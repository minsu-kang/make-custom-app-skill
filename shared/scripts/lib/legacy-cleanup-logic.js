/**
 * legacy-cleanup-logic.js: the text and JSON transforms of the old-install cleanup, and its one error formatter.
 *
 * Role: pure functions on strings. No file access, no environment, no home folder. They run on the user's real config
 * text later, so each one is exact (every byte it does not name stays), reversible (the restore inserts what the removal
 * cut), and never prints or throws file content. describeError is the only place that turns an error into text.
 * A new rule goes here with a unit test in lib/__tests__/legacy-cleanup-logic.test.js.
 */
const crypto = require('crypto');
const { SENTINEL_OPEN, SENTINEL_CLOSE } = require('./legacy-install');
const { isPlaceholder } = require('./settings');

const ENV_TO_KEY = Object.freeze({ PINECONE_API_KEY: 'pinecone-api-key', OPENAI_API_KEY: 'openai-api-key', PINECONE_INDEX_NAME: 'pinecone-index-name' });

/** The text between the markers of the block that the old Claude installer wrote, without carriage returns, trimmed. */
const INSTALLER_BLOCK_BODY =
	'# Make Custom App Skill\n\nWhen the conversation involves a Make.com custom app, IMLJSON, the Make Apps SDK, `make-app-contexts`, or an IEN Jira ticket about an app: invoke the `make-custom-app` skill before any other action and follow it. Do not answer from memory. Do not delegate this work to a sub-agent.';

