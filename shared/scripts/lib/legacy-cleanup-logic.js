/**
 * legacy-cleanup-logic.js: the text and JSON transforms of the old-install cleanup, its plan, and its one error formatter.
 *
 * Role: pure functions on strings and on facts that were read elsewhere. No file access, no environment, no home folder.
 * They run on the user's real config text later, so each one is exact (every byte it does not name stays), reversible
 * (the restore inserts what the removal cut), and never prints or throws file content. describeError is the only place
 * that turns an error into text. buildPlan is the safety gate of everything that deletes a user file: it alone decides
 * which item is `ready`, and it fails closed (an item whose facts are missing or doubtful is `manual`, never `ready`).
 * A new rule goes here with a unit test in lib/__tests__/legacy-cleanup-logic.test.js.
 */
const crypto = require('crypto');
const { SENTINEL_OPEN, SENTINEL_CLOSE, isOldRegistration, liesInside, oldInstallPaths } = require('./legacy-install');
const { isPlaceholder } = require('./settings');

const ENV_TO_KEY = Object.freeze({ PINECONE_API_KEY: 'pinecone-api-key', OPENAI_API_KEY: 'openai-api-key', PINECONE_INDEX_NAME: 'pinecone-index-name' });

/** The text between the markers of the block that the old Claude installer wrote, without carriage returns, trimmed. */
const INSTALLER_BLOCK_BODY =
	'# Make Custom App Skill\n\nWhen the conversation involves a Make.com custom app, IMLJSON, the Make Apps SDK, `make-app-contexts`, or an IEN Jira ticket about an app: invoke the `make-custom-app` skill before any other action and follow it. Do not answer from memory. Do not delegate this work to a sub-agent.';

