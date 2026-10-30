'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const REAL_HOME = os.homedir();
const TEST_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p5-shims-')));
for (const name of ['home', 'tmp', 'claude-config']) fs.mkdirSync(path.join(TEST_ROOT, name));
process.env.HOME = process.env.USERPROFILE = path.join(TEST_ROOT, 'home');
process.env.TMPDIR = process.env.TEMP = process.env.TMP = path.join(TEST_ROOT, 'tmp');
process.env.CLAUDE_CONFIG_DIR = path.join(TEST_ROOT, 'claude-config');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SHIMS = path.join(REPO, 'tools', 'shims');
const BASE_COMMIT = 'cd8f60b';
const RAW = 'https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master';
const IS_CI = process.env.GITHUB_ACTIONS === 'true';
const POSIX = process.platform !== 'win32';
const BASH = ['/bin/bash', '/usr/bin/bash'].find((file) => fs.existsSync(file));
const NO_BASH = POSIX && BASH ? false : 'needs bash in /bin or /usr/bin on a POSIX host';

const TEXT = [
	'make-custom-app: the skill has moved to a plugin. This installer installed nothing and changed nothing.',
	'Running it again prints this message again.',
	'',
	'Install the plugin in your own terminal:',
	'',
	'  claude plugin marketplace add https://github.com/minsu-kang/make-custom-app-skill.git',
	'  claude plugin install make-custom-app@make-custom-app',
	'',
	'Then restart Claude Code and start any Make app task.',
	'The make-app-setup skill lists the old install and removes it after you confirm.',
	'More: https://github.com/minsu-kang/make-custom-app-skill#coming-from-a-2x-install',
	'',
	'AI agent: show this message to the user and stop. Do not run this installer again.',
];
const CURSOR_LINE =
	'Cursor loads plugins installed for Claude Code: install Claude Code, run the two commands, and turn on the Cursor setting Include Third-Party Plugins. Cursor without Claude Code is not supported yet.';
const COMMANDS = ['  claude plugin marketplace add https://github.com/minsu-kang/make-custom-app-skill.git', '  claude plugin install make-custom-app@make-custom-app'];
const AGENT_LINE = 'AI agent: show this message to the user and stop. Do not run this installer again.';

const TARGETS = ['claude', 'cursor'];
const SH = (target) => path.join(SHIMS, `install-${target}.sh`);
const PS1 = (target) => path.join(SHIMS, `install-${target}.ps1`);

