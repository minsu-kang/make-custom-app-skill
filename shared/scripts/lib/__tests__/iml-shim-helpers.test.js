const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('../iml-shim-helpers');

const NOW = Date.parse('2026-07-15T10:30:00.000Z');
const gap = (fn, detail) => { throw Object.assign(new Error(`gap ${fn} ${detail}`), { isGap: true, fn, detail }); };
const parts = (token) => token.split('.').map((p, i) => (i < 2 ? JSON.parse(Buffer.from(p, 'base64url').toString()) : p));

const IAT = Math.floor(NOW / 1000);
const sign = (...args) => h.jwt(args, { now: () => NOW, gap });
const header = (...args) => parts(sign(...args))[0];
const claims = (...args) => parts(sign(...args))[1];

describe('jwt', () => {
	it('signs HS256 with a header of alg and typ and no iat by default', () => {
		const [header, payload, sig] = parts(h.jwt([{ sub: '1' }, 'test-secret'], { now: () => NOW, gap }));
		assert.deepEqual(header, { alg: 'HS256', typ: 'JWT' });
		assert.deepEqual(payload, { sub: '1' });
		const expected = crypto.createHmac('sha256', 'test-secret').update(h.jwt([{ sub: '1' }, 'test-secret'], { now: () => NOW, gap }).split('.').slice(0, 2).join('.')).digest('base64url');
		assert.equal(sig, expected);
	});

	it('signs RS256, RS384 and RS512 with a key pair made in the test, so that the public key verifies them', () => {
		const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
		const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
		for (const [alg, hash] of [['RS256', 'sha256'], ['RS384', 'sha384'], ['RS512', 'sha512']]) {
			const token = h.jwt([{ a: 1 }, pem, alg], { now: () => NOW, gap });
			const [head, body, sig] = token.split('.');
			assert.equal(crypto.verify(hash, Buffer.from(`${head}.${body}`), publicKey, Buffer.from(sig, 'base64url')), true, alg);
			assert.equal(parts(token)[0].alg, alg);
		}
	});

	it('adds exp from expiresIn as seconds or as text, iat only with noTimestamp false', () => {
		const iat = Math.floor(NOW / 1000);
		assert.equal(parts(h.jwt([{}, 's', 'HS256', { expiresIn: 3600 }], { now: () => NOW, gap }))[1].exp, iat + 3600);
		assert.equal(parts(h.jwt([{}, 's', 'HS256', { expiresIn: '1h' }], { now: () => NOW, gap }))[1].exp, iat + 3600);
		assert.equal(parts(h.jwt([{}, 's', 'HS256', { noTimestamp: false }], { now: () => NOW, gap }))[1].iat, iat);
	});

	it('marks another algorithm and an option outside the list as gaps', () => {
		assert.throws(() => h.jwt([{}, 's', 'ES256'], { now: () => NOW, gap }), { isGap: true, detail: 'with the algorithm "ES256"' });
		assert.throws(() => h.jwt([{}, 's', 'HS256', { allowInsecureKeySizes: true }], { now: () => NOW, gap }), { isGap: true, detail: 'with the option "allowInsecureKeySizes"' });
	});

	it('puts the claims after the payload in the order iat, nbf, exp, aud, iss, sub, jti', () => {
		const all = { expiresIn: 60, notBefore: 10, audience: 'a', issuer: 'i', subject: 's', jwtid: 'j', noTimestamp: false };
		assert.deepEqual(Object.keys(claims({ x: 1 }, 's', 'HS256', all)), ['x', 'iat', 'nbf', 'exp', 'aud', 'iss', 'sub', 'jti']);
	});

	it('adds nbf, aud, iss, sub and jti from their options', () => {
		assert.equal(claims({}, 's', 'HS256', { notBefore: 60 }).nbf, IAT + 60);
		assert.equal(claims({}, 's', 'HS256', { notBefore: '2m' }).nbf, IAT + 120);
		assert.deepEqual(claims({}, 's', 'HS256', { audience: ['a', 'b'] }).aud, ['a', 'b']);
		assert.equal(claims({}, 's', 'HS256', { issuer: 'iss-1' }).iss, 'iss-1');
		assert.equal(claims({}, 's', 'HS256', { subject: 'sub-1' }).sub, 'sub-1');
		assert.equal(claims({}, 's', 'HS256', { jwtid: 'id-1' }).jti, 'id-1');
	});

	it('takes kid from keyid, and options.header wins over it and over alg', () => {
		assert.deepEqual(header({}, 's', 'HS256', { keyid: 'k1' }), { alg: 'HS256', typ: 'JWT', kid: 'k1' });
		assert.deepEqual(header({}, 's', 'HS256', { keyid: 'k1', header: { kid: 'h' } }), { alg: 'HS256', typ: 'JWT', kid: 'h' });
		assert.deepEqual(header({}, 's', 'HS256', { header: { alg: 'HS512' } }), { alg: 'HS512', typ: 'JWT' });
		assert.equal(header({}, 's', 'HS256', { algorithm: 'HS384' }).alg, 'HS384');
		assert.throws(() => sign({}, 's', 'HS256', { header: { alg: 'none' } }), { isGap: true, detail: 'with the algorithm "none"' });
	});

	it('keeps an iat of the payload and counts expiresIn from it; noTimestamp true removes it', () => {
		assert.deepEqual(claims({ iat: 1700000000 }, 's', 'HS256', { expiresIn: 10 }), { iat: 1700000000, exp: 1700000010 });
		assert.deepEqual(claims({ iat: 1700000000 }, 's', 'HS256', { noTimestamp: true }), {});
		assert.equal(claims({ iat: 1.5 }, 's', 'HS256', { expiresIn: 1 }).exp, 2.5);
		assert.equal(claims({}, 's', 'HS256', { expiresIn: '1.5s' }).exp, IAT + 1);
	});

	it('refuses a text payload, an empty secret and a missing payload with the engine messages', () => {
		assert.throws(() => sign('hello', 's'), { message: 'invalid noTimestamp option for string payload' });
		assert.throws(() => sign('hello', 's', 'HS256', { expiresIn: 1, subject: 'x' }), { message: 'invalid expiresIn,noTimestamp,subject option for string payload' });
		assert.throws(() => sign(Buffer.from('x'), 's'), { message: 'invalid noTimestamp option for object payload' });
		assert.throws(() => sign({}, ''), { message: 'secretOrPrivateKey must have a value' });
		assert.throws(() => sign(undefined, 's'), { message: 'payload is required' });
		assert.throws(() => sign(null, 's'), { message: 'Expected "payload" to be a plain object.' });
		assert.throws(() => sign([1], 's'), { message: 'Expected "payload" to be a plain object.' });
		assert.throws(() => sign({ exp: 'x' }, 's'), { message: '"exp" should be a number of seconds' });
	});

	it('refuses a claim that the payload already has', () => {
		assert.throws(() => sign({ exp: 1 }, 's', 'HS256', { expiresIn: 1 }), { message: 'Bad "options.expiresIn" option the payload already has an "exp" property.' });
		assert.throws(() => sign({ nbf: 1 }, 's', 'HS256', { notBefore: 1 }), { message: 'Bad "options.notBefore" option the payload already has an "nbf" property.' });
		assert.throws(() => sign({ aud: 'x' }, 's', 'HS256', { audience: 'y' }), { message: 'Bad "options.audience" option. The payload already has an "aud" property.' });
	});

	it('refuses option values of the wrong type with the engine messages', () => {
		const cases = [
			[{ expiresIn: 1.5 }, '"expiresIn" should be a number of seconds or string representing a timespan'],
			[{ notBefore: '' }, '"notBefore" should be a number of seconds or string representing a timespan'],
			[{ audience: 1 }, '"audience" must be a string or array'],
			[{ header: 'x' }, '"header" must be an object'],
			[{ issuer: 1 }, '"issuer" must be a string'],
			[{ keyid: 1 }, '"keyid" must be a string'],
			[{ noTimestamp: 'yes' }, '"noTimestamp" must be a boolean'],
			[{ expiresIn: 'soon' }, '"expiresIn" should be a number of seconds or string representing a timespan eg: "1d", "20h", 60'],
			[{ notBefore: 'later' }, '"notBefore" should be a number of seconds or string representing a timespan eg: "1d", "20h", 60'],
		];
		for (const [options, message] of cases) assert.throws(() => sign({}, 's', 'HS256', options), { message }, JSON.stringify(options));
	});

	it('refuses key material that does not fit the algorithm', () => {
		const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
		const small = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
		const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
		const ed = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
		assert.throws(() => sign({}, rsa, 'HS256'), { message: 'secretOrPrivateKey must be a symmetric key when using HS256' });
		assert.throws(() => sign({}, 'plain', 'RS256'), { message: 'secretOrPrivateKey must be an asymmetric key when using RS256' });
		assert.throws(() => sign({}, small, 'RS256'), { message: 'secretOrPrivateKey has a minimum key size of 2048 bits for RS256' });
		assert.throws(() => sign({}, ec, 'RS256'), { message: '"alg" parameter for "ec" key type must be one of: ES256, ES384, ES512.' });
		assert.throws(() => sign({}, ed, 'RS256'), { message: 'Unknown key type "ed25519".' });
		assert.throws(() => sign({}, 12, 'HS256'), { message: 'secretOrPrivateKey is not valid key material' });
		assert.equal(parts(sign({}, Buffer.from('raw'), 'HS512'))[0].alg, 'HS512');
	});
});

