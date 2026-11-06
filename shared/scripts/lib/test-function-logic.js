/**
 * test-function-logic.js: the decisions of test-function.js (spec 3.1): the arguments, the engine choice, the namespace
 * and globals of each engine, the runner with its blocked and templates-only classification, the header and tail lines
 * and the exit code.
 *
 * Role: pure functions only, apart from runSuite, which runs the app's code.js and test.js text it is given and prints
 * through the `print` it is given: no file access, no network, no process.exit.
 */
const { TEMPLATE_ONLY } = require('./iml-shim');

const ENGINES = ['shim', 'runtime'];
const SHADOWED_GLOBALS = ['require', 'process', 'setTimeout', 'setInterval', 'setImmediate', 'fetch'];

const BAD_ENGINE_ERROR = 'ERROR: --engine must be shim or runtime.';
const PUBLIC_RUNTIME_ERROR = "ERROR: --engine=runtime is for Make employees only. Run the command without --engine to use the plugin's shim.";
const EMPLOYEE_RUNTIME_ERROR = "ERROR: --engine=runtime needs a runtime that loads from imt-app-runtime-path. Run the command without --engine to use the plugin's shim.";
const PATH_NOT_LOADED_LINE = "IML: imt-app-runtime-path is set but the runtime did not load, so the plugin's shim is used.";
const SHIM_LINE = "IML: the plugin's built-in shim (83 functions, written from the public Make docs). It is not the Make engine.";
const ENGINE_LINE = 'Engine: shim. A pass here is a local check; the final check is a scenario run in Make.';
const SEPARATOR = '════════════════════════════════════════';

const pathMissingLine = (secretsPath) => `IML: imt-app-runtime-path is not set, so the plugin's shim is used. Set it in ${secretsPath} to test against the runtime.`;

/**
 * argv without the editor flag: `<slug> <version> [name ...] [--tz=Zone] [--engine=shim|runtime]`. Both flags also take
 * their value after a space, the first of each counts, a bare --engine is a bad engine; other flags are ignored.
 */
function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const flag = ['--tz', '--engine'].find((f) => arg === f || arg.startsWith(`${f}=`));
		if (!flag) {
			if (!arg.startsWith('--')) positional.push(arg);
			continue;
		}
		let value;
		if (arg !== flag) value = flag === '--tz' ? arg.split('=')[1] : arg.slice('--engine='.length);
		else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) value = argv[++i];
		else value = null;
		if (!Object.hasOwn(flags, flag)) flags[flag] = value;
	}
	const [slug, version, ...names] = positional;
	const engine = Object.hasOwn(flags, '--engine') ? flags['--engine'] : null;
	const bad = Object.hasOwn(flags, '--engine') && !ENGINES.includes(engine);
	return { slug, version, names, tz: flags['--tz'] ?? 'UTC', engine: bad ? null : engine, error: bad ? BAD_ENGINE_ERROR : null };
}

/** The engine table of spec 3.1: `line` is printed before the shim header, `error` stops the run with exit 1. */
function chooseEngine({ mode, engineFlag, runtimePathSet, runtimeLoaded, secretsPath }) {
	if (engineFlag === 'shim') return { engine: 'shim', line: null, error: null };
	if (mode === 'public') {
		if (engineFlag === 'runtime') return { engine: null, line: null, error: PUBLIC_RUNTIME_ERROR };
		return { engine: 'shim', line: null, error: null };
	}
	if (runtimePathSet && runtimeLoaded) return { engine: 'runtime', line: null, error: null };
	if (engineFlag === 'runtime') return { engine: null, line: null, error: EMPLOYEE_RUNTIME_ERROR };
	return { engine: 'shim', line: runtimePathSet ? PATH_NOT_LOADED_LINE : pathMissingLine(secretsPath), error: null };
}

function parsedJson(text) {
	try {
		return JSON.parse(String(text).replace(/^\uFEFF/, ''));
	} catch {
		return undefined;
	}
}

/** metadata.json text (null when the file is missing): its manifestVersion, else 1 with known false. */
function manifestOf(metadataText) {
	const meta = metadataText == null ? null : parsedJson(metadataText);
	const value = meta && typeof meta === 'object' ? meta.manifestVersion : undefined;
	return Number.isInteger(value) && value >= 1 ? { manifest: value, known: true } : { manifest: 1, known: false };
}

/** common.imljson text (null when the file is missing): the parsed object, else {}. */
function commonOf(text) {
	if (text == null) return { common: {}, state: 'none' };
	const value = parsedJson(text);
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return { common: {}, state: 'unparsable' };
	return { common: value, state: 'file' };
}

