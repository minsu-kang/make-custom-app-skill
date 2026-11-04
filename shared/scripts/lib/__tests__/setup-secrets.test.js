/**
 * Tests for the entry script setup-secrets.js in a fake HOME. The wizard needs a terminal, so a child process with
 * a piped stdin only reaches the checks before the first question: the arguments, the editor and the terminal check.
 * The decisions behind the questions are tested in setup-secrets-logic.test.js.
 * Each run gets an explicit environment, with no CLAUDECODE or CURSOR_AGENT unless the test sets one.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPTS_DIR, setupCommand } = require('../paths');
const { USAGE, questionSteps } = require('../setup-secrets-logic');

const SCRIPT = path.join(SCRIPTS_DIR, 'setup-secrets.js');
const NOT_TTY = 'This wizard is interactive and writes secrets. Run it in your own terminal:';

let work;
let home;
let tmp;

before(() => {
	work = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-secrets-test-'));
	home = path.join(work, 'home');
	tmp = path.join(work, 'tmp');
	fs.mkdirSync(home);
	fs.mkdirSync(tmp);
});

after(() => fs.rmSync(work, { recursive: true, force: true }));

/**
 * Runs the script with stdin as a pipe, which is not a terminal. The empty NODE_V8_COVERAGE keeps the entry script out of
 * the coverage table (Node passes the variable on to every child, and the script runs in place): the gate counts the
 * modules in lib/ that the tests load in-process.
 */
function run(args, env = {}) {
	return spawnSync(process.execPath, [SCRIPT, ...args], {
		env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, NODE_V8_COVERAGE: '', ...env },
		encoding: 'utf8',
	});
}

describe('setup-secrets.js without a terminal', () => {
	it('refuses and prints the command to run in a terminal, with the editor', () => {
		const r = run(['--editor', 'claude']);
		assert.equal(r.status, 1);
		assert.equal(r.stdout, '');
		assert.equal(r.stderr, `${NOT_TTY}\n  ${setupCommand('claude')}\n`);
		assert.deepEqual(fs.readdirSync(home), [], 'nothing is written before the terminal check');
	});

	it('names Cursor in the command for --editor=cursor', () => {
		const r = run(['--editor=cursor']);
		assert.equal(r.status, 1);
		assert.equal(r.stderr, `${NOT_TTY}\n  ${setupCommand('cursor')}\n`);
	});

	it('takes the editor from the environment when there is no flag', () => {
		assert.equal(run([], { CLAUDECODE: '1' }).stderr, `${NOT_TTY}\n  ${setupCommand('claude')}\n`);
		assert.equal(run([], { CURSOR_AGENT: '1' }).stderr, `${NOT_TTY}\n  ${setupCommand('cursor')}\n`);
	});

	it('lets the flag win over the environment', () => {
		assert.equal(run(['--editor', 'cursor'], { CLAUDECODE: '1' }).stderr, `${NOT_TTY}\n  ${setupCommand('cursor')}\n`);
	});
});

describe('setup-secrets.js editor and arguments', () => {
	it('checks the editor before the terminal, so a bad value is reported as the bad value', () => {
		const r = run(['--editor', 'vscode']);
		assert.equal(r.status, 1);
		assert.equal(r.stdout, '');
		assert.equal(r.stderr, 'ERROR: Invalid editor "vscode" from --editor flag. Use claude or cursor.\n');
	});

	it('fails with the editor message when nothing says which editor', () => {
		const r = run([]);
		assert.equal(r.status, 1);
		assert.equal(r.stdout, '');
		assert.match(r.stderr, /^ERROR: Cannot tell which editor runs this script \(CLAUDECODE and CURSOR_AGENT are both unset\)/);
		assert.match(r.stderr, /pass --editor claude\|cursor\.\n$/);
		assert.doesNotMatch(r.stderr, /interactive/);
	});

	it('prints the usage for a missing value and for an unknown argument', () => {
		const missing = run(['--editor']);
		assert.equal(missing.status, 1);
		assert.equal(missing.stderr, `ERROR: --editor needs a value: claude or cursor.\n${USAGE}\n`);
		const unknown = run(['--bogus']);
		assert.equal(unknown.status, 1);
		assert.equal(unknown.stderr, `ERROR: Unknown argument: --bogus\n${USAGE}\n`);
	});
});

