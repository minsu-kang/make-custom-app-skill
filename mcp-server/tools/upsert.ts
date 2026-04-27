import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { chunkApp, mergeWorkHistory } from '../lib/chunker.js';
import { embedBatch } from '../lib/embeddings.js';
import { getIndex } from '../lib/pinecone.js';

const APPEND_SECTIONS = new Set(['work-history']);

export function registerUpsertTool(server: McpServer): void {
	server.tool(
		'upsert_app_context',
		'Read local app context (.md summary + metadata.json) and upsert to shared Pinecone vector DB',
		{
			slug: z.string().describe("App slug (e.g. 'monday', 'slack')"),
			version: z.string().describe("App version (e.g. '2', '4')"),
		},
		async ({ slug, version }) => {
			try {
				const chunks = await chunkApp(slug, version);
				if (chunks.length === 0) {
					return {
						content: [
							{
								type: 'text' as const,
								text: `No context files found for ${slug}-v${version}. Ensure ~/.claude/make-app-contexts/${slug}-v${version}.md (Claude Code) or ~/.cursor/make-app-contexts/${slug}-v${version}.md (Cursor), plus ${slug}-v${version}/metadata.json, exists.`,
							},
						],
					};
				}

				const index = getIndex();

				const appendChunkIds = chunks
					.filter((c) => APPEND_SECTIONS.has(c.metadata.section))
					.map((c) => c.id);

				if (appendChunkIds.length > 0) {
					const existing = await index.fetch(appendChunkIds);
					for (const chunk of chunks) {
						if (!APPEND_SECTIONS.has(chunk.metadata.section)) continue;
						const record = existing.records[chunk.id];
						const existingText = record?.metadata?.text;
						if (typeof existingText === 'string') {
							chunk.text = mergeWorkHistory(existingText, chunk.text);
						}
					}
				}

				const texts = chunks.map((c) => c.text);
				const embeddings = await embedBatch(texts);

				const vectors = chunks.map((chunk, i) => ({
					id: chunk.id,
					values: embeddings[i],
					metadata: {
						...chunk.metadata,
						text: chunk.text,
						updated_at: new Date().toISOString(),
					},
				}));

				const BATCH_SIZE = 100;
				for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
					await index.upsert(vectors.slice(i, i + BATCH_SIZE));
				}

				const sections = chunks.map((c) => c.metadata.section);
				return {
					content: [
						{
							type: 'text' as const,
							text: `Upserted ${chunks.length} vectors for ${slug}-v${version}.\nSections: ${sections.join(', ')}`,
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
