const fs = require('fs');

/**
 * Update `key` lines in place. Readers use the last matching line, so the last one is replaced and earlier
 * duplicates of the same key are dropped; keys without a line are appended.
 */
function applyKeyedUpdates(text, updates, { matchLine, formatLine }) {
	const entries = Object.entries(updates).filter(([, value]) => value != null);
	if (!text) {
		return entries.map(([key, value]) => formatLine(key, value)).join('\n') + '\n';
	}
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	const lastIndex = new Map();
	lines.forEach((line, i) => {
		for (const [key] of entries) if (matchLine(line, key)) lastIndex.set(key, i);
	});
	const next = [];
	lines.forEach((line, i) => {
		const hit = entries.find(([key]) => matchLine(line, key));
		if (!hit) return next.push(line);
		if (lastIndex.get(hit[0]) === i) next.push(formatLine(hit[0], hit[1]));
	});
	for (const [key, value] of entries) if (!lastIndex.has(key)) next.push(formatLine(key, value));
	return next.join('\n') + '\n';
}

function applySecretsUpdates(text, updates) {
	return applyKeyedUpdates(text, updates, {
		matchLine: (line, key) => new RegExp(`^\\s*${key}:\\s*`).test(line),
		formatLine: (key, value) => `${key}: ${value}`,
	});
}

function applyEnvUpdates(text, updates) {
	return applyKeyedUpdates(text, updates, {
		matchLine: (line, key) => new RegExp(`^${key}=`).test(line),
		formatLine: (key, value) => `${key}=${value}`,
	});
}

/**
 * Replace the file in one step: write a private temp file next to it, then rename it over the target. A reader or a
 * second writer never sees a half-written file. A symlinked file keeps its link because the real path is replaced.
 */
function writePrivate(filePath, contents) {
	const target = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
	const tmp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, contents, { mode: 0o600, flag: 'wx' });
	try {
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, target);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* nothing to clean up */
		}
		throw err;
	}
}

function upsertSecretsFile(filePath, updates) {
	const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
	writePrivate(filePath, applySecretsUpdates(existing, updates));
}

function upsertEnvFile(filePath, updates) {
	const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
	writePrivate(filePath, applyEnvUpdates(existing, updates));
}

function requireTty(stdin = process.stdin) {
	if (!stdin || !stdin.isTTY) {
		const err = new Error(
			'Run this in your own terminal (not via the agent). It is interactive and writes secrets.',
		);
		err.code = 'NOT_TTY';
		throw err;
	}
}

module.exports = {
	applySecretsUpdates,
	applyEnvUpdates,
	upsertSecretsFile,
	upsertEnvFile,
	requireTty,
};
