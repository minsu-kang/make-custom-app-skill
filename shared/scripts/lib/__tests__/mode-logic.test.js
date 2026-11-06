const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../mode-logic');

const HOST = 'eu1.make.com';
const TOKEN = 'MAKE_TOKEN_secret_value';
const NOW = 2_000_000_000_000;

describe('ZONES', () => {
	it('lists the six hosts of the zone detection, in order', () => {
		assert.deepEqual(logic.ZONES, ['eu1.make.com', 'eu2.make.com', 'us1.make.com', 'us2.make.com', 'eu1.make.celonis.com', 'us1.make.celonis.com']);
	});
});

describe('hostFromUrl', () => {
	it('takes the host of a Make API URL, with or without /admin', () => {
		assert.equal(logic.hostFromUrl('https://eu1.make.com/api/v2/admin'), 'eu1.make.com');
		assert.equal(logic.hostFromUrl('https://us2.make.com/api/v2'), 'us2.make.com');
		assert.equal(logic.hostFromUrl('https://US1.Make.Celonis.com/api/v2/admin/'), 'us1.make.celonis.com');
		assert.equal(logic.hostFromUrl('http://eu2.make.com'), 'eu2.make.com');
	});

	it('gives null for a URL that does not parse, another scheme, or a host off Make', () => {
		for (const url of ['not a url', '', null, undefined, 'ftp://eu1.make.com/api/v2', 'https://make.com/api/v2', 'https://evil-make.com/api/v2', 'https://eu1.make.com.evil.io/api/v2', 'https://celonis.com', 'http://127.0.0.1:8080/api/v2/admin', 'https://localhost/api/v2']) {
			assert.equal(logic.hostFromUrl(url), null, String(url));
		}
	});
});

describe('hostFromZone', () => {
	it('accepts a bare host, a host with a path, and a URL', () => {
		assert.equal(logic.hostFromZone('eu1.make.com'), 'eu1.make.com');
		assert.equal(logic.hostFromZone('  us1.make.celonis.com  '), 'us1.make.celonis.com');
		assert.equal(logic.hostFromZone('eu2.make.com/api'), 'eu2.make.com');
		assert.equal(logic.hostFromZone('https://us2.make.com/api/v2'), 'us2.make.com');
	});

	it('gives null for an empty value, a value that is not a string, or a host off Make', () => {
		for (const value of ['', '   ', null, undefined, 5, {}, 'eu1', 'localhost:8080', 'http://127.0.0.1:9/api']) assert.equal(logic.hostFromZone(value), null, String(value));
	});
});

