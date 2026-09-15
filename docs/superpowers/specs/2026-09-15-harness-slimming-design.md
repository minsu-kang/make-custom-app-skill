# Harness Slimming — Design Spec

Date: 2026-09-15
Target release: 2.0.0 (breaking: rule files removed, installer mechanism changed)

## 1. Problem

The skill grew by accretion: every incident added prose to the always-loaded surface. Measured state at 1.21.0:

| Layer | Size | Loaded when |
|---|---|---|
| `skill/SKILL.md` | 36 KB | every Make session |
| `rules/*.mdc` with `alwaysApply: true` (3 files) | 22 KB | **every Cursor conversation, any project** |
| TODO template + `make-app-todo-rules.mdc` | ~13 KB | every Make session |
| `workflows/code-review.md` | 43 KB | code review |
| `workflows/app-context.md` + `pinecone-sync.md` | 19 KB | pulled by every workflow |
| `references/code-review-criteria.md` | 43 KB | code review |
| **Code-review session, before reading any app code** | **≈190 KB ≈ 45k tokens** | |

Total prose harness: ≈611 KB ≈ 150k tokens (SKILL 36, workflows 119, references 397, rules 46, subagent 13).

Structural duplication found:

1. Version check described in prose twice (`SKILL.md`, subagent) while `scripts/lib/version-guard.js` already enforces it in code.
2. Tail-config validation described in prose twice plus 4 setup-guide sections, while `scripts/lib/settings.js` already reads the same keys.
3. TODO templates (5 files) reference "Common Pre/Post — verbatim" blocks in a 6th file; the agent must merge two files to build one list. Items duplicate workflow steps 1:1.
4. Five workflows repeat the same skeleton (gather context → app detect → download → load context → dev notes → context update → Pinecone → post-commit sync).
5. Breaking-change skip rules appear three times (`code-review.md` §7, `code-review.md` Important Rules, `code-review-criteria.md`).
6. `SKILL.md` "Important Notes" duplicates `app-compilation-and-deployment-reference.md`; its IML tables duplicate `builtin-iml-functions.md` and `communication-reference.md`.
7. `work-discipline.mdc` (11 KB) is half incident narrative.
8. Three memory systems: context files, Pinecone, and subagent `~/.claude/agent-memory/`.
9. `pinecone-sync.md` has four near-identical setup guides.
10. Four installers hardcode file lists; `install-sync.mdc` exists only to police that.
11. Hardcoded `~/.cursor/skills/...` paths remain in `SKILL.md` despite the `${SKILL_ROOT}` convention.

## 2. Goals

- Code-review session harness load ≤ 15k tokens (from ≈45k).
- Cursor global always-on overhead ≤ 1 KB (from 22 KB).
- Every enforceable check moves to code; prose states only what code cannot enforce.
- Zero loss of hard rules that protect against real past regressions (listed in §4).
- Existing installs upgrade via the current `--update` path without manual steps.
- Scripts, MCP server, context-file format, and `version.json` contract unchanged.

## 3. Architecture — three layers

### Layer 0 — enforced by code

| Concern | Mechanism |
|---|---|
| Skill freshness | `scripts/lib/version-guard.js` (existing, unchanged) |
| Setup completeness | **new** `scripts/check-setup.js` — one command, one screen, exit 1 when a required item is missing |
| API credentials | `scripts/lib/settings.js` (existing) |

`check-setup.js` checks and reports:

| Item | Required | Check |
|---|---|---|
| skill version | yes | `ensureFreshSkill()` |
| `imt-app-runtime-path:` | yes | tail-config present, not placeholder, directory exists |
| Make API credentials | yes | Cursor: `settings.json` `apps-sdk.environments` resolves; Claude: `make-api-key:` present, not `<...>` |
| `make-apps-mockup-path:` | optional | directory exists (needed by `test-component.js`) |
| `jira-email:` + `jira-api-token:` | optional | both present (needed by attachment download + reviewer assignment) |
| MCP server | optional | `mcp-server/dist/index.js` exists, `.env` exists, `make-app-context` registered in `~/.cursor/mcp.json` or `~/.claude.json` |

Output: one line per item (`OK` / `MISSING` / `OPTIONAL-MISSING`), then for every `MISSING`/`OPTIONAL-MISSING` item the exact fix text (the same text that today lives in `SKILL.md` and `pinecone-sync.md` setup guides). `--json` emits a machine-readable object. Exit code 1 when any required item is missing, else 0.

### Layer 1 — always loaded (target ≤ 8 KB)

**`skill/SKILL.md`** sections, in order:

