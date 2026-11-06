/**
 * Tests for the entry script update-component.js against the mock Make API of entry-harness.js: the snapshot gate of
 * public mode (spec 3.3), which refuses a metadata update before any request when no snapshot is as new as the last
 * sync, and stays silent in employee mode; the flag actions of spec 3.5 row 20 and 3.8 (show, hide and deprecate a
 * module in public mode, Publish and Unpublish kept in employee mode); and the type and name check, which stops a type
 * or a name with anything but letters, digits, _ and - (a slash, a dot, an empty part) before any request, so that no
 * name reaches another route.
 */
require('./isolate-home');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createHarness } = require('./entry-harness');
const { scriptCommand } = require('../paths');
const { gateRefusalLines } = require('../snapshot-logic');
const u = require('../update-component-logic');

const GATE_TAIL = `${gateRefusalLines({ slug: 'my-app', version: '1', command: scriptCommand('download-app.js') }).join('\n')}\n`;
const ARGS = ['my-app', '1', 'module', 'myModule', 'label=x'];
const requests = (base) => [`GET ${base}/sdk/apps/my-app/1?cols[0]=origin`, `PATCH ${base}/sdk/apps/my-app/1/modules/myModule`];
const routes = (base) => Object.fromEntries(requests(base).map((key, i) => [key, i === 0 ? [200, { app: {} }] : [200, {}]]));

let h;

before(async () => {
	h = await createHarness();
});

after(() => h.close());

describe('update-component.js: the snapshot gate', () => {
	it('public mode without a snapshot exits 2 with the refusal and sends nothing', async () => {
		h.seed({ routes: routes('/api/v2') });
		const r = await h.run('update-component.js', ARGS);
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
		const r = await h.run('update-component.js', ARGS);
		assert.equal(r.code, 2, r.out);
		assert.ok(r.stderr.endsWith(GATE_TAIL), r.stderr);
		assert.equal(h.log.length, 0);
	});

	it('public mode with a fresh snapshot sends the update', async () => {
		h.seed({ routes: routes('/api/v2') });
		h.writeWorkingCopy();
		h.writeSnapshot({ takenAt: new Date(Date.now() + 1000).toISOString() });
		const r = await h.run('update-component.js', ARGS);
		assert.equal(r.code, 0, r.out);
		assert.ok(!r.stderr.includes('No snapshot of'), r.stderr);
		assert.deepEqual(h.log.map((q) => `${q.method} ${q.url}`), requests('/api/v2'));
		assert.deepEqual(JSON.parse(h.log[1].body), { label: 'x' });
	});

	it('employee mode has no gate: the update goes out without a snapshot', async () => {
		h.seed({ mode: 'employee', routes: routes('/api/v2/admin') });
		const r = await h.run('update-component.js', ARGS);
		assert.equal(r.code, 0, r.out);
		assert.ok(!r.stderr.includes('No snapshot of'), r.stderr);
		assert.deepEqual(h.log.map((q) => `${q.method} ${q.url}`), requests('/api/v2/admin'));
	});
});

