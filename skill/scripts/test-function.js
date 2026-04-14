#!/usr/bin/env node
/**
 * Make Custom App IML Function Test Runner
 *
 * Usage:
 *   node test-function.js <app-slug> <app-version> [function-name ...] [--tz=TIMEZONE]
 *   node test-function.js google-docs 1                     # test all functions
 *   node test-function.js google-docs 1 parseError          # test specific function
 *   node test-function.js google-docs 1 parseError getError # test multiple
 *   node test-function.js monday 2 --tz=Europe/Prague       # custom timezone
 *
 * Reads code.js and test.js from ~/.cursor/make-app-contexts/{slug}-v{version}/functions/
 * Uses @integromat/iml from imt-app-runtime for built-in IML functions.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');

const DEFAULT_CONTEXTS_DIR = path.join(os.homedir(), '.cursor/make-app-contexts');
const SKILL_MD_PATH = path.join(os.homedir(), '.cursor/skills/make-custom-app/SKILL.md');

function getRuntimePath() {
	if (!fs.existsSync(SKILL_MD_PATH)) return null;
	const content = fs.readFileSync(SKILL_MD_PATH, 'utf-8');
	const lines = content.trim().split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const match = lines[i].match(/^imt-app-runtime-path:\s*(.+)$/);
		if (match) return match[1].trim();
	}
	return null;
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

	const runtimeImlDir = path.join(runtimePath, 'lib', 'iml');
	const runtimeFnMap = {
		mime: 'mime.js',
		jwt: 'jwt.js',
		cryptoSign: 'sign.js',
		errorFactory: 'errorFactory.js',
	};

	let runtimeFnCount = 0;
	for (const [fnName, fileName] of Object.entries(runtimeFnMap)) {
		const filePath = path.join(runtimeImlDir, fileName);
		if (fs.existsSync(filePath)) {
			try {
				imlFunctions[fnName] = require(filePath);
				runtimeFnCount++;
			} catch (_) { /* skip if dependency missing */ }
		}
	}

	const jwkPath = path.join(runtimeImlDir, 'jwk.js');
	if (fs.existsSync(jwkPath)) {
		try {
			const jwk = require(jwkPath);
			imlFunctions.generateJwtWithKeyId = jwk.generateJwtWithKeyId;
			runtimeFnCount++;
		} catch (_) { /* skip if dependency missing */ }
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
			functions[name] = {
				code: fs.readFileSync(codeFile, 'utf-8'),
				testFile: path.join(dir, 'test.js'),
				hasTest: fs.existsSync(path.join(dir, 'test.js')),
			};
		}
	}
	return functions;
}

