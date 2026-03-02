import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { embed } from '../lib/embeddings.js';
import { getIndex } from '../lib/pinecone.js';

const ticketTypeEnum = z.enum(['bugfix', 'feature', 'review']);

export function buildJiraText(params: {
	ticket_key: string;
	ticket_type: string;
	slug: string;
	version: string;
	summary: string;
	description?: string;
	acceptance_criteria?: string;
	developer_notes?: string;
	comments?: string;
	review_result?: string;
}): string {
	const parts: string[] = [];

	parts.push(`[${params.ticket_key}] (${params.ticket_type}) ${params.slug} v${params.version}`);
	parts.push(`Summary: ${params.summary}`);

	if (params.description) parts.push(`Description: ${params.description}`);
	if (params.acceptance_criteria) parts.push(`Acceptance Criteria: ${params.acceptance_criteria}`);
	if (params.developer_notes) parts.push(`Developer Notes:\n${params.developer_notes}`);
	if (params.review_result) parts.push(`Review Result:\n${params.review_result}`);
	if (params.comments) parts.push(`Comments:\n${params.comments}`);

	return parts.join('\n\n');
}

export function registerUpsertJiraTool(server: McpServer): void {
	server.tool(
		'upsert_jira_ticket',
		'Store a Jira ticket (bugfix, feature, review) linked to a Make app in the shared Pinecone vector DB',
		{
			ticket_key: z.string().describe("Jira ticket key (e.g. 'IEN-14600')"),
			slug: z.string().describe("App slug (e.g. 'monday', 'slack')"),
			version: z.string().describe("App version (e.g. '2', '4')"),
			ticket_type: ticketTypeEnum.describe('Ticket type: bugfix, feature, or review'),
			summary: z.string().describe('Ticket summary/title'),
			description: z.string().optional().describe('Ticket description'),
			acceptance_criteria: z.string().optional().describe('Acceptance criteria from the ticket'),
			developer_notes: z
				.string()
				.optional()
				.describe('Developer notes (Root Cause, Fix, Affected Components, Changed Files)'),
			comments: z.string().optional().describe('Relevant comments from the ticket'),
			review_result: z.string().optional().describe('Code review result (verdict, per-change reviews)'),
		},
		async (params) => {
			try {
				const text = buildJiraText(params);
				const vectorId = `${params.slug}-v${params.version}#jira-${params.ticket_key}`;

				const embedding = await embed(text);

				const index = getIndex();
				await index.upsert([
					{
						id: vectorId,
						values: embedding,
						metadata: {
							slug: params.slug,
							version: String(params.version),
							section: 'jira',
							source: 'jira',
							ticket_key: params.ticket_key,
							ticket_type: params.ticket_type,
							text,
							updated_at: new Date().toISOString(),
						},
					},
				]);

				return {
					content: [
						{
							type: 'text' as const,
							text: `Stored Jira ticket ${params.ticket_key} (${params.ticket_type}) for ${params.slug}-v${params.version} in shared vector DB.`,
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
