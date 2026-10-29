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
const { spawnSync } = require('child_process');
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

function inTempCwd(label, fn) {
	const before = process.cwd();
	process.chdir(caseDir(label));
	try {
		return fn();
	} finally {
		process.chdir(before);
	}
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

	const FULL_PARAMS = {
		claudeConfigDir: ['env and home', { env: {}, home: '/h' }],
		readPluginStatus: ['env and home', { env: {}, home: '/h' }],
		findClaudeBinary: ['env, home, and platform', { env: {}, home: '/h', platform: 'linux' }],
		throttleFile: ['tmpdir', { tmpdir: '/t' }],
		readDeclinedAt: ['home', { home: '/h' }],
		childEnv: ['env and home', { env: {}, home: '/h' }],
		spawnSpec: ['env, home, and platform', { env: {}, home: '/h', platform: 'linux' }],
		readSecretSources: ['home', { home: '/h' }],
		acquireMigrationLock: ['home', { home: '/h' }],
		migrationNotice: ['env, home, tmpdir, platform, skillRoot, and editorDir', { env: {}, home: '/h', tmpdir: '/t', platform: 'linux', skillRoot: '/s', editorDir: '.claude' }],
		listContextFiles: ['root', { root: '/r' }],
		applyContextCopies: ['targetRoot', { targetRoot: '/t' }],
	};

	it('every function that touches a folder throws a TypeError without env, home, or tmpdir', () => {
		for (const [name, [names, params]] of Object.entries(FULL_PARAMS)) {
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

	it('home and tmpdir must be non-empty strings and env a plain object, in every function that takes them', () => inTempCwd('bad-params', () => {
		const badFolders = ['', null, 5, true, {}, [], () => '/h'];
		const badEnvs = [null, 'PATH=/bin', 5, true, [], ['PATH']];
		for (const [name, [names, params]] of Object.entries(FULL_PARAMS)) {
			const expected = { name: 'TypeError', message: `${name} needs ${names}` };
			for (const key of ['home', 'tmpdir', 'root', 'targetRoot']) {
				if (!(key in params)) continue;
				for (const value of badFolders) assert.throws(() => logic[name]({ ...params, [key]: value }), expected, `${name} with ${key} ${String(value)}`);
			}
			if ('env' in params) {
				for (const value of badEnvs) assert.throws(() => logic[name]({ ...params, env: value }), expected, `${name} with env ${String(value)}`);
			}
		}
		assert.deepEqual(fs.readdirSync(process.cwd()), []);
	}));

	it('requireParams checks the names home, tmpdir, root, targetRoot, and env by value and every other name by undefined only', () => {
		assert.equal(logic.requireParams('f', { home: '/h', tmpdir: '/t', root: '/r', targetRoot: '/x', env: {}, platform: '' }, ['home', 'tmpdir', 'root', 'targetRoot', 'env', 'platform']), undefined);
		assert.throws(() => logic.requireParams('f', { root: '' }, ['root']), { name: 'TypeError', message: 'f needs root' });
		assert.throws(() => logic.requireParams('f', { targetRoot: 5 }, ['targetRoot']), { name: 'TypeError', message: 'f needs targetRoot' });
		assert.equal(logic.requireParams('f', { env: Object.create(null) }, ['env']), undefined);
		assert.equal(logic.requireParams('f', { env: process.env }, ['env']), undefined);
		assert.throws(() => logic.requireParams('f', { home: '' }, ['home']), { name: 'TypeError', message: 'f needs home' });
		assert.throws(() => logic.requireParams('f', { home: '/h', env: null }, ['home', 'env']), { name: 'TypeError', message: 'f needs home and env' });
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

	it('readPluginStatus: a plugin.json that is a directory is cache-missing', () => {
		const home = caseDir('rps-dir');
		const config = path.join(home, '.claude');
		const found = installPlugin(config, { enabled: true });
		const manifestPath = path.join(found, '.claude-plugin', 'plugin.json');
		fs.rmSync(manifestPath);
		fs.mkdirSync(manifestPath);
		const result = logic.readPluginStatus({ env: {}, home });
		assert.deepEqual(result, { status: 'absent', reason: 'cache-missing', id: null, installPath: null, version: null });
	});

	it('readPluginStatus: a leading BOM in installed_plugins.json or settings.json is ignored, with no second read', () => {
		const BOM = '\ufeff';
		assert.deepEqual(logic.parseInstalledPlugins(BOM + good).entries.map((e) => e.scope), ['user']);
		assert.equal(logic.parseInstalledPlugins(BOM + good).ok, true);
		const bom = run(
			new Map([
				[installedFile, BOM + good],
				[settingsFile, BOM + JSON.stringify({ enabledPlugins: { [ID]: false } })],
			]),
		);
		assert.equal(bom.result.status, 'inactive');
		assert.deepEqual(bom.sleeps, []);
		assert.equal(bom.reads.length, 2);
		assert.equal(run(new Map([[installedFile, BOM + good]])).result.status, 'usable');
		assert.equal(logic.pluginStatus({ installedText: BOM + good, settingsText: BOM + '{"enabledPlugins":{"make-custom-app@make-custom-app":false}}', hasManifest: () => true }).status, 'inactive');
		assert.equal(logic.parseInstalledPlugins(BOM).ok, false);
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
	const CMD = `node '${SKILL}/scripts/migrate-to-plugin.js'`;
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

	const STUB = "node() { printf '[%s]\\n' \"$@\"; }\n";
	const through = (command) => {
		const result = spawnSync('/bin/sh', ['-c', STUB + command], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(TEST_ROOT, 'home') } });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, '');
		return result.stdout;
	};

	it('migrationCommand: the POSIX form single-quotes the path and replaces each single quote with quote, backslash, quote, quote', () => {
		assert.equal(logic.migrationCommand(SKILL, 'linux'), CMD);
		assert.equal(logic.migrationCommand(SKILL, 'darwin'), CMD);
		assert.equal(logic.migrationCommand('/home/it\'s/skills/make-custom-app', 'linux'), "node '/home/it'\\''s/skills/make-custom-app/scripts/migrate-to-plugin.js'");
		assert.equal(logic.migrationCommand("/a'b'c", 'freebsd'), "node '/a'\\''b'\\''c/scripts/migrate-to-plugin.js'");
	});

	it('migrationCommand: through sh -c the script path arrives as one exact argument for roots with a $ form, a backtick, a backslash, quotes, !, a space, $HOME, and shell operators', POSIX_ONLY, () => {
		const roots = [
			'/r/$HOME/skills/make-custom-app',
			'/r/${HOME}/skills/make-custom-app',
			'/r/~/skills/make-custom-app',
			'/r/a\\b\\$c/skills/make-custom-app',
			'/r/trailing\\/skills/make-custom-app',
			"/r/it's/skills/make-custom-app",
			"/r/'a'b''/skills/make-custom-app",
			"/r/'/skills/make-custom-app",
			'/r/we"ird/skills/make-custom-app',
			'/r/"$HOME"/skills/make-custom-app',
			'/r/bang!/skills/make-custom-app',
			'/r/!!/skills/make-custom-app',
			'/r/with space/and  two/skills/make-custom-app',
			'/r/tab\there/skills/make-custom-app',
			'/r/a;b&&c|d||e/skills/make-custom-app',
			'/r/*?[ab]#x/skills/make-custom-app',
			'/r/<in>out/skills/make-custom-app',
			'/r/%PATH%^&/skills/make-custom-app',
			'/r/caf\u00e9/skills/make-custom-app',
		];
		for (const root of roots) {
			const command = logic.migrationCommand(root, 'linux');
			const script = path.posix.join(root, 'scripts', 'migrate-to-plugin.js');
			assert.ok(command.startsWith("node '") && command.endsWith("'"), command);
			assert.equal(through(command), `[${script}]\n`, JSON.stringify(root));
		}
	});

	it('migrationCommand: a command substitution or a backtick form in the root never runs', POSIX_ONLY, () => {
		const dir = caseDir('cmd-injection');
		const marker = path.join(dir, 'marker');
		const backtickMarker = path.join(dir, 'backtick-marker');
		const quotedMarker = path.join(dir, 'quoted-marker');
		const roots = [
			`/r/$(touch ${marker})/skills/make-custom-app`,
			`/r/\`touch ${backtickMarker}\`/skills/make-custom-app`,
			`/r/'$(touch ${quotedMarker})'/skills/make-custom-app`,
			`/r/'; touch ${quotedMarker}; '/skills/make-custom-app`,
		];
		for (const root of roots) {
			const script = path.posix.join(root, 'scripts', 'migrate-to-plugin.js');
			assert.equal(through(logic.migrationCommand(root, 'linux')), `[${script}]\n`, root);
			assert.ok(line({ skillRoot: root }).endsWith(`Yes runs: ${logic.migrationCommand(root, 'linux')}`));
		}
		assert.deepEqual(fs.readdirSync(dir), []);
	});

	it('migrationCommand: Windows keeps the double-quoted form and refuses $, a backtick, %, ^, &, !, a double quote, and control characters', () => {
		const root = (middle) => `C:\\Users\\a${middle}b\\.claude\\skills\\make-custom-app`;
		assert.equal(logic.migrationCommand('C:\\Users\\u\\.claude\\skills\\make-custom-app', 'win32'), 'node "C:\\Users\\u\\.claude\\skills\\make-custom-app\\scripts\\migrate-to-plugin.js"');
		for (const ch of [' ', '(', ')', "'", ';', ',', '#', '@', '~', '+', '=', '[', ']', '{', '}', '\u00e9']) {
			assert.equal(logic.migrationCommand(root(ch), 'win32'), `node "C:\\Users\\a${ch}b\\.claude\\skills\\make-custom-app\\scripts\\migrate-to-plugin.js"`, JSON.stringify(ch));
		}
		for (const ch of ['$', '`', '%', '^', '&', '!', '"', '\x00', '\x01', '\t', '\x1b', '\x7f', '\n', '\r']) {
			assert.equal(logic.migrationCommand(root(ch), 'win32'), null, JSON.stringify(ch));
			assert.equal(line({ skillRoot: root(ch), platform: 'win32' }), null, JSON.stringify(ch));
			assert.equal(line({ skillRoot: root(ch), platform: 'win32', state: 'handoff', reason: null }), null, JSON.stringify(ch));
		}
		assert.equal(logic.migrationCommand('C:\\Users\\a$\\x', 'linux'), "node 'C:\\Users\\a$\\x/scripts/migrate-to-plugin.js'");
	});

	it('migrationCommand and migrationLine: a line break in the skill root gives no command and no ask or handoff line, on both platforms', () => {
		for (const platform of ['linux', 'darwin', 'win32']) {
			for (const br of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
				const skillRoot = `/home/u${br}x/.claude/skills/make-custom-app`;
				assert.equal(logic.migrationCommand(skillRoot, platform), null, `${platform} ${JSON.stringify(br)}`);
				for (const state of ['ask', 'handoff']) {
					assert.equal(logic.migrationLine({ state, reason: 'not-recorded', skillRoot, editorDir: '.claude', installPath: '/p', platform }), null, `${platform} ${state} ${JSON.stringify(br)}`);
				}
				assert.match(logic.migrationLine({ state: 'inactive', reason: 'disabled', skillRoot, editorDir: '.claude', installPath: null, platform }), logic.LINE_PATTERN);
				assert.match(logic.migrationLine({ state: 'unsupported', reason: 'not-recorded', skillRoot, editorDir: '.cursor', installPath: null, platform }), logic.LINE_PATTERN);
			}
		}
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
	const CMD = (skillRoot) => `node '${path.join(skillRoot, 'scripts', 'migrate-to-plugin.js')}'`;

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

	it('migrationNotice: a skill root that the command cannot carry gives null for ask and handoff, writes nothing, and still reports inactive and unsupported', () => {
		const ask = setup('notice-unsafe-ask');
		const bad = [
			[process.platform, `${ask.home}/line\nbreak/.claude/skills/make-custom-app`],
			['win32', `C:\\Users\\a$b\\.claude\\skills\\make-custom-app`],
			['win32', `C:\\Users\\a%b\\.claude\\skills\\make-custom-app`],
		];
		for (const [platform, skillRoot] of bad) {
			const writes = [];
			const recording = { readFileSync: () => { throw enoent(); }, statSync: () => { throw enoent(); }, writeFileSync: (file) => writes.push(file), renameSync: (file) => writes.push(file), unlinkSync: () => {} };
			assert.equal(logic.migrationNotice({ ...ask.params, platform, skillRoot, fs: recording }), null, `${platform} ${JSON.stringify(skillRoot)}`);
			assert.deepEqual(writes, [], `${platform} ${JSON.stringify(skillRoot)}`);
		}
		assert.deepEqual(fs.readdirSync(ask.tmpdir), []);

		const handoff = setup('notice-unsafe-handoff');
		installPlugin(handoff.cfg, { enabled: true });
		assert.equal(logic.migrationNotice({ ...handoff.params, skillRoot: `${handoff.home}/a\rb` }), null);
		assert.deepEqual(fs.readdirSync(handoff.tmpdir), []);

		const inactive = setup('notice-unsafe-inactive');
		installPlugin(inactive.cfg, { enabled: false });
		const disabled = logic.migrationNotice({ ...inactive.params, skillRoot: `${inactive.home}/a\nb` });
		assert.equal(disabled.state, 'inactive');
		assert.equal(disabled.command, CMD_ENABLE);

		const cursor = setup('notice-unsafe-unsupported');
		const unsupported = logic.migrationNotice({ ...cursor.params, editorDir: '.cursor', skillRoot: `${cursor.home}/a\nb` });
		assert.equal(unsupported.state, 'unsupported');
		assert.equal(unsupported.command, null);
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

const FAKE = {
	pinecone: 'fake-pinecone-0001',
	openai: 'fake-openai-0001',
	other: 'fake-other-token-1111',
	cursor: 'fake-cursor-token-2222',
	pinecone2: 'fake-pinecone-9999',
};

function put(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

function errorWithCode(code) {
	return Object.assign(new Error(`failed with ${code}`), { code });
}

describe('task 4 constants', () => {
	it('exports ENV_TO_KEY and LOCK_STALE_MS', () => {
		assert.deepEqual(logic.ENV_TO_KEY, { PINECONE_API_KEY: 'pinecone-api-key', OPENAI_API_KEY: 'openai-api-key', PINECONE_INDEX_NAME: 'pinecone-index-name' });
		assert.equal(logic.LOCK_STALE_MS, 600000);
	});
});

describe('parseArgs', () => {
	const DEFAULTS = { dryRun: false, json: false, skipVersion: false, timeoutSec: 75, error: null };
	const TIMEOUT_ERROR = '--timeout needs a whole number of seconds from 5 to 600';

	it('parseArgs: no arguments give the defaults, and each flag sets only its own field', () => {
		assert.deepEqual(logic.parseArgs([]), DEFAULTS);
		assert.deepEqual(logic.parseArgs(), DEFAULTS);
		assert.deepEqual(logic.parseArgs(['--json']), { ...DEFAULTS, json: true });
		assert.deepEqual(logic.parseArgs(['--skip-version']), { ...DEFAULTS, skipVersion: true });
		assert.deepEqual(logic.parseArgs(['--json', '--skip-version']), { ...DEFAULTS, json: true, skipVersion: true });
	});

	it('parseArgs: --dry-run implies --skip-version, in any order and together with it', () => {
		assert.deepEqual(logic.parseArgs(['--dry-run']), { ...DEFAULTS, dryRun: true, skipVersion: true });
		assert.deepEqual(logic.parseArgs(['--json', '--dry-run']), { ...DEFAULTS, json: true, dryRun: true, skipVersion: true });
		assert.deepEqual(logic.parseArgs(['--skip-version', '--dry-run', '--timeout=9']), { ...DEFAULTS, dryRun: true, skipVersion: true, timeoutSec: 9 });
	});

	it('parseArgs: --timeout takes both forms, the range 5 to 600, and the last value wins', () => {
		assert.equal(logic.parseArgs(['--timeout', '30']).timeoutSec, 30);
		assert.equal(logic.parseArgs(['--timeout=30']).timeoutSec, 30);
		assert.equal(logic.parseArgs(['--timeout', '5']).timeoutSec, 5);
		assert.equal(logic.parseArgs(['--timeout=600']).timeoutSec, 600);
		assert.equal(logic.parseArgs(['--timeout', '0075']).timeoutSec, 75);
		assert.deepEqual(logic.parseArgs(['--timeout', '20', '--json', '--timeout=40']), { ...DEFAULTS, json: true, timeoutSec: 40 });
		assert.equal(logic.parseArgs(['--timeout', '30']).error, null);
	});

	it('parseArgs: a missing, non-numeric, fractional, signed, or out-of-range --timeout gives the timeout error', () => {
		const bad = [['--timeout'], ['--timeout', ''], ['--timeout', '4'], ['--timeout', '601'], ['--timeout', 'abc'], ['--timeout', '1.5'], ['--timeout', '-5'], ['--timeout', ' 10'], ['--timeout', '1e2'], ['--timeout', '0x10'], ['--timeout', '--json'], ['--timeout', '99999999999999999999999'], ['--timeout='], ['--timeout=4'], ['--timeout=601'], ['--timeout=abc'], ['--timeout=30=40']];
		for (const argv of bad) assert.equal(logic.parseArgs(argv).error, TIMEOUT_ERROR, JSON.stringify(argv));
	});

	it('parseArgs: an unknown option or a positional argument gives "Unknown option", and the first error stops the scan', () => {
		for (const arg of ['--bogus', '-h', '--help', 'extra', '--dry-run=1', '--json=true', '--repo', '--TIMEOUT']) {
			assert.equal(logic.parseArgs([arg]).error, `Unknown option: ${arg}`, arg);
		}
		assert.equal(logic.parseArgs(['--json', '--bogus', '--timeout', '1']).error, 'Unknown option: --bogus');
		assert.equal(logic.parseArgs(['--timeout', '1', '--bogus']).error, TIMEOUT_ERROR);
		assert.equal(logic.parseArgs(['--timeout', '30', 'extra']).error, 'Unknown option: extra');
	});
});

describe('childEnv and spawnSpec', () => {
	const AGENT_ENV = {
		CLAUDECODE: '1',
		CLAUDE_CODE_ENTRYPOINT: 'cli',
		CLAUDE_CODE_SSE_PORT: '1',
		CLAUDE_CODE_SESSION_ID: '00000000-0000-0000-0000-000000000000',
		CLAUDE_CODE_CHILD_SESSION: '1',
		CLAUDE_PID: '1',
		PATH: '/usr/bin',
		HOME: '/real/home',
		USERPROFILE: 'C:\\real',
		GIT_CONFIG_COUNT: '1',
	};
	const HOME = '/tmp/fake-home';

	it('childEnv: HOME and USERPROFILE are the given home, CLAUDECODE is removed, and every other variable stays', () => {
		const before = JSON.stringify(AGENT_ENV);
		const env = logic.childEnv({ env: AGENT_ENV, home: HOME });
		assert.equal(Object.hasOwn(env, 'CLAUDECODE'), false);
		assert.equal(env.HOME, HOME);
		assert.equal(env.USERPROFILE, HOME);
		for (const name of ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID', 'PATH', 'GIT_CONFIG_COUNT']) {
			assert.equal(env[name], AGENT_ENV[name], name);
		}
		assert.deepEqual(Object.keys(env).sort(), Object.keys(AGENT_ENV).filter((name) => name !== 'CLAUDECODE').sort());
		assert.equal(JSON.stringify(AGENT_ENV), before);
		assert.deepEqual(logic.childEnv({ env: {}, home: HOME }), { HOME, USERPROFILE: HOME });
	});

	it('spawnSpec: the POSIX form and the .exe form keep the binary and the arguments, with the fixed options', () => {
		const args = ['plugin', 'marketplace', 'list', '--json'];
		const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: logic.childEnv({ env: AGENT_ENV, home: HOME }), cwd: HOME, timeout: 75000, windowsHide: true };
		assert.deepEqual(logic.spawnSpec({ bin: '/usr/local/bin/claude', args, platform: 'linux', env: AGENT_ENV, home: HOME, timeoutMs: 75000 }), { command: '/usr/local/bin/claude', args, options });
		assert.deepEqual(logic.spawnSpec({ bin: 'C:\\Tools\\claude.exe', args, platform: 'win32', env: AGENT_ENV, home: HOME, timeoutMs: 75000 }), { command: 'C:\\Tools\\claude.exe', args, options });
		assert.deepEqual(logic.spawnSpec({ bin: '/usr/local/bin/claude.cmd', args, platform: 'darwin', env: AGENT_ENV, home: HOME, timeoutMs: 75000 }), { command: '/usr/local/bin/claude.cmd', args, options });
		const bare = logic.spawnSpec({ bin: '/b/claude', platform: 'linux', env: {}, home: HOME });
		assert.deepEqual(bare.args, []);
		assert.equal(bare.options.timeout, undefined);
		assert.equal(Object.hasOwn(bare.options, 'windowsVerbatimArguments'), false);
	});

	it('spawnSpec: a .cmd on Windows (any case) runs through cmd.exe /d /s /c with one verbatim string inside an outer quote pair', () => {
		for (const bin of ['C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\x\\CLAUDE.CMD', 'C:\\x\\claude.Cmd']) {
			const spec = logic.spawnSpec({ bin, args: ['--version'], platform: 'win32', env: AGENT_ENV, home: HOME, timeoutMs: 10000 });
			assert.equal(spec.command, 'cmd.exe');
			assert.deepEqual(spec.args, ['/d', '/s', '/c', `""${bin}" --version"`]);
			assert.deepEqual(spec.options, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: logic.childEnv({ env: AGENT_ENV, home: HOME }), cwd: HOME, timeout: 10000, windowsHide: true, windowsVerbatimArguments: true });
		}
		const several = logic.spawnSpec({ bin: 'C:\\x\\claude.cmd', args: ['plugin', 'install', 'make-custom-app@make-custom-app'], platform: 'win32', env: {}, home: HOME, timeoutMs: 1 });
		assert.equal(several.args[3], '""C:\\x\\claude.cmd" plugin install make-custom-app@make-custom-app"');
		const url = logic.spawnSpec({ bin: 'C:\\x\\claude.cmd', args: ['plugin', 'marketplace', 'add', logic.MARKETPLACE_URL, '--json'], platform: 'win32', env: {}, home: HOME, timeoutMs: 1 });
		assert.equal(url.args[3], `""C:\\x\\claude.cmd" plugin marketplace add ${logic.MARKETPLACE_URL} --json"`);
		assert.equal(logic.spawnSpec({ bin: 'C:\\x\\claude.cmd.exe', args: [], platform: 'win32', env: {}, home: HOME, timeoutMs: 1 }).command, 'C:\\x\\claude.cmd.exe');
	});

	it('spawnSpec: a .cmd path with spaces stays inside the inner quotes, which cmd.exe /s keeps once it strips the outer pair', () => {
		const bin = 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\claude.cmd';
		const spec = logic.spawnSpec({ bin, args: ['--version'], platform: 'win32', env: {}, home: HOME, timeoutMs: 10000 });
		const line = spec.args[3];
		assert.equal(line, `""${bin}" --version"`);
		assert.equal(line.slice(1, -1), `"${bin}" --version`);
		assert.equal(line.startsWith('""') && line.endsWith('"'), true);
	});

	it('spawnSpec: an argument for a Windows .cmd that holds a space, a tab, a quote, or one of & | < > ^ % throws without naming the argument', () => {
		const spawn = (args, platform = 'win32', bin = 'C:\\x\\claude.cmd') => logic.spawnSpec({ bin, args, platform, env: {}, home: HOME, timeoutMs: 1 });
		for (const char of [' ', '\t', '"', '&', '|', '<', '>', '^', '%']) {
			const bad = `fake-${char}-0001`;
			let failure;
			try {
				spawn(['plugin', bad]);
			} catch (err) {
				failure = err;
			}
			assert.ok(failure instanceof TypeError, JSON.stringify(char));
			assert.equal(failure.message, 'spawnSpec: an argument for claude.cmd holds a character that cmd.exe would read as syntax');
			assert.equal(failure.message.includes('fake-'), false);
			assert.doesNotThrow(() => spawn(['plugin', bad], 'linux'), `posix ${JSON.stringify(char)}`);
			assert.doesNotThrow(() => spawn(['plugin', bad], 'win32', 'C:\\x\\claude.exe'), `exe ${JSON.stringify(char)}`);
		}
		assert.doesNotThrow(() => spawn(['plugin', 'install', 'make-custom-app@make-custom-app', '--scope=user', 'https://github.com/o/r.git']));
	});

	it('spawnSpec: a Windows .cmd path with a percent sign or a quote throws without naming the path, and only on that branch', () => {
		const spawn = (bin, platform = 'win32') => logic.spawnSpec({ bin, args: ['--version'], platform, env: {}, home: HOME, timeoutMs: 1 });
		for (const bin of ['C:\\100%\\npm\\claude.cmd', 'C:\\%APPDATA%\\claude.cmd', 'C:\\a"b\\claude.cmd']) {
			let failure;
			try {
				spawn(bin);
			} catch (err) {
				failure = err;
			}
			assert.ok(failure instanceof TypeError, bin);
			assert.equal(failure.message, 'spawnSpec: the path of claude.cmd holds a character that cmd.exe would read as syntax');
			assert.doesNotThrow(() => spawn(bin, 'linux'), `posix ${bin}`);
			assert.doesNotThrow(() => spawn(bin.replace(/\.cmd$/, '.exe')), `exe ${bin}`);
		}
		assert.doesNotThrow(() => spawn('C:\\Users\\First Last (x86)\\a&b^c\\claude.cmd'));
	});

	it('childEnv and spawnSpec: a TypeError without env, home, or platform', () => {
		assert.throws(() => logic.childEnv({ home: HOME }), { name: 'TypeError', message: 'childEnv needs env and home' });
		assert.throws(() => logic.childEnv({ env: {} }), { name: 'TypeError', message: 'childEnv needs env and home' });
		assert.throws(() => logic.childEnv(), { name: 'TypeError', message: 'childEnv needs env and home' });
		const full = { bin: '/b/claude', args: [], platform: 'linux', env: {}, home: HOME };
		for (const key of ['env', 'home', 'platform']) {
			const partial = { ...full };
			delete partial[key];
			assert.throws(() => logic.spawnSpec(partial), { name: 'TypeError', message: 'spawnSpec needs env, home, and platform' }, key);
		}
		assert.throws(() => logic.spawnSpec(), { name: 'TypeError', message: 'spawnSpec needs env, home, and platform' });
	});
});

describe('describeError', () => {
	it('describeError: a SyntaxError whose message quotes a fake secret gives only the path', () => {
		let parseError;
		try {
			JSON.parse(`{"PINECONE_API_KEY": ${FAKE.pinecone} }`);
		} catch (err) {
			parseError = err;
		}
		assert.ok(parseError instanceof SyntaxError);
		assert.equal(logic.describeError(parseError, '/h/.claude.json'), '/h/.claude.json is not valid JSON');
		const quoting = new SyntaxError(`Unexpected token in ${FAKE.openai}`);
		const text = logic.describeError(quoting, '/h/x.json');
		assert.equal(text, '/h/x.json is not valid JSON');
		assert.equal(text.includes('fake-'), false);
		const withCode = Object.assign(new SyntaxError('x'), { code: 'EFAKE' });
		assert.equal(logic.describeError(withCode, '/h/y.json'), '/h/y.json is not valid JSON');
	});

	it('describeError: an error with a string code gives the code and the path', () => {
		assert.equal(logic.describeError(errorWithCode('ENOENT'), '/h/z.json'), 'ENOENT on /h/z.json');
		assert.equal(logic.describeError(errorWithCode('EACCES'), '/h/z.json'), 'EACCES on /h/z.json');
		const withMessage = Object.assign(new Error(`secret ${FAKE.other}`), { code: 'EISDIR' });
		assert.equal(logic.describeError(withMessage, '/h/dir'), 'EISDIR on /h/dir');
	});

	it('describeError: anything else gives the fixed text and never the message', () => {
		const fixed = 'an unexpected error occurred';
		assert.equal(logic.describeError(new Error(`boom ${FAKE.other}`), '/h/a'), fixed);
		assert.equal(logic.describeError(Object.assign(new Error('x'), { code: 13 }), '/h/a'), fixed);
		assert.equal(logic.describeError(new TypeError('bad'), '/h/a'), fixed);
		for (const value of [undefined, null, 'text', 42, {}]) assert.equal(logic.describeError(value, '/h/a'), fixed, String(value));
	});
});

describe('parseJsonc', () => {
	it('parseJsonc: line comments, block comments, and trailing commas are removed', () => {
		const text = ['// leading', '{', '\t/* block', '\t   over lines */', '\t"a": 1, // after a value', '\t"list": [1, 2, 3,],', '\t"nested": { "x": [ { "y": true, }, ], },', '\t"b"/* inside */: /* before value */ 2 ,', '}'].join('\n');
		assert.deepEqual(logic.parseJsonc(text), { a: 1, list: [1, 2, 3], nested: { x: [{ y: true }] }, b: 2 });
	});

	it('parseJsonc: a // or /* inside a string stays, also after an escaped quote', () => {
		const text = '{ "url": "http://proxy.corp:8080/a", "glob": "src/**/*.js", "q": "say \\"//\\" now", "c": "a,}b" }';
		assert.deepEqual(logic.parseJsonc(text), { url: 'http://proxy.corp:8080/a', glob: 'src/**/*.js', q: 'say "//" now', c: 'a,}b' });
		assert.deepEqual(logic.parseJsonc('["a, ]", "b" , ]'), ['a, ]', 'b']);
	});

	it('parseJsonc: a block comment never joins two tokens, a leading BOM is ignored, and plain JSON still parses', () => {
		assert.deepEqual(logic.parseJsonc('[1/**/,2]'), [1, 2]);
		assert.throws(() => logic.parseJsonc('[1/**/2]'), SyntaxError);
		assert.deepEqual(logic.parseJsonc('\uFEFF{"a": [1, 2]}'), { a: [1, 2] });
		assert.deepEqual(logic.parseJsonc('{"a": {"b": null}}'), { a: { b: null } });
		assert.deepEqual(logic.parseJsonc('{"a": 1} /* unterminated'), { a: 1 });
	});

	it('parseJsonc: input that is still invalid after the cleanup throws a SyntaxError', () => {
		for (const text of ['', '{', '[,]', '[1,,]', '{,}', '{"a": }', '{"a": 1,, }', '{ "a": fake-value }', undefined]) {
			assert.throws(() => logic.parseJsonc(text), SyntaxError, String(text));
		}
	});
});

describe('parseMarketplaceList', () => {
	const GIT = { name: 'make-custom-app', source: 'git', url: 'https://github.com/minsu-kang/make-custom-app-skill.git', installLocation: '/h/.claude/plugins/marketplaces/make-custom-app' };
	const DIRECTORY = { name: 'make-custom-app', source: 'directory', path: '/work/clone', installLocation: '/work/clone' };

	it('parseMarketplaceList: the flat shape of M1 gives the url of a git entry and the path of a directory entry', () => {
		assert.deepEqual(logic.parseMarketplaceList(JSON.stringify([GIT])), [{ name: 'make-custom-app', source: 'https://github.com/minsu-kang/make-custom-app-skill.git' }]);
		assert.deepEqual(logic.parseMarketplaceList(JSON.stringify([DIRECTORY])), [{ name: 'make-custom-app', source: '/work/clone' }]);
		assert.deepEqual(logic.parseMarketplaceList(JSON.stringify([GIT, DIRECTORY, { name: 'third', source: 'github', repo: 'o/r' }])).map((entry) => entry.source), ['https://github.com/minsu-kang/make-custom-app-skill.git', '/work/clone', 'o/r']);
	});

	it('parseMarketplaceList: an entry with only a string source gives that string, and an entry with nothing gives null', () => {
		assert.deepEqual(logic.parseMarketplaceList(JSON.stringify([{ name: 'a', source: 'git' }, { name: 'b' }, { name: 'c', source: '' }, { name: 'd', url: '' }, { name: 'e', source: 5 }])), [
			{ name: 'a', source: 'git' },
			{ name: 'b', source: null },
			{ name: 'c', source: null },
			{ name: 'd', source: null },
			{ name: 'e', source: null },
		]);
	});

	it('parseMarketplaceList: the first non-empty of url, path, repo wins, then the same fields of a source object, then the kind string', () => {
		const entry = (fields) => logic.parseMarketplaceList(JSON.stringify([{ name: 'm', ...fields }]))[0].source;
		assert.equal(entry({ url: 'U', path: 'P', repo: 'R' }), 'U');
		assert.equal(entry({ url: '', path: 'P', repo: 'R' }), 'P');
		assert.equal(entry({ repo: 'R', source: 'git' }), 'R');
		assert.equal(entry({ source: { url: 'SU', path: 'SP' } }), 'SU');
		assert.equal(entry({ source: { source: 'git', repo: 'SR' } }), 'SR');
		assert.equal(entry({ path: 'P', source: { url: 'SU' } }), 'P');
		assert.equal(entry({ source: { source: 'git' } }), null);
		assert.equal(entry({ url: 5, path: null, repo: ['x'] }), null);
	});

	it('parseMarketplaceList: an array, an object with marketplaces, and a leading BOM are read', () => {
		const list = [{ name: 'a', url: 'U1' }, { name: 'b', source: { path: 'P2' } }];
		const want = [{ name: 'a', source: 'U1' }, { name: 'b', source: 'P2' }];
		assert.deepEqual(logic.parseMarketplaceList(JSON.stringify(list)), want);
		assert.deepEqual(logic.parseMarketplaceList(JSON.stringify({ marketplaces: list })), want);
		assert.deepEqual(logic.parseMarketplaceList(`\uFEFF${JSON.stringify(list)}`), want);
	});

	it('parseMarketplaceList: text that is not JSON, other shapes, and entries without a name give an empty list or are skipped', () => {
		for (const text of ['', 'not json', 'Marketplaces:\n- make-custom-app', '{', 'null', '42', '"x"', '{}', '{"marketplaces": {}}', '{"other": []}', undefined, null]) {
			assert.deepEqual(logic.parseMarketplaceList(text), [], String(text));
		}
		assert.deepEqual(logic.parseMarketplaceList(JSON.stringify([null, 'x', 5, [], { url: 'U' }, { name: 7, url: 'U' }, { name: '', url: 'U' }, { name: 'ok', url: 'U' }])), [{ name: 'ok', source: 'U' }]);
	});
});

describe('usableValue', () => {
	it('usableValue: a good value is usable, also with surrounding spaces', () => {
		assert.equal(logic.usableValue(FAKE.pinecone), true);
		assert.equal(logic.usableValue('  fake-openai-0001  '), true);
		assert.equal(logic.usableValue('a b'), true);
	});

	it('usableValue: empty, spaces only, and a line break anywhere are not usable', () => {
		for (const value of ['', '   ', '\t', 'a\nb', 'a\r\nb', 'a\rb', 'abc\n', '\nabc', ' abc\r']) assert.equal(logic.usableValue(value), false, JSON.stringify(value));
	});

	it('usableValue: each placeholder marker of lib/settings.js is not usable', () => {
		for (const value of ['your-key-here', '<token>', 'a>b', 'someone@example.com', 'ATATT3x...', '/path/provided/by/user', '/path/to/mcp-server', '{path-to-skill}']) {
			assert.equal(logic.usableValue(value), false, value);
		}
	});

	it('usableValue: a value that starts with ${ is a variable reference and is not usable, one that holds it later is', () => {
		for (const value of ['${env:OPENAI_API_KEY}', '${PINECONE_API_KEY}', '  ${X}', '${']) assert.equal(logic.usableValue(value), false, value);
		for (const value of ['a${b', '$', '$X', '{${}']) assert.equal(logic.usableValue(value), true, value);
	});

	it('usableValue: a value that is not a string is not usable', () => {
		for (const value of [undefined, null, 5, true, {}, ['x']]) assert.equal(logic.usableValue(value), false, String(value));
	});
});

describe('parseEnvText', () => {
	it('parseEnvText: a leading BOM, CRLF line ends, comments, and blank lines are handled', () => {
		const text = '\uFEFF# header\r\nPINECONE_API_KEY=fake-pinecone-0001\r\n\r\n   \r\n  # indented comment\r\nOPENAI_API_KEY = fake-openai-0001 \r\n#PINECONE_INDEX_NAME=hidden\r\n';
		assert.deepEqual(logic.parseEnvText(text), { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai });
	});

	it('parseEnvText: the last assignment wins, a value keeps later = signs, an empty value is kept, and a line without = is skipped', () => {
		const text = 'A=1\nB=x=y\nA=2\nC=\nno equals sign\n=orphan\nD=first\nD=\n';
		assert.deepEqual(logic.parseEnvText(text), { A: '2', B: 'x=y', C: '', D: '' });
		assert.deepEqual(logic.parseEnvText(''), {});
		assert.deepEqual(logic.parseEnvText('\n\n'), {});
	});

	it('parseEnvText: a name such as __proto__ never changes the result object', () => {
		const parsed = logic.parseEnvText('__proto__=x\nPINECONE_API_KEY=fake-pinecone-0001\n');
		assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
		assert.equal(parsed.PINECONE_API_KEY, FAKE.pinecone);
		assert.equal({}.x, undefined);
	});
});

describe('pointsIntoOldSkill and isOldRegistration', () => {
	const POSIX_SKILL = '/Users/a/.claude/skills/make-custom-app/mcp-server/dist/index.js';
	const WINDOWS_SKILL = 'C:\\Users\\a\\.cursor\\skills\\make-custom-app\\mcp-server\\dist\\index.js';
	const PLUGIN_BUNDLE = '/Users/a/.claude/plugins/cache/make-custom-app/make-custom-app/3.0.0/mcp/index.mjs';

	it('pointsIntoOldSkill: either separator, in the command or in an argument', () => {
		assert.equal(logic.pointsIntoOldSkill({ command: 'node', args: [POSIX_SKILL] }), true);
		assert.equal(logic.pointsIntoOldSkill({ command: 'node', args: [WINDOWS_SKILL] }), true);
		assert.equal(logic.pointsIntoOldSkill({ command: POSIX_SKILL, args: [] }), true);
		assert.equal(logic.pointsIntoOldSkill({ command: 'node', args: ['--flag', '--path=/h/.cursor/skills/make-custom-app'] }), true);
		assert.equal(logic.pointsIntoOldSkill({ command: 'C:\\x\\skills\\make-custom-app', args: [] }), true);
		assert.equal(logic.pointsIntoOldSkill({ command: 'node', args: ['/x/skills/make-custom-app\\mcp-server'] }), true);
	});

	it('pointsIntoOldSkill: a plugin cache path, an unrelated path, a longer folder name, and malformed entries are not old', () => {
		assert.equal(logic.pointsIntoOldSkill({ command: 'node', args: [PLUGIN_BUNDLE] }), false);
		assert.equal(logic.pointsIntoOldSkill({ command: 'npx', args: ['-y', 'some-server'] }), false);
		assert.equal(logic.pointsIntoOldSkill({ command: 'node', args: ['/x/skills/make-custom-app-v2/index.js'] }), false);
		assert.equal(logic.pointsIntoOldSkill({ command: 'node', args: ['/x/myskills/make-custom-app/index.js'] }), false);
		assert.equal(logic.pointsIntoOldSkill({ command: 'node', args: POSIX_SKILL }), false);
		assert.equal(logic.pointsIntoOldSkill({ command: 7, args: [null, 5] }), false);
		for (const entry of [undefined, null, 'node', 5, [], {}]) assert.equal(logic.pointsIntoOldSkill(entry), false, String(entry));
	});

	it('isOldRegistration: an old skill path with either separator counts without mcpServerPath', () => {
		assert.equal(logic.isOldRegistration({ command: 'node', args: [POSIX_SKILL] }), true);
		assert.equal(logic.isOldRegistration({ command: 'node', args: [WINDOWS_SKILL] }, undefined), true);
		assert.equal(logic.isOldRegistration({ command: 'node', args: [POSIX_SKILL] }, '/elsewhere'), true);
	});

	it('isOldRegistration: the plugin bundle and an unrelated path are not old, also with an unrelated mcpServerPath', () => {
		assert.equal(logic.isOldRegistration({ command: 'node', args: [PLUGIN_BUNDLE] }), false);
		assert.equal(logic.isOldRegistration({ command: 'node', args: [PLUGIN_BUNDLE] }, '/opt/mcp'), false);
		assert.equal(logic.isOldRegistration({ command: 'node', args: ['/opt/other/dist/index.js'] }, '/opt/mcp'), false);
		assert.equal(logic.isOldRegistration({ command: 'node', args: ['/opt/mcp/dist/index.js'] }), false);
		assert.equal(logic.isOldRegistration({ command: 'node', args: ['/opt/mcp/dist/index.js'] }, ''), false);
		assert.equal(logic.isOldRegistration(null, '/opt/mcp'), false);
	});

	it('isOldRegistration: a command or an argument inside mcpServerPath counts, resolved and with either separator', () => {
		const old = (parts, folder) => logic.isOldRegistration({ command: parts[0], args: parts.slice(1) }, folder);
		assert.equal(old(['node', '/opt/mcp/dist/index.js'], '/opt/mcp'), true);
		assert.equal(old(['node', '/opt/mcp/dist/index.js'], '/opt/mcp/'), true);
		assert.equal(old(['/opt/mcp/run.sh'], '/opt/mcp'), true);
		assert.equal(old(['node', '/opt/mcp'], '/opt/mcp'), true);
		assert.equal(old(['node', '/opt/./mcp//dist/index.js'], '/opt/mcp'), true);
		assert.equal(old(['node', 'C:\\srv\\mcp\\dist\\index.js'], 'C:\\srv\\mcp'), true);
		assert.equal(old(['node', 'C:/srv/mcp/dist/index.js'], 'C:\\srv\\mcp\\'), true);
		assert.equal(old(['node', 'C:\\srv\\mcp\\dist\\index.js'], 'C:/srv/mcp'), true);
		assert.equal(old(['node', '/opt/mcp-other/dist/index.js'], '/opt/mcp'), false);
		assert.equal(old(['node', '/opt/mc/dist/index.js'], '/opt/mcp'), false);
		assert.equal(old(['node', '/opt/mcp/../other/index.js'], '/opt/mcp'), false);
		assert.equal(old(['node', 'C:\\srv\\mcp-other\\index.js'], 'C:\\srv\\mcp'), false);
	});

	it('isOldRegistration: a relative or root mcpServerPath never matches, and relative parts are not resolved against the current folder', () => {
		assert.equal(logic.isOldRegistration({ command: 'node', args: ['mcp/dist/index.js'] }, 'mcp'), false);
		assert.equal(logic.isOldRegistration({ command: 'node', args: ['/opt/mcp/dist/index.js'] }, 'opt/mcp'), false);
		assert.equal(logic.isOldRegistration({ command: 'node', args: ['mcp/dist/index.js'] }, '/opt/mcp'), false);
		assert.equal(logic.isOldRegistration({ command: 'node', args: ['/anything/at/all'] }, '/'), false);
		assert.equal(logic.isOldRegistration({ command: 'node', args: ['C:\\anything'] }, 'C:\\'), false);
		assert.equal(logic.isOldRegistration({ command: 'node', args: ['/x'] }, 5), false);
	});
});

describe('isOldRegistration and parent segments', () => {
	const old = (parts, folder) => logic.isOldRegistration({ command: parts[0], args: parts.slice(1) }, folder);

	it('isOldRegistration: a path with a .. segment is never old, with either separator, in the command or an argument', () => {
		assert.equal(old(['node', '/x/skills/make-custom-app/../other/y.js']), false);
		assert.equal(old(['node', '/x/skills/make-custom-app\\..\\other\\y.js']), false);
		assert.equal(old(['/x/skills/make-custom-app/../run.sh']), false);
		assert.equal(old(['node', '..\\skills\\make-custom-app\\y.js']), false);
		assert.equal(old(['node', '/x/skills/make-custom-app/..']), false);
		assert.equal(old(['node', '/x/skills/make-custom-app/y.js']), true);
		assert.equal(old(['node', '/x/skills/make-custom-app/a..b/y.js']), true);
		assert.equal(old(['node', '/x/skills/make-custom-app/..hidden/y.js']), true);
	});

	it('isOldRegistration: a .. lookalike that resolves into mcp-server-path is not old, and a clean second argument still counts', () => {
		assert.equal(old(['node', '/opt/other/../mcp/dist/index.js'], '/opt/mcp'), false);
		assert.equal(old(['node', 'C:\\srv\\other\\..\\mcp\\index.js'], 'C:\\srv\\mcp'), false);
		assert.equal(old(['node', '/opt/mcp/../mcp/dist/index.js'], '/opt/mcp'), false);
		assert.equal(old(['node', '/opt/other/../x.js', '/opt/mcp/dist/index.js'], '/opt/mcp'), true);
		assert.equal(old(['node', '/opt/mcp/dist/../index.js', '/x/skills/make-custom-app/y.js'], '/opt/mcp'), true);
	});

	it('pointsIntoOldSkill keeps the raw rule of legacy-install.js, a .. segment included', () => {
		assert.equal(logic.pointsIntoOldSkill({ command: 'node', args: ['/x/skills/make-custom-app/../other/y.js'] }), true);
	});
});

describe('secretsValue', () => {
	it('secretsValue: the last match wins and the value is trimmed', () => {
		const text = ['pinecone-api-key: fake-pinecone-0001', 'openai-api-key:fake-openai-0001', '  pinecone-api-key:   fake-pinecone-9999  \r', '> pinecone-api-key: fake-other-token-1111', 'xpinecone-api-key: fake-other-token-1111', 'pinecone-api-key-2: fake-other-token-1111'].join('\n');
		assert.equal(logic.secretsValue(text, 'pinecone-api-key'), FAKE.pinecone2);
		assert.equal(logic.secretsValue(text, 'openai-api-key'), FAKE.openai);
		assert.equal(logic.secretsValue(`\uFEFFpinecone-api-key: ${FAKE.pinecone}\n`, 'pinecone-api-key'), FAKE.pinecone);
	});

	it('secretsValue: a missing key, an empty value, and a placeholder are null', () => {
		const text = ['openai-api-key: your-openai-key', 'pinecone-index-name:', 'mcp-server-path: /path/to/mcp-server', 'jira-email: someone@example.com'].join('\n');
		for (const key of ['openai-api-key', 'pinecone-index-name', 'mcp-server-path', 'jira-email', 'pinecone-api-key']) assert.equal(logic.secretsValue(text, key), null, key);
		for (const empty of ['', undefined, null]) assert.equal(logic.secretsValue(empty, 'openai-api-key'), null);
	});

	it('secretsValue: a placeholder on the last line gives the earlier usable value, as the reader of lib/settings.js does', () => {
		assert.equal(logic.secretsValue(`openai-api-key: ${FAKE.openai}\nopenai-api-key: your-openai-key\nopenai-api-key:\n`, 'openai-api-key'), FAKE.openai);
		assert.equal(logic.secretsValue('openai-api-key: your-openai-key\nopenai-api-key: your-other-key\n', 'openai-api-key'), null);
	});

	it('secretsValue: a key with regular expression characters is matched literally', () => {
		assert.equal(logic.secretsValue('a.b: one\naxb: two\n', 'a.b'), 'one');
	});
});

describe('planSecrets', () => {
	const source = (label, values) => ({ label, values });

	it('planSecrets: the first usable source wins per key, and an unusable value does not block a later one', () => {
		const plan = logic.planSecrets({
			sources: [
				source('claude-registration', { PINECONE_API_KEY: ` ${FAKE.pinecone} `, OPENAI_API_KEY: 'your-openai-key', PINECONE_INDEX_NAME: 'make-apps' }),
				source('claude-env', { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai }),
			],
			existingText: '',
		});
		assert.deepEqual(plan, {
			updates: { 'pinecone-api-key': FAKE.pinecone, 'openai-api-key': FAKE.openai, 'pinecone-index-name': 'make-apps' },
			copied: ['pinecone-api-key', 'openai-api-key', 'pinecone-index-name'],
			keptExisting: [],
			conflicts: [],
			skipped: [],
		});
	});

	it('planSecrets: other differing usable sources are conflicts by key and label, and equal ones are not', () => {
		const plan = logic.planSecrets({
			sources: [
				source('claude-registration', { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai }),
				source('claude-env', { PINECONE_API_KEY: FAKE.pinecone2, OPENAI_API_KEY: FAKE.openai }),
				source('cursor-registration:make-app-context', { PINECONE_API_KEY: FAKE.cursor, OPENAI_API_KEY: 'your-openai-key' }),
				source('cursor-env', { PINECONE_API_KEY: FAKE.pinecone }),
			],
			existingText: '',
		});
		assert.deepEqual(plan.updates, { 'pinecone-api-key': FAKE.pinecone, 'openai-api-key': FAKE.openai });
		assert.deepEqual(plan.conflicts, [{ key: 'pinecone-api-key', used: 'claude-registration', others: ['claude-env', 'cursor-registration:make-app-context'] }]);
		assert.deepEqual(plan.copied, ['pinecone-api-key', 'openai-api-key']);
		assert.deepEqual(plan.skipped, []);
	});

	it('planSecrets: an existing usable value wins and is kept, and a placeholder in the file does not', () => {
		const sources = [source('claude-registration', { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai, PINECONE_INDEX_NAME: 'make-apps' })];
		const existingText = `pinecone-api-key: ${FAKE.pinecone2}\nopenai-api-key: your-openai-key\n`;
		assert.deepEqual(logic.planSecrets({ sources, existingText }), {
			updates: { 'openai-api-key': FAKE.openai, 'pinecone-index-name': 'make-apps' },
			copied: ['openai-api-key', 'pinecone-index-name'],
			keptExisting: ['pinecone-api-key'],
			conflicts: [{ key: 'pinecone-api-key', used: 'secrets-file', others: ['claude-registration'] }],
			skipped: [],
		});
		const nothingToOffer = logic.planSecrets({ sources: [], existingText });
		assert.deepEqual(nothingToOffer, { updates: {}, copied: [], keptExisting: [], conflicts: [], skipped: [] });
	});

	it('planSecrets: an existing value that differs from a usable source is a conflict by key and label, never by value', () => {
		const existingText = `pinecone-api-key: ${FAKE.pinecone2}\nopenai-api-key: ${FAKE.openai}\n`;
		const plan = logic.planSecrets({
			sources: [
				source('claude-registration', { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai }),
				source('claude-env', { PINECONE_API_KEY: FAKE.pinecone2, OPENAI_API_KEY: FAKE.cursor }),
				source('cursor-env', { PINECONE_API_KEY: 'your-pinecone-key', OPENAI_API_KEY: FAKE.openai }),
				source('cursor-registration:make-app-context', { PINECONE_API_KEY: FAKE.cursor }),
			],
			existingText,
		});
		assert.deepEqual(plan.updates, {});
		assert.deepEqual(plan.copied, []);
		assert.deepEqual(plan.keptExisting, ['pinecone-api-key', 'openai-api-key']);
		assert.deepEqual(plan.conflicts, [
			{ key: 'pinecone-api-key', used: 'secrets-file', others: ['claude-registration', 'cursor-registration:make-app-context'] },
			{ key: 'openai-api-key', used: 'secrets-file', others: ['claude-env'] },
		]);
		assert.deepEqual(plan.skipped, []);
		const text = JSON.stringify(plan);
		for (const value of [FAKE.pinecone, FAKE.pinecone2, FAKE.openai, FAKE.cursor]) assert.equal(text.includes(value), false, 'no value in the plan conflicts');
	});

	it('planSecrets: an existing value that equals every usable source gives no conflict, and a reference or placeholder source is no conflict', () => {
		const existingText = `pinecone-api-key: ${FAKE.pinecone}\n`;
		const same = logic.planSecrets({ sources: [source('claude-registration', { PINECONE_API_KEY: FAKE.pinecone }), source('claude-env', { PINECONE_API_KEY: ` ${FAKE.pinecone} ` })], existingText });
		assert.deepEqual(same, { updates: {}, copied: [], keptExisting: ['pinecone-api-key'], conflicts: [], skipped: [] });
		const unusable = logic.planSecrets({ sources: [source('claude-registration', { PINECONE_API_KEY: '${env:PINECONE_API_KEY}' }), source('claude-env', { PINECONE_API_KEY: 'your-key' })], existingText });
		assert.deepEqual(unusable, { updates: {}, copied: [], keptExisting: [], conflicts: [], skipped: [] });
		const laterDiffers = logic.planSecrets({ sources: [source('claude-registration', { PINECONE_API_KEY: FAKE.pinecone }), source('claude-env', { PINECONE_API_KEY: FAKE.pinecone2 })], existingText });
		assert.deepEqual(laterDiffers.conflicts, [{ key: 'pinecone-api-key', used: 'secrets-file', others: ['claude-env'] }]);
	});

	it('planSecrets: a key with only placeholder or multiline values is skipped with its reason, and a key without any value is not listed', () => {
		const plan = logic.planSecrets({
			sources: [
				source('claude-registration', { PINECONE_API_KEY: 'your-pinecone-key', OPENAI_API_KEY: 'fake-openai\n0001' }),
				source('claude-env', { PINECONE_API_KEY: '<token>', OPENAI_API_KEY: 'your-openai-key' }),
			],
			existingText: '',
		});
		assert.deepEqual(plan, {
			updates: {},
			copied: [],
			keptExisting: [],
			conflicts: [],
			skipped: [
				{ key: 'pinecone-api-key', reason: 'placeholder' },
				{ key: 'openai-api-key', reason: 'multiline' },
			],
		});
		const empty = logic.planSecrets({ sources: [source('claude-env', { PINECONE_API_KEY: '' })], existingText: '' });
		assert.deepEqual(empty.skipped, [{ key: 'pinecone-api-key', reason: 'placeholder' }]);
		const reference = logic.planSecrets({ sources: [source('cursor-registration:x', { OPENAI_API_KEY: '${env:OPENAI_API_KEY}' })], existingText: '' });
		assert.deepEqual(reference.skipped, [{ key: 'openai-api-key', reason: 'reference' }]);
		const referenceFirst = logic.planSecrets({ sources: [source('a', { OPENAI_API_KEY: '${x}' }), source('b', { OPENAI_API_KEY: 'a\nb' })], existingText: '' });
		assert.deepEqual(referenceFirst.skipped, [{ key: 'openai-api-key', reason: 'reference' }]);
		const covered = logic.planSecrets({ sources: [source('claude-env', { PINECONE_API_KEY: 'your-pinecone-key' })], existingText: `pinecone-api-key: ${FAKE.pinecone}\n` });
		assert.deepEqual(covered, { updates: {}, copied: [], keptExisting: [], conflicts: [], skipped: [] });
	});

	it('planSecrets: the result follows the key order of ENV_TO_KEY, and malformed sources and missing arguments are ignored', () => {
		const plan = logic.planSecrets({
			sources: [null, 'x', source('a', null), source('b', { PINECONE_INDEX_NAME: 'idx', OPENAI_API_KEY: FAKE.openai, PINECONE_API_KEY: 5, UNRELATED: FAKE.other })],
			existingText: undefined,
		});
		assert.deepEqual(plan.copied, ['openai-api-key', 'pinecone-index-name']);
		assert.deepEqual(Object.keys(plan.updates), ['openai-api-key', 'pinecone-index-name']);
		const none = { updates: {}, copied: [], keptExisting: [], conflicts: [], skipped: [] };
		assert.deepEqual(logic.planSecrets({}), none);
		assert.deepEqual(logic.planSecrets(), none);
	});
});

describe('readSecretSources', () => {
	const noSleep = () => {
		throw new Error('unexpected sleep');
	};

	function countingFs() {
		const reads = [];
		return {
			reads,
			readFileSync(file, encoding) {
				reads.push(file);
				return fs.readFileSync(file, encoding);
			},
		};
	}

	function oldInstall(label) {
		const home = caseDir(label);
		const skill = (editor) => path.join(home, editor, 'skills', 'make-custom-app');
		const server = (editor) => path.join(skill(editor), 'mcp-server', 'dist', 'index.js');
		const custom = path.join(home, 'custom', 'mcp-server');
		put(
			path.join(home, '.claude.json'),
			JSON.stringify({
				numStartups: 3,
				mcpServers: {
					'make-custom-app': { command: process.execPath, args: [server('.claude')], env: { PINECONE_API_KEY: ` ${FAKE.pinecone} `, OPENAI_API_KEY: FAKE.openai, PINECONE_INDEX_NAME: 'make-apps', EXTRA_TOKEN: FAKE.other } },
					'other-server': { command: 'npx', args: ['other'], env: { PINECONE_API_KEY: FAKE.other, OPENAI_API_KEY: FAKE.other, TOKEN: FAKE.other } },
				},
				projects: { '/some/project': { mcpServers: { 'make-custom-app': { command: process.execPath, args: [server('.claude')], env: { PINECONE_API_KEY: FAKE.other } } } } },
			}),
		);
		put(path.join(skill('.claude'), 'mcp-server', '.env'), `PINECONE_API_KEY=${FAKE.pinecone}\r\nOPENAI_API_KEY=${FAKE.openai}\r\n# note\r\nUNRELATED=${FAKE.other}\r\n`);
		put(
			path.join(home, '.cursor', 'mcp.json'),
			JSON.stringify({
				mcpServers: {
					unrelated: { command: 'npx', args: ['x'], env: { PINECONE_API_KEY: FAKE.other, TOKEN: FAKE.other } },
					'make-app-context': { command: process.execPath, args: [server('.cursor')], env: { PINECONE_API_KEY: FAKE.cursor, PINECONE_INDEX_NAME: 'cursor-index', EXTRA_TOKEN: FAKE.other } },
					'second-old': { command: 'node', args: [`${skill('.cursor')}\\mcp-server\\dist\\index.js`], env: { OPENAI_API_KEY: FAKE.openai } },
				},
			}),
		);
		put(path.join(skill('.cursor'), 'mcp-server', '.env'), `PINECONE_API_KEY=${FAKE.cursor}\n`);
		put(path.join(custom, '.env'), `OPENAI_API_KEY=${FAKE.openai}\nUNRELATED=${FAKE.other}\n`);
		return { home, skill, server, custom };
	}

	it('readSecretSources: the order and labels of the five sources, only the three names, and no token of another server or of a project', () => {
		const { home, custom } = oldInstall('rs-main');
		const result = logic.readSecretSources({ home, sleep: noSleep, mcpServerPath: custom });
		assert.deepEqual(result.errors, []);
		assert.deepEqual(result.sources, [
			{ label: 'claude-registration', values: { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai, PINECONE_INDEX_NAME: 'make-apps' } },
			{ label: 'claude-env', values: { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai } },
			{ label: 'cursor-registration:make-app-context', values: { PINECONE_API_KEY: FAKE.cursor, PINECONE_INDEX_NAME: 'cursor-index' } },
			{ label: 'cursor-registration:second-old', values: { OPENAI_API_KEY: FAKE.openai } },
			{ label: 'cursor-env', values: { PINECONE_API_KEY: FAKE.cursor } },
			{ label: 'mcp-server-path-env', values: { OPENAI_API_KEY: FAKE.openai } },
		]);
		assert.equal(JSON.stringify(result).includes(FAKE.other), false);
		const withoutPath = logic.readSecretSources({ home, sleep: noSleep });
		assert.deepEqual(withoutPath.sources.map((entry) => entry.label), ['claude-registration', 'claude-env', 'cursor-registration:make-app-context', 'cursor-registration:second-old', 'cursor-env']);
	});

	it('readSecretSources: a home without any old install gives no sources and no errors, and reads exactly four files', () => {
		const home = caseDir('rs-empty');
		const files = countingFs();
		assert.deepEqual(logic.readSecretSources({ home, fs: files, sleep: noSleep }), { sources: [], errors: [] });
		assert.deepEqual(files.reads, [path.join(home, '.claude.json'), path.join(home, '.claude', 'skills', 'make-custom-app', 'mcp-server', '.env'), path.join(home, '.cursor', 'mcp.json'), path.join(home, '.cursor', 'skills', 'make-custom-app', 'mcp-server', '.env')]);
	});

	it('readSecretSources: a torn ~/.claude.json is read again after 100 ms and then used', () => {
		const home = '/fake/home';
		const claudeJson = path.join(home, '.claude.json');
		const good = JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node', args: ['/fake/home/.claude/skills/make-custom-app/mcp-server/dist/index.js'], env: { OPENAI_API_KEY: FAKE.openai } } } });
		const files = fakeFs(new Map([[claudeJson, ['{"mcpServers": {"make-custom', good]]]));
		const sleeps = [];
		const result = logic.readSecretSources({ home, fs: files, sleep: (ms) => sleeps.push(ms) });
		assert.deepEqual(result, { sources: [{ label: 'claude-registration', values: { OPENAI_API_KEY: FAKE.openai } }], errors: [] });
		assert.deepEqual(sleeps, [100]);
		assert.equal(files.reads.filter((file) => file === claudeJson).length, 2);
	});

	it('readSecretSources: a malformed ~/.claude.json whose bad position holds a fake secret gives "<path> is not valid JSON" after 3 reads and no secret anywhere', () => {
		const home = caseDir('rs-malformed');
		const claudeJson = path.join(home, '.claude.json');
		put(claudeJson, `{"mcpServers":{"make-custom-app":{"env":{"PINECONE_API_KEY":${FAKE.pinecone},"OPENAI_API_KEY":"${FAKE.openai}"}}}}`);
		const files = countingFs();
		const sleeps = [];
		const result = logic.readSecretSources({ home, fs: files, sleep: (ms) => sleeps.push(ms) });
		assert.deepEqual(result, { sources: [], errors: [`${claudeJson} is not valid JSON`] });
		assert.equal(files.reads.filter((file) => file === claudeJson).length, 3);
		assert.deepEqual(sleeps, [100, 100]);
		assert.equal(JSON.stringify(result).includes('fake-'), false);
	});

	it('readSecretSources: a Claude entry that is not an old registration is no source, unless it lies inside mcp-server-path', () => {
		const home = caseDir('rs-not-old');
		const bundle = path.join(home, '.claude', 'plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0', 'mcp', 'index.mjs');
		const entry = (file) => ({ mcpServers: { 'make-custom-app': { command: process.execPath, args: [file], env: { PINECONE_API_KEY: FAKE.pinecone } } } });
		put(path.join(home, '.claude.json'), JSON.stringify(entry(bundle)));
		assert.deepEqual(logic.readSecretSources({ home, sleep: noSleep }), { sources: [], errors: [] });
		assert.deepEqual(logic.readSecretSources({ home, sleep: noSleep, mcpServerPath: path.join(home, 'elsewhere') }), { sources: [], errors: [] });

		const server = path.join(home, 'server');
		put(path.join(home, '.claude.json'), JSON.stringify(entry(path.join(server, 'dist', 'index.js'))));
		assert.deepEqual(logic.readSecretSources({ home, sleep: noSleep }), { sources: [], errors: [] });
		assert.deepEqual(logic.readSecretSources({ home, sleep: noSleep, mcpServerPath: server }), { sources: [{ label: 'claude-registration', values: { PINECONE_API_KEY: FAKE.pinecone } }], errors: [] });
		put(path.join(server, '.env'), `OPENAI_API_KEY=${FAKE.openai}\n`);
		const both = logic.readSecretSources({ home, sleep: noSleep, mcpServerPath: ` ${server} ` });
		assert.deepEqual(both.sources.map((source) => source.label), ['claude-registration', 'mcp-server-path-env']);
	});

	it('readSecretSources: a Cursor mcp.json with comments and trailing commas is read', () => {
		const home = caseDir('rs-jsonc');
		const old = path.join(home, '.cursor', 'skills', 'make-custom-app', 'mcp-server', 'dist', 'index.js');
		const text = ['// Cursor MCP servers', '{', '\t/* the old server */', '\t"mcpServers": {', '\t\t"make-app-context": {', '\t\t\t"command": "node", // runs the old build', `\t\t\t"args": [${JSON.stringify(old)},],`, `\t\t\t"env": { "PINECONE_API_KEY": "${FAKE.cursor}", },`, '\t\t},', '\t},', '}'].join('\n');
		put(path.join(home, '.cursor', 'mcp.json'), text);
		assert.deepEqual(logic.readSecretSources({ home, sleep: noSleep }), { sources: [{ label: 'cursor-registration:make-app-context', values: { PINECONE_API_KEY: FAKE.cursor } }], errors: [] });
	});

	it('readSecretSources: a Cursor mcp.json that never parses gives the error of the path, after one read, and no secret', () => {
		const home = caseDir('rs-cursor-bad');
		const cursorJson = path.join(home, '.cursor', 'mcp.json');
		put(cursorJson, `{"mcpServers": {"x": {"env": {"PINECONE_API_KEY": ${FAKE.cursor} // c\n}}}}`);
		const files = countingFs();
		const result = logic.readSecretSources({ home, fs: files, sleep: noSleep });
		assert.deepEqual(result, { sources: [], errors: [`${cursorJson} is not valid JSON`] });
		assert.equal(files.reads.filter((file) => file === cursorJson).length, 1);
		assert.equal(JSON.stringify(result).includes('fake-'), false);
	});

	it('readSecretSources: mcp-server-path inside an old skill folder, a relative one, and the root are ignored', () => {
		const run = oldInstall('rs-ignored');
		const expected = [path.join(run.home, '.claude.json'), path.join(run.skill('.claude'), 'mcp-server', '.env'), path.join(run.home, '.cursor', 'mcp.json'), path.join(run.skill('.cursor'), 'mcp-server', '.env')];
		const inside = [path.join(run.skill('.claude'), 'mcp-server'), run.skill('.claude'), run.skill('.cursor'), path.join(run.skill('.cursor'), 'mcp-server'), `${path.join(run.skill('.cursor'), 'mcp-server')}${path.sep}`];
		for (const mcpServerPath of [...inside, 'custom/mcp-server', '..', '.', '/', '', '   ', undefined, null, 5]) {
			const files = countingFs();
			const result = logic.readSecretSources({ home: run.home, fs: files, sleep: noSleep, mcpServerPath });
			assert.deepEqual(files.reads, expected, String(mcpServerPath));
			assert.equal(result.sources.some((source) => source.label === 'mcp-server-path-env'), false, String(mcpServerPath));
			assert.equal(result.sources.length, 5, String(mcpServerPath));
		}
		const used = countingFs();
		logic.readSecretSources({ home: run.home, fs: used, sleep: noSleep, mcpServerPath: run.custom });
		assert.deepEqual(used.reads, [...expected, path.join(run.custom, '.env')]);
	});

	it('readSecretSources: a missing .env is no source and no error, also when its folder is a file', () => {
		const home = caseDir('rs-missing-env');
		put(path.join(home, 'file-not-folder'), 'x');
		for (const mcpServerPath of [path.join(home, 'nope'), path.join(home, 'file-not-folder')]) {
			assert.deepEqual(logic.readSecretSources({ home, sleep: noSleep, mcpServerPath }), { sources: [], errors: [] }, mcpServerPath);
		}
	});

	it('readSecretSources: read errors other than a missing file are reported by code and path, and ENOTDIR is silent', () => {
		const home = '/fake/home';
		const claudeJson = path.join(home, '.claude.json');
		const claudeEnv = path.join(home, '.claude', 'skills', 'make-custom-app', 'mcp-server', '.env');
		const cursorJson = path.join(home, '.cursor', 'mcp.json');
		const cursorEnv = path.join(home, '.cursor', 'skills', 'make-custom-app', 'mcp-server', '.env');
		const custom = '/fake/custom';
		const files = fakeFs(
			new Map([
				[claudeJson, [errorWithCode('EACCES')]],
				[claudeEnv, [errorWithCode('EISDIR')]],
				[cursorJson, [errorWithCode('EPERM')]],
				[cursorEnv, [errorWithCode('ENOTDIR')]],
				[path.join(custom, '.env'), [errorWithCode('EBUSY')]],
			]),
		);
		const sleeps = [];
		const result = logic.readSecretSources({ home, fs: files, sleep: (ms) => sleeps.push(ms), mcpServerPath: custom });
		assert.deepEqual(result, { sources: [], errors: [`EACCES on ${claudeJson}`, `EISDIR on ${claudeEnv}`, `EPERM on ${cursorJson}`, `EBUSY on ${path.join(custom, '.env')}`] });
		assert.equal(files.reads.filter((file) => file === claudeJson).length, 3);
		assert.deepEqual(sleeps, [100, 100]);
		const quiet = fakeFs(new Map([[claudeJson, [new Error('secret fake-other-token-1111')]]]));
		assert.deepEqual(logic.readSecretSources({ home, fs: quiet, sleep: () => {} }).errors, [`an unexpected error occurred`]);
	});

	it('readSecretSources: odd shapes give no sources and no errors, and a leading BOM is ignored', () => {
		const shapes = [
			['.claude.json', '[]'],
			['.claude.json', '{"mcpServers": []}'],
			['.claude.json', '{"mcpServers": {"make-custom-app": "x"}}'],
			['.claude.json', JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node', args: ['/x/skills/make-custom-app/y'], env: { PINECONE_API_KEY: 5, OPENAI_API_KEY: null, PINECONE_INDEX_NAME: ['x'] } } } })],
			['.claude.json', JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node', args: ['/x/skills/make-custom-app/y'], env: 'x' } } })],
			['.claude.json', JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node', args: ['/x/skills/make-custom-app/y'], env: { OTHER_NAME: FAKE.other } } } })],
			['.cursor/mcp.json', '{"mcpServers": {"a": null, "b": [], "c": {"command": "node", "args": ["/x/skills/make-custom-app/y"], "env": {"OTHER": "v"}}, "d": {"command": "node", "args": ["/x/skills/make-custom-app/y"]}}}'],
			['.cursor/mcp.json', '{"mcpServers": "x"}'],
			['.cursor/mcp.json', '42'],
		];
		for (const [name, text] of shapes) {
			const home = caseDir('rs-shape');
			put(path.join(home, name), text);
			assert.deepEqual(logic.readSecretSources({ home, sleep: noSleep }), { sources: [], errors: [] }, `${name} ${text}`);
		}
		const bom = caseDir('rs-bom');
		put(path.join(bom, '.claude.json'), `\uFEFF${JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node', args: ['/x/skills/make-custom-app/y'], env: { OPENAI_API_KEY: FAKE.openai } } } })}`);
		put(path.join(bom, '.cursor', 'skills', 'make-custom-app', 'mcp-server', '.env'), `\uFEFFPINECONE_API_KEY=${FAKE.cursor}\n`);
		assert.deepEqual(logic.readSecretSources({ home: bom, sleep: noSleep }), {
			sources: [
				{ label: 'claude-registration', values: { OPENAI_API_KEY: FAKE.openai } },
				{ label: 'cursor-env', values: { PINECONE_API_KEY: FAKE.cursor } },
			],
			errors: [],
		});
	});

	it('readSecretSources: values keep empty and placeholder strings for planSecrets, trimmed', () => {
		const home = caseDir('rs-unusable');
		put(path.join(home, '.claude', 'skills', 'make-custom-app', 'mcp-server', '.env'), 'PINECONE_API_KEY=\nOPENAI_API_KEY=  your-openai-key  \n');
		assert.deepEqual(logic.readSecretSources({ home, sleep: noSleep }).sources, [{ label: 'claude-env', values: { PINECONE_API_KEY: '', OPENAI_API_KEY: 'your-openai-key' } }]);
	});

	it('readSecretSources: a registration whose path has a .. segment is no source, in Claude and in Cursor', () => {
		const home = caseDir('rs-dotdot');
		const lookalike = path.join(home, '.claude', 'skills', 'make-custom-app', '..', 'other', 'index.js');
		put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node', args: [lookalike], env: { PINECONE_API_KEY: FAKE.other } } } }));
		put(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { lookalike: { command: 'node', args: [`${home}/.cursor/skills/make-custom-app/../other/y.js`], env: { OPENAI_API_KEY: FAKE.other } } } }));
		const result = logic.readSecretSources({ home, sleep: noSleep });
		assert.deepEqual(result, { sources: [], errors: [] });
		const redirected = path.join(home, 'srv');
		put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node', args: [`${redirected}/other/../dist/index.js`], env: { PINECONE_API_KEY: FAKE.other } } } }));
		assert.deepEqual(logic.readSecretSources({ home, sleep: noSleep, mcpServerPath: redirected }), { sources: [], errors: [] });
	});

	it('readSecretSources and planSecrets: a ${...} reference in a Cursor or Claude env is not copied and is skipped as a reference', () => {
		const home = caseDir('rs-reference');
		const server = path.join(home, '.cursor', 'skills', 'make-custom-app', 'mcp-server', 'dist', 'index.js');
		put(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'make-app-context': { command: 'node', args: [server], env: { OPENAI_API_KEY: '${env:OPENAI_API_KEY}', PINECONE_API_KEY: ' ${PINECONE_API_KEY} ', PINECONE_INDEX_NAME: 'make-apps' } } } }));
		const { sources, errors } = logic.readSecretSources({ home, sleep: noSleep });
		assert.deepEqual(errors, []);
		assert.deepEqual(sources, [{ label: 'cursor-registration:make-app-context', values: { OPENAI_API_KEY: '${env:OPENAI_API_KEY}', PINECONE_API_KEY: '${PINECONE_API_KEY}', PINECONE_INDEX_NAME: 'make-apps' } }]);
		assert.deepEqual(logic.planSecrets({ sources, existingText: '' }), {
			updates: { 'pinecone-index-name': 'make-apps' },
			copied: ['pinecone-index-name'],
			keptExisting: [],
			conflicts: [],
			skipped: [
				{ key: 'pinecone-api-key', reason: 'reference' },
				{ key: 'openai-api-key', reason: 'reference' },
			],
		});
	});
});

describe('acquireMigrationLock', () => {
	const NOW = 1700000000000;
	const lockDir = (home) => path.join(home, '.make-custom-app');
	const lockFile = (home) => path.join(lockDir(home), 'cleanup.lock');
	const takeoverFile = (home) => `${lockFile(home)}.takeover`;
	const alive = () => true;
	const lockText = (pid, at) => `{"pid":${pid},"at":${at}}`;
	const staleByAge = (pid = 4242) => lockText(pid, NOW - 2 * logic.LOCK_STALE_MS);

	function ageFile(file, ms) {
		const when = new Date(Date.now() - ms);
		fs.utimesSync(file, when, when);
	}

	function wrappedFs(hooks = {}) {
		const calls = [];
		return {
			calls,
			mkdirSync: (dir, options) => fs.mkdirSync(dir, options),
			writeFileSync(file, content, options) {
				calls.push(['write', file]);
				fs.writeFileSync(file, content, options);
				if (hooks.afterWrite) hooks.afterWrite(file);
			},
			readFileSync(file, encoding) {
				if (hooks.beforeRead) hooks.beforeRead(file);
				const text = fs.readFileSync(file, encoding);
				calls.push(['read', file]);
				if (hooks.afterRead) hooks.afterRead(file, text);
				return text;
			},
			unlinkSync(file) {
				calls.push(['unlink', file]);
				if (hooks.beforeUnlink) hooks.beforeUnlink(file);
				fs.unlinkSync(file);
				if (hooks.afterUnlink) hooks.afterUnlink(file);
			},
			statSync(file) {
				return hooks.statSync ? hooks.statSync(file) : fs.statSync(file);
			},
		};
	}

	it('acquireMigrationLock: a free lock is created with mode 0700 for the folder, mode 0600 for the file, and the pid and time as content', () => {
		const home = caseDir('lock-free');
		const lock = logic.acquireMigrationLock({ home, pid: 4242, now: NOW, isAlive: alive });
		assert.equal(lock.ok, true);
		assert.equal(typeof lock.release, 'function');
		assert.equal(fs.readFileSync(lockFile(home), 'utf8'), '{"pid":4242,"at":1700000000000}');
		if (process.platform !== 'win32') {
			assert.equal(fs.statSync(lockFile(home)).mode & 0o777, 0o600);
			assert.equal(fs.statSync(lockDir(home)).mode & 0o777, 0o700);
		}
		assert.deepEqual(fs.readdirSync(lockDir(home)), ['cleanup.lock']);
	});

	it('acquireMigrationLock: a lock held by a live pid is not taken and not changed', () => {
		const home = caseDir('lock-held');
		assert.equal(logic.acquireMigrationLock({ home, pid: 4242, now: NOW, isAlive: alive }).ok, true);
		const asked = [];
		const second = logic.acquireMigrationLock({ home, pid: 5151, now: NOW + 1000, isAlive: (pid) => (asked.push(pid), true) });
		assert.deepEqual(second, { ok: false, pid: 4242 });
		assert.deepEqual(asked, [4242]);
		assert.equal(fs.readFileSync(lockFile(home), 'utf8'), '{"pid":4242,"at":1700000000000}');
		assert.deepEqual(fs.readdirSync(lockDir(home)), ['cleanup.lock']);
	});

	it('acquireMigrationLock: a lock whose pid is not alive is replaced, and no takeover file stays', () => {
		const home = caseDir('lock-dead');
		logic.acquireMigrationLock({ home, pid: 4242, now: NOW, isAlive: alive });
		const second = logic.acquireMigrationLock({ home, pid: 5151, now: NOW + 5, isAlive: (pid) => pid !== 4242 });
		assert.equal(second.ok, true);
		assert.equal(fs.readFileSync(lockFile(home), 'utf8'), lockText(5151, NOW + 5));
		assert.deepEqual(fs.readdirSync(lockDir(home)), ['cleanup.lock']);
	});

	it('acquireMigrationLock: a lock older than LOCK_STALE_MS is replaced, one of exactly that age is not', () => {
		const home = caseDir('lock-age');
		logic.acquireMigrationLock({ home, pid: 4242, now: NOW, isAlive: alive });
		assert.deepEqual(logic.acquireMigrationLock({ home, pid: 5151, now: NOW + logic.LOCK_STALE_MS, isAlive: alive }), { ok: false, pid: 4242 });
		const later = logic.acquireMigrationLock({ home, pid: 5151, now: () => NOW + logic.LOCK_STALE_MS + 1, isAlive: alive });
		assert.equal(later.ok, true);
		assert.equal(fs.readFileSync(lockFile(home), 'utf8'), lockText(5151, NOW + logic.LOCK_STALE_MS + 1));
	});

	it('acquireMigrationLock: a lock whose time lies in the future is stale, and one stamped exactly now is not', () => {
		const home = caseDir('lock-future');
		put(lockFile(home), lockText(4242, NOW));
		assert.deepEqual(logic.acquireMigrationLock({ home, pid: 5151, now: NOW, isAlive: alive }), { ok: false, pid: 4242 });
		put(lockFile(home), lockText(4242, NOW + 1));
		const taken = logic.acquireMigrationLock({ home, pid: 5151, now: NOW, isAlive: alive });
		assert.equal(taken.ok, true);
		assert.equal(fs.readFileSync(lockFile(home), 'utf8'), lockText(5151, NOW));
	});

	it('acquireMigrationLock: staleness is judged with a clock read after the lock was read, so a lock stamped a moment later is not taken', () => {
		const home = caseDir('lock-clock');
		put(lockFile(home), lockText(4242, 3000));
		const readings = [1000, 5000];
		const now = () => (readings.length > 1 ? readings.shift() : readings[0]);
		assert.deepEqual(logic.acquireMigrationLock({ home, pid: 5151, now, isAlive: alive }), { ok: false, pid: 4242 });
		assert.equal(fs.readFileSync(lockFile(home), 'utf8'), lockText(4242, 3000));
	});

	it('acquireMigrationLock: release removes our lock once, never another process lock, and the lock can be taken again', () => {
		const home = caseDir('lock-release');
		const first = logic.acquireMigrationLock({ home, pid: 4242, now: NOW, isAlive: alive });
		first.release();
		assert.equal(fs.existsSync(lockFile(home)), false);
		assert.doesNotThrow(() => first.release());
		const second = logic.acquireMigrationLock({ home, pid: 5151, now: NOW, isAlive: alive });
		assert.equal(second.ok, true);
		first.release();
		assert.equal(fs.existsSync(lockFile(home)), true);
		fs.writeFileSync(lockFile(home), '{"pid":7,"at":1}');
		second.release();
		assert.equal(fs.readFileSync(lockFile(home), 'utf8'), '{"pid":7,"at":1}');
	});

	it('acquireMigrationLock: content that is not a pid and a time is stale only when the file is older than 5 s, and never reaches isAlive', () => {
		const bad = ['', 'garbage', '[]', '{"pid":0,"at":1}', '{"pid":-3,"at":1}', '{"pid":1.5,"at":1}', '{"pid":"7","at":1}', '{"pid":4242}', '{"pid":4242,"at":"now"}', '\uFEFF{"pid":4242,"at":"x"}'];
		for (const content of bad) {
			const home = caseDir('lock-bad');
			put(lockFile(home), content);
			ageFile(lockFile(home), 6000);
			const asked = [];
			const lock = logic.acquireMigrationLock({ home, pid: 5151, isAlive: (pid) => (asked.push(pid), true) });
			assert.equal(lock.ok, true, JSON.stringify(content));
			assert.deepEqual(asked, [], JSON.stringify(content));
			assert.equal(JSON.parse(fs.readFileSync(lockFile(home), 'utf8')).pid, 5151);
		}
	});

	it('acquireMigrationLock: a fresh lock file with no pid yet (the moment between create and write) is not taken', () => {
		for (const content of ['', 'garbage', '{"pid":4242}']) {
			const home = caseDir('lock-fresh-empty');
			put(lockFile(home), content);
			const asked = [];
			const result = logic.acquireMigrationLock({ home, pid: 5151, isAlive: (pid) => (asked.push(pid), false) });
			assert.deepEqual(result, { ok: false, pid: null }, JSON.stringify(content));
			assert.deepEqual(asked, [], JSON.stringify(content));
			assert.equal(fs.readFileSync(lockFile(home), 'utf8'), content);
			assert.deepEqual(fs.readdirSync(lockDir(home)), ['cleanup.lock']);
		}
	});

	it('acquireMigrationLock: the 5 s limit for a file without a pid is strict in both directions (a modification time more than 5 s ahead is stale too), read through the injected stat and clock', () => {
		const at = (ageMs) => wrappedFs({ statSync: () => ({ mtimeMs: NOW - ageMs }) });
		for (const [ageMs, replaced] of [[5000, false], [5001, true], [0, false], [-1000, false], [-5000, false], [-5001, true], [-86400000, true]]) {
			const home = caseDir('lock-limit');
			put(lockFile(home), '');
			const result = logic.acquireMigrationLock({ home, fs: at(ageMs), pid: 5151, now: NOW, isAlive: alive });
			assert.equal(result.ok, replaced, `age ${ageMs}`);
			assert.equal(fs.readFileSync(lockFile(home), 'utf8'), replaced ? lockText(5151, NOW) : '', `age ${ageMs}`);
		}
		const home = caseDir('lock-limit-stat-error');
		put(lockFile(home), '');
		const failing = wrappedFs({
			statSync: () => {
				throw errorWithCode('ENOENT');
			},
		});
		assert.deepEqual(logic.acquireMigrationLock({ home, fs: failing, pid: 5151, now: NOW, isAlive: alive }), { ok: false, pid: null });
	});

	it('acquireMigrationLock: a stale lock that another run replaced between our read and our unlink is not removed, and we do not hold the lock', () => {
		const home = caseDir('lock-race-read');
		put(lockFile(home), staleByAge());
		let other;
		let armed = true;
		const raced = wrappedFs({
			afterRead(file) {
				if (file !== lockFile(home) || !armed) return;
				armed = false;
				other = logic.acquireMigrationLock({ home, pid: 6262, now: NOW, isAlive: alive });
			},
		});
		const result = logic.acquireMigrationLock({ home, fs: raced, pid: 5151, now: NOW, isAlive: alive });
		assert.equal(other.ok, true);
		assert.deepEqual(result, { ok: false, pid: 6262 });
		assert.equal(fs.readFileSync(lockFile(home), 'utf8'), lockText(6262, NOW));
		assert.equal(raced.calls.some(([kind, file]) => kind === 'unlink' && file === lockFile(home)), false);
		assert.deepEqual(fs.readdirSync(lockDir(home)), ['cleanup.lock']);
	});

	it('acquireMigrationLock: while one run holds the takeover file, a second run that finds the same stale lock does not take it over', () => {
		const home = caseDir('lock-race-takeover');
		put(lockFile(home), staleByAge());
		let other;
		let content;
		let mode;
		let armed = true;
		const raced = wrappedFs({
			afterWrite(file) {
				if (file !== takeoverFile(home) || !armed) return;
				armed = false;
				content = fs.readFileSync(takeoverFile(home), 'utf8');
				mode = fs.statSync(takeoverFile(home)).mode & 0o777;
				other = logic.acquireMigrationLock({ home, pid: 6262, now: NOW, isAlive: alive });
			},
		});
		const result = logic.acquireMigrationLock({ home, fs: raced, pid: 5151, now: NOW, isAlive: alive });
		assert.deepEqual(other, { ok: false, pid: null });
		assert.equal(result.ok, true);
		assert.equal(content, lockText(5151, NOW));
		if (process.platform !== 'win32') assert.equal(mode, 0o600);
		assert.equal(fs.readFileSync(lockFile(home), 'utf8'), lockText(5151, NOW));
		assert.deepEqual(fs.readdirSync(lockDir(home)), ['cleanup.lock']);
	});

	it('acquireMigrationLock: a lock created by another run between our unlink and our create is reported as held and left alone', () => {
		const home = caseDir('lock-race-create');
		put(lockFile(home), staleByAge());
		const raced = wrappedFs({
			afterUnlink(file) {
				if (file === lockFile(home)) put(lockFile(home), lockText(7, NOW));
			},
		});
		assert.deepEqual(logic.acquireMigrationLock({ home, fs: raced, pid: 5151, now: NOW, isAlive: alive }), { ok: false, pid: 7 });
		assert.equal(fs.readFileSync(lockFile(home), 'utf8'), lockText(7, NOW));
		assert.deepEqual(fs.readdirSync(lockDir(home)), ['cleanup.lock']);
	});

	it('acquireMigrationLock: a takeover file left behind, of any age and with any pid, gives held with no pid and stays in place', () => {
		const cases = [
			['dead pid, fresh', lockText(4242, 1), 0],
			['dead pid, 6 s old', lockText(4242, 1), 6000],
			['dead pid, 1 day old', lockText(4242, 1), 86400000],
			['live pid, fresh', lockText(8888, 1), 0],
			['live pid, 1 day old', lockText(8888, 1), 86400000],
			['no pid, fresh', '', 0],
			['no pid, 1 day old', '', 86400000],
			['garbage, 1 day old', 'garbage', 86400000],
		];
		for (const [label, content, ageMs] of cases) {
			const home = caseDir('lock-takeover-left');
			const stale = lockText(4242, Date.now() - 2 * logic.LOCK_STALE_MS);
			put(lockFile(home), stale);
			put(takeoverFile(home), content);
			ageFile(takeoverFile(home), ageMs);
			const result = logic.acquireMigrationLock({ home, pid: 5151, isAlive: (pid) => pid === 8888 });
			assert.deepEqual(result, { ok: false, pid: null }, label);
			assert.equal(fs.readFileSync(takeoverFile(home), 'utf8'), content, label);
			assert.equal(fs.readFileSync(lockFile(home), 'utf8'), stale, label);
			assert.deepEqual(fs.readdirSync(lockDir(home)).sort(), ['cleanup.lock', 'cleanup.lock.takeover'], label);
		}
	});

	it('acquireMigrationLock: the takeover file is removed by the run that created it, also when the lock is unreadable under it, and a lock replaced meanwhile is held', () => {
		const home = caseDir('lock-takeover-reread');
		put(lockFile(home), staleByAge());
		let reads = 0;
		const denied = wrappedFs({
			beforeRead(file) {
				if (file === lockFile(home) && ++reads === 2) throw errorWithCode('EACCES');
			},
		});
		assert.deepEqual(logic.acquireMigrationLock({ home, fs: denied, pid: 5151, now: NOW, isAlive: alive }), { ok: false, pid: null });
		assert.equal(reads, 2);
		assert.equal(fs.readFileSync(lockFile(home), 'utf8'), staleByAge());
		assert.deepEqual(fs.readdirSync(lockDir(home)), ['cleanup.lock']);
	});

	it('acquireMigrationLock: a lock that cannot be read is reported as held with no pid, and nothing is removed', () => {
		const home = caseDir('lock-unreadable');
		put(lockFile(home), staleByAge());
		const denied = wrappedFs({
			beforeRead: (file) => {
				if (file === lockFile(home)) throw errorWithCode('EACCES');
			},
		});
		assert.deepEqual(logic.acquireMigrationLock({ home, fs: denied, pid: 5151, now: NOW, isAlive: alive }), { ok: false, pid: null });
		assert.deepEqual(denied.calls.filter(([kind]) => kind === 'unlink'), []);
		assert.deepEqual(fs.readdirSync(lockDir(home)), ['cleanup.lock']);
	});

	it('acquireMigrationLock: a write error other than EEXIST is thrown, for the lock and for the takeover file', () => {
		const home = caseDir('lock-write-error');
		const denied = { mkdirSync() {}, writeFileSync: () => { throw errorWithCode('EACCES'); }, readFileSync: () => lockText(4242, 1), unlinkSync() {} };
		assert.throws(() => logic.acquireMigrationLock({ home: '/h', fs: denied, now: NOW }), { code: 'EACCES' });

		put(lockFile(home), staleByAge());
		const deniedTakeover = wrappedFs();
		const write = deniedTakeover.writeFileSync;
		deniedTakeover.writeFileSync = (file, content, options) => {
			if (file === takeoverFile(home)) throw errorWithCode('EACCES');
			return write(file, content, options);
		};
		assert.throws(() => logic.acquireMigrationLock({ home, fs: deniedTakeover, pid: 5151, now: NOW, isAlive: () => false }), { code: 'EACCES' });
		assert.deepEqual(fs.readdirSync(lockDir(home)), ['cleanup.lock']);
	});

	it('acquireMigrationLock: an unlink error other than ENOENT is thrown and the takeover file is still removed; ENOENT is ignored', () => {
		const home = caseDir('lock-unlink-error');
		put(lockFile(home), staleByAge());
		const stuck = wrappedFs({
			beforeUnlink: (file) => {
				if (file === lockFile(home)) throw errorWithCode('EPERM');
			},
		});
		assert.throws(() => logic.acquireMigrationLock({ home, fs: stuck, pid: 5151, now: NOW, isAlive: () => false }), { code: 'EPERM' });
		assert.deepEqual(fs.readdirSync(lockDir(home)), ['cleanup.lock']);
		assert.equal(fs.readFileSync(lockFile(home), 'utf8'), staleByAge());

		const gone = caseDir('lock-unlink-gone');
		put(lockFile(gone), staleByAge());
		const vanished = wrappedFs({ beforeUnlink: (file) => file === lockFile(gone) && fs.rmSync(file, { force: true }) });
		const unlink = vanished.unlinkSync;
		vanished.unlinkSync = (file) => {
			try {
				unlink(file);
			} catch (err) {
				if (err.code !== 'ENOENT') throw err;
				throw errorWithCode('ENOENT');
			}
		};
		assert.equal(logic.acquireMigrationLock({ home: gone, fs: vanished, pid: 5151, now: NOW, isAlive: () => false }).ok, true);
		assert.deepEqual(fs.readdirSync(lockDir(gone)), ['cleanup.lock']);
	});

	it('acquireMigrationLock: a lock that disappears between the failed create and the read is created without a takeover', () => {
		let writes = 0;
		const written = [];
		const vanishing = {
			mkdirSync() {},
			writeFileSync: (file) => {
				written.push(file);
				if (++writes === 1) throw errorWithCode('EEXIST');
			},
			readFileSync: () => {
				throw errorWithCode('ENOENT');
			},
			unlinkSync: () => assert.fail('nothing may be removed'),
		};
		const lock = logic.acquireMigrationLock({ home: '/h', fs: vanishing, now: NOW, isAlive: () => assert.fail('isAlive must not be asked') });
		assert.equal(lock.ok, true);
		assert.equal(writes, 2);
		assert.equal(new Set(written).size, 1);
		assert.doesNotThrow(() => lock.release());
	});

	it('acquireMigrationLock: a lock that vanishes and is replaced by another run before our second create is reported as held', () => {
		const home = caseDir('lock-vanish-race');
		put(lockFile(home), lockText(4242, NOW));
		let reads = 0;
		const racing = wrappedFs({
			beforeRead(file) {
				if (file !== lockFile(home)) return;
				if (++reads === 1) fs.rmSync(file);
				if (reads === 2) put(file, lockText(7, NOW));
			},
		});
		const original = racing.writeFileSync;
		racing.writeFileSync = (file, content, options) => {
			if (file === lockFile(home) && reads === 1) put(file, lockText(7, NOW));
			return original(file, content, options);
		};
		const result = logic.acquireMigrationLock({ home, fs: racing, pid: 5151, now: NOW, isAlive: alive });
		assert.deepEqual(result, { ok: false, pid: 7 });
	});

	it('acquireMigrationLock: the defaults are this process, the clock, and a kill-based liveness check', () => {
		const home = caseDir('lock-defaults');
		const first = logic.acquireMigrationLock({ home });
		assert.equal(first.ok, true);
		const content = JSON.parse(fs.readFileSync(lockFile(home), 'utf8'));
		assert.equal(content.pid, process.pid);
		assert.ok(Math.abs(content.at - Date.now()) < 60000);
		assert.deepEqual(logic.acquireMigrationLock({ home }), { ok: false, pid: process.pid });
		first.release();

		const finished = spawnSync(process.execPath, ['-e', '0']);
		put(lockFile(home), JSON.stringify({ pid: finished.pid, at: Date.now() }));
		assert.equal(logic.acquireMigrationLock({ home }).ok, true);
		assert.equal(JSON.parse(fs.readFileSync(lockFile(home), 'utf8')).pid, process.pid);
	});

	it('acquireMigrationLock: the default liveness check treats ESRCH as gone and every other kill result as alive', () => {
		const realKill = process.kill;
		const outcomes = [['ESRCH', true], ['EPERM', false], ['EINVAL', false]];
		try {
			for (const [code, replaced] of outcomes) {
				const home = caseDir('lock-kill');
				put(lockFile(home), `{"pid":4242,"at":${NOW}}`);
				process.kill = (pid, signal) => {
					assert.equal(pid, 4242);
					assert.equal(signal, 0);
					throw errorWithCode(code);
				};
				assert.equal(logic.acquireMigrationLock({ home, pid: 5151, now: NOW }).ok, replaced, code);
			}
		} finally {
			process.kill = realKill;
		}
	});

	it('acquireMigrationLock: a TypeError without home, and with a home that is empty or not a string', () => inTempCwd('lock-no-home', () => {
		assert.throws(() => logic.acquireMigrationLock(), { name: 'TypeError', message: 'acquireMigrationLock needs home' });
		assert.throws(() => logic.acquireMigrationLock({ pid: 1 }), { name: 'TypeError', message: 'acquireMigrationLock needs home' });
		assert.throws(() => logic.acquireMigrationLock({ home: '' }), { name: 'TypeError', message: 'acquireMigrationLock needs home' });
		assert.throws(() => logic.acquireMigrationLock({ home: null }), { name: 'TypeError', message: 'acquireMigrationLock needs home' });
		assert.throws(() => logic.readSecretSources(), { name: 'TypeError', message: 'readSecretSources needs home' });
		assert.throws(() => logic.readSecretSources({ home: '' }), { name: 'TypeError', message: 'readSecretSources needs home' });
		assert.deepEqual(fs.readdirSync(process.cwd()), []);
	}));
});

describe('classifyContextName and isOrgDownload', () => {
	it('classifyContextName and isOrgDownload: the table, including a snapshot that is null, an array, or a string', () => {
		const other = { kind: 'other', slug: null, version: null };
		const names = [
			['hubspot-v2.md', { kind: 'context-file', slug: 'hubspot', version: 2 }],
			['hubspot-v2', { kind: 'context-dir', slug: 'hubspot', version: 2 }],
			['my-app-v10.md', { kind: 'context-file', slug: 'my-app', version: 10 }],
			['my-app-v10', { kind: 'context-dir', slug: 'my-app', version: 10 }],
			['x-v2-v3.md', { kind: 'context-file', slug: 'x-v2', version: 3 }],
			['x-v007', { kind: 'context-dir', slug: 'x', version: 7 }],
			['hubspot.md', other],
			['hubspot-v.md', other],
			['hubspot-vx', other],
			['-v1.md', other],
			['-v1', other],
			['hubspot-v1.MD', other],
			['hubspot-v1.md.bak', other],
			['hubspot-v1.json', other],
			['hubspot-v1 ', other],
			['metadata.json', other],
			['', other],
			[undefined, other],
			[null, other],
			[5, other],
			[{}, other],
		];
		for (const [name, expected] of names) assert.deepEqual(logic.classifyContextName(name), expected, String(name));

		const texts = [
			['{"snapshot":{"modules":[]}}', true],
			['{"snapshot":{}}', true],
			['\uFEFF{"snapshot":{"a":1}}', true],
			['{"app":"x","snapshot":{"a":1},"functions":[]}', true],
			['{"snapshot":null}', false],
			['{"snapshot":[]}', false],
			['{"snapshot":[{"a":1}]}', false],
			['{"snapshot":"x"}', false],
			['{"snapshot":0}', false],
			['{"snapshot":true}', false],
			['{"Snapshot":{}}', false],
			['{"app":{"snapshot":{}}}', false],
			['{"__proto__":{"snapshot":{}}}', false],
			['{}', false],
			['[]', false],
			['null', false],
			['"snapshot"', false],
			['', false],
			['not json', false],
			['{"snapshot":{}', false],
		];
		for (const [text, expected] of texts) assert.equal(logic.isOrgDownload(text), expected, text);
		for (const value of [undefined, null, 5, {}, []]) assert.equal(logic.isOrgDownload(value), false, String(value));
		assert.equal(logic.isOrgDownload(Buffer.from('{"snapshot":{}}')), true);
	});

	it('download-app.js of the old tree never writes a snapshot key', () => {
		const text = fs.readFileSync(path.join(__dirname, '..', '..', 'download-app.js'), 'utf8');
		assert.equal(text.includes('snapshot'), false);
	});
});

describe('listContextFiles', () => {
	function buildContextRoot(label) {
		const root = path.join(caseDir(label), 'make-app-contexts');
		put(path.join(root, 'alpha-v1.md'), 'alpha note');
		put(path.join(root, 'alpha-v1', 'metadata.json'), '{"app":"alpha"}');
		put(path.join(root, 'alpha-v1', 'reviews', 'latest.json'), '{"ok":true}');
		put(path.join(root, 'alpha-v1', 'reviews', 'history', '2026-10-01.json'), '{}');
		put(path.join(root, 'alpha-v1', 'reviews', '.DS_Store'), 'x');
		put(path.join(root, 'alpha-v1', 'reviews', '.hidden', 'a.json'), 'x');
		put(path.join(root, 'alpha-v1', 'functions', 'f', 'a.js'), '//');
		put(path.join(root, 'alpha-v1', 'attachments', 'a.png'), 'x');
		put(path.join(root, 'alpha-v1', 'modules', 'm.json'), '{}');
		put(path.join(root, 'alpha-v1', 'notes.md'), 'x');
		put(path.join(root, 'noreviews-v9', 'metadata.json'), '{"app":"x"}');
		put(path.join(root, 'beta-v2.md'), 'beta note');
		put(path.join(root, 'beta-v2', 'metadata.json'), JSON.stringify({ snapshot: { modules: [] } }));
		put(path.join(root, 'beta-v2', 'reviews', 'latest.json'), '{}');
		put(path.join(root, '.hidden-v1.md'), 'x');
		put(path.join(root, '.hidden-v1', 'reviews', 'latest.json'), 'x');
		put(path.join(root, 'notes.txt'), 'x');
		put(path.join(root, 'plain', 'reviews', 'latest.json'), 'x');
		put(path.join(root, 'gamma-v3'), 'a file with a directory name');
		put(path.join(root, 'alpha-v1.md.bak'), 'x');
		fs.mkdirSync(path.join(root, 'delta-v4.md'));
		return root;
	}

	const rels = (listing) => listing.files.map((file) => file.rel);

	it('listContextFiles: top-level context files and reviews only; dotfiles, metadata.json, functions/, and attachments/ skipped; deep symlinks reported; an org folder skips its reviews but not its .md; a missing root', () => {
		const root = buildContextRoot('list-basic');
		const listing = logic.listContextFiles({ root });
		assert.deepEqual(rels(listing), ['alpha-v1.md', 'alpha-v1/reviews/history/2026-10-01.json', 'alpha-v1/reviews/latest.json', 'beta-v2.md']);
		assert.deepEqual(listing.orgSkipped, ['beta-v2/']);
		assert.deepEqual(listing.symlinks, []);
		for (const file of listing.files) {
			const stat = fs.statSync(file.abs);
			assert.equal(file.abs, path.join(root, ...file.rel.split('/')));
			assert.equal(file.size, stat.size);
			assert.equal(file.mtimeMs, stat.mtimeMs);
			assert.deepEqual(Object.keys(file), ['rel', 'abs', 'size', 'mtimeMs']);
		}
		assert.deepEqual(Object.keys(listing), ['files', 'orgSkipped', 'symlinks']);

		const missing = path.join(caseDir('list-missing'), 'nowhere');
		assert.deepEqual(logic.listContextFiles({ root: missing }), { files: [], orgSkipped: [], symlinks: [] });
		const asFile = path.join(caseDir('list-file-root'), 'file');
		put(asFile, 'x');
		assert.deepEqual(logic.listContextFiles({ root: asFile }), { files: [], orgSkipped: [], symlinks: [] });
		assert.deepEqual(logic.listContextFiles({ root: caseDir('list-empty') }), { files: [], orgSkipped: [], symlinks: [] });
	});

	it('listContextFiles: files up to four levels below reviews/ are listed, deeper ones are not', () => {
		const root = path.join(caseDir('list-depth'), 'contexts');
		put(path.join(root, 'app-v1', 'reviews', 'l0.json'), '{}');
		put(path.join(root, 'app-v1', 'reviews', 'a', 'l1.json'), '{}');
		put(path.join(root, 'app-v1', 'reviews', 'a', 'b', 'c', 'd', 'l4.json'), '{}');
		put(path.join(root, 'app-v1', 'reviews', 'a', 'b', 'c', 'd', 'e', 'l5.json'), '{}');
		assert.deepEqual(rels(logic.listContextFiles({ root })), [
			'app-v1/reviews/a/b/c/d/l4.json',
			'app-v1/reviews/a/l1.json',
			'app-v1/reviews/l0.json',
		]);
	});

	it('listContextFiles: a metadata.json that is not an org download keeps the reviews, and so does one that is a symbolic link', POSIX_ONLY, () => {
		const root = path.join(caseDir('list-meta'), 'contexts');
		put(path.join(root, 'plain-v1', 'metadata.json'), 'not json');
		put(path.join(root, 'plain-v1', 'reviews', 'latest.json'), '{}');
		put(path.join(root, 'null-v1', 'metadata.json'), '{"snapshot":null}');
		put(path.join(root, 'null-v1', 'reviews', 'latest.json'), '{}');
		put(path.join(root, 'none-v1', 'reviews', 'latest.json'), '{}');
		const outside = path.join(caseDir('list-meta-target'), 'metadata.json');
		put(outside, '{"snapshot":{"a":1}}');
		fs.mkdirSync(path.join(root, 'link-v1', 'reviews'), { recursive: true });
		fs.symlinkSync(outside, path.join(root, 'link-v1', 'metadata.json'));
		put(path.join(root, 'link-v1', 'reviews', 'latest.json'), '{}');
		const listing = logic.listContextFiles({ root });
		assert.deepEqual(rels(listing), ['link-v1/reviews/latest.json', 'none-v1/reviews/latest.json', 'null-v1/reviews/latest.json', 'plain-v1/reviews/latest.json']);
		assert.deepEqual(listing.orgSkipped, []);
	});

	it('listContextFiles: symbolic links below the root are reported and never followed, and a symbolic link as the root is followed', POSIX_ONLY, () => {
		const root = buildContextRoot('list-links');
		const outside = caseDir('list-links-outside');
		put(path.join(outside, 'file.md'), 'outside file');
		put(path.join(outside, 'dir', 'reviews', 'latest.json'), '{}');
		put(path.join(outside, 'reviews-target', 'x.json'), '{}');
		fs.symlinkSync(path.join(outside, 'file.md'), path.join(root, 'eps-v5.md'));
		fs.symlinkSync(path.join(outside, 'dir'), path.join(root, 'zeta-v6'));
		fs.symlinkSync(path.join(outside, 'file.md'), path.join(root, 'not-a-context-name'));
		fs.mkdirSync(path.join(root, 'theta-v7'));
		fs.symlinkSync(path.join(outside, 'reviews-target'), path.join(root, 'theta-v7', 'reviews'));
		fs.symlinkSync(path.join(outside, 'file.md'), path.join(root, 'alpha-v1', 'reviews', 'link.json'));
		fs.symlinkSync(path.join(outside, 'reviews-target'), path.join(root, 'alpha-v1', 'reviews', 'linkdir'));
		put(path.join(root, 'iota-v8', 'reviews', 'latest.json'), '{}');
		fs.symlinkSync(path.join(outside, 'file.md'), path.join(root, 'iota-v8', 'reviews', 'link.json'));
		fs.symlinkSync(path.join(outside, 'file.md'), path.join(root, 'iota-v8.md'));
		const listing = logic.listContextFiles({ root });
		assert.deepEqual(listing.symlinks, ['alpha-v1/reviews/link.json', 'alpha-v1/reviews/linkdir', 'eps-v5.md', 'iota-v8.md', 'iota-v8/reviews/link.json', 'theta-v7/reviews', 'zeta-v6']);
		assert.deepEqual(rels(listing), ['alpha-v1.md', 'alpha-v1/reviews/history/2026-10-01.json', 'alpha-v1/reviews/latest.json', 'beta-v2.md', 'iota-v8/reviews/latest.json']);

		const linkedRoot = path.join(caseDir('list-linked-root'), 'link');
		fs.symlinkSync(root, linkedRoot);
		const viaLink = logic.listContextFiles({ root: linkedRoot });
		assert.deepEqual(rels(viaLink), rels(listing));
		assert.equal(viaLink.files[0].abs, path.join(linkedRoot, 'alpha-v1.md'));
		assert.deepEqual(viaLink.symlinks, listing.symlinks);
		assert.deepEqual(viaLink.orgSkipped, ['beta-v2/']);
		const dangling = path.join(caseDir('list-dangling'), 'link');
		fs.symlinkSync(path.join(outside, 'nowhere'), dangling);
		assert.deepEqual(logic.listContextFiles({ root: dangling }), { files: [], orgSkipped: [], symlinks: [] });
	});

	it('listContextFiles: a missing root through an injected fs gives empty lists, and any other read error is thrown with its code', () => {
		const missing = { readdirSync: () => { throw errorWithCode('ENOENT'); } };
		assert.deepEqual(logic.listContextFiles({ root: '/r', fs: missing }), { files: [], orgSkipped: [], symlinks: [] });
		const notDir = { readdirSync: () => { throw errorWithCode('ENOTDIR'); } };
		assert.deepEqual(logic.listContextFiles({ root: '/r', fs: notDir }), { files: [], orgSkipped: [], symlinks: [] });
		const denied = { readdirSync: () => { throw errorWithCode('EACCES'); } };
		assert.throws(() => logic.listContextFiles({ root: '/r', fs: denied }), { code: 'EACCES' });
	});

	it('listContextFiles: a folder or a file that vanishes while the listing runs is skipped', () => {
		const root = buildContextRoot('list-vanish');
		const vanishing = {
			readdirSync: (dir, options) => {
				if (dir === path.join(root, 'alpha-v1', 'reviews', 'history')) throw errorWithCode('ENOENT');
				return fs.readdirSync(dir, options);
			},
			lstatSync: (file) => {
				if (file === path.join(root, 'beta-v2.md')) throw errorWithCode('ENOENT');
				return fs.lstatSync(file);
			},
			readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
		};
		assert.deepEqual(rels(logic.listContextFiles({ root, fs: vanishing })), ['alpha-v1.md', 'alpha-v1/reviews/latest.json']);
		const folderGone = {
			readdirSync: (dir, options) => {
				if (dir === path.join(root, 'alpha-v1')) throw errorWithCode('ENOENT');
				return fs.readdirSync(dir, options);
			},
			lstatSync: (file) => fs.lstatSync(file),
			readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
		};
		assert.deepEqual(rels(logic.listContextFiles({ root, fs: folderGone })), ['alpha-v1.md', 'beta-v2.md']);
	});

	it('listContextFiles: a stat or metadata read error other than a missing file is thrown with its code, and a file that is no longer a regular file is skipped', () => {
		const root = buildContextRoot('list-errors');
		const wrapped = (over) => ({ readdirSync: (dir, options) => fs.readdirSync(dir, options), lstatSync: (file) => fs.lstatSync(file), readFileSync: (file, encoding) => fs.readFileSync(file, encoding), ...over });
		const statDenied = wrapped({
			lstatSync: (file) => {
				if (file === path.join(root, 'alpha-v1.md')) throw errorWithCode('EACCES');
				return fs.lstatSync(file);
			},
		});
		assert.throws(() => logic.listContextFiles({ root, fs: statDenied }), { code: 'EACCES' });

		const metadataFile = path.join(root, 'beta-v2', 'metadata.json');
		const metadataDenied = wrapped({
			readFileSync: (file, encoding) => {
				if (file === metadataFile) throw errorWithCode('EACCES');
				return fs.readFileSync(file, encoding);
			},
		});
		assert.throws(() => logic.listContextFiles({ root, fs: metadataDenied }), { code: 'EACCES' });
		const metadataGone = wrapped({
			readFileSync: (file, encoding) => {
				if (file === metadataFile) throw errorWithCode('ENOENT');
				return fs.readFileSync(file, encoding);
			},
		});
		const listing = logic.listContextFiles({ root, fs: metadataGone });
		assert.deepEqual(listing.orgSkipped, []);
		assert.ok(rels(listing).includes('beta-v2/reviews/latest.json'));

		const swapped = wrapped({
			lstatSync: (file) => (file === path.join(root, 'alpha-v1.md') ? { isFile: () => false, size: 0, mtimeMs: 0 } : fs.lstatSync(file)),
		});
		assert.equal(rels(logic.listContextFiles({ root, fs: swapped })).includes('alpha-v1.md'), false);
	});

	it('listContextFiles: the org folders are listed in the order of their text with the slash', () => {
		const root = path.join(caseDir('list-org-order'), 'contexts');
		for (const name of ['a-v1', 'a-v1-x-v2', 'b-v1']) put(path.join(root, name, 'metadata.json'), '{"snapshot":{}}');
		assert.deepEqual(logic.listContextFiles({ root }).orgSkipped, ['a-v1-x-v2/', 'a-v1/', 'b-v1/']);
	});

	it('listContextFiles: the listing is sorted by relative path', () => {
		const root = path.join(caseDir('list-sorted'), 'contexts');
		for (const name of ['b-v1.md', 'a-v1.md', 'c-v1.md', 'a-v10.md', 'a-v2.md']) put(path.join(root, name), name);
		put(path.join(root, 'b-v1', 'reviews', 'z.json'), '{}');
		put(path.join(root, 'b-v1', 'reviews', 'a.json'), '{}');
		assert.deepEqual(rels(logic.listContextFiles({ root })), ['a-v1.md', 'a-v10.md', 'a-v2.md', 'b-v1.md', 'b-v1/reviews/a.json', 'b-v1/reviews/z.json', 'c-v1.md']);
	});
});

describe('planContexts and sameContent', () => {
	const BASE = 1700000000000;
	const absent = () => ({ exists: false, isFile: false, same: false, parentIsFile: false });

	function contextRoot(label, files) {
		const root = path.join(caseDir(label), 'contexts');
		fs.mkdirSync(root, { recursive: true });
		for (const [rel, spec] of Object.entries(files)) {
			const abs = path.join(root, ...rel.split('/'));
			put(abs, spec.text);
			if (spec.mtimeMs !== undefined) fs.utimesSync(abs, spec.mtimeMs / 1000, spec.mtimeMs / 1000);
		}
		return root;
	}

	function plan(claudeFiles, cursorFiles, target = absent) {
		const claude = claudeFiles === null ? undefined : logic.listContextFiles({ root: contextRoot('plan-claude', claudeFiles) });
		const cursor = cursorFiles === null ? undefined : logic.listContextFiles({ root: contextRoot('plan-cursor', cursorFiles) });
		return { claude, cursor, result: logic.planContexts({ claude, cursor, target }) };
	}

	it('planContexts: identical once; newer wins; a tie goes to claude; already present; kept existing; a parent that is a file is blocked', () => {
		const { claude, cursor, result } = plan(
			{
				'same-v1.md': { text: 'same text', mtimeMs: BASE },
				'claude-newer-v1.md': { text: 'claude new', mtimeMs: BASE + 5000 },
				'cursor-newer-v1.md': { text: 'claude old', mtimeMs: BASE },
				'tie-v1.md': { text: 'claude tie', mtimeMs: BASE },
				'only-claude-v1.md': { text: 'only claude', mtimeMs: BASE },
			},
			{
				'same-v1.md': { text: 'same text', mtimeMs: BASE + 9000 },
				'claude-newer-v1.md': { text: 'cursor old', mtimeMs: BASE },
				'cursor-newer-v1.md': { text: 'cursor new', mtimeMs: BASE + 5000 },
				'tie-v1.md': { text: 'cursor tie', mtimeMs: BASE },
				'only-cursor-v1.md': { text: 'only cursor', mtimeMs: BASE },
			},
		);
		const srcOf = (rel, from) => (from === 'claude' ? claude : cursor).files.find((file) => file.rel === rel).abs;
		assert.deepEqual(result.copies, [
			{ rel: 'claude-newer-v1.md', from: 'claude', src: srcOf('claude-newer-v1.md', 'claude') },
			{ rel: 'cursor-newer-v1.md', from: 'cursor', src: srcOf('cursor-newer-v1.md', 'cursor') },
			{ rel: 'only-claude-v1.md', from: 'claude', src: srcOf('only-claude-v1.md', 'claude') },
			{ rel: 'only-cursor-v1.md', from: 'cursor', src: srcOf('only-cursor-v1.md', 'cursor') },
			{ rel: 'same-v1.md', from: 'claude', src: srcOf('same-v1.md', 'claude') },
			{ rel: 'tie-v1.md', from: 'claude', src: srcOf('tie-v1.md', 'claude') },
		]);
		assert.deepEqual(result.duplicates, [
			{ rel: 'claude-newer-v1.md', used: 'claude' },
			{ rel: 'cursor-newer-v1.md', used: 'cursor' },
			{ rel: 'tie-v1.md', used: 'claude' },
		]);
		assert.deepEqual({ alreadyPresent: result.alreadyPresent, keptExisting: result.keptExisting, blocked: result.blocked }, { alreadyPresent: 0, keptExisting: [], blocked: [] });
		assert.deepEqual(Object.keys(result), ['copies', 'alreadyPresent', 'keptExisting', 'duplicates', 'blocked']);
	});

	it('planContexts: two files of the same size with different content are different, and the newer one wins', () => {
		const { result } = plan({ 'a-v1.md': { text: 'abcd', mtimeMs: BASE } }, { 'a-v1.md': { text: 'abce', mtimeMs: BASE + 1000 } });
		assert.deepEqual(result.duplicates, [{ rel: 'a-v1.md', used: 'cursor' }]);
		assert.equal(result.copies[0].from, 'cursor');
	});

	it('planContexts: either root may be missing or empty', () => {
		const files = { 'a-v1.md': { text: 'a', mtimeMs: BASE } };
		assert.deepEqual(plan(null, null).result, { copies: [], alreadyPresent: 0, keptExisting: [], duplicates: [], blocked: [] });
		assert.deepEqual(plan(files, null).result.copies.map((copy) => copy.from), ['claude']);
		assert.deepEqual(plan(null, files).result.copies.map((copy) => copy.from), ['cursor']);
		const empty = { files: [], orgSkipped: [], symlinks: [] };
		const listing = logic.listContextFiles({ root: contextRoot('plan-one', files) });
		assert.deepEqual(logic.planContexts({ claude: empty, cursor: listing, target: absent }).copies.map((copy) => copy.from), ['cursor']);
		assert.deepEqual(logic.planContexts({ claude: listing, cursor: empty, target: absent }).copies.map((copy) => copy.from), ['claude']);
	});

	it('planContexts: the target decides between a copy, already present, kept existing, and blocked, and gets the relative path and the chosen source', () => {
		const calls = [];
		const answers = {
			'copy-v1.md': absent(),
			'present-v1.md': { exists: true, isFile: true, same: true, parentIsFile: false },
			'different-v1.md': { exists: true, isFile: true, same: false, parentIsFile: false },
			'folder-v1.md': { exists: true, isFile: false, same: false, parentIsFile: false },
			'blocked-v1/reviews/latest.json': { exists: false, isFile: false, same: false, parentIsFile: true },
		};
		const files = { 'copy-v1.md': { text: 'c', mtimeMs: BASE }, 'present-v1.md': { text: 'p', mtimeMs: BASE }, 'different-v1.md': { text: 'd', mtimeMs: BASE }, 'folder-v1.md': { text: 'f', mtimeMs: BASE }, 'blocked-v1/reviews/latest.json': { text: 'b', mtimeMs: BASE } };
		const { claude, result } = plan(files, null, (rel, source) => {
			calls.push([rel, source]);
			return answers[rel];
		});
		assert.deepEqual(result.copies.map((copy) => copy.rel), ['copy-v1.md']);
		assert.equal(result.alreadyPresent, 1);
		assert.deepEqual(result.keptExisting, ['different-v1.md', 'folder-v1.md']);
		assert.deepEqual(result.blocked, ['blocked-v1/reviews/latest.json']);
		assert.deepEqual(result.duplicates, []);
		assert.deepEqual(calls.map(([rel]) => rel), ['blocked-v1/reviews/latest.json', 'copy-v1.md', 'different-v1.md', 'folder-v1.md', 'present-v1.md']);
		const first = claude.files.find((file) => file.rel === 'copy-v1.md');
		assert.deepEqual(calls.find(([rel]) => rel === 'copy-v1.md')[1], { rel: 'copy-v1.md', from: 'claude', src: first.abs, size: first.size, mtimeMs: first.mtimeMs });
	});

	it('planContexts: an existing target that is not a file is kept even when it claims to be the same', () => {
		const { result } = plan({ 'a-v1.md': { text: 'a', mtimeMs: BASE } }, null, () => ({ exists: true, isFile: false, same: true, parentIsFile: false }));
		assert.deepEqual(result, { copies: [], alreadyPresent: 0, keptExisting: ['a-v1.md'], duplicates: [], blocked: [] });
	});

	it('planContexts: a target whose parent is a file is blocked even when it also claims to exist, and an existing different file is never planned for a copy', () => {
		const { result } = plan({ 'a-v1.md': { text: 'a', mtimeMs: BASE } }, null, () => ({ exists: true, isFile: true, same: true, parentIsFile: true }));
		assert.deepEqual(result, { copies: [], alreadyPresent: 0, keptExisting: [], duplicates: [], blocked: ['a-v1.md'] });
	});

	it('planContexts: a TypeError without target, and the default fs reads the real files', () => {
		assert.throws(() => logic.planContexts(), { name: 'TypeError', message: 'planContexts needs target' });
		assert.throws(() => logic.planContexts({ claude: { files: [] } }), { name: 'TypeError', message: 'planContexts needs target' });
		const { result } = plan({ 'a-v1.md': { text: 'same', mtimeMs: BASE } }, { 'a-v1.md': { text: 'same', mtimeMs: BASE + 1000 } });
		assert.deepEqual(result.duplicates, []);
	});

	it('planContexts: the hashing of two roots uses the injected fs', () => {
		const reads = [];
		const injected = {
			lstatSync: () => ({ isFile: () => true, size: 4 }),
			readFileSync: (file) => {
				reads.push(file);
				return Buffer.from('same');
			},
		};
		const claude = { files: [{ rel: 'a-v1.md', abs: '/c/a-v1.md', size: 4, mtimeMs: BASE }] };
		const cursor = { files: [{ rel: 'a-v1.md', abs: '/u/a-v1.md', size: 4, mtimeMs: BASE + 1 }] };
		const result = logic.planContexts({ claude, cursor, target: absent, fs: injected });
		assert.deepEqual(reads, ['/c/a-v1.md', '/u/a-v1.md']);
		assert.deepEqual(result.duplicates, []);
		assert.deepEqual(result.copies, [{ rel: 'a-v1.md', from: 'claude', src: '/c/a-v1.md' }]);
	});

	it('sameContent: the size first, then sha256; empty files, folders, links, and missing files', () => {
		const dir = caseDir('same-content');
		const write = (name, text) => {
			put(path.join(dir, name), text);
			return path.join(dir, name);
		};
		const one = write('one', 'abcdef');
		assert.equal(logic.sameContent({ a: one, b: write('two', 'abcdef') }), true);
		assert.equal(logic.sameContent({ a: one, b: write('three', 'abcdeg') }), false);
		assert.equal(logic.sameContent({ a: one, b: write('four', 'abcde') }), false);
		assert.equal(logic.sameContent({ a: write('e1', ''), b: write('e2', '') }), true);
		assert.equal(logic.sameContent({ a: one, b: dir }), false);
		assert.equal(logic.sameContent({ a: dir, b: dir }), false);
		assert.equal(logic.sameContent({ a: one, b: path.join(dir, 'missing') }), false);
		if (process.platform !== 'win32') {
			fs.symlinkSync(one, path.join(dir, 'link'));
			assert.equal(logic.sameContent({ a: one, b: path.join(dir, 'link') }), false);
		}
	});

	it('sameContent: files of different sizes, an empty pair, and entries that are not regular files are decided without reading', () => {
		const reads = [];
		const sized = (sizes, regular = true) => ({
			lstatSync: (file) => ({ isFile: () => regular, size: sizes[file] }),
			readFileSync: (file) => {
				reads.push(file);
				return Buffer.from('x');
			},
		});
		assert.equal(logic.sameContent({ a: '/a', b: '/b', fs: sized({ '/a': 5, '/b': 6 }) }), false);
		assert.equal(logic.sameContent({ a: '/a', b: '/b', fs: sized({ '/a': 0, '/b': 0 }) }), true);
		assert.equal(logic.sameContent({ a: '/a', b: '/b', fs: sized({ '/a': 5, '/b': 5 }, false) }), false);
		const mixed = {
			lstatSync: (file) => ({ isFile: () => file === '/a', size: 5 }),
			readFileSync: (file) => {
				reads.push(file);
				return Buffer.from('x');
			},
		};
		assert.equal(logic.sameContent({ a: '/a', b: '/b', fs: mixed }), false);
		assert.equal(logic.sameContent({ a: '/b', b: '/a', fs: mixed }), false);
		assert.deepEqual(reads, []);
	});

	it('sameContent: a file over 64 MB is never called identical, one of exactly 64 MB is hashed, and a read error means different', () => {
		const LIMIT = 64 * 1024 * 1024;
		const reads = [];
		const withSize = (size, failing) => ({
			lstatSync: () => ({ isFile: () => true, size }),
			readFileSync: (file) => {
				reads.push(file);
				if (failing) throw errorWithCode('EIO');
				return Buffer.from('x');
			},
		});
		assert.equal(logic.sameContent({ a: '/a', b: '/b', fs: withSize(LIMIT + 1) }), false);
		assert.deepEqual(reads, []);
		assert.equal(logic.sameContent({ a: '/a', b: '/b', fs: withSize(LIMIT) }), true);
		assert.deepEqual(reads, ['/a', '/b']);
		assert.equal(logic.sameContent({ a: '/a', b: '/b', fs: withSize(5, true) }), false);
	});
});

describe('applyContextCopies', () => {
	const NOW = 1700000000000;
	const COPYFILE_EXCL = fs.constants.COPYFILE_EXCL;

	function sourceRoot(label, files) {
		const root = path.join(caseDir(label), 'old-contexts');
		for (const [rel, text] of Object.entries(files)) put(path.join(root, ...rel.split('/')), text);
		return root;
	}

	const planFor = (root, rels) => ({ copies: rels.map((rel) => ({ rel, from: 'claude', src: path.join(root, ...rel.split('/')) })) });
	const targetFor = (label) => path.join(caseDir(label), 'make-custom-app', 'contexts');
	const listAll = (root) => {
		const out = [];
		const walk = (dir) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else out.push(path.relative(root, full).split(path.sep).join('/'));
			}
		};
		if (fs.existsSync(root)) walk(root);
		return out.sort();
	};

	function recordingFs(overrides = {}) {
		const calls = [];
		const wrapped = { calls };
		for (const name of ['readdirSync', 'lstatSync', 'mkdirSync', 'copyFileSync', 'linkSync', 'unlinkSync', 'utimesSync', 'renameSync']) {
			wrapped[name] = (...args) => {
				calls.push([name, ...args]);
				if (overrides[name]) return overrides[name](args, () => fs[name](...args));
				return fs[name](...args);
			};
		}
		return wrapped;
	}

	it('applyContextCopies: copies into new folders of mode 0700, keeps the file content and the source mtime, and leaves no temp file', () => {
		const root = sourceRoot('apply-basic', { 'a-v1.md': 'note a', 'a-v1/reviews/latest.json': '{"a":1}', 'a-v1/reviews/deep/x.json': '{"x":2}' });
		const old = new Date(NOW - 40 * DAY);
		for (const rel of ['a-v1.md', 'a-v1/reviews/latest.json']) fs.utimesSync(path.join(root, ...rel.split('/')), old, old);
		const targetRoot = targetFor('apply-basic-target');
		const result = logic.applyContextCopies({ plan: planFor(root, ['a-v1.md', 'a-v1/reviews/latest.json', 'a-v1/reviews/deep/x.json']), targetRoot, pid: 4242, now: NOW });
		assert.deepEqual(result, { copied: 3, errors: [] });
		assert.deepEqual(listAll(targetRoot), ['a-v1.md', 'a-v1/reviews/deep/x.json', 'a-v1/reviews/latest.json']);
		assert.equal(fs.readFileSync(path.join(targetRoot, 'a-v1.md'), 'utf8'), 'note a');
		assert.equal(fs.readFileSync(path.join(targetRoot, 'a-v1', 'reviews', 'latest.json'), 'utf8'), '{"a":1}');
		for (const rel of ['a-v1.md', 'a-v1/reviews/latest.json']) {
			const src = fs.statSync(path.join(root, ...rel.split('/')));
			const dst = fs.statSync(path.join(targetRoot, ...rel.split('/')));
			assert.ok(Math.abs(dst.mtimeMs - src.mtimeMs) < 2, `${rel} mtime`);
			assert.equal(dst.nlink, 1);
		}
		if (process.platform !== 'win32') {
			for (const dir of [targetRoot, path.join(targetRoot, 'a-v1'), path.join(targetRoot, 'a-v1', 'reviews'), path.join(targetRoot, 'a-v1', 'reviews', 'deep')]) {
				assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
			}
		}
	});

	it('applyContextCopies: an existing folder keeps its mode', POSIX_ONLY, () => {
		const root = sourceRoot('apply-mode', { 'a-v1/reviews/latest.json': '{}' });
		const targetRoot = targetFor('apply-mode-target');
		fs.mkdirSync(path.join(targetRoot, 'a-v1'), { recursive: true });
		fs.chmodSync(path.join(targetRoot, 'a-v1'), 0o755);
		fs.chmodSync(targetRoot, 0o750);
		logic.applyContextCopies({ plan: planFor(root, ['a-v1/reviews/latest.json']), targetRoot, pid: 1, now: NOW });
		assert.equal(fs.statSync(path.join(targetRoot, 'a-v1')).mode & 0o777, 0o755);
		assert.equal(fs.statSync(targetRoot).mode & 0o777, 0o750);
		assert.equal(fs.statSync(path.join(targetRoot, 'a-v1', 'reviews')).mode & 0o777, 0o700);
	});

	it('applyContextCopies: never overwrites; a file that appeared after the plan stays as it is, is reported with its code, and the other files are still copied', () => {
		const root = sourceRoot('apply-never', { 'a-v1.md': 'new a', 'b-v1.md': 'new b' });
		const targetRoot = targetFor('apply-never-target');
		put(path.join(targetRoot, 'a-v1.md'), 'user wrote this');
		const result = logic.applyContextCopies({ plan: planFor(root, ['a-v1.md', 'b-v1.md']), targetRoot, pid: 4242, now: NOW });
		assert.deepEqual(result, { copied: 1, errors: [{ rel: 'a-v1.md', code: 'EEXIST' }] });
		assert.equal(fs.readFileSync(path.join(targetRoot, 'a-v1.md'), 'utf8'), 'user wrote this');
		assert.equal(fs.readFileSync(path.join(targetRoot, 'b-v1.md'), 'utf8'), 'new b');
		assert.deepEqual(listAll(targetRoot), ['a-v1.md', 'b-v1.md']);
	});

	it('applyContextCopies: never overwrites a symbolic link or a folder at the target path either', POSIX_ONLY, () => {
		const root = sourceRoot('apply-never-link', { 'a-v1.md': 'new a', 'b-v1.md': 'new b' });
		const targetRoot = targetFor('apply-never-link-target');
		const elsewhere = path.join(caseDir('apply-never-link-out'), 'secret.txt');
		put(elsewhere, 'untouched');
		fs.mkdirSync(targetRoot, { recursive: true });
		fs.symlinkSync(elsewhere, path.join(targetRoot, 'a-v1.md'));
		fs.mkdirSync(path.join(targetRoot, 'b-v1.md'));
		const result = logic.applyContextCopies({ plan: planFor(root, ['a-v1.md', 'b-v1.md']), targetRoot, pid: 4242, now: NOW });
		assert.equal(result.copied, 0);
		assert.deepEqual(result.errors.map((error) => error.rel), ['a-v1.md', 'b-v1.md']);
		assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'untouched');
		assert.deepEqual(listAll(targetRoot), ['a-v1.md']);
	});

	it('applyContextCopies: the temp file is <dst>.migrate-<pid>-<n>.tmp with n counting from 1, copied with COPYFILE_EXCL, and the file is made with a hard link', () => {
		const root = sourceRoot('apply-calls', { 'a-v1.md': 'a', 'b-v1.md': 'b' });
		const targetRoot = targetFor('apply-calls-target');
		const recording = recordingFs();
		const result = logic.applyContextCopies({ plan: planFor(root, ['a-v1.md', 'b-v1.md']), targetRoot, fs: recording, pid: 4242, now: NOW });
		assert.equal(result.copied, 2);
		const interesting = recording.calls.filter(([name]) => ['copyFileSync', 'linkSync', 'unlinkSync', 'renameSync'].includes(name));
		assert.deepEqual(interesting, [
			['copyFileSync', path.join(root, 'a-v1.md'), `${path.join(targetRoot, 'a-v1.md')}.migrate-4242-1.tmp`, COPYFILE_EXCL],
			['linkSync', `${path.join(targetRoot, 'a-v1.md')}.migrate-4242-1.tmp`, path.join(targetRoot, 'a-v1.md')],
			['unlinkSync', `${path.join(targetRoot, 'a-v1.md')}.migrate-4242-1.tmp`],
			['copyFileSync', path.join(root, 'b-v1.md'), `${path.join(targetRoot, 'b-v1.md')}.migrate-4242-2.tmp`, COPYFILE_EXCL],
			['linkSync', `${path.join(targetRoot, 'b-v1.md')}.migrate-4242-2.tmp`, path.join(targetRoot, 'b-v1.md')],
			['unlinkSync', `${path.join(targetRoot, 'b-v1.md')}.migrate-4242-2.tmp`],
		]);
		const stamps = recording.calls.filter(([name]) => name === 'utimesSync');
		assert.deepEqual(stamps.map(([, file]) => file), [path.join(targetRoot, 'a-v1.md'), path.join(targetRoot, 'b-v1.md')]);
		assert.equal(typeof stamps[0][2], 'number');
		assert.equal(stamps[0][3], fs.statSync(path.join(root, 'a-v1.md')).mtimeMs / 1000);
	});

	it('applyContextCopies: falls back to rename on EXDEV, EPERM, and ENOTSUP after it checked that the target is still free', () => {
		for (const code of ['EXDEV', 'EPERM', 'ENOTSUP']) {
			const root = sourceRoot(`apply-${code}`, { 'a-v1.md': `from ${code}` });
			const targetRoot = targetFor(`apply-${code}-target`);
			const recording = recordingFs({
				linkSync: () => {
					throw errorWithCode(code);
				},
			});
			const result = logic.applyContextCopies({ plan: planFor(root, ['a-v1.md']), targetRoot, fs: recording, pid: 4242, now: NOW });
			assert.deepEqual(result, { copied: 1, errors: [] }, code);
			assert.equal(fs.readFileSync(path.join(targetRoot, 'a-v1.md'), 'utf8'), `from ${code}`);
			assert.deepEqual(listAll(targetRoot), ['a-v1.md']);
			const dst = path.join(targetRoot, 'a-v1.md');
			const tmp = `${dst}.migrate-4242-1.tmp`;
			const order = recording.calls.map(([name, ...args]) => `${name}:${args[0] === tmp || args[0] === dst ? args[0] : ''}`);
			const linked = order.indexOf(`linkSync:${tmp}`);
			const checked = order.indexOf(`lstatSync:${dst}`);
			const renamed = order.indexOf(`renameSync:${tmp}`);
			assert.ok(linked >= 0 && linked < checked && checked < renamed, `${code} order ${order.join(' ')}`);
			assert.deepEqual(recording.calls[renamed].slice(1), [tmp, dst]);
			assert.equal(recording.calls.some(([name]) => name === 'unlinkSync'), false, code);
		}
	});

	it('applyContextCopies: the rename fallback does not overwrite a file that appeared after the link failed', () => {
		const root = sourceRoot('apply-exdev-race', { 'a-v1.md': 'ours' });
		const targetRoot = targetFor('apply-exdev-race-target');
		const dst = path.join(targetRoot, 'a-v1.md');
		const recording = recordingFs({
			linkSync: () => {
				put(dst, 'theirs');
				throw errorWithCode('EXDEV');
			},
		});
		const result = logic.applyContextCopies({ plan: planFor(root, ['a-v1.md']), targetRoot, fs: recording, pid: 4242, now: NOW });
		assert.deepEqual(result, { copied: 0, errors: [{ rel: 'a-v1.md', code: 'EEXIST' }] });
		assert.equal(fs.readFileSync(dst, 'utf8'), 'theirs');
		assert.deepEqual(listAll(targetRoot), ['a-v1.md']);
		assert.equal(recording.calls.some(([name]) => name === 'renameSync'), false);
	});

	it('applyContextCopies: a temp file that cannot be removed after an error does not hide the first error', () => {
		const root = sourceRoot('apply-cleanup-fails', { 'a-v1.md': 'a' });
		const targetRoot = targetFor('apply-cleanup-fails-target');
		const recording = recordingFs({
			linkSync: () => {
				throw errorWithCode('EMLINK');
			},
			unlinkSync: () => {
				throw errorWithCode('EACCES');
			},
		});
		assert.deepEqual(logic.applyContextCopies({ plan: planFor(root, ['a-v1.md']), targetRoot, fs: recording, pid: 4242, now: NOW }), { copied: 0, errors: [{ rel: 'a-v1.md', code: 'EMLINK' }] });
	});

	it('applyContextCopies: a temp file that already exists is left alone when the copy reports EEXIST', () => {
		const root = sourceRoot('apply-tmp-exists', { 'a-v1.md': 'a' });
		const targetRoot = targetFor('apply-tmp-exists-target');
		const recording = recordingFs({
			copyFileSync: () => {
				throw errorWithCode('EEXIST');
			},
		});
		const result = logic.applyContextCopies({ plan: planFor(root, ['a-v1.md']), targetRoot, fs: recording, pid: 4242, now: NOW });
		assert.deepEqual(result, { copied: 0, errors: [{ rel: 'a-v1.md', code: 'EEXIST' }] });
		assert.equal(recording.calls.some(([name]) => name === 'unlinkSync'), false);
	});

	it('applyContextCopies: a failing check of the target in the rename fallback is recorded with its code and removes the temp file', () => {
		const root = sourceRoot('apply-exdev-check', { 'a-v1.md': 'ours', 'b-v1.md': 'next' });
		const targetRoot = targetFor('apply-exdev-check-target');
		const first = path.join(targetRoot, 'a-v1.md');
		const recording = recordingFs({
			linkSync: ([tmp, dst], real) => {
				if (dst === first) throw errorWithCode('EXDEV');
				return real();
			},
			lstatSync: ([file], real) => {
				if (file === first) throw errorWithCode('EACCES');
				return real();
			},
		});
		const result = logic.applyContextCopies({ plan: planFor(root, ['a-v1.md', 'b-v1.md']), targetRoot, fs: recording, pid: 4242, now: NOW });
		assert.deepEqual(result, { copied: 1, errors: [{ rel: 'a-v1.md', code: 'EACCES' }] });
		assert.deepEqual(listAll(targetRoot), ['b-v1.md']);
	});

	it('applyContextCopies: records an error and continues, removes the temp file, and reports only the code', () => {
		const root = sourceRoot('apply-errors', { 'a-v1.md': 'a', 'b-v1.md': 'b', 'c-v1.md': 'c', 'd-v1.md': 'd', 'e-v1.md': 'e' });
		const targetRoot = targetFor('apply-errors-target');
		const failures = {
			'a-v1.md': () => {
				throw errorWithCode('EACCES');
			},
			'c-v1.md': () => {
				throw new Error(`plain failure with ${FAKE.pinecone}`);
			},
		};
		const recording = recordingFs({
			copyFileSync: ([src, tmp], real) => {
				const failing = failures[path.basename(src)];
				if (failing) {
					put(tmp, 'partial');
					failing();
				}
				return real();
			},
			linkSync: ([, dst], real) => {
				if (path.basename(dst) === 'd-v1.md') throw errorWithCode('EMLINK');
				return real();
			},
		});
		const result = logic.applyContextCopies({ plan: planFor(root, ['a-v1.md', 'b-v1.md', 'c-v1.md', 'd-v1.md', 'e-v1.md']), targetRoot, fs: recording, pid: 4242, now: NOW });
		assert.deepEqual(result, {
			copied: 2,
			errors: [
				{ rel: 'a-v1.md', code: 'EACCES' },
				{ rel: 'c-v1.md', code: 'UNKNOWN' },
				{ rel: 'd-v1.md', code: 'EMLINK' },
			],
		});
		assert.deepEqual(listAll(targetRoot), ['b-v1.md', 'e-v1.md']);
		assert.equal(JSON.stringify(result).includes(FAKE.pinecone), false);
	});

	it('applyContextCopies: a failing mkdir, an invalid relative path, and a source that is not a regular file are recorded and nothing is written outside the target', () => {
		const root = sourceRoot('apply-invalid', { 'a-v1.md': 'a', 'file-v1/x.json': 'x', 'ok-v1.md': 'ok' });
		const targetRoot = targetFor('apply-invalid-target');
		put(path.join(targetRoot, 'file-v1'), 'a file where a folder is needed');
		const plan = planFor(root, ['file-v1/x.json', 'ok-v1.md']);
		const outside = path.join(path.dirname(targetRoot), 'escaped.md');
		plan.copies.push(
			{ rel: '../escaped.md', from: 'claude', src: path.join(root, 'a-v1.md') },
			{ rel: '/abs-v1.md', from: 'claude', src: path.join(root, 'a-v1.md') },
			{ rel: 'a//b-v1.md', from: 'claude', src: path.join(root, 'a-v1.md') },
			{ rel: './dot-v1.md', from: 'claude', src: path.join(root, 'a-v1.md') },
			{ rel: 'back\\slash-v1.md', from: 'claude', src: path.join(root, 'a-v1.md') },
			{ rel: '', from: 'claude', src: path.join(root, 'a-v1.md') },
			{ rel: 'dir-src-v1.md', from: 'claude', src: root },
			{ rel: 'nosrc-v1.md', from: 'claude' },
			{ from: 'claude', src: path.join(root, 'a-v1.md') },
			null,
			5,
		);
		const result = logic.applyContextCopies({ plan, targetRoot, pid: 4242, now: NOW });
		assert.equal(result.copied, 1);
		const byRel = Object.fromEntries(result.errors.map((error) => [error.rel, error.code]));
		assert.equal(typeof byRel['file-v1/x.json'], 'string');
		assert.equal(byRel['../escaped.md'], 'EINVAL');
		assert.equal(byRel['/abs-v1.md'], 'EINVAL');
		assert.equal(byRel['a//b-v1.md'], 'EINVAL');
		assert.equal(byRel['./dot-v1.md'], 'EINVAL');
		assert.equal(byRel['back\\slash-v1.md'], 'EINVAL');
		assert.equal(byRel[''], 'EINVAL');
		assert.equal(byRel['dir-src-v1.md'], 'EINVAL');
		assert.equal(byRel['nosrc-v1.md'], 'EINVAL');
		assert.equal(result.errors.length, 12);
		assert.equal(result.errors.filter((error) => error.rel === '' && error.code === 'EINVAL').length, 4);
		assert.equal(fs.existsSync(outside), false);
		assert.deepEqual(listAll(targetRoot), ['file-v1', 'ok-v1.md']);
	});

	it('applyContextCopies: a source that became a symbolic link is not followed', POSIX_ONLY, () => {
		const root = sourceRoot('apply-src-link', { 'real-v1.md': 'real' });
		const outside = path.join(caseDir('apply-src-link-out'), 'secret.md');
		put(outside, 'do not copy');
		fs.symlinkSync(outside, path.join(root, 'swapped-v1.md'));
		const targetRoot = targetFor('apply-src-link-target');
		const result = logic.applyContextCopies({ plan: planFor(root, ['swapped-v1.md', 'real-v1.md']), targetRoot, pid: 4242, now: NOW });
		assert.deepEqual(result, { copied: 1, errors: [{ rel: 'swapped-v1.md', code: 'EINVAL' }] });
		assert.deepEqual(listAll(targetRoot), ['real-v1.md']);
	});

	it('applyContextCopies: sweeps its own and stale temp files but keeps a fresh temp file of another pid', () => {
		const targetRoot = targetFor('apply-sweep');
		const at = (name, ageMs, text = 'temp') => {
			const file = path.join(targetRoot, ...name.split('/'));
			put(file, text);
			const when = new Date(NOW - ageMs);
			fs.utimesSync(file, when, when);
			return file;
		};
		const ownFresh = at('own-fresh-v1.md.migrate-4242-1.tmp', 1000);
		const ownOld = at('deep/own-old-v1.md.migrate-4242-9.tmp', 30 * 60 * 1000);
		const staleOther = at('a-v1/reviews/stale-v1.md.migrate-9999-3.tmp', 11 * 60 * 1000);
		const freshOther = at('fresh-v1.md.migrate-9999-2.tmp', 9 * 60 * 1000);
		const freshOtherDeep = at('deep/fresh-v1.md.migrate-7-1.tmp', 1000);
		const realFile = at('keep-v1.md', 60 * DAY, 'real note');
		const similar = [
			at('old-v1.md.migrate-9999.tmp', 60 * DAY),
			at('old-v1.md.migrate-x-1.tmp', 60 * DAY),
			at('old-v1.md.migrate-9999-1.tmp.bak', 60 * DAY),
			at('old-v1.md.tmp', 60 * DAY),
			at('old-v1.md.migrate-9999-1', 60 * DAY),
			at('old-v1.mdmigrate-9999-1.tmp', 60 * DAY),
		];
		const result = logic.applyContextCopies({ plan: { copies: [] }, targetRoot, pid: 4242, now: NOW });
		assert.deepEqual(result, { copied: 0, errors: [] });
		for (const gone of [ownFresh, ownOld, staleOther]) assert.equal(fs.existsSync(gone), false, gone);
		for (const kept of [freshOther, freshOtherDeep, realFile, ...similar]) assert.equal(fs.existsSync(kept), true, kept);
		assert.equal(fs.readFileSync(realFile, 'utf8'), 'real note');
	});

	it('applyContextCopies: the sweep never follows a symbolic link and never removes a link or a folder that has a temp name', POSIX_ONLY, () => {
		const targetRoot = targetFor('apply-sweep-links');
		const outside = caseDir('apply-sweep-out');
		put(path.join(outside, 'x-v1.md.migrate-4242-1.tmp'), 'outside temp');
		fs.mkdirSync(targetRoot, { recursive: true });
		fs.symlinkSync(outside, path.join(targetRoot, 'linked-dir'));
		fs.symlinkSync(path.join(outside, 'x-v1.md.migrate-4242-1.tmp'), path.join(targetRoot, 'y-v1.md.migrate-4242-2.tmp'));
		fs.mkdirSync(path.join(targetRoot, 'dir-v1.md.migrate-4242-3.tmp'));
		put(path.join(targetRoot, 'dir-v1.md.migrate-4242-3.tmp', 'inner-v1.md.migrate-4242-4.tmp'), 'inner');
		logic.applyContextCopies({ plan: { copies: [] }, targetRoot, pid: 4242, now: NOW });
		assert.equal(fs.readFileSync(path.join(outside, 'x-v1.md.migrate-4242-1.tmp'), 'utf8'), 'outside temp');
		assert.equal(fs.lstatSync(path.join(targetRoot, 'y-v1.md.migrate-4242-2.tmp')).isSymbolicLink(), true);
		assert.equal(fs.existsSync(path.join(targetRoot, 'dir-v1.md.migrate-4242-3.tmp')), true);
		assert.equal(fs.existsSync(path.join(targetRoot, 'dir-v1.md.migrate-4242-3.tmp', 'inner-v1.md.migrate-4242-4.tmp')), false);
	});

	it('applyContextCopies: a missing target root with nothing to copy stays missing, and a failing sweep does not stop the copies', () => {
		const missing = path.join(caseDir('apply-nothing'), 'nowhere', 'contexts');
		assert.deepEqual(logic.applyContextCopies({ plan: { copies: [] }, targetRoot: missing }), { copied: 0, errors: [] });
		assert.deepEqual(logic.applyContextCopies({ targetRoot: missing }), { copied: 0, errors: [] });
		assert.equal(fs.existsSync(path.dirname(missing)), false);

		const root = sourceRoot('apply-sweep-fail', { 'a-v1.md': 'a' });
		const targetRoot = targetFor('apply-sweep-fail-target');
		put(path.join(targetRoot, 'x-v1.md.migrate-4242-5.tmp'), 'temp');
		put(path.join(targetRoot, 'sub', 'y-v1.md.migrate-4242-6.tmp'), 'temp');
		const stubborn = recordingFs({
			unlinkSync: ([file], real) => {
				if (file.includes('.migrate-4242-5.tmp')) throw errorWithCode('EACCES');
				return real();
			},
			readdirSync: ([dir], real) => {
				if (dir === path.join(targetRoot, 'sub')) throw errorWithCode('EACCES');
				return real();
			},
		});
		const result = logic.applyContextCopies({ plan: planFor(root, ['a-v1.md']), targetRoot, fs: stubborn, pid: 4242, now: NOW });
		assert.deepEqual(result, { copied: 1, errors: [] });
		assert.equal(fs.existsSync(path.join(targetRoot, 'a-v1.md')), true);
	});

	it('applyContextCopies: now may be a function, and the defaults are this process and the clock', () => {
		const root = sourceRoot('apply-defaults', { 'a-v1.md': 'a' });
		const targetRoot = targetFor('apply-defaults-target');
		const stale = path.join(targetRoot, 'x-v1.md.migrate-9999-1.tmp');
		put(stale, 'temp');
		const when = new Date(NOW - 11 * 60 * 1000);
		fs.utimesSync(stale, when, when);
		assert.deepEqual(logic.applyContextCopies({ plan: { copies: [] }, targetRoot, now: () => NOW }), { copied: 0, errors: [] });
		assert.equal(fs.existsSync(stale), false);

		const own = path.join(targetRoot, `y-v1.md.migrate-${process.pid}-1.tmp`);
		put(own, 'temp');
		assert.deepEqual(logic.applyContextCopies({ plan: planFor(root, ['a-v1.md']), targetRoot }), { copied: 1, errors: [] });
		assert.equal(fs.existsSync(own), false);
		assert.deepEqual(listAll(targetRoot), ['a-v1.md']);
	});

	it('applyContextCopies: a TypeError without targetRoot, and with one that is empty or not a string', () => inTempCwd('apply-no-root', () => {
		for (const value of [undefined, '', null, 5, {}]) {
			assert.throws(() => logic.applyContextCopies({ plan: { copies: [] }, targetRoot: value }), { name: 'TypeError', message: 'applyContextCopies needs targetRoot' });
		}
		assert.throws(() => logic.applyContextCopies(), { name: 'TypeError', message: 'applyContextCopies needs targetRoot' });
		assert.deepEqual(fs.readdirSync(process.cwd()), []);
	}));
});

describe('verifyInstall', () => {
	const INSTALL = path.join(path.sep, 'cache', 'make-custom-app', 'make-custom-app', '3.0.0');
	const MANIFEST = path.join(INSTALL, '.claude-plugin', 'plugin.json');
	const SKILL = path.join(INSTALL, 'skills', 'make-app-setup', 'SKILL.md');
	const SERVER = path.join(INSTALL, 'mcp', 'index.mjs');
	const usable = (extra = {}) => ({ status: 'usable', reason: null, id: ID, installPath: INSTALL, version: '3.0.0', ...extra });
	const manifest = (extra = {}) => JSON.stringify({ name: 'make-custom-app', version: '3.0.0', ...extra });
	const present = () => true;

	it('verifyInstall: each problem', () => {
		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: manifest(), exists: present }), []);
		assert.deepEqual(logic.verifyInstall({ status: usable({ status: 'inactive', reason: 'disabled' }), manifestText: manifest(), exists: present }), []);
		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: `\uFEFF${manifest()}`, exists: present }), []);
		assert.deepEqual(logic.verifyInstall({ status: usable({ version: '3.1.0' }), manifestText: manifest({ version: '3.1.0' }), exists: present }), []);
		assert.deepEqual(logic.verifyInstall({ status: usable({ version: '10.0.0' }), manifestText: manifest({ version: '10.0.0' }), exists: present }), []);

		const asked = [];
		const checks = (extra) => logic.verifyInstall({ status: usable(), manifestText: manifest(), exists: (file) => (asked.push(file), true), ...extra });
		checks();
		assert.deepEqual(asked, [SKILL, SERVER]);

		assert.deepEqual(logic.verifyInstall({ status: { status: 'absent', reason: 'cache-missing', id: null, installPath: null, version: null }, manifestText: manifest(), exists: present }), ['claude did not record the plugin as installed (cache-missing)']);
		assert.deepEqual(logic.verifyInstall({ status: { status: 'absent', reason: null }, manifestText: manifest(), exists: present }), ['claude did not record the plugin as installed']);
		assert.deepEqual(logic.verifyInstall({ status: { status: 'absent', reason: 'bad reason\nwith text' }, manifestText: manifest(), exists: present }), ['claude did not record the plugin as installed']);
		assert.deepEqual(logic.verifyInstall({ status: usable({ installPath: null }), manifestText: manifest(), exists: present }), ['the install path of the plugin is not recorded']);
		for (const status of [null, 'usable', 5, [], {}]) {
			assert.deepEqual(logic.verifyInstall({ status, manifestText: manifest(), exists: present }), ['claude did not record the plugin as installed'], String(status));
		}

		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: '{ not json', exists: present }), [`${MANIFEST} is not valid JSON`]);
		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: '', exists: present }), [`${MANIFEST} is not valid JSON`]);
		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: '[1]', exists: present }), [`${MANIFEST} does not hold a JSON object`]);
		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: 'null', exists: present }), [`${MANIFEST} does not hold a JSON object`]);
		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: null, exists: present }), [`${MANIFEST} could not be read`]);
		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: undefined, exists: present }), [`${MANIFEST} could not be read`]);

		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: manifest({ name: 'other-plugin' }), exists: present }), [`the name in ${MANIFEST} is not make-custom-app`]);
		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: JSON.stringify({ version: '3.0.0' }), exists: present }), [`the name in ${MANIFEST} is not make-custom-app`]);

		assert.deepEqual(logic.verifyInstall({ status: usable({ version: '2.9.9' }), manifestText: manifest({ version: '2.9.9' }), exists: present }), [`the version in ${MANIFEST} (2.9.9) is below 3.0.0`]);
		assert.deepEqual(logic.verifyInstall({ status: usable({ version: '2.99.99' }), manifestText: manifest({ version: '2.99.99' }), exists: present }), [`the version in ${MANIFEST} (2.99.99) is below 3.0.0`]);
		assert.deepEqual(logic.verifyInstall({ status: usable({ version: null }), manifestText: manifest({ version: '2.4.0-beta.1' }), exists: present }), [`the version in ${MANIFEST} (2.4.0) is below 3.0.0`]);
		for (const version of ['3.0', 'latest', 3, null, '', '3.0.x']) {
			assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: manifest({ version }), exists: present }), [`the version in ${MANIFEST} is missing or not a version number`], String(version));
		}
		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: JSON.stringify({ name: 'make-custom-app' }), exists: present }), [`the version in ${MANIFEST} is missing or not a version number`]);

		assert.deepEqual(logic.verifyInstall({ status: usable({ version: '3.0.1' }), manifestText: manifest({ version: '3.0.0' }), exists: present }), [`the version in ${MANIFEST} differs from the version recorded for the install`]);
		assert.deepEqual(logic.verifyInstall({ status: usable({ version: null }), manifestText: manifest({ version: '3.0.0' }), exists: present }), []);

		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: manifest(), exists: (file) => file !== SKILL }), [`${SKILL} is missing`]);
		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: manifest(), exists: (file) => file !== SERVER }), [`${SERVER} is missing`]);
		assert.deepEqual(logic.verifyInstall({ status: usable(), manifestText: manifest(), exists: () => false }), [`${SKILL} is missing`, `${SERVER} is missing`]);
	});

	it('verifyInstall: reports every problem at once, in a fixed order, and never quotes the manifest', () => {
		const text = JSON.stringify({ name: FAKE.other, version: FAKE.pinecone });
		const problems = logic.verifyInstall({ status: usable({ version: '3.0.1' }), manifestText: text, exists: () => false });
		assert.deepEqual(problems, [`the name in ${MANIFEST} is not make-custom-app`, `the version in ${MANIFEST} is missing or not a version number`, `${SKILL} is missing`, `${SERVER} is missing`]);
		const broken = logic.verifyInstall({ status: usable(), manifestText: `{"name": "${FAKE.other}", "version": ${FAKE.pinecone}}`, exists: present });
		assert.deepEqual(broken, [`${MANIFEST} is not valid JSON`]);
		for (const problem of [...problems, ...broken]) for (const seed of Object.values(FAKE)) assert.equal(problem.includes(seed), false);
		assert.deepEqual(logic.verifyInstall({ status: usable({ version: '3.0.1' }), manifestText: manifest({ version: '2.0.0' }), exists: present }), [
			`the version in ${MANIFEST} (2.0.0) is below 3.0.0`,
			`the version in ${MANIFEST} differs from the version recorded for the install`,
		]);
	});

	it('verifyInstall: a TypeError without status or exists', () => {
		assert.throws(() => logic.verifyInstall(), { name: 'TypeError', message: 'verifyInstall needs status and exists' });
		assert.throws(() => logic.verifyInstall({ manifestText: '{}', exists: present }), { name: 'TypeError', message: 'verifyInstall needs status and exists' });
		assert.throws(() => logic.verifyInstall({ status: usable(), manifestText: '{}' }), { name: 'TypeError', message: 'verifyInstall needs status and exists' });
	});
});

