/**
 * Tests for settings.js in a fake HOME. HOME is set before the module loads because SECRETS_PATH and
 * CURSOR_SETTINGS_PATH are computed when it loads. CLAUDECODE and CURSOR_AGENT are removed first because the
 * suite may itself run inside an editor's shell, and editor resolution reads them.
 */
const { describe, it, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.CLAUDECODE;
delete process.env.CURSOR_AGENT;
const secretsPath = path.join(home, '.make-custom-app-skill-secrets');
const settings = require('../settings');
const { EditorError, setupCommand } = require('../paths');

after(() => fs.rmSync(home, { recursive: true, force: true }));
afterEach(() => {
	fs.rmSync(secretsPath, { recursive: true, force: true });
	delete process.env.CLAUDECODE;
	delete process.env.CURSOR_AGENT;
});

/** Collects what console.error prints. */
function captureErrors(t) {
	const lines = [];
	t.mock.method(console, 'error', (line = '') => lines.push(line));
	return lines;
}

/** Also makes process.exit throw, so the code under test stops where it would exit. */
function captureExit(t) {
	t.mock.method(process, 'exit', (code) => {
		throw new Error(`exit ${code}`);
	});
	return captureErrors(t);
}

/** Runs code in a child process with a fake HOME and only the given editor variables. */
function runChild(code, env = {}) {
	return spawnSync(process.execPath, ['-e', code], {
		env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...env },
		encoding: 'utf8',
	});
}

describe('isPlaceholder', () => {
	it('flags empty values and the sample markers, not real values', () => {
		for (const v of [undefined, null, '', 'your-token', '<token>', 'me@example.com', '/path/to/runtime']) assert.equal(settings.isPlaceholder(v), true, String(v));
		for (const v of ['dev@make.com', 'ATATT3xreal-looking', '/Users/dev/imt-app-runtime']) assert.equal(settings.isPlaceholder(v), false, v);
	});
});

describe('readSkillConfig', () => {
	it('keeps the secrets file in the home folder', () => {
		assert.equal(settings.SECRETS_PATH, secretsPath);
	});

	it('returns null when the file does not exist or has no such key', () => {
		assert.equal(settings.readSkillConfig('jira-email'), null);
		fs.writeFileSync(secretsPath, 'make-team-id: 5\n');
		assert.equal(settings.readSkillConfig('jira-email'), null);
	});

	it('reads the value, and the last real line wins', () => {
		fs.writeFileSync(secretsPath, 'jira-email: old@make.com\nmake-team-id: 5\njira-email: new@make.com\n');
		assert.equal(settings.readSkillConfig('jira-email'), 'new@make.com');
		assert.equal(settings.readSkillConfig('make-team-id'), '5');
	});

	it('skips placeholder lines and falls back to the earlier real value', () => {
		fs.writeFileSync(secretsPath, 'jira-api-token: real-token-value\njira-api-token: <token>\n');
		assert.equal(settings.readSkillConfig('jira-api-token'), 'real-token-value');
	});

	it('ignores blockquote lines and trims the value', () => {
		fs.writeFileSync(secretsPath, '> jira-email: quoted@make.com\n  jira-base-url:   https://x.atlassian.net  \n');
		assert.equal(settings.readSkillConfig('jira-email'), null);
		assert.equal(settings.readSkillConfig('jira-base-url'), 'https://x.atlassian.net');
	});
});

describe('getEditor', () => {
	it('reads the editor from the environment', () => {
		process.env.CLAUDECODE = '1';
		assert.equal(settings.getEditor(), 'claude');
		delete process.env.CLAUDECODE;
		process.env.CURSOR_AGENT = '1';
		assert.equal(settings.getEditor(), 'cursor');
	});

	it('lets Claude Code win when both variables are set', () => {
		process.env.CLAUDECODE = '1';
		process.env.CURSOR_AGENT = '1';
		assert.equal(settings.getEditor(), 'claude');
	});

	it('prefers the editor: line of the secrets file over the environment', () => {
		process.env.CLAUDECODE = '1';
		fs.writeFileSync(secretsPath, 'editor: cursor\n');
		assert.equal(settings.getEditor(), 'cursor');
	});

	it('prefers the flag over the editor: line', () => {
		fs.writeFileSync(secretsPath, 'editor: cursor\n');
		assert.equal(settings.getEditor('claude'), 'claude');
	});

	it('throws EDITOR_UNRESOLVED when nothing says which editor runs', () => {
		assert.throws(() => settings.getEditor(), (err) => err instanceof EditorError && err.code === 'EDITOR_UNRESOLVED');
	});

	it('throws for an editor: line that is neither claude nor cursor', () => {
		fs.writeFileSync(secretsPath, 'editor: zed\n');
		assert.throws(() => settings.getEditor(), /Invalid editor "zed" from editor: line/);
	});
});

