/**
 * Tests for cleanup-legacy.js, the command line of phase B (plan, apply, restore, decline). Every case runs the script
 * from the checkout as a child process with process.execPath and exactly the environment that buildFakeLegacyHome
 * returns, on a synthetic old install under a temporary root, with the plugin root set to this checkout (so the script
 * runs from the installed plugin). The fake `claude` of that helper is the only binary that runs, and CLAUDE_BIN always
 * names it (or a missing file): a host may have a real `claude` in a fallback folder. Only fake values are used (FAKE).
 * The file moves HOME and the temp folders into a temporary root first (isolate-home). Every child also loads a preload
 * (NODE_OPTIONS=--require, written by this file) that refuses any process start of a command outside that root and leaves a
 * marker file that `run` checks after every run, so a start of a host program fails the running test.
 */
const { TEST_ROOT, assertIsolated } = require('./isolate-home');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { canonicalJson } = require('../legacy-cleanup-logic');
const { FAKE, INSTALLER_BLOCK, INSTALLER_ENV_TEXT, buildFakeLegacyHome, startWriter, snapshot, diffSnapshots } = require('./fake-legacy-home');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'shared', 'scripts', 'cleanup-legacy.js');
const POSIX_ONLY = { skip: process.platform === 'win32' };
const SECRET_SEEDS = [FAKE.pinecone, FAKE.openai, FAKE.otherToken, FAKE.cursorToken, FAKE.conflictPinecone];

const USAGE = 'Usage: cleanup-legacy.js --plan | --apply <digest> --groups claude[,cursor] | --restore [<backup>] | --decline <digest>';
const DIGEST_ERROR = 'The digest must be 16 lowercase hexadecimal characters, as printed by --plan.';
const GROUPS_ERROR = '--apply needs --groups claude, cursor, or claude,cursor.';
const BACKUP_COPY_TEXT = 'Claude Code keeps its own copy of ~/.claude.json at ~/.claude/backups/ that still holds the removed registration; this cleanup does not touch it.';
const PARTIAL_LINE = 'Stopped after a failure. Run --plan to see what is left, or --restore to undo what was done.';
const RESTART_LINE = 'Restart Claude Code and Cursor.';
const RESTART_TEXT = 'the entry came back after removal; restart Claude Code, then run the cleanup again';
const ADD_JSON_NOTE = 'Note: the restored MCP registration was passed to claude on its command line; other processes of your user could see it in the process list while it ran.';
const LOCK = '~/.make-custom-app/cleanup.lock';
const HELD_WITHOUT_PID = `Another cleanup is running (lock ${LOCK}). Nothing was changed. If no other run is active, delete ${LOCK} and ${LOCK}.takeover, then run it again.`;
const DECLINED = 'Declined. check-setup shows OLD_INSTALL_KEPT for 7 days, then asks again.';
const ALL_STEPS = ['claude.mcp-entry', 'claude.sentinel', 'claude.env-file', 'claude.skill-dir', 'cursor.mcp-entry.make-app-context', 'cursor.env-file', 'cursor.skill-dir', 'cursor.rules-dir'];
const BOTH = ['--groups', 'claude,cursor'];
const CLAUDE_ONLY = ['--groups', 'claude'];
const BACKUP_NAME = /^migration-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?$/;

let work;
let counter = 0;
let guardFile;
let refusedFile;

/** The source of the preload that every child of `run` loads: it refuses each way of starting a program that is not a file inside `root`, and records the refused command in `marker`. */
function spawnGuardSource(root, marker) {
	return [
		"'use strict';",
		"const childProcess = require('child_process');",
		"const fs = require('fs');",
		"const path = require('path');",
		`const ROOT = ${JSON.stringify(root)};`,
		`const MARKER = ${JSON.stringify(marker)};`,
		'function refuse(command) {',
		"\tfs.appendFileSync(MARKER, `${String(command)}\\n`);",
		"\tthrow new Error('a program outside the test root was refused by the test');",
		'}',
		'function allowed(command) {',
		"\tif (typeof command !== 'string' || !path.isAbsolute(command)) return false;",
		'\ttry {',
		'\t\treturn fs.realpathSync(command).startsWith(ROOT + path.sep);',
		'\t} catch {',
		'\t\treturn false;',
		'\t}',
		'}',
		"for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {",
		'\tconst original = childProcess[name];',
		'\tchildProcess[name] = function guarded(command, ...rest) {',
		'\t\tif (!allowed(command)) refuse(command);',
		'\t\treturn original.call(this, command, ...rest);',
		'\t};',
		'}',
		"for (const name of ['exec', 'execSync', 'fork']) {",
		'\tchildProcess[name] = function refused(command) {',
		'\t\trefuse(command);',
		'\t};',
		'}',
		'',
	].join('\n');
}

before(() => {
	work = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-cli-test-'));
	fs.mkdirSync(path.join(work, 'aux'));
	guardFile = path.join(work, 'aux', 'spawn-guard.js');
	refusedFile = path.join(work, 'aux', 'spawn-refused.log');
	fs.writeFileSync(guardFile, spawnGuardSource(TEST_ROOT, refusedFile));
});

after(() => {
	fs.rmSync(work, { recursive: true, force: true });
});

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hasEntry = (h) => Object.hasOwn(readJson(h.paths.claudeJson).mcpServers, 'make-custom-app');
const stateDir = (h) => path.join(h.home, '.make-custom-app');
const lockFile = (h) => path.join(stateDir(h), 'cleanup.lock');
const backupNames = (h) => (fs.existsSync(stateDir(h)) ? fs.readdirSync(stateDir(h)).filter((name) => name.startsWith('migration-backup-')).sort() : []);
const manifestOf = (h, name) => readJson(path.join(stateDir(h), name, 'manifest.json'));
const stepOf = (manifest, id) => manifest.steps.find((step) => step.id === id);
const mode = (file) => fs.statSync(file).mode & 0o777;
const notRoot = () => typeof process.getuid !== 'function' || process.getuid() !== 0;

function leaks(value) {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return SECRET_SEEDS.filter((seed) => text.includes(seed));
}

function put(file, text, fileMode) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	if (fileMode !== undefined) fs.chmodSync(file, fileMode);
}

/** A fake old install in its own folder, the plugin root being this checkout; the installer shape of `.env` unless `envText` says otherwise. */
function fakeHome(label, options = {}) {
	const root = path.join(work, `${label}-${counter++}`);
	fs.mkdirSync(root, { recursive: true });
	const full = { envText: INSTALLER_ENV_TEXT, ...options, root, pluginRoot: REPO_ROOT };
	return { ...buildFakeLegacyHome(full), root, options: full };
}

/** Writes the old install again, the way the installer would, over what is left of it. */
function reinstall(h) {
	buildFakeLegacyHome(h.options);
}

/** The commands that the preload refused since the last call (the marker file is removed), in the order they were tried. */
function takeRefusedStarts() {
	if (!fs.existsSync(refusedFile)) return [];
	const starts = fs.readFileSync(refusedFile, 'utf8').split('\n').filter(Boolean);
	fs.rmSync(refusedFile);
	return starts;
}

/**
 * Runs the script with the spawn guard preloaded; `stdout` and `stderr` are the whole texts, `lines` the lines of stdout, `refused`
 * the commands that the guard refused. A start of a program outside the test root fails the running test unless the case passes
 * `refused: true`. No run may leak a fake value.
 */
function run(h, args, { env = h.env, cwd = h.root, refused = false } = {}) {
	const result = spawnSync(process.execPath, [CLI, ...args], { env: { ...env, NODE_OPTIONS: `--require ${JSON.stringify(guardFile)}` }, cwd, encoding: 'utf8', timeout: 120000 });
	const starts = takeRefusedStarts();
	if (!refused) assert.deepEqual(starts, [], 'a program outside the test root was started');
	assert.equal(result.error, undefined, 'the script ran');
	assert.equal(result.signal, null, 'the script ended by itself');
	assert.ok(result.stdout === '' || result.stdout.endsWith('\n'), 'stdout ends with one newline');
	assert.doesNotMatch(`${result.stdout}${result.stderr}`, /fake claude:/, 'the fake claude stayed inside its root');
	assert.deepEqual(leaks(`${result.stdout}${result.stderr}`), [], 'no fake value on stdout or stderr');
	return { status: result.status, stdout: result.stdout, stderr: result.stderr, lines: result.stdout === '' ? [] : result.stdout.slice(0, -1).split('\n'), refused: starts };
}

