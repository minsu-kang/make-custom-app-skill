require('./isolate-home');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logic = require('../setup-secrets-logic');
const { upsertSecretsFile } = require('../secrets-file');
const { detectZone, detectMode } = require('../mode');
const { ZONES, TOKEN_SCOPES, RUN_COMPONENT_SCOPES, ACCOUNT_NAME_UNAVAILABLE, formatScopes, runComponentScopesText } = require('../mode-logic');

const TOKEN = 'WIZARD_TOKEN_secret_value';

describe('parseArgs', () => {
	it('returns no editor when there are no arguments', () => {
		assert.deepEqual(logic.parseArgs([]), { editor: null, error: null });
	});

	it('reads --editor with a separate value or with =', () => {
		assert.deepEqual(logic.parseArgs(['--editor', 'claude']), { editor: 'claude', error: null });
		assert.deepEqual(logic.parseArgs(['--editor=cursor']), { editor: 'cursor', error: null });
	});

	it('passes any value through, so the check of the value stays in paths.resolveEditor', () => {
		assert.deepEqual(logic.parseArgs(['--editor', 'vscode']), { editor: 'vscode', error: null });
	});

	it('lets the last --editor win', () => {
		assert.deepEqual(logic.parseArgs(['--editor', 'claude', '--editor=cursor']), { editor: 'cursor', error: null });
	});

	it('reports a missing value', () => {
		for (const argv of [['--editor'], ['--editor='], ['--editor', ''], ['--editor', '--other']]) {
			assert.deepEqual(logic.parseArgs(argv), { editor: null, error: '--editor needs a value: claude or cursor.' }, argv.join(' '));
		}
	});

	it('reports an argument it does not know', () => {
		assert.deepEqual(logic.parseArgs(['--bogus']), { editor: null, error: 'Unknown argument: --bogus' });
		assert.deepEqual(logic.parseArgs(['--editor', 'claude', 'extra']), { editor: null, error: 'Unknown argument: extra' });
	});

	it('has a usage line that names the flag', () => {
		assert.equal(logic.USAGE, 'Usage: node setup-secrets.js [--editor claude|cursor]');
	});
});

describe('makeKeyInSecretsFile', () => {
	it('is true for Claude Code and false for Cursor, which reads the key from its own settings.json', () => {
		assert.equal(logic.makeKeyInSecretsFile('claude'), true);
		assert.equal(logic.makeKeyInSecretsFile('cursor'), false);
	});
});

describe('buildSecretsUpdates', () => {
	const ANSWERS = {
		makeApiKey: 'MK',
		makeZone: 'us2.make.com',
		runtimePath: '/work/imt-app-runtime',
		mockupPath: '/work/make-apps-mockup',
		teamId: '42',
		jiraToken: 'JT',
		jiraEmail: 'dev@make.com',
		jiraBaseUrl: 'https://make.atlassian.net',
	};

	it('lists every key of an employee run for Claude Code, in the order they are written', () => {
		assert.deepEqual(Object.entries(logic.buildSecretsUpdates('claude', ANSWERS)), [
			['make-api-key', 'MK'],
			['make-zone', 'us2.make.com'],
			['imt-app-runtime-path', '/work/imt-app-runtime'],
			['make-apps-mockup-path', '/work/make-apps-mockup'],
			['make-team-id', '42'],
			['jira-api-token', 'JT'],
			['jira-email', 'dev@make.com'],
			['jira-base-url', 'https://make.atlassian.net'],
		]);
	});

	it('leaves out the Make API key and zone for Cursor, so a Claude Code key in the file stays as it is', () => {
		const keys = Object.keys(logic.buildSecretsUpdates('cursor', ANSWERS));
		assert.deepEqual(keys, ['imt-app-runtime-path', 'make-apps-mockup-path', 'make-team-id', 'jira-api-token', 'jira-email', 'jira-base-url']);
	});

	it('never writes make-api-url, which a 2.x install reads from the same file', () => {
		for (const editor of ['claude', 'cursor']) {
			assert.ok(!('make-api-url' in logic.buildSecretsUpdates(editor, { ...ANSWERS, makeApiUrl: 'https://eu1.make.com/api/v2/admin' })), editor);
		}
	});

	it('sets skipped optional answers to null, which the secrets file leaves untouched', () => {
		const updates = logic.buildSecretsUpdates('claude', { ...ANSWERS, mockupPath: '', teamId: '' });
		assert.equal(updates['make-apps-mockup-path'], null);
		assert.equal(updates['make-team-id'], null);
		assert.equal(updates['imt-app-runtime-path'], '/work/imt-app-runtime');
	});

	it('writes no Jira line when there is no Jira token', () => {
		const updates = logic.buildSecretsUpdates('claude', { ...ANSWERS, jiraToken: '' });
		assert.equal(updates['jira-api-token'], null);
		assert.equal(updates['jira-email'], null);
		assert.equal(updates['jira-base-url'], null);
	});

	it('leaves every employee line untouched in a public run, which asks only the team id', () => {
		assert.deepEqual(logic.buildSecretsUpdates('claude', { makeApiKey: 'MK', makeZone: 'eu2.make.com', teamId: '7' }), {
			'make-api-key': 'MK',
			'make-zone': 'eu2.make.com',
			'imt-app-runtime-path': null,
			'make-apps-mockup-path': null,
			'make-team-id': '7',
			'jira-api-token': null,
			'jira-email': null,
			'jira-base-url': null,
		});
	});
});

