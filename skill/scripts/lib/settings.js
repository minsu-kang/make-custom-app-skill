const fs = require('fs');
const path = require('path');
const os = require('os');
const { getEditorDir, getSkillRoot } = require('./skill-root');

/**
 * User config file — one `key: value` per line.
 *
 * Lives OUTSIDE the skill directory so it is never loaded into the agent's
 * context (SKILL.md is read by the model every session; this file is read by
 * scripts only). Shared by the Cursor and Claude Code installs.
 *
 *   imt-app-runtime-path: /abs/path       (required)
 *   make-api-key: <token>                 (Claude Code only)
 *   make-api-url: https://eu1.make.com/api/v2/admin   (optional)
 *   make-apps-mockup-path: /abs/path      (optional — test-component.js)
 *   jira-email: you@example.com           (optional — Jira scripts)
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
		const line = lines[i];
		if (line.trimStart().startsWith('>')) continue; // markdown blockquote (legacy SKILL.md samples)
		const m = line.trim().match(re);
		if (m && !isPlaceholder(m[1].trim())) return m[1].trim();
	}
	return null;
}

/**
 * Read one config value. Order: ~/.make-custom-app-skill-secrets, then the legacy
 * SKILL.md tail (pre-2.0 installs) so an un-migrated install keeps working.
 * Placeholder values are ignored. Returns null when unset.
 */
function readSkillConfig(key) {
	if (fs.existsSync(SECRETS_PATH)) {
		const v = lastMatch(fs.readFileSync(SECRETS_PATH, 'utf-8').split('\n'), key);
		if (v) return v;
	}
	const skillMd = path.join(getSkillRoot(), 'SKILL.md');
	if (fs.existsSync(skillMd)) {
		return lastMatch(fs.readFileSync(skillMd, 'utf-8').split('\n'), key);
	}
	return null;
}

/** True when the legacy SKILL.md tail still carries a value for `key`. */
function skillMdHasConfig(key) {
	const skillMd = path.join(getSkillRoot(), 'SKILL.md');
	if (!fs.existsSync(skillMd)) return false;
	return lastMatch(fs.readFileSync(skillMd, 'utf-8').split('\n'), key) !== null;
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
	console.error(`  node ${path.join(getSkillRoot(), 'scripts', 'setup-secrets.js')}`);
	process.exit(1);
}

function loadClaudeSettings() {
	const apikey = readSkillConfig('make-api-key');
	if (!apikey) failClaudeMissingKey();
	const baseUrl = readSkillConfig('make-api-url') || 'https://eu1.make.com/api/v2/admin';
	return { baseUrl, auth: `Token ${apikey}`, version: 2, apikey };
}

/**
 * Load Make API settings.
 *
 * Cursor      → ~/Library/Application Support/Cursor/User/settings.json
 *               (apps-sdk.environments / apps-sdk.environment)
 * Claude Code → ~/.make-custom-app-skill-secrets `make-api-key:` (required) +
 *               `make-api-url:` (optional, default eu1.make.com).
 */
function loadSettings() {
	if (getEditorDir() === '.claude') {
		return loadClaudeSettings();
	}
	return loadCursorSettings();
}

/** Raw API key only — test-component.js forwards it via process.env.MAKE_API_KEY. */
function getMakeApiKey() {
	return loadSettings().apikey;
}

/**
 * Jira credentials for the attachment / transition scripts. Exits with a setup
 * message when email or token is missing.
 */
function loadJiraConfig() {
	const email = readSkillConfig('jira-email');
	const apiToken = readSkillConfig('jira-api-token');
	const baseUrl = readSkillConfig('jira-base-url') || 'https://make.atlassian.net';
	if (!email || !apiToken) {
		console.error('ERROR: Jira credentials not configured.');
		console.error('Run this in your own terminal:\n');
		console.error(`  node ${path.join(getSkillRoot(), 'scripts', 'setup-secrets.js')}\n`);
		console.error('The wizard asks for a Jira API token and fills jira-email from GET /rest/api/3/myself.');
		process.exit(1);
	}
	return { email, apiToken, baseUrl };
}

module.exports = {
	SECRETS_PATH,
	isPlaceholder,
	readSkillConfig,
	skillMdHasConfig,
	loadSettings,
	getMakeApiKey,
	loadJiraConfig,
};
