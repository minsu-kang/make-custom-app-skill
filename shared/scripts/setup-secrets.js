#!/usr/bin/env node
/**
 * setup-secrets.js — interactive wizard for ~/.make-custom-app-skill-secrets
 *
 * Run in your own terminal, not via the agent (needs a TTY; writes secrets). A terminal carries neither
 * CLAUDECODE nor CURSOR_AGENT, so name the editor:
 *
 *   node setup-secrets.js --editor claude|cursor
 *
 * The wizard checks the Make API token before it asks anything else: the zone that accepts it (Claude Code), then
 * the admin API probe of lib/mode.js. Only a Make employee account gets the employee questions.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');
const { SCRIPTS_DIR, setupCommand } = require('./lib/paths');
const { readSkillConfig, readClaudeHost, readMakeCredentials, requireEditor, SECRETS_PATH, CURSOR_SETTINGS_PATH } = require('./lib/settings');
const { isValidId } = require('./lib/run-component-logic');
const { requireTty, upsertSecretsFile } = require('./lib/secrets-file');
const { fetchJiraEmail } = require('./lib/jira-myself');
const { isInternalEmail } = require('./lib/access-guard-logic');
const { detectZone, detectMode, saveVerdict } = require('./lib/mode');
const {
	USAGE,
	DEFAULT_JIRA_BASE_URL,
	DEFAULT_PINECONE_INDEX,
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
	formatStatus,
	nextStepLines,
	proxyRerunEnv,
	rerunExitCode,
} = require('./lib/setup-secrets-logic');

const RUNTIME_HTTPS = 'https://github.com/integromat/imt-app-runtime.git';
const RUNTIME_SSH = 'git@github.com:integromat/imt-app-runtime.git';
const MOCKUP_HTTPS = 'https://github.com/integromat/make-apps-mockup.git';
const MOCKUP_SSH = 'git@github.com:integromat/make-apps-mockup.git';

let rl;

function openRl() {
	if (!rl) {
		rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	}
	return rl;
}

function closeRl() {
	if (rl) {
		rl.close();
		rl = undefined;
	}
}

function expandPath(p) {
	if (!p) return p;
	if (p === '~') return os.homedir();
	if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
	return path.resolve(p);
}

function isDir(p) {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

async function promptHidden(question) {
	process.stdout.write(question);
	const stdin = process.stdin;
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding('utf8');
	let value = '';
	return new Promise((resolve) => {
		const onData = (ch) => {
			if (ch === '\n' || ch === '\r' || ch === '\u0004') {
				cleanup();
				process.stdout.write('\n');
				resolve(value);
			} else if (ch === '\u0003') {
				cleanup();
				process.stdout.write('\n');
				process.exit(130);
			} else if (ch === '\u007f' || ch === '\b') {
				value = value.slice(0, -1);
			} else if (ch === '\u0017') {
				value = '';
			} else if (ch.charCodeAt(0) >= 32) {
				value += ch;
			}
		};
		function cleanup() {
			stdin.removeListener('data', onData);
			stdin.setRawMode(false);
		}
		stdin.on('data', onData);
	});
}

async function ask({ label, current, optional, hidden, validate }) {
	const question = `${label}${promptHint({ current, optional, hidden })}: `;
	let answer;
	if (hidden) {
		closeRl();
		answer = (await promptHidden(question)).trim();
		openRl();
	} else {
		answer = (await openRl().question(question)).trim();
	}
	if (!answer) {
		if (current) return current;
		if (optional) return '';
		console.log('  Required.');
		return ask({ label, current, optional, hidden, validate });
	}
	if (validate) {
		const err = validate(answer);
		if (err) {
			console.log(`  ${err}`);
			return ask({ label, current, optional, hidden, validate });
		}
	}
	return answer;
}

async function askYesNo(label, defaultYes = false) {
	const hint = defaultYes ? ' [Y/n]' : ' [y/N]';
	const answer = (await openRl().question(`${label}${hint}: `)).trim().toLowerCase();
	if (!answer) return defaultYes;
	return answer === 'y' || answer === 'yes';
}

function validateDir(raw) {
	const resolved = expandPath(raw);
	if (!isDir(resolved)) return `Not a directory: ${resolved}`;
	return null;
}

function printCloneHelp(name, httpsUrl, sshUrl) {
	console.log(`Clone ${name} (Make internal repo), then paste the absolute path to that clone.`);
	console.log('');
	console.log(`  HTTPS:  git clone ${httpsUrl}`);
	console.log(`  SSH:    git clone ${sshUrl}`);
	console.log('');
}

/**
 * Behind an HTTP(S) proxy Node's fetch needs NODE_USE_ENV_PROXY=1 at startup, so the wizard runs itself once more with
 * it (stdio shared) and exits with that run's status. The rerun has the variable set, so it does not rerun again.
 */
