/**
 * Tests for legacy-cleanup-logic.js: the text and JSON transforms of the cleanup and its one error formatter.
 * The file moves HOME and the temp folders into a temporary root first (isolate-home). The functions under test are
 * pure, so every case runs on strings; only fake values are used (FAKE), never a real key. The plan tests build their
 * facts by hand. The facts carry no mode of ~/.claude.json, so no case depends on whether it is 0600 (Claude Code's
 * own file) or 0644 (one an installer created). Only the test helpers call dropOwnParts and ownRootsOf, on paths under
 * the temporary root, the way gatherFacts of the steps module will.
 */
const { assertIsolated, TEST_ROOT } = require('./isolate-home');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
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
} = require('../legacy-cleanup-logic');
const { SENTINEL_OPEN, SENTINEL_CLOSE, oldInstallPaths, ownRootsOf, dropOwnParts } = require('../legacy-install');
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

// ---------------------------------------------------------------------------------------------------------------
// The plan (Task 11). The facts are built by hand here; gatherFacts of the steps module will produce the same shape.
// ---------------------------------------------------------------------------------------------------------------

const PLAN_HOME = path.join(TEST_ROOT, 'plan-home');
const PLAN_PATHS = oldInstallPaths(PLAN_HOME);
const PLAN_PLUGIN_ROOT = path.join(PLAN_HOME, '.claude', 'plugins', 'cache', 'make-custom-app', 'make-custom-app', '3.0.0');
const CUSTOM_SERVER = path.join(PLAN_HOME, 'custom', 'mcp-server');
const DIGEST_A = '0123456789abcdef';
const tilde = (value) => value.replace(PLAN_HOME, '~');
const SECRETS_SAME = `pinecone-api-key: ${FAKE.pinecone}\nopenai-api-key: ${FAKE.openai}\npinecone-index-name: ${FAKE.index}\n`;
const SECRET_SEEDS = [FAKE.pinecone, FAKE.openai, FAKE.otherToken, FAKE.cursorToken, FAKE.conflictPinecone];
const BLOCK_FIX = `Remove the lines from ${SENTINEL_OPEN} to ${SENTINEL_CLOSE} by hand.`;

function skillFacts(dir, extra = {}) {
	return { path: dir, symlink: false, linkTarget: null, skillName: 'make-custom-app', version: '2.3.13', topNames: ['SKILL.md', 'mcp-server', 'scripts'], fileCount: 12, sizeBytes: 3456, ...extra };
}

function registrationOf(skillDir, extra = {}) {
	return {
		command: '/usr/bin/node',
		args: [path.join(skillDir, 'mcp-server', 'dist', 'index.js')],
		env: { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai, PINECONE_INDEX_NAME: FAKE.index },
		...extra,
	};
}

/** The entry without the plugin's own parts, as gatherFacts will supply it (the real functions of legacy-install). */
function judged(entry, lookalikes = []) {
	return dropOwnParts(entry, ownRootsOf(PLAN_PLUGIN_ROOT, lookalikes));
}

function claudeEntryFacts(entry, lookalikes) {
	return { file: PLAN_PATHS.claudeJson, entry, withoutOwn: judged(entry, lookalikes) };
}

function cursorFileFacts(servers, { compact = false, jsonc = false, utf8Exact = true } = {}) {
	const object = { mcpServers: servers };
	let text = compact ? JSON.stringify(object) : `${JSON.stringify(object, null, 2)}\n`;
	if (jsonc) text = `// Cursor settings\n${text}`;
	return {
		file: PLAN_PATHS.cursorMcp,
		format: jsonc ? 'jsonc' : 'json',
		text,
		utf8Exact,
		members: Object.entries(servers).map(([key, entry]) => ({ key, entry, withoutOwn: judged(entry) })),
	};
}

function fullFacts(overrides = {}) {
	return {
		home: PLAN_HOME,
		configDir: path.join(PLAN_HOME, '.claude'),
		configDirIsDefault: true,
		editor: 'claude',
		pluginRoot: PLAN_PLUGIN_ROOT,
		plugin: { recorded: true, userScope: true, enabled: true, installPath: PLAN_PLUGIN_ROOT, version: '3.0.0', runningFromInstall: true },
		claude: { binary: '/usr/local/bin/claude' },
		claudeSkill: skillFacts(PLAN_PATHS.claudeSkill),
		cursorSkill: skillFacts(PLAN_PATHS.cursorSkill),
		cursorRules: { path: PLAN_PATHS.cursorRules, names: ['make-custom-app.mdc'], fileCount: 1, sizeBytes: 800 },
		claudeEnv: { path: PLAN_PATHS.claudeEnv, text: INSTALLER_ENV_TEXT, mode: 0o644, utf8Exact: true, insideSkill: true },
		cursorEnv: { path: PLAN_PATHS.cursorEnv, text: INSTALLER_ENV_TEXT, mode: 0o644, utf8Exact: true, insideSkill: true },
		claudeEntry: claudeEntryFacts(registrationOf(PLAN_PATHS.claudeSkill)),
		cursorMembers: cursorFileFacts({ 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill) }),
		claudeMd: { file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text: `# Notes\n\n${INSTALLER_BLOCK}\n`, mode: 0o644, utf8Exact: true },
		secretsText: SECRETS_SAME,
		contextsDirs: [],
		...overrides,
	};
}

const idsOf = (plan) => plan.items.map((item) => item.id);
const itemOf = (plan, id) => plan.items.find((item) => item.id === id);

function withoutFingerprint(item) {
	const copy = { ...item };
	delete copy.fingerprint;
	return copy;
}

function deepFreeze(value) {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const inner of Object.values(value)) deepFreeze(inner);
	}
	return value;
}

function reverseKeys(value) {
	if (Array.isArray(value)) return value.map(reverseKeys);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reverseKeys(inner)]));
	return value;
}

