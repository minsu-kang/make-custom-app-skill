'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const REAL_HOME = os.homedir();
const TEST_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p5-tools-')));
for (const name of ['home', 'tmp', 'claude-config']) fs.mkdirSync(path.join(TEST_ROOT, name));
process.env.HOME = process.env.USERPROFILE = path.join(TEST_ROOT, 'home');
process.env.TMPDIR = process.env.TEMP = process.env.TMP = path.join(TEST_ROOT, 'tmp');
process.env.CLAUDE_CONFIG_DIR = path.join(TEST_ROOT, 'claude-config');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
	FAKE,
	MARKETPLACE_URL,
	SCENARIOS,
	mayRun,
	snapshotTree,
	snapshotPaths,
	diffSnapshots,
	grepTree,
	buildEnv,
	fakeNamesIn,
	redactFakes,
} = require('../lib/migration-scenario');

const { parseArgs, findClaude, exitCodeFor } = require('../migration-test');

const REPO = path.resolve(__dirname, '..', '..');
const TOOL = path.join(REPO, 'tools', 'migration-test.js');
const CONTAINER_TEXT = "migration-test: run this inside a container or in CI; it needs Claude Code's real layout under a throwaway HOME. See CLAUDE.md for the docker command.";
const NO_CLAUDE_TEXT = 'migration-test: claude was not found (set CLAUDE_BIN or put claude on PATH).';
const IN_CONTAINER = fs.existsSync('/.dockerenv');

