/**
 * Tests for the entry script review-changes.js against the mock Make API of entry-harness.js: every silent path of
 * spec 3.4 now fails loudly (exit 1, the Failed lines, the ERROR line, no review file, a stale latest.json removed),
 * the green paths of the result table, and the baseline route of spec 3.3 against a snapshot.
 */
require('./isolate-home');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createHarness, DESTROY, ZONE } = require('./entry-harness');
const { scriptCommand } = require('../paths');
const { originStop } = require('../mode-logic');
const { AUTH_FIX, RETRY_FIX } = require('../download-app-logic');
const rc = require('../review-changes-logic');

const PUB = '/api/v2';
const EMP = '/api/v2/admin';
const POSIX = process.platform !== 'win32';
/** Mode bits do not stop root, and Windows has none: the cases that need an unreadable or unwritable folder skip there. */
const NO_MODES = (!POSIX && 'file modes do not apply on Windows') || (process.getuid?.() === 0 && 'root ignores file modes');
const ORIGIN = (base) => `GET ${base}/sdk/apps/my-app/1?cols[0]=origin`;
const STATE = (base) => `GET ${base}/sdk/apps/my-app/1?cols[0]=changes&cols[1]=approved`;
const DIFF = (base, id) => `GET ${base}/sdk/apps/my-app/1/changes/${id}`;
const ARGS = ['my-app', '1'];
const routes = (base, extra = {}) => ({ [ORIGIN(base)]: [200, { app: {} }], ...extra });
const ROWS = [
	{ id: 1, group: 'module', item: 'a', code: 'api' },
	{ id: 2, group: 'module', item: 'b', code: 'api' },
];

let h;

before(async () => {
	h = await createHarness();
});

after(() => h.close());

const reviewsDir = () => path.join(h.contextsDir(), 'my-app-v1', 'reviews');
const latestFile = () => path.join(reviewsDir(), 'latest.json');
const readLatest = () => JSON.parse(fs.readFileSync(latestFile(), 'utf8'));
const sent = () => h.log.map((q) => `${q.method} ${q.url}`);
/** A working copy that holds a review file of an earlier run. */
const seedStale = (extra = {}) => h.writeWorkingCopy({ ...extra, files: { 'reviews/latest.json': '{"stale":true}', ...(extra.files || {}) } });
const later = (ms) => new Date(Date.now() + ms).toISOString();

/** Exit 1 with n failures, the ERROR line last, and no review file: the stale one removed, or no reviews/ folder at all. */
function assertFailed(r, n, { stale }) {
	assert.equal(r.code, 1, r.out);
	assert.ok(r.stdout.includes(`Failed: ${n}\n`), r.stdout);
	assert.ok(r.stderr.endsWith(`${rc.failedErrorLine(n)}\n`), r.stderr);
	if (stale) {
		assert.ok(!fs.existsSync(latestFile()), 'the stale latest.json is still there');
		assert.deepEqual(fs.readdirSync(reviewsDir()), []);
	} else {
		assert.ok(!fs.existsSync(reviewsDir()), 'a reviews folder was created');
	}
}