describe('the plan constants', () => {
	it('SCHEMA, DECLINE_TTL_MS, and DIGEST_PATTERN', () => {
		assert.equal(SCHEMA, 1);
		assert.equal(DECLINE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
		assert.ok(DIGEST_PATTERN.test('0123456789abcdef'));
		for (const bad of ['0123456789abcde', '0123456789abcdef0', '0123456789ABCDEF', '0123456789abcdeg', '', ' 0123456789abcdef', '0123456789abcdef\n']) assert.ok(!DIGEST_PATTERN.test(bad), JSON.stringify(bad));
	});
});

describe('parseArgs', () => {
	const USAGE = 'Usage: cleanup-legacy.js --plan | --apply <digest> --groups claude[,cursor] | --restore [<backup>] | --decline <digest>';
	const DIGEST_ERROR = 'The digest must be 16 lowercase hexadecimal characters, as printed by --plan.';
	const NEEDS_GROUPS = '--apply needs --groups claude, cursor, or claude,cursor.';
	const ok = (mode, extra = {}) => ({ mode, digest: null, groups: [], backup: null, error: null, ...extra });
	const failed = (error) => ({ mode: null, digest: null, groups: [], backup: null, error });

	it('parseArgs: each mode and form', () => {
		assert.deepEqual(parseArgs(['--plan']), ok('plan'));
		assert.deepEqual(parseArgs(['--apply', DIGEST_A, '--groups', 'claude,cursor']), ok('apply', { digest: DIGEST_A, groups: ['claude', 'cursor'] }));
		assert.deepEqual(parseArgs([`--apply=${DIGEST_A}`, '--groups=cursor']), ok('apply', { digest: DIGEST_A, groups: ['cursor'] }));
		assert.deepEqual(parseArgs(['--groups', 'claude', '--apply', DIGEST_A]), ok('apply', { digest: DIGEST_A, groups: ['claude'] }));
		assert.deepEqual(parseArgs(['--apply', DIGEST_A, '--groups', 'cursor,claude,cursor']), ok('apply', { digest: DIGEST_A, groups: ['cursor', 'claude'] }));
		assert.deepEqual(parseArgs(['--restore']), ok('restore'));
		assert.deepEqual(parseArgs(['--restore', 'migration-backup-2026-10-30T08-05-09Z']), ok('restore', { backup: 'migration-backup-2026-10-30T08-05-09Z' }));
		assert.deepEqual(parseArgs(['--restore=/somewhere/backup']), ok('restore', { backup: '/somewhere/backup' }));
		assert.deepEqual(parseArgs(['--decline', DIGEST_A]), ok('decline', { digest: DIGEST_A }));
		assert.deepEqual(parseArgs([`--decline=${DIGEST_A}`]), ok('decline', { digest: DIGEST_A }));
	});

	it('parseArgs: the usage text for no mode, two modes, --groups without --apply, and an unknown argument', () => {
		const usageCases = [
			[],
			['--plan', '--restore'],
			['--plan', '--plan'],
			['--apply', DIGEST_A, '--groups', 'claude', '--plan'],
			['--restore', '--plan'],
			['--decline', DIGEST_A, '--restore'],
			['--plan', '--groups', 'claude'],
			['--restore', '--groups', 'claude'],
			['--decline', DIGEST_A, '--groups', 'claude'],
			['--groups', 'claude'],
			['--bogus'],
			['-h'],
			['--plan', 'extra'],
			['--plan=1'],
			['--restore='],
			['--apply', DIGEST_A, '--groups', 'claude', '--groups', 'cursor'],
			['--apply', DIGEST_A, '--groups', 'claude', 'extra'],
			['--apply', DIGEST_A, '--apply', DIGEST_A, '--groups', 'claude'],
		];
		for (const argv of usageCases) assert.deepEqual(parseArgs(argv), failed(USAGE), JSON.stringify(argv));
	});

	it('parseArgs: a digest that is not 16 lowercase hexadecimal characters, for --apply and --decline', () => {
		for (const bad of ['xyz', '0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0', '']) {
			assert.deepEqual(parseArgs(['--apply', bad, '--groups', 'claude']), failed(DIGEST_ERROR), bad);
			assert.deepEqual(parseArgs([`--apply=${bad}`, '--groups', 'claude']), failed(DIGEST_ERROR), bad);
			assert.deepEqual(parseArgs([`--decline=${bad}`]), failed(DIGEST_ERROR), bad);
			assert.deepEqual(parseArgs(['--decline', bad]), failed(DIGEST_ERROR), bad);
		}
		assert.deepEqual(parseArgs(['--apply']), failed(DIGEST_ERROR));
		assert.deepEqual(parseArgs(['--decline']), failed(DIGEST_ERROR));
		assert.deepEqual(parseArgs(['--apply', '--groups', 'claude']), failed(DIGEST_ERROR));
	});

	it('parseArgs: --apply needs a group list, and an unknown group is named', () => {
		assert.deepEqual(parseArgs(['--apply', DIGEST_A]), failed(NEEDS_GROUPS));
		assert.deepEqual(parseArgs(['--apply', DIGEST_A, '--groups']), failed(NEEDS_GROUPS));
		assert.deepEqual(parseArgs(['--apply', DIGEST_A, '--groups', '']), failed(NEEDS_GROUPS));
		assert.deepEqual(parseArgs(['--apply', DIGEST_A, '--groups=']), failed(NEEDS_GROUPS));
		assert.deepEqual(parseArgs(['--apply', DIGEST_A, '--groups', 'claude,all']), failed('Unknown group "all"; use claude, cursor, or claude,cursor.'));
		assert.deepEqual(parseArgs(['--apply', DIGEST_A, '--groups', 'Claude']), failed('Unknown group "Claude"; use claude, cursor, or claude,cursor.'));
		assert.deepEqual(parseArgs(['--apply', DIGEST_A, '--groups', 'claude,']), failed('Unknown group ""; use claude, cursor, or claude,cursor.'));
	});

	it('parseArgs refuses an argument list that is not strings', () => {
		assert.throws(() => parseArgs(undefined), TypeError);
		assert.throws(() => parseArgs(['--plan', 5]), TypeError);
	});
});

describe('secretsValue', () => {
	it('secretsValue: the last line wins, trimmed; missing and no text give null', () => {
		assert.equal(secretsValue('openai-api-key: one\nopenai-api-key:   two  \r\n', 'openai-api-key'), 'two');
		assert.equal(secretsValue('a: 1\n', 'openai-api-key'), null);
		assert.equal(secretsValue('', 'openai-api-key'), null);
		assert.equal(secretsValue(null, 'openai-api-key'), null);
		assert.equal(secretsValue(undefined, 'openai-api-key'), null);
		assert.equal(secretsValue('openai-api-key: x\n', ''), null);
		assert.equal(secretsValue('openai-api-key:\n', 'openai-api-key'), null);
		assert.equal(secretsValue('xopenai-api-key: x\n', 'openai-api-key'), null);
		assert.equal(secretsValue('a.b: x\naxb: y\n', 'a.b'), 'x');
	});

	it('secretsValue mirrors lastMatch: a placeholder line is skipped; a value that is not usable gives null', () => {
		assert.equal(secretsValue(`openai-api-key: ${FAKE.openai}\nopenai-api-key: your-openai-key\n`, 'openai-api-key'), FAKE.openai);
		assert.equal(secretsValue(`openai-api-key: ${FAKE.openai}\nopenai-api-key: <token>\n`, 'openai-api-key'), FAKE.openai);
		assert.equal(secretsValue(`openai-api-key: ${FAKE.openai}\nopenai-api-key: \${env:OPENAI_API_KEY}\n`, 'openai-api-key'), null);
		assert.equal(secretsValue('openai-api-key: your-openai-key\n', 'openai-api-key'), null);
	});
});

describe('secretSources', () => {
	const old = (extra) => fullFacts(extra);
	const labels = (facts) => secretSources(facts).map((source) => source.label);

	it('secretSources: the order, the labels, and the values of each source', () => {
		const sources = secretSources(old());
		assert.deepEqual(sources.map((source) => source.label), ['claude-registration', 'claude-env', 'cursor-registration:make-app-context', 'cursor-env']);
		const all = { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai, PINECONE_INDEX_NAME: FAKE.index };
		for (const source of sources) assert.deepEqual(source.values, all, source.label);
	});

	it('secretSources: Cursor registrations are listed by key, and only the old ones count', () => {
		const servers = {
			zeta: registrationOf(PLAN_PATHS.cursorSkill, { env: { OPENAI_API_KEY: FAKE.cursorToken } }),
			unrelated: { command: '/usr/bin/node', args: ['/opt/other/server.js'], env: { OPENAI_API_KEY: FAKE.otherToken } },
			plugin: { command: '/usr/bin/node', args: [path.join(PLAN_PLUGIN_ROOT, 'mcp', 'index.mjs')], env: { OPENAI_API_KEY: FAKE.otherToken } },
			parent: { command: '/usr/bin/node', args: [`${PLAN_PATHS.cursorSkill}/../other/index.js`], env: { OPENAI_API_KEY: FAKE.otherToken } },
			alpha: registrationOf(PLAN_PATHS.cursorSkill, { env: { PINECONE_API_KEY: FAKE.pinecone } }),
		};
		const sources = secretSources(old({ cursorMembers: cursorFileFacts(servers), claudeEntry: null, claudeEnv: null, cursorEnv: null }));
		assert.deepEqual(sources, [
			{ label: 'cursor-registration:alpha', values: { PINECONE_API_KEY: FAKE.pinecone } },
			{ label: 'cursor-registration:zeta', values: { OPENAI_API_KEY: FAKE.cursorToken } },
		]);
	});

	it('secretSources: a Claude entry that is not an old registration is no source, also when mcp-server-path is above the plugin', () => {
		const env = { OPENAI_API_KEY: FAKE.otherToken };
		const bundle = { command: '/usr/bin/node', args: [path.join(PLAN_PLUGIN_ROOT, 'mcp', 'index.mjs')], env };
		const unrelated = { command: '/usr/bin/node', args: ['/opt/other/server.js'], env };
		const parent = { command: '/usr/bin/node', args: [`${PLAN_PATHS.claudeSkill}/../other/index.js`], env };
		for (const entry of [bundle, unrelated, parent]) {
			for (const secretsText of ['', `mcp-server-path: ${PLAN_HOME}\n`, `mcp-server-path: ${path.join(PLAN_HOME, '.claude')}\n`, `mcp-server-path: ${PLAN_PLUGIN_ROOT}\n`]) {
				const facts = old({ claudeEntry: claudeEntryFacts(entry), claudeEnv: null, cursorMembers: null, cursorEnv: null, secretsText });
				assert.deepEqual(labels(facts), [], `${entry.args[0]} with ${JSON.stringify(secretsText)}`);
			}
		}
		const withoutJudgement = { file: PLAN_PATHS.claudeJson, entry: registrationOf(PLAN_PATHS.claudeSkill) };
		assert.deepEqual(labels(old({ claudeEntry: withoutJudgement, claudeEnv: null, cursorMembers: null, cursorEnv: null })), []);
	});

	it('secretSources: an entry under mcp-server-path is a source', () => {
		const entry = { command: '/usr/bin/node', args: [path.join(CUSTOM_SERVER, 'dist', 'index.js')], env: { OPENAI_API_KEY: FAKE.otherToken } };
		const facts = old({ claudeEntry: claudeEntryFacts(entry), claudeEnv: null, cursorMembers: null, cursorEnv: null, secretsText: `mcp-server-path: ${CUSTOM_SERVER}\n` });
		assert.deepEqual(secretSources(facts), [{ label: 'claude-registration', values: { OPENAI_API_KEY: FAKE.otherToken } }]);
		assert.deepEqual(labels({ ...facts, secretsText: '' }), []);
	});

	it('secretSources: only the three names, trimmed, and only usable values', () => {
		const env = {
			PINECONE_API_KEY: `  ${FAKE.pinecone}  `,
			OPENAI_API_KEY: 'your-openai-key',
			PINECONE_INDEX_NAME: '',
			OTHER_TOKEN: FAKE.otherToken,
		};
		const text = `PINECONE_API_KEY= ${FAKE.pinecone} \nOPENAI_API_KEY=\${env:OPENAI_API_KEY}\nPINECONE_INDEX_NAME=\nOTHER_TOKEN=${FAKE.otherToken}\n`;
		const facts = old({
			claudeEntry: claudeEntryFacts(registrationOf(PLAN_PATHS.claudeSkill, { env })),
			claudeEnv: { path: PLAN_PATHS.claudeEnv, text, mode: 0o644, utf8Exact: true, insideSkill: true },
			cursorMembers: null,
			cursorEnv: null,
		});
		assert.deepEqual(secretSources(facts), [
			{ label: 'claude-registration', values: { PINECONE_API_KEY: FAKE.pinecone } },
			{ label: 'claude-env', values: { PINECONE_API_KEY: FAKE.pinecone } },
		]);
		const odd = old({ claudeEntry: claudeEntryFacts(registrationOf(PLAN_PATHS.claudeSkill, { env: { PINECONE_API_KEY: 5, OPENAI_API_KEY: `${FAKE.openai}\nx`, PINECONE_INDEX_NAME: null } })), claudeEnv: null, cursorMembers: null, cursorEnv: null });
		assert.deepEqual(secretSources(odd), [{ label: 'claude-registration', values: {} }]);
		const noEnv = old({ claudeEntry: claudeEntryFacts({ command: '/usr/bin/node', args: [path.join(PLAN_PATHS.claudeSkill, 'mcp-server', 'dist', 'index.js')] }), claudeEnv: null, cursorMembers: null, cursorEnv: null });
		assert.deepEqual(secretSources(noEnv), [{ label: 'claude-registration', values: {} }]);
	});

	it('secretSources: a symlinked skill folder still gives its .env as a source, and no facts give no sources', () => {
		const linked = old({ claudeSkill: skillFacts(PLAN_PATHS.claudeSkill, { symlink: true, linkTarget: path.join(TEST_ROOT, 'elsewhere') }) });
		assert.ok(labels(linked).includes('claude-env'));
		assert.deepEqual(secretSources(old({ claudeEntry: null, claudeEnv: null, cursorMembers: null, cursorEnv: null })), []);
	});
});

describe('compareSecrets', () => {
	const A = FAKE.pinecone;
	const O1 = FAKE.openai;
	const O2 = FAKE.otherToken;

	it('compareSecrets: added and absent, the first usable source wins, and a conflict names the labels only', () => {
		const sources = [
			{ label: 'claude-registration', values: { PINECONE_API_KEY: A, OPENAI_API_KEY: O1 } },
			{ label: 'claude-env', values: { PINECONE_API_KEY: A, OPENAI_API_KEY: O2 } },
			{ label: 'cursor-env', values: { OPENAI_API_KEY: O1 } },
		];
		const result = compareSecrets(sources, '');
		assert.deepEqual(result.updates, { 'pinecone-api-key': A, 'openai-api-key': O1 });
		assert.deepEqual(result.status, { 'pinecone-api-key': 'added', 'openai-api-key': 'conflict', 'pinecone-index-name': 'absent' });
		assert.deepEqual(result.conflicts, [{ key: 'openai-api-key', used: 'claude-registration', others: ['claude-env'] }]);
		assert.equal(result.finalValue('pinecone-api-key'), A);
		assert.equal(result.finalValue('openai-api-key'), O1);
		assert.equal(result.finalValue('pinecone-index-name'), null);
		assert.equal(result.finalValue('jira-api-token'), null);
		assert.ok(!JSON.stringify(result.conflicts).includes(O2));
	});

	it('compareSecrets: same, and an existing value always wins', () => {
		const sources = [{ label: 'claude-env', values: { PINECONE_API_KEY: A, OPENAI_API_KEY: O1, PINECONE_INDEX_NAME: FAKE.index } }];
		const same = compareSecrets(sources, SECRETS_SAME);
		assert.deepEqual(same.updates, {});
		assert.deepEqual(same.status, { 'pinecone-api-key': 'same', 'openai-api-key': 'same', 'pinecone-index-name': 'same' });
		assert.deepEqual(same.conflicts, []);
		assert.equal(same.finalValue('openai-api-key'), O1);

		const existing = compareSecrets(
			[
				{ label: 'claude-registration', values: { OPENAI_API_KEY: O1 } },
				{ label: 'claude-env', values: { OPENAI_API_KEY: O1 } },
				{ label: 'cursor-env', values: { OPENAI_API_KEY: A } },
			],
			`openai-api-key: ${O2}\n`,
		);
		assert.deepEqual(existing.updates, {});
		assert.equal(existing.status['openai-api-key'], 'conflict');
		assert.deepEqual(existing.conflicts, [{ key: 'openai-api-key', used: 'secrets-file', others: ['claude-registration', 'claude-env', 'cursor-env'] }]);
		assert.equal(existing.finalValue('openai-api-key'), O2);

		const noSource = compareSecrets([], SECRETS_SAME);
		assert.deepEqual(noSource.status, { 'pinecone-api-key': 'same', 'openai-api-key': 'same', 'pinecone-index-name': 'same' });
		assert.equal(noSource.finalValue('pinecone-api-key'), A);
	});

	it('compareSecrets: a reference or a placeholder is not usable, its status is placeholder, and a usable value after it still wins', () => {
		const reference = compareSecrets([{ label: 'claude-registration', values: { OPENAI_API_KEY: '${env:OPENAI_API_KEY}', PINECONE_API_KEY: 'your-pinecone-key', PINECONE_INDEX_NAME: '  ' } }], '');
		assert.deepEqual(reference.updates, {});
		assert.deepEqual(reference.status, { 'pinecone-api-key': 'placeholder', 'openai-api-key': 'placeholder', 'pinecone-index-name': 'absent' });
		assert.equal(reference.finalValue('openai-api-key'), null);

		const later = compareSecrets(
			[
				{ label: 'claude-registration', values: { OPENAI_API_KEY: '${env:OPENAI_API_KEY}' } },
				{ label: 'claude-env', values: { OPENAI_API_KEY: O1 } },
			],
			'',
		);
		assert.deepEqual(later.updates, { 'openai-api-key': O1 });
		assert.equal(later.status['openai-api-key'], 'added');
		assert.deepEqual(later.conflicts, []);

		const withExisting = compareSecrets([{ label: 'claude-registration', values: { OPENAI_API_KEY: '${env:OPENAI_API_KEY}' } }], `openai-api-key: ${O1}\n`);
		assert.equal(withExisting.status['openai-api-key'], 'same');
		assert.deepEqual(withExisting.updates, {});

		const brokenExisting = compareSecrets([{ label: 'claude-env', values: { OPENAI_API_KEY: O1 } }], 'openai-api-key: ${env:OPENAI_API_KEY}\n');
		assert.deepEqual(brokenExisting.updates, { 'openai-api-key': O1 });
	});

	it('compareSecrets: a value with spaces is trimmed, and two sources with the same value are not a conflict', () => {
		const result = compareSecrets([{ label: 'a', values: { OPENAI_API_KEY: ` ${O1} ` } }, { label: 'b', values: { OPENAI_API_KEY: O1 } }], null);
		assert.deepEqual(result.updates, { 'openai-api-key': O1 });
		assert.equal(result.status['openai-api-key'], 'added');
		assert.deepEqual(result.conflicts, []);
	});

	it('compareSecrets does not change what it is given', () => {
		const sources = deepFreeze([{ label: 'claude-env', values: { OPENAI_API_KEY: O1 } }]);
		const result = compareSecrets(sources, 'jira-email: someone@make.com\n');
		assert.deepEqual(result.updates, { 'openai-api-key': O1 });
	});
});

describe('fingerprint', () => {
	it('fingerprint ignores statuses, sizes, values, numStartups, .DS_Store, and the claude path', () => {
		const directory = { kind: 'directory', id: 'claude.skill-dir', symlink: false, linkTarget: null, skillName: 'make-custom-app', version: '2.3.13', topNames: ['scripts', 'SKILL.md', '.DS_Store', 'mcp-server'] };
		assert.deepEqual(fingerprint(directory), { symlink: false, linkTarget: null, skillName: 'make-custom-app', version: '2.3.13', topNames: ['SKILL.md', 'mcp-server', 'scripts'] });
		const noise = { status: 'manual', reason: 'x', fileCount: 1, sizeBytes: 2, numStartups: 99, claudePath: '/other/claude', binary: '/other/claude', topNames: ['mcp-server', 'SKILL.md', 'scripts'] };
		assert.deepEqual(fingerprint({ ...directory, ...noise }), fingerprint(directory));
		assert.notDeepEqual(fingerprint({ ...directory, topNames: [...directory.topNames, 'extra'] }), fingerprint(directory));
		assert.notDeepEqual(fingerprint({ ...directory, version: '2.3.12' }), fingerprint(directory));
		assert.notDeepEqual(fingerprint({ ...directory, symlink: true, linkTarget: '/t' }), fingerprint(directory));

		const entry = { kind: 'claude-mcp-entry', entry: registrationOf(PLAN_PATHS.claudeSkill) };
		const hashed = fingerprint(entry);
		assert.match(hashed, /^[0-9a-f]{64}$/);
		const changedValues = { ...entry, entry: registrationOf(PLAN_PATHS.claudeSkill, { env: { PINECONE_API_KEY: FAKE.otherToken, OPENAI_API_KEY: FAKE.cursorToken, PINECONE_INDEX_NAME: 'x' } }) };
		assert.equal(fingerprint({ ...changedValues, numStartups: 4, status: 'blocked' }), hashed);
		assert.equal(fingerprint({ kind: 'json-member', entry: entry.entry }), hashed);
		assert.notEqual(fingerprint({ ...entry, entry: registrationOf(PLAN_PATHS.claudeSkill, { command: '/usr/bin/other' }) }), hashed);
		assert.notEqual(fingerprint({ ...entry, entry: registrationOf(PLAN_PATHS.claudeSkill, { env: { OPENAI_API_KEY: 'x' } }) }), hashed);
		assert.notEqual(fingerprint({ ...entry, entry: registrationOf(PLAN_PATHS.claudeSkill, { args: ['/other.js'] }) }), hashed);
		for (const seed of SECRET_SEEDS) assert.ok(!hashed.includes(seed));
	});

	it('fingerprint of a registration is a hash of its identity: option values, urls, and headers are cut or left out, and a value that is not an object has none', () => {
		const entry = {
			type: 'stdio',
			command: `TOKEN=${FAKE.otherToken} node`,
			args: ['/opt/server.js', `--token=${FAKE.otherToken}`, '-y', `https://example.test/mcp?key=${FAKE.cursorToken}`, 5],
			env: { OPENAI_API_KEY: FAKE.openai },
			url: `https://example.test/?key=${FAKE.cursorToken}`,
			headers: { Authorization: `Bearer ${FAKE.otherToken}` },
			cwd: '/somewhere',
		};
		const identity = fingerprint({ kind: 'claude-mcp-entry', entry });
		assert.equal(identity, sha256(canonicalJson({ type: 'stdio', command: 'TOKEN=', args: ['/opt/server.js', '--token=', '-y', 'https://example.test/mcp?key=', null], env: { OPENAI_API_KEY: 'OPENAI_API_KEY' } })));
		for (const seed of SECRET_SEEDS) assert.ok(!identity.includes(seed), seed);
		assert.notEqual(fingerprint({ kind: 'json-member', entry: { ...entry, args: ['/opt/other.js'] } }), identity);
		assert.equal(fingerprint({ kind: 'claude-mcp-entry', entry: 'a string' }), null);
		assert.equal(fingerprint({ kind: 'claude-mcp-entry', entry: [FAKE.otherToken] }), null);
		assert.equal(fingerprint({ kind: 'claude-mcp-entry' }), null);
		assert.equal(fingerprint({ kind: 'claude-mcp-entry', entry: {} }), sha256(canonicalJson({})));
	});

	it('fingerprint: env-file known names, a hash of the other names, and the line count; rules folder names; sentinel hash and line', () => {
		assert.deepEqual(fingerprint({ kind: 'env-file', names: ['PINECONE_API_KEY', 'OPENAI_API_KEY'], lineCount: 6, value: FAKE.openai, mode: 0o644 }), { names: ['OPENAI_API_KEY', 'PINECONE_API_KEY'], others: null, lineCount: 6 });
		assert.deepEqual(fingerprint({ kind: 'env-file' }), { names: [], others: null, lineCount: 0 });
		const withOthers = fingerprint({ kind: 'env-file', names: ['OPENAI_API_KEY', FAKE.otherToken, 'B_NAME'], lineCount: 3 });
		assert.deepEqual(withOthers, { names: ['OPENAI_API_KEY'], others: sha256(canonicalJson([FAKE.otherToken, 'B_NAME'].sort())), lineCount: 3 });
		assert.ok(!JSON.stringify(withOthers).includes(FAKE.otherToken));
		assert.notDeepEqual(fingerprint({ kind: 'env-file', names: ['OPENAI_API_KEY', 'C_NAME'], lineCount: 3 }), withOthers);
		assert.deepEqual(fingerprint({ kind: 'directory', id: 'cursor.rules-dir', names: ['make-custom-app.mdc', '.DS_Store', 'a.mdc'], sizeBytes: 9 }), ['a.mdc', 'make-custom-app.mdc']);
		assert.equal(fingerprint({ kind: 'text-block', removedText: 'x\n', lineStart: 3, status: 'ready' }), `${sha256('x\n')}:3`);
		assert.equal(fingerprint({ kind: 'text-block', removedText: null, lineStart: null, blockStatus: 'unclosed' }), 'unclosed');
		assert.equal(fingerprint({ kind: 'text-block' }), 'none');
		assert.throws(() => fingerprint({ kind: 'nope' }), TypeError);
		assert.throws(() => fingerprint(null), TypeError);
	});
});

describe('planDigest', () => {
	const item = (extra = {}) => ({ id: 'claude.skill-dir', kind: 'directory', path: '/p/skill', action: 'move', status: 'ready', fingerprint: { topNames: ['a'] }, ...extra });

	it('planDigest is 16 hexadecimal characters, stable for the same items and for another key order', () => {
		const items = [item(), item({ id: 'cursor.rules-dir', fingerprint: ['a.mdc'] })];
		const digest = planDigest(items);
		assert.match(digest, DIGEST_PATTERN);
		assert.equal(planDigest(structuredClone(items)), digest);
		assert.equal(planDigest(items.map((entry) => reverseKeys(entry))), digest);
		assert.notEqual(planDigest([...items].reverse()), digest);
		assert.match(planDigest([]), DIGEST_PATTERN);
		assert.throws(() => planDigest(null), TypeError);
	});

	it('planDigest changes when the fingerprint, the id, the path, the kind, the action, or the status of an item changes', () => {
		const digest = planDigest([item()]);
		const changes = [
			{ fingerprint: { topNames: ['a', 'b'] } },
			{ id: 'cursor.skill-dir' },
			{ path: '/p/other' },
			{ kind: 'env-file' },
			{ action: 'delete' },
			{ status: 'manual' },
		];
		for (const change of changes) assert.notEqual(planDigest([item(change)]), digest, JSON.stringify(change));
	});

	it('planDigest counts blocked as ready, so a plan made without the claude search has the digest of the plan the user confirmed', () => {
		assert.equal(planDigest([item({ status: 'blocked' })]), planDigest([item({ status: 'ready' })]));
		assert.notEqual(planDigest([item({ status: 'blocked' })]), planDigest([item({ status: 'manual' })]));
	});

	it('planDigest does not change with a field it does not name', () => {
		const digest = planDigest([item()]);
		assert.equal(planDigest([item({ reason: 'r', fix: 'f', fileCount: 1, sizeBytes: 2, extraFiles: [], numStartups: 5, secrets: { 'openai-api-key': 'added' } })]), digest);
	});
});

describe('buildPlan: the items', () => {
	const ALL_IDS = [
		'claude.mcp-entry',
		'claude.sentinel',
		'claude.env-file',
		'claude.skill-dir',
		'cursor.mcp-entry.make-app-context',
		'cursor.env-file',
		'cursor.skill-dir',
		'cursor.rules-dir',
	];

	it('buildPlan: both editors, ready everywhere, the Claude items in apply order and the Cursor items after them', () => {
		const facts = fullFacts({ secretsText: '', contextsDirs: [] });
		const plan = buildPlan(facts);
		assert.deepEqual(Object.keys(plan), ['schema', 'digest', 'home', 'editor', 'plugin', 'claude', 'groups', 'confirmRequired', 'secrets', 'items', 'notices', 'backupRoot', 'lines']);
		assert.equal(plan.schema, 1);
		assert.match(plan.digest, DIGEST_PATTERN);
		assert.equal(plan.digest, planDigest(plan.items));
		assert.equal(plan.home, PLAN_HOME);
		assert.equal(plan.editor, 'claude');
		assert.deepEqual(plan.plugin, { recorded: true, userScope: true, enabled: true, runningFromInstall: true, version: '3.0.0' });
		assert.deepEqual(plan.claude, { binary: '/usr/local/bin/claude' });
		assert.deepEqual(idsOf(plan), ALL_IDS);
		assert.deepEqual(plan.groups, [
			{ id: 'claude', confirm: 'after-plan', ready: 4, blocked: 0, manual: 0 },
			{ id: 'cursor', confirm: 'after-cursor-check', ready: 4, blocked: 0, manual: 0 },
		]);
		assert.equal(plan.confirmRequired, true);
		assert.deepEqual(plan.secrets, { copy: ['pinecone-api-key', 'openai-api-key', 'pinecone-index-name'], conflicts: [] });
		assert.equal(plan.backupRoot, path.join(PLAN_HOME, '.make-custom-app'));
		assert.deepEqual(plan.lines, planLines(plan));
		for (const item of plan.items) {
			assert.equal(item.status, 'ready', item.id);
			assert.equal(item.reason, null, item.id);
			assert.equal(item.fix, null, item.id);
			assert.ok(path.isAbsolute(item.path), item.id);
			assert.equal(item.group, item.id.split('.')[0]);
			assert.ok(item.fingerprint !== undefined, item.id);
		}

		const serverClaude = path.join(PLAN_PATHS.claudeSkill, 'mcp-server', 'dist', 'index.js');
		const serverCursor = path.join(PLAN_PATHS.cursorSkill, 'mcp-server', 'dist', 'index.js');
		const envKeys = ['PINECONE_API_KEY', 'OPENAI_API_KEY', 'PINECONE_INDEX_NAME'];
		const secretStatus = { 'pinecone-api-key': 'added', 'openai-api-key': 'added', 'pinecone-index-name': 'added' };
		const envNames = ['PINECONE_API_KEY', 'PINECONE_INDEX_NAME', 'OPENAI_API_KEY'];
		const common = { reason: null, fix: null, status: 'ready' };
		assert.deepEqual(withoutFingerprint(itemOf(plan, 'claude.mcp-entry')), { id: 'claude.mcp-entry', group: 'claude', kind: 'claude-mcp-entry', path: PLAN_PATHS.claudeJson, action: 'remove-entry', ...common, key: 'make-custom-app', serverPath: serverClaude, envKeys });
		assert.deepEqual(withoutFingerprint(itemOf(plan, 'claude.sentinel')), { id: 'claude.sentinel', group: 'claude', kind: 'text-block', path: PLAN_PATHS.claudeMd, action: 'remove-block', ...common, lines: [3, 7], edited: false });
		assert.deepEqual(withoutFingerprint(itemOf(plan, 'claude.env-file')), { id: 'claude.env-file', group: 'claude', kind: 'env-file', path: PLAN_PATHS.claudeEnv, action: 'delete', ...common, keys: envNames, other: 0, secrets: secretStatus });
		assert.deepEqual(withoutFingerprint(itemOf(plan, 'claude.skill-dir')), { id: 'claude.skill-dir', group: 'claude', kind: 'directory', path: PLAN_PATHS.claudeSkill, action: 'move', ...common, symlink: false, version: '2.3.13', fileCount: 12, sizeBytes: 3456, extraFiles: [] });
		assert.deepEqual(withoutFingerprint(itemOf(plan, 'cursor.mcp-entry.make-app-context')), { id: 'cursor.mcp-entry.make-app-context', group: 'cursor', kind: 'json-member', path: PLAN_PATHS.cursorMcp, action: 'remove-entry', ...common, key: 'make-app-context', serverPath: serverCursor, envKeys, reformats: false });
		assert.deepEqual(withoutFingerprint(itemOf(plan, 'cursor.env-file')), { id: 'cursor.env-file', group: 'cursor', kind: 'env-file', path: PLAN_PATHS.cursorEnv, action: 'delete', ...common, keys: envNames, other: 0, secrets: secretStatus });
		assert.deepEqual(withoutFingerprint(itemOf(plan, 'cursor.skill-dir')), { id: 'cursor.skill-dir', group: 'cursor', kind: 'directory', path: PLAN_PATHS.cursorSkill, action: 'move', ...common, symlink: false, version: '2.3.13', fileCount: 12, sizeBytes: 3456, extraFiles: [] });
		assert.deepEqual(withoutFingerprint(itemOf(plan, 'cursor.rules-dir')), { id: 'cursor.rules-dir', group: 'cursor', kind: 'directory', path: PLAN_PATHS.cursorRules, action: 'move', ...common, symlink: false, version: null, fileCount: 1, sizeBytes: 800, extraFiles: [] });

		assert.equal(itemOf(plan, 'claude.sentinel').fingerprint, `${sha256(`\n${INSTALLER_BLOCK}\n`)}:3`);
		assert.deepEqual(itemOf(plan, 'claude.env-file').fingerprint, { names: ['OPENAI_API_KEY', 'PINECONE_API_KEY', 'PINECONE_INDEX_NAME'], others: null, lineCount: 6 });
		assert.deepEqual(itemOf(plan, 'claude.skill-dir').fingerprint, { symlink: false, linkTarget: null, skillName: 'make-custom-app', version: '2.3.13', topNames: ['SKILL.md', 'mcp-server', 'scripts'] });
		assert.deepEqual(itemOf(plan, 'cursor.rules-dir').fingerprint, ['make-custom-app.mdc']);
		assert.equal(itemOf(plan, 'claude.mcp-entry').fingerprint, fingerprint({ kind: 'claude-mcp-entry', entry: registrationOf(PLAN_PATHS.claudeSkill) }));
		assert.match(itemOf(plan, 'claude.mcp-entry').fingerprint, /^[0-9a-f]{64}$/);
	});

	it('buildPlan: the plan block and the groups list only what exists, and the Claude-only and Cursor-only homes work', () => {
		const claudeOnly = buildPlan(fullFacts({ editor: 'claude', cursorSkill: null, cursorRules: null, cursorEnv: null, cursorMembers: null }));
		assert.deepEqual(idsOf(claudeOnly), ['claude.mcp-entry', 'claude.sentinel', 'claude.env-file', 'claude.skill-dir']);
		assert.deepEqual(claudeOnly.groups, [{ id: 'claude', confirm: 'after-plan', ready: 4, blocked: 0, manual: 0 }]);
		const cursorOnly = buildPlan(fullFacts({ editor: 'cursor', claudeSkill: null, claudeEnv: null, claudeEntry: null, claudeMd: null }));
		assert.deepEqual(idsOf(cursorOnly), ['cursor.mcp-entry.make-app-context', 'cursor.env-file', 'cursor.skill-dir', 'cursor.rules-dir']);
		assert.deepEqual(cursorOnly.groups, [{ id: 'cursor', confirm: 'after-cursor-check', ready: 4, blocked: 0, manual: 0 }]);
		assert.equal(cursorOnly.editor, 'cursor');
		const neither = buildPlan(fullFacts({ editor: null, plugin: { recorded: false, userScope: false, enabled: false, installPath: null, version: null, runningFromInstall: false }, claude: { binary: null } }));
		assert.equal(neither.editor, null);
		assert.deepEqual(neither.plugin, { recorded: false, userScope: false, enabled: false, runningFromInstall: false, version: null });
		assert.deepEqual(neither.claude, { binary: null });
	});

	it('buildPlan: several Cursor members are listed by key, and a member that is not an old registration is no item', () => {
		const servers = {
			zeta: registrationOf(PLAN_PATHS.cursorSkill),
			unrelated: { command: '/usr/bin/node', args: ['/opt/other/server.js'] },
			plugin: { command: '/usr/bin/node', args: [path.join(PLAN_PLUGIN_ROOT, 'mcp', 'index.mjs')] },
			parent: { command: '/usr/bin/node', args: [`${PLAN_PATHS.cursorSkill}/../other/index.js`] },
			alpha: registrationOf(PLAN_PATHS.cursorSkill),
		};
		const plan = buildPlan(fullFacts({ cursorMembers: cursorFileFacts(servers) }));
		assert.deepEqual(idsOf(plan).filter((id) => id.startsWith('cursor.mcp-entry')), ['cursor.mcp-entry.alpha', 'cursor.mcp-entry.zeta']);
		const forward = buildPlan(fullFacts({ cursorMembers: cursorFileFacts({ alpha: servers.alpha, zeta: servers.zeta }) }));
		const backward = buildPlan(fullFacts({ cursorMembers: cursorFileFacts({ zeta: servers.zeta, alpha: servers.alpha }) }));
		assert.deepEqual(idsOf(forward), idsOf(backward));
		assert.equal(forward.digest, backward.digest);
		const noJudgement = fullFacts({ cursorMembers: { ...cursorFileFacts({ x: registrationOf(PLAN_PATHS.cursorSkill) }), members: [{ key: 'x', entry: registrationOf(PLAN_PATHS.cursorSkill) }] } });
		assert.deepEqual(idsOf(buildPlan(noJudgement)).filter((id) => id.startsWith('cursor.mcp-entry')), []);
	});

	it('buildPlan: serverPath is the first part that points into an old skill folder or under mcp-server-path, else the first argument', () => {
		const inSkill = path.join(PLAN_PATHS.claudeSkill, 'mcp-server', 'dist', 'index.js');
		const cases = [
			[{ command: '/usr/bin/node', args: ['--flag', inSkill] }, inSkill],
			[{ command: path.join(PLAN_PATHS.claudeSkill, 'bin', 'server'), args: ['--flag'] }, path.join(PLAN_PATHS.claudeSkill, 'bin', 'server')],
			[{ command: '/usr/bin/node', args: [inSkill, '--flag'] }, inSkill],
		];
		for (const [entry, expected] of cases) {
			const item = itemOf(buildPlan(fullFacts({ claudeEntry: claudeEntryFacts(entry) })), 'claude.mcp-entry');
			assert.equal(item.status, 'ready');
			assert.equal(item.serverPath, expected);
		}
		const under = { command: '/usr/bin/node', args: ['--flag', path.join(CUSTOM_SERVER, 'dist', 'index.js')] };
		const viaPath = itemOf(buildPlan(fullFacts({ claudeEntry: claudeEntryFacts(under), secretsText: `mcp-server-path: ${CUSTOM_SERVER}\n` })), 'claude.mcp-entry');
		assert.equal(viaPath.serverPath, under.args[1]);
		const lone = itemOf(buildPlan(fullFacts({ claudeEntry: claudeEntryFacts({ command: '/usr/bin/node', args: ['/opt/a.js', '/opt/b.js'] }) })), 'claude.mcp-entry');
		assert.equal(lone.serverPath, '/opt/a.js');
		const flags = { command: '/usr/bin/node', args: [`--token=${FAKE.otherToken}`, '-y', `NAME=${FAKE.cursorToken}`, '/opt/x.js'] };
		const flagged = buildPlan(fullFacts({ claudeEntry: claudeEntryFacts(flags), cursorMembers: cursorFileFacts({ other: { ...flags, args: flags.args.slice(0, 3) }, 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill) }) }));
		assert.equal(itemOf(flagged, 'claude.mcp-entry').serverPath, '/opt/x.js');
		const onlyFlags = buildPlan(fullFacts({ claudeEntry: claudeEntryFacts({ command: '/usr/bin/node', args: flags.args.slice(0, 3) }) }));
		assert.equal(itemOf(onlyFlags, 'claude.mcp-entry').serverPath, '/usr/bin/node');
		for (const plan of [flagged, onlyFlags]) for (const seed of [FAKE.otherToken, FAKE.cursorToken]) assert.ok(!JSON.stringify(plan).includes(seed), seed);
		const none = itemOf(buildPlan(fullFacts({ claudeEntry: claudeEntryFacts({ env: {} }) })), 'claude.mcp-entry');
		assert.equal(none.status, 'manual');
		assert.equal(none.serverPath, null);
		assert.match(none.reason, /\(server unknown\)\.$/);
		const text = itemOf(buildPlan(fullFacts({ claudeEntry: claudeEntryFacts('not an entry') })), 'claude.mcp-entry');
		assert.equal(text.status, 'manual');
		assert.deepEqual(text.envKeys, []);
	});
});