1. Frontmatter (`name`, `version`, `description` unchanged).
2. **First action** (3 lines): run `node ${SKILL_ROOT}/scripts/check-setup.js` once per conversation; if it exits non-zero, show its output and stop. This replaces the Hard Stop, the Version Check section, and all four setup sections.
3. **Routing table**: trigger → workflow file (same rows as today, one line each).
4. **Hard rules** (≤ 10 lines, see §4).
5. **Component and module-type tables** (kept: they are the one piece of domain knowledge used in every task and have no other home short enough to load).
6. **Reference index**: one line per reference with a "read when" clause.
7. **Script index**: one line per script (name + purpose). Usage details live in each workflow.
8. Tail-config area comment: `# user config lines are appended below by the installer`.

Removed from `SKILL.md`: version-check prose, Hard Stop prose, IML variable/function tables, communication skeleton, runtime limits table, error-type list, Important Notes, all four setup guides, the `test-component.js` usage block.

**`rules/make-custom-app.mdc`** — single file, `alwaysApply: true`, ≤ 600 bytes:

> When the conversation involves a Make.com custom app, IMLJSON, the Make Apps SDK, `make-app-contexts`, or an IEN Jira ticket about an app, load the `make-custom-app` skill before any other action.

All other `rules/*.mdc` are deleted. The Claude installer stops installing `rules/`.

**`subagents/make-integration-engineer.md`** — frontmatter unchanged; body ≤ 15 lines: role sentence, mandatory `Skill('make-custom-app')` first action, "follow SKILL.md; it is the operating contract." The agent-memory section is removed.

### Layer 2 — loaded on demand

**`workflows/lifecycle.md`** (new, ≈ 8 KB) — the shared skeleton every task workflow delegates to:

1. App identification (inline slug/version → Jira App HQ URL `customfield_10268` → IPME latest major → ask).
2. Code sync: `download-app.js` when missing / `downloadedAt` > 24 h / open file differs. Includes the `update-app.js` component-path table and the `commit-changes.js` option table (moved from `app-context.md`).
3. Context load: `${CONTEXTS_DIR}/{slug}-v{version}.md` + `search_app_knowledge`.
4. Jira fetch: field list `["summary","description","subtasks","comment","status","attachment","issuetype","customfield_10483","customfield_10283","customfield_10268"]`; subtasks by status (Done skip / Test review / other context); parent when the ticket is a subtask; attachments via `download-jira-ticket-attachment.js`.
5. Write-script rule: `update-app.js`, `create-component.js`, `update-component.js`, `delete-component.js`, `commit-changes.js` require the user to see the diff/summary and confirm. `commit-changes.js rollback` is never self-initiated.
6. Post-work: Developer Notes prompt (except code review) → context file (template kept verbatim — chunker depends on `##` headings) → `upsert_app_context` + `upsert_jira_ticket` → post-commit `download-app.js`.
7. MCP unavailable: run `check-setup.js` and show its MCP section; do not block the rest of the workflow.

Task workflows keep only their deltas and end with a `## Checklist` of 5–8 lines. The agent builds its own todo list from the checklist; no verbatim template, no fixed ids.

| File | Target size | Keeps | Drops |
|---|---|---|---|
| `code-review.md` | ≤ 18 KB | required inputs; reviewer assignment (parent only); §5a compiled/uncompiled interpretation table; skip rules #1–#5 **once** (incl. the uncommitted #5 change); directive → `runtime-reference.md` section index; External API verification gate (procedure, no anecdotes); cross-module verification; output format + Commit Checklist rule; Developer Message + audience rule (list form); disposition gate (past tense vs imperative, `Test`-status QA rule); re-review table | duplicated skip rules in Important Rules; false-positive anecdotes (moved to `code-review-criteria.md` Out of Scope if not already there); repeated "do not" paragraphs |
| `bug-investigation.md` | ≤ 5 KB | required-data rule; full-chain trace; failing-test gate; minimal-change principle; recurring-bug audit | steps 1–2, 9–11 (lifecycle) |
| `feature-request.md` | ≤ 4 KB | design-before-code gate; `create-component.js` table; implementation order | steps 1–2, 9–11 |
| `app-task.md` | ≤ 3 KB | UX read-first; metadata/delete script blocks; breaking-change checks | steps 1–2, 6–8 |
| `task-refinement.md` | ≤ 12 KB | status check; feasibility criteria; plan format; Investigation subtask creation | any lifecycle repetition |
| `create-endpoint.md` | ≤ 7 KB | as-is, compressed | — |
| `app-context.md` | deleted | → `lifecycle.md` | |
| `pinecone-sync.md` | deleted | → `lifecycle.md` §6–7 + `check-setup.js` | |

**`references/`** — 17 files kept. Changes limited to:

