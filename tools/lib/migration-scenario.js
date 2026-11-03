'use strict';

// Helpers of tools/migration-test.js that need no process, no claude binary, and no network: the fake values, the
// guard that decides where the tool may run, tree snapshots and greps, and the environment of every child process.
// The environment is built from scratch, so nothing of the real home, PATH, or CLAUDE_CONFIG_DIR reaches a child.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The values of shared/scripts/lib/__tests__/fake-legacy-home.js; a test compares both lists.
const FAKE = {
	pinecone: 'fake-pinecone-0001',
	openai: 'fake-openai-0001',
	index: 'make-app-contexts',
	otherToken: 'fake-other-token-1111',
	cursorToken: 'fake-cursor-token-2222',
	conflictPinecone: 'fake-pinecone-9999',
};
const SECRET_NAMES = ['pinecone', 'openai', 'otherToken', 'cursorToken', 'conflictPinecone'];
const GENERIC_FAKE = /fake-[a-z-]+-\d{4}/g;

const MARKETPLACE_URL = 'https://github.com/minsu-kang/make-app-ai-plugin.git';
const SCENARIOS = ['full', 'hand-installed', 'disabled', 'no-claude', 'edited-sentinel', 'rerun-a'];

const isFolder = (value) => typeof value === 'string' && value !== '';
const byText = (a, b) => Number(a > b) - Number(a < b);

/** CI alone does not count: many local shells set it. */
function mayRun(params) {
	if (typeof params !== 'object' || params === null || typeof params.env !== 'object' || params.env === null || typeof params.exists !== 'function') {
		throw new TypeError('mayRun needs env and exists');
	}
	return params.env.GITHUB_ACTIONS === 'true' || params.exists('/.dockerenv');
}

function entryOf(abs) {
	const stat = fs.lstatSync(abs);
	const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
	return {
		type,
		mode: stat.mode & 0o7777,
		sha256: type === 'file' ? crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') : null,
		linkTarget: type === 'symlink' ? fs.readlinkSync(abs) : null,
	};
}

function walk(result, abs, rel, skipped) {
	for (const name of fs.readdirSync(abs).sort()) {
		const childRel = rel === '' ? name : `${rel}/${name}`;
		if (!skipped(childRel)) record(result, path.join(abs, name), childRel, skipped);
	}
}

function record(result, abs, rel, skipped) {
	const entry = entryOf(abs);
	result.set(rel, entry);
	if (entry.type === 'dir') walk(result, abs, rel, skipped);
}

/** Every path below `dir` (not `dir` itself) as rel -> { type, mode, sha256, linkTarget }; `exclude` lists rel paths whose subtrees are skipped. */
function snapshotTree(dir, options) {
	if (!isFolder(dir)) throw new TypeError('snapshotTree needs dir');
	const exclude = options && Array.isArray(options.exclude) ? options.exclude : [];
	const result = new Map();
	walk(result, dir, '', (rel) => exclude.some((item) => rel === item || rel.startsWith(`${item}/`)));
	return result;
}

/** Like snapshotTree for the named paths below `dir` only: each path itself (file, folder, or link) and, for a folder, everything in it. A path that does not exist is left out. */
function snapshotPaths(dir, paths) {
	if (!isFolder(dir) || !Array.isArray(paths) || paths.some((rel) => !isFolder(rel) || path.isAbsolute(rel) || rel.split('/').includes('..'))) throw new TypeError('snapshotPaths needs dir and paths');
	const result = new Map();
	for (const rel of paths) {
		try {
			record(result, path.join(dir, rel), rel, () => false);
		} catch (err) {
			if (err.code !== 'ENOENT') throw err;
		}
	}
	return result;
}

