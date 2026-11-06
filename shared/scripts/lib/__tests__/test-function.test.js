/**
 * Tests for the entry script test-function.js on the fake HOME of entry-harness.js (spec 3.1): the engine choice in
 * both modes, the shim header and tail lines, a pass, a blocked test, a templates-only call, a missing named function,
 * an unknown zone, the employee runtime path with a stub engine, and exit codes 0, 1 and 2. No case sends a Make
 * request: the seeded mode cache answers the mode check.
 */
require('./isolate-home');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createHarness } = require('./entry-harness');

const SHIM = "IML: the plugin's built-in shim (83 functions, written from the public Make docs). It is not the Make engine.";
const TIMEZONE_UTC = 'Timezone: UTC (Make uses the time zone of the module; pass --tz=<Zone> to match)';
const MANIFEST_2 = 'Manifest: 2 (a missing value stays undefined)';
const COMMON_PUBLIC = 'Common: common.imljson (values masked in public mode)';
const ENGINE = 'Engine: shim. A pass here is a local check; the final check is a scenario run in Make.';
const SEPARATOR = '════════════════════════════════════════';
const BLOCKED_JWK = "blocked: iml.generateJwtWithKeyId is not in the plugin's shim, so this test cannot run here. Check it in a scenario run.";
const PARSE_JSON_HINT = 'iml.parseJSON is not a function. parseJSON exists only in IML templates ({{...}}), not in custom function code: use JSON.parse.';
const PATH_NOT_LOADED = "IML: imt-app-runtime-path is set but the runtime did not load, so the plugin's shim is used.";
const USAGE_FIRST = 'Usage: node test-function.js <app-slug> <app-version> [function-name ...] [--tz=TIMEZONE] [--engine=shim|runtime]';

const CODE = 'function buildToken(x) { return iml.upper(x); }';
const PASS = "it('signs the claims', () => assert.equal(buildToken('a'), 'A'));";
const BLOCK = "it('adds the key id', () => assert.throws(() => iml.generateJwtWithKeyId({})));";
const FAIL = "it('parses the response', () => iml.parseJSON('{}'));";
const MASKED_COMMON = '{\n\t"clientSecret": "***MASKED:string***"\n}\n';

let h;

before(async () => {
	h = await createHarness();
});

after(() => h.close());

const functionsDir = () => path.join(h.contextsDir(), 'my-app-v1', 'functions');
const lines = (text) => text.split('\n');

/** The working copy of my-app v1 with buildToken and the given test lines; metadata and common as each case needs. */
function writeApp({ tests = [PASS], manifestVersion = 2, common = MASKED_COMMON, code = CODE } = {}) {
	const files = { 'functions/buildToken/code.js': code, 'functions/buildToken/test.js': tests.join('\n') };
	if (common !== null) files['common.imljson'] = common;
	return h.writeWorkingCopy({ metadata: manifestVersion === null ? {} : { manifestVersion }, files });
}

/** A stub engine under the folder that the employee loader reads: one built-in, upper. */
function writeStubRuntime() {
	const dir = path.join(h.work, 'runtime');
	const iml = path.join(dir, 'node_modules', '@integromat', 'iml');
	fs.mkdirSync(iml, { recursive: true });
	fs.writeFileSync(path.join(iml, 'index.js'), 'exports.IML = { FUNCTIONS: { upper: { value(s) { return String(s).toUpperCase(); } } } };\n');
	return dir;
}

