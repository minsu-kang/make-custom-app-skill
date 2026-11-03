/**
 * update-notice-logic.js: the decisions behind the update notice of check-setup.js (spec 9.4).
 *
 * Role: pure functions only. Plain values in, plain values out: no network, no file access, no process.
 * The fetch and the cache file are in lib/update-notice.js. A new rule goes here with a unit test in
 * lib/__tests__/update-notice-logic.test.js.
 */
const UPDATE_URL = 'https://raw.githubusercontent.com/minsu-kang/make-app-ai-plugin/master/.claude-plugin/plugin.json';
const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const README_URL = 'https://github.com/minsu-kang/make-app-ai-plugin#update';

/** The `version` of a plugin.json text, or null when the text is not JSON or the version is not X.Y.Z. */
function parseVersion(text) {
	try {
		const version = JSON.parse(text).version;
		return typeof version === 'string' && SEMVER.test(version) ? version : null;
	} catch {
		return null;
	}
}

/** True when `remote` is a higher X.Y.Z than `installed`. Anything that is not X.Y.Z is never newer. */
function isNewer(remote, installed) {
	const a = SEMVER.exec(remote || '');
	const b = SEMVER.exec(installed || '');
	if (!a || !b) return false;
	for (let i = 1; i <= 3; i++) {
		const diff = Number(a[i]) - Number(b[i]);
		if (diff !== 0) return diff > 0;
	}
	return false;
}

/** True when a cache entry was written less than an hour ago. A clock that went backwards makes the entry stale. */
function isFresh(cache, now) {
	if (!cache || typeof cache.checkedAt !== 'number') return false;
	const age = now - cache.checkedAt;
	return age >= 0 && age < CACHE_TTL_MS;
}

/**
 * The lines check-setup prints when a newer version is on master. Claude Code gets the two commands, in the order that
 * works (the marketplace clone must be refreshed first). Cursor gets a pointer, because no update route is measured
 * for it yet. Nothing here installs anything.
 */
function noticeLines({ editor, installed, available }) {
	const head = `UPDATE_AVAILABLE: make-custom-app ${available} is available (installed: ${installed}). This does not block your work.`;
	if (editor === 'claude') {
		return [
			head,
			'To update, run these two commands in your own terminal, then restart Claude Code or run /reload-plugins:',
			'  claude plugin marketplace update make-custom-app',
			'  claude plugin update make-custom-app@make-custom-app',
		];
	}
	return [head, `How to update in Cursor: ${README_URL}`];
}

module.exports = { UPDATE_URL, CACHE_TTL_MS, FETCH_TIMEOUT_MS, README_URL, parseVersion, isNewer, isFresh, noticeLines };