describe('buildPlan: the Claude registration', () => {
	const REASON_NOT_OLD = (server) => `This make-custom-app entry in ~/.claude.json does not point into an old skill folder (server ${server}).`;
	const FIX_NOT_OLD = 'If it belongs to the old skill, remove the "make-custom-app" entry from ~/.claude.json by hand; the cleanup leaves it.';

	it('buildPlan: the Claude entry for the plugin bundle and for an unrelated path is manual and never ready, also with an mcp-server-path that is an ancestor of the plugin', () => {
		const bundle = path.join(PLAN_PLUGIN_ROOT, 'mcp', 'index.mjs');
		const env = { OPENAI_API_KEY: FAKE.otherToken };
		const cases = [
			[bundle, { command: '/usr/bin/node', args: [bundle], env }],
			['/opt/other/server.js', { command: '/usr/bin/node', args: ['/opt/other/server.js'], env }],
			[`${PLAN_PATHS.claudeSkill}/../other/index.js`, { command: '/usr/bin/node', args: [`${PLAN_PATHS.claudeSkill}/../other/index.js`], env }],
		];
		const secretsTexts = ['', `mcp-server-path: ${PLAN_HOME}\n`, `mcp-server-path: ${path.join(PLAN_HOME, '.claude')}\n`, `mcp-server-path: ${path.join(PLAN_HOME, '.claude', 'plugins')}\n`, `mcp-server-path: ${PLAN_PLUGIN_ROOT}\n`];
		for (const [server, entry] of cases) {
			for (const secretsText of secretsTexts) {
				const plan = buildPlan(fullFacts({ claudeEntry: claudeEntryFacts(entry), secretsText }));
				const item = itemOf(plan, 'claude.mcp-entry');
				assert.equal(item.status, 'manual', `${server} with ${JSON.stringify(secretsText)}`);
				assert.equal(item.action, 'remove-entry');
				assert.equal(item.serverPath, server);
				assert.equal(item.reason, REASON_NOT_OLD(server));
				assert.equal(item.fix, FIX_NOT_OLD);
				assert.equal(plan.notices.some((notice) => notice.kind === 'claude-backup-copy'), false);
			}
		}
	});

	it('buildPlan: a skills-dir plugin named make-custom-app is no old install: no folder items, and its own registration is manual', () => {
		const lookalike = PLAN_PATHS.claudeSkill;
		const entry = { command: '/usr/bin/node', args: [path.join(lookalike, 'mcp', 'index.mjs')], env: { OPENAI_API_KEY: FAKE.otherToken } };
		for (const secretsText of ['', `mcp-server-path: ${PLAN_HOME}\n`, `mcp-server-path: ${lookalike}\n`]) {
			const plan = buildPlan(fullFacts({ claudeSkill: null, claudeEnv: null, claudeEntry: claudeEntryFacts(entry, [lookalike]), secretsText }));
			assert.equal(itemOf(plan, 'claude.mcp-entry').status, 'manual');
			assert.equal(itemOf(plan, 'claude.skill-dir'), undefined);
			assert.equal(itemOf(plan, 'claude.env-file'), undefined);
			assert.ok(plan.items.every((item) => item.status !== 'ready' || !item.path.startsWith(lookalike)));
			assert.ok(secretSources(fullFacts({ claudeSkill: null, claudeEntry: claudeEntryFacts(entry, [lookalike]), secretsText })).every((source) => source.label !== 'claude-registration'));
		}
	});

	it('buildPlan: an entry under mcp-server-path is ready, and without a judgement of the plugin parts it is manual', () => {
		const entry = { command: '/usr/bin/node', args: [path.join(CUSTOM_SERVER, 'dist', 'index.js')], env: { OPENAI_API_KEY: FAKE.otherToken } };
		const plan = buildPlan(fullFacts({ claudeEntry: claudeEntryFacts(entry), secretsText: `mcp-server-path: ${CUSTOM_SERVER}\n` }));
		const item = itemOf(plan, 'claude.mcp-entry');
		assert.equal(item.status, 'ready');
		assert.equal(item.serverPath, entry.args[0]);
		assert.deepEqual(item.envKeys, ['OPENAI_API_KEY']);
		assert.equal(buildPlan(fullFacts({ claudeEntry: claudeEntryFacts(entry), secretsText: '' })).items.find((i) => i.id === 'claude.mcp-entry').status, 'manual');
		const raw = { file: PLAN_PATHS.claudeJson, entry: registrationOf(PLAN_PATHS.claudeSkill) };
		assert.equal(itemOf(buildPlan(fullFacts({ claudeEntry: raw })), 'claude.mcp-entry').status, 'manual');
	});

	it('buildPlan: CLAUDE_CONFIG_DIR elsewhere makes the entry manual with the by-hand fix, and no binary blocks it', () => {
		const elsewhere = itemOf(buildPlan(fullFacts({ configDirIsDefault: false })), 'claude.mcp-entry');
		assert.equal(elsewhere.status, 'manual');
		assert.equal(elsewhere.reason, 'CLAUDE_CONFIG_DIR points at another folder, so the cleanup does not touch ~/.claude.json.');
		assert.equal(elsewhere.fix, 'Remove the "make-custom-app" entry from ~/.claude.json by hand (claude mcp remove would change $CLAUDE_CONFIG_DIR/.claude.json instead).');
		assert.equal(itemOf(buildPlan(fullFacts({ configDirIsDefault: undefined })), 'claude.mcp-entry').status, 'manual');

		const noBinary = buildPlan(fullFacts({ claude: { binary: null } }));
		const blocked = itemOf(noBinary, 'claude.mcp-entry');
		assert.equal(blocked.status, 'blocked');
		assert.equal(blocked.reason, 'Claude Code was not found, so the old MCP registration cannot be removed.');
		assert.equal(blocked.fix, 'Set CLAUDE_BIN to the claude binary and run the plan again.');
		assert.deepEqual(noBinary.groups[0], { id: 'claude', confirm: 'after-plan', ready: 3, blocked: 1, manual: 0 });
		assert.equal(itemOf(buildPlan(fullFacts({ claude: { binary: '' } })), 'claude.mcp-entry').status, 'blocked');

		assert.equal(itemOf(buildPlan(fullFacts({ claude: { binary: null }, configDirIsDefault: false })), 'claude.mcp-entry').status, 'manual');
		const bundle = { command: '/usr/bin/node', args: [path.join(PLAN_PLUGIN_ROOT, 'mcp', 'index.mjs')] };
		assert.equal(itemOf(buildPlan(fullFacts({ claude: { binary: null }, claudeEntry: claudeEntryFacts(bundle) })), 'claude.mcp-entry').status, 'manual');
		assert.equal(itemOf(buildPlan(fullFacts({ claudeEntry: null })), 'claude.mcp-entry'), undefined);
	});
});

