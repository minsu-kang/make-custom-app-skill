const fs = require('fs');
const path = require('path');
const os = require('os');
const { EditorError, resolveEditor, setupCommand, takeEditorFlag, getEditorFlag } = require('./paths');
const { hostFromUrl, hostFromZone } = require('./mode-logic');

/**
 * User config file, one `key: value` per line. Scripts read it; the agent never does.
 *
 *   editor: claude | cursor               (which editor runs the scripts; see paths.js)
 *   make-api-key: <token>                 (Claude Code only)
 *   make-zone: eu1.make.com               (Claude Code only: the Make host of the token, written by the wizard)
 *   make-api-url: https://eu1.make.com/api/v2/admin   (legacy: only its host is read, when make-zone is unset)
 *   make-team-id: 12345                   (optional, default team for run-component.js)
 *   imt-app-runtime-path: /abs/path       (Make employees)
 *   make-apps-mockup-path: /abs/path      (optional, Make employees, test-component.js)
 *   jira-email: you@example.com           (Make employees: account check and Jira scripts)
 *   jira-api-token: <token>
 *   jira-base-url: https://make.atlassian.net          (optional)
 *   mcp-server-path: /abs/path            (optional)
 */
const SECRETS_PATH = path.join(os.homedir(), '.make-custom-app-skill-secrets');

const PLACEHOLDER_MARKERS = ['your-', '<', '>', '@example.com', 'ATATT3x...', '/path/provided/by/user', '/path/to/', '{path-to'];

function isPlaceholder(value) {
	if (!value) return true;
	return PLACEHOLDER_MARKERS.some((m) => value.includes(m));
}

function lastMatch(lines, key) {
	const re = new RegExp(`^${key}:\\s*(.+)$`);
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = lines[i].trim().match(re);
		if (m && !isPlaceholder(m[1].trim())) return m[1].trim();
	}
	return null;
}

/** Reads one value from the secrets file. Placeholder values are ignored. Returns null when unset. */
function readSkillConfig(key) {
	if (!fs.existsSync(SECRETS_PATH)) return null;
	return lastMatch(fs.readFileSync(SECRETS_PATH, 'utf-8').split('\n'), key);
}

/**
 * The editor that runs this script (see paths.resolveEditor). Throws EditorError when it cannot be told.
 * Without an argument it uses the --editor flag that takeEditorFlagOrExit stripped from the command line.
 */
function getEditor(flag = getEditorFlag()) {
	return resolveEditor({ env: process.env, configured: readSkillConfig('editor'), flag });
}

/**
 * getEditor() for command-line scripts: prints "ERROR: <reason>" and exits 1 when the editor cannot be told.
 * Passing null explicitly skips the remembered --editor flag (setup-secrets.js parses its own flag).
 */
function requireEditor(flag = getEditorFlag()) {
	try {
		return getEditor(flag);
	} catch (err) {
		if (!(err instanceof EditorError)) throw err;
		console.error(`ERROR: ${err.message}`);
		process.exit(1);
	}
}

/**
 * Strips --editor from argv (see paths.takeEditorFlag) for command-line scripts. Call it before anything else
 * reads process.argv. Prints "ERROR: <reason>" and exits 1 when the flag has no value.
 */
function takeEditorFlagOrExit(argv) {
	try {
		return takeEditorFlag(argv);
	} catch (err) {
		if (!(err instanceof EditorError)) throw err;
		console.error(`ERROR: ${err.message}`);
		process.exit(1);
	}
}

/** The setup command for an error message. The editor only adds a flag, so an unresolved one must not stop the message. */
function setupCommandForMessage() {
	try {
		return setupCommand(getEditor());
	} catch {
		return setupCommand();
	}
}

/**
 * Jira credentials for the attachment and transition scripts. Exits with a setup
 * message when email or token is missing.
 */
function loadJiraConfig() {
	const email = readSkillConfig('jira-email');
	const apiToken = readSkillConfig('jira-api-token');
	const baseUrl = readSkillConfig('jira-base-url') || 'https://make.atlassian.net';
	if (!email || !apiToken) {
		console.error('ERROR: Jira credentials not configured.');
		console.error('Run this in your own terminal:\n');
		console.error(`  ${setupCommandForMessage()}\n`);
		console.error('The wizard asks for a Jira API token and fills jira-email from GET /rest/api/3/myself.');
		process.exit(1);
	}
	return { email, apiToken, baseUrl };
}

function hostOf(baseUrl) {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}

/** Tells the user, on stderr, which editor and Make API host a script is about to act on. Never prints the key. */
function announceTarget(settings) {
	console.error(`Target: editor=${settings.editor}, Make API host=${hostOf(settings.baseUrl)}`);
}

