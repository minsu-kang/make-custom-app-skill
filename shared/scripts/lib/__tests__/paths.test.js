const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SCRIPTS_DIR, PLUGIN_ROOT, EditorError, getContextsDir, resolveEditor, setupCommand } = require('../paths');

test('SCRIPTS_DIR and PLUGIN_ROOT follow the shared/scripts layout', () => {
	assert.equal(path.basename(SCRIPTS_DIR), 'scripts');
	assert.equal(path.basename(path.dirname(SCRIPTS_DIR)), 'shared');
	assert.equal(PLUGIN_ROOT, path.dirname(path.dirname(SCRIPTS_DIR)));
});

test('getContextsDir is the editor-neutral folder under the given home', () => {
	assert.equal(getContextsDir('/home/u'), path.join('/home/u', '.make-custom-app', 'contexts'));
});

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

test('resolveEditor throws for an invalid configured value when nothing else decides', () => {
	assert.throws(
		() => resolveEditor({ env: {}, configured: 'zed' }),
		(err) => err instanceof EditorError && err.message === 'Invalid editor "zed" from editor: line in the secrets file. Use claude or cursor.',
	);
});

test('the unresolved message says how to fix it', () => {
	assert.throws(() => resolveEditor({ env: {} }), /editor: claude.*--editor claude\|cursor/s);
});

test('setupCommand points at setup-secrets.js in this scripts folder', () => {
	assert.equal(setupCommand(), `node ${path.join(SCRIPTS_DIR, 'setup-secrets.js')}`);
	assert.equal(setupCommand('cursor'), `node ${path.join(SCRIPTS_DIR, 'setup-secrets.js')} --editor cursor`);
});
