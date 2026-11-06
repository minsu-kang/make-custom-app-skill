require('./isolate-home');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const ar = require('../api-read');

/** A fetch stand-in: answers are { status, body, headers } or an Error to throw, used in order (the last one repeats). */
function fakeFetch(answers) {
	const calls = [];
	const fn = async (url, opts) => {
		calls.push({ url, opts });
		const a = answers[Math.min(calls.length - 1, answers.length - 1)];
		if (a instanceof Error) throw a;
		return { status: a.status, headers: { get: (name) => (a.headers || {})[name.toLowerCase()] ?? null }, text: async () => a.body ?? '' };
	};
	fn.calls = calls;
	return fn;
}
const recorder = () => {
	const waits = [];
	const sleepFn = async (ms) => { waits.push(ms); };
	return { waits, sleepFn };
};
const netError = (code) => Object.assign(new TypeError('fetch failed: Token SECRET_IN_MESSAGE'), { cause: { code } });

describe('apiGet', () => {
	it('returns the first answer with the token and the SDK header', async () => {
		const fetchFn = fakeFetch([{ status: 200, body: '{"a":1}' }]);
		const r = await ar.apiGet('http://x/a', { auth: 'Token T', fetchFn, ...recorder() });
		assert.deepEqual(r, { status: 200, body: '{"a":1}', error: null });
		assert.deepEqual(fetchFn.calls[0].opts.headers, { Authorization: 'Token T', 'x-imt-apps-sdk-version': '2.4.0' });
	});

	it('retries 503 with the backoff, calls onBackoff and prints one line per wait', async () => {
		const fetchFn = fakeFetch([{ status: 503 }, { status: 503 }, { status: 200, body: 'ok' }]);
		const { waits, sleepFn } = recorder();
		const seen = [];
		const lines = [];
		const r = await ar.apiGet('http://x', { auth: 'Token T', baseDelayMs: 1000, fetchFn, sleepFn, onBackoff: (s) => seen.push(s), log: (l) => lines.push(l) });
		assert.equal(r.status, 200);
		assert.deepEqual(waits, [1000, 2000]);
		assert.deepEqual(seen, [503, 503]);
		assert.deepEqual(lines, ['  ⏳ HTTP 503 → retrying in 1000ms', '  ⏳ HTTP 503 → retrying in 2000ms']);
	});

	it('retries 502 and 504 the same way, and 429 with its own line', async () => {
		for (const status of [502, 504, 429]) {
			const lines = [];
			const r = await ar.apiGet('http://x', { fetchFn: fakeFetch([{ status }, { status: 200, body: '' }]), ...recorder(), log: (l) => lines.push(l) });
			assert.equal(r.status, 200);
			assert.equal(lines[0], status === 429 ? '  ⏳ 429 Rate Limit → retrying in 1000ms' : `  ⏳ HTTP ${status} → retrying in 1000ms`);
		}
	});

	it('waits for the Retry-After header of the answer, capped at 10 s, and uses the backoff for an HTTP date', async () => {
		const answers = [
			{ status: 429, headers: { 'retry-after': '3' } },
			{ status: 503, headers: { 'retry-after': '30' } },
			{ status: 502, headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' } },
			{ status: 200, body: 'ok' },
		];
		const { waits, sleepFn } = recorder();
		const lines = [];
		const r = await ar.apiGet('http://x', { baseDelayMs: 1000, fetchFn: fakeFetch(answers), sleepFn, log: (l) => lines.push(l) });
		assert.equal(r.status, 200);
		assert.deepEqual(waits, [3000, 10000, 4000]);
		assert.deepEqual(lines, ['  ⏳ 429 Rate Limit → retrying in 3000ms', '  ⏳ HTTP 503 → retrying in 10000ms', '  ⏳ HTTP 502 → retrying in 4000ms']);
	});

	it('gives up after 5 retries: 6 calls, the last status returned', async () => {
		const fetchFn = fakeFetch([{ status: 504 }]);
		const r = await ar.apiGet('http://x', { fetchFn, ...recorder(), log: () => {} });
		assert.equal(fetchFn.calls.length, 6);
		assert.equal(r.status, 504);
	});

	it('does not retry 500, other statuses, or anything with retry false', async () => {
		for (const [answers, opts] of [[[{ status: 500 }], {}], [[{ status: 404 }], {}], [[{ status: 503 }], { retry: false }]]) {
			const fetchFn = fakeFetch(answers);
			await ar.apiGet('http://x', { fetchFn, ...recorder(), log: () => {}, ...opts });
			assert.equal(fetchFn.calls.length, 1);
		}
	});

	it('retries a network error and returns only its code, never its message', async () => {
		const lines = [];
		const fetchFn = fakeFetch([netError('ECONNRESET')]);
		const r = await ar.apiGet('http://x', { fetchFn, ...recorder(), log: (l) => lines.push(l) });
		assert.deepEqual(r, { status: null, body: null, error: 'ECONNRESET' });
		assert.equal(fetchFn.calls.length, 6);
		assert.ok(!JSON.stringify([r, lines]).includes('SECRET_IN_MESSAGE'));
		const again = await ar.apiGet('http://x', { fetchFn: fakeFetch([netError('ECONNRESET'), { status: 200, body: 'ok' }]), ...recorder() });
		assert.equal(again.status, 200);
	});

	it('retries a 503 whose body cannot be read', async () => {
		let n = 0;
		const fetchFn = async () => {
			n += 1;
			if (n === 1) return { status: 503, headers: { get: () => null }, text: async () => { throw new Error('aborted'); } };
			return { status: 200, headers: { get: () => null }, text: async () => 'ok' };
		};
		const r = await ar.apiGet('http://x', { fetchFn, ...recorder(), log: () => {} });
		assert.deepEqual(r, { status: 200, body: 'ok', error: null });
	});
});

describe('retryDelayMs', () => {
	it('takes Retry-After seconds capped at 10 s, and falls back to the backoff for a missing or non-numeric value', () => {
		assert.equal(ar.retryDelayMs('2', 0, 1000), 2000);
		assert.equal(ar.retryDelayMs('30', 0, 1000), 10000);
		assert.equal(ar.retryDelayMs('0', 3, 1000), 0);
		assert.equal(ar.retryDelayMs(null, 3, 1000), 8000);
		assert.equal(ar.retryDelayMs('Wed, 21 Oct 2015 07:28:00 GMT', 1, 1000), 2000);
		assert.equal(ar.retryDelayMs('-5', 0, 1000), 1000);
	});
});

describe('the defaults', () => {
	it('uses the real fetch, sleep and console.error', async (t) => {
		let hits = 0;
		const server = http.createServer((req, res) => {
			hits += 1;
			res.writeHead(hits === 1 ? 503 : 200);
			res.end('done');
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		const err = t.mock.method(console, 'error', () => {});
		try {
			const r = await ar.apiGet(`http://127.0.0.1:${server.address().port}/x`, { auth: 'Token T', baseDelayMs: 0 });
			assert.deepEqual(r, { status: 200, body: 'done', error: null });
			assert.equal(err.mock.calls.length, 1);
		} finally {
			server.close();
		}
	});
});
