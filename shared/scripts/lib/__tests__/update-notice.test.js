require('./isolate-home');
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { installedVersion, latestVersion, checkForUpdate } = require('../update-notice');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-notice-test-'));
const cacheFile = path.join(dir, 'cache.json');
const NOW = 1_000_000_000_000;

beforeEach(() => fs.rmSync(cacheFile, { force: true }));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * Runs `code` in a child Node process that is killed after 10 s and returns its stdout. A read that blocks on a FIFO
 * blocks the whole process, so a node:test timeout cannot end it; in a child the case fails instead of hanging the run.
 */
function runBounded(code, args) {
	const r = spawnSync(process.execPath, ['-e', code, ...args], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
	assert.equal(r.signal, null, 'the read blocked on the FIFO');
	assert.equal(r.status, 0, r.stderr);
	return r.stdout;
}

/** A fetch stand-in that answers with `body` and counts its calls. */
function fakeFetch(body, { ok = true, fail = false } = {}) {
	const calls = [];
	const fn = async (url, options) => {
		calls.push({ url, options });
		if (fail) throw new Error('offline');
		return { ok, text: async () => body };
	};
	fn.calls = calls;
	return fn;
}

describe('installedVersion', () => {
	it('reads the version of .claude-plugin/plugin.json under the plugin root', () => {
		const root = path.join(dir, 'plugin');
		fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
		fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), '{"version":"3.2.1"}');
		assert.equal(installedVersion(root), '3.2.1');
	});

	it('gives null when the file is missing or has no X.Y.Z version', () => {
		assert.equal(installedVersion(path.join(dir, 'nowhere')), null);
		const root = path.join(dir, 'odd');
		fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
		fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), '{"version":"x"}');
		assert.equal(installedVersion(root), null);
	});
});