/** Where Cursor keeps its user settings (and with them the Make Apps SDK environments). */
function cursorSettingsPath(platform = process.platform, home = os.homedir()) {
	if (platform === 'win32') return path.join(home, 'AppData/Roaming/Cursor/User/settings.json');
	if (platform === 'darwin') return path.join(home, 'Library/Application Support/Cursor/User/settings.json');
	return path.join(home, '.config/Cursor/User/settings.json');
}

const CURSOR_SETTINGS_PATH = cursorSettingsPath();

const CURSOR_SETTINGS_HELP = 'Set up the Make Apps SDK extension in Cursor (an environment with its API key), or run the scripts from Claude Code.';

/**
 * Removes // and block comments and trailing commas from JSONC text, outside string literals only, so a
 * value such as "http://proxy.corp:8080" survives. Line breaks stay, so a JSON error still names the right line.
 */
function stripJsonComments(text) {
	const out = [];
	let lastComma = -1;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			let end = i + 1;
			while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
			out.push(text.slice(i, end + 1));
			lastComma = -1;
			i = end + 1;
		} else if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
		} else if (ch === '/' && text[i + 1] === '*') {
			const close = text.indexOf('*/', i + 2);
			const end = close === -1 ? text.length : close + 2;
			out.push(text.slice(i, end).replace(/[^\r\n]/g, ''));
			i = end;
		} else {
			if (ch === ',') {
				lastComma = out.length;
			} else if (ch === '}' || ch === ']') {
				if (lastComma !== -1) out[lastComma] = '';
				lastComma = -1;
			} else if (!/\s/.test(ch)) {
				lastComma = -1;
			}
			out.push(ch);
			i++;
		}
	}
	return out.join('');
}

function parseJsonc(text) {
	return JSON.parse(stripJsonComments(text));
}

/**
 * V8's JSON error message can quote the text, so only the line number is kept: the file holds API keys. The line comes
 * from the position suffix that ends the message ("... at position N (line L column C)"), never from quoted text.
 */
function jsonErrorDetail(err) {
	const line = / at position \d+ \(line (\d+) column \d+\)$/.exec(err.message);
	return line ? `invalid JSON near line ${line[1]}` : 'invalid JSON';
}

/**
 * The Make Apps SDK environments in Cursor's settings.json. Never throws and never exits.
 * Failure reasons: missing (no file), unreadable (read or JSON error; detail never holds file content),
 * no-environments (apps-sdk.environments absent or empty).
 */
function readCursorEnvironments(file = CURSOR_SETTINGS_PATH) {
	let parsed;
	try {
		parsed = parseJsonc(fs.readFileSync(file, 'utf-8'));
	} catch (err) {
		if (err.code === 'ENOENT') return { ok: false, reason: 'missing', detail: `Cursor settings file not found: ${file}` };
		return { ok: false, reason: 'unreadable', detail: err instanceof SyntaxError ? jsonErrorDetail(err) : err.message };
	}
	const environments = parsed?.['apps-sdk.environments'];
	if (!Array.isArray(environments) || environments.length === 0) {
		return { ok: false, reason: 'no-environments', detail: `apps-sdk.environments not found in ${file}` };
	}
	return { ok: true, environments, activeUuid: parsed['apps-sdk.environment'] };
}

/**
 * Key and host of the active Make Apps SDK environment (the first one when none is active). Never throws and never exits.
 * { ok: true, apikey, host, admin } or { ok: false, reason, detail }: the reasons of readCursorEnvironments, plus
 * no-key (the environment has no API key) and no-host (its url is not on a Make host). detail never holds the key.
 */
function readCursorCredentials(file = CURSOR_SETTINGS_PATH) {
	const result = readCursorEnvironments(file);
	if (!result.ok) return result;
	const env = result.environments.find((e) => e && e.uuid === result.activeUuid) || result.environments[0];
	const apikey = env && typeof env.apikey === 'string' ? env.apikey.trim() : '';
	if (!apikey) return { ok: false, reason: 'no-key', detail: 'the active apps-sdk environment has no apikey' };
	const host = hostFromZone(env.url);
	if (!host) return { ok: false, reason: 'no-host', detail: `the url of the active apps-sdk environment is not on a Make host: ${env.url}` };
	return { ok: true, apikey, host, admin: Boolean(env.admin) };
}

/**
 * The Make host for Claude Code: `make-zone:`, else the host of a legacy `make-api-url:`. Never exits.
 * { ok: true, host, source: 'make-zone' | 'make-api-url' } or { ok: false, reason: 'no-zone' | 'bad-zone' | 'bad-url', detail }.
 */
