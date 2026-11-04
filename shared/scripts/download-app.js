#!/usr/bin/env node
/**
 * Make Custom App full source code download script
 *
 * Usage:
 *   node download-app.js <app-slug> <app-version> [output-dir]
 *   node download-app.js google-docs 1
 *   node download-app.js instagram 5 /tmp/instagram-v5
 *
 * Saves to ~/.make-custom-app/contexts/{slug}-v{version}/ (the same folder for every editor)
 *
 * API key sources (resolved by lib/settings.js):
 *   Cursor      → ~/Library/Application Support/Cursor/User/settings.json (apps-sdk.environments)
 *   Claude Code → `make-api-key:` line in ~/.make-custom-app-skill-secrets (required)
 *
 * Every section is saved, absent (a 404 or an empty body) or failed (lib/download-app-logic.js); a 404 on the app
 * version or on a component list fails. Files are written only when nothing failed; otherwise the Done block lists the
 * failed sections, nothing is written, and the exit code is 1. In public mode (lib/mode.js) the script reads the public
 * API, skips the admin visibility call, and fails on an app of another zone instead of switching hosts.
 */

const fs = require('fs');
const path = require('path');
const { getContextsDir } = require('./lib/paths');
const { baseFor, errorCode, testOrigin, TEST_ORIGIN_VAR } = require('./lib/mode-logic');
const logic = require('./lib/download-app-logic');
require('./lib/settings').takeEditorFlagOrExit(process.argv);

const DEFAULT_CONTEXTS_DIR = getContextsDir();
const TEST_API_ORIGIN = testOrigin(process.env[TEST_ORIGIN_VAR]);

let concurrency = 10;
// Against the loopback test origin of mode-logic.js the retries do not wait.
const BASE_DELAY_MS = TEST_API_ORIGIN ? 0 : 1000;

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
// SDK Endpoints (Endpoints RFC, compiled as IMTRPC).
// API code paths are camelCase; apps.change rows use snake_case codes
// (input_parameters / output_parameters) — local filenames follow the
// change codes so review diffs map 1:1 to files.
const ENDPOINT_FILES = [
	{ apiPath: 'api', file: 'api.imljson' },
	{ apiPath: 'inputParameters', file: 'input_parameters.imljson' },
	{ apiPath: 'outputParameters', file: 'output_parameters.imljson' },
	{ apiPath: 'scope', file: 'scope.imljson' },
];

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One GET: { status, body, error }. body is the response text; after a network failure status and body are null and
 * error is a short code (err.message is never printed: for a bad header value it holds the Authorization value).
 * With retry, a 429 and a network error are retried up to MAX_RETRIES times.
 */
