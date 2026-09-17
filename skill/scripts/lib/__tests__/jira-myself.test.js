const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fetchJiraEmail } = require('../jira-myself');

describe('fetchJiraEmail', () => {
	it('returns emailAddress from GET /rest/api/3/myself', async () => {
		const calls = [];
		const fetchFn = async (url, opts) => {
			calls.push({ url, opts });
			return {
				ok: true,
				status: 200,
				json: async () => ({ emailAddress: 'mia@example.com', displayName: 'Mia' }),
			};
		};
		const email = await fetchJiraEmail({
			baseUrl: 'https://make.atlassian.net',
			email: 'typed@example.com',
			token: 'secret-token',
			fetchFn,
		});
		assert.equal(email, 'mia@example.com');
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, 'https://make.atlassian.net/rest/api/3/myself');
		assert.equal(calls[0].opts.headers.Accept, 'application/json');
		assert.equal(calls[0].opts.headers.Authorization, `Basic ${Buffer.from('typed@example.com:secret-token').toString('base64')}`);
	});

	it('throws when Jira returns a non-OK status', async () => {
		await assert.rejects(
			() =>
				fetchJiraEmail({
					baseUrl: 'https://make.atlassian.net/',
					email: 'a@b.com',
					token: 'bad',
					fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }),
				}),
			/401/,
		);
	});

	it('throws when the response has no emailAddress', async () => {
		await assert.rejects(
			() =>
				fetchJiraEmail({
					baseUrl: 'https://make.atlassian.net',
					email: 'a@b.com',
					token: 'tok',
					fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ displayName: 'No Email' }) }),
				}),
			/emailAddress/,
		);
	});
});
