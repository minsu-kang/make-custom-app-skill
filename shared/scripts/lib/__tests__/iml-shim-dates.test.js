const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const dates = require('../iml-shim-dates');
const codec = require('./iml-shim-codec');
const parity = require('./iml-shim-parity.json');
const { CASES, GAP_ROWS } = require('./iml-shim-cases');

const FROZEN = Date.parse(codec.FROZEN_NOW_ISO);
const W = (year, month, day, hour, minute) => ({ year, month, day, hour, minute, second: 0, millisecond: 0 });
const iso = (ms) => new Date(ms).toISOString();
const make = (r) => dates.createDateFunctions({ zone: r.timezone, manifest: r.manifest, now: () => FROZEN, gap: (fn, detail) => { throw Object.assign(new Error(`gap ${fn} ${detail}`), { isGap: true, fn }); } });

describe('zone math', () => {
	it('moves a local time in a spring gap forward by the gap, and takes the earlier offset in an autumn overlap', () => {
		const rows = [
			['Europe/Prague', W(2026, 3, 29, 2, 30), '2026-03-29T01:30:00.000Z'],
			['Europe/Prague', W(2026, 10, 25, 2, 30), '2026-10-25T00:30:00.000Z'],
			['America/New_York', W(2026, 3, 8, 2, 30), '2026-03-08T07:30:00.000Z'],
			['America/New_York', W(2026, 11, 1, 1, 30), '2026-11-01T05:30:00.000Z'],
			['Australia/Sydney', W(2026, 10, 4, 2, 30), '2026-10-03T16:30:00.000Z'],
			['Australia/Sydney', W(2026, 4, 5, 2, 30), '2026-04-04T15:30:00.000Z'],
			['UTC', W(2026, 3, 29, 2, 30), '2026-03-29T02:30:00.000Z'],
		];
		for (const [zone, wall, expected] of rows) assert.equal(iso(dates.instantOf(wall, zone)), expected, `${zone} ${JSON.stringify(wall)}`);
	});

	it('gives the wall clock and offset of an instant, also for a year past 9999', () => {
		assert.deepEqual(dates.wallClock(Date.parse('2026-03-29T00:30:00Z'), 'Europe/Prague'), { year: 2026, month: 3, day: 29, hour: 1, minute: 30, second: 0, millisecond: 0, weekday: 0, offsetMinutes: 60 });
		assert.equal(dates.wallClock(Date.UTC(48962, 6, 12, 19, 40), 'UTC').year, 48962);
	});

	it('knows real zones in any letter case and refuses others', () => {
		assert.equal(dates.isKnownZone('europe/prague'), true);
		assert.equal(dates.isKnownZone('Mars/Base'), false);
		assert.equal(dates.isKnownZone(''), false);
	});

	it('refuses offset zones, which Intl takes and the engine does not, and non-text zones', () => {
		assert.equal(dates.isKnownZone('+02:00'), false);
		assert.equal(dates.isKnownZone('-0500'), false);
		assert.equal(dates.isKnownZone(5), false);
		assert.equal(dates.isKnownZone('UTC'), true);
	});

	it('gives a year before the common era as a negative number, and the wall time after a spring change', () => {
		assert.equal(dates.wallClock(Date.parse('-000005-06-15T12:00:00Z'), 'UTC').year, -5);
		assert.equal(dates.wallClock(Date.parse('-000005-06-15T12:00:00Z'), 'UTC').weekday, new Date('-000005-06-15T12:00:00Z').getUTCDay());
		assert.equal(iso(dates.instantOf(W(2026, 3, 29, 3, 30), 'Europe/Prague')), '2026-03-29T01:30:00.000Z');
		assert.equal(dates.wallClock(-1, 'UTC').millisecond, 999);
	});
});

describe('tokenize', () => {
	it('takes the longest token, keeps [literal] text and passes other characters through', () => {
		assert.deepEqual(dates.tokenize('YYYY-MM-DD[T]HH'), [{ token: 'YYYY' }, { text: '-' }, { token: 'MM' }, { text: '-' }, { token: 'DD' }, { text: 'T' }, { token: 'HH' }]);
		assert.deepEqual(dates.tokenize('Do [of] MMMM'), [{ token: 'Do' }, { text: ' ' }, { text: 'of' }, { text: ' ' }, { token: 'MMMM' }]);
		assert.deepEqual(dates.tokenize('LLLL'), [{ token: 'LLLL' }]);
		assert.deepEqual(dates.tokenize('[bcn'), [{ text: '[' }, { text: 'b' }, { text: 'c' }, { text: 'n' }]);
	});

	it('reads a backslash as an escape of the next token or character, and a [ inside brackets as plain text', () => {
		assert.deepEqual(dates.tokenize('\\YYYY\\q\\\\\\'), [{ text: 'YYYY' }, { text: 'q' }, { text: '' }, { text: '' }]);
		assert.deepEqual(dates.tokenize('[a[b]'), [{ text: '[' }, { token: 'a' }, { text: 'b' }]);
		assert.deepEqual(dates.tokenize('[]'), [{ text: '' }]);
		assert.deepEqual(dates.tokenize('Hmmss yo'), [{ token: 'Hmmss' }, { text: ' ' }, { token: 'yo' }]);
	});

	it('ends [literal] text at the last ] before the next [', () => {
		assert.deepEqual(dates.tokenize('[at]ddd]'), [{ text: 'at]ddd' }]);
		assert.deepEqual(dates.tokenize('[[x]]'), [{ text: '[' }, { text: 'x]' }]);
	});

	it('lists the tokens longest first, with the ten localized formats and the two zone name tokens', () => {
		const lengths = dates.FORMAT_TOKENS.map((t) => t.length);
		assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a));
		for (const t of ['zz', 'z', 'SSSSSSSSS', 'X', 'x', ...Object.keys(dates.LOCALIZED_FORMATS)]) assert.ok(dates.FORMAT_TOKENS.includes(t), t);
		assert.deepEqual(Object.keys(dates.LOCALIZED_FORMATS).sort(), ['L', 'LL', 'LLL', 'LLLL', 'LT', 'LTS', 'l', 'll', 'lll', 'llll']);
	});
});

describe('the date functions', () => {
	const utc1 = make({ timezone: 'UTC', manifest: 1 });
	const utc2 = make({ timezone: 'UTC', manifest: 2 });

	it('keeps the empty rule of the manifest', () => {
		assert.equal(utc1.formatDate(undefined, 'YYYY'), null);
		assert.equal(utc2.formatDate(undefined, 'YYYY'), undefined);
		assert.equal(utc2.parseDate(null), null);
	});

	it('throws the engine validation messages', () => {
		assert.throws(() => utc1.formatDate('', 'YYYY'), { message: "'' is not a valid date." });
		assert.throws(() => utc1.formatDate({}, 'YYYY'), { message: "'{object}' is not a valid date." });
		assert.throws(() => utc1.parseDate('garbage', 'YYYY-MM-DD'), { message: "'garbage' is not a valid date or does not match the date format." });
	});

	it('marks the z tokens and unread digit forms as gaps', () => {
		assert.throws(() => utc1.formatDate(new Date(0), 'zz'), { isGap: true, fn: 'formatDate' });
		assert.throws(() => utc1.parseDate('2016-W52-3'), { isGap: true, fn: 'parseDate' });
		assert.equal(utc1.parseDate('today'), null);
	});

	it('keeps the wall time across DST with addDays, and adds absolute time with addHours', () => {
		const prague = make({ timezone: 'Europe/Prague', manifest: 1 });
		assert.equal(iso(prague.addDays(new Date('2026-03-28T12:00:00Z'), 1)), '2026-03-29T11:00:00.000Z');
		assert.equal(iso(prague.addHours(new Date('2026-03-28T12:00:00Z'), 24)), '2026-03-29T12:00:00.000Z');
	});

	it('answers every recorded row of the 15 date functions', () => {
		const mismatches = codec.parityMismatches({ parity, cases: CASES, fns: dates.DATE_FUNCTIONS, makeIml: make, isGapError: (e) => e.isGap === true, gapAllowed: (fn) => dates.DATE_FUNCTIONS.includes(fn), gapRows: GAP_ROWS });
		assert.deepEqual(mismatches, []);
	});
});

const D1 = new Date('2026-03-29T00:30:00.000Z');
const FEB_2026 = new Date('2026-02-03T04:05:06.789Z');
const D7 = new Date('2026-07-15T10:00:00.000Z');
const utc = make({ timezone: 'UTC', manifest: 1 });
const prague = make({ timezone: 'Europe/Prague', manifest: 1 });
const ny = make({ timezone: 'America/New_York', manifest: 1 });
const gapOf = (fn, detail) => ({ isGap: true, fn, message: `gap ${fn} ${detail}` });

