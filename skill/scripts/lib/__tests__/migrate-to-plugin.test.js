'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const REAL_HOME = os.homedir();
const TEST_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p5-old-int-')));
for (const name of ['home', 'tmp', 'claude-config']) fs.mkdirSync(path.join(TEST_ROOT, name));
process.env.HOME = process.env.USERPROFILE = path.join(TEST_ROOT, 'home');
process.env.TMPDIR = process.env.TEMP = process.env.TMP = path.join(TEST_ROOT, 'tmp');
process.env.CLAUDE_CONFIG_DIR = path.join(TEST_ROOT, 'claude-config');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { cacheKey, JIRA_BASE_URL } = require('../access-guard-logic');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SKILL_SOURCE = path.join(REPO_ROOT, 'skill');
const BASE_COMMIT = 'cd8f60b';
const ID = 'make-custom-app@make-custom-app';
const DAY = 24 * 3600000;
const POSIX_ONLY = { skip: process.platform === 'win32' };
const BLOCK_NETWORK = path.join(TEST_ROOT, 'block-network.js');
const SECTION_BYTES = 891;
const PINNED_SECTION =
	'## Plugin migration\n\n' +
	'check-setup.js can print one `PLUGIN_MIGRATION: <state> | <text>` line. Act on it before other work, also when check-setup exits 1 (the plugin needs the same setup). `ask`: ask the user once, yes or no: "Install the make-custom-app plugin? It replaces this skill and copies your MCP keys and app contexts; nothing is deleted." Never answer for the user. On yes, run the `migrate-to-plugin.js` command printed on the line (Shell, `required_permissions: ["all"]`); on no, continue. `handoff`: do the steps of the line in order. Other states: tell the user the text once, then continue. `migrate-to-plugin.js` exit 0: relay its last lines. Exit 3: this skill was just updated; re-read this file, then run the command again. Exit 1, 4, or 5: relay its output; this skill keeps working. Then continue the user\'s task. Do the steps of a `handoff` line once per conversation.\n\n';

fs.writeFileSync(BLOCK_NETWORK, "require('net').Socket.prototype.connect = function () {\n\tthrow new Error('network access is blocked in this test');\n};\n");

process.on('exit', () => {
	fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function copyTree(from, to) {
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const source = path.join(from, entry.name);
		const target = path.join(to, entry.name);
		if (entry.isDirectory()) copyTree(source, target);
		else if (entry.isFile()) fs.copyFileSync(source, target);
	}
}

let caseCounter = 0;

function makeCase({ editor = 'claude', claudeOnPath = false } = {}) {
	const root = path.join(TEST_ROOT, `case-${++caseCounter}`);
	const home = path.join(root, 'home');
	const tmp = path.join(root, 'tmp');
	const binDir = path.join(root, 'bin');
	for (const dir of [home, tmp, binDir]) fs.mkdirSync(dir, { recursive: true });
	const skillRoot = path.join(home, `.${editor}`, 'skills', 'make-custom-app');
	copyTree(SKILL_SOURCE, skillRoot);
	if (claudeOnPath) {
		fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 97\n');
		fs.chmodSync(path.join(binDir, 'claude'), 0o755);
	}
	const env = { PATH: binDir, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, NODE_OPTIONS: `--require ${BLOCK_NETWORK}` };
	const script = path.join(skillRoot, 'scripts', 'check-setup.js');
	return {
		root,
		home,
		tmp,
		binDir,
		skillRoot,
		script,
		throttleFile: path.join(tmp, `make-custom-app-plugin-prompt-${typeof process.getuid === 'function' ? process.getuid() : 'user'}.json`),
		run(extraArgs = [], envOverride = {}) {
			const result = spawnSync(process.execPath, [script, '--skip-version', ...extraArgs], {
				cwd: home,
				env: { ...env, ...envOverride },
				encoding: 'utf8',
				timeout: 60000,
			});
			assert.equal(result.error, undefined, 'check-setup.js did not run');
			return result;
		},
	};
}

function recordPlugin(home, { enabled } = {}) {
	const config = path.join(home, '.claude');
	const installPath = path.join(config, 'plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0');
	fs.mkdirSync(path.join(installPath, '.claude-plugin'), { recursive: true });
	fs.writeFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), '{"name":"make-custom-app","version":"3.0.0"}');
	fs.writeFileSync(
		path.join(config, 'plugins', 'installed_plugins.json'),
		JSON.stringify({ version: 2, plugins: { [ID]: [{ scope: 'user', installPath, version: '3.0.0' }] } }),
	);
	if (enabled !== undefined) fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { [ID]: enabled } }));
	return installPath;
}

