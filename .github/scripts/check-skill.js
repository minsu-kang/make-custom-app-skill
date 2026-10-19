#!/usr/bin/env node
'use strict';

// CI consistency checks for the skill payload. Not installed with the skill.
// Usage: node .github/scripts/check-skill.js [repoRoot]
// Exit 1 on any error. The SKILL.md size cap only warns until the cap is decided.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const SKILL_MD_MAX_BYTES = 9 * 1024;
const LINKED_EXT = /\.(md|mdc|js|json|sh|ps1|imljson)$/i;
const SEMVER = /^\d+\.\d+\.\d+$/;

const findings = { error: [], warning: [] };

function report(level, file, line, msg) {
	findings[level].push({ file, line, msg });
	const where = line ? `${file}:${line}` : file;
	if (process.env.GITHUB_ACTIONS === 'true') {
		const lineArg = line ? `,line=${line}` : '';
		console.log(`::${level} file=${file}${lineArg}::${msg}`);
	} else {
		console.log(`${level.toUpperCase()} ${where}: ${msg}`);
	}
}

const error = (file, msg, line) => report('error', file, line, msg);
const warning = (file, msg, line) => report('warning', file, line, msg);

function read(rel) {
	try {
		return fs.readFileSync(path.join(ROOT, rel), 'utf8');
	} catch {
		error(rel, 'file is missing or unreadable');
		return null;
	}
}

function listFiles(rel, test) {
	const dir = path.join(ROOT, rel);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const child = path.posix.join(rel, entry.name);
		if (entry.isDirectory()) return listFiles(child, test);
		return test(entry.name) ? [child] : [];
	});
}

const isMarkdown = (name) => name.endsWith('.md');
const isJs = (name) => name.endsWith('.js');

function checkVersions() {
	const versionText = read('version.json');
	const skillMd = read('skill/SKILL.md');
	const changelog = read('CHANGELOG.md');
	if (versionText === null || skillMd === null || changelog === null) return;

	let versionJson;
	try {
		versionJson = JSON.parse(versionText);
	} catch (err) {
		error('version.json', `invalid JSON: ${err.message}`);
		return;
	}

	const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
	if (!frontMatter) {
		error('skill/SKILL.md', 'front matter block is missing');
		return;
	}
	const field = (name) => new RegExp(`^${name}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(frontMatter[1])?.[1];

	if (field('name') !== 'make-custom-app') error('skill/SKILL.md', `front matter name is "${field('name')}", expected "make-custom-app"`);
	if (!field('description')) error('skill/SKILL.md', 'front matter description is empty');

	const firstHeading = changelog.split(/\r?\n/).find((l) => l.startsWith('## '));
	const top = /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/.exec(firstHeading || '');
	if (!top) {
		error('CHANGELOG.md', `first heading "${firstHeading}" does not match "## X.Y.Z — YYYY-MM-DD"`);
		return;
	}

	const versions = { 'version.json': versionJson.version, 'skill/SKILL.md': field('version'), 'CHANGELOG.md': top[1] };
	for (const [file, v] of Object.entries(versions)) {
		if (!SEMVER.test(v || '')) error(file, `version "${v}" is not X.Y.Z`);
	}
	if (new Set(Object.values(versions)).size > 1) {
		const list = Object.entries(versions).map(([file, v]) => `${file}=${v}`).join(', ');
		error('version.json', `versions disagree: ${list}`);
	}
	if (versionJson.released !== top[2]) {
		error('version.json', `released "${versionJson.released}" differs from the CHANGELOG top entry date "${top[2]}"`);
	}
}

function checkSkillMdSize() {
	const skillMd = read('skill/SKILL.md');
	if (skillMd === null) return;
	const bytes = Buffer.byteLength(skillMd);
	if (bytes > SKILL_MD_MAX_BYTES) {
		warning('skill/SKILL.md', `${bytes} bytes, over the ${SKILL_MD_MAX_BYTES} byte (9 KB) cap`);
	}
}

function mentions(text, name) {
	const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
	return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-])`).test(text);
}

