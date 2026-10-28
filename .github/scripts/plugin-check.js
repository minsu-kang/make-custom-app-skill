#!/usr/bin/env node
'use strict';

// CI consistency checks for the plugin content. Not part of the plugin payload.
// Usage: node .github/scripts/plugin-check.js [repoRoot] [--scope=<path>]... [--skills=<name,name,...>]
// --scope is a path relative to the repo root: a folder (scans its Markdown files) or one .md file.
// A leading ./ and repeated or trailing slashes are ignored. Default: shared and skills, each skipped when missing.
// An explicit --scope that does not exist is an error. Without --scope the run is a full run: besides the
// per-file checks it checks the skill layer (the nine skills of spec 4.1, or the names given by --skills),
// the hard-rules blocks, that every workflow is named by a skill (outside its hard-rules block) and every reference
// by shared/index.md, the syntax of tools/, .github/scripts/ and shared/scripts/, and mcp.json when it exists.
// Prints warnings (a description over 400 characters) without failing. Exit 1 on any error.
// Later plans add the version and manifest checks to this file.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const hardRules = require(path.join(__dirname, '..', '..', 'tools', 'sync-hard-rules.js'));

const args = process.argv.slice(2);
const ROOT = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const normaliseScope = (value) => value.replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
const scopeArgs = args.filter((a) => a.startsWith('--scope=')).map((a) => normaliseScope(a.slice('--scope='.length)));
const SCOPE = scopeArgs.length ? scopeArgs : ['shared', 'skills'];
const FULL_RUN = scopeArgs.length === 0;
const EXPECTED_SKILLS = [
	'make-app-task-refinement',
	'make-app-bug-investigation',
	'make-app-code-review',
	'make-app-feature-request',
	'make-app-task',
	'make-app-endpoint',
	'make-app-question',
	'make-app-run-live',
	'make-app-setup',
];
const skillsArg = args.find((a) => a.startsWith('--skills='));
const SKILLS = skillsArg ? skillsArg.slice('--skills='.length).split(',').filter(Boolean) : EXPECTED_SKILLS;
const FRONTMATTER_KEYS = new Set(['name', 'description', 'allowed-tools']);
const DESCRIPTION_WARN = 400;
const DESCRIPTION_MAX = 1024;
const DESCRIPTION_BUDGET = 4000;
const YAML_NOT_PLAIN = /:(?:[ \t]|$)| #|^[#,[\]{}&*!|>'"%@`]/;
const APPROVED_SCRIPTS = new Set(['check-setup', 'review-changes']);
const ALLOWED_TOOL = /Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/shared\/scripts\/([\w-]+)\.js"\*\)/g;
const MCP_LOCAL = 'make-app-context';
const MCP_REMOTE = { make: 'https://mcp.make.com/v2', atlassian: 'https://mcp.atlassian.com/v1/mcp' };
const MCP_PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}/';
const PLACEHOLDER = /\$\{([^}]*)\}/g;
const SECRET_LIKE = /(?<![\w-])(?:sk-[\w-]{8,}|pcsk_[\w-]{8,}|ATATT3x[\w=-]+)/;
const ANCHOR = [
	'Plugin root: ${CLAUDE_PLUGIN_ROOT}',
	'If the line above still shows a literal ${...}, the plugin root is the directory',
	'two levels above the folder that contains this SKILL.md.',
];
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
const OLD_INSTALL_PATH = /\.(?:claude|cursor)\/(?:skills\/make-custom-app|make-app-contexts)(?![\w-])|make-app-contexts\//;
const OLD_PATH_EXEMPT_PREFIX = 'skills/make-app-setup/';
const SECTION_RUN = '§\\s*\\d+(?:\\s*(?:(?:,\\s*(?:(?:and|or)\\s*)?|(?:and|or|&)\\s*)§\\s*\\d+|(?:to|[\\u2013-])\\s*(?:§\\s*)?\\d+))*';
const LIFECYCLE_RUN = new RegExp(`\\blifecycle(\\.md)?\\)?\\s*(${SECTION_RUN})`, 'g');
const LIFECYCLE_SPELLED = /\blifecycle(?:\.md)?\)?\s+sections?\s+(\d+)/g;
const LIFECYCLE_ANCHOR = /lifecycle\.md#(\d+)-/g;

