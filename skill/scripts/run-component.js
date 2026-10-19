#!/usr/bin/env node
/**
 * run-component.js: entry script. Runs ONE SDK Endpoint or RPC of a custom app live through Make's public API.
 * Modules are out of scope. The script never sees third-party tokens: a Make connection is referenced by ID.
 *
 * Role of the two run-component files
 *   scripts/run-component.js            this file: all the I/O. It reads the --input file, calls Make's API with fetch,
 *                                       writes `make-team-id` to the secrets file, prints, and sets the exit code.
 *   scripts/lib/run-component-logic.js  all the decisions as pure functions: argument parsing, which connection to use,
 *                                       how to classify a response, what to print. No network, no files, no process.exit.
 * Tests: lib/__tests__/run-component-logic.test.js covers the logic without a server;
 *        lib/__tests__/run-component.test.js runs this script against a mock API server in a fake HOME.
 *
 * Usage:
 *   node run-component.js <app-slug> <app-version> endpoint|rpc <name> [--team=<id>] [--connection=<id>] [--input=<file.json>] [--dry-run] [--save-team]
 *
 * One command runs the component once. The connection is picked by the script and is always one the user created
 * (`authorId` equals `GET /users/me`); nobody else's connection is used. Without a connection of the right type the script
 * stops with a link to create one. `--dry-run` runs the preflight, prints the summary and sends no execution or
 * credential request; `--save-team` still stores the team.
 * The team comes from --team or the optional `make-team-id:` line in ~/.make-custom-app-skill-secrets; without either the
 * script lists the user's teams, and `--team=<id> --save-team` stores the chosen one as `make-team-id`.
 *
 * Endpoints run through POST /endpoints/v1/execute (key scope endpoints:run). Without that scope, or when v1 provably
 * did not execute the request, the legacy POST /rpcs/...?kind=endpoint route is used once instead.
 *
 * Exit codes: 0 ok · 1 usage, input, or rejected before running
 *             4 human action needed (first stderr line `ACTION: <KIND>`) · 5 result unknown, a component that may write is not rerun without the user
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const rc = require('./lib/run-component-logic');
const { getSkillRoot, getEditorDir } = require('./lib/skill-root');
const { loadSettings, readSkillConfig, SECRETS_PATH, CURSOR_SETTINGS_PATH } = require('./lib/settings');
const { upsertSecretsFile } = require('./lib/secrets-file');

const PREFLIGHT_TIMEOUT_MS = 30000;
const EXEC_TIMEOUT_MS = 330000;
const PREFLIGHT_RETRIES = 2;
const DISCOVERY_CONCURRENCY = 4;
const OUTPUT_LIMIT = 50 * 1024;
const USAGE = 'Usage: run-component.js <app-slug> <app-version> endpoint|rpc <name> [--team=<id>] [--connection=<id>] [--input=<file.json>] [--dry-run] [--save-team]';

/** Thrown to end the run with an exit code; stdout/stderr text is printed by the catcher. */
class Stop extends Error {
	constructor(code, stderr) {
		super(stderr || '');
		this.code = code;
		this.stderrText = stderr || '';
	}
}

let posted = false;

function stopAction(action, lines) {
	throw new Stop(rc.EXIT.ACTION, rc.renderAction(action, lines));
}

