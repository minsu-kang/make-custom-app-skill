'use strict';

/**
 * The checks of tools/verify-plugin.js as pure functions over facts that the tool collects: what an isolated install
 * left on disk and what `claude plugin list/details/validate` said (checkInstalled), and what a model session saw
 * when it loaded the working tree with --plugin-dir (checkLive). Each check returns { name, ok, detail }.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { wasDenied, wasRun } = require('./stream-summary');

const PLUGIN = 'make-custom-app';
const SKILLS = [
	'make-app-bug-investigation',
	'make-app-code-review',
	'make-app-endpoint',
	'make-app-feature-request',
	'make-app-question',
	'make-app-run-live',
	'make-app-setup',
	'make-app-task',
	'make-app-task-refinement',
];
const MCP_SERVERS = ['atlassian', 'make', 'make-app-context'];
const REQUIRED_FILES = [
	'.claude-plugin/plugin.json',
	'.cursor-plugin/plugin.json',
	'mcp.json',
	'mcp/index.mjs',
	'shared/hard-rules.md',
	'shared/index.md',
	'shared/scripts/check-setup.js',
	'shared/scripts/review-changes.js',
];
const LIVE_SKILL = `${PLUGIN}:make-app-code-review`;

const result = (name, ok, detail) => ({ name, ok: Boolean(ok), detail });
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The version in the plugin.json of `root`. */
function manifestVersion(root) {
	return JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
}

/**
 * root: the repository. entry: the element of `claude plugin list --json` for the plugin (or undefined).
 * details: the text of `claude plugin details`. validate: { status, stdout } of `claude plugin validate <install folder>`.
 */
function checkInstalled({ root, entry, details, validate }) {
	const out = [];
	const version = manifestVersion(root);
	out.push(result('the plugin is installed at the version of plugin.json', entry && entry.version === version, `installed ${entry ? entry.version : 'nothing'}, plugin.json ${version}`));
	const dir = entry && entry.installPath;
	if (!dir || !fs.existsSync(dir)) {
		out.push(result('the install folder exists', false, String(dir)));
		return out;
	}
	const files = [...REQUIRED_FILES, ...SKILLS.map((s) => `skills/${s}/SKILL.md`)];
	const missing = files.filter((file) => !fs.existsSync(path.join(dir, file)));
	out.push(result('the install folder holds the plugin files', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${files.length} files found`));
	out.push(result('the install folder has no .git', !fs.existsSync(path.join(dir, '.git')), dir));
	const committed = path.join(root, 'mcp', 'index.mjs');
	const installed = path.join(dir, 'mcp', 'index.mjs');
	const both = fs.existsSync(committed) && fs.existsSync(installed);
	out.push(result('the installed MCP bundle equals the committed one', both && sha256(committed) === sha256(installed), both ? 'sha256 compared' : 'bundle missing'));
	const servers = Object.keys((entry && entry.mcpServers) || {}).sort();
	out.push(result('the plugin declares the three MCP servers', same(servers, MCP_SERVERS), servers.join(', ') || 'none'));
	const skills = /Skills \((\d+)\)\s+(.+)/.exec(details || '');
	const listed = skills ? skills[2].split(',').map((s) => s.trim()).sort() : [];
	out.push(result('the plugin lists the nine skills', same(listed, SKILLS), `${listed.length} listed`));
	out.push(result('claude plugin validate finds no error', validate && validate.status === 0, `exit ${validate ? validate.status : 'none'}`));
	return out;
}

/** The four commands of the permission test, with what the pre-approval of check-setup and review-changes must do to each. */
function liveCommands(root) {
	return [
		{ text: `node "${root}/shared/scripts/check-setup.js" --json`, expect: 'run', why: 'the quoted check-setup command is pre-approved' },
		{ text: `node ${root}/shared/scripts/check-setup.js`, expect: 'denied', why: 'the unquoted form does not match the quoted pattern' },
		{ text: `node "${root}/shared/scripts/review-changes.js"`, expect: 'run', why: 'the quoted review-changes command is pre-approved (it prints its usage and exits 1)' },
		{ text: `node "${root}/shared/scripts/download-app.js"`, expect: 'denied', why: 'other scripts are not pre-approved' },
	];
}

function livePrompt(root) {
	const list = liveCommands(root).map((c, i) => `(${i + 1}) ${c.text}`).join('   ');
	return `Invoke the ${LIVE_SKILL} skill with the Skill tool. Then, ignoring that skill's own instructions, run exactly these four Bash commands, one per call and unchanged, and after each one say in one line whether it ran or was denied by permissions: ${list}   Then stop.`;
}

/** summary: parseStream() of a session started with --plugin-dir <root> and the permission test prompt. */
function checkLive({ root, summary }) {
	const out = [];
	const init = summary.init;
	if (!init) return [result('the session started and reported its init event', false, 'no init event')];
	const names = SKILLS.map((s) => `${PLUGIN}:${s}`);
	const missing = names.filter((n) => !init.skills.includes(n));
	out.push(result('the session lists the nine skills as make-custom-app:make-app-*', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '9 found'));
	const context = init.mcpServers.find((s) => s.name === `plugin:${PLUGIN}:make-app-context`);
	out.push(result('the make-app-context server is connected', context && context.status === 'connected', context ? context.status : 'not registered'));
	const plugin = init.plugins.find((p) => p.name === PLUGIN);
	const version = manifestVersion(root);
	out.push(result('the loaded plugin has the version of plugin.json', plugin && plugin.version === version, `loaded ${plugin ? plugin.version : 'nothing'}, plugin.json ${version}`));
	const skillCall = summary.calls.find((c) => c.name === 'Skill' && c.input && c.input.skill === LIVE_SKILL);
	out.push(result(`the skill ${LIVE_SKILL} was invoked`, skillCall && wasRun(skillCall), skillCall ? 'invoked' : 'no Skill call'));
	for (const command of liveCommands(root)) {
		const call = summary.calls.find((c) => c.name === 'Bash' && c.input && c.input.command === command.text);
		const label = `${command.expect === 'run' ? 'runs' : 'is denied'}: ${command.text.replace(root, '<root>')}`;
		if (!call) out.push(result(label, false, 'the model did not issue this exact command'));
		else out.push(result(label, command.expect === 'run' ? wasRun(call) : wasDenied(call), command.why));
	}
	return out;
}

module.exports = { SKILLS, MCP_SERVERS, REQUIRED_FILES, LIVE_SKILL, manifestVersion, checkInstalled, liveCommands, livePrompt, checkLive };
