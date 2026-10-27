'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'plugin-check.js');
const START = '<!-- hard-rules:start -->';
const END = '<!-- hard-rules:end -->';
const RULES = '## Hard rules\n\n1. **One.** First rule.';
const ANCHOR = [
	'Plugin root: ${CLAUDE_PLUGIN_ROOT}',
	'If the line above still shows a literal ${...}, the plugin root is the directory',
	'two levels above the folder that contains this SKILL.md.',
].join('\n');
const DESCRIPTION = 'Does one thing for a Make custom app. Not for anything else.';

function skillText({ name = 'a', description = DESCRIPTION, tools, anchor = ANCHOR, block = `${START}\n${RULES}\n${END}`, extra = '', frontmatter } = {}) {
	const lines = [`name: ${name}`, `description: ${description}`];
	if (tools !== undefined) lines.push(`allowed-tools: ${tools}`);
	const head = frontmatter !== undefined ? frontmatter : `---\n${lines.join('\n')}\n---`;
	return `${head}\n\n${anchor}\n\n${block}\n\n# Title\n\nRead \`<plugin root>/shared/workflows/x.md\`.\n${extra}`;
}

const BASE = {
	'shared/hard-rules.md': `${RULES}\n`,
	'shared/workflows/x.md': '# X\n',
	'shared/scripts/check-setup.js': '#!/usr/bin/env node\n',
	'shared/scripts/review-changes.js': '#!/usr/bin/env node\n',
	'skills/a/SKILL.md': skillText({ name: 'a' }),
	'skills/b/SKILL.md': skillText({ name: 'b' }),
};

function makeRepo(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-skills-'));
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
		const skills = extra.some((a) => a.startsWith('--skills=')) ? [] : ['--skills=a,b'];
		const r = spawnSync(process.execPath, [SCRIPT, root, ...skills, ...extra], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
		return { status: r.status, out: r.stdout };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const withSkill = (name, text) => ({ ...BASE, [`skills/${name}/SKILL.md`]: text });

test('a valid skill layer passes', () => {
	const r = run(BASE);
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /^0 error\(s\)$/m);
});

test('the front matter must exist, be closed, and use one line per key', () => {
	for (const [frontmatter, message] of [
		['no front matter', /front matter block is missing/],
		['---\nname: a\ndescription: x. Not for y.', /front matter block is not closed/],
		['---\nname: a\n  description: folded\n---', /is not "key: value"/],
	]) {
		const r = run(withSkill('a', skillText({ frontmatter })));
		assert.equal(r.status, 1, frontmatter);
		assert.match(r.out, message);
	}
});

test('only name, description, and allowed-tools are allowed, and the name equals the folder', () => {
	let r = run(withSkill('a', skillText({ frontmatter: `---\nname: a\ndescription: ${DESCRIPTION}\nversion: 1.0.0\n---` })));
	assert.equal(r.status, 1);
	assert.match(r.out, /skills\/a\/SKILL\.md: front matter key "version" is not allowed/);
	r = run(withSkill('a', skillText({ name: 'other' })));
	assert.equal(r.status, 1);
	assert.match(r.out, /front matter name "other" differs from the folder "a"/);
});

test('a description needs a "Not for" clause and must be a plain one-line value', () => {
	let r = run(withSkill('a', skillText({ description: 'Does one thing.' })));
	assert.equal(r.status, 1);
	assert.match(r.out, /description has no "Not for \.\.\." clause/);
	r = run(withSkill('a', skillText({ description: 'Does it: with a colon. Not for x.' })));
	assert.equal(r.status, 1);
	assert.match(r.out, /description must be a plain one-line YAML value/);
	r = run(withSkill('a', skillText({ description: 'Does it # with a hash. Not for x.' })));
	assert.equal(r.status, 1);
});

test('a description that YAML would reject or change is refused', () => {
	const bad = ['Does it. Not for x:', 'Does it:\twith a tab. Not for x.', ...[...'#[]{}&*!|>\'"%@`'].map((c) => `${c}Does one thing. Not for x.`)];
	for (const description of bad) {
		const r = run(withSkill('a', skillText({ description })));
		assert.equal(r.status, 1, description);
		assert.match(r.out, /description must be a plain one-line YAML value/, description);
	}
	assert.equal(run(withSkill('a', skillText({ description: 'Does one thing (a:b) for C# files, "quoted" or not. Not for x.' }))).status, 0);
});

test('a description over 400 characters warns, over 1,024 fails', () => {
	const long = `${'word '.repeat(90)}Not for x.`;
	let r = run(withSkill('a', skillText({ description: long })));
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /WARNING skills\/a\/SKILL\.md: description is \d+ characters, over 400/);
	assert.match(r.out, /^0 error\(s\), 1 warning\(s\)$/m);
	r = run(withSkill('a', skillText({ description: `${'word '.repeat(220)}Not for x.` })));
	assert.equal(r.status, 1);
	assert.match(r.out, /over the 1024 limit/);
});

test('the descriptions of all skills share a 4,000 character budget', () => {
	const mid = `${'word '.repeat(190)}Not for x.`;
	const names = ['a', 'b', 'c', 'd', 'e'];
	const files = { ...BASE };
	for (const n of names) files[`skills/${n}/SKILL.md`] = skillText({ name: n, description: mid });
	const r = run(files, '--skills=a,b,c,d,e');
	assert.equal(r.status, 1);
	assert.match(r.out, /ERROR skills: the skill descriptions total \d+ characters, over the 4000 budget/);
});

