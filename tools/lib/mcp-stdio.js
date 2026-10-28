'use strict';

const { spawn } = require('child_process');

const PROTOCOL_VERSION = '2025-06-18';

/**
 * Starts an MCP server on stdio, runs the handshake, sends the requests one after another and stops the server.
 * The SDK's stdio transport reads and writes one JSON message per line.
 *
 * requests: [{ method, params }]. Resolves with { responses, stderr }, where responses[i] is the full JSON-RPC
 * response to requests[i] (a result or an error). Rejects when the server exits early or does not answer in time.
 */
function exchange({ command, args = [], env = process.env, requests, timeoutMs = 30000, cwd }) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		const responses = [];
		const waiting = new Map();
		let stderr = '';
		let buffer = '';
		let settled = false;
		let nextId = 1;

		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			if (error) reject(error);
			else resolve(value);
		};
		const timer = setTimeout(() => finish(new Error(`MCP server did not answer within ${timeoutMs} ms. stderr: ${stderr.trim()}`)), timeoutMs);

		const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
		const request = (method, params) =>
			new Promise((ok) => {
				const id = nextId++;
				waiting.set(id, ok);
				send({ id, method, params });
			});

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		child.stdout.on('data', (chunk) => {
			buffer += chunk;
			let newline;
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				const done = waiting.get(message.id);
				if (done) {
					waiting.delete(message.id);
					done(message);
				}
			}
		});
		child.on('error', (err) => finish(err));
		child.on('close', (code, signal) => finish(new Error(`MCP server exited early (code ${code}, signal ${signal}). stderr: ${stderr.trim()}`)));

		(async () => {
			const init = await request('initialize', {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: 'mcp-stdio-check', version: '1.0.0' },
			});
			if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
			send({ method: 'notifications/initialized' });
			for (const { method, params } of requests) responses.push(await request(method, params));
		})().then(
			() => finish(null, { responses, stderr }),
			(err) => finish(err),
		);
	});
}

/** The result of a JSON-RPC response; a JSON-RPC error becomes an Error that carries the server's message. */
function resultOf(response, method) {
	if (response.error) throw new Error(`${method} failed: ${response.error.message}`);
	return response.result;
}

/** The names of the tools the server lists, sorted. */
async function listToolNames(options) {
	const { responses } = await exchange({ ...options, requests: [{ method: 'tools/list', params: {} }] });
	const { tools } = resultOf(responses[0], 'tools/list');
	return tools.map((tool) => tool.name).sort();
}

/** The text of the first content item that tools/call returns, and whether it is an error. */
async function callToolText(options, name, args) {
	const { responses } = await exchange({ ...options, requests: [{ method: 'tools/call', params: { name, arguments: args } }] });
	const result = resultOf(responses[0], 'tools/call');
	return { text: result.content[0].text, isError: result.isError === true };
}

module.exports = { exchange, listToolNames, callToolText, PROTOCOL_VERSION };
