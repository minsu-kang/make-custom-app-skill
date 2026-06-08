<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
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

1. **Local context file**: read `${CONTEXTS_DIR}/{slug}-v{version}.md` if it exists — app structure, key patterns, caveats, and **work history** (previous reviews, bugs found, known issues).
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
- **Test** → review (developer finished the subtask fix, QA pending — this is the subtask that needs review attention)
- **Other** → fetch for context (requirements, scope) but prioritize "Test"

> **Subtask status lifecycle (IEN board).** There is no `Complete` status. The flow is: QA creates a subtask and returns it to the developer → developer fixes it and sets the subtask to **`Test`** → once all subtasks are done the developer sets the **parent** ticket to **`Commit`** and requests review → the reviewer (you), on a `committed` disposition, moves the **parent** to **`In Testing`** → QA then tests each subtask directly and moves it **`Test` → `Done`** (verified) or returns it to the developer again. The reviewer never transitions a `Test` subtask — that is QA territory (see § "Post-Review Disposition Gate").

If the ticket itself is a subtask → fetch the **parent** for full scope and AC.

Read comments on the parent and all subtasks. Comments often contain clarifications or amendments to AC, QA findings with reproduction steps, reviewer feedback from previous rounds, scope changes, developer status updates that change review scope.

#### Assign to reviewer (mandatory — immediately after fetch)

Once the parent and subtasks are fetched, **immediately assign the parent ticket to the authenticated reviewer via Atlassian MCP** before any code analysis. This makes the review ownership visible in Jira from the start instead of waiting for the post-review disposition transition.

**Scope: parent ticket only. Never assign sub-tasks.** Sub-tasks (regardless of status — `Test`, `Done`, `In Progress`, anything) stay with their original assignee. Sub-task ownership belongs to the implementer / QA, not the reviewer. Touching the sub-task `assignee` field is forbidden during code review.

Procedure (all MCP calls — no script):

1. **Resolve `cloudId` once per session** — call `getAccessibleAtlassianResources` if you don't already have it from a prior step. Cache it for the rest of the review.
2. **Resolve reviewer's `accountId` once per session** — read the `jira-email:` line from `${SKILL_ROOT}/SKILL.md`, then call:
   ```
   lookupJiraAccountId({ cloudId, searchString: "<reviewer-email>" })
   ```
   Pick the entry whose `emailAddress` exactly matches. Cache the `accountId` for the rest of the review.
3. **Assign the parent ticket only**:
   ```
   editJiraIssue({
     cloudId,
     issueIdOrKey: "<PARENT-KEY>",
     fields: { assignee: { accountId: "<reviewer-accountId>" } }
   })
   ```
   - Skip when the parent's `assignee.accountId` (already in the `getJiraIssue` payload) equals the reviewer's accountId — it's already mine, no-op.
   - Skip when `common_jira_fetch` was cancelled (`[CANCELLED: review without Jira ticket ...]`).
   - Do NOT call `editJiraIssue` with an `assignee` field on any sub-task — even reviewable ones.
4. This is a pre-review action: it touches **only the parent assignee**, never the status, never sub-tasks. The status transition still happens later via `post-review-transition.js` after the user gives their disposition.
5. Execute every step as sub-actions **inside** the `common_jira_fetch` TODO item (per Universal Rule 2: no new todos for sub-actions). Do NOT split assignment off into its own todo.

Do NOT proceed to Step 4 until parent + subtasks + comments + Developer Notes have been fetched and analyzed **and parent assignment has been completed**.

### 4. Identify expected changes

Extract from the parent + subtasks: which modules/components should change, what behavior should be added/modified/fixed, what edge cases the AC mentions, what QA issues the subtasks raised.

### 5. Fetch actual code changes

Both `download-app.js` and `review-changes.js` must be run **every time** a review is requested — including re-reviews. Local code in `make-app-contexts` may be stale, and changes data must always be freshly fetched.

Auto-execute both scripts in order via the Shell tool:

```
Shell tool: node ${SKILL_ROOT}/scripts/download-app.js {app-slug} {app-version}
required_permissions: ["all"]
block_until_ms: 120000
```

```
Shell tool: node ${SKILL_ROOT}/scripts/review-changes.js {app-slug} {app-version}
required_permissions: ["all"]
block_until_ms: 60000
```

