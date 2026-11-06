'use strict';
/**
 * iml-shim.js: the plugin's built-in IML shim for test-function.js (spec 3.1): the 81 public built-ins of
 * help.make.com plus jwt and mime, written from the public Make docs and this repo's references, and checked against a
 * recording of the Make engine (lib/__tests__/iml-shim-parity.json) and against the engine run as a black box. A
 * built-in it lacks throws ShimGapError, never a wrong answer. No dependency outside Node.
 */
const crypto = require('crypto');
const { DATE_FUNCTIONS, createDateFunctions, isKnownZone } = require('./iml-shim-dates');
const helpers = require('./iml-shim-helpers');

const SHIM_COVERED = Object.freeze([
	'set', 'get', 'if', 'ifempty', 'switch', 'omit', 'pick',
	'abs', 'average', 'ceil', 'floor', 'formatNumber', 'max', 'median', 'min', 'parseNumber', 'round', 'stdevP', 'stdevS', 'sum', 'trunc',
	'ascii', 'base64', 'capitalize', 'contains', 'decodeURL', 'encodeURL', 'escapeHTML', 'escapeJSON', 'escapeMarkdown', 'indexOf', 'length', 'lower', 'md5', 'replace', 'replaceEmojiCharacters', 'sha1', 'sha256', 'sha512', 'split', 'startcase', 'stripHTML', 'substring', 'toBinary', 'toString', 'trim', 'upper',
	'add', 'arrayDiff', 'arrayIntersect', 'deduplicate', 'distinct', 'first', 'flatten', 'join', 'keys', 'last', 'map', 'merge', 'remove', 'reverse', 'shuffle', 'slice', 'sort', 'toArray', 'toCollection',
	'formatDate', 'parseDate', 'addSeconds', 'addMinutes', 'addHours', 'addDays', 'addMonths', 'addYears', 'setSecond', 'setMinute', 'setHour', 'setDay', 'setDate', 'setMonth', 'setYear',
	'jwt', 'mime',
]);
const SHIM_GAPS = Object.freeze({
	generateJwtWithKeyId: 'signs with a key that Make keeps for the connection',
	toDataStructure: 'reads a data structure of the Make organization',
	dateDiff: 'is on no public Make help page',
});
const DATE_TEXT_RULE = 'date text with digits in no accepted form';
const SHIM_GAP_RULES = Object.freeze({
	jwt: 'an algorithm other than HS256, HS384, HS512, RS256, RS384, RS512, or an option outside JWT_OPTIONS',
	formatDate: `the tokens z and zz, and ${DATE_TEXT_RULE}`,
	parseDate: 'text with digits in no accepted form, without a format',
	mime: 'an extension outside MIME_TABLE',
	...Object.fromEntries(DATE_FUNCTIONS.filter((fn) => /^(add|set)/.test(fn)).map((fn) => [fn, DATE_TEXT_RULE])),
});
const TEMPLATE_ONLY = Object.freeze({
	parseJSON: 'JSON.parse',
	createJSON: 'JSON.stringify',
	isArray: 'Array.isArray',
	pop: 'the array method',
	shift: 'the array method',
	cryptoSign: 'plain JavaScript',
	errorFactory: 'plain JavaScript',
	createXML: 'plain JavaScript',
	parseXML: 'plain JavaScript',
	safeSerialize: 'plain JavaScript',
	getFieldMapping: 'plain JavaScript',
});

class ShimGapError extends Error {
	constructor(fn, detail = '') {
		super(`iml.${fn}${detail ? ` ${detail}` : ''} is not in the plugin's shim`);
		this.name = 'ShimGapError';
		this.fn = fn;
		this.detail = detail;
	}
}

const { isDecimalText, typeName, quoted } = helpers;
/** Path keys that read and write nothing: a probe of the engine refuses these four in get, set and map. */
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype', '__super__']);
const isScalar = (v) => ['string', 'number', 'boolean'].includes(typeof v);
const isTextOrNumber = (v) => typeof v === 'string' || typeof v === 'number';
const isSimple = (v) => v == null || isScalar(v);
/** A JavaScript line terminator, which . in a pattern does not match. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/** Bytes as a Buffer; Buffer.from copies the items of a typed array. */
const bytesOf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v));