describe('review-changes.js: loud failures', () => {
	for (const [mode, base] of [
		['public', PUB],
		['employee', EMP],
	]) {
		it(`an app that every route answers 404 for exits 1 with the app failure and its fix (${mode})`, async () => {
			h.seed({ mode, routes: {} });
			const r = await h.run('review-changes.js', ARGS);
			assertFailed(r, 1, { stale: false });
			assert.ok(r.stdout.includes('  ✗ app my-app v1 (HTTP 404)\n'), r.stdout);
			assert.ok(r.stdout.includes(`  ${ZONE} has no my-app v1 that this token can read: check the slug, the version and the zone.\n`), r.stdout);
			assert.deepEqual(sent(), [ORIGIN(base)]);
			assert.ok(!fs.existsSync(path.join(h.contextsDir(), 'my-app-v1')));
		});
	}

	it('a state call that answers 403 exits 1 with the change list failure and the token fix', async () => {
		h.seed({ routes: routes(PUB, { [STATE(PUB)]: [403, { code: 'SC403' }] }) });
		seedStale();
		const r = await h.run('review-changes.js', ARGS);
		assertFailed(r, 1, { stale: true });
		assert.ok(r.stdout.includes('  ✗ change list (HTTP 403)\n'), r.stdout);
		assert.ok(r.stdout.includes(`  ${AUTH_FIX}\n`), r.stdout);
	});

	it('a state call that answers 429 every time exits 1 after five retries', async () => {
		h.seed({ routes: routes(PUB, { [STATE(PUB)]: [429, { code: 'IM429' }, { 'retry-after': '0' }] }) });
		const r = await h.run('review-changes.js', ARGS);
		assertFailed(r, 1, { stale: false });
		assert.ok(r.stdout.includes('  ✗ change list (HTTP 429 after 5 retries)\n'), r.stdout);
		assert.ok(r.stdout.includes(`  ${RETRY_FIX}\n`), r.stdout);
		assert.equal(sent().filter((q) => q === STATE(PUB)).length, 6);
	});

	it('a state call that drops the connection every time exits 1 with an error code and no message text', async () => {
		h.seed({ routes: routes(PUB, { [STATE(PUB)]: () => DESTROY }) });
		seedStale();
		const r = await h.run('review-changes.js', ARGS);
		assertFailed(r, 1, { stale: true });
		assert.match(r.stdout, /✗ change list \([A-Za-z0-9_.-]+\)/);
		assert.doesNotMatch(r.out, /Token/);
	});

	it('an origin lookup that answers 500 exits 1 after that one request', async () => {
		h.seed({ routes: { [ORIGIN(PUB)]: [500, { code: 'IM500' }] } });
		const r = await h.run('review-changes.js', ARGS);
		assertFailed(r, 1, { stale: false });
		assert.ok(r.stdout.includes('  ✗ app my-app v1 (HTTP 500)\n'), r.stdout);
		assert.deepEqual(sent(), [ORIGIN(PUB)]);
	});

	it('a state answer without changes exits 1, with its own reason for an unapproved app', async () => {
		for (const [app, reason] of [
			[{ approved: true }, 'unexpected response'],
			[{ approved: false }, 'unexpected response: no changes field (approved: false)'],
		]) {
			h.seed({ routes: routes(PUB, { [STATE(PUB)]: [200, { app }] }) });
			seedStale();
			const r = await h.run('review-changes.js', ARGS);
			assertFailed(r, 1, { stale: true });
			assert.ok(r.stdout.includes(`  ✗ change list (${reason})\n`), r.stdout);
			const fix = app.approved ? RETRY_FIX : 'A retry gets the same answer, because Make sent no change list for this app. Review the full app code instead.';
			assert.ok(r.stdout.includes(`  ✗ change list (${reason})\n  ${fix}\n`), r.stdout);
		}
	});

	it('one failed diff of two exits 1 and writes nothing', async () => {
		h.seed({ routes: routes(PUB, { [STATE(PUB)]: [200, { app: { approved: true, changes: ROWS } }], [DIFF(PUB, 1)]: [200, { old_value: 'a', new_value: 'b' }], [DIFF(PUB, 2)]: [500, {}] }) });
		seedStale();
		const r = await h.run('review-changes.js', ARGS);
		assertFailed(r, 1, { stale: true });
		assert.ok(r.stdout.includes('  module/a/api ... ✓\n'), r.stdout);
		assert.ok(r.stdout.includes('  module/b/api ... ✗ HTTP 500\n'), r.stdout);
		assert.ok(r.stdout.includes('  ✗ module/b/api (HTTP 500)\n'), r.stdout);
	});

	it('every failed diff is listed', async () => {
		h.seed({ routes: routes(PUB, { [STATE(PUB)]: [200, { app: { approved: true, changes: ROWS } }] }) });
		seedStale();
		const r = await h.run('review-changes.js', ARGS);
		assertFailed(r, 2, { stale: true });
		assert.ok(r.stdout.includes('  ✗ module/a/api (HTTP 404)\n  ✗ module/b/api (HTTP 404)\n'), r.stdout);
	});

	it('a diff with neither an old nor a new value fails', async () => {
		h.seed({ routes: routes(PUB, { [STATE(PUB)]: [200, { app: { approved: true, changes: ROWS.slice(0, 1) } }], [DIFF(PUB, 1)]: [200, {}] }) });
		seedStale();
		const r = await h.run('review-changes.js', ARGS);
		assertFailed(r, 1, { stale: true });
		assert.ok(r.stdout.includes('  ✗ module/a/api (unexpected response)\n'), r.stdout);
	});

	it('an app in another zone stops in public mode after the one origin request', async () => {
		h.seed({ routes: { [ORIGIN(PUB)]: [200, { app: { origin: 'us1.make.com' } }] } });
		const r = await h.run('review-changes.js', ARGS);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stderr.includes(originStop({ mode: 'public', host: ZONE, origin: 'us1.make.com' }).message), r.stderr);
		assert.deepEqual(sent(), [ORIGIN(PUB)]);
		assert.ok(!fs.existsSync(reviewsDir()));
	});

	it('a run that stops at the mode check has already removed a stale latest.json', async () => {
		h.seed({ routes: routes(PUB) });
		seedStale();
		fs.rmSync(path.join(h.home, '.make-custom-app-skill-secrets'));
		const r = await h.run('review-changes.js', ARGS);
		assert.equal(r.code, 1, r.out);
		assert.ok(!fs.existsSync(latestFile()), 'the stale latest.json is still there');
		assert.equal(h.log.length, 0);
	});

	it('a run that stops at the origin lookup has already removed a stale latest.json', async () => {
		for (const originRoutes of [{}, { [ORIGIN(PUB)]: [200, { app: { origin: 'us1.make.com' } }] }]) {
			h.seed({ routes: originRoutes });
			seedStale();
			const r = await h.run('review-changes.js', ARGS);
			assert.equal(r.code, 1, r.out);
			assert.ok(!fs.existsSync(latestFile()), 'the stale latest.json is still there');
			assert.deepEqual(sent(), [ORIGIN(PUB)]);
		}
	});

	it('a reviews entry that is a file stops before the mode check with the cannot write line', { skip: !POSIX && 'Windows gives another error code for a path through a file' }, async () => {
		h.seed({ routes: routes(PUB) });
		h.writeWorkingCopy({ files: { reviews: 'not a folder' } });
		const r = await h.run('review-changes.js', ARGS);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stderr, `ERROR: cannot write ${latestFile()} (ENOTDIR)\n`);
		assert.equal(h.log.length, 0);
	});

	it('a review file that cannot be written exits 1 with the cannot write line and no stack trace', { skip: NO_MODES }, async () => {
		h.seed({ routes: routes(PUB, { [STATE(PUB)]: [200, { app: { approved: true, changes: [] } }] }) });
		h.writeWorkingCopy();
		fs.mkdirSync(reviewsDir());
		fs.chmodSync(reviewsDir(), 0o500);
		try {
			const r = await h.run('review-changes.js', ARGS);
			assert.equal(r.code, 1, r.out);
			assert.ok(r.stderr.endsWith(`ERROR: cannot write ${latestFile()} (EACCES)\n`), r.stderr);
			assert.doesNotMatch(r.stderr, /\n\s+at /);
			assert.ok(!fs.existsSync(latestFile()));
		} finally {
			fs.chmodSync(reviewsDir(), 0o700);
		}
	});

	it('--baseline without a value exits 1 with the error and the usage, before any request', async () => {
		h.seed({ routes: routes(PUB) });
		const r = await h.run('review-changes.js', [...ARGS, '--baseline']);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stderr, 'ERROR: --baseline needs a snapshot id or latest.\n');
		assert.equal(r.stdout, `${rc.USAGE_LINES.join('\n')}\n`);
		assert.equal(h.log.length, 0);
	});
});