const OWN_LINE = /(?<![\w-])make-custom-app(?![\w-])`?\s+skill/i;
const ENV_LINE = /^(\s*)(PINECONE_API_KEY|OPENAI_API_KEY|PINECONE_INDEX_NAME)(\s*=\s*)([\s\S]*)$/;
const ANY_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=([\s\S]*)$/;
const COMMENT_WITHOUT_EQUALS = /^\s*#[^=]*$/;
const CR_OR_LF = /[\r\n]/;
const BOM = '\uFEFF';
const DEFAULT_INDENT = '  ';
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Defines an own enumerable member, also for the name __proto__, which a plain assignment would take as the prototype. */
function setOwn(target, key, value) {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
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
 * message is ever used: a SyntaxError gives the path, an Error with a file system style code (upper-case letters,
 * digits, and underscores, 2 to 64 characters) gives the code and the path, and anything else gives a fixed sentence.
 * It never throws: an object with a throwing getter or trap gets the fixed sentence too.
 */
function describeError(err, filePath) {
	try {
		if (err instanceof SyntaxError) return `${filePath} is not valid JSON`;
		const code = err instanceof Error ? err.code : undefined;
		if (typeof code === 'string' && ERROR_CODE.test(code)) return `${code} on ${filePath}`;
	} catch {
		// a throwing getter or trap: fall through to the fixed text
	}
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
 * the close marker; `offset` is its start in UTF-16 code units (the unit of slice, not bytes); `lineStart` and `lineEnd`
 * are the 1-based lines of the markers; `edited` is true when the text between the markers is not the installer's.
 * The offset fields are null for the other statuses. A byte order mark on the open line belongs to the block.
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
 * assignment of another name, because it cannot be templated. `unknownLines` counts the lines that are not an
 * assignment, not empty, and not a comment without `=`: such a line (a commented-out key, a `NAME: value` line) may
 * hold a value.
 * Line endings are CRLF when the text has one, so a text with mixed endings (`mixedEol`) does not render back to the same
 * bytes; rendersExactly tells a caller whether a render gives back the text it was read from.
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
	const names = new Set();
	const unknownAssignments = new Set();
	const untemplatedSecretLines = new Set();
	let unknownLines = 0;
	for (const line of lines) {
		const secretLine = ENV_LINE.exec(line);
		if (secretLine) {
			const [, lead, name, separator, raw] = secretLine;
			names.add(name);
			const key = ENV_TO_KEY[name];
			if (usableValue(raw)) {
				values[name] = raw.trim();
				if (raw === secretValue(key)) {
					template.push({ prefix: lead + name + separator, $secret: key });
					continue;
				}
				untemplatedSecretLines.add(name);
			} else if (CR_OR_LF.test(raw)) {
				untemplatedSecretLines.add(name);
			}
		} else {
			const other = ANY_ASSIGNMENT.exec(line);
			if (other) {
				names.add(other[1]);
				if (other[2].trim() !== '') unknownAssignments.add(other[1]);
			} else if (line.trim() !== '' && !COMMENT_WITHOUT_EQUALS.test(line)) {
				unknownLines++;
			}
		}
		template.push(line);
	}
	const mixedEol = body.includes('\r\n') && /(?<!\r)\n/.test(body);
	return {
		template,
		values,
		names: [...names],
		unknownAssignments: [...unknownAssignments],
		eol,
		trailingNewline,
		bom,
		untemplatedSecretLines: [...untemplatedSecretLines],
		unknownLines,
		mixedEol,
	};
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
 * True only when renderEnvTemplate(parsed, secretValue) gives back `original`, the text that `parsed` was read from.
 * False for a text with mixed line endings, for a value that changed, and when the render cannot be made. A caller that
 * deletes a `.env` and later writes it back must check this first.
 */
function rendersExactly(parsed, secretValue, original) {
	if (!parsed || parsed.mixedEol) return false;
	try {
		return renderEnvTemplate(parsed, secretValue) === original;
	} catch {
		return false;
	}
}

/** A deep copy of JSON data. Anything that is not JSON data (a circular value, a BigInt, a throwing toJSON) gives a TypeError with a fixed text, never the message of the failure. */
function copyJson(value, name) {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		throw new TypeError(`${name} needs an entry that is JSON data`);
	}
}

/**
 * A deep copy of a registration whose `env` values that equal the secrets-file value become `{ "$secret": <plugin key> }`
 * (Ruling 9). Every other value stays and its name goes to `literalKeys`.
 */
function redactEntry(entry, secretsByKey) {
	const copy = copyJson(entry, 'redactEntry');
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
	const copy = copyJson(entry, 'nameOnlyEntry');
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

/**
 * `text` with every occurrence of every non-empty secret (and of its trimmed form) replaced by `<redacted>`. It looks for
 * the secrets in `text` as it is, then merges the spans that overlap, so a secret that overlaps another one or occurs in
 * the marker text is covered and the marker is never searched. Adjacent spans stay separate. Refuses anything but an array
 * or a Set of secrets, so a secret is never printed by mistake.
 */
function redactOutput(text, secrets) {
	if (!Array.isArray(secrets) && !(secrets instanceof Set)) throw new TypeError('redactOutput needs a list of secrets');
	const out = String(text ?? '');
	const candidates = new Set();
	for (const secret of secrets) {
		if (typeof secret !== 'string' || secret.trim() === '') continue;
		candidates.add(secret);
		candidates.add(secret.trim());
	}
	const spans = [];
	for (const secret of candidates) {
		for (let at = out.indexOf(secret); at !== -1; at = out.indexOf(secret, at + 1)) spans.push([at, at + secret.length]);
	}
	spans.sort((a, b) => a[0] - b[0]);
	let result = '';
	let copied = 0;
	let current = null;
	const flush = () => {
		result += `${out.slice(copied, current[0])}<redacted>`;
		copied = current[1];
	};
	for (const span of spans) {
		if (current && span[0] < current[1]) {
			current[1] = Math.max(current[1], span[1]);
		} else {
			if (current) flush();
			current = [span[0], span[1]];
		}
	}
	if (current) flush();
	return result + out.slice(copied);
}

const SCHEMA = 1;
const DECLINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DIGEST_PATTERN = /^[0-9a-f]{16}$/;
const PLUGIN_KEYS = Object.freeze(Object.values(ENV_TO_KEY));
const SECRETS_FILE_LABEL = 'secrets-file';
const CLAUDE_KEY = 'make-custom-app';
const RULES_ID = 'cursor.rules-dir';
const RULES_FILE = 'make-custom-app.mdc';
const DS_STORE = '.DS_Store';
const GROUPS = Object.freeze([
	{ id: 'claude', heading: 'Claude Code items:', confirm: 'after-plan' },
	{ id: 'cursor', heading: 'Cursor items (ask separately):', confirm: 'after-cursor-check' },
]);
const BACKUP_NAME_LIMIT = 1000;

const USAGE = 'Usage: cleanup-legacy.js --plan | --apply <digest> --groups claude[,cursor] | --restore [<backup>] | --decline <digest>';
const DIGEST_ERROR = 'The digest must be 16 lowercase hexadecimal characters, as printed by --plan.';
const GROUPS_ERROR = '--apply needs --groups claude, cursor, or claude,cursor.';

/**
 * The arguments of cleanup-legacy.js. `mode` is `plan`, `apply`, `restore`, `decline`, or null when `error` is set (then
 * every other field is empty). `--apply` and `--decline` take a digest (`--name value` or `--name=value`), `--groups`
 * takes a comma list of `claude` and `cursor` and only goes with `--apply`, `--restore` takes an optional backup that
 * does not start with `--`. An option given twice, a second mode, and anything else give the usage text.
 */
function parseArgs(argv) {
	if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) throw new TypeError('parseArgs needs a list of strings');
	const fail = (error) => ({ mode: null, digest: null, groups: [], backup: null, error });
	let mode = null;
	let modeValue = null;
	let groupsText = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
		const name = equals === -1 ? arg : arg.slice(0, equals);
		const inline = equals === -1 ? null : arg.slice(equals + 1);
		const hasNext = i + 1 < argv.length && !argv[i + 1].startsWith('--');
		if (name === '--plan') {
			if (mode !== null || inline !== null) return fail(USAGE);
			mode = 'plan';
		} else if (name === '--apply' || name === '--restore' || name === '--decline') {
			if (mode !== null) return fail(USAGE);
			mode = name.slice(2);
			if (inline !== null) modeValue = inline;
			else if (hasNext) modeValue = argv[++i];
		} else if (name === '--groups') {
			if (groupsText !== null) return fail(USAGE);
			if (inline !== null) groupsText = inline;
			else groupsText = hasNext ? argv[++i] : '';
		} else {
			return fail(USAGE);
		}
	}
	if (mode === null || (groupsText !== null && mode !== 'apply')) return fail(USAGE);
	if (mode === 'plan') return { mode, digest: null, groups: [], backup: null, error: null };
	if (mode === 'restore') return modeValue === '' ? fail(USAGE) : { mode, digest: null, groups: [], backup: modeValue, error: null };
	if (modeValue === null || !DIGEST_PATTERN.test(modeValue)) return fail(DIGEST_ERROR);
	if (mode === 'decline') return { mode, digest: modeValue, groups: [], backup: null, error: null };
	if (!groupsText) return fail(GROUPS_ERROR);
	const groups = [];
	for (const group of groupsText.split(',')) {
		if (group !== 'claude' && group !== 'cursor') return fail(`Unknown group "${group}"; use claude, cursor, or claude,cursor.`);
		if (!groups.includes(group)) groups.push(group);
	}
	return { mode, digest: modeValue, groups, backup: null, error: null };
}

/**
 * The trimmed value of the last `key: value` line of the secrets-file text, as lastMatch of ./settings reads it (a line
 * with a placeholder value is skipped), or null when there is none or the value is not usable (for example `${env:X}`).
 */
function secretsValue(text, key) {
	if (typeof text !== 'string' || typeof key !== 'string' || key === '') return null;
	const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+)$`);
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const match = pattern.exec(lines[i].trim());
		if (match && !isPlaceholder(match[1].trim())) {
			const value = match[1].trim();
			return usableValue(value) ? value : null;
		}
	}
	return null;
}

const PLUGIN_MARKERS = Object.freeze(['.claude-plugin', '.cursor-plugin']);
const FOREIGN_REASON = 'The facts name a path that is not an old install location, so the cleanup does not touch it.';
const FOREIGN_FIX = 'Run the plan again; if this stays, remove the old install by hand.';

function isDirFacts(dir) {
	return isPlainObject(dir) && typeof dir.path === 'string';
}

/** The old install locations under the home of the facts. A plan never names any other path. */
function pathsOf(facts, name) {
	if (!isPlainObject(facts) || typeof facts.home !== 'string' || facts.home === '') throw new TypeError(`${name} needs facts with home`);
	return oldInstallPaths(facts.home);
}

/**
 * True when a folder is a plugin installed as a skills or rules folder (it lists `.claude-plugin` or `.cursor-plugin`)
 * or holds the running plugin (`facts.pluginRoot` lies inside it). Removing it would remove the plugin.
 */
function isLookalike(facts, folder, names) {
	if (Array.isArray(names) && PLUGIN_MARKERS.some((marker) => names.includes(marker))) return true;
	return typeof facts.pluginRoot === 'string' && facts.pluginRoot !== '' && liesInside(facts.pluginRoot, folder);
}

