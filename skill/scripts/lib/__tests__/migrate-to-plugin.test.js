'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const REAL_HOME = os.homedir();
const TEST_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p5-old-int-')));
for (const name of ['home', 'tmp', 'claude-config']) fs.mkdirSync(path.join(TEST_ROOT, name));
process.env.HOME = process.env.USERPROFILE = path.join(TEST_ROOT, 'home');
process.env.TMPDIR = process.env.TEMP = process.env.TMP = path.join(TEST_ROOT, 'tmp');
process.env.CLAUDE_CONFIG_DIR = path.join(TEST_ROOT, 'claude-config');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { once } = require('node:events');
const crypto = require('crypto');
const { cacheKey, JIRA_BASE_URL } = require('../access-guard-logic');
const { CLAUDE_VERSION_PATTERN, readPluginStatus, verifyInstall, parseMarketplaceList, listContextFiles, findClaudeBinary } = require('../migrate-logic');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SKILL_SOURCE = path.join(REPO_ROOT, 'skill');
const BASE_COMMIT = 'cd8f60b';
const ID = 'make-custom-app@make-custom-app';
const DAY = 24 * 3600000;
const POSIX_ONLY = { skip: process.platform === 'win32' };
const BLOCK_NETWORK = path.join(TEST_ROOT, 'block-network.js');
const SECTION_BYTES = 970;
const PINNED_SECTION =
	'## Plugin migration\n\n' +
	'check-setup.js can print one `PLUGIN_MIGRATION: <state> | <text>` line. Act on it before other work, also when check-setup exits 1 (the plugin needs the same setup). `ask`: ask the user once, yes or no: "Install the make-custom-app plugin? It replaces this skill and copies your MCP keys and app contexts; nothing is deleted." Never answer for the user. On yes, run the `migrate-to-plugin.js` command printed on the line (Shell, `required_permissions: ["all"]`, `block_until_ms: 120000` in Cursor or `timeout: 120000` in a Claude Bash call); on no, continue. `handoff`: do the steps of the line in order. Other states: tell the user the text once, then continue. `migrate-to-plugin.js` exit 0: relay its last lines. Exit 3: this skill was just updated; re-read this file, then run the command again. Exit 1, 4, or 5: relay its output; this skill keeps working. Then continue the user\'s task. Do the steps of a `handoff` line once per conversation.\n\n';

fs.writeFileSync(BLOCK_NETWORK, "require('net').Socket.prototype.connect = function () {\n\tthrow new Error('network access is blocked in this test');\n};\n");

process.on('exit', () => {
	fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function copyTree(from, to) {
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const source = path.join(from, entry.name);
		const target = path.join(to, entry.name);
		if (entry.isDirectory()) copyTree(source, target);
		else if (entry.isFile()) fs.copyFileSync(source, target);
	}
}

let caseCounter = 0;

function makeCase({ editor = 'claude', claudeOnPath = false } = {}) {
	const root = path.join(TEST_ROOT, `case-${++caseCounter}`);
	const home = path.join(root, 'home');
	const tmp = path.join(root, 'tmp');
	const binDir = path.join(root, 'bin');
	for (const dir of [home, tmp, binDir]) fs.mkdirSync(dir, { recursive: true });
	const skillRoot = path.join(home, `.${editor}`, 'skills', 'make-custom-app');
	copyTree(SKILL_SOURCE, skillRoot);
	if (claudeOnPath) {
		fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 97\n');
		fs.chmodSync(path.join(binDir, 'claude'), 0o755);
	}
	const env = { PATH: binDir, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, NODE_OPTIONS: `--require ${BLOCK_NETWORK}` };
	const script = path.join(skillRoot, 'scripts', 'check-setup.js');
	return {
		root,
		home,
		tmp,
		binDir,
		skillRoot,
		script,
		throttleFile: path.join(tmp, `make-custom-app-plugin-prompt-${typeof process.getuid === 'function' ? process.getuid() : 'user'}.json`),
		run(extraArgs = [], envOverride = {}) {
			const result = spawnSync(process.execPath, [script, '--skip-version', ...extraArgs], {
				cwd: home,
				env: { ...env, ...envOverride },
				encoding: 'utf8',
				timeout: 60000,
			});
			assert.equal(result.error, undefined, 'check-setup.js did not run');
			return result;
		},
	};
}

function recordPlugin(home, { enabled } = {}) {
	const config = path.join(home, '.claude');
	const installPath = path.join(config, 'plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0');
	fs.mkdirSync(path.join(installPath, '.claude-plugin'), { recursive: true });
	fs.writeFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), '{"name":"make-custom-app","version":"3.0.0"}');
	fs.writeFileSync(
		path.join(config, 'plugins', 'installed_plugins.json'),
		JSON.stringify({ version: 2, plugins: { [ID]: [{ scope: 'user', installPath, version: '3.0.0' }] } }),
	);
	if (enabled !== undefined) fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ enabledPlugins: { [ID]: enabled } }));
	return installPath;
}

function writeDecline(home, declinedAt) {
	const dir = path.join(home, '.make-custom-app');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'legacy-cleanup.json'), JSON.stringify({ schema: 1, declinedAt: new Date(declinedAt).toISOString(), digest: '0123456789abcdef' }));
}

const FAKE_JIRA = { email: 'fake.user@make.com', token: 'fake-jira-token-0001' };
const FAKE_MAKE_KEY = 'fake-make-token-0001';

function seedCompleteSetup(c) {
	const runtimeDir = path.join(c.root, 'imt-app-runtime');
	fs.mkdirSync(runtimeDir);
	const secrets = [`imt-app-runtime-path: ${runtimeDir}`, `make-api-key: ${FAKE_MAKE_KEY}`, `jira-email: ${FAKE_JIRA.email}`, `jira-api-token: ${FAKE_JIRA.token}`];
	fs.writeFileSync(path.join(c.home, '.make-custom-app-skill-secrets'), `${secrets.join('\n')}\n`, { mode: 0o600 });
	const key = cacheKey({ baseUrl: JIRA_BASE_URL, email: FAKE_JIRA.email, token: FAKE_JIRA.token });
	fs.writeFileSync(path.join(c.tmp, 'make-custom-app-access-check.json'), JSON.stringify({ key, email: FAKE_JIRA.email, checkedAt: Date.now() }));
}

function migrationLines(result) {
	return result.stdout.split('\n').filter((line) => line.startsWith('PLUGIN_MIGRATION: '));
}

function jsonOf(result) {
	return JSON.parse(result.stdout);
}

