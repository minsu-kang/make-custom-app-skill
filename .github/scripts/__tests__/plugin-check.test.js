'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'plugin-check.js');

function makeRepo(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-'));
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
	}
	return root;
}

function run(files, ...extra) {
	const root = makeRepo(files);
	try {
		const result = spawnSync(process.execPath, [SCRIPT, root, ...extra], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
		return { status: result.status, out: result.stdout };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const CLEAN = {
	'shared/references/a.md': '# A\n\n> Read when: testing.\n',
	'shared/workflows/lifecycle.md': '# Lifecycle\n\nSee [a](../references/a.md) and `<plugin root>/shared/references/a.md`.\n',
	'shared/workflows/bug-investigation.md': '# Bug\n\n## Checklist\n\n- [ ] one\n',
};

const withFile = (rel, body) => ({ ...CLEAN, [rel]: body });

test('a clean tree passes', () => {
	const r = run(CLEAN);
	assert.equal(r.status, 0);
	assert.match(r.out, /0 error\(s\)/);
});

test('old placeholders and the Variables comment fail', () => {
	const r = run(withFile('shared/workflows/x.md', '<!-- Variables: SKILL_ROOT = a -->\nrun ${SKILL_ROOT}/scripts/a.js and ${CONTEXTS_DIR}\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /shared\/workflows\/x\.md:1: old "Variables" comment/);
	assert.match(r.out, /shared\/workflows\/x\.md:2: old \$\{SKILL_ROOT\} or \$\{CONTEXTS_DIR\} placeholder/);
});

test('old install paths fail', () => {
	const r = run(withFile('shared/workflows/x.md', 'files live under make-app-contexts\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /x\.md:1: old install path/);
});

test('a lifecycle citation without a file name fails', () => {
	const r = run(withFile('shared/workflows/x.md', 'see lifecycle §6\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /x\.md:1: "lifecycle §6" must name the new file/);
});

test('lifecycle.md sections 1 to 4 are valid and later ones are not', () => {
	assert.equal(run(withFile('shared/workflows/x.md', 'see [lifecycle.md](lifecycle.md) §3 and lifecycle.md §2–3\n')).status, 0);
	const r = run(withFile('shared/workflows/x.md', 'see [lifecycle.md § 6 Push](lifecycle.md)\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /lifecycle\.md has no section 6/);
});

test('a pointer at SKILL.md fails', () => {
	const r = run(withFile('shared/workflows/x.md', 'see SKILL.md hard rule 3\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /x\.md:1: points at SKILL\.md/);
});

test('a broken relative link fails, links inside code do not count', () => {
	const r = run(withFile('shared/workflows/x.md', '[gone](missing.md)\n\n`[inline](nope.md)`\n\n```\n[block](nope.md)\n```\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /x\.md:1: link target "missing\.md" does not exist/);
	assert.equal(r.out.match(/does not exist/g).length, 1);
});

test('a <plugin root> path must exist', () => {
	const r = run(withFile('shared/workflows/x.md', 'run `<plugin root>/shared/scripts/gone.js`.\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /x\.md:1: <plugin root>\/shared\/scripts\/gone\.js does not exist/);
	assert.equal(run(withFile('shared/workflows/x.md', 'see <plugin root>/shared/references/a.md.\n')).status, 0);
});

test('a reference needs the Read when header and its folder needs a Parts entry', () => {
	let r = run(withFile('shared/references/b.md', '# B\n\nno header\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /b\.md: missing the "> Read when" header/);
	r = run({
		...CLEAN,
		'shared/references/big.md': '# Big\n\n> Read when: testing.\n\n| part |\n|---|\n| none |\n',
		'shared/references/big/part.md': '# Part\n\n> Read when: testing.\n',
	});
	assert.equal(r.status, 1);
	assert.match(r.out, /big\.md: Parts table does not list big\/part\.md/);
});

test('task workflows need a checklist and shared step files must not have one', () => {
	let r = run(withFile('shared/workflows/code-review.md', '# Review\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /code-review\.md: task workflow has no "## Checklist" section/);
	r = run(withFile('shared/workflows/close-out.md', '# Close\n\n## Checklist\n\n- [ ] x\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /close-out\.md: shared step file must not carry a checklist/);
});

test('shared step files must not point into task workflows', () => {
	let r = run(withFile('shared/workflows/close-out.md', '# Close\n\nsee code-review.md for the gate\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /close-out\.md:3: shared step file points into a task workflow/);
	r = run(withFile('shared/workflows/run-live.md', '# Run\n\nsee [bug-investigation.md](bug-investigation.md)\n\n## Checklist\n\n- [ ] x\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /run-live\.md:3: shared step file points into a task workflow/);
	assert.equal(run(withFile('shared/workflows/close-out.md', '# Close\n\nsee code-review-criteria.md\n')).status, 0);
});

test('--scope limits the scan and accepts a single file', () => {
	const files = { ...CLEAN, 'shared/workflows/x.md': 'see lifecycle §6\n' };
	assert.equal(run(files).status, 1);
	assert.equal(run(files, '--scope=shared/references').status, 0);
	assert.equal(run(files, '--scope=shared/workflows/lifecycle.md').status, 0);
	assert.equal(run(files, '--scope=shared/workflows/x.md').status, 1);
});
