import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
	getOpenAiApiKey,
	getPineconeApiKey,
	getPineconeIndexName,
	isLegacyInstall,
	lastSecretsValue,
	missingMessage,
	readSetting,
	type Setting,
} from '../config.js';

const PLUGIN = '/home/u/.claude/plugins/cache/make-custom-app/make-custom-app/3.0.0/mcp/index.mjs';
const OLD = '/home/u/.claude/skills/make-custom-app/mcp-server/dist/index.js';
const SECRETS = '.make-custom-app-skill-secrets';

const secretsCases = JSON.parse(readFileSync(new URL('./fixtures/secrets-cases.json', import.meta.url), 'utf-8')) as {
	name: string;
	text: string;
	key: string;
	expected: string | null;
}[];

describe('isLegacyInstall', () => {
	it('is true only for a path under skills/make-custom-app/mcp-server', () => {
		expect(isLegacyInstall(OLD)).toBe(true);
		expect(isLegacyInstall('/home/u/.cursor/skills/make-custom-app/mcp-server/dist/index.js')).toBe(true);
		expect(isLegacyInstall('C:\\Users\\u\\.claude\\skills\\make-custom-app\\mcp-server\\dist\\index.js')).toBe(true);
		expect(isLegacyInstall(PLUGIN)).toBe(false);
		expect(isLegacyInstall('/home/u/make-custom-app-skill/mcp-server/dist/index.js')).toBe(false);
		expect(isLegacyInstall('')).toBe(false);
	});
});

describe('lastSecretsValue (shared cases with settings.js)', () => {
	for (const c of secretsCases) {
		it(c.name, () => {
			expect(lastSecretsValue(c.text, c.key) ?? null).toBe(c.expected);
		});
	}
});

describe('readSetting', () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	const write = (text: string) => writeFileSync(path.join(home, SECRETS), text);

	it('plugin: reads the namespaced environment variable first', () => {
		write('openai-api-key: from-file\n');
		const env = { MAKE_APP_CONTEXT_OPENAI_API_KEY: 'from-env' };
		expect(readSetting('openai-api-key', { env, home, scriptPath: PLUGIN })).toBe('from-env');
	});

	it('plugin: falls back to the secrets file, and an empty variable counts as unset', () => {
		write('pinecone-api-key: from-file\n');
		const env = { MAKE_APP_CONTEXT_PINECONE_API_KEY: '' };
		expect(readSetting('pinecone-api-key', { env, home, scriptPath: PLUGIN })).toBe('from-file');
	});

	it('plugin: never picks up the generic variable names', () => {
		const env = { OPENAI_API_KEY: 'unrelated', PINECONE_API_KEY: 'unrelated', PINECONE_INDEX_NAME: 'unrelated' };
		for (const key of ['openai-api-key', 'pinecone-api-key', 'pinecone-index-name'] as Setting[]) {
			expect(readSetting(key, { env, home, scriptPath: PLUGIN })).toBeUndefined();
		}
	});

	it('plugin: a missing secrets file is not an error', () => {
		expect(readSetting('openai-api-key', { env: {}, home, scriptPath: PLUGIN })).toBeUndefined();
	});

	it('plugin: an unreadable secrets file is treated as empty', () => {
		mkdirSync(path.join(home, SECRETS));
		expect(readSetting('openai-api-key', { env: {}, home, scriptPath: PLUGIN })).toBeUndefined();
	});

	it('old install: reads the generic names the old registration writes', () => {
		write('openai-api-key: from-file\n');
		const env = {
			OPENAI_API_KEY: 'old-openai',
			PINECONE_API_KEY: 'old-pinecone',
			PINECONE_INDEX_NAME: 'old-index',
			MAKE_APP_CONTEXT_OPENAI_API_KEY: 'namespaced',
		};
		expect(readSetting('openai-api-key', { env, home, scriptPath: OLD })).toBe('old-openai');
		expect(readSetting('pinecone-api-key', { env, home, scriptPath: OLD })).toBe('old-pinecone');
		expect(readSetting('pinecone-index-name', { env, home, scriptPath: OLD })).toBe('old-index');
	});

	it('old install: ignores the secrets file', () => {
		write('openai-api-key: from-file\n');
		expect(readSetting('openai-api-key', { env: {}, home, scriptPath: OLD })).toBeUndefined();
	});
});

describe('required settings', () => {
	it('throw the 2.3.12 message in an old install', () => {
		expect(() => getPineconeApiKey({ env: {}, scriptPath: OLD })).toThrow('PINECONE_API_KEY is not set');
		expect(() => getOpenAiApiKey({ env: {}, scriptPath: OLD })).toThrow('OPENAI_API_KEY is not set');
	});

	it('name the variable and the secrets-file key in the plugin, without printing a value', () => {
		const message = missingMessage('openai-api-key', { scriptPath: PLUGIN });
		expect(message).toContain('MAKE_APP_CONTEXT_OPENAI_API_KEY');
		expect(message).toContain('"openai-api-key: <value>"');
		expect(message).toContain(`~/${SECRETS}`);
	});

	it('return the value when it is set', () => {
		expect(getPineconeApiKey({ env: { MAKE_APP_CONTEXT_PINECONE_API_KEY: 'k' }, scriptPath: PLUGIN })).toBe('k');
	});
});

describe('getPineconeIndexName', () => {
	it('defaults to make-app-contexts and takes the configured name otherwise', () => {
		const home = mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
		try {
			expect(getPineconeIndexName({ env: {}, home, scriptPath: PLUGIN })).toBe('make-app-contexts');
			expect(getPineconeIndexName({ env: { MAKE_APP_CONTEXT_PINECONE_INDEX: 'mine' }, home, scriptPath: PLUGIN })).toBe('mine');
			expect(getPineconeIndexName({ env: { PINECONE_INDEX_NAME: 'old' }, home, scriptPath: OLD })).toBe('old');
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
