/**
 * review-changes-logic.js: the decisions and texts behind review-changes.js (spec 3.3 and 3.4): the arguments, the
 * state and diff answers of the Make API, the route of the result table, and the review document. Pure functions only.
 */
const { fixesFor } = require('./download-app-logic');
const { sortIds } = require('./snapshot-logic');
const { MARKER_STRING, maskCommon } = require('./common-mask-logic');

/** Whether a state answer of an unapproved app without `changes` reads as an empty list (spec 3.4 step 2, settled by the live check). */
const ABSENT_CHANGES_UNAPPROVED_IS_EMPTY = false;
const EMPTY_LINE = 'No changes found.';
const APPROVED_EMPTY_LINE = 'No pending changes on this approved app.';
const USAGE_LINES = [
	'Usage: node review-changes.js <app-slug> <app-version> [--baseline <id|latest>]',
	'Example: node review-changes.js google-docs 1',
	'        node review-changes.js google-docs 1 --baseline latest',
];
const BASELINE_VALUE_ERROR = 'ERROR: --baseline needs a snapshot id or latest.';
const UNEXPECTED = 'unexpected response';
/** The fix line of a state answer without a change list for an unapproved app: a retry gets the same answer. */
const NO_CHANGES_FIELD_FIX = 'A retry gets the same answer, because Make sent no change list for this app. Review the full app code instead.';

/** { slug, version, baseline, error }: error is null when the arguments are usable, '' for the usage alone. */
function parseArgs(argv) {
	const positional = [];
	let baseline = null;
	const failure = (error) => ({ slug: null, version: null, baseline: null, error });
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--baseline' || arg.startsWith('--baseline=')) {
			const value = arg === '--baseline' ? argv[++i] : arg.slice('--baseline='.length);
			if (!value || value.startsWith('--')) return failure(BASELINE_VALUE_ERROR);
			baseline = value;
		} else if (arg.startsWith('--')) {
			return failure(`ERROR: unknown flag ${arg}`);
		} else {
			positional.push(arg);
		}
	}
	const [slug, version] = positional;
	if (!slug || !version || positional.length > 2) return failure('');
	return { slug, version, baseline, error: null };
}

/** A change row in either shape (group, item, code or table, name, column) with a label, or null when it has neither. */
function normalizeRow(row) {
	if (!row || typeof row !== 'object' || row.id === undefined || row.id === null) return null;
	if (typeof row.group === 'string' && typeof row.code === 'string') {
		const item = typeof row.item === 'string' && row.item ? row.item : null;
		return { id: row.id, group: row.group, item, code: row.code, label: [row.group, item, row.code].filter(Boolean).join('/') };
	}
	if (typeof row.table === 'string' && typeof row.name === 'string' && typeof row.column === 'string') {
		return { id: row.id, group: row.table, item: row.name, code: row.column, label: `${row.table}/${row.name}/${row.column}` };
	}
	return null;
}

/** The state answer: { changes, approved } with approved true, false or null, or { reason } (with a fix line when a retry cannot help). */
function parseState(body, { absentIsEmpty = ABSENT_CHANGES_UNAPPROVED_IS_EMPTY } = {}) {
	const app = body && typeof body === 'object' && body.app && typeof body.app === 'object' ? body.app : null;
	if (!app) return { reason: UNEXPECTED };
	const approved = typeof app.approved === 'boolean' ? app.approved : null;
	if (app.changes === undefined && approved === false) {
		return absentIsEmpty ? { changes: [], approved } : { reason: `${UNEXPECTED}: no changes field (approved: false)`, fix: NO_CHANGES_FIELD_FIX };
	}
	if (!Array.isArray(app.changes)) return { reason: UNEXPECTED };
	const changes = app.changes.map(normalizeRow);
	if (changes.includes(null)) return { reason: `${UNEXPECTED}: a change row without an id and a group and code, or a table, name and column` };
	return { changes, approved };
}

function formatValue(value) {
	if (value === null || value === undefined) return null;
	return typeof value === 'object' ? JSON.stringify(value, null, 4) : String(value);
}

/** The old and new value of one diff answer in any known spelling, or { reason } when neither side is there. */
function diffValues(body) {
	const oldValue = body.old_value ?? body.oldValue ?? body.change?.oldValue ?? null;
	const newValue = body.new_value ?? body.newValue ?? body.change?.newValue ?? null;
	if (oldValue === null && newValue === null) return { reason: UNEXPECTED };
	return { old_value: formatValue(oldValue), new_value: formatValue(newValue) };
}