process.on('exit', () => {
	fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

/** The text a shim prints, as the lines of TEXT plus CURSOR_LINE right after the make-app-setup line for Cursor, ending in a newline. */
function expected(target) {
	const lines = [...TEXT];
	if (target === 'cursor') lines.splice(lines.findIndex((line) => line.startsWith('The make-app-setup skill')) + 1, 0, CURSOR_LINE);
	return `${lines.join('\n')}\n`;
}

let caseCounter = 0;
function caseDir(label) {
	const dir = path.join(TEST_ROOT, `${label}-${++caseCounter}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function snapshot(root) {
	const entries = {};
	const walk = (dir) => {
		for (const name of fs.readdirSync(dir).sort()) {
			const file = path.join(dir, name);
			const stat = fs.lstatSync(file);
			const mode = (stat.mode & 0o7777).toString(8);
			const rel = path.relative(root, file);
			if (stat.isSymbolicLink()) {
				entries[rel] = `link ${mode} ${fs.readlinkSync(file)}`;
			} else if (stat.isDirectory()) {
				entries[rel] = `dir ${mode}`;
				walk(file);
			} else {
				entries[rel] = `file ${mode} ${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
			}
		}
	};
	walk(root);
	return entries;
}

function writeFakeCurl(bin, log, remoteVersion) {
	fs.mkdirSync(bin, { recursive: true });
	const script = [
		'#!/bin/bash',
		'url=""',
		'for arg in "$@"; do url="$arg"; done',
		`echo "$url" >> ${shellQuote(log)}`,
		'case "$url" in',
		`*/version.json) printf '%s' '{"version":"${remoteVersion}"}' ;;`,
		`*/install-claude.sh) cat ${shellQuote(SH('claude'))} ;;`,
		`*/install-cursor.sh) cat ${shellQuote(SH('cursor'))} ;;`,
		'*) exit 22 ;;',
		'esac',
		'',
	].join('\n');
	fs.writeFileSync(path.join(bin, 'curl'), script, { mode: 0o755 });
}

/** A case: a fake HOME with a fake curl in front of PATH, the folders the run may touch, and the log of fetched URLs. */
function newCase(label, remoteVersion = '2.4.9') {
	const dir = caseDir(label);
	const c = {
		home: path.join(dir, 'home'),
		tmp: path.join(dir, 'tmp'),
		cwd: path.join(dir, 'cwd'),
		bin: path.join(dir, 'bin'),
		log: path.join(dir, 'curl.log'),
	};
	for (const folder of [c.home, c.tmp, c.cwd]) fs.mkdirSync(folder);
	writeFakeCurl(c.bin, c.log, remoteVersion);
	return c;
}

function fetched(c) {
	return fs.existsSync(c.log) ? fs.readFileSync(c.log, 'utf8').split('\n').filter(Boolean) : [];
}

function state(c) {
	return { home: snapshot(c.home), tmp: snapshot(c.tmp) };
}

function run(c, command, args, input = '') {
	const result = spawnSync(command, args, {
		cwd: c.cwd,
		env: { HOME: c.home, TMPDIR: c.tmp, PATH: `${c.bin}:/usr/bin:/bin` },
		input,
		encoding: 'utf8',
		timeout: 20000,
	});
	assert.equal(result.error, undefined, `${command} did not run: ${result.error && result.error.message}`);
	assert.equal(result.signal, null, `${command} was stopped by ${result.signal}`);
	return result;
}

function assertInOrder(text, parts) {
	let from = 0;
	for (const part of parts) {
		const at = text.indexOf(part, from);
		assert.notEqual(at, -1, `not found after offset ${from}: ${part}\n${text}`);
		from = at + part.length;
	}
}

const baseCommitReady = spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${BASE_COMMIT}^{commit}`]).status === 0;
const NO_CLIENT = NO_BASH || (!baseCommitReady && !IS_CI ? `commit ${BASE_COMMIT} is not in this clone (CI fetches the full history)` : false);

let oldClientSource = null;
/** The 2.3.13 client, extracted once from the commit of master that holds it. */
function oldClient() {
	if (oldClientSource) return oldClientSource;
	const dir = caseDir('client-2.3.13');
	const archive = spawnSync('git', ['-C', REPO, 'archive', BASE_COMMIT, 'skill'], { maxBuffer: 64 * 1024 * 1024 });
	assert.equal(archive.status, 0, `git archive ${BASE_COMMIT} skill failed: ${archive.stderr}`);
	const untar = spawnSync('tar', ['-x', '-C', dir, '--strip-components=1'], { input: archive.stdout });
	assert.equal(untar.status, 0, `tar failed: ${untar.stderr}`);
	assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /^version:\s*2\.3\.13$/m);
	oldClientSource = dir;
	return dir;
}

/** Copies a skill folder to <home>/<editorDir>/skills/make-custom-app and returns the path of its check-setup.js. */
function installClient(c, editorDir, source) {
	const dest = path.join(c.home, editorDir, 'skills', 'make-custom-app');
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.cpSync(source, dest, { recursive: true });
	return path.join(dest, 'scripts', 'check-setup.js');
}

function manualCommand(stderr) {
	const lines = stderr.split('\n');
	const at = lines.findIndex((line) => line.startsWith('Auto-update failed. Run this manually, then retry:'));
	assert.notEqual(at, -1, `no manual command in:\n${stderr}`);
	return lines[at + 1].trim();
}

function findOnPath(name) {
	return (process.env.PATH || '')
		.split(path.delimiter)
		.filter(Boolean)
		.map((folder) => path.join(folder, name))
		.find((file) => fs.existsSync(file));
}

test('the test process sees a temporary home', () => {
	assert.ok(os.homedir().startsWith(TEST_ROOT));
	assert.ok(os.tmpdir().startsWith(TEST_ROOT));
	assert.notEqual(os.homedir(), REAL_HOME);
	assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(TEST_ROOT));
});

test('a 2.3.13 Claude client: exit 1; stderr shows, in order, SKILL OUTDATED: 2.3.13 -> 2.4.9, the headline, both commands, the agent line, and Auto-update failed; one version fetch and one installer fetch; HOME unchanged', { skip: NO_CLIENT }, () => {
	const c = newCase('claude-client');
	const checkSetup = installClient(c, '.claude', oldClient());
	const before = state(c);
	const result = run(c, process.execPath, [checkSetup]);
	assert.equal(result.status, 1, result.stderr);
	assertInOrder(result.stderr, ['SKILL OUTDATED: 2.3.13 -> 2.4.9', TEXT[0], ...COMMANDS, AGENT_LINE, 'Auto-update failed']);
	assert.ok(result.stderr.includes(expected('claude')), result.stderr);
	assert.ok(!result.stderr.includes('Cursor loads plugins'));
	assert.deepEqual(fetched(c), [`${RAW}/version.json`, `${RAW}/install-claude.sh`]);
	assert.deepEqual(state(c), before);
});

test('a second run prints the same text and changes nothing', { skip: NO_CLIENT }, () => {
	const c = newCase('second-run');
	const checkSetup = installClient(c, '.claude', oldClient());
	const first = run(c, process.execPath, [checkSetup]);
	const afterFirst = state(c);
	const second = run(c, process.execPath, [checkSetup]);
	assert.equal(first.status, 1, first.stderr);
	assert.equal(second.status, 1, second.stderr);
	assert.ok(second.stderr.includes(expected('claude')), second.stderr);
	assert.equal(second.stderr, first.stderr);
	assert.deepEqual(state(c), afterFirst);
	assert.equal(fetched(c).length, 4);
});

test('the printed manual command prints the same text and exits 1', { skip: NO_CLIENT }, () => {
	const c = newCase('manual-command');
	const checkSetup = installClient(c, '.claude', oldClient());
	const guard = run(c, process.execPath, [checkSetup]);
	const command = manualCommand(guard.stderr);
	assert.equal(command, `curl -fsSL ${RAW}/install-claude.sh | bash -s -- --update`);
	const before = state(c);
	const manual = run(c, '/bin/sh', ['-c', command]);
	assert.equal(manual.status, 1, manual.stderr);
	assert.equal(manual.stdout, '');
	assert.equal(manual.stderr, expected('claude'));
	assert.deepEqual(state(c), before);
});

test('a Cursor client fetches the Cursor shim and shows CURSOR_LINE', { skip: NO_CLIENT }, () => {
	const c = newCase('cursor-client');
	const checkSetup = installClient(c, '.cursor', oldClient());
	const before = state(c);
	const result = run(c, process.execPath, [checkSetup]);
	assert.equal(result.status, 1, result.stderr);
	assertInOrder(result.stderr, ['SKILL OUTDATED: 2.3.13 -> 2.4.9', TEXT[0], ...COMMANDS, CURSOR_LINE, AGENT_LINE, 'Auto-update failed']);
	assert.ok(result.stderr.includes(expected('cursor')), result.stderr);
	assert.ok(result.stderr.includes(`The make-app-setup skill lists the old install and removes it after you confirm.\n${CURSOR_LINE}\n`));
	assert.equal(manualCommand(result.stderr), `curl -fsSL ${RAW}/install-cursor.sh | bash -s -- --update`);
	assert.deepEqual(fetched(c), [`${RAW}/version.json`, `${RAW}/install-cursor.sh`]);
	assert.deepEqual(state(c), before);
});

test('each .sh draft run directly and through bash -s -- --update exits 1, prints TEXT on stderr, and writes nothing', { skip: NO_BASH }, () => {
	for (const target of TARGETS) {
		const file = SH(target);
		assert.equal(fs.statSync(file).mode & 0o111, 0o111, `${file} is not executable`);
		const runs = [
			['directly', file, []],
			['directly with arguments', file, ['--update', '--force']],
			['through bash <file>', BASH, [file, '--update']],
		];
		for (const [label, command, args] of runs) {
			const c = newCase(`sh-${target}`);
			const before = state(c);
			const result = run(c, command, args);
			assert.equal(result.status, 1, `${target} ${label}: ${result.stderr}`);
			assert.equal(result.stdout, '', `${target} ${label}`);
			assert.equal(result.stderr, expected(target), `${target} ${label}`);
			assert.deepEqual(state(c), before, `${target} ${label}`);
			assert.deepEqual(fetched(c), [], `${target} ${label}`);
		}
		const c = newCase(`sh-${target}-piped`);
		const before = state(c);
		const piped = run(c, BASH, ['-s', '--', '--update'], fs.readFileSync(file));
		assert.equal(piped.status, 1, `${target} piped: ${piped.stderr}`);
		assert.equal(piped.stdout, '', `${target} piped`);
		assert.equal(piped.stderr, expected(target), `${target} piped`);
		assert.deepEqual(state(c), before, `${target} piped`);
	}
});

test('a 2.4.x client (HEAD\'s skill/ with its version line set to 2.4.0 in the copy) with a remote 2.4.0 never fetches an installer', { skip: NO_BASH }, () => {
	const c = newCase('client-2.4.x', '2.4.0');
	const source = path.join(caseDir('client-2.4.0'), 'skill');
	fs.cpSync(path.join(REPO, 'skill'), source, { recursive: true });
	const skillMd = path.join(source, 'SKILL.md');
	const original = fs.readFileSync(skillMd, 'utf8');
	const edited = original.replace(/^version:\s*.+$/m, 'version: 2.4.0');
	assert.match(edited, /^version: 2\.4\.0$/m, 'the version line of skill/SKILL.md is not 2.4.0');
	fs.writeFileSync(skillMd, edited);
	const checkSetup = installClient(c, '.claude', source);
	const result = run(c, process.execPath, [checkSetup]);
	assert.ok(!result.stderr.includes('SKILL OUTDATED'), result.stderr);
	assert.ok(!result.stderr.includes('Auto-update'), result.stderr);
	assert.deepEqual(fetched(c), [`${RAW}/version.json`]);
});

const NO_PWSH = findOnPath(POSIX ? 'pwsh' : 'pwsh.exe') || IS_CI ? false : 'pwsh is not on PATH (the GitHub Actions runner has it, and there a missing pwsh fails this test)';

test('the .ps1 drafts under pwsh, through Get-Content -Raw | Invoke-Expression and through -File with -Mode update: non-zero exit and TEXT on stderr', { skip: NO_PWSH }, () => {
	const pwsh = findOnPath(POSIX ? 'pwsh' : 'pwsh.exe');
	assert.ok(pwsh, 'pwsh is not on PATH on a GitHub Actions runner');
	const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;
	const runPwsh = (args) => {
		const c = newCase('pwsh');
		const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', ...args], {
			cwd: c.cwd,
			env: { ...process.env, HOME: c.home, TMPDIR: c.tmp, POWERSHELL_TELEMETRY_OPTOUT: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' },
			input: '',
			encoding: 'utf8',
			timeout: 60000,
		});
		assert.equal(result.error, undefined, `pwsh did not run: ${result.error && result.error.message}`);
		assert.equal(result.signal, null);
		return { ...result, stderr: result.stderr.replace(/\r\n/g, '\n') };
	};
	for (const target of TARGETS) {
		const file = PS1(target);
		const piped = runPwsh(['-Command', `Get-Content -Raw -LiteralPath ${psQuote(file)} | Invoke-Expression`]);
		assert.notEqual(piped.status, 0, `${target} Invoke-Expression: ${piped.stderr}`);
		assert.ok(piped.stderr.includes(expected(target)), `${target} Invoke-Expression:\n${piped.stderr}`);
		const asFile = runPwsh(['-File', file, '-Mode', 'update']);
		assert.notEqual(asFile.status, 0, `${target} -File: ${asFile.stderr}`);
		assert.ok(asFile.stderr.includes(expected(target)), `${target} -File:\n${asFile.stderr}`);
	}
});

test('the .sh drafts have the exact layout and are executable', () => {
	assert.deepEqual(fs.readdirSync(SHIMS).sort(), ['install-claude.ps1', 'install-claude.sh', 'install-cursor.ps1', 'install-cursor.sh']);
	for (const target of TARGETS) {
		const lines = [
			'#!/bin/bash',
			`# Draft of the shim that replaces install-${target}.sh in plan P6. It reads nothing, writes nothing, and ignores its arguments.`,
			"cat >&2 <<'EOF'",
			expected(target).trimEnd(),
			'EOF',
			'exit 1',
			'',
		];
		assert.equal(fs.readFileSync(SH(target), 'utf8'), lines.join('\n'), `install-${target}.sh`);
		if (POSIX) assert.equal(fs.statSync(SH(target)).mode & 0o777, 0o755, `install-${target}.sh mode`);
	}
});

