import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { embed } from '../lib/embeddings.js';
import { getIndex } from '../lib/pinecone.js';

export function registerSearchTool(server: McpServer): void {
	server.tool(
		'search_app_knowledge',
		'Semantic search across all shared Make app contexts in Pinecone',
		{
			query: z.string().describe('Natural language search query'),
			slug: z.string().optional().describe('Filter by app slug (optional)'),
			top_k: z.number().int().min(1).max(20).default(5).describe('Number of results to return (default 5)'),
		},
		async ({ query, slug, top_k }) => {
			try {
				const queryEmbedding = await embed(query);

				const queryOptions: {
					vector: number[];
					topK: number;
					includeMetadata: boolean;
					filter?: Record<string, Record<string, string>>;
				} = {
					vector: queryEmbedding,
					topK: top_k,
					includeMetadata: true,
				};

				if (slug) {
					queryOptions.filter = { slug: { $eq: slug } };
				}

				const index = getIndex();
				const results = await index.query(queryOptions);

				if (!results.matches?.length) {
					return {
						content: [
							{
								type: 'text' as const,
								text: slug
									? `No results found for query "${query}" in app "${slug}".`
									: `No results found for query "${query}".`,
							},
						],
					};
				}

				const formatted = results.matches.map((match, i) => {
					const m = match.metadata as Record<string, string> | undefined;
					return [
						`### Result ${i + 1} (score: ${match.score?.toFixed(3) ?? 'N/A'})`,
						`**App**: ${m?.slug}-v${m?.version} | **Section**: ${m?.section}`,
						'',
						m?.text ?? '',
					].join('\n');
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: `Found ${results.matches.length} results for "${query}":\n\n${formatted.join('\n\n---\n\n')}`,
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
