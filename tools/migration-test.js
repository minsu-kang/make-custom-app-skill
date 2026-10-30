#!/usr/bin/env node
'use strict';

// End-to-end test of the move from the 2.x skill to the plugin, with the real Claude Code CLI (no login, no model call).
//
//   node tools/migration-test.js [--keep] [--scenario=<name>]
//
// Each scenario gets a fresh throwaway HOME under os.tmpdir() and builds a 2.x install there with the real installers
// (install-claude.sh and install-cursor.sh from this checkout, with a stub npm), fake keys, a user paragraph in CLAUDE.md,
// another MCP server in each editor, app contexts, and a secrets file. Then it runs phase A (migrate-to-plugin.js of the
// installed old skill) and phase B (cleanup-legacy.js of the installed plugin) and checks the result. The plugin comes
// from a bare clone of this checkout that git serves under the real GitHub address (insteadOf), so nothing leaves the machine.
//
// It needs Claude Code's real layout (CLAUDE_CONFIG_DIR unset), so it refuses to run outside a container or CI.
// Docker command: see CLAUDE.md. The claude binary is $CLAUDE_BIN, or `claude` on the PATH. Keep os.tmpdir() on the disk of
// the container: on a slow bind mount the concurrent writer of the full scenario can undo every attempt to remove the entry.
// Output: PASS <scenario>: <check>, FAIL <scenario>: <check> (<detail>), SKIP <scenario>: <check> (<reason>), then the totals.
// A detail never holds a fake value. Exit codes: 0 all checks passed, 1 a check failed, 2 the tool cannot run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { FAKE, MARKETPLACE_URL, SCENARIOS, mayRun, snapshotTree, snapshotPaths, diffSnapshots, grepTree, buildEnv, fakeNamesIn, redactFakes } = require('./lib/migration-scenario');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN_ID = 'make-custom-app@make-custom-app';
const CONTAINER_TEXT = "migration-test: run this inside a container or in CI; it needs Claude Code's real layout under a throwaway HOME. See CLAUDE.md for the docker command.";
const NO_CLAUDE_TEXT = 'migration-test: claude was not found (set CLAUDE_BIN or put claude on PATH).';
const USAGE_TEXT = `migration-test: unknown argument or scenario. Usage: node tools/migration-test.js [--keep] [--scenario=<${SCENARIOS.join('|')}>]`;
const STEP_TIMEOUT_MS = 120000;
const PHASE_A_TIMEOUT_MS = 150000;
const BACKUP_NAME = /^migration-backup-/;
const ANSI = /\u001b\[[0-9;]*m/g;
const WRITER_MIN_REWRITES = 20;

// What install-claude.sh appends to ~/.claude/CLAUDE.md (F4), for a run where the installer did not write it.
const SENTINEL_BLOCK =
	'<!-- make-custom-app-skill -->\n# Make Custom App Skill\n\nWhen the conversation involves a Make.com custom app, IMLJSON, the Make Apps SDK, `make-app-contexts`, or an IEN Jira ticket about an app: invoke the `make-custom-app` skill before any other action and follow it. Do not answer from memory. Do not delegate this work to a sub-agent.\n<!-- /make-custom-app-skill -->';
const USER_PARAGRAPH = '# My notes\n\nKeep my answers short.';
const ENV_TEXT = `# Pinecone\nPINECONE_API_KEY=${FAKE.pinecone}\nPINECONE_INDEX_NAME=${FAKE.index}\n\n# OpenAI (for text-embedding-3-small)\nOPENAI_API_KEY=${FAKE.openai}\n`;
const OTHER_SERVER = { command: 'node', args: ['/opt/other.js'], env: { API_TOKEN: FAKE.otherToken } };
const OTHER_CURSOR = { command: 'node', args: ['/opt/other-cursor.js'], env: { TOKEN: FAKE.cursorToken } };
const FAKE_NPM = ['#!/bin/bash', 'if [ "${1:-}" = run ] && [ "${2:-}" = build ]; then mkdir -p dist && printf \'process.exit(0);\\n\' >dist/index.js; fi', 'exit 0', ''].join('\n');

// The paths of the old install that a run must not change (the contexts folders and the secrets file are checked on their own).
const OLD_INSTALL_PATHS = ['.claude/skills/make-custom-app', '.cursor/skills/make-custom-app', '.cursor/rules/make-custom-app', '.cursor/mcp.json', '.claude/CLAUDE.md'];

const OLDER = new Date('2026-01-01T00:00:00Z');
const NEWER = new Date('2026-02-01T00:00:00Z');
// Contexts of the old install. `copied` says whether phase A puts the file into ~/.make-custom-app/contexts (spec 8.4 item 5):
// context files and reviews, the newer copy of a file that both editors hold, and nothing of an org downloader folder.
const CONTEXT_SEEDS = [
	{ editor: 'claude', rel: 'shared-v1.md', text: 'shared context, Claude Code copy\n', mtime: OLDER, copied: false },
	{ editor: 'cursor', rel: 'shared-v1.md', text: 'shared context, Cursor copy\n', mtime: NEWER, copied: true },
	{ editor: 'claude', rel: 'alpha-v1.md', text: '## App Overview\n\n- slug: alpha\n', copied: true },
	{ editor: 'claude', rel: 'alpha-v1/metadata.json', text: '{"slug":"alpha","version":1}\n', copied: false },
	{ editor: 'claude', rel: 'alpha-v1/src/index.js', text: "'use strict';\n", copied: false },
	{ editor: 'claude', rel: 'alpha-v1/reviews/review-1.md', text: 'review one\n', copied: true },
	{ editor: 'claude', rel: 'alpha-v1/reviews/older/review-0.md', text: 'review zero\n', copied: true },
	{ editor: 'claude', rel: 'acme-v3.md', text: '## App Overview\n\n- slug: acme\n', copied: true },
	{ editor: 'claude', rel: 'acme-v3/metadata.json', text: '{"slug":"acme","snapshot":{"app":"acme"}}\n', copied: false },
	{ editor: 'claude', rel: 'acme-v3/reviews/review-9.md', text: 'partial review\n', copied: false },
	{ editor: 'claude', rel: 'notes.txt', text: 'not a context file\n', copied: false },
	{ editor: 'cursor', rel: 'beta-v2.md', text: '## App Overview\n\n- slug: beta\n', copied: true },
	{ editor: 'cursor', rel: 'beta-v2/metadata.json', text: '{"slug":"beta","version":2}\n', copied: false },
	{ editor: 'cursor', rel: 'beta-v2/reviews/review-3.md', text: 'review three\n', copied: true },
];

// Rewrites ~/.claude.json every 5 ms through a temp file and a rename, the way a running Claude Code keeps it (the loop of
// startWriter in shared/scripts/lib/__tests__/fake-legacy-home.js, counter mode). The read-modify-write is not synchronized,
// so a removal that lands between its read and its rename is undone; see applyUnderWriter.
const WRITER_SOURCE = `
const fs = require('fs');
const file = process.argv[1];
const temp = file + '.writer.tmp';
let writes = 0;
setInterval(() => {
	let data;
	let mode;
	try {
		data = JSON.parse(fs.readFileSync(file, 'utf8'));
		mode = fs.statSync(file).mode & 0o7777;
	} catch {
		return;
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
	data.writerCounter = writes + 1;
	try {
		fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\\n', { mode });
		fs.chmodSync(temp, mode);
		fs.renameSync(temp, file);
		writes += 1;
	} catch {}
}, 5);
`;

// Small utilities ---------------------------------------------------------------------------------------------------

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const exists = (file) => fs.existsSync(file);
const must = (condition, detail) => (condition ? null : detail);

function sleepMs(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readText(file) {
	return fs.readFileSync(file, 'utf8');
}

function readJson(file) {
	try {
		return JSON.parse(readText(file));
	} catch {
		return null;
	}
}

function modeOf(file) {
	return fs.statSync(file).mode & 0o777;
}

function writeFile(file, text, mode = 0o644) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	fs.chmodSync(file, mode);
}

function writeJson(file, value, mode) {
	writeFile(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
}

function sameJson(a, b) {
	return canonicalJson(a) === canonicalJson(b);
}

function serversOf(file) {
	const data = readJson(file);
	return data !== null && typeof data.mcpServers === 'object' && data.mcpServers !== null ? data.mcpServers : null;
}

function describeThrown(err) {
	const frame = String((err && err.stack) || '').match(/migration-test\.js:\d+/);
	const name = err && typeof err.name === 'string' ? err.name : 'Error';
	const code = err && typeof err.code === 'string' ? ` ${err.code}` : '';
	return `unexpected ${name}${code}${frame ? ` at ${frame[0]}` : ''}`;
}

/** The last line with a letter in it from a step's error output, else from its output, free of colors and fake values, for a failure detail. */
function lastLine(result) {
	const wordLines = (text) => text.replace(ANSI, '').split('\n').map((line) => line.trim()).filter((line) => /[A-Za-z]/.test(line));
	const errors = wordLines(result.stderr);
	const lines = errors.length > 0 ? errors : wordLines(result.stdout);
	return lines.length === 0 ? '' : redactFakes(lines[lines.length - 1]).slice(0, 200);
}

function expectExit(result, code) {
	if (result.status === code) return null;
	const ended = result.error !== null ? `error ${result.error}` : result.status === null ? `signal ${result.signal}` : `exit ${result.status}`;
	const line = lastLine(result);
	return `${ended}, expected ${code}${line === '' ? '' : `; last line: ${line}`}`;
}

// Processes ---------------------------------------------------------------------------------------------------------

/** Runs a command with the environment of the scenario; records its output for the check that no step prints a fake value. */
function exec(ctx, command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd || ctx.home,
		env: options.env || ctx.env,
		encoding: 'utf8',
		timeout: options.timeout || STEP_TIMEOUT_MS,
		maxBuffer: 64 * 1024 * 1024,
		killSignal: 'SIGKILL',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const run = {
		status: result.status,
		signal: result.signal,
		error: result.error ? result.error.code || result.error.name : null,
		stdout: result.stdout || '',
		stderr: result.stderr || '',
	};
	if (options.record !== false) ctx.outputs.push(run.stdout, run.stderr);
	return run;
}

function claude(ctx, args, options) {
	return exec(ctx, ctx.claudeBin, args, options);
}

function oldScript(ctx, editor, name) {
	return path.join(ctx.home, `.${editor}`, 'skills', 'make-custom-app', 'scripts', name);
}

function phaseA(ctx, { editor = 'claude', args = [], env } = {}) {
	return exec(ctx, process.execPath, [oldScript(ctx, editor, 'migrate-to-plugin.js'), '--skip-version', ...args], { env, timeout: PHASE_A_TIMEOUT_MS });
}

function oldCheckSetup(ctx, editor = 'claude') {
	return exec(ctx, process.execPath, [oldScript(ctx, editor, 'check-setup.js'), '--skip-version']);
}

function migrationState(result) {
	const line = result.stdout.split('\n').find((text) => text.startsWith('PLUGIN_MIGRATION: '));
	const match = line === undefined ? null : /^PLUGIN_MIGRATION: (\w+) \|/.exec(line);
	return match === null ? null : match[1];
}

function cleanup(ctx, installPath, args) {
	return exec(ctx, process.execPath, [path.join(installPath, 'shared', 'scripts', 'cleanup-legacy.js'), ...args, '--editor', 'claude']);
}

function pluginCheckSetup(ctx, installPath) {
	return exec(ctx, process.execPath, [path.join(installPath, 'shared', 'scripts', 'check-setup.js'), '--editor', 'claude', '--skip-update-check']);
}

/** The record of the plugin in `claude plugin list --json`, or null. */
function pluginEntry(ctx) {
	const result = claude(ctx, ['plugin', 'list', '--json']);
	if (result.status !== 0) return null;
	try {
		const list = JSON.parse(result.stdout);
		return Array.isArray(list) ? list.find((item) => item && item.id === PLUGIN_ID) || null : null;
	} catch {
		return null;
	}
}

function parsePlan(result) {
	if (result.status !== 0) return null;
	try {
		const plan = JSON.parse(result.stdout);
		return /^[0-9a-f]{16}$/.test(plan.digest) ? plan : null;
	} catch {
		return null;
	}
}

// The concurrent writer ---------------------------------------------------------------------------------------------

function startWriter(file) {
	const child = spawn(process.execPath, ['-e', WRITER_SOURCE, file], { stdio: 'ignore' });
	child.unref();
	const stop = () => {
		child.kill('SIGKILL');
		sleepMs(50);
	};
	process.once('exit', stop);
	return { stop };
}

function writerCounter(file) {
	const data = readJson(file);
	return data !== null && Number.isInteger(data.writerCounter) ? data.writerCounter : 0;
}

/**
 * Runs --apply while the writer rewrites ~/.claude.json. The writer can undo a removal, and the cleanup then stops with exit 4
 * and "restart Claude Code, then run the cleanup again". A single removal is not asserted (Ruling 29): the cleanup makes up to
 * three attempts per run, and the run is repeated once, so the entry has to go in one of six attempts.
 */
function applyUnderWriter(ctx, installPath, digest) {
	const writer = startWriter(ctx.paths.claudeJson);
	try {
		let result = cleanup(ctx, installPath, ['--apply', digest, '--groups', 'claude,cursor']);
		const back = () => {
			const servers = serversOf(ctx.paths.claudeJson);
			return servers !== null && Object.hasOwn(servers, 'make-custom-app');
		};
		if (result.status === 4 && back()) {
			ctx.note('the writer undid the removal in a whole run; running the cleanup again, as its message says');
			const plan = parsePlan(cleanup(ctx, installPath, ['--plan']));
			if (plan !== null) {
				result = cleanup(ctx, installPath, ['--apply', plan.digest, '--groups', 'claude,cursor']);
			}
		}
		return result;
	} finally {
		writer.stop();
	}
}

// Setup of a scenario -----------------------------------------------------------------------------------------------

function findClaude(env) {
	const usable = (file) => {
		try {
			fs.accessSync(file, fs.constants.X_OK);
			return fs.statSync(file).isFile();
		} catch {
			return false;
		}
	};
	if (typeof env.CLAUDE_BIN === 'string' && env.CLAUDE_BIN !== '') return path.isAbsolute(env.CLAUDE_BIN) && usable(env.CLAUDE_BIN) ? env.CLAUDE_BIN : null;
	for (const dir of String(env.PATH || '').split(path.delimiter)) {
		if (path.isAbsolute(dir) && usable(path.join(dir, 'claude'))) return path.join(dir, 'claude');
	}
	return null;
}

function parseArgs(argv) {
	const args = { keep: false, scenarios: SCENARIOS };
	let named = false;
	for (const arg of argv) {
		if (arg === '--keep') {
			args.keep = true;
		} else if (arg.startsWith('--scenario=') && !named && SCENARIOS.includes(arg.slice('--scenario='.length))) {
			args.scenarios = [arg.slice('--scenario='.length)];
			named = true;
		} else {
			return null;
		}
	}
	return args;
}

function gitStep(ctx, args, cwd) {
	const result = spawnSync('git', args, { cwd, env: { PATH: '/usr/bin:/bin', HOME: ctx.root }, encoding: 'utf8', timeout: STEP_TIMEOUT_MS });
	if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
	return (result.stdout || '').trim();
}

/** A bare clone of this checkout with refs/heads/master at HEAD and HEAD pointing at it, whatever the checkout has checked out. */
function makeBare(ctx) {
	const head = gitStep(ctx, ['rev-parse', 'HEAD'], ROOT);
	gitStep(ctx, ['clone', '--quiet', '--bare', ROOT, ctx.bare], ctx.root);
	gitStep(ctx, ['update-ref', 'refs/heads/master', head], ctx.bare);
	gitStep(ctx, ['symbolic-ref', 'HEAD', 'refs/heads/master'], ctx.bare);
	if (gitStep(ctx, ['rev-parse', 'HEAD'], ctx.bare) !== head || gitStep(ctx, ['symbolic-ref', '--short', 'HEAD'], ctx.bare) !== 'master') throw new Error('the bare clone is not at HEAD on master');
}

function runInstaller(ctx, editor) {
	const result = exec(ctx, '/bin/bash', [path.join(ROOT, `install-${editor}.sh`), '--update'], { record: false });
	const failure = expectExit(result, 0);
	if (failure !== null) throw new Error(`install-${editor}.sh: ${failure}`);
}

function ensureClaudeRegistration(ctx) {
	const servers = serversOf(ctx.paths.claudeJson);
	if (servers !== null && Object.hasOwn(servers, 'make-custom-app')) return;
	const data = readJson(ctx.paths.claudeJson) || {};
	data.mcpServers = { ...(data.mcpServers || {}), 'make-custom-app': registration(path.join(ctx.paths.claudeSkill, 'mcp-server', 'dist', 'index.js')) };
	writeJson(ctx.paths.claudeJson, data, 0o600);
	ctx.note('seeded the Claude registration in ~/.claude.json (the installer did not write it)');
}

function ensureCursorRegistration(ctx) {
	const servers = serversOf(ctx.paths.cursorMcp);
	if (servers !== null && Object.hasOwn(servers, 'make-app-context')) return;
	const data = readJson(ctx.paths.cursorMcp) || {};
	data.mcpServers = { ...(data.mcpServers || {}), 'make-app-context': registration(path.join(ctx.paths.cursorSkill, 'mcp-server', 'dist', 'index.js')) };
	writeJson(ctx.paths.cursorMcp, data, 0o600);
	ctx.note('seeded the Cursor registration in ~/.cursor/mcp.json (the installer did not write it)');
}

function registration(serverPath) {
	return { command: process.execPath, args: [serverPath], env: { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai, PINECONE_INDEX_NAME: FAKE.index } };
}

function ensureSentinel(ctx) {
	const text = exists(ctx.paths.claudeMd) ? readText(ctx.paths.claudeMd) : '';
	if (text.includes('<!-- make-custom-app-skill -->')) return text;
	const next = `${text === '' ? '' : `${text.replace(/\n*$/, '')}\n\n`}${SENTINEL_BLOCK}\n`;
	writeFile(ctx.paths.claudeMd, next, 0o644);
	ctx.note('seeded the sentinel block in ~/.claude/CLAUDE.md (the installer did not write it)');
	return next;
}

function ensureCursorRule(ctx) {
	const rule = path.join(ctx.paths.cursorRules, 'make-custom-app.mdc');
	if (exists(rule)) return;
	writeFile(rule, '---\ndescription: Make custom app skill\nalwaysApply: true\n---\n\nUse the make-custom-app skill for Make apps.\n');
	ctx.note('seeded the Cursor rule ~/.cursor/rules/make-custom-app/make-custom-app.mdc (the installer did not write it)');
}

function seedContexts(ctx) {
	const roots = { claude: ctx.paths.claudeContexts, cursor: ctx.paths.cursorContexts };
	for (const seed of CONTEXT_SEEDS) {
		const file = path.join(roots[seed.editor], seed.rel);
		writeFile(file, seed.text);
		if (seed.mtime) fs.utimesSync(file, seed.mtime, seed.mtime);
	}
}

/** The files phase A has to put into ~/.make-custom-app/contexts: rel -> text. */
function expectedContexts() {
	return new Map(CONTEXT_SEEDS.filter((seed) => seed.copied).map((seed) => [seed.rel, seed.text]));
}

function setupScenario(name, claudeBin) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `migration-test-${name}-`)));
	const home = path.join(root, 'home');
	const fakebin = path.join(root, 'fakebin');
	const bare = path.join(root, 'bare.git');
	for (const dir of [home, path.join(home, 'tmp'), fakebin]) fs.mkdirSync(dir, { recursive: true });
	writeFile(path.join(fakebin, 'npm'), FAKE_NPM, 0o755);
	const env = buildEnv({ home, fakebin, claudeDir: path.dirname(claudeBin), nodeDir: path.dirname(process.execPath), bare });
	const paths = {
		home,
		stateDir: path.join(home, '.make-custom-app'),
		targetContexts: path.join(home, '.make-custom-app', 'contexts'),
		secrets: path.join(home, '.make-custom-app-skill-secrets'),
		claudeJson: path.join(home, '.claude.json'),
		claudeMd: path.join(home, '.claude', 'CLAUDE.md'),
		claudeSkill: path.join(home, '.claude', 'skills', 'make-custom-app'),
		claudeContexts: path.join(home, '.claude', 'make-app-contexts'),
		cursorMcp: path.join(home, '.cursor', 'mcp.json'),
		cursorSkill: path.join(home, '.cursor', 'skills', 'make-custom-app'),
		cursorRules: path.join(home, '.cursor', 'rules', 'make-custom-app'),
		cursorContexts: path.join(home, '.cursor', 'make-app-contexts'),
		pluginRecords: path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
		marketplaceRecords: path.join(home, '.claude', 'plugins', 'known_marketplaces.json'),
	};
	return { name, root, home, bare, env, claudeBin, paths, outputs: [], note: () => {} };
}

