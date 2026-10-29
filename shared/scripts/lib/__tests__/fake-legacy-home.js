'use strict';
require('./isolate-home');
/**
 * Test helper, not a test file. Builds a synthetic 2.x install inside a temporary root (it never reads skill/), a
 * fake `claude` for it, a concurrent writer of ~/.claude.json, and tree snapshots. Everything lies inside TEST_ROOT.
 * Only fake values are used (FAKE); no real key, home folder, or binary is involved.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { TEST_ROOT } = require('./isolate-home');

const FAKE = {
	pinecone: 'fake-pinecone-0001',
	openai: 'fake-openai-0001',
	index: 'make-app-contexts',
	otherToken: 'fake-other-token-1111',
	cursorToken: 'fake-cursor-token-2222',
	conflictPinecone: 'fake-pinecone-9999',
};

/** The block install-claude.sh appends to ~/.claude/CLAUDE.md (2.3.13), markers included, without the final newline. */
const INSTALLER_BLOCK =
	'<!-- make-custom-app-skill -->\n# Make Custom App Skill\n\nWhen the conversation involves a Make.com custom app, IMLJSON, the Make Apps SDK, `make-app-contexts`, or an IEN Jira ticket about an app: invoke the `make-custom-app` skill before any other action and follow it. Do not answer from memory. Do not delegate this work to a sub-agent.\n<!-- /make-custom-app-skill -->';

const PLUGIN_ID = 'make-custom-app@make-custom-app';
const FAKE_CLAUDE_VERSION = '2.1.312';
const EDITORS = ['claude', 'cursor'];
const PLUGIN_STATES = ['enabled', 'disabled', 'project-only', 'absent'];
const SECRETS_STATES = ['same', 'missing', 'conflict'];
const CURSOR_FORMATS = ['canonical', 'compact', 'jsonc'];
const CLAUDE_MODES = ['ok', 'fail', 'echo-secrets', 'none'];
const CLAUDE_ENTRIES = ['old', 'plugin-bundle', 'unrelated', 'mcp-server-path'];
const WRITER_MODES = ['counter', 'resurrect-once', 'resurrect-always'];
const SHEBANG_MAX_LENGTH = 100;

