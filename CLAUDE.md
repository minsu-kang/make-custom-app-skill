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
skill/          → installed to ~/.cursor/skills/make-custom-app/  (Cursor)
                               ~/.claude/skills/make-custom-app/   (Claude Code)
rules/          → installed to ~/.cursor/rules/make-custom-app/   (Cursor)
                               ~/.claude/skills/make-custom-app/rules/ (Claude Code)
subagents/      → ~/.claude/agents/  (Claude Code only)
mcp-server/     → ~/.claude/skills/make-custom-app/mcp-server/    (Claude Code only)
```

Installers are split by target: `install-cursor.sh` / `install-cursor.ps1` write under `~/.cursor/`, `install-claude.sh` / `install-claude.ps1` write under `~/.claude/`. The `skill/` payload is identical between targets — runtime auto-detection makes a single source tree work for both.

### Editor auto-detection

Scripts under `skill/scripts/` no longer hardcode `.cursor`. They derive the editor and skill root from `process.argv[1]` via the shared utility `skill/scripts/lib/skill-root.js`:

- `getSkillRoot()` — returns `~/.cursor/skills/make-custom-app` or `~/.claude/skills/make-custom-app` based on the invocation path.
- `getEditorDir()` — returns the dot-dir name (`.cursor` or `.claude`) for sibling paths like `make-app-contexts`.

Markdown workflow and reference files match the same convention: they use `${SKILL_ROOT}` and `${CONTEXTS_DIR}` placeholders (declared in a `<!-- Variables: ... -->` comment at the top of each file) instead of hardcoded `~/.cursor/...` paths. The agent expands these against whichever editor is loading the skill.

### Claude Code execution model

The Claude Code path introduces a sub-agent named `make-integration-engineer` (`subagents/make-integration-engineer.md`). The global `~/.claude/CLAUDE.md` is patched by the installer to route all Make app work to this agent automatically.

The sub-agent's **mandatory first action** every session is `Skill('make-custom-app')`, which loads `SKILL.md` and triggers the version-check/auto-update logic. Static file reads are not a substitute.

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
