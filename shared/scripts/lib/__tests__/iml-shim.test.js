const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const shim = require('../iml-shim');

describe('the registry', () => {
	it('covers 83 functions and holds the three declared gaps, nothing else', () => {
		assert.equal(shim.SHIM_COVERED.length, 83);
		const iml = shim.createImlShim();
		assert.deepEqual(Object.keys(iml).sort(), [...shim.SHIM_COVERED, ...Object.keys(shim.SHIM_GAPS)].sort());
		for (const name of Object.keys(iml)) assert.equal(typeof iml[name], 'function', name);
	});

	it('has no prototype: toString is the IML function, constructor and template-only names are undefined', () => {
		const iml = shim.createImlShim();
		assert.equal(Object.getPrototypeOf(iml), null);
		assert.equal(iml.toString([1, 'a', null]), '[1,a,]');
		assert.equal(iml.constructor, undefined);
		assert.equal(iml.hasOwnProperty, undefined);
		for (const name of Object.keys(shim.TEMPLATE_ONLY)) assert.equal(iml[name], undefined, name);
	});

	it('gives the spec hints for the templates-only names and frozen lists', () => {
		const rest = ['cryptoSign', 'errorFactory', 'createXML', 'parseXML', 'safeSerialize', 'getFieldMapping'];
		assert.deepEqual(shim.TEMPLATE_ONLY, { parseJSON: 'JSON.parse', createJSON: 'JSON.stringify', isArray: 'Array.isArray', pop: 'the array method', shift: 'the array method', ...Object.fromEntries(rest.map((n) => [n, 'plain JavaScript'])) });
		const changes = ['addSeconds', 'addMinutes', 'addHours', 'addDays', 'addMonths', 'addYears', 'setSecond', 'setMinute', 'setHour', 'setDay', 'setDate', 'setMonth', 'setYear'];
		assert.deepEqual(Object.keys(shim.SHIM_GAP_RULES), ['jwt', 'formatDate', 'parseDate', 'mime', ...changes]);
		for (const fn of changes) assert.equal(shim.SHIM_GAP_RULES[fn], 'date text with digits in no accepted form', fn);
		for (const list of [shim.SHIM_COVERED, shim.SHIM_GAPS, shim.SHIM_GAP_RULES, shim.TEMPLATE_ONLY]) assert.ok(Object.isFrozen(list));
	});
});

describe('gaps and warnings', () => {
	it('a declared gap calls onGap and throws ShimGapError with the spec wording', () => {
		const seen = [];
		const iml = shim.createImlShim({ onGap: (fn, detail) => seen.push([fn, detail]) });
		assert.throws(() => iml.generateJwtWithKeyId({}), (err) => err instanceof shim.ShimGapError && err.fn === 'generateJwtWithKeyId' && err.message === "iml.generateJwtWithKeyId is not in the plugin's shim");
		assert.deepEqual(seen, [['generateJwtWithKeyId', '']]);
	});

	it('a gap input of a covered function carries its detail', () => {
		const iml = shim.createImlShim();
		assert.throws(() => iml.formatDate(new Date(0), 'zz'), { name: 'ShimGapError', message: 'iml.formatDate with the token "zz" is not in the plugin\'s shim' });
	});

	it('a date text it cannot read is a gap of the function called, not of parseDate', () => {
		const seen = [];
		const iml = shim.createImlShim({ onGap: (fn, detail) => seen.push([fn, detail]) });
		assert.throws(() => iml.formatDate('Dec 28, 2016', 'YYYY'), { name: 'ShimGapError', fn: 'formatDate', message: 'iml.formatDate with the date text "Dec 28, 2016" is not in the plugin\'s shim' });
		assert.throws(() => iml.addDays('Dec 28, 2016', 1), { name: 'ShimGapError', fn: 'addDays', message: 'iml.addDays with the date text "Dec 28, 2016" is not in the plugin\'s shim' });
		assert.throws(() => iml.setYear('Dec 28, 2016', 2020), { name: 'ShimGapError', fn: 'setYear' });
		assert.throws(() => iml.parseDate('Dec 28, 2016'), { name: 'ShimGapError', fn: 'parseDate', message: 'iml.parseDate without a format on "Dec 28, 2016" is not in the plugin\'s shim' });
		const detail = 'with the date text "Dec 28, 2016"';
		assert.deepEqual(seen, [['formatDate', detail], ['addDays', detail], ['setYear', detail], ['parseDate', 'without a format on "Dec 28, 2016"']]);
	});

	it('an unknown zone warns once and the dates use UTC', () => {
		const warnings = [];
		const iml = shim.createImlShim({ timezone: 'Mars/Base', onWarning: (kind, zone) => warnings.push([kind, zone]) });
		assert.deepEqual(warnings, [['unknown-zone', 'Mars/Base']]);
		assert.equal(iml.formatDate(new Date('2026-03-29T00:30:00Z'), 'HH:mm'), '00:30');
		assert.equal(shim.createImlShim({ timezone: 'Mars/Base' }).formatDate(new Date('2026-03-29T00:30:00Z'), 'HH:mm'), '00:30');
	});

	it('a known zone warns nothing and reaches the date functions; jwt, mime and the other gaps report through onGap', () => {
		const warnings = [];
		const seen = [];
		const iml = shim.createImlShim({ timezone: 'Europe/Prague', onWarning: (...w) => warnings.push(w), onGap: (fn, detail) => seen.push([fn, detail]) });
		assert.deepEqual(warnings, []);
		assert.equal(iml.formatDate(new Date('2026-03-29T00:30:00Z'), 'HH:mm'), '01:30');
		assert.throws(() => iml.jwt({}, 's', 'ES256'), { name: 'ShimGapError', message: 'iml.jwt with the algorithm "ES256" is not in the plugin\'s shim' });
		assert.throws(() => iml.mime('a.xyz123'), { name: 'ShimGapError', message: 'iml.mime for the extension "xyz123" is not in the plugin\'s shim' });
		assert.throws(() => iml.dateDiff(), { name: 'ShimGapError' });
		assert.throws(() => iml.toDataStructure(), { name: 'ShimGapError' });
		assert.deepEqual(seen, [['jwt', 'with the algorithm "ES256"'], ['mime', 'for the extension "xyz123"'], ['dateDiff', ''], ['toDataStructure', '']]);
		assert.equal(iml.mime('a.json'), 'application/json');
		assert.equal(iml.jwt({}, 's').split('.').length, 3);
	});

	it('builds the error text with and without a detail', () => {
		assert.equal(new shim.ShimGapError('dateDiff').message, "iml.dateDiff is not in the plugin's shim");
		const err = new shim.ShimGapError('parseDate', 'without a format on "x1"');
		assert.equal(err.message, 'iml.parseDate without a format on "x1" is not in the plugin\'s shim');
		assert.equal(err.detail, 'without a format on "x1"');
		assert.ok(err instanceof Error);
	});
});

