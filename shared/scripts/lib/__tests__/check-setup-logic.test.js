const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../check-setup-logic');
const { TOKEN_SCOPES, formatScopes, runComponentScopesText, badTokenMessage, retryMessage, verdictFrom } = require('../mode-logic');

const HOST = 'us1.make.com';
const HINT = 'Run this in your own terminal (do not run it via the agent — it is interactive and writes secrets):\n  node "/p/setup-secrets.js" --editor claude';
const CMD = 'node "/p/setup-secrets.js" --editor claude';
const CURSOR_FILE = '/home/u/cursor/settings.json';
const CREDS = { ok: true, apikey: 'KEY_secret_value', host: HOST, source: 'make-zone', cursorAdmin: null };
const ME = { status: 200, body: { authUser: { id: 5, name: 'Dev User', email: 'dev@example.org' } } };
const ctx = (extra) => ({ editor: 'claude', setupHint: HINT, setupCommand: CMD, cursorSettingsPath: CURSOR_FILE, ...extra });
const UNAVAILABLE = 'us1.make.com, account name unavailable: the token lacks the user:read scope';
/** A probe result with the verdict the core gives for these two answers. */
const probeOf = (me, admin) => ({ me, admin, verdict: verdictFrom({ me, admin }) });

describe('reportedMode and modeLine', () => {
	it('reports employee and public, and nothing for another verdict or no probe', () => {
		assert.equal(logic.reportedMode({ verdict: 'employee' }), 'employee');
		assert.equal(logic.reportedMode({ verdict: 'public' }), 'public');
		for (const probe of [{ verdict: 'badToken' }, { verdict: 'retry' }, null]) assert.equal(logic.reportedMode(probe), null, JSON.stringify(probe));
	});

	it('prints MODE: with the mode, or unknown', () => {
		assert.equal(logic.modeLine('public'), 'MODE: public');
		assert.equal(logic.modeLine('employee'), 'MODE: employee');
		assert.equal(logic.modeLine(null), 'MODE: unknown');
	});
});

describe('splitMessage and tokenHelp', () => {
	it('splits a message into its first line and the rest', () => {
		assert.deepEqual(logic.splitMessage('what\nfix 1\nfix 2'), { detail: 'what', fix: 'fix 1\nfix 2' });
		assert.deepEqual(logic.splitMessage('only one line'), { detail: 'only one line', fix: null });
	});

	it('names the token page of the host, or of any Make host, with the scopes', () => {
		assert.equal(logic.tokenHelp('eu2.make.com'), `Create a token at https://eu2.make.com/user/api (scopes: ${logic.SCOPES_TEXT}).`);
		assert.equal(logic.tokenHelp(null), `Create a token at https://<your Make host>/user/api (scopes: ${logic.SCOPES_TEXT}).`);
	});

	it('builds the scope text from the scope lists of mode-logic, with no admin scope', () => {
		assert.equal(logic.SCOPES_TEXT, `${formatScopes(TOKEN_SCOPES)}; for run-component.js also ${runComponentScopesText()}`);
		assert.equal(
			logic.SCOPES_TEXT,
			'sdk-apps:read sdk-apps:write user:read; for run-component.js also teams:read organizations:read imt-forms:read, plus connections:read for components with a connection; optional: endpoints:run credential-requests:write',
		);
		assert.doesNotMatch(logic.SCOPES_TEXT, /admin/);
	});
});

describe('credentialItem without usable credentials (Claude Code)', () => {
	it('no key: the setup hint and the token page of the saved host, or of any Make host', () => {
		const creds = { ok: false, reason: 'no-key', detail: 'make-api-key is not set in /h/.make-custom-app-skill-secrets' };
		assert.deepEqual(logic.credentialItem(ctx({ creds, probe: null, tokenHost: 'eu2.make.com' })), {
			key: 'make-api-key',
			status: 'missing',
			detail: 'not set (Claude Code reads it from ~/.make-custom-app-skill-secrets)',
			fix: `${HINT}\n${logic.tokenHelp('eu2.make.com')}`,
		});
		const anyHost = logic.credentialItem(ctx({ creds, probe: null }));
		assert.equal(anyHost.fix, `${HINT}\n${logic.tokenHelp(null)}`);
		assert.doesNotMatch(anyHost.fix, /eu1/);
	});

	it('a key without a usable zone: the reason and the wizard', () => {
		for (const detail of ['make-zone is not set', 'make-zone is not a Make host: eu9', 'make-api-url is not on a Make host: https://example.org/api/v2']) {
			assert.deepEqual(logic.credentialItem(ctx({ creds: { ok: false, reason: 'no-zone', detail }, probe: null })), {
				key: 'make-api-key',
				status: 'missing',
				detail: `set, but no Make zone (${detail})`,
				fix: `${HINT}\nThe wizard tries the token on each Make zone and saves make-zone.`,
			});
		}
	});
});

