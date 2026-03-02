import { describe, it, expect } from 'vitest';
import { splitMarkdownSections, summarizeMetadata } from '../chunker.js';

describe('splitMarkdownSections', () => {
	it('returns empty array for empty string', () => {
		expect(splitMarkdownSections('')).toEqual([]);
	});

	it('returns empty array for text without ## headings', () => {
		expect(splitMarkdownSections('just some text\nno headings')).toEqual([]);
	});

	it('parses a single section', () => {
		const md = '## App Overview\n\n- slug: test\n- version: 1';
		const result = splitMarkdownSections(md);
		expect(result).toHaveLength(1);
		expect(result[0].section).toBe('app-overview');
		expect(result[0].content).toContain('## App Overview');
		expect(result[0].content).toContain('- slug: test');
	});

	it('parses multiple sections', () => {
		const md = '## First\nContent 1\n## Second\nContent 2\n## Third\nContent 3';
		const result = splitMarkdownSections(md);
		expect(result).toHaveLength(3);
		expect(result[0].section).toBe('first');
		expect(result[1].section).toBe('second');
		expect(result[2].section).toBe('third');
	});

	it('ignores content before the first ## heading', () => {
		const md = '# Title\nSome intro\n\n## Real Section\nReal content';
		const result = splitMarkdownSections(md);
		expect(result).toHaveLength(1);
		expect(result[0].section).toBe('real-section');
		expect(result[0].content).not.toContain('Some intro');
	});

	it('normalizes heading: lowercase, remove special chars, spaces to dashes', () => {
		const md = '## Key Patterns & Notes!\nsome content';
		const result = splitMarkdownSections(md);
		expect(result[0].section).toBe('key-patterns-notes');
	});

	it('trims whitespace from section content', () => {
		const md = '## Section\n\n  content  \n\n';
		const result = splitMarkdownSections(md);
		expect(result[0].content).toBe('## Section\n\n  content');
	});
});

describe('summarizeMetadata', () => {
	it('handles minimal metadata (slug + version only)', () => {
		const result = summarizeMetadata({ slug: 'test-app', version: '1' });
		expect(result).toBe('App: test-app (test-app v1)');
	});

	it('uses label over slug when available', () => {
		const result = summarizeMetadata({ slug: 'test-app', version: '1', label: 'Test App' });
		expect(result).toContain('App: Test App (test-app v1)');
	});

	it('includes description and origin', () => {
		const result = summarizeMetadata({
			slug: 'app',
			version: '2',
			description: 'A test app',
			origin: 'eu1.make.com',
		});
		expect(result).toContain('Description: A test app');
		expect(result).toContain('Origin: eu1.make.com');
	});

	it('groups modules by type', () => {
		const result = summarizeMetadata({
			slug: 'app',
			version: '1',
			modules: [
				{ name: 'mod1', label: 'Create Item', typeId: 4 },
				{ name: 'mod2', label: 'Delete Item', typeId: 4 },
				{ name: 'mod3', label: 'Watch Items', typeId: 1 },
			],
		});
		expect(result).toContain('Action (2): Create Item, Delete Item');
		expect(result).toContain('Trigger (1): Watch Items');
	});

	it('falls back to module name when label is missing', () => {
		const result = summarizeMetadata({
			slug: 'app',
			version: '1',
			modules: [{ name: 'myModule', typeId: 4 }],
		});
		expect(result).toContain('myModule');
	});

	it('handles unknown module typeId', () => {
		const result = summarizeMetadata({
			slug: 'app',
			version: '1',
			modules: [{ name: 'mod', typeId: 99 }],
		});
		expect(result).toContain('Type 99');
	});

	it('includes rpcs, webhooks, connections, and functions', () => {
		const result = summarizeMetadata({
			slug: 'app',
			version: '1',
			rpcs: [{ name: 'rpc1', label: 'List Items' }],
			webhooks: [{ name: 'wh1', label: 'New Item' }],
			connections: [{ name: 'conn1', label: 'OAuth2' }],
			functions: [{ name: 'fn1' }, 'fn2'],
		});
		expect(result).toContain('RPCs: List Items');
		expect(result).toContain('Webhooks: New Item');
		expect(result).toContain('Connections: OAuth2');
		expect(result).toContain('Custom Functions: fn1, fn2');
	});

	it('handles empty arrays gracefully', () => {
		const result = summarizeMetadata({
			slug: 'app',
			version: '1',
			modules: [],
			rpcs: [],
		});
		expect(result).toBe('App: app (app v1)');
	});
});
