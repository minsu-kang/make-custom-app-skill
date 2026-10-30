/**
 * Guards the plugin layout of shared/scripts: every file parses, every lib module loads on its own,
 * nothing refers to the old skill layout (the old paths belong only to legacy-install.js), and every entry script
 * strips --editor before it reads process.argv for anything else.
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
const OLD_LAYOUT_ALLOWED = new Set(['entry-scripts.test.js', 'fake-legacy-home.js', 'legacy-cleanup-logic.test.js', 'legacy-cleanup-steps.test.js', 'legacy-install.js', 'legacy-install.test.js', 'layout.test.js']);
const OLD_LAYOUT = /skill-root|version-guard|ensureFreshSkill|getSkillRoot|getEditorDir|\bSKILL_ROOT\b|\bCONTEXTS_DIR\b|skills\/make-custom-app|\.claude\/skills|\.cursor\/skills/;

/** Scripts that must not call the account check: they report the account item themselves. */
const NO_GUARD = new Set(['check-setup.js', 'setup-secrets.js']);
const GUARD_CALL = /require\('\.\/lib\/access-guard'\)\.ensureInternalUser\(\)/;

/** Scripts that parse --editor themselves instead of stripping it first with takeEditorFlagOrExit. */
const OWN_EDITOR_PARSER = new Set(['setup-secrets.js']);
const TAKE_FLAG = /\btakeEditorFlagOrExit\(process\.argv\)/;

/** Tests that may spell out a Cursor settings path: they test the path rule itself. */
const CURSOR_PATH_ALLOWED = new Set(['settings.test.js', 'layout.test.js']);
const CURSOR_PATH = /Application Support|AppData\/Roaming|\.config\/Cursor/;

/**
 * Removes // and block comments from JS source. Strings, template literals and regex literals are copied as they are,
 * so a `//` or a quote inside one does not hide code.
 */
function stripComments(source) {
	const REGEX_AFTER = '(,=:[!&|?{};+-*%<>~^';
	const REGEX_KEYWORDS = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do)$/;
	let out = '';
	let i = source.startsWith('#!') ? source.indexOf('\n') : 0;
	if (i === -1) return '';
	while (i < source.length) {
		const ch = source[i];
		const next = source[i + 1];
		let end = i + 1;
		if (ch === '/' && next === '/') {
			while (i < source.length && source[i] !== '\n') i++;
			continue;
		}
		if (ch === '/' && next === '*') {
			const close = source.indexOf('*/', i + 2);
			i = close === -1 ? source.length : close + 2;
			out += ' ';
			continue;
		}
		const before = out.trimEnd();
		if (ch === '"' || ch === "'" || ch === '`') {
			while (end < source.length && source[end] !== ch) end += source[end] === '\\' ? 2 : 1;
			end++;
		} else if (ch === '/' && (!before || REGEX_AFTER.includes(before.slice(-1)) || REGEX_KEYWORDS.test(before))) {
			for (let inClass = false; end < source.length && (inClass || source[end] !== '/'); end++) {
				if (source[end] === '\\') end++;
				else if (source[end] === '[') inClass = true;
				else if (source[end] === ']') inClass = false;
			}
			end++;
		}
		out += source.slice(i, end);
		i = end;
	}
	return out;
}

/** True when the source calls the account check outside of comments. */
function hasGuardCall(source) {
	return GUARD_CALL.test(stripComments(source));
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

describe('stripComments', () => {
	const compact = (code) => stripComments(code).replace(/\s+/g, ' ').trim();

	it('removes line and block comments', () => {
		assert.equal(compact('a(); // b()\nc(); /* d() */ e();\n'), 'a(); c(); e();');
		assert.equal(compact('/**\n * process.argv\n */\nx();'), 'x();');
	});

	it('keeps code after a // that sits inside a string or a template literal', () => {
		const code = "const url = 'http://x'; f(process.argv);\nconst b = \"//\"; g(process.argv);\nconst t = `//${process.argv}`;";
		assert.equal(stripComments(code), code);
	});

	it('keeps a regex literal with quotes or slashes in it, and the code after it', () => {
		const withQuotes = 'const m = line.match(/^([A-Z_]+)\\s*=\\s*"?([^"]*)"?\\s*$/);\nuse(process.argv);';
		assert.equal(stripComments(withQuotes), withQuotes);
		const withSlash = "x = /[/']/.test(y); z(process.argv);";
		assert.equal(stripComments(withSlash), withSlash);
	});

	it('leaves a division alone and drops a shebang line', () => {
		assert.equal(compact('const r = a / b; // c\n'), 'const r = a / b;');
		assert.equal(compact('#!/usr/bin/env node\nrun();'), 'run();');
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

	for (const name of ENTRY_SCRIPTS.filter((file) => !OWN_EDITOR_PARSER.has(file))) {
		it(`${name} strips --editor before it reads process.argv for anything else`, () => {
			const code = stripComments(fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf-8'));
			const call = TAKE_FLAG.exec(code);
			assert.ok(call, `${name} does not call takeEditorFlagOrExit(process.argv)`);
			assert.equal(code.indexOf('process.argv'), call.index + call[0].indexOf('process.argv'), `${name} reads process.argv before it strips --editor`);
		});
	}

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
