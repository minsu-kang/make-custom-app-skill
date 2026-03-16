# Changelog

## [1.6.1] - 2026-03-16

- Move `scripts/` into `skill/scripts/` for consistent domain container structure
- Update install.sh and install.ps1 source paths from `scripts/` to `skill/scripts/`

## [1.6.0] - 2026-03-16

- Extract workflows from SKILL.md into `workflows/` folder (882→~300 lines in SKILL.md)
  - `app-context.md` — App detection, code download/sync, context management
  - `code-review.md` — Fetch changes, perform review, generate report
  - `bug-investigation.md` — Root cause analysis, fix, verify, developer notes
  - `feature-request.md` — Design, create, implement new app components
  - `app-task.md` — Metadata changes, UX fixes, refactoring, deprecation
  - `pinecone-sync.md` — Auto-sync context to shared Pinecone vector DB
- Add workflow routing table to SKILL.md for trigger-based workflow dispatch
- Update install.sh and install.ps1 to install workflow files from `skill/workflows/`

## [1.5.5] - 2026-03-13

- Add App Version Auto-Detection via IPME API — when user provides app name without version, auto-detect latest major version from `https://ipme.integromat.com/v3/search/apps`
- Update App Detection steps in all workflows (Context Management, Code Review, Bug Investigation) to reference IPME auto-detection

## [1.5.4] - 2026-03-12

- Add Environment Variables section to runtime-reference.md — document scenario environment (`{{environment.timezone}}` etc., always available) vs server environment access (`flags.environmentAccess` for `process.env` via `{{environment.system.VAR}}`)
- Fix misleading note in SKILL.md that implied `environment` access requires `flags.environmentAccess`
- Add Runtime Reference Lookup rule to auto-actions — consult runtime-reference.md (then imt-app-runtime source) for all api.imljson work (code reviews, bug fixes, features, new apps)
- Add Runtime Behavior Verification section to code review rules

## [1.5.3] - 2026-03-11

- Document that `limit` middleware works independently from `iterate` in runtime-reference — verified from imt-app-runtime source that `limit` applies `slice(0, limit)` on any array result regardless of `iterate` usage

## [1.5.2] - 2026-03-10

- Added UX Guideline Compliance section to code review rules — verify label naming, hint formatting, and terminology accuracy against UX best practices
- Added new rule `make-app-ux-guideline.mdc` — enforces reading UX guidelines before any UX-related changes
- Added Title Case exception to UX best practices — follow app's existing convention if consistently Title Case

## [1.5.1] - 2026-03-09

- Added `help` text evaluation guideline to code review rules — distinguish redundant help (label restatement) from meaningful help (format guidance, constraints)

## [1.5.0] - 2026-03-06

- Added ES6+ enforcement rule for code reviews — all changed/new lines in `functions/*/code.js` must follow ES6+ conventions
- Added test coverage enforcement — changed functions must have corresponding test.js with tests covering the new behavior
- Added per-change review template fields for ES6+ violations and test coverage status
- Added To Developer message rule requiring all issue categories (bugs, ES6+, tests) to be included
- Added post-review auto-actions — prompt user for ticket status, then auto-execute context file update and Pinecone sync
- Added re-review process guide with previous issues resolution tracking

## [1.4.11] - 2026-03-06

- Added path existence validation when restoring user config during reinstall
- Skip and warn if saved `imt-app-runtime-path` or `mcp-server-path` directory no longer exists

## [1.4.10] - 2026-03-06

- Fixed installer config preservation to avoid duplicates on reinstall
- Use `tail -10` instead of full-file `grep` to only capture real user config (not in-doc examples)
- Filter out template values (`/path/provided`, `{path-to`) during preserve step

## [1.4.9] - 2026-03-06

- Fixed installer to preserve both `imt-app-runtime-path:` and `mcp-server-path:` on reinstall/update
- Removed hardcoded `imt-app-runtime-path` from source SKILL.md (user-local only)
- Changed config detection from `tail -1` to `grep` for reliable multi-config preservation

## [1.4.8] - 2026-03-06

- Added all reference files to README.md (tree structure and file table)

## [1.4.7] - 2026-03-06

- Added new reference files to installer file lists (install.sh, install.ps1)

## [1.4.6] - 2026-03-06

- Updated `version-sync.mdc` with semver auto-bump and CHANGELOG workflow on commit

## [1.4.5] - 2026-03-06

- Extracted 4 large reference sections (~500 lines) from SKILL.md into dedicated files (1323→835 lines)
  - `parameters-reference.md` — Parameters, Interface, RPC Dynamic Options
  - `component-patterns-reference.md` — Base, Connection, Error Handling, Webhook, Trigger, Responder
  - `developer-notes-templates.md` — Bug Fix, Feature templates
  - `custom-functions-reference.md` — code conventions, test.js, size limits
- Enriched `component-patterns-reference.md` with detailed explanations, field tables, and additional examples

## [1.4.4] - 2026-03-06

- Added Developer Notes auto-prompt after Jira ticket work completion
- Added IML function 5000 character size limit warning (`IM005`)
- Added ADF table format requirement for Developer Notes

## [1.4.3] - 2026-03-06

- Read-only scripts (`download-app.js`, `review-changes.js`) now auto-execute via Shell tool — no more manual external terminal
- Write scripts (`update-app.js`, `create-component.js`, `update-component.js`, `delete-component.js`) require user approval before auto-execution
- Removed "External Terminal Only" rule from auto-actions
- Updated code review, bug investigation, and post-commit sync workflows to auto-execute

