'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exchange, listToolNames, callToolText } = require('../lib/mcp-stdio.js');

const folders = [];
test.after(() => folders.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** A tiny MCP server: answers initialize, tools/list and tools/call with fixed data. Prints a stray line first. */
const FAKE_SERVER = `
const readline = require('readline');
console.log('not json');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
	const message = JSON.parse(line);
	if (message.id === undefined) return;
	const reply = (result) => console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
	if (message.method === 'initialize') reply({ protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: 'fake', version: '1' } });
	else if (message.method === 'tools/list') reply({ tools: [{ name: 'b' }, { name: 'a' }] });
	else if (message.method === 'tools/call') reply({ content: [{ type: 'text', text: 'echo ' + message.params.arguments.word }], isError: message.params.name === 'fail' });
});
`;

function writeScript(body) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-'));
	folders.push(dir);
	const file = path.join(dir, 'server.js');
	fs.writeFileSync(file, body);
	return file;
}

test('listToolNames and callToolText run the handshake and read the replies', async () => {
	const options = { command: process.execPath, args: [writeScript(FAKE_SERVER)] };
	assert.deepEqual(await listToolNames(options), ['a', 'b']);
	assert.deepEqual(await callToolText(options, 'say', { word: 'hi' }), { text: 'echo hi', isError: false });
	assert.deepEqual(await callToolText(options, 'fail', { word: 'x' }), { text: 'echo x', isError: true });
});

test('exchange returns every response in request order', async () => {
	const options = { command: process.execPath, args: [writeScript(FAKE_SERVER)] };
	const { responses } = await exchange({
		...options,
		requests: [
			{ method: 'tools/list', params: {} },
			{ method: 'tools/call', params: { name: 'say', arguments: { word: 'two' } } },
		],
	});
	assert.equal(responses.length, 2);
	assert.equal(responses[1].result.content[0].text, 'echo two');
});

test('a server that exits before it answers is an error with its stderr', async () => {
	const file = writeScript("console.error('boom'); process.exit(3);");
	await assert.rejects(exchange({ command: process.execPath, args: [file], requests: [] }), /exited early \(code 3.*boom/s);
});

test('a server that never answers is an error after the timeout', async () => {
	const file = writeScript('setInterval(() => {}, 1000);');
	await assert.rejects(exchange({ command: process.execPath, args: [file], requests: [], timeoutMs: 300 }), /did not answer within 300 ms/);
});

test('a command that cannot start is an error', async () => {
	await assert.rejects(exchange({ command: path.join(os.tmpdir(), 'no-such-command-for-mcp-stdio'), requests: [] }), /ENOENT/);
});
