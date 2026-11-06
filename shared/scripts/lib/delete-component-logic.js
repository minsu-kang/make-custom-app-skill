/**
 * delete-component-logic.js: the status decision of delete-component.js (spec 3.5 row 15).
 *
 * Role: pure functions only. The answer of the app status call goes in; the decision comes out: no network, no file
 * access, no process.exit, no console.
 */

/**
 * answer is what the status call returned: the parsed body, or null when the call failed. In public mode a deletion
 * goes on only when Make says whether the app is public, so a failed call or an answer with no boolean `public` stops
 * it: { stop: lines }. Employee mode keeps going as before and treats a missing answer as a private app.
 */
function statusDecision({ mode, answer, slug, version }) {
	const app = answer && typeof answer === 'object' ? (answer.app && typeof answer.app === 'object' ? answer.app : answer) : null;
	if (mode === 'public' && (!app || typeof app.public !== 'boolean')) {
		return {
			stop: [
				`ERROR: Make did not say whether app ${slug} v${version} is public (the status call failed or had no public field), so nothing was deleted.`,
				'Run download-app.js and read metadata.json (public, approved). A public app allows deleting only RPCs and functions. Then run this again.',
			],
		};
	}
	const isPublic = Boolean(app && app.public);
	const isApproved = Boolean(app && app.approved);
	return { isPublic, isApproved, label: isApproved ? 'approved (public)' : isPublic ? 'public' : 'private' };
}

module.exports = { statusDecision };
