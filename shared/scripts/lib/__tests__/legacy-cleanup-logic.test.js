/**
 * Tests for legacy-cleanup-logic.js: the text and JSON transforms of the cleanup and its one error formatter.
 * The file moves HOME and the temp folders into a temporary root first (isolate-home). The functions under test are
 * pure, so every case runs on strings; only fake values are used (FAKE), never a real key.
 */
const { assertIsolated } = require('./isolate-home');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
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
	rendersExactly,
} = require('../legacy-cleanup-logic');
const { SENTINEL_OPEN, SENTINEL_CLOSE } = require('../legacy-install');
const { FAKE, INSTALLER_BLOCK, INSTALLER_ENV_TEXT } = require('./fake-legacy-home');

const CRLF_BLOCK = INSTALLER_BLOCK.replace(/\n/g, '\r\n');
/** Text with an accented letter (2 bytes in UTF-8) and an emoji (2 code units, 4 bytes), so a count in bytes differs from a count in code units. */
const NON_ASCII_PREFIX = '\u00fcn\u00ef \uD83D\uDE00';
const SECRETS = { 'pinecone-api-key': FAKE.pinecone, 'openai-api-key': FAKE.openai, 'pinecone-index-name': FAKE.index };
const secretValue = (key) => (Object.hasOwn(SECRETS, key) ? SECRETS[key] : null);

/** The block that findSentinelBlock reports for `text`, the text without it, and the step record a manifest would hold. */
function cut(text) {
	const block = findSentinelBlock(text);
	const after = removeBlock(text, block);
	return { block, after, step: { offset: block.offset, removedText: block.removedText, sha256After: sha256(after) } };
}

describe('the test process', () => {
	it('the test process sees a temporary home', () => {
		assertIsolated();
	});
});

describe('canonicalJson and sha256', () => {
	it('canonicalJson sorts keys at every level', () => {
		const value = { b: 1, a: { d: [{ z: 1, y: [{ n: 2, m: null }] }, 3], c: 'x' }, '10': true, '9': false };
		assert.equal(canonicalJson(value), '{"10":true,"9":false,"a":{"c":"x","d":[{"y":[{"m":null,"n":2}],"z":1},3]},"b":1}');
		assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
	});

	it('canonicalJson keeps array order, drops undefined members, and writes null for undefined items', () => {
		assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
		assert.equal(canonicalJson({ a: undefined, b: 1, c: () => 1 }), '{"b":1}');
		assert.equal(canonicalJson([undefined, 'x']), '[null,"x"]');
		assert.equal(canonicalJson('text'), '"text"');
		assert.equal(canonicalJson(undefined), 'null');
	});

	it('canonicalJson keeps an own member named __proto__', () => {
		const parsed = JSON.parse('{"z":1,"__proto__":{"x":1},"a":2}');
		assert.equal(canonicalJson(parsed), '{"__proto__":{"x":1},"a":2,"z":1}');
	});

	it('sha256 gives the hex digest of the UTF-8 text', () => {
		assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		assert.equal(sha256('\u00e9'), '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
	});
});

describe('describeError', () => {
	it('describeError: a SyntaxError whose message quotes a fake secret gives only the path; an fs error gives the code and the path; anything else gives the fixed text', () => {
		const secret = FAKE.pinecone;
		const file = path.join(os.tmpdir(), 'config.json');

		let real;
		try {
			JSON.parse(`{"PINECONE_API_KEY": ${secret}}`);
		} catch (err) {
			real = err;
		}
		assert.ok(real instanceof SyntaxError);
		const synthetic = new SyntaxError(`Unexpected token near "${secret}"`);
		for (const err of [real, synthetic]) {
			const text = describeError(err, file);
			assert.equal(text, `${file} is not valid JSON`);
			assert.ok(!text.includes(secret));
		}

		let missing;
		try {
			fs.readFileSync(path.join(os.tmpdir(), 'does-not-exist.json'));
		} catch (err) {
			missing = err;
		}
		assert.equal(describeError(missing, file), `ENOENT on ${file}`);
		const leaky = Object.assign(new Error(`cannot read ${secret}`), { code: 'EACCES' });
		assert.equal(describeError(leaky, file), `EACCES on ${file}`);

		const fixed = 'an unexpected error occurred';
		assert.equal(describeError(new Error(secret), file), fixed);
		assert.equal(describeError(new TypeError(secret), file), fixed);
		assert.equal(describeError(Object.assign(new Error(secret), { code: 42 }), file), fixed);
		assert.equal(describeError(secret, file), fixed);
		assert.equal(describeError(undefined, file), fixed);
		assert.equal(describeError(null, file), fixed);
		assert.equal(describeError({ message: secret }, file), fixed);
	});

	it('describeError never shows a secret that sits in a nested cause or an AggregateError', () => {
		const secret = FAKE.openai;
		const file = '/p/mcp.json';
		const nested = new Error(`outer ${secret}`, { cause: new SyntaxError(`inner ${secret}`) });
		const aggregate = new AggregateError([new SyntaxError(`one ${secret}`), new Error(`two ${secret}`)], `many ${secret}`);
		const wrapped = new Error('wrapper', { cause: aggregate });
		for (const err of [nested, aggregate, wrapped]) {
			const text = describeError(err, file);
			assert.equal(text, 'an unexpected error occurred');
			assert.ok(!text.includes(secret));
		}
	});

	it('describeError shows a code only for an Error with an upper-case code of 2 to 64 characters, and never throws', () => {
		const file = '/p/f.json';
		const fixed = 'an unexpected error occurred';
		const withCode = (code) => Object.assign(new Error('x'), { code });
		assert.equal(describeError(withCode('ENOENT'), file), `ENOENT on ${file}`);
		assert.equal(describeError(withCode('ERR_INVALID_ARG_TYPE'), file), `ERR_INVALID_ARG_TYPE on ${file}`);
		assert.equal(describeError(withCode('E2'), file), `E2 on ${file}`);
		assert.equal(describeError(withCode(`A${'B'.repeat(63)}`), file), `A${'B'.repeat(63)} on ${file}`);
		assert.equal(describeError(Object.assign(new TypeError('x'), { code: 'ERR_X' }), file), `ERR_X on ${file}`);
		const long = 'A'.repeat(100000);
		for (const code of ['E', `A${'B'.repeat(64)}`, long, 'enoent', FAKE.pinecone, 'ERR-X', '_ERR', '1ERR', 'ERR X', 'ERR\n', 'ENOENT\n', '', 'EN\u00d6']) {
			assert.equal(describeError(withCode(code), file), fixed, code.slice(0, 12));
		}
		assert.equal(describeError({ code: 'ENOENT' }, file), fixed);
		assert.equal(describeError({ code: FAKE.pinecone }, file), fixed);
		assert.equal(describeError({ code: { toString: () => 'ENOENT' } }, file), fixed);
		assert.equal(describeError(Object.assign(new Error('x'), { code: { toString: () => 'ENOENT' } }), file), fixed);
	});

	it('describeError does not throw for a hostile error object and does not read a getter twice', () => {
		const file = '/p/f.json';
		const fixed = 'an unexpected error occurred';
		const throwing = new Error('x');
		Object.defineProperty(throwing, 'code', {
			get() {
				throw new Error(FAKE.pinecone);
			},
		});
		assert.equal(describeError(throwing, file), fixed);
		const proxy = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error(FAKE.pinecone);
				},
			},
		);
		assert.equal(describeError(proxy, file), fixed);
		const hostilePath = {
			toString() {
				throw new Error(FAKE.pinecone);
			},
		};
		assert.equal(describeError(new SyntaxError('x'), hostilePath), fixed);
		let reads = 0;
		const changing = new Error('x');
		Object.defineProperty(changing, 'code', {
			get() {
				reads++;
				return reads === 1 ? 'ENOENT' : FAKE.pinecone;
			},
		});
		assert.equal(describeError(changing, file), `ENOENT on ${file}`);
		assert.equal(reads, 1);
	});

	it('the module never reads an error message or a stack', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', 'legacy-cleanup-logic.js'), 'utf8');
		assert.doesNotMatch(source, /\.(message|stack)\b/);
	});

	it('the module source is plain ASCII, so no invisible character such as a byte order mark sits in a string', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', 'legacy-cleanup-logic.js'), 'utf8');
		assert.doesNotMatch(source, /[^\x00-\x7F]/);
		assert.ok(source.includes("'\\uFEFF'"));
	});

	it('the module needs only crypto, the old-install markers, and the placeholder rule, and reads no process state', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', 'legacy-cleanup-logic.js'), 'utf8');
		const required = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]).sort();
		assert.deepEqual(required, ['./legacy-install', './settings', 'crypto']);
		assert.doesNotMatch(source, /\bprocess\b/);
	});
});

