#!/usr/bin/env node
'use strict';

// Trigger test for Cursor (spec section 5, verification item 8). It runs the Cursor agent headless (`agent -p`) once per
// prompt of prompts.json, watches the event stream, and records the first SKILL.md the agent reads (the caveman skill is
// ignored). A positive prompt passes when a make-app-* skill is read (exact when it is the expected one); a negative
// prompt passes when none is read. Run it after every change to a skill description. The pass mark is 18 of 20 positive
// prompts.
//
//   node tools/trigger-test/run-cursor.js
//     --mode plan|ask   plan (default) lets the agent act on action prompts; ask is read-only, so the agent often
//                       answers instead of reading a skill, and action prompts fail. Plan is the measured, fairer condition.
//     --parallel 4      agents at the same time (default 4)
//     --only 1,2        run these prompt ids only
//     --no-repo         do not load this working tree with --plugin-dir (measures the installed plugin, for example the
//                       Claude install that Cursor imports)
//     --org <dir>       the org plugin to load (default ~/.claude/plugins/marketplaces/make-claude-marketplace/integration-engineering)
//     --no-org          load no org plugin
//     --out <dir>       where results-cursor-<mode>.json and the empty workspace go (default <tmp>/make-custom-app-trigger-test)
//     --selftest        judge a few fake events and print the verdicts; no agent
//
// Cost and safety: every prompt starts a real Cursor agent and uses an unknown amount of Cursor quota. The agent can run
// real shell commands and edit files, so the runner kills it (the whole process group) at the first non-caveman SKILL.md
// read, at the first shell call that is not read-only (a short list of read-only programs; no redirect, subshell,
// process substitution, -exec, -delete, -ok, -fprint, -fls, -o, --pre, or --hostname-bin), at the first call of a tool kind that is not
// on the list of read-only kinds (read, glob, grep, ls, getMcpTools, semSearch), and after 10 tool calls. A kind that
// is not on the list stops the run and is recorded as unsafe-tool:<name>, so the list can be extended after a run
// shows a harmless kind. The allow-list can lower the score: a legitimate tool kind that is not on the list and comes
// before the first SKILL.md read (for example a todo or plan kind) stops the run as a miss, so counts from this tool
// can be lower than the counts of the earlier scratch runner; the summary line says how many missed positives were
// stopped by unsafe-tool:. The stop follows the started event, so the first unsafe command may already be running.
// The agents run in their own process groups, so a signal that reaches only the runner (Ctrl-C, a closed terminal, kill)
// is handled: the runner kills every running agent group and exits. The agent works in an empty folder under the out
// folder (--trust), never in a project. The binary is `agent` on the PATH, or $AGENT_BIN; a missing binary exits 2.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const REPO = path.join(__dirname, '..', '..');
const DEFAULT_ORG = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'make-claude-marketplace', 'integration-engineering');
const DEFAULT_OUT = path.join(os.tmpdir(), 'make-custom-app-trigger-test');
const PROMPTS = require('./prompts.json');
const READ_ONLY_KINDS = new Set(['readToolCall', 'globToolCall', 'grepToolCall', 'lsToolCall', 'getMcpToolsToolCall', 'semSearchToolCall']);
const MAX_CALLS = 10;
const TIMEOUT_MS = 240000;
const READ_ONLY = new Set(['ls', 'find', 'cat', 'head', 'tail', 'pwd', 'echo', 'grep', 'rg', 'which', 'wc', 'stat', 'test', '[', 'cut', 'basename', 'dirname', 'realpath', 'printf', 'cd', 'true']);
const NOT_READ_ONLY = /[>(){}`]|-exec|-delete|-ok|-fprint|-fls|--pre|--hostname-bin|\$\(|(^|\s)-o(\s|$)/;

/**
 * True when every command of the line is on the read-only list. Redirects (except to /dev/null and 2>&1), process and command
 * substitution, subshells, braces, -exec, -delete, -ok, -fprint, -fls, --pre, --hostname-bin, and a standalone -o flag are not read-only.
 * Commands are split at ; & | and at a line break.
 */
function readOnlyShell(cmd) {
	const c = String(cmd || '')
		.replace(/[0-9]?>\s*\/dev\/null(?=\s|$|[;&|])/g, '')
		.replace(/2>&1/g, '');
	if (NOT_READ_ONLY.test(c)) return false;
	return c.split(/[;&|\n\r]/).every((segment) => {
		const first = segment.trim().split(/\s+/)[0] || '';
		return !first || READ_ONLY.has(first);
	});
}

/**
 * One stream event: { kind: 'skill', name, file } at a SKILL.md read, { kind: 'ok' } at a read-only call, and
 * { kind: 'unsafe', tool, cmd } at every other call (an allow-list: a tool kind that is not known to be read-only is unsafe).
 */
function judge(event) {
	if (event === null || typeof event !== 'object' || event.type !== 'tool_call' || event.subtype !== 'started') return { kind: 'ok' };
	const call = event.tool_call || {};
	const tool = Object.keys(call).find((key) => /ToolCall$/.test(key)) || '';
	const args = (call[tool] && call[tool].args) || {};
	if (tool === 'readToolCall') {
		const m = /\/skills\/([^/]+)\/SKILL\.md$/.exec(String(args.path || ''));
		if (m && m[1] !== 'caveman') return { kind: 'skill', name: m[1], file: args.path };
		return { kind: 'ok' };
	}
	if (READ_ONLY_KINDS.has(tool)) return { kind: 'ok' };
	if (tool === 'shellToolCall' && readOnlyShell(args.command)) return { kind: 'ok' };
	return { kind: 'unsafe', tool: tool ? tool.replace('ToolCall', '') : 'unknown', cmd: args.command || args.path || '' };
}

/** pass: a positive prompt read one of our skills, or a negative prompt did not. exact: it was the expected skill. */
function classify(prompt, run) {
	const ours = !!run.picked && run.picked.startsWith('make-app-');
	if (prompt.kind === 'negative') return { pass: !ours, exact: !ours };
	return { pass: ours, exact: ours && (prompt.expect === 'any' || run.picked === 'make-app-' + prompt.expect) };
}

/** The agent arguments for one prompt. opt: { prompt, mode, workspace, repo (null for none), org (null for none) }. */
function buildArgs(opt) {
	const args = ['-p', opt.prompt, '--mode', opt.mode, '--trust', '--workspace', opt.workspace];
	if (opt.repo) args.push('--plugin-dir', opt.repo);
	if (opt.org) args.push('--plugin-dir', opt.org);
	args.push('--output-format', 'stream-json');
	return args;
}

const active = new Set();

function killGroup(child) {
	try {
		process.kill(-child.pid, 'SIGKILL');
	} catch {
		child.kill('SIGKILL');
	}
}

function stopAll() {
	for (const child of active) killGroup(child);
}

/** Kills the agent groups when the runner exits and when it gets SIGINT, SIGTERM, or SIGHUP (the agents are detached, so they miss the signal). */
function installCleanup() {
	process.on('exit', stopAll);
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(128 + os.constants.signals[signal]));
}

function runOne(agent, prompt, opt) {
	return new Promise((resolve) => {
		const child = spawn(agent, buildArgs({ ...opt, prompt: prompt.prompt }), { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
		active.add(child);
		const out = { id: prompt.id, kind: prompt.kind, expect: prompt.expect, picked: null, stoppedBy: 'finished', calls: 0, model: null };
		const rl = readline.createInterface({ input: child.stdout });
		let done = false;
		let timer = null;
		const finish = (why) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			out.stoppedBy = why;
			active.delete(child);
			killGroup(child);
			resolve(out);
		};
		timer = setTimeout(() => finish('timeout'), TIMEOUT_MS);
		child.on('error', () => {
			out.spawnError = true;
			finish('spawn-error');
		});
		rl.on('line', (text) => {
			if (done) return;
			let event;
			try {
				event = JSON.parse(text);
			} catch {
				return;
			}
			if (event === null || typeof event !== 'object') return;
			if (event.type === 'system' && event.subtype === 'init') out.model = event.model;
			const verdict = judge(event);
			if (event.type === 'tool_call' && event.subtype === 'started') out.calls++;
			if (verdict.kind === 'skill') {
				out.picked = verdict.name;
				finish('skill-read');
			} else if (verdict.kind === 'unsafe') {
				out.unsafe = verdict.tool;
				out.unsafeCmd = String(verdict.cmd || '').slice(0, 140);
				finish('unsafe-tool:' + verdict.tool);
			} else if (out.calls >= MAX_CALLS) finish('max-calls');
			if (event.type === 'result') finish('finished');
		});
		child.on('exit', () => finish(out.stoppedBy));
	});
}

function selftest() {
	const read = (file) => ({ type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: file } } } });
	const shell = (command) => ({ type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command } } } });
	console.log(JSON.stringify([judge(shell('ls -la /tmp && find / -maxdepth 3 -iname x | head')), judge(shell('node run.js')), judge(shell('cat a > b')), judge(shell('find . -name x -delete'))]));
	console.log(
		JSON.stringify([
			judge(read('/x/skills/caveman/SKILL.md')),
			judge(read('/x/skills/make-app-setup/SKILL.md')),
			judge({ type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: {} } } }),
			judge(read('/x/foo.md')),
		]),
	);
}

function fail(message) {
	console.error(message);
	process.exit(2);
}

const VALUE_FLAGS = new Set(['--mode', '--parallel', '--only', '--org', '--out']);
const BOOLEAN_FLAGS = { '--no-repo': 'noRepo', '--no-org': 'noOrg', '--selftest': 'selftest' };

function positiveInteger(flag, text) {
	if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${flag} needs a positive whole number, not "${text}"`);
	return Number(text);
}