describe('credentialItem without usable credentials (Cursor)', () => {
	const cursor = (creds) => logic.credentialItem(ctx({ editor: 'cursor', creds, probe: null }));

	it('an unreadable settings file: fix the JSON, with the line when it is known', () => {
		assert.deepEqual(cursor({ ok: false, reason: 'unreadable', detail: 'invalid JSON near line 2' }), {
			key: 'make-api (Cursor settings.json)',
			status: 'missing',
			detail: 'cannot read the file: invalid JSON near line 2',
			fix: `Fix the JSON in ${CURSOR_FILE}, near line 2, then run check-setup again.`,
		});
		assert.equal(cursor({ ok: false, reason: 'unreadable', detail: 'invalid JSON' }).fix, `Fix the JSON in ${CURSOR_FILE}, then run check-setup again.`);
	});

	it('no settings file or no environments: install the extension', () => {
		for (const reason of ['missing', 'no-environments']) {
			const result = cursor({ ok: false, reason, detail: `detail of ${reason}` });
			assert.deepEqual(result, { key: 'make-api (Cursor settings.json)', status: 'missing', detail: `detail of ${reason}`, fix: result.fix });
			assert.match(result.fix, /^Install the Make Apps SDK extension in Cursor/);
		}
	});

	it('an environment without a key or a Make host: complete the environment', () => {
		for (const reason of ['no-key', 'no-host']) {
			const result = cursor({ ok: false, reason, detail: `detail of ${reason}` });
			assert.equal(result.status, 'missing');
			assert.equal(result.detail, `detail of ${reason}`);
			assert.equal(result.fix, `Give the active environment of the Make Apps SDK extension in Cursor your Make API token and the host you open Make at. ${logic.tokenHelp(null)}`);
		}
	});
});

describe('credentialItem after the check', () => {
	it('shows the host and the account name of users/me', () => {
		assert.deepEqual(logic.credentialItem(ctx({ creds: CREDS, probe: { me: ME, admin: { status: 403 }, verdict: 'public' } })), {
			key: 'make-api-key',
			status: 'ok',
			detail: 'us1.make.com, account Dev User',
			fix: null,
		});
		const cursor = logic.credentialItem(ctx({ editor: 'cursor', creds: { ...CREDS, source: 'cursor', cursorAdmin: false }, probe: { me: ME, admin: { status: 200 }, verdict: 'employee' } }));
		assert.equal(cursor.key, 'make-api (Cursor settings.json)');
		assert.equal(cursor.detail, 'us1.make.com, account Dev User');
	});

	it('keeps the detail on one line, and shows the host alone without an account name', () => {
		const multiLine = { status: 200, body: { authUser: { name: 'Dev\nUser' } } };
		assert.equal(logic.credentialItem(ctx({ creds: CREDS, probe: { me: multiLine, admin: { status: 403 }, verdict: 'public' } })).detail, 'us1.make.com, account Dev User');
		assert.equal(logic.credentialItem(ctx({ creds: CREDS, probe: { me: { status: 200 }, admin: { status: 403 }, verdict: 'public' } })).detail, 'us1.make.com');
	});

	it('a users/me 403 is a token without user:read: ok, with the account name unavailable, whatever the admin probe says', () => {
		for (const admin of [{ status: 403 }, { status: 200 }, { status: 500 }]) {
			assert.deepEqual(logic.credentialItem(ctx({ creds: CREDS, probe: probeOf({ status: 403 }, admin) })), { key: 'make-api-key', status: 'ok', detail: UNAVAILABLE, fix: null }, JSON.stringify(admin));
		}
	});

	it('a rejected token is missing, with the token page and the setup command', () => {
		const result = logic.credentialItem(ctx({ creds: CREDS, probe: { me: { status: 401 }, admin: null, verdict: 'badToken' } }));
		assert.deepEqual(result, { key: 'make-api-key', status: 'missing', ...logic.splitMessage(badTokenMessage(HOST, { editor: 'claude', setupCommand: CMD })) });
		assert.equal(result.detail, 'Make rejected the saved API token for us1.make.com (HTTP 401).');
		assert.ok(!JSON.stringify(result).includes(CREDS.apikey));
	});

	it('a users/me call without an answer leaves the key unchecked; the mode item carries the retry', () => {
		const result = logic.credentialItem(ctx({ creds: CREDS, probe: { me: { error: 'ECONNREFUSED' }, admin: null, verdict: 'retry' } }));
		assert.deepEqual(result, { key: 'make-api-key', status: 'ok', detail: 'us1.make.com, account not checked (see mode)', fix: null });
	});
});

