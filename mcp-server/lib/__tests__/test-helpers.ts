import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

/**
 * Creates a fake McpServer that captures tool handlers registered via server.tool().
 * Returns an object with a callTool method for invoking captured handlers in tests.
 */
export function createTestServer() {
	const handlers = new Map<string, ToolHandler>();

	const fakeServer = {
		tool: (_name: string, _desc: string, _schemaOrHandler: unknown, handler?: unknown) => {
			const cb = (typeof _schemaOrHandler === 'function' ? _schemaOrHandler : handler) as ToolHandler;
			handlers.set(_name, cb);
		},
	} as unknown as McpServer;

	return {
		server: fakeServer,
		async callTool(name: string, args: Record<string, unknown>) {
			const handler = handlers.get(name);
			if (!handler) throw new Error(`Tool "${name}" not registered`);
			return handler(args);
		},
	};
}
