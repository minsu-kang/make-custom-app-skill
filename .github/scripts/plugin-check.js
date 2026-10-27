#!/usr/bin/env node
'use strict';

// CI consistency checks for the plugin content. Not part of the plugin payload.
// Usage: node .github/scripts/plugin-check.js [repoRoot] [--scope=<path prefix>]...
// Scans the Markdown files under the scope prefixes, a prefix being a folder or one .md file (default: shared, skills).
// Exit 1 on any error.
// Later plans add the version, skill, hard-rule, and manifest checks to this file.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ROOT = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const scopeArgs = args.filter((a) => a.startsWith('--scope=')).map((a) => a.slice('--scope='.length).replace(/\/+$/, ''));
const SCOPE = scopeArgs.length ? scopeArgs : ['shared', 'skills'];
const LINKED_EXT = /\.(md|mdc|js|json|sh|ps1|imljson)$/i;
const LIFECYCLE_SECTIONS = new Set(['1', '2', '3', '4']);
const TASK_WORKFLOWS = new Set([
	'app-question.md',
	'app-task.md',
	'bug-investigation.md',
	'code-review.md',
	'create-endpoint.md',
	'feature-request.md',
	'run-live.md',
	'task-refinement.md',
]);
const SHARED_STEP_WORKFLOWS = new Set(['lifecycle.md', 'jira-ticket.md', 'push-changes.md', 'commit-compile.md', 'close-out.md']);
const NO_TASK_POINTERS = new Set([...SHARED_STEP_WORKFLOWS, 'run-live.md']);
const TASK_ONLY_NAME = /(?<![\w-])(?:app-question|app-task|bug-investigation|code-review|create-endpoint|feature-request|task-refinement)\.md/;

const findings = { error: [] };

function error(file, msg, line) {
	findings.error.push({ file, line, msg });
	const where = line ? `${file}:${line}` : file;
	if (process.env.GITHUB_ACTIONS === 'true') {
		console.log(`::error file=${file}${line ? `,line=${line}` : ''}::${msg}`);
	} else {
		console.log(`ERROR ${where}: ${msg}`);
	}
}

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
const scopedMarkdown = () =>
	[...new Set(SCOPE.flatMap((prefix) => (isMarkdown(prefix) ? [prefix] : listFiles(prefix, isMarkdown))))].sort();

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

function eachLine(text, fn) {
	text.split('\n').forEach((line, i) => fn(line, i + 1));
}

function checkPlaceholders(rel, text) {
	eachLine(text, (line, n) => {
		if (/\$\{SKILL_ROOT\}|\$\{CONTEXTS_DIR\}/.test(line)) error(rel, 'old ${SKILL_ROOT} or ${CONTEXTS_DIR} placeholder', n);
		if (/<!--\s*Variables:/.test(line)) error(rel, 'old "Variables" comment', n);
		if (/make-app-contexts|skills\/make-custom-app/.test(line)) error(rel, 'old install path (use ~/.make-custom-app/contexts or <plugin root>)', n);
	});
}

function checkCitations(rel, text) {
	eachLine(text, (line, n) => {
		for (const m of line.matchAll(/\blifecycle(\.md)?\)?\s*§\s*(\d+)/g)) {
			if (!m[1]) error(rel, `"lifecycle §${m[2]}" must name the new file (lifecycle.md, jira-ticket.md, push-changes.md, commit-compile.md, run-live.md, or close-out.md)`, n);
			else if (!LIFECYCLE_SECTIONS.has(m[2])) error(rel, `lifecycle.md has no section ${m[2]}`, n);
		}
		if (/SKILL\.md/.test(line)) error(rel, 'points at SKILL.md (use shared/index.md or the hard rules)', n);
	});
}

function checkLinks(rel, text) {
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

function checkPluginRootPaths(rel, text) {
	eachLine(text, (line, n) => {
		for (const m of line.matchAll(/<plugin root>\/([A-Za-z0-9_./-]+)/g)) {
			const target = m[1].replace(/[.,;:]+$/, '');
			if (!fs.existsSync(path.join(ROOT, target))) error(rel, `<plugin root>/${target} does not exist`, n);
		}
	});
}

function checkReferenceHeaders(rel, text) {
	if (!rel.startsWith('shared/references/')) return;
	const head = text.split('\n').slice(0, 6).join('\n');
	if (!/^> Read when/m.test(head)) error(rel, 'missing the "> Read when" header in the first lines');

	const parent = path.posix.dirname(rel);
	if (parent === 'shared/references') return;
	const main = read(`${parent}.md`);
	const part = `${path.posix.basename(parent)}/${path.posix.basename(rel)}`;
	if (main !== null && !mentions(main, part)) error(`${parent}.md`, `Parts table does not list ${part}`);
}

function checkChecklists(rel, text) {
	if (path.posix.dirname(rel) !== 'shared/workflows') return;
	const name = path.posix.basename(rel);
	const hasChecklist = /^## Checklist\s*$/m.test(text);
	if (TASK_WORKFLOWS.has(name) && !hasChecklist) error(rel, 'task workflow has no "## Checklist" section');
	if (SHARED_STEP_WORKFLOWS.has(name) && hasChecklist) error(rel, 'shared step file must not carry a checklist (it lives in the task workflows)');
}

function checkSharedPointers(rel, text) {
	if (path.posix.dirname(rel) !== 'shared/workflows' || !NO_TASK_POINTERS.has(path.posix.basename(rel))) return;
	eachLine(text, (line, n) => {
		if (TASK_ONLY_NAME.test(line)) error(rel, 'shared step file points into a task workflow', n);
	});
}

for (const rel of scopedMarkdown()) {
	const text = read(rel);
	if (text === null) continue;
	checkPlaceholders(rel, text);
	checkCitations(rel, text);
	checkLinks(rel, text);
	checkPluginRootPaths(rel, text);
	checkReferenceHeaders(rel, text);
	checkChecklists(rel, text);
	checkSharedPointers(rel, text);
}

console.log(`${findings.error.length} error(s)`);
process.exit(findings.error.length ? 1 : 0);
