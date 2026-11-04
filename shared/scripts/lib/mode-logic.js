/**
 * mode-logic.js: the decisions behind mode.js (employee or public mode of the saved Make API token), and the rules
 * check-setup, the wizard and the Make entry scripts share: the token scopes, the account label and the zone switch.
 *
 * Role: pure functions only. Plain values in, plain values out: no network, no file access, no process.exit, no console.
 * A new rule goes here with a unit test in lib/__tests__/mode-logic.test.js.
 */
const crypto = require('crypto');
const path = require('path');

const ZONES = ['eu1.make.com', 'eu2.make.com', 'us1.make.com', 'us2.make.com', 'eu1.make.celonis.com', 'us1.make.celonis.com'];
const MODES = ['employee', 'public'];
const CACHE_FILE_NAME = 'make-custom-app-mode.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ADMIN_PROBE_QUERY = 'all=true&name=__mode_probe__&cols[]=name';
/** Test hook: an http(s) origin on a loopback host that replaces https://{host} in every URL mode.js builds. */
const TEST_ORIGIN_VAR = 'MAKE_CUSTOM_APP_TEST_API_ORIGIN';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const MAKE_HOST = /^(?:[a-z0-9-]+\.)+(?:make\.com|make\.celonis\.com)$/;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,40}$/;
/** The scopes every Make API token needs (spec B 11.7): sdk-apps for the app code, user:read for the account name. */
const TOKEN_SCOPES = ['sdk-apps:read', 'sdk-apps:write', 'user:read'];
/**
 * What run-component.js (live Endpoint and RPC runs) needs on top of TOKEN_SCOPES: everyRun always, endpoints for
 * Endpoints and for listing teams, connection for a component with a connection; it uses optional when present.
 */
const RUN_COMPONENT_SCOPES = {
	everyRun: ['imt-forms:read'],
	endpoints: ['teams:read', 'organizations:read'],
	connection: ['connections:read'],
	optional: ['endpoints:run', 'credential-requests:write'],
};
const ACCOUNT_NAME_UNAVAILABLE = 'account name unavailable: the token lacks the user:read scope';