/** The 2.x install of the scenario, built with the real installers. */
function buildOldInstall(ctx) {
	const { paths } = ctx;
	makeBare(ctx);
	runInstaller(ctx, 'claude');
	runInstaller(ctx, 'cursor');
	writeFile(path.join(paths.claudeSkill, 'mcp-server', '.env'), ENV_TEXT);
	writeFile(path.join(paths.cursorSkill, 'mcp-server', '.env'), ENV_TEXT);
	runInstaller(ctx, 'claude');
	runInstaller(ctx, 'cursor');
	for (const file of [path.join(paths.claudeSkill, 'SKILL.md'), path.join(paths.cursorSkill, 'SKILL.md'), path.join(paths.claudeSkill, 'mcp-server', '.env'), path.join(paths.cursorSkill, 'mcp-server', '.env')]) {
		if (!exists(file)) throw new Error('the installers left no old skill folder with its .env');
	}
	ensureClaudeRegistration(ctx);
	ensureCursorRegistration(ctx);
	const claudeText = ensureSentinel(ctx);
	ensureCursorRule(ctx);

	const claudeJson = readJson(paths.claudeJson);
	writeJson(paths.claudeJson, { ...claudeJson, mcpServers: { ...claudeJson.mcpServers, 'other-server': OTHER_SERVER } }, 0o600);
	const cursorJson = readJson(paths.cursorMcp);
	writeJson(paths.cursorMcp, { ...cursorJson, mcpServers: { ...cursorJson.mcpServers, 'other-cursor': OTHER_CURSOR } }, 0o600);
	writeFile(paths.claudeMd, `${USER_PARAGRAPH}\n\n${claudeText}`, 0o644);
	seedContexts(ctx);
	writeFile(paths.secrets, `pinecone-api-key: ${FAKE.conflictPinecone}\n`, 0o600);
}