/**
 * The diff values as the review may save them. In public mode both sides of a common change are masked the way
 * download-app.js masks common data, and a side that is not a JSON object becomes the string marker, so a real value
 * never reaches disk (spec decision 6). Other changes, and every change in employee mode, stay as they are.
 */
function maskedDiffValues({ mode, code, values }) {
	if (mode !== 'public' || code !== 'common') return values;
	const mask = (text) => {
		if (text === null) return null;
		const masked = maskCommon(text);
		return masked.error ? MARKER_STRING : masked.text;
	};
	return { ...values, old_value: mask(values.old_value), new_value: mask(values.new_value) };
}

function languageOf(code) {
	return code === 'code' || code === 'test' ? 'js' : 'imljson';
}

/** The result table of spec 3.4: 'api', 'baseline', 'empty' (employee) or 'approvedEmpty' (public). */
function chooseRoute({ mode, approved, rowCount, baseline }) {
	if (baseline) return 'baseline';
	if (rowCount > 0) return 'api';
	if (mode === 'employee') return 'empty';
	return approved === true ? 'approvedEmpty' : 'baseline';
}

/** The first exit 2 message of spec 3.3; a --baseline run that found no snapshot leaves out the line about approval. */
function noSnapshotLines({ slug, version, command, explicit }) {
	const lines = [
		'No change list: this app is not approved, so Make applies every push at once and keeps no change rows.',
		`No snapshot of ${slug} v${version} exists to compare with, so no review file was written.`,
		`Review the full app code. Before the next push, run: ${command} ${slug} ${version} --snapshot`,
	];
	return explicit ? lines.slice(1) : lines;
}

/** The second exit 2 message of spec 3.3, with the snapshot ids newest first. */
function unknownSnapshotLine({ slug, version, id, ids }) {
	const newestFirst = sortIds(ids).reverse();
	return `Snapshot ${id} of ${slug} v${version} does not exist. Snapshots: ${newestFirst.length ? newestFirst.join(', ') : 'none'}.`;
}

function noLocalCopyLine({ slug, version }) {
	return `No local copy of ${slug} v${version} to compare. Run download-app.js ${slug} ${version} first.`;
}

/** The failure of a working copy or snapshot that cannot be read: its code, and no fix line, because no call failed. */
function localCopyFailure(err) {
	return { what: 'local copy', reason: err.code || 'unreadable', local: true };
}

function failedLines(failed) {
	const lines = [`Failed: ${failed.length}`];
	for (const f of failed) lines.push(`  ✗ ${f.what} (${f.reason})`);
	for (const fix of fixesFor(failed.filter((f) => !f.local))) lines.push(`  ${fix}`);
	return lines;
}

function failedErrorLine(count) {
	return `ERROR: ${count} call(s) failed, so no review was written. Show the failed calls above to the user; do not review from an older latest.json.`;
}

/** The stop line of a file or folder that cannot be read or written; `verb` is 'read' or 'write'. */
function fileErrorLine({ verb, file, code }) {
	return `ERROR: cannot ${verb} ${file} (${code || 'error'})`;
}

function baselineSummaryLines({ id, takenAt, counts, edited, saved }) {
	return [
		`Baseline: snapshot ${id} (taken ${takenAt})`,
		`Changes: ${counts.total} (modified ${counts.modified}, added ${counts.added}, removed ${counts.removed})`,
		`Working copy has unpushed edits: ${edited ? 'yes' : 'no'}`,
		`Saved: ${saved}`,
	];
}

/** The content of reviews/latest.json; the API route has no baseline and no edit flag. */
function reviewDocument({ slug, version, fetchedAt, source, approved, baseline = null, workingCopyEdited = null, changes }) {
	return { appSlug: slug, appVersion: version, fetchedAt, source, approved, baseline, workingCopyEdited, totalChanges: changes.length, changes };
}

module.exports = {
	ABSENT_CHANGES_UNAPPROVED_IS_EMPTY,
	EMPTY_LINE,
	APPROVED_EMPTY_LINE,
	USAGE_LINES,
	parseArgs,
	normalizeRow,
	parseState,
	formatValue,
	diffValues,
	maskedDiffValues,
	languageOf,
	chooseRoute,
	noSnapshotLines,
	unknownSnapshotLine,
	noLocalCopyLine,
	localCopyFailure,
	failedLines,
	failedErrorLine,
	fileErrorLine,
	baselineSummaryLines,
	reviewDocument,
};
