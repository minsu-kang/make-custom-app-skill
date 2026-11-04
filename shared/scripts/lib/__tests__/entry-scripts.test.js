/**
 * Tests for the twelve entry scripts in shared/scripts. The first part reads their source: each must run the mode gate
 * requireMode() (and the employee-only ones with employeeOnly), must not name the old layout, and the ones that write to
 * Make must announce their target. The second part runs them as child processes in a fake HOME with an explicit
 * environment, against a local server that stands in for Make (it never answers, answers 404, or answers what a test
 * sets), so no test reaches a real Make or Jira host. MAKE_CUSTOM_APP_TEST_API_ORIGIN sends every Make call to that
 * server, and a mode cache entry skips the probe unless a test removes it. CLAUDECODE is set only where a test says so,
 * because the suite may itself run inside an editor's shell.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { cacheKey, JIRA_BASE_URL } = require('../access-guard-logic');
const { cacheEntry, employeeOnlyMessage, originStop, CACHE_FILE_NAME, TEST_ORIGIN_VAR } = require('../mode-logic');
const { setupCommand } = require('../paths');
const { cursorSettingsPath } = require('../settings');

const SCRIPTS = path.resolve(__dirname, '..', '..');
const ENTRY_SCRIPTS = [
	'commit-changes',
	'create-component',
	'delete-component',
	'download-app',
	'download-jira-ticket-attachment',
	'post-review-transition',
	'review-changes',
	'run-component',
	'test-component',
	'test-function',
	'update-app',
	'update-component',
];
const EMPLOYEE_ONLY = ['download-jira-ticket-attachment', 'post-review-transition', 'test-component'];
const MAKE_WRITERS = ['commit-changes', 'create-component', 'delete-component', 'run-component', 'update-app', 'update-component'];
const MAKE_CALLERS = ['commit-changes', 'create-component', 'delete-component', 'download-app', 'review-changes', 'run-component', 'update-app', 'update-component'];
const CONTEXT_READERS = ['download-app', 'download-jira-ticket-attachment', 'review-changes', 'test-function'];
// The scripts that read the app origin and switch zones in employee mode (download-app has its own tests).
const ORIGIN_READERS = ['commit-changes', 'create-component', 'delete-component', 'review-changes', 'update-app', 'update-component'];
const OLD_LAYOUT = [/version-guard/, /skill-root/, /ensureFreshSkill/, /getSkillRoot/, /getEditorDir/, /SKILL_ROOT/];
const ZONE = 'eu1.make.com';
// An app origin that is not the token's zone. localhost, so that a switch to it reaches the mock and never the network.
const OTHER_ZONE = 'localhost';
const PROBE_ME = 'GET /api/v2/users/me';
const PROBE_ADMIN = 'GET /api/v2/admin/sdk/apps?all=true&name=__mode_probe__&cols[]=name';

// Arguments that get each script past its usage check, so that it reaches the mode gate.
const ARGS = {
	'commit-changes': ['my-app', '1', 'compile'],
	'create-component': ['my-app', '1', 'function', 'foo'],
	'delete-component': ['my-app', '1', 'function', 'foo', '--force'],
	'download-app': ['my-app', '1'],
	'download-jira-ticket-attachment': ['PROJ-1'],
	'post-review-transition': ['PROJ-1', 'committed'],
	'review-changes': ['my-app', '1'],
	'run-component': ['my-app', '1', 'endpoint', 'listItems', '--team=7'],
	'test-component': ['my-app', '1', 'module'],
	'test-function': ['my-app', '1'],
	'update-app': ['my-app', '1', 'base', './base.imljson'],
	'update-component': ['my-app', '1', 'module', 'myModule', 'label=x'],
};

const source = (name) => fs.readFileSync(path.join(SCRIPTS, `${name}.js`), 'utf8');

describe('entry script sources', () => {
	for (const name of ENTRY_SCRIPTS) {
		it(`${name} runs the mode gate and names nothing of the old layout`, () => {
			const text = source(name);
			assert.match(text, /require\('\.\/lib\/mode'\)\.requireMode\(/, `${name} does not call requireMode()`);
			assert.doesNotMatch(text, /ensureInternalUser/, `${name} still calls ensureInternalUser() itself`);
			assert.equal(text.includes('requireMode({ employeeOnly: true })'), EMPLOYEE_ONLY.includes(name), `${name}: employeeOnly`);
			for (const re of OLD_LAYOUT) assert.doesNotMatch(text, re, `${name} still mentions ${re.source}`);
		});
	}

	for (const name of MAKE_WRITERS) {
		it(`${name} announces its target`, () => {
			assert.match(source(name), /announceTarget\(/, `${name} does not call announceTarget()`);
		});
	}

	for (const name of CONTEXT_READERS) {
		it(`${name} takes the contexts folder from paths.js`, () => {
			assert.match(source(name), /getContextsDir\(/, `${name} does not call getContextsDir()`);
		});
	}
});

const EMAIL = 'dev@make.com';
const TOKEN = 'FAKE_JIRA_TOKEN_k3y';
const FAKE_KEY = 'FAKEKEY_abc123SECRET';
// Mock mode 'app' answers every request with this body: download-app reads it as an app with no components.
const EMPTY_APP = JSON.stringify({ app: { label: 'My App' }, appModules: [], appConnections: [], appWebhooks: [], appRpcs: [], appEndpoints: [], appFunctions: [] });

describe('entry scripts in a fake HOME', () => {
	let work;
	let home;
	let tmp;
	let mockup;
	let server;
	let port;
	let mode;
	let answers;
	let requests;
	let hosts;
	let onRequest;
	let secretsPath;
	let cachePath;
	let modeCachePath;

	before(async () => {
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-scripts-test-'));
		home = path.join(work, 'home');
		tmp = path.join(work, 'tmp');
		mockup = path.join(work, 'mockup');
		for (const dir of [home, tmp, mockup]) fs.mkdirSync(dir);
		// test-component runs git in this folder; an own repository keeps it away from any repository above the temp dir.
		spawnSync('git', ['init', '-q', mockup], { stdio: 'ignore' });
		secretsPath = path.join(home, '.make-custom-app-skill-secrets');
		cachePath = path.join(tmp, 'make-custom-app-access-check.json');
		modeCachePath = path.join(tmp, CACHE_FILE_NAME);
		server = http.createServer((req, res) => {
			requests.push(`${req.method} ${req.url}`);
			hosts.push(req.headers.host);
			if (onRequest) onRequest();
			const answer = answers[`${req.method} ${req.url}`];
			if (answer) {
				res.writeHead(answer[0], { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify(answer[1]));
			}
			if (mode === 'hang') return;
			res.writeHead(mode === 'app' ? 200 : 404, { 'Content-Type': 'application/json' });
			res.end(mode === 'app' ? EMPTY_APP : '{}');
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		port = server.address().port;
	});

	after(() => {
		server.closeAllConnections();
		server.close();
		fs.rmSync(work, { recursive: true, force: true });
	});

	/**
	 * A fresh HOME: secrets file (key, zone, mockup, Jira), access-check cache, mode cache and an empty contexts folder.
	 * Without Jira the account check of employee mode has nothing to check; without makeKey the Claude Code key is
	 * missing; tokenMode null leaves the mode cache out, so the script probes the token first. `answers` maps
	 * "METHOD url" to [status, body] for the mock; `hosts` gets the Host header of each request.
	 */
	function seed({ jira = true, makeKey = true, extra = '', tokenMode = 'employee', mock = {} } = {}) {
		mode = 'hang';
		answers = mock;
		requests = [];
		hosts = [];
		onRequest = null;
		fs.rmSync(path.join(home, '.make-custom-app'), { recursive: true, force: true });
		fs.rmSync(cachePath, { force: true });
		fs.rmSync(modeCachePath, { force: true });
		const lines = [`make-zone: ${ZONE}`, `make-apps-mockup-path: ${mockup}`];
		if (makeKey) lines.unshift(`make-api-key: ${FAKE_KEY}`);
		if (jira) {
			lines.push(`jira-email: ${EMAIL}`, `jira-api-token: ${TOKEN}`, `jira-base-url: http://127.0.0.1:${port}`);
			const key = cacheKey({ baseUrl: JIRA_BASE_URL, email: EMAIL, token: TOKEN });
			fs.writeFileSync(cachePath, JSON.stringify({ key, email: EMAIL, checkedAt: Date.now() }));
		}
		if (tokenMode) fs.writeFileSync(modeCachePath, JSON.stringify(cacheEntry(ZONE, FAKE_KEY, tokenMode, Date.now())));
		fs.writeFileSync(secretsPath, `${lines.join('\n')}\n${extra}`, { mode: 0o600 });
	}

	/** A Cursor settings file with one environment on the zone and the fake key; returns a function that removes it again. */
	function writeCursorSettings() {
		const file = cursorSettingsPath(process.platform, home);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ 'apps-sdk.environments': [{ uuid: 'u1', url: `${ZONE}/api`, apikey: FAKE_KEY }] }));
		const top = path.join(home, path.relative(home, file).split(path.sep)[0]);
		return () => fs.rmSync(top, { recursive: true, force: true });
	}

	/** Runs one script. `untilRequest: n` kills it 100 ms after its n-th request reaches the server (true means 1). */
	function run(name, args, { env = { CLAUDECODE: '1' }, untilRequest = false } = {}) {
		return new Promise((resolve) => {
			const child = spawn(process.execPath, [path.join(SCRIPTS, `${name}.js`), ...args], {
				env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, [TEST_ORIGIN_VAR]: `http://127.0.0.1:${port}`, ...env },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (c) => (stdout += c));
			child.stderr.on('data', (c) => (stderr += c));
			const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
			if (untilRequest) {
				onRequest = () => {
					if (requests.length === Number(untilRequest)) setTimeout(() => child.kill('SIGKILL'), 100);
				};
			}
			child.on('close', (code) => {
				clearTimeout(timer);
				onRequest = null;
				resolve({ code, stdout, stderr });
			});
		});
	}

	describe('with no arguments', () => {
		for (const name of ENTRY_SCRIPTS) {
			it(`${name} prints its usage and exits 1`, async () => {
				seed();
				const r = await run(name, []);
				assert.equal(r.code, 1, r.stderr);
				assert.match(r.stdout + r.stderr, /Usage/);
				assert.doesNotMatch(r.stderr, /Cannot find module/);
				assert.equal(requests.length, 0);
			});
		}
	});

	describe('the account check in employee mode', () => {
		for (const name of ENTRY_SCRIPTS) {
			it(`${name} stops there when no Jira token is saved, before any request`, async () => {
				seed({ jira: false });
				const r = await run(name, ARGS[name]);
				assert.equal(r.code, 1, r.stderr);
				assert.match(r.stderr, /no Jira API token is saved/);
				assert.ok(r.stderr.includes(setupCommand('claude')), r.stderr);
				assert.equal(requests.length, 0);
			});
		}

		it('--editor cursor reaches the refusal: it names the setup command of Cursor', async () => {
			seed({ jira: false });
			const removeCursorSettings = writeCursorSettings();
			try {
				const r = await run('download-app', ['--editor', 'cursor', ...ARGS['download-app']], { env: {} });
				assert.equal(r.code, 1, r.stderr);
				assert.match(r.stderr, /no Jira API token is saved/);
				assert.ok(r.stderr.includes(setupCommand('cursor')), r.stderr);
				assert.ok(!r.stderr.includes(setupCommand('claude')), r.stderr);
				assert.equal(requests.length, 0);
			} finally {
				removeCursorSettings();
			}
		});
	});

	describe('public mode', () => {
		for (const name of EMPLOYEE_ONLY) {
			it(`${name} stops with the employee-only message, before any request and without asking for Jira`, async () => {
				seed({ jira: false, tokenMode: 'public' });
				const r = await run(name, ARGS[name]);
				assert.equal(r.code, 1, r.stderr);
				assert.ok(r.stderr.includes(employeeOnlyMessage(`${name}.js`)), r.stderr);
				assert.doesNotMatch(r.stderr, /Jira/);
				assert.equal(requests.length, 0);
			});
		}

		it('commit-changes refuses compile and --issue, before any request', async () => {
			seed({ jira: false, tokenMode: 'public' });
			const compile = await run('commit-changes', ['my-app', '1', 'compile']);
			assert.equal(compile.code, 1, compile.stderr);
			assert.ok(compile.stderr.includes(employeeOnlyMessage('commit-changes.js compile')), compile.stderr);
			const issue = await run('commit-changes', ['my-app', '1', 'commit', '--message=x', '--issue=PROJ-1']);
			assert.equal(issue.code, 1, issue.stderr);
			assert.ok(issue.stderr.includes(employeeOnlyMessage('commit-changes.js --issue')), issue.stderr);
			assert.equal(requests.length, 0);
		});

		it('commit-changes keeps commit and rollback, on the public API and without a Jira token', async () => {
			for (const args of [['my-app', '1', 'commit', '--message=x'], ['my-app', '1', 'rollback', '--confirm']]) {
				seed({ jira: false, tokenMode: 'public' });
				const r = await run('commit-changes', args, { untilRequest: true });
				assert.deepEqual(requests, ['GET /api/v2/sdk/apps/my-app/1?cols[0]=origin'], r.stdout + r.stderr);
				assert.ok(r.stdout.includes(`API: http://127.0.0.1:${port}/api/v2\n`), r.stdout);
			}
		});

		it('commit-changes does not refuse rollback --issue: rollback chains no transition, so --issue does nothing there', async () => {
			seed({ jira: false, tokenMode: 'public' });
			const r = await run('commit-changes', ['my-app', '1', 'rollback', '--confirm', '--issue=PROJ-1'], { untilRequest: true });
			assert.ok(!r.stderr.includes(employeeOnlyMessage('commit-changes.js --issue')), r.stderr);
			assert.deepEqual(requests, ['GET /api/v2/sdk/apps/my-app/1?cols[0]=origin'], r.stdout + r.stderr);
		});
	});

	describe('the zone of the app', () => {
		const answerOrigin = (base) => ({ [`GET ${base}/sdk/apps/my-app/1?cols[0]=origin`]: [200, { app: { origin: OTHER_ZONE } }] });
		const originArgs = (name) => {
			if (name === 'commit-changes') return ['my-app', '1', 'commit', '--message=x'];
			if (name === 'update-app') return ['my-app', '1', 'base', path.join(work, 'base.imljson')];
			return ARGS[name];
		};

		before(() => fs.writeFileSync(path.join(work, 'base.imljson'), '{}\n'));

		for (const name of ORIGIN_READERS) {
			it(`${name} in public mode stops when the app lives in another zone, before any request there`, async () => {
				seed({ jira: false, tokenMode: 'public', mock: answerOrigin('/api/v2') });
				mode = '404';
				const r = await run(name, originArgs(name));
				assert.equal(r.code, 1, r.stdout + r.stderr);
				assert.ok(r.stderr.includes(originStop({ mode: 'public', host: ZONE, origin: OTHER_ZONE }).message), r.stderr);
				assert.ok(r.stderr.includes(`The app lives in ${OTHER_ZONE}, the token is for ${ZONE}.\n`), r.stderr);
				assert.deepEqual(requests, ['GET /api/v2/sdk/apps/my-app/1?cols[0]=origin'], r.stdout + r.stderr);
				assert.deepEqual(hosts, [`127.0.0.1:${port}`]);
			});

			it(`${name} in employee mode switches to the zone of the app, as before`, async () => {
				seed({ mock: answerOrigin('/api/v2/admin') });
				const r = await run(name, originArgs(name), { untilRequest: 2 });
				assert.ok(r.stdout.includes(`http://127.0.0.1:${port}/api/v2/admin → http://${OTHER_ZONE}:${port}/api/v2/admin\n`), r.stdout + r.stderr);
				assert.deepEqual(hosts, [`127.0.0.1:${port}`, `${OTHER_ZONE}:${port}`], r.stdout + r.stderr);
			});
		}
	});

	describe('the API base of the mode', () => {
		const firstRequest = (name, tokenMode) =>
			name === 'run-component' ? 'GET /api/v2/users/me/current-authorization' : `GET /api/v2${tokenMode === 'employee' ? '/admin' : ''}/sdk/apps/my-app/1?cols[0]=origin`;
		const args = (name) => (name === 'commit-changes' ? ['my-app', '1', 'commit', '--message=x'] : ARGS[name]);

		for (const tokenMode of ['employee', 'public']) {
			for (const name of MAKE_CALLERS) {
				it(`${name} in ${tokenMode} mode sends its first request to the ${tokenMode === 'employee' ? 'admin' : 'public'} API`, async () => {
					seed({ jira: tokenMode === 'employee', tokenMode });
					const r = await run(name, args(name), { untilRequest: true });
					assert.deepEqual(requests, [firstRequest(name, tokenMode)], r.stdout + r.stderr);
					assert.ok(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY), 'API key leaked');
				});
			}
		}
	});

	describe('the probe', () => {
		it('without a fresh mode cache, the script probes the token first and caches the verdict', async () => {
			seed({ jira: false, tokenMode: null, mock: { [PROBE_ME]: [200, { authUser: { id: 5, name: 'Dev User' } }], [PROBE_ADMIN]: [403, { code: 'SC403' }] } });
			const r = await run('download-app', ARGS['download-app'], { untilRequest: 3 });
			assert.deepEqual(requests, [PROBE_ME, PROBE_ADMIN, 'GET /api/v2/sdk/apps/my-app/1?cols[0]=origin'], r.stdout + r.stderr);
			assert.equal(JSON.parse(fs.readFileSync(modeCachePath, 'utf8')).mode, 'public');
			assert.ok(!fs.readFileSync(modeCachePath, 'utf8').includes(FAKE_KEY), 'API key cached');
		});

		it('a token that users/me rejects stops with the token page and the setup command, after that one request', async () => {
			seed({ tokenMode: null, mock: { [PROBE_ME]: [401, { code: 'IM001' }] } });
			const r = await run('update-app', ARGS['update-app']);
			assert.equal(r.code, 1, r.stderr);
			assert.ok(r.stderr.includes(`Make rejected the saved API token for ${ZONE} (HTTP 401).`), r.stderr);
			assert.ok(r.stderr.includes(`https://${ZONE}/user/api`), r.stderr);
			assert.ok(r.stderr.includes(setupCommand('claude')), r.stderr);
			assert.doesNotMatch(r.stderr, /Target:/);
			assert.deepEqual(requests, [PROBE_ME]);
		});
	});

	describe('the target announcement', () => {
		for (const name of MAKE_WRITERS) {
			it(`${name} prints the editor and the Make API host before its first request`, async () => {
				seed();
				const r = await run(name, ARGS[name], { untilRequest: true });
				assert.ok(requests.length >= 1, `${name} never reached the Make API: ${r.stdout}${r.stderr}`);
				assert.ok(r.stderr.includes(`Target: editor=claude, Make API host=127.0.0.1:${port}`), r.stderr);
				assert.ok(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY), 'API key leaked');
			});
		}
	});

	/**
	 * Where each script stops once --editor has answered, with no editor variable and no `editor:` line. Every row gets the
	 * minimal valid positional arguments (ARGS), so no script stops at usage. KEY_STOP rows have the Jira cache seeded and
	 * the Make API key left out: they stop at "Make API key not configured", which only the Claude Code branch prints, so it
	 * proves the flag chose the editor. The other three send no Make request of their own, so a marker on stdout shows that
	 * they got past the mode gate with the editor from the flag.
	 */
	const KEY_STOP = { seed: { makeKey: false } };
	const STOP_AT = {
		'commit-changes': KEY_STOP,
		'create-component': KEY_STOP,
		'delete-component': KEY_STOP,
		'download-app': KEY_STOP,
		'download-jira-ticket-attachment': { marker: 'Fetching attachments for PROJ-1...' },
		'post-review-transition': { marker: 'Issue: PROJ-1\nDisposition: committed' },
		'review-changes': KEY_STOP,
		'run-component': KEY_STOP,
		'test-component': KEY_STOP,
		'test-function': { marker: 'Testing: my-app v1' },
		'update-app': KEY_STOP,
		'update-component': KEY_STOP,
	};
	const PLACEMENTS = {
		first: (args) => ['--editor', 'claude', ...args],
		last: (args) => [...args, '--editor', 'claude'],
		'equals form': (args) => ['--editor=claude', ...args],
	};

	describe('--editor on every entry script', () => {
		for (const name of ENTRY_SCRIPTS) {
			for (const [placement, withFlag] of Object.entries(PLACEMENTS)) {
				it(`${name} resolves the editor from --editor (${placement}) and reaches its own work`, async () => {
					const stop = STOP_AT[name];
					seed(stop.seed);
					if (name === 'test-function') {
						const fn = path.join(home, '.make-custom-app', 'contexts', 'my-app-v1', 'functions', 'foo');
						fs.mkdirSync(fn, { recursive: true });
						fs.writeFileSync(path.join(fn, 'code.js'), 'function () { return 1; }');
					}
					const r = await run(name, withFlag(ARGS[name]), { env: {} });
					const out = r.stdout + r.stderr;
					assert.doesNotMatch(r.stderr, /Cannot tell which editor/);
					assert.doesNotMatch(out, /Usage|Unknown flag|Invalid editor|needs a value/);
					if (stop.marker) {
						assert.ok(r.stdout.includes(stop.marker), out);
						assert.doesNotMatch(out, /not found/);
					} else {
						assert.equal(r.code, 1, out);
						assert.ok(r.stderr.includes('ERROR: Make API key not configured.'), out);
						assert.ok(r.stderr.includes('Claude Code requires `make-api-key:`'), out);
					}
					assert.equal(requests.length, 0, `${name} sent a request: ${requests.join(', ')}`);
				});
			}
		}

		it('a flag with no value stops with the message before anything else', async () => {
			seed();
			const r = await run('download-app', ['my-app', '1', '--editor'], { env: {} });
			assert.equal(r.code, 1);
			assert.equal(r.stderr, 'ERROR: --editor needs a value: claude or cursor.\n');
			assert.equal(requests.length, 0);
		});

		it('a flag that names no editor stops with the editor message', async () => {
			seed();
			const r = await run('download-app', ['--editor=zed', 'my-app', '1'], { env: {} });
			assert.equal(r.code, 1);
			assert.equal(r.stderr, 'ERROR: Invalid editor "zed" from --editor flag. Use claude or cursor.\n');
			assert.equal(requests.length, 0);
		});

		it('commit-changes hands its editor to the chained post-review-transition.js', async () => {
			const changes = { app: { changes: [{ id: 1, group: 'module', item: 'm', code: 'api' }], approved: true } };
			seed({ mock: { 'GET /api/v2/admin/sdk/apps/my-app/1?cols[0]=changes&cols[1]=approved': [200, changes], 'POST /api/v2/admin/sdk/apps/my-app/1/commit': [200, {}] } });
			mode = '404';
			const r = await run('commit-changes', ['--editor', 'claude', 'my-app', '1', 'commit', '--message=x', '--issue=PROJ-1'], { env: {} });
			assert.equal(r.code, 0, r.stdout + r.stderr);
			assert.ok(r.stdout.includes('Committed 1 change(s)'), r.stdout);
			assert.ok(r.stdout.includes('Issue: PROJ-1\nDisposition: committed'), r.stdout + r.stderr);
			assert.doesNotMatch(r.stderr, /Cannot tell which editor/);
		});
	});

	describe('the editor', () => {
		it('download-app exits 1 with the editor message when no editor can be told', async () => {
			seed();
			const r = await run('download-app', ARGS['download-app'], { env: {} });
			assert.equal(r.code, 1);
			assert.match(r.stderr, /^ERROR: Cannot tell which editor runs this script/);
			assert.equal(requests.length, 0);
		});

		it('test-component exits 1 with the editor message when no editor can be told', async () => {
			seed();
			const r = await run('test-component', ARGS['test-component'], { env: {} });
			assert.equal(r.code, 1);
			assert.match(r.stderr, /ERROR: Cannot tell which editor runs this script/);
		});
	});

	describe('Cursor credentials', () => {
		for (const name of ['download-app', 'test-component']) {
			it(`${name} with --editor cursor and no Cursor settings file stops at the Cursor message, before the account check`, async () => {
				seed({ jira: false });
				const r = await run(name, ['--editor', 'cursor', ...ARGS[name]], { env: {} });
				assert.equal(r.code, 1, r.stdout + r.stderr);
				assert.ok(r.stderr.includes('Cursor settings file not found'), r.stderr);
				assert.doesNotMatch(r.stderr, /Jira|make-apps-mockup/);
				assert.equal(requests.length, 0);
			});
		}
	});

	describe('the contexts folder', () => {
		const contexts = () => path.join(home, '.make-custom-app', 'contexts');

		it('download-app saves under ~/.make-custom-app/contexts', async () => {
			seed();
			mode = 'app';
			const r = await run('download-app', ARGS['download-app']);
			assert.equal(r.code, 0, r.stdout + r.stderr);
			assert.ok(r.stdout.includes(`Output: ${path.join(contexts(), 'my-app-v1')}`), r.stdout + r.stderr);
			assert.ok(fs.existsSync(path.join(contexts(), 'my-app-v1', 'metadata.json')));
		});

		it('download-app writes no folder when the app cannot be read', async () => {
			seed();
			mode = '404';
			const r = await run('download-app', ARGS['download-app']);
			assert.equal(r.code, 1, r.stdout + r.stderr);
			assert.ok(r.stdout.includes('✗ app my-app v1 (HTTP 404)'), r.stdout);
			assert.ok(!fs.existsSync(path.join(contexts(), 'my-app-v1')));
		});

		it('review-changes saves its review under ~/.make-custom-app/contexts', async () => {
			seed();
			mode = '404';
			const r = await run('review-changes', ARGS['review-changes']);
			assert.equal(r.code, 0, r.stdout + r.stderr);
			assert.ok(fs.existsSync(path.join(contexts(), 'my-app-v1', 'reviews', 'latest.json')));
		});

		it('test-function looks for the downloaded functions there', async () => {
			seed();
			const r = await run('test-function', ARGS['test-function']);
			assert.equal(r.code, 1);
			assert.ok(r.stderr.includes(`Functions directory not found: ${path.join(contexts(), 'my-app-v1', 'functions')}`), r.stderr);
		});

		it('no script creates a folder of the old layout in HOME', async () => {
			seed();
			mode = 'app';
			await run('download-app', ARGS['download-app']);
			mode = '404';
			await run('review-changes', ARGS['review-changes']);
			assert.deepEqual(fs.readdirSync(home).sort(), ['.make-custom-app', '.make-custom-app-skill-secrets']);
		});
	});
});