describe('testOrigin', () => {
	it('keeps the origin of an http(s) URL on a loopback host', () => {
		assert.equal(logic.testOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
		assert.equal(logic.testOrigin('http://localhost:9/some/path?x=1'), 'http://localhost:9');
		assert.equal(logic.testOrigin('https://[::1]:8443'), 'https://[::1]:8443');
	});

	it('ignores anything else', () => {
		for (const value of [undefined, '', 'not a url', 'ftp://127.0.0.1:21', 'https://eu1.make.com', 'http://localhost.evil.io:80', 'http://127.0.0.1@evil.io/', 'http://10.0.0.1:80']) {
			assert.equal(logic.testOrigin(value), null, String(value));
		}
	});

	it('is read from MAKE_CUSTOM_APP_TEST_API_ORIGIN', () => {
		assert.equal(logic.TEST_ORIGIN_VAR, 'MAKE_CUSTOM_APP_TEST_API_ORIGIN');
	});
});

describe('API bases and URLs', () => {
	it('builds the public and admin bases of a host', () => {
		assert.equal(logic.publicBase(HOST), 'https://eu1.make.com/api/v2');
		assert.equal(logic.adminBase(HOST), 'https://eu1.make.com/api/v2/admin');
		assert.equal(logic.baseFor('public', HOST), 'https://eu1.make.com/api/v2');
		assert.equal(logic.baseFor('employee', HOST), 'https://eu1.make.com/api/v2/admin');
	});

	it('puts a test origin in place of https://{host}', () => {
		const origin = 'http://127.0.0.1:9';
		assert.equal(logic.publicBase(HOST, origin), 'http://127.0.0.1:9/api/v2');
		assert.equal(logic.baseFor('employee', HOST, origin), 'http://127.0.0.1:9/api/v2/admin');
		assert.equal(logic.meUrl(HOST, origin), 'http://127.0.0.1:9/api/v2/users/me');
		assert.equal(logic.adminProbeUrl(HOST, origin), 'http://127.0.0.1:9/api/v2/admin/sdk/apps?all=true&name=__mode_probe__&cols[]=name');
	});

	it('names the two probe calls and the token page', () => {
		assert.equal(logic.meUrl(HOST), 'https://eu1.make.com/api/v2/users/me');
		assert.equal(logic.adminProbeUrl('us1.make.celonis.com'), 'https://us1.make.celonis.com/api/v2/admin/sdk/apps?all=true&name=__mode_probe__&cols[]=name');
		assert.equal(logic.tokenPageUrl('us2.make.com'), 'https://us2.make.com/user/api');
	});

	it('has no base for a mode that is not employee or public', () => {
		for (const mode of ['retry', 'badToken', undefined]) assert.throws(() => logic.baseFor(mode, HOST), /No API base for mode/);
	});
});

describe('classifyMe', () => {
	it('200 and 403 ok (403: a valid token without user:read), 401 badToken, anything else retry', () => {
		assert.equal(logic.classifyMe({ status: 200 }), 'ok');
		assert.equal(logic.classifyMe({ status: 403 }), 'ok');
		assert.equal(logic.classifyMe({ status: 401 }), 'badToken');
		for (const result of [{ status: 404 }, { status: 429 }, { status: 500 }, { status: 204 }, { error: 'ECONNREFUSED' }, null, undefined]) {
			assert.equal(logic.classifyMe(result), 'retry', JSON.stringify(result));
		}
	});
});

describe('classifyAdmin', () => {
	it('2xx employee; 401, 403, 404 public; anything else retry', () => {
		for (const status of [200, 204, 299]) assert.equal(logic.classifyAdmin({ status }), 'employee', String(status));
		for (const status of [401, 403, 404]) assert.equal(logic.classifyAdmin({ status }), 'public', String(status));
		for (const result of [{ status: 302 }, { status: 400 }, { status: 429 }, { status: 500 }, { status: 503 }, { error: 'TimeoutError' }, null]) {
			assert.equal(logic.classifyAdmin(result), 'retry', JSON.stringify(result));
		}
	});
});

describe('verdictFrom', () => {
	it('takes the admin answer once users/me is ok', () => {
		assert.equal(logic.verdictFrom({ me: { status: 200 }, admin: { status: 200 } }), 'employee');
		assert.equal(logic.verdictFrom({ me: { status: 200 }, admin: { status: 403 } }), 'public');
		assert.equal(logic.verdictFrom({ me: { status: 200 }, admin: { status: 500 } }), 'retry');
	});

	it('takes the admin answer after a users/me 403 too, so a token without user:read is never a retry by itself', () => {
		assert.equal(logic.verdictFrom({ me: { status: 403 }, admin: { status: 200 } }), 'employee');
		assert.equal(logic.verdictFrom({ me: { status: 403 }, admin: { status: 403 } }), 'public');
		assert.equal(logic.verdictFrom({ me: { status: 403 }, admin: { status: 401 } }), 'public');
		assert.equal(logic.verdictFrom({ me: { status: 403 }, admin: { status: 500 } }), 'retry');
	});

	it('stops at users/me otherwise, whatever the admin answer', () => {
		assert.equal(logic.verdictFrom({ me: { status: 401 }, admin: { status: 200 } }), 'badToken');
		assert.equal(logic.verdictFrom({ me: { error: 'ENOTFOUND' }, admin: null }), 'retry');
		assert.equal(logic.verdictFrom(), 'retry');
	});
});

describe('cache entries', () => {
	it('keys an entry by host and token without storing the token', () => {
		const key = logic.cacheKey(HOST, TOKEN);
		assert.match(key, /^[0-9a-f]{64}$/);
		assert.equal(key, logic.cacheKey(HOST, TOKEN));
		assert.notEqual(key, logic.cacheKey('us1.make.com', TOKEN));
		assert.notEqual(key, logic.cacheKey(HOST, 'other'));
		const entry = logic.cacheEntry(HOST, TOKEN, 'public', NOW);
		assert.deepEqual(entry, { key, host: HOST, mode: 'public', checkedAt: NOW });
		assert.ok(!JSON.stringify(entry).includes(TOKEN));
		assert.equal(logic.CACHE_FILE_NAME, 'make-custom-app-mode.json');
	});

	it('counts an entry as fresh for 24 hours, for its own key and a real mode only', () => {
		const key = logic.cacheKey(HOST, TOKEN);
		const entry = logic.cacheEntry(HOST, TOKEN, 'employee', NOW);
		assert.equal(logic.isFresh(entry, key, NOW), true);
		assert.equal(logic.isFresh(entry, key, NOW + logic.CACHE_TTL_MS - 1), true);
		assert.equal(logic.isFresh(entry, key, NOW + logic.CACHE_TTL_MS), false);
		assert.equal(logic.isFresh(entry, key, NOW - 1), false);
		assert.equal(logic.isFresh(entry, logic.cacheKey(HOST, 'other'), NOW), false);
		assert.equal(logic.isFresh({ ...entry, mode: 'retry' }, key, NOW), false);
		assert.equal(logic.isFresh({ ...entry, checkedAt: String(NOW) }, key, NOW), false);
		assert.equal(logic.isFresh(null, key, NOW), false);
		assert.equal(logic.CACHE_TTL_MS, 24 * 60 * 60 * 1000);
	});
});

describe('pickZone', () => {
	it('picks the one host that answered 200', () => {
		assert.deepEqual(logic.pickZone([{ host: 'eu1.make.com', status: 401 }, { host: 'us2.make.com', status: 200 }, { host: 'us1.make.com', error: 'ETIMEDOUT' }]), { host: 'us2.make.com' });
	});

	it('asks when no host or several hosts answered 200', () => {
		const none = [{ host: 'eu1.make.com', status: 401 }, { host: 'eu2.make.com', error: 'ENOTFOUND' }];
		assert.deepEqual(logic.pickZone(none), { ask: true, results: none });
		const several = [{ host: 'eu1.make.com', status: 200 }, { host: 'eu2.make.com', status: 200 }];
		assert.deepEqual(logic.pickZone(several), { ask: true, results: several });
		assert.deepEqual(logic.pickZone([]), { ask: true, results: [] });
	});
});

describe('errorCode', () => {
	it('takes the code of the cause, else the error name', () => {
		assert.equal(logic.errorCode(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), 'ECONNREFUSED');
		assert.equal(logic.errorCode(new DOMException('timed out', 'TimeoutError')), 'TimeoutError');
		assert.equal(logic.errorCode(Object.assign(new Error('x'), { cause: {} })), 'Error');
	});

	it('never returns text that could come from the request', () => {
		assert.equal(logic.errorCode(Object.assign(new Error('x'), { cause: { code: `bad code with ${TOKEN}` } })), 'Error');
		assert.equal(logic.errorCode({ name: 'x'.repeat(41) }), 'Error');
		assert.equal(logic.errorCode(null), 'Error');
		assert.equal(logic.errorCode('boom'), 'Error');
	});
});

describe('parseBody and callSummary', () => {
	it('parses a JSON body and gives null for anything else', () => {
		assert.deepEqual(logic.parseBody('{"a":1}'), { a: 1 });
		assert.equal(logic.parseBody(''), null);
		assert.equal(logic.parseBody('<html>'), null);
	});

	it('drops the body of a call result', () => {
		assert.deepEqual(logic.callSummary({ status: 200, body: { authUser: {} } }), { status: 200 });
		assert.deepEqual(logic.callSummary({ error: 'ECONNRESET' }), { error: 'ECONNRESET' });
		assert.equal(logic.callSummary(null), null);
	});
});

describe('parseProbeOutput', () => {
	it('returns the two results of the child', () => {
		assert.deepEqual(logic.parseProbeOutput('{"me":{"status":200},"admin":{"status":403}}'), { me: { status: 200 }, admin: { status: 403 } });
		assert.deepEqual(logic.parseProbeOutput('{"me":{"status":401},"admin":null}'), { me: { status: 401 }, admin: null });
		assert.deepEqual(logic.parseProbeOutput('{"me":{"status":200,"body":{"x":1}},"admin":{"error":"TimeoutError"}}'), { me: { status: 200 }, admin: { error: 'TimeoutError' } });
	});

	it('reports NO_OUTPUT for output that is not a probe result', () => {
		const NO_OUTPUT = { me: { error: 'NO_OUTPUT' }, admin: null };
		for (const text of ['', '{"me":{"sta', 'null', '5', '{}', '{"me":{"status":"200"},"admin":null}', '{"me":{"error":"has spaces in it"},"admin":null}', '{"me":{"status":200}}', '{"me":{"status":200},"admin":{}}']) {
			assert.deepEqual(logic.parseProbeOutput(text), NO_OUTPUT, text);
		}
	});
});

describe('retryDetail', () => {
	it('names the call that failed and how', () => {
		assert.equal(logic.retryDetail({ me: { error: 'ECONNREFUSED' }, admin: null }), 'GET /users/me: ECONNREFUSED');
		assert.equal(logic.retryDetail({ me: { status: 503 }, admin: null }), 'GET /users/me: HTTP 503');
		assert.equal(logic.retryDetail({ me: null, admin: null }), 'GET /users/me: no answer');
		assert.equal(logic.retryDetail({ me: { status: 200 }, admin: { status: 500 } }), 'admin API probe: HTTP 500');
		assert.equal(logic.retryDetail({ me: { status: 200 }, admin: { error: 'TimeoutError' } }), 'admin API probe: TimeoutError');
		assert.equal(logic.retryDetail({ me: { status: 200 }, admin: null }), 'admin API probe: no answer');
		assert.equal(logic.retryDetail(), 'GET /users/me: no answer');
	});

	it('names the admin probe after a users/me 403, never users/me', () => {
		assert.equal(logic.retryDetail({ me: { status: 403 }, admin: { status: 500 } }), 'admin API probe: HTTP 500');
		assert.equal(logic.retryDetail({ me: { status: 403 }, admin: null }), 'admin API probe: no answer');
	});
});

describe('messages', () => {
	it('badTokenMessage: the token page of the host, and the wizard for Claude Code', () => {
		const text = logic.badTokenMessage('us1.make.com', { editor: 'claude', setupCommand: 'node "/p/setup-secrets.js" --editor claude' });
		assert.deepEqual(text.split('\n'), [
			'Make rejected the saved API token for us1.make.com (HTTP 401).',
			'Create a new token at https://us1.make.com/user/api, then save it in your own terminal (the agent must not run this):',
			'  node "/p/setup-secrets.js" --editor claude',
		]);
	});

	it('badTokenMessage: the Make Apps SDK environment for Cursor', () => {
		assert.deepEqual(logic.badTokenMessage(HOST, { editor: 'cursor', setupCommand: 'unused' }).split('\n'), [
			'Make rejected the saved API token for eu1.make.com (HTTP 401).',
			'Create a new token at https://eu1.make.com/user/api and put it in the active Make Apps SDK environment in Cursor.',
		]);
	});

	it('retryMessage and employeeOnlyMessage', () => {
		assert.deepEqual(logic.retryMessage(HOST, 'GET /users/me: ECONNREFUSED').split('\n'), [
			'Could not check the Make API token for eu1.make.com (GET /users/me: ECONNREFUSED).',
			'Nothing was changed. Retry later, and check the network, VPN or proxy.',
		]);
		assert.deepEqual(logic.employeeOnlyMessage('test-component.js').split('\n'), [
			'test-component.js is for Make employees only, and this Make API token is in public mode (the Make admin API refused it).',
			'Do not retry it. Tell the user that no component test ran here. Test an RPC or an Endpoint with run-component.js, and a module in a test scenario.',
		]);
	});

	it('employeeOnlyMessage: one instruction per script, and a default for any other', () => {
		const instead = {
			'post-review-transition.js': 'There is no ticket flow in public mode. Skip this step and go on with the close-out.',
			'download-jira-ticket-attachment.js': 'There is no ticket flow in public mode. Ask the user to drop the screenshots or logs into the chat or to give local file paths, and read them directly.',
			'commit-changes.js compile': 'Compiling is not a step for the owner of an app: a push to an app that is not approved is live at once. Do not offer it again.',
			'commit-changes.js --issue': 'There is no ticket flow in public mode. Run the same command without --issue.',
			'foo.js': 'Tell the user that this step needs a Make employee account, and go on without it.',
		};
		for (const [what, text] of Object.entries(instead)) {
			assert.deepEqual(
				logic.employeeOnlyMessage(what).split('\n'),
				[`${what} is for Make employees only, and this Make API token is in public mode (the Make admin API refused it).`, `Do not retry it. ${text}`],
				what,
			);
		}
		assert.deepEqual(Object.keys(logic.EMPLOYEE_ONLY_INSTEAD), ['test-component.js', 'post-review-transition.js', 'download-jira-ticket-attachment.js', 'commit-changes.js compile', 'commit-changes.js --issue']);
		assert.equal(logic.EMPLOYEE_ONLY_DEFAULT, instead['foo.js']);
		assert.equal(logic.employeeOnlyMessage('toString').split('\n')[1], `Do not retry it. ${logic.EMPLOYEE_ONLY_DEFAULT}`);
	});

	it('cursorAdminWarning: one line when the Cursor admin flag disagrees with the probe', () => {
		assert.match(logic.cursorAdminWarning({ cursorAdmin: true, mode: 'public' }), /^WARNING: the active Cursor environment has "admin": true, but the Make admin API refused this token/);
		assert.match(logic.cursorAdminWarning({ cursorAdmin: false, mode: 'employee' }), /^WARNING: the active Cursor environment has no "admin": true, but this token can use the Make admin API/);
		for (const row of [{ cursorAdmin: true, mode: 'employee' }, { cursorAdmin: false, mode: 'public' }, { cursorAdmin: null, mode: 'public' }, { cursorAdmin: null, mode: 'employee' }]) {
			assert.equal(logic.cursorAdminWarning(row), null, JSON.stringify(row));
		}
	});
});

describe('accountName', () => {
	it('takes the name of authUser, else its email', () => {
		assert.equal(logic.accountName({ status: 200, body: { authUser: { name: ' Dev User ', email: 'dev@example.org' } } }), 'Dev User');
		assert.equal(logic.accountName({ status: 200, body: { authUser: { name: ' ', email: ' dev@example.org ' } } }), 'dev@example.org');
	});

	it('gives null when users/me has no usable account', () => {
		for (const me of [null, { error: 'ECONNREFUSED' }, { status: 200, body: null }, { status: 200, body: {} }, { status: 200, body: { authUser: { name: 5 } } }]) {
			assert.equal(logic.accountName(me), null, JSON.stringify(me));
		}
	});
});

describe('accountLabel', () => {
	it('shows the name of a 200 on one line, else its email', () => {
		assert.equal(logic.accountLabel({ status: 200, body: { authUser: { name: ' Dev\n  User ', email: 'dev@example.org' } } }), 'Dev User');
		assert.equal(logic.accountLabel({ status: 200, body: { authUser: { name: '', email: 'dev@example.org' } } }), 'dev@example.org');
	});

	it('says why there is no name when users/me answers 403', () => {
		assert.equal(logic.ACCOUNT_NAME_UNAVAILABLE, 'account name unavailable: the token lacks the user:read scope');
		assert.equal(logic.accountLabel({ status: 403, body: { message: 'Forbidden' } }), logic.ACCOUNT_NAME_UNAVAILABLE);
		assert.equal(logic.accountLabel({ status: 403 }), logic.ACCOUNT_NAME_UNAVAILABLE);
	});

	it('gives null for a 200 without an account (a probe result has no body) and for any other answer', () => {
		for (const me of [{ status: 200 }, { status: 200, body: {} }, { status: 401, body: { authUser: { name: 'X' } } }, { error: 'ECONNREFUSED' }, null, undefined]) {
			assert.equal(logic.accountLabel(me), null, JSON.stringify(me));
		}
	});
});

describe('token scopes', () => {
	it('lists the scopes every token needs, user:read included, and no admin scope', () => {
		assert.deepEqual(logic.TOKEN_SCOPES, ['sdk-apps:read', 'sdk-apps:write', 'user:read']);
		assert.deepEqual(logic.RUN_COMPONENT_SCOPES, {
			everyRun: ['imt-forms:read'],
			endpoints: ['teams:read', 'organizations:read'],
			connection: ['connections:read'],
			optional: ['endpoints:run', 'credential-requests:write'],
		});
		assert.doesNotMatch(JSON.stringify([logic.TOKEN_SCOPES, logic.RUN_COMPONENT_SCOPES]), /admin/);
	});

	it('formats a scope list and the run-component.js scopes as one line each', () => {
		assert.equal(logic.formatScopes(logic.TOKEN_SCOPES), 'sdk-apps:read sdk-apps:write user:read');
		assert.equal(
			logic.runComponentScopesText(),
			'teams:read organizations:read imt-forms:read, plus connections:read for components with a connection; optional: endpoints:run credential-requests:write',
		);
	});

	it('covers every scope that run-component.js checks', () => {
		const rc = require('../run-component-logic');
		const { everyRun, endpoints, connection, optional } = logic.RUN_COMPONENT_SCOPES;
		const granted = [...logic.TOKEN_SCOPES, ...everyRun, ...endpoints, ...connection];
		for (const kind of ['endpoint', 'rpc']) {
			for (const needsConnection of [false, true]) assert.deepEqual(rc.missingScopes(granted, rc.requiredKeyScopes({ kind, needsConnection })), [], `${kind} ${needsConnection}`);
		}
		assert.deepEqual(rc.missingScopes(granted, rc.CONNECTION_SCOPES), []);
		assert.equal(rc.chooseEndpointTransport(optional), 'v1');
		assert.equal(rc.canRequestCredentials(optional), true);
	});
});

describe('originHostOf and originStop', () => {
	it('takes the host part of an app origin', () => {
		assert.equal(logic.originHostOf('eu1.make.com'), 'eu1.make.com');
		assert.equal(logic.originHostOf('US1.make.com/api'), 'us1.make.com');
		for (const v of [undefined, null, '', 5, {}]) assert.equal(logic.originHostOf(v), null, JSON.stringify(v));
	});

	it('lets the script go on without an origin or when the app lives on the token host, in both modes', () => {
		for (const mode of ['employee', 'public']) {
			for (const origin of [undefined, null, '', 'eu1.make.com', 'EU1.make.com/api/v2']) assert.equal(logic.originStop({ mode, host: HOST, origin }), null, `${mode} ${origin}`);
		}
	});

	it('lets employee mode switch to the origin host, as before', () => {
		for (const origin of ['us1.make.com', 'us1.make.com/api']) assert.equal(logic.originStop({ mode: 'employee', host: HOST, origin }), null, origin);
	});

	it('stops public mode when the app lives in another zone: reason, fix and message', () => {
		const fix = 'To work on this app, set up a Make API token of us1.make.com (create it at https://us1.make.com/user/api).';
		for (const origin of ['us1.make.com', 'US1.make.com/some/path']) {
			assert.deepEqual(logic.originStop({ mode: 'public', host: HOST, origin }), {
				originHost: 'us1.make.com',
				reason: 'the app lives in us1.make.com, the token is for eu1.make.com',
				fix,
				message: `The app lives in us1.make.com, the token is for eu1.make.com.\n${fix}`,
			}, origin);
		}
	});
});

describe('scriptNameOf', () => {
	it('names the entry script by its file name', () => {
		assert.equal(logic.scriptNameOf('/plugin/shared/scripts/test-component.js'), 'test-component.js');
		assert.equal(logic.scriptNameOf(undefined), 'this script');
		assert.equal(logic.scriptNameOf(''), 'this script');
	});
});