describe('findSentinelBlock, removeBlock, restoreBlock', () => {
	it('INSTALLER_BLOCK_BODY is the text between the markers of the installer block', () => {
		const lines = INSTALLER_BLOCK.split('\n');
		assert.equal(lines[0], SENTINEL_OPEN);
		assert.equal(lines[lines.length - 1], SENTINEL_CLOSE);
		assert.equal(INSTALLER_BLOCK_BODY, lines.slice(1, -1).join('\n').trim());
		assert.ok(!INSTALLER_BLOCK_BODY.includes('\r'));
		assert.ok(INSTALLER_BLOCK_BODY.startsWith('# Make Custom App Skill'));
	});

	it('findSentinelBlock: none, ok, unclosed, reversed, multiple; edited true and false; CRLF', () => {
		const none = { status: 'none', offset: null, removedText: null, lineStart: null, lineEnd: null, edited: false };
		assert.deepEqual(findSentinelBlock(''), none);
		assert.deepEqual(findSentinelBlock('just notes\nmore notes\n'), none);
		assert.deepEqual(findSentinelBlock(`notes\n${SENTINEL_CLOSE}\n`), none);
		assert.deepEqual(findSentinelBlock(`notes ${SENTINEL_OPEN} inline\n`), none);

		const ok = findSentinelBlock(`notes\n\n${INSTALLER_BLOCK}\n`);
		assert.deepEqual(ok, { status: 'ok', offset: 6, removedText: `\n${INSTALLER_BLOCK}\n`, lineStart: 3, lineEnd: 7, edited: false });

		const first = findSentinelBlock(`${INSTALLER_BLOCK}\n`);
		assert.deepEqual(first, { status: 'ok', offset: 0, removedText: `${INSTALLER_BLOCK}\n`, lineStart: 1, lineEnd: 5, edited: false });

		const noBlank = findSentinelBlock(`notes\n${INSTALLER_BLOCK}\n`);
		assert.deepEqual(noBlank, { status: 'ok', offset: 6, removedText: `${INSTALLER_BLOCK}\n`, lineStart: 2, lineEnd: 6, edited: false });

		const noFinalNewline = findSentinelBlock(`notes\n\n${INSTALLER_BLOCK}`);
		assert.equal(noFinalNewline.status, 'ok');
		assert.equal(noFinalNewline.removedText, `\n${INSTALLER_BLOCK}`);

		const withTail = findSentinelBlock(`notes\n\n${INSTALLER_BLOCK}\n\ntail\n`);
		assert.equal(withTail.removedText, `\n${INSTALLER_BLOCK}\n`);
		assert.equal(withTail.lineEnd, 7);

		const spaced = findSentinelBlock(`  ${SENTINEL_OPEN}  \nbody\n\t${SENTINEL_CLOSE} \n`);
		assert.equal(spaced.status, 'ok');
		assert.equal(spaced.lineStart, 1);
		assert.equal(spaced.lineEnd, 3);
		assert.equal(spaced.edited, true);

		const crlf = findSentinelBlock(`notes\r\n\r\n${CRLF_BLOCK}\r\n`);
		assert.deepEqual(crlf, { status: 'ok', offset: 7, removedText: `\r\n${CRLF_BLOCK}\r\n`, lineStart: 3, lineEnd: 7, edited: false });

		const unclosed = { status: 'unclosed', offset: null, removedText: null, lineStart: null, lineEnd: null, edited: false };
		assert.deepEqual(findSentinelBlock(`notes\n${SENTINEL_OPEN}\n# Make Custom App Skill\n`), unclosed);
		const reversed = { ...unclosed, status: 'reversed' };
		assert.deepEqual(findSentinelBlock(`${SENTINEL_CLOSE}\nmiddle\n${SENTINEL_OPEN}\n`), reversed);
		const multiple = { ...unclosed, status: 'multiple' };
		assert.deepEqual(findSentinelBlock(`${INSTALLER_BLOCK}\n\n${INSTALLER_BLOCK}\n`), multiple);
		assert.deepEqual(findSentinelBlock(`${SENTINEL_OPEN}\n${SENTINEL_OPEN}\n`), multiple);
		assert.deepEqual(findSentinelBlock(`${SENTINEL_OPEN}\nx\n${SENTINEL_CLOSE}\ny\n${SENTINEL_CLOSE}\n`), multiple);
		assert.deepEqual(findSentinelBlock(`${SENTINEL_CLOSE}\n${SENTINEL_OPEN}\nx\n${SENTINEL_CLOSE}\n`), multiple);

		const changedWord = findSentinelBlock(`${INSTALLER_BLOCK.replace('Do not answer from memory.', 'Answer from memory.')}\n`);
		assert.equal(changedWord.status, 'ok');
		assert.equal(changedWord.edited, true);
		const innerSpaces = findSentinelBlock(`${INSTALLER_BLOCK.replace('# Make Custom App Skill', '# Make Custom App Skill  ')}\n`);
		assert.equal(innerSpaces.edited, true);
		const emptyInside = findSentinelBlock(`${SENTINEL_OPEN}\n${SENTINEL_CLOSE}\n`);
		assert.equal(emptyInside.status, 'ok');
		assert.equal(emptyInside.edited, true);
		const outerBlankLines = findSentinelBlock(`${INSTALLER_BLOCK.replace(`${SENTINEL_OPEN}\n`, `${SENTINEL_OPEN}\n\n`).replace(`\n${SENTINEL_CLOSE}`, `\n\n${SENTINEL_CLOSE}`)}\n`);
		assert.equal(outerBlankLines.edited, false);
	});

	it('findSentinelBlock reports a removedText that sits at its offset', () => {
		const texts = [
			`notes\n\n${INSTALLER_BLOCK}\n`,
			`${INSTALLER_BLOCK}\n`,
			`a\n${INSTALLER_BLOCK}`,
			`a\r\n\r\n${CRLF_BLOCK}\r\nb\r\n`,
			`a\n \n${INSTALLER_BLOCK}\nb\n`,
		];
		for (const text of texts) {
			const block = findSentinelBlock(text);
			assert.equal(block.status, 'ok');
			assert.equal(text.slice(block.offset, block.offset + block.removedText.length), block.removedText);
		}
	});

	it('findSentinelBlock gives the offset in UTF-16 code units, the unit of slice, not in bytes', () => {
		const prefix = `${NON_ASCII_PREFIX}\n`;
		assert.equal(prefix.length, 7);
		assert.equal(Buffer.byteLength(prefix), 11);
		for (const text of [`${prefix}\n${INSTALLER_BLOCK}\n`, `${prefix}${INSTALLER_BLOCK}\n`]) {
			const block = findSentinelBlock(text);
			assert.equal(block.status, 'ok');
			assert.equal(block.offset, prefix.length);
			assert.notEqual(block.offset, Buffer.byteLength(prefix));
			assert.equal(text.slice(block.offset, block.offset + block.removedText.length), block.removedText);
		}
		const { after, block } = cut(`${prefix}\n${INSTALLER_BLOCK}\ntail \uD83D\uDE00\n`);
		assert.equal(after, `${prefix}tail \uD83D\uDE00\n`);
		assert.equal(block.lineStart, 3);
	});

	it('a byte order mark before the open marker is cut with the block and put back by restoreBlock; one before user text stays', () => {
		const alone = `\uFEFF${INSTALLER_BLOCK}\n`;
		const block = findSentinelBlock(alone);
		assert.deepEqual(block, { status: 'ok', offset: 0, removedText: alone, lineStart: 1, lineEnd: 5, edited: false });
		const { after, step } = cut(alone);
		assert.equal(after, '');
		assert.deepEqual(restoreBlock(after, step), { text: alone, how: 'spliced' });

		const withUser = `\uFEFFmy rules\n\n${INSTALLER_BLOCK}\n`;
		const second = cut(withUser);
		assert.equal(second.after, '\uFEFFmy rules\n');
		assert.deepEqual(restoreBlock(second.after, second.step), { text: withUser, how: 'spliced' });
	});

	it('removeBlock takes the blank line before the block and keeps every other byte', () => {
		const user = 'My own rules\nSecond line\n';
		assert.equal(cut(`${user}\n${INSTALLER_BLOCK}\n`).after, user);
		assert.equal(cut(`${INSTALLER_BLOCK}\n`).after, '');
		assert.equal(cut(`${user}${INSTALLER_BLOCK}\n`).after, user);
		assert.equal(cut(`${user}\n${INSTALLER_BLOCK}`).after, user);
		assert.equal(cut(`head\n\n${INSTALLER_BLOCK}\n\ntail\n`).after, 'head\n\ntail\n');
		assert.equal(cut(`head\n\n${INSTALLER_BLOCK}\ntail\n`).after, 'head\ntail\n');
		assert.equal(cut(`head\r\n\r\n${CRLF_BLOCK}\r\ntail\r\nmore\n`).after, 'head\r\ntail\r\nmore\n');
		assert.equal(cut(`head\n \n${INSTALLER_BLOCK}\n`).after, 'head\n \n');
		assert.equal(cut(`head\n\n  ${SENTINEL_OPEN}\nx\n${SENTINEL_CLOSE}  \nkeep  \n`).after, 'head\nkeep  \n');
	});

	it('removeBlock leaves the text alone when there is no ok block, and refuses a block found in other text', () => {
		const text = `notes\n${SENTINEL_OPEN}\nunclosed\n`;
		assert.equal(removeBlock(text, findSentinelBlock(text)), text);
		assert.equal(removeBlock('plain\n', findSentinelBlock('plain\n')), 'plain\n');
		assert.equal(removeBlock('plain\n', undefined), 'plain\n');
		const block = findSentinelBlock(`notes\n\n${INSTALLER_BLOCK}\n`);
		const other = `other\n\n${INSTALLER_BLOCK.replace('IMLJSON', 'IMLJSON2')}\n`;
		assert.throws(() => removeBlock(other, block), (err) => err instanceof TypeError && !err.message.includes('IMLJSON'));
		assert.throws(() => removeBlock('', block), TypeError);
	});

	it('restoreBlock: present, spliced, appended', () => {
		const original = `notes\n\n${INSTALLER_BLOCK}\ntail\n`;
		const { after, step } = cut(original);

		assert.deepEqual(restoreBlock(original, step), { text: original, how: 'present' });
		const indented = `x\n  ${SENTINEL_OPEN}\n`;
		assert.deepEqual(restoreBlock(indented, step), { text: indented, how: 'present' });
		const crlfPresent = `x\r\n${SENTINEL_OPEN}\r\n`;
		assert.equal(restoreBlock(crlfPresent, step).how, 'present');
		const inline = `see ${SENTINEL_OPEN} here\n`;
		assert.equal(restoreBlock(inline, step).how, 'appended');

		assert.deepEqual(restoreBlock(after, step), { text: original, how: 'spliced' });
		const crlfOriginal = `head\r\n\r\n${CRLF_BLOCK}\r\ntail\r\n`;
		const crlf = cut(crlfOriginal);
		assert.deepEqual(restoreBlock(crlf.after, crlf.step), { text: crlfOriginal, how: 'spliced' });
		const atStart = cut(`${INSTALLER_BLOCK}\ntail\n`);
		assert.deepEqual(restoreBlock(atStart.after, atStart.step), { text: `${INSTALLER_BLOCK}\ntail\n`, how: 'spliced' });
		const atEnd = cut(`head\n\n${INSTALLER_BLOCK}`);
		assert.deepEqual(restoreBlock(atEnd.after, atEnd.step), { text: `head\n\n${INSTALLER_BLOCK}`, how: 'spliced' });

		const edited = `${after}added by the user\n`;
		assert.deepEqual(restoreBlock(edited, step), { text: `${edited}${step.removedText}`, how: 'appended' });
		const noNewline = 'notes\ntail';
		assert.deepEqual(restoreBlock(noNewline, step), { text: `${noNewline}\n${step.removedText}`, how: 'appended' });
		const noNewlineCrlf = 'notes\r\ntail';
		assert.deepEqual(restoreBlock(noNewlineCrlf, step), { text: `${noNewlineCrlf}\r\n${step.removedText}`, how: 'appended' });
		assert.deepEqual(restoreBlock('', step), { text: step.removedText, how: 'appended' });
	});

	it('restoreBlock appends when the recorded offset cannot be used', () => {
		const original = `notes\n\n${INSTALLER_BLOCK}\n`;
		const { after, step } = cut(original);
		for (const offset of [-1, 1.5, after.length + 1, undefined, null, '6']) {
			assert.deepEqual(restoreBlock(after, { ...step, offset }), { text: `${after}${step.removedText}`, how: 'appended' });
		}
	});

	it('restoreBlock needs the text and the removed text', () => {
		assert.throws(() => restoreBlock(undefined, { removedText: 'x' }), TypeError);
		assert.throws(() => restoreBlock('x', undefined), TypeError);
		assert.throws(() => restoreBlock('x', { offset: 0 }), TypeError);
	});

	it('remove then restore gives the original bytes for every layout of the block', () => {
		const texts = [
			`notes\n\n${INSTALLER_BLOCK}\n`,
			`${INSTALLER_BLOCK}\n`,
			`${INSTALLER_BLOCK}`,
			`a\n${INSTALLER_BLOCK}\nb\n`,
			`a\r\n\r\n${CRLF_BLOCK}\r\nb\r\n`,
			`a\n\n${INSTALLER_BLOCK}\n\n${'b'.repeat(40)}`,
			`\n${INSTALLER_BLOCK}\n`,
			`a\n\n${INSTALLER_BLOCK.replace('Do not answer from memory.', 'Edited.')}\n`,
			`${NON_ASCII_PREFIX}\n${INSTALLER_BLOCK}\n`,
			`${NON_ASCII_PREFIX}\r\n\r\n${CRLF_BLOCK}\r\n${NON_ASCII_PREFIX}\r\n`,
		];
		for (const text of texts) {
			const { after, step } = cut(text);
			assert.equal(findSentinelBlock(after).status, 'none');
			assert.deepEqual(restoreBlock(after, step), { text, how: 'spliced' });
		}
	});
});

