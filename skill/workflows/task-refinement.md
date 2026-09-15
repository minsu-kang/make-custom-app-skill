<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->

# Task Refinement Workflow

> Read [lifecycle.md](lifecycle.md) first. Read-only investigation of a Jira ticket (typically **Preparation** status): read the ticket, the app, the references, and the vendor API docs; decide feasibility; draft an implementation plan; flag unavoidable breaking changes; optionally create an `Investigation` subtask. No code changes, no write scripts, no Developer Notes. The only Jira write is the optional subtask, after explicit approval.

## Trigger

**Mandatory auto-trigger** — a message containing (1) a Jira URL, (2) an inline app slug (± version), and (3) a ticket whose `status.name === "Preparation"` (verified after the fetch) is always this workflow. No confirmation, no fallback to feature/bugfix, even with a bare verb ("조사해줘", "look into this") or no verb at all.

Also: user asks for refinement / investigation / feasibility ("리파인", "검토해줘", "구현 가능한지 봐줘", "can this be implemented?"); or shares a `Preparation` ticket without a slug (resolve via lifecycle §1).

Status not `Preparation` → warn once: *"The ticket status is `{status}` — task refinement is intended for Preparation. Continue anyway?"* Continue only on explicit yes.

No ticket at all → ask for one; if the user wants a free-form feasibility study, run steps 2–7 and deliver the report in chat only.

## Steps

1. **Fetch the ticket** (lifecycle §4) with the standard fields plus `"parent", "labels", "priority"`. Read Dev Notes for any earlier investigation; note existing subtasks (avoid a duplicate `Investigation`); download and read attachments — UX text and mockups often live only there.
2. **Load app context and code** (lifecycle §2–3). Brand-new app with no slug → skip code; investigate from references + API docs.
3. **Scan the app**: `metadata.json`, `base.imljson` (auth, baseUrl, errors), `common.imljson`, and the most similar existing modules/RPCs for conventions (naming, fields, pagination, hints). List reuse candidates (RPCs, functions, connections).
4. **Re-read the references the AC touches** — feasibility claims from memory are forbidden; each "possible" must point to a reference section or an existing component:

   | AC suggests | Read |
   |---|---|
   | New module / RPC / webhook | parameters-reference, communication-reference, component-patterns-reference |
   | Custom function | custom-functions-reference |
   | Polling trigger | polling-trigger-guide + runtime-reference § Polling Triggers |
   | OAuth / connection change | component-patterns-reference § Connection + security-reference |
   | Pagination / iterate / wrapper | runtime-reference § Response Parsing + § Pagination |
   | UX copy | app-ux-best-practices |

5. **Research the vendor API** (hard rule 1). Primary source: `customfield_10283` or the docs URL in the description. Per endpoint: method + path, auth requirement (existing token? new scope/header?), request shape, response shape (paginated / wrapped / array), rate limit or credit cost, error shape. Docs unreachable → state *"API docs not fetchable from this environment — relying on user-provided info and similar existing modules."*
6. **Decide feasibility** — **Feasible** (runtime + app express the AC fully; list reused components) / **Feasible with constraints** (name each constraint, e.g. cursor vs offset pagination, binary response needs `type: "binary"`) / **Not feasible** (each blocker with the reference section that proves it). Never "should work".
7. **Draft the plan** (Feasible / with constraints): components to create and reuse, endpoint mapping, `api` / `expect` / `interface` skeletons as full JSON, pagination decision, custom functions (name, purpose, signature, size risk), pricing / quota notes, verbatim UX copy from the ticket.
8. **Breaking-change check** (skip only for `issuetype: "App"`). For every modified existing component: expect field removed/renamed (saved settings break), interface field removed/renamed (mappings break), connection schema change (reconnect), module type change (bundle shape), auth flow change, pagination semantics change. Avoidable → state the alternative in the plan. Unavoidable → ⚠️ row in the report.
9. **Emit the report** (format below) in chat.
10. **Ask**: *"Shall I create an **Investigation** subtask on `{KEY}` with this report?"* ("응" / "만들어줘" / "ㅇㅇ" = yes; "아니" / "스킵" = no).
11. **Create the subtask on yes.** Parent = the ticket, or its `parent` if the ticket is itself a sub-task. If an open `Investigation` subtask exists, offer: comment on it (`addCommentToJiraIssue`) / create another / skip. Issue type `Sub-task` (verify with `getJiraProjectIssueTypesMetadata` if unsure). `createJiraIssue({ cloudId, projectKey, issueTypeName: "Sub-task", summary: "Investigation", description: <ADF>, parent: KEY, contentFormat: "adf" })`. Report the new key.
12. **Context** (lifecycle §7 steps 2–3, lightweight): one Work History line `{date} | {KEY} | Refinement | {verdict + plan summary}` and Pinecone sync. Skip when Not feasible with no plan, or when the app has no context file yet.

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
**Spec change:** full post-change content of `installSpec.imljson` / `install.imljson` / `base.imljson` / `common.imljson` as a JSON block.

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
Generic dev steps (spec changes → create components → implement per skeletons → push → admin sets install params per zone). Estimated effort: ~{n} day.
```

**ADF delivery.** Build the body programmatically (a small script) rather than hand-writing JSON — a feature-sized report has 10–15 `expand` nodes. Minimum shape per snippet:

```json
{ "type": "expand", "attrs": { "title": "modules/{name}/api.imljson" },
  "content": [ { "type": "codeBlock", "attrs": { "language": "json" }, "content": [ { "type": "text", "text": "{ ... }" } ] } ] }
```

One `expand` per file. If `createJiraIssue` is unavailable or rejects the body, `POST /rest/api/3/issue` directly with the `jira-email` / `jira-api-token` from the SKILL.md tail. Markdown body (`contentFormat: "markdown"`) only when the report contains zero code blocks.

## Checklist

- [ ] Ticket, subtasks, comments, attachments read; status verified (warned if not Preparation)
- [ ] App scanned; references re-read; vendor API researched with sources
- [ ] Feasibility verdict cited; plan drafted; breaking changes checked
- [ ] Report emitted; subtask question asked
- [ ] Subtask created on approval (duplicate check done); context + Pinecone updated
