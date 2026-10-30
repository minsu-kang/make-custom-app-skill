/**
 * Spawn tests for check-setup.js. Every run is a child process with a fake HOME and TMPDIR and only the editor
 * variables the test passes. HOME is set before settings.js loads, because it computes its paths at load time.
 * The network is blocked in every child (a preload that records each connect attempt), so a test fails instead of
 * calling the real Jira. The file moves HOME and the temp folders into a temporary root first (isolate-home); the tests
 * of a declined cleanup run on a synthetic old install (buildFakeLegacyHome) and read the marker the CLI writes.
 */
require('./isolate-home');
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
const { buildFakeLegacyHome } = require('./fake-legacy-home');

const CHECK_SETUP = path.join(__dirname, '..', '..', 'check-setup.js');
const CLEANUP_LEGACY = path.join(__dirname, '..', '..', 'cleanup-legacy.js');
const CACHE_FILE = path.join(tmp, 'make-custom-app-access-check.json');
const BLOCKER = path.join(aux, 'block-network.js');
const NET_LOG = path.join(aux, 'net.log');
const DATE_BREAKER = path.join(aux, 'break-date-now.js');
const EMAIL = 'dev@make.com';
const SECRET_VALUES = ['MAKE_KEY_secret_value', 'JIRA_TOKEN_secret_value', 'PINECONE_secret_value', 'OPENAI_secret_value', 'ENV_OPENAI_secret_value'];
const UPDATE_CACHE_FILE = path.join(tmp, 'make-custom-app-update-check.json');

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

