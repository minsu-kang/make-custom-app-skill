/**
 * migrate-logic.js: the decisions behind the plugin migration prompt of check-setup.js and the migrate-to-plugin.js script.
 *
 * Role: plugin status, finding the claude binary without running it, the PLUGIN_MIGRATION line, and its throttle; the arguments,
 * child process setup, secret sources and plan, and the lock of migrate-to-plugin.js; copying the app contexts, checking the
 * install, and building the summary and JSON report. Any function that
 * reads or writes under a home, temp, or Claude config folder takes those folders (and env, platform, and so on) as required
 * parameters and throws a TypeError without them, so a test or a script can never reach a real home by default.
 * Runs on Node 18 or newer. Needs only Node built-ins and ./settings.
 */
const nodeFs = require('fs');
const nodeOs = require('os');
const path = require('path');
const crypto = require('crypto');
const { isPlaceholder } = require('./settings');

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

const FOLDER_PARAMS = new Set(['home', 'tmpdir', 'root', 'targetRoot']);

function paramIsValid(key, value) {
	if (FOLDER_PARAMS.has(key)) return typeof value === 'string' && value !== '';
	if (key === 'env') return isPlainObject(value);
	return value !== undefined;
}

function requireParams(name, params, keys) {
	const given = params || {};
	if (keys.every((key) => paramIsValid(key, given[key]))) return;
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
		const value = JSON.parse(String(text).replace(/^\uFEFF/, ''));
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

const LINE_BREAK = /[\r\n\u2028\u2029]/;
const CONTROL_CHARACTER = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const WINDOWS_UNSAFE = /[$`%^&!"\x00-\x1f\x7f]/;

function hasControlCharacter(value) {
	return typeof value === 'string' && CONTROL_CHARACTER.test(value);
}

function migrationCommand(skillRoot, platform) {
	if (LINE_BREAK.test(skillRoot)) return null;
	const script = pathFor(platform).join(skillRoot, 'scripts', 'migrate-to-plugin.js');
	if (platform === 'win32') return WINDOWS_UNSAFE.test(script) ? null : `node "${script}"`;
	return `node '${script.replace(/'/g, "'\\''")}'`;
}

function migrationLine({ state, reason, skillRoot, editorDir, installPath, platform }) {
	const cmd = migrationCommand(skillRoot, platform);
	if (cmd === null && (state === 'ask' || state === 'handoff')) return null;
	if (state === 'handoff' && editorDir !== '.claude' && hasControlCharacter(installPath)) return null;
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
		if ([status.id, status.version, status.installPath].some(hasControlCharacter)) return null;
		const claudeBin = status.status === 'absent' ? findClaudeBinary({ env, platform, home, isExecutable }).bin : null;
		const declinedAt = status.status === 'usable' ? readDeclinedAt({ home, fs }) : null;
		const state = promptState({ status: status.status, claudeBin, editorDir, declinedAt, now });
		if (state === null) return null;
		const line = migrationLine({ state, reason: status.reason, skillRoot, editorDir, installPath: status.installPath, platform });
		if (line === null) return null;
		const file = throttleFile({ tmpdir, platform, uid, username });
		const due = shouldShow({ cache: readThrottle({ file, fs }), state, now });
		if (due && !json) writeThrottle({ file, fs, pid: process.pid, state, now });
		const command = state === 'inactive' ? ENABLE_COMMAND : state === 'unsupported' ? null : migrationCommand(skillRoot, platform);
		return { state, reason: status.reason, claudeBin, command, line, due };
	} catch {
		return null;
	}
}

const DEFAULT_TIMEOUT_SEC = 75;
const TIMEOUT_ERROR = '--timeout needs a whole number of seconds from 5 to 600';

function parseTimeout(raw) {
	if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
	const seconds = Number(raw);
	return seconds >= 5 && seconds <= 600 ? seconds : null;
}

function parseArgs(argv) {
	const args = Array.isArray(argv) ? argv : [];
	const result = { dryRun: false, json: false, skipVersion: false, timeoutSec: DEFAULT_TIMEOUT_SEC, error: null };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--dry-run') {
			result.dryRun = true;
			result.skipVersion = true;
		} else if (arg === '--json') {
			result.json = true;
		} else if (arg === '--skip-version') {
			result.skipVersion = true;
		} else if (arg === '--timeout' || (typeof arg === 'string' && arg.startsWith('--timeout='))) {
			const seconds = parseTimeout(arg === '--timeout' ? args[++i] : arg.slice('--timeout='.length));
			if (seconds === null) {
				result.error = TIMEOUT_ERROR;
				return result;
			}
			result.timeoutSec = seconds;
		} else {
			result.error = `Unknown option: ${arg}`;
			return result;
		}
	}
	return result;
}

function childEnv(params) {
	requireParams('childEnv', params, ['env', 'home']);
	const { env, home } = params;
	const out = { ...env, HOME: home, USERPROFILE: home };
	delete out.CLAUDECODE;
	return out;
}

