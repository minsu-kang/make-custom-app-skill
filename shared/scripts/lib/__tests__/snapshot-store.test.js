/**
 * Tests for snapshot-store.js in process, each in its own fake home: the atomic write of a snapshot folder, the -2 id
 * on a clash, the cleanup after a failed write, retention, stale temp folders, which folders count as snapshots, the
 * modes of spec 3.3, and the push gate.
 */
require('./isolate-home');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../snapshot-store');
const { scriptCommand } = require('../paths');
const { gateRefusalLines } = require('../snapshot-logic');

const at = (iso) => Date.parse(iso);
const POSIX = process.platform !== 'win32';
const FILES = [
	['base.imljson', '{}'],
	['modules/m/api.imljson', '{"url":"/x"}'],
];

let home;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-store-'));
});

const root = () => path.join(home, '.make-custom-app', 'snapshots', 'my-app-v1');
const write = (nowIso, extra = {}) => store.writeSnapshot({ slug: 'my-app', version: '1', files: FILES, metadata: { slug: 'my-app', version: '1' }, home, now: () => at(nowIso), ...extra });
const mode = (p) => fs.statSync(p).mode & 0o777;
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [path.join(dir, e.name), ...walk(path.join(dir, e.name))] : [path.join(dir, e.name)]));

describe('appSnapshotsDir', () => {
	it('is {slug}-v{version} under the snapshots folder of the home', () => {
		assert.equal(store.appSnapshotsDir('my-app', '1', { home: '/home/u' }), path.join('/home/u', '.make-custom-app', 'snapshots', 'my-app-v1'));
		assert.equal(store.appSnapshotsDir('my-app', 2), path.join(os.homedir(), '.make-custom-app', 'snapshots', 'my-app-v2'));
	});
});

