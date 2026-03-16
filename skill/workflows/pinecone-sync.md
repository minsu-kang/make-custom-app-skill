# Shared Context (Pinecone) Auto-Sync

Automatically syncs local context to the shared Pinecone vector DB via the `make-app-context` MCP server. This enables team-wide knowledge sharing — any context saved locally is immediately searchable by all team members.

## Trigger (Auto-Execute — No User Confirmation Needed)

Execute auto-sync **automatically** whenever any of the following occurs during a conversation:

- A `{slug}-v{version}.md` context file is **created or updated**
- Developer notes are generated for a Jira ticket (bug investigation, feature work)
- A code review is completed

## MCP Server Availability Check

Before calling any MCP tool, check if the server is available by looking at the available MCP servers list.

**Detection logic (execute in order):**

1. **Check if `user-make-app-context` exists** in the available MCP servers.
   - If yes → **MCP server is ready.** Proceed to "Auto-Sync Actions" below.
   - If no → Continue to step 2.

2. **Resolve the mcp-server path** (check in order, use the first match):
   a. `mcp-server-path:` line at the end of SKILL.md → use that path.
   b. Default installed path `~/.cursor/skills/make-custom-app/mcp-server/` → if `package.json` exists there, use this path.
   - If a path is found → Continue to step 3.
   - If neither exists → **MCP server is not installed.** Show the "Full Setup Guide" below and end the turn.

3. **Check if `dist/index.js` exists** at the resolved path.
   - If yes → Check if `.env` exists:
     - `.env` exists → The server is built but not registered. Show the "Register Only Guide" below.
     - `.env` missing → Show the "Configure & Register Guide" below.
   - If no → The server needs to be built. Show the "Build & Register Guide" below.

## Setup Guides

### Full Setup Guide (MCP server not installed)

> **Shared context MCP server is not installed yet.**
>
> This server enables team-wide sharing of app contexts via Pinecone.
>
> Open **Cursor menu bar → Terminal → New Window** and run the installer:
>
> ```
> curl -fsSL https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install.sh | bash
> ```
>
> After installation completes, configure the MCP server:
>
> ```
> cd ~/.cursor/skills/make-custom-app/mcp-server
> cp .env.example .env
> ```
>
> Fill in `PINECONE_API_KEY`, `OPENAI_API_KEY`, `PINECONE_INDEX_NAME` in the `.env` file, then:
>
> ```
> npm run register
> ```
>
> **Restart Cursor** after completion!

After the user confirms setup, if `mcp-server-path:` is not already present, append it to the **very last line** of SKILL.md:

```
mcp-server-path: {path-to-mcp-server-directory}
```

### Build & Register Guide (code exists but not built)

> **MCP server needs to be built.**
>
> Open **Cursor menu bar → Terminal → New Window** and run:
>
> ```
> cd {mcp-server-path}
> npm install
> npm run build
> ```
>
> Then configure and register:
>
> ```
> cp .env.example .env     # skip if .env already exists
> ```
>
> Fill in `PINECONE_API_KEY`, `OPENAI_API_KEY`, `PINECONE_INDEX_NAME` in the `.env` file, then:
>
> ```
> npm run register
> ```
>
> **Restart Cursor** after completion!

### Configure & Register Guide (built but .env not configured)

> **MCP server is built but not configured yet.**
>
> Open **Cursor menu bar → Terminal → New Window** and run:
>
> ```
> cd {mcp-server-path}
> cp .env.example .env
> ```
>
> Fill in `PINECONE_API_KEY`, `OPENAI_API_KEY`, `PINECONE_INDEX_NAME` in the `.env` file, then:
>
> ```
> npm run register
> ```
>
> **Restart Cursor** after completion!

### Register Only Guide (built and configured but not registered with Cursor)

> **MCP server is built but not registered with Cursor.**
>
> Open **Cursor menu bar → Terminal → New Window** and run:
>
> ```
> cd {mcp-server-path}
> npm run register
> ```
>
> **Restart Cursor** after completion!

## Auto-Sync Actions

Once the MCP server is confirmed available, execute the appropriate upsert **automatically without asking**:

**After context file create/update** — call `upsert_app_context`:

```
MCP server: user-make-app-context
Tool: upsert_app_context
Arguments: { slug: "{app-slug}", version: "{app-version}" }
```

**After Jira ticket work** (bug investigation, feature, code review) — call `upsert_jira_ticket`:

```
MCP server: user-make-app-context
Tool: upsert_jira_ticket
Arguments: {
  ticket_key: "{JIRA-KEY}",
  slug: "{app-slug}",
  version: "{app-version}",
  ticket_type: "bugfix" | "feature" | "review",
  summary: "{ticket summary}",
  description: "{ticket description}",
  acceptance_criteria: "{acceptance criteria, if any}",
  developer_notes: "{developer notes, if generated}",
  review_result: "{review result, if code review}"
}
```

## Important Rules

- **Always auto-sync after saving context.** Never skip this step or ask the user whether to sync.
- If MCP server is not available, **show the appropriate setup guide and end the turn.** Do not skip the guide.
- If the MCP call fails with a transient error (network, timeout), inform the user and suggest retrying later. Do not block the rest of the workflow.
- The `upsert_app_context` reads from `~/.cursor/make-app-contexts/` — ensure the local files are saved before calling it.
