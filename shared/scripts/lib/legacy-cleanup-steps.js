/**
 * legacy-cleanup-steps.js: the file and process steps of the old-install cleanup (phase B).
 *
 * Role: gatherFacts reads the real file system into the facts that buildPlan (./legacy-cleanup-logic) judges, locateClaude
 * finds and checks the `claude` binary, pluginGuard says whether the cleanup may run, acquireLock keeps two runs apart,
 * and readDecline and writeDecline keep the answer "keep the old install". preflightApply refuses a run that may not
 * start, and applySteps is the only code that moves or deletes a user file: it rereads every file or folder right before
 * it acts, rebuilds the plan item from what it read, and acts only when the item is still the one the user confirmed.
 * It records each step in a manifest before the change, never writes ~/.claude.json (`claude mcp remove` does), and never
 * shows a value of a file: every error text goes through describeError or is one of the fixed texts below. findBackups and
 * restoreSteps undo a run from its manifest, which they treat as data that may be hostile: every place it names is checked
 * against oldInstallPaths before anything is written, and a step is judged by what is on disk now (restoreDecision).
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
	restoreBlock,
	renderEnvTemplate,
	insertJsonMember,
	restoreDecision,
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

/** True when the file itself is a symbolic link (a link in a folder on the way does not count). */
function isLinkFile(fs, file) {
	try {
		return fs.lstatSync(file).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * The `.env` of a skill folder, as read: text, mode (of the file a link names), whether its bytes survive UTF-8, and
 * whether its real path lies inside the real path of the folder. `linked: true` is added when the `.env` itself is a
 * link, so the plan keeps it in the backup and never deletes it. One above the read cap is not read: it has no text,
 * `utf8Exact` false, and `tooLarge` true, so the plan keeps it in the backup and never deletes it.
 */
function envFacts(fs, envFile, skillDir) {
	const read = readFileRecord(fs, envFile);
	if (read.state !== 'ok' && read.state !== 'toolarge') return null;
	const insideSkill = realPathInside(fs, envFile, skillDir);
	const linked = isLinkFile(fs, envFile) ? { linked: true } : {};
	if (read.state === 'toolarge') return { path: envFile, text: '', mode: read.mode, utf8Exact: false, insideSkill, ...linked, tooLarge: true };
	const { text, utf8Exact } = decode(read.buffer);
	return { path: envFile, text, mode: read.mode, utf8Exact, insideSkill, ...linked };
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
const NO_LONGER_OLD_TEXT = 'the entry in ~/.claude.json is no longer the old one, so it was left alone';
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
 * remove in the named groups (exit 0; it fires only when they hold neither a `ready` nor a `blocked` item, as planDigest
 * counts them), a digest that is not the plan's (3), the plugin guard (2), a blocked item of a named group (2). It reads
 * only the plan and the facts it is given.
 */
function preflightApply(params) {
	requireParams('preflightApply', params, ['digest', 'groups', 'plan', 'facts']);
	const { digest, groups, plan, facts } = params;
	if (!Array.isArray(groups) || !isPlainObject(plan) || !Array.isArray(plan.items)) throw new TypeError('preflightApply needs digest, groups, plan, and facts');
	const named = plan.items.filter((item) => groups.includes(item.group));
	if (!named.some((item) => item.status === 'ready' || item.status === 'blocked')) return { exitCode: 0, lines: [`Nothing to remove in ${groups.join(' and ')}.`] };
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

/**
 * Writes the manifest through `manifest.json.tmp` (flag `wx`, mode 0600) and a rename. The backup folder is new, so a temp
 * file in it is ours and is removed after every failure, also after a write that stopped part way; the one exception is an
 * EEXIST of the open itself, which names a file that was there before.
 */
function writeManifest(run) {
	const temp = `${run.manifestFile}.tmp`;
	let renaming = false;
	try {
		run.fs.writeFileSync(temp, `${JSON.stringify(run.manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
		renaming = true;
		run.fs.renameSync(temp, run.manifestFile);
	} catch (err) {
		if (renaming || err.code !== 'EEXIST') {
			try {
				run.fs.unlinkSync(temp);
			} catch {
				// the temp file is gone already
			}
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

/** The text for a registration that is still there: the first line of stderr of a command that failed, with the known secrets cut out, else the restart text (or `fallback`). */
function removalFailureText(run, result, secrets, fallback = RESTART_TEXT) {
	if (result.error) return describeError(result.error, run.claudeBin);
	const line = result.status === 0 ? '' : String(result.stderr ?? '').split(/\r?\n/, 1)[0].trim();
	if (line === '') return fallback;
	return redactOutput(line, secrets).replace(CONTROL_CHARACTERS, '?').slice(0, STDERR_LINE_LIMIT);
}

/**
 * What ~/.claude.json holds for the registration right now: `servers` (null when the file does not parse), whether the key
 * is `present` (whatever its value, even null), its `entry`, and whether it is still the old registration of the plan
 * (recheck: Ruling 28 and the fingerprint).
 */
function judgeClaudeEntry(run, item) {
	const current = readClaudeJson(run, REGISTRATION_ATTEMPTS);
	const servers = current === null ? null : serversOf(current.value);
	if (servers === null || !Object.hasOwn(servers, CLAUDE_KEY)) return { servers, present: false, entry: null, old: false };
	const entry = servers[CLAUDE_KEY];
	const holder = { file: run.paths.claudeJson, ...entryFacts(entry, run.ownRoots) };
	const old = recheck(run, item, { claudeEntry: holder, claude: { binary: run.claudeBin }, secretsText: secretsFileText(run.fs, run.secretsFile) });
	return { servers, present: true, entry, old };
}

/** The error for a ~/.claude.json that cannot be used after a removal: a file that is gone (ENOENT) or one that does not parse. */
function unusableClaudeJson(run) {
	if (readFileRecord(run.fs, run.paths.claudeJson, Infinity).state === 'missing') return Object.assign(new Error('~/.claude.json is gone'), { code: 'ENOENT' });
	return new SyntaxError('~/.claude.json does not parse');
}

function claudeEntryStep(run, step, item, flags) {
	if (run.claudeBin === null) throw new StepFailure(NO_CLAUDE_TEXT);
	const first = judgeClaudeEntry(run, item);
	if (!first.old) throw changedSince('~/.claude.json');
	startStep(run, step, { position: Object.keys(first.servers).indexOf(CLAUDE_KEY), entry: redactEntry(first.entry, secretsByKey(run)).entry });
	let result;
	let outcome = 'present';
	for (let attempt = 0; attempt < REMOVE_ATTEMPTS && outcome === 'present'; attempt++) {
		if (attempt > 0) {
			const again = judgeClaudeEntry(run, item);
			if (again.servers === null) throw unusableClaudeJson(run);
			if (!again.present) return;
			if (!again.old) throw new StepFailure(NO_LONGER_OLD_TEXT);
		}
		result = runClaude(run, ['mcp', 'remove', CLAUDE_KEY, '--scope', 'user']);
		flags.changed = true;
		outcome = removalOutcome(run);
	}
	if (outcome === 'gone') return;
	if (outcome === 'unreadable') throw unusableClaudeJson(run);
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

/**
 * `{ stat, linked }` of the `.env`: `stat` is the one of the regular file it names, which may be the file behind a link,
 * and its real path must lie inside the real path of its skill folder, which is no link itself.
 */
function envLocation(run, item) {
	const skillDir = item.group === 'claude' ? run.paths.claudeSkill : run.paths.cursorSkill;
	const own = run.fs.lstatSync(item.path);
	const linked = own.isSymbolicLink();
	const stat = linked ? run.fs.statSync(item.path) : own;
	if (run.fs.lstatSync(skillDir).isSymbolicLink() || !stat.isFile() || !realPathInside(run.fs, item.path, skillDir)) throw new StepFailure(ENV_OUTSIDE_TEXT);
	return { stat, linked };
}

function envFileStep(run, step, item) {
	const { stat, linked } = envLocation(run, item);
	const folder = run.plan.items.find((candidate) => candidate.id === `${item.group}.skill-dir`);
	if (folder === undefined) throw new StepFailure(DIR_CHANGED_TEXT);
	checkFolder(run, folder);
	if (item.action === 'keep-in-backup') {
		startStep(run, step, { mode: stat.mode & 0o777 });
		run.fs.chmodSync(item.path, 0o600);
		return;
	}
	const read = readFileRecord(run.fs, item.path);
	if (read.state !== 'ok') throw new StepFailure(ENV_CHANGED_TEXT);
	const { text, utf8Exact } = decode(read.buffer);
	const secretsText = secretsFileText(run.fs, run.secretsFile);
	const holder = { path: item.path, text, mode: read.mode, utf8Exact, insideSkill: true, ...(linked ? { linked: true } : {}) };
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

/**
 * Renames `from` to `to` (a link moves as a link). EXDEV falls back to `copy` (copyThenRemove: a copy that is checked and
 * then removed); EPERM and EBUSY on Windows are retried 3 times, 500 ms apart. A `step` records the fallback as its
 * method; the restore passes null.
 */
function moveFolder(run, step, from, to, isLink, flags, copy = copyThenRemove) {
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
	if (step !== null) {
		step.method = 'copy';
		writeManifest(run);
	}
	copy(run, from, to, isLink, flags);
}

/** The checks before a skill or rules folder is moved or its `.env` is touched: it is no plugin, and it is still the folder of the plan. Returns its fresh facts. */
function checkFolder(run, item) {
	const original = item.path;
	if (isLookalikeSkillDir(original, run.pluginRoot)) throw new StepFailure(DIR_PLUGIN_TEXT);
	const rules = item.id === RULES_ID;
	const fresh = rules ? rulesFolderFacts(run.fs, original) : skillFolderFacts(run.fs, original);
	if (!recheck(run, item, rules ? { cursorRules: fresh } : { [`${item.group}Skill`]: fresh })) throw new StepFailure(DIR_CHANGED_TEXT);
	return fresh;
}

function directoryStep(run, step, item, flags) {
	const original = item.path;
	const fresh = checkFolder(run, item);
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

// ---------------------------------------------------------------------------------------------------------------
// findBackups and restoreSteps
// ---------------------------------------------------------------------------------------------------------------

const BACKUP_NAME = /^migration-backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:-(\d+))?$/;
const MANIFEST_STATUSES = ['in-progress', 'complete', 'partial', 'restored', 'partially-restored'];
const STEP_STATES = ['pending', 'running', 'done', 'failed', 'restored', 'restore-skipped'];
const MAX_RESTORE_STEPS = 64;
const MAX_SHOWN_CHARACTERS = 300;
const PLACE_FIELD = { 'claude-mcp-entry': 'file', 'text-block': 'file', 'env-file': 'path', directory: 'original', 'json-member': 'file' };
const REAL_PATH_TYPES = ['text-block', 'json-member'];

const WINDOWS_RESTORE_TEXT = 'on Windows with claude.cmd the entry is not passed through cmd.exe; run the old installer again to register the old server';
const NO_CLAUDE_RESTORE_TEXT = 'Claude Code was not found. Set CLAUDE_BIN and run --restore again.';
const NO_FOLDER_TO_PUT_BACK_TEXT = 'the backup holds no folder to put back';
const ADD_FAILED_TEXT = 'claude did not add the registration to ~/.claude.json';
const APPENDED_TEXT = ' (appended at the end, because the file changed)';
const EARLIER_RESTORE_TEXT = 'handled by an earlier restore';
const ADD_JSON_NOTE = 'Note: the restored MCP registration was passed to claude on its command line; other processes of your user could see it in the process list while it ran.';
const RESTART_AFTER_RESTORE = 'Restart Claude Code and Cursor.';

function backupSummary(fs, dir) {
	const unreadable = { status: 'unreadable', createdAt: null };
	const read = readFileRecord(fs, path.join(dir, MANIFEST_FILE));
	if (read.state !== 'ok') return unreadable;
	try {
		const manifest = parseJsonText(read.buffer.toString('utf8'));
		if (!isPlainObject(manifest) || !MANIFEST_STATUSES.includes(manifest.status)) return unreadable;
		return { status: manifest.status, createdAt: typeof manifest.createdAt === 'string' && ISO_UTC.test(manifest.createdAt) ? manifest.createdAt : null };
	} catch {
		return unreadable;
	}
}

/**
 * The backup folders under `<home>/.make-custom-app`, newest name first, as `{ dir, name, status, createdAt }`. A folder
 * counts when it is a real folder (no link) named like backupFolderName makes them. `status` is the status of its
 * manifest, `unreadable` when the manifest is missing, is too big, does not parse, or holds a status this version does not
 * write; `createdAt` is the time the manifest records, or null.
 */
function findBackups(params) {
	requireParams('findBackups', params, ['home']);
	const { home, fs = nodeFs } = params;
	const base = path.join(home, STATE_DIR);
	let entries;
	try {
		entries = fs.readdirSync(base, { withFileTypes: true });
	} catch {
		return [];
	}
	const found = [];
	for (const entry of entries) {
		const match = BACKUP_NAME.exec(entry.name);
		if (match === null || !entry.isDirectory()) continue;
		const dir = path.join(base, entry.name);
		found.push({ stamp: match[1], serial: match[2] === undefined ? 1 : Number(match[2]), item: { dir, name: entry.name, ...backupSummary(fs, dir) } });
	}
	found.sort((a, b) => (a.stamp === b.stamp ? b.serial - a.serial : a.stamp < b.stamp ? 1 : -1));
	return found.map(({ item }) => item);
}

function restoreSpecs(paths) {
	return {
		'claude.mcp-entry': { type: 'claude-mcp-entry', place: paths.claudeJson },
		'claude.sentinel': { type: 'text-block', place: paths.claudeMd },
		'claude.env-file': { type: 'env-file', place: paths.claudeEnv, skillDir: paths.claudeSkill },
		'claude.skill-dir': { type: 'directory', place: paths.claudeSkill },
		'cursor.env-file': { type: 'env-file', place: paths.cursorEnv, skillDir: paths.cursorSkill },
		'cursor.skill-dir': { type: 'directory', place: paths.cursorSkill },
		[RULES_ID]: { type: 'directory', place: paths.cursorRules },
		secrets: { type: 'secrets', place: null },
	};
}

function isMode(value) {
	return Number.isInteger(value) && value >= 0 && value <= 0o777;
}

function isEol(value) {
	return value === '\n' || value === '\r\n';
}

/** True when every object in `entry.env` is a `{ "$secret": <one of the three plugin keys> }` reference. */
function hasKnownSecretRefs(entry) {
	if (!isPlainObject(entry) || !isPlainObject(entry.env)) return true;
	return Object.values(entry.env).every((value) => !isPlainObject(value) || (Object.keys(value).length === 1 && PLUGIN_KEYS.includes(value.$secret)));
}

function isEnvTemplate(template) {
	return Array.isArray(template) && template.every((item) => typeof item === 'string' || (isPlainObject(item) && Object.keys(item).length === 2 && typeof item.prefix === 'string' && PLUGIN_KEYS.includes(item.$secret)));
}

const NONNEGATIVE = (value) => Number.isInteger(value) && value >= 0;

/** The fields every step of a type has, in every state (the pending ones are filled in when the manifest is created). */
const STEP_SHAPES = {
	'claude-mcp-entry': (step) => typeof step.file === 'string',
	'text-block': (step) => typeof step.file === 'string',
	'env-file': (step) => typeof step.path === 'string' && (step.action === 'delete' || step.action === 'keep-in-backup'),
	directory: (step) => typeof step.original === 'string' && typeof step.backup === 'string' && (step.method === 'rename' || step.method === 'copy') && typeof step.symlink === 'boolean',
	'json-member': (step) => typeof step.file === 'string' && typeof step.key === 'string' && step.key !== '' && step.id === CURSOR_PREFIX + step.key,
	secrets: () => true,
};

/** The fields a step has once it has run (it was recorded as `running` before its change, so these are there for `running` and `done`). */
const RAN_SHAPES = {
	'claude-mcp-entry': (step) => isPlainObject(step.entry) && hasKnownSecretRefs(step.entry),
	'text-block': (step) => typeof step.realPath === 'string' && isMode(step.mode) && NONNEGATIVE(step.offset) && typeof step.removedText === 'string' && typeof step.sha256After === 'string',
	'env-file': (step) => isMode(step.mode) && (step.action !== 'delete' || (isEnvTemplate(step.template) && isEol(step.eol) && typeof step.trailingNewline === 'boolean' && typeof step.bom === 'boolean')),
	'json-member': (step) =>
		typeof step.realPath === 'string' &&
		isMode(step.mode) &&
		(step.position === null || NONNEGATIVE(step.position)) &&
		typeof step.indent === 'string' &&
		/^[ \t]*$/.test(step.indent) &&
		isEol(step.eol) &&
		typeof step.trailingNewline === 'boolean' &&
		step.entry !== undefined &&
		hasKnownSecretRefs(step.entry),
};

/**
 * The steps of a manifest as `{ step, spec, realPath }`, or null when it is not a manifest this version writes: the
 * schema, at most 64 steps, each a known id once, its type, its state, and the fields of its type. Nothing here reads the file system.
 */
function checkManifest(manifest, paths) {
	if (!isPlainObject(manifest) || manifest.schema !== SCHEMA || !Array.isArray(manifest.steps) || manifest.steps.length > MAX_RESTORE_STEPS) return null;
	const known = restoreSpecs(paths);
	const seen = new Set();
	const entries = [];
	for (const step of manifest.steps) {
		if (!isPlainObject(step) || typeof step.id !== 'string' || seen.has(step.id) || !STEP_STATES.includes(step.state)) return null;
		seen.add(step.id);
		let spec = Object.hasOwn(known, step.id) ? known[step.id] : null;
		if (step.id.startsWith(CURSOR_PREFIX) && step.id.length > CURSOR_PREFIX.length) spec = { type: 'json-member', place: paths.cursorMcp };
		if (spec === null || step.type !== spec.type || !STEP_SHAPES[spec.type](step)) return null;
		const ran = step.state === 'running' || step.state === 'done';
		if (ran && Object.hasOwn(RAN_SHAPES, spec.type) && !RAN_SHAPES[spec.type](step)) return null;
		entries.push({ step, spec, realPath: null });
	}
	return entries;
}

function isInsideRelative(relative) {
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** The real path of the folder that holds `file` (the deepest part that exists, then the rest), joined with its name; null when it cannot be told. */
function realParentPath(fs, file) {
	const rest = [path.basename(file)];
	let current = path.dirname(file);
	for (;;) {
		try {
			return path.join(fs.realpathSync(current), ...rest);
		} catch (err) {
			const parent = path.dirname(current);
			if (!isMissingFile(err) || parent === current) return null;
			rest.unshift(path.basename(current));
			current = parent;
		}
	}
}

/** True when `backup` is a normalized absolute path that lies inside the backup folder, also after the links on the way are resolved. The last name is not resolved: a link moves as a link. */
function backupInside(fs, backupDir, realBackupDir, backup) {
	if (path.resolve(backup) !== backup || !isInsideRelative(path.relative(path.resolve(backupDir), backup))) return false;
	const real = realParentPath(fs, backup);
	return real !== null && isInsideRelative(path.relative(realBackupDir, real));
}

/**
 * The first place a step names that the cleanup does not move, or null (Ruling 9). A step that ran must still have the
 * real path it recorded: it is computed now and kept on the entry, which is where every write goes. A file that is gone has
 * none (null: its step fails later), one whose real path cannot be told counts as a place that does not match.
 */
function foreignPlace(fs, backupDir, realBackupDir, entries) {
	for (const entry of entries) {
		const { step, spec } = entry;
		const named = step[PLACE_FIELD[spec.type]];
		if (spec.place !== null && named !== spec.place) return named;
		if (spec.type === 'directory' && !backupInside(fs, backupDir, realBackupDir, step.backup)) return step.backup;
		if (REAL_PATH_TYPES.includes(spec.type) && (step.state === 'running' || step.state === 'done')) {
			let now = null;
			try {
				now = fs.realpathSync(step.file);
			} catch (err) {
				if (!isMissingFile(err)) return step.realPath;
			}
			if (now !== null && now !== step.realPath) return step.realPath;
			entry.realPath = now;
		}
	}
	return null;
}

function showText(value) {
	return shownPath(value).slice(0, MAX_SHOWN_CHARACTERS);
}

function missingFile() {
	return Object.assign(new Error('the file is missing'), { code: 'ENOENT' });
}

/** What the restore may print as a secret: the values of the secrets file and every literal env value the manifest holds. */
function manifestSecrets(run) {
	const values = new Set(Object.values(secretsByKey(run)).filter((value) => value !== null));
	for (const { step } of run.entries) {
		if (!isPlainObject(step.entry) || !isPlainObject(step.entry.env)) continue;
		for (const value of Object.values(step.entry.env)) if (typeof value === 'string') values.add(value);
	}
	return [...values];
}

/** A copy of a recorded entry whose `{ "$secret": k }` values are the values of the secrets file; a key it lacks fails the step. */
function resolveEntry(run, entry) {
	const copy = JSON.parse(JSON.stringify(entry));
	if (isPlainObject(copy) && isPlainObject(copy.env)) {
		const text = secretsFileText(run.fs, run.secretsFile);
		for (const [name, value] of Object.entries(copy.env)) {
			if (!isPlainObject(value)) continue;
			const secret = secretsValue(text, value.$secret);
			if (secret === null) throw new StepFailure(`the secrets file has no ${value.$secret} any more`);
			Object.defineProperty(copy.env, name, { value: secret, enumerable: true, writable: true, configurable: true });
		}
	}
	return copy;
}

const restored = (suffix = '') => ({ result: 'restored', suffix });
const skipped = (why) => ({ result: 'skipped', why, state: 'restore-skipped' });
const untouched = (why) => ({ result: 'skipped', why, state: null });

function changedWhileRestoring(label) {
	return new StepFailure(`${label} changed while it was restored, so it was left as it is`);
}

/** The bytes of a file that a step rewrites, read at the real path computed before the restore began. */
function readTarget(run, entry, label) {
	if (entry.realPath === null) throw missingFile();
	const read = readFileRecord(run.fs, entry.realPath);
	if (read.state !== 'ok') throw new StepFailure(`${label} could not be read`);
	return read;
}

function restoreTextBlock(run, entry) {
	const { step } = entry;
	const read = readTarget(run, entry, '~/.claude/CLAUDE.md');
	const { text, utf8Exact } = decode(read.buffer);
	if (!utf8Exact) throw notUtf8(step.file);
	const result = restoreBlock(text, step);
	if (restoreDecision(step, { markerPresent: result.how === 'present' }) === 'skip') return skipped('the block is already there');
	if (!replaceFile(run, entry.realPath, result.text, read.buffer, step.mode)) throw changedWhileRestoring('~/.claude/CLAUDE.md');
	return restored(result.how === 'appended' ? APPENDED_TEXT : '');
}

function restoreJsonMember(run, entry) {
	const { step } = entry;
	const read = readTarget(run, entry, '~/.cursor/mcp.json');
	const { text, utf8Exact } = decode(read.buffer);
	if (!utf8Exact) throw notUtf8(step.file);
	const keyPresent = Object.hasOwn(serversOf(JSON.parse(text)), step.key);
	if (restoreDecision(step, { keyPresent }) === 'skip') return skipped('the member exists again');
	const layout = { position: step.position, indent: step.indent, eol: step.eol, trailingNewline: step.trailingNewline };
	const next = insertJsonMember(text, step.key, resolveEntry(run, step.entry), layout);
	if (!replaceFile(run, entry.realPath, next, read.buffer, step.mode)) throw changedWhileRestoring('~/.cursor/mcp.json');
	return restored();
}

function restoreClaudeEntry(run, entry) {
	const { step } = entry;
	const current = readClaudeJson(run, REGISTRATION_ATTEMPTS);
	if (current === null && readFileRecord(run.fs, run.paths.claudeJson, Infinity).state !== 'missing') throw unusableClaudeJson(run);
	const servers = current === null ? {} : serversOf(current.value);
	if (restoreDecision(step, { keyPresent: Object.hasOwn(servers, CLAUDE_KEY) }) === 'skip') {
		const same = canonicalJson(redactEntry(servers[CLAUDE_KEY], secretsByKey(run)).entry) === canonicalJson(step.entry);
		return skipped(same ? 'the registration is still there' : 'another registration holds this key, so it was left as it is');
	}
	if (run.claudeBin === null) throw new StepFailure(NO_CLAUDE_RESTORE_TEXT);
	if (run.platform === 'win32' && /\.cmd$/i.test(run.claudeBin)) return skipped(WINDOWS_RESTORE_TEXT);
	const json = JSON.stringify(resolveEntry(run, step.entry));
	run.usedAddJson = true;
	const result = runClaude(run, ['mcp', 'add-json', CLAUDE_KEY, json, '--scope', 'user']);
	const outcome = removalOutcome(run);
	if (outcome === 'present') return restored();
	if (outcome === 'unreadable') throw unusableClaudeJson(run);
	throw new StepFailure(removalFailureText(run, result, run.secrets, ADD_FAILED_TEXT));
}

/** Writes a file that is not there, exclusively (an existing file is never replaced) and with the recorded mode; a partial file of ours is removed. */
function createFile(run, file, text, mode) {
	try {
		run.fs.writeFileSync(file, text, { flag: 'wx', mode });
		run.fs.chmodSync(file, mode);
	} catch (err) {
		if (err.code !== 'EEXIST') {
			try {
				run.fs.unlinkSync(file);
			} catch {
				// no partial file to remove
			}
		}
		throw err;
	}
}

function restoreEnvFile(run, entry) {
	const { step, spec } = entry;
	const file = step.path;
	const decision = restoreDecision(step, { fileExists: pathExists(run.fs, file) });
	if (decision === 'skip') return skipped('the .env exists again');
	if (decision === 'missing') return untouched('the .env is not there, so there is no mode to put back');
	if (step.action === 'keep-in-backup') {
		if (!realPathInside(run.fs, file, spec.skillDir) || !run.fs.statSync(file).isFile()) throw new StepFailure(ENV_OUTSIDE_TEXT);
		run.fs.chmodSync(file, step.mode);
		return restored();
	}
	const folder = run.fs.realpathSync(path.dirname(file));
	if (!isInsideRelative(path.relative(run.fs.realpathSync(spec.skillDir), folder))) throw new StepFailure(ENV_OUTSIDE_TEXT);
	const text = secretsFileText(run.fs, run.secretsFile);
	const value = (key) => secretsValue(text, key);
	for (const item of step.template) if (typeof item !== 'string' && value(item.$secret) === null) throw new StepFailure(`the secrets file has no ${item.$secret} any more`);
	createFile(run, file, renderEnvTemplate(step, value), step.mode);
	return restored();
}

/** The EXDEV fallback for a link: it is made again from its text, because a copy of a link that does not resolve from where it lies (a relative one in the backup folder) fails; then the old one is removed. */
function relinkThenRemove(run, from, to) {
	run.fs.symlinkSync(run.fs.readlinkSync(from), to);
	run.fs.unlinkSync(from);
}

/** Copies into `to` every entry of `from` that `to` lacks; an entry that is there stays as it is, a folder of the copy is filled in too. */
function copyMissing(fs, from, to) {
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const source = path.join(from, entry.name);
		const target = path.join(to, entry.name);
		const existing = pathExists(fs, target) ? fs.lstatSync(target) : null;
		if (entry.isDirectory()) {
			if (existing === null) fs.mkdirSync(target);
			if (existing === null || existing.isDirectory()) {
				copyMissing(fs, source, target);
				if (existing === null) fs.chmodSync(target, fs.lstatSync(source).mode & 0o777);
			}
		} else if (existing === null) {
			if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
			else fs.copyFileSync(source, target, nodeFs.constants.COPYFILE_EXCL);
		}
	}
}

function restoreDirectory(run, entry) {
	const { original, backup, method, state } = entry.step;
	const backupExists = pathExists(run.fs, backup);
	const decision = restoreDecision(entry.step, { originalExists: pathExists(run.fs, original), backupExists });
	if (decision === 'skip') {
		const completing = method === 'copy' && state === 'running' && backupExists && run.fs.lstatSync(backup).isDirectory() && run.fs.lstatSync(original).isDirectory();
		if (!completing) return skipped('the folder exists again');
		copyMissing(run.fs, backup, original);
		return restored();
	}
	if (decision === 'missing') throw new StepFailure(NO_FOLDER_TO_PUT_BACK_TEXT);
	const stat = run.fs.lstatSync(backup);
	const isLink = stat.isSymbolicLink();
	if (!isLink && !stat.isDirectory()) throw new StepFailure(NO_FOLDER_TO_PUT_BACK_TEXT);
	run.fs.mkdirSync(path.dirname(original), { recursive: true });
	moveFolder(run, null, backup, original, isLink, { changed: false }, isLink ? relinkThenRemove : undefined);
	return restored();
}

const RESTORERS = {
	'claude-mcp-entry': restoreClaudeEntry,
	'text-block': restoreTextBlock,
	'env-file': restoreEnvFile,
	directory: restoreDirectory,
	'json-member': restoreJsonMember,
	secrets: () => skipped('the added keys stay'),
};

/** The outcome of one step: a step that never ran, failed, or was handled before is left alone; the others are judged by what is on disk (restoreDecision) in their restorer. */
function restoreOne(run, entry) {
	const { step } = entry;
	if (step.state === 'pending') return untouched('this step never ran');
	if (step.state === 'failed') return untouched('this step failed, so there is nothing to undo');
	if (step.state === 'restored' || step.state === 'restore-skipped') return untouched(EARLIER_RESTORE_TEXT);
	try {
		return RESTORERS[step.type](run, entry);
	} catch (err) {
		return { result: 'failed', why: failureText(run, step, err) };
	}
}

/** Records an outcome in its step and returns whether the step changed. A failed restore keeps the state, so the next run tries again; it records its error. */
function settleStep(step, outcome) {
	let { state, error } = step;
	if (outcome.result === 'restored') {
		state = 'restored';
		error = null;
	} else if (outcome.result === 'failed') {
		error = outcome.why;
	} else if (outcome.state !== null) {
		state = outcome.state;
		error = null;
	}
	const changed = state !== step.state || error !== step.error;
	Object.assign(step, { state, error });
	return changed;
}

/**
 * Puts back what applySteps moved, from `<backupDir>/manifest.json`, and returns `{ exitCode, status, lines, usedAddJson }`:
 * exit 2 and status null when it refused before any change (the manifest does not parse, is not one this version writes, or
 * names a place the cleanup does not move or a file whose real path is not the recorded one), else exit 0 and `restored`, or
 * exit 4 and `partially-restored` when a step failed. The manifest is data from disk that may be hostile: every step is
 * checked before the first change, writes go to real paths computed now, and a line holds only a fixed text, an id, or an
 * error through describeError, with every value that may be a secret cut out. The steps run in reverse order; a step is done
 * or running only when it changed something, so those go through restoreDecision and are judged by what is on disk now; a
 * step that failed to restore keeps its state, so a second restore tries it again. The manifest is written once, at the
 * end, and only when something in it changed. `claude mcp add-json` takes the registration with its secrets on the command
 * line: `usedAddJson` is true when it was started, and the lines then carry the note about it.
 */
function restoreSteps(params) {
	requireParams('restoreSteps', params, ['env', 'home']);
	const { env, home, backupDir } = params;
	if (typeof backupDir !== 'string' || !path.isAbsolute(backupDir)) throw new TypeError('restoreSteps needs backupDir');
	const fs = params.fs === undefined ? nodeFs : params.fs;
	const paths = oldInstallPaths(home);
	const manifestFile = path.join(backupDir, MANIFEST_FILE);
	const refuse = (reason) => ({ exitCode: 2, status: null, lines: [`Cannot restore ${showText(shortHome(home, backupDir))}: ${reason}. Nothing was changed.`], usedAddJson: false });

	let manifest;
	let realBackupDir;
	try {
		if (fs.statSync(manifestFile).size > MAX_READ_BYTES) throw Object.assign(new Error('the manifest is too big'), { code: 'EFBIG' });
		manifest = parseJsonText(fs.readFileSync(manifestFile, 'utf8'));
		realBackupDir = fs.realpathSync(backupDir);
	} catch (err) {
		return refuse(describeError(err, manifestFile));
	}
	const entries = checkManifest(manifest, paths);
	if (entries === null) return refuse(`${showText(manifestFile)} is not a manifest this version wrote`);
	const foreign = foreignPlace(fs, backupDir, realBackupDir, entries);
	if (foreign !== null) return refuse(`the manifest names ${showText(foreign)}, which is not a place the cleanup moves`);

	const run = {
		fs,
		env,
		home,
		paths,
		manifest,
		manifestFile,
		entries,
		secretsFile: path.join(home, '.make-custom-app-skill-secrets'),
		spawn: params.spawnSync === undefined ? childProcess.spawnSync : params.spawnSync,
		sleep: params.sleep === undefined ? sleepMs : params.sleep,
		platform: params.platform === undefined ? process.platform : params.platform,
		claudeBin: typeof params.claudeBin === 'string' && params.claudeBin !== '' ? params.claudeBin : null,
		usedAddJson: false,
		secrets: null,
	};
	run.secrets = manifestSecrets(run);

	const lines = [];
	let failed = false;
	let dirty = false;
	for (const entry of [...entries].reverse()) {
		const outcome = restoreOne(run, entry);
		const id = showText(entry.step.id);
		if (outcome.result === 'restored') lines.push(`restored ${id}${outcome.suffix}`);
		else if (outcome.result === 'skipped') lines.push(`skipped  ${id}: ${outcome.why}`);
		else lines.push(`failed   ${id}: ${outcome.why}`);
		failed = failed || outcome.result === 'failed';
		dirty = settleStep(entry.step, outcome) || dirty;
	}
	const status = failed ? 'partially-restored' : 'restored';
	if (manifest.status !== status) {
		manifest.status = status;
		dirty = true;
	}
	if (dirty) {
		try {
			writeManifest(run);
		} catch (err) {
			failed = true;
			lines.push(`failed   manifest: ${describeError(err.cause, manifestFile)}`);
		}
	}
	if (run.usedAddJson) lines.push(ADD_JSON_NOTE);
	lines.push(RESTART_AFTER_RESTORE);
	return { exitCode: failed ? 4 : 0, status: failed ? 'partially-restored' : 'restored', lines: lines.map((line) => redactOutput(line, run.secrets)), usedAddJson: run.usedAddJson };
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
	findBackups,
	restoreSteps,
};
