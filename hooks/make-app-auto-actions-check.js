#!/usr/bin/env node
/**
 * Cursor stop-hook: enforce Make app post-work checklist.
 *
 * Scans the current conversation transcript for Make app work signals
 * (IMLJSON edits, SDK script usage, Jira tickets, code review work, etc.)
 * and blocks the stop event if any mandatory follow-up action from
 * `make-app-auto-actions.mdc` is missing.
 *
 * Enforced checks (hard blocks — fixable by the agent before ending):
 *   §6    — IML function code.js changed → test.js updated + test-function.js run
 *   §6-2  — api.imljson changed → test-component.js run for that component
 *   §8    — write script used on Jira ticket → Developer Notes written or explicitly declined by user
 *   §9    — Make app work → ~/.cursor/make-app-contexts/{slug}-v{version}.md updated
 *   §10   — Make app work → upsert_app_context called
 *          + Jira ticket referenced → upsert_jira_ticket called
 *   Post-review — user said "committed" / "returned to developer" → post-review-transition.js run
 *
 * Designed to be defensive: on any error, fails OPEN (allow stop) so it never
 * breaks normal sessions. loop_limit=1 in hooks.json prevents infinite loops.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ──────────────────────────────────────────────────────────────────────────────
// Entry
// ──────────────────────────────────────────────────────────────────────────────

function main() {
	let input = '';
	try {
		input = fs.readFileSync(0, 'utf8');
	} catch (_) {
		return allow();
	}

	let payload = {};
	try {
		payload = input.trim() ? JSON.parse(input) : {};
	} catch (_) {
		return allow();
	}

	if (payload.stop_hook_active) return allow();

	const transcriptPath =
		payload.transcript_path || payload.transcriptPath || findLatestTranscript(payload);
	if (!transcriptPath || !fs.existsSync(transcriptPath)) return allow();

	const messages = readJsonl(transcriptPath);
	if (!messages.length) return allow();

	const ctx = analyzeTranscript(messages);

	// Nothing Make-app-ish happened → allow
	if (!ctx.touchedMakeApp && ctx.ticketKeys.length === 0 && !ctx.postReviewDisposition) {
		return allow();
	}

	const failures = runChecks(ctx);
	if (failures.length === 0) return allow();

	return block(formatReason(ctx, failures));
}

// ──────────────────────────────────────────────────────────────────────────────
// Transcript analysis
// ──────────────────────────────────────────────────────────────────────────────

function analyzeTranscript(messages) {
	const body = flattenText(messages);
	const toolCalls = extractToolCalls(messages);
	const lastUserMessage = findLastUserText(messages);

	const ticketKeys = extractTicketKeysStrict(messages, toolCalls);

	const editedPaths = collectEditedPaths(toolCalls);
	const shellCommands = collectShellCommands(toolCalls);
	const mcpCalls = toolCalls.filter((t) => t.mcp);
	const agentText = collectAgentText(messages);

	const modifiedFunctions = extractModifiedFunctions(editedPaths);
	const modifiedTestFunctions = extractModifiedTestFunctions(editedPaths);
	const modifiedApiComponents = extractModifiedApiComponents(editedPaths);
	const modifiedContextFiles = editedPaths.filter((p) =>
		/make-app-contexts\/[^/]+-v\d+\.md$/.test(p),
	);

	const usedWriteScript =
		shellCommands.some((c) =>
			/\b(update-app|create-component|update-component|delete-component)\.js\b/.test(c),
		) ||
		toolCalls.some(
			(t) =>
				typeof t.name === 'string' &&
				/(update_app|create_component|update_component|delete_component)/.test(t.name),
		);

	const isCodeReview =
		shellCommands.some((c) => /\breview-changes\.js\b/.test(c)) ||
		/code\s*review|reviewing\s+(this|the|code)/i.test(body) ||
		/(^|\n)\s*#+\s*(code\s*)?review/i.test(agentText);

	const postReviewDisposition = detectDisposition(lastUserMessage, agentText);

	const devNotesDeclined = detectDevNotesDecline(messages);
	const devNotesPrompted = detectDevNotesPrompted(agentText, toolCalls);

	const touchedMakeApp = detectMakeAppWork({
		body,
		toolCalls,
		editedPaths,
		shellCommands,
	});

	return {
		ticketKeys,
		toolCalls,
		mcpCalls,
		editedPaths,
		shellCommands,
		modifiedFunctions,
		modifiedTestFunctions,
		modifiedApiComponents,
		modifiedContextFiles,
		usedWriteScript,
		isCodeReview,
		postReviewDisposition,
		devNotesDeclined,
		devNotesPrompted,
		touchedMakeApp,
		lastUserMessage,
		agentText,
	};
}

function detectMakeAppWork({ toolCalls, editedPaths, shellCommands }) {
	// Only trust concrete tool_use signals — no text-regex fallbacks on assistant
	// prose, since the skill repo itself frequently mentions `imljson`,
	// `~/.cursor/skills/make-custom-app/`, etc. without any Make app being touched.
	if (editedPaths.some((p) => /\.imljson$/i.test(p))) return true;
	if (editedPaths.some((p) => /make-app-contexts\/[^/]+-v\d+\.md$/.test(p))) return true;
	if (
		shellCommands.some((c) =>
			/\b(update-app|create-component|update-component|delete-component|download-app|test-component|test-function|review-changes|post-review-transition)\.js\b/.test(
				c,
			),
		)
	) {
		return true;
	}
	if (
		toolCalls.some(
			(t) =>
				typeof t.name === 'string' &&
				(t.name === 'upsert_app_context' ||
					t.name === 'upsert_jira_ticket' ||
					t.name === 'search_app_knowledge' ||
					t.name === 'get_app_summary' ||
					t.name === 'list_apps'),
		)
	) {
		return true;
	}
	return false;
}

function extractModifiedFunctions(paths) {
	const set = new Set();
	for (const p of paths) {
		const m = p.match(/functions\/([^/]+)\/code\.js$/);
		if (m) set.add(m[1]);
	}
	return [...set];
}

function extractModifiedTestFunctions(paths) {
	const set = new Set();
	for (const p of paths) {
		const m = p.match(/functions\/([^/]+)\/test\.js$/);
		if (m) set.add(m[1]);
	}
	return [...set];
}

function extractModifiedApiComponents(paths) {
	const out = new Map();
	for (const p of paths) {
		const m = p.match(/(modules|rpcs|webhooks|connections)\/([^/]+)\/api\.imljson$/);
		if (m) {
			const type = { modules: 'module', rpcs: 'rpc', webhooks: 'webhook', connections: 'connection' }[
				m[1]
			];
			out.set(`${type}:${m[2]}`, { type, name: m[2] });
		}
	}
	return [...out.values()];
}

function detectDisposition(lastUser, agentText) {
	if (!lastUser) return null;
	const t = lastUser.toLowerCase();
	// Must be explicit — avoid false positives on conversational mentions
	if (/\bcommit(t?ed)?\b/.test(t) && !/not\s+commit/.test(t)) return 'committed';
	if (/\breturn(ed)?\b\s*(to\s+developer)?/.test(t) || /\bsend\s+back\b/.test(t))
		return 'returned';
	return null;
}

/**
 * Detect whether the user has declined the Developer Notes prompt at any point
 * in the conversation. Scans all user messages (after stripping any re-injected
 * hook output) for negation phrases adjacent to "developer notes" / "dev notes" /
 * "노트" / "customfield_10483". Multilingual.
 *
 * Once the user has declined, the rule says "skip, do not ask again" — so the
 * decision must persist across subsequent turns, not just match the most recent
 * user message.
 */
