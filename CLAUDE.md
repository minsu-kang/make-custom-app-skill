# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## MCP Server — Commands

All commands run from `mcp-server/`:

```bash
# Build TypeScript → dist/
npm run build

# Lint (ESLint + typescript-eslint + prettier rules)
npm run lint
npm run lint:fix

# Run all tests (vitest)
npm test

# Run a single test file
npx vitest run lib/__tests__/chunker.test.ts
npx vitest run tools/__tests__/upsert.test.ts

# Watch mode during development
npm run test:watch
```

The MCP server is never started in this repo directly — the installer copies source to `~/.claude/skills/make-custom-app/mcp-server/`, runs `npm install && npm run build` there, and registers it in `~/.claude/claude.json`.

## Architecture

This repo ships a **two-target skill**: the same domain knowledge installs into either Cursor or Claude Code.

### Dual-target layout

```
skill/      → ~/.cursor/skills/make-custom-app/ (Cursor)
              ~/.claude/skills/make-custom-app/ (Claude Code)
rules/      → ~/.cursor/rules/make-custom-app/ (Cursor only — one ~600-byte trigger rule)
mcp-server/ → ~/.claude/skills/make-custom-app/mcp-server/ (both)
```

Installers are split by target: `install-cursor.sh` / `install-cursor.ps1` write under `~/.cursor/`, `install-claude.sh` / `install-claude.ps1` under `~/.claude/`. Each downloads the GitHub archive once (or uses the local clone) and copies directories wholesale — no file lists to maintain. The `skill/` payload is identical between targets.

### Three layers

- **Code-enforced**: `scripts/check-setup.js` (first action every conversation — version, `imt-app-runtime-path`, API credentials, optional mockup / Jira / MCP) and `scripts/lib/version-guard.js` (runs at the top of every script, auto-updates an outdated install).
- **Always loaded**: `skill/SKILL.md` (≤ 9 KB) — first action, workflow routing, hard rules, component/module tables, reference index. It is the only prose loaded in every Make session.
- **On demand**: `workflows/lifecycle.md` (shared skeleton: app identification → sync → context → Jira → work → push with confirmation → close-out) plus per-task deltas (`code-review.md`, `bug-investigation.md`, `feature-request.md`, `app-task.md`, `task-refinement.md`, `create-endpoint.md`), and `references/*.md`, each with a `> Read when:` header.

### Editor auto-detection

Scripts under `skill/scripts/` derive the editor and skill root from `process.argv[1]` via `skill/scripts/lib/skill-root.js` (`getSkillRoot()`, `getEditorDir()`). Markdown files use `${SKILL_ROOT}` and `${CONTEXTS_DIR}` placeholders declared in a `<!-- Variables: ... -->` comment; the agent expands them for whichever editor loaded the skill.

### Claude Code execution model

Same as Cursor: the main session invokes the `make-custom-app` skill and follows `SKILL.md`. The installer patches `~/.claude/CLAUDE.md` with that trigger (Cursor uses `rules/make-custom-app.mdc` instead). There is no Claude Code sub-agent and no private memory store — knowledge persists only through app context files and the Pinecone MCP tools. `--update` rewrites the CLAUDE.md sentinel block and deletes a leftover `~/.claude/agents/make-integration-engineer.md` from 2.0 installs.

### MCP server (Pinecone shared context)

`mcp-server/` is an optional TypeScript MCP server (stdio transport) that provides a team-shared vector knowledge base via Pinecone. It exposes five tools registered in `index.ts`: `upsert_app_context`, `search_app_knowledge`, `get_app_summary`, `list_apps`, `upsert_jira_ticket`.

Key internals:
- `lib/chunker.ts` — reads app context files from `~/.cursor/make-app-contexts/`, splits markdown by `##` headings into vectors, merges Work History tables by `Date+Task` key without losing existing rows
- `lib/pinecone.ts` — lazy singleton client; vector IDs follow `{slug}-v{version}#{section}` scheme
- `lib/embeddings.ts` — OpenAI embeddings wrapper
- `tools/` — one file per MCP tool, each calls `register*Tool(server)`

Required env vars for the MCP server: `PINECONE_API_KEY`, `OPENAI_API_KEY`. Optional: `PINECONE_INDEX_NAME` (defaults to `make-app-contexts`).

### Version sync

Every commit must bump `version.json` → `skill/SKILL.md` front matter → `CHANGELOG.md` together (see `.claude/CLAUDE.md` for the exact protocol). The skill's auto-update logic compares the installed version against `version.json` fetched from the `master` branch on GitHub, so these three files must always agree.
