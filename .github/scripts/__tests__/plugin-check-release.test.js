'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'plugin-check.js');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GITHUB_ACTIONS: '' };

function git(root, ...args) {
	const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV });
	assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

function write(root, files) {
	for (const [rel, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), body);
	}
}

const manifest = (version) => `${JSON.stringify({ name: 'make-custom-app', version })}\n`;

/**
 * A repository with a commit "base" (tag base) and a commit on a branch with `changes` applied. A null value deletes a file.
 * The scope is docs, so the run is a scoped run: only the release rule and the scope are checked.
 */
function repo({ baseFiles, changes }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-release-'));
	git(root, 'init', '-q', '-b', 'main');
	write(root, { 'docs/note.md': '# Note\n', ...baseFiles });
	git(root, 'add', '-A');
	git(root, 'commit', '-q', '-m', 'base');
	git(root, 'tag', 'base');
	git(root, 'checkout', '-q', '-b', 'work');
	for (const [rel, body] of Object.entries(changes)) {
		if (body === null) fs.rmSync(path.join(root, rel));
		else write(root, { [rel]: body });
	}
	git(root, 'add', '-A');
	git(root, 'commit', '-q', '-m', 'work');
	return root;
}

function run(root, base = 'base') {
	try {
		const r = spawnSync(process.execPath, [SCRIPT, root, '--scope=docs', `--release-base=${base}`], { encoding: 'utf8', env: GIT_ENV });
		return { status: r.status, out: r.stdout };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const BASE_FILES = { '.claude-plugin/plugin.json': manifest('3.0.0'), 'skills/a/SKILL.md': 'old\n', 'README.md': 'old\n' };

test('a change outside the payload needs no version bump', () => {
	const r = run(repo({ baseFiles: BASE_FILES, changes: { 'README.md': 'new\n', 'docs/superpowers/plan.md': 'x\n', 'tools/x.js': '1\n' } }));
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /0 error\(s\)/);
});

test('a payload change with the same version is an error that names the file and both versions', () => {
	const r = run(repo({ baseFiles: BASE_FILES, changes: { 'skills/a/SKILL.md': 'new\n' } }));
	assert.equal(r.status, 1);
	assert.match(r.out, /\.claude-plugin\/plugin\.json: payload changed \(1 file\(s\), for example skills\/a\/SKILL\.md\) but the plugin version 3\.0\.0 is not greater than 3\.0\.0 on base/);
});

test('every payload path counts: shared, mcp, mcp.json, hooks and both manifests', () => {
	for (const rel of ['shared/x.md', 'mcp/index.mjs', 'mcp.json', 'hooks/hooks.json', '.cursor-plugin/plugin.json']) {
		const r = run(repo({ baseFiles: BASE_FILES, changes: { [rel]: 'new\n' } }));
		assert.equal(r.status, 1, rel);
		assert.match(r.out, /payload changed/, rel);
	}
});

test('a deleted payload file counts', () => {
	const r = run(repo({ baseFiles: BASE_FILES, changes: { 'skills/a/SKILL.md': null } }));
	assert.equal(r.status, 1);
});

test('a higher version passes, a lower one does not, and the numbers are compared as numbers', () => {
	const bumped = run(repo({ baseFiles: BASE_FILES, changes: { 'skills/a/SKILL.md': 'new\n', '.claude-plugin/plugin.json': manifest('3.0.1') } }));
	assert.equal(bumped.status, 0, bumped.out);
	const lower = run(repo({ baseFiles: BASE_FILES, changes: { 'skills/a/SKILL.md': 'new\n', '.claude-plugin/plugin.json': manifest('2.9.9') } }));
	assert.equal(lower.status, 1);
	const tens = run(repo({ baseFiles: { ...BASE_FILES, '.claude-plugin/plugin.json': manifest('3.0.9') }, changes: { 'skills/a/SKILL.md': 'new\n', '.claude-plugin/plugin.json': manifest('3.0.10') } }));
	assert.equal(tens.status, 0, tens.out);
});

test('a base without a plugin manifest (the 2.x master) accepts any version', () => {
	const baseFiles = { 'skill/SKILL.md': 'old\n' };
	const r = run(repo({ baseFiles, changes: { '.claude-plugin/plugin.json': manifest('3.0.0'), 'skills/a/SKILL.md': 'new\n' } }));
	assert.equal(r.status, 0, r.out);
});

test('a missing manifest at the head is an error when the payload changed', () => {
	const r = run(repo({ baseFiles: BASE_FILES, changes: { '.claude-plugin/plugin.json': null, 'skills/a/SKILL.md': 'new\n' } }));
	assert.equal(r.status, 1);
	assert.match(r.out, /\.claude-plugin\/plugin\.json: file is missing or unreadable/);
});

test('a base ref that git does not know is an error that names it', () => {
	const r = run(repo({ baseFiles: BASE_FILES, changes: { 'README.md': 'new\n' } }), 'no-such-ref');
	assert.equal(r.status, 1);
	assert.match(r.out, /--release-base: cannot diff against no-such-ref/);
});