describe('buildPlan: the sentinel block', () => {
	it('buildPlan: unclosed, reversed, and repeated sentinels are manual; an edited block is ready with edited true', () => {
		const cases = [
			['unclosed', `# Notes\n\n${SENTINEL_OPEN}\n# Make Custom App Skill\n`, 'unclosed'],
			['reversed', `${SENTINEL_CLOSE}\ntext\n${SENTINEL_OPEN}\n`, 'in the wrong order'],
			['repeated', `${INSTALLER_BLOCK}\n\n${INSTALLER_BLOCK}\n`, 'repeated'],
			['repeated close', `${SENTINEL_OPEN}\n${SENTINEL_CLOSE}\n${SENTINEL_CLOSE}\n`, 'repeated'],
		];
		for (const [name, text, wording] of cases) {
			const plan = buildPlan(fullFacts({ claudeMd: { file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text, mode: 0o644, utf8Exact: true } }));
			const item = itemOf(plan, 'claude.sentinel');
			assert.equal(item.status, 'manual', name);
			assert.equal(item.action, 'remove-block');
			assert.equal(item.kind, 'text-block');
			assert.equal(item.reason, `The old skill block in ~/.claude/CLAUDE.md is ${wording}.`, name);
			assert.equal(item.fix, BLOCK_FIX, name);
			assert.equal(item.edited, false);
			assert.equal(plan.groups[0].manual, 1);
		}

		const edited = `# Notes\n\n${SENTINEL_OPEN}\n# Make Custom App Skill\n\nMy own words about it.\n${SENTINEL_CLOSE}\n`;
		const plan = buildPlan(fullFacts({ claudeMd: { file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text: edited, mode: 0o644, utf8Exact: true } }));
		const item = itemOf(plan, 'claude.sentinel');
		assert.equal(item.status, 'ready');
		assert.equal(item.edited, true);
		assert.deepEqual(item.lines, [3, 7]);
		assert.ok(plan.lines.includes('  remove  the old skill block from ~/.claude/CLAUDE.md (lines 3 to 7, edited by hand)'));
	});

	it('buildPlan: no block or no CLAUDE.md gives no sentinel item, and a block of CRLF text is ready', () => {
		const none = (claudeMd) => buildPlan(fullFacts({ claudeMd }));
		assert.equal(itemOf(none(null), 'claude.sentinel'), undefined);
		assert.equal(itemOf(none({ file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text: '# only notes\n', mode: 0o644, utf8Exact: true }), 'claude.sentinel'), undefined);
		const crlf = `# Notes\r\n\r\n${INSTALLER_BLOCK.replace(/\n/g, '\r\n')}\r\n`;
		const item = itemOf(none({ file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text: crlf, mode: 0o644, utf8Exact: true }), 'claude.sentinel');
		assert.equal(item.status, 'ready');
		assert.equal(item.edited, false);
	});

	it('buildPlan: invalid UTF-8 in CLAUDE.md makes the sentinel item manual, whatever the block is', () => {
		for (const text of [`# Notes\n\n${INSTALLER_BLOCK}\n`, `${SENTINEL_OPEN}\nunclosed\n`]) {
			const plan = buildPlan(fullFacts({ claudeMd: { file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text, mode: 0o644, utf8Exact: false } }));
			const item = itemOf(plan, 'claude.sentinel');
			assert.equal(item.status, 'manual');
			assert.equal(item.reason, '~/.claude/CLAUDE.md is not valid UTF-8, so the cleanup does not rewrite it.');
			assert.equal(item.fix, BLOCK_FIX);
		}
		const unknown = buildPlan(fullFacts({ claudeMd: { file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text: `${INSTALLER_BLOCK}\n`, mode: 0o644 } }));
		assert.equal(itemOf(unknown, 'claude.sentinel').status, 'manual');
	});
});

describe('buildPlan: the Cursor registrations', () => {
	const JSONC_REASON = '~/.cursor/mcp.json has comments or trailing commas, which the cleanup does not rewrite.';
	const UTF8_REASON = '~/.cursor/mcp.json is not valid UTF-8, so the cleanup does not rewrite it.';
	const byHand = (key) => `Remove the "${key}" entry from ~/.cursor/mcp.json by hand.`;

	it('buildPlan: a jsonc Cursor file makes its member manual and reformats is reported for a compact file', () => {
		const server = { 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill) };
		const jsonc = itemOf(buildPlan(fullFacts({ cursorMembers: cursorFileFacts(server, { jsonc: true }) })), 'cursor.mcp-entry.make-app-context');
		assert.equal(jsonc.status, 'manual');
		assert.equal(jsonc.action, 'remove-entry');
		assert.equal(jsonc.reason, JSONC_REASON);
		assert.equal(jsonc.fix, byHand('make-app-context'));
		assert.equal(jsonc.reformats, false);

		const compact = itemOf(buildPlan(fullFacts({ cursorMembers: cursorFileFacts(server, { compact: true }) })), 'cursor.mcp-entry.make-app-context');
		assert.equal(compact.status, 'ready');
		assert.equal(compact.reformats, true);
		const canonical = itemOf(buildPlan(fullFacts({ cursorMembers: cursorFileFacts(server) })), 'cursor.mcp-entry.make-app-context');
		assert.equal(canonical.status, 'ready');
		assert.equal(canonical.reformats, false);

		const broken = { ...cursorFileFacts(server), text: '{ not json at all' };
		const unreadable = itemOf(buildPlan(fullFacts({ cursorMembers: broken })), 'cursor.mcp-entry.make-app-context');
		assert.equal(unreadable.status, 'manual');
		assert.equal(unreadable.reason, JSONC_REASON);
		assert.ok(!JSON.stringify(unreadable).includes('not json at all'));
		const absent = { ...cursorFileFacts(server), text: '{"mcpServers":{}}' };
		assert.equal(itemOf(buildPlan(fullFacts({ cursorMembers: absent })), 'cursor.mcp-entry.make-app-context').status, 'manual');
	});

	it('buildPlan: invalid UTF-8 in ~/.cursor/mcp.json makes every Cursor member manual', () => {
		const servers = { 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill), legacy: registrationOf(PLAN_PATHS.cursorSkill) };
		const plan = buildPlan(fullFacts({ cursorMembers: cursorFileFacts(servers, { utf8Exact: false }) }));
		for (const key of ['legacy', 'make-app-context']) {
			const item = itemOf(plan, `cursor.mcp-entry.${key}`);
			assert.equal(item.status, 'manual', key);
			assert.equal(item.reason, UTF8_REASON);
			assert.equal(item.fix, byHand(key));
		}
		const both = buildPlan(fullFacts({ cursorMembers: cursorFileFacts(servers, { utf8Exact: false, jsonc: true }) }));
		assert.equal(itemOf(both, 'cursor.mcp-entry.legacy').reason, UTF8_REASON);
		const unknown = buildPlan(fullFacts({ cursorMembers: { ...cursorFileFacts(servers), utf8Exact: undefined } }));
		assert.equal(itemOf(unknown, 'cursor.mcp-entry.legacy').status, 'manual');
		assert.equal(plan.groups.find((group) => group.id === 'cursor').manual, 2);
	});

	it('buildPlan: the Cursor items do not depend on the Claude binary or on CLAUDE_CONFIG_DIR', () => {
		const plan = buildPlan(fullFacts({ claude: { binary: null }, configDirIsDefault: false }));
		for (const item of plan.items.filter((entry) => entry.group === 'cursor')) assert.equal(item.status, 'ready', item.id);
	});
});

describe('buildPlan: the .env files', () => {
	const envFacts = (text, extra = {}) => ({ claudeEntry: null, cursorMembers: null, cursorEnv: null, claudeEnv: { path: PLAN_PATHS.claudeEnv, text, mode: 0o644, utf8Exact: true, insideSkill: true }, ...extra });
	const actionOf = (facts) => {
		const item = itemOf(buildPlan(fullFacts(facts)), 'claude.env-file');
		assert.equal(item.status, 'ready');
		return item.action;
	};

	it('buildPlan: .env delete versus keep-in-backup', () => {
		const spaced = INSTALLER_ENV_TEXT.replace(`OPENAI_API_KEY=${FAKE.openai}`, `OPENAI_API_KEY=${FAKE.openai}  `);
		const mixed = `PINECONE_API_KEY=${FAKE.pinecone}\r\nOPENAI_API_KEY=${FAKE.openai}\n`;
		const cases = [
			['the installer file', envFacts(INSTALLER_ENV_TEXT), 'delete'],
			['no secrets file at all: the values are copied first', envFacts(INSTALLER_ENV_TEXT, { secretsText: null }), 'delete'],
			['an unknown assignment with a value', envFacts(`${INSTALLER_ENV_TEXT}OTHER_TOKEN=${FAKE.otherToken}\n`), 'keep-in-backup'],
			['an export line', envFacts(`${INSTALLER_ENV_TEXT}export OTHER_TOKEN=${FAKE.otherToken}\n`), 'keep-in-backup'],
			['an unknown assignment with no value', envFacts(`${INSTALLER_ENV_TEXT}SOME_FLAG=\n`), 'delete'],
			['trailing spaces', envFacts(spaced), 'keep-in-backup'],
			['mixed line endings', envFacts(mixed), 'keep-in-backup'],
			['CRLF only', envFacts(INSTALLER_ENV_TEXT.replace(/\n/g, '\r\n')), 'delete'],
			['bytes that are not UTF-8', envFacts(INSTALLER_ENV_TEXT, { claudeEnv: { path: PLAN_PATHS.claudeEnv, text: INSTALLER_ENV_TEXT, mode: 0o644, utf8Exact: false, insideSkill: true } }), 'keep-in-backup'],
			['utf8Exact missing', envFacts(INSTALLER_ENV_TEXT, { claudeEnv: { path: PLAN_PATHS.claudeEnv, text: INSTALLER_ENV_TEXT, mode: 0o644, insideSkill: true } }), 'keep-in-backup'],
			['a value that differs from the secrets file', envFacts(INSTALLER_ENV_TEXT, { secretsText: `openai-api-key: ${FAKE.otherToken}\n` }), 'keep-in-backup'],
			['an empty value and a placeholder', envFacts(`PINECONE_API_KEY=\nOPENAI_API_KEY=your-openai-key\nPINECONE_INDEX_NAME=${FAKE.index}\n`, { secretsText: `pinecone-index-name: ${FAKE.index}\n` }), 'delete'],
			['a reference', envFacts(`OPENAI_API_KEY=\${env:OPENAI_API_KEY}\nPINECONE_INDEX_NAME=${FAKE.index}\n`, { secretsText: `pinecone-index-name: ${FAKE.index}\n` }), 'delete'],
			['no final newline and a byte order mark', envFacts(`\uFEFFOPENAI_API_KEY=${FAKE.openai}`), 'delete'],
		];
		for (const [name, facts, expected] of cases) assert.equal(actionOf(facts), expected, name);
	});

	it('buildPlan: the env-file item holds names, statuses, and a line count, and a conflict is reported by key and source', () => {
		const facts = fullFacts(envFacts(INSTALLER_ENV_TEXT, { secretsText: `openai-api-key: ${FAKE.otherToken}\n` }));
		const plan = buildPlan(facts);
		const item = itemOf(plan, 'claude.env-file');
		assert.equal(item.action, 'keep-in-backup');
		assert.deepEqual(item.secrets, { 'pinecone-api-key': 'added', 'openai-api-key': 'conflict', 'pinecone-index-name': 'added' });
		assert.deepEqual(plan.secrets, { copy: ['pinecone-api-key', 'pinecone-index-name'], conflicts: [{ key: 'openai-api-key', used: 'secrets-file', others: ['claude-env'] }] });
		assert.ok(plan.lines.includes('  keep    ~/.claude/skills/make-custom-app/mcp-server/.env in the backup (it holds a value that is not in your secrets file)'));
	});

	it('buildPlan: a second .env with a different value is kept, the first source wins and its .env is deleted', () => {
		const other = INSTALLER_ENV_TEXT.replace(FAKE.pinecone, FAKE.conflictPinecone);
		const plan = buildPlan(fullFacts({ claudeEntry: null, cursorMembers: null, secretsText: null, cursorEnv: { path: PLAN_PATHS.cursorEnv, text: other, mode: 0o644, utf8Exact: true, insideSkill: true } }));
		assert.equal(itemOf(plan, 'claude.env-file').action, 'delete');
		assert.equal(itemOf(plan, 'cursor.env-file').action, 'keep-in-backup');
		assert.deepEqual(plan.secrets.conflicts, [{ key: 'pinecone-api-key', used: 'claude-env', others: ['cursor-env'] }]);
		assert.deepEqual(plan.secrets.copy, ['pinecone-api-key', 'openai-api-key', 'pinecone-index-name']);
		assert.equal(itemOf(plan, 'cursor.env-file').secrets['pinecone-api-key'], 'conflict');
	});

	it('buildPlan: an .env in a skill folder that is not planned gives no env-file item', () => {
		const plan = buildPlan(fullFacts({ claudeSkill: null, cursorSkill: null }));
		assert.equal(itemOf(plan, 'claude.env-file'), undefined);
		assert.equal(itemOf(plan, 'cursor.env-file'), undefined);
		const noEnv = buildPlan(fullFacts({ claudeEnv: null, cursorEnv: null }));
		assert.equal(itemOf(noEnv, 'claude.env-file'), undefined);
		assert.ok(itemOf(noEnv, 'claude.skill-dir'));
	});
});