// Snapshots and reads -----------------------------------------------------------------------------------------------

/** The old install paths of the home, and the mcpServers of ~/.claude.json as parsed JSON (claude writes the rest of that file). */
function oldInstallSnapshot(ctx) {
	const snapshot = snapshotPaths(ctx.home, OLD_INSTALL_PATHS);
	const servers = serversOf(ctx.paths.claudeJson);
	snapshot.set('.claude.json#mcpServers', { type: 'json', mode: null, sha256: sha256(servers === null ? 'unreadable' : canonicalJson(servers)), linkTarget: null });
	return snapshot;
}

function homeSnapshot(ctx) {
	return snapshotTree(ctx.home, { exclude: ['tmp'] });
}

function contextsSnapshot(ctx) {
	return snapshotPaths(ctx.home, ['.claude/make-app-contexts', '.cursor/make-app-contexts']);
}

function unchanged(before, after) {
	const lines = diffSnapshots(before, after);
	return lines.length === 0 ? null : `${lines.length} path(s) changed: ${lines.slice(0, 4).join('; ')}`;
}

function parseSecrets(file) {
	const secrets = new Map();
	for (const line of readText(file).split('\n')) {
		const match = /^([a-z0-9-]+):[ \t]*(.*)$/.exec(line);
		if (match !== null) secrets.set(match[1], match[2].trim());
	}
	return secrets;
}