/** `none` (no facts), `lookalike` (a plugin, never planned), `foreign` (not at the old install location), or `ok`. */
function dirState(facts, dir, expectedPath, names) {
	if (!isDirFacts(dir)) return 'none';
	if (isLookalike(facts, dir.path, names)) return 'lookalike';
	return dir.path === expectedPath ? 'ok' : 'foreign';
}

/** The folders that no registration part may point into: the running plugin and every folder that is a plugin. */
function ownFoldersOf(facts) {
	const folders = [];
	if (typeof facts.pluginRoot === 'string' && facts.pluginRoot !== '') folders.push(facts.pluginRoot);
	for (const dir of [facts.claudeSkill, facts.cursorSkill]) if (isDirFacts(dir) && isLookalike(facts, dir.path, dir.topNames)) folders.push(dir.path);
	if (isDirFacts(facts.cursorRules) && isLookalike(facts, facts.cursorRules.path, facts.cursorRules.names)) folders.push(facts.cursorRules.path);
	return folders;
}

/**
 * The entry of a facts holder with the plugin's own parts dropped (gatherFacts supplies it as `withoutOwn`), and again
 * without every part inside the running plugin or a folder that is a plugin (checked here from the facts, so a plan does
 * not depend on gatherFacts for that), or null when `withoutOwn` is missing.
 */
function judgedEntry(holder, facts) {
	if (!isPlainObject(holder) || !isPlainObject(holder.withoutOwn)) return null;
	const folders = ownFoldersOf(facts);
	if (folders.length === 0) return holder.withoutOwn;
	const outside = (part) => typeof part === 'string' && !folders.some((folder) => liesInside(part, folder));
	const { command, args } = holder.withoutOwn;
	return { command: outside(command) ? command : undefined, args: Array.isArray(args) ? args.filter(outside) : args };
}

/** True when the Claude `make-custom-app` registration counts as the old skill's (Ruling 28). Without the judged entry it does not. */
function isOldClaudeEntry(facts) {
	const judged = judgedEntry(facts.claudeEntry, facts);
	return judged !== null && isOldRegistration(judged, secretsValue(facts.secretsText, 'mcp-server-path'));
}

/** The members of ~/.cursor/mcp.json that point into an old skill folder (the plugin's own parts dropped), by key. */
function oldCursorMembers(facts) {
	const holder = facts.cursorMembers;
	if (!isPlainObject(holder) || !Array.isArray(holder.members)) return [];
	return holder.members
		.filter((member) => {
			const judged = isPlainObject(member) && typeof member.key === 'string' ? judgedEntry(member, facts) : null;
			return judged !== null && isOldRegistration(judged);
		})
		.sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** The usable values of the three names of ENV_TO_KEY in an `env` object or a parsed `.env`, trimmed. */
function usableEnvValues(env) {
	const found = {};
	if (!isPlainObject(env)) return found;
	for (const name of Object.keys(ENV_TO_KEY)) {
		if (Object.hasOwn(env, name) && usableValue(env[name])) found[name] = env[name].trim();
	}
	return found;
}

function envOf(entry) {
	return isPlainObject(entry) ? entry.env : undefined;
}

/** The text of an old `.env` that may be a secret source: its skill folder is planned and both paths are the old install locations. */
function sourceEnvText(facts, skill, skillPath, env, envPath) {
	if (dirState(facts, skill, skillPath, isDirFacts(skill) ? skill.topNames : undefined) !== 'ok') return null;
	return isPlainObject(env) && env.path === envPath && typeof env.text === 'string' ? env.text : null;
}

/**
 * Where an old install keeps its keys, in the order of Ruling 7: `claude-registration` (only when the entry counts as an
 * old registration), `claude-env`, `cursor-registration:<key>` (old members only, by key), `cursor-env`. `values` is
 * keyed by the three names of ENV_TO_KEY and holds only usable values, trimmed. A source exists when its file does, even
 * with no usable value. A registration or `.env` counts only at its old install location; an `.env` counts only when
 * the skill folder it belongs to is a planned folder (not null, not a plugin, even when it is a symbolic link; the `.env`
 * need not lie inside it). The values stay in memory: no other function copies them into a plan.
 */
function secretSources(facts) {
	const paths = pathsOf(facts, 'secretSources');
	const sources = [];
	const claudeEntry = facts.claudeEntry;
	if (isPlainObject(claudeEntry) && claudeEntry.file === paths.claudeJson && isOldClaudeEntry(facts)) sources.push({ label: 'claude-registration', values: usableEnvValues(envOf(claudeEntry.entry)) });
	const claudeEnv = sourceEnvText(facts, facts.claudeSkill, paths.claudeSkill, facts.claudeEnv, paths.claudeEnv);
	if (claudeEnv !== null) sources.push({ label: 'claude-env', values: usableEnvValues(parseEnvTemplate(claudeEnv, () => null).values) });
	if (isPlainObject(facts.cursorMembers) && facts.cursorMembers.file === paths.cursorMcp) {
		for (const member of oldCursorMembers(facts)) sources.push({ label: `cursor-registration:${member.key}`, values: usableEnvValues(envOf(member.entry)) });
	}
	const cursorEnv = sourceEnvText(facts, facts.cursorSkill, paths.cursorSkill, facts.cursorEnv, paths.cursorEnv);
	if (cursorEnv !== null) sources.push({ label: 'cursor-env', values: usableEnvValues(parseEnvTemplate(cursorEnv, () => null).values) });
	return sources;
}

/**
 * What the keys of the sources do to the secrets file (Ruling 7), per key of the plugin. An existing usable value always
 * wins; otherwise the first usable source value is the update. `status`: `same` (the file has it and no source differs),
 * `added` (an update, no source differs), `conflict` (a usable source value differs from the one used; `conflicts` names
 * the key, who was used (`secrets-file` or a label), and the labels that differ, never a value), `placeholder` (nothing
 * usable, but a source holds a placeholder or a `${...}` reference), `absent`. `finalValue(key)` is what the secrets file
 * holds after the update, or null.
 */
function compareSecrets(sources, secretsText) {
	const list = Array.isArray(sources) ? sources : [];
	const updates = {};
	const status = {};
	const conflicts = [];
	const finals = {};
	for (const [envName, key] of Object.entries(ENV_TO_KEY)) {
		const existing = secretsValue(secretsText, key);
		const candidates = [];
		let placeholderSeen = false;
		for (const source of list) {
			if (!isPlainObject(source) || !isPlainObject(source.values) || !Object.hasOwn(source.values, envName)) continue;
			const raw = source.values[envName];
			if (typeof raw !== 'string') continue;
			if (usableValue(raw)) candidates.push({ label: String(source.label), value: raw.trim() });
			else if (raw.trim() !== '') placeholderSeen = true;
		}
		let used = null;
		if (existing !== null) {
			used = { label: SECRETS_FILE_LABEL, value: existing };
		} else if (candidates.length > 0) {
			used = candidates[0];
			updates[key] = used.value;
		}
		const others = used === null ? [] : candidates.filter((candidate) => candidate.value !== used.value).map((candidate) => candidate.label);
		if (others.length > 0) {
			status[key] = 'conflict';
			conflicts.push({ key, used: used.label, others });
		} else if (existing !== null) {
			status[key] = 'same';
		} else if (used !== null) {
			status[key] = 'added';
		} else {
			status[key] = placeholderSeen ? 'placeholder' : 'absent';
		}
		finals[key] = used === null ? null : used.value;
	}
	return { updates, status, conflicts, finalValue: (key) => (Object.hasOwn(finals, key) ? finals[key] : null) };
}

/** An argument or command without the value of an `--option=value`, `NAME=value`, or `?key=value` (the text up to and including the first `=`), because such a value can be a secret. */
function withoutOptionValue(text) {
	const equals = text.indexOf('=');
	return equals === -1 ? text : text.slice(0, equals + 1);
}

/**
 * The identity of a registration: its type, command, arguments (option values cut), and the names of its env, as
 * nameOnlyEntry gives them. Every other member (a url, headers, anything a user added) is left out, because it can hold a
 * secret and does not decide what the cleanup removes. An entry that is not an object has no identity (null).
 */
function entryIdentity(entry) {
	const named = nameOnlyEntry(entry);
	if (!isPlainObject(named)) return null;
	const identity = {};
	if (typeof named.type === 'string') identity.type = named.type;
	if (typeof named.command === 'string') identity.command = withoutOptionValue(named.command);
	if (Array.isArray(named.args)) identity.args = named.args.map((arg) => (typeof arg === 'string' ? withoutOptionValue(arg) : null));
	if (isPlainObject(named.env)) identity.env = named.env;
	return identity;
}

function sortedNames(names, dropDsStore) {
	const list = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && !(dropDsStore && name === DS_STORE)) : [];
	return list.sort();
}

