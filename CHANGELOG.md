# Changelog

## 3.3.0 — 2026-11-05

The parameters reference (`shared/references/parameters-reference.md`) and the Endpoint schema checklist (`shared/references/endpoints-reference/forman-schemas.md`) are rewritten as a description of how Make handles parameter and interface specs, checked against Make's module form and value check. They say what the form shows and what the value check does when a spec says something, without internal names. User-visible messages are quoted as users see them.

- Every fact of the old text stays, reworded. 91 old statements that were wrong or incomplete are corrected, and 86 behaviours that were missing are added. The most visible: `mode: "edit"` is a legacy spelling of map mode on every type with a Map switch; `validate: false` switches off every check of the field in the form, while Make's value check still runs the type check, the option list and `required`; `dynamic: true` switches off the option-list check of a select with inline options; grouped options need `grouped: true`, or no value matches; `uuid` has no UUID shape check; `checkbox` ignores `nested`; `sequence` does nothing on an array; and `validate.enum` is not enforced.
- Three new parts in `parameters-reference/`: `validation.md` (where values are checked, the `validate` keys by type, empty values and `required`, how values are converted, patterns, item rules, hints and the verbatim messages), `select-and-rpc-options.md` (select and option properties, option sources, what an options RPC receives and returns, conditional RPCs, which nested set is shown, paging and search) and `interface.md` (the output interface and a dynamic interface via RPC).
- `forman-schemas.md` stays the Endpoint schema checklist, based on the measured effects, with the rules Make enforces kept apart from the team conventions. The new `endpoints-reference/schema-behaviour.md` says, per property and per type, what the form, the value check and the public `@makehq/forman-schema` converter do, with their messages.
- Where the code cannot show what Make does outside the form, for example whether resolved values are checked again when a scenario runs, the text says so in one line.
- The Parts tables and `shared/index.md` list the new parts. Other references and workflows link to the new section names, and their lines that restated parameter behaviour now agree with the reference, for example the `validate.pattern` review rules, the `mode: "edit"` notes and the Endpoint workflow.

## 3.2.0 — 2026-11-05

The runtime reference (`shared/references/runtime-reference.md` and its parts) is rewritten as a description of how Make runs custom-app IMLJSON, checked against the runtime itself. It says what Make does when the IMLJSON says something, without the runtime's internal names.

- Every fact of the old text stays, reworded. 97 old statements that were wrong or incomplete are corrected, and 62 behaviours that were missing are added. The most visible: the `timeout` directive (without it, nothing is read from the common data); the `valid` forms and their messages; a false `condition`, which never returns `false`; what a search returns when it finds nothing; a failed request is not retried (only the older HTTP client repeats one TLS failure); when trigger paging stops; an instant trigger with `response.iterate` and no `url` repeats until the run is stopped; and an action, or a search or RPC with a `response.wrapper`, loses the last page when a page-number condition ends paging.
- Five new parts: `polling-triggers.md` (trigger state, "Choose where to start", items that share a date, `order`, the default limit), `webhooks.md` (instant triggers, dedicated and shared webhooks, attach, update and detach, responders), `http-requests.md` (TLS options, AWS and OAuth 1 signing, cookies, compression, the headers Make adds), `iml-context.md` (the IML roots each component can read, custom IML function limits) and `on-prem-agent.md` (the `agency` directive). The Parts table and `shared/index.md` list them.
- `pagination.md`, `inline-endpoint-calls.md`, `environment-variables.md`, `oauth-connection-variables.md` (now covering basic, OAuth 1 and OAuth 2 connections) and `isc.md` are rewritten the same way.
- Other references and workflows link to the new section names, and their lines that restated runtime behaviour now agree with the reference. The code review workflow no longer sends reviewers to the runtime source: behaviour the reference does not cover is reported as unverified.

## 3.1.0 — 2026-11-04

The plugin now works for every Make user with a Make API token. Make employees keep the flow they have today, apart from the changes in the last item.

