#!/usr/bin/env node
/**
 * Make Custom App component update script
 *
 * Usage:
 *   node update-app.js <app-slug> <app-version> <component-path> <file-path>
 *
 * Component path format:
 *   module/<name>/<section>       - Module section (api, parameters, expect, interface, samples, scope, epoch)
 *   connection/<name>/<section>   - Connection section (api, common, scopes, scope, parameters)
 *   rpc/<name>/<section>          - RPC section (api, parameters)
 *   webhook/<name>/<section>      - Webhook section (api, parameters, attach, detach, update, scope)
 *   function/<name>/<section>     - Function file (code, test)
 *   endpoint/<name>/<section>     - SDK Endpoint section (api, input_parameters, output_parameters, scope, context)
 *                                   context PATCHes endpoint metadata (markdown); the others PUT the section
 *   base                          - App base
 *   common                        - App common data
 *   groups                        - App groups
 *
 * Examples:
 *   node update-app.js zoom 2 module/listWebinarRegistrants/api ./fix.imljson
 *   node update-app.js zoom 2 base ./base.imljson
 *   node update-app.js zoom 2 function/parseError/code ./parseError.js
 *   node update-app.js google-docs 1 endpoint/getDocument/input_parameters ./input_parameters.imljson
 *   node update-app.js google-docs 1 endpoint/getDocument/context ./context.md
 *
 * API key sources (resolved by lib/settings.js):
 *   Cursor      → ~/Library/Application Support/Cursor/User/settings.json (apps-sdk.environments)
 *   Claude Code → `make-api-key:` line in SKILL.md (required)
 */

const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./lib/settings');

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

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
			if (retries >= MAX_RETRIES) return null;
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

