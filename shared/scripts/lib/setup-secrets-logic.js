/**
 * setup-secrets-logic.js: the decisions behind setup-secrets.js (the entry script in the folder above).
 *
 * Role: pure functions only. Plain values in, plain values out: no prompts, no file access, no process.exit, no console.
 * The entry script asks the questions, runs the Make API checks of lib/mode.js and writes the file. A new rule goes here
 * with a unit test in lib/__tests__/setup-secrets-logic.test.js.
 */
const { scriptCommand } = require('./paths');
const { proxyEnv } = require('./access-guard-logic');
const {
	MODES,
	ZONES,
	TOKEN_SCOPES,
	ACCOUNT_NAME_UNAVAILABLE,
	tokenPageUrl,
	verdictFrom,
	retryMessage,
	retryDetail,
	accountLabel,
	formatScopes,
	runComponentScopesText,
} = require('./mode-logic');

const USAGE = 'Usage: node setup-secrets.js [--editor claude|cursor]';
const DEFAULT_JIRA_BASE_URL = 'https://make.atlassian.net';
const DEFAULT_PINECONE_INDEX = 'make-app-contexts';
const SECRET_KEYS = ['make-api-key', 'jira-api-token', 'pinecone-api-key', 'openai-api-key'];
const EMPLOYEE_STEPS = ['imt-app-runtime-path', 'make-apps-mockup-path', 'make-team-id', 'jira-api-token'];
const PUBLIC_STEPS = ['make-team-id'];
const ZONE_403_HINT = 'HTTP 403 means the token is valid on that zone but lacks the user:read scope: choose that zone, or add user:read to the token and run this wizard again.';

/**
 * Reads the command line. The value of --editor is not checked here: paths.resolveEditor owns that rule, so the
 * message for a bad value is the same in every script.
 */
function parseArgs(argv) {
	let editor = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--editor') {
			const value = argv[i + 1];
			if (!value || value.startsWith('--')) return { editor: null, error: '--editor needs a value: claude or cursor.' };
			editor = value;
			i++;
		} else if (arg.startsWith('--editor=')) {
			editor = arg.slice('--editor='.length);
			if (!editor) return { editor: null, error: '--editor needs a value: claude or cursor.' };
		} else {
			return { editor: null, error: `Unknown argument: ${arg}` };
		}
	}
	return { editor, error: null };
}

/** Cursor takes the Make API key from its own settings.json (apps-sdk.environments). Only Claude Code keeps it in the secrets file. */
function makeKeyInSecretsFile(editor) {
	return editor === 'claude';
}

/** What the wizard prints above the token question. The link uses the saved host when there is one; no zone is assumed. */
function tokenIntroLines(savedHost) {
	return [
		savedHost ? `Create a token at ${tokenPageUrl(savedHost)}` : `Create a token on the API page of your Make profile: https://<your Make host>/user/api (for example ${tokenPageUrl(ZONES[0])}).`,
		`Scopes: ${formatScopes(TOKEN_SCOPES)} (user:read lets the wizard and check-setup find your zone and account).`,
		`For run-component.js (live Endpoint / RPC runs) also add: ${runComponentScopesText()}`,
	];
}

function zoneRowStatus(result) {
	if (result && Number.isInteger(result.status)) return `HTTP ${result.status}`;
	return (result && result.error) || 'no answer';
}

/**
 * The zone step after detectZone (pickZone of the six hosts). One host that answered 200: { host, lines }. Every call
 * failed on the network: { stop: true, lines } with the retry advice, because no zone answered and a list would
 * suggest the token is wrong. Otherwise { ask: true, lines, current }: the lines list every zone with its answer, and
 * current is the saved host when it is one of the six (Enter keeps it). A 403 is a valid token without user:read
 * (spec B 11.1); with no 200 the list says so, because detection cannot pick that zone by itself.
 */
