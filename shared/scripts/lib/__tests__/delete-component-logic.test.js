const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { statusDecision } = require('../delete-component-logic');

describe('statusDecision', () => {
	const ctx = { slug: 'my-app', version: '1' };
	const STOP = [
		'ERROR: Make did not say whether app my-app v1 is public (the status call failed or had no public field), so nothing was deleted.',
		'Run download-app.js and read metadata.json (public, approved). A public app allows deleting only RPCs and functions. Then run this again.',
	];

	it('public mode stops when the call failed or the answer has no boolean public', () => {
		for (const answer of [null, undefined, 'text', 7, {}, [], { app: {} }, { app: null }, { app: { public: 'false' } }, { approved: true }]) {
			assert.deepEqual(statusDecision({ mode: 'public', answer, ...ctx }), { stop: STOP }, JSON.stringify(answer));
		}
	});

	it('names the app and the version in the stop lines', () => {
		assert.equal(statusDecision({ mode: 'public', answer: null, slug: 'other', version: '12' }).stop[0], 'ERROR: Make did not say whether app other v12 is public (the status call failed or had no public field), so nothing was deleted.');
	});

	it('reads public and approved in both modes', () => {
		assert.deepEqual(statusDecision({ mode: 'public', answer: { app: { public: false, approved: false } }, ...ctx }), { isPublic: false, isApproved: false, label: 'private' });
		assert.deepEqual(statusDecision({ mode: 'public', answer: { public: true }, ...ctx }), { isPublic: true, isApproved: false, label: 'public' });
		assert.deepEqual(statusDecision({ mode: 'employee', answer: { app: { public: true, approved: true } }, ...ctx }), { isPublic: true, isApproved: true, label: 'approved (public)' });
	});

	it('employee mode keeps going on a failed call, as today', () => {
		assert.deepEqual(statusDecision({ mode: 'employee', answer: null, ...ctx }), { isPublic: false, isApproved: false, label: 'private' });
		assert.deepEqual(statusDecision({ mode: 'employee', answer: { app: {} }, ...ctx }), { isPublic: false, isApproved: false, label: 'private' });
	});
});