describe('buildPlan: folders, notices, and secrets', () => {
	it('buildPlan: a symlinked skill folder has no env-file item and a symlink-target notice, and nothing outside the link is touched', () => {
		const target = path.join(TEST_ROOT, 'dotfiles', 'claude-skill');
		const cursorTarget = path.join(TEST_ROOT, 'dotfiles', 'cursor-skill');
		const facts = fullFacts({
			claudeSkill: skillFacts(PLAN_PATHS.claudeSkill, { symlink: true, linkTarget: target }),
			cursorSkill: skillFacts(PLAN_PATHS.cursorSkill, { symlink: true, linkTarget: cursorTarget }),
			secretsText: '',
		});
		const plan = buildPlan(facts);
		assert.deepEqual(idsOf(plan), ['claude.mcp-entry', 'claude.sentinel', 'claude.skill-dir', 'cursor.mcp-entry.make-app-context', 'cursor.skill-dir', 'cursor.rules-dir']);
		for (const id of ['claude.skill-dir', 'cursor.skill-dir']) {
			const item = itemOf(plan, id);
			assert.equal(item.symlink, true);
			assert.equal(item.status, 'ready');
			assert.equal(item.action, 'move');
		}
		assert.deepEqual(plan.notices.filter((notice) => notice.kind === 'symlink-target'), [
			{ kind: 'symlink-target', file: PLAN_PATHS.claudeSkill, lines: [], text: `~/.claude/skills/make-custom-app is a symbolic link to ${target}; only the link moves, and the files in ${target}, its mcp-server/.env included, stay where they are.` },
			{ kind: 'symlink-target', file: PLAN_PATHS.cursorSkill, lines: [], text: `~/.cursor/skills/make-custom-app is a symbolic link to ${cursorTarget}; only the link moves, and the files in ${cursorTarget}, its mcp-server/.env included, stay where they are.` },
		]);
		const flat = JSON.stringify(plan.items);
		assert.ok(!flat.includes(PLAN_PATHS.claudeEnv));
		assert.ok(!flat.includes(PLAN_PATHS.cursorEnv));
		for (const item of plan.items) assert.ok(item.path !== target && !item.path.startsWith(target + path.sep) && !item.path.startsWith(cursorTarget + path.sep), item.id);
		assert.ok(plan.lines.includes('  move    ~/.claude/skills/make-custom-app (old skill folder, a symbolic link; only the link moves)'));
		assert.deepEqual(plan.secrets.copy, ['pinecone-api-key', 'openai-api-key', 'pinecone-index-name']);
		assert.ok(secretSources(facts).some((source) => source.label === 'claude-env'));
	});

	it('buildPlan: the rules folder lists the files besides make-custom-app.mdc, without .DS_Store', () => {
		const rules = { path: PLAN_PATHS.cursorRules, names: ['notes.mdc', '.DS_Store', 'make-custom-app.mdc', 'a.mdc'], fileCount: 3, sizeBytes: 900 };
		const item = itemOf(buildPlan(fullFacts({ cursorRules: rules })), 'cursor.rules-dir');
		assert.deepEqual(item.extraFiles, ['a.mdc', 'notes.mdc']);
		assert.equal(item.fileCount, 3);
		assert.deepEqual(item.fingerprint, ['a.mdc', 'make-custom-app.mdc', 'notes.mdc']);
	});

	it('buildPlan: own-line and contexts notices', () => {
		const text = `# My notes\nFor IMLJSON, use the make-custom-app skill first.\n\n${INSTALLER_BLOCK}\nAlso the \`make-custom-app\` skill is nice.\n`;
		const facts = fullFacts({
			claudeMd: { file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text, mode: 0o644, utf8Exact: true },
			contextsDirs: [PLAN_PATHS.claudeContexts, PLAN_PATHS.cursorContexts],
		});
		const plan = buildPlan(facts);
		const own = (line) => ({
			kind: 'own-line',
			file: PLAN_PATHS.claudeMd,
			lines: [line],
			text: `~/.claude/CLAUDE.md line ${line} names the make-custom-app skill, which the plugin replaces. The cleanup does not edit your own text. Change it to use the matching make-app-* skill of the make-custom-app plugin, or delete it: the plugin's skills trigger without it.`,
		});
		const contexts = (dir, shown) => ({ kind: 'contexts', file: dir, lines: [], text: `Old app contexts remain in ${shown}; the plugin uses ~/.make-custom-app/contexts. The cleanup does not move or delete them.` });
		assert.deepEqual(plan.notices.filter((notice) => notice.kind !== 'claude-backup-copy'), [own(2), own(9), contexts(PLAN_PATHS.claudeContexts, '~/.claude/make-app-contexts'), contexts(PLAN_PATHS.cursorContexts, '~/.cursor/make-app-contexts')]);
		assert.equal(itemOf(plan, 'claude.sentinel').status, 'ready');
		assert.deepEqual(itemOf(plan, 'claude.sentinel').lines, [4, 8]);
		assert.deepEqual(buildPlan(fullFacts({ contextsDirs: [] })).notices.map((notice) => notice.kind), ['claude-backup-copy']);
		assert.deepEqual(buildPlan(fullFacts({ claudeMd: null })).notices.map((notice) => notice.kind), ['claude-backup-copy']);
	});

	it('buildPlan: the claude-backup-copy notice has the exact text when the Claude entry is ready, and is absent when the entry is manual, blocked, or not present', () => {
		const expected = {
			kind: 'claude-backup-copy',
			file: path.join(PLAN_HOME, '.claude.json'),
			lines: [],
			text: 'Claude Code keeps its own copy of ~/.claude.json at ~/.claude/backups/ that still holds the removed registration; this cleanup does not touch it.',
		};
		const ready = buildPlan(fullFacts({ contextsDirs: [PLAN_PATHS.claudeContexts] }));
		assert.deepEqual(ready.notices.filter((notice) => notice.kind === 'claude-backup-copy'), [expected]);
		assert.deepEqual(ready.notices.at(-1), expected);

		const bundle = { command: '/usr/bin/node', args: [path.join(PLAN_PLUGIN_ROOT, 'mcp', 'index.mjs')] };
		const absentCases = [
			['not an old registration', { claudeEntry: claudeEntryFacts(bundle) }],
			['CLAUDE_CONFIG_DIR elsewhere', { configDirIsDefault: false }],
			['no binary', { claude: { binary: null } }],
			['no entry', { claudeEntry: null }],
		];
		for (const [name, extra] of absentCases) {
			const plan = buildPlan(fullFacts({ contextsDirs: [PLAN_PATHS.claudeContexts], ...extra }));
			assert.ok(!plan.notices.some((notice) => notice.kind === 'claude-backup-copy'), name);
			assert.ok(plan.notices.some((notice) => notice.kind === 'contexts'), name);
		}
	});

	it('buildPlan: no fake secret value occurs anywhere in JSON.stringify(plan)', () => {
		const loud = { PINECONE_API_KEY: FAKE.conflictPinecone, OPENAI_API_KEY: FAKE.cursorToken, OTHER_TOKEN: FAKE.otherToken };
		const conflictEnv = `PINECONE_API_KEY=${FAKE.conflictPinecone}\nOPENAI_API_KEY=${FAKE.cursorToken}\nOTHER_TOKEN=${FAKE.otherToken}\n`;
		const bundle = { command: '/usr/bin/node', args: [path.join(PLAN_PLUGIN_ROOT, 'mcp', 'index.mjs')], env: loud };
		const variants = [
			fullFacts(),
			fullFacts({ secretsText: '' }),
			fullFacts({ secretsText: `openai-api-key: ${FAKE.otherToken}\npinecone-api-key: ${FAKE.cursorToken}\n` }),
			fullFacts({ claudeEnv: { path: PLAN_PATHS.claudeEnv, text: conflictEnv, mode: 0o644, utf8Exact: true, insideSkill: true }, cursorEnv: { path: PLAN_PATHS.cursorEnv, text: conflictEnv, mode: 0o644, utf8Exact: false, insideSkill: true } }),
			fullFacts({ claudeEntry: claudeEntryFacts(bundle), cursorMembers: cursorFileFacts({ 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill, { env: loud }) }, { jsonc: true }) }),
			fullFacts({ claudeEntry: claudeEntryFacts(registrationOf(PLAN_PATHS.claudeSkill, { env: loud })), cursorMembers: cursorFileFacts({ 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill, { env: loud }) }, { compact: true }) }),
			fullFacts({ configDirIsDefault: false, claude: { binary: null } }),
			fullFacts({ claudeSkill: skillFacts(PLAN_PATHS.claudeSkill, { symlink: true, linkTarget: path.join(TEST_ROOT, 'elsewhere') }) }),
			fullFacts({ claudeEntry: claudeEntryFacts({ type: 'http', url: `https://example.test/?key=${FAKE.cursorToken}`, headers: { Authorization: `Bearer ${FAKE.otherToken}` } }) }),
			fullFacts({ claudeEntry: claudeEntryFacts({ command: '/usr/bin/node', args: [`--token=${FAKE.otherToken}`], env: loud }) }),
		];
		for (const [index, facts] of variants.entries()) {
			const text = JSON.stringify(buildPlan(facts));
			for (const seed of SECRET_SEEDS) assert.ok(!text.includes(seed), `variant ${index} holds ${seed}`);
		}
	});

	it('buildPlan: an empty home gives an empty plan', () => {
		const empty = fullFacts({ claudeSkill: null, cursorSkill: null, cursorRules: null, claudeEnv: null, cursorEnv: null, claudeEntry: null, cursorMembers: null, claudeMd: null, secretsText: null, contextsDirs: [] });
		const plan = buildPlan(empty);
		assert.deepEqual(plan.items, []);
		assert.deepEqual(plan.groups, []);
		assert.deepEqual(plan.notices, []);
		assert.deepEqual(plan.secrets, { copy: [], conflicts: [] });
		assert.equal(plan.confirmRequired, false);
		assert.deepEqual(plan.lines, ['Nothing to remove.']);
		assert.match(plan.digest, DIGEST_PATTERN);
	});

	it('buildPlan: confirmRequired is true only when some item is ready', () => {
		assert.equal(buildPlan(fullFacts()).confirmRequired, true);
		assert.equal(buildPlan(fullFacts({ claude: { binary: null }, claudeSkill: null, claudeEnv: null, claudeMd: null, cursorSkill: null, cursorEnv: null, cursorRules: null, cursorMembers: null })).confirmRequired, false);
		const manualOnly = fullFacts({ claudeSkill: null, claudeEnv: null, cursorSkill: null, cursorEnv: null, cursorRules: null, cursorMembers: null, claudeEntry: null, claudeMd: { file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text: `${SENTINEL_OPEN}\n`, mode: 0o644, utf8Exact: true } });
		assert.equal(buildPlan(manualOnly).confirmRequired, false);
	});

	it('buildPlan needs facts with a home and does not change them', () => {
		for (const bad of [undefined, null, 'x', [], {}, { home: '' }, { home: 5 }]) assert.throws(() => buildPlan(bad), TypeError, JSON.stringify(bad));
		const frozen = deepFreeze(fullFacts());
		const first = buildPlan(frozen);
		assert.deepEqual(buildPlan(frozen), first);
		const sparse = buildPlan({ home: PLAN_HOME });
		assert.deepEqual(sparse.items, []);
		assert.equal(sparse.editor, null);
	});
});

describe('buildPlan: the digest', () => {
	const base = () => buildPlan(fullFacts()).digest;

	it('the digest is the same for the same facts in another key order and member order, and for changes it does not name', () => {
		const digest = base();
		assert.equal(buildPlan(reverseKeys(fullFacts())).digest, digest);
		const two = { 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill), legacy: registrationOf(PLAN_PATHS.cursorSkill) };
		const reversedMembers = { ...cursorFileFacts(two), members: cursorFileFacts(two).members.reverse() };
		assert.equal(buildPlan(fullFacts({ cursorMembers: reversedMembers })).digest, buildPlan(fullFacts({ cursorMembers: cursorFileFacts(two) })).digest);

		const quiet = [
			['the claude binary path', fullFacts({ claude: { binary: '/opt/homebrew/bin/claude' } })],
			['no claude binary at all (a plan made without the search)', fullFacts({ claude: { binary: null } })],
			['the key statuses of the secrets file', fullFacts({ secretsText: '' })],
			['the plugin version', fullFacts({ plugin: { ...fullFacts().plugin, version: '3.1.0' } })],
			['sizes and counts', fullFacts({ claudeSkill: skillFacts(PLAN_PATHS.claudeSkill, { fileCount: 99, sizeBytes: 1 }) })],
			['a .DS_Store', fullFacts({ claudeSkill: skillFacts(PLAN_PATHS.claudeSkill, { topNames: ['.DS_Store', 'scripts', 'SKILL.md', 'mcp-server'] }) })],
			['the mode of an .env', fullFacts({ claudeEnv: { path: PLAN_PATHS.claudeEnv, text: INSTALLER_ENV_TEXT, mode: 0o600, utf8Exact: true, insideSkill: true } })],
			['a context folder and an own line (notices)', fullFacts({ contextsDirs: [PLAN_PATHS.claudeContexts] })],
			['text after the block', fullFacts({ claudeMd: { file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text: `# Notes\n\n${INSTALLER_BLOCK}\nmore text\nthe make-custom-app skill\n`, mode: 0o644, utf8Exact: true } })],
			['an unrelated secrets line', fullFacts({ secretsText: `jira-email: someone@make.com\n${SECRETS_SAME}` })],
			['the values of the entries and the files', (() => {
				const swap = (value) => value.split(FAKE.index).join('other-index');
				const env = { PINECONE_API_KEY: FAKE.pinecone, OPENAI_API_KEY: FAKE.openai, PINECONE_INDEX_NAME: 'other-index' };
				return fullFacts({
					secretsText: swap(SECRETS_SAME),
					claudeEnv: { path: PLAN_PATHS.claudeEnv, text: swap(INSTALLER_ENV_TEXT), mode: 0o644, utf8Exact: true, insideSkill: true },
					cursorEnv: { path: PLAN_PATHS.cursorEnv, text: swap(INSTALLER_ENV_TEXT), mode: 0o644, utf8Exact: true, insideSkill: true },
					claudeEntry: claudeEntryFacts(registrationOf(PLAN_PATHS.claudeSkill, { env })),
					cursorMembers: cursorFileFacts({ 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill, { env }) }),
				});
			})()],
		];
		for (const [name, facts] of quiet) assert.equal(buildPlan(facts).digest, digest, name);
	});

	it('the digest changes with a top-level name, a block, an entry, the assignment names of a .env, a path, a status, or an action', () => {
		const digest = base();
		const editedBlock = INSTALLER_BLOCK.replace('Do not answer from memory.', 'Answer from memory.');
		const changed = [
			['a top-level name of the skill folder', fullFacts({ claudeSkill: skillFacts(PLAN_PATHS.claudeSkill, { topNames: ['SKILL.md', 'mcp-server', 'scripts', 'notes.md'] }) })],
			['the version of the skill folder', fullFacts({ claudeSkill: skillFacts(PLAN_PATHS.claudeSkill, { version: '2.3.12' }) })],
			['a symbolic link', fullFacts({ claudeSkill: skillFacts(PLAN_PATHS.claudeSkill, { symlink: true, linkTarget: path.join(TEST_ROOT, 'x') }) })],
			['the text of the block', fullFacts({ claudeMd: { file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text: `# Notes\n\n${editedBlock}\n`, mode: 0o644, utf8Exact: true } })],
			['the line of the block', fullFacts({ claudeMd: { file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text: `# Notes\nmore\n\n${INSTALLER_BLOCK}\n`, mode: 0o644, utf8Exact: true } })],
			['the command of the entry', fullFacts({ claudeEntry: claudeEntryFacts(registrationOf(PLAN_PATHS.claudeSkill, { command: '/usr/bin/other' })) })],
			['an env name of the entry', fullFacts({ claudeEntry: claudeEntryFacts(registrationOf(PLAN_PATHS.claudeSkill, { env: { OPENAI_API_KEY: FAKE.openai } })) })],
			['the Cursor member', fullFacts({ cursorMembers: cursorFileFacts({ 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill, { args: [path.join(PLAN_PATHS.cursorSkill, 'mcp-server', 'other.js')] }) }) })],
			['the key of the Cursor member', fullFacts({ cursorMembers: cursorFileFacts({ other: registrationOf(PLAN_PATHS.cursorSkill) }) })],
			['an assignment name of an .env', fullFacts({ claudeEnv: { path: PLAN_PATHS.claudeEnv, text: `${INSTALLER_ENV_TEXT}EXTRA_FLAG=\n`, mode: 0o644, utf8Exact: true, insideSkill: true } })],
			['a path', fullFacts({ claudeSkill: skillFacts(path.join(PLAN_HOME, '.claude', 'skills', 'make-custom-app-2')) })],
			['a status (CLAUDE_CONFIG_DIR)', fullFacts({ configDirIsDefault: false })],
			['an action (a conflicting secrets value)', fullFacts({ secretsText: `openai-api-key: ${FAKE.otherToken}\n` })],
			['the plugin rules folder', fullFacts({ cursorRules: { path: PLAN_PATHS.cursorRules, names: ['make-custom-app.mdc', 'x.mdc'], fileCount: 2, sizeBytes: 800 } })],
		];
		const seen = new Set([digest]);
		for (const [name, facts] of changed) {
			const next = buildPlan(facts).digest;
			assert.notEqual(next, digest, name);
			seen.add(next);
		}
		assert.ok(seen.size > changed.length / 2);
	});
});

