#!/usr/bin/env node
/**
 * Make Custom App IML Function Test Runner
 *
 * Usage:
 *   node test-function.js <app-slug> <app-version> [function-name ...] [--tz=TIMEZONE] [--engine=shim|runtime]
 *   node test-function.js google-docs 1                     # test all functions
 *   node test-function.js google-docs 1 parseError          # test specific function
 *   node test-function.js google-docs 1 parseError getError # test multiple
 *   node test-function.js monday 2 --tz=Europe/Prague       # custom timezone
 *
 * Reads code.js and test.js from
 *   ~/.make-custom-app/contexts/{slug}-v{version}/functions/ (the same folder for every editor).
 * Uses @integromat/iml from imt-app-runtime for built-in IML functions.
 * In public mode, and in employee mode without a runtime that loads, the built-ins come from the plugin's shim
 * (lib/iml-shim.js); exit 0 means every test passed, 1 a failure or a stop, 2 a test blocked by the shim and none failed.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { getContextsDir } = require('./lib/paths');

const DEFAULT_CONTEXTS_DIR = getContextsDir();
const { readSkillConfig, SECRETS_PATH } = require('./lib/settings');
require('./lib/settings').takeEditorFlagOrExit(process.argv);
const logic = require('./lib/test-function-logic');
const { createImlShim } = require('./lib/iml-shim');

function getRuntimePath() {
	return readSkillConfig('imt-app-runtime-path');
}

function loadImlFunctions(runtimePath, tz) {
	const imlPath = path.join(runtimePath, 'node_modules', '@integromat', 'iml');
	if (!fs.existsSync(imlPath)) {
		console.error(`@integromat/iml not found at: ${imlPath}`);
		console.error('Run "npm install" in the imt-app-runtime directory first.');
		return null;
	}

	const { IML } = require(imlPath);
	const imlFunctions = {};

	for (const [name, { value: fn }] of Object.entries(IML.FUNCTIONS)) {
		imlFunctions[name] = fn.bind({ timezone: tz });
	}

	// Sources are progressively migrating from lib/iml/*.js to TypeScript, whose
	// compiled output lands in dist/lib/iml. Plain `require` cannot read the .ts
	// source, so probe both locations and take whichever resolves.
	const runtimeImlDirs = [
		path.join(runtimePath, 'lib', 'iml'),
		path.join(runtimePath, 'dist', 'lib', 'iml'),
	];

	function requireRuntimeIml(baseName) {
		for (const dir of runtimeImlDirs) {
			const filePath = path.join(dir, `${baseName}.js`);
			if (!fs.existsSync(filePath)) continue;
			try {
				return require(filePath);
			} catch (_) { /* try the next location */ }
		}
		return null;
	}

	function pickCallable(mod, exportName) {
		if (typeof mod === 'function') return mod;
		if (mod && typeof mod[exportName] === 'function') return mod[exportName];
		if (mod && typeof mod.default === 'function') return mod.default;
		return null;
	}

	const runtimeFnNames = ['jwt', 'cryptoSign', 'errorFactory'];
	const runtimeFnFiles = { cryptoSign: 'sign' };
	const missingRuntimeFns = [];

	let runtimeFnCount = 0;
	for (const fnName of runtimeFnNames) {
		const fn = pickCallable(requireRuntimeIml(runtimeFnFiles[fnName] || fnName), fnName);
		if (fn) {
			imlFunctions[fnName] = fn;
			runtimeFnCount++;
		} else {
			missingRuntimeFns.push(fnName);
		}
	}

	const generateJwtWithKeyId = pickCallable(requireRuntimeIml('jwk'), 'generateJwtWithKeyId');
	if (generateJwtWithKeyId) {
		imlFunctions.generateJwtWithKeyId = generateJwtWithKeyId;
		runtimeFnCount++;
	} else {
		missingRuntimeFns.push('generateJwtWithKeyId');
	}

	// Mirrors lib/iml/mime.ts (`m.getType(file) || undefined`). Implemented here
	// rather than loaded from the runtime because that module now only ships as
	// TypeScript, and its checked-in dist build predates mime v4's default export.
	try {
		const mimePkg = require(path.join(runtimePath, 'node_modules', 'mime'));
		const mimeApi = mimePkg && typeof mimePkg.getType === 'function' ? mimePkg : mimePkg.default;
		if (mimeApi && typeof mimeApi.getType === 'function') {
			imlFunctions.mime = (file) => mimeApi.getType(file) || undefined;
			runtimeFnCount++;
		} else {
			missingRuntimeFns.push('mime');
		}
	} catch (_) {
		missingRuntimeFns.push('mime');
	}

	imlFunctions.pop = (arr) => Array.isArray(arr) ? arr.pop() : undefined;
	imlFunctions.shift = (arr) => Array.isArray(arr) ? arr.shift() : undefined;
	imlFunctions.isArray = (arr) => Array.isArray(arr);
	imlFunctions.parseJSON = (string) => JSON.parse(string);
	imlFunctions.createJSON = (object) => JSON.stringify(object);
	runtimeFnCount += 5;

	try {
		const xmlbuilder = require(path.join(runtimePath, 'node_modules', 'xmlbuilder'));
		imlFunctions.createXML = (object) => xmlbuilder.create(object).end({ pretty: true });
		runtimeFnCount++;
	} catch (_) { /* xmlbuilder not available */ }

	try {
		const xmlbuilder2 = require(path.join(runtimePath, 'node_modules', 'xmlbuilder2'));
		imlFunctions.parseXML = (string) => xmlbuilder2.convert(string, { format: 'object' });
		runtimeFnCount++;
	} catch (_) { /* xmlbuilder2 not available */ }

	if (runtimeFnCount > 0) {
		console.log(`IML: ${runtimeFnCount} runtime-provided functions loaded (mime, jwt, cryptoSign, etc.)`);
	}
	if (missingRuntimeFns.length > 0) {
		console.log(`IML: ⚠ ${missingRuntimeFns.join(', ')} unavailable in imt-app-runtime — tests calling them will fail`);
	}

	return imlFunctions;
}

