#!/usr/bin/env node
'use strict';

// Cursor sessionStart hook, the only registered caller (hooks/hooks-cursor.json); Claude Code does not run it (spec 5).

const CONTEXT =
	'Skills for Make custom app work (IMLJSON, the Make Apps SDK, your own custom app with or without a Jira ticket, an app slug): make-app-question, make-app-code-review, make-app-bug-investigation, make-app-feature-request, make-app-task, make-app-endpoint, make-app-run-live, make-app-task-refinement (feasibility and plans, Preparation tickets), make-app-setup. They sync the app source themselves, so use the matching skill instead of searching the file system for the app.';

function render() {
	return { additional_context: CONTEXT };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(render())}\n`);

module.exports = { CONTEXT, render };
