'use strict';
/**
 * The 15 date functions of the plugin's IML shim (spec 3.1): zone math on Intl.DateTimeFormat, the format tokenizer,
 * parseDate with and without a format, add* and set*. The rules follow the engine as the parity file records it. The
 * current time comes only from now(); gap(fn, detail) throws for a declared gap.
 * Behaviour and messages follow the public moment and moment-timezone packages (MIT licensed; their notices are in
 * THIRD_PARTY_NOTICES.md in this folder).
 */
const { isDecimalText, quoted } = require('./iml-shim-helpers');

const DATE_FUNCTIONS = Object.freeze(['formatDate', 'parseDate', 'addSeconds', 'addMinutes', 'addHours', 'addDays', 'addMonths', 'addYears', 'setSecond', 'setMinute', 'setHour', 'setDay', 'setDate', 'setMonth', 'setYear']);

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULT_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSSZ';
/** A format of only spaces: the engine falls back to these, without milliseconds, and writes Z at a zero offset of a known zone. */
const WHITESPACE_FORMAT = 'YYYY-MM-DDTHH:mm:ssZ';
const WHITESPACE_FORMAT_UTC = 'YYYY-MM-DDTHH:mm:ss[Z]';
const formatters = new Map();

function formatterOf(zone) {
	let f = formatters.get(zone);
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', era: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
		formatters.set(zone, f);
	}
	return f;
}

/** A zone name Intl knows; an offset such as +02:00 is refused, because the engine falls back to UTC for it. */
function isKnownZone(zone) {
	if (typeof zone !== 'string' || !zone || /^[+-]/.test(zone)) return false;
	try {
		formatterOf(zone);
		return true;
	} catch {
		return false;
	}
}

/** The instant whose UTC fields are the wall fields (years 0 to 99 included, which Date.UTC would move to 19xx). */
function utcOf(wall) {
	const d = new Date(0);
	d.setUTCFullYear(wall.year, wall.month - 1, wall.day);
	d.setUTCHours(wall.hour, wall.minute, wall.second, wall.millisecond);
	return d.getTime();
}

/** The wall clock of an instant in a zone, and the exact offset in milliseconds (seconds included, as in old local times). */
function local(ms, zone) {
	const p = {};
	for (const { type, value } of formatterOf(zone).formatToParts(new Date(ms))) p[type] = value;
	const year = p.era === 'BC' || p.era === 'B' ? 1 - Number(p.year) : Number(p.year);
	const wall = { year, month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second), millisecond: ((ms % 1000) + 1000) % 1000, weekday: WEEKDAYS[p.weekday] };
	return { wall, offsetMs: utcOf(wall) - ms };
}

function wallClock(ms, zone) {
	const { wall, offsetMs } = local(ms, zone);
	return { ...wall, offsetMinutes: Math.round(offsetMs / MINUTE_MS) };
}

const offsetAt = (ms, zone) => local(ms, zone).offsetMs;

/** Wall clock to instant: in a spring gap the time moves forward by the gap; in an autumn overlap the earlier offset wins. */
function instantOf(wall, zone) {
	const at = utcOf(wall);
	if (Number.isNaN(at)) return NaN;
	const before = offsetAt(at - DAY_MS, zone);
	if (offsetAt(at - before, zone) === before) return at - before;
	const after = offsetAt(at + DAY_MS, zone);
	if (offsetAt(at - after, zone) === after) return at - after;
	return at - before;
}

const dateUtc = (year, month, day) => utcOf({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 });
const daysInMonth = (year, month) => new Date(dateUtc(year, month + 1, 0)).getUTCDate();
const dayOfYear = (w) => Math.round((dateUtc(w.year, w.month, w.day) - dateUtc(w.year, 1, 1)) / DAY_MS) + 1;

/** Week year and week of a wall date: weeks start on weekStart, and a week belongs to the year of its day `anchor`. */
function weekOf(w, weekStart, anchor) {
	const back = (w.weekday - weekStart + 7) % 7;
	const at = dateUtc(w.year, w.month, w.day) + (anchor - back) * DAY_MS;
	const year = new Date(at).getUTCFullYear();
	return { year, week: Math.floor((at - dateUtc(year, 1, 1)) / DAY_MS / 7) + 1 };
}
const localWeek = (c) => weekOf(c, 0, 6);
const isoWeek = (c) => weekOf(c, 1, 3);

function zeroFill(n, width, sign = false) {
	const digits = String(Math.abs(n)).padStart(width, '0');
	if (n < 0) return `-${digits}`;
	return sign ? `+${digits}` : digits;
}

function ordinal(n) {
	const last = n % 10;
	const suffix = Math.trunc((n % 100) / 10) === 1 ? 'th' : last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
	return `${n}${suffix}`;
}

function offsetText(c, separator) {
	const minutes = Math.trunc(Math.abs(c.offsetMs) / MINUTE_MS);
	return `${c.offsetMs < 0 ? '-' : '+'}${zeroFill(Math.floor(minutes / 60), 2)}${separator}${zeroFill(minutes % 60, 2)}`;
}

const hour12 = (c) => c.hour % 12 || 12;
const eraYear = (c) => (c.year >= 1 ? c.year : 1 - c.year);
const era = (c) => (c.year >= 1 ? 'AD' : 'BC');