const CMD_UNSAFE_ARGUMENT = /[\s"&|<>^%]/;
const CMD_UNSAFE_PATH = /["%]/;

function spawnSpec(params) {
	requireParams('spawnSpec', params, ['env', 'home', 'platform']);
	const { bin, args = [], platform, env, home, timeoutMs } = params;
	const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv({ env, home }), cwd: home, timeout: timeoutMs, windowsHide: true };
	if (platform === 'win32' && /\.cmd$/i.test(bin)) {
		if (CMD_UNSAFE_PATH.test(bin)) {
			throw new TypeError('spawnSpec: the path of claude.cmd holds a character that cmd.exe would read as syntax');
		}
		if (args.some((arg) => CMD_UNSAFE_ARGUMENT.test(arg))) {
			throw new TypeError('spawnSpec: an argument for claude.cmd holds a character that cmd.exe would read as syntax');
		}
		return { command: 'cmd.exe', args: ['/d', '/s', '/c', `""${bin}" ${args.join(' ')}"`], options: { ...options, windowsVerbatimArguments: true } };
	}
	return { command: bin, args, options };
}

function describeError(err, filePath) {
	if (err instanceof SyntaxError) return `${filePath} is not valid JSON`;
	if (err && typeof err.code === 'string') return `${err.code} on ${filePath}`;
	return 'an unexpected error occurred';
}

function stripBom(text) {
	return String(text).replace(/^\uFEFF/, '');
}

function stripJsonComments(text) {
	const out = [];
	let lastComma = -1;
	let prev = '';
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			let end = i + 1;
			while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
			out.push(text.slice(i, end + 1));
			lastComma = -1;
			prev = '"';
			i = end + 1;
		} else if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
		} else if (ch === '/' && text[i + 1] === '*') {
			const close = text.indexOf('*/', i + 2);
			out.push(' ');
			i = close === -1 ? text.length : close + 2;
		} else {
			if (ch === ',') {
				lastComma = /[\]}"\w]/.test(prev) ? out.length : -1;
			} else if (ch === '}' || ch === ']') {
				if (lastComma !== -1) out[lastComma] = '';
				lastComma = -1;
			} else if (!/\s/.test(ch)) {
				lastComma = -1;
			}
			if (!/\s/.test(ch)) prev = ch;
			out.push(ch);
			i++;
		}
	}
	return out.join('');
}

function parseJsonc(text) {
	return JSON.parse(stripJsonComments(stripBom(text)));
}

const ADDRESS_FIELDS = ['url', 'path', 'repo'];

function firstAddress(holder) {
	if (!isPlainObject(holder)) return null;
	const field = ADDRESS_FIELDS.find((name) => typeof holder[name] === 'string' && holder[name] !== '');
	return field === undefined ? null : holder[field];
}

function marketplaceSource(entry) {
	const direct = firstAddress(entry);
	if (direct !== null) return direct;
	const nested = firstAddress(entry.source);
	if (nested !== null) return nested;
	return typeof entry.source === 'string' && entry.source !== '' ? entry.source : null;
}

function parseMarketplaceList(text) {
	let data;
	try {
		data = JSON.parse(stripBom(text));
	} catch {
		return [];
	}
	const list = Array.isArray(data) ? data : isPlainObject(data) && Array.isArray(data.marketplaces) ? data.marketplaces : [];
	return list.filter((entry) => isPlainObject(entry) && typeof entry.name === 'string' && entry.name !== '').map((entry) => ({ name: entry.name, source: marketplaceSource(entry) }));
}

const CR_OR_LF = /[\r\n]/;

function usableValue(value) {
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	return trimmed !== '' && !CR_OR_LF.test(value) && !trimmed.startsWith('${') && !isPlaceholder(trimmed);
}

function parseEnvText(text) {
	const values = {};
	for (const line of stripBom(text).split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) continue;
		const split = trimmed.indexOf('=');
		if (split === -1) continue;
		const key = trimmed.slice(0, split).trim();
		if (key !== '') values[key] = trimmed.slice(split + 1).trim();
	}
	return values;
}

const OLD_SKILL_FOLDER = /[\\/]skills[\\/]make-custom-app(?:[\\/]|$)/;

function entryParts(entry) {
	if (!isPlainObject(entry)) return [];
	return [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].filter((part) => typeof part === 'string');
}

function pointsIntoOldSkill(entry) {
	return entryParts(entry).some((part) => OLD_SKILL_FOLDER.test(part));
}

function absolutePath(value) {
	if (typeof value !== 'string' || value === '') return null;
	const unified = path.posix.normalize(value.replace(/\\/g, '/'));
	if (!/^(?:\/|[A-Za-z]:\/)/.test(unified)) return null;
	return unified.length > 1 && unified.endsWith('/') ? unified.slice(0, -1) : unified;
}

function folderPath(value) {
	const folder = absolutePath(value);
	return folder === null || folder === '/' || /^[A-Za-z]:$/.test(folder) ? null : folder;
}

function liesInside(file, folder) {
	const target = absolutePath(file);
	const base = folderPath(folder);
	if (target === null || base === null) return false;
	return target === base || target.startsWith(`${base}/`);
}

