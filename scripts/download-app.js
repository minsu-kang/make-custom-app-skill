#!/usr/bin/env node
/**
 * Make Custom App full source code download script
 *
 * Usage:
 *   node download-app.js <app-slug> <app-version> [output-dir]
 *   node download-app.js google-docs 1
 *   node download-app.js instagram 5 /tmp/instagram-v5
 *
 * Saves to ~/.cursor/make-app-contexts/{slug}-v{version}/
 * Automatically reads API key and environment from Cursor settings
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

let concurrency = 10;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

const MODULE_FILES = {
	1: ['api', 'epoch', 'parameters', 'interface', 'samples', 'scope'],       // Trigger
	4: ['api', 'parameters', 'expect', 'interface', 'samples', 'scope'],      // Action
	9: ['api', 'parameters', 'expect', 'interface', 'samples', 'scope'],      // Search
	10: ['api', 'parameters', 'interface', 'samples'],                         // Instant Trigger
	11: ['api', 'parameters', 'expect'],                                       // Responder
	12: ['api', 'parameters', 'expect', 'interface', 'samples', 'scope'],     // Universal
};

const CONNECTION_FILES = ['api', 'common', 'scopes', 'scope', 'parameters', 'installSpec', 'install'];
const WEBHOOK_FILES = ['api', 'parameters', 'attach', 'detach', 'update', 'scope'];
const RPC_FILES = ['api', 'parameters'];
const FUNCTION_FILES = ['code', 'test'];

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
				console.error(`  ✗ 429 retry limit exceeded: ${url}`);
				return null;
			}
			concurrency = Math.max(2, Math.floor(concurrency / 2));
			const retryAfter = resp.headers.get('retry-after');
			const delay = retryAfter
				? parseInt(retryAfter, 10) * 1000
				: BASE_DELAY_MS * Math.pow(2, retries);
			console.error(`  ⏳ 429 Rate Limit → retrying in ${delay}ms (concurrency: ${concurrency})`);
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

async function apiGetText(url, auth) {
	const resp = await apiGet(url, auth);
	if (!resp) return null;
	const text = await resp.text();
	if (text === 'null' || !text.trim()) return null;
	return text;
}

function saveFile(outputDir, relPath, content) {
	if (content == null) return false;
	const filepath = path.join(outputDir, relPath);
	fs.mkdirSync(path.dirname(filepath), { recursive: true });
	fs.writeFileSync(filepath, content, 'utf-8');
	return true;
}

async function runBatch(tasks) {
	const results = [];
	let i = 0;
	while (i < tasks.length) {
		const batch = tasks.slice(i, i + concurrency);
		const batchResults = await Promise.all(batch.map((fn) => fn()));
		results.push(...batchResults);
		i += batch.length;
	}
	return results;
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
			return { baseUrl: newUrl, origin };
		}
	}
	return { baseUrl, origin };
}

async function downloadApp(appSlug, appVersion, customOutputDir) {
	let { baseUrl, auth } = loadSettings();
	const stats = { saved: 0, skipped: 0 };

	console.log(`Configured API: ${baseUrl}`);
	console.log(`App: ${appSlug} v${appVersion}\n`);

	const resolved = await resolveOrigin(baseUrl, auth, appSlug, appVersion);
	baseUrl = resolved.baseUrl;
	const origin = resolved.origin;

	const outputDir = customOutputDir || path.join(DEFAULT_CONTEXTS_DIR, `${appSlug}-v${appVersion}`);
	fs.mkdirSync(outputDir, { recursive: true });

	console.log(`Actual API: ${baseUrl}`);
	console.log(`Output: ${outputDir}\n`);

	const appBase = `${baseUrl}/sdk/apps`;
	const verBase = `${appBase}/${appSlug}/${appVersion}`;

	// --- App-level files ---
	console.log('=== App-level files ===');
	const appLevelTasks = ['base', 'common', 'groups', 'readme'].map((fileType) => async () => {
		const ext = fileType === 'readme' ? 'md' : 'imljson';
		const content = await apiGetText(`${verBase}/${fileType}`, auth);
		if (saveFile(outputDir, `${fileType}.${ext}`, content)) {
			console.log(`  ✓ ${fileType}.${ext}`);
			stats.saved++;
		} else {
			stats.skipped++;
		}
	});
	await runBatch(appLevelTasks);

	// --- Modules ---
	console.log('\n=== Modules ===');
	const modResp = await apiGetJson(
		`${verBase}/modules?cols[]=name&cols[]=label&cols[]=typeId&cols[]=crud&cols[]=deprecated`,
		auth,
	);
	const modules = modResp?.appModules || [];
	console.log(`  ${modules.length} module(s) found`);

	const moduleTasks = modules.flatMap((mod) => {
		const files = MODULE_FILES[mod.typeId] || MODULE_FILES[4];
		return files.map((ft) => async () => {
			const content = await apiGetText(`${verBase}/modules/${mod.name}/${ft}`, auth);
			if (saveFile(outputDir, `modules/${mod.name}/${ft}.imljson`, content)) {
				console.log(`  ✓ modules/${mod.name}/${ft}.imljson`);
				stats.saved++;
			} else {
				stats.skipped++;
			}
		});
	});
	await runBatch(moduleTasks);

	// --- Connections ---
	console.log('\n=== Connections ===');
	const connResp = await apiGetJson(`${appBase}/${appSlug}/connections`, auth);
	const connections = connResp?.appConnections || [];
	console.log(`  ${connections.length} connection(s) found`);

	const connTasks = connections.flatMap((conn) =>
		CONNECTION_FILES.map((ft) => async () => {
			const content = await apiGetText(`${appBase}/connections/${conn.name}/${ft}`, auth);
			if (saveFile(outputDir, `connections/${conn.name}/${ft}.imljson`, content)) {
				console.log(`  ✓ connections/${conn.name}/${ft}.imljson`);
				stats.saved++;
			} else {
				stats.skipped++;
			}
		}),
	);
	await runBatch(connTasks);

	// --- Webhooks ---
	console.log('\n=== Webhooks ===');
	const whResp = await apiGetJson(`${appBase}/${appSlug}/webhooks`, auth);
	const webhooks = whResp?.appWebhooks || [];
	console.log(`  ${webhooks.length} webhook(s) found`);

	const whTasks = webhooks.flatMap((wh) =>
		WEBHOOK_FILES.map((ft) => async () => {
			const content = await apiGetText(`${appBase}/webhooks/${wh.name}/${ft}`, auth);
			if (saveFile(outputDir, `webhooks/${wh.name}/${ft}.imljson`, content)) {
				console.log(`  ✓ webhooks/${wh.name}/${ft}.imljson`);
				stats.saved++;
			} else {
				stats.skipped++;
			}
		}),
	);
	await runBatch(whTasks);

	// --- RPCs ---
	console.log('\n=== RPCs ===');
	const rpcResp = await apiGetJson(`${verBase}/rpcs`, auth);
	const rpcs = rpcResp?.appRpcs || [];
	console.log(`  ${rpcs.length} RPC(s) found`);

	const rpcTasks = rpcs.flatMap((rpc) =>
		RPC_FILES.map((ft) => async () => {
			const content = await apiGetText(`${verBase}/rpcs/${rpc.name}/${ft}`, auth);
			if (saveFile(outputDir, `rpcs/${rpc.name}/${ft}.imljson`, content)) {
				console.log(`  ✓ rpcs/${rpc.name}/${ft}.imljson`);
				stats.saved++;
			} else {
				stats.skipped++;
			}
		}),
	);
	await runBatch(rpcTasks);

	// --- Functions ---
	console.log('\n=== Functions ===');
	const funcResp = await apiGetJson(`${verBase}/functions`, auth);
	const functions = funcResp?.appFunctions || [];
	console.log(`  ${functions.length} function(s) found`);

	const funcTasks = functions.flatMap((func) =>
		FUNCTION_FILES.map((ft) => async () => {
			const content = await apiGetText(`${verBase}/functions/${func.name}/${ft}`, auth);
			if (content && saveFile(outputDir, `functions/${func.name}/${ft}.js`, content)) {
				console.log(`  ✓ functions/${func.name}/${ft}.js`);
				stats.saved++;
			} else {
				stats.skipped++;
			}
		}),
	);
	await runBatch(funcTasks);

	// --- Metadata ---
	const appInfo = await apiGetJson(
		`${verBase}?cols[]=name&cols[]=label&cols[]=description&cols[]=version&cols[]=origin&cols[]=versionFull`,
		auth,
	);
	const appObj = appInfo?.app || appInfo || {};

	const metadata = {
		slug: appSlug,
		version: appVersion,
		origin,
		label: appObj.label || appSlug,
		description: appObj.description || '',
		downloadedAt: new Date().toISOString(),
		modules: modules.map((m) => ({ name: m.name, label: m.label, typeId: m.typeId })),
		connections: connections.map((c) => ({ name: c.name, label: c.label })),
		webhooks: webhooks.map((w) => ({ name: w.name, label: w.label })),
		rpcs: rpcs.map((r) => ({ name: r.name, label: r.label })),
		functions: functions.map((f) => ({ name: f.name })),
	};
	saveFile(outputDir, 'metadata.json', JSON.stringify(metadata, null, 2));
	console.log('\n  ✓ metadata.json');

	console.log(`\n=== Done ===`);
	console.log(`  Saved: ${stats.saved} file(s)`);
	console.log(`  Skipped: ${stats.skipped} (empty)`);
	console.log(`  Path: ${outputDir}`);
}

const [appSlug, appVersion, outputDir] = process.argv.slice(2);

if (!appSlug || !appVersion) {
	console.log('Usage: node download-app.js <app-slug> <app-version> [output-dir]');
	console.log('Example: node download-app.js google-docs 1');
	console.log('        node download-app.js instagram 5 /tmp/instagram-v5');
	process.exit(1);
}

downloadApp(appSlug, appVersion, outputDir).catch((err) => {
	console.error('ERROR:', err.message);
	process.exit(1);
});