/** One writer per token; the context holds the wall fields, the instant `ms` and `offsetMs`. */
const FORMATTERS = {
	YYYYYY: (c) => zeroFill(c.year, 6, true),
	YYYYY: (c) => zeroFill(c.year, 5),
	YYYY: (c) => zeroFill(c.year, 4),
	YY: (c) => zeroFill(c.year % 100, 2),
	Y: (c) => (c.year <= 9999 ? zeroFill(c.year, 4) : `+${c.year}`),
	N: era,
	NN: era,
	NNN: era,
	NNNN: (c) => (c.year >= 1 ? 'Anno Domini' : 'Before Christ'),
	NNNNN: era,
	y: (c) => zeroFill(eraYear(c), 1),
	yy: (c) => zeroFill(eraYear(c), 2),
	yyy: (c) => zeroFill(eraYear(c), 3),
	yyyy: (c) => zeroFill(eraYear(c), 4),
	yo: (c) => ordinal(eraYear(c)),
	Q: (c) => String(Math.ceil(c.month / 3)),
	Qo: (c) => ordinal(Math.ceil(c.month / 3)),
	M: (c) => String(c.month),
	Mo: (c) => ordinal(c.month),
	MM: (c) => zeroFill(c.month, 2),
	MMM: (c) => MONTH_NAMES[c.month - 1].slice(0, 3),
	MMMM: (c) => MONTH_NAMES[c.month - 1],
	D: (c) => String(c.day),
	Do: (c) => ordinal(c.day),
	DD: (c) => zeroFill(c.day, 2),
	DDD: (c) => String(dayOfYear(c)),
	DDDo: (c) => ordinal(dayOfYear(c)),
	DDDD: (c) => zeroFill(dayOfYear(c), 3),
	d: (c) => String(c.weekday),
	do: (c) => ordinal(c.weekday),
	dd: (c) => DAY_NAMES[c.weekday].slice(0, 2),
	ddd: (c) => DAY_NAMES[c.weekday].slice(0, 3),
	dddd: (c) => DAY_NAMES[c.weekday],
	e: (c) => String(c.weekday),
	E: (c) => String(c.weekday || 7),
	w: (c) => String(localWeek(c).week),
	wo: (c) => ordinal(localWeek(c).week),
	ww: (c) => zeroFill(localWeek(c).week, 2),
	W: (c) => String(isoWeek(c).week),
	Wo: (c) => ordinal(isoWeek(c).week),
	WW: (c) => zeroFill(isoWeek(c).week, 2),
	gg: (c) => zeroFill(localWeek(c).year % 100, 2),
	gggg: (c) => zeroFill(localWeek(c).year, 4),
	ggggg: (c) => zeroFill(localWeek(c).year, 5),
	GG: (c) => zeroFill(isoWeek(c).year % 100, 2),
	GGGG: (c) => zeroFill(isoWeek(c).year, 4),
	GGGGG: (c) => zeroFill(isoWeek(c).year, 5),
	H: (c) => String(c.hour),
	HH: (c) => zeroFill(c.hour, 2),
	h: (c) => String(hour12(c)),
	hh: (c) => zeroFill(hour12(c), 2),
	k: (c) => String(c.hour || 24),
	kk: (c) => zeroFill(c.hour || 24, 2),
	Hmm: (c) => `${c.hour}${zeroFill(c.minute, 2)}`,
	Hmmss: (c) => `${c.hour}${zeroFill(c.minute, 2)}${zeroFill(c.second, 2)}`,
	hmm: (c) => `${hour12(c)}${zeroFill(c.minute, 2)}`,
	hmmss: (c) => `${hour12(c)}${zeroFill(c.minute, 2)}${zeroFill(c.second, 2)}`,
	A: (c) => (c.hour > 11 ? 'PM' : 'AM'),
	a: (c) => (c.hour > 11 ? 'pm' : 'am'),
	m: (c) => String(c.minute),
	mm: (c) => zeroFill(c.minute, 2),
	s: (c) => String(c.second),
	ss: (c) => zeroFill(c.second, 2),
	S: (c) => String(Math.floor(c.millisecond / 100)),
	SS: (c) => zeroFill(Math.floor(c.millisecond / 10), 2),
	SSS: (c) => zeroFill(c.millisecond, 3),
	Z: (c) => offsetText(c, ':'),
	ZZ: (c) => offsetText(c, ''),
	X: (c) => String(Math.floor(c.ms / 1000)),
	x: (c) => String(c.ms),
};
for (let n = 4; n <= 9; n++) FORMATTERS['S'.repeat(n)] = (c) => zeroFill(c.millisecond * 10 ** (n - 3), n);

const LOCALIZED_FORMATS = Object.freeze({ LT: 'h:mm A', LTS: 'h:mm:ss A', L: 'MM/DD/YYYY', LL: 'MMMM D, YYYY', LLL: 'MMMM D, YYYY h:mm A', LLLL: 'dddd, MMMM D, YYYY h:mm A', l: 'M/D/YYYY', ll: 'MMM D, YYYY', lll: 'MMM D, YYYY h:mm A', llll: 'ddd, MMM D, YYYY h:mm A' });
const ZONE_NAME_TOKENS = ['zz', 'z'];
const FORMAT_TOKENS = Object.freeze([...Object.keys(FORMATTERS), ...Object.keys(LOCALIZED_FORMATS), ...ZONE_NAME_TOKENS].sort((a, b) => b.length - a.length));

const tokenAt = (format, i) => FORMAT_TOKENS.find((t) => format.startsWith(t, i));

/** For each [ of a format, the index of the ] that closes it (the last ] before the next [), or -1; one pass. */
function closingBrackets(format) {
	const closes = new Map();
	let open = -1;
	for (let i = 0; i < format.length; i++) {
		if (format[i] === '[') {
			open = i;
			closes.set(i, -1);
		} else if (format[i] === ']' && open !== -1) closes.set(open, i);
	}
	return closes;
}

/** The parts of a format with the source text `raw` of each text part, which parseDate reads its own way. */
function split(format) {
	const out = [];
	const closes = closingBrackets(format);
	let i = 0;
	while (i < format.length) {
		const ch = format[i];
		const end = ch === '[' ? closes.get(i) : -1;
		const token = end === -1 && ch !== '\\' ? tokenAt(format, i) : undefined;
		if (token) {
			out.push({ token });
			i += token.length;
			continue;
		}
		let raw = ch;
		let text = ch;
		if (end !== -1) {
			raw = format.slice(i, end + 1);
			text = raw.slice(1, -1);
		} else if (ch === '\\') {
			raw = ch + (tokenAt(format, i + 1) || format.charAt(i + 1));
			text = raw.replace(/\\/g, '');
		}
		out.push({ text, raw });
		i += raw.length;
	}
	return out;
}