/**
 * The identity of one item, so a plan that changed can be told from the one the user saw. It holds names, hashes, and
 * links, never a value, a size, a status, a count of files, or the path of the claude binary. `item.kind` selects the
 * form: a skill folder gives `{ symlink, linkTarget, skillName, version, topNames }` (`.DS_Store` out, names sorted), the
 * rules folder (id cursor.rules-dir) its sorted names (`{ symlink, linkTarget, names }` when it is a link), an env-file `{ names, others, lineCount }` (the three known names,
 * and a hash of the other assignment names), a registration or member the sha256 of the canonical JSON of its identity
 * (entryIdentity: option values, urls, and headers are left out; the hash is all that is printed, because an argument
 * can be a secret), a block `sha256(removedText):lineStart`. The input carries these identity fields next to the
 * public ones; buildPlan fills them from the facts.
 */
function fingerprint(item) {
	if (!isPlainObject(item)) throw new TypeError('fingerprint needs an item');
	switch (item.kind) {
		case 'directory':
			if (item.id === RULES_ID) return item.symlink === true ? { symlink: true, linkTarget: item.linkTarget ?? null, names: sortedNames(item.names, true) } : sortedNames(item.names, true);
			return {
				symlink: item.symlink === true,
				linkTarget: item.linkTarget ?? null,
				skillName: item.skillName ?? null,
				version: item.version ?? null,
				topNames: sortedNames(item.topNames, true),
			};
		case 'env-file': {
			const names = sortedNames(item.names, false);
			const others = names.filter((name) => !Object.hasOwn(ENV_TO_KEY, name));
			return {
				names: names.filter((name) => Object.hasOwn(ENV_TO_KEY, name)),
				others: others.length === 0 ? null : sha256(canonicalJson(others)),
				lineCount: Number.isInteger(item.lineCount) ? item.lineCount : 0,
			};
		}
		case 'claude-mcp-entry':
		case 'json-member': {
			const identity = entryIdentity(item.entry);
			return identity === null ? null : sha256(canonicalJson(identity));
		}
		case 'text-block':
			return typeof item.removedText === 'string' ? `${sha256(item.removedText)}:${item.lineStart}` : String(item.blockStatus ?? 'none');
		default:
			throw new TypeError('fingerprint needs an item of a known kind');
	}
}

/**
 * The 16 hexadecimal characters that identify a plan: the first 16 of sha256 over the canonical JSON of every item in plan
 * order. An item counts with its id, kind, path, action, status, and `reformats` besides its fingerprint, so a plan that would touch
 * another file, do something else with it, or move an item from `manual` to `ready` has another digest. `blocked` counts
 * as `ready`: it only means that no `claude` binary was looked for or found, and a plan made without that search (as
 * check-setup makes it) must give the digest of the plan the user confirmed. `--apply <digest>` refuses when the digest it
 * computes now is not the one the user confirmed. No value, size, count, or key status goes in.
 */
function planDigest(items) {
	if (!Array.isArray(items)) throw new TypeError('planDigest needs a list of items');
	const rows = items.map((item) => [item.id, item.kind ?? null, item.path ?? null, item.action ?? null, item.status === 'blocked' ? 'ready' : (item.status ?? null), item.reformats ?? null, item.fingerprint ?? null]);
	return sha256(canonicalJson({ schema: SCHEMA, items: rows })).slice(0, 16);
}

function joinPath(base, name) {
	const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	return base.endsWith(separator) ? base + name : base + separator + name;
}

/** A function that writes every occurrence of the home folder (as a whole path segment) as `~`. */
function makeShortener(home) {
	const trimmed = home.length > 1 ? home.replace(/[\\/]+$/, '') : home;
	if (trimmed === '' || trimmed === '/' || trimmed === '\\') return (text) => String(text);
	const pattern = new RegExp(`${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\\\/]|$)`, 'g');
	return (text) => String(text).replace(pattern, '~');
}

const CLAUDE_JSON = '~/.claude.json';
const CLAUDE_MD = '~/.claude/CLAUDE.md';
const CURSOR_JSON = '~/.cursor/mcp.json';
const BLOCK_FIX = `Remove the lines from ${SENTINEL_OPEN} to ${SENTINEL_CLOSE} by hand.`;
const BLOCK_WORDS = Object.freeze({ unclosed: 'unclosed', reversed: 'in the wrong order', multiple: 'repeated' });
const BACKUP_COPY_TEXT = 'Claude Code keeps its own copy of ~/.claude.json at ~/.claude/backups/ that still holds the removed registration; this cleanup does not touch it.';

