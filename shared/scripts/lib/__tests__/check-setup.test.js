/**
 * Spawn tests for check-setup.js. Every run is a child process with a fake HOME and TMPDIR and only the editor
 * variables the test passes. HOME is set before settings.js loads, because it computes its paths at load time.
 * The network is blocked in every child (a preload that records each connect attempt), so a test fails instead of
 * calling the real Jira.
 */
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'check-setup-test-'));
const home = path.join(work, 'home');
const tmp = path.join(work, 'tmp');
const aux = path.join(work, 'aux');
for (const dir of [home, tmp, aux]) fs.mkdirSync(dir);
process.env.HOME = home;
process.env.USERPROFILE = home;
const { CURSOR_SETTINGS_PATH, SECRETS_PATH } = require('../settings');
const { PLUGIN_ROOT, setupCommand } = require('../paths');
const { cacheKey, JIRA_BASE_URL } = require('../access-guard-logic');

const CHECK_SETUP = path.join(__dirname, '..', '..', 'check-setup.js');
const CACHE_FILE = path.join(tmp, 'make-custom-app-access-check.json');
const BLOCKER = path.join(aux, 'block-network.js');
const NET_LOG = path.join(aux, 'net.log');
const EMAIL = 'dev@make.com';
const SECRET_VALUES = ['MAKE_KEY_secret_value', 'JIRA_TOKEN_secret_value', 'PINECONE_secret_value', 'OPENAI_secret_value'];

fs.writeFileSync(
	BLOCKER,
	[
		"const fs = require('fs');",
		"const net = require('net');",
		'net.Socket.prototype.connect = function connect() {',
		`\tfs.appendFileSync(${JSON.stringify(NET_LOG)}, 'connect\\n');`,
		"\tthrow new Error('network blocked by the test');",
		'};',
	].join('\n'),
);

beforeEach(() => {
	for (const dir of [home, tmp]) {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir);
	}
	fs.rmSync(NET_LOG, { force: true });
});

after(() => fs.rmSync(work, { recursive: true, force: true }));

function run(args = [], env = {}) {
	return spawnSync(process.execPath, [CHECK_SETUP, ...args], {
		env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, NODE_OPTIONS: `--require ${JSON.stringify(BLOCKER)}`, ...env },
		encoding: 'utf8',
	});
}

function connectAttempts() {
	return fs.existsSync(NET_LOG) ? fs.readFileSync(NET_LOG, 'utf8').split('\n').filter(Boolean).length : 0;
}

/** Item status and detail by key, read from the human-readable report. */
function parseItems(stdout) {
	const items = {};
	for (const m of stdout.matchAll(/^(OK|MISSING|OPTIONAL) +(.+?): (.*)$/gm)) items[m[2]] = { status: m[1], detail: m[3] };
	return items;
}

function statuses(stdout) {
	return Object.fromEntries(Object.entries(parseItems(stdout)).map(([key, item]) => [key, item.status]));
}

