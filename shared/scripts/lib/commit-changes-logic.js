/**
 * commit-changes-logic.js: the texts and the message rule of commit-changes.js (spec 3.5 rows 1 to 6 and 22).
 *
 * Role: pure functions only. The mode goes in, the lines come out: no network, no file access, no process.exit, no
 * console. Employee mode keeps the wording it had before the public texts.
 */
const MESSAGE_MAX_LENGTH = 1000;
const MESSAGE_ERROR = 'ERROR: --message is required and must be 1 to 1000 characters.';
const AFTER_ROLLBACK_LINE = '  Run download-app.js again so the local copy matches the app.';

const USAGE_LINES = [
	'Usage: node commit-changes.js <app-slug> <app-version> <commit|rollback|compile> [options]',
	'',
	'  commit    --message="..." [--change-ids=1,2] [--notify] [--issue=KEY]',
	'            (--issue is for Make employees only)',
	'  rollback  --confirm            (discards ALL pending changes)',
	'  compile   [--issue=KEY]        (Make employees only)',
	'',
	'Example: node commit-changes.js my-app 1 commit --message="Fix pagination of the list module"',
];

const EMPLOYEE_NOT_APPROVED_LINE = '  App is not approved (approved: false) → SDK edits write directly to the DB and never create change rows.';
const EMPLOYEE_FORWARD_LINE = '  There is nothing to commit; the forward action for this app is `compile`.';
const EMPLOYEE_AFTER_COMMIT_LINE = '  A compile is enqueued automatically by the commit routine.';

const PUBLIC_UNAPPROVED_LINES = [
	'ABORT: nothing to commit.',
	'  This app is not approved, so Make keeps no change list for it. Every push you made is already live on the app.',
	'  There is nothing to commit, compile or roll back. A manual rollback uses the local snapshot taken before the first push.',
];
const PUBLIC_APPROVED_LINES = [
	'ABORT: no pending changes to commit.',
	'  This app is approved: pushes wait as pending changes until they are committed, and none are waiting now.',
];
const PUBLIC_UNKNOWN_LINES = [
	'ABORT: no pending changes to commit.',
	'  Make did not say whether this app is approved. On an app that is not approved every push is live at once and there is nothing to commit.',
];
const PUBLIC_AFTER_COMMIT_LINE = '  Run download-app.js again to confirm that the local copy matches the committed app.';

/** The usage block, printed in both modes (it runs before the mode is known). */
function usageLines() {
	return [...USAGE_LINES];
}

function isValidMessage(message) {
	return typeof message === 'string' && message.length > 0 && message.length <= MESSAGE_MAX_LENGTH;
}

/** The stderr lines when a commit finds no pending change row; `approved` is the answer of Make or undefined. */
function noChangesLines({ mode, approved }) {
	if (mode !== 'public') {
		const lines = ['ABORT: no pending changes to commit.'];
		if (approved === false) lines.push(EMPLOYEE_NOT_APPROVED_LINE, EMPLOYEE_FORWARD_LINE);
		return lines;
	}
	if (approved === false) return [...PUBLIC_UNAPPROVED_LINES];
	if (approved === true) return [...PUBLIC_APPROVED_LINES];
	return [...PUBLIC_UNKNOWN_LINES];
}

/** The line printed after a successful commit. */
function afterCommitLine(mode) {
	return mode === 'public' ? PUBLIC_AFTER_COMMIT_LINE : EMPLOYEE_AFTER_COMMIT_LINE;
}

module.exports = { MESSAGE_MAX_LENGTH, MESSAGE_ERROR, AFTER_ROLLBACK_LINE, usageLines, isValidMessage, noChangesLines, afterCommitLine };
