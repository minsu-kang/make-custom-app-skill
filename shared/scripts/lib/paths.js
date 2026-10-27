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
 * Order: --editor flag, CLAUDECODE, CURSOR_AGENT, the `editor:` line of the secrets file.
 * CLAUDECODE wins when both variables are set (Claude Code started from a Cursor terminal).
 * Both editors share the secrets file, so its `editor:` line only decides when the environment does not,
 * and a bad value is reported only then.
 */
function resolveEditor({ env = process.env, configured = null, flag = null } = {}) {
	if (flag) return validEditor(flag, '--editor flag');
	if (env.CLAUDECODE) return 'claude';
	if (env.CURSOR_AGENT) return 'cursor';
	if (configured) return validEditor(configured, 'editor: line in the secrets file');
	throw new EditorError(
		'Cannot tell which editor runs this script (CLAUDECODE and CURSOR_AGENT are both unset). ' +
			'Add "editor: claude" or "editor: cursor" to ~/.make-custom-app-skill-secrets, or pass --editor claude|cursor.',
	);
}

function validEditor(value, source) {
	if (!EDITORS.includes(value)) throw new EditorError(`Invalid editor "${value}" from ${source}. Use claude or cursor.`);
	return value;
}

/**
 * The command a user runs in their own terminal to fill in credentials. The script path is in double
 * quotes so a folder with a space stays one argument in bash, zsh, cmd and PowerShell. An embedded
 * double quote is backslash-escaped; nothing else is, so a path with $ or a backtick still breaks on POSIX.
 */
function setupCommand(editor, scriptsDir = SCRIPTS_DIR) {
	const script = path.join(scriptsDir, 'setup-secrets.js').replace(/"/g, '\\"');
	const flag = editor ? ` --editor ${editor}` : '';
	return `node "${script}"${flag}`;
}

module.exports = { SCRIPTS_DIR, PLUGIN_ROOT, EditorError, getContextsDir, resolveEditor, setupCommand };