function writeDecline(home, declinedAt) {
	const dir = path.join(home, '.make-custom-app');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'legacy-cleanup.json'), JSON.stringify({ schema: 1, declinedAt: new Date(declinedAt).toISOString(), digest: '0123456789abcdef' }));
}

const FAKE_JIRA = { email: 'fake.user@make.com', token: 'fake-jira-token-0001' };
const FAKE_MAKE_KEY = 'fake-make-token-0001';

function seedCompleteSetup(c) {
	const runtimeDir = path.join(c.root, 'imt-app-runtime');
	fs.mkdirSync(runtimeDir);
	const secrets = [`imt-app-runtime-path: ${runtimeDir}`, `make-api-key: ${FAKE_MAKE_KEY}`, `jira-email: ${FAKE_JIRA.email}`, `jira-api-token: ${FAKE_JIRA.token}`];
	fs.writeFileSync(path.join(c.home, '.make-custom-app-skill-secrets'), `${secrets.join('\n')}\n`, { mode: 0o600 });
	const key = cacheKey({ baseUrl: JIRA_BASE_URL, email: FAKE_JIRA.email, token: FAKE_JIRA.token });
	fs.writeFileSync(path.join(c.tmp, 'make-custom-app-access-check.json'), JSON.stringify({ key, email: FAKE_JIRA.email, checkedAt: Date.now() }));
}

function migrationLines(result) {
	return result.stdout.split('\n').filter((line) => line.startsWith('PLUGIN_MIGRATION: '));
}

function jsonOf(result) {
	return JSON.parse(result.stdout);
}