const invalid = (value, text, hidden) => {
	const s = quoted(value);
	return new Error(s === null ? hidden : text(s));
};
const notValid = (value, what) => invalid(value, (s) => `'${s}' is not a valid ${what}.`, `Invalid ${what}.`);
const NOT_TEXT_OR_NUMBER = (value) => invalid(value, (s) => `'${s}' is not string or number.`, 'Invalid string or number.');
const BAD_SEPARATOR = (value) => invalid(value, (s) => `'${s}' is not a valid number or using unsuitable separator.`, 'Invalid number or separator.');
const NOT_A_NUMBER_IN_LIST = (value) => invalid(value, () => "'{{number}}' is not a valid number.", 'Invalid number.');

/**
 * A key written in backticks without them (two backticks stand for one), with a [n] after the closing backtick kept.
 * A key with a line break, or without a closing backtick at its end or before such a [n], stays as written.
 */
function unquote(key) {
	if (key.length < 2 || key[0] !== '`' || LINE_BREAK.test(key)) return key;
	let close = key.length - 1;
	if (key[close] !== '`') {
		if (key[close] !== ']') return key;
		close = key.lastIndexOf('`[');
		if (close < 1) return key;
	}
	return key.slice(1, close).replaceAll('``', '`') + key.slice(close + 1);
}

/** The keys of a dot path: a dot splits the path where an even number of backticks follows it. */
function pathKeys(path) {
	const text = String(path);
	let ticksAhead = 0;
	for (let i = 0; i < text.length; i++) if (text[i] === '`') ticksAhead++;
	const keys = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '`') ticksAhead--;
		else if (text[i] === '.' && ticksAhead % 2 === 0) {
			keys.push(unquote(text.slice(start, i)));
			start = i + 1;
		}
	}
	keys.push(unquote(text.slice(start)));
	return keys;
}

/** A key that ends in [n] (digits, or none for 1): the name before it and n; any other key: the key and null. */
function withPosition(key) {
	const end = key.length - 1;
	if (key[end] !== ']') return { name: key, position: null };
	let open = end - 1;
	while (open >= 0 && key[open] >= '0' && key[open] <= '9') open--;
	if (key[open] !== '[') return { name: key, position: null };
	const digits = key.slice(open + 1, end);
	return { name: key.slice(0, open), position: digits === '' ? 1 : Number(digits) };
}

const NOTHING = Symbol('nothing');

/** One name read from a value: an own key of an object, a 1-based position (as parseInt reads it) of a list. */
function readName(value, name) {
	if (Array.isArray(value)) {
		const position = parseInt(name, 10);
		return Number.isNaN(position) ? NOTHING : value[position - 1];
	}
	if (typeof value !== 'object') return value;
	return Object.hasOwn(value, name) ? value[name] : undefined;
}

/**
 * iml.get: a dot path read step by step, 1-based positions written a[n] or a.n, and the empty rule of the receiver. An
 * empty name before [n] on a list reads the position of the list itself; a function found on the way counts as empty.
 */
function lookup(data, path, empty) {
	let value = data;
	if (value == null) return empty(value);
	for (const key of pathKeys(path)) {
		if (BLOCKED_KEYS.has(key)) return empty(undefined);
		const { name, position } = withPosition(key);
		if (name !== '' || position === null || !Array.isArray(value)) {
			value = readName(value, name);
			if (value === NOTHING) return empty(undefined);
		}
		if (position !== null && Array.isArray(value)) value = value[position - 1];
		if (typeof value === 'function') return empty(undefined);
		if (value == null) return empty(value);
	}
	return value;
}

/**
 * The steps of a path that iml.set writes: the keys split again on [ and ], empty pieces dropped. A piece that is a
 * whole number of 0 or more is a list position (1 and 0 both the first item); any other piece is an object key.
 */
function writeSteps(path) {
	const steps = [];
	for (const key of pathKeys(path)) {
		for (const piece of key.split(/[[\]]/)) {
			if (piece === '') continue;
			const n = isDecimalText(piece) ? Number(piece) : NaN;
			steps.push(Number.isInteger(n) && n >= 0 ? Math.max(n - 1, 0) : piece);
		}
	}
	return steps;
}

/**
 * A copy of `holder` with `entry` at `step`: a position copies a list (a new list for anything else) and fills the gap
 * with undefined; a key copies a plain object (a new object for anything else).
 */
function withEntry(holder, step, entry) {
	if (typeof step === 'number') {
		const list = Array.isArray(holder) ? [...holder] : [];
		while (list.length < step) list.push(undefined);
		list[step] = entry;
		return list;
	}
	const record = holder !== null && typeof holder === 'object' && !Array.isArray(holder) ? holder : {};
	return { ...record, [step]: entry };
}