describe('requireEditor', () => {
	it('returns the editor when it resolves', () => {
		process.env.CURSOR_AGENT = '1';
		assert.equal(settings.requireEditor(), 'cursor');
		assert.equal(settings.requireEditor('claude'), 'claude');
	});

	it('prints the reason and exits 1 when it does not', (t) => {
		const lines = captureExit(t);
		assert.throws(() => settings.requireEditor(), /exit 1/);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^ERROR: Cannot tell which editor runs this script/);
		assert.match(lines[0], /editor: claude/);
	});

	it('lets other errors through', (t) => {
		captureExit(t);
		fs.mkdirSync(secretsPath);
		assert.throws(() => settings.requireEditor(), (err) => !(err instanceof EditorError) && err.code === 'EISDIR');
	});

	it('exits the process with code 1 in a fake HOME with no editor set', () => {
		const code = `require(${JSON.stringify(path.join(__dirname, '..', 'settings'))}).requireEditor(); console.log('ran');`;
		const r = runChild(code);
		assert.equal(r.status, 1);
		assert.equal(r.stdout, '');
		assert.match(r.stderr, /^ERROR: Cannot tell which editor runs this script \(CLAUDECODE and CURSOR_AGENT are both unset\)/);
	});

	it('continues in a child process when the editor variable is set', () => {
		const code = `console.log(require(${JSON.stringify(path.join(__dirname, '..', 'settings'))}).requireEditor());`;
		const r = runChild(code, { CURSOR_AGENT: '1' });
		assert.equal(r.status, 0);
		assert.equal(r.stdout, 'cursor\n');
	});
});

describe('loadJiraConfig', () => {
	it('returns the credentials with the Make Jira site as the default base URL', () => {
		fs.writeFileSync(secretsPath, 'jira-email: dev@make.com\njira-api-token: tok\n');
		assert.deepEqual(settings.loadJiraConfig(), { email: 'dev@make.com', apiToken: 'tok', baseUrl: 'https://make.atlassian.net' });
		fs.appendFileSync(secretsPath, 'jira-base-url: https://example.atlassian.net\n');
		assert.equal(settings.loadJiraConfig().baseUrl, 'https://example.atlassian.net');
	});

	it('exits 1 with the setup command when the email or token is missing', (t) => {
		const lines = captureExit(t);
		fs.writeFileSync(secretsPath, 'jira-email: dev@make.com\n');
		assert.throws(() => settings.loadJiraConfig(), /exit 1/);
		const printed = lines.join('\n');
		assert.match(printed, /Jira credentials not configured/);
		assert.ok(printed.includes(setupCommand()), printed);
		assert.ok(!printed.includes('--editor'), printed);
	});

	it('adds --editor to the setup command when the editor is known', (t) => {
		const lines = captureExit(t);
		process.env.CURSOR_AGENT = '1';
		assert.throws(() => settings.loadJiraConfig(), /exit 1/);
		assert.ok(lines.join('\n').includes(setupCommand('cursor')), lines.join('\n'));
	});

	it('still prints the setup command when the editor: line is invalid', (t) => {
		const lines = captureExit(t);
		fs.writeFileSync(secretsPath, 'editor: zed\n');
		assert.throws(() => settings.loadJiraConfig(), /exit 1/);
		assert.ok(lines.join('\n').includes(setupCommand()), lines.join('\n'));
	});
});

describe('announceTarget', () => {
	it('prints the editor and the Make API host to stderr', (t) => {
		const lines = captureErrors(t);
		settings.announceTarget({ editor: 'claude', baseUrl: 'https://eu1.make.com/api/v2/admin', auth: 'Token SECRET', apikey: 'SECRET' });
		assert.deepEqual(lines, ['Target: editor=claude, Make API host=eu1.make.com']);
	});

	it('keeps the port of a local Make API', (t) => {
		const lines = captureErrors(t);
		settings.announceTarget({ editor: 'cursor', baseUrl: 'http://localhost:8080/v2' });
		assert.deepEqual(lines, ['Target: editor=cursor, Make API host=localhost:8080']);
	});

	it('prints the raw value when the base URL cannot be parsed', (t) => {
		const lines = captureErrors(t);
		settings.announceTarget({ editor: 'cursor', baseUrl: 'not a url' });
		assert.deepEqual(lines, ['Target: editor=cursor, Make API host=not a url']);
	});

	it('writes to stderr and leaves stdout alone', () => {
		const code = `require(${JSON.stringify(path.join(__dirname, '..', 'settings'))}).announceTarget({ editor: 'cursor', baseUrl: 'https://us1.make.com/v2' });`;
		const r = runChild(code);
		assert.equal(r.status, 0);
		assert.equal(r.stdout, '');
		assert.equal(r.stderr, 'Target: editor=cursor, Make API host=us1.make.com\n');
	});
});

