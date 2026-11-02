'use strict';

// Only the CHANGELOG rule of the old checker: the plugin entry "## 3.0.0 (unreleased)" sits above the last 2.x release.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'check-skill.js');

function run(changelog, skillVersion = '2.3.13') {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-skill-'));
	try {
		const files = {
			'version.json': `${JSON.stringify({ version: '2.3.13', released: '2026-10-27' })}\n`,
			'skill/SKILL.md': `---\nname: make-custom-app\ndescription: x\nversion: ${skillVersion}\n---\n`,
			'CHANGELOG.md': changelog,
		};
		for (const [rel, body] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), body);
		}
		const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
		// the tree is minimal on purpose; keep only the lines that the version rule prints
		return r.stdout.split('\n').filter((line) => /CHANGELOG|version/.test(line) && !/README|Script Files|index/.test(line));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test('an unreleased top entry is skipped and the last released entry is compared with version.json', () => {
	const lines = run('# Changelog\n\n## 3.0.0 (unreleased)\n\nText.\n\n## 2.3.13 — 2026-10-27\n\nOld.\n');
	assert.deepEqual(lines, []);
});

test('the released entry still has to equal version.json', () => {
	const lines = run('# Changelog\n\n## 3.0.0 (unreleased)\n\nText.\n\n## 2.3.12 — 2026-10-27\n\nOld.\n');
	assert.ok(lines.some((l) => /versions disagree/.test(l)), lines.join('\n'));
});

test('a dated 3.x entry on top is skipped and the newest 2.x entry is compared with version.json', () => {
	const lines = run('# Changelog\n\n## 3.0.0 — 2026-11-01\n\nText.\n\n## 2.3.13 — 2026-10-27\n\nOld.\n');
	assert.deepEqual(lines, []);
	const stale = run('# Changelog\n\n## 3.0.0 — 2026-11-01\n\nText.\n\n## 2.3.12 — 2026-10-27\n\nOld.\n');
	assert.ok(stale.some((l) => /versions disagree/.test(l)), stale.join('\n'));
});

test('a 2.4.x bridge entry below the dated plugin entry is the one compared', () => {
	const lines = run('# Changelog\n\n## 3.0.0 — 2026-11-01\n\nText.\n\n## 2.4.0 — 2026-10-20\n\nBridge.\n\n## 2.3.13 — 2026-10-19\n\nOld.\n');
	assert.ok(lines.some((l) => /versions disagree/.test(l) && /CHANGELOG\.md=2\.4\.0/.test(l)), lines.join('\n'));
});

test('a changelog without any released entry is an error', () => {
	const lines = run('# Changelog\n\n## 3.0.0 (unreleased)\n');
	assert.ok(lines.some((l) => /does not match "## X\.Y\.Z/.test(l)), lines.join('\n'));
});
