'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { exchange, listToolNames } = require('../lib/mcp-stdio.js');
const claude = require('../trigger-test/run-claude.js');
const cursor = require('../trigger-test/run-cursor.js');
const prompts = require('../trigger-test/prompts.json');

const STUB = path.join(__dirname, '..', 'trigger-test', 'jira-stub.js');
const RUN_CLAUDE = path.join(__dirname, '..', 'trigger-test', 'run-claude.js');
const RUN_CURSOR = path.join(__dirname, '..', 'trigger-test', 'run-cursor.js');
const SKILLS = ['bug-investigation', 'code-review', 'endpoint', 'feature-request', 'question', 'run-live', 'setup', 'task', 'task-refinement'];

const line = (event) => JSON.stringify(event);
const skillCall = (skill) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } });

test('parseRun reads the init skills, the calls in order, the first Skill call, and the cost', () => {
	const run = claude.parseRun(
		[
			line({ type: 'system', subtype: 'init', skills: ['make-custom-app:make-app-question', 'other'] }),
			'not json',
			'',
			line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'ToolSearch', input: {} }] } }),
			skillCall('make-custom-app:make-app-task'),
			skillCall('make-custom-app:make-app-question'),
			line({ type: 'result', total_cost_usd: 0.1, is_error: false }),
		].join('\n'),
	);
	assert.deepEqual(run, {
		skills: ['make-custom-app:make-app-question', 'other'],
		calls: ['ToolSearch', 'Skill', 'Skill'],
		firstSkill: 'make-custom-app:make-app-task',
		cost: 0.1,
		error: null,
	});
});

test('parseRun records null when no Skill call happens, and "?" for a Skill call without a name', () => {
	const none = claude.parseRun([line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }), line({ type: 'result' })].join('\n'));
	assert.equal(none.firstSkill, null);
	assert.deepEqual(none.calls, ['Bash']);
	assert.equal(none.cost, 0);
	assert.equal(claude.parseRun(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: {} }] } })).firstSkill, '?');
	assert.equal(claude.parseRun(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { name: 'x:y' } }] } })).firstSkill, 'x:y');
	assert.deepEqual(claude.parseRun(''), { skills: [], calls: [], firstSkill: null, cost: 0, error: null });
});

test('parseRun keeps an error result, cut to 120 characters', () => {
	assert.equal(claude.parseRun(line({ type: 'result', is_error: true, result: 'x'.repeat(300) })).error, 'x'.repeat(120));
	assert.equal(claude.parseRun(line({ type: 'result', is_error: true })).error, 'error');
});

test('Claude classify passes a positive prompt when one of our skills is picked, and is exact only for the expected one', () => {
	const prompt = { kind: 'positive', expect: 'question' };
	assert.deepEqual(claude.classify(prompt, { firstSkill: 'make-custom-app:make-app-question' }), { ours: true, short: 'question', pass: true, exact: true });
	assert.deepEqual(claude.classify(prompt, { firstSkill: 'make-custom-app:make-app-task' }), { ours: true, short: 'task', pass: true, exact: false });
	assert.equal(claude.classify({ kind: 'positive', expect: 'any' }, { firstSkill: 'make-custom-app:make-app-task-refinement' }).exact, true);
});

test('Claude classify fails a positive prompt for an org skill or no skill', () => {
	assert.deepEqual(claude.classify(prompt1(), { firstSkill: 'make-integration-engineering:jira-investigation' }), {
		ours: false,
		short: 'make-integration-engineering:jira-investigation',
		pass: false,
		exact: false,
	});
	assert.deepEqual(claude.classify(prompt1(), { firstSkill: null }), { ours: false, short: '', pass: false, exact: false });
	assert.equal(claude.classify({ kind: 'positive', expect: 'any' }, { firstSkill: null }).exact, false);
});

test('Claude classify passes a negative prompt unless one of our skills is picked', () => {
	const prompt = { kind: 'negative', expect: 'none' };
	assert.deepEqual(claude.classify(prompt, { firstSkill: null }), { ours: false, short: '', pass: true, exact: true });
	assert.equal(claude.classify(prompt, { firstSkill: 'make-integration-engineering:scenario-help' }).pass, true);
	assert.deepEqual(claude.classify(prompt, { firstSkill: 'make-custom-app:make-app-setup' }), { ours: true, short: 'setup', pass: false, exact: false });
});

function prompt1() {
	return { kind: 'positive', expect: 'question' };
}

test('Claude buildArgs allows only the Skill tool, and loads both plugins with project settings for the clean condition', () => {
	const args = claude.buildArgs('clean', 'a prompt', { repo: '/r', org: '/o', turns: 2, allow: [], mcpConfig: null });
	assert.deepEqual(args, [
		'-p', 'a prompt', '--permission-mode', 'dontAsk', '--allowedTools', 'Skill', '--max-turns', '2', '--output-format', 'stream-json', '--verbose',
		'--plugin-dir', '/r', '--plugin-dir', '/o', '--setting-sources', 'project',
	]);
});

