'use strict';
/**
 * Test helper, not a test file. Require it before anything else in a test file: it moves HOME, USERPROFILE, TMPDIR,
 * TEMP, TMP, and CLAUDE_CONFIG_DIR into a fresh temporary root, so a module that reads the home folder when it loads
 * (settings.js computes SECRETS_PATH then) and a test that forgets to pass a folder can never reach the real one.
 * The root is removed when the process exits.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_HOME = os.homedir();
const TEST_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p5-shared-')));
for (const name of ['home', 'tmp', 'claude-config']) fs.mkdirSync(path.join(TEST_ROOT, name));

process.env.HOME = process.env.USERPROFILE = path.join(TEST_ROOT, 'home');
process.env.TMPDIR = process.env.TEMP = process.env.TMP = path.join(TEST_ROOT, 'tmp');
process.env.CLAUDE_CONFIG_DIR = path.join(TEST_ROOT, 'claude-config');

process.on('exit', () => {
	fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function isInsideTestRoot(value) {
	return typeof value === 'string' && (value === TEST_ROOT || value.startsWith(TEST_ROOT + path.sep));
}

/** Fails when the process still sees the real home, the real temp folder, the real secrets file, or another config folder. */
function assertIsolated() {
	const home = os.homedir();
	assert.ok(isInsideTestRoot(home), 'os.homedir() is outside the test root');
	assert.notEqual(home, REAL_HOME, 'os.homedir() is still the real home');
	assert.ok(isInsideTestRoot(os.tmpdir()), 'os.tmpdir() is outside the test root');
	assert.ok(isInsideTestRoot(require('../settings').SECRETS_PATH), 'SECRETS_PATH is outside the test root');
	assert.ok(isInsideTestRoot(process.env.CLAUDE_CONFIG_DIR), 'CLAUDE_CONFIG_DIR is outside the test root');
}

module.exports = { TEST_ROOT, REAL_HOME, assertIsolated };