function runTests(functionsDir, targetNames, imlBuiltins, timezone) {
	const functions = loadAppFunctions(functionsDir);
	const allNames = Object.keys(functions);

	if (allNames.length === 0) {
		console.log('No functions found.');
		return { total: 0, passed: 0, failed: 0, skipped: 0, errors: [] };
	}

	const namesToTest = targetNames.length > 0
		? targetNames.filter((n) => {
				if (!functions[n]) {
					console.log(`\n⚠ Function "${n}" not found. Available: ${allNames.join(', ')}`);
					return false;
				}
				return true;
			})
		: allNames;

	const environment = { timezone };

	const iml = { ...imlBuiltins };

	const loadedNames = [];
	const failedNames = [];

	for (const [name, fn] of Object.entries(functions)) {
		try {
			const codeToWrap = `(${fn.code}).apply({timezone: environment.timezone}, __arguments__)`;
			iml[name] = (...args) => {
				const execFn = new Function('environment', '__arguments__', 'iml', 'debug', `return ${codeToWrap}`);
				return execFn(environment, args, iml, () => {});
			};
			loadedNames.push(name);
		} catch (e) {
			failedNames.push(name);
			console.error(`  ⚠ Failed to load ${name}/code.js: ${e.message}`);
		}
	}

	console.log(`Functions: ${loadedNames.length} loaded${failedNames.length ? `, ${failedNames.length} failed (${failedNames.join(', ')})` : ''}`);
	console.log(`  → ${loadedNames.join(', ')}`);

	let totalTests = 0;
	let passedTests = 0;
	let failedTests = 0;
	let skippedFunctions = 0;
	const errors = [];

	for (const name of namesToTest) {
		const fn = functions[name];

		console.log(`\n━━━ ${name} ━━━`);

		if (!fn.hasTest) {
			console.log('  ⏭ No test.js found — skipped');
			skippedFunctions++;
			continue;
		}

		const testCode = fs.readFileSync(fn.testFile, 'utf-8');
		if (!testCode || testCode.trim() === 'undefined') {
			console.log('  ⏭ test.js is empty — skipped');
			skippedFunctions++;
			continue;
		}

		const testResults = [];

		const itFn = (description, testFn) => {
			testResults.push({ description, testFn });
		};
		const describeFn = (_description, suiteFn) => {
			suiteFn();
		};

		const codeToRun = `${fn.code}\r\n\r\n/* === TEST CODE === */\r\n\r\n${testCode}`;

		try {
			const runFn = new Function('assert', 'iml', 'it', 'describe', 'environment', 'debug', codeToRun);
			runFn(assert, iml, itFn, describeFn, environment, () => {});
		} catch (e) {
			console.log(`  ✗ Failed to parse test: ${e.message}`);
			errors.push({ function: name, test: '(parse)', error: e.message });
			failedTests++;
			totalTests++;
			continue;
		}

		for (const { description, testFn } of testResults) {
			totalTests++;
			try {
				testFn();
				passedTests++;
				console.log(`  ✓ ${description}`);
			} catch (e) {
				failedTests++;
				const msg = e.code === 'ERR_ASSERTION'
					? `Expected: ${JSON.stringify(e.expected)}\n            Actual:   ${JSON.stringify(e.actual)}`
					: e.message;
				console.log(`  ✗ ${description}`);
				console.log(`          ${msg}`);
				errors.push({ function: name, test: description, error: msg });
			}
		}
	}

	console.log('\n════════════════════════════════════════');
	console.log(`Results: ${passedTests} passed, ${failedTests} failed, ${skippedFunctions} skipped (${totalTests} total tests)`);
	if (errors.length > 0) {
		console.log('\nFailed tests:');
		for (const e of errors) {
			console.log(`  ✗ ${e.function} › ${e.test}`);
		}
	}
	console.log('════════════════════════════════════════');

	return { total: totalTests, passed: passedTests, failed: failedTests, skipped: skippedFunctions, errors };
}

const args = process.argv.slice(2);
const tzArg = args.find(a => a.startsWith('--tz='));
const positional = args.filter(a => !a.startsWith('--'));
const [slug, version, ...targetNames] = positional;

if (!slug || !version) {
	console.log('Usage: node test-function.js <app-slug> <app-version> [function-name ...] [--tz=TIMEZONE]');
	console.log('');
	console.log('Examples:');
	console.log('  node test-function.js google-docs 1                     # test all functions');
	console.log('  node test-function.js google-docs 1 parseError          # test one function');
	console.log('  node test-function.js google-docs 1 parseError getError # test multiple');
	console.log('  node test-function.js monday 2 --tz=Europe/Prague       # custom timezone');
	console.log('');
	console.log('Default timezone: UTC (matches Make Apps SDK extension)');
	process.exit(1);
}

const functionsDir = path.join(DEFAULT_CONTEXTS_DIR, `${slug}-v${version}`, 'functions');

if (!fs.existsSync(functionsDir)) {
	console.error(`Functions directory not found: ${functionsDir}`);
	console.error(`Run download-app.js first: node download-app.js ${slug} ${version}`);
	process.exit(1);
}

const timezone = tzArg ? tzArg.split('=')[1] : 'UTC';
const runtimePath = getRuntimePath();
let imlBuiltins = {};

if (runtimePath && fs.existsSync(runtimePath)) {
	const loaded = loadImlFunctions(runtimePath, timezone);
	if (loaded) {
		imlBuiltins = loaded;
		console.log(`IML: @integromat/iml loaded (${Object.keys(imlBuiltins).length} built-in functions)`);
	} else {
		console.log('IML: Failed to load @integromat/iml — using passthrough stubs');
	}
} else {
	console.log('IML: imt-app-runtime path not configured — using passthrough stubs');
	console.log('     Set imt-app-runtime-path in SKILL.md for full IML function support');
}

console.log(`Testing: ${slug} v${version}`);
console.log(`Timezone: ${timezone}`);
console.log(`Path: ${functionsDir}`);

const result = runTests(functionsDir, targetNames, imlBuiltins, timezone);
process.exit(result.failed > 0 ? 1 : 0);