/** The engine's loose equality of distinct: null equals undefined, scalars compare as text, objects key by key. */
function looseEqual(a, b) {
	if (a == null || b == null) return (a == null) === (b == null);
	if (typeof a !== 'object') return isScalar(a) && String(a) === String(b);
	if (typeof b !== 'object') return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!looseEqual(a[i], b[i])) return false;
		return true;
	}
	if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
	if (Object.keys(a).length !== Object.keys(b).length) return false;
	for (const key in a) if (!looseEqual(a[key], b[key])) return false;
	return true;
}

const ENCODINGS = ['ascii', 'hex', 'base64', 'utf8', 'binary'];

function encodingOf(value) {
	if (typeName(value) !== 'string') throw notValid(value, 'encoding');
	const encoding = value.toLowerCase() === 'utf-8' ? 'utf8' : value.toLowerCase();
	if (!ENCODINGS.includes(encoding)) throw notValid(encoding, 'encoding');
	return encoding;
}

function joinedItem(item, separator, brackets) {
	if (typeof item !== 'object') return item === undefined ? '' : `${item}`;
	if (item === null) return '';
	if (Array.isArray(item)) return joinItems(item, separator, brackets);
	if (item instanceof Date) return item.toISOString();
	return typeName(item) === 'buffer' ? '{buffer}' : '{object}';
}

function joinItems(list, separator, brackets) {
	const text = list.map((item) => joinedItem(item, separator, brackets)).join(separator);
	return brackets ? `[${text}]` : text;
}

/**
 * iml.toString: '' for null and undefined; for any other input the encoding (the second argument when there are exactly
 * two) is checked first.
 */
function toText(value, ...rest) {
	if (value == null) return '';
	const encoding = encodingOf(rest.length === 1 ? rest[0] : 'utf8');
	if (typeof value !== 'object') return isScalar(value) ? String(value) : '';
	if (Array.isArray(value)) return joinItems(value, ',', true);
	if (value instanceof Date) return value.toISOString();
	return typeName(value) === 'buffer' ? bytesOf(value).toString(encoding) : '{object}';
}

/** The bytes the hash functions read: empty stays null, so Node refuses it as the engine's call does. */
function toBytes(data) {
	if (data == null) return null;
	const kind = typeName(data);
	if (kind === 'buffer') return bytesOf(data);
	return kind === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(toText(data));
}

function generalFunctions({ empty, manifest }) {
	return {
		get: (value, path) => lookup(value, path, empty),
		set(object, path, value) {
			if (object == null) return empty(object);
			if (typeof object !== 'object') return object;
			if (path == null || String(path).trim() === '') throw new Error("Function 'set' finished with error! Path must be a string.");
			const steps = writeSteps(path);
			if (steps.some((step) => BLOCKED_KEYS.has(step))) throw new Error('"Function \'set\' finished with error! Forbidden key used in path."');
			const holders = [object];
			for (let i = 1; i < steps.length; i++) holders.push(holders[i - 1]?.[steps[i - 1]]);
			let result = structuredClone(value);
			for (let i = steps.length - 1; i >= 0; i--) result = withEntry(holders[i], steps[i], result);
			return result;
		},
		if: (condition, whenTrue, whenFalse) => (condition ? whenTrue : whenFalse),
		ifempty: (value, fallback) => (value == null || value === '' ? fallback : value),
		switch(...args) {
			const fallback = args.length % 2 === 0 ? args.pop() : undefined;
			const none = () => (fallback != null || manifest >= 2 ? fallback : null);
			const value = args[0];
			if (!isScalar(value)) return none();
			for (let i = 1; i < args.length; i += 2) if (isScalar(args[i]) && String(value) === String(args[i])) return args[i + 1];
			return none();
		},
		omit(object, ...keys) {
			if (!object) return {};
			if (keys.length === 0) return object;
			const names = Array.isArray(keys[0]) ? keys[0] : keys;
			const out = {};
			for (const key of Object.keys(object)) if (!names.includes(key)) out[key] = object[key];
			return out;
		},
		pick(object, ...keys) {
			if (!object || keys.length === 0) return {};
			const names = Array.isArray(keys[0]) ? keys[0] : keys;
			const own = Object.keys(object);
			const out = {};
			for (const key of names) if (own.includes(key)) out[key] = object[key];
			return out;
		},
	};
}

/** The group mark that parseNumber drops for each decimal mark it accepts. */
const GROUP_MARK_FOR = new Map([['.', ','], [',', '.']]);
const LEADING_MARKS = new Set('-0123456789');
const INNER_MARKS = new Set('0123456789.,e');

