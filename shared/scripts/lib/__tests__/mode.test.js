/**
 * Tests for mode.js: detectMode and detectZone with injected answers and against a mock Make API, probeSync against the
 * mock (a separate process, because the probe blocks this one), the cache, and requireMode in-process (process.exit
 * throws) and in child processes with a fake HOME and TMPDIR. MAKE_CUSTOM_APP_TEST_API_ORIGIN points them at the mock.
 */
require('./isolate-home');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const settings = require('../settings');
const mode = require('../mode');
const logic = require('../mode-logic');
const { cacheKey: accessKey, JIRA_BASE_URL } = require('../access-guard-logic');
const { setupCommand } = require('../paths');

const MODE = path.join(__dirname, '..', 'mode.js');
const HOST = 'eu1.make.com';
const TOKEN = 'MODE_TEST_TOKEN_secret';
const EMAIL = 'dev@make.com';
const JIRA_TOKEN = 'JIRA_TOKEN_secret_value';
const NOW = 2_000_000_000_000;
const ME_BODY = { authUser: { id: 5, name: 'Dev User', email: 'dev@example.org' } };

// Answers by token, so one mock serves every case.
const MOCK_MAKE = `
const http = require('http');
const seen = [];
const ANSWERS = {
	EMPLOYEE_TOKEN: { me: 200, admin: 200 },
	PUBLIC_403_TOKEN: { me: 200, admin: 403 },
	PUBLIC_401_TOKEN: { me: 200, admin: 401 },
	ADMIN_500_TOKEN: { me: 200, admin: 500 },
	BAD_TOKEN: { me: 401 },
	ME_403_EMPLOYEE_TOKEN: { me: 403, admin: 200 },
	ME_403_PUBLIC_TOKEN: { me: 403, admin: 403 },
};
const server = http.createServer((req, res) => {
	const u = new URL(req.url, 'http://x');
	if (u.pathname === '/__log') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		return res.end(JSON.stringify(seen));
	}
	const token = (req.headers.authorization || '').replace(/^Token /, '');
	seen.push({ path: u.pathname, search: u.search, token });
	const answer = ANSWERS[token] || { me: 401 };
	const status = u.pathname === '/api/v2/users/me' ? answer.me : u.pathname === '/api/v2/admin/sdk/apps' ? answer.admin : 404;
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(u.pathname === '/api/v2/users/me' && status === 200 ? { authUser: { id: 5, name: 'Dev User' } } : { apps: [] }));
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

let mockProcess;
let origin;
let closedOrigin;
let work;

before(async () => {
	work = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-test-'));
	mockProcess = spawn(process.execPath, ['-e', MOCK_MAKE], { stdio: ['ignore', 'pipe', 'inherit'] });
	const port = await new Promise((resolve) => mockProcess.stdout.once('data', (c) => resolve(String(c).trim())));
	origin = `http://127.0.0.1:${port}`;
	closedOrigin = `http://127.0.0.1:${await closedPort()}`;
});

after(() => {
	mockProcess.kill();
	fs.rmSync(work, { recursive: true, force: true });
});

afterEach(() => {
	delete process.env[logic.TEST_ORIGIN_VAR];
	delete process.env.CLAUDECODE;
	delete process.env.CURSOR_AGENT;
});

