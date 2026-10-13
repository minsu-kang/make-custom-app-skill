const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { getSkillRoot, getEditorDir } = require('../skill-root');

const originalArgv1 = process.argv[1];
afterEach(() => {
	process.argv[1] = originalArgv1;
});

describe('getEditorDir', () => {
	it('detects Claude Code from a POSIX path', () => {
		process.argv[1] = '/Users/x/.claude/skills/make-custom-app/scripts/check-setup.js';
		assert.equal(getEditorDir(), '.claude');
	});

	it('detects Claude Code from a Windows path', () => {
		process.argv[1] = 'C:\\Users\\x\\.claude\\skills\\make-custom-app\\scripts\\check-setup.js';
		assert.equal(getEditorDir(), '.claude');
	});

	it('detects Cursor from POSIX and Windows paths', () => {
		process.argv[1] = '/Users/x/.cursor/skills/make-custom-app/scripts/check-setup.js';
		assert.equal(getEditorDir(), '.cursor');
		process.argv[1] = 'C:\\Users\\x\\.cursor\\skills\\make-custom-app\\scripts\\check-setup.js';
		assert.equal(getEditorDir(), '.cursor');
	});

	it('falls back to Cursor for a plain clone path', () => {
		process.argv[1] = '/Users/x/Documents/GitHub/make-custom-app-skill/skill/scripts/check-setup.js';
		assert.equal(getEditorDir(), '.cursor');
	});
});

describe('getSkillRoot', () => {
	it('returns the skill root for POSIX and Windows paths', () => {
		process.argv[1] = '/Users/x/.claude/skills/make-custom-app/scripts/check-setup.js';
		assert.equal(getSkillRoot(), '/Users/x/.claude/skills/make-custom-app');
		process.argv[1] = 'C:\\Users\\x\\.cursor\\skills\\make-custom-app\\scripts\\check-setup.js';
		assert.equal(getSkillRoot(), 'C:\\Users\\x\\.cursor\\skills\\make-custom-app');
	});
});