describe('buildMcpUpdates', () => {
	it('maps the three answers to the keys of the secrets file', () => {
		assert.deepEqual(logic.buildMcpUpdates({ pineconeKey: 'PK', pineconeIndex: 'my-index', openaiKey: 'OK' }), {
			'pinecone-api-key': 'PK',
			'pinecone-index-name': 'my-index',
			'openai-api-key': 'OK',
		});
	});

	it('falls back to the default index and leaves empty keys untouched', () => {
		assert.deepEqual(logic.buildMcpUpdates({ pineconeKey: '', pineconeIndex: '', openaiKey: '' }), {
			'pinecone-api-key': null,
			'pinecone-index-name': 'make-app-contexts',
			'openai-api-key': null,
		});
	});
});

describe('mcpConfigured', () => {
	it('is true only when the Pinecone key, the index name and the OpenAI key are all set', () => {
		assert.equal(logic.mcpConfigured({ pineconeKey: 'PK', pineconeIndex: 'idx', openaiKey: 'OK' }), true);
		for (const missing of ['pineconeKey', 'pineconeIndex', 'openaiKey']) {
			const values = { pineconeKey: 'PK', pineconeIndex: 'idx', openaiKey: 'OK', [missing]: null };
			assert.equal(logic.mcpConfigured(values), false, missing);
		}
	});
});

describe('the updates written through upsertSecretsFile', () => {
	let work;
	before(() => {
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-secrets-logic-'));
	});
	after(() => fs.rmSync(work, { recursive: true, force: true }));

	it('replace existing MCP keys in place, add the missing one at the end, and leave the file private', () => {
		const file = path.join(work, 'mcp-secrets');
		fs.writeFileSync(file, 'imt-app-runtime-path: /a\npinecone-api-key: OLDPINE\njira-email: dev@make.com\nopenai-api-key: SAMEOPENAI\n', { mode: 0o644 });
		upsertSecretsFile(file, logic.buildMcpUpdates({ pineconeKey: 'NEWPINE', pineconeIndex: '', openaiKey: 'SAMEOPENAI' }));
		assert.equal(
			fs.readFileSync(file, 'utf8'),
			'imt-app-runtime-path: /a\npinecone-api-key: NEWPINE\njira-email: dev@make.com\nopenai-api-key: SAMEOPENAI\npinecone-index-name: make-app-contexts\n',
		);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	});

	it('keep a Make API key of Claude Code when the editor is Cursor', () => {
		const file = path.join(work, 'cursor-secrets');
		fs.writeFileSync(file, 'make-api-key: CLAUDEKEY\nmake-api-url: https://us1.make.com/api/v2/admin\n');
		upsertSecretsFile(file, logic.buildSecretsUpdates('cursor', { runtimePath: '/work/imt-app-runtime', mockupPath: '', teamId: '', jiraToken: '' }));
		assert.equal(
			fs.readFileSync(file, 'utf8'),
			'make-api-key: CLAUDEKEY\nmake-api-url: https://us1.make.com/api/v2/admin\nimt-app-runtime-path: /work/imt-app-runtime\n',
		);
	});

	it('add make-zone and keep a legacy make-api-url line and the employee lines in a public run', () => {
		const file = path.join(work, 'public-secrets');
		fs.writeFileSync(file, 'make-api-key: OLDKEY\nmake-api-url: https://eu1.make.com/api/v2/admin\nimt-app-runtime-path: /a\njira-api-token: JT\njira-email: dev@make.com\n');
		upsertSecretsFile(file, logic.buildSecretsUpdates('claude', { makeApiKey: 'NEWKEY', makeZone: 'eu1.make.com', teamId: '' }));
		assert.equal(
			fs.readFileSync(file, 'utf8'),
			'make-api-key: NEWKEY\nmake-api-url: https://eu1.make.com/api/v2/admin\nimt-app-runtime-path: /a\njira-api-token: JT\njira-email: dev@make.com\nmake-zone: eu1.make.com\n',
		);
	});
});

