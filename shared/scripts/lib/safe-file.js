'use strict';
/**
 * safe-file.js: the small JSON files the scripts keep for themselves (the mode cache, the update-check cache and the
 * live-run notice). A read never follows a symlink, never blocks on a FIFO, and takes only a regular file of at most
 * 4 KiB that this user owns. A write goes to a new temp file (flag wx, mode 0600) that is renamed over the target, so a
 * planted link is replaced, never followed. Neither function throws.
 */
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 4096;

function readFlags(constants = fs.constants) {
	return constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
}

function currentUid() {
	return typeof process.getuid === 'function' ? process.getuid() : null;
}

function readOwnedJson(file, { maxBytes = MAX_BYTES, uid = currentUid() } = {}) {
	let fd = null;
	try {
		fd = fs.openSync(file, readFlags());
		const st = fs.fstatSync(fd);
		if (!st.isFile() || st.size > maxBytes) return null;
		if (uid !== null && st.uid !== uid) return null;
		const buf = Buffer.alloc(st.size);
		const read = st.size ? fs.readSync(fd, buf, 0, st.size, 0) : 0;
		const value = JSON.parse(buf.subarray(0, read).toString('utf8'));
		return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	} finally {
		if (fd !== null) fs.closeSync(fd);
	}
}

function writeOwnedJson(file, value, { mkdir = false } = {}) {
	const temp = `${file}.${process.pid}.tmp`;
	try {
		const text = JSON.stringify(value);
		if (mkdir) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		try {
			fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
		} catch (err) {
			if (err.code !== 'EEXIST') throw err;
			fs.unlinkSync(temp);
			fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
		}
		fs.renameSync(temp, file);
		return true;
	} catch {
		try {
			fs.rmSync(temp, { force: true });
		} catch {
			/* a temp file of another user in a shared temp folder: left for its owner */
		}
		return false;
	}
}

module.exports = { MAX_BYTES, readFlags, currentUid, readOwnedJson, writeOwnedJson };