function backupDirs(ctx) {
	return exists(ctx.paths.stateDir) ? fs.readdirSync(ctx.paths.stateDir).filter((name) => BACKUP_NAME.test(name)).sort().map((name) => path.join(ctx.paths.stateDir, name)) : [];
}

function filesBelow(dir) {
	const found = new Map();
	for (const [rel, entry] of snapshotTree(dir)) if (entry.type === 'file') found.set(rel, readText(path.join(dir, rel)));
	return found;
}

function contextsDetail(ctx) {
	const found = exists(ctx.paths.targetContexts) ? filesBelow(ctx.paths.targetContexts) : new Map();
	const expected = expectedContexts();
	const missing = [...expected.keys()].filter((rel) => !found.has(rel));
	const extra = [...found.keys()].filter((rel) => !expected.has(rel));
	const different = [...expected.keys()].filter((rel) => found.has(rel) && found.get(rel) !== expected.get(rel));
	if (missing.length + extra.length + different.length === 0) return null;
	return [missing.length > 0 ? `missing ${missing.join(', ')}` : '', extra.length > 0 ? `unexpected ${extra.join(', ')}` : '', different.length > 0 ? `different content ${different.join(', ')}` : ''].filter(Boolean).join('; ');
}

/** True for a file in a moved skill folder that is byte-identical to the file this repo ships: the old skill carries its own tests, and they spell the same fake values. */
function isShippedCopy(rel, file) {
	const match = /^(?:claude|cursor)\/skill-dir\/(.+)$/.exec(rel);
	if (match === null) return false;
	const sub = match[1];
	const source = sub.startsWith('mcp-server/') ? path.join(ROOT, 'mcp-server', sub.slice('mcp-server/'.length)) : path.join(ROOT, 'skill', sub);
	try {
		return fs.readFileSync(source).equals(fs.readFileSync(file));
	} catch {
		return false;
	}
}

