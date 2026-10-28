'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'plugin-check.js');

const README = [
	'# Plugin',
	'',
	'## Scripts',
	'',
	'| Script | Description |',
	'|---|---|',
	'| `check-setup.js` | Diagnosis |',
	'| `download-app.js` | Download |',
	'',
	'## Configuration',
	'',
	'| `other.js` | not a plugin script |',
].join('\n');

const BASE = {
	'shared/scripts/check-setup.js': '#!/usr/bin/env node\n',
	'shared/scripts/download-app.js': '#!/usr/bin/env node\n',
	'shared/scripts/lib/helper.js': "'use strict';\n",
	'README.md': README,
};

function run(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-readme-'));
	try {
		for (const [rel, body] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), body);
		}
		const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
		return { status: r.status, out: r.stdout };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test('a Scripts table that matches the entry scripts passes; lib files and other tables are ignored', () => {
	const r = run(BASE);
	assert.equal(r.status, 0, r.out);
});

test('an entry script that the table does not list is an error that names it', () => {
	const r = run({ ...BASE, 'shared/scripts/update-app.js': '#!/usr/bin/env node\n' });
	assert.equal(r.status, 1);
	assert.match(r.out, /README\.md: Scripts table does not list update-app\.js/);
});

test('a table row for a script that does not exist is an error', () => {
	const r = run({ ...BASE, 'README.md': README.replace('| `download-app.js` | Download |', '| `download-app.js` | Download |\n| `gone.js` | Removed |') });
	assert.equal(r.status, 1);
	assert.match(r.out, /README\.md: Scripts table lists gone\.js, which is not in shared\/scripts/);
});

test('a README without a "## Scripts" section is an error', () => {
	const r = run({ ...BASE, 'README.md': '# Plugin\n\nNothing here.\n' });
	assert.equal(r.status, 1);
	assert.match(r.out, /README\.md: has no "## Scripts" section/);
});

test('no README, or no entry scripts, means no table check', () => {
	const noReadme = { ...BASE };
	delete noReadme['README.md'];
	assert.equal(run(noReadme).status, 0);
	assert.equal(run({ 'README.md': '# Plugin\n' }).status, 0);
});

test('README.md and CLAUDE.md are in the default scope: the old placeholders are errors there', () => {
	const r = run({ 'README.md': '# Plugin\n\nSee ${SKILL_ROOT}/x.md\n', 'CLAUDE.md': 'Use ${CONTEXTS_DIR}\n' });
	assert.equal(r.status, 1);
	assert.match(r.out, /README\.md:3: old \$\{SKILL_ROOT\} or \$\{CONTEXTS_DIR\} placeholder/);
	assert.match(r.out, /CLAUDE\.md:1: old \$\{SKILL_ROOT\} or \$\{CONTEXTS_DIR\} placeholder/);
});

test('README.md and CLAUDE.md may name the old install paths, other documents may not', () => {
	const old = 'The old skill lives in ~/.claude/skills/make-custom-app.\n';
	assert.equal(run({ 'README.md': `# Plugin\n\n${old}`, 'CLAUDE.md': old }).status, 0);
	const r = run({ 'shared/workflows/x.md': old });
	assert.equal(r.status, 1);
	assert.match(r.out, /shared\/workflows\/x\.md:1: old install path/);
});

test('a relative link in README.md has to resolve', () => {
	const r = run({ 'README.md': '# Plugin\n\nSee [index](shared/index.md).\n' });
	assert.equal(r.status, 1);
	assert.match(r.out, /README\.md:3: link target "shared\/index\.md" does not exist/);
});
