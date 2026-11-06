'use strict';
/**
 * The helpers of the plugin's IML shim (spec 3.1): the value checks and the message text that every built-in shares;
 * jwt on node:crypto for HS256, HS384, HS512, RS256, RS384, RS512, with the claims, header and error texts of the
 * public jsonwebtoken package as the engine uses it; and mime from a table of common extensions as the public mime
 * package answers them. Another algorithm, an option outside JWT_OPTIONS and an extension outside MIME_TABLE are gaps:
 * gap(fn, detail) throws.
 * Behaviour and messages follow the public jsonwebtoken, jws, ms and mime packages (MIT licensed; their notices are in
 * THIRD_PARTY_NOTICES.md in this folder).
 */
const crypto = require('crypto');

/** Text that is one decimal number: an optional minus, digits, and optionally a point with more digits. */
const DECIMAL_TEXT = /^-?[0-9]+(?:\.[0-9]+)?$/;
/** True when the value, read as text, is a decimal number; the built-ins take such text as a number. */
const isDecimalText = (value) => DECIMAL_TEXT.test(value);

const isByteStore = (v) => Buffer.isBuffer(v) || v instanceof ArrayBuffer || v instanceof SharedArrayBuffer;

/**
 * The type name the built-ins check: null, undefined, boolean, number (decimal text too), string, array, date, buffer
 * (bytes, or a view over bytes such as a typed array), object, or unknown for a function, a symbol and a bigint.
 */
function typeName(value) {
	if (value === null) return 'null';
	const type = typeof value;
	if (type === 'string') return isDecimalText(value) ? 'number' : 'string';
	if (type === 'object') {
		if (Array.isArray(value)) return 'array';
		if (value instanceof Date) return 'date';
		return isByteStore(value) || isByteStore(value.buffer) ? 'buffer' : 'object';
	}
	return type === 'undefined' || type === 'boolean' || type === 'number' ? type : 'unknown';
}

/**
 * A value as an error message of a built-in quotes it: {empty} for null and undefined, {array}, {object} or {buffer}
 * for a structure, the ISO text of a date; null when the message leaves the value out (text over 100 characters, a
 * function, a symbol, a bigint).
 */
function quoted(value) {
	const type = typeName(value);
	if (type === 'null' || type === 'undefined') return '{empty}';
	if (type === 'string') return value.length > 100 ? null : value;
	if (type === 'number' || type === 'boolean') return String(value);
	if (type === 'date') return value.toISOString();
	return type === 'unknown' ? null : `{${type}}`;
}

const JWT_ALGORITHMS = Object.freeze(['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512']);
const JWT_OPTIONS = Object.freeze(['expiresIn', 'notBefore', 'audience', 'issuer', 'subject', 'jwtid', 'keyid', 'header', 'noTimestamp', 'algorithm']);

const MIME_TABLE = Object.freeze({
	json: 'application/json',
	txt: 'text/plain',
	html: 'text/html',
	htm: 'text/html',
	css: 'text/css',
	js: 'text/javascript',
	mjs: 'text/javascript',
	csv: 'text/csv',
	xml: 'application/xml',
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	ico: 'image/vnd.microsoft.icon',
	bmp: 'image/bmp',
	tif: 'image/tiff',
	tiff: 'image/tiff',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	avi: 'video/x-msvideo',
	zip: 'application/zip',
	gz: 'application/gzip',
	tar: 'application/x-tar',
	'7z': 'application/x-7z-compressed',
	rar: 'application/vnd.rar',
	doc: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ppt: 'application/vnd.ms-powerpoint',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	odt: 'application/vnd.oasis.opendocument.text',
	ods: 'application/vnd.oasis.opendocument.spreadsheet',
	odp: 'application/vnd.oasis.opendocument.presentation',
	rtf: 'application/rtf',
	md: 'text/markdown',
	yaml: 'text/yaml',
	yml: 'text/yaml',
	wasm: 'application/wasm',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
	eot: 'application/vnd.ms-fontobject',
	epub: 'application/epub+zip',
	ics: 'text/calendar',
	vcf: 'text/x-vcard',
	eml: 'message/rfc822',
});