function timezoneLine(timezone, zoneKnown) {
	if (zoneKnown) return `Timezone: ${timezone} (Make uses the time zone of the module; pass --tz=<Zone> to match)`;
	return `Timezone: ${timezone} is not a time zone this computer knows, so the date functions use UTC. Make also falls back without an error; check the zone name.`;
}

function manifestLine(manifest, manifestKnown) {
	if (!manifestKnown) return 'Manifest: 1 (metadata.json has no manifestVersion; run download-app.js to read it)';
	return manifest >= 2 ? `Manifest: ${manifest} (a missing value stays undefined)` : 'Manifest: 1 (a missing value becomes null)';
}

function commonLine(commonState, mode) {
	if (commonState === 'none') return 'Common: none (no common.imljson in the local copy)';
	if (commonState === 'unparsable') return 'Common: none (common.imljson is not a JSON object, so common is {})';
	return mode === 'public' ? 'Common: common.imljson (values masked in public mode)' : 'Common: common.imljson';
}

/** The header of a shim run, in the order of the spec 3.1 sample, after the employee fallback line when there is one. */
function shimHeaderLines({ fallbackLine, slug, version, timezone, zoneKnown, manifest, manifestKnown, commonState, mode, functionsDir }) {
	return [
		...(fallbackLine ? [fallbackLine] : []),
		SHIM_LINE,
		`Testing: ${slug} v${version}`,
		timezoneLine(timezone, zoneKnown),
		manifestLine(manifest, manifestKnown),
		commonLine(commonState, mode),
		`Path: ${functionsDir}`,
	];
}

function functionParams(engine) {
	return engine === 'shim' ? ['environment', '__arguments__', 'iml', 'debug', 'common', 'Buffer', ...SHADOWED_GLOBALS] : ['environment', '__arguments__', 'iml', 'debug'];
}

function testParams(engine) {
	return engine === 'shim' ? ['assert', 'iml', 'it', 'describe', 'environment', 'debug', 'common', 'Buffer', ...SHADOWED_GLOBALS] : ['assert', 'iml', 'it', 'describe', 'environment', 'debug'];
}

/** In shim mode the file runs one function deeper, so its own let or const may reuse a name only the shim adds. */
function testBody(engine, codeToRun) {
	if (engine !== 'shim') return codeToRun;
	const shared = testParams('runtime').join(', ');
	return `return (function (${shared}) {\n${codeToRun}\n})(${shared});`;
}

/** The values after the shared ones that shim mode passes for common, Buffer and the shadowed globals. */
function shimValues(engine, common) {
	return engine === 'shim' ? [common, Buffer, ...SHADOWED_GLOBALS.map(() => undefined)] : [];
}

function buildNamespace({ engine, builtins }) {
	return engine === 'shim' ? Object.assign(Object.create(null), builtins) : { ...builtins };
}

function blockedLine({ fn, detail }) {
	return `blocked: iml.${fn}${detail ? ` ${detail}` : ''} is not in the plugin's shim, so this test cannot run here. Check it in a scenario run.`;
}

function templateOnlyHint(err) {
	const m = err instanceof TypeError ? /^iml\.(\w+) is not a function$/.exec(err.message) : null;
	if (!m || !Object.hasOwn(TEMPLATE_ONLY, m[1])) return null;
	return `${err.message}. ${m[1]} exists only in IML templates ({{...}}), not in custom function code: use ${TEMPLATE_ONLY[m[1]]}.`;
}

function errorText(err, engine) {
	return (engine === 'shim' && templateOnlyHint(err)) || (err ? err.message : String(err));
}

function failureMessage(err, engine) {
	if (err && err.code === 'ERR_ASSERTION') return `Expected: ${JSON.stringify(err.expected)}\n            Actual:   ${JSON.stringify(err.actual)}`;
	return errorText(err, engine);
}

function exitCode({ failed, blocked, notFound }) {
	if (failed > 0 || notFound.length > 0) return 1;
	return blocked > 0 ? 2 : 0;
}

/**
 * Runs the tests of `functions` ({ name: { code, testCode, hasTest } }), all of them or `targetNames`. `gaps` is the
 * array the shim's onGap fills; a test during which it grows is blocked, also when it catches the error or fails an
 * assertion (spec 3.1), and so is a whole test.js whose top level makes it grow, as one test named (load).
 */