describe('writeSnapshot', () => {
	it('writes the files and metadata.json into the id folder, 0700 folders and 0600 files, and leaves no temp folder', () => {
		const r = write('2026-11-05T14:12:00Z');
		assert.deepEqual(r, { id: '20261105-141200', kept: 1, takenAt: '2026-11-05T14:12:00.000Z', dir: path.join(root(), '20261105-141200') });
		assert.equal(fs.readFileSync(path.join(r.dir, 'base.imljson'), 'utf8'), '{}');
		assert.equal(fs.readFileSync(path.join(r.dir, 'modules/m/api.imljson'), 'utf8'), '{"url":"/x"}');
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'metadata.json'), 'utf8')), {
			slug: 'my-app',
			version: '1',
			snapshot: { id: '20261105-141200', takenAt: '2026-11-05T14:12:00.000Z' },
		});
		assert.deepEqual(fs.readdirSync(root()), ['20261105-141200']);
		if (POSIX) {
			const snapshots = path.join(home, '.make-custom-app', 'snapshots');
			for (const dir of [snapshots, root(), r.dir, path.join(r.dir, 'modules'), path.join(r.dir, 'modules/m')]) assert.equal(mode(dir), 0o700, dir);
			for (const file of walk(r.dir).filter((p) => fs.statSync(p).isFile())) assert.equal(mode(file), 0o600, file);
		}
	});

	it('gives a second snapshot in the same second the id -2', () => {
		write('2026-11-05T14:12:00Z');
		assert.equal(write('2026-11-05T14:12:00Z').id, '20261105-141200-2');
		assert.deepEqual(fs.readdirSync(root()).sort(), ['20261105-141200', '20261105-141200-2']);
	});

	it('throws on a failed write and leaves neither the temp folder nor an id folder', () => {
		const files = [
			['a.imljson', 'x'],
			['a.imljson/b.imljson', 'y'],
		];
		assert.throws(() => write('2026-11-05T14:12:00Z', { files }));
		assert.deepEqual(fs.readdirSync(root()), []);
	});

	it('keeps the newest five: of seven snapshots the two oldest are gone', () => {
		let last;
		for (let day = 1; day <= 7; day++) last = write(`2026-11-0${day}T00:00:00Z`);
		assert.equal(last.kept, 5);
		assert.deepEqual(fs.readdirSync(root()).sort(), ['20261103-000000', '20261104-000000', '20261105-000000', '20261106-000000', '20261107-000000']);
	});

	it('keeps the snapshot just written when its id sorts before the others (a clock set back)', () => {
		for (let day = 2; day <= 6; day++) write(`2026-11-0${day}T00:00:00Z`);
		const r = write('2026-11-01T00:00:00Z');
		assert.equal(r.id, '20261101-000000');
		assert.equal(r.kept, 5);
		assert.ok(fs.existsSync(path.join(r.dir, 'metadata.json')));
		assert.deepEqual(fs.readdirSync(root()).sort(), ['20261101-000000', '20261103-000000', '20261104-000000', '20261105-000000', '20261106-000000']);
	});

	it('leaves an old snapshot in place when removing it fails, and still returns the new snapshot', (t) => {
		for (let day = 1; day <= 5; day++) write(`2026-11-0${day}T00:00:00Z`);
		const oldest = path.join(root(), '20261101-000000');
		const rmSync = fs.rmSync;
		t.mock.method(fs, 'rmSync', (target, options) => {
			if (target === oldest) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
			return rmSync(target, options);
		});
		const r = write('2026-11-06T00:00:00Z');
		assert.equal(r.id, '20261106-000000');
		assert.equal(r.kept, 6);
		assert.ok(fs.existsSync(path.join(oldest, 'metadata.json')));
		assert.ok(fs.existsSync(path.join(r.dir, 'metadata.json')));
	});

	it('removes a temp folder older than a day on the next write and leaves a fresh one', () => {
		const now = at('2026-11-05T14:12:00Z');
		const stale = path.join(root(), '20261103-000000.tmp');
		const fresh = path.join(root(), '20261105-140000.tmp');
		for (const dir of [stale, fresh]) fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
		fs.utimesSync(stale, new Date(now - 2 * 86400000), new Date(now - 2 * 86400000));
		fs.utimesSync(fresh, new Date(now - 3600000), new Date(now - 3600000));
		write('2026-11-05T14:12:00Z');
		assert.deepEqual(fs.readdirSync(root()).sort(), ['20261105-140000.tmp', '20261105-141200']);
	});

	it('leaves a temp entry it cannot read the time of', { skip: !POSIX && 'symbolic links need extra rights on Windows' }, () => {
		fs.mkdirSync(root(), { recursive: true });
		fs.symlinkSync(path.join(home, 'gone'), path.join(root(), '20261101-000000.tmp'));
		write('2026-11-05T14:12:00Z');
		assert.deepEqual(fs.readdirSync(root()).sort(), ['20261101-000000.tmp', '20261105-141200']);
	});

	it('takes the time from Date.now and the home from os.homedir when they are not given', () => {
		const before = Date.now();
		const r = store.writeSnapshot({ slug: 'default-home-app', version: '3', files: [], metadata: {} });
		assert.equal(r.dir, path.join(os.homedir(), '.make-custom-app', 'snapshots', 'default-home-app-v3', r.id));
		assert.ok(Date.parse(r.takenAt) >= before - 1000 && Date.parse(r.takenAt) <= Date.now(), r.takenAt);
		assert.deepEqual(fs.readdirSync(r.dir), ['metadata.json']);
	});
});

describe('listSnapshots', () => {
	it('returns the snapshots with a usable metadata.json, oldest first', () => {
		const second = write('2026-11-05T14:12:00Z');
		const first = write('2026-11-04T09:00:00Z');
		fs.mkdirSync(path.join(root(), '20261105-150000'));
		fs.mkdirSync(path.join(root(), 'notes'));
		fs.writeFileSync(path.join(root(), 'notes', 'metadata.json'), JSON.stringify({ snapshot: { id: 'notes', takenAt: '2026-11-05T15:00:00.000Z' } }));
		fs.mkdirSync(path.join(root(), '20261105-160000.tmp'));
		fs.writeFileSync(path.join(root(), '20261105-160000.tmp', 'metadata.json'), JSON.stringify({ snapshot: { id: '20261105-160000', takenAt: '2026-11-05T16:00:00.000Z' } }));
		fs.mkdirSync(path.join(root(), '20261105-170000'));
		fs.writeFileSync(path.join(root(), '20261105-170000', 'metadata.json'), JSON.stringify({ slug: 'my-app' }));
		fs.mkdirSync(path.join(root(), '20261105-180000'));
		fs.writeFileSync(path.join(root(), '20261105-180000', 'metadata.json'), 'not json');
		assert.deepEqual(store.listSnapshots('my-app', '1', { home }), [
			{ id: first.id, takenAt: first.takenAt, dir: first.dir },
			{ id: second.id, takenAt: second.takenAt, dir: second.dir },
		]);
	});

	it('is empty when the app has no snapshot folder', () => {
		assert.deepEqual(store.listSnapshots('my-app', '1', { home }), []);
		assert.deepEqual(store.listSnapshots('no-such-app', '1'), []);
		assert.deepEqual(store.listSnapshots('my-app', '1', { home, strict: true }), []);
	});

	it('reads a folder it cannot list as empty, and throws its error only when strict', () => {
		fs.mkdirSync(path.dirname(root()), { recursive: true });
		fs.writeFileSync(root(), 'not a folder');
		assert.deepEqual(store.listSnapshots('my-app', '1', { home }), []);
		assert.throws(() => store.listSnapshots('my-app', '1', { home, strict: true }), { code: 'ENOTDIR' });
	});
});

