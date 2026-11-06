/**
 * Tests for the entry script download-app.js against a mock Make API, in a fake HOME with a fake API token. The
 * decisions are tested without a server in download-app-logic.test.js; this file covers the wiring: which API base each
 * mode reads, what counts as saved, absent or failed, the Done block, the exit code, and that a failed run writes
 * nothing. MAKE_CUSTOM_APP_TEST_API_ORIGIN sends every call to the mock, and a seeded mode cache skips the mode probe.
 */
require('./isolate-home');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { cacheEntry, CACHE_FILE_NAME, TEST_ORIGIN_VAR } = require('../mode-logic');
const { cacheKey: accessKey, JIRA_BASE_URL } = require('../access-guard-logic');
const { RETRY_FIX, AUTH_FIX, USAGE_LINES, SNAPSHOT_WITH_OUTPUT_DIR } = require('../download-app-logic');

const SCRIPT = path.resolve(__dirname, '..', '..', 'download-app.js');
const FAKE_KEY = 'FAKEKEY_download_SECRET';
const EMAIL = 'dev@make.com';
const JIRA_TOKEN = 'FAKE_JIRA_TOKEN_dl';
const ZONE = 'eu1.make.com';
const DESTROY = Symbol('destroy');
const flaky = (status, times, body) => { let n = 0; return () => (n++ < times ? status : body); };

const GATE = { app: { origin: ZONE } };
const ROUTES = () => ({
	'/sdk/apps/my-app/1': (u) => (u.searchParams.has('cols[0]') ? GATE : { app: { label: 'My App', description: 'A test app', manifestVersion: 2, approved: false, public: false } }),
	'/sdk/apps/my-app/1/base': '{ "baseUrl": "https://api.example.com" }',
	'/sdk/apps/my-app/1/common': '{}',
	'/sdk/apps/my-app/1/groups': 'null',
	'/sdk/apps/my-app/1/readme': 404,
	'/sdk/apps/my-app/1/install': 404,
	'/sdk/apps/my-app/1/installSpec': 404,
	'/sdk/apps/my-app/1/modules': { appModules: [{ name: 'listItems', label: 'List items', typeId: 9, crud: 'read', deprecated: false, public: true }] },
	'/sdk/apps/my-app/1/modules/listItems/api': '{ "url": "/items" }',
	'/sdk/apps/my-app/1/modules/listItems/parameters': '[]',
	'/sdk/apps/my-app/1/modules/listItems/expect': '[]',
	'/sdk/apps/my-app/1/modules/listItems/interface': '[]',
	'/sdk/apps/my-app/1/modules/listItems/samples': 404,
	'/sdk/apps/my-app/1/modules/listItems/scope': '[]',
	'/sdk/apps/my-app/connections': { appConnections: [{ name: 'my-app', label: 'My App', type: 'basic' }] },
	'/sdk/apps/connections/my-app/api': '{ "url": "/me" }',
	'/sdk/apps/connections/my-app/common': '{}',
	'/sdk/apps/connections/my-app/scopes': 404,
	'/sdk/apps/connections/my-app/scope': 404,
	'/sdk/apps/connections/my-app/parameters': '[]',
	'/sdk/apps/connections/my-app/installSpec': 404,
	'/sdk/apps/connections/my-app/install': 'null',
	'/sdk/apps/my-app/webhooks': { appWebhooks: [] },
	'/sdk/apps/my-app/1/rpcs': { appRpcs: [] },
	'/sdk/apps/my-app/1/endpoints': { appEndpoints: [{ name: 'getItem', label: 'Get item' }] },
	'/sdk/apps/my-app/1/endpoints/getItem': { appEndpoint: { context: '---\nname: getItem\n---\nGets one item.', annotations: { readOnlyHint: true }, public: true } },
	'/sdk/apps/my-app/1/endpoints/getItem/api': '{ "url": "/items/{{parameters.id}}" }',
	'/sdk/apps/my-app/1/endpoints/getItem/inputParameters': '[]',
	'/sdk/apps/my-app/1/endpoints/getItem/outputParameters': '[]',
	'/sdk/apps/my-app/1/endpoints/getItem/scope': '[]',
	'/sdk/apps/my-app/1/functions': { appFunctions: [{ name: 'fmt' }] },
	'/sdk/apps/my-app/1/functions/fmt/code': 'function fmt(x) {\n\treturn x;\n}',
	'/sdk/apps/my-app/1/functions/fmt/test': '',
	'/apps/my-app': { app: { versions: [{ version: 1, private: false, packagePrivate: false, deprecated: false, modules: [{ name: 'listItems', private: true, deprecated: false }] }] } },
});
// With ROUTES as they are: 16 files saved, 10 sections absent.
const SAVED = ['base.imljson', 'common.imljson', 'modules/listItems/api.imljson', 'modules/listItems/scope.imljson', 'connections/my-app/parameters.imljson', 'endpoints/getItem/input_parameters.imljson', 'endpoints/getItem/context.md', 'functions/fmt/code.js'];
const ABSENT = ['groups.imljson', 'readme.md', 'install.imljson', 'modules/listItems/samples.imljson', 'connections/my-app/scope.imljson', 'connections/my-app/install.imljson', 'functions/fmt/test.js'];