describe('formatDate', () => {
	it('uses YYYY-MM-DDTHH:mm:ss.SSSZ with +00:00 when the format is missing, null, empty or another false value', () => {
		for (const format of [undefined, null, '', 0, false]) assert.equal(utc.formatDate(D1, format), '2026-03-29T00:30:00.000+00:00');
		assert.equal(utc.formatDate(D1, ' YYYY '), '2026');
	});

	it('throws the date format message for a format that is not text', () => {
		assert.throws(() => utc.formatDate(D1, 12), { message: "'12' is not a valid date format." });
		assert.throws(() => utc.formatDate(D1, '12'), { message: "'12' is not a valid date format." });
		assert.throws(() => utc.formatDate(D1, {}), { message: "'{object}' is not a valid date format." });
		assert.throws(() => utc.formatDate(D1, new Date(0)), { message: "'1970-01-01T00:00:00.000Z' is not a valid date format." });
		assert.throws(() => utc.formatDate(D1, Buffer.from('a')), { message: "'{buffer}' is not a valid date format." });
		assert.throws(() => utc.formatDate(D1, new Date(NaN)), { name: 'RangeError', message: 'Invalid time value' });
	});

	it('lets a per-call zone win over the receiver zone, and gives UTC for an unknown per-call zone without a callback', () => {
		const calls = [];
		const spied = dates.createDateFunctions({ zone: 'Europe/Prague', manifest: 1, now: () => FROZEN, gap: (fn, detail) => calls.push([fn, detail]) });
		assert.equal(spied.formatDate(D1, 'HH:mm', 'America/New_York'), '20:30');
		assert.equal(spied.formatDate(D1, 'HH:mm', 'Mars/Base'), '00:30');
		assert.equal(spied.formatDate(D1, 'HH:mm', '+02:00'), '00:30');
		assert.equal(spied.formatDate(D1, 'HH:mm', 0), '01:30');
		assert.equal(spied.formatDate(D1, 'HH:mm', NaN), '01:30');
		assert.equal(utc.formatDate(D1, 'HH:mm', 'europe/prague'), '01:30');
		assert.equal(utc.formatDate(D1, 'HH:mm', ' 5 '), '00:30');
		assert.deepEqual(calls, []);
	});

	it('throws the time zone message for a zone that is not text or is a number in text', () => {
		assert.throws(() => utc.formatDate(D1, 'HH', true), { message: "'true' is not a valid time zone." });
		assert.throws(() => utc.formatDate(D1, 'HH', 5), { message: "'5' is not a valid time zone." });
		assert.throws(() => utc.formatDate(D1, 'HH', '-3'), { message: "'-3' is not a valid time zone." });
		assert.throws(() => utc.formatDate(D1, 'HH', []), { message: "'{array}' is not a valid time zone." });
		assert.throws(() => utc.formatDate(D1, 'HH', new Date(0)), { message: "'1970-01-01T00:00:00.000Z' is not a valid time zone." });
	});

	it('reads a number or a number in text as epoch milliseconds', () => {
		assert.equal(utc.formatDate(1774744200000, 'X'), '1774744200');
		assert.equal(utc.formatDate('1774744200000', 'X'), '1774744200');
		assert.equal(utc.formatDate('-1.5', 'x'), '-1');
		assert.equal(utc.formatDate(' 123 ', 'x'), '123');
		assert.equal(utc.formatDate('2016-12-28', 'YYYY-MM-DD HH:mm', 'Asia/Tokyo'), '2016-12-28 09:00');
		assert.equal(prague.formatDate('2016-12-28', 'YYYY-MM-DD HH:mm', 'Asia/Tokyo'), '2016-12-28 08:00');
	});

	it('throws the date message for values that are not a date, and the gap for text it cannot read', () => {
		assert.throws(() => utc.formatDate(false, 'YYYY'), { message: "'false' is not a valid date." });
		assert.throws(() => utc.formatDate(NaN, 'YYYY'), { message: "'NaN' is not a valid date." });
		assert.throws(() => utc.formatDate([1], 'YYYY'), { message: "'{array}' is not a valid date." });
		assert.throws(() => utc.formatDate(Buffer.from('a'), 'YYYY'), { message: "'{buffer}' is not a valid date." });
		assert.throws(() => utc.formatDate(8.64e15 + 1, 'x'), { message: "'8640000000000001' is not a valid date." });
		assert.throws(() => utc.formatDate('9'.repeat(30), 'x'), { message: `'${'9'.repeat(30)}' is not a valid date.` });
		assert.throws(() => utc.formatDate('x'.repeat(101), 'YYYY'), { message: 'Invalid date.' });
		assert.throws(() => utc.formatDate('1'.repeat(150), 'YYYY'), { message: `'${'1'.repeat(150)}' is not a valid date.` });
		assert.throws(() => utc.formatDate(new Uint8Array(2), 'YYYY'), { message: "'{buffer}' is not a valid date." });
		assert.throws(() => utc.addDays(new DataView(new ArrayBuffer(2)), 1), { message: "'{buffer}' is not a valid date." });
		assert.throws(() => utc.parseDate('x', new Uint8Array(1)), { message: "'{buffer}' is not a valid date format." });
		assert.throws(() => utc.formatDate(10n, 'YYYY'), { message: 'Invalid date.' });
		assert.throws(() => utc.formatDate(new Date(NaN), 'YYYY'), { name: 'RangeError', message: 'Invalid time value' });
		assert.throws(() => utc.formatDate('Dec 28, 2016', 'YYYY'), gapOf('formatDate', 'with the date text "Dec 28, 2016"'));
	});

	it('writes unbracketed letters that are tokens as tokens, and the extra tokens of the engine', () => {
		assert.equal(utc.formatDate(D1, 'Today is'), 'To0am2026 i0');
		assert.equal(ny.formatDate(D1, 'Today is'), 'To6pm2026 i0');
		assert.equal(utc.formatDate(FEB_2026, 'e N NN NNN NNNN NNNNN y yy yyy yyyy yo YYYYY YYYYYY ggggg GGGGG Hmm Hmmss hmm hmmss'), '2 AD AD AD Anno Domini AD 2026 2026 2026 2026 2026th 02026 +002026 02026 02026 405 40506 405 40506');
		assert.equal(ny.formatDate(FEB_2026, 'hmm hmmss'), '1105 110506');
		assert.equal(utc.formatDate(FEB_2026, '\\YYYY [YYYY] \\\\ \\q \\'), 'YYYY YYYY  q ');
		assert.equal(utc.formatDate(D1, '[z] YYYY'), 'z 2026');
	});

	it('writes years before the common era and past 9999', () => {
		assert.equal(utc.formatDate(new Date('-000005-06-15T12:00:00Z'), 'YYYY Y YY N NNNN y yo gggg GGGG'), '-0005 -0005 -05 BC Before Christ 6 6th -0005 -0005');
		assert.equal(utc.formatDate(new Date('+048962-07-12T19:40:00Z'), 'YYYY Y YY'), '48962 +48962 62');
	});

	it('writes English ordinals, fractions and negative timestamps', () => {
		const day = (d, f) => utc.formatDate(new Date(`2026-${d}T12:00:00Z`), f);
		assert.deepEqual(['01-11', '01-12', '01-13', '01-21', '01-22', '01-23'].map((d) => day(d, 'Do')), ['11th', '12th', '13th', '21st', '22nd', '23rd']);
		assert.deepEqual(['04-12', '04-21', '04-22'].map((d) => day(d, 'DDDo')), ['102nd', '111th', '112th']);
		assert.equal(utc.formatDate(new Date(-1500), 'X x'), '-2 -1500');
		assert.equal(utc.formatDate(new Date('2026-01-01T00:00:00.009Z'), 'S SS SSS SSSS'), '0 00 009 0090');
	});

	it('expands localized tokens as text first, so the expansion joins the letters next to it', () => {
		const leap = new Date('2024-02-29T10:00:00Z');
		assert.equal(utc.formatDate(leap, 'LTSMoMMMlll'), '10:00:00 AM2ndFebruary02 29, 2024 10:00 AM');
		assert.equal(prague.formatDate(new Date('2026-11-01T06:30:00Z'), 'dllllyy'), 'Sunday, Nov 1, 2026 7:30 AM2026');
		assert.equal(prague.formatDate(new Date('2060-10-12T10:31:51.206Z'), 'llllLY[/D'), 'Tue, Oct 12, 2060 12:31 PM10/12/02060[/12');
		assert.equal(utc.formatDate(D1, '\\LT [LT] \\\\L'), 'LT LT L');
		assert.equal(utc.formatDate(new Date(1614897445310), '[[at]xs]'), '[at]xs');
		assert.equal(utc.formatDate(new Date(1614897445310), 'DDD[at]-Q]'), '63at]-Q');
	});

	it('writes the short default without milliseconds for a format of spaces, with Z at a zero offset of a known zone', () => {
		assert.equal(utc.formatDate(D1, ' '), '2026-03-29T00:30:00Z');
		assert.equal(prague.formatDate(D1, ' '), '2026-03-29T01:30:00+01:00');
		assert.equal(utc.formatDate(D1, ' ', 'Mars/Base'), '2026-03-29T00:30:00+00:00');
		assert.equal(prague.formatDate(D1, ' ', 'Europe/London'), '2026-03-29T00:30:00Z');
	});

	it('marks the token z as a gap with its detail', () => {
		assert.throws(() => utc.formatDate(D1, 'YYYY z'), gapOf('formatDate', 'with the token "z"'));
		assert.throws(() => utc.formatDate(D1, 'zz'), gapOf('formatDate', 'with the token "zz"'));
	});
});