describe('pushGate', () => {
	const COMMAND = 'node "/path/to/shared/scripts/download-app.js"';
	const working = (downloadedAt) => {
		const dir = path.join(home, '.make-custom-app', 'contexts', 'my-app-v1');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ slug: 'my-app', downloadedAt }));
	};
	const gate = () => store.pushGate({ slug: 'my-app', version: '1', home, command: COMMAND });

	it('refuses without a snapshot and gives the four lines with the command', () => {
		working('2026-11-05T14:00:00.000Z');
		const r = gate();
		assert.equal(r.ok, false);
		assert.deepEqual(r.lines, gateRefusalLines({ slug: 'my-app', version: '1', command: COMMAND }));
		assert.equal(r.lines[2], `  ${COMMAND} my-app 1 --snapshot`);
	});

	it('passes with a snapshot newer than the working folder', () => {
		working('2026-11-05T14:00:00.000Z');
		write('2026-11-05T14:12:00Z');
		assert.deepEqual(gate(), { ok: true, lines: [] });
	});

	it('refuses with a snapshot older than the working folder', () => {
		write('2026-11-05T14:12:00Z');
		working('2026-11-05T15:00:00.000Z');
		assert.equal(gate().ok, false);
	});

	it('passes with any snapshot when there is no working folder', () => {
		write('2020-01-01T00:00:00Z');
		assert.deepEqual(gate(), { ok: true, lines: [] });
	});

	it('names download-app.js of the scripts folder and reads the home of the process when they are not given', () => {
		const r = store.pushGate({ slug: 'no-snapshot-app', version: '1' });
		assert.equal(r.ok, false);
		assert.equal(r.lines[2], `  ${scriptCommand('download-app.js')} no-snapshot-app 1 --snapshot`);
	});
});

describe('readTree', () => {
	const tree = () => path.join(home, 'tree');
	const put = (rel, text) => {
		const file = path.join(tree(), rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	};

	it('gives the parsed metadata, the section files without metadata.json and reviews/, and the times of the non-review files', () => {
		put('metadata.json', JSON.stringify({ slug: 'my-app', modules: [{ name: 'm' }] }));
		put('base.imljson', '{}');
		put('modules/m/api.imljson', '{"url":"/x"}');
		put('reviews/latest.json', '{}');
		const r = store.readTree(tree());
		assert.deepEqual(r.metadata, { slug: 'my-app', modules: [{ name: 'm' }] });
		assert.deepEqual([...r.files.entries()].sort(), [
			['base.imljson', '{}'],
			['modules/m/api.imljson', '{"url":"/x"}'],
		]);
		assert.deepEqual(r.mtimes.map((f) => f.rel).sort(), ['base.imljson', 'metadata.json', 'modules/m/api.imljson']);
		const api = r.mtimes.find((f) => f.rel === 'modules/m/api.imljson');
		assert.equal(api.mtimeMs, fs.statSync(path.join(tree(), 'modules/m/api.imljson')).mtimeMs);
	});

	it('keeps a nested reviews folder of a component and skips a link', { skip: !POSIX && 'symbolic links need extra rights on Windows' }, () => {
		put('metadata.json', '{}');
		put('modules/m/reviews/x.imljson', 'x');
		fs.symlinkSync(path.join(tree(), 'metadata.json'), path.join(tree(), 'link.imljson'));
		assert.deepEqual([...store.readTree(tree()).files.keys()], ['modules/m/reviews/x.imljson']);
	});

	it('throws on an unreadable metadata.json or a missing folder', () => {
		put('metadata.json', 'not json');
		put('base.imljson', '{}');
		assert.throws(() => store.readTree(tree()));
		assert.throws(() => store.readTree(path.join(home, 'none')), { code: 'ENOENT' });
	});
});
