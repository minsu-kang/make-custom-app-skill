const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { getSkillRoot, getEditorDir } = require('./skill-root');

/**
 * Deterministic skill-version guard.
 *
 * The SKILL.md "Version Check & Auto-Update" step is an agent instruction, so it
 * is skipped whenever the agent forgets (every fresh session is a fresh agent
 * with no memory of the rule). This guard enforces the same check in code: it
 * runs at the top of EVERY entry script the agent can invoke (download-app,
 * review-changes, update-app, create/update/delete-component, test-function,
 * test-component, post-review-transition, download-jira-ticket-attachment), so
 * an outdated skill blocks real work no matter which script runs first and
 * regardless of agent discipline.
 *
 * Behaviour:
 *   - up to date / network error / unreadable state -> fail OPEN (never block work)
 *   - outdated -> auto-run the matching installer `--update`, then exit so the
 *     caller re-runs against the fresh skill. If the update does not take, exit
 *     with the manual command instead of looping.
 *
 * Cheap by design: the remote version.json is fetched at most once per
 * CHECK_TTL_MS via a tmp-dir cache, so calling this at the top of every script
 * costs nothing on the common (already-fresh) path.
 */

const REPO = 'minsu-kang/make-custom-app-skill';
const BRANCH = 'master';
const VERSION_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/version.json`;
const CHECK_TTL_MS = 60 * 60 * 1000; // re-check the network at most once per hour
const CACHE_FILE = path.join(os.tmpdir(), 'make-custom-app-version-check.json');

function parseInstalledVersion(skillRoot) {
	try {
		const txt = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
		const m = txt.match(/^version:\s*(.+)$/m);
		return m ? m[1].trim() : null;
	} catch {
		return null;
	}
}

/** Returns -1 / 0 / 1 comparing dotted numeric versions (a vs b). */
function cmpVersion(a, b) {
	const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
	const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

function updateCommand(editorDir) {
	const target = editorDir === '.claude' ? 'claude' : 'cursor';
	if (process.platform === 'win32') {
		return `powershell -NoProfile -Command "irm https://raw.githubusercontent.com/${REPO}/${BRANCH}/install-${target}.ps1 | iex"`;
	}
	return `curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/install-${target}.sh | bash -s -- --update`;
}

function readCache() {
	try {
		return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
	} catch {
		return null;
	}
}

function writeCache(data) {
	try {
		fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
	} catch {
		/* tmp not writable -> ignore, just means we re-check next run */
	}
}

function fetchRemoteVersion() {
	try {
		const raw = execSync(`curl -fsSL --max-time 5 ${VERSION_URL}`, {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const v = JSON.parse(raw).version;
		return typeof v === 'string' ? v.trim() : null;
	} catch {
		return null;
	}
}

/**
 * Enforce that the installed skill is at the latest version before real work
 * proceeds. Safe to call at the top of any entry script. May call process.exit()
 * when the skill is outdated.
 */
function ensureFreshSkill() {
	let skillRoot;
	let editorDir;
	try {
		skillRoot = getSkillRoot();
		editorDir = getEditorDir();
	} catch {
		return; // can't resolve skill root -> fail open
	}

	// Skip the network round-trip if we confirmed "fresh" recently.
	const cache = readCache();
	if (cache && cache.ok && typeof cache.checkedAt === 'number' && Date.now() - cache.checkedAt < CHECK_TTL_MS) {
		return;
	}

	const installed = parseInstalledVersion(skillRoot);
	if (!installed) return; // can't read installed version -> fail open

	const remote = fetchRemoteVersion();
	if (!remote) return; // offline / GitHub down -> fail open

	if (cmpVersion(installed, remote) >= 0) {
		writeCache({ ok: true, checkedAt: Date.now(), installed, remote });
		return;
	}

	// --- Outdated: block work and attempt auto-update. ---
	const cmd = updateCommand(editorDir);
	const line = '='.repeat(64);
	process.stderr.write(`\n${line}\n`);
	process.stderr.write(`SKILL OUTDATED: ${installed} -> ${remote}\n`);
	process.stderr.write('All Make app work is blocked until the skill is updated.\n');
	process.stderr.write(`${line}\n\nAuto-updating...\n`);

	try {
		execSync(cmd, { stdio: 'inherit' });
	} catch {
		process.stderr.write(`\nAuto-update failed. Run this manually, then retry:\n   ${cmd}\n`);
		process.exit(1);
	}

	// Verify the update actually took before telling the caller to re-run,
	// otherwise a silently-failed installer would loop forever.
	const after = parseInstalledVersion(skillRoot);
	if (after && cmpVersion(after, remote) >= 0) {
		try {
			fs.unlinkSync(CACHE_FILE);
		} catch {
			/* ignore */
		}
		process.stderr.write(`\nSkill updated ${installed} -> ${after}. Re-run your command.\n`);
		process.exit(3);
	}

	process.stderr.write(`\nUpdate did not take (still ${after || 'unknown'}). Run manually, then retry:\n   ${cmd}\n`);
	process.exit(1);
}

module.exports = {
	ensureFreshSkill,
	// exported for unit tests
	__test: { cmpVersion, parseInstalledVersion, updateCommand },
};
