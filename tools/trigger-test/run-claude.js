#!/usr/bin/env node
'use strict';

// Trigger test for Claude Code (spec section 5, verification item 8). It starts one headless Claude Code session per
// prompt of prompts.json and records the first Skill tool call. A positive prompt passes when a make-custom-app:make-app-*
// skill is picked (exact when it is the expected one); a negative prompt passes when none is picked. Run it after every
// change to a skill description. The pass mark is 18 of 20 positive prompts.
//
//   node tools/trigger-test/run-claude.js --condition clean
//     --condition clean|real  clean (default) loads this working tree and the org plugin with --plugin-dir, reads project
//                             settings only (--setting-sources project) and sets CLAUDE_CODE_DISABLE_CLAUDE_MDS=1, so the
//                             old 2.x skill and your own CLAUDE.md are out. real keeps your own settings, CLAUDE.md,
//                             installed plugins, and the old skill.
//     --only 1,2,3            run these prompt ids only
//     --repeat 3              run the list three times (two runs of one prompt can differ)
//     --allow Tool1,Tool2     tools to allow besides Skill
//     --turns 2               --max-turns of each session (default 2)
//     --stub                  serve the tickets that prompts 4, 5, 19, and 20 name from jira-stub.js (a generated MCP config,
//                             --strict-mcp-config) and allow its tool; a headless session cannot use the real Atlassian
//                             connector, because the permission prompt is denied
//     --org <dir>             the org plugin to load (default ~/.claude/plugins/marketplaces/make-claude-marketplace/integration-engineering)
//     --no-org                load no org plugin (--org and --no-org do nothing with --condition real)
//     --out <dir>             where results-<condition>.json and the stub config go (default <tmp>/make-custom-app-trigger-test)
//     --dry-run               print the commands and run nothing
//     --selftest              parse a fake stream and print the result; no session
//
// Cost and safety: every prompt is a real model session and costs about 0.1 USD of Claude usage. The runner allows only
// the Skill tool (plus --allow tools) under --permission-mode dontAsk. A session can still run read-only shell commands
// and the pre-approved quoted `check-setup.js` and `review-changes.js` of the skill it picks (they read the secrets file
// and may call Jira and Make with the maintainer's credentials). The session's own tools cannot write files or run
// other commands; the pre-approved scripts write small cache files in the temp folder (check-setup.js) or review files
// under ~/.make-custom-app/contexts (review-changes.js), and check-setup.js fetches the update notice from
// raw.githubusercontent.com. In the real condition the maintainer's own permission rules also apply. Sessions start in
// the system temp folder.
// The binary is `claude` on the PATH, or $CLAUDE_BIN.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const DEFAULT_ORG = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'make-claude-marketplace', 'integration-engineering');
const DEFAULT_OUT = path.join(os.tmpdir(), 'make-custom-app-trigger-test');
const SKILL_PREFIX = 'make-custom-app:make-app-';
const PROMPTS = require('./prompts.json');

/** Reads a stream-json transcript: the skills of the init event, every tool call, the first Skill call, cost, and an error. */
function parseRun(text) {
	const out = { skills: [], calls: [], firstSkill: null, cost: 0, error: null };
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === 'system' && event.subtype === 'init') out.skills = event.skills || [];
		if (event.type === 'assistant') {
			for (const part of (event.message && event.message.content) || []) {
				if (part.type !== 'tool_use') continue;
				out.calls.push(part.name);
				if (part.name === 'Skill' && !out.firstSkill) out.firstSkill = (part.input && (part.input.skill || part.input.name)) || '?';
			}
		}
		if (event.type === 'result') {
			out.cost = event.total_cost_usd || 0;
			if (event.is_error) out.error = String(event.result || 'error').slice(0, 120);
		}
	}
	return out;
}

