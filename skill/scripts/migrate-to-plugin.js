#!/usr/bin/env node
/**
 * migrate-to-plugin.js: phase A of the move from this skill to the make-custom-app plugin.
 *
 * Installs the plugin through the claude CLI when it is not installed, then copies the MCP keys into
 * ~/.make-custom-app-skill-secrets and the app contexts into ~/.make-custom-app/contexts. It asks nothing, reads no
 * standard input, and deletes none of your files (it removes only its own throttle file, a stale lock, and its own temp
 * files): the old skill keeps working until the cleanup of the plugin.
 *
 *   node migrate-to-plugin.js                  run
 *   node migrate-to-plugin.js --dry-run        print the plan; writes nothing
 *   node migrate-to-plugin.js --json           print one JSON report instead of the summary
 *   node migrate-to-plugin.js --timeout <s>    seconds for one claude call (5 to 600, default 75)
 *   node migrate-to-plugin.js --skip-version   skip the version check of this skill
 *
 * --timeout accepts up to 600, but the 110 second deadline of the whole run (it starts before the version check)
 * caps every call. A claude that does not finish is killed with SIGKILL; its own children (for example the git clone
 * of the marketplace add) can survive, because spawnSync has no process group kill.
 *
 * Exit codes: 0 done (also when the plugin was already installed, or is disabled and reported), 1 the install or its
 * check failed or an unexpected error, 2 usage, 3 this skill was just updated (run again), 4 the plugin is installed but
 * a copy failed or the lock was held, 5 the plugin is not installed and Claude Code was not found.
 * Every decision lives in lib/migrate-logic.js; this file does the I/O.
 */
const nodeFs = require('fs');
const nodeOs = require('os');
const path = require('path');
const childProcess = require('child_process');
const {
	PLUGIN_ID,
	MARKETPLACE_NAME,
	MARKETPLACE_URL,
	CLAUDE_VERSION_PATTERN,
	requireParams,
	parseArgs,
	readPluginStatus,
	findClaudeBinary,
	spawnSpec,
	parseMarketplaceList,
	verifyInstall,
	acquireMigrationLock,
	readSecretSources,
	planSecrets,
	secretsValue,
	listContextFiles,
	planContexts,
	sameContent,
	applyContextCopies,
	summaryLines,
	jsonReport,
	throttleFile,
	removeThrottle,
	describeError,
} = require('./lib/migrate-logic');
const { getEditorDir } = require('./lib/skill-root');
const { upsertSecretsFile } = require('./lib/secrets-file');

const USAGE = 'Usage: node migrate-to-plugin.js [--dry-run] [--json] [--timeout <seconds>] [--skip-version]';
const DEADLINE_MS = 110000;
const VERSION_TIMEOUT_MS = 10000;
const LIST_TIMEOUT_MS = 30000;
const NODE_FLOOR = 20;
const SECRETS_NAME = '.make-custom-app-skill-secrets';
const WOULD_COPY = 'Dry run: would copy MCP keys and app contexts; nothing else would change.';
const RETRY_LINE = 'The plugin is installed, but some files could not be copied (see above). Run this script again to retry the copies; nothing is copied twice.';
const NOT_FOUND = 'Claude Code was not found (looked at CLAUDE_BIN, the PATH, and the usual install folders).';
const MANUAL_STEPS = `Run these in your own terminal, then run this script again:\n  claude plugin marketplace add ${MARKETPLACE_URL}\n  claude plugin install ${PLUGIN_ID}`;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const URL_USERINFO = /\/\/[^/\s@]*@/g;
const MISSING_TARGET = { exists: false, isFile: false, same: false, parentIsFile: false };
const BLOCKED_TARGET = { exists: true, isFile: false, same: false, parentIsFile: true };
const NO_CONTEXTS = { files: [], orgSkipped: [], symlinks: [] };

function oneLine(value, max = 500) {
	return String(value).replace(URL_USERINFO, '//').replace(CONTROL_CHARACTERS, '?').slice(0, max);
}