Read the review data after scripts complete:

```
${CONTEXTS_DIR}/{slug}-v{version}/reviews/latest.json
```

#### 5a. Interpret `review-changes.js` output — compiled vs uncompiled app (mandatory)

`review-changes.js` lists **uncommitted changes** via `GET /sdk/apps/{slug}/{version}?cols[0]=changes` (`app.changes` = `[{id, group, item, code}]`), then fetches each change's `old_value`/`new_value` via `GET /sdk/apps/{slug}/{version}/changes/{id}`. Crucially, **change-tracking is gated by the `approved` flag**, not by `compile`: a non-approved app writes every SDK edit **directly** to the DB working copy without creating any `apps.change` row, so `app.changes` is always empty for it. (Full mechanism + pipeline: [app-compilation-and-deployment-reference.md](../references/app-compilation-and-deployment-reference.md).)

This makes the meaning of "0 changes" depend entirely on the app's `approved` state. **Before concluding anything from a 0-change result, read `metadata.json` (`approved`) for the app:**

| `metadata.json` state | What `review-changes.js` returns | Correct interpretation |
|---|---|---|
| **Non-approved** — `approved: false` (typical for a brand-new `issuetype: "App"` ticket; usually `compile: false` too) | **Structurally always 0** — edits write straight to `apps.*`, no change rows are ever created, no matter how much was changed | **NOT "nothing to review."** Review the **full app code** (base, connection, every module/RPC/webhook/function, install/installSpec, groups, common) against the ticket AC. On re-reviews, re-read the full current code each round — the developer's fixes ARE the current full state; there is no diff to show. |
| **Approved** — `approved: true` | Real uncommitted changes (delta vs the committed baseline), or 0 if the developer genuinely saved nothing new | Diff-based review on `old_value → new_value`. If 0 here, it genuinely means "No uncommitted changes found." |

**Do not describe a non-approved app's 0-change result as "all committed via SDK" or "no changes to review."** The accurate phrasing is: *"App is not approved (`approved: false`) → SDK edits write directly to the DB, no change rows → reviewing full app code."*

**Jira status nuance**: the canonical pre-review status is **Compilation**; some developers colloquially set **Commit** instead. Both mean "ready for review," and `post-review-transition.js` accepts either (see § "Post-Review Disposition Gate").

### 6. Filter changes (mandatory)

For each change in `latest.json`, determine whether it is related to the Jira ticket's AC:

- **Related** → include in review (proceed to Step 7)
- **Unrelated** → **exclude entirely.** Do NOT review, analyze, or comment on unrelated changes. They belong to a different ticket or scope.

After filtering: flag any AC items with no corresponding code change. If ALL changes are unrelated → report "No changes found for this ticket's AC."

### 7. Review each related change

**Skip Breaking Changes** in three cases — evaluate before the review:

1. **App-level skip** — if the Jira ticket's `issuetype.name === "App"`, skip Breaking Changes for the entire app (a new app has never been deployed, no user scenarios exist).
2. **Per-change skip (no `old_value`)** — if a change reported by `review-changes.js` is a **pure new-component creation** (files have `new_value` only, no `old_value`), skip Breaking Changes for that component (it has never been placed in any scenario).
3. **Per-change skip (`old_value` is the default scaffold template)** — when the SDK creates a new module/RPC, its files are pre-filled with Make's **default scaffold boilerplate** (placeholder `"url": "/users"`, `"iterate": "{{body.users}}"`, the standard scaffold comments like `// Relative to base URL` / `// Query string` / `// Splits array from API response into bundles`, and — for triggers — a default `response.trigger`). `review-changes.js` then reports this boilerplate as the `old_value`, but it is **not a real prior implementation**, so the component is effectively new → skip Breaking Changes. First decide from the **ticket** whether the work is new-component implementation, then confirm by checking whether the `old_value` is the untouched scaffold. The canonical scaffolds are the `model` template app (slug `model`, version 1 — run `download-app.js model 1` to see the current per-type templates under `modules/{Action,ActionCreate,ActionUpdate,ActionDelete,Search,Trigger,InstantTrigger,Responder,Universal,UniversalGraphQL,blank}/`). Recognize a scaffold by markers such as `"url": "/users"` (Search/Trigger) or `"url": "/users/{{parameters.id}}"` (Action), `"iterate": "{{body.users}}"`, `"qs": { "pageSize": 100 }`, the default `response.trigger` (`"id": "{{item.id}}"`, `"date": "{{item.created}}"`, `"order": "desc"`), and the boilerplate comments (`// Relative to base URL`, `// Splits array from API response into bundles`). `blank` is simply `{}`.