describe('parseDate without a format', () => {
	it('reads a number or a number in text as Unix seconds, and padded digits as milliseconds', () => {
		assert.equal(iso(utc.parseDate(1482940986)), '2016-12-28T16:03:06.000Z');
		assert.equal(iso(utc.parseDate('-5')), '1969-12-31T23:59:55.000Z');
		assert.equal(iso(utc.parseDate('1.5')), '1970-01-01T00:00:01.500Z');
		assert.equal(iso(utc.parseDate(1.5)), '1970-01-01T00:00:01.500Z');
		assert.equal(iso(utc.parseDate(' 123 ')), '1970-01-01T00:00:00.123Z');
		assert.ok(Number.isNaN(utc.parseDate(NaN).getTime()));
	});

	it('reads text without an offset as local time in the zone, and ignores a per-call zone', () => {
		assert.equal(iso(prague.parseDate('2016-12-28 16:03')), '2016-12-28T15:03:00.000Z');
		assert.equal(iso(prague.parseDate('2016-12-28', undefined, 'Asia/Tokyo')), '2016-12-27T23:00:00.000Z');
		assert.equal(iso(prague.parseDate('2016-12-28', null, 'Asia/Tokyo')), '2016-12-27T23:00:00.000Z');
	});

	it('reads the accepted text forms with their times and offsets', () => {
		const rows = [
			['2016-12-28t16:03:06z', '2016-12-28T16:03:06.000Z'],
			['2016-12-28T16:03:06.123456789+02:00', '2016-12-28T14:03:06.123Z'],
			['2016-1-2', '2016-01-01T23:00:00.000Z'],
			['2016-12/28', '2016-12-27T23:00:00.000Z'],
			['2016-12-2816:03', '2016-12-28T15:03:00.000Z'],
			['28.12.2016 4:03 pm', '2016-12-28T15:03:00.000Z'],
			['28-12-2016', '2016-12-27T23:00:00.000Z'],
			['28. 12. 2016', '2016-12-27T23:00:00.000Z'],
			['12/28/2016 4 PM', '2016-12-28T15:00:00.000Z'],
			['12/28/2016 16:03 +02:00', '2016-12-28T14:03:00.000Z'],
			['2016/12/28T16:03', '2016-12-28T15:03:00.000Z'],
			['2016/12/28 4:03 pm', '2016-12-28T15:03:00.000Z'],
			['2016-12-28T24:00', '2016-12-28T23:00:00.000Z'],
			['2016-12-28T24:00:00.000', '2016-12-28T23:00:00.000Z'],
			['2016-12-28 12:03 am', '2016-12-27T23:03:00.000Z'],
			['2016-12-28 0:03 am', '2016-12-27T23:03:00.000Z'],
			['2016-12-28 0:03 pm', '2016-12-28T11:03:00.000Z'],
			['2016-12-28 12:03 pm', '2016-12-28T11:03:00.000Z'],
			[' 2016-12-28 ', '2016-12-27T23:00:00.000Z'],
			['2016-12-28T16:03-0500', '2016-12-28T21:03:00.000Z'],
			['28.12.2016Z', '2016-12-28T00:00:00.000Z'],
			['2016-12-28 16:03 utc', '2016-12-28T16:03:00.000Z'],
			['2016-12-28 16:03 GMT', '2016-12-28T16:03:00.000Z'],
		];
		for (const [text, expected] of rows) assert.equal(iso(prague.parseDate(text)), expected, text);
	});

	it('marks text with digits that it does not read as a gap, and cuts the text after 40 characters', () => {
		for (const text of ['2016-02-30', '2016-13-01', '2016-00-01', '2016-12-28T25:00', '2016-12-28T16:60', '2016-12-28T16:03:60', '2016-12-28T24:00:01', '0999-12-28', '2016-12-28 13:03 pm', '2016-12-28 4:03:06 PM', '2016-12', '+5', '2016-12-28 16:03:06,5', '28.12.2016T16:03', '2016-12-28 16:03 later', '2016-12-28 10:00:', '2016-12-28 10:00:00.', '2016-12-28 10: pm']) {
			assert.throws(() => prague.parseDate(text), gapOf('parseDate', `without a format on "${text}"`), text);
		}
		const long = `2016 ${'x'.repeat(60)}`;
		assert.throws(() => utc.parseDate(long), gapOf('parseDate', `without a format on "${long.slice(0, 40)}"`));
	});

	it('blocks a line break inside the clock, where the engine reads no date, and reads one before the clock', () => {
		for (const text of ['2016-12-28 16:03\nZ', '2016-12-28 16:03\r+01:00', '2016-12-28 4\npm', '2016-12-28 16:03 \u2028 Z']) {
			assert.throws(() => utc.parseDate(text), gapOf('parseDate', `without a format on "${text}"`), JSON.stringify(text));
		}
		assert.equal(iso(utc.parseDate('2016-12-28\n16:03')), '2016-12-28T16:03:00.000Z');
		assert.equal(iso(utc.parseDate('\n28.12.2016 16:03 Z\n')), '2016-12-28T16:03:00.000Z');
	});

	it('gives null for text without a digit, passes a Date through and refuses other values', () => {
		assert.equal(utc.parseDate('   '), null);
		assert.equal(utc.parseDate(''), null);
		assert.equal(utc.parseDate(D1), D1);
		assert.ok(Number.isNaN(utc.parseDate(new Date(NaN)).getTime()));
		assert.equal(utc.parseDate(D1, 12), D1);
		assert.throws(() => utc.parseDate(false), { message: "'false' is not a valid date." });
		assert.throws(() => utc.parseDate(Buffer.from('a')), { message: "'{buffer}' is not a valid date." });
		assert.throws(() => utc.parseDate(true, 12), { message: "'true' is not a valid date." });
		assert.throws(() => utc.parseDate('x', 12), { message: "'12' is not a valid date format." });
		assert.throws(() => utc.parseDate(5, {}), { message: "'{object}' is not a valid date format." });
		assert.throws(() => utc.parseDate('2016', '12'), { message: "'12' is not a valid date format." });
	});
});