async function apiPut(url, auth, content, contentType = 'application/jsonc', retries = 0) {
	try {
		const resp = await fetch(url, {
			method: 'PUT',
			headers: {
				Authorization: auth,
				'Content-Type': contentType,
				'x-imt-apps-sdk-version': '2.4.0',
			},
			body: content,
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
			return apiPut(url, auth, content, contentType, retries + 1);
		}
		const body = await resp.text();
		if (!resp.ok) {
			return { ok: false, status: resp.status, message: body.slice(0, 500) };
		}
		return { ok: true, status: resp.status, message: body };
	} catch (err) {
		if (retries < MAX_RETRIES) {
			const delay = BASE_DELAY_MS * Math.pow(2, retries);
			await sleep(delay);
			return apiPut(url, auth, content, contentType, retries + 1);
		}
		return { ok: false, status: 0, message: err.message };
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
				console.error(`  ✗ 429 retry limit exceeded: ${url}`);
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
			const delay = BASE_DELAY_MS * Math.pow(2, retries);
			await sleep(delay);
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

// Endpoint section names: local files / apps.change rows use snake_case, the API
// paths use camelCase (snake_case variants 404). Accept both on the CLI.
const ENDPOINT_SECTION_API_PATH = {
	api: 'api',
	scope: 'scope',
	input_parameters: 'inputParameters',
	inputParameters: 'inputParameters',
	output_parameters: 'outputParameters',
	outputParameters: 'outputParameters',
};

function buildApiUrl(baseUrl, appSlug, appVersion, componentPath) {
	const parts = componentPath.split('/');
	const type = parts[0];
	const name = parts[1];
	const section = parts[2];

	const appBase = `${baseUrl}/sdk/apps`;
	const verBase = `${appBase}/${appSlug}/${appVersion}`;

	switch (type) {
		case 'module':
			return `${verBase}/modules/${name}/${section}`;
		case 'connection':
			return `${appBase}/connections/${name}/${section}`;
		case 'rpc':
			return `${verBase}/rpcs/${name}/${section}`;
		case 'webhook':
			return `${appBase}/webhooks/${name}/${section}`;
		case 'function':
			return `${verBase}/functions/${name}/${section}`;
		case 'endpoint': {
			// `context` has no section PUT path — handled separately via PATCH in updateComponent().
			const apiSection = ENDPOINT_SECTION_API_PATH[section];
			if (!apiSection) {
				console.error(`ERROR: Unknown endpoint section "${section}"`);
				console.error('Supported: api, input_parameters, output_parameters, scope, context');
				process.exit(1);
			}
			return `${verBase}/endpoints/${name}/${apiSection}`;
		}
		case 'base':
			return `${verBase}/base`;
		case 'common':
			return `${verBase}/common`;
		case 'groups':
			return `${verBase}/groups`;
		case 'install':
			return `${verBase}/install`;
		case 'installSpec':
			return `${verBase}/installSpec`;
		default:
			console.error(`ERROR: Unknown component type "${type}"`);
			console.error('Supported types: module, connection, rpc, webhook, function, endpoint, base, common, groups, install, installSpec');
			process.exit(1);
	}
}

async function updateComponent(appSlug, appVersion, componentPath, filePath) {
	let { baseUrl, auth } = loadSettings();

	console.log(`Configured API: ${baseUrl}`);
	console.log(`App: ${appSlug} v${appVersion}`);
	console.log(`Component: ${componentPath}`);
	console.log(`Source: ${filePath}\n`);

	baseUrl = await resolveOrigin(baseUrl, auth, appSlug, appVersion);

	const content = fs.readFileSync(filePath, 'utf-8');
	const [type, name, section] = componentPath.split('/');

	// Endpoint `context` is metadata (markdown), not a section — no PUT code path exists
	// for it (404). It is written via PATCH { context } on the endpoint entity instead.
	if (type === 'endpoint' && section === 'context') {
		const patchUrl = `${baseUrl}/sdk/apps/${appSlug}/${appVersion}/endpoints/${name}`;
		console.log(`  PATCH ${patchUrl}`);
		console.log(`  Field: context (${content.length} bytes)\n`);
		const patchResult = await apiPatch(patchUrl, auth, { context: content });
		if (patchResult.ok) {
			console.log(`  ✓ Updated successfully (HTTP ${patchResult.status})`);
		} else {
			console.error(`  ✗ Update failed (HTTP ${patchResult.status})`);
			console.error(`    ${patchResult.message}`);
			process.exit(1);
		}
		return;
	}

	const apiUrl = buildApiUrl(baseUrl, appSlug, appVersion, componentPath);
	const contentType = type === 'function' ? 'application/javascript' : type === 'common' ? 'application/json' : 'application/jsonc';

	console.log(`  PUT ${apiUrl}`);
	console.log(`  Content-Type: ${contentType}`);
	console.log(`  Content length: ${content.length} bytes\n`);

	const result = await apiPut(apiUrl, auth, content, contentType);

	if (result.ok) {
		console.log(`  ✓ Updated successfully (HTTP ${result.status})`);
	} else {
		console.error(`  ✗ Update failed (HTTP ${result.status})`);
		console.error(`    ${result.message}`);
		process.exit(1);
	}
}

const [appSlug, appVersion, componentPath, filePath] = process.argv.slice(2);

if (!appSlug || !appVersion || !componentPath || !filePath) {
	console.log('Usage: node update-app.js <app-slug> <app-version> <component-path> <file-path>');
	console.log('');
	console.log('Component path format:');
	console.log('  module/<name>/<section>       Module section (api, parameters, expect, interface, samples, scope)');
	console.log('  connection/<name>/<section>    Connection section (api, common, scopes, scope, parameters)');
	console.log('  rpc/<name>/<section>           RPC section (api, parameters)');
	console.log('  webhook/<name>/<section>       Webhook section (api, parameters, attach, detach)');
	console.log('  function/<name>/<section>      Function file (code, test)');
	console.log('  endpoint/<name>/<section>      SDK Endpoint (api, input_parameters, output_parameters, scope, context)');
	console.log('  base                           App base');
	console.log('  common                         App common data');
	console.log('  groups                         App groups');
	console.log('');
	console.log('Examples:');
	console.log('  node update-app.js zoom 2 module/listWebinarRegistrants/api ./fix.imljson');
	console.log('  node update-app.js zoom 2 base ./base.imljson');
	console.log('  node update-app.js google-docs 1 endpoint/getDocument/input_parameters ./input_parameters.imljson');
	console.log('  node update-app.js google-docs 1 endpoint/getDocument/context ./context.md');
	process.exit(1);
}

require('./lib/version-guard').ensureFreshSkill();

updateComponent(appSlug, appVersion, componentPath, filePath).catch((err) => {
	console.error('ERROR:', err.message);
	process.exit(1);
});
