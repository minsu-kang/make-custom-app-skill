import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestServer } from '../../lib/__tests__/test-helpers.js';
import { buildJiraText } from '../upsert-jira.js';

vi.mock('../../lib/embeddings.js', () => ({
	embed: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
}));

vi.mock('../../lib/pinecone.js', () => ({
	getIndex: vi.fn(),
}));

import { embed } from '../../lib/embeddings.js';
import { getIndex } from '../../lib/pinecone.js';
import { registerUpsertJiraTool } from '../upsert-jira.js';

describe('buildJiraText (unit)', () => {
	it('includes required fields', () => {
		const result = buildJiraText({
			ticket_key: 'IEN-100',
			ticket_type: 'bugfix',
			slug: 'slack',
			version: '2',
			summary: 'Fix parsing error',
		});
		expect(result).toContain('[IEN-100]');
		expect(result).toContain('(bugfix)');
		expect(result).toContain('slack v2');
		expect(result).toContain('Summary: Fix parsing error');
	});

	it('includes all optional fields when present', () => {
		const result = buildJiraText({
			ticket_key: 'IEN-200',
			ticket_type: 'feature',
			slug: 'monday',
			version: '3',
			summary: 'Add new module',
			description: 'Detailed description',
			acceptance_criteria: 'Must pass all tests',
			developer_notes: 'Root cause: X',
			comments: 'User reported issue',
			review_result: 'LGTM',
		});
		expect(result).toContain('Description: Detailed description');
		expect(result).toContain('Acceptance Criteria: Must pass all tests');
		expect(result).toContain('Developer Notes:\nRoot cause: X');
		expect(result).toContain('Comments:\nUser reported issue');
		expect(result).toContain('Review Result:\nLGTM');
	});

	it('omits optional fields when absent', () => {
		const result = buildJiraText({
			ticket_key: 'IEN-300',
			ticket_type: 'review',
			slug: 'app',
			version: '1',
			summary: 'Review changes',
		});
		expect(result).not.toContain('Description:');
		expect(result).not.toContain('Developer Notes:');
		expect(result).not.toContain('Comments:');
	});

	it('separates sections with double newlines', () => {
		const result = buildJiraText({
			ticket_key: 'IEN-400',
			ticket_type: 'bugfix',
			slug: 'app',
			version: '1',
			summary: 'Test',
			description: 'Desc',
		});
		const parts = result.split('\n\n');
		expect(parts.length).toBeGreaterThanOrEqual(3);
	});
});

describe('upsert_jira_ticket tool (integration)', () => {
	const mockUpsert = vi.fn().mockResolvedValue(undefined);

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getIndex).mockReturnValue({ upsert: mockUpsert } as never);
		vi.mocked(embed).mockResolvedValue(new Array(1536).fill(0));
	});

	it('upserts with correct vector ID and metadata', async () => {
		const { server, callTool } = createTestServer();
		registerUpsertJiraTool(server);

		const result = await callTool('upsert_jira_ticket', {
			ticket_key: 'IEN-500',
			slug: 'gmail',
			version: '4',
			ticket_type: 'feature',
			summary: 'Test ticket',
		});

		expect(result.content[0].text).toContain('IEN-500');
		expect(result.content[0].text).toContain('gmail-v4');
		expect(embed).toHaveBeenCalled();
		expect(mockUpsert).toHaveBeenCalledTimes(1);

		const upserted = mockUpsert.mock.calls[0][0][0];
		expect(upserted.id).toBe('gmail-v4#jira-IEN-500');
		expect(upserted.metadata.slug).toBe('gmail');
		expect(upserted.metadata.section).toBe('jira');
		expect(upserted.metadata.ticket_key).toBe('IEN-500');
		expect(upserted.metadata.ticket_type).toBe('feature');
	});

	it('returns error on failure', async () => {
		vi.mocked(embed).mockRejectedValue(new Error('API error'));

		const { server, callTool } = createTestServer();
		registerUpsertJiraTool(server);

		const result = await callTool('upsert_jira_ticket', {
			ticket_key: 'IEN-ERR',
			slug: 'app',
			version: '1',
			ticket_type: 'bugfix',
			summary: 'Error test',
		});

		expect(result.content[0].text).toContain('Error: API error');
		expect(result.isError).toBe(true);
	});
});