function splitLines(text) {
	return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function skillMdParts() {
	const head = splitLines(fs.readFileSync(path.join(SKILL_SOURCE, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n'));
	const start = head.findIndex((line) => line === '## Plugin migration\n');
	assert.ok(start > 0, 'the section heading is missing');
	const next = head.findIndex((line, index) => index > start && line.startsWith('## '));
	assert.ok(next > start, 'no heading follows the section');
	return { head, start, next };
}

function dropVersionLine(lines) {
	const first = lines.findIndex((line) => line.replace(/\r?\n$/, '') === '---');
	const second = lines.findIndex((line, index) => index > first && line.replace(/\r?\n$/, '') === '---');
	const at = lines.findIndex((line, index) => index > first && index < second && line.startsWith('version:'));
	return at === -1 ? lines : [...lines.slice(0, at), ...lines.slice(at + 1)];
}

function readBaseSkillMd() {
	const shown = spawnSync('git', ['show', `${BASE_COMMIT}:skill/SKILL.md`], { cwd: REPO_ROOT, encoding: 'utf8' });
	if (shown.error || shown.status !== 0) return { skip: `git or commit ${BASE_COMMIT} is not available`, text: '' };
	return { skip: false, text: shown.stdout };
}

const BASE_SKILL_MD = readBaseSkillMd();

const MARKETPLACE_NAME = 'make-custom-app';
const MARKETPLACE_URL = 'https://github.com/minsu-kang/make-custom-app-skill.git';
const PLUGIN_ID = ID;
const FAKE_CLAUDE_VERSION = '2.1.312';
const FAKE_PLUGIN_VERSION = '3.0.0';
const FAKE_WRONG_VERSION = '2.9.0';
const FAKE_MODES = ['normal', 'add-fails', 'install-fails', 'install-no-record', 'wrong-version', 'hang', 'hang-trap', 'disabled', 'object-entry', 'already-added', 'not-claude'];
const FAKE_HANG_DEFAULT_MS = 30000;
const FAKE_HANG_MAX_MS = 600000;
const SHEBANG_MAX_LENGTH = 100;
const OLD_EDITORS = ['claude', 'cursor'];
const OLD_PLUGIN_STATES = ['none', 'usable', 'disabled'];
const FAKE_ENV_VARS = { PINECONE_API_KEY: 'fake-pinecone-0001', OPENAI_API_KEY: 'fake-openai-0001', PINECONE_INDEX_NAME: 'make-app-contexts' };
const FAKE_ENV_FILE = '# Pinecone\nPINECONE_API_KEY=fake-pinecone-0001\nPINECONE_INDEX_NAME=make-app-contexts\n\n# OpenAI (for text-embedding-3-small)\nOPENAI_API_KEY=fake-openai-0001\n';
const OTHER_CLAUDE_TOKEN = 'fake-other-token-1111';
const SENTINEL_BLOCK =
	'<!-- make-custom-app-skill -->\n# Make Custom App Skill\n\nWhen the conversation involves a Make.com custom app, IMLJSON, the Make Apps SDK, `make-app-contexts`, or an IEN Jira ticket about an app: invoke the `make-custom-app` skill before any other action and follow it. Do not answer from memory. Do not delegate this work to a sub-agent.\n<!-- /make-custom-app-skill -->';
const OLD_SNAPSHOT_PATHS = [
	'.claude/skills/make-custom-app',
	'.cursor/skills/make-custom-app',
	'.claude/make-app-contexts',
	'.cursor/make-app-contexts',
	'.cursor/rules/make-custom-app',
	'.claude.json',
	'.cursor/mcp.json',
	'.claude/CLAUDE.md',
];

// Functions from here to fakeClaudeMain are written into the fake claude as source text, so they use only fs, path, process, and the constants above.
function isObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInsidePath(file, root) {
	if (typeof file !== 'string' || typeof root !== 'string') return false;
	const relative = path.relative(root, file);
	return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hasParentSegment(value) {
	return typeof value === 'string' && value.split(/[\\/]/).includes('..');
}

function realishPath(file) {
	if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
	const rest = [];
	let current = path.resolve(file);
	for (;;) {
		try {
			return path.join(fs.realpathSync(current), ...rest.reverse());
		} catch (err) {
			if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return null;
			const parent = path.dirname(current);
			if (parent === current) return null;
			rest.push(path.basename(current));
			current = parent;
		}
	}
}

function refusal(message) {
	const error = new Error(message);
	error.refusal = true;
	return error;
}

// guard(file, kind, label) returns the normalized path that it checked; every read, write, and folder of the fake goes through it and uses that value.
function makeGuard(rootReal) {
	return function guard(file, kind, label) {
		const deny = (reason) => {
			throw refusal(`${label || file} ${reason}`);
		};
		if (typeof file !== 'string' || !path.isAbsolute(file)) deny('is not an absolute path');
		const target = path.resolve(file);
		let leaf = null;
		try {
			leaf = fs.lstatSync(target);
		} catch (err) {
			if (err.code !== 'ENOENT') deny('cannot be inspected');
		}
		if (leaf !== null) {
			if (leaf.isSymbolicLink()) deny('is a symbolic link');
			if (kind === 'file' && !leaf.isFile()) deny('is not a regular file');
			if (kind === 'dir' && !leaf.isDirectory()) deny('is not a folder');
		}
		const rest = [path.basename(target)];
		let existing = path.dirname(target);
		for (;;) {
			try {
				fs.lstatSync(existing);
				break;
			} catch (err) {
				if (err.code !== 'ENOENT') deny('cannot be inspected');
			}
			const parent = path.dirname(existing);
			if (parent === existing) deny('cannot be resolved');
			rest.push(path.basename(existing));
			existing = parent;
		}
		let real = null;
		try {
			real = fs.realpathSync(existing);
			if (!fs.statSync(real).isDirectory()) real = null;
		} catch {
			real = null;
		}
		if (real === null) deny('cannot be resolved');
		if (!isInsidePath(path.join(real, ...rest.reverse()), rootReal)) deny('is outside FAKE_CLAUDE_ROOT');
		return target;
	};
}

function makeIo({ guard, dry }) {
	return {
		read(file) {
			const target = guard(file, 'file');
			try {
				return fs.readFileSync(target, 'utf8');
			} catch (err) {
				if (err.code === 'ENOENT') return null;
				throw err;
			}
		},
		write(file, text, mode) {
			const target = guard(file, 'file');
			if (dry) return;
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, text, mode === undefined ? undefined : { mode });
		},
		append(file, text) {
			const target = guard(file, 'file');
			if (dry) return;
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.appendFileSync(target, text);
		},
		mkdir(dir) {
			const target = guard(dir, 'dir');
			if (!dry) fs.mkdirSync(target, { recursive: true });
		},
		list(dir) {
			const target = guard(dir, 'dir');
			try {
				return fs.readdirSync(target);
			} catch (err) {
				if (err.code === 'ENOENT') return [];
				throw err;
			}
		},
	};
}

function readJsonFile(io, file, fallback) {
	const text = io.read(file);
	if (text === null) return fallback;
	try {
		return JSON.parse(text);
	} catch {
		return fallback;
	}
}

function writeJsonFile(io, file, value) {
	io.write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writePluginFiles(io, { config, version, record, disabled, objectEntry }) {
	const installPath = path.join(config, 'plugins', 'cache', 'make-custom-app', 'make-custom-app', version);
	io.write(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'make-custom-app', version }));
	io.write(path.join(installPath, 'skills', 'make-app-setup', 'SKILL.md'), '---\nname: make-app-setup\ndescription: Fake plugin skill of the test harness.\n---\n\nFake plugin skill.\n');
	io.write(path.join(installPath, 'mcp', 'index.mjs'), '// fake plugin MCP bundle of the test harness\n');
	if (record) {
		const file = path.join(config, 'plugins', 'installed_plugins.json');
		const installed = readJsonFile(io, file, { version: 2, plugins: {} });
		if (!isObject(installed.plugins)) installed.plugins = {};
		const now = new Date().toISOString();
		const entry = { scope: 'user', installPath, version, installedAt: now, lastUpdated: now, gitCommitSha: '0'.repeat(40) };
		installed.plugins[PLUGIN_ID] = objectEntry ? entry : [entry];
		writeJsonFile(io, file, installed);
	}
	const settingsFile = path.join(config, 'settings.json');
	const settings = readJsonFile(io, settingsFile, {});
	settings.enabledPlugins = { ...(isObject(settings.enabledPlugins) ? settings.enabledPlugins : {}), [PLUGIN_ID]: !disabled };
	writeJsonFile(io, settingsFile, settings);
	return installPath;
}

function rewriteUserFile(io, { env, userFile, config }) {
	if (env.FAKE_CLAUDE_USER_FILE !== 'rewrite') return;
	const text = io.read(userFile);
	let data = {};
	if (text !== null) {
		try {
			data = JSON.parse(text);
		} catch {
			return;
		}
		if (!isObject(data)) return;
	}
	const backups = path.join(config, 'backups');
	if (text !== null && !io.list(backups).some((name) => name.startsWith('.claude.json.backup.'))) {
		io.write(path.join(backups, `.claude.json.backup.${Date.now()}`), text, 0o600);
	}
	const own = {
		firstStartTime: new Date().toISOString(),
		firstStartVersion: FAKE_CLAUDE_VERSION,
		machineID: 'f'.repeat(64),
		opusProMigrationComplete: true,
		sonnet1m45MigrationComplete: true,
		seenNotifications: {},
		hasResetAutoModeOptInForDefaultOffer: true,
		migrationVersion: 11,
	};
	for (const [key, value] of Object.entries(own)) if (!Object.hasOwn(data, key)) data[key] = value;
	io.write(userFile, JSON.stringify(data, null, 2), 0o600);
}

function runCommand({ argv, env, config, userFile, mode, io }) {
	const done = (code, out = null, err = null) => ({ code, out, err, hang: false });
	if (argv.length === 1 && argv[0] === '--version') return done(0, mode === 'not-claude' ? '1.0.0 (Other Tool)' : `${FAKE_CLAUDE_VERSION} (Claude Code)`);
	if (mode === 'not-claude' || argv[0] !== 'plugin') return done(2, null, 'unexpected command');
	if (mode === 'hang' || mode === 'hang-trap') return { code: 0, out: null, err: null, hang: true };
	const marketplacesFile = path.join(config, 'fake-marketplaces.json');
	const entry = { name: MARKETPLACE_NAME, source: 'git', url: MARKETPLACE_URL, installLocation: path.join(config, 'plugins', 'marketplaces', MARKETPLACE_NAME) };
	const marketplaces = () => {
		const held = readJsonFile(io, marketplacesFile, null);
		if (Array.isArray(held)) return held;
		return mode === 'already-added' ? [entry] : [];
	};
	const added = () => marketplaces().some((held) => held.name === MARKETPLACE_NAME);
	const rest = argv.slice(1);

	if (rest.length === 3 && rest[0] === 'marketplace' && rest[1] === 'list' && rest[2] === '--json') return done(0, JSON.stringify(marketplaces(), null, 2));
	if (rest.length === 3 && rest[0] === 'marketplace' && rest[1] === 'add') {
		if (rest[2] !== MARKETPLACE_URL) return done(1, null, `fatal: unknown source ${rest[2]}`);
		if (mode === 'add-fails') return done(1, null, 'fatal: could not add the marketplace (fake failure)');
		if (added()) return done(0, `Marketplace '${MARKETPLACE_NAME}' already on disk`);
		writeJsonFile(io, marketplacesFile, [...marketplaces(), entry]);
		io.mkdir(entry.installLocation);
		const settingsFile = path.join(config, 'settings.json');
		const settings = readJsonFile(io, settingsFile, {});
		const known = isObject(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
		settings.extraKnownMarketplaces = { ...known, [MARKETPLACE_NAME]: { source: { source: 'git', url: MARKETPLACE_URL } } };
		writeJsonFile(io, settingsFile, settings);
		rewriteUserFile(io, { env, userFile, config });
		return done(0, `Successfully added marketplace: ${MARKETPLACE_NAME}`);
	}
	if (rest.length === 2 && rest[0] === 'install' && rest[1] === PLUGIN_ID) {
		if (!added()) return done(1, null, `Error: marketplace ${MARKETPLACE_NAME} is not added`);
		if (mode === 'install-fails') return done(1, null, 'Error: could not install the plugin (fake failure)');
		const installed = readJsonFile(io, path.join(config, 'plugins', 'installed_plugins.json'), null);
		if (isObject(installed) && isObject(installed.plugins) && Object.hasOwn(installed.plugins, PLUGIN_ID)) return done(0, 'already installed (scope: user)');
		const version = mode === 'wrong-version' ? FAKE_WRONG_VERSION : FAKE_PLUGIN_VERSION;
		writePluginFiles(io, { config, version, record: mode !== 'install-no-record', disabled: mode === 'disabled', objectEntry: mode === 'object-entry' });
		rewriteUserFile(io, { env, userFile, config });
		return done(0, `Installed ${PLUGIN_ID} (scope: user)`);
	}
	return done(2, null, 'unexpected command');
}

function fakeClaudeMain(argv, env) {
	const refuse = (what) => {
		process.stderr.write(`fake claude: ${what}; refusing\n`);
		return 97;
	};
	const realAbsolute = (value) => {
		if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
		try {
			return fs.realpathSync(value);
		} catch {
			return null;
		}
	};
	const rootReal = realAbsolute(env.FAKE_CLAUDE_ROOT);
	const homeReal = realAbsolute(env.HOME);
	if (rootReal === null || homeReal === null) return refuse('HOME is outside FAKE_CLAUDE_ROOT');
	if (rootReal === TEST_ROOT_REAL || !isInsidePath(rootReal, TEST_ROOT_REAL)) return refuse('FAKE_CLAUDE_ROOT is outside the test root');
	if (!isInsidePath(homeReal, rootReal)) return refuse('HOME is outside FAKE_CLAUDE_ROOT');
	for (const name of ['HOME', 'CLAUDE_CONFIG_DIR', 'FAKE_CLAUDE_LOG']) {
		if (hasParentSegment(env[name])) return refuse(`${name} contains a .. segment`);
	}
	const home = path.resolve(env.HOME);
	const configSet = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR !== '';
	if (configSet && !isInsidePath(realishPath(env.CLAUDE_CONFIG_DIR), rootReal)) return refuse('CLAUDE_CONFIG_DIR is outside FAKE_CLAUDE_ROOT');
	const config = configSet ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
	if (!isInsidePath(realishPath(config), rootReal)) return refuse('the Claude config folder is outside FAKE_CLAUDE_ROOT');
	if (typeof env.FAKE_CLAUDE_LOG !== 'string' || !path.isAbsolute(env.FAKE_CLAUDE_LOG)) return refuse('FAKE_CLAUDE_LOG is outside FAKE_CLAUDE_ROOT');
	const log = path.resolve(env.FAKE_CLAUDE_LOG);
	const guard = makeGuard(rootReal);
	const refused = (error) => {
		if (error && error.refusal) return refuse(error.message);
		throw error;
	};
	try {
		guard(log, 'file', 'FAKE_CLAUDE_LOG');
	} catch (error) {
		return refused(error);
	}
	const mode = env.FAKE_CLAUDE_MODE || 'normal';
	if (!FAKE_MODES.includes(mode)) {
		process.stderr.write('fake claude: unknown FAKE_CLAUDE_MODE\n');
		return 2;
	}
	const context = { argv, env, config, userFile: path.join(configSet ? config : home, '.claude.json'), mode };
	try {
		runCommand({ ...context, io: makeIo({ guard, dry: true }) });
	} catch (error) {
		return refused(error);
	}
	const io = makeIo({ guard, dry: false });
	const inherited = Object.keys(env).filter((name) => name.startsWith('CLAUDE_CODE_')).sort();
	io.append(log, `${JSON.stringify({ argv, claudecode: 'CLAUDECODE' in env, inherited })}\n`);
	const result = runCommand({ ...context, io });
	if (result.out !== null) process.stdout.write(`${result.out}\n`);
	if (result.err !== null) process.stderr.write(`${result.err}\n`);
	if (!result.hang) return result.code;
	const asked = Number(env.FAKE_CLAUDE_HANG_MS);
	if (mode === 'hang-trap') process.on('SIGTERM', () => {});
	setTimeout(() => {}, Number.isInteger(asked) && asked > 0 ? Math.min(asked, FAKE_HANG_MAX_MS) : FAKE_HANG_DEFAULT_MS);
	return null;
}

function shebangFits(node) {
	return !/\s/.test(node) && node.length <= SHEBANG_MAX_LENGTH;
}

function fakeClaudeSource(node) {
	const constants = { PLUGIN_ID, MARKETPLACE_NAME, MARKETPLACE_URL, FAKE_CLAUDE_VERSION, FAKE_PLUGIN_VERSION, FAKE_WRONG_VERSION, FAKE_MODES, FAKE_HANG_DEFAULT_MS, FAKE_HANG_MAX_MS, TEST_ROOT_REAL: TEST_ROOT };
	const functions = [isObject, isInsidePath, hasParentSegment, realishPath, refusal, makeGuard, makeIo, readJsonFile, writeJsonFile, writePluginFiles, rewriteUserFile, runCommand, fakeClaudeMain];
	const header = shebangFits(node) ? [`#!${node}`] : ['#!/bin/sh', `':' //; exec '${node.replace(/'/g, "'\\''")}' "$0" "$@"`];
	return [
		...header,
		"'use strict';",
		"const fs = require('fs');",
		"const path = require('path');",
		...Object.entries(constants).map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`),
		...functions.map((fn) => fn.toString()),
		'let code;',
		'try {',
		'\tcode = fakeClaudeMain(process.argv.slice(2), process.env);',
		'} catch (error) {',
		"\tprocess.stderr.write(`fake claude: unexpected error (${error && error.code ? error.code : 'unknown'})\\n`);",
		'\tcode = 2;',
		'}',
		'if (code !== null) process.exitCode = code;',
		'',
	].join('\n');
}

function needParams(name, params, keys) {
	const given = params || {};
	const valid = (key) => (key === 'env' ? isObject(given.env) : typeof given[key] === 'string' && given[key] !== '');
	if (keys.every(valid)) return;
	const names = keys.length > 2 ? `${keys.slice(0, -1).join(', ')}, and ${keys[keys.length - 1]}` : keys.join(' and ');
	throw new TypeError(`${name} needs ${names}`);
}

function makeRoot() {
	const root = path.join(TEST_ROOT, `harness-${++caseCounter}`);
	fs.mkdirSync(root);
	return root;
}

function withEnv(base, overrides) {
	const env = { ...base };
	for (const [name, value] of Object.entries(overrides)) {
		if (value === undefined) delete env[name];
		else env[name] = value;
	}
	return env;
}

function writeFakeClaude({ binDir, root, node = process.execPath } = {}) {
	needParams('writeFakeClaude', { binDir, root }, ['binDir', 'root']);
	if (!path.isAbsolute(root) || root === TEST_ROOT || !isInsidePath(root, TEST_ROOT)) throw new TypeError('writeFakeClaude: root must lie inside the test root');
	if (!path.isAbsolute(binDir) || !isInsidePath(binDir, root)) throw new TypeError('writeFakeClaude: binDir must lie inside the root');
	if (typeof node !== 'string' || !path.isAbsolute(node)) throw new TypeError('writeFakeClaude: node must be an absolute path');
	fs.mkdirSync(binDir, { recursive: true });
	const file = path.join(binDir, 'claude');
	fs.writeFileSync(file, fakeClaudeSource(node));
	fs.chmodSync(file, 0o755);
	return file;
}

function writeText(file, text, mode = 0o644) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	fs.chmodSync(file, mode);
}

function setMtime(file, iso) {
	const when = new Date(iso);
	fs.utimesSync(file, when, when);
}

function writeOldContexts(paths) {
	const claude = paths.claudeContexts;
	const cursor = paths.cursorContexts;
	for (const root of [claude, cursor]) {
		writeText(path.join(root, 'alpha-v1.md'), 'Alpha context, version 1.\n');
		setMtime(path.join(root, 'alpha-v1.md'), '2026-01-05T10:00:00Z');
	}
	writeText(path.join(claude, 'beta-v1.md'), 'Beta context written by Claude Code.\n');
	setMtime(path.join(claude, 'beta-v1.md'), '2026-01-10T10:00:00Z');
	writeText(path.join(cursor, 'beta-v1.md'), 'Beta context written by Cursor, later.\n');
	setMtime(path.join(cursor, 'beta-v1.md'), '2026-02-10T10:00:00Z');
	writeText(path.join(claude, 'alpha-v1', 'reviews', 'review-1.md'), 'Review one.\n');
	writeText(path.join(claude, 'alpha-v1', 'reviews', 'nested', 'review-2.md'), 'Review two.\n');
	fs.symlinkSync(path.join('..', '..', 'alpha-v1.md'), path.join(claude, 'alpha-v1', 'reviews', 'link.md'));
	writeText(path.join(claude, 'orgapp-v2.md'), 'Org app context.\n');
	writeText(path.join(claude, 'orgapp-v2', 'metadata.json'), '{"snapshot":{"id":1}}');
	writeText(path.join(claude, 'orgapp-v2', 'reviews', 'org-review.md'), 'Review written by the org downloader.\n');
	writeText(path.join(cursor, 'gamma-v1.md'), 'Gamma context.\n');
	writeText(path.join(cursor, 'gamma-v1', 'reviews', 'gamma-review.md'), 'Gamma review.\n');
}

function oldRegistration(skill) {
	return { command: process.execPath, args: [path.join(skill, 'mcp-server', 'dist', 'index.js')], env: { ...FAKE_ENV_VARS } };
}

function buildOldHome({ root, editors = ['claude'], secrets = null, contexts = true, malformedClaudeJson = false, plugin = 'none' } = {}) {
	needParams('buildOldHome', { root }, ['root']);
	if (!path.isAbsolute(root) || root === TEST_ROOT || !isInsidePath(root, TEST_ROOT)) throw new TypeError('buildOldHome: root must lie inside the test root');
	if (!Array.isArray(editors) || editors.some((editor) => !OLD_EDITORS.includes(editor))) throw new TypeError('buildOldHome: editors must name claude or cursor');
	if (!OLD_PLUGIN_STATES.includes(plugin)) throw new TypeError(`buildOldHome: plugin must be one of ${OLD_PLUGIN_STATES.join(', ')}`);
	const home = path.join(root, 'home');
	const tmp = path.join(root, 'tmp');
	const binDir = path.join(root, 'bin');
	const log = path.join(root, 'fake-claude.log');
	for (const dir of [home, tmp, binDir]) fs.mkdirSync(dir, { recursive: true });
	const claudeSkill = path.join(home, '.claude', 'skills', 'make-custom-app');
	const cursorSkill = path.join(home, '.cursor', 'skills', 'make-custom-app');
	const config = path.join(home, '.claude');
	const paths = {
		root,
		tmp,
		home,
		binDir,
		config,
		claudeSkill,
		cursorSkill,
		claudeEnv: path.join(claudeSkill, 'mcp-server', '.env'),
		cursorEnv: path.join(cursorSkill, 'mcp-server', '.env'),
		claudeJson: path.join(home, '.claude.json'),
		cursorMcp: path.join(home, '.cursor', 'mcp.json'),
		claudeMd: path.join(config, 'CLAUDE.md'),
		cursorRules: path.join(home, '.cursor', 'rules', 'make-custom-app'),
		claudeContexts: path.join(config, 'make-app-contexts'),
		cursorContexts: path.join(home, '.cursor', 'make-app-contexts'),
		newContexts: path.join(home, '.make-custom-app', 'contexts'),
		secrets: path.join(home, '.make-custom-app-skill-secrets'),
		installPath: path.join(config, 'plugins', 'cache', 'make-custom-app', 'make-custom-app', FAKE_PLUGIN_VERSION),
	};

	// Modes as the old installers leave them (install-claude.sh lines 285, 403, 95, 155; mcp-server/register.js line 50): .env and .claude.json get no chmod, CLAUDE.md is a mktemp file, mcp.json is created 0600
	for (const editor of editors) {
		const skill = paths[`${editor}Skill`];
		copyTree(SKILL_SOURCE, skill);
		writeText(paths[`${editor}Env`], FAKE_ENV_FILE, 0o644);
		writeText(path.join(skill, 'mcp-server', 'dist', 'index.js'), '// fake built MCP server of the test harness\n');
	}
	if (editors.includes('claude')) {
		const claudeJson = {
			numStartups: 3,
			mcpServers: {
				'other-server': { command: 'node', args: ['/nonexistent/other-server.js'], env: { API_TOKEN: OTHER_CLAUDE_TOKEN } },
				'make-custom-app': oldRegistration(claudeSkill),
			},
			projects: { [path.join(home, 'work')]: { allowedTools: [], history: [], mcpServers: {} } },
		};
		const text = `${JSON.stringify(claudeJson, null, 2)}\n`;
		writeText(paths.claudeJson, malformedClaudeJson ? text.slice(0, text.indexOf(OTHER_CLAUDE_TOKEN) + OTHER_CLAUDE_TOKEN.length) : text, 0o644);
		writeText(paths.claudeMd, `# My notes\n\nA paragraph of the user that the installer keeps.\n\n${SENTINEL_BLOCK}\n`, 0o600);
	}
	if (editors.includes('cursor')) {
		const cursorJson = {
			mcpServers: {
				'other-cursor': { command: 'node', args: ['/nonexistent/other-cursor.js'], env: { API_TOKEN: 'fake-cursor-token-2222' } },
				'make-app-context': oldRegistration(cursorSkill),
			},
		};
		writeText(paths.cursorMcp, `${JSON.stringify(cursorJson, null, 2)}\n`, 0o600);
		fs.mkdirSync(paths.cursorRules, { recursive: true });
		for (const name of fs.readdirSync(path.join(REPO_ROOT, 'rules')).filter((file) => file.endsWith('.mdc'))) {
			fs.copyFileSync(path.join(REPO_ROOT, 'rules', name), path.join(paths.cursorRules, name));
		}
	}
	if (contexts) writeOldContexts(paths);
	if (plugin !== 'none') writePluginFiles(makeIo({ guard: (file) => file, dry: false }), { config, version: FAKE_PLUGIN_VERSION, record: true, disabled: plugin === 'disabled', objectEntry: false });
	if (typeof secrets === 'string') writeText(paths.secrets, secrets, 0o600);

	const env = { PATH: binDir, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp, FAKE_CLAUDE_ROOT: root, FAKE_CLAUDE_LOG: log, CLAUDE_BIN: path.join(binDir, 'claude') };
	return { home, binDir, log, env, paths };
}

function runScript({ home, script, args = [], env, timeoutMs = 60000, editor = 'claude' } = {}) {
	needParams('runScript', { home, script, env }, ['home', 'script', 'env']);
	if (!OLD_EDITORS.includes(editor)) throw new TypeError('runScript: editor must be claude or cursor');
	const file = path.join(home, `.${editor}`, 'skills', 'make-custom-app', 'scripts', script);
	const result = spawnSync(process.execPath, [file, ...args], { cwd: home, env, encoding: 'utf8', timeout: timeoutMs });
	if (result.error) throw new Error(result.error.code === 'ETIMEDOUT' ? `${script} did not finish within ${timeoutMs} ms` : `${script} did not run (${result.error.code})`);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function snapshotPaths(base, rels) {
	const entries = [];
	const visit = (rel) => {
		const abs = rel === '' ? base : path.join(base, ...rel.split('/'));
		let stat;
		try {
			stat = fs.lstatSync(abs);
		} catch (err) {
			if (err.code === 'ENOENT') return;
			throw err;
		}
		const isLink = stat.isSymbolicLink();
		const isFile = stat.isFile();
		const isDir = stat.isDirectory();
		entries.push({
			rel,
			type: isLink ? 'symlink' : isDir ? 'dir' : isFile ? 'file' : 'other',
			mode: stat.mode & 0o7777,
			size: isFile ? stat.size : null,
			sha256: isFile ? crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') : null,
			mtimeMs: stat.mtimeMs,
			linkTarget: isLink ? fs.readlinkSync(abs) : null,
		});
		if (isDir) for (const name of fs.readdirSync(abs).sort()) visit(rel === '' ? name : `${rel}/${name}`);
	};
	for (const rel of rels) visit(rel);
	return entries.sort((a, b) => Number(a.rel > b.rel) - Number(a.rel < b.rel));
}

function snapshotOld(home) {
	needParams('snapshotOld', { home }, ['home']);
	return snapshotPaths(home, OLD_SNAPSHOT_PATHS);
}

function readLog(log) {
	needParams('readLog', { log }, ['log']);
	let text;
	try {
		text = fs.readFileSync(log, 'utf8');
	} catch (err) {
		if (err.code === 'ENOENT') return [];
		throw err;
	}
	return text
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line));
}

describe('test isolation', () => {
	it('the test process sees a temporary home', () => {
		assert.ok(os.homedir().startsWith(TEST_ROOT));
		assert.ok(os.tmpdir().startsWith(TEST_ROOT));
		assert.notEqual(os.homedir(), REAL_HOME);
		assert.ok(require('../settings').SECRETS_PATH.startsWith(TEST_ROOT));
		assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(TEST_ROOT));
	});
});

describe('check-setup.js PLUGIN_MIGRATION', () => {
	it('prints ask once, then nothing within 24 hours', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		const first = c.run();
		const lines = migrationLines(first);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: ask \| /);
		assert.ok(lines[0].endsWith(`Yes runs: node '${path.join(c.skillRoot, 'scripts', 'migrate-to-plugin.js')}'`));
		assert.equal(first.stderr, '');
		assert.equal(JSON.parse(fs.readFileSync(c.throttleFile, 'utf8')).state, 'ask');
		assert.equal(fs.statSync(c.throttleFile).mode & 0o777, 0o600);
		const second = c.run();
		assert.deepEqual(migrationLines(second), []);
		assert.equal(second.stderr, '');
	});

	it('prints ask from the Cursor install when claude is on PATH', POSIX_ONLY, () => {
		const c = makeCase({ editor: 'cursor', claudeOnPath: true });
		const lines = migrationLines(c.run());
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: ask \| /);
		assert.ok(lines[0].includes(path.join(c.home, '.cursor', 'skills', 'make-custom-app', 'scripts', 'migrate-to-plugin.js')));
	});

	it('prints handoff once the plugin is recorded, although ask was shown before', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		assert.match(migrationLines(c.run())[0], /^PLUGIN_MIGRATION: ask \| /);
		assert.deepEqual(migrationLines(c.run()), []);
		recordPlugin(c.home, { enabled: true });
		const lines = migrationLines(c.run());
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: handoff \| /);
	});

	it('prints handoff on two runs in a row', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		recordPlugin(c.home, { enabled: true });
		for (let run = 0; run < 2; run++) {
			const lines = migrationLines(c.run());
			assert.equal(lines.length, 1, `run ${run + 1}`);
			assert.match(lines[0], /^PLUGIN_MIGRATION: handoff \| /);
		}
	});

	it('the Claude handoff names the migrate command first and then the Skill tool; the Cursor handoff names the migrate command first and then <installPath>/skills/make-app-setup/SKILL.md', POSIX_ONLY, () => {
		const claude = makeCase({ editor: 'claude' });
		recordPlugin(claude.home, { enabled: true });
		const claudeLine = migrationLines(claude.run())[0];
		const migrate = `node '${path.join(claude.skillRoot, 'scripts', 'migrate-to-plugin.js')}'`;
		assert.ok(claudeLine.includes(`1. Run ${migrate} `));
		const skillTool = claudeLine.indexOf('Skill tool with make-custom-app:make-app-setup');
		assert.ok(skillTool !== -1);
		assert.ok(claudeLine.indexOf(migrate) < skillTool);
		assert.ok(!claudeLine.includes('SKILL.md'));

		const cursor = makeCase({ editor: 'cursor' });
		const installPath = recordPlugin(cursor.home, { enabled: true });
		const cursorLine = migrationLines(cursor.run())[0];
		const cursorMigrate = `node '${path.join(cursor.skillRoot, 'scripts', 'migrate-to-plugin.js')}'`;
		const target = `${installPath}/skills/make-app-setup/SKILL.md`;
		assert.ok(cursorLine.includes(`1. Run ${cursorMigrate} `));
		assert.ok(cursorLine.includes(target));
		assert.ok(cursorLine.indexOf(cursorMigrate) < cursorLine.indexOf(target));
		assert.ok(!cursorLine.includes('Skill tool'));
	});

	it('prints nothing while a decline marker is younger than 7 days', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		recordPlugin(c.home, { enabled: true });
		writeDecline(c.home, Date.now() - DAY);
		const result = c.run();
		assert.deepEqual(migrationLines(result), []);
		assert.equal(result.stderr, '');
		assert.equal(jsonOf(c.run(['--json'])).pluginMigration, null);
	});

	it('prints handoff again once the decline marker is older than 7 days', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		recordPlugin(c.home, { enabled: true });
		writeDecline(c.home, Date.now() - 8 * DAY);
		assert.match(migrationLines(c.run())[0], /^PLUGIN_MIGRATION: handoff \| /);
	});

	it('prints inactive for a disabled plugin', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		recordPlugin(c.home, { enabled: false });
		const lines = migrationLines(c.run());
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: inactive \| /);
		assert.ok(lines[0].endsWith(`run in your own terminal: claude plugin enable ${ID}`));
		assert.deepEqual(migrationLines(c.run()), []);
		const report = jsonOf(c.run(['--json'])).pluginMigration;
		assert.equal(report.state, 'inactive');
		assert.equal(report.reason, 'disabled');
		assert.equal(report.claudeBin, null);
		assert.equal(report.command, `claude plugin enable ${ID}`);
		assert.equal(report.due, false);
	});

	it('prints unsupported from the Cursor install when CLAUDE_BIN names a missing file', POSIX_ONLY, () => {
		const c = makeCase({ editor: 'cursor', claudeOnPath: true });
		const missing = { CLAUDE_BIN: path.join(c.home, 'nowhere', 'claude') };
		const lines = migrationLines(c.run([], missing));
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: unsupported \| /);
		const report = jsonOf(c.run(['--json'], missing)).pluginMigration;
		assert.equal(report.state, 'unsupported');
		assert.equal(report.claudeBin, null);
		assert.equal(report.command, null);
	});

	it('prints ask from the Claude install when CLAUDE_BIN names a missing file', POSIX_ONLY, () => {
		const c = makeCase({ editor: 'claude', claudeOnPath: true });
		const missing = { CLAUDE_BIN: path.join(c.home, 'nowhere', 'claude') };
		const lines = migrationLines(c.run([], missing));
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: ask \| /);
		const report = jsonOf(c.run(['--json'], missing)).pluginMigration;
		assert.equal(report.state, 'ask');
		assert.equal(report.claudeBin, null);
	});

	it('the line comes right before the final Setup line, and the exit code equals the run without the line', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		const withLine = c.run();
		const without = c.run();
		assert.equal(migrationLines(withLine).length, 1);
		assert.equal(migrationLines(without).length, 0);
		assert.equal(withLine.status, without.status);
		assert.equal(withLine.status, 1);
		const lines = withLine.stdout.split('\n');
		const setup = lines.findIndex((line) => line.startsWith('Setup '));
		assert.ok(setup > 3);
		assert.match(lines[setup], /^Setup INCOMPLETE/);
		assert.equal(lines[setup - 1], '');
		assert.match(lines[setup - 2], /^PLUGIN_MIGRATION: ask \| /);
		assert.equal(lines[setup - 3], '');
		const removed = lines.filter((line, index) => index !== setup - 2 && index !== setup - 3);
		assert.equal(removed.join('\n'), without.stdout);
	});

	it('prints the line before Setup OK. and exits 0 when every required item is set', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		seedCompleteSetup(c);
		const withLine = c.run();
		assert.equal(withLine.status, 0);
		assert.equal(withLine.stderr, '');
		const lines = withLine.stdout.split('\n');
		const setup = lines.indexOf('Setup OK.');
		assert.ok(setup > 3);
		assert.equal(lines[setup - 1], '');
		assert.match(lines[setup - 2], /^PLUGIN_MIGRATION: ask \| /);
		assert.equal(lines[setup - 3], '');
		assert.match(withLine.stdout, /^OK +make account: fake\.user@make\.com$/m);
		const without = c.run();
		assert.equal(without.status, 0);
		assert.equal(migrationLines(without).length, 0);
		assert.equal(without.stdout, lines.filter((line, index) => index !== setup - 2 && index !== setup - 3).join('\n'));
		assert.equal(withLine.stdout.includes(FAKE_JIRA.token) || withLine.stdout.includes(FAKE_MAKE_KEY), false);
		const report = jsonOf(c.run(['--json']));
		assert.equal(report.ok, true);
		assert.equal(report.pluginMigration.state, 'ask');
		assert.equal(report.pluginMigration.due, false);
	});

	it('--json reports pluginMigration with due and writes no throttle file', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		for (let run = 0; run < 2; run++) {
			const result = c.run(['--json']);
			assert.equal(result.status, 1);
			assert.equal(result.stderr, '');
			const report = jsonOf(result).pluginMigration;
			assert.deepEqual(Object.keys(report).sort(), ['claudeBin', 'command', 'due', 'reason', 'state']);
			assert.equal(report.state, 'ask');
			assert.equal(report.reason, 'not-recorded');
			assert.equal(report.due, true);
			assert.equal(report.claudeBin, path.join(c.binDir, 'claude'));
			assert.equal(report.command, `node '${path.join(c.skillRoot, 'scripts', 'migrate-to-plugin.js')}'`);
			assert.equal(fs.existsSync(c.throttleFile), false);
		}
		recordPlugin(c.home, { enabled: true });
		const handoff = jsonOf(c.run(['--json'])).pluginMigration;
		assert.equal(handoff.state, 'handoff');
		assert.equal(handoff.reason, null);
		assert.equal(handoff.claudeBin, null);
		assert.equal(handoff.due, true);
		assert.equal(fs.existsSync(c.throttleFile), false);
	});

	it('an unwritable TMPDIR prints the line on every run', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		const unwritable = { TMPDIR: path.join(c.root, 'no-such-folder'), TEMP: path.join(c.root, 'no-such-folder'), TMP: path.join(c.root, 'no-such-folder') };
		for (let run = 0; run < 3; run++) {
			const result = c.run([], unwritable);
			const lines = migrationLines(result);
			assert.equal(lines.length, 1, `run ${run + 1}`);
			assert.match(lines[0], /^PLUGIN_MIGRATION: ask \| /);
			assert.equal(result.stderr, '');
		}
		assert.equal(fs.existsSync(path.join(c.root, 'no-such-folder')), false);
	});

	it('a malformed installed_plugins.json gives ask and no crash', POSIX_ONLY, () => {
		const c = makeCase({ claudeOnPath: true });
		fs.mkdirSync(path.join(c.home, '.claude', 'plugins'), { recursive: true });
		fs.writeFileSync(path.join(c.home, '.claude', 'plugins', 'installed_plugins.json'), '{ "plugins": { "make-custom-app@make-custom-app": [');
		const result = c.run();
		assert.equal(result.status, 1);
		assert.equal(result.stderr, '');
		const lines = migrationLines(result);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^PLUGIN_MIGRATION: ask \| /);
		assert.equal(jsonOf(c.run(['--json'])).pluginMigration.reason, 'unreadable');
	});

	it('fails open: a migrate-logic.js that cannot load changes neither the exit code nor stderr and prints no line', POSIX_ONLY, () => {
		const baseline = makeCase({ claudeOnPath: true });
		const expected = baseline.run(['--json']);
		const c = makeCase({ claudeOnPath: true });
		fs.writeFileSync(path.join(c.skillRoot, 'scripts', 'lib', 'migrate-logic.js'), "throw new Error('boom from migrate-logic');\n");
		const human = c.run();
		assert.equal(human.status, expected.status);
		assert.equal(human.stderr, '');
		assert.equal(human.stdout.includes('PLUGIN_MIGRATION'), false);
		assert.equal(human.stdout.includes('boom'), false);
		assert.match(human.stdout, /\nSetup INCOMPLETE/);
		const json = c.run(['--json']);
		assert.equal(json.status, expected.status);
		assert.equal(json.stderr, '');
		assert.equal(jsonOf(json).pluginMigration, null);
		const summary = (result) => jsonOf(result).items.map((item) => `${item.key}:${item.status}`);
		assert.deepEqual(summary(json), summary(expected));
		assert.equal(jsonOf(json).ok, jsonOf(expected).ok);
	});

	it('SKILL.md: the Plugin migration section equals the pinned text', () => {
		const { head, start, next } = skillMdParts();
		assert.equal(head[next], '## Workflows\n');
		const lines = head.slice(start, next);
		assert.equal(lines.join(''), PINNED_SECTION);
		assert.equal(Buffer.byteLength(PINNED_SECTION), SECTION_BYTES);
		assert.equal(lines.filter((line) => line.startsWith('## ')).length, 1);
		assert.ok(!PINNED_SECTION.includes('```'));
	});

	it('SKILL.md: without the section and without the version line the file equals cd8f60b', { skip: BASE_SKILL_MD.skip }, () => {
		const { head, start, next } = skillMdParts();
		const rest = [...head.slice(0, start), ...head.slice(next)];
		assert.equal(dropVersionLine(rest).join(''), dropVersionLine(splitLines(BASE_SKILL_MD.text)).join(''));
	});
});