function noFakeInOutput(ctx) {
	const names = fakeNamesIn(ctx.outputs.join('\n'));
	return names.length === 0 ? null : `the output of a step holds the fake value(s) ${names.join(', ')}`;
}

// Reporting ---------------------------------------------------------------------------------------------------------

function makeReporter(name, totals) {
	const say = (line) => process.stdout.write(`${line}\n`);
	return {
		say,
		check(label, fn) {
			let detail;
			try {
				detail = fn();
			} catch (err) {
				detail = describeThrown(err);
			}
			if (detail === null || detail === undefined) {
				totals.passed += 1;
				say(`PASS ${name}: ${label}`);
				return true;
			}
			totals.failed += 1;
			say(`FAIL ${name}: ${label} (${redactFakes(String(detail))})`);
			return false;
		},
		skip(label, reason) {
			say(`SKIP ${name}: ${label} (${reason})`);
		},
		note(text) {
			say(`NOTE ${name}: ${text}`);
		},
	};
}

// Shared steps of the scenarios -------------------------------------------------------------------------------------

/** Runs phase A from the Claude install and checks the exit code, the plugin record, and that the old install stayed as it was. Returns the plugin record or null. */
function migrateStep(ctx) {
	const before = oldInstallSnapshot(ctx);
	const contextsBefore = contextsSnapshot(ctx);
	const run = phaseA(ctx);
	if (!ctx.check('migrate-to-plugin.js --skip-version exits 0', () => expectExit(run, 0))) return null;
	const entry = pluginEntry(ctx);
	ctx.check(`claude plugin list --json shows make-custom-app ${ctx.pluginVersion}`, () => must(entry !== null && entry.version === ctx.pluginVersion, 'the plugin is not listed at that version'));
	ctx.check('phase A leaves the old install as it was', () => unchanged(before, oldInstallSnapshot(ctx)));
	ctx.check('phase A leaves both old contexts folders as they were', () => unchanged(contextsBefore, contextsSnapshot(ctx)));
	return { entry, run };
}

