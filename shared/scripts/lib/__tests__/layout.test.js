/**
 * Guards the plugin layout of shared/scripts: every file parses, every lib module loads on its own,
 * and nothing refers to the old skill layout (the old paths belong only to legacy-install.js).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS_DIR = path.resolve(__dirname, '..', '..');
const LIB_DIR = path.join(SCRIPTS_DIR, 'lib');

/** Files that name the old layout on purpose: they forbid it or detect it. */
const OLD_LAYOUT_ALLOWED = new Set(['entry-scripts.test.js', 'legacy-install.js', 'legacy-install.test.js', 'layout.test.js']);
const OLD_LAYOUT = /skill-root|version-guard|ensureFreshSkill|getSkillRoot|getEditorDir|\bSKILL_ROOT\b|\bCONTEXTS_DIR\b|skills\/make-custom-app|\.claude\/skills|\.cursor\/skills/;

/** Scripts that must not call the account check: they report the account item themselves. */
const NO_GUARD = new Set(['check-setup.js', 'setup-secrets.js']);

/** Tests that may spell out a Cursor settings path: they test the path rule itself. */
const CURSOR_PATH_ALLOWED = new Set(['settings.test.js', 'layout.test.js']);
const CURSOR_PATH = /Application Support|AppData\/Roaming|\.config\/Cursor/;
const GUARD_CALL = /require\('\.\/lib\/access-guard'\)\.ensureInternalUser\(\)/;
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/.*$/gm;

/** True when the source calls the account check outside of comments. */
function hasGuardCall(source) {
	return GUARD_CALL.test(source.replace(COMMENTS, ''));
}

function listJs(dir) {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) => {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) return listJs(full);
			return entry.name.endsWith('.js') ? [full] : [];
		})
		.sort();
}

const ALL_FILES = listJs(SCRIPTS_DIR);
const ENTRY_SCRIPTS = fs
	.readdirSync(SCRIPTS_DIR)
	.filter((name) => name.endsWith('.js'))
	.sort();
const LIB_MODULES = fs
	.readdirSync(LIB_DIR)
	.filter((name) => name.endsWith('.js'))
	.map((name) => path.join(LIB_DIR, name));

describe('hasGuardCall', () => {
	const CALL = "require('./lib/access-guard').ensureInternalUser();";

	it('finds a real call', () => {
		assert.equal(hasGuardCall(`#!/usr/bin/env node\n${CALL}\nconst x = 1;\n`), true);
	});

	it('ignores the same call inside a line comment or a block comment', () => {
		assert.equal(hasGuardCall(`// ${CALL}\nconst x = 1;\n`), false);
		assert.equal(hasGuardCall(`const x = 1; // ${CALL}\n`), false);
		assert.equal(hasGuardCall(`/*\n${CALL}\n*/\nconst x = 1;\n`), false);
		assert.equal(hasGuardCall(`/** ${CALL} */\n`), false);
	});
});

describe('shared/scripts layout', () => {
	let home;
	let env;

	before(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-test-'));
		env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home };
	});

	after(() => {
		if (home) fs.rmSync(home, { recursive: true, force: true });
	});

	it('finds the scripts to check', () => {
		assert.ok(ALL_FILES.length > 30, `only ${ALL_FILES.length} files found`);
		assert.ok(LIB_MODULES.length >= 10, `only ${LIB_MODULES.length} lib modules found`);
	});

	it('every entry script calls the account check, except check-setup and setup-secrets', () => {
		assert.ok(ENTRY_SCRIPTS.length >= 14, `only ${ENTRY_SCRIPTS.length} entry scripts found`);
		const callsGuard = (name) => hasGuardCall(fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf-8'));
		assert.deepEqual(ENTRY_SCRIPTS.filter((name) => !NO_GUARD.has(name) && !callsGuard(name)), []);
		assert.deepEqual([...NO_GUARD].filter(callsGuard), []);
	});

	it('every file passes node --check', () => {
		const failures = ALL_FILES.map((file) => ({ file, run: spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8', env }) }))
			.filter(({ run }) => run.status !== 0)
			.map(({ file, run }) => `${path.relative(SCRIPTS_DIR, file)}: ${run.stderr.trim().split('\n')[0]}`);
		assert.deepEqual(failures, []);
	});

	it('every lib module loads on its own in a fake HOME', () => {
		const failures = LIB_MODULES.map((file) => ({
			file,
			run: spawnSync(process.execPath, ['-e', 'require(process.argv[1])', file], { encoding: 'utf-8', env }),
		}))
			.filter(({ run }) => run.status !== 0)
			.map(({ file, run }) => `${path.basename(file)}: ${run.stderr.trim().split('\n')[0]}`);
		assert.deepEqual(failures, []);
	});

	it('no test builds a Cursor settings path by hand, the platform decides it', () => {
		const tests = fs.readdirSync(path.join(__dirname)).filter((name) => name.endsWith('.test.js') && !CURSOR_PATH_ALLOWED.has(name));
		assert.ok(tests.length >= 10, `only ${tests.length} test files found`);
		assert.deepEqual(tests.filter((name) => CURSOR_PATH.test(fs.readFileSync(path.join(__dirname, name), 'utf-8'))), []);
	});

	it('nothing outside the legacy detection names the old layout', () => {
		const offenders = ALL_FILES.filter((file) => !OLD_LAYOUT_ALLOWED.has(path.basename(file)))
			.filter((file) => OLD_LAYOUT.test(fs.readFileSync(file, 'utf-8')))
			.map((file) => path.relative(SCRIPTS_DIR, file));
		assert.deepEqual(offenders, []);
	});
});
