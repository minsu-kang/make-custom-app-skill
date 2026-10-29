'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const REAL_HOME = os.homedir();
const TEST_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p5-guard-')));
for (const name of ['home', 'tmp', 'claude-config']) fs.mkdirSync(path.join(TEST_ROOT, name));
process.env.HOME = process.env.USERPROFILE = path.join(TEST_ROOT, 'home');
process.env.TMPDIR = process.env.TEMP = process.env.TMP = path.join(TEST_ROOT, 'tmp');
process.env.CLAUDE_CONFIG_DIR = path.join(TEST_ROOT, 'claude-config');

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const guard = require('../old-tree-guard');

process.on('exit', () => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

const SCRIPT = path.join(__dirname, '..', 'old-tree-guard.js');
const USAGE = 'Usage: node .github/scripts/old-tree-guard.js --mode=branch|release --base=<ref> [repoRoot]';

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: 't',
	GIT_AUTHOR_EMAIL: 't@example.com',
	GIT_COMMITTER_NAME: 't',
	GIT_COMMITTER_EMAIL: 't@example.com',
	GITHUB_ACTIONS: '',
	GIT_CONFIG_GLOBAL: os.devNull,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CEILING_DIRECTORIES: TEST_ROOT,
};
for (const key of Object.keys(GIT_ENV)) {
	if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|PREFIX|NAMESPACE)$/.test(key)) delete GIT_ENV[key];
}

// Fixtures shaped like the master files of 2.3.13 (commit cd8f60b).
const VERSION_JSON = {
	version: '2.3.13',
	released: '2026-10-27',
	min_version: '1.0.0',
	update_command_cursor: 'curl -fsSL https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install-cursor.sh | bash -s -- --update',
	update_command_cursor_windows: 'irm https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install-cursor.ps1 | iex',
	update_command_claude: 'curl -fsSL https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install-claude.sh | bash -s -- --update',
	update_command_claude_windows: 'irm https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install-claude.ps1 | iex',
};

const versionJson = (over = {}) => `${JSON.stringify({ ...VERSION_JSON, ...over }, null, 2)}\n`;

function skillMd({ version = '2.3.13', migration = null, tail = 'Hard rule one.', eol = '\n' } = {}) {
	const lines = [
		'---',
		'name: make-custom-app',
		`version: ${version}`,
		'description: Build, review, and edit Make.com custom app IMLJSON code.',
		'---',
		'',
		'# Make Custom App Development',
		'',
		'Skill for writing, reviewing, and maintaining Make.com custom apps.',
		'',
		'## First action',
		'',
		'Run check-setup.js once per conversation.',
		'',
		'## Workflows',
		'',
		'Read lifecycle.md first.',
		'',
	];
	if (migration) lines.push('## Plugin migration', '', ...migration, '');
	lines.push('## Hard rules', '', tail, '', '## Scripts', '', 'See the scripts folder.');
	return `${lines.join(eol)}${eol}`;
}

const BASE = { versionJson: versionJson(), skillMd: skillMd() };
const pair = (version, over = {}) => ({ versionJson: versionJson({ version, released: '2026-11-03', ...over }), skillMd: skillMd({ version }) });
const entry = (status, file) => ({ status, path: file });
const check = (mode, entries, base, head) => guard.checkOldTree({ mode, entries, base, head });

const notAllowed = (file, status) => `${file}: changes to this old-tree path are not allowed during the bridge (git status ${status})`;
const SECTION_FINDING = 'skill/SKILL.md: changed outside the version line and the "## Plugin migration" section';
const skillVersionFinding = (from, to) => `skill/SKILL.md: version changed from ${from} to ${to}; versions change only in the release commit`;
const VERSION_JSON_CHANGED = 'version.json: changed; it changes only in the release commit';
const stillReads = (v) => `version.json: the old tree changed but version.json still reads ${v}; a bridge change needs a 2.4.x bump of version.json and skill/SKILL.md together`;
const differsFromSkill = (a, b) => `version.json: version ${a} differs from the skill/SKILL.md version ${b}`;
const not24x = (v) => `version.json: version ${v} is not 2.4.x`;
const notGreater = (v, base) => `version.json: version ${v} is not greater than ${base} on the base`;
const notADate = (x) => `version.json: released "${x}" is not a YYYY-MM-DD date`;
const keyDiffers = (key) => `version.json: ${key} differs from the base; only version and released may change`;

