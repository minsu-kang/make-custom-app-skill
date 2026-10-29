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
const crypto = require('crypto');
const { cacheKey, JIRA_BASE_URL } = require('../access-guard-logic');
const { CLAUDE_VERSION_PATTERN, readPluginStatus, verifyInstall, parseMarketplaceList, listContextFiles } = require('../migrate-logic');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SKILL_SOURCE = path.join(REPO_ROOT, 'skill');
const BASE_COMMIT = 'cd8f60b';
const ID = 'make-custom-app@make-custom-app';
const DAY = 24 * 3600000;
const POSIX_ONLY = { skip: process.platform === 'win32' };
const BLOCK_NETWORK = path.join(TEST_ROOT, 'block-network.js');
const SECTION_BYTES = 891;
const PINNED_SECTION =
	'## Plugin migration\n\n' +
	'check-setup.js can print one `PLUGIN_MIGRATION: <state> | <text>` line. Act on it before other work, also when check-setup exits 1 (the plugin needs the same setup). `ask`: ask the user once, yes or no: "Install the make-custom-app plugin? It replaces this skill and copies your MCP keys and app contexts; nothing is deleted." Never answer for the user. On yes, run the `migrate-to-plugin.js` command printed on the line (Shell, `required_permissions: ["all"]`); on no, continue. `handoff`: do the steps of the line in order. Other states: tell the user the text once, then continue. `migrate-to-plugin.js` exit 0: relay its last lines. Exit 3: this skill was just updated; re-read this file, then run the command again. Exit 1, 4, or 5: relay its output; this skill keeps working. Then continue the user\'s task. Do the steps of a `handoff` line once per conversation.\n\n';

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
const FAKE_MODES = ['normal', 'add-fails', 'install-fails', 'install-no-record', 'wrong-version', 'hang', 'disabled', 'object-entry', 'already-added', 'not-claude'];
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
	if (mode === 'hang') return { code: 0, out: null, err: null, hang: true };
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