function loadAppFunctions(functionsDir) {
	const functions = {};
	if (!fs.existsSync(functionsDir)) return functions;

	for (const name of fs.readdirSync(functionsDir)) {
		const dir = path.join(functionsDir, name);
		if (!fs.statSync(dir).isDirectory()) continue;
		const codeFile = path.join(dir, 'code.js');
		if (fs.existsSync(codeFile)) {
			const testFile = path.join(dir, 'test.js');
			const hasTest = fs.existsSync(testFile);
			functions[name] = {
				code: fs.readFileSync(codeFile, 'utf-8'),
				testCode: hasTest ? fs.readFileSync(testFile, 'utf-8') : undefined,
				hasTest,
			};
		}
	}
	return functions;
}

function readIfExists(file) {
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
}

const USAGE = [
	'Usage: node test-function.js <app-slug> <app-version> [function-name ...] [--tz=TIMEZONE] [--engine=shim|runtime]',
	'',
	'Examples:',
	'  node test-function.js google-docs 1                     # test all functions',
	'  node test-function.js google-docs 1 parseError          # test one function',
	'  node test-function.js google-docs 1 parseError getError # test multiple',
	'  node test-function.js monday 2 --tz=Europe/Prague       # custom timezone',
	'',
	'Default timezone: UTC (matches Make Apps SDK extension)',
];

const args = logic.parseArgs(process.argv.slice(2));

if (args.error || !args.slug || !args.version) {
	if (args.error) console.error(args.error);
	for (const line of USAGE) console.log(line);
	process.exit(1);
}

const settings = require('./lib/mode').requireMode();

const functionsDir = path.join(DEFAULT_CONTEXTS_DIR, `${args.slug}-v${args.version}`, 'functions');

if (!fs.existsSync(functionsDir)) {
	console.error(`Functions directory not found: ${functionsDir}`);
	console.error(`Run download-app.js first: node download-app.js ${args.slug} ${args.version}`);
	process.exit(1);
}

const runtimePath = getRuntimePath();
const wantsRuntime = settings.mode === 'employee' && args.engine !== 'shim';
let runtimeBuiltins = null;
if (wantsRuntime && runtimePath) {
	try {
		runtimeBuiltins = loadImlFunctions(runtimePath, args.tz);
	} catch {
		runtimeBuiltins = null;
	}
}

const choice = logic.chooseEngine({
	mode: settings.mode,
	engineFlag: args.engine,
	runtimePathSet: Boolean(runtimePath),
	runtimeLoaded: Boolean(runtimeBuiltins),
	secretsPath: SECRETS_PATH,
});
if (choice.error) {
	console.error(choice.error);
	process.exit(1);
}

const environment = { timezone: args.tz };
const gaps = [];
let builtins;
let common = {};

if (choice.engine === 'runtime') {
	builtins = runtimeBuiltins;
	console.log(`IML: @integromat/iml loaded (${Object.keys(builtins).length} built-in functions)`);
	console.log(`Testing: ${args.slug} v${args.version}`);
	console.log(`Timezone: ${args.tz}`);
	console.log(`Path: ${functionsDir}`);
} else {
	// The parity file was recorded in UTC, so the shim and the function code run in UTC, not in the zone of this computer.
	process.env.TZ = 'UTC';
	const contextDir = path.dirname(functionsDir);
	const { manifest, known } = logic.manifestOf(readIfExists(path.join(contextDir, 'metadata.json')));
	const parsed = logic.commonOf(readIfExists(path.join(contextDir, 'common.imljson')));
	common = parsed.common;
	let zoneKnown = true;
	builtins = createImlShim({
		timezone: args.tz,
		manifest,
		onGap: (fn, detail) => gaps.push({ fn, detail }),
		onWarning: (kind) => {
			if (kind === 'unknown-zone') zoneKnown = false;
		},
	});
	const header = logic.shimHeaderLines({
		fallbackLine: choice.line,
		slug: args.slug,
		version: args.version,
		timezone: args.tz,
		zoneKnown,
		manifest,
		manifestKnown: known,
		commonState: parsed.state,
		mode: settings.mode,
		functionsDir,
	});
	for (const line of header) console.log(line);
}

const result = logic.runSuite({
	functions: loadAppFunctions(functionsDir),
	targetNames: args.names,
	engine: choice.engine,
	builtins,
	environment,
	common,
	assert,
	print: (line) => console.log(line),
	gaps,
});
for (const line of logic.tailLines({ engine: choice.engine, result })) console.log(line);
process.exit(logic.exitCode(result));