describe('parseDate with a format', () => {
	const at = (fns, text, format, zone) => iso(fns.parseDate(text, format, zone));
	const bad = (text) => ({ message: `'${text}' is not a valid date or does not match the date format.` });

	it('fills missing date parts from the UTC day of now(), then January and the first day', () => {
		assert.equal(at(utc, '10:00', 'HH:mm'), '2026-07-15T10:00:00.000Z');
		const early = (zone) => dates.createDateFunctions({ zone, manifest: 1, now: () => Date.parse('2026-07-15T02:00:00Z'), gap: () => { throw new Error('gap'); } });
		const late = (zone) => dates.createDateFunctions({ zone, manifest: 1, now: () => Date.parse('2026-07-15T20:00:00Z'), gap: () => { throw new Error('gap'); } });
		assert.equal(at(early('America/New_York'), '16:00', 'HH:mm'), '2026-07-15T20:00:00.000Z');
		assert.equal(at(late('Asia/Tokyo'), '16:00', 'HH:mm'), '2026-07-15T07:00:00.000Z');
		assert.equal(at(utc, '28', 'DD'), '2026-07-28T00:00:00.000Z');
		assert.equal(at(utc, '2016', 'YYYY'), '2016-01-01T00:00:00.000Z');
	});

	it('reads years with the two-digit rule, a sign and few digits', () => {
		assert.equal(at(utc, '69-12-28', 'YY-MM-DD'), '1969-12-28T00:00:00.000Z');
		assert.equal(at(utc, '68-12-28', 'YY-MM-DD'), '2068-12-28T00:00:00.000Z');
		assert.equal(at(utc, '05', 'YYYY'), '2005-01-01T00:00:00.000Z');
		assert.equal(at(utc, '5', 'YYYY'), '0005-01-01T00:00:00.000Z');
		assert.equal(at(prague, '5', 'YYYY'), '0004-12-31T23:02:16.000Z');
		assert.equal(at(utc, '-0005', 'Y'), '-000005-01-01T00:00:00.000Z');
		assert.equal(at(utc, 12345, 'YYYY'), '1234-01-01T00:00:00.000Z');
		assert.equal(at(utc, '12345 x', 'YYYYY'), '+012345-01-01T00:00:00.000Z');
		assert.equal(at(utc, '2016-1-2', 'YYYY-M-D'), '2016-01-02T00:00:00.000Z');
		assert.throws(() => utc.parseDate('999999', 'Y'), bad('999999'));
	});

	it('searches each part anywhere in the rest of the text and ignores what is left', () => {
		assert.equal(at(utc, 'xx2016yy12zz28', 'YYYY-MM-DD'), '2016-12-28T00:00:00.000Z');
		assert.equal(at(utc, '28 2016', 'MMM DD YYYY'), '2016-01-20T00:00:00.000Z');
		assert.equal(at(utc, '2016-12-28', '[YYYY]-MM-DD'), '2026-12-28T00:00:00.000Z');
		assert.equal(at(utc, '2016-12-28', '\\YYYY-MM-DD'), '2026-12-28T00:00:00.000Z');
		assert.equal(at(utc, '2016-12-28', '[]YYYY-MM-DD'), '2016-12-28T00:00:00.000Z');
	});

	it('reads month and weekday names by their first letters', () => {
		assert.equal(at(utc, 'Decxyz 28 2016', 'MMM DD YYYY'), '2016-12-28T00:00:00.000Z');
		assert.throws(() => utc.parseDate('Foo 28 2016', 'MMM DD YYYY'), bad('Foo 28 2016'));
		for (const [text, format] of [['2016-12-28 Wed', 'YYYY-MM-DD ddd'], ['2016-12-28 Wednesday', 'YYYY-MM-DD dddd'], ['2016-12-28 We', 'YYYY-MM-DD dd'], ['2016-12-28 3', 'YYYY-MM-DD d']]) {
			assert.equal(at(utc, text, format), '2016-12-28T00:00:00.000Z', format);
		}
		for (const [text, format] of [['2016-12-28 Thu', 'YYYY-MM-DD ddd'], ['2016-12-28 Xyz', 'YYYY-MM-DD ddd'], ['2016-12-28 4', 'YYYY-MM-DD d']]) {
			assert.throws(() => utc.parseDate(text, format), bad(text), format);
		}
	});

	it('searches a long run of digits for a name in linear time', () => {
		const text = `${'1'.repeat(100000)}-`;
		const started = process.hrtime.bigint();
		assert.throws(() => utc.parseDate(text, 'MMM'), { message: 'Invalid date.' });
		assert.throws(() => utc.parseDate(text, 'dddd'), { message: 'Invalid date.' });
		assert.equal(at(utc, text, 'MMMM YYYY'), '1111-01-01T00:00:00.000Z');
		assert.ok(process.hrtime.bigint() - started < 5000000000n, 'three searches took 5 s or more');
	});

	it('reads at most 256 letters of a name and searches the next part after them, as the engine does', () => {
		const x = (n) => 'x'.repeat(n);
		assert.equal(at(utc, `Feb${x(253)}Mar 2026`, 'MMMMMMMM YYYY'), '2026-03-01T00:00:00.000Z');
		assert.equal(at(utc, `Feb${x(300)} Mar 2026`, 'MMMM MMMM YYYY'), '2026-03-01T00:00:00.000Z');
		assert.throws(() => utc.parseDate(`Feb${x(300)}Mar`, 'MMMM MMMM'), { message: 'Invalid date.' });
		assert.throws(() => utc.parseDate(`Wed${x(300)}Thu 2026`, 'ddddddd YYYY'), { message: 'Invalid date.' });
	});

	it('reads week fields without a month or day as a day of that week, with the week of now() for missing fields', () => {
		const rows = [
			['2016-W52', 'GGGG-[W]WW', '2016-12-26'],
			['2015 53 7', 'GGGG W E', '2016-01-03'],
			['53 2015', 'W GGGG', '2015-12-28'],
			['99 1', 'GG W', '1999-01-04'],
			['5', 'E', '2026-01-02'],
			['52 2016', 'w gggg', '2016-12-18'],
			['53 2016', 'w gggg', '2016-12-25'],
			['16 1', 'gg w', '2015-12-27'],
			['2016 10', 'YYYY w', '2016-02-28'],
			['100 2016 1', 'DDD YYYY w', '2015-12-27'],
			['Wed', 'ddd', '2026-07-15'],
			['Sun', 'dddd', '2026-07-12'],
			['2016 Thu', 'YYYY ddd', '2016-07-14'],
			['3', 'e', '2026-07-15'],
			['0', 'd', '2026-07-12'],
		];
		for (const [text, format, day] of rows) assert.equal(at(utc, text, format), `${day}T00:00:00.000Z`, format);
		assert.equal(at(prague, '2016-W52', 'GGGG-[W]WW'), '2016-12-25T23:00:00.000Z');
		for (const [text, format] of [['54 2016', 'w gggg'], ['0', 'W'], ['8', 'E'], ['0', 'E'], ['7', 'd'], ['7', 'e']]) {
			assert.throws(() => utc.parseDate(text, format), bad(text), format);
		}
		assert.equal(at(utc, '2016-12-28 52', 'YYYY-MM-DD w'), '2016-12-28T00:00:00.000Z');
		assert.equal(at(utc, '2016-12-28 5', 'YYYY-MM-DD E'), '2016-12-28T00:00:00.000Z');
		assert.equal(at(utc, '2016-12-28 2016', 'YYYY-MM-DD gggg'), '2016-12-28T00:00:00.000Z');
	});

	it('reads era names at the start of the rest of the text and era years', () => {
		assert.equal(at(utc, '2016 AD', 'YYYY N'), '2016-01-01T00:00:00.000Z');
		assert.equal(at(utc, '2016 anno domini', 'YYYY NNNN'), '2016-01-01T00:00:00.000Z');
		assert.equal(at(utc, '44 BC', 'y N'), '-000043-01-01T00:00:00.000Z');
		assert.equal(at(utc, 'Before Christ 44', 'NNNN y'), '-000043-01-01T00:00:00.000Z');
		assert.equal(at(utc, 'BC', 'N'), '0000-01-01T00:00:00.000Z');
		assert.equal(at(utc, 'AD', 'NNNNN'), '0001-01-01T00:00:00.000Z');
		assert.equal(at(utc, '2016th', 'yo'), '2016-01-01T00:00:00.000Z');
		assert.equal(at(utc, 'x AD 2016', 'N YYYY'), '2016-01-01T00:00:00.000Z');
		assert.equal(at(utc, '1482940986 BC', 'X N'), '2016-12-28T16:03:06.000Z');
		assert.throws(() => utc.parseDate('AD pm', 'N a'), bad('AD pm'));
	});

	it('applies am and pm, and refuses a meridiem with nothing else', () => {
		assert.equal(at(utc, '2016-12-28 12:00 AM', 'YYYY-MM-DD hh:mm a'), '2016-12-28T00:00:00.000Z');
		assert.equal(at(utc, '2016-12-28 13:00 PM', 'YYYY-MM-DD hh:mm a'), '2016-12-28T13:00:00.000Z');
		assert.equal(at(utc, '2016-12-28 pm', 'YYYY-MM-DD a'), '2016-12-28T00:00:00.000Z');
		assert.throws(() => utc.parseDate('pm', 'a'), bad('pm'));
		assert.equal(at(utc, '930', 'Hmm'), '2026-07-15T09:30:00.000Z');
		assert.equal(at(utc, '93015', 'Hmmss'), '2026-07-15T09:30:15.000Z');
		assert.equal(at(ny, '930 pm', 'hmm a'), '2026-07-16T01:30:00.000Z');
		assert.equal(at(utc, '93015 pm', 'hmmss a'), '2026-07-15T21:30:15.000Z');
		assert.equal(at(utc, '2016-12-28 5', 'YYYY-MM-DD k'), '2016-12-28T05:00:00.000Z');
		assert.equal(at(utc, '2016-12-28 05', 'YYYY-MM-DD kk'), '2016-12-28T05:00:00.000Z');
		assert.equal(at(utc, '4:03 PM', 'LT'), '2026-07-15T16:03:00.000Z');
	});

	it('reads quarters, days of the year and fractions, and refuses values out of range', () => {
		assert.equal(at(prague, '3 2016', 'Q YYYY'), '2016-06-30T22:00:00.000Z');
		assert.equal(at(utc, '100 2016', 'DDD YYYY'), '2016-04-09T00:00:00.000Z');
		assert.equal(at(utc, '100', 'DDDD'), '2026-04-10T00:00:00.000Z');
		assert.equal(at(utc, '5', 'S'), '2026-07-15T00:00:00.500Z');
		assert.equal(at(utc, '12', 'SSS'), '2026-07-15T00:00:00.120Z');
		assert.equal(at(utc, '123456', 'SSSSSS'), '2026-07-15T00:00:00.123Z');
		for (const [text, format] of [['366 2015', 'DDD YYYY'], ['0 2016', 'DDD YYYY'], ['2016-12-28 24:30', 'YYYY-MM-DD HH:mm'], ['2016-12-28 25:00', 'YYYY-MM-DD HH:mm'], ['2016-12-28 16:60', 'YYYY-MM-DD HH:mm'], ['2016-12-28 16:03:60', 'YYYY-MM-DD HH:mm:ss'], ['2016-00-28', 'YYYY-MM-DD'], ['2016-12-00', 'YYYY-MM-DD']]) {
			assert.throws(() => utc.parseDate(text, format), bad(text), text);
		}
		assert.throws(() => utc.parseDate('x'.repeat(101), 'YYYY'), { message: 'Invalid date.' });
	});

	it('reads offsets and timestamps, and reads a timestamp in a longer format as wall time', () => {
		assert.equal(at(prague, '2016-12-28 +05', 'YYYY-MM-DD Z'), '2016-12-27T19:00:00.000Z');
		assert.equal(at(prague, '2016-12-28 -0530', 'YYYY-MM-DD ZZ'), '2016-12-28T05:30:00.000Z');
		assert.equal(at(prague, '2016-12-28 Z', 'YYYY-MM-DD Z'), '2016-12-28T00:00:00.000Z');
		assert.equal(at(prague, '-5', 'X'), '1969-12-31T23:59:55.000Z');
		assert.equal(at(prague, ' 1482940986', 'X'), '2016-12-28T16:03:06.000Z');
		assert.equal(at(prague, '1482940986 2016', 'X YYYY'), '2016-12-28T15:03:06.000Z');
		assert.equal(at(prague, '1482940986 +05:00', 'X Z'), '2016-12-28T16:03:06.000Z');
		assert.equal(at(prague, '1482940986579', 'x'), '2016-12-28T16:03:06.579Z');
		assert.equal(at(prague, ' 1482940986579', 'x'), '2016-12-28T16:03:06.579Z');
		assert.ok(Number.isNaN(utc.parseDate('99999999999999999', 'X').getTime()));
		assert.throws(() => utc.parseDate(' 99999999999999999', 'X'), bad(' 99999999999999999'));
		for (const [text, format] of [['1482940986 13', 'X MM'], ['1482940986 0', 'X DD'], ['1482940986 24', 'X H'], ['1482940986 24:00', 'X H:mm']]) {
			assert.throws(() => utc.parseDate(text, format), bad(text), format);
		}
	});

	it('reads literal parts the engine way: localized text joined, brackets unescaped, a plain g or G as signed digits', () => {
		assert.equal(at(utc, 'January/13/20213', 'MMLd'), '2021-01-13T00:00:00.000Z');
		assert.equal(at(prague, 'July/23/1987', 'MMMl'), '1987-07-22T22:00:00.000Z');
		assert.throws(() => utc.parseDate('at]dddJuly:', '[at]ddd]MMMM: '), bad('at]dddJuly:'));
		assert.throws(() => utc.parseDate('12undefined', '[]MM'), bad('12undefined'));
		assert.equal(at(utc, '5 24', 'gDD'), '2026-07-24T00:00:00.000Z');
		assert.equal(at(utc, '5 24', 'GDD'), '2026-07-24T00:00:00.000Z');
		assert.equal(at(utc, '5 24', '[g]DD'), '2026-07-05T00:00:00.000Z');
	});

	it('checks a weekday against the date after a 24:00 rollover', () => {
		assert.equal(at(utc, '2016-12-25 24:00 Mon', 'YYYY-MM-DD HH:mm ddd'), '2016-12-26T00:00:00.000Z');
		assert.throws(() => utc.parseDate('2016-12-25 24:00 Sun', 'YYYY-MM-DD HH:mm ddd'), bad('2016-12-25 24:00 Sun'));
	});

	it('takes the zone tokens and ordinal-only tokens as text to skip', () => {
		assert.equal(at(prague, '2016-12-28 16:03 z', 'YYYY-MM-DD HH:mm z'), '2016-12-28T15:03:00.000Z');
		assert.equal(at(prague, '2016-12-28 12th', 'YYYY-MM-DD Mo'), '2016-12-27T23:00:00.000Z');
		assert.equal(at(prague, 'Sunday, March 29, 2026 1:30 AM', 'LLLL'), '2026-03-29T00:30:00.000Z');
		assert.equal(at(prague, '2016-12-28T16:03:06.5Z', 'YYYY-MM-DDTHH:mm:ss.SZ'), '2016-12-28T16:03:06.500Z');
	});

	it('takes a per-call zone: a name, a number of hours, an unknown name as UTC, and refuses other values', () => {
		const text = '2016-12-28 16:03';
		const format = 'YYYY-MM-DD HH:mm';
		assert.equal(at(prague, text, format, 'America/New_York'), '2016-12-28T21:03:00.000Z');
		assert.equal(at(prague, text, format, 5), '2016-12-28T11:03:00.000Z');
		assert.equal(at(prague, text, format, '5'), '2016-12-28T11:03:00.000Z');
		assert.equal(at(prague, text, format, -3), '2016-12-28T19:03:00.000Z');
		assert.equal(at(prague, text, format, '0'), '2016-12-28T16:03:00.000Z');
		assert.equal(at(prague, text, format, 0), '2016-12-28T15:03:00.000Z');
		assert.equal(at(prague, text, format, 'Mars/Base'), '2016-12-28T16:03:00.000Z');
		assert.equal(at(prague, '2016-12-28 16:03 +05:00', 'YYYY-MM-DD HH:mm Z', 2), '2016-12-28T09:03:00.000Z');
		assert.equal(at(prague, '1482940986 2016', 'X YYYY', 2), '2016-12-28T14:03:06.000Z');
		assert.throws(() => prague.parseDate(text, format, true), { message: "'true' is not a valid time zone." });
		assert.throws(() => prague.parseDate(text, format, {}), { message: "'{object}' is not a valid time zone." });
	});

	it('reads an empty format as ISO 8601 text in the zone, with the per-call zone', () => {
		assert.equal(at(prague, '2016-12-28 16:03', ''), '2016-12-28T15:03:00.000Z');
		assert.equal(at(prague, '2016-12-28 16:03', '', 'Asia/Tokyo'), '2016-12-28T07:03:00.000Z');
		assert.equal(at(prague, '2016-12-28 16:03', '', 5), '2016-12-28T11:03:00.000Z');
		assert.equal(at(prague, '2016-12-28T16:03:06+02:00', ''), '2016-12-28T14:03:06.000Z');
		for (const text of ['2016-W52-3', '2016-363', '+002016-12-28', 20161228]) assert.equal(at(prague, text, ''), '2016-12-27T23:00:00.000Z', text);
		assert.equal(at(prague, '20161228T1000Z', ''), '2016-12-28T10:00:00.000Z');
		assert.equal(at(prague, '2016-12-28 10:00:00,5 Z', ''), '2016-12-28T10:00:00.500Z');
	});

	it('reads an empty format as RFC 2822 text, as /Date(ms)/, then as JavaScript reads the text in UTC', () => {
		const rows = [
			['Wed, 28 Dec 2016 10:00 GMT', '2016-12-28T10:00:00.000Z'],
			['Wed,  28 (note) Dec\t2016 10:00:30 Z', '2016-12-28T10:00:30.000Z'],
			['28 Dec 16 10:00 +0199', '2016-12-28T07:21:00.000Z'],
			['28 Dec 1999 10:00 -0130', '1999-12-28T11:30:00.000Z'],
			['28 Dec 2016 10:00 PST', '2016-12-28T18:00:00.000Z'],
			['28 Dec 49 10:00 UT', '2049-12-28T10:00:00.000Z'],
			['28 Dec 999 10:00 EDT', '2899-12-28T14:00:00.000Z'],
			['/Date(1482940986000)/', '2016-12-28T16:03:06.000Z'],
			['Date(-5)', '1969-12-31T23:59:59.995Z'],
			['Dec 28, 2016', '2016-12-28T00:00:00.000Z'],
			['2016/12/28', '2016-12-28T00:00:00.000Z'],
			['Dec 28 2016 10:00 +0200', '2016-12-28T10:00:00.000Z'],
		];
		for (const [text, expected] of rows) assert.equal(at(prague, text, ''), expected, text);
		assert.equal(at(prague, 'Dec 28, 2016', '', 'Asia/Tokyo'), '2016-12-28T00:00:00.000Z');
		assert.equal(at(prague, 'Dec 28, 2016', '', 5), '2016-12-27T19:00:00.000Z');
	});

	it('throws the engine message for empty-format text that no reading takes, with or without digits', () => {
		const texts = ['today', '', '   ', '28.12.2016', '1482940986', '2016-12T10:00', '2016-02-30', '2016-12-28t16:03', '2016-W52-8', '2016-W53-1T10:00', '/Date(99999999999999999)/', 'Mon, 28 Dec 2016 10:00 GMT', '31 Feb 2016 10:00 GMT', '0 Dec 2016 10:00 GMT', '28 Dec 2016 24:00 GMT', '28 Dec 2016 10:60 GMT', '28 Dec 2016 10:00:60 GMT'];
		for (const text of texts) assert.throws(() => prague.parseDate(text, ''), bad(text), text);
		assert.throws(() => prague.parseDate(1482940986, ''), bad('1482940986'));
	});

	it('reads empty-format text with an open ( in UTC whatever the zone of the computer, and puts the zone back', () => {
		const saved = process.env.TZ;
		try {
			for (const zone of ['Asia/Tokyo', undefined, 'UTC']) {
				if (zone === undefined) delete process.env.TZ;
				else process.env.TZ = zone;
				assert.equal(at(prague, 'Dec 28 2016 10:00 (x', ''), '2016-12-28T10:00:00.000Z', zone);
				assert.equal(at(prague, 'Wed Dec 28 2016 10:00:00 GMT+0100 (CET', ''), '2016-12-28T09:00:00.000Z', zone);
				assert.equal(process.env.TZ, zone);
			}
		} finally {
			if (saved === undefined) delete process.env.TZ;
			else process.env.TZ = saved;
		}
	});
});

