/**
 * legacy-cleanup-steps.js: the file and process steps of the old-install cleanup (phase B).
 *
 * Role: gatherFacts reads the real file system into the facts that buildPlan (./legacy-cleanup-logic) judges, locateClaude
 * finds and checks the `claude` binary, pluginGuard says whether the cleanup may run, acquireLock keeps two runs apart,
 * and readDecline and writeDecline keep the answer "keep the old install". Nothing here deletes or moves a user file:
 * the gather only reads, and the lock and the marker write only under `<home>/.make-custom-app`.
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
const { SCHEMA, DIGEST_PATTERN, secretsValue } = require('./legacy-cleanup-logic');

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

/** `{ state: 'ok', buffer, mode }`, or `missing` (no such file), `unusable` (not a regular file, or too large), or `error`. */
function readFileRecord(fs, file, limit = MAX_READ_BYTES) {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > limit) return { state: 'unusable' };
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
 * writer may be in the middle of its write). A missing file, or one that is no regular file, ends at once. Returns null
 * when nothing parsed, else `{ text, mode, utf8Exact, value }`. The parser's error is dropped, so no text of the file
 * leaves this function.
 */
function readParsed({ fs, file, parse, attempts, retryMs, sleep }) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (attempt > 0) sleep(retryMs);
		const read = readFileRecord(fs, file);
		if (read.state === 'missing' || read.state === 'unusable') return null;
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
		if (!isDirectoryPath(fs, dir)) return null;
		try {
			return { path: dir, symlink: true, linkTarget: path.resolve(path.dirname(dir), fs.readlinkSync(dir)), skillName: null, version: null, topNames: [], fileCount: 0, sizeBytes: 0 };
		} catch {
			return null;
		}
	}
	if (!stat.isDirectory()) return null;
	const walked = walkFolder(fs, dir);
	if (walked === null) return null;
	const { name, version } = readFrontMatter(fs, path.join(dir, 'SKILL.md'));
	return { path: dir, symlink: false, linkTarget: null, skillName: name, version, ...walked };
}

/** The facts of the Cursor rules folder, or null. A link to a folder lists its top names and is not walked. */
function rulesFolderFacts(fs, dir) {
	let stat;
	try {
		stat = fs.lstatSync(dir);
	} catch {
		return null;
	}
	if (stat.isSymbolicLink()) {
		if (!isDirectoryPath(fs, dir)) return null;
		let names = [];
		try {
			names = fs.readdirSync(dir).sort();
		} catch {
			// a link whose folder cannot be listed has no names to show
		}
		return { path: dir, names, fileCount: 0, sizeBytes: 0 };
	}
	if (!stat.isDirectory()) return null;
	const walked = walkFolder(fs, dir);
	return walked === null ? null : { path: dir, names: walked.topNames, fileCount: walked.fileCount, sizeBytes: walked.sizeBytes };
}

function realPathInside(fs, child, parent) {
	try {
		const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(child));
		return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	} catch {
		return false;
	}
}

/** The `.env` of a skill folder, as read: text, mode, whether its bytes survive UTF-8, and whether its real path lies inside the real path of the folder. */
function envFacts(fs, envFile, skillDir) {
	const read = readFileRecord(fs, envFile);
	if (read.state !== 'ok') return null;
	const { text, utf8Exact } = decode(read.buffer);
	return { path: envFile, text, mode: read.mode, utf8Exact, insideSkill: realPathInside(fs, envFile, skillDir) };
}

function claudeMdFacts(fs, file) {
	const read = readFileRecord(fs, file);
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
	const read = readParsed({ fs, file, parse: parseJsonText, attempts: REGISTRATION_ATTEMPTS, retryMs: REGISTRATION_RETRY_MS, sleep });
	if (read === null || !isPlainObject(read.value) || !isPlainObject(read.value.mcpServers) || !Object.hasOwn(read.value.mcpServers, PLUGIN_NAME)) return null;
	return { file, ...entryFacts(read.value.mcpServers[PLUGIN_NAME], ownRoots) };
}

function cursorMembersFacts({ fs, file, ownRoots, sleep }) {
	const read = readParsed({ fs, file, parse: parseCursorText, attempts: REGISTRATION_ATTEMPTS, retryMs: REGISTRATION_RETRY_MS, sleep });
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
	const read = readFileRecord(fs, file);
	return read.state === 'ok' ? read.buffer.toString('utf8') : null;
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

	const lookalikes = [paths.claudeSkill, paths.cursorSkill, paths.cursorRules].filter((dir) => isLookalikeSkillDir(dir, pluginRoot));
	const ownRoots = ownRootsOf(pluginRoot, lookalikes);
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
};
