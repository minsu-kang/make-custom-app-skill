/**
 * setup-secrets-logic.js: the decisions behind setup-secrets.js (the entry script in the folder above).
 *
 * Role: pure functions only. Plain values in, plain values out: no prompts, no file access, no process.exit, no console.
 * The entry script asks the questions and writes the file. A new rule goes here with a unit test in
 * lib/__tests__/setup-secrets-logic.test.js.
 */

const USAGE = 'Usage: node setup-secrets.js [--editor claude|cursor]';
const DEFAULT_MAKE_API_URL = 'https://eu1.make.com/api/v2/admin';
const DEFAULT_JIRA_BASE_URL = 'https://make.atlassian.net';
const DEFAULT_PINECONE_INDEX = 'make-app-contexts';
const SECRET_KEYS = ['make-api-key', 'jira-api-token', 'pinecone-api-key', 'openai-api-key'];

/**
 * Reads the command line. The value of --editor is not checked here: paths.resolveEditor owns that rule, so the
 * message for a bad value is the same in every script.
 */
function parseArgs(argv) {
	let editor = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--editor') {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) return { editor: null, error: '--editor needs a value: claude or cursor.' };
			editor = value;
			i++;
		} else if (arg.startsWith('--editor=')) {
			editor = arg.slice('--editor='.length);
			if (!editor) return { editor: null, error: '--editor needs a value: claude or cursor.' };
		} else {
			return { editor: null, error: `Unknown argument: ${arg}` };
		}
	}
	return { editor, error: null };
}

/** Cursor takes the Make API key from its own settings.json (apps-sdk.environments). Only Claude Code keeps it in the secrets file. */
function makeKeyInSecretsFile(editor) {
	return editor === 'claude';
}

/**
 * The lines the main part of the wizard writes. A null value means "leave that line as it is" (secrets-file.js skips it),
 * which is how a skipped optional question keeps its old value. Object order is the order of new lines in a new file.
 */
function buildSecretsUpdates(editor, answers) {
	const { makeApiKey, makeApiUrl, runtimePath, mockupPath, teamId, jiraToken, jiraEmail, jiraBaseUrl } = answers;
	const updates = {};
	if (makeKeyInSecretsFile(editor)) {
		updates['make-api-key'] = makeApiKey;
		updates['make-api-url'] = makeApiUrl;
	}
	updates['imt-app-runtime-path'] = runtimePath;
	updates['make-apps-mockup-path'] = mockupPath || null;
	updates['make-team-id'] = teamId || null;
	updates['jira-api-token'] = jiraToken || null;
	updates['jira-email'] = jiraToken ? jiraEmail : null;
	updates['jira-base-url'] = jiraToken ? jiraBaseUrl : null;
	return updates;
}

/** The lines the Pinecone / OpenAI step writes into the secrets file (they used to go to mcp-server/.env). */
function buildMcpUpdates({ pineconeKey, pineconeIndex, openaiKey }) {
	return {
		'pinecone-api-key': pineconeKey || null,
		'pinecone-index-name': pineconeIndex || DEFAULT_PINECONE_INDEX,
		'openai-api-key': openaiKey || null,
	};
}

/** True when the secrets file already holds everything the make-app-context server needs. */
function mcpConfigured({ pineconeKey, pineconeIndex, openaiKey }) {
	return Boolean(pineconeKey && pineconeIndex && openaiKey);
}

/** The part of a question after its label. A hidden question never shows the value it keeps. */
function promptHint({ current, optional, hidden }) {
	if (current) return hidden ? ' [set, Enter to keep]' : ` [${current}, Enter to keep]`;
	return optional ? ' [Enter to skip]' : '';
}

/** What the wizard may print for a key: "set" or "not set" for a secret, the value itself for anything else. */
function maskForDisplay(key, value) {
	if (!value || !String(value).trim()) return 'not set';
	return SECRET_KEYS.includes(key) ? 'set' : value;
}

/** One printable line per key of an updates object. */
function formatStatus(updates) {
	return Object.entries(updates).map(([key, value]) => `  ${key}: ${maskForDisplay(key, value)}`);
}

module.exports = {
	USAGE,
	DEFAULT_MAKE_API_URL,
	DEFAULT_JIRA_BASE_URL,
	DEFAULT_PINECONE_INDEX,
	parseArgs,
	makeKeyInSecretsFile,
	buildSecretsUpdates,
	buildMcpUpdates,
	mcpConfigured,
	promptHint,
	maskForDisplay,
	formatStatus,
};
