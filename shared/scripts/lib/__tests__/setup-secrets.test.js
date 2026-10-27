/**
 * Tests for the entry script setup-secrets.js in a fake HOME. The wizard needs a terminal, so a child process with
 * a piped stdin only reaches the checks before the first question: the arguments, the editor and the terminal check.
 * The decisions behind the questions are tested in setup-secrets-logic.test.js.
 * Each run gets an explicit environment, with no CLAUDECODE or CURSOR_AGENT unless the test sets one.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPTS_DIR, setupCommand } = require('../paths');
const { USAGE } = require('../setup-secrets-logic');

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
				'./lib/paths',
				'./lib/run-component-logic',
				'./lib/secrets-file',
				'./lib/settings',
				'./lib/setup-secrets-logic',
			],
		);
		assert.doesNotMatch(source, /ensureInternalUser/);
	});

	it('no longer writes mcp-server/.env or runs npm run register', () => {
		const source = fs.readFileSync(SCRIPT, 'utf8');
		assert.doesNotMatch(source, /upsertEnvFile|mcp-server|npm run register|\.env['"`]/);
		for (const key of ['pinecone-api-key', 'pinecone-index-name', 'openai-api-key']) assert.ok(source.includes(`'${key}'`), key);
	});
});
