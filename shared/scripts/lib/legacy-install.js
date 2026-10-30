const fs = require('fs');
const os = require('os');
const path = require('path');
const { PLUGIN_ROOT } = require('./paths');
const { parseJsonc, isPlaceholder } = require('./settings');

/**
 * Finds what the 2.x installers left behind, so check-setup can warn and make-app-setup can clean up.
 * Detection only: it reads JSON for key names and command paths, and never returns or prints a value from `env`.
 * The old paths are spelled here and nowhere else in shared/scripts (oldInstallPaths).
 */
const SENTINEL_OPEN = '<!-- make-custom-app-skill -->';
const SENTINEL_CLOSE = '<!-- /make-custom-app-skill -->';
const OLD_SKILL_FOLDER = /[\\/]skills[\\/]make-custom-app(?:[\\/]|$)/;

function isDirectory(p) {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** The block the Claude installer wrote into ~/.claude/CLAUDE.md. Markers are whole lines, as the installer matches them. */
function findSentinel(file) {
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return null;
	}
	const lines = text.split(/\r?\n/).map((line) => line.trim());
	const open = lines.indexOf(SENTINEL_OPEN);
	if (open === -1) return null;
	return { kind: 'sentinel', path: file, editor: 'claude', closed: lines.indexOf(SENTINEL_CLOSE, open + 1) !== -1 };
}

function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mcpServersOf(parsed) {
	return isPlainObject(parsed) && isPlainObject(parsed.mcpServers) ? parsed.mcpServers : {};
}

/** The `mcpServers` object of a JSON config file, or {} when the file is missing, malformed or shaped differently. */
function readMcpServers(file) {
	try {
		return mcpServersOf(JSON.parse(fs.readFileSync(file, 'utf8')));
	} catch {
		return {};
	}
}

/**
 * The servers of a config file that may hold comments (Cursor's mcp.json), and how it was read: 'json' (plain JSON),
 * 'jsonc' (only the comment-tolerant parser worked), 'missing' (no file), or 'unreadable' (not a file, or not JSON
 * either way). `servers` is {} unless `mcpServers` is a plain object. Never returns file content.
 */
function readMcpConfig(file) {
	if (typeof file !== 'string' || file === '') throw new TypeError('readMcpConfig needs file');
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (err) {
		return { servers: {}, format: err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'missing' : 'unreadable' };
	}
	try {
		return { servers: mcpServersOf(JSON.parse(text)), format: 'json' };
	} catch {
		// not strict JSON: try again with comments and trailing commas allowed
	}
	try {
		return { servers: mcpServersOf(parseJsonc(text)), format: 'jsonc' };
	} catch {
		return { servers: {}, format: 'unreadable' };
	}
}

const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/** The command and arguments of a server entry that are strings. A part with a `..` segment is left out: it never counts as a path into a folder. */
function entryParts(entry) {
	if (!isPlainObject(entry)) return [];
	return [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].filter((part) => typeof part === 'string' && !PARENT_SEGMENT.test(part));
}

/** True when the command or an argument of a server entry points into an old skill folder (either path separator). */
function pointsIntoOldSkill(entry) {
	return entryParts(entry).some((part) => OLD_SKILL_FOLDER.test(part));
}

/** An absolute path (POSIX or drive letter, either separator) with `/` separators and no trailing one, or null. */
function absolutePath(value) {
	const unified = path.posix.normalize(value.replace(/\\/g, '/'));
	if (!/^(?:\/|[A-Za-z]:\/)/.test(unified)) return null;
	return unified.length > 1 && unified.endsWith('/') ? unified.slice(0, -1) : unified;
}

/** True when the absolute path `file` is the folder or lies inside it (either separator; false for a path that is not absolute and for a filesystem root as the folder). */
function liesInside(file, folder) {
	const target = absolutePath(file);
	const base = absolutePath(folder);
	if (target === null || base === null || base === '/' || /^[A-Za-z]:$/.test(base)) return false;
	return target === base || target.startsWith(`${base}/`);
}

/**
 * True when a registration is the old skill's: it points into an old skill folder, or `mcpServerPath` (the
 * `mcp-server-path:` line of the secrets file) is set and the command or an argument lies inside it. Any other
 * registration, such as one that points at the plugin bundle or at an unrelated path, is not an old install.
 * An `mcpServerPath` with a `..` segment is not usable: it could name a folder above the one it spells.
 * The plugin's own registration must be taken out first (dropOwnParts), because an `mcpServerPath` above the plugin
 * folder would otherwise cover it.
 */