const NEW_FILES = [
	'skill/scripts/migrate-to-plugin.js',
	'skill/scripts/lib/migrate-logic.js',
	'skill/scripts/lib/__tests__/migrate-logic.test.js',
	'skill/scripts/lib/__tests__/migrate-to-plugin.test.js',
];
const CHANGED_FILES = ['skill/SKILL.md', 'skill/scripts/check-setup.js', 'skill/scripts/lib/__tests__/access-guard.test.js'];

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

const BASE_FILES = {
	'version.json': BASE.versionJson,
	'skill/SKILL.md': BASE.skillMd,
	'skill/scripts/check-setup.js': "'use strict';\n",
	'skill/scripts/download-app.js': "'use strict';\n",
	'skill/scripts/lib/__tests__/access-guard.test.js': "'use strict';\n",
	'rules/make-custom-app.mdc': 'rule\n',
	'install-claude.sh': '#!/bin/sh\n',
	'README.md': 'old\n',
};

/**
 * A repository with a commit "base" (tag base) that holds the old tree of 2.3.13, and a commit on a branch with `changes`
 * applied after `moves` (git mv pairs). A null value in `changes` deletes a file.
 */
function repo({ changes = {}, moves = [] }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'old-tree-guard-'));
	try {
		git(root, 'init', '-q', '-b', 'main');
		write(root, BASE_FILES);
		git(root, 'add', '-A');
		git(root, 'commit', '-q', '-m', 'base');
		git(root, 'tag', 'base');
		git(root, 'checkout', '-q', '-b', 'work');
		for (const [from, to] of moves) git(root, 'mv', from, to);
		for (const [rel, body] of Object.entries(changes)) {
			if (body === null) fs.rmSync(path.join(root, rel));
			else write(root, { [rel]: body });
		}
		git(root, 'add', '-A');
		git(root, 'commit', '-q', '-m', 'work');
		return root;
	} catch (err) {
		fs.rmSync(root, { recursive: true, force: true });
		throw err;
	}
}

function withRepo(spec, fn) {
	const root = repo(spec);
	try {
		return fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function cli(root, args, env = {}) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args, root], { encoding: 'utf8', env: { ...GIT_ENV, ...env } });
	return { status: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split('\n').filter((line) => line !== '') };
}

const summary = (n, mode, base) => `old-tree-guard: ${n} finding(s) (mode ${mode}, base ${base})`;

test('the test process sees a temporary home', () => {
	assert.ok(os.homedir().startsWith(TEST_ROOT), os.homedir());
	assert.ok(os.tmpdir().startsWith(TEST_ROOT), os.tmpdir());
	assert.notEqual(os.homedir(), REAL_HOME);
	assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(TEST_ROOT), process.env.CLAUDE_CONFIG_DIR);
});

test('branch: no old-tree change passes', () => {
	assert.deepEqual(check('branch', [], BASE, BASE), []);
	withRepo({ changes: { 'README.md': 'new\n', 'docs/note.md': 'x\n' } }, (root) => {
		const r = cli(root, ['--mode=branch', '--base=base']);
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(r.lines, [summary(0, 'branch', 'base')]);
	});
});

test('branch: each of the seven allowed paths passes (A for the four new files, M for the three changed ones)', () => {
	assert.deepEqual(guard.OLD_TREE_PATHS, ['skill', 'rules', 'install-claude.sh', 'install-claude.ps1', 'install-cursor.sh', 'install-cursor.ps1', 'version.json']);
	assert.deepEqual(guard.ALLOWED_PATHS, [
		'skill/SKILL.md',
		'skill/scripts/check-setup.js',
		'skill/scripts/lib/__tests__/access-guard.test.js',
		'skill/scripts/migrate-to-plugin.js',
		'skill/scripts/lib/migrate-logic.js',
		'skill/scripts/lib/__tests__/migrate-logic.test.js',
		'skill/scripts/lib/__tests__/migrate-to-plugin.test.js',
	]);
	const entries = [...CHANGED_FILES.map((p) => entry('M', p)), ...NEW_FILES.map((p) => entry('A', p))];
	for (const one of entries) assert.deepEqual(check('branch', [one], BASE, BASE), [], one.path);
	assert.deepEqual(check('branch', entries, BASE, BASE), []);
});

