---
name: make-app-setup
description: Diagnose and fix local setup for the Make custom app tools (Make API key, Jira token, imt-app-runtime path, team id, MCP servers, and leftovers of an old 2.x install). Use when check-setup reports a missing item or the user asks to set up or fix credentials. Not for app work; never reads the secrets file.
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
4. **Write scripts need confirmation.** `update-app.js`, `create-component.js`, `update-component.js`, `delete-component.js`, `commit-changes.js` run only after the user has seen the change and approved (`<plugin root>/shared/workflows/push-changes.md`). `run-component.js` is the exception: it runs in one step and only with a connection the user created (`<plugin root>/shared/workflows/run-live.md`). Dev work ends at the push: `commit-changes.js commit|compile` only on an explicit user instruction, never as a proposed next step; `rollback` only on an explicit rollback request, and a returned review ticket is never rollback authorization (`<plugin root>/shared/workflows/commit-compile.md`). A Make MCP tool that creates, updates, deletes, publishes, or compiles is a write and needs the same confirmation. After a script fails, tell the user before you fall back to an MCP tool.
5. **Review disposition gate.** In a code review, no context-file write, `upsert_*` call, or Jira transition until the user states the disposition (committed / compiled / returned).
6. **Reviewers do not write Developer Notes**; sub-tasks in `Test` status belong to QA, so never transition them.
7. **Developer-facing text** (To Developer messages, Jira comments, Dev Notes) never mentions scripts of this plugin, plugin or context-folder paths, Pinecone, or MCP tools. Speak in SDK / IMLJSON terms.
8. **Stay inside the ticket's AC.** Anything outside it is proposed with a reason, not silently changed.
9. **Function edits ship with tests.** `functions/{name}/code.js` change → update `test.js` and run `test-function.js`. `api.imljson` change outside a review → run `test-component.js`.
10. **Never read `~/.make-custom-app-skill-secrets`** (or paste its contents). Scripts consume it; `check-setup.js` reports what you need to know (paths, Jira email) without the tokens.
11. **Todo list before any edit.** Before the first local file write, edit, or write script, create a todo list whose items are the active workflow's `## Checklist`. A shorter stand-in list does not count. Follow that list strictly: mark one item in progress before starting it, finish it before the next, and do not write files for a later item. `Plan approved before editing` is one of those items: do not edit the app until it is done (a failing test that reproduces a bug is written first). `make-app-setup` makes no edits and has no checklist.
<!-- hard-rules:end -->

# Make app: setup

Diagnose and fix the local setup of the Make custom app tools. It makes no edit to any app.

## Procedure

1. Run `node "<plugin root>/shared/scripts/check-setup.js"` (Shell, `required_permissions: ["all"]`). It checks `imt-app-runtime-path`, the Make API credentials, the `@make.com` Atlassian account behind the Jira token, and the optional mockup path, team id and MCP keys, and it prints the fix for anything missing. User config (paths, API keys, Jira credentials) lives in `~/.make-custom-app-skill-secrets`; scripts read it, you never do.
2. Exit 0: report that the setup is complete, with any OPTIONAL items and `LEGACY_INSTALL:` lines it printed.
3. Exit 1: show the output and stop (no app code, scripts, or MCP calls) until it is fixed, then run it again.
   - A `make account` refusal for a non-`@make.com` account is final: offer no workaround. Other `make account` failures follow their printed fix.
   - For MISSING config only, tell the user to run the printed `setup-secrets.js` command in their own terminal, never run it yourself (it is interactive and writes secrets).
   - Exception: to add a config line that check-setup reports as not set, append it with Bash (`printf '\n%s\n' 'key: value' >> ~/.make-custom-app-skill-secrets`; the last match wins). This includes `editor: claude` or `editor: cursor` when the output says the editor cannot be told. Never Read, Edit, or Write that file.
4. MCP servers: the plugin ships three, `make-app-context` (it needs the Pinecone and OpenAI keys that `setup-secrets.js` saves), `make`, and `atlassian`. check-setup cannot see whether they are registered. When an MCP tool is missing or asks to sign in, ask the user to sign in through `/mcp` in Claude Code, or to enable the server in the MCP settings of Cursor.
5. Leftovers of an old 2.x install: when the output has `LEGACY_INSTALL:` lines, show them to the user. Removing them comes with the migration release; delete nothing yet.
