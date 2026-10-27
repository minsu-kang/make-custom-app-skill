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

const CURSOR_SETTINGS_PATH = path.join(
	os.homedir(),
	process.platform === 'win32'
		? 'AppData/Roaming/Cursor/User/settings.json'
		: 'Library/Application Support/Cursor/User/settings.json',
);

function parseJsonc(text) {
	let cleaned = text.replace(/\/\/.*$/gm, '');
	cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
	cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
	return JSON.parse(cleaned);
}

function loadCursorSettings() {
	const raw = fs.readFileSync(CURSOR_SETTINGS_PATH, 'utf-8');
	const settings = parseJsonc(raw);

	const activeUuid = settings['apps-sdk.environment'];
	const environments = settings['apps-sdk.environments'] || [];

	const env = environments.find((e) => e.uuid === activeUuid) || environments[0];
	if (!env) {
		console.error('ERROR: apps-sdk.environments configuration not found.');
		process.exit(1);
	}

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