let work;
let home;
let tmp;
let server;
let port;
let routes;
let log;

/** A route answer is a body, a status number, DESTROY, or a function of the URL that gives one of them or a promise of one. */
function handle(req, res) {
	const u = new URL(req.url, 'http://x');
	log.push({ path: u.pathname, url: req.url, auth: req.headers.authorization, sdk: req.headers['x-imt-apps-sdk-version'] });
	const m = /^\/api\/v2(?:\/admin)?(\/.*)$/.exec(u.pathname);
	let answer = m ? routes[m[1]] : undefined;
	if (typeof answer === 'function') answer = answer(u);
	if (answer instanceof Promise) return void answer.then((later) => respond(req, res, later));
	return respond(req, res, answer);
}

function respond(req, res, answer) {
	if (answer === DESTROY) return req.socket.destroy();
	if (answer === undefined || typeof answer === 'number') {
		const code = answer || 404;
		res.writeHead(code, { 'Content-Type': 'application/json', ...(code === 429 ? { 'retry-after': '0' } : {}) });
		return res.end(JSON.stringify({ message: `mock ${code}` }));
	}
	res.writeHead(200, { 'Content-Type': typeof answer === 'string' ? 'text/plain' : 'application/json' });
	return res.end(typeof answer === 'string' ? answer : JSON.stringify(answer));
}

const appDir = () => path.join(home, '.make-custom-app', 'contexts', 'my-app-v1');
const snapshotsDir = () => path.join(home, '.make-custom-app', 'snapshots', 'my-app-v1');
const walkFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const hits = (p) => log.filter((r) => r.path === p).length;
const readMetadata = () => JSON.parse(fs.readFileSync(path.join(appDir(), 'metadata.json'), 'utf8'));

/** Writes the secrets file and a fresh mode cache entry. Only employee mode gets the Jira lines and the Jira cache. */
function seed(mode) {
	const lines = [`make-api-key: ${FAKE_KEY}`, `make-zone: ${ZONE}`];
	if (mode === 'employee') {
		lines.push(`jira-email: ${EMAIL}`, `jira-api-token: ${JIRA_TOKEN}`);
		const key = accessKey({ baseUrl: JIRA_BASE_URL, email: EMAIL, token: JIRA_TOKEN });
		fs.writeFileSync(path.join(tmp, 'make-custom-app-access-check.json'), JSON.stringify({ key, email: EMAIL, checkedAt: Date.now() }));
	}
	fs.writeFileSync(path.join(home, '.make-custom-app-skill-secrets'), `${lines.join('\n')}\n`, { mode: 0o600 });
	fs.writeFileSync(path.join(tmp, CACHE_FILE_NAME), JSON.stringify(cacheEntry(ZONE, FAKE_KEY, mode, Date.now())));
}

/** Runs download-app.js with `args` (my-app 1 by default) against the mock with ROUTES plus `override`; `nodeArgs` go before the script. */
async function run({ mode = 'employee', override = {}, args = ['my-app', '1'], nodeArgs = [] } = {}) {
	routes = { ...ROUTES(), ...override };
	log = [];
	seed(mode);
	const r = await new Promise((resolve) => {
		const child = spawn(process.execPath, [...nodeArgs, SCRIPT, ...args], {
			cwd: work,
			env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, CLAUDECODE: '1', [TEST_ORIGIN_VAR]: `http://127.0.0.1:${port}` },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (c) => (stdout += c));
		child.stderr.on('data', (c) => (stderr += c));
		const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, out: stdout + stderr });
		});
	});
	assert.ok(!r.out.includes(FAKE_KEY), 'API key leaked');
	return r;
}

before(async () => {
	work = fs.mkdtempSync(path.join(os.tmpdir(), 'download-app-test-'));
	home = path.join(work, 'home');
	tmp = path.join(work, 'tmp');
	for (const dir of [home, tmp]) fs.mkdirSync(dir);
	server = http.createServer(handle);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = server.address().port;
});

after(() => {
	server.closeAllConnections();
	server.close();
	fs.rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
	fs.rmSync(path.join(home, '.make-custom-app'), { recursive: true, force: true });
});

