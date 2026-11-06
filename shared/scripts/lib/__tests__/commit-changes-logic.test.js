const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../commit-changes-logic');

describe('commit-changes texts', () => {
	it('row 5: the usage in both modes', () => {
		assert.deepEqual(c.usageLines(), [
			'Usage: node commit-changes.js <app-slug> <app-version> <commit|rollback|compile> [options]',
			'',
			'  commit    --message="..." [--change-ids=1,2] [--notify] [--issue=KEY]',
			'            (--issue is for Make employees only)',
			'  rollback  --confirm            (discards ALL pending changes)',
			'  compile   [--issue=KEY]        (Make employees only)',
			'',
			'Example: node commit-changes.js my-app 1 commit --message="Fix pagination of the list module"',
		]);
	});

	it('row 6: the message rule and its error', () => {
		assert.equal(c.MESSAGE_MAX_LENGTH, 1000);
		assert.equal(c.isValidMessage('x'), true);
		assert.equal(c.isValidMessage('x'.repeat(1000)), true);
		for (const m of [null, undefined, '', 'x'.repeat(1001)]) assert.equal(c.isValidMessage(m), false);
		assert.equal(c.MESSAGE_ERROR, 'ERROR: --message is required and must be 1 to 1000 characters.');
	});

	it('rows 1 to 3: nothing to commit in public mode, by approved', () => {
		assert.deepEqual(c.noChangesLines({ mode: 'public', approved: false }), [
			'ABORT: nothing to commit.',
			'  This app is not approved, so Make keeps no change list for it. Every push you made is already live on the app.',
			'  There is nothing to commit, compile or roll back. A manual rollback uses the local snapshot taken before the first push.',
		]);
		assert.deepEqual(c.noChangesLines({ mode: 'public', approved: true }), [
			'ABORT: no pending changes to commit.',
			'  This app is approved: pushes wait as pending changes until they are committed, and none are waiting now.',
		]);
		for (const approved of [null, undefined]) {
			assert.deepEqual(c.noChangesLines({ mode: 'public', approved }), [
				'ABORT: no pending changes to commit.',
				'  Make did not say whether this app is approved. On an app that is not approved every push is live at once and there is nothing to commit.',
			]);
		}
	});

	it("employee mode keeps today's lines", () => {
		assert.deepEqual(c.noChangesLines({ mode: 'employee', approved: false }), [
			'ABORT: no pending changes to commit.',
			'  App is not approved (approved: false) → SDK edits write directly to the DB and never create change rows.',
			'  There is nothing to commit; the forward action for this app is `compile`.',
		]);
		assert.deepEqual(c.noChangesLines({ mode: 'employee', approved: true }), ['ABORT: no pending changes to commit.']);
		assert.deepEqual(c.noChangesLines({ mode: 'employee', approved: undefined }), ['ABORT: no pending changes to commit.']);
		assert.equal(c.afterCommitLine('employee'), '  A compile is enqueued automatically by the commit routine.');
	});

	it('rows 4 and 22: the lines after a commit and after a rollback', () => {
		assert.equal(c.afterCommitLine('public'), '  Run download-app.js again to confirm that the local copy matches the committed app.');
		assert.equal(c.AFTER_ROLLBACK_LINE, '  Run download-app.js again so the local copy matches the app.');
	});

	it('does not hand out its arrays: a caller that edits a result leaves the next call alone', () => {
		const first = c.noChangesLines({ mode: 'public', approved: false });
		first.length = 0;
		assert.equal(c.noChangesLines({ mode: 'public', approved: false }).length, 3);
	});
});