describe('loadSettings for Claude Code', () => {
	beforeEach(() => {
		process.env.CLAUDECODE = '1';
	});

	it('builds the API settings from the secrets file and names the editor', () => {
		fs.writeFileSync(secretsPath, 'make-api-key: KEY123\n');
		assert.deepEqual(settings.loadSettings(), {
			baseUrl: 'https://eu1.make.com/api/v2/admin',
			auth: 'Token KEY123',
			version: 2,
			apikey: 'KEY123',
			editor: 'claude',
		});
		fs.appendFileSync(secretsPath, 'make-api-url: https://us1.make.com/api/v2/admin\n');
		assert.equal(settings.loadSettings().baseUrl, 'https://us1.make.com/api/v2/admin');
		assert.equal(settings.getMakeApiKey(), 'KEY123');
	});

	it('exits 1 with the setup command when the API key is missing', (t) => {
		const lines = captureExit(t);
		assert.throws(() => settings.loadSettings(), /exit 1/);
		const printed = lines.join('\n');
		assert.match(printed, /Make API key not configured/);
		assert.ok(printed.includes(setupCommand('claude')), printed);
	});

	it('follows the editor: line over the environment', () => {
		process.env.CURSOR_AGENT = '1';
		fs.writeFileSync(secretsPath, 'editor: claude\nmake-api-key: KEY123\n');
		assert.equal(settings.loadSettings().editor, 'claude');
	});
});

describe('loadSettings without an editor', () => {
	it('prints the editor message and exits 1', (t) => {
		const lines = captureExit(t);
		assert.throws(() => settings.loadSettings(), /exit 1/);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^ERROR: Cannot tell which editor runs this script/);
	});
});

describe('loadSettings for Cursor', () => {
	function writeCursorSettings(text) {
		fs.mkdirSync(path.dirname(settings.CURSOR_SETTINGS_PATH), { recursive: true });
		fs.writeFileSync(settings.CURSOR_SETTINGS_PATH, text);
	}

	const JSONC = `{
	// Make Apps SDK
	"editor.fontSize": 14, /* block comment */
	"apps-sdk.environment": "uuid-2",
	"apps-sdk.environments": [
		{ "uuid": "uuid-1", "url": "eu1.make.com", "apikey": "KEY1", },
		{ "uuid": "uuid-2", "url": "us1.make.com", "apikey": "KEY2", "admin": true },
	],
}`;

	beforeEach(() => {
		process.env.CURSOR_AGENT = '1';
	});

	afterEach(() => fs.rmSync(settings.CURSOR_SETTINGS_PATH, { force: true }));

	it('reads the active environment from a settings.json with comments and trailing commas', () => {
		writeCursorSettings(JSONC);
		assert.deepEqual(settings.loadSettings(), {
			baseUrl: 'https://us1.make.com/v2/admin',
			auth: 'Token KEY2',
			version: 2,
			apikey: 'KEY2',
			editor: 'cursor',
		});
		assert.equal(settings.getMakeApiKey(), 'KEY2');
	});

	it('falls back to the first environment when none is active or the active one is unknown', () => {
		writeCursorSettings(JSONC.replace('"uuid-2",\n', '"uuid-gone",\n'));
		assert.equal(settings.loadSettings().apikey, 'KEY1');
		writeCursorSettings(JSONC.replace(/\t"apps-sdk.environment": "uuid-2",\n/, ''));
		assert.equal(settings.loadSettings().baseUrl, 'https://eu1.make.com/v2');
	});

	const URLS = [
		{ name: 'version 2 is the default', env: {}, expected: 'https://eu1.make.com/v2' },
		{ name: 'version 1 has no admin path', env: { version: 1, admin: true }, expected: 'https://eu1.make.com/v1' },
		{ name: 'version 3', env: { version: 3 }, expected: 'https://eu1.make.com/v3' },
		{ name: 'admin', env: { admin: true }, expected: 'https://eu1.make.com/v2/admin' },
		{ name: 'noVersionPath', env: { noVersionPath: true }, expected: 'https://eu1.make.com' },
		{ name: 'noVersionPath with admin', env: { noVersionPath: true, admin: true }, expected: 'https://eu1.make.com/admin' },
		{ name: 'unsafe uses http', env: { unsafe: true, url: 'localhost:8080' }, expected: 'http://localhost:8080/v2' },
	];

	for (const row of URLS) {
		it(`builds the base URL: ${row.name}`, () => {
			writeCursorSettings(JSON.stringify({ 'apps-sdk.environments': [{ uuid: 'u', url: 'eu1.make.com', apikey: 'K', ...row.env }] }));
			const loaded = settings.loadSettings();
			assert.equal(loaded.baseUrl, row.expected);
			assert.equal(loaded.version, row.env.version || 2);
		});
	}

	it('exits 1 when apps-sdk.environments is missing or empty', (t) => {
		const lines = captureExit(t);
		for (const text of ['{}', '{ "apps-sdk.environments": [] }']) {
			writeCursorSettings(text);
			assert.throws(() => settings.loadSettings(), /exit 1/);
		}
		assert.deepEqual(lines, Array(2).fill('ERROR: apps-sdk.environments configuration not found.'));
	});

	it('takes the key from Cursor and ignores make-api-key of the secrets file', () => {
		writeCursorSettings(JSONC);
		fs.writeFileSync(secretsPath, 'editor: cursor\nmake-api-key: CLAUDE_KEY\n');
		process.env.CLAUDECODE = '1';
		const loaded = settings.loadSettings();
		assert.equal(loaded.editor, 'cursor');
		assert.equal(loaded.apikey, 'KEY2');
	});
});
