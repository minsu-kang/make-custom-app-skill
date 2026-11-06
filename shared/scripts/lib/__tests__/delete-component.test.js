/**
 * Tests for the entry script delete-component.js against the mock Make API of entry-harness.js: the snapshot gate of
 * public mode (spec 3.3), which refuses a deletion before any request when no snapshot is as new as the last sync,
 * and stays silent in employee mode, and the app status call, which stops a public-mode run when Make does not say
 * whether the app is public (spec 3.5 row 15) and fails open in employee mode; and the type and name check, which stops
 * a type or a name with anything but letters, digits, _ and - (a slash, a dot, an empty part) before any request, so
 * that no name reaches another route.
 */
require('./isolate-home');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createHarness } = require('./entry-harness');
const { scriptCommand } = require('../paths');
const { gateRefusalLines } = require('../snapshot-logic');

const GATE_TAIL = `${gateRefusalLines({ slug: 'my-app', version: '1', command: scriptCommand('download-app.js') }).join('\n')}\n`;
const ARGS = ['my-app', '1', 'function', 'foo', '--force'];
const requests = (base) => [
	`GET ${base}/sdk/apps/my-app/1?cols[0]=origin`,
	`GET ${base}/sdk/apps/my-app/1?cols[0]=public&cols[1]=approved`,
	`DELETE ${base}/sdk/apps/my-app/1/functions/foo`,
];
const routes = (base) => {
	const [origin, status, remove] = requests(base);
	return { [origin]: [200, { app: {} }], [status]: [200, { app: { public: false, approved: false } }], [remove]: [200, {}] };
};

let h;

before(async () => {
	h = await createHarness();
});

after(() => h.close());

describe('delete-component.js: the snapshot gate', () => {
	it('public mode without a snapshot exits 2 with the refusal and sends nothing', async () => {
		h.seed({ routes: routes('/api/v2') });
		const r = await h.run('delete-component.js', ARGS);
		assert.equal(r.code, 2, r.out);
		assert.ok(r.stderr.endsWith(GATE_TAIL), r.stderr);
		assert.ok(r.stderr.includes('Target: ') && r.stderr.indexOf('Target: ') < r.stderr.length - GATE_TAIL.length, r.stderr);
		assert.equal(r.stdout, '');
		assert.equal(h.log.length, 0);
	});

	it('public mode with a snapshot older than the last sync exits 2 and sends nothing', async () => {
		h.seed({ routes: routes('/api/v2') });
		h.writeSnapshot({ takenAt: new Date(Date.now() - 60000).toISOString() });
		h.writeWorkingCopy();
		const r = await h.run('delete-component.js', ARGS);
		assert.equal(r.code, 2, r.out);
		assert.ok(r.stderr.endsWith(GATE_TAIL), r.stderr);
		assert.equal(h.log.length, 0);
	});

	it('public mode with a fresh snapshot sends the deletion', async () => {
		h.seed({ routes: routes('/api/v2') });
		h.writeWorkingCopy();
		h.writeSnapshot({ takenAt: new Date(Date.now() + 1000).toISOString() });
		const r = await h.run('delete-component.js', ARGS);
		assert.equal(r.code, 0, r.out);
		assert.ok(!r.stderr.includes('No snapshot of'), r.stderr);
		assert.ok(r.stdout.includes('  ✓ Deleted successfully (HTTP 200)'), r.stdout);
		assert.deepEqual(h.log.map((q) => `${q.method} ${q.url}`), requests('/api/v2'));
	});

	it('employee mode has no gate: the deletion goes out without a snapshot', async () => {
		h.seed({ mode: 'employee', routes: routes('/api/v2/admin') });
		const r = await h.run('delete-component.js', ARGS);
		assert.equal(r.code, 0, r.out);
		assert.ok(!r.stderr.includes('No snapshot of'), r.stderr);
		assert.deepEqual(h.log.map((q) => `${q.method} ${q.url}`), requests('/api/v2/admin'));
	});
});

describe('delete-component.js: the app status (spec 3.5 row 15)', () => {
	const STOP_LINES = [
		'ERROR: Make did not say whether app my-app v1 is public (the status call failed or had no public field), so nothing was deleted.',
		'Run download-app.js and read metadata.json (public, approved). A public app allows deleting only RPCs and functions. Then run this again.',
	].join('\n');
	const seedStatus = (mode, status, args) => {
		const base = mode === 'employee' ? '/api/v2/admin' : '/api/v2';
		const [origin, statusRoute, remove] = requests(base);
		h.seed({ mode, routes: { [origin]: [200, { app: {} }], [statusRoute]: status, [remove]: [200, {}], [`DELETE ${base}/sdk/apps/my-app/1/modules/m`]: [200, {}] } });
		if (mode === 'public') {
			h.writeWorkingCopy();
			h.writeSnapshot({ takenAt: new Date(Date.now() + 1000).toISOString() });
		}
		return h.run('delete-component.js', args || ARGS);
	};
	const deletes = () => h.log.filter((q) => q.method === 'DELETE');

	it('public mode stops when the status call fails, before any DELETE', async () => {
		const r = await seedStatus('public', [500, { message: 'boom' }]);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stderr.includes(`${STOP_LINES}\n`), r.stderr);
		assert.ok(!r.stdout.includes('App status:'), r.stdout);
		assert.equal(deletes().length, 0);
	});

	it('public mode stops when the answer has no public field', async () => {
		const r = await seedStatus('public', [200, { app: { approved: false } }]);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stderr.includes(`${STOP_LINES}\n`), r.stderr);
		assert.equal(deletes().length, 0);
	});

	it('public mode stops on a status answer that is not JSON, without the parser error', async () => {
		const r = await seedStatus('public', [200, 'not json']);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stderr.includes(`${STOP_LINES}\n`), r.stderr);
		assert.ok(!r.out.includes('ERROR: Unexpected token'), r.out);
		assert.equal(deletes().length, 0);
	});

	it('public mode goes on when Make says the app is private', async () => {
		const r = await seedStatus('public', [200, { app: { public: false, approved: false } }]);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('  App status: private\n'), r.stdout);
		assert.equal(deletes().length, 1);
	});

	it('public mode refuses a module of a public app, as before', async () => {
		const r = await seedStatus('public', [200, { app: { public: true, approved: false } }], ['my-app', '1', 'module', 'm', '--force']);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stdout.includes('  App status: public\n'), r.stdout);
		assert.ok(r.stderr.includes('Cannot delete module "m"'), r.stderr);
		assert.equal(deletes().length, 0);
	});

	it('employee mode still fails open on a failed status call: private, and the DELETE goes out', async () => {
		const r = await seedStatus('employee', [500, { message: 'boom' }]);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('  App status: private\n'), r.stdout);
		assert.ok(!r.stderr.includes('Make did not say'), r.stderr);
		assert.equal(deletes().length, 1);
	});

	it('employee mode still stops with the ERROR line on a status answer that is not JSON, and deletes nothing', async () => {
		const r = await seedStatus('employee', [200, 'not json']);
		assert.equal(r.code, 1, r.out);
		assert.match(r.stderr, /^ERROR: /m);
		assert.ok(!r.stderr.includes('Make did not say'), r.stderr);
		assert.equal(deletes().length, 0);
	});
});