describe('findOwnLines', () => {
	it('findOwnLines finds the user paragraph and ignores the block', () => {
		const text = ['Use the make-custom-app skill for every Make task.', '', INSTALLER_BLOCK, '', 'Also: the `make-custom-app` skill is installed.', 'Nothing here.'].join('\n');
		const block = findSentinelBlock(text);
		assert.equal(block.status, 'ok');
		assert.deepEqual(findOwnLines(text, block), [1, 9]);
		assert.deepEqual(findOwnLines(text, findSentinelBlock('')), [1, 6, 9]);
	});

	it('findOwnLines matches the skill name only as a whole word, in any case', () => {
		const lines = [
			'the make-custom-app skill',
			'The `make-custom-app` skill',
			'MAKE-CUSTOM-APP\tSKILL',
			'make-custom-app-skill is the repo name',
			'my-make-custom-app skill',
			'make-custom-apps skill',
			'make-custom-app plugin',
			'make-custom-app',
			'skill make-custom-app',
			'<!-- make-custom-app-skill -->',
		];
		assert.deepEqual(findOwnLines(lines.join('\n'), findSentinelBlock('')), [1, 2, 3]);
		assert.deepEqual(findOwnLines(lines.join('\r\n'), findSentinelBlock('')), [1, 2, 3]);
	});

	it('findOwnLines checks every line when the block is not ok, and numbers lines from 1', () => {
		const text = `${SENTINEL_OPEN}\nthe make-custom-app skill\n`;
		assert.deepEqual(findOwnLines(text, findSentinelBlock(text)), [2]);
		assert.deepEqual(findOwnLines(text), [2]);
		assert.deepEqual(findOwnLines('', undefined), []);
	});
});