function rerunBehindProxy() {
	const env = proxyRerunEnv(process.env);
	if (!env) return;
	const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env });
	process.exit(rerunExitCode(child.status));
}

/** Prints why the wizard cannot go on and exits 1. Nothing has been written at this point. */
function stop(lines) {
	closeRl();
	for (const line of lines) console.error(line);
	process.exit(1);
}

/** Claude Code: the token, then the zone that accepts it. Returns { host, apikey, zoneChosen } for the mode check. */
async function askMakeToken() {
	const saved = readClaudeHost();
	const savedHost = saved.ok ? saved.host : null;
	console.log('── Make API (required) ──');
	for (const line of tokenIntroLines(savedHost)) console.log(line);
	console.log('');
	const apikey = await ask({
		label: 'make-api-key',
		current: readSkillConfig('make-api-key'),
		hidden: true,
	});
	console.log('Looking for the Make zone of this token...');
	const zone = zoneOutcome(await detectZone(apikey), savedHost);
	if (zone.stop) stop(zone.lines);
	for (const line of zone.lines) console.log(line);
	const host =
		zone.host ||
		zoneFromChoice(
			await ask({
				label: 'make-zone (number or host)',
				current: zone.current,
				validate: zoneChoiceError,
			}),
		);
	return { host, apikey, zoneChosen: !zone.host };
}

/** Cursor: the key and host of the active Make Apps SDK environment. Stops when there is none. */
function readCursorTarget(editor) {
	console.log('── Make API ──');
	console.log('Cursor reads the Make API key from the Make Apps SDK settings (apps-sdk.environments in its settings.json). Nothing to enter here.');
	const creds = readMakeCredentials(editor);
	if (!creds.ok) stop(cursorCredentialLines(creds, CURSOR_SETTINGS_PATH));
	return { host: creds.host, apikey: creds.apikey };
}

async function askRuntime() {
	console.log('');
	console.log('── imt-app-runtime (required) ──');
	printCloneHelp('imt-app-runtime', RUNTIME_HTTPS, RUNTIME_SSH);
	const runtimePath = expandPath(
		await ask({
			label: 'imt-app-runtime-path',
			current: readSkillConfig('imt-app-runtime-path'),
			validate: validateDir,
		}),
	);
	return { runtimePath };
}

async function askMockup() {
	console.log('');
	console.log('── make-apps-mockup (optional) ──');
	printCloneHelp('make-apps-mockup', MOCKUP_HTTPS, MOCKUP_SSH);
	const mockupRaw = await ask({
		label: 'make-apps-mockup-path',
		current: readSkillConfig('make-apps-mockup-path'),
		optional: true,
		validate: (raw) => validateDir(raw),
	});
	return { mockupPath: mockupRaw ? expandPath(mockupRaw) : '' };
}

async function askTeamId() {
	console.log('');
	console.log('── Live runs (optional) ──');
	console.log('Default Make team id for run-component.js. Enter skips (the script then lists your teams and --team=<id> --save-team stores one); --team=<id> overrides it on every run.');
	const teamId = await ask({
		label: 'make-team-id',
		current: readSkillConfig('make-team-id'),
		optional: true,
		validate: (raw) => (isValidId(raw) ? null : 'A team id is a positive integer up to 2147483647.'),
	});
	return { teamId };
}

async function askJira() {
	console.log('');
	console.log('── Jira (required) ──');
	console.log('Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens (choose "Create API token", not "Create API token with scopes").');
	console.log('The skill is for Make employees: it confirms that this Atlassian account is a @make.com account. The token is also used for ticket attachments and reviewer assignment.');
	console.log('');
	const jiraToken = await ask({
		label: 'jira-api-token',
		current: readSkillConfig('jira-api-token'),
		hidden: true,
	});

	let jiraEmail = readSkillConfig('jira-email');
	let jiraBaseUrl = readSkillConfig('jira-base-url');
	if (jiraToken) {
		jiraBaseUrl = jiraBaseUrl || DEFAULT_JIRA_BASE_URL;
		const typedEmail = await ask({
			label: 'Atlassian account email (to call /myself)',
			current: jiraEmail,
		});
		try {
			jiraEmail = await fetchJiraEmail({
				baseUrl: jiraBaseUrl,
				email: typedEmail,
				token: jiraToken,
			});
			console.log(`  jira-email set from /myself: ${jiraEmail}`);
			if (!isInternalEmail(jiraEmail)) console.log('  This is not a @make.com account, so the skill will refuse to run.');
		} catch (err) {
			jiraEmail = typedEmail;
			console.log(`  /myself failed (${err.message}). Saving the typed email. The skill will not run until the token works.`);
		}
	}
	return { jiraToken, jiraEmail, jiraBaseUrl };
}

