#!/usr/bin/env node
/**
 * Make Custom App component deletion script
 *
 * Deletes a component from the Make app via the SDK Admin API.
 *
 * Restrictions:
 *   - Private apps: ALL component types can be deleted
 *   - Public apps: ONLY rpc and function can be deleted
 *
 * Usage:
 *   node delete-component.js <app-slug> <app-version> <type> <name> [--force]
 *
 * Types:
 *   module, rpc, function, connection, webhook, endpoint
 *
 * Options:
 *   --force    Skip confirmation prompt
 *
 * Examples:
 *   node delete-component.js monday 2 function buildAggregateSelect
 *   node delete-component.js monday 2 rpc RpcAggregateColumns
 *   node delete-component.js monday 2 module aggregateTableV2 --force
 *   node delete-component.js monday 2 connection myConnection
 *   node delete-component.js monday 2 webhook myWebhook
 *   node delete-component.js google-docs 1 endpoint listFiles
 *
 * API key sources (resolved by lib/settings.js):
 *   Cursor      → ~/Library/Application Support/Cursor/User/settings.json (apps-sdk.environments)
 *   Claude Code → `make-api-key:` line in SKILL.md (required)
 */

const readline = require('readline');
const { loadSettings } = require('./lib/settings');

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGetJson(url, auth, retries = 0) {
	try {
		const resp = await fetch(url, {
			headers: {
				Authorization: auth,
				'x-imt-apps-sdk-version': '2.4.0',
			},
		});
		if (resp.status === 404) return null;
		if (resp.status === 429) {
			if (retries >= MAX_RETRIES) return null;
			const retryAfter = resp.headers.get('retry-after');
			const delay = retryAfter
				? parseInt(retryAfter, 10) * 1000
				: BASE_DELAY_MS * Math.pow(2, retries);
			await sleep(delay);
			return apiGetJson(url, auth, retries + 1);
		}
		if (!resp.ok) return null;
		return resp.json();
	} catch (err) {
		if (retries < MAX_RETRIES) {
			await sleep(BASE_DELAY_MS * Math.pow(2, retries));
			return apiGetJson(url, auth, retries + 1);
		}
		return null;
	}
}

async function apiDelete(url, auth, retries = 0) {
	try {
		const resp = await fetch(url, {
			method: 'DELETE',
			headers: {
				Authorization: auth,
				'Content-Type': 'application/json',
				'x-imt-apps-sdk-version': '2.4.0',
			},
		});
		if (resp.status === 429) {
			if (retries >= MAX_RETRIES) {
				return { ok: false, status: 429, message: 'Rate limit exceeded' };
			}
			const retryAfter = resp.headers.get('retry-after');
			const delay = retryAfter
				? parseInt(retryAfter, 10) * 1000
				: BASE_DELAY_MS * Math.pow(2, retries);
			console.error(`  ⏳ 429 Rate Limit → retrying in ${delay}ms`);
			await sleep(delay);
			return apiDelete(url, auth, retries + 1);
		}
		const respBody = await resp.text();
		if (!resp.ok) {
			return { ok: false, status: resp.status, message: respBody.slice(0, 500) };
		}
		return { ok: true, status: resp.status, message: respBody };
	} catch (err) {
		if (retries < MAX_RETRIES) {
			await sleep(BASE_DELAY_MS * Math.pow(2, retries));
			return apiDelete(url, auth, retries + 1);
		}
		return { ok: false, status: 0, message: err.message };
	}
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
			console.log(`  Origin detected: ${origin}`);
			console.log(`  URL changed: ${baseUrl} → ${newUrl}`);
			return newUrl;
		}
	}
	return baseUrl;
}

function buildUrl(baseUrl, appSlug, appVersion, type, name) {
	const appBase = `${baseUrl}/sdk/apps`;

	switch (type) {
		case 'module':
			return `${appBase}/${appSlug}/${appVersion}/modules/${name}`;
		case 'rpc':
			return `${appBase}/${appSlug}/${appVersion}/rpcs/${name}`;
		case 'function':
			return `${appBase}/${appSlug}/${appVersion}/functions/${name}`;
		case 'connection':
			return `${appBase}/connections/${name}`;
		case 'webhook':
			return `${appBase}/webhooks/${name}`;
		case 'endpoint':
			return `${appBase}/${appSlug}/${appVersion}/endpoints/${name}`;
		default:
			console.error(`ERROR: Unknown type "${type}". Supported: module, rpc, function, connection, webhook, endpoint`);
			process.exit(1);
	}
}

