# Code Review Workflow

Workflow for AI to fetch uncommitted changes from a Make app and perform a code review. Pair with the static § R TODO template (`rules/make-app-todo-review.mdc`) and the universal TODO discipline (`rules/make-app-todo-rules.mdc`) — the TODO list is created **first**, then this workflow executes inside the matching items.

## Trigger

- User requests a code review (e.g., "code review", "review changes")
- User asks to review changes for a specific app

## Required Inputs

### App slug + version (mandatory)

If neither is provided, ask:

> Please provide the **app slug** and **version** for the code review. Example: `slug: slack`, `version: 4`

If `app-slug` is given but `version` is missing, auto-detect via IPME (see [App Version Auto-Detection](app-context.md#app-version-auto-detection-ipme)). Only ask the user if IPME fails.

### Jira ticket link (recommended)

If no Jira ticket is provided, suggest attaching one:

> If you have a Jira ticket link, please attach it. The ticket's Acceptance Criteria, change list, and comments help provide a more accurate review. Example: `https://make.atlassian.net/browse/IEN-12345`

If the user has no ticket, fall back to § "Review Without Jira Ticket" below.

### Atlassian MCP connection

If a Jira link is attached but MCP tools (`getJiraIssue`, etc.) are unavailable, instruct the user:

> The Atlassian MCP server is not connected. Cursor Settings → MCP → enable Atlassian MCP Server → restart Cursor → re-request the review.

## Steps

### 1. App Detection

Determine the app slug and version per § "Required Inputs". If unclear after IPME, ask the user.

### 2. Load Context (mandatory — before review)

Before fetching code or analyzing changes, load existing knowledge about this app:

1. **Local context file**: read `~/.cursor/make-app-contexts/{slug}-v{version}.md` if it exists — app structure, key patterns, caveats, and **work history** (previous reviews, bugs found, known issues).
2. **Pinecone search**: call `search_app_knowledge` with the app slug and relevant keywords (ticket key, module names, feature area) to find prior context, related fixes, and known caveats from the team.
3. **Evaluate relevance**: detect re-reviews and load previous issues for verification, identify known caveats that may affect current changes, avoid repeating analysis already captured in prior reviews.

Do NOT skip this step. Missing context leads to incomplete reviews (e.g., not catching that a previous review flagged a bug that is still unfixed).

### 3. Fetch Jira ticket details (mandatory when ticket attached)

Call `getJiraIssue` with **all required fields in a single call**: `fields: ["summary", "description", "subtasks", "comment", "status", "attachment", "issuetype", "customfield_10483", "customfield_10283"]`.

- `customfield_10483` = **Developer Notes** — the developer's own explanation of what they changed and why. Read before forming any verdict. Misreading or ignoring leads to flagging intentional decisions as bugs.
- `customfield_10283` = **API Docs URL** — link to the app's API documentation. If present, fetch and cross-reference against code changes.
- `attachment` = **Attachments** — auto-download via `download-jira-ticket-attachment.js` (see `rules/make-app-workflow.mdc` § During Work) and analyze images via the Read tool.

If the ticket has subtasks → fetch them all with the same fields and **filter by status**:

- **Done** → skip (QA-verified already, no review needed)
- **Complete** → review (developer finished, QA pending — this is the subtask that needs review attention)
- **Other** → fetch for context (requirements, scope) but prioritize "Complete"

If the ticket itself is a subtask → fetch the **parent** for full scope and AC.

Read comments on the parent and all subtasks. Comments often contain clarifications or amendments to AC, QA findings with reproduction steps, reviewer feedback from previous rounds, scope changes, developer status updates that change review scope.

#### Assign to reviewer (mandatory — immediately after fetch)

Once the parent and subtasks are fetched (and the reviewable subtask set is determined per the Done / Complete / Other filter above), **immediately assign the parent + every reviewed subtask to the authenticated reviewer via Atlassian MCP** before any code analysis. This makes the review ownership visible in Jira from the start instead of waiting for the post-review disposition transition.

Procedure (all MCP calls — no script):

1. **Resolve `cloudId` once per session** — call `getAccessibleAtlassianResources` if you don't already have it from a prior step. Cache it for the rest of the review.
2. **Resolve reviewer's `accountId` once per session** — read the `jira-email:` line from `~/.cursor/skills/make-custom-app/SKILL.md`, then call:
   ```
   lookupJiraAccountId({ cloudId, searchString: "<reviewer-email>" })
   ```
   Pick the entry whose `emailAddress` exactly matches. Cache the `accountId` for the rest of the review.
3. **Assign each ticket** — for the parent and every reviewable subtask (those in **Complete**; skip **Done** subtasks):
   ```
   editJiraIssue({
     cloudId,
     issueIdOrKey: "<KEY>",
     fields: { assignee: { accountId: "<reviewer-accountId>" } }
   })
   ```
   - Skip when the ticket's `assignee.accountId` (already in the `getJiraIssue` payload) equals the reviewer's accountId — it's already mine, no-op.
   - Skip when `common_jira_fetch` was cancelled (`[CANCELLED: review without Jira ticket ...]`).
4. This is a pre-review action: it touches **only the assignee**, never the status. The status transition still happens later via `post-review-transition.js` after the user gives their disposition.
5. Execute every step as sub-actions **inside** the `common_jira_fetch` TODO item (per Universal Rule 2: no new todos for sub-actions). Do NOT split assignment off into its own todo.

Do NOT proceed to Step 4 until parent + subtasks + comments + Developer Notes have been fetched and analyzed **and assignment has been completed**.

### 4. Identify expected changes

Extract from the parent + subtasks: which modules/components should change, what behavior should be added/modified/fixed, what edge cases the AC mentions, what QA issues the subtasks raised.

### 5. Fetch actual code changes

Both `download-app.js` and `review-changes.js` must be run **every time** a review is requested — including re-reviews. Local code in `make-app-contexts` may be stale, and changes data must always be freshly fetched.

Auto-execute both scripts in order via the Shell tool:

```
Shell tool: node ~/.cursor/skills/make-custom-app/scripts/download-app.js {app-slug} {app-version}
required_permissions: ["all"]
block_until_ms: 120000
```

```
Shell tool: node ~/.cursor/skills/make-custom-app/scripts/review-changes.js {app-slug} {app-version}
required_permissions: ["all"]
block_until_ms: 60000
```

Read the review data after scripts complete:

```
~/.cursor/make-app-contexts/{slug}-v{version}/reviews/latest.json
```

### 6. Filter changes (mandatory)

For each change in `latest.json`, determine whether it is related to the Jira ticket's AC:

- **Related** → include in review (proceed to Step 7)
- **Unrelated** → **exclude entirely.** Do NOT review, analyze, or comment on unrelated changes. They belong to a different ticket or scope.

After filtering: flag any AC items with no corresponding code change. If ALL changes are unrelated → report "No changes found for this ticket's AC."

### 7. Review each related change

**Skip Breaking Changes** in two cases — evaluate before the review:

1. **App-level skip** — if the Jira ticket's `issuetype.name === "App"`, skip Breaking Changes for the entire app (a new app has never been deployed, no user scenarios exist).
2. **Per-change skip** — if a change reported by `review-changes.js` is a **pure new-component creation** (files have `new_value` only, no `old_value`), skip Breaking Changes for that component (it has never been placed in any scenario).

In either case, the review output's Analysis must state:

> Breaking Changes check skipped — new {app | component: `{group}/{item}`} (no existing scenarios).

Modifications to existing components (changes with `old_value`) are still subject to Breaking Changes evaluation.

For each ticket-related change, evaluate against [code-review-criteria.md](../references/code-review-criteria.md):

- **Review Categories**: Breaking (per skip rules above), Bugs, Improvements, Security
- **ES6+ Compliance**: all changed/new code follows ES6+ conventions
- **Code Quality**: design principles, code smells, maintainability
- **Test Coverage**: changed functions must have corresponding `test.js`
- **UX Compliance**: expect/parameters changes follow UX best practices
- **Runtime Verification**: `api.imljson` changes verified against runtime docs
- **Removed Code**: verify necessity before flagging removals as bugs
- **Polling Triggers**: verify order, date filtering, epoch

### Cross-Module Pattern Verification (mandatory)

When flagging a missing feature (e.g., RPC, hint, parameter type, pagination) in one component, **search the entire app for every component using the same field/pattern** before writing the review. Report the **complete list** in a single review item — never one-at-a-time.

Failing this leads to incomplete reviews where the developer fixes one module but misses the same issue in 9 others.

## Review Output Format

```
## Code Review: {App Name} v{Version}
### Jira: {JIRA-KEY} — {ticket summary}

### AC Coverage
| AC Item | Status | Implemented In |
|---|---|---|
| {AC item} | Covered / Missing / Partial | {group/item/code} |

### Per-Change Review

(Only ticket-related changes. Unrelated changes are excluded entirely.)

#### [{#}] {group}/{item}/{code}
- **Mapped AC**: {which AC item}
- **Verdict**: LGTM | Breaking Change | Bug | Improvement Needed
- **Change Summary**: (one line)
- **Analysis**: (old → new, correctness against AC)
- **ES6+ Violations**: (table or "None")
- **Test Coverage**: (missing / gaps / adequate)
- **Suggestions**: (if any)

### Overall Verdict
- LGTM / Changes Requested / Needs Discussion
- {summary of missing AC items or concerns}

### Commit Checklist
Commit message: `{JIRA-KEY}: {concise description}`
- [ ] {group}/{item}/{code}
```

## Developer Message (Changes Requested only)

When the overall verdict is **Changes Requested** (any change has a verdict of Breaking Change, Bug, or Improvement Needed), generate a "To Developer" message — English, professional, concise, ready to copy-paste into Jira / Slack / Teams. Must include **all** issue categories found (logic bugs, breaking changes, ES6+ violations, missing/incomplete tests). Never omit a category even if it was covered in the review output.

```
### To Developer — {JIRA-KEY}

Hi, I reviewed the changes for {JIRA-KEY} ({app-slug} v{version}). Here are items that need attention:

**[{severity}] {group}/{item}/{code}**
- Issue: {clear description}
- Expected: {correct behavior/code}
- Suggestion: {fix}

Once the above items are addressed, please request a re-review. Thanks!
```

Severity: `BREAKING` / `BUG` / `IMPROVEMENT`. Skip this section entirely if LGTM.

## Post-Review Disposition Gate (STRICT)

After delivering the review output (and Developer Message if applicable), ask:

> Did you return the ticket to the developer, or commit the changes?

**Until the user explicitly confirms one of the following, do NOT touch the context file, do NOT call `upsert_app_context` / `upsert_jira_ticket`, do NOT run `post-review-transition.js`:**

- "committed" / "커밋했어" / "커밋완료" — the changes were committed (LGTM path) → `post-review-transition.js {key} committed`
- "returned" / "돌려줬어" / "개발자한테 보냈어" — the ticket was returned to the developer (Changes Requested path) → `post-review-transition.js {key} returned`

These are **post-disposition** actions, not post-review actions. Updating context files mid-review pollutes the knowledge base with results the user has not yet acted on.

Once the user confirms, immediately execute (do NOT wait for the user to ask again):

1. **Context file**: create or update `~/.cursor/make-app-contexts/{slug}-v{version}.md` with verdict + changed files + issues + caveats discovered.
2. **Pinecone sync**: `upsert_app_context` (sync the updated context file) + `upsert_jira_ticket` (for each Jira ticket reviewed, store the review result).
3. **Jira assign + transition** via `post-review-transition.js`:
   - `committed` → assigns to authenticated user (`/myself`) and transitions to "In Testing" (from "Commit" or "Compilation")
   - `returned` → assigns to authenticated user and transitions:
     - "Commit" → "In Progress"
     - "Compilation" → "To Do" (the "Compilation" workflow has no direct "In Progress" transition)
   - The script aborts with a clear message if the ticket's current status is not in the allowed list ("Commit" or "Compilation" by default). Use `--from-status=<name1,name2>` to customize, or `--force` only when the user explicitly opts in.
   - Run for **every** reviewed ticket (parent + reviewed subtasks).

These map to `common_context_update`, `common_upsert_app_context`, `common_upsert_jira_ticket`, `review_transition` in the § R TODO template — they stay `pending` until the disposition `[GATE]` (`review_wait_disposition`) is `completed`.

**Do NOT prompt for Developer Notes (`customfield_10483`)** during a code review, even if write scripts were used (e.g., `update-component.js public=true` to publish modules after LGTM, or `update-app.js` to apply a tiny reviewer-suggested fix). Developer Notes belong to the original implementer, not the reviewer.

## Re-Review

When the developer submits fixes and the user requests a re-review:

1. **Fresh fetch** — re-run `download-app.js` + `review-changes.js`. Never reuse previous `latest.json`.
2. **Previous issues checklist** — load prior issues (from context file or prior conversation) and verify each one:
   - **Fixed** → mark resolved
   - **Not fixed** → flag again with reference to the previous review
   - **Partially fixed** → note what remains
3. **New changes** — check if new changes were introduced beyond the previous review's scope. Review with the same criteria.
4. **Output** — same Review Output Format plus a "Previous Issues Resolution" table:

```
### Previous Issues Resolution
| # | Issue | Status |
|---|---|---|
| 1 | {issue description} | Fixed / Not Fixed / Partial |
```

5. **Post-review** — § "Post-Review Disposition Gate" applies as usual.

Reuse the same 15-item § R TODO list. Do not create a "re-review" template. Do not duplicate items.

## Review Without Jira Ticket

Standard code-quality review using the criteria in [code-review-criteria.md](../references/code-review-criteria.md). Omit the AC Coverage section. The § R TODO template still applies — `common_jira_fetch` and `common_attachments` are cancelled with `[CANCELLED: review without Jira ticket per workflows/code-review.md § "Review Without Jira Ticket"]`.

## Important Rules

- **ALWAYS run both `download-app.js` and `review-changes.js` before every review** — never rely on previously saved local code or `latest.json`. The local code may be stale, and review data must be freshly fetched each time, including re-reviews.
- After review, if fixes are needed, apply them via `update-app.js` (see [App Code Update](app-context.md#app-code-update-push-changes-to-make)) instead of manually editing in the SDK.
- If there are 0 changes: inform the user "No uncommitted changes found."
- Focus the review on **old_value → new_value comparison**. If only `new_value` exists (new component), evaluate quality of `new_value` only.
- If any breaking change is found, the overall verdict must be **Changes Requested**. Exception: skip breaking change evaluation entirely when the Jira ticket type is "App" (new app, not yet deployed — no existing scenarios to break).
- If any bug is found, the overall verdict must be **Changes Requested**.
- If only improvements are found, the overall verdict can be **LGTM (with suggestions)**.
- Do NOT modify local code in `make-app-contexts` after review. Local code sync is the responsibility of `download-app.js`.