const findings = { error: [], warning: [] };

const escapeAnnotation = (value) => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function error(file, msg, line) {
	findings.error.push({ file, line, msg });
	const where = line ? `${file}:${line}` : file;
	if (process.env.GITHUB_ACTIONS === 'true') {
		console.log(`::error file=${escapeAnnotation(file)}${line ? `,line=${line}` : ''}::${escapeAnnotation(msg)}`);
	} else {
		console.log(`ERROR ${where}: ${msg}`);
	}
}

function warn(file, msg) {
	findings.warning.push({ file, msg });
	console.log(process.env.GITHUB_ACTIONS === 'true' ? `::warning file=${escapeAnnotation(file)}::${escapeAnnotation(msg)}` : `WARNING ${file}: ${msg}`);
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
const scopeExists = (prefix) => fs.existsSync(path.join(ROOT, prefix));
const scopedMarkdown = () =>
	[...new Set(SCOPE.filter(scopeExists).flatMap((prefix) => (isMarkdown(prefix) ? [prefix] : listFiles(prefix, isMarkdown))))].sort();

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
	const oldPathAllowed = rel.startsWith(OLD_PATH_EXEMPT_PREFIX);
	eachLine(text, (line, n) => {
		if (/\$\{SKILL_ROOT\}|\$\{CONTEXTS_DIR\}/.test(line)) error(rel, 'old ${SKILL_ROOT} or ${CONTEXTS_DIR} placeholder', n);
		if (/<!--\s*Variables:/.test(line)) error(rel, 'old "Variables" comment', n);
		if (!oldPathAllowed && OLD_INSTALL_PATH.test(line)) error(rel, 'old install path (use ~/.make-custom-app/contexts or <plugin root>)', n);
	});
}

