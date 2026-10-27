const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Finds what the 2.x installers left behind, so check-setup can warn and make-app-setup can clean up.
 * Detection only: it reads JSON for key names and command paths, and never returns or prints a value from `env`.
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

/** The `mcpServers` object of a JSON config file, or {} when the file is missing, malformed or shaped differently. */
function readMcpServers(file) {
	try {
		const servers = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers;
		return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {};
	} catch {
		return {};
	}
}

/** True when the command or an argument of a server entry points into an old skill folder (either path separator). */
function pointsIntoOldSkill(entry) {
	if (!entry || typeof entry !== 'object') return false;
	const parts = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
	return parts.some((part) => typeof part === 'string' && OLD_SKILL_FOLDER.test(part));
}

/**
 * Every old 2.x artefact that exists under `home`, as { kind, path, editor }. A sentinel item also has `closed`,
 * an 'mcp-entry' item also has `name` (the key in mcpServers).
 * Kinds: 'skill-dir', 'rules-dir', 'sentinel', 'mcp-entry'.
 */
function detectLegacyInstall({ home = os.homedir() } = {}) {
	const items = [];
	const folder = (kind, editor, ...parts) => {
		const dir = path.join(home, ...parts);
		if (isDirectory(dir)) items.push({ kind, path: dir, editor });
	};

	folder('skill-dir', 'claude', '.claude', 'skills', 'make-custom-app');
	const sentinel = findSentinel(path.join(home, '.claude', 'CLAUDE.md'));
	if (sentinel) items.push(sentinel);
	const claudeJson = path.join(home, '.claude.json');
	if (Object.hasOwn(readMcpServers(claudeJson), 'make-custom-app')) items.push({ kind: 'mcp-entry', path: claudeJson, editor: 'claude', name: 'make-custom-app' });

	folder('skill-dir', 'cursor', '.cursor', 'skills', 'make-custom-app');
	folder('rules-dir', 'cursor', '.cursor', 'rules', 'make-custom-app');
	const cursorJson = path.join(home, '.cursor', 'mcp.json');
	for (const [name, entry] of Object.entries(readMcpServers(cursorJson))) {
		if (pointsIntoOldSkill(entry)) items.push({ kind: 'mcp-entry', path: cursorJson, editor: 'cursor', name });
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

module.exports = { detectLegacyInstall, legacyInstallLines };