/** Reads the flags. Throws an Error with a message for an unknown flag, a missing value, or a bad value. */
function parseArgs(argv) {
	const opts = { mode: 'plan', parallel: 4, only: null, noRepo: false, noOrg: false, org: null, out: null, selftest: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (BOOLEAN_FLAGS[flag]) {
			opts[BOOLEAN_FLAGS[flag]] = true;
			continue;
		}
		if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown flag "${flag}"`);
		const value = argv[++i];
		if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
		if (flag === '--mode') {
			if (value !== 'plan' && value !== 'ask') throw new Error(`--mode must be plan or ask, not "${value}"`);
			opts.mode = value;
		} else if (flag === '--parallel') opts.parallel = positiveInteger(flag, value);
		else if (flag === '--only') {
			opts.only = value.split(',').map((id) => positiveInteger(flag, id));
			for (const id of opts.only) if (!PROMPTS.some((p) => p.id === id)) throw new Error(`--only names the prompt id ${id}, which does not exist`);
		} else if (flag === '--org') opts.org = value;
		else opts.out = value;
	}
	if (opts.org && opts.noOrg) throw new Error('Use --org or --no-org, not both');
	return opts;
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		return fail(err.message);
	}
	if (opts.selftest) return selftest();

	const agent = process.env.AGENT_BIN || 'agent';
	const outDir = path.resolve(opts.out || DEFAULT_OUT);
	const org = opts.noOrg ? null : path.resolve(opts.org || DEFAULT_ORG);
	if (org && !fs.existsSync(org)) fail(`The org plugin folder ${org} does not exist. Pass --org <dir> or --no-org.`);
	const opt = { mode: opts.mode, workspace: path.join(outDir, 'cursor-ws'), repo: opts.noRepo ? null : REPO, org };
	fs.mkdirSync(opt.workspace, { recursive: true });

	installCleanup();

	const list = PROMPTS.filter((p) => !opts.only || opts.only.includes(p.id));
	const results = [];
	let next = 0;
	async function worker() {
		while (next < list.length) {
			const p = list[next++];
			const r = await runOne(agent, p, opt);
			if (r.spawnError) fail('Cannot start agent. Put agent on the PATH or set AGENT_BIN.');
			const c = classify(p, r);
			Object.assign(r, c);
			results.push(r);
			console.log(`${p.id}\t${p.kind}\texpect=${p.expect}\tpicked=${r.picked || 'none'}\t${c.pass ? 'PASS' : 'FAIL'}${c.exact ? '' : ' (not expected)'}\t[${r.stoppedBy}, ${r.calls} calls]`);
		}
	}
	await Promise.all(Array.from({ length: opts.parallel }, worker));
	results.sort((a, b) => a.id - b.id);

	const pos = results.filter((x) => x.kind === 'positive');
	const neg = results.filter((x) => x.kind === 'negative');
	console.log(
		`\ncursor positives selecting a make-app skill: ${pos.filter((x) => x.pass).length}/${pos.length}; exact: ${pos.filter((x) => x.exact).length}/${pos.length}; negatives clean: ${neg.filter((x) => x.pass).length}/${neg.length}; missed positives stopped by unsafe-tool: ${pos.filter((x) => !x.pass && String(x.stoppedBy).startsWith('unsafe-tool:')).length}; model: ${results[0] && results[0].model}`,
	);
	const file = path.join(outDir, `results-cursor-${opts.mode}.json`);
	fs.writeFileSync(file, JSON.stringify(results, null, 2));
	console.log('wrote', file);
}

module.exports = { readOnlyShell, judge, classify, buildArgs, parseArgs, runOne, installCleanup };

if (require.main === module) {
	main().catch((err) => {
		console.error(err && err.message ? err.message : String(err));
		process.exit(1);
	});
}
