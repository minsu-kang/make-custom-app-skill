<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->

# Code Review Workflow

> Read [lifecycle.md](lifecycle.md) first. This file adds only what is review-specific.

## Inputs

- **slug + version** — required. Resolve per lifecycle §1 (inline → App HQ URL → IPME → ask: *"Please provide the app slug and version, e.g. `slug: slack`, `version: 4`."*).
- **Jira ticket** — recommended. Without one, suggest attaching it (AC, change list, comments make the review accurate); if none exists, see § "Without a Jira ticket".
- Load context (lifecycle §3) **before** looking at code — prior reviews may hold unfixed findings.

## Reviewer assignment (parent ticket only)

Right after the ticket fetch (lifecycle §4), assign the **parent** to yourself so ownership is visible in Jira:

1. `getAccessibleAtlassianResources` → `cloudId` (cache for the session).
2. `lookupJiraAccountId({ cloudId, searchString: <jira-email: value from SKILL.md tail> })` → pick the exact email match (cache).
3. `editJiraIssue({ cloudId, issueIdOrKey: PARENT, fields: { assignee: { accountId } } })` — skip when already assigned to you or when there is no ticket.

Never set `assignee` on any sub-task, whatever its status. Status transitions happen only after the disposition (below).

## Fetch changes — every review, including re-reviews

```
node ${SKILL_ROOT}/scripts/download-app.js {slug} {version}      # block_until_ms 120000
node ${SKILL_ROOT}/scripts/review-changes.js {slug} {version}    # block_until_ms 60000
```

Then read `${CONTEXTS_DIR}/{slug}-v{version}/reviews/latest.json` (`changes[]` with `id`, `group`, `item`, `code`, `old_value`, `new_value`). Never reuse a previous `latest.json`; never edit files under `make-app-contexts` after a review — `download-app.js` owns that copy.

### "0 changes" depends on `approved`

Change tracking is gated by `metadata.json` **`approved`**, not `compile` ([app-compilation-and-deployment-reference.md § 3](../references/app-compilation-and-deployment-reference.md)):

| `approved` | `review-changes.js` returns | Do |
|---|---|---|
| `false` (typical for a new `issuetype: "App"`) | Always 0 — SDK edits write straight to the DB, no change rows | **Review the full app code** against the AC (base, connections, every module/RPC/webhook/function, install/installSpec, groups, common). On re-review, re-read the full current code. Never say "nothing to review" or "all committed via SDK". Say: *"App is not approved (`approved: false`) → SDK edits write directly to the DB, no change rows → reviewing full app code."* |
| `true` | Real uncommitted delta (`old_value → new_value`), or 0 | Diff-based review. 0 here genuinely means "No uncommitted changes found." |

Jira pre-review status is canonically `Compilation`; some developers set `Commit`. Both mean "ready for review" and `post-review-transition.js` accepts either.

## Filter to the ticket

For each change decide whether it serves the ticket's AC (parent + subtasks + comments + Developer Notes). Unrelated changes are **excluded entirely** — not reviewed, not mentioned. Then flag AC items with no matching change. If nothing matches: report "No changes found for this ticket's AC."

## Skip rules (decide before reviewing each change)

Breaking Changes are skipped in cases 1–4; case 5 also skips Bugs. State every skip in the change's Analysis: *"Breaking Changes check skipped — new {app | component `{group}/{item}`} (no existing scenarios)."* or *"Breaking/Bug skipped — `{group}/{item}` has no production surface (`private: null` | unused | empty expect)."*

1. **App-level** — `issuetype.name === "App"`: skip Breaking for the whole app (never deployed).
2. **New component, no `old_value`** — files carry `new_value` only.
3. **`old_value` is the SDK scaffold** — a new module/RPC is pre-filled with Make's boilerplate (`"url": "/users"` or `/users/{{parameters.id}}`, `"iterate": "{{body.users}}"`, `"qs": { "pageSize": 100 }`, default `response.trigger` `id:{{item.id}}` / `date:{{item.created}}` / `order:desc`, comments `// Relative to base URL`, `// Splits array from API response into bundles`; `blank` is `{}`). Decide from the ticket that this is new-component work, then confirm deterministically: compare `old_value` (whitespace/comment-insensitive) with the matching template in [component-scaffold-templates.md](../references/component-scaffold-templates.md) (refresh via `download-app.js model 1`). Match, or scaffold markers with only trivial edits → new component: skip Breaking **and** skip the `old_value` diff; judge `new_value` on its own. Ambiguous → run the Breaking evaluation.
4. **Endpoint** — `group === "endpoint"`: SDK Endpoints are not scenario-runnable, so nothing can break. A shared custom function edited for an endpoint can still break modules — evaluate that under its `function/{name}/code` change. Missing `required`/`default` enforcement via MCP is a known platform gap, never a Bug. Details: [endpoints-reference.md](../references/endpoints-reference.md) § review guidance.
5. **No production surface (Breaking and Bugs)** — the only consumers were never deployed (`private: true` / `private: null`, never public) **or** are unused (Investigation / Dev Notes / usage = 0 users, 0 scenarios, or a stub with `expect` and `parameters` both `[]`). The code may still be wrong; it is not a blocker. Do **not** skip when usage exists, even if labelled "(deprecated)" (e.g. `makeSoapApiCall` with 7 users / 3 scenarios). Shared functions: skip only the unused callers. Usage unknown → do not skip. Combined evidence is enough: `private: null` + empty expect/parameters + Dev Notes "skipped" (IEN-14893 `generateAccountReport`).

