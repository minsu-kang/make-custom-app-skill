#!/usr/bin/env node
/**
 * check-setup.js — one-screen diagnosis of the plugin's local setup.
 *
 * The agent runs this once per conversation; a non-zero exit means a REQUIRED item is
 * missing and work must stop until the printed fix is applied.
 *
 *   node check-setup.js                          human-readable report
 *   node check-setup.js --json                   machine-readable report
 *   node check-setup.js --editor claude|cursor   (or --editor=cursor) when no editor variable is set and the secrets file has no editor: line
 *
 * Exit codes: 0 = every required item OK, 1 = a required item is missing or the editor cannot be told.
 * Leftovers of an old 2.x install (a LEGACY_INSTALL warning) never change the exit code.
 */
const fs = require('fs');
const { PLUGIN_ROOT, setupCommand } = require('./lib/paths');
const { readSkillConfig, requireEditor, takeEditorFlagOrExit, SECRETS_PATH, CURSOR_SETTINGS_PATH } = require('./lib/settings');
const { isValidId } = require('./lib/run-component-logic');
const { checkAccess } = require('./lib/access-guard');
const { denyMessage } = require('./lib/access-guard-logic');
const { detectLegacyInstall, legacyInstallLines } = require('./lib/legacy-install');

takeEditorFlagOrExit(process.argv);
const argv = process.argv.slice(2);
const editor = requireEditor();
const isClaude = editor === 'claude';
const items = [];
const SETUP_CMD = setupCommand(editor);
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
			`${SETUP_HINT}\nCreate a token at https://eu1.make.com/user/api (scopes: apps:read apps:write sdk-apps:read sdk-apps:write, plus any admin scope you have; for run-component.js also teams:read organizations:read imt-forms:read, plus connections:read user:read for components with a connection; optional endpoints:run credential-requests:write).`,
		);
	} else {
		add('make-api-key', 'ok', `set (${readSkillConfig('make-api-url') || 'https://eu1.make.com/api/v2/admin'})`);
	}
} else {
	let ok = false;
	try {
		const raw = fs
			.readFileSync(CURSOR_SETTINGS_PATH, 'utf-8')
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
			`apps-sdk.environments not found in ${CURSOR_SETTINGS_PATH}`,
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

// 4. Make account (required): the plugin is for Make employees; the Atlassian account behind the saved Jira token must be @make.com
{
	const access = checkAccess();
	if (access.ok) {
		add('make account', 'ok', access.email);
	} else {
		const [detail, ...fix] = denyMessage(access.code, { ...access, setupCommand: SETUP_CMD }).split('\n');
		add('make account', 'missing', detail, fix.length ? fix.join('\n') : null);
	}
}

// 4b. make-team-id (optional — default team for run-component.js)
{
	const v = readSkillConfig('make-team-id');
	if (!v) {
		add(
			'make-team-id',
			'optional-missing',
			'not set — run-component.js lists your teams once and --team=<id> --save-team stores one',
			`Optional — run-component.js lists your teams when none is set; then run it again with --team=<id> --save-team.\nOr add one line to ${SECRETS_PATH} (the team id is not a secret):\n  make-team-id: <team id>\n${SETUP_HINT}`,
		);
	} else if (!isValidId(v)) {
		add('make-team-id', 'optional-missing', `not a team id: ${v}`, `Use one positive integer, e.g.\n  make-team-id: 12345`);
	} else {
		add('make-team-id', 'ok', v);
	}
}

// 5. MCP server (optional — shared Pinecone context). The plugin's server is not recorded in
// ~/.claude.json or ~/.cursor/mcp.json, so only the keys it reads from the secrets file can be checked.
{
	const missing = ['pinecone-api-key', 'pinecone-index-name', 'openai-api-key'].filter((key) => !readSkillConfig(key));
	if (missing.length === 0) {
		add(
			'mcp-server',
			'ok',
			`keys are in ${SECRETS_PATH} (cannot check whether the server is registered: plugin MCP servers are not listed in ~/.claude.json or ~/.cursor/mcp.json)`,
		);
	} else {
		add(
			'mcp-server',
			'optional-missing',
			`missing in ${SECRETS_PATH}: ${missing.join(', ')}`,
			`${SETUP_HINT}\nOptional — the wizard asks for the Pinecone and OpenAI keys of the shared app-context server and saves them in the secrets file.`,
		);
	}
}

const ok = items.every((i) => i.status !== 'missing');
const legacyInstall = detectLegacyInstall();

if (argv.includes('--json')) {
	process.stdout.write(JSON.stringify({ ok, editor, pluginRoot: PLUGIN_ROOT, setupCommand: SETUP_CMD, items, legacyInstall }, null, 2) + '\n');
} else {
	const mark = { ok: 'OK      ', missing: 'MISSING ', 'optional-missing': 'OPTIONAL' };
	console.log(`make-custom-app setup — ${editor} — ${PLUGIN_ROOT}\n`);
	for (const i of items) console.log(`${mark[i.status]} ${i.key}: ${i.detail}`);
	const fixes = items.filter((i) => i.fix);
	if (fixes.length) {
		console.log('\nFixes:');
		console.log(`\nInteractive wizard (your terminal, not the agent):\n  ${SETUP_CMD}`);
		for (const i of fixes) console.log(`\n[${i.status === 'missing' ? 'REQUIRED' : 'optional'}] ${i.key}\n${i.fix}`);
	}
	const legacyWarning = legacyInstallLines(legacyInstall);
	if (legacyWarning.length) console.log(`\n${legacyWarning.join('\n')}`);
	console.log(ok ? '\nSetup OK.' : '\nSetup INCOMPLETE — required items missing. Stop and apply the REQUIRED fixes above.');
}
process.exit(ok ? 0 : 1);
