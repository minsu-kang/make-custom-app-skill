/**
 * Tests for the twelve entry scripts in shared/scripts. The first part reads their source: each must run the account
 * check directly, must not name the old layout, and the ones that write to Make must announce their target. The second
 * part runs them as child processes in a fake HOME with an explicit environment, against a local server that stands in
 * for Make (it never answers, or answers 404), so no test reaches a real Make or Jira host. CLAUDECODE is set only where
 * a test says so, because the suite may itself run inside an editor's shell.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { cacheKey, JIRA_BASE_URL } = require('../access-guard-logic');
const { setupCommand } = require('../paths');

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
const MAKE_WRITERS = ['commit-changes', 'create-component', 'delete-component', 'run-component', 'update-app', 'update-component'];
const CONTEXT_READERS = ['download-app', 'download-jira-ticket-attachment', 'review-changes', 'test-function'];
const OLD_LAYOUT = [/version-guard/, /skill-root/, /ensureFreshSkill/, /getSkillRoot/, /getEditorDir/, /SKILL_ROOT/];

// Arguments that get each script past its usage check, so that it reaches the account check.
const ARGS = {
	'commit-changes': ['my-app', '1', 'compile'],
	'create-component': ['my-app', '1', 'function', 'foo'],
	'delete-component': ['my-app', '1', 'function', 'foo', '--force'],
	'download-app': ['my-app', '1'],
	'download-jira-ticket-attachment': ['IEN-1'],
	'post-review-transition': ['IEN-1', 'committed'],
	'review-changes': ['my-app', '1'],
	'run-component': ['my-app', '1', 'endpoint', 'listItems', '--team=7'],
	'test-component': ['my-app', '1', 'module'],
	'test-function': ['my-app', '1'],
	'update-app': ['my-app', '1', 'base', './base.imljson'],
	'update-component': ['my-app', '1', 'module', 'myModule', 'label=x'],
};

const source = (name) => fs.readFileSync(path.join(SCRIPTS, `${name}.js`), 'utf8');
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/.*$/gm;
const TAKE_FLAG = "require('./lib/settings').takeEditorFlagOrExit(process.argv)";

describe('entry script sources', () => {
	for (const name of ENTRY_SCRIPTS) {
		it(`${name} runs the account check and names nothing of the old layout`, () => {
			const text = source(name);
			assert.match(text, /ensureInternalUser\(/, `${name} does not call ensureInternalUser()`);
			for (const re of OLD_LAYOUT) assert.doesNotMatch(text, re, `${name} still mentions ${re.source}`);
		});
	}

	for (const name of ENTRY_SCRIPTS) {
		it(`${name} strips --editor before it reads process.argv for anything else`, () => {
			const code = source(name).replace(COMMENTS, '');
			const call = code.indexOf(TAKE_FLAG);
			assert.ok(call >= 0, `${name} does not call ${TAKE_FLAG}`);
			assert.equal(code.indexOf('process.argv'), call + TAKE_FLAG.indexOf('process.argv'), `${name} reads process.argv before it strips --editor`);
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

describe('entry scripts in a fake HOME', () => {
	let work;
	let home;
	let tmp;
	let mockup;
	let server;
	let port;
	let mode;
	let requests;
	let onRequest;
	let secretsPath;
	let cachePath;

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
		server = http.createServer((req, res) => {
			requests.push(`${req.method} ${req.url}`);
			if (onRequest) onRequest();
			if (mode === 'hang') return;
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end('{}');
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		port = server.address().port;
	});

	after(() => {
		server.closeAllConnections();
		server.close();
		fs.rmSync(work, { recursive: true, force: true });
	});

	/** A fresh HOME: secrets file, access-check cache and an empty contexts folder. Without Jira the guard has nothing to check; without makeKey the Claude Code key is missing. */
	function seed({ jira = true, makeKey = true, extra = '' } = {}) {
		mode = 'hang';
		requests = [];
		onRequest = null;
		fs.rmSync(path.join(home, '.make-custom-app'), { recursive: true, force: true });
		fs.rmSync(cachePath, { force: true });
		const lines = [`make-api-url: http://127.0.0.1:${port}/api/v2/admin`, `make-apps-mockup-path: ${mockup}`];
		if (makeKey) lines.unshift(`make-api-key: ${FAKE_KEY}`);
		if (jira) {
			lines.push(`jira-email: ${EMAIL}`, `jira-api-token: ${TOKEN}`, `jira-base-url: http://127.0.0.1:${port}`);
			const key = cacheKey({ baseUrl: JIRA_BASE_URL, email: EMAIL, token: TOKEN });
			fs.writeFileSync(cachePath, JSON.stringify({ key, email: EMAIL, checkedAt: Date.now() }));
		}
		fs.writeFileSync(secretsPath, `${lines.join('\n')}\n${extra}`, { mode: 0o600 });
	}

	/** Runs one script. `untilRequest` kills it 100 ms after its first request reaches the server, which never answers. */
	function run(name, args, { env = { CLAUDECODE: '1' }, untilRequest = false } = {}) {
		return new Promise((resolve) => {
			const child = spawn(process.execPath, [path.join(SCRIPTS, `${name}.js`), ...args], {
				env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...env },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (c) => (stdout += c));
			child.stderr.on('data', (c) => (stderr += c));
			const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
			if (untilRequest) onRequest = () => setTimeout(() => child.kill('SIGKILL'), 100);
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

	describe('the account check', () => {
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
	 * proves the flag chose the editor. The other three never ask for an editor before their own work, so a marker on stdout
	 * shows that their arguments reached them without the flag.
	 */
	const KEY_STOP = { seed: { makeKey: false } };
	const STOP_AT = {
		'commit-changes': KEY_STOP,
		'create-component': KEY_STOP,
		'delete-component': KEY_STOP,
		'download-app': KEY_STOP,
		'download-jira-ticket-attachment': { marker: 'Fetching attachments for IEN-1...' },
		'post-review-transition': { marker: 'Issue: IEN-1\nDisposition: committed' },
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

	describe('the Cursor key hint', () => {
		it('test-component with --editor cursor and no Cursor settings file points at the mockup .env and the export', async () => {
			seed();
			const r = await run('test-component', ['--editor', 'cursor', ...ARGS['test-component']], { env: {} });
			assert.equal(r.code, 1, r.stdout + r.stderr);
			assert.ok(r.stderr.includes('MAKE_API_KEY not found. Set it in:'), r.stderr);
			assert.ok(r.stderr.includes(`  - ${path.join(mockup, '.env')}`), r.stderr);
			assert.ok(r.stderr.includes('export MAKE_API_KEY=your-api-key'), r.stderr);
			assert.doesNotMatch(r.stderr, /Cursor settings file not found/);
			assert.equal(requests.length, 0);
		});
	});

	describe('the contexts folder', () => {
		const contexts = () => path.join(home, '.make-custom-app', 'contexts');

		it('download-app saves under ~/.make-custom-app/contexts', async () => {
			seed();
			mode = '404';
			const r = await run('download-app', ARGS['download-app']);
			assert.ok(r.stdout.includes(`Output: ${path.join(contexts(), 'my-app-v1')}`), r.stdout + r.stderr);
			assert.ok(fs.existsSync(path.join(contexts(), 'my-app-v1')));
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
			mode = '404';
			await run('download-app', ARGS['download-app']);
			await run('review-changes', ARGS['review-changes']);
			assert.deepEqual(fs.readdirSync(home).sort(), ['.make-custom-app', '.make-custom-app-skill-secrets']);
		});
	});
});