process.on('exit', () => {
	fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

let caseCounter = 0;
function caseDir(label) {
	const dir = path.join(TEST_ROOT, `${label}-${++caseCounter}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function put(file, content, mode = 0o644) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	fs.chmodSync(file, mode);
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** The tool under test as a child process with a minimal environment, so nothing of the real home or PATH reaches it. */
function runTool(args, env) {
	const result = spawnSync(process.execPath, [TOOL, ...args], {
		env: { HOME: path.join(TEST_ROOT, 'home'), TMPDIR: path.join(TEST_ROOT, 'tmp'), ...env },
		encoding: 'utf8',
		timeout: 20000,
	});
	assert.equal(result.error, undefined, `the tool did not run: ${result.error && result.error.message}`);
	return result;
}

test('the test process sees a temporary home', () => {
	assert.ok(os.homedir().startsWith(TEST_ROOT));
	assert.ok(os.tmpdir().startsWith(TEST_ROOT));
	assert.notEqual(os.homedir(), REAL_HOME);
	assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(TEST_ROOT));
});

test('the constants name the six scenarios, the marketplace address, and the fake values of the shared test helper', () => {
	assert.deepEqual(SCENARIOS, ['full', 'hand-installed', 'disabled', 'no-claude', 'edited-sentinel', 'rerun-a']);
	assert.equal(MARKETPLACE_URL, 'https://github.com/minsu-kang/make-app-ai-plugin.git');
	assert.deepEqual(Object.keys(FAKE).sort(), ['conflictPinecone', 'cursorToken', 'index', 'openai', 'otherToken', 'pinecone']);
	const helper = fs.readFileSync(path.join(REPO, 'shared', 'scripts', 'lib', '__tests__', 'fake-legacy-home.js'), 'utf8');
	for (const [name, value] of Object.entries(FAKE)) assert.ok(helper.includes(`${name}: '${value}',`), `FAKE.${name} differs from fake-legacy-home.js`);
	for (const name of ['pinecone', 'openai', 'otherToken', 'cursorToken', 'conflictPinecone']) assert.ok(!/^(sk-|pcsk_)/.test(FAKE[name]), `FAKE.${name} must not look like a real key`);
});

test('mayRun: GITHUB_ACTIONS, /.dockerenv, CI alone, neither', () => {
	const calls = [];
	const exists = (file) => {
		calls.push(file);
		return file === '/.dockerenv';
	};
	assert.equal(mayRun({ env: { GITHUB_ACTIONS: 'true' }, exists: () => false }), true);
	assert.equal(mayRun({ env: {}, exists }), true);
	assert.deepEqual(calls, ['/.dockerenv']);
	assert.equal(mayRun({ env: { CI: 'true' }, exists: () => false }), false);
	assert.equal(mayRun({ env: { CI: '1', GITHUB_ACTIONS: 'false' }, exists: () => false }), false);
	assert.equal(mayRun({ env: {}, exists: () => false }), false);
});

test('mayRun needs env and exists', () => {
	assert.throws(() => mayRun({ exists: () => true }), { name: 'TypeError', message: 'mayRun needs env and exists' });
	assert.throws(() => mayRun({ env: {} }), { name: 'TypeError', message: 'mayRun needs env and exists' });
	assert.throws(() => mayRun(), { name: 'TypeError', message: 'mayRun needs env and exists' });
});

test('snapshotTree and diffSnapshots report a content change, a mode change, an added file, and a changed symlink target', () => {
	const root = caseDir('snapshot');
	put(path.join(root, 'a.txt'), 'one');
	put(path.join(root, 'sub', 'b.txt'), 'two', 0o600);
	put(path.join(root, 'skip', 'c.txt'), 'three');
	fs.symlinkSync('a.txt', path.join(root, 'link'));
	const before = snapshotTree(root, { exclude: ['skip'] });
	assert.deepEqual([...before.keys()].sort(), ['a.txt', 'link', 'sub', 'sub/b.txt']);
	assert.deepEqual(before.get('a.txt'), { type: 'file', mode: 0o644, sha256: sha('one'), linkTarget: null });
	assert.deepEqual(before.get('sub/b.txt'), { type: 'file', mode: 0o600, sha256: sha('two'), linkTarget: null });
	assert.equal(before.get('sub').type, 'dir');
	assert.equal(before.get('sub').sha256, null);
	assert.equal(before.get('sub').linkTarget, null);
	assert.deepEqual({ type: before.get('link').type, sha256: before.get('link').sha256, linkTarget: before.get('link').linkTarget }, { type: 'symlink', sha256: null, linkTarget: 'a.txt' });
	assert.deepEqual(diffSnapshots(before, snapshotTree(root, { exclude: ['skip'] })), []);
	assert.equal(snapshotTree(root).has('skip/c.txt'), true);

	fs.writeFileSync(path.join(root, 'a.txt'), 'four');
	fs.chmodSync(path.join(root, 'sub', 'b.txt'), 0o644);
	put(path.join(root, 'new.txt'), 'five');
	fs.unlinkSync(path.join(root, 'link'));
	fs.symlinkSync('sub/b.txt', path.join(root, 'link'));
	assert.deepEqual(diffSnapshots(before, snapshotTree(root, { exclude: ['skip'] })), [
		'changed a.txt: content',
		'changed link: link target',
		'added new.txt',
		'changed sub/b.txt: mode 600 -> 644',
	]);

	fs.rmSync(path.join(root, 'sub'), { recursive: true });
	fs.rmSync(path.join(root, 'new.txt'));
	const after = snapshotTree(root, { exclude: ['skip'] });
	assert.deepEqual(diffSnapshots(before, after), ['changed a.txt: content', 'changed link: link target', 'removed sub', 'removed sub/b.txt']);
	fs.rmSync(path.join(root, 'a.txt'));
	fs.mkdirSync(path.join(root, 'a.txt'));
	fs.chmodSync(path.join(root, 'a.txt'), 0o755);
	assert.ok(diffSnapshots(before, snapshotTree(root, { exclude: ['skip'] })).includes('changed a.txt: type file -> dir, mode 644 -> 755, content'));
});

test('snapshotPaths records the named files and folders with their subtrees, and leaves a missing path out', () => {
	const root = caseDir('paths');
	put(path.join(root, 'a', 'one.txt'), 'one', 0o600);
	put(path.join(root, 'a', 'deep', 'two.txt'), 'two');
	put(path.join(root, 'b', 'three.txt'), 'three');
	put(path.join(root, 'single.json'), '{}', 0o600);
	fs.symlinkSync('single.json', path.join(root, 'link'));
	const snapshot = snapshotPaths(root, ['a', 'single.json', 'link', 'missing/dir', 'b/three.txt']);
	assert.deepEqual([...snapshot.keys()].sort(), ['a', 'a/deep', 'a/deep/two.txt', 'a/one.txt', 'b/three.txt', 'link', 'single.json']);
	assert.deepEqual(snapshot.get('single.json'), { type: 'file', mode: 0o600, sha256: sha('{}'), linkTarget: null });
	assert.equal(snapshot.get('a').type, 'dir');
	assert.equal(snapshot.get('link').linkTarget, 'single.json');
	assert.equal(snapshot.has('b'), false);
	fs.chmodSync(path.join(root, 'a', 'one.txt'), 0o644);
	assert.deepEqual(diffSnapshots(snapshot, snapshotPaths(root, ['a', 'single.json', 'link', 'missing/dir', 'b/three.txt'])), ['changed a/one.txt: mode 600 -> 644']);
	assert.deepEqual([...snapshotPaths(root, []).keys()], []);
	for (const bad of [[''], ['/etc'], ['../x'], ['a/../../x'], [7]]) assert.throws(() => snapshotPaths(root, bad), { name: 'TypeError', message: 'snapshotPaths needs dir and paths' });
	for (const bad of [undefined, '', null]) assert.throws(() => snapshotPaths(bad, ['a']), { name: 'TypeError', message: 'snapshotPaths needs dir and paths' });
	assert.throws(() => snapshotPaths(root), { name: 'TypeError', message: 'snapshotPaths needs dir and paths' });
});

test('diffSnapshots lines never hold file content', () => {
	const root = caseDir('snapshot-content');
	put(path.join(root, 'secret.env'), `KEY=${FAKE.pinecone}`);
	const before = snapshotTree(root);
	put(path.join(root, 'secret.env'), `KEY=${FAKE.conflictPinecone}`);
	const lines = diffSnapshots(before, snapshotTree(root));
	assert.deepEqual(lines, ['changed secret.env: content']);
	assert.deepEqual(fakeNamesIn(lines.join('\n')), []);
});

test('grepTree finds needles and reports relative paths', () => {
	const root = caseDir('grep');
	put(path.join(root, 'a.txt'), 'a line\nNEEDLE-ONE here\n');
	put(path.join(root, 'sub', 'b.bin'), Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from('NEEDLE-TWO'), Buffer.from([0, 7])]));
	put(path.join(root, 'sub', 'deep', 'c.txt'), 'NEEDLE-TWO and NEEDLE-ONE and NEEDLE-ONE again');
	put(path.join(root, 'd.txt'), 'nothing to see');
	put(path.join(root, 'sub.txt'), 'NEEDLE-ONE beside the folder sub');
	fs.symlinkSync('a.txt', path.join(root, 'link'));
	assert.deepEqual(grepTree(root, ['NEEDLE-ONE', 'NEEDLE-TWO']), [
		{ rel: 'a.txt', needle: 'NEEDLE-ONE' },
		{ rel: 'sub.txt', needle: 'NEEDLE-ONE' },
		{ rel: 'sub/b.bin', needle: 'NEEDLE-TWO' },
		{ rel: 'sub/deep/c.txt', needle: 'NEEDLE-ONE' },
		{ rel: 'sub/deep/c.txt', needle: 'NEEDLE-TWO' },
	]);
	assert.deepEqual(grepTree(root, ['NEEDLE-TWO']), [
		{ rel: 'sub/b.bin', needle: 'NEEDLE-TWO' },
		{ rel: 'sub/deep/c.txt', needle: 'NEEDLE-TWO' },
	]);
	assert.deepEqual(grepTree(root, ['NOT THERE']), []);
	assert.deepEqual(grepTree(root, []), []);
});

test('buildEnv has no CLAUDE_CONFIG_DIR, sets HOME and USERPROFILE, puts fakebin first on PATH, and sets CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SSE_PORT, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION, and CLAUDE_PID', () => {
	assert.ok(process.env.CLAUDE_CONFIG_DIR, 'this test needs a process that has CLAUDE_CONFIG_DIR');
	const env = buildEnv({ home: '/h/home', fakebin: '/h/fakebin', claudeDir: '/c/bin', nodeDir: '/n/bin', bare: '/h/bare.git' });
	assert.equal('CLAUDE_CONFIG_DIR' in env, false);
	assert.equal(env.HOME, '/h/home');
	assert.equal(env.USERPROFILE, '/h/home');
	assert.equal(env.PATH.split(path.delimiter)[0], '/h/fakebin');
	for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) assert.ok(name in env, `${name} is not set`);
	assert.deepEqual(env, {
		PATH: ['/h/fakebin', '/c/bin', '/n/bin', '/usr/bin', '/bin'].join(path.delimiter),
		HOME: '/h/home',
		USERPROFILE: '/h/home',
		TMPDIR: path.join('/h/home', 'tmp'),
		GIT_CONFIG_COUNT: '2',
		GIT_CONFIG_KEY_0: 'url./h/bare.git.insteadOf',
		GIT_CONFIG_VALUE_0: 'https://github.com/minsu-kang/make-app-ai-plugin.git',
		GIT_CONFIG_KEY_1: 'url.https://blocked.invalid/.insteadOf',
		GIT_CONFIG_VALUE_1: 'https://github.com/',
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		DISABLE_AUTOUPDATER: '1',
		MAKE_CUSTOM_APP_SKIP_UPDATE_CHECK: '1',
		CLAUDECODE: '1',
		CLAUDE_CODE_ENTRYPOINT: 'cli',
		CLAUDE_CODE_SSE_PORT: '1',
		CLAUDE_CODE_SESSION_ID: '00000000-0000-0000-0000-000000000000',
		CLAUDE_CODE_CHILD_SESSION: '1',
		CLAUDE_PID: '1',
	});
	assert.equal(env.TMPDIR.startsWith(env.HOME), true);
});

test('buildEnv does not copy the environment of the process', () => {
	const before = process.env.MIGRATION_SCENARIO_PROBE;
	process.env.MIGRATION_SCENARIO_PROBE = 'leak';
	try {
		const env = buildEnv({ home: '/h/home', fakebin: '/h/fakebin', claudeDir: '/c/bin', nodeDir: '/n/bin', bare: '/h/bare.git' });
		assert.equal('MIGRATION_SCENARIO_PROBE' in env, false);
		assert.equal('PINECONE_API_KEY' in env, false);
		assert.equal('OPENAI_API_KEY' in env, false);
	} finally {
		if (before === undefined) delete process.env.MIGRATION_SCENARIO_PROBE;
		else process.env.MIGRATION_SCENARIO_PROBE = before;
	}
});

test('the helpers refuse a missing folder, so a default can never reach the real home (Ruling 11)', () => {
	const full = { home: '/h/home', fakebin: '/h/fakebin', claudeDir: '/c/bin', nodeDir: '/n/bin', bare: '/h/bare.git' };
	for (const name of Object.keys(full)) {
		for (const bad of [undefined, '', 7]) {
			assert.throws(() => buildEnv({ ...full, [name]: bad }), { name: 'TypeError', message: 'buildEnv needs home, fakebin, claudeDir, nodeDir, bare' }, name);
		}
	}
	assert.throws(() => buildEnv(), { name: 'TypeError', message: 'buildEnv needs home, fakebin, claudeDir, nodeDir, bare' });
	for (const bad of [undefined, '', null, 7]) {
		assert.throws(() => snapshotTree(bad), { name: 'TypeError', message: 'snapshotTree needs dir' });
		assert.throws(() => grepTree(bad, ['x']), { name: 'TypeError', message: 'grepTree needs dir and needles' });
	}
	assert.throws(() => grepTree(TEST_ROOT), { name: 'TypeError', message: 'grepTree needs dir and needles' });
	assert.throws(() => grepTree(TEST_ROOT, ['']), { name: 'TypeError', message: 'grepTree needs dir and needles' });
	assert.throws(() => grepTree(TEST_ROOT, [7]), { name: 'TypeError', message: 'grepTree needs dir and needles' });
});

test('fakeNamesIn and redactFakes find and hide every secret fake value, and leave the index name alone', () => {
	const text = `a ${FAKE.pinecone} b ${FAKE.openai} c ${FAKE.otherToken} d ${FAKE.cursorToken} e ${FAKE.conflictPinecone} f ${FAKE.index} g ${FAKE.pinecone}`;
	assert.deepEqual(fakeNamesIn(text), ['pinecone', 'openai', 'otherToken', 'cursorToken', 'conflictPinecone']);
	assert.deepEqual(fakeNamesIn(`only the index ${FAKE.index}`), []);
	assert.deepEqual(fakeNamesIn(''), []);
	const redacted = redactFakes(text);
	assert.equal(redacted, `a [pinecone] b [openai] c [otherToken] d [cursorToken] e [conflictPinecone] f ${FAKE.index} g [pinecone]`);
	assert.deepEqual(fakeNamesIn(redacted), []);
	assert.equal(redactFakes('another fake-thing-0042 value'), 'another [fake] value');
});

test('migration-test.js exits 2 with the container text when mayRun is false', { skip: IN_CONTAINER && 'this test runs in a container, where the tool may run' }, () => {
	const result = runTool([], { PATH: path.dirname(process.execPath), CI: 'true' });
	assert.equal(result.status, 2);
	assert.equal(result.stdout, '');
	assert.equal(result.stderr, `${CONTAINER_TEXT}\n`);
});

test('migration-test.js exits 2 before it creates anything when claude is not found', () => {
	const empty = caseDir('empty-path');
	const tmp = caseDir('tool-tmp');
	const result = runTool([], { GITHUB_ACTIONS: 'true', PATH: empty, TMPDIR: tmp });
	assert.equal(result.status, 2);
	assert.equal(result.stdout, '');
	assert.equal(result.stderr, `${NO_CLAUDE_TEXT}\n`);
	assert.deepEqual(fs.readdirSync(tmp), []);
	const named = runTool([], { GITHUB_ACTIONS: 'true', PATH: empty, TMPDIR: tmp, CLAUDE_BIN: path.join(empty, 'claude') });
	assert.equal(named.status, 2);
	assert.equal(named.stderr, `${NO_CLAUDE_TEXT}\n`);
	const plain = caseDir('plain-claude');
	put(path.join(plain, 'claude'), '#!/bin/sh\nexit 0\n', 0o644);
	const notExecutable = runTool([], { GITHUB_ACTIONS: 'true', PATH: plain, TMPDIR: tmp });
	assert.equal(notExecutable.status, 2);
	assert.equal(notExecutable.stderr, `${NO_CLAUDE_TEXT}\n`);
	assert.deepEqual(fs.readdirSync(tmp), []);
});

test('migration-test.js exits 2 for an unknown argument or scenario before it looks for claude', () => {
	const empty = caseDir('empty-path-args');
	const usage = `migration-test: unknown argument or scenario. Usage: node tools/migration-test.js [--keep] [--scenario=<${SCENARIOS.join('|')}>]\n`;
	for (const args of [['--scenario=bogus'], ['--bogus'], ['--scenario'], ['full'], ['--keep', '--scenario='], ['--scenario=full', '--scenario=disabled'], ['--keep', '--scenario=full', 'extra']]) {
		const result = runTool(args, { GITHUB_ACTIONS: 'true', PATH: empty });
		assert.equal(result.status, 2, args.join(' '));
		assert.equal(result.stdout, '');
		assert.equal(result.stderr, usage, args.join(' '));
	}
	for (const args of [['--keep', '--scenario=full'], ['--scenario=rerun-a'], ['--keep'], []]) {
		const known = runTool(args, { GITHUB_ACTIONS: 'true', PATH: empty });
		assert.equal(known.stderr, `${NO_CLAUDE_TEXT}\n`, args.join(' '));
	}
});

test('migration-test.js does not take a relative CLAUDE_BIN, because its children run in another folder', () => {
	const empty = caseDir('relative-bin');
	const tmp = caseDir('relative-tmp');
	put(path.join(empty, 'claude'), '#!/bin/sh\nexit 1\n', 0o755);
	const result = spawnSync(process.execPath, [TOOL], {
		cwd: empty,
		env: { HOME: path.join(TEST_ROOT, 'home'), TMPDIR: tmp, GITHUB_ACTIONS: 'true', PATH: empty, CLAUDE_BIN: './claude' },
		encoding: 'utf8',
		timeout: 20000,
	});
	assert.equal(result.status, 2);
	assert.equal(result.stderr, `${NO_CLAUDE_TEXT}\n`);
	assert.deepEqual(fs.readdirSync(tmp), []);
});

test('exitCodeFor is 0 only when checks ran and none failed', () => {
	assert.equal(exitCodeFor({ passed: 28, failed: 0 }), 0);
	assert.equal(exitCodeFor({ passed: 27, failed: 1 }), 1);
	assert.equal(exitCodeFor({ passed: 0, failed: 1 }), 1);
	assert.equal(exitCodeFor({ passed: 0, failed: 0 }), 1);
});

test('parseArgs reads --keep and one --scenario, and nothing else', () => {
	assert.deepEqual(parseArgs([]), { keep: false, scenarios: SCENARIOS });
	assert.deepEqual(parseArgs(['--keep']), { keep: true, scenarios: SCENARIOS });
	assert.deepEqual(parseArgs(['--scenario=no-claude']), { keep: false, scenarios: ['no-claude'] });
	assert.deepEqual(parseArgs(['--scenario=rerun-a', '--keep']), { keep: true, scenarios: ['rerun-a'] });
	for (const bad of [['--scenario=nope'], ['--scenario'], ['--scenario=full', '--scenario=full'], ['--keep=1'], ['-k'], ['full']]) assert.equal(parseArgs(bad), null, bad.join(' '));
});

test('findClaude takes CLAUDE_BIN when it is set, and else the first claude on the PATH that can run', () => {
	const bin = caseDir('find-bin');
	const other = caseDir('find-other');
	put(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', 0o755);
	put(path.join(other, 'claude'), '#!/bin/sh\nexit 0\n', 0o755);
	const plain = caseDir('find-plain');
	put(path.join(plain, 'claude'), 'text', 0o644);
	assert.equal(findClaude({ PATH: [plain, bin, other].join(path.delimiter) }), path.join(bin, 'claude'));
	assert.equal(findClaude({ PATH: [path.relative(process.cwd(), bin), other].join(path.delimiter) }), path.join(other, 'claude'), 'a relative PATH entry is skipped');
	assert.equal(findClaude({ PATH: path.relative(process.cwd(), bin) }), null);
	assert.equal(findClaude({ PATH: [bin].join(path.delimiter), CLAUDE_BIN: path.join(other, 'claude') }), path.join(other, 'claude'));
	assert.equal(findClaude({ PATH: bin, CLAUDE_BIN: path.join(plain, 'claude') }), null, 'a CLAUDE_BIN that cannot run ends the search');
	assert.equal(findClaude({ PATH: bin, CLAUDE_BIN: 'claude' }), null);
	assert.equal(findClaude({ PATH: plain }), null);
	assert.equal(findClaude({ PATH: '' }), null);
	assert.equal(findClaude({}), null);
	assert.equal(findClaude({ PATH: bin, CLAUDE_BIN: '' }), path.join(bin, 'claude'));
	assert.equal(findClaude({ PATH: caseDir('find-dir') }), null);
	const directory = caseDir('find-directory');
	fs.mkdirSync(path.join(directory, 'claude'), { mode: 0o755 });
	assert.equal(findClaude({ PATH: directory }), null, 'a folder named claude is no binary');
});

test('a CI run alone does not let migration-test.js run', { skip: IN_CONTAINER && 'this test runs in a container, where the tool may run' }, () => {
	const empty = caseDir('ci-only');
	const result = runTool(['--scenario=full'], { CI: 'true', GITHUB_ACTIONS: 'false', PATH: empty });
	assert.equal(result.status, 2);
	assert.equal(result.stderr, `${CONTAINER_TEXT}\n`);
});