Real existing components modified by the same ticket (`base`, a shared RPC, …) still get the full diff + Breaking evaluation unless #5 applies. A new module's `private`/publish state is **never** a finding — the deployer flips it after QA.

## Review each related change

Evaluate against [code-review-criteria.md](../references/code-review-criteria.md): Breaking (per skips) · Bugs · Improvements · Security · ES6+ · Code quality / smells · Test coverage (`test.js` for every changed function) · UX (expect/parameters vs best practices) · Runtime behaviour · External API · Removed code (verify necessity before calling a removal a bug) · Polling triggers (order, date filter, epoch).

### Gate — runtime reference before any `api.imljson` finding

Read the section of [runtime-reference.md](../references/runtime-reference.md) that covers the directive **before** flagging Bug / Breaking / Improvement on a `code === "api"` change. Intuition is not evidence.

| Directive | Section |
|---|---|
| `url`, `baseUrl`, path templates, slashes, `qs` | URL Normalization |
| `headers`, `body`, `type`, `condition` | Communication directives |
| `temp` (request or response level) | temp (two-phase evaluation) |
| `response.output` / `iterate` / `limit` / `wrapper` / `valid` / `error` | Response Parsing + Response directives |
| `pagination` | Pagination |
| `trigger` | Polling Triggers + [polling-trigger-guide.md](../references/polling-trigger-guide.md) |
| IML paths (`foo[]`, `foo[1]`, `body.results[].field`) | IML Variable Path Syntax (1-based) |
| `endpoint`, `input`, `pagination.endpoint`, `response.unwrap` | Inline Endpoint Calls (static references) + endpoints-reference.md |
| `{{internal.*}}`, `flags.exposeInternalProperties` | Make-Infrastructure Data |

Not covered there → read the `imt-app-runtime` source. Known false positives this prevents: double-slash "bug" (runtime collapses `//`), `temp` "undefined in same request" (two-phase), `body.results[].field` "wrong array wrap" (1-based unwrap).

### Gate — vendor docs before any external-API finding

Before flagging anything that rests on a claim about the third-party API ("endpoint X supports `includes`", "body accepts field Y", "module is missing parameter Z the vendor exposes"):

1. Pin the exact endpoint — `/listings/active` and `/shops/{id}/listings/active` are different endpoints; never assume symmetry.
2. `WebFetch` / `WebSearch` the vendor's official reference or tutorial. If the page is JS-rendered, use a published OpenAPI mirror as secondary source; the newest official tutorial wins on conflict.
3. Quote the source (URL + one line) in the finding.
4. Cannot verify → do not flag; tell the user *"I couldn't verify {claim} in {vendor}'s docs — please confirm."*
5. Existing app code is not proof (legacy fields exist). Verification contradicts an earlier statement → retract it explicitly.
6. Record the verified fact with its URL in the context file § Caveats at close-out.

### Cross-module check

When a finding is "missing X" (RPC, hint, type, pagination …) in one component, search the whole app for every component with the same pattern and report the complete list in **one** item.

## Output format

```
## Code Review: {App Name} v{Version}
### Jira: {JIRA-KEY} — {ticket summary}

### AC Coverage
| AC Item | Status | Implemented In |
|---|---|---|
| {AC item} | Covered / Missing / Partial | {group/item/code} |

### Per-Change Review
(Only ticket-related changes.)

#### [{#}] {group}/{item}/{code}
- **Mapped AC**: {AC item}
- **Verdict**: LGTM | Breaking Change | Bug | Improvement Needed
- **Change Summary**: (one line)
- **Analysis**: (old → new, correctness against AC, skip statements)
- **ES6+ Violations**: (table or "None")
- **Test Coverage**: (missing / gaps / adequate)
- **Suggestions**: (if any)

### Overall Verdict
- LGTM / LGTM (with suggestions) / Changes Requested / Needs Discussion
- {missing AC items or concerns}

### Commit Checklist
Commit message: `{JIRA-KEY}: {concise description}`
- [ ] {group}/{item}/{code}
```

