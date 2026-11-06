'use strict';
/**
 * Test helper, not a test file. A mock Make API on 127.0.0.1 and a fake HOME for the entry scripts. seed() writes the
 * secrets file and a fresh mode cache (employee mode also the Jira check cache), so no script probes the token; run()
 * runs one entry script against the mock, and its promise rejects when a fake token shows up in the output. Routes map
 * "METHOD /path?query" (as the script sends it) to [status, body, headers] or to a function (req, body) returning that;
 * a string body is sent as text. An unrouted request gets 404.
 */
require('./isolate-home');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { cacheEntry, CACHE_FILE_NAME, TEST_ORIGIN_VAR } = require('../mode-logic');
const { cacheKey: accessKey, JIRA_BASE_URL } = require('../access-guard-logic');

const SCRIPTS_DIR = path.resolve(__dirname, '..', '..');
const FAKE_KEY = 'FAKEKEY_harness_SECRET';
const ZONE = 'eu1.make.com';
const EMAIL = 'dev@make.com';
const JIRA_TOKEN = 'FAKE_JIRA_TOKEN_harness';
/** A route answer that drops the connection instead of answering (a network error for the script). */
const DESTROY = Symbol('destroy');

function writeTree(dir, files) {
	for (const [rel, text] of Object.entries(files)) {
		const file = path.join(dir, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	}
}

const emptyLists = { modules: [], connections: [], webhooks: [], rpcs: [], functions: [], endpoints: [] };

async function createHarness() {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-harness-'));
	const h = { work, home: path.join(work, 'home'), tmp: path.join(work, 'tmp'), routes: {}, log: [] };
	for (const dir of [h.home, h.tmp]) fs.mkdirSync(dir);
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const key = `${req.method} ${req.url}`;
			h.log.push({ method: req.method, url: req.url, path: new URL(req.url, 'http://x').pathname, contentType: req.headers['content-type'] || null, auth: req.headers.authorization, body });
			let answer = h.routes[key];
			if (typeof answer === 'function') answer = answer(req, body);
			if (answer === DESTROY) return void req.socket.destroy();
			const [status, payload, headers] = answer || [404, { message: `unrouted ${key}` }];
			res.writeHead(status, { 'Content-Type': typeof payload === 'string' ? 'text/plain' : 'application/json', ...(headers || {}) });
			res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	h.port = server.address().port;
	h.contextsDir = () => path.join(h.home, '.make-custom-app', 'contexts');
	h.snapshotsDir = () => path.join(h.home, '.make-custom-app', 'snapshots');
	h.seed = ({ mode = 'public', secretsExtra = '', routes = {} } = {}) => {
		h.routes = routes;
		h.log = [];
		fs.rmSync(path.join(h.home, '.make-custom-app'), { recursive: true, force: true });
		const lines = [`make-api-key: ${FAKE_KEY}`, `make-zone: ${ZONE}`];
		if (mode === 'employee') {
			lines.push(`jira-email: ${EMAIL}`, `jira-api-token: ${JIRA_TOKEN}`);
			const key = accessKey({ baseUrl: JIRA_BASE_URL, email: EMAIL, token: JIRA_TOKEN });
			fs.writeFileSync(path.join(h.tmp, 'make-custom-app-access-check.json'), JSON.stringify({ key, email: EMAIL, checkedAt: Date.now() }));
		}
		fs.writeFileSync(path.join(h.home, '.make-custom-app-skill-secrets'), `${lines.join('\n')}\n${secretsExtra}`, { mode: 0o600 });
		fs.writeFileSync(path.join(h.tmp, CACHE_FILE_NAME), JSON.stringify(cacheEntry(ZONE, FAKE_KEY, mode, Date.now())));
	};
	h.writeWorkingCopy = ({ slug = 'my-app', version = 1, metadata = {}, files = {} } = {}) => {
		const dir = path.join(h.contextsDir(), `${slug}-v${version}`);
		writeTree(dir, { ...files, 'metadata.json': JSON.stringify({ slug, version: String(version), downloadedAt: new Date().toISOString(), ...emptyLists, ...metadata }, null, 2) });
		return dir;
	};
	h.writeSnapshot = ({ slug = 'my-app', version = 1, id = '20261105-120000', takenAt = new Date().toISOString(), metadata = {}, files = {} } = {}) => {
		const dir = path.join(h.snapshotsDir(), `${slug}-v${version}`, id);
		writeTree(dir, { ...files, 'metadata.json': JSON.stringify({ slug, version: String(version), downloadedAt: takenAt, ...emptyLists, ...metadata, snapshot: { id, takenAt } }, null, 2) });
		return dir;
	};
	h.run = async (script, args, { env = { CLAUDECODE: '1' } } = {}) => {
		const result = await new Promise((resolve) => {
			const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, script), ...args], {
				env: { PATH: process.env.PATH, HOME: h.home, USERPROFILE: h.home, TMPDIR: h.tmp, TEMP: h.tmp, TMP: h.tmp, [TEST_ORIGIN_VAR]: `http://127.0.0.1:${h.port}`, ...env },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (c) => (stdout += c));
			child.stderr.on('data', (c) => (stderr += c));
			const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
			child.on('close', (code) => {
				clearTimeout(timer);
				resolve({ code, stdout, stderr, out: stdout + stderr });
			});
		});
		for (const token of [FAKE_KEY, JIRA_TOKEN]) assert.ok(!result.out.includes(token), `${script}: a token leaked into the output`);
		return result;
	};
	h.close = () => {
		server.closeAllConnections();
		server.close();
		fs.rmSync(work, { recursive: true, force: true });
	};
	return h;
}

module.exports = { createHarness, DESTROY, FAKE_KEY, ZONE, SCRIPTS_DIR };