describe('phase A harness', POSIX_ONLY, () => {
	function fresh(options = {}) {
		const root = makeRoot();
		const h = buildOldHome({ root, ...options });
		writeFakeClaude({ binDir: h.binDir, root });
		return { root, ...h };
	}

	function runFake(h, args, overrides = {}, timeout = 30000) {
		return spawnSync(path.join(h.binDir, 'claude'), args, { cwd: h.home, env: withEnv(h.env, overrides), encoding: 'utf8', timeout });
	}

	const listArgs = () => ['plugin', 'marketplace', 'list', '--json'];
	const addArgs = (url = MARKETPLACE_URL) => ['plugin', 'marketplace', 'add', url];
	const installArgs = () => ['plugin', 'install', ID];
	const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
	const cacheDir = (config, version = '3.0.0') => path.join(config, 'plugins', 'cache', 'make-custom-app', 'make-custom-app', version);

	function statusOf(h, config) {
		const env = config ? { ...h.env, CLAUDE_CONFIG_DIR: config } : h.env;
		return readPluginStatus({ env, home: h.home });
	}

	function problemsOf(status) {
		const manifest = status.installPath ? path.join(status.installPath, '.claude-plugin', 'plugin.json') : null;
		const manifestText = manifest && fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8') : undefined;
		return verifyInstall({ status, manifestText, exists: (file) => fs.existsSync(file) });
	}

	it('the fake claude refuses with exit 97 when HOME, or a set CLAUDE_CONFIG_DIR, is outside FAKE_CLAUDE_ROOT, and writes nothing', () => {
		const h = fresh();
		const outside = makeRoot();
		fs.mkdirSync(path.join(outside, 'cfg'));
		fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep\n');
		const linkToOutside = path.join(h.root, 'link-to-outside');
		fs.symlinkSync(outside, linkToOutside);
		const linkToConfig = path.join(h.root, 'link-to-config');
		fs.symlinkSync(path.join(outside, 'cfg'), linkToConfig);
		const linkedHome = path.join(h.root, 'linked-home');
		fs.mkdirSync(linkedHome);
		fs.symlinkSync(path.join(outside, 'cfg'), path.join(linkedHome, '.claude'));
		const beforeOutside = snapshotPaths(outside, ['']);
		const beforeRoot = snapshotPaths(h.root, ['']);
		const homeMessage = 'HOME is outside FAKE_CLAUDE_ROOT';
		const configMessage = 'CLAUDE_CONFIG_DIR is outside FAKE_CLAUDE_ROOT';
		const cases = [
			['HOME in another folder', { HOME: outside }, homeMessage],
			['HOME unset', { HOME: undefined }, homeMessage],
			['HOME empty', { HOME: '' }, homeMessage],
			['HOME relative', { HOME: 'home' }, homeMessage],
			['HOME a link into another folder', { HOME: linkToOutside }, homeMessage],
			['HOME the parent of the root', { HOME: path.dirname(h.root) }, homeMessage],
			['FAKE_CLAUDE_ROOT unset', { FAKE_CLAUDE_ROOT: undefined }, homeMessage],
			['FAKE_CLAUDE_ROOT missing', { FAKE_CLAUDE_ROOT: path.join(h.root, 'missing') }, homeMessage],
			['CLAUDE_CONFIG_DIR in another folder', { CLAUDE_CONFIG_DIR: path.join(outside, 'cfg') }, configMessage],
			['CLAUDE_CONFIG_DIR not yet created in another folder', { CLAUDE_CONFIG_DIR: path.join(outside, 'new', 'cfg') }, configMessage],
			['CLAUDE_CONFIG_DIR a link into another folder', { CLAUDE_CONFIG_DIR: linkToConfig }, configMessage],
			['CLAUDE_CONFIG_DIR relative', { CLAUDE_CONFIG_DIR: 'cfg' }, configMessage],
			['the default config folder a link into another folder', { HOME: linkedHome }, 'the Claude config folder is outside FAKE_CLAUDE_ROOT'],
			['FAKE_CLAUDE_LOG in another folder', { FAKE_CLAUDE_LOG: path.join(outside, 'fake.log') }, 'FAKE_CLAUDE_LOG is outside FAKE_CLAUDE_ROOT'],
			['FAKE_CLAUDE_LOG unset', { FAKE_CLAUDE_LOG: undefined }, 'FAKE_CLAUDE_LOG is outside FAKE_CLAUDE_ROOT'],
		];
		for (const [label, overrides, message] of cases) {
			for (const argv of [['--version'], installArgs()]) {
				const result = runFake(h, argv, overrides);
				assert.equal(result.error, undefined, label);
				assert.equal(result.status, 97, `${label}: ${argv.join(' ')}`);
				assert.equal(result.stdout, '', label);
				assert.equal(result.stderr, `fake claude: ${message}; refusing\n`, label);
			}
		}
		assert.deepEqual(snapshotPaths(outside, ['']), beforeOutside);
		assert.deepEqual(snapshotPaths(h.root, ['']), beforeRoot);
		assert.equal(fs.existsSync(h.log), false);
		assert.equal(runFake(h, ['--version']).status, 0);
		assert.equal(runFake(h, ['--version'], { CLAUDE_CONFIG_DIR: path.join(h.root, 'config-dir') }).status, 0);
	});

	it('the fake claude prints the Claude Code version, and the not-claude mode does not', () => {
		const h = fresh();
		const normal = runFake(h, ['--version']);
		assert.equal(normal.status, 0);
		assert.equal(normal.stdout, '2.1.312 (Claude Code)\n');
		assert.equal(normal.stderr, '');
		assert.match(normal.stdout.split('\n')[0], CLAUDE_VERSION_PATTERN);
		const other = runFake(h, ['--version'], { FAKE_CLAUDE_MODE: 'not-claude' });
		assert.equal(other.status, 0);
		assert.equal(other.stdout, '1.0.0 (Other Tool)\n');
		assert.doesNotMatch(other.stdout.split('\n')[0], CLAUDE_VERSION_PATTERN);
		const plugin = runFake(h, listArgs(), { FAKE_CLAUDE_MODE: 'not-claude' });
		assert.equal(plugin.status, 2);
		assert.equal(plugin.stdout, '');
		assert.equal(plugin.stderr, 'unexpected command\n');
	});

	it('marketplace add accepts only the fixed address; marketplace list --json prints the flat shape of M1; install writes the cache, the record, and enabledPlugins', () => {
		const h = fresh();
		const config = path.join(h.home, '.claude');
		const location = path.join(config, 'plugins', 'marketplaces', 'make-custom-app');
		let result = runFake(h, listArgs());
		assert.equal(result.status, 0);
		assert.deepEqual(JSON.parse(result.stdout), []);

		result = runFake(h, installArgs());
		assert.equal(result.status, 1);
		assert.equal(fs.existsSync(path.join(config, 'plugins')), false);

		result = runFake(h, addArgs('https://example.invalid/other.git'));
		assert.equal(result.status, 1);
		assert.equal(result.stdout, '');
		assert.equal(result.stderr, 'fatal: unknown source https://example.invalid/other.git\n');
		assert.deepEqual(JSON.parse(runFake(h, listArgs()).stdout), []);

		result = runFake(h, addArgs());
		assert.equal(result.status, 0);
		assert.equal(result.stderr, '');
		const listed = runFake(h, listArgs());
		assert.equal(listed.status, 0);
		assert.deepEqual(JSON.parse(listed.stdout), [{ name: 'make-custom-app', source: 'git', url: MARKETPLACE_URL, installLocation: location }]);
		assert.deepEqual(parseMarketplaceList(listed.stdout), [{ name: 'make-custom-app', source: MARKETPLACE_URL }]);
		const afterAdd = readJson(path.join(config, 'settings.json'));
		assert.deepEqual(afterAdd, { extraKnownMarketplaces: { 'make-custom-app': { source: { source: 'git', url: MARKETPLACE_URL } } } });

		result = runFake(h, addArgs());
		assert.equal(result.status, 0);
		assert.match(result.stdout, /already on disk/);
		assert.equal(JSON.parse(runFake(h, listArgs()).stdout).length, 1);

		const otherPlugin = { scope: 'user', installPath: '/nowhere/other', version: '1.0.0' };
		fs.writeFileSync(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'other@elsewhere': [otherPlugin] } }));
		fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ ...afterAdd, theme: 'dark', enabledPlugins: { 'other@elsewhere': true } }));
		result = runFake(h, installArgs());
		assert.equal(result.status, 0);
		assert.equal(result.stderr, '');
		const installPath = cacheDir(config);
		assert.equal(fs.readFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), 'utf8'), '{"name":"make-custom-app","version":"3.0.0"}');
		assert.ok(fs.statSync(path.join(installPath, 'skills', 'make-app-setup', 'SKILL.md')).isFile());
		assert.ok(fs.statSync(path.join(installPath, 'mcp', 'index.mjs')).isFile());
		const installed = readJson(path.join(config, 'plugins', 'installed_plugins.json'));
		assert.deepEqual(Object.keys(installed.plugins), ['other@elsewhere', ID]);
		assert.deepEqual(installed.plugins['other@elsewhere'], [otherPlugin]);
		assert.equal(installed.plugins[ID].length, 1);
		assert.deepEqual({ scope: installed.plugins[ID][0].scope, installPath: installed.plugins[ID][0].installPath, version: installed.plugins[ID][0].version }, { scope: 'user', installPath, version: '3.0.0' });
		assert.deepEqual(readJson(path.join(config, 'settings.json')), { ...afterAdd, theme: 'dark', enabledPlugins: { 'other@elsewhere': true, [ID]: true } });
		const status = statusOf(h);
		assert.deepEqual(status, { status: 'usable', reason: null, id: ID, installPath, version: '3.0.0' });
		assert.deepEqual(problemsOf(status), []);

		result = runFake(h, installArgs());
		assert.equal(result.status, 0);
		assert.match(result.stdout, /already installed \(scope: user\)/);
		assert.equal(readJson(path.join(config, 'plugins', 'installed_plugins.json')).plugins[ID].length, 1);

		const other = path.join(h.root, 'config-dir');
		const inOther = { CLAUDE_CONFIG_DIR: other };
		assert.deepEqual(JSON.parse(runFake(h, listArgs(), inOther).stdout), []);
		assert.equal(runFake(h, addArgs(), inOther).status, 0);
		assert.equal(runFake(h, installArgs(), inOther).status, 0);
		assert.ok(fs.existsSync(path.join(cacheDir(other), '.claude-plugin', 'plugin.json')));
		assert.ok(fs.existsSync(path.join(other, 'settings.json')));
		assert.equal(statusOf(h, other).status, 'usable');
		assert.equal(JSON.parse(runFake(h, listArgs(), inOther).stdout)[0].installLocation, path.join(other, 'plugins', 'marketplaces', 'make-custom-app'));
		assert.equal(readJson(path.join(config, 'plugins', 'installed_plugins.json')).plugins[ID].length, 1);
	});

	it('each FAKE_CLAUDE_MODE behaves as named', () => {
		const installIn = (mode) => {
			const h = fresh();
			const env = { FAKE_CLAUDE_MODE: mode };
			const config = path.join(h.home, '.claude');
			return { h, config, add: runFake(h, addArgs(), env), install: runFake(h, installArgs(), env), env };
		};

		const addFails = installIn('add-fails');
		assert.equal(addFails.add.status, 1);
		assert.equal(addFails.add.stderr, 'fatal: could not add the marketplace (fake failure)\n');
		assert.deepEqual(JSON.parse(runFake(addFails.h, listArgs(), addFails.env).stdout), []);
		assert.equal(addFails.install.status, 1);
		assert.equal(fs.existsSync(path.join(addFails.config, 'plugins')), false);

		const installFails = installIn('install-fails');
		assert.equal(installFails.add.status, 0);
		assert.equal(installFails.install.status, 1);
		assert.equal(installFails.install.stderr, 'Error: could not install the plugin (fake failure)\n');
		assert.equal(fs.existsSync(path.join(installFails.config, 'plugins', 'cache')), false);
		assert.equal(fs.existsSync(path.join(installFails.config, 'plugins', 'installed_plugins.json')), false);
		assert.equal(statusOf(installFails.h).status, 'absent');

		const noRecord = installIn('install-no-record');
		assert.equal(noRecord.install.status, 0);
		assert.ok(fs.existsSync(path.join(cacheDir(noRecord.config), '.claude-plugin', 'plugin.json')));
		assert.equal(fs.existsSync(path.join(noRecord.config, 'plugins', 'installed_plugins.json')), false);
		const noRecordStatus = statusOf(noRecord.h);
		assert.deepEqual([noRecordStatus.status, noRecordStatus.reason], ['absent', 'not-recorded']);
		assert.equal(problemsOf(noRecordStatus).length, 1);

		const wrong = installIn('wrong-version');
		assert.equal(wrong.install.status, 0);
		assert.equal(readJson(path.join(cacheDir(wrong.config, '2.9.0'), '.claude-plugin', 'plugin.json')).version, '2.9.0');
		assert.equal(fs.existsSync(cacheDir(wrong.config)), false);
		const wrongStatus = statusOf(wrong.h);
		assert.deepEqual([wrongStatus.status, wrongStatus.version], ['usable', '2.9.0']);
		assert.match(problemsOf(wrongStatus).join('\n'), /is below 3\.0\.0/);

		const disabled = installIn('disabled');
		assert.equal(disabled.install.status, 0);
		assert.equal(readJson(path.join(disabled.config, 'settings.json')).enabledPlugins[ID], false);
		assert.equal(readJson(path.join(disabled.config, 'plugins', 'installed_plugins.json')).plugins[ID].length, 1);
		const disabledStatus = statusOf(disabled.h);
		assert.deepEqual([disabledStatus.status, disabledStatus.reason], ['inactive', 'disabled']);
		assert.deepEqual(problemsOf(disabledStatus), []);

		const objectEntry = installIn('object-entry');
		assert.equal(objectEntry.install.status, 0);
		const record = readJson(path.join(objectEntry.config, 'plugins', 'installed_plugins.json')).plugins[ID];
		assert.equal(Array.isArray(record), false);
		assert.equal(record.scope, 'user');
		const objectStatus = statusOf(objectEntry.h);
		assert.equal(objectStatus.status, 'usable');
		assert.equal(objectStatus.installPath, cacheDir(objectEntry.config));
		assert.deepEqual(problemsOf(objectStatus), []);

		const already = fresh();
		const alreadyEnv = { FAKE_CLAUDE_MODE: 'already-added' };
		const alreadyList = JSON.parse(runFake(already, listArgs(), alreadyEnv).stdout);
		assert.deepEqual(alreadyList.map((entry) => entry.name), ['make-custom-app']);
		assert.equal(runFake(already, installArgs(), alreadyEnv).status, 0);
		const alreadyAdd = runFake(already, addArgs(), alreadyEnv);
		assert.equal(alreadyAdd.status, 0);
		assert.match(alreadyAdd.stdout, /already on disk/);
		assert.equal(JSON.parse(runFake(already, listArgs(), alreadyEnv).stdout).length, 1);
		assert.equal(statusOf(already).status, 'usable');

		const hang = fresh();
		const hangEnv = { FAKE_CLAUDE_MODE: 'hang' };
		const started = Date.now();
		assert.equal(runFake(hang, ['--version'], hangEnv, 10000).status, 0);
		for (const argv of [listArgs(), addArgs(), installArgs()]) {
			const result = runFake(hang, argv, hangEnv, 1000);
			assert.equal(result.error && result.error.code, 'ETIMEDOUT', argv.join(' '));
			assert.equal(result.signal, 'SIGTERM');
		}
		assert.ok(Date.now() - started < 20000);
		assert.deepEqual(readLog(hang.log).map((entry) => entry.argv.slice(0, 2).join(' ')), ['--version', 'plugin marketplace', 'plugin marketplace', 'plugin install']);
		assert.equal(fs.existsSync(path.join(hang.home, '.claude', 'plugins')), false);

		const notClaude = fresh();
		assert.equal(runFake(notClaude, ['--version'], { FAKE_CLAUDE_MODE: 'not-claude' }).stdout, '1.0.0 (Other Tool)\n');
		assert.equal(runFake(notClaude, installArgs(), { FAKE_CLAUDE_MODE: 'not-claude' }).status, 2);

		const normal = fresh();
		assert.equal(runFake(normal, addArgs(), { FAKE_CLAUDE_MODE: 'normal' }).status, 0);
		const typo = fresh();
		const typoRun = runFake(typo, ['--version'], { FAKE_CLAUDE_MODE: 'add-fail' });
		assert.equal(typoRun.status, 2);
		assert.equal(typoRun.stderr, 'fake claude: unknown FAKE_CLAUDE_MODE\n');
		assert.equal(fs.existsSync(typo.log), false);
	});

	it('the log records argv, CLAUDECODE, and inherited CLAUDE_CODE_* names, outside HOME', () => {
		const h = fresh();
		assert.deepEqual(readLog(h.log), []);
		assert.deepEqual(Object.keys(h.env).filter((name) => name.startsWith('CLAUDE_CODE_') || name === 'CLAUDECODE'), []);
		const beforeHome = snapshotOld(h.home);
		runFake(h, ['--version'], { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: '00000000-0000-0000-0000-000000000000', CLAUDE_PID: '1' });
		runFake(h, listArgs());
		runFake(h, ['plugin', 'uninstall', ID]);
		runFake(h, ['--version'], { CLAUDECODE: '' });
		assert.deepEqual(readLog(h.log), [
			{ argv: ['--version'], claudecode: true, inherited: ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'] },
			{ argv: listArgs(), claudecode: false, inherited: [] },
			{ argv: ['plugin', 'uninstall', ID], claudecode: false, inherited: [] },
			{ argv: ['--version'], claudecode: true, inherited: [] },
		]);
		const lines = fs.readFileSync(h.log, 'utf8').split('\n');
		assert.equal(lines.length, 5);
		assert.equal(lines[4], '');
		for (const line of lines.slice(0, 4)) assert.deepEqual(Object.keys(JSON.parse(line)), ['argv', 'claudecode', 'inherited']);
		assert.equal(h.log, path.join(h.root, 'fake-claude.log'));
		assert.equal(h.log.startsWith(`${h.home}${path.sep}`), false);
		assert.deepEqual(snapshotOld(h.home), beforeHome);
		assert.equal(fs.existsSync(path.join(h.home, '.claude', 'plugins')), false);
	});

	it('buildOldHome writes what the old installers write, and the malformed variant cuts the file after the token', () => {
		const root = makeRoot();
		const h = buildOldHome({ root, editors: ['claude', 'cursor'] });
		const claudeSkill = path.join(h.home, '.claude', 'skills', 'make-custom-app');
		const cursorSkill = path.join(h.home, '.cursor', 'skills', 'make-custom-app');
		assert.equal(h.home, path.join(root, 'home'));
		assert.equal(h.binDir, path.join(root, 'bin'));
		assert.deepEqual(h.env, {
			PATH: h.binDir,
			HOME: h.home,
			USERPROFILE: h.home,
			TMPDIR: path.join(root, 'tmp'),
			TEMP: path.join(root, 'tmp'),
			TMP: path.join(root, 'tmp'),
			FAKE_CLAUDE_ROOT: root,
			FAKE_CLAUDE_LOG: h.log,
			CLAUDE_BIN: path.join(h.binDir, 'claude'),
		});
		assert.ok(fs.statSync(h.env.TMPDIR).isDirectory());
		assert.equal(fs.existsSync(path.join(h.binDir, 'claude')), false);
		assert.equal(fs.existsSync(h.log), false);

		for (const skill of [claudeSkill, cursorSkill]) {
			const copied = snapshotPaths(skill, ['']).filter((entry) => entry.rel === 'SKILL.md' || entry.rel === 'scripts/check-setup.js' || entry.rel === 'scripts/lib/migrate-logic.js');
			assert.deepEqual(copied.map((entry) => entry.rel), ['SKILL.md', 'scripts/check-setup.js', 'scripts/lib/migrate-logic.js']);
			for (const entry of copied) assert.equal(entry.sha256, snapshotPaths(SKILL_SOURCE, [entry.rel])[0].sha256, entry.rel);
			const sourceFiles = snapshotPaths(SKILL_SOURCE, ['']).filter((entry) => entry.type === 'file').length;
			const copiedFiles = snapshotPaths(skill, ['']).filter((entry) => entry.type === 'file' && !entry.rel.startsWith('mcp-server/')).length;
			assert.equal(copiedFiles, sourceFiles);
			assert.equal(fs.readFileSync(path.join(skill, 'mcp-server', '.env'), 'utf8'), '# Pinecone\nPINECONE_API_KEY=fake-pinecone-0001\nPINECONE_INDEX_NAME=make-app-contexts\n\n# OpenAI (for text-embedding-3-small)\nOPENAI_API_KEY=fake-openai-0001\n');
			assert.ok(fs.statSync(path.join(skill, 'mcp-server', 'dist', 'index.js')).isFile());
		}
		assert.equal(h.paths.claudeSkill, claudeSkill);
		assert.equal(h.paths.cursorSkill, cursorSkill);
		assert.equal(h.paths.claudeEnv, path.join(claudeSkill, 'mcp-server', '.env'));
		assert.equal(h.paths.cursorEnv, path.join(cursorSkill, 'mcp-server', '.env'));

		const claudeJsonText = fs.readFileSync(h.paths.claudeJson, 'utf8');
		const claudeJson = JSON.parse(claudeJsonText);
		assert.equal(claudeJsonText, `${JSON.stringify(claudeJson, null, 2)}\n`);
		const fakeEnv = { PINECONE_API_KEY: 'fake-pinecone-0001', OPENAI_API_KEY: 'fake-openai-0001', PINECONE_INDEX_NAME: 'make-app-contexts' };
		assert.deepEqual(claudeJson.mcpServers['make-custom-app'], { command: process.execPath, args: [path.join(claudeSkill, 'mcp-server', 'dist', 'index.js')], env: fakeEnv });
		assert.equal(claudeJson.mcpServers['other-server'].env.API_TOKEN, 'fake-other-token-1111');
		assert.deepEqual(Object.keys(claudeJson.mcpServers), ['other-server', 'make-custom-app']);
		assert.equal(typeof claudeJson.projects, 'object');
		assert.ok(Object.keys(claudeJson.projects).length > 0);

		const cursorJson = readJson(h.paths.cursorMcp);
		assert.deepEqual(cursorJson.mcpServers['make-app-context'], { command: process.execPath, args: [path.join(cursorSkill, 'mcp-server', 'dist', 'index.js')], env: fakeEnv });
		assert.equal(cursorJson.mcpServers['other-cursor'].env.API_TOKEN, 'fake-cursor-token-2222');
		assert.equal(fs.readFileSync(h.paths.cursorMcp, 'utf8'), `${JSON.stringify(cursorJson, null, 2)}\n`);
		assert.equal(fs.readFileSync(path.join(h.paths.cursorRules, 'make-custom-app.mdc'), 'utf8'), fs.readFileSync(path.join(REPO_ROOT, 'rules', 'make-custom-app.mdc'), 'utf8'));

		const installer = fs.readFileSync(path.join(REPO_ROOT, 'install-claude.sh'), 'utf8');
		const block = /SKILL_SECTION='([^']*)'/.exec(installer);
		assert.ok(block, 'the sentinel block was not found in install-claude.sh');
		assert.equal(fs.readFileSync(h.paths.claudeMd, 'utf8'), `# My notes\n\nA paragraph of the user that the installer keeps.\n\n${block[1]}\n`);

		assert.equal(fs.existsSync(h.paths.secrets), false);
		assert.equal(fs.existsSync(path.join(h.home, '.make-custom-app')), false);
		assert.equal(fs.existsSync(path.join(h.home, '.claude', 'plugins')), false);

		const claudeRoot = h.paths.claudeContexts;
		const cursorRoot = h.paths.cursorContexts;
		assert.equal(claudeRoot, path.join(h.home, '.claude', 'make-app-contexts'));
		assert.equal(cursorRoot, path.join(h.home, '.cursor', 'make-app-contexts'));
		assert.equal(fs.readFileSync(path.join(claudeRoot, 'alpha-v1.md'), 'utf8'), fs.readFileSync(path.join(cursorRoot, 'alpha-v1.md'), 'utf8'));
		const claudeBeta = path.join(claudeRoot, 'beta-v1.md');
		const cursorBeta = path.join(cursorRoot, 'beta-v1.md');
		assert.notEqual(fs.readFileSync(claudeBeta, 'utf8'), fs.readFileSync(cursorBeta, 'utf8'));
		assert.ok(fs.statSync(cursorBeta).mtimeMs > fs.statSync(claudeBeta).mtimeMs);
		assert.equal(fs.readFileSync(path.join(claudeRoot, 'orgapp-v2', 'metadata.json'), 'utf8'), '{"snapshot":{"id":1}}');
		assert.ok(fs.lstatSync(path.join(claudeRoot, 'alpha-v1', 'reviews', 'link.md')).isSymbolicLink());
		const claudeListed = listContextFiles({ root: claudeRoot });
		assert.deepEqual(claudeListed.files.map((file) => file.rel).sort(), ['alpha-v1.md', 'alpha-v1/reviews/nested/review-2.md', 'alpha-v1/reviews/review-1.md', 'beta-v1.md', 'orgapp-v2.md']);
		assert.deepEqual(claudeListed.orgSkipped, ['orgapp-v2/']);
		assert.deepEqual(claudeListed.symlinks, ['alpha-v1/reviews/link.md']);
		const cursorListed = listContextFiles({ root: cursorRoot });
		assert.deepEqual(cursorListed.files.map((file) => file.rel).sort(), ['alpha-v1.md', 'beta-v1.md', 'gamma-v1.md', 'gamma-v1/reviews/gamma-review.md']);
		assert.deepEqual([cursorListed.orgSkipped, cursorListed.symlinks], [[], []]);

		const claudeOnly = buildOldHome({ root: makeRoot() });
		assert.equal(fs.existsSync(path.join(claudeOnly.home, '.cursor', 'skills')), false);
		assert.equal(fs.existsSync(claudeOnly.paths.cursorMcp), false);
		assert.equal(fs.existsSync(claudeOnly.paths.cursorRules), false);
		assert.ok(fs.existsSync(claudeOnly.paths.claudeJson));

		const cursorOnly = buildOldHome({ root: makeRoot(), editors: ['cursor'], contexts: false, secrets: 'make-api-key: fake-make-token-0001\n' });
		assert.equal(fs.existsSync(path.join(cursorOnly.home, '.claude', 'skills')), false);
		assert.equal(fs.existsSync(cursorOnly.paths.claudeJson), false);
		assert.equal(fs.existsSync(cursorOnly.paths.claudeMd), false);
		assert.ok(fs.existsSync(cursorOnly.paths.cursorMcp));
		assert.equal(fs.existsSync(cursorOnly.paths.claudeContexts), false);
		assert.equal(fs.existsSync(cursorOnly.paths.cursorContexts), false);
		assert.equal(fs.readFileSync(cursorOnly.paths.secrets, 'utf8'), 'make-api-key: fake-make-token-0001\n');
		assert.equal(fs.statSync(cursorOnly.paths.secrets).mode & 0o777, 0o600);

		const malformed = buildOldHome({ root: makeRoot(), malformedClaudeJson: true });
		const cut = fs.readFileSync(malformed.paths.claudeJson, 'utf8');
		assert.ok(cut.endsWith('fake-other-token-1111'));
		assert.equal(cut.indexOf('fake-other-token-1111') + 'fake-other-token-1111'.length, cut.length);
		assert.throws(() => JSON.parse(cut), SyntaxError);
		const complete = buildOldHome({ root: makeRoot() });
		const normalize = (text, built) => text.replaceAll(path.dirname(built.home), '<root>');
		const wholeText = normalize(fs.readFileSync(complete.paths.claudeJson, 'utf8'), complete);
		const cutText = normalize(cut, malformed);
		assert.ok(wholeText.startsWith(cutText));
		assert.ok(wholeText.length > cutText.length);

		for (const [plugin, expected] of [['none', 'absent'], ['usable', 'usable'], ['disabled', 'inactive']]) {
			const built = buildOldHome({ root: makeRoot(), plugin });
			const status = readPluginStatus({ env: built.env, home: built.home });
			assert.equal(status.status, expected, plugin);
			if (plugin === 'none') continue;
			assert.equal(status.installPath, cacheDir(path.join(built.home, '.claude')));
			assert.equal(status.version, '3.0.0');
			assert.deepEqual(problemsOf(status), []);
			assert.equal(readJson(path.join(built.home, '.claude', 'settings.json')).enabledPlugins[ID], plugin === 'usable');
		}
	});

	it('the harness helpers take their folders as required parameters and stay inside the test root', () => {
		const outsideRoot = path.join(path.dirname(TEST_ROOT), `p5-never-created-${process.pid}`);
		assert.throws(() => buildOldHome(), { name: 'TypeError', message: 'buildOldHome needs root' });
		assert.throws(() => buildOldHome({ root: '' }), { name: 'TypeError', message: 'buildOldHome needs root' });
		assert.throws(() => buildOldHome({ root: outsideRoot }), /inside the test root/);
		assert.throws(() => buildOldHome({ root: makeRoot(), editors: ['vim'] }), /editors/);
		assert.throws(() => buildOldHome({ root: makeRoot(), plugin: 'maybe' }), /plugin/);
		assert.equal(fs.existsSync(outsideRoot), false);
		assert.throws(() => writeFakeClaude(), { name: 'TypeError', message: 'writeFakeClaude needs binDir and root' });
		assert.throws(() => writeFakeClaude({ binDir: path.join(outsideRoot, 'bin'), root: outsideRoot }), /inside the test root/);
		const root = makeRoot();
		assert.throws(() => writeFakeClaude({ binDir: path.join(path.dirname(root), 'elsewhere-bin'), root }), /inside the root/);
		assert.equal(fs.existsSync(path.join(path.dirname(root), 'elsewhere-bin')), false);
		assert.equal(fs.existsSync(outsideRoot), false);
		assert.throws(() => runScript(), { name: 'TypeError', message: 'runScript needs home, script, and env' });
		assert.throws(() => runScript({ home: root, script: 'check-setup.js' }), { name: 'TypeError', message: 'runScript needs home, script, and env' });
		assert.throws(() => runScript({ home: root, script: 'check-setup.js', env: [] }), /runScript needs/);
		assert.throws(() => runScript({ home: '', script: 'check-setup.js', env: {} }), /runScript needs/);
		assert.throws(() => snapshotOld(), { name: 'TypeError', message: 'snapshotOld needs home' });
		assert.throws(() => snapshotOld(''), { name: 'TypeError', message: 'snapshotOld needs home' });
		assert.throws(() => readLog(), { name: 'TypeError', message: 'readLog needs log' });
		assert.deepEqual(readLog(path.join(root, 'no-such.log')), []);
	});

	it('snapshotOld lists both old installs sorted and detects changes, and runScript runs an installed script with exactly the given env', () => {
		const h = buildOldHome({ root: makeRoot(), editors: ['claude', 'cursor'] });
		const snapshot = snapshotOld(h.home);
		const rels = snapshot.map((entry) => entry.rel);
		assert.deepEqual(rels, [...rels].sort());
		assert.equal(new Set(rels).size, rels.length);
		for (const rel of ['.claude.json', '.cursor/mcp.json', '.claude/CLAUDE.md', '.claude/skills/make-custom-app/SKILL.md', '.cursor/skills/make-custom-app/mcp-server/.env', '.claude/make-app-contexts/alpha-v1.md', '.cursor/make-app-contexts/gamma-v1/reviews/gamma-review.md', '.cursor/rules/make-custom-app/make-custom-app.mdc']) {
			assert.ok(rels.includes(rel), rel);
		}
		assert.equal(rels.some((rel) => rel.startsWith('.make-custom-app') || rel.includes('plugins')), false);
		const link = snapshot.find((entry) => entry.rel === '.claude/make-app-contexts/alpha-v1/reviews/link.md');
		assert.deepEqual([link.type, link.linkTarget, link.sha256, link.size], ['symlink', '../../alpha-v1.md', null, null]);
		const file = snapshot.find((entry) => entry.rel === '.claude.json');
		assert.deepEqual(Object.keys(file), ['rel', 'type', 'mode', 'size', 'sha256', 'mtimeMs', 'linkTarget']);
		assert.deepEqual([file.type, file.linkTarget, typeof file.mtimeMs, file.sha256.length], ['file', null, 'number', 64]);
		assert.equal(file.size, fs.statSync(h.paths.claudeJson).size);
		assert.equal(snapshot.find((entry) => entry.rel === '.claude/make-app-contexts').type, 'dir');
		assert.deepEqual(snapshotOld(h.home), snapshot);

		fs.appendFileSync(path.join(h.paths.claudeContexts, 'beta-v1.md'), 'more\n');
		const changed = snapshotOld(h.home);
		assert.notDeepEqual(changed, snapshot);
		assert.notEqual(changed.find((entry) => entry.rel === '.claude/make-app-contexts/beta-v1.md').sha256, snapshot.find((entry) => entry.rel === '.claude/make-app-contexts/beta-v1.md').sha256);
		fs.writeFileSync(path.join(h.paths.claudeSkill, 'scripts', 'extra.js'), '\n');
		assert.equal(snapshotOld(h.home).length, changed.length + 1);

		const probe = path.join(h.paths.cursorSkill, 'scripts', 'probe.js');
		fs.writeFileSync(probe, "process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd(), argv: process.argv.slice(2) }));\n");
		const env = { ...h.env, PROBE_ONLY: 'yes' };
		const result = runScript({ home: h.home, script: 'probe.js', args: ['--one', 'two'], env, editor: 'cursor' });
		assert.equal(result.status, 0);
		assert.equal(result.stderr, '');
		const seen = JSON.parse(result.stdout);
		// macOS adds this variable to every process
		delete seen.env.__CF_USER_TEXT_ENCODING;
		assert.deepEqual(seen.env, env);
		assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(h.home));
		assert.deepEqual(seen.argv, ['--one', 'two']);

		const check = runScript({ home: h.home, script: 'check-setup.js', args: ['--skip-version', '--json'], env: { ...h.env, NODE_OPTIONS: `--require ${BLOCK_NETWORK}` } });
		assert.equal(check.status, 1);
		assert.equal(check.stderr, '');
		assert.equal(JSON.parse(check.stdout).ok, false);
		fs.writeFileSync(path.join(h.paths.claudeSkill, 'scripts', 'fail.js'), "process.stderr.write('boom\\n');\nprocess.exitCode = 7;\n");
		const failed = runScript({ home: h.home, script: 'fail.js', env: h.env });
		assert.deepEqual([failed.status, failed.stdout, failed.stderr], [7, '', 'boom\n']);
		fs.writeFileSync(path.join(h.paths.claudeSkill, 'scripts', 'slow.js'), 'setTimeout(() => {}, 60000);\n');
		assert.throws(() => runScript({ home: h.home, script: 'slow.js', env: h.env, timeoutMs: 300 }), /did not finish within 300 ms/);
	});

	it('FAKE_CLAUDE_USER_FILE=rewrite emulates the user file rewrite of M5 and M6, and the default leaves it alone', () => {
		const plain = fresh();
		const original = fs.readFileSync(plain.paths.claudeJson, 'utf8');
		assert.equal(runFake(plain, addArgs()).status, 0);
		assert.equal(runFake(plain, installArgs()).status, 0);
		assert.equal(fs.readFileSync(plain.paths.claudeJson, 'utf8'), original);
		assert.equal(fs.existsSync(path.join(plain.home, '.claude', 'backups')), false);

		const h = fresh();
		const seeded = readJson(h.paths.claudeJson);
		const env = { FAKE_CLAUDE_USER_FILE: 'rewrite' };
		assert.equal(runFake(h, addArgs(), env).status, 0);
		const text = fs.readFileSync(h.paths.claudeJson, 'utf8');
		assert.equal(text.endsWith('\n'), false);
		const rewritten = JSON.parse(text);
		for (const key of Object.keys(seeded)) assert.deepEqual(rewritten[key], seeded[key], key);
		const added = Object.keys(rewritten).filter((key) => !Object.hasOwn(seeded, key)).sort();
		assert.deepEqual(added, ['firstStartTime', 'firstStartVersion', 'hasResetAutoModeOptInForDefaultOffer', 'machineID', 'migrationVersion', 'opusProMigrationComplete', 'seenNotifications', 'sonnet1m45MigrationComplete']);
		const backups = path.join(h.home, '.claude', 'backups');
		const copies = fs.readdirSync(backups);
		assert.equal(copies.length, 1);
		assert.match(copies[0], /^\.claude\.json\.backup\.\d+$/);
		assert.equal(fs.readFileSync(path.join(backups, copies[0]), 'utf8'), `${JSON.stringify(seeded, null, 2)}\n`);
		assert.equal(fs.statSync(path.join(backups, copies[0])).mode & 0o777, 0o600);
		assert.equal(runFake(h, installArgs(), env).status, 0);
		assert.equal(fs.readdirSync(backups).length, 1);
		assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(h.paths.claudeJson, 'utf8'))), Object.keys(rewritten));

		const other = fresh();
		const configDir = path.join(other.root, 'config-dir');
		fs.mkdirSync(configDir);
		fs.writeFileSync(path.join(configDir, '.claude.json'), '{"numStartups":1}');
		const beforeHomeFile = fs.readFileSync(other.paths.claudeJson, 'utf8');
		assert.equal(runFake(other, addArgs(), { ...env, CLAUDE_CONFIG_DIR: configDir }).status, 0);
		assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8')).numStartups, 1);
		assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8')), 'machineID'), true);
		assert.equal(fs.readdirSync(path.join(configDir, 'backups')).length, 1);
		assert.equal(fs.readFileSync(other.paths.claudeJson, 'utf8'), beforeHomeFile);

		const missing = fresh({ editors: ['cursor'] });
		assert.equal(fs.existsSync(missing.paths.claudeJson), false);
		assert.equal(runFake(missing, addArgs(), env).status, 0);
		assert.equal(Object.hasOwn(readJson(missing.paths.claudeJson), 'machineID'), true);
		// measured with claude 2.1.312: a .claude.json that claude creates is 0600
		assert.equal(fs.statSync(missing.paths.claudeJson).mode & 0o777, 0o600);
		assert.equal(fs.existsSync(path.join(missing.home, '.claude', 'backups')), false);

		const broken = fresh({ malformedClaudeJson: true });
		const brokenText = fs.readFileSync(broken.paths.claudeJson, 'utf8');
		assert.equal(runFake(broken, addArgs(), env).status, 0);
		assert.equal(fs.readFileSync(broken.paths.claudeJson, 'utf8'), brokenText);
		assert.equal(fs.existsSync(path.join(broken.home, '.claude', 'backups')), false);
	});

	it('the fake claude refuses a sibling folder whose name starts with the name of the root', () => {
		const h = fresh();
		const evil = `${h.root}-evil`;
		fs.mkdirSync(path.join(evil, 'home'), { recursive: true });
		fs.mkdirSync(path.join(evil, 'cfg'));
		const beforeEvil = snapshotPaths(evil, ['']);
		const beforeRoot = snapshotPaths(h.root, ['']);
		const cases = [
			['HOME', { HOME: path.join(evil, 'home') }, 'HOME is outside FAKE_CLAUDE_ROOT'],
			['CLAUDE_CONFIG_DIR', { CLAUDE_CONFIG_DIR: path.join(evil, 'cfg') }, 'CLAUDE_CONFIG_DIR is outside FAKE_CLAUDE_ROOT'],
			['CLAUDE_CONFIG_DIR not yet created', { CLAUDE_CONFIG_DIR: path.join(evil, 'new', 'cfg') }, 'CLAUDE_CONFIG_DIR is outside FAKE_CLAUDE_ROOT'],
			['FAKE_CLAUDE_LOG', { FAKE_CLAUDE_LOG: path.join(evil, 'fake.log') }, 'FAKE_CLAUDE_LOG is outside FAKE_CLAUDE_ROOT'],
		];
		for (const [label, overrides, message] of cases) {
			for (const argv of [['--version'], addArgs(), installArgs()]) {
				const result = runFake(h, argv, overrides);
				assert.equal(result.status, 97, `${label}: ${argv.join(' ')}`);
				assert.equal(result.stdout, '', label);
				assert.equal(result.stderr, `fake claude: ${message}; refusing\n`, label);
			}
		}
		assert.deepEqual(snapshotPaths(evil, ['']), beforeEvil);
		assert.deepEqual(snapshotPaths(h.root, ['']), beforeRoot);
	});

	it('the fake claude refuses a FAKE_CLAUDE_ROOT outside the test root it was written for', () => {
		const h = fresh();
		const parentLink = `${h.root}-parent-link`;
		fs.symlinkSync(path.dirname(TEST_ROOT), parentLink);
		const beforeRoot = snapshotPaths(h.root, ['']);
		const roots = [
			['the file system root', path.parse(TEST_ROOT).root],
			['the folder that holds the test root', path.dirname(TEST_ROOT)],
			['the test root itself', TEST_ROOT],
			['a link to the folder that holds the test root', parentLink],
		];
		for (const [label, root] of roots) {
			for (const argv of [['--version'], installArgs()]) {
				const result = runFake(h, argv, { FAKE_CLAUDE_ROOT: root });
				assert.equal(result.status, 97, `${label}: ${argv.join(' ')}`);
				assert.equal(result.stdout, '', label);
				assert.equal(result.stderr, 'fake claude: FAKE_CLAUDE_ROOT is outside the test root; refusing\n', label);
			}
		}
		assert.deepEqual(snapshotPaths(h.root, ['']), beforeRoot);
		assert.equal(fs.existsSync(h.log), false);
	});

	it('a symlinked FAKE_CLAUDE_ROOT works, whether HOME names the link or the real folder', () => {
		const h = fresh();
		const link = `${h.root}-link`;
		fs.symlinkSync(h.root, link);
		for (const home of [h.home, path.join(link, 'home')]) {
			const overrides = { FAKE_CLAUDE_ROOT: link, HOME: home };
			assert.equal(runFake(h, ['--version'], overrides).status, 0, home);
			assert.equal(runFake(h, addArgs(), overrides).status, 0, home);
			assert.equal(runFake(h, installArgs(), overrides).status, 0, home);
		}
		assert.equal(statusOf(h).status, 'usable');
		assert.equal(readLog(h.log).length, 6);
	});

	describe('writes of the fake claude', () => {
		function refused(label, { setup = () => {}, argv, overrides = () => ({}), stderr }) {
			const h = fresh();
			const outside = makeRoot();
			fs.mkdirSync(path.join(outside, 'dir'));
			fs.writeFileSync(path.join(outside, 'target.json'), '{"keep":true}\n');
			const config = path.join(h.home, '.claude');
			const context = { h, outside, config };
			setup(context);
			const beforeOutside = snapshotPaths(outside, ['']);
			const beforeRoot = snapshotPaths(h.root, ['']);
			const beforeParent = snapshotPaths(TEST_ROOT, ['x']);
			const result = runFake(h, argv, overrides(context));
			assert.equal(result.error, undefined, label);
			assert.equal(result.status, 97, `${label}: ${result.stderr}`);
			assert.equal(result.stdout, '', label);
			assert.match(result.stderr, stderr(context), label);
			assert.deepEqual(snapshotPaths(outside, ['']), beforeOutside, `${label}: the outside folder changed`);
			assert.deepEqual(snapshotPaths(h.root, ['']), beforeRoot, `${label}: the root changed`);
			assert.deepEqual(snapshotPaths(TEST_ROOT, ['x']), beforeParent, label);
		}

		const exact = (text) => () => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`);
		const refusing = (file, what) => exact(`fake claude: ${file} ${what}; refusing`);
		const rewrite = { FAKE_CLAUDE_USER_FILE: 'rewrite' };

		it('refuse an unnormalized HOME, CLAUDE_CONFIG_DIR, or FAKE_CLAUDE_LOG', () => {
			refused('log with a .. segment behind a link', {
				setup: ({ h, outside }) => fs.symlinkSync(path.join(outside, 'dir'), path.join(h.root, 'link')),
				argv: ['--version'],
				overrides: ({ h }) => ({ FAKE_CLAUDE_LOG: `${h.root}/link/../x/fake.log` }),
				stderr: exact('fake claude: FAKE_CLAUDE_LOG contains a .. segment; refusing'),
			});
			refused('HOME with a .. segment', {
				argv: ['--version'],
				overrides: ({ h }) => ({ HOME: `${h.root}/tmp/../home` }),
				stderr: exact('fake claude: HOME contains a .. segment; refusing'),
			});
			refused('CLAUDE_CONFIG_DIR with a .. segment', {
				argv: ['--version'],
				overrides: ({ h }) => ({ CLAUDE_CONFIG_DIR: `${h.root}/tmp/../config` }),
				stderr: exact('fake claude: CLAUDE_CONFIG_DIR contains a .. segment; refusing'),
			});
		});

		it('refuse a FAKE_CLAUDE_LOG that is a link, behind a dangling link, or a folder', () => {
			refused('log a dangling link', {
				setup: ({ h, outside }) => fs.symlinkSync(path.join(outside, 'new.log'), path.join(h.root, 'dangling.log')),
				argv: ['--version'],
				overrides: ({ h }) => ({ FAKE_CLAUDE_LOG: path.join(h.root, 'dangling.log') }),
				stderr: exact('fake claude: FAKE_CLAUDE_LOG is a symbolic link; refusing'),
			});
			refused('log a link to an existing outside file', {
				setup: ({ h, outside }) => fs.symlinkSync(path.join(outside, 'target.json'), path.join(h.root, 'linked.log')),
				argv: ['--version'],
				overrides: ({ h }) => ({ FAKE_CLAUDE_LOG: path.join(h.root, 'linked.log') }),
				stderr: exact('fake claude: FAKE_CLAUDE_LOG is a symbolic link; refusing'),
			});
			refused('log inside a dangling link folder', {
				setup: ({ h, outside }) => fs.symlinkSync(path.join(outside, 'nodir'), path.join(h.root, 'logs')),
				argv: ['--version'],
				overrides: ({ h }) => ({ FAKE_CLAUDE_LOG: path.join(h.root, 'logs', 'fake.log') }),
				stderr: exact('fake claude: FAKE_CLAUDE_LOG cannot be resolved; refusing'),
			});
			refused('log a folder', {
				setup: ({ h }) => fs.mkdirSync(path.join(h.root, 'log-dir')),
				argv: ['--version'],
				overrides: ({ h }) => ({ FAKE_CLAUDE_LOG: path.join(h.root, 'log-dir') }),
				stderr: exact('fake claude: FAKE_CLAUDE_LOG is not a regular file; refusing'),
			});
		});

		it('refuse a settings.json that is a link, before anything else is written', () => {
			refused('settings.json a link', {
				setup: ({ config, outside }) => {
					fs.mkdirSync(config, { recursive: true });
					fs.symlinkSync(path.join(outside, 'target.json'), path.join(config, 'settings.json'));
				},
				argv: addArgs(),
				stderr: ({ config }) => refusing(path.join(config, 'settings.json'), 'is a symbolic link')(),
			});
		});

		it('refuse to read a state file that is a link, also for a command that writes nothing', () => {
			refused('fake-marketplaces.json a link', {
				setup: ({ config, outside }) => {
					fs.mkdirSync(config, { recursive: true });
					fs.symlinkSync(path.join(outside, 'target.json'), path.join(config, 'fake-marketplaces.json'));
				},
				argv: listArgs(),
				stderr: ({ config }) => refusing(path.join(config, 'fake-marketplaces.json'), 'is a symbolic link')(),
			});
		});

		it('refuse a plugins folder that is a link to another folder, before anything else is written', () => {
			refused('plugins a link to an outside folder', {
				setup: ({ config, outside }) => {
					fs.mkdirSync(config, { recursive: true });
					fs.symlinkSync(path.join(outside, 'dir'), path.join(config, 'plugins'));
				},
				argv: addArgs(),
				stderr: () => /^fake claude: .*plugins.* is outside FAKE_CLAUDE_ROOT; refusing\n$/,
			});
		});

		it('refuse installed_plugins.json and the cache folder when they are links', () => {
			const afterAdd = ({ h }) => assert.equal(runFake(h, addArgs()).status, 0);
			refused('installed_plugins.json a link', {
				setup: (context) => {
					afterAdd(context);
					fs.symlinkSync(path.join(context.outside, 'target.json'), path.join(context.config, 'plugins', 'installed_plugins.json'));
				},
				argv: installArgs(),
				stderr: ({ config }) => refusing(path.join(config, 'plugins', 'installed_plugins.json'), 'is a symbolic link')(),
			});
			refused('cache a link to an outside folder', {
				setup: (context) => {
					afterAdd(context);
					fs.symlinkSync(path.join(context.outside, 'dir'), path.join(context.config, 'plugins', 'cache'));
				},
				argv: installArgs(),
				stderr: () => /^fake claude: .*cache.* is outside FAKE_CLAUDE_ROOT; refusing\n$/,
			});
		});

		it('refuse a .claude.json and a backups folder that are links, in the rewrite mode', () => {
			refused('.claude.json a link', {
				setup: ({ h, outside }) => {
					fs.rmSync(h.paths.claudeJson);
					fs.symlinkSync(path.join(outside, 'target.json'), h.paths.claudeJson);
				},
				argv: addArgs(),
				overrides: () => rewrite,
				stderr: ({ h }) => refusing(h.paths.claudeJson, 'is a symbolic link')(),
			});
			refused('backups a link to an outside folder', {
				setup: ({ config, outside }) => {
					fs.mkdirSync(config, { recursive: true });
					fs.symlinkSync(path.join(outside, 'dir'), path.join(config, 'backups'));
				},
				argv: addArgs(),
				overrides: () => rewrite,
				stderr: ({ config }) => refusing(path.join(config, 'backups'), 'is a symbolic link')(),
			});
		});

		it('follow a link to a folder inside the root', () => {
			const h = fresh();
			const config = path.join(h.home, '.claude');
			fs.mkdirSync(path.join(h.root, 'real-plugins'));
			fs.mkdirSync(config, { recursive: true });
			fs.symlinkSync(path.join(h.root, 'real-plugins'), path.join(config, 'plugins'));
			assert.equal(runFake(h, addArgs()).status, 0);
			assert.equal(runFake(h, installArgs()).status, 0);
			assert.ok(fs.existsSync(path.join(h.root, 'real-plugins', 'marketplaces', 'make-custom-app')));
			assert.ok(fs.existsSync(path.join(h.root, 'real-plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0', '.claude-plugin', 'plugin.json')));
			assert.equal(statusOf(h).status, 'usable');
		});
	});

	it('the hang mode ends by itself after FAKE_CLAUDE_HANG_MS, and an invalid value keeps the long default', () => {
		const h = fresh();
		const started = Date.now();
		const ended = runFake(h, listArgs(), { FAKE_CLAUDE_MODE: 'hang', FAKE_CLAUDE_HANG_MS: '1200' }, 15000);
		assert.equal(ended.error, undefined);
		assert.equal(ended.status, 0);
		assert.ok(Date.now() - started >= 1000);
		const invalid = runFake(h, listArgs(), { FAKE_CLAUDE_MODE: 'hang', FAKE_CLAUDE_HANG_MS: 'soon' }, 1000);
		assert.equal(invalid.error && invalid.error.code, 'ETIMEDOUT');
	});

	it('the fake claude starts when the node path holds spaces and a quote, and keeps the plain shebang otherwise', () => {
		const h = buildOldHome({ root: makeRoot() });
		const plain = writeFakeClaude({ binDir: h.binDir, root: h.paths.root });
		const firstLine = (file) => fs.readFileSync(file, 'utf8').split('\n')[0];
		assert.equal(firstLine(plain), shebangFits(process.execPath) ? `#!${process.execPath}` : '#!/bin/sh');
		assert.equal(fs.statSync(plain).mode & 0o777, 0o755);
		const odd = path.join(h.paths.root, "it's a node folder");
		fs.mkdirSync(odd);
		fs.symlinkSync(process.execPath, path.join(odd, 'node'));
		const wrapped = writeFakeClaude({ binDir: path.join(h.paths.root, 'wrapper-bin'), root: h.paths.root, node: path.join(odd, 'node') });
		assert.equal(firstLine(wrapped), '#!/bin/sh');
		assert.equal(fs.statSync(wrapped).mode & 0o777, 0o755);
		const result = spawnSync(wrapped, ['--version'], { cwd: h.home, env: h.env, encoding: 'utf8' });
		assert.equal(result.error, undefined);
		assert.deepEqual([result.status, result.stdout, result.stderr], [0, '2.1.312 (Claude Code)\n', '']);
		assert.deepEqual(readLog(h.log).map((entry) => entry.argv), [['--version']]);
		assert.throws(() => writeFakeClaude({ binDir: h.binDir, root: h.paths.root, node: 'node' }), /node must be an absolute path/);
	});

	it('buildOldHome files carry the modes of the old installers', () => {
		const h = buildOldHome({ root: makeRoot(), editors: ['claude', 'cursor'], secrets: 'make-api-key: fake-make-token-0001\n' });
		const mode = (file) => fs.statSync(file).mode & 0o777;
		// install-claude.sh:285 and install-cursor.sh:251 write mcp-server/.env with a plain heredoc and no chmod (0644 under umask 022)
		assert.deepEqual([mode(h.paths.claudeEnv), mode(h.paths.cursorEnv)], [0o644, 0o644]);
		// install-claude.sh:403 writes ~/.claude.json with fs.writeFileSync and no mode (0644 when the installer creates it)
		assert.equal(mode(h.paths.claudeJson), 0o644);
		// mcp-server/register.js:50 and :81 create ~/.cursor/mcp.json with mode 0600
		assert.equal(mode(h.paths.cursorMcp), 0o600);
		// install-claude.sh:95 and the mv in wire_claude_md: ~/.claude/CLAUDE.md is a mktemp file, so 0600
		assert.equal(mode(h.paths.claudeMd), 0o600);
		// install-claude.sh:155 and install-cursor.sh:83 chmod 600 the secrets file
		assert.equal(mode(h.paths.secrets), 0o600);
		assert.equal(mode(path.join(h.paths.claudeContexts, 'alpha-v1.md')), 0o644);
	});
});

