#!/usr/bin/env node
/**
 * Make Custom App Commit / Rollback / Compile Script
 *
 * Mirrors the 'apps-sdk-internal.changes.{commit,rollback,compile}' commands
 * from ChangesCommands.js:
 *   POST /sdk/apps/{slug}/{version}/commit    body { notify, message, changeIds }
 *   POST /sdk/apps/{slug}/{version}/rollback  (no body — discards ALL pending changes)
 *   POST /sdk/apps/{slug}/{version}/compile   (no body — enqueues a compile)
 *
 * Usage:
 *   node commit-changes.js <app-slug> <app-version> commit --message="..." [--change-ids=1,2] [--notify] [--issue=KEY]
 *   node commit-changes.js <app-slug> <app-version> rollback --confirm
 *   node commit-changes.js <app-slug> <app-version> compile [--issue=KEY]
 *
 * Examples:
 *   node commit-changes.js google-docs 1 commit --message="IEN-15238 fix pagination"
 *   node commit-changes.js google-docs 1 commit --message="partial" --change-ids=8891,8892
 *   node commit-changes.js google-docs 1 commit --message="IEN-15238 fix" --issue=IEN-15238
 *   node commit-changes.js google-docs 1 rollback --confirm
 *
 * `--issue=<key>` chains `post-review-transition.js <key> committed` after a
 * successful commit/compile (both are the review "forward path").
 *
 * Exit codes: 0 ok · 1 error · 2 nothing to do / precondition failed
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { loadSettings } = require('./lib/settings');

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const SDK_VERSION_HEADER = '2.4.0';
const MESSAGE_MAX_LENGTH = 1000;

const ACTIONS = ['commit', 'rollback', 'compile'];

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiRequest(method, url, auth, body, retries = 0) {
	const headers = {
		Authorization: auth,
		'x-imt-apps-sdk-version': SDK_VERSION_HEADER,
	};
	if (body != null) headers['Content-Type'] = 'application/json';

	try {
		const resp = await fetch(url, {
			method,
			headers,
			body: body != null ? JSON.stringify(body) : undefined,
		});

		if (resp.status === 429) {
			if (retries >= MAX_RETRIES) {
				return { ok: false, status: 429, message: '429 retries exceeded' };
			}
			const retryAfter = resp.headers.get('retry-after');
			const delay = retryAfter
				? parseInt(retryAfter, 10) * 1000
				: BASE_DELAY_MS * Math.pow(2, retries);
			console.error(`  ⏳ 429 Rate Limit → retrying in ${delay}ms`);
			await sleep(delay);
			return apiRequest(method, url, auth, body, retries + 1);
		}

		const text = await resp.text();
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch (e) {
			json = null;
		}

		if (!resp.ok) {
			return {
				ok: false,
				status: resp.status,
				message: json?.message || json?.detail || text.slice(0, 400),
			};
		}
		return { ok: true, status: resp.status, json };
	} catch (err) {
		if (retries < MAX_RETRIES) {
			await sleep(BASE_DELAY_MS * Math.pow(2, retries));
			return apiRequest(method, url, auth, body, retries + 1);
		}
		return { ok: false, status: 0, message: err.message };
	}
}

async function apiGetJson(url, auth) {
	const result = await apiRequest('GET', url, auth);
	if (!result.ok) {
		console.error(`  ✗ HTTP ${result.status}: ${url}\n    ${result.message}`);
		return null;
	}
	return result.json;
}

async function resolveOrigin(baseUrl, auth, appSlug, appVersion) {
	const resp = await apiGetJson(`${baseUrl}/sdk/apps/${appSlug}/${appVersion}?cols[0]=origin`, auth);
	const origin = resp?.app?.origin || resp?.origin;
	if (!origin) return baseUrl;

	const currentHost = new URL(baseUrl).hostname;
	const originHost = origin.includes('/') ? origin.split('/')[0] : origin;
	if (currentHost === originHost) return baseUrl;

	const newUrl = baseUrl.replace(currentHost, originHost);
	console.log(`  Origin: ${origin}`);
	console.log(`  URL: ${baseUrl} → ${newUrl}`);
	return newUrl;
}

function parseArgs(argv) {
	const positional = [];
	const flags = {
		message: null,
		changeIds: null,
		notify: false,
		confirm: false,
		issue: null,
	};

	for (const arg of argv) {
		if (arg === '--notify') {
			flags.notify = true;
		} else if (arg === '--confirm') {
			flags.confirm = true;
		} else if (arg.startsWith('--message=')) {
			flags.message = arg.slice('--message='.length);
		} else if (arg.startsWith('--change-ids=')) {
			flags.changeIds = arg
				.slice('--change-ids='.length)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		} else if (arg.startsWith('--issue=')) {
			flags.issue = arg.slice('--issue='.length).trim();
		} else if (arg.startsWith('--')) {
			console.error(`Unknown flag: ${arg}`);
			process.exit(1);
		} else {
			positional.push(arg);
		}
	}

	return { positional, flags };
}

function labelOf(change) {
	return `${change.group}/${change.item}/${change.code}`;
}

async function fetchAppState(verBase, auth) {
	const data = await apiGetJson(`${verBase}?cols[0]=changes&cols[1]=approved`, auth);
	if (!data) return null;
	const app = data.app || data;
	return { changes: app.changes || [], approved: app.approved };
}

function runTransition(issueKey) {
	const scriptPath = path.join(__dirname, 'post-review-transition.js');
	console.log(`\n▸ Chaining: post-review-transition.js ${issueKey} committed\n`);
	const result = spawnSync(process.execPath, [scriptPath, issueKey, 'committed'], {
		stdio: 'inherit',
	});
	if (result.status !== 0) {
		console.error(
			`\n⚠️  Transition step exited with code ${result.status}. The app action itself succeeded — resolve the Jira side manually.`,
		);
	}
}

async function doCommit(verBase, auth, flags) {
	const message = flags.message;
	if (!message || message.length === 0 || message.length > MESSAGE_MAX_LENGTH) {
		console.error(
			`ERROR: --message is required and must be 1–${MESSAGE_MAX_LENGTH} characters (Validator.commitMessage).`,
		);
		process.exit(1);
	}

	const state = await fetchAppState(verBase, auth);
	if (!state) process.exit(1);

	if (state.changes.length === 0) {
		console.error('ABORT: no pending changes to commit.');
		if (state.approved === false) {
			console.error(
				'  App is not approved (approved: false) → SDK edits write directly to the DB and never create change rows.',
			);
			console.error('  There is nothing to commit; the forward action for this app is `compile`.');
		}
		process.exit(2);
	}

	let selected = state.changes;
	if (flags.changeIds) {
		const wanted = new Set(flags.changeIds.map(String));
		selected = state.changes.filter((c) => wanted.has(String(c.id)));
		const found = new Set(selected.map((c) => String(c.id)));
		const missing = [...wanted].filter((id) => !found.has(id));
		if (missing.length > 0) {
			console.error(`ABORT: change id(s) not pending on this app: ${missing.join(', ')}`);
			console.error('  Pending ids:');
			state.changes.forEach((c) => console.error(`    ${c.id}  ${labelOf(c)}`));
			process.exit(2);
		}
	}

	console.log(`Message: ${message}`);
	console.log(`Notify: ${flags.notify}`);
	console.log(
		`Changes: ${selected.length}/${state.changes.length}${flags.changeIds ? ' (selected)' : ' (all pending)'}`,
	);
	selected.forEach((c) => console.log(`  - ${c.id}  ${labelOf(c)}`));
	console.log('');

	const result = await apiRequest('POST', `${verBase}/commit`, auth, {
		notify: flags.notify,
		message,
		changeIds: selected.map((c) => c.id),
	});

	if (!result.ok) {
		console.error(`✗ Commit failed (HTTP ${result.status}): ${result.message}`);
		process.exit(1);
	}

	console.log(`✓ Committed ${selected.length} change(s) (HTTP ${result.status})`);
	console.log('  A compile is enqueued automatically by the commit routine.');

	const remaining = state.changes.length - selected.length;
	if (remaining > 0) console.log(`  ${remaining} change(s) still pending.`);
}

async function doRollback(verBase, auth, flags) {
	if (!flags.confirm) {
		console.error('ABORT: rollback discards ALL pending changes on this app version and cannot be undone.');
		console.error('  The endpoint takes no change ids — it is all-or-nothing.');
		console.error('  Re-run with --confirm once the user has explicitly approved it.');
		process.exit(2);
	}

	const state = await fetchAppState(verBase, auth);
	if (!state) process.exit(1);

	if (state.changes.length === 0) {
		console.error('ABORT: no pending changes to roll back.');
		process.exit(2);
	}

	console.log(`Discarding ${state.changes.length} pending change(s):`);
	state.changes.forEach((c) => console.log(`  - ${c.id}  ${labelOf(c)}`));
	console.log('');

	const result = await apiRequest('POST', `${verBase}/rollback`, auth, {});
	if (!result.ok) {
		console.error(`✗ Rollback failed (HTTP ${result.status}): ${result.message}`);
		process.exit(1);
	}
	console.log(`✓ Rolled back ${state.changes.length} change(s) (HTTP ${result.status})`);
	console.log('  Re-run download-app.js to resync the local snapshot.');
}

async function doCompile(verBase, auth) {
	const result = await apiRequest('POST', `${verBase}/compile`, auth, {});
	if (!result.ok) {
		console.error(`✗ Compile request failed (HTTP ${result.status}): ${result.message}`);
		process.exit(1);
	}
	console.log(`✓ Compile enqueued (HTTP ${result.status})`);

	// The compile runs asynchronously in make-apps-processor; compilationError is
	// the only signal surfaced back onto the app record.
	for (let attempt = 0; attempt < 5; attempt++) {
		await sleep(1500);
		const data = await apiGetJson(`${verBase}?cols[0]=compilationError&cols[1]=compile`, auth);
		const compilationError = (data?.app || data || {}).compilationError;
		if (compilationError) {
			console.error(`✗ Compilation error: ${compilationError}`);
			process.exit(1);
		}
	}
	console.log('  No compilation error reported after polling.');
}

async function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	const [appSlug, appVersion, action] = positional;

	if (!appSlug || !appVersion || !ACTIONS.includes(action)) {
		console.log('Usage: node commit-changes.js <app-slug> <app-version> <commit|rollback|compile> [options]');
		console.log('');
		console.log('  commit    --message="..." [--change-ids=1,2] [--notify] [--issue=KEY]');
		console.log('  rollback  --confirm            (discards ALL pending changes)');
		console.log('  compile   [--issue=KEY]');
		console.log('');
		console.log('Example: node commit-changes.js google-docs 1 commit --message="IEN-15238 fix pagination"');
		process.exit(1);
	}

	let { baseUrl, auth } = loadSettings();
	console.log(`API: ${baseUrl}`);
	console.log(`App: ${appSlug} v${appVersion}`);
	console.log(`Action: ${action}\n`);

	baseUrl = await resolveOrigin(baseUrl, auth, appSlug, appVersion);
	const verBase = `${baseUrl}/sdk/apps/${appSlug}/${appVersion}`;

	if (action === 'commit') {
		await doCommit(verBase, auth, flags);
	} else if (action === 'rollback') {
		await doRollback(verBase, auth, flags);
	} else {
		await doCompile(verBase, auth);
	}

	if (flags.issue && action !== 'rollback') {
		runTransition(flags.issue);
	}
}

require('./lib/version-guard').ensureFreshSkill();

main().catch((err) => {
	console.error('ERROR:', err.message);
	process.exit(1);
});
