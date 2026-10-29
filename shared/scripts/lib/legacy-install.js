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
 */
function isOldRegistration(entry, mcpServerPath) {
	if (pointsIntoOldSkill(entry)) return true;
	if (typeof mcpServerPath !== 'string' || mcpServerPath === '') return false;
	return entryParts(entry).some((part) => liesInside(part, mcpServerPath));
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
 * A skill folder that is a plugin or holds the running plugin (`pluginRoot`) is skipped. The Claude `make-custom-app`
 * entry counts only when isOldRegistration says so (`mcpServerPath` defaults to the `mcp-server-path:` line of the
 * secrets file under `home`); another entry of that name would never be removed, so it must not raise the warning.
 */
function detectLegacyInstall({ home = os.homedir(), pluginRoot = PLUGIN_ROOT, mcpServerPath } = {}) {
	const paths = oldInstallPaths(home);
	const serverPath = mcpServerPath === undefined ? readMcpServerPath(home) : mcpServerPath;
	const items = [];
	const skillDir = (editor, dir) => {
		if (isDirectory(dir) && !isLookalikeSkillDir(dir, pluginRoot)) items.push({ kind: 'skill-dir', path: dir, editor });
	};

	skillDir('claude', paths.claudeSkill);
	const sentinel = findSentinel(paths.claudeMd);
	if (sentinel) items.push(sentinel);
	const claudeServers = readMcpServers(paths.claudeJson);
	if (Object.hasOwn(claudeServers, 'make-custom-app') && isOldRegistration(claudeServers['make-custom-app'], serverPath)) {
		items.push({ kind: 'mcp-entry', path: paths.claudeJson, editor: 'claude', name: 'make-custom-app' });
	}

	skillDir('cursor', paths.cursorSkill);
	if (isDirectory(paths.cursorRules)) items.push({ kind: 'rules-dir', path: paths.cursorRules, editor: 'cursor' });
	const cursor = readMcpConfig(paths.cursorMcp);
	for (const [name, entry] of Object.entries(cursor.servers)) {
		if (pointsIntoOldSkill(entry)) items.push({ kind: 'mcp-entry', path: paths.cursorMcp, editor: 'cursor', name, format: cursor.format });
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
	readMcpServers,
	isOldRegistration,
	readMcpConfig,
	oldInstallPaths,
	isLookalikeSkillDir,
	detectLegacyInstall,
	legacyInstallLines,
};
