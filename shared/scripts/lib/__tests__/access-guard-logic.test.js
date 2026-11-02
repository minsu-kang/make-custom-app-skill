const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isInternalEmail, cacheKey, cacheState, retryTooSoon, proxyEnv, parseLookupOutput, verdictFromLookup, denyMessage, CACHE_TTL_MS, RETRY_MS } = require('../access-guard-logic');

describe('isInternalEmail', () => {
	it('accepts @make.com addresses in any case, with surrounding whitespace', () => {
		for (const e of ['dev@make.com', 'First.Last+tag@make.com', 'DEV@MAKE.COM', '  dev@make.com\n']) assert.equal(isInternalEmail(e), true, e);
	});

	it('rejects other domains, look-alike domains, and malformed values', () => {
		const bad = [
			'dev@gmail.com',
			'dev@make.com.evil.io',
			'dev@evilmake.com',
			'dev@sub.make.com',
			'dev@make.co',
			'dev@make.com@evil.io',
			'a@b.com@make.com',
			'dev @make.com',
			'@make.com',
			'make.com',
			'',
			null,
			undefined,
			42,
			{ toString: () => 'dev@make.com' },
		];
		for (const e of bad) assert.equal(isInternalEmail(e), false, String(e));
	});
});

describe('cacheKey', () => {
	const base = { baseUrl: 'https://make.atlassian.net', email: 'dev@make.com', token: 'tok' };

	it('is stable and changes with any credential field', () => {
		assert.equal(cacheKey(base), cacheKey({ ...base }));
		for (const field of ['baseUrl', 'email', 'token']) assert.notEqual(cacheKey(base), cacheKey({ ...base, [field]: `${base[field]}x` }), field);
	});

	it('does not contain the token', () => {
		assert.ok(!cacheKey({ ...base, token: 'SECRET-TOKEN-VALUE' }).includes('SECRET'));
	});
});

describe('cacheState', () => {
	const NOW = 1_000_000_000_000;
	const entry = (over) => ({ key: 'k', email: 'dev@make.com', checkedAt: NOW - 1000, ...over });

	it('is fresh inside the TTL and stale after it', () => {
		assert.equal(cacheState(entry(), 'k', NOW), 'fresh');
		assert.equal(cacheState(entry({ checkedAt: NOW - CACHE_TTL_MS + 1 }), 'k', NOW), 'fresh');
		assert.equal(cacheState(entry({ checkedAt: NOW - CACHE_TTL_MS }), 'k', NOW), 'stale');
	});

	it('treats an entry written in the future (clock moved back) as stale', () => {
		assert.equal(cacheState(entry({ checkedAt: NOW + 5000 }), 'k', NOW), 'stale');
	});

	it('is none for a missing entry, another key, a non-@make.com email, or a malformed entry', () => {
		assert.equal(cacheState(null, 'k', NOW), 'none');
		assert.equal(cacheState(entry({ key: 'other' }), 'k', NOW), 'none');
		assert.equal(cacheState(entry({ email: 'dev@gmail.com' }), 'k', NOW), 'none');
		assert.equal(cacheState(entry({ email: undefined }), 'k', NOW), 'none');
		assert.equal(cacheState(entry({ checkedAt: '123' }), 'k', NOW), 'none');
	});
});

describe('retryTooSoon', () => {
	const NOW = 1_000_000_000_000;

	it('holds for RETRY_MS after a failed attempt, and only then', () => {
		assert.equal(retryTooSoon({ lastAttemptAt: NOW - 1000 }, NOW), true);
		assert.equal(retryTooSoon({ lastAttemptAt: NOW - RETRY_MS + 1 }, NOW), true);
		assert.equal(retryTooSoon({ lastAttemptAt: NOW - RETRY_MS }, NOW), false);
	});

	it('is false without an attempt, or for an attempt in the future', () => {
		assert.equal(retryTooSoon({}, NOW), false);
		assert.equal(retryTooSoon({ lastAttemptAt: 'x' }, NOW), false);
		assert.equal(retryTooSoon({ lastAttemptAt: NOW + 1000 }, NOW), false);
	});
});

describe('proxyEnv', () => {
	const ON = { NODE_USE_ENV_PROXY: '1' };

	it('turns the Node proxy opt-in on when a proxy variable has an http or https scheme', () => {
		for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
			assert.deepEqual(proxyEnv({ [name]: 'http://proxy.corp:8080' }), ON, name);
		}
		assert.deepEqual(proxyEnv({ HTTPS_PROXY: 'https://user:pw@proxy.corp:8443' }), ON);
		assert.deepEqual(proxyEnv({ HTTPS_PROXY: 'HTTP://proxy.corp:8080', http_proxy: 'http://proxy.corp:8080' }), ON);
	});

	it('leaves it off with no proxy variable, an empty one, or only ALL_PROXY', () => {
		for (const env of [{}, { HTTPS_PROXY: '' }, { ALL_PROXY: 'http://proxy.corp:8080' }, { NO_PROXY: 'make.atlassian.net' }]) assert.deepEqual(proxyEnv(env), {}, JSON.stringify(env));
	});

	it('leaves it off when any proxy variable has no http(s) scheme, because Node exits at startup on it', () => {
		for (const env of [
			{ HTTPS_PROXY: 'proxy.corp:8080' },
			{ http_proxy: '127.0.0.1:3128' },
			{ HTTPS_PROXY: 'socks5://proxy.corp:1080' },
			{ HTTPS_PROXY: 'http://proxy.corp:8080', HTTP_PROXY: 'proxy.corp:8080' },
			{ HTTPS_PROXY: 'ftp://proxy.corp:21' },
		]) {
			assert.deepEqual(proxyEnv(env), {}, JSON.stringify(env));
		}
	});

	it('keeps a NODE_USE_ENV_PROXY the user already set', () => {
		assert.deepEqual(proxyEnv({ HTTPS_PROXY: 'http://proxy.corp:8080', NODE_USE_ENV_PROXY: '0' }), {});
		assert.deepEqual(proxyEnv({ HTTPS_PROXY: 'http://proxy.corp:8080', NODE_USE_ENV_PROXY: '1' }), {});
	});
});