- Scripts check the saved Make API token before they work: `GET /api/v2/users/me` on the token's zone, then one read of the Make admin API. When the admin API answers, they run in employee mode with today's flow (the admin API base, `imt-app-runtime-path`, the `@make.com` Jira account). Otherwise they run in public mode on the public API, `https://{zone}/api/v2`. A 403 on `users/me` means a token without `user:read`: the scripts accept it and the admin read still decides the mode, so existing employee tokens keep working. A rejected token (401) or a check that cannot reach Make stops the script with the fix; nothing falls back to public mode. The result is kept for 24 hours in the temp folder under a hash of the zone and the token, never the token itself.
- The setup wizard tries the token on `eu1.make.com`, `eu2.make.com`, `us1.make.com`, `us2.make.com`, `eu1.make.celonis.com` and `us1.make.celonis.com`, saves the zone that accepts it as `make-zone`, and asks when none or several do. It no longer writes `make-api-url`. A setup without `make-zone` keeps working through the host of its `make-api-url`. The built-in `https://eu1.make.com/api/v2/admin` default is gone, so a setup with neither is incomplete.
- The wizard asks the employee questions (`imt-app-runtime` path, mockup path, Jira token and email) only for an employee token. The team id and the MCP keys stay optional for everyone. Behind an HTTP or HTTPS proxy (`HTTPS_PROXY` or `HTTP_PROXY`), the wizard restarts itself once with `NODE_USE_ENV_PROXY=1`, so its zone and mode checks reach Make the same way as the token check of the scripts.
- `check-setup.js` prints `MODE: employee` or `MODE: public` on its first line, or `MODE: unknown` with exit 1 when no token is saved, no usable Make zone is set, Make rejects it, or the check cannot reach Make. `--json` has `mode` and `zone`. The Make API line names the zone and the account behind the token, or says that the account name is unavailable for a token without `user:read`. Public mode checks the Make token, the team id and the MCP keys; employee mode adds the runtime path, the mockup path and the `make account` check. In Cursor a `WARNING:` line appears when the `admin` flag of the Make Apps SDK environment disagrees with the check.
- `test-component.js`, `post-review-transition.js`, `download-jira-ticket-attachment.js`, and `commit-changes.js compile` and `commit --issue` stop in public mode with a message that says so. `commit-changes.js commit` and `rollback` work in both modes.
- `download-app.js` writes all or nothing. A run that fails lists each part it could not read under `Failed:`, writes nothing and exits 1, so the folder keeps its previous copy or is not created. A 404 fails the run only for the app, the version or a component list; a 404 on any other section still means that the app does not have it, as before. A refused token, a 429 after the retries, a 5xx or a network error fails the run on any section. In public mode the visibility check is skipped and shown as `visibility unknown (public mode)`, and `private`, `packagePrivate` and `ipmDeployedToZone` in `metadata.json` stay `null` (unknown).
- In public mode, `download-app.js`, `commit-changes.js`, `create-component.js`, `delete-component.js`, `review-changes.js`, `update-app.js` and `update-component.js` stop on an app that lives in another zone than the token. The message names both zones and the token page of the app's zone. Employee mode still switches to the app's zone.
- The task skills read the `MODE:` line and tell the user when a step needs an employee account. `make-app-setup` covers both modes, and only Make employees sign in to the `atlassian` MCP server. The shared lifecycle stops on a failed download, treats the `null` visibility fields of public mode as unknown, and skips `search_app_knowledge` when the context server has no keys. The grant check in `environment-variables.md` loads the token through `requireMode()`. The README setup part covers both modes and lists the token scopes from the same constant as check-setup and the wizard.
- Changes that Make employees see: in Cursor, the `version`, `unsafe`, `noVersionPath` and `admin` fields of the Make Apps SDK environment no longer shape the API address, which now comes from the host and the mode. A Cursor environment `url` or a `make-api-url` on a host that is not a Make host (for example localhost or a staging host) is refused. In Cursor, `test-component.js` needs an active Make Apps SDK environment: without one, the `MAKE_API_KEY` variable and the mockup `.env` no longer stand in. In Cursor, `setup-secrets.js` needs a usable Make Apps SDK environment first: without one it stops before any question and writes nothing. `test-function.js`, `download-jira-ticket-attachment.js` and `post-review-transition.js` now need the saved Make API token and zone, like the other scripts.

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