**How to verify `old_value` is the scaffold (deterministic):** compare the change's `old_value`, whitespace-/comment-insensitive, against the matching template in [`component-scaffold-templates.md`](../references/component-scaffold-templates.md). A match → untouched template → **new component** (skip the `old_value` diff + skip Breaking). That reference carries every per-type scaffold (module by `typeId`, RPC, webhook, connection) plus the full compare procedure; refresh it with `download-app.js model 1`. If `old_value` keeps scaffold markers with only minor edits and no real logic, still treat it as new. Only when `old_value` is a **genuine implementation** (real endpoints/fields, no scaffold markers) do the full diff + Breaking eval. If genuinely ambiguous, default to running the Breaking eval.

In all cases, the review output's Analysis must state:

> Breaking Changes check skipped — new {app | component: `{group}/{item}`} (no existing scenarios).

Modifications to **real existing components** (changes whose `old_value` is a genuine prior implementation, not the scaffold template) are still subject to Breaking Changes evaluation — including shared components (e.g. `base`, a shared RPC) that a new-component task happens to touch.

**`old_value` comparison rule:** review the `old_value → new_value` diff **only when `old_value` is a real prior implementation**. When `old_value` is the `model` scaffold template, the diff is meaningless — **do not bother comparing against it**; just evaluate the quality of `new_value` on its own. (`new_value` quality is always reviewed; the `old_value` diff is what you skip for scaffold-backed components.)

**Module publish/visibility state is never a finding.** A new module is normally `private: true` or `private: null` in `metadata.json` during implementation/review; the deployer flips it to public in the scenario builder after QA passes. Do NOT flag a new module's `private`/publish/visibility state (`private: true`/`null`) as a Breaking Change, Bug, or Improvement.

For each ticket-related change, evaluate against [code-review-criteria.md](../references/code-review-criteria.md):

- **Review Categories**: Breaking (per skip rules above), Bugs, Improvements, Security
- **ES6+ Compliance**: all changed/new code follows ES6+ conventions
- **Code Quality**: design principles, code smells, maintainability
- **Test Coverage**: changed functions must have corresponding `test.js`
- **UX Compliance**: expect/parameters changes follow UX best practices
- **Runtime Verification**: `api.imljson` changes verified against runtime docs
- **External API Verification**: every claim about the vendor's API surface (endpoint params, body fields, response shape) backed by the official vendor docs — see "Hard Gate — External API Reference Verification" below
- **Removed Code**: verify necessity before flagging removals as bugs
- **Polling Triggers**: verify order, date filtering, epoch

#### Hard Gate — Runtime Reference Read (mandatory before flagging any `api.imljson` issue)

Before flagging **any** Bug / Breaking Change / Improvement on a change whose `code` is `api` (i.e. `api.imljson`), you MUST first `Read` the relevant section(s) of [`references/runtime-reference.md`](../references/runtime-reference.md) that cover the directive in question. Intuition about URL / header / body / response shape is not evidence — the runtime spec is. If the spec confirms the runtime already handles the case you suspected was a bug, **do not flag it**.

Index of must-read sections by directive:

| Directive being flagged | Required reading in `runtime-reference.md` |
|---|---|
| `url`, `baseUrl`, path templates, trailing/leading slash | § "URL Normalization" (slash collapse, trailing slash, baseUrl join, encodeUrl) |
| `qs` / query string | § "URL Normalization" (legacy vs uniform QS encoding, `?→&` rewrite) |
| `headers`, `body`, `type`, `condition` | § "Communication directives" |
| `temp` (request-level or response-level) | § "temp" (two-phase evaluation: `temp` → `response.temp`) |
| `response.output` / `iterate` / `limit` / `wrapper` / `valid` / `error` | § "Response Parsing" + § "Response directives" |
| `pagination` | § "Pagination" |
| `trigger` (id / date / order / type) | § "Polling Triggers" + [`polling-trigger-guide.md`](../references/polling-trigger-guide.md) |
| IML path syntax (`foo[]`, `foo[1]`, `body.results[].field`) | § "IML Variable Path Syntax" (1-based indices, single-item unwrap idiom) |

