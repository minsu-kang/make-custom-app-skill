#!/usr/bin/env node
/**
 * check-setup.js — one-screen diagnosis of the skill's local setup.
 *
 * Replaces the prose "Hard Stop" and setup-guide sections that used to live in
 * SKILL.md (pre-2.0). The agent runs this once per conversation; a
 * non-zero exit means a REQUIRED item is missing and work must stop until the
 * printed fix is applied.
 *
 *   node check-setup.js                 human-readable report
 *   node check-setup.js --json          machine-readable report
 *   node check-setup.js --skip-version  skip the remote skill-version check
 *
 * Exit codes: 0 = every required item OK, 1 = a required item is missing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getSkillRoot, getEditorDir } = require('./lib/skill-root');
const { readSkillConfig, skillMdHasConfig, SECRETS_PATH } = require('./lib/settings');

const args = new Set(process.argv.slice(2));
if (!args.has('--skip-version')) {
	require('./lib/version-guard').ensureFreshSkill();
}

const skillRoot = getSkillRoot();
const editorDir = getEditorDir();
const isClaude = editorDir === '.claude';
const skillMd = path.join(skillRoot, 'SKILL.md');
const items = [];
const SECRETS_HINT = `${SECRETS_PATH} (one \`key: value\` per line; create it with mode 600 if missing)`;

function add(key, status, detail, fix) {
	items.push({ key, status, detail, fix: fix || null });
}

function isPlaceholder(value, markers) {
	return !value || markers.some((m) => value.includes(m));
}

// 1. imt-app-runtime-path (required, both editors)
{
	const v = readSkillConfig('imt-app-runtime-path');
	if (isPlaceholder(v, ['/path/provided/by/user'])) {
		add(
			'imt-app-runtime-path',
			'missing',
			'not set',
			`Clone niceinnovative/imt-app-runtime (Make internal repo), then add to ${SECRETS_HINT}:\n  imt-app-runtime-path: /absolute/path/to/imt-app-runtime`,
		);
	} else if (!fs.existsSync(v)) {
		add(
			'imt-app-runtime-path',
			'missing',
			`path does not exist: ${v}`,
			`Fix the imt-app-runtime-path line in ${SECRETS_PATH} so it points to an existing clone.`,
		);
	} else {
		add('imt-app-runtime-path', 'ok', v);
	}
}

// 2. Make API credentials (required)
if (isClaude) {
	const key = readSkillConfig('make-api-key');
	if (!key || /^<.*>$/.test(key)) {
		add(
			'make-api-key',
			'missing',
			'not set (Claude Code reads it from ~/.make-custom-app-skill-secrets)',
			`Generate a token in Make → Profile → API (scopes: apps:read apps:write sdk-apps:read sdk-apps:write, plus any admin scope you have), then add to ${SECRETS_HINT}:\n  make-api-key: <token>\n  make-api-url: https://eu1.make.com/api/v2/admin   # optional — change for us1/us2/custom zone`,
		);
	} else {
		add('make-api-key', 'ok', `set (${readSkillConfig('make-api-url') || 'https://eu1.make.com/api/v2/admin'})`);
	}
} else {
	const settingsPath = path.join(
		os.homedir(),
		process.platform === 'win32' ? 'AppData/Roaming/Cursor/User/settings.json' : 'Library/Application Support/Cursor/User/settings.json',
	);
	let ok = false;
	try {
		const raw = fs
			.readFileSync(settingsPath, 'utf-8')
			.replace(/\/\/.*$/gm, '')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/,\s*([}\]])/g, '$1');
		const s = JSON.parse(raw);
		ok = Array.isArray(s['apps-sdk.environments']) && s['apps-sdk.environments'].length > 0;
	} catch {
		/* unreadable → treated as missing */
	}
	if (ok) {
		add('make-api (Cursor settings.json)', 'ok', 'apps-sdk.environments present');
	} else {
		add(
			'make-api (Cursor settings.json)',
			'missing',
			`apps-sdk.environments not found in ${settingsPath}`,
			'Install the Make Apps SDK extension in Cursor and add an environment with your API key (Command Palette → "Make Apps: Add environment").',
		);
	}
}

// 3. make-apps-mockup-path (optional — test-component.js)
{
	const v = readSkillConfig('make-apps-mockup-path');
	if (isPlaceholder(v, ['/path/to'])) {
		add(
			'make-apps-mockup-path',
			'optional-missing',
			'not set — test-component.js unavailable',
			`Clone the make-apps-mockup repo, then add to ${SECRETS_HINT}:\n  make-apps-mockup-path: /absolute/path/to/make-apps-mockup`,
		);
	} else if (!fs.existsSync(v)) {
		add('make-apps-mockup-path', 'optional-missing', `path does not exist: ${v}`, `Fix the make-apps-mockup-path line in ${SECRETS_PATH}.`);
	} else {
		add('make-apps-mockup-path', 'ok', v);
	}
}

