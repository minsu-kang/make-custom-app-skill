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

// extra: strings are command-line arguments, plain objects are extra environment variables
function run(files, ...extra) {
	const root = makeRepo(files);
	const args = extra.filter((a) => typeof a === 'string');
	const env = Object.assign({}, ...extra.filter((a) => typeof a === 'object'));
	try {
		const result = spawnSync(process.execPath, [SCRIPT, root, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', ...env } });
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

test('old install paths fail, other uses of the old names do not', () => {
	const r = run(withFile('shared/workflows/x.md', 'a ~/.cursor/make-app-contexts/foo\nb make-app-contexts/model-v1/\nc ~/.claude/skills/make-custom-app/scripts\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /x\.md:1: old install path/);
	assert.match(r.out, /x\.md:2: old install path/);
	assert.match(r.out, /x\.md:3: old install path/);
	assert.equal(r.out.match(/old install path/g).length, 3);
	const ok = run(withFile('shared/workflows/x.md', 'the Pinecone index defaults to make-app-contexts\nsee ~/.claude/skills/make-custom-app-review/x\n'));
	assert.equal(ok.status, 0);
	assert.match(ok.out, /0 error\(s\)/);
});

test('the make-app-setup skill may name old install paths, other skills may not', () => {
	const body = 'remove ~/.cursor/make-app-contexts/foo and ~/.claude/skills/make-custom-app/scripts\n';
	assert.equal(run(withFile('skills/make-app-setup/SKILL.md', body), '--scope=skills').status, 0);
	const r = run(withFile('skills/make-app-question/SKILL.md', body), '--scope=skills');
	assert.equal(r.status, 1);
	assert.match(r.out, /skills\/make-app-question\/SKILL\.md:1: old install path/);
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

test('every section number in a lifecycle citation run is checked', () => {
	const cases = [
		['lifecycle.md §3 and §6', '6'],
		['lifecycle.md §2, §3, §7', '7'],
		['lifecycle.md §1 to §6', '6'],
		['lifecycle.md §2–7', '7'],
		['lifecycle.md#6-push-changes', '6'],
		['[x](lifecycle.md#5-other)', '5'],
	];
	for (const [text, bad] of cases) {
		const r = run(withFile('shared/workflows/x.md', `see ${text}\n`));
		assert.equal(r.status, 1, text);
		assert.match(r.out, new RegExp(`x\\.md:1: lifecycle\\.md has no section ${bad}`), text);
		assert.equal(r.out.match(/has no section/g).length, 1, text);
	}
});

test('valid lifecycle citations pass in the new and the carried forms', () => {
	const valid = [
		'[lifecycle.md](lifecycle.md) §3',
		'lifecycle.md §1 to §3',
		'lifecycle.md §2–3',
		'lifecycle.md §3 and §4',
		'lifecycle.md §1, §2, §4',
		'[x](lifecycle.md#4-do-the-work)',
	];
	for (const text of valid) {
		const r = run(withFile('shared/workflows/x.md', `see ${text}\n`));
		assert.equal(r.status, 0, text);
	}
});

test('the spelled-out lifecycle section form fails for any number', () => {
	for (const text of ['lifecycle section 6', 'lifecycle.md section 3', 'lifecycle sections 2 and 3']) {
		const r = run(withFile('shared/workflows/x.md', `see ${text}\n`));
		assert.equal(r.status, 1, text);
		assert.match(r.out, /x\.md:1: spell the citation as "lifecycle\.md §\d"/, text);
	}
});

test('a pointer at SKILL.md fails in shared files and passes in skill files', () => {
	const r = run(withFile('shared/workflows/x.md', 'see SKILL.md hard rule 3\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /x\.md:1: points at SKILL\.md/);
	const skill = run(withFile('skills/make-app-question/SKILL.md', 'Open the folder that contains this SKILL.md, then read `<plugin root>/skills/make-app-question/SKILL.md`.\n'), '--scope=skills');
	assert.equal(skill.status, 0);
	assert.match(skill.out, /0 error\(s\)/);
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

test('module-test.md and self-review.md are task workflows, and module-test.md names no task workflow, self-review.md included', () => {
	let r = run(withFile('shared/workflows/module-test.md', '# Module test\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /module-test\.md: task workflow has no "## Checklist" section/);
	r = run(withFile('shared/workflows/self-review.md', '# Self-review\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /self-review\.md: task workflow has no "## Checklist" section/);
	r = run(withFile('shared/workflows/module-test.md', '# Module test\n\nsee code-review.md\n\n## Checklist\n\n- [ ] x\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /module-test\.md:3: shared step file points into a task workflow/);
	r = run(withFile('shared/workflows/lifecycle.md', '# Lifecycle\n\nsee self-review.md\n'));
	assert.equal(r.status, 1);
	assert.match(r.out, /lifecycle\.md:3: shared step file points into a task workflow/);
	assert.equal(run(withFile('shared/workflows/module-test.md', '# Module test\n\nsee run-live.md, push-changes.md and lifecycle.md\n\n## Checklist\n\n- [ ] x\n')).status, 0);
});

test('--scope limits the scan and accepts a single file', () => {
	const files = { ...CLEAN, 'shared/workflows/x.md': 'see lifecycle §6\n' };
	assert.equal(run(files).status, 1);
	assert.equal(run(files, '--scope=shared/references').status, 0);
	assert.equal(run(files, '--scope=shared/workflows/lifecycle.md').status, 0);
	assert.equal(run(files, '--scope=shared/workflows/x.md').status, 1);
});

test('--scope values are normalised and an explicit scope must exist', () => {
	const files = { ...CLEAN, 'shared/workflows/x.md': 'see lifecycle §6\n' };
	assert.equal(run(files, '--scope=./shared/references').status, 0);
	assert.equal(run(files, '--scope=shared//references/').status, 0);
	const file = run(files, '--scope=./shared/workflows/x.md');
	assert.equal(file.status, 1);
	assert.match(file.out, /ERROR shared\/workflows\/x\.md:1: /);
	const missing = run(files, '--scope=shared/nope');
	assert.equal(missing.status, 1);
	assert.match(missing.out, /ERROR shared\/nope: scope does not exist/);
	const missingFile = run(files, '--scope=shared/references', '--scope=./shared/nope.md');
	assert.equal(missingFile.status, 1);
	assert.match(missingFile.out, /ERROR shared\/nope\.md: scope does not exist/);
	assert.equal(missingFile.out.match(/ERROR/g).length, 1);
});

test('the default scope skips folders that do not exist', () => {
	const r = run({ 'shared/references/a.md': '# A\n\n> Read when: testing.\n' });
	assert.equal(r.status, 0);
	assert.match(r.out, /0 error\(s\)/);
});

test('with GITHUB_ACTIONS a finding is an escaped ::error annotation', () => {
	const files = withFile('shared/workflows/50%.md', '# X\n\n[a](my%20file.md)\n');
	const r = run(files, { GITHUB_ACTIONS: 'true' });
	assert.equal(r.status, 1);
	assert.match(r.out, /^::error file=shared\/workflows\/50%25\.md,line=3::link target "my%2520file\.md" does not exist$/m);
	assert.doesNotMatch(r.out, /^ERROR /m);
});