describe('download-app.js: a complete download', () => {
	it('employee mode reads the admin API, saves the sections, counts the absent ones and exits 0', async () => {
		const r = await run();
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes(`Configured API: http://127.0.0.1:${port}/api/v2/admin`), r.stdout);
		assert.ok(r.stdout.includes('  Saved: 16 file(s)'), r.stdout);
		assert.ok(r.stdout.includes('  Absent: 10 (empty or not set on the server)'), r.stdout);
		assert.ok(r.stdout.includes(`  Path: ${appDir()}`), r.stdout);
		assert.doesNotMatch(r.out, /Failed|✗|Visibility: unknown/);
		assert.ok(r.stdout.includes('\n=== Visibility (admin app endpoint) ===\n  ✓ IPM-deployed to'), r.stdout);
		const written = r.stdout.slice(r.stdout.indexOf('\n=== Files ===\n'));
		for (const f of [...SAVED, 'metadata.json']) assert.ok(written.includes(`\n  ✓ ${f}\n`), `no ✓ line for ${f} under Files: ${r.stdout}`);
		assert.equal((r.stdout.match(/^ {2}✓ (?!IPM)/gm) || []).length, 17, r.stdout);
		for (const f of SAVED) assert.ok(fs.existsSync(path.join(appDir(), f)), `${f} missing`);
		for (const f of ABSENT) assert.ok(!fs.existsSync(path.join(appDir(), f)), `${f} written`);
		assert.equal(fs.readFileSync(path.join(appDir(), 'functions/fmt/code.js'), 'utf8'), 'function fmt(x) {\n\treturn x;\n}');
		assert.ok(log.length > 0 && log.every((q) => q.path.startsWith('/api/v2/admin/')), log.map((q) => q.path).join('\n'));
		assert.ok(log.every((q) => q.auth === `Token ${FAKE_KEY}` && q.sdk === '2.4.0'));
		assert.equal(hits('/api/v2/admin/apps/my-app'), 1);
		assert.equal(hits('/api/v2/users/me'), 0);
		const meta = readMetadata();
		assert.equal(meta.ipmDeployedToZone, true);
		assert.equal(meta.modules[0].private, true);
		assert.equal(meta.label, 'My App');
		assert.equal(meta.endpoints[0].annotations.readOnlyHint, true);
		assert.ok(!('visibility' in meta));
	});

	it('public mode reads the public API, skips the admin visibility call and records visibility unknown', async () => {
		const r = await run({ mode: 'public' });
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes(`Configured API: http://127.0.0.1:${port}/api/v2\n`), r.stdout);
		assert.ok(r.stdout.includes('\n=== Visibility ===\n  · Visibility flags (private, packagePrivate, ipmDeployedToZone) are not available in public mode. metadata.json keeps them as null.\n'), r.stdout);
		assert.ok(r.stdout.includes('  Visibility: unknown (public mode)'), r.stdout);
		assert.ok(r.stdout.includes('  Saved: 16 file(s)'), r.stdout);
		assert.ok(log.every((q) => q.path.startsWith('/api/v2/sdk/')), log.map((q) => q.path).join('\n'));
		assert.equal(hits('/api/v2/apps/my-app'), 0);
		const meta = readMetadata();
		assert.equal(meta.visibility, 'unknown (public mode)');
		assert.equal(meta.ipmDeployedToZone, null);
		assert.equal(meta.modules[0].private, null);
		assert.equal(meta.private, null);
		assert.equal(meta.packagePrivate, null);
	});

	it('employee mode keeps the admin visibility call non-fatal: a 403 there still exits 0', async () => {
		const r = await run({ override: { '/apps/my-app': 403 } });
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('403 → caller lacks admin access to this endpoint'), r.stdout);
		assert.equal(readMetadata().ipmDeployedToZone, null);
	});

	it('employee mode keeps a malformed admin visibility answer non-fatal: exit 0, files written, visibility null', async () => {
		const r = await run({ override: { '/apps/my-app': { app: { versions: {} } } } });
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('admin endpoint error: unexpected response. Visibility flags = null.'), r.stdout);
		assert.ok(r.stdout.includes('  Saved: 16 file(s)'), r.stdout);
		assert.doesNotMatch(r.out, /Failed|ERROR|TypeError/);
		assert.equal(readMetadata().ipmDeployedToZone, null);
		for (const f of SAVED) assert.ok(fs.existsSync(path.join(appDir(), f)), `${f} missing`);
	});

	it('a 404 on a section of any kind is absent, as before, also on an OAuth connection', async () => {
		const r = await run({
			override: {
				'/sdk/apps/my-app/connections': { appConnections: [{ name: 'my-app', label: 'My App', type: 'oauth' }] },
				'/sdk/apps/connections/my-app/common': 404,
				'/sdk/apps/my-app/1/modules/listItems/expect': 404,
				'/sdk/apps/my-app/webhooks': { appWebhooks: [{ name: 'hook', label: 'Hook' }] },
				'/sdk/apps/webhooks/hook/api': '{ "url": "/hooks" }',
				'/sdk/apps/my-app/1/rpcs': { appRpcs: [{ name: 'listOptions', label: 'List options' }] },
				'/sdk/apps/my-app/1/rpcs/listOptions/api': '{ "url": "/options" }',
				'/sdk/apps/my-app/1/endpoints/getItem/outputParameters': 404,
				'/sdk/apps/my-app/1/endpoints/getItem/scope': 404,
				'/sdk/apps/my-app/1/functions/fmt/test': 404,
			},
		});
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('  Saved: 14 file(s)'), r.stdout);
		assert.ok(r.stdout.includes('  Absent: 20 (empty or not set on the server)'), r.stdout);
		assert.doesNotMatch(r.out, /Failed|✗/);
		for (const f of ['webhooks/hook/api.imljson', 'rpcs/listOptions/api.imljson', 'connections/my-app/api.imljson']) assert.ok(fs.existsSync(path.join(appDir(), f)), `${f} missing`);
		for (const f of ['webhooks/hook/attach.imljson', 'webhooks/hook/scope.imljson', 'rpcs/listOptions/parameters.imljson', 'connections/my-app/common.imljson', 'connections/my-app/scopes.imljson', 'modules/listItems/expect.imljson', 'endpoints/getItem/scope.imljson', 'functions/fmt/test.js']) {
			assert.ok(!fs.existsSync(path.join(appDir(), f)), `${f} written`);
		}
		const meta = readMetadata();
		assert.deepEqual(meta.webhooks, [{ name: 'hook', label: 'Hook' }]);
		assert.deepEqual(meta.rpcs, [{ name: 'listOptions', label: 'List options' }]);
		assert.equal(meta.connections[0].type, 'oauth');
	});

	it('reads the module descriptions and keeps them in metadata.json', async () => {
		const r = await run({ override: { '/sdk/apps/my-app/1/modules': { appModules: [{ name: 'listItems', label: 'List items', description: 'Lists the items.', typeId: 9, crud: 'read', deprecated: false, public: true }] } } });
		assert.equal(r.code, 0, r.out);
		const list = log.find((q) => q.path === '/api/v2/admin/sdk/apps/my-app/1/modules');
		assert.ok(list.url.includes('cols[]=description'), list.url);
		assert.equal(readMetadata().modules[0].description, 'Lists the items.');
	});

	it('keeps a module description that Make leaves out as null', async () => {
		const r = await run({ mode: 'public' });
		assert.equal(r.code, 0, r.out);
		assert.equal(readMetadata().modules[0].description, null);
	});

	it('sets downloadedAt after the files are written, whatever the precision of file times', async () => {
		const orderFile = path.join(work, 'write-order.json');
		const preload = path.join(work, 'write-order.js');
		// Loaded before the script: after each section file it waits for the clock to move on and notes the time.
		fs.writeFileSync(
			preload,
			[
				"const fs = require('fs');",
				"const path = require('path');",
				'const write = fs.writeFileSync;',
				'const times = [];',
				'fs.writeFileSync = function (file, ...rest) {',
				'	const result = write.call(this, file, ...rest);',
				"	if (String(file).includes(`${path.sep}contexts${path.sep}`) && path.basename(String(file)) !== 'metadata.json') {",
				'		const t = Date.now();',
				'		while (Date.now() <= t);',
				'		times.push(Date.now());',
				'	}',
				'	return result;',
				'};',
				`process.on('exit', () => write(${JSON.stringify(orderFile)}, JSON.stringify(times)));`,
			].join('\n'),
		);
		const r = await run({ nodeArgs: ['--require', preload] });
		assert.equal(r.code, 0, r.out);
		const times = JSON.parse(fs.readFileSync(orderFile, 'utf8'));
		assert.equal(times.length, 16);
		const downloadedAt = Date.parse(readMetadata().downloadedAt);
		assert.ok(downloadedAt >= Math.max(...times), `downloadedAt ${readMetadata().downloadedAt} is before the last section write`);
	});

	it('a 404 on the endpoint detail counts context.md as absent and keeps the endpoint in metadata.json', async () => {
		const r = await run({ override: { '/sdk/apps/my-app/1/endpoints/getItem': 404 } });
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('  Saved: 15 file(s)'), r.stdout);
		assert.ok(r.stdout.includes('  Absent: 11 (empty or not set on the server)'), r.stdout);
		assert.ok(!fs.existsSync(path.join(appDir(), 'endpoints/getItem/context.md')));
		assert.ok(fs.existsSync(path.join(appDir(), 'endpoints/getItem/api.imljson')));
		assert.deepEqual(readMetadata().endpoints, [
			{ name: 'getItem', label: 'Get item', description: null, annotations: null, attachedAccounts: null, public: null, approved: null, deprecated: null, archived: null },
		]);
	});
});

