/**
 * migrate-logic.js: the decisions behind the plugin migration prompt of check-setup.js and the migrate-to-plugin.js script.
 *
 * Role: plugin status, finding the claude binary without running it, the PLUGIN_MIGRATION line, and its throttle. Any function that
 * reads or writes under a home, temp, or Claude config folder takes those folders (and env, platform, and so on) as required
 * parameters and throws a TypeError without them, so a test or a script can never reach a real home by default.
 * Runs on Node 18 or newer. Needs only Node built-ins.
 */
const nodeFs = require('fs');
const nodeOs = require('os');
const path = require('path');

const PLUGIN_ID = 'make-custom-app@make-custom-app';
const MARKETPLACE_NAME = 'make-custom-app';
const MARKETPLACE_URL = 'https://github.com/minsu-kang/make-custom-app-skill.git';
const MIN_PLUGIN_VERSION = '3.0.0';
const DAY_MS = 86400000;
const PROMPT_INTERVAL_MS = { ask: DAY_MS, inactive: DAY_MS, unsupported: 30 * DAY_MS };
const DECLINE_TTL_MS = 7 * DAY_MS;
const LINE_PATTERN = /^PLUGIN_MIGRATION: (ask|inactive|handoff|unsupported) \| (.+)$/;
const CLAUDE_VERSION_PATTERN = /\(Claude Code\)/;
const ENABLE_COMMAND = `claude plugin enable ${PLUGIN_ID}`;
const THROTTLE_PREFIX = 'make-custom-app-plugin-prompt-';
const TORN_RETRY_MS = 50;

function requireParams(name, params, keys) {
	const given = params || {};
	if (!keys.some((key) => given[key] === undefined)) return;
	const names = keys.length > 2 ? `${keys.slice(0, -1).join(', ')}, and ${keys[keys.length - 1]}` : keys.join(' and ');
	throw new TypeError(`${name} needs ${names}`);
}

function pathFor(platform) {
	return platform === 'win32' ? path.win32 : path.posix;
}

function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(text) {
	try {
		const value = JSON.parse(text);
		return isPlainObject(value) ? value : null;
	} catch {
		return null;
	}
}

