/**
 * Tests for the entry script commit-changes.js against the mock Make API of entry-harness.js: the public texts of the
 * commit, rollback and compile paths (spec 3.5 rows 1 to 7 and 22), and today's employee lines.
 */
require('./isolate-home');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./entry-harness');
const { usageLines, noChangesLines, afterCommitLine, AFTER_ROLLBACK_LINE, MESSAGE_ERROR } = require('../commit-changes-logic');
const { employeeOnlyMessage } = require('../mode-logic');

const ORIGIN = (base) => `GET ${base}/sdk/apps/my-app/1?cols[0]=origin`;
const STATE = (base) => `GET ${base}/sdk/apps/my-app/1?cols[0]=changes&cols[1]=approved`;
const CHANGE = { id: 8, group: 'module', item: 'm', code: 'api' };
const PUBLIC = '/api/v2';
const EMPLOYEE = '/api/v2/admin';
const COMMIT_ARGS = ['my-app', '1', 'commit', '--message=x'];
const posts = (h) => h.log.filter((q) => q.method === 'POST');

let h;

before(async () => {
	h = await createHarness();
});

after(() => h.close());

describe('commit-changes.js: usage and message', () => {
	it('prints the usage and exits 1 without a request when there are no arguments', async () => {
		h.seed({});
		const r = await h.run('commit-changes.js', []);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stdout, `${usageLines().join('\n')}\n`);
		assert.equal(r.stderr, '');
		assert.equal(h.log.length, 0);
	});

	it('public mode refuses an empty --message with the message error and sends no POST', async () => {
		h.seed({ routes: { [ORIGIN(PUBLIC)]: [200, { app: {} }] } });
		const r = await h.run('commit-changes.js', ['my-app', '1', 'commit', '--message=']);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stderr.includes(`${MESSAGE_ERROR}\n`), r.stderr);
		assert.equal(posts(h).length, 0);
	});

	it('employee mode says the same for a message that is too long', async () => {
		h.seed({ mode: 'employee', routes: { [ORIGIN(EMPLOYEE)]: [200, { app: {} }] } });
		const r = await h.run('commit-changes.js', ['my-app', '1', 'commit', `--message=${'x'.repeat(1001)}`]);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stderr.includes(`${MESSAGE_ERROR}\n`), r.stderr);
		assert.ok(!r.stderr.includes('Validator'), r.stderr);
		assert.equal(posts(h).length, 0);
	});
});

describe('commit-changes.js: nothing to commit', () => {
	const seedState = (mode, base, app) => h.seed({ mode, routes: { [ORIGIN(base)]: [200, { app: {} }], [STATE(base)]: [200, { app }] } });

	it('public mode, approved false: exits 2 with the row 1 lines and sends no POST', async () => {
		seedState('public', PUBLIC, { approved: false, changes: [] });
		const r = await h.run('commit-changes.js', COMMIT_ARGS);
		assert.equal(r.code, 2, r.out);
		assert.ok(r.stderr.includes(`${noChangesLines({ mode: 'public', approved: false }).join('\n')}\n`), r.stderr);
		assert.ok(r.stderr.includes('ABORT: nothing to commit.\n'), r.stderr);
		assert.equal(posts(h).length, 0);
	});

	it('public mode, approved true: exits 2 with the row 2 lines', async () => {
		seedState('public', PUBLIC, { approved: true, changes: [] });
		const r = await h.run('commit-changes.js', COMMIT_ARGS);
		assert.equal(r.code, 2, r.out);
		assert.ok(r.stderr.includes(`${noChangesLines({ mode: 'public', approved: true }).join('\n')}\n`), r.stderr);
		assert.ok(r.stderr.includes('  This app is approved: pushes wait as pending changes'), r.stderr);
		assert.equal(posts(h).length, 0);
	});

	it('public mode, no approved field: exits 2 with the row 3 lines', async () => {
		seedState('public', PUBLIC, { changes: [] });
		const r = await h.run('commit-changes.js', COMMIT_ARGS);
		assert.equal(r.code, 2, r.out);
		assert.ok(r.stderr.includes(`${noChangesLines({ mode: 'public', approved: undefined }).join('\n')}\n`), r.stderr);
		assert.ok(r.stderr.includes('  Make did not say whether this app is approved.'), r.stderr);
		assert.equal(posts(h).length, 0);
	});

	it("employee mode, approved false: exits 2 with today's three lines", async () => {
		seedState('employee', EMPLOYEE, { approved: false, changes: [] });
		const r = await h.run('commit-changes.js', COMMIT_ARGS);
		assert.equal(r.code, 2, r.out);
		assert.ok(
			r.stderr.includes(
				[
					'ABORT: no pending changes to commit.',
					'  App is not approved (approved: false) → SDK edits write directly to the DB and never create change rows.',
					'  There is nothing to commit; the forward action for this app is `compile`.',
					'',
				].join('\n'),
			),
			r.stderr,
		);
		assert.equal(posts(h).length, 0);
	});
});

describe('commit-changes.js: commit, rollback and compile', () => {
	const seedWithChange = (mode, base, extra) =>
		h.seed({ mode, routes: { [ORIGIN(base)]: [200, { app: {} }], [STATE(base)]: [200, { app: { approved: true, changes: [CHANGE] } }], ...extra } });

	it('public mode commits one change and ends with the row 4 line', async () => {
		seedWithChange('public', PUBLIC, { [`POST ${PUBLIC}/sdk/apps/my-app/1/commit`]: [200, {}] });
		const r = await h.run('commit-changes.js', COMMIT_ARGS);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes(`✓ Committed 1 change(s) (HTTP 200)\n${afterCommitLine('public')}\n`), r.stdout);
		assert.ok(!r.stdout.includes('A compile is enqueued'), r.stdout);
		assert.deepEqual(JSON.parse(posts(h)[0].body), { notify: false, message: 'x', changeIds: [8] });
	});

	it("employee mode commits one change and keeps today's compile line", async () => {
		seedWithChange('employee', EMPLOYEE, { [`POST ${EMPLOYEE}/sdk/apps/my-app/1/commit`]: [200, {}] });
		const r = await h.run('commit-changes.js', COMMIT_ARGS);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('✓ Committed 1 change(s) (HTTP 200)\n  A compile is enqueued automatically by the commit routine.\n'), r.stdout);
	});

	it('rollback ends with the row 22 line', async () => {
		seedWithChange('public', PUBLIC, { [`POST ${PUBLIC}/sdk/apps/my-app/1/rollback`]: [200, {}] });
		const r = await h.run('commit-changes.js', ['my-app', '1', 'rollback', '--confirm']);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes(`✓ Rolled back 1 change(s) (HTTP 200)\n${AFTER_ROLLBACK_LINE}\n`), r.stdout);
		assert.ok(!r.stdout.includes('snapshot'), r.stdout);
	});

	it('public mode refuses compile with the employee-only text and sends nothing', async () => {
		h.seed({});
		const r = await h.run('commit-changes.js', ['my-app', '1', 'compile']);
		assert.equal(r.code, 1, r.out);
		const message = employeeOnlyMessage('commit-changes.js compile');
		assert.ok(r.stderr.includes(message), r.stderr);
		assert.ok(message.endsWith('Do not retry it. Compiling is not a step for the owner of an app: a push to an app that is not approved is live at once. Do not offer it again.'), message);
		assert.equal(h.log.length, 0);
	});
});
