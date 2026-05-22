# Make Custom App Skill — Project Config

## Version Sync (automatic)

This repository follows strict semver. Before every `git commit`:
1. Determine the appropriate bump: `patch` for fixes/docs, `minor` for new features/workflows/references, `major` for breaking changes to the skill API
2. Update `version.json` → bump the `version` field
3. Update `skill/SKILL.md` → bump the `version:` frontmatter field to match
4. Prepend a new entry to `CHANGELOG.md` in format: `## X.Y.Z — YYYY-MM-DD\n- <change summary>`
5. Stage the version files (`version.json`, `skill/SKILL.md`, `CHANGELOG.md`) alongside the feature changes
6. Format the commit message as: `X.Y.Z: <description>` (e.g. `1.13.0: add claude code install script`)

Never commit without bumping the version.

## Install Sync (automatic)

The 4 installers (`install-cursor.sh`, `install-cursor.ps1`, `install-claude.sh`, `install-claude.ps1`) hardcode the list of files they download from GitHub. Wildcard copies only run when the user installs from a local clone — the README-recommended `curl | bash` / `irm | iex` paths download **only the files listed in the installer arrays**. Files missing from the arrays silently disappear for those users.

### Tracked directories → installer arrays

| Repo directory | Pattern | Array (all 4 installers) |
|---|---|---|
| `skill/` (root only) | `*.md` | `SKILL_FILES` / `$SKILL_FILES` |
| `skill/references/` | `*.md` | `REFERENCE_FILES` / `$REFERENCE_FILES` |
| `skill/workflows/` | `*.md` | `WORKFLOW_FILES` / `$WORKFLOW_FILES` |
| `skill/scripts/` (root only) | `*.js` | `SCRIPT_FILES` / `$SCRIPT_FILES` |
| `skill/scripts/lib/` | `*.js` | `SCRIPT_LIB_FILES` / `$SCRIPT_LIB_FILES` |
| `rules/` | `*.mdc` | `RULE_FILES` / `$RULE_FILES` |
| `mcp-server/` (selective) | varies | `MCP_SERVER_FILES` / `$MCP_SERVER_FILES` |
| `subagents/` | hardcoded inline | not an array — edit `install-claude.*` only |

### Mandatory sync triggers

Whenever you **add, rename, delete, or move** a file inside a tracked directory, you MUST in the same change:

1. Update **all 4 installer arrays** (or hardcoded paths for `subagents/`). Never patch only `.sh` or only `.ps1` — both platforms must stay in sync.
2. Update `README.md` if the file appears in any enumerated list:
   - `### Skill Files` table (workflows + references)
   - `### Script Files` table
   - `### Rule Files` table
   - `## Repository Structure` tree
3. Update `skill/SKILL.md` if the new/changed file is referenced from the workflow routing table or any cross-link.
4. Verify by running `Glob` on each tracked directory and `Grep` against each installer's array — counts and filenames must match 1:1.

No exceptions. Updating only some of these leaves users with broken installs.

### Why this matters

In 1.14.0, `make-app-todo-refinement.mdc` and `task-refinement.md` were added to the repo but never added to any installer array. Every user who installed via the README-recommended one-liner received a broken installation missing those files. This rule exists so that class of bug cannot recur.
