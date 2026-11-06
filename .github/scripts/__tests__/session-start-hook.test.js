'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'hooks', 'session-start.js');
const { CONTEXT, render } = require(SCRIPT);

const SKILLS_DIR = path.join(__dirname, '..', '..', '..', 'skills');
const SKILLS = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
// The sentence measured in the Cursor trigger test (spec 11 item 8). A change here voids that measurement.
const MEASURED =
	'Skills for Make custom app work (IMLJSON, the Make Apps SDK, your own custom app with or without a Jira ticket, an app slug): make-app-question, make-app-code-review, make-app-bug-investigation, make-app-feature-request, make-app-task, make-app-endpoint, make-app-run-live, make-app-task-refinement (feasibility and plans, Preparation tickets), make-app-setup. They sync the app source themselves, so use the matching skill instead of searching the file system for the app.';

function runClosedStdin(env = {}) {
	return spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, env: { ...process.env, ...env } });
}

test('it exits 0, prints one JSON line and nothing on stderr', () => {
	const r = runClosedStdin();
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stderr, '');
	assert.match(r.stdout, /^[^\n]+\n$/);
	assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test('the JSON object has the key additional_context only, and its text is CONTEXT', () => {
	const parsed = JSON.parse(runClosedStdin().stdout);
	assert.deepEqual(Object.keys(parsed), ['additional_context']);
	assert.equal(parsed.additional_context, CONTEXT);
});

test('CONTEXT is the measured sentence', () => {
	assert.equal(CONTEXT, MEASURED);
});

test('CONTEXT names all nine skills', () => {
	assert.equal(SKILLS.length, 9);
	for (const name of SKILLS) assert.match(CONTEXT, new RegExp(`(?<![\\w-])${name}(?![\\w-])`), name);
});

test('CONTEXT stays short and on one line', () => {
	assert.ok(CONTEXT.length < 600, `${CONTEXT.length} characters`);
	assert.doesNotMatch(CONTEXT, /[\r\n]/);
});

test('render() returns the same object that the script prints', () => {
	assert.deepEqual(render(), { additional_context: CONTEXT });
	assert.deepEqual(JSON.parse(runClosedStdin().stdout), render());
});

test('the output does not depend on the editor environment', () => {
	const plain = runClosedStdin({ CLAUDECODE: '', CURSOR_AGENT: '', CURSOR_PLUGIN_ROOT: '' }).stdout;
	assert.equal(runClosedStdin({ CLAUDECODE: '1' }).stdout, plain);
	assert.equal(runClosedStdin({ CURSOR_AGENT: '1', CURSOR_PLUGIN_ROOT: '/somewhere' }).stdout, plain);
});

test('it does not wait for stdin that stays open', async () => {
	const child = spawn(process.execPath, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
	let stdout = '';
	child.stdout.on('data', (chunk) => (stdout += chunk));
	const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
	const [code, signal] = await new Promise((resolve) => child.on('close', (c, s) => resolve([c, s])));
	clearTimeout(timer);
	assert.equal(signal, null, 'the script was still running after 5 seconds');
	assert.equal(code, 0);
	assert.equal(stdout, `${JSON.stringify({ additional_context: CONTEXT })}\n`);
});