test('branch: a SKILL.md change inside the Plugin migration section passes', () => {
	const section = ['The plugin replaces this skill.', 'Run migrate-to-plugin.js.'];
	const head = { versionJson: BASE.versionJson, skillMd: skillMd({ migration: section }) };
	assert.deepEqual(check('branch', [entry('M', 'skill/SKILL.md')], BASE, head), []);
	const edited = { versionJson: BASE.versionJson, skillMd: skillMd({ migration: [...section, 'One more line.'] }) };
	assert.deepEqual(check('branch', [entry('M', 'skill/SKILL.md')], head, edited), []);

	assert.equal(guard.stripBridgeParts(head.skillMd), guard.stripBridgeParts(BASE.skillMd));
	const stripped = guard.stripBridgeParts(BASE.skillMd);
	assert.ok(!/^version:/m.test(stripped));
	assert.equal(stripped, BASE.skillMd.replace('version: 2.3.13\n', ''));
	const crlf = guard.stripBridgeParts(skillMd({ version: '2.4.0', migration: section, eol: '\r\n' }));
	assert.equal(crlf, guard.stripBridgeParts(skillMd({ eol: '\r\n' })));
	assert.ok(!/(^|[^\r])\n/.test(crlf), 'line endings stay CRLF');
	assert.equal(guard.stripBridgeParts('---\nversion: 1\n---\nbody\n## Plugin migration\nx\ny\n'), '---\n---\nbody\n');
	assert.equal(guard.stripBridgeParts('a\n## Plugin migration'), 'a\n');
	assert.equal(guard.stripBridgeParts('a\n## Plugin migration\nx\n## Next\ny\n'), 'a\n## Next\ny\n');
	for (const same of ['a\n## Plugin migration notes\nb\n', 'a\n### Plugin migration\nb\n', '---\nname: x\n---\nversion: 2\n']) {
		assert.equal(guard.stripBridgeParts(same), same);
	}
});

test('branch: a SKILL.md change outside the section fails', () => {
	const section = ['Run migrate-to-plugin.js.'];
	const e = [entry('M', 'skill/SKILL.md')];
	const heads = [
		skillMd({ tail: 'Hard rule one, changed.' }),
		skillMd({ migration: section }).replace('description: Build, review', 'description: Build, check'),
		skillMd({ migration: section }).replace('## Workflows', '## Workflow'),
		skillMd({ migration: section }).replace('See the scripts folder.', 'See the scripts folder.\n\nversion: 2.3.13'),
		skillMd({ migration: section }).replace('## Plugin migration', '## Plugin migrations'),
		skillMd({ migration: section, eol: '\r\n' }),
	];
	for (const skill of heads) assert.deepEqual(check('branch', e, BASE, { versionJson: BASE.versionJson, skillMd: skill }), [SECTION_FINDING], skill);
	assert.deepEqual(check('release', e, BASE, { versionJson: pair('2.4.0').versionJson, skillMd: skillMd({ version: '2.4.0', tail: 'Changed.' }) }), [SECTION_FINDING]);
});

test('branch: a SKILL.md version change fails', () => {
	const e = [entry('M', 'skill/SKILL.md')];
	assert.deepEqual(check('branch', e, BASE, { versionJson: BASE.versionJson, skillMd: skillMd({ version: '2.4.0' }) }), [skillVersionFinding('2.3.13', '2.4.0')]);
	assert.deepEqual(check('branch', [...e, entry('M', 'version.json')], BASE, pair('2.4.0')), [skillVersionFinding('2.3.13', '2.4.0'), VERSION_JSON_CHANGED]);

	assert.equal(guard.skillVersion(BASE.skillMd), '2.3.13');
	assert.equal(guard.skillVersion(skillMd({ eol: '\r\n' })), '2.3.13');
	assert.equal(guard.skillVersion('---\nname: x\nversion:   2.4.0  \n---\n'), '2.4.0');
	assert.equal(guard.skillVersion('---\nname: x\n---\nversion: 2.4.0\n'), null);
	assert.equal(guard.skillVersion('---\nname: x\nversion: 2.4.0\n'), null);
	assert.equal(guard.skillVersion('# Title\nversion: 2.4.0\n'), null);
	assert.equal(guard.skillVersion(null), null);
});

