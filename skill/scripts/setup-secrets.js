#!/usr/bin/env node
/**
 * setup-secrets.js — interactive wizard for ~/.make-custom-app-skill-secrets
 * and (optional) mcp-server/.env.
 *
 * Run in your own terminal, not via the agent (needs a TTY; writes secrets).
 *
 *   node setup-secrets.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');
const { getSkillRoot } = require('./lib/skill-root');
const { readSkillConfig, SECRETS_PATH } = require('./lib/settings');
const { requireTty, upsertSecretsFile, upsertEnvFile } = require('./lib/secrets-file');
const { fetchJiraEmail } = require('./lib/jira-myself');

const DEFAULT_MAKE_API_URL = 'https://eu1.make.com/api/v2/admin';
const DEFAULT_JIRA_BASE_URL = 'https://make.atlassian.net';
const DEFAULT_PINECONE_INDEX = 'make-app-contexts';

const RUNTIME_HTTPS = 'https://github.com/integromat/imt-app-runtime.git';
const RUNTIME_SSH = 'git@github.com:integromat/imt-app-runtime.git';
const MOCKUP_HTTPS = 'https://github.com/integromat/make-apps-mockup.git';
const MOCKUP_SSH = 'git@github.com:integromat/make-apps-mockup.git';

let rl;

function openRl() {
	if (!rl) {
		rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	}
	return rl;
}

function closeRl() {
	if (rl) {
		rl.close();
		rl = undefined;
	}
}

function expandPath(p) {
	if (!p) return p;
	if (p === '~') return os.homedir();
	if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
	return path.resolve(p);
}

function isDir(p) {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

async function promptHidden(question) {
	process.stdout.write(question);
	const stdin = process.stdin;
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding('utf8');
	let value = '';
	return new Promise((resolve) => {
		const onData = (ch) => {
			if (ch === '\n' || ch === '\r' || ch === '\u0004') {
				cleanup();
				process.stdout.write('\n');
				resolve(value);
			} else if (ch === '\u0003') {
				cleanup();
				process.stdout.write('\n');
				process.exit(130);
			} else if (ch === '\u007f' || ch === '\b') {
				value = value.slice(0, -1);
			} else if (ch === '\u0017') {
				value = '';
			} else if (ch.charCodeAt(0) >= 32) {
				value += ch;
			}
		};
		function cleanup() {
			stdin.removeListener('data', onData);
			stdin.setRawMode(false);
		}
		stdin.on('data', onData);
	});
}

async function ask({ label, current, optional, hidden, validate }) {
	const hint = current
		? hidden
			? ' [set, Enter to keep]'
			: ` [${current}, Enter to keep]`
		: optional
			? ' [Enter to skip]'
			: '';
	const question = `${label}${hint}: `;
	let answer;
	if (hidden) {
		closeRl();
		answer = (await promptHidden(question)).trim();
		openRl();
	} else {
		answer = (await openRl().question(question)).trim();
	}
	if (!answer) {
		if (current) return current;
		if (optional) return '';
		console.log('  Required.');
		return ask({ label, current, optional, hidden, validate });
	}
	if (validate) {
		const err = validate(answer);
		if (err) {
			console.log(`  ${err}`);
			return ask({ label, current, optional, hidden, validate });
		}
	}
	return answer;
}

async function askYesNo(label, defaultYes = false) {
	const hint = defaultYes ? ' [Y/n]' : ' [y/N]';
	const answer = (await openRl().question(`${label}${hint}: `)).trim().toLowerCase();
	if (!answer) return defaultYes;
	return answer === 'y' || answer === 'yes';
}

function validateDir(raw) {
	const resolved = expandPath(raw);
	if (!isDir(resolved)) return `Not a directory: ${resolved}`;
	return null;
}

function readEnvValue(filePath, key) {
	if (!fs.existsSync(filePath)) return '';
	const m = fs.readFileSync(filePath, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'));
	return m ? m[1].trim() : '';
}

function envValuePresent(filePath, key) {
	const v = readEnvValue(filePath, key);
	return Boolean(v) && !v.startsWith('your-');
}

function printCloneHelp(name, httpsUrl, sshUrl) {
	console.log(`Clone ${name} (Make internal repo), then paste the absolute path to that clone.`);
	console.log('');
	console.log(`  HTTPS:  git clone ${httpsUrl}`);
	console.log(`  SSH:    git clone ${sshUrl}`);
	console.log('');
}

async function main() {
	try {
		requireTty(process.stdin);
	} catch (err) {
		if (err.code === 'NOT_TTY') {
			const cmd = `node ${path.join(getSkillRoot(), 'scripts', 'setup-secrets.js')}`;
			console.error('This wizard is interactive and writes secrets. Run it in your own terminal:');
			console.error(`  ${cmd}`);
			process.exit(1);
		}
		throw err;
	}

	require('./lib/version-guard').ensureFreshSkill();

	const skillRoot = getSkillRoot();
	const envPath = path.join(skillRoot, 'mcp-server', '.env');
	const envExample = path.join(skillRoot, 'mcp-server', '.env.example');

	console.log('make-custom-app setup');
	console.log(`Secrets file: ${SECRETS_PATH} (mode 600)`);
	console.log(`MCP .env:     ${envPath}`);
	console.log('');

	console.log('── Make API (required) ──');
	console.log(`Create a token at ${'https://eu1.make.com/user/api'}`);
	console.log('Scopes: apps:read apps:write sdk-apps:read sdk-apps:write, plus any admin scope you have.');
	console.log('');
	const makeApiKey = await ask({
		label: 'make-api-key',
		current: readSkillConfig('make-api-key'),
		hidden: true,
	});
	const makeApiUrl = readSkillConfig('make-api-url') || DEFAULT_MAKE_API_URL;

	console.log('');
	console.log('── imt-app-runtime (required) ──');
	printCloneHelp('imt-app-runtime', RUNTIME_HTTPS, RUNTIME_SSH);
	const runtimePath = expandPath(
		await ask({
			label: 'imt-app-runtime-path',
			current: readSkillConfig('imt-app-runtime-path'),
			validate: validateDir,
		}),
	);

	console.log('');
	console.log('── make-apps-mockup (optional) ──');
	printCloneHelp('make-apps-mockup', MOCKUP_HTTPS, MOCKUP_SSH);
	const mockupRaw = await ask({
		label: 'make-apps-mockup-path',
		current: readSkillConfig('make-apps-mockup-path'),
		optional: true,
		validate: (raw) => validateDir(raw),
	});
	const mockupPath = mockupRaw ? expandPath(mockupRaw) : '';

	console.log('');
	console.log('── Jira (optional) ──');
	console.log(`Create an API token at ${'https://id.atlassian.com/manage-profile/security/api-tokens'}`);
	console.log('Used for ticket attachments and reviewer assignment. Enter skips this section.');
	console.log('');
	const jiraToken = await ask({
		label: 'jira-api-token',
		current: readSkillConfig('jira-api-token'),
		optional: true,
		hidden: true,
	});

	let jiraEmail = readSkillConfig('jira-email');
	let jiraBaseUrl = readSkillConfig('jira-base-url');
	if (jiraToken) {
		jiraBaseUrl = jiraBaseUrl || DEFAULT_JIRA_BASE_URL;
		const typedEmail = await ask({
			label: 'Atlassian account email (to call /myself)',
			current: jiraEmail,
		});
		try {
			jiraEmail = await fetchJiraEmail({
				baseUrl: jiraBaseUrl,
				email: typedEmail,
				token: jiraToken,
			});
			console.log(`  jira-email set from /myself: ${jiraEmail}`);
		} catch (err) {
			jiraEmail = typedEmail;
			console.log(`  /myself failed (${err.message}). Saving the typed email.`);
		}
	}

	upsertSecretsFile(SECRETS_PATH, {
		'make-api-key': makeApiKey,
		'make-api-url': makeApiUrl,
		'imt-app-runtime-path': runtimePath,
		'make-apps-mockup-path': mockupPath || null,
		'jira-api-token': jiraToken || null,
		'jira-email': jiraToken ? jiraEmail : null,
		'jira-base-url': jiraToken ? jiraBaseUrl : null,
	});
	console.log('');
	console.log(`Wrote ${SECRETS_PATH}`);

	console.log('');
	console.log('── MCP server / Pinecone (optional) ──');
	const mcpDir = path.join(skillRoot, 'mcp-server');
	if (!fs.existsSync(mcpDir)) {
		console.log(`mcp-server not installed at ${mcpDir}. Re-run the installer to add it.`);
	} else {
		console.log('Shared app-context search. Needs a Pinecone index and an OpenAI key for embeddings.');
		console.log('Pinecone key:  https://app.pinecone.io');
		console.log('OpenAI key:    https://platform.openai.com/api-keys');
		console.log('');

		const mcpReady =
			envValuePresent(envPath, 'PINECONE_API_KEY') &&
			envValuePresent(envPath, 'PINECONE_INDEX_NAME') &&
			envValuePresent(envPath, 'OPENAI_API_KEY');
		const setupMcp = await askYesNo(mcpReady ? 'MCP .env already set. Update MCP keys?' : 'Set up MCP server now?', false);

		if (setupMcp) {
			if (!fs.existsSync(envPath) && fs.existsSync(envExample)) {
				fs.copyFileSync(envExample, envPath);
				fs.chmodSync(envPath, 0o600);
			}
			const pineconeKey = await ask({
				label: 'PINECONE_API_KEY',
				current: envValuePresent(envPath, 'PINECONE_API_KEY') ? 'set' : '',
				hidden: true,
			});
			const existingIndex = envValuePresent(envPath, 'PINECONE_INDEX_NAME')
				? readEnvValue(envPath, 'PINECONE_INDEX_NAME')
				: DEFAULT_PINECONE_INDEX;
			const pineconeIndex = await ask({
				label: 'PINECONE_INDEX_NAME',
				current: existingIndex,
			});
			const openaiKey = await ask({
				label: 'OPENAI_API_KEY',
				current: envValuePresent(envPath, 'OPENAI_API_KEY') ? 'set' : '',
				hidden: true,
			});
			const envUpdates = {
				PINECONE_INDEX_NAME: pineconeIndex || DEFAULT_PINECONE_INDEX,
			};
			if (pineconeKey !== 'set') envUpdates.PINECONE_API_KEY = pineconeKey;
			if (openaiKey !== 'set') envUpdates.OPENAI_API_KEY = openaiKey;
			upsertEnvFile(envPath, envUpdates);
			console.log(`Wrote ${envPath}`);
			console.log(`Then: cd ${mcpDir} && npm run register`);
		} else {
			console.log('MCP skipped.');
		}
	}

	closeRl();
	console.log('');
	console.log('Done. Verify with:');
	console.log(`  node ${path.join(skillRoot, 'scripts', 'check-setup.js')}`);
}

main().catch((err) => {
	closeRl();
	console.error(err.message || err);
	process.exit(1);
});
