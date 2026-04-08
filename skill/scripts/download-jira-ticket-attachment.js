#!/usr/bin/env node
/**
 * Jira attachment download script
 *
 * Usage:
 *   node download-jira-ticket-attachment.js <issue-key>
 *   node download-jira-ticket-attachment.js IEN-14934
 *
 * Downloads all attachments from a Jira issue to:
 *   ~/.cursor/make-app-contexts/attachments/{issue-key}/
 *
 * Requires jira-email and jira-api-token in SKILL.md
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const SKILL_MD_PATH = path.join(os.homedir(), '.cursor/skills/make-custom-app/SKILL.md');
const ATTACHMENTS_DIR = path.join(os.homedir(), '.cursor/make-app-contexts/attachments');

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function loadJiraConfig() {
	if (!fs.existsSync(SKILL_MD_PATH)) {
		console.error('ERROR: SKILL.md not found at', SKILL_MD_PATH);
		process.exit(1);
	}

	const content = fs.readFileSync(SKILL_MD_PATH, 'utf-8');
	const lines = content.split('\n');

	let email = '';
	let apiToken = '';
	let baseUrl = 'https://make.atlassian.net';

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('jira-email:')) {
			email = trimmed.replace('jira-email:', '').trim();
		} else if (trimmed.startsWith('jira-api-token:')) {
			apiToken = trimmed.replace('jira-api-token:', '').trim();
		} else if (trimmed.startsWith('jira-base-url:')) {
			baseUrl = trimmed.replace('jira-base-url:', '').trim();
		}
	}

	if (!email || !apiToken) {
		console.error('ERROR: Jira credentials not configured in SKILL.md.');
		console.error('Add the following to the last lines of ~/.cursor/skills/make-custom-app/SKILL.md:\n');
		console.error('  jira-email: your-email@example.com');
		console.error('  jira-api-token: your-api-token');
		console.error('  jira-base-url: https://make.atlassian.net  (optional, defaults to make.atlassian.net)\n');
		console.error('Generate an API token at: https://id.atlassian.com/manage-profile/security/api-tokens');
		process.exit(1);
	}

	return { email, apiToken, baseUrl };
}

function fetchJson(url, auth) {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const options = {
			hostname: parsedUrl.hostname,
			path: parsedUrl.pathname + parsedUrl.search,
			method: 'GET',
			headers: {
				Authorization: `Basic ${Buffer.from(`${auth.email}:${auth.apiToken}`).toString('base64')}`,
				Accept: 'application/json',
			},
		};

		const req = https.request(options, (res) => {
			let data = '';
			res.on('data', (chunk) => (data += chunk));
			res.on('end', () => {
				if (res.statusCode >= 400) {
					reject(new Error(`HTTP ${res.statusCode}: ${data}`));
					return;
				}
				resolve(JSON.parse(data));
			});
		});
		req.on('error', reject);
		req.end();
	});
}

function downloadFile(url, destPath, auth) {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const options = {
			hostname: parsedUrl.hostname,
			path: parsedUrl.pathname + parsedUrl.search,
			method: 'GET',
			headers: {
				Authorization: `Basic ${Buffer.from(`${auth.email}:${auth.apiToken}`).toString('base64')}`,
			},
		};

		const req = https.request(options, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				downloadFile(res.headers.location, destPath, auth).then(resolve).catch(reject);
				return;
			}
			if (res.statusCode >= 400) {
				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${data}`)));
				return;
			}

			const file = fs.createWriteStream(destPath);
			res.pipe(file);
			file.on('finish', () => {
				file.close();
				resolve();
			});
			file.on('error', (err) => {
				fs.unlinkSync(destPath);
				reject(err);
			});
		});
		req.on('error', reject);
		req.end();
	});
}

async function main() {
	const issueKey = process.argv[2];
	if (!issueKey) {
		console.error('Usage: node download-jira-ticket-attachment.js <issue-key>');
		console.error('Example: node download-jira-ticket-attachment.js IEN-14934');
		process.exit(1);
	}

	const config = loadJiraConfig();
	const auth = { email: config.email, apiToken: config.apiToken };

	console.log(`Fetching attachments for ${issueKey}...`);

	const url = `${config.baseUrl}/rest/api/3/issue/${issueKey}?fields=attachment`;
	const issue = await fetchJson(url, auth);

	const attachments = issue.fields?.attachment || [];
	if (!attachments.length) {
		console.log(`No attachments found on ${issueKey}.`);
		process.exit(0);
	}

	const outputDir = path.join(ATTACHMENTS_DIR, issueKey);
	fs.mkdirSync(outputDir, { recursive: true });

	console.log(`Found ${attachments.length} attachment(s). Downloading to ${outputDir}/\n`);

	const results = [];

	for (const att of attachments) {
		const filename = att.filename;
		const destPath = path.join(outputDir, filename);
		const ext = path.extname(filename).toLowerCase();
		const isImage = SUPPORTED_IMAGE_EXTENSIONS.has(ext);
		const sizeMb = (att.size / 1024 / 1024).toFixed(2);

		process.stdout.write(`  ${filename} (${sizeMb} MB) ... `);

		try {
			await downloadFile(att.content, destPath, auth);
			console.log('✓');
			results.push({
				filename,
				path: destPath,
				mimeType: att.mimeType,
				size: att.size,
				isImage,
				readable: isImage,
			});
		} catch (err) {
			console.log(`✗ ${err.message}`);
		}
	}

	console.log(`\nDownloaded ${results.length}/${attachments.length} file(s) to ${outputDir}/`);

	const readableFiles = results.filter((r) => r.readable);
	if (readableFiles.length) {
		console.log(`\nReadable by agent (images):`);
		for (const f of readableFiles) {
			console.log(`  ${f.path}`);
		}
	}

	const nonReadable = results.filter((r) => !r.readable);
	if (nonReadable.length) {
		console.log(`\nNot directly readable (videos, PDFs, etc.):`);
		for (const f of nonReadable) {
			console.log(`  ${f.path} (${f.mimeType})`);
		}
	}
}

main().catch((err) => {
	console.error('ERROR:', err.message);
	process.exit(1);
});
