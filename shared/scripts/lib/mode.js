const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { setupCommand } = require('./paths');
const { loadSettings } = require('./settings');
const { proxyEnv } = require('./access-guard-logic');
const logic = require('./mode-logic');

/**
 * Employee or public mode of the saved Make API token: employee when the Make admin API accepts it (spec B 3.2).
 * Entry scripts call requireMode(); check-setup and the wizard call detectMode() and saveVerdict().
 *
 * requireMode() runs the probe in a child process because entry scripts are synchronous. The token goes to the child
 * over stdin, never on its command line. A verdict is cached for 24 hours under a hash of host and token.
 * MAKE_CUSTOM_APP_TEST_API_ORIGIN (http(s) on a loopback host only) sends every call and baseUrl to a local mock.
 */
const CACHE_FILE = path.join(os.tmpdir(), logic.CACHE_FILE_NAME);
const FETCH_TIMEOUT_MS = 6000;
const SPAWN_TIMEOUT_MS = 15000;

const CHILD_SOURCE = [
	'const { detectMode } = require(process.argv[1]);',
	'const { callSummary } = require(process.argv[2]);',
	"let raw = '';",
	"process.stdin.on('data', (c) => (raw += c)).on('end', async () => {",
	'const { host, apiKey, origin } = JSON.parse(raw);',
	'const { me, admin } = await detectMode(host, apiKey, { origin });',
	'process.stdout.write(JSON.stringify({ me: callSummary(me), admin: callSummary(admin) }));',
	'});',
].join(' ');

function envTestOrigin() {
	return logic.testOrigin(process.env[logic.TEST_ORIGIN_VAR]);
}

function timedFetch(url, options) {
	return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/** One GET with the token: { status, body } (body is the parsed JSON or null) or { error }. Never throws. */
async function call(url, apiKey, fetchFn) {
	try {
		const res = await fetchFn(url, { headers: { Accept: 'application/json', Authorization: `Token ${apiKey}` } });
		return { status: res.status, body: logic.parseBody(await res.text()) };
	} catch (err) {
		return { error: logic.errorCode(err) };
	}
}

/** GET users/me, then the admin probe when users/me answered 200 or 403: { me, admin, verdict }; admin is null when it did not run. */
async function detectMode(host, apiKey, { fetchFn = timedFetch, origin = envTestOrigin() } = {}) {
	const me = await call(logic.meUrl(host, origin), apiKey, fetchFn);
	const admin = logic.classifyMe(me) === 'ok' ? await call(logic.adminProbeUrl(host, origin), apiKey, fetchFn) : null;
	return { me, admin, verdict: logic.verdictFrom({ me, admin }) };
}

/** GET users/me on every zone at once: pickZone of [{ host, status } | { host, error }]. */
async function detectZone(apiKey, { fetchFn = timedFetch, origin = envTestOrigin() } = {}) {
	const results = await Promise.all(logic.ZONES.map(async (host) => ({ host, ...logic.callSummary(await call(logic.meUrl(host, origin), apiKey, fetchFn)) })));
	return logic.pickZone(results);
}

/** detectMode in a child process: { me, admin } as { status } or { error }, without bodies. */
function probeSync(host, apiKey, { origin = envTestOrigin() } = {}) {
	const run = spawnSync(process.execPath, ['-e', CHILD_SOURCE, __filename, path.join(__dirname, 'mode-logic.js')], {
		input: JSON.stringify({ host, apiKey, origin }),
		env: { ...process.env, ...proxyEnv(process.env) },
		encoding: 'utf8',
		timeout: SPAWN_TIMEOUT_MS,
		stdio: ['pipe', 'pipe', 'ignore'],
	});
	return logic.parseProbeOutput(run.stdout);
}

function readCache(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

/** 'employee' | 'public' from a fresh cache entry of this host and token, else null. */
function cachedMode(host, apiKey, { cacheFile = CACHE_FILE, now = Date.now } = {}) {
	const entry = readCache(cacheFile);
	return logic.isFresh(entry, logic.cacheKey(host, apiKey), now()) ? entry.mode : null;
}

/** employee and public are cached, badToken drops the cache, retry leaves it as it is. Never throws. */
function saveVerdict(host, apiKey, verdict, { cacheFile = CACHE_FILE, now = Date.now } = {}) {
	try {
		if (logic.MODES.includes(verdict)) fs.writeFileSync(cacheFile, JSON.stringify(logic.cacheEntry(host, apiKey, verdict, now())), { mode: 0o600 });
		else if (verdict === 'badToken') fs.unlinkSync(cacheFile);
	} catch {
		/* tmp not writable, or nothing cached: the next run probes again */
	}
}

function exitWith(text) {
	process.stderr.write(`\n${text}\n`);
	process.exit(1);
}

/** Prints employeeOnlyMessage(what) to stderr and exits 1. */
function exitEmployeeOnly(what) {
	exitWith(logic.employeeOnlyMessage(what));
}

/**
 * The gate of every entry script that calls Make. Credentials come from settings.loadSettings(), which exits on a
 * missing key or host. The mode comes from a fresh cache entry or a probe. Exits 1 on a rejected token, on a probe that
 * got no usable answer, and for an employee-only script in public mode. Employee mode then runs today's Jira check.
 * Returns the settings plus mode and baseUrl. cacheFile, now and probe are for tests.
 */
function requireMode({ employeeOnly = false, scriptName = logic.scriptNameOf(require.main?.filename), cacheFile = CACHE_FILE, now = Date.now, probe = probeSync } = {}) {
	const settings = loadSettings();
	const { editor, host, apikey } = settings;
	const origin = envTestOrigin();
	let mode = cachedMode(host, apikey, { cacheFile, now });
	if (!mode) {
		const result = probe(host, apikey, { origin });
		const verdict = logic.verdictFrom(result);
		saveVerdict(host, apikey, verdict, { cacheFile, now });
		if (verdict === 'badToken') exitWith(logic.badTokenMessage(host, { editor, setupCommand: setupCommand(editor) }));
		if (verdict === 'retry') exitWith(logic.retryMessage(host, logic.retryDetail(result)));
		mode = verdict;
	}
	if (mode === 'public' && employeeOnly) exitWith(logic.employeeOnlyMessage(scriptName));
	if (mode === 'employee') require('./access-guard').ensureInternalUser();
	return { ...settings, mode, baseUrl: logic.baseFor(mode, host, origin) };
}

module.exports = { CACHE_FILE, detectMode, detectZone, probeSync, cachedMode, saveVerdict, requireMode, exitEmployeeOnly };