/** pass: a positive prompt picked one of our skills, or a negative prompt did not. exact: it was the expected skill. */
function classify(prompt, run) {
	const skill = run.firstSkill || '';
	const ours = skill.startsWith(SKILL_PREFIX);
	const short = ours ? skill.slice(SKILL_PREFIX.length) : skill;
	if (prompt.kind === 'negative') return { ours, short, pass: !ours, exact: !ours };
	return { ours, short, pass: ours, exact: ours && (prompt.expect === 'any' || prompt.expect === short) };
}

/** The claude arguments for one prompt. opt: { repo, org (null for none), turns, allow, mcpConfig (null for none) }. */
function buildArgs(condition, prompt, opt) {
	const allow = ['Skill', ...(opt.allow || [])].join(',');
	const args = ['-p', prompt, '--permission-mode', 'dontAsk', '--allowedTools', allow, '--max-turns', String(opt.turns || 2), '--output-format', 'stream-json', '--verbose'];
	if (opt.mcpConfig) args.push('--mcp-config', opt.mcpConfig, '--strict-mcp-config');
	if (condition === 'clean') {
		args.push('--plugin-dir', opt.repo);
		if (opt.org) args.push('--plugin-dir', opt.org);
		args.push('--setting-sources', 'project');
	}
	return args;
}

/** The MCP config that starts jira-stub.js, given its absolute path. */
function stubConfig(stubPath) {
	return { mcpServers: { 'jira-stub': { command: 'node', args: [stubPath] } } };
}

/** The reason a claude process failed, from a spawnSync result: a spawn error (ETIMEDOUT, EACCES), a signal, or a non-zero exit; null otherwise. */
function processError(r) {
	if (r.error) return String(r.error.code || r.error.message);
	if (r.signal) return 'signal ' + r.signal;
	return r.status ? 'exit ' + r.status : null;
}

function selftest() {
	const fake = [
		JSON.stringify({ type: 'system', subtype: 'init', skills: ['make-custom-app:make-app-question'] }),
		JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'make-custom-app:make-app-question' } }] } }),
		JSON.stringify({ type: 'result', total_cost_usd: 0.1, is_error: false }),
	].join('\n');
	const run = parseRun(fake);
	console.log(JSON.stringify({ r: run, c: classify(PROMPTS[0], run) }));
}

function fail(message) {
	console.error(message);
	process.exit(2);
}

const VALUE_FLAGS = new Set(['--condition', '--only', '--repeat', '--allow', '--turns', '--org', '--out']);
const BOOLEAN_FLAGS = { '--stub': 'stub', '--no-org': 'noOrg', '--dry-run': 'dryRun', '--selftest': 'selftest' };

function positiveInteger(flag, text) {
	if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${flag} needs a positive whole number, not "${text}"`);
	return Number(text);
}

/** Reads the flags. Throws an Error with a message for an unknown flag, a missing value, or a bad value. */
function parseArgs(argv) {
	const opts = { condition: 'clean', only: null, repeat: 1, allow: [], turns: 2, stub: false, org: null, noOrg: false, out: null, dryRun: false, selftest: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (BOOLEAN_FLAGS[flag]) {
			opts[BOOLEAN_FLAGS[flag]] = true;
			continue;
		}
		if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown flag "${flag}"`);
		const value = argv[++i];
		if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
		if (flag === '--condition') {
			if (value !== 'clean' && value !== 'real') throw new Error(`--condition must be clean or real, not "${value}"`);
			opts.condition = value;
		} else if (flag === '--only') {
			opts.only = value.split(',').map((id) => positiveInteger(flag, id));
			for (const id of opts.only) if (!PROMPTS.some((p) => p.id === id)) throw new Error(`--only names the prompt id ${id}, which does not exist`);
		} else if (flag === '--repeat') opts.repeat = positiveInteger(flag, value);
		else if (flag === '--turns') opts.turns = positiveInteger(flag, value);
		else if (flag === '--allow') opts.allow = value.split(',').filter(Boolean);
		else if (flag === '--org') opts.org = value;
		else opts.out = value;
	}
	if (opts.org && opts.noOrg) throw new Error('Use --org or --no-org, not both');
	return opts;
}

