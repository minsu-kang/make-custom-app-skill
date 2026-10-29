/**
 * Tests for legacy-install.js and for the test homes of fake-legacy-home.js. The file moves HOME and the temp folders
 * into a temporary root first (isolate-home), and every test builds a fake home folder and passes it in, so nothing
 * reads the real HOME.
 */
const { TEST_ROOT, REAL_HOME, assertIsolated } = require('./isolate-home');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const settings = require('../settings');
const {
	SENTINEL_OPEN,
	SENTINEL_CLOSE,
	OLD_SKILL_FOLDER,
	pointsIntoOldSkill,
	readMcpServers,
	isOldRegistration,
	readMcpConfig,
	oldInstallPaths,
	isLookalikeSkillDir,
	ownRootsOf,
	dropOwnParts,
	detectLegacyInstall,
	legacyInstallLines,
} = require('../legacy-install');
const { FAKE, INSTALLER_BLOCK, INSTALLER_ENV_TEXT, buildFakeLegacyHome, startWriter, snapshot, diffSnapshots } = require('./fake-legacy-home');

let work;
let n = 0;

before(() => {
	work = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-install-test-'));
});

after(() => {
	fs.rmSync(work, { recursive: true, force: true });
});

function newHome() {
	const home = path.join(work, `home-${n++}`);
	fs.mkdirSync(home);
	return home;
}