function sleepMs(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function claudeConfigDir(params) {
	requireParams('claudeConfigDir', params, ['env', 'home']);
	const { env, home } = params;
	const dir = env.CLAUDE_CONFIG_DIR;
	return typeof dir === 'string' && dir.length > 0 ? dir : path.join(home, '.claude');
}

function isOurPluginId(id) {
	return typeof id === 'string' && id.split('@').includes('make-custom-app');
}

function entryList(value) {
	if (Array.isArray(value)) return value.filter(isPlainObject);
	return isPlainObject(value) ? [value] : [];
}

function parseInstalledPlugins(text) {
	const top = parseObject(text);
	if (top === null) return { ok: false, entries: [] };
	const map = isPlainObject(top.plugins) ? top.plugins : top;
	const entries = [];
	for (const [id, value] of Object.entries(map)) {
		if (!isOurPluginId(id)) continue;
		for (const entry of entryList(value)) {
			entries.push({
				id,
				scope: typeof entry.scope === 'string' && entry.scope !== '' ? entry.scope : 'user',
				installPath: typeof entry.installPath === 'string' ? entry.installPath : null,
				version: typeof entry.version === 'string' ? entry.version : null,
			});
		}
	}
	return { ok: true, entries };
}

function pluginStatus({ installedText, settingsText, hasManifest }) {
	const absent = (reason) => ({ status: 'absent', reason, id: null, installPath: null, version: null });
	if (installedText === null || installedText === undefined) return absent('not-recorded');
	const parsed = parseInstalledPlugins(installedText);
	if (!parsed.ok) return absent('unreadable');
	if (parsed.entries.length === 0) return absent('not-recorded');
	const own = parsed.entries.filter((entry) => entry.scope === 'user' || entry.scope === 'managed');
	if (own.length === 0) return absent('project-only');
	const found = own.find((entry) => entry.installPath !== null && hasManifest(entry.installPath));
	if (found === undefined) return absent('cache-missing');
	const settings = settingsText === null || settingsText === undefined ? null : parseObject(settingsText);
	const enabled = settings !== null && isPlainObject(settings.enabledPlugins) ? settings.enabledPlugins[found.id] : undefined;
	return {
		status: enabled === false ? 'inactive' : 'usable',
		reason: enabled === false ? 'disabled' : null,
		id: found.id,
		installPath: found.installPath,
		version: found.version,
	};
}

function readTextOnce(fsImpl, file) {
	try {
		return fsImpl.readFileSync(file, 'utf8');
	} catch (err) {
		return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? null : '';
	}
}

function readJsonText(fsImpl, file, sleep) {
	const first = readTextOnce(fsImpl, file);
	if (first === null || parseObject(first) !== null) return first;
	sleep(TORN_RETRY_MS);
	return readTextOnce(fsImpl, file);
}

function readPluginStatus(params) {
	requireParams('readPluginStatus', params, ['env', 'home']);
	const { env, home, fs = nodeFs, sleep = sleepMs } = params;
	const dir = claudeConfigDir({ env, home });
	const installedText = readJsonText(fs, path.join(dir, 'plugins', 'installed_plugins.json'), sleep);
	const settingsText = readJsonText(fs, path.join(dir, 'settings.json'), sleep);
	const hasManifest = (installPath) => {
		try {
			return fs.statSync(path.join(installPath, '.claude-plugin', 'plugin.json')).isFile();
		} catch {
			return false;
		}
	};
	return pluginStatus({ installedText, settingsText, hasManifest });
}

function defaultIsExecutable(file) {
	try {
		if (!nodeFs.statSync(file).isFile()) return false;
		nodeFs.accessSync(file, nodeFs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function pathVariable(env, platform) {
	if (platform !== 'win32') return env.PATH;
	const key = ['Path', 'PATH'].find((name) => typeof env[name] === 'string') || Object.keys(env).find((name) => name.toLowerCase() === 'path');
	return key === undefined ? undefined : env[key];
}

function findClaudeBinary(params) {
	requireParams('findClaudeBinary', params, ['env', 'home', 'platform']);
	const { env, home, platform, isExecutable = defaultIsExecutable } = params;
	const win = platform === 'win32';
	const p = pathFor(platform);
	if (typeof env.CLAUDE_BIN === 'string' && env.CLAUDE_BIN !== '') {
		return { bin: isExecutable(env.CLAUDE_BIN) ? env.CLAUDE_BIN : null, explicit: true };
	}
	const names = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
	const dirs = String(pathVariable(env, platform) || '')
		.split(win ? ';' : ':')
		.map((dir) => (win ? dir.replace(/^"(.*)"$/, '$1') : dir))
		.filter((dir) => dir !== '');
	const candidates = dirs.flatMap((dir) => names.map((name) => p.join(dir, name)));
	if (win) {
		candidates.push(p.join(home, '.local', 'bin', 'claude.exe'));
		if (typeof env.APPDATA === 'string' && env.APPDATA !== '') candidates.push(p.join(env.APPDATA, 'npm', 'claude.cmd'));
	} else {
		candidates.push(p.join(home, '.local', 'bin', 'claude'), p.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude');
	}
	const bin = candidates.find((candidate) => isExecutable(candidate));
	return { bin: bin === undefined ? null : bin, explicit: false };
}

function promptState({ status, claudeBin, editorDir, declinedAt, now }) {
	if (status === 'usable') {
		const declined = typeof declinedAt === 'number' && declinedAt <= now && now - declinedAt < DECLINE_TTL_MS;
		return declined ? null : 'handoff';
	}
	if (status === 'inactive') return 'inactive';
	if (status === 'absent') return claudeBin || editorDir === '.claude' ? 'ask' : 'unsupported';
	return null;
}

function shouldShow({ cache, state, now }) {
	if (state === 'handoff') return true;
	if (!isPlainObject(cache) || typeof cache.state !== 'string' || !Number.isFinite(cache.shownAt)) return true;
	if (cache.state !== state || now < cache.shownAt) return true;
	return now - cache.shownAt >= PROMPT_INTERVAL_MS[state];
}

function migrationCommand(skillRoot, platform) {
	const script = pathFor(platform).join(skillRoot, 'scripts', 'migrate-to-plugin.js');
	return `node "${script.replace(/"/g, '\\"')}"`;
}

function migrationLine({ state, reason, skillRoot, editorDir, installPath, platform }) {
	const cmd = migrationCommand(skillRoot, platform);
	if (state === 'ask') {
		const where = reason === 'project-only' || reason === 'cache-missing' ? 'not installed for your user account' : 'not installed';
		return `PLUGIN_MIGRATION: ask | The make-custom-app plugin replaces this skill and is ${where}. Ask the user yes or no before other work. Yes runs: ${cmd}`;
	}
	if (state === 'inactive') {
		return `PLUGIN_MIGRATION: inactive | The make-custom-app plugin is installed but disabled, and this skill keeps working. To use the plugin, run in your own terminal: ${ENABLE_COMMAND}`;
	}
	if (state === 'handoff') {
		const first = `The make-custom-app plugin is installed, so this old skill is a leftover. Before other work: 1. Run ${cmd} (it installs nothing now, copies the MCP keys and app contexts the plugin lacks, and deletes nothing) and relay its last lines.`;
		const second =
			editorDir === '.claude'
				? '2. Call the Skill tool with make-custom-app:make-app-setup; it lists the old install and removes it after the user confirms. If that skill is not available in this session, tell the user to restart Claude Code, then continue with this skill.'
				: `2. Ask the user whether Cursor lists the make-app-* skills (the Cursor setting Include Third-Party Plugins must be on). If yes, read ${installPath}/skills/make-app-setup/SKILL.md and follow it; it removes the old install after the user confirms. If no, continue with this skill.`;
		return `PLUGIN_MIGRATION: handoff | ${first} ${second}`;
	}
	if (state === 'unsupported') {
		return 'PLUGIN_MIGRATION: unsupported | Claude Code was not found on this machine. Installing the make-custom-app plugin for Cursor alone is not supported yet, so this skill keeps working and nothing was changed.';
	}
	throw new Error(`unknown migration state: ${state}`);
}

function defaultUid() {
	return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function defaultUsername() {
	try {
		return nodeOs.userInfo().username;
	} catch {
		return 'user';
	}
}

function throttleFile(params) {
	requireParams('throttleFile', params, ['tmpdir']);
	const { tmpdir, platform = process.platform } = params;
	const uid = params.uid === undefined ? defaultUid() : params.uid;
	const byName = platform === 'win32' || uid === undefined;
	const id = byName ? String(params.username === undefined ? defaultUsername() : params.username).replace(/[^A-Za-z0-9._-]/g, '_') : String(uid);
	return pathFor(platform).join(tmpdir, `${THROTTLE_PREFIX}${id}.json`);
}

function readThrottle({ file, fs = nodeFs }) {
	try {
		return parseObject(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

function writeThrottle({ file, fs = nodeFs, pid = process.pid, state, now = Date.now() }) {
	if (typeof file !== 'string' || file === '') return false;
	const temp = `${file}.${pid}.tmp`;
	try {
		fs.writeFileSync(temp, JSON.stringify({ state, shownAt: now }), { flag: 'wx', mode: 0o600 });
		fs.renameSync(temp, file);
		return true;
	} catch {
		try {
			fs.unlinkSync(temp);
		} catch {}
		return false;
	}
}

function removeThrottle({ file, fs = nodeFs }) {
	try {
		fs.unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}

function readDeclinedAt(params) {
	requireParams('readDeclinedAt', params, ['home']);
	const { home, fs = nodeFs } = params;
	try {
		const marker = parseObject(fs.readFileSync(path.join(home, '.make-custom-app', 'legacy-cleanup.json'), 'utf8'));
		const at = marker !== null && typeof marker.declinedAt === 'string' ? Date.parse(marker.declinedAt) : NaN;
		return Number.isNaN(at) ? null : at;
	} catch {
		return null;
	}
}

function resolveNow(now) {
	if (typeof now === 'function') return now();
	return now === undefined ? Date.now() : now;
}

function migrationNotice(params) {
	requireParams('migrationNotice', params, ['env', 'home', 'tmpdir', 'platform', 'skillRoot', 'editorDir']);
	const { env, home, tmpdir, platform, uid, username, fs = nodeFs, sleep, isExecutable, skillRoot, editorDir, json } = params;
	try {
		const now = resolveNow(params.now);
		const status = readPluginStatus({ env, home, fs, sleep });
		const claudeBin = status.status === 'absent' ? findClaudeBinary({ env, platform, home, isExecutable }).bin : null;
		const declinedAt = status.status === 'usable' ? readDeclinedAt({ home, fs }) : null;
		const state = promptState({ status: status.status, claudeBin, editorDir, declinedAt, now });
		if (state === null) return null;
		const line = migrationLine({ state, reason: status.reason, skillRoot, editorDir, installPath: status.installPath, platform });
		const file = throttleFile({ tmpdir, platform, uid, username });
		const due = shouldShow({ cache: readThrottle({ file, fs }), state, now });
		if (due && !json) writeThrottle({ file, fs, pid: process.pid, state, now });
		const command = state === 'inactive' ? ENABLE_COMMAND : state === 'unsupported' ? null : migrationCommand(skillRoot, platform);
		return { state, reason: status.reason, claudeBin, command, line, due };
	} catch {
		return null;
	}
}

module.exports = {
	PLUGIN_ID,
	MARKETPLACE_NAME,
	MARKETPLACE_URL,
	MIN_PLUGIN_VERSION,
	PROMPT_INTERVAL_MS,
	DECLINE_TTL_MS,
	LINE_PATTERN,
	CLAUDE_VERSION_PATTERN,
	requireParams,
	claudeConfigDir,
	isOurPluginId,
	parseInstalledPlugins,
	pluginStatus,
	readPluginStatus,
	findClaudeBinary,
	promptState,
	shouldShow,
	migrationCommand,
	migrationLine,
	throttleFile,
	readThrottle,
	writeThrottle,
	removeThrottle,
	readDeclinedAt,
	migrationNotice,
};
