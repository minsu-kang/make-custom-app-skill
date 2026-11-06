/**
 * Tests for test-function-logic.js (spec 3.1): the engine table, the arguments, the runner in both engines (namespace
 * order, globals, blocked and templates-only classification, not-found names), the header and tail lines and the
 * exit codes. Every case runs in process; the shim comes from iml-shim.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const nodeAssert = require('assert');
const t = require('../test-function-logic');
const { createImlShim, TEMPLATE_ONLY } = require('../iml-shim');

const SECRETS = '/home/u/.make-custom-app-skill-secrets';
const PATH_MISSING = `IML: imt-app-runtime-path is not set, so the plugin's shim is used. Set it in ${SECRETS} to test against the runtime.`;
const PATH_NOT_LOADED = "IML: imt-app-runtime-path is set but the runtime did not load, so the plugin's shim is used.";
const EMPLOYEE_RUNTIME = "ERROR: --engine=runtime needs a runtime that loads from imt-app-runtime-path. Run the command without --engine to use the plugin's shim.";
const PUBLIC_RUNTIME = "ERROR: --engine=runtime is for Make employees only. Run the command without --engine to use the plugin's shim.";
const PARSE_JSON_HINT = 'iml.parseJSON is not a function. parseJSON exists only in IML templates ({{...}}), not in custom function code: use JSON.parse.';
const ENGINE = 'Engine: shim. A pass here is a local check; the final check is a scenario run in Make.';
const SHIM = "IML: the plugin's built-in shim (83 functions, written from the public Make docs). It is not the Make engine.";
const FUNCTIONS_DIR = '/Users/me/.make-custom-app/contexts/my-app-v1/functions';
const SEPARATOR = '════════════════════════════════════════';

describe('chooseEngine (spec 3.1 Engine choice)', () => {
	const choose = (o) => t.chooseEngine({ secretsPath: SECRETS, runtimePathSet: false, runtimeLoaded: false, engineFlag: null, ...o });
	it('employee with a runtime that loads uses it, with no flag or with --engine=runtime', () => {
		assert.deepEqual(choose({ mode: 'employee', runtimePathSet: true, runtimeLoaded: true }), { engine: 'runtime', line: null, error: null });
		assert.deepEqual(choose({ mode: 'employee', engineFlag: 'runtime', runtimePathSet: true, runtimeLoaded: true }), { engine: 'runtime', line: null, error: null });
	});

	it('employee without a flag falls back to the shim with one line', () => {
		assert.deepEqual(choose({ mode: 'employee' }), { engine: 'shim', line: PATH_MISSING, error: null });
		assert.deepEqual(choose({ mode: 'employee', runtimePathSet: true }), { engine: 'shim', line: PATH_NOT_LOADED, error: null });
	});

	it('employee with --engine=runtime and no runtime stops', () => {
		assert.deepEqual(choose({ mode: 'employee', engineFlag: 'runtime' }), { engine: null, line: null, error: EMPLOYEE_RUNTIME });
		assert.deepEqual(choose({ mode: 'employee', engineFlag: 'runtime', runtimePathSet: true }), { engine: null, line: null, error: EMPLOYEE_RUNTIME });
	});

	it('public uses the shim, refuses --engine=runtime, and --engine=shim wins everywhere', () => {
		assert.deepEqual(choose({ mode: 'public', runtimePathSet: true, runtimeLoaded: true }), { engine: 'shim', line: null, error: null });
		assert.deepEqual(choose({ mode: 'public', engineFlag: 'runtime' }), { engine: null, line: null, error: PUBLIC_RUNTIME });
		assert.deepEqual(choose({ mode: 'public', engineFlag: 'shim' }), { engine: 'shim', line: null, error: null });
		assert.deepEqual(choose({ mode: 'employee', engineFlag: 'shim', runtimePathSet: true, runtimeLoaded: true }), { engine: 'shim', line: null, error: null });
		assert.deepEqual(choose({ mode: 'employee', engineFlag: 'shim' }), { engine: 'shim', line: null, error: null });
	});
});

describe('parseArgs', () => {
	it('reads names, --tz and --engine, and ignores other flags as today', () => {
		assert.deepEqual(t.parseArgs(['my-app', '1', 'a', 'b', '--tz=Europe/Prague', '--engine=shim', '--x']), { slug: 'my-app', version: '1', names: ['a', 'b'], tz: 'Europe/Prague', engine: 'shim', error: null });
		assert.equal(t.parseArgs(['my-app', '1']).tz, 'UTC');
		assert.equal(t.parseArgs(['my-app', '1', '--engine=other']).error, 'ERROR: --engine must be shim or runtime.');
	});

	it('gives no engine without the flag, takes runtime, and leaves slug and version out when missing', () => {
		assert.deepEqual(t.parseArgs(['my-app', '1']), { slug: 'my-app', version: '1', names: [], tz: 'UTC', engine: null, error: null });
		assert.equal(t.parseArgs(['my-app', '1', '--engine=runtime']).engine, 'runtime');
		assert.deepEqual(t.parseArgs(['--engine=']), { slug: undefined, version: undefined, names: [], tz: 'UTC', engine: null, error: 'ERROR: --engine must be shim or runtime.' });
		assert.deepEqual(t.ENGINES, ['shim', 'runtime']);
	});

	it('takes the value of --engine and --tz after a space, keeps the first of each, and refuses a bare --engine', () => {
		assert.deepEqual(t.parseArgs(['my-app', '1', '--engine', 'shim', 'a', '--tz', 'Europe/Prague']), { slug: 'my-app', version: '1', names: ['a'], tz: 'Europe/Prague', engine: 'shim', error: null });
		assert.equal(t.parseArgs(['my-app', '1', '--engine', 'runtime']).engine, 'runtime');
		assert.deepEqual(t.parseArgs(['my-app', '1', '--engine', 'other']).error, 'ERROR: --engine must be shim or runtime.');
		assert.deepEqual(t.parseArgs(['my-app', '1', '--engine']), { slug: 'my-app', version: '1', names: [], tz: 'UTC', engine: null, error: 'ERROR: --engine must be shim or runtime.' });
		assert.equal(t.parseArgs(['my-app', '1', '--engine', '--tz=Asia/Tokyo']).error, 'ERROR: --engine must be shim or runtime.');
		assert.equal(t.parseArgs(['my-app', '1', '--engine', '--tz=Asia/Tokyo']).tz, 'Asia/Tokyo');
		assert.deepEqual(t.parseArgs(['my-app', '1', '--tz']), { slug: 'my-app', version: '1', names: [], tz: 'UTC', engine: null, error: null });
		assert.equal(t.parseArgs(['my-app', '1', '--tz=Asia/Tokyo', '--tz', 'Europe/Prague']).tz, 'Asia/Tokyo');
		assert.deepEqual(t.parseArgs(['my-app', '1', '--engine=shim', 'a']).names, ['a']);
	});
});

describe('runSuite in shim mode', () => {
	function run(code, testCode, { names = [], fnName = 'buildToken' } = {}) {
		const gaps = [];
		const lines = [];
		const shim = createImlShim({ onGap: (fn, detail) => gaps.push({ fn, detail }) });
		const result = t.runSuite({ functions: { [fnName]: { code, testCode, hasTest: true } }, targetNames: names, engine: 'shim', builtins: shim, environment: { timezone: 'UTC' }, common: { a: '***MASKED:string***' }, assert: nodeAssert, print: (l) => lines.push(l), gaps });
		return { result, lines };
	}

	it('passes, blocks a gap even when the test catches it, and hints at a template-only call', () => {
		const code = 'function buildToken(x) { return iml.upper(x); }';
		const test = [
			"it('signs the claims', () => assert.equal(buildToken('a'), 'A'));",
			"it('adds the key id', () => assert.throws(() => iml.generateJwtWithKeyId({})));",
			"it('parses the response', () => iml.parseJSON('{}'));",
		].join('\n');
		const { result, lines } = run(code, test);
		assert.deepEqual([result.passed, result.failed, result.blocked, result.total], [1, 1, 1, 3]);
		assert.deepEqual(result.blockedFns, ['generateJwtWithKeyId']);
		assert.ok(lines.includes('  ⊘ adds the key id'));
		assert.ok(lines.includes(`          ${t.blockedLine({ fn: 'generateJwtWithKeyId', detail: '' })}`));
		assert.ok(lines.includes(`          ${PARSE_JSON_HINT}`));
		assert.deepEqual(result.errors, [{ function: 'buildToken', test: 'parses the response', error: PARSE_JSON_HINT }]);
		assert.equal(t.exitCode(result), 1);
	});

	it('prints the run in the order of the spec sample', () => {
		const test = "it('signs the claims', () => {});\nit('adds the key id', () => iml.generateJwtWithKeyId({}));\nit('parses the response', () => iml.parseJSON('{}'));";
		const { lines } = run('function buildToken() {}', test);
		assert.deepEqual(lines, [
			'Functions: 1 loaded',
			'  → buildToken',
			'\n━━━ buildToken ━━━',
			'  ✓ signs the claims',
			'  ⊘ adds the key id',
			`          ${t.blockedLine({ fn: 'generateJwtWithKeyId', detail: '' })}`,
			'  ✗ parses the response',
			`          ${PARSE_JSON_HINT}`,
		]);
	});

	it('blocks a test that hit a gap and then failed an assertion, and names each gap function once', () => {
		const test = [
			"it('two gaps', () => { try { iml.dateDiff(); } catch {} try { iml.toDataStructure(); } catch {} assert.equal(1, 2); });",
			"it('one again', () => iml.dateDiff());",
			"it('formats with zz', () => iml.formatDate(new Date(0), 'zz'));",
		].join('\n');
		const { result, lines } = run('function buildToken() {}', test);
		assert.deepEqual([result.blocked, result.failed, result.total], [3, 0, 3]);
		assert.deepEqual(result.blockedFns, ['dateDiff', 'toDataStructure', 'formatDate']);
		assert.ok(lines.includes(`          ${t.blockedLine({ fn: 'dateDiff', detail: '' })}`));
		assert.ok(lines.includes('          blocked: iml.formatDate with the token "zz" is not in the plugin\'s shim, so this test cannot run here. Check it in a scenario run.'));
		assert.equal(t.exitCode(result), 2);
	});

	it('hides require, process, timers and fetch, and gives common, Buffer and environment', () => {
		const test = "it('sees the globals', () => { assert.equal(typeof require, 'undefined'); assert.equal(typeof process, 'undefined'); assert.equal(typeof setTimeout, 'undefined'); assert.equal(typeof fetch, 'undefined'); assert.equal(common.a, '***MASKED:string***'); assert.ok(Buffer.isBuffer(Buffer.from('x'))); assert.equal(environment.timezone, 'UTC'); });";
		assert.equal(run('function buildToken() { return typeof require; }', test).result.passed, 1);
	});

	it('gives the same globals to function code called through iml', () => {
		const code = 'function buildToken() { return [typeof require, typeof process, typeof setInterval, typeof setImmediate, typeof fetch, common.a, Buffer.from("x").length, environment.timezone, this.timezone].join(","); }';
		const test = "it('reads them', () => assert.equal(iml.buildToken(), 'undefined,undefined,undefined,undefined,undefined,***MASKED:string***,1,UTC,UTC'));";
		assert.equal(run(code, test).result.passed, 1);
	});

	it('lets test.js declare its own const or let for a name the shim adds, as runtime mode does', () => {
		const code = 'function buildToken() { return [common.a, typeof Buffer, fetch].join(","); }';
		const test = [
			"const common = { a: 'own' };",
			'let Buffer = 1;',
			"const require = 'r', process = 'p', setTimeout = 1, setInterval = 2, setImmediate = 3, fetch = 'f';",
			"it('the function in test.js reads the file values', () => assert.equal(buildToken(), 'own,number,f'));",
			"it('the function through iml keeps the shim values', () => assert.equal(iml.buildToken(), '***MASKED:string***,function,'));",
		].join('\n');
		const { result } = run(code, test);
		assert.deepEqual([result.passed, result.failed, result.errors], [2, 0, []]);
		const own = run('function buildToken() {}', 'const assert = 1;');
		assert.equal(own.result.errors[0].test, '(parse)');
		assert.match(own.result.errors[0].error, /'assert' has already been declared/);
	});

	it('runs the tests inside describe and gives a no-op debug to tests and function code', () => {
		const code = 'function buildToken() { debug("from code"); return 1; }';
		const test = "describe('suite', () => { it('inside', () => { debug('from test'); assert.equal(iml.buildToken(), 1); }); });";
		const { result, lines } = run(code, test);
		assert.equal(result.passed, 1);
		assert.ok(lines.includes('  ✓ inside'));
	});

	it('lets an app function replace a built-in of the same name, as in Make', () => {
		const { result } = run('function upper(x) { return "mine"; }', "it('uses the app function', () => assert.equal(iml.upper('a'), 'mine'));", { fnName: 'upper' });
		assert.equal(result.passed, 1);
	});

	it('keeps templates-only and unknown names undefined on a null-prototype namespace', () => {
		const test = "it('looks them up', () => { assert.equal(iml.parseJSON, undefined); assert.equal(iml.nothing, undefined); assert.equal(iml.constructor, undefined); assert.equal(typeof iml.toString, 'function'); });";
		assert.equal(run('function buildToken() {}', test).result.passed, 1);
	});

	it('exits 2 when none failed and one was blocked, and 1 for a missing named function', () => {
		assert.equal(t.exitCode({ failed: 0, blocked: 1, notFound: [] }), 2);
		assert.equal(t.exitCode({ failed: 0, blocked: 0, notFound: [] }), 0);
		assert.equal(t.exitCode({ failed: 0, blocked: 3, notFound: ['x'] }), 1);
		assert.equal(t.exitCode({ failed: 1, blocked: 1, notFound: [] }), 1);
		const { result, lines } = run('function buildToken() {}', "it('x', () => {});", { names: ['missing'] });
		assert.deepEqual(result.notFound, ['missing']);
		assert.equal(result.total, 0);
		assert.ok(lines.includes('\n⚠ Function "missing" not found. Available: buildToken'));
	});

	it('runs a named function that exists and leaves the others out', () => {
		const lines = [];
		const shim = createImlShim();
		const functions = { a: { code: 'function a() {}', testCode: "it('a', () => {});", hasTest: true }, b: { code: 'function b() {}', testCode: "it('b', () => {});", hasTest: true } };
		const result = t.runSuite({ functions, targetNames: ['b', 'c'], engine: 'shim', builtins: shim, environment: { timezone: 'UTC' }, common: {}, assert: nodeAssert, print: (l) => lines.push(l), gaps: [] });
		assert.deepEqual([result.passed, result.total, result.notFound], [1, 1, ['c']]);
		assert.ok(lines.includes('  ✓ b') && !lines.includes('  ✓ a'));
		assert.ok(lines.includes('  → a, b'));
	});

	it('blocks the whole file as (load) when its top level hits a gap', () => {
		const { result, lines } = run('function buildToken() {}', "iml.dateDiff(new Date(), new Date(), 'D');\nit('never runs', () => {});");
		assert.deepEqual([result.blocked, result.total, result.passed], [1, 1, 0]);
		assert.deepEqual(result.blockedFns, ['dateDiff']);
		assert.ok(lines.includes('  ⊘ (load)'));
		assert.ok(lines.includes(`          ${t.blockedLine({ fn: 'dateDiff', detail: '' })}`));
		assert.ok(!lines.includes('  ✓ never runs'));
	});

	it('blocks the file as (load) also when its top level catches the gap', () => {
		const { result, lines } = run('function buildToken() {}', "try { iml.dateDiff(); } catch {}\nit('never runs', () => {});");
		assert.deepEqual([result.blocked, result.total, result.passed], [1, 1, 0]);
		assert.ok(lines.includes('  ⊘ (load)'));
	});

	it('keeps today\'s (parse) failure for a SyntaxError, and hints at a template-only call at the top level', () => {
		const parse = run('function buildToken() {}', 'it(');
		assert.deepEqual([parse.result.failed, parse.result.total], [1, 1]);
		assert.equal(parse.result.errors[0].test, '(parse)');
		assert.ok(parse.lines.some((l) => l.startsWith('  ✗ Failed to parse test: ')));
		const top = run('function buildToken() {}', "const sample = iml.parseJSON('{}');\nit('x', () => {});");
		assert.deepEqual(top.result.errors, [{ function: 'buildToken', test: '(parse)', error: PARSE_JSON_HINT }]);
		assert.ok(top.lines.includes(`  ✗ Failed to parse test: ${PARSE_JSON_HINT}`));
		const thrown = run('function buildToken() {}', 'throw null;');
		assert.deepEqual(thrown.result.errors, [{ function: 'buildToken', test: '(parse)', error: 'null' }]);
	});

	it('skips a function without test.js and one with an empty test.js with today\'s lines', () => {
		const lines = [];
		const functions = { a: { code: 'function a() {}', hasTest: false }, b: { code: 'function b() {}', testCode: '', hasTest: true }, c: { code: 'function c() {}', testCode: 'undefined\n', hasTest: true } };
		const result = t.runSuite({ functions, targetNames: [], engine: 'shim', builtins: createImlShim(), environment: { timezone: 'UTC' }, common: {}, assert: nodeAssert, print: (l) => lines.push(l), gaps: [] });
		assert.deepEqual([result.skipped, result.total], [3, 0]);
		assert.ok(lines.includes('  ⏭ No test.js found — skipped'));
		assert.equal(lines.filter((l) => l === '  ⏭ test.js is empty — skipped').length, 2);
	});

	it('prints No functions found. and lists every named function as not found when there are none', () => {
		const lines = [];
		const base = { functions: {}, engine: 'shim', builtins: createImlShim(), environment: { timezone: 'UTC' }, common: {}, assert: nodeAssert, print: (l) => lines.push(l), gaps: [] };
		const none = t.runSuite({ ...base, targetNames: [] });
		assert.deepEqual(none, { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, errors: [], blockedFns: [], notFound: [], noFunctions: true });
		assert.deepEqual(lines, ['No functions found.']);
		assert.deepEqual(t.runSuite({ ...base, targetNames: ['x', 'y'] }).notFound, ['x', 'y']);
	});
});

describe('runSuite in runtime mode', () => {
	const runtimeBuiltins = { upper: (s) => String(s).toUpperCase(), parseJSON: (s) => JSON.parse(s) };
	function run(code, testCode) {
		const lines = [];
		const result = t.runSuite({ functions: { f: { code, testCode, hasTest: true } }, targetNames: [], engine: 'runtime', builtins: runtimeBuiltins, environment: { timezone: 'UTC' }, common: { a: 1 }, assert: nodeAssert, print: (l) => lines.push(l), gaps: [] });
		return { result, lines };
	}

	it('passes no extra globals and keeps the plain object namespace', () => {
		assert.deepEqual(t.functionParams('runtime'), ['environment', '__arguments__', 'iml', 'debug']);
		assert.deepEqual(t.testParams('runtime'), ['assert', 'iml', 'it', 'describe', 'environment', 'debug']);
		const ns = t.buildNamespace({ engine: 'runtime', builtins: runtimeBuiltins });
		assert.equal(Object.getPrototypeOf(ns), Object.prototype);
		assert.notEqual(ns, runtimeBuiltins);
		const test = "it('sees no common', () => { assert.equal(typeof common, 'undefined'); assert.equal(iml.parseJSON('{\"a\":1}').a, 1); assert.equal(typeof iml.constructor, 'function'); });";
		assert.equal(run('function f() {}', test).result.passed, 1);
	});

	it('gives function code no common through iml', () => {
		const { result } = run('function f() { return typeof common; }', "it('x', () => assert.equal(iml.f(), 'undefined'));");
		assert.equal(result.passed, 1);
	});

	it('reports a templates-only name without the hint and an assertion with today\'s Expected and Actual lines', () => {
		const { result, lines } = run('function f() {}', "it('a', () => iml.createXML({}));\nit('b', () => assert.equal(1, 2));");
		assert.deepEqual(result.errors.map((e) => e.error), ['iml.createXML is not a function', 'Expected: 2\n            Actual:   1']);
		assert.ok(lines.includes('          Expected: 2\n            Actual:   1'));
		assert.equal(result.blocked, 0);
	});

	it('uses the shim params with common, Buffer and the shadowed globals', () => {
		assert.deepEqual(t.functionParams('shim'), ['environment', '__arguments__', 'iml', 'debug', 'common', 'Buffer', ...t.SHADOWED_GLOBALS]);
		assert.deepEqual(t.testParams('shim'), ['assert', 'iml', 'it', 'describe', 'environment', 'debug', 'common', 'Buffer', ...t.SHADOWED_GLOBALS]);
		assert.deepEqual(t.SHADOWED_GLOBALS, ['require', 'process', 'setTimeout', 'setInterval', 'setImmediate', 'fetch']);
		const ns = t.buildNamespace({ engine: 'shim', builtins: { upper: 1 } });
		assert.equal(Object.getPrototypeOf(ns), null);
		assert.equal(ns.upper, 1);
	});
});

describe('failureMessage and templateOnlyHint', () => {
	const notAFunction = (name) => new TypeError(`iml.${name} is not a function`);

	it('gives the hint for every templates-only name in shim mode', () => {
		assert.equal(t.templateOnlyHint(notAFunction('parseJSON')), PARSE_JSON_HINT);
		for (const [name, use] of Object.entries(TEMPLATE_ONLY)) {
			assert.equal(t.failureMessage(notAFunction(name), 'shim'), `iml.${name} is not a function. ${name} exists only in IML templates ({{...}}), not in custom function code: use ${use}.`);
		}
	});

	it('gives null for a name outside TEMPLATE_ONLY, another error kind or another text', () => {
		assert.equal(t.templateOnlyHint(notAFunction('nothing')), null);
		assert.equal(t.templateOnlyHint(notAFunction('toString')), null);
		assert.equal(t.templateOnlyHint(new Error('iml.parseJSON is not a function')), null);
		assert.equal(t.templateOnlyHint(new TypeError('x.parseJSON is not a function')), null);
		assert.equal(t.templateOnlyHint(null), null);
		assert.equal(t.failureMessage(notAFunction('nothing'), 'shim'), 'iml.nothing is not a function');
	});

	it('keeps err.message in runtime mode', () => {
		const err = notAFunction('parseJSON');
		assert.equal(t.failureMessage(err, 'runtime'), err.message);
	});

	it('keeps today\'s Expected and Actual lines for an assertion error', () => {
		let err;
		try {
			nodeAssert.deepEqual({ a: 1 }, { a: 2 });
		} catch (e) {
			err = e;
		}
		assert.equal(t.failureMessage(err, 'shim'), 'Expected: {"a":2}\n            Actual:   {"a":1}');
		assert.equal(t.failureMessage(err, 'runtime'), 'Expected: {"a":2}\n            Actual:   {"a":1}');
	});

	it('turns a thrown empty value into text and keeps the message of a thrown object', () => {
		assert.equal(t.failureMessage(undefined, 'shim'), 'undefined');
		assert.equal(t.failureMessage(null, 'runtime'), 'null');
		assert.equal(t.failureMessage({ message: 'plain' }, 'runtime'), 'plain');
	});
});

describe('blockedLine', () => {
	it('gives the spec line, with the detail after the name when there is one', () => {
		assert.equal(t.blockedLine({ fn: 'generateJwtWithKeyId', detail: '' }), "blocked: iml.generateJwtWithKeyId is not in the plugin's shim, so this test cannot run here. Check it in a scenario run.");
		assert.equal(t.blockedLine({ fn: 'formatDate', detail: 'with the token "zz"' }), 'blocked: iml.formatDate with the token "zz" is not in the plugin\'s shim, so this test cannot run here. Check it in a scenario run.');
	});
});

describe('tailLines', () => {
	it('shim mode: failed tests, Not found, Results, Blocked, Engine last', () => {
		const result = { total: 3, passed: 1, failed: 1, blocked: 1, skipped: 0, errors: [{ function: 'buildToken', test: 'parses the response', error: 'e' }], blockedFns: ['generateJwtWithKeyId'], notFound: ['x'] };
		assert.deepEqual(t.tailLines({ engine: 'shim', result }), [
			'',
			SEPARATOR,
			'Failed tests:',
			'  ✗ buildToken › parses the response',
			'Not found: x',
			'Results: 1 passed, 1 failed, 1 blocked by the shim, 0 skipped (3 total tests)',
			'Blocked by the shim: iml.generateJwtWithKeyId',
			ENGINE,
		]);
	});

	it('shim mode: only the separator, Results and Engine when nothing failed, was blocked or is missing', () => {
		const result = { total: 2, passed: 2, failed: 0, blocked: 0, skipped: 1, errors: [], blockedFns: [], notFound: [] };
		assert.deepEqual(t.tailLines({ engine: 'shim', result }), ['', SEPARATOR, 'Results: 2 passed, 0 failed, 0 blocked by the shim, 1 skipped (2 total tests)', ENGINE]);
		assert.equal(t.ENGINE_LINE, ENGINE);
	});

	it('shim mode: lists several blocked functions and missing names', () => {
		const result = { total: 2, passed: 0, failed: 0, blocked: 2, skipped: 0, errors: [], blockedFns: ['dateDiff', 'jwt'], notFound: ['x', 'y'] };
		assert.deepEqual(t.tailLines({ engine: 'shim', result }).slice(2, 5), ['Not found: x, y', 'Results: 0 passed, 0 failed, 2 blocked by the shim, 0 skipped (2 total tests)', 'Blocked by the shim: iml.dateDiff, iml.jwt']);
	});

	it('runtime mode: today\'s tail with Not found before Results', () => {
		const result = { total: 1, passed: 0, failed: 1, blocked: 0, skipped: 0, errors: [{ function: 'f', test: 't', error: 'e' }], blockedFns: [], notFound: ['x'] };
		assert.deepEqual(t.tailLines({ engine: 'runtime', result }), ['', SEPARATOR, 'Not found: x', 'Results: 0 passed, 1 failed, 0 skipped (1 total tests)', '', 'Failed tests:', '  ✗ f › t', SEPARATOR]);
	});

	it('runtime mode: today\'s tail when every test passed', () => {
		const result = { total: 1, passed: 1, failed: 0, blocked: 0, skipped: 0, errors: [], blockedFns: [], notFound: [] };
		assert.deepEqual(t.tailLines({ engine: 'runtime', result }), ['', SEPARATOR, 'Results: 1 passed, 0 failed, 0 skipped (1 total tests)', SEPARATOR]);
	});

	it('after No functions found.: no tail in runtime mode unless a name was given, the full tail in shim mode', () => {
		const result = { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, errors: [], blockedFns: [], notFound: [], noFunctions: true };
		assert.deepEqual(t.tailLines({ engine: 'runtime', result }), []);
		assert.deepEqual(t.tailLines({ engine: 'runtime', result: { ...result, notFound: ['x'] } }), ['', SEPARATOR, 'Not found: x', 'Results: 0 passed, 0 failed, 0 skipped (0 total tests)', SEPARATOR]);
		assert.deepEqual(t.tailLines({ engine: 'shim', result }), ['', SEPARATOR, 'Results: 0 passed, 0 failed, 0 blocked by the shim, 0 skipped (0 total tests)', ENGINE]);
	});
});

describe('shimHeaderLines', () => {
	const header = (o) => t.shimHeaderLines({ fallbackLine: null, slug: 'my-app', version: '1', timezone: 'UTC', zoneKnown: true, manifest: 2, manifestKnown: true, commonState: 'file', mode: 'public', functionsDir: FUNCTIONS_DIR, ...o });

	it('prints the shim lines in the order of the spec sample', () => {
		assert.deepEqual(header({}), [
			SHIM,
			'Testing: my-app v1',
			'Timezone: UTC (Make uses the time zone of the module; pass --tz=<Zone> to match)',
			'Manifest: 2 (a missing value stays undefined)',
			'Common: common.imljson (values masked in public mode)',
			`Path: ${FUNCTIONS_DIR}`,
		]);
		assert.equal(t.SHIM_LINE, SHIM);
	});

	it('puts the employee fallback line first', () => {
		const lines = header({ fallbackLine: PATH_MISSING, mode: 'employee' });
		assert.deepEqual(lines.slice(0, 2), [PATH_MISSING, SHIM]);
		assert.equal(lines.length, 7);
	});

	it('names an unknown zone, manifest 1, no manifestVersion and each common state', () => {
		assert.equal(header({ timezone: 'Mars/Base', zoneKnown: false })[2], 'Timezone: Mars/Base is not a time zone this computer knows, so the date functions use UTC. Make also falls back without an error; check the zone name.');
		assert.equal(header({ manifest: 1 })[3], 'Manifest: 1 (a missing value becomes null)');
		assert.equal(header({ manifest: 1, manifestKnown: false })[3], 'Manifest: 1 (metadata.json has no manifestVersion; run download-app.js to read it)');
		assert.equal(header({ commonState: 'none' })[4], 'Common: none (no common.imljson in the local copy)');
		assert.equal(header({ commonState: 'file', mode: 'employee' })[4], 'Common: common.imljson');
		assert.equal(header({ commonState: 'unparsable' })[4], 'Common: none (common.imljson is not a JSON object, so common is {})');
	});
});

describe('manifestOf and commonOf', () => {
	it('reads manifestVersion from metadata.json and falls back to 1 without it', () => {
		assert.deepEqual(t.manifestOf('{"manifestVersion":2}'), { manifest: 2, known: true });
		assert.deepEqual(t.manifestOf('{"manifestVersion":1}'), { manifest: 1, known: true });
		assert.deepEqual(t.manifestOf('{"slug":"my-app"}'), { manifest: 1, known: false });
		assert.deepEqual(t.manifestOf('{"manifestVersion":"2"}'), { manifest: 1, known: false });
		assert.deepEqual(t.manifestOf('not json'), { manifest: 1, known: false });
		assert.deepEqual(t.manifestOf('null'), { manifest: 1, known: false });
		assert.deepEqual(t.manifestOf(null), { manifest: 1, known: false });
	});

	it('parses common.imljson into an object, else gives {}', () => {
		assert.deepEqual(t.commonOf(null), { common: {}, state: 'none' });
		assert.deepEqual(t.commonOf('\uFEFF{"a":"***MASKED:string***"}'), { common: { a: '***MASKED:string***' }, state: 'file' });
		assert.deepEqual(t.commonOf('[1]'), { common: {}, state: 'unparsable' });
		assert.deepEqual(t.commonOf('null'), { common: {}, state: 'unparsable' });
		assert.deepEqual(t.commonOf('{"a":'), { common: {}, state: 'unparsable' });
	});
});