const SCRIPT_NAME = 'migrate-to-plugin.js';
const FAKE_TOKENS = ['fake-pinecone-0001', 'fake-openai-0001', 'fake-other-token-1111', 'fake-cursor-token-2222', 'fake-pinecone-9999'];
const TOKEN_HOLDERS = [
	'home/.claude.json',
	'home/.cursor/mcp.json',
	'home/.claude/skills/make-custom-app/mcp-server/.env',
	'home/.cursor/skills/make-custom-app/mcp-server/.env',
	'home/.make-custom-app-skill-secrets',
];
const CLAUDE_BACKUP = /^home\/\.claude\/backups\/\.claude\.json\.backup\.\d+$/;
const HOST_CLAUDE_FALLBACKS = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
const HOST_HAS_CLAUDE = HOST_CLAUDE_FALLBACKS.some((file) => fs.existsSync(file));
const IS_ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;
const COMMANDS = {
	version: ['--version'],
	list: ['plugin', 'marketplace', 'list', '--json'],
	add: ['plugin', 'marketplace', 'add', MARKETPLACE_URL],
	install: ['plugin', 'install', ID],
};
const KEYS_COPIED = 'MCP keys copied to ~/.make-custom-app-skill-secrets: pinecone-api-key, openai-api-key, pinecone-index-name';
const NOTHING_DELETED = 'Nothing was deleted. The old skill keeps working until the cleanup.';
const NEXT_RESTART_CLAUDE = 'Next: restart Claude Code, then run /make-custom-app:make-app-setup (or start any Make task). It lists the old install and removes it after you confirm.';
const NEXT_RESTART_CURSOR =
	'Next: turn on the Cursor setting Include Third-Party Plugins (Cursor loads the plugin installed for Claude Code), restart Cursor, then run /make-app-setup (or start any Make task). It lists the old install and removes it after you confirm.';