/** Splits a format into tokens and text: [text] is literal text (see closingBrackets), a backslash escapes the next token or character. */
const tokenize = (format) => split(format).map((p) => (p.token ? { token: p.token } : { text: p.text }));

/**
 * The format with each localized token replaced by its format as text, outside [brackets] and escapes, before the
 * format is split: an expansion joins the letters next to it, as in the engine ("MMMlll" holds "MMMMMM D, YYYY").
 */
const expandLocalized = (format) => format.replace(/(\[[^[]*\])|(\\)?(LTS|LT|LL?L?L?|l{1,4})/g, (all, bracket, escape, token) => (bracket || escape ? all : LOCALIZED_FORMATS[token]));

function invalid(value, what) {
	const text = quoted(value);
	return new Error(text === null ? `Invalid ${what}.` : `'${text}' is not a valid ${what}.`);
}

function noMatch(value) {
	const text = quoted(value);
	return new Error(text === null ? 'Invalid date.' : `'${text}' is not a valid date or does not match the date format.`);
}

const isNumberLike = (v) => typeof v === 'number' || (typeof v === 'string' && isDecimalText(v));
const isPlainText = (v) => typeof v === 'string' && !isDecimalText(v);
const absRound = (n) => (n < 0 ? -Math.round(-n) : Math.round(n));
const clip = (text, max) => text.slice(0, max);

const isDigit = (c) => c >= '0' && c <= '9';
const isSpace = (c) => c !== undefined && /\s/.test(c);
const allDigits = (text) => text.length > 0 && [...text].every(isDigit);
/** True when the text ends with the ASCII word, in any letter case. */
const endsWithWord = (text, word) => text.length >= word.length && text.slice(-word.length).toLowerCase() === word;

/** A reader that moves through a text: runs of digits, single characters and white space. */
function cursor(text) {
	let at = 0;
	return {
		/** A run of `min` to `max` digits as a number, or null (and the position stays) when fewer than `min` follow. */
		digits(min, max) {
			let end = at;
			while (end < text.length && end - at < max && isDigit(text[end])) end++;
			if (end - at < min) return null;
			const run = text.slice(at, end);
			at = end;
			return run;
		},
		/** The next character when `chars` holds it, else null. */
		one(chars) {
			return at < text.length && chars.includes(text[at]) ? text[at++] : null;
		},
		/** Skips `most` white space characters (all with Infinity). */
		space(most = Infinity) {
			for (let n = 0; n < most && isSpace(text[at]); n++) at++;
		},
		done: () => at >= text.length,
		rest: () => text.slice(at),
	};
}

/**
 * The date at the start of a text that parseDate reads without a format: YYYY-M-D (with - or /, then T or one white
 * space), D.M.YYYY (with . or -, a white space allowed after each), or M/D/YYYY. Returns the numbers and the rest of the
 * text, or null.
 */
function leadingDate(text) {
	const read = [
		(c) => {
			const year = c.digits(4, 4);
			const month = year && c.one('-/') && c.digits(1, 2);
			const day = month && c.one('-/') && c.digits(1, 2);
			if (day && !c.one('Tt')) c.space(1);
			return day && { year, month, day };
		},
		(c) => {
			const day = c.digits(1, 2);
			const month = day && c.one('.-') && (c.space(1), c.digits(1, 2));
			const year = month && c.one('.-') && (c.space(1), c.digits(4, 4));
			return year && { year, month, day };
		},
		(c) => {
			const month = c.digits(1, 2);
			const day = month && c.one('/') && c.digits(1, 2);
			const year = day && c.one('/') && c.digits(4, 4);
			return year && { year, month, day };
		},
	];
	for (const form of read) {
		const c = cursor(text);
		const date = form(c);
		if (date) {
			c.space();
			return { year: Number(date.year), month: Number(date.month), day: Number(date.day), rest: c.rest() };
		}
	}
	return null;
}

/** An offset at the end of a text, written +hh:mm or +hhmm (or with -), as { ms, length }, or null. */
function trailingOffset(text) {
	for (const length of [6, 5]) {
		const tail = text.slice(-length);
		const colon = length === 5 || tail[3] === ':';
		if (tail.length === length && (tail[0] === '+' || tail[0] === '-') && colon && allDigits(tail.slice(1, 3)) && allDigits(tail.slice(-2))) {
			const minutes = Number(tail.slice(1, 3)) * 60 + Number(tail.slice(-2));
			return { ms: (tail[0] === '-' ? -1 : 1) * minutes * MINUTE_MS, length };
		}
	}
	return null;
}

/** H:mm, H:mm:ss or H:mm:ss.fff (one or two digits each, any number of fraction digits), or null. */
function clock24(text) {
	const c = cursor(text);
	const hour = c.digits(1, 2);
	const minute = hour && c.one(':') && c.digits(1, 2);
	if (!minute) return null;
	let second = '0';
	let fraction = '';
	if (c.one(':')) {
		second = c.digits(1, 2);
		if (!second) return null;
		if (c.one('.')) {
			fraction = c.digits(1, Infinity);
			if (!fraction) return null;
		}
	}
	if (!c.done()) return null;
	const time = { hour: Number(hour), minute: Number(minute), second: Number(second), millisecond: Number(fraction.slice(0, 3).padEnd(3, '0')) };
	const midnight = time.hour === 24 && time.minute === 0 && time.second === 0 && time.millisecond === 0;
	return (time.hour > 23 && !midnight) || time.minute > 59 || time.second > 59 ? false : time;
}

/** H am, H:mm pm and the like (white space allowed before am or pm, any letter case), or null. */
function clock12(text) {
	const c = cursor(text);
	const hour = c.digits(1, 2);
	if (!hour) return null;
	let minute = '0';
	if (c.one(':')) {
		minute = c.digits(1, 2);
		if (!minute) return null;
	}
	c.space();
	const half = c.rest().toLowerCase();
	if (half !== 'am' && half !== 'pm') return null;
	const h = Number(hour);
	if (h > 12 || Number(minute) > 59) return false;
	return { hour: (h % 12) + (half === 'pm' ? 12 : 0), minute: Number(minute), second: 0, millisecond: 0 };
}

/**
 * The clock and offset after the date of such a text: an offset at the end, then Z, UTC or GMT (offset 0 unless an
 * offset other than 0 was given), then a 24-hour or 12-hour clock, or nothing for midnight. Null when anything else is
 * left, a value is out of range, or a line break is inside the clock (a probe of the engine reads no date there).
 */
function readClock(rest) {
	let text = rest.trim();
	if (/[\n\r\u2028\u2029]/.test(text)) return null;
	let offsetMs = null;
	const offset = trailingOffset(text);
	if (offset) {
		offsetMs = offset.ms;
		text = text.slice(0, -offset.length).trim();
	}
	const zone = ['z', 'utc', 'gmt'].find((word) => endsWithWord(text, word));
	if (zone) {
		if (!offsetMs) offsetMs = 0;
		text = text.slice(0, -zone.length).trim();
	}
	if (text === '') return { time: { hour: 0, minute: 0, second: 0, millisecond: 0 }, offsetMs };
	const time = clock24(text) ?? clock12(text);
	return time ? { time, offsetMs } : null;
}

/** The wall time and offset of a text in one of the forms the shim reads, or null. */
function readParts(text) {
	const date = leadingDate(text);
	if (!date) return null;
	const { year, month, day } = date;
	const clock = readClock(date.rest);
	if (!clock || year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
	return { wall: { year, month, day, ...clock.time }, offsetMs: clock.offsetMs };
}

const instantOfParts = (parts, zone) => (parts.offsetMs !== null ? utcOf(parts.wall) - parts.offsetMs : instantOf(parts.wall, zone));

/** A day or month name: its index, or -1. Names are full or three letters, in any letter case. */
function nameIndex(names, value) {
	if (typeof value !== 'string') return -1;
	const text = value.toLowerCase();
	return names.findIndex((n) => text === n.toLowerCase() || text === n.slice(0, 3).toLowerCase());
}

const toInt = (text) => {
	const n = Number(text);
	return n !== 0 && Number.isFinite(n) ? Math.trunc(n) : 0;
};
const twoDigitYear = (text) => toInt(text) + (toInt(text) > 68 ? 1900 : 2000);
const startIndex = (names, width, word) => names.findIndex((n) => word.toLowerCase().startsWith(n.slice(0, width).toLowerCase()));
const escapeText = (text) => new RegExp(text.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'));
/** The text a literal part of a parse format searches for: brackets and one backslash removed the engine's way. */
const unescapeRaw = (raw) => raw.replace('\\', '').replace(/\\(\[)|\\(\])|\[([^\][]*)\]|\\(.)/g, (all, open, close, inner, other) => open || close || inner || other);

const D1TO2 = /\d\d?/;
/** A name searched in the text: both runs stop at 256 as in the engine, which also keeps the search linear on a long run of digits. */
const WORD = /[0-9]{0,256}['a-z\u00A0-\u05FF\u0700-\uD7FF\uF900-\uFDCF\uFDF0-\uFF07\uFF10-\uFFEF]{1,256}/i;
const set = (field, read = toInt) => (s, v) => {
	s[field] = read(v);
};
/** A week field: w and W the week, gg and GG the week year, d, e and E the weekday. */
const weekPart = (field, read = toInt) => (s, v) => {
	s.w = { ...s.w, [field]: read(v) };
};
const month = (s, v) => {
	const i = startIndex(MONTH_NAMES, 3, v);
	if (i < 0) s.invalid = true;
	else s.month = i;
};
const weekday = (s, v) => {
	const i = startIndex(DAY_NAMES, 2, v);
	if (i < 0) s.invalid = true;
	else s.w = { ...s.w, d: i };
};
const fraction = set('millisecond', (v) => toInt(Number(`0.${v}`) * 1000));
const KHOUR = [D1TO2, set('hour', (v) => (toInt(v) === 24 ? 0 : toInt(v)))];
const HMM = [/\d\d\d\d?/, (s, v) => Object.assign(s, { hour: toInt(v.slice(0, -2)), minute: toInt(v.slice(-2)) })];
const HMMSS = [/\d\d\d\d\d\d?/, (s, v) => Object.assign(s, { hour: toInt(v.slice(0, -4)), minute: toInt(v.slice(-4, -2)), second: toInt(v.slice(-2)) })];
const MERIDIEM = [/[ap]\.?m?\.?/i, set('pm', (v) => v.toLowerCase().charAt(0) === 'p')];
const OFFSET = [/Z|[+-]\d\d(?::?\d\d)?/i, set('offsetMs', offsetOfText)];
/** An era name, only at the start of the rest of the text. */
const ERA = [/^(?:Anno Domini|AD|Before Christ|BC)/i, set('era', (v) => (/^a/i.test(v) ? 'AD' : 'BC'))];
const ERA_YEAR = [/\d+/, set('year')];

/** The parse rule of each token of a format: [pattern searched in the rest of the text, what the match sets]. */
const PARSERS = {
	YYYYYY: [/[+-]?\d{1,6}/, set('year')],
	YYYYY: [/[+-]?\d{1,6}/, set('year')],
	YYYY: [/\d{1,4}/, set('year', (v) => (v.length === 2 ? twoDigitYear(v) : toInt(v)))],
	YY: [D1TO2, set('year', twoDigitYear)],
	Y: [/[+-]?\d+/, set('year')],
	N: ERA,
	NN: ERA,
	NNN: ERA,
	NNNN: ERA,
	NNNNN: ERA,
	y: ERA_YEAR,
	yy: ERA_YEAR,
	yyy: ERA_YEAR,
	yyyy: ERA_YEAR,
	yo: [/\d+/, set('year', (v) => parseInt(v, 10))],
	Q: [/\d/, set('month', (v) => (toInt(v) - 1) * 3)],
	M: [D1TO2, set('month', (v) => toInt(v) - 1)],
	MM: [D1TO2, set('month', (v) => toInt(v) - 1)],
	MMM: [WORD, month],
	MMMM: [WORD, month],
	D: [D1TO2, set('date')],
	DD: [D1TO2, set('date')],
	Do: [/\d{1,2}(?:th|st|nd|rd)|\d{1,2}/, set('date', (v) => toInt(D1TO2.exec(v)[0]))],
	DDD: [/\d{1,3}/, set('dayOfYear')],
	DDDD: [/\d{3}/, set('dayOfYear')],
	d: [D1TO2, weekPart('d')],
	dd: [WORD, weekday],
	ddd: [WORD, weekday],
	dddd: [WORD, weekday],
	e: [D1TO2, weekPart('e')],
	E: [D1TO2, weekPart('E')],
	w: [D1TO2, weekPart('w')],
	ww: [D1TO2, weekPart('w')],
	W: [D1TO2, weekPart('W')],
	WW: [D1TO2, weekPart('W')],
	gg: [D1TO2, weekPart('gg', twoDigitYear)],
	gggg: [/\d{1,4}/, weekPart('gg')],
	ggggg: [/[+-]?\d{1,6}/, weekPart('gg')],
	GG: [D1TO2, weekPart('GG', twoDigitYear)],
	GGGG: [/\d{1,4}/, weekPart('GG')],
	GGGGG: [/[+-]?\d{1,6}/, weekPart('GG')],
	H: [D1TO2, set('hour')],
	HH: [D1TO2, set('hour')],
	h: [D1TO2, set('hour')],
	hh: [D1TO2, set('hour')],
	k: KHOUR,
	kk: KHOUR,
	Hmm: HMM,
	hmm: HMM,
	Hmmss: HMMSS,
	hmmss: HMMSS,
	a: MERIDIEM,
	A: MERIDIEM,
	m: [D1TO2, set('minute')],
	mm: [D1TO2, set('minute')],
	s: [D1TO2, set('second')],
	ss: [D1TO2, set('second')],
	S: [/\d{1,3}/, fraction],
	SS: [/\d{1,3}/, fraction],
	SSS: [/\d{1,3}/, fraction],
	Z: OFFSET,
	ZZ: OFFSET,
	X: [/[+-]?\d+(\.\d{1,3})?/, set('ts', (v) => new Date(parseFloat(v) * 1000).getTime())],
	x: [/[+-]?\d+/, set('ts', (v) => new Date(toInt(v)).getTime())],
};
for (let n = 4; n <= 9; n++) PARSERS['S'.repeat(n)] = [/\d+/, fraction];

function offsetOfText(text) {
	const parts = text.match(/[+-]|\d\d/g) || ['-', '0', '0'];
	const minutes = toInt(parts[1]) * 60 + toInt(parts[2]);
	return (parts[0] === '+' ? minutes : -minutes) * MINUTE_MS;
}

/**
 * True when a field is out of range. A missing field passes every check except 24:00, which needs minutes, seconds and
 * milliseconds of exactly 0 (with a timestamp token the engine checks the fields as parsed, without defaults).
 */
function outOfRange({ year, month, date, hour, minute, second, millisecond }) {
	if (month < 0 || month > 11 || date < 1 || date > daysInMonth(year, month + 1)) return true;
	return hour > 24 || (hour === 24 && (minute !== 0 || second !== 0 || millisecond !== 0)) || minute > 59 || second > 59;
}

const first = (...values) => values.find((v) => v !== undefined);

/** The first day of week 1: weeks start on weekday `dow`, and day `jan` of January is always in week 1. */
function weekOneStart(year, dow, jan) {
	const at = dateUtc(year, 1, jan);
	return at - ((new Date(at).getUTCDay() - dow + 7) % 7) * DAY_MS;
}

/**
 * The year and day of the year that the week fields name: ISO weeks when W, GG or E is given, else Sunday weeks with
 * week 1 holding 1 January. A missing week year comes from `year`, then from the week of `today`; a missing ISO week
 * and weekday are 1, a missing Sunday week is the week of `today` and a missing weekday is Sunday. Null when the week or
 * the weekday is out of range.
 */
function fromWeeks(w, year, today) {
	const iso = w.GG !== undefined || w.W !== undefined || w.E !== undefined;
	const current = iso ? isoWeek(today) : localWeek(today);
	const [dow, jan, low, high] = iso ? [1, 4, 1, 7] : [0, 1, 0, 6];
	const weekYear = first(iso ? w.GG : w.gg, year, current.year);
	const week = iso ? first(w.W, 1) : first(w.w, current.week);
	const day = iso ? first(w.E, 1) : first(w.d, w.e, 0);
	const start = weekOneStart(weekYear, dow, jan);
	const weeks = (weekOneStart(weekYear + 1, dow, jan) - start) / (7 * DAY_MS);
	if (week < 1 || week > weeks || day < low || day > high) return null;
	const at = new Date(start + ((week - 1) * 7 + ((day - dow + 7) % 7)) * DAY_MS);
	const atYear = at.getUTCFullYear();
	return { year: atYear, dayOfYear: dayOfYear({ year: atYear, month: at.getUTCMonth() + 1, day: at.getUTCDate() }) };
}

/**
 * parseDate with a format, read the engine's way: each part is searched anywhere in the rest of the text, trailing text
 * is ignored, missing time parts are 0, and missing date parts come from the UTC day of `nowMs` until the first given
 * part, then January and the first day; week fields without a month or day name the date by its week. Returns
 * { wall, offsetMs } or { ts, offsetMs }, or null when the text does not fit.
 */
function parseWithFormat(text, format, nowMs) {
	const s = {};
	let matched = false;
	let rest = text;
	for (const part of split(expandLocalized(format))) {
		const rule = PARSERS[part.token];
		let re = rule ? rule[0] : escapeText(part.token || unescapeRaw(part.raw));
		if (part.raw === 'g' || part.raw === 'G') re = /[+-]?\d+/;
		const m = re.exec(rest);
		if (!m || !m[0]) continue;
		rest = rest.slice(m.index + m[0].length);
		if (part.token === undefined) continue;
		matched = true;
		if (rule) rule[1](s, m[0], part.token);
	}
	const parsedParts = ['year', 'month', 'date', 'hour', 'minute', 'second', 'millisecond'].some((k) => s[k] !== undefined);
	if (!matched || s.invalid || (s.pm !== undefined && !parsedParts)) return null;
	if (s.pm !== undefined && s.hour !== undefined) {
		if (s.pm && s.hour < 12) s.hour += 12;
		else if (!s.pm && s.hour === 12) s.hour = 0;
	}
	if (s.era) {
		const year = first(s.year, 1);
		s.year = s.era === 'AD' ? year : 1 - year;
	}
	if (s.ts !== undefined) return Number.isNaN(s.ts) || outOfRange(s) ? null : { ts: s.ts, offsetMs: s.offsetMs };
	const today = local(nowMs, 'UTC').wall;
	if (s.w && s.month === undefined && s.date === undefined) {
		const byWeek = fromWeeks(s.w, s.year, today);
		if (!byWeek) return null;
		Object.assign(s, byWeek);
	}
	if (s.dayOfYear !== undefined) {
		const year = s.year === undefined ? today.year : s.year;
		if (s.dayOfYear === 0 || s.dayOfYear > dayOfYear({ year, month: 12, day: 31 })) return null;
		const d = new Date(dateUtc(year, 1, s.dayOfYear));
		Object.assign(s, { month: d.getUTCMonth(), date: d.getUTCDate() });
	}
	const ymd = [s.year, s.month, s.date];
	const now = [today.year, today.month - 1, today.day];
	let i = 0;
	for (; i < 3 && ymd[i] === undefined; i++) ymd[i] = now[i];
	for (; i < 3; i++) if (ymd[i] === undefined) ymd[i] = i === 2 ? 1 : 0;
	const [year, monthIndex, date] = ymd;
	const time = { hour: s.hour || 0, minute: s.minute || 0, second: s.second || 0, millisecond: s.millisecond || 0 };
	if (outOfRange({ year, month: monthIndex, date, ...time })) return null;
	const wall = { year, month: monthIndex + 1, day: date, ...time };
	if (s.w && s.w.d !== undefined && s.w.d !== new Date(utcOf(wall)).getUTCDay()) return null;
	return { wall, offsetMs: s.offsetMs };
}

/** ISO 8601 text as the engine reads it with an empty format: the extended form, then the basic form. */
const ISO_EXTENDED = /^\s*((?:[+-]\d{6}|\d{4})-(?:\d\d-\d\d|W\d\d-\d|W\d\d|\d{3}|\d\d))(?:([T ])(\d\d(?::\d\d(?::\d\d(?:[.,]\d+)?)?)?)([+-]\d\d(?::?\d\d)?|\s*Z)?)?$/;
const ISO_BASIC = /^\s*((?:[+-]\d{6}|\d{4})(?:\d{4}|W\d{3}|W\d\d|\d{3}|\d\d|))(?:([T ])(\d\d(?:\d\d(?:\d\d(?:[.,]\d+)?)?)?)([+-]\d\d(?::?\d\d)?|\s*Z)?)?$/;
/** The format of an ISO date part: the first form whose pattern occurs anywhere in it. */
const ISO_DATE_FORMS = [
	['YYYYYY-MM-DD', /[+-]\d{6}-\d\d-\d\d/],
	['YYYY-MM-DD', /\d{4}-\d\d-\d\d/],
	['GGGG-[W]WW-E', /\d{4}-W\d\d-\d/],
	['GGGG-[W]WW', /\d{4}-W\d\d/],
	['YYYY-DDD', /\d{4}-\d{3}/],
	['YYYY-MM', /\d{4}-\d\d/],
	['YYYYYYMMDD', /[+-]\d{10}/],
	['YYYYMMDD', /\d{8}/],
	['GGGG[W]WWE', /\d{4}W\d{3}/],
	['GGGG[W]WW', /\d{4}W\d\d/],
	['YYYYDDD', /\d{7}/],
	['YYYYMM', /\d{6}/],
	['YYYY', /\d{4}/],
];
const ISO_DATE_ONLY = new Set(['GGGG-[W]WW', 'YYYY-MM', 'GGGG[W]WW', 'YYYYMM', 'YYYY']);

/** The parse format of ISO 8601 text, or undefined when the text is not ISO or a date-only form has a time. */
function isoFormatOf(text) {
	const m = ISO_EXTENDED.exec(text) || ISO_BASIC.exec(text);
	if (!m) return undefined;
	const [form] = ISO_DATE_FORMS.find(([, re]) => re.test(m[1]));
	if (m[3] && ISO_DATE_ONLY.has(form)) return undefined;
	const time = m[3] ? m[2] + ['HH', 'mm', 'ss'].reduce((f, token) => f.replace(/\d\d/, token), m[3]).replace(/\d+$/, 'SSSS') : '';
	return form + time + (m[4] ? 'Z' : '');
}

const short = (names) => names.map((n) => n.slice(0, 3)).join('|');
const RFC_2822 = new RegExp(`^(?:(${short(DAY_NAMES)}),?\\s)?(\\d{1,2})\\s(${short(MONTH_NAMES)})\\s(\\d{2,4})\\s(\\d\\d):(\\d\\d)(?::(\\d\\d))?\\s(?:(UT|GMT|[ECMP][SD]T)|[Zz]|([+-]\\d{4}))$`);
const RFC_ZONE_HOURS = { UT: 0, GMT: 0, EDT: -4, EST: -5, CDT: -5, CST: -6, MDT: -6, MST: -7, PDT: -7, PST: -8 };

/**
 * RFC 2822 text (comments and extra white space taken out first) as { ts, offsetMs: 0 }, null when a field is out of
 * range or the weekday does not fit, undefined when the text is not in that form.
 */
function readRfc2822(text) {
	const m = RFC_2822.exec(text.replace(/\([^()]*\)|[\n\t]/g, ' ').replace(/\s\s+/g, ' ').trim());
	if (!m) return undefined;
	const [, dayName, day, monthName, yearText, hour, minute, second = '0', zone, offset] = m;
	const y = Number(yearText);
	const wall = { year: y <= 49 ? 2000 + y : y <= 999 ? 1900 + y : y, month: MONTH_NAMES.findIndex((n) => n.startsWith(monthName)) + 1, day: Number(day), hour: Number(hour), minute: Number(minute), second: Number(second), millisecond: 0 };
	if (wall.day < 1 || wall.day > daysInMonth(wall.year, wall.month) || wall.hour > 23 || wall.minute > 59 || wall.second > 59) return null;
	if (dayName && !DAY_NAMES[new Date(utcOf(wall)).getUTCDay()].startsWith(dayName)) return null;
	const hm = Number(offset || 0);
	const minutes = zone ? RFC_ZONE_HOURS[zone] * 60 : ((hm - (hm % 100)) / 100) * 60 + (hm % 100);
	return { ts: utcOf(wall) - minutes * MINUTE_MS, offsetMs: 0 };
}

/**
 * JavaScript's own reading of the text with " UTC" added, as the engine's last try. An open "(" starts a comment that
 * hides the suffix, and then the text is read in the computer's zone, so the clock is set to UTC, as the engine's is.
 */
function readInUtc(text) {
	const read = () => new Date(`${text} UTC`).getTime();
	const saved = process.env.TZ;
	if (!text.includes('(') || saved === 'UTC') return read();
	process.env.TZ = 'UTC';
	try {
		return read();
	} finally {
		if (saved === undefined) delete process.env.TZ;
		else process.env.TZ = saved;
	}
}

/** parseDate with an empty format, read as the engine reads it: /Date(ms)/, ISO 8601, RFC 2822, then readInUtc. */
function parseEmptyFormat(text, nowMs) {
	const asp = /^\/?Date\((-?\d+)/i.exec(text);
	if (asp) return { ts: Number(asp[1]), offsetMs: 0 };
	const iso = isoFormatOf(text);
	if (iso) return parseWithFormat(text, iso, nowMs);
	const rfc = readRfc2822(text);
	if (rfc !== undefined) return rfc;
	const ts = readInUtc(text);
	return Number.isNaN(ts) ? null : { ts, offsetMs: 0 };
}

/**
 * The date functions for one receiver: `zone` (a known zone), `manifest` (2 or higher: an empty input comes back as it
 * was; 1: it becomes null), `now()` (epoch ms) and `gap(fn, detail)` (throws).
 */
function createDateFunctions({ zone, manifest, now, gap }) {
	const empty = (value) => (manifest >= 2 ? value : null);

	/** Date text read without a format: Date, null (no digit) or a gap of `fn` (digits in no form the shim reads). */
	function readText(value, fn) {
		const text = value.trim();
		if (allDigits(text)) return new Date(Number(text));
		const parts = readParts(text);
		if (parts) return new Date(instantOfParts(parts, zone));
		if (/\d/.test(value)) throw gap(fn, `${fn === 'parseDate' ? 'without a format on' : 'with the date text'} "${clip(value, 40)}"`);
		return null;
	}

	/** The instant of a date input of formatDate, add* and set*; `fn` is the function called. */
	function instantArg(value, fn) {
		let date;
		if (value instanceof Date) date = value;
		else if (isNumberLike(value)) date = new Date(Number(value));
		else if (typeof value === 'string') date = readText(value, fn);
		else throw invalid(value, 'date');
		if (!date || Number.isNaN(date.getTime())) throw invalid(value, 'date');
		return date.getTime();
	}

	function amount(value, unit) {
		const n = Number(value);
		if (!isDecimalText(n)) throw invalid(value, `number of ${unit}`);
		return n;
	}

	/** A calendar change: the new wall time keeps the old offset first, then takes the offset at that instant. */
	function keepWall(ms, change) {
		const { wall, offsetMs } = local(ms, zone);
		const at = utcOf(change(wall));
		return new Date(Number.isNaN(at) ? NaN : at - offsetAt(at - offsetMs, zone));
	}

	/** A clock field change: the new wall time keeps the old offset. */
	function keepOffset(ms, change) {
		const { wall, offsetMs } = local(ms, zone);
		return new Date(utcOf(change(wall)) - offsetMs);
	}

	/**
	 * The wall time moved to month `index` (0-based, any number): the day is clamped to the length of that month first,
	 * computed the engine's way also for a fraction (1.5 counts 29.5 days), then both are cut to whole numbers.
	 */
	function withMonth(w, index) {
		const inYear = ((index % 12) + 12) % 12;
		const year = w.year + (index - inYear) / 12;
		const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
		const length = inYear === 1 ? (leap ? 29 : 28) : 31 - ((inYear % 7) % 2);
		return { ...w, month: Math.trunc(index) + 1, day: Math.trunc(Math.min(w.day, length)) };
	}

	/** Wraps the change of a date of function `fn`: the empty rule first, then the date input, then the amount. */
	const dateChange = (fn, change) => (value, n) => {
		if (value == null) return empty(value);
		return change(instantArg(value, fn), n);
	};

	function parseZone(tz) {
		if (!tz) return { zone, shiftMs: 0 };
		if (isNumberLike(tz)) return { zone: 'UTC', shiftMs: -parseFloat(tz) * HOUR_MS };
		if (typeof tz !== 'string') throw invalid(tz, 'time zone');
		return { zone: isKnownZone(tz) ? tz : 'UTC', shiftMs: 0 };
	}

	function formatDate(value, format, tz) {
		if (value == null) return empty(value);
		const ms = instantArg(value, 'formatDate');
		const text = format || DEFAULT_FORMAT;
		if (!isPlainText(text)) throw invalid(text, 'date format');
		let target = zone;
		if (tz) {
			if (!isPlainText(tz)) throw invalid(tz, 'time zone');
			target = isKnownZone(tz) ? tz : 'UTC';
		}
		const { wall, offsetMs } = local(ms, target);
		const context = { ...wall, ms, offsetMs };
		const zoneKnown = !tz || isKnownZone(tz);
		const chosen = text.trim() || (offsetMs === 0 && zoneKnown ? WHITESPACE_FORMAT_UTC : WHITESPACE_FORMAT);
		return tokenize(expandLocalized(chosen))
			.map((p) => {
				if (p.token === undefined) return p.text;
				if (p.token in LOCALIZED_FORMATS) return p.token;
				if (ZONE_NAME_TOKENS.includes(p.token)) throw gap('formatDate', `with the token "${p.token}"`);
				return FORMATTERS[p.token](context);
			})
			.join('');
	}

	function parseDate(value, format, tz) {
		if (value == null) return empty(value);
		if (value instanceof Date) return value;
		const numeric = isNumberLike(value);
		if (!numeric && typeof value !== 'string') throw invalid(value, 'date');
		if (!isPlainText(format)) {
			if (format != null) throw invalid(format, 'date format');
			return numeric ? new Date(value * 1000) : readText(value, 'parseDate');
		}
		if (numeric && format === 'X') return new Date(value * 1000);
		if (numeric && format === 'x') return new Date(Number(value));
		const text = String(value);
		const where = parseZone(tz);
		const parsed = format === '' ? parseEmptyFormat(text, now()) : parseWithFormat(text, format, now());
		if (!parsed) throw noMatch(value);
		let ms;
		if (parsed.ts !== undefined) ms = format === 'X' || format === 'x' || parsed.offsetMs !== undefined ? parsed.ts : instantOf(local(parsed.ts, 'UTC').wall, where.zone);
		else if (parsed.offsetMs !== undefined) ms = utcOf(parsed.wall) - parsed.offsetMs;
		else ms = instantOf(parsed.wall, where.zone);
		const date = new Date(ms + where.shiftMs);
		if (Number.isNaN(date.getTime())) throw noMatch(value);
		return date;
	}

	const days = (ms, n) => keepWall(ms, (w) => ({ ...w, day: w.day + n }));
	const months = (ms, n) => keepWall(ms, (w) => withMonth(w, w.month - 1 + n));

	return {
		formatDate,
		parseDate,
		addSeconds: dateChange('addSeconds', (ms, n) => new Date(ms + amount(n, 'seconds') * 1000)),
		addMinutes: dateChange('addMinutes', (ms, n) => new Date(ms + amount(n, 'minutes') * MINUTE_MS)),
		addHours: dateChange('addHours', (ms, n) => new Date(ms + amount(n, 'hours') * HOUR_MS)),
		addDays: dateChange('addDays', (ms, n) => days(ms, absRound(amount(n, 'days')))),
		addMonths: dateChange('addMonths', (ms, n) => months(ms, absRound(amount(n, 'months')))),
		addYears: dateChange('addYears', (ms, n) => months(ms, absRound(amount(n, 'years') * 12))),
		setSecond: dateChange('setSecond', (ms, n) => {
			const second = Math.trunc(amount(n, 'seconds'));
			return keepOffset(ms, (w) => ({ ...w, second }));
		}),
		setMinute: dateChange('setMinute', (ms, n) => {
			const minute = Math.trunc(amount(n, 'minutes'));
			return keepOffset(ms, (w) => ({ ...w, minute }));
		}),
		setHour: dateChange('setHour', (ms, n) => {
			const hour = Math.trunc(amount(n, 'hours'));
			return keepWall(ms, (w) => ({ ...w, hour }));
		}),
		setDay: dateChange('setDay', (ms, n) => {
			const named = nameIndex(DAY_NAMES, n);
			const target = named >= 0 ? named : amount(n, 'days') - 1;
			return days(ms, absRound(target - local(ms, zone).wall.weekday));
		}),
		setDate: dateChange('setDate', (ms, n) => {
			const day = Math.trunc(amount(n, 'days'));
			return keepWall(ms, (w) => ({ ...w, day }));
		}),
		setMonth: dateChange('setMonth', (ms, n) => {
			const named = nameIndex(MONTH_NAMES, n);
			const index = named >= 0 ? named : amount(n, 'months') - 1;
			return keepWall(ms, (w) => withMonth(w, index));
		}),
		setYear: dateChange('setYear', (ms, n) => {
			const year = Math.trunc(amount(n, 'years'));
			return keepWall(ms, (w) => ({ ...w, year, day: w.month === 2 && w.day === 29 ? daysInMonth(year, 2) : w.day }));
		}),
	};
}

module.exports = { DATE_FUNCTIONS, FORMAT_TOKENS, LOCALIZED_FORMATS, isKnownZone, wallClock, instantOf, tokenize, createDateFunctions };