describe('promptHint', () => {
	it('shows the current value of a visible question', () => {
		assert.equal(logic.promptHint({ current: '/work/imt-app-runtime', optional: false, hidden: false }), ' [/work/imt-app-runtime, Enter to keep]');
	});

	it('never shows the current value of a hidden question', () => {
		const hint = logic.promptHint({ current: 'TOPSECRET', optional: false, hidden: true });
		assert.equal(hint, ' [set, Enter to keep]');
		assert.ok(!hint.includes('TOPSECRET'));
	});

	it('offers to skip an optional question without a value', () => {
		assert.equal(logic.promptHint({ current: '', optional: true, hidden: false }), ' [Enter to skip]');
	});

	it('adds nothing to a required question without a value', () => {
		assert.equal(logic.promptHint({ current: null, optional: false, hidden: true }), '');
	});
});

describe('maskForDisplay', () => {
	it('shows only "set" for a secret key', () => {
		for (const key of ['make-api-key', 'jira-api-token', 'pinecone-api-key', 'openai-api-key']) {
			assert.equal(logic.maskForDisplay(key, 'TOPSECRET'), 'set', key);
		}
	});

	it('shows "not set" for an empty value, a missing value and a blank value', () => {
		for (const value of ['', null, undefined, '   ']) assert.equal(logic.maskForDisplay('pinecone-api-key', value), 'not set', String(value));
	});

	it('shows the value of a key that is not secret', () => {
		assert.equal(logic.maskForDisplay('pinecone-index-name', 'make-app-contexts'), 'make-app-contexts');
		assert.equal(logic.maskForDisplay('pinecone-index-name', null), 'not set');
	});
});

describe('formatStatus', () => {
	it('lists each key with "set" or "not set" for a secret, and never the secret', () => {
		const lines = logic.formatStatus({ 'pinecone-api-key': 'PK-SECRET', 'pinecone-index-name': 'make-app-contexts', 'openai-api-key': null });
		assert.deepEqual(lines, ['  pinecone-api-key: set', '  pinecone-index-name: make-app-contexts', '  openai-api-key: not set']);
		assert.ok(!lines.join('\n').includes('PK-SECRET'));
	});
});

describe('nextStepLines', () => {
	it('prints the check-setup command with the script path in double quotes', () => {
		const dir = '/home/First Last/plugin/shared/scripts';
		assert.deepEqual(logic.nextStepLines(dir), [
			'',
			'Done. Verify by asking the agent in your editor to run:',
			`  node "${path.join(dir, 'check-setup.js')}"`,
		]);
	});
});

describe('the removed eu1 default', () => {
	it('is gone: the wizard finds the zone instead', () => {
		assert.equal(logic.DEFAULT_MAKE_API_URL, undefined);
	});
});

describe('tokenIntroLines', () => {
	it('links the token page of the saved host', () => {
		assert.equal(logic.tokenIntroLines('us1.make.celonis.com')[0], 'Create a token at https://us1.make.celonis.com/user/api');
	});

	it('assumes no zone when nothing is saved', () => {
		assert.equal(logic.tokenIntroLines(null)[0], 'Create a token on the API page of your Make profile: https://<your Make host>/user/api (for example https://eu1.make.com/user/api).');
	});

	it('builds the scope lines from the one scope source in mode-logic, with no admin scope', () => {
		const lines = logic.tokenIntroLines(null);
		assert.equal(lines[1], `Scopes: ${formatScopes(TOKEN_SCOPES)} (user:read lets the wizard and check-setup find your zone and account).`);
		assert.equal(lines[1], 'Scopes: sdk-apps:read sdk-apps:write user:read (user:read lets the wizard and check-setup find your zone and account).');
		assert.equal(lines[2], `For run-component.js (live Endpoint / RPC runs) also add: ${runComponentScopesText()}`);
		for (const scope of Object.values(RUN_COMPONENT_SCOPES).flat()) assert.ok(lines[2].includes(scope), scope);
		assert.doesNotMatch(lines.join('\n'), /admin/i);
	});
});

