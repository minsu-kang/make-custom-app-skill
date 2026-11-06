---
name: make-app-bug-investigation
description: Find the root cause of and fix a bug in a Make custom app (error report, PARSING_ERROR-style failure, wrong output, regression, QA subtask or returned ticket), with or without a ticket. Traces real data, reproduces the bug first, fixes minimally, pushes and closes out. Not for reviewing someone else's changes, new features, or refining a Preparation-status ticket.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/shared/scripts/check-setup.js"*)
---

Plugin root: ${CLAUDE_PLUGIN_ROOT}
If the line above still shows a literal ${...}, the plugin root is the directory
two levels above the folder that contains this SKILL.md.

<!-- hard-rules:start -->
## Hard rules

1. **Vendor API claims need the vendor's docs.** Before stating that an external endpoint supports a parameter, field, header, or response shape, fetch the official docs. Existing app code is not proof. Unverifiable → say so; do not flag or implement on the assumption.
2. **No invented runtime features.** Use only directives, IML functions, and spec properties documented in `<plugin root>/shared/references/` or, in employee mode, present in the `imt-app-runtime` source. Otherwise ask.
3. **Read before you flag or change.** Any `api.imljson` finding → read the matching section of `<plugin root>/shared/references/runtime-reference.md` first. Any label / hint / field change → read `<plugin root>/shared/references/app-ux-best-practices.md` first.
4. **Write scripts need confirmation.** `update-app.js`, `create-component.js`, `update-component.js`, `delete-component.js`, `commit-changes.js` run only after the user has seen the change and approved (`<plugin root>/shared/workflows/push-changes.md`). `run-component.js` is the exception: it runs in one step and only with a connection the user created; in `MODE: public` its first run stops once with a live-run notice, and you add `--accept-live-notice` only after the user agrees (`<plugin root>/shared/workflows/run-live.md`). Dev work ends at the push: `commit-changes.js commit|compile` only on an explicit user instruction, never as a proposed next step; `rollback` only on an explicit rollback request, and a returned review ticket is never rollback authorization (`<plugin root>/shared/workflows/commit-compile.md`). A Make MCP tool that creates, updates, deletes, publishes, or compiles is a write and needs the same confirmation; the exceptions are the connection request that a live run or a module test asks for, which the user authorizes on Make's own page (`<plugin root>/shared/workflows/run-live.md`), and the test scenarios of `<plugin root>/shared/workflows/module-test.md`, which one yes per task covers. Never make an app public or request Make's review of it: the user does both in Make. After a script fails, tell the user before you fall back to an MCP tool.
5. **Review disposition gate.** In a code review, no context-file write, `upsert_*` call, or Jira transition until the user states the disposition (committed / compiled / returned). In `MODE: public` a review of the user's own app has no disposition: record it only after the user says yes (`<plugin root>/shared/workflows/self-review.md`).
6. **Reviewers do not write Developer Notes**; sub-tasks in `Test` status belong to QA, so never transition them.
7. **Developer-facing text** (To Developer messages, Jira comments, Dev Notes) never mentions scripts of this plugin, plugin or context-folder paths, Pinecone, or MCP tools. Speak in SDK / IMLJSON terms.
8. **Stay inside the ticket's AC.** In `MODE: public` the chat request is the ticket: its AC are the goal and criteria from the chat, fixed when the user approves the plan. Anything outside the AC is proposed with a reason, not silently changed.
9. **Function edits ship with tests.** `functions/{name}/code.js` change → update `test.js` and run `test-function.js`. `api.imljson` change outside a review → run `test-component.js`. In `MODE: public`, `test-function.js` runs on the plugin's IML shim (exit 2: a blocked test needs a scenario run), and an `api.imljson` change is tested by a live run for an Endpoint or RPC (`<plugin root>/shared/workflows/run-live.md`) or a test scenario for a module, connection, or webhook (`<plugin root>/shared/workflows/module-test.md`).
10. **Never read `~/.make-custom-app-skill-secrets`** (or paste its contents). Scripts consume it; `check-setup.js` reports what you need to know (mode, zone, and in employee mode the paths and the Jira email) without the tokens. In `MODE: public` the values in `common.imljson` files are masked: never treat a masked value as data, and never ask the user to paste a secret into the chat; the user changes common data in the Make UI.
11. **Todo list before any edit.** Before the first local file write, edit, or write script, create a todo list whose items are the active workflow's `## Checklist`. A shorter stand-in list does not count. Follow that list strictly: mark one item in progress before starting it, finish it before the next, and do not write files for a later item. In a workflow that edits the app, `Plan approved before editing` is one of those items: do not edit the app until it is done (a failing test that reproduces a bug is the one write allowed before it). In `MODE: public` an item that needs an employee-only step stays on the list, marked `n/a (public mode)` with its replacement from the Public mode table of `<plugin root>/shared/workflows/lifecycle.md`. `make-app-setup` has no checklist: it edits no app, only appends the config lines its procedure names, and runs `cleanup-legacy.js --apply` only after the user confirms (`--plan` and `--decline` run without that confirmation).
<!-- hard-rules:end -->

