'use strict';

/**
 * Unit tests for hooks/make-app-auto-actions-check.js.
 *
 * Run:
 *   node --test hooks/__tests__/make-app-auto-actions-check.test.js
 *   node --test hooks/__tests__/                   # whole dir
 *
 * Uses Node's built-in `node:test` runner — no external deps. Requires
 * Node 18+ (matches the rest of the skill toolchain).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectDevNotesDecline, detectDevNotesPrompted, stripHookOutput } = require('../make-app-auto-actions-check.js');

const msg = (role, content) => ({ role, message: { role, content } });

// ──────────────────────────────────────────────────────────────────────────────
// detectDevNotesDecline
// ──────────────────────────────────────────────────────────────────────────────

test('detectDevNotesDecline: explicit form mentioning notes (no preceding prompt required)', () => {
	assert.equal(
		detectDevNotesDecline([msg('user', '노트 적지마')]),
		true,
		'Korean explicit "노트 적지마" should count as decline',
	);
	assert.equal(
		detectDevNotesDecline([msg('user', "don't write developer notes")]),
		true,
		'English explicit "don\'t write developer notes" should count as decline',
	);
	assert.equal(
		detectDevNotesDecline([msg('user', '노트 안 씀')]),
		true,
		'Korean "노트 안 씀" should count as decline',
	);
});

test('detectDevNotesDecline: standalone negation only counts when preceded by dev-notes prompt', () => {
	const promptText = 'Shall I write Developer Notes to the Jira ticket?';
	const koPromptText = 'Developer Notes를 작성할까요?';

	const standalones = ['ㄴㄴ', 'ㄴㄴㄴ', '아니', '아니야', '싫', '싫어', '필요없음', 'no', 'nope', 'nah', 'skip', 'pass', 'no thanks'];
	for (const reply of standalones) {
		assert.equal(
			detectDevNotesDecline([msg('assistant', promptText), msg('user', reply)]),
			true,
			`"${reply}" after EN prompt should count as decline`,
		);
	}

	assert.equal(
		detectDevNotesDecline([msg('assistant', koPromptText), msg('user', 'ㄴㄴ 작성하지마셈')]),
		true,
		'"ㄴㄴ 작성하지마셈" after KO prompt should count as decline',
	);
});

test('detectDevNotesDecline: standalone negation alone (no prompt) is NOT a decline', () => {
	assert.equal(detectDevNotesDecline([msg('user', 'ㄴㄴ')]), false);
	assert.equal(detectDevNotesDecline([msg('user', 'no')]), false);
	assert.equal(detectDevNotesDecline([msg('user', '아니')]), false);
});

test('detectDevNotesDecline: random user reply after prompt is NOT a decline', () => {
	const prompt = msg('assistant', 'Shall I write Developer Notes?');
	assert.equal(detectDevNotesDecline([prompt, msg('user', '알겠음')]), false);
	assert.equal(detectDevNotesDecline([prompt, msg('user', '커밋해주세요')]), false);
	assert.equal(detectDevNotesDecline([prompt, msg('user', 'tell me more')]), false);
});

test('detectDevNotesDecline: words containing "no" do NOT false-positive (e.g. "node", "now", "noon")', () => {
	const prompt = msg('assistant', 'Shall I write Developer Notes?');
	assert.equal(detectDevNotesDecline([prompt, msg('user', 'node check')]), false);
	assert.equal(detectDevNotesDecline([prompt, msg('user', 'now what?')]), false);
	assert.equal(detectDevNotesDecline([prompt, msg('user', 'noon meeting')]), false);
});

test('detectDevNotesDecline: handles array-form content blocks', () => {
	const prompt = { role: 'assistant', message: { role: 'assistant', content: [{ text: 'Shall I write Developer Notes?' }] } };
	const reply = { role: 'user', message: { role: 'user', content: [{ text: 'ㄴㄴ' }] } };
	assert.equal(detectDevNotesDecline([prompt, reply]), true);
});

test('detectDevNotesDecline: KO prompt variants trigger context for standalone negation', () => {
	const variants = [
		'개발자 노트 작성할까요?',
		'Developer Notes 적을까요?',
		'Developer Notes를 남길까요?',
	];
	for (const p of variants) {
		assert.equal(
			detectDevNotesDecline([msg('assistant', p), msg('user', 'ㄴㄴ')]),
			true,
			`Standalone "ㄴㄴ" after KO prompt variant "${p}" should count as decline`,
		);
	}
});

// ──────────────────────────────────────────────────────────────────────────────
// detectDevNotesPrompted (covers what registers as a "prompt" upstream)
// ──────────────────────────────────────────────────────────────────────────────

test('detectDevNotesPrompted: matches EN and KO phrasings in agent text', () => {
	assert.equal(detectDevNotesPrompted('Shall I write Developer Notes to the ticket?', []), true);
	assert.equal(detectDevNotesPrompted('Developer Notes 작성할까요?', []), true);
	assert.equal(detectDevNotesPrompted('개발자 노트 남길까요?', []), true);
	assert.equal(detectDevNotesPrompted('Hello world', []), false);
});

test('detectDevNotesPrompted: matches AskQuestion tool calls referencing customfield_10483', () => {
	const tools = [{ name: 'AskQuestion', input: { questions: [{ prompt: 'customfield_10483 to write?' }] } }];
	assert.equal(detectDevNotesPrompted('', tools), true);
});

// ──────────────────────────────────────────────────────────────────────────────
// stripHookOutput (smoke check — must not throw on plain text)
// ──────────────────────────────────────────────────────────────────────────────

test('stripHookOutput: identity for plain user text', () => {
	assert.equal(stripHookOutput('hello world'), 'hello world');
});
