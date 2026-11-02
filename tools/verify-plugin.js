#!/usr/bin/env node
'use strict';

// Verifies the plugin the way a user gets it, with Claude Code and without touching your own configuration.
//
//   node tools/verify-plugin.js           install the committed HEAD from a git-hosted marketplace into an isolated
//                                         CLAUDE_CONFIG_DIR and inspect the result (no model session, no login needed)
//   node tools/verify-plugin.js --live    also start one model session with the working tree loaded through
//                                         --plugin-dir (project settings only) and check the skills, the MCP servers and
//                                         the permission rule of check-setup and review-changes (needs a login, costs a few cents)
//   --keep                                keep the temporary folder
//
// The claude binary is `claude` on the PATH, or $CLAUDE_BIN. Exit 0 when every check passes, 1 when one fails, 2 when the tool cannot run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseStream } = require('./lib/stream-summary');
const { checkInstalled, checkLive, livePrompt } = require('./lib/verify-checks');

const ROOT = path.resolve(__dirname, '..');
const MARKETPLACE_URL = 'https://verify.invalid/make-custom-app.git';
const PLUGIN_ID = 'make-custom-app@make-custom-app';

function exec(command, args, options = {}) {
	const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
	if (r.error) return { status: 127, stdout: '', stderr: String(r.error.message) };
	return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const firstLine = (text) => (text || '').split('\n').find((line) => line.trim()) || '';

/**
 * Installs the committed HEAD of `root` into a config folder under `tmp` and returns the checks. The marketplace is a
 * bare clone of the repository, served under a made-up https address through git's insteadOf, so nothing leaves the machine.
 */
function runInstall({ root = ROOT, claude, tmp, run = exec }) {
	const bare = path.join(tmp, 'bare.git');
	const config = path.join(tmp, 'config');
	const fail = (name, step) => [{ name, ok: false, detail: `${firstLine(step.stderr) || firstLine(step.stdout) || `exit ${step.status}`}` }];
	const clone = run('git', ['clone', '--quiet', '--bare', root, bare]);
	if (clone.status !== 0) return fail('the repository can be cloned', clone);
	fs.mkdirSync(config, { recursive: true });
	const env = {
		...process.env,
		CLAUDE_CONFIG_DIR: config,
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
		GIT_CONFIG_VALUE_0: MARKETPLACE_URL,
	};
	const add = run(claude, ['plugin', 'marketplace', 'add', MARKETPLACE_URL], { env });
	if (add.status !== 0) return fail('claude plugin marketplace add succeeds', add);
	const install = run(claude, ['plugin', 'install', PLUGIN_ID], { env });
	if (install.status !== 0) return fail(`claude plugin install ${PLUGIN_ID} succeeds`, install);
	const list = run(claude, ['plugin', 'list', '--json'], { env });
	let entry;
	try {
		entry = JSON.parse(list.stdout).find((item) => item.id === PLUGIN_ID);
	} catch {
		return fail('claude plugin list --json answers with JSON', list);
	}
	const details = run(claude, ['plugin', 'details', 'make-custom-app'], { env });
	const validate = entry && entry.installPath ? run(claude, ['plugin', 'validate', entry.installPath], { env }) : null;
	return checkInstalled({ root, entry, details: details.stdout, validate });
}

/** One model session with the working tree loaded in place. Project settings only, so the user's own plugins, skills and CLAUDE.md do not take part. */
function runLive({ root = ROOT, claude, tmp, run = exec }) {
	const cwd = path.join(tmp, 'live');
	fs.mkdirSync(cwd, { recursive: true });
	const args = [
		'-p', livePrompt(root),
		'--plugin-dir', root,
		'--setting-sources', 'project',
		'--permission-mode', 'dontAsk',
		'--allowedTools', 'Skill,Read',
		'--output-format', 'stream-json',
		'--verbose',
		'--max-turns', '12',
		'--no-session-persistence',
	];
	const session = run(claude, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
	const summary = parseStream(session.stdout);
	if (!summary.init) return [{ name: 'the model session started', ok: false, detail: firstLine(session.stderr) || firstLine(session.stdout) || `exit ${session.status}` }];
	return checkLive({ root, summary });
}

function format(results) {
	return results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` (${r.detail})` : ''}`).join('\n');
}

function main(argv) {
	const live = argv.includes('--live');
	const claude = process.env.CLAUDE_BIN || 'claude';
	const probe = exec(claude, ['--version']);
	if (probe.status !== 0) {
		console.error(`verify-plugin: cannot run "${claude}" (${firstLine(probe.stderr) || `exit ${probe.status}`}). Put claude on the PATH or set CLAUDE_BIN.`);
		return 2;
	}
	const dirty = exec('git', ['status', '--porcelain'], { cwd: ROOT }).stdout.trim();
	if (dirty) console.log('Note: the install check uses the committed HEAD; uncommitted changes are not in it.');
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-plugin-'));
	try {
		console.log(`claude ${firstLine(probe.stdout)}; temporary folder ${tmp}`);
		console.log('\nInstall from a git-hosted marketplace (isolated CLAUDE_CONFIG_DIR):');
		const results = runInstall({ claude, tmp });
		console.log(format(results));
		if (live) {
			console.log('\nModel session with --plugin-dir (project settings only):');
			const liveResults = runLive({ claude, tmp });
			console.log(format(liveResults));
			results.push(...liveResults);
		}
		const failed = results.filter((r) => !r.ok).length;
		console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
		return failed ? 1 : 0;
	} finally {
		if (argv.includes('--keep')) console.log(`kept ${tmp}`);
		else fs.rmSync(tmp, { recursive: true, force: true });
	}
}

module.exports = { MARKETPLACE_URL, PLUGIN_ID, runInstall, runLive, format };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
