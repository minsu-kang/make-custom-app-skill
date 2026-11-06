#!/usr/bin/env node
/**
 * Make Custom App Code Change Review Script
 *
 * Based on the 'apps-sdk-internal.changes.show' logic from ChangesCommands.js,
 * fetches uncommitted changes (old/new) for an app and saves them in a reviewable format.
 *
 * Usage:
 *   node review-changes.js <app-slug> <app-version> [--baseline <id|latest>]
 *   node review-changes.js google-docs 1
 *   node review-changes.js google-docs 1 --baseline latest
 *
 * Output:
 *   ~/.make-custom-app/contexts/{slug}-v{version}/reviews/latest.json (the same folder for every editor)
 *   plus a timestamped review-{timestamp}.json in the same dir when the review has changes
 *
 * Exit codes: 0 the review was written, 1 a usage error, a stop, a failed read, or a file that cannot be read or written
 * (one ERROR line), 2 no usable baseline.
 */

const fs = require('fs');
const path = require('path');
const { getContextsDir, scriptCommand } = require('./lib/paths');
const { originStop, testOrigin, TEST_ORIGIN_VAR } = require('./lib/mode-logic');
const read = require('./lib/api-read');
const { readJson, gateFailure } = require('./lib/download-app-logic');
const rc = require('./lib/review-changes-logic');
const snap = require('./lib/snapshot-logic');
const { appSnapshotsDir, listSnapshots, readTree } = require('./lib/snapshot-store');
require('./lib/settings').takeEditorFlagOrExit(process.argv);

const args = rc.parseArgs(process.argv.slice(2));
if (args.error !== null) {
	if (args.error) console.error(args.error);
	for (const line of rc.USAGE_LINES) console.log(line);
	process.exit(1);
}

const { slug, version } = args;
const workingDir = path.join(getContextsDir(), `${slug}-v${version}`);
const reviewsDir = path.join(workingDir, 'reviews');
const latestPath = path.join(reviewsDir, 'latest.json');
try {
	fs.rmSync(latestPath, { force: true });
} catch (err) {
	console.error(rc.fileErrorLine({ verb: 'write', file: latestPath, code: err.code }));
	process.exit(1);
}

// Against the loopback test origin of mode-logic.js the retries do not wait.
const BASE_DELAY_MS = testOrigin(process.env[TEST_ORIGIN_VAR]) ? 0 : 1000;

function fail(failed) {
	console.log('');
	for (const line of rc.failedLines(failed)) console.log(line);
	console.error(rc.failedErrorLine(failed.length));
	return 1;
}

/** A file-system error as the one ERROR line that ends the run; the catch at the end prints it. */
function fileStop(verb, file, err) {
	return Object.assign(new Error(rc.fileErrorLine({ verb, file, code: err.code })), { fileLine: true });
}

function writeOrStop(file, write) {
	try {
		write();
	} catch (err) {
		throw fileStop('write', file, err);
	}
}

/**
 * Writes the history file when there are changes, then latest.json, so latest.json exists only when every write
 * worked; returns both paths (history null when none).
 */
function save(doc) {
	const text = JSON.stringify(doc, null, 2);
	writeOrStop(reviewsDir, () => fs.mkdirSync(reviewsDir, { recursive: true }));
	let history = null;
	if (doc.totalChanges > 0) {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		history = path.join(reviewsDir, `review-${timestamp}.json`);
		writeOrStop(history, () => fs.writeFileSync(history, text));
	}
	writeOrStop(latestPath, () => fs.writeFileSync(latestPath, text));
	return { latest: latestPath, history };
}

async function apiRoute(get, verBase, state, mode) {
	console.log(`Found ${state.changes.length} change(s)\n`);
	const failed = [];
	const rows = [];
	for (const change of state.changes) {
		process.stdout.write(`  ${change.label} ... `);
		const diff = await get(`${verBase}/changes/${change.id}`);
		const got = diff.reason ? diff : rc.diffValues(diff.body);
		if (got.reason) {
			console.log(`✗ ${got.reason}`);
			failed.push({ what: change.label, reason: got.reason });
			continue;
		}
		const values = rc.maskedDiffValues({ mode, code: change.code, values: got });
		rows.push({ id: change.id, group: change.group, item: change.item, code: change.code, label: change.label, language: rc.languageOf(change.code), old_value: values.old_value, new_value: values.new_value });
		console.log('✓');
	}
	if (failed.length) return fail(failed);

	const { latest, history } = save(rc.reviewDocument({ slug, version, fetchedAt: new Date().toISOString(), source: 'api', approved: state.approved, changes: rows }));
	console.log(`\n=== Review data saved ===`);
	console.log(`  Latest: ${latest}`);
	console.log(`  History: ${history}`);
	console.log(`  Changes: ${rows.length}`);
	for (const d of rows) console.log(`    - ${d.label} (${d.language})`);
	return 0;
}