describe('modeItem', () => {
	it('shows the verdict with the status of the admin API probe', () => {
		assert.deepEqual(logic.modeItem({ creds: CREDS, probe: { me: ME, admin: { status: 403 }, verdict: 'public' } }), { key: 'mode', status: 'ok', detail: 'public (admin API 403)', fix: null });
		assert.equal(logic.modeItem({ creds: CREDS, probe: { me: ME, admin: { status: 401 }, verdict: 'public' } }).detail, 'public (admin API 401)');
		assert.equal(logic.modeItem({ creds: CREDS, probe: { me: ME, admin: { status: 200 }, verdict: 'employee' } }).detail, 'employee (admin API 200)');
	});

	it('follows the admin API probe after a users/me 403', () => {
		const me = { status: 403 };
		assert.deepEqual(logic.modeItem({ creds: CREDS, probe: probeOf(me, { status: 403 }) }), { key: 'mode', status: 'ok', detail: 'public (admin API 403)', fix: null });
		assert.deepEqual(logic.modeItem({ creds: CREDS, probe: probeOf(me, { status: 200 }) }), { key: 'mode', status: 'ok', detail: 'employee (admin API 200)', fix: null });
		assert.deepEqual(logic.modeItem({ creds: CREDS, probe: probeOf(me, { status: 500 }) }), {
			key: 'mode',
			status: 'missing',
			...logic.splitMessage(retryMessage(HOST, 'admin API probe: HTTP 500')),
		});
		assert.equal(logic.reportedMode(probeOf(me, { status: 403 })), 'public');
		assert.equal(logic.reportedMode(probeOf(me, { status: 200 })), 'employee');
	});

	it('is missing without a token or with a rejected one, without a fix of its own', () => {
		assert.deepEqual(logic.modeItem({ creds: { ok: false, reason: 'no-key' }, probe: null }), { key: 'mode', status: 'missing', detail: 'unknown (no Make API token to check)', fix: null });
		assert.deepEqual(logic.modeItem({ creds: CREDS, probe: { me: { status: 401 }, admin: null, verdict: 'badToken' } }), { key: 'mode', status: 'missing', detail: 'unknown (Make rejected the token)', fix: null });
	});

	it('is missing with the retry text when a call got no usable answer', () => {
		assert.deepEqual(logic.modeItem({ creds: CREDS, probe: { me: { error: 'ECONNREFUSED' }, admin: null, verdict: 'retry' } }), {
			key: 'mode',
			status: 'missing',
			...logic.splitMessage(retryMessage(HOST, 'GET /users/me: ECONNREFUSED')),
		});
		const admin = logic.modeItem({ creds: CREDS, probe: { me: ME, admin: { status: 500 }, verdict: 'retry' } });
		assert.equal(admin.detail, 'Could not check the Make API token for us1.make.com (admin API probe: HTTP 500).');
		assert.equal(admin.fix, 'Nothing was changed. Retry later, and check the network, VPN or proxy.');
	});
});

describe('mcpServerItem', () => {
	const SECRETS = '/home/u/.make-custom-app-skill-secrets';
	const KEYS = [
		{ key: 'pinecone-api-key', variable: 'MAKE_APP_CONTEXT_PINECONE_API_KEY' },
		{ key: 'openai-api-key', variable: 'MAKE_APP_CONTEXT_OPENAI_API_KEY' },
	];
	const WIZARD_LINE = 'Optional — the wizard asks for the Pinecone and OpenAI keys of the shared app-context server and saves them in the secrets file.';
	const item = (mode, missing) => logic.mcpServerItem({ mode, missing, secretsPath: SECRETS, setupHint: HINT });
	const OK = {
		key: 'mcp-server',
		status: 'ok',
		detail: `keys are set (environment or ${SECRETS}); cannot check whether the server is registered: plugin MCP servers are not listed in ~/.claude.json or ~/.cursor/mcp.json`,
		fix: null,
	};

	it('is ok when no key is missing, in every mode', () => {
		for (const mode of ['employee', 'public', null]) assert.deepEqual(item(mode, []), OK, String(mode));
	});

	it("keeps today's optional item and its fix for an employee or an unknown mode", () => {
		for (const mode of ['employee', null]) {
			assert.deepEqual(item(mode, KEYS), {
				key: 'mcp-server',
				status: 'optional-missing',
				detail: `missing: pinecone-api-key, openai-api-key (set MAKE_APP_CONTEXT_PINECONE_API_KEY, MAKE_APP_CONTEXT_OPENAI_API_KEY or the same key in ${SECRETS})`,
				fix: `${HINT}\n${WIZARD_LINE}`,
			}, String(mode));
		}
		assert.equal(item('employee', [KEYS[1]]).detail, `missing: openai-api-key (set MAKE_APP_CONTEXT_OPENAI_API_KEY or the same key in ${SECRETS})`);
	});

	it('row 16: public mode stays optional-missing with no fix and the public detail', () => {
		const expected = {
			key: 'mcp-server',
			status: 'optional-missing',
			detail: 'not needed in public mode: the shared Make app-context index is not available to public users, and your app notes stay in ~/.make-custom-app/contexts. Set the two keys only if you run a Pinecone index of your own.',
			fix: null,
		};
		assert.deepEqual(item('public', KEYS), expected);
		assert.deepEqual(item('public', [KEYS[0]]), expected);
	});
});