const NEXT_HANDOFF = 'Next: continue with the make-app-setup skill of the plugin; it lists the old install and removes it after you confirm.';
const ORG_NOTE = '  skipped orgapp-v2/ (written by the org downloader; its data can be partial)';
const SYMLINK_NOTE = '  skipped alpha-v1/reviews/link.md (a symbolic link)';
const RETRY_LINE = 'The plugin is installed, but some files could not be copied (see above). Run this script again to retry the copies; nothing is copied twice.';
const MANUAL_STEPS = [
	'Run these in your own terminal, then run this script again:',
	`  claude plugin marketplace add ${MARKETPLACE_URL}`,
	`  claude plugin install ${ID}`,
];
const LOCK_PATH = '~/.make-custom-app/cleanup.lock';
const lockLine = (pid) =>
	pid === null
		? `Another migration or cleanup is running (lock ${LOCK_PATH}). Nothing was copied; run this script again. If no other run is active, delete ${LOCK_PATH} and ${LOCK_PATH}.takeover, then run it again.`
		: `Another migration or cleanup is running (lock ${LOCK_PATH}, pid ${pid}). Nothing was copied; run this script again.`;
const CONTEXT_FILES = [
	'alpha-v1.md',
	'alpha-v1/reviews/nested/review-2.md',
	'alpha-v1/reviews/review-1.md',
	'beta-v1.md',
	'gamma-v1.md',
	'gamma-v1/reviews/gamma-review.md',
	'orgapp-v2.md',
];
const DUPLICATE_NOTE = '  both editors had beta-v1.md: used the Cursor copy (newer)';
const CONTEXTS_LINE = (copied, notes) => `App contexts copied to ~/.make-custom-app/contexts: ${copied} files; ${notes} notes below`;

function walkFiles(root) {
	const found = [];
	const visit = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(abs);
			else if (entry.isFile()) found.push(abs);
		}
	};
	visit(root);
	return found.sort();
}

// the copied old skill carries this repo's own test files, which spell the seeds
const COPIED_TESTS = /^home\/\.(claude|cursor)\/skills\/make-custom-app\/scripts\/lib\/__tests__\//;

function tokenFiles(root) {
	const hits = {};
	for (const file of walkFiles(root)) {
		if (COPIED_TESTS.test(path.relative(root, file))) continue;
		const content = fs.readFileSync(file);
		const found = FAKE_TOKENS.filter((token) => content.includes(token));
		if (found.length > 0) hits[path.relative(root, file)] = found;
	}
	return hits;
}

function assertNoLeaks(h, outputs, { allowBackup = false, holders = [] } = {}) {
	for (const [rel, found] of Object.entries(tokenFiles(h.root))) {
		const allowed = TOKEN_HOLDERS.includes(rel) || holders.includes(rel) || (allowBackup && CLAUDE_BACKUP.test(rel));
		assert.ok(allowed, `${rel} holds ${found.join(', ')}`);
		if (rel === 'home/.make-custom-app-skill-secrets') {
			assert.deepEqual(
				found.filter((token) => token === 'fake-other-token-1111' || token === 'fake-cursor-token-2222'),
				[],
				'the token of another server reached the secrets file',
			);
		}
	}
	for (const text of outputs) {
		for (const token of FAKE_TOKENS) assert.equal(text.includes(token), false, `an output holds ${token}`);
	}
}

function assertOnlyOurCalls(h) {
	for (const entry of readLog(h.log)) {
		assert.ok(
			Object.values(COMMANDS).some((argv) => JSON.stringify(argv) === JSON.stringify(entry.argv)),
			`unexpected claude call: ${entry.argv.join(' ')}`,
		);
		assert.doesNotMatch(entry.argv.join(' '), /uninstall|remove|disable|enable|\bmcp\b/);
	}
}

const NODE_WARNING = `Warning: Node ${process.versions.node} is older than 20; the plugin's MCP server is built for Node 20 or newer.\n`;

// the script warns on stderr when it runs on Node 18, so a run on that Node must show the warning, and the rest is compared as on Node 20 and later
function withoutNodeWarning(result) {
	if (Number(process.versions.node.split('.')[0]) >= 20 || result.status === 2) return result;
	assert.ok(result.stderr.startsWith(NODE_WARNING), 'the warning for Node 18 is missing');
	return { ...result, stderr: result.stderr.slice(NODE_WARNING.length) };
}

function withoutDirTimes(snapshot) {
	return snapshot.map((entry) => ({ ...entry, mtimeMs: entry.type === 'dir' ? null : entry.mtimeMs }));
}

function nonEmptyLines(text) {
	return text.split('\n').filter((line) => line !== '');
}

function linesOf(...lines) {
	return `${lines.join('\n')}\n`;
}

function seedThrottle(h) {
	const file = path.join(h.paths.tmp, `make-custom-app-plugin-prompt-${process.getuid()}.json`);
	fs.writeFileSync(file, JSON.stringify({ state: 'ask', shownAt: Date.now() }), { mode: 0o600 });
	return file;
}

function lockFile(h) {
	return path.join(h.home, '.make-custom-app', 'cleanup.lock');
}

function writeLock(h, text) {
	fs.mkdirSync(path.join(h.home, '.make-custom-app'), { recursive: true, mode: 0o700 });
	fs.writeFileSync(lockFile(h), text, { mode: 0o600 });
}

function relativeFiles(root) {
	return walkFiles(root).map((file) => path.relative(root, file).split(path.sep).join('/'));
}

function deadPid() {
	const pid = spawnSync(process.execPath, ['-e', '0']).pid;
	assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
	return pid;
}

