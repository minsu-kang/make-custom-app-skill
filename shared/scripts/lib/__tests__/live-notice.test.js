require('./isolate-home');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const notice = require('../live-notice');
const { cacheKey } = require('../mode-logic');

const POSIX = process.platform !== 'win32';
let home;
let file;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), 'live-notice-'));
	file = notice.noticeFile(home);
});

describe('live-notice', () => {
	it('keeps the file under ~/.make-custom-app', () => {
		assert.equal(file, path.join(home, '.make-custom-app', 'live-run-notice.json'));
	});

	it('is not accepted before accept(), and accepted after it for the same token and zone', () => {
		assert.equal(notice.isAccepted({ host: 'eu1.make.com', apiKey: 'TOKEN_A', file }), false);
		assert.equal(notice.accept({ host: 'eu1.make.com', apiKey: 'TOKEN_A', file, now: () => Date.parse('2026-11-05T12:00:00Z') }), true);
		assert.equal(notice.isAccepted({ host: 'eu1.make.com', apiKey: 'TOKEN_A', file }), true);
		assert.equal(notice.isAccepted({ host: 'eu1.make.com', apiKey: 'TOKEN_B', file }), false);
		assert.equal(notice.isAccepted({ host: 'us1.make.com', apiKey: 'TOKEN_A', file }), false);
	});

	it('writes schema 1, notice version 1, the hashed key and the time, never the token, with mode 0600 in a 0700 folder', () => {
		notice.accept({ host: 'eu1.make.com', apiKey: 'TOKEN_A', file, now: () => Date.parse('2026-11-05T12:00:00Z') });
		const text = fs.readFileSync(file, 'utf8');
		assert.deepEqual(JSON.parse(text), { schema: 1, noticeVersion: 1, key: cacheKey('eu1.make.com', 'TOKEN_A'), acceptedAt: '2026-11-05T12:00:00.000Z' });
		assert.ok(!text.includes('TOKEN_A'));
		if (POSIX) {
			assert.equal(fs.statSync(file).mode & 0o777, 0o600);
			assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
		}
	});

	it('does not accept another schema, a higher notice version or a symlink', { skip: !POSIX }, () => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const key = cacheKey('eu1.make.com', 'TOKEN_A');
		for (const entry of [{ schema: 2, noticeVersion: 1, key }, { schema: 1, noticeVersion: 2, key }]) {
			fs.writeFileSync(file, JSON.stringify(entry));
			assert.equal(notice.isAccepted({ host: 'eu1.make.com', apiKey: 'TOKEN_A', file }), false);
		}
		const target = path.join(home, 'target.json');
		fs.writeFileSync(target, JSON.stringify({ schema: 1, noticeVersion: 1, key }));
		fs.rmSync(file);
		fs.symlinkSync(target, file);
		assert.equal(notice.isAccepted({ host: 'eu1.make.com', apiKey: 'TOKEN_A', file }), false);
	});

	it('returns false when the folder cannot be made', () => {
		fs.writeFileSync(path.join(home, '.make-custom-app'), 'a file, not a folder');
		assert.equal(notice.accept({ host: 'eu1.make.com', apiKey: 'TOKEN_A', file }), false);
	});
});