describe('usableValue', () => {
	it('usableValue: empty, spaces only, multiline, placeholder markers, a value that starts with ${, a good value', () => {
		assert.equal(usableValue(''), false);
		assert.equal(usableValue('   '), false);
		assert.equal(usableValue('\t'), false);
		assert.equal(usableValue('first\nsecond'), false);
		assert.equal(usableValue('first\rsecond'), false);
		assert.equal(usableValue('value\r\n'), false);
		for (const marker of ['your-pinecone-key', '<key>', 'name@example.com', 'ATATT3x...abc', '/path/to/server', '{path-to-folder}', '/path/provided/by/user']) {
			assert.equal(usableValue(marker), false, marker);
		}
		assert.equal(usableValue('${env:OPENAI_API_KEY}'), false);
		assert.equal(usableValue('  ${OPENAI_API_KEY}'), false);
		assert.equal(usableValue(FAKE.pinecone), true);
		assert.equal(usableValue(`  ${FAKE.openai}  `), true);
		assert.equal(usableValue('a$b{c}'), true);
		for (const value of [undefined, null, 5, {}, ['x']]) assert.equal(usableValue(value), false);
	});

	it('ENV_TO_KEY maps the three names of the old .env to the keys of the secrets file', () => {
		assert.deepEqual(ENV_TO_KEY, { PINECONE_API_KEY: 'pinecone-api-key', OPENAI_API_KEY: 'openai-api-key', PINECONE_INDEX_NAME: 'pinecone-index-name' });
	});
});

