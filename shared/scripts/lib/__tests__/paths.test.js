const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
	SCRIPTS_DIR,
	PLUGIN_ROOT,
	EditorError,
	getContextsDir,
	getSnapshotsDir,
	resolveEditor,
	setupCommand,
	scriptCommand,
	takeEditorFlag,
	getEditorFlag,
	resetEditorFlag,
} = require('../paths');

beforeEach(() => resetEditorFlag());

test('SCRIPTS_DIR and PLUGIN_ROOT follow the shared/scripts layout', () => {
	assert.equal(path.basename(SCRIPTS_DIR), 'scripts');
	assert.equal(path.basename(path.dirname(SCRIPTS_DIR)), 'shared');
	assert.equal(PLUGIN_ROOT, path.dirname(path.dirname(SCRIPTS_DIR)));
});

test('getContextsDir is the editor-neutral folder under the given home', () => {
	assert.equal(getContextsDir('/home/u'), path.join('/home/u', '.make-custom-app', 'contexts'));
});

test('getSnapshotsDir is the snapshots folder next to the contexts', () => {
	assert.equal(getSnapshotsDir('/home/u'), path.join('/home/u', '.make-custom-app', 'snapshots'));
	assert.equal(getSnapshotsDir(), path.join(os.homedir(), '.make-custom-app', 'snapshots'));
});

const CONTEXT_CASES = JSON.parse(
	fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'mcp-server', 'lib', '__tests__', 'fixtures', 'contexts-dir-cases.json'), 'utf8'),
);

for (const c of CONTEXT_CASES.filter((entry) => entry.plugin)) {
	test(`getContextsDir agrees with mcp-server/lib/chunker.ts: ${c.name}`, () => {
		assert.equal(getContextsDir(c.home), path.join(c.home, ...c.expected));
	});
}

const MATRIX = [
	{ name: 'neither variable set', env: {}, expected: null },
	{ name: 'CLAUDE_CONFIG_DIR alone does not identify the editor', env: { CLAUDE_CONFIG_DIR: '/tmp/cfg' }, expected: null },
	{ name: 'CLAUDECODE only', env: { CLAUDECODE: '1' }, expected: 'claude' },
	{ name: 'CURSOR_AGENT only', env: { CURSOR_AGENT: '1' }, expected: 'cursor' },
	{ name: 'both set: Claude Code wins', env: { CLAUDECODE: '1', CURSOR_AGENT: '1' }, expected: 'claude' },
	{ name: 'configured line is used when no variable is set', env: {}, configured: 'cursor', expected: 'cursor' },
	{ name: 'CLAUDECODE beats the configured line', env: { CLAUDECODE: '1' }, configured: 'cursor', expected: 'claude' },
	{ name: 'CURSOR_AGENT beats the configured line', env: { CURSOR_AGENT: '1' }, configured: 'claude', expected: 'cursor' },
	{ name: 'flag beats environment and configured line', env: { CLAUDECODE: '1' }, configured: 'claude', flag: 'cursor', expected: 'cursor' },
	{ name: 'invalid configured value is ignored when the environment decides', env: { CLAUDECODE: '1' }, configured: 'zed', expected: 'claude' },
	{ name: 'empty configured value is ignored', env: { CURSOR_AGENT: '1' }, configured: '', expected: 'cursor' },
	{ name: 'invalid configured value is ignored when the flag decides', env: {}, configured: 'zed', flag: 'cursor', expected: 'cursor' },
];

for (const row of MATRIX) {
	test(`resolveEditor: ${row.name}`, () => {
		const input = { env: row.env, configured: row.configured ?? null, flag: row.flag ?? null };
		if (row.expected === null) {
			assert.throws(() => resolveEditor(input), (err) => err instanceof EditorError && err.code === 'EDITOR_UNRESOLVED');
		} else {
			assert.equal(resolveEditor(input), row.expected);
		}
	});
}

test('resolveEditor rejects an unknown editor name and names the source', () => {
	assert.throws(() => resolveEditor({ env: {}, flag: 'vscode' }), /Invalid editor "vscode" from --editor flag/);
	assert.throws(() => resolveEditor({ env: {}, configured: 'zed' }), /Invalid editor "zed" from editor: line/);
});

test('resolveEditor still rejects an invalid flag when an environment variable is set', () => {
	for (const env of [{ CLAUDECODE: '1' }, { CURSOR_AGENT: '1' }]) {
		assert.throws(() => resolveEditor({ env, flag: 'zed' }), (err) => err instanceof EditorError && err.message === 'Invalid editor "zed" from --editor flag. Use claude or cursor.');
	}
});