/**
 * parseNumber of text: a leading digit or minus and later digits, marks and e are kept; the group mark is dropped and
 * the decimal mark read as a point. A result that is not decimal text fails with the kept characters.
 */
function numberFromText(text, decimal) {
	const group = GROUP_MARK_FOR.get(decimal);
	if (group === undefined) throw new Error("Valid separators are ',' and '.'.");
	let kept = '';
	let plain = '';
	for (let i = 0; i < text.length; i++) {
		const mark = text[i];
		if (!(i === 0 ? LEADING_MARKS : INNER_MARKS).has(mark)) continue;
		kept += mark;
		if (mark !== group) plain += mark === decimal ? '.' : mark;
	}
	const n = Number(plain);
	if (!isDecimalText(n)) throw BAD_SEPARATOR(kept);
	return n;
}

function mathFunctions({ empty }) {
	const numbers = (args) => (Array.isArray(args[0]) ? args[0] : args).filter(isDecimalText);
	const strictNumbers = (args) => (Array.isArray(args[0]) ? args.flat() : args).map((v) => {
		if (typeof v !== 'number') throw NOT_A_NUMBER_IN_LIST(v);
		return v;
	});
	const deviation = (args, sample) => {
		const list = strictNumbers(args);
		const mean = list.reduce((total, x) => total + x, 0) / list.length;
		const squares = list.map((x) => Math.pow(x - mean, 2));
		return Math.sqrt(squares.reduce((total, x) => total + x, 0) / (sample ? list.length - 1 : list.length));
	};
	const rounding = (method, kinds) => (value) => {
		if (value == null) return empty(value);
		if (value === '') return null;
		if (!kinds.includes(typeName(value))) throw notValid(value, 'number');
		return method(value);
	};
	return {
		abs(value) {
			if (typeName(value) !== 'number') throw invalid(value, (s) => `'${s}' is not number.`, 'Invalid number.');
			return Math.abs(Number(value));
		},
		average: (...args) => {
			const list = numbers(args);
			let total = 0;
			for (const x of list) total += Number(x);
			return total / list.length;
		},
		ceil: rounding(Math.ceil, ['number']),
		floor: rounding(Math.floor, ['number']),
		round: rounding(Math.round, ['number', 'string']),
		formatNumber(value, decimals, pointMark, groupMark) {
			if (value == null) return empty(value);
			if (!['number', 'string'].includes(typeName(value))) throw notValid(value, 'number');
			const n = Number(value);
			if (!isDecimalText(n)) throw BAD_SEPARATOR(n);
			const parts = n.toFixed(decimals).split('.');
			const sign = parts[0].startsWith('-') ? '-' : '';
			let digits = parts[0].slice(sign.length);
			const groups = [];
			while (digits.length > 3) {
				groups.unshift(digits.slice(-3));
				digits = digits.slice(0, -3);
			}
			parts[0] = sign + [digits, ...groups].join(groupMark ?? '.');
			return parts.join(pointMark ?? ',');
		},
		max: (...args) => Math.max(...numbers(args)),
		min: (...args) => Math.min(...numbers(args)),
		median(...args) {
			const list = strictNumbers(args).sort((a, b) => a - b);
			if (list.length === 0) return null;
			const middle = Math.floor(list.length / 2);
			return list.length % 2 === 0 ? (list[middle - 1] + list[middle]) / 2 : list[middle];
		},
		parseNumber(value, separator) {
			if (value == null) return empty(value);
			const kind = typeName(value);
			if (kind === 'string') return numberFromText(value, separator ?? '.');
			if (kind !== 'number') throw notValid(value, 'number');
			return Number(value);
		},
		stdevP: (...args) => deviation(args, false),
		stdevS: (...args) => deviation(args, true),
		sum: (...args) => {
			let total = 0;
			for (const x of numbers(args)) total += parseFloat(x);
			return total;
		},
		trunc(value, digits = 0) {
			if (typeName(value) !== 'number') throw notValid(value, 'number');
			if (typeName(digits) !== 'number') throw invalid(digits, () => "'{{numDigits}}' is not a valid number.", 'Invalid number.');
			const n = Number(value);
			const places = Number(digits);
			const cut = places >= 0 && n - Math.floor(n) !== 0;
			if (cut) {
				const [whole, decimals] = String(n).split('.');
				if (decimals.length >= places) return Number(`${whole}.${decimals.slice(0, places)}`);
			} else if (places < 0) {
				const scale = 10 ** places;
				return Math.trunc(n * scale) / scale;
			}
			return Number(n.toFixed(places));
		},
	};
}