function baselineRoute(state) {
	if (!fs.existsSync(path.join(workingDir, 'metadata.json'))) {
		console.error(rc.noLocalCopyLine({ slug, version }));
		return 2;
	}
	let snapshots;
	try {
		snapshots = listSnapshots(slug, version, { strict: true });
	} catch (err) {
		throw fileStop('read', appSnapshotsDir(slug, version), err);
	}
	const explicitId = args.baseline && args.baseline !== 'latest' ? args.baseline : null;
	const chosen = explicitId ? snapshots.find((s) => s.id === explicitId) : snapshots.at(-1);
	if (!chosen && explicitId) {
		console.error(rc.unknownSnapshotLine({ slug, version, id: explicitId, ids: snapshots.map((s) => s.id) }));
		return 2;
	}
	if (!chosen) {
		for (const line of rc.noSnapshotLines({ slug, version, command: scriptCommand('download-app.js'), explicit: Boolean(args.baseline) })) console.error(line);
		return 2;
	}

	let working;
	let baseline;
	try {
		working = readTree(workingDir);
		baseline = readTree(chosen.dir);
	} catch (err) {
		return fail([rc.localCopyFailure(err)]);
	}
	const rows = snap.diffTrees({ working, baseline });
	const edited = snap.workingCopyEdited({ files: working.mtimes, downloadedAt: working.metadata?.downloadedAt });
	const { id, takenAt, dir } = chosen;
	const doc = rc.reviewDocument({ slug, version, fetchedAt: new Date().toISOString(), source: 'baseline', approved: state.approved, baseline: { id, takenAt, dir }, workingCopyEdited: edited, changes: rows });
	const { latest } = save(doc);
	for (const line of rc.baselineSummaryLines({ id, takenAt, counts: snap.countRows(rows), edited, saved: latest })) console.log(line);
	return 0;
}

async function reviewChanges(settings) {
	const { auth, mode, host } = settings;
	let { baseUrl } = settings;
	const get = async (url) => readJson(await read.apiGet(url, { auth, baseDelayMs: BASE_DELAY_MS }));

	console.log(`API: ${baseUrl}`);
	console.log(`App: ${slug} v${version}\n`);

	const lookup = await get(`${baseUrl}/sdk/apps/${slug}/${version}?cols[0]=origin`);
	if (lookup.reason) return fail([gateFailure(lookup.reason, { slug, version, host })]);
	const origin = lookup.body.app?.origin || lookup.body.origin;
	const stop = originStop({ mode, host, origin });
	if (stop) {
		console.error(stop.message);
		return 1;
	}
	if (typeof origin === 'string' && origin) {
		const currentHost = new URL(baseUrl).hostname;
		const originHost = origin.includes('/') ? origin.split('/')[0] : origin;
		if (currentHost !== originHost) {
			const newUrl = baseUrl.replace(currentHost, originHost);
			console.log(`  Origin: ${origin}`);
			console.log(`  URL: ${baseUrl} → ${newUrl}`);
			baseUrl = newUrl;
		}
	}

	const verBase = `${baseUrl}/sdk/apps/${slug}/${version}`;
	console.log('Fetching changes...');
	const answer = await get(`${verBase}?cols[0]=changes&cols[1]=approved`);
	const state = answer.reason ? answer : rc.parseState(answer.body);
	if (state.reason) return fail([{ what: 'change list', reason: state.reason, fix: state.fix }]);

	const route = rc.chooseRoute({ mode, approved: state.approved, rowCount: state.changes.length, baseline: args.baseline });
	if (route === 'api') return apiRoute(get, verBase, state, mode);
	if (route === 'baseline') return baselineRoute(state);

	console.log(`\n${route === 'empty' ? rc.EMPTY_LINE : rc.APPROVED_EMPTY_LINE}`);
	const { latest } = save(rc.reviewDocument({ slug, version, fetchedAt: new Date().toISOString(), source: 'api', approved: state.approved, changes: [] }));
	console.log(`Saved: ${latest}`);
	return 0;
}

const settings = require('./lib/mode').requireMode();

reviewChanges(settings)
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err) => {
		console.error(err.fileLine ? err.message : `ERROR: ${err.message}`);
		process.exit(1);
	});