describe('parseEnvTemplate and renderEnvTemplate', () => {
	it('the installer .env is templated line by line and renders back to the same bytes', () => {
		const parsed = parseEnvTemplate(INSTALLER_ENV_TEXT, secretValue);
		assert.deepEqual(parsed.template, [
			'# Pinecone',
			{ prefix: 'PINECONE_API_KEY=', $secret: 'pinecone-api-key' },
			{ prefix: 'PINECONE_INDEX_NAME=', $secret: 'pinecone-index-name' },
			'',
			'# OpenAI (for text-embedding-3-small)',
			{ prefix: 'OPENAI_API_KEY=', $secret: 'openai-api-key' },
		]);
		assert.deepEqual(parsed.values, { PINECONE_API_KEY: FAKE.pinecone, PINECONE_INDEX_NAME: FAKE.index, OPENAI_API_KEY: FAKE.openai });
		assert.deepEqual(parsed.names, ['PINECONE_API_KEY', 'PINECONE_INDEX_NAME', 'OPENAI_API_KEY']);
		assert.deepEqual(parsed.unknownAssignments, []);
		assert.deepEqual(parsed.untemplatedSecretLines, []);
		assert.equal(parsed.eol, '\n');
		assert.equal(parsed.trailingNewline, true);
		assert.equal(parsed.bom, false);
		assert.equal(renderEnvTemplate(parsed, secretValue), INSTALLER_ENV_TEXT);

		const template = JSON.stringify(parsed.template);
		for (const value of [FAKE.pinecone, FAKE.openai]) assert.ok(!template.includes(value));
	});

	it('parseEnvTemplate and renderEnvTemplate: equal values are templated; an empty value, a placeholder, and a value with trailing spaces stay literal (the last one listed in untemplatedSecretLines); BOM, CRLF, comments, and an unknown assignment round-trip byte for byte', () => {
		const text = [
			'\uFEFF# keys',
			`PINECONE_API_KEY=${FAKE.pinecone}`,
			'OPENAI_API_KEY=',
			'# PINECONE_INDEX_NAME=commented-out',
			`PINECONE_INDEX_NAME=${FAKE.index}  `,
			'OTHER_TOKEN=',
			`FOO=${FAKE.otherToken}`,
			'',
		].join('\r\n');
		const parsed = parseEnvTemplate(text, secretValue);
		assert.equal(parsed.bom, true);
		assert.equal(parsed.eol, '\r\n');
		assert.equal(parsed.trailingNewline, true);
		assert.deepEqual(parsed.template, [
			'# keys',
			{ prefix: 'PINECONE_API_KEY=', $secret: 'pinecone-api-key' },
			'OPENAI_API_KEY=',
			'# PINECONE_INDEX_NAME=commented-out',
			`PINECONE_INDEX_NAME=${FAKE.index}  `,
			'OTHER_TOKEN=',
			`FOO=${FAKE.otherToken}`,
		]);
		assert.deepEqual(parsed.untemplatedSecretLines, ['PINECONE_INDEX_NAME']);
		assert.deepEqual(parsed.unknownAssignments, ['FOO']);
		assert.deepEqual(parsed.names, ['PINECONE_API_KEY', 'OPENAI_API_KEY', 'PINECONE_INDEX_NAME', 'OTHER_TOKEN', 'FOO']);
		assert.deepEqual(parsed.values, { PINECONE_API_KEY: FAKE.pinecone, PINECONE_INDEX_NAME: FAKE.index });
		assert.equal(renderEnvTemplate(parsed, secretValue), text);
	});

	it('a placeholder, a reference, and an empty value hold no secret and stay literal without a note', () => {
		const text = ['PINECONE_API_KEY=your-pinecone-key', 'OPENAI_API_KEY=${env:OPENAI_API_KEY}', 'PINECONE_INDEX_NAME=   ', ''].join('\n');
		const parsed = parseEnvTemplate(text, secretValue);
		assert.deepEqual(parsed.template, text.split('\n').slice(0, 3));
		assert.deepEqual(parsed.values, {});
		assert.deepEqual(parsed.untemplatedSecretLines, []);
		assert.deepEqual(parsed.unknownAssignments, []);
		assert.deepEqual(parsed.names, ['PINECONE_API_KEY', 'OPENAI_API_KEY', 'PINECONE_INDEX_NAME']);
		assert.equal(renderEnvTemplate(parsed, secretValue), text);
	});

	it('a value that differs from the secrets file, or has no secrets file value, is listed and stays literal', () => {
		const text = `PINECONE_API_KEY=${FAKE.conflictPinecone}\nOPENAI_API_KEY=${FAKE.openai}\n`;
		const conflict = parseEnvTemplate(text, secretValue);
		assert.deepEqual(conflict.template, [`PINECONE_API_KEY=${FAKE.conflictPinecone}`, { prefix: 'OPENAI_API_KEY=', $secret: 'openai-api-key' }]);
		assert.deepEqual(conflict.untemplatedSecretLines, ['PINECONE_API_KEY']);
		assert.deepEqual(conflict.values, { PINECONE_API_KEY: FAKE.conflictPinecone, OPENAI_API_KEY: FAKE.openai });

		const none = parseEnvTemplate(text, () => null);
		assert.deepEqual(none.template, text.split('\n').slice(0, 2));
		assert.deepEqual(none.untemplatedSecretLines, ['PINECONE_API_KEY', 'OPENAI_API_KEY']);
		assert.equal(renderEnvTemplate(none, () => null), text);
	});

	it('spaces around the separator, leading spaces, and a missing final newline are kept', () => {
		const text = `  OPENAI_API_KEY = ${FAKE.openai}\nPINECONE_API_KEY\t=\t${FAKE.pinecone}`;
		const parsed = parseEnvTemplate(text, secretValue);
		assert.deepEqual(parsed.template, [
			{ prefix: '  OPENAI_API_KEY = ', $secret: 'openai-api-key' },
			{ prefix: 'PINECONE_API_KEY\t=\t', $secret: 'pinecone-api-key' },
		]);
		assert.equal(parsed.trailingNewline, false);
		assert.equal(renderEnvTemplate(parsed, secretValue), text);
	});

	it('the last usable value of a name wins in values, and every duplicate line is still templated', () => {
		const text = `PINECONE_API_KEY=${FAKE.conflictPinecone}\nPINECONE_API_KEY=${FAKE.pinecone}\n`;
		const parsed = parseEnvTemplate(text, secretValue);
		assert.deepEqual(parsed.values, { PINECONE_API_KEY: FAKE.pinecone });
		assert.deepEqual(parsed.names, ['PINECONE_API_KEY']);
		assert.deepEqual(parsed.untemplatedSecretLines, ['PINECONE_API_KEY']);
		assert.equal(renderEnvTemplate(parsed, secretValue), text);
	});

	it('an assignment the template cannot hold keeps the file out of a delete: export lines and other names are listed', () => {
		const text = `export OPENAI_API_KEY=${FAKE.openai}\nexport EMPTY=\nexport KEPT=${FAKE.otherToken}\nmy.setting-1 = 2\n1BAD=x\n`;
		const parsed = parseEnvTemplate(text, secretValue);
		assert.deepEqual(parsed.template, text.split('\n').slice(0, 5));
		assert.deepEqual(parsed.unknownAssignments, ['OPENAI_API_KEY', 'KEPT', 'my.setting-1']);
		assert.deepEqual(parsed.names, ['OPENAI_API_KEY', 'EMPTY', 'KEPT', 'my.setting-1']);
		assert.deepEqual(parsed.values, {});
		assert.equal(renderEnvTemplate(parsed, secretValue), text);
	});

	it('a value with a line break inside it cannot be templated and is listed', () => {
		const oneLine = `PINECONE_API_KEY=${FAKE.pinecone}\rOPENAI_API_KEY=${FAKE.openai}\r`;
		const parsed = parseEnvTemplate(oneLine, secretValue);
		assert.deepEqual(parsed.template, [oneLine]);
		assert.deepEqual(parsed.untemplatedSecretLines, ['PINECONE_API_KEY']);
		assert.deepEqual(parsed.values, {});
		assert.equal(renderEnvTemplate(parsed, secretValue), oneLine);

		const strayCr = parseEnvTemplate(`PINECONE_API_KEY=${FAKE.pinecone}\r`, secretValue);
		assert.deepEqual(strayCr.untemplatedSecretLines, ['PINECONE_API_KEY']);
		const emptyCr = parseEnvTemplate('PINECONE_API_KEY=\r', secretValue);
		assert.deepEqual(emptyCr.untemplatedSecretLines, []);
	});

	it('a line with U+2028 inside a value is still one line of the file', () => {
		const text = `OPENAI_API_KEY=${FAKE.openai}\u2028x\n`;
		const parsed = parseEnvTemplate(text, secretValue);
		assert.deepEqual(parsed.untemplatedSecretLines, ['OPENAI_API_KEY']);
		assert.equal(renderEnvTemplate(parsed, secretValue), text);
	});

	it('an empty text, a lone newline, and a text without assignments round-trip', () => {
		for (const text of ['', '\n', '\r\n', '# only a comment', '# only a comment\n', '\n\n', '\uFEFF']) {
			const parsed = parseEnvTemplate(text, secretValue);
			assert.deepEqual(parsed.values, {}, JSON.stringify(text));
			assert.deepEqual(parsed.names, []);
			assert.equal(renderEnvTemplate(parsed, secretValue), text, JSON.stringify(text));
		}
		assert.equal(parseEnvTemplate('\r\n', secretValue).eol, '\r\n');
		assert.equal(parseEnvTemplate('\uFEFF', secretValue).bom, true);
	});

	it('a file with mixed line endings reports mixedEol, is written back with CRLF, and is not rendered exactly', () => {
		const text = `# a\nPINECONE_API_KEY=${FAKE.pinecone}\r\n# b\n`;
		const parsed = parseEnvTemplate(text, secretValue);
		assert.equal(parsed.mixedEol, true);
		assert.equal(parsed.eol, '\r\n');
		assert.deepEqual(parsed.untemplatedSecretLines, []);
		assert.deepEqual(parsed.unknownAssignments, []);
		assert.notEqual(renderEnvTemplate(parsed, secretValue), text);
		assert.equal(renderEnvTemplate(parsed, secretValue), text.replace(/\r?\n/g, '\r\n'));
		assert.equal(rendersExactly(parsed, secretValue, text), false);
		assert.equal(rendersExactly(parsed, secretValue, text.replace(/\r?\n/g, '\r\n')), false);
		const bareFirst = parseEnvTemplate(`# a\r\n# b\n${INSTALLER_ENV_TEXT.replace(/\n/g, '\r\n')}`, secretValue);
		assert.equal(bareFirst.mixedEol, true);
	});

	it('mixedEol is false for LF, CRLF, a bare carriage return, a missing final newline, and an empty text', () => {
		const crlf = INSTALLER_ENV_TEXT.replace(/\n/g, '\r\n');
		for (const text of ['', '\n', '\r\n', INSTALLER_ENV_TEXT, crlf, crlf.slice(0, -2), `${INSTALLER_ENV_TEXT}\r`, '\uFEFF# a\r\n# b\r\n', 'a\rb\r\nc\r\n']) {
			assert.equal(parseEnvTemplate(text, secretValue).mixedEol, false, JSON.stringify(text));
		}
	});

	it('rendersExactly: true only when the render equals the original text', () => {
		const crlf = INSTALLER_ENV_TEXT.replace(/\n/g, '\r\n');
		for (const text of [INSTALLER_ENV_TEXT, crlf, `\uFEFF${crlf}`, '', `PINECONE_API_KEY=${FAKE.pinecone}`, 'FOO=1\nOPENAI_API_KEY=your-key\n']) {
			const parsed = parseEnvTemplate(text, secretValue);
			assert.equal(rendersExactly(parsed, secretValue, text), true, JSON.stringify(text));
		}
		const parsed = parseEnvTemplate(INSTALLER_ENV_TEXT, secretValue);
		assert.equal(rendersExactly(parsed, secretValue, `${INSTALLER_ENV_TEXT}# more\n`), false);
		assert.equal(rendersExactly(parsed, secretValue, INSTALLER_ENV_TEXT.replace(/\n/g, '\r\n')), false);
		assert.equal(rendersExactly(parsed, (key) => `changed-${key}`, INSTALLER_ENV_TEXT), false);
		assert.equal(rendersExactly(parsed, () => null, INSTALLER_ENV_TEXT), false);
		assert.equal(
			rendersExactly(parsed, () => {
				throw new Error(FAKE.pinecone);
			}, INSTALLER_ENV_TEXT),
			false,
		);
		assert.equal(rendersExactly(undefined, secretValue, INSTALLER_ENV_TEXT), false);
		assert.equal(rendersExactly(null, secretValue, ''), false);
	});

	it('parseEnvTemplate stays linear when a file has tens of thousands of distinct names', () => {
		const count = 40000;
		const text = `${Array.from({ length: count }, (_, i) => `NAME_${i}=value${i}`).join('\n')}\n`;
		const started = Date.now();
		const parsed = parseEnvTemplate(text, secretValue);
		const elapsed = Date.now() - started;
		assert.equal(parsed.names.length, count);
		assert.equal(parsed.unknownAssignments.length, count);
		assert.equal(parsed.names[count - 1], `NAME_${count - 1}`);
		assert.ok(elapsed < 1000, `took ${elapsed} ms`);
		assert.equal(renderEnvTemplate(parsed, secretValue), text);
	});

	it('renderEnvTemplate puts in the value that the callback gives, and refuses a missing value without naming content', () => {
		const parsed = parseEnvTemplate(INSTALLER_ENV_TEXT, secretValue);
		const swapped = renderEnvTemplate(parsed, (key) => `changed-${key}`);
		assert.ok(swapped.includes('PINECONE_API_KEY=changed-pinecone-api-key\n'));
		assert.ok(!swapped.includes(FAKE.pinecone));
		assert.throws(
			() => renderEnvTemplate(parsed, () => null),
			(err) => err instanceof TypeError && !err.message.includes('pinecone-api-key'),
		);
		assert.throws(() => renderEnvTemplate(parsed, () => undefined), TypeError);
	});

	it('both functions check their arguments', () => {
		assert.throws(() => parseEnvTemplate(undefined, secretValue), TypeError);
		assert.throws(() => parseEnvTemplate('', undefined), TypeError);
		assert.throws(() => renderEnvTemplate(undefined, secretValue), TypeError);
		assert.throws(() => renderEnvTemplate({ template: 'x' }, secretValue), TypeError);
		assert.throws(() => renderEnvTemplate(parseEnvTemplate('', secretValue), undefined), TypeError);
	});

	it('the secrets callback is asked only for keys of the secrets file, and only for usable values', () => {
		const asked = [];
		parseEnvTemplate(`PINECONE_API_KEY=${FAKE.pinecone}\nOPENAI_API_KEY=\nPINECONE_INDEX_NAME=your-index\nFOO=1\n`, (key) => {
			asked.push(key);
			return null;
		});
		assert.deepEqual(asked, ['pinecone-api-key']);
	});
});

