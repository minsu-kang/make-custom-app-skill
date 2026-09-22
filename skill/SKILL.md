---
name: make-custom-app
version: 2.1.5
description: Build and edit Make.com custom app IMLJSON code. Use when working with Make Internal App extension, editing IMLJSON files, creating modules, connections, RPCs, webhooks, or any Make custom app development. Triggers on imljson files, Make app references, or IML expressions.
---

# Make Custom App Development

Skill for writing, reviewing, and maintaining Make.com custom apps (IMLJSON, Make Apps SDK). Docs: https://developers.make.com/custom-apps-documentation

Path variables: `${SKILL_ROOT}` = `~/.cursor/skills/make-custom-app` (Cursor) or `~/.claude/skills/make-custom-app` (Claude Code); `${CONTEXTS_DIR}` = the sibling `make-app-contexts` directory.

## First action — once per conversation

Run `node ${SKILL_ROOT}/scripts/check-setup.js` (Shell, `required_permissions: ["all"]`). It checks the skill version (auto-updates when outdated), `imt-app-runtime-path`, Make API credentials, and optional mockup / Jira / MCP setup, and prints the fix for anything missing. User config (paths, API keys, Jira credentials) lives in `~/.make-custom-app-skill-secrets`; scripts read it, you never do.

- Exit `0` → continue. Exit `3` → skill was just updated; re-read this file, then continue.
- Exit `1` → show its output and **stop**: no app code, scripts, or MCP calls until the required items are fixed. Tell the user to run `node ${SKILL_ROOT}/scripts/setup-secrets.js` **in their own terminal** — do not run that wizard yourself (it is interactive and writes secrets). Only exception: the user is asking you to add or fix one of those config lines — then edit `~/.make-custom-app-skill-secrets` with the single line they gave you, without reading the rest of the file.

## Workflows

Read [workflows/lifecycle.md](workflows/lifecycle.md) first for every task (app identification, code sync, Jira fetch, write-script confirmation, close-out), then the task workflow:

| Trigger | Workflow |
|---|---|
| Code review requested | [code-review.md](workflows/code-review.md) |
| Bug report, error, QA subtask, regression | [bug-investigation.md](workflows/bug-investigation.md) |
| New module / RPC / webhook / connection / function / app | [feature-request.md](workflows/feature-request.md) |
| Refactor, UX or metadata change, deprecation, cleanup | [app-task.md](workflows/app-task.md) |
| SDK Endpoint create / update | [create-endpoint.md](workflows/create-endpoint.md) |
| `Preparation`-status ticket, feasibility, task refinement (Jira URL + app slug + `Preparation` → always this, no confirmation) | [task-refinement.md](workflows/task-refinement.md) |
| Question about one app, or open file under `sdk/apps/` | lifecycle.md §1–3, then answer |

## Hard rules

1. **Vendor API claims need the vendor's docs.** Before stating that an external endpoint supports a parameter, field, header, or response shape, fetch the official docs. Existing app code is not proof. Unverifiable → say so; do not flag or implement on the assumption.
2. **No invented runtime features.** Use only directives, IML functions, and spec properties documented in `references/` or present in the `imt-app-runtime` source. Otherwise ask.
3. **Read before you flag or change.** Any `api.imljson` finding → read the matching [runtime-reference.md](references/runtime-reference.md) section first. Any label / hint / field change → read [app-ux-best-practices.md](references/app-ux-best-practices.md) first.
4. **Write scripts need confirmation.** `update-app.js`, `create-component.js`, `update-component.js`, `delete-component.js`, `commit-changes.js` run only after the user has seen the change and approved. `commit-changes.js rollback` discards every pending change and runs only on an explicit rollback request — a returned review ticket is never rollback authorization.
5. **Review disposition gate.** In a code review, no context-file write, `upsert_*` call, or Jira transition until the user states the disposition (committed / compiled / returned).
6. **Reviewers do not write Developer Notes**; sub-tasks in `Test` status belong to QA — never transition them.
7. **Developer-facing text** (To Developer messages, Jira comments, Dev Notes) never mentions skill scripts, skill paths, Pinecone, or MCP tools. Speak in SDK / IMLJSON terms.
8. **Stay inside the ticket's AC.** Anything outside it is proposed with a reason, not silently changed.
9. **Function edits ship with tests.** `functions/{name}/code.js` change → update `test.js` + run `test-function.js`. `api.imljson` change outside a review → run `test-component.js`.
10. **Never read `~/.make-custom-app-skill-secrets`** (or paste its contents). Scripts consume it; `check-setup.js` reports what you need to know (paths, Jira email) without the tokens.

## App components

