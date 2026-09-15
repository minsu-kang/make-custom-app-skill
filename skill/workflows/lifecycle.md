<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->

# Task Lifecycle (shared by every workflow)

Every Make app task runs through these steps. Task workflows (`code-review.md`, `bug-investigation.md`, …) add only what is specific to them and point back here for the rest. Track progress with a todo list built from the workflow's `## Checklist`; there is no fixed template.

## 1. Identify the app

Resolve `slug` + `version`, in this order:

1. Inline from the user (`slack, 4`, "Google Docs v1").
2. Open file path `…/sdk/apps/{slug}/{version}/…`.
3. Jira ticket **App HQ URL** (`customfield_10268`): `https://{zone}/[admin/]apps/{slug}/{version}` → slug = segment after `/apps/`, version = next segment. A minimal `getJiraIssue` for just that field is fine here; the full fetch happens in §4.
4. Slug known but no version → latest major via IPME: `curl -s "https://ipme.integromat.com/v3/search/apps" -H "x-imt-ipm-version: 3.20.0"`, match `name`, take the major of `version` (`2.52.56` → `2`).
5. Otherwise ask.

## 2. Sync code

Local source lives at `${CONTEXTS_DIR}/{slug}-v{version}/` (`metadata.json`, `base.imljson`, `common.imljson`, `modules/`, `connections/`, `webhooks/`, `rpcs/`, `functions/`, `endpoints/`).

Run **without asking** when the folder is missing, `metadata.json.downloadedAt` is older than 24 h (or absent), the user's open SDK file differs from the local copy, or the task is a code review (always fresh):

```
Shell: node ${SKILL_ROOT}/scripts/download-app.js {slug} {version}
required_permissions: ["all"], block_until_ms: 120000
```

Between 1 h and 24 h old: mention the age, offer a re-download, continue. Do not answer questions about an app whose code you have not synced.

## 3. Load context

- Read `${CONTEXTS_DIR}/{slug}-v{version}.md` if it exists (structure, patterns, caveats, work history — including prior reviews and fixes).
- Call MCP `search_app_knowledge` with the slug plus ticket key / module names / feature keywords for team-wide prior context.
- For a bug in a component that was recently fixed (Work History), apply the recurring-bug rigor in `bug-investigation.md`.

## 4. Fetch the Jira ticket (when one is attached)

One `getJiraIssue` call with `fields: ["summary","description","subtasks","comment","status","attachment","issuetype","customfield_10483","customfield_10283","customfield_10268"]`.

- `customfield_10483` = Developer Notes — read before forming any plan or verdict.
- `customfield_10283` = API Docs URL — fetch and cross-reference when present.
- `customfield_10268` = App HQ URL (see §1).
- `attachment` → run `node ${SKILL_ROOT}/scripts/download-jira-ticket-attachment.js {KEY}` and read every image with the Read tool; note video paths. Skipping attachments causes misdiagnosis.
- Subtasks: fetch each with the same fields. `Done` → skip; `Test` → the item needing attention (developer finished, QA pending); other → context only. If the ticket is itself a subtask, fetch the parent for scope and AC.
- Read comments on parent and subtasks — they carry AC amendments, QA reproduction steps, prior review feedback.
- Subtask lifecycle (IEN board): QA opens subtask → developer fixes and sets `Test` → parent to `Compilation` (some say `Commit`) and asks for review → reviewer moves parent to `In Testing` on commit → QA moves subtasks `Test → Done`. Reviewers never touch `Test` subtasks.
- Atlassian MCP unavailable → tell the user: "Enable the Atlassian MCP server in your editor's MCP settings, restart, and resend the request."

## 5. Do the work

Read the task workflow. For bugfix, feature, and app-task work: **state the plan (root cause or design, files, components) and wait for approval before editing.** Edit the local copy under `${CONTEXTS_DIR}/{slug}-v{version}/`, then push (§6). Re-read the relevant reference before touching each file type (SKILL.md hard rule 3).

## 6. Push changes (write scripts — user confirmation required)

