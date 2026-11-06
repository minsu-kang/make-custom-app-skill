/**
 * Tests for snapshot-logic.js: snapshot ids and their order, retention, stale temp folders, the push gate decision, and
 * the lines of spec 3.3. No file access: snapshot-store.test.js covers the folders.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../snapshot-logic');

const at = (iso) => Date.parse(iso);

describe('ids', () => {
	it('names a snapshot by its UTC second and adds -2, -3 on a clash', () => {
		assert.equal(s.snapshotId(at('2026-11-05T14:12:00.999Z'), []), '20261105-141200');
		assert.equal(s.snapshotId(at('2026-11-05T14:12:00Z'), ['20261105-141200']), '20261105-141200-2');
		assert.equal(s.snapshotId(at('2026-11-05T14:12:00Z'), ['20261105-141200', '20261105-141200-2']), '20261105-141200-3');
	});

	it('sorts ids in time order, also with ten clashes in one second, and drops other names', () => {
		const names = ['20261105-141201', '20261105-141200-10', 'notes.txt', '20261105-141200', '20261105-141200-2', '20261105-141200.tmp', '20261105-141200-1'];
		assert.deepEqual(s.sortIds(names), ['20261105-141200', '20261105-141200-2', '20261105-141200-10', '20261105-141201']);
		assert.equal(s.isSnapshotId('20261105-141200-1'), false);
	});

	it('compares two ids by their second first and by the clash number second', () => {
		assert.equal(s.compareIds('20261105-141200', '20261105-141201') < 0, true);
		assert.equal(s.compareIds('20261105-141201', '20261105-141200-9') > 0, true);
		assert.equal(s.compareIds('20261105-141200-3', '20261105-141200-2') > 0, true);
		assert.equal(s.compareIds('20261105-141200', '20261105-141200'), 0);
	});

	it('takes only the id form as an id', () => {
		for (const name of ['20261105-141200', '20261105-141200-2', '20261105-141200-12']) assert.equal(s.isSnapshotId(name), true, name);
		for (const name of ['20261105-141200-0', '20261105-141200-02', '2026115-141200', '20261105-141200.tmp', '', null, undefined]) assert.equal(s.isSnapshotId(name), false, String(name));
	});

	it('prunes the oldest beyond five', () => {
		const ids = ['20261101-000000', '20261102-000000', '20261103-000000', '20261104-000000', '20261105-000000', '20261106-000000', '20261107-000000'];
		assert.deepEqual(s.pruneChoice([...ids].reverse()), ['20261101-000000', '20261102-000000']);
		assert.deepEqual(s.pruneChoice(ids.slice(0, 5)), []);
		assert.deepEqual(s.pruneChoice(ids, 6), ['20261101-000000']);
		assert.equal(s.KEEP_SNAPSHOTS, 5);
	});

	it('never prunes the snapshot just written, whatever its id sorts to', () => {
		const others = ['20261102-000000', '20261103-000000', '20261104-000000', '20261105-000000', '20261106-000000'];
		assert.deepEqual(s.pruneChoice([...others, '20261101-000000'], 5, '20261101-000000'), ['20261102-000000']);
		assert.deepEqual(s.pruneChoice([...others, '20261107-000000'], 5, '20261107-000000'), ['20261102-000000']);
		assert.deepEqual(s.pruneChoice(['20261101-000000', ...others.slice(0, 3)], 5, '20261101-000000'), []);
	});

	it('finds the temp folders older than a day', () => {
		const now = at('2026-11-05T12:00:00Z');
		const entries = [
			{ name: '20261103-000000.tmp', mtimeMs: now - 2 * 86400000 },
			{ name: '20261105-110000.tmp', mtimeMs: now - 3600000 },
			{ name: '20261101-000000', mtimeMs: now - 9 * 86400000 },
		];
		assert.deepEqual(s.staleTemps(entries, now), ['20261103-000000.tmp']);
		assert.equal(s.TEMP_MAX_AGE_MS, 86400000);
	});
});

describe('gateDecision', () => {
	const snap = (id, takenAt) => ({ id, takenAt });
	it('passes when the newest snapshot is at or after the last sync', () => {
		const r = s.gateDecision({ snapshots: [snap('20261105-100000', '2026-11-05T10:00:00.000Z'), snap('20261105-120000', '2026-11-05T12:00:00.000Z')], workingDownloadedAt: '2026-11-05T12:00:00.000Z' });
		assert.equal(r.ok, true);
		assert.equal(r.newest.id, '20261105-120000');
	});

	it('refuses when the newest snapshot is older than the last sync, or there is none', () => {
		assert.equal(s.gateDecision({ snapshots: [snap('20261105-100000', '2026-11-05T10:00:00.000Z')], workingDownloadedAt: '2026-11-05T11:00:00.000Z' }).ok, false);
		assert.deepEqual(s.gateDecision({ snapshots: [], workingDownloadedAt: null }), { ok: false, newest: null });
	});

	it('counts a missing or unreadable working folder time as 0 and skips a snapshot without a usable time', () => {
		assert.equal(s.gateDecision({ snapshots: [snap('20200101-000000', '2020-01-01T00:00:00.000Z')], workingDownloadedAt: null }).ok, true);
		assert.equal(s.gateDecision({ snapshots: [snap('20200101-000000', 'garbage')], workingDownloadedAt: null }).ok, false);
		assert.equal(s.gateDecision({ snapshots: [snap('20200101-000000', '2020-01-01T00:00:00.000Z')], workingDownloadedAt: 'OLD' }).ok, true);
	});

	it('takes the newest by id, whatever the order of the list, and skips an entry whose id is no id', () => {
		const r = s.gateDecision({ snapshots: [snap('20261105-120000', '2026-11-05T12:00:00.000Z'), snap('notes', '2030-01-01T00:00:00.000Z'), snap('20261105-100000', '2026-11-05T10:00:00.000Z')], workingDownloadedAt: '2026-11-05T11:00:00.000Z' });
		assert.deepEqual(r, { ok: true, newest: snap('20261105-120000', '2026-11-05T12:00:00.000Z') });
	});
});

describe('lines', () => {
	it('gives the four lines of the refusal with the real command', () => {
		assert.deepEqual(s.gateRefusalLines({ slug: 'my-app', version: '1', command: 'node "/path/to/shared/scripts/download-app.js"' }), [
			'No snapshot of my-app v1 since the last sync, so nothing was sent.',
			'In public mode a push can be live at once with no way back in Make. Take a snapshot first; it reads Make and changes nothing:',
			'  node "/path/to/shared/scripts/download-app.js" my-app 1 --snapshot',
			'Then run this command again. Do not push with a Make MCP tool instead.',
		]);
	});

	it('gives the four lines of a snapshot that was taken', () => {
		assert.deepEqual(s.snapshotDoneLines({ id: '20261105-141200', dir: '/Users/me/.make-custom-app/snapshots/my-app-v1/20261105-141200', kept: 3 }), [
			'Snapshot: 20261105-141200',
			'Path: /Users/me/.make-custom-app/snapshots/my-app-v1/20261105-141200',
			'Kept: 3 of 5',
			'Taken before the push: its files can be pushed back by hand.',
		]);
	});
});

describe('describePath', () => {
	it('names the app files, the component files of each kind, and nothing else', () => {
		assert.deepEqual(s.describePath('base.imljson'), { group: 'app', item: null, code: 'base', componentPath: 'base', language: 'imljson' });
		assert.deepEqual(s.describePath('readme.md'), { group: 'app', item: null, code: 'readme', componentPath: null, language: 'md' });
		assert.deepEqual(s.describePath('modules/listItems/api.imljson'), { group: 'module', item: 'listItems', code: 'api', componentPath: 'module/listItems/api', language: 'imljson' });
		assert.deepEqual(s.describePath('connections/c/common.imljson'), { group: 'connection', item: 'c', code: 'common', componentPath: 'connection/c/common', language: 'imljson' });
		assert.deepEqual(s.describePath('functions/fmt/code.js'), { group: 'function', item: 'fmt', code: 'code', componentPath: 'function/fmt/code', language: 'js' });
		assert.equal(s.describePath('functions/fmt/test.js').code, 'test');
		assert.equal(s.describePath('endpoints/getItem/input_parameters.imljson').code, 'input_parameters');
		assert.deepEqual(s.describePath('endpoints/getItem/context.md'), { group: 'endpoint', item: 'getItem', code: 'context', componentPath: 'endpoint/getItem/context', language: 'md' });
		assert.equal(s.describePath('webhooks/w/attach.imljson').componentPath, 'webhook/w/attach');
		assert.equal(s.describePath('rpcs/r/parameters.imljson').componentPath, 'rpc/r/parameters');
		for (const rel of ['modules/x/notes.txt', 'reviews/latest.json', 'metadata.json', 'functions/fmt/other.js', 'endpoints/getItem/notes.imljson', 'modules/x/deep/api.imljson', 'toString', 'endpoints/getItem/constructor', 'other/x/api.imljson']) {
			assert.equal(s.describePath(rel), null, rel);
		}
	});

	it('knows the six app files', () => {
		assert.deepEqual(Object.keys(s.APP_FILES), ['base.imljson', 'common.imljson', 'groups.imljson', 'readme.md', 'install.imljson', 'installSpec.imljson']);
		assert.deepEqual(s.METADATA_FIELDS, ['label', 'description', 'public', 'deprecated', 'archived', 'annotations']);
	});
});

describe('listedPaths', () => {
	it('keeps the app files and the files of listed components, and leaves out a lingering folder', () => {
		const metadata = { modules: [{ name: 'listItems' }], functions: [{ name: 'fmt' }], rpcs: 'x' };
		const rels = ['base.imljson', 'readme.md', 'modules/listItems/api.imljson', 'modules/gone/api.imljson', 'functions/fmt/code.js', 'rpcs/r/api.imljson', 'notes.txt'];
		assert.deepEqual(s.listedPaths(metadata, rels), ['base.imljson', 'readme.md', 'modules/listItems/api.imljson', 'functions/fmt/code.js']);
		assert.deepEqual(s.listedPaths(null, rels), ['base.imljson', 'readme.md']);
	});
});

describe('normalizeText', () => {
	it('reads \\r\\n as \\n and drops trailing new lines', () => {
		assert.equal(s.normalizeText('{\r\n  "a": 1\r\n}\r\n\r\n'), '{\n  "a": 1\n}');
		assert.equal(s.normalizeText('x'), 'x');
	});
});

describe('diffTrees', () => {
	const tree = (metadata, files) => ({ metadata, files: new Map(Object.entries(files)) });
	const working = tree(
		{ modules: [{ name: 'listItems' }, { name: 'newOne' }], connections: [{ name: 'c' }], rpcs: [] },
		{
			'base.imljson': '{\r\n    "name": "x"\r\n}\r\n',
			'common.imljson': '{"a": 2}',
			'readme.md': '# New',
			'modules/listItems/api.imljson': '{"url": "/v2"}',
			'modules/newOne/api.imljson': '{"url": "/new"}',
			'modules/gone/api.imljson': '{"url": "/gone"}',
			'connections/c/common.imljson': '{"b": 2}',
		},
	);
	const baseline = tree(
		{ modules: [{ name: 'listItems' }], connections: [{ name: 'c' }], rpcs: [{ name: 'oldRpc' }] },
		{
			'base.imljson': '{\n    "name": "x"\n}\n\n',
			'common.imljson': '{"a": 1}',
			'readme.md': '# Old',
			'modules/listItems/api.imljson': '{"url": "/v1"}',
			'rpcs/oldRpc/api.imljson': '{"url": "/rpc"}',
			'connections/c/common.imljson': '{"b": 1}',
		},
	);

	it('gives modified, added and removed rows sorted by path, and none for a CRLF-only change or a lingering folder', () => {
		const rows = s.diffTrees({ working, baseline });
		assert.deepEqual(rows.map((row) => row.path), ['common.imljson', 'connections/c/common.imljson', 'modules/listItems/api.imljson', 'modules/newOne/api.imljson', 'readme.md', 'rpcs/oldRpc/api.imljson', 'metadata.json', 'metadata.json']);
		assert.deepEqual(rows.slice(-2).map((row) => [row.componentPath, row.status]), [['module/newOne/metadata', 'added'], ['rpc/oldRpc/metadata', 'removed']]);
		const byPath = Object.fromEntries(rows.map((row) => [row.path, row]));
		assert.deepEqual(byPath['modules/listItems/api.imljson'], {
			id: null,
			group: 'module',
			item: 'listItems',
			code: 'api',
			componentPath: 'module/listItems/api',
			path: 'modules/listItems/api.imljson',
			language: 'imljson',
			status: 'modified',
			restorable: true,
			old_value: '{"url": "/v1"}',
			new_value: '{"url": "/v2"}',
		});
		assert.deepEqual([byPath['modules/newOne/api.imljson'].status, byPath['modules/newOne/api.imljson'].old_value, byPath['modules/newOne/api.imljson'].restorable], ['added', null, false]);
		assert.equal(byPath['modules/newOne/api.imljson'].new_value, '{"url": "/new"}');
		assert.deepEqual([byPath['rpcs/oldRpc/api.imljson'].status, byPath['rpcs/oldRpc/api.imljson'].new_value, byPath['rpcs/oldRpc/api.imljson'].restorable], ['removed', null, false]);
		assert.equal(byPath['rpcs/oldRpc/api.imljson'].old_value, '{"url": "/rpc"}');
		for (const rel of ['common.imljson', 'connections/c/common.imljson', 'readme.md']) {
			assert.equal(byPath[rel].status, 'modified', rel);
			assert.equal(byPath[rel].restorable, false, rel);
		}
		assert.equal(byPath['common.imljson'].componentPath, 'common');
		assert.equal(byPath['readme.md'].componentPath, null);
	});

	it('adds the metadata rows after the file rows', () => {
		const w = tree({ modules: [{ name: 'm', label: 'New' }] }, {});
		const b = tree({ modules: [{ name: 'm', label: 'Old' }] }, {});
		assert.deepEqual(s.diffTrees({ working: w, baseline: b }).map((row) => row.componentPath), ['module/m/metadata']);
		assert.deepEqual(s.diffTrees({ working: b, baseline: b }), []);
	});
});

describe('metadataRows', () => {
	it('gives one modified row per component whose metadata fields changed', () => {
		const w = { modules: [{ name: 'listItems', label: 'List items', typeId: 9, public: true }], endpoints: [{ name: 'getItem', label: 'Get', annotations: { readOnlyHint: true } }] };
		const b = { modules: [{ name: 'listItems', label: 'List', typeId: 4, public: true }], endpoints: [{ name: 'getItem', label: 'Get', annotations: null }] };
		const rows = s.metadataRows(w, b);
		assert.deepEqual(rows[1], {
			id: null,
			group: 'module',
			item: 'listItems',
			code: 'metadata',
			componentPath: 'module/listItems/metadata',
			path: 'metadata.json',
			language: 'imljson',
			status: 'modified',
			restorable: false,
			old_value: '{\n    "label": "List",\n    "public": true\n}',
			new_value: '{\n    "label": "List items",\n    "public": true\n}',
		});
		assert.equal(rows.length, 2);
		assert.equal(rows[0].componentPath, 'endpoint/getItem/metadata');
		assert.equal(rows[0].old_value, '{\n    "label": "Get",\n    "annotations": null\n}');
		assert.equal(rows[0].new_value, '{\n    "label": "Get",\n    "annotations": {\n        "readOnlyHint": true\n    }\n}');
	});

	it('gives an added or removed row for a component that only one tree lists, also without any section file', () => {
		const row = (item, status, oldValue, newValue) => ({ id: null, group: 'module', item, code: 'metadata', componentPath: `module/${item}/metadata`, path: 'metadata.json', language: 'imljson', status, restorable: false, old_value: oldValue, new_value: newValue });
		assert.deepEqual(s.metadataRows({ modules: [{ name: 'a', label: 'A', typeId: 4 }] }, { modules: [{ name: 'b', label: 'B' }] }), [row('a', 'added', null, '{\n    "label": "A"\n}'), row('b', 'removed', '{\n    "label": "B"\n}', null)]);
		assert.deepEqual(s.diffTrees({ working: { metadata: { modules: [{ name: 'a' }] }, files: new Map() }, baseline: { metadata: { rpcs: [{ name: 'r' }] }, files: new Map() } }).map((r) => [r.componentPath, r.status]), [['module/a/metadata', 'added'], ['rpc/r/metadata', 'removed']]);
	});

	it('gives no row for equal entries, or for a field that is null on one side and missing on the other', () => {
		assert.deepEqual(s.metadataRows({ modules: [{ name: 'a', label: 'A', deprecated: false }] }, { modules: [{ deprecated: false, label: 'A', name: 'a' }] }), []);
		assert.deepEqual(s.metadataRows({ modules: [{ name: 'a', label: 'A', description: null }] }, { modules: [{ name: 'a', label: 'A' }] }), []);
		assert.deepEqual(s.metadataRows(null, undefined), []);
		assert.deepEqual(s.metadataRows({ modules: [null, 'x', { name: 'a', label: 'A' }] }, { modules: [null, 'x', { name: 'a', label: 'A' }] }), []);
	});

	it('sorts the rows by component path', () => {
		const names = ['c', 'a', 'd', 'b'];
		const rows = s.metadataRows({ rpcs: names.map((name) => ({ name, label: '2' })) }, { rpcs: names.map((name) => ({ name, label: '1' })) });
		assert.deepEqual(rows.map((row) => row.componentPath), ['rpc/a/metadata', 'rpc/b/metadata', 'rpc/c/metadata', 'rpc/d/metadata']);
	});
});

describe('countRows', () => {
	it('counts metadata rows as modified', () => {
		const rows = [{ status: 'modified' }, { status: 'added' }, { status: 'removed' }, { status: 'modified', code: 'metadata' }];
		assert.deepEqual(s.countRows(rows), { total: 4, modified: 2, added: 1, removed: 1 });
		assert.deepEqual(s.countRows([]), { total: 0, modified: 0, added: 0, removed: 0 });
	});
});

describe('workingCopyEdited', () => {
	const synced = '2026-11-05T14:12:00.000Z';
	const t = (iso) => Date.parse(iso);
	const metadata = { modules: [{ name: 'm' }] };

	it('is false when every file is at or before downloadedAt, also within the same millisecond', () => {
		assert.equal(s.workingCopyEdited({ files: [{ rel: 'base.imljson', mtimeMs: t('2026-11-05T14:11:00Z') }, { rel: 'modules/m/api.imljson', mtimeMs: t(synced) + 0.7 }], downloadedAt: synced, metadata }), false);
	});

	it('is true when a section file is newer', () => {
		assert.equal(s.workingCopyEdited({ files: [{ rel: 'modules/m/api.imljson', mtimeMs: t(synced) + 1 }], downloadedAt: synced, metadata }), true);
		assert.equal(s.workingCopyEdited({ files: [{ rel: 'common.imljson', mtimeMs: t(synced) + 1 }], downloadedAt: synced }), true);
	});

	it('does not count metadata.json or a review file', () => {
		const files = [{ rel: 'metadata.json', mtimeMs: t(synced) + 60000 }, { rel: 'reviews/latest.json', mtimeMs: t(synced) + 60000 }];
		assert.equal(s.workingCopyEdited({ files, downloadedAt: synced, metadata }), false);
	});

	it('counts only section files, not notes, ticket files or review files of the folder', () => {
		const later = t(synced) + 60000;
		const others = ['notes.txt', 'jira/ticket.md', 'modules/m/notes.txt', 'reviews/review-2026-11-05T14-13-00.json'];
		const files = others.map((rel) => ({ rel, mtimeMs: later }));
		assert.equal(s.workingCopyEdited({ files, downloadedAt: synced, metadata }), false);
		assert.equal(s.workingCopyEdited({ files: [...files, { rel: 'modules/m/api.imljson', mtimeMs: later }], downloadedAt: synced, metadata }), true);
	});

	it('counts an edited file of a component made since the last download, which metadata.json does not list yet', () => {
		assert.equal(s.workingCopyEdited({ files: [{ rel: 'modules/newMod/api.imljson', mtimeMs: t(synced) + 60000 }], downloadedAt: synced, metadata: { modules: [] } }), true);
	});

	it('counts a missing or unreadable downloadedAt as edited', () => {
		assert.equal(s.workingCopyEdited({ files: [], downloadedAt: undefined, metadata }), true);
		assert.equal(s.workingCopyEdited({ files: [], downloadedAt: 'garbage', metadata }), true);
	});
});