describe('nextLines, summaryLines, and jsonReport', () => {
	const MAKE_DIR = '~/.make-custom-app';
	const LOCK = `${MAKE_DIR}/cleanup.lock`;
	const NEXT_CLAUDE = 'Next: restart Claude Code, then run /make-custom-app:make-app-setup (or start any Make task). It lists the old install and removes it after you confirm.';
	const NEXT_CURSOR = 'Next: turn on the Cursor setting Include Third-Party Plugins (Cursor loads the plugin installed for Claude Code), restart Cursor, then run /make-app-setup (or start any Make task). It lists the old install and removes it after you confirm.';
	const NEXT_HANDOFF = 'Next: continue with the make-app-setup skill of the plugin; it lists the old install and removes it after you confirm.';
	const NOTHING_DELETED = 'Nothing was deleted. The old skill keeps working until the cleanup.';
	const DISABLED = 'The plugin is installed but disabled; this script does not enable it. To use it, run in your own terminal: claude plugin enable make-custom-app@make-custom-app';
	const ADDRESS = 'https://github.com/minsu-kang/make-custom-app-skill.git';

	function baseReport(over = {}) {
		return {
			ok: true,
			exitCode: 0,
			editor: 'claude',
			dryRun: false,
			claude: { bin: '/usr/local/bin/claude', version: '2.1.312 (Claude Code)' },
			marketplace: { action: 'added', source: ADDRESS },
			plugin: { action: 'installed', version: '3.0.0', problems: [] },
			lock: { held: false, pid: null },
			secrets: { copied: [], keptExisting: [], conflicts: [], skipped: [], error: null },
			contexts: { copied: 0, alreadyPresent: 0, keptExisting: [], orgSkipped: [], duplicates: [], symlinks: [], errors: [] },
			next: [],
			...over,
		};
	}

	const SCHEMA_KEYS = ['ok', 'exitCode', 'editor', 'dryRun', 'claude', 'marketplace', 'plugin', 'lock', 'secrets', 'contexts', 'next'];

	it('nextLines: the exact lines for each editor, installed now or not', () => {
		assert.deepEqual(logic.nextLines('claude', true), [NEXT_CLAUDE]);
		assert.deepEqual(logic.nextLines('cursor', true), [NEXT_CURSOR]);
		assert.deepEqual(logic.nextLines('claude', false), [NEXT_HANDOFF]);
		assert.deepEqual(logic.nextLines('cursor', false), [NEXT_HANDOFF]);
		for (const editor of [undefined, 'vscode', '', null]) {
			assert.throws(() => logic.nextLines(editor, true), { name: 'TypeError', message: 'nextLines needs the editor claude or cursor' }, String(editor));
			assert.throws(() => logic.nextLines(editor, false), { name: 'TypeError', message: 'nextLines needs the editor claude or cursor' }, String(editor));
		}
	});

	it('summaryLines and jsonReport: the exact lines', () => {
		const full = baseReport({
			marketplace: { action: 'present', source: '/Users/x/make-custom-app-skill' },
			secrets: {
				copied: ['pinecone-api-key', 'openai-api-key'],
				keptExisting: ['pinecone-index-name'],
				conflicts: [
					{ key: 'openai-api-key', used: 'claude-registration', others: ['cursor-env'] },
					{ key: 'pinecone-api-key', used: 'secrets-file', others: ['claude-env', 'cursor-registration:make-app-context'] },
					{ key: 'pinecone-index-name', used: 'claude-env', others: ['cursor-registration:a', 'cursor-env'] },
				],
				skipped: [{ key: 'x', reason: 'placeholder' }],
				error: null,
			},
			contexts: {
				copied: 12,
				alreadyPresent: 3,
				keptExisting: ['y-v1.md', 'z-v1/reviews/latest.json'],
				orgSkipped: ['hubspot-v2/'],
				duplicates: [{ rel: 'hubspot-v2.md', used: 'claude' }, { rel: 'x-v1.md', used: 'cursor' }],
				symlinks: ['link-v1.md'],
				errors: [{ rel: 'q-v1.md', code: 'EACCES' }],
			},
		});
		assert.deepEqual(logic.summaryLines(full), [
			'Plugin make-custom-app@make-custom-app: installed, version 3.0.0',
			'Marketplace make-custom-app was already there (/Users/x/make-custom-app-skill); it was kept.',
			'MCP keys copied to ~/.make-custom-app-skill-secrets: pinecone-api-key, openai-api-key',
			'MCP keys kept (the secrets file already had a value): pinecone-index-name',
			'MCP keys with different values in the old install (the first source was used): openai-api-key (claude-registration; also cursor-env)',
			'MCP keys with different values in the old install (the first source was used): pinecone-index-name (claude-env; also cursor-registration:a, cursor-env)',
			'MCP keys that differ from the old install (the value in the secrets file is used, so the plugin uses another value than the old registration): pinecone-api-key (claude-env, cursor-registration:make-app-context)',
			'App contexts copied to ~/.make-custom-app/contexts: 12 files; 7 notes below',
			'  skipped hubspot-v2/ (written by the org downloader; its data can be partial)',
			'  both editors had hubspot-v2.md: used the Claude Code copy (newer)',
			'  both editors had x-v1.md: used the Cursor copy (newer)',
			'  kept y-v1.md (the target already has a different file)',
			'  kept z-v1/reviews/latest.json (the target already has a different file)',
			'  skipped link-v1.md (a symbolic link)',
			'  failed q-v1.md (EACCES)',
			NOTHING_DELETED,
			NEXT_CLAUDE,
		]);
	});

	it('summaryLines: the plain installed report has the plugin line, the contexts line, nothing deleted, and the next line', () => {
		assert.deepEqual(logic.summaryLines(baseReport({ secrets: { copied: ['openai-api-key'], keptExisting: [], conflicts: [], skipped: [], error: null }, contexts: { ...baseReport().contexts, copied: 1 } })), [
			'Plugin make-custom-app@make-custom-app: installed, version 3.0.0',
			'MCP keys copied to ~/.make-custom-app-skill-secrets: openai-api-key',
			'App contexts copied to ~/.make-custom-app/contexts: 1 files',
			NOTHING_DELETED,
			NEXT_CLAUDE,
		]);
		assert.deepEqual(logic.summaryLines(baseReport({ editor: 'cursor' })), [
			'Plugin make-custom-app@make-custom-app: installed, version 3.0.0',
			'MCP keys: none found in the old install',
			'App contexts copied to ~/.make-custom-app/contexts: 0 files',
			NOTHING_DELETED,
			NEXT_CURSOR,
		]);
	});

	it('summaryLines: the plugin line for an already installed plugin (the handoff path) and a disabled one', () => {
		assert.deepEqual(logic.summaryLines(baseReport({ plugin: { action: 'present', version: '3.0.0', problems: [] }, marketplace: { action: 'skipped', source: null } })), [
			'Plugin make-custom-app@make-custom-app: already installed, version 3.0.0',
			'MCP keys: none found in the old install',
			'App contexts copied to ~/.make-custom-app/contexts: 0 files',
			NOTHING_DELETED,
			NEXT_HANDOFF,
		]);
		assert.deepEqual(logic.summaryLines(baseReport({ editor: 'cursor', plugin: { action: 'present', version: '3.0.1', problems: [] } })).slice(-1), [NEXT_HANDOFF]);
		assert.deepEqual(logic.summaryLines(baseReport({ plugin: { action: 'disabled', version: '3.0.0', problems: [] }, marketplace: { action: 'skipped', source: null } })), [
			'Plugin make-custom-app@make-custom-app: installed but disabled, version 3.0.0',
			'MCP keys: none found in the old install',
			'App contexts copied to ~/.make-custom-app/contexts: 0 files',
			NOTHING_DELETED,
			DISABLED,
		]);
		assert.deepEqual(logic.summaryLines(baseReport({ plugin: { action: 'installed', version: null, problems: [] } }))[0], 'Plugin make-custom-app@make-custom-app: installed');
		assert.deepEqual(logic.summaryLines(baseReport({ plugin: { action: 'present', version: 'bad\nversion', problems: [] } }))[0], 'Plugin make-custom-app@make-custom-app: already installed');
	});

	it('summaryLines: a failed or skipped plugin prints no plugin, key, context, deletion, or next line', () => {
		for (const action of ['failed', 'skipped']) {
			assert.deepEqual(logic.summaryLines(baseReport({ plugin: { action, version: null, problems: ['x'] }, marketplace: { action: 'failed', source: null } })), [], action);
		}
		assert.deepEqual(logic.summaryLines(baseReport({ plugin: { action: 'failed', version: null, problems: [] }, marketplace: { action: 'present', source: ADDRESS } })), [`Marketplace make-custom-app was already there (${ADDRESS}); it was kept.`]);
	});

	it('summaryLines: the lock line with a pid, and without a pid with the delete hint; no keys or contexts lines then', () => {
		const held = (pid) => baseReport({ lock: { held: true, pid }, exitCode: 4, ok: false });
		assert.deepEqual(logic.summaryLines(held(4242)), [
			'Plugin make-custom-app@make-custom-app: installed, version 3.0.0',
			`Another migration or cleanup is running (lock ${LOCK}, pid 4242). Nothing was copied; run this script again.`,
			NOTHING_DELETED,
			NEXT_CLAUDE,
		]);
		assert.deepEqual(logic.summaryLines(held(null)), [
			'Plugin make-custom-app@make-custom-app: installed, version 3.0.0',
			`Another migration or cleanup is running (lock ${LOCK}). Nothing was copied; run this script again. If no other run is active, delete ${LOCK} and ${LOCK}.takeover, then run it again.`,
			NOTHING_DELETED,
			NEXT_CLAUDE,
		]);
		for (const pid of [0, -1, 1.5, '4242', NaN, undefined]) {
			assert.equal(logic.summaryLines(held(pid))[1].startsWith(`Another migration or cleanup is running (lock ${LOCK}). Nothing was copied;`), true, String(pid));
		}
		const noLock = logic.summaryLines(baseReport({ lock: { held: false, pid: 4242 } }));
		assert.equal(noLock.some((line) => line.startsWith('Another migration')), false);
	});

	it('summaryLines: a present marketplace shows its address, its kind only without an address, and no parentheses without a value', () => {
		const markets = [
			['https://example.test/marketplace.git', ' (https://example.test/marketplace.git)'],
			['/Users/x/folder', ' (/Users/x/folder)'],
			['git', ' (git)'],
			[null, ''],
			['', ''],
			[undefined, ''],
			[5, ''],
			['line\nbreak', ''],
		];
		for (const [source, shown] of markets) {
			assert.equal(logic.summaryLines(baseReport({ marketplace: { action: 'present', source } }))[1], `Marketplace make-custom-app was already there${shown}; it was kept.`, String(source));
		}
		const parsed = logic.parseMarketplaceList(JSON.stringify([{ name: 'make-custom-app', source: 'git', url: ADDRESS, installLocation: '/x' }, { name: 'make-custom-app', source: 'directory', path: '/Users/x/folder' }, { name: 'make-custom-app', source: 'git' }]));
		assert.deepEqual(parsed.map((entry) => entry.source), [ADDRESS, '/Users/x/folder', 'git']);
		for (const entry of parsed) assert.equal(logic.summaryLines(baseReport({ marketplace: { action: 'present', source: entry.source } }))[1], `Marketplace make-custom-app was already there (${entry.source}); it was kept.`);
		for (const action of ['added', 'skipped', 'failed']) {
			assert.equal(logic.summaryLines(baseReport({ marketplace: { action, source: ADDRESS } })).some((line) => line.startsWith('Marketplace')), false, action);
		}
	});

	it('summaryLines and jsonReport: an address with a user name or a token in front of the host is shown without it', () => {
		const url = 'https://someone:fake-other-token-1111@github.com/minsu-kang/make-custom-app-skill.git';
		const report = baseReport({ marketplace: { action: 'present', source: url } });
		assert.equal(logic.summaryLines(report)[1], 'Marketplace make-custom-app was already there (https://github.com/minsu-kang/make-custom-app-skill.git); it was kept.');
		assert.equal(logic.jsonReport(report).marketplace.source, 'https://github.com/minsu-kang/make-custom-app-skill.git');
		assert.equal(logic.jsonReport(baseReport({ marketplace: { action: 'present', source: 'git@github.com:minsu-kang/x.git' } })).marketplace.source, 'git@github.com:minsu-kang/x.git');
	});

	it('summaryLines: the none-found line, a keys-error line instead of it, and no line for skipped keys', () => {
		const withSecrets = (secrets) => logic.summaryLines(baseReport({ secrets: { copied: [], keptExisting: [], conflicts: [], skipped: [], error: null, ...secrets } }));
		assert.equal(withSecrets({})[1], 'MCP keys: none found in the old install');
		assert.equal(withSecrets({ skipped: [{ key: 'openai-api-key', reason: 'placeholder' }] })[1], 'MCP keys: none found in the old install');
		assert.equal(withSecrets({ keptExisting: ['openai-api-key'] })[1], 'MCP keys kept (the secrets file already had a value): openai-api-key');
		assert.equal(withSecrets({ conflicts: [{ key: 'openai-api-key', used: 'secrets-file', others: ['claude-env'] }] })[1].startsWith('MCP keys that differ from the old install'), true);
		const failed = withSecrets({ error: '/h/.claude.json is not valid JSON' });
		assert.deepEqual(failed.slice(1, 2), ['MCP keys: not copied completely (/h/.claude.json is not valid JSON)']);
		assert.equal(failed.some((line) => line.includes('none found')), false);
		const partial = withSecrets({ copied: ['openai-api-key'], error: 'read-back mismatch: openai-api-key' });
		assert.deepEqual(partial.slice(1, 3), ['MCP keys copied to ~/.make-custom-app-skill-secrets: openai-api-key', 'MCP keys: not copied completely (read-back mismatch: openai-api-key)']);
	});

	it('summaryLines: the contexts line counts its notes, and a line with no notes has no note count', () => {
		const withContexts = (contexts) => logic.summaryLines(baseReport({ contexts: { ...baseReport().contexts, ...contexts } }));
		assert.equal(withContexts({ copied: 4 })[1], 'MCP keys: none found in the old install');
		assert.equal(withContexts({ copied: 4 })[2], 'App contexts copied to ~/.make-custom-app/contexts: 4 files');
		assert.deepEqual(withContexts({ copied: 2, orgSkipped: ['a-v1/'] }).slice(2, 4), ['App contexts copied to ~/.make-custom-app/contexts: 2 files; 1 notes below', '  skipped a-v1/ (written by the org downloader; its data can be partial)']);
		assert.equal(withContexts({ copied: 2, orgSkipped: ['a-v1'] })[3], '  skipped a-v1/ (written by the org downloader; its data can be partial)');
		assert.equal(withContexts({ alreadyPresent: 9 })[2], 'App contexts copied to ~/.make-custom-app/contexts: 0 files');
		const noisy = withContexts({ symlinks: ['bad\nname-v1.md'], errors: [{ rel: 'bad\u2028x-v1.md', code: 'EACCES' }], keptExisting: ['tab\tname-v1.md'] });
		assert.deepEqual(noisy.slice(3, 6), ['  kept tab?name-v1.md (the target already has a different file)', '  skipped bad?name-v1.md (a symbolic link)', '  failed bad?x-v1.md (EACCES)']);
	});

	it('jsonReport: exactly the schema keys, with copies of the given values and defaults for missing parts', () => {
		const report = baseReport({
			exitCode: 4,
			ok: false,
			editor: 'cursor',
			dryRun: true,
			claude: { bin: null, version: null },
			marketplace: { action: 'present', source: null },
			plugin: { action: 'present', version: '3.0.0', problems: ['a problem'] },
			lock: { held: true, pid: 4242 },
			secrets: {
				copied: ['openai-api-key'],
				keptExisting: ['pinecone-api-key'],
				conflicts: [{ key: 'pinecone-api-key', used: 'secrets-file', others: ['claude-env'] }],
				skipped: [{ key: 'pinecone-index-name', reason: 'reference' }],
				error: 'read-back mismatch: openai-api-key',
			},
			contexts: {
				copied: 2,
				alreadyPresent: 1,
				keptExisting: ['k-v1.md'],
				orgSkipped: ['o-v1/'],
				duplicates: [{ rel: 'd-v1.md', used: 'cursor' }],
				symlinks: ['s-v1.md'],
				errors: [{ rel: 'e-v1.md', code: 'EACCES' }],
			},
		});
		const out = logic.jsonReport(report);
		assert.deepEqual(Object.keys(out), SCHEMA_KEYS);
		assert.deepEqual(Object.keys(out.claude), ['bin', 'version']);
		assert.deepEqual(Object.keys(out.marketplace), ['action', 'source']);
		assert.deepEqual(Object.keys(out.plugin), ['action', 'version', 'problems']);
		assert.deepEqual(Object.keys(out.lock), ['held', 'pid']);
		assert.deepEqual(Object.keys(out.secrets), ['copied', 'keptExisting', 'conflicts', 'skipped', 'error']);
		assert.deepEqual(Object.keys(out.contexts), ['copied', 'alreadyPresent', 'keptExisting', 'orgSkipped', 'duplicates', 'symlinks', 'errors']);
		assert.deepEqual(out, { ...report, next: [NEXT_HANDOFF] });
		assert.notEqual(out.secrets.copied, report.secrets.copied);
		assert.notEqual(out.contexts.errors[0], report.contexts.errors[0]);
		assert.doesNotThrow(() => JSON.stringify(out));

		const bare = logic.jsonReport({ editor: 'claude' });
		assert.deepEqual(bare, {
			ok: false,
			exitCode: 1,
			editor: 'claude',
			dryRun: false,
			claude: { bin: null, version: null },
			marketplace: { action: 'skipped', source: null },
			plugin: { action: 'skipped', version: null, problems: [] },
			lock: { held: false, pid: null },
			secrets: { copied: [], keptExisting: [], conflicts: [], skipped: [], error: null },
			contexts: { copied: 0, alreadyPresent: 0, keptExisting: [], orgSkipped: [], duplicates: [], symlinks: [], errors: [] },
			next: [],
		});
		assert.throws(() => logic.jsonReport({}), { name: 'TypeError', message: 'jsonReport needs the editor claude or cursor' });
		assert.throws(() => logic.jsonReport(), { name: 'TypeError', message: 'jsonReport needs the editor claude or cursor' });
		assert.throws(() => logic.summaryLines({ editor: 'other' }), { name: 'TypeError', message: 'summaryLines needs the editor claude or cursor' });
	});

	it('jsonReport: the next lines follow the editor and the plugin action, and the given next is not used', () => {
		const next = (editor, action) => logic.jsonReport(baseReport({ editor, plugin: { action, version: '3.0.0', problems: [] }, next: ['something else'] })).next;
		assert.deepEqual(next('claude', 'installed'), [NEXT_CLAUDE]);
		assert.deepEqual(next('cursor', 'installed'), [NEXT_CURSOR]);
		assert.deepEqual(next('claude', 'present'), [NEXT_HANDOFF]);
		assert.deepEqual(next('cursor', 'present'), [NEXT_HANDOFF]);
		for (const action of ['disabled', 'failed', 'skipped']) assert.deepEqual(next('claude', action), [], action);
	});

	it('jsonReport: wrong types are replaced by the defaults, and unknown keys are dropped', () => {
		const out = logic.jsonReport({
			ok: 'yes',
			exitCode: 'x',
			editor: 'claude',
			dryRun: 1,
			extra: 'dropped',
			claude: { bin: 5, version: 'a\nb', extra: 'dropped' },
			marketplace: { action: 'present', source: ['x'] },
			plugin: { action: 'present', version: 5, problems: ['one', 2, null] },
			lock: { held: 'yes', pid: '4242' },
			secrets: { copied: 'openai-api-key', keptExisting: [1, 'a'], conflicts: [null, 'x', { key: 5, used: 'u' }, { key: 'k', used: 5 }, { key: 'k', used: 'u', others: 'o', extra: 1 }], skipped: [{ key: 'k', reason: 'placeholder', extra: 1 }, 5, { key: 'k' }, { reason: 'x' }], error: 5 },
			contexts: { copied: 'many', alreadyPresent: -1, keptExisting: 'x', orgSkipped: [5], duplicates: [{ rel: 5, used: 'claude' }, { rel: 'r', used: 'other' }, { rel: 'r', used: 'claude', extra: 1 }], symlinks: null, errors: [{ rel: 5, code: 'EIO' }, { rel: 'r', code: 5 }, { rel: 'r', code: 'EIO', message: 'dropped' }] },
		});
		assert.deepEqual(out, {
			ok: false,
			exitCode: 1,
			editor: 'claude',
			dryRun: false,
			claude: { bin: null, version: null },
			marketplace: { action: 'present', source: null },
			plugin: { action: 'present', version: null, problems: ['one'] },
			lock: { held: false, pid: null },
			secrets: { copied: [], keptExisting: ['a'], conflicts: [{ key: 'k', used: 'u', others: [] }], skipped: [{ key: 'k', reason: 'placeholder' }], error: null },
			contexts: { copied: 0, alreadyPresent: 0, keptExisting: [], orgSkipped: [], duplicates: [{ rel: 'r', used: 'claude' }], symlinks: [], errors: [{ rel: 'r', code: 'EIO' }] },
			next: [NEXT_HANDOFF],
		});
	});

	it('summaryLines and jsonReport: seeded secret values and a seeded parse-error text never appear', () => {
		const home = caseDir('report-seeds');
		const badJson = `{"mcpServers": {"make-custom-app": {"env": {"OPENAI_API_KEY": "${FAKE.openai}", "PINECONE_API_KEY": "${FAKE.pinecone}" oops}}}}`;
		const parseMessage = (() => {
			try {
				JSON.parse(badJson);
			} catch (err) {
				return err.message;
			}
			return '';
		})();
		put(path.join(home, '.claude.json'), badJson);
		put(path.join(home, '.cursor', 'mcp.json'), `{"mcpServers": {"make-app-context": {"command": "node", "args": ["${path.join(home, '.cursor', 'skills', 'make-custom-app', 'mcp-server', 'dist', 'index.js')}"], "env": {"OPENAI_API_KEY": "${FAKE.cursor}", "PINECONE_API_KEY": "${FAKE.other}"}}}}`);
		const read = logic.readSecretSources({ home });
		assert.equal(read.errors.length, 1);
		const plan = logic.planSecrets({ sources: read.sources, existingText: `pinecone-api-key: ${FAKE.pinecone2}\n` });
		const report = baseReport({
			secrets: { ...plan, sources: read.sources, updates: plan.updates, error: read.errors[0], raw: parseMessage },
			contexts: { ...baseReport().contexts, copied: 1 },
		});
		const shown = [...logic.summaryLines(report), JSON.stringify(logic.jsonReport(report)), JSON.stringify(logic.jsonReport({ ...report, plugin: { ...report.plugin, action: 'present' } }))].join('\n');
		for (const seed of Object.values(FAKE)) assert.equal(shown.includes(seed), false, seed);
		if (parseMessage !== '') assert.equal(shown.includes(parseMessage), false);
		assert.equal(shown.includes('"sources"'), false);
		assert.equal(shown.includes('"updates"'), false);
		assert.equal(shown.includes('"raw"'), false);
		assert.ok(shown.includes('openai-api-key'));
	});
});