function mkdir(...parts) {
	const dir = path.join(home, ...parts);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** A complete Claude Code setup. Jira lookups are answered from the cache file, so no test needs the network. */
function fullConfig() {
	return {
		'imt-app-runtime-path': mkdir('imt-app-runtime'),
		'make-api-key': SECRET_VALUES[0],
		'make-apps-mockup-path': mkdir('make-apps-mockup'),
		'make-team-id': '12345',
		'jira-email': EMAIL,
		'jira-api-token': SECRET_VALUES[1],
		'pinecone-api-key': SECRET_VALUES[2],
		'pinecone-index-name': 'make-app-contexts',
		'openai-api-key': SECRET_VALUES[3],
	};
}

function save(config) {
	fs.writeFileSync(SECRETS_PATH, `${Object.entries(config).map(([key, value]) => `${key}: ${value}`).join('\n')}\n`, { mode: 0o600 });
	if (config['jira-email'] && config['jira-api-token']) {
		const key = cacheKey({ baseUrl: JIRA_BASE_URL, email: config['jira-email'], token: config['jira-api-token'] });
		fs.writeFileSync(CACHE_FILE, JSON.stringify({ key, email: config['jira-email'], checkedAt: Date.now() }));
	}
}

function assertNoSecrets(r) {
	for (const value of SECRET_VALUES) assert.ok(!r.stdout.includes(value) && !r.stderr.includes(value), `${value} leaked`);
}

describe('the test harness', () => {
	it('records a connect attempt of a child process', () => {
		const r = spawnSync(process.execPath, ['-e', "fetch('http://127.0.0.1:65000/').catch(() => {})"], {
			env: { PATH: process.env.PATH, HOME: home, NODE_OPTIONS: `--require ${JSON.stringify(BLOCKER)}` },
		});
		assert.equal(r.status, 0);
		assert.ok(connectAttempts() >= 1);
	});
});

describe('check-setup in a fake HOME, Claude Code', () => {
	const CLAUDE = { CLAUDECODE: '1' };

	it('exits 1 and lists every missing item when nothing is set up, without any network call', () => {
		const r = run([], CLAUDE);
		assert.equal(r.status, 1);
		assert.equal(r.stderr, '');
		assert.ok(r.stdout.startsWith(`make-custom-app setup — claude — ${PLUGIN_ROOT}\n`), r.stdout);
		assert.deepEqual(statuses(r.stdout), {
			'imt-app-runtime-path': 'MISSING',
			'make-api-key': 'MISSING',
			'make-apps-mockup-path': 'OPTIONAL',
			'make account': 'MISSING',
			'make-team-id': 'OPTIONAL',
			'mcp-server': 'OPTIONAL',
		});
		const items = parseItems(r.stdout);
		assert.equal(items['imt-app-runtime-path'].detail, 'not set');
		assert.equal(items['make-api-key'].detail, 'not set (Claude Code reads it from ~/.make-custom-app-skill-secrets)');
		assert.match(items['make account'].detail, /^This skill is for Make employees\. .* no Jira API token is saved yet\.$/);
		assert.ok(r.stdout.includes(`Interactive wizard (your terminal, not the agent):\n  ${setupCommand('claude')}`), r.stdout);
		assert.ok(r.stdout.trimEnd().endsWith('Setup INCOMPLETE — required items missing. Stop and apply the REQUIRED fixes above.'), r.stdout);
		assert.doesNotMatch(r.stdout, /LEGACY_INSTALL/);
		assert.equal(connectAttempts(), 0);
	});

	it('exits 0 with Setup OK when everything is configured, and prints no secret', () => {
		save(fullConfig());
		const r = run([], CLAUDE);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.equal(r.stderr, '');
		assert.deepEqual(statuses(r.stdout), {
			'imt-app-runtime-path': 'OK',
			'make-api-key': 'OK',
			'make-apps-mockup-path': 'OK',
			'make account': 'OK',
			'make-team-id': 'OK',
			'mcp-server': 'OK',
		});
		const items = parseItems(r.stdout);
		assert.equal(items['make account'].detail, EMAIL);
		assert.equal(items['make-api-key'].detail, 'set (https://eu1.make.com/api/v2/admin)');
		assert.match(items['mcp-server'].detail, /keys are in .*make-custom-app-skill-secrets.*cannot check whether the server is registered/);
		assert.ok(r.stdout.trimEnd().endsWith('Setup OK.'), r.stdout);
		assert.doesNotMatch(r.stdout, /Fixes:/);
		assertNoSecrets(r);
		assert.equal(connectAttempts(), 0);
	});

	it('flags paths that do not exist and a team id that is not a number', () => {
		save({ ...fullConfig(), 'imt-app-runtime-path': path.join(home, 'gone'), 'make-apps-mockup-path': path.join(home, 'gone-too'), 'make-team-id': 'abc' });
		const r = run([], CLAUDE);
		assert.equal(r.status, 1);
		const items = parseItems(r.stdout);
		assert.deepEqual(items['imt-app-runtime-path'], { status: 'MISSING', detail: `path does not exist: ${path.join(home, 'gone')}` });
		assert.deepEqual(items['make-apps-mockup-path'], { status: 'OPTIONAL', detail: `path does not exist: ${path.join(home, 'gone-too')}` });
		assert.deepEqual(items['make-team-id'], { status: 'OPTIONAL', detail: 'not a team id: abc' });
	});

	it('treats missing Pinecone and OpenAI keys as optional and names them, whatever an old MCP registration says', () => {
		const config = fullConfig();
		delete config['pinecone-index-name'];
		delete config['openai-api-key'];
		save(config);
		fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node' } } }));
		const r = run([], CLAUDE);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const item = parseItems(r.stdout)['mcp-server'];
		assert.equal(item.status, 'OPTIONAL');
		assert.match(item.detail, /missing in .*make-custom-app-skill-secrets: pinecone-index-name, openai-api-key$/);
		assert.ok(r.stdout.includes(`  ${setupCommand('claude')}`), r.stdout);
	});

	it('writes machine-readable JSON with --json and nothing else on stdout', () => {
		save(fullConfig());
		const r = run(['--json'], CLAUDE);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const report = JSON.parse(r.stdout);
		assert.equal(report.ok, true);
		assert.equal(report.editor, 'claude');
		assert.equal(report.pluginRoot, PLUGIN_ROOT);
		assert.equal(report.setupCommand, setupCommand('claude'));
		assert.deepEqual(report.items.map((i) => [i.key, i.status]), [
			['imt-app-runtime-path', 'ok'],
			['make-api-key', 'ok'],
			['make-apps-mockup-path', 'ok'],
			['make account', 'ok'],
			['make-team-id', 'ok'],
			['mcp-server', 'ok'],
		]);
		assertNoSecrets(r);
	});

	it('ignores the removed --skip-version flag', () => {
		save(fullConfig());
		const r = run(['--skip-version'], CLAUDE);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.ok(r.stdout.trimEnd().endsWith('Setup OK.'), r.stdout);
	});
});

describe('check-setup in a fake HOME, choosing the editor', () => {
	it('exits 1 with the editor message when nothing says which editor runs it', () => {
		const r = run();
		assert.equal(r.status, 1);
		assert.equal(r.stdout, '');
		assert.match(r.stderr, /^ERROR: Cannot tell which editor runs this script \(CLAUDECODE and CURSOR_AGENT are both unset\)/);
	});

	it('takes the editor from --editor when the environment says nothing', () => {
		const r = run(['--editor', 'cursor']);
		assert.equal(r.status, 1);
		assert.ok(r.stdout.startsWith(`make-custom-app setup — cursor — ${PLUGIN_ROOT}\n`), r.stdout);
		assert.ok(r.stdout.includes(`  ${setupCommand('cursor')}`), r.stdout);
		assert.equal(statuses(r.stdout)['make-api (Cursor settings.json)'], 'MISSING');
		assert.equal(statuses(r.stdout)['make-api-key'], undefined);
	});

	it('--editor=cursor works', () => {
		const r = run(['--editor=cursor']);
		assert.equal(r.status, 1);
		assert.ok(r.stdout.startsWith(`make-custom-app setup — cursor — ${PLUGIN_ROOT}\n`), r.stdout);
		assert.ok(r.stdout.includes(`  ${setupCommand('cursor')}`), r.stdout);
		assert.equal(statuses(r.stdout)['make-api (Cursor settings.json)'], 'MISSING');
		const json = JSON.parse(run(['--json', '--editor=cursor']).stdout);
		assert.equal(json.editor, 'cursor');
	});

	it('--editor claude does not hide --json from the report', () => {
		const r = run(['--editor', 'claude', '--json']);
		assert.equal(JSON.parse(r.stdout).editor, 'claude');
	});

	it('rejects an --editor value that is neither claude nor cursor, or missing', () => {
		const bad = run(['--editor', 'zed']);
		assert.equal(bad.status, 1);
		assert.equal(bad.stdout, '');
		assert.equal(bad.stderr, 'ERROR: Invalid editor "zed" from --editor flag. Use claude or cursor.\n');
		for (const args of [['--editor'], ['--editor', '--json'], ['--editor=']]) {
			const none = run(args);
			assert.equal(none.status, 1, args.join(' '));
			assert.equal(none.stdout, '');
			assert.equal(none.stderr, 'ERROR: --editor needs a value: claude or cursor.\n', args.join(' '));
		}
	});

	it('reads the API environment from the Cursor settings.json instead of make-api-key', () => {
		const config = fullConfig();
		delete config['make-api-key'];
		save({ editor: 'cursor', ...config });
		fs.mkdirSync(path.dirname(CURSOR_SETTINGS_PATH), { recursive: true });
		fs.writeFileSync(CURSOR_SETTINGS_PATH, '{\n\t// Make Apps SDK\n\t"apps-sdk.environments": [{ "uuid": "u", "url": "eu1.make.com", "apikey": "CURSOR_KEY_secret", },],\n}');
		const r = run();
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.ok(r.stdout.startsWith(`make-custom-app setup — cursor — ${PLUGIN_ROOT}\n`), r.stdout);
		assert.deepEqual(parseItems(r.stdout)['make-api (Cursor settings.json)'], { status: 'OK', detail: 'apps-sdk.environments present' });
		assert.ok(!r.stdout.includes('CURSOR_KEY_secret'));
		assert.equal(connectAttempts(), 0);
	});

	it('a Cursor settings.json with a proxy URL and a valid environment passes', () => {
		const config = fullConfig();
		delete config['make-api-key'];
		save({ editor: 'cursor', ...config });
		fs.mkdirSync(path.dirname(CURSOR_SETTINGS_PATH), { recursive: true });
		fs.writeFileSync(
			CURSOR_SETTINGS_PATH,
			'{\n\t"http.proxy": "http://proxy.corp:8080", // office proxy\n\t"apps-sdk.environments": [{ "uuid": "u", "url": "eu1.make.com", "apikey": "CURSOR_KEY_secret", },],\n}',
		);
		const r = run();
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(parseItems(r.stdout)['make-api (Cursor settings.json)'], { status: 'OK', detail: 'apps-sdk.environments present' });
		assert.ok(!r.stdout.includes('CURSOR_KEY_secret'));
	});

	it('reports a Cursor settings.json that has no environments as missing', () => {
		fs.mkdirSync(path.dirname(CURSOR_SETTINGS_PATH), { recursive: true });
		for (const text of ['{}', '{ "apps-sdk.environments": [] }']) {
			fs.writeFileSync(CURSOR_SETTINGS_PATH, text);
			const item = parseItems(run([], { CURSOR_AGENT: '1' }).stdout)['make-api (Cursor settings.json)'];
			assert.deepEqual(item, { status: 'MISSING', detail: `apps-sdk.environments not found in ${CURSOR_SETTINGS_PATH}` }, text);
		}
	});

	it('reports a missing Cursor settings.json as missing, with the path', () => {
		const r = run([], { CURSOR_AGENT: '1' });
		assert.equal(r.status, 1);
		assert.deepEqual(parseItems(r.stdout)['make-api (Cursor settings.json)'], {
			status: 'MISSING',
			detail: `Cursor settings file not found: ${CURSOR_SETTINGS_PATH}`,
		});
		assert.ok(r.stdout.includes('[REQUIRED] make-api (Cursor settings.json)'), r.stdout);
	});

	it('reports a Cursor settings.json that cannot be read as missing, without any file content', () => {
		fs.mkdirSync(path.dirname(CURSOR_SETTINGS_PATH), { recursive: true });
		fs.writeFileSync(CURSOR_SETTINGS_PATH, '{\n\t"apps-sdk.environments": [{ "apikey": "CURSOR_KEY_secret" "x": 1 }]\n}');
		const r = run([], { CURSOR_AGENT: '1' });
		assert.deepEqual(parseItems(r.stdout)['make-api (Cursor settings.json)'], {
			status: 'MISSING',
			detail: 'cannot read the file: invalid JSON near line 2',
		});
		assert.ok(!r.stdout.includes('CURSOR_KEY_secret') && !r.stderr.includes('CURSOR_KEY_secret'));
		fs.writeFileSync(CURSOR_SETTINGS_PATH, 'not json');
		const second = parseItems(run([], { CURSOR_AGENT: '1' }).stdout)['make-api (Cursor settings.json)'];
		assert.equal(second.status, 'MISSING');
		assert.ok(!second.detail.includes('not json'), second.detail);
	});

	it('tells the user to fix the JSON of an unreadable Cursor settings.json, not to install the extension', () => {
		fs.mkdirSync(path.dirname(CURSOR_SETTINGS_PATH), { recursive: true });
		fs.writeFileSync(CURSOR_SETTINGS_PATH, '{\n\t"apps-sdk.environments": [{ "apikey": "CURSOR_KEY_secret" "x": 1 }]\n}');
		const withLine = run([], { CURSOR_AGENT: '1' }).stdout;
		assert.ok(withLine.includes(`[REQUIRED] make-api (Cursor settings.json)\nFix the JSON in ${CURSOR_SETTINGS_PATH}, near line 2, then run check-setup again.\n`), withLine);
		assert.ok(!withLine.includes('Install the Make Apps SDK extension'), withLine);
		assert.equal(withLine.split(CURSOR_SETTINGS_PATH).length - 1, 1, 'the path is printed once');
		fs.writeFileSync(CURSOR_SETTINGS_PATH, 'not json');
		const noLine = run([], { CURSOR_AGENT: '1' }).stdout;
		assert.ok(noLine.includes(`[REQUIRED] make-api (Cursor settings.json)\nFix the JSON in ${CURSOR_SETTINGS_PATH}, then run check-setup again.\n`), noLine);
	});

	it('keeps the install text for a missing settings.json and for one without environments', () => {
		const missing = run([], { CURSOR_AGENT: '1' }).stdout;
		assert.ok(missing.includes('Install the Make Apps SDK extension in Cursor'), missing);
		fs.mkdirSync(path.dirname(CURSOR_SETTINGS_PATH), { recursive: true });
		fs.writeFileSync(CURSOR_SETTINGS_PATH, '{}');
		const empty = run([], { CURSOR_AGENT: '1' }).stdout;
		assert.ok(empty.includes('Install the Make Apps SDK extension in Cursor'), empty);
	});
});

describe('check-setup in a fake HOME, old 2.x install left behind', () => {
	const CLAUDE = { CLAUDECODE: '1' };
	const TOKEN = 'LEGACY_MCP_TOKEN_secret_value';

	function leaveOldInstall() {
		const skillDir = mkdir('.claude', 'skills', 'make-custom-app');
		const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
		fs.writeFileSync(claudeMd, '<!-- make-custom-app-skill -->\nold block\n<!-- /make-custom-app-skill -->\n');
		const claudeJson = path.join(home, '.claude.json');
		fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node', env: { OPENAI_API_KEY: TOKEN } } } }));
		return { skillDir, claudeMd, claudeJson };
	}

	it('prints the LEGACY_INSTALL line and the item paths before the verdict, and still exits 0', () => {
		save(fullConfig());
		const old = leaveOldInstall();
		const r = run([], CLAUDE);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const warning = [
			'LEGACY_INSTALL: 3 old install item(s) found; run the make-app-setup skill to clean up',
			`  ${old.skillDir} (old skill folder)`,
			`  ${old.claudeMd} (old skill block)`,
			`  ${old.claudeJson} (old MCP server entry "make-custom-app")`,
		];
		assert.ok(r.stdout.includes(`\n${warning.join('\n')}\n\nSetup OK.\n`), r.stdout);
		assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), 'MCP token leaked');
		assertNoSecrets(r);
	});

	it('warns and still exits 1 when required items are missing, without any network call', () => {
		mkdir('.cursor', 'rules', 'make-custom-app');
		const r = run([], CLAUDE);
		assert.equal(r.status, 1);
		assert.match(r.stdout, /^LEGACY_INSTALL: 1 old install item\(s\) found; run the make-app-setup skill to clean up$/m);
		assert.ok(r.stdout.trimEnd().endsWith('Setup INCOMPLETE — required items missing. Stop and apply the REQUIRED fixes above.'), r.stdout);
		assert.equal(connectAttempts(), 0);
	});

	it('lists the old install items in --json and keeps stdout pure JSON', () => {
		save(fullConfig());
		const old = leaveOldInstall();
		const r = run(['--json'], CLAUDE);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const report = JSON.parse(r.stdout);
		assert.equal(report.ok, true);
		assert.deepEqual(report.legacyInstall, [
			{ kind: 'skill-dir', path: old.skillDir, editor: 'claude' },
			{ kind: 'sentinel', path: old.claudeMd, editor: 'claude', closed: true },
			{ kind: 'mcp-entry', path: old.claudeJson, editor: 'claude', name: 'make-custom-app' },
		]);
		assert.ok(!r.stdout.includes(TOKEN), 'MCP token leaked');
	});

	it('reports an empty legacyInstall list in --json when nothing is left over', () => {
		save(fullConfig());
		const r = run(['--json'], CLAUDE);
		assert.deepEqual(JSON.parse(r.stdout).legacyInstall, []);
	});
});
