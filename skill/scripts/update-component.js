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
 *   module     label, description, connection, altConnection, webhook, typeId, crud, public
 *   rpc        label, connection, altConnection
 *   connection label
 *   webhook    label, connection, altConnection
 *   endpoint   label, description, public, deprecated, archived
 *              (context is markdown — update it via update-app.js endpoint/<name>/context)
 *   function   (not supported — functions have no patchable metadata)
 *
 * The "public" field (modules, endpoints) uses a separate API endpoint (POST .../public or
 * .../private); endpoint "deprecated"/"archived" use POST .../deprecate|undeprecate /
 * .../archive|unarchive. All can be combined with other fields in a single command.
 *
 * Examples:
 *   node update-component.js monday 2 module aggregateTableV2 label="Aggregate Table"
 *   node update-component.js monday 2 module aggregateTableV2 label="New Label" description="New desc" connection=monday
 *   node update-component.js monday 2 module newModule public=true
 *   node update-component.js monday 2 module oldModule public=false
 *   node update-component.js monday 2 rpc RpcAggregateColumns label="Aggregate columns"
 *   node update-component.js monday 2 connection monday label="Monday v2 Updated"
 *   node update-component.js monday 2 webhook monday label="Monday Webhook Updated"
 *
 * API key sources (resolved by lib/settings.js):
 *   Cursor      → ~/Library/Application Support/Cursor/User/settings.json (apps-sdk.environments)
 *   Claude Code → `make-api-key:` line in SKILL.md (required)
 */

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

async function apiPost(url, auth, retries = 0) {
	try {
		const resp = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: auth,
				'Content-Type': 'application/json',
				'x-imt-apps-sdk-version': '2.4.0',
			},
			body: JSON.stringify({}),
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
			return apiPost(url, auth, retries + 1);
		}
		const respBody = await resp.text();
		if (!resp.ok) {
			return { ok: false, status: resp.status, message: respBody.slice(0, 500) };
		}
		return { ok: true, status: resp.status, message: respBody };
	} catch (err) {
		if (retries < MAX_RETRIES) {
			await sleep(BASE_DELAY_MS * Math.pow(2, retries));
			return apiPost(url, auth, retries + 1);
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
	module: ['label', 'description', 'connection', 'altConnection', 'webhook', 'typeId', 'crud', 'public'],
	rpc: ['label', 'connection', 'altConnection'],
	connection: ['label'],
	webhook: ['label', 'connection', 'altConnection'],
	endpoint: ['label', 'description', 'public', 'deprecated', 'archived'],
};

const INTEGER_FIELDS = new Set(['typeId']);
const BOOLEAN_FIELDS = new Set(['public', 'deprecated', 'archived']);

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
		} else if (BOOLEAN_FIELDS.has(key)) {
			value = value === 'true';
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
		case 'endpoint':
			return `${appBase}/${appSlug}/${appVersion}/endpoints/${name}`;
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
		console.error(`ERROR: Unknown type "${type}". Supported: module, rpc, connection, webhook, endpoint`);
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
	let hasError = false;

	// Flag flips that use dedicated POST routes instead of PATCH fields.
	const flagActions = [];
	if ('public' in body && (type === 'module' || type === 'endpoint')) {
		flagActions.push({ verb: body.public ? 'Publish' : 'Unpublish', path: body.public ? 'public' : 'private' });
		delete body.public;
	}
	if ('deprecated' in body && type === 'endpoint') {
		flagActions.push({ verb: body.deprecated ? 'Deprecate' : 'Undeprecate', path: body.deprecated ? 'deprecate' : 'undeprecate' });
		delete body.deprecated;
	}
	if ('archived' in body && type === 'endpoint') {
		flagActions.push({ verb: body.archived ? 'Archive' : 'Unarchive', path: body.archived ? 'archive' : 'unarchive' });
		delete body.archived;
	}

	for (const action of flagActions) {
		const actionUrl = `${url}/${action.path}`;

		console.log(`  ${action.verb}: ${type} "${name}"`);
		console.log(`  POST ${actionUrl}\n`);

		const result = await apiPost(actionUrl, auth);

		if (result.ok) {
			console.log(`  ✓ ${action.verb} succeeded (HTTP ${result.status})`);
		} else {
			console.error(`  ✗ ${action.verb} failed (HTTP ${result.status})`);
			console.error(`    ${result.message}`);
			hasError = true;
		}
	}

	if (Object.keys(body).length > 0) {
		console.log(`  Updating: ${type} "${name}"`);
		console.log(`  PATCH ${url}`);
		console.log(`  Fields: ${JSON.stringify(body, null, 2)}\n`);

		const result = await apiPatch(url, auth, body);

		if (result.ok) {
			console.log(`  ✓ Updated successfully (HTTP ${result.status})`);
		} else {
			console.error(`  ✗ Update failed (HTTP ${result.status})`);
			console.error(`    ${result.message}`);
			hasError = true;
		}
	}

	if (hasError) process.exit(1);
}

const [appSlug, appVersion, type, name, ...kvArgs] = process.argv.slice(2);

if (!appSlug || !appVersion || !type || !name || kvArgs.length === 0) {
	console.log('Usage: node update-component.js <app-slug> <app-version> <type> <name> <key=value> [key=value...]');
	console.log('');
	console.log('Updates component metadata (NOT file contents — use update-app.js for that).');
	console.log('');
	console.log('Types and supported fields:');
	console.log('  module     label, description, connection, altConnection, webhook, typeId, crud, public');
	console.log('  rpc        label, connection, altConnection');
	console.log('  connection label');
	console.log('  webhook    label, connection, altConnection');
	console.log('  endpoint   label, description, public, deprecated, archived (context → update-app.js)');
	console.log('  function   (not supported)');
	console.log('');
	console.log('Examples:');
	console.log('  node update-component.js monday 2 module aggregateTableV2 label="Aggregate Table"');
	console.log('  node update-component.js monday 2 module newModule public=true');
	console.log('  node update-component.js monday 2 module oldModule public=false');
	console.log('  node update-component.js monday 2 rpc RpcBoards label="List Boards" connection=monday');
	console.log('  node update-component.js monday 2 connection monday label="Monday v2 Updated"');
	console.log('  node update-component.js google-docs 1 endpoint getDocument label="Get a Document" public=true');
	console.log('  node update-component.js google-docs 1 endpoint oldEndpoint deprecated=true');
	process.exit(1);
}

require('./lib/version-guard').ensureFreshSkill();

updateComponent(appSlug, appVersion, type, name, kvArgs).catch((err) => {
	console.error('ERROR:', err.message);
	process.exit(1);
});