function hasClaudeBinary(facts) {
	return isPlainObject(facts.claude) && typeof facts.claude.binary === 'string' && facts.claude.binary !== '';
}

const SAFE_OLD_PATH = /^(?:\/|[A-Za-z]:[\\/])[^=@]*$/;
const SAFE_FALLBACK_PATH = /^(?:\/|[A-Za-z]:[\\/])[^\s=@]*$/;

/**
 * The part of a registration that the plan shows as its server, and only an absolute path: the first part that points
 * into an old skill folder or under `mcp-server-path` (it may hold spaces but no `=` or `@`), else the first argument
 * that is an absolute path without whitespace, `=`, or `@`, else the command under the same rule, else null. Any other
 * argument or command string is never shown, because it can carry a secret (`--api-key <value>`, a header, a URL with
 * credentials, a bare token).
 */
function serverPathOf(entry, judged, mcpServerPath) {
	const partsOf = (value) => (isPlainObject(value) ? [...(Array.isArray(value.args) ? value.args : []), value.command].filter((part) => typeof part === 'string') : []);
	const found = partsOf(judged).find((part) => SAFE_OLD_PATH.test(part) && isOldRegistration({ command: part }, mcpServerPath));
	if (found !== undefined) return found;
	if (!isPlainObject(entry)) return null;
	const argument = Array.isArray(entry.args) ? entry.args.find((part) => typeof part === 'string' && SAFE_FALLBACK_PATH.test(part)) : undefined;
	if (argument !== undefined) return argument;
	return typeof entry.command === 'string' && SAFE_FALLBACK_PATH.test(entry.command) ? entry.command : null;
}

function envKeysOf(entry) {
	return isPlainObject(entry) && isPlainObject(entry.env) ? Object.keys(entry.env) : [];
}

/** What replaces an item whose facts name a path that is not an old install location: a manual item at the expected path. */
function foreignItem(id, kind, action, expectedPath) {
	return { id, group: id.split('.')[0], kind, path: expectedPath, action, status: 'manual', reason: FOREIGN_REASON, fix: FOREIGN_FIX, fingerprint: null };
}

function claudeEntryItem(facts, paths) {
	const holder = facts.claudeEntry;
	if (!isPlainObject(holder) || typeof holder.file !== 'string') return null;
	if (holder.file !== paths.claudeJson) return foreignItem('claude.mcp-entry', 'claude-mcp-entry', 'remove-entry', paths.claudeJson);
	const entry = holder.entry;
	const mcpServerPath = secretsValue(facts.secretsText, 'mcp-server-path');
	const judged = judgedEntry(holder, facts);
	const serverPath = serverPathOf(entry, judged, mcpServerPath);
	let status = 'ready';
	let reason = null;
	let fix = null;
	if (judged === null || !isOldRegistration(judged, mcpServerPath)) {
		status = 'manual';
		reason = `This make-custom-app entry in ${CLAUDE_JSON} does not point into an old skill folder (server ${serverPath ?? 'unknown'}).`;
		fix = `If it belongs to the old skill, remove the "${CLAUDE_KEY}" entry from ${CLAUDE_JSON} by hand; the cleanup leaves it.`;
	} else if (facts.configDirIsDefault !== true) {
		status = 'manual';
		reason = `CLAUDE_CONFIG_DIR points at another folder, so the cleanup does not touch ${CLAUDE_JSON}.`;
		fix = `Remove the "${CLAUDE_KEY}" entry from ${CLAUDE_JSON} by hand (claude mcp remove would change $CLAUDE_CONFIG_DIR/.claude.json instead).`;
	} else if (!hasClaudeBinary(facts)) {
		status = 'blocked';
		reason = 'Claude Code was not found, so the old MCP registration cannot be removed.';
		fix = 'Set CLAUDE_BIN to the claude binary and run the plan again.';
	}
	return {
		id: 'claude.mcp-entry',
		group: 'claude',
		kind: 'claude-mcp-entry',
		path: holder.file,
		action: 'remove-entry',
		status,
		reason,
		fix,
		fingerprint: fingerprint({ kind: 'claude-mcp-entry', entry }),
		key: CLAUDE_KEY,
		serverPath,
		envKeys: envKeysOf(entry),
	};
}

function sentinelItem(facts, paths) {
	const holder = facts.claudeMd;
	if (!isPlainObject(holder) || typeof holder.file !== 'string') return null;
	if (holder.tooLarge === true) {
		if (holder.file !== paths.claudeMd) return foreignItem('claude.sentinel', 'text-block', 'remove-block', paths.claudeMd);
		return {
			id: 'claude.sentinel',
			group: 'claude',
			kind: 'text-block',
			path: holder.file,
			action: 'remove-block',
			status: 'manual',
			reason: `${CLAUDE_MD} is too large to read, so the cleanup does not look for its old skill block.`,
			fix: `If it holds the old skill block, remove the lines from ${SENTINEL_OPEN} to ${SENTINEL_CLOSE} by hand.`,
			fingerprint: fingerprint({ kind: 'text-block', blockStatus: 'too-large' }),
			lines: [],
			edited: false,
		};
	}
	if (typeof holder.text !== 'string') return null;
	const block = findSentinelBlock(holder.text);
	if (block.status === 'none') return null;
	if (holder.file !== paths.claudeMd) return foreignItem('claude.sentinel', 'text-block', 'remove-block', paths.claudeMd);
	let status = 'ready';
	let reason = null;
	let fix = null;
	if (holder.utf8Exact !== true) {
		status = 'manual';
		reason = `${CLAUDE_MD} is not valid UTF-8, so the cleanup does not rewrite it.`;
		fix = BLOCK_FIX;
	} else if (block.status !== 'ok') {
		status = 'manual';
		reason = `The old skill block in ${CLAUDE_MD} is ${BLOCK_WORDS[block.status]}.`;
		fix = BLOCK_FIX;
	}
	return {
		id: 'claude.sentinel',
		group: 'claude',
		kind: 'text-block',
		path: holder.file,
		action: 'remove-block',
		status,
		reason,
		fix,
		fingerprint: fingerprint({ kind: 'text-block', removedText: block.removedText, lineStart: block.lineStart, blockStatus: block.status }),
		lines: block.status === 'ok' ? [block.lineStart, block.lineEnd] : [],
		edited: block.edited,
	};
}