function firstLineOf(text) {
	return String(text || '').split(/\r?\n/)[0].trim();
}

function firstFilledLine(text) {
	const line = String(text || '')
		.split(/\r?\n/)
		.map((item) => item.trim())
		.find((item) => item !== '');
	return line === undefined ? '' : oneLine(line, 200);
}

function isFileError(err) {
	return err instanceof SyntaxError || (typeof err === 'object' && err !== null && typeof err.code === 'string');
}

function union(a, b) {
	return [...new Set([...a, ...b])].sort();
}

function runVersionGuard() {
	require('./lib/version-guard').ensureFreshSkill({ access: false });
}

function newReport(editor, dryRun) {
	return {
		ok: false,
		exitCode: 1,
		editor,
		dryRun,
		claude: { bin: null, version: null },
		marketplace: { action: 'skipped', source: null },
		plugin: { action: 'skipped', version: null, problems: [] },
		lock: { held: false, pid: null },
		secrets: { copied: [], keptExisting: [], conflicts: [], skipped: [], error: null },
		contexts: { copied: 0, alreadyPresent: 0, keptExisting: [], orgSkipped: [], duplicates: [], symlinks: [], errors: [] },
	};
}

function finish(r, code, extra = []) {
	const { c, args, report } = r;
	report.ok = code === 0;
	report.exitCode = code;
	if (code === 0 && !args.dryRun) removeThrottle({ file: throttleFile({ tmpdir: c.tmpdir, platform: c.platform, uid: c.uid, username: c.username }), fs: c.fs });
	if (args.json) {
		c.stdout(`${JSON.stringify(jsonReport(report), null, 2)}\n`);
		return code;
	}
	const lines = args.dryRun ? extra : [...summaryLines(report), ...extra];
	if (lines.length > 0) c.stdout(`${lines.join('\n')}\n`);
	return code;
}

function claudeCall(r, bin, args, step, limitMs) {
	const { c } = r;
	const remaining = DEADLINE_MS - (c.now() - r.start);
	if (remaining <= 0) return { ok: false, stdout: '', reason: `claude did not finish within ${DEADLINE_MS / 1000} seconds (${step})` };
	const timeoutMs = Math.min(limitMs, r.args.timeoutSec * 1000, remaining);
	const spec = spawnSpec({ bin, args, platform: c.platform, env: c.env, home: c.home, timeoutMs });
	const result = c.spawn(spec.command, spec.args, { ...spec.options, killSignal: 'SIGKILL' });
	const stdout = typeof result.stdout === 'string' ? result.stdout : '';
	if (result.error) {
		const timedOut = result.error.code === 'ETIMEDOUT';
		return { ok: false, stdout, reason: timedOut ? `claude did not finish within ${Math.ceil(timeoutMs / 1000)} seconds (${step})` : describeError(result.error, bin) };
	}
	if (result.status === 0) return { ok: true, stdout, reason: null };
	const line = firstFilledLine(result.stderr);
	const ended = result.status === null ? `signal ${result.signal}` : `code ${result.status}`;
	return { ok: false, stdout, reason: line === '' ? `claude exited with ${ended} (${step})` : line };
}

function noClaude(r, found) {
	const { c, report } = r;
	if (found.explicit) {
		c.stderr(`CLAUDE_BIN is set to ${oneLine(c.env.CLAUDE_BIN)}, which is not an executable file. Nothing was changed.\n`);
	} else if (report.editor === 'cursor') {
		c.stderr(
			`${NOT_FOUND}\nInstalling the make-custom-app plugin for Cursor alone is not supported yet. This skill keeps working; nothing was changed.\nIf Claude Code is installed in another folder, run this script again with CLAUDE_BIN set to its path.\n`,
		);
	} else {
		c.stderr(`${NOT_FOUND} Nothing was changed. In Claude Code, run these two commands, then restart Claude Code:\n  /plugin marketplace add ${MARKETPLACE_URL}\n  /plugin install ${PLUGIN_ID}\n`);
	}
	return finish(r, 5);
}