describe('redactEntry and nameOnlyEntry', () => {
	function entry() {
		return {
			command: '/usr/bin/node',
			args: ['/x/mcp-server/dist/index.js'],
			env: { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.conflictPinecone, PINECONE_INDEX_NAME: FAKE.index, EXTRA_TOKEN: FAKE.otherToken },
		};
	}

	it('redactEntry: equal values become $secret, others stay and are listed', () => {
		const input = entry();
		const result = redactEntry(input, SECRETS);
		assert.deepEqual(result.entry, {
			command: '/usr/bin/node',
			args: ['/x/mcp-server/dist/index.js'],
			env: {
				PINECONE_API_KEY: { $secret: 'pinecone-api-key' },
				OPENAI_API_KEY: FAKE.conflictPinecone,
				PINECONE_INDEX_NAME: { $secret: 'pinecone-index-name' },
				EXTRA_TOKEN: FAKE.otherToken,
			},
		});
		assert.deepEqual(result.literalKeys, ['OPENAI_API_KEY', 'EXTRA_TOKEN']);
		assert.deepEqual(input, entry());
		assert.ok(!JSON.stringify(result.entry.env.PINECONE_API_KEY).includes(FAKE.pinecone));
	});

	it('redactEntry returns a deep copy', () => {
		const input = entry();
		const result = redactEntry(input, SECRETS);
		result.entry.args.push('changed');
		result.entry.env.EXTRA_TOKEN = 'changed';
		assert.deepEqual(input, entry());
	});

	it('redactEntry keeps a value that has only an empty or a missing secrets value, and a value of another type', () => {
		const input = { command: 'node', env: { PINECONE_API_KEY: '', OPENAI_API_KEY: FAKE.openai, PINECONE_INDEX_NAME: 5 } };
		const result = redactEntry(input, { 'pinecone-api-key': '', 'pinecone-index-name': 5 });
		assert.deepEqual(result.entry, input);
		assert.deepEqual(result.literalKeys, ['PINECONE_API_KEY', 'OPENAI_API_KEY', 'PINECONE_INDEX_NAME']);
		assert.deepEqual(redactEntry(input, undefined).literalKeys, ['PINECONE_API_KEY', 'OPENAI_API_KEY', 'PINECONE_INDEX_NAME']);
	});

	it('redactEntry copes with an entry without env and with a value that is not an entry', () => {
		assert.deepEqual(redactEntry({ type: 'http', url: 'https://example.invalid/mcp' }, SECRETS), { entry: { type: 'http', url: 'https://example.invalid/mcp' }, literalKeys: [] });
		assert.deepEqual(redactEntry({ env: 'x' }, SECRETS), { entry: { env: 'x' }, literalKeys: [] });
		assert.deepEqual(redactEntry(null, SECRETS), { entry: null, literalKeys: [] });
		assert.deepEqual(redactEntry(undefined, SECRETS), { entry: undefined, literalKeys: [] });
		assert.deepEqual(redactEntry(['x'], SECRETS), { entry: ['x'], literalKeys: [] });
	});

	it('nameOnlyEntry holds no value', () => {
		const input = entry();
		const result = nameOnlyEntry(input);
		assert.deepEqual(result, {
			command: '/usr/bin/node',
			args: ['/x/mcp-server/dist/index.js'],
			env: { PINECONE_API_KEY: 'PINECONE_API_KEY', OPENAI_API_KEY: 'OPENAI_API_KEY', PINECONE_INDEX_NAME: 'PINECONE_INDEX_NAME', EXTRA_TOKEN: 'EXTRA_TOKEN' },
		});
		const text = JSON.stringify(result);
		for (const value of [FAKE.pinecone, FAKE.conflictPinecone, FAKE.otherToken, FAKE.index]) assert.ok(!text.includes(value), value);
		assert.deepEqual(input, entry());
		result.args.push('changed');
		assert.deepEqual(input, entry());
	});

	it('redactEntry and nameOnlyEntry refuse an entry that is not JSON data with a fixed TypeError', () => {
		const circular = { env: { PINECONE_API_KEY: FAKE.pinecone } };
		circular.self = circular;
		const hostile = {
			env: { PINECONE_API_KEY: FAKE.pinecone },
			toJSON() {
				throw new Error(`cannot copy ${FAKE.pinecone}`);
			},
		};
		const bad = [circular, hostile, { env: { A: 10n } }, () => 1, Symbol('x')];
		for (const value of bad) {
			for (const fn of [(v) => redactEntry(v, SECRETS), nameOnlyEntry]) {
				assert.throws(
					() => fn(value),
					(err) => {
						assert.ok(err instanceof TypeError);
						assert.match(err.message, /^(redactEntry|nameOnlyEntry) needs an entry that is JSON data$/);
						assert.equal(err.cause, undefined);
						return true;
					},
				);
			}
		}
	});

	it('redactEntry and nameOnlyEntry copy through JSON: dates and undefined members follow JSON rules and a member named __proto__ stays', () => {
		const parsed = JSON.parse('{"command":"node","env":{"__proto__":"x","PINECONE_API_KEY":"' + FAKE.pinecone + '"}}');
		const result = redactEntry(parsed, SECRETS);
		assert.deepEqual(Object.keys(result.entry.env), ['__proto__', 'PINECONE_API_KEY']);
		assert.deepEqual(result.literalKeys, ['__proto__']);
		assert.deepEqual(result.entry.env.PINECONE_API_KEY, { $secret: 'pinecone-api-key' });
		assert.deepEqual(Object.keys(nameOnlyEntry(parsed).env), ['__proto__', 'PINECONE_API_KEY']);
		assert.deepEqual(redactEntry({ a: undefined, b: 1 }, SECRETS).entry, { b: 1 });
	});

	it('nameOnlyEntry replaces an object value too, and leaves an entry without env alone', () => {
		assert.deepEqual(nameOnlyEntry({ env: { A: { $secret: 'x' }, B: 1 } }), { env: { A: 'A', B: 'B' } });
		assert.deepEqual(nameOnlyEntry({ type: 'http', url: 'https://example.invalid/mcp' }), { type: 'http', url: 'https://example.invalid/mcp' });
		assert.deepEqual(nameOnlyEntry({ env: null }), { env: null });
		assert.equal(nameOnlyEntry(null), null);
		assert.equal(nameOnlyEntry(undefined), undefined);
	});
});

