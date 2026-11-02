'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const REAL_HOME = os.homedir();
const TEST_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p5-tool-checks-')));
for (const name of ['home', 'tmp', 'claude-config']) fs.mkdirSync(path.join(TEST_ROOT, name));
process.env.HOME = process.env.USERPROFILE = path.join(TEST_ROOT, 'home');
process.env.TMPDIR = process.env.TEMP = process.env.TMP = path.join(TEST_ROOT, 'tmp');
process.env.CLAUDE_CONFIG_DIR = path.join(TEST_ROOT, 'claude-config');

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { atLeastVersion, pluginVersionOfCheckout, pluginVersionDetail, disabledRefusalDetail, isShippedCopy, BACKUP_GREP_LABEL, DISABLED_TEXT, MIN_PLUGIN_VERSION } = require('../migration-test');
const { pluginGuard } = require('../../shared/scripts/lib/legacy-cleanup-steps');

const REPO = path.resolve(__dirname, '..', '..');
const TOOL = path.join(REPO, 'tools', 'migration-test.js');

process.on('exit', () => {
	fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

let caseCounter = 0;
function caseDir(label) {
	const dir = path.join(TEST_ROOT, `${label}-${++caseCounter}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function put(file, content, mode = 0o644) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	fs.chmodSync(file, mode);
}

const step = (status, stdout, stderr = '') => ({ status, signal: null, error: null, stdout, stderr });

test('the test process sees a temporary home', () => {
	assert.ok(os.homedir().startsWith(TEST_ROOT));
	assert.ok(os.tmpdir().startsWith(TEST_ROOT));
	assert.notEqual(os.homedir(), REAL_HOME);
	assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(TEST_ROOT));
});

test('atLeastVersion compares the three numbers of a version, not the text', () => {
	assert.equal(MIN_PLUGIN_VERSION, '3.0.0');
	for (const version of ['3.0.0', '3.0.1', '3.1.0', '4.0.0', '10.0.0', '3.10.0', '3.0.10']) assert.equal(atLeastVersion(version, '3.0.0'), true, version);
	for (const version of ['2.9.9', '2.4.3', '2.99.99', '0.0.0', '3.0.0-rc.1', '3.0', '3', '', 'v3.0.0', '3.0.0.0', 'three', null, undefined, 3]) assert.equal(atLeastVersion(version, '3.0.0'), false, String(version));
	assert.equal(atLeastVersion('3.10.0', '3.9.0'), true);
	assert.equal(atLeastVersion('3.9.0', '3.10.0'), false);
	assert.equal(atLeastVersion('1.2.3', '1.2.3'), true);
	assert.equal(atLeastVersion('1.2.3', '1.2.4'), false);
	assert.equal(atLeastVersion('1.2.3', 'not a version'), false);
});

test('pluginVersionOfCheckout reads the version of the plugin.json of the checkout it is given', () => {
	const root = caseDir('checkout');
	put(path.join(root, '.claude-plugin', 'plugin.json'), '{ "name": "make-custom-app", "version": "3.4.5" }\n');
	assert.equal(pluginVersionOfCheckout(root), '3.4.5');
	const manifest = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8'));
	assert.equal(pluginVersionOfCheckout(), manifest.version);
	assert.equal(atLeastVersion(pluginVersionOfCheckout(), MIN_PLUGIN_VERSION), true);
});

test('pluginVersionDetail passes only for the version of plugin.json when it is at least 3.0.0', () => {
	assert.equal(pluginVersionDetail({ id: 'make-custom-app@make-custom-app', version: '3.0.0' }, '3.0.0'), null);
	assert.equal(pluginVersionDetail({ version: '3.2.1' }, '3.2.1'), null);
	assert.equal(pluginVersionDetail(null, '3.0.0'), 'the plugin is not listed at that version');
	assert.equal(pluginVersionDetail({ version: '3.0.1' }, '3.0.0'), 'the plugin is not listed at that version');
	assert.equal(pluginVersionDetail({ version: '2.9.9' }, '3.0.0'), 'the plugin is not listed at that version');
	assert.equal(pluginVersionDetail({ version: '2.9.9' }, '2.9.9'), "the checkout's plugin.json has version 2.9.9, below 3.0.0");
	assert.equal(pluginVersionDetail({ version: undefined }, undefined), "the checkout's plugin.json has version undefined, below 3.0.0");
});

test('the disabled text is what pluginGuard says for a disabled plugin', () => {
	const guard = pluginGuard({ plugin: { recorded: true, userScope: true, enabled: false, runningFromInstall: true } });
	assert.equal(guard.reason, DISABLED_TEXT);
	assert.notEqual(pluginGuard({ plugin: { recorded: false } }).reason, DISABLED_TEXT);
});

test('disabledRefusalDetail needs exit 2 and the refusal that names the disabled plugin', () => {
	const refusal = `Refused: ${DISABLED_TEXT} Nothing was changed. Fix: claude plugin enable make-custom-app@make-custom-app\n`;
	assert.equal(disabledRefusalDetail(step(2, refusal)), null);
	assert.equal(disabledRefusalDetail(step(2, 'Refused: The make-custom-app plugin is not installed for your user account. Nothing was changed.\n')), 'the output does not say that the plugin is disabled');
	assert.equal(disabledRefusalDetail(step(2, 'Refused: This script does not run from the installed plugin (a; installed at b). Nothing was changed.\n')), 'the output does not say that the plugin is disabled');
	assert.equal(disabledRefusalDetail(step(2, '')), 'the output does not say that the plugin is disabled');
	assert.equal(disabledRefusalDetail(step(2, '', refusal)), 'the output does not say that the plugin is disabled', 'the product prints the refusal to stdout');
	assert.match(disabledRefusalDetail(step(0, refusal)), /^exit 0, expected 2/);
	assert.match(disabledRefusalDetail(step(3, refusal)), /^exit 3, expected 2/);
	assert.match(disabledRefusalDetail({ status: null, signal: 'SIGKILL', error: null, stdout: refusal, stderr: '' }), /^signal SIGKILL, expected 2/);
});

test('the label of the backup check says that byte-identical copies of shipped files are ignored, and why', () => {
	assert.match(BACKUP_GREP_LABEL, /^the migration backup holds no other-server or other-cursor token, and the pinecone key only in kept \.env files and the manifest /);
	assert.match(BACKUP_GREP_LABEL, /byte-identical copies of shipped skill\/ and mcp-server\/ files are ignored/);
	assert.match(BACKUP_GREP_LABEL, /their tests spell the fake values/);
});

test('isShippedCopy ignores only byte-identical copies of files in skill/ and mcp-server/ inside a moved skill folder', () => {
	const backup = caseDir('backup');
	const copy = (rel, source) => {
		put(path.join(backup, rel), fs.readFileSync(path.join(REPO, source)));
		return path.join(backup, rel);
	};
	const suite = 'scripts/lib/__tests__/migrate-logic.test.js';
	assert.equal(isShippedCopy(`claude/skill-dir/${suite}`, copy(`claude/skill-dir/${suite}`, `skill/${suite}`)), true);
	assert.equal(isShippedCopy('cursor/skill-dir/SKILL.md', copy('cursor/skill-dir/SKILL.md', 'skill/SKILL.md')), true);
	assert.equal(isShippedCopy('claude/skill-dir/mcp-server/package.json', copy('claude/skill-dir/mcp-server/package.json', 'mcp-server/package.json')), true);

	const changed = path.join(backup, 'claude', 'skill-dir', suite);
	fs.appendFileSync(changed, '// fake-pinecone-0001\n');
	assert.equal(isShippedCopy(`claude/skill-dir/${suite}`, changed), false, 'a changed copy is a hit');
	put(path.join(backup, 'claude', 'skill-dir', 'mcp-server', '.env'), 'PINECONE_API_KEY=fake-pinecone-0001\n');
	assert.equal(isShippedCopy('claude/skill-dir/mcp-server/.env', path.join(backup, 'claude', 'skill-dir', 'mcp-server', '.env')), false, 'a file the repo does not ship is a hit');
	put(path.join(backup, 'manifest.json'), '{}\n');
	assert.equal(isShippedCopy('manifest.json', path.join(backup, 'manifest.json')), false, 'a file outside skill-dir is a hit');
	copy('claude/other/SKILL.md', 'skill/SKILL.md');
	assert.equal(isShippedCopy('claude/other/SKILL.md', path.join(backup, 'claude', 'other', 'SKILL.md')), false, 'only skill-dir folders count');
	assert.equal(isShippedCopy(`claude/skill-dir/${suite}`, path.join(backup, 'missing')), false, 'an unreadable file is a hit');
});

test('a setup failure prints the tool line only, never the message of the error', () => {
	const bin = caseDir('setup-bin');
	put(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', 0o755);
	const gone = path.join(TEST_ROOT, 'no-such-tmp-folder');
	const result = spawnSync(process.execPath, [TOOL, '--scenario=rerun-a'], {
		env: { HOME: path.join(TEST_ROOT, 'home'), TMPDIR: gone, GITHUB_ACTIONS: 'true', PATH: bin },
		encoding: 'utf8',
		timeout: 20000,
	});
	assert.equal(result.error, undefined, `the tool did not run: ${result.error && result.error.message}`);
	assert.equal(result.status, 1);
	assert.equal(result.stderr, '');
	const lines = result.stdout.trimEnd().split('\n');
	assert.equal(lines.length, 2, result.stdout);
	assert.match(lines[0], /^FAIL rerun-a: setup \(unexpected Error ENOENT at migration-test\.js:\d+\)$/);
	assert.equal(lines[1], 'migration-test: 0 passed, 1 failed');
	assert.ok(!result.stdout.includes('no such file'), 'the message of the error is not printed');
	assert.ok(!result.stdout.includes(gone), 'no path of the error is printed');
	assert.equal(fs.existsSync(gone), false);
});
