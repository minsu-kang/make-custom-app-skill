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
const CURSOR = { name: 'make-custom-app', displayName: 'Make Custom App', description: 'One sentence.', version: '3.0.0', author: { name: 'someone' }, rules: './plugin-rules/' };
const CHANGELOG = '# Changelog\n\n## 3.0.0 (unreleased)\n\nText.\n\n## 2.3.13 — 2026-10-27\n\nOld.\n';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** The files of a good repository, with `change` applied to copies of the two manifests. */
function good(change = () => {}) {
	const claude = JSON.parse(JSON.stringify(CLAUDE));
	const cursor = JSON.parse(JSON.stringify(CURSOR));
	change(claude, cursor);
	return {
		'.claude-plugin/plugin.json': json(claude),
		'.cursor-plugin/plugin.json': json(cursor),
		'plugin-rules/.gitkeep': '',
		'CHANGELOG.md': CHANGELOG,
	};
}

function run(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-manifests-'));
	try {
		for (const [rel, body] of Object.entries(files)) {
			const abs = path.join(root, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, body);
		}
		const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
		return { status: r.status, out: r.stdout };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test('good manifests, an empty plugin-rules folder, and an unreleased CHANGELOG entry pass', () => {
	const r = run(good());
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /0 error\(s\)/);
});

test('the real manifests of this repository pass against their own CHANGELOG', () => {
	const files = {
		'.claude-plugin/plugin.json': fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8'),
		'.cursor-plugin/plugin.json': fs.readFileSync(path.join(REPO, '.cursor-plugin', 'plugin.json'), 'utf8'),
		'plugin-rules/.gitkeep': '',
		'CHANGELOG.md': fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8'),
	};
	for (const name of fs.readdirSync(path.join(REPO, 'hooks'))) files[`hooks/${name}`] = fs.readFileSync(path.join(REPO, 'hooks', name), 'utf8');
	const r = run(files);
	assert.equal(r.status, 0, r.out);
});

test('a repository without any manifest folder is not checked for manifests', () => {
	assert.equal(run({}).status, 0);
});

test('one missing manifest and invalid JSON are errors', () => {
	const onlyClaude = good();
	delete onlyClaude['.cursor-plugin/plugin.json'];
	const missing = run(onlyClaude);
	assert.equal(missing.status, 1);
	assert.match(missing.out, /\.cursor-plugin\/plugin\.json: file is missing or unreadable/);
	const broken = run({ ...good(), '.claude-plugin/plugin.json': '{ nope' });
	assert.match(broken.out, /\.claude-plugin\/plugin\.json: is not valid JSON/);
});

test('name, version shape and description are checked in both manifests', () => {
	const r = run(good((claude, cursor) => {
		claude.name = 'other';
		cursor.version = '3.0';
		claude.description = ' ';
		cursor.description = '';
	}));
	assert.equal(r.status, 1);
	assert.match(r.out, /\.claude-plugin\/plugin\.json: name is "other", expected "make-custom-app"/);
	assert.match(r.out, /\.cursor-plugin\/plugin\.json: version "3\.0" is not X\.Y\.Z/);
	assert.match(r.out, /\.claude-plugin\/plugin\.json: description is empty/);
	assert.match(r.out, /\.cursor-plugin\/plugin\.json: description is empty/);
});

test('the two manifests must agree on version, description and author', () => {
	const r = run(good((claude, cursor) => {
		cursor.version = '3.0.1';
		cursor.description = 'Another sentence.';
		cursor.author = { name: 'someone else' };
	}));
	assert.match(r.out, /version 3\.0\.1 differs from 3\.0\.0/);
	assert.match(r.out, /description differs/);
	assert.match(r.out, /author differs/);
});

test('mcpServers and rules must point where the layout says', () => {
	const r = run(good((claude, cursor) => {
		claude.mcpServers = './.mcp.json';
		cursor.rules = './rules/';
	}));
	assert.match(r.out, /mcpServers must be "\.\/mcp\.json"/);
	assert.match(r.out, /rules must be "\.\/plugin-rules\/"/);
});

test('plugin-rules must exist and hold only .gitkeep', () => {
	const noFolder = good();
	delete noFolder['plugin-rules/.gitkeep'];
	assert.match(run(noFolder).out, /plugin-rules: folder is missing/);
	const withRule = { ...good(), 'plugin-rules/make.mdc': 'alwaysApply: true\n' };
	const r = run(withRule);
	assert.equal(r.status, 1);
	assert.match(r.out, /plugin-rules\/make\.mdc: plugin-rules must stay empty/);
});

test('the top CHANGELOG entry must equal the plugin version, released or not', () => {
	const dated = run({ ...good(), 'CHANGELOG.md': '# Changelog\n\n## 3.0.0 — 2026-11-01\n\nText.\n' });
	assert.equal(dated.status, 0, dated.out);
	const stale = run({ ...good(), 'CHANGELOG.md': '# Changelog\n\n## 2.3.13 — 2026-10-27\n\nOld.\n' });
	assert.match(stale.out, /CHANGELOG\.md: top entry 2\.3\.13 differs from the plugin version 3\.0\.0/);
	const odd = run({ ...good(), 'CHANGELOG.md': '# Changelog\n\n## Unreleased\n' });
	assert.match(odd.out, /CHANGELOG\.md: first heading "## Unreleased" does not match/);
	const bare = run({ ...good(), 'CHANGELOG.md': '# Changelog\n\n## 3.0.0\n\nText.\n' });
	assert.equal(bare.status, 1);
	assert.match(bare.out, /CHANGELOG\.md: first heading "## 3\.0\.0" does not match/);
});

test('a manifest that is valid JSON but not an object is an error', () => {
	for (const body of ['null', 'false', '0', '"text"', '[]']) {
		const r = run({ ...good(), '.claude-plugin/plugin.json': `${body}\n` });
		assert.equal(r.status, 1, `${body}: ${r.out}`);
		assert.match(r.out, /\.claude-plugin\/plugin\.json: must be a JSON object/, body);
	}
});

test('plugin-rules that is a file and a version that is not a string are errors', () => {
	const asFile = good();
	delete asFile['plugin-rules/.gitkeep'];
	const file = run({ ...asFile, 'plugin-rules': '' });
	assert.equal(file.status, 1);
	assert.match(file.out, /plugin-rules: is not a folder/);
	const list = run(good((claude, cursor) => {
		cursor.version = ['3.0.0'];
	}));
	assert.equal(list.status, 1);
	assert.match(list.out, /\.cursor-plugin\/plugin\.json: version "3\.0\.0" is not X\.Y\.Z/);
});