/**
 * The `.env` inside an old skill folder. `delete` only when the file is a template of the secrets file (Ruling 36): no
 * other assignment with a value, every usable key line equals the final secrets value, every other line is empty or a
 * comment without `=` (the template goes into the manifest, so it must hold no value), the bytes are UTF-8 exact, and a
 * render gives back the same text. Otherwise it stays in the folder, which moves into the backup. No item when the skill
 * folder is not planned, is a symbolic link (only the link moves, Ruling 38), or the `.env` does not lie inside it
 * (`insideSkill` is not true: `mcp-server` may link to a folder elsewhere, and the cleanup would unlink or change a file
 * outside the old install). A `.env` that is itself a link (`linked` true) is never deleted: unlinking the link would leave
 * the file it names, with the secrets, in the backup. `keys` lists the known names; the other assignment names are only counted.
 */
function envFileItem(group, facts, skill, skillPath, env, envPath, compared) {
	if (dirState(facts, skill, skillPath, isDirFacts(skill) ? skill.topNames : undefined) !== 'ok' || skill.symlink === true) return null;
	if (!isPlainObject(env) || typeof env.path !== 'string' || typeof env.text !== 'string' || env.insideSkill !== true) return null;
	if (env.path !== envPath) return foreignItem(`${group}.env-file`, 'env-file', 'keep-in-backup', envPath);
	const parsed = parseEnvTemplate(env.text, compared.finalValue);
	const deletable = env.tooLarge !== true && env.linked !== true && parsed.unknownAssignments.length === 0 && parsed.untemplatedSecretLines.length === 0 && parsed.unknownLines === 0 && env.utf8Exact === true && rendersExactly(parsed, compared.finalValue, env.text);
	const keys = parsed.names.filter((name) => Object.hasOwn(ENV_TO_KEY, name));
	return {
		id: `${group}.env-file`,
		group,
		kind: 'env-file',
		path: env.path,
		action: deletable ? 'delete' : 'keep-in-backup',
		status: 'ready',
		reason: null,
		fix: null,
		fingerprint: fingerprint({ kind: 'env-file', names: parsed.names, lineCount: parsed.template.length }),
		keys,
		other: parsed.names.length - keys.length,
		secrets: { ...compared.status },
	};
}

function skillDirItem(group, facts, dir, expectedPath) {
	const state = dirState(facts, dir, expectedPath, isDirFacts(dir) ? dir.topNames : undefined);
	if (state === 'foreign') return foreignItem(`${group}.skill-dir`, 'directory', 'move', expectedPath);
	if (state !== 'ok') return null;
	return {
		id: `${group}.skill-dir`,
		group,
		kind: 'directory',
		path: dir.path,
		action: 'move',
		status: 'ready',
		reason: null,
		fix: null,
		fingerprint: fingerprint({ kind: 'directory', id: `${group}.skill-dir`, symlink: dir.symlink, linkTarget: dir.linkTarget, skillName: dir.skillName, version: dir.version, topNames: dir.topNames }),
		symlink: dir.symlink === true,
		version: typeof dir.version === 'string' ? dir.version : null,
		fileCount: Number.isInteger(dir.fileCount) ? dir.fileCount : 0,
		sizeBytes: Number.isInteger(dir.sizeBytes) ? dir.sizeBytes : 0,
		extraFiles: [],
	};
}

function rulesDirItem(facts, rules, expectedPath) {
	const state = dirState(facts, rules, expectedPath, isDirFacts(rules) ? rules.names : undefined);
	if (state === 'foreign') return foreignItem(RULES_ID, 'directory', 'move', expectedPath);
	if (state !== 'ok') return null;
	return {
		id: RULES_ID,
		group: 'cursor',
		kind: 'directory',
		path: rules.path,
		action: 'move',
		status: 'ready',
		reason: null,
		fix: null,
		fingerprint: fingerprint({ kind: 'directory', id: RULES_ID, names: rules.names, symlink: rules.symlink === true, linkTarget: rules.linkTarget }),
		symlink: rules.symlink === true,
		version: null,
		fileCount: Number.isInteger(rules.fileCount) ? rules.fileCount : 0,
		sizeBytes: Number.isInteger(rules.sizeBytes) ? rules.sizeBytes : 0,
		extraFiles: sortedNames(rules.names, true).filter((name) => name !== RULES_FILE),
	};
}

/** Whether taking `key` out of the JSON text leaves every other byte alone: true or false, or null when the text cannot be used. */
function leavesLayoutAlone(text, key) {
	try {
		const removal = removeJsonMember(text, key);
		return removal === null ? null : removal.canonical;
	} catch {
		return null;
	}
}

function cursorMemberItems(facts, paths) {
	const holder = facts.cursorMembers;
	if (!isPlainObject(holder) || typeof holder.file !== 'string') return [];
	if (holder.file !== paths.cursorMcp) return oldCursorMembers(facts).map((member) => foreignItem(`cursor.mcp-entry.${member.key}`, 'json-member', 'remove-entry', paths.cursorMcp));
	return oldCursorMembers(facts).map((member) => {
		const byHand = `Remove the "${member.key}" entry from ${CURSOR_JSON} by hand.`;
		let status = 'ready';
		let reason = null;
		let fix = null;
		let reformats = false;
		if (holder.utf8Exact !== true) {
			status = 'manual';
			reason = `${CURSOR_JSON} is not valid UTF-8, so the cleanup does not rewrite it.`;
			fix = byHand;
		} else {
			const canonicalFile = holder.format === 'json' ? leavesLayoutAlone(holder.text, member.key) : null;
			if (canonicalFile === null) {
				status = 'manual';
				reason = `${CURSOR_JSON} has comments, trailing commas or a byte order mark, which the cleanup does not rewrite.`;
				fix = byHand;
			} else {
				reformats = !canonicalFile;
			}
		}
		return {
			id: `cursor.mcp-entry.${member.key}`,
			group: 'cursor',
			kind: 'json-member',
			path: holder.file,
			action: 'remove-entry',
			status,
			reason,
			fix,
			fingerprint: fingerprint({ kind: 'json-member', entry: member.entry }),
			key: member.key,
			serverPath: serverPathOf(member.entry, judgedEntry(member, facts), undefined),
			envKeys: envKeysOf(member.entry),
			reformats,
		};
	});
}