function mkdir(home, ...parts) {
	const dir = path.join(home, ...parts);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function write(home, parts, text) {
	const file = path.join(home, ...parts);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

describe('detectLegacyInstall: folders', () => {
	it('returns an empty list for a home without old files', () => {
		assert.deepEqual(detectLegacyInstall({ home: newHome() }), []);
	});

	it('defaults to the current home folder', (t) => {
		const home = newHome();
		const dir = mkdir(home, '.claude', 'skills', 'make-custom-app');
		t.mock.method(os, 'homedir', () => home);
		assert.deepEqual(detectLegacyInstall(), [{ kind: 'skill-dir', path: dir, editor: 'claude' }]);
	});

	it('finds the Claude Code skill folder', () => {
		const home = newHome();
		const dir = mkdir(home, '.claude', 'skills', 'make-custom-app');
		mkdir(dir, 'scripts');
		assert.deepEqual(detectLegacyInstall({ home }), [{ kind: 'skill-dir', path: dir, editor: 'claude' }]);
	});

	it('finds the Cursor skill folder and the Cursor rule folder', () => {
		const home = newHome();
		const skill = mkdir(home, '.cursor', 'skills', 'make-custom-app');
		const rules = mkdir(home, '.cursor', 'rules', 'make-custom-app');
		assert.deepEqual(detectLegacyInstall({ home }), [
			{ kind: 'skill-dir', path: skill, editor: 'cursor' },
			{ kind: 'rules-dir', path: rules, editor: 'cursor' },
		]);
	});

	it('ignores a file where a folder is expected', () => {
		const home = newHome();
		write(home, ['.claude', 'skills', 'make-custom-app'], 'not a folder');
		write(home, ['.cursor', 'rules', 'make-custom-app'], 'not a folder');
		assert.deepEqual(detectLegacyInstall({ home }), []);
	});

	it('ignores the new plugin folders and other skills', () => {
		const home = newHome();
		mkdir(home, '.claude', 'skills', 'make-app-setup');
		mkdir(home, '.claude', 'skills', 'make-custom-app-notes');
		mkdir(home, '.claude', 'plugins', 'cache', 'make-custom-app');
		mkdir(home, '.cursor', 'rules', 'other-rule');
		assert.deepEqual(detectLegacyInstall({ home }), []);
	});
});

describe('detectLegacyInstall: the block in ~/.claude/CLAUDE.md', () => {
	const OPEN = '<!-- make-custom-app-skill -->';
	const CLOSE = '<!-- /make-custom-app-skill -->';
	const BLOCK = `${OPEN}\n## Make custom app\nUse the make-custom-app skill.\n${CLOSE}\n`;

	it('finds the block between the markers', () => {
		const home = newHome();
		const file = write(home, ['.claude', 'CLAUDE.md'], `# My notes\n\n${BLOCK}\nMore notes\n`);
		assert.deepEqual(detectLegacyInstall({ home }), [{ kind: 'sentinel', path: file, editor: 'claude', closed: true }]);
	});

	it('reports a block with no closing marker as closed: false', () => {
		const home = newHome();
		const file = write(home, ['.claude', 'CLAUDE.md'], `${OPEN}\n## Make custom app\n`);
		assert.deepEqual(detectLegacyInstall({ home }), [{ kind: 'sentinel', path: file, editor: 'claude', closed: false }]);
	});

	it('reports a closing marker that comes before the opening marker as closed: false', () => {
		const home = newHome();
		const file = write(home, ['.claude', 'CLAUDE.md'], `${CLOSE}\n${OPEN}\n`);
		assert.deepEqual(detectLegacyInstall({ home }), [{ kind: 'sentinel', path: file, editor: 'claude', closed: false }]);
	});

	it('reads Windows line endings', () => {
		const home = newHome();
		const file = write(home, ['.claude', 'CLAUDE.md'], BLOCK.replace(/\n/g, '\r\n'));
		assert.deepEqual(detectLegacyInstall({ home }), [{ kind: 'sentinel', path: file, editor: 'claude', closed: true }]);
	});

	it('accepts spaces around the marker lines', () => {
		const home = newHome();
		const file = write(home, ['.claude', 'CLAUDE.md'], `  ${OPEN} \nold\n\t${CLOSE}\n`);
		assert.deepEqual(detectLegacyInstall({ home }), [{ kind: 'sentinel', path: file, editor: 'claude', closed: true }]);
	});

	it('ignores a CLAUDE.md with no opening marker line, including prose that quotes a marker', () => {
		const home = newHome();
		write(home, ['.claude', 'CLAUDE.md'], `The old block started with ${OPEN} and ended with ${CLOSE}.\n${CLOSE}\n`);
		assert.deepEqual(detectLegacyInstall({ home }), []);
	});

	it('ignores a CLAUDE.md that is a folder', () => {
		const home = newHome();
		mkdir(home, '.claude', 'CLAUDE.md');
		assert.deepEqual(detectLegacyInstall({ home }), []);
	});
});

describe('detectLegacyInstall: MCP entries', () => {
	const TOKEN = 'FAKE_PINECONE_TOKEN_must_not_appear';
	const OTHER_TOKEN = 'FAKE_OTHER_SERVER_TOKEN_must_not_appear';

	function oldServerPath(home, editor = 'cursor') {
		return path.join(home, `.${editor}`, 'skills', 'make-custom-app', 'mcp-server', 'dist', 'index.js');
	}

	it('finds the make-custom-app entry of ~/.claude.json', () => {
		const home = newHome();
		const file = write(home, ['.claude.json'], JSON.stringify({
			numStartups: 3,
			mcpServers: {
				'make-custom-app': { command: process.execPath, args: [oldServerPath(home, 'claude')], env: { PINECONE_API_KEY: TOKEN } },
				'other-server': { command: 'npx', args: ['-y', 'some-server'] },
			},
		}));
		assert.deepEqual(detectLegacyInstall({ home }), [{ kind: 'mcp-entry', path: file, editor: 'claude', name: 'make-custom-app' }]);
	});

	it('ignores a ~/.claude.json without that entry, including servers a plugin brings', () => {
		const home = newHome();
		write(home, ['.claude.json'], JSON.stringify({
			mcpServers: { 'make-app-context': { command: 'node' }, 'plugin:make-custom-app:make-app-context': { command: 'node' } },
		}));
		assert.deepEqual(detectLegacyInstall({ home }), []);
	});

	it('finds Cursor entries by the path of their command or arguments, whatever the name', () => {
		const home = newHome();
		const old = oldServerPath(home);
		const file = write(home, ['.cursor', 'mcp.json'], JSON.stringify({
			mcpServers: {
				'make-app-context': { command: process.execPath, args: [old], env: { PINECONE_API_KEY: TOKEN } },
				renamed: { command: 'node', args: ['--enable-source-maps', old] },
				'by-command': { command: old },
				'folder-only': { command: 'node', args: [path.dirname(path.dirname(path.dirname(old)))] },
			},
		}));
		const expected = ['make-app-context', 'renamed', 'by-command', 'folder-only'].map((name) => ({ kind: 'mcp-entry', path: file, editor: 'cursor', name, format: 'json' }));
		assert.deepEqual(detectLegacyInstall({ home }), expected);
	});

	it('finds a Cursor entry whose path uses Windows separators', () => {
		const home = newHome();
		const file = write(home, ['.cursor', 'mcp.json'], JSON.stringify({
			mcpServers: { win: { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Users\\dev\\.cursor\\skills\\make-custom-app\\mcp-server\\dist\\index.js'] } },
		}));
		assert.deepEqual(detectLegacyInstall({ home }), [{ kind: 'mcp-entry', path: file, editor: 'cursor', name: 'win', format: 'json' }]);
	});

	it('ignores Cursor entries that only look similar, such as the plugin server with the same name', () => {
		const home = newHome();
		write(home, ['.cursor', 'mcp.json'], JSON.stringify({
			mcpServers: {
				'make-app-context': { command: 'node', args: [path.join(home, '.claude', 'plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0', 'mcp', 'index.mjs')] },
				extra: { command: 'node', args: [path.join(home, '.cursor', 'skills', 'make-custom-app-extra', 'index.js')] },
				elsewhere: { command: 'node', args: [path.join(home, 'tools', 'make-custom-app', 'index.js')] },
				remote: { url: 'https://example.com/mcp' },
			},
		}));
		assert.deepEqual(detectLegacyInstall({ home }), []);
	});

	it('never returns an env value, an argument or a token', () => {
		const home = newHome();
		write(home, ['.claude.json'], JSON.stringify({
			mcpServers: {
				'make-custom-app': { command: 'node', args: [oldServerPath(home, 'claude'), `--token=${TOKEN}`], env: { PINECONE_API_KEY: TOKEN, OPENAI_API_KEY: TOKEN } },
				unrelated: { command: 'npx', args: ['-y', 'x', `--token=${OTHER_TOKEN}`], env: { API_TOKEN: OTHER_TOKEN } },
			},
		}));
		write(home, ['.cursor', 'mcp.json'], JSON.stringify({
			mcpServers: {
				old: { command: 'node', args: [oldServerPath(home), `--token=${TOKEN}`], env: { OPENAI_API_KEY: TOKEN } },
				unrelated: { command: 'npx', args: ['-y', 'x', `--token=${OTHER_TOKEN}`], env: { API_TOKEN: OTHER_TOKEN } },
			},
		}));
		const items = detectLegacyInstall({ home });
		assert.equal(items.length, 2);
		assert.deepEqual(Object.keys(items[0]).sort(), ['editor', 'kind', 'name', 'path']);
		assert.deepEqual(Object.keys(items[1]).sort(), ['editor', 'format', 'kind', 'name', 'path']);
		const printed = JSON.stringify(items);
		for (const secret of [TOKEN, OTHER_TOKEN, 'PINECONE_API_KEY', 'API_TOKEN', '--token', 'unrelated']) assert.ok(!printed.includes(secret), `${secret} leaked: ${printed}`);
	});

	it('ignores malformed files and files of an unexpected shape', () => {
		const home = newHome();
		write(home, ['.claude.json'], '{ not json');
		write(home, ['.cursor', 'mcp.json'], '{"mcpServers": {"a": ');
		assert.deepEqual(detectLegacyInstall({ home }), []);
		for (const text of ['[]', 'null', '"text"', '42', '{}', '{"mcpServers": []}', '{"mcpServers": "x"}']) {
			write(home, ['.claude.json'], text);
			write(home, ['.cursor', 'mcp.json'], text);
			assert.deepEqual(detectLegacyInstall({ home }), [], text);
		}
		write(home, ['.cursor', 'mcp.json'], JSON.stringify({ mcpServers: { a: null, b: 5, c: 'text', d: { command: 5, args: 'text' }, e: { args: [5, null, {}, [path.join(home, '.cursor', 'skills', 'make-custom-app', 'x.js')]] } } }));
		assert.deepEqual(detectLegacyInstall({ home }), []);
	});

	it('finds every old artefact at once, Claude Code first', () => {
		const home = newHome();
		const claudeSkill = mkdir(home, '.claude', 'skills', 'make-custom-app');
		const claudeMd = write(home, ['.claude', 'CLAUDE.md'], '<!-- make-custom-app-skill -->\nold\n<!-- /make-custom-app-skill -->\n');
		const claudeJson = write(home, ['.claude.json'], JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node', args: [oldServerPath(home, 'claude')] } } }));
		const cursorSkill = mkdir(home, '.cursor', 'skills', 'make-custom-app');
		const cursorRules = mkdir(home, '.cursor', 'rules', 'make-custom-app');
		const cursorJson = write(home, ['.cursor', 'mcp.json'], JSON.stringify({ mcpServers: { 'make-app-context': { command: 'node', args: [oldServerPath(home)] } } }));
		assert.deepEqual(detectLegacyInstall({ home }), [
			{ kind: 'skill-dir', path: claudeSkill, editor: 'claude' },
			{ kind: 'sentinel', path: claudeMd, editor: 'claude', closed: true },
			{ kind: 'mcp-entry', path: claudeJson, editor: 'claude', name: 'make-custom-app' },
			{ kind: 'skill-dir', path: cursorSkill, editor: 'cursor' },
			{ kind: 'rules-dir', path: cursorRules, editor: 'cursor' },
			{ kind: 'mcp-entry', path: cursorJson, editor: 'cursor', name: 'make-app-context', format: 'json' },
		]);
	});
});

describe('legacyInstallLines', () => {
	const skillDir = path.join(path.sep, 'h', '.claude', 'skills', 'make-custom-app');
	const claudeMd = path.join(path.sep, 'h', '.claude', 'CLAUDE.md');
	const rulesDir = path.join(path.sep, 'h', '.cursor', 'rules', 'make-custom-app');
	const cursorJson = path.join(path.sep, 'h', '.cursor', 'mcp.json');

	it('returns no lines when nothing is left over', () => {
		assert.deepEqual(legacyInstallLines([]), []);
	});

	it('starts with the LEGACY_INSTALL line and names every item path', () => {
		const items = [
			{ kind: 'skill-dir', path: skillDir, editor: 'claude' },
			{ kind: 'sentinel', path: claudeMd, editor: 'claude', closed: true },
			{ kind: 'rules-dir', path: rulesDir, editor: 'cursor' },
			{ kind: 'mcp-entry', path: cursorJson, editor: 'cursor', name: 'make-app-context' },
		];
		assert.deepEqual(legacyInstallLines(items), [
			'LEGACY_INSTALL: 4 old install item(s) found; run the make-app-setup skill to clean up',
			`  ${skillDir} (old skill folder)`,
			`  ${claudeMd} (old skill block)`,
			`  ${rulesDir} (old Cursor rule folder)`,
			`  ${cursorJson} (old MCP server entry "make-app-context")`,
		]);
	});

	it('says when the closing marker of the block is missing', () => {
		const lines = legacyInstallLines([{ kind: 'sentinel', path: claudeMd, editor: 'claude', closed: false }]);
		assert.deepEqual(lines, [
			'LEGACY_INSTALL: 1 old install item(s) found; run the make-app-setup skill to clean up',
			`  ${claudeMd} (old skill block, closing marker missing)`,
		]);
	});
});

describe('the test home', () => {
	it('the test process sees a temporary home', () => {
		assertIsolated();
		assert.notEqual(os.homedir(), REAL_HOME);
		assert.ok(os.tmpdir().startsWith(TEST_ROOT));
	});

	it('assertIsolated fails when the process still sees the real home', () => {
		const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
		try {
			process.env.HOME = process.env.USERPROFILE = REAL_HOME;
			assert.throws(() => assertIsolated(), /os\.homedir\(\)/);
		} finally {
			process.env.HOME = saved.HOME;
			process.env.USERPROFILE = saved.USERPROFILE;
		}
		assertIsolated();
	});

	it('assertIsolated fails when the temp folder or CLAUDE_CONFIG_DIR is outside the root', () => {
		const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
		try {
			process.env.CLAUDE_CONFIG_DIR = path.dirname(TEST_ROOT);
			assert.throws(() => assertIsolated(), /CLAUDE_CONFIG_DIR/);
			process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
			process.env.TMPDIR = process.env.TEMP = process.env.TMP = path.dirname(TEST_ROOT);
			assert.throws(() => assertIsolated(), /os\.tmpdir\(\)/);
		} finally {
			Object.assign(process.env, saved);
		}
		assertIsolated();
	});
});

function withEnv(changes, run) {
	const saved = {};
	for (const name of Object.keys(changes)) saved[name] = process.env[name];
	try {
		Object.assign(process.env, changes);
		run();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

describe('assertIsolated checks every folder it names, with the boundary of the test root', () => {
	const evil = `${TEST_ROOT}-evil`;
	const other = path.join(TEST_ROOT, 'other');

	it('fails for a sibling folder that only shares the prefix of the test root', () => {
		withEnv({ HOME: `${evil}/home`, USERPROFILE: `${evil}/home` }, () => assert.throws(() => assertIsolated(), /os\.homedir\(\) is outside/));
		withEnv({ TMPDIR: `${evil}/tmp`, TEMP: `${evil}/tmp`, TMP: `${evil}/tmp` }, () => assert.throws(() => assertIsolated(), /os\.tmpdir\(\) is outside/));
		withEnv({ CLAUDE_CONFIG_DIR: `${evil}/claude-config` }, () => assert.throws(() => assertIsolated(), /CLAUDE_CONFIG_DIR is outside/));
		assertIsolated();
	});

	it('fails when SECRETS_PATH is outside the test root, also for the sibling prefix', () => {
		const saved = settings.SECRETS_PATH;
		try {
			for (const value of [path.join(REAL_HOME, '.make-custom-app-skill-secrets'), `${evil}/secrets`]) {
				settings.SECRETS_PATH = value;
				assert.throws(() => assertIsolated(), /SECRETS_PATH is outside/);
			}
		} finally {
			settings.SECRETS_PATH = saved;
		}
		assertIsolated();
	});

	it('fails when HOME, USERPROFILE, TMPDIR, TEMP, or TMP names another folder, even one inside the test root', () => {
		for (const name of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP']) {
			withEnv({ [name]: other }, () => assert.throws(() => assertIsolated(), { message: new RegExp(`^${name} is not`) }));
		}
		assertIsolated();
	});
});

describe('oldInstallPaths and the exports of the old markers', () => {
	it('oldInstallPaths names the eight old places and the two contexts folders', () => {
		const home = path.join(path.sep, 'h');
		assert.deepEqual(oldInstallPaths(home), {
			claudeSkill: path.join(home, '.claude', 'skills', 'make-custom-app'),
			claudeEnv: path.join(home, '.claude', 'skills', 'make-custom-app', 'mcp-server', '.env'),
			claudeJson: path.join(home, '.claude.json'),
			claudeMd: path.join(home, '.claude', 'CLAUDE.md'),
			cursorSkill: path.join(home, '.cursor', 'skills', 'make-custom-app'),
			cursorEnv: path.join(home, '.cursor', 'skills', 'make-custom-app', 'mcp-server', '.env'),
			cursorRules: path.join(home, '.cursor', 'rules', 'make-custom-app'),
			cursorMcp: path.join(home, '.cursor', 'mcp.json'),
			claudeContexts: path.join(home, '.claude', 'make-app-contexts'),
			cursorContexts: path.join(home, '.cursor', 'make-app-contexts'),
		});
	});

	it('oldInstallPaths needs a home folder', () => {
		for (const bad of [undefined, null, '', 5, {}]) assert.throws(() => oldInstallPaths(bad), { name: 'TypeError', message: 'oldInstallPaths needs home' });
	});

	it('exports the sentinel markers of the installer block and the old folder pattern', () => {
		assert.equal(SENTINEL_OPEN, '<!-- make-custom-app-skill -->');
		assert.equal(SENTINEL_CLOSE, '<!-- /make-custom-app-skill -->');
		assert.ok(INSTALLER_BLOCK.startsWith(`${SENTINEL_OPEN}\n# Make Custom App Skill\n\n`));
		assert.ok(INSTALLER_BLOCK.endsWith(`\n${SENTINEL_CLOSE}`));
		assert.ok(OLD_SKILL_FOLDER.test('/h/.claude/skills/make-custom-app/mcp-server'));
		assert.ok(!OLD_SKILL_FOLDER.test('/h/.claude/skills/make-custom-app-notes'));
	});
});

describe('readMcpConfig', () => {
	const entry = { command: 'node', args: ['/x.js'] };

	it('readMcpConfig: json, jsonc, missing, unreadable', () => {
		const home = newHome();
		const json = write(home, ['plain.json'], JSON.stringify({ mcpServers: { a: entry } }));
		assert.deepEqual(readMcpConfig(json), { servers: { a: entry }, format: 'json' });

		const jsonc = write(home, ['commented.json'], `{\n  // the servers of the user\n  "mcpServers": { "a": { "command": "node", "args": ["/x.js"], }, /* more */ }\n}\n`);
		assert.deepEqual(readMcpConfig(jsonc), { servers: { a: entry }, format: 'jsonc' });

		assert.deepEqual(readMcpConfig(path.join(home, 'absent.json')), { servers: {}, format: 'missing' });
		assert.deepEqual(readMcpConfig(path.join(json, 'below-a-file.json')), { servers: {}, format: 'missing' });

		mkdir(home, 'a-folder.json');
		assert.deepEqual(readMcpConfig(path.join(home, 'a-folder.json')), { servers: {}, format: 'unreadable' });
		const broken = write(home, ['broken.json'], '{ "mcpServers": { "a": ');
		assert.deepEqual(readMcpConfig(broken), { servers: {}, format: 'unreadable' });
	});

	it('gives no servers unless mcpServers is a plain object, and keeps the format it was read in', () => {
		const home = newHome();
		for (const text of ['[]', 'null', '"text"', '42', '{}', '{"mcpServers": []}', '{"mcpServers": "x"}', '{"mcpServers": null}']) {
			const file = write(home, ['shape.json'], text);
			assert.deepEqual(readMcpConfig(file), { servers: {}, format: 'json' }, text);
		}
		const file = write(home, ['shape.json'], '// note\n[]');
		assert.deepEqual(readMcpConfig(file), { servers: {}, format: 'jsonc' });
	});

	it('never returns file content in the result of a file that is not JSON', () => {
		const home = newHome();
		const file = write(home, ['secret.json'], `{ "mcpServers": { "a": { "env": { "TOKEN": "${FAKE.cursorToken}" } } `);
		const result = readMcpConfig(file);
		assert.deepEqual(result, { servers: {}, format: 'unreadable' });
		assert.ok(!JSON.stringify(result).includes(FAKE.cursorToken));
	});

	it('needs a file path', () => {
		for (const bad of [undefined, '', 5]) assert.throws(() => readMcpConfig(bad), { name: 'TypeError', message: 'readMcpConfig needs file' });
	});

	it('readMcpServers keeps reading plain JSON only', () => {
		const home = newHome();
		assert.deepEqual(readMcpServers(write(home, ['a.json'], JSON.stringify({ mcpServers: { a: entry } }))), { a: entry });
		assert.deepEqual(readMcpServers(write(home, ['b.json'], '{ // comment\n "mcpServers": { "a": {} } }')), {});
		assert.deepEqual(readMcpServers(path.join(home, 'absent.json')), {});
	});
});

describe('isOldRegistration', () => {
	const oldPath = path.join(path.sep, 'h', '.claude', 'skills', 'make-custom-app', 'mcp-server', 'dist', 'index.js');
	const MCP_PATH = path.join(path.sep, 'clone', 'mcp-server');
	const entryAt = (...args) => ({ command: 'node', args });

	it('isOldRegistration: an old skill path with either separator, a path under mcp-server-path, the plugin bundle, an unrelated path, a path with a .. segment', () => {
		assert.equal(isOldRegistration(entryAt(oldPath)), true);
		assert.equal(isOldRegistration(entryAt('C:\\Users\\dev\\.claude\\skills\\make-custom-app\\mcp-server\\dist\\index.js')), true);
		assert.equal(isOldRegistration({ command: oldPath }), true);
		assert.equal(isOldRegistration(entryAt('--flag', oldPath)), true);

		assert.equal(isOldRegistration(entryAt(path.join(MCP_PATH, 'dist', 'index.js')), MCP_PATH), true);
		assert.equal(isOldRegistration({ command: path.join(MCP_PATH, 'run.sh') }, MCP_PATH), true);
		assert.equal(isOldRegistration(entryAt(MCP_PATH), MCP_PATH), true);
		assert.equal(isOldRegistration(entryAt(path.join(MCP_PATH, 'dist', 'index.js')), `${MCP_PATH}/`), true);
		assert.equal(isOldRegistration(entryAt('C:\\work\\clone\\mcp-server\\dist\\index.js'), 'C:/work/clone/mcp-server'), true);
		assert.equal(isOldRegistration(entryAt('C:/work/clone/mcp-server/dist/index.js'), 'C:\\work\\clone\\mcp-server'), true);

		const bundle = path.join(path.sep, 'h', '.claude', 'plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0', 'mcp', 'index.mjs');
		assert.equal(isOldRegistration(entryAt(bundle), MCP_PATH), false);
		assert.equal(isOldRegistration(entryAt(path.join(path.sep, 'elsewhere', 'server.js')), MCP_PATH), false);
		assert.equal(isOldRegistration(entryAt(`${MCP_PATH}-2`, 'dist', 'index.js'), MCP_PATH), false);

		assert.equal(isOldRegistration(entryAt('/h/.claude/skills/make-custom-app/../other/y.js')), false);
		assert.equal(isOldRegistration(entryAt('C:\\x\\skills\\make-custom-app\\..\\y.js')), false);
		assert.equal(isOldRegistration(entryAt(`${MCP_PATH}/../other/y.js`), MCP_PATH), false);
		assert.equal(isOldRegistration(entryAt(`${MCP_PATH}/dist/../index.js`), MCP_PATH), false);
		assert.equal(isOldRegistration(entryAt('..', oldPath)), true);
		assert.equal(isOldRegistration(entryAt(`${MCP_PATH}/dist/../index.js`, path.join(MCP_PATH, 'ok.js')), MCP_PATH), true);
	});

	it('ignores an mcp-server-path that is not a usable folder, and entries of the wrong shape', () => {
		const file = path.join(MCP_PATH, 'dist', 'index.js');
		for (const bad of [undefined, null, '', '/', 'C:/', 'C:', 'relative/mcp-server', 5]) assert.equal(isOldRegistration(entryAt(file), bad), false, String(bad));
		for (const bad of [null, undefined, 'text', 5, [], { command: 5, args: 'x' }, { args: [5, null, {}] }]) assert.equal(isOldRegistration(bad, MCP_PATH), false, JSON.stringify(bad));
		assert.equal(isOldRegistration(entryAt('relative/mcp-server/x.js'), MCP_PATH), false);
	});

	it('the root folder and a drive root never make every absolute path old', () => {
		assert.equal(isOldRegistration(entryAt('/'), '/'), false);
		assert.equal(isOldRegistration(entryAt('/x/server.js'), '/'), false);
		for (const folder of ['C:/', 'C:\\', 'C:']) {
			assert.equal(isOldRegistration(entryAt('C:\\Users\\dev\\server.js'), folder), false, folder);
			assert.equal(isOldRegistration(entryAt('C:/Users/dev/server.js'), folder), false, folder);
		}
	});

	it('a relative entry path never counts, not even under a relative mcp-server-path', () => {
		assert.equal(isOldRegistration(entryAt('relative/mcp-server/x.js'), 'relative/mcp-server'), false);
		assert.equal(isOldRegistration(entryAt('./mcp-server/x.js'), './mcp-server'), false);
	});

	it('the old folder pattern needs a separator before skills and the exact folder name', () => {
		for (const text of ['myskills/make-custom-app/x', 'skills/make-custom-app/x', '/h/.claude/skills/make-custom-appx/x', '/h/.claude/skills/other/make-custom-app/x', 'make-custom-app/skills', '/h/myskills/make-custom-app/x']) {
			assert.equal(OLD_SKILL_FOLDER.test(text), false, text);
			assert.equal(pointsIntoOldSkill(entryAt(text)), false, text);
		}
		for (const text of ['/skills/make-custom-app', '/h/skills/make-custom-app/', '\\skills\\make-custom-app\\x', '/a/skills/make-custom-app/x']) assert.equal(OLD_SKILL_FOLDER.test(text), true, text);
	});

	it('an mcp-server-path with a .. segment is not usable, so it cannot name a folder above the one it spells', () => {
		for (const folder of ['/clone/mcp-server/..', '/clone/mcp-server/../', '/clone/mcp-server/../other', '/clone/mcp-server/../../clone', 'C:\\clone\\mcp-server\\..']) {
			assert.equal(isOldRegistration(entryAt('/clone/other/x.js'), folder), false, folder);
			assert.equal(isOldRegistration(entryAt('C:\\clone\\x.js'), folder), false, folder);
		}
		assert.equal(isOldRegistration(entryAt('/clone/mcp-server/x.js'), '/clone/mcp-server'), true);
	});

	it('dropOwnParts removes the command and arguments that lie inside an own root and keeps the rest, without env', () => {
		const own = '/h/.claude/plugins/cache/p/p/3.0.0';
		const entry = { command: 'node', args: [`${own}/mcp/index.mjs`, '--flag', '/x/skills/make-custom-app/y.js'], env: { PINECONE_API_KEY: FAKE.pinecone } };
		assert.deepEqual(dropOwnParts(entry, [own]), { command: 'node', args: ['--flag', '/x/skills/make-custom-app/y.js'] });
		assert.deepEqual(dropOwnParts({ command: `${own}/run.sh`, args: [] }, [own]), { command: undefined, args: [] });
		assert.deepEqual(dropOwnParts({ command: 'node' }, [own]), { command: 'node', args: undefined });
		assert.deepEqual(dropOwnParts(entry, []), { command: 'node', args: entry.args });
		assert.deepEqual(dropOwnParts({ command: 'C:\\p\\plugin\\run.exe' }, ['C:/p/plugin']), { command: undefined, args: undefined });
		assert.deepEqual(dropOwnParts({ command: `${own}-2/run.sh` }, [own]), { command: `${own}-2/run.sh`, args: undefined });
		for (const bad of [null, undefined, 'text', 5, []]) assert.equal(dropOwnParts(bad, [own]), bad);
		assert.ok(!JSON.stringify(dropOwnParts(entry, [own])).includes(FAKE.pinecone));
	});

	it('ownRootsOf lists each folder and its real path, once, and skips what is not a folder name', () => {
		const home = newHome();
		const real = mkdir(home, 'real');
		const link = path.join(home, 'link');
		fs.symlinkSync(real, link);
		assert.deepEqual(ownRootsOf(link, [real, '', null, 5, 'relative']), [link, real, 'relative']);
		assert.deepEqual(ownRootsOf(path.join(link, 'missing')), [path.join(link, 'missing'), path.join(real, 'missing')]);
		assert.deepEqual(ownRootsOf(undefined), []);
	});

	it('pointsIntoOldSkill skips a part with a .. segment', () => {
		assert.equal(pointsIntoOldSkill(entryAt(oldPath)), true);
		assert.equal(pointsIntoOldSkill(entryAt('/h/.cursor/skills/make-custom-app/../y.js')), false);
		assert.equal(pointsIntoOldSkill(null), false);
	});
});

describe('detectLegacyInstall: lookalike folders and registrations', () => {
	const oldFile = (home, editor = 'claude') => path.join(home, `.${editor}`, 'skills', 'make-custom-app', 'mcp-server', 'dist', 'index.js');

	it('a skills-dir plugin named make-custom-app is not an old install', () => {
		const home = newHome();
		const claude = mkdir(home, '.claude', 'skills', 'make-custom-app');
		mkdir(claude, '.claude-plugin');
		const cursor = mkdir(home, '.cursor', 'skills', 'make-custom-app');
		mkdir(cursor, '.cursor-plugin');
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot: path.join(home, 'elsewhere') }), []);
		assert.deepEqual(detectLegacyInstall({ home }), []);
		assert.equal(isLookalikeSkillDir(claude, path.join(home, 'elsewhere')), true);
		assert.equal(isLookalikeSkillDir(cursor, path.join(home, 'elsewhere')), true);
	});

	it('a file named like a plugin folder does not make a skill folder a plugin', () => {
		const home = newHome();
		const claude = mkdir(home, '.claude', 'skills', 'make-custom-app');
		write(claude, ['.claude-plugin'], 'a file');
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot: path.join(home, 'elsewhere') }), [{ kind: 'skill-dir', path: claude, editor: 'claude' }]);
	});

	it('a folder that contains the running plugin root is not an old install', () => {
		const home = newHome();
		const claude = mkdir(home, '.claude', 'skills', 'make-custom-app');
		const inner = mkdir(claude, 'nested', 'plugin');
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot: inner }), []);
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot: claude }), []);
		const cursor = mkdir(home, '.cursor', 'skills', 'make-custom-app');
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot: mkdir(cursor, 'x') }), [{ kind: 'skill-dir', path: claude, editor: 'claude' }]);

		const linked = newHome();
		const checkout = mkdir(linked, 'checkout');
		const link = path.join(mkdir(linked, '.claude', 'skills'), 'make-custom-app');
		fs.symlinkSync(checkout, link);
		assert.deepEqual(detectLegacyInstall({ home: linked, pluginRoot: checkout }), []);
		assert.deepEqual(detectLegacyInstall({ home: linked, pluginRoot: mkdir(checkout, 'sub') }), []);
		assert.deepEqual(detectLegacyInstall({ home: linked, pluginRoot: path.join(link, 'sub') }), []);
	});

	it('a folder that does not contain the plugin root is still an old install', () => {
		const home = newHome();
		const claude = mkdir(home, '.claude', 'skills', 'make-custom-app');
		const sibling = mkdir(home, '.claude', 'skills', 'make-custom-app-2');
		const expected = [{ kind: 'skill-dir', path: claude, editor: 'claude' }];
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot: sibling }), expected);
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot: path.join(home, 'missing') }), expected);
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot: home }), expected);
		assert.equal(isLookalikeSkillDir(claude, sibling), false);
	});

	it('isLookalikeSkillDir needs both folders', () => {
		for (const args of [[], ['/a'], ['', '/b'], ['/a', ''], [5, '/b']]) assert.throws(() => isLookalikeSkillDir(...args), { name: 'TypeError', message: 'isLookalikeSkillDir needs dir and pluginRoot' });
	});

	it('a Cursor mcp.json with a comment is read and its item has format jsonc', () => {
		const home = newHome();
		const text = `{\n  // kept by the user\n  "mcpServers": {\n    "make-app-context": { "command": "node", "args": [${JSON.stringify(oldFile(home, 'cursor'))}] },\n    "other": { "command": "npx" },\n  }\n}\n`;
		const file = write(home, ['.cursor', 'mcp.json'], text);
		assert.deepEqual(detectLegacyInstall({ home }), [{ kind: 'mcp-entry', path: file, editor: 'cursor', name: 'make-app-context', format: 'jsonc' }]);
	});

	it('a Cursor mcp.json that is not JSON in either form gives no item', () => {
		const home = newHome();
		write(home, ['.cursor', 'mcp.json'], `{ "mcpServers": { "a": { "args": [${JSON.stringify(oldFile(home, 'cursor'))}] `);
		assert.deepEqual(detectLegacyInstall({ home }), []);
	});

	it('a Cursor entry with a .. segment in its old path is not an old install', () => {
		const home = newHome();
		write(home, ['.cursor', 'mcp.json'], JSON.stringify({ mcpServers: { a: { command: 'node', args: [`${home}/.cursor/skills/make-custom-app/../other/y.js`] } } }));
		assert.deepEqual(detectLegacyInstall({ home }), []);
	});

	it('the .env inside a skill folder is never an item', () => {
		const home = newHome();
		const claude = mkdir(home, '.claude', 'skills', 'make-custom-app');
		const cursor = mkdir(home, '.cursor', 'skills', 'make-custom-app');
		for (const dir of [claude, cursor]) write(dir, ['mcp-server', '.env'], `PINECONE_API_KEY=${FAKE.pinecone}\n`);
		const items = detectLegacyInstall({ home });
		assert.deepEqual(items.map((item) => item.path), [claude, cursor]);
		assert.ok(items.every((item) => !item.path.endsWith('.env')));
		assert.ok(!JSON.stringify(items).includes(FAKE.pinecone));
	});

	it('does not list a make-custom-app entry that is a hand registration, with no path into an old folder', () => {
		const home = newHome();
		for (const entry of [{ command: 'node' }, { command: 'npx', args: ['-y', 'some-server'] }, { url: 'https://example.com/mcp' }, null, 'text']) {
			write(home, ['.claude.json'], JSON.stringify({ mcpServers: { 'make-custom-app': entry } }));
			assert.deepEqual(detectLegacyInstall({ home }), [], JSON.stringify(entry));
		}
	});

	it('reads mcp-server-path from the secrets file: the last usable line wins', () => {
		const home = newHome();
		const registration = (dir) => write(home, ['.claude.json'], JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node', args: [path.join(dir, 'dist', 'index.js')] } } }));
		const a = path.join(home, 'clone-a', 'mcp-server');
		const b = path.join(home, 'clone-b', 'mcp-server');
		write(home, ['.make-custom-app-skill-secrets'], `mcp-server-path: ${a}\nmcp-server-path:   ${b}  \r\nmcp-server-path: /path/to/mcp-server\n`);
		registration(b);
		assert.equal(detectLegacyInstall({ home }).length, 1);
		registration(a);
		assert.deepEqual(detectLegacyInstall({ home }), []);
		write(home, ['.make-custom-app-skill-secrets'], 'jira-email: x@y.z\n');
		registration(b);
		assert.deepEqual(detectLegacyInstall({ home }), []);
		fs.rmSync(path.join(home, '.make-custom-app-skill-secrets'));
		assert.deepEqual(detectLegacyInstall({ home }), []);
	});

	it('an explicit mcpServerPath replaces the secrets file, and null or an empty string turns it off', () => {
		const home = newHome();
		const folder = path.join(home, 'clone', 'mcp-server');
		write(home, ['.claude.json'], JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node', args: [path.join(folder, 'dist', 'index.js')] } } }));
		assert.equal(detectLegacyInstall({ home, mcpServerPath: folder }).length, 1);
		write(home, ['.make-custom-app-skill-secrets'], `mcp-server-path: ${folder}\n`);
		assert.equal(detectLegacyInstall({ home }).length, 1);
		assert.deepEqual(detectLegacyInstall({ home, mcpServerPath: null }), []);
		assert.deepEqual(detectLegacyInstall({ home, mcpServerPath: '' }), []);
		assert.deepEqual(detectLegacyInstall({ home, mcpServerPath: path.join(home, 'other') }), []);
	});
});