describe('setup-secrets.js wiring', () => {
	it('loads only the library modules of the plugin layout, so it cannot call a guard', () => {
		const source = fs.readFileSync(SCRIPT, 'utf8');
		const modules = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
		assert.deepEqual(
			modules.filter((m) => m.startsWith('./')).sort(),
			[
				'./lib/access-guard-logic',
				'./lib/jira-myself',
				'./lib/mode',
				'./lib/paths',
				'./lib/run-component-logic',
				'./lib/secrets-file',
				'./lib/settings',
				'./lib/setup-secrets-logic',
			],
		);
		assert.doesNotMatch(source, /ensureInternalUser|requireMode/);
	});

	it('checks the token with detectZone and detectMode, and writes nothing before the mode check', () => {
		const source = fs.readFileSync(SCRIPT, 'utf8');
		assert.match(source, /zoneOutcome\(await detectZone\(apikey\), savedHost\)/);
		assert.match(source, /modeOutcome\(await detectMode\(target\.host, target\.apikey\), target\.host, editor, \{ zoneChosen: target\.zoneChosen \}\)/);
		assert.match(source, /if \(zone\.stop\) stop\(zone\.lines\);/);
		const stopAt = source.indexOf('if (checked.stop) stop(checked.lines);');
		assert.ok(stopAt > 0);
		assert.ok(stopAt < source.indexOf('upsertSecretsFile(SECRETS_PATH, buildSecretsUpdates('));
		assert.ok(source.indexOf('upsertSecretsFile(SECRETS_PATH, buildSecretsUpdates(') < source.indexOf('saveVerdict(target.host, target.apikey, checked.mode);'));
	});

	it('asks each question of questionSteps through one map, so the logic decides the order', () => {
		const source = fs.readFileSync(SCRIPT, 'utf8');
		assert.match(source, /for \(const step of questionSteps\(checked\.mode\)\) Object\.assign\(answers, await QUESTIONS\[step\]\(\)\);/);
		for (const step of questionSteps('employee')) assert.ok(source.includes(`'${step}': ask`), step);
	});

	it('never writes make-api-url and has no built-in zone or admin URL', () => {
		for (const file of [SCRIPT, path.join(SCRIPTS_DIR, 'lib', 'setup-secrets-logic.js')]) {
			const source = fs.readFileSync(file, 'utf8');
			assert.ok(!source.includes("'make-api-url'"), file);
			assert.doesNotMatch(source, /DEFAULT_MAKE_API_URL|\/api\/v2\/admin|eu1\.make\.com/, file);
		}
	});

	it('prints the follow-up command through the shared quoting, not by hand', () => {
		const source = fs.readFileSync(SCRIPT, 'utf8');
		assert.match(source, /nextStepLines\(SCRIPTS_DIR\)/);
		assert.doesNotMatch(source, /node \$\{/);
	});

	it('no longer writes mcp-server/.env or runs npm run register', () => {
		const source = fs.readFileSync(SCRIPT, 'utf8');
		assert.doesNotMatch(source, /upsertEnvFile|mcp-server|npm run register|\.env['"`]/);
		for (const key of ['pinecone-api-key', 'pinecone-index-name', 'openai-api-key']) assert.ok(source.includes(`'${key}'`), key);
	});
});

/**
 * The proxy rerun (spec B 11.6) happens before the argument and terminal checks, so a child with a piped stdin shows it.
 * A preload (NODE_OPTIONS=--require, written by this file) records every Node start of the run with its
 * NODE_USE_ENV_PROXY; the wizard itself prints nothing about the rerun. Both proxy URLs point at a closed local port, so
 * nothing could leave the machine even if a call were made.
 */
describe('setup-secrets.js behind a proxy', () => {
	let closed;
	let preload;
	let runs = 0;

	before(async () => {
		const server = net.createServer();
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		closed = `http://127.0.0.1:${server.address().port}`;
		await new Promise((resolve) => server.close(resolve));
		preload = path.join(work, 'record-start.js');
		fs.writeFileSync(preload, "require('fs').appendFileSync(process.env.SETUP_TEST_STARTS, `${process.env.NODE_USE_ENV_PROXY || '-'}\\n`);\n");
	});

	/** run() plus the NODE_USE_ENV_PROXY value of each Node start, in order ('-' when unset). */
	function runRecorded(args, env) {
		const startsFile = path.join(work, `starts-${++runs}.txt`);
		const r = run(args, { NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, SETUP_TEST_STARTS: startsFile, MAKE_CUSTOM_APP_TEST_API_ORIGIN: closed, ...env });
		return { ...r, starts: fs.readFileSync(startsFile, 'utf8').trim().split('\n') };
	}

	const notTtyEnd = (editor) => `${NOT_TTY}\n  ${setupCommand(editor)}\n`;
	const count = (text, part) => text.split(part).length - 1;

	it('runs itself once more with NODE_USE_ENV_PROXY=1 when an http(s) proxy is set, and the rerun does the rest', () => {
		const r = runRecorded(['--editor', 'claude'], { HTTPS_PROXY: closed });
		assert.deepEqual(r.starts, ['-', '1']);
		assert.equal(r.status, 1);
		assert.equal(r.stdout, '');
		assert.equal(count(r.stderr, NOT_TTY), 1, r.stderr);
		assert.ok(r.stderr.endsWith(notTtyEnd('claude')), r.stderr);
		assert.deepEqual(fs.readdirSync(home), [], 'nothing is written');
	});

	it('reruns before the argument check, so the usage error is printed once, by the rerun', () => {
		const r = runRecorded(['--bogus'], { http_proxy: closed });
		assert.deepEqual(r.starts, ['-', '1']);
		assert.equal(r.status, 1);
		assert.equal(count(r.stderr, `ERROR: Unknown argument: --bogus\n${USAGE}\n`), 1, r.stderr);
	});

	it('does not rerun when NODE_USE_ENV_PROXY is already set, so the rerun cannot loop', () => {
		const r = runRecorded(['--editor', 'cursor'], { HTTPS_PROXY: closed, NODE_USE_ENV_PROXY: '1' });
		assert.deepEqual(r.starts, ['1']);
		assert.ok(r.stderr.endsWith(notTtyEnd('cursor')), r.stderr);
	});

	it('does not rerun without a proxy, or with a proxy value that is not http(s)', () => {
		const plain = runRecorded(['--editor', 'claude'], {});
		assert.deepEqual(plain.starts, ['-']);
		assert.equal(plain.stderr, notTtyEnd('claude'));
		assert.deepEqual(runRecorded(['--editor', 'claude'], { HTTPS_PROXY: 'socks5://127.0.0.1:1080' }).starts, ['-']);
	});
});
