'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BANNER, BUNDLE, buildText, run } = require('../build-mcp.js');

function tempRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'build-mcp-'));
}

/** An esbuild stand-in that records its options and returns `text` as the bundle. */
function fakeEsbuild(text) {
	const calls = [];
	return {
		calls,
		build: async (options) => {
			calls.push(options);
			return { outputFiles: [{ text }] };
		},
	};
}

test('buildText bundles mcp-server/index.ts for Node 20 as an ES module with the createRequire banner', async () => {
	const root = tempRoot();
	try {
		const esbuild = fakeEsbuild('bundle text');
		assert.equal(await buildText({ root, esbuild }), 'bundle text');
		const [options] = esbuild.calls;
		assert.deepEqual(options.entryPoints, [path.join(root, 'mcp-server', 'index.ts')]);
		assert.equal(options.bundle, true);
		assert.equal(options.platform, 'node');
		assert.equal(options.target, 'node20');
		assert.equal(options.format, 'esm');
		assert.equal(options.minify, true);
		assert.equal(options.write, false);
		assert.equal(options.banner.js, BANNER);
		assert.match(BANNER, /createRequire/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('run writes the bundle and reports its size', async () => {
	const root = tempRoot();
	try {
		const result = await run([], { root, esbuild: fakeEsbuild('abc') });
		assert.equal(result.code, 0);
		assert.equal(result.message, 'mcp/index.mjs: wrote 3 bytes');
		assert.equal(fs.readFileSync(path.join(root, BUNDLE), 'utf8'), 'abc');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('--check passes when the committed bundle equals a fresh build and writes nothing', async () => {
	const root = tempRoot();
	try {
		fs.mkdirSync(path.join(root, 'mcp'));
		fs.writeFileSync(path.join(root, BUNDLE), 'same');
		const before = fs.statSync(path.join(root, BUNDLE)).mtimeMs;
		const result = await run(['--check'], { root, esbuild: fakeEsbuild('same') });
		assert.deepEqual(result, { code: 0, message: 'mcp/index.mjs: up to date' });
		assert.equal(fs.statSync(path.join(root, BUNDLE)).mtimeMs, before);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('--check fails when the bundle differs or is missing, and names the fix', async () => {
	const root = tempRoot();
	try {
		const missing = await run(['--check'], { root, esbuild: fakeEsbuild('new') });
		assert.equal(missing.code, 1);
		assert.match(missing.message, /mcp\/index\.mjs is missing\. Run: node tools\/build-mcp\.js/);
		fs.mkdirSync(path.join(root, 'mcp'));
		fs.writeFileSync(path.join(root, BUNDLE), 'old');
		const stale = await run(['--check'], { root, esbuild: fakeEsbuild('new') });
		assert.equal(stale.code, 1);
		assert.match(stale.message, /differs from a fresh build\. Run: node tools\/build-mcp\.js/);
		assert.equal(fs.readFileSync(path.join(root, BUNDLE), 'utf8'), 'old');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('without esbuild installed the error says to run npm ci in mcp-server', async () => {
	const root = tempRoot();
	try {
		await assert.rejects(run([], { root }), /npm ci/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('an unknown argument is an error and builds nothing', async () => {
	const root = tempRoot();
	try {
		const esbuild = fakeEsbuild('x');
		const result = await run(['--watch'], { root, esbuild });
		assert.equal(result.code, 1);
		assert.match(result.message, /Unknown argument: --watch/);
		assert.equal(esbuild.calls.length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