describe('planLines', () => {
	const COPY = '  copy    pinecone-api-key, openai-api-key, pinecone-index-name into ~/.make-custom-app-skill-secrets (values already there win)';
	const SERVER_CLAUDE = '~/.claude/skills/make-custom-app/mcp-server/dist/index.js';
	const SERVER_CURSOR = '~/.cursor/skills/make-custom-app/mcp-server/dist/index.js';

	it('planLines: the exact lines for a full plan', () => {
		const plan = buildPlan(fullFacts({ secretsText: '' }));
		assert.deepEqual(planLines(plan), [
			'Claude Code items:',
			COPY,
			`  remove  "make-custom-app" from ~/.claude.json (old MCP registration, server ${SERVER_CLAUDE})`,
			'  remove  the old skill block from ~/.claude/CLAUDE.md (lines 3 to 7)',
			'  delete  ~/.claude/skills/make-custom-app/mcp-server/.env (its keys are in your secrets file)',
			'  move    ~/.claude/skills/make-custom-app (old skill folder, version 2.3.13, 12 files)',
			'Cursor items (ask separately):',
			`  remove  "make-app-context" from ~/.cursor/mcp.json (old MCP registration, server ${SERVER_CURSOR})`,
			'  delete  ~/.cursor/skills/make-custom-app/mcp-server/.env (its keys are in your secrets file)',
			'  move    ~/.cursor/skills/make-custom-app (old skill folder, version 2.3.13, 12 files)',
			'  move    ~/.cursor/rules/make-custom-app (old Cursor rule folder, 1 files)',
		]);
		assert.deepEqual(plan.lines, planLines(plan));
	});

	it('planLines: no copy line when every key is in the secrets file, and the keep line, the symlink line, and the edited block', () => {
		const target = path.join(TEST_ROOT, 'dotfiles', 'skill');
		const edited = `# Notes\n\n${SENTINEL_OPEN}\n# Make Custom App Skill\n\nMy own words.\n${SENTINEL_CLOSE}\n`;
		const facts = fullFacts({
			claudeMd: { file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text: edited, mode: 0o644, utf8Exact: true },
			claudeEnv: { path: PLAN_PATHS.claudeEnv, text: `${INSTALLER_ENV_TEXT}OTHER_TOKEN=${FAKE.otherToken}\n`, mode: 0o644, utf8Exact: true, insideSkill: true },
			cursorSkill: skillFacts(PLAN_PATHS.cursorSkill, { symlink: true, linkTarget: target }),
		});
		assert.deepEqual(planLines(buildPlan(facts)), [
			'Claude Code items:',
			`  remove  "make-custom-app" from ~/.claude.json (old MCP registration, server ${SERVER_CLAUDE})`,
			'  remove  the old skill block from ~/.claude/CLAUDE.md (lines 3 to 7, edited by hand)',
			'  keep    ~/.claude/skills/make-custom-app/mcp-server/.env in the backup (it holds a value that is not in your secrets file)',
			'  move    ~/.claude/skills/make-custom-app (old skill folder, version 2.3.13, 12 files)',
			'Cursor items (ask separately):',
			`  remove  "make-app-context" from ~/.cursor/mcp.json (old MCP registration, server ${SERVER_CURSOR})`,
			'  move    ~/.cursor/skills/make-custom-app (old skill folder, a symbolic link; only the link moves)',
			'  move    ~/.cursor/rules/make-custom-app (old Cursor rule folder, 1 files)',
		]);
	});

	it('planLines: the exact lines for a blocked plan', () => {
		const plan = buildPlan(fullFacts({ secretsText: '', claude: { binary: null }, cursorSkill: null, cursorRules: null, cursorEnv: null, cursorMembers: null }));
		assert.deepEqual(planLines(plan), [
			'Claude Code items:',
			COPY,
			'  remove  the old skill block from ~/.claude/CLAUDE.md (lines 3 to 7)',
			'  delete  ~/.claude/skills/make-custom-app/mcp-server/.env (its keys are in your secrets file)',
			'  move    ~/.claude/skills/make-custom-app (old skill folder, version 2.3.13, 12 files)',
			'Blocked (fix first; nothing is removed until then):',
			'  claude.mcp-entry: Claude Code was not found, so the old MCP registration cannot be removed. Fix: Set CLAUDE_BIN to the claude binary and run the plan again.',
		]);
	});

	it('planLines: the exact lines for a manual-only plan, with the home shortened in the reason', () => {
		const bundle = path.join(PLAN_PLUGIN_ROOT, 'mcp', 'index.mjs');
		const manualOnly = fullFacts({
			claudeSkill: null,
			claudeEnv: null,
			cursorSkill: null,
			cursorEnv: null,
			cursorRules: null,
			cursorMembers: cursorFileFacts({ 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill) }, { jsonc: true }),
			claudeEntry: claudeEntryFacts({ command: '/usr/bin/node', args: [bundle] }),
			claudeMd: { file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text: `# Notes\n${SENTINEL_OPEN}\n`, mode: 0o644, utf8Exact: true },
		});
		const plan = buildPlan(manualOnly);
		assert.equal(plan.confirmRequired, false);
		assert.deepEqual(planLines(plan), [
			'By hand (the cleanup does not do these):',
			`  claude.mcp-entry: This make-custom-app entry in ~/.claude.json does not point into an old skill folder (server ${tilde(bundle)}). Fix: If it belongs to the old skill, remove the "make-custom-app" entry from ~/.claude.json by hand; the cleanup leaves it.`,
			`  claude.sentinel: The old skill block in ~/.claude/CLAUDE.md is unclosed. Fix: Remove the lines from ${SENTINEL_OPEN} to ${SENTINEL_CLOSE} by hand.`,
			'  cursor.mcp-entry.make-app-context: ~/.cursor/mcp.json has comments or trailing commas, which the cleanup does not rewrite. Fix: Remove the "make-app-context" entry from ~/.cursor/mcp.json by hand.',
		]);
	});

	it('planLines: ready, blocked, and manual items together, in that order, and the copy line goes under the first group that has a ready item', () => {
		const facts = fullFacts({
			secretsText: '',
			claude: { binary: null },
			claudeSkill: null,
			claudeEnv: null,
			claudeMd: { file: PLAN_PATHS.claudeMd, realPath: PLAN_PATHS.claudeMd, text: `${SENTINEL_OPEN}\n`, mode: 0o644, utf8Exact: true },
		});
		const lines = planLines(buildPlan(facts));
		assert.equal(lines[0], 'Cursor items (ask separately):');
		assert.equal(lines[1], COPY);
		assert.ok(lines.indexOf('Blocked (fix first; nothing is removed until then):') > lines.indexOf('  move    ~/.cursor/rules/make-custom-app (old Cursor rule folder, 1 files)'));
		assert.ok(lines.indexOf('By hand (the cleanup does not do these):') > lines.indexOf('Blocked (fix first; nothing is removed until then):'));
		assert.ok(!lines.includes('Claude Code items:'));
	});

	it('planLines: the exact line for an empty plan, and it needs a plan', () => {
		assert.deepEqual(planLines({ home: PLAN_HOME, items: [] }), ['Nothing to remove.']);
		for (const bad of [undefined, null, {}, { home: PLAN_HOME }, { items: [] }]) assert.throws(() => planLines(bad), TypeError, JSON.stringify(bad));
	});

	it('planLines shortens only the home folder, as a whole path segment', () => {
		const plan = buildPlan(fullFacts());
		const line = planLines({ ...plan, home: PLAN_HOME }).find((entry) => entry.includes('~/.claude.json'));
		assert.ok(line);
		const odd = { ...plan, home: `${PLAN_HOME}-x` };
		assert.ok(planLines(odd).every((entry) => !entry.includes('~/')));
	});
});

describe('backupFolderName', () => {
	const MOMENT = Date.UTC(2026, 9, 30, 8, 5, 9, 123);

	it('backupFolderName: format and collision suffix', () => {
		assert.equal(backupFolderName(MOMENT, () => false), 'migration-backup-2026-10-30T08-05-09Z');
		assert.equal(backupFolderName(new Date(MOMENT), () => false), 'migration-backup-2026-10-30T08-05-09Z');
		const taken = new Set(['migration-backup-2026-10-30T08-05-09Z']);
		assert.equal(backupFolderName(MOMENT, (name) => taken.has(name)), 'migration-backup-2026-10-30T08-05-09Z-2');
		taken.add('migration-backup-2026-10-30T08-05-09Z-2');
		taken.add('migration-backup-2026-10-30T08-05-09Z-3');
		assert.equal(backupFolderName(MOMENT, (name) => taken.has(name)), 'migration-backup-2026-10-30T08-05-09Z-4');
		const asked = [];
		backupFolderName(MOMENT, (name) => {
			asked.push(name);
			return asked.length < 3;
		});
		assert.deepEqual(asked, ['migration-backup-2026-10-30T08-05-09Z', 'migration-backup-2026-10-30T08-05-09Z-2', 'migration-backup-2026-10-30T08-05-09Z-3']);
		assert.equal(backupFolderName(Date.UTC(2027, 0, 1, 0, 0, 0), () => false), 'migration-backup-2027-01-01T00-00-00Z');
		assert.equal(backupFolderName(Date.UTC(2026, 11, 31, 23, 59, 59, 999), () => false), 'migration-backup-2026-12-31T23-59-59Z');
	});

	it('backupFolderName needs a moment and an exists function, and stops when every name is taken', () => {
		assert.throws(() => backupFolderName(undefined, () => false), TypeError);
		assert.throws(() => backupFolderName(Number.NaN, () => false), TypeError);
		assert.throws(() => backupFolderName('2026-10-30', () => false), TypeError);
		assert.throws(() => backupFolderName(new Date('nope'), () => false), TypeError);
		assert.throws(() => backupFolderName(MOMENT), TypeError);
		assert.throws(() => backupFolderName(MOMENT, () => true), (err) => err instanceof Error && !(err instanceof TypeError) && /no free name/.test(String(err)));
	});
});

describe('restoreDecision', () => {
	const reality = (extra = {}) => ({ originalExists: false, backupExists: false, fileExists: false, markerPresent: false, keyPresent: false, ...extra });

	it('restoreDecision: every type, for done and running steps, and both env-file actions', () => {
		for (const state of ['done', 'running']) {
			const step = (extra) => ({ state, ...extra });
			assert.equal(restoreDecision(step({ type: 'directory' }), reality({ originalExists: true })), 'skip');
			assert.equal(restoreDecision(step({ type: 'directory' }), reality({ originalExists: true, backupExists: true })), 'skip');
			assert.equal(restoreDecision(step({ type: 'directory' }), reality({ backupExists: true })), 'restore');
			assert.equal(restoreDecision(step({ type: 'directory' }), reality()), 'missing');

			assert.equal(restoreDecision(step({ type: 'env-file', action: 'delete' }), reality({ fileExists: true })), 'skip');
			assert.equal(restoreDecision(step({ type: 'env-file', action: 'delete' }), reality()), 'restore');
			assert.equal(restoreDecision(step({ type: 'env-file', action: 'keep-in-backup' }), reality({ fileExists: true })), 'restore');
			assert.equal(restoreDecision(step({ type: 'env-file', action: 'keep-in-backup' }), reality()), 'missing');

			assert.equal(restoreDecision(step({ type: 'text-block' }), reality({ markerPresent: true })), 'skip');
			assert.equal(restoreDecision(step({ type: 'text-block' }), reality()), 'restore');

			for (const type of ['claude-mcp-entry', 'json-member']) {
				assert.equal(restoreDecision(step({ type }), reality({ keyPresent: true })), 'skip', type);
				assert.equal(restoreDecision(step({ type }), reality()), 'restore', type);
			}
			assert.equal(restoreDecision(step({ type: 'secrets' }), reality()), 'skip');
		}
	});

	it('restoreDecision: a step that never ran, failed, is already restored, has no state, or has an unknown state is left alone', () => {
		for (const state of ['pending', 'failed', 'restored', 'restore-skipped']) {
			assert.equal(restoreDecision({ type: 'directory', state }, reality({ backupExists: true })), 'skip', state);
			assert.equal(restoreDecision({ type: 'text-block', state }, reality()), 'skip', state);
			assert.equal(restoreDecision({ type: 'env-file', action: 'delete', state }, reality()), 'skip', state);
		}
		assert.equal(restoreDecision({ type: 'directory' }, reality({ backupExists: true })), 'skip');
		assert.equal(restoreDecision({ type: 'directory', state: null }, reality({ backupExists: true })), 'skip');
		assert.equal(restoreDecision({ type: 'text-block', state: 'unknown' }, reality()), 'skip');
	});

	it('restoreDecision refuses an unknown type, an unknown action, and missing arguments', () => {
		assert.throws(() => restoreDecision({ type: 'nope', state: 'done' }, reality()), TypeError);
		assert.throws(() => restoreDecision({ type: 'env-file', action: 'move', state: 'done' }, reality()), TypeError);
		assert.throws(() => restoreDecision({ type: 'env-file', state: 'done' }, reality()), TypeError);
		assert.throws(() => restoreDecision(null, reality()), TypeError);
		assert.throws(() => restoreDecision({ type: 'directory', state: 'done' }, null), TypeError);
		assert.throws(() => restoreDecision({ type: 'directory', state: 'done' }), TypeError);
	});
});

describe('declineState', () => {
	const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
	const DAY = 24 * 60 * 60 * 1000;

	it('declineState: none, fresh, 8 days old, future, changed digest', () => {
		const state = (marker, digest = DIGEST_A) => declineState({ marker, digest, now: NOW });
		assert.equal(state(null), 'none');
		assert.equal(state(undefined), 'none');
		assert.equal(state({}), 'none');
		assert.equal(state({ declinedAt: 'yesterday', digest: DIGEST_A }), 'none');
		assert.equal(state({ declinedAt: Number.NaN, digest: DIGEST_A }), 'none');
		assert.equal(state({ declinedAt: NOW - 1000, digest: DIGEST_A }), 'fresh');
		assert.equal(state({ declinedAt: NOW, digest: DIGEST_A }), 'fresh');
		assert.equal(state({ declinedAt: NOW - 6 * DAY, digest: DIGEST_A }), 'fresh');
		assert.equal(state({ declinedAt: NOW - DECLINE_TTL_MS + 1, digest: DIGEST_A }), 'fresh');
		assert.equal(state({ declinedAt: NOW - DECLINE_TTL_MS, digest: DIGEST_A }), 'expired');
		assert.equal(state({ declinedAt: NOW - 8 * DAY, digest: DIGEST_A }), 'expired');
		assert.equal(state({ declinedAt: NOW + 1, digest: DIGEST_A }), 'expired');
		assert.equal(state({ declinedAt: NOW + 30 * DAY, digest: DIGEST_A }), 'expired');
		assert.equal(state({ declinedAt: NOW - 1000, digest: 'fedcba9876543210' }), 'changed');
		assert.equal(state({ declinedAt: NOW - 8 * DAY, digest: 'fedcba9876543210' }), 'changed');
		assert.equal(state({ declinedAt: NOW - 1000 }), 'changed');
	});

	it('declineState needs a digest and a clock', () => {
		assert.throws(() => declineState({ marker: null, digest: DIGEST_A }), TypeError);
		assert.throws(() => declineState({ marker: null, digest: DIGEST_A, now: 'x' }), TypeError);
		assert.throws(() => declineState({ marker: null, now: NOW }), TypeError);
		assert.throws(() => declineState(), TypeError);
	});
});

