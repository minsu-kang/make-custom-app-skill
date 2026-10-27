const os = require('os');
const path = require('path');

/**
 * Where things live in the plugin layout. Scripts find themselves with __dirname because
 * the plugin variables are not in the Bash environment.
 *
 *   <plugin root>/shared/scripts/lib/paths.js   (this file)
 */
const SCRIPTS_DIR = path.resolve(__dirname, '..');
const PLUGIN_ROOT = path.resolve(SCRIPTS_DIR, '..', '..');

const EDITORS = ['claude', 'cursor'];

class EditorError extends Error {
	constructor(message) {
		super(message);
		this.name = 'EditorError';
		this.code = 'EDITOR_UNRESOLVED';
	}
}

/** App contexts live in one editor-neutral folder. */
function getContextsDir(home = os.homedir()) {
	return path.join(home, '.make-custom-app', 'contexts');
}

/**
 * Which editor runs the script. It selects the Make credential source, so there is no silent default.
 * Order: --editor flag, the `editor:` line of the secrets file, CLAUDECODE, CURSOR_AGENT.
 * CLAUDECODE wins when both variables are set (Claude Code started from a Cursor terminal).
 */
function resolveEditor({ env = process.env, configured = null, flag = null } = {}) {
	for (const [source, value] of [
		['--editor flag', flag],
		['editor: line in the secrets file', configured],
	]) {
		if (value === null || value === undefined || value === '') continue;
		if (!EDITORS.includes(value)) throw new EditorError(`Invalid editor "${value}" from ${source}. Use claude or cursor.`);
		return value;
	}
	if (env.CLAUDECODE) return 'claude';
	if (env.CURSOR_AGENT) return 'cursor';
	throw new EditorError(
		'Cannot tell which editor runs this script (CLAUDECODE and CURSOR_AGENT are both unset). ' +
			'Add "editor: claude" or "editor: cursor" to ~/.make-custom-app-skill-secrets, or pass --editor claude|cursor.',
	);
}

/** The command a user runs in their own terminal to fill in credentials. */
function setupCommand(editor) {
	const flag = editor ? ` --editor ${editor}` : '';
	return `node ${path.join(SCRIPTS_DIR, 'setup-secrets.js')}${flag}`;
}

module.exports = { SCRIPTS_DIR, PLUGIN_ROOT, EditorError, getContextsDir, resolveEditor, setupCommand };
