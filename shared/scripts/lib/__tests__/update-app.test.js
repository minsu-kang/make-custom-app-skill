/**
 * Tests for the entry script update-app.js against the mock Make API of entry-harness.js: the masked-common guard
 * (spec 3.2), which refuses a common file that still holds a marker in both modes before any request, the content
 * type of each push, and the snapshot gate of public mode (spec 3.3).
 */
require('./isolate-home');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createHarness } = require('./entry-harness');
const { scriptCommand } = require('../paths');
const { gateRefusalLines } = require('../snapshot-logic');

const REFUSAL_TAIL = [
	'In public mode download-app.js masks every string and number in common data, so a real value never reaches this computer.',
	'Pushing the file would replace the real values in Make with the marker text, and Make keeps no history of common data.',
	"Nothing was sent. To change common data, edit it in the Make UI (the Common data section on the app's Base page or on the connection's Communication page). Do not paste secret values into the chat.",
];
const MASKED = '{\n\t"clientSecret": "***MASKED:string***",\n\t"request": {\n\t\t"timeout": "***MASKED:number***",\n\t\t"sandbox": true\n\t}\n}\n';
const ORIGIN = 'GET /api/v2/admin/sdk/apps/my-app/1?cols[0]=origin';

let h;

before(async () => {
	h = await createHarness();
});

after(() => h.close());

function input(name, text) {
	const file = path.join(h.work, name);
	fs.writeFileSync(file, text);
	return file;
}

const block = (line1) => `${[line1, ...REFUSAL_TAIL].join('\n')}\n`;

describe('update-app.js: the masked-common guard', () => {
	it('public mode refuses a masked common with the spec block, before any request', async () => {
		h.seed();
		const r = await h.run('update-app.js', ['my-app', '1', 'common', input('common.imljson', MASKED)]);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stderr, block('Refused: common.imljson of my-app v1 still holds 2 masked values (clientSecret, request.timeout).'));
		assert.equal(r.stdout, '');
		assert.equal(h.log.length, 0);
	});

	it('public mode refuses a masked connection common and names its file', async () => {
		h.seed();
		const r = await h.run('update-app.js', ['my-app', '1', 'connection/my-conn/common', input('conn-common.imljson', '{ "liveSecret": "***MASKED:string***" }')]);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stderr, block('Refused: connections/my-conn/common.imljson of my-app v1 still holds 1 masked value (liveSecret).'));
		assert.equal(h.log.length, 0);
	});

	it('employee mode refuses a masked common too: the guard reads the content, not the mode', async () => {
		h.seed({ mode: 'employee' });
		const r = await h.run('update-app.js', ['my-app', '1', 'common', input('common.imljson', MASKED)]);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stderr, block('Refused: common.imljson of my-app v1 still holds 2 masked values (clientSecret, request.timeout).'));
		assert.equal(h.log.length, 0);
	});

	it('a masked JSONC file is refused without the parenthesis', async () => {
		h.seed();
		const r = await h.run('update-app.js', ['my-app', '1', 'common', input('common.imljson', '{\n\t// the client secret\n\t"clientSecret": "***MASKED:string***"\n}\n')]);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stderr, block('Refused: common.imljson of my-app v1 still holds 1 masked value.'));
		assert.equal(h.log.length, 0);
	});

	it('a common path whose file does not exist stops with the read error, before any request', async () => {
		h.seed();
		const missing = path.join(h.work, 'no-such-common.imljson');
		const r = await h.run('update-app.js', ['my-app', '1', 'common', missing]);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stderr, `ERROR: cannot read ${missing} (ENOENT)\n`);
		assert.equal(h.log.length, 0);
	});

	it('stops a component path with a . or .. part, which a URL would resolve to the common route, before any request', async () => {
		for (const mode of ['public', 'employee']) {
			for (const componentPath of ['module/../common', 'rpc/../common', 'function/../common', 'connection/x/../common']) {
				h.seed({ mode });
				const r = await h.run('update-app.js', ['my-app', '1', componentPath, input('common.imljson', MASKED)]);
				assert.equal(r.code, 1, r.out);
				assert.equal(r.stderr, `ERROR: the component path "${componentPath}" may hold only letters, digits, _ and - between its slashes, and no empty part.\n`, componentPath);
				assert.equal(h.log.length, 0, componentPath);
			}
		}
	});

	it('a component path that still reaches the common route is guarded as well', async () => {
		for (const componentPath of ['common/x', 'connection/my-conn/common/x']) {
			h.seed({ mode: 'employee' });
			const r = await h.run('update-app.js', ['my-app', '1', componentPath, input('common.imljson', MASKED)]);
			assert.equal(r.code, 1, r.out);
			assert.match(r.stderr, /^Refused: (?:connections\/my-conn\/)?common\.imljson of my-app v1 still holds 2 masked values/, componentPath);
			assert.equal(h.log.length, 0, componentPath);
		}
	});
});

