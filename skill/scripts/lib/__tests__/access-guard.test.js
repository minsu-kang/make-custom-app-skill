/**
 * Tests for access-guard.js: the verdict flow with injected Jira answers, the real child-process lookup against a mock
 * Jira server (a separate process, because the lookup blocks this one), and ensureInternalUser() in a fake HOME.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const guard = require('../access-guard');
const { cacheKey, JIRA_BASE_URL, CACHE_TTL_MS, RETRY_MS } = require('../access-guard-logic');

const SKILL_DIR = path.resolve(__dirname, '..', '..', '..');
const NOW = 2_000_000_000_000;
const EMAIL = 'dev@make.com';
const TOKEN = 'JIRA_TOKEN_secret_value';
const KEY = cacheKey({ baseUrl: JIRA_BASE_URL, email: EMAIL, token: TOKEN });

let work;
let n = 0;

before(() => {
	work = fs.mkdtempSync(path.join(os.tmpdir(), 'access-guard-test-'));
});

after(() => {
	fs.rmSync(work, { recursive: true, force: true });
});

function harness({ config = { 'jira-email': EMAIL, 'jira-api-token': TOKEN }, answer, cache } = {}) {
	const cacheFile = path.join(work, `cache-${n++}.json`);
	if (cache) fs.writeFileSync(cacheFile, JSON.stringify(cache));
	const calls = [];
	const deps = {
		readConfig: (key) => config[key] || null,
		lookup: (args) => {
			calls.push(args);
			return answer;
		},
		cacheFile,
		now: () => NOW,
	};
	return { deps, calls, cacheFile, cached: () => (fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : null) };
}

describe('checkAccess', () => {
	it('refuses without a Jira email and token, and does not call Jira', () => {
		for (const config of [{}, { 'jira-email': EMAIL }, { 'jira-api-token': TOKEN }]) {
			const h = harness({ config, answer: { ok: true, email: EMAIL } });
			assert.deepEqual(guard.checkAccess(h.deps), { ok: false, code: 'NO_JIRA' });
			assert.equal(h.calls.length, 0);
		}
	});

	it('accepts a @make.com account, asks the pinned Jira site, and caches the verdict', () => {
		const h = harness({ answer: { ok: true, email: EMAIL } });
		assert.deepEqual(guard.checkAccess(h.deps), { ok: true, email: EMAIL, source: 'jira' });
		assert.deepEqual(h.calls, [{ baseUrl: 'https://make.atlassian.net', email: EMAIL, token: TOKEN }]);
		assert.deepEqual(h.cached(), { key: KEY, email: EMAIL, checkedAt: NOW });
		assert.ok(!JSON.stringify(h.cached()).includes(TOKEN));
	});

	it('uses a fresh cache entry without calling Jira', () => {
		const h = harness({ answer: { ok: false }, cache: { key: KEY, email: EMAIL, checkedAt: NOW - 1000 } });
		assert.deepEqual(guard.checkAccess(h.deps), { ok: true, email: EMAIL, source: 'cache' });
		assert.equal(h.calls.length, 0);
	});

	it('asks Jira again when the cache belongs to other credentials', () => {
		const h = harness({ answer: { ok: true, email: EMAIL }, cache: { key: 'another-key', email: EMAIL, checkedAt: NOW - 1000 } });
		assert.equal(guard.checkAccess(h.deps).source, 'jira');
		assert.equal(h.calls.length, 1);
		assert.equal(h.cached().key, KEY);
	});

	it('refuses an account that is not @make.com and drops the cache', () => {
		const h = harness({ answer: { ok: true, email: 'dev@gmail.com' }, cache: { key: KEY, email: EMAIL, checkedAt: NOW - CACHE_TTL_MS - 1 } });
		assert.deepEqual(guard.checkAccess(h.deps), { ok: false, code: 'EXTERNAL', email: 'dev@gmail.com' });
		assert.equal(h.cached(), null);
	});

	it('refuses a non-@make.com account when nothing is cached', () => {
		const h = harness({ answer: { ok: true, email: 'dev@gmail.com' } });
		assert.deepEqual(guard.checkAccess(h.deps), { ok: false, code: 'EXTERNAL', email: 'dev@gmail.com' });
	});

	it('refuses a 401 and drops the cache, even when the cache is stale', () => {
		const h = harness({ answer: { ok: false, status: 401 }, cache: { key: KEY, email: EMAIL, checkedAt: NOW - CACHE_TTL_MS - 1 } });
		assert.deepEqual(guard.checkAccess(h.deps), { ok: false, code: 'REJECTED', status: 401 });
		assert.equal(h.cached(), null);
	});

	it('does not drop a confirmed account when Jira answers 403', () => {
		const stale = { key: KEY, email: EMAIL, checkedAt: NOW - CACHE_TTL_MS - 1 };
		const h = harness({ answer: { ok: false, status: 403 }, cache: stale });
		assert.deepEqual(guard.checkAccess(h.deps), { ok: true, email: EMAIL, source: 'stale-cache' });
		assert.equal(h.cached().checkedAt, stale.checkedAt);
	});

	it('keeps working from a stale cache while Jira cannot be reached, and waits an hour before asking again', () => {
		const stale = { key: KEY, email: EMAIL, checkedAt: NOW - CACHE_TTL_MS - 1 };
		const h = harness({ answer: { ok: false, status: null, reason: 'ETIMEDOUT' }, cache: stale });
		assert.deepEqual(guard.checkAccess(h.deps), { ok: true, email: EMAIL, source: 'stale-cache' });
		assert.deepEqual(h.cached(), { ...stale, lastAttemptAt: NOW });
		assert.equal(h.calls.length, 1);

		let later = NOW + RETRY_MS - 1;
		assert.equal(guard.checkAccess({ ...h.deps, now: () => later }).source, 'stale-cache');
		assert.equal(h.calls.length, 1);

		later = NOW + RETRY_MS;
		assert.equal(guard.checkAccess({ ...h.deps, now: () => later }).source, 'stale-cache');
		assert.equal(h.calls.length, 2);
	});

	it('asks again at once and refreshes the entry when Jira answers after a failed attempt', () => {
		const h = harness({ answer: { ok: true, email: EMAIL }, cache: { key: KEY, email: EMAIL, checkedAt: NOW - CACHE_TTL_MS - 1, lastAttemptAt: NOW - RETRY_MS } });
		assert.equal(guard.checkAccess(h.deps).source, 'jira');
		assert.deepEqual(h.cached(), { key: KEY, email: EMAIL, checkedAt: NOW });
	});

	it('refuses when Jira cannot be reached and nothing is cached, and says why', () => {
		const cases = [
			[{ ok: false, status: null, noEmail: false, reason: 'ENOTFOUND' }, { status: null, noEmail: false, reason: 'ENOTFOUND' }],
			[{ ok: false, status: 500 }, { status: 500, noEmail: false, reason: null }],
			[{ ok: false, status: 403 }, { status: 403, noEmail: false, reason: null }],
			[{ ok: false, status: null, noEmail: true }, { status: null, noEmail: true, reason: null }],
		];
		for (const [answer, detail] of cases) {
			const h = harness({ answer });
			assert.deepEqual(guard.checkAccess(h.deps), { ok: false, code: 'UNVERIFIED', ...detail }, JSON.stringify(answer));
			assert.equal(h.cached(), null);
		}
	});

	it('writes the cache file readable by its owner only', { skip: process.platform === 'win32' }, () => {
		const h = harness({ answer: { ok: true, email: EMAIL } });
		guard.checkAccess(h.deps);
		assert.equal(fs.statSync(h.cacheFile).mode & 0o777, 0o600);
	});

	it('ignores a cache file that is not JSON', () => {
		const h = harness({ answer: { ok: true, email: EMAIL } });
		fs.writeFileSync(h.cacheFile, 'not json');
		assert.equal(guard.checkAccess(h.deps).source, 'jira');
	});

	it('still answers when the cache file cannot be written', () => {
		const h = harness({ answer: { ok: true, email: EMAIL } });
		const deps = { ...h.deps, cacheFile: path.join(work, 'no-such-dir', 'cache.json') };
		assert.equal(guard.checkAccess(deps).ok, true);
	});
});

const MOCK_JIRA = `
const http = require('http');
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
	if (!req.url.endsWith('/rest/api/3/myself')) return send(res, 404, {});
	if (req.url.startsWith('/noemail')) return send(res, 200, { displayName: 'No Email' });
	const [user, pass] = Buffer.from((req.headers.authorization || '').replace('Basic ', ''), 'base64').toString().split(':');
	if (pass !== '${TOKEN}') return send(res, 401, {});
	send(res, 200, { emailAddress: user });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

describe('lookupJiraEmail (child process against a mock Jira)', () => {
	let mock;
	let base;

	before(async () => {
		mock = spawn(process.execPath, ['-e', MOCK_JIRA], { stdio: ['ignore', 'pipe', 'inherit'] });
		const port = await new Promise((resolve) => mock.stdout.once('data', (c) => resolve(String(c).trim())));
		base = `http://127.0.0.1:${port}`;
	});

	after(() => mock.kill());

	it('sends the credentials as Basic auth and returns the account email', async () => {
		const result = guard.lookupJiraEmail({ baseUrl: base, email: EMAIL, token: TOKEN });
		assert.deepEqual(result, { ok: true, email: EMAIL });
	});

	it('reports the HTTP status of a rejection', async () => {
		assert.deepEqual(guard.lookupJiraEmail({ baseUrl: base, email: EMAIL, token: 'wrong' }), { ok: false, status: 401, noEmail: false, reason: null });
	});

	it('reports a response without an email address', async () => {
		assert.deepEqual(guard.lookupJiraEmail({ baseUrl: `${base}/noemail`, email: EMAIL, token: TOKEN }), { ok: false, status: null, noEmail: true, reason: null });
	});

	it('reports a network failure as an error code and nothing from the request', async () => {
		const closed = await closedPort();
		const result = guard.lookupJiraEmail({ baseUrl: `http://127.0.0.1:${closed}`, email: EMAIL, token: TOKEN });
		assert.deepEqual(result, { ok: false, status: null, noEmail: false, reason: 'ECONNREFUSED' });
	});
});

// A CONNECT-only proxy that tunnels every target to the mock Jira and logs each request. Node's fetch sends CONNECT
// for http:// targets too once NODE_USE_ENV_PROXY=1 is on.
const MOCK_PROXY = `
const http = require('http');
const net = require('net');
const server = http.createServer((req, res) => { res.writeHead(502); res.end(); });
server.on('connect', (req, socket, head) => {
	console.log('CONNECT ' + req.url);
	const upstream = net.connect(Number(process.argv[1]), '127.0.0.1', () => {
		socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
		if (head.length) upstream.write(head);
		upstream.pipe(socket);
		socket.pipe(upstream);
	});
	upstream.on('error', () => socket.destroy());
	socket.on('error', () => upstream.destroy());
});
server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`;

const PROXY_ENV_NAMES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'];
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
const NODE_HAS_ENV_PROXY = NODE_MAJOR >= 24 || (NODE_MAJOR === 22 && NODE_MINOR >= 21);

function withProxyEnv(vars, fn) {
	const saved = Object.fromEntries(PROXY_ENV_NAMES.map((name) => [name, process.env[name]]));
	for (const name of PROXY_ENV_NAMES) delete process.env[name];
	Object.assign(process.env, vars);
	try {
		return fn();
	} finally {
		for (const name of PROXY_ENV_NAMES) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('lookupJiraEmail with a proxy in the environment', () => {
	// .invalid never resolves, so only a request that goes through the proxy can reach the mock Jira.
	const JIRA = 'http://jira.proxy-test.invalid';
	let jira;
	let proxy;
	let proxyPort;
	let proxyLog = '';

	before(async () => {
		jira = spawn(process.execPath, ['-e', MOCK_JIRA], { stdio: ['ignore', 'pipe', 'inherit'] });
		const jiraPort = await new Promise((resolve) => jira.stdout.once('data', (c) => resolve(String(c).trim())));
		proxy = spawn(process.execPath, ['-e', MOCK_PROXY, jiraPort], { stdio: ['ignore', 'pipe', 'inherit'] });
		proxyPort = await new Promise((resolve) => proxy.stdout.once('data', (c) => resolve(/PORT (\d+)/.exec(String(c))[1])));
		proxy.stdout.on('data', (c) => (proxyLog += c));
	});

	after(() => {
		jira.kill();
		proxy.kill();
	});

	it('sends the request through http:// proxy variables', { skip: !NODE_HAS_ENV_PROXY && 'this Node ignores NODE_USE_ENV_PROXY' }, async () => {
		const seen = proxyLog;
		const result = withProxyEnv({ HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, HTTP_PROXY: `http://127.0.0.1:${proxyPort}` }, () => guard.lookupJiraEmail({ baseUrl: JIRA, email: EMAIL, token: TOKEN }));
		await settle();
		assert.deepEqual(result, { ok: true, email: EMAIL });
		assert.match(proxyLog.slice(seen.length), /CONNECT jira\.proxy-test\.invalid:80/);
	});

	it('does not crash on a proxy variable without a scheme and goes direct', async () => {
		const seen = proxyLog;
		const result = withProxyEnv({ HTTPS_PROXY: `127.0.0.1:${proxyPort}` }, () => guard.lookupJiraEmail({ baseUrl: JIRA, email: EMAIL, token: TOKEN }));
		await settle();
		assert.equal(result.ok, false);
		assert.notEqual(result.reason, 'NO_OUTPUT');
		assert.equal(proxyLog, seen);
	});
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

describe('guard wiring', () => {
	it('every entry script calls ensureFreshSkill, and only the two setup scripts skip the account check', () => {
		const scripts = fs.readdirSync(path.join(SKILL_DIR, 'scripts')).filter((f) => f.endsWith('.js'));
		assert.ok(scripts.length >= 14, `found ${scripts.length} scripts`);
		const skipping = [];
		for (const file of scripts) {
			const text = fs.readFileSync(path.join(SKILL_DIR, 'scripts', file), 'utf8');
			assert.match(text, /ensureFreshSkill\(/, `${file} does not call ensureFreshSkill`);
			if (/ensureFreshSkill\(\{\s*access:\s*false/.test(text)) skipping.push(file);
		}
		assert.deepEqual(skipping.sort(), ['check-setup.js', 'setup-secrets.js']);
	});
});

// ensureInternalUser() asks the pinned https://make.atlassian.net, which a test cannot redirect, so its refusal output for
// a real answer is covered through checkAccess() with an injected lookup plus denyMessage(); the runs below use no network.
describe('ensureInternalUser in a fake HOME', () => {
	let home;
	let tmp;
	let secretsPath;

	before(() => {
		home = path.join(work, 'home');
		tmp = path.join(work, 'tmp');
		fs.mkdirSync(tmp, { recursive: true });
		const skillDir = path.join(home, '.claude', 'skills', 'make-custom-app');
		fs.mkdirSync(skillDir, { recursive: true });
		fs.cpSync(path.join(SKILL_DIR, 'scripts'), path.join(skillDir, 'scripts'), { recursive: true, filter: (src) => !src.includes(`${path.sep}__tests__`) });
		fs.copyFileSync(path.join(SKILL_DIR, 'SKILL.md'), path.join(skillDir, 'SKILL.md'));
		fs.writeFileSync(
			path.join(skillDir, 'scripts', 'probe.js'),
			"require('./lib/version-guard').ensureFreshSkill(process.argv[2] === '--no-access' ? { access: false } : undefined);\nconsole.log('ran');\n",
		);
		secretsPath = path.join(home, '.make-custom-app-skill-secrets');
	});

	function probe(args, { secrets, cache }) {
		fs.rmSync(secretsPath, { force: true });
		fs.rmSync(path.join(tmp, 'make-custom-app-access-check.json'), { force: true });
		if (secrets) fs.writeFileSync(secretsPath, secrets, { mode: 0o600 });
		fs.writeFileSync(path.join(tmp, 'make-custom-app-version-check.json'), JSON.stringify({ ok: true, checkedAt: Date.now(), installed: 'x', remote: 'x' }));
		if (cache) fs.writeFileSync(path.join(tmp, 'make-custom-app-access-check.json'), JSON.stringify(cache));
		return new Promise((resolve) => {
			const script = path.join(home, '.claude', 'skills', 'make-custom-app', 'scripts', 'probe.js');
			const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, TEMP: tmp, USERPROFILE: home } });
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (c) => (stdout += c));
			child.stderr.on('data', (c) => (stderr += c));
			child.on('close', (code) => resolve({ code, stdout, stderr }));
		});
	}

	const SECRETS = `jira-email: ${EMAIL}\njira-api-token: ${TOKEN}\n`;

	it('exits 1 with the setup command when no Jira token is saved', async () => {
		const r = await probe([], { secrets: 'imt-app-runtime-path: /tmp\n' });
		assert.equal(r.code, 1);
		assert.equal(r.stdout, '');
		assert.match(r.stderr, /no Jira API token is saved/);
		assert.match(r.stderr, /setup-secrets\.js/);
	});

	it('continues when a fresh cache entry matches the saved credentials', async () => {
		const r = await probe([], { secrets: SECRETS, cache: { key: KEY, email: EMAIL, checkedAt: Date.now() } });
		assert.equal(r.code, 0);
		assert.equal(r.stdout, 'ran\n');
		assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), 'token leaked');
	});

	it('skips the account check with { access: false }', async () => {
		const r = await probe(['--no-access'], {});
		assert.equal(r.code, 0);
		assert.equal(r.stdout, 'ran\n');
	});
});