test('Claude buildArgs adds the extra tools, the stub config, and leaves the plugins to the install for the real condition', () => {
	const args = claude.buildArgs('real', 'p', { repo: '/r', org: '/o', turns: 3, allow: ['mcp__x'], mcpConfig: '/out/jira-stub.mcp.json' });
	assert.equal(args[args.indexOf('--allowedTools') + 1], 'Skill,mcp__x');
	assert.equal(args[args.indexOf('--max-turns') + 1], '3');
	assert.deepEqual(args.slice(args.indexOf('--mcp-config')), ['--mcp-config', '/out/jira-stub.mcp.json', '--strict-mcp-config']);
	assert.equal(args.includes('--plugin-dir'), false);
	assert.equal(args.includes('--setting-sources'), false);
});

test('Claude buildArgs loads no org plugin when org is null', () => {
	const args = claude.buildArgs('clean', 'p', { repo: '/r', org: null, turns: 2, allow: [], mcpConfig: null });
	assert.deepEqual(args.filter((a, i) => args[i - 1] === '--plugin-dir'), ['/r']);
});

test('Claude stubConfig names the absolute path of jira-stub.js', () => {
	const config = claude.stubConfig('/abs/jira-stub.js');
	assert.deepEqual(config, { mcpServers: { 'jira-stub': { command: 'node', args: ['/abs/jira-stub.js'] } } });
});

const toolCall = (tool, args) => ({ type: 'tool_call', subtype: 'started', tool_call: { [tool]: { args } } });
const shell = (command) => toolCall('shellToolCall', { command });
const read = (file) => toolCall('readToolCall', { path: file });

test('Cursor judge reports the first read of a skill file, and ignores the caveman skill and other reads', () => {
	assert.deepEqual(cursor.judge(read('/x/skills/make-app-setup/SKILL.md')), { kind: 'skill', name: 'make-app-setup', file: '/x/skills/make-app-setup/SKILL.md' });
	assert.deepEqual(cursor.judge(read('/x/skills/caveman/SKILL.md')), { kind: 'ok' });
	assert.deepEqual(cursor.judge(read('/x/foo.md')), { kind: 'ok' });
	assert.deepEqual(cursor.judge(read('/x/skills/make-app-setup/notes.md')), { kind: 'ok' });
});

test('Cursor judge allows read-only shell calls, including 2>/dev/null and 2>&1', () => {
	assert.deepEqual(cursor.judge(shell('ls -la /tmp && find / -maxdepth 3 -iname x | head')), { kind: 'ok' });
	assert.deepEqual(cursor.judge(shell('ls /x 2>/dev/null')), { kind: 'ok' });
	assert.deepEqual(cursor.judge(shell('find / -name SKILL.md 2>&1 | head -5')), { kind: 'ok' });
	for (const command of ['ls >/dev/null', 'ls >/dev/null && pwd', 'ls 2> /dev/null | head', 'ls 2>/dev/null; pwd', 'ls 2>/dev/null&', 'ls >/dev/null 2>&1']) {
		assert.deepEqual(cursor.judge(shell(command)), { kind: 'ok' }, command);
	}
	assert.deepEqual(cursor.judge(toolCall('shellToolCall', {})), { kind: 'ok' });
});

test('Cursor judge stops at a shell call that is not read-only', () => {
	assert.deepEqual(cursor.judge(shell('node x.js')), { kind: 'unsafe', tool: 'shell', cmd: 'node x.js' });
	assert.equal(cursor.judge(shell('cat a > b')).kind, 'unsafe');
	assert.equal(cursor.judge(shell('find . -name x -delete')).kind, 'unsafe');
	assert.equal(cursor.judge(shell('find . -name x -exec rm {} ;')).kind, 'unsafe');
	assert.equal(cursor.judge(shell('echo $(whoami)')).kind, 'unsafe');
	assert.equal(cursor.judge(shell('ls && rm -rf x')).kind, 'unsafe');
});

test('Cursor judge stops at an edit, a write, and an MCP call, and ignores events that are not a started tool call', () => {
	assert.deepEqual(cursor.judge(toolCall('editToolCall', { path: '/x/a.js' })), { kind: 'unsafe', tool: 'edit', cmd: '/x/a.js' });
	assert.equal(cursor.judge(toolCall('writeToolCall', { path: '/x/a.js' })).kind, 'unsafe');
	assert.deepEqual(cursor.judge(toolCall('mcpToolCall', {})), { kind: 'unsafe', tool: 'mcp', cmd: '' });
	assert.equal(cursor.judge(toolCall('grepToolCall', { pattern: 'x' })).kind, 'ok');
	assert.deepEqual(cursor.judge({ type: 'tool_call', subtype: 'completed', tool_call: { editToolCall: { args: {} } } }), { kind: 'ok' });
	assert.deepEqual(cursor.judge({ type: 'assistant' }), { kind: 'ok' });
});

test('readOnlyShell accepts the whitelist and rejects redirects, substitutions, and other programs', () => {
	assert.equal(cursor.readOnlyShell('cat a.txt | grep x | wc -l'), true);
	assert.equal(cursor.readOnlyShell('ls x 2>/dev/null; pwd'), true);
	assert.equal(cursor.readOnlyShell(''), true);
	assert.equal(cursor.readOnlyShell('echo hi >> log'), false);
	assert.equal(cursor.readOnlyShell('echo `date`'), false);
	assert.equal(cursor.readOnlyShell('git status'), false);
	assert.equal(cursor.readOnlyShell('ls | xargs rm'), false);
});