test('resolveEditor throws for an invalid configured value when nothing else decides', () => {
	assert.throws(
		() => resolveEditor({ env: {}, configured: 'zed' }),
		(err) => err instanceof EditorError && err.message === 'Invalid editor "zed" from editor: line in the secrets file. Use claude or cursor.',
	);
});

test('the unresolved message says how to fix it', () => {
	assert.throws(() => resolveEditor({ env: {} }), /editor: claude.*--editor claude\|cursor/s);
});

test('setupCommand quotes the script path', () => {
	const script = path.join(SCRIPTS_DIR, 'setup-secrets.js');
	assert.equal(setupCommand(), `node "${script}"`);
	assert.equal(setupCommand('cursor'), `node "${script}" --editor cursor`);
});

test('setupCommand keeps a path with spaces in one argument', () => {
	const dir = '/home/First Last/plugin/shared/scripts';
	assert.equal(setupCommand('claude', dir), `node "${path.join(dir, 'setup-secrets.js')}" --editor claude`);
	assert.equal(setupCommand(undefined, dir), `node "${path.join(dir, 'setup-secrets.js')}"`);
});

test('setupCommand escapes an embedded double quote', () => {
	const dir = path.join('/home', 'say "hi"', 'scripts');
	assert.equal(
		setupCommand('cursor', dir),
		`node "${path.join('/home', 'say \\"hi\\"', 'scripts', 'setup-secrets.js')}" --editor cursor`,
	);
});

test('scriptCommand quotes the path and keeps a path with spaces', () => {
	assert.equal(scriptCommand('check-setup.js'), `node "${path.join(SCRIPTS_DIR, 'check-setup.js')}"`);
	const dir = '/home/First Last/plugin/shared/scripts';
	assert.equal(scriptCommand('check-setup.js', dir), `node "${path.join(dir, 'check-setup.js')}"`);
});

test('scriptCommand escapes an embedded double quote', () => {
	const dir = path.join('/home', 'say "hi"', 'scripts');
	assert.equal(scriptCommand('check-setup.js', dir), `node "${path.join('/home', 'say \\"hi\\"', 'scripts', 'check-setup.js')}"`);
});

test('takeEditorFlag removes the two-token form', () => {
	const argv = ['--editor', 'claude'];
	assert.equal(takeEditorFlag(argv), 'claude');
	assert.deepEqual(argv, []);
});

test('takeEditorFlag removes the equals form', () => {
	const argv = ['--editor=cursor'];
	assert.equal(takeEditorFlag(argv), 'cursor');
	assert.deepEqual(argv, []);
});

test('takeEditorFlag keeps other arguments in order', () => {
	const argv = ['node', 'script.js', '--editor', 'claude', 'my-app', '1', '--editor=cursor', 'module', '--force'];
	assert.equal(takeEditorFlag(argv), 'cursor');
	assert.deepEqual(argv, ['node', 'script.js', 'my-app', '1', 'module', '--force']);
});

test('takeEditorFlag returns null and leaves argv alone without the flag', () => {
	const argv = ['node', 'script.js', 'my-app', '--editors', '--editor-x=1', 'claude'];
	const before = [...argv];
	assert.equal(takeEditorFlag(argv), null);
	assert.deepEqual(argv, before);
	assert.equal(getEditorFlag(), null);
});

test('takeEditorFlag throws when the value is missing', () => {
	const message = '--editor needs a value: claude or cursor.';
	for (const argv of [['--editor'], ['my-app', '--editor'], ['--editor', '--json'], ['--editor', '--x', 'claude'], ['--editor='], ['--editor', '']]) {
		assert.throws(
			() => takeEditorFlag(argv),
			(err) => err instanceof EditorError && err.code === 'EDITOR_UNRESOLVED' && err.message === message,
			JSON.stringify(argv),
		);
	}
});

test('takeEditorFlag remembers the last value', () => {
	assert.equal(getEditorFlag(), null);
	takeEditorFlag(['--editor', 'claude', '--editor=cursor']);
	assert.equal(getEditorFlag(), 'cursor');
	takeEditorFlag(['--editor=claude']);
	assert.equal(getEditorFlag(), 'claude');
	resetEditorFlag();
	assert.equal(getEditorFlag(), null);
});

test('takeEditorFlag does not validate the value', () => {
	const argv = ['--editor', 'zed'];
	assert.equal(takeEditorFlag(argv), 'zed');
	assert.deepEqual(argv, []);
});

test('takeEditorFlag keeps the remembered value when a later call finds no flag', () => {
	takeEditorFlag(['--editor', 'cursor']);
	assert.equal(takeEditorFlag(['my-app']), null);
	assert.equal(getEditorFlag(), 'cursor');
});
