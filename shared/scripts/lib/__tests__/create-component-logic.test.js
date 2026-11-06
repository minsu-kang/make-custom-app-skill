const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../create-component-logic');

const INIT_MODE_TEXT = "initMode: example (copies the endpoint scaffold of Make's model app; the default in employee mode), blank (an empty endpoint; the default in public mode)";
const REFUSAL = '  SDK Endpoints are a closed beta. If Make refused this call, the account has no access to them: tell the user, and use an RPC or a module instead.';

describe('row 18: the endpoint initMode', () => {
	it('names both modes and says which one is the default where', () => {
		assert.deepEqual(c.INIT_MODES, ['example', 'blank']);
		assert.equal(c.INIT_MODE_USAGE, INIT_MODE_TEXT);
	});

	it('public mode sends blank when initMode is omitted, employee mode sends nothing', () => {
		assert.equal(c.endpointInitMode({ mode: 'public', initMode: undefined }), 'blank');
		assert.equal(c.endpointInitMode({ mode: 'public', initMode: '' }), 'blank');
		assert.equal(c.endpointInitMode({ mode: 'employee' }), null);
		assert.equal(c.endpointInitMode({ mode: 'employee', initMode: undefined }), null);
	});

	it('a given initMode wins in both modes', () => {
		for (const mode of ['public', 'employee']) {
			assert.equal(c.endpointInitMode({ mode, initMode: 'example' }), 'example');
			assert.equal(c.endpointInitMode({ mode, initMode: 'blank' }), 'blank');
		}
	});

	it('the usage block holds the row 18 text on the initMode line and no other default claim', () => {
		assert.ok(c.USAGE_LINES.includes(`    ${INIT_MODE_TEXT}`));
		assert.ok(!c.USAGE_LINES.some((line) => line.includes('initMode: example (default')));
		assert.equal(c.USAGE_LINES.filter((line) => line.includes('initMode:')).length, 1);
	});

	it('the usage block keeps the rest of today\'s lines', () => {
		assert.equal(c.USAGE_LINES[0], 'Usage: node create-component.js <app-slug> <app-version> <type> [args...]');
		assert.ok(c.USAGE_LINES.includes('  endpoint <name> <label> [connection] [description] [initMode]'));
		assert.equal(c.USAGE_LINES[c.USAGE_LINES.length - 1], '  node create-component.js google-docs 1 endpoint listFiles "List Files" google-docs');
	});

	it('the endpoint sub-usage is two lines, the second one the row 18 text', () => {
		const lines = c.endpointUsageLines();
		assert.equal(lines.length, 2);
		assert.equal(lines[0], 'Usage: create-component.js <slug> <version> endpoint <name> <label> [connection] [description] [initMode]');
		assert.equal(lines[1], `  ${INIT_MODE_TEXT}`);
	});
});

describe('row 19: a failed endpoint creation', () => {
	it('the refusal line is the row 19 text', () => {
		assert.equal(c.ENDPOINT_REFUSAL_LINE, REFUSAL);
	});

	it('public mode adds the line for an endpoint only', () => {
		assert.deepEqual(c.creationFailedLines({ mode: 'public', type: 'endpoint' }), [REFUSAL]);
		assert.deepEqual(c.creationFailedLines({ mode: 'public', type: 'module' }), []);
		assert.deepEqual(c.creationFailedLines({ mode: 'employee', type: 'endpoint' }), []);
		assert.deepEqual(c.creationFailedLines({ mode: undefined, type: 'endpoint' }), []);
	});
});