function secretsChecks(ctx) {
	const { secrets } = ctx.paths;
	ctx.check('the secrets file has openai-api-key and pinecone-index-name', () => {
		const values = parseSecrets(secrets);
		return must(values.get('openai-api-key') === FAKE.openai && values.get('pinecone-index-name') === FAKE.index, 'a key is missing or holds another value');
	});
	ctx.check('the secrets file keeps its own pinecone-api-key', () => must(parseSecrets(secrets).get('pinecone-api-key') === FAKE.conflictPinecone, 'the value changed'));
	ctx.check('the secrets file is 0600', () => must(modeOf(secrets) === 0o600, `mode is ${modeOf(secrets).toString(8)}`));
}

function contextsChecks(ctx, run) {
	ctx.check('the context files match spec 8.4 item 5', () => contextsDetail(ctx));
	if (run !== null) {
		ctx.check('phase A reports the org folder and the duplicate it did not copy', () =>
			must(run.stdout.includes('skipped acme-v3/') && run.stdout.includes('both editors had shared-v1.md: used the Cursor copy'), 'a note is missing from the summary'),
		);
	}
}

/** The install folder of the plugin record, after a check that it holds the cleanup script; null when the record names none. */
function installPathOf(ctx, entry) {
	const installPath = entry !== null && typeof entry.installPath === 'string' && entry.installPath !== '' ? entry.installPath : null;
	ctx.check('the plugin record names an install folder with cleanup-legacy.js', () => must(installPath !== null && exists(path.join(installPath, 'shared', 'scripts', 'cleanup-legacy.js')), 'no cleanup-legacy.js in it'));
	return installPath;
}

// Scenarios ---------------------------------------------------------------------------------------------------------

function scenarioFull(ctx) {
	const { paths } = ctx;
	ctx.check('the old check-setup prints PLUGIN_MIGRATION: ask', () => {
		const state = migrationState(oldCheckSetup(ctx));
		return must(state === 'ask', `it printed ${state === null ? 'no PLUGIN_MIGRATION line' : state}`);
	});
	const migrated = migrateStep(ctx);
	if (migrated === null) return;
	secretsChecks(ctx);
	ctx.check('no step output holds a fake value after phase A', () => noFakeInOutput(ctx));
	contextsChecks(ctx, migrated.run);

	for (const label of ['the old check-setup now prints PLUGIN_MIGRATION: handoff', 'the old check-setup prints PLUGIN_MIGRATION: handoff again on a second run']) {
		ctx.check(label, () => {
			const state = migrationState(oldCheckSetup(ctx));
			return must(state === 'handoff', `it printed ${state === null ? 'no PLUGIN_MIGRATION line' : state}`);
		});
	}
	const installPath = installPathOf(ctx, migrated.entry);
	if (installPath === null) return;
	ctx.check('the cached plugin check-setup prints LEGACY_INSTALL', () => must(/^LEGACY_INSTALL: /m.test(pluginCheckSetup(ctx, installPath).stdout), 'no LEGACY_INSTALL line'));

	const planRun = cleanup(ctx, installPath, ['--plan']);
	const plan = parsePlan(planRun);
	if (!ctx.check('cleanup-legacy.js --plan prints a digest', () => (plan === null ? expectExit(planRun, 0) || 'the output has no 16 character digest' : null))) return;
	ctx.check('the plan has ready items in the claude and cursor groups and no blocked or manual item', () => {
		const groups = plan.groups.map((group) => `${group.id} ${group.ready}/${group.blocked}/${group.manual}`);
		const sound = plan.groups.length === 2 && plan.groups.every((group) => ['claude', 'cursor'].includes(group.id) && group.ready > 0 && group.blocked === 0 && group.manual === 0);
		return must(sound, `groups (ready/blocked/manual): ${groups.join(', ')}`);
	});

	const before = oldInstallSnapshot(ctx);
	const applied = applyUnderWriter(ctx, installPath, plan.digest);
	ctx.check('cleanup-legacy.js --apply exits 0 while a writer rewrites ~/.claude.json', () => expectExit(applied, 0));
	ctx.check('the writer rewrote ~/.claude.json while the cleanup ran', () => must(writerCounter(paths.claudeJson) >= WRITER_MIN_REWRITES, `only ${writerCounter(paths.claudeJson)} rewrites`));
	if (applied.status !== 0) return;

	ctx.check('~/.claude.json parses, keeps other-server, and has no make-custom-app', () => {
		const servers = serversOf(paths.claudeJson);
		if (servers === null) return '~/.claude.json does not parse or has no mcpServers';
		return must(sameJson(servers['other-server'], OTHER_SERVER) && !Object.hasOwn(servers, 'make-custom-app'), `servers: ${Object.keys(servers).join(', ')}`);
	});
	ctx.check('~/.cursor/mcp.json is 0600, keeps other-cursor, and has no make-app-context', () => {
		const servers = serversOf(paths.cursorMcp);
		if (servers === null) return '~/.cursor/mcp.json does not parse or has no mcpServers';
		const mode = modeOf(paths.cursorMcp);
		return must(mode === 0o600 && sameJson(servers['other-cursor'], OTHER_CURSOR) && !Object.hasOwn(servers, 'make-app-context'), `mode ${mode.toString(8)}, servers: ${Object.keys(servers).join(', ')}`);
	});
	ctx.check('the sentinel block is gone and the user paragraph is byte-equal', () => must(readText(paths.claudeMd) === `${USER_PARAGRAPH}\n`, 'CLAUDE.md differs from the user paragraph'));
	ctx.check('the old skill folders and the Cursor rules left their places', () => must(!exists(paths.claudeSkill) && !exists(paths.cursorSkill) && !exists(paths.cursorRules), 'one of them is still there'));

	const backups = backupDirs(ctx);
	ctx.check('the backup folder is 0700 and its manifest is 0600', () =>
		must(backups.length > 0 && backups.every((dir) => modeOf(dir) === 0o700 && exists(path.join(dir, 'manifest.json')) && modeOf(path.join(dir, 'manifest.json')) === 0o600), `${backups.length} backup folder(s) or a mode differs`),
	);
	ctx.check('the migration backup holds no other-server or other-cursor token, and the pinecone key only in kept .env files and the manifest', () => {
		const hits = backups.flatMap((dir) => grepTree(dir, [FAKE.otherToken, FAKE.cursorToken, FAKE.pinecone]).filter((hit) => !isShippedCopy(hit.rel, path.join(dir, hit.rel))));
		const names = new Map(Object.entries(FAKE).map(([name, value]) => [value, name]));
		const wrong = hits.filter((hit) => hit.needle !== FAKE.pinecone || (hit.rel !== 'manifest.json' && path.posix.basename(hit.rel) !== '.env'));
		return must(wrong.length === 0, wrong.map((hit) => `${names.get(hit.needle)} in ${hit.rel}`).join('; '));
	});

	const restored = cleanup(ctx, installPath, ['--restore']);
	ctx.check('cleanup-legacy.js --restore exits 0', () => expectExit(restored, 0));
	ctx.check('the restore brings the pre-apply snapshot back, the .env modes included', () => unchanged(before, oldInstallSnapshot(ctx)));
	ctx.check('no step output holds a fake value', () => noFakeInOutput(ctx));
}

