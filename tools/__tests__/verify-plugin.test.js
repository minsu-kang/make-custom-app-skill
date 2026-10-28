'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MARKETPLACE_URL, PLUGIN_ID, runInstall, runLive, format } = require('../verify-plugin.js');
const { SKILLS, MCP_SERVERS, REQUIRED_FILES, LIVE_SKILL, liveCommands } = require('../lib/verify-checks.js');

const folders = [];
test.after(() => folders.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function folder() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-plugin-test-'));
	folders.push(dir);
	return dir;
}

function root() {
	const dir = folder();
	fs.mkdirSync(path.join(dir, '.claude-plugin'));
	fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{"version":"3.0.0"}');
	fs.mkdirSync(path.join(dir, 'mcp'));
	fs.writeFileSync(path.join(dir, 'mcp', 'index.mjs'), 'bundle');
	return dir;
}

/** A stand-in for exec: records every call and answers the way git and claude do when all is well, unless `answers` says otherwise. */
function fakeRun(tmp, answers = {}) {
	const calls = [];
	const installPath = path.join(tmp, 'config', 'installed');
	const run = (command, args, options = {}) => {
		calls.push({ command, args, options });
		const key = command === 'git' ? 'git' : args[0] === '-p' ? '-p' : args.slice(0, 2).join(' ');
		if (answers[key]) return answers[key];
		if (key === 'plugin install') {
			for (const file of [...REQUIRED_FILES, ...SKILLS.map((s) => `skills/${s}/SKILL.md`)]) {
				fs.mkdirSync(path.dirname(path.join(installPath, file)), { recursive: true });
				fs.writeFileSync(path.join(installPath, file), file === 'mcp/index.mjs' ? 'bundle' : 'x');
			}
		}
		if (key === 'plugin list') return { status: 0, stdout: JSON.stringify([{ id: PLUGIN_ID, version: '3.0.0', installPath, mcpServers: Object.fromEntries(MCP_SERVERS.map((s) => [s, {}])) }]), stderr: '' };
		if (key === 'plugin details') return { status: 0, stdout: `  Skills (9)  ${SKILLS.join(', ')}\n`, stderr: '' };
		return { status: 0, stdout: '', stderr: '' };
	};
	run.calls = calls;
	return run;
}

test('runInstall clones the repository, serves it under a made-up address, installs, and inspects the install', () => {
	const tmp = folder();
	const run = fakeRun(tmp);
	const repo = root();
	const results = runInstall({ root: repo, claude: 'claude-x', tmp, run });
	assert.deepEqual(results.filter((r) => !r.ok), []);
	assert.deepEqual(run.calls.map((c) => [c.command, ...c.args].join(' ')), [
		`git clone --quiet --bare ${repo} ${path.join(tmp, 'bare.git')}`,
		`claude-x plugin marketplace add ${MARKETPLACE_URL}`,
		`claude-x plugin install ${PLUGIN_ID}`,
		'claude-x plugin list --json',
		'claude-x plugin details make-custom-app',
		`claude-x plugin validate ${path.join(tmp, 'config', 'installed')}`,
	]);
	const env = run.calls[1].options.env;
	assert.equal(env.CLAUDE_CONFIG_DIR, path.join(tmp, 'config'));
	assert.equal(env.GIT_CONFIG_COUNT, '1');
	assert.equal(env.GIT_CONFIG_KEY_0, `url.${path.join(tmp, 'bare.git')}.insteadOf`);
	assert.equal(env.GIT_CONFIG_VALUE_0, MARKETPLACE_URL);
	assert.equal(run.calls[0].options.env, undefined, 'the clone does not get the git override');
});

test('runInstall stops at the first failing step and reports its first line', () => {
	const tmp = folder();
	for (const [key, name] of [
		['git', 'the repository can be cloned'],
		['plugin marketplace', 'claude plugin marketplace add succeeds'],
		['plugin install', `claude plugin install ${PLUGIN_ID} succeeds`],
	]) {
		const run = fakeRun(tmp, { [key]: { status: 1, stdout: '', stderr: '\nsomething broke\nmore' } });
		const results = runInstall({ root: root(), claude: 'claude-x', tmp: folder(), run });
		assert.deepEqual(results, [{ name, ok: false, detail: 'something broke' }]);
	}
});

test('runInstall reports an answer of plugin list that is not JSON', () => {
	const tmp = folder();
	const results = runInstall({ root: root(), claude: 'claude-x', tmp, run: fakeRun(tmp, { 'plugin list': { status: 0, stdout: 'not json', stderr: '' } }) });
	assert.deepEqual(results.map((r) => r.name), ['claude plugin list --json answers with JSON']);
});

test('runLive starts one session with --plugin-dir, project settings only, and the permission prompt, and checks what it saw', () => {
	const tmp = folder();
	const r = root();
	const ok = { type: 'tool_result', content: 'fine', is_error: false };
	const lines = [
		{ type: 'system', subtype: 'init', skills: SKILLS.map((s) => `make-custom-app:${s}`), mcp_servers: [{ name: 'plugin:make-custom-app:make-app-context', status: 'connected' }], plugins: [{ name: 'make-custom-app', version: '3.0.0' }] },
		{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's', name: 'Skill', input: { skill: LIVE_SKILL } }] } },
		{ type: 'user', message: { content: [{ ...ok, tool_use_id: 's' }] } },
		...liveCommands(r).flatMap((c, i) => [
			{ type: 'assistant', message: { content: [{ type: 'tool_use', id: `b${i}`, name: 'Bash', input: { command: c.text } }] } },
			{ type: 'user', message: { content: [c.expect === 'run' ? { ...ok, tool_use_id: `b${i}` } : { type: 'tool_result', tool_use_id: `b${i}`, is_error: true, content: "Permission to use Bash has been denied because Claude Code is running in don't ask mode." }] } },
		]),
	].map((e) => JSON.stringify(e)).join('\n');
	const run = fakeRun(tmp, { '-p': { status: 0, stdout: lines, stderr: '' } });
	const results = runLive({ root: r, claude: 'claude-x', tmp, run });
	assert.deepEqual(results.filter((x) => !x.ok), []);
	const [call] = run.calls;
	assert.equal(call.command, 'claude-x');
	const args = call.args;
	assert.equal(args[args.indexOf('--plugin-dir') + 1], r);
	assert.equal(args[args.indexOf('--setting-sources') + 1], 'project');
	assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
	assert.equal(args[args.indexOf('--allowedTools') + 1], 'Skill,Read');
	assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
	assert.equal(call.options.cwd, path.join(tmp, 'live'));
});

test('runLive reports a session that never started', () => {
	const tmp = folder();
	const run = fakeRun(tmp, { '-p': { status: 1, stdout: '', stderr: 'Not logged in\n' } });
	assert.deepEqual(runLive({ root: root(), claude: 'claude-x', tmp, run }), [{ name: 'the model session started', ok: false, detail: 'Not logged in' }]);
});

test('format prints one PASS or FAIL line per check, with its detail', () => {
	assert.equal(format([{ name: 'a', ok: true, detail: 'x' }, { name: 'b', ok: false, detail: '' }]), 'PASS  a (x)\nFAIL  b');
});
