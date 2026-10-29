'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const REAL_HOME = os.homedir();
const TEST_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p5-old-unit-')));
for (const name of ['home', 'tmp', 'claude-config']) fs.mkdirSync(path.join(TEST_ROOT, name));
process.env.HOME = process.env.USERPROFILE = path.join(TEST_ROOT, 'home');
process.env.TMPDIR = process.env.TEMP = process.env.TMP = path.join(TEST_ROOT, 'tmp');
process.env.CLAUDE_CONFIG_DIR = path.join(TEST_ROOT, 'claude-config');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../migrate-logic');

const ID = 'make-custom-app@make-custom-app';
const CMD_ENABLE = 'claude plugin enable make-custom-app@make-custom-app';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const POSIX_ONLY = { skip: process.platform === 'win32' };

process.on('exit', () => {
	fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

let caseCounter = 0;
function caseDir(label) {
	const dir = path.join(TEST_ROOT, `${label}-${++caseCounter}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function enoent() {
	return Object.assign(new Error('no such file'), { code: 'ENOENT' });
}

function recorded(entries, id = ID) {
	return JSON.stringify({ version: 2, plugins: { [id]: entries } });
}

function installPlugin(cfg, { enabled, scope = 'user' } = {}) {
	const installPath = path.join(cfg, 'plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0');
	fs.mkdirSync(path.join(installPath, '.claude-plugin'), { recursive: true });
	fs.writeFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), '{}');
	fs.writeFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), recorded([{ scope, installPath, version: '3.0.0' }]));
	if (enabled !== undefined) fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: { [ID]: enabled } }));
	return installPath;
}

function fakeFs(files, manifests = []) {
	const reads = [];
	return {
		reads,
		readFileSync(file) {
			reads.push(file);
			const value = files.get(file);
			const next = Array.isArray(value) ? (value.length > 1 ? value.shift() : value[0]) : value;
			if (next === undefined) throw enoent();
			if (next instanceof Error) throw next;
			return next;
		},
		statSync(file) {
			if (!manifests.includes(file)) throw enoent();
			return { isFile: () => true };
		},
	};
}

describe('test isolation', () => {
	it('the test process sees a temporary home', () => {
		assert.ok(os.homedir().startsWith(TEST_ROOT));
		assert.ok(os.tmpdir().startsWith(TEST_ROOT));
		assert.notEqual(os.homedir(), REAL_HOME);
		assert.ok(require('../settings').SECRETS_PATH.startsWith(TEST_ROOT));
		assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(TEST_ROOT));
	});
});

describe('required parameters', () => {
	it('requireParams names every required parameter and counts only undefined as missing', () => {
		assert.equal(logic.requireParams('f', { a: null, b: 0, c: '' }, ['a', 'b', 'c']), undefined);
		assert.throws(() => logic.requireParams('f', {}, ['a']), { name: 'TypeError', message: 'f needs a' });
		assert.throws(() => logic.requireParams('f', undefined, ['a', 'b']), { name: 'TypeError', message: 'f needs a and b' });
		assert.throws(() => logic.requireParams('f', { a: 1 }, ['a', 'b', 'c']), { name: 'TypeError', message: 'f needs a, b, and c' });
	});

	it('every function that touches a folder throws a TypeError without env, home, or tmpdir', () => {
		const full = {
			claudeConfigDir: ['env and home', { env: {}, home: '/h' }],
			readPluginStatus: ['env and home', { env: {}, home: '/h' }],
			findClaudeBinary: ['env, home, and platform', { env: {}, home: '/h', platform: 'linux' }],
			throttleFile: ['tmpdir', { tmpdir: '/t' }],
			readDeclinedAt: ['home', { home: '/h' }],
			migrationNotice: ['env, home, tmpdir, platform, skillRoot, and editorDir', { env: {}, home: '/h', tmpdir: '/t', platform: 'linux', skillRoot: '/s', editorDir: '.claude' }],
		};
		for (const [name, [names, params]] of Object.entries(full)) {
			const expected = { name: 'TypeError', message: `${name} needs ${names}` };
			assert.throws(() => logic[name](), expected, `${name} without arguments`);
			assert.throws(() => logic[name]({}), expected, `${name} with an empty object`);
			for (const key of Object.keys(params)) {
				const partial = { ...params };
				delete partial[key];
				assert.throws(() => logic[name](partial), expected, `${name} without ${key}`);
			}
		}
	});
});

describe('constants', () => {
	it('exports the fixed values of the plan', () => {
		assert.equal(logic.PLUGIN_ID, ID);
		assert.equal(logic.MARKETPLACE_NAME, 'make-custom-app');
		assert.equal(logic.MARKETPLACE_URL, 'https://github.com/minsu-kang/make-custom-app-skill.git');
		assert.equal(logic.MIN_PLUGIN_VERSION, '3.0.0');
		assert.deepEqual(logic.PROMPT_INTERVAL_MS, { ask: DAY, inactive: DAY, unsupported: 30 * DAY });
		assert.equal(logic.DECLINE_TTL_MS, 7 * DAY);
		assert.equal(logic.CLAUDE_VERSION_PATTERN.test('2.1.312 (Claude Code)'), true);
		assert.equal(logic.CLAUDE_VERSION_PATTERN.test('2.1.312'), false);
	});
});

describe('claudeConfigDir', () => {
	it('claudeConfigDir uses CLAUDE_CONFIG_DIR, else <home>/.claude', () => {
		assert.equal(logic.claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '/cfg/dir' }, home: '/h' }), '/cfg/dir');
		assert.equal(logic.claudeConfigDir({ env: {}, home: '/h' }), path.join('/h', '.claude'));
		assert.equal(logic.claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '' }, home: '/h' }), path.join('/h', '.claude'));
	});
});

describe('isOurPluginId and parseInstalledPlugins', () => {
	it('isOurPluginId matches make-custom-app on either side of @ only', () => {
		for (const id of [ID, 'make-custom-app@other', 'other@make-custom-app', 'make-custom-app']) assert.equal(logic.isOurPluginId(id), true, id);
		for (const id of ['my-make-custom-app@x', 'make-custom-app-2@x', 'x@make-custom-app.old', 'other@market', '', 'Make-Custom-App@x']) assert.equal(logic.isOurPluginId(id), false, id);
		for (const id of [undefined, null, 5, {}]) assert.equal(logic.isOurPluginId(id), false, String(id));
	});

	it('parseInstalledPlugins reads the plugins map, a top-level map, an object entry, and rejects text that is not JSON', () => {
		const entry = { scope: 'user', installPath: '/p/3.0.0', version: '3.0.0', installedAt: 'x' };
		const want = { id: ID, scope: 'user', installPath: '/p/3.0.0', version: '3.0.0' };
		assert.deepEqual(logic.parseInstalledPlugins(recorded([entry])), { ok: true, entries: [want] });
		assert.deepEqual(logic.parseInstalledPlugins(JSON.stringify({ [ID]: [entry] })), { ok: true, entries: [want] });
		assert.deepEqual(logic.parseInstalledPlugins(JSON.stringify({ plugins: { [ID]: entry } })), { ok: true, entries: [want] });
		assert.deepEqual(logic.parseInstalledPlugins(JSON.stringify({ version: 2, plugins: 'x', [ID]: entry })), { ok: true, entries: [want] });
		assert.deepEqual(logic.parseInstalledPlugins(recorded([entry, { scope: 'project', installPath: '/q', version: '2.9.0' }])).entries.map((e) => e.scope), ['user', 'project']);
		assert.deepEqual(logic.parseInstalledPlugins(recorded([{ installPath: '/p', version: '3.0.0' }])).entries, [{ id: ID, scope: 'user', installPath: '/p', version: '3.0.0' }]);
		assert.deepEqual(logic.parseInstalledPlugins(recorded([{ scope: '', installPath: 5 }])).entries, [{ id: ID, scope: 'user', installPath: null, version: null }]);
		assert.deepEqual(logic.parseInstalledPlugins(recorded([null, 'x', 7, [entry]])).entries, []);
		assert.deepEqual(logic.parseInstalledPlugins(recorded(7)).entries, []);
		assert.deepEqual(logic.parseInstalledPlugins(JSON.stringify({ plugins: { 'other@market': [entry], 'x@make-custom-app': [entry] } })).entries.map((e) => e.id), ['x@make-custom-app']);
		assert.deepEqual(logic.parseInstalledPlugins('{}'), { ok: true, entries: [] });
		for (const text of ['', '{"plug', 'not json', '[]', '[{"a":1}]', 'null', '7', '"text"', 'true']) assert.deepEqual(logic.parseInstalledPlugins(text), { ok: false, entries: [] }, text);
	});
});

describe('pluginStatus', () => {
	const hasManifest = (installPath) => installPath.startsWith('/ok/');
	const status = (installedText, settingsText, has = hasManifest) => logic.pluginStatus({ installedText, settingsText, hasManifest: has });
	const entry = (scope, installPath, version = '3.0.0') => ({ scope, installPath, version });
	const absent = (reason) => ({ status: 'absent', reason, id: null, installPath: null, version: null });
	const settingsWith = (value) => JSON.stringify({ enabledPlugins: { [ID]: value } });

	it('pluginStatus: usable for a user entry with a manifest', () => {
		const want = { status: 'usable', reason: null, id: ID, installPath: '/ok/3.0.0', version: '3.0.0' };
		assert.deepEqual(status(recorded([entry('user', '/ok/3.0.0')]), settingsWith(true)), want);
		assert.deepEqual(status(recorded([entry('user', '/ok/3.0.0')]), null), want);
		assert.deepEqual(status(recorded([entry('user', '/ok/3.0.0')]), '{}'), want);
		assert.deepEqual(status(recorded([entry('user', '/ok/3.0.0')]), JSON.stringify({ enabledPlugins: { other: false } })), want);
	});

	it('pluginStatus: managed scope and a missing scope count as user', () => {
		assert.equal(status(recorded([entry('managed', '/ok/m')]), null).status, 'usable');
		assert.equal(status(recorded([{ installPath: '/ok/n', version: '3.0.0' }]), null).status, 'usable');
		const seen = [];
		const result = status(recorded([entry('project', '/ok/p'), entry('user', '/nope/u'), entry('local', '/ok/l'), entry('user', '/ok/second')]), null, (p) => (seen.push(p), hasManifest(p)));
		assert.equal(result.installPath, '/ok/second');
		assert.deepEqual(seen, ['/nope/u', '/ok/second']);
	});

	it('pluginStatus: inactive/disabled when enabledPlugins[id] is false', () => {
		assert.deepEqual(status(recorded([entry('user', '/ok/3.0.0')]), settingsWith(false)), { status: 'inactive', reason: 'disabled', id: ID, installPath: '/ok/3.0.0', version: '3.0.0' });
		for (const value of [true, 0, 'false', null]) assert.equal(status(recorded([entry('user', '/ok/3.0.0')]), settingsWith(value)).status, 'usable', String(value));
		const other = 'make-custom-app@other';
		assert.deepEqual(status(recorded([entry('user', '/ok/o')], other), JSON.stringify({ enabledPlugins: { [other]: false } })), { status: 'inactive', reason: 'disabled', id: other, installPath: '/ok/o', version: '3.0.0' });
	});

	it('pluginStatus: absent/project-only, absent/cache-missing, absent/not-recorded, absent/unreadable', () => {
		assert.deepEqual(status(recorded([entry('project', '/ok/p'), entry('local', '/ok/l')]), null), absent('project-only'));
		assert.deepEqual(status(recorded([entry('user', '/nope/u'), entry('managed', '/nope/m')]), null), absent('cache-missing'));
		assert.deepEqual(status(recorded([entry('project', '/ok/p'), entry('user', '/nope/u')]), null), absent('cache-missing'));
		assert.deepEqual(status(recorded([{ scope: 'user', installPath: 7 }]), null), absent('cache-missing'));
		assert.deepEqual(status(null, null), absent('not-recorded'));
		assert.deepEqual(status(undefined, null), absent('not-recorded'));
		assert.deepEqual(status('{}', null), absent('not-recorded'));
		assert.deepEqual(status(JSON.stringify({ version: 2, plugins: { 'other@market': [entry('user', '/ok/x')] } }), null), absent('not-recorded'));
		assert.deepEqual(status('{"plugins": {"make-cu', null), absent('unreadable'));
		assert.deepEqual(status('', null), absent('unreadable'));
	});

	it('pluginStatus: unreadable settings count as enabled', () => {
		for (const settingsText of ['{"enabledPlugins": {"make-cu', '', 'null', '[]', '7', JSON.stringify({ enabledPlugins: 'x' }), JSON.stringify({ enabledPlugins: null })]) {
			assert.equal(status(recorded([entry('user', '/ok/3.0.0')]), settingsText).status, 'usable', settingsText);
		}
	});
});

describe('readPluginStatus', () => {
	const cfg = path.join('/cfg', 'dir');
	const installedFile = path.join(cfg, 'plugins', 'installed_plugins.json');
	const settingsFile = path.join(cfg, 'settings.json');
	const installPath = path.join(cfg, 'plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0');
	const manifest = path.join(installPath, '.claude-plugin', 'plugin.json');
	const good = recorded([{ scope: 'user', installPath, version: '3.0.0' }]);
	const run = (files, extra = {}) => {
		const sleeps = [];
		const stub = fakeFs(files, [manifest]);
		const result = logic.readPluginStatus({ env: { CLAUDE_CONFIG_DIR: cfg }, home: '/h', fs: stub, sleep: (ms) => sleeps.push(ms), ...extra });
		return { result, sleeps, reads: stub.reads };
	};

	it('readPluginStatus reads once more after 50 ms when the JSON is torn', () => {
		const torn = run(new Map([[installedFile, ['{"version":2,"plug', good]]]));
		assert.equal(torn.result.status, 'usable');
		assert.deepEqual(torn.sleeps, [50]);
		assert.equal(torn.reads.filter((f) => f === installedFile).length, 2);

		const stuck = run(new Map([[installedFile, '{"version":2,"plug']]));
		assert.deepEqual(stuck.result, { status: 'absent', reason: 'unreadable', id: null, installPath: null, version: null });
		assert.deepEqual(stuck.sleeps, [50]);

		const settingsTorn = run(
			new Map([
				[installedFile, good],
				[settingsFile, ['{"enabledPl', JSON.stringify({ enabledPlugins: { [ID]: false } })]],
			]),
		);
		assert.equal(settingsTorn.result.status, 'inactive');
		assert.deepEqual(settingsTorn.sleeps, [50]);
	});

	it('readPluginStatus: a missing file is not recorded without a second read, other read errors are unreadable', () => {
		const missing = run(new Map());
		assert.deepEqual(missing.result, { status: 'absent', reason: 'not-recorded', id: null, installPath: null, version: null });
		assert.deepEqual(missing.sleeps, []);
		assert.deepEqual(missing.reads.filter((file) => file === installedFile), [installedFile]);

		const notDir = run(new Map([[installedFile, Object.assign(new Error('x'), { code: 'ENOTDIR' })]]));
		assert.equal(notDir.result.reason, 'not-recorded');

		const denied = run(new Map([[installedFile, Object.assign(new Error('x'), { code: 'EACCES' })]]));
		assert.equal(denied.result.reason, 'unreadable');
		assert.deepEqual(denied.sleeps, [50]);
	});

	it('readPluginStatus: the folder is <home>/.claude when CLAUDE_CONFIG_DIR is unset, and a stat error means no manifest', () => {
		const home = path.join('/h', 'two');
		const file = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
		const stub = fakeFs(new Map([[file, good]]));
		const result = logic.readPluginStatus({ env: {}, home, fs: stub, sleep: () => assert.fail('no sleep expected') });
		assert.deepEqual(stub.reads, [file, path.join(home, '.claude', 'settings.json')]);
		assert.equal(result.reason, 'cache-missing');
	});

	it('readPluginStatus: real files give usable, then inactive after the plugin is disabled', () => {
		const home = caseDir('rps');
		const config = path.join(home, '.claude');
		installPlugin(config, { enabled: true });
		const params = { env: {}, home };
		const usable = logic.readPluginStatus(params);
		assert.equal(usable.status, 'usable');
		assert.equal(usable.id, ID);
		assert.equal(usable.version, '3.0.0');
		fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { [ID]: false } }));
		assert.equal(logic.readPluginStatus(params).status, 'inactive');
		fs.rmSync(path.join(usable.installPath, '.claude-plugin', 'plugin.json'));
		assert.equal(logic.readPluginStatus(params).reason, 'cache-missing');
		fs.rmSync(path.join(config, 'plugins'), { recursive: true });
		assert.equal(logic.readPluginStatus(params).reason, 'not-recorded');
	});

	it('readPluginStatus: the default sleep waits about 50 ms before the second read', () => {
		const home = caseDir('rps-sleep');
		fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
		fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), '{"torn');
		const started = Date.now();
		const result = logic.readPluginStatus({ env: {}, home });
		assert.ok(Date.now() - started >= 40);
		assert.equal(result.reason, 'unreadable');
	});
});

describe('findClaudeBinary', () => {
	const exec = (...yes) => {
		const calls = [];
		const isExecutable = (file) => (calls.push(file), yes.includes(file));
		return { calls, isExecutable };
	};

	it('findClaudeBinary: CLAUDE_BIN wins, and a CLAUDE_BIN that is not executable stops the search', () => {
		const first = exec('/custom/claude', '/a/claude');
		assert.deepEqual(logic.findClaudeBinary({ env: { CLAUDE_BIN: '/custom/claude', PATH: '/a' }, platform: 'linux', home: '/h', isExecutable: first.isExecutable }), { bin: '/custom/claude', explicit: true });
		assert.deepEqual(first.calls, ['/custom/claude']);

		const second = exec('/a/claude', '/h/.local/bin/claude');
		assert.deepEqual(logic.findClaudeBinary({ env: { CLAUDE_BIN: '/custom/missing', PATH: '/a' }, platform: 'linux', home: '/h', isExecutable: second.isExecutable }), { bin: null, explicit: true });
		assert.deepEqual(second.calls, ['/custom/missing']);

		const third = exec('/a/claude');
		assert.deepEqual(logic.findClaudeBinary({ env: { CLAUDE_BIN: '', PATH: '/a' }, platform: 'linux', home: '/h', isExecutable: third.isExecutable }), { bin: '/a/claude', explicit: false });
	});

	it('findClaudeBinary: PATH order on POSIX', () => {
		const run = exec('/b/claude', '/c/claude');
		const found = logic.findClaudeBinary({ env: { PATH: '/a::/b:/c:' }, platform: 'linux', home: '/h', isExecutable: run.isExecutable });
		assert.deepEqual(found, { bin: '/b/claude', explicit: false });
		assert.deepEqual(run.calls, ['/a/claude', '/b/claude']);
		const ignored = exec();
		logic.findClaudeBinary({ env: { Path: '/z' }, platform: 'darwin', home: '/h', isExecutable: ignored.isExecutable });
		assert.ok(!ignored.calls.includes('/z/claude'));
	});

	it('findClaudeBinary: Windows reads Path, tries claude.exe before claude.cmd, then the Windows fallbacks', () => {
		const onPath = exec('C:\\b\\claude.cmd');
		assert.deepEqual(logic.findClaudeBinary({ env: { Path: 'C:\\a;;"C:\\Program Files\\b"' }, platform: 'win32', home: 'C:\\Users\\u', isExecutable: onPath.isExecutable }), { bin: null, explicit: false });
		assert.deepEqual(onPath.calls.slice(0, 4), ['C:\\a\\claude.exe', 'C:\\a\\claude.cmd', 'C:\\Program Files\\b\\claude.exe', 'C:\\Program Files\\b\\claude.cmd']);

		const second = exec('C:\\b\\claude.cmd', 'C:\\b\\claude.exe');
		assert.deepEqual(logic.findClaudeBinary({ env: { Path: 'C:\\a;C:\\b' }, platform: 'win32', home: 'C:\\Users\\u', isExecutable: second.isExecutable }), { bin: 'C:\\b\\claude.exe', explicit: false });
		assert.deepEqual(second.calls, ['C:\\a\\claude.exe', 'C:\\a\\claude.cmd', 'C:\\b\\claude.exe']);

		const upper = exec('C:\\u\\claude.exe');
		assert.equal(logic.findClaudeBinary({ env: { PATH: 'C:\\u' }, platform: 'win32', home: 'C:\\Users\\u', isExecutable: upper.isExecutable }).bin, 'C:\\u\\claude.exe');

		const odd = exec('C:\\v\\claude.exe');
		assert.equal(logic.findClaudeBinary({ env: { pAtH: 'C:\\v' }, platform: 'win32', home: 'C:\\Users\\u', isExecutable: odd.isExecutable }).bin, 'C:\\v\\claude.exe');

		const fallbacks = exec('C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd');
		const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
		assert.deepEqual(logic.findClaudeBinary({ env, platform: 'win32', home: 'C:\\Users\\u', isExecutable: fallbacks.isExecutable }), { bin: 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd', explicit: false });
		assert.deepEqual(fallbacks.calls, ['C:\\Users\\u\\.local\\bin\\claude.exe', 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd']);

		const noAppData = exec();
		assert.deepEqual(logic.findClaudeBinary({ env: {}, platform: 'win32', home: 'C:\\Users\\u', isExecutable: noAppData.isExecutable }), { bin: null, explicit: false });
		assert.deepEqual(noAppData.calls, ['C:\\Users\\u\\.local\\bin\\claude.exe']);

		const explicit = exec('C:\\tools\\claude.cmd');
		assert.deepEqual(logic.findClaudeBinary({ env: { CLAUDE_BIN: 'C:\\tools\\claude.cmd' }, platform: 'win32', home: 'C:\\Users\\u', isExecutable: explicit.isExecutable }), { bin: 'C:\\tools\\claude.cmd', explicit: true });
	});

	it('findClaudeBinary: the POSIX fallback folders in order, and null when nothing is found', () => {
		const fallbacks = ['/h/.local/bin/claude', '/h/.claude/local/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
		const none = exec();
		assert.deepEqual(logic.findClaudeBinary({ env: { PATH: '/a:/b' }, platform: 'linux', home: '/h', isExecutable: none.isExecutable }), { bin: null, explicit: false });
		assert.deepEqual(none.calls, ['/a/claude', '/b/claude', ...fallbacks]);
		for (const [index, want] of fallbacks.entries()) {
			const run = exec(...fallbacks.slice(index));
			assert.deepEqual(logic.findClaudeBinary({ env: {}, platform: 'darwin', home: '/h', isExecutable: run.isExecutable }), { bin: want, explicit: false });
			assert.deepEqual(run.calls, fallbacks.slice(0, index + 1));
		}
	});

	it('findClaudeBinary: the default check accepts an executable file only', POSIX_ONLY, () => {
		const dir = caseDir('fcb');
		const good = path.join(dir, 'claude');
		const plain = path.join(dir, 'plain');
		fs.writeFileSync(good, '#!/bin/sh\n');
		fs.chmodSync(good, 0o755);
		fs.writeFileSync(plain, 'x');
		fs.chmodSync(plain, 0o644);
		const find = (bin) => logic.findClaudeBinary({ env: { CLAUDE_BIN: bin }, platform: process.platform, home: dir });
		assert.deepEqual(find(good), { bin: good, explicit: true });
		assert.deepEqual(find(plain), { bin: null, explicit: true });
		assert.deepEqual(find(dir), { bin: null, explicit: true });
		assert.deepEqual(find(path.join(dir, 'missing')), { bin: null, explicit: true });
	});
});

describe('promptState and shouldShow', () => {
	const NOW = 1900000000000;

	it('promptState: the state table', () => {
		const state = (extra) => logic.promptState({ status: 'absent', claudeBin: null, editorDir: '.cursor', declinedAt: null, now: NOW, ...extra });
		assert.equal(state({ status: 'usable' }), 'handoff');
		assert.equal(state({ status: 'usable', declinedAt: NOW - HOUR }), null);
		assert.equal(state({ status: 'usable', declinedAt: NOW }), null);
		assert.equal(state({ status: 'usable', declinedAt: NOW - 6 * DAY }), null);
		assert.equal(state({ status: 'usable', declinedAt: NOW - 8 * DAY }), 'handoff');
		assert.equal(state({ status: 'usable', declinedAt: NOW - logic.DECLINE_TTL_MS }), 'handoff');
		assert.equal(state({ status: 'usable', declinedAt: NOW + HOUR }), 'handoff');
		for (const declinedAt of [NaN, '2026-10-20', undefined]) assert.equal(state({ status: 'usable', declinedAt }), 'handoff', String(declinedAt));
		assert.equal(state({ status: 'inactive' }), 'inactive');
		assert.equal(state({ status: 'inactive', declinedAt: NOW - HOUR }), 'inactive');
		assert.equal(state({ claudeBin: '/x/claude', editorDir: '.cursor' }), 'ask');
		assert.equal(state({ claudeBin: null, editorDir: '.claude' }), 'ask');
		assert.equal(state({ claudeBin: '/x/claude', editorDir: '.claude' }), 'ask');
		assert.equal(state({ claudeBin: null, editorDir: '.cursor' }), 'unsupported');
		assert.equal(state({ status: 'unknown' }), null);
	});

	it('shouldShow: handoff always; no cache, a malformed cache, a changed state, a future stamp, 23 and 25 hours, 29 and 31 days for unsupported', () => {
		const show = (cache, state, now = NOW) => logic.shouldShow({ cache, state, now });
		assert.equal(show({ state: 'handoff', shownAt: NOW }, 'handoff'), true);
		assert.equal(show({ state: 'handoff', shownAt: NOW + DAY }, 'handoff'), true);
		for (const cache of [null, undefined, [], 'text', 7, {}, { state: 'ask' }, { shownAt: NOW }, { state: 'ask', shownAt: String(NOW) }, { state: 'ask', shownAt: NaN }, { state: 'ask', shownAt: Infinity }, { state: 5, shownAt: NOW }]) {
			assert.equal(show(cache, 'ask'), true, JSON.stringify(cache));
		}
		assert.equal(show({ state: 'ask', shownAt: NOW - HOUR }, 'inactive'), true);
		assert.equal(show({ state: 'ask', shownAt: NOW + 1 }, 'ask'), true);
		assert.equal(show({ state: 'ask', shownAt: NOW - 23 * HOUR }, 'ask'), false);
		assert.equal(show({ state: 'ask', shownAt: NOW - 25 * HOUR }, 'ask'), true);
		assert.equal(show({ state: 'ask', shownAt: NOW - DAY }, 'ask'), true);
		assert.equal(show({ state: 'ask', shownAt: NOW }, 'ask'), false);
		assert.equal(show({ state: 'inactive', shownAt: NOW - 23 * HOUR }, 'inactive'), false);
		assert.equal(show({ state: 'inactive', shownAt: NOW - 25 * HOUR }, 'inactive'), true);
		assert.equal(show({ state: 'unsupported', shownAt: NOW - 25 * HOUR }, 'unsupported'), false);
		assert.equal(show({ state: 'unsupported', shownAt: NOW - 29 * DAY }, 'unsupported'), false);
		assert.equal(show({ state: 'unsupported', shownAt: NOW - 31 * DAY }, 'unsupported'), true);
	});
});

describe('migrationCommand and migrationLine', () => {
	const SKILL = '/home/u/.claude/skills/make-custom-app';
	const CMD = `node "${SKILL}/scripts/migrate-to-plugin.js"`;
	const line = (extra) => logic.migrationLine({ state: 'ask', reason: 'not-recorded', skillRoot: SKILL, editorDir: '.claude', installPath: '/p/3.0.0', platform: 'linux', ...extra });

	it('migrationLine: the exact text of every state and editor, each matching LINE_PATTERN, and both handoff texts name <cmd> before the second step', () => {
		const ask = `PLUGIN_MIGRATION: ask | The make-custom-app plugin replaces this skill and is not installed. Ask the user yes or no before other work. Yes runs: ${CMD}`;
		const askAccount = `PLUGIN_MIGRATION: ask | The make-custom-app plugin replaces this skill and is not installed for your user account. Ask the user yes or no before other work. Yes runs: ${CMD}`;
		const inactive = `PLUGIN_MIGRATION: inactive | The make-custom-app plugin is installed but disabled, and this skill keeps working. To use the plugin, run in your own terminal: ${CMD_ENABLE}`;
		const handoffClaude = `PLUGIN_MIGRATION: handoff | The make-custom-app plugin is installed, so this old skill is a leftover. Before other work: 1. Run ${CMD} (it installs nothing now, copies the MCP keys and app contexts the plugin lacks, and deletes nothing) and relay its last lines. 2. Call the Skill tool with make-custom-app:make-app-setup; it lists the old install and removes it after the user confirms. If that skill is not available in this session, tell the user to restart Claude Code, then continue with this skill.`;
		const handoffCursor = `PLUGIN_MIGRATION: handoff | The make-custom-app plugin is installed, so this old skill is a leftover. Before other work: 1. Run ${CMD} (it installs nothing now, copies the MCP keys and app contexts the plugin lacks, and deletes nothing) and relay its last lines. 2. Ask the user whether Cursor lists the make-app-* skills (the Cursor setting Include Third-Party Plugins must be on). If yes, read /p/3.0.0/skills/make-app-setup/SKILL.md and follow it; it removes the old install after the user confirms. If no, continue with this skill.`;
		const unsupported = 'PLUGIN_MIGRATION: unsupported | Claude Code was not found on this machine. Installing the make-custom-app plugin for Cursor alone is not supported yet, so this skill keeps working and nothing was changed.';
		const cases = [
			[{ state: 'ask', reason: 'not-recorded' }, ask],
			[{ state: 'ask', reason: 'unreadable' }, ask],
			[{ state: 'ask', reason: 'project-only' }, askAccount],
			[{ state: 'ask', reason: 'cache-missing' }, askAccount],
			[{ state: 'ask', reason: 'not-recorded', editorDir: '.cursor' }, ask],
			[{ state: 'inactive', reason: 'disabled' }, inactive],
			[{ state: 'inactive', reason: 'disabled', editorDir: '.cursor' }, inactive],
			[{ state: 'handoff', reason: null, editorDir: '.claude' }, handoffClaude],
			[{ state: 'handoff', reason: null, editorDir: '.cursor' }, handoffCursor],
			[{ state: 'unsupported', reason: 'not-recorded', editorDir: '.cursor' }, unsupported],
		];
		for (const [extra, want] of cases) {
			const got = line(extra);
			assert.equal(got, want, JSON.stringify(extra));
			assert.match(got, logic.LINE_PATTERN);
			assert.equal(got.includes('\n'), false);
		}
		for (const got of [handoffClaude, handoffCursor]) {
			assert.ok(got.indexOf(CMD) > -1 && got.indexOf(CMD) < got.indexOf(' 2. '));
		}
		assert.equal(logic.LINE_PATTERN.exec(ask)[1], 'ask');
		assert.equal(logic.LINE_PATTERN.exec(handoffCursor)[1], 'handoff');
		assert.equal(logic.LINE_PATTERN.test('PLUGIN_MIGRATION: other | text'), false);
		assert.throws(() => line({ state: 'other' }), { name: 'Error', message: 'unknown migration state: other' });
	});

	it('migrationLine: a skill root with a double quote is escaped', () => {
		const root = '/home/we"ird/.claude/skills/make-custom-app';
		const want = 'node "/home/we\\"ird/.claude/skills/make-custom-app/scripts/migrate-to-plugin.js"';
		assert.equal(logic.migrationCommand(root, 'linux'), want);
		assert.ok(line({ skillRoot: root }).endsWith(`Yes runs: ${want}`));
		assert.equal(logic.migrationCommand(SKILL, 'darwin'), CMD);
		assert.equal(logic.migrationCommand('C:\\Users\\u\\.claude\\skills\\make-custom-app', 'win32'), 'node "C:\\Users\\u\\.claude\\skills\\make-custom-app\\scripts\\migrate-to-plugin.js"');
	});
});

describe('the throttle file', () => {
	const fileIn = (dir) => path.join(dir, 'make-custom-app-plugin-prompt-501.json');

	it('throttleFile: one file per uid, and a sanitized Windows user name', () => {
		assert.equal(logic.throttleFile({ tmpdir: '/t', platform: 'linux', uid: 501 }), path.posix.join('/t', 'make-custom-app-plugin-prompt-501.json'));
		assert.notEqual(logic.throttleFile({ tmpdir: '/t', platform: 'linux', uid: 502 }), logic.throttleFile({ tmpdir: '/t', platform: 'linux', uid: 501 }));
		assert.equal(logic.throttleFile({ tmpdir: '/t', platform: 'linux', uid: 0 }), '/t/make-custom-app-plugin-prompt-0.json');
		assert.equal(logic.throttleFile({ tmpdir: 'C:\\Temp', platform: 'win32', uid: 501, username: 'Anna O\\x/\u00e9' }), 'C:\\Temp\\make-custom-app-plugin-prompt-Anna_O_x__.json');
		assert.equal(logic.throttleFile({ tmpdir: 'C:\\Temp', platform: 'win32', username: 'a.b-c_d9' }), 'C:\\Temp\\make-custom-app-plugin-prompt-a.b-c_d9.json');
		assert.match(logic.throttleFile({ tmpdir: 'C:\\Temp', platform: 'win32' }), /^C:\\Temp\\make-custom-app-plugin-prompt-[A-Za-z0-9._-]+\.json$/);
		const original = os.userInfo;
		os.userInfo = () => {
			throw new Error('no passwd entry');
		};
		try {
			assert.equal(logic.throttleFile({ tmpdir: 'C:\\Temp', platform: 'win32' }), 'C:\\Temp\\make-custom-app-plugin-prompt-user.json');
		} finally {
			os.userInfo = original;
		}
	});

	it('throttleFile: the defaults are this process and its user', POSIX_ONLY, () => {
		assert.equal(logic.throttleFile({ tmpdir: '/t' }), `/t/make-custom-app-plugin-prompt-${process.getuid()}.json`);
		const original = process.getuid;
		process.getuid = undefined;
		try {
			assert.equal(logic.throttleFile({ tmpdir: '/t', platform: 'linux', username: 'a b' }), '/t/make-custom-app-plugin-prompt-a_b.json');
			assert.match(logic.throttleFile({ tmpdir: '/t', platform: 'linux' }), /^\/t\/make-custom-app-plugin-prompt-[A-Za-z0-9._-]+\.json$/);
		} finally {
			process.getuid = original;
		}
	});

	it('readThrottle and writeThrottle: a round trip with mode 0600, no temp file left, null for a missing or malformed file', POSIX_ONLY, () => {
		const dir = caseDir('throttle');
		const file = fileIn(dir);
		assert.equal(logic.readThrottle({ file, fs }), null);
		assert.equal(logic.writeThrottle({ file, fs, pid: 4242, state: 'ask', now: 1234 }), true);
		assert.deepEqual(logic.readThrottle({ file, fs }), { state: 'ask', shownAt: 1234 });
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(dir), ['make-custom-app-plugin-prompt-501.json']);
		assert.equal(logic.writeThrottle({ file, fs, pid: 4242, state: 'inactive', now: 5 }), true);
		assert.deepEqual(logic.readThrottle({ file, fs }), { state: 'inactive', shownAt: 5 });
		for (const text of ['{"state":"ask"', '', '[]', 'null', '7', '"x"']) {
			fs.writeFileSync(file, text);
			assert.equal(logic.readThrottle({ file, fs }), null, text);
		}
		assert.equal(logic.readThrottle({ file: path.join(dir, 'missing', 'x.json'), fs }), null);
	});

	it('writeThrottle: false when the folder is missing, a temp file is in the way, or the target is a folder, and no temp file stays', POSIX_ONLY, () => {
		const dir = caseDir('throttle-fail');
		assert.equal(logic.writeThrottle({ file: path.join(dir, 'missing', 'x.json'), fs, pid: 1, state: 'ask', now: 1 }), false);

		const file = fileIn(dir);
		fs.writeFileSync(`${file}.7.tmp`, 'planted');
		assert.equal(logic.writeThrottle({ file, fs, pid: 7, state: 'ask', now: 1 }), false);
		assert.deepEqual(fs.readdirSync(dir), []);

		fs.mkdirSync(path.join(file, 'inner'), { recursive: true });
		assert.equal(logic.writeThrottle({ file, fs, pid: 8, state: 'ask', now: 1 }), false);
		assert.deepEqual(fs.readdirSync(dir), ['make-custom-app-plugin-prompt-501.json']);
		assert.equal(logic.writeThrottle({ file: undefined, fs, pid: 8, state: 'ask', now: 1 }), false);
	});

	it('writeThrottle replaces a symlink planted at the throttle path instead of following it', POSIX_ONLY, () => {
		const dir = caseDir('throttle-link');
		const victim = path.join(dir, 'victim.txt');
		fs.writeFileSync(victim, 'keep me');
		const file = fileIn(dir);
		fs.symlinkSync(victim, file);
		assert.equal(logic.writeThrottle({ file, fs, pid: 99, state: 'ask', now: 42 }), true);
		assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
		assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { state: 'ask', shownAt: 42 });

		const temp = `${file}.100.tmp`;
		fs.rmSync(file);
		fs.symlinkSync(victim, temp);
		assert.equal(logic.writeThrottle({ file, fs, pid: 100, state: 'ask', now: 43 }), false);
		assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
		assert.equal(fs.existsSync(temp), false);
	});

	it('removeThrottle: an existing file, a missing file', () => {
		const dir = caseDir('throttle-rm');
		const file = fileIn(dir);
		fs.writeFileSync(file, '{}');
		assert.equal(logic.removeThrottle({ file, fs }), true);
		assert.equal(fs.existsSync(file), false);
		assert.equal(logic.removeThrottle({ file, fs }), false);
		fs.mkdirSync(path.join(file, 'inner'), { recursive: true });
		assert.equal(logic.removeThrottle({ file, fs }), false);
		assert.equal(fs.existsSync(file), true);
	});
});

describe('readDeclinedAt', () => {
	it('readDeclinedAt: a valid marker, a malformed marker, a missing file', () => {
		const home = caseDir('declined');
		const marker = path.join(home, '.make-custom-app', 'legacy-cleanup.json');
		assert.equal(logic.readDeclinedAt({ home, fs }), null);
		fs.mkdirSync(path.dirname(marker));
		fs.writeFileSync(marker, JSON.stringify({ schema: 1, declinedAt: '2026-10-20T10:00:00.000Z', digest: '0123456789abcdef' }));
		assert.equal(logic.readDeclinedAt({ home, fs }), Date.parse('2026-10-20T10:00:00.000Z'));
		assert.equal(logic.readDeclinedAt({ home }), Date.parse('2026-10-20T10:00:00.000Z'));
		for (const text of ['{"declinedAt":"2026-10', '', 'null', '[]', '7', '{}', '{"declinedAt":"yesterday"}', '{"declinedAt":1760000000000}', '{"declinedAt":null}']) {
			fs.writeFileSync(marker, text);
			assert.equal(logic.readDeclinedAt({ home, fs }), null, text);
		}
		fs.rmSync(marker);
		assert.equal(logic.readDeclinedAt({ home, fs }), null);
	});
});

describe('migrationNotice', () => {
	const NOW = 1900000000000;
	const setup = (label) => {
		const root = caseDir(label);
		const home = path.join(root, 'home');
		const tmpdir = path.join(root, 'tmp');
		const cfg = path.join(root, 'cfg');
		for (const dir of [home, tmpdir, cfg]) fs.mkdirSync(dir);
		const skillRoot = path.join(home, '.claude', 'skills', 'make-custom-app');
		const params = { env: { CLAUDE_CONFIG_DIR: cfg }, home, tmpdir, platform: process.platform, uid: 501, now: NOW, fs, skillRoot, editorDir: '.claude', isExecutable: () => false };
		return { root, home, tmpdir, cfg, skillRoot, params, throttle: logic.throttleFile({ tmpdir, platform: process.platform, uid: 501 }) };
	};
	const CMD = (skillRoot) => `node "${path.join(skillRoot, 'scripts', 'migrate-to-plugin.js')}"`;

	it('migrationNotice: ask is due on the first call and not on the second within 24 hours; handoff is due on every call; json mode never writes; an unwritable temp folder keeps due true; a thrown error inside a reader returns null', () => {
		const ask = setup('notice-ask');
		const first = logic.migrationNotice(ask.params);
		assert.deepEqual(first, {
			state: 'ask',
			reason: 'not-recorded',
			claudeBin: null,
			command: CMD(ask.skillRoot),
			line: logic.migrationLine({ state: 'ask', reason: 'not-recorded', skillRoot: ask.skillRoot, editorDir: '.claude', installPath: null, platform: process.platform }),
			due: true,
		});
		assert.match(first.line, logic.LINE_PATTERN);
		assert.deepEqual(JSON.parse(fs.readFileSync(ask.throttle, 'utf8')), { state: 'ask', shownAt: NOW });
		const second = logic.migrationNotice({ ...ask.params, now: NOW + HOUR });
		assert.equal(second.due, false);
		assert.equal(second.state, 'ask');
		assert.equal(second.line, first.line);
		assert.equal(logic.migrationNotice({ ...ask.params, now: NOW + 25 * HOUR }).due, true);
		assert.deepEqual(JSON.parse(fs.readFileSync(ask.throttle, 'utf8')), { state: 'ask', shownAt: NOW + 25 * HOUR });

		const handoff = setup('notice-handoff');
		const installPath = installPlugin(handoff.cfg, { enabled: true });
		const h1 = logic.migrationNotice(handoff.params);
		assert.equal(h1.state, 'handoff');
		assert.equal(h1.reason, null);
		assert.equal(h1.command, CMD(handoff.skillRoot));
		assert.equal(h1.due, true);
		assert.equal(h1.claudeBin, null);
		assert.ok(h1.line.startsWith('PLUGIN_MIGRATION: handoff | '));
		assert.equal(logic.migrationNotice({ ...handoff.params, now: NOW + 1000 }).due, true);
		assert.equal(logic.migrationNotice({ ...handoff.params, now: NOW + 2000 }).due, true);
		const cursor = logic.migrationNotice({ ...handoff.params, editorDir: '.cursor' });
		assert.ok(cursor.line.includes(`read ${installPath}/skills/make-app-setup/SKILL.md`));

		const json = setup('notice-json');
		for (const now of [NOW, NOW + 1000]) assert.equal(logic.migrationNotice({ ...json.params, now, json: true }).due, true);
		assert.equal(fs.existsSync(json.throttle), false);

		const unwritable = setup('notice-unwritable');
		const params = { ...unwritable.params, tmpdir: path.join(unwritable.root, 'no-such-folder') };
		assert.equal(logic.migrationNotice(params).due, true);
		assert.equal(logic.migrationNotice({ ...params, now: NOW + 1000 }).due, true);

		const torn = setup('notice-torn');
		fs.mkdirSync(path.join(torn.cfg, 'plugins'));
		fs.writeFileSync(path.join(torn.cfg, 'plugins', 'installed_plugins.json'), '{"torn');
		assert.equal(
			logic.migrationNotice({
				...torn.params,
				sleep: () => {
					throw new Error('reader failed');
				},
			}),
			null,
		);
		assert.equal(fs.existsSync(torn.throttle), false);
	});

	it('migrationNotice: inactive, a decline marker, and a found binary', () => {
		const inactive = setup('notice-inactive');
		installPlugin(inactive.cfg, { enabled: false });
		const result = logic.migrationNotice(inactive.params);
		assert.equal(result.state, 'inactive');
		assert.equal(result.reason, 'disabled');
		assert.equal(result.command, CMD_ENABLE);
		assert.ok(result.line.endsWith(CMD_ENABLE));
		assert.equal(logic.migrationNotice({ ...inactive.params, now: NOW + HOUR }).due, false);

		const declined = setup('notice-declined');
		installPlugin(declined.cfg);
		fs.mkdirSync(path.join(declined.home, '.make-custom-app'));
		const marker = path.join(declined.home, '.make-custom-app', 'legacy-cleanup.json');
		fs.writeFileSync(marker, JSON.stringify({ schema: 1, declinedAt: new Date(NOW - HOUR).toISOString(), digest: '0123456789abcdef' }));
		assert.equal(logic.migrationNotice(declined.params), null);
		assert.equal(fs.existsSync(declined.throttle), false);
		fs.writeFileSync(marker, JSON.stringify({ schema: 1, declinedAt: new Date(NOW - 8 * DAY).toISOString(), digest: '0123456789abcdef' }));
		assert.equal(logic.migrationNotice(declined.params).state, 'handoff');

		const found = setup('notice-found');
		const bin = path.join(found.root, 'bin', 'claude');
		const withBin = { ...found.params, editorDir: '.cursor', env: { ...found.params.env, CLAUDE_BIN: bin }, isExecutable: (file) => file === bin };
		const asked = logic.migrationNotice(withBin);
		assert.equal(asked.state, 'ask');
		assert.equal(asked.claudeBin, bin);

		const none = logic.migrationNotice({ ...found.params, editorDir: '.cursor' });
		assert.equal(none.state, 'unsupported');
		assert.equal(none.command, null);
		assert.equal(none.claudeBin, null);
		assert.equal(logic.migrationNotice({ ...found.params, editorDir: '.cursor', now: NOW + 29 * DAY }).due, false);
		assert.equal(logic.migrationNotice({ ...found.params, editorDir: '.cursor', now: NOW + 31 * DAY }).due, true);
	});

	it('migrationNotice: uid, username, now, fs, sleep, and isExecutable have defaults; now may be a function', () => {
		const run = setup('notice-defaults');
		const { env, home, tmpdir, platform, skillRoot, editorDir } = run.params;
		const first = logic.migrationNotice({ env, home, tmpdir, platform, skillRoot, editorDir });
		assert.equal(first.state, 'ask');
		assert.equal(first.due, true);
		const written = fs.readdirSync(tmpdir);
		assert.equal(written.length, 1);
		assert.match(written[0], /^make-custom-app-plugin-prompt-[A-Za-z0-9._-]+\.json$/);
		assert.ok(Math.abs(JSON.parse(fs.readFileSync(path.join(tmpdir, written[0]), 'utf8')).shownAt - Date.now()) < 60000);
		assert.equal(logic.migrationNotice({ env, home, tmpdir, platform, skillRoot, editorDir }).due, false);

		const clocked = setup('notice-clock');
		const p = clocked.params;
		assert.equal(logic.migrationNotice({ ...p, now: () => 5000 }).due, true);
		assert.deepEqual(JSON.parse(fs.readFileSync(clocked.throttle, 'utf8')), { state: 'ask', shownAt: 5000 });
	});
});