describe('zoneOutcome', () => {
	it('takes the one zone that accepted the token and links its token page', () => {
		assert.deepEqual(logic.zoneOutcome({ host: 'us2.make.com' }, 'eu1.make.com'), {
			host: 'us2.make.com',
			lines: ['Zone: us2.make.com (the only Make zone that accepted this token). Token page: https://us2.make.com/user/api'],
		});
	});

	it('lists every zone with its answer when none accepted the token, and offers the saved zone', () => {
		const results = [
			{ host: 'eu1.make.com', status: 401 },
			{ host: 'eu2.make.com', error: 'ENOTFOUND' },
			{ host: 'us1.make.com', status: 500 },
			{ host: 'us2.make.com', status: 401 },
			{ host: 'eu1.make.celonis.com' },
		];
		assert.deepEqual(logic.zoneOutcome({ ask: true, results }, 'us1.make.com'), {
			ask: true,
			lines: [
				'No Make zone accepted this token. Choose the zone you sign in to:',
				'  1) eu1.make.com          HTTP 401',
				'  2) eu2.make.com          ENOTFOUND',
				'  3) us1.make.com          HTTP 500',
				'  4) us2.make.com          HTTP 401',
				'  5) eu1.make.celonis.com  no answer',
				'  6) us1.make.celonis.com  no answer',
			],
			current: 'us1.make.com',
		});
	});

	it('explains a 403 under the list: a valid token without user:read, so the user picks that zone', () => {
		const results = ZONES.map((host) => ({ host, status: host === 'eu2.make.com' ? 403 : 401 }));
		const outcome = logic.zoneOutcome({ ask: true, results }, null);
		assert.equal(outcome.lines.length, 8);
		assert.equal(outcome.lines[0], 'No Make zone accepted this token. Choose the zone you sign in to:');
		assert.equal(outcome.lines[2], '  2) eu2.make.com          HTTP 403');
		assert.equal(outcome.lines[7], logic.ZONE_403_HINT);
		assert.equal(logic.ZONE_403_HINT, 'HTTP 403 means the token is valid on that zone but lacks the user:read scope: choose that zone, or add user:read to the token and run this wizard again.');
	});

	it('says so when several zones accepted the token, and adds no 403 line next to a 200', () => {
		const results = ZONES.map((host, i) => ({ host, status: i === 2 ? 403 : 200 }));
		const outcome = logic.zoneOutcome({ ask: true, results }, null);
		assert.equal(outcome.lines[0], 'Several Make zones accepted this token. Choose the zone you sign in to:');
		assert.equal(outcome.lines.length, 7);
		assert.equal(outcome.current, null);
	});

	it('offers no saved zone that is not one of the six', () => {
		assert.equal(logic.zoneOutcome({ ask: true, results: [] }, 'dev.make.com').current, null);
	});

	it('stops with the retry advice when every zone call failed with a network error, and lists no zones to choose', () => {
		const results = ZONES.map((host) => ({ host, error: 'ENOTFOUND' }));
		assert.deepEqual(logic.zoneOutcome({ ask: true, results }, 'us1.make.com'), {
			stop: true,
			lines: ['Could not check the Make API token for any Make zone (every zone call failed: ENOTFOUND).', 'Nothing was changed. Retry later, and check the network, VPN or proxy.'],
		});
		const mixed = ZONES.map((host, i) => ({ host, error: i % 2 ? 'TimeoutError' : 'ENOTFOUND' }));
		assert.equal(logic.zoneOutcome({ ask: true, results: mixed }, null).lines[0], 'Could not check the Make API token for any Make zone (every zone call failed: ENOTFOUND, TimeoutError).');
	});

	it('still lists the zones when at least one zone answered with an HTTP status', () => {
		const results = ZONES.map((host, i) => (i === 0 ? { host, status: 401 } : { host, error: 'ENOTFOUND' }));
		const outcome = logic.zoneOutcome({ ask: true, results }, null);
		assert.equal(outcome.ask, true);
		assert.equal(outcome.stop, undefined);
		assert.equal(outcome.lines[0], 'No Make zone accepted this token. Choose the zone you sign in to:');
	});
});