function detectDevNotesDecline(messages) {
	// "Word near notes" decline — explicit form ("don't write developer notes",
	// "노트 작성하지 마" etc.). Requires negation + notes-ish keyword adjacency.
	const declineNear = new RegExp(
		// English negation/decline tokens
		String.raw`(?:` +
			String.raw`(?:\bno\b|\bnope\b|\bskip\b|\bdon'?t\b|\bdo\s*not\b|\bdecline\b|\bnot\s+now\b|\bnever\b|\bno\s+thanks?\b|` +
			// Korean negation/decline tokens (common patterns)
			String.raw`적는\s*게\s*아니|적지\s*마|쓰지\s*마|쓰지\s*않|안\s*적|안\s*써|안\s*씀|안\s*함|아니다|아니야|아니에요|필요\s*없|스킵|건너|패스|됐다|됐어|됐고)` +
			String.raw`[^.\n]{0,80}` +
			String.raw`(?:dev(?:eloper)?\s*notes?|customfield_10483|개발자\s*노트|디벨로퍼\s*노트|노트)` +
			String.raw`)|(?:` +
			// Same patterns but with "notes" first
			String.raw`(?:dev(?:eloper)?\s*notes?|customfield_10483|개발자\s*노트|디벨로퍼\s*노트|노트)` +
			String.raw`[^.\n]{0,80}` +
			String.raw`(?:\bno\b|\bnope\b|\bskip\b|\bdon'?t\b|\bdo\s*not\b|\bdecline\b|\bnot\s+now\b|\bnever\b|\bno\s+thanks?\b|` +
			String.raw`적는\s*게\s*아니|적지\s*마|쓰지\s*마|쓰지\s*않|안\s*적|안\s*써|안\s*씀|안\s*함|아니다|아니야|아니에요|필요\s*없|스킵|건너|패스|됐다|됐어|됐고))`,
		'i',
	);

	// Standalone negation — short user reply with no notes keyword. Only counts
	// as a decline when the IMMEDIATELY PRECEDING assistant turn asked the
	// dev-notes question (context-implicit decline). Examples that should
	// trigger only in that context:
	//   "ㄴㄴ", "ㄴㄴ 작성하지마셈", "no", "no thanks", "skip", "ㄴㄴㄴ",
	//   "아니", "안 함", "필요없음", "ㄴ ㄴ"
	// NOTE: Hangul characters do not participate in JS \b word boundaries, so
	// instead of \b we anchor at start and require either end-of-string or a
	// non-Hangul / non-word follow char. This lets "ㄴㄴ" match while still
	// rejecting things like "노" alone or longer mid-sentence words.
	const standaloneNegationRe = new RegExp(
		String.raw`^\s*(?:` +
			String.raw`ㄴ{2,}|ㄴ\s+ㄴ|아니(?:[야다요])?|싫(?:어)?|필요\s*없\S*|건너[^\s]*|패스|스킵|` +
			String.raw`no|nope|nah|skip|pass|never|don'?t|do\s*not|decline|not\s+now|no\s+thanks?` +
			String.raw`)(?:\s|[.!?,]|$)`,
		'i',
	);

	const promptRe =
		/(?:shall\s+i\s+write\s+developer\s+notes)|(?:write\s+developer\s+notes\??)|(?:developer\s+notes[^.\n]{0,30}(?:작성|기록|쓸까|쓰[시지]|적[시지을]?|남길까|넣을까))|(?:customfield_10483)|(?:개발자\s*노트[^.\n]{0,30}(?:작성|기록|쓸까|쓰[시지]|적[시지을]?|남길까|넣을까))/i;

	const collectText = (m) => {
		const content = m?.message?.content;
		const out = [];
		if (typeof content === 'string') out.push(content);
		else if (Array.isArray(content)) {
			for (const c of content) {
				if (typeof c === 'string') out.push(c);
				else if (c && typeof c.text === 'string') out.push(c.text);
			}
		}
		return out.join('\n');
	};

	let prevAssistantText = '';
	for (const m of messages) {
		const role = m?.message?.role || m?.role;
		if (role === 'assistant') {
			prevAssistantText = collectText(m);
			continue;
		}
		if (role !== 'user') continue;
		const userText = stripHookOutput(collectText(m));
		if (!userText) continue;
		// Form 1: explicit decline mentioning notes
		if (declineNear.test(userText)) return true;
		// Form 2: short standalone negation following a dev-notes prompt
		if (promptRe.test(prevAssistantText) && standaloneNegationRe.test(userText.trim())) return true;
	}
	return false;
}

