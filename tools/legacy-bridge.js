#!/usr/bin/env node
'use strict';

// Bridge check for the old installers (CI job legacy-bridge, while install-claude.sh exists).
//
// mcp-server/ is also the payload of the 2.x installers: they copy its source into ~/.claude/skills/make-custom-app,
// run npm install and tsc there, and the old scripts keep writing the per-editor contexts folder. This script does
// that in a fake HOME and drives the built server over stdio:
//   1. install-claude.sh --update from this checkout
//   2. seed a context where the old tree writes it (the folder is taken from the old tree's own getEditorDir)
//   3. upsert_app_context must find the chunks and then stop at the missing Pinecone key
//
// The old download-app.js is not run: its version guard calls GitHub and its access guard calls Atlassian.
// Usage: node tools/legacy-bridge.js

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { listToolNames, callToolText } = require('./lib/mcp-stdio');

const ROOT = path.resolve(__dirname, '..');
const SLUG = 'bridge-demo';

function step(message) {
	console.log(`legacy-bridge: ${message}`);
}

async function main() {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-bridge-'));
	try {
		const env = { ...process.env, HOME: home, USERPROFILE: home };

		step('install-claude.sh --update in a fake HOME');
		const install = spawnSync('bash', [path.join(ROOT, 'install-claude.sh'), '--update'], { cwd: ROOT, env, encoding: 'utf8' });
		assert.equal(install.status, 0, `installer failed:\n${install.stdout}\n${install.stderr}`);

		const skillDir = path.join(home, '.claude', 'skills', 'make-custom-app');
		const server = path.join(skillDir, 'mcp-server', 'dist', 'index.js');
		assert.ok(fs.existsSync(server), `the installer did not build ${server}`);

		// Where the old scripts write: the editor folder comes from the installed script path, the name is fixed in download-app.js.
		const downloadApp = path.join(skillDir, 'scripts', 'download-app.js');
		assert.ok(fs.readFileSync(downloadApp, 'utf8').includes("'make-app-contexts'"), 'download-app.js no longer writes to make-app-contexts');
		const previousArgv1 = process.argv[1];
		process.argv[1] = downloadApp;
		const editorDir = require(path.join(ROOT, 'skill', 'scripts', 'lib', 'skill-root.js')).getEditorDir();
		process.argv[1] = previousArgv1;
		assert.equal(editorDir, '.claude');
		const contexts = path.join(home, editorDir, 'make-app-contexts');
		fs.mkdirSync(path.join(contexts, `${SLUG}-v1`), { recursive: true });
		fs.writeFileSync(path.join(contexts, `${SLUG}-v1.md`), '## App Overview\n\n- slug: bridge-demo\n');
		fs.writeFileSync(path.join(contexts, `${SLUG}-v1`, 'metadata.json'), JSON.stringify({ slug: SLUG, version: '1', label: 'Bridge demo' }));

		// The server starts with no keys, so a found context ends at the Pinecone step.
		const options = { command: process.execPath, args: [server], env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home } };

		step('tools/list');
		assert.deepEqual(await listToolNames(options), ['get_app_summary', 'list_apps', 'search_app_knowledge', 'upsert_app_context', 'upsert_jira_ticket']);

		step('upsert_app_context finds the seeded context');
		const found = await callToolText(options, 'upsert_app_context', { slug: SLUG, version: '1' });
		assert.ok(!found.text.includes('No context files found'), `the server did not read ${contexts}: ${found.text}`);
		assert.ok(found.isError && found.text.includes('PINECONE_API_KEY is not set'), `unexpected result: ${found.text}`);

		step('upsert_app_context names the old folder when nothing is found');
		const missing = await callToolText(options, 'upsert_app_context', { slug: 'ghost', version: '1' });
		assert.ok(missing.text.includes(path.join(contexts, 'ghost-v1.md')), `unexpected message: ${missing.text}`);

		step('ok');
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(`legacy-bridge: FAILED: ${err.message}`);
	process.exitCode = 1;
});