describe('zoneFromChoice and zoneChoiceError', () => {
	it('accepts a list number or one of the six hosts', () => {
		assert.equal(logic.zoneFromChoice('1'), 'eu1.make.com');
		assert.equal(logic.zoneFromChoice(' 3 '), 'us1.make.com');
		assert.equal(logic.zoneFromChoice('6'), 'us1.make.celonis.com');
		assert.equal(logic.zoneFromChoice('US2.Make.com'), 'us2.make.com');
		assert.equal(logic.zoneChoiceError('eu1.make.celonis.com'), null);
	});

	it('refuses anything else with the list of valid answers', () => {
		for (const raw of ['0', '7', '1.5', '-1', '', null, 'eu3.make.com', 'https://eu1.make.com', 'dev.make.com']) {
			assert.equal(logic.zoneFromChoice(raw), null, String(raw));
			assert.equal(
				logic.zoneChoiceError(raw),
				'Enter a number from 1 to 6 or one of: eu1.make.com, eu2.make.com, us1.make.com, us2.make.com, eu1.make.celonis.com, us1.make.celonis.com.',
				String(raw),
			);
		}
	});
});

describe('cursorCredentialLines', () => {
	const file = '/home/dev/Cursor/User/settings.json';
	const FIX = 'Set up the Make Apps SDK extension in Cursor (an environment with its API key), then run this wizard again. Nothing was written.';

	it('names the problem with the settings file once, then the fix', () => {
		assert.deepEqual(logic.cursorCredentialLines({ reason: 'missing', detail: `Cursor settings file not found: ${file}` }, file), [
			`Cannot check the Make API token of Cursor: Cursor settings file not found: ${file}.`,
			FIX,
		]);
		assert.deepEqual(logic.cursorCredentialLines({ reason: 'unreadable', detail: 'invalid JSON near line 3' }, file), [
			`Cannot check the Make API token of Cursor: ${file}: invalid JSON near line 3.`,
			FIX,
		]);
	});
});