## [1.4.2] - 2026-03-06

- Jira-driven code review now strictly filters to ticket-related changes only — unrelated changes are excluded entirely from review output
- Added mandatory subtask and comment fetching enforcement in code review Step 1

## [1.4.1] - 2026-03-06

- Added `app-ux-best-practices.md` to installer file list (macOS/Linux + Windows)
- Added expect.imljson limitations note (no IML expressions, no condition, editable deprecated)

## [1.4.0] - 2026-03-04

- Added IML function `test.js` mandatory rule with `assert.deepStrictEqual` / `assert.strictEqual` examples
- Added Dynamic Interface via RPC documentation with mapped parameter handling patterns (`isImlVariableIncluded`, `validateID`)
- Added Developer Notes `Changed Files` rule: mark each file as **(new)** or **(modified)**
- Updated RPC Dynamic Options section with conditional RPC flags and nested parameter inheritance
- Updated Module Type Selection with `type_id` table and `iterate` restriction (Search only)
- Added ES6+ code conventions for IML functions

## [1.3.9] - 2026-03-04

- Added Apps UX best practices reference (`app-ux-best-practices.md`) covering naming, hints, fields, messages, and all IEN UX guidelines from Confluence
- Fixed `create-component.js` module creation to use `typeId` instead of `type_id`

## [1.3.8] - 2026-03-04

- Added missing `make-app-auto-actions.mdc` to installer rule file list

## [1.3.7] - 2026-03-04

- Installer update mode now cleans old files before reinstalling (preserves `.env` and `imt-app-runtime-path`)
- Scripts installed to `scripts/` subdirectory instead of skill root

## [1.3.6] - 2026-03-03

- Restructured `make-app-auto-actions.mdc` into Before/During/After phases
- Expanded `make-app-code-review.mdc` with Jira-driven review process, AC coverage table, and Developer Message section

## [1.3.5] - 2026-03-03

- Updated README with `update-app.js` and `make-app-auto-actions.mdc` documentation

## [1.3.4] - 2026-03-03

- Added version check, code download/sync first, external terminal only, and fresh fetch before code review rules to `make-app-auto-actions.mdc`

## [1.3.3] - 2026-03-03

- Added Windows support for settings path in `download-app.js`, `update-app.js`, `review-changes.js`
- Fixed `update-app.js` to use `application/javascript` content type for function code uploads
- Added `apiPut` content type parameter for flexible content type handling
- Added `make-app-auto-actions.mdc` rule to enforce auto context update, Pinecone sync, and related ticket lookup
- Added QA subtask investigation workflow to rule (Pinecone search → local context → investigation)

## [1.3.2] - 2026-03-03

- Added `downloadedAt` timestamp to `metadata.json` in `download-app.js`
- Added freshness check workflow to SKILL.md (1h fresh / 1–24h info / 24h+ recommend re-download)
- Legacy metadata without `downloadedAt` is treated as stale

## [1.3.1] - 2026-03-03

- Added commit checklist to code review output format for easier SDK commit tracking

## [1.3.0] - 2026-03-03

- Added `update-app.js` script to push code changes directly to Make via SDK Admin API
- Updated Bug Investigation Workflow (Step 7) to use `update-app.js` instead of manual SDK editing
- Updated Code Review Workflow to reference `update-app.js` for applying fixes
- Added "App Code Update" section to SKILL.md documenting `update-app.js` usage and component path format

## [1.2.0] - 2026-03-02

- Added `install.ps1` — Windows PowerShell installer with full feature parity to `install.sh`
- Updated `README.md` with OS-specific installation instructions (macOS/Linux + Windows)

## [1.1.0] - 2026-03-02

- Added MCP server for shared app context via Pinecone vector DB
- Added Pinecone auto-sync workflow to SKILL.md (triggers on context save, Jira work, code review)
- Added interactive MCP server setup to install.sh (API key input, auto-register)
- Added `register.js` script for automated Cursor MCP registration
- Added ESLint with TypeScript + Prettier flat config to mcp-server
- Added Vitest with 44 unit/integration tests for mcp-server
- Improved MCP server detection logic (auto-detect default installed path)

## [1.0.3] - 2026-03-02

- Moved scripts (`download-app.js`, `review-changes.js`) to separate `scripts/` folder
- Updated `install.sh` to install scripts from `scripts/` directory
- Translated all Korean text to English in `skill/SKILL.md` and `scripts/download-app.js`

## [1.0.2] - 2026-03-02

- Added `version-sync.mdc` rule to keep `version.json`, `skill/SKILL.md`, and `CHANGELOG.md` in sync
- Added `CHANGELOG.md` for tracking release history
- Updated `install.sh` to install scripts from `scripts/` directory
- Updated `README.md` with `version-sync.mdc` documentation
- Removed `changelog` field from `version.json` (replaced by `CHANGELOG.md`)

## [1.0.1] - 2026-03-02

- Version check system test

## [1.0.0] - Initial Release

- SKILL.md: IMLJSON patterns, app context management, code review, bug investigation workflows
- download-app.js: App source code downloader with dynamic concurrency and retry
- review-changes.js: Uncommitted changes fetcher for code review
- Reference docs: builtin-iml-functions, communication-reference, examples, runtime-reference
- Rule: make-app-code-review.mdc
- install.sh: One-liner installer with update/force modes
