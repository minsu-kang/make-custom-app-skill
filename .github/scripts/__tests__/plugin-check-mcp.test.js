'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'plugin-check.js');
const REAL_MCP_JSON = path.join(__dirname, '..', '..', '..', 'mcp.json');

const GOOD = {
	mcpServers: {
		'make-app-context': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/index.mjs'] },
		make: { type: 'http', url: 'https://mcp.make.com/v2' },
		atlassian: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' },
	},
};

/** A copy of GOOD with `change(servers)` applied. */
function config(change) {
	const copy = JSON.parse(JSON.stringify(GOOD));
	change(copy.mcpServers);
	return `${JSON.stringify(copy, null, 2)}\n`;
}

function run(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-mcp-'));
	try {
		for (const [rel, body] of Object.entries(files)) {
			const abs = path.join(root, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, body);
		}
		const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
		return { status: r.status, out: r.stdout };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const withMcp = (text, extra = {}) => ({ 'mcp.json': text, 'mcp/index.mjs': '// bundle\n', ...extra });

test('the mcp.json of this repository passes', () => {
	const r = run(withMcp(fs.readFileSync(REAL_MCP_JSON, 'utf8')));
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /0 error\(s\)/);
});

test('a repository without mcp.json is not checked for it', () => {
	assert.equal(run({}).status, 0);
});

test('invalid JSON and a missing mcpServers object are errors', () => {
	assert.match(run(withMcp('{ nope')).out, /mcp\.json: is not valid JSON/);
	assert.match(run(withMcp('null')).out, /has no mcpServers object/);
	assert.match(run(withMcp('{"mcpServers": []}')).out, /has no mcpServers object/);
});

test('the three servers of spec 7.1 are required and no other is allowed', () => {
	const missing = run(withMcp(config((s) => delete s.atlassian)));
	assert.equal(missing.status, 1);
	assert.match(missing.out, /server "atlassian" is missing/);
	const extra = run(withMcp(config((s) => (s.other = { type: 'http', url: 'https://example.com' }))));
	assert.match(extra.out, /unexpected server "other"/);
	assert.match(run(withMcp(config((s) => (s.make = null)))).out, /server "make" is not an object/);
});

test('a remote server needs type http and its exact address', () => {
	const noType = run(withMcp(config((s) => delete s.make.type)));
	assert.match(noType.out, /server "make" needs "type": "http"/);
	const bare = run(withMcp(config((s) => (s.make.url = 'https://mcp.make.com'))));
	assert.match(bare.out, /server "make" must use https:\/\/mcp\.make\.com\/v2/);
	const v2 = run(withMcp(config((s) => (s.atlassian.url = 'https://mcp.atlassian.com/v2/mcp'))));
	assert.match(v2.out, /server "atlassian" must use https:\/\/mcp\.atlassian\.com\/v1\/mcp/);
});

test('the local server runs node on a bundle that exists under the plugin root', () => {
	assert.match(run(withMcp(config((s) => (s['make-app-context'].command = 'bash')))).out, /must run node/);
	assert.match(run(withMcp(config((s) => (s['make-app-context'].args = ['mcp/index.mjs'])))).out, /must start \$\{CLAUDE_PLUGIN_ROOT\}\//);
	assert.match(run(withMcp(config((s) => delete s['make-app-context'].args))).out, /must start \$\{CLAUDE_PLUGIN_ROOT\}\//);
	const gone = run({ 'mcp.json': config(() => {}) });
	assert.equal(gone.status, 1);
	assert.match(gone.out, /points at mcp\/index\.mjs, which does not exist/);
});

test('no environment, no headers, no other placeholder and no secret in mcp.json', () => {
	assert.match(run(withMcp(config((s) => (s['make-app-context'].env = { A: 'b' })))).out, /server "make-app-context" has env/);
	assert.match(run(withMcp(config((s) => (s.make.headers = { Authorization: 'x' })))).out, /server "make" has headers/);
	const placeholder = run(withMcp(config((s) => (s['make-app-context'].args = ['${CLAUDE_PLUGIN_ROOT}/mcp/index.mjs', '${HOME}']))));
	assert.match(placeholder.out, /the placeholder named HOME is not allowed/);
	const secret = run(withMcp(config((s) => (s['make-app-context'].args = ['${CLAUDE_PLUGIN_ROOT}/mcp/index.mjs', 'sk-abcdefghijklmnop']))));
	assert.match(secret.out, /looks like a secret/);
	for (const key of ['pcsk_abcdefghijklmnop', 'ATATT3xabcdefghij']) {
		const shaped = run(withMcp(config((s) => (s['make-app-context'].args = ['${CLAUDE_PLUGIN_ROOT}/mcp/index.mjs', key]))));
		assert.equal(shaped.status, 1, key);
		assert.match(shaped.out, /looks like a secret/, key);
	}
});

test('ordinary words that contain sk- are not taken for a secret', () => {
	for (const word of ['risk-assessment.mjs', 'desk-organizer-tool']) {
		const r = run(withMcp(config((s) => (s['make-app-context'].args = ['${CLAUDE_PLUGIN_ROOT}/mcp/index.mjs', word]))));
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, /0 error\(s\)/);
	}
});

test('a server named like an inherited property is only an unexpected server', () => {
	const r = run(withMcp(config((s) => (s.toString = { type: 'http', url: 'https://example.com' }))));
	assert.match(r.out, /unexpected server "toString"/);
	assert.doesNotMatch(r.out, /must use/);
});