describe('review-changes.js: the API route', () => {
	it('public-shaped rows get real labels and are saved with group, item and code', async () => {
		h.seed({ routes: routes(PUB, { [STATE(PUB)]: [200, { app: { approved: false, changes: [{ id: 7, table: 'module', name: 'listItems', column: 'api' }] } }], [DIFF(PUB, 7)]: [200, { oldValue: 'a', newValue: 'b' }] }) });
		const r = await h.run('review-changes.js', ARGS);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('Found 1 change(s)\n'), r.stdout);
		assert.ok(r.stdout.includes('  module/listItems/api ... ✓\n'), r.stdout);
		assert.ok(r.stdout.includes('    - module/listItems/api (imljson)\n'), r.stdout);
		assert.doesNotMatch(r.out, /undefined/);
		const latest = readLatest();
		assert.equal(latest.source, 'api');
		assert.equal(latest.approved, false);
		assert.equal(latest.baseline, null);
		assert.equal(latest.workingCopyEdited, null);
		assert.equal(latest.totalChanges, 1);
		assert.deepEqual(latest.changes, [{ id: 7, group: 'module', item: 'listItems', code: 'api', label: 'module/listItems/api', language: 'imljson', old_value: 'a', new_value: 'b' }]);
		const history = fs.readdirSync(reviewsDir()).filter((f) => f.startsWith('review-'));
		assert.equal(history.length, 1);
		assert.ok(r.stdout.includes(`  Latest: ${latestFile()}\n  History: ${path.join(reviewsDir(), history[0])}\n  Changes: 1\n`), r.stdout);
		assert.deepEqual(sent(), [ORIGIN(PUB), STATE(PUB), DIFF(PUB, 7)]);
	});

	it('employee mode with change rows takes the API route and writes latest.json and the history file (result table row 1)', async () => {
		h.seed({
			mode: 'employee',
			routes: routes(EMP, {
				[STATE(EMP)]: [200, { app: { approved: true, changes: ROWS } }],
				[DIFF(EMP, 1)]: [200, { old_value: 'a', new_value: 'b' }],
				[DIFF(EMP, 2)]: [200, { change: { oldValue: { x: 1 }, newValue: null } }],
			}),
		});
		const r = await h.run('review-changes.js', ARGS);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('Found 2 change(s)\n'), r.stdout);
		assert.ok(r.stdout.includes('  Changes: 2\n    - module/a/api (imljson)\n    - module/b/api (imljson)\n'), r.stdout);
		const latest = readLatest();
		assert.equal(latest.source, 'api');
		assert.equal(latest.approved, true);
		assert.equal(latest.totalChanges, 2);
		assert.deepEqual(
			latest.changes.map((c) => [c.label, c.old_value, c.new_value]),
			[
				['module/a/api', 'a', 'b'],
				['module/b/api', '{\n    "x": 1\n}', null],
			],
		);
		const history = fs.readdirSync(reviewsDir()).filter((f) => f.startsWith('review-'));
		assert.equal(history.length, 1);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(reviewsDir(), history[0]), 'utf8')), latest);
		assert.deepEqual(sent(), [ORIGIN(EMP), STATE(EMP), DIFF(EMP, 1), DIFF(EMP, 2)]);
	});

	it('masks common changes in public mode before it saves them, and keeps them in employee mode', async () => {
		const SECRETS = ['REAL_OLD_SECRET', 'REAL_NEW_SECRET', 'REAL_CONN_SECRET'];
		const COMMON_ROWS = [{ id: 7, group: 'app', code: 'common' }, { id: 8, group: 'connection', item: 'my-conn', code: 'common' }];
		for (const [mode, base] of [
			['public', PUB],
			['employee', EMP],
		]) {
			h.seed({
				mode,
				routes: routes(base, {
					[STATE(base)]: [200, { app: { approved: true, changes: COMMON_ROWS } }],
					[DIFF(base, 7)]: [200, { old_value: { clientSecret: 'REAL_OLD_SECRET' }, new_value: { clientSecret: 'REAL_NEW_SECRET', port: 1 } }],
					[DIFF(base, 8)]: [200, { old_value: null, new_value: 'REAL_CONN_SECRET' }],
				}),
			});
			const r = await h.run('review-changes.js', ARGS);
			assert.equal(r.code, 0, r.out);
			const files = fs.readdirSync(reviewsDir()).map((f) => fs.readFileSync(path.join(reviewsDir(), f), 'utf8'));
			assert.equal(files.length, 2);
			for (const secret of SECRETS) {
				assert.ok(!r.out.includes(secret), `${mode} output`);
				for (const text of files) assert.equal(text.includes(secret), mode === 'employee', `${mode} ${secret}`);
			}
			if (mode === 'public') {
				assert.deepEqual(
					readLatest().changes.map((c) => [c.label, c.old_value, c.new_value]),
					[
						['app/common', '{\n\t"clientSecret": "***MASKED:string***"\n}\n', '{\n\t"clientSecret": "***MASKED:string***",\n\t"port": "***MASKED:number***"\n}\n'],
						['connection/my-conn/common', null, '***MASKED:string***'],
					],
				);
			}
			fs.rmSync(reviewsDir(), { recursive: true, force: true });
		}
	});

	it('employee mode with no rows says No changes found. and writes latest.json only', async () => {
		h.seed({ mode: 'employee', routes: routes(EMP, { [STATE(EMP)]: [200, { app: { approved: true, changes: [] } }] }) });
		const r = await h.run('review-changes.js', ARGS);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('\nNo changes found.\n'), r.stdout);
		assert.ok(r.stdout.includes(`Saved: ${latestFile()}\n`), r.stdout);
		const latest = readLatest();
		assert.equal(latest.source, 'api');
		assert.equal(latest.approved, true);
		assert.equal(latest.totalChanges, 0);
		assert.deepEqual(fs.readdirSync(reviewsDir()), ['latest.json']);
	});

	it('public mode with an approved app and no rows says there is nothing pending', async () => {
		h.seed({ routes: routes(PUB, { [STATE(PUB)]: [200, { app: { approved: true, changes: [] } }] }) });
		seedStale();
		const r = await h.run('review-changes.js', ARGS);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes(`\n${rc.APPROVED_EMPTY_LINE}\n`), r.stdout);
		const latest = readLatest();
		assert.equal(latest.stale, undefined);
		assert.equal(latest.source, 'api');
		assert.equal(latest.approved, true);
		assert.deepEqual(fs.readdirSync(reviewsDir()), ['latest.json']);
	});
});