describe('the plan: odd facts and hand-made plans', () => {
	it('secretSources and compareSecrets refuse or skip what they cannot use', () => {
		assert.throws(() => secretSources(null), TypeError);
		assert.throws(() => secretSources('facts'), TypeError);
		const odd = compareSecrets(null, null);
		assert.deepEqual(odd.status, { 'pinecone-api-key': 'absent', 'openai-api-key': 'absent', 'pinecone-index-name': 'absent' });
		const mixed = compareSecrets([null, { label: 'x', values: null }, { label: 'y', values: { OPENAI_API_KEY: 5 } }, { label: 'z', values: { OPENAI_API_KEY: FAKE.openai } }], null);
		assert.deepEqual(mixed.updates, { 'openai-api-key': FAKE.openai });
		const objectEntry = { file: PLAN_PATHS.claudeJson, entry: 'not an object', withoutOwn: judged(registrationOf(PLAN_PATHS.claudeSkill)) };
		assert.deepEqual(secretSources(fullFacts({ claudeEntry: objectEntry, claudeEnv: null, cursorMembers: null, cursorEnv: null })), [{ label: 'claude-registration', values: {} }]);
	});

	it('fingerprint and planDigest take an item with only the fields it has', () => {
		assert.deepEqual(fingerprint({ kind: 'directory', id: 'claude.skill-dir' }), { symlink: false, linkTarget: null, skillName: null, version: null, topNames: [] });
		assert.deepEqual(fingerprint({ kind: 'directory', id: 'cursor.rules-dir' }), []);
		assert.match(planDigest([{ id: 'a' }]), DIGEST_PATTERN);
		assert.notEqual(planDigest([{ id: 'a' }]), planDigest([{ id: 'b' }]));
	});

	it('buildPlan: a folder with no version, counts, or sizes still gives an item, and a Windows home gets backslash paths', () => {
		const bare = { path: PLAN_PATHS.claudeSkill };
		const plan = buildPlan(fullFacts({ claudeSkill: bare, cursorRules: { path: PLAN_PATHS.cursorRules } }));
		assert.deepEqual(withoutFingerprint(itemOf(plan, 'claude.skill-dir')), { id: 'claude.skill-dir', group: 'claude', kind: 'directory', path: PLAN_PATHS.claudeSkill, action: 'move', status: 'ready', reason: null, fix: null, symlink: false, version: null, fileCount: 0, sizeBytes: 0, extraFiles: [] });
		assert.deepEqual(itemOf(plan, 'cursor.rules-dir').extraFiles, []);
		assert.equal(itemOf(plan, 'cursor.rules-dir').fileCount, 0);
		assert.ok(plan.lines.includes('  move    ~/.claude/skills/make-custom-app (old skill folder, version unknown, 0 files)'));

		const windows = buildPlan({ home: 'C:\\Users\\someone' });
		assert.equal(windows.backupRoot, 'C:\\Users\\someone\\.make-custom-app');
		const trailing = buildPlan({ home: `${PLAN_HOME}/` });
		assert.equal(trailing.backupRoot, path.join(PLAN_HOME, '.make-custom-app'));
		const rootPaths = oldInstallPaths('/');
		const root = buildPlan({ home: '/', claudeSkill: skillFacts(rootPaths.claudeSkill) });
		assert.equal(root.backupRoot, '/.make-custom-app');
		assert.ok(root.lines.includes('  move    /.claude/skills/make-custom-app (old skill folder, version 2.3.13, 12 files)'), 'a home of / shortens nothing');
	});

	it('buildPlan: a symbolic link without a target and an empty context entry still give notices that name no value', () => {
		const plan = buildPlan(fullFacts({ claudeSkill: skillFacts(PLAN_PATHS.claudeSkill, { symlink: true, linkTarget: null }), contextsDirs: ['', 5, PLAN_PATHS.cursorContexts] }));
		assert.deepEqual(plan.notices.filter((notice) => notice.kind === 'contexts').map((notice) => notice.file), [PLAN_PATHS.cursorContexts]);
		const link = plan.notices.find((notice) => notice.kind === 'symlink-target');
		assert.equal(link.text, '~/.claude/skills/make-custom-app is a symbolic link to another folder; only the link moves, and the files in another folder, its mcp-server/.env included, stay where they are.');
	});

	it('planLines copes with a hand-made plan: no server path, no version, no secrets block', () => {
		const home = PLAN_HOME;
		const items = [
			{ id: 'claude.mcp-entry', group: 'claude', kind: 'claude-mcp-entry', path: PLAN_PATHS.claudeJson, action: 'remove-entry', status: 'ready', key: 'make-custom-app', serverPath: null },
			{ id: 'claude.skill-dir', group: 'claude', kind: 'directory', path: PLAN_PATHS.claudeSkill, action: 'move', status: 'ready', symlink: false, version: null, fileCount: 2 },
		];
		assert.deepEqual(planLines({ home, items }), [
			'Claude Code items:',
			'  remove  "make-custom-app" from ~/.claude.json (old MCP registration, server unknown)',
			'  move    ~/.claude/skills/make-custom-app (old skill folder, version unknown, 2 files)',
		]);
	});

	it('buildPlan: a members list that is not a list, and members that are not objects or have no key, give no Cursor item', () => {
		const base = cursorFileFacts({ 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill) });
		const noList = buildPlan(fullFacts({ cursorMembers: { ...base, members: 'none' } }));
		assert.equal(idsOf(noList).some((id) => id.startsWith('cursor.mcp-entry')), false);
		const junk = buildPlan(fullFacts({ cursorMembers: { ...base, members: [null, 5, 'x', { entry: registrationOf(PLAN_PATHS.cursorSkill), withoutOwn: judged(registrationOf(PLAN_PATHS.cursorSkill)) }, { key: 7, withoutOwn: judged(registrationOf(PLAN_PATHS.cursorSkill)) }] } }));
		assert.equal(idsOf(junk).some((id) => id.startsWith('cursor.mcp-entry')), false);
		assert.deepEqual(secretSources(fullFacts({ cursorMembers: { ...base, members: [null] }, claudeEntry: null, claudeEnv: null, cursorEnv: null })), []);
	});

	it('restoreDecision reads the type from a step that names it kind', () => {
		assert.equal(restoreDecision({ kind: 'text-block', state: 'done' }, { markerPresent: true }), 'skip');
		assert.equal(restoreDecision({ kind: 'json-member', state: 'running' }, { keyPresent: false }), 'restore');
	});
});

