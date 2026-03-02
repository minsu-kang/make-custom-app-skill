import { describe, it, expect } from 'vitest';
import { buildVectorId, parseVectorId } from '../pinecone.js';

describe('buildVectorId', () => {
	it('builds correct format', () => {
		expect(buildVectorId('slack', '2', 'app-overview')).toBe('slack-v2#app-overview');
	});

	it('handles slugs with hyphens', () => {
		expect(buildVectorId('google-email', '4', 'metadata')).toBe('google-email-v4#metadata');
	});
});

describe('parseVectorId', () => {
	it('parses a valid vector ID', () => {
		const result = parseVectorId('slack-v2#app-overview');
		expect(result).toEqual({ slug: 'slack', version: '2', section: 'app-overview' });
	});

	it('parses hyphenated slugs', () => {
		const result = parseVectorId('google-email-v4#metadata');
		expect(result).toEqual({ slug: 'google-email', version: '4', section: 'metadata' });
	});

	it('parses jira section IDs', () => {
		const result = parseVectorId('slack-v2#jira-IEN-12345');
		expect(result).toEqual({ slug: 'slack', version: '2', section: 'jira-IEN-12345' });
	});

	it('returns null for invalid format', () => {
		expect(parseVectorId('invalid')).toBeNull();
		expect(parseVectorId('no-hash')).toBeNull();
		expect(parseVectorId('')).toBeNull();
	});

	it('round-trips with buildVectorId', () => {
		const id = buildVectorId('monday', '3', 'work-history');
		const parsed = parseVectorId(id);
		expect(parsed).toEqual({ slug: 'monday', version: '3', section: 'work-history' });
	});
});