// 4. Jira credentials (optional — attachment download, reviewer assignment)
{
	const email = readSkillConfig('jira-email');
	const token = readSkillConfig('jira-api-token');
	if (isPlaceholder(email, ['your-email', '@example.com']) || isPlaceholder(token, ['your-api-token', '<token>'])) {
		add(
			'jira credentials',
			'optional-missing',
			'jira-email / jira-api-token not set — attachment download and reviewer assignment unavailable',
			`Create a token at https://id.atlassian.com/manage-profile/security/api-tokens, then add to ${SECRETS_HINT}:\n  jira-email: you@example.com\n  jira-api-token: <token>\n  jira-base-url: https://make.atlassian.net   # optional`,
		);
	} else {
		add('jira credentials', 'ok', email);
	}
}

// 5. MCP server (optional — shared Pinecone context)
{
	const mcpDir = readSkillConfig('mcp-server-path') || path.join(skillRoot, 'mcp-server');
	const dist = path.join(mcpDir, 'dist', 'index.js');
	const envFile = path.join(mcpDir, '.env');
	const registryPath = isClaude ? path.join(os.homedir(), '.claude.json') : path.join(os.homedir(), '.cursor', 'mcp.json');
	let registered = false;
	try {
		const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
		// Cursor registers the server as `make-app-context`, the Claude installer as `make-custom-app`.
		registered = !!(reg.mcpServers && (reg.mcpServers['make-app-context'] || reg.mcpServers['make-custom-app']));
	} catch {
		/* not registered */
	}

	if (!fs.existsSync(path.join(mcpDir, 'package.json'))) {
		add(
			'mcp-server',
			'optional-missing',
			`not installed at ${mcpDir}`,
			`Re-run the installer (it copies and builds mcp-server), or add an mcp-server-path: line to ${SECRETS_PATH}.`,
		);
	} else if (!fs.existsSync(dist)) {
		add('mcp-server', 'optional-missing', 'not built', `cd ${mcpDir} && npm install && npm run build`);
	} else if (!fs.existsSync(envFile)) {
		add(
			'mcp-server',
			'optional-missing',
			'.env missing',
			`cd ${mcpDir} && cp .env.example .env   # fill PINECONE_API_KEY, OPENAI_API_KEY, PINECONE_INDEX_NAME\nnpm run register                     # then restart the editor`,
		);
	} else if (!registered) {
		add(
			'mcp-server',
			'optional-missing',
			`built and configured but not registered in ${registryPath}`,
			`cd ${mcpDir} && npm run register   # then restart the editor`,
		);
	} else {
		add('mcp-server', 'ok', `registered (${registryPath})`);
	}
}

// 6. Legacy config still in SKILL.md (pre-2.0) — SKILL.md is loaded into the model every session
{
	const legacy = ['make-api-key', 'jira-api-token', 'jira-email', 'imt-app-runtime-path', 'make-apps-mockup-path', 'mcp-server-path', 'make-api-url', 'jira-base-url'].filter(skillMdHasConfig);
	if (legacy.length) {
		add(
			'legacy config in SKILL.md',
			'optional-missing',
			`still present in ${skillMd}: ${legacy.join(', ')} — SKILL.md is read by the AI agent every session`,
			`Move these lines to ${SECRETS_PATH} and delete them from SKILL.md (re-running the installer does this automatically):\n  ${legacy.map((k) => `${k}: …`).join('\n  ')}`,
		);
	}
}

const ok = items.every((i) => i.status !== 'missing');

if (args.has('--json')) {
	process.stdout.write(JSON.stringify({ ok, editor: editorDir, skillRoot, items }, null, 2) + '\n');
} else {
	const mark = { ok: 'OK      ', missing: 'MISSING ', 'optional-missing': 'OPTIONAL' };
	console.log(`make-custom-app setup — ${editorDir} — ${skillRoot}\n`);
	for (const i of items) console.log(`${mark[i.status]} ${i.key}: ${i.detail}`);
	const fixes = items.filter((i) => i.fix);
	if (fixes.length) {
		console.log('\nFixes:');
		for (const i of fixes) console.log(`\n[${i.status === 'missing' ? 'REQUIRED' : 'optional'}] ${i.key}\n${i.fix}`);
	}
	console.log(ok ? '\nSetup OK.' : '\nSetup INCOMPLETE — required items missing. Stop and apply the REQUIRED fixes above.');
}
process.exit(ok ? 0 : 1);