describe('fix round 1: registration arguments never reach the plan', () => {
	const SEED = FAKE.otherToken;
	const OLD_CLAUDE = path.join(PLAN_PATHS.claudeSkill, 'mcp-server', 'dist', 'index.js');
	const OLD_CURSOR = path.join(PLAN_PATHS.cursorSkill, 'mcp-server', 'dist', 'index.js');
	const variants = (oldPath) => ({
		'npx with a space-separated flag': [{ command: 'npx', args: ['-y', '@acme/mcp', '--api-key', SEED] }, false],
		'mcp-remote with a header string': [{ command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.example.test/sse', '--header', `Authorization: Bearer ${SEED}`] }, false],
		'a positional secret after an absolute command': [{ command: '/usr/local/bin/acme-mcp', args: [SEED] }, false],
		'url userinfo': [{ command: 'npx', args: ['mcp-remote', `https://user:${SEED}@example.test/mcp`] }, false],
		'a secret in the url path': [{ command: 'npx', args: ['mcp-remote', `https://example.test/mcp/${SEED}`] }, false],
		'a command string that holds the secret': [{ command: `TOKEN ${SEED}` }, false],
		'a shell string that holds the secret': [{ command: 'sh', args: ['-c', `node /opt/x.js --key ${SEED}`] }, false],
		'the secret as the command': [{ command: SEED }, false],
		'type, url, headers, and env': [{ type: 'http', url: `https://example.test/?key=${SEED}`, headers: { Authorization: `Bearer ${SEED}` }, env: { OPENAI_API_KEY: SEED } }, false],
		'a secret after an old path': [{ command: '/usr/bin/node', args: [oldPath, '--token', SEED] }, true],
		'a header after an old path': [{ command: '/usr/bin/node', args: [oldPath, '--header', `Authorization: Bearer ${SEED}`] }, true],
		'an option with the old path inside': [{ command: '/usr/bin/node', args: [`--entry=${oldPath}`, '--token', SEED] }, true],
	});
	const everywhere = (plan) => [JSON.stringify(plan), plan.lines.join('\n'), util.inspect(plan, { depth: 20 }), ...plan.items.map((item) => `${item.reason}\n${item.fix}\n${JSON.stringify(item.fingerprint)}`)].join('\n');

	it('a Claude registration with a secret in any argument form shows no seed in the plan, its lines, or its fingerprint', () => {
		for (const [name, [entry, isOld]] of Object.entries(variants(OLD_CLAUDE))) {
			let plan;
			assert.doesNotThrow(() => {
				plan = buildPlan(fullFacts({ claudeEntry: claudeEntryFacts(entry) }));
			}, name);
			const item = itemOf(plan, 'claude.mcp-entry');
			assert.equal(item.status, isOld ? 'ready' : 'manual', name);
			assert.ok(!everywhere(plan).includes(SEED), `${name} shows the seed`);
			assert.ok(!util.inspect(fingerprint({ kind: 'claude-mcp-entry', entry }), { depth: 20 }).includes(SEED), name);
			assert.match(item.fingerprint, /^[0-9a-f]{64}$/, name);
		}
	});

	it('an old Cursor member with a secret in any argument form shows no seed anywhere', () => {
		for (const [name, [entry, isOld]] of Object.entries(variants(OLD_CURSOR))) {
			const members = { 'make-app-context': entry, legacy: registrationOf(PLAN_PATHS.cursorSkill) };
			let plan;
			assert.doesNotThrow(() => {
				plan = buildPlan(fullFacts({ cursorMembers: cursorFileFacts(members), cursorEnv: null }));
			}, name);
			const item = itemOf(plan, 'cursor.mcp-entry.make-app-context');
			assert.equal(item !== undefined, isOld, name);
			if (isOld) assert.equal(item.status, 'ready', name);
			assert.ok(!everywhere(plan).includes(SEED), `${name} shows the seed`);
		}
	});

	it('serverPath shows only an absolute path: a fallback has no space, equals sign, or at sign, and an old path may hold spaces', () => {
		const show = (entry, secretsText = '') => itemOf(buildPlan(fullFacts({ claudeEntry: claudeEntryFacts(entry), secretsText })), 'claude.mcp-entry');
		const windows = 'C:\\Users\\John Smith\\.claude\\skills\\make-custom-app\\mcp-server\\dist\\index.js';
		const spaced = show({ command: 'C:\\Program Files\\nodejs\\node.exe', args: [windows] });
		assert.equal(spaced.status, 'ready');
		assert.equal(spaced.serverPath, windows);
		assert.equal(show({ command: '/usr/bin/node', args: ['/opt/my dir/server.js'] }).serverPath, '/usr/bin/node');
		assert.equal(show({ command: '/usr/bin/node', args: ['/opt/a@b/server.js'] }).serverPath, '/usr/bin/node');
		assert.equal(show({ command: '/usr/bin/node', args: ['/opt/a=b/server.js'] }).serverPath, '/usr/bin/node');
		assert.equal(show({ command: 'node', args: ['server.js', 'relative/dir/x.js'] }).serverPath, null);
		const home = show({ command: '/usr/bin/node', args: [`${PLAN_PATHS.claudeSkill}/mcp-server@1/index.js`] });
		assert.equal(home.status, 'ready');
		assert.equal(home.serverPath, '/usr/bin/node');
		const unknown = show({ command: SEED, args: [SEED] });
		assert.equal(unknown.serverPath, null);
		assert.match(unknown.reason, /\(server unknown\)\.$/);
		assert.ok(!JSON.stringify(unknown).includes(SEED));
		const planned = buildPlan(fullFacts({ claudeEntry: claudeEntryFacts({ command: SEED, args: [SEED] }) }));
		assert.ok(planned.lines.some((line) => line.includes('(server unknown)')));
	});
});

describe('fix round 1: a plugin installed as a skills folder is never planned', () => {
	const labelsOf = (facts) => secretSources(facts).map((source) => source.label);
	const noFolderItems = (plan, group, paths) => {
		assert.equal(itemOf(plan, `${group}.skill-dir`), undefined);
		assert.equal(itemOf(plan, `${group}.env-file`), undefined);
		for (const item of plan.items) for (const dir of paths) assert.ok(item.path !== dir && !item.path.startsWith(dir + path.sep), `${item.id} lies in ${dir}`);
		assert.ok(!plan.notices.some((notice) => notice.kind === 'symlink-target'));
	};

	it('a Claude skills folder with a plugin marker or the running plugin inside is no item, no source, and its registration is manual', () => {
		const entry = registrationOf(PLAN_PATHS.claudeSkill);
		const cases = [
			['.claude-plugin', { claudeSkill: skillFacts(PLAN_PATHS.claudeSkill, { topNames: ['.claude-plugin', 'skills', 'shared', 'mcp'] }) }],
			['.cursor-plugin', { claudeSkill: skillFacts(PLAN_PATHS.claudeSkill, { topNames: ['.cursor-plugin', 'skills'] }) }],
			['the running plugin inside', { pluginRoot: path.join(PLAN_PATHS.claudeSkill, 'plugin') }],
			['the running plugin as the folder', { pluginRoot: PLAN_PATHS.claudeSkill }],
		];
		for (const [name, extra] of cases) {
			const facts = fullFacts({ claudeEntry: claudeEntryFacts(entry), ...extra });
			const plan = buildPlan(facts);
			noFolderItems(plan, 'claude', [PLAN_PATHS.claudeSkill]);
			assert.equal(itemOf(plan, 'claude.mcp-entry').status, 'manual', name);
			assert.deepEqual(labelsOf(facts).filter((label) => label.startsWith('claude')), [], name);
			assert.equal(itemOf(plan, 'cursor.skill-dir').status, 'ready', name);
			assert.ok(!plan.notices.some((notice) => notice.kind === 'claude-backup-copy'), name);
		}
	});

	it('a Cursor skills folder or rules folder that is a plugin, or holds the running plugin, is no item, no source, and its member is not listed', () => {
		const server = { 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill) };
		const skillCases = [
			['.cursor-plugin', { cursorSkill: skillFacts(PLAN_PATHS.cursorSkill, { topNames: ['.cursor-plugin'] }) }],
			['.claude-plugin', { cursorSkill: skillFacts(PLAN_PATHS.cursorSkill, { topNames: ['.claude-plugin'] }) }],
			['the running plugin inside', { pluginRoot: path.join(PLAN_PATHS.cursorSkill, 'plugin') }],
		];
		for (const [name, extra] of skillCases) {
			const facts = fullFacts({ cursorMembers: cursorFileFacts(server), ...extra });
			const plan = buildPlan(facts);
			noFolderItems(plan, 'cursor', [PLAN_PATHS.cursorSkill]);
			assert.equal(idsOf(plan).some((id) => id.startsWith('cursor.mcp-entry')), false, name);
			assert.deepEqual(labelsOf(facts).filter((label) => label.startsWith('cursor')), [], name);
		}
		const rulesCases = [
			['.cursor-plugin', { cursorRules: { path: PLAN_PATHS.cursorRules, names: ['.cursor-plugin', 'a.mdc'], fileCount: 2, sizeBytes: 1 } }],
			['.claude-plugin', { cursorRules: { path: PLAN_PATHS.cursorRules, names: ['.claude-plugin'], fileCount: 1, sizeBytes: 1 } }],
			['the running plugin inside', { pluginRoot: path.join(PLAN_PATHS.cursorRules, 'plugin') }],
		];
		for (const [name, extra] of rulesCases) {
			const plan = buildPlan(fullFacts(extra));
			assert.equal(itemOf(plan, 'cursor.rules-dir'), undefined, name);
			assert.equal(itemOf(plan, 'cursor.skill-dir').status, 'ready', name);
		}
	});

	it('a folder with an ordinary name and no plugin marker is still planned', () => {
		const plan = buildPlan(fullFacts({ pluginRoot: path.join(PLAN_PATHS.claudeSkill, '..', 'make-custom-app-2', 'plugin') }));
		assert.equal(itemOf(plan, 'claude.skill-dir').status, 'ready');
		const unrelated = buildPlan(fullFacts({ pluginRoot: undefined }));
		assert.equal(itemOf(unrelated, 'claude.skill-dir').status, 'ready');
	});
});

describe('fix round 1: an .env that is not inside the old skill folder', () => {
	const linked = (insideSkill) => fullFacts({
		claudeEntry: null,
		cursorMembers: null,
		cursorEnv: null,
		secretsText: '',
		claudeEnv: { path: PLAN_PATHS.claudeEnv, text: INSTALLER_ENV_TEXT, mode: 0o644, utf8Exact: true, insideSkill },
	});

	it('insideSkill false, missing, or not true gives no env-file item and no path outside the old install, and the keys still count', () => {
		const allowed = new Set(Object.values(PLAN_PATHS));
		for (const insideSkill of [false, undefined, 'yes', 1, null]) {
			const facts = linked(insideSkill);
			const plan = buildPlan(facts);
			assert.equal(itemOf(plan, 'claude.env-file'), undefined, String(insideSkill));
			assert.ok(!JSON.stringify(plan).includes(PLAN_PATHS.claudeEnv), String(insideSkill));
			for (const item of plan.items) assert.ok(allowed.has(item.path), item.path);
			assert.deepEqual(secretSources(facts).map((source) => source.label), ['claude-env']);
			assert.deepEqual(plan.secrets.copy, ['pinecone-api-key', 'openai-api-key', 'pinecone-index-name']);
			assert.equal(itemOf(plan, 'claude.skill-dir').status, 'ready');
		}
		assert.equal(itemOf(buildPlan(linked(true)), 'claude.env-file').action, 'delete');
	});

	it('the same holds for the Cursor .env', () => {
		const facts = fullFacts({ claudeEntry: null, cursorMembers: null, claudeEnv: null, cursorEnv: { path: PLAN_PATHS.cursorEnv, text: INSTALLER_ENV_TEXT, mode: 0o644, utf8Exact: true, insideSkill: false } });
		const plan = buildPlan(facts);
		assert.equal(itemOf(plan, 'cursor.env-file'), undefined);
		assert.ok(!JSON.stringify(plan).includes(PLAN_PATHS.cursorEnv));
		assert.deepEqual(secretSources(facts).map((source) => source.label), ['cursor-env']);
	});
});

describe('fix round 1: secret sources need the skill folder they come from', () => {
	const labels = (facts) => secretSources(facts).map((source) => source.label);

	it('secretSources ignores a Claude or Cursor .env when the matching skill facts are null, and keeps it for a symbolic link', () => {
		assert.deepEqual(labels(fullFacts({ claudeSkill: null })), ['claude-registration', 'cursor-registration:make-app-context', 'cursor-env']);
		assert.deepEqual(labels(fullFacts({ cursorSkill: null })), ['claude-registration', 'claude-env', 'cursor-registration:make-app-context']);
		assert.deepEqual(labels(fullFacts({ claudeSkill: null, cursorSkill: null })), ['claude-registration', 'cursor-registration:make-app-context']);
		const linkedBoth = fullFacts({ claudeSkill: skillFacts(PLAN_PATHS.claudeSkill, { symlink: true, linkTarget: path.join(TEST_ROOT, 'a') }), cursorSkill: skillFacts(PLAN_PATHS.cursorSkill, { symlink: true, linkTarget: path.join(TEST_ROOT, 'b') }) });
		assert.deepEqual(labels(linkedBoth), ['claude-registration', 'claude-env', 'cursor-registration:make-app-context', 'cursor-env']);
		assert.throws(() => secretSources({}), TypeError);
	});

	it('buildPlan does not copy a key from an .env whose skill folder is not planned', () => {
		const plan = buildPlan(fullFacts({ claudeSkill: null, cursorSkill: null, claudeEntry: null, cursorMembers: null, secretsText: '' }));
		assert.deepEqual(plan.secrets, { copy: [], conflicts: [] });
	});
});

describe('fix round 1: an unusable plugin', () => {
	const UNUSABLE = 'The plugin is not usable in this session, so nothing will be removed.';
	const usable = { recorded: true, userScope: true, enabled: true, installPath: PLAN_PLUGIN_ROOT, version: '3.0.0', runningFromInstall: true };

	it('each missing condition makes confirmRequired false and puts one line first, without changing the items or the digest', () => {
		const good = buildPlan(fullFacts());
		assert.equal(good.confirmRequired, true);
		assert.ok(!good.lines.includes(UNUSABLE));
		for (const flag of ['recorded', 'userScope', 'enabled', 'runningFromInstall']) {
			for (const value of [false, undefined]) {
				const plan = buildPlan(fullFacts({ plugin: { ...usable, [flag]: value } }));
				assert.equal(plan.confirmRequired, false, `${flag} ${value}`);
				assert.equal(plan.lines[0], UNUSABLE, flag);
				assert.deepEqual(plan.lines.slice(1), good.lines, flag);
				assert.equal(plan.lines.filter((line) => line === UNUSABLE).length, 1);
				assert.equal(plan.digest, good.digest, flag);
				assert.deepEqual(plan.items, good.items, flag);
			}
		}
		for (const plugin of [null, undefined, {}]) {
			const plan = buildPlan(fullFacts({ plugin }));
			assert.equal(plan.confirmRequired, false);
			assert.equal(plan.lines[0], UNUSABLE);
		}
	});

	it('an empty plan stays the single line, and a hand-made plan without a plugin block gets no extra line', () => {
		const empty = buildPlan({ home: PLAN_HOME, plugin: { recorded: false } });
		assert.deepEqual(empty.lines, ['Nothing to remove.']);
		assert.equal(empty.confirmRequired, false);
		const items = [{ id: 'claude.skill-dir', group: 'claude', kind: 'directory', path: PLAN_PATHS.claudeSkill, action: 'move', status: 'ready', symlink: false, version: '1', fileCount: 1 }];
		assert.ok(!planLines({ home: PLAN_HOME, items }).includes(UNUSABLE));
		assert.equal(planLines({ home: PLAN_HOME, items, plugin: { recorded: true, userScope: true, enabled: false, runningFromInstall: true } })[0], UNUSABLE);
	});
});

describe('fix round 1: planLines names the keys that differ', () => {
	const only = { claudeEntry: null, cursorMembers: null };

	it('a source value that differs from the secrets file gives one note line with the key and the source, no value', () => {
		const plan = buildPlan(fullFacts({ ...only, secretsText: `openai-api-key: ${FAKE.otherToken}\n` }));
		assert.deepEqual(plan.lines.slice(0, 4), [
			'Claude Code items:',
			'  copy    pinecone-api-key, pinecone-index-name into ~/.make-custom-app-skill-secrets (values already there win)',
			'  note    openai-api-key: the value in claude-env, cursor-env differs from your secrets file; the secrets file value stays, and the old value is kept in the backup',
			'  remove  the old skill block from ~/.claude/CLAUDE.md (lines 3 to 7)',
		]);
		assert.ok(plan.lines.includes('  keep    ~/.claude/skills/make-custom-app/mcp-server/.env in the backup (it holds a value that is not in your secrets file)'));
		for (const seed of SECRET_SEEDS) assert.ok(!plan.lines.join('\n').includes(seed));
	});

	it('two sources that differ with no secrets file value give one note line naming who is copied', () => {
		const other = INSTALLER_ENV_TEXT.replace(FAKE.pinecone, FAKE.conflictPinecone);
		const plan = buildPlan(fullFacts({ ...only, secretsText: '', cursorEnv: { path: PLAN_PATHS.cursorEnv, text: other, mode: 0o644, utf8Exact: true, insideSkill: true } }));
		assert.ok(plan.lines.includes('  note    pinecone-api-key: claude-env and cursor-env hold different values; the value in claude-env is copied and the others are kept in the backup'));
		assert.equal(plan.lines.filter((line) => line.startsWith('  note    ')).length, 1);
		for (const seed of SECRET_SEEDS) assert.ok(!plan.lines.join('\n').includes(seed));
	});

	it('the note lines go under the first group with a ready item, after the copy line, and are absent without a conflict', () => {
		const plan = buildPlan(fullFacts({ claudeEntry: null, claudeMd: null, claudeSkill: null, claudeEnv: null, cursorMembers: null, secretsText: `openai-api-key: ${FAKE.otherToken}\n` }));
		assert.equal(plan.lines[0], 'Cursor items (ask separately):');
		assert.ok(plan.lines[1].startsWith('  copy    '));
		assert.ok(plan.lines[2].startsWith('  note    openai-api-key:'));
		assert.ok(!buildPlan(fullFacts()).lines.some((line) => line.startsWith('  note    ')));
	});
});

describe('fix round 1: the digest, paths, keys, and formats', () => {
	it('reformats is in the digest: a canonical Cursor file that turns compact changes it', () => {
		const server = { 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill) };
		const canonical = buildPlan(fullFacts({ cursorMembers: cursorFileFacts(server) }));
		const compact = buildPlan(fullFacts({ cursorMembers: cursorFileFacts(server, { compact: true }) }));
		assert.equal(itemOf(canonical, 'cursor.mcp-entry.make-app-context').reformats, false);
		assert.equal(itemOf(compact, 'cursor.mcp-entry.make-app-context').reformats, true);
		assert.notEqual(canonical.digest, compact.digest);
		assert.equal(buildPlan(fullFacts({ cursorMembers: cursorFileFacts(server, { compact: true }) })).digest, compact.digest);
	});

	it('format jsonc makes the member manual even when the text is valid JSON', () => {
		const server = { 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill) };
		const item = itemOf(buildPlan(fullFacts({ cursorMembers: { ...cursorFileFacts(server), format: 'jsonc' } })), 'cursor.mcp-entry.make-app-context');
		assert.equal(item.status, 'manual');
		assert.equal(item.reason, '~/.cursor/mcp.json has comments or trailing commas, which the cleanup does not rewrite.');
		for (const format of ['missing', 'unreadable', undefined]) assert.equal(itemOf(buildPlan(fullFacts({ cursorMembers: { ...cursorFileFacts(server), format } })), 'cursor.mcp-entry.make-app-context').status, 'manual');
	});

	it('an item path that is not an old install location is replaced by a manual item with a fixed reason, and the foreign path never appears', () => {
		const REASON = 'The facts name a path that is not an old install location, so the cleanup does not touch it.';
		const FIX = 'Run the plan again; if this stays, remove the old install by hand.';
		const server = { 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill) };
		const cases = [
			['claude.skill-dir', PLAN_PATHS.claudeSkill, { claudeSkill: skillFacts('/etc/skill') }],
			['claude.mcp-entry', PLAN_PATHS.claudeJson, { claudeEntry: { ...claudeEntryFacts(registrationOf(PLAN_PATHS.claudeSkill)), file: '/etc/passwd' } }],
			['claude.sentinel', PLAN_PATHS.claudeMd, { claudeMd: { file: '/etc/hosts', realPath: '/etc/hosts', text: `${INSTALLER_BLOCK}\n`, mode: 0o644, utf8Exact: true } }],
			['claude.env-file', PLAN_PATHS.claudeEnv, { claudeEnv: { path: '/etc/shadow', text: INSTALLER_ENV_TEXT, mode: 0o644, utf8Exact: true, insideSkill: true } }],
			['cursor.mcp-entry.make-app-context', PLAN_PATHS.cursorMcp, { cursorMembers: { ...cursorFileFacts(server), file: '/etc/cursor.json' } }],
			['cursor.skill-dir', PLAN_PATHS.cursorSkill, { cursorSkill: skillFacts('/etc/cursor-skill') }],
			['cursor.env-file', PLAN_PATHS.cursorEnv, { cursorEnv: { path: '/etc/cursor.env', text: INSTALLER_ENV_TEXT, mode: 0o644, utf8Exact: true, insideSkill: true } }],
			['cursor.rules-dir', PLAN_PATHS.cursorRules, { cursorRules: { path: '/etc/rules', names: ['make-custom-app.mdc'], fileCount: 1, sizeBytes: 1 } }],
		];
		const allowed = new Set(Object.values(PLAN_PATHS));
		for (const [id, expected, extra] of cases) {
			const facts = fullFacts({ contextsDirs: ['/etc', PLAN_PATHS.claudeContexts], ...extra });
			const plan = buildPlan(facts);
			const item = itemOf(plan, id);
			if (id === 'claude.env-file' || id === 'cursor.env-file') {
				assert.equal(item.status, 'manual', id);
			} else if (id !== 'claude.skill-dir' && id !== 'cursor.skill-dir') {
				assert.equal(item.status, 'manual', id);
			} else {
				assert.equal(item.status, 'manual', id);
			}
			assert.equal(item.path, expected, id);
			assert.equal(item.reason, REASON, id);
			assert.equal(item.fix, FIX, id);
			assert.equal(item.group, id.split('.')[0]);
			assert.ok(!JSON.stringify(plan).includes('/etc'), id);
			for (const entry of plan.items) assert.ok(allowed.has(entry.path), `${id}: ${entry.path}`);
			assert.deepEqual(plan.notices.filter((notice) => notice.kind === 'contexts').map((notice) => notice.file), [PLAN_PATHS.claudeContexts], id);
			assert.ok(plan.lines.includes(`  ${id}: ${REASON} Fix: ${FIX}`), id);
			assert.equal(plan.digest, buildPlan(facts).digest);
		}
	});

	it('a registration, an .env, or a CLAUDE.md at a foreign path is no secret source and no own-line notice', () => {
		const foreignEntry = { ...claudeEntryFacts(registrationOf(PLAN_PATHS.claudeSkill)), file: '/etc/passwd' };
		const foreignEnv = { path: '/etc/shadow', text: INSTALLER_ENV_TEXT, mode: 0o644, utf8Exact: true, insideSkill: true };
		const foreignMembers = { ...cursorFileFacts({ 'make-app-context': registrationOf(PLAN_PATHS.cursorSkill) }), file: '/etc/cursor.json' };
		const facts = fullFacts({ claudeEntry: foreignEntry, claudeEnv: foreignEnv, cursorEnv: foreignEnv, cursorMembers: foreignMembers, secretsText: '' });
		assert.deepEqual(secretSources(facts), []);
		const md = { file: '/etc/hosts', realPath: '/etc/hosts', text: 'the make-custom-app skill\n', mode: 0o644, utf8Exact: true };
		assert.deepEqual(buildPlan(fullFacts({ claudeMd: md })).notices.filter((notice) => notice.kind === 'own-line'), []);
	});

	it('env-file keys list only the three known names; every other assignment name is counted, never shown, and a change of one changes the digest', () => {
		const text = `${INSTALLER_ENV_TEXT}${FAKE.otherToken}=\nB_NAME=1\n`;
		const facts = (envText) => fullFacts({ claudeEntry: null, cursorMembers: null, cursorEnv: null, claudeEnv: { path: PLAN_PATHS.claudeEnv, text: envText, mode: 0o644, utf8Exact: true, insideSkill: true } });
		const plan = buildPlan(facts(text));
		const item = itemOf(plan, 'claude.env-file');
		assert.deepEqual(item.keys, ['PINECONE_API_KEY', 'PINECONE_INDEX_NAME', 'OPENAI_API_KEY']);
		assert.equal(item.other, 2);
		assert.equal(item.action, 'keep-in-backup');
		for (const seed of SECRET_SEEDS) assert.ok(!JSON.stringify(plan).includes(seed), seed);
		assert.ok(!JSON.stringify(plan).includes('B_NAME'));
		assert.notEqual(buildPlan(facts(text.replace('B_NAME', 'C_NAME'))).digest, plan.digest);
		assert.equal(buildPlan(facts(text.replace('B_NAME=1', 'B_NAME=2'))).digest, plan.digest);
		assert.equal(itemOf(buildPlan(facts(INSTALLER_ENV_TEXT)), 'claude.env-file').other, 0);
	});
});