const SECOND_MS = 1000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;
const UNIT_MS = new Map([
	...['', 'ms', 'msec', 'msecs', 'millisecond', 'milliseconds'].map((u) => [u, 1]),
	...['s', 'sec', 'secs', 'second', 'seconds'].map((u) => [u, SECOND_MS]),
	...['m', 'min', 'mins', 'minute', 'minutes'].map((u) => [u, 60 * SECOND_MS]),
	...['h', 'hr', 'hrs', 'hour', 'hours'].map((u) => [u, 60 * 60 * SECOND_MS]),
	...['d', 'day', 'days'].map((u) => [u, DAY_MS]),
	...['w', 'week', 'weeks'].map((u) => [u, 7 * DAY_MS]),
	...['y', 'yr', 'yrs', 'year', 'years'].map((u) => [u, DAY_MS * 365.25]),
]);

/** Seconds of a jwt time span: a number as it is; text in the form of the public ms package ('90' is 90 ms); else null. */
function parseDuration(value) {
	if (typeof value === 'number') return value;
	if (typeof value !== 'string' || value.length > 100) return null;
	const match = /^(-?\d*\.?\d+) *([a-z]*)$/i.exec(value);
	const unit = match && UNIT_MS.get(match[2].toLowerCase());
	return unit ? (parseFloat(match[1]) * unit) / SECOND_MS : null;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const isText = (v) => typeof v === 'string';
const OPTION_RULES = {
	expiresIn: [(v) => Number.isInteger(v) || (isText(v) && v !== ''), '"expiresIn" should be a number of seconds or string representing a timespan'],
	notBefore: [(v) => Number.isInteger(v) || (isText(v) && v !== ''), '"notBefore" should be a number of seconds or string representing a timespan'],
	audience: [(v) => isText(v) || Array.isArray(v), '"audience" must be a string or array'],
	header: [isPlainObject, '"header" must be an object'],
	issuer: [isText, '"issuer" must be a string'],
	subject: [isText, '"subject" must be a string'],
	jwtid: [isText, '"jwtid" must be a string'],
	keyid: [isText, '"keyid" must be a string'],
	noTimestamp: [(v) => typeof v === 'boolean', '"noTimestamp" must be a boolean'],
};
const FOR_OBJECT_PAYLOADS = ['expiresIn', 'notBefore', 'noTimestamp', 'audience', 'issuer', 'subject', 'jwtid'];
const OPTION_CLAIMS = [['audience', 'aud'], ['issuer', 'iss'], ['subject', 'sub'], ['jwtid', 'jti']];
const OTHER_KEY_ALGORITHMS = { ec: ['ES256', 'ES384', 'ES512'], 'rsa-pss': ['PS256', 'PS384', 'PS512'] };

function keyOf(secret) {
	try {
		return crypto.createPrivateKey(secret);
	} catch {
		try {
			return crypto.createSecretKey(isText(secret) ? Buffer.from(secret) : secret);
		} catch {
			throw new Error('secretOrPrivateKey is not valid key material');
		}
	}
}

function checkKey(alg, key) {
	if (alg.startsWith('HS')) {
		if (key.type !== 'secret') throw new Error(`secretOrPrivateKey must be a symmetric key when using ${alg}`);
		return;
	}
	if (key.type !== 'private') throw new Error(`secretOrPrivateKey must be an asymmetric key when using ${alg}`);
	if (key.asymmetricKeyDetails.modulusLength < 2048) throw new Error(`secretOrPrivateKey has a minimum key size of 2048 bits for ${alg}`);
}

function checkKeyType(alg, key) {
	const type = key.asymmetricKeyType;
	if (!type || type === 'rsa') return;
	const allowed = OTHER_KEY_ALGORITHMS[type];
	if (!allowed) throw new Error(`Unknown key type "${type}".`);
	throw new Error(`"alg" parameter for "${type}" key type must be one of: ${allowed.join(', ')}.`);
}

function timespan(value, timestamp, name) {
	if (typeof value === 'number') return timestamp + value;
	const seconds = parseDuration(value);
	if (seconds === null) throw new Error(`"${name}" should be a number of seconds or string representing a timespan eg: "1d", "20h", 60`);
	return Math.floor(timestamp + seconds);
}

/** iml.jwt(payload, secret, alg = 'HS256', options = {}): a signed token, or the error the engine throws. */
function jwt(args, { now, gap }) {
	const [payload, secret, algorithm = 'HS256', options = {}] = args;
	const settings = Object.assign({ algorithm }, options);
	const timestampAsked = Boolean(payload?.iat) || settings.noTimestamp !== undefined;
	if (!timestampAsked) settings.noTimestamp = true;
	if (!JWT_ALGORITHMS.includes(settings.algorithm)) throw gap('jwt', `with the algorithm "${settings.algorithm}"`);
	for (const key of Object.keys(settings)) if (!JWT_OPTIONS.includes(key)) throw gap('jwt', `with the option "${key}"`);
	const objectPayload = typeof payload === 'object' && !Buffer.isBuffer(payload);
	const header = { alg: settings.algorithm, typ: objectPayload ? 'JWT' : undefined, kid: settings.keyid, ...settings.header };
	if (!JWT_ALGORITHMS.includes(header.alg)) throw gap('jwt', `with the algorithm "${header.alg}"`);

	if (!secret) throw new Error('secretOrPrivateKey must have a value');
	const key = keyOf(secret);
	checkKey(header.alg, key);
	if (payload === undefined) throw new Error('payload is required');
	if (!objectPayload) {
		const set = FOR_OBJECT_PAYLOADS.filter((name) => settings[name] !== undefined);
		throw new Error(`invalid ${set.join(',')} option for ${typeof payload} payload`);
	}
	if (!isPlainObject(payload)) throw new Error('Expected "payload" to be a plain object.');
	for (const name of Object.keys(payload)) {
		if (['iat', 'exp', 'nbf'].includes(name) && typeof payload[name] !== 'number') throw new Error(`"${name}" should be a number of seconds`);
	}
	const claims = { ...payload };
	if (claims.exp !== undefined && settings.expiresIn !== undefined) throw new Error('Bad "options.expiresIn" option the payload already has an "exp" property.');
	if (claims.nbf !== undefined && settings.notBefore !== undefined) throw new Error('Bad "options.notBefore" option the payload already has an "nbf" property.');
	for (const name of Object.keys(settings)) {
		const rule = OPTION_RULES[name];
		if (rule && !rule[0](settings[name])) throw new Error(rule[1]);
	}
	checkKeyType(header.alg, key);

	const timestamp = claims.iat || Math.floor(now() / 1000);
	if (settings.noTimestamp) delete claims.iat;
	else claims.iat = timestamp;
	if (settings.notBefore !== undefined) claims.nbf = timespan(settings.notBefore, timestamp, 'notBefore');
	if (settings.expiresIn !== undefined) claims.exp = timespan(settings.expiresIn, timestamp, 'expiresIn');
	for (const [option, claim] of OPTION_CLAIMS) {
		if (settings[option] === undefined) continue;
		if (claims[claim] !== undefined) throw new Error(`Bad "options.${option}" option. The payload already has an "${claim}" property.`);
		claims[claim] = settings[option];
	}

	const input = `${Buffer.from(JSON.stringify(header), 'latin1').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
	const digest = `sha${header.alg.slice(2)}`;
	const signature = header.alg.startsWith('HS') ? crypto.createHmac(digest, key).update(input).digest() : crypto.sign(digest, Buffer.from(input), key);
	return `${input}.${signature.toString('base64url')}`;
}

/** iml.mime(name): the type of a file name, a path or a bare extension, as the public mime package reads it. */
function mimeType(name, { gap }) {
	if (!isText(name)) return undefined;
	const last = name.replace(/^.*[/\\]/s, '').toLowerCase();
	const ext = last.replace(/^.*\./s, '');
	const inPath = last.length < name.length;
	const dotted = ext.length < last.length - 1;
	if ((inPath && !dotted) || ext === '') return undefined;
	if (Object.hasOwn(MIME_TABLE, ext)) return MIME_TABLE[ext];
	throw gap('mime', `for the extension "${ext}"`);
}

module.exports = { JWT_ALGORITHMS, JWT_OPTIONS, MIME_TABLE, isDecimalText, typeName, quoted, parseDuration, jwt, mimeType };