function zoneOutcome(pick, savedHost) {
	if (pick.host) return { host: pick.host, lines: [`Zone: ${pick.host} (the only Make zone that accepted this token). Token page: ${tokenPageUrl(pick.host)}`] };
	if (pick.results.length > 0 && pick.results.every((r) => !Number.isInteger(r.status))) {
		const codes = [...new Set(pick.results.map(zoneRowStatus))].join(', ');
		return { stop: true, lines: retryMessage('any Make zone', `every zone call failed: ${codes}`).split('\n') };
	}
	const accepted = pick.results.filter((r) => r.status === 200).length;
	const width = Math.max(...ZONES.map((h) => h.length));
	const lines = [accepted > 1 ? 'Several Make zones accepted this token. Choose the zone you sign in to:' : 'No Make zone accepted this token. Choose the zone you sign in to:'];
	ZONES.forEach((host, i) => {
		lines.push(`  ${i + 1}) ${host.padEnd(width)}  ${zoneRowStatus(pick.results.find((r) => r.host === host))}`);
	});
	if (accepted === 0 && pick.results.some((r) => r.status === 403)) lines.push(ZONE_403_HINT);
	return { ask: true, lines, current: ZONES.includes(savedHost) ? savedHost : null };
}

/** An answer to the zone question: a list number or one of the six hosts. Anything else gives null. */
function zoneFromChoice(raw) {
	const value = String(raw || '').trim().toLowerCase();
	if (/^\d+$/.test(value)) return ZONES[Number(value) - 1] || null;
	return ZONES.includes(value) ? value : null;
}

function zoneChoiceError(raw) {
	return zoneFromChoice(raw) ? null : `Enter a number from 1 to ${ZONES.length} or one of: ${ZONES.join(', ')}.`;
}

/** Cursor without a usable Make Apps SDK environment: the wizard cannot check the token, so it stops before any question. */
function cursorCredentialLines({ detail }, file) {
	return [
		`Cannot check the Make API token of Cursor: ${detail.includes(file) ? detail : `${file}: ${detail}`}.`,
		'Set up the Make Apps SDK extension in Cursor (an environment with its API key), then run this wizard again. Nothing was written.',
	];
}

/**
 * The mode step after detectMode: { mode: 'employee' | 'public', lines } or { stop: true, lines } for a rejected token
 * or a check without a usable answer (decision 3: never public by default). Nothing is written before this step.
 * After a users/me 403 the admin probe decides, and the line says that the account name is unavailable. zoneChosen is
 * true when the user picked the Claude Code zone from the list, so the rejection may come from the wrong zone.
 */
function modeOutcome(result, host, editor, { zoneChosen = false } = {}) {
	const verdict = verdictFrom(result);
	if (verdict === 'badToken') {
		if (editor === 'claude') {
			const lines = [`Make rejected this token on ${host} (HTTP 401). Nothing was written.`, `Create a new token at ${tokenPageUrl(host)} and run this wizard again.`];
			if (zoneChosen) lines.push('If you chose this zone from the list, run this wizard again and choose another zone.');
			return { stop: true, lines };
		}
		return {
			stop: true,
			lines: [
				`Make rejected the API token of the active Cursor environment on ${host} (HTTP 401). Nothing was written.`,
				`Create a new token at ${tokenPageUrl(host)}, put it in the active Make Apps SDK environment in Cursor, and run this wizard again.`,
			],
		};
	}
	if (verdict === 'retry') return { stop: true, lines: retryMessage(host, retryDetail(result)).split('\n') };
	const label = accountLabel(result.me);
	const where = `${host}, admin API ${result.admin.status}`;
	const who = label === ACCOUNT_NAME_UNAVAILABLE ? `${where}; ${label}` : `${label ? `${label} on ` : ''}${where}`;
	if (verdict === 'employee') return { mode: 'employee', lines: [`Make employee account detected (${who}).`] };
	return { mode: 'public', lines: [`Public mode (${who}): the Make employee questions (imt-app-runtime, make-apps-mockup, Jira) are skipped.`] };
}

/**
 * The questions after the mode check, in the order the wizard asks them. A Make employee gets today's questions in
 * today's order; a public account gets only the team id. The MCP step follows for both.
 */
function questionSteps(mode) {
	if (!MODES.includes(mode)) throw new Error(`No setup questions for mode ${mode}`);
	return mode === 'employee' ? [...EMPLOYEE_STEPS] : [...PUBLIC_STEPS];
}

