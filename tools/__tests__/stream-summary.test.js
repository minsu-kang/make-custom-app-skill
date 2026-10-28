'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStream, wasDenied, wasRun } = require('../lib/stream-summary.js');

const line = (event) => JSON.stringify(event);
const STREAM = [
	line({ type: 'system', subtype: 'init', skills: ['a', 'make-custom-app:make-app-task'], mcp_servers: [{ name: 'plugin:make-custom-app:make', status: 'needs-auth', extra: 1 }], plugins: [{ name: 'make-custom-app', version: '3.0.0' }, { name: 'other' }] }),
	line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node "x"' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'node y' } }] } }),
	line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Exit code 1\nUsage' }], is_error: true }] } }),
	line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Permission to use Bash has been denied because Claude Code is running in don\'t ask mode.', is_error: true }, { type: 'tool_result', tool_use_id: 'unknown', content: 'x' }] } }),
	'not json',
	'',
	line({ type: 'result', is_error: false, num_turns: 3, total_cost_usd: 0.12 }),
].join('\n');

test('parseStream keeps the init event, every tool call with its result, and the final result', () => {
	const summary = parseStream(STREAM);
	assert.deepEqual(summary.init, {
		skills: ['a', 'make-custom-app:make-app-task'],
		mcpServers: [{ name: 'plugin:make-custom-app:make', status: 'needs-auth' }],
		plugins: [{ name: 'make-custom-app', version: '3.0.0' }, { name: 'other', version: null }],
	});
	assert.equal(summary.calls.length, 2);
	assert.equal(summary.calls[0].input.command, 'node "x"');
	assert.deepEqual(summary.calls[0].result, { isError: true, text: 'Exit code 1\nUsage' });
	assert.equal(summary.calls[1].result.isError, true);
	assert.deepEqual(summary.result, { isError: false, turns: 3, cost: 0.12 });
});

test('a stream without events gives an empty summary', () => {
	assert.deepEqual(parseStream(''), { init: null, calls: [], result: null });
	assert.deepEqual(parseStream('garbage\n{"type":"other"}'), { init: null, calls: [], result: null });
});

test('wasDenied is true only for a permission refusal; a failing command counts as run', () => {
	const [failed, denied] = parseStream(STREAM).calls;
	assert.equal(wasDenied(failed), false);
	assert.equal(wasRun(failed), true);
	assert.equal(wasDenied(denied), true);
	assert.equal(wasRun(denied), false);
	assert.equal(wasRun({ result: null }), false);
	assert.equal(wasDenied({ result: null }), false);
});