Show what will change (component path + diff or summary) and wait for an explicit yes. Then:

```
Shell: node ${SKILL_ROOT}/scripts/update-app.js {slug} {version} {component-path} {local-file}
required_permissions: ["all"], block_until_ms: 30000
```

| Component path | Sections |
|---|---|
| `module/{name}/{section}` | `api`, `parameters`, `expect`, `interface`, `samples`, `scope` |
| `connection/{name}/{section}` | `api`, `common`, `scopes`, `scope`, `parameters` |
| `rpc/{name}/{section}` | `api`, `parameters` |
| `webhook/{name}/{section}` | `api`, `parameters`, `attach`, `detach` |
| `function/{name}/{section}` | `code`, `test` |
| `endpoint/{name}/{section}` | `api`, `input_parameters`, `output_parameters`, `scope`, `context` (`.md`, PATCHes metadata) |
| `base` · `common` · `groups` | app-level files |

Component lifecycle: `create-component.js {slug} {ver} {module|rpc|webhook|function} {name} {label} [--type= --connection= --crud=]`, `update-component.js {slug} {ver} {type} {name} {json}` (metadata: label, public, connection …), `delete-component.js {slug} {ver} {type} {name}` (irreversible — require explicit approval). Same confirmation rule.

On an **approved** app, pushes land as uncommitted change rows; on a non-approved app they write directly and the forward action is `compile`.

```
node ${SKILL_ROOT}/scripts/commit-changes.js {slug} {ver} commit --message="{KEY} {summary}" [--change-ids=1,2] [--issue=KEY]
node ${SKILL_ROOT}/scripts/commit-changes.js {slug} {ver} compile [--issue=KEY]
node ${SKILL_ROOT}/scripts/commit-changes.js {slug} {ver} rollback --confirm
```

`--message` 1–1000 chars, defaults to all pending changes; `--issue=KEY` chains `post-review-transition.js {KEY} committed`; `--notify` only when the user asks. Commit enqueues a compile. Commit on a non-approved app exits 2 and points to `compile`.

**⛔ Rollback is never self-initiated.** It discards **all** pending changes on the version at once and cannot be undone. Do not run it, propose it as a repair step, or pass `--confirm` on your own reasoning. A returned ticket ("돌려줘" / "returned") is not rollback authorization. After a rollback, re-run `download-app.js`.

## 7. Close out

1. **Developer Notes** (skip for code reviews): ask *"Shall I write Developer Notes to the Jira ticket?"* If yes, write `customfield_10483` via `editJiraIssue` using the ADF table format from [developer-notes-templates.md](../references/developer-notes-templates.md).
2. **Context file** — create or update `${CONTEXTS_DIR}/{slug}-v{version}.md` (template below; keep the `##` headings — the Pinecone chunker splits on them). Add a Work History line, new caveats (with source URL for any vendor-API fact verified), pattern changes.
3. **Pinecone sync** — immediately after the file write, call MCP `upsert_app_context` `{ slug, version }` and, for each ticket worked, `upsert_jira_ticket` `{ ticket_key, slug, version, ticket_type: "bugfix"|"feature"|"review", summary, description, acceptance_criteria?, developer_notes?, review_result? }`. MCP server missing → run `check-setup.js`, show its `mcp-server` fix, tell the user sync was skipped, continue. Transient MCP error → report, suggest retry, continue.
4. **Post-commit sync** — when the user says the changes are committed, re-run `download-app.js` so the local copy matches.
5. When everything is done, recommend context compaction before the next task.

For code reviews, steps 2–3 wait for the disposition gate in `code-review.md`.

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

## Checklist

- [ ] App identified (slug + version, source stated)
- [ ] Code synced (`download-app.js` fresh)
- [ ] Context loaded (file + `search_app_knowledge`)
- [ ] Jira fetched incl. subtasks, comments, attachments (or none attached)
- [ ] Plan approved before editing
- [ ] Pushed only after confirmation; tests run per hard rule 9
- [ ] Closed out: Dev Notes asked · context file · Pinecone · post-commit sync
