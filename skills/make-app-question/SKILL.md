---
name: make-app-question
description: Answer a question about a Make custom app or open IMLJSON file (structure, how a module works, pagination, expressions, runtime behaviour) from its synced source and the references. Read-only. Default skill for any Make custom app request that is not review, bug, feature, task, endpoint, refinement or live run. Not for changing the app.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/shared/scripts/check-setup.js"*)
---

Plugin root: ${CLAUDE_PLUGIN_ROOT}
If the line above still shows a literal ${...}, the plugin root is the directory
two levels above the folder that contains this SKILL.md.

<!-- hard-rules:start -->
## Hard rules

1. **Vendor API claims need the vendor's docs.** Before stating that an external endpoint supports a parameter, field, header, or response shape, fetch the official docs. Existing app code is not proof. Unverifiable → say so; do not flag or implement on the assumption.
2. **No invented runtime features.** Use only directives, IML functions, and spec properties documented in `<plugin root>/shared/references/` or present in the `imt-app-runtime` source. Otherwise ask.
3. **Read before you flag or change.** Any `api.imljson` finding → read the matching section of `<plugin root>/shared/references/runtime-reference.md` first. Any label / hint / field change → read `<plugin root>/shared/references/app-ux-best-practices.md` first.
4. **Write scripts need confirmation.** `update-app.js`, `create-component.js`, `update-component.js`, `delete-component.js`, `commit-changes.js` run only after the user has seen the change and approved (`<plugin root>/shared/workflows/push-changes.md`). `run-component.js` is the exception: it runs in one step and only with a connection the user created (`<plugin root>/shared/workflows/run-live.md`). Dev work ends at the push: `commit-changes.js commit|compile` only on an explicit user instruction, never as a proposed next step; `rollback` only on an explicit rollback request, and a returned review ticket is never rollback authorization (`<plugin root>/shared/workflows/commit-compile.md`). A Make MCP tool that creates, updates, deletes, publishes, or compiles is a write and needs the same confirmation; the one exception is the connection request that a live run asks for, which the user authorizes on Make's own page (`<plugin root>/shared/workflows/run-live.md`). After a script fails, tell the user before you fall back to an MCP tool.
5. **Review disposition gate.** In a code review, no context-file write, `upsert_*` call, or Jira transition until the user states the disposition (committed / compiled / returned).
6. **Reviewers do not write Developer Notes**; sub-tasks in `Test` status belong to QA, so never transition them.
7. **Developer-facing text** (To Developer messages, Jira comments, Dev Notes) never mentions scripts of this plugin, plugin or context-folder paths, Pinecone, or MCP tools. Speak in SDK / IMLJSON terms.
8. **Stay inside the ticket's AC.** Anything outside it is proposed with a reason, not silently changed.
9. **Function edits ship with tests.** `functions/{name}/code.js` change → update `test.js` and run `test-function.js`. `api.imljson` change outside a review → run `test-component.js`.
10. **Never read `~/.make-custom-app-skill-secrets`** (or paste its contents). Scripts consume it; `check-setup.js` reports what you need to know (paths, Jira email) without the tokens.
11. **Todo list before any edit.** Before the first local file write, edit, or write script, create a todo list whose items are the active workflow's `## Checklist`. A shorter stand-in list does not count. Follow that list strictly: mark one item in progress before starting it, finish it before the next, and do not write files for a later item. In a workflow that edits the app, `Plan approved before editing` is one of those items: do not edit the app until it is done (a failing test that reproduces a bug is the one write allowed before it). `make-app-setup` has no checklist: it edits no app, only appends the config lines its procedure names, and runs `cleanup-legacy.js --apply` only after the user confirms (`--plan` and `--decline` run without that confirmation).
<!-- hard-rules:end -->

# Make app: app question

Answer a question about one Make custom app from its synced source and the references. Read-only. This is the default skill for any Make custom app request that no other `make-app-*` skill covers.

## First action

Once per conversation, run `node "<plugin root>/shared/scripts/check-setup.js"` (Shell, `required_permissions: ["all"]`).

- Exit 0: continue.
- Exit 1: show its output and stop (no app code, scripts, or MCP calls) until the user has fixed it, then run it again. The setup steps are in the `make-app-setup` skill: in Claude Code call the Skill tool with `make-custom-app:make-app-setup`; in Cursor read `<plugin root>/skills/make-app-setup/SKILL.md` and follow it.
- A line that starts with `LEGACY_INSTALL:` in the output: hand off to `make-app-setup` the same way before the task, and continue the task when that is done or declined.
- A line that starts with `UPDATE_AVAILABLE:` in the output: tell the user once per conversation what it says, including the update commands printed under it, then continue the task.

## Load order

Read now:
- `<plugin root>/shared/workflows/app-question.md`
- `<plugin root>/shared/workflows/lifecycle.md` (sections 1 to 3 only)

Look-ups: `<plugin root>/shared/index.md` (component and module tables, quick facts, the reference list, the script folder).