function isOldRegistration(entry, mcpServerPath) {
	if (pointsIntoOldSkill(entry)) return true;
	if (typeof mcpServerPath !== 'string' || mcpServerPath === '' || PARENT_SEGMENT.test(mcpServerPath)) return false;
	return entryParts(entry).some((part) => liesInside(part, mcpServerPath));
}

/** The real path of the deepest folder that exists, joined with the rest, so a path that does not exist yet can be compared. */
function realishPath(value) {
	const rest = [];
	let current = path.resolve(value);
	for (;;) {
		try {
			return path.join(fs.realpathSync(current), ...rest);
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(value);
			rest.unshift(path.basename(current));
			current = parent;
		}
	}
}

/**
 * The folders whose files are never the old skill's: the running plugin and any folder that is a plugin, each as given
 * and as its real path. A folder name that is not a non-empty string is skipped.
 */
function ownRootsOf(pluginRoot, folders = []) {
	const roots = new Set();
	for (const folder of [pluginRoot, ...folders]) {
		if (typeof folder !== 'string' || folder === '') continue;
		roots.add(folder);
		if (path.isAbsolute(folder)) roots.add(realishPath(folder));
	}
	return [...roots];
}

/**
 * `{ command, args }` of a server entry without the parts that lie inside an own root (ownRootsOf), compared as written
 * and by real path, so a registration that names the plugin folder through a symbolic link is still the plugin's. The
 * result has no `env`. Returns a value that is not an entry as it is.
 */
function dropOwnParts(entry, ownRoots) {
	if (!isPlainObject(entry)) return entry;
	const own = (part) => typeof part === 'string' && ownRoots.some((root) => liesInside(part, root) || (path.isAbsolute(part) && liesInside(realishPath(part), root)));
	return { command: own(entry.command) ? undefined : entry.command, args: Array.isArray(entry.args) ? entry.args.filter((part) => !own(part)) : entry.args };
}

/** Every place the 2.x installers write to, under `home` (required). */
function oldInstallPaths(home) {
	if (typeof home !== 'string' || home === '') throw new TypeError('oldInstallPaths needs home');
	const claudeSkill = path.join(home, '.claude', 'skills', 'make-custom-app');
	const cursorSkill = path.join(home, '.cursor', 'skills', 'make-custom-app');
	return {
		claudeSkill,
		claudeEnv: path.join(claudeSkill, 'mcp-server', '.env'),
		claudeJson: path.join(home, '.claude.json'),
		claudeMd: path.join(home, '.claude', 'CLAUDE.md'),
		cursorSkill,
		cursorEnv: path.join(cursorSkill, 'mcp-server', '.env'),
		cursorRules: path.join(home, '.cursor', 'rules', 'make-custom-app'),
		cursorMcp: path.join(home, '.cursor', 'mcp.json'),
		claudeContexts: path.join(home, '.claude', 'make-app-contexts'),
		cursorContexts: path.join(home, '.cursor', 'make-app-contexts'),
	};
}

/**
 * True when a folder named like the old skill is not the old skill: it is a plugin installed as a skills folder (it
 * holds .claude-plugin or .cursor-plugin), or it holds the running plugin (the real path of `pluginRoot` is the folder
 * or lies inside it). Removing it would remove the plugin.
 */
function isLookalikeSkillDir(dir, pluginRoot) {
	if (typeof dir !== 'string' || dir === '' || typeof pluginRoot !== 'string' || pluginRoot === '') throw new TypeError('isLookalikeSkillDir needs dir and pluginRoot');
	if (isDirectory(path.join(dir, '.claude-plugin')) || isDirectory(path.join(dir, '.cursor-plugin'))) return true;
	try {
		const relative = path.relative(fs.realpathSync(dir), fs.realpathSync(pluginRoot));
		return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	} catch {
		return false;
	}
}

/** The last usable `mcp-server-path:` value of the secrets file under `home`, trimmed, or undefined. */
function readMcpServerPath(home) {
	let text;
	try {
		text = fs.readFileSync(path.join(home, '.make-custom-app-skill-secrets'), 'utf8');
	} catch {
		return undefined;
	}
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const match = /^mcp-server-path:\s*(.+)$/.exec(lines[i].trim());
		if (match && !isPlaceholder(match[1].trim())) return match[1].trim();
	}
	return undefined;
}

