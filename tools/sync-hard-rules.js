#!/usr/bin/env node
'use strict';

// Copies shared/hard-rules.md verbatim into the block between the two marker lines of every skills/*/SKILL.md.
// Usage: node tools/sync-hard-rules.js [--check] [repoRoot]
// Write mode rewrites the files whose block differs. --check changes nothing and exits 1 when a block differs.
// Both modes exit 1 when the source holds a token that Claude rewrites when a skill loads (spec 4.3), when the
// source is missing, or when a SKILL.md does not hold exactly one start marker followed by one end marker.

const fs = require('fs');
const path = require('path');

const START = '<!-- hard-rules:start -->';
const END = '<!-- hard-rules:end -->';
const SOURCE = 'shared/hard-rules.md';
const RESERVED = [
	[/\$\{CLAUDE_/, '${CLAUDE_...}'],
	[/\$\{user_config\./, '${user_config...}'],
	[/\$ARGUMENTS/, '$ARGUMENTS'],
	[/\$[0-9]/, '$0 to $9'],
	[/\\\$/, 'a backslash before a dollar sign'],
	[/(^|\s)!`/, 'an exclamation mark followed by a backtick'],
];

function readSource(root) {
	const file = path.join(root, SOURCE);
	if (!fs.existsSync(file)) throw new Error(`${SOURCE} is missing`);
	return fs.readFileSync(file, 'utf8');
}

// One entry per offending line: { line, token }.
function lintSource(text) {
	const found = [];
	text.split('\n').forEach((line, i) => {
		for (const [pattern, token] of RESERVED) if (pattern.test(line)) found.push({ line: i + 1, token });
	});
	return found;
}

function blockFor(source) {
	return `${START}\n${source.replace(/\n+$/, '')}\n${END}`;
}

// Returns { text, changed } or { error }.
function applyBlock(text, block) {
	const lines = text.split('\n');
	const starts = lines.flatMap((l, i) => (l === START ? [i] : []));
	const ends = lines.flatMap((l, i) => (l === END ? [i] : []));
	if (starts.length !== 1 || ends.length !== 1) return { error: `needs exactly one ${START} line and one ${END} line (found ${starts.length} and ${ends.length})` };
	if (starts[0] > ends[0]) return { error: `${END} comes before ${START}` };
	const next = [...lines.slice(0, starts[0]), ...block.split('\n'), ...lines.slice(ends[0] + 1)].join('\n');
	return { text: next, changed: next !== text };
}

function skillFiles(root) {
	const dir = path.join(root, 'skills');
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
		.map((e) => path.posix.join('skills', e.name, 'SKILL.md'))
		.sort();
}

// Returns { errors: [string], drifted: [rel], written: [rel] }.
function run(root, { check = false } = {}) {
	const result = { errors: [], drifted: [], written: [] };
	let source;
	try {
		source = readSource(root);
	} catch (err) {
		result.errors.push(err.message);
		return result;
	}
	for (const { line, token } of lintSource(source)) result.errors.push(`${SOURCE}:${line}: contains ${token}, which Claude rewrites when a skill loads`);
	if (result.errors.length) return result;
	const block = blockFor(source);
	for (const rel of skillFiles(root)) {
		const file = path.join(root, rel);
		const applied = applyBlock(fs.readFileSync(file, 'utf8'), block);
		if (applied.error) {
			result.errors.push(`${rel}: ${applied.error}`);
		} else if (applied.changed) {
			result.drifted.push(rel);
			if (!check) {
				fs.writeFileSync(file, applied.text);
				result.written.push(rel);
			}
		}
	}
	return result;
}

module.exports = { START, END, SOURCE, lintSource, blockFor, applyBlock, skillFiles, readSource, run };

if (require.main === module) {
	const args = process.argv.slice(2);
	const check = args.includes('--check');
	const root = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..'));
	const result = run(root, { check });
	for (const message of result.errors) console.log(`ERROR ${message}`);
	for (const rel of result.written) console.log(`updated ${rel}`);
	if (check) for (const rel of result.drifted) console.log(`ERROR ${rel}: hard-rules block differs from ${SOURCE}; run node tools/sync-hard-rules.js`);
	const failed = result.errors.length > 0 || (check && result.drifted.length > 0);
	console.log(failed ? 'hard rules: out of sync' : check ? 'hard rules: in sync' : `hard rules: ${result.written.length} file(s) updated`);
	process.exitCode = failed ? 1 : 0;
}
