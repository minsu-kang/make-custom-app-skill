'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sync = require('../sync-hard-rules.js');

const SCRIPT = path.join(__dirname, '..', 'sync-hard-rules.js');
const RULES = '## Hard rules\n\n1. **One.** First rule.\n2. **Two.** Second rule.\n';
const withBlock = (inner) => `---\nname: x\n---\n\nbody\n\n${sync.START}\n${inner}\n${sync.END}\n\ntail\n`;

function makeRepo(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-hard-rules-'));
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
	}
	return root;
}

function cli(root, ...args) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args, root], { encoding: 'utf8' });
	return { status: r.status, out: r.stdout };
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('write mode puts the source between the markers and leaves the rest alone', () => {
	const root = makeRepo({ 'shared/hard-rules.md': RULES, 'skills/a/SKILL.md': withBlock('old text') });
	const r = cli(root);
	assert.equal(r.status, 0);
	assert.match(r.out, /updated skills\/a\/SKILL\.md/);
	assert.equal(read(root, 'skills/a/SKILL.md'), withBlock(RULES.replace(/\n+$/, '')));
});

test('a second run changes nothing', () => {
	const root = makeRepo({ 'shared/hard-rules.md': RULES, 'skills/a/SKILL.md': withBlock('old text') });
	cli(root);
	const before = read(root, 'skills/a/SKILL.md');
	const r = cli(root);
	assert.equal(r.status, 0);
	assert.doesNotMatch(r.out, /^updated /m);
	assert.match(r.out, /hard rules: 0 file\(s\) updated/);
	assert.equal(read(root, 'skills/a/SKILL.md'), before);
});

test('--check exits 1 on drift and writes nothing, and exits 0 when in sync', () => {
	const root = makeRepo({ 'shared/hard-rules.md': RULES, 'skills/a/SKILL.md': withBlock('old text') });
	let r = cli(root, '--check');
	assert.equal(r.status, 1);
	assert.match(r.out, /ERROR skills\/a\/SKILL\.md: hard-rules block differs/);
	assert.equal(read(root, 'skills/a/SKILL.md'), withBlock('old text'));
	cli(root);
	r = cli(root, '--check');
	assert.equal(r.status, 0);
	assert.match(r.out, /hard rules: in sync/);
});

test('every skills/*/SKILL.md is synced and nothing else is touched', () => {
	const root = makeRepo({
		'shared/hard-rules.md': RULES,
		'skills/a/SKILL.md': withBlock('x'),
		'skills/b/SKILL.md': withBlock('y'),
		'skills/b/notes.md': 'untouched',
		'skills/c/README.md': 'no skill file here',
	});
	const r = cli(root);
	assert.equal(r.status, 0);
	assert.match(r.out, /updated skills\/a\/SKILL\.md/);
	assert.match(r.out, /updated skills\/b\/SKILL\.md/);
	assert.equal(read(root, 'skills/b/notes.md'), 'untouched');
	assert.deepEqual(sync.skillFiles(root), ['skills/a/SKILL.md', 'skills/b/SKILL.md']);
});

test('a SKILL.md without markers, with a duplicate marker, or with the markers reversed is an error', () => {
	const bad = {
		'skills/none/SKILL.md': 'no markers\n',
		'skills/dup/SKILL.md': `${sync.START}\n${sync.START}\n${sync.END}\n`,
		'skills/rev/SKILL.md': `${sync.END}\n${sync.START}\n`,
	};
	for (const [rel, body] of Object.entries(bad)) {
		const root = makeRepo({ 'shared/hard-rules.md': RULES, [rel]: body });
		const r = cli(root);
		assert.equal(r.status, 1, rel);
		assert.match(r.out, new RegExp(`ERROR ${rel.replace(/[./]/g, '\\$&')}: `), rel);
	}
});

test('a missing source is an error', () => {
	const root = makeRepo({ 'skills/a/SKILL.md': withBlock('x') });
	const r = cli(root);
	assert.equal(r.status, 1);
	assert.match(r.out, /ERROR shared\/hard-rules\.md is missing/);
});

test('tokens that Claude rewrites when a skill loads are errors in both modes, with the line number', () => {
	const tokens = {
		'${CLAUDE_PLUGIN_ROOT}': '${CLAUDE_',
		'${user_config.key}': '${user_config...}',
		'$ARGUMENTS': '$ARGUMENTS',
		'costs $5': '$0 to $9',
		'a \\$ sign': 'a backslash before a dollar sign',
		'run !`ls` now': 'an exclamation mark followed by a backtick',
	};
	for (const [text, label] of Object.entries(tokens)) {
		const root = makeRepo({ 'shared/hard-rules.md': `## Hard rules\n\n${text}\n`, 'skills/a/SKILL.md': withBlock('x') });
		for (const args of [[], ['--check']]) {
			const r = cli(root, ...args);
			assert.equal(r.status, 1, text);
			assert.ok(r.out.includes(`ERROR shared/hard-rules.md:3: contains ${label}`), `${text}: ${r.out}`);
		}
		assert.equal(read(root, 'skills/a/SKILL.md'), withBlock('x'), 'nothing is written when the source is bad');
	}
});

test('ordinary text with a dollar sign inside code or an exclamation mark passes the lint', () => {
	assert.deepEqual(sync.lintSource('Use `fetch()`! It is fine. Cost: USD. The `!` operator.\n'), []);
});

test('blockFor trims trailing newlines of the source', () => {
	assert.equal(sync.blockFor('a\nb\n\n'), `${sync.START}\na\nb\n${sync.END}`);
});