describe('detectLegacyInstall: the plugin own registration is never old', () => {
	const oldFile = (home, editor = 'claude') => path.join(home, `.${editor}`, 'skills', 'make-custom-app', 'mcp-server', 'dist', 'index.js');
	const cachePlugin = (home) => mkdir(home, '.claude', 'plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0');
	const registerClaude = (home, ...args) => write(home, ['.claude.json'], JSON.stringify({ mcpServers: { 'make-custom-app': { command: process.execPath, args } } }));

	it('is not old, whatever folder mcp-server-path names at or above the plugin', () => {
		const home = newHome();
		const pluginRoot = cachePlugin(home);
		registerClaude(home, path.join(pluginRoot, 'mcp', 'index.mjs'));
		const folders = [
			home,
			path.join(home, '.claude'),
			path.join(home, '.claude', 'plugins'),
			path.join(home, '.claude', 'plugins', 'cache'),
			path.dirname(pluginRoot),
			pluginRoot,
			path.join(pluginRoot, 'mcp'),
			`${pluginRoot}/mcp/..`,
			`${path.dirname(pluginRoot)}/..`,
			`${home}/.claude/..`,
		];
		for (const folder of folders) {
			assert.deepEqual(detectLegacyInstall({ home, pluginRoot, mcpServerPath: folder }), [], folder);
			write(home, ['.make-custom-app-skill-secrets'], `mcp-server-path: ${folder}\n`);
			assert.deepEqual(detectLegacyInstall({ home, pluginRoot }), [], folder);
		}
	});

	it('an mcp-server-path with a .. segment makes no registration old, from the secrets file or as a parameter', () => {
		const home = newHome();
		const folder = `${home}/clone/mcp-server/..`;
		registerClaude(home, path.join(home, 'clone', 'other', 'x.js'));
		assert.deepEqual(detectLegacyInstall({ home, mcpServerPath: folder }), []);
		write(home, ['.make-custom-app-skill-secrets'], `mcp-server-path: ${folder}\n`);
		assert.deepEqual(detectLegacyInstall({ home }), []);
	});

	it('a real old registration still counts when mcp-server-path is an ancestor and the plugin lives elsewhere', () => {
		const home = newHome();
		const pluginRoot = cachePlugin(home);
		const clone = path.join(home, 'clone', 'mcp-server');
		registerClaude(home, path.join(clone, 'dist', 'index.js'));
		for (const folder of [clone, path.join(home, 'clone'), home]) assert.equal(detectLegacyInstall({ home, pluginRoot, mcpServerPath: folder }).length, 1, folder);
		registerClaude(home, oldFile(home));
		for (const folder of [undefined, null, home, pluginRoot]) assert.equal(detectLegacyInstall({ home, pluginRoot, mcpServerPath: folder }).length, 1, String(folder));
	});

	it('a registration with the plugin bundle next to an old path is still old because of the old path', () => {
		const home = newHome();
		const pluginRoot = cachePlugin(home);
		registerClaude(home, path.join(pluginRoot, 'mcp', 'index.mjs'), oldFile(home));
		assert.equal(detectLegacyInstall({ home, pluginRoot, mcpServerPath: home }).length, 1);
	});

	it('is not old when the plugin folder is spelled through a symbolic link, in either direction', () => {
		const home = newHome();
		const real = mkdir(home, 'real-claude', 'plugins', 'cache', 'p', 'p', '3.0.0');
		const link = path.join(home, 'linked-claude');
		fs.symlinkSync(path.join(home, 'real-claude'), link);
		const viaLink = path.join(link, 'plugins', 'cache', 'p', 'p', '3.0.0');
		registerClaude(home, path.join(viaLink, 'mcp', 'index.mjs'));
		for (const folder of [home, link]) assert.deepEqual(detectLegacyInstall({ home, pluginRoot: real, mcpServerPath: folder }), [], folder);
		registerClaude(home, path.join(real, 'mcp', 'index.mjs'));
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot: viaLink, mcpServerPath: home }), []);
	});

	it('is not old when the plugin root sits in a folder that looks like the old skill, for Claude and for Cursor', () => {
		const home = newHome();
		const pluginRoot = mkdir(home, 'dev', 'skills', 'make-custom-app');
		registerClaude(home, path.join(pluginRoot, 'mcp-server', 'dist', 'index.js'));
		write(home, ['.cursor', 'mcp.json'], JSON.stringify({ mcpServers: { x: { command: 'node', args: [path.join(pluginRoot, 'mcp-server', 'dist', 'index.js')] } } }));
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot }), []);
		assert.equal(detectLegacyInstall({ home, pluginRoot: path.join(home, 'elsewhere') }).length, 2);
	});

	it('an entry that points into a skills-dir plugin named make-custom-app is not old, for Claude and for Cursor', () => {
		const home = newHome();
		const claude = mkdir(home, '.claude', 'skills', 'make-custom-app');
		mkdir(claude, '.claude-plugin');
		registerClaude(home, path.join(claude, 'mcp', 'index.mjs'));
		const cursor = mkdir(home, '.cursor', 'skills', 'make-custom-app');
		mkdir(cursor, '.cursor-plugin');
		write(home, ['.cursor', 'mcp.json'], JSON.stringify({ mcpServers: { x: { command: 'node', args: [path.join(cursor, 'mcp', 'index.mjs')] } } }));
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot: path.join(home, 'elsewhere') }), []);
	});

	it('an old Cursor entry is still found next to the plugin entry', () => {
		const home = newHome();
		const pluginRoot = cachePlugin(home);
		const file = write(home, ['.cursor', 'mcp.json'], JSON.stringify({ mcpServers: { plugin: { command: 'node', args: [path.join(pluginRoot, 'mcp', 'index.mjs')] }, old: { command: 'node', args: [oldFile(home, 'cursor')] } } }));
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot }), [{ kind: 'mcp-entry', path: file, editor: 'cursor', name: 'old', format: 'json' }]);
	});

	it('needs a pluginRoot string when it is given at all, and falls back to the running plugin without one', () => {
		const home = newHome();
		for (const bad of [null, '', 5, {}]) assert.throws(() => detectLegacyInstall({ home, pluginRoot: bad }), { name: 'TypeError', message: 'detectLegacyInstall needs pluginRoot' }, String(bad));
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot: undefined }), []);
		assert.deepEqual(detectLegacyInstall({ home }), []);
	});

	it('a plugin folder whose name starts with two dots is inside the skill folder, and a skill folder is not inside its parent', () => {
		const home = newHome();
		const claude = mkdir(home, '.claude', 'skills', 'make-custom-app');
		const inner = mkdir(claude, '..plugin');
		assert.equal(isLookalikeSkillDir(claude, inner), true);
		assert.deepEqual(detectLegacyInstall({ home, pluginRoot: inner }), []);
		assert.equal(isLookalikeSkillDir(inner, claude), false);
		assert.equal(isLookalikeSkillDir(claude, path.dirname(claude)), false);
	});
});

