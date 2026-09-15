#!/usr/bin/env node
/**
 * Post code-review Jira transition script
 *
 * Usage:
 *   node post-review-transition.js <issue-key> <disposition> [--force] [--from-status=<name>]
 *
 *   <disposition>:
 *     committed  → assign to self + transition to "In Testing" (from Commit or Compilation)
 *     returned   → assign to self + transition to:
 *                    - "In Progress" (from Commit)
 *                    - "To Do"       (from Compilation — workflow has no direct In Progress transition)
 *
 * Default required pre-status: "Commit" or "Compilation" (comma-separated, customizable via --from-status)
 *
 * Examples:
 *   node post-review-transition.js IEN-14701 committed
 *   node post-review-transition.js IEN-14701 returned
 *   node post-review-transition.js IEN-14701 committed --force
 *
 * Requires jira-email and jira-api-token in ~/.make-custom-app-skill-secrets
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const { loadJiraConfig } = require('./lib/settings');


// Target status depends on disposition AND current status.
// IEN has two workflows: one with "Commit" status, another with "Compilation".
// "Compilation" workflow has no direct "In Progress" transition, so returned → "To Do".
const TARGET_MATRIX = {
	committed: {
		Commit: 'In Testing',
		Compilation: 'In Testing',
	},
	returned: {
		Commit: 'In Progress',
		Compilation: 'To Do',
	},
};


function request(method, url, auth, body) {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const payload = body != null ? JSON.stringify(body) : null;
		const headers = {
			Authorization: `Basic ${Buffer.from(`${auth.email}:${auth.apiToken}`).toString('base64')}`,
			Accept: 'application/json',
		};
		if (payload) {
			headers['Content-Type'] = 'application/json';
			headers['Content-Length'] = Buffer.byteLength(payload);
		}

		const options = {
			hostname: parsedUrl.hostname,
			path: parsedUrl.pathname + parsedUrl.search,
			method,
			headers,
		};

		const req = https.request(options, (res) => {
			let data = '';
			res.on('data', (chunk) => (data += chunk));
			res.on('end', () => {
				if (res.statusCode >= 400) {
					reject(new Error(`HTTP ${res.statusCode} ${method} ${url}: ${data}`));
					return;
				}
				if (!data) {
					resolve(null);
					return;
				}
				try {
					resolve(JSON.parse(data));
				} catch (e) {
					resolve(data);
				}
			});
		});
		req.on('error', reject);
		if (payload) req.write(payload);
		req.end();
	});
}

function parseArgs(argv) {
	const positional = [];
	const flags = { force: false, fromStatus: 'Commit,Compilation' };

	for (const arg of argv) {
		if (arg === '--force') {
			flags.force = true;
		} else if (arg.startsWith('--from-status=')) {
			flags.fromStatus = arg.replace('--from-status=', '').trim();
		} else if (arg.startsWith('--')) {
			console.error(`Unknown flag: ${arg}`);
			process.exit(1);
		} else {
			positional.push(arg);
		}
	}

	return { positional, flags };
}

async function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	const [issueKey, disposition] = positional;

	if (!issueKey || !disposition) {
		console.error('Usage: node post-review-transition.js <issue-key> <committed|returned> [--force] [--from-status=<name1,name2>]');
		console.error('  committed → "In Testing"  (from Commit or Compilation)');
		console.error('  returned  → "In Progress" (from Commit) | "To Do" (from Compilation)');
		process.exit(1);
	}

	const targetsByStatus = TARGET_MATRIX[disposition];
	if (!targetsByStatus) {
		console.error(`ERROR: Invalid disposition "${disposition}". Must be "committed" or "returned".`);
		process.exit(1);
	}

	const config = loadJiraConfig();
	const auth = { email: config.email, apiToken: config.apiToken };

	const allowedFromStatuses = flags.fromStatus
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	console.log(`Issue: ${issueKey}`);
	console.log(`Disposition: ${disposition}`);
	console.log(`Target status by current status: ${JSON.stringify(targetsByStatus)}`);
	console.log(`Allowed pre-status: ${allowedFromStatuses.map((s) => `"${s}"`).join(' | ')}${flags.force ? ' (force override)' : ''}\n`);

	const me = await request('GET', `${config.baseUrl}/rest/api/3/myself`, auth);
	if (!me || !me.accountId) {
		console.error('ERROR: Could not resolve authenticated user via /myself.');
		process.exit(1);
	}
	console.log(`Authenticated: ${me.displayName} <${me.emailAddress || 'n/a'}> (${me.accountId})`);

	const issue = await request(
		'GET',
		`${config.baseUrl}/rest/api/3/issue/${issueKey}?fields=status,assignee,summary`,
		auth,
	);
	const currentStatus = issue.fields?.status?.name || '(unknown)';
	const currentAssignee = issue.fields?.assignee?.displayName || '(unassigned)';
	const summary = issue.fields?.summary || '';
	console.log(`Current: status="${currentStatus}", assignee="${currentAssignee}"`);
	console.log(`Summary: ${summary}\n`);

	if (!allowedFromStatuses.includes(currentStatus) && !flags.force) {
		console.error(
			`ABORT: current status "${currentStatus}" is not in allowed list [${allowedFromStatuses.map((s) => `"${s}"`).join(', ')}]. ` +
				`Use --force to override or --from-status=<name1,name2> to customize.`,
		);
		process.exit(2);
	}

	const targetStatus = targetsByStatus[currentStatus];
	if (!targetStatus) {
		console.error(
			`ABORT: No target status defined for disposition "${disposition}" from current status "${currentStatus}".\n` +
				`Known mappings: ${JSON.stringify(targetsByStatus)}`,
		);
		process.exit(4);
	}
	console.log(`Resolved: "${currentStatus}" --[${disposition}]--> "${targetStatus}"\n`);

	console.log(`▸ Assigning to ${me.displayName} ...`);
	await request(
		'PUT',
		`${config.baseUrl}/rest/api/3/issue/${issueKey}/assignee`,
		auth,
		{ accountId: me.accountId },
	);
	console.log('  ✓ Assigned');

	console.log(`▸ Looking up transition to "${targetStatus}" ...`);
	const transitionsResp = await request(
		'GET',
		`${config.baseUrl}/rest/api/3/issue/${issueKey}/transitions`,
		auth,
	);
	const transitions = transitionsResp?.transitions || [];
	const match = transitions.find((t) => t.to?.name === targetStatus);
	if (!match) {
		console.error(
			`ABORT: No transition available to status "${targetStatus}" from current status "${currentStatus}".`,
		);
		console.error('Available transitions:');
		for (const t of transitions) {
			console.error(`  - "${t.name}" → "${t.to?.name}" (id: ${t.id})`);
		}
		process.exit(3);
	}
	console.log(`  Found: "${match.name}" (id: ${match.id}) → "${match.to.name}"`);

	console.log(`▸ Transitioning ...`);
	await request(
		'POST',
		`${config.baseUrl}/rest/api/3/issue/${issueKey}/transitions`,
		auth,
		{ transition: { id: match.id } },
	);
	console.log('  ✓ Transitioned\n');

	console.log(`=== Done ===`);
	console.log(`  ${issueKey}: "${currentStatus}" → "${targetStatus}"`);
	console.log(`  Assignee: ${me.displayName}`);
	console.log(`  URL: ${config.baseUrl}/browse/${issueKey}`);
}

require('./lib/version-guard').ensureFreshSkill();

main().catch((err) => {
	console.error('ERROR:', err.message);
	process.exit(1);
});
