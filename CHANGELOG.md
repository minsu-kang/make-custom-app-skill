# Changelog

## 3.0.2 — 2026-11-04

- **Internal links removed.** References, workflows, script comments and test inputs no longer link to Make's internal Jira, Confluence, Slack, Figma or private GitHub pages, and no longer name internal ticket keys. The facts next to them stay. A few blocks of copied runtime code are described in prose instead. The full app example in `examples.md` uses fictional names. Releases before 2.4.0 are no longer listed here.
- No change in how the skills, scripts or MCP server behave. The maintainer trigger test (`tools/trigger-test/`) now loads an org plugin only when `--org` names one.

## 3.0.1 — 2026-11-03

The repository moved from `minsu-kang/make-custom-app-skill` to `minsu-kang/make-app-ai-plugin`. Plugin installs keep working: GitHub redirects the old address for git and raw files.

- **New address.** The README install command, the `homepage` and `repository` fields of both manifests, the update notice (the version check and the Cursor update link), and the installer shim drafts in `tools/shims/` use `https://github.com/minsu-kang/make-app-ai-plugin`.
- **Unchanged.** The marketplace and the plugin id stay `make-custom-app@make-custom-app`. A marketplace added with the old address keeps updating through the redirect; the README says to skip the `marketplace add` command in that case.

## 2.4.2 — 2026-11-04

- **Internal links removed from the 2.x skill.** The same change as plugin 3.0.2, in `skill/references`, `skill/workflows` and `skill/scripts`. `old-tree-guard.js` allows changes and deletions of non-bridge files in these folders for the 2.4.2 release only.

## 2.4.1 — 2026-11-03

- **Installers fixed after the repository rename.** GitHub now names the archive folder `make-app-ai-plugin-master`, so the four installers stopped finding `skill/SKILL.md` when run through `curl` or `irm` ("Archive layout unexpected"), and every auto-update failed after it had removed the old skill folder. The installers now download from `minsu-kang/make-app-ai-plugin`. `old-tree-guard.js` allows the four installers as bridge files.
- **Migration script.** `migrate-to-plugin.js` adds the marketplace from the new address, `https://github.com/minsu-kang/make-app-ai-plugin.git`.
- **Unchanged.** The update check and `version.json` keep the old raw address, which GitHub still serves.

## 3.0.0 — 2026-11-02

The make-custom-app skill becomes one plugin for Claude Code and Cursor.

- **Nine task skills.** `skills/make-app-*` replace the single `make-custom-app` skill: task refinement, bug investigation, code review, feature request, task, endpoint, question, live run, and setup. Each carries the same hard rules, generated from `shared/hard-rules.md`.
- **One shared folder.** Workflows, references, and scripts live in `shared/`. Scripts find their own folder, resolve the editor through `shared/scripts/lib/paths.js`, and keep app contexts in `~/.make-custom-app/contexts` for both editors.
- **Three MCP servers.** `mcp.json` declares `make-app-context` (a committed bundle, `mcp/index.mjs`), the Make MCP server, and the Atlassian MCP server. The context server reads its keys from `MAKE_APP_CONTEXT_*` variables or the secrets file.
- **Cursor hook.** `hooks/session-start.js`, registered for Cursor only through `.cursor-plugin/plugin.json`, adds one line that names the nine skills to each Cursor session.
- **Update notice.** `check-setup.js` prints an `UPDATE_AVAILABLE` line, with the two update commands, when master carries a newer plugin version.
- **Cleanup of a 2.x install.** The `make-app-setup` skill runs `cleanup-legacy.js`: it lists the old skill folders, their MCP registrations, the block in `~/.claude/CLAUDE.md`, and the old Cursor rule folder, moves them to `~/.make-custom-app/migration-backup-<time>/` only after you confirm, and puts them back with `--restore`.
- **Checks.** `plugin-check` guards the manifests, `mcp.json`, the skills, and the shared content; `tools/build-mcp.js --check` guards the bundle; `old-tree-guard.js` limits the old tree to the 2.4.x bridge files, and `tools/migration-test.js` runs the migration from a 2.x install with the real Claude CLI.

## 2.4.0 — 2026-11-02

The last 2.x feature release. It offers to move this install to the make-custom-app plugin.

- **Plugin prompt.** `check-setup.js` prints a `PLUGIN_MIGRATION` line while the plugin is not installed, and `SKILL.md` asks you at most once a day whether to install it. Once the plugin is installed, the line first copies your MCP keys and app contexts with the same script and then hands the work to the plugin's `make-app-setup` skill, which removes this install after you confirm.
- **Migration script.** `migrate-to-plugin.js` runs `claude plugin marketplace add` and `claude plugin install`, copies the Pinecone and OpenAI keys into `~/.make-custom-app-skill-secrets` and the app context files into `~/.make-custom-app/contexts`, and deletes nothing.
- **Cursor without Claude Code.** Not supported yet: `check-setup.js` says so once a month and changes nothing.

## Earlier releases

Releases before 2.4.0 are not listed here.
