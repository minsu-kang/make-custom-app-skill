'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const recorder = require('../record-iml-parity');
const codec = require('../../shared/scripts/lib/__tests__/iml-shim-codec');

const SCRIPT = path.join(__dirname, '..', 'record-iml-parity.js');

describe('parseArgs', () => {
	it('needs --runtime and --m2-flag', () => {
		assert.deepEqual(recorder.parseArgs([]), { error: 'ERROR: --runtime is required' });
		assert.deepEqual(recorder.parseArgs(['--runtime', '/r']), { error: 'ERROR: --m2-flag is required' });
	});

	it('reads every option and resolves the paths', () => {
		const r = recorder.parseArgs(['--runtime', 'r', '--m2-flag', 'F', '--cases', 'c.js', '--out', 'o.json']);
		assert.deepEqual(r, { runtime: path.resolve('r'), m2Flag: 'F', cases: path.resolve('c.js'), out: path.resolve('o.json') });
	});

	it('stops on an unknown argument and on a missing value', () => {
		assert.deepEqual(recorder.parseArgs(['--x']), { error: 'ERROR: unknown argument --x' });
		assert.deepEqual(recorder.parseArgs(['--runtime']), { error: 'ERROR: --runtime needs a value' });
		assert.deepEqual(recorder.parseArgs(['--runtime', '--m2-flag', 'F']), { error: 'ERROR: --runtime needs a value' });
	});
});

describe('the codec', () => {
	const roundTrip = (v) => codec.decode(JSON.parse(JSON.stringify(codec.encode(v))));

	it('round-trips the typed values', () => {
		const values = [undefined, null, -0, NaN, Infinity, 7n, new Date('2026-01-02T03:04:05.006Z'), Buffer.from('hé'), [1, { a: undefined }], { x: 'y', n: [true, ''] }];
		for (const v of values) assert.deepEqual(roundTrip(v), v);
		const invalid = roundTrip(new Date(NaN));
		assert.ok(invalid instanceof Date);
		assert.ok(Number.isNaN(invalid.getTime()));
	});

	it('changes the hash when a case changes', () => {
		assert.notEqual(codec.casesHash({ upper: [['a']] }), codec.casesHash({ upper: [['b']] }));
		assert.match(codec.casesHash({ upper: [['a']] }), /^sha256:[0-9a-f]{64}$/);
	});
});

