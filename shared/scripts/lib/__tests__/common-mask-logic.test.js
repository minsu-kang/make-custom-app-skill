const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../common-mask-logic');

const SECRETS = ['SECRET_A', 'SECRET_B', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', '{{common.token}}'];

describe('maskCommon', () => {
	it('masks every non-empty string and every number, keeps booleans, null, empty values, key order and nesting', () => {
		const text = JSON.stringify({ clientSecret: SECRETS[0], request: { key: SECRETS[2], timeout: 30, sandbox: true }, scopes: [SECRETS[1], ''], empty: {}, list: [], none: null, iml: SECRETS[3] });
		const r = m.maskCommon(text);
		assert.equal(r.count, 5);
		assert.deepEqual(r.paths, ['clientSecret', 'request.key', 'request.timeout', 'scopes[0]', 'iml']);
		assert.deepEqual(Object.keys(JSON.parse(r.text)), ['clientSecret', 'request', 'scopes', 'empty', 'list', 'none', 'iml']);
		assert.deepEqual(JSON.parse(r.text), {
			clientSecret: m.MARKER_STRING,
			request: { key: m.MARKER_STRING, timeout: m.MARKER_NUMBER, sandbox: true },
			scopes: [m.MARKER_STRING, ''],
			empty: {},
			list: [],
			none: null,
			iml: m.MARKER_STRING,
		});
		assert.ok(r.text.endsWith('}\n') && r.text.includes('\n\t"clientSecret"'));
		for (const s of SECRETS) assert.ok(!r.text.includes(s));
	});

	it('masks numbers above 2^53 and keeps a __proto__ key as data, without touching the prototype', () => {
		const r = m.maskCommon('{"big": 123456789012345678901234567890, "__proto__": {"polluted": "yes"}, "constructor": "x"}');
		const out = JSON.parse(r.text);
		assert.equal(out.big, m.MARKER_NUMBER);
		assert.ok(Object.hasOwn(out, '__proto__'));
		assert.equal({}.polluted, undefined);
		assert.ok(!r.text.includes('123456789'));
	});

	it('reads a BOM and gives the errors for text that is not JSON or not an object', () => {
		assert.equal(m.maskCommon('\uFEFF{"a":"x"}').count, 1);
		assert.deepEqual(m.maskCommon('{ nope'), { error: 'not valid JSON' });
		for (const text of ['[1]', '"x"', '7', 'null']) assert.deepEqual(m.maskCommon(text), { error: 'not a JSON object' });
	});

	it('gives an empty object 0 values', () => {
		assert.deepEqual(m.maskCommon('{}'), { text: '{}\n', count: 0, paths: [] });
	});
});

describe('markers', () => {
	it('hasMarker finds a marker in raw text, also in JSONC and next to edits', () => {
		assert.equal(m.hasMarker('{ // note\n "a": "***MASKED:string***" }'), true);
		assert.equal(m.hasMarker('{"a": "***MASKED:number***x"}'), true);
		assert.equal(m.hasMarker('{"a": "***MASKED"}'), false);
		assert.equal(m.markerCount('"***MASKED:string***" "***MASKED:number***"'), 2);
		assert.equal(m.markerCount('{"a":"x"}'), 0);
	});

	it('markerPaths lists the paths of values that hold a marker, and nothing for text that does not parse', () => {
		assert.deepEqual(m.markerPaths('{"a":"***MASKED:string***","b":{"c":["ok","***MASKED:number***"]}}'), ['a', 'b.c[1]']);
		assert.deepEqual(m.markerPaths('{ // jsonc\n "a": "***MASKED:string***" }'), []);
	});

	it('markerPaths skips numbers, booleans and null, and reads a BOM', () => {
		assert.deepEqual(m.markerPaths('\uFEFF{"n":5,"t":true,"z":null,"s":"x ***MASKED:string***"}'), ['s']);
		assert.deepEqual(m.markerPaths('{"***MASKED:string***":1}'), []);
	});

	it('the description marker names neither real type', () => {
		assert.equal(m.MARKER_DESCRIPTION, '***MASKED:<type>***');
		assert.equal(m.hasMarker(m.MARKER_DESCRIPTION), false);
	});
});

describe('paths', () => {
	it('knows the two common files and the two common component paths', () => {
		assert.equal(m.isCommonFile('common.imljson'), true);
		assert.equal(m.isCommonFile('connections/my-conn/common.imljson'), true);
		assert.equal(m.isCommonFile('connections/my-conn/api.imljson'), false);
		assert.equal(m.isCommonFile('modules/x/common.imljson'), false);
		assert.equal(m.isCommonComponentPath('common'), true);
		assert.equal(m.isCommonComponentPath('connection/my-conn/common'), true);
		assert.equal(m.isCommonComponentPath('connection/my-conn/api'), false);
		assert.equal(m.commonFileOf('common'), 'common.imljson');
		assert.equal(m.commonFileOf('connection/my-conn/common'), 'connections/my-conn/common.imljson');
	});

	it('reads a Windows separator in a file path', () => {
		assert.equal(m.isCommonFile('connections\\my-conn\\common.imljson'), true);
	});

	it('accepts a component path of letters, digits, _ and - parts, and stops one with an empty, . or .. part', () => {
		for (const p of ['common', 'base', 'module/listItems/api', 'connection/my-conn/common', 'endpoint/getDocument/input_parameters', 'common/x']) assert.equal(m.componentPathError(p), null, p);
		for (const p of ['module/../common', 'rpc/../common', 'function/../common', 'connection/x/../common', 'module//api', 'common/', '.', 'module/a.b/api', 'module/a b/api', '']) {
			assert.equal(m.componentPathError(p), `ERROR: the component path "${p}" may hold only letters, digits, _ and - between its slashes, and no empty part.`, p);
		}
	});

	it('accepts a type and a name of letters, digits, _ and -, and stops one with a slash, a dot or an empty value, type first', () => {
		for (const [type, name] of [['module', 'listItems'], ['endpoint', 'get_document-2'], ['widget', 'm']]) assert.equal(m.componentNameError(type, name), null, `${type} ${name}`);
		for (const name of ['listFiles/connections', 'm/public', '../common', 'a/../b', '..', '.', 'a.b', 'a/', '', 'a b', 'a\n']) {
			assert.equal(m.componentNameError('module', name), `ERROR: the component name "${name}" may hold only letters, digits, _ and -.`, name);
		}
		for (const type of ['module/x', 'wid.get', '', 'module/']) assert.equal(m.componentNameError(type, 'a/b'), `ERROR: the component type "${type}" may hold only letters, digits, _ and -.`, type);
	});

	it('counts every component path that update-app.js sends to a common route, and no other', () => {
		for (const p of ['common/', 'common/x', 'connection/my-conn/common/x']) assert.equal(m.isCommonComponentPath(p), true, p);
		for (const p of ['connection/common', 'module/common/api', 'commons', 'base', '']) assert.equal(m.isCommonComponentPath(p), false, p);
		assert.equal(m.commonFileOf('common/x'), 'common.imljson');
		assert.equal(m.commonFileOf('connection/my-conn/common/x'), 'connections/my-conn/common.imljson');
	});
});

describe('the refusal', () => {
	it('gives the four lines of spec 3.2 with the count and the paths', () => {
		const text = m.refusalMessage({ file: 'common.imljson', slug: 'my-app', version: '1', count: 3, paths: ['clientSecret', 'request.key', 'scopes[0]'] });
		assert.deepEqual(text.split('\n'), [
			'Refused: common.imljson of my-app v1 still holds 3 masked values (clientSecret, request.key, scopes[0]).',
			'In public mode download-app.js masks every string and number in common data, so a real value never reaches this computer.',
			'Pushing the file would replace the real values in Make with the marker text, and Make keeps no history of common data.',
			"Nothing was sent. To change common data, edit it in the Make UI (the Common data section on the app's Base page or on the connection's Communication page). Do not paste secret values into the chat.",
		]);
	});

	it('leaves the parenthesis out without paths and says "value" for one', () => {
		const line = m.refusalMessage({ file: 'connections/c/common.imljson', slug: 'my-app', version: '1', count: 1, paths: [] }).split('\n')[0];
		assert.equal(line, 'Refused: connections/c/common.imljson of my-app v1 still holds 1 masked value.');
		assert.equal(m.refusalMessage({ file: 'common.imljson', slug: 'my-app', version: '1', count: 2 }).split('\n')[0], 'Refused: common.imljson of my-app v1 still holds 2 masked values.');
	});

	it('names the Make UI place right after "the Make UI", and none when a caller passes an empty one', () => {
		assert.equal(m.COMMON_UI_PLACE, "the Common data section on the app's Base page or on the connection's Communication page");
		const bare = m.refusalMessage({ file: 'common.imljson', slug: 'my-app', version: '1', count: 1, paths: [], place: '' }).split('\n')[3];
		assert.equal(bare, 'Nothing was sent. To change common data, edit it in the Make UI. Do not paste secret values into the chat.');
		const line = m.refusalMessage({ file: 'common.imljson', slug: 'my-app', version: '1', count: 1, paths: [], place: 'Common data tab' }).split('\n')[3];
		assert.equal(line, 'Nothing was sent. To change common data, edit it in the Make UI (Common data tab). Do not paste secret values into the chat.');
	});

	it('commonRefusal counts the values its list names, and the raw markers only when it can list none', () => {
		const firstLine = (text) => m.commonRefusal(text, { componentPath: 'common', slug: 's', version: '1' }).split('\n')[0];
		assert.equal(firstLine('{"a":"***MASKED:string*** ***MASKED:number***","b":"***MASKED:string***"}'), 'Refused: common.imljson of s v1 still holds 2 masked values (a, b).');
		assert.equal(firstLine('{ // note\n "a": "***MASKED:string***", "b": "***MASKED:number***" }'), 'Refused: common.imljson of s v1 still holds 2 masked values.');
		assert.equal(firstLine('{"***MASKED:string***": 1}'), 'Refused: common.imljson of s v1 still holds 1 masked value.');
	});

	it('commonRefusal also refuses a marker that only the JSON escapes hide', () => {
		const escaped = '{"a":"\\u002a\\u002a\\u002aMASKED:string\\u002a\\u002a\\u002a"}';
		assert.equal(m.hasMarker(escaped), false);
		assert.deepEqual(m.markerPaths(escaped), ['a']);
		assert.equal(m.commonRefusal(escaped, { componentPath: 'common', slug: 's', version: '1' }).split('\n')[0], 'Refused: common.imljson of s v1 still holds 1 masked value (a).');
	});

	it('commonRefusal is null for a clean file and the message for a masked one', () => {
		assert.equal(m.commonRefusal('{"a":"x"}', { componentPath: 'common', slug: 's', version: '1' }), null);
		assert.match(m.commonRefusal('{"a":"***MASKED:string***"}', { componentPath: 'connection/c/common', slug: 's', version: '1' }), /^Refused: connections\/c\/common\.imljson of s v1 still holds 1 masked value \(a\)\./);
	});
});
