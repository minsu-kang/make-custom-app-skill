#!/usr/bin/env node
'use strict';

// CI guard for the 2.x old tree (skill/, rules/, the four installers, version.json) while the bridge release exists. Not part of the plugin payload.
// Usage: node .github/scripts/old-tree-guard.js --mode=branch|release --base=<ref> [repoRoot]
// Both modes allow changes only in the bridge files of ALLOWED_PATHS (the seven of spec 8.2, and since 2.4.1 the four installers); release mode also allows the
// one-time 2.4.2 removal of internal content under CLEANUP_PREFIXES (changes and deletions of files outside ALLOWED_PATHS, no new files) when
// version.json moves to 2.4.2. skill/SKILL.md may differ from the base only in its
// version line and its "## Plugin migration" section. Branch mode (pull requests into an integration branch) also keeps both versions as
// they are. Release mode (pull requests into master and pushes to master) lets version.json change, and when the old tree changed at all it
// needs a higher 2.4.x version in version.json and skill/SKILL.md together.
// Exit 0 when there is no finding, 1 with findings, 2 for a usage error or a git failure.

const path = require('path');
const { isDeepStrictEqual } = require('util');
const { spawnSync } = require('child_process');

const OLD_TREE_PATHS = ['skill', 'rules', 'install-claude.sh', 'install-claude.ps1', 'install-cursor.sh', 'install-cursor.ps1', 'version.json'];
const ALLOWED_PATHS = [
	'skill/SKILL.md',
	'skill/scripts/check-setup.js',
	'skill/scripts/lib/__tests__/access-guard.test.js',
	'skill/scripts/migrate-to-plugin.js',
	'skill/scripts/lib/migrate-logic.js',
	'skill/scripts/lib/__tests__/migrate-logic.test.js',
	'skill/scripts/lib/__tests__/migrate-to-plugin.test.js',
	'install-claude.sh',
	'install-claude.ps1',
	'install-cursor.sh',
	'install-cursor.ps1',
];
const CLEANUP_VERSION = '2.4.2';
const CLEANUP_PREFIXES = ['skill/references/', 'skill/workflows/', 'skill/scripts/'];
const MODES = ['branch', 'release'];
const SKILL_MD = 'skill/SKILL.md';
const VERSION_JSON = 'version.json';
const MIGRATION_HEADING = '## Plugin migration';
const USAGE = 'Usage: node .github/scripts/old-tree-guard.js --mode=branch|release --base=<ref> [repoRoot]';

const splitLines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
const lineContent = (line) => line.replace(/\r?\n?$/, '');

function frontMatterRange(lines) {
	const first = lines.findIndex((line) => lineContent(line) === '---');
	if (first === -1) return null;
	const second = lines.findIndex((line, index) => index > first && lineContent(line) === '---');
	return second === -1 ? null : { first, second };
}

function versionLineIndex(lines) {
	const range = frontMatterRange(lines);
	if (!range) return -1;
	for (let i = range.first + 1; i < range.second; i++) {
		if (lineContent(lines[i]).startsWith('version:')) return i;
	}
	return -1;
}

function skillVersion(text) {
	if (typeof text !== 'string') return null;
	const lines = splitLines(text);
	const index = versionLineIndex(lines);
	return index === -1 ? null : lineContent(lines[index]).slice('version:'.length).trim();
}

function stripBridgeParts(text) {
	const lines = splitLines(text);
	const versionIndex = versionLineIndex(lines);
	if (versionIndex !== -1) lines.splice(versionIndex, 1);
	const start = lines.findIndex((line) => lineContent(line) === MIGRATION_HEADING);
	if (start !== -1) {
		const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
		lines.splice(start, (next === -1 ? lines.length : next) - start);
	}
	return lines.join('');
}

function parseNameStatus(zText) {
	const parts = zText.split('\0');
	const entries = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		entries.push({ status: parts[i], path: parts[i + 1] });
	}
	return entries;
}

function parseVersionJson(text) {
	if (typeof text !== 'string') return null;
	try {
		const value = JSON.parse(text);
		return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

function parseTriple(version) {
	const match = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(version) : null;
	return match ? match.slice(1).map(Number) : null;
}

function isGreater(version, base) {
	const a = parseTriple(version);
	const b = parseTriple(base);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] > b[i];
	}
	return false;
}

function releaseFindings(base, head) {
	const baseJson = parseVersionJson(base.versionJson);
	const headJson = parseVersionJson(head.versionJson);
	const findings = [];
	if (!baseJson) findings.push('version.json: not valid JSON on base');
	if (!headJson) findings.push('version.json: not valid JSON on HEAD');
	if (!baseJson || !headJson) return findings;

	const version = headJson.version;
	if (version === baseJson.version) {
		findings.push(`version.json: the old tree changed but version.json still reads ${version}; a bridge change needs a 2.4.x bump of version.json and skill/SKILL.md together`);
	}
	const skill = skillVersion(head.skillMd);
	if (version !== skill) findings.push(`version.json: version ${version} differs from the skill/SKILL.md version ${skill}`);
	if (typeof version !== 'string' || !/^2\.4\.\d+$/.test(version)) findings.push(`version.json: version ${version} is not 2.4.x`);
	if (!isGreater(version, baseJson.version)) findings.push(`version.json: version ${version} is not greater than ${baseJson.version} on the base`);
	if (typeof headJson.released !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(headJson.released)) {
		findings.push(`version.json: released "${headJson.released}" is not a YYYY-MM-DD date`);
	}
	const keys = new Set([...Object.keys(baseJson), ...Object.keys(headJson)]);
	for (const key of keys) {
		if (key === 'version' || key === 'released') continue;
		if (!isDeepStrictEqual(baseJson[key], headJson[key])) findings.push(`version.json: ${key} differs from the base; only version and released may change`);
	}
	return findings;
}