function splitLines(text) {
	return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function skillMdParts() {
	const head = splitLines(fs.readFileSync(path.join(SKILL_SOURCE, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n'));
	const start = head.findIndex((line) => line === '## Plugin migration\n');
	assert.ok(start > 0, 'the section heading is missing');
	const next = head.findIndex((line, index) => index > start && line.startsWith('## '));
	assert.ok(next > start, 'no heading follows the section');
	return { head, start, next };
}

function dropVersionLine(lines) {
	const first = lines.findIndex((line) => line.replace(/\r?\n$/, '') === '---');
	const second = lines.findIndex((line, index) => index > first && line.replace(/\r?\n$/, '') === '---');
	const at = lines.findIndex((line, index) => index > first && index < second && line.startsWith('version:'));
	return at === -1 ? lines : [...lines.slice(0, at), ...lines.slice(at + 1)];
}

function readBaseSkillMd() {
	const shown = spawnSync('git', ['show', `${BASE_COMMIT}:skill/SKILL.md`], { cwd: REPO_ROOT, encoding: 'utf8' });
	if (shown.error || shown.status !== 0) return { skip: `git or commit ${BASE_COMMIT} is not available`, text: '' };
	return { skip: false, text: shown.stdout };
}

const BASE_SKILL_MD = readBaseSkillMd();

describe('test isolation', () => {
	it('the test process sees a temporary home', () => {
		assert.ok(os.homedir().startsWith(TEST_ROOT));
		assert.ok(os.tmpdir().startsWith(TEST_ROOT));
		assert.notEqual(os.homedir(), REAL_HOME);
		assert.ok(require('../settings').SECRETS_PATH.startsWith(TEST_ROOT));
		assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(TEST_ROOT));
	});
});

describe('check-setup.js PLUGIN_MIGRATION', () => {
	it('prints ask once, then nothing within 24 hours', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		const first = c.run();
		const lines = migrationLines(first);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: ask \| /);
		assert.ok(lines[0].endsWith(`Yes runs: node '${path.join(c.skillRoot, 'scripts', 'migrate-to-plugin.js')}'`));
		assert.equal(first.stderr, '');
		assert.equal(JSON.parse(fs.readFileSync(c.throttleFile, 'utf8')).state, 'ask');
		assert.equal(fs.statSync(c.throttleFile).mode & 0o777, 0o600);
		const second = c.run();
		assert.deepEqual(migrationLines(second), []);
		assert.equal(second.stderr, '');
	});

	it('prints ask from the Cursor install when claude is on PATH', POSIX_ONLY, () => {
		const c = makeCase({ editor: 'cursor', claudeOnPath: true });
		const lines = migrationLines(c.run());
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: ask \| /);
		assert.ok(lines[0].includes(path.join(c.home, '.cursor', 'skills', 'make-custom-app', 'scripts', 'migrate-to-plugin.js')));
	});

	it('prints handoff once the plugin is recorded, although ask was shown before', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		assert.match(migrationLines(c.run())[0], /^PLUGIN_MIGRATION: ask \| /);
		assert.deepEqual(migrationLines(c.run()), []);
		recordPlugin(c.home, { enabled: true });
		const lines = migrationLines(c.run());
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: handoff \| /);
	});

	it('prints handoff on two runs in a row', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		recordPlugin(c.home, { enabled: true });
		for (let run = 0; run < 2; run++) {
			const lines = migrationLines(c.run());
			assert.equal(lines.length, 1, `run ${run + 1}`);
			assert.match(lines[0], /^PLUGIN_MIGRATION: handoff \| /);
		}
	});

	it('the Claude handoff names the migrate command first and then the Skill tool; the Cursor handoff names the migrate command first and then <installPath>/skills/make-app-setup/SKILL.md', POSIX_ONLY, () => {
		const claude = makeCase({ editor: 'claude' });
		recordPlugin(claude.home, { enabled: true });
		const claudeLine = migrationLines(claude.run())[0];
		const migrate = `node '${path.join(claude.skillRoot, 'scripts', 'migrate-to-plugin.js')}'`;
		assert.ok(claudeLine.includes(`1. Run ${migrate} `));
		const skillTool = claudeLine.indexOf('Skill tool with make-custom-app:make-app-setup');
		assert.ok(skillTool !== -1);
		assert.ok(claudeLine.indexOf(migrate) < skillTool);
		assert.ok(!claudeLine.includes('SKILL.md'));

		const cursor = makeCase({ editor: 'cursor' });
		const installPath = recordPlugin(cursor.home, { enabled: true });
		const cursorLine = migrationLines(cursor.run())[0];
		const cursorMigrate = `node '${path.join(cursor.skillRoot, 'scripts', 'migrate-to-plugin.js')}'`;
		const target = `${installPath}/skills/make-app-setup/SKILL.md`;
		assert.ok(cursorLine.includes(`1. Run ${cursorMigrate} `));
		assert.ok(cursorLine.includes(target));
		assert.ok(cursorLine.indexOf(cursorMigrate) < cursorLine.indexOf(target));
		assert.ok(!cursorLine.includes('Skill tool'));
	});

	it('prints nothing while a decline marker is younger than 7 days', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		recordPlugin(c.home, { enabled: true });
		writeDecline(c.home, Date.now() - DAY);
		const result = c.run();
		assert.deepEqual(migrationLines(result), []);
		assert.equal(result.stderr, '');
		assert.equal(jsonOf(c.run(['--json'])).pluginMigration, null);
	});

	it('prints handoff again once the decline marker is older than 7 days', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		recordPlugin(c.home, { enabled: true });
		writeDecline(c.home, Date.now() - 8 * DAY);
		assert.match(migrationLines(c.run())[0], /^PLUGIN_MIGRATION: handoff \| /);
	});

	it('prints inactive for a disabled plugin', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		recordPlugin(c.home, { enabled: false });
		const lines = migrationLines(c.run());
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: inactive \| /);
		assert.ok(lines[0].endsWith(`run in your own terminal: claude plugin enable ${ID}`));
		assert.deepEqual(migrationLines(c.run()), []);
		const report = jsonOf(c.run(['--json'])).pluginMigration;
		assert.equal(report.state, 'inactive');
		assert.equal(report.reason, 'disabled');
		assert.equal(report.claudeBin, null);
		assert.equal(report.command, `claude plugin enable ${ID}`);
		assert.equal(report.due, false);
	});

	it('prints unsupported from the Cursor install when CLAUDE_BIN names a missing file', POSIX_ONLY, () => {
		const c = makeCase({ editor: 'cursor', claudeOnPath: true });
		const missing = { CLAUDE_BIN: path.join(c.home, 'nowhere', 'claude') };
		const lines = migrationLines(c.run([], missing));
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: unsupported \| /);
		const report = jsonOf(c.run(['--json'], missing)).pluginMigration;
		assert.equal(report.state, 'unsupported');
		assert.equal(report.claudeBin, null);
		assert.equal(report.command, null);
	});

	it('prints ask from the Claude install when CLAUDE_BIN names a missing file', POSIX_ONLY, () => {
		const c = makeCase({ editor: 'claude', claudeOnPath: true });
		const missing = { CLAUDE_BIN: path.join(c.home, 'nowhere', 'claude') };
		const lines = migrationLines(c.run([], missing));
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: ask \| /);
		const report = jsonOf(c.run(['--json'], missing)).pluginMigration;
		assert.equal(report.state, 'ask');
		assert.equal(report.claudeBin, null);
	});

	it('the line comes right before the final Setup line, and the exit code equals the run without the line', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		const withLine = c.run();
		const without = c.run();
		assert.equal(migrationLines(withLine).length, 1);
		assert.equal(migrationLines(without).length, 0);
		assert.equal(withLine.status, without.status);
		assert.equal(withLine.status, 1);
		const lines = withLine.stdout.split('\n');
		const setup = lines.findIndex((line) => line.startsWith('Setup '));
		assert.ok(setup > 3);
		assert.match(lines[setup], /^Setup INCOMPLETE/);
		assert.equal(lines[setup - 1], '');
		assert.match(lines[setup - 2], /^PLUGIN_MIGRATION: ask \| /);
		assert.equal(lines[setup - 3], '');
		const removed = lines.filter((line, index) => index !== setup - 2 && index !== setup - 3);
		assert.equal(removed.join('\n'), without.stdout);
	});

	it('prints the line before Setup OK. and exits 0 when every required item is set', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		seedCompleteSetup(c);
		const withLine = c.run();
		assert.equal(withLine.status, 0);
		assert.equal(withLine.stderr, '');
		const lines = withLine.stdout.split('\n');
		const setup = lines.indexOf('Setup OK.');
		assert.ok(setup > 3);
		assert.equal(lines[setup - 1], '');
		assert.match(lines[setup - 2], /^PLUGIN_MIGRATION: ask \| /);
		assert.equal(lines[setup - 3], '');
		assert.match(withLine.stdout, /^OK +make account: fake\.user@make\.com$/m);
		const without = c.run();
		assert.equal(without.status, 0);
		assert.equal(migrationLines(without).length, 0);
		assert.equal(without.stdout, lines.filter((line, index) => index !== setup - 2 && index !== setup - 3).join('\n'));
		assert.equal(withLine.stdout.includes(FAKE_JIRA.token) || withLine.stdout.includes(FAKE_MAKE_KEY), false);
		const report = jsonOf(c.run(['--json']));
		assert.equal(report.ok, true);
		assert.equal(report.pluginMigration.state, 'ask');
		assert.equal(report.pluginMigration.due, false);
	});

	it('--json reports pluginMigration with due and writes no throttle file', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		for (let run = 0; run < 2; run++) {
			const result = c.run(['--json']);
			assert.equal(result.status, 1);
			assert.equal(result.stderr, '');
			const report = jsonOf(result).pluginMigration;
			assert.deepEqual(Object.keys(report).sort(), ['claudeBin', 'command', 'due', 'reason', 'state']);
			assert.equal(report.state, 'ask');
			assert.equal(report.reason, 'not-recorded');
			assert.equal(report.due, true);
			assert.equal(report.claudeBin, path.join(c.binDir, 'claude'));
			assert.equal(report.command, `node '${path.join(c.skillRoot, 'scripts', 'migrate-to-plugin.js')}'`);
			assert.equal(fs.existsSync(c.throttleFile), false);
		}
		recordPlugin(c.home, { enabled: true });
		const handoff = jsonOf(c.run(['--json'])).pluginMigration;
		assert.equal(handoff.state, 'handoff');
		assert.equal(handoff.reason, null);
		assert.equal(handoff.claudeBin, null);
		assert.equal(handoff.due, true);
		assert.equal(fs.existsSync(c.throttleFile), false);
	});

	it('an unwritable TMPDIR prints the line on every run', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		const unwritable = { TMPDIR: path.join(c.root, 'no-such-folder'), TEMP: path.join(c.root, 'no-such-folder'), TMP: path.join(c.root, 'no-such-folder') };
		for (let run = 0; run < 3; run++) {
			const result = c.run([], unwritable);
			const lines = migrationLines(result);
			assert.equal(lines.length, 1, `run ${run + 1}`);
			assert.match(lines[0], /^PLUGIN_MIGRATION: ask \| /);
			assert.equal(result.stderr, '');
		}
		assert.equal(fs.existsSync(path.join(c.root, 'no-such-folder')), false);
	});

	it('a malformed installed_plugins.json gives ask and no crash', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		fs.mkdirSync(path.join(c.home, '.claude', 'plugins'), { recursive: true });
		fs.writeFileSync(path.join(c.home, '.claude', 'plugins', 'installed_plugins.json'), '{ "plugins": { "make-custom-app@make-custom-app": [');
		const result = c.run();
		assert.equal(result.status, 1);
		assert.equal(result.stderr, '');
		const lines = migrationLines(result);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: ask \| /);
		assert.equal(jsonOf(c.run(['--json'])).pluginMigration.reason, 'unreadable');
	});

	it('fails open: a migrate-logic.js that cannot load changes neither the exit code nor stderr and prints no line', POSIX_ONLY, () => {
		const baseline = makeCase({ claudeOnPath: true });
		const expected = baseline.run(['--json']);
		const c = makeCase({ claudeOnPath: true });
		fs.writeFileSync(path.join(c.skillRoot, 'scripts', 'lib', 'migrate-logic.js'), "throw new Error('boom from migrate-logic');\n");
		const human = c.run();
		assert.equal(human.status, expected.status);
		assert.equal(human.stderr, '');
		assert.equal(human.stdout.includes('PLUGIN_MIGRATION'), false);
		assert.equal(human.stdout.includes('boom'), false);
		assert.match(human.stdout, /\nSetup INCOMPLETE/);
		const json = c.run(['--json']);
		assert.equal(json.status, expected.status);
		assert.equal(json.stderr, '');
		assert.equal(jsonOf(json).pluginMigration, null);
		const summary = (result) => jsonOf(result).items.map((item) => `${item.key}:${item.status}`);
		assert.deepEqual(summary(json), summary(expected));
		assert.equal(jsonOf(json).ok, jsonOf(expected).ok);
	});

	it('SKILL.md: the Plugin migration section equals the pinned text', () => {
		const { head, start, next } = skillMdParts();
		assert.equal(head[next], '## Workflows\n');
		const lines = head.slice(start, next);
		assert.equal(lines.join(''), PINNED_SECTION);
		assert.equal(Buffer.byteLength(PINNED_SECTION), SECTION_BYTES);
		assert.equal(lines.filter((line) => line.startsWith('## ')).length, 1);
		assert.ok(!PINNED_SECTION.includes('```'));
	});

	it('SKILL.md: without the section and without the version line the file equals cd8f60b', { skip: BASE_SKILL_MD.skip }, () => {
		const { head, start, next } = skillMdParts();
		const rest = [...head.slice(0, start), ...head.slice(next)];
		assert.equal(dropVersionLine(rest).join(''), dropVersionLine(splitLines(BASE_SKILL_MD.text)).join(''));
	});
});