// The functions from isInside to fakeClaudeMain are written into the fake claude as source text, so they use only fs, path, process, and the constants of fakeClaudeSource (TEST_ROOT_REAL, FAKE_CLAUDE_VERSION).
function isInside(child, parent) {
	return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** The real path of the deepest existing parent, joined with the rest, so a folder that does not exist yet can be checked. */
function realish(value) {
	const rest = [];
	let current = path.resolve(value);
	for (;;) {
		try {
			return path.join(fs.realpathSync(current), ...rest);
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(value);
			rest.unshift(path.basename(current));
			current = parent;
		}
	}
}

function fakeClaudeMain(argv, env) {
	const refuse = (what) => {
		process.stderr.write(`fake claude: ${what}; refusing\n`);
		return 97;
	};
	const given = (name) => typeof env[name] === 'string' && env[name] !== '';
	const hasParent = (value) => value.split(/[\\/]/).includes('..');
	const isLink = (file) => {
		try {
			return fs.lstatSync(file).isSymbolicLink();
		} catch {
			return false;
		}
	};
	if (!given('HOME') || !given('FAKE_CLAUDE_ROOT') || hasParent(env.HOME)) return refuse('HOME is outside FAKE_CLAUDE_ROOT');
	const root = realish(env.FAKE_CLAUDE_ROOT);
	if (!isInside(realish(env.HOME), root)) return refuse('HOME is outside FAKE_CLAUDE_ROOT');
	if (root === TEST_ROOT_REAL || !isInside(root, TEST_ROOT_REAL)) return refuse('FAKE_CLAUDE_ROOT is outside the test root');
	const configSet = given('CLAUDE_CONFIG_DIR');
	if (configSet && (hasParent(env.CLAUDE_CONFIG_DIR) || !isInside(realish(env.CLAUDE_CONFIG_DIR), root))) return refuse('CLAUDE_CONFIG_DIR is outside FAKE_CLAUDE_ROOT');
	const logSet = given('FAKE_CLAUDE_LOG');
	if (logSet && (!path.isAbsolute(env.FAKE_CLAUDE_LOG) || hasParent(env.FAKE_CLAUDE_LOG) || !isInside(realish(env.FAKE_CLAUDE_LOG), root) || isLink(env.FAKE_CLAUDE_LOG))) {
		return refuse('FAKE_CLAUDE_LOG is outside FAKE_CLAUDE_ROOT');
	}
	const mode = env.FAKE_CLAUDE_MODE || 'ok';
	if (!['ok', 'fail', 'echo-secrets'].includes(mode)) {
		process.stderr.write('fake claude: unknown FAKE_CLAUDE_MODE\n');
		return 2;
	}
	const userFile = path.join(configSet ? env.CLAUDE_CONFIG_DIR : env.HOME, '.claude.json');
	if (isLink(userFile)) return refuse('the user file is a symbolic link');

	if (logSet) fs.appendFileSync(env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, claudecode: 'CLAUDECODE' in env })}\n`);

	const out = (text) => process.stdout.write(`${text}\n`);
	const err = (text) => process.stderr.write(`${text}\n`);
	if (argv.length === 1 && argv[0] === '--version') {
		out(`${FAKE_CLAUDE_VERSION} (Claude Code)`);
		return 0;
	}
	if (argv[0] !== 'mcp') {
		err('unexpected command');
		return 2;
	}
	if (mode === 'fail') {
		err('simulated failure');
		return 1;
	}
	const remove = argv.length === 5 && argv[1] === 'remove' && argv[3] === '--scope' && argv[4] === 'user';
	const addJson = argv.length === 6 && argv[1] === 'add-json' && argv[4] === '--scope' && argv[5] === 'user';
	if (!remove && !addJson) {
		err('unexpected command');
		return 2;
	}
	const key = argv[2];
	let data = null;
	try {
		data = JSON.parse(fs.readFileSync(userFile, 'utf8'));
	} catch (error) {
		if (error.code !== 'ENOENT') {
			err('fake claude: the user file is not valid JSON');
			return 1;
		}
	}
	const servers = data !== null && typeof data.mcpServers === 'object' && data.mcpServers !== null ? data.mcpServers : {};
	let entry;
	if (remove) {
		if (!Object.hasOwn(servers, key)) {
			err(`No MCP server named "${key}" in user scope`);
			return 1;
		}
		entry = servers[key];
		delete servers[key];
	} else {
		try {
			entry = JSON.parse(argv[3]);
		} catch {
			err('fake claude: the entry is not valid JSON');
			return 1;
		}
		delete servers[key];
		servers[key] = entry;
	}
	data = { ...(data === null ? {} : data), mcpServers: servers };
	let fileMode = 0o600;
	try {
		fileMode = fs.statSync(userFile).mode & 0o7777;
	} catch {
		// a new file keeps 0600, as Claude Code creates it
	}
	const temp = `${userFile}.fake-claude-${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: fileMode });
	fs.chmodSync(temp, fileMode);
	fs.renameSync(temp, userFile);
	if (remove) {
		out(`Removed MCP server ${key} from user config`);
		out(`File modified: ${userFile}`);
		if (mode === 'echo-secrets') {
			out(JSON.stringify(entry));
			err(JSON.stringify(entry));
		}
	} else {
		out(`Added stdio MCP server ${key} to user config`);
	}
	return 0;
}

function shebangFits(node) {
	return !/\s/.test(node) && node.length <= SHEBANG_MAX_LENGTH;
}