test('branch: a version.json change fails', () => {
	assert.deepEqual(check('branch', [entry('M', 'version.json')], BASE, BASE), [VERSION_JSON_CHANGED]);
	assert.deepEqual(check('branch', [entry('D', 'version.json')], BASE, BASE), [notAllowed('version.json', 'D'), VERSION_JSON_CHANGED]);
	withRepo({ changes: { 'version.json': versionJson({ released: '2026-11-03' }) } }, (root) => {
		const r = cli(root, ['--mode=branch', '--base=base']);
		assert.equal(r.status, 1);
		assert.deepEqual(r.lines, [`old-tree-guard: ${VERSION_JSON_CHANGED}`, summary(1, 'branch', 'base')]);
	});
});

test('both modes: skill/scripts/download-app.js, rules/make-custom-app.mdc, and install-claude.sh fail', () => {
	const entries = [
		entry('M', 'skill/scripts/download-app.js'),
		entry('M', 'rules/make-custom-app.mdc'),
		entry('M', 'install-claude.sh'),
		entry('A', 'skill/scripts/lib/__tests__/migrate-logic-more.test.js'),
	];
	const expected = entries.map((e) => notAllowed(e.path, e.status));
	assert.deepEqual(check('branch', entries, BASE, BASE), expected);
	assert.deepEqual(check('release', entries, BASE, pair('2.4.0')), expected);
	assert.throws(() => check('sideways', entries, BASE, BASE), /mode/);
	withRepo({ changes: { 'skill/scripts/download-app.js': 'x\n', 'rules/make-custom-app.mdc': 'x\n', 'install-claude.sh': 'x\n' } }, (root) => {
		const r = cli(root, ['--mode=branch', '--base=base']);
		assert.equal(r.status, 1);
		assert.deepEqual(r.lines, [
			`old-tree-guard: ${notAllowed('install-claude.sh', 'M')}`,
			`old-tree-guard: ${notAllowed('rules/make-custom-app.mdc', 'M')}`,
			`old-tree-guard: ${notAllowed('skill/scripts/download-app.js', 'M')}`,
			summary(3, 'branch', 'base'),
		]);
	});
});

test('both modes: deleting skill/scripts/check-setup.js fails, and a rename shows as a deletion', () => {
	for (const mode of ['branch', 'release']) {
		const head = mode === 'release' ? pair('2.4.0') : BASE;
		assert.deepEqual(check(mode, [entry('D', 'skill/scripts/check-setup.js')], BASE, head), [notAllowed('skill/scripts/check-setup.js', 'D')], mode);
		assert.deepEqual(check(mode, [entry('D', 'skill/scripts/migrate-to-plugin.js')], BASE, head), [notAllowed('skill/scripts/migrate-to-plugin.js', 'D')], mode);
	}

	assert.deepEqual(guard.parseNameStatus('D\0skill/scripts/check-setup.js\0A\0skill/scripts/migrate-to-plugin.js\0M\0skill/SKILL.md\0'), [
		entry('D', 'skill/scripts/check-setup.js'),
		entry('A', 'skill/scripts/migrate-to-plugin.js'),
		entry('M', 'skill/SKILL.md'),
	]);
	assert.deepEqual(guard.parseNameStatus(''), []);
	assert.deepEqual(guard.parseNameStatus('A\0skill/a b\nc.js\0'), [entry('A', 'skill/a b\nc.js')]);

	for (const mode of ['branch', 'release']) {
		const changes = mode === 'release' ? { 'version.json': pair('2.4.0').versionJson, 'skill/SKILL.md': pair('2.4.0').skillMd } : {};
		withRepo({ moves: [['skill/scripts/check-setup.js', 'skill/scripts/migrate-to-plugin.js']], changes }, (root) => {
			const r = cli(root, [`--mode=${mode}`, '--base=base']);
			assert.equal(r.status, 1, r.out);
			assert.deepEqual(r.lines, [`old-tree-guard: ${notAllowed('skill/scripts/check-setup.js', 'D')}`, summary(1, mode, 'base')]);
		});
	}
});