function checkOldTree({ mode, entries, base, head }) {
	if (!MODES.includes(mode)) throw new TypeError('checkOldTree needs mode branch or release');
	const findings = [];
	const versionOf = (side) => parseVersionJson(side.versionJson)?.version;
	const cleanup = mode === 'release' && versionOf(head) === CLEANUP_VERSION && versionOf(base) !== CLEANUP_VERSION;
	const inCleanup = (file) => cleanup && !ALLOWED_PATHS.includes(file) && CLEANUP_PREFIXES.some((prefix) => file.startsWith(prefix));
	for (const { status, path: file } of entries) {
		if (inCleanup(file)) {
			if (status === 'T') findings.push(`${file}: file type changed`);
			else if (status !== 'M' && status !== 'D') findings.push(`${file}: changes to this old-tree path are not allowed during the bridge (git status ${status})`);
			continue;
		}
		if (status === 'D' || (file !== VERSION_JSON && !ALLOWED_PATHS.includes(file))) {
			findings.push(`${file}: changes to this old-tree path are not allowed during the bridge (git status ${status})`);
		} else if (status === 'T') {
			findings.push(`${file}: file type changed`);
		}
	}

	const stripped = (text) => (typeof text === 'string' ? stripBridgeParts(text) : null);
	if (stripped(base.skillMd) !== stripped(head.skillMd)) {
		findings.push(`${SKILL_MD}: changed outside the version line and the "${MIGRATION_HEADING}" section`);
	}

	if (mode === 'branch') {
		const from = skillVersion(base.skillMd);
		const to = skillVersion(head.skillMd);
		if (from !== to) findings.push(`${SKILL_MD}: version changed from ${from} to ${to}; versions change only in the release commit`);
		if (entries.some((e) => e.path === VERSION_JSON)) findings.push(`${VERSION_JSON}: changed; it changes only in the release commit`);
	} else if (entries.length > 0) {
		findings.push(...releaseFindings(base, head));
	}
	return findings;
}

const firstLine = (text) => String(text || '').split('\n').find((line) => line.trim() !== '') || '';
const escapeAnnotation = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function run({ mode, baseRef, root, env, spawnSync: spawn }) {
	if (root === undefined || env === undefined || spawn === undefined) throw new TypeError('run needs root, env, and spawnSync');
	if (!MODES.includes(mode) || typeof baseRef !== 'string' || baseRef === '' || baseRef.startsWith('-')) return { lines: [USAGE], exitCode: 2 };

	const git = (args) => spawn('git', args, { cwd: root, encoding: 'utf8', env });
	const failure = (result, fallback) => ({
		lines: [`old-tree-guard: git failed: ${firstLine(result.stderr) || (result.error && typeof result.error.code === 'string' ? result.error.code : fallback)}`],
		exitCode: 2,
	});
	const show = (ref, file) => {
		const result = git(['show', `${ref}:${file}`]);
		return result.error || result.status !== 0 ? null : result.stdout;
	};

	const resolved = git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
	if (resolved.error || resolved.status !== 0) return failure(resolved, `cannot resolve ${baseRef} to a commit`);
	const diff = git(['diff', '--name-status', '--no-renames', '-z', baseRef, 'HEAD', '--', ...OLD_TREE_PATHS]);
	if (diff.error || diff.status !== 0) return failure(diff, 'git diff failed');

	const findings = checkOldTree({
		mode,
		entries: parseNameStatus(diff.stdout),
		base: { versionJson: show(baseRef, VERSION_JSON), skillMd: show(baseRef, SKILL_MD) },
		head: { versionJson: show('HEAD', VERSION_JSON), skillMd: show('HEAD', SKILL_MD) },
	});
	const annotate = env.GITHUB_ACTIONS === 'true';
	const lines = findings.map((finding) => (annotate ? `::error::${escapeAnnotation(finding)}` : `old-tree-guard: ${finding}`));
	lines.push(`old-tree-guard: ${findings.length} finding(s) (mode ${mode}, base ${baseRef})`);
	return { lines, exitCode: findings.length ? 1 : 0 };
}

function parseArgv(argv) {
	const options = { mode: undefined, baseRef: undefined, root: undefined };
	for (const arg of argv) {
		if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length);
		else if (arg.startsWith('--base=')) options.baseRef = arg.slice('--base='.length);
		else if (arg.startsWith('-') || options.root !== undefined) return null;
		else options.root = path.resolve(arg);
	}
	if (options.root === undefined) options.root = path.join(__dirname, '..', '..');
	return options;
}

if (require.main === module) {
	const options = parseArgv(process.argv.slice(2));
	const result = options ? run({ ...options, env: process.env, spawnSync }) : { lines: [USAGE], exitCode: 2 };
	for (const line of result.lines) console.log(line);
	process.exitCode = result.exitCode;
}

module.exports = { OLD_TREE_PATHS, ALLOWED_PATHS, CLEANUP_VERSION, CLEANUP_PREFIXES, skillVersion, stripBridgeParts, parseNameStatus, checkOldTree, run };
