'use strict';

// The committed bundle must start with no node_modules and no network, and must pick its names and folders from the
// place it runs from. Each test copies mcp/index.mjs into a fake HOME that has no node_modules above it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listToolNames, callToolText } = require('../lib/mcp-stdio.js');

const BUNDLE = path.join(__dirname, '..', '..', 'mcp', 'index.mjs');
const TOOLS = ['get_app_summary', 'list_apps', 'search_app_knowledge', 'upsert_app_context', 'upsert_jira_ticket'];

/** A fake HOME with the bundle at `where` (a path relative to it), and the options that start it. */
function setup(where, extraEnv = {}) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bundle-'));
	try {
		const script = path.join(home, where);
		fs.mkdirSync(path.dirname(script), { recursive: true });
		fs.copyFileSync(BUNDLE, script);
		const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...extraEnv };
		return { home, options: { command: process.execPath, args: [script], env } };
	} catch (err) {
		fs.rmSync(home, { recursive: true, force: true });
		throw err;
	}
}

function seedContext(folder) {
	fs.mkdirSync(path.join(folder, 'demo-v1'), { recursive: true });
	fs.writeFileSync(path.join(folder, 'demo-v1', 'metadata.json'), JSON.stringify({ slug: 'demo', version: '1' }));
}

const PLUGIN_AT = path.join('.claude', 'plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0', 'mcp', 'index.mjs');
const OLD_AT = path.join('.claude', 'skills', 'make-custom-app', 'mcp-server', 'dist', 'index.mjs');

test('the bundle lists the five tools without node_modules', async () => {
	const { home, options } = setup(PLUGIN_AT);
	try {
		assert.deepEqual(await listToolNames(options), TOOLS);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test('as a plugin it reads ~/.make-custom-app/contexts and the keys of the secrets file', async () => {
	const { home, options } = setup(PLUGIN_AT);
	try {
		seedContext(path.join(home, '.make-custom-app', 'contexts'));
		const found = await callToolText(options, 'upsert_app_context', { slug: 'demo', version: '1' });
		assert.equal(found.isError, true);
		assert.match(found.text, /pinecone-api-key is not set\. Set MAKE_APP_CONTEXT_PINECONE_API_KEY/);
		const missing = await callToolText(options, 'upsert_app_context', { slug: 'ghost', version: '1' });
		assert.ok(missing.text.includes(path.join(home, '.make-custom-app', 'contexts', 'ghost-v1.md')), missing.text);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test('as a plugin it ignores the generic key names and the old contexts folder', async () => {
	const { home, options } = setup(PLUGIN_AT, { PINECONE_API_KEY: 'unrelated', OPENAI_API_KEY: 'unrelated' });
	try {
		seedContext(path.join(home, '.claude', 'make-app-contexts'));
		const result = await callToolText(options, 'upsert_app_context', { slug: 'demo', version: '1' });
		assert.match(result.text, /No context files found for demo-v1/);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test('placed like an old install it keeps the 2.3.12 folder and key names', async () => {
	const { home, options } = setup(OLD_AT);
	try {
		seedContext(path.join(home, '.claude', 'make-app-contexts'));
		const result = await callToolText(options, 'upsert_app_context', { slug: 'demo', version: '1' });
		assert.equal(result.isError, true);
		assert.match(result.text, /PINECONE_API_KEY is not set/);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