// Makes Date.now throw for a call made directly by check-setup.js, and for no other caller.
fs.writeFileSync(
	DATE_BREAKER,
	[
		'const real = Date.now;',
		'Date.now = function now() {',
		"\tconst caller = new Error().stack.split('\\n')[2] || '';",
		"\tif (caller.includes('check-setup.js')) throw new Error('Date.now broken by the test');",
		'\treturn real();',
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
		env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, NODE_OPTIONS: `--require ${JSON.stringify(BLOCKER)}`, MAKE_CUSTOM_APP_SKIP_UPDATE_CHECK: '1', ...env },
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
		assert.match(items['mcp-server'].detail, /keys are set \(environment or .*make-custom-app-skill-secrets\); cannot check whether the server is registered/);
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
		delete config['pinecone-api-key'];
		delete config['openai-api-key'];
		save(config);
		fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node' } } }));
		const r = run([], CLAUDE);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const item = parseItems(r.stdout)['mcp-server'];
		assert.equal(item.status, 'OPTIONAL');
		assert.match(item.detail, /^missing: pinecone-api-key, openai-api-key \(set MAKE_APP_CONTEXT_PINECONE_API_KEY, MAKE_APP_CONTEXT_OPENAI_API_KEY or the same key in .*make-custom-app-skill-secrets\)$/);
		assert.ok(r.stdout.includes(`  ${setupCommand('claude')}`), r.stdout);
	});

	it('does not ask for the index name, which the server defaults', () => {
		const config = fullConfig();
		delete config['pinecone-index-name'];
		save(config);
		const r = run([], CLAUDE);
		assert.equal(parseItems(r.stdout)['mcp-server'].status, 'OK');
	});

	it('takes a key from the MAKE_APP_CONTEXT_* variable, and never prints its value', () => {
		const config = fullConfig();
		delete config['openai-api-key'];
		save(config);
		const r = run([], { ...CLAUDE, MAKE_APP_CONTEXT_OPENAI_API_KEY: SECRET_VALUES[4] });
		assert.equal(parseItems(r.stdout)['mcp-server'].status, 'OK');
		assertNoSecrets(r);
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
		fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node', args: [path.join(skillDir, 'mcp-server', 'dist', 'index.js')], env: { OPENAI_API_KEY: TOKEN } } } }));
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

describe('check-setup in a fake HOME, after the old install was declined', () => {
	const DAY = 24 * 60 * 60 * 1000;
	const KEPT = 'OLD_INSTALL_KEPT: 3 old install item(s) kept; the old skill still loads beside the plugin. Ask for make-app-setup to remove them.';
	const LEGACY = 'LEGACY_INSTALL: 3 old install item(s) found; run the make-app-setup skill to clean up';
	let homes = 0;

	/** A synthetic 2.x install (Claude Code items) in its own root; `complete` adds the config that makes the exit code 0. */
	function oldHome({ complete = true, ...options } = {}) {
		const root = path.join(aux, `old-${homes++}`);
		fs.mkdirSync(root);
		const h = buildFakeLegacyHome({ editors: ['claude'], ...options, root, pluginRoot: PLUGIN_ROOT });
		if (complete) {
			const runtime = path.join(h.home, 'imt-app-runtime');
			fs.mkdirSync(runtime);
			const lines = [`imt-app-runtime-path: ${runtime}`, `make-api-key: ${SECRET_VALUES[0]}`, `jira-email: ${EMAIL}`, `jira-api-token: ${SECRET_VALUES[1]}`];
			fs.appendFileSync(h.paths.secrets, `${lines.join('\n')}\n`);
			const key = cacheKey({ baseUrl: JIRA_BASE_URL, email: EMAIL, token: SECRET_VALUES[1] });
			fs.writeFileSync(path.join(h.paths.tmp, 'make-custom-app-access-check.json'), JSON.stringify({ key, email: EMAIL, checkedAt: Date.now() }));
		}
		return h;
	}

	/** check-setup with exactly the environment of the fake home, as Claude Code, without the update check. */
	function runIn(h, args = [], env = {}) {
		const result = spawnSync(process.execPath, [CHECK_SETUP, ...args], {
			env: { ...h.env, CLAUDECODE: '1', NODE_OPTIONS: `--require ${JSON.stringify(BLOCKER)}`, MAKE_CUSTOM_APP_SKIP_UPDATE_CHECK: '1', ...env },
			encoding: 'utf8',
		});
		assert.equal(result.error, undefined);
		assert.doesNotMatch(`${result.stdout}${result.stderr}`, /fake claude:/);
		return result;
	}

	function cleanup(h, args, env = {}) {
		const result = spawnSync(process.execPath, [CLEANUP_LEGACY, ...args], { env: { ...h.env, ...env }, cwd: h.paths.root, encoding: 'utf8' });
		assert.equal(result.error, undefined);
		return result;
	}

	/** The digest of the plan now, as the CLI prints it; the fake claude log is cleared, because the plan starts that binary. */
	function planDigestOf(h, env) {
		const result = cleanup(h, ['--plan'], env);
		assert.equal(result.status, 0, result.stderr);
		fs.rmSync(h.log, { force: true });
		return JSON.parse(result.stdout).digest;
	}

	const markerFile = (h) => path.join(h.home, '.make-custom-app', 'legacy-cleanup.json');

	function writeMarker(h, { digest = planDigestOf(h), declinedAt = Date.now(), text } = {}) {
		fs.mkdirSync(path.dirname(markerFile(h)), { recursive: true, mode: 0o700 });
		fs.writeFileSync(markerFile(h), text ?? JSON.stringify({ schema: 1, declinedAt: new Date(declinedAt).toISOString(), digest }), { mode: 0o600 });
	}

	const legacyLines = (h, heading) => [heading, `  ${h.paths.claudeSkill} (old skill folder)`, `  ${h.paths.claudeMd} (old skill block)`, `  ${h.paths.claudeJson} (old MCP server entry "make-custom-app")`];
	const claudeCalls = (h) => (fs.existsSync(h.log) ? fs.readFileSync(h.log, 'utf8').split('\n').filter(Boolean).length : 0);

	it('a fresh decline marker with the current digest prints OLD_INSTALL_KEPT instead of LEGACY_INSTALL', () => {
		const h = oldHome();
		const declined = cleanup(h, ['--decline', planDigestOf(h)]);
		assert.equal(declined.status, 0, declined.stdout + declined.stderr);
		const r = runIn(h);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.equal(r.stderr, '');
		assert.ok(r.stdout.includes(`\n${legacyLines(h, KEPT).join('\n')}\n\nSetup OK.\n`), r.stdout);
		assert.doesNotMatch(r.stdout, /LEGACY_INSTALL/);
		assertNoSecrets(r);
		assert.equal(connectAttempts(), 0);
	});

	it('shows LEGACY_INSTALL, with the same item lines, when no marker exists', () => {
		const h = oldHome();
		const r = runIn(h);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.ok(r.stdout.includes(`\n${legacyLines(h, LEGACY).join('\n')}\n\nSetup OK.\n`), r.stdout);
		assert.doesNotMatch(r.stdout, /OLD_INSTALL_KEPT/);
	});

	it('a marker that is 6 days old still counts', () => {
		const h = oldHome();
		writeMarker(h, { declinedAt: Date.now() - 6 * DAY });
		const r = runIn(h);
		assert.ok(r.stdout.includes(KEPT), r.stdout);
		assert.doesNotMatch(r.stdout, /LEGACY_INSTALL/);
	});

	it('an 8-day-old marker brings LEGACY_INSTALL back', () => {
		const h = oldHome();
		writeMarker(h, { declinedAt: Date.now() - 8 * DAY });
		const r = runIn(h);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.ok(r.stdout.includes(`\n${legacyLines(h, LEGACY).join('\n')}\n`), r.stdout);
		assert.doesNotMatch(r.stdout, /OLD_INSTALL_KEPT/);
	});

	it('a marker dated in the future does not count', () => {
		const h = oldHome();
		writeMarker(h, { declinedAt: Date.now() + DAY });
		const r = runIn(h);
		assert.ok(r.stdout.includes(LEGACY), r.stdout);
		assert.doesNotMatch(r.stdout, /OLD_INSTALL_KEPT/);
	});

	it('a changed old install brings LEGACY_INSTALL back', () => {
		const h = oldHome();
		const digest = planDigestOf(h);
		writeMarker(h, { digest });
		assert.ok(runIn(h).stdout.includes(KEPT), 'the marker counts before the change');
		fs.writeFileSync(path.join(h.paths.claudeSkill, 'added-after-the-decline.txt'), 'x\n');
		assert.notEqual(planDigestOf(h), digest, 'the change reaches the plan digest');
		const r = runIn(h);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.ok(r.stdout.includes(`\n${legacyLines(h, LEGACY).join('\n')}\n`), r.stdout);
		assert.doesNotMatch(r.stdout, /OLD_INSTALL_KEPT/);
	});

	it('a malformed marker is ignored', () => {
		const h = oldHome();
		const digest = planDigestOf(h);
		const at = new Date().toISOString();
		const texts = [
			'',
			'not json',
			'[]',
			'null',
			JSON.stringify({ schema: 2, declinedAt: at, digest }),
			JSON.stringify({ schema: 1, declinedAt: at }),
			JSON.stringify({ schema: 1, declinedAt: 'yesterday', digest }),
			JSON.stringify({ schema: 1, declinedAt: at, digest: digest.toUpperCase() }),
			JSON.stringify({ schema: 1, declinedAt: at, digest: digest.slice(0, 8) }),
		];
		for (const text of texts) {
			writeMarker(h, { text });
			const r = runIn(h);
			assert.equal(r.status, 0, text);
			assert.equal(r.stderr, '', text);
			assert.ok(r.stdout.includes(LEGACY), text);
			assert.doesNotMatch(r.stdout, /OLD_INSTALL_KEPT/, text);
		}
		fs.rmSync(markerFile(h), { force: true });
		fs.mkdirSync(markerFile(h));
		const folder = runIn(h);
		assert.equal(folder.status, 0);
		assert.ok(folder.stdout.includes(LEGACY), 'a folder in place of the marker is ignored');
	});

	it('--json reports legacyDeclinedAt', () => {
		const h = oldHome();
		const none = runIn(h, ['--json']);
		assert.equal(none.status, 0, none.stdout + none.stderr);
		assert.equal(JSON.parse(none.stdout).legacyDeclinedAt, null, 'no marker');

		const declinedAt = Date.now() - 2 * DAY;
		const digest = planDigestOf(h);
		writeMarker(h, { digest, declinedAt });
		const fresh = runIn(h, ['--json']);
		assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
		const report = JSON.parse(fresh.stdout);
		assert.equal(report.legacyDeclinedAt, new Date(declinedAt).toISOString());
		assert.deepEqual(report.legacyInstall.map((item) => item.kind), ['skill-dir', 'sentinel', 'mcp-entry'], 'the leftovers are still listed');

		writeMarker(h, { digest, declinedAt: Date.now() - 8 * DAY });
		assert.equal(JSON.parse(runIn(h, ['--json']).stdout).legacyDeclinedAt, null, 'an expired marker');
		writeMarker(h, { digest: digest === '0123456789abcdef' ? 'fedcba9876543210' : '0123456789abcdef' });
		assert.equal(JSON.parse(runIn(h, ['--json']).stdout).legacyDeclinedAt, null, 'another digest');
		writeMarker(h, { text: 'not json' });
		assert.equal(JSON.parse(runIn(h, ['--json']).stdout).legacyDeclinedAt, null, 'a malformed marker');
	});

	it('--json reports no decline when nothing of the old install is left', () => {
		const h = oldHome();
		fs.rmSync(h.paths.claudeSkill, { recursive: true, force: true });
		fs.rmSync(h.paths.claudeJson);
		fs.rmSync(h.paths.claudeMd);
		writeMarker(h, { digest: planDigestOf(h) });
		const r = runIn(h, ['--json']);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const report = JSON.parse(r.stdout);
		assert.deepEqual(report.legacyInstall, []);
		assert.equal(report.legacyDeclinedAt, null);
		assert.doesNotMatch(runIn(h).stdout, /OLD_INSTALL_KEPT|LEGACY_INSTALL/);
	});

	it('the exit code is the same with and without a decline', () => {
		for (const complete of [true, false]) {
			const h = oldHome({ complete });
			const before = runIn(h);
			writeMarker(h);
			const after = runIn(h);
			assert.ok(before.stdout.includes('LEGACY_INSTALL') && after.stdout.includes('OLD_INSTALL_KEPT'), 'the decline changed the warning');
			assert.equal(after.status, before.status);
			assert.equal(after.status, complete ? 0 : 1);
			assert.equal(after.stderr, '');
		}
	});

	it('starts no claude process while it reads the plan', () => {
		const h = oldHome();
		writeMarker(h);
		assert.equal(claudeCalls(h), 0);
		const r = runIn(h);
		assert.ok(r.stdout.includes(KEPT), r.stdout);
		assert.equal(claudeCalls(h), 0, 'the fake claude was not called');
	});

	it('reads the plan with the environment of the run: CLAUDE_CONFIG_DIR is part of it', () => {
		const h = oldHome();
		const other = { CLAUDE_CONFIG_DIR: path.join(h.paths.root, 'other-config') };
		writeMarker(h);
		const moved = runIn(h, [], other);
		assert.ok(moved.stdout.includes(LEGACY), 'a marker of the default plan does not hold under another config folder');
		assert.doesNotMatch(moved.stdout, /OLD_INSTALL_KEPT/);
		writeMarker(h, { digest: planDigestOf(h, other) });
		assert.ok(runIn(h, [], other).stdout.includes(KEPT), 'a marker of that plan does');
		assert.ok(runIn(h).stdout.includes(LEGACY), 'and not under the default one');
	});

	it('an error while the marker is judged leaves the LEGACY_INSTALL warning and the exit code', () => {
		const h = oldHome();
		writeMarker(h);
		const works = runIn(h);
		assert.ok(works.stdout.includes(KEPT), works.stdout);
		const broken = runIn(h, [], { NODE_OPTIONS: `--require ${JSON.stringify(BLOCKER)} --require ${JSON.stringify(DATE_BREAKER)}` });
		assert.equal(broken.status, works.status);
		assert.equal(broken.stderr, '');
		assert.ok(broken.stdout.includes(`\n${legacyLines(h, LEGACY).join('\n')}\n\nSetup OK.\n`), broken.stdout);
		assert.doesNotMatch(broken.stdout, /OLD_INSTALL_KEPT/);
	});
});

describe('check-setup update notice', () => {
	const CLAUDE = { CLAUDECODE: '1' };
	const NOTICE = { MAKE_CUSTOM_APP_SKIP_UPDATE_CHECK: '' };
	const PLUGIN_VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;

	function cacheVersion(version, checkedAt = Date.now()) {
		fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify({ checkedAt, version }));
	}

	it('prints the two Claude Code commands when master has a newer version, and still exits 0', () => {
		save(fullConfig());
		cacheVersion('99.0.0');
		const r = run([], { ...CLAUDE, ...NOTICE });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.ok(r.stdout.includes(`UPDATE_AVAILABLE: make-custom-app 99.0.0 is available (installed: ${PLUGIN_VERSION}).`), r.stdout);
		assert.ok(r.stdout.includes('  claude plugin marketplace update make-custom-app\n  claude plugin update make-custom-app@make-custom-app'), r.stdout);
		assert.ok(r.stdout.trimEnd().endsWith('Setup OK.'), r.stdout);
		assert.equal(connectAttempts(), 0);
	});

	it('points Cursor users to the README', () => {
		save(fullConfig());
		cacheVersion('99.0.0');
		const r = run([], { CURSOR_AGENT: '1', ...NOTICE });
		assert.match(r.stdout, /How to update in Cursor: https:\/\/github\.com\/minsu-kang\/make-custom-app-skill#update/);
		assert.doesNotMatch(r.stdout, /claude plugin update/);
	});

	it('prints nothing when master has the same or an older version, or the cache holds no version', () => {
		save(fullConfig());
		for (const version of [PLUGIN_VERSION, '0.0.1', null]) {
			cacheVersion(version);
			const r = run([], { ...CLAUDE, ...NOTICE });
			assert.doesNotMatch(r.stdout, /UPDATE_AVAILABLE/, String(version));
			assert.equal(r.status, 0);
		}
	});

	it('adds the versions to --json and keeps stdout pure JSON', () => {
		save(fullConfig());
		cacheVersion('99.0.0');
		const report = JSON.parse(run(['--json'], { ...CLAUDE, ...NOTICE }).stdout);
		assert.deepEqual(report.update, { installed: PLUGIN_VERSION, available: '99.0.0' });
		cacheVersion(PLUGIN_VERSION);
		assert.equal(JSON.parse(run(['--json'], { ...CLAUDE, ...NOTICE }).stdout).update, null);
	});

	it('--skip-update-check and the skip variable turn the check off, even with a newer version cached', () => {
		save(fullConfig());
		cacheVersion('99.0.0');
		assert.doesNotMatch(run(['--skip-update-check'], { ...CLAUDE, ...NOTICE }).stdout, /UPDATE_AVAILABLE/);
		assert.doesNotMatch(run([], CLAUDE).stdout, /UPDATE_AVAILABLE/);
	});

	it('fails open: no cache and no network means no notice, no error, and the same exit code', () => {
		save(fullConfig());
		const r = run([], { ...CLAUDE, ...NOTICE });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.equal(r.stderr, '');
		assert.doesNotMatch(r.stdout, /UPDATE_AVAILABLE/);
		assert.ok(connectAttempts() >= 1, 'the check tried the network');
		assert.equal(JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, 'utf8')).version, null);
	});
});