/**
 * The lines the main part of the wizard writes. A null value means "leave that line as it is" (secrets-file.js skips it),
 * which is how a skipped question keeps its old value, including the employee questions in public mode. Object order is
 * the order of new lines in a new file. make-api-url is never written: a 2.x install reads the same file.
 */
function buildSecretsUpdates(editor, answers) {
	const { makeApiKey, makeZone, runtimePath, mockupPath, teamId, jiraToken, jiraEmail, jiraBaseUrl } = answers;
	const updates = {};
	if (makeKeyInSecretsFile(editor)) {
		updates['make-api-key'] = makeApiKey;
		updates['make-zone'] = makeZone;
	}
	updates['imt-app-runtime-path'] = runtimePath || null;
	updates['make-apps-mockup-path'] = mockupPath || null;
	updates['make-team-id'] = teamId || null;
	updates['jira-api-token'] = jiraToken || null;
	updates['jira-email'] = jiraToken ? jiraEmail : null;
	updates['jira-base-url'] = jiraToken ? jiraBaseUrl : null;
	return updates;
}

/** The lines the Pinecone / OpenAI step writes into the secrets file (they used to go to mcp-server/.env). */
function buildMcpUpdates({ pineconeKey, pineconeIndex, openaiKey }) {
	return {
		'pinecone-api-key': pineconeKey || null,
		'pinecone-index-name': pineconeIndex || DEFAULT_PINECONE_INDEX,
		'openai-api-key': openaiKey || null,
	};
}

/** True when the secrets file already holds everything the make-app-context server needs. */
function mcpConfigured({ pineconeKey, pineconeIndex, openaiKey }) {
	return Boolean(pineconeKey && pineconeIndex && openaiKey);
}

/** The part of a question after its label. A hidden question never shows the value it keeps. */
function promptHint({ current, optional, hidden }) {
	if (current) return hidden ? ' [set, Enter to keep]' : ` [${current}, Enter to keep]`;
	return optional ? ' [Enter to skip]' : '';
}

/** What the wizard may print for a key: "set" or "not set" for a secret, the value itself for anything else. */
function maskForDisplay(key, value) {
	if (!value || !String(value).trim()) return 'not set';
	return SECRET_KEYS.includes(key) ? 'set' : value;
}

/** One printable line per key of an updates object. */
function formatStatus(updates) {
	return Object.entries(updates).map(([key, value]) => `  ${key}: ${maskForDisplay(key, value)}`);
}

/** What the wizard prints last: the check-setup command, with its path quoted like every printed script command. */
function nextStepLines(scriptsDir) {
	return ['', 'Done. Verify by asking the agent in your editor to run:', `  ${scriptCommand('check-setup.js', scriptsDir)}`];
}

/**
 * The environment for one rerun of the wizard behind an HTTP(S) proxy (spec B 11.6), or null for no rerun. Node's fetch
 * reads the proxy variables only when NODE_USE_ENV_PROXY=1 is set at startup. The rerun has it set, so this returns null
 * there and the wizard runs at most twice.
 */
function proxyRerunEnv(env) {
	const extra = proxyEnv(env);
	return Object.keys(extra).length > 0 ? { ...env, ...extra } : null;
}

/** The exit code after the rerun: its status, or 1 when it has none (killed by a signal, or it did not start). */
function rerunExitCode(status) {
	return Number.isInteger(status) ? status : 1;
}

module.exports = {
	USAGE,
	DEFAULT_JIRA_BASE_URL,
	DEFAULT_PINECONE_INDEX,
	ZONE_403_HINT,
	parseArgs,
	makeKeyInSecretsFile,
	tokenIntroLines,
	zoneOutcome,
	zoneFromChoice,
	zoneChoiceError,
	cursorCredentialLines,
	modeOutcome,
	questionSteps,
	buildSecretsUpdates,
	buildMcpUpdates,
	mcpConfigured,
	promptHint,
	maskForDisplay,
	formatStatus,
	nextStepLines,
	proxyRerunEnv,
	rerunExitCode,
};
