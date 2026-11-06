const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const codec = require('./iml-shim-codec');
const parity = require('./iml-shim-parity.json');
const { CASES, GAP_ROWS } = require('./iml-shim-cases');
const shim = require('../iml-shim');

/** Rows whose error text comes from Node itself and differs between Node versions: only the error name is compared. */
const DIVERGENCES = {
	// '<row id>': { receivers: null, reason: '<why the native text differs>' },
};

const FROZEN = Date.parse(codec.FROZEN_NOW_ISO);
const makeIml = (r) => shim.createImlShim({ timezone: r.timezone, manifest: r.manifest, now: () => FROZEN });
const gapAllowed = (fn) => Object.hasOwn(shim.SHIM_GAPS, fn) || Object.hasOwn(shim.SHIM_GAP_RULES, fn);

describe('IML shim parity', () => {
	it('the case list is the one that was recorded, and every case has a row with every receiver', () => {
		assert.equal(codec.casesHash(CASES), parity.casesHash);
		assert.match(parity.recordedAt, /^\d{4}-\d{2}-\d{2}$/);
		assert.deepEqual(parity.rows.map((r) => r.id), codec.caseRows(CASES).map((r) => r.id));
		for (const row of parity.rows) assert.deepEqual(Object.keys(row.results), Object.keys(codec.RECEIVERS), row.id);
	});

	it('every case group is a covered function or a declared gap, and every covered function has a case', () => {
		const names = Object.keys(CASES);
		assert.deepEqual(names.filter((n) => !shim.SHIM_COVERED.includes(n) && !Object.hasOwn(shim.SHIM_GAPS, n)), []);
		assert.deepEqual(shim.SHIM_COVERED.filter((n) => !names.includes(n)), []);
	});

	it('every recorded error is a name and a message, never a stack or a path', () => {
		for (const row of parity.rows) for (const r of Object.values(row.results)) if (r.err) assert.deepEqual(Object.keys(r.err), ['name', 'message'], row.id);
		assert.doesNotMatch(JSON.stringify(parity), codec.PATH_OR_STACK);
	});

	it('every divergence names a recorded row and gives a reason', () => {
		const ids = new Set(parity.rows.map((r) => r.id));
		for (const [id, d] of Object.entries(DIVERGENCES)) {
			assert.ok(ids.has(id), id);
			assert.ok(typeof d.reason === 'string' && d.reason.length > 10, id);
		}
	});

	it('every listed gap row is a recorded row of a function with a declared gap', () => {
		const ids = new Set(parity.rows.map((r) => r.id));
		for (const id of GAP_ROWS) {
			assert.ok(ids.has(id), id);
			assert.ok(gapAllowed(id.split('#')[0]), id);
		}
	});

	for (const fn of Object.keys(CASES)) {
		it(`${fn}: every recorded row`, () => {
			assert.deepEqual(codec.parityMismatches({ parity, cases: CASES, fns: [fn], makeIml, isGapError: (e) => e instanceof shim.ShimGapError, gapAllowed, gapRows: GAP_ROWS, divergences: DIVERGENCES }), []);
		});
	}
});

describe('parityMismatches', () => {
	const cases = { upper: [['a']], lower: [['B']] };
	const gapError = (fn) => Object.assign(new Error(`gap ${fn}`), { isGap: true, fn });
	const fake = {
		upper: (s) => s.toUpperCase(),
		lower: (s) => s.toLowerCase(),
	};
	const doc = (rows) => ({ rows: rows.map(([id, result]) => ({ id, results: { m1_utc: result } })) });
	const run = (rows, options = {}) => codec.parityMismatches({ parity: doc(rows), cases, makeIml: () => fake, isGapError: (e) => e.isGap === true, gapAllowed: (fn) => fn === 'upper', ...options });

	it('passes an equal answer and an equal error', () => {
		assert.deepEqual(run([['upper#0', { ok: 'A' }], ['lower#0', { ok: 'b' }]]), []);
		assert.deepEqual(run([['upper#0', { err: { name: 'Error', message: 'no' } }]], { makeIml: () => ({ upper: () => { throw new Error('no'); } }) }), []);
	});

	it('lists a different answer, a different error and an answer where an error was recorded', () => {
		assert.deepEqual(run([['upper#0', { ok: 'a' }]]), ['upper#0 m1_utc: got {"ok":"A"}, recorded {"ok":"a"}']);
		const thrower = () => ({ upper: () => { throw new TypeError('no'); } });
		assert.deepEqual(run([['upper#0', { err: { name: 'Error', message: 'no' } }]], { makeIml: thrower }), ['upper#0 m1_utc: got {"err":{"name":"TypeError","message":"no"}}, recorded {"err":{"name":"Error","message":"no"}}']);
		assert.deepEqual(run([['upper#0', { err: { name: 'Error', message: 'no' } }]]), ['upper#0 m1_utc: got {"ok":"A"}, recorded {"err":{"name":"Error","message":"no"}}']);
	});

	it('lists a recorded row that is not in the case list, and skips functions outside fns', () => {
		assert.deepEqual(run([['upper#1', { ok: 'A' }]]), ['upper#1: recorded, but not in the case list']);
		assert.deepEqual(run([['lower#0', { ok: 'wrong' }]], { fns: ['upper'] }), []);
	});

	it('lists a gap of an undeclared function, a gap on a row GAP_ROWS does not list, and a listed row without a gap', () => {
		const gaps = () => ({ upper: () => { throw gapError('upper'); }, lower: () => { throw gapError('lower'); } });
		assert.deepEqual(run([['lower#0', { ok: 'b' }]], { makeIml: gaps }), ['lower#0 m1_utc: a gap error for lower, which is not a declared gap']);
		assert.deepEqual(run([['upper#0', { ok: 'A' }]], { makeIml: gaps, gapRows: [] }), ['upper#0 m1_utc: a gap error on a row that GAP_ROWS does not list']);
		assert.deepEqual(run([['upper#0', { ok: 'A' }]], { makeIml: gaps, gapRows: ['upper#0'] }), []);
		assert.deepEqual(run([['upper#0', { ok: 'A' }]], { gapRows: ['upper#0'] }), ['upper#0 m1_utc: listed in GAP_ROWS, but the shim answered without a gap error']);
	});

	it('passes a divergence row only when both sides are errors of the same name', () => {
		const divergences = { 'upper#0': { receivers: null, reason: 'the native text differs' } };
		const thrower = (Type) => () => ({ upper: () => { throw new Type('other text'); } });
		const recorded = [['upper#0', { err: { name: 'TypeError', message: 'native text' } }]];
		assert.deepEqual(run(recorded, { makeIml: thrower(TypeError), divergences }), []);
		const needs = 'upper#0 m1_utc: a divergence row needs an error of the same name on both sides';
		assert.deepEqual(run(recorded, { makeIml: thrower(RangeError), divergences }), [needs]);
		assert.deepEqual(run(recorded, { divergences }), [needs]);
		assert.deepEqual(run(recorded, { makeIml: thrower(RangeError), divergences: { 'upper#0': { receivers: ['m2_utc'], reason: 'only on another receiver' } } }).length, 1);
	});
});
