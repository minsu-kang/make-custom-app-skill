# Fetch the Jira ticket (when one is attached)

Run this when a Jira ticket is attached, before forming a plan. It usually comes after the app is identified and its code and context are loaded ([lifecycle.md](lifecycle.md) §1 to §3); a task that needs the ticket status earlier fetches it earlier. Employee mode only: in public mode the chat request is the ticket ([lifecycle.md § Public mode](lifecycle.md#public-mode)); do not fetch or ask for a Jira ticket.

One `getJiraIssue` call with `fields: ["summary","description","subtasks","comment","status","attachment","issuetype","customfield_10483","customfield_10283","customfield_10268"]`.

- `customfield_10483` = Developer Notes — read before forming any plan or verdict.
- `customfield_10283` = API Docs URL — fetch and cross-reference when present.
- `customfield_10268` = App HQ URL (see [lifecycle.md](lifecycle.md) §1).
- `attachment` → run `node "<plugin root>/shared/scripts/download-jira-ticket-attachment.js" {KEY}` and read every image with the Read tool; note video paths. Skipping attachments causes misdiagnosis.
- Subtasks: fetch each with the same fields. `Done` / `Canceled` → skip. In a **code review**, `Test` is the item needing attention (developer finished, QA pending) and other statuses are context only. When **fixing a QA-returned ticket**, `To Do` / `In Progress` subtasks are the items needing attention: evaluate each against the skill references (`endpoints-reference.md`, `code-review-criteria.md`, `runtime-reference.md`) first to classify it as **True Positive** or **False Positive** (e.g., a request to `encodeURL()` simple resource IDs, or to work around platform-level MCP validation/default limits). Do not implement a change that violates skill conventions. Present that verdict to the user before editing. If the ticket is itself a subtask, fetch the parent for scope and AC.
- Read comments on parent and subtasks — they carry AC amendments, QA reproduction steps, prior review feedback.
- Subtask lifecycle (IEN board): QA opens subtask → developer fixes and sets `Test` (or `Canceled` for a confirmed false positive, transitioning through `In Progress` first) → parent to `Compilation` (some say `Commit`) and asks for review → reviewer moves parent to `In Testing` on commit → QA moves subtasks `Test → Done`. Reviewers never touch `Test` subtasks.
- Atlassian MCP unavailable → tell the user: "Enable the Atlassian MCP server in your editor's MCP settings, restart, and resend the request." (employee mode; in public mode never offer the Atlassian server)
