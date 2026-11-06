'use strict';
/**
 * live-notice.js: the one-time live-run notice of public mode (spec 3.6). The answer is kept for one token and zone in
 * ~/.make-custom-app/live-run-notice.json under the hash of mode-logic.cacheKey (never the token), through safe-file.js.
 * The folder is made with mode 0700 when it does not exist yet; an existing folder keeps its mode.
 */
const os = require('os');
const path = require('path');
const { readOwnedJson, writeOwnedJson } = require('./safe-file');
const { cacheKey } = require('./mode-logic');
const rc = require('./run-component-logic');

const NOTICE_FILE_NAME = 'live-run-notice.json';

function noticeFile(home = os.homedir()) {
	return path.join(home, '.make-custom-app', NOTICE_FILE_NAME);
}

function isAccepted({ host, apiKey, file = noticeFile() }) {
	return rc.liveNoticeAccepted(readOwnedJson(file), cacheKey(host, apiKey));
}

function accept({ host, apiKey, file = noticeFile(), now = Date.now }) {
	return writeOwnedJson(file, rc.liveNoticeEntry(cacheKey(host, apiKey), now()), { mkdir: true });
}

module.exports = { NOTICE_FILE_NAME, noticeFile, isAccepted, accept };