describe('test-function.js in public mode', () => {
	it('prints the shim header, the run and the shim tail, and exits 1 for a failed test', async () => {
		h.seed();
		writeApp({ tests: [PASS, BLOCK, FAIL] });
		const r = await h.run('test-function.js', ['my-app', '1']);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stdout, `${[
			SHIM,
			'Testing: my-app v1',
			TIMEZONE_UTC,
			MANIFEST_2,
			COMMON_PUBLIC,
			`Path: ${functionsDir()}`,
			'Functions: 1 loaded',
			'  → buildToken',
			'',
			'━━━ buildToken ━━━',
			'  ✓ signs the claims',
			'  ⊘ adds the key id',
			`          ${BLOCKED_JWK}`,
			'  ✗ parses the response',
			`          ${PARSE_JSON_HINT}`,
			'',
			SEPARATOR,
			'Failed tests:',
			'  ✗ buildToken › parses the response',
			'Results: 1 passed, 1 failed, 1 blocked by the shim, 0 skipped (3 total tests)',
			'Blocked by the shim: iml.generateJwtWithKeyId',
			ENGINE,
		].join('\n')}\n`);
		assert.equal(r.stderr, '');
		assert.equal(h.log.length, 0);
	});

	it('exits 0 when the one test passes', async () => {
		h.seed();
		writeApp();
		const r = await h.run('test-function.js', ['my-app', '1']);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('  ✓ signs the claims'), r.stdout);
		assert.ok(r.stdout.endsWith(`Results: 1 passed, 0 failed, 0 blocked by the shim, 0 skipped (1 total tests)\n${ENGINE}\n`), r.stdout);
		assert.equal(h.log.length, 0);
	});

	it('exits 2 when a test was blocked and none failed', async () => {
		h.seed();
		writeApp({ tests: [PASS, BLOCK] });
		const r = await h.run('test-function.js', ['my-app', '1']);
		assert.equal(r.code, 2, r.out);
		assert.ok(r.stdout.endsWith(`Results: 1 passed, 0 failed, 1 blocked by the shim, 0 skipped (2 total tests)\nBlocked by the shim: iml.generateJwtWithKeyId\n${ENGINE}\n`), r.stdout);
		assert.equal(h.log.length, 0);
	});

	it('exits 1 for a missing named function and names it right before Results', async () => {
		h.seed();
		writeApp();
		const r = await h.run('test-function.js', ['my-app', '1', 'missing']);
		assert.equal(r.code, 1, r.out);
		const out = lines(r.stdout);
		assert.ok(r.stdout.includes('\n⚠ Function "missing" not found. Available: buildToken\n'), r.stdout);
		const results = out.findIndex((l) => l.startsWith('Results: '));
		assert.equal(out[results - 1], 'Not found: missing');
		assert.equal(out[results], 'Results: 0 passed, 0 failed, 0 blocked by the shim, 0 skipped (0 total tests)');
		assert.equal(h.log.length, 0);
	});

	it('refuses --engine=runtime', async () => {
		h.seed();
		writeApp();
		const r = await h.run('test-function.js', ['my-app', '1', '--engine=runtime']);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stderr, "ERROR: --engine=runtime is for Make employees only. Run the command without --engine to use the plugin's shim.\n");
		assert.equal(r.stdout, '');
		assert.equal(h.log.length, 0);
	});

	it('falls back to UTC for an unknown --tz with one line, and the date functions use UTC', async () => {
		h.seed();
		writeApp({ tests: ["it('formats', () => assert.equal(iml.formatDate(new Date(0), 'HH:mm'), '00:00'));"] });
		const r = await h.run('test-function.js', ['my-app', '1', '--tz=Mars/Base']);
		assert.equal(r.code, 0, r.out);
		assert.equal(lines(r.stdout)[2], 'Timezone: Mars/Base is not a time zone this computer knows, so the date functions use UTC. Make also falls back without an error; check the zone name.');
		assert.ok(r.stdout.includes('  ✓ formats'), r.stdout);
		assert.equal(h.log.length, 0);
	});

	it('runs function code and the shim in UTC whatever the zone of the computer', async () => {
		h.seed();
		writeApp({ code: 'function buildToken(d) { return String(d); }', tests: ['it(buildToken(new Date(0)), () => {});', 'it(iml.upper(new Date(0)), () => {});'] });
		const r = await h.run('test-function.js', ['my-app', '1'], { env: { CLAUDECODE: '1', TZ: 'America/Los_Angeles' } });
		assert.equal(r.code, 0, r.out);
		assert.match(r.stdout, /\n {2}✓ Thu Jan 01 1970 00:00:00 GMT\+0000 /);
		assert.match(r.stdout, /\n {2}✓ THU JAN 01 1970 00:00:00 GMT\+0000 /);
		assert.equal(h.log.length, 0);
	});

	it('says so when metadata.json and common.imljson are missing', async () => {
		h.seed();
		const dir = writeApp({ common: null });
		fs.rmSync(path.join(dir, 'metadata.json'));
		const r = await h.run('test-function.js', ['my-app', '1']);
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(lines(r.stdout).slice(3, 5), ['Manifest: 1 (metadata.json has no manifestVersion; run download-app.js to read it)', 'Common: none (no common.imljson in the local copy)']);
		assert.equal(h.log.length, 0);
	});

	it('gives function code the local common file', async () => {
		h.seed();
		writeApp({ code: 'function buildToken() { return common.clientSecret; }', tests: ["it('reads common', () => assert.equal(buildToken(), '***MASKED:string***'));"] });
		const r = await h.run('test-function.js', ['my-app', '1']);
		assert.equal(r.code, 0, r.out);
		assert.equal(h.log.length, 0);
	});

	it('stops a bad --engine value with the error and the usage', async () => {
		h.seed();
		writeApp();
		const r = await h.run('test-function.js', ['my-app', '1', '--engine=bogus']);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stderr, 'ERROR: --engine must be shim or runtime.\n');
		assert.equal(lines(r.stdout)[0], USAGE_FIRST);
		assert.equal(h.log.length, 0);
	});

	it('prints the usage with the engine flag when the version is missing', async () => {
		h.seed();
		const r = await h.run('test-function.js', ['my-app']);
		assert.equal(r.code, 1, r.out);
		assert.equal(lines(r.stdout)[0], USAGE_FIRST);
		assert.equal(r.stderr, '');
		assert.equal(h.log.length, 0);
	});

	it('stops with today\'s lines when the functions folder is missing', async () => {
		h.seed();
		const r = await h.run('test-function.js', ['my-app', '1']);
		assert.equal(r.code, 1, r.out);
		assert.equal(r.stderr, `Functions directory not found: ${functionsDir()}\nRun download-app.js first: node download-app.js my-app 1\n`);
		assert.equal(h.log.length, 0);
	});
});

