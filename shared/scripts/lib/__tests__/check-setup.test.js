/**
 * Spawn tests for check-setup.js. Every run is a child process with a fake HOME and TMPDIR and only the editor
 * variables the test passes. HOME is set before settings.js loads, because it computes its paths at load time.
 * The network is blocked in every child except 127.0.0.1 (a preload that records each other connect attempt), so a
 * test fails instead of calling the real Make, Jira or GitHub. MAKE_CUSTOM_APP_TEST_API_ORIGIN sends the token check to
 * a mock Make API in its own process (spawnSync blocks this one); it answers by token and logs every request.
 * The file moves HOME and the temp folders into a temporary root first (isolate-home); the tests of a declined cleanup
 * run on a synthetic old install (buildFakeLegacyHome) and read the marker the CLI writes.
 */
const { TEST_ROOT, REAL_HOME } = require('./isolate-home');
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

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
const { FAKE, buildFakeLegacyHome } = require('./fake-legacy-home');
const modeLogic = require('../mode-logic');

const CHECK_SETUP = path.join(__dirname, '..', '..', 'check-setup.js');
const CLEANUP_LEGACY = path.join(__dirname, '..', '..', 'cleanup-legacy.js');
const CACHE_FILE = path.join(tmp, 'make-custom-app-access-check.json');
const MODE_CACHE_FILE = path.join(tmp, modeLogic.CACHE_FILE_NAME);
const BLOCKER = path.join(aux, 'block-network.js');
const NET_LOG = path.join(aux, 'net.log');
const MOCK_LOG = path.join(aux, 'mock-make.log');
const DATE_BREAKER = path.join(aux, 'break-date-now.js');
const EMAIL = 'dev@make.com';
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
const NODE_HAS_ENV_PROXY = NODE_MAJOR >= 24 || (NODE_MAJOR === 22 && NODE_MINOR >= 21);
const KEYS = {
	public: 'PUBLIC_KEY_secret_value',
	bad: 'BAD_KEY_secret_value',
	admin500: 'ADMIN_500_KEY_secret_value',
	me503: 'ME_503_KEY_secret_value',
	me403Public: 'ME_403_PUBLIC_KEY_secret_value',
	me403Employee: 'ME_403_EMPLOYEE_KEY_secret_value',
};
const SECRET_VALUES = ['MAKE_KEY_secret_value', 'JIRA_TOKEN_secret_value', 'PINECONE_secret_value', 'OPENAI_secret_value', 'ENV_OPENAI_secret_value', ...Object.values(KEYS)];
/**
 * How the mock Make API answers a token: users/me status, admin probe status, account name. Any other token gets 401.
 * A users/me 403 is a token without the user:read scope (spec B 11.1).
 */
