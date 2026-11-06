# Task Refinement Workflow

> Read [lifecycle.md](lifecycle.md) and, when a Jira ticket is attached in employee mode, [jira-ticket.md](jira-ticket.md) first. Read-only investigation of a Jira ticket (typically **Preparation** status): read the ticket, the app, the references, and the vendor API docs; decide feasibility; draft an implementation plan; flag unavoidable breaking changes; optionally create an `Investigation` subtask. No code changes, no write scripts, no Developer Notes. The only Jira write is the optional subtask, after explicit approval. In public mode the chat request is the ticket.

## Trigger

**Mandatory auto-trigger** — a message containing (1) a Jira URL, (2) an inline app slug (± version), and (3) a ticket whose `status.name === "Preparation"` (verified after the fetch) is always this workflow. No confirmation, no fallback to feature/bugfix, even with a bare verb ("조사해줘", "look into this") or no verb at all.

Also: user asks for refinement / investigation / feasibility ("리파인", "검토해줘", "구현 가능한지 봐줘", "can this be implemented?"); or shares a `Preparation` ticket without a slug (resolve via [lifecycle.md](lifecycle.md) §1).

Status not `Preparation` → warn once: *"The ticket status is `{status}` — task refinement is intended for Preparation. Continue anyway?"* Continue only on explicit yes.

No ticket at all → ask for one; if the user wants a free-form feasibility study, run steps 2–7 and deliver the report in chat only. Public mode: never ask for a ticket; run steps 2 to 9 with the request from the chat as the AC, skip steps 1 and 11, ask the public question of step 10 instead of the subtask question, and in step 12 write the Work History line without a key.

## Steps

1. **Fetch the ticket** ([jira-ticket.md](jira-ticket.md)) with the `fields` list of [jira-ticket.md](jira-ticket.md) plus `"parent", "labels", "priority"`. Read Dev Notes for any earlier investigation; note existing subtasks (avoid a duplicate `Investigation`); download and read attachments — UX text and mockups often live only there.
2. **Load app context and code** ([lifecycle.md](lifecycle.md) §2 and §3). Brand-new app with no slug → skip code; investigate from references + API docs.
3. **Scan the app**: `metadata.json`, `base.imljson` (auth, baseUrl, errors), `common.imljson`, and the most similar existing modules/RPCs for conventions (naming, fields, pagination, hints). List reuse candidates (RPCs, functions, connections).
4. **Re-read the references the AC touches** — feasibility claims from memory are forbidden; each "possible" must point to a reference section or an existing component:

   | AC suggests | Read |
   |---|---|
   | New module / RPC / webhook | parameters-reference (selects and RPC options: its `select-and-rpc-options.md` part; interface: its `interface.md` part), communication-reference, component-patterns-reference (webhooks: also its `webhook-pattern.md` part) |
   | Custom function | custom-functions-reference |
   | Polling trigger | polling-trigger-guide + `runtime-reference/polling-triggers.md` |
   | OAuth / connection change | component-patterns-reference § Connection Pattern (+ its `connection-oauth.md` / `connection-aliased.md` parts) + security-reference |
   | Pagination / iterate / wrapper | runtime-reference § Directives (iterate, output, wrapper) + § What each module type returns + § Handling the response + `runtime-reference/pagination.md` |
   | UX copy | app-ux-best-practices |

5. **Research the vendor API** (hard rule 1). Primary source: `customfield_10283` or the docs URL in the description (public mode: the docs URL from the chat; ask when missing). Per endpoint: method + path, auth requirement (existing token? new scope/header?), request shape, response shape (paginated / wrapped / array), rate limit or credit cost, error shape. Docs unreachable → state *"API docs not fetchable from this environment — relying on user-provided info and similar existing modules."*
6. **Decide feasibility** — **Feasible** (runtime + app express the AC fully; list reused components) / **Feasible with constraints** (name each constraint, e.g. cursor vs offset pagination, binary response needs `type: "binary"`) / **Not feasible** (each blocker with the reference section that proves it). Never "should work".
7. **Draft the plan** (Feasible / with constraints): components to create and reuse, endpoint mapping, `api` / `expect` / `interface` skeletons as full JSON, pagination decision, custom functions (name, purpose, signature, size risk), pricing / quota notes, verbatim UX copy from the ticket.
8. **Breaking-change check** (skip only for `issuetype: "App"`) (public mode: for a new app, or when the user says no scenario uses the component). For every modified existing component: expect field removed/renamed (saved settings break), interface field removed/renamed (mappings break), connection schema change (reconnect), module type change (bundle shape), auth flow change, pagination semantics change. Avoidable → state the alternative in the plan. Unavoidable → ⚠️ row in the report.
9. **Emit the report** (format below) in chat.
10. **Ask**: *"Shall I create an **Investigation** subtask on `{KEY}` with this report?"* ("응" / "만들어줘" / "ㅇㅇ" = yes; "아니" / "스킵" = no). Public mode instead: ask whether to save the plan in the context file, or to hand it to make-app-feature-request or make-app-endpoint.
11. **Create the subtask on yes.** Parent = the ticket, or its `parent` if the ticket is itself a sub-task. If an open `Investigation` subtask exists, offer: comment on it (`addCommentToJiraIssue`) / create another / skip. Issue type `Sub-task` (verify with `getJiraProjectIssueTypesMetadata` if unsure). `createJiraIssue({ cloudId, projectKey, issueTypeName: "Sub-task", summary: "Investigation", description: <ADF>, parent: KEY, contentFormat: "adf" })`. Report the new key.
12. **Context** ([close-out.md](close-out.md) steps 2 and 3, lightweight): one Work History line `{date} | {KEY} | Refinement | {verdict + plan summary}` and Pinecone sync. Skip when Not feasible with no plan, or when the app has no context file yet.

