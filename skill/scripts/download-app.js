#!/usr/bin/env node
/**
 * Make Custom App full source code download script
 *
 * Usage:
 *   node download-app.js <app-slug> <app-version> [output-dir]
 *   node download-app.js google-docs 1
 *   node download-app.js instagram 5 /tmp/instagram-v5
 *
 * Saves to ~/.claude/make-app-contexts/{slug}-v{version}/ (Claude Code)
 * or  ~/.cursor/make-app-contexts/{slug}-v{version}/ (Cursor)
 *
 * API key sources (resolved by lib/settings.js):
 *   Cursor      → ~/Library/Application Support/Cursor/User/settings.json (apps-sdk.environments)
 *   Claude Code → `make-api-key:` line in SKILL.md (required)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getEditorDir } = require('./lib/skill-root');
const { loadSettings } = require('./lib/settings');

const editorDir = getEditorDir();
const DEFAULT_CONTEXTS_DIR = path.join(os.homedir(), editorDir, 'make-app-contexts');

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
	const appLevelTasks = ['base', 'common', 'groups', 'readme', 'install', 'installSpec'].map((fileType) => async () => {
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
		`${verBase}?cols[]=name&cols[]=label&cols[]=description&cols[]=version&cols[]=origin&cols[]=versionFull&cols[]=manifestVersion&cols[]=approved&cols[]=compile&cols[]=compilationError&cols[]=theme&cols[]=public&cols[]=beta&cols[]=language&cols[]=countries&cols[]=global`,
		auth,
	);
	const appObj = appInfo?.app || appInfo || {};

	// Visibility info (private/deprecated for app + modules) lives on the
	// admin app endpoint, NOT the SDK version endpoint. This call is per-zone:
	//   GET {zone}/api/v2/admin/apps/{slug}  →  { app: { versions: [...] } }
	// Response status interpretation:
	//   200 → app IPM-deployed to this zone; versions[*] carries private/deprecated
	//   403 → admin role but no access to this endpoint
	//   404 → app compiled but NOT IPM-deployed to this zone (unusable in builder)
	console.log('\n=== Visibility (admin app endpoint) ===');
	const adminBase = baseUrl.replace(/\/sdk$/, '');
	const adminUrl = `${adminBase}/apps/${appSlug}`;
	let verRow = null;
	let ipmDeployed = null;
	try {
		const adminFetch = await fetch(adminUrl, {
			headers: { Authorization: auth, 'x-imt-apps-sdk-version': '2.4.0' },
		});
		if (adminFetch.status === 200) {
			const adminAppInfo = await adminFetch.json();
			const adminVersions = adminAppInfo?.app?.versions || [];
			verRow =
				adminVersions.find((v) => String(v.version) === String(appVersion)) ||
				adminVersions.find((v) => parseInt(v.version, 10) === parseInt(appVersion, 10)) ||
				null;
			ipmDeployed = true;
			console.log(`  ✓ IPM-deployed to ${origin || new URL(baseUrl).hostname} (${adminVersions.length} version row(s))`);
		} else if (adminFetch.status === 404) {
			ipmDeployed = false;
			console.log(`  · 404 → app not IPM-deployed to this zone (compiled but not published). Visibility flags = null.`);
		} else if (adminFetch.status === 403) {
			ipmDeployed = null;
			console.log(`  · 403 → caller lacks admin access to this endpoint. Visibility flags = null.`);
		} else {
			ipmDeployed = null;
			console.log(`  · HTTP ${adminFetch.status} on admin endpoint. Visibility flags = null.`);
		}
	} catch (err) {
		ipmDeployed = null;
		console.log(`  · admin endpoint error: ${err.message}. Visibility flags = null.`);
	}
	const moduleVisibility = new Map(
		(verRow?.modules || []).map((m) => [m.name, { private: m.private ?? null, deprecated: m.deprecated ?? null }]),
	);

	const metadata = {
		slug: appSlug,
		version: appVersion,
		origin,
		label: appObj.label || appSlug,
		description: appObj.description || '',
		manifestVersion: appObj.manifestVersion ?? 1,
		approved: appObj.approved ?? null,
		compile: appObj.compile ?? null,
		compilationError: appObj.compilationError ?? null,
		ipmDeployedToZone: ipmDeployed,
		theme: appObj.theme ?? null,
		public: appObj.public ?? null,
		private: verRow?.private ?? null,
		packagePrivate: verRow?.packagePrivate ?? null,
		deprecated: verRow?.deprecated ?? null,
		beta: appObj.beta ?? verRow?.beta ?? null,
		language: appObj.language ?? null,
		countries: appObj.countries ?? null,
		global: appObj.global ?? null,
		downloadedAt: new Date().toISOString(),
		modules: modules.map((m) => {
			const vis = moduleVisibility.get(m.name) || {};
			// `deprecated` source of truth = SDK modules endpoint (m.deprecated).
			// The admin app endpoint (versions[].modules[].deprecated) is observed
			// to return stale `false` even when the module is deprecated, which
			// previously slipped through `vis.deprecated ?? m.deprecated` because
			// `false` is not nullish. SDK endpoint stays authoritative; admin
			// endpoint remains the source for `private` (SDK endpoint does not
			// expose it).
			return {
				name: m.name,
				label: m.label,
				typeId: m.typeId,
				private: vis.private ?? null,
				deprecated: m.deprecated ?? vis.deprecated ?? null,
			};
		}),
		connections: connections.map((c) => ({
			name: c.name,
			label: c.label,
			type: c.type,
			...(c.aliasTo || c.alias_to ? { aliasTo: c.aliasTo || c.alias_to } : {}),
		})),
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

require('./lib/version-guard').ensureFreshSkill();

downloadApp(appSlug, appVersion, outputDir).catch((err) => {
	console.error('ERROR:', err.message);
	process.exit(1);
});
