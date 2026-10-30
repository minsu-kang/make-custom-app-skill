# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repository is the `make-custom-app` plugin for Claude Code and Cursor, and its own marketplace. The repo root is the plugin root. Users get the plugin through `claude plugin marketplace add` and `claude plugin install`; Cursor can load the same install. The old single skill (`skill/`, `rules/`, four installers, `version.json`) stays on master only until the migration period ends, because 2.x clients download it.

## Layout

```
.claude-plugin/   plugin.json, marketplace.json
.cursor-plugin/   plugin.json (rules points at the empty plugin-rules/ folder)
skills/           nine make-app-* skills, one SKILL.md each
shared/           hard-rules.md, index.md, workflows/, references/, scripts/ (+ lib/ and lib/__tests__/)
mcp/index.mjs     built MCP context server, committed
mcp-server/       TypeScript source of that server (also the payload of the old installers)
mcp.json          the three MCP servers (make-app-context, make, atlassian)
hooks/            the Cursor sessionStart hook: hooks-cursor.json and session-start.js (Cursor only)
tools/            repo-only tools: sync-hard-rules.js, build-mcp.js, legacy-bridge.js, verify-plugin.js, migration-test.js
tools/trigger-test/   maintainer trigger test (spec 11 item 8): run-claude.js, run-cursor.js, jira-stub.js, prompts.json
tools/shims/      drafts of the four installer shims (inactive until plan P6)
.github/          workflows and the content checks (plugin-check.js, check-skill.js, old-tree-guard.js)
docs/superpowers/ design spec and implementation plans (local files, git-ignored)
skill/ rules/ install-*.sh install-*.ps1 version.json   the 2.x bridge: do not change except as named in the spec
```

## Commands

```bash
# Content checks and the tools' tests (Node 24 in CI)
node .github/scripts/plugin-check.js
node --test ".github/scripts/__tests__/*.test.js" "tools/__tests__/*.test.js"
node tools/sync-hard-rules.js          # copy shared/hard-rules.md into every SKILL.md (add --check to only compare)

# Scripts (Node 22 and 24 in CI; 90% line, branch, and function coverage)
node --test --experimental-test-coverage --test-coverage-exclude="**/__tests__/**" --test-coverage-exclude="shared/scripts/*.js" --test-coverage-lines=90 --test-coverage-branches=90 --test-coverage-functions=90 "shared/scripts/lib/__tests__/*.test.js"

# MCP server (from mcp-server/), then rebuild and commit the bundle
npm ci && npm run lint && npm run build && npm test
node ../tools/build-mcp.js             # writes ../mcp/index.mjs (add --check to only compare)

# Old tree, while it exists
node --test "skill/scripts/lib/__tests__/*.test.js"
node .github/scripts/check-skill.js
node .github/scripts/old-tree-guard.js --mode=branch --base=df148e5   # old-tree changes only in the bridge files

# Migration from a 2.x install with the real CLI (it refuses to run outside a container or CI)
docker run --rm -v "$PWD:/src:ro" node:22 bash -c 'set -e; git config --global --add safe.directory "*"; git clone -q /src /w/repo; cd /w/repo; npm install --global --silent @anthropic-ai/claude-code@2.1.312; node tools/migration-test.js'

# Load the working tree as a plugin, or check a real install
claude --plugin-dir .
node tools/verify-plugin.js            # install into an isolated config and inspect it (add --live for model sessions)

# Trigger test after any change to a skill description (real model sessions: about 0.1 USD of Claude usage per prompt, an unknown amount of Cursor quota)
node tools/trigger-test/run-claude.js --condition clean
node tools/trigger-test/run-cursor.js
```

Keep the test globs quoted so Node expands them in any shell. The MCP server is never started from this repo directly: the plugin runs the committed bundle, and the 2.x installers build `mcp-server/` in the user's skill folder.

## Architecture

### Three layers

- **Code-enforced.** `shared/scripts/check-setup.js` (the first action of every skill: `imt-app-runtime-path`, Make API credentials, the `@make.com` account behind the Jira token, MCP keys, leftovers of a 2.x install, an update notice) and `lib/access-guard.js` (`ensureInternalUser()` refuses an Atlassian account that is not `@make.com`).
- **Always loaded.** The `SKILL.md` of the skill that triggers: the front matter, a three-line plugin-root anchor, the hard rules (a generated block between `<!-- hard-rules:start -->` and `<!-- hard-rules:end -->`), and a short load order. It is the only prose loaded in every Make session.
- **On demand.** `shared/workflows/` (a shared lifecycle split into `lifecycle`, `jira-ticket`, `push-changes`, `commit-compile`, `run-live`, `close-out`, plus one file per task kind) and `shared/references/` (each with a `> Read when:` header; the five largest are a main file plus topic parts in a same-named folder). `shared/index.md` lists them all.

### Hard rules

`shared/hard-rules.md` is the single source. `tools/sync-hard-rules.js` copies it verbatim into the block of every `SKILL.md`; CI fails on drift (`--check`). Never edit a generated block by hand. The source must not contain `${CLAUDE_*}`, `${user_config.*}`, `$ARGUMENTS`, `$0` to `$9`, a backslash before a dollar sign, or an exclamation mark followed by a backtick at a line start or after whitespace, because Claude rewrites or runs them when it loads a skill.

### Paths

Documents write `<plugin root>/shared/...`. The plugin root is the directory on the `Plugin root:` line at the top of the running skill. In a skill, `${CLAUDE_PLUGIN_ROOT}` is substituted only in a `SKILL.md` body and in `allowed-tools`, never in a file that is read with the Read tool, and it is not in the Bash environment. The `args` in `mcp.json` use it as well. Cursor leaves it literal when the model (not the user) invokes a skill, so the anchor carries a fallback: the root is two levels above the folder of the `SKILL.md`. A relative `../../shared` path in a skill fails on the first read in Claude Code.

