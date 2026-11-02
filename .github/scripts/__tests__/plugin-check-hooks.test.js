'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'plugin-check.js');
const REPO = path.join(__dirname, '..', '..', '..');

const CLAUDE = {
	name: 'make-custom-app',
	description: 'One sentence.',
	version: '3.0.0',
	author: { name: 'someone' },
	mcpServers: './mcp.json',
};
const CURSOR = { ...CLAUDE, displayName: 'Make Custom App', rules: './plugin-rules/', hooks: './hooks/hooks-cursor.json' };
delete CURSOR.mcpServers;
const HOOKS = { version: 1, hooks: { sessionStart: [{ command: 'node ./hooks/session-start.js' }] } };
const CHANGELOG = '# Changelog\n\n## 3.0.0 (unreleased)\n\nText.\n';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const copy = (value) => JSON.parse(JSON.stringify(value));

/** The files of a good repository; `change` edits copies of the Cursor manifest and the hooks file. */
function good(change = () => {}) {
	const cursor = copy(CURSOR);
	const hooks = copy(HOOKS);
	change(cursor, hooks);
	return {
		'.claude-plugin/plugin.json': json(CLAUDE),
		'.cursor-plugin/plugin.json': json(cursor),
		'plugin-rules/.gitkeep': '',
		'CHANGELOG.md': CHANGELOG,
		'hooks/hooks-cursor.json': json(hooks),
		'hooks/session-start.js': "'use strict';\n",
	};
}

