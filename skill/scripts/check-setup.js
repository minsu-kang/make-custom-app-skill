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
const SETUP_CMD = `node ${path.join(skillRoot, 'scripts', 'setup-secrets.js')}`;
const SETUP_HINT = `Run this in your own terminal (do not run it via the agent — it is interactive and writes secrets):\n  ${SETUP_CMD}`;

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
			`${SETUP_HINT}\nThe wizard will ask you to clone integromat/imt-app-runtime and paste the local path.`,
		);
	} else if (!fs.existsSync(v)) {
		add(
			'imt-app-runtime-path',
			'missing',
			`path does not exist: ${v}`,
			`${SETUP_HINT}\nThe current imt-app-runtime-path does not exist on disk.`,
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
			`${SETUP_HINT}\nCreate a token at https://eu1.make.com/user/api (scopes: apps:read apps:write sdk-apps:read sdk-apps:write, plus any admin scope you have).`,
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
			`${SETUP_HINT}\nOptional — the wizard will ask you to clone make-apps-mockup and paste the local path.`,
		);
	} else if (!fs.existsSync(v)) {
		add('make-apps-mockup-path', 'optional-missing', `path does not exist: ${v}`, `${SETUP_HINT}\nThe current make-apps-mockup-path does not exist on disk.`);
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
			`${SETUP_HINT}\nOptional — create a token at https://id.atlassian.com/manage-profile/security/api-tokens. The wizard fills jira-email from GET /rest/api/3/myself.`,
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
			`Re-run the installer (it copies and builds mcp-server), or add an mcp-server-path: line via:\n  ${SETUP_CMD}`,
		);
	} else if (!fs.existsSync(dist)) {
		add('mcp-server', 'optional-missing', 'not built', `cd ${mcpDir} && npm install && npm run build`);
	} else if (!fs.existsSync(envFile)) {
		add(
			'mcp-server',
			'optional-missing',
			'.env missing',
			`${SETUP_HINT}\nThe wizard can write mcp-server/.env (PINECONE_API_KEY, PINECONE_INDEX_NAME, OPENAI_API_KEY), then:\n  cd ${mcpDir} && npm run register`,
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
			`Move these lines to ${SECRETS_PATH} (re-running the installer does this automatically) and delete them from SKILL.md:\n  ${legacy.map((k) => `${k}: …`).join('\n  ')}`,
		);
	}
}

const ok = items.every((i) => i.status !== 'missing');

if (args.has('--json')) {
	process.stdout.write(JSON.stringify({ ok, editor: editorDir, skillRoot, setupCommand: SETUP_CMD, items }, null, 2) + '\n');
} else {
	const mark = { ok: 'OK      ', missing: 'MISSING ', 'optional-missing': 'OPTIONAL' };
	console.log(`make-custom-app setup — ${editorDir} — ${skillRoot}\n`);
	for (const i of items) console.log(`${mark[i.status]} ${i.key}: ${i.detail}`);
	const fixes = items.filter((i) => i.fix);
	if (fixes.length) {
		console.log('\nFixes:');
		console.log(`\nInteractive wizard (your terminal, not the agent):\n  ${SETUP_CMD}`);
		for (const i of fixes) console.log(`\n[${i.status === 'missing' ? 'REQUIRED' : 'optional'}] ${i.key}\n${i.fix}`);
	}
	console.log(ok ? '\nSetup OK.' : '\nSetup INCOMPLETE — required items missing. Stop and apply the REQUIRED fixes above.');
}
process.exit(ok ? 0 : 1);