describe('modeOutcome', () => {
	const ME = { status: 200, body: { authUser: { name: 'Dev User' } } };

	it('employee when the admin API accepts the token, with the account label of mode-logic', () => {
		assert.deepEqual(logic.modeOutcome({ me: ME, admin: { status: 200 } }, 'eu1.make.com', 'claude'), {
			mode: 'employee',
			lines: ['Make employee account detected (Dev User on eu1.make.com, admin API 200).'],
		});
		const spaced = { status: 200, body: { authUser: { name: ' Dev \n  User ' } } };
		assert.equal(logic.modeOutcome({ me: spaced, admin: { status: 200 } }, 'eu1.make.com', 'claude').lines[0], 'Make employee account detected (Dev User on eu1.make.com, admin API 200).');
	});

	it('public when the admin API answers 401, 403 or 404, and says which questions are skipped', () => {
		assert.deepEqual(logic.modeOutcome({ me: { status: 200, body: null }, admin: { status: 403 } }, 'us2.make.com', 'claude'), {
			mode: 'public',
			lines: ['Public mode (us2.make.com, admin API 403): the Make employee questions (imt-app-runtime, make-apps-mockup, Jira) are skipped.'],
		});
		for (const status of [401, 404]) assert.equal(logic.modeOutcome({ me: ME, admin: { status } }, 'us2.make.com', 'cursor').mode, 'public', String(status));
	});

	it('goes on after a users/me 403 (a token without user:read): the admin probe decides, and the account name is unavailable', () => {
		assert.deepEqual(logic.modeOutcome({ me: { status: 403, body: {} }, admin: { status: 200 } }, 'eu1.make.com', 'claude'), {
			mode: 'employee',
			lines: [`Make employee account detected (eu1.make.com, admin API 200; ${ACCOUNT_NAME_UNAVAILABLE}).`],
		});
		assert.deepEqual(logic.modeOutcome({ me: { status: 403 }, admin: { status: 403 } }, 'us2.make.com', 'cursor'), {
			mode: 'public',
			lines: [
				'Public mode (us2.make.com, admin API 403; account name unavailable: the token lacks the user:read scope): the Make employee questions (imt-app-runtime, make-apps-mockup, Jira) are skipped.',
			],
		});
	});

	it('stops on a rejected token with the token page of the zone', () => {
		assert.deepEqual(logic.modeOutcome({ me: { status: 401 }, admin: null }, 'eu2.make.com', 'claude'), {
			stop: true,
			lines: ['Make rejected this token on eu2.make.com (HTTP 401). Nothing was written.', 'Create a new token at https://eu2.make.com/user/api and run this wizard again.'],
		});
		assert.deepEqual(logic.modeOutcome({ me: { status: 401 }, admin: null }, 'eu2.make.com', 'cursor'), {
			stop: true,
			lines: [
				'Make rejected the API token of the active Cursor environment on eu2.make.com (HTTP 401). Nothing was written.',
				'Create a new token at https://eu2.make.com/user/api, put it in the active Make Apps SDK environment in Cursor, and run this wizard again.',
			],
		});
	});

	it('adds one line for a zone the user picked by hand: run the wizard again and choose another zone', () => {
		const outcome = logic.modeOutcome({ me: { status: 401 }, admin: null }, 'eu2.make.com', 'claude', { zoneChosen: true });
		assert.deepEqual(outcome, {
			stop: true,
			lines: [
				'Make rejected this token on eu2.make.com (HTTP 401). Nothing was written.',
				'Create a new token at https://eu2.make.com/user/api and run this wizard again.',
				'If you chose this zone from the list, run this wizard again and choose another zone.',
			],
		});
		assert.equal(logic.modeOutcome({ me: { status: 401 }, admin: null }, 'eu2.make.com', 'claude', { zoneChosen: false }).lines.length, 2);
		assert.equal(logic.modeOutcome({ me: { status: 401 }, admin: null }, 'eu2.make.com', 'cursor', { zoneChosen: true }).lines.length, 2);
	});

	it('stops without a usable answer and never falls back to public', () => {
		const cases = [
			[{ me: { error: 'ECONNREFUSED' }, admin: null }, 'GET /users/me: ECONNREFUSED'],
			[{ me: { status: 500 }, admin: null }, 'GET /users/me: HTTP 500'],
			[{ me: { status: 429 }, admin: null }, 'GET /users/me: HTTP 429'],
			[{ me: { status: 403 }, admin: { status: 500 } }, 'admin API probe: HTTP 500'],
			[{ me: ME, admin: { status: 500 } }, 'admin API probe: HTTP 500'],
			[{ me: ME, admin: { status: 429 } }, 'admin API probe: HTTP 429'],
			[{ me: ME, admin: { error: 'TimeoutError' } }, 'admin API probe: TimeoutError'],
		];
		for (const [result, detail] of cases) {
			assert.deepEqual(logic.modeOutcome(result, 'eu1.make.com', 'claude'), {
				stop: true,
				lines: [`Could not check the Make API token for eu1.make.com (${detail}).`, 'Nothing was changed. Retry later, and check the network, VPN or proxy.'],
			}, detail);
		}
	});
});

describe('questionSteps', () => {
	it('asks a Make employee the questions of today, in the order of today', () => {
		assert.deepEqual(logic.questionSteps('employee'), ['imt-app-runtime-path', 'make-apps-mockup-path', 'make-team-id', 'jira-api-token']);
	});

	it('asks a public account only the team id', () => {
		assert.deepEqual(logic.questionSteps('public'), ['make-team-id']);
	});

	it('returns a fresh list each time', () => {
		logic.questionSteps('public').push('jira-api-token');
		assert.deepEqual(logic.questionSteps('public'), ['make-team-id']);
	});

	it('has no questions for a verdict that is not a mode', () => {
		for (const mode of ['badToken', 'retry', undefined]) assert.throws(() => logic.questionSteps(mode), /No setup questions for mode/);
	});
});