/** Host of a Make API URL such as https://eu1.make.com/api/v2/admin; null when it does not parse or is not on *.make.com or *.make.celonis.com. */
function hostFromUrl(url) {
	let parsed;
	try {
		parsed = new URL(String(url));
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
	return MAKE_HOST.test(parsed.hostname) ? parsed.hostname : null;
}

/** Host of a make-zone value or a Cursor environment url: a bare host (eu1.make.com), a host with a path, or a URL. */
function hostFromZone(value) {
	if (typeof value !== 'string' || !value.trim()) return null;
	const text = value.trim();
	return hostFromUrl(text.includes('://') ? text : `https://${text}`);
}

/** The origin of TEST_ORIGIN_VAR when it is http(s) on a loopback host, else null. */
function testOrigin(value) {
	if (!value) return null;
	let url;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	return /^https?:$/.test(url.protocol) && LOOPBACK_HOSTS.includes(url.hostname) ? url.origin : null;
}

function publicBase(host, origin = null) {
	return `${origin || `https://${host}`}/api/v2`;
}

function adminBase(host, origin = null) {
	return `${publicBase(host, origin)}/admin`;
}

function baseFor(mode, host, origin = null) {
	if (!MODES.includes(mode)) throw new Error(`No API base for mode ${mode}`);
	return mode === 'employee' ? adminBase(host, origin) : publicBase(host, origin);
}

function meUrl(host, origin = null) {
	return `${publicBase(host, origin)}/users/me`;
}

function adminProbeUrl(host, origin = null) {
	return `${adminBase(host, origin)}/sdk/apps?${ADMIN_PROBE_QUERY}`;
}

function tokenPageUrl(host) {
	return `https://${host}/user/api`;
}

/** Step 1, GET users/me: 'ok' | 'badToken' | 'retry'. A 403 is a valid token without user:read (spec B 11.1). */
function classifyMe(result) {
	const status = result?.status;
	if (status === 200 || status === 403) return 'ok';
	if (status === 401) return 'badToken';
	return 'retry';
}

/** Step 2, the admin probe: 'employee' | 'public' | 'retry'. */
function classifyAdmin(result) {
	const status = result?.status;
	if (Number.isInteger(status) && status >= 200 && status < 300) return 'employee';
	if (status === 401 || status === 403 || status === 404) return 'public';
	return 'retry';
}

/** Both steps: 'employee' | 'public' | 'badToken' | 'retry'. */
function verdictFrom({ me, admin } = {}) {
	const step1 = classifyMe(me);
	return step1 === 'ok' ? classifyAdmin(admin) : step1;
}

/** Binds a cached mode to the host and token that produced it. The token itself is never stored. */
function cacheKey(host, apiKey) {
	return crypto.createHash('sha256').update(`${host}\n${apiKey}`).digest('hex');
}

function cacheEntry(host, apiKey, mode, now) {
	return { key: cacheKey(host, apiKey), host, mode, checkedAt: now };
}

function isFresh(entry, key, now) {
	if (!entry || entry.key !== key || !MODES.includes(entry.mode) || typeof entry.checkedAt !== 'number') return false;
	const age = now - entry.checkedAt;
	return age >= 0 && age < CACHE_TTL_MS;
}

/** [{ host, status } | { host, error }] -> { host } for exactly one 200, otherwise { ask: true, results }. */
function pickZone(results) {
	const matches = results.filter((r) => r.status === 200);
	return matches.length === 1 ? { host: matches[0].host } : { ask: true, results };
}

/** A network error -> a short code such as ECONNREFUSED or TimeoutError, never any text of the request. */
function errorCode(err) {
	const code = err?.cause?.code || err?.name;
	return typeof code === 'string' && SAFE_CODE.test(code) ? code : 'Error';
}

function parseBody(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** A call result without its body: { status } | { error } | null. */
function callSummary(result) {
	if (!result) return null;
	return typeof result.error === 'string' ? { error: result.error } : { status: result.status };
}

function validCall(result) {
	return Boolean(result) && (Number.isInteger(result.status) || (typeof result.error === 'string' && SAFE_CODE.test(result.error)));
}

/** stdout of the probe child -> { me, admin }, or a NO_OUTPUT error when it is not one. */
function parseProbeOutput(text) {
	try {
		const value = JSON.parse(text);
		if (value && validCall(value.me) && (value.admin === null || validCall(value.admin))) return { me: callSummary(value.me), admin: callSummary(value.admin) };
	} catch {
		/* empty or cut-off output: the child was killed or crashed */
	}
	return { me: { error: 'NO_OUTPUT' }, admin: null };
}

function describeCall(name, result) {
	if (!result) return `${name}: no answer`;
	return result.error ? `${name}: ${result.error}` : `${name}: HTTP ${result.status}`;
}

/** What failed in a 'retry' verdict, for retryMessage. */
function retryDetail({ me, admin } = {}) {
	return classifyMe(me) === 'ok' ? describeCall('admin API probe', admin) : describeCall('GET /users/me', me);
}

// Messages: the first line says what happened, the lines after it say what to do. None includes the token.

function badTokenMessage(host, { editor, setupCommand }) {
	const fix =
		editor === 'cursor'
			? `Create a new token at ${tokenPageUrl(host)} and put it in the active Make Apps SDK environment in Cursor.`
			: `Create a new token at ${tokenPageUrl(host)}, then save it in your own terminal (the agent must not run this):\n  ${setupCommand}`;
	return `Make rejected the saved API token for ${host} (HTTP 401).\n${fix}`;
}

function retryMessage(host, detail) {
	return `Could not check the Make API token for ${host} (${detail}).\nNothing was changed. Retry later, and check the network, VPN or proxy.`;
}

function employeeOnlyMessage(what) {
	return `${what} is for Make employees only, and this Make API token is in public mode (the Make admin API refused it).\nDo not retry or work around it: tell the user that this step needs a Make employee account.`;
}

/** One warning line when the admin flag of the Cursor environment disagrees with the probe, else null. */
function cursorAdminWarning({ cursorAdmin, mode }) {
	if (cursorAdmin === true && mode === 'public') return 'WARNING: the active Cursor environment has "admin": true, but the Make admin API refused this token, so the scripts use the public API.';
	if (cursorAdmin === false && mode === 'employee') return 'WARNING: the active Cursor environment has no "admin": true, but this token can use the Make admin API, so the scripts use the admin API.';
	return null;
}

/** The account name of a users/me result (its email when the name is empty), or null. */
function accountName(me) {
	const user = me?.body?.authUser;
	if (!user) return null;
	if (typeof user.name === 'string' && user.name.trim()) return user.name.trim();
	return typeof user.email === 'string' && user.email.trim() ? user.email.trim() : null;
}

/** How check-setup and the wizard show the account: the name (or email) of a 200 on one line, ACCOUNT_NAME_UNAVAILABLE for a 403, else null. */
function accountLabel(me) {
	if (me?.status === 403) return ACCOUNT_NAME_UNAVAILABLE;
	if (me?.status !== 200) return null;
	const name = accountName(me);
	return name && name.replace(/\s+/g, ' ');
}

function scriptNameOf(filename) {
	return filename ? path.basename(filename) : 'this script';
}

function formatScopes(scopes) {
	return scopes.join(' ');
}

/** RUN_COMPONENT_SCOPES in one line, for check-setup and the wizard. */
function runComponentScopesText() {
	const { everyRun, endpoints, connection, optional } = RUN_COMPONENT_SCOPES;
	return `${formatScopes([...endpoints, ...everyRun])}, plus ${formatScopes(connection)} for components with a connection; optional: ${formatScopes(optional)}`;
}

/** Host part of an app origin such as eu1.make.com or eu1.make.com/..., in lower case; null when there is none. */
function originHostOf(origin) {
	if (typeof origin !== 'string' || !origin) return null;
	return (origin.includes('/') ? origin.split('/')[0] : origin).toLowerCase();
}

/**
 * The zone switch of download-app.js and the six Make scripts that read the app origin (spec B 11.3). null when the
 * script goes on: no origin, the origin is the token host, or employee mode (it switches to the origin host as before).
 * In public mode a token works only in its own zone, so an origin elsewhere stops the script:
 * { originHost, reason, fix, message }, where reason fits a failure list and message is what happened, then the fix.
 */
function originStop({ mode, host, origin }) {
	const originHost = originHostOf(origin);
	if (!originHost || originHost === host || mode === 'employee') return null;
	const fix = `To work on this app, set up a Make API token of ${originHost} (create it at ${tokenPageUrl(originHost)}).`;
	return {
		originHost,
		reason: `the app lives in ${originHost}, the token is for ${host}`,
		fix,
		message: `The app lives in ${originHost}, the token is for ${host}.\n${fix}`,
	};
}

module.exports = {
	ZONES,
	MODES,
	CACHE_FILE_NAME,
	CACHE_TTL_MS,
	ADMIN_PROBE_QUERY,
	TEST_ORIGIN_VAR,
	TOKEN_SCOPES,
	RUN_COMPONENT_SCOPES,
	ACCOUNT_NAME_UNAVAILABLE,
	hostFromUrl,
	hostFromZone,
	testOrigin,
	publicBase,
	adminBase,
	baseFor,
	meUrl,
	adminProbeUrl,
	tokenPageUrl,
	classifyMe,
	classifyAdmin,
	verdictFrom,
	cacheKey,
	cacheEntry,
	isFresh,
	pickZone,
	errorCode,
	parseBody,
	callSummary,
	parseProbeOutput,
	retryDetail,
	badTokenMessage,
	retryMessage,
	employeeOnlyMessage,
	cursorAdminWarning,
	accountName,
	accountLabel,
	scriptNameOf,
	formatScopes,
	runComponentScopesText,
	originHostOf,
	originStop,
};