describe('download-app.js: the app origin', () => {
	it('employee mode switches to the origin of the app, as before', async () => {
		const r = await run({ override: { '/sdk/apps/my-app/1': (u) => (u.searchParams.has('cols[0]') ? { app: { origin: 'us1.make.com' } } : { app: {} }) } });
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('  Origin detected: us1.make.com'), r.stdout);
		assert.ok(r.stdout.includes('  URL changed: '), r.stdout);
		assert.ok(r.stdout.includes('  ✓ IPM-deployed to us1.make.com (1 version row(s))'), r.stdout);
		assert.equal(readMetadata().origin, 'us1.make.com');
	});

	it('public mode fails instead of switching hosts, after one request and without writing', async () => {
		const r = await run({ mode: 'public', override: { '/sdk/apps/my-app/1': { app: { origin: 'us1.make.com' } } } });
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stdout.includes('  Failed: 1\n    ✗ app origin (the app lives in us1.make.com, the token is for eu1.make.com)'), r.stdout);
		assert.ok(r.stdout.includes('https://us1.make.com/user/api'), r.stdout);
		assert.ok(r.stderr.includes('ERROR: 1 section(s) of my-app v1 could not be read, so nothing was written.'), r.stderr);
		assert.equal(log.length, 1);
		assert.ok(!fs.existsSync(appDir()));
	});
});

