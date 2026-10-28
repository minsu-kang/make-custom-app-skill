import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

/**
 * Where the server runs from decides which names and folders it uses.
 *
 * Plugin: `<plugin root>/mcp/index.mjs`. Secrets come from the namespaced environment variables, then from
 * ~/.make-custom-app-skill-secrets. Contexts live in ~/.make-custom-app/contexts.
 *
 * Old install (2.x): `<home>/.claude|.cursor/skills/make-custom-app/mcp-server/dist/index.js`. The old registration
 * writes the generic variable names, and the old scripts write the per-editor contexts folder, so both stay as in 2.3.12.
 */
const LEGACY_SEGMENT = '/skills/make-custom-app/mcp-server/';
const SECRETS_FILE = '.make-custom-app-skill-secrets';
const DEFAULT_INDEX = 'make-app-contexts';

// Same markers as shared/scripts/lib/settings.js: a value that holds one is a sample, not a secret.
const PLACEHOLDER_MARKERS = ['your-', '<', '>', '@example.com', 'ATATT3x...', '/path/provided/by/user', '/path/to/', '{path-to'];

export type Setting = 'pinecone-api-key' | 'pinecone-index-name' | 'openai-api-key';

const PLUGIN_ENV: Record<Setting, string> = {
	'pinecone-api-key': 'MAKE_APP_CONTEXT_PINECONE_API_KEY',
	'pinecone-index-name': 'MAKE_APP_CONTEXT_PINECONE_INDEX',
	'openai-api-key': 'MAKE_APP_CONTEXT_OPENAI_API_KEY',
};

const LEGACY_ENV: Record<Setting, string> = {
	'pinecone-api-key': 'PINECONE_API_KEY',
	'pinecone-index-name': 'PINECONE_INDEX_NAME',
	'openai-api-key': 'OPENAI_API_KEY',
};

/** True when `scriptPath` (process.argv[1]) is inside an old 2.x install. Both separators count, so a Windows path works anywhere. */
export function isLegacyInstall(scriptPath: string = process.argv[1] || ''): boolean {
	return scriptPath.replace(/\\/g, '/').includes(LEGACY_SEGMENT);
}

function isPlaceholder(value: string): boolean {
	return !value || PLACEHOLDER_MARKERS.some((marker) => value.includes(marker));
}

/** The value of the last `key: value` line that is not a sample, or undefined. Mirrors lastMatch in shared/scripts/lib/settings.js. */
export function lastSecretsValue(text: string, key: string): string | undefined {
	const re = new RegExp(`^${key}:\\s*(.+)$`);
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const match = lines[i].trim().match(re);
		if (match && !isPlaceholder(match[1].trim())) return match[1].trim();
	}
	return undefined;
}

export interface ConfigSource {
	env?: NodeJS.ProcessEnv;
	home?: string;
	scriptPath?: string;
}

function readSecrets(home: string): string {
	const file = path.join(home, SECRETS_FILE);
	if (!existsSync(file)) return '';
	try {
		return readFileSync(file, 'utf-8');
	} catch {
		return '';
	}
}

/** One setting, or undefined. Plugin: environment, then the secrets file. Old install: the generic environment name only. */
export function readSetting(key: Setting, source: ConfigSource = {}): string | undefined {
	const env = source.env ?? process.env;
	if (isLegacyInstall(source.scriptPath)) return env[LEGACY_ENV[key]] || undefined;
	const fromEnv = env[PLUGIN_ENV[key]];
	if (fromEnv) return fromEnv;
	return lastSecretsValue(readSecrets(source.home ?? os.homedir()), key);
}

/** The message for a missing setting. It names where to put the value and never prints one. */
export function missingMessage(key: Setting, source: ConfigSource = {}): string {
	if (isLegacyInstall(source.scriptPath)) return `${LEGACY_ENV[key]} is not set`;
	return `${key} is not set. Set ${PLUGIN_ENV[key]} or add "${key}: <value>" to ~/${SECRETS_FILE} (the setup wizard of the plugin writes it)`;
}

export function requireSetting(key: Setting, source: ConfigSource = {}): string {
	const value = readSetting(key, source);
	if (!value) throw new Error(missingMessage(key, source));
	return value;
}

export function getPineconeApiKey(source: ConfigSource = {}): string {
	return requireSetting('pinecone-api-key', source);
}

export function getOpenAiApiKey(source: ConfigSource = {}): string {
	return requireSetting('openai-api-key', source);
}

export function getPineconeIndexName(source: ConfigSource = {}): string {
	return readSetting('pinecone-index-name', source) || DEFAULT_INDEX;
}