function fieldLines(fields) {
	if (fields.unparsed) return [`(response body is not a JSON object, ${fields.length} characters)`];
	const lines = [];
	if (fields.code) lines.push(`code: ${fields.code}`);
	if (fields.message) lines.push(`message: ${fields.message}`);
	if (fields.detail) lines.push(`detail: ${fields.detail}`);
	for (const s of fields.suberrors || []) lines.push(`suberror: ${s}`);
	return lines;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function http(req, { retries, timeoutMs, auth }) {
	const headers = { Authorization: auth };
	if (req.body !== undefined) headers['Content-Type'] = 'application/json';
	for (let attempt = 0; ; attempt++) {
		try {
			const resp = await fetch(req.url, {
				method: req.method,
				headers,
				body: req.body === undefined ? undefined : JSON.stringify(req.body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (resp.status === 429 && attempt < retries) {
				const wait = Math.min(parseInt(resp.headers.get('retry-after') || '1', 10) * 1000 || 1000, 10000);
				await sleep(wait);
				continue;
			}
			return { status: resp.status, text: await resp.text(), multiple: resp.headers.get('x-imt-multiple-results') === 'yes' };
		} catch (err) {
			// A TypeError means the request could not be built (for example a bad header value); retrying cannot help.
			if (attempt < retries && !(err instanceof TypeError)) {
				await sleep(1000 * 2 ** attempt);
				continue;
			}
			// err.message is never printed: for a bad header value it holds the Authorization value.
			const reason = err.name === 'TimeoutError' ? 'timeout' : (err.cause && err.cause.code) || (err instanceof TypeError ? 'the request could not be built' : 'network error');
			return { status: 0, text: '', error: String(reason) };
		}
	}
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

function printResult(output) {
	if (output === undefined) {
		console.log('result: (empty)');
		return;
	}
	const text = JSON.stringify(output, null, 2);
	console.log('result:');
	console.log(text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n... (truncated, ${text.length} characters in total)` : text);
}

async function run(argv) {
	let args;
	try {
		args = rc.parseArgs(argv);
	} catch (err) {
		if (err instanceof rc.UsageError) throw new Stop(rc.EXIT.USAGE, `ERROR: ${err.message}\n${USAGE}`);
		throw err;
	}
	require('./lib/version-guard').ensureFreshSkill();

	const teamId = rc.resolveTeam(args.teamId, readSkillConfig('make-team-id'));
	const teamFromSetting = args.teamId === null && teamId !== null;

	const settings = loadSettings();
	const editor = getEditorDir() === '.claude' ? 'claude' : 'cursor';
	const publicBase = rc.derivePublicBase(settings.baseUrl);
	const apiUrl = new URL(publicBase);
	const host = apiUrl.origin;
	const setupCommand = `node ${path.join(getSkillRoot(), 'scripts', 'setup-secrets.js')}`;
	const call = (req, opts = {}) => http(req, { retries: PREFLIGHT_RETRIES, timeoutMs: PREFLIGHT_TIMEOUT_MS, auth: settings.auth, ...opts });
	const discovery = rc.buildDiscoveryRequests(publicBase);
	const keyFix = (missing) => rc.scopeFixText({ editor, missing, setupCommand, host: apiUrl.host });

	let input = {};
	if (args.inputPath) {
		const forbidden = [SECRETS_PATH, CURSOR_SETTINGS_PATH, path.join(os.homedir(), '.claude.json'), path.join(os.homedir(), '.cursor', 'mcp.json')].flatMap((p) => {
			try {
				return [p, fs.realpathSync(p)];
			} catch {
				return [p];
			}
		});
		rc.rejectInputPath(args.inputPath, forbidden);
		let real;
		let stat;
		try {
			real = fs.realpathSync(args.inputPath);
			stat = fs.statSync(real);
		} catch (err) {
			throw new rc.UsageError(`cannot read the --input file (${err.code || 'error'})`);
		}
		rc.rejectInputPath(real, forbidden);
		if (!stat.isFile() || stat.size > rc.MAX_INPUT_BYTES) throw new rc.UsageError(`--input must be a regular file under ${rc.MAX_INPUT_BYTES / 1024} KiB`);
		input = rc.parseInputText(fs.readFileSync(real, 'utf-8'));
	}

	const fail = (what, r) => {
		const detail = r.error ? [`(${r.error})`] : fieldLines(rc.pickErrorFields(r.text));
		return new Stop(rc.EXIT.USAGE, [`ERROR: ${what} (HTTP ${r.status || 'no response'})`, ...detail].join('\n'));
	};

	// 1. key scopes
	const authz = await call(discovery.authorization);
	if (authz.status === 401) {
		stopAction('KEY_SCOPES', [
			'The Make API key was rejected (invalid, revoked or expired). Create a new key and update the skill config.',
			editor === 'cursor' ? 'Put it in the apikey field of your Make Apps SDK environment in Cursor.' : `Then run this in your own terminal, not through the agent: ${setupCommand}`,
		]);
	}
	if (authz.status !== 200) throw fail('could not read the key scopes', authz);
	const authorization = (parseJson(authz.text) || {}).authorization;
	if (!authorization || !Array.isArray(authorization.scope)) throw new Stop(rc.EXIT.USAGE, 'ERROR: unexpected current-authorization response');
	const keyScopes = authorization.scope;
	const missing = rc.missingScopes(keyScopes, rc.requiredKeyScopes({ kind: args.kind, needsConnection: false }));
	if (missing.length) stopAction('KEY_SCOPES', keyFix(missing));

	// 1b. no team: list the user's teams so the user can choose once
	if (!teamId) await chooseTeam();
	const reqs = rc.buildRequests({ publicBase, slug: args.slug, version: args.version, kind: args.kind, name: args.name, teamId });

	const warnings = [];
	const notes = [];

	// 2. the app must live in the zone this key talks to
	const sdkBase = `${settings.baseUrl}/sdk/apps/${args.slug}/${args.version}`;
	const originResp = await call({ method: 'GET', url: `${sdkBase}?cols[0]=origin` });
	const originJson = originResp.status === 200 ? parseJson(originResp.text) : null;
	const origin = originJson && ((originJson.app && originJson.app.origin) || originJson.origin);
	if (origin) {
		const originHost = origin.includes('/') ? origin.split('/')[0] : origin;
		if (originHost !== new URL(settings.baseUrl).hostname) {
			stopAction('CONFIG', [`App ${args.slug} lives in ${originHost}, but the configured API is ${new URL(settings.baseUrl).hostname}.`, 'Change make-api-url in the skill secrets file (or the Cursor environment) to the app zone and run again.']);
		}
	} else {
		warnings.push('the app origin zone could not be checked');
	}

	// 3. the team must be readable (--save-team) and, for an Endpoint, the app must be installed in its organization
	let orgId = null;
	let teamName = null;
	if (args.kind === 'endpoint' || args.saveTeam) {
		const missingTeams = rc.missingScopes(keyScopes, ['teams:read']);
		if (missingTeams.length) stopAction('KEY_SCOPES', keyFix(missingTeams));
		const teamResp = await call(reqs.team);
		if ((teamResp.status === 403 || teamResp.status === 404) && teamFromSetting) await chooseTeam(`make-team-id (${teamId}) is not readable with this key: wrong zone, deleted team, or lost access.`);
		if (teamResp.status === 403 || teamResp.status === 404) stopAction('MAKE_UI', [`Team ${teamId} was not found or this key cannot read it. Check the team id and your access in Make.`]);
		if (teamResp.status !== 200) throw fail('could not read the team', teamResp);
		const teamJson = parseJson(teamResp.text);
		orgId = rc.teamOrganizationId(teamJson);
		teamName = rc.teamName(teamJson);
		if (!orgId) throw new Stop(rc.EXIT.USAGE, 'ERROR: unexpected team response (no organizationId)');
		// The team exists and is readable: remember it when asked, whatever the later checks say.
		if (args.saveTeam && readSkillConfig('make-team-id') !== String(teamId)) {
			upsertSecretsFile(SECRETS_PATH, { 'make-team-id': String(teamId) });
			console.log(`saved make-team-id: ${teamId} in the skill secrets file`);
		}
	}
	if (args.kind === 'endpoint') {
		const appsResp = await call(discovery.installedApps(orgId));
		if (appsResp.status === 403) stopAction('MAKE_UI', [`This key cannot list the installed apps of organization ${orgId}. Ask an organization admin, or use another team.`]);
		if (appsResp.status !== 200) throw fail('could not list the installed apps', appsResp);
		const appsJson = parseJson(appsResp.text);
		if (!appsJson || !Array.isArray(appsJson.installedApps)) throw new Stop(rc.EXIT.USAGE, 'ERROR: unexpected installed apps response');
		if (!rc.installedIn(appsJson, args.slug, args.version)) {
			const other = await findInstalledElsewhere(orgId);
			stopAction('ORG_ADMIN', rc.orgAdminLines({ slug: args.slug, version: args.version, orgId, teamId, elsewhere: other.found, incomplete: other.incomplete }));
		}
	}

	// The user's organizations and teams, then stop so the agent can ask which team to use. `reason` says why a saved team failed.
	async function chooseTeam(reason) {
		const missingList = rc.missingScopes(keyScopes, ['organizations:read', 'teams:read']);
		if (missingList.length) stopAction('KEY_SCOPES', keyFix(missingList));
		const orgsResp = await call(discovery.organizations);
		if (orgsResp.status !== 200) throw fail('could not list your organizations', orgsResp);
		const found = await mapLimit(rc.parseOrganizations(parseJson(orgsResp.text)), DISCOVERY_CONCURRENCY, async (o) => {
			const t = await call(discovery.teams(o.id));
			if (t.status === 403) return { ...o, teams: [], skipped: true };
			if (t.status !== 200) return { ...o, teams: [], failed: true };
			const teams = rc.parseTeams(parseJson(t.text));
			let installed = null;
			if (args.kind === 'endpoint' && teams.length) {
				const apps = await call(discovery.installedApps(o.id));
				if (apps.status === 200) installed = rc.installedIn(parseJson(apps.text), args.slug, args.version);
			}
			return { ...o, teams, installed };
		});
		stopAction('CHOOSE_TEAM', rc.chooseTeamLines({ orgs: found, skipped: found.filter((o) => o.skipped).length, failed: found.filter((o) => o.failed).length, reason }));
	}

	// Best effort: the user's other organizations where the app is installed, with their teams. Never fails the run.
	async function findInstalledElsewhere(exceptOrgId) {
		const none = { found: [], incomplete: false };
		try {
			if (rc.missingScopes(keyScopes, ['organizations:read', 'teams:read']).length) return none;
			const orgsResp = await call(discovery.organizations);
			if (orgsResp.status !== 200) return { found: [], incomplete: true };
			const others = rc.parseOrganizations(parseJson(orgsResp.text)).filter((o) => o.id !== exceptOrgId);
			let incomplete = false;
			const found = await mapLimit(others, DISCOVERY_CONCURRENCY, async (o) => {
				const apps = await call(discovery.installedApps(o.id));
				if (apps.status !== 200) {
					if (apps.status !== 403) incomplete = true;
					return null;
				}
				if (!rc.installedIn(parseJson(apps.text), args.slug, args.version)) return null;
				const teams = await call(discovery.teams(o.id));
				if (teams.status !== 200) {
					incomplete = true;
					return null;
				}
				return { ...o, teams: rc.parseTeams(parseJson(teams.text)) };
			});
			return { found: found.filter(Boolean), incomplete };
		} catch {
			return { found: [], incomplete: true };
		}
	}

	// 4. input form and connection
	const formResp = await call(reqs.form);
	if (formResp.status === 501) stopAction('ORG_ADMIN', ['Endpoint execution is not enabled on this environment.', 'Ask a Make admin whether it is planned for this zone.']);
	if ((formResp.status === 401 || formResp.status === 403) && teamFromSetting) await chooseTeam(`make-team-id (${teamId}) is not accessible with this key: wrong zone, deleted team, or lost access.`);
	if (formResp.status === 401 || formResp.status === 403) stopAction('MAKE_UI', [`The input form of ${args.kind} ${args.name} is not accessible for team ${teamId} (HTTP ${formResp.status}). Check the team id and your access in Make.`, ...fieldLines(rc.pickErrorFields(formResp.text))]);
	if (formResp.status !== 200) throw fail(`could not read the input form of ${args.kind} ${args.name}`, formResp);
	let form;
	try {
		const body = parseJson(formResp.text);
		form = args.kind === 'endpoint' ? rc.parseEndpointForm(body) : rc.parseRpcOptions(body);
	} catch (err) {
		throw new Stop(rc.EXIT.USAGE, `ERROR: ${err.message}`);
	}

	let connectionRow = null;
	let otherConnections = 0;
	if (!form.connection && args.connectionId !== null) throw new Stop(rc.EXIT.USAGE, `ERROR: This ${args.kind} declares no connection; remove --connection.`);
	if (form.connection) {
		const missingConn = rc.missingScopes(keyScopes, rc.CONNECTION_SCOPES);
		if (missingConn.length) stopAction('KEY_SCOPES', keyFix(missingConn));
		const meResp = await call(discovery.me);
		if (meResp.status === 401) stopAction('KEY_SCOPES', ['The Make API key was rejected while reading your user. Create a new key and update the skill config.']);
		if (meResp.status !== 200) throw fail('could not read your user', meResp);
		const userId = rc.parseMe(parseJson(meResp.text));
		if (userId === null) throw new Stop(rc.EXIT.USAGE, 'ERROR: unexpected users/me response (no user id)');
		const connResp = await call(reqs.connections(form.connection));
		if (connResp.status === 401) stopAction('KEY_SCOPES', ['The Make API key was rejected while listing connections. Create a new key and update the skill config.']);
		if (connResp.status === 403) stopAction('MAKE_UI', [`The user behind this key cannot list the connections of team ${teamId}. Check the team role in Make.`, ...fieldLines(rc.pickErrorFields(connResp.text))]);
		if (connResp.status !== 200) throw fail('could not list the connections', connResp);
		const rows = (parseJson(connResp.text) || {}).connections;
		if (!Array.isArray(rows)) throw new Stop(rc.EXIT.USAGE, 'ERROR: unexpected connections response');
		const pick = rc.pickConnection({ rows, connectionId: args.connectionId, userId, now: Date.now(), types: form.connection.types });
		let request;
		if (pick.state === 'none' && form.connection.types.length && !args.dryRun && rc.canRequestCredentials(keyScopes)) {
			// A link only: the user authorizes on Make's own page, no credential passes through this script.
			const r = await http(rc.buildCredentialRequest({ publicBase, teamId, slug: args.slug, connection: form.connection }), { retries: 0, timeoutMs: PREFLIGHT_TIMEOUT_MS, auth: settings.auth });
			const uri = r.status >= 200 && r.status < 300 ? rc.parseCredentialRequestLink(r.text, apiUrl.hostname) : null;
			if (uri) request = { uri };
			else if (r.error) request = { reason: `no response (${r.error})` };
			else if (r.status >= 200 && r.status < 300) request = { reason: 'the response had no usable link' };
			else request = { reason: `HTTP ${r.status}${rc.pickErrorFields(r.text).message ? `: ${rc.pickErrorFields(r.text).message}` : ''}` };
		}
		const action = rc.connectionAction(pick, { host, teamId, connectionId: args.connectionId, connection: form.connection, request });
		if (action) stopAction(action.action, action.lines);
		connectionRow = pick.connection;
		otherConnections = pick.others;
		warnings.push(...pick.warnings);
	}

	// 5. local input check
	const check = rc.validateInput(args.kind, form.spec, input);
	if (check.errors.length) throw new Stop(rc.EXIT.USAGE, ['ERROR: the input does not match the declared parameters:', ...check.errors.map((e) => `  ${e}`)].join('\n'));
	warnings.push(...check.warnings);
	notes.push(...check.notes);

	// 6. side-effect label (best effort, informational)
	let effectInput;
	if (args.kind === 'endpoint') {
		const detail = await call({ method: 'GET', url: `${sdkBase}/endpoints/${args.name}` }, { retries: 0 });
		const endpoint = detail.status === 200 ? (parseJson(detail.text) || {}).appEndpoint : null;
		effectInput = { kind: 'endpoint', annotations: endpoint ? endpoint.annotations : undefined };
	} else {
		const api = await call({ method: 'GET', url: `${sdkBase}/rpcs/${args.name}/api` }, { retries: 0 });
		effectInput = { kind: 'rpc', rpcApi: api.status === 200 ? api.text : undefined };
	}
	const sideEffects = rc.sideEffectLabel(effectInput);
	const rerun = rc.sideEffectClass(effectInput) === 'read' ? 'The component is read-only, so running it again is safe.' : 'Do not run it again without asking the user.';

	// 7. summary
	const transport = args.kind === 'rpc' ? 'rpc' : rc.chooseEndpointTransport(keyScopes);
	const transportNote = {
		v1: 'v1 (POST /endpoints/v1/execute); the legacy rpcs route is tried once only if v1 provably did not run the request',
		legacy: 'legacy (POST /rpcs/...?kind=endpoint) because the key has no endpoints:run scope',
		rpc: 'rpc (POST /rpcs/...)',
	}[transport];
	const { masked, maskedKeys } = rc.maskInput(input);
	console.log(rc.renderRunSummary({
		kind: args.kind, slug: args.slug, version: args.version, name: args.name, host, teamId, teamName, orgId, installed: args.kind === 'endpoint',
		transportNote, connection: connectionRow, others: otherConnections, warnings, notes, input: masked, maskedKeys, sideEffects,
	}));
	if (args.dryRun) {
		console.log('dry run: nothing was sent');
		return;
	}

	// 8. execute: one request, no retries
	const connectionId = connectionRow ? connectionRow.id : null;
	const base = { publicBase, slug: args.slug, version: args.version, name: args.name, teamId, connectionId, input };
	const send = async (t) => {
		posted = true;
		const req = rc.buildExecRequest({ ...base, transport: t });
		const r = await http(req, { retries: 0, timeoutMs: EXEC_TIMEOUT_MS, auth: settings.auth });
		if (r.error) throw new Stop(rc.EXIT.UNKNOWN, `RESULT UNKNOWN: the request was sent but no response arrived (${r.error}).\nThe request may have run and may have been billed. ${rerun}`);
		return { ...rc.classifyExecResponse({ transport: t, status: r.status, bodyText: r.text }), multiple: r.multiple };
	};
	let used = transport;
	let result = await send(used);
	if (result.fallback && used === 'v1') {
		console.log(`v1 did not run the request (${result.reason}); trying the legacy route once`);
		used = 'legacy';
		result = await send(used);
	}
	console.log(`transport: ${used}`);
	if (result.outcome === 'ok') {
		if (used === 'rpc' && result.multiple) console.log('multiple results: yes');
		printResult(result.output);
		return;
	}
	const detail = fieldLines(result.fields);
	if (result.outcome === 'action') stopAction(result.action, [result.reason, ...detail]);
	if (result.outcome === 'rejected') throw new Stop(rc.EXIT.USAGE, [`ERROR: ${result.reason}`, ...detail].join('\n'));
	throw new Stop(rc.EXIT.UNKNOWN, [`RESULT UNKNOWN: ${result.reason}`, ...(result.hint ? [`hint: ${result.hint}`] : []), ...detail, `The request may have run and may have been billed. ${rerun}`].join('\n'));
}

function finish(code, stderrText) {
	if (stderrText) process.stderr.write(`${stderrText}\n`);
	process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

run(process.argv.slice(2)).then(
	() => finish(rc.EXIT.OK),
	(err) => {
		if (err instanceof Stop) return finish(err.code, err.stderrText);
		if (err instanceof rc.UsageError) return finish(posted ? rc.EXIT.UNKNOWN : rc.EXIT.USAGE, `ERROR: ${err.message}`);
		const text = `ERROR: unexpected failure (${err && err.name ? err.name : 'Error'}): ${err && err.message ? err.message : err}`;
		if (posted) return finish(rc.EXIT.UNKNOWN, `RESULT UNKNOWN: ${text}\nThe request may have run. Do not run it again without asking the user.`);
		return finish(rc.EXIT.USAGE, text);
	},
);