test('release: the 2.4.0 pair against a 2.3.13 base passes', () => {
	const entries = [
		entry('M', 'skill/SKILL.md'),
		entry('M', 'version.json'),
		entry('M', 'skill/scripts/check-setup.js'),
		entry('M', 'skill/scripts/lib/__tests__/access-guard.test.js'),
		...NEW_FILES.map((p) => entry('A', p)),
	];
	const head = { versionJson: pair('2.4.0').versionJson, skillMd: skillMd({ version: '2.4.0', migration: ['Run migrate-to-plugin.js.'] }) };
	assert.deepEqual(check('release', entries, BASE, head), []);

	const changes = {
		'version.json': head.versionJson,
		'skill/SKILL.md': head.skillMd,
		'skill/scripts/check-setup.js': "'use strict';\n// migration line\n",
		'skill/scripts/lib/__tests__/access-guard.test.js': "'use strict';\n// wiring\n",
	};
	for (const file of NEW_FILES) changes[file] = "'use strict';\n";
	withRepo({ changes }, (root) => {
		const r = cli(root, ['--mode=release', '--base=base']);
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(r.lines, [summary(0, 'release', 'base')]);
	});
});

test('release: a 2.4.1 bump with a migrate-logic.js fix against a 2.4.0 base passes', () => {
	const entries = [entry('M', 'skill/scripts/lib/migrate-logic.js'), entry('M', 'skill/SKILL.md'), entry('M', 'version.json')];
	assert.deepEqual(check('release', entries, pair('2.4.0'), pair('2.4.1', { released: '2026-11-10' })), []);
	assert.deepEqual(check('release', entries, pair('2.4.9'), pair('2.4.10')), [], 'numbers compare as numbers');
});

test('release: a change outside the old tree passes', () => {
	assert.deepEqual(check('release', [], BASE, BASE), []);
	withRepo({ changes: { 'README.md': 'new\n', 'docs/note.md': 'x\n', 'tools/x.js': '1\n', '.github/x.yml': 'a: 1\n' } }, (root) => {
		const r = cli(root, ['--mode=release', '--base=base']);
		assert.equal(r.status, 0, r.out);
		assert.deepEqual(r.lines, [summary(0, 'release', 'base')]);
	});
});

test('release: an old-tree change without a bump fails', () => {
	const entries = [entry('M', 'skill/scripts/lib/migrate-logic.js')];
	assert.deepEqual(check('release', entries, BASE, BASE), [stillReads('2.3.13'), not24x('2.3.13'), notGreater('2.3.13', '2.3.13')]);
	assert.deepEqual(check('release', entries, pair('2.4.0'), pair('2.4.0')), [stillReads('2.4.0'), notGreater('2.4.0', '2.4.0')]);
	withRepo({ changes: { 'skill/scripts/check-setup.js': "'use strict';\n// changed\n" } }, (root) => {
		const r = cli(root, ['--mode=release', '--base=base']);
		assert.equal(r.status, 1);
		assert.equal(r.lines[0], `old-tree-guard: ${stillReads('2.3.13')}`);
		assert.equal(r.lines.at(-1), summary(3, 'release', 'base'));
	});
});

test('release: unequal versions fail', () => {
	const entries = [entry('M', 'skill/SKILL.md'), entry('M', 'version.json')];
	const head = (jsonVersion, skillVersion) => ({ versionJson: pair(jsonVersion).versionJson, skillMd: skillMd({ version: skillVersion }) });
	assert.deepEqual(check('release', entries, BASE, head('2.4.0', '2.4.1')), [differsFromSkill('2.4.0', '2.4.1')]);
	assert.deepEqual(check('release', entries, BASE, head('2.4.1', '2.4.0')), [differsFromSkill('2.4.1', '2.4.0')]);
	const noVersion = skillMd().replace('version: 2.3.13\n', '');
	assert.deepEqual(check('release', entries, BASE, { versionJson: pair('2.4.0').versionJson, skillMd: noVersion }), [differsFromSkill('2.4.0', null)]);
});

