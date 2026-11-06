'use strict';
/**
 * api-read.js: one GET of the Make API with the retry rule that download-app.js and review-changes.js share.
 * { status, body, error }: body is the response text; after a network failure status and body are null and error is a
 * short code. err.message is never printed or returned: for a bad header value it holds the Authorization value.
 * 429, 502, 503, 504 and network errors are retried up to MAX_RETRIES times; every other status returns at once.
 */
const { errorCode } = require('./mode-logic');

const MAX_RETRIES = 5;
const TRANSIENT_STATUSES = [502, 503, 504];
const RETRY_AFTER_CAP_MS = 10000;
const SDK_VERSION = '2.4.0';

function isTransientStatus(status) {
	return TRANSIENT_STATUSES.includes(status);
}

/** Retry-After in whole seconds, capped at 10 s; a missing or non-numeric value (an HTTP date) uses baseDelayMs * 2^retries. */
function retryDelayMs(retryAfter, retries, baseDelayMs) {
	const text = typeof retryAfter === 'string' ? retryAfter.trim() : '';
	if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, RETRY_AFTER_CAP_MS);
	return baseDelayMs * 2 ** retries;
}

function backoffLine(status, delayMs) {
	return status === 429 ? `  ⏳ 429 Rate Limit → retrying in ${delayMs}ms` : `  ⏳ HTTP ${status} → retrying in ${delayMs}ms`;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(url, { auth, retry = true, baseDelayMs = 1000, onBackoff = () => {}, log = (line) => console.error(line), fetchFn = fetch, sleepFn = sleep } = {}) {
	for (let retries = 0; ; retries++) {
		const canRetry = retry && retries < MAX_RETRIES;
		try {
			const resp = await fetchFn(url, { headers: { Authorization: auth, 'x-imt-apps-sdk-version': SDK_VERSION } });
			if (canRetry && (resp.status === 429 || isTransientStatus(resp.status))) {
				const delay = retryDelayMs(resp.headers.get('retry-after'), retries, baseDelayMs);
				onBackoff(resp.status);
				log(backoffLine(resp.status, delay));
				await resp.text().catch(() => '');
				await sleepFn(delay);
				continue;
			}
			return { status: resp.status, body: await resp.text(), error: null };
		} catch (err) {
			if (canRetry) {
				await sleepFn(baseDelayMs * 2 ** retries);
				continue;
			}
			return { status: null, body: null, error: errorCode(err) };
		}
	}
}

module.exports = { MAX_RETRIES, TRANSIENT_STATUSES, RETRY_AFTER_CAP_MS, isTransientStatus, retryDelayMs, backoffLine, apiGet };