function installFailed(r, reason) {
	r.c.stderr(`Could not install the plugin: ${reason}\nclaude --version reported: ${r.report.claude.version}\n${MANUAL_STEPS}\n`);
	return finish(r, 1);
}

// Returns the exit code when the run ends here, or null once the plugin is installed.
function installPlugin(r) {
	const { c, args, report } = r;
	const found = findClaudeBinary({ env: c.env, home: c.home, platform: c.platform, isExecutable: c.isExecutable });
	if (found.bin === null) return noClaude(r, found);
	const bin = found.bin;
	report.claude.bin = bin;
	const versionLine = firstLineOf(claudeCall(r, bin, ['--version'], 'claude --version', VERSION_TIMEOUT_MS).stdout);
	if (!CLAUDE_VERSION_PATTERN.test(versionLine)) {
		c.stderr(`${oneLine(bin)} is not Claude Code (claude --version printed "${oneLine(versionLine, 80)}"). Nothing was changed. Set CLAUDE_BIN to the claude binary of Claude Code and run this script again.\n`);
		return finish(r, 5);
	}
	report.claude.version = oneLine(versionLine);

	const list = claudeCall(r, bin, ['plugin', 'marketplace', 'list', '--json'], 'marketplace list', LIST_TIMEOUT_MS);
	if (!list.ok) {
		report.marketplace.action = 'failed';
		return installFailed(r, list.reason);
	}
	const known = parseMarketplaceList(list.stdout).find((entry) => entry.name === MARKETPLACE_NAME);
	if (known !== undefined) report.marketplace = { action: 'present', source: known.source };
	if (args.dryRun) {
		const present = `Dry run: the marketplace ${MARKETPLACE_NAME} is present${known !== undefined && known.source !== null ? ` (${oneLine(known.source)})` : ''}`;
		return finish(r, 0, [known === undefined ? `Dry run: would add the marketplace ${MARKETPLACE_URL}` : present, `Dry run: would install ${PLUGIN_ID}`, WOULD_COPY]);
	}
	if (known === undefined) {
		const add = claudeCall(r, bin, ['plugin', 'marketplace', 'add', MARKETPLACE_URL], 'marketplace add', Infinity);
		if (!add.ok) {
			report.marketplace.action = 'failed';
			return installFailed(r, add.reason);
		}
		report.marketplace = { action: 'added', source: MARKETPLACE_URL };
	}
	const install = claudeCall(r, bin, ['plugin', 'install', PLUGIN_ID], 'plugin install', Infinity);
	if (!install.ok) {
		report.plugin.action = 'failed';
		return installFailed(r, install.reason);
	}
	return null;
}

// Returns the exit code when the check fails, or null.
function verify(r, installedNow) {
	const { c, report } = r;
	const status = readPluginStatus({ env: c.env, home: c.home, fs: c.fs });
	let manifestText;
	if (typeof status.installPath === 'string') {
		try {
			manifestText = c.fs.readFileSync(path.join(status.installPath, '.claude-plugin', 'plugin.json'), 'utf8');
		} catch {
			manifestText = undefined;
		}
	}
	const exists = (file) => {
		try {
			return c.fs.statSync(file).isFile();
		} catch {
			return false;
		}
	};
	const problems = verifyInstall({ status, manifestText, exists }).map((problem) => oneLine(problem));
	if (problems.length > 0) {
		report.plugin = { action: 'failed', version: status.version, problems };
		for (const problem of problems) c.stderr(`The plugin install could not be verified: ${problem}\n`);
		return finish(r, 1);
	}
	report.plugin = { action: status.status === 'inactive' ? 'disabled' : installedNow ? 'installed' : 'present', version: status.version, problems: [] };
	return null;
}

function readExisting(fs, file) {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch (err) {
		if (err && err.code === 'ENOENT') return '';
		throw err;
	}
}

