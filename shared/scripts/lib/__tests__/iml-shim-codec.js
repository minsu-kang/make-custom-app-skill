'use strict';
/**
 * Test helper, not a test file: the value encoding of the IML parity rows (spec 3.1), shared by iml-shim-parity.test.js
 * and tools/record-iml-parity.js. A Date, a Buffer, undefined and the numbers JSON cannot hold get a typed encoding;
 * the case-list hash ties a recording to the exact inputs, receivers and frozen instant.
 */
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');

const FROZEN_NOW_ISO = '2026-07-15T10:30:00.000Z';
const RECEIVERS = {
	m1_utc: { timezone: 'UTC', manifest: 1 },
	m2_utc: { timezone: 'UTC', manifest: 2 },
	m1_prague: { timezone: 'Europe/Prague', manifest: 1 },
	m1_new_york: { timezone: 'America/New_York', manifest: 1 },
};
const TAGS = ['$u', '$d', '$b', '$n', '$big', '$f'];
/** A file path, a package name or a stack frame: the recorder refuses a result with one, and the recorded file holds none. */
const PATH_OR_STACK = /node_modules|@integromat|\/Users\/|\bat [\w.]+ \(/;

function setOwn(target, key, value) {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function encode(v) {
	if (v === undefined) return { $u: 1 };
	if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
	if (typeof v === 'number') {
		if (Object.is(v, -0)) return { $n: '-0' };
		return Number.isFinite(v) ? v : { $n: String(v) };
	}
	if (typeof v === 'bigint') return { $big: String(v) };
	if (typeof v === 'function') return { $f: 1 };
	if (Object.prototype.toString.call(v) === '[object Date]') {
		return { $d: Number.isNaN(Date.prototype.getTime.call(v)) ? 'Invalid Date' : Date.prototype.toISOString.call(v) };
	}
	if (Buffer.isBuffer(v)) return { $b: v.toString('hex') };
	if (Array.isArray(v)) return v.map(encode);
	const out = {};
	for (const key of Object.keys(v)) setOwn(out, key, encode(v[key]));
	return out;
}

function tagOf(v) {
	const keys = Object.keys(v);
	return keys.length === 1 && TAGS.includes(keys[0]) ? keys[0] : null;
}

function decode(v) {
	if (Array.isArray(v)) return v.map(decode);
	if (v === null || typeof v !== 'object') return v;
	switch (tagOf(v)) {
		case '$u':
			return undefined;
		case '$d':
			return new Date(v.$d === 'Invalid Date' ? NaN : v.$d);
		case '$b':
			return Buffer.from(v.$b, 'hex');
		case '$n':
			return v.$n === '-0' ? -0 : Number(v.$n);
		case '$big':
			return BigInt(v.$big);
		case '$f':
			return () => undefined;
		default: {
			const out = {};
			for (const key of Object.keys(v)) setOwn(out, key, decode(v[key]));
			return out;
		}
	}
}

function encodeError(err) {
	return { name: err && typeof err.name === 'string' ? err.name : 'Error', message: err && typeof err.message === 'string' ? err.message : String(err) };
}

function caseRows(cases) {
	return Object.keys(cases).flatMap((fn) => cases[fn].map((args, i) => ({ id: `${fn}#${i}`, fn, args })));
}

function casesHash(cases) {
	const text = JSON.stringify({ frozenNow: FROZEN_NOW_ISO, receivers: RECEIVERS, rows: caseRows(cases) });
	return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

/**
 * Runs every recorded row of the functions `fns` (all when null) on makeIml(receiver) and lists the rows whose answer
 * differs. A gap error (isGapError) passes when gapAllowed(err.fn) and, with `gapRows`, only on a listed row; a listed
 * row must answer with a gap error. A row in `divergences` ({ [id]: { receivers, reason } }) passes when both sides are
 * errors with the same name.
 */
function parityMismatches({ parity, cases, fns = null, makeIml, isGapError, gapAllowed, gapRows = null, divergences = {} }) {
	const inputs = new Map(caseRows(cases).map((r) => [r.id, r]));
	const gapIds = gapRows ? new Set(gapRows) : null;
	const imls = {};
	const out = [];
	for (const row of parity.rows) {
		const c = inputs.get(row.id);
		if (!c) {
			out.push(`${row.id}: recorded, but not in the case list`);
			continue;
		}
		if (fns && !fns.includes(c.fn)) continue;
		for (const [name, recorded] of Object.entries(row.results)) {
			imls[name] = imls[name] || makeIml(RECEIVERS[name]);
			let got;
			try {
				got = { ok: encode(imls[name][c.fn](...decode(c.args))) };
			} catch (err) {
				if (isGapError(err)) {
					if (!gapAllowed(err.fn)) out.push(`${row.id} ${name}: a gap error for ${err.fn}, which is not a declared gap`);
					else if (gapIds && !gapIds.has(row.id)) out.push(`${row.id} ${name}: a gap error on a row that GAP_ROWS does not list`);
					continue;
				}
				got = { err: encodeError(err) };
			}
			if (gapIds && gapIds.has(row.id)) {
				out.push(`${row.id} ${name}: listed in GAP_ROWS, but the shim answered without a gap error`);
				continue;
			}
			const divergence = divergences[row.id];
			if (divergence && (!divergence.receivers || divergence.receivers.includes(name))) {
				if (!(got.err && recorded.err && got.err.name === recorded.err.name)) out.push(`${row.id} ${name}: a divergence row needs an error of the same name on both sides`);
				continue;
			}
			if (!isDeepStrictEqual(got, recorded)) out.push(`${row.id} ${name}: got ${JSON.stringify(got)}, recorded ${JSON.stringify(recorded)}`);
		}
	}
	return out;
}

module.exports = { FROZEN_NOW_ISO, RECEIVERS, PATH_OR_STACK, encode, decode, encodeError, caseRows, casesHash, parityMismatches };