describe('update-component.js: the flag actions', () => {
	const originRoute = (base) => ({ [`GET ${base}/sdk/apps/my-app/1?cols[0]=origin`]: [200, { app: {} }] });
	const postRoutes = (base, ...paths) => ({ ...originRoute(base), ...Object.fromEntries(paths.map((p) => [`POST ${base}/sdk/apps/my-app/1/${p}`, [200, {}]])) });
	const fresh = () => {
		h.writeWorkingCopy();
		h.writeSnapshot({ takenAt: new Date(Date.now() + 1000).toISOString() });
	};
	const posted = () => h.log.filter((q) => q.method === 'POST').map((q) => q.url);
	const lines = (r) => r.stdout.split('\n');

	it('public: a module public flag shows the module, with the note between the title and the POST', async () => {
		h.seed({ routes: postRoutes('/api/v2', 'modules/m/public') });
		fresh();
		const r = await h.run('update-component.js', ['my-app', '1', 'module', 'm', 'public=true']);
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(posted(), ['/api/v2/sdk/apps/my-app/1/modules/m/public']);
		const out = lines(r);
		const at = out.indexOf('  Show module (public): module "m"');
		assert.ok(at >= 0, r.stdout);
		assert.equal(out[at + 1], u.MODULE_PUBLIC_NOTE);
		assert.equal(out[at + 2], `  POST http://127.0.0.1:${h.port}/api/v2/sdk/apps/my-app/1/modules/m/public`);
		assert.ok(out.includes('  ✓ Show module succeeded (HTTP 200)'), r.stdout);
		assert.ok(!r.stdout.includes('Publish'), r.stdout);
	});

	it('public: a module public=false hides the module', async () => {
		h.seed({ routes: postRoutes('/api/v2', 'modules/m/private') });
		fresh();
		const r = await h.run('update-component.js', ['my-app', '1', 'module', 'm', 'public=false']);
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(posted(), ['/api/v2/sdk/apps/my-app/1/modules/m/private']);
		const out = lines(r);
		assert.equal(out[out.indexOf('  Hide module (private): module "m"') + 1], u.MODULE_PUBLIC_NOTE);
		assert.ok(out.includes('  ✓ Hide module succeeded (HTTP 200)'), r.stdout);
	});

	it('public: an endpoint public flag has its own title and no note', async () => {
		h.seed({ routes: postRoutes('/api/v2', 'endpoints/e/public') });
		fresh();
		const r = await h.run('update-component.js', ['my-app', '1', 'endpoint', 'e', 'public=true']);
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(posted(), ['/api/v2/sdk/apps/my-app/1/endpoints/e/public']);
		const out = lines(r);
		const at = out.indexOf('  Set endpoint public: endpoint "e"');
		assert.ok(at >= 0, r.stdout);
		assert.ok(out[at + 1].startsWith('  POST '), r.stdout);
		assert.ok(!r.stdout.includes(u.MODULE_PUBLIC_NOTE), r.stdout);
		assert.ok(out.includes('  ✓ Set endpoint public succeeded (HTTP 200)'), r.stdout);
	});

	it('employee: Publish and Unpublish stay, without a note', async () => {
		h.seed({ mode: 'employee', routes: postRoutes('/api/v2/admin', 'modules/m/public') });
		const r = await h.run('update-component.js', ['my-app', '1', 'module', 'm', 'public=true']);
		assert.equal(r.code, 0, r.out);
		const out = lines(r);
		const at = out.indexOf('  Publish: module "m"');
		assert.ok(at >= 0, r.stdout);
		assert.ok(out[at + 1].startsWith('  POST '), r.stdout);
		assert.ok(out.includes('  ✓ Publish succeeded (HTTP 200)'), r.stdout);
		assert.ok(!r.stdout.includes(u.MODULE_PUBLIC_NOTE), r.stdout);
	});

	it('public: module deprecated=true and deprecated=false use the deprecate and undeprecate routes', async () => {
		h.seed({ routes: postRoutes('/api/v2', 'modules/m/deprecate', 'modules/m/undeprecate') });
		fresh();
		let r = await h.run('update-component.js', ['my-app', '1', 'module', 'm', 'deprecated=true']);
		assert.equal(r.code, 0, r.out);
		assert.ok(lines(r).includes('  Deprecate module: module "m"'), r.stdout);
		assert.ok(lines(r).includes('  ✓ Deprecate module succeeded (HTTP 200)'), r.stdout);
		r = await h.run('update-component.js', ['my-app', '1', 'module', 'm', 'deprecated=false']);
		assert.equal(r.code, 0, r.out);
		assert.ok(lines(r).includes('  Undeprecate module: module "m"'), r.stdout);
		assert.ok(lines(r).includes('  ✓ Undeprecate module succeeded (HTTP 200)'), r.stdout);
		assert.deepEqual(posted(), ['/api/v2/sdk/apps/my-app/1/modules/m/deprecate', '/api/v2/sdk/apps/my-app/1/modules/m/undeprecate']);
		assert.ok(!h.log.some((q) => q.method === 'PATCH'));
	});

	it('employee: a module deprecated field stops with today\'s refusal, before any request', async () => {
		h.seed({ mode: 'employee', routes: postRoutes('/api/v2/admin', 'modules/m/deprecate') });
		const r = await h.run('update-component.js', ['my-app', '1', 'module', 'm', 'deprecated=true']);
		assert.equal(r.code, 1, r.out);
		const refusal = u.employeeFieldError({ mode: 'employee', type: 'module', body: { deprecated: true } });
		assert.ok(r.stderr.endsWith(`${refusal.join('\n')}\n`), r.stderr);
		assert.equal(h.log.length, 0);
	});

	it('public: a failed flag call prints the verb and exits 1', async () => {
		h.seed({ routes: { ...originRoute('/api/v2'), 'POST /api/v2/sdk/apps/my-app/1/modules/m/public': [500, { message: 'boom' }] } });
		fresh();
		const r = await h.run('update-component.js', ['my-app', '1', 'module', 'm', 'public=true']);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stderr.split('\n').includes('  ✗ Show module failed (HTTP 500)'), r.stderr);
		assert.ok(!r.stdout.includes('succeeded'), r.stdout);
	});

	it('a flag together with a field sends the POST and the PATCH with the field only', async () => {
		h.seed({ routes: { ...postRoutes('/api/v2', 'modules/m/public'), 'PATCH /api/v2/sdk/apps/my-app/1/modules/m': [200, {}] } });
		fresh();
		const r = await h.run('update-component.js', ['my-app', '1', 'module', 'm', 'public=true', 'label=x']);
		assert.equal(r.code, 0, r.out);
		const patch = h.log.find((q) => q.method === 'PATCH');
		assert.deepEqual(JSON.parse(patch.body), { label: 'x' });
	});

	it('with no arguments the usage holds both row 20 comments and the module deprecated field', async () => {
		h.seed({ routes: {} });
		const r = await h.run('update-component.js', []);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stdout, `${u.USAGE_LINES.join('\n')}\n`);
		assert.ok(r.stdout.includes('  node update-component.js monday 2 module newModule public=true     # show the module in the scenario editor\n'));
		assert.ok(r.stdout.includes('  node update-component.js monday 2 module oldModule public=false    # hide the module\n'));
		assert.ok(r.stdout.includes('crud, public, deprecated (public mode only)\n'));
		assert.equal(h.log.length, 0);
	});
});