const ANSWERS = {
	[SECRET_VALUES[0]]: { me: 200, admin: 200, name: 'Dev User' },
	CURSOR_KEY_secret: { me: 200, admin: 200, name: 'Dev User' },
	[KEYS.public]: { me: 200, admin: 403, name: 'Pat Public' },
	[KEYS.admin500]: { me: 200, admin: 500, name: 'Dev User' },
	[KEYS.me503]: { me: 503 },
	[KEYS.me403Public]: { me: 403, admin: 403 },
	[KEYS.me403Employee]: { me: 403, admin: 200 },
};
const MOCK_MAKE = `
const fs = require('fs');
const http = require('http');
const [log, answers] = process.argv.slice(1);
const ANSWERS = JSON.parse(answers);
const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://mock');
	const token = (req.headers.authorization || '').replace(/^Token /, '');
	fs.appendFileSync(log, JSON.stringify({ path: url.pathname, search: url.search, token }) + '\\n');
	const answer = ANSWERS[token] || { me: 401 };
	const status = url.pathname === '/api/v2/users/me' ? answer.me : url.pathname === '/api/v2/admin/sdk/apps' ? answer.admin : 404;
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(status === 200 && url.pathname === '/api/v2/users/me' ? { authUser: { id: 5, name: answer.name } } : {}));
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;
const UPDATE_CACHE_FILE = path.join(tmp, 'make-custom-app-update-check.json');
const OLD_INSTALL_SEEDS = [FAKE.pinecone, FAKE.openai, FAKE.otherToken, FAKE.cursorToken];

// Lets a connect to 127.0.0.1 (the mock Make API) through; blocks and records every other one.
fs.writeFileSync(
	BLOCKER,
	[
		"const fs = require('fs');",
		"const net = require('net');",
		'const connect = net.Socket.prototype.connect;',
		'net.Socket.prototype.connect = function blocked(...args) {',
		'\tconst options = Array.isArray(args[0]) ? args[0][0] : args[0];',
		"\tif (options && typeof options === 'object' && options.host === '127.0.0.1') return connect.apply(this, args);",
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

let mock;
let origin;
let closedOrigin;

/** A port on 127.0.0.1 that nothing listens on. */
function closedPort() {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

before(async () => {
	mock = spawn(process.execPath, ['-e', MOCK_MAKE, MOCK_LOG, JSON.stringify(ANSWERS)], { stdio: ['ignore', 'pipe', 'inherit'] });
	origin = `http://127.0.0.1:${await new Promise((resolve) => mock.stdout.once('data', (c) => resolve(String(c).trim())))}`;
	closedOrigin = `http://127.0.0.1:${await closedPort()}`;
});

beforeEach(() => {
	for (const dir of [home, tmp]) {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir);
	}
	fs.rmSync(NET_LOG, { force: true });
	fs.rmSync(MOCK_LOG, { force: true });
});

after(() => {
	mock.kill();
	fs.rmSync(work, { recursive: true, force: true });
});

function run(args = [], env = {}) {
	return spawnSync(process.execPath, [CHECK_SETUP, ...args], {
		env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, NODE_OPTIONS: `--require ${JSON.stringify(BLOCKER)}`, MAKE_CUSTOM_APP_SKIP_UPDATE_CHECK: '1', [modeLogic.TEST_ORIGIN_VAR]: origin, ...env },
		encoding: 'utf8',
	});
}

function connectAttempts() {
	return fs.existsSync(NET_LOG) ? fs.readFileSync(NET_LOG, 'utf8').split('\n').filter(Boolean).length : 0;
}

