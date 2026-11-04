#!/usr/bin/env node
/**
 * check-setup.js — one-screen diagnosis of the plugin's local setup.
 *
 * The agent runs this once per conversation; a non-zero exit means a REQUIRED item is
 * missing and work must stop until the printed fix is applied.
 *
 *   node check-setup.js                          human-readable report; the first line is MODE: employee, public or unknown
 *   node check-setup.js --json                   machine-readable report (with mode and zone)
 *   node check-setup.js --editor claude|cursor   (or --editor=cursor) when no editor variable is set and the secrets file has no editor: line
 *   node check-setup.js --skip-update-check      do not look for a newer version on master (also: MAKE_CUSTOM_APP_SKIP_UPDATE_CHECK set to any non-empty value)
 *
 * With a saved Make API token, every run checks it again (GET users/me, then the admin API probe of lib/mode.js) and
 * caches the mode for the entry scripts. Without a token it sends no request to Make.
 * Items in both modes: the Make API token and mode (required), make-team-id and mcp-server (optional).
 * Employee mode adds imt-app-runtime-path and make account (required) and make-apps-mockup-path (optional).
 *
 * Exit codes: 0 = every required item OK, 1 = a required item is missing (also a rejected token or a check that got
 * no answer) or the editor cannot be told.
 * Leftovers of an old 2.x install (a LEGACY_INSTALL warning) and a newer version on master (an UPDATE_AVAILABLE notice)
 * never change the exit code.
 * After the user declines the cleanup, OLD_INSTALL_KEPT replaces the LEGACY_INSTALL warning for 7 days.
 */
const fs = require('fs');
const os = require('os');
const { PLUGIN_ROOT, setupCommand } = require('./lib/paths');
const { readSkillConfig, readMakeCredentials, readClaudeHost, requireEditor, takeEditorFlagOrExit, SECRETS_PATH, CURSOR_SETTINGS_PATH } = require('./lib/settings');
const { isValidId } = require('./lib/run-component-logic');
const { checkAccess } = require('./lib/access-guard');
const { denyMessage, proxyEnv } = require('./lib/access-guard-logic');
const { detectMode, probeSync, saveVerdict } = require('./lib/mode');
const { verdictFrom, cursorAdminWarning } = require('./lib/mode-logic');
const { credentialItem, modeItem, reportedMode, modeLine } = require('./lib/check-setup-logic');
const { detectLegacyInstall, legacyInstallLines, keptInstallLines } = require('./lib/legacy-install');
const { readDecline, gatherFacts } = require('./lib/legacy-cleanup-steps');
const { buildPlan, declineState } = require('./lib/legacy-cleanup-logic');
const { checkForUpdate, installedVersion } = require('./lib/update-notice');

takeEditorFlagOrExit(process.argv);
const argv = process.argv.slice(2);
const editor = requireEditor();
const items = [];
const SETUP_CMD = setupCommand(editor);
const SETUP_HINT = `Run this in your own terminal (do not run it via the agent — it is interactive and writes secrets):\n  ${SETUP_CMD}`;

function add(key, status, detail, fix) {
	items.push({ key, status, detail, fix: fix || null });
}

function isPlaceholder(value, markers) {
	return !value || markers.some((m) => value.includes(m));
}

