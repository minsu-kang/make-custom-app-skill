<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# Task Refinement Workflow

Read-only investigation workflow for Jira tickets in **Preparation** status. The agent reads the ticket, scans the target app + relevant references + external API docs, decides feasibility, drafts an implementation plan, highlights any unavoidable breaking changes, and (on user request) creates an `Investigation` subtask on the parent ticket with the full report.

No code changes, no uploads, no write scripts. The only Jira write is the optional `Investigation` subtask via Atlassian MCP `createJiraIssue` — and only after explicit user approval.

Pair with `rules/make-app-todo-refinement.mdc` (§ P · Task Refinement template, 18 items) and the universal TODO discipline (`rules/make-app-todo-rules.mdc`). The TODO list is created **first**, then this workflow executes inside the matching items.

## Trigger

### Mandatory auto-trigger (no confirmation needed)

When **all three** of the following are present in the user's message, this workflow is the **only** valid template. Do not ask the user which workflow to run, do not fall back to § N (Feature) or § B (Bugfix), do not propose any alternative — go straight into the § P TODO template and run this workflow.

1. A Jira ticket URL (e.g., `https://make.atlassian.net/browse/IEN-14737`)
2. An app slug (and optionally a version) provided inline in the message (e.g., `make-ai-web-search, 1` or just `make-ai-web-search`)
3. The ticket's `status.name === "Preparation"` (verified after the first `getJiraIssue` call in `common_jira_fetch`)

Verbs are optional in this case. Even a single Korean word like "조사해줘", "검토해줘", "리파인", "분석해줘", or an English equivalent ("look into this", "investigate", "feasibility") is sufficient when the three signals above are present. The same applies to a bare message that contains only the URL + slug — treat it as a refinement request.

If condition (3) turns out false after `getJiraIssue` (status is not `Preparation`), follow § "Required Inputs" § "Status check" — warn the user once, then continue refinement on explicit "continue".

### Other trigger conditions

Execute this workflow when **any** of the following hold (and the mandatory auto-trigger above did not already match):

- User explicitly asks for "task refinement", "investigation", "feasibility check", or any Korean equivalent ("리파인", "조사해줘", "검토해줘", "구현 가능한지 봐줘")
- User asks "can this be implemented?" / "feasible?" about a Make app feature
- User shares a Jira ticket whose `status.name === "Preparation"` without inline slug/version (workflow still runs; slug/version is resolved per § "Required Inputs")

## Required Inputs

### Jira ticket (mandatory)

Refinement starts from a Jira ticket. If no ticket is attached, ask:

> Task refinement requires a Jira ticket (typically in **Preparation** status). Please attach the ticket link. Example: `https://make.atlassian.net/browse/IEN-14737`

If the user wants a feasibility study against a free-form description with no ticket, fall back to § "Refinement Without Jira Ticket" — no subtask will be created at the end.

### App slug + version

Determine from the ticket summary / description (e.g., "Make AI Web Search: new module" → look up the matching app slug). If only the app name is mentioned without a version, auto-detect via IPME (see `app-context.md` § "App Version Auto-Detection (IPME)"). Only ask the user if IPME fails.

For brand-new app refinement (no slug yet), `common_code_sync` and `refine_app_structure_scan` are cancelled per the universal rule — the investigation runs against references + API docs alone.

### Status check

If the ticket's `status.name` is not `Preparation`, warn the user:

> The ticket status is `{actual status}` — task refinement is intended for **Preparation**. Continue anyway?

Wait for explicit confirmation before continuing. A non-Preparation ticket can still be refined, but the mismatch must never be silent.

### Atlassian MCP connection

If a Jira link is attached but MCP tools (`getJiraIssue`, `createJiraIssue`, etc.) are unavailable, instruct the user to enable the Atlassian MCP server (Cursor Settings → MCP) and restart the editor.

## Steps

### 1. Fetch Ticket + Attachments

Call `getJiraIssue` with `fields: ["summary", "description", "subtasks", "comment", "status", "attachment", "issuetype", "customfield_10483", "customfield_10283", "parent", "labels", "priority"]`.

Read every field:

- **summary / description** — the goal and Acceptance Criteria
- **status** — must be `Preparation` (else warn per § Required Inputs)
- **issuetype** — `Feature` / `Bug` / `Task` / `App` informs the scope of the plan
- **customfield_10283** (API Docs URL) — primary source for endpoint research
- **customfield_10483** (Developer Notes) — read in case a previous investigation already exists
- **subtasks** — existing subtasks (avoid creating duplicate `Investigation`)
- **comment** — clarifications, scope notes, prior discussion
- **attachment** — screenshots / mockups / UI references

Auto-download attachments via `download-jira-ticket-attachment.js <issue-key>` and read images with the Read tool. Required when the AC describes UX or shows screenshots (e.g., a disclaimer text in an image).

### 2. Load App Context

Confirm app slug + version. Load `${CONTEXTS_DIR}/{slug}-v{version}.md` if it exists, and call MCP `search_app_knowledge` with the slug + relevant keywords (ticket key, feature area, module names) — surfaces prior implementation notes, related fixes, and known caveats.

Run `download-app.js` if local code is missing / older than 24h / open file differs (per `app-context.md`). Skip code download only when the ticket targets a brand-new app with no existing slug.

### 3. Scan Existing App Structure

Before researching the new feature, understand what's already there:

- `metadata.json` — full list of existing modules, RPCs, connections, webhooks, functions
- `base.imljson` — auth pattern, baseUrl, error handling, logging conventions
- `common.imljson` — shared encrypted config (API keys, secret names)
- **Similar existing components** — read the most relevant existing modules / RPCs to extract conventions (naming, field structure, pagination shape, error handling, hint style)

Identify reuse candidates: existing RPCs that provide dynamic options the new module needs, existing custom functions that transform similar responses, existing connections the new module can reuse.

### 4. Re-read Relevant References

