const crypto = require('crypto');

const INTERNAL_EMAIL = /^[^\s@]+@make\.com$/i;
const JIRA_BASE_URL = 'https://make.atlassian.net';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

function isInternalEmail(email) {
	return typeof email === 'string' && INTERNAL_EMAIL.test(email.trim());
}

/** Binds a cached verdict to the credentials that produced it. */
function cacheKey({ baseUrl, email, token }) {
	return crypto.createHash('sha256').update(`${baseUrl}\n${email}\n${token}`).digest('hex');
}

/** 'fresh' | 'stale' | 'none' for a cache entry written by access-guard.js. */
function cacheState(cache, key, now) {
	if (!cache || cache.key !== key || !isInternalEmail(cache.email) || typeof cache.checkedAt !== 'number') return 'none';
	const age = now - cache.checkedAt;
	return age >= 0 && age < CACHE_TTL_MS ? 'fresh' : 'stale';
}

/** True while a stale entry was already tried against an unreachable Jira less than RETRY_MS ago. */
function retryTooSoon(cache, now) {
	const age = now - cache.lastAttemptAt;
	return typeof cache.lastAttemptAt === 'number' && age >= 0 && age < RETRY_MS;
}

/** stdout of the lookup child process -> its result object, or { reason: 'NO_OUTPUT' } when it is not one. */
function parseLookupOutput(text) {
	try {
		const value = JSON.parse(text);
		if (value && typeof value === 'object') {
			if (value.ok) return value;
			const reason = typeof value.reason === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(value.reason) ? value.reason : null;
			return { ...value, reason };
		}
	} catch {
		/* empty or cut-off output: the child was killed or crashed */
	}
	return { ok: false, status: null, noEmail: false, reason: 'NO_OUTPUT' };
}

/** Child-process lookup result -> 'ok' | 'external' | 'rejected' | 'unverified'. */
function verdictFromLookup(lookup) {
	if (!lookup || typeof lookup !== 'object') return 'unverified';
	if (lookup.ok) return isInternalEmail(lookup.email) ? 'ok' : 'external';
	return lookup.status === 401 ? 'rejected' : 'unverified';
}

const TOKEN_HINT = "Create it with 'Create API token', not 'Create API token with scopes'.";

function unverifiedText({ status, noEmail, reason }) {
	if (noEmail) return 'Jira did not return an email address for this account, so it cannot be confirmed. Check the email visibility setting in your Atlassian profile, then retry.';
	if (status) return `Jira answered HTTP ${status}, so the account could not be confirmed.${status === 403 ? ' A network allowlist or an admin policy on API tokens can cause this.' : ''} Retry later, or ask IT.`;
	if (reason) return `Could not reach Jira (${reason}). Check your network or VPN and retry.`;
	return 'Could not confirm your Atlassian account. Check your network or VPN and retry.';
}

/** Text for a refused run. Never includes the token. */
function denyMessage(code, { email, setupCommand, status, noEmail, reason } = {}) {
	if (code === 'NO_JIRA') {
		return [
			'This skill is for Make employees. It checks your Atlassian account, and no Jira API token is saved yet.',
			`Run this in your own terminal (the agent must not run it) and enter a Jira API token from https://id.atlassian.com/manage-profile/security/api-tokens. ${TOKEN_HINT}\n  ${setupCommand}`,
		].join('\n');
	}
	if (code === 'EXTERNAL') return `This skill is for Make employees only. The Atlassian account ${email || '(unknown)'} is not a @make.com account.`;
	if (code === 'REJECTED') {
		return [
			`Jira rejected the saved credentials (HTTP ${status}), so the account could not be confirmed.`,
			`Create a new Jira API token and save it in your own terminal. ${TOKEN_HINT}\n  ${setupCommand}`,
		].join('\n');
	}
	return unverifiedText({ status, noEmail, reason });
}

module.exports = { INTERNAL_EMAIL, JIRA_BASE_URL, CACHE_TTL_MS, RETRY_MS, isInternalEmail, cacheKey, cacheState, retryTooSoon, parseLookupOutput, verdictFromLookup, denyMessage };