function planOf(h, extra) {
	const result = run(h, ['--plan'], extra);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

const digestOf = (h) => planOf(h).digest;

function apply(h, groups = BOTH, digest = digestOf(h), extra) {
	return run(h, ['--apply', digest, ...groups], extra);
}

function nameOfBackup(result) {
	const match = /^Backup: ~\/\.make-custom-app\/(migration-backup-\S+)$/m.exec(result.stdout);
	assert.ok(match, `no Backup line in: ${result.stdout}`);
	return match[1];
}

function readLog(h) {
	return fs.existsSync(h.log)
		? fs
				.readFileSync(h.log, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
}

const mcpCalls = (h) => readLog(h).filter((entry) => entry.argv[0] === 'mcp');

/** The home as the cleanup leaves it for the restore to compare: every path but the backups and ~/.claude.json (a parsed, key-sorted copy, because `claude` writes that file). */
function stateOf(h) {
	const claudeJson = fs.existsSync(h.paths.claudeJson) ? canonicalJson(readJson(h.paths.claudeJson)) : null;
	return { files: snapshot(h.home, { exclude: ['.make-custom-app', '.claude.json'] }), claudeJson };
}

function assertBack(h, before, label) {
	const after = stateOf(h);
	assert.deepEqual(diffSnapshots(before.files, after.files), [], label);
	assert.equal(after.claudeJson, before.claudeJson, `${label}: ~/.claude.json as parsed JSON with sorted keys`);
}

/** The whole home but the state folder, so a refused run is shown to have changed nothing. */
function assertUntouched(h, before, label) {
	assert.deepEqual(diffSnapshots(before, snapshot(h.home, { exclude: ['.make-custom-app'] })), [], label);
	assert.deepEqual(backupNames(h), [], `${label}: no backup folder`);
}

function filesHolding(dir, seed) {
	const found = [];
	for (const [rel, info] of snapshot(dir)) {
		if (info.type === 'file' && fs.readFileSync(path.join(dir, rel)).includes(seed)) found.push(rel);
	}
	return found.sort();
}

const doneLines = (...ids) => ids.map((id) => `done    ${id}`);
const restoredLines = (...ids) => ids.map((id) => `restored ${id}`);
const undoLine = `To undo: node "${REPO_ROOT}/shared/scripts/cleanup-legacy.js" --restore`;
const staleLine = (digest, now) => `The old install changed since the plan (digest ${digest}, now ${now}). Nothing was changed. Run --plan again.`;
const binLine = (value) => `CLAUDE_BIN is set to ${value}, which is not an absolute path to an executable Claude Code binary. Set it to the full path of the claude binary, or unset it. Nothing was changed.`;
const BLOCKED_LINE = 'Refused: claude.mcp-entry is blocked: Claude Code was not found, so the old MCP registration cannot be removed. Nothing was changed. Fix: Set CLAUDE_BIN to the claude binary and run the plan again.';
const hostHasClaudeFallback = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'].some((file) => fs.existsSync(file));

describe('test isolation', () => {
	it('the test process sees a temporary home', () => {
		assertIsolated();
		assert.ok(CLI.startsWith(REPO_ROOT + path.sep) && fs.existsSync(path.join(REPO_ROOT, '.claude-plugin', 'plugin.json')), 'the script under test lies in the checkout');
		assert.ok(work.startsWith(TEST_ROOT + path.sep), 'every case folder lies under the test root');
	});
});

describe('cleanup-legacy.js: --plan', () => {
	it('--plan prints one JSON object with the plan keys, the claude-backup-copy notice for a ready Claude entry, and no fake secret', POSIX_ONLY, () => {
		const h = fakeHome('plan');
		const before = snapshot(h.home);
		const result = run(h, ['--plan']);
		assert.equal(result.status, 0);
		assert.equal(result.stderr, '');
		const plan = JSON.parse(result.stdout);
		assert.equal(result.stdout, `${JSON.stringify(plan, null, 2)}\n`, 'one object, two-space indent, one final newline');
		assert.deepEqual(Object.keys(plan), ['schema', 'digest', 'home', 'editor', 'plugin', 'claude', 'groups', 'confirmRequired', 'secrets', 'items', 'notices', 'backupRoot', 'lines']);
		assert.match(plan.digest, /^[0-9a-f]{16}$/);
		assert.equal(plan.home, h.home);
		assert.equal(plan.backupRoot, stateDir(h));
		assert.equal(plan.confirmRequired, true);
		assert.deepEqual({ ...plan.plugin, version: typeof plan.plugin.version }, { recorded: true, userScope: true, enabled: true, runningFromInstall: true, version: 'string' });
		assert.deepEqual(plan.claude, { binary: h.paths.claudeBin });
		assert.deepEqual(plan.items.map((item) => [item.id, item.status]), ALL_STEPS.map((id) => [id, 'ready']));
		assert.deepEqual(plan.groups.map((group) => [group.id, group.confirm, group.ready]), [['claude', 'after-plan', 4], ['cursor', 'after-cursor-check', 4]]);
		const notice = plan.notices.find((candidate) => candidate.kind === 'claude-backup-copy');
		assert.equal(notice.text, BACKUP_COPY_TEXT);
		assert.deepEqual(leaks(result.stdout), []);
		assert.deepEqual(diffSnapshots(before, snapshot(h.home)), [], 'the plan changes nothing');
		assert.equal(fs.existsSync(stateDir(h)), false, 'and creates no state folder');
		assert.deepEqual(readLog(h).map((entry) => entry.argv), [['--version']], 'it asks claude for its version once and runs nothing else');
	});

	it('--plan twice gives the same digest; numStartups churn and a .DS_Store do not change it; a new top-level file in the skill folder does', POSIX_ONLY, () => {
		const h = fakeHome('plan-digest');
		const first = digestOf(h);
		assert.equal(digestOf(h), first);
		const json = readJson(h.paths.claudeJson);
		json.numStartups = 8;
		json.projects['/other'] = { mcpServers: {} };
		fs.writeFileSync(h.paths.claudeJson, `${JSON.stringify(json, null, 2)}\n`);
		put(path.join(h.paths.claudeSkill, '.DS_Store'), 'noise');
		put(path.join(h.paths.cursorSkill, '.DS_Store'), 'noise');
		assert.equal(digestOf(h), first, 'churn in ~/.claude.json and a .DS_Store are not part of the plan');
		put(path.join(h.paths.claudeSkill, 'notes.txt'), 'a new top-level file\n');
		assert.notEqual(digestOf(h), first, 'a new top-level file in the skill folder is');
	});

	it('--plan with the old install gone prints an empty plan, and apply says there is nothing to remove', POSIX_ONLY, () => {
		const h = fakeHome('plan-empty', { editors: [] });
		const plan = planOf(h);
		assert.deepEqual(plan.items, []);
		assert.deepEqual(plan.lines, ['Nothing to remove.']);
		const before = snapshot(h.home);
		const result = apply(h, CLAUDE_ONLY, plan.digest);
		assert.deepEqual([result.status, result.lines, result.stderr], [0, ['Nothing to remove in claude.'], '']);
		assert.deepEqual(diffSnapshots(before, snapshot(h.home, { exclude: ['.make-custom-app'] })), []);
		assert.deepEqual(backupNames(h), []);
	});

	it('--plan takes the editor flag out of the arguments, and the plan does not need an editor', POSIX_ONLY, () => {
		const h = fakeHome('plan-editor');
		const result = run(h, ['--plan', '--editor', 'cursor']);
		assert.equal(result.status, 0);
		assert.equal(JSON.parse(result.stdout).editor, 'cursor');
		const bare = planOf(h);
		assert.equal(bare.editor, null);
	});
});

describe('cleanup-legacy.js: --apply', () => {
	it('--apply both groups: exit 0, items gone, backup and manifest modes, other servers intact, user paragraph byte-equal, secrets keys present, the output carries the claude-backup-copy text', POSIX_ONLY, () => {
		const h = fakeHome('apply-both', { secrets: 'missing' });
		const p = h.paths;
		const planned = planOf(h);
		assert.deepEqual(planned.secrets.copy, ['pinecone-api-key', 'openai-api-key', 'pinecone-index-name']);
		const before = snapshot(h.home);
		const result = run(h, ['--apply', planned.digest, ...BOTH]);
		assert.equal(result.status, 0);
		assert.equal(result.stderr, '');
		const name = nameOfBackup(result);
		assert.match(name, BACKUP_NAME);
		assert.deepEqual(result.lines, [...doneLines('secrets', ...ALL_STEPS), `Backup: ~/.make-custom-app/${name}`, BACKUP_COPY_TEXT, undoLine, RESTART_LINE]);

		assert.equal(fs.existsSync(p.claudeSkill), false);
		assert.equal(fs.existsSync(p.cursorSkill), false);
		assert.equal(fs.existsSync(p.cursorRules), false);
		assert.equal(hasEntry(h), false);
		const claudeJson = readJson(p.claudeJson);
		assert.equal(claudeJson.numStartups, 7);
		assert.deepEqual(claudeJson.projects, { '/work': { mcpServers: {} } });
		assert.deepEqual(Object.keys(claudeJson.mcpServers), ['other-server']);
		assert.deepEqual(claudeJson.mcpServers['other-server'], { command: 'node', args: ['/opt/other.js'], env: { API_TOKEN: FAKE.otherToken } });
		assert.equal(mode(p.claudeJson), 0o600, 'the cleanup never writes ~/.claude.json, so its mode stays');
		assert.deepEqual(Object.keys(readJson(p.cursorMcp).mcpServers), ['other-cursor']);
		assert.deepEqual(readJson(p.cursorMcp).mcpServers['other-cursor'], { command: 'node', args: ['/opt/other-cursor.js'], env: { TOKEN: FAKE.cursorToken } });
		assert.equal(fs.readFileSync(p.claudeMd, 'utf8'), '# My notes\n\nAlways invoke the `make-custom-app` skill for Make apps.\n', 'the user paragraph is byte-equal');

		const secrets = fs.readFileSync(p.secrets, 'utf8');
		assert.equal(secrets, `editor: claude\npinecone-api-key: ${FAKE.pinecone}\nopenai-api-key: ${FAKE.openai}\npinecone-index-name: ${FAKE.index}\n`, 'the keys of the old install are in the secrets file');
		assert.equal(mode(p.secrets), 0o600);

		const dir = path.join(stateDir(h), name);
		assert.equal(mode(stateDir(h)), 0o700);
		assert.equal(mode(dir), 0o700);
		assert.equal(mode(path.join(dir, 'manifest.json')), 0o600);
		assert.deepEqual(fs.readdirSync(dir).sort(), ['claude', 'cursor', 'manifest.json'], 'no temp file is left');
		assert.deepEqual(fs.readdirSync(stateDir(h)), [name], 'the lock is released');
		const manifest = manifestOf(h, name);
		assert.equal(manifest.status, 'complete');
		assert.equal(manifest.digest, planned.digest);
		assert.deepEqual(manifest.groups, ['claude', 'cursor']);
		assert.deepEqual(manifest.secretsKeysAdded, planned.secrets.copy);
		assert.deepEqual(manifest.steps.map((step) => [step.id, step.state]), [['secrets', 'done'], ...ALL_STEPS.map((id) => [id, 'done'])]);
		assert.deepEqual(diffSnapshots(before, snapshot(h.home, { exclude: ['.make-custom-app'] })).filter((line) => !/^removed \.(claude\/skills|cursor\/(skills|rules))\//.test(line)), [
			'changed .claude.json: content',
			'changed .claude/CLAUDE.md: content',
			'changed .cursor/mcp.json: content',
			'changed .make-custom-app-skill-secrets: content',
		]);
		assert.deepEqual(
			readLog(h).map((entry) => [entry.argv.join(' '), entry.claudecode]),
			[['--version', false], ['--version', false], ['mcp remove make-custom-app --scope user', false]],
			'one version check per run (the plan, then the apply) and one removal, all without CLAUDECODE',
		);
	});

	it('apply then --restore gives back the snapshot (Task 14 comparison rules)', POSIX_ONLY, () => {
		const h = fakeHome('apply-restore');
		const before = stateOf(h);
		const cursorBytes = fs.readFileSync(h.paths.cursorMcp);
		const applied = apply(h);
		assert.equal(applied.status, 0);
		assert.equal(hasEntry(h), false);
		const name = nameOfBackup(applied);

		const restored = run(h, ['--restore']);
		assert.equal(restored.status, 0);
		assert.equal(restored.stderr, '');
		assert.deepEqual(restored.lines, [...restoredLines(...[...ALL_STEPS].reverse()), ADD_JSON_NOTE, RESTART_LINE]);
		assertBack(h, before, 'the home is back as it was');
		assert.equal(hasEntry(h), true);
		assert.equal(fs.readFileSync(h.paths.cursorMcp).equals(cursorBytes), true, 'the canonical Cursor file is byte-equal');
		assert.equal(manifestOf(h, name).status, 'restored');
		assert.deepEqual(fs.readdirSync(stateDir(h)), [name], 'the lock is released and the backup folder stays');

		const again = run(h, ['--restore']);
		assert.deepEqual([again.status, again.lines, again.stderr], [0, ['Nothing to restore: every backup in ~/.make-custom-app is already restored.'], '']);
		assertBack(h, before, 'a second restore changes nothing');
	});

	it('the migration backup folder (~/.make-custom-app/migration-backup-<time>/) holds no fake token (Task 13 grep rules)', POSIX_ONLY, () => {
		const same = fakeHome('backup-same');
		const sameResult = apply(same);
		assert.equal(sameResult.status, 0);
		const sameDir = path.join(stateDir(same), nameOfBackup(sameResult));
		for (const seed of SECRET_SEEDS) assert.deepEqual(filesHolding(sameDir, seed), [], `${seed} with secrets same`);

		const conflict = fakeHome('backup-conflict', { secrets: 'conflict' });
		const planned = planOf(conflict);
		assert.deepEqual(planned.items.filter((item) => item.kind === 'env-file').map((item) => item.action), ['keep-in-backup', 'keep-in-backup']);
		const result = apply(conflict, BOTH, planned.digest);
		assert.equal(result.status, 0);
		const dir = path.join(stateDir(conflict), nameOfBackup(result));
		const kept = ['claude/skill-dir/mcp-server/.env', 'cursor/skill-dir/mcp-server/.env'];
		assert.deepEqual(filesHolding(dir, FAKE.pinecone), [...kept, 'manifest.json']);
		assert.deepEqual(filesHolding(dir, FAKE.openai), kept, 'an equal value is a reference in the manifest, and a literal only in the kept .env files');
		for (const seed of [FAKE.otherToken, FAKE.cursorToken, FAKE.conflictPinecone]) assert.deepEqual(filesHolding(dir, seed), [], seed);
		assert.equal(fs.readFileSync(conflict.paths.secrets, 'utf8').includes(FAKE.conflictPinecone), true, 'the secrets file keeps its own value');
	});

	it('a stale digest exits 3 and the snapshot is unchanged', POSIX_ONLY, () => {
		const h = fakeHome('stale-digest');
		const digest = digestOf(h);
		const before = snapshot(h.home);
		const wrong = digest === '0123456789abcdef' ? 'fedcba9876543210' : '0123456789abcdef';
		const result = apply(h, BOTH, wrong);
		assert.equal(result.status, 3);
		assert.equal(result.stderr, '');
		assert.deepEqual(result.lines, [staleLine(wrong, digest)]);
		assertUntouched(h, before, 'a stale digest');
		assert.deepEqual(fs.readdirSync(stateDir(h)), [], 'the lock is released');
		assert.deepEqual(mcpCalls(h), [], 'claude was not asked to change anything');
	});

	it('the same digest twice: the second run says Nothing to remove and exits 0, no new folder', POSIX_ONLY, () => {
		const h = fakeHome('apply-twice');
		const digest = digestOf(h);
		const first = apply(h, BOTH, digest);
		assert.equal(first.status, 0);
		const names = backupNames(h);
		assert.equal(names.length, 1);
		const afterFirst = snapshot(h.home);
		const callsAfterFirst = readLog(h).length;
		const second = apply(h, BOTH, digest);
		assert.deepEqual([second.status, second.lines, second.stderr], [0, ['Nothing to remove in claude and cursor.'], '']);
		assert.deepEqual(backupNames(h), names);
		assert.deepEqual(diffSnapshots(afterFirst, snapshot(h.home)), [], 'no file or folder of the home changed, the state folder and its backup included');
		assert.equal(readLog(h).length, callsAfterFirst + 1, 'only the version check of the second run reached claude');
	});

	it('apply, reinstall the old files the same way, apply again with the same digest: exit 0 and a second backup folder', POSIX_ONLY, () => {
		const h = fakeHome('apply-reinstall');
		const digest = digestOf(h);
		const first = apply(h, BOTH, digest);
		assert.equal(first.status, 0);
		reinstall(h);
		assert.equal(digestOf(h), digest, 'the reinstalled old install has the same plan digest');
		const second = apply(h, BOTH, digest);
		assert.equal(second.status, 0);
		const names = backupNames(h);
		assert.equal(names.length, 2);
		assert.notEqual(nameOfBackup(first), nameOfBackup(second));
		assert.deepEqual(names, [nameOfBackup(first), nameOfBackup(second)].sort());
		assert.equal(fs.existsSync(h.paths.claudeSkill), false);
		assert.equal(hasEntry(h), false);
	});

	it('disabled, absent, project-only plugin, and a foreign plugin root: exit 2, snapshot unchanged, no backup folder', POSIX_ONLY, () => {
		const foreignRoot = path.join(work, 'foreign-plugin');
		put(path.join(foreignRoot, '.claude-plugin', 'plugin.json'), '{"name":"make-custom-app"}\n');
		const cases = [
			['absent', { pluginState: 'absent' }, 'The make-custom-app plugin is not installed for your user account.', 'claude plugin install make-custom-app@make-custom-app'],
			['project-only', { pluginState: 'project-only' }, 'The make-custom-app plugin is not installed for your user account.', 'claude plugin install make-custom-app@make-custom-app'],
			['disabled', { pluginState: 'disabled' }, 'The make-custom-app plugin is installed but disabled.', 'claude plugin enable make-custom-app@make-custom-app'],
			['foreign', null, `This script does not run from the installed plugin (${REPO_ROOT}; installed at ${foreignRoot}).`, 'Run the copy in the installed plugin.'],
		];
		for (const [label, options, reason, fix] of cases) {
			const h = options === null ? fakeHome(`guard-${label}`) : fakeHome(`guard-${label}`, options);
			if (options === null) {
				const record = readJson(h.paths.installedPlugins);
				record.plugins['make-custom-app@make-custom-app'][0].installPath = foreignRoot;
				fs.writeFileSync(h.paths.installedPlugins, JSON.stringify(record));
			}
			const planned = planOf(h);
			assert.equal(planned.confirmRequired, false, `${label}: the plan says nothing needs confirming`);
			const before = snapshot(h.home);
			const result = apply(h, BOTH, planned.digest);
			assert.equal(result.status, 2, label);
			assert.equal(result.stderr, '', label);
			assert.deepEqual(result.lines, [`Refused: ${reason} Nothing was changed. Fix: ${fix}`], label);
			assertUntouched(h, before, label);
			assert.deepEqual(mcpCalls(h), [], `${label}: claude was not asked to change anything`);
		}
	});

	it('claudeEntry plugin-bundle and unrelated: the Claude entry is in By hand and never removed; claudeEntry mcp-server-path: removed', POSIX_ONLY, () => {
		for (const claudeEntry of ['plugin-bundle', 'unrelated']) {
			const h = fakeHome(`entry-${claudeEntry}`, { claudeEntry });
			const planned = planOf(h);
			const item = planned.items.find((candidate) => candidate.id === 'claude.mcp-entry');
			assert.equal(item.status, 'manual', claudeEntry);
			assert.ok(planned.lines.some((line) => line.startsWith('By hand')) && planned.lines.some((line) => line.startsWith('  claude.mcp-entry: ')), `${claudeEntry}: listed in By hand`);
			assert.equal(planned.notices.some((notice) => notice.kind === 'claude-backup-copy'), false, claudeEntry);
			const entry = readJson(h.paths.claudeJson).mcpServers['make-custom-app'];
			const result = apply(h, CLAUDE_ONLY, planned.digest);
			assert.equal(result.status, 0, claudeEntry);
			assert.deepEqual(result.lines.filter((line) => line.startsWith('done ')), doneLines('claude.sentinel', 'claude.env-file', 'claude.skill-dir'), claudeEntry);
			assert.deepEqual(readJson(h.paths.claudeJson).mcpServers['make-custom-app'], entry, `${claudeEntry}: the entry is never removed`);
			assert.deepEqual(mcpCalls(h), [], `${claudeEntry}: claude was not asked to remove anything`);
			assert.equal(fs.existsSync(h.paths.claudeSkill), false, `${claudeEntry}: the rest of the group ran`);
		}
		const own = fakeHome('entry-server-path', { claudeEntry: 'mcp-server-path' });
		const planned = planOf(own);
		assert.equal(planned.items.find((candidate) => candidate.id === 'claude.mcp-entry').status, 'ready');
		const result = apply(own, CLAUDE_ONLY, planned.digest);
		assert.equal(result.status, 0);
		assert.equal(hasEntry(own), false);
		assert.deepEqual(result.lines.filter((line) => line.startsWith('done ')), doneLines('claude.mcp-entry', 'claude.sentinel', 'claude.env-file', 'claude.skill-dir'));
	});

	it('a jsonc Cursor file: the member is manual and the rest of the Cursor group runs', POSIX_ONLY, () => {
		const h = fakeHome('cursor-jsonc', { cursorFormat: 'jsonc' });
		const planned = planOf(h);
		assert.equal(planned.items.find((item) => item.id === 'cursor.mcp-entry.make-app-context').status, 'manual');
		const bytes = fs.readFileSync(h.paths.cursorMcp);
		const result = apply(h, ['--groups', 'cursor'], planned.digest);
		assert.equal(result.status, 0);
		assert.deepEqual(result.lines.filter((line) => line.startsWith('done ')), doneLines('cursor.env-file', 'cursor.skill-dir', 'cursor.rules-dir'));
		assert.equal(fs.readFileSync(h.paths.cursorMcp).equals(bytes), true, 'the file with a comment keeps its bytes');
		assert.equal(fs.existsSync(h.paths.cursorSkill), false);
		assert.equal(fs.existsSync(h.paths.cursorRules), false);
		assert.equal(fs.existsSync(h.paths.claudeSkill), true, 'the Claude group was not named');
	});

	it('sentinel unclosed or doubled: manual, the rest runs; a CRLF CLAUDE.md keeps CRLF; a symlinked CLAUDE.md is edited at its target and the link stays', POSIX_ONLY, () => {
		const unclosed = '# My notes\n\n<!-- make-custom-app-skill -->\n# Make Custom App Skill\n\nuse the skill\n';
		const doubled = `# My notes\n\n${INSTALLER_BLOCK}\n\n${INSTALLER_BLOCK}\n`;
		for (const [label, text] of [['unclosed', unclosed], ['doubled', doubled]]) {
			const h = fakeHome(`sentinel-${label}`, { editors: ['claude'] });
			put(h.paths.claudeMd, text, 0o600);
			const planned = planOf(h);
			assert.equal(planned.items.find((item) => item.id === 'claude.sentinel').status, 'manual', label);
			const result = apply(h, CLAUDE_ONLY, planned.digest);
			assert.equal(result.status, 0, label);
			assert.deepEqual(result.lines.filter((line) => line.startsWith('done ')), doneLines('claude.mcp-entry', 'claude.env-file', 'claude.skill-dir'), label);
			assert.equal(fs.readFileSync(h.paths.claudeMd, 'utf8'), text, `${label}: CLAUDE.md keeps its bytes`);
			assert.equal(fs.existsSync(h.paths.claudeSkill), false, `${label}: the rest of the group ran`);
		}

		const crlf = fakeHome('sentinel-crlf', { editors: ['claude'] });
		const notes = '# Notes\r\nmy own line\r\n';
		put(crlf.paths.claudeMd, `${notes}\r\n${INSTALLER_BLOCK.replace(/\n/g, '\r\n')}\r\nafter the block\r\n`, 0o664);
		assert.equal(apply(crlf, CLAUDE_ONLY).status, 0);
		assert.equal(fs.readFileSync(crlf.paths.claudeMd, 'utf8'), `${notes}after the block\r\n`, 'CRLF stays');
		assert.equal(mode(crlf.paths.claudeMd), 0o664, 'and so does the mode');

		const linked = fakeHome('sentinel-link', { editors: ['claude'] });
		const target = path.join(linked.root, 'dotfiles', 'CLAUDE.md');
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.renameSync(linked.paths.claudeMd, target);
		fs.symlinkSync(target, linked.paths.claudeMd);
		assert.equal(apply(linked, CLAUDE_ONLY).status, 0);
		assert.equal(fs.lstatSync(linked.paths.claudeMd).isSymbolicLink(), true, 'the link stays');
		assert.equal(fs.readlinkSync(linked.paths.claudeMd), target);
		assert.equal(fs.readFileSync(target, 'utf8'), '# My notes\n\nAlways invoke the `make-custom-app` skill for Make apps.\n', 'the target is edited');
	});

	it('.env with a conflict, an unknown line, or trailing spaces is kept in the backup; an empty value and a placeholder still delete it, and --restore brings it back byte-equal', POSIX_ONLY, () => {
		const cases = {
			'an unknown line': { text: `${INSTALLER_ENV_TEXT}EXTRA_SETTING=on\n`, kept: true },
			'trailing spaces': { text: INSTALLER_ENV_TEXT.replace(`PINECONE_API_KEY=${FAKE.pinecone}`, `PINECONE_API_KEY=${FAKE.pinecone}  `), kept: true },
			'a conflict': { text: INSTALLER_ENV_TEXT.replace(FAKE.pinecone, FAKE.conflictPinecone), kept: true },
			'an empty value and a placeholder': { text: `# Pinecone\nPINECONE_API_KEY=${FAKE.pinecone}\nPINECONE_INDEX_NAME=\n\n# OpenAI\nOPENAI_API_KEY=your-openai-key\n`, kept: false },
		};
		for (const [label, { text, kept }] of Object.entries(cases)) {
			const h = fakeHome('env-variants', { editors: ['claude'], envText: text });
			const p = h.paths;
			fs.chmodSync(p.claudeEnv, 0o640);
			const planned = planOf(h);
			assert.equal(planned.items.find((item) => item.id === 'claude.env-file').action, kept ? 'keep-in-backup' : 'delete', label);
			const before = stateOf(h);
			const result = apply(h, CLAUDE_ONLY, planned.digest);
			assert.equal(result.status, 0, label);
			const inBackup = path.join(stateDir(h), nameOfBackup(result), 'claude', 'skill-dir', 'mcp-server', '.env');
			assert.equal(fs.existsSync(inBackup), kept, label);
			if (kept) {
				assert.equal(fs.readFileSync(inBackup, 'utf8'), text, `${label}: the backup holds the bytes`);
				assert.equal(mode(inBackup), 0o600, `${label}: at mode 0600`);
			}
			const restored = run(h, ['--restore']);
			assert.equal(restored.status, 0, label);
			assert.equal(fs.readFileSync(p.claudeEnv, 'utf8'), text, `${label}: --restore brings it back byte-equal`);
			assert.equal(mode(p.claudeEnv), 0o640, `${label}: with its old mode`);
			assertBack(h, before, label);
		}
	});

	it('symlinked skill folder: only the link moves, and the target\'s .env keeps its bytes and mode', POSIX_ONLY, () => {
		const h = fakeHome('symlink-skill', { editors: ['claude'], symlinkSkill: true });
		const p = h.paths;
		const planned = planOf(h);
		assert.equal(planned.notices.filter((notice) => notice.kind === 'symlink-target').length, 1);
		assert.equal(
			planned.items.some((item) => item.id === 'claude.env-file'),
			false,
			'a linked skill folder has no env-file item',
		);
		const target = snapshot(p.skillTarget);
		const envBytes = fs.readFileSync(path.join(p.skillTarget, 'mcp-server', '.env'));
		const result = apply(h, CLAUDE_ONLY, planned.digest);
		assert.equal(result.status, 0);
		assert.throws(() => fs.lstatSync(p.claudeSkill), { code: 'ENOENT' }, 'the link is gone from ~/.claude/skills');
		const moved = path.join(stateDir(h), nameOfBackup(result), 'claude', 'skill-dir');
		assert.equal(fs.lstatSync(moved).isSymbolicLink(), true, 'the backup holds the link');
		assert.equal(fs.readlinkSync(moved), p.skillTarget);
		assert.deepEqual(diffSnapshots(target, snapshot(p.skillTarget)), [], 'the link target is untouched');
		assert.equal(fs.readFileSync(path.join(p.skillTarget, 'mcp-server', '.env')).equals(envBytes), true);
		assert.equal(mode(path.join(p.skillTarget, 'mcp-server', '.env')), 0o644);
	});
});

describe('cleanup-legacy.js: claude and its failures', () => {
	it('no claude with the claude group: exit 2 with the CLAUDE_BIN fix, snapshot unchanged', POSIX_ONLY, () => {
		const h = fakeHome('no-claude', { claudeMode: 'none' });
		const plan = run(h, ['--plan']);
		assert.equal(plan.status, 0);
		assert.equal(plan.stderr, `${binLine(h.paths.claudeBin)}\n`, 'the plan says why claude was not found, on stderr');
		const planned = JSON.parse(plan.stdout);
		assert.equal(planned.claude.binary, null);
		assert.equal(planned.items.find((item) => item.id === 'claude.mcp-entry').status, 'blocked');
		const before = snapshot(h.home);
		const result = apply(h, CLAUDE_ONLY, planned.digest);
		assert.equal(result.status, 2);
		assert.equal(result.stderr, '');
		assert.deepEqual(result.lines, [BLOCKED_LINE, binLine(h.paths.claudeBin)]);
		assertUntouched(h, before, 'a missing claude');

		const both = apply(h, BOTH, planned.digest);
		assert.deepEqual([both.status, both.lines], [2, [BLOCKED_LINE, binLine(h.paths.claudeBin)]], 'a blocked item of a named group refuses the whole run');
		assertUntouched(h, before, 'both groups named');

		const wrong = planned.digest === '0123456789abcdef' ? 'fedcba9876543210' : '0123456789abcdef';
		const stale = apply(h, CLAUDE_ONLY, wrong);
		assert.deepEqual([stale.status, stale.lines], [3, [staleLine(wrong, planned.digest)]], 'a stale digest is reported alone');

		const disabled = fakeHome('no-claude-disabled', { claudeMode: 'none', pluginState: 'disabled' });
		const disabledPlan = planOf(disabled);
		const refused = apply(disabled, CLAUDE_ONLY, disabledPlan.digest);
		const DISABLED_LINE = 'Refused: The make-custom-app plugin is installed but disabled. Nothing was changed. Fix: claude plugin enable make-custom-app@make-custom-app';
		assert.deepEqual([refused.status, refused.lines], [2, [DISABLED_LINE, binLine(disabled.paths.claudeBin)]], 'a refusal of the guard comes first, and the claude that the named group needs is explained after it');

		const cursorOnly = apply(disabled, ['--groups', 'cursor'], disabledPlan.digest);
		assert.deepEqual([cursorOnly.status, cursorOnly.lines], [2, [DISABLED_LINE]], 'a blocked item of a group that is not named adds no CLAUDE_BIN line');

		const manual = fakeHome('no-claude-manual', { claudeMode: 'none', pluginState: 'disabled', claudeEntry: 'plugin-bundle' });
		const manualPlan = planOf(manual);
		assert.equal(manualPlan.items.find((item) => item.id === 'claude.mcp-entry').status, 'manual');
		assert.equal(manualPlan.items.some((item) => item.status === 'blocked'), false, 'no item needs claude');
		const unneeded = apply(manual, CLAUDE_ONLY, manualPlan.digest);
		assert.deepEqual([unneeded.status, unneeded.lines], [2, [DISABLED_LINE]], 'without a blocked item there is no CLAUDE_BIN line, although CLAUDE_BIN is set and unusable');
	});

	it('a missing claude does not stop a Cursor-only apply, and a blocked group that is not named adds no CLAUDE_BIN line', POSIX_ONLY, () => {
		const h = fakeHome('no-claude-cursor', { claudeMode: 'none' });
		const planned = planOf(h);
		const result = apply(h, ['--groups', 'cursor'], planned.digest);
		assert.equal(result.status, 0);
		assert.deepEqual(result.lines.filter((line) => line.startsWith('done ')), doneLines('cursor.mcp-entry.make-app-context', 'cursor.env-file', 'cursor.skill-dir', 'cursor.rules-dir'));
		assert.equal(fs.existsSync(h.paths.claudeSkill), true, 'the Claude group was not named');
		assert.equal(hasEntry(h), true);
	});

	it('a CLAUDE_BIN that is relative is refused although the file is there, and one with control characters is shown with question marks', POSIX_ONLY, () => {
		const h = fakeHome('claude-bin-relative');
		const fromBin = { env: { ...h.env, CLAUDE_BIN: 'claude' }, cwd: h.binDir };
		const plan = run(h, ['--plan'], fromBin);
		assert.equal(plan.status, 0);
		assert.equal(plan.stderr, `${binLine('claude')}\n`);
		assert.equal(JSON.parse(plan.stdout).claude.binary, null);
		const before = snapshot(h.home);
		const refused = apply(h, CLAUDE_ONLY, JSON.parse(plan.stdout).digest, fromBin);
		assert.deepEqual([refused.status, refused.lines.at(-1)], [2, binLine('claude')]);
		assertUntouched(h, before, 'a relative CLAUDE_BIN');

		const shown = run(h, ['--plan'], { env: { ...h.env, CLAUDE_BIN: '/nonexistent/a\u0001b\nc\u2028d' } });
		assert.equal(shown.stderr, `${binLine('/nonexistent/a?b?c?d')}\n`);

		const good = run(h, ['--plan']);
		assert.equal(good.stderr, '', 'a usable CLAUDE_BIN gives no line');
		assert.equal(JSON.parse(good.stdout).claude.binary, h.paths.claudeBin);
	});

	it('a CLAUDE_BIN that is not set adds no CLAUDE_BIN line, only the fix of the blocked item', { skip: process.platform === 'win32' || hostHasClaudeFallback }, () => {
		const h = fakeHome('claude-bin-unset', { claudeMode: 'none' });
		const { CLAUDE_BIN, ...env } = h.env;
		assert.ok(CLAUDE_BIN, 'the helper sets it, and this case removes it');
		const plan = run(h, ['--plan'], { env });
		assert.equal(plan.stderr, '');
		assert.equal(JSON.parse(plan.stdout).claude.binary, null);
		const before = snapshot(h.home);
		const refused = apply(h, CLAUDE_ONLY, JSON.parse(plan.stdout).digest, { env });
		assert.deepEqual([refused.status, refused.lines], [2, [BLOCKED_LINE]]);
		assertUntouched(h, before, 'an unset CLAUDE_BIN');
	});

	it('a failing claude: exit 4 and no folder moved', POSIX_ONLY, () => {
		const h = fakeHome('claude-fails', { claudeMode: 'fail' });
		const planned = planOf(h);
		const before = snapshot(h.home);
		const result = apply(h, BOTH, planned.digest);
		assert.equal(result.status, 4);
		assert.equal(result.stderr, '');
		const name = nameOfBackup(result);
		assert.deepEqual(result.lines, ['failed  claude.mcp-entry: simulated failure', `Backup: ~/.make-custom-app/${name}`, undoLine, PARTIAL_LINE]);
		assert.deepEqual(diffSnapshots(before, snapshot(h.home, { exclude: ['.make-custom-app'] })), [], 'nothing of the old install moved');
		const dir = path.join(stateDir(h), name);
		assert.equal(fs.existsSync(path.join(dir, 'claude', 'skill-dir')), false);
		assert.equal(manifestOf(h, name).status, 'partial');
		assert.deepEqual(manifestOf(h, name).steps.map((step) => step.state).slice(0, 2), ['running', 'pending']);
		assert.equal(mcpCalls(h).length, 3, 'three attempts');
	});

	it('echo-secrets: no fake value on stdout or stderr', POSIX_ONLY, () => {
		const h = fakeHome('echo-secrets', { claudeMode: 'echo-secrets' });
		const planned = run(h, ['--plan']);
		assert.deepEqual(leaks(planned.stdout + planned.stderr), []);
		const result = apply(h, BOTH, JSON.parse(planned.stdout).digest);
		assert.equal(result.status, 0);
		assert.deepEqual(leaks(result.stdout + result.stderr), []);
		const dir = path.join(stateDir(h), nameOfBackup(result));
		for (const seed of SECRET_SEEDS) assert.deepEqual(filesHolding(dir, seed), [], `${seed} in the backup`);
		const restored = run(h, ['--restore']);
		assert.equal(restored.status, 0);
		assert.deepEqual(leaks(restored.stdout + restored.stderr), []);
	});
});

describe('cleanup-legacy.js: the lock during a run', () => {
	it('the lock is held while claude runs, for the apply and for the restore, and is gone after each', POSIX_ONLY, () => {
		const h = fakeHome('lock-during');
		const log = path.join(h.root, 'lock-state.log');
		const shim = path.join(h.root, 'shim', 'claude');
		put(shim, `#!/bin/sh\nif [ -f "$HOME/.make-custom-app/cleanup.lock" ]; then echo "held $1 $2" >> "${log}"; else echo "free $1 $2" >> "${log}"; fi\nexec "${h.paths.claudeBin}" "$@"\n`, 0o755);
		const env = { ...h.env, CLAUDE_BIN: shim };
		const digest = planOf(h, { env }).digest;
		assert.equal(fs.readFileSync(log, 'utf8'), 'free --version \n', 'the plan takes no lock');
		fs.writeFileSync(log, '');

		const applied = apply(h, BOTH, digest, { env });
		assert.equal(applied.status, 0, applied.stdout);
		assert.equal(fs.readFileSync(log, 'utf8'), 'held --version \nheld mcp remove\n', 'the facts are gathered and claude removes the entry while the lock is held');
		assert.equal(fs.existsSync(lockFile(h)), false);

		fs.writeFileSync(log, '');
		const restored = run(h, ['--restore'], { env });
		assert.equal(restored.status, 0, restored.stdout);
		assert.ok(fs.readFileSync(log, 'utf8').split('\n').includes('held mcp add-json'), 'claude adds the entry back while the lock is held');
		assert.equal(fs.readFileSync(log, 'utf8').includes('free'), false);
		assert.equal(fs.existsSync(lockFile(h)), false);
	});
});

describe('cleanup-legacy.js: the spawn guard of these tests', () => {
	it('a CLAUDE_BIN that points outside the test root is never started: the preload refuses it and the test sees the refusal', POSIX_ONLY, () => {
		const h = fakeHome('guard-outside');
		const link = path.join(h.root, 'link-to-node');
		fs.symlinkSync(process.execPath, link);
		try {
			for (const [label, bin] of [['a file outside the root', process.execPath], ['a link inside the root to a file outside it', link]]) {
				const env = { ...h.env, CLAUDE_BIN: bin };
				const plan = run(h, ['--plan'], { env, refused: true });
				assert.equal(plan.status, 0, label);
				assert.deepEqual(plan.refused, [bin], `${label}: the start was refused and recorded`);
				assert.equal(plan.stderr, `${binLine(bin)}\n`, `${label}: the script took it for no claude`);
				assert.equal(JSON.parse(plan.stdout).claude.binary, null, label);
				const refused = apply(h, CLAUDE_ONLY, JSON.parse(plan.stdout).digest, { env, refused: true });
				assert.deepEqual([refused.status, refused.lines, refused.refused], [2, [BLOCKED_LINE, binLine(bin)], [bin]], label);
				assert.throws(() => run(h, ['--plan'], { env }), /a program outside the test root was started/, `${label}: without refused: true the running test fails`);
				assert.equal(fs.existsSync(refusedFile), false, 'the marker is taken with every run');
			}
		} finally {
			takeRefusedStarts();
		}
	});

	it('the preload refuses every way to start a program that is not an absolute path inside the root (a bare name or a relative path too, although the working folder holds that file), and lets the fake claude of the case run', POSIX_ONLY, () => {
		const h = fakeHome('guard-apis');
		const env = { ...h.env, NODE_OPTIONS: `--require ${JSON.stringify(guardFile)}` };
		const attempt = (call) => spawnSync(process.execPath, ['-e', `const c = require('child_process'); try { ${call}; console.log('started'); } catch (e) { console.log('refused'); }`], { env, cwd: h.binDir, encoding: 'utf8' }).stdout.trim();
		const refusedCalls = [
			"c.spawnSync('/bin/echo', ['x'])",
			"c.spawn('/bin/echo', ['x'])",
			"c.execFileSync('/bin/echo', ['x'])",
			"c.execFile('/bin/echo', ['x'], () => {})",
			"c.execSync('echo x')",
			"c.exec('echo x', () => {})",
			"c.fork('/bin/echo')",
			"c.spawnSync('echo', ['x'])",
			"c.spawnSync('./claude', ['--version'])",
			"c.spawnSync('claude', ['--version'])",
		];
		try {
			for (const call of refusedCalls) assert.equal(attempt(call), 'refused', call);
			assert.equal(takeRefusedStarts().length, refusedCalls.length, 'each refusal is recorded');
			const fake = JSON.stringify(h.paths.claudeBin);
			assert.equal(attempt(`c.spawnSync(${fake}, ['--version'])`), 'started');
			assert.equal(attempt(`c.execFileSync(${fake}, ['--version'])`), 'started');
			assert.deepEqual(takeRefusedStarts(), [], 'the fake claude of the case is not refused');
		} finally {
			takeRefusedStarts();
		}
	});
});

describe('cleanup-legacy.js: a writer of ~/.claude.json', () => {
	// The writer of the helper is an unsynchronized read-modify-write (Ruling 29): a stale write of it can undo a removal, and a
	// writer that is not scheduled for a while misses the moment that a case aims at. Both cases wait until the writer has
	// written and try up to six times. The counter case keeps one home and one writer and runs the script again (as a user
	// would) until the entry is gone; resurrect-always starts a fresh home and a fresh writer per try, for the outcome that
	// the writer put the entry back each time. What must hold on every try is asserted on every try. No other case runs a writer.
	const TRIES = 6;
	const OTHER = { command: 'node', args: ['/opt/other.js'], env: { API_TOKEN: FAKE.otherToken } };

	async function writerHasWritten(h) {
		for (let i = 0; i < 400; i++) {
			try {
				if (readJson(h.paths.claudeJson).writerCounter >= 1) return;
			} catch {
				// the file is being replaced at this moment
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.fail('the writer never wrote');
	}

	async function withWriter(label, writerMode, body) {
		const h = fakeHome(label, { editors: ['claude'] });
		const writer = startWriter({ file: h.paths.claudeJson, mode: writerMode, entry: readJson(h.paths.claudeJson).mcpServers['make-custom-app'] });
		let outcome;
		let stats;
		try {
			await writerHasWritten(h);
			outcome = body(h);
		} finally {
			stats = await writer.stop();
		}
		const json = readJson(h.paths.claudeJson);
		assert.deepEqual(json.mcpServers['other-server'], OTHER, 'on every try: the file parses and other-server is intact');
		return { h, json, stats, ...outcome };
	}

	function applyUntilGone(h) {
		let last = null;
		let attempts = 0;
		while (attempts < TRIES) {
			attempts += 1;
			last = apply(h, CLAUDE_ONLY);
			assert.ok([0, 4].includes(last.status), `attempt ${attempts}: ${last.stdout}${last.stderr}`);
			if (last.status === 0) break;
		}
		return { last, attempts };
	}

	it('a writer rewriting ~/.claude.json every 5 ms during --apply: parses, other-server intact, the entry gone', POSIX_ONLY, async () => {
		const t = await withWriter('writer-counter', 'counter', applyUntilGone);
		assert.equal(t.last.status, 0, `done after ${t.attempts} applies: ${t.last.stdout}`);
		assert.equal(Object.hasOwn(t.json.mcpServers, 'make-custom-app'), false, 'the entry is gone');
		assert.equal(t.json.numStartups, 7);
		assert.ok(t.stats.writes >= 1 && t.json.writerCounter >= 1, 'the writer ran while the script did');
		assert.equal(mode(t.h.paths.claudeJson), 0o600);
		assert.equal(fs.existsSync(t.h.paths.claudeSkill), false, 'the rest of the group ran');
	});

	it('resurrect-always: exit 4 with the restart text', POSIX_ONLY, async () => {
		let seen = null;
		for (let attempt = 1; attempt <= TRIES && seen === null; attempt++) {
			const t = await withWriter('writer-always', 'resurrect-always', (h) => ({ result: apply(h, CLAUDE_ONLY) }));
			assert.ok([0, 4].includes(t.result.status), t.result.stdout);
			assert.ok(mcpCalls(t.h).length <= 3, 'on every try: at most three removals');
			if (t.result.status === 4 && t.result.lines[0] === `failed  claude.mcp-entry: ${RESTART_TEXT}`) seen = t;
		}
		assert.ok(seen, 'one of the tries met a writer that put the entry back each time');
		assert.equal(seen.result.stderr, '');
		assert.equal(seen.result.lines.at(-1), PARTIAL_LINE);
		assert.equal(Object.hasOwn(seen.json.mcpServers, 'make-custom-app'), true, 'the entry is back');
		assert.equal(fs.existsSync(seen.h.paths.claudeSkill), true, 'nothing after the entry ran');
		assert.equal(fs.readFileSync(seen.h.paths.claudeMd, 'utf8').includes('<!-- make-custom-app-skill -->'), true);
	});
});


describe('cleanup-legacy.js: failures inside the apply', () => {
	it('applySteps throws before its first change: the exit is 1 with the line that says nothing was changed, and no backup folder is left behind', { skip: process.platform === 'win32' || !notRoot() }, () => {
		const h = fakeHome('apply-throws', { editors: ['claude'] });
		// A claude that makes the state folder read-only while the script gathers its facts, so the backup folder cannot be created.
		const shim = path.join(h.root, 'shim', 'claude');
		put(shim, '#!/bin/sh\n/bin/chmod 500 "$HOME/.make-custom-app"\necho "2.1.312 (Claude Code)"\n', 0o755);
		const env = { ...h.env, CLAUDE_BIN: shim };
		const planned = planOf(h, { env });
		const before = snapshot(h.home);
		let result;
		try {
			result = apply(h, CLAUDE_ONLY, planned.digest, { env });
		} finally {
			if (fs.existsSync(stateDir(h))) fs.chmodSync(stateDir(h), 0o700);
		}
		assert.equal(result.status, 1);
		assert.equal(result.stdout, '');
		assert.equal(result.stderr, `cleanup-legacy: nothing was changed: EACCES on ${stateDir(h)}\n`);
		assertUntouched(h, before, 'a backup folder that cannot be created');
	});

	it('a read-only mcp-server folder makes the env-file step fail: exit 4, and --restore undoes only the done steps', { skip: process.platform === 'win32' || !notRoot() }, () => {
		const h = fakeHome('env-readonly', { editors: ['claude'] });
		const p = h.paths;
		const folder = path.join(p.claudeSkill, 'mcp-server');
		fs.chmodSync(folder, 0o555);
		try {
			const planned = planOf(h);
			const before = stateOf(h);
			const result = apply(h, CLAUDE_ONLY, planned.digest);
			assert.equal(result.status, 4);
			const name = nameOfBackup(result);
			assert.deepEqual(result.lines.slice(0, 3), [...doneLines('claude.mcp-entry', 'claude.sentinel'), `failed  claude.env-file: EACCES on ${p.claudeEnv}`]);
			assert.equal(result.lines.at(-1), PARTIAL_LINE);
			assert.equal(fs.existsSync(p.claudeEnv), true, 'the .env is still there');
			assert.equal(fs.existsSync(p.claudeSkill), true, 'and so is the folder: nothing after the failed step ran');
			assert.equal(hasEntry(h), false);
			assert.equal(fs.readFileSync(p.claudeMd, 'utf8').includes('<!-- make-custom-app-skill -->'), false);
			assert.equal(manifestOf(h, name).status, 'partial');

			const restored = run(h, ['--restore']);
			assert.equal(restored.status, 0, restored.stdout);
			assert.deepEqual(
				restored.lines.filter((line) => line.startsWith('restored ')),
				restoredLines('claude.sentinel', 'claude.mcp-entry'),
				'only the done steps are undone',
			);
			assert.equal(restored.lines.at(-1), RESTART_LINE);
			assertBack(h, before, 'the home is back as it was');
		} finally {
			fs.chmodSync(folder, 0o755);
		}
	});
});

describe('cleanup-legacy.js: the lock', () => {
	function deadPid() {
		const child = spawnSync(process.execPath, ['-e', '']);
		assert.ok(child.pid > 0);
		return child.pid;
	}

	function writeLock(h, pid, at = Date.now()) {
		put(lockFile(h), JSON.stringify({ pid, at }), 0o600);
	}

	it('a held lock exits 2; a stale lock is replaced; a fresh empty lock file is held, and so is a takeover file left behind (exit 2, the exact line without a pid, with the delete hint)', POSIX_ONLY, () => {
		const h = fakeHome('lock');
		const digest = digestOf(h);
		const before = snapshot(h.home);

		writeLock(h, process.pid);
		const lockBytes = fs.readFileSync(lockFile(h));
		const held = apply(h, BOTH, digest);
		assert.deepEqual([held.status, held.stderr, held.lines], [2, '', [`Another cleanup is running (lock ${LOCK}, pid ${process.pid}). Nothing was changed.`]]);
		assert.equal(fs.readFileSync(lockFile(h)).equals(lockBytes), true, 'the lock of the other run is left alone');
		assertUntouched(h, before, 'a held lock');

		fs.writeFileSync(lockFile(h), '');
		const empty = apply(h, BOTH, digest);
		assert.deepEqual([empty.status, empty.stderr, empty.lines], [2, '', [HELD_WITHOUT_PID]]);
		assert.equal(fs.existsSync(lockFile(h)), true, 'an empty lock of a run that is just starting is not taken');

		writeLock(h, deadPid());
		fs.writeFileSync(`${lockFile(h)}.takeover`, '', { mode: 0o600 });
		const takeover = apply(h, BOTH, digest);
		assert.deepEqual([takeover.status, takeover.stderr, takeover.lines], [2, '', [HELD_WITHOUT_PID]]);
		assert.equal(fs.existsSync(`${lockFile(h)}.takeover`), true, 'a takeover file that a crash left is never reaped');
		assertUntouched(h, before, 'a lock without a pid');

		fs.unlinkSync(`${lockFile(h)}.takeover`);
		const stale = apply(h, BOTH, digest);
		assert.equal(stale.status, 0, 'a lock of a pid that is gone is replaced');
		assert.deepEqual(fs.readdirSync(stateDir(h)), [nameOfBackup(stale)], 'and the lock is released at the end');
	});

	it('a lock whose time is too old is replaced even when its pid is alive', POSIX_ONLY, () => {
		const h = fakeHome('lock-old');
		const digest = digestOf(h);
		writeLock(h, process.pid, Date.now() - 11 * 60 * 1000);
		const result = apply(h, ['--groups', 'cursor'], digest);
		assert.equal(result.status, 0);
		assert.equal(fs.existsSync(lockFile(h)), false);
	});
});

describe('cleanup-legacy.js: --decline', () => {
	it('--decline writes the marker with mode 0600 and exits 0; a stale digest exits 3', POSIX_ONLY, () => {
		const h = fakeHome('decline');
		const planned = planOf(h);
		const before = snapshot(h.home);
		const wrong = planned.digest === '0123456789abcdef' ? 'fedcba9876543210' : '0123456789abcdef';
		const refused = run(h, ['--decline', wrong]);
		assert.deepEqual([refused.status, refused.stderr, refused.lines], [3, '', [staleLine(wrong, planned.digest)]]);
		assert.equal(fs.existsSync(path.join(stateDir(h), 'legacy-cleanup.json')), false, 'a stale digest writes no marker');

		const started = Date.now();
		const result = run(h, ['--decline', planned.digest]);
		const ended = Date.now();
		assert.deepEqual([result.status, result.stderr, result.lines], [0, '', [DECLINED]]);
		const marker = path.join(stateDir(h), 'legacy-cleanup.json');
		assert.equal(mode(marker), 0o600);
		const text = fs.readFileSync(marker, 'utf8');
		const parsed = JSON.parse(text);
		assert.equal(text, JSON.stringify({ schema: 1, declinedAt: parsed.declinedAt, digest: planned.digest }), 'exactly the three fields');
		assert.match(parsed.declinedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		assert.ok(Date.parse(parsed.declinedAt) >= started - 1000 && Date.parse(parsed.declinedAt) <= ended + 1000);
		assert.deepEqual(fs.readdirSync(stateDir(h)), ['legacy-cleanup.json'], 'no lock and no temp file is left');
		assert.deepEqual(diffSnapshots(before, snapshot(h.home, { exclude: ['.make-custom-app'] })), []);
		assert.deepEqual(readLog(h).map((entry) => entry.argv), [['--version']], 'only the plan asked claude for a version: a decline does not start it');
	});

	it('--decline reads the plan with the environment of the run: a CLAUDE_CONFIG_DIR that is not the default changes the plan and its digest', POSIX_ONLY, () => {
		const h = fakeHome('decline-config-dir');
		const env = { ...h.env, CLAUDE_CONFIG_DIR: path.join(h.root, 'other-config') };
		const defaultDigest = digestOf(h);
		const planned = planOf(h, { env });
		assert.equal(planned.items.find((item) => item.id === 'claude.mcp-entry').status, 'manual', 'the registration of another config folder is not touched');
		assert.notEqual(planned.digest, defaultDigest);
		const result = run(h, ['--decline', planned.digest], { env });
		assert.deepEqual([result.status, result.stderr, result.lines], [0, '', [DECLINED]]);
		assert.equal(run(h, ['--decline', defaultDigest], { env }).status, 3, 'the digest of the plan of another environment is stale');
	});
});

describe('cleanup-legacy.js: usage and unexpected errors', () => {
	it('usage errors exit 1 with the exact texts', POSIX_ONLY, () => {
		const h = fakeHome('usage');
		const digest = '0123456789abcdef';
		const cases = [
			[[], USAGE],
			[['--bogus'], USAGE],
			[['--plan', 'extra'], USAGE],
			[['--plan', '--apply', digest, ...BOTH], USAGE],
			[['--groups', 'claude'], USAGE],
			[['--restore', '--groups', 'claude'], USAGE],
			[['--apply'], DIGEST_ERROR],
			[['--apply', 'NOTADIGEST', ...BOTH], DIGEST_ERROR],
			[['--decline'], DIGEST_ERROR],
			[['--apply', digest], GROUPS_ERROR],
			[['--apply', digest, '--groups', 'claude,desktop'], 'Unknown group "desktop"; use claude, cursor, or claude,cursor.'],
		];
		for (const [args, text] of cases) {
			const result = run(h, args);
			assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', `${text}\n`], args.join(' '));
		}
		assert.equal(fs.existsSync(stateDir(h)), false, 'no usage error creates a state folder');
		assert.deepEqual(readLog(h), [], 'and none starts claude');
		const stripped = run(h, ['--apply', digest, '--editor', 'claude']);
		assert.equal(stripped.stderr, `${GROUPS_ERROR}\n`, '--editor never reaches the argument parser');
	});

	it('an unexpected error prints one line with the code and the state folder, never the message of the error', POSIX_ONLY, () => {
		const h = fakeHome('unexpected');
		const digest = digestOf(h);
		const before = snapshot(h.home);
		put(stateDir(h), `${FAKE.pinecone}\n`);
		for (const args of [['--apply', digest, ...BOTH], ['--decline', digest]]) {
			const result = run(h, args);
			assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', `cleanup-legacy: unexpected error: EEXIST on ${stateDir(h)}\n`], args[0]);
		}
		fs.rmSync(stateDir(h));
		assert.deepEqual(diffSnapshots(before, snapshot(h.home)), []);
	});

	it('a home folder that is empty or not an absolute path stops every mode with one fixed line before it creates anything in the current folder', POSIX_ONLY, () => {
		const h = fakeHome('relative-home');
		const digest = '0123456789abcdef';
		const cwd = path.join(h.root, 'cwd');
		fs.mkdirSync(cwd);
		const line = 'cleanup-legacy: HOME is not an absolute path. Nothing was changed.\n';
		for (const home of ['', 'relative-home', '.']) {
			for (const args of [['--plan'], ['--apply', digest, ...BOTH], ['--restore'], ['--restore', 'migration-backup-2026-10-30T12-00-00Z'], ['--decline', digest], [], ['--bogus']]) {
				const result = run(h, args, { env: { ...h.env, HOME: home }, cwd });
				assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', line], `${args.join(' ') || 'no arguments'} with HOME ${JSON.stringify(home)}: a bad HOME is reported as HOME, also before a usage error`);
				assert.deepEqual(fs.readdirSync(cwd), [], 'nothing is created in the current folder');
			}
		}
		const usage = run(h, ['--bogus']);
		assert.deepEqual([usage.status, usage.stdout, usage.stderr], [1, '', `${USAGE}\n`], 'with a good HOME a usage error has its own text');
	});
});

describe('cleanup-legacy.js: --restore', () => {
	it('--restore without a backup folder exits 2 and creates nothing', POSIX_ONLY, () => {
		const h = fakeHome('restore-none');
		const before = snapshot(h.home);
		const result = run(h, ['--restore']);
		assert.deepEqual([result.status, result.stderr, result.lines], [2, '', ['Nothing to restore: no backup folder in ~/.make-custom-app.']]);
		assert.deepEqual(diffSnapshots(before, snapshot(h.home)), [], 'not even the state folder or its lock');
	});

	it('--restore when every backup is restored exits 0; with two unrestored backups it restores the newest and names the other', POSIX_ONLY, () => {
		const h = fakeHome('restore-three');
		const before = stateOf(h);
		const digest = digestOf(h);
		const first = apply(h, BOTH, digest);
		reinstall(h);
		const second = apply(h, BOTH, digest);
		reinstall(h);
		const third = apply(h, BOTH, digest);
		assert.deepEqual([first.status, second.status, third.status], [0, 0, 0]);
		const [oldest, middle, newest] = [nameOfBackup(first), nameOfBackup(second), nameOfBackup(third)].sort();
		const statuses = () => [oldest, middle, newest].map((name) => manifestOf(h, name).status);
		const others = (...names) => `Other backups not restored: ${names.join(', ')}. Restore one with --restore <name>.`;

		const one = run(h, ['--restore']);
		assert.equal(one.status, 0, one.stdout);
		assert.deepEqual(one.lines, [...restoredLines(...[...ALL_STEPS].reverse()), ADD_JSON_NOTE, RESTART_LINE, others(middle, oldest)], 'the newest backup is restored, and the others are named newest first');
		assert.deepEqual(statuses(), ['complete', 'complete', 'restored']);
		assert.equal(hasEntry(h), true);

		const two = run(h, ['--restore']);
		assert.equal(two.status, 0, two.stdout);
		assert.equal(two.lines.at(-1), others(oldest), 'a restored backup is never named, and a bare --restore skips it');
		assert.deepEqual(statuses(), ['complete', 'restored', 'restored']);

		const last = run(h, ['--restore']);
		assert.equal(last.status, 0, last.stdout);
		assert.equal(last.lines.some((line) => line.startsWith('Other backups')), false, 'nothing is left to name');
		assert.deepEqual(statuses(), ['restored', 'restored', 'restored']);
		assertBack(h, before, 'the home is back as it was');
		const done = run(h, ['--restore']);
		assert.deepEqual([done.status, done.lines], [0, ['Nothing to restore: every backup in ~/.make-custom-app is already restored.']]);

		const fourth = nameOfBackup(apply(h, BOTH, digest));
		const named = run(h, ['--restore', oldest]);
		assert.equal(named.status, 0, named.stdout);
		assert.equal(named.lines.some((line) => line.startsWith('Other backups')), false, 'a given name restores that backup and names no other, although one is not restored');
		assert.equal(manifestOf(h, fourth).status, 'complete');
		assert.equal(run(h, ['--restore']).status, 0);
		assert.equal(manifestOf(h, fourth).status, 'restored');
		assertBack(h, before, 'and the home is back again');
	});

	it('--restore with a failed step (exit 4) prints the failed line and the hint line, and a bare --restore picks the same backup again; a hostile manifest prints its exit 2 text unchanged', POSIX_ONLY, () => {
		const h = fakeHome('restore-failed', { editors: ['claude'] });
		const before = stateOf(h);
		const applied = apply(h, CLAUDE_ONLY);
		const name = nameOfBackup(applied);
		const secretsText = fs.readFileSync(h.paths.secrets, 'utf8');
		fs.writeFileSync(h.paths.secrets, secretsText.split('\n').filter((line) => !line.startsWith('openai-api-key')).join('\n'));
		const MISSING = 'the secrets file has no openai-api-key any more';
		const HINT = `Some steps could not be restored from ${name}. The failed lines say why. Run --restore ${name} again after you fix that.`;

		const first = run(h, ['--restore']);
		assert.equal(first.status, 4);
		assert.equal(first.stderr, '');
		assert.deepEqual(first.lines, ['restored claude.skill-dir', `failed   claude.env-file: ${MISSING}`, 'restored claude.sentinel', `failed   claude.mcp-entry: ${MISSING}`, RESTART_LINE, HINT]);
		assert.equal(manifestOf(h, name).status, 'partially-restored');

		const second = run(h, ['--restore']);
		assert.equal(second.status, 4, 'a bare --restore picks the same backup again');
		assert.equal(second.lines.at(-1), HINT);
		assert.equal(second.lines.some((line) => line.startsWith('Other backups')), false);
		fs.writeFileSync(h.paths.secrets, secretsText);
		const third = run(h, ['--restore', name]);
		assert.equal(third.status, 0);
		assert.equal(third.lines.some((line) => line.startsWith('Some steps')), false, 'no hint once the restore is complete');
		assertBack(h, before, 'the home is back as it was');

		const hostile = fakeHome('restore-hostile', { editors: ['claude'] });
		const hostileName = nameOfBackup(apply(hostile, CLAUDE_ONLY));
		const manifestFile = path.join(stateDir(hostile), hostileName, 'manifest.json');
		const manifest = readJson(manifestFile);
		const foreign = path.join(hostile.root, 'elsewhere');
		stepOf(manifest, 'claude.skill-dir').original = foreign;
		fs.writeFileSync(manifestFile, JSON.stringify(manifest));
		const snap = snapshot(hostile.root, { exclude: ['claude-log.jsonl'] });
		const refused = run(hostile, ['--restore']);
		assert.deepEqual([refused.status, refused.stderr, refused.lines], [2, '', [`Cannot restore ~/.make-custom-app/${hostileName}: the manifest names ${foreign}, which is not a place the cleanup moves. Nothing was changed.`]]);
		assert.deepEqual(diffSnapshots(snap, snapshot(hostile.root, { exclude: ['claude-log.jsonl'] })), [], 'nothing was moved');
	});

	it('a partial restore of the newest backup prints the hint line first, then the other backups', POSIX_ONLY, () => {
		const h = fakeHome('restore-partial-others', { editors: ['claude'] });
		const digest = digestOf(h);
		const first = nameOfBackup(apply(h, CLAUDE_ONLY, digest));
		reinstall(h);
		const second = nameOfBackup(apply(h, CLAUDE_ONLY, digest));
		const [older, newer] = [first, second].sort();
		fs.writeFileSync(h.paths.secrets, fs.readFileSync(h.paths.secrets, 'utf8').split('\n').filter((line) => !line.startsWith('openai-api-key')).join('\n'));
		const result = run(h, ['--restore']);
		assert.equal(result.status, 4, result.stdout);
		assert.deepEqual(result.lines.slice(-3), [
			RESTART_LINE,
			`Some steps could not be restored from ${newer}. The failed lines say why. Run --restore ${newer} again after you fix that.`,
			`Other backups not restored: ${older}. Restore one with --restore <name>.`,
		]);
	});

	it('--restore holds the lock: a held lock exits 2 before any step runs', POSIX_ONLY, () => {
		const h = fakeHome('restore-lock');
		const applied = apply(h);
		assert.equal(applied.status, 0);
		put(lockFile(h), JSON.stringify({ pid: process.pid, at: Date.now() }), 0o600);
		const before = snapshot(h.home);
		const calls = mcpCalls(h).length;
		const result = run(h, ['--restore']);
		assert.deepEqual([result.status, result.stderr, result.lines], [2, '', [`Another cleanup is running (lock ${LOCK}, pid ${process.pid}). Nothing was changed.`]]);
		assert.deepEqual(diffSnapshots(before, snapshot(h.home)), [], 'no step ran');
		assert.equal(mcpCalls(h).length, calls, 'claude was not asked to add anything');
		assert.equal(manifestOf(h, nameOfBackup(applied)).status, 'complete');
	});

	it('--restore with a folder name and with the absolute path of the same backup restores the same way (exit 0)', POSIX_ONLY, () => {
		for (const [label, spelling] of [
			['the folder name', (h, name) => name],
			['the absolute path', (h, name) => path.join(stateDir(h), name)],
			['the absolute path with a trailing slash', (h, name) => `${path.join(stateDir(h), name)}/`],
		]) {
			const h = fakeHome('restore-spelling');
			const before = stateOf(h);
			const name = nameOfBackup(apply(h));
			const result = run(h, ['--restore', spelling(h, name)]);
			assert.equal(result.status, 0, `${label}: ${result.stdout}`);
			assert.deepEqual(result.lines, [...restoredLines(...[...ALL_STEPS].reverse()), ADD_JSON_NOTE, RESTART_LINE], label);
			assertBack(h, before, label);
		}
	});

	it('--restore names a backup that is not there: exit 2 with the argument shown safely', POSIX_ONLY, () => {
		const h = fakeHome('restore-unknown');
		const name = nameOfBackup(apply(h));
		const before = snapshot(h.home);
		const elsewhere = path.join(h.root, 'elsewhere', name);
		fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
		fs.cpSync(path.join(stateDir(h), name), elsewhere, { recursive: true });
		for (const argument of ['nosuch', 'migration-backup-2020-01-01T00-00-00Z', 'migration-backup-bad', '../x', elsewhere, `${stateDir(h)}/../.make-custom-app/${name}`, 'a\nb\u0001c']) {
			const result = run(h, ['--restore', argument]);
			assert.deepEqual([result.status, result.stderr, result.lines], [2, '', [`No backup named ${argument.replace(/[\x00-\x1f]/g, '?')} in ~/.make-custom-app.`]], argument);
		}
		assert.deepEqual(diffSnapshots(before, snapshot(h.home)), [], 'nothing was restored');
	});

	it('an unexpected error (a malformed manifest under --restore) prints no FAKE value', POSIX_ONLY, () => {
		const h = fakeHome('restore-malformed', { secrets: 'conflict' });
		const name = nameOfBackup(apply(h));
		const manifestFile = path.join(stateDir(h), name, 'manifest.json');
		const text = fs.readFileSync(manifestFile, 'utf8');
		const cut = text.slice(0, text.indexOf(FAKE.pinecone) + FAKE.pinecone.length);
		assert.ok(cut.length < text.length && cut.includes(FAKE.pinecone), 'the cut manifest holds a fake value right before it ends');
		fs.writeFileSync(manifestFile, cut);
		const before = snapshot(h.home);
		for (const args of [['--restore'], ['--restore', name]]) {
			const result = run(h, args);
			assert.deepEqual([result.status, result.stderr, result.lines], [2, '', [`Cannot restore ~/.make-custom-app/${name}: ${manifestFile} is not valid JSON. Nothing was changed.`]]);
			assert.deepEqual(leaks(result.stdout + result.stderr), []);
		}
		assert.deepEqual(diffSnapshots(before, snapshot(h.home)), [], 'nothing was changed');
	});
});