/**
 * Detect whether the agent has already prompted the user about Developer Notes.
 * Looks at both:
 *   - assistant prose (agentText) for "Shall I write Developer Notes ...",
 *     "Developer Notes를 작성할까요" etc., in any language
 *   - structured tool calls (AskQuestion) whose prompt mentions developer notes
 *     or customfield_10483
 */
function detectDevNotesPrompted(agentText, toolCalls) {
	const promptRe =
		/(?:shall\s+i\s+write\s+developer\s+notes)|(?:write\s+developer\s+notes\??)|(?:developer\s+notes[^.\n]{0,30}(?:작성|기록|쓸까|쓰[시지]|적[시지을]?|남길까|넣을까))|(?:customfield_10483)|(?:개발자\s*노트[^.\n]{0,30}(?:작성|기록|쓸까|쓰[시지]|적[시지을]?|남길까|넣을까))/i;

	if (promptRe.test(agentText || '')) return true;

	for (const t of toolCalls || []) {
		if (!/^AskQuestion$/i.test(t.name || '')) continue;
		try {
			const blob = JSON.stringify(t.input || {});
			if (promptRe.test(blob)) return true;
		} catch (_) {}
	}
	return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Checks
// ──────────────────────────────────────────────────────────────────────────────

function runChecks(ctx) {
	const failures = [];

	// §9: Context file update
	if (ctx.touchedMakeApp && ctx.modifiedContextFiles.length === 0) {
		failures.push({
			id: '§9',
			title: 'Context file not updated',
			remedy:
				'Write or update ~/.cursor/make-app-contexts/{slug}-v{version}.md with the work performed (overview, patterns, work history for the ticket).',
		});
	}

	// §10a: upsert_app_context
	if (ctx.touchedMakeApp && !hasMcpCall(ctx, 'upsert_app_context')) {
		failures.push({
			id: '§10',
			title: 'upsert_app_context not called',
			remedy:
				'Call user-make-app-context.upsert_app_context with { slug, version } to sync the context file to Pinecone.',
		});
	}

	// §10b: upsert_jira_ticket per ticket
	if (ctx.ticketKeys.length > 0) {
		const synced = collectJiraTicketsSynced(ctx);
		const missing = ctx.ticketKeys.filter((k) => !synced.has(k));
		if (missing.length > 0) {
			failures.push({
				id: '§10',
				title: 'upsert_jira_ticket not called for all tickets',
				remedy:
					`Call user-make-app-context.upsert_jira_ticket for each: ${missing.join(', ')}. ` +
					'Include summary, description, and developer_notes if available.',
			});
		}
	}

	// §6: function code.js changed → test.js updated + test-function.js run
	for (const fn of ctx.modifiedFunctions) {
		if (!ctx.modifiedTestFunctions.includes(fn)) {
			failures.push({
				id: '§6',
				title: `functions/${fn}/test.js not updated`,
				remedy: `Create or update functions/${fn}/test.js to cover the changed behavior (happy path, edge cases, regression guards).`,
			});
		}
		const ranTest = ctx.shellCommands.some(
			(c) => /test-function\.js\b/.test(c) && new RegExp(`\\b${escapeRe(fn)}\\b`).test(c),
		);
		if (!ranTest) {
			failures.push({
				id: '§6',
				title: `test-function.js not run for ${fn}`,
				remedy: `Run: node ~/.cursor/skills/make-custom-app/scripts/test-function.js <slug> <version> ${fn}`,
			});
		}
	}

	// §6-2: api.imljson changed → test-component.js run (skip for pure code review)
	if (!ctx.isCodeReview) {
		for (const comp of ctx.modifiedApiComponents) {
			const ranTest = ctx.shellCommands.some(
				(c) =>
					/test-component\.js\b/.test(c) &&
					new RegExp(`\\b${escapeRe(comp.name)}\\b`).test(c) &&
					new RegExp(`\\b${escapeRe(comp.type)}\\b`).test(c),
			);
			if (!ranTest) {
				failures.push({
					id: '§6-2',
					title: `test-component.js not run for ${comp.type} ${comp.name}`,
					remedy: `Run: node ~/.cursor/skills/make-custom-app/scripts/test-component.js <slug> <version> ${comp.type} ${comp.name}`,
				});
			}
		}
	}

	// §8: write script on a Jira ticket → Developer Notes acknowledged
	//
	// Skip entirely for code reviews — Developer Notes are the *developer's*
	// responsibility (their own explanation of what they changed and why), not
	// the reviewer's. Code reviews follow §7 of make-app-code-review.mdc instead
	// (disposition prompt + post-review-transition.js).
	if (!ctx.isCodeReview && ctx.usedWriteScript && ctx.ticketKeys.length > 0) {
		const wrote = ctx.toolCalls.some(
			(t) =>
				(t.name === 'editJiraIssue' ||
					(t.mcp && t.name && t.name.toLowerCase().includes('edit'))) &&
				JSON.stringify(t.input || {}).includes('customfield_10483'),
		);
		if (!wrote && !ctx.devNotesPrompted && !ctx.devNotesDeclined) {
			failures.push({
				id: '§8',
				title: 'Developer Notes neither written nor offered',
				remedy:
					'Ask the user: "Shall I write Developer Notes to the Jira ticket?" If approved, write to customfield_10483 via editJiraIssue (ADF with Root Cause / Fix / Affected Components / Changed Files tables).',
			});
		}
	}

	// Post-review disposition → post-review-transition.js
	if (ctx.postReviewDisposition && ctx.ticketKeys.length > 0) {
		const arg = ctx.postReviewDisposition; // committed | returned
		const ran = ctx.shellCommands.some(
			(c) => /post-review-transition\.js\b/.test(c) && new RegExp(`\\b${arg}\\b`).test(c),
		);
		if (!ran) {
			failures.push({
				id: 'post-review',
				title: `post-review-transition.js not run (${arg})`,
				remedy:
					`User disposition detected: "${arg}". Run: ` +
					`node ~/.cursor/skills/make-custom-app/scripts/post-review-transition.js ${ctx.ticketKeys[0]} ${arg}`,
			});
		}
	}

	return failures;
}

function hasMcpCall(ctx, toolName) {
	return ctx.toolCalls.some((t) => t.name === toolName);
}

function collectJiraTicketsSynced(ctx) {
	const set = new Set();
	for (const t of ctx.toolCalls) {
		if (t.name !== 'upsert_jira_ticket') continue;
		const input = t.input || {};
		const key =
			input.ticket_key ||
			input.ticketKey ||
			input.issue_key ||
			input.issueKey ||
			input.key;
		if (typeof key === 'string') set.add(key);
		// Fallback: scan the input JSON for ticket keys
		try {
			const keys = extractTicketKeys(JSON.stringify(input));
			for (const k of keys) set.add(k);
		} catch (_) {}
	}
	return set;
}

// ──────────────────────────────────────────────────────────────────────────────
// Output
// ──────────────────────────────────────────────────────────────────────────────

function formatReason(ctx, failures) {
	const lines = [];
	lines.push('Post-work checklist incomplete (make-app-auto-actions.mdc).');
	lines.push('');
	if (ctx.ticketKeys.length) lines.push(`Jira ticket(s): ${ctx.ticketKeys.join(', ')}`);
	if (ctx.modifiedFunctions.length)
		lines.push(`Modified functions: ${ctx.modifiedFunctions.join(', ')}`);
	if (ctx.modifiedApiComponents.length)
		lines.push(
			`Modified api.imljson: ${ctx.modifiedApiComponents.map((c) => `${c.type}/${c.name}`).join(', ')}`,
		);
	if (ctx.postReviewDisposition)
		lines.push(`Post-review disposition: ${ctx.postReviewDisposition}`);
	lines.push('');
	lines.push('Missing actions:');
	failures.forEach((f, i) => {
		lines.push(`${i + 1}. [${f.id}] ${f.title}`);
		lines.push(`   → ${f.remedy}`);
	});
	lines.push('');
	lines.push('Complete the missing actions, then end the turn.');
	return lines.join('\n');
}

function allow() {
	process.stdout.write('');
	process.exit(0);
}

function block(reason) {
	const out = JSON.stringify({ decision: 'block', reason });
	process.stdout.write(out);
	process.exit(0);
}

// ──────────────────────────────────────────────────────────────────────────────
// Low-level helpers
// ──────────────────────────────────────────────────────────────────────────────

function findLatestTranscript(payload) {
	const base = path.join(os.homedir(), '.cursor', 'projects');
	if (!fs.existsSync(base)) return null;

	const preferredProject = payload.cwd
		? path.basename(payload.cwd).replace(/[^a-zA-Z0-9]/g, '-')
		: null;

	const candidates = [];
	for (const proj of safeReaddir(base)) {
		const transcriptDir = path.join(base, proj, 'agent-transcripts');
		if (!fs.existsSync(transcriptDir)) continue;
		for (const sid of safeReaddir(transcriptDir)) {
			const sessDir = path.join(transcriptDir, sid);
			const stat = safeStat(sessDir);
			if (!stat || !stat.isDirectory()) continue;
			for (const f of safeReaddir(sessDir)) {
				if (!f.endsWith('.jsonl')) continue;
				const full = path.join(sessDir, f);
				const st = safeStat(full);
				if (!st) continue;
				const projectBoost = preferredProject && proj.includes(preferredProject) ? 1e13 : 0;
				candidates.push({ full, mtime: st.mtimeMs + projectBoost });
			}
		}
	}
	if (!candidates.length) return null;
	candidates.sort((a, b) => b.mtime - a.mtime);
	return candidates[0].full;
}

function safeReaddir(p) {
	try {
		return fs.readdirSync(p);
	} catch (_) {
		return [];
	}
}

function safeStat(p) {
	try {
		return fs.statSync(p);
	} catch (_) {
		return null;
	}
}

function readJsonl(p) {
	const raw = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
	const out = [];
	for (const line of raw) {
		try {
			out.push(JSON.parse(line));
		} catch (_) {}
	}
	return out;
}

function flattenText(messages) {
	const parts = [];
	for (const m of messages) {
		const content = m?.message?.content;
		if (!Array.isArray(content)) {
			if (typeof content === 'string') parts.push(content);
			continue;
		}
		for (const c of content) {
			if (typeof c === 'string') parts.push(c);
			else if (c && typeof c.text === 'string') parts.push(c.text);
		}
	}
	return parts.join('\n');
}

function collectAgentText(messages) {
	const parts = [];
	for (const m of messages) {
		const role = m?.message?.role || m?.role;
		if (role !== 'assistant') continue;
		const content = m?.message?.content;
		if (!Array.isArray(content)) {
			if (typeof content === 'string') parts.push(content);
			continue;
		}
		for (const c of content) {
			if (typeof c === 'string') parts.push(c);
			else if (c && typeof c.text === 'string') parts.push(c.text);
		}
	}
	return parts.join('\n');
}

function findLastUserText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		const role = m?.message?.role || m?.role;
		if (role !== 'user') continue;
		const content = m?.message?.content;
		if (typeof content === 'string') return content;
		if (Array.isArray(content)) {
			const parts = [];
			for (const c of content) {
				if (typeof c === 'string') parts.push(c);
				else if (c && typeof c.text === 'string') parts.push(c.text);
			}
			if (parts.length) return parts.join('\n');
		}
	}
	return null;
}

