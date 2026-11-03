const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { UPDATE_URL, CACHE_TTL_MS, FETCH_TIMEOUT_MS, parseVersion, isNewer, isFresh, noticeLines } = require('../update-notice-logic');

describe('constants', () => {
	it('fetch only the plugin.json of master, wait at most 5 seconds, and keep an answer for an hour', () => {
		assert.equal(UPDATE_URL, 'https://raw.githubusercontent.com/minsu-kang/make-app-ai-plugin/master/.claude-plugin/plugin.json');
		assert.equal(FETCH_TIMEOUT_MS, 5000);
		assert.equal(CACHE_TTL_MS, 3600000);
	});
});

describe('parseVersion', () => {
	it('reads an X.Y.Z version from plugin.json text', () => {
		assert.equal(parseVersion('{"name":"x","version":"3.0.1"}'), '3.0.1');
	});

	it('gives null for text that is not JSON, has no version, or has a version that is not X.Y.Z', () => {
		for (const text of ['', 'not json', '{}', '{"version":3}', '{"version":"3.0"}', '{"version":"v3.0.0"}', '{"version":"3.0.0-beta"}', 'null']) {
			assert.equal(parseVersion(text), null, text);
		}
	});
});

describe('isNewer', () => {
	it('compares the three numbers, not the text', () => {
		assert.equal(isNewer('3.0.1', '3.0.0'), true);
		assert.equal(isNewer('3.1.0', '3.0.9'), true);
		assert.equal(isNewer('4.0.0', '3.9.9'), true);
		assert.equal(isNewer('3.0.10', '3.0.9'), true);
		assert.equal(isNewer('3.0.0', '3.0.0'), false);
		assert.equal(isNewer('3.0.0', '3.0.1'), false);
		assert.equal(isNewer('2.9.9', '3.0.0'), false);
	});

	it('is never true when either side is not X.Y.Z', () => {
		for (const [a, b] of [[null, '3.0.0'], ['3.0.0', null], ['', ''], ['x', '3.0.0'], ['3.0.0', undefined]]) assert.equal(isNewer(a, b), false);
	});
});

describe('isFresh', () => {
	it('is true for an entry younger than an hour', () => {
		assert.equal(isFresh({ checkedAt: 1000 }, 1000), true);
		assert.equal(isFresh({ checkedAt: 1000 }, 1000 + CACHE_TTL_MS - 1), true);
	});

	it('is false for an old entry, a missing entry, a bad entry, or a clock that went backwards', () => {
		assert.equal(isFresh({ checkedAt: 1000 }, 1000 + CACHE_TTL_MS), false);
		assert.equal(isFresh(null, 5), false);
		assert.equal(isFresh({}, 5), false);
		assert.equal(isFresh({ checkedAt: '5' }, 5), false);
		assert.equal(isFresh({ checkedAt: 2000 }, 1000), false);
	});
});

describe('noticeLines', () => {
	it('gives Claude Code the two commands in the order that works', () => {
		const lines = noticeLines({ editor: 'claude', installed: '3.0.0', available: '3.1.0' });
		assert.equal(lines[0], 'UPDATE_AVAILABLE: make-custom-app 3.1.0 is available (installed: 3.0.0). This does not block your work.');
		assert.ok(lines.indexOf('  claude plugin marketplace update make-custom-app') < lines.indexOf('  claude plugin update make-custom-app@make-custom-app'));
		assert.match(lines[1], /own terminal.*\/reload-plugins/);
	});

	it('gives Cursor a pointer to the README and no command', () => {
		const lines = noticeLines({ editor: 'cursor', installed: '3.0.0', available: '3.1.0' });
		assert.equal(lines.length, 2);
		assert.equal(lines[1], 'How to update in Cursor: https://github.com/minsu-kang/make-app-ai-plugin#update');
	});
});