describe('latestVersion', () => {
	it('fetches the url with a timeout signal and caches the answer', async () => {
		const fetchFn = fakeFetch('{"version":"3.1.0"}');
		assert.equal(await latestVersion({ fetchFn, cacheFile, now: NOW, url: 'https://example.test/plugin.json' }), '3.1.0');
		assert.equal(fetchFn.calls.length, 1);
		assert.equal(fetchFn.calls[0].url, 'https://example.test/plugin.json');
		assert.ok(fetchFn.calls[0].options.signal instanceof AbortSignal);
		assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), { checkedAt: NOW, version: '3.1.0' });
	});

	it('uses a fresh cache without fetching, and fetches again when the cache is an hour old', async () => {
		const fetchFn = fakeFetch('{"version":"3.2.0"}');
		fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: NOW - 60_000, version: '3.1.0' }));
		assert.equal(await latestVersion({ fetchFn, cacheFile, now: NOW }), '3.1.0');
		assert.equal(fetchFn.calls.length, 0);
		assert.equal(await latestVersion({ fetchFn, cacheFile, now: NOW + 3_600_000 }), '3.2.0');
		assert.equal(fetchFn.calls.length, 1);
	});

	it('gives null and remembers the failure for an hour when the fetch fails, answers badly, or returns no version', async () => {
		for (const fetchFn of [fakeFetch('', { fail: true }), fakeFetch('{"version":"3.0.0"}', { ok: false }), fakeFetch('<html>'), fakeFetch('{}')]) {
			fs.rmSync(cacheFile, { force: true });
			assert.equal(await latestVersion({ fetchFn, cacheFile, now: NOW }), null);
			assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), { checkedAt: NOW, version: null });
			assert.equal(await latestVersion({ fetchFn, cacheFile, now: NOW + 1000 }), null);
			assert.equal(fetchFn.calls.length, 1, 'the second call used the cache');
		}
	});

	it('replaces a planted symlink and leaves the file it pointed at as it was', { skip: process.platform === 'win32' }, async () => {
		const victim = path.join(dir, 'victim.txt');
		fs.writeFileSync(victim, 'VICTIM');
		fs.symlinkSync(victim, cacheFile);
		assert.equal(await latestVersion({ fetchFn: fakeFetch('{"version":"3.1.0"}'), cacheFile, now: NOW }), '3.1.0');
		assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM');
		assert.equal(fs.lstatSync(cacheFile).isSymbolicLink(), false);
		fs.rmSync(victim);
	});

	it('fetches again when the cache is a symlink to a fresh entry', { skip: process.platform === 'win32' }, async () => {
		const target = path.join(dir, 'target.json');
		fs.writeFileSync(target, JSON.stringify({ checkedAt: NOW, version: '3.0.0' }));
		fs.symlinkSync(target, cacheFile);
		const fetchFn = fakeFetch('{"version":"3.1.0"}');
		assert.equal(await latestVersion({ fetchFn, cacheFile, now: NOW }), '3.1.0');
		assert.equal(fetchFn.calls.length, 1);
		fs.rmSync(target);
	});

	it('writes a new cache file readable by its owner only', { skip: process.platform === 'win32' }, async () => {
		assert.equal(fs.existsSync(cacheFile), false);
		await latestVersion({ fetchFn: fakeFetch('{"version":"3.1.0"}'), cacheFile, now: NOW });
		assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
	});

	it('replaces a 0644 cache with one readable by its owner only', { skip: process.platform === 'win32' }, async () => {
		fs.writeFileSync(cacheFile, '{}', { mode: 0o644 });
		fs.chmodSync(cacheFile, 0o644);
		await latestVersion({ fetchFn: fakeFetch('{"version":"3.1.0"}'), cacheFile, now: NOW });
		assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
	});

	it('fetches again instead of hanging when the cache is a FIFO', { skip: process.platform === 'win32' }, (t) => {
		if (spawnSync('mkfifo', [cacheFile]).status !== 0) return t.skip('mkfifo failed');
		const code = [
			'const [file, cacheFile] = process.argv.slice(1);',
			'let calls = 0;',
			'const fetchFn = async () => { calls += 1; return { ok: true, text: async () => \'{"version":"3.1.0"}\' }; };',
			'require(file).latestVersion({ fetchFn, cacheFile, now: 1 }).then((version) => process.stdout.write(JSON.stringify({ version, calls })));',
		].join(' ');
		assert.deepEqual(JSON.parse(runBounded(code, [require.resolve('../update-notice'), cacheFile])), { version: '3.1.0', calls: 1 });
	});

	it('is not stopped by a leftover temp file of the same process', async () => {
		fs.writeFileSync(`${cacheFile}.${process.pid}.tmp`, 'junk');
		assert.equal(await latestVersion({ fetchFn: fakeFetch('{"version":"3.1.0"}'), cacheFile, now: NOW }), '3.1.0');
		assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), { checkedAt: NOW, version: '3.1.0' });
		assert.equal(fs.existsSync(`${cacheFile}.${process.pid}.tmp`), false);
	});

	it('does not fail when the cache cannot be written or read', async () => {
		const unwritable = path.join(dir, 'no-such-folder', 'cache.json');
		assert.equal(await latestVersion({ fetchFn: fakeFetch('{"version":"3.1.0"}'), cacheFile: unwritable, now: NOW }), '3.1.0');
		fs.writeFileSync(cacheFile, 'not json');
		assert.equal(await latestVersion({ fetchFn: fakeFetch('{"version":"3.1.0"}'), cacheFile, now: NOW }), '3.1.0');
	});
});

describe('checkForUpdate', () => {
	it('returns the versions and the lines when master is newer', async () => {
		const result = await checkForUpdate({ editor: 'claude', installed: '3.0.0', fetchFn: fakeFetch('{"version":"3.0.1"}'), cacheFile, now: NOW });
		assert.deepEqual({ installed: result.installed, available: result.available }, { installed: '3.0.0', available: '3.0.1' });
		assert.match(result.lines[0], /^UPDATE_AVAILABLE: make-custom-app 3\.0\.1 /);
	});

	it('returns null when master is the same or older, or when the installed version is unknown', async () => {
		assert.equal(await checkForUpdate({ editor: 'claude', installed: '3.0.0', fetchFn: fakeFetch('{"version":"3.0.0"}'), cacheFile, now: NOW }), null);
		fs.rmSync(cacheFile, { force: true });
		assert.equal(await checkForUpdate({ editor: 'claude', installed: '3.0.0', fetchFn: fakeFetch('{"version":"2.9.9"}'), cacheFile, now: NOW }), null);
		const fetchFn = fakeFetch('{"version":"9.0.0"}');
		assert.equal(await checkForUpdate({ editor: 'claude', installed: null, fetchFn, cacheFile, now: NOW }), null);
		assert.equal(fetchFn.calls.length, 0, 'no fetch without an installed version');
	});
});