- Add a 1–3 line `> Read when: …` header to every file.
- `code-review-criteria.md`: replace the duplicated skip-rule block with one link to `code-review.md` §"Skip rules"; replace the "Runtime Behavior Verification" section body with the directive index link plus the false-positive list.
- Move `SKILL.md` Important Notes content into `app-compilation-and-deployment-reference.md` where not already present (verify by grep before moving; most is already there).
- Replace remaining `~/.cursor/skills/make-custom-app` literals with `${SKILL_ROOT}`.

### Installers

All four installers switch from per-file download to one archive download:

- `.sh`: `curl -fsSL https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz | tar -xz -C "$TMP"`; source root `$TMP/make-custom-app-skill-$BRANCH`.
- `.ps1`: `Invoke-WebRequest https://github.com/$REPO/archive/refs/heads/$BRANCH.zip` → `Expand-Archive`; same root.
- Local-clone mode (script run from a checkout) keeps using `$SCRIPT_DIR` as the source root. Both paths then run the same copy block: `skill/` → `$SKILL_DIR`, `rules/` → `$RULES_DIR` (Cursor only), `mcp-server/` selected files → `$MCP_SERVER_DIR`, `subagents/` → `~/.claude/agents/` (Claude only).
- `mcp-server/` copy excludes `node_modules`, `dist`, `.env` (the installer builds and preserves `.env` as today).
- User-config preservation (tail lines, `.env`) unchanged.
- Migration: on update, remove `$RULES_DIR/*.mdc` before copying (Cursor) and remove `$SKILL_DIR/rules/` (Claude, already covered by `rm -rf $SKILL_DIR`). Remove the deprecated-hooks block only after confirming no installs older than 1.12.0 matter — kept in 2.0.0, deletable later.
- Claude `copy_with_rewrite` / `copy_rule_strip_frontmatter` become unnecessary once no `~/.cursor` literals remain; keep the sed rewrite as a no-op safety net for one release.

`install-sync.mdc` and the `## Install Sync` section of `CLAUDE.md` / `.claude/CLAUDE.md` are deleted.

## 4. Hard rules retained (prose, because code cannot enforce them)

These go into `SKILL.md` § Hard rules, one line each:

1. Never claim anything about a third-party API without fetching the vendor's official docs first; when unverifiable, say so and do not flag.
2. Never use an IMLJSON directive, IML function, or spec property that is not in `references/` or the `imt-app-runtime` source. Ask instead.
3. Before flagging any `api.imljson` issue, read the matching `runtime-reference.md` section.
4. Write scripts run only after the user sees the change and confirms; `commit-changes.js rollback` only on an explicit rollback request.
5. In code review: no context-file or Pinecone write until the user states the disposition (committed / compiled / returned).
6. Reviewers never write Developer Notes; sub-tasks in `Test` status are QA territory — never transition them.
7. Developer-facing messages contain no skill scripts, paths, or Pinecone terms.
8. Changes outside the ticket's AC are proposed, not made.

Gates retained inside workflows: plan approval before editing (bug/feature/task), write-script confirmation (lifecycle), review disposition (code-review).

## 5. Out of scope

- Script logic (`download-app.js` … `post-review-transition.js`) — unchanged.
- `mcp-server/` — unchanged.
- Context-file template and chunker contract — unchanged.
- Factual content of references — only deduplicated, never rewritten for meaning.
- Reference restructuring beyond the three edits in §3.

## 6. Migration and compatibility

- `version.json` bumps to `2.0.0`; `version-guard.js` triggers `--update` on the first script run of every existing install, which fetches the new installer from `master` and performs the archive install + rule cleanup.
- Cursor rule changes take effect after editor restart (same as today; the installer prints this).
- Claude Code: `~/.claude/CLAUDE.md` sentinel block is unchanged (still routes to the sub-agent); the sub-agent file is overwritten on `--update`.

## 7. Success criteria

- `wc -c skill/SKILL.md` ≤ 8192.
- `rules/` contains exactly one file ≤ 600 bytes.
- Sum of `skill/SKILL.md + rules/*.mdc + workflows/lifecycle.md + workflows/code-review.md + references/code-review-criteria.md` ≤ 60 KB.
- Fresh install from a temporary `HOME` via `install-cursor.sh` and `install-claude.sh` (local-clone mode and archive mode) produces a tree where `node scripts/check-setup.js --json` runs and reports the expected `MISSING` items.
- `--update` over a 1.21.0 install preserves tail-config lines and removes the 8 old rule files.
- No markdown link in `skill/` points to a deleted file (checked by script).
- `mcp-server`: `npm test` green.
- Every hard rule in §4 is present verbatim-in-meaning in the new `SKILL.md`; every skip rule #1–#5 and the disposition gate are present in `code-review.md`.