- The **Commit Checklist is mandatory for every verdict, LGTM included**, and is the last block of the same message. An output that stops at Overall Verdict is invalid.
- Verdict rules: any Breaking Change on a production-surface component → Changes Requested; any Bug (after skip #5) → Changes Requested; improvements only → LGTM (with suggestions).
- Re-review: add a `### Previous Issues Resolution` table (`# | Issue | Fixed / Not Fixed / Partial`) before Overall Verdict, and review new changes with the same criteria.
- Without a Jira ticket: omit AC Coverage; standard quality review.

## Developer message (Changes Requested only)

```
### To Developer — {JIRA-KEY}

Hi, I reviewed the changes for {JIRA-KEY} ({app-slug} v{version}). Here are items that need attention:

**[{BREAKING|BUG|IMPROVEMENT}] {group}/{item}/{code}**
- Issue: {clear description}
- Expected: {correct behavior/code}
- Suggestion: {fix}

Once the above items are addressed, please request a re-review. Thanks!
```

Include every category found (logic, breaking, ES6+, tests). Audience: developers working in the SDK / VS Code extension, so — per hard rule 7 — no skill scripts, no `${SKILL_ROOT}` / `make-app-contexts` paths, no Pinecone / MCP / mockup terms, no `--flags`. Say *"Set the module to public in the SDK (Module → Visibility → Public)"*, not *"run `update-component.js … public=true`"*; cite in-app paths like `modules/SearchTiles/expect.imljson`. The same applies to any Jira comment or Dev Notes text you draft.

## Disposition gate

After the output (and developer message), ask — wording by compilation state:

- `approved: false` → *"Did you **compile** the app, or return it to the developer?"*
- `approved: true` → *"Did you return the ticket to the developer, or **commit** the changes?"*

Until the user answers, **no** context-file write, **no** `upsert_*`, **no** `post-review-transition.js`. Accepted answers:

- Forward, past tense — "committed" / "커밋했어" / "커밋완료" / "compiled" / "컴파일했어" / "컴파일완료": the user did it in the SDK. Run `post-review-transition.js {KEY} committed` (`Commit`/`Compilation` → `In Testing`), then lifecycle §7 steps 2–3.
- Forward, imperative — "커밋해줘" / "commit it" / "컴파일해줘" / "compile it": the request **is** the disposition. Show the pending change list and the Commit Checklist message, get confirmation, then run `commit-changes.js {slug} {ver} commit --message="{KEY} {summary}" --issue={KEY}` (approved app) or `commit-changes.js {slug} {ver} compile --issue={KEY}` (non-approved). `--issue` chains the parent transition — do not call `post-review-transition.js` again for the parent. Never pass `--notify` unasked; never run `rollback` here.
- Returned — "returned" / "돌려줬어" / "돌려줌" / "개발자한테 보냈어": `post-review-transition.js {KEY} returned` (`Commit` → `In Progress`; `Compilation` → `To Do`), then lifecycle §7 steps 2–3 with the review result.

Run the transition for every reviewed ticket (parent + reviewed subtasks). The script aborts when the status is not `Commit`/`Compilation`; `--from-status=` customizes, `--force` only on explicit user request. **Sub-tasks in `Test` are QA territory**: when the script aborts on one, report "skipped (QA territory)" and move on — never `--force`, never `transitionJiraIssue` to `Done`.

Do not prompt for Developer Notes in a review, even if you ran a write script (e.g. publishing modules after LGTM).

## Checklist

- [ ] Context loaded; ticket + subtasks + comments + attachments read; parent assigned to me
- [ ] `download-app.js` + `review-changes.js` run fresh; `approved` state read
- [ ] Changes filtered to the AC; skip rules decided per change
- [ ] Runtime-reference gate and vendor-docs gate satisfied for every finding
- [ ] Cross-module check done for every "missing X"
- [ ] Output emitted with Commit Checklist (+ To Developer if Changes Requested)
- [ ] Disposition asked and answered before any context / Pinecone / Jira write
- [ ] Transition run; context file + Pinecone updated; caveats recorded with sources