describe('parseDuration', () => {
	it('reads seconds from a number and the ms text forms, and null from anything else', () => {
		assert.equal(h.parseDuration(90), 90);
		const cases = [['90', 0.09], ['10s', 10], ['2m', 120], ['1h', 3600], ['1.5h', 5400], ['2 days', 172800], ['1w', 604800], ['1y', 31557600], ['-1d', -86400], ['.5 Mins', 30], ['3 hrs', 10800], ['250ms', 0.25]];
		for (const [text, seconds] of cases) assert.equal(h.parseDuration(text), seconds, text);
		for (const bad of ['', 'soon', '1 fortnight', '1.h', `${'1'.repeat(101)}`, true, null, {}]) assert.equal(h.parseDuration(bad), null, String(bad));
	});
});

describe('mime', () => {
	it('reads a file name, a path or a bare extension in any case, and gives undefined for an empty name', () => {
		assert.equal(h.mimeType('REPORT.PDF', { gap }), 'application/pdf');
		assert.equal(h.mimeType('/tmp/a/b.png', { gap }), 'image/png');
		assert.equal(h.mimeType('json', { gap }), 'application/json');
		assert.equal(h.mimeType('', { gap }), undefined);
		assert.equal(h.mimeType(null, { gap }), undefined);
	});

	it('marks an extension outside the table as a gap', () => {
		assert.throws(() => h.mimeType('file.xyz123', { gap }), { isGap: true, detail: 'for the extension "xyz123"' });
	});

	it('answers undefined, as the mime package does, for a path whose last part has no extension, and for a trailing dot', () => {
		assert.equal(h.mimeType('C:\\docs\\a.TXT', { gap }), 'text/plain');
		assert.equal(h.mimeType('.json', { gap }), 'application/json');
		assert.equal(h.mimeType('/tmp/json', { gap }), undefined);
		assert.equal(h.mimeType('/tmp/.json', { gap }), undefined);
		assert.equal(h.mimeType('file.', { gap }), undefined);
		assert.equal(h.mimeType(12, { gap }), undefined);
	});

	it('holds the recorded types and the fixed lists', () => {
		assert.equal(Object.keys(h.MIME_TABLE).length, 55);
		assert.equal(h.MIME_TABLE.docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
		assert.ok(Object.isFrozen(h.MIME_TABLE) && Object.isFrozen(h.JWT_ALGORITHMS) && Object.isFrozen(h.JWT_OPTIONS));
		assert.deepEqual(h.JWT_ALGORITHMS, ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512']);
		assert.deepEqual(h.JWT_OPTIONS, ['expiresIn', 'notBefore', 'audience', 'issuer', 'subject', 'jwtid', 'keyid', 'header', 'noTimestamp', 'algorithm']);
	});
});
