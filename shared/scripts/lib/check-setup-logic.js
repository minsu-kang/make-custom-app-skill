/**
 * check-setup-logic.js: the decisions behind the Make API items of check-setup.js (the token item, the mode item and
 * the MODE line).
 *
 * Role: pure functions only. Plain values in, items out: no network, no file access, no process.exit, no console.
 * An item is { key, status: 'ok' | 'missing' | 'optional-missing', detail, fix }; fix is null or the lines to apply.
 */
const {
	MODES,
	TOKEN_SCOPES,
	ACCOUNT_NAME_UNAVAILABLE,
	formatScopes,
	runComponentScopesText,
	tokenPageUrl,
	badTokenMessage,
	retryMessage,
	retryDetail,
	classifyMe,
	accountLabel,
} = require('./mode-logic');

const CLAUDE_ITEM = 'make-api-key';
const CURSOR_ITEM = 'make-api (Cursor settings.json)';
/** The scopes a new token needs, from the one scope source in mode-logic.js (spec B 11.7). */
const SCOPES_TEXT = `${formatScopes(TOKEN_SCOPES)}; for run-component.js also ${runComponentScopesText()}`;
const CURSOR_INSTALL_FIX = 'Install the Make Apps SDK extension in Cursor and add an environment with your API key (Command Palette → "Make Apps: Add environment").';

function item(key, status, detail, fix = null) {
	return { key, status, detail, fix };
}

/** Line 1 of a mode-logic message is the detail; the lines after it are the fix (null when there are none). */
function splitMessage(text) {
	const [detail, ...fix] = text.split('\n');
	return { detail, fix: fix.length ? fix.join('\n') : null };
}

/** Where to create a token, with the scopes. Without a known host it names the page of any Make host. */
function tokenHelp(host) {
	return `Create a token at ${host ? tokenPageUrl(host) : 'https://<your Make host>/user/api'} (scopes: ${SCOPES_TEXT}).`;
}

/** 'employee' | 'public', or null when the token was not checked or the check gave no mode. */
function reportedMode(probe) {
	return probe && MODES.includes(probe.verdict) ? probe.verdict : null;
}

/** The first line of the human report. */
function modeLine(mode) {
	return `MODE: ${mode || 'unknown'}`;
}

function unreadableItem(editor, creds, { tokenHost, setupHint, cursorSettingsPath }) {
	if (editor === 'claude') {
		if (creds.reason === 'no-key') return item(CLAUDE_ITEM, 'missing', 'not set (Claude Code reads it from ~/.make-custom-app-skill-secrets)', `${setupHint}\n${tokenHelp(tokenHost)}`);
		return item(CLAUDE_ITEM, 'missing', `set, but no Make zone (${creds.detail})`, `${setupHint}\nThe wizard tries the token on each Make zone and saves make-zone.`);
	}
	if (creds.reason === 'unreadable') {
		const line = /near line (\d+)/.exec(creds.detail);
		return item(CURSOR_ITEM, 'missing', `cannot read the file: ${creds.detail}`, `Fix the JSON in ${cursorSettingsPath}${line ? `, near line ${line[1]}` : ''}, then run check-setup again.`);
	}
	if (creds.reason === 'no-key' || creds.reason === 'no-host') {
		return item(CURSOR_ITEM, 'missing', creds.detail, `Give the active environment of the Make Apps SDK extension in Cursor your Make API token and the host you open Make at. ${tokenHelp(null)}`);
	}
	return item(CURSOR_ITEM, 'missing', creds.detail, CURSOR_INSTALL_FIX);
}

/**
 * The Make API item: make-api-key (Claude Code) or the Cursor environment. creds is settings.readMakeCredentials();
 * probe is { me, admin, verdict } or null when creds is not ok. tokenHost (Claude Code without a key) is the host of
 * make-zone or make-api-url when one is set, so the token page is the right one. A users/me 403 is a valid token
 * without user:read (spec B 11.1): the item is ok and says the account name is unavailable.
 */
function credentialItem({ editor, creds, probe, tokenHost = null, setupHint, setupCommand, cursorSettingsPath }) {
	if (!creds.ok) return unreadableItem(editor, creds, { tokenHost, setupHint, cursorSettingsPath });
	const key = editor === 'claude' ? CLAUDE_ITEM : CURSOR_ITEM;
	if (probe.verdict === 'badToken') {
		const { detail, fix } = splitMessage(badTokenMessage(creds.host, { editor, setupCommand }));
		return item(key, 'missing', detail, fix);
	}
	if (classifyMe(probe.me) !== 'ok') return item(key, 'ok', `${creds.host}, account not checked (see mode)`);
	const label = accountLabel(probe.me);
	if (!label) return item(key, 'ok', creds.host);
	return item(key, 'ok', `${creds.host}, ${label === ACCOUNT_NAME_UNAVAILABLE ? label : `account ${label}`}`);
}

/** The mode item (ok or missing, spec B 11.5): the verdict with the status of the admin API probe, or why there is none. */
function modeItem({ creds, probe }) {
	if (!creds.ok) return item('mode', 'missing', 'unknown (no Make API token to check)');
	if (probe.verdict === 'badToken') return item('mode', 'missing', 'unknown (Make rejected the token)');
	if (probe.verdict === 'retry') {
		const { detail, fix } = splitMessage(retryMessage(creds.host, retryDetail(probe)));
		return item('mode', 'missing', detail, fix);
	}
	return item('mode', 'ok', `${probe.verdict} (admin API ${probe.admin.status})`);
}

const MCP_PUBLIC_DETAIL = 'not needed in public mode: the shared Make app-context index is not available to public users, and your app notes stay in ~/.make-custom-app/contexts. Set the two keys only if you run a Pinecone index of your own.';
const MCP_WIZARD_LINE = 'Optional — the wizard asks for the Pinecone and OpenAI keys of the shared app-context server and saves them in the secrets file.';

/**
 * The mcp-server item. missing lists the keys that are set neither as a MAKE_APP_CONTEXT_* variable nor in the secrets
 * file: [{ key, variable }]. Public mode has no shared index, so a missing key stays optional and has no fix (spec 3.5
 * row 16); every other mode keeps the item that asks for the keys.
 */
function mcpServerItem({ mode, missing, secretsPath, setupHint }) {
	if (missing.length === 0) {
		return item(
			'mcp-server',
			'ok',
			`keys are set (environment or ${secretsPath}); cannot check whether the server is registered: plugin MCP servers are not listed in ~/.claude.json or ~/.cursor/mcp.json`,
		);
	}
	if (mode === 'public') return item('mcp-server', 'optional-missing', MCP_PUBLIC_DETAIL);
	return item(
		'mcp-server',
		'optional-missing',
		`missing: ${missing.map(({ key }) => key).join(', ')} (set ${missing.map(({ variable }) => variable).join(', ')} or the same key in ${secretsPath})`,
		`${setupHint}\n${MCP_WIZARD_LINE}`,
	);
}

module.exports = { CLAUDE_ITEM, CURSOR_ITEM, SCOPES_TEXT, splitMessage, tokenHelp, reportedMode, modeLine, credentialItem, modeItem, mcpServerItem };
