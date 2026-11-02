/**
 * update-notice.js: the update notice of check-setup.js (spec 9.4). It fetches only the plugin.json of master, waits at
 * most 5 seconds, keeps the answer for an hour in a temp file (a failed fetch is kept too, so an offline machine
 * waits once an hour), and fails open: any error means "no notice". It installs nothing.
 *
 * The decisions are in lib/update-notice-logic.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UPDATE_URL, FETCH_TIMEOUT_MS, parseVersion, isNewer, isFresh, noticeLines } = require('./update-notice-logic');

const CACHE_FILE = path.join(os.tmpdir(), 'make-custom-app-update-check.json');

function readCache(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

function writeCache(file, entry) {
	try {
		fs.writeFileSync(file, JSON.stringify(entry));
	} catch {
		/* a cache that cannot be written only costs one more fetch */
	}
}

/** The version of the plugin.json under `pluginRoot`, or null. */
function installedVersion(pluginRoot) {
	try {
		return parseVersion(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
	} catch {
		return null;
	}
}

/** The version on master: from the cache while it is fresh, else fetched. Null when it cannot be told. */
async function latestVersion({ fetchFn = fetch, cacheFile = CACHE_FILE, now = Date.now(), url = UPDATE_URL, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
	const cache = readCache(cacheFile);
	if (isFresh(cache, now)) return typeof cache.version === 'string' ? cache.version : null;
	let version = null;
	try {
		const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
		if (res.ok) version = parseVersion(await res.text());
	} catch {
		version = null;
	}
	writeCache(cacheFile, { checkedAt: now, version });
	return version;
}

/** { installed, available, lines } when master has a newer version than the installed one, else null. */
async function checkForUpdate({ editor, installed, ...options }) {
	if (!installed) return null;
	const available = await latestVersion(options);
	if (!isNewer(available, installed)) return null;
	return { installed, available, lines: noticeLines({ editor, installed, available }) };
}

module.exports = { CACHE_FILE, installedVersion, latestVersion, checkForUpdate };