describe('download-app.js: failures', () => {
	it('a 404 on the app version fails at once, names the zone and writes nothing', async () => {
		const r = await run({ override: { '/sdk/apps/my-app/1': 404 } });
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stdout.includes('  Failed: 1\n    ✗ app my-app v1 (HTTP 404)'), r.stdout);
		assert.ok(r.stdout.includes('eu1.make.com has no my-app v1 that this token can read: check the slug, the version and the zone.'), r.stdout);
		assert.equal(log.length, 1);
		assert.ok(!fs.existsSync(appDir()));
	});

	it('a 404 on a component list fails', async () => {
		const r = await run({ override: { '/sdk/apps/my-app/1/rpcs': 404 } });
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stdout.includes('  Failed: 1\n    ✗ RPC list (HTTP 404)'), r.stdout);
		assert.ok(r.stdout.includes(`  ${RETRY_FIX}`), r.stdout);
	});

	it('a list without its array key fails as an unexpected response', async () => {
		const r = await run({ mode: 'public', override: { '/sdk/apps/my-app/webhooks': { webhooks: [] } } });
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stdout.includes('    ✗ webhook list (unexpected response)'), r.stdout);
	});

	it('a 401 and a 403 on sections fail and point at check-setup', async () => {
		const r = await run({ override: { '/sdk/apps/my-app/1/modules/listItems/api': 401, '/sdk/apps/connections/my-app/api': 403 } });
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stdout.includes('  Failed: 2'), r.stdout);
		assert.ok(r.stdout.includes('    ✗ modules/listItems/api.imljson (HTTP 401)'), r.stdout);
		assert.ok(r.stdout.includes('    ✗ connections/my-app/api.imljson (HTTP 403)'), r.stdout);
		assert.ok(r.stdout.includes(`  ${AUTH_FIX}`), r.stdout);
		assert.ok(r.stderr.includes('ERROR: 2 section(s) of my-app v1 could not be read'), r.stderr);
	});

	it('a 500 fails without a retry', async () => {
		const r = await run({ override: { '/sdk/apps/my-app/1/base': 500, '/sdk/apps/my-app/1/endpoints/getItem': 500 } });
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stdout.includes('    ✗ base.imljson (HTTP 500)'), r.stdout);
		assert.ok(r.stdout.includes('    ✗ endpoints/getItem (detail) (HTTP 500)'), r.stdout);
		assert.equal(hits('/api/v2/admin/sdk/apps/my-app/1/base'), 1);
		assert.equal(hits('/api/v2/admin/sdk/apps/my-app/1/endpoints/getItem'), 1);
	});

	for (const status of [502, 503, 504]) {
		it(`a ${status} that clears is retried and the run succeeds`, async () => {
			const r = await run({ override: { '/sdk/apps/my-app/1/base': flaky(status, 2, '{ "baseUrl": "https://api.example.com" }') } });
			assert.equal(r.code, 0, r.out);
			assert.ok(r.stdout.includes('Saved: 16 file(s)'), r.stdout);
			assert.equal(hits('/api/v2/admin/sdk/apps/my-app/1/base'), 3);
			assert.match(r.stderr, new RegExp(`⏳ HTTP ${status} → retrying in 0ms`));
		});
	}

	it('halves the concurrency after a 503 or a 429, and not after a 502', async () => {
		const modules = ['a', 'b', 'c', 'd'].map((name) => ({ name, label: name, typeId: 9, crud: 'read', deprecated: false, public: true }));
		for (const status of [503, 429, 502]) {
			let open = 0;
			let most = 0;
			const held = async () => {
				open += 1;
				most = Math.max(most, open);
				await new Promise((resolve) => setTimeout(resolve, 50));
				open -= 1;
				return '[]';
			};
			const override = { '/sdk/apps/my-app/1/base': flaky(status, 1, '{}'), '/sdk/apps/my-app/1/modules': { appModules: modules } };
			for (const { name } of modules) for (const section of ['api', 'parameters', 'expect', 'interface', 'samples', 'scope']) override[`/sdk/apps/my-app/1/modules/${name}/${section}`] = held;
			const r = await run({ override });
			assert.equal(r.code, 0, r.out);
			if (status === 502) assert.ok(most > 5, `${status}: at most ${most} module requests were open at once`);
			else assert.ok(most <= 5 && most >= 2, `${status}: ${most} module requests were open at once`);
		}
	});

	it('a 503 that stays fails after the 5 retries', async () => {
		const r = await run({ override: { '/sdk/apps/my-app/1/base': 503 } });
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stdout.includes('    ✗ base.imljson (HTTP 503 after 5 retries)'), r.stdout);
		assert.equal(hits('/api/v2/admin/sdk/apps/my-app/1/base'), 6);
	});

	it('a 429 fails after the 5 retries', async () => {
		const r = await run({ override: { '/sdk/apps/my-app/1/common': 429 } });
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stdout.includes('    ✗ common.imljson (HTTP 429 after 5 retries)'), r.stdout);
		assert.match(r.stderr, /429 Rate Limit/);
		assert.equal(hits('/api/v2/admin/sdk/apps/my-app/1/common'), 6);
	});

	it('a network error fails after the 5 retries and prints only an error code', async () => {
		const r = await run({ override: { '/sdk/apps/my-app/1/functions/fmt/code': DESTROY } });
		assert.equal(r.code, 1, r.out);
		assert.match(r.stdout, /\n {4}✗ functions\/fmt\/code\.js \([A-Za-z0-9_.-]+\)\n/);
		assert.doesNotMatch(r.stdout, /✗ functions\/fmt\/code\.js \(HTTP/);
		assert.ok(r.stdout.includes(`  ${RETRY_FIX}`), r.stdout);
		assert.equal(hits('/api/v2/admin/sdk/apps/my-app/1/functions/fmt/code'), 6);
	});

	it('a failed metadata call fails', async () => {
		const r = await run({ override: { '/sdk/apps/my-app/1': (u) => (u.searchParams.has('cols[0]') ? GATE : 500) } });
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stdout.includes('  Failed: 1\n    ✗ app metadata (HTTP 500)'), r.stdout);
	});

	it('a failed run writes nothing and leaves the old copy and its downloadedAt as they were', async () => {
		fs.mkdirSync(appDir(), { recursive: true });
		fs.writeFileSync(path.join(appDir(), 'metadata.json'), '{"downloadedAt":"OLD"}');
		fs.writeFileSync(path.join(appDir(), 'base.imljson'), 'OLD BASE');
		const r = await run({ override: { '/sdk/apps/my-app/1/common': 500 } });
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stdout.includes(`  Nothing was written: ${appDir()} is unchanged.`), r.stdout);
		assert.equal(hits('/api/v2/admin/sdk/apps/my-app/1/base'), 1, 'the section was read');
		assert.doesNotMatch(r.stdout, /✓|=== Files ===/);
		assert.equal(hits('/api/v2/admin/apps/my-app'), 0, 'visibility call on a failed run');
		assert.equal(fs.readFileSync(path.join(appDir(), 'metadata.json'), 'utf8'), '{"downloadedAt":"OLD"}');
		assert.equal(fs.readFileSync(path.join(appDir(), 'base.imljson'), 'utf8'), 'OLD BASE');
		assert.deepEqual(fs.readdirSync(appDir()).sort(), ['base.imljson', 'metadata.json']);
	});
});

