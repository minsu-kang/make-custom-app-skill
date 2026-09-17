async function fetchJiraEmail({ baseUrl, email, token, fetchFn = fetch }) {
	const root = String(baseUrl || '').replace(/\/+$/, '');
	const url = `${root}/rest/api/3/myself`;
	const res = await fetchFn(url, {
		headers: {
			Accept: 'application/json',
			Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
		},
	});
	if (!res.ok) {
		throw new Error(`Jira /myself failed: HTTP ${res.status}`);
	}
	const body = await res.json();
	if (!body || !body.emailAddress) {
		throw new Error('Jira /myself response has no emailAddress');
	}
	return body.emailAddress;
}

module.exports = { fetchJiraEmail };
