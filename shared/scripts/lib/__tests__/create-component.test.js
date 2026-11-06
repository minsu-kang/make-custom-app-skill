/**
 * Tests for the entry script create-component.js against the mock Make API of entry-harness.js: the endpoint initMode
 * default of public mode (spec 3.5 row 18), the closed-beta line after a failed endpoint creation (row 19) and the usage
 * text. The script has no snapshot gate, so no snapshot is written.
 */
require('./isolate-home');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./entry-harness');
const c = require('../create-component-logic');

const LABEL = 'Live check endpoint';
const ENDPOINT = ['my-app', '1', 'endpoint', 'lcEndpoint', LABEL];
const origin = (base) => `GET ${base}/sdk/apps/my-app/1?cols[0]=origin`;
const routes = (base, create) => ({ [origin(base)]: [200, { app: {} }], [`POST ${base}/sdk/apps/my-app/1/endpoints`]: create });
const CREATED = [201, { appEndpoint: { name: 'lcEndpoint', label: LABEL } }];
const posts = (h) => h.log.filter((q) => q.method === 'POST');

let h;

before(async () => {
	h = await createHarness();
});

after(() => h.close());

describe('create-component.js: the endpoint initMode', () => {
	it('public mode sends blank when initMode is omitted', async () => {
		h.seed({ routes: routes('/api/v2', CREATED) });
		const r = await h.run('create-component.js', ENDPOINT);
		assert.equal(r.code, 0, r.out);
		assert.equal(posts(h).length, 1);
		assert.deepEqual(JSON.parse(posts(h)[0].body), { name: 'lcEndpoint', label: LABEL, endpointInitMode: 'blank' });
		assert.match(r.stdout, /Creating: Endpoint "Live check endpoint"/);
	});

	it('employee mode without initMode sends no endpointInitMode', async () => {
		h.seed({ mode: 'employee', routes: routes('/api/v2/admin', CREATED) });
		const r = await h.run('create-component.js', ENDPOINT);
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(JSON.parse(posts(h)[0].body), { name: 'lcEndpoint', label: LABEL });
	});

	it('a given initMode is sent in both modes', async () => {
		for (const [mode, base] of [['public', '/api/v2'], ['employee', '/api/v2/admin']]) {
			h.seed({ mode, routes: routes(base, CREATED) });
			const r = await h.run('create-component.js', [...ENDPOINT, '', '', 'example']);
			assert.equal(r.code, 0, `${mode}: ${r.out}`);
			assert.equal(JSON.parse(posts(h)[0].body).endpointInitMode, 'example', mode);
		}
	});

	it('an unknown initMode exits 1 before any create call', async () => {
		h.seed({ routes: routes('/api/v2', CREATED) });
		const r = await h.run('create-component.js', [...ENDPOINT, '', '', 'clone']);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stderr.split('\n').includes('ERROR: Invalid initMode "clone". Valid: example, blank'), r.stderr);
		assert.equal(posts(h).length, 0);
	});

	it('an endpoint without a label prints the endpoint usage with the row 18 text', async () => {
		h.seed({ routes: routes('/api/v2', CREATED) });
		const r = await h.run('create-component.js', ['my-app', '1', 'endpoint', 'lcEndpoint']);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stderr.endsWith(`${c.endpointUsageLines().join('\n')}\n`), r.stderr);
		assert.equal(posts(h).length, 0);
	});
});

describe('create-component.js: a refused creation', () => {
	const refused = [403, { message: 'Forbidden' }];

	it('public mode adds the closed-beta line after a failed endpoint creation', async () => {
		h.seed({ routes: routes('/api/v2', refused) });
		const r = await h.run('create-component.js', ENDPOINT);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stderr.endsWith(`  ✗ Creation failed (HTTP 403)\n    {"message":"Forbidden"}\n${c.ENDPOINT_REFUSAL_LINE}\n`), r.stderr);
		assert.equal(c.ENDPOINT_REFUSAL_LINE, '  SDK Endpoints are a closed beta. If Make refused this call, the account has no access to them: tell the user, and use an RPC or a module instead.');
	});

	it('public mode adds nothing after a failed module creation', async () => {
		h.seed({ routes: { [origin('/api/v2')]: [200, { app: {} }], 'POST /api/v2/sdk/apps/my-app/1/modules': refused } });
		const r = await h.run('create-component.js', ['my-app', '1', 'module', 'm', 'M', '4']);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stderr.endsWith('  ✗ Creation failed (HTTP 403)\n    {"message":"Forbidden"}\n'), r.stderr);
		assert.ok(!r.stderr.includes('closed beta'), r.stderr);
	});

	it('employee mode adds nothing after a failed endpoint creation', async () => {
		h.seed({ mode: 'employee', routes: routes('/api/v2/admin', refused) });
		const r = await h.run('create-component.js', ENDPOINT);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stderr.endsWith('  ✗ Creation failed (HTTP 403)\n    {"message":"Forbidden"}\n'), r.stderr);
	});
});

describe('create-component.js: the usage', () => {
	it('with no arguments the usage holds the row 18 text and nothing is sent', async () => {
		h.seed({ routes: {} });
		const r = await h.run('create-component.js', []);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stdout, `${c.USAGE_LINES.join('\n')}\n`);
		assert.ok(r.stdout.includes(`    ${c.INIT_MODE_USAGE}\n`));
		assert.equal(h.log.length, 0);
	});
});
