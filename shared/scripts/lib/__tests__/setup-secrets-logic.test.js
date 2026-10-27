const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logic = require('../setup-secrets-logic');
const { upsertSecretsFile } = require('../secrets-file');

describe('parseArgs', () => {
	it('returns no editor when there are no arguments', () => {
		assert.deepEqual(logic.parseArgs([]), { editor: null, error: null });
	});

	it('reads --editor with a separate value or with =', () => {
		assert.deepEqual(logic.parseArgs(['--editor', 'claude']), { editor: 'claude', error: null });
		assert.deepEqual(logic.parseArgs(['--editor=cursor']), { editor: 'cursor', error: null });
	});

	it('passes any value through, so the check of the value stays in paths.resolveEditor', () => {
		assert.deepEqual(logic.parseArgs(['--editor', 'vscode']), { editor: 'vscode', error: null });
	});

	it('lets the last --editor win', () => {
		assert.deepEqual(logic.parseArgs(['--editor', 'claude', '--editor=cursor']), { editor: 'cursor', error: null });
	});

	it('reports a missing value', () => {
		for (const argv of [['--editor'], ['--editor='], ['--editor', '--other']]) {
			assert.deepEqual(logic.parseArgs(argv), { editor: null, error: '--editor needs a value: claude or cursor.' }, argv.join(' '));
		}
	});

	it('reports an argument it does not know', () => {
		assert.deepEqual(logic.parseArgs(['--bogus']), { editor: null, error: 'Unknown argument: --bogus' });
		assert.deepEqual(logic.parseArgs(['--editor', 'claude', 'extra']), { editor: null, error: 'Unknown argument: extra' });
	});

	it('has a usage line that names the flag', () => {
		assert.equal(logic.USAGE, 'Usage: node setup-secrets.js [--editor claude|cursor]');
	});
});

describe('makeKeyInSecretsFile', () => {
	it('is true for Claude Code and false for Cursor, which reads the key from its own settings.json', () => {
		assert.equal(logic.makeKeyInSecretsFile('claude'), true);
		assert.equal(logic.makeKeyInSecretsFile('cursor'), false);
	});
});

describe('buildSecretsUpdates', () => {
	const ANSWERS = {
		makeApiKey: 'MK',
		makeApiUrl: 'https://eu1.make.com/api/v2/admin',
		runtimePath: '/work/imt-app-runtime',
		mockupPath: '/work/make-apps-mockup',
		teamId: '42',
		jiraToken: 'JT',
		jiraEmail: 'dev@make.com',
		jiraBaseUrl: 'https://make.atlassian.net',
	};

	it('lists every key for Claude Code, in the order they are written', () => {
		assert.deepEqual(Object.entries(logic.buildSecretsUpdates('claude', ANSWERS)), [
			['make-api-key', 'MK'],
			['make-api-url', 'https://eu1.make.com/api/v2/admin'],
			['imt-app-runtime-path', '/work/imt-app-runtime'],
			['make-apps-mockup-path', '/work/make-apps-mockup'],
			['make-team-id', '42'],
			['jira-api-token', 'JT'],
			['jira-email', 'dev@make.com'],
			['jira-base-url', 'https://make.atlassian.net'],
		]);
	});

	it('leaves out the Make API key and URL for Cursor, so a Claude Code key in the file stays as it is', () => {
		const keys = Object.keys(logic.buildSecretsUpdates('cursor', ANSWERS));
		assert.deepEqual(keys, ['imt-app-runtime-path', 'make-apps-mockup-path', 'make-team-id', 'jira-api-token', 'jira-email', 'jira-base-url']);
	});

	it('sets skipped optional answers to null, which the secrets file leaves untouched', () => {
		const updates = logic.buildSecretsUpdates('claude', { ...ANSWERS, mockupPath: '', teamId: '' });
		assert.equal(updates['make-apps-mockup-path'], null);
		assert.equal(updates['make-team-id'], null);
		assert.equal(updates['imt-app-runtime-path'], '/work/imt-app-runtime');
	});

	it('writes no Jira line when there is no Jira token', () => {
		const updates = logic.buildSecretsUpdates('claude', { ...ANSWERS, jiraToken: '' });
		assert.equal(updates['jira-api-token'], null);
		assert.equal(updates['jira-email'], null);
		assert.equal(updates['jira-base-url'], null);
	});
});

describe('buildMcpUpdates', () => {
	it('maps the three answers to the keys of the secrets file', () => {
		assert.deepEqual(logic.buildMcpUpdates({ pineconeKey: 'PK', pineconeIndex: 'my-index', openaiKey: 'OK' }), {
			'pinecone-api-key': 'PK',
			'pinecone-index-name': 'my-index',
			'openai-api-key': 'OK',
		});
	});

	it('falls back to the default index and leaves empty keys untouched', () => {
		assert.deepEqual(logic.buildMcpUpdates({ pineconeKey: '', pineconeIndex: '', openaiKey: '' }), {
			'pinecone-api-key': null,
			'pinecone-index-name': 'make-app-contexts',
			'openai-api-key': null,
		});
	});
});