### Skills and triggering

Skills trigger by description, so write the trigger first. `plugin-check.js` enforces the `Not for` clause, a plain one-line YAML value, a warning above 400 characters and a failure above 1,024, and a budget for the nine together. A skill may pre-approve exactly two scripts with `allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/shared/scripts/<name>.js"*)`: `check-setup` and `review-changes`. The quoted form is the one that matches: an unquoted command and any other script still prompt. All other scripts keep the harness permission prompt on top of the hard rules. Rerun the trigger test (spec section 11 item 8) after any change to a skill description; the pass mark is 18 of 20 positive prompts per editor.

Cursor often reads no skill for a natural prompt, so a `sessionStart` hook (`hooks/session-start.js`) adds one factual line that names the nine skills (measured with `--plugin-dir` and on the installed route; spec section 11 item 8). Claude Code does not need it and does not register it: the Cursor-format file `hooks/hooks-cursor.json` is named by the `hooks` field of `.cursor-plugin/plugin.json`, and `hooks/hooks.json` (the Claude format) must not exist, because it would add the line to every Claude session. `plugin-check.js` enforces this, including that the `hooks` field and `hooks/hooks-cursor.json` come together (the numbers and the decision are in spec section 5).

### Editor and contexts

Scripts resolve the editor with `shared/scripts/lib/paths.js`: the `--editor claude|cursor` flag, then `CLAUDECODE`, then `CURSOR_AGENT`, then the `editor:` line of the secrets file; there is no silent default, because the editor selects the Make credential source. App contexts live in `~/.make-custom-app/contexts` for both editors. Plugin-internal paths come from `__dirname`.

### MCP servers

`mcp.json` declares `make-app-context` (the committed bundle `mcp/index.mjs`), `make` (`https://mcp.make.com/v2`), and `atlassian` (`https://mcp.atlassian.com/v1/mcp`). Remote entries need `"type": "http"`, and the file holds no secret. The context server reads its keys from `MAKE_APP_CONTEXT_*` variables, then from `~/.make-custom-app-skill-secrets`. `mcp-server/lib/config.ts` treats a script path under `.../skills/make-custom-app/mcp-server/` as an old install (generic variable names, per-editor contexts folder) and every other path as the plugin. Rebuild and commit `mcp/index.mjs` with every change to `mcp-server/`; CI compares the bytes.

## CI

`.github/workflows/ci.yml` runs on every pull request and master push. Run the same commands locally before pushing.

- `mcp-server` (Node 22): `npm ci`, lint, build, test, and `node ../tools/build-mcp.js --check`.
- `legacy-bridge`: installs the 2.x skill in a fake `HOME` from this checkout and drives its built server (`tools/legacy-bridge.js`), while the installers exist.
- `skill-scripts` (Node 22 and 24): the script tests with coverage, for `shared/scripts` and for the old tree.
- `skill-check`: `check-skill.js` for the old tree (it reads the newest 2.x CHANGELOG entry, so the plugin entry above it is skipped), and `old-tree-guard.js`: on pull requests into other branches the old tree may change only in the seven bridge files of spec 8.2 and its versions stay; on pull requests into master and pushes to master the same files and `version.json` may change, and only with a higher `2.4.x` version in `version.json` and `skill/SKILL.md` together.
- `plugin-check`: the tests of the checks and tools, `plugin-check.js` (manifests, marketplace, hooks, `mcp.json`, skills, hard-rule drift, links, indexes, README script table, syntax), and the release rule (`--release-base`) for pull requests into master and for pushes to master.
- `plugin-validate`: `claude plugin validate` with a pinned Claude Code version.
- `migration`: `tools/migration-test.js` with Claude Code 2.1.312 from npm: the 2.x installers, phase A, and phase B in a throwaway `HOME` (real CLI, no login, no model).
- `lint-misc`: `shellcheck` on the two `.sh` installers and the two `.sh` shim drafts in `tools/shims/`, and `actionlint`.

## Scripts in `shared/scripts`

Plain Node CommonJS. No `package.json`, no build, no TypeScript. Cursor loads the same invariants from `.cursor/rules/skill-scripts.mdc`.

- `require()`, not ESM `import`.
- New entry script: `#!/usr/bin/env node`; `require('./lib/settings').takeEditorFlagOrExit(process.argv)` before anything reads `process.argv` (`setup-secrets.js` parses `--editor` itself instead); `require('./lib/access-guard').ensureInternalUser()` (`check-setup.js` and `setup-secrets.js` skip it because they report the account check themselves; `cleanup-legacy.js` skips it because it only moves local files and must work without a Jira token). `lib/__tests__/layout.test.js` and `entry-scripts.test.js` enforce this.
- Paths and the editor come from `lib/paths.js`; never rebuild them from `process.argv[1]`. Read config through `lib/settings.js`. Never print token values to logs or stdout.
- A script that needs tests keeps its I/O (network, files, exit codes) in `scripts/<name>.js` and its decisions as pure functions in `scripts/lib/<name>-logic.js`. Tests: `lib/__tests__/<name>-logic.test.js` and `lib/__tests__/<name>.test.js` (against a mock server, example: `run-component.js`).
- Adding or renaming a script: update the Scripts table of `README.md` (CI compares it with `shared/scripts/*.js`) and the scripts line of `shared/index.md`.

## Releases

See `.claude/CLAUDE.md`: after the merge to master every commit bumps `version` in both `plugin.json` files and the CHANGELOG (a `2.4.x` bridge commit that touches only the old tree is the exception); until then versions change only in the release commit, the last commit on the branch before the pull request into master.