/** One line per added, removed, or changed path, sorted by path. A line names the kind of change and never holds file content. */
function diffSnapshots(before, after) {
	const lines = [];
	for (const rel of new Set([...before.keys(), ...after.keys()])) {
		const was = before.get(rel);
		const now = after.get(rel);
		if (was === undefined) {
			lines.push([rel, `added ${rel}`]);
		} else if (now === undefined) {
			lines.push([rel, `removed ${rel}`]);
		} else {
			const changes = [];
			if (was.type !== now.type) changes.push(`type ${was.type} -> ${now.type}`);
			if (was.mode !== now.mode) changes.push(`mode ${was.mode.toString(8)} -> ${now.mode.toString(8)}`);
			if (was.sha256 !== now.sha256) changes.push('content');
			if (was.linkTarget !== now.linkTarget) changes.push('link target');
			if (changes.length > 0) lines.push([rel, `changed ${rel}: ${changes.join(', ')}`]);
		}
	}
	return lines.sort((x, y) => byText(x[0], y[0])).map((line) => line[1]);
}

/** The regular files below `dir` that hold a needle, one { rel, needle } per file and needle, sorted by path. Links are not followed. */
function grepTree(dir, needles) {
	if (!isFolder(dir) || !Array.isArray(needles) || needles.some((needle) => !isFolder(needle))) throw new TypeError('grepTree needs dir and needles');
	const found = [];
	const visit = (abs, rel) => {
		for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((x, y) => byText(x.name, y.name))) {
			const childAbs = path.join(abs, entry.name);
			const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				visit(childAbs, childRel);
			} else if (entry.isFile()) {
				const content = fs.readFileSync(childAbs);
				for (const needle of needles) if (content.includes(needle)) found.push({ rel: childRel, needle });
			}
		}
	};
	visit(dir, '');
	return found.sort((x, y) => byText(x.rel, y.rel));
}

/** The whole environment of a child process: PATH, the throwaway home, the git mappings of M1b, the switches that keep claude offline, and the variables of an agent session (M4). */
function buildEnv(params) {
	const names = ['home', 'fakebin', 'claudeDir', 'nodeDir', 'bare'];
	if (typeof params !== 'object' || params === null || !names.every((name) => isFolder(params[name]))) throw new TypeError(`buildEnv needs ${names.join(', ')}`);
	const { home, fakebin, claudeDir, nodeDir, bare } = params;
	return {
		PATH: [fakebin, claudeDir, nodeDir, '/usr/bin', '/bin'].join(path.delimiter),
		HOME: home,
		USERPROFILE: home,
		TMPDIR: path.join(home, 'tmp'),
		GIT_CONFIG_COUNT: '2',
		GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
		GIT_CONFIG_VALUE_0: MARKETPLACE_URL,
		GIT_CONFIG_KEY_1: 'url.https://blocked.invalid/.insteadOf',
		GIT_CONFIG_VALUE_1: 'https://github.com/',
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		DISABLE_AUTOUPDATER: '1',
		MAKE_CUSTOM_APP_SKIP_UPDATE_CHECK: '1',
		CLAUDECODE: '1',
		CLAUDE_CODE_ENTRYPOINT: 'cli',
		CLAUDE_CODE_SSE_PORT: '1',
		CLAUDE_CODE_SESSION_ID: '00000000-0000-0000-0000-000000000000',
		CLAUDE_CODE_CHILD_SESSION: '1',
		CLAUDE_PID: '1',
	};
}

/** The names (keys of FAKE) of the secret fake values that `text` holds, in the order of the list. The index name is no secret. */
function fakeNamesIn(text) {
	const value = typeof text === 'string' ? text : '';
	return SECRET_NAMES.filter((name) => value.includes(FAKE[name]));
}

/** `text` with every fake value shown as [name], and any other value of the form fake-word-1234 as [fake], so a failure detail can quote a line safely. */
function redactFakes(text) {
	let result = typeof text === 'string' ? text : '';
	for (const name of SECRET_NAMES) result = result.split(FAKE[name]).join(`[${name}]`);
	return result.replace(GENERIC_FAKE, '[fake]');
}

module.exports = { FAKE, MARKETPLACE_URL, SCENARIOS, mayRun, snapshotTree, snapshotPaths, diffSnapshots, grepTree, buildEnv, fakeNamesIn, redactFakes };
