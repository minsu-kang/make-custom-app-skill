/**
 * legacy-cleanup-steps.js: the file and process steps of the old-install cleanup (phase B).
 *
 * Role: gatherFacts reads the real file system into the facts that buildPlan (./legacy-cleanup-logic) judges, locateClaude
 * finds and checks the `claude` binary, pluginGuard says whether the cleanup may run, acquireLock keeps two runs apart,
 * and readDecline and writeDecline keep the answer "keep the old install". preflightApply refuses a run that may not
 * start, and applySteps is the only code that moves or deletes a user file: it rereads every file or folder right before
 * it acts, rebuilds the plan item from what it read, and acts only when the item is still the one the user confirmed.
 * It records each step in a manifest before the change, never writes ~/.claude.json (`claude mcp remove` does), and never
 * shows a value of a file: every error text goes through describeError or is one of the fixed texts below.
 * Every function that reads or writes under a home, temp, or lock folder, or starts a process, takes those folders (and
 * `env`) as required parameters and throws a TypeError without them, so a test or a script can never reach a real home by
 * default. Only the entry scripts pass `process.env` and `os.homedir()`. Loading this module has no side effect.
 */
const nodeFs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { PLUGIN_ROOT, resolveEditor, getEditorFlag } = require('./paths');
const { parseJsonc } = require('./settings');
const { oldInstallPaths, isLookalikeSkillDir, ownRootsOf, dropOwnParts } = require('./legacy-install');
const {
	SCHEMA,
	DIGEST_PATTERN,
	ENV_TO_KEY,
	secretsValue,
	secretSources,
	compareSecrets,
	buildPlan,
	backupFolderName,
	canonicalJson,
	sha256,
	describeError,
	findSentinelBlock,
	removeBlock,
	parseEnvTemplate,
	redactEntry,
	redactOutput,
	removeJsonMember,
} = require('./legacy-cleanup-logic');
const { upsertSecretsFile } = require('./secrets-file');

const PLUGIN_ID = 'make-custom-app@make-custom-app';
const PLUGIN_NAME = 'make-custom-app';
const STATE_DIR = '.make-custom-app';
const LOCK_FILE = 'cleanup.lock';
const DECLINE_FILE = 'legacy-cleanup.json';
const CLAUDE_VERSION_PATTERN = /\(Claude Code\)/;
const VERSION_TIMEOUT_MS = 10000;
const VERSION_LINE_LIMIT = 200;
const LOCK_STALE_MS = 600000;
const LOCK_PARTIAL_MS = 5000;
const REGISTRATION_ATTEMPTS = 3;
const REGISTRATION_RETRY_MS = 100;
const PLUGIN_ATTEMPTS = 2;
const PLUGIN_RETRY_MS = 50;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_FRONT_MATTER_BYTES = 256 * 1024;
const MAX_MARKER_BYTES = 1024;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const BOM = /^\uFEFF/;
const FOLDER_PARAMS = new Set(['home', 'dir']);

