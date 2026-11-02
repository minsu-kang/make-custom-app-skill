const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installedVersion, latestVersion, checkForUpdate } = require('../update-notice');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-notice-test-'));
const cacheFile = path.join(dir, 'cache.json');
const NOW = 1_000_000_000_000;

beforeEach(() => fs.rmSync(cacheFile, { force: true }));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

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