function scenarioHandInstalled(ctx) {
	const { paths } = ctx;
	if (!ctx.check('claude plugin marketplace add exits 0', () => expectExit(claude(ctx, ['plugin', 'marketplace', 'add', MARKETPLACE_URL]), 0))) return;
	if (!ctx.check('claude plugin install exits 0', () => expectExit(claude(ctx, ['plugin', 'install', PLUGIN_ID]), 0))) return;
	ctx.check('the old check-setup prints PLUGIN_MIGRATION: handoff', () => {
		const state = migrationState(oldCheckSetup(ctx));
		return must(state === 'handoff', `it printed ${state === null ? 'no PLUGIN_MIGRATION line' : state}`);
	});
	const listBefore = claude(ctx, ['plugin', 'list', '--json']).stdout;
	const recordsBefore = [paths.pluginRecords, paths.marketplaceRecords].map(readText);
	const before = oldInstallSnapshot(ctx);
	const run = phaseA(ctx, { args: ['--json'] });
	if (!ctx.check('migrate-to-plugin.js --skip-version exits 0', () => expectExit(run, 0))) return;
	ctx.check('phase A runs no marketplace add or install, and the plugin list is unchanged', () => {
		let report = null;
		try {
			report = JSON.parse(run.stdout);
		} catch {
			return 'the report is not JSON';
		}
		const same = claude(ctx, ['plugin', 'list', '--json']).stdout === listBefore && [paths.pluginRecords, paths.marketplaceRecords].every((file, i) => readText(file) === recordsBefore[i]);
		return must(report.marketplace.action === 'skipped' && report.plugin.action === 'present' && same, `marketplace ${report.marketplace.action}, plugin ${report.plugin.action}, list ${same ? 'unchanged' : 'changed'}`);
	});
	ctx.check('phase A leaves the old install as it was', () => unchanged(before, oldInstallSnapshot(ctx)));
	secretsChecks(ctx);
	contextsChecks(ctx, null);
	ctx.check('no step output holds a fake value', () => noFakeInOutput(ctx));
}

function scenarioDisabled(ctx) {
	const migrated = migrateStep(ctx);
	if (migrated === null) return;
	const installPath = installPathOf(ctx, migrated.entry);
	if (installPath === null) return;
	if (!ctx.check('claude plugin disable exits 0', () => expectExit(claude(ctx, ['plugin', 'disable', PLUGIN_ID]), 0))) return;
	const plan = parsePlan(cleanup(ctx, installPath, ['--plan']));
	if (!ctx.check('cleanup-legacy.js --plan prints a digest', () => must(plan !== null, 'no digest'))) return;
	const before = oldInstallSnapshot(ctx);
	const applied = cleanup(ctx, installPath, ['--apply', plan.digest, '--groups', 'claude,cursor']);
	ctx.check('cleanup-legacy.js --apply exits 2 for a disabled plugin', () => expectExit(applied, 2));
	ctx.check('the old install is unchanged and no backup folder exists', () => unchanged(before, oldInstallSnapshot(ctx)) || must(backupDirs(ctx).length === 0, 'a backup folder exists'));
}

function scenarioNoClaude(ctx) {
	const before = homeSnapshot(ctx);
	const missing = '/nonexistent/claude';
	for (const editor of ['claude', 'cursor']) {
		const run = phaseA(ctx, { editor, env: { ...ctx.env, CLAUDE_BIN: missing } });
		ctx.check(`phase A from the ${editor} install exits 5 and names CLAUDE_BIN`, () => expectExit(run, 5) || must(run.stdout === '' && run.stderr.includes(`CLAUDE_BIN is set to ${missing}, which is not an executable file. Nothing was changed.`), 'the message differs'));
	}
	ctx.check('nothing in the home changed', () => unchanged(before, homeSnapshot(ctx)));

	// With CLAUDE_BIN set the script names the variable. The texts for a machine without claude need a search that finds nothing,
	// which is only so when no usual install folder holds one: --dry-run changes nothing either way.
	const env = { ...ctx.env, PATH: [path.join(ctx.root, 'fakebin'), '/usr/bin', '/bin'].join(path.delimiter) };
	const texts = {
		claude: [`  /plugin marketplace add ${MARKETPLACE_URL}`, `  /plugin install ${PLUGIN_ID}`],
		cursor: ['Installing the make-custom-app plugin for Cursor alone is not supported yet.'],
	};
	for (const editor of ['claude', 'cursor']) {
		const label = `phase A finds no claude from the ${editor} install and prints its own text`;
		const run = phaseA(ctx, { editor, args: ['--dry-run'], env });
		if (run.status === 0) {
			ctx.skip(label, 'a claude exists in a usual install folder');
			continue;
		}
		ctx.check(label, () => expectExit(run, 5) || must(run.stdout === '' && texts[editor].every((text) => run.stderr.includes(text)), 'the text differs'));
	}
	ctx.check('nothing in the home changed after the searches', () => unchanged(before, homeSnapshot(ctx)));
}

