#!/usr/bin/env node
'use strict';
/**
 * record-iml-parity.js (repo-only, maintainer tool, CI never runs it): records what the IML engine of a local runtime
 * clone answers for every case of shared/scripts/lib/__tests__/iml-shim-cases.js under the four receivers of
 * iml-shim-codec.js, with TZ=UTC and the clock frozen at FROZEN_NOW_ISO, into iml-shim-parity.json.
 *
 *   node tools/record-iml-parity.js --runtime <runtime clone> --m2-flag <name> [--cases <file>] [--out <file>]
 *
 * --m2-flag is the receiver property that turns on the manifest 2 empty-value rule in the engine; the name is never
 * stored. The engine and the jwt and mime helpers are reached the way test-function.js loads them in employee mode.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'shared', 'scripts', 'lib', '__tests__');
const USAGE = 'Usage: node tools/record-iml-parity.js --runtime <runtime clone> --m2-flag <name> [--cases <file>] [--out <file>]';
const OPTIONS = { '--runtime': 'runtime', '--m2-flag': 'm2Flag', '--cases': 'cases', '--out': 'out' };

function parseArgs(argv) {
	const opts = { runtime: null, m2Flag: null, cases: path.join(TESTS_DIR, 'iml-shim-cases.js'), out: path.join(TESTS_DIR, 'iml-shim-parity.json') };
	for (let i = 0; i < argv.length; i += 2) {
		const key = OPTIONS[argv[i]];
		if (!key) return { error: `ERROR: unknown argument ${argv[i]}` };
		const value = argv[i + 1];
		if (!value || value.startsWith('--')) return { error: `ERROR: ${argv[i]} needs a value` };
		opts[key] = value;
	}
	if (!opts.runtime) return { error: 'ERROR: --runtime is required' };
	if (!opts.m2Flag) return { error: 'ERROR: --m2-flag is required' };
	return { runtime: path.resolve(opts.runtime), m2Flag: opts.m2Flag, cases: path.resolve(opts.cases), out: path.resolve(opts.out) };
}

function freezeClock(nowMs) {
	const RealDate = Date;
	class FrozenDate extends RealDate {
		constructor(...args) {
			if (args.length === 0) super(nowMs);
			else super(...args);
		}
		static now() {
			return nowMs;
		}
	}
	global.Date = FrozenDate;
}

function pickCallable(mod, name) {
	if (typeof mod === 'function') return mod;
	if (mod && typeof mod[name] === 'function') return mod[name];
	if (mod && typeof mod.default === 'function') return mod.default;
	return null;
}

function requireFirst(files) {
	for (const file of files) {
		if (!fs.existsSync(file)) continue;
		try {
			return require(file);
		} catch {
			/* try the next location */
		}
	}
	return null;
}

function loadMime(runtime) {
	try {
		const pkg = require(path.join(runtime, 'node_modules', 'mime'));
		const api = pkg && typeof pkg.getType === 'function' ? pkg : pkg && pkg.default;
		return api && typeof api.getType === 'function' ? (file) => api.getType(file) || undefined : null;
	} catch {
		return null;
	}
}

function loadEngine(runtime) {
	const imlPath = path.join(runtime, 'node_modules', '@integromat', 'iml');
	if (!fs.existsSync(imlPath)) throw new Error(`no IML engine at ${imlPath}`);
	const { IML } = require(imlPath);
	const jwt = pickCallable(requireFirst([path.join(runtime, 'lib', 'iml', 'jwt.js'), path.join(runtime, 'dist', 'lib', 'iml', 'jwt.js')]), 'jwt');
	return { table: IML.FUNCTIONS, jwt, mime: loadMime(runtime) };
}

function record({ runtime, m2Flag, cases, recordedAt }) {
	const codec = require(path.join(TESTS_DIR, 'iml-shim-codec.js'));
	const { CASES } = require(cases);
	const engine = loadEngine(runtime);
	const rows = [];
	for (const c of codec.caseRows(CASES)) {
		const fn = c.fn === 'jwt' ? engine.jwt : c.fn === 'mime' ? engine.mime : engine.table[c.fn] && engine.table[c.fn].value;
		if (typeof fn !== 'function') throw new Error(`the engine has no function ${c.fn}`);
		const results = {};
		for (const [name, r] of Object.entries(codec.RECEIVERS)) {
			const receiver = r.manifest >= 2 ? { timezone: r.timezone, [m2Flag]: true } : { timezone: r.timezone };
			try {
				results[name] = { ok: codec.encode(fn.apply(receiver, codec.decode(c.args))) };
			} catch (err) {
				results[name] = { err: codec.encodeError(err) };
			}
			const text = JSON.stringify(results[name]);
			if (text.includes(runtime) || codec.PATH_OR_STACK.test(text)) {
				throw new Error(`row ${c.id} (${name}) has a file path, a package name or a stack frame in its result; take the case out of the list`);
			}
		}
		rows.push({ id: c.id, results });
	}
	return { recordedAt, casesHash: codec.casesHash(CASES), rows };
}

function formatDoc(doc) {
	return `{\n"recordedAt": ${JSON.stringify(doc.recordedAt)},\n"casesHash": ${JSON.stringify(doc.casesHash)},\n"rows": [\n${doc.rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n}\n`;
}

function main(argv = process.argv.slice(2)) {
	const opts = parseArgs(argv);
	if (opts.error) {
		console.error(`${opts.error}\n${USAGE}`);
		return 1;
	}
	if (process.env.TZ !== 'UTC') {
		const child = spawnSync(process.execPath, [...process.execArgv, __filename, ...argv], { stdio: 'inherit', env: { ...process.env, TZ: 'UTC' } });
		return child.status === null ? 1 : child.status;
	}
	const recordedAt = new Date().toISOString().slice(0, 10);
	const codec = require(path.join(TESTS_DIR, 'iml-shim-codec.js'));
	freezeClock(Date.parse(codec.FROZEN_NOW_ISO));
	let doc;
	try {
		doc = record({ ...opts, recordedAt });
	} catch (err) {
		console.error(`ERROR: ${err.message}`);
		return 1;
	}
	fs.writeFileSync(opts.out, formatDoc(doc));
	console.log(`Recorded ${doc.rows.length} rows, ${Object.keys(codec.RECEIVERS).length} receivers each: ${path.relative(ROOT, opts.out)}`);
	return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { USAGE, parseArgs, record, formatDoc, main };
