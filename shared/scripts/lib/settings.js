const fs = require('fs');
const path = require('path');
const os = require('os');
const { EditorError, resolveEditor, setupCommand, takeEditorFlag, getEditorFlag } = require('./paths');

/**
 * User config file, one `key: value` per line. Scripts read it; the agent never does.
 *
 *   editor: claude | cursor               (which editor runs the scripts; see paths.js)
 *   imt-app-runtime-path: /abs/path       (required)
 *   make-api-key: <token>                 (Claude Code only)
 *   make-api-url: https://eu1.make.com/api/v2/admin   (optional)
 *   make-apps-mockup-path: /abs/path      (optional, test-component.js)
 *   make-team-id: 12345                   (optional, default team for run-component.js)
 *   jira-email: you@example.com           (required, account check and Jira scripts)
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

/** getEditor() for command-line scripts: prints "ERROR: <reason>" and exits 1 when the editor cannot be told. */
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

/** V8's JSON error message quotes the start of the text, so only the line number is kept: the file holds API keys. */
function jsonErrorDetail(err) {
	const line = /\(line (\d+) column \d+\)/.exec(err.message);
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

function failCursorSettings({ reason, detail }) {
	if (reason === 'missing') console.error(`ERROR: ${detail}. ${CURSOR_SETTINGS_HELP}`);
	else if (reason === 'unreadable') console.error(`ERROR: Cannot read the Cursor settings file ${CURSOR_SETTINGS_PATH}: ${detail}`);
	else console.error('ERROR: apps-sdk.environments configuration not found.');
	process.exit(1);
}

function loadCursorSettings() {
	const result = readCursorEnvironments();
	if (!result.ok) failCursorSettings(result);

	const { environments, activeUuid } = result;
	const env = environments.find((e) => e.uuid === activeUuid) || environments[0];

	const version = env.version || 2;
	let baseUrl;
	if (version === 1) {
		baseUrl = `https://${env.url}/v1`;
	} else {
		const proto = env.unsafe ? 'http' : 'https';
		const verPath = env.noVersionPath ? '' : `/v${version}`;
		const adminPath = env.admin ? '/admin' : '';
		baseUrl = `${proto}://${env.url}${verPath}${adminPath}`;
	}

	return { baseUrl, auth: `Token ${env.apikey}`, version, apikey: env.apikey };
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

function loadClaudeSettings() {
	const apikey = readSkillConfig('make-api-key');
	if (!apikey) failClaudeMissingKey();
	const baseUrl = readSkillConfig('make-api-url') || 'https://eu1.make.com/api/v2/admin';
	return { baseUrl, auth: `Token ${apikey}`, version: 2, apikey };
}

/**
 * Load Make API settings for the editor that runs the script.
 *
 * Cursor      -> Cursor's settings.json (apps-sdk.environments / apps-sdk.environment)
 * Claude Code -> `make-api-key:` (required) and `make-api-url:` (optional, default eu1.make.com)
 *                in the secrets file.
 *
 * Exits 1 when the editor cannot be told (see requireEditor).
 */
function loadSettings() {
	const editor = requireEditor();
	const loaded = editor === 'claude' ? loadClaudeSettings() : loadCursorSettings();
	return { ...loaded, editor };
}

/** Raw API key only. test-component.js forwards it through process.env.MAKE_API_KEY. */
function getMakeApiKey() {
	return loadSettings().apikey;
}

module.exports = {
	SECRETS_PATH,
	CURSOR_SETTINGS_PATH,
	cursorSettingsPath,
	stripJsonComments,
	parseJsonc,
	readCursorEnvironments,
	isPlaceholder,
	readSkillConfig,
	getEditor,
	requireEditor,
	takeEditorFlagOrExit,
	loadSettings,
	getMakeApiKey,
	loadJiraConfig,
	announceTarget,
};
