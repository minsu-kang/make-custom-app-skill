import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestServer } from '../../lib/__tests__/test-helpers.js';

vi.mock('../../lib/embeddings.js', () => ({
	embed: vi.fn(),
}));

vi.mock('../../lib/pinecone.js', () => ({
	getIndex: vi.fn(),
}));

import { embed } from '../../lib/embeddings.js';
import { getIndex } from '../../lib/pinecone.js';
import { registerSearchTool } from '../search.js';

describe('search_app_knowledge tool', () => {
	const mockQuery = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getIndex).mockReturnValue({ query: mockQuery } as never);
		vi.mocked(embed).mockResolvedValue(new Array(1536).fill(0));
	});

	it('returns formatted results from Pinecone matches', async () => {
		mockQuery.mockResolvedValue({
			matches: [
				{
					id: 'slack-v2#overview',
					score: 0.95,
					metadata: { slug: 'slack', version: '2', section: 'app-overview', text: 'Slack app overview content' },
				},
			],
		});

		const { server, callTool } = createTestServer();
		registerSearchTool(server);

		const result = await callTool('search_app_knowledge', { query: 'how does slack auth work', top_k: 5 });
		expect(result.content[0].text).toContain('Found 1 results');
		expect(result.content[0].text).toContain('0.950');
		expect(result.content[0].text).toContain('Slack app overview content');
	});

	it('returns no-results message when empty', async () => {
		mockQuery.mockResolvedValue({ matches: [] });

		const { server, callTool } = createTestServer();
		registerSearchTool(server);

		const result = await callTool('search_app_knowledge', { query: 'nonexistent topic', top_k: 5 });
		expect(result.content[0].text).toContain('No results found');
	});

	it('passes slug filter when provided', async () => {
		mockQuery.mockResolvedValue({ matches: [] });

		const { server, callTool } = createTestServer();
		registerSearchTool(server);

		await callTool('search_app_knowledge', { query: 'test', slug: 'gmail', top_k: 5 });
		expect(mockQuery).toHaveBeenCalledWith(
			expect.objectContaining({
				filter: { slug: { $eq: 'gmail' } },
			}),
		);
	});

	it('includes slug-specific message when no results with slug filter', async () => {
		mockQuery.mockResolvedValue({ matches: [] });

		const { server, callTool } = createTestServer();
		registerSearchTool(server);

		const result = await callTool('search_app_knowledge', { query: 'test query', slug: 'slack', top_k: 5 });
		expect(result.content[0].text).toContain('"slack"');
	});

	it('handles errors gracefully', async () => {
		vi.mocked(embed).mockRejectedValue(new Error('OpenAI timeout'));

		const { server, callTool } = createTestServer();
		registerSearchTool(server);

		const result = await callTool('search_app_knowledge', { query: 'test', top_k: 5 });
		expect(result.content[0].text).toContain('Error: OpenAI timeout');
		expect(result.isError).toBe(true);
	});
});