function runSuite({ functions, targetNames, engine, builtins, environment, common, assert, print, gaps }) {
	const result = { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, errors: [], blockedFns: [], notFound: [], noFunctions: false };
	const allNames = Object.keys(functions);

	if (allNames.length === 0) {
		print('No functions found.');
		result.notFound.push(...targetNames);
		result.noFunctions = true;
		return result;
	}

	const namesToTest = targetNames.length > 0
		? targetNames.filter((n) => {
				if (!Object.hasOwn(functions, n)) {
					print(`\n⚠ Function "${n}" not found. Available: ${allNames.join(', ')}`);
					result.notFound.push(n);
					return false;
				}
				return true;
			})
		: allNames;

	const iml = buildNamespace({ engine, builtins });
	const extra = shimValues(engine, common);

	for (const [name, fn] of Object.entries(functions)) {
		const codeToWrap = `(${fn.code}).apply({timezone: environment.timezone}, __arguments__)`;
		iml[name] = (...args) => {
			const execFn = new Function(...functionParams(engine), `return ${codeToWrap}`);
			return execFn(environment, args, iml, () => {}, ...extra);
		};
	}

	print(`Functions: ${allNames.length} loaded`);
	print(`  → ${allNames.join(', ')}`);

	const block = (description) => {
		result.blocked++;
		print(`  ⊘ ${description}`);
		print(`          ${blockedLine(gaps[0])}`);
		for (const { fn } of gaps) if (!result.blockedFns.includes(fn)) result.blockedFns.push(fn);
	};

	for (const name of namesToTest) {
		const fn = functions[name];

		print(`\n━━━ ${name} ━━━`);

		if (!fn.hasTest) {
			print('  ⏭ No test.js found — skipped');
			result.skipped++;
			continue;
		}

		const testCode = fn.testCode;
		if (!testCode || testCode.trim() === 'undefined') {
			print('  ⏭ test.js is empty — skipped');
			result.skipped++;
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

		gaps.length = 0;
		let loadError = null;
		let loadFailed = false;
		try {
			const runFn = new Function(...testParams(engine), testBody(engine, codeToRun));
			runFn(assert, iml, itFn, describeFn, environment, () => {}, ...extra);
		} catch (e) {
			loadFailed = true;
			loadError = e;
		}
		if (gaps.length > 0) {
			result.total++;
			block('(load)');
			continue;
		}
		if (loadFailed) {
			const msg = errorText(loadError, engine);
			print(`  ✗ Failed to parse test: ${msg}`);
			result.errors.push({ function: name, test: '(parse)', error: msg });
			result.failed++;
			result.total++;
			continue;
		}

		for (const { description, testFn } of testResults) {
			result.total++;
			gaps.length = 0;
			let error = null;
			let threw = false;
			try {
				testFn();
			} catch (e) {
				threw = true;
				error = e;
			}
			if (gaps.length > 0) {
				block(description);
			} else if (threw) {
				result.failed++;
				const msg = failureMessage(error, engine);
				print(`  ✗ ${description}`);
				print(`          ${msg}`);
				result.errors.push({ function: name, test: description, error: msg });
			} else {
				result.passed++;
				print(`  ✓ ${description}`);
			}
		}
	}

	return result;
}

/**
 * The lines after the run. Shim mode: separator, Failed tests, Not found, Results, Blocked by the shim, Engine last.
 * Runtime mode: today's tail with Not found before Results, and none after "No functions found." when no name was given.
 */
function tailLines({ engine, result }) {
	const failedBlock = result.errors.length > 0 ? ['Failed tests:', ...result.errors.map((e) => `  ✗ ${e.function} › ${e.test}`)] : [];
	const notFound = result.notFound.length > 0 ? [`Not found: ${result.notFound.join(', ')}`] : [];
	if (engine === 'shim') {
		return [
			'',
			SEPARATOR,
			...failedBlock,
			...notFound,
			`Results: ${result.passed} passed, ${result.failed} failed, ${result.blocked} blocked by the shim, ${result.skipped} skipped (${result.total} total tests)`,
			...(result.blocked > 0 ? [`Blocked by the shim: ${result.blockedFns.map((fn) => `iml.${fn}`).join(', ')}`] : []),
			ENGINE_LINE,
		];
	}
	if (result.noFunctions && notFound.length === 0) return [];
	return [
		'',
		SEPARATOR,
		...notFound,
		`Results: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped (${result.total} total tests)`,
		...(failedBlock.length > 0 ? ['', ...failedBlock] : []),
		SEPARATOR,
	];
}

module.exports = {
	ENGINES,
	SHADOWED_GLOBALS,
	SHIM_LINE,
	ENGINE_LINE,
	parseArgs,
	chooseEngine,
	manifestOf,
	commonOf,
	shimHeaderLines,
	functionParams,
	testParams,
	buildNamespace,
	blockedLine,
	templateOnlyHint,
	failureMessage,
	runSuite,
	tailLines,
	exitCode,
};
