#!/usr/bin/env node
/**
 * cleanup-legacy.js: phase B of the move from the 2.x skill to the plugin: after you confirm, it moves what is left of an
 * old install into ~/.make-custom-app/migration-backup-<time>/, and it can put it back. Run by the make-app-setup skill.
 *
 *   node cleanup-legacy.js --plan                                     print the plan (JSON) with its digest
 *   node cleanup-legacy.js --apply <digest> --groups claude[,cursor]  move the items of the named groups into a backup
 *   node cleanup-legacy.js --restore [<backup>]                       undo a run (the newest one that is not restored)
 *   node cleanup-legacy.js --decline <digest>                         keep the old install; check-setup asks again after 7 days
 *
 * Exit codes: 0 = done or nothing to do, 1 = usage or an unexpected error (an apply that stopped before its first change
 * too), 2 = refused before any change, 3 = the plan changed since the digest, 4 = stopped after some changes or a partial
 * restore. It needs no account check: it only moves local files. The work is in lib/legacy-cleanup-steps.js and
 * lib/legacy-cleanup-logic.js; this file only wires them to the command line. It prints plan JSON, the lines those
 * functions return, and fixed texts. It never prints a fact or a secret; the only environment value it shows is CLAUDE_BIN,
 * and the --restore argument is shown when no such backup exists, both with control characters shown as `?`.
 */
'use strict';
require('./lib/settings').takeEditorFlagOrExit(process.argv);
const os = require('os');
const path = require('path');
const { parseArgs, buildPlan, describeError } = require('./lib/legacy-cleanup-logic');
const steps = require('./lib/legacy-cleanup-steps');

const CLEANUP = 'the cleanup';
const LOCK = '~/.make-custom-app/cleanup.lock';
const BACKUP_NAME = /^migration-backup-[0-9T-]+Z(-\d+)?$/;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

/** The place that an unexpected error names: the state folder once a run works in it, else the cleanup as a whole. */
let place = CLEANUP;

function print(lines) {
	process.stdout.write(`${lines.join('\n')}\n`);
}

function shown(value) {
	return value.replace(CONTROL_CHARACTERS, '?');
}

function heldLines(pid) {
	if (pid === null) {
		return [`Another cleanup is running (lock ${LOCK}). Nothing was changed. If no other run is active, delete ${LOCK} and ${LOCK}.takeover, then run it again.`];
	}
	return [`Another cleanup is running (lock ${LOCK}, pid ${pid}). Nothing was changed.`];
}

function staleLine(digest, current) {
	return `The old install changed since the plan (digest ${digest}, now ${current}). Nothing was changed. Run --plan again.`;
}

/** The line for a CLAUDE_BIN that is set but names no usable binary, or null when it is unset or fine. */
function claudeBinLine({ env, home, facts }) {
	if (facts.claude.binary !== null || !steps.claudeCandidates({ env, home }).explicit) return null;
	return `CLAUDE_BIN is set to ${shown(env.CLAUDE_BIN)}, which is not an absolute path to an executable Claude Code binary. Set it to the full path of the claude binary, or unset it. Nothing was changed.`;
}

/** Runs `work` while this process holds the cleanup lock. A held lock is exit 2 and `work` does not run. */
function locked(stateDir, work) {
	const lock = steps.acquireLock({ dir: stateDir });
	if (!lock.ok) {
		print(heldLines(lock.pid));
		return 2;
	}
	try {
		return work();
	} finally {
		lock.release();
	}
}

function plan({ env, home }) {
	const facts = steps.gatherFacts({ home, env });
	const result = buildPlan(facts);
	const binLine = claudeBinLine({ env, home, facts });
	if (binLine !== null) process.stderr.write(`${binLine}\n`);
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	return 0;
}