describe('add and set', () => {
	it('clamps addMonths and addYears to the month end', () => {
		assert.equal(iso(utc.addMonths(new Date('2026-01-31T10:00:00Z'), 1)), '2026-02-28T10:00:00.000Z');
		assert.equal(iso(utc.addYears(new Date('2024-02-29T10:00:00Z'), 1)), '2025-02-28T10:00:00.000Z');
		assert.equal(iso(utc.addMonths(new Date('2026-03-31T10:00:00Z'), -13)), '2025-02-28T10:00:00.000Z');
	});

	it('rounds calendar amounts half away from zero and adds clock amounts exactly', () => {
		assert.equal(iso(utc.addDays(D7, 0.5)), '2026-07-16T10:00:00.000Z');
		assert.equal(iso(utc.addDays(D7, -0.5)), '2026-07-14T10:00:00.000Z');
		assert.equal(iso(utc.addDays(D7, 2.5)), '2026-07-18T10:00:00.000Z');
		assert.equal(iso(utc.addMonths(D7, 1.5)), '2026-09-15T10:00:00.000Z');
		assert.equal(iso(prague.addYears(D7, 1.5)), '2028-01-15T11:00:00.000Z');
		assert.equal(iso(utc.addHours(D7, 1.5)), '2026-07-15T11:30:00.000Z');
		assert.equal(iso(utc.addSeconds(D7, 1.0005)), '2026-07-15T10:00:01.000Z');
		assert.equal(iso(utc.addMinutes(D7, -31)), '2026-07-15T09:29:00.000Z');
	});

	it('reads amounts as JavaScript numbers', () => {
		assert.equal(iso(utc.addHours(D7, true)), '2026-07-15T11:00:00.000Z');
		assert.equal(iso(utc.addHours(D7, '')), '2026-07-15T10:00:00.000Z');
		assert.equal(iso(utc.addHours(D7, ' 2 ')), '2026-07-15T12:00:00.000Z');
		assert.equal(iso(utc.addHours(D7, '1e2')), '2026-07-19T14:00:00.000Z');
		assert.equal(iso(utc.addHours(D7, [2])), '2026-07-15T12:00:00.000Z');
		assert.equal(iso(utc.addSeconds(D7, 10n)), '2026-07-15T10:00:10.000Z');
		assert.equal(iso(utc.addDays(D7, null)), '2026-07-15T10:00:00.000Z');
		assert.equal(iso(utc.setHour(D7, '0x10')), '2026-07-15T16:00:00.000Z');
		assert.equal(iso(utc.setHour(D7, 5.7)), '2026-07-15T05:00:00.000Z');
		assert.equal(iso(utc.setHour(D7, -5.7)), '2026-07-14T19:00:00.000Z');
	});

	it('throws the number message of each unit for an amount that is not a number', () => {
		const rows = [['addSeconds', 'seconds'], ['addMinutes', 'minutes'], ['addHours', 'hours'], ['addDays', 'days'], ['addMonths', 'months'], ['addYears', 'years'], ['setSecond', 'seconds'], ['setMinute', 'minutes'], ['setHour', 'hours'], ['setDay', 'days'], ['setDate', 'days'], ['setMonth', 'months'], ['setYear', 'years']];
		for (const [fn, unit] of rows) assert.throws(() => utc[fn](D7, 'abc'), { message: `'abc' is not a valid number of ${unit}.` }, fn);
		assert.throws(() => utc.setHour(D7), { message: "'{empty}' is not a valid number of hours." });
		assert.throws(() => utc.setHour(D7, {}), { message: "'{object}' is not a valid number of hours." });
		assert.throws(() => utc.setHour(D7, ['a']), { message: "'{array}' is not a valid number of hours." });
		assert.throws(() => utc.addHours(D7, NaN), { message: "'NaN' is not a valid number of hours." });
		assert.throws(() => utc.addHours(D7, Infinity), { message: "'Infinity' is not a valid number of hours." });
		assert.throws(() => utc.addSeconds(D7, 1e21), { message: "'1e+21' is not a valid number of seconds." });
		assert.throws(() => utc.addSeconds(D7, 1e-7), { message: "'1e-7' is not a valid number of seconds." });
		assert.throws(() => utc.addSeconds(D7, 'x'.repeat(101)), { message: 'Invalid number of seconds.' });
		assert.throws(() => utc.addSeconds(D7, () => 1), { message: 'Invalid number of seconds.' });
	});

	it('checks the date before the amount, and keeps the empty rule first', () => {
		assert.throws(() => utc.addDays('garbage', 'abc'), { message: "'garbage' is not a valid date." });
		assert.equal(utc.addDays(null, 'abc'), null);
		assert.equal(make({ timezone: 'UTC', manifest: 2 }).setHour(undefined, 'abc'), undefined);
		assert.throws(() => utc.setHour(new Date(NaN), 1), { name: 'RangeError', message: 'Invalid time value' });
		assert.equal(iso(prague.addDays('2016-12-28', 1)), '2016-12-28T23:00:00.000Z');
	});

	it('takes English day names, three-letter forms and 1 to 7 with Sunday as 1 in setDay', () => {
		const jun = new Date('2018-06-27T11:36:39.138Z');
		assert.equal(iso(utc.setDay(jun, 'monday')), '2018-06-25T11:36:39.138Z');
		assert.equal(iso(utc.setDay(jun, 'tue')), '2018-06-26T11:36:39.138Z');
		assert.equal(iso(utc.setDay(jun, 1)), '2018-06-24T11:36:39.138Z');
		assert.equal(iso(utc.setDay(jun, 7)), '2018-06-30T11:36:39.138Z');
		assert.equal(iso(utc.setDay(D7, 'MONDAY')), '2026-07-13T10:00:00.000Z');
		assert.equal(iso(utc.setDay(D7, 'Sun')), '2026-07-12T10:00:00.000Z');
		assert.equal(iso(utc.setDay(D7, 2.6)), '2026-07-14T10:00:00.000Z');
		assert.equal(iso(utc.setDay(D7, -0.5)), '2026-07-10T10:00:00.000Z');
		assert.equal(iso(utc.setDay(D7, '')), '2026-07-11T10:00:00.000Z');
		assert.throws(() => utc.setDay(D7, 'mo'), { message: "'mo' is not a valid number of days." });
	});

	it('takes 1 to 12 and English month names in setMonth', () => {
		const aug = new Date('2015-08-07T11:36:39.138Z');
		assert.equal(iso(utc.setMonth(aug, 'january')), '2015-01-07T11:36:39.138Z');
		assert.equal(iso(utc.setMonth(aug, 12)), '2015-12-07T11:36:39.138Z');
		assert.equal(iso(utc.setMonth(D7, 'May')), '2026-05-15T10:00:00.000Z');
		assert.equal(iso(utc.setMonth(D7, 0.5)), '2026-01-15T10:00:00.000Z');
		assert.equal(iso(utc.setMonth(D7, -0.5)), '2025-12-15T10:00:00.000Z');
		assert.equal(iso(utc.setMonth(new Date('2026-01-31T10:00:00Z'), 2.5)), '2026-03-01T10:00:00.000Z');
		assert.equal(iso(prague.setMonth(new Date('2026-12-31T23:30:00Z'), 2.5)), '2027-01-31T23:30:00.000Z');
		assert.throws(() => utc.setMonth(D7, 'sept'), { message: "'sept' is not a valid number of months." });
	});

	it('reports date text with digits that it cannot read as a gap of the function called', () => {
		for (const fn of dates.DATE_FUNCTIONS.filter((name) => /^(add|set)/.test(name))) assert.throws(() => utc[fn]('Dec 28, 2016', 1), gapOf(fn, 'with the date text "Dec 28, 2016"'), fn);
	});

	it('throws the date message for a garbage string in every set function', () => {
		for (const fn of ['setSecond', 'setMinute', 'setHour', 'setDay', 'setDate', 'setMonth', 'setYear']) assert.throws(() => utc[fn]('garbage', 1), { message: "'garbage' is not a valid date." }, fn);
	});

	it('sets the year with the leap day rule and rolls other fields over', () => {
		assert.equal(iso(utc.setYear(new Date('2024-02-29T10:00:00Z'), 2028)), '2028-02-29T10:00:00.000Z');
		assert.equal(iso(utc.setYear(D7, null)), '0000-07-15T10:00:00.000Z');
		assert.equal(iso(utc.setYear(D7, 2017.9)), '2017-07-15T10:00:00.000Z');
		assert.equal(iso(utc.setDate(D7, 32)), '2026-08-01T10:00:00.000Z');
	});

	it('sets a year out of 1 to 9999 as the engine does, up to the ends of the Date range', () => {
		const aug = new Date('2015-08-07T11:36:39.138Z');
		const leap = new Date('2024-02-29T10:00:00.000Z');
		const rows = [
			[utc, aug, 10000, '+010000-08-07T11:36:39.138Z'],
			[utc, aug, 0, '0000-08-07T11:36:39.138Z'],
			[utc, aug, -1, '-000001-08-07T11:36:39.138Z'],
			[utc, aug, 275760, '+275760-08-07T11:36:39.138Z'],
			[utc, aug, -271821, '-271821-08-07T11:36:39.138Z'],
			[utc, leap, 10000, '+010000-02-29T10:00:00.000Z'],
			[utc, leap, 2100, '2100-02-28T10:00:00.000Z'],
			[utc, leap, -4, '-000004-02-29T10:00:00.000Z'],
			[prague, aug, -1, '-000001-08-07T12:38:55.138Z'],
			[ny, aug, -1, '-000001-08-07T12:32:41.138Z'],
		];
		for (const [fns, date, year, expected] of rows) assert.equal(iso(fns.setYear(date, year)), expected, String(year));
		for (const year of [275761, -271822]) assert.ok(Number.isNaN(utc.setYear(aug, year).getTime()), String(year));
	});

	it('gives an invalid Date when the result is outside the Date range', () => {
		for (const [fn, n] of [['setYear', 999999], ['addYears', 300000], ['addDays', 1e8], ['addHours', 1e12], ['setHour', 1e12], ['setMinute', 1e14]]) {
			assert.ok(Number.isNaN(prague[fn](D7, n).getTime()), fn);
		}
		assert.ok(Number.isNaN(dates.instantOf(W(999999, 1, 1, 0, 0), 'Europe/Prague')));
	});

	it('resolves set and calendar results in the zone the way the engine does across DST', () => {
		assert.equal(iso(prague.setMinute(new Date('2026-03-29T00:59:00Z'), 61)), '2026-03-29T01:01:00.000Z');
		assert.equal(iso(prague.setSecond(new Date('2026-03-29T00:59:59Z'), 61)), '2026-03-29T01:00:01.000Z');
		assert.equal(iso(ny.setHour(new Date('2026-11-01T08:00:00Z'), 1)), '2026-11-01T06:00:00.000Z');
		assert.equal(iso(prague.setHour(new Date('2026-11-01T08:00:00Z'), 1)), '2026-11-01T00:00:00.000Z');
		assert.equal(iso(prague.setDate(new Date('2026-10-24T06:30:00Z'), 25)), '2026-10-25T07:30:00.000Z');
		assert.equal(iso(ny.setDate(new Date('2026-10-24T06:30:00Z'), 25)), '2026-10-25T06:30:00.000Z');
	});

	it('follows the engine across both DST changes of four zones in add*, set* and parseDate', () => {
		const zones = { 'Europe/Prague': prague, 'America/New_York': ny, 'Australia/Sydney': make({ timezone: 'Australia/Sydney', manifest: 1 }), UTC: utc };
		// [zone, function, the date (text for parseDate), amount or format, the engine's answer]
		const rows = [
			['Europe/Prague', 'addDays', '2026-03-28T01:30:00.000Z', 1, '2026-03-29T00:30:00.000Z'],
			['Europe/Prague', 'addDays', '2026-03-30T00:30:00.000Z', -1, '2026-03-29T01:30:00.000Z'],
			['Europe/Prague', 'addMonths', '2026-04-29T00:30:00.000Z', -1, '2026-03-29T01:30:00.000Z'],
			['Europe/Prague', 'addYears', '2025-03-29T01:30:00.000Z', 1, '2026-03-29T00:30:00.000Z'],
			['Europe/Prague', 'addHours', '2026-03-29T00:30:00.000Z', 1, '2026-03-29T01:30:00.000Z'],
			['Europe/Prague', 'setHour', '2026-03-28T23:30:00.000Z', 2, '2026-03-29T00:30:00.000Z'],
			['Europe/Prague', 'setHour', '2026-03-29T10:30:00.000Z', 2, '2026-03-29T01:30:00.000Z'],
			['Europe/Prague', 'setDate', '2026-03-30T00:30:00.000Z', 29, '2026-03-29T01:30:00.000Z'],
			['Europe/Prague', 'setMonth', '2026-04-29T00:30:00.000Z', 3, '2026-03-29T01:30:00.000Z'],
			['Europe/Prague', 'setYear', '2025-03-29T01:30:00.000Z', 2026, '2026-03-29T00:30:00.000Z'],
			['Europe/Prague', 'setDay', '2026-03-30T00:30:00.000Z', 'Sunday', '2026-03-29T01:30:00.000Z'],
			['Europe/Prague', 'setMinute', '2026-03-29T00:59:00.000Z', 90, '2026-03-29T01:30:00.000Z'],
			['Europe/Prague', 'setSecond', '2026-03-29T00:59:00.000Z', 3600, '2026-03-29T01:59:00.000Z'],
			['Europe/Prague', 'parseDate', '2026-03-29 02:30', 'YYYY-MM-DD HH:mm', '2026-03-29T01:30:00.000Z'],
			['Europe/Prague', 'parseDate', '2026-03-29 02:30', null, '2026-03-29T01:30:00.000Z'],
			['Europe/Prague', 'addDays', '2026-10-24T00:30:00.000Z', 1, '2026-10-25T00:30:00.000Z'],
			['Europe/Prague', 'addDays', '2026-10-26T01:30:00.000Z', -1, '2026-10-25T01:30:00.000Z'],
			['Europe/Prague', 'addMonths', '2026-11-25T01:30:00.000Z', -1, '2026-10-25T01:30:00.000Z'],
			['Europe/Prague', 'addYears', '2025-10-25T00:30:00.000Z', 1, '2026-10-25T00:30:00.000Z'],
			['Europe/Prague', 'addHours', '2026-10-24T23:30:00.000Z', 1, '2026-10-25T00:30:00.000Z'],
			['Europe/Prague', 'setHour', '2026-10-24T22:30:00.000Z', 2, '2026-10-25T00:30:00.000Z'],
			['Europe/Prague', 'setHour', '2026-10-25T11:30:00.000Z', 2, '2026-10-25T01:30:00.000Z'],
			['Europe/Prague', 'setDate', '2026-10-26T01:30:00.000Z', 25, '2026-10-25T01:30:00.000Z'],
			['Europe/Prague', 'setMonth', '2026-11-25T01:30:00.000Z', 10, '2026-10-25T01:30:00.000Z'],
			['Europe/Prague', 'setYear', '2025-10-25T00:30:00.000Z', 2026, '2026-10-25T00:30:00.000Z'],
			['Europe/Prague', 'setDay', '2026-10-26T01:30:00.000Z', 'Sunday', '2026-10-25T01:30:00.000Z'],
			['Europe/Prague', 'setMinute', '2026-10-24T23:59:00.000Z', 90, '2026-10-25T00:30:00.000Z'],
			['Europe/Prague', 'setSecond', '2026-10-24T23:59:00.000Z', 3600, '2026-10-25T00:59:00.000Z'],
			['Europe/Prague', 'parseDate', '2026-10-25 02:30', 'YYYY-MM-DD HH:mm', '2026-10-25T00:30:00.000Z'],
			['Europe/Prague', 'parseDate', '2026-10-25 02:30', null, '2026-10-25T00:30:00.000Z'],
			['America/New_York', 'addDays', '2026-03-07T07:30:00.000Z', 1, '2026-03-08T06:30:00.000Z'],
			['America/New_York', 'addDays', '2026-03-09T06:30:00.000Z', -1, '2026-03-08T07:30:00.000Z'],
			['America/New_York', 'addMonths', '2026-04-08T06:30:00.000Z', -1, '2026-03-08T07:30:00.000Z'],
			['America/New_York', 'addYears', '2025-03-08T07:30:00.000Z', 1, '2026-03-08T06:30:00.000Z'],
			['America/New_York', 'addHours', '2026-03-08T06:30:00.000Z', 1, '2026-03-08T07:30:00.000Z'],
			['America/New_York', 'setHour', '2026-03-08T05:30:00.000Z', 2, '2026-03-08T06:30:00.000Z'],
			['America/New_York', 'setHour', '2026-03-08T16:30:00.000Z', 2, '2026-03-08T07:30:00.000Z'],
			['America/New_York', 'setDate', '2026-03-09T06:30:00.000Z', 8, '2026-03-08T07:30:00.000Z'],
			['America/New_York', 'setMonth', '2026-04-08T06:30:00.000Z', 3, '2026-03-08T07:30:00.000Z'],
			['America/New_York', 'setYear', '2025-03-08T07:30:00.000Z', 2026, '2026-03-08T06:30:00.000Z'],
			['America/New_York', 'setDay', '2026-03-09T06:30:00.000Z', 'Sunday', '2026-03-08T07:30:00.000Z'],
			['America/New_York', 'setMinute', '2026-03-08T06:59:00.000Z', 90, '2026-03-08T07:30:00.000Z'],
			['America/New_York', 'setSecond', '2026-03-08T06:59:00.000Z', 3600, '2026-03-08T07:59:00.000Z'],
			['America/New_York', 'parseDate', '2026-03-08 02:30', 'YYYY-MM-DD HH:mm', '2026-03-08T07:30:00.000Z'],
			['America/New_York', 'parseDate', '2026-03-08 02:30', null, '2026-03-08T07:30:00.000Z'],
			['America/New_York', 'addDays', '2026-10-31T05:30:00.000Z', 1, '2026-11-01T05:30:00.000Z'],
			['America/New_York', 'addDays', '2026-11-02T06:30:00.000Z', -1, '2026-11-01T06:30:00.000Z'],
			['America/New_York', 'addMonths', '2026-12-01T06:30:00.000Z', -1, '2026-11-01T06:30:00.000Z'],
			['America/New_York', 'addYears', '2025-11-01T05:30:00.000Z', 1, '2026-11-01T05:30:00.000Z'],
			['America/New_York', 'addHours', '2026-11-01T04:30:00.000Z', 1, '2026-11-01T05:30:00.000Z'],
			['America/New_York', 'setHour', '2026-11-01T04:30:00.000Z', 1, '2026-11-01T05:30:00.000Z'],
			['America/New_York', 'setHour', '2026-11-01T17:30:00.000Z', 1, '2026-11-01T06:30:00.000Z'],
			['America/New_York', 'setDate', '2026-11-02T06:30:00.000Z', 1, '2026-11-01T06:30:00.000Z'],
			['America/New_York', 'setMonth', '2026-12-01T06:30:00.000Z', 11, '2026-11-01T06:30:00.000Z'],
			['America/New_York', 'setYear', '2025-11-01T05:30:00.000Z', 2026, '2026-11-01T05:30:00.000Z'],
			['America/New_York', 'setDay', '2026-11-02T06:30:00.000Z', 'Sunday', '2026-11-01T06:30:00.000Z'],
			['America/New_York', 'setMinute', '2026-11-01T04:59:00.000Z', 90, '2026-11-01T05:30:00.000Z'],
			['America/New_York', 'setSecond', '2026-11-01T04:59:00.000Z', 3600, '2026-11-01T05:59:00.000Z'],
			['America/New_York', 'parseDate', '2026-11-01 01:30', 'YYYY-MM-DD HH:mm', '2026-11-01T05:30:00.000Z'],
			['America/New_York', 'parseDate', '2026-11-01 01:30', null, '2026-11-01T05:30:00.000Z'],
			['Australia/Sydney', 'addDays', '2026-10-02T16:30:00.000Z', 1, '2026-10-03T15:30:00.000Z'],
			['Australia/Sydney', 'addDays', '2026-10-04T15:30:00.000Z', -1, '2026-10-03T16:30:00.000Z'],
			['Australia/Sydney', 'addMonths', '2026-11-03T15:30:00.000Z', -1, '2026-10-03T16:30:00.000Z'],
			['Australia/Sydney', 'addYears', '2025-10-03T16:30:00.000Z', 1, '2026-10-03T15:30:00.000Z'],
			['Australia/Sydney', 'addHours', '2026-10-03T15:30:00.000Z', 1, '2026-10-03T16:30:00.000Z'],
			['Australia/Sydney', 'setHour', '2026-10-03T14:30:00.000Z', 2, '2026-10-03T15:30:00.000Z'],
			['Australia/Sydney', 'setHour', '2026-10-04T01:30:00.000Z', 2, '2026-10-03T16:30:00.000Z'],
			['Australia/Sydney', 'setDate', '2026-10-04T15:30:00.000Z', 4, '2026-10-03T16:30:00.000Z'],
			['Australia/Sydney', 'setMonth', '2026-11-03T15:30:00.000Z', 10, '2026-10-03T16:30:00.000Z'],
			['Australia/Sydney', 'setYear', '2025-10-03T16:30:00.000Z', 2026, '2026-10-03T15:30:00.000Z'],
			['Australia/Sydney', 'setDay', '2026-10-04T15:30:00.000Z', 'Sunday', '2026-10-03T16:30:00.000Z'],
			['Australia/Sydney', 'setMinute', '2026-10-03T15:59:00.000Z', 90, '2026-10-03T16:30:00.000Z'],
			['Australia/Sydney', 'setSecond', '2026-10-03T15:59:00.000Z', 3600, '2026-10-03T16:59:00.000Z'],
			['Australia/Sydney', 'parseDate', '2026-10-04 02:30', 'YYYY-MM-DD HH:mm', '2026-10-03T16:30:00.000Z'],
			['Australia/Sydney', 'parseDate', '2026-10-04 02:30', null, '2026-10-03T16:30:00.000Z'],
			['Australia/Sydney', 'addDays', '2026-04-03T15:30:00.000Z', 1, '2026-04-04T15:30:00.000Z'],
			['Australia/Sydney', 'addDays', '2026-04-05T16:30:00.000Z', -1, '2026-04-04T16:30:00.000Z'],
			['Australia/Sydney', 'addMonths', '2026-05-04T16:30:00.000Z', -1, '2026-04-04T16:30:00.000Z'],
			['Australia/Sydney', 'addYears', '2025-04-04T15:30:00.000Z', 1, '2026-04-04T15:30:00.000Z'],
			['Australia/Sydney', 'addHours', '2026-04-04T14:30:00.000Z', 1, '2026-04-04T15:30:00.000Z'],
			['Australia/Sydney', 'setHour', '2026-04-04T13:30:00.000Z', 2, '2026-04-04T15:30:00.000Z'],
			['Australia/Sydney', 'setHour', '2026-04-05T02:30:00.000Z', 2, '2026-04-04T16:30:00.000Z'],
			['Australia/Sydney', 'setDate', '2026-04-05T16:30:00.000Z', 5, '2026-04-04T16:30:00.000Z'],
			['Australia/Sydney', 'setMonth', '2026-05-04T16:30:00.000Z', 4, '2026-04-04T16:30:00.000Z'],
			['Australia/Sydney', 'setYear', '2025-04-04T15:30:00.000Z', 2026, '2026-04-04T15:30:00.000Z'],
			['Australia/Sydney', 'setDay', '2026-04-05T16:30:00.000Z', 'Sunday', '2026-04-04T16:30:00.000Z'],
			['Australia/Sydney', 'setMinute', '2026-04-04T14:59:00.000Z', 90, '2026-04-04T15:30:00.000Z'],
			['Australia/Sydney', 'setSecond', '2026-04-04T14:59:00.000Z', 3600, '2026-04-04T15:59:00.000Z'],
			['Australia/Sydney', 'parseDate', '2026-04-05 02:30', 'YYYY-MM-DD HH:mm', '2026-04-04T15:30:00.000Z'],
			['Australia/Sydney', 'parseDate', '2026-04-05 02:30', null, '2026-04-04T15:30:00.000Z'],
			['UTC', 'addDays', '2026-03-28T02:30:00.000Z', 1, '2026-03-29T02:30:00.000Z'],
			['UTC', 'addDays', '2026-03-30T02:30:00.000Z', -1, '2026-03-29T02:30:00.000Z'],
			['UTC', 'addMonths', '2026-04-29T02:30:00.000Z', -1, '2026-03-29T02:30:00.000Z'],
			['UTC', 'addYears', '2025-03-29T02:30:00.000Z', 1, '2026-03-29T02:30:00.000Z'],
			['UTC', 'addHours', '2026-03-29T01:30:00.000Z', 1, '2026-03-29T02:30:00.000Z'],
			['UTC', 'setHour', '2026-03-29T00:30:00.000Z', 2, '2026-03-29T02:30:00.000Z'],
			['UTC', 'setHour', '2026-03-29T12:30:00.000Z', 2, '2026-03-29T02:30:00.000Z'],
			['UTC', 'setDate', '2026-03-30T02:30:00.000Z', 29, '2026-03-29T02:30:00.000Z'],
			['UTC', 'setMonth', '2026-04-29T02:30:00.000Z', 3, '2026-03-29T02:30:00.000Z'],
			['UTC', 'setYear', '2025-03-29T02:30:00.000Z', 2026, '2026-03-29T02:30:00.000Z'],
			['UTC', 'setDay', '2026-03-30T02:30:00.000Z', 'Sunday', '2026-03-29T02:30:00.000Z'],
			['UTC', 'setMinute', '2026-03-29T01:59:00.000Z', 90, '2026-03-29T02:30:00.000Z'],
			['UTC', 'setSecond', '2026-03-29T01:59:00.000Z', 3600, '2026-03-29T02:59:00.000Z'],
			['UTC', 'parseDate', '2026-03-29 02:30', 'YYYY-MM-DD HH:mm', '2026-03-29T02:30:00.000Z'],
			['UTC', 'parseDate', '2026-03-29 02:30', null, '2026-03-29T02:30:00.000Z'],
			['UTC', 'addDays', '2026-10-24T02:30:00.000Z', 1, '2026-10-25T02:30:00.000Z'],
			['UTC', 'addDays', '2026-10-26T02:30:00.000Z', -1, '2026-10-25T02:30:00.000Z'],
			['UTC', 'addMonths', '2026-11-25T02:30:00.000Z', -1, '2026-10-25T02:30:00.000Z'],
			['UTC', 'addYears', '2025-10-25T02:30:00.000Z', 1, '2026-10-25T02:30:00.000Z'],
			['UTC', 'addHours', '2026-10-25T01:30:00.000Z', 1, '2026-10-25T02:30:00.000Z'],
			['UTC', 'setHour', '2026-10-25T00:30:00.000Z', 2, '2026-10-25T02:30:00.000Z'],
			['UTC', 'setHour', '2026-10-25T12:30:00.000Z', 2, '2026-10-25T02:30:00.000Z'],
			['UTC', 'setDate', '2026-10-26T02:30:00.000Z', 25, '2026-10-25T02:30:00.000Z'],
			['UTC', 'setMonth', '2026-11-25T02:30:00.000Z', 10, '2026-10-25T02:30:00.000Z'],
			['UTC', 'setYear', '2025-10-25T02:30:00.000Z', 2026, '2026-10-25T02:30:00.000Z'],
			['UTC', 'setDay', '2026-10-26T02:30:00.000Z', 'Sunday', '2026-10-25T02:30:00.000Z'],
			['UTC', 'setMinute', '2026-10-25T01:59:00.000Z', 90, '2026-10-25T02:30:00.000Z'],
			['UTC', 'setSecond', '2026-10-25T01:59:00.000Z', 3600, '2026-10-25T02:59:00.000Z'],
			['UTC', 'parseDate', '2026-10-25 02:30', 'YYYY-MM-DD HH:mm', '2026-10-25T02:30:00.000Z'],
			['UTC', 'parseDate', '2026-10-25 02:30', null, '2026-10-25T02:30:00.000Z'],
		];
		for (const [zone, fn, input, arg, expected] of rows) {
			const value = fn === 'parseDate' ? input : new Date(input);
			assert.equal(iso(zones[zone][fn](value, arg)), expected, `${zone} ${fn}(${input}, ${arg})`);
		}
	});
});