describe('update-app.js: the content type of a push', () => {
	const push = async (componentPath, url, text) => {
		h.seed({ mode: 'employee', routes: { [ORIGIN]: [200, { app: {} }], [`PUT ${url}`]: [200, {}] } });
		const r = await h.run('update-app.js', ['my-app', '1', componentPath, input('section.txt', text)]);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('  ✓ Updated successfully (HTTP 200)'), r.stdout);
		assert.deepEqual(h.log.map((q) => `${q.method} ${q.url}`), [ORIGIN, `PUT ${url}`]);
		return h.log[1];
	};

	it('employee mode sends a clean common as application/json with the file text', async () => {
		const text = '{"liveCheck":"1"}';
		const sent = await push('common', '/api/v2/admin/sdk/apps/my-app/1/common', text);
		assert.equal(sent.contentType, 'application/json');
		assert.equal(sent.body, text);
	});

	it('employee mode sends a clean connection common as application/json', async () => {
		const text = '{ "liveCheck": "2" }\n';
		const sent = await push('connection/my-conn/common', '/api/v2/admin/sdk/apps/connections/my-conn/common', text);
		assert.equal(sent.contentType, 'application/json');
		assert.equal(sent.body, text);
	});

	it('base stays application/jsonc and function code application/javascript', async () => {
		assert.equal((await push('base', '/api/v2/admin/sdk/apps/my-app/1/base', '{ "baseUrl": "https://api.example.com" }')).contentType, 'application/jsonc');
		assert.equal((await push('function/fmt/code', '/api/v2/admin/sdk/apps/my-app/1/functions/fmt/code', 'function fmt(x) {\n\treturn x;\n}')).contentType, 'application/javascript');
	});
});

describe('update-app.js: the snapshot gate', () => {
	const GATE_TAIL = `${gateRefusalLines({ slug: 'my-app', version: '1', command: scriptCommand('download-app.js') }).join('\n')}\n`;
	const routes = (base) => ({ [`GET ${base}/sdk/apps/my-app/1?cols[0]=origin`]: [200, { app: {} }], [`PUT ${base}/sdk/apps/my-app/1/base`]: [200, {}] });
	const push = () => h.run('update-app.js', ['my-app', '1', 'base', input('base.imljson', '{ "baseUrl": "https://api.example.com" }')]);

	it('public mode without a snapshot exits 2 with the refusal and sends nothing', async () => {
		h.seed({ routes: routes('/api/v2') });
		const r = await push();
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
		const r = await push();
		assert.equal(r.code, 2, r.out);
		assert.ok(r.stderr.endsWith(GATE_TAIL), r.stderr);
		assert.equal(h.log.length, 0);
	});

	it('public mode with a fresh snapshot sends the push', async () => {
		h.seed({ routes: routes('/api/v2') });
		h.writeWorkingCopy();
		h.writeSnapshot({ takenAt: new Date(Date.now() + 1000).toISOString() });
		const r = await push();
		assert.equal(r.code, 0, r.out);
		assert.ok(!r.stderr.includes('No snapshot of'), r.stderr);
		assert.deepEqual(h.log.map((q) => `${q.method} ${q.url}`), ['GET /api/v2/sdk/apps/my-app/1?cols[0]=origin', 'PUT /api/v2/sdk/apps/my-app/1/base']);
	});

	it('employee mode has no gate: the push goes out without a snapshot', async () => {
		h.seed({ mode: 'employee', routes: routes('/api/v2/admin') });
		const r = await push();
		assert.equal(r.code, 0, r.out);
		assert.ok(!r.stderr.includes('No snapshot of'), r.stderr);
		assert.deepEqual(h.log.map((q) => `${q.method} ${q.url}`), ['GET /api/v2/admin/sdk/apps/my-app/1?cols[0]=origin', 'PUT /api/v2/admin/sdk/apps/my-app/1/base']);
	});
});
