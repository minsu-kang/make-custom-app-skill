'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SKILLS, MCP_SERVERS, REQUIRED_FILES, LIVE_SKILL, checkInstalled, liveCommands, livePrompt, checkLive } = require('../lib/verify-checks.js');

const folders = [];
test.after(() => folders.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function folder() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-checks-'));
	folders.push(dir);
	return dir;
}

function write(base, files) {
	for (const [rel, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
		fs.writeFileSync(path.join(base, rel), body);
	}
}

/** A repository root with a plugin.json and a bundle, and an install folder that holds what an install holds. */
function fixture({ version = '3.0.0', installedVersion = version, bundle = 'bundle' } = {}) {
	const root = folder();
	const install = folder();
	write(root, { '.claude-plugin/plugin.json': JSON.stringify({ version }), 'mcp/index.mjs': 'bundle' });
	const files = Object.fromEntries([...REQUIRED_FILES, ...SKILLS.map((s) => `skills/${s}/SKILL.md`)].map((f) => [f, 'x']));
	write(install, { ...files, 'mcp/index.mjs': bundle });
	const entry = { version: installedVersion, installPath: install, mcpServers: Object.fromEntries(MCP_SERVERS.map((s) => [s, {}])) };
	const details = `Component inventory\n  Skills (9)  ${SKILLS.join(', ')}\n  Agents (0)\n`;
	return { root, install, entry, details, validate: { status: 0, stdout: '' } };
}

const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);

test('checkInstalled passes for a complete install', () => {
	const f = fixture();
	const results = checkInstalled(f);
	assert.deepEqual(failed(results), []);
	assert.equal(results.length, 7);
});

test('checkInstalled fails when the installed version differs from plugin.json', () => {
	assert.deepEqual(failed(checkInstalled(fixture({ installedVersion: '2.9.0' }))), ['the plugin is installed at the version of plugin.json']);
});

test('checkInstalled stops at a missing install entry or folder', () => {
	const f = fixture();
	assert.deepEqual(failed(checkInstalled({ ...f, entry: undefined })), ['the plugin is installed at the version of plugin.json', 'the install folder exists']);
	assert.deepEqual(failed(checkInstalled({ ...f, entry: { ...f.entry, installPath: path.join(f.install, 'gone') } })), ['the install folder exists']);
});

test('checkInstalled names the files that are missing, a .git folder, and a bundle that differs', () => {
	const f = fixture({ bundle: 'other bundle' });
	fs.rmSync(path.join(f.install, 'skills', SKILLS[0]), { recursive: true });
	fs.mkdirSync(path.join(f.install, '.git'));
	const results = checkInstalled(f);
	assert.deepEqual(failed(results), ['the install folder holds the plugin files', 'the install folder has no .git', 'the installed MCP bundle equals the committed one']);
	assert.match(results.find((r) => r.name === 'the install folder holds the plugin files').detail, new RegExp(`missing: skills/${SKILLS[0]}/SKILL.md`));
});

test('checkInstalled compares the MCP servers, the skill list, and the validate exit code', () => {
	const f = fixture();
	assert.deepEqual(failed(checkInstalled({ ...f, entry: { ...f.entry, mcpServers: { make: {} } } })), ['the plugin declares the three MCP servers']);
	assert.deepEqual(failed(checkInstalled({ ...f, details: 'Skills (1)  make-app-task' })), ['the plugin lists the nine skills']);
	assert.deepEqual(failed(checkInstalled({ ...f, details: '' })), ['the plugin lists the nine skills']);
	assert.deepEqual(failed(checkInstalled({ ...f, validate: { status: 1, stdout: '' } })), ['claude plugin validate finds no error']);
});

test('liveCommands: two quoted pre-approved commands must run, the unquoted form and another script must be denied', () => {
	const commands = liveCommands('/r');
	assert.deepEqual(commands.map((c) => c.expect), ['run', 'denied', 'run', 'denied']);
	assert.equal(commands[0].text, 'node "/r/shared/scripts/check-setup.js" --json');
	assert.equal(commands[1].text, 'node /r/shared/scripts/check-setup.js');
	assert.match(livePrompt('/r'), new RegExp(`Invoke the ${LIVE_SKILL} skill`));
	for (const c of commands) assert.ok(livePrompt('/r').includes(c.text));
});

function summary(root, change = () => {}) {
	const ok = { isError: false, text: 'fine' };
	const denied = { isError: true, text: "Permission to use Bash has been denied because Claude Code is running in don't ask mode." };
	const s = {
		init: {
			skills: SKILLS.map((n) => `make-custom-app:${n}`),
			mcpServers: [{ name: 'plugin:make-custom-app:make-app-context', status: 'connected' }],
			plugins: [{ name: 'make-custom-app', version: '3.0.0' }],
		},
		calls: [
			{ name: 'Skill', input: { skill: LIVE_SKILL }, result: ok },
			...liveCommands(root).map((c) => ({ name: 'Bash', input: { command: c.text }, result: c.expect === 'run' ? { isError: true, text: 'Exit code 1\nUsage' } : denied })),
		],
		result: null,
	};
	change(s);
	return s;
}

test('checkLive passes for a session that behaves as designed (a failing but permitted command counts as run)', () => {
	const { root } = fixture();
	const results = checkLive({ root, summary: summary(root) });
	assert.deepEqual(failed(results), []);
	assert.equal(results.length, 8);
});

test('checkLive reports a missing init event, missing skills, a server that is not connected, and a wrong version', () => {
	const { root } = fixture();
	assert.deepEqual(failed(checkLive({ root, summary: { init: null, calls: [], result: null } })), ['the session started and reported its init event']);
	const results = checkLive({ root, summary: summary(root, (s) => {
		s.init.skills.pop();
		s.init.mcpServers[0].status = 'failed';
		s.init.plugins[0].version = '2.0.0';
	}) });
	assert.deepEqual(failed(results), ['the session lists the nine skills as make-custom-app:make-app-*', 'the make-app-context server is connected', 'the loaded plugin has the version of plugin.json']);
});

test('checkLive fails a command that was permitted when it must be denied, one denied when it must run, and one never issued', () => {
	const { root } = fixture();
	const permitted = { isError: false, text: 'ran' };
	const refused = { isError: true, text: "Permission to use Bash has been denied because Claude Code is running in don't ask mode." };
	const results = checkLive({ root, summary: summary(root, (s) => {
		s.calls[1].result = refused; // first command: must run
		s.calls[2].result = permitted; // second command: must be denied
		s.calls.pop(); // fourth command never issued
	}) });
	const names = failed(results);
	assert.equal(names.length, 3);
	assert.ok(names[0].startsWith('runs: node "<root>/shared/scripts/check-setup.js"'));
	assert.ok(names[1].startsWith('is denied: node <root>/shared/scripts/check-setup.js'));
	assert.ok(names[2].startsWith('is denied: node "<root>/shared/scripts/download-app.js"'));
	assert.match(results.find((r) => r.name === names[2]).detail, /did not issue this exact command/);
});