function extractTicketKeys(text) {
	const set = new Set();
	if (typeof text !== 'string' || !text) return [];
	const re = /\b[A-Z][A-Z0-9]+-\d{2,6}\b/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		// Filter to common prefixes to reduce false positives
		if (/^(IEN|APPS|INT|APP|MI|MAKE)-/.test(m[0])) set.add(m[0]);
	}
	return [...set];
}

/**
 * Remove any previous hook-output blocks that Cursor may have injected back
 * into the transcript as a user-role message after `decision: block`.
 *
 * The hook's own reason text contains example ticket IDs and would otherwise
 * be re-read as real work signals on the next stop cycle.
 */
function stripHookOutput(text) {
	if (typeof text !== 'string' || !text) return text || '';
	// Anchor on our stable signatures. Be tolerant to minor wording changes.
	return text
		.replace(
			/Post-work checklist incomplete[\s\S]*?Complete the missing actions, then end the turn\.?/g,
			'',
		)
		.replace(
			/Missing actions:[\s\S]*?(?:upsert_jira_ticket|upsert_app_context|test-component\.js|test-function\.js|post-review-transition\.js)[\s\S]{0,800}/g,
			'',
		);
}

/**
 * Strict ticket extraction — only pulls keys from signals that indicate
 * real work, not incidental mentions in example code / test fixtures.
 *
 * Sources (in priority order):
 *   1. User messages (the human explicitly referenced the ticket)
 *   2. Jira MCP tool inputs (getJiraIssue, editJiraIssue, createJiraIssue, …)
 *   3. `upsert_jira_ticket` MCP inputs (the agent itself synced it)
 *
 * Shell commands, code blocks, and arbitrary assistant prose are NOT scanned,
 * since those frequently contain placeholder / sample keys.
 */