If `runtime-reference.md` does not cover the directive in question, fall back to the `imt-app-runtime` source per `make-app-workflow.md` § During Work. Never flag based on memory alone.

False-positives this gate prevents (real regressions caught in prior reviews):

- Flagging `https://host/{{parameters.path}}` + leading-slash help text as a double-slash bug (runtime collapses `//` in pathname per § "URL Normalization").
- Flagging a `temp` value consumed in the same request as undefined (two-phase `temp` evaluation per § "temp").
- Flagging `{{body.results[].field}}` as a wrong array-wrap (1-based IML path indices per § "IML Variable Path Syntax").

Failing this gate produces false-positive Bug verdicts and wastes the developer's time. Mark this gate as completed inside `review_analyze` (§ R TODO template) — never as a separate todo.

#### Hard Gate — External API Reference Verification (mandatory before flagging any vendor-API issue)

`runtime-reference.md` covers Make's runtime; it does NOT cover the third-party vendor's contract. Before flagging **any** Bug / Breaking Change / Improvement that depends on a claim about the external API (e.g. *"Endpoint X supports `includes`"*, *"`updateListingInventory` body accepts `readiness_state_on_property`"*, *"this module is missing parameter Y that the vendor exposes"*), you MUST first verify the claim in the vendor's official documentation.

Verification procedure:

1. **Identify the exact endpoint and field/parameter** in question — full path (`GET /v3/application/listings/active` vs `GET /v3/application/shops/{shop_id}/listings/active` are different endpoints with different parameter sets, never assume symmetry).
2. **Fetch the vendor's docs** via `WebFetch` / `WebSearch` against:
   - The vendor's official API reference page (e.g. `https://developer.etsy.com/documentation/reference/...`).
   - The vendor's official tutorials (often the only place new fields are documented before the reference catches up).
   - As secondary sources when the docs page is JS-rendered and unfetchable: published OpenAPI / Swagger spec mirrors on GitHub (e.g. `gordonturner/etsy-open-api-client`, `trusty-codes/etsy-openapi-php`). The most recent vendor tutorial wins on conflict.
3. **Quote the source.** When flagging the issue in the review output (or "To Developer" message), include the doc URL and a short example/quote that proves the claim. Example: *"Etsy [Listings Tutorial](URL) — body sample includes `\"readiness_state_on_property\": [47626760362]` (line 1690 of the rendered page)."*
4. **When the docs cannot be fetched or the claim cannot be confirmed**, do NOT flag it. State to the user instead: *"I couldn't verify {claim} in {vendor}'s docs — please confirm or share the relevant section."*
5. **Existing app code is not proof.** A field already present in `expect.imljson` doesn't mean it's a vendor field — it may be a legacy artifact. Symmetric-looking endpoints (`/listings/active` vs `/shops/{shop_id}/listings/active`) frequently diverge on `includes`, pagination, sort order. Always verify per-endpoint.
6. **Withdraw on contradiction.** If verification proves a claim wrong mid-review, retract it explicitly in the next message and downgrade/upgrade the verdict accordingly.

False-positives this gate prevents (real regressions caught in prior reviews):

- Flagging `listAllactiveListings/api` for missing `includes=Inventory` — Etsy's `findAllListingsActive` (`GET /v3/application/listings/active`) does not accept `includes` at all (verified via Etsy OpenAPI spec). Only the per-shop variant supports it.
- Under-flagging missing `readiness_state_on_property` on `updateInventory` as a low-priority "Improvement" — Etsy Listings Tutorial documents it as a first-class body field, sibling of `price_on_property` / `quantity_on_property` / `sku_on_property`. Correct severity is **Bug** (3-variation listings with property-varying readiness state cannot be updated without it).

Failing this gate produces either false-positive Bug verdicts (waste developer time) or false-negative Bug verdicts (let real bugs through to prod). Mark this gate as completed inside `review_analyze` (§ R TODO template) — never as a separate todo.

