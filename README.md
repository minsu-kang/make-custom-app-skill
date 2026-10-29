# Make Custom App plugin for Claude Code and Cursor

A plugin that helps you build, review, and maintain [Make](https://www.make.com/) custom apps (IMLJSON, the Make Apps SDK) in [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Cursor](https://cursor.sh/). It works with the **Make Apps SDK** extension and knows Make's IMLJSON format, module types, connections, RPCs, webhooks, SDK Endpoints, pagination, error handling, and the runtime internals of `imt-app-runtime`.

The plugin is for Make employees. The scripts refuse to run when the Atlassian account behind your Jira API token is not a `@make.com` account; `check-setup.js` and `setup-secrets.js` only report it.

## What it does

- **Nine task skills.** Each starts from one kind of request and loads only the workflow it needs: refine a ticket, investigate a bug, review code, add a feature, maintain an app, build an SDK Endpoint, answer a question, run an Endpoint or RPC live, and set up the tools.
- **App context.** Downloads the full source of an app once, keeps it in `~/.make-custom-app/contexts` for both editors, and shares summaries through a Pinecone index.
- **Jira integration.** Reads the ticket, reviews changes against its acceptance criteria, and writes Developer Notes, through the Atlassian MCP server.
- **Safe writes.** Scripts that change an app run only after you have seen and approved the change. Dev work ends at the push: committing or compiling an app happens only when you ask for it.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (the plugin installs through it; Cursor can load the same install)
- Node.js 20 or newer
- The [Make Apps SDK](https://marketplace.visualstudio.com/items?itemName=Integromat.apps-sdk) extension, configured with an API key and an environment
- A local clone of `integromat/imt-app-runtime` (Make internal)
- A Jira API token of your `@make.com` Atlassian account
- Optional: a Pinecone key and an OpenAI key for the shared app-context search

## Install

In your own terminal:

```bash
claude plugin marketplace add https://github.com/minsu-kang/make-custom-app-skill.git
claude plugin install make-custom-app@make-custom-app
```

Restart Claude Code (or run `/reload-plugins`). Then:

1. Ask Claude Code to set up the plugin. The `make-app-setup` skill runs `check-setup.js`, reports what is missing, and prints the interactive wizard command. Run that command **in your own terminal**: it asks for secrets, so the agent never runs it.
2. Type `/mcp` and sign in to the `make` and `atlassian` servers of the plugin.

### Cursor

Cursor can load the plugins that were installed for Claude Code, and the skills of this plugin show up there. Install the plugin with the commands above, restart Cursor, and check that the three MCP servers of the plugin (`make-app-context`, `make`, `atlassian`) appear in the MCP settings of Cursor. A route for machines that have Cursor only is not documented yet.

## Update

Third-party marketplaces do not update by themselves. Either turn on auto-update (`/plugin`, Marketplaces, `make-custom-app`, Enable auto-update), or update by hand with both commands, in this order:

```bash
claude plugin marketplace update make-custom-app
claude plugin update make-custom-app@make-custom-app
```

The same two commands apply when Cursor loads the Claude install.

`check-setup.js` prints an `UPDATE_AVAILABLE` line, without blocking your work, when master carries a newer version.

## Coming from a 2.x install

The old skill (`~/.claude/skills/make-custom-app`, or the Cursor copy) keeps working until you move. Release 2.4.0 of the old skill asks once a day whether to install the plugin; answer yes and it installs the plugin and copies your secrets and app contexts. After the plugin has loaded, the `make-app-setup` skill lists the old install (the skill folder, its MCP registration, the block in `~/.claude/CLAUDE.md`) and removes it only after you confirm; everything it removes is moved to a backup folder first. Your own paragraph in `~/.claude/CLAUDE.md` that says to invoke the `make-custom-app` skill is never edited: replace it by hand, because that skill no longer exists after the move.

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
| `check-setup.js` | One-screen setup diagnosis: `imt-app-runtime-path`, Make API credentials, mockup path, default team id, the `@make.com` account check, MCP keys, leftovers of a 2.x install, and an update notice. Exit 1 when a required item is missing. |
| `setup-secrets.js` | Interactive wizard for `~/.make-custom-app-skill-secrets`. Run it in your own terminal, never through the agent. |
| `download-app.js` | Downloads the full source of an app from the Make API into `~/.make-custom-app/contexts` |
| `update-app.js` | Pushes code changes to Make through the SDK Admin API |
| `review-changes.js` | Fetches the uncommitted changes of an app for a code review |
| `commit-changes.js` | Commits pending changes, rolls them back, or enqueues a compile; `--issue=KEY` chains the Jira transition |
| `create-component.js` | Creates a module, RPC, function, connection, webhook, or endpoint |
| `update-component.js` | Updates component metadata |
| `delete-component.js` | Deletes a component (public apps: RPCs and functions only) |
| `test-function.js` | Runs the tests of a custom IML function (`code.js` and `test.js`) |
| `test-component.js` | Runs component integration tests through the `make-apps-mockup` framework |
| `run-component.js` | Runs one SDK Endpoint or RPC live through the public API, in one step, with your own Make connection |
| `download-jira-ticket-attachment.js` | Downloads the attachments of a Jira ticket (images, videos) for analysis |
| `post-review-transition.js` | Moves a Jira ticket after a code review is concluded |

The scripts take `--editor claude|cursor` when no editor variable reaches them. The `lib/` folder holds their shared code and its tests.

## Configuration

`~/.make-custom-app-skill-secrets` holds one `key: value` per line (mode 600, never inside the plugin, never read by the agent). The wizard writes the file; `make-app-setup` adds the `editor` line when the editor cannot be told:

| Key | Meaning |
|---|---|
| `imt-app-runtime-path` | Local clone of `imt-app-runtime` (required) |
| `make-api-key`, `make-api-url` | Make API token (Claude Code only; Cursor reads the Make Apps SDK settings) and its address |
| `jira-api-token`, `jira-email`, `jira-base-url` | Jira API token, and the account it belongs to (filled from `GET /rest/api/3/myself`) |
| `make-apps-mockup-path` | Local clone of `make-apps-mockup` (optional; `test-component.js`) |
| `make-team-id` | Default team for `run-component.js` (optional) |
| `pinecone-api-key`, `pinecone-index-name`, `openai-api-key` | Keys of the shared app-context server (optional; the index name defaults to `make-app-contexts`) |
| `editor` | `claude` or `cursor`, used only when no editor variable is set |

Create the Make token at https://eu1.make.com/user/api. Scopes: `apps:read apps:write sdk-apps:read sdk-apps:write`, plus any admin scope you have. `run-component.js` needs more: `imt-forms:read` for every run, `teams:read organizations:read` for Endpoints and for listing your teams, `connections:read user:read` when the component uses a connection, and optionally `endpoints:run` and `credential-requests:write`. Create the Jira token at https://id.atlassian.com/manage-profile/security/api-tokens (choose **Create API token**, not the one with scopes).

## MCP servers

`mcp.json` declares three servers.

| Server | What it is |
|---|---|
| `make-app-context` | Local server (a committed bundle, `mcp/index.mjs`) for the shared Pinecone app context |
| `make` | The Make MCP server, `https://mcp.make.com/v2` (sign in with `/mcp`) |
| `atlassian` | The Atlassian MCP server, `https://mcp.atlassian.com/v1/mcp`; left out when you already configured the same address yourself |

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
tools/             repo tools: hard-rules sync, MCP bundle build, install verification
.github/           CI and the content checks
```

Contributor notes (commands, rules for scripts, how a version is released) are in [CLAUDE.md](CLAUDE.md).

## Usage examples

Ask naturally:

- *"Create an Action module that calls the /users endpoint"*
- *"How does pagination work for cursor-based APIs?"*
- *"Add error handling for 429 rate limits"*
- *"Review my code changes: slug slack, version 4"*
- *"Refine this ticket: https://make.atlassian.net/browse/IEN-12345, app monday"*
