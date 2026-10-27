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

let editorFlag = null;

/**
 * Removes every `--editor <value>` pair and every `--editor=<value>` from argv in place, so a script's own
 * positional parsing never sees the flag. Remembers the last value (getEditorFlag) and returns it, or returns null
 * when argv has no flag, leaving the remembered value as it was. The value is not checked here; resolveEditor does that.
 * A flag with no value (end of argv, an empty value, or a next item that starts with `--`) throws EditorError.
 */
function takeEditorFlag(argv) {
	let found = null;
	for (let i = 0; i < argv.length; ) {
		const arg = argv[i];
		let value;
		let width = 1;
		if (arg === '--editor') {
			value = argv[i + 1];
			width = 2;
		} else if (arg.startsWith('--editor=')) {
			value = arg.slice('--editor='.length);
		} else {
			i++;
			continue;
		}
		if (!value || value.startsWith('--')) throw new EditorError('--editor needs a value: claude or cursor.');
		found = value;
		argv.splice(i, width);
	}
	if (found !== null) editorFlag = found;
	return found;
}

/** The value takeEditorFlag remembered, or null. */
function getEditorFlag() {
	return editorFlag;
}

/** Forgets the remembered value (for tests). */
function resetEditorFlag() {
	editorFlag = null;
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

module.exports = {
	SCRIPTS_DIR,
	PLUGIN_ROOT,
	EditorError,
	getContextsDir,
	resolveEditor,
	setupCommand,
	takeEditorFlag,
	getEditorFlag,
	resetEditorFlag,
};