// imt-app-runtime-path (required, employee mode)
function checkRuntimePath() {
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

// make-apps-mockup-path (optional, employee mode — test-component.js)
function checkMockupPath() {
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

// Make account (required, employee mode): the Atlassian account behind the saved Jira token must be @make.com
function checkMakeAccount() {
	const access = checkAccess();
	if (access.ok) {
		add('make account', 'ok', access.email);
	} else {
		const [detail, ...fix] = denyMessage(access.code, { ...access, setupCommand: SETUP_CMD }).split('\n');
		add('make account', 'missing', detail, fix.length ? fix.join('\n') : null);
	}
}

// make-team-id (optional — default team for run-component.js)
function checkTeamId() {
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

// MCP server (optional — shared Pinecone context). The plugin's server is not recorded in ~/.claude.json or
// ~/.cursor/mcp.json, so registration cannot be checked. The server reads the two keys from the MAKE_APP_CONTEXT_*
// variables first and then from the secrets file; the index name has a default and is not required.
function checkMcpServer() {
	const keys = [
		{ key: 'pinecone-api-key', variable: 'MAKE_APP_CONTEXT_PINECONE_API_KEY' },
		{ key: 'openai-api-key', variable: 'MAKE_APP_CONTEXT_OPENAI_API_KEY' },
	];
	const missing = keys.filter(({ key, variable }) => !process.env[variable] && !readSkillConfig(key));
	if (missing.length === 0) {
		add(
			'mcp-server',
			'ok',
			`keys are set (environment or ${SECRETS_PATH}); cannot check whether the server is registered: plugin MCP servers are not listed in ~/.claude.json or ~/.cursor/mcp.json`,
		);
	} else {
		add(
			'mcp-server',
			'optional-missing',
			`missing: ${missing.map(({ key }) => key).join(', ')} (set ${missing.map(({ variable }) => variable).join(', ')} or the same key in ${SECRETS_PATH})`,
			`${SETUP_HINT}\nOptional — the wizard asks for the Pinecone and OpenAI keys of the shared app-context server and saves them in the secrets file.`,
		);
	}
}

/**
 * Checks the saved token and caches the verdict; null without a usable token. Node's fetch in this process ignores
 * HTTPS_PROXY unless NODE_USE_ENV_PROXY was set at start, so with a proxy the calls run in probeSync's child, which
 * honours it but returns no account name.
 */
async function probeToken(creds) {
	if (!creds.ok) return null;
	const result = proxyEnv(process.env).NODE_USE_ENV_PROXY ? probeSync(creds.host, creds.apikey) : await detectMode(creds.host, creds.apikey);
	const verdict = verdictFrom(result);
	saveVerdict(creds.host, creds.apikey, verdict);
	return { me: result.me, admin: result.admin, verdict };
}

const legacyInstall = detectLegacyInstall();
let declined = null;
try {
	const home = os.homedir();
	const marker = legacyInstall.length ? readDecline({ home }) : null;
	if (marker && declineState({ marker, digest: buildPlan(gatherFacts({ home, env: process.env, locate: false })).digest, now: Date.now() }) === 'fresh') declined = marker;
} catch {
	declined = null;
}
const skipUpdateCheck = argv.includes('--skip-update-check') || Boolean(process.env.MAKE_CUSTOM_APP_SKIP_UPDATE_CHECK);

async function main() {
	const creds = readMakeCredentials(editor);
	const [probe, update] = await Promise.all([probeToken(creds), skipUpdateCheck ? null : checkForUpdate({ editor, installed: installedVersion(PLUGIN_ROOT) })]);
	const mode = reportedMode(probe);
	const known = !creds.ok && editor === 'claude' && creds.reason === 'no-key' ? readClaudeHost() : null;
	items.push(credentialItem({ editor, creds, probe, tokenHost: known?.ok ? known.host : null, setupHint: SETUP_HINT, setupCommand: SETUP_CMD, cursorSettingsPath: CURSOR_SETTINGS_PATH }));
	items.push(modeItem({ creds, probe }));
	if (mode === 'employee') {
		checkRuntimePath();
		checkMockupPath();
		checkMakeAccount();
	}
	checkTeamId();
	checkMcpServer();
	const warning = cursorAdminWarning({ cursorAdmin: creds.ok ? creds.cursorAdmin : null, mode });
	const warnings = warning ? [warning] : [];
	const ok = items.every((i) => i.status !== 'missing');
	if (argv.includes('--json')) {
		const report = {
			ok,
			editor,
			mode,
			zone: creds.ok ? creds.host : null,
			pluginRoot: PLUGIN_ROOT,
			setupCommand: SETUP_CMD,
			items,
			warnings,
			legacyInstall,
			legacyDeclinedAt: declined ? new Date(declined.declinedAt).toISOString() : null,
		};
		report.update = update ? { installed: update.installed, available: update.available } : null;
		process.stdout.write(JSON.stringify(report, null, 2) + '\n');
	} else {
		const mark = { ok: 'OK      ', missing: 'MISSING ', 'optional-missing': 'OPTIONAL' };
		console.log(modeLine(mode));
		console.log(`make-custom-app setup — ${editor} — ${PLUGIN_ROOT}\n`);
		for (const i of items) console.log(`${mark[i.status]} ${i.key}: ${i.detail}`);
		if (warnings.length) console.log(`\n${warnings.join('\n')}`);
		const fixes = items.filter((i) => i.fix);
		if (fixes.length) {
			console.log('\nFixes:');
			console.log(`\nInteractive wizard (your terminal, not the agent):\n  ${SETUP_CMD}`);
			for (const i of fixes) console.log(`\n[${i.status === 'missing' ? 'REQUIRED' : 'optional'}] ${i.key}\n${i.fix}`);
		}
		const legacyWarning = declined ? keptInstallLines(legacyInstall) : legacyInstallLines(legacyInstall);
		if (legacyWarning.length) console.log(`\n${legacyWarning.join('\n')}`);
		if (update) console.log(`\n${update.lines.join('\n')}`);
		console.log(ok ? '\nSetup OK.' : '\nSetup INCOMPLETE — required items missing. Stop and apply the REQUIRED fixes above.');
	}
	process.exit(ok ? 0 : 1);
}

main();