describe('mcpConfigured', () => {
	it('is true only when the Pinecone key, the index name and the OpenAI key are all set', () => {
		assert.equal(logic.mcpConfigured({ pineconeKey: 'PK', pineconeIndex: 'idx', openaiKey: 'OK' }), true);
		for (const missing of ['pineconeKey', 'pineconeIndex', 'openaiKey']) {
			const values = { pineconeKey: 'PK', pineconeIndex: 'idx', openaiKey: 'OK', [missing]: null };
			assert.equal(logic.mcpConfigured(values), false, missing);
		}
	});
});

describe('the updates written through upsertSecretsFile', () => {
	let work;
	before(() => {
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-secrets-logic-'));
	});
	after(() => fs.rmSync(work, { recursive: true, force: true }));

	it('replace existing MCP keys in place, add the missing one at the end, and leave the file private', () => {
		const file = path.join(work, 'mcp-secrets');
		fs.writeFileSync(file, 'imt-app-runtime-path: /a\npinecone-api-key: OLDPINE\njira-email: dev@make.com\nopenai-api-key: SAMEOPENAI\n', { mode: 0o644 });
		upsertSecretsFile(file, logic.buildMcpUpdates({ pineconeKey: 'NEWPINE', pineconeIndex: '', openaiKey: 'SAMEOPENAI' }));
		assert.equal(
			fs.readFileSync(file, 'utf8'),
			'imt-app-runtime-path: /a\npinecone-api-key: NEWPINE\njira-email: dev@make.com\nopenai-api-key: SAMEOPENAI\npinecone-index-name: make-app-contexts\n',
		);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	});

	it('keep a Make API key of Claude Code when the editor is Cursor', () => {
		const file = path.join(work, 'cursor-secrets');
		fs.writeFileSync(file, 'make-api-key: CLAUDEKEY\nmake-api-url: https://us1.make.com/api/v2/admin\n');
		upsertSecretsFile(file, logic.buildSecretsUpdates('cursor', { runtimePath: '/work/imt-app-runtime', mockupPath: '', teamId: '', jiraToken: '' }));
		assert.equal(
			fs.readFileSync(file, 'utf8'),
			'make-api-key: CLAUDEKEY\nmake-api-url: https://us1.make.com/api/v2/admin\nimt-app-runtime-path: /work/imt-app-runtime\n',
		);
	});
});

describe('promptHint', () => {
	it('shows the current value of a visible question', () => {
		assert.equal(logic.promptHint({ current: '/work/imt-app-runtime', optional: false, hidden: false }), ' [/work/imt-app-runtime, Enter to keep]');
	});

	it('never shows the current value of a hidden question', () => {
		const hint = logic.promptHint({ current: 'TOPSECRET', optional: false, hidden: true });
		assert.equal(hint, ' [set, Enter to keep]');
		assert.ok(!hint.includes('TOPSECRET'));
	});

	it('offers to skip an optional question without a value', () => {
		assert.equal(logic.promptHint({ current: '', optional: true, hidden: false }), ' [Enter to skip]');
	});

	it('adds nothing to a required question without a value', () => {
		assert.equal(logic.promptHint({ current: null, optional: false, hidden: true }), '');
	});
});

describe('maskForDisplay', () => {
	it('shows only "set" for a secret key', () => {
		for (const key of ['make-api-key', 'jira-api-token', 'pinecone-api-key', 'openai-api-key']) {
			assert.equal(logic.maskForDisplay(key, 'TOPSECRET'), 'set', key);
		}
	});

	it('shows "not set" for an empty value, a missing value and a blank value', () => {
		for (const value of ['', null, undefined, '   ']) assert.equal(logic.maskForDisplay('pinecone-api-key', value), 'not set', String(value));
	});

	it('shows the value of a key that is not secret', () => {
		assert.equal(logic.maskForDisplay('pinecone-index-name', 'make-app-contexts'), 'make-app-contexts');
		assert.equal(logic.maskForDisplay('pinecone-index-name', null), 'not set');
	});
});

describe('formatStatus', () => {
	it('lists each key with "set" or "not set" for a secret, and never the secret', () => {
		const lines = logic.formatStatus({ 'pinecone-api-key': 'PK-SECRET', 'pinecone-index-name': 'make-app-contexts', 'openai-api-key': null });
		assert.deepEqual(lines, ['  pinecone-api-key: set', '  pinecone-index-name: make-app-contexts', '  openai-api-key: not set']);
		assert.ok(!lines.join('\n').includes('PK-SECRET'));
	});
});