describe('parseLookupOutput', () => {
	it('returns an ok result unchanged', () => {
		assert.deepEqual(parseLookupOutput('{"ok":true,"email":"dev@make.com"}'), { ok: true, email: 'dev@make.com' });
	});

	it('keeps a failure and a clean reason code, and drops a reason that is not a short code', () => {
		assert.deepEqual(parseLookupOutput('{"ok":false,"status":401,"noEmail":false,"reason":null}'), { ok: false, status: 401, noEmail: false, reason: null });
		assert.equal(parseLookupOutput('{"ok":false,"reason":"ECONNREFUSED"}').reason, 'ECONNREFUSED');
		for (const reason of ['has space', 'x'.repeat(41), '', 5, { a: 1 }, 'a\nb']) assert.equal(parseLookupOutput(JSON.stringify({ ok: false, reason })).reason, null, String(reason));
	});

	it('returns NO_OUTPUT for empty, cut-off, or non-object output', () => {
		const noOutput = { ok: false, status: null, noEmail: false, reason: 'NO_OUTPUT' };
		for (const text of ['', '{"ok":tr', 'null', '42', '"text"', null, undefined]) assert.deepEqual(parseLookupOutput(text), noOutput, String(text));
	});
});

describe('verdictFromLookup', () => {
	it('maps a Jira answer to a verdict', () => {
		assert.equal(verdictFromLookup({ ok: true, email: 'dev@make.com' }), 'ok');
		assert.equal(verdictFromLookup({ ok: true, email: 'dev@gmail.com' }), 'external');
		assert.equal(verdictFromLookup({ ok: false, status: 401 }), 'rejected');
	});

	it('treats everything else as unverified', () => {
		for (const r of [{ ok: false, status: null }, { ok: false, status: 403 }, { ok: false, status: 429 }, { ok: false, status: 500 }, { ok: false, status: 404 }, { ok: false, status: null, noEmail: true }, null, undefined, 'x']) {
			assert.equal(verdictFromLookup(r), 'unverified', JSON.stringify(r));
		}
	});
});

describe('denyMessage', () => {
	const ctx = { email: 'dev@gmail.com', setupCommand: 'node /x/setup-secrets.js', status: 401 };

	it('says why for every code', () => {
		assert.match(denyMessage('NO_JIRA', ctx), /no Jira API token is saved[\s\S]*node \/x\/setup-secrets\.js/);
		assert.match(denyMessage('EXTERNAL', ctx), /Make employees only[\s\S]*dev@gmail\.com[\s\S]*not a @make\.com/);
		assert.match(denyMessage('REJECTED', ctx), /HTTP 401[\s\S]*node \/x\/setup-secrets\.js/);
		assert.match(denyMessage('UNVERIFIED', { setupCommand: ctx.setupCommand }), /Could not confirm/);
	});

	it('tells the user which kind of Jira token to create', () => {
		for (const code of ['NO_JIRA', 'REJECTED']) assert.match(denyMessage(code, ctx), /'Create API token', not 'Create API token with scopes'/, code);
	});

	it('names the cause when Jira could not confirm the account', () => {
		assert.match(denyMessage('UNVERIFIED', { noEmail: true }), /did not return an email address/);
		assert.match(denyMessage('UNVERIFIED', { status: 403 }), /HTTP 403[\s\S]*allowlist/);
		assert.doesNotMatch(denyMessage('UNVERIFIED', { status: 503 }), /allowlist/);
		assert.match(denyMessage('UNVERIFIED', { status: 503 }), /HTTP 503/);
		assert.match(denyMessage('UNVERIFIED', { reason: 'ENOTFOUND' }), /Could not reach Jira \(ENOTFOUND\)/);
		assert.match(denyMessage('UNVERIFIED', { reason: 'NO_OUTPUT' }), /NO_OUTPUT/);
		assert.match(denyMessage('UNVERIFIED', {}), /Could not confirm your Atlassian account/);
	});

	it('falls back to the unverified text for an unknown code and tolerates a missing email', () => {
		assert.equal(denyMessage('???', ctx), denyMessage('UNVERIFIED', ctx));
		assert.match(denyMessage('EXTERNAL', {}), /\(unknown\)/);
	});
});