/** An emoji as the engine finds it; the first class lists the emoji shown as emoji by default that it reads with a following U+FE0F. */
const EMOJI = /[\u231A\u231B\u25FE\u2614\u2615\u2648-\u2653\u267F\u26AA\u26BD\u26BE\u26C4\u26F2\u26F3\u26F5\u26FA\u2757\u2B1B\u2B1C\u2B55\u{1F004}]\uFE0F|\p{RGI_Emoji}|[#*0-9]\u20E3|[\p{Emoji}--[#*0-9\p{Regional_Indicator}]]\uFE0F?/gv;
const HTML_ENTITIES = { '<': '&lt;', '>': '&gt;', '&': '&amp;' };
/** The characters escapeMarkdown replaces, found by a probe of the engine over every UTF-16 unit: &, < and > by name, the rest by number. */
const MARKDOWN_MARKS = new Set('!#&()*+-/:<=>[\\]_`|~');

/** The text without its UTF-16 units from `low` to `high`: the combining marks after NFD, or everything outside ASCII. */
const withoutUnits = (text, low, high) => text.split('').filter((c) => c < low || c > high).join('');

/** The search of iml.replace as a pattern when it is written /pattern/ with no flag or one of g, i and m; else null. */
function searchPattern(text) {
	if (text.length < 2 || text[0] !== '/' || LINE_BREAK.test(text)) return null;
	const last = text[text.length - 1];
	const flag = text.length > 2 && 'gim'.includes(last) && text[text.length - 2] === '/' ? last : '';
	const close = text.length - 1 - flag.length;
	if (close < 1 || text[close] !== '/') return null;
	return new RegExp(text.slice(1, close), flag);
}

/** The text without each <tag ...> ... </tag> block: the opening tag up to its first >, then up to the first </tag>. */
function withoutBlock(text, tag) {
	const open = `<${tag}`;
	const close = `</${tag}>`;
	let out = '';
	let from = 0;
	for (let start = text.indexOf(open); start !== -1; start = text.indexOf(open, from)) {
		const gt = text.indexOf('>', start + open.length);
		const end = gt === -1 ? -1 : text.indexOf(close, gt + 1);
		if (end === -1) break;
		out += text.slice(from, start);
		from = end + close.length;
	}
	return out + text.slice(from);
}

/** The text with each <br>, <br/> and <br /> (any white space before the slash or the >) as a line break. */
function lineBreaks(text) {
	let out = '';
	let from = 0;
	for (let start = text.indexOf('<br'); start !== -1; start = text.indexOf('<br', from)) {
		let i = start + 3;
		while (i < text.length && /\s/.test(text[i])) i++;
		if (text[i] === '/') i++;
		const isBreak = text[i] === '>';
		out += isBreak ? `${text.slice(from, start)}\n` : text.slice(from, start + 3);
		from = isBreak ? i + 1 : start + 3;
	}
	return out + text.slice(from);
}

/** The text without its tags: each < that has at least one character before the next >, up to that >. */
function withoutTags(text) {
	let out = '';
	let from = 0;
	for (let lt = text.indexOf('<'); lt !== -1; ) {
		const gt = text.indexOf('>', lt + 1);
		if (gt === -1) break;
		if (gt === lt + 1) {
			lt = text.indexOf('<', gt);
			continue;
		}
		out += text.slice(from, lt);
		from = gt + 1;
		lt = text.indexOf('<', from);
	}
	return out + text.slice(from);
}

function textFunctions({ empty }) {
	const text = (fn) => (value, ...rest) => (value == null ? empty(value) : fn(String(value), ...rest));
	const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
	/** An encoding argument in lower case; the TypeError names the argument as the engine's does. */
	const lowerArg = (args, i) => {
		const value = args[i];
		if (value == null) return undefined;
		if (typeof value.toLowerCase !== 'function') throw new TypeError(`arguments[${i}].toLowerCase is not a function`);
		return value.toLowerCase();
	};
	const hash = (algorithm, keyed) => (...args) => {
		const data = args[0];
		let encoding = lowerArg(args, 1);
		let key = args[2];
		let keyEncoding = lowerArg(args, 3);
		if (!['hex', 'latin1', 'base64', 'binary'].includes(encoding)) encoding = 'hex';
		if (!['text', 'hex', 'base64', 'binary'].includes(keyEncoding)) keyEncoding = 'text';
		if (keyed(key)) {
			if (keyEncoding === 'text') key = typeName(key) === 'buffer' ? key : toBytes(key);
			else if (keyEncoding !== 'binary') key = Buffer.from(toText(key), keyEncoding);
			else if (typeName(key) !== 'buffer') throw new Error("Key 'binary' is not a valid buffer.");
		}
		const bytes = toBytes(data);
		const digest = key ? crypto.createHmac(algorithm, key) : crypto.createHash(algorithm);
		return digest.update(bytes).digest(encoding);
	};
	const plainText = (value) => (typeName(value) === 'buffer' ? bytesOf(value).toString() : value);
	return {
		ascii: text((s, removeDiacritics) => withoutUnits(removeDiacritics ? withoutUnits(s.normalize('NFD'), '\u0300', '\u036f') : s, '\u0080', '\uffff')),
		base64: (data) => Buffer.from(typeName(data) === 'buffer' ? data : toText(data)).toString('base64'),
		capitalize: text(capitalize),
		contains(subject, value, ...rest) {
			if (subject == null || value == null) return false;
			const ignoreCase = Boolean(rest[0]);
			if (isTextOrNumber(subject)) {
				if (ignoreCase) return String(subject).toLowerCase().indexOf(String(value).toLowerCase()) !== -1;
				if (typeof subject === 'number') throw new TypeError('array.indexOf is not a function');
				return subject.indexOf(value) !== -1;
			}
			if (!Array.isArray(subject)) return false;
			const type = typeName(value);
			if (type === 'date') return subject.some((item) => +item === +value);
			if (type !== 'string' && type !== 'number') return subject.some((item) => item === value);
			const wanted = String(type === 'string' && ignoreCase ? value.toLowerCase() : value);
			return subject.some((item) => {
				if (!isTextOrNumber(item)) return false;
				if (!ignoreCase) return String(item) === wanted;
				if (typeof item === 'number') throw new TypeError('item.toLowerCase is not a function');
				return item.toLowerCase() === wanted;
			});
		},
		decodeURL: text(decodeURIComponent),
		encodeURL: text(encodeURIComponent),
		escapeHTML: text((s) => s.replace(/[&<>]/g, (c) => HTML_ENTITIES[c])),
		escapeJSON: text((s) => JSON.stringify(s).slice(1, -1)),
		escapeMarkdown: text((s) => s.split('').map((c) => (MARKDOWN_MARKS.has(c) ? HTML_ENTITIES[c] || `&#${c.charCodeAt(0)};` : c)).join('')),
		indexOf: text((s, value, start) => s.indexOf(value, start)),
		length(value) {
			if (value == null) return 0;
			return ['array', 'buffer'].includes(typeName(value)) ? value.length : String(value).length;
		},
		lower: text((s) => s.toLowerCase()),
		md5: (data) => crypto.createHash('md5').update(toBytes(data)).digest('hex'),
		replace(value, search, replacement) {
			if (value == null) return empty(value);
			if (search == null || replacement == null) return value;
			const source = plainText(value);
			for (const v of [source, search, replacement]) if (!isTextOrNumber(v)) throw NOT_TEXT_OR_NUMBER(v);
			const pattern = searchPattern(String(search));
			return pattern ? String(source).replace(pattern, replacement) : String(source).replaceAll(String(search), replacement);
		},
		replaceEmojiCharacters(value, replacement) {
			if (value == null) return empty(value);
			if (replacement == null) throw new Error("The replacement value is required to be added. Invalid value: '{empty}'");
			const source = plainText(value);
			for (const v of [source, replacement]) if (!isTextOrNumber(v)) throw NOT_TEXT_OR_NUMBER(v);
			return String(source).replace(EMOJI, replacement);
		},
		sha1: hash('sha1', (key) => key != null),
		sha256: hash('sha256', (key) => key != null),
		sha512: hash('sha512', Boolean),
		split(value, separator, keepEmpty) {
			let parts;
			if (typeof value === 'string') parts = value.split(separator ?? ',');
			else if (typeof value === 'number') parts = [String(value)];
			else if (value instanceof Date) throw new TypeError('arr.map is not a function');
			else return null;
			parts = parts.map((part) => part.trim());
			return keepEmpty ? parts : parts.filter((part) => part !== '');
		},
		startcase: text((s) => s.split(' ').map((word) => capitalize(word.toLowerCase())).join(' ')),
		stripHTML: text((s) => withoutTags(lineBreaks(withoutBlock(withoutBlock(s, 'style'), 'script')))),
		substring: text((s, start, end) => s.substring(start, end)),
		toBinary(entry, ...rest) {
			if (entry == null) return empty(entry);
			if (typeName(entry) === 'buffer') return entry;
			const encoding = encodingOf(rest.length === 1 ? rest[0] : 'utf8');
			return typeName(entry) === 'string' ? Buffer.from(entry, encoding) : Buffer.from(toText(entry));
		},
		toString: toText,
		trim: text((s) => s.trim()),
		upper: text((s) => s.toUpperCase()),
	};
}

/** A comma list, split at each comma with the white space next to the commas dropped (not at the two ends). */
function commaList(text) {
	const parts = text.split(',');
	const last = parts.length - 1;
	return parts.map((part, i) => {
		const start = i > 0 ? part.trimStart() : part;
		return i < last ? start.trimEnd() : start;
	});
}

/** The orders of iml.sort; any other second argument is the key, sorted in ascending order. */
const SORT_ORDERS = new Set(['asc', 'desc', 'asc ci', 'desc ci']);
/** The ascending order of sort: an empty value or a greater one goes after, a smaller one before, any other pair stays. */
const compareValues = (a, b) => (a == null || a > b ? 1 : b == null || a < b ? -1 : 0);
/** The ascending order of the ci orders: the values as lower-case text in the locale order. */
const compareText = (a, b) => String(a).toLowerCase().localeCompare(String(b).toLowerCase());

function arrayFunctions({ empty }) {
	const field = (item, key) => lookup(item, key, empty);
	const listOnly = (fn) => (list, ...rest) => {
		if (list == null) return empty(list);
		if (!Array.isArray(list)) throw notValid(list, 'array');
		return fn(list, ...rest);
	};
	const twoLists = (fn) => (a, b) => {
		if (a == null) return empty(a);
		if (b == null) return empty(b);
		for (const list of [a, b]) if (!Array.isArray(list)) throw notValid(list, 'array');
		return fn(a, b);
	};
	/** True the first time `value` comes to `set`, which then holds it. */
	const isNew = (set, value) => !set.has(value) && Boolean(set.add(value));
	/**
	 * The first item per value (of the item, or of its `key`): one empty value, text, numbers and booleans as text, dates
	 * by their time (an invalid date is always new), objects and lists by looseEqual; a function or a symbol is dropped.
	 */
	const distinct = listOnly((list, key) => {
		const empties = new Set();
		const texts = new Set();
		const times = new Set();
		const structures = [];
		return list.filter((item) => {
			const value = key ? field(item, key) : item;
			if (value == null) return isNew(empties, null);
			if (isScalar(value)) return isNew(texts, String(value));
			if (value instanceof Date) return Number.isNaN(value.getTime()) || isNew(times, value.getTime());
			if (typeof value !== 'object' || structures.some((seen) => looseEqual(value, seen))) return false;
			structures.push(value);
			return true;
		});
	});
	/** A value of an item for map: the path lookup, else the item's own property of that whole name (none for a blocked name). */
	const mapped = (item, name) => {
		const found = field(item, name);
		if (found != null) return found;
		if (BLOCKED_KEYS.has(name)) return empty(undefined);
		return item[name];
	};
	return {
		add: listOnly((list, ...values) => {
			const out = list.slice();
			out.push(...values);
			return out;
		}),
		arrayDiff: twoLists((a, b) => {
			if ([...a, ...b].some((item) => ['object', 'array'].includes(typeName(item)))) throw new Error('Array contains collections or objects.');
			return a.filter((item) => !b.some((other) => (item == null || other == null ? item === other : String(item) === String(other))));
		}),
		arrayIntersect: twoLists((a, b) =>
			a.filter((item) => isSimple(item) && b.some((other) => isSimple(other) && (item == null || other == null ? item == null && other == null : String(item) === String(other)))),
		),
		deduplicate: distinct,
		distinct,
		first: listOnly((list) => list[0]),
		flatten: listOnly((list, depth) => {
			if (!['null', 'undefined', 'number'].includes(typeName(depth))) throw notValid(depth, 'number');
			const flat = (items, level) => items.reduce((out, v) => (Array.isArray(v) && level > 1 ? out.concat(flat(v, level - 1)) : out.concat(v)), []);
			return flat(list, depth ?? 1);
		}),
		join: (list, separator, ...rest) => {
			if (!Array.isArray(list)) return '';
			return joinItems(list, isTextOrNumber(separator) ? separator : ',', rest[0] === true);
		},
		keys: (value) => (['object', 'array'].includes(typeName(value)) ? Object.keys(value) : []),
		last: listOnly((list) => list[list.length - 1]),
		map: listOnly((list, key, ...rest) => {
			if (!isTextOrNumber(key)) throw notValid(key, 'key');
			if (list.length === 0) return [];
			const [filterKey, names] = rest;
			if (filterKey != null && !isTextOrNumber(filterKey)) throw notValid(filterKey, 'key for filtering');
			if (names != null && !isScalar(names)) throw invalid(names, (s) => `'${s}' is not a valid list of key names for filtering.`, 'Invalid key names for filtering.');
			if (filterKey == null || names == null) return list.map((item) => mapped(item, key));
			const allowed = commaList(String(names));
			const kept = list.filter((item) => {
				const v = mapped(item, filterKey);
				return v !== undefined && allowed.includes(String(v));
			});
			return kept.map((item) => mapped(item, key));
		}),
		merge: (...args) => {
			const lists = args.filter(Array.isArray);
			return lists.length ? [].concat(...lists) : null;
		},
		remove: listOnly((list, ...values) => {
			const targets = values.filter((v) => v === null || isScalar(v));
			return list.filter((item) => !isSimple(item) || !targets.some((t) => (t === null ? item == null : item != null && String(t) === String(item))));
		}),
		reverse: listOnly((list) => list.slice().reverse()),
		shuffle: listOnly((list) => {
			const out = list.slice();
			for (let i = out.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[out[i], out[j]] = [out[j], out[i]];
			}
			return out;
		}),
		slice(list, begin, ...rest) {
			if (list == null) return empty(list);
			const end = rest[0] ?? undefined;
			if (!Array.isArray(list)) throw notValid(list, 'array');
			if (!isDecimalText(begin)) throw notValid(begin, 'start number');
			if (end != null && !isDecimalText(end)) throw notValid(end, 'end number');
			return list.slice(begin, end);
		},
		sort: listOnly((list, ...rest) => {
			const named = SORT_ORDERS.has(rest[0]);
			const order = named ? rest[0] : 'asc';
			const key = named ? rest[1] : rest[0];
			const sign = order.startsWith('desc') ? -1 : 1;
			const valueOf = (item) => (key ? field(item, key) : item);
			const compare = order.endsWith(' ci') ? compareText : compareValues;
			return list.slice().sort((x, y) => sign * compare(valueOf(x), valueOf(y)));
		}),
		toArray(collection) {
			if (!collection || typeof collection !== 'object') throw notValid(collection, 'collection');
			const keys = Array.isArray(collection) ? collection.map((_, i) => i) : Object.keys(collection);
			return keys.map((key) => ({ key, value: collection[key] }));
		},
		toCollection(list, key, value) {
			if (!(list && key && value)) return {};
			if (!Array.isArray(list)) throw notValid(list, 'array');
			if (!isTextOrNumber(key)) throw notValid(key, 'key name');
			if (!isTextOrNumber(value)) throw notValid(value, 'value name');
			const out = {};
			for (const item of list) {
				const name = field(item, key);
				if (name) out[name] = field(item, value);
			}
			return out;
		},
	};
}

function createImlShim({ timezone = 'UTC', manifest = 1, now = Date.now, onGap = () => {}, onWarning = () => {} } = {}) {
	const known = isKnownZone(timezone);
	if (!known) onWarning('unknown-zone', timezone);
	const gap = (fn, detail = '') => {
		onGap(fn, detail);
		throw new ShimGapError(fn, detail);
	};
	const m = manifest >= 2 ? 2 : 1;
	const ctx = { zone: known ? timezone : 'UTC', manifest: m, now, gap, empty: (value) => (m >= 2 ? value : null) };
	const iml = Object.create(null);
	Object.assign(iml, generalFunctions(ctx), mathFunctions(ctx), textFunctions(ctx), arrayFunctions(ctx), createDateFunctions(ctx));
	iml.jwt = (...args) => helpers.jwt(args, ctx);
	iml.mime = (name) => helpers.mimeType(name, ctx);
	for (const name of Object.keys(SHIM_GAPS)) iml[name] = () => gap(name);
	return iml;
}

module.exports = { SHIM_COVERED, SHIM_GAPS, SHIM_GAP_RULES, TEMPLATE_ONLY, ShimGapError, createImlShim };