## Report format

Four rules: **tables** for structured data (AC coverage, components, breaking changes, open questions, pricing, UX copy); **full fenced code blocks** for every IMLJSON file and function mentioned (no bullet-list substitutes); in the subtask body **every code block sits inside its own ADF `expand`** titled with the file path (e.g. `modules/scrapeAPublicWebsite/api.imljson`); the subtask body is **English only**. Never include a "References Consulted" section, a "Test Plan" section, or any skill script name (hard rule 7).

```markdown
# Task Refinement: {KEY} — {summary}

| Field | Value |
|---|---|
| App | `{slug}` v{version} |
| Parent status | `{status}` |
| Parent issuetype | `{issuetype}` |
| Refined by | {email} |
| Refinement date | {YYYY-MM-DD} |

## Feasibility
**{Feasible | Feasible with constraints | Not feasible}**
{2–4 sentences with reference / existing-component citations.}

## Acceptance Criteria Coverage
| AC Item | Coverage | Notes |
|---|---|---|
| {AC} | Achievable / Constrained / Blocked | {note} |

## Decisions   (omit if none)
### D1 — {title}
{justification}
**Spec change:** full post-change content of `installSpec.imljson` / `install.imljson` / `base.imljson` / `common.imljson` (public mode: `common.imljson` keys only; its values are masked) as a JSON block.

## Implementation Plan   (omit when Not feasible)
### New Components
| Type | Name | Label | Type ID | Purpose |
### Reused Components
| Component | Reuse Reason |
### `api.imljson` skeleton — full JSON per new module/RPC (only the directives it uses) + brief notes; external API response shape as its own JSON block when non-obvious
### `expect.imljson` skeleton — full JSON array (name, type, label, required, advanced, default, help, nested spec)
### `interface.imljson` skeleton — full JSON array
### Pagination — one paragraph: directive used and why, or "NOT applicable" + reason
### Custom Functions
| Name | Purpose | Signature |
+ `functions/{name}/code.js` JavaScript block each
### Pricing / Quota   (omit if none)
| Item | Value | Note |
### UX Copy   (omit if none)
| Field | Copy |

## Breaking Changes   (omit when Not feasible or issuetype App)
**None identified.** — or —
| Affected Surface | Change | Impact |   (⚠️ prefix on unavoidable rows; operational notes as a paragraph below)

## Open Questions   (omit if none)
| # | Question | Owner | Blocks |

## Next Step
Generic dev steps (spec changes → create components → implement per skeletons → push → admin sets install params per zone (public mode: no admin step; the owner keeps app-wide values in common data in the Make UI)). Estimated effort: ~{n} day.
```

Public mode: heading `# Task Refinement: {slug} v{version}, {one-line request}`; rows App, Request (one line), Refinement date; leave out Parent status, Parent issuetype and Refined by.

**ADF delivery.** Build the body programmatically (a small script) rather than hand-writing JSON — a feature-sized report has 10–15 `expand` nodes. Minimum shape per snippet:

```json
{ "type": "expand", "attrs": { "title": "modules/{name}/api.imljson" },
  "content": [ { "type": "codeBlock", "attrs": { "language": "json" }, "content": [ { "type": "text", "text": "{ ... }" } ] } ] }
```

One `expand` per file. If `createJiraIssue` is unavailable or rejects the body, write a small Node script that reads `jira-email` / `jira-api-token` via `<plugin root>/shared/scripts/lib/settings.js` (`loadJiraConfig()`) and `POST`s `/rest/api/3/issue` — do not read the secrets file yourself. Markdown body (`contentFormat: "markdown"`) only when the report contains zero code blocks.

## Checklist

- [ ] App identified (slug + version, source stated), code synced, context loaded (skipped for a brand-new app)
- [ ] Ticket, subtasks, comments, attachments read; status verified (warned if not Preparation) (public mode: request taken from the chat)
- [ ] App scanned; references re-read; vendor API researched with sources
- [ ] Feasibility verdict cited; plan drafted; breaking changes checked
- [ ] Report emitted; subtask question asked (public mode: save or hand-off asked)
- [ ] Subtask created on approval (duplicate check done); context + Pinecone updated (public mode: no subtask)