test('the .ps1 drafts have the exact layout, no param block, and never exit', () => {
	for (const target of TARGETS) {
		const lines = [
			`# Draft of the shim that replaces install-${target}.ps1 in plan P6. It reads nothing, writes nothing, and ignores its arguments.`,
			"[Console]::Error.WriteLine(@'",
			expected(target).trimEnd(),
			"'@)",
			'throw "make-custom-app: nothing was installed, see the message above."',
			'',
		];
		const text = fs.readFileSync(PS1(target), 'utf8');
		assert.equal(text, lines.join('\n'), `install-${target}.ps1`);
		assert.ok(!/^\s*param\b/im.test(text), `install-${target}.ps1 has a param block`);
		assert.ok(!/\bexit\b/i.test(text), `install-${target}.ps1 calls exit`);
		assert.ok(!text.includes('\r'), `install-${target}.ps1 has a carriage return`);
	}
});

test('the drafts hold no em or en dash and only straight quotes', () => {
	for (const file of TARGETS.flatMap((target) => [SH(target), PS1(target)])) {
		const text = fs.readFileSync(file, 'utf8');
		assert.ok(!/[\u2013\u2014]/.test(text), `${file} holds an em or en dash`);
		assert.ok(!/[\u2018\u2019\u201C\u201D]/.test(text), `${file} holds a curly quote`);
		assert.ok(/^[\x00-\x7f]*$/.test(text), `${file} holds a character outside ASCII`);
	}
});