/** One function per name in questionSteps(mode); each returns its part of the answers. */
const QUESTIONS = {
	'imt-app-runtime-path': askRuntime,
	'make-apps-mockup-path': askMockup,
	'make-team-id': askTeamId,
	'jira-api-token': askJira,
};

async function main() {
	rerunBehindProxy();
	const { editor: flag, error } = parseArgs(process.argv.slice(2));
	if (error) {
		console.error(`ERROR: ${error}`);
		console.error(USAGE);
		process.exit(1);
	}
	const editor = requireEditor(flag);

	try {
		requireTty(process.stdin);
	} catch (err) {
		if (err.code === 'NOT_TTY') {
			console.error('This wizard is interactive and writes secrets. Run it in your own terminal:');
			console.error(`  ${setupCommand(editor)}`);
			process.exit(1);
		}
		throw err;
	}

	console.log(`make-custom-app setup (editor: ${editor})`);
	console.log(`Secrets file: ${SECRETS_PATH} (mode 600)`);
	console.log('');

	const inFile = makeKeyInSecretsFile(editor);
	const target = inFile ? await askMakeToken() : readCursorTarget(editor);
	console.log(`Checking the Make account on ${target.host}...`);
	const checked = modeOutcome(await detectMode(target.host, target.apikey), target.host, editor, { zoneChosen: target.zoneChosen });
	if (checked.stop) stop(checked.lines);
	for (const line of checked.lines) console.log(line);

	const answers = inFile ? { makeApiKey: target.apikey, makeZone: target.host } : {};
	for (const step of questionSteps(checked.mode)) Object.assign(answers, await QUESTIONS[step]());

	upsertSecretsFile(SECRETS_PATH, buildSecretsUpdates(editor, answers));
	saveVerdict(target.host, target.apikey, checked.mode);
	console.log('');
	console.log(`Wrote ${SECRETS_PATH}`);

	console.log('');
	console.log('── MCP server / Pinecone (optional) ──');
	console.log('Shared app-context search. Needs a Pinecone index and an OpenAI key for embeddings.');
	console.log('Pinecone key:  https://app.pinecone.io');
	console.log('OpenAI key:    https://platform.openai.com/api-keys');
	console.log('The keys go into the secrets file, where the make-app-context server reads them.');
	console.log('');

	const mcpCurrent = {
		pineconeKey: readSkillConfig('pinecone-api-key'),
		pineconeIndex: readSkillConfig('pinecone-index-name'),
		openaiKey: readSkillConfig('openai-api-key'),
	};
	const setupMcp = await askYesNo(mcpConfigured(mcpCurrent) ? 'Pinecone and OpenAI keys already set. Update them?' : 'Set up the MCP server keys now?', false);

	if (setupMcp) {
		const pineconeKey = await ask({
			label: 'pinecone-api-key',
			current: mcpCurrent.pineconeKey,
			hidden: true,
		});
		const pineconeIndex = await ask({
			label: 'pinecone-index-name',
			current: mcpCurrent.pineconeIndex || DEFAULT_PINECONE_INDEX,
		});
		const openaiKey = await ask({
			label: 'openai-api-key',
			current: mcpCurrent.openaiKey,
			hidden: true,
		});
		const mcpUpdates = buildMcpUpdates({ pineconeKey, pineconeIndex, openaiKey });
		upsertSecretsFile(SECRETS_PATH, mcpUpdates);
		console.log(`Wrote ${SECRETS_PATH}`);
		for (const line of formatStatus(mcpUpdates)) console.log(line);
	} else {
		console.log('MCP skipped.');
	}

	closeRl();
	for (const line of nextStepLines(SCRIPTS_DIR)) console.log(line);
}

main().catch((err) => {
	closeRl();
	console.error(err.message || err);
	process.exit(1);
});
