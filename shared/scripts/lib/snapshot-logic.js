/**
 * snapshot-logic.js: the decisions behind the snapshots of spec 3.3: ids, retention, the push gate, and the baseline
 * diff of review-changes.js. Pure functions only; the file work is in snapshot-store.js.
 */
const KEEP_SNAPSHOTS = 5;
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^(\d{8}-\d{6})(?:-([1-9]\d*))?$/;

/** An id is the UTC second `YYYYMMDD-HHMMSS`, with `-2`, `-3` and so on after a clash; `-1` is never written. */
function isSnapshotId(name) {
	const m = ID_RE.exec(String(name));
	return Boolean(m) && (m[2] === undefined || Number(m[2]) >= 2);
}

function idParts(id) {
	const m = ID_RE.exec(id);
	return [m[1], m[2] === undefined ? 1 : Number(m[2])];
}

function compareIds(a, b) {
	const [baseA, nA] = idParts(a);
	const [baseB, nB] = idParts(b);
	if (baseA !== baseB) return baseA < baseB ? -1 : 1;
	return nA - nB;
}

/** The ids among the names, oldest first. */
function sortIds(names) {
	return names.filter(isSnapshotId).sort(compareIds);
}

function snapshotId(ms, names) {
	const iso = new Date(ms).toISOString();
	const base = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
	const taken = new Set(names);
	if (!taken.has(base)) return base;
	let n = 2;
	while (taken.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

/** The ids to remove so that `keep` stay: the newest ones, and always `current` (the snapshot just written). */
function pruneChoice(names, keep = KEEP_SNAPSHOTS, current = null) {
	const ids = sortIds(names);
	return ids.filter((id) => id !== current).slice(0, Math.max(0, ids.length - keep));
}

function staleTemps(entries, nowMs) {
	return entries.filter((e) => e.name.endsWith('.tmp') && nowMs - e.mtimeMs > TEMP_MAX_AGE_MS).map((e) => e.name);
}

/**
 * The push gate: ok when the newest snapshot (by id) was taken at or after the working folder's downloadedAt. A
 * missing or unreadable downloadedAt counts as time 0; a snapshot without a usable takenAt does not count.
 */
function gateDecision({ snapshots, workingDownloadedAt }) {
	const usable = snapshots.filter((x) => isSnapshotId(x.id) && Number.isFinite(Date.parse(x.takenAt)));
	const newest = usable.sort((a, b) => compareIds(a.id, b.id)).at(-1) || null;
	const synced = Date.parse(workingDownloadedAt);
	const since = Number.isFinite(synced) ? synced : 0;
	return { ok: newest !== null && Date.parse(newest.takenAt) >= since, newest };
}

function gateRefusalLines({ slug, version, command }) {
	return [
		`No snapshot of ${slug} v${version} since the last sync, so nothing was sent.`,
		'In public mode a push can be live at once with no way back in Make. Take a snapshot first; it reads Make and changes nothing:',
		`  ${command} ${slug} ${version} --snapshot`,
		'Then run this command again. Do not push with a Make MCP tool instead.',
	];
}

function snapshotDoneLines({ id, dir, kept }) {
	return [`Snapshot: ${id}`, `Path: ${dir}`, `Kept: ${kept} of ${KEEP_SNAPSHOTS}`, 'Taken before the push: its files can be pushed back by hand.'];
}

const APP_FILES = { 'base.imljson': 'base', 'common.imljson': 'common', 'groups.imljson': 'groups', 'readme.md': 'readme', 'install.imljson': 'install', 'installSpec.imljson': 'installSpec' };
const COMPONENT_DIRS = { modules: 'module', connections: 'connection', webhooks: 'webhook', rpcs: 'rpc', functions: 'function', endpoints: 'endpoint' };
const ENDPOINT_FILES = { 'api.imljson': 'api', 'input_parameters.imljson': 'input_parameters', 'output_parameters.imljson': 'output_parameters', 'scope.imljson': 'scope', 'context.md': 'context' };
const METADATA_FIELDS = ['label', 'description', 'public', 'deprecated', 'archived', 'annotations'];
const COMPONENT_PATH_RE = /^(modules|connections|webhooks|rpcs|functions|endpoints)\/([^/]+)\/([^/]+)$/;

const languageOfFile = (file) => (file.endsWith('.js') ? 'js' : file.endsWith('.md') ? 'md' : 'imljson');
const isObject = (value) => value !== null && typeof value === 'object';
const entriesOf = (metadata, list) => (Array.isArray(metadata?.[list]) ? metadata[list].filter(isObject) : []);

/** What a file of a working copy or snapshot is: { group, item, code, componentPath, language }, or null for any other file. */
function describePath(rel) {
	if (Object.hasOwn(APP_FILES, rel)) {
		const code = APP_FILES[rel];
		return { group: 'app', item: null, code, componentPath: code === 'readme' ? null : code, language: languageOfFile(rel) };
	}
	const m = COMPONENT_PATH_RE.exec(rel);
	if (!m) return null;
	const group = COMPONENT_DIRS[m[1]];
	const file = m[3];
	let code;
	if (group === 'endpoint') code = Object.hasOwn(ENDPOINT_FILES, file) ? ENDPOINT_FILES[file] : undefined;
	else if (group === 'function') code = /^(code|test)\.js$/.test(file) ? file.slice(0, -3) : undefined;
	else code = file.endsWith('.imljson') ? file.slice(0, -'.imljson'.length) : undefined;
	if (!code) return null;
	return { group, item: m[2], code, componentPath: `${group}/${m[2]}/${code}`, language: languageOfFile(file) };
}

function componentNames(metadata, group) {
	const list = Object.keys(COMPONENT_DIRS).find((key) => COMPONENT_DIRS[key] === group);
	return new Set(entriesOf(metadata, list).map((c) => c.name));
}

/** The app files and the files of the components that metadata.json lists, so a lingering folder pairs with nothing. */
function listedPaths(metadata, relPaths) {
	return relPaths.filter((rel) => {
		const d = describePath(rel);
		return d !== null && (d.group === 'app' || componentNames(metadata, d.group).has(d.item));
	});
}

function normalizeText(text) {
	return String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

function fileRow(rel, oldText, newText) {
	const d = describePath(rel);
	const status = oldText === undefined ? 'added' : newText === undefined ? 'removed' : 'modified';
	const restorable = status === 'modified' && d.code !== 'common' && d.code !== 'readme';
	return { id: null, group: d.group, item: d.item, code: d.code, componentPath: d.componentPath, path: rel, language: d.language, status, restorable, old_value: oldText ?? null, new_value: newText ?? null };
}

/** The metadata fields an entry has, in the order of METADATA_FIELDS. */
function pickFields(entry) {
	const out = {};
	for (const key of METADATA_FIELDS) if (entry[key] !== undefined) out[key] = entry[key];
	return out;
}

/** The text two entries are compared by: the six fields in one order, a missing field read as null. */
function compareText(entry) {
	return JSON.stringify(METADATA_FIELDS.map((key) => entry[key] ?? null));
}

/**
 * One row per component whose metadata fields differ between the trees (spec 2.1, common 6), and one per component
 * that only one tree lists (added or removed, also when it has no section file).
 */
function metadataRows(workingMeta, baselineMeta) {
	const rows = [];
	const fieldsText = (entry) => (entry ? JSON.stringify(pickFields(entry), null, 4) : null);
	for (const [list, group] of Object.entries(COMPONENT_DIRS)) {
		const before = new Map(entriesOf(baselineMeta, list).map((c) => [c.name, c]));
		const after = new Map(entriesOf(workingMeta, list).map((c) => [c.name, c]));
		for (const name of new Set([...after.keys(), ...before.keys()])) {
			const old = before.get(name);
			const entry = after.get(name);
			if (old && entry && compareText(old) === compareText(entry)) continue;
			const status = !old ? 'added' : !entry ? 'removed' : 'modified';
			rows.push({ id: null, group, item: name, code: 'metadata', componentPath: `${group}/${name}/metadata`, path: 'metadata.json', language: 'imljson', status, restorable: false, old_value: fieldsText(old), new_value: fieldsText(entry) });
		}
	}
	return rows.sort((a, b) => (a.componentPath < b.componentPath ? -1 : 1));
}

/** The rows of the baseline route: the files by path (CRLF and trailing new lines ignored), then the metadata rows. */
function diffTrees({ working, baseline }) {
	const w = new Set(listedPaths(working.metadata, [...working.files.keys()]));
	const b = new Set(listedPaths(baseline.metadata, [...baseline.files.keys()]));
	const rows = [];
	for (const rel of [...new Set([...w, ...b])].sort()) {
		const oldText = b.has(rel) ? baseline.files.get(rel) : undefined;
		const newText = w.has(rel) ? working.files.get(rel) : undefined;
		if (oldText !== undefined && newText !== undefined && normalizeText(oldText) === normalizeText(newText)) continue;
		rows.push(fileRow(rel, oldText, newText));
	}
	return [...rows, ...metadataRows(working.metadata, baseline.metadata)];
}

function countRows(rows) {
	const count = (status) => rows.filter((r) => r.status === status).length;
	return { total: rows.length, modified: count('modified'), added: count('added'), removed: count('removed') };
}

/**
 * Whether an app section file or a section file of any component folder is newer than downloadedAt, also of a
 * component made since the last download (metadata.json does not list it yet); notes and reviews/ do not count, and a
 * folder of a removed component is never newer. No usable downloadedAt counts as edited.
 */
function workingCopyEdited({ files, downloadedAt }) {
	const synced = Date.parse(downloadedAt);
	if (!Number.isFinite(synced)) return true;
	return files.some((f) => describePath(f.rel) !== null && Math.floor(f.mtimeMs) > synced);
}

module.exports = {
	KEEP_SNAPSHOTS,
	TEMP_MAX_AGE_MS,
	APP_FILES,
	METADATA_FIELDS,
	isSnapshotId,
	compareIds,
	sortIds,
	snapshotId,
	pruneChoice,
	staleTemps,
	gateDecision,
	gateRefusalLines,
	snapshotDoneLines,
	describePath,
	listedPaths,
	normalizeText,
	diffTrees,
	metadataRows,
	countRows,
	workingCopyEdited,
};