// Returns true when the keys were not copied completely.
function copySecrets(r) {
	const { c, report } = r;
	const file = path.join(c.home, SECRETS_NAME);
	const problems = [];
	try {
		const existing = readExisting(c.fs, file);
		const found = readSecretSources({ home: c.home, fs: c.fs, mcpServerPath: secretsValue(existing, 'mcp-server-path') });
		problems.push(...found.errors);
		const plan = planSecrets({ sources: found.sources, existingText: existing });
		report.secrets.keptExisting = plan.keptExisting;
		report.secrets.conflicts = plan.conflicts;
		report.secrets.skipped = plan.skipped;
		const keys = Object.keys(plan.updates);
		let mismatched = [];
		if (keys.length > 0) {
			c.upsertSecrets(file, plan.updates);
			const after = readExisting(c.fs, file);
			mismatched = keys.filter((key) => secretsValue(after, key) !== plan.updates[key]);
			if (mismatched.length > 0) problems.push(`read-back mismatch: ${mismatched.join(', ')}`);
		}
		report.secrets.copied = plan.copied.filter((key) => !mismatched.includes(key));
	} catch (err) {
		if (!isFileError(err)) throw err;
		problems.push(describeError(err, file));
	}
	report.secrets.error = problems.length > 0 ? problems.join('; ') : null;
	return problems.length > 0;
}

function contextTarget(fs, targetRoot) {
	const inspect = (file, follow) => {
		try {
			return follow ? fs.statSync(file) : fs.lstatSync(file);
		} catch (err) {
			if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
			throw err;
		}
	};
	return (rel, source) => {
		const segments = rel.split('/');
		let current = targetRoot;
		for (const segment of segments) {
			const stat = inspect(current, current === targetRoot);
			if (stat === null) return MISSING_TARGET;
			if (!stat.isDirectory()) return BLOCKED_TARGET;
			current = path.join(current, segment);
		}
		const leaf = inspect(current, false);
		if (leaf === null) return MISSING_TARGET;
		const isFile = leaf.isFile();
		return { exists: true, isFile, same: isFile && sameContent({ a: source.src, b: current, fs }), parentIsFile: false };
	};
}

function errorEntry(rel, err) {
	return { rel, code: typeof err.code === 'string' ? err.code : 'UNKNOWN' };
}

// Returns true when a listing, a check, or a copy failed.
function copyContexts(r) {
	const { c, report } = r;
	const roots = { claude: path.join(c.home, '.claude', 'make-app-contexts'), cursor: path.join(c.home, '.cursor', 'make-app-contexts') };
	const targetRoot = path.join(c.home, '.make-custom-app', 'contexts');
	const listings = {};
	const errors = [];
	for (const [editor, root] of Object.entries(roots)) {
		try {
			listings[editor] = listContextFiles({ root, fs: c.fs });
		} catch (err) {
			if (!isFileError(err)) throw err;
			c.stderr(`Could not read the app contexts: ${describeError(err, root)}\n`);
			listings[editor] = NO_CONTEXTS;
			errors.push(errorEntry(root, err));
		}
	}
	report.contexts.orgSkipped = union(listings.claude.orgSkipped, listings.cursor.orgSkipped);
	report.contexts.symlinks = union(listings.claude.symlinks, listings.cursor.symlinks);
	try {
		const plan = planContexts({ claude: listings.claude, cursor: listings.cursor, target: contextTarget(c.fs, targetRoot), fs: c.fs });
		const applied = applyContextCopies({ plan, targetRoot, fs: c.fs });
		report.contexts.copied = applied.copied;
		report.contexts.alreadyPresent = plan.alreadyPresent;
		report.contexts.keptExisting = plan.keptExisting;
		report.contexts.duplicates = plan.duplicates;
		errors.push(...applied.errors, ...plan.blocked.map((rel) => ({ rel, code: 'ENOTDIR' })));
	} catch (err) {
		if (!isFileError(err)) throw err;
		c.stderr(`Could not check the app contexts: ${describeError(err, targetRoot)}\n`);
		errors.push(errorEntry(targetRoot, err));
	}
	report.contexts.errors = errors;
	return errors.length > 0;
}

