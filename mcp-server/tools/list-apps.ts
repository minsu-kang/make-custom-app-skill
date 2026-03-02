import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getIndex } from '../lib/pinecone.js';

const EMBEDDING_DIM = 1536;

interface AppEntry {
	slug: string;
	version: string;
	updated_at: string;
}

export function registerListAppsTool(server: McpServer): void {
	server.tool(
		'list_apps',
		'List all Make apps that have context stored in the shared Pinecone vector DB',
		{},
		async () => {
			try {
				const index = getIndex();

				let results = await index.query({
					vector: new Array<number>(EMBEDDING_DIM).fill(0),
					topK: 10000,
					includeMetadata: true,
					filter: { section: { $eq: 'metadata' } },
				});

				if (!results.matches?.length) {
					const fallback = await index.query({
						vector: new Array<number>(EMBEDDING_DIM).fill(0),
						topK: 10000,
						includeMetadata: true,
						filter: { section: { $eq: 'app-overview' } },
					});

					if (!fallback.matches?.length) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'No apps found in the shared vector DB. Use upsert_app_context to add app contexts.',
								},
							],
						};
					}

					results = fallback;
				}

				const apps: AppEntry[] = results.matches.map((match) => {
					const m = match.metadata as Record<string, string> | undefined;
					return {
						slug: m?.slug ?? 'unknown',
						version: m?.version ?? '?',
						updated_at: m?.updated_at ?? 'unknown',
					};
				});

				apps.sort((a, b) => a.slug.localeCompare(b.slug));

				const lines = apps.map((app) => `- **${app.slug}** v${app.version} (updated: ${app.updated_at})`);

				return {
					content: [
						{
							type: 'text' as const,
							text: `## Apps in Shared Context DB (${apps.length})\n\n${lines.join('\n')}`,
						},
					],
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: 'text' as const, text: `Error: ${message}` }],
					isError: true,
				};
			}
		},
	);
}