function fakeClaudeSource(node) {
	const constants = { TEST_ROOT_REAL: TEST_ROOT, FAKE_CLAUDE_VERSION };
	const header = shebangFits(node) ? [`#!${node}`] : ['#!/bin/sh', `':' //; exec '${node.replace(/'/g, "'\\''")}' "$0" "$@"`];
	return [
		...header,
		"'use strict';",
		"const fs = require('fs');",
		"const path = require('path');",
		...Object.entries(constants).map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`),
		isInside.toString(),
		realish.toString(),
		fakeClaudeMain.toString(),
		'let code;',
		'try {',
		'\tcode = fakeClaudeMain(process.argv.slice(2), process.env);',
		'} catch (error) {',
		"\tprocess.stderr.write(`fake claude: unexpected error (${error && error.code ? error.code : 'unknown'})\\n`);",
		'\tcode = 2;',
		'}',
		'process.exitCode = code;',
		'',
	].join('\n');
}

function writeText(file, text, mode = 0o644) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	fs.chmodSync(file, mode);
}

function writeJson(file, value, mode) {
	writeText(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function writeFakeClaude(binDir) {
	fs.mkdirSync(binDir, { recursive: true });
	const file = path.join(binDir, 'claude');
	writeText(file, fakeClaudeSource(process.execPath), 0o755);
	if (process.platform === 'win32') writeText(path.join(binDir, 'claude.cmd'), `@"${process.execPath}" "%~dp0claude" %*\r\n`);
	return file;
}

function writeSkillFolder(dir, envText) {
	writeText(path.join(dir, 'SKILL.md'), '---\nname: make-custom-app\nversion: 2.4.0\ndescription: A fake old skill for tests.\n---\n\n# Fake old skill\n');
	writeText(path.join(dir, 'scripts', 'check-setup.js'), "'use strict';\nprocess.exit(0);\n");
	writeText(path.join(dir, 'mcp-server', 'dist', 'index.js'), "'use strict';\n");
	writeText(path.join(dir, 'mcp-server', 'node_modules', 'fake', 'index.js'), 'module.exports = {};\n');
	writeText(path.join(dir, 'mcp-server', '.env'), envText, 0o644);
}

function registration(serverPath) {
	return { command: process.execPath, args: [serverPath], env: { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai, PINECONE_INDEX_NAME: FAKE.index } };
}

function pick(name, value, allowed) {
	if (!allowed.includes(value)) throw new TypeError(`buildFakeLegacyHome: ${name} must be one of ${allowed.join(', ')}`);
}

/**
 * Writes a synthetic 2.x install under `<root>/home` and returns { home, binDir, log, env, paths }. `env` is the whole
 * environment for a child process (no CLAUDE_CONFIG_DIR); `root` must lie inside TEST_ROOT. `claudeJsonMode` is the mode
 * of ~/.claude.json (Claude Code keeps it at 0600; an installer that created it would leave 0644).
 */
function buildFakeLegacyHome(options = {}) {
	const {
		root: given,
		pluginRoot,
		editors = EDITORS,
		pluginState = 'enabled',
		secrets = 'same',
		ownParagraph = true,
		symlinkSkill = false,
		cursorFormat = 'canonical',
		claudeMode = 'ok',
		claudeEntry = 'old',
		envText = null,
		claudeJsonMode = 0o600,
	} = options;
	if (typeof given !== 'string' || given === '') throw new TypeError('buildFakeLegacyHome needs root');
	const root = path.resolve(given);
	if (!path.isAbsolute(given) || !isInside(realish(root), TEST_ROOT) || realish(root) === TEST_ROOT) throw new TypeError('buildFakeLegacyHome: root must lie inside TEST_ROOT');
	if (!Array.isArray(editors) || editors.some((editor) => !EDITORS.includes(editor))) throw new TypeError('buildFakeLegacyHome: editors must name claude or cursor');
	pick('pluginState', pluginState, PLUGIN_STATES);
	pick('secrets', secrets, SECRETS_STATES);
	pick('cursorFormat', cursorFormat, CURSOR_FORMATS);
	pick('claudeMode', claudeMode, CLAUDE_MODES);
	pick('claudeEntry', claudeEntry, CLAUDE_ENTRIES);
	if ((pluginState !== 'absent' || claudeEntry === 'plugin-bundle') && (typeof pluginRoot !== 'string' || pluginRoot === '')) throw new TypeError('buildFakeLegacyHome needs pluginRoot');

	const home = path.join(root, 'home');
	const tmp = path.join(root, 'tmp');
	const binDir = path.join(root, 'bin');
	const log = path.join(root, 'claude-log.jsonl');
	for (const dir of [home, tmp, binDir]) fs.mkdirSync(dir, { recursive: true });
	const config = path.join(home, '.claude');
	const claudeSkill = path.join(config, 'skills', 'make-custom-app');
	const cursorSkill = path.join(home, '.cursor', 'skills', 'make-custom-app');
	const skillTarget = path.join(root, 'skill-target');
	const paths = {
		root,
		home,
		tmp,
		binDir,
		log,
		config,
		claudeSkill,
		claudeEnv: path.join(claudeSkill, 'mcp-server', '.env'),
		claudeJson: path.join(home, '.claude.json'),
		claudeMd: path.join(config, 'CLAUDE.md'),
		cursorSkill,
		cursorEnv: path.join(cursorSkill, 'mcp-server', '.env'),
		cursorRules: path.join(home, '.cursor', 'rules', 'make-custom-app'),
		cursorMcp: path.join(home, '.cursor', 'mcp.json'),
		claudeContexts: path.join(config, 'make-app-contexts'),
		cursorContexts: path.join(home, '.cursor', 'make-app-contexts'),
		secrets: path.join(home, '.make-custom-app-skill-secrets'),
		installedPlugins: path.join(config, 'plugins', 'installed_plugins.json'),
		settingsJson: path.join(config, 'settings.json'),
		skillTarget,
		claudeBin: path.join(binDir, 'claude'),
	};
	const env = {
		PATH: binDir,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: tmp,
		TEMP: tmp,
		TMP: tmp,
		CLAUDE_BIN: paths.claudeBin,
		FAKE_CLAUDE_ROOT: root,
		FAKE_CLAUDE_LOG: log,
		FAKE_CLAUDE_MODE: claudeMode,
	};
	const dotEnv = envText ?? `PINECONE_API_KEY=${FAKE.pinecone}\nOPENAI_API_KEY=${FAKE.openai}\nPINECONE_INDEX_NAME=${FAKE.index}\n`;

	if (editors.includes('claude')) {
		if (symlinkSkill) {
			writeSkillFolder(skillTarget, dotEnv);
			fs.mkdirSync(path.dirname(claudeSkill), { recursive: true });
			fs.symlinkSync(skillTarget, claudeSkill);
		} else {
			writeSkillFolder(claudeSkill, dotEnv);
		}
		const serverPath = {
			old: path.join(claudeSkill, 'mcp-server', 'dist', 'index.js'),
			'plugin-bundle': path.join(pluginRoot || '', 'mcp', 'index.mjs'),
			unrelated: path.join(root, 'elsewhere', 'server.js'),
			'mcp-server-path': path.join(root, 'clone', 'mcp-server', 'dist', 'index.js'),
		}[claudeEntry];
		writeText(
			paths.claudeJson,
			`${JSON.stringify(
				{
					numStartups: 7,
					projects: { '/work': { mcpServers: {} } },
					mcpServers: {
						'other-server': { command: 'node', args: ['/opt/other.js'], env: { API_TOKEN: FAKE.otherToken } },
						'make-custom-app': registration(serverPath),
					},
				},
				null,
				2,
			)}\n`,
			claudeJsonMode,
		);
		const notes = ownParagraph ? '# My notes\n\nAlways invoke the `make-custom-app` skill for Make apps.' : '# My notes';
		writeText(paths.claudeMd, `${notes}\n\n${INSTALLER_BLOCK}\n`, 0o600);
	}

	if (editors.includes('cursor')) {
		writeSkillFolder(cursorSkill, dotEnv);
		writeText(path.join(paths.cursorRules, 'make-custom-app.mdc'), '---\ndescription: Make custom app skill\nalwaysApply: true\n---\n\nUse the make-custom-app skill for Make apps.\n');
		const canonical = `${JSON.stringify(
			{
				mcpServers: {
					'other-cursor': { command: 'node', args: ['/opt/other-cursor.js'], env: { TOKEN: FAKE.cursorToken } },
					'make-app-context': registration(path.join(cursorSkill, 'mcp-server', 'dist', 'index.js')),
				},
			},
			null,
			2,
		)}\n`;
		const text = { canonical, compact: JSON.stringify(JSON.parse(canonical)), jsonc: canonical.replace('{\n', '{\n  // a comment of the user\n') }[cursorFormat];
		writeText(paths.cursorMcp, text, 0o600);
	}

	if (pluginState !== 'absent') {
		const record = { scope: pluginState === 'project-only' ? 'project' : 'user', installPath: pluginRoot, version: '3.0.0', installedAt: '2026-10-01T00:00:00.000Z', lastUpdated: '2026-10-01T00:00:00.000Z', gitCommitSha: '0'.repeat(40) };
		writeJson(paths.installedPlugins, { version: 2, plugins: { [PLUGIN_ID]: [record] } });
		writeJson(paths.settingsJson, { enabledPlugins: { [PLUGIN_ID]: pluginState !== 'disabled' } });
	}

	const lines = {
		same: [`pinecone-api-key: ${FAKE.pinecone}`, `openai-api-key: ${FAKE.openai}`, `pinecone-index-name: ${FAKE.index}`],
		missing: ['editor: claude'],
		conflict: [`pinecone-api-key: ${FAKE.conflictPinecone}`, `openai-api-key: ${FAKE.openai}`, `pinecone-index-name: ${FAKE.index}`],
	}[secrets];
	if (claudeEntry === 'mcp-server-path') lines.push(`mcp-server-path: ${path.join(root, 'clone', 'mcp-server')}`);
	writeText(paths.secrets, `${lines.join('\n')}\n`, 0o600);

	if (claudeMode !== 'none') writeFakeClaude(binDir);
	return { home, binDir, log, env, paths };
}

// Runs as the code of the writer process; it uses only fs, process, and its argument.
function writerChild({ file, mode, key, entry, intervalMs }) {
	const fs = require('fs');
	const temp = `${file}.writer.tmp`;
	let writes = 0;
	let resurrected = false;
	const timer = setInterval(() => {
		let data;
		let fileMode;
		try {
			data = JSON.parse(fs.readFileSync(file, 'utf8'));
			fileMode = fs.statSync(file).mode & 0o7777;
		} catch {
			return;
		}
		if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
		data.writerCounter = writes + 1;
		if (mode !== 'counter') {
			const valid = typeof data.mcpServers === 'object' && data.mcpServers !== null && !Array.isArray(data.mcpServers);
			const servers = valid ? data.mcpServers : (data.mcpServers = {});
			if (!Object.hasOwn(servers, key) && (mode === 'resurrect-always' || !resurrected)) {
				servers[key] = entry;
				resurrected = true;
			}
		}
		try {
			fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: fileMode });
			fs.chmodSync(temp, fileMode);
			fs.renameSync(temp, file);
			writes += 1;
		} catch {
			// the folder may be gone at the end of a test
		}
	}, intervalMs);
	process.stdin.on('end', () => {
		clearInterval(timer);
		process.stdout.write(`${JSON.stringify({ writes })}\n`);
	});
	process.stdin.resume();
}

/**
 * Starts a Node child that rewrites `file` (a JSON object) every `intervalMs` through `<file>.writer.tmp` and a rename,
 * the way a running Claude Code keeps ~/.claude.json. Modes: counter (sets writerCounter only), resurrect-once and
 * resurrect-always (also put mcpServers[key] = entry back when it is missing, the first time or every time).
 * stop() ends the child and resolves { writes }.
 */
function startWriter({ file, mode = 'counter', key = 'make-custom-app', entry, intervalMs = 5 } = {}) {
	if (typeof file !== 'string' || !path.isAbsolute(file) || !isInside(realish(file), TEST_ROOT)) throw new TypeError('startWriter: file must lie inside TEST_ROOT');
	if (!WRITER_MODES.includes(mode)) throw new TypeError(`startWriter: mode must be one of ${WRITER_MODES.join(', ')}`);
	if (mode !== 'counter' && (typeof entry !== 'object' || entry === null)) throw new TypeError('startWriter needs entry');
	if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new TypeError('startWriter: intervalMs must be a positive integer');
	const code = `(${writerChild.toString()})(JSON.parse(process.argv[1]))`;
	const child = spawn(process.execPath, ['-e', code, JSON.stringify({ file, mode, key, entry: entry ?? null, intervalMs })], { stdio: ['pipe', 'pipe', 'pipe'] });
	let stdout = '';
	child.stdout.on('data', (chunk) => {
		stdout += chunk;
	});
	child.stdin.on('error', () => {});
	const closed = new Promise((resolve) => child.on('close', (status) => resolve(status)));
	child.unref();
	for (const stream of [child.stdin, child.stdout, child.stderr]) stream.unref();
	process.once('exit', () => child.kill('SIGKILL'));
	let stopping = null;
	return {
		stop() {
			if (stopping === null) {
				stopping = (async () => {
					child.stdin.end();
					let timer;
					const status = await Promise.race([
						closed,
						new Promise((resolve) => {
							timer = setTimeout(() => resolve('timeout'), 10000);
						}),
					]);
					clearTimeout(timer);
					if (status === 'timeout') child.kill('SIGKILL');
					const last = stdout.trim().split('\n').pop();
					if (status !== 0 || !last) throw new Error(`the writer did not report its count (${status})`);
					return JSON.parse(last);
				})();
			}
			return stopping;
		},
	};
}

/** Every path below `dir` (not `dir` itself) as rel -> { type, mode, sha256, linkTarget }; `exclude` lists rel paths whose subtrees are skipped. */
function snapshot(dir, { exclude = [] } = {}) {
	const result = new Map();
	const skipped = (rel) => exclude.some((item) => rel === item || rel.startsWith(`${item}/`));
	const visit = (abs, rel) => {
		for (const name of fs.readdirSync(abs).sort()) {
			const childAbs = path.join(abs, name);
			const childRel = rel === '' ? name : `${rel}/${name}`;
			if (skipped(childRel)) continue;
			const stat = fs.lstatSync(childAbs);
			const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
			result.set(childRel, {
				type,
				mode: stat.mode & 0o7777,
				sha256: type === 'file' ? crypto.createHash('sha256').update(fs.readFileSync(childAbs)).digest('hex') : null,
				linkTarget: type === 'symlink' ? fs.readlinkSync(childAbs) : null,
			});
			if (type === 'dir') visit(childAbs, childRel);
		}
	};
	visit(dir, '');
	return result;
}

/** One line per added, removed, or changed path, sorted by path. The lines never hold file content. */
function diffSnapshots(a, b) {
	const lines = [];
	for (const rel of new Set([...a.keys(), ...b.keys()])) {
		const before = a.get(rel);
		const after = b.get(rel);
		if (before === undefined) {
			lines.push([rel, `added ${rel}`]);
		} else if (after === undefined) {
			lines.push([rel, `removed ${rel}`]);
		} else {
			const changes = [];
			if (before.type !== after.type) changes.push(`type ${before.type} -> ${after.type}`);
			if (before.mode !== after.mode) changes.push(`mode ${before.mode.toString(8)} -> ${after.mode.toString(8)}`);
			if (before.sha256 !== after.sha256) changes.push('content');
			if (before.linkTarget !== after.linkTarget) changes.push('link target');
			if (changes.length > 0) lines.push([rel, `changed ${rel}: ${changes.join(', ')}`]);
		}
	}
	return lines.sort((x, y) => Number(x[0] > y[0]) - Number(x[0] < y[0])).map((line) => line[1]);
}

module.exports = { FAKE, INSTALLER_BLOCK, buildFakeLegacyHome, startWriter, snapshot, diffSnapshots };