describe('buildFakeLegacyHome', () => {
	const WINDOWS = { skip: process.platform === 'win32' };
	let cases = 0;
	const makeRoot = () => path.join(TEST_ROOT, `case-${++cases}`);
	const pluginRoot = path.join(TEST_ROOT, 'plugin-root');
	const build = (options = {}) => buildFakeLegacyHome({ root: makeRoot(), pluginRoot, ...options });
	const keysOf = (items) => items.map((item) => `${item.editor}:${item.kind}`);
	const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
	const modeOf = (file) => fs.statSync(file).mode & 0o777;

	it('buildFakeLegacyHome writes what detectLegacyInstall finds: six items with both editors, three with one; it refuses a root outside TEST_ROOT', () => {
		const both = build();
		assert.deepEqual(keysOf(detectLegacyInstall({ home: both.home, pluginRoot })), ['claude:skill-dir', 'claude:sentinel', 'claude:mcp-entry', 'cursor:skill-dir', 'cursor:rules-dir', 'cursor:mcp-entry']);
		const claudeOnly = build({ editors: ['claude'] });
		assert.deepEqual(keysOf(detectLegacyInstall({ home: claudeOnly.home, pluginRoot })), ['claude:skill-dir', 'claude:sentinel', 'claude:mcp-entry']);
		const cursorOnly = build({ editors: ['cursor'] });
		assert.deepEqual(keysOf(detectLegacyInstall({ home: cursorOnly.home, pluginRoot })), ['cursor:skill-dir', 'cursor:rules-dir', 'cursor:mcp-entry']);

		const outside = path.join(path.dirname(TEST_ROOT), `p5-outside-${process.pid}`);
		for (const root of [outside, TEST_ROOT, `${TEST_ROOT}/../p5-outside-dots`, `${TEST_ROOT}-evil/x`, 'relative-root', '']) {
			assert.throws(() => buildFakeLegacyHome({ root, pluginRoot }), TypeError, root);
		}
		assert.throws(() => buildFakeLegacyHome({ pluginRoot }), { message: 'buildFakeLegacyHome needs root' });
		assert.equal(fs.existsSync(outside), false);
		assert.equal(fs.existsSync(path.join(path.dirname(TEST_ROOT), 'p5-outside-dots')), false);
		assert.equal(fs.existsSync(`${TEST_ROOT}-evil`), false);
	});

	it('writes the files of a real install with the modes of a real install, and the fixed fake values', () => {
		const h = build();
		const { paths } = h;
		assert.equal(h.home, path.join(paths.root, 'home'));
		assert.equal(h.log, path.join(paths.root, 'claude-log.jsonl'));
		const claudeJson = readJson(paths.claudeJson);
		assert.deepEqual(Object.keys(claudeJson), ['numStartups', 'projects', 'mcpServers']);
		assert.deepEqual(Object.keys(claudeJson.mcpServers), ['other-server', 'make-custom-app']);
		assert.deepEqual(claudeJson.mcpServers['make-custom-app'], {
			command: process.execPath,
			args: [path.join(paths.claudeSkill, 'mcp-server', 'dist', 'index.js')],
			env: { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai, PINECONE_INDEX_NAME: FAKE.index },
		});
		assert.equal(claudeJson.mcpServers['other-server'].env.API_TOKEN, FAKE.otherToken);
		assert.equal(fs.readFileSync(paths.claudeJson, 'utf8'), `${JSON.stringify(claudeJson, null, 2)}\n`);
		const cursorJson = readJson(paths.cursorMcp);
		assert.equal(cursorJson.mcpServers['other-cursor'].env.TOKEN, FAKE.cursorToken);
		assert.deepEqual(cursorJson.mcpServers['make-app-context'].args, [path.join(paths.cursorSkill, 'mcp-server', 'dist', 'index.js')]);
		assert.equal(fs.readFileSync(paths.cursorMcp, 'utf8'), `${JSON.stringify(cursorJson, null, 2)}\n`);
		assert.equal(fs.readFileSync(paths.claudeMd, 'utf8'), `# My notes\n\nAlways invoke the \`make-custom-app\` skill for Make apps.\n\n${INSTALLER_BLOCK}\n`);
		assert.equal(fs.readFileSync(paths.claudeEnv, 'utf8'), `PINECONE_API_KEY=${FAKE.pinecone}\nOPENAI_API_KEY=${FAKE.openai}\nPINECONE_INDEX_NAME=${FAKE.index}\n`);
		assert.equal(fs.readFileSync(paths.secrets, 'utf8'), `pinecone-api-key: ${FAKE.pinecone}\nopenai-api-key: ${FAKE.openai}\npinecone-index-name: ${FAKE.index}\n`);
		for (const dir of [paths.claudeSkill, paths.cursorSkill]) {
			assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /^---\nname: make-custom-app\nversion: 2\.4\.0\n/);
			for (const rel of ['scripts/check-setup.js', 'mcp-server/dist/index.js', 'mcp-server/node_modules/fake/index.js', 'mcp-server/.env']) assert.ok(fs.statSync(path.join(dir, ...rel.split('/'))).isFile(), rel);
		}
		assert.ok(fs.statSync(path.join(paths.cursorRules, 'make-custom-app.mdc')).isFile());
		if (process.platform !== 'win32') {
			assert.equal(modeOf(paths.claudeJson), 0o600);
			assert.equal(modeOf(paths.claudeMd), 0o600);
			assert.equal(modeOf(paths.cursorMcp), 0o600);
			assert.equal(modeOf(paths.secrets), 0o600);
			assert.equal(modeOf(paths.claudeEnv), 0o644);
			assert.equal(modeOf(paths.cursorEnv), 0o644);
		}
		assert.deepEqual(h.env, {
			PATH: h.binDir,
			HOME: h.home,
			USERPROFILE: h.home,
			TMPDIR: paths.tmp,
			TEMP: paths.tmp,
			TMP: paths.tmp,
			CLAUDE_BIN: path.join(h.binDir, 'claude'),
			FAKE_CLAUDE_ROOT: paths.root,
			FAKE_CLAUDE_LOG: h.log,
			FAKE_CLAUDE_MODE: 'ok',
		});
		assert.ok(!h.log.startsWith(h.home + path.sep));
		assert.ok(fs.statSync(paths.tmp).isDirectory());
	});

	it('the paths it returns match oldInstallPaths of the home', () => {
		const h = build();
		const expected = oldInstallPaths(h.home);
		for (const [name, value] of Object.entries(expected)) assert.equal(h.paths[name], value, name);
	});

	it('writes the installer shape of the .env when it is given, comments and a blank line included', () => {
		assert.equal(INSTALLER_ENV_TEXT, `# Pinecone\nPINECONE_API_KEY=${FAKE.pinecone}\nPINECONE_INDEX_NAME=${FAKE.index}\n\n# OpenAI (for text-embedding-3-small)\nOPENAI_API_KEY=${FAKE.openai}\n`);
		const h = build({ envText: INSTALLER_ENV_TEXT });
		assert.equal(fs.readFileSync(h.paths.claudeEnv, 'utf8'), INSTALLER_ENV_TEXT);
		assert.equal(fs.readFileSync(h.paths.cursorEnv, 'utf8'), INSTALLER_ENV_TEXT);
	});

	it('writes the options: a CRLF-free CLAUDE.md without the own paragraph, an env text, a 0644 user file, and a link for the Claude skill', () => {
		const h = build({ editors: ['claude'], ownParagraph: false, envText: 'PINECONE_API_KEY=\n', claudeJsonMode: 0o644, symlinkSkill: true });
		assert.equal(fs.readFileSync(h.paths.claudeMd, 'utf8'), `# My notes\n\n${INSTALLER_BLOCK}\n`);
		assert.equal(fs.readFileSync(h.paths.claudeEnv, 'utf8'), 'PINECONE_API_KEY=\n');
		assert.equal(fs.lstatSync(h.paths.claudeSkill).isSymbolicLink(), true);
		assert.equal(fs.readlinkSync(h.paths.claudeSkill), h.paths.skillTarget);
		assert.ok(fs.statSync(path.join(h.paths.skillTarget, 'mcp-server', 'dist', 'index.js')).isFile());
		if (process.platform !== 'win32') assert.equal(modeOf(h.paths.claudeJson), 0o644);
		assert.ok(!fs.existsSync(h.paths.cursorSkill));
		assert.ok(!fs.existsSync(h.paths.cursorMcp));
		assert.deepEqual(keysOf(detectLegacyInstall({ home: h.home, pluginRoot })), ['claude:skill-dir', 'claude:sentinel', 'claude:mcp-entry']);
	});

	it('writes the three formats of the Cursor file', () => {
		const text = (cursorFormat) => fs.readFileSync(build({ editors: ['cursor'], cursorFormat }).paths.cursorMcp, 'utf8');
		const canonical = text('canonical');
		assert.equal(canonical, `${JSON.stringify(JSON.parse(canonical), null, 2)}\n`);
		const compact = text('compact');
		assert.equal(compact, JSON.stringify(JSON.parse(compact)));
		assert.ok(!compact.includes('\n'));
		const jsonc = text('jsonc');
		assert.ok(jsonc.startsWith('{\n  // a comment of the user\n  "mcpServers"'), jsonc);
		const withoutComment = jsonc.replace('  // a comment of the user\n', '');
		assert.equal(withoutComment, `${JSON.stringify(JSON.parse(withoutComment), null, 2)}\n`);
		const h = build({ editors: ['cursor'], cursorFormat: 'jsonc' });
		const read = readMcpConfig(h.paths.cursorMcp);
		assert.equal(read.format, 'jsonc');
		assert.deepEqual(Object.keys(read.servers), ['other-cursor', 'make-app-context']);
		assert.equal(readMcpConfig(build({ editors: ['cursor'], cursorFormat: 'compact' }).paths.cursorMcp).format, 'json');
	});

	it('writes the plugin state: enabled, disabled, project-only, absent', () => {
		const id = 'make-custom-app@make-custom-app';
		const record = (h) => readJson(h.paths.installedPlugins);
		const enabled = build();
		assert.deepEqual(record(enabled), {
			version: 2,
			plugins: { [id]: [{ scope: 'user', installPath: pluginRoot, version: '3.0.0', installedAt: '2026-10-01T00:00:00.000Z', lastUpdated: '2026-10-01T00:00:00.000Z', gitCommitSha: '0'.repeat(40) }] },
		});
		assert.deepEqual(readJson(enabled.paths.settingsJson), { enabledPlugins: { [id]: true } });
		const disabled = build({ pluginState: 'disabled' });
		assert.equal(record(disabled).plugins[id][0].scope, 'user');
		assert.deepEqual(readJson(disabled.paths.settingsJson), { enabledPlugins: { [id]: false } });
		assert.equal(record(build({ pluginState: 'project-only' })).plugins[id][0].scope, 'project');
		const absent = buildFakeLegacyHome({ root: makeRoot(), pluginState: 'absent' });
		assert.equal(fs.existsSync(absent.paths.installedPlugins), false);
		assert.equal(fs.existsSync(absent.paths.settingsJson), false);
		assert.ok(!fs.existsSync(pluginRoot));
	});

	it('writes the secrets variants: same, missing, conflict, and the mcp-server-path line', () => {
		const text = (options) => fs.readFileSync(build(options).paths.secrets, 'utf8');
		assert.equal(text({ secrets: 'missing' }), 'editor: claude\n');
		assert.equal(text({ secrets: 'conflict' }), `pinecone-api-key: ${FAKE.conflictPinecone}\nopenai-api-key: ${FAKE.openai}\npinecone-index-name: ${FAKE.index}\n`);
		const h = build({ claudeEntry: 'mcp-server-path' });
		const folder = path.join(h.paths.root, 'clone', 'mcp-server');
		assert.equal(fs.readFileSync(h.paths.secrets, 'utf8'), `pinecone-api-key: ${FAKE.pinecone}\nopenai-api-key: ${FAKE.openai}\npinecone-index-name: ${FAKE.index}\nmcp-server-path: ${folder}\n`);
		assert.deepEqual(readJson(h.paths.claudeJson).mcpServers['make-custom-app'].args, [path.join(folder, 'dist', 'index.js')]);
	});

	it('refuses wrong options and a missing pluginRoot', () => {
		const root = makeRoot();
		assert.throws(() => buildFakeLegacyHome({ root, pluginRoot, editors: ['vim'] }), /editors/);
		assert.throws(() => buildFakeLegacyHome({ root, pluginRoot, editors: 'claude' }), /editors/);
		for (const name of ['pluginState', 'secrets', 'cursorFormat', 'claudeMode', 'claudeEntry']) assert.throws(() => buildFakeLegacyHome({ root, pluginRoot, [name]: 'nope' }), new RegExp(name));
		assert.throws(() => buildFakeLegacyHome({ root }), { message: 'buildFakeLegacyHome needs pluginRoot' });
		assert.throws(() => buildFakeLegacyHome({ root, pluginState: 'absent', claudeEntry: 'plugin-bundle' }), { message: 'buildFakeLegacyHome needs pluginRoot' });
		assert.throws(() => buildFakeLegacyHome(), { message: 'buildFakeLegacyHome needs root' });
	});

	it('detectLegacyInstall lists the Claude entry for an old skill path and for a path under mcp-server-path, and not for the plugin bundle or an unrelated path', () => {
		const claudeEntry = (options) => {
			const h = build({ editors: ['claude'], ...options });
			return detectLegacyInstall({ home: h.home, pluginRoot }).filter((item) => item.kind === 'mcp-entry').length;
		};
		assert.equal(claudeEntry({ claudeEntry: 'old' }), 1);
		assert.equal(claudeEntry({ claudeEntry: 'mcp-server-path' }), 1);
		assert.equal(claudeEntry({ claudeEntry: 'plugin-bundle' }), 0);
		assert.equal(claudeEntry({ claudeEntry: 'unrelated' }), 0);
		const bundle = build({ editors: ['claude'], claudeEntry: 'plugin-bundle' });
		assert.deepEqual(readJson(bundle.paths.claudeJson).mcpServers['make-custom-app'].args, [path.join(pluginRoot, 'mcp', 'index.mjs')]);
		assert.deepEqual(keysOf(detectLegacyInstall({ home: bundle.home, pluginRoot })), ['claude:skill-dir', 'claude:sentinel']);
		const lone = build({ editors: ['claude'], claudeEntry: 'mcp-server-path' });
		assert.deepEqual(keysOf(detectLegacyInstall({ home: lone.home, pluginRoot, mcpServerPath: null })), ['claude:skill-dir', 'claude:sentinel']);
	});

	describe('the fake claude', WINDOWS, () => {
		const REMOVE = ['mcp', 'remove', 'make-custom-app', '--scope', 'user'];
		const run = (h, args, overrides = {}) => {
			const result = spawnSync(h.paths.claudeBin, args, { cwd: h.home, env: { ...h.env, ...overrides }, encoding: 'utf8' });
			return { status: result.status, stdout: result.stdout, stderr: result.stderr };
		};
		const serverNames = (file) => Object.keys(readJson(file).mcpServers);
		const logLines = (h) => fs.readFileSync(h.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

		it('the fake claude refuses with exit 97 when HOME, or a set CLAUDE_CONFIG_DIR, is outside FAKE_CLAUDE_ROOT and leaves that folder unchanged', () => {
			const h = build();
			const outside = path.join(TEST_ROOT, `outside-${cases}`);
			fs.mkdirSync(path.join(outside, 'config'), { recursive: true });
			fs.writeFileSync(path.join(outside, '.claude.json'), JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node' } } }));
			fs.writeFileSync(path.join(outside, 'config', '.claude.json'), JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node' } } }));
			const evilRoot = `${h.paths.root}-evil`;
			fs.mkdirSync(path.join(evilRoot, 'config'), { recursive: true });
			for (const file of [path.join(evilRoot, '.claude.json'), path.join(evilRoot, 'config', '.claude.json')]) fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node' } } }));
			const before = snapshot(outside);
			const evilBefore = snapshot(evilRoot);
			const homeBefore = snapshot(h.home);
			const refuse = (overrides, message) => {
				const r = run(h, REMOVE, overrides);
				assert.deepEqual(r, { status: 97, stdout: '', stderr: `fake claude: ${message}; refusing\n` }, JSON.stringify(overrides));
			};
			refuse({ HOME: outside, USERPROFILE: outside }, 'HOME is outside FAKE_CLAUDE_ROOT');
			refuse({ CLAUDE_CONFIG_DIR: path.join(outside, 'config') }, 'CLAUDE_CONFIG_DIR is outside FAKE_CLAUDE_ROOT');
			refuse({ CLAUDE_CONFIG_DIR: `${h.paths.root}/../${path.basename(outside)}/config` }, 'CLAUDE_CONFIG_DIR is outside FAKE_CLAUDE_ROOT');
			refuse({ HOME: `${h.home}/../home` }, 'HOME is outside FAKE_CLAUDE_ROOT');
			refuse({ HOME: '' }, 'HOME is outside FAKE_CLAUDE_ROOT');
			refuse({ FAKE_CLAUDE_ROOT: '' }, 'HOME is outside FAKE_CLAUDE_ROOT');
			refuse({ FAKE_CLAUDE_ROOT: path.dirname(TEST_ROOT), HOME: h.home }, 'FAKE_CLAUDE_ROOT is outside the test root');
			refuse({ FAKE_CLAUDE_LOG: path.join(outside, 'log.jsonl') }, 'FAKE_CLAUDE_LOG is outside FAKE_CLAUDE_ROOT');
			refuse({ FAKE_CLAUDE_LOG: 'relative.jsonl' }, 'FAKE_CLAUDE_LOG is outside FAKE_CLAUDE_ROOT');
			const link = path.join(h.paths.root, 'link-out');
			fs.symlinkSync(outside, link);
			refuse({ HOME: link, USERPROFILE: link }, 'HOME is outside FAKE_CLAUDE_ROOT');
			refuse({ HOME: evilRoot, USERPROFILE: evilRoot }, 'HOME is outside FAKE_CLAUDE_ROOT');
			refuse({ HOME: `${evilRoot}/home`, USERPROFILE: `${evilRoot}/home` }, 'HOME is outside FAKE_CLAUDE_ROOT');
			refuse({ CLAUDE_CONFIG_DIR: `${evilRoot}/config` }, 'CLAUDE_CONFIG_DIR is outside FAKE_CLAUDE_ROOT');
			const evilTestRoot = `${TEST_ROOT}-evil/root`;
			refuse({ FAKE_CLAUDE_ROOT: evilTestRoot, HOME: `${evilTestRoot}/home`, FAKE_CLAUDE_LOG: `${evilTestRoot}/log.jsonl` }, 'FAKE_CLAUDE_ROOT is outside the test root');
			const planted = path.join(outside, 'planted.jsonl');
			const dangling = path.join(h.paths.root, 'log-link');
			fs.symlinkSync(planted, dangling);
			refuse({ FAKE_CLAUDE_LOG: dangling }, 'FAKE_CLAUDE_LOG is outside FAKE_CLAUDE_ROOT');
			assert.equal(fs.existsSync(planted), false);
			assert.equal(fs.existsSync(`${TEST_ROOT}-evil`), false);
			assert.deepEqual(diffSnapshots(evilBefore, snapshot(evilRoot)), []);
			assert.deepEqual(diffSnapshots(before, snapshot(outside)), []);
			assert.deepEqual(diffSnapshots(homeBefore, snapshot(h.home)), []);
			assert.equal(fs.existsSync(h.log), false);
			assert.equal(fs.existsSync(path.join(outside, 'log.jsonl')), false);
		});

		it('refuses when the user file is a symbolic link, and fails clearly on an unknown mode, a file that is not JSON, and an unwritable log', () => {
			const h = build();
			const target = path.join(h.paths.root, 'real-user-file.json');
			fs.renameSync(h.paths.claudeJson, target);
			fs.symlinkSync(target, h.paths.claudeJson);
			assert.deepEqual(run(h, REMOVE), { status: 97, stdout: '', stderr: 'fake claude: the user file is a symbolic link; refusing\n' });
			fs.rmSync(h.paths.claudeJson);
			fs.writeFileSync(h.paths.claudeJson, '{ not json');
			assert.deepEqual(run(h, REMOVE), { status: 1, stdout: '', stderr: 'fake claude: the user file is not valid JSON\n' });
			assert.deepEqual(run(h, ['--version'], { FAKE_CLAUDE_MODE: 'weird' }), { status: 2, stdout: '', stderr: 'fake claude: unknown FAKE_CLAUDE_MODE\n' });
			fs.mkdirSync(path.join(h.paths.root, 'a-folder'));
			assert.deepEqual(run(h, ['--version'], { FAKE_CLAUDE_LOG: path.join(h.paths.root, 'a-folder') }), { status: 2, stdout: '', stderr: 'fake claude: unexpected error (EISDIR)\n' });
		});

		it('the fake claude keeps the mode of ~/.claude.json when it removes or adds an entry', () => {
			for (const mode of [0o600, 0o644]) {
				const h = build({ claudeJsonMode: mode });
				const entry = readJson(h.paths.claudeJson).mcpServers['make-custom-app'];
				assert.equal(run(h, REMOVE).status, 0);
				assert.equal(modeOf(h.paths.claudeJson), mode);
				assert.equal(run(h, ['mcp', 'add-json', 'make-custom-app', JSON.stringify(entry), '--scope', 'user']).status, 0);
				assert.equal(modeOf(h.paths.claudeJson), mode);
				assert.deepEqual(fs.readdirSync(h.home).filter((name) => name.includes('.tmp')), []);
			}
		});

		it('the fake claude removes and re-adds the Claude entry and logs its argv outside HOME', () => {
			const h = build();
			const before = readJson(h.paths.claudeJson);
			assert.deepEqual(run(h, ['--version']), { status: 0, stdout: '2.1.312 (Claude Code)\n', stderr: '' });

			const removed = run(h, REMOVE);
			assert.deepEqual(removed, { status: 0, stdout: `Removed MCP server make-custom-app from user config\nFile modified: ${h.paths.claudeJson}\n`, stderr: '' });
			const afterRemove = readJson(h.paths.claudeJson);
			assert.deepEqual(Object.keys(afterRemove.mcpServers), ['other-server']);
			assert.deepEqual({ ...afterRemove, mcpServers: null }, { ...before, mcpServers: null });
			assert.deepEqual(afterRemove.mcpServers['other-server'], before.mcpServers['other-server']);
			assert.equal(fs.readFileSync(h.paths.claudeJson, 'utf8'), `${JSON.stringify(afterRemove, null, 2)}\n`);

			assert.deepEqual(run(h, REMOVE), { status: 1, stdout: '', stderr: 'No MCP server named "make-custom-app" in user scope\n' });

			const entry = before.mcpServers['make-custom-app'];
			const added = run(h, ['mcp', 'add-json', 'make-custom-app', JSON.stringify(entry), '--scope', 'user'], { CLAUDECODE: '1' });
			assert.deepEqual(added, { status: 0, stdout: 'Added stdio MCP server make-custom-app to user config\n', stderr: '' });
			const afterAdd = readJson(h.paths.claudeJson);
			assert.deepEqual(Object.keys(afterAdd.mcpServers), ['other-server', 'make-custom-app']);
			assert.deepEqual(afterAdd, before);

			assert.deepEqual(run(h, ['mcp', 'add-json', 'x', '{ not json', '--scope', 'user']), { status: 1, stdout: '', stderr: 'fake claude: the entry is not valid JSON\n' });
			for (const args of [['plugin', 'list'], ['mcp', 'list'], ['mcp', 'remove', 'make-custom-app'], ['mcp', 'remove', 'make-custom-app', '--scope', 'project'], []]) {
				assert.deepEqual(run(h, args), { status: 2, stdout: '', stderr: 'unexpected command\n' }, JSON.stringify(args));
			}

			const lines = logLines(h);
			assert.deepEqual(lines.slice(0, 5), [
				{ argv: ['--version'], claudecode: false },
				{ argv: REMOVE, claudecode: false },
				{ argv: REMOVE, claudecode: false },
				{ argv: ['mcp', 'add-json', 'make-custom-app', JSON.stringify(entry), '--scope', 'user'], claudecode: true },
				{ argv: ['mcp', 'add-json', 'x', '{ not json', '--scope', 'user'], claudecode: false },
			]);
			assert.ok(!h.log.startsWith(h.home + path.sep));
			assert.ok(h.log.startsWith(h.paths.root + path.sep));
		});

		it('adds an entry to a user file that does not exist yet with mode 0600, and acts on the file in CLAUDE_CONFIG_DIR when it is set inside the root', () => {
			const h = build({ editors: ['cursor'] });
			assert.equal(fs.existsSync(h.paths.claudeJson), false);
			assert.equal(run(h, REMOVE).status, 1);
			assert.equal(run(h, ['mcp', 'add-json', 'make-custom-app', '{"command":"node"}', '--scope', 'user']).status, 0);
			assert.deepEqual(readJson(h.paths.claudeJson), { mcpServers: { 'make-custom-app': { command: 'node' } } });
			assert.equal(modeOf(h.paths.claudeJson), 0o600);

			const config = path.join(h.paths.root, 'config-dir');
			fs.mkdirSync(config);
			const homeBefore = snapshot(h.home);
			assert.equal(run(h, ['mcp', 'add-json', 'probe', '{"command":"node"}', '--scope', 'user'], { CLAUDE_CONFIG_DIR: config }).status, 0);
			assert.deepEqual(readJson(path.join(config, '.claude.json')), { mcpServers: { probe: { command: 'node' } } });
			assert.deepEqual(diffSnapshots(homeBefore, snapshot(h.home)), []);
		});

		it('the fail mode fails every mcp command and changes nothing; the echo-secrets mode prints the removed entry', () => {
			const failing = build({ claudeMode: 'fail' });
			const before = snapshot(failing.home);
			assert.deepEqual(run(failing, REMOVE), { status: 1, stdout: '', stderr: 'simulated failure\n' });
			assert.deepEqual(run(failing, ['mcp', 'add-json', 'a', '{}', '--scope', 'user']), { status: 1, stdout: '', stderr: 'simulated failure\n' });
			assert.equal(run(failing, ['--version']).status, 0);
			assert.deepEqual(diffSnapshots(before, snapshot(failing.home)), []);

			const echo = build({ claudeMode: 'echo-secrets' });
			const r = run(echo, REMOVE);
			assert.equal(r.status, 0);
			for (const stream of [r.stdout, r.stderr]) assert.ok(stream.includes(FAKE.pinecone) && stream.includes(FAKE.openai), stream);
			assert.deepEqual(serverNames(echo.paths.claudeJson), ['other-server']);
		});

		it('the none mode leaves no binary, and CLAUDE_BIN names a path that does not exist', () => {
			const h = build({ claudeMode: 'none' });
			assert.equal(h.env.CLAUDE_BIN, path.join(h.binDir, 'claude'));
			assert.equal(fs.existsSync(h.env.CLAUDE_BIN), false);
			assert.deepEqual(fs.readdirSync(h.binDir), []);
			assert.equal(h.env.FAKE_CLAUDE_MODE, 'none');
		});

		it('starts with the shebang of the running node, or a shell line when that path is long or has a space', () => {
			const h = build();
			const source = fs.readFileSync(h.paths.claudeBin, 'utf8');
			const fits = !/\s/.test(process.execPath) && process.execPath.length <= 100;
			assert.ok(source.startsWith(fits ? `#!${process.execPath}\n'use strict';` : '#!/bin/sh\n'), source.slice(0, 120));
			assert.equal(modeOf(h.paths.claudeBin), 0o755);
		});
	});

	describe('startWriter, snapshot, and diffSnapshots', () => {
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		async function until(check, what) {
			for (let i = 0; i < 400; i++) {
				if (check()) return;
				await wait(10);
			}
			assert.fail(`timed out waiting for ${what}`);
		}
		const readJson = (file) => {
			try {
				return JSON.parse(fs.readFileSync(file, 'utf8'));
			} catch {
				return {};
			}
		};
		const hasKey = (file) => Object.hasOwn(readJson(file).mcpServers ?? {}, 'make-custom-app');
		const entry = { command: 'node', args: ['/x.js'] };

		function userFile() {
			const h = buildFakeLegacyHome({ root: path.join(TEST_ROOT, `writer-${++n}`), pluginState: 'absent', editors: ['claude'] });
			return h.paths.claudeJson;
		}

		function removeKey(file) {
			const data = readJson(file);
			if (!data.mcpServers) return;
			delete data.mcpServers['make-custom-app'];
			fs.writeFileSync(`${file}.test.tmp`, `${JSON.stringify(data)}\n`);
			fs.renameSync(`${file}.test.tmp`, file);
		}

		it('startWriter in counter mode rewrites the file, keeps its mode and content, and reports its writes', async () => {
			const file = userFile();
			const before = readJson(file);
			const writer = startWriter({ file });
			await until(() => readJson(file).writerCounter >= 5, 'five writes');
			const { writes } = await writer.stop();
			assert.ok(writes >= 5, `writes ${writes}`);
			assert.deepEqual(await writer.stop(), { writes });
			const after = readJson(file);
			assert.equal(after.writerCounter, writes);
			assert.deepEqual({ ...after, writerCounter: undefined }, { ...before, writerCounter: undefined });
			if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
			assert.equal(fs.existsSync(`${file}.writer.tmp`), false);
		});

		it('startWriter leaves a file that does not parse or is not an object alone', async () => {
			const file = path.join(TEST_ROOT, `writer-plain-${++n}.json`);
			const writer = startWriter({ file });
			for (const text of ['{ not json', '[]', 'null']) {
				fs.writeFileSync(file, text);
				await wait(60);
				assert.equal(fs.readFileSync(file, 'utf8'), text);
			}
			assert.deepEqual(await writer.stop(), { writes: 0 });
			fs.rmSync(file);
		});

		it('startWriter in resurrect-always mode puts the entry back every time it is removed', async () => {
			const file = userFile();
			const writer = startWriter({ file, mode: 'resurrect-always', entry });
			try {
				for (let round = 0; round < 3; round++) {
					await until(() => hasKey(file), 'the entry');
					removeKey(file);
					await until(() => hasKey(file), 'the entry to come back');
				}
			} finally {
				await writer.stop();
			}
		});

		it('startWriter in resurrect-once mode puts the entry back once, and also creates mcpServers when it is missing', async () => {
			const file = userFile();
			const writer = startWriter({ file, mode: 'resurrect-once', entry });
			try {
				await until(() => hasKey(file), 'the entry');
				removeKey(file);
				await until(() => hasKey(file), 'the entry to come back');
				let stayed = false;
				for (let attempt = 0; attempt < 6 && !stayed; attempt++) {
					await until(() => hasKey(file), 'the entry');
					removeKey(file);
					const mark = readJson(file).writerCounter ?? 0;
					await until(() => (readJson(file).writerCounter ?? 0) >= mark + 8, 'eight more writes');
					stayed = !hasKey(file);
				}
				assert.ok(stayed, 'the entry came back every time');
			} finally {
				await writer.stop();
			}
			const bare = path.join(TEST_ROOT, `writer-bare-${++n}.json`);
			fs.writeFileSync(bare, '{}\n');
			const second = startWriter({ file: bare, mode: 'resurrect-once', entry });
			try {
				await until(() => hasKey(bare), 'the entry in a file with no mcpServers');
			} finally {
				await second.stop();
			}
			assert.deepEqual(readJson(bare).mcpServers['make-custom-app'], entry);
			fs.rmSync(bare);
		});

		it('startWriter checks its arguments', () => {
			const inside = path.join(TEST_ROOT, 'writer-args.json');
			assert.throws(() => startWriter(), /file must lie inside TEST_ROOT/);
			assert.throws(() => startWriter({ file: path.join(path.dirname(TEST_ROOT), 'outside.json') }), /file must lie inside TEST_ROOT/);
			assert.throws(() => startWriter({ file: 'relative.json' }), /file must lie inside TEST_ROOT/);
			assert.throws(() => startWriter({ file: `${TEST_ROOT}-evil/x.json` }), /file must lie inside TEST_ROOT/);
			assert.throws(() => startWriter({ file: `${TEST_ROOT}/../outside.json` }), /file must lie inside TEST_ROOT/);
			assert.throws(() => startWriter({ file: inside, mode: 'sometimes' }), /mode must be one of/);
			assert.throws(() => startWriter({ file: inside, mode: 'resurrect-once' }), { message: 'startWriter needs entry' });
			assert.throws(() => startWriter({ file: inside, intervalMs: 0 }), /intervalMs/);
		});

		it('snapshot and diffSnapshots report a content change, a mode change, an added and a removed path, a type change, and a changed link', () => {
			const dir = path.join(TEST_ROOT, `snap-${++n}`);
			fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
			fs.mkdirSync(path.join(dir, 'skip-me'));
			fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
			fs.writeFileSync(path.join(dir, 'b.txt'), 'two');
			fs.writeFileSync(path.join(dir, 'c.txt'), 'three');
			fs.writeFileSync(path.join(dir, 'sub', 'deep', 'd.txt'), 'four');
			fs.writeFileSync(path.join(dir, 'skip-me', 'e.txt'), 'five');
			fs.symlinkSync('a.txt', path.join(dir, 'link'));
			fs.chmodSync(path.join(dir, 'a.txt'), 0o600);
			fs.chmodSync(path.join(dir, 'b.txt'), 0o644);
			const before = snapshot(dir, { exclude: ['skip-me'] });
			assert.deepEqual([...before.keys()], ['a.txt', 'b.txt', 'c.txt', 'link', 'sub', 'sub/deep', 'sub/deep/d.txt']);
			assert.deepEqual(before.get('a.txt'), { type: 'file', mode: 0o600, sha256: before.get('a.txt').sha256, linkTarget: null });
			assert.match(before.get('a.txt').sha256, /^[0-9a-f]{64}$/);
			assert.deepEqual(before.get('link'), { type: 'symlink', mode: before.get('link').mode, sha256: null, linkTarget: 'a.txt' });
			assert.deepEqual(before.get('sub'), { type: 'dir', mode: before.get('sub').mode, sha256: null, linkTarget: null });
			assert.deepEqual(diffSnapshots(before, snapshot(dir, { exclude: ['skip-me'] })), []);

			fs.writeFileSync(path.join(dir, 'a.txt'), 'uno');
			fs.chmodSync(path.join(dir, 'b.txt'), 0o640);
			fs.rmSync(path.join(dir, 'c.txt'));
			fs.writeFileSync(path.join(dir, 'new.txt'), 'new');
			fs.rmSync(path.join(dir, 'link'));
			fs.symlinkSync('b.txt', path.join(dir, 'link'));
			fs.rmSync(path.join(dir, 'sub', 'deep', 'd.txt'));
			fs.mkdirSync(path.join(dir, 'sub', 'deep', 'd.txt'));
			const after = snapshot(dir, { exclude: ['skip-me'] });
			assert.deepEqual(diffSnapshots(before, after), [
				'changed a.txt: content',
				'changed b.txt: mode 644 -> 640',
				'removed c.txt',
				'changed link: link target',
				'added new.txt',
				`changed sub/deep/d.txt: type file -> dir, mode ${before.get('sub/deep/d.txt').mode.toString(8)} -> ${after.get('sub/deep/d.txt').mode.toString(8)}, content`,
			]);
			assert.ok(snapshot(dir).has('skip-me/e.txt'));
		});
	});
});