test('release: 2.5.0, 2.3.14, and a lowered 2.4.0 (base 2.4.1) fail', () => {
	const entries = [entry('M', 'skill/SKILL.md'), entry('M', 'version.json')];
	assert.deepEqual(check('release', entries, BASE, pair('2.5.0')), [not24x('2.5.0')]);
	assert.deepEqual(check('release', entries, BASE, pair('2.3.14')), [not24x('2.3.14')]);
	assert.deepEqual(check('release', entries, pair('2.4.1'), pair('2.4.0')), [notGreater('2.4.0', '2.4.1')]);
	assert.deepEqual(check('release', entries, BASE, pair('2.4')), [not24x('2.4'), notGreater('2.4', '2.3.13')]);
	assert.deepEqual(check('release', entries, BASE, pair('3.0.0')), [not24x('3.0.0')]);
});

test('release: a changed update_command_claude fails', () => {
	const entries = [entry('M', 'skill/SKILL.md'), entry('M', 'version.json')];
	const head = (over) => ({ versionJson: pair('2.4.0', over).versionJson, skillMd: skillMd({ version: '2.4.0' }) });
	assert.deepEqual(check('release', entries, BASE, head({ update_command_claude: 'curl -fsSL https://example.com/x.sh | bash' })), [keyDiffers('update_command_claude')]);
	assert.deepEqual(check('release', entries, BASE, head({ extra_key: 1 })), [keyDiffers('extra_key')]);
	assert.deepEqual(check('release', entries, BASE, head({ min_version: undefined })), [keyDiffers('min_version')]);
	assert.deepEqual(check('release', entries, BASE, head({ min_version: '1.0.1', update_command_cursor: 'x' })), [keyDiffers('min_version'), keyDiffers('update_command_cursor')]);

	const good = pair('2.4.0');
	const only = (side, text) => check('release', entries, side === 'base' ? { ...BASE, versionJson: text } : BASE, side === 'base' ? good : { ...good, versionJson: text });
	assert.deepEqual(only('head', '{ not json'), ['version.json: not valid JSON on HEAD']);
	assert.deepEqual(only('base', '{ not json'), ['version.json: not valid JSON on base']);
	assert.deepEqual(only('head', '[]'), ['version.json: not valid JSON on HEAD']);
	assert.deepEqual(only('head', 'null'), ['version.json: not valid JSON on HEAD']);
	assert.deepEqual(only('head', null), ['version.json: not valid JSON on HEAD']);
	assert.deepEqual(check('release', entries, { ...BASE, versionJson: '' }, { ...good, versionJson: '' }), ['version.json: not valid JSON on base', 'version.json: not valid JSON on HEAD']);
});

test('release: a released value that is not a date fails', () => {
	const entries = [entry('M', 'skill/SKILL.md'), entry('M', 'version.json')];
	const head = (released) => ({ versionJson: pair('2.4.0', { released }).versionJson, skillMd: skillMd({ version: '2.4.0' }) });
	for (const bad of ['soon', '2026-11-3', '', '2026-11-03T10:00:00Z', ' 2026-11-03']) {
		assert.deepEqual(check('release', entries, BASE, head(bad)), [notADate(bad)], JSON.stringify(bad));
	}
	assert.deepEqual(check('release', entries, BASE, head(undefined)), [notADate(undefined)]);
	assert.deepEqual(check('release', entries, BASE, head(20261103)), [notADate(20261103)]);
	assert.deepEqual(check('release', entries, BASE, head('2026-11-03')), []);
});