function confirm(question) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
		});
	});
}

const ALWAYS_DELETABLE = new Set(['rpc', 'function']);
const PRIVATE_ONLY_DELETABLE = new Set(['module', 'connection', 'webhook']);

async function checkAppPublicStatus(baseUrl, auth, appSlug, appVersion) {
	const url = `${baseUrl}/sdk/apps/${appSlug}/${appVersion}?cols[0]=public&cols[1]=approved`;
	const resp = await apiGetJson(url, auth);
	const app = resp?.app || resp || {};
	return { isPublic: !!app.public, isApproved: !!app.approved };
}

async function deleteComponent(appSlug, appVersion, type, name, force) {
	// 'endpoint' is not in PRIVATE_ONLY_DELETABLE — deletability on public/approved
	// apps is left to the server (no client-side pre-block).
	const validTypes = ['module', 'rpc', 'function', 'connection', 'webhook', 'endpoint'];
	if (!validTypes.includes(type)) {
		console.error(`ERROR: Unknown type "${type}". Supported: ${validTypes.join(', ')}`);
		process.exit(1);
	}

	let { baseUrl, auth } = loadSettings();

	console.log(`Configured API: ${baseUrl}`);
	console.log(`App: ${appSlug} v${appVersion}\n`);

	baseUrl = await resolveOrigin(baseUrl, auth, appSlug, appVersion);

	const { isPublic, isApproved } = await checkAppPublicStatus(baseUrl, auth, appSlug, appVersion);
	const status = isApproved ? 'approved (public)' : isPublic ? 'public' : 'private';
	console.log(`  App status: ${status}`);

	if (isPublic && PRIVATE_ONLY_DELETABLE.has(type)) {
		console.error(`\n  ✗ Cannot delete ${type} "${name}" — this app is ${status}.`);
		console.error(`    Public/approved apps only allow deleting: rpc, function`);
		process.exit(1);
	}

	const url = buildUrl(baseUrl, appSlug, appVersion, type, name);

	console.log(`  Deleting: ${type} "${name}"`);
	console.log(`  DELETE ${url}\n`);

	if (!force) {
		const confirmed = await confirm(`  Are you sure you want to delete ${type} "${name}"? (y/N) `);
		if (!confirmed) {
			console.log('\n  Cancelled.');
			process.exit(0);
		}
		console.log('');
	}

	const result = await apiDelete(url, auth);

	if (result.ok) {
		console.log(`  ✓ Deleted successfully (HTTP ${result.status})`);
	} else {
		console.error(`  ✗ Deletion failed (HTTP ${result.status})`);
		console.error(`    ${result.message}`);
		process.exit(1);
	}
}

const rawArgs = process.argv.slice(2);
const force = rawArgs.includes('--force');
const args = rawArgs.filter((a) => a !== '--force');
const [appSlug, appVersion, type, name] = args;

if (!appSlug || !appVersion || !type || !name) {
	console.log('Usage: node delete-component.js <app-slug> <app-version> <type> <name> [--force]');
	console.log('');
	console.log('Deletes a component from the Make app.');
	console.log('');
	console.log('Restrictions:');
	console.log('  Private apps → all types can be deleted');
	console.log('  Public apps  → only rpc and function can be deleted');
	console.log('');
	console.log('Types: module, rpc, function, connection, webhook, endpoint');
	console.log('');
	console.log('Options:');
	console.log('  --force    Skip confirmation prompt');
	console.log('');
	console.log('Examples:');
	console.log('  node delete-component.js monday 2 function buildAggregateSelect');
	console.log('  node delete-component.js monday 2 rpc RpcAggregateColumns');
	console.log('  node delete-component.js monday 2 module aggregateTableV2 --force');
	process.exit(1);
}

require('./lib/version-guard').ensureFreshSkill();

deleteComponent(appSlug, appVersion, type, name, force).catch((err) => {
	console.error('ERROR:', err.message);
	process.exit(1);
});
