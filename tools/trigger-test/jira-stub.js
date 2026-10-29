#!/usr/bin/env node
'use strict';
// Minimal stdio MCP server that returns canned Jira tickets. No network, no credentials.
// run-claude.js --stub starts it as the MCP server "jira-stub" in place of the real Atlassian connector, which a headless
// session cannot use (the permission prompt is denied). It serves one tool, getJiraIssue, for IEN-16879 and IEN-16847,
// the tickets that prompts 4, 5, 19, and 20 name. Any other key answers { "error": "not found" }.
const TICKETS = {
	'IEN-16879': { key: 'IEN-16879', summary: 'Add a bulk upsert module to the HubSpot app', status: 'Preparation', issuetype: 'Task', project: 'IEN', description: 'Customers ask for a bulk upsert of contacts in the HubSpot custom app (version 3). The ticket needs a refinement before development starts.' },
	'IEN-16847': { key: 'IEN-16847', summary: 'monday app: Search Items returns duplicate items', status: 'Preparation', issuetype: 'Task', project: 'IEN', description: 'In the monday custom app the Search Items module returns the same item twice when a board has more than 100 items. Needs a refinement before development starts.' },
};
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.on('data', (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf('\n')) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		let m;
		try { m = JSON.parse(line); } catch { continue; }
		if (m === null || typeof m !== 'object' || m.id === undefined) continue;
		if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'jira-stub', version: '1' } } });
		else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'getJiraIssue', description: 'Get a Jira issue by key or id.', inputSchema: { type: 'object', properties: { issueIdOrKey: { type: 'string' } }, required: ['issueIdOrKey'] } }] } });
		else if (m.method === 'tools/call') {
			const key = String(((m.params && m.params.arguments) || {}).issueIdOrKey || '');
			const t = TICKETS[key];
			send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(t || { error: 'not found' }) }], isError: !t } });
		} else send({ jsonrpc: '2.0', id: m.id, result: {} });
	}
});