describe('migrate-to-plugin.js', POSIX_ONLY, () => {
	function fresh({ withClaude = true, ...options } = {}) {
		const root = makeRoot();
		const h = buildOldHome({ root, ...options });
		if (withClaude) writeFakeClaude({ binDir: h.binDir, root });
		return { root, ...h };
	}

	function execute(h, args = [], overrides = {}, options = {}) {
		const { editor = 'claude', skipRels = [], allowBackup = false, holders = [], timeoutMs, beforeWarning = false } = options;
		const before = snapshotOld(h.home).filter((entry) => !skipRels.includes(entry.rel));
		const env = withEnv({ ...h.env, NODE_OPTIONS: `--require ${BLOCK_NETWORK}` }, overrides);
		const ran = runScript({ home: h.home, script: SCRIPT_NAME, args: ['--skip-version', ...args], env, editor, timeoutMs });
		const result = beforeWarning ? ran : withoutNodeWarning(ran);
		assert.deepEqual(
			snapshotOld(h.home).filter((entry) => !skipRels.includes(entry.rel)),
			before,
			'the old install changed',
		);
		assertOnlyOurCalls(h);
		assertNoLeaks(h, [result.stdout, result.stderr], { allowBackup, holders });
		return result;
	}

	const callsOf = (h) => readLog(h.log).map((entry) => entry.argv);
	const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
	const secretsText = (h) => fs.readFileSync(h.paths.secrets, 'utf8');
	const installDir = (h, version = '3.0.0') => path.join(h.home, '.claude', 'plugins', 'cache', 'make-custom-app', 'make-custom-app', version);

	function installFailure(reason, h) {
		return linesOf(`Could not install the plugin: ${reason}`, 'claude --version reported: 2.1.312 (Claude Code)', ...MANUAL_STEPS);
	}

	function assertNothingCopied(h) {
		assert.equal(fs.existsSync(h.paths.secrets), false);
		assert.equal(fs.existsSync(path.join(h.home, '.make-custom-app')), false);
	}

	it('happy path: installs, copies the keys and the contexts, prints the summary, exit 0, and removes the throttle file', () => {
		const h = fresh();
		const throttle = seedThrottle(h);
		const result = execute(h);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, '');
		assert.equal(
			result.stdout,
			linesOf(
				`Plugin ${ID}: installed, version 3.0.0`,
				KEYS_COPIED,
				CONTEXTS_LINE(7, 3),
				ORG_NOTE,
				DUPLICATE_NOTE,
				SYMLINK_NOTE,
				NOTHING_DELETED,
				NEXT_RESTART_CLAUDE,
			),
		);
		assert.deepEqual(callsOf(h), [COMMANDS.version, COMMANDS.list, COMMANDS.add, COMMANDS.install]);
		assert.equal(secretsText(h), 'pinecone-api-key: fake-pinecone-0001\nopenai-api-key: fake-openai-0001\npinecone-index-name: make-app-contexts\n');
		assert.equal(fs.statSync(h.paths.secrets).mode & 0o777, 0o600);
		assert.deepEqual(relativeFiles(h.paths.newContexts), CONTEXT_FILES);
		for (const rel of CONTEXT_FILES) {
			const fromCursor = rel === 'beta-v1.md' || rel.startsWith('gamma-v1');
			const source = path.join(fromCursor ? h.paths.cursorContexts : h.paths.claudeContexts, rel);
			const copy = path.join(h.paths.newContexts, rel);
			assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(source, 'utf8'), rel);
			assert.ok(Math.abs(fs.statSync(copy).mtimeMs - fs.statSync(source).mtimeMs) < 5, `${rel} keeps the modification time`);
		}
		assert.equal(fs.statSync(path.join(h.home, '.make-custom-app')).mode & 0o777, 0o700);
		assert.equal(fs.statSync(h.paths.newContexts).mode & 0o777, 0o700);
		assert.deepEqual(fs.readdirSync(path.join(h.home, '.make-custom-app')), ['contexts']);
		assert.equal(fs.existsSync(throttle), false);
		const status = readPluginStatus({ env: h.env, home: h.home });
		assert.deepEqual([status.status, status.version, status.installPath], ['usable', '3.0.0', installDir(h)]);
	});

	it('handoff with a usable plugin and CLAUDE_BIN naming a missing file: exit 0, copies done, no fake claude call, claude.bin null, and the Next line names make-app-setup without a restart', () => {
		const h = fresh({ plugin: 'usable' });
		const missing = { CLAUDE_BIN: path.join(h.root, 'nowhere', 'claude') };
		const result = execute(h, [], missing);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, '');
		const lines = nonEmptyLines(result.stdout);
		assert.equal(lines[0], `Plugin ${ID}: already installed, version 3.0.0`);
		assert.equal(lines[1], KEYS_COPIED);
		assert.equal(lines[2], CONTEXTS_LINE(7, 3));
		const next = lines[lines.length - 1];
		assert.equal(next, NEXT_HANDOFF);
		assert.match(next, /make-app-setup/);
		assert.doesNotMatch(next, /restart/i);
		assert.equal(fs.existsSync(h.log), false);
		assert.deepEqual(relativeFiles(h.paths.newContexts), CONTEXT_FILES);

		const json = execute(fresh({ plugin: 'usable' }), ['--json'], missing);
		assert.equal(json.status, 0);
		const report = JSON.parse(json.stdout);
		assert.deepEqual(report.claude, { bin: null, version: null });
		assert.deepEqual(report.plugin, { action: 'present', version: '3.0.0', problems: [] });
		assert.deepEqual(report.marketplace, { action: 'skipped', source: null });
		assert.deepEqual(report.next, [NEXT_HANDOFF]);
		assert.equal(report.contexts.copied, 7);
		assert.deepEqual(report.secrets.copied, ['pinecone-api-key', 'openai-api-key', 'pinecone-index-name']);
	});

	it('a second run changes nothing and reports already installed', () => {
		const h = fresh();
		assert.equal(execute(h).status, 0);
		const homeBefore = withoutDirTimes(snapshotPaths(h.home, ['']));
		const secretsBefore = fs.statSync(h.paths.secrets).mtimeMs;
		const second = execute(h);
		assert.equal(second.status, 0, second.stderr);
		assert.equal(second.stderr, '');
		assert.equal(
			second.stdout,
			linesOf(
				`Plugin ${ID}: already installed, version 3.0.0`,
				'MCP keys kept (the secrets file already had a value): pinecone-api-key, openai-api-key, pinecone-index-name',
				CONTEXTS_LINE(0, 3),
				ORG_NOTE,
				DUPLICATE_NOTE,
				SYMLINK_NOTE,
				NOTHING_DELETED,
				NEXT_HANDOFF,
			),
		);
		assert.deepEqual(withoutDirTimes(snapshotPaths(h.home, [''])), homeBefore);
		assert.equal(fs.statSync(h.paths.secrets).mtimeMs, secretsBefore);
		assert.equal(callsOf(h).length, 4);
		assert.deepEqual(fs.readdirSync(path.join(h.home, '.make-custom-app')), ['contexts']);
	});

	it('already-added: no marketplace add call', () => {
		const h = fresh();
		const result = execute(h, [], { FAKE_CLAUDE_MODE: 'already-added' });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(callsOf(h), [COMMANDS.version, COMMANDS.list, COMMANDS.install]);
		const lines = nonEmptyLines(result.stdout);
		assert.equal(lines[0], `Plugin ${ID}: installed, version 3.0.0`);
		assert.equal(lines[1], `Marketplace make-custom-app was already there (${MARKETPLACE_URL}); it was kept.`);
	});

	it('add-fails and install-fails: exit 1, the two commands printed, nothing copied', () => {
		const addFails = fresh();
		const throttle = seedThrottle(addFails);
		const first = execute(addFails, [], { FAKE_CLAUDE_MODE: 'add-fails' });
		assert.equal(first.status, 1);
		assert.equal(first.stdout, '');
		assert.equal(first.stderr, installFailure('fatal: could not add the marketplace (fake failure)', addFails));
		assert.deepEqual(callsOf(addFails), [COMMANDS.version, COMMANDS.list, COMMANDS.add]);
		assertNothingCopied(addFails);
		assert.equal(fs.existsSync(throttle), true);

		const installFails = fresh();
		const second = execute(installFails, [], { FAKE_CLAUDE_MODE: 'install-fails' });
		assert.equal(second.status, 1);
		assert.equal(second.stdout, '');
		assert.equal(second.stderr, installFailure('Error: could not install the plugin (fake failure)', installFails));
		assert.deepEqual(callsOf(installFails), [COMMANDS.version, COMMANDS.list, COMMANDS.add, COMMANDS.install]);
		assertNothingCopied(installFails);
	});

	it('install-no-record and wrong-version: exit 1 with "could not be verified"', () => {
		const noRecord = fresh();
		const first = execute(noRecord, [], { FAKE_CLAUDE_MODE: 'install-no-record' });
		assert.equal(first.status, 1);
		assert.equal(first.stdout, '');
		assert.equal(first.stderr, linesOf('The plugin install could not be verified: claude did not record the plugin as installed (not-recorded)'));
		assertNothingCopied(noRecord);

		const wrong = fresh();
		const second = execute(wrong, [], { FAKE_CLAUDE_MODE: 'wrong-version' });
		assert.equal(second.status, 1);
		assert.equal(second.stdout, '');
		const manifest = path.join(installDir(wrong, '2.9.0'), '.claude-plugin', 'plugin.json');
		assert.equal(second.stderr, linesOf(`The plugin install could not be verified: the version in ${manifest} (2.9.0) is below 3.0.0`));
		assertNothingCopied(wrong);
	});

	it('hang: --timeout 5 ends the run with exit 1 in under 15 seconds', () => {
		const h = fresh();
		const started = Date.now();
		const result = execute(h, ['--timeout', '5'], { FAKE_CLAUDE_MODE: 'hang', FAKE_CLAUDE_HANG_MS: '9000' });
		assert.ok(Date.now() - started < 15000);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, '');
		assert.equal(result.stderr, installFailure('claude did not finish within 5 seconds (marketplace list)', h));
		assert.deepEqual(callsOf(h), [COMMANDS.version, COMMANDS.list]);
		assertNothingCopied(h);
	});

	it('a claude that ignores SIGTERM is killed for good: --timeout 5 ends the run in under 15 seconds with the timeout message and exit 1', () => {
		const h = fresh();
		const started = Date.now();
		const result = execute(h, ['--timeout', '5'], { FAKE_CLAUDE_MODE: 'hang-trap', FAKE_CLAUDE_HANG_MS: '20000' });
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 15000, `the run took ${elapsed} ms`);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, '');
		assert.equal(result.stderr, installFailure('claude did not finish within 5 seconds (marketplace list)', h));
		assert.deepEqual(callsOf(h), [COMMANDS.version, COMMANDS.list]);
		assertNothingCopied(h);
	});

	it('an empty HOME ends with the unexpected error line and exit 1, no stack trace, and nothing written', () => {
		const h = fresh();
		const homeBefore = snapshotPaths(h.home, ['']);
		const tmpBefore = snapshotPaths(h.paths.tmp, ['']);
		const result = execute(h, [], { HOME: '', USERPROFILE: '' }, { beforeWarning: true });
		assert.equal(result.status, 1);
		assert.equal(result.stdout, '');
		assert.equal(result.stderr, 'migrate-to-plugin: unexpected error: an unexpected error occurred\n');
		assert.deepEqual(snapshotPaths(h.home, ['']), homeBefore);
		assert.deepEqual(snapshotPaths(h.paths.tmp, ['']), tmpBefore);
		assert.equal(fs.existsSync(h.log), false);
	});

	it('disabled: exit 0, the enable command printed, copies done, no enable call', () => {
		const h = fresh();
		const result = execute(h, [], { FAKE_CLAUDE_MODE: 'disabled' });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			result.stdout,
			linesOf(
				`Plugin ${ID}: installed but disabled, version 3.0.0`,
				KEYS_COPIED,
				CONTEXTS_LINE(7, 3),
				ORG_NOTE,
				DUPLICATE_NOTE,
				SYMLINK_NOTE,
				NOTHING_DELETED,
				`The plugin is installed but disabled; this script does not enable it. To use it, run in your own terminal: claude plugin enable ${ID}`,
			),
		);
		assert.deepEqual(callsOf(h), [COMMANDS.version, COMMANDS.list, COMMANDS.add, COMMANDS.install]);
		assert.equal(readJson(path.join(h.home, '.claude', 'settings.json')).enabledPlugins[ID], false);

		const inactive = fresh({ plugin: 'disabled' });
		const again = execute(inactive, [], { CLAUDE_BIN: path.join(inactive.root, 'nowhere', 'claude') });
		assert.equal(again.status, 0, again.stderr);
		assert.equal(nonEmptyLines(again.stdout)[0], `Plugin ${ID}: installed but disabled, version 3.0.0`);
		assert.ok(again.stdout.includes(`claude plugin enable ${ID}`));
		assert.equal(fs.existsSync(inactive.log), false);
		assert.equal(readJson(path.join(inactive.home, '.claude', 'settings.json')).enabledPlugins[ID], false);
	});

	it('object-entry: the record is read', () => {
		const h = fresh();
		const result = execute(h, [], { FAKE_CLAUDE_MODE: 'object-entry' });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(nonEmptyLines(result.stdout)[0], `Plugin ${ID}: installed, version 3.0.0`);
		assert.equal(Array.isArray(readJson(path.join(h.home, '.claude', 'plugins', 'installed_plugins.json')).plugins[ID]), false);
		assert.equal(fs.existsSync(h.paths.secrets), true);
	});

	it('CLAUDECODE set in the parent never reaches the fake claude, and CLAUDE_CODE_ENTRYPOINT and CLAUDE_CODE_SESSION_ID do', () => {
		const h = fresh();
		const result = execute(h, [], {
			CLAUDECODE: '1',
			CLAUDE_CODE_ENTRYPOINT: 'cli',
			CLAUDE_CODE_SESSION_ID: '00000000-0000-0000-0000-000000000000',
			CLAUDE_PID: '1',
		});
		assert.equal(result.status, 0, result.stderr);
		const log = readLog(h.log);
		assert.equal(log.length, 4);
		for (const entry of log) {
			assert.equal(entry.claudecode, false, entry.argv.join(' '));
			assert.deepEqual(entry.inherited, ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'], entry.argv.join(' '));
		}
	});

	it('the child sees the fake HOME: every log line comes from a run inside FAKE_CLAUDE_ROOT', () => {
		const h = fresh();
		const probeDir = path.join(h.root, 'probe-bin');
		const record = path.join(h.root, 'probe-record.jsonl');
		fs.mkdirSync(probeDir);
		const probe = path.join(probeDir, 'claude');
		const real = path.join(h.binDir, 'claude');
		fs.writeFileSync(
			probe,
			[
				`#!${process.execPath}`,
				"const fs = require('fs');",
				`fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ env: process.env, cwd: process.cwd() }) + '\\n');`,
				`const run = require('child_process').spawnSync(${JSON.stringify(real)}, process.argv.slice(2), { stdio: 'inherit', env: process.env });`,
				'process.exitCode = run.status;',
				'',
			].join('\n'),
		);
		fs.chmodSync(probe, 0o755);
		const parent = {
			CLAUDE_BIN: probe,
			USERPROFILE: path.join(h.root, 'other-profile'),
			CLAUDECODE: '1',
			CLAUDE_CODE_ENTRYPOINT: 'cli',
			CLAUDE_PID: '1',
			KEEP_ME: 'yes',
		};
		const result = execute(h, [], parent);
		assert.equal(result.status, 0, result.stderr);
		const calls = fs
			.readFileSync(record, 'utf8')
			.split('\n')
			.filter((line) => line !== '')
			.map((line) => JSON.parse(line));
		assert.equal(calls.length, 4);
		const expected = withEnv({ ...h.env, NODE_OPTIONS: `--require ${BLOCK_NETWORK}` }, { ...parent, CLAUDE_BIN: probe, HOME: h.home, USERPROFILE: h.home, CLAUDECODE: undefined });
		for (const call of calls) {
			// macOS adds the first variable to every process, and node adds the second one to every child while it collects coverage
			delete call.env.__CF_USER_TEXT_ENCODING;
			delete call.env.NODE_V8_COVERAGE;
			assert.deepEqual(call.env, expected);
			assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(h.home));
		}
		assert.equal(callsOf(h).length, 4);
	});

	it('finds claude on the PATH when CLAUDE_BIN is not set', () => {
		const h = fresh();
		const result = execute(h, [], { CLAUDE_BIN: undefined });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(callsOf(h), [COMMANDS.version, COMMANDS.list, COMMANDS.add, COMMANDS.install]);
	});

	it('no claude from the Cursor install: exit 5, the three lines, and the whole HOME unchanged', { skip: HOST_HAS_CLAUDE && 'the host has a claude in a usual install folder' }, () => {
		const h = fresh({ withClaude: false, editors: ['cursor'] });
		const throttle = seedThrottle(h);
		const homeBefore = snapshotPaths(h.home, ['']);
		const result = execute(h, [], { CLAUDE_BIN: undefined }, { editor: 'cursor' });
		assert.equal(result.status, 5);
		assert.equal(result.stdout, '');
		assert.equal(
			result.stderr,
			linesOf(
				'Claude Code was not found (looked at CLAUDE_BIN, the PATH, and the usual install folders).',
				'Installing the make-custom-app plugin for Cursor alone is not supported yet. This skill keeps working; nothing was changed.',
				'If Claude Code is installed in another folder, run this script again with CLAUDE_BIN set to its path.',
			),
		);
		assert.deepEqual(snapshotPaths(h.home, ['']), homeBefore);
		assert.equal(fs.existsSync(h.log), false);
		assert.equal(fs.existsSync(throttle), true);
	});

	it('no claude from the Claude install: exit 5 and the two slash commands', { skip: HOST_HAS_CLAUDE && 'the host has a claude in a usual install folder' }, () => {
		const h = fresh({ withClaude: false });
		const homeBefore = snapshotPaths(h.home, ['']);
		const result = execute(h, [], { CLAUDE_BIN: undefined });
		assert.equal(result.status, 5);
		assert.equal(result.stdout, '');
		assert.equal(
			result.stderr,
			linesOf(
				'Claude Code was not found (looked at CLAUDE_BIN, the PATH, and the usual install folders). Nothing was changed. In Claude Code, run these two commands, then restart Claude Code:',
				`  /plugin marketplace add ${MARKETPLACE_URL}`,
				`  /plugin install ${ID}`,
			),
		);
		assert.deepEqual(snapshotPaths(h.home, ['']), homeBefore);
	});

	it('CLAUDE_BIN naming a missing file or a file that is not executable: exit 5 and the search stops', () => {
		const h = fresh();
		const missing = path.join(h.root, 'nowhere', 'claude');
		const first = execute(h, [], { CLAUDE_BIN: missing });
		assert.equal(first.status, 5);
		assert.equal(first.stdout, '');
		assert.equal(first.stderr, linesOf(`CLAUDE_BIN is set to ${missing}, which is not an executable file. Nothing was changed.`));
		const plain = path.join(h.root, 'plain-claude');
		fs.writeFileSync(plain, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
		const second = execute(h, [], { CLAUDE_BIN: plain });
		assert.equal(second.status, 5);
		assert.equal(second.stderr, linesOf(`CLAUDE_BIN is set to ${plain}, which is not an executable file. Nothing was changed.`));
		assert.equal(fs.existsSync(h.log), false);
		assertNothingCopied(h);
	});

	it('not-claude: exit 5', () => {
		const h = fresh();
		const throttle = seedThrottle(h);
		const result = execute(h, [], { FAKE_CLAUDE_MODE: 'not-claude' });
		assert.equal(result.status, 5);
		assert.equal(result.stdout, '');
		assert.equal(
			result.stderr,
			linesOf(`${path.join(h.binDir, 'claude')} is not Claude Code (claude --version printed "1.0.0 (Other Tool)"). Nothing was changed. Set CLAUDE_BIN to the claude binary of Claude Code and run this script again.`),
		);
		assert.deepEqual(callsOf(h), [COMMANDS.version]);
		assertNothingCopied(h);
		assert.equal(fs.existsSync(throttle), true);
	});

	it('the fake tokens appear in no output and in no file outside ~/.claude.json, ~/.cursor/mcp.json, the old .env files, and the secrets file, also with the malformed ~/.claude.json', () => {
		const both = fresh({ editors: ['claude', 'cursor'] });
		const first = execute(both);
		assert.equal(first.status, 0, first.stderr);
		const held = tokenFiles(both.root);
		assert.deepEqual(Object.keys(held).sort(), [...TOKEN_HOLDERS].sort());
		assert.deepEqual(held['home/.make-custom-app-skill-secrets'], ['fake-pinecone-0001', 'fake-openai-0001']);

		const malformed = fresh({ malformedClaudeJson: true });
		const second = execute(malformed);
		assert.equal(second.status, 4);
		assert.equal(second.stderr, '');
		assert.ok(second.stdout.includes(`MCP keys: not copied completely (${malformed.paths.claudeJson} is not valid JSON)`));
		assert.ok(second.stdout.includes(RETRY_LINE));
		assert.equal(secretsText(malformed), 'pinecone-api-key: fake-pinecone-0001\nopenai-api-key: fake-openai-0001\npinecone-index-name: make-app-contexts\n');
		assert.equal(fs.readFileSync(malformed.paths.claudeJson, 'utf8').endsWith('fake-other-token-1111'), true);
		const json = execute(malformed, ['--json']);
		assert.equal(json.status, 4);
		assert.equal(JSON.parse(json.stdout).secrets.error, `${malformed.paths.claudeJson} is not valid JSON`);
	});

	it('a malformed ~/.cursor/mcp.json gives "is not valid JSON" and no seed value in any output or new file', () => {
		const h = fresh({ editors: ['claude', 'cursor'] });
		const token = 'fake-cursor-token-2222';
		const text = fs.readFileSync(h.paths.cursorMcp, 'utf8');
		fs.writeFileSync(h.paths.cursorMcp, text.slice(0, text.indexOf(token) + token.length), { mode: 0o600 });
		const first = execute(h);
		assert.equal(first.status, 4);
		assert.equal(first.stderr, '');
		assert.ok(first.stdout.includes(`MCP keys: not copied completely (${h.paths.cursorMcp} is not valid JSON)\n`));
		assert.ok(first.stdout.endsWith(`${RETRY_LINE}\n`));
		assert.equal(secretsText(h), 'pinecone-api-key: fake-pinecone-0001\nopenai-api-key: fake-openai-0001\npinecone-index-name: make-app-contexts\n');
		const json = execute(h, ['--json']);
		assert.equal(json.status, 4);
		assert.equal(JSON.parse(json.stdout).secrets.error, `${h.paths.cursorMcp} is not valid JSON`);
		assert.equal(fs.readFileSync(h.paths.cursorMcp, 'utf8').endsWith(token), true);
	});

	it('the host folders that the "no claude anywhere" tests guard against are the absolute fallbacks of findClaudeBinary', () => {
		const home = path.join(TEST_ROOT, 'no-such-home');
		const seen = [];
		const found = findClaudeBinary({
			env: { PATH: '' },
			home,
			platform: 'linux',
			isExecutable: (file) => {
				seen.push(file);
				return false;
			},
		});
		assert.deepEqual(found, { bin: null, explicit: false });
		assert.deepEqual(
			seen.filter((file) => !file.startsWith(`${home}${path.sep}`)),
			HOST_CLAUDE_FALLBACKS,
		);
	});

	it('the hang-trap mode of the fake ignores SIGTERM and ends by itself, and SIGKILL stops it at once', () => {
		const h = fresh();
		const env = withEnv(h.env, { FAKE_CLAUDE_MODE: 'hang-trap', FAKE_CLAUDE_HANG_MS: '2500' });
		const started = Date.now();
		const termed = spawnSync(path.join(h.binDir, 'claude'), COMMANDS.list, { cwd: h.home, env, encoding: 'utf8', timeout: 600 });
		assert.equal(termed.error && termed.error.code, 'ETIMEDOUT');
		assert.ok(Date.now() - started >= 2000, 'the fake ended on SIGTERM');
		const killedAt = Date.now();
		const killed = spawnSync(path.join(h.binDir, 'claude'), COMMANDS.list, { cwd: h.home, env, encoding: 'utf8', timeout: 600, killSignal: 'SIGKILL' });
		assert.equal(killed.error && killed.error.code, 'ETIMEDOUT');
		assert.equal(killed.signal, 'SIGKILL');
		assert.ok(Date.now() - killedAt < 2000);
	});

	it('existing secrets-file values win and are reported by key name, and a source value that differs from an existing value is a conflict with used secrets-file, by key name and source label only', () => {
		const h = fresh({ secrets: 'make-api-key: fake-make-token-0001\npinecone-api-key: fake-pinecone-9999\nopenai-api-key: fake-openai-0001\n' });
		const result = execute(h);
		assert.equal(result.status, 0, result.stderr);
		const lines = nonEmptyLines(result.stdout);
		assert.deepEqual(lines.slice(0, 4), [
			`Plugin ${ID}: installed, version 3.0.0`,
			'MCP keys copied to ~/.make-custom-app-skill-secrets: pinecone-index-name',
			'MCP keys kept (the secrets file already had a value): pinecone-api-key, openai-api-key',
			'MCP keys that differ from the old install (the value in the secrets file is used, so the plugin uses another value than the old registration): pinecone-api-key (claude-registration, claude-env)',
		]);
		assert.equal(secretsText(h), 'make-api-key: fake-make-token-0001\npinecone-api-key: fake-pinecone-9999\nopenai-api-key: fake-openai-0001\npinecone-index-name: make-app-contexts\n');
		assert.equal(fs.statSync(h.paths.secrets).mode & 0o777, 0o600);
		assert.equal(result.stdout.includes('fake-pinecone-9999'), false);
	});

	it('conflicting sources are reported by key name and source label', () => {
		const h = fresh({ editors: ['claude', 'cursor'] });
		fs.writeFileSync(h.paths.claudeEnv, FAKE_ENV_FILE.replace('fake-pinecone-0001', 'fake-pinecone-9999'));
		const result = execute(h);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.includes('MCP keys with different values in the old install (the first source was used): pinecone-api-key (claude-registration; also claude-env)\n'));
		assert.equal(secretsText(h).split('\n')[0], 'pinecone-api-key: fake-pinecone-0001');
		const json = execute(h, ['--json']);
		assert.deepEqual(JSON.parse(json.stdout).secrets.conflicts, [{ key: 'pinecone-api-key', used: 'secrets-file', others: ['claude-env'] }]);
	});

	it('the .env of the folder named by mcp-server-path in the secrets file is a source too, after the other sources', () => {
		const h = fresh();
		const folder = path.join(h.root, 'custom-mcp');
		fs.mkdirSync(folder);
		fs.writeFileSync(path.join(folder, '.env'), 'PINECONE_API_KEY=fake-pinecone-9999\n');
		fs.writeFileSync(h.paths.secrets, `mcp-server-path: ${folder}\n`, { mode: 0o600 });
		const result = execute(h, [], {}, { holders: ['custom-mcp/.env'] });
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.includes('MCP keys with different values in the old install (the first source was used): pinecone-api-key (claude-registration; also mcp-server-path-env)\n'));
		assert.equal(secretsText(h), `mcp-server-path: ${folder}\npinecone-api-key: fake-pinecone-0001\nopenai-api-key: fake-openai-0001\npinecone-index-name: make-app-contexts\n`);
	});

	it('contexts: newer wins, identical once, org reviews skipped and reported, symlink skipped, existing target kept', () => {
		const h = fresh({ editors: ['claude', 'cursor'] });
		fs.mkdirSync(h.paths.newContexts, { recursive: true });
		fs.writeFileSync(path.join(h.paths.newContexts, 'gamma-v1.md'), 'Existing gamma of the plugin.\n');
		const result = execute(h);
		assert.equal(result.status, 0, result.stderr);
		const lines = nonEmptyLines(result.stdout);
		assert.deepEqual(lines.slice(2, 7), [
			CONTEXTS_LINE(6, 4),
			ORG_NOTE,
			DUPLICATE_NOTE,
			'  kept gamma-v1.md (the target already has a different file)',
			SYMLINK_NOTE,
		]);
		assert.deepEqual(relativeFiles(h.paths.newContexts), CONTEXT_FILES);
		assert.equal(fs.readFileSync(path.join(h.paths.newContexts, 'beta-v1.md'), 'utf8'), 'Beta context written by Cursor, later.\n');
		assert.equal(fs.readFileSync(path.join(h.paths.newContexts, 'gamma-v1.md'), 'utf8'), 'Existing gamma of the plugin.\n');
		assert.equal(fs.readFileSync(path.join(h.paths.newContexts, 'gamma-v1', 'reviews', 'gamma-review.md'), 'utf8'), 'Gamma review.\n');
		assert.equal(fs.existsSync(path.join(h.paths.newContexts, 'orgapp-v2')), false);
		assert.equal(fs.existsSync(path.join(h.paths.newContexts, 'alpha-v1', 'reviews', 'link.md')), false);
		assert.equal(fs.readFileSync(path.join(h.paths.newContexts, 'orgapp-v2.md'), 'utf8'), 'Org app context.\n');
		const json = JSON.parse(execute(h, ['--json']).stdout);
		assert.equal(json.contexts.copied, 0);
		assert.equal(json.contexts.alreadyPresent, 6);
		assert.deepEqual(json.contexts.keptExisting, ['gamma-v1.md']);
		assert.deepEqual(json.contexts.duplicates, [{ rel: 'beta-v1.md', used: 'cursor' }]);
		assert.deepEqual(json.contexts.orgSkipped, ['orgapp-v2/']);
		assert.deepEqual(json.contexts.symlinks, ['alpha-v1/reviews/link.md']);
	});

	it('a read-only ~/.make-custom-app gives exit 4 and leaves no partial file', { skip: IS_ROOT_USER && 'root ignores file modes' }, () => {
		const locked = fresh();
		const dir = path.join(locked.home, '.make-custom-app');
		fs.mkdirSync(dir, { mode: 0o700 });
		fs.chmodSync(dir, 0o500);
		let result;
		try {
			result = execute(locked);
			assert.deepEqual(fs.readdirSync(dir), []);
		} finally {
			fs.chmodSync(dir, 0o700);
		}
		assert.equal(result.status, 4);
		assert.ok(result.stdout.startsWith(`Plugin ${ID}: installed, version 3.0.0\n`));
		assert.ok(result.stdout.includes(`MCP keys: not copied completely (EACCES on ${path.join(dir, 'cleanup.lock')})`));
		assert.ok(result.stdout.endsWith(`${RETRY_LINE}\n`));
		assert.equal(fs.existsSync(locked.paths.secrets), false);

		const contexts = fresh();
		const target = contexts.paths.newContexts;
		fs.mkdirSync(target, { recursive: true, mode: 0o700 });
		fs.chmodSync(target, 0o500);
		try {
			const again = execute(contexts);
			assert.equal(again.status, 4);
			assert.ok(again.stdout.includes(`${CONTEXTS_LINE(0, 10)}\n`));
			for (const rel of CONTEXT_FILES) assert.ok(again.stdout.includes(`  failed ${rel} (EACCES)\n`), rel);
			assert.ok(again.stdout.endsWith(`${RETRY_LINE}\n`));
			assert.deepEqual(fs.readdirSync(target), []);
			assert.deepEqual(fs.readdirSync(path.join(contexts.home, '.make-custom-app')), ['contexts']);
		} finally {
			fs.chmodSync(target, 0o700);
		}
		assert.equal(secretsText(contexts).startsWith('pinecone-api-key: fake-pinecone-0001\n'), true);
		const retry = execute(contexts);
		assert.equal(retry.status, 0, retry.stdout);
		assert.deepEqual(relativeFiles(target), CONTEXT_FILES);
	});

	it('a held lock (a live pid in ~/.make-custom-app/cleanup.lock): exit 4, the lock line, nothing copied; a stale lock is replaced; a fresh empty lock file is not taken, and neither is a takeover file left behind (exit 4, the exact lock line without a pid, with the delete hint); the lock is released when a later step throws', () => {
		const held = fresh();
		const text = JSON.stringify({ pid: process.pid, at: Date.now() });
		writeLock(held, text);
		const first = execute(held);
		assert.equal(first.status, 4);
		assert.equal(first.stderr, '');
		assert.equal(first.stdout, linesOf(`Plugin ${ID}: installed, version 3.0.0`, lockLine(process.pid), NOTHING_DELETED, NEXT_RESTART_CLAUDE));
		assert.equal(fs.existsSync(held.paths.secrets), false);
		assert.equal(fs.existsSync(held.paths.newContexts), false);
		assert.equal(fs.readFileSync(lockFile(held), 'utf8'), text);
		const json = JSON.parse(execute(held, ['--json']).stdout);
		assert.deepEqual(json.lock, { held: true, pid: process.pid });
		assert.equal(json.ok, false);
		assert.equal(json.exitCode, 4);

		const stale = fresh();
		writeLock(stale, JSON.stringify({ pid: deadPid(), at: Date.now() }));
		const second = execute(stale);
		assert.equal(second.status, 0, second.stdout);
		assert.equal(fs.existsSync(lockFile(stale)), false);
		assert.equal(fs.existsSync(`${lockFile(stale)}.takeover`), false);
		assert.deepEqual(relativeFiles(stale.paths.newContexts), CONTEXT_FILES);

		const old = fresh();
		writeLock(old, JSON.stringify({ pid: process.pid, at: Date.now() - 11 * 60000 }));
		assert.equal(execute(old).status, 0);
		assert.equal(fs.existsSync(lockFile(old)), false);

		const empty = fresh({ plugin: 'usable' });
		writeLock(empty, '');
		const third = execute(empty);
		assert.equal(third.status, 4);
		assert.equal(third.stdout, linesOf(`Plugin ${ID}: already installed, version 3.0.0`, lockLine(null), NOTHING_DELETED, NEXT_HANDOFF));
		assert.equal(fs.readFileSync(lockFile(empty), 'utf8'), '');
		assert.equal(fs.existsSync(empty.paths.secrets), false);

		const takeover = fresh({ plugin: 'usable' });
		const staleText = JSON.stringify({ pid: deadPid(), at: Date.now() });
		writeLock(takeover, staleText);
		fs.writeFileSync(`${lockFile(takeover)}.takeover`, staleText, { mode: 0o600 });
		const fourth = execute(takeover);
		assert.equal(fourth.status, 4);
		assert.equal(fourth.stdout, linesOf(`Plugin ${ID}: already installed, version 3.0.0`, lockLine(null), NOTHING_DELETED, NEXT_HANDOFF));
		assert.equal(fs.readFileSync(lockFile(takeover), 'utf8'), staleText);
		assert.equal(fs.readFileSync(`${lockFile(takeover)}.takeover`, 'utf8'), staleText);
		assert.equal(fs.existsSync(takeover.paths.secrets), false);

		const preload = path.join(TEST_ROOT, 'break-secrets-rename.js');
		fs.writeFileSync(
			preload,
			[
				"const fs = require('fs');",
				'const real = fs.renameSync;',
				'fs.renameSync = function (from, to) {',
				"\tif (String(to).endsWith('.make-custom-app-skill-secrets')) throw new Error('boom with fake-openai-0001');",
				'\treturn real.apply(this, arguments);',
				'};',
				'',
			].join('\n'),
		);
		const throws = fresh();
		const fifth = execute(throws, [], { NODE_OPTIONS: `--require ${BLOCK_NETWORK} --require ${preload}` });
		assert.equal(fifth.status, 1);
		assert.equal(fifth.stdout, '');
		assert.equal(fifth.stderr, 'migrate-to-plugin: unexpected error: an unexpected error occurred\n');
		assert.equal(fs.existsSync(lockFile(throws)), false);
		assert.equal(fs.existsSync(throws.paths.secrets), false);
		assert.deepEqual(fs.readdirSync(throws.home).filter((name) => name.includes('tmp')), []);
	});

	it('the summary and the --json report hold no value and no sources or updates object (the fake tokens are grepped in both)', () => {
		const make = () =>
			fresh({
				editors: ['claude', 'cursor'],
				secrets: 'pinecone-api-key: fake-pinecone-9999\n',
			});
		const reference = (h) => {
			const claudeJson = readJson(h.paths.claudeJson);
			claudeJson.mcpServers['make-custom-app'].env.OPENAI_API_KEY = '${env:OPENAI_API_KEY}';
			fs.writeFileSync(h.paths.claudeJson, `${JSON.stringify(claudeJson, null, 2)}\n`);
			for (const env of [h.paths.claudeEnv, h.paths.cursorEnv]) fs.writeFileSync(env, FAKE_ENV_FILE.replace('fake-openai-0001', '${env:OPENAI_API_KEY}'));
			const cursorJson = readJson(h.paths.cursorMcp);
			cursorJson.mcpServers['make-app-context'].env.OPENAI_API_KEY = '${env:OPENAI_API_KEY}';
			fs.writeFileSync(h.paths.cursorMcp, `${JSON.stringify(cursorJson, null, 2)}\n`);
		};
		const text = make();
		reference(text);
		const printed = execute(text);
		assert.equal(printed.status, 0, printed.stderr);
		const json = make();
		reference(json);
		const printedJson = execute(json, ['--json']);
		assert.equal(printedJson.status, 0, printedJson.stderr);
		const report = JSON.parse(printedJson.stdout);
		assert.deepEqual(Object.keys(report.secrets).sort(), ['conflicts', 'copied', 'error', 'keptExisting', 'skipped']);
		assert.deepEqual(report.secrets.copied, ['pinecone-index-name']);
		assert.deepEqual(report.secrets.keptExisting, ['pinecone-api-key']);
		assert.deepEqual(report.secrets.skipped, [{ key: 'openai-api-key', reason: 'reference' }]);
		assert.deepEqual(report.secrets.conflicts, [{ key: 'pinecone-api-key', used: 'secrets-file', others: ['claude-registration', 'claude-env', 'cursor-registration:make-app-context', 'cursor-env'] }]);
		const keys = [];
		const walk = (value) => {
			if (Array.isArray(value)) value.forEach(walk);
			else if (value !== null && typeof value === 'object') {
				for (const [key, inner] of Object.entries(value)) {
					keys.push(key);
					walk(inner);
				}
			}
		};
		walk(report);
		for (const banned of ['sources', 'updates', 'values']) assert.equal(keys.includes(banned), false, banned);
		for (const output of [printed.stdout, printedJson.stdout]) {
			for (const token of FAKE_TOKENS) assert.equal(output.includes(token), false, token);
			assert.doesNotMatch(output, /\$\{env:/);
		}
	});

	it('a non-atomic writer rewriting ~/.claude.json every 2 ms does not crash the run, and the writer\'s last write stands', async () => {
		const { spawn } = require('child_process');
		const h = fresh();
		const base = fs.readFileSync(h.paths.claudeJson, 'utf8');
		const stop = path.join(h.root, 'stop-writer');
		const finalText = JSON.stringify({ ...JSON.parse(base), numStartups: 99999 }, null, 2);
		const writer = [
			"const fs = require('fs');",
			'const [file, stop, base, finalText] = process.argv.slice(1);',
			'let n = 0;',
			'const timer = setInterval(() => {',
			'\tif (fs.existsSync(stop)) {',
			'\t\tclearInterval(timer);',
			'\t\tfs.writeFileSync(file, finalText);',
			'\t\tprocess.exit(0);',
			'\t}',
			'\tfs.writeFileSync(file, JSON.stringify({ ...JSON.parse(base), numStartups: ++n }, null, 2));',
			"\tif (n === 5) process.stdout.write('ready\\n');",
			'}, 2);',
		].join('\n');
		const child = spawn(process.execPath, ['-e', writer, h.paths.claudeJson, stop, base, finalText], { stdio: ['ignore', 'pipe', 'inherit'] });
		const exited = once(child, 'exit');
		let result;
		try {
			await once(child.stdout, 'data');
			result = execute(h, [], {}, { skipRels: ['.claude.json'] });
		} finally {
			fs.writeFileSync(stop, '');
			const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
			await exited;
			clearTimeout(killer);
		}
		assert.ok([0, 4].includes(result.status), `exit ${result.status}`);
		assert.equal(result.stderr, '');
		assert.doesNotMatch(result.stdout, /unexpected error/);
		if (result.status === 4) assert.ok(result.stdout.includes('is not valid JSON'));
		assert.equal(secretsText(h).startsWith('pinecone-api-key: fake-pinecone-0001\n'), true);
		assert.equal(fs.readFileSync(h.paths.claudeJson, 'utf8'), finalText);
	});

	it('--dry-run: nothing changes, not even the throttle file, and no add or install call; with a usable plugin no lock, secrets file, contexts folder, or throttle file is written and no claude call is made', () => {
		const dryRun = (h, overrides = {}) => {
			const throttle = seedThrottle(h);
			const throttleBefore = fs.readFileSync(throttle, 'utf8');
			const homeBefore = snapshotPaths(h.home, ['']);
			const tmpBefore = snapshotPaths(h.paths.tmp, ['']);
			const result = execute(h, ['--dry-run'], overrides);
			assert.deepEqual(snapshotPaths(h.home, ['']), homeBefore, 'the home changed');
			assert.deepEqual(snapshotPaths(h.paths.tmp, ['']), tmpBefore, 'the temp folder changed');
			assert.equal(fs.readFileSync(throttle, 'utf8'), throttleBefore);
			assert.equal(result.stderr, '');
			return result;
		};
		const wouldCopy = 'Dry run: would copy MCP keys and app contexts; nothing else would change.';

		const absent = fresh();
		const first = dryRun(absent);
		assert.equal(first.status, 0);
		assert.equal(first.stdout, linesOf(`Dry run: would add the marketplace ${MARKETPLACE_URL}`, `Dry run: would install ${ID}`, wouldCopy));
		assert.deepEqual(callsOf(absent), [COMMANDS.version, COMMANDS.list]);

		const added = fresh();
		const second = dryRun(added, { FAKE_CLAUDE_MODE: 'already-added' });
		assert.equal(second.status, 0);
		assert.equal(second.stdout, linesOf(`Dry run: the marketplace make-custom-app is present (${MARKETPLACE_URL})`, `Dry run: would install ${ID}`, wouldCopy));
		assert.deepEqual(callsOf(added), [COMMANDS.version, COMMANDS.list]);

		for (const plugin of ['usable', 'disabled']) {
			const installed = fresh({ plugin });
			const third = dryRun(installed, { CLAUDE_BIN: path.join(installed.root, 'nowhere', 'claude') });
			assert.equal(third.status, 0, plugin);
			assert.equal(third.stdout, linesOf('Dry run: the plugin is installed (version 3.0.0); nothing would be installed.', wouldCopy), plugin);
			assert.equal(fs.existsSync(installed.log), false);
			assert.equal(fs.existsSync(path.join(installed.home, '.make-custom-app')), false);
			assert.equal(fs.existsSync(installed.paths.secrets), false);
		}

		const jsonRun = fresh();
		const printed = execute(jsonRun, ['--dry-run', '--json']);
		assert.equal(printed.status, 0);
		const report = JSON.parse(printed.stdout);
		assert.equal(report.dryRun, true);
		assert.equal(report.ok, true);
		assert.deepEqual(report.plugin, { action: 'skipped', version: null, problems: [] });
		assert.deepEqual(callsOf(jsonRun), [COMMANDS.version, COMMANDS.list]);
	});

	it('--dry-run with no claude exits 5 and writes nothing', { skip: HOST_HAS_CLAUDE && 'the host has a claude in a usual install folder' }, () => {
		const h = fresh({ withClaude: false });
		const homeBefore = snapshotPaths(h.home, ['']);
		const result = execute(h, ['--dry-run'], { CLAUDE_BIN: undefined });
		assert.equal(result.status, 5);
		assert.equal(result.stdout, '');
		assert.match(result.stderr, /^Claude Code was not found /);
		assert.deepEqual(snapshotPaths(h.home, ['']), homeBefore);
	});

	it('--json prints one object with exactly the schema keys', () => {
		const h = fresh();
		const result = execute(h, ['--json']);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, '');
		assert.ok(result.stdout.endsWith('}\n'));
		const report = JSON.parse(result.stdout);
		assert.deepEqual(Object.keys(report).sort(), ['claude', 'contexts', 'dryRun', 'editor', 'exitCode', 'lock', 'marketplace', 'next', 'ok', 'plugin', 'secrets']);
		assert.deepEqual(Object.keys(report.claude).sort(), ['bin', 'version']);
		assert.deepEqual(Object.keys(report.marketplace).sort(), ['action', 'source']);
		assert.deepEqual(Object.keys(report.plugin).sort(), ['action', 'problems', 'version']);
		assert.deepEqual(Object.keys(report.lock).sort(), ['held', 'pid']);
		assert.deepEqual(Object.keys(report.secrets).sort(), ['conflicts', 'copied', 'error', 'keptExisting', 'skipped']);
		assert.deepEqual(Object.keys(report.contexts).sort(), ['alreadyPresent', 'copied', 'duplicates', 'errors', 'keptExisting', 'orgSkipped', 'symlinks']);
		assert.deepEqual(report, {
			ok: true,
			exitCode: 0,
			editor: 'claude',
			dryRun: false,
			claude: { bin: path.join(h.binDir, 'claude'), version: '2.1.312 (Claude Code)' },
			marketplace: { action: 'added', source: MARKETPLACE_URL },
			plugin: { action: 'installed', version: '3.0.0', problems: [] },
			lock: { held: false, pid: null },
			secrets: { copied: ['pinecone-api-key', 'openai-api-key', 'pinecone-index-name'], keptExisting: [], conflicts: [], skipped: [], error: null },
			contexts: { copied: 7, alreadyPresent: 0, keptExisting: [], orgSkipped: ['orgapp-v2/'], duplicates: [{ rel: 'beta-v1.md', used: 'cursor' }], symlinks: ['alpha-v1/reviews/link.md'], errors: [] },
			next: [NEXT_RESTART_CLAUDE],
		});

		const failed = execute(fresh(), ['--json'], { FAKE_CLAUDE_MODE: 'add-fails' });
		assert.equal(failed.status, 1);
		const failedReport = JSON.parse(failed.stdout);
		assert.deepEqual([failedReport.ok, failedReport.exitCode, failedReport.marketplace.action, failedReport.plugin.action], [false, 1, 'failed', 'skipped']);
		assert.ok(failed.stderr.startsWith('Could not install the plugin: fatal: could not add the marketplace'));
	});

	it('an .env with a BOM and CRLF is read', () => {
		const h = fresh();
		const claudeJson = readJson(h.paths.claudeJson);
		delete claudeJson.mcpServers['make-custom-app'];
		fs.writeFileSync(h.paths.claudeJson, `${JSON.stringify(claudeJson, null, 2)}\n`);
		fs.writeFileSync(h.paths.claudeEnv, `\uFEFF${FAKE_ENV_FILE.replace(/\n/g, '\r\n')}`);
		const result = execute(h);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(secretsText(h), 'pinecone-api-key: fake-pinecone-0001\nopenai-api-key: fake-openai-0001\npinecone-index-name: make-app-contexts\n');
		assert.equal(secretsText(h).includes('\r'), false);
	});

	it('the Cursor install runs the same script: the Cursor Next line and the same copies', () => {
		const h = fresh({ editors: ['cursor'] });
		const result = execute(h, [], {}, { editor: 'cursor' });
		assert.equal(result.status, 0, result.stderr);
		const lines = nonEmptyLines(result.stdout);
		assert.equal(lines[lines.length - 1], NEXT_RESTART_CURSOR);
		assert.equal(JSON.parse(execute(h, ['--json'], {}, { editor: 'cursor' }).stdout).editor, 'cursor');
		assert.deepEqual(relativeFiles(h.paths.newContexts), CONTEXT_FILES);
	});

	it('usage errors exit 2 with the usage line and write nothing', () => {
		const h = fresh();
		const homeBefore = snapshotPaths(h.home, ['']);
		const usage = 'Usage: node migrate-to-plugin.js [--dry-run] [--json] [--timeout <seconds>] [--skip-version]';
		const unknown = execute(h, ['--nope']);
		assert.equal(unknown.status, 2);
		assert.equal(unknown.stdout, '');
		assert.equal(unknown.stderr, linesOf('Unknown option: --nope', usage));
		const timeout = execute(h, ['--timeout', '4']);
		assert.equal(timeout.status, 2);
		assert.equal(timeout.stderr, linesOf('--timeout needs a whole number of seconds from 5 to 600', usage));
		assert.deepEqual(snapshotPaths(h.home, ['']), homeBefore);
		assert.equal(fs.existsSync(h.log), false);
	});

	it('FAKE_CLAUDE_USER_FILE=rewrite: a ~/.claude.json that Claude Code rewrote still gives the keys, and the one backup copy is the only extra file that holds a fake token', () => {
		const h = fresh();
		const seeded = readJson(h.paths.claudeJson);
		const result = execute(h, [], { FAKE_CLAUDE_USER_FILE: 'rewrite' }, { skipRels: ['.claude.json'], allowBackup: true });
		assert.equal(result.status, 0, result.stderr);
		const rewritten = readJson(h.paths.claudeJson);
		for (const key of Object.keys(seeded)) assert.deepEqual(rewritten[key], seeded[key], key);
		assert.equal(Object.hasOwn(rewritten, 'machineID'), true);
		const backups = fs.readdirSync(path.join(h.home, '.claude', 'backups'));
		assert.equal(backups.length, 1);
		assert.ok(Object.hasOwn(tokenFiles(h.root), `home/.claude/backups/${backups[0]}`));
		assert.equal(secretsText(h), 'pinecone-api-key: fake-pinecone-0001\nopenai-api-key: fake-openai-0001\npinecone-index-name: make-app-contexts\n');
	});

	it('nothing is deleted: the snapshot is equal before and after every case except the files the case writes on purpose', () => {
		const h = fresh({ editors: ['claude', 'cursor'], secrets: 'make-api-key: fake-make-token-0001\n' });
		const before = snapshotPaths(h.home, ['']);
		assert.equal(execute(h).status, 0);
		assert.equal(execute(h).status, 0);
		const after = new Map(snapshotPaths(h.home, ['']).map((entry) => [entry.rel, entry]));
		const owner = (rel) => (rel.startsWith('.claude/') ? rel.split('/').slice(0, 2).join('/') : rel.split('/')[0]);
		for (const entry of before) {
			const kept = after.get(entry.rel);
			assert.ok(kept, `${entry.rel} was deleted`);
			assert.deepEqual([kept.type, kept.linkTarget], [entry.type, entry.linkTarget], entry.rel);
			if (entry.type === 'file' && entry.rel !== '.make-custom-app-skill-secrets') {
				assert.equal(kept.sha256, entry.sha256, entry.rel);
				assert.equal(kept.mode, entry.mode, entry.rel);
				assert.equal(kept.mtimeMs, entry.mtimeMs, entry.rel);
			}
		}
		const known = new Set(before.map((entry) => entry.rel));
		const written = new Set([...after.keys()].filter((rel) => !known.has(rel)).map(owner));
		assert.deepEqual([...written].sort(), ['.claude/fake-marketplaces.json', '.claude/plugins', '.claude/settings.json', '.make-custom-app']);
		assert.equal(secretsText(h).startsWith('make-api-key: fake-make-token-0001\n'), true);
	});

	it('no case calls uninstall, marketplace remove, disable, enable, or mcp', () => {
		const modes = ['normal', 'already-added', 'add-fails', 'install-fails', 'install-no-record', 'wrong-version', 'disabled', 'object-entry', 'not-claude'];
		const seen = new Set();
		for (const mode of modes) {
			const h = fresh();
			execute(h, [], { FAKE_CLAUDE_MODE: mode });
			for (const argv of callsOf(h)) seen.add(argv.join(' '));
		}
		const usable = fresh({ plugin: 'usable' });
		execute(usable, ['--dry-run']);
		assert.deepEqual([...seen].sort(), [COMMANDS.version, COMMANDS.list, COMMANDS.add, COMMANDS.install].map((argv) => argv.join(' ')).sort());
		const source = fs.readFileSync(path.join(SKILL_SOURCE, 'scripts', SCRIPT_NAME), 'utf8');
		const code = source
			.split('\n')
			.filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
			.join('\n');
		for (const word of ["'uninstall'", "'disable'", "'enable'", "'remove'", "'mcp'", 'marketplace remove', '.claude.json', 'mcp.json', 'settings.json', 'CLAUDE.md']) {
			assert.equal(code.includes(word), false, `the script mentions ${word}`);
		}
	});
});