function extractTicketKeysStrict(messages, toolCalls) {
	const set = new Set();

	for (const m of messages) {
		const role = m?.message?.role || m?.role;
		if (role !== 'user') continue;
		const content = m?.message?.content;
		const texts = [];
		if (typeof content === 'string') texts.push(content);
		else if (Array.isArray(content)) {
			for (const c of content) {
				if (typeof c === 'string') texts.push(c);
				else if (c && typeof c.text === 'string') texts.push(c.text);
			}
		}
		for (const t of texts) {
			// Strip any hook-output blocks that may have been re-injected as a
			// user-role message by Cursor after a prior `decision: block`.
			// Otherwise placeholder tickets inside the hook reason get treated
			// as real work tickets on the next stop cycle.
			const clean = stripHookOutput(t);
			for (const k of extractTicketKeys(clean)) set.add(k);
		}
	}

	for (const t of toolCalls) {
		const name = (t.name || '').toLowerCase();
		const isJira =
			/\bjira\b|issue/i.test(name) ||
			name === 'upsert_jira_ticket' ||
			name === 'getjiraissue' ||
			name === 'editjiraissue' ||
			name === 'createjiraissue';
		if (!isJira) continue;
		try {
			const inputStr = JSON.stringify(t.input || {});
			for (const k of extractTicketKeys(inputStr)) set.add(k);
		} catch (_) {}
	}

	return [...set];
}