| Component | Files | Notes |
|---|---|---|
| Base | `base.imljson` | Inherited by modules and RPCs only (not connections / webhooks) |
| Common | `common.imljson` | Encrypted shared data; static content locked after approval, `installSpec` values stay admin-editable |
| Connection | `api`, `parameters` | OAuth2 / OAuth1 / JWT / API key / Basic |
| Module | `api`, `parameters`, `expect`, `interface`, `samples` | Execution unit |
| RPC | `api`, `parameters` | Dynamic options / fields |
| Webhook | `api` | Owns the connection for Instant Trigger modules |
| Endpoint | `api`, `input_parameters`, `output_parameters`, `scope`, `context.md` | AI-callable single call, not scenario-runnable — [endpoints-reference.md](references/endpoints-reference.md) |

## Module types

| type_id | Type | Use |
|---|---|---|
| 1 | Trigger (polling) | Periodic new-item check; static params only; `response.trigger` (`id`/`date`/`type`/`order`) |
| 4 | Action | Exactly one bundle (create / get / update / delete) — `iterate` does not multiply output |
| 9 | Search | Zero or more bundles; needs `response.iterate` + `response.limit: "{{parameters.limit}}"` + expect `limit` (`uinteger`, default 10) |
| 10 | Instant Trigger | Webhook-fed; communication optional |
| 11 | Responder | Returns the webhook response |
| 12 | Universal | Generic call with CRUD hint |

Quick facts: IMLJSON allows `//` comments · IML indices are 1-based (`foo[]` = `foo[1]`; `{{body.results[].field}}` unwraps a single-item array) · triggers cannot map values · `approved` = compiled, not "in production".

## References — read when …

- [runtime-reference.md](references/runtime-reference.md) — writing/reviewing `api.imljson`: directives, URL/QS normalization, `temp`, pagination, triggers, `api.endpoint`, `environment`/`internal`, limits
- [communication-reference.md](references/communication-reference.md) — request/response spec, pagination, RPC, file upload/download patterns
- [component-patterns-reference.md](references/component-patterns-reference.md) — base, connections per auth type, install params, errors, webhook, trigger, responder
- [parameters-reference.md](references/parameters-reference.md) — any `expect` / `parameters` / `interface` edit
- [builtin-iml-functions.md](references/builtin-iml-functions.md) — verifying a `{{ }}` function exists; runtime extras, `errorFactory` types
- [custom-functions-reference.md](references/custom-functions-reference.md) — `functions/*/code.js` + `test.js` conventions
- [app-ux-best-practices.md](references/app-ux-best-practices.md) — labels, hints, fields, messages, ordering
- [polling-trigger-guide.md](references/polling-trigger-guide.md) — type-1 trigger order / date filtering / epoch
- [component-test-guide.md](references/component-test-guide.md) — `test-component.js` mocks and debugging
- [code-review-criteria.md](references/code-review-criteria.md) — review categories, out-of-scope list, ES6+, tests, UX, runtime false positives
- [code-smells-reference.md](references/code-smells-reference.md) — quality thresholds
- [security-reference.md](references/security-reference.md) — credentials, OAuth, signatures, SSRF, data exposure
- [app-compilation-and-deployment-reference.md](references/app-compilation-and-deployment-reference.md) — `approved`/`compile`/changes, visibility flags, admin endpoints, IPM pipeline
- [component-scaffold-templates.md](references/component-scaffold-templates.md) — is a review `old_value` untouched SDK boilerplate?
- [endpoints-reference.md](references/endpoints-reference.md) — SDK Endpoints entity, admin API, schemas, review guidance
- [developer-notes-templates.md](references/developer-notes-templates.md) — Jira Developer Notes (bugfix / feature)
- [examples.md](references/examples.md) — full real-app example

## Scripts (`${SKILL_ROOT}/scripts/`)

`check-setup.js` · `setup-secrets.js` (user terminal only) · `download-app.js {slug} {ver}` · `review-changes.js {slug} {ver}` → `reviews/latest.json` · `update-app.js` · `create-component.js` / `update-component.js` / `delete-component.js` · `commit-changes.js {slug} {ver} commit|rollback|compile` · `test-function.js` / `test-component.js` · `download-jira-ticket-attachment.js {key}` · `post-review-transition.js {key} committed|returned`. Usage details are in the workflows.

<!-- User config (imt-app-runtime-path, make-api-key, make-apps-mockup-path, jira-email, jira-api-token, mcp-server-path …) lives in ~/.make-custom-app-skill-secrets, never in this file. Run scripts/setup-secrets.js in a terminal to fill it; scripts/check-setup.js reports what is still missing. -->
