#!/usr/bin/env node
/**
 * Make Custom App Code Change Review Script
 *
 * Based on the 'apps-sdk-internal.changes.show' logic from ChangesCommands.js,
 * fetches uncommitted changes (old/new) for an app and saves them in a reviewable format.
 *
 * Usage:
 *   node review-changes.js <app-slug> <app-version>
 *   node review-changes.js google-docs 1
 *
 * Output:
 *   ~/.cursor/make-app-contexts/{slug}-v{version}/reviews/latest.json
 *   ~/.cursor/make-app-contexts/{slug}-v{version}/reviews/review-{timestamp}.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(
	os.homedir(),
	process.platform === 'win32'
		? 'AppData/Roaming/Cursor/User/settings.json'
		: 'Library/Application Support/Cursor/User/settings.json',
);
const DEFAULT_CONTEXTS_DIR = path.join(os.homedir(), '.cursor/make-app-contexts');

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

function parseJsonc(text) {
	let cleaned = text.replace(/\/\/.*$/gm, '');
	cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
	cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
	return JSON.parse(cleaned);
}

function loadSettings() {
	const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
	const settings = parseJsonc(raw);

	const activeUuid = settings['apps-sdk.environment'];
	const environments = settings['apps-sdk.environments'] || [];

	const env = environments.find((e) => e.uuid === activeUuid) || environments[0];
	if (!env) {
		console.error('ERROR: apps-sdk.environments configuration not found.');
		process.exit(1);
	}

	const version = env.version || 2;
	let baseUrl;
	if (version === 1) {
		baseUrl = `https://${env.url}/v1`;
	} else {
		const proto = env.unsafe ? 'http' : 'https';
		const verPath = env.noVersionPath ? '' : `/v${version}`;
		const adminPath = env.admin ? '/admin' : '';
		baseUrl = `${proto}://${env.url}${verPath}${adminPath}`;
	}

	return { baseUrl, auth: `Token ${env.apikey}`, version };
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(url, auth, retries = 0) {
	try {
		const resp = await fetch(url, {
			headers: {
				Authorization: auth,
				'x-imt-apps-sdk-version': '2.4.0',
			},
		});
		if (resp.status === 404) return null;
		if (resp.status === 429) {
			if (retries >= MAX_RETRIES) {
				console.error(`  ✗ 429 retries exceeded: ${url}`);
				return null;
			}
			const retryAfter = resp.headers.get('retry-after');
			const delay = retryAfter
				? parseInt(retryAfter, 10) * 1000
				: BASE_DELAY_MS * Math.pow(2, retries);
			console.error(`  ⏳ 429 Rate Limit → retrying in ${delay}ms`);
			await sleep(delay);
			return apiGet(url, auth, retries + 1);
		}
		if (!resp.ok) {
			const body = await resp.text();
			console.error(`  ✗ HTTP ${resp.status}: ${url}\n    ${body.slice(0, 200)}`);
			return null;
		}
		return resp;
	} catch (err) {
		if (retries < MAX_RETRIES) {
			const delay = BASE_DELAY_MS * Math.pow(2, retries);
			await sleep(delay);
			return apiGet(url, auth, retries + 1);
		}
		console.error(`  ✗ ${url}: ${err.message}`);
		return null;
	}
}

async function apiGetJson(url, auth) {
	const resp = await apiGet(url, auth);
	if (!resp) return null;
	return resp.json();
}

async function resolveOrigin(baseUrl, auth, appSlug, appVersion) {
	const url = `${baseUrl}/sdk/apps/${appSlug}/${appVersion}?cols[0]=origin`;
	const resp = await apiGetJson(url, auth);
	const origin = resp?.app?.origin || resp?.origin;

	if (origin) {
		const currentHost = new URL(baseUrl).hostname;
		const originHost = origin.includes('/') ? origin.split('/')[0] : origin;
		if (currentHost !== originHost) {
			const newUrl = baseUrl.replace(currentHost, originHost);
			console.log(`  Origin: ${origin}`);
			console.log(`  URL: ${baseUrl} → ${newUrl}`);
			return { baseUrl: newUrl, origin };
		}
	}
	return { baseUrl, origin };
}

function formatValue(value) {
	if (value == null) return null;
	if (typeof value === 'object') return JSON.stringify(value, null, 4);
	return String(value);
}

async function reviewChanges(appSlug, appVersion) {
	let { baseUrl, auth } = loadSettings();

	console.log(`API: ${baseUrl}`);
	console.log(`App: ${appSlug} v${appVersion}\n`);

	const resolved = await resolveOrigin(baseUrl, auth, appSlug, appVersion);
	baseUrl = resolved.baseUrl;

	const verBase = `${baseUrl}/sdk/apps/${appSlug}/${appVersion}`;

	console.log('Fetching changes...');
	const appData = await apiGetJson(`${verBase}?cols[0]=changes`, auth);
	const changes = appData?.app?.changes || [];

	const outputDir = path.join(DEFAULT_CONTEXTS_DIR, `${appSlug}-v${appVersion}`, 'reviews');
	fs.mkdirSync(outputDir, { recursive: true });

	if (changes.length === 0) {
		console.log('\nNo changes found.');
		const outputFile = path.join(outputDir, 'latest.json');
		fs.writeFileSync(
			outputFile,
			JSON.stringify(
				{
					appSlug,
					appVersion,
					fetchedAt: new Date().toISOString(),
					totalChanges: 0,
					changes: [],
				},
				null,
				2,
			),
		);
		console.log(`Saved: ${outputFile}`);
		return;
	}

	console.log(`Found ${changes.length} change(s)\n`);

	const diffs = [];
	for (const change of changes) {
		const label = `${change.group}/${change.item}/${change.code}`;
		process.stdout.write(`  ${label} ... `);

		const diffData = await apiGetJson(`${verBase}/changes/${change.id}`, auth);
		if (!diffData) {
			console.log('✗ failed');
			continue;
		}

		const oldValue =
			diffData.old_value ?? diffData.oldValue ?? diffData.change?.oldValue ?? null;
		const newValue =
			diffData.new_value ?? diffData.newValue ?? diffData.change?.newValue ?? null;

		const isCode = ['code', 'test'].includes(change.code);
		const language = isCode ? 'js' : 'imljson';

		diffs.push({
			id: change.id,
			group: change.group,
			item: change.item,
			code: change.code,
			language,
			old_value: formatValue(oldValue),
			new_value: formatValue(newValue),
		});

		console.log('✓');
	}

	const reviewData = {
		appSlug,
		appVersion,
		fetchedAt: new Date().toISOString(),
		totalChanges: diffs.length,
		changes: diffs,
	};

	const latestFile = path.join(outputDir, 'latest.json');
	fs.writeFileSync(latestFile, JSON.stringify(reviewData, null, 2));

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const historyFile = path.join(outputDir, `review-${timestamp}.json`);
	fs.writeFileSync(historyFile, JSON.stringify(reviewData, null, 2));

	console.log(`\n=== Review data saved ===`);
	console.log(`  Latest: ${latestFile}`);
	console.log(`  History: ${historyFile}`);
	console.log(`  Changes: ${diffs.length}`);
	diffs.forEach((d) => {
		console.log(`    - ${d.group}/${d.item}/${d.code} (${d.language})`);
	});
}

const [appSlug, appVersion] = process.argv.slice(2);

if (!appSlug || !appVersion) {
	console.log('Usage: node review-changes.js <app-slug> <app-version>');
	console.log('Example: node review-changes.js google-docs 1');
	process.exit(1);
}

reviewChanges(appSlug, appVersion).catch((err) => {
	console.error('ERROR:', err.message);
	process.exit(1);
});