function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function sleepMs(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveNow(now) {
	if (typeof now === 'function') return now();
	return now === undefined ? Date.now() : now;
}

function isMissingFile(err) {
	return Boolean(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

/** The environment of a child: the given one with HOME and USERPROFILE set to `home` and without CLAUDECODE (Ruling 15). */
function childEnv(params) {
	requireParams('childEnv', params, ['env', 'home']);
	const { env, home } = params;
	const out = { ...env, HOME: home, USERPROFILE: home };
	delete out.CLAUDECODE;
	return out;
}

const CMD_UNSAFE_ARGUMENT = /[\s"&|<>^%]/;
const CMD_UNSAFE_PATH = /["%]/;

/**
 * The call for child_process.spawnSync: `{ command, args, options }`. A `.cmd` on Windows runs as
 * `cmd.exe /d /s /c ""<bin>" <args>"` with windowsVerbatimArguments (cmd.exe strips the outer quote pair), so an argument
 * with a space or one of `"&|<>^%` and a path with `%` or a quote are refused with a TypeError that names neither.
 */
function spawnSpec(params) {
	requireParams('spawnSpec', params, ['env', 'home', 'platform']);
	const { bin, args = [], platform, env, home, timeoutMs } = params;
	const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv({ env, home }), cwd: home, timeout: timeoutMs, windowsHide: true };
	if (platform === 'win32' && /\.cmd$/i.test(bin)) {
		if (CMD_UNSAFE_PATH.test(bin)) throw new TypeError('spawnSpec: the path of claude.cmd holds a character that cmd.exe would read as syntax');
		if (args.some((arg) => CMD_UNSAFE_ARGUMENT.test(arg))) throw new TypeError('spawnSpec: an argument for claude.cmd holds a character that cmd.exe would read as syntax');
		return { command: 'cmd.exe', args: ['/d', '/s', '/c', `""${bin}" ${args.join(' ')}"`], options: { ...options, windowsVerbatimArguments: true } };
	}
	return { command: bin, args, options };
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

/**
 * Where `claude` may be, in the order of Ruling 15: `CLAUDE_BIN` alone when it is set (`explicit` is then true), else the
 * folders of PATH (`claude`; on Windows `claude.exe` then `claude.cmd`), then `<home>/.local/bin/claude`,
 * `<home>/.claude/local/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude` (Windows: `<home>\.local\bin\claude.exe`,
 * `<APPDATA>\npm\claude.cmd`). A relative path is never a candidate: the child runs in the home folder, so a relative
 * path would name another file than the one that was checked. Nothing is run or checked here.
 */
function claudeCandidates(params) {
	requireParams('claudeCandidates', params, ['env', 'home']);
	const { env, home, platform = process.platform } = params;
	const win = platform === 'win32';
	const p = pathFor(platform);
	if (typeof env.CLAUDE_BIN === 'string' && env.CLAUDE_BIN !== '') return { explicit: true, candidates: p.isAbsolute(env.CLAUDE_BIN) ? [env.CLAUDE_BIN] : [] };
	const names = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
	const dirs = String(pathVariable(env, platform) || '')
		.split(win ? ';' : ':')
		.map((dir) => (win ? dir.replace(/^"(.*)"$/, '$1') : dir))
		.filter((dir) => dir !== '' && p.isAbsolute(dir));
	const candidates = dirs.flatMap((dir) => names.map((name) => p.join(dir, name)));
	if (win) {
		candidates.push(p.join(home, '.local', 'bin', 'claude.exe'));
		if (typeof env.APPDATA === 'string' && env.APPDATA !== '') candidates.push(p.join(env.APPDATA, 'npm', 'claude.cmd'));
	} else {
		candidates.push(p.join(home, '.local', 'bin', 'claude'), p.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude');
	}
	return { explicit: false, candidates };
}

/** The first line of `claude --version` when the binary is Claude Code, else null. Any failure of the call is a null. */
function claudeVersion({ bin, env, home, platform, spawn }) {
	try {
		const spec = spawnSpec({ bin, args: ['--version'], platform, env, home, timeoutMs: VERSION_TIMEOUT_MS });
		const result = spawn(spec.command, spec.args, { ...spec.options, killSignal: 'SIGKILL' });
		if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
		const line = result.stdout.split(/\r?\n/, 1)[0].trim();
		if (line.length > VERSION_LINE_LIMIT || !CLAUDE_VERSION_PATTERN.test(line)) return null;
		return line.replace(CONTROL_CHARACTERS, '?');
	} catch {
		return null;
	}
}

/**
 * Finds the `claude` binary and checks that it is Claude Code: each candidate (claudeCandidates) that is an executable file
 * runs `--version` (10 s) through spawnSpec with childEnv and the home as cwd, and counts only when the first line holds
 * `(Claude Code)`. With `CLAUDE_BIN` set nothing else is tried. Returns `{ binary, version, explicit }`, with `binary` and
 * `version` null when nothing fits. Never looks at a shell alias. `isExecutable` and `spawnSync` are injected by tests, so
 * no real `claude` of the host runs there.
 */
function locateClaude(params) {
	requireParams('locateClaude', params, ['env', 'home']);
	const { env, home, platform = process.platform, isExecutable = defaultIsExecutable, spawnSync = childProcess.spawnSync } = params;
	const { explicit, candidates } = claudeCandidates({ env, home, platform });
	for (const bin of candidates) {
		if (!isExecutable(bin)) continue;
		const version = claudeVersion({ bin, env, home, platform, spawn: spawnSync });
		if (version !== null) return { binary: bin, version, explicit };
	}
	return { binary: null, version: null, explicit };
}

// ---------------------------------------------------------------------------------------------------------------
// The facts
// ---------------------------------------------------------------------------------------------------------------

/**
 * `{ state: 'ok', buffer, mode }`, or `missing` (no such file), `unusable` (not a regular file), `toolarge` (a regular file
 * above `limit`, with its `mode`, not read), or `error`. A caller turns `toolarge` into a fact of its own, never into
 * "nothing there".
 */
function readFileRecord(fs, file, limit = MAX_READ_BYTES) {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) return { state: 'unusable' };
		if (stat.size > limit) return { state: 'toolarge', mode: stat.mode & 0o777 };
		return { state: 'ok', buffer: fs.readFileSync(file), mode: stat.mode & 0o777 };
	} catch (err) {
		return { state: isMissingFile(err) ? 'missing' : 'error' };
	}
}

/** The text of a buffer, and whether encoding the text gives the same bytes. A byte order mark and CRLF survive; an invalid byte does not. */
function decode(buffer) {
	const text = buffer.toString('utf8');
	return { text, utf8Exact: Buffer.from(text, 'utf8').equals(buffer) };
}

/**
 * Reads a file and parses its text, again up to `attempts` times, `retryMs` apart, while it does not read or parse (a
 * writer may be in the middle of its write). A missing file, one that is no regular file, or one above `limit` ends at
 * once. The registration files are read with no limit (`Infinity`), as `detectLegacyInstall` and Claude Code read them,
 * so a big `~/.claude.json` never turns into "no registration". Returns null when nothing parsed, else
 * `{ text, mode, utf8Exact, value }`. The parser's error is dropped, so no text of the file leaves this function.
 */
function readParsed({ fs, file, parse, attempts, retryMs, sleep, limit = MAX_READ_BYTES }) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (attempt > 0) sleep(retryMs);
		const read = readFileRecord(fs, file, limit);
		if (read.state === 'missing' || read.state === 'unusable' || read.state === 'toolarge') return null;
		if (read.state === 'error') continue;
		const { text, utf8Exact } = decode(read.buffer);
		try {
			return { text, mode: read.mode, utf8Exact, value: parse(text) };
		} catch {
			// a torn or malformed text: read it again
		}
	}
	return null;
}

function parseJsonText(text) {
	return JSON.parse(text.replace(BOM, ''));
}

/** Plain JSON gives `format` json; text that only the comment-tolerant parser reads (comments, trailing commas, a byte order mark) gives jsonc. */
function parseCursorText(text) {
	try {
		return { format: 'json', value: JSON.parse(text) };
	} catch {
		return { format: 'jsonc', value: parseJsonc(text.replace(BOM, '')) };
	}
}

/** Walks a folder without following links: the sorted top names, and the number and size of every entry that is not a folder. Null when the folder cannot be listed. */
function walkFolder(fs, root) {
	let top;
	try {
		top = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	const walked = { topNames: top.map((entry) => entry.name).sort(), fileCount: 0, sizeBytes: 0 };
	const pending = [];
	const visit = (dir, entries) => {
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				pending.push(full);
				continue;
			}
			walked.fileCount += 1;
			try {
				walked.sizeBytes += fs.lstatSync(full).size;
			} catch {
				// a file that vanished while walking only lowers the size
			}
		}
	};
	visit(root, top);
	while (pending.length > 0) {
		const dir = pending.pop();
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		visit(dir, entries);
	}
	return walked;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

function frontMatterValue(raw, pattern) {
	const value = raw.trim().replace(/^(["'])(.*)\1$/, '$2');
	return pattern.test(value) ? value : null;
}

/** The `name` and `version` of the front matter of a SKILL.md, or null for each that is missing or is not a short plain word (a value is shown in the plan). */
function readFrontMatter(fs, file) {
	const none = { name: null, version: null };
	const read = readFileRecord(fs, file, MAX_FRONT_MATTER_BYTES);
	if (read.state !== 'ok') return none;
	const lines = decode(read.buffer).text.replace(BOM, '').split(/\r?\n/);
	if (lines[0].trim() !== '---') return none;
	const found = { name: undefined, version: undefined };
	for (const line of lines.slice(1)) {
		if (line.trim() === '---') break;
		const match = /^(name|version):(.*)$/.exec(line);
		if (match && found[match[1]] === undefined) found[match[1]] = frontMatterValue(match[2], match[1] === 'name' ? NAME_PATTERN : VERSION_PATTERN);
	}
	return { name: found.name ?? null, version: found.version ?? null };
}

function isDirectoryPath(fs, file) {
	try {
		return fs.statSync(file).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Where a link names, as an absolute path: a relative target is resolved against the real path of the folder that holds
 * the link, as the system does (the logical parent may be a link itself). Null when it cannot be read.
 */
function linkTargetOf(fs, dir) {
	try {
		return path.resolve(fs.realpathSync(path.dirname(dir)), fs.readlinkSync(dir));
	} catch {
		return null;
	}
}

/**
 * The facts of an old skill folder (`DirFacts` of the plan), or null when it is not there, is no folder, or cannot be
 * listed. A symbolic link to a folder records `linkTarget` as an absolute path and is not walked or read.
 */
function skillFolderFacts(fs, dir) {
	let stat;
	try {
		stat = fs.lstatSync(dir);
	} catch {
		return null;
	}
	if (stat.isSymbolicLink()) {
		const linkTarget = linkTargetOf(fs, dir);
		if (!isDirectoryPath(fs, dir) || linkTarget === null) return null;
		return { path: dir, symlink: true, linkTarget, skillName: null, version: null, topNames: [], fileCount: 0, sizeBytes: 0 };
	}
	if (!stat.isDirectory()) return null;
	const walked = walkFolder(fs, dir);
	if (walked === null) return null;
	const { name, version } = readFrontMatter(fs, path.join(dir, 'SKILL.md'));
	return { path: dir, symlink: false, linkTarget: null, skillName: name, version, ...walked };
}

/** The facts of the Cursor rules folder, or null. A link to a folder lists its top names, records `symlink` and `linkTarget`, and is not walked. */
function rulesFolderFacts(fs, dir) {
	let stat;
	try {
		stat = fs.lstatSync(dir);
	} catch {
		return null;
	}
	if (stat.isSymbolicLink()) {
		const linkTarget = linkTargetOf(fs, dir);
		if (!isDirectoryPath(fs, dir) || linkTarget === null) return null;
		let names = [];
		try {
			names = fs.readdirSync(dir).sort();
		} catch {
			// a link whose folder cannot be listed has no names to show
		}
		return { path: dir, names, fileCount: 0, sizeBytes: 0, symlink: true, linkTarget };
	}
	if (!stat.isDirectory()) return null;
	const walked = walkFolder(fs, dir);
	return walked === null ? null : { path: dir, names: walked.topNames, fileCount: walked.fileCount, sizeBytes: walked.sizeBytes, symlink: false, linkTarget: null };
}

function realPathInside(fs, child, parent) {
	try {
		const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(child));
		return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	} catch {
		return false;
	}
}

/**
 * The `.env` of a skill folder, as read: text, mode, whether its bytes survive UTF-8, and whether its real path lies
 * inside the real path of the folder. One above the read cap is not read: it has no text, `utf8Exact` false, and
 * `tooLarge` true, so the plan keeps it in the backup and never deletes it.
 */
function envFacts(fs, envFile, skillDir) {
	const read = readFileRecord(fs, envFile);
	if (read.state !== 'ok' && read.state !== 'toolarge') return null;
	const insideSkill = realPathInside(fs, envFile, skillDir);
	if (read.state === 'toolarge') return { path: envFile, text: '', mode: read.mode, utf8Exact: false, insideSkill, tooLarge: true };
	const { text, utf8Exact } = decode(read.buffer);
	return { path: envFile, text, mode: read.mode, utf8Exact, insideSkill };
}

/** CLAUDE.md as read; one above the read cap is `{ file, tooLarge: true }`, which the plan turns into a manual item. */
function claudeMdFacts(fs, file) {
	const read = readFileRecord(fs, file);
	if (read.state === 'toolarge') return { file, tooLarge: true };
	if (read.state !== 'ok') return null;
	let realPath;
	try {
		realPath = fs.realpathSync(file);
	} catch {
		return null;
	}
	const { text, utf8Exact } = decode(read.buffer);
	return { file, realPath, text, mode: read.mode, utf8Exact };
}

function entryFacts(entry, ownRoots) {
	return { entry, withoutOwn: dropOwnParts(entry, ownRoots) };
}

function claudeEntryFacts({ fs, file, ownRoots, sleep }) {
	const read = readParsed({ fs, file, parse: parseJsonText, attempts: REGISTRATION_ATTEMPTS, retryMs: REGISTRATION_RETRY_MS, sleep, limit: Infinity });
	if (read === null || !isPlainObject(read.value) || !isPlainObject(read.value.mcpServers) || !Object.hasOwn(read.value.mcpServers, PLUGIN_NAME)) return null;
	return { file, ...entryFacts(read.value.mcpServers[PLUGIN_NAME], ownRoots) };
}

function cursorMembersFacts({ fs, file, ownRoots, sleep }) {
	const read = readParsed({ fs, file, parse: parseCursorText, attempts: REGISTRATION_ATTEMPTS, retryMs: REGISTRATION_RETRY_MS, sleep, limit: Infinity });
	if (read === null) return null;
	const { format, value } = read.value;
	const servers = isPlainObject(value) && isPlainObject(value.mcpServers) ? value.mcpServers : {};
	const members = Object.entries(servers).map(([key, entry]) => ({ key, ...entryFacts(entry, ownRoots) }));
	return { file, format, text: read.text, utf8Exact: read.utf8Exact, members };
}

function isOurPluginId(id) {
	return id.split('@').includes(PLUGIN_NAME);
}

function entryList(value) {
	if (Array.isArray(value)) return value.filter(isPlainObject);
	return isPlainObject(value) ? [value] : [];
}

/** The records of this plugin in installed_plugins.json: `{ id, scope, installPath, version }`. A missing scope counts as `user`. */
function pluginRecords(installed) {
	const map = isPlainObject(installed.plugins) ? installed.plugins : installed;
	const records = [];
	for (const [id, value] of Object.entries(map)) {
		if (!isOurPluginId(id)) continue;
		for (const entry of entryList(value)) {
			records.push({
				id,
				scope: typeof entry.scope === 'string' && entry.scope !== '' ? entry.scope : 'user',
				installPath: typeof entry.installPath === 'string' ? entry.installPath : null,
				version: typeof entry.version === 'string' ? entry.version : null,
			});
		}
	}
	return records;
}

function hasManifest(fs, installPath) {
	try {
		return fs.statSync(path.join(installPath, '.claude-plugin', 'plugin.json')).isFile();
	} catch {
		return false;
	}
}

function sameRealPath(fs, a, b) {
	if (typeof a !== 'string' || typeof b !== 'string') return false;
	try {
		return fs.realpathSync(a) === fs.realpathSync(b);
	} catch {
		return false;
	}
}

/**
 * Whether the plugin is installed for the user, enabled, and the one that runs (the rules of the migration prompt): a
 * record for this plugin in `<configDir>/plugins/installed_plugins.json` (`recorded`), one with scope `user` or `managed`
 * (`userScope`; the first with a manifest in its folder, else the first), `enabledPlugins[id] !== false` in
 * `<configDir>/settings.json` (`enabled`; a missing or unreadable file counts as enabled), and `installPath` having the
 * same real path as `pluginRoot` (`runningFromInstall`).
 */
function pluginFacts({ fs, configDir, pluginRoot, sleep }) {
	const none = { recorded: false, userScope: false, enabled: false, installPath: null, version: null, runningFromInstall: false };
	const read = (file) => readParsed({ fs, file, parse: parseJsonText, attempts: PLUGIN_ATTEMPTS, retryMs: PLUGIN_RETRY_MS, sleep });
	const installed = read(path.join(configDir, 'plugins', 'installed_plugins.json'));
	if (installed === null || !isPlainObject(installed.value)) return none;
	const records = pluginRecords(installed.value);
	if (records.length === 0) return none;
	const own = records.filter((record) => record.scope === 'user' || record.scope === 'managed');
	if (own.length === 0) return { ...none, recorded: true };
	const chosen = own.find((record) => record.installPath !== null && hasManifest(fs, record.installPath)) ?? own[0];
	const settings = read(path.join(configDir, 'settings.json'));
	const flags = settings !== null && isPlainObject(settings.value) && isPlainObject(settings.value.enabledPlugins) ? settings.value.enabledPlugins : {};
	return {
		recorded: true,
		userScope: true,
		enabled: flags[chosen.id] !== false,
		installPath: chosen.installPath,
		version: chosen.version,
		runningFromInstall: sameRealPath(fs, pluginRoot, chosen.installPath),
	};
}

function secretsFileText(fs, file) {
	const read = readFileRecord(fs, file, Infinity);
	return read.state === 'ok' ? read.buffer.toString('utf8') : null;
}

/** The old folders that are a plugin or hold the running plugin, and the folders whose files are never the old skill's. */
function ownRootsFor(paths, pluginRoot) {
	const lookalikes = [paths.claudeSkill, paths.cursorSkill, paths.cursorRules].filter((dir) => isLookalikeSkillDir(dir, pluginRoot));
	return { lookalikes, ownRoots: ownRootsOf(pluginRoot, lookalikes) };
}

/**
 * Reads the old install into the facts that buildPlan judges (see the `Facts` comment of ./legacy-cleanup-logic): paths only
 * from oldInstallPaths(home), skill folders (a lookalike of the plugin is null with its `.env`), the Cursor rules folder,
 * the `.env` files, the Claude entry and the Cursor members with `withoutOwn` (the plugin's own parts dropped), CLAUDE.md,
 * the secrets file of the given home, the plugin state, and the `claude` binary when `locate` is true (`isExecutable` and
 * `spawnSync` reach locateClaude). Files whose bytes the cleanup may rewrite or delete are read as Buffers and carry
 * `utf8Exact`. It only reads; a file that cannot be read gives null (nothing is planned from it), and no error text or
 * parser message is kept. The lookalike check and the own-part drop of ./legacy-install use the real file system, so
 * `fs` is for tests that fail a read.
 */
function gatherFacts(params) {
	requireParams('gatherFacts', params, ['env', 'home']);
	const { env, home, fs = nodeFs, spawnSync = childProcess.spawnSync, platform = process.platform, locate = true, sleep = sleepMs, isExecutable } = params;
	const pluginRoot = params.pluginRoot === undefined ? PLUGIN_ROOT : params.pluginRoot;
	if (typeof pluginRoot !== 'string' || pluginRoot === '') throw new TypeError('gatherFacts needs pluginRoot');
	const paths = oldInstallPaths(home);
	const configDir = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude');
	const secretsText = secretsFileText(fs, path.join(home, '.make-custom-app-skill-secrets'));
	let editor = null;
	try {
		editor = resolveEditor({ env, configured: secretsValue(secretsText, 'editor'), flag: getEditorFlag() });
	} catch {
		editor = null;
	}

	const { lookalikes, ownRoots } = ownRootsFor(paths, pluginRoot);
	const skill = (dir) => (lookalikes.includes(dir) ? null : skillFolderFacts(fs, dir));
	const claudeSkill = skill(paths.claudeSkill);
	const cursorSkill = skill(paths.cursorSkill);
	const cursorRules = lookalikes.includes(paths.cursorRules) ? null : rulesFolderFacts(fs, paths.cursorRules);
	const located = locate ? locateClaude({ env, home, platform, isExecutable, spawnSync }) : null;

	return {
		home,
		configDir,
		configDirIsDefault: !(typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR !== ''),
		editor,
		pluginRoot,
		plugin: pluginFacts({ fs, configDir, pluginRoot, sleep }),
		claude: { binary: located === null ? null : located.binary },
		claudeSkill,
		cursorSkill,
		cursorRules,
		claudeEnv: claudeSkill === null ? null : envFacts(fs, paths.claudeEnv, paths.claudeSkill),
		cursorEnv: cursorSkill === null ? null : envFacts(fs, paths.cursorEnv, paths.cursorSkill),
		claudeEntry: claudeEntryFacts({ fs, file: paths.claudeJson, ownRoots, sleep }),
		cursorMembers: cursorMembersFacts({ fs, file: paths.cursorMcp, ownRoots, sleep }),
		claudeMd: claudeMdFacts(fs, paths.claudeMd),
		secretsText,
		contextsDirs: [paths.claudeContexts, paths.cursorContexts].filter((dir) => isDirectoryPath(fs, dir)),
	};
}

function shownPath(value) {
	return typeof value === 'string' && value !== '' ? value.replace(CONTROL_CHARACTERS, '?') : 'unknown';
}

/**
 * Why the cleanup may not run in this session, as `{ reason, fix }`, or null when it may. Checked in this order: the
 * plugin is not installed for the user, it is disabled, this script does not run from the installed copy. A value that is
 * not `true` is a refusal. The paths in the last reason come from a file, so control characters show as `?`.
 */
function pluginGuard(facts) {
	if (!isPlainObject(facts)) throw new TypeError('pluginGuard needs facts');
	const plugin = isPlainObject(facts.plugin) ? facts.plugin : {};
	if (plugin.recorded !== true || plugin.userScope !== true) {
		return { reason: 'The make-custom-app plugin is not installed for your user account.', fix: `claude plugin install ${PLUGIN_ID}` };
	}
	if (plugin.enabled !== true) return { reason: 'The make-custom-app plugin is installed but disabled.', fix: `claude plugin enable ${PLUGIN_ID}` };
	if (plugin.runningFromInstall !== true) {
		return {
			reason: `This script does not run from the installed plugin (${shownPath(facts.pluginRoot)}; installed at ${shownPath(plugin.installPath)}).`,
			fix: 'Run the copy in the installed plugin.',
		};
	}
	return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The lock (the same file, format, and rules as acquireMigrationLock of the old tree, with a folder parameter)
// ---------------------------------------------------------------------------------------------------------------

function defaultIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return !(err && err.code === 'ESRCH');
	}
}

function parseLock(text) {
	try {
		const lock = JSON.parse(text.replace(BOM, ''));
		return isPlainObject(lock) && Number.isInteger(lock.pid) && lock.pid > 0 && Number.isFinite(lock.at) ? { pid: lock.pid, at: lock.at } : null;
	} catch {
		return null;
	}
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

/**
 * Takes `<dir>/cleanup.lock` (`{"pid":<pid>,"at":<ms>}`, created with flag `wx`, mode 0600; `dir` is created with mode
 * 0700), and returns `{ ok: true, release() }` or `{ ok: false, pid }` (`pid` is null when the holder is unknown). A lock
 * is stale when its pid is gone, its time is later than the clock (read again after the lock was read), or it is more than
 * LOCK_STALE_MS old; content that is not a pid and a time is stale only when the file is more than 5 s away from the clock
 * in either direction, so a file that a run has created but not yet written is not taken. A stale lock is replaced under
 * `<lock>.takeover` (created with `wx` by one run only and removed by that run): a takeover file left behind, a lock that
 * cannot be read, and a lock whose text changed meanwhile all give held and are not touched. `release()` removes the lock
 * only while it still holds our content. The protocol narrows the races of concurrent runs; it does not close them.
 */
function acquireLock(params) {
	requireParams('acquireLock', params, ['dir']);
	const { dir, fs = nodeFs, pid = process.pid, isAlive = defaultIsAlive } = params;
	const clock = () => resolveNow(params.now);
	const file = path.join(dir, LOCK_FILE);
	const takeoverFile = `${file}.takeover`;
	const content = JSON.stringify({ pid, at: clock() });
	const heldBy = (read) => ({ ok: false, pid: read.holder ? read.holder.pid : null });
	const acquired = () => ({
		ok: true,
		release() {
			try {
				if (fs.readFileSync(file, 'utf8') === content) fs.unlinkSync(file);
			} catch {
				// the lock is gone or no longer ours
			}
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
			} catch {
				// it was ours to remove, and it is gone
			}
		}
	};

	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (createExclusive(fs, file, content)) return acquired();
	const seen = readLockFile(fs, file);
	if (seen.missing) return createExclusive(fs, file, content) ? acquired() : heldBy(readLockFile(fs, file));
	if (seen.unreadable || !isStale(seen)) return heldBy(seen);
	return takeOver(seen.text);
}

// ---------------------------------------------------------------------------------------------------------------
// The decline marker (Ruling 3)
// ---------------------------------------------------------------------------------------------------------------

function declineFile(home) {
	return path.join(home, STATE_DIR, DECLINE_FILE);
}

/**
 * `{ declinedAt, digest }` (milliseconds, 16 lowercase hex characters) of `<home>/.make-custom-app/legacy-cleanup.json`, or
 * null when the file is missing, is not a small regular file, or does not hold `schema` 1, an ISO 8601 UTC `declinedAt`,
 * and a digest. A marker that is doubtful is no marker: the old install is then offered again.
 */
function readDecline(params) {
	requireParams('readDecline', params, ['home']);
	const { home, fs = nodeFs } = params;
	try {
		const file = declineFile(home);
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) return null;
		const marker = JSON.parse(fs.readFileSync(file, 'utf8').replace(BOM, ''));
		if (!isPlainObject(marker) || marker.schema !== SCHEMA) return null;
		if (typeof marker.declinedAt !== 'string' || !ISO_UTC.test(marker.declinedAt) || typeof marker.digest !== 'string' || !DIGEST_PATTERN.test(marker.digest)) return null;
		const declinedAt = Date.parse(marker.declinedAt);
		return Number.isFinite(declinedAt) ? { declinedAt, digest: marker.digest } : null;
	} catch {
		return null;
	}
}

/**
 * Writes `{"schema":1,"declinedAt":"<ISO 8601 UTC>","digest":"<16 hex>"}` to `<home>/.make-custom-app/legacy-cleanup.json`
 * through `<file>.<pid>.tmp` (flag `wx`, mode 0600) and a rename; the folder is created with mode 0700. Returns what it
 * wrote, as readDecline gives it. A file system error is thrown after the temp file is removed.
 */
function writeDecline(params) {
	requireParams('writeDecline', params, ['home']);
	const { home, fs = nodeFs, digest, pid = process.pid } = params;
	if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) throw new TypeError('writeDecline needs a digest of 16 lowercase hexadecimal characters');
	const at = resolveNow(params.now);
	if (typeof at !== 'number' || !Number.isFinite(at)) throw new TypeError('writeDecline needs now to be a time in milliseconds');
	const declinedAt = new Date(at).toISOString();
	const file = declineFile(home);
	const temp = `${file}.${pid}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	try {
		fs.writeFileSync(temp, JSON.stringify({ schema: SCHEMA, declinedAt, digest }), { flag: 'wx', mode: 0o600 });
		fs.renameSync(temp, file);
	} catch (err) {
		if (!err || err.code !== 'EEXIST') {
			try {
				fs.unlinkSync(temp);
			} catch {
				// no temp file to remove
			}
		}
		throw err;
	}
	return { declinedAt: Date.parse(declinedAt), digest };
}

// ---------------------------------------------------------------------------------------------------------------
// preflightApply and applySteps
// ---------------------------------------------------------------------------------------------------------------

const CLAUDE_KEY = 'make-custom-app';
const CURSOR_PREFIX = 'cursor.mcp-entry.';
const RULES_ID = 'cursor.rules-dir';
const GROUP_IDS = ['claude', 'cursor'];
const MANIFEST_FILE = 'manifest.json';
const REMOVE_TIMEOUT_MS = 30000;
const REMOVE_ATTEMPTS = 3;
const REREAD_ATTEMPTS = 3;
const REREAD_MS = 500;
const CURSOR_ATTEMPTS = 3;
const RENAME_RETRIES = 3;
const RENAME_RETRY_MS = 500;
const STDERR_LINE_LIMIT = 200;
const PLUGIN_KEYS = Object.values(ENV_TO_KEY);

const PLAN_ERROR = 'applySteps needs a plan of the items this version knows';
const RESTART_TEXT = 'the entry came back after removal; restart Claude Code, then run the cleanup again';
const NO_CLAUDE_TEXT = 'Claude Code was not found, so the old MCP registration cannot be removed.';
const ENV_CHANGED_TEXT = 'the .env changed since the plan';
const ENV_OUTSIDE_TEXT = 'the .env is not a regular file inside its old skill folder, so the cleanup does not touch it';
const DIR_CHANGED_TEXT = 'the old folder changed since the plan';
const DIR_PLUGIN_TEXT = 'the folder is a plugin or holds the running plugin, so the cleanup does not move it';
const BACKUP_TAKEN_TEXT = 'the backup folder already holds a folder of that name';
const COPY_MISMATCH_TEXT = 'the copy of the folder does not match the original, so nothing was removed';
const READ_BACK_TEXT = 'the secrets file did not read back';
const CURSOR_BUSY_TEXT = '~/.cursor/mcp.json kept changing; close Cursor, then run the cleanup again';
const PARTIAL_TEXT = 'Stopped after a failure. Run --plan to see what is left, or --restore to undo what was done.';

/** A failure with one of the fixed texts of the cleanup: its message is shown as it is. */
class StepFailure extends Error {}

/** The manifest could not be written: `cause` is the file system error, shown with the path of the manifest. */
class ManifestError extends Error {
	constructor(cause) {
		super('the manifest could not be written');
		this.cause = cause;
	}
}

function changedSince(label) {
	return new StepFailure(`${label} changed since the plan`);
}

/**
 * Why `--apply` may not start, as `{ exitCode, lines }`, or null when it may. Checked in this order (Ruling 39): nothing to
 * remove in the named groups (exit 0), a digest that is not the plan's (3), the plugin guard (2), a blocked item of a
 * named group (2). It reads only the plan and the facts it is given, and an item counts as ready only when it is `ready`.
 */
function preflightApply(params) {
	requireParams('preflightApply', params, ['digest', 'groups', 'plan', 'facts']);
	const { digest, groups, plan, facts } = params;
	if (!Array.isArray(groups) || !isPlainObject(plan) || !Array.isArray(plan.items)) throw new TypeError('preflightApply needs digest, groups, plan, and facts');
	const named = plan.items.filter((item) => groups.includes(item.group));
	if (!named.some((item) => item.status === 'ready')) return { exitCode: 0, lines: [`Nothing to remove in ${groups.join(' and ')}.`] };
	if (plan.digest !== digest) {
		return { exitCode: 3, lines: [`The old install changed since the plan (digest ${digest}, now ${plan.digest}). Nothing was changed. Run --plan again.`] };
	}
	const guard = pluginGuard(facts);
	if (guard !== null) return { exitCode: 2, lines: [`Refused: ${guard.reason} Nothing was changed. Fix: ${guard.fix}`] };
	const blocked = named.find((item) => item.status === 'blocked');
	if (blocked !== undefined) return { exitCode: 2, lines: [`Refused: ${blocked.id} is blocked: ${blocked.reason} Nothing was changed. Fix: ${blocked.fix}`] };
	return null;
}

function binaryOf(facts) {
	return isPlainObject(facts.claude) && typeof facts.claude.binary === 'string' && facts.claude.binary !== '' ? facts.claude.binary : null;
}

/** A path inside the home folder, with the home written as `~`. */
function shortHome(home, file) {
	return `~${path.sep}${path.relative(home, file)}`;
}

function realPathOrNull(fs, file) {
	try {
		return fs.realpathSync(file);
	} catch {
		return null;
	}
}

function pathExists(fs, file) {
	try {
		fs.lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

function serversOf(value) {
	return isPlainObject(value) && isPlainObject(value.mcpServers) ? value.mcpServers : {};
}

function secretsByKey(run) {
	const text = secretsFileText(run.fs, run.secretsFile);
	return Object.fromEntries(PLUGIN_KEYS.map((key) => [key, secretsValue(text, key)]));
}

/** Every value that may be a secret and that is in memory: the env of the registrations, the values of the sources, and the secrets file. */
function knownSecrets(run) {
	const values = new Set();
	const addEnv = (entry) => {
		if (!isPlainObject(entry) || !isPlainObject(entry.env)) return;
		for (const value of Object.values(entry.env)) if (typeof value === 'string') values.add(value);
	};
	if (isPlainObject(run.facts.claudeEntry)) addEnv(run.facts.claudeEntry.entry);
	if (isPlainObject(run.facts.cursorMembers) && Array.isArray(run.facts.cursorMembers.members)) for (const member of run.facts.cursorMembers.members) addEnv(member.entry);
	for (const source of run.sources) for (const value of Object.values(source.values)) values.add(value);
	for (const value of Object.values(secretsByKey(run))) if (value !== null) values.add(value);
	return [...values];
}

function writeManifest(run) {
	const temp = `${run.manifestFile}.tmp`;
	try {
		run.fs.writeFileSync(temp, `${JSON.stringify(run.manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
		run.fs.chmodSync(temp, 0o600);
		run.fs.renameSync(temp, run.manifestFile);
	} catch (err) {
		try {
			run.fs.unlinkSync(temp);
		} catch {
			// no temp file to remove
		}
		throw new ManifestError(err);
	}
}

/** Records the fields a restore needs and the state `running` in the manifest, before the step changes anything. */
function startStep(run, step, fields) {
	Object.assign(step, fields);
	step.state = 'running';
	writeManifest(run);
}

/**
 * True when the plan item `item` is still what the plan says, judged by buildPlan on the facts of the plan with `patch`
 * (what was just reread) in place of the old facts: it is `ready`, at the same path, with the same action and the same fingerprint.
 */
function recheck(run, item, patch, extra = () => true) {
	const fresh = buildPlan({ ...run.facts, ...patch }).items.find((candidate) => candidate.id === item.id);
	return fresh !== undefined && fresh.status === 'ready' && fresh.path === item.path && fresh.action === item.action && canonicalJson(fresh.fingerprint) === canonicalJson(item.fingerprint) && extra(fresh);
}

/** Writes `text` over `target` through a temp file in the same folder (flag `wx`, the old mode), unless the bytes of `target` are no longer `original`. Returns false then. */
function replaceFile(run, target, text, original, mode) {
	const temp = `${target}.${process.pid}.tmp`;
	let created = false;
	let renamed = false;
	try {
		run.fs.writeFileSync(temp, text, { flag: 'wx', mode });
		created = true;
		run.fs.chmodSync(temp, mode);
		const again = readFileRecord(run.fs, target, Infinity);
		if (again.state !== 'ok' || !again.buffer.equals(original)) return false;
		run.fs.renameSync(temp, target);
		renamed = true;
		return true;
	} finally {
		if (created && !renamed) {
			try {
				run.fs.unlinkSync(temp);
			} catch {
				// the temp file is gone already
			}
		}
	}
}

function notUtf8(file) {
	return new StepFailure(`${file} is not valid UTF-8, so the cleanup does not rewrite it`);
}

// The secrets step -------------------------------------------------------------------------------------------------

function secretsStep(run, step, item, flags) {
	const { updates } = compareSecrets(run.sources, secretsFileText(run.fs, run.secretsFile));
	const keys = Object.keys(updates);
	startStep(run, step, { keys });
	if (keys.length === 0) return;
	upsertSecretsFile(run.secretsFile, updates);
	flags.changed = true;
	run.manifest.secretsKeysAdded = keys;
	const after = secretsFileText(run.fs, run.secretsFile);
	if (!keys.every((key) => secretsValue(after, key) === updates[key])) throw new StepFailure(READ_BACK_TEXT);
}

// The Claude registration ------------------------------------------------------------------------------------------

function readClaudeJson(run, attempts) {
	return readParsed({ fs: run.fs, file: run.paths.claudeJson, parse: parseJsonText, attempts, retryMs: REGISTRATION_RETRY_MS, sleep: run.sleep, limit: Infinity });
}

function runClaude(run, args) {
	const spec = spawnSpec({ bin: run.claudeBin, args, platform: run.platform, env: run.env, home: run.home, timeoutMs: REMOVE_TIMEOUT_MS });
	return run.spawn(spec.command, spec.args, { ...spec.options, killSignal: 'SIGKILL' });
}

/** `gone`, `present`, or `unreadable`: what ~/.claude.json shows, read up to 3 times, 500 ms apart, until it parses. */
function removalOutcome(run) {
	for (let read = 0; read < REREAD_ATTEMPTS; read++) {
		run.sleep(REREAD_MS);
		const result = readClaudeJson(run, 1);
		if (result !== null) return Object.hasOwn(serversOf(result.value), CLAUDE_KEY) ? 'present' : 'gone';
	}
	return 'unreadable';
}

/** The text for a registration that is still there: the first line of stderr of a command that failed, with the known secrets cut out, else the restart text. */
function removalFailureText(run, result, secrets) {
	if (result.error) return describeError(result.error, run.claudeBin);
	const line = result.status === 0 ? '' : String(result.stderr ?? '').split(/\r?\n/, 1)[0].trim();
	if (line === '') return RESTART_TEXT;
	return redactOutput(line, secrets).replace(CONTROL_CHARACTERS, '?').slice(0, STDERR_LINE_LIMIT);
}

function claudeEntryStep(run, step, item, flags) {
	if (run.claudeBin === null) throw new StepFailure(NO_CLAUDE_TEXT);
	const current = readClaudeJson(run, REGISTRATION_ATTEMPTS);
	const servers = current === null ? {} : serversOf(current.value);
	if (!Object.hasOwn(servers, CLAUDE_KEY)) throw changedSince('~/.claude.json');
	const entry = servers[CLAUDE_KEY];
	const holder = { file: run.paths.claudeJson, ...entryFacts(entry, run.ownRoots) };
	if (!recheck(run, item, { claudeEntry: holder, claude: { binary: run.claudeBin }, secretsText: secretsFileText(run.fs, run.secretsFile) })) throw changedSince('~/.claude.json');
	startStep(run, step, { position: Object.keys(servers).indexOf(CLAUDE_KEY), entry: redactEntry(entry, secretsByKey(run)).entry });
	let result;
	let outcome = 'present';
	for (let attempt = 0; attempt < REMOVE_ATTEMPTS && outcome === 'present'; attempt++) {
		result = runClaude(run, ['mcp', 'remove', CLAUDE_KEY, '--scope', 'user']);
		outcome = removalOutcome(run);
	}
	if (outcome === 'gone') return;
	if (outcome === 'unreadable') {
		flags.changed = true;
		throw new SyntaxError('~/.claude.json does not parse');
	}
	throw new StepFailure(removalFailureText(run, result, knownSecrets(run)));
}

// CLAUDE.md --------------------------------------------------------------------------------------------------------

function sentinelStep(run, step, item, flags) {
	const file = run.paths.claudeMd;
	const realPath = run.fs.realpathSync(file);
	const known = run.facts.claudeMd;
	if (!isPlainObject(known) || known.realPath !== realPath) throw changedSince('~/.claude/CLAUDE.md');
	const read = readFileRecord(run.fs, realPath);
	if (read.state !== 'ok') throw changedSince('~/.claude/CLAUDE.md');
	const { text, utf8Exact } = decode(read.buffer);
	if (!utf8Exact) throw notUtf8(file);
	if (!recheck(run, item, { claudeMd: { file, realPath, text, mode: read.mode, utf8Exact } })) throw changedSince('~/.claude/CLAUDE.md');
	const block = findSentinelBlock(text);
	const next = removeBlock(text, block);
	startStep(run, step, { file, realPath, mode: read.mode, offset: block.offset, removedText: block.removedText, sha256Before: sha256(text), sha256After: sha256(next) });
	if (!replaceFile(run, realPath, next, read.buffer, read.mode)) throw changedSince('~/.claude/CLAUDE.md');
}

// The .env files ---------------------------------------------------------------------------------------------------

/** The stat of the `.env`, when it is a regular file (no link) whose real path lies inside the real path of its skill folder, and that folder is no link. */
function envLocation(run, item) {
	const skillDir = item.group === 'claude' ? run.paths.claudeSkill : run.paths.cursorSkill;
	const stat = run.fs.lstatSync(item.path);
	if (run.fs.lstatSync(skillDir).isSymbolicLink() || !stat.isFile() || !realPathInside(run.fs, item.path, skillDir)) throw new StepFailure(ENV_OUTSIDE_TEXT);
	return stat;
}

function envFileStep(run, step, item) {
	const stat = envLocation(run, item);
	if (item.action === 'keep-in-backup') {
		startStep(run, step, { mode: stat.mode & 0o777 });
		run.fs.chmodSync(item.path, 0o600);
		return;
	}
	const read = readFileRecord(run.fs, item.path);
	if (read.state !== 'ok') throw new StepFailure(ENV_CHANGED_TEXT);
	const { text, utf8Exact } = decode(read.buffer);
	const secretsText = secretsFileText(run.fs, run.secretsFile);
	const holder = { path: item.path, text, mode: read.mode, utf8Exact, insideSkill: true };
	if (!recheck(run, item, { [`${item.group}Env`]: holder, secretsText })) throw new StepFailure(ENV_CHANGED_TEXT);
	const parsed = parseEnvTemplate(text, (key) => secretsValue(secretsText, key));
	startStep(run, step, { mode: read.mode, eol: parsed.eol, trailingNewline: parsed.trailingNewline, bom: parsed.bom, template: parsed.template });
	run.fs.unlinkSync(item.path);
}

// The folders ------------------------------------------------------------------------------------------------------

/** True when both folders list the same number of entries that are not folders with the same total size, or both links name the same target. */
function sameTree(fs, from, to, isLink) {
	if (isLink) return fs.readlinkSync(from) === fs.readlinkSync(to);
	const a = walkFolder(fs, from);
	const b = walkFolder(fs, to);
	return a !== null && b !== null && a.fileCount === b.fileCount && a.sizeBytes === b.sizeBytes;
}

function copyThenRemove(run, from, to, isLink, flags) {
	try {
		run.fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
		if (!sameTree(run.fs, from, to, isLink)) throw new StepFailure(COPY_MISMATCH_TEXT);
	} catch (err) {
		try {
			run.fs.rmSync(to, { recursive: true, force: true });
		} catch {
			// a partial copy that cannot be removed stays in the backup folder
		}
		throw err;
	}
	flags.changed = true;
	if (isLink) run.fs.unlinkSync(from);
	else run.fs.rmSync(from, { recursive: true });
}

/** Renames `from` to `to` (a link moves as a link). EXDEV falls back to a copy that is checked and then removed; EPERM and EBUSY on Windows are retried 3 times, 500 ms apart. */
function moveFolder(run, step, from, to, isLink, flags) {
	for (let attempt = 0; ; attempt++) {
		try {
			run.fs.renameSync(from, to);
			return;
		} catch (err) {
			if (err.code === 'EXDEV') break;
			if (run.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EBUSY') && attempt < RENAME_RETRIES) {
				run.sleep(RENAME_RETRY_MS);
				continue;
			}
			throw err;
		}
	}
	step.method = 'copy';
	writeManifest(run);
	copyThenRemove(run, from, to, isLink, flags);
}

function directoryStep(run, step, item, flags) {
	const original = item.path;
	if (isLookalikeSkillDir(original, run.pluginRoot)) throw new StepFailure(DIR_PLUGIN_TEXT);
	const rules = item.id === RULES_ID;
	const fresh = rules ? rulesFolderFacts(run.fs, original) : skillFolderFacts(run.fs, original);
	if (!recheck(run, item, rules ? { cursorRules: fresh } : { [`${item.group}Skill`]: fresh })) throw new StepFailure(DIR_CHANGED_TEXT);
	run.fs.mkdirSync(path.dirname(step.backup), { recursive: true, mode: 0o700 });
	if (pathExists(run.fs, step.backup)) throw new StepFailure(BACKUP_TAKEN_TEXT);
	startStep(run, step, { symlink: fresh.symlink === true, method: 'rename' });
	moveFolder(run, step, original, step.backup, fresh.symlink === true, flags);
}

// The Cursor registrations -----------------------------------------------------------------------------------------

function cursorMemberStep(run, step, item, flags) {
	const file = run.paths.cursorMcp;
	const key = item.id.slice(CURSOR_PREFIX.length);
	const realPath = run.fs.realpathSync(file);
	for (let attempt = 0; attempt < CURSOR_ATTEMPTS; attempt++) {
		const read = readFileRecord(run.fs, realPath, Infinity);
		if (read.state !== 'ok') throw changedSince('~/.cursor/mcp.json');
		const { text, utf8Exact } = decode(read.buffer);
		if (!utf8Exact) throw notUtf8(file);
		const members = Object.entries(serversOf(JSON.parse(text))).map(([name, entry]) => ({ key: name, ...entryFacts(entry, run.ownRoots) }));
		const holder = { file, format: 'json', text, utf8Exact, members };
		if (!recheck(run, item, { cursorMembers: holder, secretsText: secretsFileText(run.fs, run.secretsFile) }, (fresh) => !fresh.reformats || item.reformats === true)) throw changedSince('~/.cursor/mcp.json');
		const removal = removeJsonMember(text, key);
		startStep(run, step, {
			realPath,
			position: removal.position,
			indent: removal.indent,
			eol: removal.eol,
			trailingNewline: removal.trailingNewline,
			mode: read.mode,
			entry: redactEntry(removal.entry, secretsByKey(run)).entry,
		});
		if (replaceFile(run, realPath, removal.text, read.buffer, read.mode)) {
			flags.changed = true;
			JSON.parse(run.fs.readFileSync(realPath, 'utf8'));
			return;
		}
	}
	throw new StepFailure(CURSOR_BUSY_TEXT);
}

// The run ----------------------------------------------------------------------------------------------------------

/** The kind, path, allowed actions, and runner of each plan item this version knows; anything else is a TypeError before the first change. */
function stepSpec(item, paths) {
	const known = {
		'claude.mcp-entry': { kind: 'claude-mcp-entry', path: paths.claudeJson, actions: ['remove-entry'], run: claudeEntryStep },
		'claude.sentinel': { kind: 'text-block', path: paths.claudeMd, actions: ['remove-block'], run: sentinelStep },
		'claude.env-file': { kind: 'env-file', path: paths.claudeEnv, actions: ['delete', 'keep-in-backup'], run: envFileStep },
		'claude.skill-dir': { kind: 'directory', path: paths.claudeSkill, actions: ['move'], run: directoryStep },
		'cursor.env-file': { kind: 'env-file', path: paths.cursorEnv, actions: ['delete', 'keep-in-backup'], run: envFileStep },
		'cursor.skill-dir': { kind: 'directory', path: paths.cursorSkill, actions: ['move'], run: directoryStep },
		[RULES_ID]: { kind: 'directory', path: paths.cursorRules, actions: ['move'], run: directoryStep },
	};
	const id = item.id;
	let spec = typeof id === 'string' && Object.hasOwn(known, id) ? known[id] : null;
	if (typeof id === 'string' && id.startsWith(CURSOR_PREFIX) && id.length > CURSOR_PREFIX.length) spec = { kind: 'json-member', path: paths.cursorMcp, actions: ['remove-entry'], run: cursorMemberStep };
	if (spec === null || item.kind !== spec.kind || item.path !== spec.path || !spec.actions.includes(item.action) || item.group !== id.split('.')[0]) throw new TypeError(PLAN_ERROR);
	return spec;
}

/** The fields of a step that are known before it runs, so a manifest that stops early still names every step. */
function pendingFields(run, item, spec) {
	switch (spec.kind) {
		case 'claude-mcp-entry':
			return { file: spec.path, key: CLAUDE_KEY, scope: 'user', position: null, entry: null };
		case 'text-block':
			return { file: spec.path, realPath: realPathOrNull(run.fs, spec.path), mode: null, offset: null, removedText: null, sha256Before: null, sha256After: null };
		case 'env-file':
			return { path: spec.path, mode: null, action: item.action, eol: null, trailingNewline: null, bom: null, template: null };
		case 'directory': {
			const [group, name] = item.id.split('.');
			return { original: spec.path, backup: path.join(run.backupDir, group, name), symlink: item.symlink === true, method: 'rename' };
		}
		default:
			return { file: spec.path, realPath: realPathOrNull(run.fs, spec.path), key: item.id.slice(CURSOR_PREFIX.length), position: null, indent: null, eol: null, trailingNewline: null, mode: null, entry: null };
	}
}

function fileOf(run, step) {
	return step.file ?? step.path ?? step.original ?? run.secretsFile;
}

function failureText(run, step, err) {
	if (err instanceof ManifestError) return describeError(err.cause, run.manifestFile);
	if (err instanceof StepFailure) return err.message;
	return describeError(err, fileOf(run, step));
}

/**
 * Runs one step: it records its fields and the state `running`, acts, calls `hooks.afterChange`, and marks it `done`. A
 * failure marks it `failed`, unless the step may have changed something: then it stays `running` with its error, because
 * the restore only looks at `done` and `running` steps. Returns false after a failure.
 */
function runStep(run, entry) {
	const { step, item, spec } = entry;
	const flags = { changed: false };
	try {
		spec.run(run, step, item, flags);
		flags.changed = true;
		if (typeof run.hooks.afterChange === 'function') run.hooks.afterChange(step.id);
		step.state = 'done';
		step.error = null;
		writeManifest(run);
		return true;
	} catch (err) {
		step.state = flags.changed ? 'running' : 'failed';
		step.error = failureText(run, step, err);
	}
	try {
		writeManifest(run);
	} catch {
		// the manifest on disk keeps the earlier state, which the restore reads as running
	}
	return false;
}

function resultLines(run, entries, failed) {
	const lines = entries
		.filter(({ step }) => step.state !== 'pending')
		.map(({ step }) => (step.state === 'done' ? `done    ${step.id}` : `failed  ${step.id}: ${step.error}`));
	lines.push(`Backup: ${shortHome(run.home, run.backupDir)}`);
	const notice = Array.isArray(run.plan.notices) ? run.plan.notices.find((candidate) => candidate.kind === 'claude-backup-copy') : undefined;
	const claude = entries.find(({ step }) => step.id === 'claude.mcp-entry');
	if (notice !== undefined && claude !== undefined && claude.step.state === 'done') lines.push(notice.text);
	lines.push(`To undo: node "${shownPath(run.pluginRoot)}/shared/scripts/cleanup-legacy.js" --restore`);
	lines.push(failed ? PARTIAL_TEXT : 'Restart Claude Code and Cursor.');
	return lines;
}

/**
 * Moves the old install of the named groups into `<home>/.make-custom-app/migration-backup-<time>/`, step by step, in the
 * order of the plan, and returns `{ exitCode, status, backupDir, lines }`: exit 0 and `complete`, or exit 4 and `partial`
 * after the first failed step (later steps stay `pending`). Before the first change it writes `manifest.json` (mode 0600,
 * through a temp file and a rename) with every step `pending`; each step is recorded as `running` before its change.
 * Every step rereads what it changes and acts only when the plan item still holds (see recheck). The secrets that the old
 * install holds and the secrets file lacks are copied first; `~/.claude.json` is never written, only `claude mcp remove`
 * changes it. `hooks.afterChange(stepId)` is for tests. A plan with nothing ready in the named groups returns exit 0 with
 * `backupDir` null. Call preflightApply first: this function does not look at the digest or at pluginGuard.
 */
function applySteps(params) {
	requireParams('applySteps', params, ['env', 'home']);
	const { plan, facts, groups, env, home } = params;
	if (!isPlainObject(plan) || !Array.isArray(plan.items) || typeof plan.digest !== 'string' || !isPlainObject(facts) || !Array.isArray(groups)) throw new TypeError('applySteps needs plan, facts, and groups');
	if (plan.home !== home || facts.home !== home) throw new TypeError('applySteps needs a plan and facts of the given home');
	const pluginRoot = typeof params.pluginRoot === 'string' && params.pluginRoot !== '' ? params.pluginRoot : facts.pluginRoot;
	if (typeof pluginRoot !== 'string' || pluginRoot === '') throw new TypeError('applySteps needs pluginRoot');
	const fs = params.fs === undefined ? nodeFs : params.fs;
	const paths = oldInstallPaths(home);
	const selected = plan.items.filter((item) => groups.includes(item.group) && item.status === 'ready');
	const specs = selected.map((item) => stepSpec(item, paths));
	if (selected.length === 0) return { exitCode: 0, status: 'complete', backupDir: null, lines: [`Nothing to remove in ${groups.join(' and ')}.`] };

	const nowMs = resolveNow(params.now);
	const base = path.join(home, STATE_DIR);
	fs.mkdirSync(base, { recursive: true, mode: 0o700 });
	const backupDir = path.join(base, backupFolderName(nowMs, (name) => fs.existsSync(path.join(base, name))));
	fs.mkdirSync(backupDir, { mode: 0o700 });
	fs.chmodSync(backupDir, 0o700);

	const sources = secretSources(facts);
	const run = {
		fs,
		env,
		home,
		paths,
		plan,
		facts,
		sources,
		pluginRoot,
		backupDir,
		manifestFile: path.join(backupDir, MANIFEST_FILE),
		secretsFile: path.join(home, '.make-custom-app-skill-secrets'),
		spawn: params.spawnSync === undefined ? childProcess.spawnSync : params.spawnSync,
		sleep: params.sleep === undefined ? sleepMs : params.sleep,
		platform: params.platform === undefined ? process.platform : params.platform,
		hooks: isPlainObject(params.hooks) ? params.hooks : {},
		claudeBin: typeof params.claudeBin === 'string' && params.claudeBin !== '' ? params.claudeBin : binaryOf(facts),
		ownRoots: ownRootsFor(paths, pluginRoot).ownRoots,
		manifest: null,
	};
	const entries = selected.map((item, index) => ({ item, spec: specs[index], step: { id: item.id, type: specs[index].kind, state: 'pending', error: null, ...pendingFields(run, item, specs[index]) } }));
	const secretKeys = Object.keys(compareSecrets(sources, typeof facts.secretsText === 'string' ? facts.secretsText : null).updates);
	if (secretKeys.length > 0) entries.unshift({ item: null, spec: { run: secretsStep }, step: { id: 'secrets', type: 'secrets', state: 'pending', error: null, keys: secretKeys } });
	run.manifest = {
		schema: SCHEMA,
		createdAt: new Date(nowMs).toISOString(),
		pluginVersion: isPlainObject(plan.plugin) && typeof plan.plugin.version === 'string' ? plan.plugin.version : null,
		home,
		digest: plan.digest,
		groups: GROUP_IDS.filter((id) => groups.includes(id)),
		status: 'in-progress',
		secretsKeysAdded: [],
		steps: entries.map(({ step }) => step),
	};
	try {
		writeManifest(run);
	} catch (err) {
		try {
			fs.rmdirSync(backupDir);
		} catch {
			// a folder that cannot be removed stays
		}
		throw err.cause;
	}

	let failed = false;
	for (const entry of entries) {
		if (!runStep(run, entry)) {
			failed = true;
			break;
		}
	}
	run.manifest.status = failed ? 'partial' : 'complete';
	try {
		writeManifest(run);
	} catch {
		// the manifest on disk keeps the status in-progress
	}
	return { exitCode: failed ? 4 : 0, status: run.manifest.status, backupDir, lines: resultLines(run, entries, failed) };
}

module.exports = {
	LOCK_STALE_MS,
	childEnv,
	spawnSpec,
	claudeCandidates,
	locateClaude,
	gatherFacts,
	pluginGuard,
	acquireLock,
	readDecline,
	writeDecline,
	preflightApply,
	applySteps,
};
