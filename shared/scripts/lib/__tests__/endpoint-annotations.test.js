const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ANNOTATION_KEYS, parseAnnotations } = require('../endpoint-annotations');

describe('parseAnnotations', () => {
	it('accepts the full Arbitrary Call set', () => {
		const text = JSON.stringify({
			readOnlyHint: false,
			openWorldHint: false,
			idempotentHint: false,
			destructiveHint: false,
			arbitraryCallHint: true,
		});
		assert.deepEqual(parseAnnotations(text), {
			readOnlyHint: false,
			openWorldHint: false,
			idempotentHint: false,
			destructiveHint: false,
			arbitraryCallHint: true,
		});
	});

	it('accepts a partial set and an empty object', () => {
		assert.deepEqual(parseAnnotations('{ "readOnlyHint": true }'), { readOnlyHint: true });
		assert.deepEqual(parseAnnotations('{}'), {});
	});

	it('accepts every documented key', () => {
		const obj = Object.fromEntries(ANNOTATION_KEYS.map((k) => [k, true]));
		assert.deepEqual(parseAnnotations(JSON.stringify(obj)), obj);
	});

	it('rejects invalid JSON', () => {
		assert.throws(() => parseAnnotations('{ readOnlyHint: true }'), /not valid JSON/);
		assert.throws(() => parseAnnotations(''), /not valid JSON/);
	});

	it('rejects non-object JSON', () => {
		for (const text of ['null', '[]', '"x"', '1', 'true']) {
			assert.throws(() => parseAnnotations(text), /must be a JSON object/, text);
		}
	});

	it('rejects an unknown key and names the allowed ones', () => {
		assert.throws(() => parseAnnotations('{ "readonlyHint": true }'), (err) => {
			assert.match(err.message, /unknown annotation "readonlyHint"/);
			assert.match(err.message, /readOnlyHint/);
			return true;
		});
	});

	it('rejects non-boolean values', () => {
		assert.throws(() => parseAnnotations('{ "readOnlyHint": "true" }'), /"readOnlyHint" must be true or false/);
		assert.throws(() => parseAnnotations('{ "idempotentHint": null }'), /"idempotentHint" must be true or false/);
		assert.throws(() => parseAnnotations('{ "openWorldHint": 1 }'), /"openWorldHint" must be true or false/);
	});
});