describe('download-app.js: common masking', () => {
	const MARKER_STRING = '***MASKED:string***';
	const MARKER_NUMBER = '***MASKED:number***';
	const COMMONS = {
		'/sdk/apps/my-app/1/common': '{ "clientSecret": "SECRET_VALUE_1", "nested": { "n": 42, "flag": true, "empty": "" }, "list": ["SECRET_VALUE_2"] }',
		'/sdk/apps/connections/my-app/common': '{ "liveSecret": "SECRET_VALUE_3" }',
	};
	const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
	const readApp = (rel) => fs.readFileSync(path.join(appDir(), rel), 'utf8');

	it('public mode saves both commons masked, lists them in commonMasked, and no real value reaches a file or the output', async () => {
		const r = await run({ mode: 'public', override: COMMONS });
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(JSON.parse(readApp('common.imljson')), { clientSecret: MARKER_STRING, nested: { n: MARKER_NUMBER, flag: true, empty: '' }, list: [MARKER_STRING] });
		assert.deepEqual(JSON.parse(readApp('connections/my-app/common.imljson')), { liveSecret: MARKER_STRING });
		assert.deepEqual(readMetadata().commonMasked, {
			marker: '***MASKED:<type>***',
			files: [
				{ file: 'common.imljson', values: 3 },
				{ file: 'connections/my-app/common.imljson', values: 1 },
			],
		});
		for (const file of walk(appDir())) assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRET_VALUE_'), `a real value in ${file}`);
		assert.ok(!r.stdout.includes('SECRET_VALUE_') && !r.stderr.includes('SECRET_VALUE_'), r.out);
	});

	it('employee mode saves the raw commons and writes no commonMasked', async () => {
		const r = await run({ override: COMMONS });
		assert.equal(r.code, 0, r.out);
		assert.equal(readApp('common.imljson'), COMMONS['/sdk/apps/my-app/1/common']);
		assert.equal(readApp('connections/my-app/common.imljson'), COMMONS['/sdk/apps/connections/my-app/common']);
		assert.ok(!('commonMasked' in readMetadata()));
	});

	it('public mode lists an empty common object with 0 values', async () => {
		const r = await run({ mode: 'public' });
		assert.equal(r.code, 0, r.out);
		assert.equal(readApp('common.imljson'), '{}\n');
		assert.deepEqual(readMetadata().commonMasked.files, [
			{ file: 'common.imljson', values: 0 },
			{ file: 'connections/my-app/common.imljson', values: 0 },
		]);
	});

	it('public mode does not list an absent connection common', async () => {
		const r = await run({ mode: 'public', override: { '/sdk/apps/connections/my-app/common': 404 } });
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(readMetadata().commonMasked.files, [{ file: 'common.imljson', values: 0 }]);
	});

	it('public mode writes commonMasked with an empty list when neither common was saved', async () => {
		const r = await run({ mode: 'public', override: { '/sdk/apps/my-app/1/common': 404, '/sdk/apps/connections/my-app/common': 'null' } });
		assert.equal(r.code, 0, r.out);
		assert.ok(!fs.existsSync(path.join(appDir(), 'common.imljson')));
		assert.deepEqual(readMetadata().commonMasked, { marker: '***MASKED:<type>***', files: [] });
	});

	it('public mode fails on a common that is not a JSON object and writes nothing', async () => {
		const r = await run({ mode: 'public', override: { '/sdk/apps/my-app/1/common': '[1,2]' } });
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stdout.includes('    ✗ common.imljson (common data is not a JSON object, so it cannot be masked)'), r.stdout);
		assert.ok(!fs.existsSync(appDir()));
	});
});

