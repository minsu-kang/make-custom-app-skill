'use strict';

/**
 * Reads the stream-json output of `claude -p --output-format stream-json --verbose` and keeps what the plugin
 * verification needs: the init event (skills, MCP servers, plugins) and every tool call with its result.
 */
function parseStream(text) {
	const summary = { init: null, calls: [], result: null };
	const byId = new Map();
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === 'system' && event.subtype === 'init') {
			summary.init = {
				skills: event.skills || [],
				mcpServers: (event.mcp_servers || []).map((s) => ({ name: s.name, status: s.status })),
				plugins: (event.plugins || []).map((p) => ({ name: p.name, version: p.version || null })),
			};
		} else if (event.type === 'assistant') {
			for (const item of (event.message && event.message.content) || []) {
				if (item.type !== 'tool_use') continue;
				const call = { id: item.id, name: item.name, input: item.input, result: null };
				byId.set(item.id, call);
				summary.calls.push(call);
			}
		} else if (event.type === 'user') {
			for (const item of (event.message && event.message.content) || []) {
				const call = item.type === 'tool_result' ? byId.get(item.tool_use_id) : null;
				if (!call) continue;
				const text = Array.isArray(item.content) ? item.content.map((part) => part.text || '').join('') : String(item.content === undefined ? '' : item.content);
				call.result = { isError: item.is_error === true, text };
			}
		} else if (event.type === 'result') {
			summary.result = { isError: event.is_error === true, turns: event.num_turns, cost: event.total_cost_usd };
		}
	}
	return summary;
}

const DENIED = /Permission to use .* has been denied/;

/** True when the harness refused the call because no permission rule allowed it. */
function wasDenied(call) {
	return Boolean(call.result && call.result.isError && DENIED.test(call.result.text));
}

/** True when the call got a result that is not a permission refusal (a non-zero exit of the command still counts as run). */
function wasRun(call) {
	return Boolean(call.result) && !wasDenied(call);
}

module.exports = { parseStream, wasDenied, wasRun };