function checkCitations(rel, text) {
	eachLine(text, (line, n) => {
		const invalid = (numbers) => {
			for (const number of new Set(numbers)) if (!LIFECYCLE_SECTIONS.has(number)) error(rel, `lifecycle.md has no section ${number}`, n);
		};
		for (const m of line.matchAll(LIFECYCLE_RUN)) {
			const numbers = m[2].match(/\d+/g);
			if (!m[1]) error(rel, `"lifecycle §${numbers[0]}" must name the new file (lifecycle.md, jira-ticket.md, push-changes.md, commit-compile.md, run-live.md, or close-out.md)`, n);
			else invalid(numbers);
		}
		for (const m of line.matchAll(LIFECYCLE_SPELLED)) error(rel, `spell the citation as "lifecycle.md §${m[1]}", not "${m[0]}"`, n);
		invalid([...line.matchAll(LIFECYCLE_ANCHOR)].map((m) => m[1]));
		if (rel.startsWith('shared/') && /SKILL\.md/.test(line)) error(rel, 'points at SKILL.md (use shared/index.md or the hard rules)', n);
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

function parseFrontmatter(text) {
	const lines = text.split('\n');
	if (lines[0] !== '---') return { error: 'front matter block is missing' };
	const end = lines.indexOf('---', 1);
	if (end < 0) return { error: 'front matter block is not closed' };
	const values = {};
	for (let i = 1; i < end; i += 1) {
		const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
		if (!m) return { error: `front matter line ${i + 1} is not "key: value" (one line per key)` };
		if (Object.hasOwn(values, m[1])) return { error: `front matter key "${m[1]}" is given twice` };
		values[m[1]] = m[2].trim();
	}
	return { values, lines, bodyStart: end + 1 };
}

function checkAllowedTools(rel, tools) {
	const scripts = [...tools.matchAll(ALLOWED_TOOL)].map((m) => m[1]);
	const rest = tools.replace(ALLOWED_TOOL, '').trim();
	if (rest) error(rel, `allowed-tools holds "${rest}", which is not a quoted node command for check-setup.js or review-changes.js`);
	for (const script of scripts) {
		if (!APPROVED_SCRIPTS.has(script)) error(rel, `allowed-tools pre-approves ${script}.js; only check-setup.js and review-changes.js may be pre-approved`);
		else if (!fs.existsSync(path.join(ROOT, 'shared', 'scripts', `${script}.js`))) error(rel, `allowed-tools names shared/scripts/${script}.js, which does not exist`);
	}
}

// Returns the description length (0 when there is none).
function checkSkillFile(rel, text, folder) {
	const fm = parseFrontmatter(text);
	if (fm.error) {
		error(rel, fm.error);
		return 0;
	}
	for (const key of Object.keys(fm.values)) {
		if (!FRONTMATTER_KEYS.has(key)) error(rel, `front matter key "${key}" is not allowed (name, description, allowed-tools)`);
	}
	if (fm.values.name !== folder) error(rel, `front matter name "${fm.values.name}" differs from the folder "${folder}"`);
	const description = fm.values.description || '';
	if (!description) {
		error(rel, 'front matter description is empty');
	} else {
		if (description.length > DESCRIPTION_MAX) error(rel, `description is ${description.length} characters, over the ${DESCRIPTION_MAX} limit`);
		else if (description.length > DESCRIPTION_WARN) warn(rel, `description is ${description.length} characters, over ${DESCRIPTION_WARN}`);
		if (!/Not for /.test(description)) error(rel, 'description has no "Not for ..." clause');
		if (YAML_NOT_PLAIN.test(description)) error(rel, 'description must be a plain one-line YAML value: no ": ", no trailing ":", no " #", and no leading # , [ ] { } & * ! | > \' " % @ or backtick');
	}
	if (fm.values['allowed-tools'] !== undefined) checkAllowedTools(rel, fm.values['allowed-tools']);
	const body = fm.lines.slice(fm.bodyStart);
	const anchored = body[0] === '' && ANCHOR.every((line, i) => body[i + 1] === line) && body[4] === '' && body[5] === hardRules.START;
	if (!anchored) error(rel, `the body must start with an empty line, the three-line "Plugin root:" anchor, an empty line, and the ${hardRules.START} line`);
	return description.length;
}

function withoutHardRules(text) {
	const lines = text.split('\n');
	const start = lines.indexOf(hardRules.START);
	const end = lines.indexOf(hardRules.END);
	if (start < 0 || end < start) return text;
	return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');
}

function checkSkillLayer() {
	const dir = path.join(ROOT, 'skills');
	const folders = fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
	for (const name of SKILLS.filter((n) => !folders.includes(n))) error(`skills/${name}`, 'expected skill folder is missing');
	for (const name of folders.filter((n) => !SKILLS.includes(n))) error(`skills/${name}`, 'unexpected skill folder (the skills are listed in spec 4.1)');
	let total = 0;
	let allText = '';
	for (const name of SKILLS.filter((n) => folders.includes(n))) {
		const rel = `skills/${name}/SKILL.md`;
		const text = read(rel);
		if (text === null) continue;
		allText += `${withoutHardRules(text)}\n`;
		total += checkSkillFile(rel, text, name);
	}
	if (total > DESCRIPTION_BUDGET) error('skills', `the skill descriptions total ${total} characters, over the ${DESCRIPTION_BUDGET} budget`);
	for (const rel of listFiles('shared/workflows', isMarkdown)) {
		if (!mentions(allText, `shared/workflows/${path.posix.basename(rel)}`)) error(rel, 'no SKILL.md names this workflow in its Load order list');
	}
}

function checkReferenceIndex() {
	if (!fs.existsSync(path.join(ROOT, 'shared', 'index.md'))) return;
	const index = read('shared/index.md');
	if (index === null) return;
	for (const rel of listFiles('shared/references', isMarkdown).filter((f) => path.posix.dirname(f) === 'shared/references')) {
		if (!mentions(index, `references/${path.posix.basename(rel)}`)) error('shared/index.md', `does not list ${rel}`);
	}
}

function checkHardRules() {
	const result = hardRules.run(ROOT, { check: true });
	for (const message of result.errors) error(message.split(':')[0], message);
	for (const rel of result.drifted) error(rel, `hard-rules block differs from ${hardRules.SOURCE}; run node tools/sync-hard-rules.js`);
}

function checkMcpConfig() {
	const text = read('mcp.json');
	if (text === null) return;
	let servers;
	try {
		const config = JSON.parse(text);
		servers = config && config.mcpServers;
	} catch (err) {
		error('mcp.json', `is not valid JSON: ${err.message}`);
		return;
	}
	if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
		error('mcp.json', 'has no mcpServers object; the file must be { "mcpServers": { ... } }');
		return;
	}
	const expected = [MCP_LOCAL, ...Object.keys(MCP_REMOTE)];
	for (const name of expected) if (!(name in servers)) error('mcp.json', `server "${name}" is missing`);
	for (const name of Object.keys(servers)) if (!expected.includes(name)) error('mcp.json', `unexpected server "${name}" (spec 7.1 lists ${expected.join(', ')})`);
	for (const [name, server] of Object.entries(servers)) {
		if (!server || typeof server !== 'object') {
			error('mcp.json', `server "${name}" is not an object`);
			continue;
		}
		for (const key of ['env', 'headers']) if (key in server) error('mcp.json', `server "${name}" has ${key}; mcp.json holds no secret and no environment`);
		if (Object.hasOwn(MCP_REMOTE, name)) {
			if (server.type !== 'http') error('mcp.json', `server "${name}" needs "type": "http" (Claude drops a remote entry without it)`);
			if (server.url !== MCP_REMOTE[name]) error('mcp.json', `server "${name}" must use ${MCP_REMOTE[name]}`);
		} else if (name === MCP_LOCAL) {
			const entry = Array.isArray(server.args) ? server.args[0] : undefined;
			if (server.command !== 'node') error('mcp.json', `server "${name}" must run node`);
			if (typeof entry !== 'string' || !entry.startsWith(MCP_PLUGIN_ROOT)) error('mcp.json', `server "${name}" must start ${MCP_PLUGIN_ROOT}<path to the bundle> as its first argument`);
			else if (!fs.existsSync(path.join(ROOT, entry.slice(MCP_PLUGIN_ROOT.length)))) error('mcp.json', `server "${name}" points at ${entry.slice(MCP_PLUGIN_ROOT.length)}, which does not exist`);
		}
	}
	for (const [, variable] of text.matchAll(PLACEHOLDER)) {
		if (variable !== 'CLAUDE_PLUGIN_ROOT') error('mcp.json', `the placeholder named ${variable} is not allowed; only CLAUDE_PLUGIN_ROOT is`);
	}
	if (SECRET_LIKE.test(text)) error('mcp.json', 'holds something that looks like a secret; remove it, keys come from the environment or the secrets file (spec 7.2)');
}

function checkSyntax() {
	const isJs = (n) => n.endsWith('.js');
	for (const rel of [...listFiles('tools', isJs), ...listFiles('.github/scripts', isJs), ...listFiles('shared/scripts', isJs)]) {
		const result = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
		if (result.status !== 0) error(rel, `syntax check failed: ${(result.stderr || '').split('\n').find((l) => l.trim()) || 'unknown error'}`);
	}
}

for (const prefix of scopeArgs) {
	if (!scopeExists(prefix)) error(prefix, 'scope does not exist');
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

if (FULL_RUN) {
	if (fs.existsSync(path.join(ROOT, 'skills'))) checkSkillLayer();
	if (fs.existsSync(path.join(ROOT, 'skills')) || fs.existsSync(path.join(ROOT, hardRules.SOURCE))) checkHardRules();
	checkReferenceIndex();
	if (fs.existsSync(path.join(ROOT, 'mcp.json'))) checkMcpConfig();
	checkSyntax();
}

console.log(`${findings.error.length} error(s)${findings.warning.length ? `, ${findings.warning.length} warning(s)` : ''}`);
process.exitCode = findings.error.length ? 1 : 0;
