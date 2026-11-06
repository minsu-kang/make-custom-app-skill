/**
 * Tests for review-changes-logic.js: the arguments, the state and diff answers of the Make API, the route of spec 3.4,
 * and the texts of spec 3.3 and 3.4. No network and no files: review-changes.test.js runs the script.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const r = require('../review-changes-logic');
const { AUTH_FIX, RETRY_FIX } = require('../download-app-logic');

describe('parseState', () => {
	it('accepts both row shapes and gives real labels', () => {
		const out = r.parseState({ app: { approved: true, changes: [{ id: 1, group: 'module', item: 'listItems', code: 'api' }, { id: 2, group: 'app', code: 'base' }, { id: 3, table: 'module', name: 'getItem', column: 'expect' }] } });
		assert.deepEqual(out.changes.map((c) => c.label), ['module/listItems/api', 'app/base', 'module/getItem/expect']);
		assert.deepEqual(out.changes[2], { id: 3, group: 'module', item: 'getItem', code: 'expect', label: 'module/getItem/expect' });
		assert.equal(out.approved, true);
	});

	it('fails on a body without app.changes, a row without an id or a full shape, and on a non-object', () => {
		assert.deepEqual(r.parseState({ app: { approved: true } }), { reason: 'unexpected response' });
		assert.deepEqual(r.parseState({ app: { approved: false } }), { reason: 'unexpected response: no changes field (approved: false)', fix: 'A retry gets the same answer, because Make sent no change list for this app. Review the full app code instead.' });
		assert.deepEqual(r.parseState({ app: { changes: 'x' } }), { reason: 'unexpected response' });
		assert.match(r.parseState({ app: { changes: [{ group: 'module', code: 'api' }] } }).reason, /^unexpected response/);
		assert.match(r.parseState({ app: { changes: [{ id: 1, table: 'module', name: 'x' }] } }).reason, /^unexpected response/);
		assert.deepEqual(r.parseState(null), { reason: 'unexpected response' });
	});

	it('reads the absent-changes case of an unapproved app as empty only when the rule says so', () => {
		assert.deepEqual(r.parseState({ app: { approved: false } }, { absentIsEmpty: true }), { changes: [], approved: false });
		assert.deepEqual(r.parseState({ app: { approved: null } }, { absentIsEmpty: true }), { reason: 'unexpected response' });
	});

	it('keeps approved as true, false or null', () => {
		assert.equal(r.parseState({ app: { changes: [] } }).approved, null);
		assert.equal(r.parseState({ app: { changes: [], approved: 'yes' } }).approved, null);
	});

	it('keeps the rule constant false until the live check settles it (spec 3.4 step 2)', () => {
		assert.equal(r.ABSENT_CHANGES_UNAPPROVED_IS_EMPTY, false);
	});

	it('fails on a body whose app is not an object', () => {
		assert.deepEqual(r.parseState({ app: 'x' }), { reason: 'unexpected response' });
		assert.deepEqual(r.parseState('text'), { reason: 'unexpected response' });
	});
});

describe('normalizeRow', () => {
	it('gives the group and code shape with an optional item, and the table shape', () => {
		assert.deepEqual(r.normalizeRow({ id: 0, group: 'app', item: '', code: 'common' }), { id: 0, group: 'app', item: null, code: 'common', label: 'app/common' });
		assert.deepEqual(r.normalizeRow({ id: 'a', group: 'function', item: 7, code: 'code' }), { id: 'a', group: 'function', item: null, code: 'code', label: 'function/code' });
		assert.deepEqual(r.normalizeRow({ id: 4, table: 'rpc', name: 'list', column: 'api' }), { id: 4, group: 'rpc', item: 'list', code: 'api', label: 'rpc/list/api' });
	});

	it('gives null for a row that is no object, has no id, or has neither shape', () => {
		for (const row of [null, 'x', 3, { group: 'module', code: 'api' }, { id: null, group: 'module', code: 'api' }, { id: 1, group: 'module' }, { id: 1, table: 'module', name: 'x', column: 2 }]) {
			assert.equal(r.normalizeRow(row), null, JSON.stringify(row));
		}
	});
});

describe('formatValue', () => {
	it('gives null for null and undefined, JSON with four spaces for an object, and text for the rest', () => {
		assert.equal(r.formatValue(null), null);
		assert.equal(r.formatValue(undefined), null);
		assert.equal(r.formatValue({ a: [1] }), '{\n    "a": [\n        1\n    ]\n}');
		assert.equal(r.formatValue(5), '5');
		assert.equal(r.formatValue(''), '');
	});
});

describe('diffValues', () => {
	it('takes every known spelling, and fails when neither side is there', () => {
		assert.deepEqual(r.diffValues({ old_value: 'a', new_value: { x: 1 } }), { old_value: 'a', new_value: '{\n    "x": 1\n}' });
		assert.deepEqual(r.diffValues({ change: { oldValue: null, newValue: 'b' } }), { old_value: null, new_value: 'b' });
		assert.deepEqual(r.diffValues({}), { reason: 'unexpected response' });
	});

	it('reads the camelCase spelling at the top level', () => {
		assert.deepEqual(r.diffValues({ oldValue: 'a', newValue: 'b' }), { old_value: 'a', new_value: 'b' });
		assert.deepEqual(r.diffValues({ change: {} }), { reason: 'unexpected response' });
	});
});

describe('maskedDiffValues', () => {
	const values = { old_value: '{\n    "clientSecret": "REAL_OLD",\n    "port": 8080,\n    "flag": true\n}', new_value: 'REAL_TEXT' };

	it('masks both sides of a common change in public mode, a side that is no JSON object as the string marker', () => {
		assert.deepEqual(r.maskedDiffValues({ mode: 'public', code: 'common', values }), {
			old_value: '{\n\t"clientSecret": "***MASKED:string***",\n\t"port": "***MASKED:number***",\n\t"flag": true\n}\n',
			new_value: '***MASKED:string***',
		});
		assert.deepEqual(r.maskedDiffValues({ mode: 'public', code: 'common', values: { old_value: null, new_value: '[1]' } }), { old_value: null, new_value: '***MASKED:string***' });
	});

	it('keeps other changes and every change in employee mode as they are', () => {
		assert.equal(r.maskedDiffValues({ mode: 'public', code: 'api', values }), values);
		assert.equal(r.maskedDiffValues({ mode: 'employee', code: 'common', values }), values);
	});
});

describe('languageOf', () => {
	it('gives js for the code and test of a function and imljson for the rest', () => {
		assert.equal(r.languageOf('code'), 'js');
		assert.equal(r.languageOf('test'), 'js');
		assert.equal(r.languageOf('api'), 'imljson');
	});
});

describe('chooseRoute', () => {
	it('follows the result table of spec 3.4', () => {
		assert.equal(r.chooseRoute({ mode: 'employee', approved: false, rowCount: 2, baseline: null }), 'api');
		assert.equal(r.chooseRoute({ mode: 'employee', approved: false, rowCount: 0, baseline: null }), 'empty');
		assert.equal(r.chooseRoute({ mode: 'public', approved: null, rowCount: 1, baseline: null }), 'api');
		assert.equal(r.chooseRoute({ mode: 'public', approved: true, rowCount: 0, baseline: null }), 'approvedEmpty');
		assert.equal(r.chooseRoute({ mode: 'public', approved: false, rowCount: 0, baseline: null }), 'baseline');
		assert.equal(r.chooseRoute({ mode: 'public', approved: null, rowCount: 0, baseline: null }), 'baseline');
		assert.equal(r.chooseRoute({ mode: 'employee', approved: true, rowCount: 3, baseline: 'latest' }), 'baseline');
	});
});

describe('parseArgs', () => {
	it('reads the slug, the version and --baseline in both spellings', () => {
		assert.deepEqual(r.parseArgs(['my-app', '1']), { slug: 'my-app', version: '1', baseline: null, error: null });
		assert.equal(r.parseArgs(['my-app', '1', '--baseline', 'latest']).baseline, 'latest');
		assert.equal(r.parseArgs(['my-app', '1', '--baseline=20261105-141200']).baseline, '20261105-141200');
	});

	it('gives an error for a missing value, an unknown flag and a missing positional', () => {
		assert.equal(r.parseArgs(['my-app', '1', '--baseline']).error, 'ERROR: --baseline needs a snapshot id or latest.');
		assert.equal(r.parseArgs(['my-app', '1', '--baseline', '--x']).error, 'ERROR: --baseline needs a snapshot id or latest.');
		assert.equal(r.parseArgs(['my-app', '1', '--all']).error, 'ERROR: unknown flag --all');
		assert.equal(r.parseArgs(['my-app']).error, '');
	});

	it('gives the usage error for an empty --baseline= and for a third positional', () => {
		assert.equal(r.parseArgs(['my-app', '1', '--baseline=']).error, 'ERROR: --baseline needs a snapshot id or latest.');
		assert.deepEqual(r.parseArgs(['my-app', '1', 'extra']), { slug: null, version: null, baseline: null, error: '' });
		assert.deepEqual(r.parseArgs(['--baseline', 'latest', 'my-app', '1']), { slug: 'my-app', version: '1', baseline: 'latest', error: null });
	});

	it('has usage lines that name --baseline', () => {
		assert.deepEqual(r.USAGE_LINES, [
			'Usage: node review-changes.js <app-slug> <app-version> [--baseline <id|latest>]',
			'Example: node review-changes.js google-docs 1',
			'        node review-changes.js google-docs 1 --baseline latest',
		]);
	});
});

describe('texts', () => {
	it('gives the exit 2 messages of spec 3.3', () => {
		const command = 'node "/path/to/shared/scripts/download-app.js"';
		assert.deepEqual(r.noSnapshotLines({ slug: 'my-app', version: '1', command, explicit: false }), [
			'No change list: this app is not approved, so Make applies every push at once and keeps no change rows.',
			'No snapshot of my-app v1 exists to compare with, so no review file was written.',
			'Review the full app code. Before the next push, run: node "/path/to/shared/scripts/download-app.js" my-app 1 --snapshot',
		]);
		assert.deepEqual(r.noSnapshotLines({ slug: 'my-app', version: '1', command, explicit: true }), [
			'No snapshot of my-app v1 exists to compare with, so no review file was written.',
			'Review the full app code. Before the next push, run: node "/path/to/shared/scripts/download-app.js" my-app 1 --snapshot',
		]);
		assert.equal(
			r.unknownSnapshotLine({ slug: 'my-app', version: '1', id: '20261101-090000', ids: ['20261104-170512', '20261105-141200'] }),
			'Snapshot 20261101-090000 of my-app v1 does not exist. Snapshots: 20261105-141200, 20261104-170512.',
		);
		assert.equal(r.unknownSnapshotLine({ slug: 'my-app', version: '1', id: 'x', ids: [] }), 'Snapshot x of my-app v1 does not exist. Snapshots: none.');
		assert.equal(r.noLocalCopyLine({ slug: 'my-app', version: '1' }), 'No local copy of my-app v1 to compare. Run download-app.js my-app 1 first.');
	});

	it('lists the snapshots newest first, also with a clash number, whatever the order it gets', () => {
		const ids = ['20261105-141200-2', '20261104-170512', '20261105-141200'];
		assert.equal(r.unknownSnapshotLine({ slug: 'my-app', version: '1', id: 'x', ids }), 'Snapshot x of my-app v1 does not exist. Snapshots: 20261105-141200-2, 20261105-141200, 20261104-170512.');
		assert.deepEqual(ids, ['20261105-141200-2', '20261104-170512', '20261105-141200']);
	});

	it('gives the failure lines and the error line of spec 3.4 step 5', () => {
		assert.deepEqual(r.failedLines([{ what: 'change list', reason: 'HTTP 403' }]).slice(0, 2), ['Failed: 1', '  ✗ change list (HTTP 403)']);
		assert.equal(r.failedErrorLine(2), 'ERROR: 2 call(s) failed, so no review was written. Show the failed calls above to the user; do not review from an older latest.json.');
	});

	it('ends the failure lines with each fix once', () => {
		const failed = [
			{ what: 'change list', reason: 'HTTP 403' },
			{ what: 'module/a/api', reason: 'HTTP 500' },
			{ what: 'module/b/api', reason: 'ECONNRESET' },
			{ what: 'app my-app v1', reason: 'HTTP 404', fix: 'eu1.make.com has no my-app v1 that this token can read: check the slug, the version and the zone.' },
		];
		assert.deepEqual(r.failedLines(failed), [
			'Failed: 4',
			'  ✗ change list (HTTP 403)',
			'  ✗ module/a/api (HTTP 500)',
			'  ✗ module/b/api (ECONNRESET)',
			'  ✗ app my-app v1 (HTTP 404)',
			`  ${AUTH_FIX}`,
			`  ${RETRY_FIX}`,
			'  eu1.make.com has no my-app v1 that this token can read: check the slug, the version and the zone.',
		]);
	});

	it('gives no network fix for a local copy failure, and keeps the fix of a call next to it', () => {
		assert.deepEqual(r.localCopyFailure({ code: 'EACCES' }), { what: 'local copy', reason: 'EACCES', local: true });
		assert.deepEqual(r.failedLines([r.localCopyFailure({ code: 'EACCES' })]), ['Failed: 1', '  ✗ local copy (EACCES)']);
		assert.deepEqual(r.failedLines([r.localCopyFailure(new SyntaxError('bad')), { what: 'change list', reason: 'HTTP 500' }]), [
			'Failed: 2',
			'  ✗ local copy (unreadable)',
			'  ✗ change list (HTTP 500)',
			`  ${RETRY_FIX}`,
		]);
	});

	it('gives the stop line of a file that cannot be read or written', () => {
		assert.equal(r.fileErrorLine({ verb: 'read', file: '/h/.make-custom-app/snapshots/my-app-v1', code: 'EACCES' }), 'ERROR: cannot read /h/.make-custom-app/snapshots/my-app-v1 (EACCES)');
		assert.equal(r.fileErrorLine({ verb: 'write', file: '/h/reviews/latest.json', code: 'ENOTDIR' }), 'ERROR: cannot write /h/reviews/latest.json (ENOTDIR)');
		assert.equal(r.fileErrorLine({ verb: 'write', file: '/h/reviews/latest.json' }), 'ERROR: cannot write /h/reviews/latest.json (error)');
	});

	it('gives the baseline summary of spec 3.3', () => {
		const lines = r.baselineSummaryLines({ id: '20261105-141200', takenAt: '2026-11-05T14:12:00.000Z', counts: { total: 4, modified: 2, added: 1, removed: 1 }, edited: false, saved: '/Users/me/.make-custom-app/contexts/my-app-v1/reviews/latest.json' });
		assert.deepEqual(lines, [
			'Baseline: snapshot 20261105-141200 (taken 2026-11-05T14:12:00.000Z)',
			'Changes: 4 (modified 2, added 1, removed 1)',
			'Working copy has unpushed edits: no',
			'Saved: /Users/me/.make-custom-app/contexts/my-app-v1/reviews/latest.json',
		]);
		assert.equal(r.baselineSummaryLines({ id: 'i', takenAt: 't', counts: { total: 0, modified: 0, added: 0, removed: 0 }, edited: true, saved: 's' })[2], 'Working copy has unpushed edits: yes');
	});

	it('gives the two empty lines of spec 3.4', () => {
		assert.equal(r.EMPTY_LINE, 'No changes found.');
		assert.equal(r.APPROVED_EMPTY_LINE, 'No pending changes on this approved app.');
	});
});

describe('reviewDocument', () => {
	it('gives the API document with no baseline and no edit flag', () => {
		const changes = [{ id: 1, group: 'module', item: 'm', code: 'api', label: 'module/m/api', language: 'imljson', old_value: 'a', new_value: 'b' }];
		assert.deepEqual(r.reviewDocument({ slug: 'my-app', version: '1', fetchedAt: '2026-11-05T14:12:00.000Z', source: 'api', approved: true, changes }), {
			appSlug: 'my-app',
			appVersion: '1',
			fetchedAt: '2026-11-05T14:12:00.000Z',
			source: 'api',
			approved: true,
			baseline: null,
			workingCopyEdited: null,
			totalChanges: 1,
			changes,
		});
	});

	it('gives the baseline document with the snapshot and the edit flag', () => {
		const baseline = { id: '20261105-141200', takenAt: '2026-11-05T14:12:00.000Z', dir: '/d' };
		const doc = r.reviewDocument({ slug: 'my-app', version: '1', fetchedAt: 'f', source: 'baseline', approved: null, baseline, workingCopyEdited: false, changes: [] });
		assert.deepEqual(doc.baseline, baseline);
		assert.equal(doc.workingCopyEdited, false);
		assert.equal(doc.totalChanges, 0);
		assert.equal(doc.approved, null);
	});
});