describe('the source', () => {
	it('reads the clock only through now()', () => {
		for (const file of ['iml-shim.js', 'iml-shim-dates.js', 'iml-shim-helpers.js']) {
			const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
			assert.doesNotMatch(text, /Date\.now\(\)|new Date\(\)/, file);
		}
	});
});

describe('behaviours outside the parity table', () => {
	const m1 = shim.createImlShim();
	const m2 = shim.createImlShim({ manifest: 2 });

	it('shuffle returns the same items in some order and leaves the input as it was', () => {
		const input = [1, 2, 3, 4];
		const out = m1.shuffle(input);
		assert.deepEqual([...out].sort(), [1, 2, 3, 4]);
		assert.notEqual(out, input);
		assert.deepEqual(input, [1, 2, 3, 4]);
	});

	it('shuffle reaches every order of four items', () => {
		// A fair shuffle misses one of the 24 orders in 2,000 runs with a chance below 1e-35.
		const seen = new Set();
		for (let i = 0; i < 2000; i++) seen.add(m1.shuffle([1, 2, 3, 4]).join(''));
		assert.equal(seen.size, 24);
	});

	it('if evaluates nothing lazily: both branches are values', () => {
		const branch = () => 'called';
		assert.equal(m1.if(true, branch, 'b'), branch);
		assert.equal(m1.if(0, 'a', branch), branch);
	});

	it('toBinary gives a Buffer back as it is, and set copies the value it stores', () => {
		const buffer = Buffer.from('x');
		assert.equal(m1.toBinary(buffer), buffer);
		const value = { x: 1 };
		const out = m1.set({}, 'a', value);
		assert.deepEqual(out, { a: { x: 1 } });
		assert.notEqual(out.a, value);
		const bytes = m1.set({}, 'f', buffer).f;
		assert.ok(bytes instanceof Uint8Array && !Buffer.isBuffer(bytes));
		assert.equal(m1.toBinary(bytes), bytes);
	});

	it('add, sort, reverse and slice leave the input array as it was', () => {
		const input = [3, 1, 2];
		m1.add(input, 4);
		m1.sort(input);
		m1.reverse(input);
		const part = m1.slice(input, 1);
		assert.deepEqual(part, [1, 2]);
		part.push(9);
		assert.deepEqual(input, [3, 1, 2]);
	});

	it('distinct keeps every invalid date and one of each other value', () => {
		const out = m1.distinct([new Date(NaN), new Date(NaN), new Date(0), new Date(0), '0', 0, null, undefined]);
		assert.equal(out.length, 5);
		assert.ok(out.slice(0, 2).every((d) => Number.isNaN(d.getTime())));
		assert.deepEqual(out.slice(2), [new Date(0), '0', null]);
	});

	it('reads long inputs in linear time', () => {
		const started = process.hrtime.bigint();
		assert.equal(m1.stripHTML('<'.repeat(100000)).length, 100000);
		assert.deepEqual(m1.map([{ a: 1, b: 'x' }], 'a', 'b', `${' '.repeat(100000)}x`), []);
		assert.equal(m1.get({}, `\`${'`['.repeat(50000)}`), null);
		assert.equal(m1.formatDate(new Date(0), '[a'.repeat(80000)), '[am'.repeat(80000));
		assert.throws(() => m1.parseDate('2020', '['.repeat(80000)), { message: "'2020' is not a valid date or does not match the date format." });
		assert.ok(process.hrtime.bigint() - started < 5000000000n, 'five calls took 5 s or more');
	});

	it('manifest 2 and higher keep an empty input; manifest 1 and lower turn it into null', () => {
		assert.equal(shim.createImlShim({ manifest: 3 }).lower(undefined), undefined);
		assert.equal(shim.createImlShim({ manifest: 0 }).lower(undefined), null);
		assert.equal(m2.lower(null), null);
	});
});

const ERR = Symbol('error');
const fails = (message, name = 'Error') => ({ [ERR]: { name, message } });
const b = (text) => Buffer.from(text);
const D = (iso) => new Date(iso);
const T = '2026-03-29T00:30:00.000Z';
const fn1 = () => 1;
const hash = (alg, data, enc = 'hex') => crypto.createHash(alg).update(data).digest(enc);
const hmac = (alg, key, data, enc = 'hex') => crypto.createHmac(alg, key).update(data).digest(enc);
const NO_DATA = 'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received null';
/** set stores a structured clone, which turns a Buffer into a plain Uint8Array. */
const viaSet = (bytes) => shim.createImlShim().set({}, 'f', bytes).f;
const U8 = viaSet(b('hi'));
const shared = (bytes) => {
	const store = new SharedArrayBuffer(bytes.length);
	new Uint8Array(store).set(bytes);
	return store;
};

/** [function, arguments, result with manifest 1, result with manifest 2 when it differs]; fails() is a thrown error. */
const ROWS = [
	['if', [true, 'a', 'b'], 'a'],
	['if', ['', 'a', 'b'], 'b'],
	['ifempty', ['', 'b'], 'b'],
	['ifempty', [0, 'b'], 0],
	['ifempty', [undefined, 'b'], 'b'],
	['switch', ['B', 'A', 1, 'B', 2], 2],
	['switch', ['X', 'A', 1, 'else'], 'else'],
	['switch', [2, '2', 'two'], 'two'],
	['switch', [true, 'true', 'yes'], 'yes'],
	['switch', ['X', 'A', 1], null, undefined],
	['switch', [[1], '1', 'one'], null, undefined],
	['switch', [[1], '1', 'one', 'd'], 'd'],
	['switch', ['a', {}, 1, 'a', 2], 2],
	['switch', [null, 'A', 1, null], null],
	['get', [{ a: { b: 1 } }, 'a.b'], 1],
	['get', [[10, 20, 30], 2], 20],
	['get', [{ a: [{ b: 1 }] }, 'a[1].b'], 1],
	['get', [{ a: [1, 2] }, 'a[]'], 1],
	['get', [[10, 20, 30], '[2]'], 20],
	['get', [{ '': 5 }, '[1]'], 5],
	['get', [[1, 2], ''], null, undefined],
	['get', [[[1, 2]], '1[2]'], 2],
	['get', [{ a: 1 }, 'z'], null, undefined],
	['get', [{ a: 1 }, 'constructor'], null, undefined],
	['get', [[1, 2], 'x'], null, undefined],
	['get', [{ f: fn1 }, 'f'], null, undefined],
	['get', [{ a: 'xyz' }, 'a.length'], 'xyz'],
	['get', [{ 'a.b': 1 }, '`a.b`'], 1],
	['get', [{ a: { 'b.c': 2 } }, 'a.`b.c`'], 2],
	['get', [{ 'x`y': 3 }, '`x``y`'], 3],
	['get', [{ a: { b: null } }, 'a.b.c'], null],
	['get', [{ a: [[1, 2]] }, 'a[1][2]'], null, undefined],
	['get', [null, 'a'], null],
	['get', [undefined, 'a'], null, undefined],
	['set', [{ a: 1 }, 'b', 2], { a: 1, b: 2 }],
	['set', [{}, 'a.b', 1], { a: { b: 1 } }],
	['set', [{}, 'a[2]', 'x'], { a: [undefined, 'x'] }],
	['set', [[1, 2], '3', 'x'], [1, 2, 'x']],
	['set', [{ a: [1, 2] }, 'a[1]', 9], { a: [9, 2] }],
	['set', [{ a: 1 }, 'a.0', 'z'], { a: ['z'] }],
	['set', [{ a: 1 }, 'a.-1', 2], { a: { '-1': 2 } }],
	['set', [{ 'a.b': 1 }, '`a.b`', 2], { 'a.b': 2 }],
	['set', ['abc', 'a', 1], 'abc'],
	['set', [null, 'a', 1], null],
	['set', [undefined, 'a', 1], null, undefined],
	['set', [{ a: 1 }, null, 1], fails("Function 'set' finished with error! Path must be a string.")],
	['set', [{ a: 1 }, '  ', 1], fails("Function 'set' finished with error! Path must be a string.")],
	['set', [{ a: 1 }, '__proto__.x', 1], fails('"Function \'set\' finished with error! Forbidden key used in path."')],
	['pick', [{ a: 1, b: 2, c: 3 }, 'c', 'a'], { c: 3, a: 1 }],
	['pick', [{ a: 1, b: 2 }, ['a', 'z']], { a: 1 }],
	['pick', [{ a: 1 }], {}],
	['pick', [null, 'a'], {}],
	['omit', [{ a: 1, b: 2, c: 3 }, 'a', 'c'], { b: 2 }],
	['omit', [{ a: 1, b: 2 }, ['a']], { b: 2 }],
	['omit', [{ a: 1 }], { a: 1 }],
	['omit', [0, 'a'], {}],

	['abs', [-3], 3],
	['abs', ['-2'], 2],
	['abs', ['abc'], fails("'abc' is not number.")],
	['abs', [null], fails("'{empty}' is not number.")],
	['abs', ['x'.repeat(101)], fails('Invalid number.')],
	['abs', [fn1], fails('Invalid number.')],
	['ceil', ['3.1'], 4],
	['ceil', [''], null],
	['ceil', ['abc'], fails("'abc' is not a valid number.")],
	['ceil', [undefined], null, undefined],
	['floor', [-2.1], -3],
	['floor', [true], fails("'true' is not a valid number.")],
	['floor', [''], null],
	['floor', [undefined], null, undefined],
	['round', [2.5], 3],
	['round', [''], null],
	['round', ['abc'], NaN],
	['round', [[1]], fails("'{array}' is not a valid number.")],
	['round', [D('2026-01-01T00:00:00.000Z')], fails("'2026-01-01T00:00:00.000Z' is not a valid number.")],
	['round', [b('x')], fails("'{buffer}' is not a valid number.")],
	['round', [undefined], null, undefined],
	['trunc', [1.567, 2], 1.56],
	['trunc', [1.5, 5], 1.5],
	['trunc', [123, -2], 100],
	['trunc', [5, 2], 5],
	['trunc', ['2.75', '1'], 2.7],
	['trunc', [1.5, null], fails("'{{numDigits}}' is not a valid number.")],
	['trunc', ['abc'], fails("'abc' is not a valid number.")],
	['min', [[1, 'a', 3]], 1],
	['min', [5, 2, '1'], 1],
	['min', [[]], Infinity],
	['max', [1, 5, '9'], 9],
	['sum', [[1, 2, '3']], 6],
	['sum', [0.1, 0.2], 0.30000000000000004],
	['sum', [null], 0],
	['average', [[1, 2]], 1.5],
	['average', [1, 'x', 4], 2.5],
	['average', [[]], NaN],
	['median', [[3, 1, 2]], 2],
	['median', [[1, 2, 3, 4]], 2.5],
	['median', [3, 1, 2], 2],
	['median', [[1], [2, 3]], 2],
	['median', [[]], null],
	['median', [], null],
	['median', [null], fails("'{{number}}' is not a valid number.")],
	['median', [['1']], fails("'{{number}}' is not a valid number.")],
	['median', ['x'.repeat(101)], fails('Invalid number.')],
	['stdevS', [1, 2, 3, 4], 1.2909944487358056],
	['stdevP', [[2, 4, 4, 4, 5, 5, 7, 9]], 2],
	['stdevS', [null], fails("'{{number}}' is not a valid number.")],
	['parseNumber', ['1.234,56', ','], 1234.56],
	['parseNumber', ['1,234.56'], 1234.56],
	['parseNumber', ['-1,5', ','], -1.5],
	['parseNumber', ['abc'], 0],
	['parseNumber', [12], 12],
	['parseNumber', ['12'], 12],
	['parseNumber', [true], fails("'true' is not a valid number.")],
	['parseNumber', ['x1', ';'], fails("Valid separators are ',' and '.'.")],
	['parseNumber', ['-', '.'], fails("'-' is not a valid number or using unsuitable separator.")],
	['parseNumber', [undefined], null, undefined],
	['parseNumber', ['--1'], -1],
	['parseNumber', ['a-1'], 1],
	['parseNumber', ['e5'], 5],
	['parseNumber', ['1e5'], 100000],
	['parseNumber', ['1E5'], 15],
	['parseNumber', ['١٢'], 0],
	['parseNumber', ['', ','], 0],
	['parseNumber', ['1,2,3'], 123],
	['parseNumber', ['1.2.3', ','], 123],
	['parseNumber', ['x1', null], 1],
	['parseNumber', ['12', ';'], 12],
	['parseNumber', ['x1', 1], fails("Valid separators are ',' and '.'.")],
	['parseNumber', ['1e'], fails("'1e' is not a valid number or using unsuitable separator.")],
	['parseNumber', ['1.2.3'], fails("'1.2.3' is not a valid number or using unsuitable separator.")],
	['parseNumber', ['1,2,3', ','], fails("'1,2,3' is not a valid number or using unsuitable separator.")],
	['parseNumber', ['0,0000001', ','], fails("'0,0000001' is not a valid number or using unsuitable separator.")],
	['parseNumber', ['1.'.repeat(60)], fails('Invalid number or separator.')],
	['parseNumber', [[12]], fails("'{array}' is not a valid number.")],
	['formatNumber', [1234.5, 2], '1.234,50'],
	['formatNumber', [1234567.891, 2, '.', ' '], '1 234 567.89'],
	['formatNumber', [-1234.567, 2, ',', '.'], '-1.234,57'],
	['formatNumber', [2.345, 2, '.', ','], '2.35'],
	['formatNumber', [5], '5'],
	['formatNumber', [999, 0], '999'],
	['formatNumber', [true, 2], fails("'true' is not a valid number.")],
	['formatNumber', ['abc', 2], fails("'NaN' is not a valid number or using unsuitable separator.")],
	['formatNumber', [1e21, 0], fails("'1e+21' is not a valid number or using unsuitable separator.")],
	['formatNumber', [null, 2], null],
	['formatNumber', [undefined, 2], null, undefined],

	['length', [null], 0],
	['length', ['😀'], 2],
	['length', [[1, 2]], 2],
	['length', [b('hé')], 3],
	['length', [{ a: 1 }], 15],
	['length', [123], 3],
	['lower', ['HeLLo'], 'hello'],
	['lower', [{}], '[object object]'],
	['lower', [undefined], null, undefined],
	['upper', [true], 'TRUE'],
	['upper', [null], null],
	['capitalize', ['hello world'], 'Hello world'],
	['capitalize', [''], ''],
	['capitalize', [undefined], null, undefined],
	['startcase', ['hello WORLD foo-bar'], 'Hello World Foo-bar'],
	['startcase', ['  a  b'], '  A  B'],
	['startcase', [null], null],
	['trim', ['\u00a0 a \n'], 'a'],
	['trim', [12], '12'],
	['trim', [undefined], null, undefined],
	['ascii', ['Příliš žluťoučký kůň'], 'Pli luouk k'],
	['ascii', ['Příliš žluťoučký', true], 'Prilis zlutoucky'],
	['ascii', [undefined], null, undefined],
	['replace', ['a.b.c', '.', '-'], 'a-b-c'],
	['replace', ['abcb', '/b/g', 'x'], 'axcx'],
	['replace', ['abcb', '/b/', 'x'], 'axcb'],
	['replace', ['abc', '/b/gi', 'x'], 'abc'],
	['replace', ['a/b/gi', '/b/gi', 'x'], 'ax'],
	['replace', ['aaa', 'a', '$$'], '$$$'],
	['replace', ['a//b', '//', 'x'], 'xa//b'],
	['replace', ['abc', '/(?<n>b)/', '[$<n>]'], 'a[b]c'],
	['replace', ['abc', '/[/', 'x'], fails('Invalid regular expression: /[/: Unterminated character class', 'SyntaxError')],
	['replace', [123, '2', 9], '193'],
	['replace', [123, null, 'x'], 123],
	['replace', ['abc', 'b', null], 'abc'],
	['replace', [b('abc'), 'b', 'x'], 'axc'],
	['replace', [true, 'a', 'b'], fails("'true' is not string or number.")],
	['replace', ['abc', {}, 'x'], fails("'{object}' is not string or number.")],
	['replace', ['abc', 'b', [1]], fails("'{array}' is not string or number.")],
	['replace', [null, 'a', 'b'], null],
	['replace', [undefined, 'a', 'b'], null, undefined],
	['replaceEmojiCharacters', ['hi 😀 there 👍🏽', ''], 'hi  there '],
	['replaceEmojiCharacters', ['a😀', '[$&]'], 'a[😀]'],
	['replaceEmojiCharacters', ['a\u231A\uFE0Fb \u23E9\uFE0F', '_'], 'a_b _\uFE0F'],
	['replaceEmojiCharacters', ['\u{1F1E6} 1 # \u00A9 1\u20E3 \u{1F1E8}\u{1F1FF}', '_'], '\u{1F1E6} 1 # _ _ _'],
	['replaceEmojiCharacters', [b('a😀'), 1], 'a1'],
	['replaceEmojiCharacters', ['a', null], fails("The replacement value is required to be added. Invalid value: '{empty}'")],
	['replaceEmojiCharacters', [true, 'x'], fails("'true' is not string or number.")],
	['replaceEmojiCharacters', ['a', {}], fails("'{object}' is not string or number.")],
	['replaceEmojiCharacters', [undefined, 'x'], null, undefined],
	['substring', ['hello', 1, 3], 'el'],
	['substring', [undefined, 1], null, undefined],
	['indexOf', ['hello', 'l', 3], 3],
	['indexOf', [[1, 2], 2], 2],
	['indexOf', [undefined, 'a'], null, undefined],
	['base64', ['hello'], 'aGVsbG8='],
	['base64', [b('hello')], 'aGVsbG8='],
	['base64', [null], ''],
	['base64', [[1, 2]], 'WzEsMl0='],
	['md5', ['abc'], '900150983cd24fb0d6963f7d28e17f72'],
	['md5', [123], hash('md5', '123')],
	['md5', [null], fails(NO_DATA, 'TypeError')],
	['sha1', ['abc', 'hex', ''], hmac('sha1', '', 'abc')],
	['sha1', ['abc', 'latin1'], hash('sha1', 'abc', 'latin1')],
	['sha512', ['abc', 'hex', ''], hash('sha512', 'abc')],
	['sha512', ['abc', 'base64', 'key'], hmac('sha512', 'key', 'abc', 'base64')],
	['sha256', ['abc', 'HEX'], hash('sha256', 'abc')],
	['sha256', ['abc', 'bad'], hash('sha256', 'abc')],
	['sha256', ['abc', 'base64', '6b6579', 'hex'], hmac('sha256', 'key', 'abc', 'base64')],
	['sha256', ['abc', 'hex', 'a2V5', 'BASE64'], hmac('sha256', 'key', 'abc')],
	['sha256', ['abc', 'hex', b('key'), 'binary'], hmac('sha256', 'key', 'abc')],
	['sha256', ['abc', 'hex', 'key', 'odd'], hmac('sha256', 'key', 'abc')],
	['sha256', ['abc', 'hex', 'key', 'binary'], fails("Key 'binary' is not a valid buffer.")],
	['sha256', [undefined], fails(NO_DATA, 'TypeError')],
	['sha1', ['abc', 5], fails('arguments[1].toLowerCase is not a function', 'TypeError')],
	['sha1', ['abc', 'hex', 'key', []], fails('arguments[3].toLowerCase is not a function', 'TypeError')],
	['sha256', ['abc', true], fails('arguments[1].toLowerCase is not a function', 'TypeError')],
	['sha256', ['abc', 'hex', 'key', 7], fails('arguments[3].toLowerCase is not a function', 'TypeError')],
	['sha512', ['abc', {}], fails('arguments[1].toLowerCase is not a function', 'TypeError')],
	['sha512', ['abc', 'hex', 'key', {}], fails('arguments[3].toLowerCase is not a function', 'TypeError')],
	['toString', [[1, 'a', null]], '[1,a,]'],
	['toString', [[{ a: 1 }, b('x'), D(T), [2, [3]], undefined]], `[{object},{buffer},${T},[2,[3]],]`],
	['toString', [D(T)], T],
	['toString', [{ a: 1 }], '{object}'],
	['toString', [null], ''],
	['toString', [123], '123'],
	['toString', ['12'], '12'],
	['toString', [true], 'true'],
	['toString', [fn1], ''],
	['toString', [b('hi'), 'base64'], 'aGk='],
	['toString', [b('hi'), 'UTF-8'], 'hi'],
	['toString', [b('hi'), 'hex', 'extra'], 'hi'],
	['toString', [b('hi'), 'BAD'], fails("'bad' is not a valid encoding.")],
	['toString', ['x', 5], fails("'5' is not a valid encoding.")],
	['toString', ['abc', 'hex'], 'abc'],
	['toString', [false], 'false'],
	['toString', [10n], ''],
	['toString', [null, 'BAD'], ''],
	['toString', [D(T), 'BAD'], fails("'bad' is not a valid encoding.")],
	['toBinary', ['hello'], b('hello')],
	['toBinary', ['68656c6c6f', 'hex'], b('hello')],
	['toBinary', ['1234', 'hex'], b('1234')],
	['toBinary', [123], b('123')],
	['toBinary', ['hé', 'ascii'], Buffer.from([0x68, 0xe9])],
	['toBinary', ['x', 'bad'], fails("'bad' is not a valid encoding.")],
	['toBinary', ['x', undefined], fails("'{empty}' is not a valid encoding.")],
	['toBinary', [null], null],
	['toBinary', [undefined], null, undefined],
	['encodeURL', ['a b&c/é'], 'a%20b%26c%2F%C3%A9'],
	['encodeURL', [undefined], null, undefined],
	['decodeURL', ['%E2%9C%93'], '✓'],
	['decodeURL', ['%zz'], fails('URI malformed', 'URIError')],
	['decodeURL', [null], null],
	['stripHTML', ['<p>Hi<br/>there</p><script type="x">x()</script><style>p{}</style>&amp;'], 'Hi\nthere&amp;'],
	['stripHTML', [undefined], null, undefined],
	['escapeHTML', ['<a>&"'], '&lt;a&gt;&amp;"'],
	['escapeHTML', [undefined], null, undefined],
	['escapeMarkdown', ['#*_=-~+[]():!/\\`|<>&.'], '&#35;&#42;&#95;&#61;&#45;&#126;&#43;&#91;&#93;&#40;&#41;&#58;&#33;&#47;&#92;&#96;&#124;&lt;&gt;&amp;.'],
	['escapeMarkdown', [undefined], null, undefined],
	['escapeJSON', ['he said "hi"\n'], 'he said \\"hi\\"\\n'],
	['escapeJSON', [12], '12'],
	['escapeJSON', [undefined], null, undefined],
	['split', ['a, b,,c', ','], ['a', 'b', 'c']],
	['split', ['a,,b', ',', true], ['a', '', 'b']],
	['split', ['abc', ''], ['a', 'b', 'c']],
	['split', ['', ','], []],
	['split', ['12', ','], ['12']],
	['split', [12, ','], ['12']],
	['split', [true, ','], null],
	['split', [undefined, ','], null],
	['split', [D(T)], fails('arr.map is not a function', 'TypeError')],
	['contains', ['Hello', 'ell'], true],
	['contains', ['Hello', 'ELL', true], true],
	['contains', [123, '2', true], true],
	['contains', [123, 2], fails('array.indexOf is not a function', 'TypeError')],
	['contains', [[1, 2, '3'], 3], true],
	['contains', [['a', 'B'], 'b', 'ci'], true],
	['contains', [[1, 2], 'x', true], fails('item.toLowerCase is not a function', 'TypeError')],
	['contains', [[{ a: 1 }], 'a'], false],
	['contains', [[D(T)], D(T)], true],
	['contains', [[true], true], true],
	['contains', [[{ a: 1 }], { a: 1 }], false],
	['contains', [{ a: 1 }, 'a'], false],
	['contains', [null, 'a'], false],

	['join', [[1, 2, 3], '-'], '1-2-3'],
	['join', [[1, null, undefined, 3]], '1,,,3'],
	['join', [[{ a: 1 }, b('x'), D(T), [1, 2]], ';'], `{object};{buffer};${T};1;2`],
	['join', [[1, [2, 3]], ';', true], '[1;[2;3]]'],
	['join', [[1, 2], true], '1,2'],
	['join', [[1, 2], 0], '102'],
	['join', ['abc', ','], ''],
	['keys', [{ a: 1, b: 2 }], ['a', 'b']],
	['keys', [[5, 6]], ['0', '1']],
	['keys', [b('ab')], []],
	['keys', ['abc'], []],
	['toCollection', [[{ k: 'a', v: 1 }, { k: 'a', v: 2 }], 'k', 'v'], { a: 2 }],
	['toCollection', [[{ k: 'a' }], 'k', 'v'], { a: null }, { a: undefined }],
	['toCollection', [[{ k: '', v: 1 }], 'k', 'v'], {}],
	['toCollection', [[], 'k', 'v'], {}],
	['toCollection', [null, 'k', 'v'], {}],
	['toCollection', [{}, 'k', 'v'], fails("'{object}' is not a valid array.")],
	['toCollection', [[{}], {}, 'v'], fails("'{object}' is not a valid key name.")],
	['toCollection', [[{}], 'k', true], fails("'true' is not a valid value name.")],
	['toArray', [{ a: 1 }], [{ key: 'a', value: 1 }]],
	['toArray', [[5]], [{ key: 0, value: 5 }]],
	['toArray', [null], fails("'{empty}' is not a valid collection.")],
	['toArray', ['abc'], fails("'abc' is not a valid collection.")],
	['toArray', [0], fails("'0' is not a valid collection.")],
	['first', [[1, 2]], 1],
	['first', [[]], undefined],
	['first', ['abc'], fails("'abc' is not a valid array.")],
	['first', [{ a: 1 }], fails("'{object}' is not a valid array.")],
	['first', [undefined], null, undefined],
	['last', [[1, 2]], 2],
	['last', [null], null],
	['merge', [[1], null, [2, 3]], [1, 2, 3]],
	['merge', [[1], 'x'], [1]],
	['merge', [], null],
	['add', [[1, 2], 3, 4], [1, 2, 3, 4]],
	['add', ['abc', 1], fails("'abc' is not a valid array.")],
	['add', [undefined, 1], null, undefined],
	['remove', [[1, 2, '2', 3], 2], [1, 3]],
	['remove', [[null, 'null', 1], null], ['null', 1]],
	['remove', [[undefined, 1, { a: 1 }], 1, { a: 1 }], [undefined, { a: 1 }]],
	['remove', [['a', 'B'], 'b'], ['a', 'B']],
	['remove', [undefined, 1], null, undefined],
	['map', [[{ n: 'a', t: 'x' }, { n: 'b', t: 'y' }], 'n', 't', 'x, y'], ['a', 'b']],
	['map', [[{ n: 'a', t: 1 }], 'n', 't', 1], ['a']],
	['map', [[{ n: 'a' }], 'n', 'missing', 'x'], []],
	['map', [[{ n: 1 }, { m: 2 }], 'n'], [1, undefined]],
	['map', [[{ 'a.b': 1 }], 'a.b'], [1]],
	['map', [[{ n: 1 }], 'constructor'], [null], [undefined]],
	['map', [[{ n: { m: 1 } }], 'n.m'], [1]],
	['map', [[], 'n'], []],
	['map', ['abc', 'n'], fails("'abc' is not a valid array.")],
	['map', [[{}], {}], fails("'{object}' is not a valid key.")],
	['map', [[{ n: 1 }], 'n', {}, 'x'], fails("'{object}' is not a valid key for filtering.")],
	['map', [[{ n: 1 }], 'n', 't', {}], fails("'{object}' is not a valid list of key names for filtering.")],
	['map', [[null], 'n'], fails("Cannot read properties of null (reading 'n')", 'TypeError')],
	['map', [undefined, 'n'], null, undefined],
	['shuffle', [[1]], [1]],
	['shuffle', ['abc'], fails("'abc' is not a valid array.")],
	['shuffle', [null], null],
	['shuffle', [undefined], null, undefined],
	['sort', [[3, 1, 2], 'desc'], [3, 2, 1]],
	['sort', [['b', 'A', 'c'], 'asc ci'], ['A', 'b', 'c']],
	['sort', [['b', 'A', 'c'], 'desc ci'], ['c', 'b', 'A']],
	['sort', [['a', 'A'], 'desc ci'], ['a', 'A']],
	['sort', [[{ n: 2 }, { n: 1 }], 'n'], [{ n: 1 }, { n: 2 }]],
	['sort', [[{ a: { b: 1 } }, { a: { b: 2 } }], 'desc', 'a.b'], [{ a: { b: 2 } }, { a: { b: 1 } }]],
	['sort', [[null, 2, 1]], [null, 1, 2]],
	['sort', [[null, 2, 1], 'desc'], [2, 1, null]],
	['sort', [[3, '2', 1]], [1, '2', 3]],
	['sort', [[2, 1, 2]], [1, 2, 2]],
	['sort', ['abc'], fails("'abc' is not a valid array.")],
	['sort', [undefined], null, undefined],
	['reverse', [[1, 2, 3]], [3, 2, 1]],
	['reverse', [undefined], null, undefined],
	['slice', [[1, 2, 3], '1'], [2, 3]],
	['slice', [[1, 2, 3, 4], 1, 3], [2, 3]],
	['slice', [[1, 2, 3], 'x'], fails("'x' is not a valid start number.")],
	['slice', [[1, 2, 3], 0, 'y'], fails("'y' is not a valid end number.")],
	['slice', [[1, 2, 3]], fails("'{empty}' is not a valid start number.")],
	['slice', ['abc', 0], fails("'abc' is not a valid array.")],
	['slice', [undefined, 0], null, undefined],
	['flatten', [[[1, [2]], 3]], [1, [2], 3]],
	['flatten', [[[1, [2, [3]]]], '2'], [1, 2, [3]]],
	['flatten', [[[1]], 'x'], fails("'x' is not a valid number.")],
	['flatten', [undefined], null, undefined],
	['distinct', [[1, '1', 2, { a: 1 }, { a: 1 }]], [1, 2, { a: 1 }]],
	['distinct', [[{ id: 1, x: 1 }, { id: 1, x: 2 }], 'id'], [{ id: 1, x: 1 }]],
	['distinct', [[null, null, undefined, 0]], [null, 0]],
	['distinct', [[D(T), D(T)]], [D(T)]],
	['distinct', [[fn1, 1]], [1]],
	['distinct', [[[1], [1], [1, 2]]], [[1], [1, 2]]],
	['distinct', [[{ a: [1, 2] }, { a: [1, 2] }, { a: [1, 3] }]], [{ a: [1, 2] }, { a: [1, 3] }]],
	['distinct', [[{ a: 1 }, { a: 1, b: 2 }]], [{ a: 1 }, { a: 1, b: 2 }]],
	['distinct', [[{ a: 1 }, { a: '1' }]], [{ a: 1 }]],
	['distinct', [[{ a: null }, { a: undefined }]], [{ a: null }]],
	['distinct', [[{ a: 'x' }, { a: D(T) }, { a: D(T) }]], [{ a: 'x' }, { a: D(T) }]],
	['distinct', [[{ a: [1] }, { a: { 0: 1 } }]], [{ a: [1] }]],
	['distinct', [[{ a: { 0: 1 } }, { a: [1] }]], [{ a: { 0: 1 } }, { a: [1] }]],
	['distinct', [[{ a: 1 }, { a: {} }]], [{ a: 1 }, { a: {} }]],
	['distinct', [[{ a: fn1 }, { a: fn1 }]], [{ a: fn1 }, { a: fn1 }]],
	['distinct', ['abc'], fails("'abc' is not a valid array.")],
	['deduplicate', [[1, 2, 2, 3]], [1, 2, 3]],
	['deduplicate', [undefined], null, undefined],
	['arrayDiff', [[1, 2, 3], [2]], [1, 3]],
	['arrayDiff', [[null, 1, undefined], [null]], [1, undefined]],
	['arrayDiff', [[1, { a: 1 }], [1]], fails('Array contains collections or objects.')],
	['arrayDiff', [[1], [[2]]], fails('Array contains collections or objects.')],
	['arrayDiff', ['abc', [1]], fails("'abc' is not a valid array.")],
	['arrayDiff', [[1], 'x'], fails("'x' is not a valid array.")],
	['arrayDiff', [[1], undefined], null, undefined],
	['arrayDiff', [undefined, [1]], null, undefined],
	['arrayIntersect', [[null, 1, { a: 1 }, 'x'], [null, '1', [1]]], [null, 1]],
	['arrayIntersect', [[1, 2], []], []],
	['arrayIntersect', [[1], 'x'], fails("'x' is not a valid array.")],
	['arrayIntersect', ['x', [1]], fails("'x' is not a valid array.")],
	['arrayIntersect', [[1], null], null],
	['arrayIntersect', [undefined, [1]], null, undefined],
	['arrayIntersect', [[1], undefined], null, undefined],

	['toString', [U8], 'hi'],
	['toString', [U8, 'base64'], 'aGk='],
	['toString', [U8, 'hex'], '6869'],
	['toString', [new Uint8Array(b('xhiy')).subarray(1, 3)], 'hi'],
	['toString', [new Uint16Array([0x6968, 0x21])], 'h!'],
	['toString', [new Uint8Array(b('hi')).buffer], 'hi'],
	['toString', [shared(b('hi'))], 'hi'],
	['toString', [new DataView(new ArrayBuffer(2))], ''],
	['length', [U8], 2],
	['length', [new Uint16Array(3)], 3],
	['length', [new ArrayBuffer(2)], undefined],
	['base64', [U8], 'aGk='],
	['base64', [new Uint16Array([0x6968])], 'aA=='],
	['md5', [U8], hash('md5', 'hi')],
	['md5', [new DataView(new ArrayBuffer(2))], hash('md5', '')],
	['sha256', [U8], hash('sha256', 'hi')],
	['sha1', [U8, 'hex', U8, 'binary'], hmac('sha1', 'hi', 'hi')],
	['sha256', ['abc', 'hex', new Uint16Array([0x6968])], hmac('sha256', 'hi', 'abc')],
	['sha512', [new BigInt64Array([1n]), 'hex', 'k', 'binary'], fails("Key 'binary' is not a valid buffer.")],
	['join', [[U8, 1]], '{buffer},1'],
	['keys', [U8], []],
	['keys', [{ buffer: new ArrayBuffer(2) }], []],
	['keys', [{ buffer: b('x') }], []],
	['toBinary', [U8], U8],
	['replace', [U8, 'h', 'x'], 'xi'],
	['replaceEmojiCharacters', [viaSet(b('a😀')), 1], 'a1'],
	['ceil', [U8], fails("'{buffer}' is not a valid number.")],
	['first', [U8], fails("'{buffer}' is not a valid array.")],

	// Checked on the engine by a probe, outside the parity table.
	['get', [{ prototype: 1 }, 'prototype'], null, undefined],
	['get', [{ __super__: 1 }, '__super__'], null, undefined],
	['get', [{ 'a\nb': 1 }, '`a\nb`'], null, undefined],
	['get', [{ a: [5, 6] }, '`a`[2]'], 6],
	['get', [[1, 2, 3], '2x'], 2],
	['get', [{ '`[1]': 5, '`': [7] }, '`[1]'], 7],
	['get', [{ 'a1]': 3 }, 'a1]'], 3],
	['set', [{}, 'prototype', 1], fails('"Function \'set\' finished with error! Forbidden key used in path."')],
	['set', [{}, 'a.__super__', 1], fails('"Function \'set\' finished with error! Forbidden key used in path."')],
	['set', [{}, 'a[2][3]', 1], { a: [undefined, [undefined, undefined, 1]] }],
	['set', [{}, '1.0', 1], [[1]]],
	['stripHTML', ['<style x>a</style>b<script>c</script>d'], 'bd'],
	['stripHTML', ['<<a<b>c<>d</>e'], 'c<>de'],
	['stripHTML', ['a<br>b<br/>c<br \n/>d<BR>e<brx>f'], 'a\nb\nc\ndef'],
	['stripHTML', ['x<style>y'], 'xy'],
	['stripHTML', ['<style>y</style'], 'y</style'],
	['stripHTML', ['a<style b'], 'a<style b'],
	['map', [[{ a: 1, b: 'x' }, { a: 2, b: 'y' }, { a: 3, b: ' y' }], 'a', 'b', ' x , y '], []],
	['map', [[{ a: 1, b: '' }, { a: 2, b: 'z' }], 'a', 'b', 'x, ,z'], [1, 2]],
	['contains', [123, '2'], fails('array.indexOf is not a function', 'TypeError')],
	['contains', [[1, 'A'], 'a', true], fails('item.toLowerCase is not a function', 'TypeError')],
	['contains', [['A', 1], 'a', true], true],
	['escapeMarkdown', ['!#&()*+-/:<=>[\\]_`|~ab'], '&#33;&#35;&amp;&#40;&#41;&#42;&#43;&#45;&#47;&#58;&lt;&#61;&gt;&#91;&#92;&#93;&#95;&#96;&#124;&#126;ab'],
	['replace', ['aXbx', '/x/i', '-'], 'a-bx'],
	['replace', ['a/x/gi', '/x/gi', '-'], 'a-'],
	['replace', ['abc', '//', '-'], '-abc'],
	['sort', [[3, null, 1, 'b', 'A'], 'desc ci'], [null, 'b', 'A', 3, 1]],
	['sort', [[{ a: 2 }, { a: null }, { a: 1 }], 'desc', 'a'], [{ a: 1 }, { a: null }, { a: 2 }]],
	['toArray', [['x', 'y']], [{ key: 0, value: 'x' }, { key: 1, value: 'y' }]],
	['trunc', [1.5, NaN], 2],
	['trunc', [Infinity, 1], fails("Cannot read properties of undefined (reading 'length')", 'TypeError')],
	['trunc', [123.456, -1], 120],
	['trunc', [1.25, 5], 1.25],
];

function outcome(iml, fn, args) {
	try {
		return iml[fn](...args);
	} catch (err) {
		return { [ERR]: { name: err.name, message: err.message } };
	}
}

describe('one-line cases per function, with manifest 1 and manifest 2', () => {
	const m1 = shim.createImlShim();
	const m2 = shim.createImlShim({ manifest: 2 });
	const byFunction = new Map();
	for (const row of ROWS) byFunction.set(row[0], [...(byFunction.get(row[0]) || []), row]);
	for (const [fn, rows] of byFunction) {
		it(fn, () => {
			for (const row of rows) {
				const [, args, one] = row;
				const two = row.length > 3 ? row[3] : one;
				assert.deepEqual(outcome(m1, fn, args), one, `${fn} ${rows.indexOf(row)} manifest 1`);
				assert.deepEqual(outcome(m2, fn, args), two, `${fn} ${rows.indexOf(row)} manifest 2`);
			}
		});
	}
});
