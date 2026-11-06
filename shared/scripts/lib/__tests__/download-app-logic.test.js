/**
 * Tests for download-app-logic.js: which call results count as saved, absent or failed, the origin decision of each
 * mode, the visibility outcome, and the Done block. No server: download-app.test.js runs the script itself.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../download-app-logic');
const { originStop, TOKEN_SCOPES, formatScopes } = require('../mode-logic');
const { snapshotDoneLines } = require('../snapshot-logic');

const ok = (body) => ({ status: 200, body, error: null });
const status = (n) => ({ status: n, body: '{"message":"x"}', error: null });
const network = (code) => ({ status: null, body: null, error: code });

describe('classifySection', () => {
	it('saves a 2xx answer with content', () => {
		assert.equal(logic.classifySection(ok('{"url":"/x"}')), 'saved');
		assert.equal(logic.classifySection({ status: 201, body: '[]', error: null }), 'saved');
	});

	it('counts an empty 2xx answer as absent', () => {
		for (const body of ['null', '', '  \n', null]) assert.equal(logic.classifySection(ok(body)), 'absent', JSON.stringify(body));
	});

	it('counts a 404 on a section as absent, as before', () => {
		assert.equal(logic.classifySection(status(404)), 'absent');
	});

	it('fails on 401, 403, 429, other 4xx, 5xx and network errors', () => {
		for (const r of [status(401), status(403), status(429), status(400), status(410), status(500), status(503), network('ECONNRESET')]) {
			assert.equal(logic.classifySection(r), 'failed', JSON.stringify(r));
		}
	});
});

describe('failureReason', () => {
	it('names the error code, the status, the retries after 429, 502, 503 or 504, or an unexpected 2xx answer', () => {
		assert.equal(logic.failureReason(network('UND_ERR_SOCKET')), 'UND_ERR_SOCKET');
		assert.equal(logic.failureReason(status(429)), 'HTTP 429 after 5 retries');
		assert.equal(logic.failureReason(status(403)), 'HTTP 403');
		assert.equal(logic.failureReason(status(502)), 'HTTP 502 after 5 retries');
		assert.equal(logic.failureReason(status(503)), 'HTTP 503 after 5 retries');
		assert.equal(logic.failureReason(status(504)), 'HTTP 504 after 5 retries');
		assert.equal(logic.failureReason(status(500)), 'HTTP 500');
		assert.equal(logic.failureReason(ok('not json')), 'unexpected response');
	});
});

describe('readJson, readList and readDetail', () => {
	it('returns the parsed object of a 2xx answer', () => {
		assert.deepEqual(logic.readJson(ok('{"app":{"origin":"eu1.make.com"}}')), { body: { app: { origin: 'eu1.make.com' } } });
	});

	it('fails on a non-2xx answer (a 404 included), on text that is not JSON, and on JSON that is not an object', () => {
		assert.deepEqual(logic.readJson(status(404)), { reason: 'HTTP 404' });
		assert.deepEqual(logic.readJson(network('ECONNREFUSED')), { reason: 'ECONNREFUSED' });
		assert.deepEqual(logic.readJson(ok('<html>')), { reason: 'unexpected response' });
		assert.deepEqual(logic.readJson(ok('null')), { reason: 'unexpected response' });
		assert.deepEqual(logic.readJson(ok('7')), { reason: 'unexpected response' });
	});

	it('returns the items of a list, also an empty one', () => {
		assert.deepEqual(logic.readList(ok('{"appModules":[{"name":"a"}]}'), 'appModules'), { items: [{ name: 'a' }] });
		assert.deepEqual(logic.readList(ok('{"appRpcs":[]}'), 'appRpcs'), { items: [] });
	});

	it('fails a list on a 404, on a missing array key, and passes other failures through', () => {
		assert.deepEqual(logic.readList(ok('{"webhooks":[]}'), 'appWebhooks'), { reason: 'unexpected response' });
		assert.deepEqual(logic.readList(ok('{"appWebhooks":{}}'), 'appWebhooks'), { reason: 'unexpected response' });
		assert.deepEqual(logic.readList(status(404), 'appWebhooks'), { reason: 'HTTP 404' });
		assert.deepEqual(logic.readList(status(429), 'appWebhooks'), { reason: 'HTTP 429 after 5 retries' });
	});

	it('reads the endpoint detail like a section: a 404 is absent, every other failure fails', () => {
		assert.deepEqual(logic.readDetail(ok('{"appEndpoint":{"context":"x"}}')), { body: { appEndpoint: { context: 'x' } } });
		assert.deepEqual(logic.readDetail(status(404)), { absent: true });
		assert.deepEqual(logic.readDetail(status(403)), { reason: 'HTTP 403' });
		assert.deepEqual(logic.readDetail(status(503)), { reason: 'HTTP 503 after 5 retries' });
		assert.deepEqual(logic.readDetail(network('ECONNRESET')), { reason: 'ECONNRESET' });
		assert.deepEqual(logic.readDetail(ok('<html>')), { reason: 'unexpected response' });
	});
});

describe('gateFailure', () => {
	const app = { slug: 'my-app', version: '1', host: 'eu1.make.com' };

	it('adds a fix line for a 404 on the app version', () => {
		assert.deepEqual(logic.gateFailure('HTTP 404', app), {
			what: 'app my-app v1',
			reason: 'HTTP 404',
			fix: 'eu1.make.com has no my-app v1 that this token can read: check the slug, the version and the zone.',
		});
	});

	it('leaves the fix to fixesFor for every other reason', () => {
		assert.deepEqual(logic.gateFailure('HTTP 401', app), { what: 'app my-app v1', reason: 'HTTP 401' });
	});
});

describe('planOrigin', () => {
	it('stays on the token host when the origin is missing or the same', () => {
		for (const mode of ['employee', 'public']) {
			for (const origin of [undefined, null, '', 'eu1.make.com', 'EU1.make.com/api']) assert.deepEqual(logic.planOrigin(mode, 'eu1.make.com', origin), { action: 'stay' }, `${mode} ${origin}`);
		}
	});

	it('switches to the origin host in employee mode, as before', () => {
		assert.deepEqual(logic.planOrigin('employee', 'eu1.make.com', 'us1.make.com'), { action: 'switch', host: 'us1.make.com' });
		assert.deepEqual(logic.planOrigin('employee', 'eu1.make.com', 'US1.make.com/api'), { action: 'switch', host: 'us1.make.com' });
	});

	it('fails in public mode with the reason and the fix of originStop', () => {
		const plan = logic.planOrigin('public', 'eu1.make.com', 'us1.make.com');
		const stop = originStop({ mode: 'public', host: 'eu1.make.com', origin: 'us1.make.com' });
		assert.deepEqual(plan, { action: 'fail', failure: { what: 'app origin', reason: stop.reason, fix: stop.fix } });
		assert.deepEqual(plan.failure, {
			what: 'app origin',
			reason: 'the app lives in us1.make.com, the token is for eu1.make.com',
			fix: 'To work on this app, set up a Make API token of us1.make.com (create it at https://us1.make.com/user/api).',
		});
	});
});

describe('visibilityHeader', () => {
	it('names the admin endpoint only in employee mode', () => {
		assert.equal(logic.visibilityHeader('public'), '=== Visibility ===');
		assert.equal(logic.visibilityHeader('employee'), '=== Visibility (admin app endpoint) ===');
	});
});

describe('visibilityOutcome', () => {
	const versions = { app: { versions: [{ version: '1.2.0', private: true }, { version: 2, private: false }] } };

	it('records visibility unknown in public mode, where the call is not made', () => {
		assert.deepEqual(logic.visibilityOutcome(null, '1', 'eu1.make.com'), {
			ipmDeployed: null,
			verRow: null,
			line: '  · Visibility flags (private, packagePrivate, ipmDeployedToZone) are not available in public mode. metadata.json keeps them as null.',
		});
	});

	it('finds the version row by exact version, then by major', () => {
		const exact = logic.visibilityOutcome(ok(JSON.stringify(versions)), '2', 'eu1.make.com');
		assert.deepEqual(exact, { ipmDeployed: true, verRow: { version: 2, private: false }, line: '  ✓ IPM-deployed to eu1.make.com (2 version row(s))' });
		assert.deepEqual(logic.visibilityOutcome(ok(JSON.stringify(versions)), '1', 'x').verRow, { version: '1.2.0', private: true });
		assert.equal(logic.visibilityOutcome(ok(JSON.stringify(versions)), '3', 'x').verRow, null);
		assert.deepEqual(logic.visibilityOutcome(ok('{"app":{}}'), '1', 'eu1.make.com'), { ipmDeployed: true, verRow: null, line: '  ✓ IPM-deployed to eu1.make.com (0 version row(s))' });
	});

	it('keeps the 404, 403 and other status lines of before, and never fails', () => {
		assert.deepEqual(logic.visibilityOutcome(status(404), '1', 'x'), { ipmDeployed: false, verRow: null, line: '  · 404 → app not IPM-deployed to this zone (compiled but not published). Visibility flags = null.' });
		assert.deepEqual(logic.visibilityOutcome(status(403), '1', 'x'), { ipmDeployed: null, verRow: null, line: '  · 403 → caller lacks admin access to this endpoint. Visibility flags = null.' });
		assert.deepEqual(logic.visibilityOutcome(status(500), '1', 'x'), { ipmDeployed: null, verRow: null, line: '  · HTTP 500 on admin endpoint. Visibility flags = null.' });
	});

	it('never throws on a malformed 200 body: unusable versions give the unknown result, bad rows and modules are skipped', () => {
		const unusable = { ipmDeployed: null, verRow: null, line: '  · admin endpoint error: unexpected response. Visibility flags = null.' };
		for (const body of ['{"app":{"versions":{}}}', '{"app":{"versions":"x"}}']) {
			assert.deepEqual(logic.visibilityOutcome(ok(body), '1', 'eu1.make.com'), unusable, body);
		}
		assert.deepEqual(logic.visibilityOutcome(ok('{"app":{"versions":[null,"x",3]}}'), '1', 'eu1.make.com'), {
			ipmDeployed: true,
			verRow: null,
			line: '  ✓ IPM-deployed to eu1.make.com (3 version row(s))',
		});
		for (const modules of ['"x"', '{}', 'null']) {
			const outcome = logic.visibilityOutcome(ok(`{"app":{"versions":[null,{"version":1,"private":true,"modules":${modules}}]}}`), '1', 'x');
			assert.deepEqual(outcome.verRow, { version: 1, private: true, modules: [] }, modules);
		}
		const mixed = logic.visibilityOutcome(ok('{"app":{"versions":[{"version":1,"modules":[null,{"name":"m","private":true}]}]}}'), '1', 'x');
		assert.deepEqual(mixed.verRow.modules, [{ name: 'm', private: true }]);
	});

	it('prints an error code or "unexpected response", never an error message', () => {
		assert.equal(logic.visibilityOutcome(network('ECONNRESET'), '1', 'x').line, '  · admin endpoint error: ECONNRESET. Visibility flags = null.');
		assert.deepEqual(logic.visibilityOutcome(ok('<html>'), '1', 'x'), { ipmDeployed: null, verRow: null, line: '  · admin endpoint error: unexpected response. Visibility flags = null.' });
	});
});

describe('AUTH_FIX', () => {
	it('names the token scopes of mode-logic, the one source of the scope list', () => {
		assert.equal(logic.AUTH_FIX, `For HTTP 401 or 403: the Make API token was rejected, lacks one of the scopes ${formatScopes(TOKEN_SCOPES)}, or cannot read this app, and Make answers 403 for an app version that does not exist too. Check the slug and the version, then run check-setup.js.`);
	});
});

describe('fixesFor', () => {
	it('gives one line per kind of failure, an own fix first', () => {
		const failed = [
			{ what: 'a', reason: 'HTTP 401' },
			{ what: 'b', reason: 'HTTP 403' },
			{ what: 'c', reason: 'HTTP 500' },
			{ what: 'd', reason: 'ECONNRESET' },
			{ what: 'e', reason: 'HTTP 404', fix: 'Own fix.' },
		];
		assert.deepEqual(logic.fixesFor(failed), [logic.AUTH_FIX, logic.RETRY_FIX, 'Own fix.']);
	});

	it('gives the retry line to a 404 without its own fix (a component list)', () => {
		assert.deepEqual(logic.fixesFor([{ what: 'RPC list', reason: 'HTTP 404' }]), [logic.RETRY_FIX]);
	});
});

describe('doneLines and failedErrorLine', () => {
	it('prints Saved, Absent and Path when nothing failed', () => {
		assert.deepEqual(logic.doneLines({ saved: 3, absent: 2, failed: [], outputDir: '/o', mode: 'employee' }), [
			'',
			'=== Done ===',
			'  Saved: 3 file(s)',
			'  Absent: 2 (empty or not set on the server)',
			'  Path: /o',
		]);
	});

	it('adds the visibility line in public mode', () => {
		assert.deepEqual(logic.doneLines({ saved: 1, absent: 0, failed: [], outputDir: '/o', mode: 'public' }).slice(4), ['  Visibility: unknown (public mode)', '  Path: /o']);
	});

	it('prints Failed: N with every failed section, says nothing was written, and adds the fixes', () => {
		const failed = [
			{ what: 'module list', reason: 'HTTP 403' },
			{ what: 'base.imljson', reason: 'HTTP 500' },
		];
		assert.deepEqual(logic.doneLines({ saved: 4, absent: 1, failed, outputDir: '/o', mode: 'public' }), [
			'',
			'=== Done ===',
			'  Failed: 2',
			'    ✗ module list (HTTP 403)',
			'    ✗ base.imljson (HTTP 500)',
			'  Nothing was written: /o is unchanged.',
			`  ${logic.AUTH_FIX}`,
			`  ${logic.RETRY_FIX}`,
		]);
	});

	it('ends a snapshot run with the four snapshot lines instead of the Path line', () => {
		const snapshot = { id: '20261105-141200', dir: '/s/my-app-v1/20261105-141200', kept: 3 };
		const lines = logic.doneLines({ saved: 2, absent: 1, failed: [], outputDir: '/o', mode: 'public', snapshotMode: true, snapshot });
		assert.deepEqual(lines.slice(-4), snapshotDoneLines(snapshot));
		assert.deepEqual(lines.slice(0, -4), ['', '=== Done ===', '  Saved: 2 file(s)', '  Absent: 1 (empty or not set on the server)', '  Visibility: unknown (public mode)']);
		assert.ok(!lines.some((line) => line.startsWith('  Path:')), lines.join('\n'));
	});

	it('says that no snapshot was taken when a snapshot run failed', () => {
		const lines = logic.doneLines({ saved: 0, absent: 0, failed: [{ what: 'base.imljson', reason: 'HTTP 500' }], outputDir: '/o', mode: 'employee', snapshotMode: true });
		assert.deepEqual(lines, ['', '=== Done ===', '  Failed: 1', '    ✗ base.imljson (HTTP 500)', '  Nothing was written: no snapshot was taken.', `  ${logic.RETRY_FIX}`]);
	});

	it('names the count and the app on the stderr line', () => {
		assert.equal(
			logic.failedErrorLine(2, 'my-app', '1'),
			'ERROR: 2 section(s) of my-app v1 could not be read, so nothing was written. Show the failed sections above to the user; do not answer from the local copy.',
		);
	});
});

describe('takeSnapshotFlag, USAGE_LINES and SNAPSHOT_WITH_OUTPUT_DIR', () => {
	it('removes every --snapshot from argv in place and says whether there was one', () => {
		const argv = ['node', 's', 'a', '--snapshot', '1'];
		assert.equal(logic.takeSnapshotFlag(argv), true);
		assert.deepEqual(argv, ['node', 's', 'a', '1']);
		const twice = ['node', 's', '--snapshot', 'a', '1', '--snapshot'];
		assert.equal(logic.takeSnapshotFlag(twice), true);
		assert.deepEqual(twice, ['node', 's', 'a', '1']);
	});

	it('leaves argv as it was without the flag', () => {
		const argv = ['node', 's', 'a', '1', '/tmp/out', '--snapshots'];
		assert.equal(logic.takeSnapshotFlag(argv), false);
		assert.deepEqual(argv, ['node', 's', 'a', '1', '/tmp/out', '--snapshots']);
	});

	it('gives the usage with --snapshot and the usage error of an output dir', () => {
		assert.deepEqual(logic.USAGE_LINES, [
			'Usage: node download-app.js <app-slug> <app-version> [output-dir | --snapshot]',
			'Example: node download-app.js google-docs 1',
			'        node download-app.js instagram 5 /tmp/instagram-v5',
			'        node download-app.js google-docs 1 --snapshot',
		]);
		assert.equal(logic.SNAPSHOT_WITH_OUTPUT_DIR, 'ERROR: --snapshot saves to ~/.make-custom-app/snapshots and takes no output dir.');
		assert.deepEqual(logic.snapshotWriteErrorLines('EEXIST'), ['ERROR: the snapshot could not be written (EEXIST), so none was kept.', 'Check that ~/.make-custom-app/snapshots can be written, then run the same command again.']);
		assert.equal(logic.snapshotWriteErrorLines(undefined)[0], 'ERROR: the snapshot could not be written (error), so none was kept.');
	});
});
