import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestServer } from '../../lib/__tests__/test-helpers.js';

vi.mock('../../lib/pinecone.js', () => ({
	getIndex: vi.fn(),
}));

import { getIndex } from '../../lib/pinecone.js';
import { registerGetSummaryTool } from '../get-summary.js';

describe('get_app_summary tool', () => {
	const mockQuery = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getIndex).mockReturnValue({ query: mockQuery } as never);
	});

	it('returns combined sections for a specific app', async () => {
		mockQuery.mockResolvedValue({
			matches: [
				{ id: 'app-v1#app-overview', metadata: { section: 'app-overview', text: 'App overview text', updated_at: '2026-03-01' } },
				{ id: 'app-v1#key-patterns', metadata: { section: 'key-patterns', text: 'Key patterns text', updated_at: '2026-03-01' } },
			],
		});

		const { server, callTool } = createTestServer();
		registerGetSummaryTool(server);

		const result = await callTool('get_app_summary', { slug: 'app', version: '1' });
		expect(result.content[0].text).toContain('app-v1 (2 sections)');
		expect(result.content[0].text).toContain('App overview text');
		expect(result.content[0].text).toContain('Key patterns text');
		expect(result.content[0].text).toContain('2026-03-01');
	});

	it('sorts sections by predefined order', async () => {
		mockQuery.mockResolvedValue({
			matches: [
				{ id: 'app-v1#work-history', metadata: { section: 'work-history', text: 'history' } },
				{ id: 'app-v1#app-overview', metadata: { section: 'app-overview', text: 'overview' } },
				{ id: 'app-v1#metadata', metadata: { section: 'metadata', text: 'meta' } },
			],
		});

		const { server, callTool } = createTestServer();
		registerGetSummaryTool(server);

		const result = await callTool('get_app_summary', { slug: 'app', version: '1' });
		const text = result.content[0].text;
		const overviewIdx = text.indexOf('[app-overview]');
		const metaIdx = text.indexOf('[metadata]');
		const historyIdx = text.indexOf('[work-history]');
		expect(overviewIdx).toBeLessThan(metaIdx);
		expect(metaIdx).toBeLessThan(historyIdx);
	});

	it('returns not-found message when no data', async () => {
		mockQuery.mockResolvedValue({ matches: [] });

		const { server, callTool } = createTestServer();
		registerGetSummaryTool(server);

		const result = await callTool('get_app_summary', { slug: 'missing', version: '1' });
		expect(result.content[0].text).toContain('No context found for missing-v1');
	});

	it('handles errors gracefully', async () => {
		mockQuery.mockRejectedValue(new Error('Pinecone connection failed'));

		const { server, callTool } = createTestServer();
		registerGetSummaryTool(server);

		const result = await callTool('get_app_summary', { slug: 'app', version: '1' });
		expect(result.content[0].text).toContain('Error: Pinecone connection failed');
		expect(result.isError).toBe(true);
	});
});