/**
 * Every old 2.x artefact that exists under `home`, as { kind, path, editor }. A sentinel item also has `closed`,
 * an 'mcp-entry' item also has `name` (the key in mcpServers), and a Cursor 'mcp-entry' item also has `format`
 * ('json' or 'jsonc', how mcp.json was read).
 * Kinds: 'skill-dir', 'rules-dir', 'sentinel', 'mcp-entry'.
 * A skill folder that is a plugin or holds the running plugin (`pluginRoot`) is skipped, and so is every registration
 * part that lies inside such a folder or inside `pluginRoot` (the plugin's own server is never old, whatever
 * `mcpServerPath` names above it). The Claude `make-custom-app` entry counts only when isOldRegistration says so
 * (`mcpServerPath` defaults to the `mcp-server-path:` line of the secrets file under `home`; null or '' turns it
 * off); another entry of that name would never be removed, so it must not raise the warning. `pluginRoot` must be a
 * non-empty string when it is given (a TypeError otherwise); without it the running plugin is used.
 */
function detectLegacyInstall({ home = os.homedir(), pluginRoot = PLUGIN_ROOT, mcpServerPath } = {}) {
	if (typeof pluginRoot !== 'string' || pluginRoot === '') throw new TypeError('detectLegacyInstall needs pluginRoot');
	const paths = oldInstallPaths(home);
	const serverPath = mcpServerPath === undefined ? readMcpServerPath(home) : mcpServerPath;
	const items = [];
	const lookalikes = [paths.claudeSkill, paths.cursorSkill].filter((dir) => isDirectory(dir) && isLookalikeSkillDir(dir, pluginRoot));
	const ownRoots = ownRootsOf(pluginRoot, lookalikes);
	const skillDir = (editor, dir) => {
		if (isDirectory(dir) && !lookalikes.includes(dir)) items.push({ kind: 'skill-dir', path: dir, editor });
	};

	skillDir('claude', paths.claudeSkill);
	const sentinel = findSentinel(paths.claudeMd);
	if (sentinel) items.push(sentinel);
	const claudeServers = readMcpServers(paths.claudeJson);
	if (Object.hasOwn(claudeServers, 'make-custom-app') && isOldRegistration(dropOwnParts(claudeServers['make-custom-app'], ownRoots), serverPath)) {
		items.push({ kind: 'mcp-entry', path: paths.claudeJson, editor: 'claude', name: 'make-custom-app' });
	}

	skillDir('cursor', paths.cursorSkill);
	if (isDirectory(paths.cursorRules)) items.push({ kind: 'rules-dir', path: paths.cursorRules, editor: 'cursor' });
	const cursor = readMcpConfig(paths.cursorMcp);
	for (const [name, entry] of Object.entries(cursor.servers)) {
		if (pointsIntoOldSkill(dropOwnParts(entry, ownRoots))) items.push({ kind: 'mcp-entry', path: paths.cursorMcp, editor: 'cursor', name, format: cursor.format });
	}
	return items;
}

function describeItem(item) {
	if (item.kind === 'skill-dir') return 'old skill folder';
	if (item.kind === 'rules-dir') return 'old Cursor rule folder';
	if (item.kind === 'sentinel') return item.closed ? 'old skill block' : 'old skill block, closing marker missing';
	return `old MCP server entry "${item.name}"`;
}

/** The warning check-setup prints: one LEGACY_INSTALL line, then one line per item. Empty when nothing is left over. */
function legacyInstallLines(items) {
	if (items.length === 0) return [];
	return [
		`LEGACY_INSTALL: ${items.length} old install item(s) found; run the make-app-setup skill to clean up`,
		...items.map((item) => `  ${item.path} (${describeItem(item)})`),
	];
}

module.exports = {
	SENTINEL_OPEN,
	SENTINEL_CLOSE,
	OLD_SKILL_FOLDER,
	pointsIntoOldSkill,
	liesInside,
	readMcpServers,
	isOldRegistration,
	readMcpConfig,
	oldInstallPaths,
	isLookalikeSkillDir,
	ownRootsOf,
	dropOwnParts,
	detectLegacyInstall,
	legacyInstallLines,
};
