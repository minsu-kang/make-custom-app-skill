#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerUpsertTool } from './tools/upsert.js';
import { registerSearchTool } from './tools/search.js';
import { registerGetSummaryTool } from './tools/get-summary.js';
import { registerListAppsTool } from './tools/list-apps.js';
import { registerUpsertJiraTool } from './tools/upsert-jira.js';

const server = new McpServer({
	name: 'make-app-context',
	version: '1.0.0',
});

registerUpsertTool(server);
registerSearchTool(server);
registerGetSummaryTool(server);
registerListAppsTool(server);
registerUpsertJiraTool(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[make-app-context] MCP server running (stdio)');
