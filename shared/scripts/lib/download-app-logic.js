/**
 * download-app-logic.js: the decisions behind download-app.js (spec B section 6 and amendments 11.2, 11.3).
 *
 * Role: pure functions only. A call result goes in ({ status, body, error }: status and body text of a response, or
 * status null and a short error code after a network failure), and a classification comes out: saved, absent or
 * failed. No network, no file access, no process.exit, no console.
 */
const { parseBody, originHostOf, originStop, TOKEN_SCOPES, formatScopes } = require('./mode-logic');

const { MAX_RETRIES, isTransientStatus } = require('./api-read');
const { snapshotDoneLines } = require('./snapshot-logic');
const PUBLIC_VISIBILITY_LINE = '  · Visibility flags (private, packagePrivate, ipmDeployedToZone) are not available in public mode. metadata.json keeps them as null.';
const AUTH_FIX = `For HTTP 401 or 403: the Make API token was rejected, lacks one of the scopes ${formatScopes(TOKEN_SCOPES)}, or cannot read this app, and Make answers 403 for an app version that does not exist too. Check the slug and the version, then run check-setup.js.`;
const RETRY_FIX = 'Retry later, and check the network, VPN or proxy.';
const USAGE_LINES = [
	'Usage: node download-app.js <app-slug> <app-version> [output-dir | --snapshot]',
	'Example: node download-app.js google-docs 1',
	'        node download-app.js instagram 5 /tmp/instagram-v5',
	'        node download-app.js google-docs 1 --snapshot',
];
const SNAPSHOT_WITH_OUTPUT_DIR = 'ERROR: --snapshot saves to ~/.make-custom-app/snapshots and takes no output dir.';

/** Removes every `--snapshot` from argv in place and says whether there was one. */
function takeSnapshotFlag(argv) {
	let found = false;
	for (let i = argv.length - 1; i >= 0; i--) {
		if (argv[i] === '--snapshot') {
			argv.splice(i, 1);
			found = true;
		}
	}
	return found;
}

function isOk(result) {
	return Number.isInteger(result.status) && result.status >= 200 && result.status < 300;
}

/** A body of 'null' or only whitespace is a section without content. */
function isEmptyBody(text) {
	return typeof text !== 'string' || text === 'null' || !text.trim();
}

/**
 * 'saved' | 'absent' | 'failed' for one section file. A 404 on a section means the app does not have it, whatever the
 * component kind or type; only the app version and the component lists fail on a 404 (readJson, readList).
 */
function classifySection(result) {
	if (isOk(result)) return isEmptyBody(result.body) ? 'absent' : 'saved';
	return result.status === 404 ? 'absent' : 'failed';
}

/** Why a call counts as failed, without host, URL or token: an error code, 'HTTP n', or 'unexpected response'. */
function failureReason(result) {
	if (result.error) return result.error;
	if (result.status === 429 || isTransientStatus(result.status)) return `HTTP ${result.status} after ${MAX_RETRIES} retries`;
	if (isOk(result)) return 'unexpected response';
	return `HTTP ${result.status}`;
}

/** A JSON object answer: { body } | { reason }. Every non-2xx fails, a 404 included. */
function readJson(result) {
	if (!isOk(result)) return { reason: failureReason(result) };
	const body = parseBody(result.body);
	return body && typeof body === 'object' ? { body } : { reason: 'unexpected response' };
}

/** A component list such as { appModules: [...] }: { items } | { reason }. A list without its array key failed. */
function readList(result, key) {
	const json = readJson(result);
	if (json.reason) return json;
	return Array.isArray(json.body[key]) ? { items: json.body[key] } : { reason: 'unexpected response' };
}

/** The endpoint detail, a section of its component: { body } | { absent: true } on a 404 | { reason }. */
function readDetail(result) {
	return result.status === 404 ? { absent: true } : readJson(result);
}

/** The failure entry of the app-version GET, with a fix line when the app is not there. */
function gateFailure(reason, { slug, version, host }) {
	const failure = { what: `app ${slug} v${version}`, reason };
	if (reason === 'HTTP 404') failure.fix = `${host} has no ${slug} v${version} that this token can read: check the slug, the version and the zone.`;
	return failure;
}

/**
 * What to do with the app's origin: { action: 'stay' }, { action: 'switch', host } (employee mode, as before), or
 * { action: 'fail', failure } (public mode). The rule and its words are originStop of mode-logic.js (spec B 11.3).
 */
function planOrigin(mode, host, origin) {
	const originHost = originHostOf(origin);
	if (!originHost || originHost === host) return { action: 'stay' };
	const stop = originStop({ mode, host, origin });
	if (!stop) return { action: 'switch', host: originHost };
	return { action: 'fail', failure: { what: 'app origin', reason: stop.reason, fix: stop.fix } };
}