function safeDecode(target) {
	try {
		return decodeURIComponent(target);
	} catch {
		return target;
	}
}

function linkTargets(line) {
	const targets = [...line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)].map((m) => m[1]);
	const definition = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)/.exec(line);
	if (definition) targets.push(definition[1]);
	return targets;
}

function stripCode(text) {
	return text
		.replace(/^(```|~~~)[\s\S]*?^\1/gm, (block) => block.replace(/[^\n]/g, ''))
		.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
}

function checkLinks() {
	const files = [...listFiles('skill', isMarkdown), 'README.md'];
	for (const rel of files) {
		const text = read(rel);
		if (text === null) continue;
		stripCode(text).split('\n').forEach((line, i) => {
			for (const raw of linkTargets(line)) {
				const target = raw.replace(/[#?].*$/, '');
				if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.includes('${') || !LINKED_EXT.test(target)) continue;
				const decoded = safeDecode(target);
				const resolved = decoded.startsWith('/') ? path.join(ROOT, decoded) : path.resolve(ROOT, path.dirname(rel), decoded);
				if (!fs.existsSync(resolved)) error(rel, `link target "${raw}" does not exist`, i + 1);
			}
		});
	}
}

function checkIndexes() {
	const skillMd = read('skill/SKILL.md');
	if (skillMd !== null) {
		for (const dir of ['references', 'workflows']) {
			for (const rel of listFiles(`skill/${dir}`, isMarkdown).filter((f) => path.posix.dirname(f) === `skill/${dir}`)) {
				const indexed = `${dir}/${path.posix.basename(rel)}`;
				if (!mentions(skillMd, indexed)) error('skill/SKILL.md', `${indexed} is not linked from SKILL.md`);
			}
		}
	}

	for (const rel of listFiles('skill/references', isMarkdown)) {
		const head = (read(rel) || '').split('\n').slice(0, 6).join('\n');
		if (!/^> Read when/m.test(head)) error(rel, 'missing the "> Read when" header in the first lines');

		const parent = path.posix.dirname(rel);
		if (parent === 'skill/references') continue;
		const main = read(`${parent}.md`);
		const part = `${path.posix.basename(parent)}/${path.posix.basename(rel)}`;
		if (main !== null && !mentions(main, part)) error(`${parent}.md`, `Parts table does not list ${part}`);
	}
}

function checkScriptLists() {
	const readme = read('README.md');
	const skillMd = read('skill/SKILL.md');
	for (const rel of listFiles('skill/scripts', isJs).filter((f) => path.posix.dirname(f) === 'skill/scripts')) {
		const name = path.posix.basename(rel);
		if (readme !== null && !mentions(readme, name)) error('README.md', `script ${name} is not in the Script Files table`);
		if (skillMd !== null && !mentions(skillMd, name)) error('skill/SKILL.md', `script ${name} is not in the scripts line`);
	}
}

function checkSyntax() {
	const scripts = [
		...listFiles('skill/scripts', isJs),
		...listFiles('.github/scripts', isJs),
		'mcp-server/register.js',
	];
	for (const rel of scripts) {
		const result = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
		if (result.status !== 0) error(rel, `syntax check failed: ${(result.stderr || '').split('\n').find((l) => l.trim()) || 'unknown error'}`);
	}
	for (const rel of ['version.json', 'cspell.json', 'mcp-server/package.json']) {
		const text = read(rel);
		if (text === null) continue;
		try {
			JSON.parse(text);
		} catch (err) {
			error(rel, `invalid JSON: ${err.message}`);
		}
	}
}

checkVersions();
checkSkillMdSize();
checkLinks();
checkIndexes();
checkScriptLists();
checkSyntax();

console.log(`${findings.error.length} error(s), ${findings.warning.length} warning(s)`);
process.exit(findings.error.length ? 1 : 0);