Refinement decisions hinge on what the runtime actually supports. Re-read (don't rely on memory):

| If the AC suggests | Re-read |
|---|---|
| New module / RPC / webhook | `parameters-reference.md` + `communication-reference.md` + `component-patterns-reference.md` |
| Custom IML function needed | `custom-functions-reference.md` |
| Polling trigger | `polling-trigger-guide.md` + `runtime-reference.md` § "Polling Triggers" |
| OAuth / connection change | `component-patterns-reference.md` § "Connection Pattern" + `security-reference.md` |
| Pagination / iterate / wrapper | `runtime-reference.md` § "Response Parsing" + § "Pagination" |
| UX (labels, hints, ordering) | `app-ux-best-practices.md` |
| Real-world pattern check | `examples.md` |

Memory-based feasibility claims are forbidden — every "yes this is possible" verdict must point to a concrete reference section or an existing component.

### 5. Research the Target API

If `customfield_10283` (API Docs URL) is present, treat it as the primary source. Otherwise extract any API URL mentioned in the description (e.g., `https://docs.firecrawl.dev/api-reference/endpoint/search`).

For each endpoint relevant to the AC, capture:

- HTTP method + path
- Auth requirement (does it use the existing connection's token? new scope? new header?)
- Request body / query params shape
- Response shape (paginated? single object? array? wrapped?)
- Rate limit / pricing hints (the AC may reference a credit cost — note it)
- Error response shape

Use the WebFetch tool only when the docs URL is publicly accessible. If blocked, note "API docs not fetchable from this environment — relying on user-provided info and similar existing modules in the app."

### 6. Decide Feasibility

State one of three verdicts with concrete reasoning:

- **Feasible** — the runtime + existing app structure can express the AC fully. No new runtime feature required. List every reused component.
- **Feasible with constraints** — implementable but with caveats (e.g., the API uses cursor pagination and existing modules use offset; or the API returns binary that requires `type: "binary"` and the existing pattern is JSON). Spell out the constraints.
- **Not feasible** — list every blocker (e.g., the API requires WebSocket; runtime does not expose multipart binary download with progress; an IML function would exceed the size limit). Quote the specific reference section that confirms the blocker.

Never give a vague "should work" — every verdict must be backed by either a reference or an existing-component citation.

### 7. Draft the Implementation Plan (when Feasible / Feasible with constraints)

Outline — do not implement. The plan is the deliverable; no code is written yet.

Include:

1. **Components to create** — table of `type / name / label / purpose`. New module(s), new RPC(s), new function(s), new webhook(s).
2. **Components to reuse** — list existing RPCs / functions / connections that the new components depend on.
3. **API endpoint mapping** — for each new module, the `method` + `url` + auth headers it will hit.
4. **expect skeleton** — bullet list of input fields with `name / type / required / rpc?`. No full IMLJSON — just the shape.
5. **interface skeleton** — bullet list of output fields with `name / type`. Mirror the API response shape.
6. **Pagination / iterate / wrapper plan** — explicit choice + reason.
7. **Custom function needs** — name + purpose + signature (e.g., `transformSearchResults(items) → mapped objects`). State if size will approach the runtime limit.
8. **Test plan outline** — function tests (if any function created), component tests (modules / RPCs that need mockup fixtures), edge cases worth covering.
9. **Pricing / quota notes** — credit cost per call when AC mentions it, runtime overrides needed (`maxRequestCount`, `timeout`).
10. **Disclaimer / UX copy** — for any disclaimer text required by AC, capture the exact wording from the ticket / screenshot.

### 8. Breaking Change Check (mandatory)

Even refinement-only output must flag every unavoidable breaking change the proposed plan introduces.

For each modified existing component, ask:

- Will an existing **expect** field be removed or renamed? → breaks saved scenario settings
- Will an existing **interface** field be removed or renamed? → breaks downstream mappings
- Will the **connection** schema change (new required parameter on an existing connection)? → breaks existing connections
- Will the **module type** change (e.g., Action → Search)? → output shape changes from single bundle to multiple
- Will **auth flow** change (OAuth → API Key, or new mandatory scope)? → users must reconnect
- Will **pagination semantics** change (page-based → cursor-based)? → existing scenarios may double-process or skip records

If a breaking change is **avoidable** (e.g., adding a new field instead of renaming an old one), state the avoidable alternative inside the plan and skip the warning.

If a breaking change is **unavoidable**, highlight it in the output with a ⚠️ marker (see Output Format).

**Skip the entire Breaking Change section** only when the Jira ticket's `issuetype.name === "App"` (brand-new app — no existing scenarios to break).

### 9. Emit the Investigation Report

Use the Output Format below. This is what the user sees and what gets copied into the subtask description if they approve.

### 10. Ask About Subtask Creation

Ask exactly:

> Shall I create an **Investigation** subtask on `{TICKET-KEY}` with this report?

Wait for explicit yes/no. Korean equivalents acceptable ("응", "어", "만들어줘", "ㅇㅇ" → yes; "아니", "괜찮아", "스킵" → no).

### 11. Create the Subtask (on approval)

Pre-checks:

1. The current ticket is the **parent** for the subtask. If the user-provided ticket is itself a sub-task, walk up to its parent (the `parent` field returned by `getJiraIssue`) and use that as the parent for the new `Investigation` subtask.
2. Check existing subtasks from Step 1. If a subtask with summary `Investigation` already exists and is open, ask the user whether to:
   - Add a comment to the existing one (`addCommentToJiraIssue`), or
   - Create a second one anyway, or
   - Skip.
3. Resolve the project's Sub-task issue type name — `Sub-task` in IEN, but verify via `getJiraProjectIssueTypesMetadata` if uncertain.

MCP call:

```
createJiraIssue({
  cloudId: "<resolved-cloudId>",
  projectKey: "<project key, e.g. IEN>",
  issueTypeName: "Sub-task",
  summary: "Investigation",
  description: "<ADF body — see § Subtask Body Format>",
  parent: "<PARENT-TICKET-KEY>",
  contentFormat: "adf"
})
```

Report the new subtask key back to the user (e.g., `Created IEN-14999: Investigation`).

### 12. Update Context (lightweight)

For investigations that produced a concrete plan, append a one-line entry to `${CONTEXTS_DIR}/{slug}-v{version}.md` Work History:

```
| {YYYY-MM-DD} | {TICKET-KEY} | Refinement | {one-line feasibility + plan summary} |
```

Then run Pinecone sync (`upsert_app_context` + `upsert_jira_ticket`) per `pinecone-sync.md`.

Skip the context update when:

- Verdict was **Not feasible** with no actionable plan
- Brand-new app with no context file yet (record in the new context file when the implementation work later starts)

## Output Format

The investigation report has a **fixed structure** designed for Jira readability. Two hard rules:

1. **Tables for structured comparison data** (AC coverage, components list, breaking-change impact, open questions, pricing, UX copy).
2. **Fenced code blocks for skeleton code** — every IMLJSON file you mention (`api.imljson`, `expect.imljson`, `interface.imljson`, `installSpec.imljson`, `install.imljson`) must appear as a full JSON code block. Every custom function must appear as a JavaScript code block. **No bullet-list-of-fields substitute** — Jira's plain-list rendering hides the structure that matters.

Forbidden in refinement reports (do not include even if drafted earlier):

- "References Consulted" section — the investigation report is for the dev audience consuming the ticket, not a citation trail. Internal source references stay in the chat / context file.
- Make-skill internal commands (`update-component.js`, `update-app.js`, `test-component.js`, `download-app.js`, `create-component.js`, `delete-component.js`) — these belong to the implementer's session, not the ticket body. Use generic dev-step language (e.g., "Create new module `generateAnAgentResponse` (typeId 9 Search)", not "run `update-component.js …`").
- "Test Plan" section — test design is implementation territory, not refinement. The implementer writes function/component tests in the § N / § B session.

### Template (markdown — render directly via `contentFormat: "markdown"`)

```markdown
# Task Refinement: {TICKET-KEY} — {ticket summary}

| Field | Value |
|---|---|
| App | `{slug}` v{version} |
| Parent status | `{status}` |
| Parent issuetype | `{issuetype}` |
| Refined by | {reviewer-email} |
| Refinement date | {YYYY-MM-DD} |

---

## Feasibility

**{Feasible | Feasible with constraints | Not feasible}**

{2-4 sentence justification with concrete reference citations or existing-component pointers.}

---

## Acceptance Criteria Coverage

| AC Item | Coverage | Notes |
|---|---|---|
| {AC bullet 1} | Achievable / Constrained / Blocked | {short note} |
| {AC bullet 2} | … | … |

---

## Decisions
(Subsection per decision resolved during refinement. Omit the whole section if no decisions were resolved.)

### D1 — {short title, e.g. "Firecrawl API key storage: app-level installSpec extension"}

{2-4 sentences justifying the chosen path with concrete reference / existing-component citations.}

**Spec change (if applicable):**

`installSpec.imljson` / `install.imljson` / `base.imljson` / `common.imljson` — show the **full file content as it would look after the change** in a fenced JSON block. Do not show inline bullet diffs; full code is mandatory.

```json
{ … }
```

---

## Implementation Plan
(Omit the entire Implementation Plan section when verdict is "Not feasible".)

### New Components

| Type | Name | Label | Type ID | Purpose |
|---|---|---|---|---|
| module | `{name}` | {label} | {typeId} | {one-line purpose} |

### Reused Components

| Component | Reuse Reason |
|---|---|
| `{component path}` | {why reused — 1 line} |

### `api.imljson` skeleton

Full JSON block for each new module / RPC's `api.imljson`. Include `url`, `method`, `headers` (only those that override `base.imljson`), `body`, `response.{type,iterate,limit,output,wrapper,error,pagination,temp,valid}` — only the directives the module actually uses.

```json
{ … }
```

Notes (bullet list, brief): override reasons (URL absolute vs baseUrl, header overrides, error overrides), `iterate` choice rationale, open-question dependencies.

**External API response shape** (only when the external API's response structure isn't obvious — single fenced JSON block, not part of `api.imljson`):

```json
{ … }
```

### `expect.imljson` skeleton

Full JSON array block. Include every field with `name`, `type`, `label`, `required`, `advanced`, `default`, `help`, and nested `spec` (for `array` / `collection`).

```json
[ … ]
```

### `interface.imljson` skeleton

Full JSON array block. Include every output field with `name`, `type`, `label`, and nested `spec` for `array` / `collection` outputs.

```json
[ … ]
```

### Pagination

One short paragraph. State whether pagination applies, the directive used (`condition` + `qs` / `body` rewrite, `iterate.container.last.*`), and the rationale. If not applicable, state "NOT applicable" with the reason (single-request endpoint, max-N per call, no cursor / `has_more`).

### Custom Functions

| Name | Purpose | Signature |
|---|---|---|
| `{functionName}` | {one-line purpose} | `{name}(args) → returnType` |

For each function, append a `functions/{name}/code.js` code block:

```javascript
function {name}(...) { … }
```

### Pricing / Quota
(Omit when AC has no pricing line and no runtime overrides are needed.)

| Item | Value | Note |
|---|---|---|
| Pricing formula (Make) | {e.g. 3 credits per run} | {context} |
| Assumed results per run | {n} | {context} |
| External API base cost | {e.g. 1 credit per result} | {gap absorbed by Make? user?} |
| Approval gate | {e.g. Pricing committee on staging} | {process} |
| Runtime override | {None needed / `common.timeout: …`} | {reason} |

### UX Copy
(Omit when AC has no specific UX text — labels, hints, banners.)

| Field | Copy |
|---|---|
| {field name or banner} | "{verbatim text from ticket}" |

---

## Breaking Changes
(Omit when verdict is "Not feasible" OR when issuetype is "App".)

**None identified.** ← (or table below if any exist)

| Affected Surface | Change | Impact |
|---|---|---|
| {component / file} | {what changes} | {scenario / user impact} |

For unavoidable breaking changes, prefix the row with ⚠️ in the **Affected Surface** column and add a separate "Operational note" paragraph after the table when needed. Non-breaking deployment steps (e.g., "admin must enter new install-param value once") go in the Operational note, not in the table.

---

## Open Questions
(Omit when no questions remain.)

| # | Question | Owner | Blocks |
|---|---|---|---|
| 1 | {question} | {PM email / committee / API provider} | {what is gated on this} |

---

## Next Step

Once Open Questions are answered, this ticket is unblocked for implementation. Use generic dev-step language — **never** mention Make-skill internal commands:

1. Spec changes: {file changes}
2. Create new {component}: `{name}` ({typeId X} {Type})
3. Implement `api.imljson` + `expect.imljson` + `interface.imljson` + `samples.imljson` per skeletons above
4. Add `functions/{name}/` (`code.js`)
5. Push changes to Make platform
6. Admin sets {param} in admin panel per zone (when applicable)

Estimated dev effort: ~{0.5–1 day}.
```

### Subtask body delivery

Default: call `createJiraIssue` (or `editJiraIssue` when revising) with `contentFormat: "markdown"` and pass the template above as the description. Atlassian's renderer handles GFM tables, fenced code blocks (with `json` / `javascript` highlighting), inline code, and standard headers.

Optional ADF: convert to ADF only when the user explicitly requests "ADF" or when the report includes content the markdown renderer can't represent (e.g., a `panel: warning` block for a critical unavoidable breaking change that must stand out above the table). The markdown path covers ~95% of refinement reports — do not over-engineer the default.

## Refinement Without Jira Ticket

When the user wants a feasibility study without a Jira ticket:

- Skip Step 1 (`getJiraIssue`) and Steps 10–11 (no subtask to create).
- Cancel `common_jira_fetch`, `common_attachments`, `refine_status_verify`, `refine_ask_subtask`, `refine_subtask_create`, `common_upsert_jira_ticket` with `[CANCELLED: refinement without Jira ticket per workflows/task-refinement.md § "Refinement Without Jira Ticket"]`.
- Steps 2–9 still run. The investigation report is delivered as a chat message only.

## Important Rules

- **Read-only by default.** This workflow runs no write scripts (`update-app.js`, `update-component.js`, `create-component.js`, `delete-component.js`). The single Jira write is `createJiraIssue` for the subtask — and only after the user explicitly approves.
- **No assumptions about runtime support.** Every feasibility verdict must cite a reference section or an existing component. If neither exists, ask the user before claiming feasibility.
- **Always check existing subtasks.** Do not create a duplicate `Investigation` subtask without telling the user — offer `addCommentToJiraIssue` on the existing subtask instead.
- **Breaking changes are non-negotiable.** Even a small investigation report must flag every unavoidable breaking change. Hidden breaking changes are a top reason features get rejected after implementation.
- **Status mismatch warns, never silently blocks.** A non-Preparation ticket can still be refined — just confirm with the user first.
- **No Developer Notes (`customfield_10483`) write during refinement.** Dev Notes belong to the implementer, not the refinement researcher. If a prior investigation exists in Dev Notes, read it as context but never overwrite it.