/** The requests the mock Make API got in this test: { path, search, token }. */
function mockCalls() {
	return fs.existsSync(MOCK_LOG) ? fs.readFileSync(MOCK_LOG, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function modeCache() {
	return JSON.parse(fs.readFileSync(MODE_CACHE_FILE, 'utf8'));
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

/** A complete Claude Code setup of a Make employee: the mock says employee for its key, and Jira lookups are answered from the cache file. */
function fullConfig() {
	return {
		'imt-app-runtime-path': mkdir('imt-app-runtime'),
		'make-api-key': SECRET_VALUES[0],
		'make-zone': 'eu1.make.com',
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

function assertNoSecrets(r, extra = []) {
	for (const value of [...SECRET_VALUES, ...extra]) assert.ok(!r.stdout.includes(value) && !r.stderr.includes(value), `${value} leaked`);
}

describe('the test harness', () => {
	it('records a connect attempt of a child process', () => {
		const r = spawnSync(process.execPath, ['-e', "fetch('http://192.0.2.1:65000/').catch(() => {})"], {
			env: { PATH: process.env.PATH, HOME: home, NODE_OPTIONS: `--require ${JSON.stringify(BLOCKER)}` },
		});
		assert.equal(r.status, 0);
		assert.ok(connectAttempts() >= 1);
	});

	it('lets a child reach the mock Make API on 127.0.0.1 without counting it', () => {
		const r = spawnSync(process.execPath, ['-e', `fetch('${origin}/api/v2/users/me').then((res) => console.log(res.status))`], {
			env: { PATH: process.env.PATH, HOME: home, NODE_OPTIONS: `--require ${JSON.stringify(BLOCKER)}` },
			encoding: 'utf8',
		});
		assert.equal(r.stdout.trim(), '401');
		assert.equal(connectAttempts(), 0);
		assert.deepEqual(mockCalls(), [{ path: '/api/v2/users/me', search: '', token: '' }]);
	});

	it('keeps HOME, the temp folder, and the secrets file inside the test root', () => {
		assert.notEqual(os.homedir(), REAL_HOME);
		for (const folder of [os.homedir(), os.tmpdir(), home, tmp, SECRETS_PATH, process.env.CLAUDE_CONFIG_DIR]) assert.ok(folder.startsWith(TEST_ROOT + path.sep), `${folder} is outside the test root`);
	});
});

describe('check-setup in a fake HOME, Claude Code', () => {
	const CLAUDE = { CLAUDECODE: '1' };

	it('exits 1 with MODE: unknown and the token items when nothing is set up, without any network call', () => {
		const r = run([], CLAUDE);
		assert.equal(r.status, 1);
		assert.equal(r.stderr, '');
		assert.ok(r.stdout.startsWith(`MODE: unknown\nmake-custom-app setup — claude — ${PLUGIN_ROOT}\n`), r.stdout);
		assert.deepEqual(statuses(r.stdout), {
			'make-api-key': 'MISSING',
			mode: 'MISSING',
			'make-team-id': 'OPTIONAL',
			'mcp-server': 'OPTIONAL',
		});
		const items = parseItems(r.stdout);
		assert.equal(items['make-api-key'].detail, 'not set (Claude Code reads it from ~/.make-custom-app-skill-secrets)');
		assert.equal(items.mode.detail, 'unknown (no Make API token to check)');
		assert.ok(r.stdout.includes('Create a token at https://<your Make host>/user/api (scopes: sdk-apps:read sdk-apps:write user:read; for run-component.js also '), r.stdout);
		assert.doesNotMatch(r.stdout, /eu1\.make\.com|admin scope/);
		assert.ok(r.stdout.includes(`Interactive wizard (your terminal, not the agent):\n  ${setupCommand('claude')}`), r.stdout);
		assert.ok(r.stdout.trimEnd().endsWith('Setup INCOMPLETE — required items missing. Stop and apply the REQUIRED fixes above.'), r.stdout);
		assert.doesNotMatch(r.stdout, /LEGACY_INSTALL/);
		assert.equal(connectAttempts(), 0);
		assert.deepEqual(mockCalls(), []);
	});

	it('names the token page of the saved zone when the key is missing', () => {
		save({ 'make-zone': 'us2.make.com' });
		const r = run([], CLAUDE);
		assert.equal(r.status, 1);
		assert.ok(r.stdout.includes('Create a token at https://us2.make.com/user/api (scopes:'), r.stdout);
		assert.deepEqual(mockCalls(), []);
	});

	it('reports a key without a usable zone as missing, without any network call', () => {
		save({ 'make-api-key': SECRET_VALUES[0] });
		const none = run([], CLAUDE);
		assert.equal(none.status, 1);
		assert.deepEqual(parseItems(none.stdout)['make-api-key'], { status: 'MISSING', detail: 'set, but no Make zone (make-zone is not set)' });
		assert.ok(none.stdout.includes('[REQUIRED] make-api-key\nRun this in your own terminal'), none.stdout);
		save({ 'make-api-key': SECRET_VALUES[0], 'make-zone': 'eu9.example.org' });
		assert.equal(parseItems(run([], CLAUDE).stdout)['make-api-key'].detail, 'set, but no Make zone (make-zone is not a Make host: eu9.example.org)');
		assert.deepEqual(mockCalls(), []);
		assert.equal(connectAttempts(), 0);
		assertNoSecrets(none);
	});

	it('employee: MODE: employee, every item of today, exit 0, the mode cached, and no secret printed', () => {
		save(fullConfig());
		const r = run([], CLAUDE);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.equal(r.stderr, '');
		assert.ok(r.stdout.startsWith(`MODE: employee\nmake-custom-app setup — claude — ${PLUGIN_ROOT}\n`), r.stdout);
		assert.deepEqual(statuses(r.stdout), {
			'make-api-key': 'OK',
			mode: 'OK',
			'imt-app-runtime-path': 'OK',
			'make-apps-mockup-path': 'OK',
			'make account': 'OK',
			'make-team-id': 'OK',
			'mcp-server': 'OK',
		});
		const items = parseItems(r.stdout);
		assert.equal(items['make-api-key'].detail, 'eu1.make.com, account Dev User');
		assert.equal(items.mode.detail, 'employee (admin API 200)');
		assert.equal(items['make account'].detail, EMAIL);
		assert.match(items['mcp-server'].detail, /keys are set \(environment or .*make-custom-app-skill-secrets\); cannot check whether the server is registered/);
		assert.ok(r.stdout.trimEnd().endsWith('Setup OK.'), r.stdout);
		assert.doesNotMatch(r.stdout, /Fixes:|WARNING/);
		assertNoSecrets(r);
		assert.equal(connectAttempts(), 0);
		assert.deepEqual(mockCalls(), [
			{ path: '/api/v2/users/me', search: '', token: SECRET_VALUES[0] },
			{ path: '/api/v2/admin/sdk/apps', search: '?all=true&name=__mode_probe__&cols[]=name', token: SECRET_VALUES[0] },
		]);
		const cache = modeCache();
		assert.deepEqual({ ...cache, checkedAt: typeof cache.checkedAt }, { key: modeLogic.cacheKey('eu1.make.com', SECRET_VALUES[0]), host: 'eu1.make.com', mode: 'employee', checkedAt: 'number' });
		assert.ok(!fs.readFileSync(MODE_CACHE_FILE, 'utf8').includes(SECRET_VALUES[0]));
	});

	it('public: MODE: public and no employee item, even a configured one, and exit 0 without a Jira token', () => {
		for (const config of [{ 'make-api-key': KEYS.public, 'make-zone': 'eu1.make.com' }, { ...fullConfig(), 'make-api-key': KEYS.public }]) {
			save(config);
			const r = run([], CLAUDE);
			assert.equal(r.status, 0, r.stdout + r.stderr);
			assert.ok(r.stdout.startsWith(`MODE: public\nmake-custom-app setup — claude — ${PLUGIN_ROOT}\n`), r.stdout);
			const items = parseItems(r.stdout);
			assert.deepEqual(Object.keys(items), ['make-api-key', 'mode', 'make-team-id', 'mcp-server']);
			assert.equal(items['make-api-key'].detail, 'eu1.make.com, account Pat Public');
			assert.deepEqual(items.mode, { status: 'OK', detail: 'public (admin API 403)' });
			assert.doesNotMatch(r.stdout, /imt-app-runtime|make-apps-mockup|make account|Jira/);
			assert.equal(modeCache().mode, 'public');
			assertNoSecrets(r);
		}
	});

	it('users/me 403 and admin 403: MODE: public and exit 0, with the account name unavailable', () => {
		save({ 'make-api-key': KEYS.me403Public, 'make-zone': 'eu1.make.com' });
		const r = run([], CLAUDE);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.ok(r.stdout.startsWith(`MODE: public\nmake-custom-app setup — claude — ${PLUGIN_ROOT}\n`), r.stdout);
		const items = parseItems(r.stdout);
		assert.deepEqual(Object.keys(items), ['make-api-key', 'mode', 'make-team-id', 'mcp-server']);
		assert.deepEqual(items['make-api-key'], { status: 'OK', detail: 'eu1.make.com, account name unavailable: the token lacks the user:read scope' });
		assert.deepEqual(items.mode, { status: 'OK', detail: 'public (admin API 403)' });
		assert.ok(r.stdout.trimEnd().endsWith('Setup OK.'), r.stdout);
		assert.deepEqual(mockCalls().map((c) => c.path), ['/api/v2/users/me', '/api/v2/admin/sdk/apps']);
		assert.equal(modeCache().mode, 'public');
		assertNoSecrets(r);
	});

	it('users/me 403 and admin 200: MODE: employee with the employee items, and the account name unavailable', () => {
		save({ ...fullConfig(), 'make-api-key': KEYS.me403Employee });
		const r = run([], CLAUDE);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.ok(r.stdout.startsWith(`MODE: employee\nmake-custom-app setup — claude — ${PLUGIN_ROOT}\n`), r.stdout);
		const items = parseItems(r.stdout);
		assert.deepEqual(Object.keys(items), ['make-api-key', 'mode', 'imt-app-runtime-path', 'make-apps-mockup-path', 'make account', 'make-team-id', 'mcp-server']);
		assert.deepEqual(items['make-api-key'], { status: 'OK', detail: 'eu1.make.com, account name unavailable: the token lacks the user:read scope' });
		assert.deepEqual(items.mode, { status: 'OK', detail: 'employee (admin API 200)' });
		assert.deepEqual(items['make account'], { status: 'OK', detail: EMAIL });
		assert.equal(modeCache().mode, 'employee');
		assertNoSecrets(r);
	});

	it('checks the token on every run and rewrites the cache, whatever a fresh entry says', () => {
		save({ 'make-api-key': KEYS.public, 'make-zone': 'eu1.make.com' });
		fs.writeFileSync(MODE_CACHE_FILE, JSON.stringify(modeLogic.cacheEntry('eu1.make.com', KEYS.public, 'employee', Date.now())));
		assert.ok(run([], CLAUDE).stdout.startsWith('MODE: public\n'));
		assert.equal(modeCache().mode, 'public');
		run([], CLAUDE);
		assert.equal(mockCalls().length, 4);
	});

	it('a rejected token: exit 1, the token page of its zone and the setup command, and the cache dropped', () => {
		save({ 'make-api-key': KEYS.bad, 'make-zone': 'us1.make.com' });
		fs.writeFileSync(MODE_CACHE_FILE, JSON.stringify(modeLogic.cacheEntry('us1.make.com', KEYS.bad, 'public', Date.now())));
		const r = run([], CLAUDE);
		assert.equal(r.status, 1);
		assert.ok(r.stdout.startsWith('MODE: unknown\n'), r.stdout);
		const items = parseItems(r.stdout);
		assert.deepEqual(items['make-api-key'], { status: 'MISSING', detail: 'Make rejected the saved API token for us1.make.com (HTTP 401).' });
		assert.deepEqual(items.mode, { status: 'MISSING', detail: 'unknown (Make rejected the token)' });
		assert.ok(r.stdout.includes(`[REQUIRED] make-api-key\nCreate a new token at https://us1.make.com/user/api, then save it in your own terminal (the agent must not run this):\n  ${setupCommand('claude')}\n`), r.stdout);
		assert.deepEqual(mockCalls().map((c) => c.path), ['/api/v2/users/me']);
		assert.equal(fs.existsSync(MODE_CACHE_FILE), false);
		assertNoSecrets(r);
	});

	it('no usable answer: exit 1 with the retry fix on the mode item, and the cache kept as it was', () => {
		const cases = [
			{ key: SECRET_VALUES[0], env: { [modeLogic.TEST_ORIGIN_VAR]: closedOrigin }, what: 'GET /users/me: ECONNREFUSED', account: 'account not checked (see mode)' },
			{ key: KEYS.me503, env: {}, what: 'GET /users/me: HTTP 503', account: 'account not checked (see mode)' },
			{ key: KEYS.admin500, env: {}, what: 'admin API probe: HTTP 500', account: 'account Dev User' },
		];
		for (const { key, env, what, account } of cases) {
			save({ 'make-api-key': key, 'make-zone': 'eu1.make.com' });
			const entry = modeLogic.cacheEntry('eu1.make.com', key, 'public', Date.now() - 1000);
			fs.writeFileSync(MODE_CACHE_FILE, JSON.stringify(entry));
			const r = run([], { ...CLAUDE, ...env });
			assert.equal(r.status, 1, what);
			assert.ok(r.stdout.startsWith('MODE: unknown\n'), r.stdout);
			const items = parseItems(r.stdout);
			assert.deepEqual(items['make-api-key'], { status: 'OK', detail: `eu1.make.com, ${account}` }, what);
			assert.deepEqual(items.mode, { status: 'MISSING', detail: `Could not check the Make API token for eu1.make.com (${what}).` });
			assert.ok(r.stdout.includes('[REQUIRED] mode\nNothing was changed. Retry later, and check the network, VPN or proxy.\n'), r.stdout);
			assert.deepEqual(modeCache(), entry, what);
			assertNoSecrets(r);
		}
	});

	it('takes the zone from a legacy make-api-url, so an existing employee setup needs no change', () => {
		const config = fullConfig();
		delete config['make-zone'];
		save({ ...config, 'make-api-url': 'https://us2.make.com/api/v2/admin' });
		const r = run(['--json'], CLAUDE);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const report = JSON.parse(r.stdout);
		assert.deepEqual([report.mode, report.zone], ['employee', 'us2.make.com']);
		assert.equal(report.items[0].detail, 'us2.make.com, account Dev User');
	});

	it('with a proxy variable, checks the token in a child process that uses the proxy', { skip: !NODE_HAS_ENV_PROXY && 'this Node ignores NODE_USE_ENV_PROXY' }, () => {
		save(fullConfig());
		const proxy = { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' };
		const through = run([], { ...CLAUDE, ...proxy });
		assert.equal(through.status, 1);
		assert.equal(parseItems(through.stdout).mode.detail, 'Could not check the Make API token for eu1.make.com (GET /users/me: ECONNREFUSED).');
		assert.deepEqual(mockCalls(), [], 'the calls went to the proxy, not to the mock');
		const direct = run([], { ...CLAUDE, ...proxy, NO_PROXY: '127.0.0.1' });
		assert.equal(direct.status, 0, direct.stdout + direct.stderr);
		assert.ok(direct.stdout.startsWith('MODE: employee\n'), direct.stdout);
		assert.equal(parseItems(direct.stdout)['make-api-key'].detail, 'eu1.make.com', 'the child returns no account name');
		assert.equal(mockCalls().length, 2);
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

	it('writes machine-readable JSON with --json and nothing else on stdout, with the mode and the zone', () => {
		save(fullConfig());
		const r = run(['--json'], CLAUDE);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const report = JSON.parse(r.stdout);
		assert.equal(report.ok, true);
		assert.equal(report.editor, 'claude');
		assert.equal(report.mode, 'employee');
		assert.equal(report.zone, 'eu1.make.com');
		assert.equal(report.pluginRoot, PLUGIN_ROOT);
		assert.equal(report.setupCommand, setupCommand('claude'));
		assert.deepEqual(report.items.map((i) => [i.key, i.status]), [
			['make-api-key', 'ok'],
			['mode', 'ok'],
			['imt-app-runtime-path', 'ok'],
			['make-apps-mockup-path', 'ok'],
			['make account', 'ok'],
			['make-team-id', 'ok'],
			['mcp-server', 'ok'],
		]);
		assert.deepEqual(report.warnings, []);
		assertNoSecrets(r);
	});

	it('--json in public mode, and without a token', () => {
		save({ 'make-api-key': KEYS.public, 'make-zone': 'us1.make.celonis.com' });
		const pub = run(['--json'], CLAUDE);
		assert.equal(pub.status, 0, pub.stdout + pub.stderr);
		const report = JSON.parse(pub.stdout);
		assert.deepEqual([report.ok, report.mode, report.zone], [true, 'public', 'us1.make.celonis.com']);
		assert.deepEqual(report.items.map((i) => i.key), ['make-api-key', 'mode', 'make-team-id', 'mcp-server']);
		assert.deepEqual(report.items[1], { key: 'mode', status: 'ok', detail: 'public (admin API 403)', fix: null });
		fs.rmSync(SECRETS_PATH);
		const none = run(['--json'], CLAUDE);
		assert.equal(none.status, 1);
		const empty = JSON.parse(none.stdout);
		assert.deepEqual([empty.ok, empty.mode, empty.zone], [false, null, null]);
		assertNoSecrets(pub);
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
		assert.ok(r.stdout.startsWith(`MODE: unknown\nmake-custom-app setup — cursor — ${PLUGIN_ROOT}\n`), r.stdout);
		assert.ok(r.stdout.includes(`  ${setupCommand('cursor')}`), r.stdout);
		assert.equal(statuses(r.stdout)['make-api (Cursor settings.json)'], 'MISSING');
		assert.equal(statuses(r.stdout)['make-api-key'], undefined);
	});

	it('--editor=cursor works', () => {
		const r = run(['--editor=cursor']);
		assert.equal(r.status, 1);
		assert.ok(r.stdout.startsWith(`MODE: unknown\nmake-custom-app setup — cursor — ${PLUGIN_ROOT}\n`), r.stdout);
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
		assert.ok(r.stdout.startsWith(`MODE: employee\nmake-custom-app setup — cursor — ${PLUGIN_ROOT}\n`), r.stdout);
		assert.deepEqual(parseItems(r.stdout)['make-api (Cursor settings.json)'], { status: 'OK', detail: 'eu1.make.com, account Dev User' });
		assert.ok(r.stdout.includes(`\n${modeLogic.cursorAdminWarning({ cursorAdmin: false, mode: 'employee' })}\n`), r.stdout);
		assert.ok(!r.stdout.includes('CURSOR_KEY_secret'));
		assert.equal(connectAttempts(), 0);
		assert.deepEqual(mockCalls().map((c) => c.token), ['CURSOR_KEY_secret', 'CURSOR_KEY_secret']);
	});

	it('warns once when the admin flag of the Cursor environment disagrees with the mode', () => {
		const config = fullConfig();
		delete config['make-api-key'];
		save({ editor: 'cursor', ...config });
		fs.mkdirSync(path.dirname(CURSOR_SETTINGS_PATH), { recursive: true });
		const write = (apikey) => fs.writeFileSync(CURSOR_SETTINGS_PATH, JSON.stringify({ 'apps-sdk.environments': [{ uuid: 'u', url: 'eu2.make.com', apikey, admin: true }] }));
		write('CURSOR_KEY_secret');
		const agrees = run();
		assert.equal(agrees.status, 0, agrees.stdout + agrees.stderr);
		assert.doesNotMatch(agrees.stdout, /WARNING/);
		write(KEYS.public);
		const r = run();
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const warning = modeLogic.cursorAdminWarning({ cursorAdmin: true, mode: 'public' });
		assert.deepEqual(r.stdout.split('\n').filter((line) => line.startsWith('WARNING')), [warning]);
		assert.deepEqual(JSON.parse(run(['--json']).stdout).warnings, [warning]);
		assertNoSecrets(r);
	});

	it('reports an environment without an API key or a Make host as missing, without any network call', () => {
		fs.mkdirSync(path.dirname(CURSOR_SETTINGS_PATH), { recursive: true });
		fs.writeFileSync(CURSOR_SETTINGS_PATH, JSON.stringify({ 'apps-sdk.environments': [{ uuid: 'u', url: 'eu1.make.com' }] }));
		const noKey = run([], { CURSOR_AGENT: '1' });
		assert.equal(noKey.status, 1);
		assert.deepEqual(parseItems(noKey.stdout)['make-api (Cursor settings.json)'], { status: 'MISSING', detail: 'the active apps-sdk environment has no apikey' });
		assert.ok(noKey.stdout.includes('Give the active environment of the Make Apps SDK extension in Cursor your Make API token'), noKey.stdout);
		fs.writeFileSync(CURSOR_SETTINGS_PATH, JSON.stringify({ 'apps-sdk.environments': [{ uuid: 'u', url: 'localhost:8080', apikey: 'CURSOR_KEY_secret' }] }));
		const noHost = run([], { CURSOR_AGENT: '1' });
		assert.deepEqual(parseItems(noHost.stdout)['make-api (Cursor settings.json)'], { status: 'MISSING', detail: 'the url of the active apps-sdk environment is not on a Make host: localhost:8080' });
		assert.ok(!noHost.stdout.includes('CURSOR_KEY_secret'));
		assert.deepEqual(mockCalls(), []);
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
		assert.deepEqual(parseItems(r.stdout)['make-api (Cursor settings.json)'], { status: 'OK', detail: 'eu1.make.com, account Dev User' });
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

	/** A synthetic 2.x install (Claude Code items) in its own root; `complete` adds the employee config that makes the exit code 0. */
	function oldHome({ complete = true, ...options } = {}) {
		const root = path.join(aux, `old-${homes++}`);
		fs.mkdirSync(root);
		const h = buildFakeLegacyHome({ editors: ['claude'], ...options, root, pluginRoot: PLUGIN_ROOT });
		if (complete) {
			const runtime = path.join(h.home, 'imt-app-runtime');
			fs.mkdirSync(runtime);
			const lines = [`imt-app-runtime-path: ${runtime}`, `make-api-key: ${SECRET_VALUES[0]}`, 'make-zone: eu1.make.com', `jira-email: ${EMAIL}`, `jira-api-token: ${SECRET_VALUES[1]}`];
			fs.appendFileSync(h.paths.secrets, `${lines.join('\n')}\n`);
			const key = cacheKey({ baseUrl: JIRA_BASE_URL, email: EMAIL, token: SECRET_VALUES[1] });
			fs.writeFileSync(path.join(h.paths.tmp, 'make-custom-app-access-check.json'), JSON.stringify({ key, email: EMAIL, checkedAt: Date.now() }));
		}
		return h;
	}

	/** check-setup with exactly the environment of the fake home, as Claude Code, without the update check. */
	function runIn(h, args = [], env = {}) {
		const result = spawnSync(process.execPath, [CHECK_SETUP, ...args], {
			env: { ...h.env, CLAUDECODE: '1', NODE_OPTIONS: `--require ${JSON.stringify(BLOCKER)}`, MAKE_CUSTOM_APP_SKIP_UPDATE_CHECK: '1', [modeLogic.TEST_ORIGIN_VAR]: origin, ...env },
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
		assertNoSecrets(r, OLD_INSTALL_SEEDS);
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
		assertNoSecrets(none, OLD_INSTALL_SEEDS);

		const declinedAt = Date.now() - 2 * DAY;
		const digest = planDigestOf(h);
		writeMarker(h, { digest, declinedAt });
		const fresh = runIn(h, ['--json']);
		assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
		const report = JSON.parse(fresh.stdout);
		assert.equal(report.legacyDeclinedAt, new Date(declinedAt).toISOString());
		assert.deepEqual(report.legacyInstall.map((item) => item.kind), ['skill-dir', 'sentinel', 'mcp-entry'], 'the leftovers are still listed');
		assertNoSecrets(fresh, OLD_INSTALL_SEEDS);

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
		assert.match(r.stdout, /How to update in Cursor: https:\/\/github\.com\/minsu-kang\/make-app-ai-plugin#update/);
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
