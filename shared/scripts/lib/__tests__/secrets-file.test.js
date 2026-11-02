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

describe('duplicate keys', () => {
	it('replaces the last line of a key, the one readers use, and drops earlier duplicates', () => {
		const out = applySecretsUpdates(['a: 1', 'make-team-id: 7', 'b: 2', 'make-team-id: 8', ''].join('\n'), { 'make-team-id': '2321' });
		assert.equal(out, ['a: 1', 'b: 2', 'make-team-id: 2321', ''].join('\n'));
	});

	it('matches an indented line the way the reader does', () => {
		const out = applySecretsUpdates(['make-team-id: 7', '  make-team-id: 12', ''].join('\n'), { 'make-team-id': '2321' });
		assert.equal(out, 'make-team-id: 2321\n');
	});

	it('dedupes every updated key independently and keeps other keys and comments', () => {
		const out = applySecretsUpdates(['# c', 'x: 1', 'y: 1', 'x: 2', 'y: 2', 'z: 3', ''].join('\n'), { x: 'X', y: 'Y' });
		assert.equal(out, ['# c', 'x: X', 'y: Y', 'z: 3', ''].join('\n'));
	});

	it('env files follow the same rule', () => {
		const out = applyEnvUpdates(['K=1', 'M=2', 'K=3', ''].join('\n'), { K: 'new' });
		assert.equal(out, ['M=2', 'K=new', ''].join('\n'));
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

describe('upsertSecretsFile replaces the file in one step', () => {
	let dir;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'make-secrets-atomic-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('tightens a file that was readable by others to 600 and leaves no temp file', () => {
		const file = path.join(dir, 'secrets');
		fs.writeFileSync(file, 'make-api-key: x\n', { mode: 0o644 });
		fs.chmodSync(file, 0o644);
		upsertSecretsFile(file, { 'make-team-id': '7' });
		assert.equal(fs.readFileSync(file, 'utf8'), 'make-api-key: x\nmake-team-id: 7\n');
		if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(dir), ['secrets']);
	});

	it('keeps a symlinked secrets file as a link and updates the file it points to', { skip: process.platform === 'win32' }, () => {
		const real = path.join(dir, 'real-secrets');
		const link = path.join(dir, 'link-secrets');
		fs.writeFileSync(real, 'make-api-key: x\n');
		fs.symlinkSync(real, link);
		upsertSecretsFile(link, { 'make-team-id': '7' });
		assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
		assert.equal(fs.readFileSync(real, 'utf8'), 'make-api-key: x\nmake-team-id: 7\n');
		assert.deepEqual(fs.readdirSync(dir).sort(), ['link-secrets', 'real-secrets']);
	});

	it('never leaves a truncated file for a reader while another process writes', { skip: process.platform === 'win32' }, () => {
		const file = path.join(dir, 'secrets');
		fs.writeFileSync(file, 'make-api-key: keep\nimt-app-runtime-path: /rt\n');
		for (let i = 0; i < 200; i++) {
			upsertSecretsFile(file, { 'make-team-id': String(i + 1) });
			const text = fs.readFileSync(file, 'utf8');
			assert.match(text, /make-api-key: keep/);
			assert.match(text, /imt-app-runtime-path: \/rt/);
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