describe('migrate-to-plugin.js main, in this process', POSIX_ONLY, () => {
	const loadMain = () => require('../../migrate-to-plugin').main;
	const secretsPath = (h) => h.paths.secrets;
	const callsOf = (h) => readLog(h.log).map((entry) => entry.argv);
	const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

	function fresh(options = {}) {
		const root = makeRoot();
		const h = buildOldHome({ root, ...options });
		writeFakeClaude({ binDir: h.binDir, root });
		return { root, ...h };
	}

	const executableIn = (root) => (file) => {
		try {
			const stat = fs.statSync(file);
			return isInsidePath(file, root) && stat.isFile() && (stat.mode & 0o111) !== 0;
		} catch {
			return false;
		}
	};

	function runMain(h, args = [], overrides = {}, deps = {}) {
		const out = [];
		const err = [];
		const status = loadMain()({
			argv: ['--skip-version', ...args],
			env: withEnv(h.env, overrides),
			home: h.home,
			tmpdir: h.paths.tmp,
			platform: process.platform,
			editorDir: '.claude',
			nodeVersion: '24.0.0',
			isExecutable: executableIn(h.root),
			stdout: (text) => out.push(text),
			stderr: (text) => err.push(text),
			...deps,
		});
		return { status, stdout: out.join(''), stderr: err.join('') };
	}

	const ok = (stdout = '') => ({ status: 0, signal: null, stdout, stderr: '' });
	const failed = (stderr, status = 1) => ({ status, signal: null, stdout: '', stderr });
	const timedOut = () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
	const CLAUDE_VERSION_LINE = '2.1.312 (Claude Code)\n';

	function stubSpawn(steps, record = []) {
		const queue = [...steps];
		const spawn = (command, args, options) => {
			record.push({ command, args, options });
			assert.ok(queue.length > 0, `unexpected claude call: ${args.join(' ')}`);
			const next = queue.shift();
			return typeof next === 'function' ? next() : next;
		};
		spawn.record = record;
		return spawn;
	}

	function installLikeClaude(h) {
		return () => {
			writePluginFiles(makeIo({ guard: (file) => file, dry: false }), { config: path.join(h.home, '.claude'), version: FAKE_PLUGIN_VERSION, record: true, disabled: false, objectEntry: false });
			return ok(`Installed ${ID} (scope: user)\n`);
		};
	}

	const failureOf = (reason) => `Could not install the plugin: ${reason}\nclaude --version reported: 2.1.312 (Claude Code)\n${MANUAL_STEPS.join('\n')}\n`;

	it('requires argv, env, home, tmpdir, platform, and editorDir', () => {
		const main = loadMain();
		assert.throws(() => main(), { name: 'TypeError', message: 'main needs argv, env, home, tmpdir, platform, and editorDir' });
		const valid = { argv: [], env: {}, home: '/home', tmpdir: '/tmp', platform: 'linux', editorDir: '.claude' };
		for (const [name, value] of [['home', ''], ['tmpdir', ''], ['env', []], ['env', null], ['argv', undefined], ['platform', undefined], ['editorDir', undefined]]) {
			assert.throws(() => main({ ...valid, [name]: value }), { name: 'TypeError' }, name);
		}
	});

	it('usage errors exit 2 and run no guard, no claude, and no write', () => {
		const h = fresh();
		let guards = 0;
		const record = [];
		const homeBefore = snapshotPaths(h.home, ['']);
		const usage = 'Usage: node migrate-to-plugin.js [--dry-run] [--json] [--timeout <seconds>] [--skip-version]';
		for (const [args, message] of [
			[['--nope'], 'Unknown option: --nope'],
			[['--timeout'], '--timeout needs a whole number of seconds from 5 to 600'],
			[['--timeout=601'], '--timeout needs a whole number of seconds from 5 to 600'],
		]) {
			const result = runMain(h, [], {}, { argv: args, versionGuard: () => guards++, spawn: stubSpawn([], record) });
			assert.equal(result.status, 2);
			assert.equal(result.stdout, '');
			assert.equal(result.stderr, linesOf(message, usage));
		}
		assert.equal(guards, 0);
		assert.equal(record.length, 0);
		assert.deepEqual(snapshotPaths(h.home, ['']), homeBefore);
	});

	it('runs the version guard first and only when neither --skip-version nor --dry-run is given', () => {
		const h = fresh({ plugin: 'usable' });
		const events = [];
		const guard = () => events.push('guard');
		const spawn = stubSpawn([]);
		const stdout = () => events.push('output');
		const first = runMain(h, [], {}, { argv: [], versionGuard: guard, stdout, spawn });
		assert.equal(first.status, 0);
		assert.equal(events[0], 'guard');
		assert.equal(events.filter((event) => event === 'guard').length, 1);
		for (const argv of [['--skip-version'], ['--dry-run'], ['--dry-run', '--json']]) {
			const before = events.length;
			runMain(h, [], {}, { argv, versionGuard: guard, spawn });
			assert.equal(events.slice(before).includes('guard'), false, argv.join(' '));
		}
		assert.equal(spawn.record.length, 0);
	});

	it('warns on stderr when Node is older than 20, and goes on', () => {
		const h = fresh({ plugin: 'usable' });
		const old = runMain(h, [], {}, { nodeVersion: '18.15.0' });
		assert.equal(old.status, 0);
		assert.equal(old.stderr, "Warning: Node 18.15.0 is older than 20; the plugin's MCP server is built for Node 20 or newer.\n");
		for (const nodeVersion of ['20.0.0', '22.22.0', '24.22.1']) assert.equal(runMain(h, [], {}, { nodeVersion }).stderr, '', nodeVersion);
	});

	it('maps the editor folder .claude to claude and anything else to cursor', () => {
		const h = fresh({ plugin: 'usable' });
		for (const [editorDir, editor, next] of [['.claude', 'claude', NEXT_HANDOFF], ['.cursor', 'cursor', NEXT_HANDOFF], ['.other', 'cursor', NEXT_HANDOFF]]) {
			const result = runMain(h, ['--json'], {}, { editorDir });
			const report = JSON.parse(result.stdout);
			assert.equal(report.editor, editor, editorDir);
			assert.deepEqual(report.next, [next]);
		}
		const cursor = fresh({ editors: ['cursor'] });
		const installed = runMain(cursor, [], {}, { editorDir: '.cursor' });
		assert.equal(installed.status, 0, installed.stderr);
		assert.ok(installed.stdout.endsWith(`${NEXT_RESTART_CURSOR}\n`));
	});

	it('installs from the fake claude, copies, removes the throttle file, and prints the summary', () => {
		const h = fresh();
		const throttle = seedThrottle(h);
		const result = runMain(h);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, '');
		assert.ok(result.stdout.startsWith(`Plugin ${ID}: installed, version 3.0.0\n${KEYS_COPIED}\n`));
		assert.ok(result.stdout.endsWith(`${NOTHING_DELETED}\n${NEXT_RESTART_CLAUDE}\n`));
		assert.equal(fs.existsSync(throttle), false);
		assert.equal(fs.existsSync(path.join(h.home, '.make-custom-app', 'cleanup.lock')), false);
		assert.deepEqual(callsOf(h), [COMMANDS.version, COMMANDS.list, COMMANDS.add, COMMANDS.install]);
		const again = runMain(h);
		assert.equal(again.status, 0);
		assert.ok(again.stdout.startsWith(`Plugin ${ID}: already installed, version 3.0.0\n`));
		assert.equal(callsOf(h).length, 4);
	});

	it('keeps the throttle file after an exit other than 0, and after a dry run', () => {
		const h = fresh();
		const throttle = seedThrottle(h);
		assert.equal(runMain(h, ['--dry-run']).status, 0);
		assert.equal(fs.existsSync(throttle), true);
		assert.equal(runMain(h, [], { FAKE_CLAUDE_MODE: 'add-fails' }).status, 1);
		assert.equal(fs.existsSync(throttle), true);
		assert.equal(runMain(h, [], { CLAUDE_BIN: path.join(h.root, 'nowhere') }).status, 5);
		assert.equal(fs.existsSync(throttle), true);
	});

	it('exit 5 without a binary names the variable, the Cursor limit, or the two slash commands', () => {
		const h = buildOldHome({ root: makeRoot(), editors: ['cursor'] });
		const nothing = { CLAUDE_BIN: undefined };
		const cursor = runMain(h, [], nothing, { editorDir: '.cursor', spawn: stubSpawn([]) });
		assert.equal(cursor.status, 5);
		assert.equal(cursor.stderr.split('\n').length, 4);
		assert.ok(cursor.stderr.includes('Installing the make-custom-app plugin for Cursor alone is not supported yet.'));
		const claude = runMain(h, [], nothing, { spawn: stubSpawn([]) });
		assert.equal(claude.status, 5);
		assert.ok(claude.stderr.includes(`  /plugin install ${ID}\n`));
		const named = runMain(h, [], { CLAUDE_BIN: 'bad\nname' }, { spawn: stubSpawn([]) });
		assert.equal(named.status, 5);
		assert.equal(named.stderr, linesOf('CLAUDE_BIN is set to bad?name, which is not an executable file. Nothing was changed.'));
		const json = JSON.parse(runMain(h, ['--json'], nothing, { spawn: stubSpawn([]) }).stdout);
		assert.deepEqual([json.ok, json.exitCode, json.claude.bin, json.plugin.action], [false, 5, null, 'skipped']);
	});

	it('a first line of claude --version without (Claude Code) exits 5, cut at 80 characters and cleaned', () => {
		const h = fresh();
		const bin = path.join(h.binDir, 'claude');
		const long = 'x'.repeat(100);
		for (const [version, shown] of [
			[{ ...ok('1.0.0 (Other Tool)\nsecond line\n') }, '1.0.0 (Other Tool)'],
			[ok(`${long}\n`), 'x'.repeat(80)],
			[ok('tab\there\u0007\n'), 'tab?here?'],
			[failed('boom'), ''],
			[timedOut(), ''],
		]) {
			const spawn = stubSpawn([version]);
			const result = runMain(h, [], {}, { spawn });
			assert.equal(result.status, 5);
			assert.equal(result.stderr, linesOf(`${bin} is not Claude Code (claude --version printed "${shown}"). Nothing was changed. Set CLAUDE_BIN to the claude binary of Claude Code and run this script again.`));
			assert.equal(spawn.record.length, 1);
		}
	});

	it('gives each claude call its own timeout: 10 s, 30 s, and --timeout seconds, all capped by the 110 s deadline', () => {
		const h = fresh();
		const record = [];
		const spawn = stubSpawn([ok(CLAUDE_VERSION_LINE), ok('[]'), ok(), installLikeClaude(h)], record);
		assert.equal(runMain(h, [], {}, { spawn }).status, 0);
		assert.deepEqual(record.map((call) => call.options.timeout), [10000, 30000, 75000, 75000]);
		assert.deepEqual(record.map((call) => call.args), [COMMANDS.version, COMMANDS.list, COMMANDS.add, COMMANDS.install]);
		for (const call of record) {
			assert.equal(call.command, path.join(h.binDir, 'claude'));
			assert.equal(call.options.killSignal, 'SIGKILL');
		}

		const short = fresh();
		const shortRecord = [];
		runMain(short, ['--timeout', '5'], {}, { spawn: stubSpawn([ok(CLAUDE_VERSION_LINE), ok('[]'), ok(), installLikeClaude(short)], shortRecord) });
		assert.deepEqual(shortRecord.map((call) => call.options.timeout), [5000, 5000, 5000, 5000]);

		const slow = fresh();
		let clock = 1000;
		const slowRecord = [];
		const slowSpawn = stubSpawn(
			[
				() => {
					clock += 100000;
					return ok(CLAUDE_VERSION_LINE);
				},
				() => {
					clock += 15000;
					return ok('[]');
				},
			],
			slowRecord,
		);
		const late = runMain(slow, [], {}, { spawn: slowSpawn, now: () => clock });
		assert.equal(late.status, 1);
		assert.deepEqual(slowRecord.map((call) => call.options.timeout), [10000, 10000]);
		assert.equal(late.stderr, failureOf('claude did not finish within 110 seconds (marketplace add)'));
	});

	it('starts the 110 s clock before the version guard, so the guard is inside the budget', () => {
		const h = fresh();
		let clock = 1000;
		const record = [];
		const spawn = stubSpawn([ok(CLAUDE_VERSION_LINE), ok('[]'), ok(), installLikeClaude(h)], record);
		const result = runMain(h, [], {}, {
			argv: [],
			now: () => clock,
			versionGuard: () => {
				clock += 105000;
			},
			spawn,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(record.map((call) => call.options.timeout), [5000, 5000, 5000, 5000]);
	});

	it('a failed or timed-out call exits 1 with the first stderr line or the timeout text, per step', () => {
		const cases = [
			['list timeout', [timedOut()], 'claude did not finish within 30 seconds (marketplace list)'],
			['add timeout', [ok('[]'), timedOut()], 'claude did not finish within 75 seconds (marketplace add)'],
			['install timeout', [ok('[]'), ok(), timedOut()], 'claude did not finish within 75 seconds (plugin install)'],
			['stderr line', [ok('[]'), ok(), failed('\n  \nfatal: first line\nsecond line\n')], 'fatal: first line'],
			['userinfo and control character', [ok('[]'), failed('fatal: unable to access https://user:secret-pass@example.invalid/x.git\u0007')], 'fatal: unable to access https://example.invalid/x.git?'],
			['long line', [ok('[]'), ok(), failed('y'.repeat(300))], 'y'.repeat(200)],
			['no stderr', [ok('[]'), failed('', 3)], 'claude exited with code 3 (marketplace add)'],
			['signal', [ok('[]'), ok(), { status: null, signal: 'SIGKILL', stdout: '', stderr: '' }], 'claude exited with signal SIGKILL (plugin install)'],
			['spawn error', [{ status: null, signal: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'EACCES' }) }], null],
		];
		for (const [label, steps, reason] of cases) {
			const h = fresh();
			const result = runMain(h, [], {}, { spawn: stubSpawn([ok(CLAUDE_VERSION_LINE), ...steps]) });
			assert.equal(result.status, 1, label);
			assert.equal(result.stdout, '', label);
			assert.equal(result.stderr, failureOf(reason === null ? `EACCES on ${path.join(h.binDir, 'claude')}` : reason), label);
			assert.equal(fs.existsSync(h.paths.secrets), false, label);
		}
	});

	it('a marketplace list that is not JSON still tries the add, and a present marketplace of another kind is kept and reported', () => {
		const h = fresh();
		const spawn = stubSpawn([ok(CLAUDE_VERSION_LINE), ok('not json at all'), ok(), installLikeClaude(h)]);
		const result = runMain(h, ['--json'], {}, { spawn });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout).marketplace, { action: 'added', source: MARKETPLACE_URL });
		assert.deepEqual(spawn.record.map((call) => call.args), [COMMANDS.version, COMMANDS.list, COMMANDS.add, COMMANDS.install]);

		const other = fresh();
		const folder = JSON.stringify([{ name: 'make-custom-app', source: 'directory', path: '/some/folder', installLocation: '/x' }]);
		const kept = runMain(other, [], {}, { spawn: stubSpawn([ok(CLAUDE_VERSION_LINE), ok(folder), installLikeClaude(other)]) });
		assert.equal(kept.status, 0, kept.stderr);
		assert.ok(kept.stdout.includes('Marketplace make-custom-app was already there (/some/folder); it was kept.\n'));

		const bare = fresh();
		const noAddress = runMain(bare, [], {}, { spawn: stubSpawn([ok(CLAUDE_VERSION_LINE), ok(JSON.stringify([{ name: 'make-custom-app' }])), installLikeClaude(bare)]) });
		assert.ok(noAddress.stdout.includes('Marketplace make-custom-app was already there; it was kept.\n'));
	});

	it('a dry run names a present marketplace by its address, and without parentheses when it has none', () => {
		const h = fresh();
		const wouldCopy = 'Dry run: would copy MCP keys and app contexts; nothing else would change.';
		const listed = (entry) => stubSpawn([ok(CLAUDE_VERSION_LINE), ok(JSON.stringify([entry]))]);
		const withPath = runMain(h, ['--dry-run'], {}, { spawn: listed({ name: 'make-custom-app', source: 'directory', path: '/some/folder' }) });
		assert.equal(withPath.status, 0);
		assert.equal(withPath.stdout, linesOf('Dry run: the marketplace make-custom-app is present (/some/folder)', `Dry run: would install ${ID}`, wouldCopy));
		const bare = runMain(h, ['--dry-run'], {}, { spawn: listed({ name: 'make-custom-app' }) });
		assert.equal(bare.stdout, linesOf('Dry run: the marketplace make-custom-app is present', `Dry run: would install ${ID}`, wouldCopy));
		const json = JSON.parse(runMain(h, ['--dry-run', '--json'], {}, { spawn: listed({ name: 'make-custom-app', url: 'https://user:pass@example.invalid/x.git' }) }).stdout);
		assert.deepEqual(json.marketplace, { action: 'present', source: 'https://example.invalid/x.git' });
	});

	it('a dry run that cannot list the marketplaces exits 1 and writes nothing', () => {
		const h = fresh();
		const homeBefore = snapshotPaths(h.home, ['']);
		const result = runMain(h, ['--dry-run'], {}, { spawn: stubSpawn([ok(CLAUDE_VERSION_LINE), failed('Error: list failed')]) });
		assert.equal(result.status, 1);
		assert.equal(result.stdout, '');
		assert.equal(result.stderr, failureOf('Error: list failed'));
		assert.deepEqual(snapshotPaths(h.home, ['']), homeBefore);
	});

	it('on Windows with a claude.cmd the call is the documented cmd.exe string', () => {
		const h = fresh();
		const bin = 'C:\\Program Files\\Claude\\claude.cmd';
		const record = [];
		const result = runMain(h, [], { CLAUDE_BIN: bin }, { platform: 'win32', isExecutable: () => true, spawn: stubSpawn([ok(CLAUDE_VERSION_LINE), ok('[]'), ok(), failed('boom')], record) });
		assert.equal(result.status, 1);
		assert.deepEqual(
			record.map((call) => [call.command, call.args]),
			[
				['cmd.exe', ['/d', '/s', '/c', `""${bin}" --version"`]],
				['cmd.exe', ['/d', '/s', '/c', `""${bin}" plugin marketplace list --json"`]],
				['cmd.exe', ['/d', '/s', '/c', `""${bin}" plugin marketplace add ${MARKETPLACE_URL}"`]],
				['cmd.exe', ['/d', '/s', '/c', `""${bin}" plugin install ${ID}"`]],
			],
		);
		for (const call of record) {
			assert.equal(call.options.killSignal, 'SIGKILL');
			assert.equal(call.options.windowsVerbatimArguments, true);
			assert.equal(call.options.cwd, h.home);
			assert.equal(call.options.env.HOME, h.home);
			assert.equal(call.options.env.USERPROFILE, h.home);
		}
		assert.equal(result.stderr.split('\n')[0], 'Could not install the plugin: boom');
	});

	it('a failing step, whatever it is, prints "unexpected error" with the formatter and exits 1', () => {
		const h = fresh();
		const plain = runMain(h, [], {}, { spawn: () => { throw new Error('contains fake-pinecone-0001'); } });
		assert.equal(plain.status, 1);
		assert.equal(plain.stdout, '');
		assert.equal(plain.stderr, 'migrate-to-plugin: unexpected error: an unexpected error occurred\n');
		const coded = runMain(h, [], {}, { spawn: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); } });
		assert.equal(coded.stderr, 'migrate-to-plugin: unexpected error: EPERM on the migration\n');
		const syntax = runMain(h, [], {}, { spawn: () => { throw new SyntaxError('Unexpected token f in JSON at position 0: fake-pinecone-0001'); } });
		assert.equal(syntax.stderr, 'migrate-to-plugin: unexpected error: the migration is not valid JSON\n');
	});

	it('the lock is released when a later step throws, and nothing after the throw runs', () => {
		const h = fresh();
		const lock = path.join(h.home, '.make-custom-app', 'cleanup.lock');
		let seen = null;
		const result = runMain(h, [], {}, {
			upsertSecrets: () => {
				seen = fs.existsSync(lock);
				throw new Error('boom with fake-openai-0001');
			},
		});
		assert.equal(seen, true);
		assert.equal(result.status, 1);
		assert.equal(result.stderr, 'migrate-to-plugin: unexpected error: an unexpected error occurred\n');
		assert.equal(fs.existsSync(lock), false);
		assert.equal(fs.existsSync(h.paths.secrets), false);
		assert.equal(fs.existsSync(h.paths.newContexts), false);
	});

	it('a read-back that differs from the planned value sets secrets.error, drops the key from copied, and exits 4', () => {
		const h = fresh();
		const result = runMain(h, ['--json'], {}, {
			upsertSecrets: (file) => fs.writeFileSync(file, 'pinecone-api-key: fake-pinecone-9999\nopenai-api-key: fake-openai-0001\npinecone-index-name: make-app-contexts\n', { mode: 0o600 }),
		});
		assert.equal(result.status, 4);
		const report = JSON.parse(result.stdout);
		assert.equal(report.secrets.error, 'read-back mismatch: pinecone-api-key');
		assert.deepEqual(report.secrets.copied, ['openai-api-key', 'pinecone-index-name']);
		assert.equal(report.contexts.copied, 7);
		assert.equal(report.ok, false);
		assert.equal(result.stdout.includes('fake-pinecone-9999'), false);
		const text = runMain(fresh(), [], {}, { upsertSecrets: () => {} });
		assert.equal(text.status, 4);
		assert.ok(text.stdout.includes('MCP keys: not copied completely (read-back mismatch: pinecone-api-key, openai-api-key, pinecone-index-name)\n'));
		assert.ok(text.stdout.endsWith(`${RETRY_LINE}\n`));
	});

	it('a secrets file that cannot be read or written exits 4 with the code and the path only', () => {
		const unreadable = fresh();
		fs.mkdirSync(secretsPath(unreadable));
		const first = runMain(unreadable, ['--json']);
		assert.equal(first.status, 4);
		assert.equal(JSON.parse(first.stdout).secrets.error, `EISDIR on ${secretsPath(unreadable)}`);
		assert.equal(JSON.parse(first.stdout).contexts.copied, 7);

		const unwritable = fresh();
		const second = runMain(unwritable, [], {}, {
			upsertSecrets: () => {
				throw Object.assign(new Error('x'), { code: 'EACCES' });
			},
		});
		assert.equal(second.status, 4);
		assert.ok(second.stdout.includes(`MCP keys: not copied completely (EACCES on ${secretsPath(unwritable)})\n`));
		assert.equal(fs.existsSync(path.join(unwritable.home, '.make-custom-app', 'cleanup.lock')), false);
	});

	it('an unreadable contexts folder is reported by code and path on stderr, the other folder is still copied, and the run exits 4', () => {
		const h = fresh();
		const bad = h.paths.claudeContexts;
		const wrapped = {
			...fs,
			readdirSync(dir, ...rest) {
				if (dir === bad) throw Object.assign(new Error('x'), { code: 'EACCES' });
				return fs.readdirSync(dir, ...rest);
			},
		};
		const result = runMain(h, [], {}, { fs: wrapped });
		assert.equal(result.status, 4);
		assert.equal(result.stderr, linesOf(`Could not read the app contexts: EACCES on ${bad}`));
		assert.ok(result.stdout.includes(`${CONTEXTS_LINE(4, 1)}\n  failed ${bad} (EACCES)\n`));
		assert.ok(result.stdout.endsWith(`${RETRY_LINE}\n`));
		assert.deepEqual(relativeFiles(h.paths.newContexts), ['alpha-v1.md', 'beta-v1.md', 'gamma-v1.md', 'gamma-v1/reviews/gamma-review.md']);
		const json = runMain(h, ['--json'], {}, { fs: wrapped });
		assert.equal(json.status, 4);
		assert.deepEqual(JSON.parse(json.stdout).contexts.errors, [{ rel: bad, code: 'EACCES' }]);
	});

	it('a link, a file, or a missing folder in the way of a copy is reported, never followed, and the run exits 4', () => {
		const h = fresh();
		const elsewhere = path.join(h.root, 'elsewhere');
		fs.mkdirSync(elsewhere);
		fs.writeFileSync(path.join(elsewhere, 'beta-target.md'), 'Not a context.\n');
		const target = h.paths.newContexts;
		fs.mkdirSync(target, { recursive: true });
		fs.symlinkSync(elsewhere, path.join(target, 'alpha-v1'));
		fs.writeFileSync(path.join(target, 'gamma-v1'), 'A file where a folder belongs.\n');
		fs.symlinkSync(path.join(elsewhere, 'beta-target.md'), path.join(target, 'beta-v1.md'));
		const result = runMain(h, ['--json']);
		assert.equal(result.status, 4);
		const { contexts } = JSON.parse(result.stdout);
		assert.deepEqual(contexts.errors, [
			{ rel: 'alpha-v1/reviews/nested/review-2.md', code: 'ENOTDIR' },
			{ rel: 'alpha-v1/reviews/review-1.md', code: 'ENOTDIR' },
			{ rel: 'gamma-v1/reviews/gamma-review.md', code: 'ENOTDIR' },
		]);
		assert.deepEqual(contexts.keptExisting, ['beta-v1.md']);
		assert.equal(contexts.copied, 3);
		assert.deepEqual(fs.readdirSync(elsewhere), ['beta-target.md']);
		assert.equal(fs.readFileSync(path.join(elsewhere, 'beta-target.md'), 'utf8'), 'Not a context.\n');
		assert.equal(fs.readFileSync(path.join(target, 'gamma-v1'), 'utf8'), 'A file where a folder belongs.\n');
		assert.ok(fs.lstatSync(path.join(target, 'beta-v1.md')).isSymbolicLink());
		const text = runMain(h);
		assert.ok(text.stdout.includes('  failed alpha-v1/reviews/review-1.md (ENOTDIR)\n'));
		assert.ok(text.stdout.endsWith(`${RETRY_LINE}\n`));

		const file = fresh();
		fs.mkdirSync(path.join(file.home, '.make-custom-app'));
		fs.writeFileSync(file.paths.newContexts, 'a file where the contexts folder belongs\n');
		const blocked = JSON.parse(runMain(file, ['--json']).stdout).contexts;
		assert.equal(blocked.errors.length, 7);
		assert.equal(blocked.copied, 0);
		assert.equal(fs.readFileSync(file.paths.newContexts, 'utf8'), 'a file where the contexts folder belongs\n');
	});

	it('a contexts folder that is a link to a folder is followed, and a target that cannot be inspected exits 4', () => {
		const h = fresh();
		const real = path.join(h.root, 'real-contexts');
		fs.mkdirSync(real);
		fs.mkdirSync(path.join(h.home, '.make-custom-app'));
		fs.symlinkSync(real, h.paths.newContexts);
		const result = runMain(h, ['--json']);
		assert.equal(result.status, 0, result.stdout);
		assert.deepEqual(relativeFiles(real), CONTEXT_FILES);

		const broken = fresh();
		fs.mkdirSync(broken.paths.newContexts, { recursive: true });
		const wrapped = {
			...fs,
			lstatSync(file, ...rest) {
				if (file === path.join(broken.paths.newContexts, 'alpha-v1.md')) throw Object.assign(new Error('x'), { code: 'EACCES' });
				return fs.lstatSync(file, ...rest);
			},
		};
		const second = runMain(broken, [], {}, { fs: wrapped });
		assert.equal(second.status, 4);
		assert.equal(second.stderr, linesOf(`Could not check the app contexts: EACCES on ${broken.paths.newContexts}`));
		assert.ok(second.stdout.endsWith(`${RETRY_LINE}\n`));
		const json = runMain(broken, ['--json'], {}, { fs: wrapped });
		assert.equal(json.status, 4);
		assert.deepEqual(JSON.parse(json.stdout).contexts.errors, [{ rel: broken.paths.newContexts, code: 'EACCES' }]);
	});

	it('runs the real version guard, which fails open without an installed SKILL.md and needs no network', () => {
		for (const editor of ['.claude', '.cursor']) assert.equal(fs.existsSync(path.join(os.homedir(), editor, 'skills', 'make-custom-app', 'SKILL.md')), false);
		assert.doesNotMatch(process.argv[1], /[\\/]\.(claude|cursor)[\\/]skills[\\/]make-custom-app/);
		const h = fresh({ plugin: 'usable' });
		const result = runMain(h, [], {}, { argv: [] });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, '');
	});

	it('a held lock ends the run with exit 4, the lock line with or without the pid, and no copy', () => {
		const h = fresh();
		const lock = path.join(h.home, '.make-custom-app', 'cleanup.lock');
		fs.mkdirSync(path.dirname(lock), { mode: 0o700 });
		fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
		const withPid = runMain(h, ['--json']);
		assert.equal(withPid.status, 4);
		assert.deepEqual(JSON.parse(withPid.stdout).lock, { held: true, pid: process.pid });
		assert.equal(runMain(h).stdout.includes(`(lock ~/.make-custom-app/cleanup.lock, pid ${process.pid}). Nothing was copied; run this script again.\n`), true);
		fs.writeFileSync(lock, '');
		const noPid = runMain(h);
		assert.equal(noPid.status, 4);
		assert.ok(noPid.stdout.includes('(lock ~/.make-custom-app/cleanup.lock). Nothing was copied; run this script again. If no other run is active, delete ~/.make-custom-app/cleanup.lock and ~/.make-custom-app/cleanup.lock.takeover, then run it again.\n'));
		assert.equal(noPid.stdout.includes(RETRY_LINE), false);
		assert.equal(fs.existsSync(h.paths.secrets), false);
		assert.equal(fs.existsSync(h.paths.newContexts), false);
	});

	it('a plugin manifest that cannot be read is a verification problem', () => {
		const h = fresh({ plugin: 'usable' });
		const manifest = path.join(h.home, '.claude', 'plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0', '.claude-plugin', 'plugin.json');
		const wrapped = {
			...fs,
			readFileSync(file, ...rest) {
				if (file === manifest) throw Object.assign(new Error('x'), { code: 'EACCES' });
				return fs.readFileSync(file, ...rest);
			},
		};
		const result = runMain(h, [], {}, { fs: wrapped });
		assert.equal(result.status, 1);
		assert.equal(result.stderr, linesOf(`The plugin install could not be verified: ${manifest} could not be read`));
	});

	it('a lock that cannot be created for a reason other than a held lock exits 4 and names the lock file', () => {
		const h = fresh();
		const lock = path.join(h.home, '.make-custom-app', 'cleanup.lock');
		const wrapped = {
			...fs,
			writeFileSync(file, ...rest) {
				if (file === lock) throw Object.assign(new Error('x'), { code: 'EROFS' });
				return fs.writeFileSync(file, ...rest);
			},
		};
		const result = runMain(h, ['--json'], {}, { fs: wrapped });
		assert.equal(result.status, 4);
		const report = JSON.parse(result.stdout);
		assert.equal(report.secrets.error, `EROFS on ${lock}`);
		assert.deepEqual(report.lock, { held: false, pid: null });
		assert.equal(fs.existsSync(h.paths.secrets), false);
		const other = runMain(fresh(), [], {}, { fs: { ...fs, writeFileSync() { throw new TypeError('not a file error'); } } });
		assert.equal(other.status, 1);
		assert.equal(other.stderr, 'migrate-to-plugin: unexpected error: an unexpected error occurred\n');
	});

	it('verification problems and an unreadable manifest exit 1 with one line per problem', () => {
		const h = fresh();
		const spawn = stubSpawn([
			ok(CLAUDE_VERSION_LINE),
			ok('[]'),
			ok(),
			() => {
				const installPath = writePluginFiles(makeIo({ guard: (file) => file, dry: false }), { config: path.join(h.home, '.claude'), version: FAKE_PLUGIN_VERSION, record: true, disabled: false, objectEntry: false });
				fs.rmSync(path.join(installPath, 'mcp', 'index.mjs'));
				fs.writeFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), '{"name":"other","version":"3.0.0"}');
				return ok();
			},
		]);
		const result = runMain(h, ['--json'], {}, { spawn });
		assert.equal(result.status, 1);
		const installPath = path.join(h.home, '.claude', 'plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0');
		const manifest = path.join(installPath, '.claude-plugin', 'plugin.json');
		assert.equal(result.stderr, linesOf(`The plugin install could not be verified: the name in ${manifest} is not make-custom-app`, `The plugin install could not be verified: ${path.join(installPath, 'mcp', 'index.mjs')} is missing`));
		const report = JSON.parse(result.stdout);
		assert.equal(report.plugin.action, 'failed');
		assert.equal(report.plugin.problems.length, 2);
		assert.equal(fs.existsSync(h.paths.secrets), false);

		const unreadable = fresh({ plugin: 'usable' });
		fs.rmSync(path.join(unreadable.home, '.claude', 'plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0', 'mcp', 'index.mjs'));
		const handoff = runMain(unreadable);
		assert.equal(handoff.status, 1);
		assert.match(handoff.stderr, /^The plugin install could not be verified: .*index\.mjs is missing\n$/);
	});
});
