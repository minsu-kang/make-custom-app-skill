#!/usr/bin/env node
/**
 * Make Custom App component metadata update script
 *
 * Updates component metadata (label, description, connection, etc.) via PATCH.
 * For updating file contents (api.imljson, code.js, etc.), use update-app.js instead.
 *
 * Usage:
 *   node update-component.js <app-slug> <app-version> <type> <name> <key=value> [key=value...]
 *
 * Types and supported fields:
 *   module     label, description, connection, altConnection, webhook, typeId, crud
 *   rpc        label, connection, altConnection
 *   connection label
 *   webhook    label, connection, altConnection
 *   function   (not supported — functions have no patchable metadata)
 *
 * Examples:
 *   node update-component.js monday 2 module aggregateTableV2 label="Aggregate Table"
 *   node update-component.js monday 2 module aggregateTableV2 label="New Label" description="New desc" connection=monday
 *   node update-component.js monday 2 rpc RpcAggregateColumns label="Aggregate columns"
 *   node update-component.js monday 2 connection monday label="Monday v2 Updated"
 *   node update-component.js monday 2 webhook monday label="Monday Webhook Updated"
 *
 * Reads API key and environment from Cursor settings (same as download-app.js)
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

async function apiPatch(url, auth, body, retries = 0) {
	try {
		const resp = await fetch(url, {
			method: 'PATCH',
			headers: {
				Authorization: auth,
				'Content-Type': 'application/json',
				'x-imt-apps-sdk-version': '2.4.0',
			},
			body: JSON.stringify(body),
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
			return apiPatch(url, auth, body, retries + 1);
		}
		const respBody = await resp.text();
		if (!resp.ok) {
			return { ok: false, status: resp.status, message: respBody.slice(0, 500) };
		}
		return { ok: true, status: resp.status, message: respBody };
	} catch (err) {
		if (retries < MAX_RETRIES) {
			await sleep(BASE_DELAY_MS * Math.pow(2, retries));
			return apiPatch(url, auth, body, retries + 1);
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

const ALLOWED_FIELDS = {
	module: ['label', 'description', 'connection', 'altConnection', 'webhook', 'typeId', 'crud'],
	rpc: ['label', 'connection', 'altConnection'],
	connection: ['label'],
	webhook: ['label', 'connection', 'altConnection'],
};

const INTEGER_FIELDS = new Set(['typeId']);

function parseKeyValues(args) {
	const result = {};
	for (const arg of args) {
		const eqIdx = arg.indexOf('=');
		if (eqIdx === -1) {
			console.error(`ERROR: Invalid key=value format: "${arg}"`);
			process.exit(1);
		}
		const key = arg.slice(0, eqIdx);
		let value = arg.slice(eqIdx + 1);
		if (INTEGER_FIELDS.has(key)) {
			value = parseInt(value, 10);
		}
		result[key] = value;
	}
	return result;
}

function buildUrl(baseUrl, appSlug, appVersion, type, name) {
	const appBase = `${baseUrl}/sdk/apps`;

	switch (type) {
		case 'module':
			return `${appBase}/${appSlug}/${appVersion}/modules/${name}`;
		case 'rpc':
			return `${appBase}/${appSlug}/${appVersion}/rpcs/${name}`;
		case 'connection':
			return `${appBase}/connections/${name}`;
		case 'webhook':
			return `${appBase}/webhooks/${name}`;
		default:
			console.error(`ERROR: Unsupported type "${type}" for update.`);
			process.exit(1);
	}
}

async function updateComponent(appSlug, appVersion, type, name, kvArgs) {
	if (type === 'function') {
		console.error('ERROR: Functions have no patchable metadata. Use update-app.js to update code/test content.');
		process.exit(1);
	}

	const allowed = ALLOWED_FIELDS[type];
	if (!allowed) {
		console.error(`ERROR: Unknown type "${type}". Supported: module, rpc, connection, webhook`);
		process.exit(1);
	}

	const body = parseKeyValues(kvArgs);
	const invalidKeys = Object.keys(body).filter((k) => !allowed.includes(k));
	if (invalidKeys.length > 0) {
		console.error(`ERROR: Invalid field(s) for ${type}: ${invalidKeys.join(', ')}`);
		console.error(`  Allowed fields: ${allowed.join(', ')}`);
		process.exit(1);
	}

	if (Object.keys(body).length === 0) {
		console.error('ERROR: No fields to update. Provide at least one key=value pair.');
		process.exit(1);
	}

	let { baseUrl, auth } = loadSettings();

	console.log(`Configured API: ${baseUrl}`);
	console.log(`App: ${appSlug} v${appVersion}\n`);

	baseUrl = await resolveOrigin(baseUrl, auth, appSlug, appVersion);

	const url = buildUrl(baseUrl, appSlug, appVersion, type, name);

	console.log(`  Updating: ${type} "${name}"`);
	console.log(`  PATCH ${url}`);
	console.log(`  Fields: ${JSON.stringify(body, null, 2)}\n`);

	const result = await apiPatch(url, auth, body);

	if (result.ok) {
		console.log(`  ✓ Updated successfully (HTTP ${result.status})`);
	} else {
		console.error(`  ✗ Update failed (HTTP ${result.status})`);
		console.error(`    ${result.message}`);
		process.exit(1);
	}
}

const [appSlug, appVersion, type, name, ...kvArgs] = process.argv.slice(2);

if (!appSlug || !appVersion || !type || !name || kvArgs.length === 0) {
	console.log('Usage: node update-component.js <app-slug> <app-version> <type> <name> <key=value> [key=value...]');
	console.log('');
	console.log('Updates component metadata (NOT file contents — use update-app.js for that).');
	console.log('');
	console.log('Types and supported fields:');
	console.log('  module     label, description, connection, altConnection, webhook, typeId, crud');
	console.log('  rpc        label, connection, altConnection');
	console.log('  connection label');
	console.log('  webhook    label, connection, altConnection');
	console.log('  function   (not supported)');
	console.log('');
	console.log('Examples:');
	console.log('  node update-component.js monday 2 module aggregateTableV2 label="Aggregate Table"');
	console.log('  node update-component.js monday 2 rpc RpcBoards label="List Boards" connection=monday');
	console.log('  node update-component.js monday 2 connection monday label="Monday v2 Updated"');
	process.exit(1);
}

updateComponent(appSlug, appVersion, type, name, kvArgs).catch((err) => {
	console.error('ERROR:', err.message);
	process.exit(1);
});
