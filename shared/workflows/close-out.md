# Close out

> Read when: the work is done and the ticket, the context file, and Pinecone need updating. A task workflow's close-out step names the steps below that apply to it. Public mode: see the Close-out row of lifecycle.md § Public mode.

1. (Employee mode, with a ticket.) **Developer Notes, QA subtasks, and parent transition:** ask *"Shall I write Developer Notes to the Jira ticket?"* If yes, write `customfield_10483` on the **parent** ticket via `editJiraIssue` (`contentFormat: "markdown"`) using the table format from [developer-notes-templates.md](../references/developer-notes-templates.md) (`Sub-task` issues do not have `customfield_10483` on their screen). When closing out QA subtasks on a returned ticket, post a comment (`addCommentToJiraIssue`) on each subtask stating the verdict — what was fixed for a **True Positive**, or why it is a **False Positive** and what documentation/help was updated instead — and transition each subtask through `In Progress` to **`Test`** (True Positive) or **`Canceled`** (False Positive). Once Developer Notes are written (and any QA subtasks closed out), if a Jira ticket is attached and the parent ticket's status is **`In Progress`**, run `node "<plugin root>/shared/scripts/post-review-transition.js" {KEY} commit` (transitions `In Progress` → **`Commit`**, or `Compilation` if the workflow uses `Compilation`, and populates the required `customfield_10492` `"Does this have an impact on customers?"` = `"No Impact"` when unset, which MCP `transitionJiraIssue` cannot pass due to nested-object stripping).
2. **Context file** — create or update `~/.make-custom-app/contexts/{slug}-v{version}.md` (template below; keep the `##` headings — the Pinecone chunker splits on them). Add a Work History line, new caveats (with source URL for any vendor-API fact verified), pattern changes.
3. **Pinecone sync** — immediately after the file write, call MCP `upsert_app_context` `{ slug, version }` and, for each ticket worked, `upsert_jira_ticket` `{ ticket_key, slug, version, ticket_type: "bugfix"|"feature"|"review", summary, description, acceptance_criteria?, developer_notes?, review_result? }`. MCP server missing → run `check-setup.js`, show its `mcp-server` fix, tell the user sync was skipped, continue. Transient MCP error → report, suggest retry, continue. Public mode with the keys missing: say once that the shared sync is not used; do not show the fix for the keys.
4. **Post-commit sync** — when the user says the changes are committed, re-run `download-app.js` so the local copy matches. Public mode: run `download-app.js` once after the last push.
5. When everything is done, recommend context compaction before the next task.

### Context file template

```markdown
# {AppName} v{Version}

## App Overview

- slug: {slug}
- label: {label}
- API: {base URL}
- Auth method: OAuth2 / API Key / Basic / ...

## Structure

- Connection: {connection names}
- Modules: {module list (with types)}
- RPCs: {RPC list}
- Webhooks: {webhook list}
- Custom Functions: {function list}

## Key Patterns

- {Unique patterns used in this app}
- {API characteristics, error handling methods, etc.}

## Caveats

- {Known issues, API limitations, etc.}

## Work History

- {date}: {work description}
```