describe('test-function.js in employee mode', () => {
	it('uses the shim with one line when imt-app-runtime-path is not set', async () => {
		h.seed({ mode: 'employee' });
		writeApp();
		const r = await h.run('test-function.js', ['my-app', '1']);
		assert.equal(r.code, 0, r.out);
		const secrets = path.join(h.home, '.make-custom-app-skill-secrets');
		assert.deepEqual(lines(r.stdout).slice(0, 7), [
			`IML: imt-app-runtime-path is not set, so the plugin's shim is used. Set it in ${secrets} to test against the runtime.`,
			SHIM,
			'Testing: my-app v1',
			TIMEZONE_UTC,
			MANIFEST_2,
			'Common: common.imljson',
			`Path: ${functionsDir()}`,
		]);
		assert.ok(r.stdout.endsWith(`${ENGINE}\n`), r.stdout);
		assert.equal(h.log.length, 0);
	});

	it('uses the shim with one line when the runtime path does not load', async () => {
		const empty = path.join(h.work, 'empty-runtime');
		fs.mkdirSync(empty, { recursive: true });
		h.seed({ mode: 'employee', secretsExtra: `imt-app-runtime-path: ${empty}\n` });
		writeApp();
		const r = await h.run('test-function.js', ['my-app', '1']);
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(lines(r.stdout).slice(0, 3), [PATH_NOT_LOADED, SHIM, 'Testing: my-app v1']);
		assert.equal(h.log.length, 0);
	});

	it('runs a test.js that declares its own common on the shim when the runtime throws on load', async () => {
		const broken = path.join(h.work, 'broken-runtime');
		const iml = path.join(broken, 'node_modules', '@integromat', 'iml');
		fs.mkdirSync(iml, { recursive: true });
		fs.writeFileSync(path.join(iml, 'index.js'), "throw new Error('broken');\n");
		h.seed({ mode: 'employee', secretsExtra: `imt-app-runtime-path: ${broken}\n` });
		writeApp({ code: 'function buildToken() { return common.a; }', tests: ['const common = { a: 1 };', "it('reads its own common', () => assert.equal(buildToken(), 1));"] });
		const r = await h.run('test-function.js', ['my-app', '1']);
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(lines(r.stdout).slice(0, 2), [PATH_NOT_LOADED, SHIM]);
		assert.ok(r.stdout.includes('  ✓ reads its own common'), r.stdout);
		assert.ok(!r.stdout.includes('(parse)') && !r.stdout.includes('Failed to parse'), r.stdout);
		assert.equal(h.log.length, 0);
	});

	it('falls back to the shim with its one line when the runtime throws while it loads', async () => {
		const bodies = ["throw new Error('runtime failed to load');\n", 'exports.IML = undefined;\n'];
		for (const [i, body] of bodies.entries()) {
			const runtime = path.join(h.work, `throwing-runtime-${i}`);
			const iml = path.join(runtime, 'node_modules', '@integromat', 'iml');
			fs.mkdirSync(iml, { recursive: true });
			fs.writeFileSync(path.join(iml, 'index.js'), body);
			h.seed({ mode: 'employee', secretsExtra: `imt-app-runtime-path: ${runtime}\n` });
			writeApp();
			const r = await h.run('test-function.js', ['my-app', '1']);
			assert.equal(r.code, 0, r.out);
			const out = lines(r.stdout);
			assert.deepEqual(out.slice(0, 3), [PATH_NOT_LOADED, SHIM, 'Testing: my-app v1'], body);
			assert.equal(out.filter((l) => l.startsWith('IML: ')).length, 2, r.stdout);
			assert.ok(r.stdout.includes('  ✓ signs the claims'), r.stdout);
			assert.ok(r.stdout.endsWith(`${ENGINE}\n`), r.stdout);
			assert.equal(r.stderr, '', body);
			assert.equal(h.log.length, 0);
		}
	});

	it('keeps the zone of the computer for function code when the runtime runs', async () => {
		const runtime = writeStubRuntime();
		h.seed({ mode: 'employee', secretsExtra: `imt-app-runtime-path: ${runtime}\n` });
		writeApp({ code: 'function buildToken(d) { return String(d); }', tests: ['it(buildToken(new Date(0)), () => {});'] });
		const r = await h.run('test-function.js', ['my-app', '1'], { env: { CLAUDECODE: '1', TZ: 'America/Los_Angeles' } });
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.includes('IML: @integromat/iml loaded'), r.stdout);
		assert.match(r.stdout, /\n {2}✓ Wed Dec 31 1969 16:00:00 GMT-0800 /);
		assert.equal(h.log.length, 0);
	});

	it('runs the runtime with today\'s header and tail when it loads', async () => {
		const runtime = writeStubRuntime();
		h.seed({ mode: 'employee', secretsExtra: `imt-app-runtime-path: ${runtime}\n` });
		writeApp({ tests: [PASS, "it('parses', () => assert.deepEqual(iml.parseJSON('{\"a\":1}'), { a: 1 }));"] });
		const r = await h.run('test-function.js', ['my-app', '1']);
		assert.equal(r.code, 0, r.out);
		const out = lines(r.stdout);
		const loaded = out.findIndex((l) => /^IML: @integromat\/iml loaded \(\d+ built-in functions\)$/.test(l));
		assert.ok(loaded >= 0, r.stdout);
		assert.deepEqual(out.slice(loaded + 1, loaded + 4), ['Testing: my-app v1', 'Timezone: UTC', `Path: ${functionsDir()}`]);
		assert.ok(!r.stdout.includes('Manifest:') && !r.stdout.includes('Common:') && !r.stdout.includes('blocked') && !r.stdout.includes('Engine:'), r.stdout);
		assert.ok(r.stdout.includes('  ✓ parses'), r.stdout);
		assert.ok(r.stdout.endsWith(`\n${SEPARATOR}\nResults: 2 passed, 0 failed, 0 skipped (2 total tests)\n${SEPARATOR}\n`), r.stdout);
		assert.equal(h.log.length, 0);
	});

	it('stops after No functions found. with no tail, and gives the tail with Not found and exit 1 for a named function', async () => {
		const runtime = writeStubRuntime();
		h.seed({ mode: 'employee', secretsExtra: `imt-app-runtime-path: ${runtime}\n` });
		h.writeWorkingCopy({ metadata: { manifestVersion: 2 }, files: {} });
		fs.mkdirSync(functionsDir(), { recursive: true });
		const r = await h.run('test-function.js', ['my-app', '1']);
		assert.equal(r.code, 0, r.out);
		assert.ok(r.stdout.endsWith('\nNo functions found.\n'), r.stdout);
		const named = await h.run('test-function.js', ['my-app', '1', 'x']);
		assert.equal(named.code, 1, named.out);
		assert.ok(named.stdout.endsWith(`\nNo functions found.\n\n${SEPARATOR}\nNot found: x\nResults: 0 passed, 0 failed, 0 skipped (0 total tests)\n${SEPARATOR}\n`), named.stdout);
		assert.equal(h.log.length, 0);
	});

	it('stops --engine=runtime when no runtime path is set', async () => {
		h.seed({ mode: 'employee' });
		writeApp();
		const r = await h.run('test-function.js', ['my-app', '1', '--engine=runtime']);
		assert.equal(r.code, 1, r.out);
		assert.ok(r.stderr.endsWith("ERROR: --engine=runtime needs a runtime that loads from imt-app-runtime-path. Run the command without --engine to use the plugin's shim.\n"), r.stderr);
		assert.ok(!r.stdout.includes('Testing:'), r.stdout);
		assert.equal(h.log.length, 0);
	});

	it('uses the shim with --engine=shim even when the runtime loads', async () => {
		const runtime = writeStubRuntime();
		h.seed({ mode: 'employee', secretsExtra: `imt-app-runtime-path: ${runtime}\n` });
		writeApp();
		const r = await h.run('test-function.js', ['my-app', '1', '--engine=shim']);
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(lines(r.stdout).slice(0, 2), [SHIM, 'Testing: my-app v1']);
		assert.ok(!r.stdout.includes('@integromat/iml'), r.stdout);
		assert.ok(r.stdout.endsWith(`${ENGINE}\n`), r.stdout);
		assert.equal(h.log.length, 0);
	});
});