function apply({ env, home, stateDir, args }) {
	return locked(stateDir, () => {
		const facts = steps.gatherFacts({ home, env });
		const current = buildPlan(facts);
		const refusal = steps.preflightApply({ digest: args.digest, groups: args.groups, plan: current, facts });
		if (refusal !== null) {
			print(refusal.lines);
			const needsClaude = args.groups.includes('claude') && current.items.some((item) => item.id === 'claude.mcp-entry' && item.status === 'blocked');
			const binLine = refusal.exitCode === 2 && needsClaude ? claudeBinLine({ env, home, facts }) : null;
			if (binLine !== null) print([binLine]);
			return refusal.exitCode;
		}
		let result;
		try {
			result = steps.applySteps({ plan: current, facts, groups: args.groups, env, home, claudeBin: facts.claude.binary });
		} catch (err) {
			process.stderr.write(`cleanup-legacy: nothing was changed: ${describeError(err, stateDir)}\n`);
			return 1;
		}
		print(result.lines);
		return result.exitCode;
	});
}

/** The folder name that `argument` names under the state folder, or null. It is a folder name or an absolute path directly inside the state folder. */
function backupNameOf(argument, stateDir) {
	const name = path.isAbsolute(argument) ? (path.dirname(argument) === stateDir ? path.basename(argument) : null) : argument;
	return name !== null && BACKUP_NAME.test(name) ? name : null;
}

function restore({ env, home, stateDir, args }) {
	const backups = steps.findBackups({ home });
	let target;
	if (args.backup === null) {
		if (backups.length === 0) {
			print(['Nothing to restore: no backup folder in ~/.make-custom-app.']);
			return 2;
		}
		target = backups.find((backup) => backup.status !== 'restored');
		if (target === undefined) {
			print(['Nothing to restore: every backup in ~/.make-custom-app is already restored.']);
			return 0;
		}
	} else {
		const name = backupNameOf(args.backup, stateDir);
		target = backups.find((backup) => backup.name === name);
		if (target === undefined) {
			print([`No backup named ${shown(args.backup)} in ~/.make-custom-app.`]);
			return 2;
		}
	}
	return locked(stateDir, () => {
		const result = steps.restoreSteps({ backupDir: target.dir, env, home, claudeBin: steps.locateClaude({ env, home }).binary });
		const lines = [...result.lines];
		if (result.status === 'partially-restored') {
			lines.push(`Some steps could not be restored from ${target.name}. The failed lines say why. Run --restore ${target.name} again after you fix that.`);
		}
		const others = backups.filter((backup) => backup !== target && backup.status !== 'restored').map((backup) => backup.name);
		if (args.backup === null && others.length > 0) lines.push(`Other backups not restored: ${others.join(', ')}. Restore one with --restore <name>.`);
		print(lines);
		return result.exitCode;
	});
}

function decline({ env, home, args }) {
	const facts = steps.gatherFacts({ home, env, locate: false });
	const current = buildPlan(facts);
	if (current.digest !== args.digest) {
		print([staleLine(args.digest, current.digest)]);
		return 3;
	}
	steps.writeDecline({ home, digest: args.digest });
	print(['Declined. check-setup shows OLD_INSTALL_KEPT for 7 days, then asks again.']);
	return 0;
}

function main() {
	const env = process.env;
	const home = os.homedir();
	if (!path.isAbsolute(home)) {
		process.stderr.write('cleanup-legacy: HOME is not an absolute path. Nothing was changed.\n');
		return 1;
	}
	const args = parseArgs(process.argv.slice(2));
	if (args.error !== null) {
		process.stderr.write(`${args.error}\n`);
		return 1;
	}
	const stateDir = path.join(home, '.make-custom-app');
	if (args.mode === 'plan') return plan({ env, home });
	place = stateDir;
	if (args.mode === 'apply') return apply({ env, home, stateDir, args });
	if (args.mode === 'restore') return restore({ env, home, stateDir, args });
	return decline({ env, home, args });
}

try {
	process.exitCode = main();
} catch (err) {
	process.stderr.write(`cleanup-legacy: unexpected error: ${describeError(err, place)}\n`);
	process.exitCode = 1;
}
