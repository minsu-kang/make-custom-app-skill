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

The MCP server is never started in this repo directly — the installer copies source to `~/.claude/skills/make-custom-app/mcp-server/`, runs `npm install && npm run build` there, and registers it in `~/.claude.json`. Cursor gets the same copy and build under `~/.cursor/skills/make-custom-app/mcp-server/`; `npm run register` there writes `~/.cursor/mcp.json`.

## Architecture

This repo ships a **two-target skill**: the same domain knowledge installs into either Cursor or Claude Code.

### Dual-target layout

```
skill/      → ~/.cursor/skills/make-custom-app/ (Cursor)
              ~/.claude/skills/make-custom-app/ (Claude Code)
rules/      → ~/.cursor/rules/make-custom-app/ (Cursor only — one ~600-byte trigger rule)
mcp-server/ → ~/.cursor/skills/make-custom-app/mcp-server/ (Cursor)
              ~/.claude/skills/make-custom-app/mcp-server/ (Claude Code)
```

Installers are split by target: `install-cursor.sh` / `install-cursor.ps1` write under `~/.cursor/`, `install-claude.sh` / `install-claude.ps1` under `~/.claude/`. Each downloads the GitHub archive once (or uses the local clone) and copies directories wholesale — no file lists to maintain. The `skill/` payload is identical between targets.

### Three layers

- **Code-enforced**: `scripts/check-setup.js` (first action every conversation — version, `imt-app-runtime-path`, API credentials, the `@make.com` account, optional mockup / MCP) and `scripts/lib/version-guard.js` (runs at the top of every script, auto-updates an outdated install, and through `lib/access-guard.js` refuses an Atlassian account that is not `@make.com`).
- **Always loaded**: `skill/SKILL.md` (≤ 9 KB) — first action, workflow routing, hard rules, component/module tables, reference index. It is the only prose loaded in every Make session.
- **On demand**: `workflows/lifecycle.md` (shared skeleton: app identification → sync → context → Jira → work → push with confirmation → close-out) plus per-task deltas (`code-review.md`, `bug-investigation.md`, `feature-request.md`, `app-task.md`, `task-refinement.md`, `create-endpoint.md`), and `references/*.md`, each with a `> Read when:` header. The five largest (`runtime-reference`, `endpoints-reference`, `component-patterns-reference`, `code-review-criteria`, `app-ux-best-practices`) are a main file plus topic parts in a same-named folder; the main file's `## Parts` table says when to open each part.

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

## CI

`.github/workflows/ci.yml` runs on every pull request and master push. Run the same commands locally before pushing.

- `mcp-server` (Node 22): `npm ci`, `npm run lint`, `npm run build`, `npm test`.
- `skill-scripts` (Node 22 and 24): the `node --test` command below plus `--experimental-test-coverage` with 90% line, branch, and function thresholds.
- `skill-check`: `node .github/scripts/check-skill.js` checks version sync (`version.json`, `SKILL.md`, `CHANGELOG.md`), front matter, relative links in `skill/**/*.md` and `README.md`, `> Read when` headers, the `SKILL.md` index, the README and `SKILL.md` script lists, and syntax. The 9 KB `SKILL.md` size only warns.
- `lint-misc`: `shellcheck --severity=warning` on the two `.sh` installers and `actionlint`.

## Skill scripts

Plain Node CommonJS under `skill/scripts/`. No `package.json`, no build, no TypeScript. Cursor loads the same invariants from `.cursor/rules/skill-scripts.mdc` when those files are in scope.

- `require()`, not ESM `import`.
- New entry script: `#!/usr/bin/env node` and `require('./lib/version-guard').ensureFreshSkill()` (`check-setup.js` may skip with `--skip-version`; it and `setup-secrets.js` pass `{ access: false }` because they report and fix the account check themselves).
- Resolve the skill root via `lib/skill-root.js` (`process.argv[1]`). Do not use `__dirname` for the skill root.
- Read config through `lib/settings.js` → `~/.make-custom-app-skill-secrets`. Never print token values to logs or stdout.
- Tests: `node --test "skill/scripts/lib/__tests__/*.test.js"` (`node:test`, not the mcp-server vitest suite). Keep the quotes so Node expands the glob in any shell; the bare folder form finds no tests on Node 24.
- Entry script and logic: a script that needs tests keeps its I/O (network, files, exit codes) in `scripts/<name>.js` and its decisions as pure functions in `scripts/lib/<name>-logic.js`, with a different file name. Tests: `lib/__tests__/<name>-logic.test.js` for the logic, `lib/__tests__/<name>.test.js` for the script against a mock server (example: `run-component.js`).
- Adding or renaming a script: update the README Script Files table and the `SKILL.md` scripts line (installers copy `skill/` wholesale; there is no file list).