const OWN_LINE = /(?<![\w-])make-custom-app(?![\w-])`?\s+skill/i;
const ENV_LINE = /^(\s*)(PINECONE_API_KEY|OPENAI_API_KEY|PINECONE_INDEX_NAME)(\s*=\s*)([\s\S]*)$/;
const ANY_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=([\s\S]*)$/;
const CR_OR_LF = /[\r\n]/;
const BOM = '\uFEFF';
const DEFAULT_INDENT = '  ';

function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Defines an own enumerable member, also for the name __proto__, which a plain assignment would take as the prototype. */
function setOwn(target, key, value) {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function addOnce(list, value) {
	if (!list.includes(value)) list.push(value);
}

function canonical(value) {
	if (Array.isArray(value)) return `[${value.map((item) => canonical(item) ?? 'null').join(',')}]`;
	if (isPlainObject(value)) {
		const parts = [];
		for (const key of Object.keys(value).sort()) {
			const text = canonical(value[key]);
			if (text !== undefined) parts.push(`${JSON.stringify(key)}:${text}`);
		}
		return `{${parts.join(',')}}`;
	}
	return JSON.stringify(value);
}

/** JSON with the keys of every object sorted and no whitespace, so equal data gives equal text. */
function canonicalJson(value) {
	return canonical(value) ?? 'null';
}

function sha256(text) {
	return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The only text that phase B shows for an error. The message of a JSON.parse error can quote the source text, so no
 * message is ever used: a SyntaxError gives the path, a file system error gives its code and the path, and anything else
 * gives a fixed sentence.
 */
function describeError(err, filePath) {
	if (err instanceof SyntaxError) return `${filePath} is not valid JSON`;
	if (err && typeof err.code === 'string') return `${err.code} on ${filePath}`;
	return 'an unexpected error occurred';
}

/** The lines of a text with their offsets: `start`, `end` (after the line ending), and `content` (without it and without a trailing carriage return). */
function splitLines(text) {
	const lines = [];
	let start = 0;
	while (start < text.length) {
		const newline = text.indexOf('\n', start);
		const end = newline === -1 ? text.length : newline + 1;
		const raw = text.slice(start, newline === -1 ? text.length : newline);
		lines.push({ start, end, content: raw.endsWith('\r') ? raw.slice(0, -1) : raw });
		start = end;
	}
	return lines;
}

function markerLines(lines, marker) {
	const found = [];
	for (const [index, line] of lines.entries()) if (line.content.trim() === marker) found.push(index);
	return found;
}

/**
 * Finds the block that the old Claude installer appended to ~/.claude/CLAUDE.md. A marker is a whole line (trimmed, and
 * without a carriage return). `ok` needs exactly one open line and one close line after it. A text with no open line is
 * `none`; more than one open or close line is `multiple`; one open line with no close line is `unclosed`; a close line
 * before the open line is `reversed`. For `ok`, `removedText` is the exact piece removeBlock cuts: the empty line right
 * before the open marker when there is one, both marker lines with everything between them, and the line ending after
 * the close marker; `offset` is its start; `lineStart` and `lineEnd` are the 1-based lines of the markers; `edited` is
 * true when the text between the markers is not the installer's. The offset fields are null for the other statuses.
 */
function findSentinelBlock(text) {
	const none = (status) => ({ status, offset: null, removedText: null, lineStart: null, lineEnd: null, edited: false });
	const lines = splitLines(text);
	const opens = markerLines(lines, SENTINEL_OPEN);
	const closes = markerLines(lines, SENTINEL_CLOSE);
	if (opens.length === 0) return none('none');
	if (opens.length > 1 || closes.length > 1) return none('multiple');
	if (closes.length === 0) return none('unclosed');
	const [open] = opens;
	const [close] = closes;
	if (close < open) return none('reversed');
	const offset = open > 0 && lines[open - 1].content === '' ? lines[open - 1].start : lines[open].start;
	const inner = text.slice(lines[open].end, lines[close].start).replace(/\r/g, '').trim();
	return {
		status: 'ok',
		offset,
		removedText: text.slice(offset, lines[close].end),
		lineStart: open + 1,
		lineEnd: close + 1,
		edited: inner !== INSTALLER_BLOCK_BODY,
	};
}

/** `text` without the block that findSentinelBlock found in it; every other byte and line ending stays. A block that is not `ok` removes nothing. */
function removeBlock(text, block) {
	if (!block || block.status !== 'ok') return text;
	if (text.slice(block.offset, block.offset + block.removedText.length) !== block.removedText) throw new TypeError('removeBlock needs a block that was found in this text');
	return text.slice(0, block.offset) + text.slice(block.offset + block.removedText.length);
}

/**
 * Puts back what removeBlock cut. `present`: the open marker is already a whole line, nothing changes. `spliced`: the text
 * is exactly what the removal left (its sha256 is `step.sha256After`), so the piece goes back at `step.offset`. `appended`:
 * the text changed since, so the piece goes at the end, after a line ending when the text lacks one.
 */
function restoreBlock(text, step) {
	if (typeof text !== 'string' || !step || typeof step.removedText !== 'string') throw new TypeError('restoreBlock needs text and step.removedText');
	if (markerLines(splitLines(text), SENTINEL_OPEN).length > 0) return { text, how: 'present' };
	const offsetUsable = Number.isInteger(step.offset) && step.offset >= 0 && step.offset <= text.length;
	if (offsetUsable && sha256(text) === step.sha256After) {
		return { text: text.slice(0, step.offset) + step.removedText + text.slice(step.offset), how: 'spliced' };
	}
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lead = text === '' || text.endsWith('\n') ? '' : eol;
	return { text: text + lead + step.removedText, how: 'appended' };
}

/** The 1-based numbers of the lines outside the block that name the make-custom-app skill: the user's own text, which the cleanup never edits. */
function findOwnLines(text, block) {
	const inside = block && block.status === 'ok' ? (number) => number >= block.lineStart && number <= block.lineEnd : () => false;
	const found = [];
	for (const [index, line] of splitLines(text).entries()) {
		if (!inside(index + 1) && OWN_LINE.test(line.content)) found.push(index + 1);
	}
	return found;
}

/** True when an `.env` or registration value can be a secret to copy: not empty, one line, not a `${...}` reference, not a placeholder (Ruling 7). */
function usableValue(value) {
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	return trimmed !== '' && !CR_OR_LF.test(value) && !trimmed.startsWith('${') && !isPlaceholder(trimmed);
}

/**
 * Reads an old `.env` as a template (Ruling 36). A line of one of the three names whose raw value (the text after the
 * separator, without the line ending) is usable and equals `secretValue(pluginKey)` becomes `{ prefix, $secret }`; every
 * other line stays a string, byte for byte. `values` holds the trimmed usable values (the last one of a name wins).
 * `names` lists every assignment name once, `unknownAssignments` the names other than the three that have a value, and
 * `untemplatedSecretLines` the names of the three whose value is usable but differs from the secrets file or has a line
 * break inside it: the file holds something the secrets file does not. An `export NAME=value` line counts as an
 * assignment of another name, because it cannot be templated.
 * Line endings are CRLF when the text has one, so a text with mixed endings does not render back to the same bytes.
 */
function parseEnvTemplate(text, secretValue) {
	if (typeof text !== 'string' || typeof secretValue !== 'function') throw new TypeError('parseEnvTemplate needs text and secretValue');
	const bom = text.startsWith(BOM);
	const body = bom ? text.slice(1) : text;
	const eol = body.includes('\r\n') ? '\r\n' : '\n';
	const trailingNewline = body.endsWith('\n');
	const lines = body.split(/\r?\n/);
	if (trailingNewline) lines.pop();

	const template = [];
	const values = {};
	const names = [];
	const unknownAssignments = [];
	const untemplatedSecretLines = [];
	for (const line of lines) {
		const secretLine = ENV_LINE.exec(line);
		if (secretLine) {
			const [, lead, name, separator, raw] = secretLine;
			addOnce(names, name);
			const key = ENV_TO_KEY[name];
			if (usableValue(raw)) {
				values[name] = raw.trim();
				if (raw === secretValue(key)) {
					template.push({ prefix: lead + name + separator, $secret: key });
					continue;
				}
				addOnce(untemplatedSecretLines, name);
			} else if (CR_OR_LF.test(raw)) {
				addOnce(untemplatedSecretLines, name);
			}
		} else {
			const other = ANY_ASSIGNMENT.exec(line);
			if (other) {
				addOnce(names, other[1]);
				if (other[2].trim() !== '') addOnce(unknownAssignments, other[1]);
			}
		}
		template.push(line);
	}
	return { template, values, names, unknownAssignments, eol, trailingNewline, bom, untemplatedSecretLines };
}

/** Rebuilds the text of a parsed `.env`: BOM, line endings, and final newline as read; a templated line gets `secretValue(pluginKey)`. */
function renderEnvTemplate(parsed, secretValue) {
	if (!parsed || !Array.isArray(parsed.template) || typeof secretValue !== 'function') throw new TypeError('renderEnvTemplate needs parsed and secretValue');
	const lines = parsed.template.map((item) => {
		if (typeof item === 'string') return item;
		const value = secretValue(item.$secret);
		if (typeof value !== 'string') throw new TypeError('renderEnvTemplate needs a value for every templated line');
		return item.prefix + value;
	});
	return (parsed.bom ? BOM : '') + lines.join(parsed.eol) + (parsed.trailingNewline ? parsed.eol : '');
}

/**
 * A deep copy of a registration whose `env` values that equal the secrets-file value become `{ "$secret": <plugin key> }`
 * (Ruling 9). Every other value stays and its name goes to `literalKeys`.
 */
function redactEntry(entry, secretsByKey) {
	const copy = structuredClone(entry);
	const literalKeys = [];
	if (isPlainObject(copy) && isPlainObject(copy.env)) {
		const known = isPlainObject(secretsByKey) ? secretsByKey : {};
		for (const [name, value] of Object.entries(copy.env)) {
			const key = Object.hasOwn(ENV_TO_KEY, name) ? ENV_TO_KEY[name] : undefined;
			const secret = key === undefined ? undefined : known[key];
			if (typeof secret === 'string' && secret !== '' && value === secret) setOwn(copy.env, name, { $secret: key });
			else literalKeys.push(name);
		}
	}
	return { entry: copy, literalKeys };
}

/** A deep copy of a registration whose `env` values are replaced by their names, so a fingerprint holds no value. */
function nameOnlyEntry(entry) {
	const copy = structuredClone(entry);
	if (isPlainObject(copy) && isPlainObject(copy.env)) {
		for (const name of Object.keys(copy.env)) setOwn(copy.env, name, name);
	}
	return copy;
}

/** JSON.parse that throws a SyntaxError without the parser's message, which can quote the text. */
function parseJsonText(text, name) {
	if (typeof text !== 'string') throw new TypeError(`${name} needs text`);
	try {
		return JSON.parse(text);
	} catch {
		throw new SyntaxError('the text is not valid JSON');
	}
}

function jsonLayout(text) {
	const firstBreak = text.indexOf('\n');
	const indented = /^([ \t]+)\S/m.exec(firstBreak === -1 ? '' : text.slice(firstBreak + 1));
	return { indent: indented ? indented[1] : DEFAULT_INDENT, eol: text.includes('\r\n') ? '\r\n' : '\n', trailingNewline: text.endsWith('\n') };
}

function serializeJson(value, { indent, eol, trailingNewline }) {
	const text = JSON.stringify(value, null, indent);
	return (eol === '\n' ? text : text.replace(/\n/g, eol)) + (trailingNewline ? eol : '');
}

/**
 * Takes the member `key` out of `mcpServers` of a JSON text and serializes the rest with the layout of the input: the
 * indent of its first indented line (two spaces when it has none), CRLF when it has one, and a final line ending when it
 * had one. Returns null unless the text parses and `mcpServers` has the own key. `position` is the index of the key in
 * `mcpServers`, `entry` the removed value, and `canonical` is true when the input is exactly that serialization of its own
 * content, so a restore gives the same bytes. Throws a SyntaxError (with no text in it) when the text does not parse.
 */
function removeJsonMember(text, key) {
	const parsed = parseJsonText(text, 'removeJsonMember');
	if (!isPlainObject(parsed) || !Object.hasOwn(parsed, 'mcpServers') || !isPlainObject(parsed.mcpServers) || !Object.hasOwn(parsed.mcpServers, key)) return null;
	const layout = jsonLayout(text);
	const servers = parsed.mcpServers;
	const isCanonical = serializeJson(parsed, layout) === text;
	const position = Object.keys(servers).indexOf(key);
	const entry = servers[key];
	delete servers[key];
	return { text: serializeJson(parsed, layout), position, indent: layout.indent, eol: layout.eol, trailingNewline: layout.trailingNewline, canonical: isCanonical, entry };
}

/**
 * Puts a member back into `mcpServers` at `position` (the end when it is missing or too large; the object is created when
 * the text has none) and serializes with the given layout (two spaces, LF, no final line ending by default). Throws a
 * TypeError when the key is already there or the text is not an object, and a SyntaxError when it does not parse.
 */
function insertJsonMember(text, key, entry, { position, indent = DEFAULT_INDENT, eol = '\n', trailingNewline = false } = {}) {
	const parsed = parseJsonText(text, 'insertJsonMember');
	if (!isPlainObject(parsed)) throw new TypeError('insertJsonMember needs a JSON object');
	const hasServers = Object.hasOwn(parsed, 'mcpServers');
	if (hasServers && !isPlainObject(parsed.mcpServers)) throw new TypeError('insertJsonMember needs mcpServers to be an object');
	const servers = hasServers ? parsed.mcpServers : {};
	if (Object.hasOwn(servers, key)) throw new TypeError('insertJsonMember needs a key that is not there yet');
	const entries = Object.entries(servers);
	entries.splice(Number.isInteger(position) ? Math.max(position, 0) : entries.length, 0, [key, entry]);
	const next = {};
	for (const [name, value] of entries) setOwn(next, name, value);
	parsed.mcpServers = next;
	return serializeJson(parsed, { indent, eol, trailingNewline });
}

/** `text` with every non-empty secret (and its trimmed form) replaced by `<redacted>`, the longest first. Refuses anything but an array or a Set of secrets, so a secret is never printed by mistake. */
function redactOutput(text, secrets) {
	if (!Array.isArray(secrets) && !(secrets instanceof Set)) throw new TypeError('redactOutput needs a list of secrets');
	const candidates = [];
	for (const secret of secrets) {
		if (typeof secret !== 'string' || secret.trim() === '') continue;
		candidates.push(secret);
		if (secret.trim() !== secret) candidates.push(secret.trim());
	}
	candidates.sort((a, b) => b.length - a.length);
	let out = String(text ?? '');
	for (const secret of candidates) out = out.split(secret).join('<redacted>');
	return out;
}

module.exports = {
	canonicalJson,
	sha256,
	describeError,
	INSTALLER_BLOCK_BODY,
	findSentinelBlock,
	removeBlock,
	restoreBlock,
	findOwnLines,
	ENV_TO_KEY,
	usableValue,
	parseEnvTemplate,
	renderEnvTemplate,
	redactEntry,
	nameOnlyEntry,
	removeJsonMember,
	insertJsonMember,
	redactOutput,
};
