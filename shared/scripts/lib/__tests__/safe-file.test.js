require('./isolate-home');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sf = require('../safe-file');

const POSIX = process.platform !== 'win32';
let dir;
let n = 0;
const file = () => path.join(dir, `f-${n++}.json`);

/**
 * Runs `code` in a child Node process that is killed after 10 s and returns its stdout. A read that blocks on a FIFO
 * blocks the whole process, so a node:test timeout cannot end it; in a child the case fails instead of hanging the run.
 */
function runBounded(code, args) {
	const r = spawnSync(process.execPath, ['-e', code, ...args], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
	assert.equal(r.signal, null, 'the read blocked on the FIFO');
	assert.equal(r.status, 0, r.stderr);
	return r.stdout;
}

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-file-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('readOwnedJson', () => {
	it('reads a small JSON object of this user', () => {
		const f = file();
		fs.writeFileSync(f, '{"a":1}');
		assert.deepEqual(sf.readOwnedJson(f), { a: 1 });
	});

	it('gives null for a missing file, an empty file, text that is not JSON, an array, a primitive and a file over 4 KiB', () => {
		assert.equal(sf.readOwnedJson(path.join(dir, 'missing.json')), null);
		for (const text of ['', 'not json', '[1]', '7', 'null', JSON.stringify({ a: 'x'.repeat(5000) })]) {
			const f = file();
			fs.writeFileSync(f, text);
			assert.equal(sf.readOwnedJson(f), null, text.slice(0, 20));
		}
	});

	it('reads a file of exactly 4 KiB and gives null for one byte more', () => {
		assert.equal(sf.MAX_BYTES, 4096);
		const at = (size) => {
			const f = file();
			fs.writeFileSync(f, JSON.stringify({ a: 'x'.repeat(size - '{"a":""}'.length) }));
			assert.equal(fs.statSync(f).size, size);
			return sf.readOwnedJson(f);
		};
		assert.equal(at(4096).a.length, 4088);
		assert.equal(at(4097), null);
	});

	it('gives null for a folder', () => {
		const folder = path.join(dir, `folder-${n++}`);
		fs.mkdirSync(folder);
		assert.equal(sf.readOwnedJson(folder), null);
	});

	it('never follows a symlink, even to a valid file', { skip: !POSIX }, () => {
		const target = file();
		fs.writeFileSync(target, '{"a":1}');
		const link = file();
		fs.symlinkSync(target, link);
		assert.equal(sf.readOwnedJson(link), null);
	});

	it('does not hang on a FIFO', { skip: !POSIX }, (t) => {
		const fifo = path.join(dir, 'fifo');
		if (spawnSync('mkfifo', [fifo]).status !== 0) return t.skip('mkfifo failed');
		const code = 'process.stdout.write(JSON.stringify(require(process.argv[1]).readOwnedJson(process.argv[2])))';
		assert.equal(runBounded(code, [require.resolve('../safe-file'), fifo]), 'null');
	});

	it('gives null for a file of another owner', { skip: !POSIX }, () => {
		const f = file();
		fs.writeFileSync(f, '{"a":1}');
		assert.equal(sf.readOwnedJson(f, { uid: 999999 }), null);
	});

	it('skips the owner check where the platform has no uid', () => {
		const f = file();
		fs.writeFileSync(f, '{"a":1}');
		assert.deepEqual(sf.readOwnedJson(f, { uid: null }), { a: 1 });
		assert.equal(sf.currentUid(), POSIX ? process.getuid() : null);
		const saved = process.getuid;
		try {
			process.getuid = undefined;
			assert.equal(sf.currentUid(), null);
		} finally {
			process.getuid = saved;
		}
	});

	it('builds the read flags without O_NOFOLLOW and O_NONBLOCK where the platform has none', () => {
		assert.equal(sf.readFlags({ O_RDONLY: 0 }), 0);
		assert.equal(sf.readFlags({ O_RDONLY: 0, O_NOFOLLOW: 256, O_NONBLOCK: 4 }), 260);
	});
});

describe('writeOwnedJson', () => {
	it('writes a 0600 file through a temp file and leaves no temp file', () => {
		const f = file();
		assert.equal(sf.writeOwnedJson(f, { a: 1 }), true);
		assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 1 });
		if (POSIX) assert.equal(fs.statSync(f).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')), []);
	});

	it('replaces a planted symlink and leaves its target untouched', { skip: !POSIX }, () => {
		const victim = file();
		fs.writeFileSync(victim, 'VICTIM');
		const f = file();
		fs.symlinkSync(victim, f);
		assert.equal(sf.writeOwnedJson(f, { a: 1 }), true);
		assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM');
		assert.equal(fs.lstatSync(f).isSymbolicLink(), false);
	});

	it('replaces a 0644 file with a 0600 one', { skip: !POSIX }, () => {
		const f = file();
		fs.writeFileSync(f, '{}', { mode: 0o644 });
		fs.chmodSync(f, 0o644);
		assert.equal(sf.writeOwnedJson(f, { a: 2 }), true);
		assert.equal(fs.statSync(f).mode & 0o777, 0o600);
		assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 2 });
	});

	it('is not stopped by a leftover temp file of the same process, and the result is 0600', () => {
		const f = file();
		const temp = `${f}.${process.pid}.tmp`;
		fs.writeFileSync(temp, 'junk', { mode: 0o644 });
		if (POSIX) fs.chmodSync(temp, 0o644);
		assert.equal(sf.writeOwnedJson(f, { a: 3 }), true);
		assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 3 });
		assert.equal(fs.existsSync(temp), false);
		if (POSIX) assert.equal(fs.statSync(f).mode & 0o777, 0o600);
	});

	it('does not follow a symlink planted at the temp path', { skip: !POSIX }, () => {
		const victim = file();
		fs.writeFileSync(victim, 'VICTIM');
		const f = file();
		const temp = `${f}.${process.pid}.tmp`;
		fs.symlinkSync(victim, temp);
		assert.equal(sf.writeOwnedJson(f, { a: 4 }), true);
		assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM');
		assert.equal(fs.lstatSync(f).isFile(), true);
		assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 4 });
		assert.equal(fs.statSync(f).mode & 0o777, 0o600);
		assert.equal(fs.existsSync(temp), false);
	});

	it('creates the folder with mode 0700 when asked', () => {
		const f = path.join(dir, 'new-folder', 'x.json');
		assert.equal(sf.writeOwnedJson(f, { a: 1 }, { mkdir: true }), true);
		if (POSIX) assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
	});

	it('returns false instead of throwing for a missing folder or a value JSON cannot hold', () => {
		assert.equal(sf.writeOwnedJson(path.join(dir, 'no-such', 'x.json'), { a: 1 }), false);
		const cyclic = {};
		cyclic.self = cyclic;
		assert.equal(sf.writeOwnedJson(file(), cyclic), false);
	});
});
