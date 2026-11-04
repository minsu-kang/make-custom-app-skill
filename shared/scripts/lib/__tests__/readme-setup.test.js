const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ZONES, TOKEN_SCOPES, RUN_COMPONENT_SCOPES, formatScopes } = require('../mode-logic');

const README = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'README.md'), 'utf8');
const code = (text) => `\`${text}\``;

describe('README setup part follows mode-logic (spec 11.7)', () => {
	it('names the token scopes of TOKEN_SCOPES', () => {
		assert.ok(README.includes(`Scopes: ${code(formatScopes(TOKEN_SCOPES))}.`));
	});

	it('names the run-component scopes of RUN_COMPONENT_SCOPES', () => {
		const { everyRun, endpoints, connection, optional } = RUN_COMPONENT_SCOPES;
		const sentence = `${code(formatScopes(everyRun))} for every run, ${code(formatScopes(endpoints))} for Endpoints and for listing your teams, ${code(formatScopes(connection))} when the component uses a connection, and optionally ${optional.map(code).join(' and ')}.`;
		assert.ok(README.includes(sentence));
	});

	it('lists the six zones of ZONES', () => {
		assert.ok(README.includes(`(${ZONES.map(code).join(', ')})`));
	});
});