async function apiGet(url, auth, { retry = true } = {}) {
	for (let retries = 0; ; retries++) {
		const canRetry = retry && retries < logic.MAX_RETRIES;
		try {
			const resp = await fetch(url, {
				headers: {
					Authorization: auth,
					'x-imt-apps-sdk-version': '2.4.0',
				},
			});
			if (resp.status === 429 && canRetry) {
				concurrency = Math.max(2, Math.floor(concurrency / 2));
				const retryAfter = resp.headers.get('retry-after');
				const delay = retryAfter
					? parseInt(retryAfter, 10) * 1000
					: BASE_DELAY_MS * Math.pow(2, retries);
				console.error(`  ⏳ 429 Rate Limit → retrying in ${delay}ms (concurrency: ${concurrency})`);
				await sleep(delay);
				continue;
			}
			return { status: resp.status, body: await resp.text(), error: null };
		} catch (err) {
			if (canRetry) {
				await sleep(BASE_DELAY_MS * Math.pow(2, retries));
				continue;
			}
			return { status: null, body: null, error: errorCode(err) };
		}
	}
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

async function downloadApp(settings, appSlug, appVersion, customOutputDir) {
	let { baseUrl, host } = settings;
	const { auth, mode } = settings;
	const stats = { saved: 0, absent: 0 };
	const failed = [];
	const files = [];
	const outputDir = customOutputDir || path.join(DEFAULT_CONTEXTS_DIR, `${appSlug}-v${appVersion}`);

	const fail = (failure) => {
		failed.push(failure);
		console.error(`  ✗ ${failure.what} (${failure.reason})`);
	};
	const finish = () => {
		for (const line of logic.doneLines({ ...stats, failed, outputDir, mode })) console.log(line);
		if (failed.length) {
			console.error(logic.failedErrorLine(failed.length, appSlug, appVersion));
			process.exitCode = 1;
		}
	};
	const keep = (relPath, result) => {
		const outcome = logic.classifySection(result);
		if (outcome === 'saved') {
			files.push([relPath, result.body]);
			stats.saved++;
		} else if (outcome === 'absent') {
			stats.absent++;
		} else {
			fail({ what: relPath, reason: logic.failureReason(result) });
		}
	};
	const list = async (what, noun, url, key) => {
		const r = logic.readList(await apiGet(url, auth), key);
		if (r.reason) {
			fail({ what, reason: r.reason });
			return [];
		}
		console.log(`  ${r.items.length} ${noun} found`);
		return r.items;
	};

	console.log(`Configured API: ${baseUrl}`);
	console.log(`App: ${appSlug} v${appVersion}\n`);

	const gate = logic.readJson(await apiGet(`${baseUrl}/sdk/apps/${appSlug}/${appVersion}?cols[0]=origin`, auth));
	if (gate.reason) {
		fail(logic.gateFailure(gate.reason, { slug: appSlug, version: appVersion, host }));
		return finish();
	}
	const origin = gate.body.app?.origin || gate.body.origin;
	const plan = logic.planOrigin(mode, host, origin);
	if (plan.action === 'fail') {
		fail(plan.failure);
		return finish();
	}
	if (plan.action === 'switch') {
		const newUrl = baseFor(mode, plan.host, TEST_API_ORIGIN);
		console.log(`  Origin detected: ${origin}`);
		console.log(`  URL changed: ${baseUrl} → ${newUrl}`);
		baseUrl = newUrl;
		host = plan.host;
	}

	console.log(`Actual API: ${baseUrl}`);
	console.log(`Output: ${outputDir}\n`);

	const appBase = `${baseUrl}/sdk/apps`;
	const verBase = `${appBase}/${appSlug}/${appVersion}`;

	// --- App-level files ---
	console.log('=== App-level files ===');
	const appLevelTasks = ['base', 'common', 'groups', 'readme', 'install', 'installSpec'].map((fileType) => async () => {
		const ext = fileType === 'readme' ? 'md' : 'imljson';
		keep(`${fileType}.${ext}`, await apiGet(`${verBase}/${fileType}`, auth));
	});
	await runBatch(appLevelTasks);

	// --- Modules ---
	console.log('\n=== Modules ===');
	const modules = await list(
		'module list',
		'module(s)',
		`${verBase}/modules?cols[]=name&cols[]=label&cols[]=typeId&cols[]=crud&cols[]=deprecated&cols[]=public`,
		'appModules',
	);

	const moduleTasks = modules.flatMap((mod) => {
		const sections = MODULE_FILES[mod.typeId] || MODULE_FILES[4];
		return sections.map((ft) => async () => {
			keep(`modules/${mod.name}/${ft}.imljson`, await apiGet(`${verBase}/modules/${mod.name}/${ft}`, auth));
		});
	});
	await runBatch(moduleTasks);

	// --- Connections ---
	console.log('\n=== Connections ===');
	const connections = await list('connection list', 'connection(s)', `${appBase}/${appSlug}/connections`, 'appConnections');

	const connTasks = connections.flatMap((conn) =>
		CONNECTION_FILES.map((ft) => async () => {
			keep(`connections/${conn.name}/${ft}.imljson`, await apiGet(`${appBase}/connections/${conn.name}/${ft}`, auth));
		}),
	);
	await runBatch(connTasks);

	// --- Webhooks ---
	console.log('\n=== Webhooks ===');
	const webhooks = await list('webhook list', 'webhook(s)', `${appBase}/${appSlug}/webhooks`, 'appWebhooks');

	const whTasks = webhooks.flatMap((wh) =>
		WEBHOOK_FILES.map((ft) => async () => {
			keep(`webhooks/${wh.name}/${ft}.imljson`, await apiGet(`${appBase}/webhooks/${wh.name}/${ft}`, auth));
		}),
	);
	await runBatch(whTasks);

	// --- RPCs ---
	console.log('\n=== RPCs ===');
	const rpcs = await list('RPC list', 'RPC(s)', `${verBase}/rpcs`, 'appRpcs');

	const rpcTasks = rpcs.flatMap((rpc) =>
		RPC_FILES.map((ft) => async () => {
			keep(`rpcs/${rpc.name}/${ft}.imljson`, await apiGet(`${verBase}/rpcs/${rpc.name}/${ft}`, auth));
		}),
	);
	await runBatch(rpcTasks);

	// --- Endpoints (SDK Endpoints, IMTRPC) ---
	console.log('\n=== Endpoints ===');
	const endpoints = await list('endpoint list', 'endpoint(s)', `${verBase}/endpoints`, 'appEndpoints');

	const endpointDetails = new Map();
	const epTasks = endpoints.flatMap((ep) => {
		const codeTasks = ENDPOINT_FILES.map(({ apiPath, file }) => async () => {
			keep(`endpoints/${ep.name}/${file}`, await apiGet(`${verBase}/endpoints/${ep.name}/${apiPath}`, auth));
		});
		// context (markdown with frontmatter) + annotations only exist on the
		// endpoint detail JSON — there is no /context code path (404).
		const detailTask = async () => {
			const detail = logic.readDetail(await apiGet(`${verBase}/endpoints/${ep.name}`, auth));
			if (detail.reason) return fail({ what: `endpoints/${ep.name} (detail)`, reason: detail.reason });
			const epObj = detail.body?.appEndpoint || {};
			endpointDetails.set(ep.name, epObj);
			keep(`endpoints/${ep.name}/context.md`, { status: 200, body: typeof epObj.context === 'string' ? epObj.context : null, error: null });
		};
		return [...codeTasks, detailTask];
	});
	await runBatch(epTasks);

	// --- Functions ---
	console.log('\n=== Functions ===');
	const functions = await list('function list', 'function(s)', `${verBase}/functions`, 'appFunctions');

	const funcTasks = functions.flatMap((func) =>
		FUNCTION_FILES.map((ft) => async () => {
			keep(`functions/${func.name}/${ft}.js`, await apiGet(`${verBase}/functions/${func.name}/${ft}`, auth));
		}),
	);
	await runBatch(funcTasks);

	// --- Metadata ---
	const appInfo = logic.readJson(
		await apiGet(
			`${verBase}?cols[]=name&cols[]=label&cols[]=description&cols[]=version&cols[]=origin&cols[]=versionFull&cols[]=manifestVersion&cols[]=approved&cols[]=compile&cols[]=compilationError&cols[]=theme&cols[]=public&cols[]=beta&cols[]=language&cols[]=countries&cols[]=global`,
			auth,
		),
	);
	if (appInfo.reason) fail({ what: 'app metadata', reason: appInfo.reason });
	if (failed.length) return finish();
	const appObj = appInfo.body.app || appInfo.body;

	// Visibility info (private/deprecated for app + modules) lives on the
	// admin app endpoint, NOT the SDK version endpoint. This call is per-zone:
	//   GET {zone}/api/v2/admin/apps/{slug}  →  { app: { versions: [...] } }
	// Response status interpretation:
	//   200 → app IPM-deployed to this zone; versions[*] carries private/deprecated
	//   403 → admin role but no access to this endpoint
	//   404 → app compiled but NOT IPM-deployed to this zone (unusable in builder)
	// Public mode has no admin API, so the call is not made. Only a run without failures gets here: the
	// answer is used only for metadata.json.
	console.log('\n=== Visibility (admin app endpoint) ===');
	const adminResult = mode === 'public' ? null : await apiGet(`${baseUrl}/apps/${appSlug}`, auth, { retry: false });
	const visibility = logic.visibilityOutcome(adminResult, appVersion, origin || host);
	console.log(visibility.line);
	const { verRow, ipmDeployed } = visibility;
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
		...(mode === 'public' ? { visibility: 'unknown (public mode)' } : {}),
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
			// `deprecated` and `public` come from the SDK modules endpoint.
			// The admin app endpoint (versions[].modules[].deprecated) is observed
			// to return stale `false` even when the module is deprecated, which
			// previously slipped through `vis.deprecated ?? m.deprecated` because
			// `false` is not nullish. SDK stays authoritative for those two.
			// `private` exists only on the admin app endpoint. `null` means the
			// module is absent from the deployed list, not that it is public.
			return {
				name: m.name,
				label: m.label,
				typeId: m.typeId,
				public: m.public ?? null,
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
		endpoints: endpoints.map((e) => {
			const d = endpointDetails.get(e.name) || {};
			return {
				name: e.name,
				label: e.label ?? d.label ?? null,
				description: e.description ?? d.description ?? null,
				annotations: d.annotations ?? null,
				attachedAccounts: d.attachedAccounts ?? null,
				public: d.public ?? null,
				approved: d.approved ?? null,
				deprecated: d.deprecated ?? null,
				archived: d.archived ?? null,
			};
		}),
	};

	console.log('\n=== Files ===');
	for (const [relPath, content] of files) {
		const filepath = path.join(outputDir, relPath);
		fs.mkdirSync(path.dirname(filepath), { recursive: true });
		fs.writeFileSync(filepath, content, 'utf-8');
		console.log(`  ✓ ${relPath}`);
	}
	fs.mkdirSync(outputDir, { recursive: true });
	fs.writeFileSync(path.join(outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
	console.log('  ✓ metadata.json');

	finish();
}

const [appSlug, appVersion, outputDir] = process.argv.slice(2);

if (!appSlug || !appVersion) {
	console.log('Usage: node download-app.js <app-slug> <app-version> [output-dir]');
	console.log('Example: node download-app.js google-docs 1');
	console.log('        node download-app.js instagram 5 /tmp/instagram-v5');
	process.exit(1);
}

const settings = require('./lib/mode').requireMode();

downloadApp(settings, appSlug, appVersion, outputDir).catch((err) => {
	console.error('ERROR:', err.message);
	process.exit(1);
});