# Make app: bug investigation

Root cause and minimal fix for a bug in a Make custom app, proven by a failing test, pushed with confirmation, and closed out in Jira. In `MODE: public` the proof can be a live run or a test scenario, and close-out is the context file and a summary in the chat.

## First action

Once per conversation, run `node "<plugin root>/shared/scripts/check-setup.js"` (Shell, `required_permissions: ["all"]`).

- Exit 0: continue.
- Exit 1: show its output and stop (no app code, scripts, or MCP calls) until the user has fixed it, then run it again. The setup steps are in the `make-app-setup` skill: in Claude Code call the Skill tool with `make-custom-app:make-app-setup`; in Cursor read `<plugin root>/skills/make-app-setup/SKILL.md` and follow it.
- A line that starts with `LEGACY_INSTALL:` in the output: hand off to `make-app-setup` the same way before the task, and continue the task when that is done or declined.
- A line that starts with `UPDATE_AVAILABLE:` in the output: tell the user once per conversation what it says, including the update commands printed under it, then continue the task.
- A line that starts with `MODE:` in the output: `MODE: public` means the steps that need a Make employee account (Jira ticket, compile, component tests, ownership transfer) are not available, and the Public mode section of `<plugin root>/shared/workflows/lifecycle.md` says what replaces each one: read it before the task workflow and follow it wherever a step differs. `MODE: employee` keeps every step as written.

## Preparation guard

When a Jira ticket is attached (employee mode; in `MODE: public` the request from the chat is the ticket and this guard does not apply), fetch it first (`<plugin root>/shared/workflows/jira-ticket.md`) and read its status before syncing code. If the status is `Preparation` and the user gave no verb, or only a generic one ("look at", "check", "handle", "investigate", "봐줘", "조사해줘"), hand off to `make-app-task-refinement`: in Claude Code call the Skill tool with `make-custom-app:make-app-task-refinement`; in Cursor read `<plugin root>/skills/make-app-task-refinement/SKILL.md` and follow it. An explicit request for this skill's own work keeps this skill.

## Load order

Read now:
- `<plugin root>/shared/workflows/bug-investigation.md`
- `<plugin root>/shared/workflows/lifecycle.md`
- `<plugin root>/shared/workflows/jira-ticket.md` (employee mode, when a Jira ticket is attached)

Read when the work reaches it:
- `<plugin root>/shared/workflows/push-changes.md`: when the fix is ready to push
- `<plugin root>/shared/workflows/run-live.md`: after pushing an Endpoint or RPC fix
- `<plugin root>/shared/workflows/module-test.md`: in `MODE: public`, to reproduce or verify a module bug, after the user's yes
- `<plugin root>/shared/workflows/close-out.md`: when the work is done
- `<plugin root>/shared/workflows/commit-compile.md`: only when the user explicitly asks to commit, compile, or roll back

Look-ups: `<plugin root>/shared/index.md` (component and module tables, quick facts, the reference list, the script folder).