describe('review-changes.js: the baseline route', () => {
	const NOT_APPROVED = { [STATE(PUB)]: [200, { app: { approved: false, changes: [] } }] };
	const SNAPSHOT = { id: '20261105-141200', takenAt: '2026-11-05T14:12:00.000Z' };
	const snapshotDir = () => path.join(h.snapshotsDir(), 'my-app-v1', SNAPSHOT.id);

	/** A working copy and a snapshot with one row of each kind, a lingering folder and a CRLF-only change. */
	function seedPair({ downloadedAt = later(60000) } = {}) {
		h.writeWorkingCopy({
			metadata: { downloadedAt, modules: [{ name: 'listItems', label: 'List items' }, { name: 'newOne', label: 'New one' }], rpcs: [] },
			files: {
				'base.imljson': '{\r\n    "name": "x"\r\n}\r\n',
				'common.imljson': '{"a": 2}',
				'modules/listItems/api.imljson': '{"url": "/v2"}',
				'modules/newOne/api.imljson': '{"url": "/new"}',
				'modules/gone/api.imljson': '{"url": "/gone"}',
			},
		});
		h.writeSnapshot({
			...SNAPSHOT,
			metadata: { modules: [{ name: 'listItems', label: 'List' }], rpcs: [{ name: 'oldRpc', label: 'Old' }] },
			files: {
				'base.imljson': '{\n    "name": "x"\n}\n\n',
				'common.imljson': '{"a": 1}',
				'modules/listItems/api.imljson': '{"url": "/v1"}',
				'rpcs/oldRpc/api.imljson': '{"url": "/rpc"}',
			},
		});
	}

	it('an unapproved app with a working copy and no snapshot exits 2 with the first message', async () => {
		h.seed({ routes: routes(PUB, NOT_APPROVED) });
		seedStale();
		const r = await h.run('review-changes.js', ARGS);
		assert.equal(r.code, 2, r.out);
		const lines = rc.noSnapshotLines({ slug: 'my-app', version: '1', command: scriptCommand('download-app.js'), explicit: false });
		assert.equal(lines.length, 3);
		assert.ok(r.stderr.endsWith(`${lines.join('\n')}\n`), r.stderr);
		assert.ok(!fs.existsSync(latestFile()));
	});

	it('an unapproved app without a working copy exits 2 with the no local copy line', async () => {
		h.seed({ routes: routes(PUB, NOT_APPROVED) });
		const r = await h.run('review-changes.js', ARGS);
		assert.equal(r.code, 2, r.out);
		assert.ok(r.stderr.endsWith(`${rc.noLocalCopyLine({ slug: 'my-app', version: '1' })}\n`), r.stderr);
		assert.ok(!fs.existsSync(reviewsDir()));
	});

	it('an unapproved app compares the working copy with the newest snapshot', async () => {
		h.seed({ routes: routes(PUB, NOT_APPROVED) });
		seedPair();
		h.writeSnapshot({ id: '20261104-170512', takenAt: '2026-11-04T17:05:12.000Z' });
		const r = await h.run('review-changes.js', ARGS);
		assert.equal(r.code, 0, r.out);
		assert.ok(
			r.stdout.endsWith(
				[
					`Baseline: snapshot ${SNAPSHOT.id} (taken ${SNAPSHOT.takenAt})`,
					'Changes: 7 (modified 3, added 2, removed 2)',
					'Working copy has unpushed edits: no',
					`Saved: ${latestFile()}`,
					'',
				].join('\n'),
			),
			r.stdout,
		);
		const latest = readLatest();
		assert.equal(latest.source, 'baseline');
		assert.equal(latest.approved, false);
		assert.deepEqual(latest.baseline, { ...SNAPSHOT, dir: snapshotDir() });
		assert.equal(latest.workingCopyEdited, false);
		assert.equal(latest.totalChanges, 7);
		assert.deepEqual(Object.fromEntries(latest.changes.map((row) => [row.componentPath, [row.status, row.restorable]])), {
			common: ['modified', false],
			'module/listItems/api': ['modified', true],
			'module/newOne/api': ['added', false],
			'rpc/oldRpc/api': ['removed', false],
			'module/listItems/metadata': ['modified', false],
			'module/newOne/metadata': ['added', false],
			'rpc/oldRpc/metadata': ['removed', false],
		});
		assert.ok(!latest.changes.some((row) => row.path.startsWith('modules/gone') || row.path === 'base.imljson'));
		assert.equal(fs.readdirSync(reviewsDir()).filter((f) => f.startsWith('review-')).length, 1);
		assert.deepEqual(sent(), [ORIGIN(PUB), STATE(PUB)]);
	});

	it('a working copy file changed after the last sync shows as unpushed edits', async () => {
		h.seed({ routes: routes(PUB, NOT_APPROVED) });
		seedPair();
		const file = path.join(h.contextsDir(), 'my-app-v1', 'modules', 'listItems', 'api.imljson');
		const touched = new Date(Date.now() + 120000);
		fs.utimesSync(file, touched, touched);
		const r = await h.run('review-changes.js', ARGS);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('\nWorking copy has unpushed edits: yes\n'), r.stdout);
		assert.equal(readLatest().workingCopyEdited, true);
	});

	it('a newer note or ticket file is no unpushed edit, a newer file of a component made since the sync is one', async () => {
		h.seed({ routes: routes(PUB, NOT_APPROVED) });
		seedPair();
		const touched = new Date(Date.now() + 120000);
		const touch = (rel) => {
			const file = path.join(h.contextsDir(), 'my-app-v1', rel);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, 'x');
			fs.utimesSync(file, touched, touched);
		};
		for (const rel of ['notes.md', 'jira/ticket.md']) touch(rel);
		const r = await h.run('review-changes.js', ARGS);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('\nWorking copy has unpushed edits: no\n'), r.stdout);
		assert.equal(readLatest().workingCopyEdited, false);
		touch('modules/newMod/api.imljson');
		const again = await h.run('review-changes.js', ARGS);
		assert.equal(again.code, 0, again.out);
		assert.ok(again.stdout.includes('\nWorking copy has unpushed edits: yes\n'), again.stdout);
		assert.equal(readLatest().workingCopyEdited, true);
	});

	it('--baseline with an id that does not exist exits 2 and lists the snapshots newest first', async () => {
		h.seed({ routes: routes(PUB, NOT_APPROVED) });
		seedStale();
		h.writeSnapshot({ id: '20261104-170512', takenAt: '2026-11-04T17:05:12.000Z' });
		h.writeSnapshot({ id: '20261105-141200', takenAt: '2026-11-05T14:12:00.000Z' });
		const r = await h.run('review-changes.js', [...ARGS, '--baseline', '20200101-000000']);
		assert.equal(r.code, 2, r.out);
		assert.ok(r.stderr.endsWith('Snapshot 20200101-000000 of my-app v1 does not exist. Snapshots: 20261105-141200, 20261104-170512.\n'), r.stderr);
		assert.ok(!fs.existsSync(latestFile()));
	});

	it('--baseline with an id compares with that snapshot', async () => {
		h.seed({ routes: routes(PUB, NOT_APPROVED) });
		seedPair();
		h.writeSnapshot({ id: '20261106-000000', takenAt: '2026-11-06T00:00:00.000Z' });
		const r = await h.run('review-changes.js', [...ARGS, `--baseline=${SNAPSHOT.id}`]);
		assert.equal(r.code, 0, r.out);
		assert.equal(readLatest().baseline.id, SNAPSHOT.id);
		assert.equal(readLatest().totalChanges, 7);
	});

	it('--baseline latest without any snapshot exits 2 with the message without its first line', async () => {
		h.seed({ mode: 'employee', routes: routes(EMP, { [STATE(EMP)]: [200, { app: { approved: true, changes: [] } }] }) });
		h.writeWorkingCopy();
		const r = await h.run('review-changes.js', [...ARGS, '--baseline', 'latest']);
		assert.equal(r.code, 2, r.out);
		const lines = rc.noSnapshotLines({ slug: 'my-app', version: '1', command: scriptCommand('download-app.js'), explicit: true });
		assert.ok(r.stderr.endsWith(`${lines.join('\n')}\n`), r.stderr);
		assert.ok(!r.stderr.includes('No change list'), r.stderr);
	});

	it('employee mode with rows on the API takes the baseline route with --baseline latest, after the state call', async () => {
		h.seed({ mode: 'employee', routes: routes(EMP, { [STATE(EMP)]: [200, { app: { approved: true, changes: ROWS } }] }) });
		seedPair();
		const r = await h.run('review-changes.js', [...ARGS, '--baseline', 'latest']);
		assert.equal(r.code, 0, r.out);
		const latest = readLatest();
		assert.equal(latest.source, 'baseline');
		assert.equal(latest.approved, true);
		assert.equal(latest.baseline.id, SNAPSHOT.id);
		assert.deepEqual(sent(), [ORIGIN(EMP), STATE(EMP)]);
	});

	it('a working copy whose metadata.json cannot be read exits 1 and writes nothing', async () => {
		h.seed({ routes: routes(PUB, NOT_APPROVED) });
		seedPair();
		fs.writeFileSync(path.join(h.contextsDir(), 'my-app-v1', 'metadata.json'), 'not json');
		const r = await h.run('review-changes.js', ARGS);
		assertFailed(r, 1, { stale: false });
		assert.ok(r.stdout.includes('Failed: 1\n  ✗ local copy (unreadable)\n'), r.stdout);
		assert.ok(!r.stdout.includes(RETRY_FIX), r.stdout);
	});

	it('a snapshot file that cannot be read exits 1 with the local copy failure and no network fix', { skip: NO_MODES }, async () => {
		h.seed({ routes: routes(PUB, NOT_APPROVED) });
		seedPair();
		fs.chmodSync(path.join(snapshotDir(), 'common.imljson'), 0);
		const r = await h.run('review-changes.js', ARGS);
		assertFailed(r, 1, { stale: false });
		assert.ok(r.stdout.includes('Failed: 1\n  ✗ local copy (EACCES)\n'), r.stdout);
		assert.ok(!r.stdout.includes(RETRY_FIX), r.stdout);
	});

	it('a snapshot folder that cannot be listed exits 1 with the cannot read line and no stack trace', { skip: NO_MODES }, async () => {
		h.seed({ routes: routes(PUB, NOT_APPROVED) });
		seedPair();
		const dir = path.join(h.snapshotsDir(), 'my-app-v1');
		fs.chmodSync(dir, 0);
		try {
			const r = await h.run('review-changes.js', ARGS);
			assert.equal(r.code, 1, r.out);
			assert.ok(r.stderr.endsWith(`ERROR: cannot read ${dir} (EACCES)\n`), r.stderr);
			assert.doesNotMatch(r.stderr, /\n\s+at /);
			assert.ok(!fs.existsSync(reviewsDir()));
		} finally {
			fs.chmodSync(dir, 0o700);
		}
	});
});
