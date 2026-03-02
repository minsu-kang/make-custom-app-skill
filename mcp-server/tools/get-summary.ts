import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getIndex } from '../lib/pinecone.js';

const EMBEDDING_DIM = 1536;

export function registerGetSummaryTool(server: McpServer): void {
	server.tool(
		'get_app_summary',
		'Retrieve the full context of a specific app from the shared Pinecone vector DB',
		{
			slug: z.string().describe("App slug (e.g. 'monday', 'slack')"),
			version: z.string().describe("App version (e.g. '2', '4')"),
		},
		async ({ slug, version }) => {
			try {
				const index = getIndex();

				const results = await index.query({
					vector: new Array<number>(EMBEDDING_DIM).fill(0),
					topK: 50,
					includeMetadata: true,
					filter: {
						slug: { $eq: slug },
						version: { $eq: String(version) },
					},
				});

				if (!results.matches?.length) {
					return {
						content: [
							{
								type: 'text' as const,
								text: `No context found for ${slug}-v${version} in the shared vector DB. Use upsert_app_context to add it first.`,
							},
						],
					};
				}

				const sectionOrder = ['app-overview', 'metadata', 'structure', 'key-patterns', 'caveats', 'work-history'];

				const sorted = results.matches.sort((a, b) => {
					const aSection = (a.metadata as Record<string, string> | undefined)?.section ?? '';
					const bSection = (b.metadata as Record<string, string> | undefined)?.section ?? '';
					const aIdx = sectionOrder.indexOf(aSection);
					const bIdx = sectionOrder.indexOf(bSection);
					const aOrder = aIdx === -1 ? 999 : aIdx;
					const bOrder = bIdx === -1 ? 999 : bIdx;
					return aOrder - bOrder;
				});

				const content = sorted
					.map((match) => {
						const m = match.metadata as Record<string, string> | undefined;
						return `[${m?.section ?? 'unknown'}]\n${m?.text ?? ''}`;
					})
					.join('\n\n---\n\n');

				const firstMeta = sorted[0]?.metadata as Record<string, string> | undefined;

				return {
					content: [
						{
							type: 'text' as const,
							text: `# ${slug}-v${version} (${sorted.length} sections)\n\n${content}\n\n_Last updated: ${firstMeta?.updated_at ?? 'unknown'}_`,
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