function run(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-hooks-'));
	try {
		for (const [rel, body] of Object.entries(files)) {
			const abs = path.join(root, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, body);
		}
		const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
		return { status: r.status, out: r.stdout, err: r.stderr };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test('a Cursor manifest with a good hooks file and script passes', () => {
	const r = run(good());
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /0 error\(s\)/);
});

test('the hooks of this repository pass', () => {
	const files = good();
	for (const rel of ['.claude-plugin/plugin.json', '.cursor-plugin/plugin.json', 'CHANGELOG.md']) {
		files[rel] = fs.readFileSync(path.join(REPO, rel), 'utf8');
	}
	for (const name of fs.readdirSync(path.join(REPO, 'hooks'))) files[`hooks/${name}`] = fs.readFileSync(path.join(REPO, 'hooks', name), 'utf8');
	const r = run(files);
	assert.equal(r.status, 0, r.out);
	assert.equal(r.err, '');
});

test('a manifest without a hooks field needs no hooks folder', () => {
	const files = good((cursor) => delete cursor.hooks);
	delete files['hooks/hooks-cursor.json'];
	delete files['hooks/session-start.js'];
	assert.equal(run(files).status, 0);
});

test('hooks/hooks-cursor.json without a hooks field is an error', () => {
	const r = run(good((cursor) => delete cursor.hooks));
	assert.equal(r.status, 1);
	assert.match(r.out, /ERROR \.cursor-plugin\/plugin\.json: hooks\/hooks-cursor\.json exists but "hooks" is not set; add "hooks": "\.\/hooks\/hooks-cursor\.json"/);
});

test('the hooks field must be a relative ./hooks/ path', () => {
	for (const value of ['hooks/hooks-cursor.json', '/hooks/hooks-cursor.json', './other/hooks-cursor.json', './hooks/../hooks.json', './hooks', 7, ['./hooks/hooks-cursor.json'], null]) {
		const r = run(good((cursor) => (cursor.hooks = value)));
		assert.equal(r.status, 1, String(value));
		assert.match(r.out, /\.cursor-plugin\/plugin\.json: hooks must be a relative path to a file in hooks\/ that starts with "\.\/hooks\/"/, String(value));
	}
});

test('the hooks file must exist and be a file', () => {
	const missing = good();
	delete missing['hooks/hooks-cursor.json'];
	assert.match(run(missing).out, /\.cursor-plugin\/plugin\.json: hooks points at hooks\/hooks-cursor\.json, which does not exist/);
	const folder = good();
	delete folder['hooks/hooks-cursor.json'];
	folder['hooks/hooks-cursor.json/x'] = '';
	assert.match(run(folder).out, /hooks points at hooks\/hooks-cursor\.json, which is not a file/);
});

test('the hooks file must be a JSON object', () => {
	assert.match(run({ ...good(), 'hooks/hooks-cursor.json': '{ nope' }).out, /hooks\/hooks-cursor\.json: is not valid JSON/);
	assert.match(run({ ...good(), 'hooks/hooks-cursor.json': '[]' }).out, /hooks\/hooks-cursor\.json: must be a JSON object/);
});

test('the hooks file must have "version": 1', () => {
	for (const value of [2, '1', undefined]) {
		const r = run(good((cursor, hooks) => (hooks.version = value)));
		assert.equal(r.status, 1, String(value));
		assert.match(r.out, /hooks\/hooks-cursor\.json: version must be 1 \(the Cursor hooks format\)/, String(value));
	}
});

test('hooks.sessionStart must be a non-empty array', () => {
	const shapes = [(hooks) => (hooks.hooks.sessionStart = []), (hooks) => (hooks.hooks.sessionStart = {}), (hooks) => delete hooks.hooks.sessionStart, (hooks) => delete hooks.hooks, (hooks) => (hooks.hooks = [])];
	for (const shape of shapes) {
		const r = run(good((cursor, hooks) => shape(hooks)));
		assert.equal(r.status, 1, String(shape));
		assert.match(r.out, /hooks\/hooks-cursor\.json: hooks\.sessionStart must be a non-empty array/, String(shape));
	}
});

test('every sessionStart entry needs a command string', () => {
	for (const entry of [{}, { command: 7 }, { command: ' ' }, 'node x.js', null]) {
		const r = run(good((cursor, hooks) => (hooks.hooks.sessionStart = [{ command: 'node ./hooks/session-start.js' }, entry])));
		assert.equal(r.status, 1, JSON.stringify(entry));
		assert.match(r.out, /hooks\/hooks-cursor\.json: hooks\.sessionStart\[1\] has no command string/, JSON.stringify(entry));
	}
});

test('a command that names a missing script in hooks/ is an error', () => {
	const files = good();
	delete files['hooks/session-start.js'];
	const r = run(files);
	assert.equal(r.status, 1);
	assert.match(r.out, /hooks\/hooks-cursor\.json: hooks\.sessionStart\[0\] names hooks\/session-start\.js, which does not exist/);
	const second = run(good((cursor, hooks) => hooks.hooks.sessionStart.push({ command: 'node ./hooks/other.js --flag' })));
	assert.match(second.out, /hooks\.sessionStart\[1\] names hooks\/other\.js, which does not exist/);
	assert.doesNotMatch(second.out, /session-start\.js/);
});

test('a command must name a ./hooks/<name> script', () => {
	for (const command of ['echo hi', 'node ./hook/session-start.js', 'node hooks/session-start.js', 'node hooks/nope.js']) {
		const r = run(good((cursor, hooks) => (hooks.hooks.sessionStart = [{ command }])));
		assert.equal(r.status, 1, command);
		assert.match(r.out, /hooks\/hooks-cursor\.json: hooks\.sessionStart\[0\] names no script in hooks\/ \(a command must run a \.\/hooks\/<name> script\)/, command);
	}
});

test('a script path that is a folder is an error', () => {
	const files = { ...good((cursor, hooks) => (hooks.hooks.sessionStart = [{ command: 'node ./hooks/sub' }])), 'hooks/sub/x.js': "'use strict';\n" };
	const r = run(files);
	assert.equal(r.status, 1);
	assert.match(r.out, /hooks\/hooks-cursor\.json: hooks\.sessionStart\[0\] names hooks\/sub, which is not a file/);
});

test('hooks/hooks.json must not exist, with or without a hooks field', () => {
	const claudeFormat = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node' }] }] } };
	const withField = run({ ...good(), 'hooks/hooks.json': json(claudeFormat) });
	assert.equal(withField.status, 1);
	assert.match(withField.out, /ERROR hooks\/hooks\.json: must not exist: Claude Code would run it in every session and add the hook text to each one; the hook is registered for Cursor only, through the "hooks" field of \.cursor-plugin\/plugin\.json \(spec 5\)/);
	const files = good((cursor) => delete cursor.hooks);
	delete files['hooks/hooks-cursor.json'];
	assert.match(run({ ...files, 'hooks/hooks.json': '{}\n' }).out, /ERROR hooks\/hooks\.json: must not exist/);
});

test('a missing or broken Cursor manifest is left to the manifest check', () => {
	const missing = good();
	delete missing['.cursor-plugin/plugin.json'];
	const r = run(missing);
	assert.equal(r.out.match(/\.cursor-plugin\/plugin\.json: file is missing or unreadable/g).length, 1);
	const broken = run({ ...good(), '.cursor-plugin/plugin.json': '{ nope' });
	assert.equal(broken.out.match(/\.cursor-plugin\/plugin\.json: is not valid JSON/g).length, 1);
	assert.doesNotMatch(broken.out, /hooks/);
	assert.equal(run({ ...good(), '.cursor-plugin/plugin.json': '[]' }).out.match(/\.cursor-plugin\/plugin\.json: must be a JSON object/g).length, 1);
});

test('a scoped run skips the hooks check', () => {
	const files = { ...good(), 'hooks/hooks.json': '{}\n' };
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-hooks-'));
	try {
		for (const [rel, body] of Object.entries(files)) {
			const abs = path.join(root, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, body);
		}
		fs.mkdirSync(path.join(root, 'shared'));
		const r = spawnSync(process.execPath, [SCRIPT, root, '--scope=shared'], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
		assert.equal(r.status, 0, r.stdout);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('the hook scripts must pass node --check', () => {
	const r = run({ ...good(), 'hooks/bad.js': 'const = ;\n' });
	assert.equal(r.status, 1);
	assert.match(r.out, /ERROR hooks\/bad\.js: syntax check failed/);
});
