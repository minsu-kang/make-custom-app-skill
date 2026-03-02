import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestServer } from '../../lib/__tests__/test-helpers.js';

vi.mock('../../lib/chunker.js', () => ({
	chunkApp: vi.fn(),
}));

vi.mock('../../lib/embeddings.js', () => ({
	embedBatch: vi.fn(),
}));

vi.mock('../../lib/pinecone.js', () => ({
	getIndex: vi.fn(),
}));

import { chunkApp } from '../../lib/chunker.js';
import { embedBatch } from '../../lib/embeddings.js';
import { getIndex } from '../../lib/pinecone.js';
import { registerUpsertTool } from '../upsert.js';

describe('upsert_app_context tool', () => {
	const mockUpsert = vi.fn().mockResolvedValue(undefined);

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getIndex).mockReturnValue({ upsert: mockUpsert } as never);
	});

	it('returns message when no context files found', async () => {
		vi.mocked(chunkApp).mockResolvedValue([]);

		const { server, callTool } = createTestServer();
		registerUpsertTool(server);

		const result = await callTool('upsert_app_context', { slug: 'nonexistent', version: '1' });
		expect(result.content[0].text).toContain('No context files found');
		expect(result.content[0].text).toContain('nonexistent-v1');
		expect(mockUpsert).not.toHaveBeenCalled();
	});

	it('upserts chunks with correct vector count', async () => {
		const mockChunks = [
			{ id: 'app-v1#overview', text: 'overview text', metadata: { slug: 'app', version: '1', section: 'overview', source: 'summary' } },
			{ id: 'app-v1#metadata', text: 'metadata text', metadata: { slug: 'app', version: '1', section: 'metadata', source: 'metadata' } },
		];
		vi.mocked(chunkApp).mockResolvedValue(mockChunks);
		vi.mocked(embedBatch).mockResolvedValue([new Array(1536).fill(0), new Array(1536).fill(0.1)]);

		const { server, callTool } = createTestServer();
		registerUpsertTool(server);

		const result = await callTool('upsert_app_context', { slug: 'app', version: '1' });
		expect(result.content[0].text).toContain('Upserted 2 vectors');
		expect(result.content[0].text).toContain('overview, metadata');
		expect(mockUpsert).toHaveBeenCalledTimes(1);

		const upsertedVectors = mockUpsert.mock.calls[0][0];
		expect(upsertedVectors).toHaveLength(2);
		expect(upsertedVectors[0].id).toBe('app-v1#overview');
		expect(upsertedVectors[0].metadata.updated_at).toBeDefined();
	});

	it('handles errors gracefully', async () => {
		vi.mocked(chunkApp).mockRejectedValue(new Error('File read error'));

		const { server, callTool } = createTestServer();
		registerUpsertTool(server);

		const result = await callTool('upsert_app_context', { slug: 'app', version: '1' });
		expect(result.content[0].text).toContain('Error: File read error');
		expect(result.isError).toBe(true);
	});
});