describe('update-component.js: the type and name check', () => {
	const nameLine = (part, value) => `ERROR: the component ${part} "${value}" may hold only letters, digits, _ and -.\n`;

	it('stops a name with a . or .. part, a dot, an empty part or a slash before any request, in both modes', async () => {
		for (const mode of ['public', 'employee']) {
			for (const name of ['../common', 'a/../b', 'a.b', 'a/', 'm/public', 'a b']) {
				h.seed({ mode });
				const r = await h.run('update-component.js', ['my-app', '1', 'module', name, 'label=x']);
				assert.equal(r.code, 1, r.out);
				assert.equal(r.stderr, nameLine('name', name), name);
				assert.equal(r.stdout, '', name);
				assert.equal(h.log.length, 0, name);
			}
		}
	});

	it('a name with a slash never reaches a sub-route of the component, in both modes', async () => {
		const cases = [['module', 'm/public', 'my-app/1/modules'], ['endpoint', 'listFiles/connections', 'my-app/1/endpoints'], ['connection', 'c/common', 'connections'], ['rpc', 'r/x', 'my-app/1/rpcs']];
		for (const [mode, base] of [['public', '/api/v2'], ['employee', '/api/v2/admin']]) {
			for (const [type, name, route] of cases) {
				h.seed({ mode, routes: { [`GET ${base}/sdk/apps/my-app/1?cols[0]=origin`]: [200, { app: {} }], [`PATCH ${base}/sdk/apps/${route}/${name}`]: [200, {}] } });
				h.writeWorkingCopy();
				h.writeSnapshot({ takenAt: new Date(Date.now() + 1000).toISOString() });
				const r = await h.run('update-component.js', ['my-app', '1', type, name, 'label=x']);
				assert.equal(r.code, 1, r.out);
				assert.equal(r.stderr, nameLine('name', name), name);
				assert.equal(h.log.length, 0, name);
			}
		}
	});

	it('an empty name stops at the usage, before any request, in both modes', async () => {
		for (const mode of ['public', 'employee']) {
			h.seed({ mode });
			const r = await h.run('update-component.js', ['my-app', '1', 'module', '', 'label=x']);
			assert.equal(r.code, 1, r.out);
			assert.equal(r.stdout, `${u.USAGE_LINES.join('\n')}\n`);
			assert.equal(h.log.length, 0);
		}
	});

	it('the name check runs before the mode check: without a saved key a bad name still gets its own line', async () => {
		h.seed();
		fs.rmSync(path.join(h.home, '.make-custom-app-skill-secrets'));
		const bad = await h.run('update-component.js', ['my-app', '1', 'module', '../x', 'label=x']);
		assert.equal(bad.code, 1, bad.out);
		assert.equal(bad.stderr, nameLine('name', '../x'));
		const good = await h.run('update-component.js', ['my-app', '1', 'module', 'x', 'label=x']);
		assert.equal(good.code, 1, good.out);
		assert.ok(good.stderr.startsWith('ERROR: Make API key not configured.'), good.stderr);
		assert.equal(h.log.length, 0);
	});

	it('a type outside the list keeps the Unknown type error when it holds only valid characters', async () => {
		for (const mode of ['public', 'employee']) {
			h.seed({ mode });
			const r = await h.run('update-component.js', ['my-app', '1', 'widget', 'm', 'label=x']);
			assert.equal(r.code, 1, r.out);
			assert.equal(r.stderr, 'ERROR: Unknown type "widget". Supported: module, rpc, connection, webhook, endpoint\n');
			assert.equal(h.log.length, 0);
			for (const type of ['wid.get', 'module/x', 'module/']) {
				const bad = await h.run('update-component.js', ['my-app', '1', type, 'm', 'label=x']);
				assert.equal(bad.code, 1, bad.out);
				assert.equal(bad.stderr, nameLine('type', type), type);
				assert.equal(h.log.length, 0, type);
			}
		}
	});
});
