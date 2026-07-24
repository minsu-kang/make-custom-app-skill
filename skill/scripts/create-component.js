#!/usr/bin/env node
/**
 * Make Custom App component creation script
 *
 * Usage:
 *   node create-component.js <app-slug> <app-version> <type> [args...]
 *
 * Types and arguments:
 *   module <name> <label> <type_id> [connection] [description]
 *     type_id: 1=trigger, 4=action, 9=search, 10=instant_trigger, 11=responder, 12=universal
 *
 *   rpc <name> <label> [connection]
 *
 *   function <name>
 *
 *   connection <label> <auth-type>
 *     auth-type: tokenAuth, oAuth, basic, digest, apiCert, apiKey, ...
 *
 *   webhook <label> <webhook-type> [connection]
 *     webhook-type: web, web-shared
 *
 *   endpoint <name> <label> [connection] [description] [initMode]
 *     initMode: example (default — clones the `model` app endpoint scaffold), blank
 *     connection is stored as attachedAccounts: [connection]
 *
 * Examples:
 *   node create-component.js monday 2 module aggregateTableV2 "Aggregate Table (beta)" 4 monday
 *   node create-component.js monday 2 rpc RpcAggregateColumns "Aggregate-compatible columns" monday
 *   node create-component.js monday 2 function buildAggregateSelect
 *   node create-component.js monday 2 connection "Monday v3" oAuth
 *   node create-component.js monday 2 webhook "Monday Events" web monday
 *   node create-component.js google-docs 1 endpoint listFiles "List Files" google-docs "Lists Drive files" blank
 *
 * API key sources (resolved by lib/settings.js):
 *   Cursor      → ~/Library/Application Support/Cursor/User/settings.json (apps-sdk.environments)
 *   Claude Code → `make-api-key:` line in SKILL.md (required)
 */

const fs = require('fs');
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
			console.error(`  ⏳ 429 Rate Limit → retrying in ${delay}ms`);
			await sleep(delay);
			return apiGetJson(url, auth, retries + 1);
		}
		if (!resp.ok) {
			const body = await resp.text();
			console.error(`  ✗ HTTP ${resp.status}: ${url}\n    ${body.slice(0, 200)}`);
			return null;
		}
		return resp.json();
	} catch (err) {
		if (retries < MAX_RETRIES) {
			const delay = BASE_DELAY_MS * Math.pow(2, retries);
			await sleep(delay);
			return apiGetJson(url, auth, retries + 1);
		}
		console.error(`  ✗ ${url}: ${err.message}`);
		return null;
	}
}