test('allowed-tools may pre-approve check-setup.js and review-changes.js as quoted node commands only', () => {
	const ok = 'Bash(node "${CLAUDE_PLUGIN_ROOT}/shared/scripts/check-setup.js"*) Bash(node "${CLAUDE_PLUGIN_ROOT}/shared/scripts/review-changes.js"*)';
	assert.equal(run(withSkill('a', skillText({ tools: ok }))).status, 0);
	let r = run(withSkill('a', skillText({ tools: 'Bash(node "${CLAUDE_PLUGIN_ROOT}/shared/scripts/update-app.js"*)' })));
	assert.equal(r.status, 1);
	assert.match(r.out, /pre-approves update-app\.js; only check-setup\.js and review-changes\.js may be pre-approved/);
	r = run(withSkill('a', skillText({ tools: 'Bash(node ${CLAUDE_PLUGIN_ROOT}/shared/scripts/check-setup.js*)' })));
	assert.equal(r.status, 1);
	assert.match(r.out, /not a quoted node command/);
	r = run(withSkill('a', skillText({ tools: 'Bash(*)' })));
	assert.equal(r.status, 1);
	const files = withSkill('a', skillText({ tools: 'Bash(node "${CLAUDE_PLUGIN_ROOT}/shared/scripts/check-setup.js"*)' }));
	delete files['shared/scripts/check-setup.js'];
	r = run(files);
	assert.equal(r.status, 1);
	assert.match(r.out, /names shared\/scripts\/check-setup\.js, which does not exist/);
});

test('the body starts with the plugin-root anchor and then the hard-rules block', () => {
	let r = run(withSkill('a', skillText({ anchor: 'Plugin root: ${CLAUDE_PLUGIN_ROOT}' })));
	assert.equal(r.status, 1);
	assert.match(r.out, /the body must start with an empty line, the three-line "Plugin root:" anchor/);
	r = run(withSkill('a', skillText({ anchor: ANCHOR.replace('two levels', 'three levels') })));
	assert.equal(r.status, 1);
	r = run(withSkill('a', skillText({ anchor: `${ANCHOR}\n\nSome text first.` })));
	assert.equal(r.status, 1);
});

test('the skill folders must be exactly the expected set', () => {
	const files = { ...BASE };
	delete files['skills/b/SKILL.md'];
	let r = run(files);
	assert.equal(r.status, 1);
	assert.match(r.out, /ERROR skills\/b: expected skill folder is missing/);
	r = run({ ...BASE, 'skills/c/SKILL.md': skillText({ name: 'c' }) });
	assert.equal(r.status, 1);
	assert.match(r.out, /ERROR skills\/c: unexpected skill folder/);
});

test('every workflow must be named by a SKILL.md', () => {
	const r = run({ ...BASE, 'shared/workflows/lonely.md': '# Lonely\n' });
	assert.equal(r.status, 1);
	assert.match(r.out, /shared\/workflows\/lonely\.md: no SKILL\.md names this workflow in its load order/);
});

test('a mention inside the hard-rules block does not count as naming a workflow', () => {
	const rules = `${RULES}\nSee <plugin root>/shared/workflows/lonely.md.`;
	const files = { ...BASE, 'shared/hard-rules.md': `${rules}\n`, 'shared/workflows/lonely.md': '# Lonely\n' };
	for (const n of ['a', 'b']) files[`skills/${n}/SKILL.md`] = skillText({ name: n, block: `${START}\n${rules}\n${END}` });
	const r = run(files);
	assert.equal(r.status, 1);
	assert.match(r.out, /shared\/workflows\/lonely\.md: no SKILL\.md names this workflow in its load order/);
	files['skills/b/SKILL.md'] = skillText({ name: 'b', block: `${START}\n${rules}\n${END}`, extra: 'Read `<plugin root>/shared/workflows/lonely.md`.\n' });
	assert.equal(run(files).status, 0);
});

test('hard-rules blocks must equal shared/hard-rules.md, and the source must not hold reserved tokens', () => {
	let r = run(withSkill('a', skillText({ block: `${START}\n## Hard rules\n\nold\n${END}` })));
	assert.equal(r.status, 1);
	assert.match(r.out, /ERROR skills\/a\/SKILL\.md: hard-rules block differs from shared\/hard-rules\.md/);
	r = run({ ...BASE, 'shared/hard-rules.md': '## Hard rules\n\nuse $ARGUMENTS\n' });
	assert.equal(r.status, 1);
	assert.match(r.out, /shared\/hard-rules\.md:3: contains \$ARGUMENTS/);
});

test('every top-level reference must be listed in shared/index.md', () => {
	const files = { ...BASE, 'shared/index.md': '# Index\n\n- [one](references/one.md)\n', 'shared/references/one.md': '# One\n\n> Read when: x.\n', 'shared/references/two.md': '# Two\n\n> Read when: x.\n' };
	const r = run(files);
	assert.equal(r.status, 1);
	assert.match(r.out, /ERROR shared\/index\.md: does not list shared\/references\/two\.md/);
	delete files['shared/references/two.md'];
	assert.equal(run(files).status, 0);
});

test('tools and CI scripts must pass node --check', () => {
	const r = run({ ...BASE, 'tools/bad.js': 'const = ;\n' });
	assert.equal(r.status, 1);
	assert.match(r.out, /ERROR tools\/bad\.js: syntax check failed/);
});

test('a scoped run skips the skill-layer checks', () => {
	const files = withSkill('a', skillText({ description: 'Does one thing.' }));
	assert.equal(run(files).status, 1);
	assert.equal(run(files, '--scope=shared').status, 0);
});