describe('removeJsonMember and insertJsonMember', () => {
	function config() {
		return {
			numStartups: 3,
			mcpServers: {
				alpha: { command: 'node', args: ['/opt/alpha.js'], env: { TOKEN: FAKE.otherToken } },
				'make-custom-app': { command: '/usr/bin/node', args: ['/x/mcp-server/dist/index.js'], env: { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai } },
				omega: { type: 'http', url: 'https://example.invalid/mcp' },
			},
			projects: { '/work': { allowedTools: [], mcpServers: {}, history: ['a', 'b'] } },
		};
	}
	const KEYS = ['alpha', 'make-custom-app', 'omega'];
	const LAYOUTS = {
		'two spaces and a final newline': { text: () => `${JSON.stringify(config(), null, 2)}\n`, indent: '  ', eol: '\n', trailingNewline: true },
		'two spaces and no final newline': { text: () => JSON.stringify(config(), null, 2), indent: '  ', eol: '\n', trailingNewline: false },
		tabs: { text: () => `${JSON.stringify(config(), null, '\t')}\n`, indent: '\t', eol: '\n', trailingNewline: true },
		'four spaces': { text: () => JSON.stringify(config(), null, 4), indent: '    ', eol: '\n', trailingNewline: false },
		CRLF: { text: () => `${JSON.stringify(config(), null, 2).replace(/\n/g, '\r\n')}\r\n`, indent: '  ', eol: '\r\n', trailingNewline: true },
		'CRLF without a final newline': { text: () => JSON.stringify(config(), null, 2).replace(/\n/g, '\r\n'), indent: '  ', eol: '\r\n', trailingNewline: false },
	};

	it('removeJsonMember and insertJsonMember round-trip the canonical file byte for byte and a compact file deep-equal; position and indent are kept; CRLF kept', () => {
		for (const [name, layout] of Object.entries(LAYOUTS)) {
			for (const [position, key] of KEYS.entries()) {
				const text = layout.text();
				const removed = removeJsonMember(text, key);
				const label = `${name}, ${key}`;
				assert.equal(removed.canonical, true, label);
				assert.equal(removed.position, position, label);
				assert.equal(removed.indent, layout.indent, label);
				assert.equal(removed.eol, layout.eol, label);
				assert.equal(removed.trailingNewline, layout.trailingNewline, label);
				assert.deepEqual(removed.entry, config().mcpServers[key], label);

				const rest = config();
				delete rest.mcpServers[key];
				const expected = JSON.stringify(rest, null, layout.indent).replace(/\n/g, layout.eol) + (layout.trailingNewline ? layout.eol : '');
				assert.equal(removed.text, expected, label);
				assert.ok(!Object.hasOwn(JSON.parse(removed.text).mcpServers, key), label);

				const back = insertJsonMember(removed.text, key, removed.entry, removed);
				assert.equal(back, text, label);
			}
		}
	});

	it('a compact file is rewritten with two-space indent and comes back deep-equal with the same key order', () => {
		const text = JSON.stringify(config());
		const removed = removeJsonMember(text, 'make-custom-app');
		assert.equal(removed.canonical, false);
		assert.equal(removed.indent, '  ');
		assert.equal(removed.eol, '\n');
		assert.equal(removed.trailingNewline, false);
		assert.equal(removed.position, 1);
		assert.ok(removed.text.includes('\n  "mcpServers"'));

		const back = insertJsonMember(removed.text, 'make-custom-app', removed.entry, removed);
		assert.notEqual(back, text);
		assert.deepEqual(JSON.parse(back), config());
		assert.deepEqual(Object.keys(JSON.parse(back).mcpServers), KEYS);
		assert.deepEqual(Object.keys(JSON.parse(back)), Object.keys(config()));
	});

	it('a file that is not exactly the serialization of its content is not canonical', () => {
		const variants = [
			'{ "mcpServers": { "a": { "x": 1 } } }',
			'{\n  "mcpServers": {\n    "a": { "x": 1.0 }\n  }\n}\n',
			'{\n  "mcpServers": {\n    "a": {\n      "x": 1\n    }\n  }\n}\n\n',
			'{\n  "mcpServers": {\n    "a": {\n      "x": 1\n    }\n  },\n  "mcpServers": {\n    "a": {\n      "x": 1\n    }\n  }\n}\n',
			'{\n  "mcpServers": {\n    "a": {\n      "x": "\\u00e9"\n    }\n  }\n}\n',
		];
		for (const text of variants) {
			const removed = removeJsonMember(text, 'a');
			assert.equal(removed.canonical, false, text);
			assert.deepEqual(JSON.parse(removed.text), { mcpServers: {} });
		}
	});

	it('the indent of a file is the leading whitespace of its first indented line, not of the first line', () => {
		assert.equal(removeJsonMember('  {\n      "mcpServers": {\n         "a": {}\n      }\n}', 'a').indent, '      ');
		assert.equal(removeJsonMember('{"mcpServers":{"a":{}}}', 'a').indent, '  ');
		assert.equal(removeJsonMember('{\r\n\t"mcpServers": {"a": {}}\r\n}', 'a').indent, '\t');
	});

	it('insertJsonMember puts the member back at its position, clamps a position that is too large, and appends without one', () => {
		const text = `${JSON.stringify({ mcpServers: { a: { n: 1 }, b: { n: 2 } } }, null, 2)}\n`;
		const options = { indent: '  ', eol: '\n', trailingNewline: true };
		const keysAt = (position) => Object.keys(JSON.parse(insertJsonMember(text, 'x', { n: 9 }, { ...options, position })).mcpServers);
		assert.deepEqual(keysAt(0), ['x', 'a', 'b']);
		assert.deepEqual(keysAt(1), ['a', 'x', 'b']);
		assert.deepEqual(keysAt(2), ['a', 'b', 'x']);
		assert.deepEqual(keysAt(99), ['a', 'b', 'x']);
		assert.deepEqual(keysAt(-1), ['x', 'a', 'b']);
		assert.deepEqual(keysAt(-3), ['x', 'a', 'b']);
		assert.deepEqual(keysAt(undefined), ['a', 'b', 'x']);
		assert.deepEqual(keysAt(1.5), ['a', 'b', 'x']);
	});

	it('insertJsonMember creates mcpServers when it is missing and fills an empty one', () => {
		const options = { position: 0, indent: '  ', eol: '\n', trailingNewline: true };
		const created = insertJsonMember('{"other": 1}', 'x', { n: 1 }, options);
		assert.equal(created, `${JSON.stringify({ other: 1, mcpServers: { x: { n: 1 } } }, null, 2)}\n`);
		const empty = insertJsonMember('{"mcpServers": {}, "other": 1}', 'x', { n: 1 }, options);
		assert.deepEqual(Object.keys(JSON.parse(empty)), ['mcpServers', 'other']);
		assert.deepEqual(JSON.parse(empty).mcpServers, { x: { n: 1 } });
	});

	it('insertJsonMember falls back to two spaces, LF, and no final newline when an option is missing', () => {
		assert.equal(insertJsonMember('{}', 'x', { n: 1 }), JSON.stringify({ mcpServers: { x: { n: 1 } } }, null, 2));
		assert.equal(insertJsonMember('{}', 'x', { n: 1 }, {}), JSON.stringify({ mcpServers: { x: { n: 1 } } }, null, 2));
		assert.equal(insertJsonMember('{}', 'x', { n: 1 }, { eol: '\r\n' }), JSON.stringify({ mcpServers: { x: { n: 1 } } }, null, 2).replace(/\n/g, '\r\n'));
	});

	it('insertJsonMember refuses a key that is already there and a file that is not an object', () => {
		assert.throws(() => insertJsonMember('{"mcpServers":{"x":{}}}', 'x', { n: 1 }, {}), (err) => err instanceof TypeError && !err.message.includes('"x"'));
		assert.throws(() => insertJsonMember('[]', 'x', {}, {}), TypeError);
		assert.throws(() => insertJsonMember('"text"', 'x', {}, {}), TypeError);
		assert.throws(() => insertJsonMember('null', 'x', {}, {}), TypeError);
		assert.throws(() => insertJsonMember('{"mcpServers": []}', 'x', {}, {}), TypeError);
		assert.throws(() => insertJsonMember('{"mcpServers": null}', 'x', {}, {}), TypeError);
		assert.throws(() => insertJsonMember(undefined, 'x', {}, {}), TypeError);
	});

	it('insertJsonMember throws a SyntaxError without content for text that does not parse', () => {
		const text = `{"mcpServers": {"a": {"env": {"PINECONE_API_KEY": ${FAKE.pinecone}}}}`;
		assert.throws(
			() => insertJsonMember(text, 'x', {}, {}),
			(err) => {
				assert.ok(err instanceof SyntaxError);
				assert.ok(!err.message.includes(FAKE.pinecone));
				assert.equal(describeError(err, 'f.json'), 'f.json is not valid JSON');
				return true;
			},
		);
	});

	it('a member named __proto__ is removed and put back like any other', () => {
		const text = '{\n  "mcpServers": {\n    "a": {},\n    "__proto__": {\n      "n": 1\n    }\n  }\n}\n';
		const removed = removeJsonMember(text, '__proto__');
		assert.equal(removed.position, 1);
		assert.deepEqual(removed.entry, { n: 1 });
		assert.equal(insertJsonMember(removed.text, '__proto__', removed.entry, removed), text);
	});

	it('removeJsonMember returns null for a missing key and throws a SyntaxError for text that does not parse', () => {
		const text = `${JSON.stringify(config(), null, 2)}\n`;
		assert.equal(removeJsonMember(text, 'nothing-here'), null);
		assert.equal(removeJsonMember(text, 'numStartups'), null);
		assert.equal(removeJsonMember(text, 'toString'), null);
		assert.equal(removeJsonMember(text, 'constructor'), null);
		assert.equal(removeJsonMember('{"other": 1}', 'a'), null);
		assert.equal(removeJsonMember('{"mcpServers": []}', 'a'), null);
		assert.equal(removeJsonMember('{"mcpServers": null}', 'a'), null);
		assert.equal(removeJsonMember('{"mcpServers": "a"}', 'a'), null);
		assert.equal(removeJsonMember('[]', 'a'), null);
		assert.equal(removeJsonMember('null', 'a'), null);
		assert.equal(removeJsonMember('"a"', 'a'), null);
		assert.equal(removeJsonMember('{"projects": {"mcpServers": {"a": {}}}}', 'a'), null);

		assert.throws(() => removeJsonMember('{"mcpServers": {', 'a'), SyntaxError);
		assert.throws(() => removeJsonMember('', 'a'), SyntaxError);
		assert.throws(() => removeJsonMember('\uFEFF{}', 'a'), SyntaxError);
		assert.throws(() => removeJsonMember('{"a": 1,}', 'a'), SyntaxError);
		assert.throws(() => removeJsonMember(undefined, 'a'), TypeError);
	});

	it('the SyntaxError of removeJsonMember carries no text of the file, in its message or its stack', () => {
		const bad = [
			`{"mcpServers": {"make-custom-app": {"env": {"PINECONE_API_KEY": ${FAKE.pinecone}}}}}`,
			`{"mcpServers": {"make-custom-app": {"env": {"OPENAI_API_KEY": "${FAKE.openai}"`,
			`${FAKE.otherToken}`,
			`{"a": "${FAKE.cursorToken}" "b": 1}`,
		];
		for (const text of bad) {
			assert.throws(
				() => removeJsonMember(text, 'make-custom-app'),
				(err) => {
					assert.ok(err instanceof SyntaxError);
					for (const value of [FAKE.pinecone, FAKE.openai, FAKE.otherToken, FAKE.cursorToken]) {
						assert.ok(!err.message.includes(value));
						assert.ok(!String(err.stack).includes(value));
					}
					assert.equal(err.cause, undefined);
					assert.equal(describeError(err, '/h/.claude.json'), '/h/.claude.json is not valid JSON');
					return true;
				},
			);
		}
	});
});

