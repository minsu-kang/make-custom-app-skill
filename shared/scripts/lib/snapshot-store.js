/**
 * snapshot-store.js: the snapshot folders of spec 3.3, ~/.make-custom-app/snapshots/{slug}-v{version}/{id}/.
 * A snapshot is written to {id}.tmp and renamed in one step, so a half-written snapshot is never visible; folders are
 * 0700 and files 0600; the newest KEEP_SNAPSHOTS stay. The decisions are in snapshot-logic.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getContextsDir, getSnapshotsDir, scriptCommand } = require('./paths');
const logic = require('./snapshot-logic');

function appSnapshotsDir(slug, version, { home = os.homedir() } = {}) {
	return path.join(getSnapshotsDir(home), `${slug}-v${version}`);
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

function names(dir, { strict = false } = {}) {
	try {
		return fs.readdirSync(dir);
	} catch (err) {
		if (strict && err.code !== 'ENOENT') throw err;
		return [];
	}
}

/**
 * The snapshots of one app version, oldest first: id folders whose metadata.json holds a snapshot.takenAt text. A
 * folder that cannot be listed reads as no snapshot; with `strict` its error is thrown instead (a missing one stays none).
 */
function listSnapshots(slug, version, { home = os.homedir(), strict = false } = {}) {
	const root = appSnapshotsDir(slug, version, { home });
	return logic.sortIds(names(root, { strict })).flatMap((id) => {
		const dir = path.join(root, id);
		const takenAt = readJson(path.join(dir, 'metadata.json'))?.snapshot?.takenAt;
		return typeof takenAt === 'string' ? [{ id, takenAt, dir }] : [];
	});
}

function removeStaleTemps(root, nowMs) {
	const entries = names(root).map((name) => {
		try {
			return { name, mtimeMs: fs.statSync(path.join(root, name)).mtimeMs };
		} catch {
			return { name, mtimeMs: nowMs };
		}
	});
	for (const name of logic.staleTemps(entries, nowMs)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
}

/**
 * Writes `files` ([relative path, text] pairs) and metadata.json with `snapshot: { id, takenAt }` as a new snapshot,
 * then prunes the oldest beyond KEEP_SNAPSHOTS, never the new one. On a failed write it removes its temp folder and
 * throws; an old snapshot that cannot be removed stays, and the new snapshot still counts as saved.
 */
function writeSnapshot({ slug, version, files, metadata, home = os.homedir(), now = Date.now }) {
	const root = appSnapshotsDir(slug, version, { home });
	const nowMs = now();
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	removeStaleTemps(root, nowMs);
	const id = logic.snapshotId(nowMs, names(root));
	const takenAt = new Date(nowMs).toISOString();
	const temp = path.join(root, `${id}.tmp`);
	fs.mkdirSync(temp, { mode: 0o700 });
	try {
		for (const [rel, text] of files) {
			const file = path.join(temp, rel);
			fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
		}
		fs.writeFileSync(path.join(temp, 'metadata.json'), JSON.stringify({ ...metadata, snapshot: { id, takenAt } }, null, 2), { flag: 'wx', mode: 0o600 });
		fs.renameSync(temp, path.join(root, id));
	} catch (err) {
		fs.rmSync(temp, { recursive: true, force: true });
		throw err;
	}
	for (const old of logic.pruneChoice(names(root), logic.KEEP_SNAPSHOTS, id)) {
		try {
			fs.rmSync(path.join(root, old), { recursive: true, force: true });
		} catch {
			/* left for the next prune */
		}
	}
	return { id, dir: path.join(root, id), takenAt, kept: logic.sortIds(names(root)).length };
}

/** The push gate of public mode: { ok: true, lines: [] }, or { ok: false, lines } with the refusal of spec 3.3. */
function pushGate({ slug, version, home = os.homedir(), command = scriptCommand('download-app.js') }) {
	const working = readJson(path.join(getContextsDir(home), `${slug}-v${version}`, 'metadata.json'));
	const decision = logic.gateDecision({ snapshots: listSnapshots(slug, version, { home }), workingDownloadedAt: working?.downloadedAt ?? null });
	return decision.ok ? { ok: true, lines: [] } : { ok: false, lines: logic.gateRefusalLines({ slug, version, command }) };
}

/**
 * A working copy or a snapshot for the baseline diff: metadata.json parsed, the text of every other file except those
 * under reviews/, and the times of every file except those under reviews/. Throws when the tree cannot be read.
 */
function readTree(dir) {
	const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
	const files = new Map();
	const mtimes = [];
	const walk = (rel) => {
		for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			if (child === 'reviews') continue;
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile()) {
				const file = path.join(dir, child);
				mtimes.push({ rel: child, mtimeMs: fs.statSync(file).mtimeMs });
				if (child !== 'metadata.json') files.set(child, fs.readFileSync(file, 'utf8'));
			}
		}
	};
	walk('');
	return { metadata, files, mtimes };
}

module.exports = { appSnapshotsDir, listSnapshots, writeSnapshot, pushGate, readTree };