function readClaudeHost() {
	const zone = readSkillConfig('make-zone');
	if (zone) {
		const host = hostFromZone(zone);
		return host ? { ok: true, host, source: 'make-zone' } : { ok: false, reason: 'bad-zone', detail: `make-zone is not a Make host: ${zone}` };
	}
	const url = readSkillConfig('make-api-url');
	if (!url) return { ok: false, reason: 'no-zone', detail: 'make-zone is not set' };
	const host = hostFromUrl(url);
	return host ? { ok: true, host, source: 'make-api-url' } : { ok: false, reason: 'bad-url', detail: `make-api-url is not on a Make host: ${url}` };
}

/**
 * Make API key and host for an editor, without exiting (check-setup reads it):
 * { ok: true, apikey, host, source, cursorAdmin } or { ok: false, reason, detail }.
 * Claude Code: make-api-key (reason no-key) and readClaudeHost; cursorAdmin is null. Cursor: readCursorCredentials,
 * source 'cursor', cursorAdmin = the admin flag of the environment.
 */
function readMakeCredentials(editor) {
	if (editor === 'claude') {
		const apikey = readSkillConfig('make-api-key');
		if (!apikey) return { ok: false, reason: 'no-key', detail: `make-api-key is not set in ${SECRETS_PATH}` };
		const zone = readClaudeHost();
		return zone.ok ? { ok: true, apikey, host: zone.host, source: zone.source, cursorAdmin: null } : zone;
	}
	const cursor = readCursorCredentials();
	return cursor.ok ? { ok: true, apikey: cursor.apikey, host: cursor.host, source: 'cursor', cursorAdmin: cursor.admin } : cursor;
}

function failCursorSettings({ reason, detail }) {
	if (reason === 'missing') console.error(`ERROR: ${detail}. ${CURSOR_SETTINGS_HELP}`);
	else if (reason === 'unreadable') console.error(`ERROR: Cannot read the Cursor settings file ${CURSOR_SETTINGS_PATH}: ${detail}`);
	else if (reason === 'no-environments') console.error('ERROR: apps-sdk.environments configuration not found.');
	else console.error(`ERROR: In ${CURSOR_SETTINGS_PATH}, ${detail}. ${CURSOR_SETTINGS_HELP}`);
	process.exit(1);
}

function failClaudeMissingKey() {
	console.error('ERROR: Make API key not configured.');
	console.error('');
	console.error(`Claude Code requires \`make-api-key:\` in ${SECRETS_PATH}.`);
	console.error('Run this in your own terminal:');
	console.error('');
	console.error(`  ${setupCommand('claude')}`);
	process.exit(1);
}

function failClaudeMissingHost(detail) {
	console.error(`ERROR: Make zone not configured (${detail}).`);
	console.error('');
	console.error(`Claude Code reads \`make-zone:\` (or the host of a legacy \`make-api-url:\`) from ${SECRETS_PATH}.`);
	console.error('Run this in your own terminal:');
	console.error('');
	console.error(`  ${setupCommand('claude')}`);
	process.exit(1);
}

/**
 * Make API key and host for the editor that runs the script: { editor, host, apikey, auth, cursorAdmin }.
 *
 * Cursor      -> the active environment of Cursor's settings.json (apps-sdk.environments / apps-sdk.environment)
 * Claude Code -> `make-api-key:` and `make-zone:` (or the host of a legacy `make-api-url:`) in the secrets file
 *
 * There is no base URL here: lib/mode.js requireMode() adds baseUrl for the mode of the token.
 * Exits 1 when the editor cannot be told (see requireEditor) or the key or host is missing.
 */
function loadSettings() {
	const editor = requireEditor();
	const result = readMakeCredentials(editor);
	if (!result.ok) {
		if (editor !== 'claude') failCursorSettings(result);
		else if (result.reason === 'no-key') failClaudeMissingKey();
		else failClaudeMissingHost(result.detail);
	}
	return { editor, host: result.host, apikey: result.apikey, auth: `Token ${result.apikey}`, cursorAdmin: result.cursorAdmin };
}

module.exports = {
	SECRETS_PATH,
	CURSOR_SETTINGS_PATH,
	cursorSettingsPath,
	stripJsonComments,
	parseJsonc,
	readCursorEnvironments,
	readCursorCredentials,
	readClaudeHost,
	readMakeCredentials,
	isPlaceholder,
	readSkillConfig,
	getEditor,
	requireEditor,
	takeEditorFlagOrExit,
	loadSettings,
	loadJiraConfig,
	announceTarget,
};