describe('proxyRerunEnv and rerunExitCode', () => {
	it('asks for one rerun with NODE_USE_ENV_PROXY=1 when every proxy variable is http(s), without changing the input', () => {
		for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
			const env = { PATH: '/bin', [name]: 'http://proxy.example:3128' };
			assert.deepEqual(logic.proxyRerunEnv(env), { PATH: '/bin', [name]: 'http://proxy.example:3128', NODE_USE_ENV_PROXY: '1' }, name);
			assert.equal(env.NODE_USE_ENV_PROXY, undefined, name);
		}
		assert.deepEqual(logic.proxyRerunEnv({ HTTPS_PROXY: 'https://a:1', http_proxy: 'HTTP://b:2' }), { HTTPS_PROXY: 'https://a:1', http_proxy: 'HTTP://b:2', NODE_USE_ENV_PROXY: '1' });
	});

	it('asks for no rerun inside the rerun, so the wizard runs at most twice', () => {
		const rerun = logic.proxyRerunEnv({ HTTPS_PROXY: 'http://proxy.example:3128' });
		assert.equal(logic.proxyRerunEnv(rerun), null);
		assert.equal(logic.proxyRerunEnv({ HTTPS_PROXY: 'http://proxy.example:3128', NODE_USE_ENV_PROXY: '0' }), null);
	});

	it('asks for no rerun without a proxy, or with a proxy value that Node would refuse at startup', () => {
		assert.equal(logic.proxyRerunEnv({ PATH: '/bin' }), null);
		assert.equal(logic.proxyRerunEnv({ HTTPS_PROXY: '' }), null);
		assert.equal(logic.proxyRerunEnv({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' }), null);
		assert.equal(logic.proxyRerunEnv({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'proxy.example:3128' }), null);
	});

	it('exits with the status of the rerun, or 1 when it has none', () => {
		assert.equal(logic.rerunExitCode(0), 0);
		assert.equal(logic.rerunExitCode(1), 1);
		assert.equal(logic.rerunExitCode(130), 130);
		assert.equal(logic.rerunExitCode(null), 1);
		assert.equal(logic.rerunExitCode(undefined), 1);
	});
});

describe('the zone and mode steps with an injected fetch', () => {
	const ME_BODY = JSON.stringify({ authUser: { name: 'Dev User' } });

	/** Answers users/me by host (a status, or no entry for a network error) and the admin probe with one status. */
	function makeFetch({ zones, admin }) {
		const calls = [];
		const fn = async (url, options) => {
			calls.push({ url, auth: options.headers.Authorization });
			const { hostname, pathname } = new URL(url);
			if (pathname === '/api/v2/admin/sdk/apps') return { status: admin, text: async () => '{"apps":[]}' };
			const status = zones[hostname];
			if (status === undefined) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
			return { status, text: async () => (status === 200 ? ME_BODY : '{}') };
		};
		fn.calls = calls;
		return fn;
	}

	async function runSteps(fetchFn, { savedHost = null, choice } = {}) {
		const zone = logic.zoneOutcome(await detectZone(TOKEN, { fetchFn, origin: null }), savedHost);
		const host = zone.host || logic.zoneFromChoice(choice);
		return { zone, host, checked: logic.modeOutcome(await detectMode(host, TOKEN, { fetchFn, origin: null }), host, 'claude') };
	}

	it('public account: one zone found, public mode, only the team id is asked, make-zone is written', async () => {
		const fetchFn = makeFetch({ zones: { 'eu1.make.com': 401, 'eu2.make.com': 401, 'us1.make.com': 401, 'us2.make.com': 200, 'eu1.make.celonis.com': 401, 'us1.make.celonis.com': 401 }, admin: 403 });
		const { zone, host, checked } = await runSteps(fetchFn);
		assert.equal(zone.ask, undefined);
		assert.equal(host, 'us2.make.com');
		assert.equal(checked.mode, 'public');
		assert.deepEqual(logic.questionSteps(checked.mode), ['make-team-id']);
		const updates = logic.buildSecretsUpdates('claude', { makeApiKey: TOKEN, makeZone: host, teamId: '' });
		assert.equal(updates['make-zone'], 'us2.make.com');
		assert.ok(!('make-api-url' in updates));
		assert.deepEqual(
			fetchFn.calls.map((c) => c.url).sort(),
			[...ZONES.map((h) => `https://${h}/api/v2/users/me`), 'https://us2.make.com/api/v2/users/me', 'https://us2.make.com/api/v2/admin/sdk/apps?all=true&name=__mode_probe__&cols[]=name'].sort(),
		);
		for (const c of fetchFn.calls) assert.equal(c.auth, `Token ${TOKEN}`);
	});

	it('employee account: the admin API accepts the token, so the employee questions follow', async () => {
		const { host, checked } = await runSteps(makeFetch({ zones: { 'eu1.make.com': 200 }, admin: 200 }));
		assert.equal(host, 'eu1.make.com');
		assert.deepEqual(checked, { mode: 'employee', lines: ['Make employee account detected (Dev User on eu1.make.com, admin API 200).'] });
		assert.deepEqual(logic.questionSteps(checked.mode), ['imt-app-runtime-path', 'make-apps-mockup-path', 'make-team-id', 'jira-api-token']);
	});

	it('no zone accepts the token: the user chooses one from the list, and the check there stops on HTTP 401', async () => {
		const { zone, host, checked } = await runSteps(makeFetch({ zones: Object.fromEntries(ZONES.map((h) => [h, 401])), admin: 200 }), { savedHost: 'eu2.make.com', choice: '2' });
		assert.equal(zone.ask, true);
		assert.equal(zone.current, 'eu2.make.com');
		assert.equal(zone.lines[2], '  2) eu2.make.com          HTTP 401');
		assert.equal(host, 'eu2.make.com');
		assert.equal(checked.stop, true);
		assert.equal(checked.lines[0], 'Make rejected this token on eu2.make.com (HTTP 401). Nothing was written.');
	});

	it('no network: the zone step stops with retry advice and lists no zone', async () => {
		const fetchFn = makeFetch({ zones: {}, admin: 200 });
		const zone = logic.zoneOutcome(await detectZone(TOKEN, { fetchFn, origin: null }), 'us1.make.com');
		assert.deepEqual(zone, {
			stop: true,
			lines: ['Could not check the Make API token for any Make zone (every zone call failed: ENOTFOUND).', 'Nothing was changed. Retry later, and check the network, VPN or proxy.'],
		});
		assert.equal(fetchFn.calls.length, ZONES.length);
	});

	it('only the chosen zone fails on the network: the check stops with retry advice', async () => {
		const fetchFn = makeFetch({ zones: Object.fromEntries(ZONES.filter((h) => h !== 'us1.make.com').map((h) => [h, 401])), admin: 200 });
		const { zone, checked } = await runSteps(fetchFn, { choice: 'us1.make.com' });
		assert.equal(zone.ask, true);
		assert.equal(zone.lines[3], '  3) us1.make.com          ENOTFOUND');
		assert.deepEqual(checked.lines, ['Could not check the Make API token for us1.make.com (GET /users/me: ENOTFOUND).', 'Nothing was changed. Retry later, and check the network, VPN or proxy.']);
	});

	it('several zones accept the token: the user chooses, and the admin probe decides the mode there', async () => {
		const { zone, host, checked } = await runSteps(makeFetch({ zones: { 'eu1.make.com': 200, 'us1.make.com': 200 }, admin: 401 }), { choice: '3' });
		assert.equal(zone.lines[0], 'Several Make zones accepted this token. Choose the zone you sign in to:');
		assert.equal(host, 'us1.make.com');
		assert.equal(checked.mode, 'public');
	});

	it('a token without user:read (users/me 403): the list explains the 403, the admin probe still runs, and an employee keeps the employee questions', async () => {
		const zones = Object.fromEntries(ZONES.map((h) => [h, h === 'eu2.make.com' ? 403 : 401]));
		const fetchFn = makeFetch({ zones, admin: 200 });
		// Enter on the zone question returns zone.current, the saved host.
		const { zone, host, checked } = await runSteps(fetchFn, { savedHost: 'eu2.make.com', choice: 'eu2.make.com' });
		assert.equal(zone.ask, true);
		assert.equal(zone.current, 'eu2.make.com');
		assert.equal(zone.lines[zone.lines.length - 1], logic.ZONE_403_HINT);
		assert.equal(host, 'eu2.make.com');
		assert.deepEqual(checked, { mode: 'employee', lines: [`Make employee account detected (eu2.make.com, admin API 200; ${ACCOUNT_NAME_UNAVAILABLE}).`] });
		assert.deepEqual(logic.questionSteps(checked.mode), ['imt-app-runtime-path', 'make-apps-mockup-path', 'make-team-id', 'jira-api-token']);
		assert.deepEqual(fetchFn.calls.slice(-2).map((c) => c.url), ['https://eu2.make.com/api/v2/users/me', 'https://eu2.make.com/api/v2/admin/sdk/apps?all=true&name=__mode_probe__&cols[]=name']);
	});
});
