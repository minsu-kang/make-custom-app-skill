const fs = require('fs');
const path = require('path');
const os = require('os');
const { getEditorDir, getSkillRoot } = require('./skill-root');

/**
 * Parse the trailing key/value lines of SKILL.md.
 *
 * SKILL.md uses a tail-of-file convention for runtime config (similar to
 * `imt-app-runtime-path:`, `make-apps-mockup-path:`, `jira-email:`, etc.).
 * Each line is `key: value`; whitespace and trailing newlines are tolerated.
 * The most recent (last) occurrence wins so that the installer's "Restore
 * preserved user config" step reliably overrides earlier placeholders.
 */
function readSkillConfig(key) {
	const skillMd = path.join(getSkillRoot(), 'SKILL.md');
	if (!fs.existsSync(skillMd)) return null;
	const content = fs.readFileSync(skillMd, 'utf-8');
	const lines = content.split('\n');
	const re = new RegExp(`^${key}:\\s*(.+)$`);
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = lines[i].match(re);
		if (m) return m[1].trim();
	}
	return null;
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
	console.error('Claude Code requires `make-api-key:` in the last lines of SKILL.md.');
	console.error('Add the following to ~/.claude/skills/make-custom-app/SKILL.md:');
	console.error('');
	console.error('  make-api-key: <your-make-api-token>');
	console.error('  # optional, defaults to https://eu1.make.com/api/v2/admin');
	console.error('  make-api-url: https://eu1.make.com/api/v2/admin');
	console.error('');
	console.error('Generate the token at: https://www.make.com/en/help/api');
	process.exit(1);
}

function loadClaudeSettings() {
	const apikey = readSkillConfig('make-api-key');
	if (!apikey || /^<.*>$/.test(apikey)) failClaudeMissingKey();
	const baseUrl = readSkillConfig('make-api-url') || 'https://eu1.make.com/api/v2/admin';
	return { baseUrl, auth: `Token ${apikey}`, version: 2, apikey };
}

/**
 * Load API settings.
 *
 * Cursor → ~/Library/Application Support/Cursor/User/settings.json
 *           (apps-sdk.environments / apps-sdk.environment)
 * Claude Code → SKILL.md last-lines `make-api-key:` (required) +
 *               `make-api-url:` (optional, default eu1.make.com).
 *
 * The Claude Code path intentionally does NOT fall back to environment
 * variables — SKILL.md is the single source of truth so that scripts
 * behave identically regardless of how the shell was launched.
 */
function loadSettings() {
	if (getEditorDir() === '.claude') {
		return loadClaudeSettings();
	}
	return loadCursorSettings();
}

/**
 * Return only the raw API key string. Used by test-component.js which
 * forwards the key into a child process via process.env.MAKE_API_KEY.
 */
function getMakeApiKey() {
	const s = loadSettings();
	return s.apikey;
}

module.exports = {
	readSkillConfig,
	loadSettings,
	getMakeApiKey,
};