describe('download-app.js --snapshot', () => {
	const COMMONS = {
		'/sdk/apps/my-app/1/common': '{ "clientSecret": "SECRET_VALUE_1", "n": 42 }',
		'/sdk/apps/connections/my-app/common': '{ "liveSecret": "SECRET_VALUE_3" }',
	};
	const entries = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
	const tailOf = (stdout) => stdout.trimEnd().split('\n').slice(-4);
	const plant = (id, takenAt) => {
		fs.mkdirSync(path.join(snapshotsDir(), id), { recursive: true });
		fs.writeFileSync(path.join(snapshotsDir(), id, 'metadata.json'), JSON.stringify({ snapshot: { id, takenAt } }));
	};

	it('public mode saves a masked snapshot under snapshots/ and ends with the four snapshot lines', async () => {
		const r = await run({ mode: 'public', override: COMMONS, args: ['my-app', '1', '--snapshot'] });
		assert.equal(r.code, 0, r.out);
		const [idLine, pathLine, keptLine, lastLine] = tailOf(r.stdout);
		const id = idLine.slice('Snapshot: '.length);
		assert.match(idLine, /^Snapshot: \d{8}-\d{6}$/);
		assert.equal(pathLine, `Path: ${path.join(snapshotsDir(), id)}`);
		assert.equal(keptLine, 'Kept: 1 of 5');
		assert.equal(lastLine, 'Taken before the push: its files can be pushed back by hand.');
		assert.ok(r.stdout.includes(`Output: ${snapshotsDir()} (a new snapshot)\n`), r.stdout);
		assert.doesNotMatch(r.stdout, /=== Files ===|\n {2}Path: /);
		const dir = path.join(snapshotsDir(), id);
		assert.equal(fs.readFileSync(path.join(dir, 'base.imljson'), 'utf8'), '{ "baseUrl": "https://api.example.com" }');
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'common.imljson'), 'utf8')), { clientSecret: '***MASKED:string***', n: '***MASKED:number***' });
		for (const file of walkFiles(dir)) assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRET_VALUE_'), `a real value in ${file}`);
		const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
		assert.equal(meta.snapshot.id, id);
		assert.equal(meta.snapshot.id, path.basename(dir));
		assert.deepEqual(meta.commonMasked.files, [
			{ file: 'common.imljson', values: 2 },
			{ file: 'connections/my-app/common.imljson', values: 1 },
		]);
		assert.ok(!fs.existsSync(appDir()), 'the working folder was written');
		assert.deepEqual(entries(snapshotsDir()), [id]);
	});

	it('leaves the working folder byte for byte as it was', async () => {
		fs.mkdirSync(appDir(), { recursive: true });
		fs.writeFileSync(path.join(appDir(), 'metadata.json'), '{"downloadedAt":"OLD"}');
		fs.writeFileSync(path.join(appDir(), 'base.imljson'), 'OLD BASE');
		const r = await run({ mode: 'public', args: ['my-app', '1', '--snapshot'] });
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(fs.readdirSync(appDir()).sort(), ['base.imljson', 'metadata.json']);
		assert.equal(fs.readFileSync(path.join(appDir(), 'metadata.json'), 'utf8'), '{"downloadedAt":"OLD"}');
		assert.equal(fs.readFileSync(path.join(appDir(), 'base.imljson'), 'utf8'), 'OLD BASE');
	});

	it('keeps five snapshots: the oldest of five old ones is gone after the run', async () => {
		for (let n = 1; n <= 5; n++) plant(`20200101-00000${n}`, `2020-01-01T00:00:0${n}.000Z`);
		const r = await run({ mode: 'public', args: ['my-app', '1', '--snapshot'] });
		assert.equal(r.code, 0, r.out);
		const id = tailOf(r.stdout)[0].slice('Snapshot: '.length);
		assert.deepEqual(entries(snapshotsDir()), ['20200101-000002', '20200101-000003', '20200101-000004', '20200101-000005', id]);
		assert.ok(r.stdout.includes('\nKept: 5 of 5\n'), r.stdout);
	});

	it('removes a temp folder older than a day', async () => {
		const stale = path.join(snapshotsDir(), '20200101-000000.tmp');
		fs.mkdirSync(stale, { recursive: true });
		const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
		fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
		const r = await run({ mode: 'public', args: ['my-app', '1', '--snapshot'] });
		assert.equal(r.code, 0, r.out);
		assert.ok(!fs.existsSync(stale), 'the stale temp folder is still there');
		assert.equal(entries(snapshotsDir()).length, 1);
	});

	it('a read failure prints the Failed block, takes no snapshot and exits 1', async () => {
		const r = await run({ mode: 'public', override: { '/sdk/apps/my-app/1/base': 500 }, args: ['my-app', '1', '--snapshot'] });
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stdout.includes('  Failed: 1\n    ✗ base.imljson (HTTP 500)\n  Nothing was written: no snapshot was taken.\n'), r.stdout);
		assert.ok(r.stderr.includes('ERROR: 1 section(s) of my-app v1 could not be read, so nothing was written.'), r.stderr);
		assert.deepEqual(entries(snapshotsDir()), []);
		assert.ok(!fs.existsSync(appDir()));
	});

	it('a snapshot that cannot be written exits 1 with the write error and leaves no folder', async () => {
		fs.mkdirSync(path.dirname(snapshotsDir()), { recursive: true });
		fs.writeFileSync(snapshotsDir(), 'a file where the app folder goes');
		const r = await run({ mode: 'public', args: ['my-app', '1', '--snapshot'] });
		assert.equal(r.code, 1, r.out);
		assert.match(r.stderr, /^ERROR: the snapshot could not be written \([A-Z]+\), so none was kept\.\nCheck that ~\/\.make-custom-app\/snapshots can be written, then run the same command again\.$/m);
		assert.ok(fs.statSync(snapshotsDir()).isFile(), 'the planted file was replaced');
		assert.deepEqual(fs.readdirSync(path.dirname(snapshotsDir())), ['my-app-v1']);
		assert.ok(!fs.existsSync(appDir()));
		assert.doesNotMatch(r.stdout, /^Snapshot: /m);
	});

	it('refuses an output dir next to --snapshot before any request', async () => {
		const out = path.join(work, 'out');
		const r = await run({ mode: 'public', args: ['my-app', '1', out, '--snapshot'] });
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stderr, `${SNAPSHOT_WITH_OUTPUT_DIR}\n`);
		assert.equal(r.stdout, `${USAGE_LINES.join('\n')}\n`);
		assert.equal(log.length, 0);
		assert.ok(!fs.existsSync(out));
	});

	it('prints the usage with --snapshot when the version is missing', async () => {
		const r = await run({ args: ['my-app', '--snapshot'] });
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stdout, `${USAGE_LINES.join('\n')}\n`);
		assert.equal(log.length, 0);
	});

	it('employee mode saves the raw commons in the snapshot and writes no commonMasked', async () => {
		const r = await run({ override: COMMONS, args: ['my-app', '1', '--snapshot'] });
		assert.equal(r.code, 0, r.out);
		const dir = path.join(snapshotsDir(), tailOf(r.stdout)[0].slice('Snapshot: '.length));
		assert.equal(fs.readFileSync(path.join(dir, 'common.imljson'), 'utf8'), COMMONS['/sdk/apps/my-app/1/common']);
		assert.equal(fs.readFileSync(path.join(dir, 'connections/my-app/common.imljson'), 'utf8'), COMMONS['/sdk/apps/connections/my-app/common']);
		assert.ok(!('commonMasked' in JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'))));
		assert.ok(!fs.existsSync(appDir()));
	});
});
