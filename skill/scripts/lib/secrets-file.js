const fs = require('fs');

function applyKeyedUpdates(text, updates, { matchLine, formatLine }) {
	const entries = Object.entries(updates).filter(([, value]) => value != null);
	if (!text) {
		return entries.map(([key, value]) => formatLine(key, value)).join('\n') + '\n';
	}
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	const remaining = new Map(entries);
	const next = lines.map((line) => {
		for (const [key, value] of remaining) {
			if (matchLine(line, key)) {
				remaining.delete(key);
				return formatLine(key, value);
			}
		}
		return line;
	});
	for (const [key, value] of remaining) next.push(formatLine(key, value));
	return next.join('\n') + '\n';
}

function applySecretsUpdates(text, updates) {
	return applyKeyedUpdates(text, updates, {
		matchLine: (line, key) => new RegExp(`^${key}:\\s*`).test(line),
		formatLine: (key, value) => `${key}: ${value}`,
	});
}

function applyEnvUpdates(text, updates) {
	return applyKeyedUpdates(text, updates, {
		matchLine: (line, key) => new RegExp(`^${key}=`).test(line),
		formatLine: (key, value) => `${key}=${value}`,
	});
}

function writePrivate(filePath, contents) {
	fs.writeFileSync(filePath, contents, { mode: 0o600 });
	fs.chmodSync(filePath, 0o600);
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
