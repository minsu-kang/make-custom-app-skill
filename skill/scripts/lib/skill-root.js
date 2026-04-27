const path = require('path');
const os = require('os');

/**
 * Derive the skill root from the invocation path (process.argv[1]).
 * Works for both ~/.cursor/skills/make-custom-app/ and ~/.claude/skills/make-custom-app/.
 * Do NOT use __dirname.
 */
function getSkillRoot() {
	const scriptPath = process.argv[1];
	const match = scriptPath.match(/^(.+?(?:\.cursor|\.claude)\/skills\/make-custom-app)/);
	if (match) return match[1];
	// fallback: prefer .claude if exists, else .cursor
	const fs = require('fs');
	const claudePath = path.join(os.homedir(), '.claude', 'skills', 'make-custom-app');
	return fs.existsSync(claudePath) ? claudePath : path.join(os.homedir(), '.cursor', 'skills', 'make-custom-app');
}

/**
 * Derive the editor dot-dir (.claude or .cursor) from process.argv[1].
 */
function getEditorDir() {
	const scriptPath = process.argv[1];
	if (scriptPath.includes('/.claude/')) return '.claude';
	return '.cursor';
}

module.exports = { getSkillRoot, getEditorDir };