After verification, **record the verified fact in `${CONTEXTS_DIR}/{slug}-v{version}.md` § Caveats** with the source URL, so the next session does not re-verify from zero. Pair every recorded fact with a one-line quote or example from the docs.

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

### Commit Checklist (MANDATORY — every verdict, including LGTM)
Commit message: `{JIRA-KEY}: {concise description}`
- [ ] {group}/{item}/{code}
```

### Output Completeness Gate (STRICT — applies to every verdict)

The review output is **incomplete and invalid** without the `### Commit Checklist` block. It is mandatory for **every** verdict — `LGTM`, `LGTM (with suggestions)`, `Changes Requested`, and `Needs Discussion` alike. An LGTM review with no Commit Checklist is a **format violation**, not an acceptable shortcut.

- The Commit Checklist is the **last block of every review output**, emitted immediately after `### Overall Verdict` (and after any suggestions list).
- It always contains: (1) a one-line `Commit message:` in the form `{JIRA-KEY}: {concise description}`, and (2) one `- [ ]` line per reviewed `group/item/code` change.
- **Never end the output at `Overall Verdict` or at the suggestions list.** If you wrote a verdict, you MUST also write the Commit Checklist in the **same message** — do not wait to be asked for it.
- This is independent of the "To Developer" message below: the Developer Message is conditional (Changes Requested only), but the Commit Checklist is **unconditional**.

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

### Audience Rule — No Skill-Repo Commands in Developer Messages

The "To Developer" message is read by developers who **do not use this skill** — they work in the Make Internal App (VS Code extension) and the SDK web UI, not in the local `make-custom-app-skill` toolchain. Anything specific to this skill is noise (or worse, confusing) to them.

**Forbidden in any "To Developer" message** (and equally in any review output that may be copy-pasted into Jira / Slack / Teams):

- Skill scripts: `update-component.js`, `update-app.js`, `create-component.js`, `delete-component.js`, `download-app.js`, `review-changes.js`, `test-component.js`, `test-function.js`, `post-review-transition.js`, `download-jira-ticket-attachment.js`, etc.
- Skill paths: `~/.cursor/skills/make-custom-app/...`, `~/.claude/skills/make-custom-app/...`, `${SKILL_ROOT}`, `${CONTEXTS_DIR}`, `~/.cursor/make-app-contexts/...`, `~/.claude/make-app-contexts/...`.
- Skill-internal references: `Pinecone`, `upsert_app_context`, `upsert_jira_ticket`, `search_app_knowledge`, the `make-app-context` MCP server, `make-apps-mockup`, `${slug}-v${version}.md`.
- Skill-internal flags / invocations: `node {script} ... public=true`, `--debug`, `--format=json`, `--update`, etc.

**Speak in the developer's language instead** — describe the *change* in IMLJSON / SDK terms:

- Don't say *"Run `update-component.js timebuzzer 1 module SearchTiles public=true` to publish."*
  Say *"Set the module to public in the SDK (Module → Visibility → Public)."*
- Don't say *"Add to `expect.imljson`..."* with a path like `~/.cursor/skills/make-custom-app/...`.
  Say *"In `modules/SearchTiles/expect.imljson`, add the following field..."* with the in-app relative path.
- Don't reference `test-component.js` runs.
  Say *"Verify the module returns the expected output for the new parameter."* The developer will use whatever workflow they prefer.

This rule applies to:

- The "To Developer" Markdown block (§ "Developer Message" template above).
- Any quoted "To Developer" snippet appearing in the chat that the user might copy-paste to Jira.
- Any Jira comment / Developer Notes content authored on the developer's behalf.

It does NOT apply to:

- Internal review output (the analysis above the "To Developer" line) — internal commands are fine when the user is the audience.
- Skill-side post-review actions (`post-review-transition.js`, MCP `upsert_*`) — those run silently against the user's local environment and never appear in developer-facing copy.

## Post-Review Disposition Gate (STRICT)

After delivering the review output (and Developer Message if applicable), ask the disposition question — **the verb depends on the app's compilation state** (`metadata.json` `approved`/`compile`, see § 5a):