const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

function isOldRegistration(entry, mcpServerPath) {
	const parts = entryParts(entry).filter((part) => !PARENT_SEGMENT.test(part));
	if (parts.some((part) => OLD_SKILL_FOLDER.test(part))) return true;
	if (typeof mcpServerPath !== 'string' || mcpServerPath === '') return false;
	return parts.some((part) => liesInside(part, mcpServerPath));
}

const ENV_TO_KEY = { PINECONE_API_KEY: 'pinecone-api-key', OPENAI_API_KEY: 'openai-api-key', PINECONE_INDEX_NAME: 'pinecone-index-name' };

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function secretsValue(text, key) {
	const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`);
	const lines = String(text ?? '').split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const match = pattern.exec(lines[i].trim());
		if (match !== null && usableValue(match[1])) return match[1];
	}
	return null;
}

const CLAUDE_JSON_ATTEMPTS = 3;
const CLAUDE_JSON_RETRY_MS = 100;
const OLD_SKILL_ENV = ['skills', 'make-custom-app', 'mcp-server', '.env'];

function isMissingFile(err) {
	return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

function readParsed({ fs, file, parse, attempts, sleep }) {
	let failure;
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (attempt > 0) sleep(CLAUDE_JSON_RETRY_MS);
		let text;
		try {
			text = fs.readFileSync(file, 'utf8');
		} catch (err) {
			if (isMissingFile(err)) return { missing: true };
			failure = err;
			continue;
		}
		try {
			return { value: parse(text) };
		} catch (err) {
			failure = err;
		}
	}
	return { failure };
}

function parseJsonOrJsonc(text) {
	try {
		return JSON.parse(stripBom(text));
	} catch {
		return parseJsonc(text);
	}
}

function envValues(env) {
	const values = {};
	if (!isPlainObject(env)) return values;
	for (const name of Object.keys(ENV_TO_KEY)) {
		if (typeof env[name] === 'string') values[name] = env[name].trim();
	}
	return values;
}

function readSecretSources(params) {
	requireParams('readSecretSources', params, ['home']);
	const { home, fs = nodeFs, sleep = sleepMs } = params;
	const oldSkillFolders = ['.claude', '.cursor'].map((editor) => path.join(home, editor, 'skills', 'make-custom-app'));
	const given = typeof params.mcpServerPath === 'string' ? params.mcpServerPath.trim() : '';
	const mcpServerPath = path.isAbsolute(given) && folderPath(given) !== null && !oldSkillFolders.some((folder) => liesInside(given, folder)) ? given : undefined;
	const sources = [];
	const errors = [];
	const add = (label, env) => {
		const values = envValues(env);
		if (Object.keys(values).length > 0) sources.push({ label, values });
	};
	const readFile = (file, parse, attempts) => {
		const read = readParsed({ fs, file, parse, attempts, sleep });
		if (Object.hasOwn(read, 'failure')) errors.push(describeError(read.failure, file));
		return Object.hasOwn(read, 'value') ? read.value : null;
	};
	const addEnvFile = (label, file) => {
		const values = readFile(file, parseEnvText, 1);
		if (values !== null) add(label, values);
	};
	const serversOf = (config) => (isPlainObject(config) && isPlainObject(config.mcpServers) ? config.mcpServers : {});

	const claudeServers = serversOf(readFile(path.join(home, '.claude.json'), (text) => JSON.parse(stripBom(text)), CLAUDE_JSON_ATTEMPTS));
	const claudeEntry = claudeServers['make-custom-app'];
	if (isOldRegistration(claudeEntry, mcpServerPath)) add('claude-registration', claudeEntry.env);
	addEnvFile('claude-env', path.join(home, '.claude', ...OLD_SKILL_ENV));

	for (const [key, entry] of Object.entries(serversOf(readFile(path.join(home, '.cursor', 'mcp.json'), parseJsonOrJsonc, 1)))) {
		if (isOldRegistration(entry)) add(`cursor-registration:${key}`, entry.env);
	}
	addEnvFile('cursor-env', path.join(home, '.cursor', ...OLD_SKILL_ENV));
	if (mcpServerPath !== undefined) addEnvFile('mcp-server-path-env', path.join(mcpServerPath, '.env'));
	return { sources, errors };
}

function skipReason(value) {
	if (CR_OR_LF.test(value)) return 'multiline';
	return value.startsWith('${') ? 'reference' : 'placeholder';
}

function planSecrets({ sources = [], existingText = '' } = {}) {
	const plan = { updates: {}, copied: [], keptExisting: [], conflicts: [], skipped: [] };
	for (const [envName, key] of Object.entries(ENV_TO_KEY)) {
		const candidates = sources
			.filter((source) => isPlainObject(source) && isPlainObject(source.values) && typeof source.values[envName] === 'string')
			.map((source) => ({ label: source.label, value: source.values[envName].trim() }));
		const usable = candidates.filter((candidate) => usableValue(candidate.value));
		const existing = secretsValue(existingText, key);
		if (usable.length > 0) {
			const used = existing === null ? usable[0] : { label: 'secrets-file', value: existing };
			if (existing === null) {
				plan.updates[key] = used.value;
				plan.copied.push(key);
			} else {
				plan.keptExisting.push(key);
			}
			const others = usable.filter((candidate) => candidate.value !== used.value).map((candidate) => candidate.label);
			if (others.length > 0) plan.conflicts.push({ key, used: used.label, others });
		} else if (candidates.length > 0 && existing === null) {
			plan.skipped.push({ key, reason: skipReason(candidates[0].value) });
		}
	}
	return plan;
}

const LOCK_STALE_MS = 600000;
const LOCK_PARTIAL_MS = 5000;

function defaultIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return !(err && err.code === 'ESRCH');
	}
}

function parseLock(text) {
	const lock = parseObject(text);
	return lock !== null && Number.isInteger(lock.pid) && lock.pid > 0 && Number.isFinite(lock.at) ? { pid: lock.pid, at: lock.at } : null;
}

function readLockFile(fs, file) {
	try {
		const text = fs.readFileSync(file, 'utf8');
		return { text, holder: parseLock(text) };
	} catch (err) {
		return isMissingFile(err) ? { missing: true } : { unreadable: true };
	}
}

function fileAgeMs(fs, file, now) {
	try {
		return now - fs.statSync(file).mtimeMs;
	} catch {
		return null;
	}
}

function createExclusive(fs, file, content) {
	try {
		fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
		return true;
	} catch (err) {
		if (err && err.code === 'EEXIST') return false;
		throw err;
	}
}

function removeIfPresent(fs, file) {
	try {
		fs.unlinkSync(file);
	} catch (err) {
		if (!err || err.code !== 'ENOENT') throw err;
	}
}

function acquireMigrationLock(params) {
	requireParams('acquireMigrationLock', params, ['home']);
	const { home, fs = nodeFs, pid = process.pid, isAlive = defaultIsAlive } = params;
	const clock = () => resolveNow(params.now);
	const dir = path.join(home, '.make-custom-app');
	const file = path.join(dir, 'cleanup.lock');
	const takeoverFile = `${file}.takeover`;
	const content = JSON.stringify({ pid, at: clock() });
	const heldBy = (read) => ({ ok: false, pid: read.holder ? read.holder.pid : null });
	const acquired = () => ({
		ok: true,
		release() {
			try {
				if (fs.readFileSync(file, 'utf8') === content) fs.unlinkSync(file);
			} catch {}
		},
	});
	const isStale = (read) => {
		const now = clock();
		if (read.holder !== null) return !isAlive(read.holder.pid) || read.holder.at > now || now - read.holder.at > LOCK_STALE_MS;
		const age = fileAgeMs(fs, file, now);
		return age !== null && Math.abs(age) > LOCK_PARTIAL_MS;
	};
	const takeOver = (staleText) => {
		if (!createExclusive(fs, takeoverFile, content)) return { ok: false, pid: null };
		try {
			const again = readLockFile(fs, file);
			if (!again.missing) {
				if (again.text !== staleText) return heldBy(again);
				removeIfPresent(fs, file);
			}
			return createExclusive(fs, file, content) ? acquired() : heldBy(readLockFile(fs, file));
		} finally {
			try {
				fs.unlinkSync(takeoverFile);
			} catch {}
		}
	};

	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (createExclusive(fs, file, content)) return acquired();
	const seen = readLockFile(fs, file);
	if (seen.missing) return createExclusive(fs, file, content) ? acquired() : heldBy(readLockFile(fs, file));
	if (seen.unreadable || !isStale(seen)) return heldBy(seen);
	return takeOver(seen.text);
}

const CONTEXT_FILE_PATTERN = /^(.+)-v(\d+)\.md$/;
const CONTEXT_DIR_PATTERN = /^(.+)-v(\d+)$/;
const REVIEW_DEPTH = 4;
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const TEMP_PATTERN = /\.migrate-(\d+)-\d+\.tmp$/;
const TEMP_STALE_MS = 600000;
const LINK_FALLBACK_CODES = new Set(['EPERM', 'ENOTSUP', 'EXDEV']);

function classifyContextName(name) {
	const other = { kind: 'other', slug: null, version: null };
	if (typeof name !== 'string') return other;
	const file = CONTEXT_FILE_PATTERN.exec(name);
	if (file !== null) return { kind: 'context-file', slug: file[1], version: Number(file[2]) };
	const dir = CONTEXT_DIR_PATTERN.exec(name);
	return dir === null ? other : { kind: 'context-dir', slug: dir[1], version: Number(dir[2]) };
}

function isOrgDownload(metadataText) {
	const metadata = parseObject(metadataText);
	return metadata !== null && Object.hasOwn(metadata, 'snapshot') && isPlainObject(metadata.snapshot);
}

function byName(a, b) {
	return Number(a.name > b.name) - Number(a.name < b.name);
}

function byRel(a, b) {
	return Number(a.rel > b.rel) - Number(a.rel < b.rel);
}

function readEntries(fs, dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		if (isMissingFile(err)) return null;
		throw err;
	}
	return entries.filter((entry) => !entry.name.startsWith('.')).sort(byName);
}

function addListedFile(result, fs, abs, rel) {
	let stat;
	try {
		stat = fs.lstatSync(abs);
	} catch (err) {
		if (isMissingFile(err)) return;
		throw err;
	}
	if (stat.isFile()) result.files.push({ rel, abs, size: stat.size, mtimeMs: stat.mtimeMs });
}

function walkReviews(result, fs, dir, relDir, depth) {
	const entries = readEntries(fs, dir);
	if (entries === null) return;
	for (const entry of entries) {
		const rel = `${relDir}/${entry.name}`;
		const abs = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) result.symlinks.push(rel);
		else if (entry.isFile()) addListedFile(result, fs, abs, rel);
		else if (entry.isDirectory() && depth < REVIEW_DEPTH) walkReviews(result, fs, abs, rel, depth + 1);
	}
}

function isOrgFolder(fs, dir, entries) {
	if (!entries.some((entry) => entry.name === 'metadata.json' && entry.isFile())) return false;
	try {
		return isOrgDownload(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
	} catch (err) {
		if (isMissingFile(err)) return false;
		throw err;
	}
}

function listContextFolder(result, fs, root, name) {
	const dir = path.join(root, name);
	const entries = readEntries(fs, dir);
	if (entries === null) return;
	if (isOrgFolder(fs, dir, entries)) {
		result.orgSkipped.push(`${name}/`);
		return;
	}
	const reviews = entries.find((entry) => entry.name === 'reviews');
	if (reviews === undefined) return;
	if (reviews.isSymbolicLink()) result.symlinks.push(`${name}/reviews`);
	else if (reviews.isDirectory()) walkReviews(result, fs, path.join(dir, 'reviews'), `${name}/reviews`, 0);
}

function listContextFiles(params) {
	requireParams('listContextFiles', params, ['root']);
	const { root, fs = nodeFs } = params;
	const result = { files: [], orgSkipped: [], symlinks: [] };
	const entries = readEntries(fs, root);
	if (entries === null) return result;
	for (const entry of entries) {
		const { kind } = classifyContextName(entry.name);
		if (kind === 'other') continue;
		if (entry.isSymbolicLink()) result.symlinks.push(entry.name);
		else if (kind === 'context-file' && entry.isFile()) addListedFile(result, fs, path.join(root, entry.name), entry.name);
		else if (kind === 'context-dir' && entry.isDirectory()) listContextFolder(result, fs, root, entry.name);
	}
	result.files.sort(byRel);
	result.symlinks.sort();
	result.orgSkipped.sort();
	return result;
}

function regularSize(fs, file) {
	const stat = fs.lstatSync(file);
	return stat.isFile() ? stat.size : null;
}

function digestOf(fs, file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sameContent({ a, b, fs = nodeFs } = {}) {
	try {
		const sizeA = regularSize(fs, a);
		const sizeB = regularSize(fs, b);
		if (sizeA === null || sizeB === null || sizeA !== sizeB || sizeA > MAX_HASH_BYTES) return false;
		return sizeA === 0 || digestOf(fs, a) === digestOf(fs, b);
	} catch {
		return false;
	}
}

function chooseSource(entry, fs) {
	if (entry.claude === undefined || entry.cursor === undefined) {
		const from = entry.claude === undefined ? 'cursor' : 'claude';
		return { from, file: entry[from], differs: false };
	}
	if (sameContent({ a: entry.claude.abs, b: entry.cursor.abs, fs })) return { from: 'claude', file: entry.claude, differs: false };
	const from = entry.cursor.mtimeMs > entry.claude.mtimeMs ? 'cursor' : 'claude';
	return { from, file: entry[from], differs: true };
}

function planContexts(params) {
	requireParams('planContexts', params, ['target']);
	const { claude, cursor, target, fs = nodeFs } = params;
	const plan = { copies: [], alreadyPresent: 0, keptExisting: [], duplicates: [], blocked: [] };
	const byPath = new Map();
	for (const [from, listing] of [['claude', claude], ['cursor', cursor]]) {
		for (const file of isPlainObject(listing) && Array.isArray(listing.files) ? listing.files : []) {
			byPath.set(file.rel, { ...byPath.get(file.rel), [from]: file });
		}
	}
	for (const rel of [...byPath.keys()].sort()) {
		const { from, file, differs } = chooseSource(byPath.get(rel), fs);
		if (differs) plan.duplicates.push({ rel, used: from });
		const found = target(rel, { rel, from, src: file.abs, size: file.size, mtimeMs: file.mtimeMs });
		if (found.parentIsFile) plan.blocked.push(rel);
		else if (found.exists && found.isFile && found.same) plan.alreadyPresent += 1;
		else if (found.exists) plan.keptExisting.push(rel);
		else plan.copies.push({ rel, from, src: file.abs });
	}
	return plan;
}

function codedError(code) {
	return Object.assign(new Error(code), { code });
}

function errorCode(err) {
	return err && typeof err.code === 'string' && err.code !== '' ? err.code : 'UNKNOWN';
}

function removeQuietly(fs, file) {
	try {
		fs.unlinkSync(file);
	} catch {}
}

function sweepTemps({ fs, dir, pid, now }) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			sweepTemps({ fs, dir: file, pid, now });
			continue;
		}
		const match = entry.isFile() ? TEMP_PATTERN.exec(entry.name) : null;
		if (match === null) continue;
		try {
			if (match[1] === String(pid) || now - fs.lstatSync(file).mtimeMs > TEMP_STALE_MS) fs.unlinkSync(file);
		} catch {}
	}
}

function destinationPath(targetRoot, rel) {
	if (typeof rel !== 'string') return null;
	const segments = rel.split('/');
	const unsafe = (segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0');
	return segments.some(unsafe) ? null : path.join(targetRoot, ...segments);
}

function pathExists(fs, file) {
	try {
		fs.lstatSync(file);
		return true;
	} catch (err) {
		if (isMissingFile(err)) return false;
		throw err;
	}
}

function placeFile(fs, tmp, dst) {
	try {
		fs.linkSync(tmp, dst);
	} catch (err) {
		if (!err || !LINK_FALLBACK_CODES.has(err.code)) throw err;
		if (pathExists(fs, dst)) throw codedError('EEXIST');
		fs.renameSync(tmp, dst);
		return;
	}
	fs.unlinkSync(tmp);
}

function copyOne({ fs, src, dst, tmp }) {
	const stat = fs.lstatSync(src);
	if (!stat.isFile()) throw codedError('EINVAL');
	fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
	try {
		fs.copyFileSync(src, tmp, nodeFs.constants.COPYFILE_EXCL);
	} catch (err) {
		if (!err || err.code !== 'EEXIST') removeQuietly(fs, tmp);
		throw err;
	}
	try {
		placeFile(fs, tmp, dst);
	} catch (err) {
		removeQuietly(fs, tmp);
		throw err;
	}
	fs.utimesSync(dst, stat.atimeMs / 1000, stat.mtimeMs / 1000);
}

function applyContextCopies(params) {
	requireParams('applyContextCopies', params, ['targetRoot']);
	const { plan, targetRoot, fs = nodeFs, pid = process.pid } = params;
	sweepTemps({ fs, dir: targetRoot, pid, now: resolveNow(params.now) });
	const copies = isPlainObject(plan) && Array.isArray(plan.copies) ? plan.copies : [];
	const result = { copied: 0, errors: [] };
	copies.forEach((copy, index) => {
		const item = isPlainObject(copy) ? copy : {};
		try {
			const dst = destinationPath(targetRoot, item.rel);
			if (dst === null || typeof item.src !== 'string') throw codedError('EINVAL');
			copyOne({ fs, src: item.src, dst, tmp: `${dst}.migrate-${pid}-${index + 1}.tmp` });
			result.copied += 1;
		} catch (err) {
			result.errors.push({ rel: typeof item.rel === 'string' ? item.rel : '', code: errorCode(err) });
		}
	});
	return result;
}

const PLUGIN_NAME = 'make-custom-app';
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
const REASON_PATTERN = /^[a-z][a-z-]*$/;

function versionParts(text) {
	const match = typeof text === 'string' ? VERSION_PATTERN.exec(text) : null;
	return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isBelow(parts, floor) {
	for (let i = 0; i < floor.length; i++) {
		if (parts[i] !== floor[i]) return parts[i] < floor[i];
	}
	return false;
}

function parseManifest(manifestText, manifestPath) {
	if (typeof manifestText !== 'string') return { problem: `${manifestPath} could not be read` };
	let manifest;
	try {
		manifest = JSON.parse(stripBom(manifestText));
	} catch {
		return { problem: `${manifestPath} is not valid JSON` };
	}
	return isPlainObject(manifest) ? { manifest } : { problem: `${manifestPath} does not hold a JSON object` };
}

function manifestProblems(manifest, manifestPath, recordedVersion) {
	const problems = [];
	if (manifest.name !== PLUGIN_NAME) problems.push(`the name in ${manifestPath} is not ${PLUGIN_NAME}`);
	const parts = versionParts(manifest.version);
	if (parts === null) {
		problems.push(`the version in ${manifestPath} is missing or not a version number`);
		return problems;
	}
	if (isBelow(parts, versionParts(MIN_PLUGIN_VERSION))) problems.push(`the version in ${manifestPath} (${parts.join('.')}) is below ${MIN_PLUGIN_VERSION}`);
	if (typeof recordedVersion === 'string' && manifest.version !== recordedVersion) {
		problems.push(`the version in ${manifestPath} differs from the version recorded for the install`);
	}
	return problems;
}

function verifyInstall(params) {
	requireParams('verifyInstall', params, ['status', 'exists']);
	const { status, manifestText, exists } = params;
	const info = isPlainObject(status) ? status : {};
	if (info.status !== 'usable' && info.status !== 'inactive') {
		const reason = typeof info.reason === 'string' && REASON_PATTERN.test(info.reason) ? ` (${info.reason})` : '';
		return [`claude did not record the plugin as installed${reason}`];
	}
	const installPath = info.installPath;
	if (typeof installPath !== 'string' || installPath === '') return ['the install path of the plugin is not recorded'];
	const manifestPath = path.join(installPath, '.claude-plugin', 'plugin.json');
	const parsed = parseManifest(manifestText, manifestPath);
	const problems = Object.hasOwn(parsed, 'problem') ? [parsed.problem] : manifestProblems(parsed.manifest, manifestPath, info.version);
	for (const parts of [['skills', 'make-app-setup', 'SKILL.md'], ['mcp', 'index.mjs']]) {
		const file = path.join(installPath, ...parts);
		if (!exists(file)) problems.push(`${file} is missing`);
	}
	return problems;
}

const NEXT_RESTART_CLAUDE = 'Next: restart Claude Code, then run /make-custom-app:make-app-setup (or start any Make task). It lists the old install and removes it after you confirm.';
const NEXT_RESTART_CURSOR =
	'Next: turn on the Cursor setting Include Third-Party Plugins (Cursor loads the plugin installed for Claude Code), restart Cursor, then run /make-app-setup (or start any Make task). It lists the old install and removes it after you confirm.';
const NEXT_HANDOFF = 'Next: continue with the make-app-setup skill of the plugin; it lists the old install and removes it after you confirm.';

function nextLines(editor, installedNow) {
	if (editor !== 'claude' && editor !== 'cursor') throw new TypeError('nextLines needs the editor claude or cursor');
	if (installedNow !== true) return [NEXT_HANDOFF];
	return [editor === 'claude' ? NEXT_RESTART_CLAUDE : NEXT_RESTART_CURSOR];
}

const MARKETPLACE_ACTIONS = ['added', 'present', 'skipped', 'failed'];
const PLUGIN_ACTIONS = ['installed', 'present', 'disabled', 'failed', 'skipped'];
const PLUGIN_STATE_TEXT = { installed: 'installed', present: 'already installed', disabled: 'installed but disabled' };
const UNPRINTABLE = /[\u0000-\u001f\u007f\u2028\u2029]/;
const URL_USERINFO = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#\s]*@/;
const NOTHING_DELETED = 'Nothing was deleted. The old skill keeps working until the cleanup.';
const LOCK_PATH = '~/.make-custom-app/cleanup.lock';

function cleanText(value) {
	return typeof value === 'string' && value !== '' && !UNPRINTABLE.test(value) ? value : null;
}

function publicAddress(value) {
	const text = cleanText(value);
	return text === null ? null : text.replace(URL_USERINFO, '$1');
}

function displayText(value) {
	return String(value).replace(new RegExp(UNPRINTABLE.source, 'g'), '?');
}

function stringsOf(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function recordsOf(value, pick) {
	return Array.isArray(value) ? value.filter(isPlainObject).map(pick).filter((item) => item !== null) : [];
}

function countOf(value) {
	return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeReport(name, report) {
	const given = isPlainObject(report) ? report : {};
	if (given.editor !== 'claude' && given.editor !== 'cursor') throw new TypeError(`${name} needs the editor claude or cursor`);
	const part = (key) => (isPlainObject(given[key]) ? given[key] : {});
	const [claude, marketplace, plugin, lock, secrets, contexts] = ['claude', 'marketplace', 'plugin', 'lock', 'secrets', 'contexts'].map(part);
	const pluginAction = PLUGIN_ACTIONS.includes(plugin.action) ? plugin.action : 'skipped';
	const installedNow = pluginAction === 'installed';
	return {
		ok: given.ok === true,
		exitCode: Number.isInteger(given.exitCode) ? given.exitCode : 1,
		editor: given.editor,
		dryRun: given.dryRun === true,
		claude: { bin: cleanText(claude.bin), version: cleanText(claude.version) },
		marketplace: { action: MARKETPLACE_ACTIONS.includes(marketplace.action) ? marketplace.action : 'skipped', source: publicAddress(marketplace.source) },
		plugin: { action: pluginAction, version: cleanText(plugin.version), problems: stringsOf(plugin.problems) },
		lock: { held: lock.held === true, pid: Number.isInteger(lock.pid) && lock.pid > 0 ? lock.pid : null },
		secrets: {
			copied: stringsOf(secrets.copied),
			keptExisting: stringsOf(secrets.keptExisting),
			conflicts: recordsOf(secrets.conflicts, (item) => (typeof item.key === 'string' && typeof item.used === 'string' ? { key: item.key, used: item.used, others: stringsOf(item.others) } : null)),
			skipped: recordsOf(secrets.skipped, (item) => (typeof item.key === 'string' && typeof item.reason === 'string' ? { key: item.key, reason: item.reason } : null)),
			error: cleanText(secrets.error),
		},
		contexts: {
			copied: countOf(contexts.copied),
			alreadyPresent: countOf(contexts.alreadyPresent),
			keptExisting: stringsOf(contexts.keptExisting),
			orgSkipped: stringsOf(contexts.orgSkipped),
			duplicates: recordsOf(contexts.duplicates, (item) => (typeof item.rel === 'string' && (item.used === 'claude' || item.used === 'cursor') ? { rel: item.rel, used: item.used } : null)),
			symlinks: stringsOf(contexts.symlinks),
			errors: recordsOf(contexts.errors, (item) => (typeof item.rel === 'string' && typeof item.code === 'string' ? { rel: item.rel, code: item.code } : null)),
		},
		next: installedNow || pluginAction === 'present' ? nextLines(given.editor, installedNow) : [],
	};
}

function jsonReport(report) {
	return normalizeReport('jsonReport', report);
}

function lockHeldLine(pid) {
	const run = 'Another migration or cleanup is running';
	if (pid !== null) return `${run} (lock ${LOCK_PATH}, pid ${pid}). Nothing was copied; run this script again.`;
	return `${run} (lock ${LOCK_PATH}). Nothing was copied; run this script again. If no other run is active, delete ${LOCK_PATH} and ${LOCK_PATH}.takeover, then run it again.`;
}

function secretsLines(secrets) {
	const names = (list) => list.map(displayText).join(', ');
	const lines = [];
	if (secrets.copied.length > 0) lines.push(`MCP keys copied to ~/.make-custom-app-skill-secrets: ${names(secrets.copied)}`);
	if (secrets.keptExisting.length > 0) lines.push(`MCP keys kept (the secrets file already had a value): ${names(secrets.keptExisting)}`);
	for (const conflict of secrets.conflicts.filter((item) => item.used !== 'secrets-file')) {
		lines.push(`MCP keys with different values in the old install (the first source was used): ${displayText(conflict.key)} (${displayText(conflict.used)}; also ${names(conflict.others)})`);
	}
	for (const conflict of secrets.conflicts.filter((item) => item.used === 'secrets-file')) {
		lines.push(`MCP keys that differ from the old install (the value in the secrets file is used, so the plugin uses another value than the old registration): ${displayText(conflict.key)} (${names(conflict.others)})`);
	}
	if (secrets.error !== null) lines.push(`MCP keys: not copied completely (${secrets.error})`);
	else if (lines.length === 0) lines.push('MCP keys: none found in the old install');
	return lines;
}

function contextsLines(contexts) {
	const notes = [
		...contexts.orgSkipped.map((dir) => `  skipped ${displayText(dir.endsWith('/') ? dir : `${dir}/`)} (written by the org downloader; its data can be partial)`),
		...contexts.duplicates.map((item) => `  both editors had ${displayText(item.rel)}: used the ${item.used === 'claude' ? 'Claude Code' : 'Cursor'} copy (newer)`),
		...contexts.keptExisting.map((rel) => `  kept ${displayText(rel)} (the target already has a different file)`),
		...contexts.symlinks.map((rel) => `  skipped ${displayText(rel)} (a symbolic link)`),
		...contexts.errors.map((item) => `  failed ${displayText(item.rel)} (${displayText(item.code)})`),
	];
	const more = notes.length > 0 ? `; ${notes.length} notes below` : '';
	return [`App contexts copied to ~/.make-custom-app/contexts: ${contexts.copied} files${more}`, ...notes];
}

function summaryLines(report) {
	const r = normalizeReport('summaryLines', report);
	const state = Object.hasOwn(PLUGIN_STATE_TEXT, r.plugin.action) ? PLUGIN_STATE_TEXT[r.plugin.action] : null;
	const lines = [];
	if (state !== null) lines.push(`Plugin ${PLUGIN_ID}: ${state}${r.plugin.version === null ? '' : `, version ${r.plugin.version}`}`);
	if (r.marketplace.action === 'present') {
		lines.push(`Marketplace ${MARKETPLACE_NAME} was already there${r.marketplace.source === null ? '' : ` (${displayText(r.marketplace.source)})`}; it was kept.`);
	}
	if (r.lock.held) lines.push(lockHeldLine(r.lock.pid));
	else if (state !== null) lines.push(...secretsLines(r.secrets), ...contextsLines(r.contexts));
	if (state !== null) lines.push(NOTHING_DELETED);
	if (r.plugin.action === 'disabled') lines.push(`The plugin is installed but disabled; this script does not enable it. To use it, run in your own terminal: ${ENABLE_COMMAND}`);
	lines.push(...r.next);
	return lines;
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
	ENV_TO_KEY,
	LOCK_STALE_MS,
	parseArgs,
	childEnv,
	spawnSpec,
	describeError,
	parseJsonc,
	parseMarketplaceList,
	usableValue,
	parseEnvText,
	pointsIntoOldSkill,
	isOldRegistration,
	secretsValue,
	readSecretSources,
	planSecrets,
	acquireMigrationLock,
	classifyContextName,
	isOrgDownload,
	listContextFiles,
	sameContent,
	planContexts,
	applyContextCopies,
	verifyInstall,
	nextLines,
	summaryLines,
	jsonReport,
};