function buildNotices(facts, items, short, home, paths) {
	const notices = [];
	const holder = facts.claudeMd;
	if (isPlainObject(holder) && typeof holder.text === 'string' && holder.file === paths.claudeMd) {
		for (const line of findOwnLines(holder.text, findSentinelBlock(holder.text))) {
			notices.push({
				kind: 'own-line',
				file: holder.file,
				lines: [line],
				text: `${CLAUDE_MD} line ${line} names the make-custom-app skill, which the plugin replaces. The cleanup does not edit your own text. Change it to use the matching make-app-* skill of the make-custom-app plugin, or delete it: the plugin's skills trigger without it.`,
			});
		}
	}
	for (const dir of Array.isArray(facts.contextsDirs) ? facts.contextsDirs : []) {
		if (dir !== paths.claudeContexts && dir !== paths.cursorContexts) continue;
		notices.push({ kind: 'contexts', file: dir, lines: [], text: `Old app contexts remain in ${short(dir)}; the plugin uses ~/.make-custom-app/contexts. The cleanup does not move or delete them.` });
	}
	for (const [skill, expectedPath] of [[facts.claudeSkill, paths.claudeSkill], [facts.cursorSkill, paths.cursorSkill]]) {
		if (dirState(facts, skill, expectedPath, isDirFacts(skill) ? skill.topNames : undefined) !== 'ok' || skill.symlink !== true) continue;
		const target = typeof skill.linkTarget === 'string' && skill.linkTarget !== '' ? skill.linkTarget : 'another folder';
		notices.push({
			kind: 'symlink-target',
			file: skill.path,
			lines: [],
			text: `${short(skill.path)} is a symbolic link to ${target}; only the link moves, and the files in ${target}, its mcp-server/.env included, stay where they are.`,
		});
	}
	const entry = items.find((item) => item.id === 'claude.mcp-entry');
	if (entry && entry.status === 'ready') notices.push({ kind: 'claude-backup-copy', file: joinPath(home, '.claude.json'), lines: [], text: BACKUP_COPY_TEXT });
	return notices;
}

/** True when the plugin is installed for the user, enabled, and this script runs from the install: the conditions of pluginGuard. */
function pluginIsUsable(plugin) {
	return isPlainObject(plugin) && plugin.recorded === true && plugin.userScope === true && plugin.enabled === true && plugin.runningFromInstall === true;
}

/**
 * The plan of the cleanup: what the facts about an old install allow it to remove, as the JSON that `--plan` prints
 * (schema, digest, home, editor, plugin, claude, groups, confirmRequired, secrets, items, notices, backupRoot, lines).
 * `secrets` holds the keys that would be copied into the secrets file and the conflicts, by name and label. It reads
 * nothing and holds no secret value (a registration is shown only by an absolute path and a hash). The facts carry each
 * registration twice: `entry` (for the names of its env) and `withoutOwn` (the same entry without the plugin's own
 * parts, from dropOwnParts of ./legacy-install), and only `withoutOwn` is judged; an entry without it is never old, so
 * it is never `ready`. A file whose bytes are not UTF-8 exact (`utf8Exact` not true) is never rewritten or deleted. A
 * CLAUDE.md that gatherFacts found too large to read (`tooLarge: true`) is a manual sentinel item and such an `.env` is
 * kept in the backup, so the plan never says "nothing there" about a file that exists. A skill, rules, or plugin
 * folder that is a plugin (a marker folder, or the running plugin inside it) is never planned,
 * an `.env` is planned only when `insideSkill` is true, and an item whose path is not the old install location under
 * `facts.home` becomes a manual item at that location. When the plugin is not usable (see pluginIsUsable) nothing is
 * `confirmRequired`; the plan and its digest stay the same, so a plan made by check-setup without a search for `claude`
 * has the digest of the plan the user confirmed, and `preflightApply` keeps the plugin guard as its own check.
 */
function buildPlan(facts) {
	if (!isPlainObject(facts) || typeof facts.home !== 'string' || facts.home === '') throw new TypeError('buildPlan needs facts with home');
	const home = facts.home;
	const paths = pathsOf(facts, 'buildPlan');
	const short = makeShortener(home);
	const compared = compareSecrets(secretSources(facts), typeof facts.secretsText === 'string' ? facts.secretsText : null);
	const items = [
		claudeEntryItem(facts, paths),
		sentinelItem(facts, paths),
		envFileItem('claude', facts, facts.claudeSkill, paths.claudeSkill, facts.claudeEnv, paths.claudeEnv, compared),
		skillDirItem('claude', facts, facts.claudeSkill, paths.claudeSkill),
		...cursorMemberItems(facts, paths),
		envFileItem('cursor', facts, facts.cursorSkill, paths.cursorSkill, facts.cursorEnv, paths.cursorEnv, compared),
		skillDirItem('cursor', facts, facts.cursorSkill, paths.cursorSkill),
		rulesDirItem(facts, facts.cursorRules, paths.cursorRules),
	].filter((item) => item !== null);
	const count = (group, status) => items.filter((item) => item.group === group && item.status === status).length;
	const plugin = isPlainObject(facts.plugin) ? facts.plugin : {};
	const plan = {
		schema: SCHEMA,
		digest: planDigest(items),
		home,
		editor: facts.editor === 'claude' || facts.editor === 'cursor' ? facts.editor : null,
		plugin: {
			recorded: plugin.recorded === true,
			userScope: plugin.userScope === true,
			enabled: plugin.enabled === true,
			runningFromInstall: plugin.runningFromInstall === true,
			version: typeof plugin.version === 'string' ? plugin.version : null,
		},
		claude: { binary: hasClaudeBinary(facts) ? facts.claude.binary : null },
		groups: GROUPS.filter((group) => items.some((item) => item.group === group.id)).map((group) => ({ id: group.id, confirm: group.confirm, ready: count(group.id, 'ready'), blocked: count(group.id, 'blocked'), manual: count(group.id, 'manual') })),
		confirmRequired: pluginIsUsable(plugin) && items.some((item) => item.status === 'ready'),
		secrets: { copy: PLUGIN_KEYS.filter((key) => Object.hasOwn(compared.updates, key)), conflicts: compared.conflicts },
		items,
		notices: buildNotices(facts, items, short, home, paths),
		backupRoot: joinPath(home, '.make-custom-app'),
		lines: [],
	};
	plan.lines = planLines(plan);
	return plan;
}

const UNUSABLE_PLUGIN_LINE = 'The plugin is not usable in this session, so nothing will be removed.';

/** One line about a key whose value differs between sources: the key, the source labels, and what happens; never a value. */
function conflictLine(conflict) {
	const others = conflict.others.join(', ');
	if (conflict.used === SECRETS_FILE_LABEL) return `  note    ${conflict.key}: the value in ${others} differs from your secrets file; the secrets file value stays, and the old value is kept in the backup`;
	return `  note    ${conflict.key}: ${conflict.used} and ${others} hold different values; the value in ${conflict.used} is copied and the others are kept in the backup`;
}