describe('redactOutput', () => {
	it('redactOutput replaces every secret', () => {
		const text = `PINECONE ${FAKE.pinecone} and ${FAKE.pinecone} again; OPENAI ${FAKE.openai}; ${FAKE.otherToken}`;
		const out = redactOutput(text, [FAKE.pinecone, FAKE.openai]);
		assert.equal(out, `PINECONE <redacted> and <redacted> again; OPENAI <redacted>; ${FAKE.otherToken}`);
		for (const value of [FAKE.pinecone, FAKE.openai]) assert.ok(!out.includes(value));
	});

	it('redactOutput replaces the longer secret first, so no tail of it stays visible', () => {
		assert.equal(redactOutput('abcdef abc', ['abc', 'abcdef']), '<redacted> <redacted>');
		assert.equal(redactOutput(`${FAKE.pinecone}${FAKE.conflictPinecone}`, [FAKE.pinecone, `${FAKE.pinecone}${FAKE.conflictPinecone}`]), '<redacted>');
	});

	it('redactOutput skips empty and non-string secrets and treats a secret as plain text', () => {
		assert.equal(redactOutput('keep this', ['', '   ', undefined, null, 5, {}]), 'keep this');
		assert.equal(redactOutput('a.b*c and axbbc', ['a.b*c']), '<redacted> and axbbc');
		assert.equal(redactOutput('x $& y', ['$&']), 'x <redacted> y');
		assert.equal(redactOutput('', ['x']), '');
		assert.equal(redactOutput('no secret here', []), 'no secret here');
	});

	it('redactOutput also removes the trimmed form of a secret that has spaces around it', () => {
		assert.equal(redactOutput('x token-1,y', [' token-1 ']), 'x <redacted>,y');
		assert.equal(redactOutput('x token-1 y', [' token-1 ']), 'x<redacted>y');
	});

	it('redactOutput works in one pass: a secret that occurs in the marker text or overlaps another one is covered', () => {
		assert.equal(redactOutput('hunter2 red', ['hunter2', 'red']), '<redacted> <redacted>');
		assert.equal(redactOutput('a red b', ['acted', 'red', 'redacted']), 'a <redacted> b');
		assert.equal(redactOutput('abcdef', ['abcd', 'cdef']), '<redacted>');
		assert.equal(redactOutput('abcdef abcd', ['cdef', 'abcd']), '<redacted> <redacted>');
		assert.equal(redactOutput('xx', ['x']), '<redacted><redacted>');
		assert.equal(redactOutput('aaa', ['aa']), '<redacted>');
		assert.equal(redactOutput('abababa-ab', ['ababa']), '<redacted>-ab');
		assert.equal(redactOutput('p@ss <redacted>', ['<redacted>', 'p@ss']), '<redacted> <redacted>');
		const out = redactOutput(`${FAKE.pinecone}${FAKE.openai} ${FAKE.openai}`, [FAKE.openai, FAKE.pinecone]);
		assert.equal(out, '<redacted><redacted> <redacted>');
	});

	it('redactOutput takes a Set, and refuses anything that is not a list so a secret is never printed by mistake', () => {
		assert.equal(redactOutput(`x ${FAKE.pinecone}`, new Set([FAKE.pinecone])), 'x <redacted>');
		assert.throws(() => redactOutput(`x ${FAKE.pinecone}`, undefined), TypeError);
		assert.throws(() => redactOutput(`x ${FAKE.pinecone}`, FAKE.pinecone), TypeError);
		assert.throws(() => redactOutput(`x ${FAKE.pinecone}`, { a: FAKE.pinecone }), (err) => err instanceof TypeError && !err.message.includes(FAKE.pinecone));
	});

	it('redactOutput turns a text that is not a string into text', () => {
		assert.equal(redactOutput(undefined, ['x']), '');
		assert.equal(redactOutput(null, ['x']), '');
		assert.equal(redactOutput(12345, ['234']), '1<redacted>5');
	});
});