// Takes the lock, copies the keys and the contexts, and releases the lock. Returns { failed, held }.
function copyPhase(r) {
	const { c, report } = r;
	const lockPath = path.join(c.home, '.make-custom-app', 'cleanup.lock');
	let lock;
	try {
		lock = acquireMigrationLock({ home: c.home, fs: c.fs });
	} catch (err) {
		if (!isFileError(err)) throw err;
		report.secrets.error = describeError(err, lockPath);
		return { failed: true, held: false };
	}
	if (!lock.ok) {
		report.lock = { held: true, pid: lock.pid };
		return { failed: true, held: true };
	}
	try {
		const secretsFailed = copySecrets(r);
		const contextsFailed = copyContexts(r);
		return { failed: secretsFailed || contextsFailed, held: false };
	} finally {
		lock.release();
	}
}

function run(c, start) {
	const args = parseArgs(c.argv);
	if (args.error !== null) {
		c.stderr(`${args.error}\n${USAGE}\n`);
		return 2;
	}
	if (!args.skipVersion) c.versionGuard();
	if (Number(String(c.nodeVersion).split('.')[0]) < NODE_FLOOR) {
		c.stderr(`Warning: Node ${c.nodeVersion} is older than ${NODE_FLOOR}; the plugin's MCP server is built for Node ${NODE_FLOOR} or newer.\n`);
	}
	const r = { c, args, start, report: newReport(c.editorDir === '.claude' ? 'claude' : 'cursor', args.dryRun) };

	const found = readPluginStatus({ env: c.env, home: c.home, fs: c.fs });
	const needsInstall = found.status === 'absent';
	if (needsInstall) {
		const ended = installPlugin(r);
		if (ended !== null) return ended;
	} else if (args.dryRun) {
		r.report.plugin = { action: 'present', version: found.version, problems: [] };
		const version = found.version === null ? '' : ` (version ${oneLine(found.version)})`;
		return finish(r, 0, [`Dry run: the plugin is installed${version}; nothing would be installed.`, WOULD_COPY]);
	}
	const rejected = verify(r, needsInstall);
	if (rejected !== null) return rejected;

	const copied = copyPhase(r);
	if (copied.failed) return finish(r, 4, copied.held ? [] : [RETRY_LINE]);
	return finish(r, 0);
}

function main(options) {
	requireParams('main', options, ['argv', 'env', 'home', 'tmpdir', 'platform', 'editorDir']);
	const c = {
		argv: options.argv,
		env: options.env,
		home: options.home,
		tmpdir: options.tmpdir,
		platform: options.platform,
		editorDir: options.editorDir,
		uid: options.uid,
		username: options.username,
		isExecutable: options.isExecutable,
		nodeVersion: options.nodeVersion || process.versions.node,
		stdout: options.stdout || ((text) => process.stdout.write(text)),
		stderr: options.stderr || ((text) => process.stderr.write(text)),
		versionGuard: options.versionGuard || runVersionGuard,
		fs: options.fs || nodeFs,
		spawn: options.spawn || childProcess.spawnSync,
		now: options.now || Date.now,
		upsertSecrets: options.upsertSecrets || upsertSecretsFile,
	};
	const start = c.now();
	try {
		return run(c, start);
	} catch (err) {
		c.stderr(`migrate-to-plugin: unexpected error: ${describeError(err, 'the migration')}\n`);
		return 1;
	}
}

if (require.main === module) {
	try {
		process.exitCode = main({
			argv: process.argv.slice(2),
			env: process.env,
			home: nodeOs.homedir(),
			tmpdir: nodeOs.tmpdir(),
			platform: process.platform,
			editorDir: getEditorDir(),
		});
	} catch (err) {
		process.stderr.write(`migrate-to-plugin: unexpected error: ${describeError(err, 'the migration')}\n`);
		process.exitCode = 1;
	}
}

module.exports = { main };
