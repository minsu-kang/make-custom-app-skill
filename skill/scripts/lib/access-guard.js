const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getSkillRoot } = require('./skill-root');
const { readSkillConfig } = require('./settings');
const logic = require('./access-guard-logic');

/**
 * Internal-use gate: the skill runs only for Make employees, whose Atlassian account is @make.com.
 * The email comes from Jira GET /myself with the saved token, so a line typed into the secrets file
 * does not count. Entry scripts reach this through version-guard's ensureFreshSkill().
 *
 * The check runs in a child process because entry scripts call the guard synchronously. The token
 * goes to the child over stdin, never on its command line. A verdict is cached for 24 hours.
 */
const CACHE_FILE = path.join(os.tmpdir(), 'make-custom-app-access-check.json');
const LOOKUP_TIMEOUT_MS = 6000;

const CHILD_SOURCE = [
	"const { fetchJiraEmail } = require(process.argv[1]);",
	"let raw = '';",
	"process.stdin.on('data', (c) => (raw += c)).on('end', async () => {",
	'const { baseUrl, email, token } = JSON.parse(raw);',
	`const fetchFn = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(${LOOKUP_TIMEOUT_MS}) });`,
	'try {',
	'process.stdout.write(JSON.stringify({ ok: true, email: await fetchJiraEmail({ baseUrl, email, token, fetchFn }) }));',
	'} catch (err) {',
	'const noEmail = err.code === "NO_EMAIL";',
	"process.stdout.write(JSON.stringify({ ok: false, status: err.status || null, noEmail, reason: err.status || noEmail ? null : (err.cause && err.cause.code) || err.name || null }));",
	'}',
	'});',
].join(' ');

/** Calls Jira /myself in a child process. Returns { ok, email } or { ok: false, status, noEmail, reason }. */
function lookupJiraEmail({ baseUrl, email, token }) {
	const run = spawnSync(process.execPath, ['-e', CHILD_SOURCE, path.join(__dirname, 'jira-myself.js')], {
		input: JSON.stringify({ baseUrl, email, token }),
		env: { ...process.env, ...logic.proxyEnv(process.env) },
		encoding: 'utf8',
		timeout: LOOKUP_TIMEOUT_MS + 4000,
		stdio: ['pipe', 'pipe', 'ignore'],
	});
	return logic.parseLookupOutput(run.stdout);
}

function readCache(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

function writeCache(file, data) {
	try {
		fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
	} catch {
		/* tmp not writable -> the next run checks again */
	}
}

function removeCache(file) {
	try {
		fs.unlinkSync(file);
	} catch {
		/* nothing cached */
	}
}

/** { ok: true, email, source } or { ok: false, code, ... }. Codes: see denyMessage(). */
function checkAccess({ readConfig = readSkillConfig, lookup = lookupJiraEmail, cacheFile = CACHE_FILE, now = Date.now, baseUrl = logic.JIRA_BASE_URL } = {}) {
	const email = readConfig('jira-email');
	const token = readConfig('jira-api-token');
	if (!email || !token) return { ok: false, code: 'NO_JIRA' };

	const key = logic.cacheKey({ baseUrl, email, token });
	const cache = readCache(cacheFile);
	const state = logic.cacheState(cache, key, now());
	if (state === 'fresh') return { ok: true, email: cache.email, source: 'cache' };

	if (state === 'stale' && logic.retryTooSoon(cache, now())) return { ok: true, email: cache.email, source: 'stale-cache' };

	const result = lookup({ baseUrl, email, token });
	const verdict = logic.verdictFromLookup(result);
	if (verdict === 'ok') {
		writeCache(cacheFile, { key, email: result.email, checkedAt: now() });
		return { ok: true, email: result.email, source: 'jira' };
	}
	if (verdict === 'external') {
		removeCache(cacheFile);
		return { ok: false, code: 'EXTERNAL', email: result.email };
	}
	if (verdict === 'rejected') {
		removeCache(cacheFile);
		return { ok: false, code: 'REJECTED', status: result.status };
	}
	if (state === 'stale') {
		writeCache(cacheFile, { ...cache, lastAttemptAt: now() });
		return { ok: true, email: cache.email, source: 'stale-cache' };
	}
	return { ok: false, code: 'UNVERIFIED', status: result.status || null, noEmail: Boolean(result.noEmail), reason: result.reason || null };
}

/** Exits 1 with the reason unless the Atlassian account is @make.com. */
function ensureInternalUser() {
	const result = checkAccess();
	if (result.ok) return;
	const setupCommand = `node ${path.join(getSkillRoot(), 'scripts', 'setup-secrets.js')}`;
	process.stderr.write(`\n${logic.denyMessage(result.code, { ...result, setupCommand })}\n`);
	process.exit(1);
}

module.exports = { CACHE_FILE, checkAccess, ensureInternalUser, lookupJiraEmail };