async function apiPost(url, auth, body, retries = 0) {
	try {
		const resp = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: auth,
				'Content-Type': 'application/json',
				'x-imt-apps-sdk-version': '2.4.0',
			},
			body: JSON.stringify(body),
		});
		if (resp.status === 429) {
			if (retries >= MAX_RETRIES) {
				console.error(`  ✗ 429 retry limit exceeded: ${url}`);
				return { ok: false, status: 429, message: 'Rate limit exceeded' };
			}
			const retryAfter = resp.headers.get('retry-after');
			const delay = retryAfter
				? parseInt(retryAfter, 10) * 1000
				: BASE_DELAY_MS * Math.pow(2, retries);
			console.error(`  ⏳ 429 Rate Limit → retrying in ${delay}ms`);
			await sleep(delay);
			return apiPost(url, auth, body, retries + 1);
		}
		const respBody = await resp.text();
		if (!resp.ok) {
			return { ok: false, status: resp.status, message: respBody.slice(0, 500) };
		}
		let data = null;
		try { data = JSON.parse(respBody); } catch {}
		return { ok: true, status: resp.status, message: respBody, data };
	} catch (err) {
		if (retries < MAX_RETRIES) {
			const delay = BASE_DELAY_MS * Math.pow(2, retries);
			await sleep(delay);
			return apiPost(url, auth, body, retries + 1);
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

const TYPE_LABELS = {
	1: 'Trigger',
	4: 'Action',
	9: 'Search',
	10: 'Instant Trigger',
	11: 'Responder',
	12: 'Universal',
};

function buildEndpointAndBody(baseUrl, appSlug, appVersion, type, args) {
	const appBase = `${baseUrl}/sdk/apps`;
	const verBase = `${appBase}/${appSlug}/${appVersion}`;

	switch (type) {
		case 'module': {
			const [name, label, typeId, connection, description] = args;
			if (!name || !label || !typeId) {
				console.error('Usage: create-component.js <slug> <version> module <name> <label> <type_id> [connection] [description]');
				console.error('  type_id: 1=trigger, 4=action, 9=search, 10=instant_trigger, 11=responder, 12=universal');
				process.exit(1);
			}
			const tid = parseInt(typeId, 10);
			if (!TYPE_LABELS[tid]) {
				console.error(`ERROR: Invalid type_id "${typeId}". Valid: ${Object.entries(TYPE_LABELS).map(([k, v]) => `${k}=${v}`).join(', ')}`);
				process.exit(1);
			}
			const body = {
				name,
				label,
				description: description || label,
				typeId: tid,
			};
			if (connection) body.connection = connection;
			return { url: `${verBase}/modules`, body, display: `Module "${label}" (${TYPE_LABELS[tid]})` };
		}

		case 'rpc': {
			const [name, label, connection] = args;
			if (!name || !label) {
				console.error('Usage: create-component.js <slug> <version> rpc <name> <label> [connection]');
				process.exit(1);
			}
			const body = { name, label };
			if (connection) body.connection = connection;
			return { url: `${verBase}/rpcs`, body, display: `RPC "${label}"` };
		}

		case 'function': {
			const [name] = args;
			if (!name) {
				console.error('Usage: create-component.js <slug> <version> function <name>');
				process.exit(1);
			}
			return { url: `${verBase}/functions`, body: { name }, display: `Function "${name}"` };
		}

		case 'connection': {
			const [label, authType] = args;
			if (!label || !authType) {
				console.error('Usage: create-component.js <slug> <version> connection <label> <auth-type>');
				console.error('  auth-type: tokenAuth, oAuth, basic, digest, apiCert, apiKey, ...');
				process.exit(1);
			}
			return { url: `${appBase}/${appSlug}/connections`, body: { label, type: authType }, display: `Connection "${label}" (${authType})` };
		}

		case 'webhook': {
			const [label, webhookType, connection] = args;
			if (!label || !webhookType) {
				console.error('Usage: create-component.js <slug> <version> webhook <label> <webhook-type> [connection]');
				console.error('  webhook-type: web, web-shared');
				process.exit(1);
			}
			const body = { label, type: webhookType };
			body.connection = connection || '';
			return { url: `${appBase}/${appSlug}/webhooks`, body, display: `Webhook "${label}" (${webhookType})` };
		}

		case 'endpoint': {
			const [name, label, connection, description, initMode] = args;
			if (!name || !label) {
				console.error('Usage: create-component.js <slug> <version> endpoint <name> <label> [connection] [description] [initMode]');
				console.error('  initMode: example (default — clones the model app endpoint scaffold), blank');
				process.exit(1);
			}
			if (initMode && !['example', 'blank'].includes(initMode)) {
				console.error(`ERROR: Invalid initMode "${initMode}". Valid: example, blank`);
				process.exit(1);
			}
			const body = { name, label };
			if (description) body.description = description;
			if (connection) body.attachedAccounts = [connection];
			if (initMode) body.endpointInitMode = initMode;
			return { url: `${verBase}/endpoints`, body, display: `Endpoint "${label}"` };
		}

		default:
			console.error(`ERROR: Unknown component type "${type}"`);
			console.error('Supported types: module, rpc, function, connection, webhook, endpoint');
			process.exit(1);
	}
}

async function createComponent(appSlug, appVersion, type, args) {
	let { baseUrl, auth } = loadSettings();

	console.log(`Configured API: ${baseUrl}`);
	console.log(`App: ${appSlug} v${appVersion}\n`);

	baseUrl = await resolveOrigin(baseUrl, auth, appSlug, appVersion);

	const { url, body, display } = buildEndpointAndBody(baseUrl, appSlug, appVersion, type, args);

	console.log(`  Creating: ${display}`);
	console.log(`  POST ${url}`);
	console.log(`  Body: ${JSON.stringify(body, null, 2)}\n`);

	const result = await apiPost(url, auth, body);

	if (result.ok) {
		console.log(`  ✓ Created successfully (HTTP ${result.status})`);
		if (result.data) {
			const created = result.data.appModule || result.data.appRpc || result.data.appFunction || result.data.appConnection || result.data.appWebhook || result.data.appEndpoint || result.data;
			if (created?.name) console.log(`  → Name: ${created.name}`);
			if (created?.label) console.log(`  → Label: ${created.label}`);
		}
	} else {
		console.error(`  ✗ Creation failed (HTTP ${result.status})`);
		console.error(`    ${result.message}`);
		process.exit(1);
	}
}

const [appSlug, appVersion, type, ...args] = process.argv.slice(2);

if (!appSlug || !appVersion || !type) {
	console.log('Usage: node create-component.js <app-slug> <app-version> <type> [args...]');
	console.log('');
	console.log('Types:');
	console.log('  module <name> <label> <type_id> [connection] [description]');
	console.log('    type_id: 1=trigger, 4=action, 9=search, 10=instant_trigger, 11=responder, 12=universal');
	console.log('');
	console.log('  rpc <name> <label> [connection]');
	console.log('');
	console.log('  function <name>');
	console.log('');
	console.log('  connection <label> <auth-type>');
	console.log('    auth-type: tokenAuth, oAuth, basic, digest, apiCert, apiKey, ...');
	console.log('');
	console.log('  webhook <label> <webhook-type> [connection]');
	console.log('    webhook-type: web, web-shared');
	console.log('');
	console.log('  endpoint <name> <label> [connection] [description] [initMode]');
	console.log('    initMode: example (default — clones the model app endpoint scaffold), blank');
	console.log('');
	console.log('Examples:');
	console.log('  node create-component.js monday 2 module aggregateTableV2 "Aggregate Table (beta)" 4 monday');
	console.log('  node create-component.js monday 2 rpc RpcAggregateColumns "Aggregate columns" monday');
	console.log('  node create-component.js monday 2 function buildAggregateSelect');
	console.log('  node create-component.js monday 2 connection "Monday v3" oAuth');
	console.log('  node create-component.js monday 2 webhook "Monday Events" web monday');
	console.log('  node create-component.js google-docs 1 endpoint listFiles "List Files" google-docs');
	process.exit(1);
}

require('./lib/version-guard').ensureFreshSkill();

createComponent(appSlug, appVersion, type, args).catch((err) => {
	console.error('ERROR:', err.message);
	process.exit(1);
});