- **Uncompiled app** (`approved: false` / `compile: false` — e.g. a brand-new `issuetype: "App"`): the forward action is **compile**, not commit. Ask:
  > Did you **compile** the app, or return it to the developer?
- **Compiled app** (`approved: true`): the forward action is **commit**. Ask:
  > Did you return the ticket to the developer, or **commit** the changes?

The two LGTM-path verbs (compile / commit) map to the **same** `post-review-transition.js {key} committed` call — the script transitions `Commit`/`Compilation` → `In Testing` either way. Only the question wording changes, to match what the user actually does (you don't "commit" an app that has never been compiled).

**Until the user explicitly confirms one of the following, do NOT touch the context file, do NOT call `upsert_app_context` / `upsert_jira_ticket`, do NOT run `post-review-transition.js`:**

- LGTM / forward path → `post-review-transition.js {key} committed`. Accepted phrases:
  - Compiled app: "committed" / "커밋했어" / "커밋완료"
  - Uncompiled app: "compiled" / "컴파일했어" / "컴파일완료" / "컴파일할게" / "내가 컴파일할게"
- "returned" / "돌려줬어" / "돌려줌" / "개발자한테 보냈어" — the ticket was returned to the developer (Changes Requested path) → `post-review-transition.js {key} returned`

These are **post-disposition** actions, not post-review actions. Updating context files mid-review pollutes the knowledge base with results the user has not yet acted on.

Once the user confirms, immediately execute (do NOT wait for the user to ask again):

1. **Context file**: create or update `${CONTEXTS_DIR}/{slug}-v{version}.md` with verdict + changed files + issues + caveats discovered.
2. **Pinecone sync**: `upsert_app_context` (sync the updated context file) + `upsert_jira_ticket` (for each Jira ticket reviewed, store the review result).
3. **Jira assign + transition** via `post-review-transition.js`:
   - `committed` → assigns to authenticated user (`/myself`) and transitions to "In Testing" (from "Commit" or "Compilation")
   - `returned` → assigns to authenticated user and transitions:
     - "Commit" → "In Progress"
     - "Compilation" → "To Do" (the "Compilation" workflow has no direct "In Progress" transition)
   - The script aborts with a clear message if the ticket's current status is not in the allowed list ("Commit" or "Compilation" by default). Use `--from-status=<name1,name2>` to customize, or `--force` only when the user explicitly opts in.
   - Run for **every** reviewed ticket (parent + reviewed subtasks).
   - **⛔ Hard Rule — Sub-task "Test" status is QA territory.** If a reviewable sub-task is in `Test` status (not `Commit` / `Compilation`), the script will abort. **Do NOT bypass this** — do not pass `--force`, do not directly call MCP `transitionJiraIssue` to push it to `Done`. The `Test → Done` transition belongs to QA; they will mark it `Done` themselves once verified (or return it to the developer). Skip the sub-task transition silently and move on; report the abort to the user as "skipped (QA territory)". Only override if the user explicitly says "force it" or names the target status.

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
- If `review-changes.js` returns 0 changes: **first check `metadata.json` `approved`/`compile`** (see § 5a). Uncompiled app (`approved: false`/`compile: false`) → 0 is structural, review the **full app code** against the AC (never report "nothing to review"). Compiled app (`approved: true`) with 0 → genuinely "No uncommitted changes found."
- Focus the review on **old_value → new_value comparison** — but only when `old_value` is a real prior implementation. For a **new component** (no `old_value`, OR `old_value` is the `model` scaffold template — see § 7), do NOT compare against `old_value`; evaluate the quality of `new_value` only.
- **Never run Breaking Changes verification on a new component.** Skip the Breaking Changes category entirely for: (a) "App"-type tickets (new app, not yet deployed), and (b) any new component — a change with no `old_value` or whose `old_value` is the `model` scaffold template (see § 7). Breaking Changes apply only to real existing components (genuine prior `old_value`), including shared components a new-component task happens to touch.
- If any breaking change is found (on a real existing component), the overall verdict must be **Changes Requested**.
- If any bug is found, the overall verdict must be **Changes Requested**.
- If only improvements are found, the overall verdict can be **LGTM (with suggestions)**.
- Do NOT modify local code in `make-app-contexts` after review. Local code sync is the responsibility of `download-app.js`.
