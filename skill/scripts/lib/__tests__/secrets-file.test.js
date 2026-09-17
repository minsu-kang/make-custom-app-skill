const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applySecretsUpdates, upsertSecretsFile, applyEnvUpdates, upsertEnvFile, requireTty } = require('../secrets-file');

describe('applySecretsUpdates', () => {
	it('writes key: value lines when the file is empty', () => {
		const out = applySecretsUpdates('', { 'make-api-key': 'tok_1', 'make-api-url': 'https://eu1.make.com/api/v2/admin' });
		assert.equal(out, ['make-api-key: tok_1', 'make-api-url: https://eu1.make.com/api/v2/admin', ''].join('\n'));
	});

	it('updates an existing key in place and appends new keys', () => {
		const existing = ['# keep me', 'make-api-key: old', 'imt-app-runtime-path: /old/runtime', ''].join('\n');
		const out = applySecretsUpdates(existing, { 'make-api-key': 'new', 'jira-email': 'a@b.com' });
		assert.equal(
			out,
			['# keep me', 'make-api-key: new', 'imt-app-runtime-path: /old/runtime', 'jira-email: a@b.com', ''].join('\n'),
		);
	});

	it('skips keys whose update value is null or undefined', () => {
		const existing = 'make-api-key: keep\n';
		const out = applySecretsUpdates(existing, { 'make-api-key': null, 'jira-email': undefined, 'make-api-url': 'https://eu1.make.com/api/v2/admin' });
		assert.equal(out, ['make-api-key: keep', 'make-api-url: https://eu1.make.com/api/v2/admin', ''].join('\n'));
	});
});

describe('upsertSecretsFile', () => {
	let dir;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'make-secrets-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('creates the file with mode 600 and merges later writes', () => {
		const file = path.join(dir, '.make-custom-app-skill-secrets');
		upsertSecretsFile(file, { 'make-api-key': 'first' });
		assert.equal(fs.readFileSync(file, 'utf8'), 'make-api-key: first\n');
		if (process.platform !== 'win32') {
			assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		}
		upsertSecretsFile(file, { 'imt-app-runtime-path': '/rt' });
		assert.equal(fs.readFileSync(file, 'utf8'), ['make-api-key: first', 'imt-app-runtime-path: /rt', ''].join('\n'));
		if (process.platform !== 'win32') {
			assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		}
	});
});

describe('applyEnvUpdates', () => {
	it('writes KEY=value lines when the file is empty', () => {
		const out = applyEnvUpdates('', { PINECONE_API_KEY: 'pc', PINECONE_INDEX_NAME: 'make-app-contexts', OPENAI_API_KEY: 'sk' });
		assert.equal(out, ['PINECONE_API_KEY=pc', 'PINECONE_INDEX_NAME=make-app-contexts', 'OPENAI_API_KEY=sk', ''].join('\n'));
	});

	it('updates existing keys in place and keeps comments', () => {
		const existing = ['# Pinecone', 'PINECONE_API_KEY=old', 'PINECONE_INDEX_NAME=make-app-contexts', '', '# OpenAI', 'OPENAI_API_KEY=old-sk', ''].join('\n');
		const out = applyEnvUpdates(existing, { PINECONE_API_KEY: 'new', OPENAI_API_KEY: 'new-sk' });
		assert.equal(
			out,
			['# Pinecone', 'PINECONE_API_KEY=new', 'PINECONE_INDEX_NAME=make-app-contexts', '', '# OpenAI', 'OPENAI_API_KEY=new-sk', ''].join('\n'),
		);
	});
});

describe('upsertEnvFile', () => {
	let dir;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'make-env-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('creates .env with mode 600', () => {
		const file = path.join(dir, '.env');
		upsertEnvFile(file, { PINECONE_API_KEY: 'pc', OPENAI_API_KEY: 'sk', PINECONE_INDEX_NAME: 'make-app-contexts' });
		assert.match(fs.readFileSync(file, 'utf8'), /PINECONE_API_KEY=pc/);
		if (process.platform !== 'win32') {
			assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		}
	});
});

describe('requireTty', () => {
	it('throws NOT_TTY when stdin is not a TTY', () => {
		assert.throws(() => requireTty({ isTTY: false }), (err) => err.code === 'NOT_TTY');
	});

	it('returns when stdin is a TTY', () => {
		assert.doesNotThrow(() => requireTty({ isTTY: true }));
	});
});