test('Cursor classify passes a positive prompt for a make-app skill, exact for the expected one', () => {
	assert.deepEqual(cursor.classify({ kind: 'positive', expect: 'endpoint' }, { picked: 'make-app-endpoint' }), { pass: true, exact: true });
	assert.deepEqual(cursor.classify({ kind: 'positive', expect: 'endpoint' }, { picked: 'make-app-task' }), { pass: true, exact: false });
	assert.deepEqual(cursor.classify({ kind: 'positive', expect: 'any' }, { picked: 'make-app-task-refinement' }), { pass: true, exact: true });
	assert.deepEqual(cursor.classify({ kind: 'positive', expect: 'endpoint' }, { picked: 'jira-investigation' }), { pass: false, exact: false });
	assert.deepEqual(cursor.classify({ kind: 'positive', expect: 'endpoint' }, { picked: null }), { pass: false, exact: false });
});

test('Cursor classify passes a negative prompt unless a make-app skill is read', () => {
	assert.deepEqual(cursor.classify({ kind: 'negative', expect: 'none' }, { picked: null }), { pass: true, exact: true });
	assert.deepEqual(cursor.classify({ kind: 'negative', expect: 'none' }, { picked: 'jira-investigation' }), { pass: true, exact: true });
	assert.deepEqual(cursor.classify({ kind: 'negative', expect: 'none' }, { picked: 'make-app-setup' }), { pass: false, exact: false });
});

test('Cursor buildArgs runs in plan mode by default, trusts the workspace, and loads both plugins', () => {
	assert.deepEqual(cursor.buildArgs({ prompt: 'p', mode: 'plan', workspace: '/ws', repo: '/r', org: '/o' }), [
		'-p', 'p', '--mode', 'plan', '--trust', '--workspace', '/ws', '--plugin-dir', '/r', '--plugin-dir', '/o', '--output-format', 'stream-json',
	]);
	const args = cursor.buildArgs({ prompt: 'p', mode: 'ask', workspace: '/ws', repo: null, org: null });
	assert.equal(args[args.indexOf('--mode') + 1], 'ask');
	assert.equal(args.includes('--plugin-dir'), false);
});

