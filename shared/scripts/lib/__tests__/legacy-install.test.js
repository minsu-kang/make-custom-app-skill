/**
 * Tests for legacy-install.js. Every test builds a fake home folder and passes it in, so nothing reads the real HOME.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectLegacyInstall, legacyInstallLines } = require('../legacy-install');

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

	function oldServerPath(home) {
		return path.join(home, '.cursor', 'skills', 'make-custom-app', 'mcp-server', 'dist', 'index.js');
	}

	it('finds the make-custom-app entry of ~/.claude.json', () => {
		const home = newHome();
		const file = write(home, ['.claude.json'], JSON.stringify({
			numStartups: 3,
			mcpServers: {
				'make-custom-app': { command: process.execPath, args: ['/x/dist/index.js'], env: { PINECONE_API_KEY: TOKEN } },
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
		const expected = ['make-app-context', 'renamed', 'by-command', 'folder-only'].map((name) => ({ kind: 'mcp-entry', path: file, editor: 'cursor', name }));
		assert.deepEqual(detectLegacyInstall({ home }), expected);
	});

	it('finds a Cursor entry whose path uses Windows separators', () => {
		const home = newHome();
		const file = write(home, ['.cursor', 'mcp.json'], JSON.stringify({
			mcpServers: { win: { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Users\\dev\\.cursor\\skills\\make-custom-app\\mcp-server\\dist\\index.js'] } },
		}));
		assert.deepEqual(detectLegacyInstall({ home }), [{ kind: 'mcp-entry', path: file, editor: 'cursor', name: 'win' }]);
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
				'make-custom-app': { command: 'node', args: ['/x/index.js', `--token=${TOKEN}`], env: { PINECONE_API_KEY: TOKEN, OPENAI_API_KEY: TOKEN } },
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
		for (const item of items) assert.deepEqual(Object.keys(item).sort(), ['editor', 'kind', 'name', 'path']);
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
		const claudeJson = write(home, ['.claude.json'], JSON.stringify({ mcpServers: { 'make-custom-app': { command: 'node' } } }));
		const cursorSkill = mkdir(home, '.cursor', 'skills', 'make-custom-app');
		const cursorRules = mkdir(home, '.cursor', 'rules', 'make-custom-app');
		const cursorJson = write(home, ['.cursor', 'mcp.json'], JSON.stringify({ mcpServers: { 'make-app-context': { command: 'node', args: [oldServerPath(home)] } } }));
		assert.deepEqual(detectLegacyInstall({ home }), [
			{ kind: 'skill-dir', path: claudeSkill, editor: 'claude' },
			{ kind: 'sentinel', path: claudeMd, editor: 'claude', closed: true },
			{ kind: 'mcp-entry', path: claudeJson, editor: 'claude', name: 'make-custom-app' },
			{ kind: 'skill-dir', path: cursorSkill, editor: 'cursor' },
			{ kind: 'rules-dir', path: cursorRules, editor: 'cursor' },
			{ kind: 'mcp-entry', path: cursorJson, editor: 'cursor', name: 'make-app-context' },
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