function readyLine(item, short) {
	const where = short(item.path);
	switch (item.kind) {
		case 'claude-mcp-entry':
		case 'json-member':
			return `  remove  "${item.key}" from ${where} (old MCP registration, server ${item.serverPath === null ? 'unknown' : short(item.serverPath)})`;
		case 'text-block':
			return `  remove  the old skill block from ${where} (lines ${item.lines[0]} to ${item.lines[1]}${item.edited ? ', edited by hand' : ''})`;
		case 'env-file':
			return item.action === 'delete' ? `  delete  ${where} (its keys are in your secrets file)` : `  keep    ${where} in the backup (it holds a value that is not in your secrets file)`;
		default:
			if (item.id === RULES_ID) return item.symlink ? `  move    ${where} (old Cursor rule folder, a symbolic link; only the link moves)` : `  move    ${where} (old Cursor rule folder, ${item.fileCount} files)`;
			if (item.symlink) return `  move    ${where} (old skill folder, a symbolic link; only the link moves)`;
			return `  move    ${where} (old skill folder, version ${item.version === null ? 'unknown' : item.version}, ${item.fileCount} files)`;
	}
}

/**
 * The text a plan shows the user, one string per line, with the home folder written as `~`: a heading per group that has
 * a ready item, then the ready items in apply order (the `copy` line first, under the first heading, when keys would be
 * copied), then the `Blocked` and `By hand` sections. A plan with no item at all is the single line `Nothing to remove.`
 */
function planLines(plan) {
	if (!isPlainObject(plan) || typeof plan.home !== 'string' || !Array.isArray(plan.items)) throw new TypeError('planLines needs a plan');
	if (plan.items.length === 0) return ['Nothing to remove.'];
	const short = makeShortener(plan.home);
	const copy = isPlainObject(plan.secrets) && Array.isArray(plan.secrets.copy) ? plan.secrets.copy : [];
	const conflicts = isPlainObject(plan.secrets) && Array.isArray(plan.secrets.conflicts) ? plan.secrets.conflicts.filter((conflict) => isPlainObject(conflict) && Array.isArray(conflict.others)) : [];
	const lines = [];
	if (isPlainObject(plan.plugin) && !pluginIsUsable(plan.plugin)) lines.push(UNUSABLE_PLUGIN_LINE);
	let extrasShown = copy.length === 0 && conflicts.length === 0;
	for (const group of GROUPS) {
		const ready = plan.items.filter((item) => item.group === group.id && item.status === 'ready');
		if (ready.length === 0) continue;
		lines.push(group.heading);
		if (!extrasShown) {
			if (copy.length > 0) lines.push(`  copy    ${copy.join(', ')} into ~/.make-custom-app-skill-secrets (values already there win)`);
			for (const conflict of conflicts) lines.push(conflictLine(conflict));
			extrasShown = true;
		}
		for (const item of ready) lines.push(readyLine(item, short));
	}
	for (const [status, heading] of [['blocked', 'Blocked (fix first; nothing is removed until then):'], ['manual', 'By hand (the cleanup does not do these):']]) {
		const rows = plan.items.filter((item) => item.status === status);
		if (rows.length === 0) continue;
		lines.push(heading);
		for (const item of rows) lines.push(`  ${item.id}: ${short(item.reason)} Fix: ${short(item.fix)}`);
	}
	return lines;
}

/** `migration-backup-<YYYY-MM-DDTHH-mm-ssZ>` in UTC for the moment `now` (a number of milliseconds or a Date), with `-2`, `-3`, ... while `exists(name)` is true. */
function backupFolderName(now, exists) {
	const moment = now instanceof Date ? now.getTime() : now;
	if (typeof moment !== 'number' || !Number.isFinite(moment) || typeof exists !== 'function') throw new TypeError('backupFolderName needs now and exists');
	const stamp = new Date(moment).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
	const base = `migration-backup-${stamp}`;
	for (let n = 1; n <= BACKUP_NAME_LIMIT; n++) {
		const name = n === 1 ? base : `${base}-${n}`;
		if (!exists(name)) return name;
	}
	throw new Error('backupFolderName found no free name');
}

/**
 * What the restore does with one manifest step, from what is on disk now (`reality`): `restore`, `skip` (it is back
 * already), or `missing` (nothing to restore from). The fields of `reality`: `originalExists` and `backupExists` for a
 * directory, `fileExists` for an env-file, `markerPresent` for a text-block (its open marker), `keyPresent` for a
 * registration or a Cursor member. Only a step in state `done` or `running` is restored; any other state, and no state,
 * is `skip`, so a step that never ran, failed, or is restored already is never written. A `secrets` step restores
 * nothing (added keys stay), so it is `skip`.
 */
function restoreDecision(step, reality) {
	if (!isPlainObject(step) || !isPlainObject(reality)) throw new TypeError('restoreDecision needs step and reality');
	const type = step.type ?? step.kind;
	if (!['directory', 'env-file', 'text-block', 'claude-mcp-entry', 'json-member', 'secrets'].includes(type)) throw new TypeError('restoreDecision needs a step of a known type');
	if (type === 'env-file' && step.action !== 'delete' && step.action !== 'keep-in-backup') throw new TypeError('restoreDecision needs an env-file step with an action');
	if (step.state !== 'done' && step.state !== 'running') return 'skip';
	switch (type) {
		case 'directory':
			if (reality.originalExists === true) return 'skip';
			return reality.backupExists === true ? 'restore' : 'missing';
		case 'env-file':
			if (step.action === 'delete') return reality.fileExists === true ? 'skip' : 'restore';
			return reality.fileExists === true ? 'restore' : 'missing';
		case 'text-block':
			return reality.markerPresent === true ? 'skip' : 'restore';
		case 'secrets':
			return 'skip';
		default:
			return reality.keyPresent === true ? 'skip' : 'restore';
	}
}

/**
 * How a decline marker (`{ declinedAt, digest }` of readDecline, milliseconds) relates to the plan now: `none` (no
 * usable marker), `changed` (another plan digest), `expired` (7 days or more old, or dated after `now`), or `fresh`.
 */
function declineState({ marker, digest, now } = {}) {
	if (typeof digest !== 'string' || typeof now !== 'number' || !Number.isFinite(now)) throw new TypeError('declineState needs digest and now');
	if (!isPlainObject(marker) || typeof marker.declinedAt !== 'number' || !Number.isFinite(marker.declinedAt)) return 'none';
	if (marker.digest !== digest) return 'changed';
	const age = now - marker.declinedAt;
	return age < 0 || age >= DECLINE_TTL_MS ? 'expired' : 'fresh';
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
	rendersExactly,
	redactEntry,
	nameOnlyEntry,
	removeJsonMember,
	insertJsonMember,
	redactOutput,
	SCHEMA,
	DECLINE_TTL_MS,
	DIGEST_PATTERN,
	parseArgs,
	secretsValue,
	secretSources,
	compareSecrets,
	fingerprint,
	planDigest,
	buildPlan,
	planLines,
	backupFolderName,
	restoreDecision,
	declineState,
};