test('cli: exits 2 with the usage line for a missing mode, an unknown mode, a missing base, and a base that starts with a dash', () => {
	const cases = [[], ['--base=base'], ['--mode=branch'], ['--mode=sideways', '--base=base'], ['--mode=', '--base=base'], ['--mode=branch', '--base='], ['--mode=branch', '--base=-x'], ['--mode=release', '--base=--help'], ['--mode=branch', '--base=base', '--verbose'], ['-x', '--mode=branch', '--base=base']];
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'old-tree-guard-empty-'));
	try {
		for (const args of cases) {
			const r = cli(empty, args);
			assert.equal(r.status, 2, args.join(' '));
			assert.equal(r.out, `${USAGE}\n`, args.join(' '));
		}
	} finally {
		fs.rmSync(empty, { recursive: true, force: true });
	}

	const spawnMustNotRun = () => {
		throw new Error('git must not start');
	};
	assert.deepEqual(guard.run({ mode: 'branch', baseRef: '-x', root: empty, env: {}, spawnSync: spawnMustNotRun }), { lines: [USAGE], exitCode: 2 });
	assert.deepEqual(guard.run({ mode: 'other', baseRef: 'base', root: empty, env: {}, spawnSync: spawnMustNotRun }), { lines: [USAGE], exitCode: 2 });
	assert.deepEqual(guard.run({ mode: 'branch', baseRef: '', root: empty, env: {}, spawnSync: spawnMustNotRun }), { lines: [USAGE], exitCode: 2 });
	assert.throws(() => guard.run({ mode: 'branch', baseRef: 'base', root: empty }), /run needs root, env, and spawnSync/);
});

test('cli: exits 2 when the base does not resolve', () => {
	withRepo({ changes: { 'README.md': 'new\n' } }, (root) => {
		for (const base of ['no-such-ref', 'base^{tree}']) {
			const r = cli(root, ['--mode=branch', `--base=${base}`]);
			assert.equal(r.status, 2, base);
			assert.match(r.out, /^old-tree-guard: git failed: \S.*\n$/, base);
			assert.equal(r.out.split('\n').filter(Boolean).length, 1, base);
		}
	});
	const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'old-tree-guard-norepo-'));
	try {
		const r = cli(notARepo, ['--mode=branch', '--base=base']);
		assert.equal(r.status, 2);
		assert.match(r.out, /^old-tree-guard: git failed: fatal: not a git repository/);
	} finally {
		fs.rmSync(notARepo, { recursive: true, force: true });
	}
});

test('cli: prints ::error lines under GitHub Actions and plain lines otherwise', () => {
	const changes = { 'skill/scripts/download-app.js': 'x\n', 'rules/make-custom-app.mdc': 'x\n' };
	withRepo({ changes }, (root) => {
		const plain = cli(root, ['--mode=branch', '--base=base']);
		assert.equal(plain.status, 1);
		assert.deepEqual(plain.lines, [
			`old-tree-guard: ${notAllowed('rules/make-custom-app.mdc', 'M')}`,
			`old-tree-guard: ${notAllowed('skill/scripts/download-app.js', 'M')}`,
			summary(2, 'branch', 'base'),
		]);
		const actions = cli(root, ['--mode=branch', '--base=base'], { GITHUB_ACTIONS: 'true' });
		assert.equal(actions.status, 1);
		assert.deepEqual(actions.lines, [
			`::error::${notAllowed('rules/make-custom-app.mdc', 'M')}`,
			`::error::${notAllowed('skill/scripts/download-app.js', 'M')}`,
			summary(2, 'branch', 'base'),
		]);
		const other = cli(root, ['--mode=branch', '--base=base'], { GITHUB_ACTIONS: 'false' });
		assert.deepEqual(other.lines, plain.lines);
	});
	withRepo({ changes: { 'skill/odd%name\n::error::x': 'x\n' } }, (root) => {
		const r = cli(root, ['--mode=branch', '--base=base'], { GITHUB_ACTIONS: 'true' });
		assert.deepEqual(r.lines, [`::error::${notAllowed('skill/odd%25name%0A::error::x', 'A')}`, summary(1, 'branch', 'base')]);
	});
});

test('cli: the summary line names the mode and the base', () => {
	withRepo({ changes: { 'README.md': 'new\n' } }, (root) => {
		const sha = git(root, 'rev-parse', 'base').trim();
		for (const [mode, base] of [['branch', 'base'], ['release', 'base'], ['branch', sha], ['release', 'HEAD~1']]) {
			const r = cli(root, [`--mode=${mode}`, `--base=${base}`]);
			assert.equal(r.status, 0, r.out);
			assert.equal(r.lines.at(-1), summary(0, mode, base));
		}
	});
});