function extractToolCalls(messages) {
	const out = [];
	for (const m of messages) {
		const content = m?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const c of content) {
			if (c?.type !== 'tool_use' || typeof c.name !== 'string') continue;
			const entry = { name: c.name, input: c.input, mcp: false };
			out.push(entry);
			if (c.name === 'CallMcpTool') {
				const inner = c.input?.toolName;
				if (typeof inner === 'string') {
					out.push({ name: inner, input: c.input?.arguments, mcp: true });
				}
			}
		}
	}
	return out;
}

function collectEditedPaths(toolCalls) {
	const set = new Set();
	for (const t of toolCalls) {
		if (!t.input || typeof t.input !== 'object') continue;
		const isEditTool = /^(Write|StrReplace|Edit|MultiEdit|EditNotebook)$/i.test(t.name || '');
		if (!isEditTool) continue;
		const p = t.input.path || t.input.file_path || t.input.target_notebook || t.input.target_file;
		if (typeof p === 'string') set.add(p);
	}
	return [...set];
}

function collectShellCommands(toolCalls) {
	const out = [];
	for (const t of toolCalls) {
		if (!/^Shell$/i.test(t.name || '')) continue;
		const cmd = t.input?.command;
		if (typeof cmd === 'string') out.push(cmd);
	}
	return out;
}

function escapeRe(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

try {
	main();
} catch (_) {
	allow();
}
