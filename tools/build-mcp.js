#!/usr/bin/env node
'use strict';

// Builds the MCP server bundle that the plugin runs: mcp-server/index.ts plus its dependencies into mcp/index.mjs.
// The bundle is committed because a plugin install has no build step and no node_modules.
//
//   node tools/build-mcp.js            write mcp/index.mjs
//   node tools/build-mcp.js --check    fail when mcp/index.mjs differs from a fresh build (CI)
//
// esbuild is resolved from mcp-server/node_modules (run npm ci in mcp-server first).

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = 'mcp/index.mjs';

// Bundled CommonJS dependencies call require(); an ES module has none, so give the bundle one.
const BANNER = "import { createRequire as __mcpCreateRequire } from 'module';\nconst require = __mcpCreateRequire(import.meta.url);";

function loadEsbuild(root) {
	try {
		return createRequire(path.join(root, 'mcp-server', 'package.json'))('esbuild');
	} catch (err) {
		throw new Error(`esbuild is not installed under ${path.join(root, 'mcp-server')}. Run npm ci in mcp-server first. (${err.message.split('\n')[0]})`);
	}
}

/** The bundle text, built in memory. */
async function buildText({ root = ROOT, esbuild = loadEsbuild(root) } = {}) {
	const result = await esbuild.build({
		entryPoints: [path.join(root, 'mcp-server', 'index.ts')],
		bundle: true,
		platform: 'node',
		target: 'node20',
		format: 'esm',
		minify: true,
		banner: { js: BANNER },
		write: false,
		outfile: path.join(root, BUNDLE),
		logLevel: 'silent',
	});
	return result.outputFiles[0].text;
}

/**
 * Runs the tool. Returns { code, message }; the caller prints the message and exits with the code.
 * args: process.argv.slice(2).
 */
async function run(args, options = {}) {
	const root = options.root || ROOT;
	const unknown = args.filter((a) => a !== '--check');
	if (unknown.length) return { code: 1, message: `Unknown argument: ${unknown[0]}\nUsage: node tools/build-mcp.js [--check]` };
	const file = path.join(root, BUNDLE);
	const text = await buildText({ root, esbuild: options.esbuild });
	if (args.includes('--check')) {
		const committed = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
		if (committed === text) return { code: 0, message: `${BUNDLE}: up to date` };
		const why = committed === null ? 'is missing' : 'differs from a fresh build';
		return { code: 1, message: `${BUNDLE} ${why}. Run: node tools/build-mcp.js` };
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return { code: 0, message: `${BUNDLE}: wrote ${Buffer.byteLength(text)} bytes` };
}

module.exports = { BUNDLE, BANNER, buildText, run };

if (require.main === module) {
	run(process.argv.slice(2)).then(
		({ code, message }) => {
			console.log(message);
			process.exitCode = code;
		},
		(err) => {
			console.error(`build-mcp: ${err.message}`);
			process.exitCode = 1;
		},
	);
}