function closedPort() {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.listen(0, '127.0.0.1', () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
}

async function seenBy(token) {
	const res = await fetch(`${origin}/__log`);
	return (await res.json()).filter((entry) => entry.token === token);
}

/** A fetch stand-in that answers by path ({ status, body } or an Error to throw) and records each call. */
function fakeFetch(routes) {
	const calls = [];
	const fn = async (url, options) => {
		calls.push({ url, options });
		const answer = routes[new URL(url).pathname];
		if (answer instanceof Error) throw answer;
		return { status: answer.status, text: async () => (answer.body === undefined ? '' : JSON.stringify(answer.body)) };
	};
	fn.calls = calls;
	return fn;
}

const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

/**
 * Runs `code` in a child Node process that is killed after 10 s and returns its stdout. A read that blocks on a FIFO
 * blocks the whole process, so a node:test timeout cannot end it; in a child the case fails instead of hanging the run.
 */
function runBounded(code, args) {
	const r = spawnSync(process.execPath, ['-e', code, ...args], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
	assert.equal(r.signal, null, 'the read blocked on the FIFO');
	assert.equal(r.status, 0, r.stderr);
	return r.stdout;
}

describe('detectMode with injected answers', () => {
	it('asks users/me and then the admin probe with the token, and says employee on 2xx', async () => {
		const fetchFn = fakeFetch({ '/api/v2/users/me': { status: 200, body: ME_BODY }, '/api/v2/admin/sdk/apps': { status: 200, body: { apps: [] } } });
		const result = await mode.detectMode(HOST, TOKEN, { fetchFn, origin: null });
		assert.deepEqual(result, { me: { status: 200, body: ME_BODY }, admin: { status: 200, body: { apps: [] } }, verdict: 'employee' });
		assert.deepEqual(
			fetchFn.calls.map((c) => c.url),
			['https://eu1.make.com/api/v2/users/me', 'https://eu1.make.com/api/v2/admin/sdk/apps?all=true&name=__mode_probe__&cols[]=name'],
		);
		for (const c of fetchFn.calls) assert.deepEqual(c.options.headers, { Accept: 'application/json', Authorization: `Token ${TOKEN}` });
	});

	it('says public when the admin API answers 401, 403 or 404, and retry for anything else', async () => {
		for (const [admin, verdict] of [[{ status: 401 }, 'public'], [{ status: 403 }, 'public'], [{ status: 404 }, 'public'], [{ status: 429 }, 'retry'], [{ status: 500 }, 'retry'], [refused(), 'retry']]) {
			const fetchFn = fakeFetch({ '/api/v2/users/me': { status: 200, body: ME_BODY }, '/api/v2/admin/sdk/apps': admin });
			assert.equal((await mode.detectMode(HOST, TOKEN, { fetchFn, origin: null })).verdict, verdict, JSON.stringify(admin));
		}
	});

	it('goes on to the admin probe when users/me answers 403: a valid token without user:read', async () => {
		for (const [admin, verdict] of [[{ status: 200 }, 'employee'], [{ status: 403 }, 'public']]) {
			const fetchFn = fakeFetch({ '/api/v2/users/me': { status: 403, body: { message: 'Forbidden' } }, '/api/v2/admin/sdk/apps': admin });
			const result = await mode.detectMode(HOST, TOKEN, { fetchFn, origin: null });
			assert.equal(result.verdict, verdict);
			assert.equal(fetchFn.calls.length, 2);
			assert.equal(logic.accountLabel(result.me), logic.ACCOUNT_NAME_UNAVAILABLE);
		}
	});

	it('stops after users/me on 401, 5xx or a network error: no admin call', async () => {
		for (const [me, expected, verdict] of [
			[{ status: 401 }, { status: 401, body: null }, 'badToken'],
			[{ status: 503, body: { message: 'down' } }, { status: 503, body: { message: 'down' } }, 'retry'],
			[refused(), { error: 'ECONNREFUSED' }, 'retry'],
		]) {
			const fetchFn = fakeFetch({ '/api/v2/users/me': me });
			assert.deepEqual(await mode.detectMode(HOST, TOKEN, { fetchFn, origin: null }), { me: expected, admin: null, verdict });
			assert.equal(fetchFn.calls.length, 1);
		}
	});

	it('sends the calls to a test origin instead of https://{host}', async () => {
		const fetchFn = fakeFetch({ '/api/v2/users/me': { status: 401 } });
		await mode.detectMode(HOST, TOKEN, { fetchFn, origin: 'http://127.0.0.1:9' });
		assert.equal(fetchFn.calls[0].url, 'http://127.0.0.1:9/api/v2/users/me');
	});
});

describe('detectMode against the mock Make API', () => {
	it('employee: both calls reach the mock with the token and the probe query', async () => {
		const result = await mode.detectMode(HOST, 'EMPLOYEE_TOKEN', { origin });
		assert.equal(result.verdict, 'employee');
		assert.equal(logic.accountName(result.me), 'Dev User');
		assert.deepEqual(await seenBy('EMPLOYEE_TOKEN'), [
			{ path: '/api/v2/users/me', search: '', token: 'EMPLOYEE_TOKEN' },
			{ path: '/api/v2/admin/sdk/apps', search: '?all=true&name=__mode_probe__&cols[]=name', token: 'EMPLOYEE_TOKEN' },
		]);
	});

	it('takes the mock from MAKE_CUSTOM_APP_TEST_API_ORIGIN when no origin is passed', async () => {
		process.env[logic.TEST_ORIGIN_VAR] = origin;
		assert.equal((await mode.detectMode(HOST, 'PUBLIC_403_TOKEN')).verdict, 'public');
		assert.equal((await mode.detectMode(HOST, 'BAD_TOKEN')).verdict, 'badToken');
	});

	it('reports a refused connection as an error code', async () => {
		assert.deepEqual(await mode.detectMode(HOST, TOKEN, { origin: closedOrigin }), { me: { error: 'ECONNREFUSED' }, admin: null, verdict: 'retry' });
	});
});

describe('detectZone', () => {
	function zoneFetch(statusByHost) {
		const calls = [];
		const fn = async (url) => {
			calls.push(url);
			const status = statusByHost[new URL(url).hostname];
			if (status === undefined) throw refused();
			return { status, text: async () => '{}' };
		};
		fn.calls = calls;
		return fn;
	}

	it('tries users/me on all six zones and picks the one that answers 200', async () => {
		const fetchFn = zoneFetch({ 'eu1.make.com': 401, 'eu2.make.com': 401, 'us1.make.com': 401, 'us2.make.com': 200, 'eu1.make.celonis.com': 401 });
		assert.deepEqual(await mode.detectZone(TOKEN, { fetchFn, origin: null }), { host: 'us2.make.com' });
		assert.deepEqual(fetchFn.calls.sort(), logic.ZONES.map((h) => `https://${h}/api/v2/users/me`).sort());
	});

	it('asks with every answer when no zone or several zones answer 200', async () => {
		const none = await mode.detectZone(TOKEN, { fetchFn: zoneFetch({ 'eu1.make.com': 401 }), origin: null });
		assert.equal(none.ask, true);
		assert.deepEqual(none.results[0], { host: 'eu1.make.com', status: 401 });
		assert.deepEqual(none.results[1], { host: 'eu2.make.com', error: 'ECONNREFUSED' });
		const several = await mode.detectZone(TOKEN, { fetchFn: zoneFetch({ 'eu1.make.com': 200, 'us1.make.com': 200 }), origin: null });
		assert.equal(several.ask, true);
		assert.equal(several.results.length, 6);
	});

	it('sends all six calls to the test origin from the environment', async () => {
		process.env[logic.TEST_ORIGIN_VAR] = origin;
		const result = await mode.detectZone('PUBLIC_401_TOKEN');
		assert.equal(result.ask, true);
		assert.deepEqual(result.results.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
	});
});

describe('probeSync (child process against the mock)', () => {
	it('returns both results without bodies', () => {
		assert.deepEqual(mode.probeSync(HOST, 'EMPLOYEE_TOKEN', { origin }), { me: { status: 200 }, admin: { status: 200 } });
		assert.deepEqual(mode.probeSync(HOST, 'PUBLIC_403_TOKEN', { origin }), { me: { status: 200 }, admin: { status: 403 } });
		assert.deepEqual(mode.probeSync(HOST, 'BAD_TOKEN', { origin }), { me: { status: 401 }, admin: null });
		assert.deepEqual(mode.probeSync(HOST, 'ME_403_EMPLOYEE_TOKEN', { origin }), { me: { status: 403 }, admin: { status: 200 } });
	});

	it('reports a network failure as an error code', () => {
		assert.deepEqual(mode.probeSync(HOST, TOKEN, { origin: closedOrigin }), { me: { error: 'ECONNREFUSED' }, admin: null });
	});

	it('takes the test origin from the environment by default', () => {
		process.env[logic.TEST_ORIGIN_VAR] = origin;
		assert.deepEqual(mode.probeSync(HOST, 'ADMIN_500_TOKEN'), { me: { status: 200 }, admin: { status: 500 } });
	});

	it('never puts the token in the argv or the environment of the child: it goes over stdin', () => {
		const capture = path.join(work, 'child-capture.json');
		const preload = path.join(work, 'capture-child.js');
		fs.writeFileSync(preload, "require('fs').writeFileSync(process.env.MODE_TEST_CAPTURE, JSON.stringify({ argv: process.argv, execArgv: process.execArgv, env: process.env }));");
		const before = { NODE_OPTIONS: process.env.NODE_OPTIONS, MODE_TEST_CAPTURE: process.env.MODE_TEST_CAPTURE };
		process.env.NODE_OPTIONS = `--require "${preload}"`;
		process.env.MODE_TEST_CAPTURE = capture;
		let result;
		try {
			result = mode.probeSync(HOST, 'EMPLOYEE_TOKEN', { origin });
		} finally {
			for (const [name, value] of Object.entries(before)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
		assert.deepEqual(result, { me: { status: 200 }, admin: { status: 200 } });
		const child = JSON.parse(fs.readFileSync(capture, 'utf8'));
		assert.ok(child.argv.includes(MODE), 'the capture is of the probe child');
		assert.ok(!JSON.stringify(child).includes('EMPLOYEE_TOKEN'));
	});
});

describe('the mode cache', () => {
	let cacheFile;
	let n = 0;

	beforeEach(() => {
		cacheFile = path.join(work, `mode-${n++}.json`);
	});

	it('keeps the file in the temp folder', () => {
		assert.equal(mode.CACHE_FILE, path.join(os.tmpdir(), 'make-custom-app-mode.json'));
	});

	it('saves employee and public with the hashed key and no token, and reads them back for 24 hours', () => {
		mode.saveVerdict(HOST, TOKEN, 'public', { cacheFile, now: () => NOW });
		const entry = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
		assert.deepEqual(entry, { key: logic.cacheKey(HOST, TOKEN), host: HOST, mode: 'public', checkedAt: NOW });
		assert.ok(!fs.readFileSync(cacheFile, 'utf8').includes(TOKEN));
		assert.equal(mode.cachedMode(HOST, TOKEN, { cacheFile, now: () => NOW + 1000 }), 'public');
		assert.equal(mode.cachedMode(HOST, TOKEN, { cacheFile, now: () => NOW + logic.CACHE_TTL_MS }), null);
		assert.equal(mode.cachedMode(HOST, 'another token', { cacheFile, now: () => NOW }), null);
		assert.equal(mode.cachedMode('us1.make.com', TOKEN, { cacheFile, now: () => NOW }), null);
		mode.saveVerdict(HOST, TOKEN, 'employee', { cacheFile, now: () => NOW });
		assert.equal(mode.cachedMode(HOST, TOKEN, { cacheFile, now: () => NOW }), 'employee');
	});

	it('leaves the file alone on retry and removes it on badToken', () => {
		mode.saveVerdict(HOST, TOKEN, 'public', { cacheFile, now: () => NOW });
		mode.saveVerdict(HOST, TOKEN, 'retry', { cacheFile, now: () => NOW + 5 });
		assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).checkedAt, NOW);
		mode.saveVerdict(HOST, TOKEN, 'badToken', { cacheFile });
		assert.equal(fs.existsSync(cacheFile), false);
		mode.saveVerdict(HOST, TOKEN, 'badToken', { cacheFile });
	});

	it('writes the file readable by its owner only', { skip: process.platform === 'win32' }, () => {
		mode.saveVerdict(HOST, TOKEN, 'public', { cacheFile, now: () => NOW });
		assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
	});

	it('replaces a planted symlink and leaves the file it pointed at as it was', { skip: process.platform === 'win32' }, () => {
		const victim = path.join(work, `victim-${n}.txt`);
		fs.writeFileSync(victim, 'VICTIM');
		fs.symlinkSync(victim, cacheFile);
		mode.saveVerdict(HOST, TOKEN, 'public', { cacheFile, now: () => NOW });
		assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM');
		assert.equal(fs.lstatSync(cacheFile).isSymbolicLink(), false);
		assert.equal(mode.cachedMode(HOST, TOKEN, { cacheFile, now: () => NOW }), 'public');
	});

	it('reads a symlinked cache as empty even when its target holds a fresh entry', { skip: process.platform === 'win32' }, () => {
		const target = path.join(work, `target-${n}.json`);
		fs.writeFileSync(target, JSON.stringify(logic.cacheEntry(HOST, TOKEN, 'public', NOW)));
		fs.symlinkSync(target, cacheFile);
		assert.equal(mode.cachedMode(HOST, TOKEN, { cacheFile, now: () => NOW }), null);
	});

	it('replaces a 0644 file of the same owner with a 0600 one', { skip: process.platform === 'win32' }, () => {
		fs.writeFileSync(cacheFile, '{}', { mode: 0o644 });
		fs.chmodSync(cacheFile, 0o644);
		mode.saveVerdict(HOST, TOKEN, 'public', { cacheFile, now: () => NOW });
		assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
	});

	it('reads a FIFO as empty without hanging', { skip: process.platform === 'win32' }, (t) => {
		if (spawnSync('mkfifo', [cacheFile]).status !== 0) return t.skip('mkfifo failed');
		const code = 'const [file, host, cacheFile] = process.argv.slice(1); process.stdout.write(String(require(file).cachedMode(host, "FIFO_CASE_KEY", { cacheFile })))';
		assert.equal(runBounded(code, [MODE, HOST, cacheFile]), 'null');
	});

	it('is not stopped by a leftover temp file of the same process', () => {
		fs.writeFileSync(`${cacheFile}.${process.pid}.tmp`, 'junk');
		mode.saveVerdict(HOST, TOKEN, 'public', { cacheFile, now: () => NOW });
		assert.equal(mode.cachedMode(HOST, TOKEN, { cacheFile, now: () => NOW }), 'public');
		assert.equal(fs.existsSync(`${cacheFile}.${process.pid}.tmp`), false);
	});

	it('ignores a file that is not JSON and a folder that cannot be written', () => {
		fs.writeFileSync(cacheFile, 'not json');
		assert.equal(mode.cachedMode(HOST, TOKEN, { cacheFile }), null);
		mode.saveVerdict(HOST, TOKEN, 'public', { cacheFile: path.join(work, 'no-such-dir', 'mode.json') });
	});

	it('uses the default file and clock', () => {
		mode.saveVerdict(HOST, TOKEN, 'public');
		assert.equal(mode.cachedMode(HOST, TOKEN), 'public');
		mode.saveVerdict(HOST, TOKEN, 'badToken');
		assert.equal(mode.cachedMode(HOST, TOKEN), null);
	});
});

describe('requireMode in-process', () => {
	let cacheFile;
	let n = 0;
	const accessCache = () => require('../access-guard').CACHE_FILE;

	function writeSecrets({ jira = false, zone = 'make-zone: eu1.make.com' } = {}) {
		const lines = [`make-api-key: ${TOKEN}`, zone];
		if (jira) lines.push(`jira-email: ${EMAIL}`, `jira-api-token: ${JIRA_TOKEN}`);
		fs.writeFileSync(settings.SECRETS_PATH, `${lines.join('\n')}\n`, { mode: 0o600 });
		if (jira) fs.writeFileSync(accessCache(), JSON.stringify({ key: accessKey({ baseUrl: JIRA_BASE_URL, email: EMAIL, token: JIRA_TOKEN }), email: EMAIL, checkedAt: Date.now() }));
	}

	/** process.exit throws, so the code stops where it would exit; returns what went to stderr. */
	function captureExit(t) {
		const out = [];
		t.mock.method(process, 'exit', (code) => {
			throw new Error(`exit ${code}`);
		});
		t.mock.method(process.stderr, 'write', (chunk) => {
			out.push(String(chunk));
			return true;
		});
		return out;
	}

	function probeAnswering(result) {
		const calls = [];
		const fn = (...args) => {
			calls.push(args);
			return result;
		};
		fn.calls = calls;
		return fn;
	}

	const opts = (extra = {}) => ({ cacheFile, now: () => NOW, ...extra });

	beforeEach(() => {
		cacheFile = path.join(work, `require-${n++}.json`);
		process.env.CLAUDECODE = '1';
		fs.rmSync(accessCache(), { force: true });
	});

	afterEach(() => fs.rmSync(settings.SECRETS_PATH, { force: true }));

	it('employee: probes once, caches the verdict, runs the Jira check and returns the admin base', () => {
		writeSecrets({ jira: true });
		const probe = probeAnswering({ me: { status: 200 }, admin: { status: 200 } });
		const result = mode.requireMode(opts({ probe }));
		assert.deepEqual(result, { editor: 'claude', host: HOST, apikey: TOKEN, auth: `Token ${TOKEN}`, cursorAdmin: null, mode: 'employee', baseUrl: 'https://eu1.make.com/api/v2/admin' });
		assert.deepEqual(probe.calls, [[HOST, TOKEN, { origin: null }]]);
		assert.equal(mode.cachedMode(HOST, TOKEN, opts()), 'employee');
	});

	it('public: returns the public base and needs no Jira token', () => {
		writeSecrets();
		const result = mode.requireMode(opts({ probe: probeAnswering({ me: { status: 200 }, admin: { status: 403 } }) }));
		assert.equal(result.mode, 'public');
		assert.equal(result.baseUrl, 'https://eu1.make.com/api/v2');
		assert.equal(mode.cachedMode(HOST, TOKEN, opts()), 'public');
	});

	it('uses a fresh cache entry without probing, and probes again after 24 hours', () => {
		writeSecrets();
		mode.saveVerdict(HOST, TOKEN, 'public', opts());
		const never = () => assert.fail('probed despite a fresh cache entry');
		assert.equal(mode.requireMode(opts({ probe: never })).mode, 'public');
		const probe = probeAnswering({ me: { status: 200 }, admin: { status: 404 } });
		assert.equal(mode.requireMode(opts({ probe, now: () => NOW + logic.CACHE_TTL_MS })).mode, 'public');
		assert.equal(probe.calls.length, 1);
	});

	it('exits 1 on a rejected token with the token page and the setup command, and drops the cache', (t) => {
		const out = captureExit(t);
		writeSecrets();
		mode.saveVerdict(HOST, TOKEN, 'public', { cacheFile, now: () => NOW - logic.CACHE_TTL_MS });
		assert.throws(() => mode.requireMode(opts({ probe: probeAnswering({ me: { status: 401 }, admin: null }) })), /exit 1/);
		assert.equal(out.join(''), `\n${logic.badTokenMessage(HOST, { editor: 'claude', setupCommand: setupCommand('claude') })}\n`);
		assert.equal(fs.existsSync(cacheFile), false);
		assert.ok(!out.join('').includes(TOKEN));
	});

	it('exits 1 and asks to retry when a call got no usable answer, and caches nothing', (t) => {
		const out = captureExit(t);
		writeSecrets();
		assert.throws(() => mode.requireMode(opts({ probe: probeAnswering({ me: { error: 'ECONNREFUSED' }, admin: null }) })), /exit 1/);
		assert.throws(() => mode.requireMode(opts({ probe: probeAnswering({ me: { status: 200 }, admin: { status: 500 } }) })), /exit 1/);
		assert.deepEqual(out, [`\n${logic.retryMessage(HOST, 'GET /users/me: ECONNREFUSED')}\n`, `\n${logic.retryMessage(HOST, 'admin API probe: HTTP 500')}\n`]);
		assert.equal(fs.existsSync(cacheFile), false);
	});

	it('users/me 403: the admin probe decides, the mode is cached, and nothing asks to retry', (t) => {
		const out = captureExit(t);
		writeSecrets({ jira: true });
		const employee = mode.requireMode(opts({ probe: probeAnswering({ me: { status: 403 }, admin: { status: 200 } }) }));
		assert.equal(employee.mode, 'employee');
		assert.equal(employee.baseUrl, 'https://eu1.make.com/api/v2/admin');
		const pub = mode.requireMode(opts({ probe: probeAnswering({ me: { status: 403 }, admin: { status: 403 } }), now: () => NOW + logic.CACHE_TTL_MS }));
		assert.equal(pub.mode, 'public');
		assert.equal(mode.cachedMode(HOST, TOKEN, { cacheFile, now: () => NOW + logic.CACHE_TTL_MS }), 'public');
		assert.deepEqual(out, []);
	});

	it('refuses an employee-only script in public mode, naming it', (t) => {
		const out = captureExit(t);
		writeSecrets();
		mode.saveVerdict(HOST, TOKEN, 'public', opts());
		assert.throws(() => mode.requireMode(opts({ employeeOnly: true, scriptName: 'test-component.js' })), /exit 1/);
		assert.equal(out.join(''), `\n${logic.employeeOnlyMessage('test-component.js')}\n`);
	});

	it('names the entry script by default', (t) => {
		const out = captureExit(t);
		writeSecrets();
		mode.saveVerdict(HOST, TOKEN, 'public', opts());
		assert.throws(() => mode.requireMode(opts({ employeeOnly: true })), /exit 1/);
		assert.ok(out.join('').includes(`${logic.scriptNameOf(require.main?.filename)} is for Make employees only`), out.join(''));
	});

	it('employee mode still runs the Jira check: no Jira token means exit 1', (t) => {
		const out = captureExit(t);
		writeSecrets();
		mode.saveVerdict(HOST, TOKEN, 'employee', opts());
		assert.throws(() => mode.requireMode(opts()), /exit 1/);
		assert.match(out.join(''), /no Jira API token is saved/);
	});

	it('an employee-only script runs in employee mode', () => {
		writeSecrets({ jira: true });
		mode.saveVerdict(HOST, TOKEN, 'employee', opts());
		assert.equal(mode.requireMode(opts({ employeeOnly: true })).mode, 'employee');
	});

	it('stops at a missing zone before any probe', (t) => {
		captureExit(t);
		t.mock.method(console, 'error', () => {});
		writeSecrets({ zone: '' });
		assert.throws(() => mode.requireMode(opts({ probe: () => assert.fail('probed') })), /exit 1/);
	});

	it('puts a loopback test origin in baseUrl and passes it to the probe, and ignores any other origin', () => {
		writeSecrets();
		process.env[logic.TEST_ORIGIN_VAR] = 'http://127.0.0.1:9';
		const probe = probeAnswering({ me: { status: 200 }, admin: { status: 403 } });
		assert.equal(mode.requireMode(opts({ probe })).baseUrl, 'http://127.0.0.1:9/api/v2');
		assert.deepEqual(probe.calls[0][2], { origin: 'http://127.0.0.1:9' });
		process.env[logic.TEST_ORIGIN_VAR] = 'https://evil.example.org';
		assert.equal(mode.requireMode(opts()).baseUrl, 'https://eu1.make.com/api/v2');
	});

	it('exitEmployeeOnly prints the message and exits 1', (t) => {
		const out = captureExit(t);
		assert.throws(() => mode.exitEmployeeOnly('commit-changes.js compile'), /exit 1/);
		assert.equal(out.join(''), `\n${logic.employeeOnlyMessage('commit-changes.js compile')}\n`);
	});
});

describe('requireMode in a child process against the mock', () => {
	let home;
	let tmp;
	let n = 0;

	beforeEach(() => {
		home = path.join(work, `child-home-${n}`);
		tmp = path.join(work, `child-tmp-${n++}`);
		fs.mkdirSync(home);
		fs.mkdirSync(tmp);
	});

	function run(token, { jira = false, testOrigin = origin, cache = null, employeeOnly = false } = {}) {
		const lines = [`make-api-key: ${token}`, 'make-zone: eu1.make.com'];
		if (jira) {
			lines.push(`jira-email: ${EMAIL}`, `jira-api-token: ${JIRA_TOKEN}`);
			const key = accessKey({ baseUrl: JIRA_BASE_URL, email: EMAIL, token: JIRA_TOKEN });
			fs.writeFileSync(path.join(tmp, 'make-custom-app-access-check.json'), JSON.stringify({ key, email: EMAIL, checkedAt: Date.now() }));
		}
		fs.writeFileSync(path.join(home, '.make-custom-app-skill-secrets'), `${lines.join('\n')}\n`, { mode: 0o600 });
		if (cache) fs.writeFileSync(path.join(tmp, logic.CACHE_FILE_NAME), JSON.stringify(logic.cacheEntry(HOST, token, cache, Date.now())));
		const code = `const s = require(${JSON.stringify(MODE)}).requireMode({ employeeOnly: ${employeeOnly} }); console.log(JSON.stringify({ mode: s.mode, host: s.host, baseUrl: s.baseUrl }));`;
		const r = spawnSync(process.execPath, ['-e', code], {
			env: {
				PATH: process.env.PATH,
				HOME: home,
				USERPROFILE: home,
				TMPDIR: tmp,
				TEMP: tmp,
				TMP: tmp,
				CLAUDECODE: '1',
				[logic.TEST_ORIGIN_VAR]: testOrigin,
				// The children count toward the coverage of mode.js (Node also copies this variable into an explicit env by itself).
				NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE,
			},
			encoding: 'utf8',
		});
		for (const secret of [token, JIRA_TOKEN]) assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'token leaked');
		return { ...r, cached: () => JSON.parse(fs.readFileSync(path.join(tmp, logic.CACHE_FILE_NAME), 'utf8')) };
	}

	it('me 200 and admin 200: employee with the admin base, after the Jira check, and the verdict is cached', () => {
		const r = run('EMPLOYEE_TOKEN', { jira: true });
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), { mode: 'employee', host: HOST, baseUrl: `${origin}/api/v2/admin` });
		assert.equal(r.cached().mode, 'employee');
	});

	it('admin 403 and admin 401: public with the public base, no Jira token needed', () => {
		for (const token of ['PUBLIC_403_TOKEN', 'PUBLIC_401_TOKEN']) {
			const r = run(token);
			assert.equal(r.status, 0, r.stderr);
			assert.deepEqual(JSON.parse(r.stdout), { mode: 'public', host: HOST, baseUrl: `${origin}/api/v2` });
		}
	});

	it('me 401: exit 1 with the bad-token message', () => {
		const r = run('BAD_TOKEN');
		assert.equal(r.status, 1);
		assert.equal(r.stdout, '');
		assert.ok(r.stderr.includes('Make rejected the saved API token for eu1.make.com (HTTP 401).'), r.stderr);
		assert.ok(r.stderr.includes(setupCommand('claude')), r.stderr);
	});

	it('me 403 (a token without user:read): the admin probe decides the mode, and nothing asks to retry', () => {
		const employee = run('ME_403_EMPLOYEE_TOKEN', { jira: true });
		assert.equal(employee.status, 0, employee.stderr);
		assert.deepEqual(JSON.parse(employee.stdout), { mode: 'employee', host: HOST, baseUrl: `${origin}/api/v2/admin` });
		assert.equal(employee.cached().mode, 'employee');
		const pub = run('ME_403_PUBLIC_TOKEN');
		assert.equal(pub.status, 0, pub.stderr);
		assert.deepEqual(JSON.parse(pub.stdout), { mode: 'public', host: HOST, baseUrl: `${origin}/api/v2` });
		assert.equal(pub.cached().mode, 'public');
		for (const r of [employee, pub]) assert.doesNotMatch(r.stderr, /Could not check|retry/i);
	});

	it('a network error: exit 1 with the retry message, nothing cached', () => {
		const r = run('EMPLOYEE_TOKEN', { testOrigin: closedOrigin });
		assert.equal(r.status, 1);
		assert.ok(r.stderr.includes('Could not check the Make API token for eu1.make.com (GET /users/me: ECONNREFUSED).'), r.stderr);
		assert.equal(fs.existsSync(path.join(tmp, logic.CACHE_FILE_NAME)), false);
	});

	it('a fresh cache entry means no network: it works against a closed port', () => {
		const r = run('ANY_TOKEN', { testOrigin: closedOrigin, cache: 'public' });
		assert.equal(r.status, 0, r.stderr);
		assert.equal(JSON.parse(r.stdout).mode, 'public');
	});

	it('employeeOnly in public mode: exit 1 with the message', () => {
		const r = run('PUBLIC_403_TOKEN', { employeeOnly: true });
		assert.equal(r.status, 1);
		assert.ok(r.stderr.includes('this script is for Make employees only'), r.stderr);
	});

	it('employee mode still runs the Jira check', () => {
		const r = run('EMPLOYEE_TOKEN');
		assert.equal(r.status, 1);
		assert.match(r.stderr, /no Jira API token is saved/);
	});
});