function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		return fail(err.message);
	}
	if (opts.selftest) return selftest();

	const { condition, dryRun } = opts;
	const claude = process.env.CLAUDE_BIN || 'claude';
	const outDir = path.resolve(opts.out || DEFAULT_OUT);
	const org = opts.noOrg ? null : path.resolve(opts.org || DEFAULT_ORG);
	if (condition === 'clean' && org && !dryRun && !fs.existsSync(org)) fail(`The org plugin folder ${org} does not exist. Pass --org <dir> or --no-org.`);

	const once = PROMPTS.filter((p) => !opts.only || opts.only.includes(p.id));
	const list = [];
	for (let i = 0; i < opts.repeat; i++) list.push(...once);

	const buildOpt = { repo: REPO, org, turns: opts.turns, allow: [...opts.allow], mcpConfig: null };
	if (opts.stub) {
		buildOpt.allow.push('mcp__jira-stub__getJiraIssue');
		buildOpt.mcpConfig = path.join(outDir, 'jira-stub.mcp.json');
		if (!dryRun) {
			fs.mkdirSync(outDir, { recursive: true });
			fs.writeFileSync(buildOpt.mcpConfig, JSON.stringify(stubConfig(path.join(__dirname, 'jira-stub.js'))));
		}
	}

	const env = { ...process.env };
	if (condition === 'clean') env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
	const results = [];
	for (const p of list) {
		const args = buildArgs(condition, p.prompt, buildOpt);
		if (dryRun) {
			console.log(p.id, [claude, ...args].join(' '));
			continue;
		}
		const r = spawnSync(claude, args, { cwd: os.tmpdir(), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
		if (r.error && r.error.code === 'ENOENT') fail(`Cannot start ${claude}. Put claude on the PATH or set CLAUDE_BIN.`);
		const run = parseRun(r.stdout || '');
		const c = classify(p, run);
		const spawnFailure = r.error || r.signal ? processError(r) : null;
		results.push({
			id: p.id,
			lang: p.lang,
			kind: p.kind,
			expect: p.expect,
			picked: run.firstSkill,
			calls: run.calls.join(','),
			pass: c.pass,
			exact: c.exact,
			cost: run.cost,
			legacySkillPresent: run.skills.includes('make-custom-app'),
			orgSkills: run.skills.filter((s) => s.startsWith('make-integration-engineering:')).length,
			error: spawnFailure || run.error || processError(r),
		});
		console.log(`${p.id}\t${p.kind}\texpect=${p.expect}\tpicked=${run.firstSkill || 'none'}\t${c.pass ? 'PASS' : 'FAIL'}${c.exact ? '' : ' (not the expected skill)'}${spawnFailure ? `\t[${spawnFailure}]` : ''}`);
	}
	if (!results.length) return;

	const pos = results.filter((x) => x.kind === 'positive');
	const neg = results.filter((x) => x.kind === 'negative');
	console.log(
		`\ncondition=${condition} positives selecting a make-app skill: ${pos.filter((x) => x.pass).length}/${pos.length}; exact expected: ${pos.filter((x) => x.exact).length}/${pos.length}; negatives clean: ${neg.filter((x) => x.pass).length}/${neg.length}; cost $${results.reduce((s, x) => s + x.cost, 0).toFixed(2)}; legacy skill present in any run: ${results.some((x) => x.legacySkillPresent)}`,
	);
	fs.mkdirSync(outDir, { recursive: true });
	const file = path.join(outDir, `results-${condition}.json`);
	fs.writeFileSync(file, JSON.stringify(results, null, 2));
	console.log('wrote', file);
}

module.exports = { parseRun, classify, buildArgs, stubConfig, parseArgs, processError };

if (require.main === module) main();