describe('delete-component.js: the type and name check', () => {
	const nameLine = (part, value) => `ERROR: the component ${part} "${value}" may hold only letters, digits, _ and -.\n`;
	const usage = 'Usage: node delete-component.js <app-slug> <app-version> <type> <name> [--force]\n';

	it('stops a name with a . or .. part, a dot, an empty part or a slash before any request, in both modes', async () => {
		for (const mode of ['public', 'employee']) {
			for (const name of ['../common', 'a/../b', 'a.b', 'a/', 'f/x', 'a b']) {
				h.seed({ mode });
				const r = await h.run('delete-component.js', ['my-app', '1', 'function', name, '--force']);
				assert.equal(r.code, 1, r.out);
				assert.equal(r.stderr, nameLine('name', name), name);
				assert.equal(r.stdout, '', name);
				assert.equal(h.log.length, 0, name);
			}
		}
	});

	it('a name with a slash never reaches a sub-route of the component, in both modes', async () => {
		const cases = [['endpoint', 'listFiles/connections', 'my-app/1/endpoints'], ['module', 'm/public', 'my-app/1/modules'], ['connection', 'c/common', 'connections'], ['function', 'f/test', 'my-app/1/functions']];
		for (const [mode, base] of [['public', '/api/v2'], ['employee', '/api/v2/admin']]) {
			for (const [type, name, route] of cases) {
				h.seed({
					mode,
					routes: {
						[`GET ${base}/sdk/apps/my-app/1?cols[0]=origin`]: [200, { app: {} }],
						[`GET ${base}/sdk/apps/my-app/1?cols[0]=public&cols[1]=approved`]: [200, { app: { public: false, approved: false } }],
						[`DELETE ${base}/sdk/apps/${route}/${name}`]: [200, {}],
					},
				});
				h.writeWorkingCopy();
				h.writeSnapshot({ takenAt: new Date(Date.now() + 1000).toISOString() });
				const r = await h.run('delete-component.js', ['my-app', '1', type, name, '--force']);
				assert.equal(r.code, 1, r.out);
				assert.equal(r.stderr, nameLine('name', name), name);
				assert.equal(h.log.length, 0, name);
			}
		}
	});

	it('an empty name stops at the usage, before any request, in both modes', async () => {
		for (const mode of ['public', 'employee']) {
			h.seed({ mode });
			const r = await h.run('delete-component.js', ['my-app', '1', 'function', '', '--force']);
			assert.equal(r.code, 1, r.out);
			assert.ok(r.stdout.startsWith(usage), r.stdout);
			assert.equal(h.log.length, 0);
		}
	});

	it('the name check runs before the mode check: without a saved key a bad name still gets its own line', async () => {
		h.seed();
		fs.rmSync(path.join(h.home, '.make-custom-app-skill-secrets'));
		const bad = await h.run('delete-component.js', ['my-app', '1', 'module', '../x', '--force']);
		assert.equal(bad.code, 1, bad.out);
		assert.equal(bad.stderr, nameLine('name', '../x'));
		const good = await h.run('delete-component.js', ['my-app', '1', 'module', 'x', '--force']);
		assert.equal(good.code, 1, good.out);
		assert.ok(good.stderr.startsWith('ERROR: Make API key not configured.'), good.stderr);
		assert.equal(h.log.length, 0);
	});

	it('a type outside the list keeps the Unknown type error when it holds only valid characters', async () => {
		for (const mode of ['public', 'employee']) {
			h.seed({ mode });
			const r = await h.run('delete-component.js', ['my-app', '1', 'widget', 'm', '--force']);
			assert.equal(r.code, 1, r.out);
			assert.equal(r.stderr, 'ERROR: Unknown type "widget". Supported: module, rpc, function, connection, webhook, endpoint\n');
			assert.equal(h.log.length, 0);
			for (const type of ['wid.get', 'module/x', 'module/']) {
				const bad = await h.run('delete-component.js', ['my-app', '1', type, 'm', '--force']);
				assert.equal(bad.code, 1, bad.out);
				assert.equal(bad.stderr, nameLine('type', type), type);
				assert.equal(h.log.length, 0, type);
			}
		}
	});
});