function scenarioEditedSentinel(ctx) {
	const { paths } = ctx;
	const migrated = migrateStep(ctx);
	if (migrated === null) return;
	const installPath = installPathOf(ctx, migrated.entry);
	if (installPath === null) return;
	const plan = parsePlan(cleanup(ctx, installPath, ['--plan']));
	if (!ctx.check('cleanup-legacy.js --plan prints a digest', () => must(plan !== null, 'no digest'))) return;
	const original = readText(paths.claudeMd);
	const edited = original.replace('Do not delegate this work to a sub-agent.', 'Do not delegate this work to a sub-agent, ever.');
	if (!ctx.check('the text inside the sentinel block can be edited', () => must(edited !== original, 'the block text was not found'))) return;
	writeFile(paths.claudeMd, edited, modeOf(paths.claudeMd));
	const before = oldInstallSnapshot(ctx);
	const applied = cleanup(ctx, installPath, ['--apply', plan.digest, '--groups', 'claude,cursor']);
	ctx.check('cleanup-legacy.js --apply exits 3 after the block was edited', () => expectExit(applied, 3));
	ctx.check('nothing else changed and no backup folder exists', () => unchanged(before, oldInstallSnapshot(ctx)) || must(backupDirs(ctx).length === 0, 'a backup folder exists'));
}

function scenarioRerunA(ctx) {
	const { paths } = ctx;
	const first = phaseA(ctx);
	if (!ctx.check('the first migrate-to-plugin.js --skip-version exits 0', () => expectExit(first, 0))) return;
	const contextsBefore = snapshotTree(paths.targetContexts);
	const secretsBefore = readText(paths.secrets);
	const second = phaseA(ctx, { args: ['--json'] });
	if (!ctx.check('the second migrate-to-plugin.js --skip-version exits 0', () => expectExit(second, 0))) return;
	ctx.check('the second run copies nothing', () => {
		let report = null;
		try {
			report = JSON.parse(second.stdout);
		} catch {
			return 'the report is not JSON';
		}
		return must(report.contexts.copied === 0 && report.secrets.copied.length === 0 && report.plugin.action === 'present', `contexts copied ${report.contexts.copied}, keys copied ${report.secrets.copied.length}, plugin ${report.plugin.action}`);
	});
	ctx.check('no file in ~/.make-custom-app/contexts changed', () => unchanged(contextsBefore, snapshotTree(paths.targetContexts)));
	ctx.check('the secrets file did not change', () => must(readText(paths.secrets) === secretsBefore && modeOf(paths.secrets) === 0o600, 'its text or mode changed'));
}

const RUNNERS = {
	full: scenarioFull,
	'hand-installed': scenarioHandInstalled,
	disabled: scenarioDisabled,
	'no-claude': scenarioNoClaude,
	'edited-sentinel': scenarioEditedSentinel,
	'rerun-a': scenarioRerunA,
};

// Main --------------------------------------------------------------------------------------------------------------

function pluginVersionOfCheckout() {
	return readJson(path.join(ROOT, '.claude-plugin', 'plugin.json')).version;
}

function runScenario(name, { claudeBin, keep, totals }) {
	const reporter = makeReporter(name, totals);
	let ctx = null;
	try {
		ctx = setupScenario(name, claudeBin);
		Object.assign(ctx, reporter, { pluginVersion: pluginVersionOfCheckout() });
		buildOldInstall(ctx);
	} catch (err) {
		reporter.check('setup', () => `${describeThrown(err)}: ${redactFakes(String((err && err.message) || ''))}`.slice(0, 300));
		return cleanScenario(ctx, keep, reporter);
	}
	try {
		RUNNERS[name](ctx);
	} catch (err) {
		reporter.check('the scenario runs to its end', () => describeThrown(err));
	}
	return cleanScenario(ctx, keep, reporter);
}

function cleanScenario(ctx, keep, reporter) {
	if (ctx === null) return;
	if (keep) {
		reporter.say(`kept ${ctx.name}: ${ctx.root}`);
	} else if (path.basename(ctx.root).startsWith('migration-test-') && ctx.root.startsWith(fs.realpathSync(os.tmpdir()))) {
		fs.rmSync(ctx.root, { recursive: true, force: true });
	}
}

function main(argv, env) {
	if (!mayRun({ env, exists })) {
		process.stderr.write(`${CONTAINER_TEXT}\n`);
		return 2;
	}
	const args = parseArgs(argv);
	if (args === null) {
		process.stderr.write(`${USAGE_TEXT}\n`);
		return 2;
	}
	const claudeBin = findClaude(env);
	if (claudeBin === null) {
		process.stderr.write(`${NO_CLAUDE_TEXT}\n`);
		return 2;
	}
	const totals = { passed: 0, failed: 0 };
	for (const name of args.scenarios) runScenario(name, { claudeBin, keep: args.keep, totals });
	process.stdout.write(`migration-test: ${totals.passed} passed, ${totals.failed} failed\n`);
	return exitCodeFor(totals);
}

/** 0 when checks ran and none failed; a run that checked nothing is no success. */
function exitCodeFor(totals) {
	return totals.failed === 0 && totals.passed > 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2), process.env);

module.exports = { parseArgs, findClaude, exitCodeFor };
