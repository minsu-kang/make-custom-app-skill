import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestServer } from '../../lib/__tests__/test-helpers.js';

vi.mock('../../lib/pinecone.js', () => ({
	getIndex: vi.fn(),
}));

import { getIndex } from '../../lib/pinecone.js';
import { registerListAppsTool } from '../list-apps.js';

describe('list_apps tool', () => {
	const mockQuery = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getIndex).mockReturnValue({ query: mockQuery } as never);
	});

	it('returns sorted list of apps', async () => {
		mockQuery.mockResolvedValue({
			matches: [
				{ id: 'slack-v2#metadata', metadata: { slug: 'slack', version: '2', updated_at: '2026-03-01' } },
				{ id: 'gmail-v4#metadata', metadata: { slug: 'gmail', version: '4', updated_at: '2026-03-02' } },
			],
		});

		const { server, callTool } = createTestServer();
		registerListAppsTool(server);

		const result = await callTool('list_apps', {});
		const text = result.content[0].text;
		expect(text).toContain('Apps in Shared Context DB (2)');
		const gmailIdx = text.indexOf('gmail');
		const slackIdx = text.indexOf('slack');
		expect(gmailIdx).toBeLessThan(slackIdx);
	});

	it('falls back to app-overview section when no metadata', async () => {
		mockQuery
			.mockResolvedValueOnce({ matches: [] })
			.mockResolvedValueOnce({
				matches: [
					{ id: 'app-v1#app-overview', metadata: { slug: 'app', version: '1', updated_at: '2026-01-01' } },
				],
			});

		const { server, callTool } = createTestServer();
		registerListAppsTool(server);

		const result = await callTool('list_apps', {});
		expect(result.content[0].text).toContain('**app** v1');
		expect(mockQuery).toHaveBeenCalledTimes(2);
	});

	it('returns empty message when no apps at all', async () => {
		mockQuery
			.mockResolvedValueOnce({ matches: [] })
			.mockResolvedValueOnce({ matches: [] });

		const { server, callTool } = createTestServer();
		registerListAppsTool(server);

		const result = await callTool('list_apps', {});
		expect(result.content[0].text).toContain('No apps found');
	});

	it('handles errors gracefully', async () => {
		mockQuery.mockRejectedValue(new Error('DB unreachable'));

		const { server, callTool } = createTestServer();
		registerListAppsTool(server);

		const result = await callTool('list_apps', {});
		expect(result.content[0].text).toContain('Error: DB unreachable');
		expect(result.isError).toBe(true);
	});
});