function stubReplies(requests) {
	const input = requests.map((r) => `${typeof r === 'string' ? r : JSON.stringify(r)}\n`).join('');
	const result = spawnSync(process.execPath, [STUB], { input, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('jira-stub answers initialize with the requested protocol version, and with a default when none is given', () => {
	const [a, b] = stubReplies([
		{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
		{ jsonrpc: '2.0', id: 2, method: 'initialize' },
	]);
	assert.equal(a.result.protocolVersion, '2025-06-18');
	assert.deepEqual(a.result.serverInfo, { name: 'jira-stub', version: '1' });
	assert.deepEqual(a.result.capabilities, { tools: {} });
	assert.equal(b.result.protocolVersion, '2024-11-05');
});

test('jira-stub lists the one tool getJiraIssue', () => {
	const [reply] = stubReplies([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
	assert.equal(reply.result.tools.length, 1);
	assert.equal(reply.result.tools[0].name, 'getJiraIssue');
	assert.deepEqual(reply.result.tools[0].inputSchema.required, ['issueIdOrKey']);
});

test('jira-stub returns a canned ticket for a known key and an error for an unknown key', () => {
	const [known, unknown, missing] = stubReplies([
		{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getJiraIssue', arguments: { issueIdOrKey: 'IEN-16879' } } },
		{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'getJiraIssue', arguments: { issueIdOrKey: 'IEN-1' } } },
		{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'getJiraIssue' } },
	]);
	assert.equal(known.result.isError, false);
	const ticket = JSON.parse(known.result.content[0].text);
	assert.equal(ticket.key, 'IEN-16879');
	assert.equal(ticket.status, 'Preparation');
	assert.equal(JSON.parse(stubReplies([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { arguments: { issueIdOrKey: 'IEN-16847' } } }])[0].result.content[0].text).key, 'IEN-16847');
	assert.equal(unknown.result.isError, true);
	assert.deepEqual(JSON.parse(unknown.result.content[0].text), { error: 'not found' });
	assert.equal(missing.result.isError, true);
});

test('jira-stub ignores notifications and lines that are not JSON, and answers an unknown method with an empty result', () => {
	const replies = stubReplies([
		'not json',
		'null',
		'42',
		{ jsonrpc: '2.0', method: 'notifications/initialized' },
		{ jsonrpc: '2.0', id: 7, method: 'ping' },
	]);
	assert.deepEqual(replies, [{ jsonrpc: '2.0', id: 7, result: {} }]);
});

test('jira-stub answers tools/call without params as an unknown ticket and keeps running', () => {
	const [reply, after] = stubReplies([
		{ jsonrpc: '2.0', id: 1, method: 'tools/call' },
		{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
	]);
	assert.equal(reply.result.isError, true);
	assert.equal(after.result.tools.length, 1);
});

test('jira-stub completes the handshake of the shared stdio helper', async () => {
	assert.deepEqual(await listToolNames({ command: process.execPath, args: [STUB] }), ['getJiraIssue']);
	const { responses } = await exchange({
		command: process.execPath,
		args: [STUB],
		requests: [{ method: 'tools/call', params: { name: 'getJiraIssue', arguments: { issueIdOrKey: 'IEN-16847' } } }],
	});
	assert.equal(JSON.parse(responses[0].result.content[0].text).summary, 'monday app: Search Items returns duplicate items');
});

test('prompts.json holds 24 prompts with ids 1 to 24, 20 positive and 4 negative', () => {
	assert.equal(prompts.length, 24);
	assert.deepEqual(prompts.map((p) => p.id), Array.from({ length: 24 }, (_, i) => i + 1));
	assert.equal(prompts.filter((p) => p.kind === 'positive').length, 20);
	assert.equal(prompts.filter((p) => p.kind === 'negative').length, 4);
	for (const p of prompts) {
		assert.ok(['positive', 'negative'].includes(p.kind), `prompt ${p.id} kind`);
		assert.ok(typeof p.prompt === 'string' && p.prompt.trim(), `prompt ${p.id} text`);
	}
});

test('prompts.json expectations are the nine skill suffixes, any, or none, and 13 prompts are Korean', () => {
	const allowed = new Set([...SKILLS, 'any']);
	for (const p of prompts) {
		if (p.kind === 'positive') assert.ok(allowed.has(p.expect), `prompt ${p.id} expects "${p.expect}"`);
		else assert.equal(p.expect, 'none', `prompt ${p.id}`);
	}
	assert.equal(prompts.filter((p) => p.lang === 'ko').length, 13);
	assert.equal(prompts.filter((p) => p.lang === 'en').length, 11);
	assert.deepEqual(new Set(prompts.filter((p) => p.kind === 'positive' && p.expect !== 'any').map((p) => p.expect)), new Set(SKILLS));
});

test('the nine skill suffixes of the tests match the skills folder', () => {
	const folders = fs.readdirSync(path.join(__dirname, '..', '..', 'skills')).filter((n) => n.startsWith('make-app-'));
	assert.deepEqual(folders.map((n) => n.slice('make-app-'.length)).sort(), [...SKILLS].sort());
});

test('Cursor judge stops at a shell call that chains, substitutes, or writes by another route', () => {
	const bypasses = [
		'ls & rm -rf x',
		'ls\nrm -rf x',
		'ls\r\nrm -rf x',
		'cat <(rm -rf x)',
		'cat a >(tee f)',
		'find . -ok rm {} ;',
		'find . -okdir rm {} ;',
		'find . -fprint f',
		'find . -fprintf f %p',
		'find . -fls f',
		'sort -o f f',
		'rg --pre sh x',
		'rg --pre=sh x',
		'rg --hostname-bin sh x',
		'rg --hostname-bin=sh x',
		'ls >/dev/nullx',
		'ls > /dev/null.f',
		'ls >/dev/nullfoo',
		'ls >/dev/null/x',
		'cat a -o b',
		'ls (cd x)',
		'{ ls; rm x; }',
		'sort a',
		'uniq a b',
		'tree -o f',
		'file -C x',
	];
	for (const command of bypasses) assert.equal(cursor.judge(shell(command)).kind, 'unsafe', command);
});

test('Cursor judge takes the first key that ends in ToolCall as the tool kind, whatever metadata keys come first', () => {
	const event = { type: 'tool_call', subtype: 'started', tool_call: { futureMetadata: { a: 1 }, hookAdditionalContexts: [], toolCallId: 'c1', startedAtMs: 1, mcpToolCall: { args: {} } } };
	assert.deepEqual(cursor.judge(event), { kind: 'unsafe', tool: 'mcp', cmd: '' });
	const read = { type: 'tool_call', subtype: 'started', tool_call: { futureMetadata: 1, globToolCall: { args: {} } } };
	assert.deepEqual(cursor.judge(read), { kind: 'ok' });
	const noKind = { type: 'tool_call', subtype: 'started', tool_call: { futureMetadata: 1, somethingElse: { args: {} } } };
	assert.deepEqual(cursor.judge(noKind), { kind: 'unsafe', tool: 'unknown', cmd: '' });
});

test('Cursor judge ignores a stream line that is not an object', () => {
	for (const value of [null, 42, 'text', true, []]) assert.deepEqual(cursor.judge(value), { kind: 'ok' });
});

test('Cursor judge allows only known read-only tool kinds and stops at any other kind', () => {
	for (const kind of ['readToolCall', 'globToolCall', 'grepToolCall', 'lsToolCall', 'getMcpToolsToolCall', 'semSearchToolCall']) {
		assert.deepEqual(cursor.judge(toolCall(kind, {})), { kind: 'ok' }, kind);
	}
	assert.deepEqual(cursor.judge(toolCall('fooToolCall', {})), { kind: 'unsafe', tool: 'foo', cmd: '' });
	assert.deepEqual(cursor.judge(toolCall('todoToolCall', { path: '/x' })), { kind: 'unsafe', tool: 'todo', cmd: '/x' });
	assert.deepEqual(cursor.judge({ type: 'tool_call', subtype: 'started', tool_call: {} }), { kind: 'unsafe', tool: 'unknown', cmd: '' });
});

const folders = [];
test.after(() => folders.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-test-'));
	folders.push(dir);
	return dir;
}

function fakeBin(dir, name, body) {
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!${process.execPath}\n${body}`);
	fs.chmodSync(file, 0o755);
	return file;
}

function runScript(script, args, env = {}) {
	const base = { ...process.env };
	for (const key of ['CLAUDE_BIN', 'AGENT_BIN', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'FAKE_LOG', 'FAKE_PIDS', 'FAKE_SCENARIO']) delete base[key];
	return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...base, ...env }, timeout: 30000 });
}

const logLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const FAKE_CLAUDE = `
const fs = require('fs');
const args = process.argv.slice(2);
const sentinel = process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, sentinel: sentinel === undefined ? null : sentinel }) + '\\n');
const events = [{ type: 'system', subtype: 'init', skills: ['make-custom-app:make-app-question'] }];
if (args[1].includes('monday')) events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'make-custom-app:make-app-question' } }] } });
events.push({ type: 'result', total_cost_usd: 0.1, is_error: false });
console.log(events.map((e) => JSON.stringify(e)).join('\\n'));
`;

test('Claude parseArgs defaults to the clean condition, 2 turns, one run, and no stub', () => {
	const opts = claude.parseArgs([]);
	assert.equal(opts.condition, 'clean');
	assert.equal(opts.turns, 2);
	assert.equal(opts.repeat, 1);
	assert.deepEqual(opts.allow, []);
	assert.equal(opts.only, null);
	assert.equal(opts.stub, false);
	assert.equal(opts.dryRun, false);
	assert.equal(opts.noOrg, false);
});

test('Claude parseArgs reads every flag', () => {
	const opts = claude.parseArgs(['--condition', 'real', '--only', '1,2', '--repeat', '3', '--allow', 'A,B', '--turns', '4', '--stub', '--out', '/o', '--org', '/g', '--dry-run']);
	assert.deepEqual(opts, { condition: 'real', only: [1, 2], repeat: 3, allow: ['A', 'B'], turns: 4, stub: true, out: '/o', org: '/g', noOrg: false, dryRun: true, selftest: false });
	assert.equal(claude.parseArgs(['--no-org']).noOrg, true);
	assert.equal(claude.parseArgs(['--selftest']).selftest, true);
});

test('Claude parseArgs rejects bad numbers, unknown flags, missing values, and unknown ids', () => {
	const bad = [
		[['--only', 'abc'], /--only/],
		[['--only', '1,x'], /--only/],
		[['--only', '99'], /99/],
		[['--repeat', 'abc'], /--repeat/],
		[['--repeat', '0'], /--repeat/],
		[['--turns', '0'], /--turns/],
		[['--turns', '1.5'], /--turns/],
		[['--condition', 'fast'], /--condition/],
		[['--bogus'], /Unknown flag "--bogus"/],
		[['--only'], /Missing value for --only/],
		[['--only', '--stub'], /Missing value for --only/],
		[['--org', '/x', '--no-org'], /--org or --no-org/],
	];
	for (const [args, pattern] of bad) assert.throws(() => claude.parseArgs(args), pattern, args.join(' '));
});

test('Cursor parseArgs defaults to plan mode and 4 agents, and reads every flag', () => {
	assert.deepEqual(cursor.parseArgs([]), { mode: 'plan', parallel: 4, only: null, noRepo: false, noOrg: false, org: null, out: null, selftest: false });
	assert.deepEqual(cursor.parseArgs(['--mode', 'ask', '--parallel', '2', '--only', '3,4', '--no-repo', '--no-org', '--out', '/o']), {
		mode: 'ask',
		parallel: 2,
		only: [3, 4],
		noRepo: true,
		noOrg: true,
		org: null,
		out: '/o',
		selftest: false,
	});
});

test('Cursor parseArgs rejects bad numbers, modes, unknown flags, and missing values', () => {
	const bad = [
		[['--parallel', '0'], /--parallel/],
		[['--parallel', 'abc'], /--parallel/],
		[['--only', 'abc'], /--only/],
		[['--only', '99'], /99/],
		[['--mode', 'fast'], /--mode/],
		[['--bogus'], /Unknown flag "--bogus"/],
		[['--out'], /Missing value for --out/],
		[['--org', '/x', '--no-org'], /--org or --no-org/],
	];
	for (const [args, pattern] of bad) assert.throws(() => cursor.parseArgs(args), pattern, args.join(' '));
});

test('both runners exit 2 with a message on a bad flag, before they do anything', () => {
	for (const script of [RUN_CLAUDE, RUN_CURSOR]) {
		for (const args of [['--only', 'abc'], ['--bogus'], ['--only']]) {
			const result = runScript(script, args);
			assert.equal(result.status, 2, `${path.basename(script)} ${args.join(' ')}`);
			assert.match(result.stderr, /--only|Unknown flag/);
		}
	}
	assert.equal(runScript(RUN_CLAUDE, ['--repeat', 'abc']).status, 2);
	assert.equal(runScript(RUN_CURSOR, ['--parallel', '0']).status, 2);
});

test('run-claude --dry-run prints the clean command with 2 turns, and creates no folder or file', () => {
	const dir = tempDir();
	const out = path.join(dir, 'out');
	const result = runScript(RUN_CLAUDE, ['--only', '1', '--stub', '--out', out, '--org', path.join(dir, 'org'), '--dry-run'], { CLAUDE_BIN: 'fake-claude' });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^1 fake-claude -p /);
	assert.match(result.stdout, /--max-turns 2 /);
	assert.match(result.stdout, /--setting-sources project/);
	assert.ok(result.stdout.includes(`--plugin-dir ${path.join(dir, 'org')}`));
	assert.ok(result.stdout.includes(`--mcp-config ${path.join(out, 'jira-stub.mcp.json')}`));
	assert.equal(fs.existsSync(out), false);
	assert.deepEqual(fs.readdirSync(dir), []);
});

test('run-claude runs the clean condition by default, with the sentinel set, and writes results and the stub config', () => {
	const dir = tempDir();
	const bin = fakeBin(dir, 'fake-claude.js', FAKE_CLAUDE);
	const log = path.join(dir, 'log.jsonl');
	const out = path.join(dir, 'out');
	const result = runScript(RUN_CLAUDE, ['--only', '1,21', '--stub', '--turns', '3', '--allow', 'Extra', '--out', out, '--no-org'], { CLAUDE_BIN: bin, FAKE_LOG: log });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /condition=clean positives selecting a make-app skill: 1\/1; exact expected: 1\/1; negatives clean: 1\/1/);
	const calls = logLines(log);
	assert.equal(calls.length, 2);
	for (const call of calls) {
		assert.equal(call.sentinel, '1');
		assert.equal(call.args[call.args.indexOf('--max-turns') + 1], '3');
		assert.equal(call.args[call.args.indexOf('--allowedTools') + 1], 'Skill,Extra,mcp__jira-stub__getJiraIssue');
		assert.equal(call.args.includes('--setting-sources'), true);
		assert.equal(call.args.includes('--strict-mcp-config'), true);
		assert.deepEqual(call.args.filter((a, i) => call.args[i - 1] === '--plugin-dir'), [path.join(__dirname, '..', '..')]);
	}
	const results = JSON.parse(fs.readFileSync(path.join(out, 'results-clean.json'), 'utf8'));
	assert.deepEqual(results.map((r) => [r.id, r.picked, r.pass]), [[1, 'make-custom-app:make-app-question', true], [21, null, true]]);
	const stub = JSON.parse(fs.readFileSync(path.join(out, 'jira-stub.mcp.json'), 'utf8'));
	assert.deepEqual(stub.mcpServers['jira-stub'].args, [STUB]);
	assert.ok(path.isAbsolute(stub.mcpServers['jira-stub'].args[0]));
});

test('run-claude --condition real sets no sentinel and loads no plugin directory', () => {
	const dir = tempDir();
	const bin = fakeBin(dir, 'fake-claude.js', FAKE_CLAUDE);
	const log = path.join(dir, 'log.jsonl');
	const result = runScript(RUN_CLAUDE, ['--condition', 'real', '--only', '1', '--out', path.join(dir, 'out'), '--org', '/not/used'], { CLAUDE_BIN: bin, FAKE_LOG: log });
	assert.equal(result.status, 0, result.stderr);
	const [call] = logLines(log);
	assert.equal(call.sentinel, null);
	assert.equal(call.args.includes('--plugin-dir'), false);
	assert.equal(call.args[call.args.indexOf('--max-turns') + 1], '2');
	assert.equal(fs.existsSync(path.join(dir, 'out', 'results-real.json')), true);
});

test('run-claude exits 2 when the binary or the org folder is missing, and writes no results', () => {
	const dir = tempDir();
	const missingBin = runScript(RUN_CLAUDE, ['--only', '1', '--out', path.join(dir, 'a'), '--no-org'], { CLAUDE_BIN: path.join(dir, 'no-such-claude') });
	assert.equal(missingBin.status, 2);
	assert.match(missingBin.stderr, /Cannot start .*no-such-claude\. Put claude on the PATH or set CLAUDE_BIN\./);
	assert.equal(fs.existsSync(path.join(dir, 'a', 'results-clean.json')), false);
	const missingOrg = runScript(RUN_CLAUDE, ['--only', '1', '--out', path.join(dir, 'b'), '--org', path.join(dir, 'no-org')], { CLAUDE_BIN: 'fake-claude' });
	assert.equal(missingOrg.status, 2);
	assert.match(missingOrg.stderr, /org plugin folder .* does not exist/);
});

const FAKE_AGENT = `
const fs = require('fs');
const { spawn } = require('child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args }) + '\\n');
if (process.env.FAKE_PIDS) {
	const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
	fs.writeFileSync(process.env.FAKE_PIDS, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
}
const call = (tool, a) => ({ type: 'tool_call', subtype: 'started', tool_call: { [tool]: { args: a }, toolCallId: 'c', startedAtMs: 1 } });
const events = [{ type: 'system', subtype: 'init', model: 'fake-model' }];
const scenario = process.env.FAKE_SCENARIO || 'skill';
if (scenario === 'skill') events.push(call('readToolCall', { path: '/x/skills/make-app-question/SKILL.md' }));
if (scenario === 'unsafe') events.push(call('shellToolCall', { command: 'node x.js' }));
if (scenario === 'unknown') events.push(call('fooToolCall', {}));
if (scenario === 'many') for (let i = 0; i < 14; i++) events.push(call('readToolCall', { path: '/x/foo.md' }));
if (scenario === 'finish') events.push({ type: 'result' });
if (scenario === 'nulls') process.stdout.write('null\\n42\\n"text"\\n[]\\ntrue\\n');
if (scenario === 'nulls') events.push(call('readToolCall', { path: '/x/skills/make-app-question/SKILL.md' }));
process.stdout.write(events.map((e) => JSON.stringify(e)).join('\\n') + '\\n');
setTimeout(() => process.exit(0), 20000);
`;

function agentRun(scenario, args = ['--only', '1'], env = {}) {
	const dir = tempDir();
	const bin = fakeBin(dir, 'fake-agent.js', FAKE_AGENT);
	const log = path.join(dir, 'log.jsonl');
	const out = path.join(dir, 'out');
	const result = runScript(RUN_CURSOR, [...args, '--out', out, '--no-org'], { AGENT_BIN: bin, FAKE_LOG: log, FAKE_SCENARIO: scenario, ...env });
	return { dir, log, out, result };
}

const resultsOf = (out, mode = 'plan') => JSON.parse(fs.readFileSync(path.join(out, `results-cursor-${mode}.json`), 'utf8'));

test('run-cursor runs in plan mode by default in an empty workspace under the out folder, and records the skill read', () => {
	const { log, out, result } = agentRun('skill');
	assert.equal(result.status, 0, result.stderr);
	const [call] = logLines(log);
	assert.equal(call.args[call.args.indexOf('--mode') + 1], 'plan');
	assert.equal(call.args[call.args.indexOf('--workspace') + 1], path.join(out, 'cursor-ws'));
	assert.equal(call.args.includes('--trust'), true);
	assert.deepEqual(call.args.filter((a, i) => call.args[i - 1] === '--plugin-dir'), [path.join(__dirname, '..', '..')]);
	const [row] = resultsOf(out);
	assert.equal(row.picked, 'make-app-question');
	assert.equal(row.stoppedBy, 'skill-read');
	assert.equal(row.model, 'fake-model');
	assert.match(result.stdout, /cursor positives selecting a make-app skill: 1\/1/);
	assert.match(result.stdout, /missed positives stopped by unsafe-tool: 0;/);
});

test('run-cursor --mode ask and --no-repo are passed on', () => {
	const { log, result } = agentRun('finish', ['--only', '1', '--mode', 'ask', '--no-repo']);
	assert.equal(result.status, 0, result.stderr);
	const [call] = logLines(log);
	assert.equal(call.args[call.args.indexOf('--mode') + 1], 'ask');
	assert.equal(call.args.includes('--plugin-dir'), false);
});

test('run-cursor stops a run at the tenth tool call and keeps the count at 10', () => {
	const { out, result } = agentRun('many');
	assert.equal(result.status, 0, result.stderr);
	const [row] = resultsOf(out);
	assert.equal(row.stoppedBy, 'max-calls');
	assert.equal(row.calls, 10);
});

test('run-cursor stops at the first unsafe call and at an unknown tool kind, and records them', () => {
	const stopped = agentRun('unsafe');
	const unsafe = resultsOf(stopped.out);
	assert.equal(unsafe[0].stoppedBy, 'unsafe-tool:shell');
	assert.equal(unsafe[0].unsafeCmd, 'node x.js');
	assert.match(stopped.result.stdout, /negatives clean: 0\/0; missed positives stopped by unsafe-tool: 1; model: fake-model/);
	const unknown = resultsOf(agentRun('unknown').out);
	assert.equal(unknown[0].stoppedBy, 'unsafe-tool:foo');
});

test('run-cursor kills the whole process group of the agent when it stops a run', async () => {
	const dir = tempDir();
	const pids = path.join(dir, 'pids.json');
	const { result } = agentRun('unsafe', ['--only', '1'], { FAKE_PIDS: pids });
	assert.equal(result.status, 0, result.stderr);
	const { child, grandchild } = JSON.parse(fs.readFileSync(pids, 'utf8'));
	const alive = (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	try {
		for (let i = 0; i < 40 && (alive(child) || alive(grandchild)); i++) await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(alive(child), false, 'the agent process is still running');
		assert.equal(alive(grandchild), false, 'a child of the agent is still running');
	} finally {
		for (const pid of [child, grandchild]) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				// already gone
			}
		}
	}
});

test('run-cursor exits 2 at once when the agent binary is missing, and writes no results', () => {
	const dir = tempDir();
	const out = path.join(dir, 'out');
	const started = Date.now();
	const result = runScript(RUN_CURSOR, ['--only', '1', '--out', out, '--no-org'], { AGENT_BIN: path.join(dir, 'no-such-agent') });
	assert.equal(result.status, 2);
	assert.ok(Date.now() - started < 15000, 'it waited for the timeout');
	assert.match(result.stderr, /Cannot start agent\. Put agent on the PATH or set AGENT_BIN\./);
	assert.equal(fs.existsSync(path.join(out, 'results-cursor-plan.json')), false);
});

test('run-cursor ignores stream lines that are null or not objects', () => {
	const { out, result } = agentRun('nulls');
	assert.equal(result.status, 0, result.stderr);
	assert.equal(resultsOf(out)[0].picked, 'make-app-question');
});

test('processError names a spawn error, a signal, and a non-zero exit, and is null for a clean exit', () => {
	assert.equal(claude.processError({ error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGTERM' }), 'ETIMEDOUT');
	assert.equal(claude.processError({ error: { code: 'EACCES' }, status: null }), 'EACCES');
	assert.equal(claude.processError({ error: new Error('spawn failed'), status: null }), 'spawn failed');
	assert.equal(claude.processError({ status: null, signal: 'SIGKILL' }), 'signal SIGKILL');
	assert.equal(claude.processError({ status: 1 }), 'exit 1');
	assert.equal(claude.processError({ status: 0 }), null);
});

test('run-claude records and shows a binary that cannot be executed', () => {
	const dir = tempDir();
	const bin = path.join(dir, 'not-executable');
	fs.writeFileSync(bin, '#!/bin/sh\n');
	fs.chmodSync(bin, 0o644);
	const out = path.join(dir, 'out');
	const result = runScript(RUN_CLAUDE, ['--only', '1', '--out', out, '--no-org'], { CLAUDE_BIN: bin });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^1\tpositive\texpect=question\tpicked=none\tFAIL \(not the expected skill\)\t\[EACCES\]/m);
	assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'results-clean.json'), 'utf8'))[0].error, 'EACCES');
});

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function waitFor(condition, timeoutMs = 10000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

function readPids(file) {
	try {
		const pids = JSON.parse(fs.readFileSync(file, 'utf8'));
		return pids.child && pids.grandchild ? pids : null;
	} catch {
		return null;
	}
}

function killQuietly(pids) {
	for (const pid of pids ? [pids.child, pids.grandchild] : []) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// already gone
		}
	}
}

function cleanEnv(extra) {
	const base = { ...process.env };
	for (const key of ['CLAUDE_BIN', 'AGENT_BIN', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'FAKE_LOG', 'FAKE_PIDS', 'FAKE_SCENARIO']) delete base[key];
	return { ...base, ...extra };
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
	test(`run-cursor stops the agent and its children when the runner gets ${signal}`, async () => {
		const dir = tempDir();
		const bin = fakeBin(dir, 'fake-agent.js', FAKE_AGENT);
		const pidsFile = path.join(dir, 'pids.json');
		const env = cleanEnv({ AGENT_BIN: bin, FAKE_LOG: path.join(dir, 'log.jsonl'), FAKE_SCENARIO: 'wait', FAKE_PIDS: pidsFile });
		const runner = spawn(process.execPath, [RUN_CURSOR, '--only', '1', '--out', path.join(dir, 'out'), '--no-org'], { env, stdio: 'ignore' });
		const exited = new Promise((resolve) => runner.on('exit', (code, name) => resolve({ code, name })));
		let pids = null;
		try {
			assert.ok(await waitFor(() => (pids = readPids(pidsFile)) !== null), 'the fake agent did not start');
			runner.kill(signal);
			const { code } = await exited;
			assert.equal(code, 128 + os.constants.signals[signal]);
			assert.ok(await waitFor(() => !alive(pids.child) && !alive(pids.grandchild), 5000), 'the agent or its child is still running');
		} finally {
			runner.kill('SIGKILL');
			killQuietly(pids);
		}
	});
}

test('a runner that exits normally while an agent is still running does not leave it behind', async () => {
	const dir = tempDir();
	const bin = fakeBin(dir, 'fake-agent.js', FAKE_AGENT);
	const pidsFile = path.join(dir, 'pids.json');
	const driver = path.join(dir, 'driver.js');
	fs.writeFileSync(
		driver,
		`const fs = require('fs');
const cursor = require(${JSON.stringify(RUN_CURSOR)});
cursor.installCleanup();
cursor.runOne(process.env.AGENT_BIN, { id: 1, kind: 'positive', expect: 'any', prompt: 'x' }, { mode: 'plan', workspace: process.env.WS, repo: null, org: null });
const timer = setInterval(() => {
	try {
		const pids = JSON.parse(fs.readFileSync(process.env.FAKE_PIDS, 'utf8'));
		if (pids.child && pids.grandchild) {
			clearInterval(timer);
			process.exit(0);
		}
	} catch {
		// not written yet
	}
}, 25);
`,
	);
	fs.mkdirSync(path.join(dir, 'ws'));
	const env = cleanEnv({ AGENT_BIN: bin, FAKE_LOG: path.join(dir, 'log.jsonl'), FAKE_SCENARIO: 'wait', FAKE_PIDS: pidsFile, WS: path.join(dir, 'ws') });
	const result = spawnSync(process.execPath, [driver], { env, encoding: 'utf8', timeout: 30000 });
	const pids = readPids(pidsFile);
	try {
		assert.equal(result.status, 0, result.stderr);
		assert.ok(pids, 'the fake agent did not start');
		assert.ok(await waitFor(() => !alive(pids.child) && !alive(pids.grandchild), 5000), 'the agent or its child is still running');
	} finally {
		killQuietly(pids);
	}
});
