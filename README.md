# Make Custom App plugin for Claude Code and Cursor

A plugin that helps you build, review, and maintain [Make](https://www.make.com/) custom apps (IMLJSON, the Make Apps SDK) in [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Cursor](https://cursor.sh/). It works with the **Make Apps SDK** extension and knows Make's IMLJSON format, module types, connections, RPCs, webhooks, SDK Endpoints, pagination, error handling, and the runtime internals of `imt-app-runtime`.

Any Make user can use the plugin with a Make API token. Before they work, the scripts check the token on your zone and pick a mode: employee mode when the token can call the Make admin API, public mode otherwise. Public mode works on your own apps through the public Make API. Employee mode keeps the Make employee flow: the admin API, a local `imt-app-runtime` clone, and Jira. In employee mode the scripts refuse to run when the Atlassian account behind your Jira API token is not a `@make.com` account; `check-setup.js` and `setup-secrets.js` only report it, and `cleanup-legacy.js` checks nothing because it only moves local files.

A few steps need a Make employee account: Jira tickets, compile, component tests, and ownership transfer. In public mode the skills tell you when a step needs one, and the scripts behind these steps stop with a message that says so.

## What it does

- **Nine task skills.** Each starts from one kind of request and loads only the workflow it needs: refine a ticket, investigate a bug, review code, add a feature, maintain an app, build an SDK Endpoint, answer a question, run an Endpoint or RPC live, and set up the tools.
- **App context.** Downloads the full source of an app once, keeps it in `~/.make-custom-app/contexts` for both editors, and shares summaries through a Pinecone index.
- **Jira integration.** Reads the ticket, reviews changes against its acceptance criteria, and writes Developer Notes, through the Atlassian MCP server.
- **Safe writes.** Scripts that change an app run only after you have seen and approved the change. Dev work ends at the push: committing or compiling an app happens only when you ask for it.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (the plugin installs through it; Cursor can load the same install)
- Node.js 20 or newer
- The [Make Apps SDK](https://marketplace.visualstudio.com/items?itemName=Integromat.apps-sdk) extension, configured with an API key and an environment
- A Make account and a Make API token (scopes under [Configuration](#configuration)); the setup finds your zone from the token
- Optional: a Pinecone key and an OpenAI key for the shared app-context search

Make employees also need a local clone of `integromat/imt-app-runtime` (Make internal) and a Jira API token of their `@make.com` Atlassian account. The setup asks for them only in employee mode.

## Install

In your own terminal:

```bash
claude plugin marketplace add https://github.com/minsu-kang/make-app-ai-plugin.git
claude plugin install make-custom-app@make-custom-app
```

If `claude plugin marketplace list` already shows `make-custom-app` (added from the old `make-custom-app-skill` address), skip the first command: the old address still works, and adding the new one fails while the old entry exists.

Restart Claude Code (or run `/reload-plugins`). Then:

1. Ask Claude Code to set up the plugin. The `make-app-setup` skill runs `check-setup.js`, reports what is missing, and prints the interactive wizard command. Run that command **in your own terminal**: it asks for secrets, so the agent never runs it. The wizard asks for your Make API token, tries it on each Make zone (`eu1.make.com`, `eu2.make.com`, `us1.make.com`, `us2.make.com`, `eu1.make.celonis.com`, `us1.make.celonis.com`) and saves the zone that accepts it; when none or several do, it asks you. Then it checks the mode and asks the employee questions (`imt-app-runtime` path, mockup path, Jira token) only in employee mode. `check-setup.js` then shows `MODE: employee` or `MODE: public` on its first line.
2. Type `/mcp` and sign in to the `make` server of the plugin. Only Make employees also sign in to `atlassian`; other users can ignore the `atlassian` server and its sign-in prompt.

### Cursor

Cursor can load the plugins that were installed for Claude Code, and the skills of this plugin show up there. Install the plugin with the commands above and open the Plugins tab of Cursor: the plugin is listed as Imported, with its nine skills and its three MCP servers (`make-app-context`, `make`, `atlassian`). The setting "Include Third-Party Plugins" must be on, because with it off the plugin is hidden. In Cursor the scripts take the Make API token and the zone from the active environment of the Make Apps SDK extension, and the mode from the same token check as in Claude Code. `make` needs its own sign-in in Cursor, since Cursor keeps its own OAuth. Cursor without Claude Code is not supported yet.

## Update

Third-party marketplaces do not update by themselves. Either turn on auto-update (`/plugin`, Marketplaces, `make-custom-app`, Enable auto-update), or update by hand with both commands, in this order:

```bash
claude plugin marketplace update make-custom-app
claude plugin update make-custom-app@make-custom-app
```

The same two commands apply when Cursor loads the Claude install.

`check-setup.js` prints an `UPDATE_AVAILABLE` line, without blocking your work, when master carries a newer version.

## Coming from a 2.x install

The old skill (`~/.claude/skills/make-custom-app`, or the Cursor copy) keeps working until you move. On Windows its auto-update may need a manual run of the installer.

1. Release 2.4.0 of the old skill checks whether the plugin is installed. While it is not, it asks at most once a day whether to install it. Answer yes, and it runs `skill/scripts/migrate-to-plugin.js`: that runs `claude plugin marketplace add` and `claude plugin install`, copies the Pinecone and OpenAI keys of the old MCP registration and `mcp-server/.env` into `~/.make-custom-app-skill-secrets` (values already there win), and copies the app context files (`{slug}-v{n}.md` and `reviews/`) into `~/.make-custom-app/contexts`. It deletes nothing. Then restart Claude Code. If you install the plugin yourself, or 2.4.0 reaches you after the plugin, the old skill runs the same script before it hands over (it then installs nothing and only copies).
2. In a plugin session, the `make-app-setup` skill lists the old install: the skill folder, its MCP registration in `~/.claude.json`, and the block in `~/.claude/CLAUDE.md`, and with a separate question the Cursor copy, its rule folder, and its entry in `~/.cursor/mcp.json`. It removes them only after you confirm. The folders and the removed config entries move to `~/.make-custom-app/migration-backup-<time>/`, and the old `mcp-server/.env` is deleted when it holds only keys that are in your secrets file (any other `.env` stays in its folder, in the backup). If the old skill folder is a link, only the link moves; the files the link points to, an `.env` included, stay where they are. `cleanup-legacy.js --restore` puts everything back. Claude Code keeps its own copy of `~/.claude.json` as a hidden file, `~/.claude/backups/.claude.json.backup.<time>`; that copy can still hold the old Pinecone and OpenAI keys and the tokens of your other MCP servers, and the cleanup does not touch it. If you say no, `check-setup.js` replaces its warning with a short `OLD_INSTALL_KEPT` notice for 7 days, and the question comes back after that.
3. Your own paragraph in `~/.claude/CLAUDE.md` that says to invoke the `make-custom-app` skill is never edited: the cleanup names the line to change. The plugin's skills trigger without it.
4. Limits of `--restore`: when it cannot finish (a folder and its backup are both gone, or the old skill path is now a link), the backup stays `partially-restored` and a bare `--restore` picks it again, so name another one with `--restore <name>` or delete that folder. A removed `.env` is written back to its old place even when you created a new skill folder there, but never into a skill folder that is now a link. When a folder has to be copied across devices, a failed copy removes the half-copied target, so files another program wrote there at that moment are lost, and on Node 22 that copy may not keep folder permissions.

In Cursor, on a machine without Claude Code, release 2.4.0 says once a month that installing the plugin for Cursor alone is not supported yet; the old skill keeps working there. If the plugin is installed but disabled, the old skill says so once a day and prints `claude plugin enable make-custom-app@make-custom-app` for you to run in your own terminal; `migrate-to-plugin.js` never enables it. If you used the `mcp-server-path` option or a manual clone of the context server, the plugin's server reads the `MAKE_APP_CONTEXT_*` variables or the secrets-file keys instead (see [MCP servers](#mcp-servers)). The Windows route is not verified.

## Skills

| Skill | Use it for |
|---|---|
| `make-app-task-refinement` | Read-only feasibility study and implementation plan for a ticket in Preparation status |
| `make-app-bug-investigation` | Root cause and fix of a bug, regression, or returned ticket, with a failing test first |
| `make-app-code-review` | Review of a developer's changes against the Jira acceptance criteria |
| `make-app-feature-request` | New module, RPC, webhook, connection, custom function, or app |
| `make-app-task` | Refactor, label or UX change, metadata edit, deprecation, cleanup |
| `make-app-endpoint` | Create or update an SDK Endpoint |
| `make-app-question` | Questions about an app or an IMLJSON file; the default skill for any other Make app request |
| `make-app-run-live` | Run an Endpoint or RPC once against the real vendor API with your own connection |
| `make-app-setup` | Check and fix credentials, paths, MCP servers, and leftovers of a 2.x install |

Claude Code shows them as `make-custom-app:make-app-*`, Cursor as `make-app-*`. Every skill file carries the same hard rules, generated from `shared/hard-rules.md`. Workflows, references, and the component tables are in `shared/` (start at [shared/index.md](shared/index.md)); a skill loads them on demand.

## Scripts

Entry scripts in `shared/scripts/`. A skill runs them as `node "<plugin root>/shared/scripts/<name>.js"`.

| Script | Description |
|---|---|
| `check-setup.js` | One-screen setup diagnosis. It checks the Make API token on its zone and prints `MODE: employee`, `MODE: public` or, when it cannot check the token, `MODE: unknown` first, then the Make API credentials, the default team id, MCP keys, leftovers of a 2.x install, and an update notice; in employee mode also `imt-app-runtime-path`, the mockup path, and the `@make.com` account check. Exit 1 when a required item is missing, no usable Make zone is set, Make rejects the token, or the check cannot reach Make. |
| `cleanup-legacy.js` | Removes the leftovers of a 2.x install after you confirm: `--plan` lists them with a digest, `--apply <digest> --groups claude,cursor` moves them to `~/.make-custom-app/migration-backup-<time>/`, `--restore` puts them back, `--decline <digest>` records a no for 7 days. Run by the `make-app-setup` skill; `check-setup.js` prints `LEGACY_INSTALL:` while the old install is there and `OLD_INSTALL_KEPT:` after a no. |
| `setup-secrets.js` | Interactive wizard for `~/.make-custom-app-skill-secrets`. It finds your zone from the Make API token and asks the employee questions only in employee mode. Run it in your own terminal, never through the agent. |
| `download-app.js` | Downloads the full source of an app from the Make API into `~/.make-custom-app/contexts`. Exit 1, with the failed parts listed under `Failed:`, when a part cannot be read |
| `update-app.js` | Pushes code changes to Make through the SDK Admin API |
| `review-changes.js` | Fetches the uncommitted changes of an app for a code review |
| `commit-changes.js` | Commits pending changes, rolls them back, or enqueues a compile; `--issue=KEY` chains the Jira transition. `compile` and the `--issue` chain are for Make employees only |
| `create-component.js` | Creates a module, RPC, function, connection, webhook, or endpoint |
| `update-component.js` | Updates component metadata |
| `delete-component.js` | Deletes a component (public apps: RPCs and functions only) |
| `test-function.js` | Runs the tests of a custom IML function (`code.js` and `test.js`) |
| `test-component.js` | Runs component integration tests through the `make-apps-mockup` framework (Make employees only) |
| `run-component.js` | Runs one SDK Endpoint or RPC live through the public API, in one step, with your own Make connection |
| `download-jira-ticket-attachment.js` | Downloads the attachments of a Jira ticket (images, videos) for analysis (Make employees only) |
| `post-review-transition.js` | Moves a Jira ticket after a code review is concluded (Make employees only) |

The scripts take `--editor claude|cursor` when no editor variable reaches them. The `lib/` folder holds their shared code and its tests.

## Configuration

`~/.make-custom-app-skill-secrets` holds one `key: value` per line (mode 600, never inside the plugin, never read by the agent). The wizard writes the file; `make-app-setup` adds the `editor` line when the editor cannot be told:

| Key | Meaning |
|---|---|
| `make-api-key` | Make API token (required; Claude Code only, Cursor reads the Make Apps SDK settings) |
| `make-zone` | The Make host of your account, such as `eu1.make.com`; the wizard finds it from the token (Claude Code only) |
| `make-api-url` | Older setups only: when `make-zone` is not set, the scripts use the host of this URL. The wizard does not write it. |
| `imt-app-runtime-path` | Local clone of `imt-app-runtime` (Make employees; required in employee mode) |
| `jira-api-token`, `jira-email`, `jira-base-url` | Jira API token, and the account it belongs to (filled from `GET /rest/api/3/myself`; Make employees, required in employee mode) |
| `make-apps-mockup-path` | Local clone of `make-apps-mockup` (Make employees, optional; `test-component.js`) |
| `make-team-id` | Default team for `run-component.js` (optional) |
| `pinecone-api-key`, `pinecone-index-name`, `openai-api-key` | Keys of the shared app-context server (optional; the index name defaults to `make-app-contexts`) |
| `editor` | `claude` or `cursor`, used only when no editor variable is set |

Create the Make token in Make, on the API page of your profile (`https://<your zone>/user/api`, for example `https://eu1.make.com/user/api`). Scopes: `sdk-apps:read sdk-apps:write user:read`. `user:read` lets `check-setup.js` show the account name behind the token, and `run-component.js` needs it for components with a connection. `run-component.js` also needs `imt-forms:read` for every run, `teams:read organizations:read` for Endpoints and for listing your teams, `connections:read` when the component uses a connection, and optionally `endpoints:run` and `credential-requests:write`.

Make employees keep the token they use today, also without `user:read`: the scripts accept it, and `check-setup.js` then says that the account name is unavailable. When `check-setup.js` shows `MODE: public` for an employee account, the token cannot call the Make admin API. Create the Jira token at https://id.atlassian.com/manage-profile/security/api-tokens (choose **Create API token**, not the one with scopes).

## MCP servers

`mcp.json` declares three servers.

| Server | What it is |
|---|---|
| `make-app-context` | Local server (a committed bundle, `mcp/index.mjs`) for the shared Pinecone app context |
| `make` | The Make MCP server, `https://mcp.make.com/v2` (sign in with `/mcp`) |
| `atlassian` | The Atlassian MCP server, `https://mcp.atlassian.com/v1/mcp`, for the Jira steps of Make employees (other users can ignore it); left out when you already configured the same address yourself |

The context server reads its keys from `MAKE_APP_CONTEXT_PINECONE_API_KEY`, `MAKE_APP_CONTEXT_OPENAI_API_KEY`, and `MAKE_APP_CONTEXT_PINECONE_INDEX` first, then from the secrets file. The generic names `PINECONE_API_KEY` and `OPENAI_API_KEY` are not read.

In Claude Code the tools are named `mcp__plugin_make-custom-app_make-app-context__<tool>`. A plugin cannot ship permission rules, so the first call of each tool asks. To stop that for the three read tools, add these to `permissions.allow` in your own settings (`~/.claude/settings.json`, or a project settings file), and nothing broader (no wildcard, and not `upsert_app_context` or `upsert_jira_ticket`, which write to the shared index and need your approval):

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_make-custom-app_make-app-context__search_app_knowledge",
      "mcp__plugin_make-custom-app_make-app-context__get_app_summary",
      "mcp__plugin_make-custom-app_make-app-context__list_apps"
    ]
  }
}
```

If the file already has a `permissions.allow` list, add the three names to it.

## Repository

```
.claude-plugin/    plugin.json (Claude Code), marketplace.json
.cursor-plugin/    plugin.json (Cursor)
skills/            the nine make-app-* skills (SKILL.md each)
shared/            hard-rules.md, workflows/, references/, scripts/ (and their tests)
mcp/               index.mjs, the built context server
mcp-server/        TypeScript source of that server
mcp.json           the three MCP servers
hooks/             the Cursor sessionStart hook (Cursor only)
tools/             repo tools: hard-rules sync, MCP bundle build, install verification, trigger test, migration test, installer shim drafts
.github/           CI and the content checks
```

Contributor notes (commands, rules for scripts, how a version is released) are in [CLAUDE.md](CLAUDE.md).

## Usage examples

Ask naturally:

- *"Create an Action module that calls the /users endpoint"*
- *"How does pagination work for cursor-based APIs?"*
- *"Add error handling for 429 rate limits"*
- *"Review my code changes: slug slack, version 4"*
- *"Refine this ticket: https://make.atlassian.net/browse/PROJ-123, app monday"*