describe('the script', () => {
	let dir;
	let env;
	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-iml-'));
		env = { ...process.env, HOME: dir, USERPROFILE: dir };
		const pkg = path.join(dir, 'runtime', 'node_modules', '@integromat', 'iml');
		fs.mkdirSync(pkg, { recursive: true });
		fs.writeFileSync(
			path.join(pkg, 'index.js'),
			[
				'exports.IML = { FUNCTIONS: {',
				"	upper: { value(s) { return [String(s).toUpperCase(), this.timezone, this.FLAG === true, Date.now(), new Date().toISOString(), process.env.TZ]; } },",
				"	fail: { value() { throw new Error('bad input'); } },",
				"	flagged: { value() { return Object.keys(this).length; } },",
				"	inRuntime: { value() { return process.env.RECORD_TEST_RUNTIME + '/lib/x.js'; } },",
				"	inHome: { value() { return '/Users/someone/x.js'; } },",
				"	inPackages: { value() { return 'node_modules/x/index.js'; } },",
				"	namesPackage: { value() { throw new Error('@integromat/x failed'); } },",
				"	withStack: { value() { throw new Error('bad\\n    at run (x.js:1:2)'); } },",
				'} };',
				'',
			].join('\n'),
		);
		fs.writeFileSync(path.join(dir, 'cases.js'), "exports.CASES = { upper: [['a']], fail: [[]] };\n");
		fs.mkdirSync(path.join(dir, 'empty'));
	});
	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	/** Runs the recorder on the fake runtime with a cases file of `cases`, written as its own file. */
	const recordCases = (name, cases, flag = 'FLAG') => {
		const casesFile = path.join(dir, `cases-${name}.js`);
		fs.writeFileSync(casesFile, `exports.CASES = ${JSON.stringify(cases)};\n`);
		const out = path.join(dir, `out-${name}.json`);
		const runtime = path.join(dir, 'runtime');
		const r = spawnSync(process.execPath, [SCRIPT, '--runtime', runtime, '--m2-flag', flag, '--cases', casesFile, '--out', out], { encoding: 'utf8', env: { ...env, RECORD_TEST_RUNTIME: runtime } });
		return { ...r, out };
	};

	it('stops without --runtime, with the usage', () => {
		const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
		assert.equal(r.status, 1);
		assert.match(r.stderr, /^ERROR: --runtime is required\nUsage: node tools\/record-iml-parity\.js/);
	});

	it('stops when the runtime has no engine', () => {
		const r = spawnSync(process.execPath, [SCRIPT, '--runtime', path.join(dir, 'empty'), '--m2-flag', 'FLAG', '--out', path.join(dir, 'never.json')], { encoding: 'utf8', env });
		assert.equal(r.status, 1);
		assert.match(r.stderr, /^ERROR: no IML engine at /);
		assert.equal(fs.existsSync(path.join(dir, 'never.json')), false);
	});

	it('records every case under the four receivers, with TZ=UTC and the frozen clock', () => {
		const out = path.join(dir, 'out.json');
		const r = spawnSync(process.execPath, [SCRIPT, '--runtime', path.join(dir, 'runtime'), '--m2-flag', 'FLAG', '--cases', path.join(dir, 'cases.js'), '--out', out], { encoding: 'utf8', env: { ...env, TZ: 'Europe/Prague' } });
		assert.equal(r.status, 0, r.stderr);
		const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
		assert.match(doc.recordedAt, /^\d{4}-\d{2}-\d{2}$/);
		assert.equal(doc.casesHash, codec.casesHash({ upper: [['a']], fail: [[]] }));
		const now = Date.parse(codec.FROZEN_NOW_ISO);
		const row = (zone, flag) => ({ ok: ['A', zone, flag, now, codec.FROZEN_NOW_ISO, 'UTC'] });
		assert.deepEqual(doc.rows[0], { id: 'upper#0', results: { m1_utc: row('UTC', false), m2_utc: row('UTC', true), m1_prague: row('Europe/Prague', false), m1_new_york: row('America/New_York', false) } });
		assert.deepEqual(doc.rows[1].results.m1_utc, { err: { name: 'Error', message: 'bad input' } });
		assert.equal(fs.readFileSync(out, 'utf8').split('\n').filter((line) => line.startsWith('{"id":')).length, 2);
	});

	it('refuses a result with the runtime folder, a home path, a package path or name, or a stack frame, and writes nothing', () => {
		for (const fn of ['inRuntime', 'inHome', 'inPackages', 'namesPackage', 'withStack']) {
			const r = recordCases(fn, { upper: [['a']], [fn]: [[]] });
			assert.equal(r.status, 1, fn);
			assert.equal(r.stderr, `ERROR: row ${fn}#0 (m1_utc) has a file path, a package name or a stack frame in its result; take the case out of the list\n`, fn);
			assert.equal(fs.existsSync(r.out), false, fn);
		}
	});

	it('stops when the engine has no function of a case, and writes nothing', () => {
		const r = recordCases('missing', { upper: [['a']], nope: [[]] });
		assert.equal(r.status, 1);
		assert.equal(r.stderr, 'ERROR: the engine has no function nope\n');
		assert.equal(fs.existsSync(r.out), false);
	});

	it('passes the manifest 2 flag to the engine but never stores or prints its name', () => {
		const flag = 'flagNameUnderTest';
		const r = recordCases('flag', { flagged: [[]] }, flag);
		assert.equal(r.status, 0, r.stderr);
		const text = fs.readFileSync(r.out, 'utf8');
		const { results } = JSON.parse(text).rows[0];
		assert.deepEqual([results.m1_utc, results.m2_utc], [{ ok: 1 }, { ok: 2 }]);
		assert.ok(!text.includes(flag) && !r.stdout.includes(flag) && !r.stderr.includes(flag));
	});
});
