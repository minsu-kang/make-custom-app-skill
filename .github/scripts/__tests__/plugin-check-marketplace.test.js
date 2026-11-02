'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'plugin-check.js');
const REAL = path.join(__dirname, '..', '..', '..', '.claude-plugin', 'marketplace.json');

const GOOD = {
	name: 'make-custom-app',
	description: 'A marketplace.',
	owner: { name: 'someone' },
	plugins: [{ name: 'make-custom-app', description: 'The plugin.', source: './' }],
};

/** A marketplace.json text built from GOOD with `change` applied to a copy. */
function market(change = () => {}) {
	const copy = JSON.parse(JSON.stringify(GOOD));
	change(copy);
	return `${JSON.stringify(copy, null, 2)}\n`;
}

function run(text) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-marketplace-'));
	try {
		fs.mkdirSync(path.join(root, '.claude-plugin'));
		fs.writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), text);
		const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
		// the repository has no plugin.json, which another check reports; keep only the marketplace lines
		return { out: r.stdout.split('\n').filter((line) => line.includes('marketplace.json')).join('\n'), status: r.status, err: r.stderr };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test('a good marketplace has no finding', () => {
	const r = run(market());
	assert.equal(r.out, '');
	assert.equal(r.err, '');
});

test('the marketplace of this repository has no finding', () => {
	const r = run(fs.readFileSync(REAL, 'utf8'));
	assert.equal(r.out, '');
	assert.equal(r.err, '');
});

test('invalid JSON is an error', () => {
	assert.match(run('{ nope').out, /marketplace\.json: is not valid JSON/);
});

test('the marketplace is named make-custom-app and has an owner with a name', () => {
	assert.match(run(market((m) => (m.name = 'other'))).out, /marketplace\.json: name is "other", expected "make-custom-app"/);
	assert.match(run(market((m) => delete m.owner)).out, /marketplace\.json: has no owner with a name/);
	assert.match(run(market((m) => (m.owner = { name: '' }))).out, /marketplace\.json: has no owner with a name/);
});

test('it lists exactly one plugin, named make-custom-app, from the repository root', () => {
	assert.match(run(market((m) => (m.plugins = []))).out, /lists 0 plugins, expected exactly one/);
	assert.match(run(market((m) => m.plugins.push({ name: 'x', source: './x' }))).out, /lists 2 plugins, expected exactly one/);
	assert.match(run(market((m) => (m.plugins[0].name = 'other'))).out, /plugin entry is named "other", expected "make-custom-app"/);
	assert.match(run(market((m) => (m.plugins[0].source = './plugin'))).out, /plugin entry source is "\.\/plugin", expected "\.\/" \(the repository root is the plugin\)/);
	assert.match(run(market((m) => delete m.plugins)).out, /lists 0 plugins, expected exactly one/);
});

test('a plugin entry that is not an object is a finding, not a crash', () => {
	for (const entry of [null, 'x', 7, ['x']]) {
		const r = run(market((m) => (m.plugins = [entry])));
		assert.match(r.out, /marketplace\.json: plugin entry is not an object/);
		assert.equal(r.err, '');
		assert.equal(r.status, 1);
	}
});

test('the plugin entry carries no version, because plugin.json holds it', () => {
	assert.match(run(market((m) => (m.plugins[0].version = '3.0.0'))).out, /plugin entry must not carry a version/);
});
