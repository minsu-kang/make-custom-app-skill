/**
 * Tests for the secrets-file readers in settings.js, in a fake HOME. The Cursor settings.json path is not covered here.
 * HOME is set before the module is loaded because SECRETS_PATH is computed when it loads.
 */
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const skillDir = path.join(home, '.claude', 'skills', 'make-custom-app');
const secretsPath = path.join(home, '.make-custom-app-skill-secrets');
const skillMd = path.join(skillDir, 'SKILL.md');
const settings = require('../settings');

before(() => fs.mkdirSync(skillDir, { recursive: true }));
after(() => fs.rmSync(home, { recursive: true, force: true }));
afterEach(() => {
	fs.rmSync(secretsPath, { force: true });
	fs.rmSync(skillMd, { force: true });
});

/** Runs fn as if the script lived under ~/.claude/skills/make-custom-app/scripts (editor detection reads argv[1]). */
function asClaudeScript(fn) {
	const saved = process.argv[1];
	process.argv[1] = path.join(skillDir, 'scripts', 'probe.js');
	try {
		return fn();
	} finally {
		process.argv[1] = saved;
	}
}

describe('isPlaceholder', () => {
	it('flags empty values and the sample markers, not real values', () => {
		for (const v of [undefined, null, '', 'your-token', '<token>', 'me@example.com', '/path/to/runtime']) assert.equal(settings.isPlaceholder(v), true, String(v));
		for (const v of ['dev@make.com', 'ATATT3xreal-looking', '/Users/dev/imt-app-runtime']) assert.equal(settings.isPlaceholder(v), false, v);
	});
});

describe('readSkillConfig', () => {
	it('returns null when no file has the key', () => {
		assert.equal(settings.readSkillConfig('jira-email'), null);
	});

	it('reads the value, and the last real line wins', () => {
		fs.writeFileSync(secretsPath, 'jira-email: old@make.com\nmake-team-id: 5\njira-email: new@make.com\n');
		assert.equal(settings.readSkillConfig('jira-email'), 'new@make.com');
		assert.equal(settings.readSkillConfig('make-team-id'), '5');
	});

	it('skips placeholder lines and falls back to the earlier real value', () => {
		fs.writeFileSync(secretsPath, 'jira-api-token: real-token-value\njira-api-token: <token>\n');
		assert.equal(settings.readSkillConfig('jira-api-token'), 'real-token-value');
	});

	it('ignores blockquote lines in the legacy SKILL.md tail and reads plain ones', () => {
		fs.writeFileSync(skillMd, '> jira-email: quoted@make.com\njira-email: legacy@make.com\n');
		assert.equal(settings.readSkillConfig('jira-email'), 'legacy@make.com');
		assert.equal(settings.skillMdHasConfig('jira-email'), true);
		assert.equal(settings.skillMdHasConfig('make-team-id'), false);
	});

	it('prefers the secrets file over the SKILL.md tail', () => {
		fs.writeFileSync(skillMd, 'jira-email: legacy@make.com\n');
		fs.writeFileSync(secretsPath, 'jira-email: current@make.com\n');
		assert.equal(settings.readSkillConfig('jira-email'), 'current@make.com');
	});

	it('reports no legacy config when SKILL.md does not exist', () => {
		assert.equal(settings.skillMdHasConfig('jira-email'), false);
	});
});

describe('loadJiraConfig', () => {
	it('returns the credentials with the Make Jira site as the default base URL', () => {
		fs.writeFileSync(secretsPath, 'jira-email: dev@make.com\njira-api-token: tok\n');
		assert.deepEqual(settings.loadJiraConfig(), { email: 'dev@make.com', apiToken: 'tok', baseUrl: 'https://make.atlassian.net' });
		fs.appendFileSync(secretsPath, 'jira-base-url: https://example.atlassian.net\n');
		assert.equal(settings.loadJiraConfig().baseUrl, 'https://example.atlassian.net');
	});

	it('exits 1 with the setup command when the email or token is missing', (t) => {
		t.mock.method(process, 'exit', (code) => {
			throw new Error(`exit ${code}`);
		});
		const lines = [];
		t.mock.method(console, 'error', (line) => lines.push(line));
		fs.writeFileSync(secretsPath, 'jira-email: dev@make.com\n');
		assert.throws(() => settings.loadJiraConfig(), /exit 1/);
		assert.match(lines.join('\n'), /Jira credentials not configured[\s\S]*setup-secrets\.js/);
	});
});

describe('Claude Code settings', () => {
	it('builds the API settings from the secrets file', () => {
		fs.writeFileSync(secretsPath, 'make-api-key: KEY123\n');
		assert.deepEqual(asClaudeScript(() => settings.loadSettings()), {
			baseUrl: 'https://eu1.make.com/api/v2/admin',
			auth: 'Token KEY123',
			version: 2,
			apikey: 'KEY123',
		});
		fs.appendFileSync(secretsPath, 'make-api-url: https://us1.make.com/api/v2/admin\n');
		assert.equal(asClaudeScript(() => settings.loadSettings()).baseUrl, 'https://us1.make.com/api/v2/admin');
		assert.equal(asClaudeScript(() => settings.getMakeApiKey()), 'KEY123');
	});

	it('exits 1 with the setup command when the API key is missing', (t) => {
		t.mock.method(process, 'exit', (code) => {
			throw new Error(`exit ${code}`);
		});
		const lines = [];
		t.mock.method(console, 'error', (line) => lines.push(line));
		assert.throws(() => asClaudeScript(() => settings.loadSettings()), /exit 1/);
		assert.match(lines.join('\n'), /Make API key not configured[\s\S]*setup-secrets\.js/);
	});
});