const isObject = (value) => value !== null && typeof value === 'object';

/** The version row with a usable modules list: a row whose modules are not an array of objects gets an empty list. */
function cleanRow(row) {
	if (!row || row.modules === undefined) return row;
	return { ...row, modules: Array.isArray(row.modules) ? row.modules.filter(isObject) : [] };
}

/** The header of the visibility block: the admin app endpoint is named only where it is called. */
function visibilityHeader(mode) {
	return mode === 'public' ? '=== Visibility ===' : '=== Visibility (admin app endpoint) ===';
}

/**
 * The admin app endpoint (employee mode only): { ipmDeployed, verRow, line }. Never a failure, whatever the body: a
 * body whose versions are not a list counts as unusable, and rows that are not objects are skipped. A null result
 * means the call was not made (public mode).
 */
function visibilityOutcome(result, appVersion, where) {
	const unknown = (line) => ({ ipmDeployed: null, verRow: null, line });
	if (!result) return unknown(PUBLIC_VISIBILITY_LINE);
	if (result.error) return unknown(`  · admin endpoint error: ${result.error}. Visibility flags = null.`);
	if (result.status === 200) {
		const body = parseBody(result.body);
		const unusable = '  · admin endpoint error: unexpected response. Visibility flags = null.';
		if (!body || typeof body !== 'object') return unknown(unusable);
		const versions = body.app?.versions || [];
		if (!Array.isArray(versions)) return unknown(unusable);
		const verRow =
			versions.find((v) => isObject(v) && String(v.version) === String(appVersion)) ||
			versions.find((v) => isObject(v) && parseInt(v.version, 10) === parseInt(appVersion, 10)) ||
			null;
		return { ipmDeployed: true, verRow: cleanRow(verRow), line: `  ✓ IPM-deployed to ${where} (${versions.length} version row(s))` };
	}
	if (result.status === 404) return { ipmDeployed: false, verRow: null, line: '  · 404 → app not IPM-deployed to this zone (compiled but not published). Visibility flags = null.' };
	if (result.status === 403) return unknown('  · 403 → caller lacks admin access to this endpoint. Visibility flags = null.');
	return unknown(`  · HTTP ${result.status} on admin endpoint. Visibility flags = null.`);
}

function fixesFor(failed) {
	return [...new Set(failed.map((f) => f.fix || (/^HTTP 40[13]$/.test(f.reason) ? AUTH_FIX : RETRY_FIX)))];
}

/**
 * The Done block on stdout. With a failure it lists every failed section and says that nothing was written. A
 * snapshot run (spec 3.3) ends with the snapshot lines instead of the Path line.
 */
function doneLines({ saved, absent, failed, outputDir, mode, snapshotMode = false, snapshot = null }) {
	const lines = ['', '=== Done ==='];
	if (failed.length) {
		lines.push(`  Failed: ${failed.length}`);
		for (const f of failed) lines.push(`    ✗ ${f.what} (${f.reason})`);
		lines.push(snapshotMode ? '  Nothing was written: no snapshot was taken.' : `  Nothing was written: ${outputDir} is unchanged.`);
		for (const fix of fixesFor(failed)) lines.push(`  ${fix}`);
		return lines;
	}
	lines.push(`  Saved: ${saved} file(s)`, `  Absent: ${absent} (empty or not set on the server)`);
	if (mode === 'public') lines.push('  Visibility: unknown (public mode)');
	if (snapshot) lines.push(...snapshotDoneLines(snapshot));
	else lines.push(`  Path: ${outputDir}`);
	return lines;
}

/** The stderr lines when a snapshot could not be written: the error code and the step that clears it. */
function snapshotWriteErrorLines(code) {
	return [`ERROR: the snapshot could not be written (${code || 'error'}), so none was kept.`, 'Check that ~/.make-custom-app/snapshots can be written, then run the same command again.'];
}

/** The last line on stderr when a section failed. */
function failedErrorLine(count, slug, version) {
	return `ERROR: ${count} section(s) of ${slug} v${version} could not be read, so nothing was written. Show the failed sections above to the user; do not answer from the local copy.`;
}

module.exports = {
	MAX_RETRIES,
	AUTH_FIX,
	RETRY_FIX,
	USAGE_LINES,
	SNAPSHOT_WITH_OUTPUT_DIR,
	takeSnapshotFlag,
	classifySection,
	failureReason,
	readJson,
	readList,
	readDetail,
	gateFailure,
	planOrigin,
	visibilityHeader,
	visibilityOutcome,
	fixesFor,
	doneLines,
	snapshotWriteErrorLines,
	failedErrorLine,
};
