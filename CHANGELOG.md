# Changelog

## [1.11.7] - 2026-04-24

- `hooks/make-app-auto-actions-check.js` — fix §8 Developer Notes false-positive that re-prompted across sessions for tickets the user had already declined. The previous `detectDevNotesDecline` only matched explicit "no + notes-keyword" phrases (`"don't write developer notes"`, `"노트 적지마"`), so context-implicit Korean replies like `"ㄴㄴ"` / `"ㄴㄴ 작성하지마셈"` (right after the agent's "Developer Notes를 작성할까요?" prompt) were never recognized as declines and the hook kept asking forever. Detection now walks messages in conversation order and accepts a second form: a short standalone-negation user reply (`ㄴㄴ`, `ㄴ`, `아니`, `싫`, `필요없`, `no`, `nope`, `nah`, `skip`, `pass`, `decline`, `not now`, `no thanks`, …) immediately following an assistant turn that contained the dev-notes prompt. The original explicit-form regex is preserved for cases where the user volunteers a decline without being prompted.

## [1.11.6] - 2026-04-24

- `runtime-reference.md` — add new § "IML Variable Path Syntax" section documenting a critical gotcha verified against `imt-iml/lib/utils.js` `mapVariable`: **IML path indices are 1-based, not 0-based.** Includes a behavior table (`foo[]` = `foo[1]` = first element; `foo[0]` → `undefined`), implications for `response.output` / `response.iterate`, dynamic index evaluation, and the internal `` foo.`1` `` dotted-number stringify form.
- `SKILL.md` § "Important Notes" — add a one-liner on 1-based IML indexing and clarify that `{{body.results[].field}}` is the idiomatic way to unwrap a one-element response array into a scalar output, linking to the new runtime-reference section.
- `code-review-criteria.md` § "Out of Scope" — add a new sub-section "IML Path `[]` / `[1]` Shorthand (Do NOT flag as array wrap)" with a pattern table so reviewers stop incorrectly flagging `newMediaItemResults[].mediaItem`-style expressions as accidental array wraps and correctly flag `[0]` (which resolves to `undefined`) as a bug.

## [1.11.5] - 2026-04-24

- `download-app.js` — extend `metadata.json` to capture compilation + branding + per-zone visibility: `approved` (compilation state — `false` = not yet compiled, `true` = compiled), `compile`, `compilationError`, `theme`, `public`, `beta`, `language`, `countries`, `global` come from the SDK version endpoint; `ipmDeployedToZone`, `private`, `packagePrivate`, `deprecated` (and per-module `private` / `deprecated`) come from a second, admin-only call to `GET {zone}/api/v2/admin/apps/{slug}` matched to the requested major version. The admin call gracefully handles `200` / `403` / `404` (404 = compiled but not IPM-deployed to this zone) and leaves visibility flags `null` when the data is not available.
- `SKILL.md` § "Important Notes" — document two related but distinct concepts:
  1. `approved` reflects compilation state (not Make-team production approval).
  2. Scenario-builder visibility is governed by `versions[*].private` + `versions[*].deprecated` (and the same fields per-module). `private: false` + `deprecated: false` = visible & usable; `private: true` = hidden; `deprecated: true` = hidden in builder but kept in scenarios already using it. The visibility data only exists for apps **IPM-deployed to that specific zone** — `200` / `403` / `404` semantics on the admin endpoint are spelled out so reviewers do not misread a 404 as "app missing". `approved: true` is necessary but not sufficient for production visibility.
- `hooks/make-app-auto-actions-check.js` — fix §8 (Developer Notes) false positives:
  1. Skip §8 entirely for code reviews — Dev Notes are the developer's responsibility, not the reviewer's. Code reviews follow §7 of `make-app-code-review.mdc` (disposition prompt + `post-review-transition.js`) instead.
  2. Broaden the user-decline detector to Korean (`적는 게 아니다`, `쓰지 마`, `안 적`, `필요 없`, `스킵`, `됐다`, etc. adjacent to `dev note` / `developer notes` / `개발자 노트` / `노트`) and scan the **entire** user-message history instead of only the last message — once the user has declined, the rule says "skip, do not ask again" and the decision must persist across turns.
  3. Broaden the "already prompted" detector to match Korean wording (`Developer Notes를 작성할까요`, `개발자 노트 …` etc.) and to inspect `AskQuestion` tool inputs in addition to assistant prose.

## [1.11.4] - 2026-04-23

- Add `hooks/make-app-auto-actions-check.js` — Cursor stop hook that enforces the full `make-app-auto-actions.mdc` post-work checklist at session end. Blocks the stop event (with an actionable reminder) when any of the following are missing: §6 (IML function `test.js` update + `test-function.js` run after `code.js` change), §6-2 (`test-component.js` run after `api.imljson` change outside code review), §8 (Developer Notes offered/written after a write script + Jira ticket), §9 (`~/.cursor/make-app-contexts/{slug}-v{version}.md` update), §10 (`upsert_app_context` + `upsert_jira_ticket` per detected ticket), and post-review transition (`post-review-transition.js`) when the user replies "committed" / "returned". Fail-open on any internal error so it never breaks a session; `loop_limit: 1` prevents infinite loops.
- Ticket-key extraction is strict — scans only user messages and Jira MCP tool inputs (`getJiraIssue`, `editJiraIssue`, `upsert_jira_ticket`, …). Assistant prose, code blocks, shell command strings, and edit-tool arguments are ignored, eliminating false positives from example snippets or placeholder IDs.
- Hook also strips its own previously-emitted reason blocks from user-role messages before extracting keys, so a re-injected block from a prior `decision: block` cycle does not cause the hook to re-detect its own example tickets.
- Make-app-work detection relies on concrete tool_use signals only (`.imljson` edits, `make-app-contexts/` writes, SDK script invocations, `make-app` MCP calls) — no text-regex fallbacks, so skill-repo edits that merely mention IMLJSON terms do not trigger the checklist.
- `install.sh` / `install.ps1` now install `hooks/*.js` to `~/.cursor/hooks/` and merge-register the stop hook into `~/.cursor/hooks.json` (idempotent, never overwrites existing user hooks). Both installers also remove the legacy `check-make-app-ticket-sync.js` filename and its `hooks.json` entry from prior releases.
- `README.md` repository-structure tree, install blurb, and a new **Hook Scripts** section document the stop hook and its enforcement scope.

## [1.11.3] - 2026-04-23

- Add `skill/references/security-reference.md` — authoritative security checklist for Make app code review. Eight categories (credentials & secret handling, OAuth/connection flow, webhook signature & replay, SSRF, injection/prototype pollution/ReDoS, sensitive data exposure, environment & sandbox, output format) with severity (`C`/`H`/`M`), detection patterns, and fix guidance. Each finding gets a numeric ID (e.g. `1.2`, `3.1`) so reviews cite `[SECURITY][1.2]` for traceability.
- Add `skill/references/code-smells-reference.md` — quantitative quality thresholds (function length ≤40, cyclomatic ≤10, cognitive ≤15, params ≤4, nesting ≤3, duplication, return paths, boolean params) plus IMLJSON-specific smells (`A-*` for api.imljson, `P-*` for parameters/expect, `S-*` for samples, `I-*` for interface, `X-*` for cross-file). Findings cite `[QUALITY][A-01]` / `[QUALITY][function-length=62]`.
- Reshape `code-review-criteria.md` to point to the two new references instead of duplicating content. Security section is now a trigger list (which change types mandate opening `security-reference.md`); Code Quality keeps the JS design principles/smells tables but delegates thresholds and IMLJSON smells to `code-smells-reference.md`.
- Add `component-patterns-reference.md` § "OAuth2 Connection with Common Fallback" — documents why `installSpec.imljson` + `install.imljson` are mandatory when `connections/{name}/api.imljson` references `common.clientId` / `common.clientSecret`, with the admin-form + `parameters → common` mapping example.
- Add `code-review-criteria.md` § "Connection install + installSpec Verification" — mandatory reviewer step: grep `common\.` in `connections/{name}/api.imljson`; if hit and install files are empty, flag as bug (OAuth fallback resolves to empty → `invalid_client`).
- Add `code-review-criteria.md` § "Branding Consistency for Apps in an Existing Family" — mandatory reviewer step for new-app tickets sharing a prefix with published apps (e.g. `google-ads-*`): verify `app.theme` via admin API, check the family-shared logo, confirm label/description style.
- Expand Breaking Changes skip conditions in both `code-review-criteria.md` and `rules/make-app-code-review.mdc` — now skip for (1) App-type Jira tickets (entire app), and (2) per-change new-component creation inside existing apps (when the review diff has `new_value` only with no `old_value`). All skip cases must state the reason in Analysis.
- Update `install.sh`, `install.ps1` `REFERENCE_FILES` whitelist, `README.md` directory tree + reference table, and `SKILL.md` Detailed Reference list to register the two new references — required so `curl | bash` installs pick them up (local-clone installs already did via `cp *.md`).

## [1.11.2] - 2026-04-22

- Document URL normalization in `runtime-reference.md` — new `### URL Normalization` subsection under `## Requester / HTTP Details` explains the behavior of `lib/core/utils/normalizeUrl.js` and `joinBaseUrlAndUrl.ts`: consecutive slashes in `pathname` are collapsed (`\/{2,} → /`), but trailing slash on non-root paths is preserved (stripped only when `pathname === '/'`). Includes the IEN-15136 Adalo case as an example — apps must emit optional trailing path segments conditionally (`{{if(parameters.url, '/' + parameters.url, '')}}`) because the runtime will not strip an app-level trailing `/`. Also documents `baseUrl + url` join rules, path/QS encoding differences between `legacy` and `uniform` modes, default-port stripping, and hostname handling.

## [1.11.1] - 2026-04-22

- Document aliased connection runtime behavior in `component-patterns-reference.md` — new `### Aliased Connections (aliasTo)` section clarifies that when a connection has `aliasTo` set, all of its own IMLJSON files (`api`, `parameters`, `common`, `scope*`, `install*`) are **excluded at compile time** and the runtime resolves the connection entirely through the source connection referenced by `aliasTo`. Includes detection via admin API `/sdk/apps/{slug}/connections` response and `metadata.json connections[].aliasTo`.
- Correct the Base Pattern scope in `component-patterns-reference.md` and `SKILL.md` — `base.imljson` is inherited by **modules and RPCs only**, NOT by `connections/*/api.imljson` or `webhooks/*/api.imljson`. **Every** field in base (not just `baseUrl` / `headers` / `response.error` / `log.sanitize`, but any key at all) is ignored for connection and webhook contexts; those components are standalone and must re-declare everything they need. Previous docs incorrectly claimed base applied to webhooks too.
- Add `### Aliased Connections` mandatory check to `code-review-criteria.md` — reviewers must consult `metadata.json connections[].aliasTo` before evaluating any `connections/{name}/*.imljson` change; edits on aliased connections are runtime no-ops and must be flagged with that caveat even when the verdict is LGTM.
- Fix `download-app.js` dropping connection metadata — the `connections.map` now captures `type` and `aliasTo` (with `alias_to` snake_case fallback) into `metadata.json`, matching what the admin API already returns. Previously only `name` and `label` were persisted, which hid alias relationships from the agent.

## [1.11.0] - 2026-04-20

- Add `post-review-transition.js` script — assigns a Jira ticket to the authenticated user (`/myself`) and transitions the ticket after a code review. `committed` → "In Testing" (from "Commit" or "Compilation"); `returned` → "In Progress" (from "Commit") or "To Do" (from "Compilation", since that workflow has no direct "In Progress" transition). Supports `--force` override and `--from-status=<name1,name2>` customization.
- Wire the new script into `make-app-code-review.mdc` § 7 (Post-Review Auto-Actions) and `make-app-auto-actions.mdc` § 3 so it runs automatically when the user replies "committed" / "returned to developer" after a review.
- Fix `install.sh` `set -e` + subshell regression — when `npm install`, `npm run build`, or `node register.js` failed, the installer aborted before reaching the Jira credentials / runtime paths restore block, silently wiping `jira-email`, `jira-api-token`, `imt-app-runtime-path`, etc. The failing subshells are now guarded by `if (...); then` so only the post-check branch reacts to the failure.
- Harden `SKILL.md` credential parsing in `download-jira-ticket-attachment.js` and `post-review-transition.js` — skip markdown blockquote lines (`> ...`) from the setup guide, filter obvious placeholders (`your-*`, `user@example.com`, `ATATT3x...`), and use last-wins so real credentials appended at the end of the file take precedence over setup-guide examples.

## [1.10.18] - 2026-04-17

- Document new `{ errorType, message }` object form for component test error output in `component-test-guide.md` § "Error Output" — supports asserting error class (e.g., `ConnectionError` vs `RuntimeError`) in addition to the error message. Backwards-compatible with the legacy string form. Requires the matching `test-runner.ts` extension in `make-apps-mockup` (shipped together)

## [1.10.17] - 2026-04-17

- Add "Out of Scope" section to `code-review-criteria.md` — explicitly exclude formatting and indentation changes (whitespace, tabs ↔ spaces, whole-file re-indentation) from code review output to reduce noise; reviewers should use `diff -w -u` to extract the real logical change

## [1.10.16] - 2026-04-17

- Document `mappable` override pattern in `parameters-reference.md` — spec properties (verified: `help`) can be overridden only when the user flips the Map toggle on, useful for RPC-backed select fields that need different guidance for dropdown vs mapping UI

## [1.10.15] - 2026-04-16

- Add auto-action rule 11: recommend context compaction after all task TODOs are completed to prevent context degradation in long sessions

## [1.10.14] - 2026-04-15

- Skip Breaking Changes evaluation for "App" type Jira tickets (new apps not yet deployed to production)
- Add `issuetype` to `getJiraIssue` fields for automatic ticket type detection
- Filter subtasks by status: skip "Done" (QA verified), review "Complete" (awaiting QA)

## [1.10.13] - 2026-04-14

- Inject `debug` as no-op into test-function.js sandbox so IML functions using `debug()` (e.g., `parseBatchResponseBody`) no longer fail with "debug is not defined"

## [1.10.12] - 2026-04-14

- Add work-discipline rule 5 "Test Completeness by File Type": require cross-referencing changed file types against auto-actions rules to include all required test types (function test, component test) in TODO planning from the start

## [1.10.11] - 2026-04-14

- Strengthen work-discipline rule 6 "Never Fabricate or Assume": add Self-Check Before Writing Any Spec Property sub-section with 3-step verification questions
- Consolidate Proactive Reference Re-Read for `interface.imljson`, `expect.imljson`, and `parameters.imljson` into a single entry requiring `parameters-reference.md` + `app-ux-best-practices.md` re-read + existing code pattern check
- Add universal fallback rule: if not documented and not in existing code, do NOT use it — ask the user

## [1.10.10] - 2026-04-10

- Auto-sync mockup repo before component tests: `test-component.js` now runs `git checkout master && git pull origin master` on the mockup repo before executing tests to ensure test data is always up-to-date

## [1.10.9] - 2026-04-10

- Replace manual version check (show warning + stop) with auto-update: agent now runs `install.sh --update` automatically via Shell tool when outdated, re-reads updated SKILL.md, and proceeds without blocking the user

## [1.10.8] - 2026-04-09

- Add breaking change rule to `code-review-criteria.md`: never suggest renaming existing expect parameter names for consistency — renaming destroys user mappings in production scenarios; use api.imljson mapping (temp or explicit body) to convert to API-expected format instead

## [1.10.7] - 2026-04-09

- Document undefined parameter handling in `runtime-reference.md`: IML evaluates unset `{{parameters.x}}` to `undefined`, `_.merge` skips undefined in temp, `JSON.stringify` omits undefined keys in body — explicit body mapping and temp patterns do NOT send empty values for unfilled fields
- Add false-positive prevention rule to `code-review-criteria.md`: do not flag explicit body mapping as "sending empty values" bug

## [1.10.6] - 2026-04-09

- Add "ID Select Fields: `mode: edit` and Nested RPC Usage by Module Type" to UX best practices — document that Get/Update/Delete modules use flat `rpc://` with `mode: "edit"` (no nested RPCs needed)
- Add "ID Select Field Pattern (Do NOT flag as Improvement)" to code review criteria — prevent false-positive improvement flags on Get/Update/Delete module ID fields

## [1.10.5] - 2026-04-09

- Rewrite `builtin-iml-functions.md` from IML source code (`@integromat/iml` package): add return types, operator precedence table, ALT_OPS aliases (`===`→`=` loose equality), `+` operator type detection, Decimal.js precision notes
- Add missing functions: `dateDiff`, `toArray`, `first`, `last`
- Add dedicated Operators, Keywords, and Variables sections with source file references
- Document `emptystring` behavior (`new String('')` vs primitive `""`)
- Document `formatDate` always returns string (even for numeric formats like `'X'`)

## [1.10.4] - 2026-04-09

- Fix Windows CRLF line endings breaking markdown section parsing in MCP chunker (`split('\n')` → `split(/\r?\n/)`)
- Add append-only upsert for Work History sections: fetch existing Pinecone vector and merge rows (dedupe by Date+Task) before upserting, preventing loss of previous work history entries
- Add `mergeWorkHistory()` utility and tests

## [1.10.3] - 2026-04-08

- Fix Removed Code Verification rule: remove misleading `parameters.apiKey` example, rebalance from "assume removal is safe" to bidirectional verification, emphasize caller-context check (step 3) for RPCs called from connection parameters

## [1.10.2] - 2026-04-08

- Add `download-jira-ticket-attachment.js` script for downloading Jira ticket attachments (images, videos) via REST API
- Add Jira attachment auto-download and analysis rules to auto-actions (4-1) and code-review (Step 1)
- Add mockup repo PR must include Jira ticket URLs rule (6-1)
- Add Jira credential setup section to SKILL.md (`jira-email`, `jira-api-token`, `jira-base-url`)
- Preserve and restore Jira credentials during skill install/update (`install.sh`, `install.ps1`)
- Update README with new script in directory tree and script table

## [1.10.1] - 2026-04-08

- Add "Cross-Module Pattern Verification" rule to code review: when flagging a missing feature in one component, search ALL components for the same pattern and report the complete list

## [1.10.0] - 2026-04-08

- Refactor repo structure: separate Rules (directives), Workflows (process), and References (detailed criteria)
- Extract detailed review criteria from `make-app-code-review.mdc` (401→211 lines) into new `code-review-criteria.md` reference (ES6+, code quality, test coverage, UX, runtime verification, polling triggers)
- Merge `make-app-ux-guideline.mdc` into `make-app-auto-actions.mdc` as "5-1. UX Reference Before UX Changes" — remove standalone file
- Deduplicate `code-review.md` workflow (143→69 lines) — remove inline Review Criteria and Output Format, reference rule and criteria docs instead
- Add root `.gitignore` for `.DS_Store`
- Remove garbage files from git tracking (`--version/metadata.json`, empty `node` file)
- Simplify installers: use directory-level copy (`cp *.md`) for local install mode instead of per-file iteration
- Add deprecated rule cleanup migration to installers (`make-app-ux-guideline.mdc`)
- Update README: fix rule install path, add `work-discipline.mdc` and `code-review-criteria.md`, remove deprecated entries

## [1.9.1] - 2026-04-07

- Expand "Proactive Reference Re-Read" triggers: add test.js, component test, Jira fetch, expect/parameters re-read rules
- Add mandatory re-read of `custom-functions-reference.md` before writing IML function tests (assert conventions)
- Add mandatory re-read of `component-test-guide.md` before writing/running component tests
- Enforce explicit `getJiraIssue` fields list with Developer Notes (`customfield_10483`) and API Docs URL (`customfield_10283`)
- Include `runtime-reference.md`, `communication-reference.md`, `component-patterns-reference.md`, `examples.md` in api.imljson re-read list

## [1.9.0] - 2026-04-07

- Set all rules to `alwaysApply: true` for 100% enforcement when skill is active
- Add "Removed Code Verification" rule to code review — verify removed code's necessity before flagging as bug
- Remove `make-app-rules-loader.mdc` — redundant with skill description auto-detection
- Move `version-sync.mdc` to workspace-only rule (`.cursor/rules/`) — not installed globally
- Remove duplicate code-review sections from auto-actions (Fresh Fetch, Review Tests, Review Component Tests)
- Trim work-discipline "Proactive Re-Read" to references only (rules now auto-applied)
- Remove "Mandatory Rules" section from SKILL.md (rules auto-injected)
- Renumber auto-actions sections after dedup
- Update install.sh and install.ps1 rule file lists

## [1.8.14] - 2026-04-07

- Add component-test-guide.md reference — make-apps-mockup architecture, test.js structure, capture() args, executor types, test discovery, debugging
- Register component-test-guide.md in install.sh, install.ps1, README.md, and SKILL.md

## [1.8.13] - 2026-04-07

- Rewrite rules-loader to auto-detect Make app topics and activate skill immediately, instead of relying on agent to recognize skill relevance

## [1.8.12] - 2026-04-07

- Add epoch.imljson temp key dependency section to polling-trigger-guide
- Add epoch temp key checklist item to code review polling trigger checklist

## [1.8.11] - 2026-04-07

- Add app-level `install`/`installSpec` download support to `download-app.js`
- Add `install`/`installSpec` component type support to `update-app.js`
- Fix `update-app.js` to use `application/json` content-type for `common` component (was incorrectly using `application/jsonc`)

## [1.8.10] - 2026-04-02

- Fix install.sh source detection for `curl | bash` — when BASH_SOURCE[0] is empty, dirname returns "." which resolves to cwd; if cwd is the repo, local (stale) files were copied instead of downloading from GitHub

## [1.8.9] - 2026-04-04

- Add `required` validation behavior documentation to parameters-reference — documents why collection enforces `required` on child fields but array does not, with source-level explanation from `imt-forman` and practical implications

## [1.8.8] - 2026-04-01

- Add Agency Module Pattern section to component-patterns-reference — documents on-prem agent architecture, agency directive IMLJSON structure, dual timeout model, runtime internals, pagination, and caveats

## [1.8.7] - 2026-04-01

- Add "Proactive Rule & Reference Re-Read" section to work-discipline rule — enforce re-reading IML function reference, runtime docs, and rule files in long conversations to prevent hallucination (e.g., fabricating non-existent `set()` function)

## [1.8.6] - 2026-03-31

- Use full absolute paths for `test-function.js` and `test-component.js` in all rule/skill docs — prevents script-not-found errors when running from app repo directory
- Clarify `make-apps-mockup` repo role as test data (mockup fixtures), not the test framework itself

## [1.8.5] - 2026-03-31

- Fix test-component.js hanging when no component names provided — add `input: '\n'` to execSync so readline prompt auto-completes

## [1.8.4] - 2026-03-30

- Add "Code Quality & Maintainability" enforcement section to `make-app-code-review.mdc` — reviews changed functions as a senior JS engineer
- Flag design principle violations: Data over branching, DRY, Open/Closed, Single Responsibility, Declarative over imperative
- Flag code smells: spaghetti flow, god functions, magic values, in-place mutation, boolean blindness, null/undefined juggling, dead code, inconsistent return types
- Add 4-point review checklist: Structure, Extensibility, Readability, Testability

## [1.8.3] - 2026-03-30

- Isolate rule files into `~/.cursor/rules/make-custom-app/` subdirectory — prevents overwriting user's own rules during skill install/update
- Add migration logic to installers (bash/PowerShell) — auto-removes old rule files from `~/.cursor/rules/` on upgrade
- Change 4 skill rules to `alwaysApply: false` — rules are now loaded only when the make-custom-app skill is activated via SKILL.md
- Add "Mandatory Rules" section to SKILL.md — explicitly loads all rule files on skill activation
- Add `work-discipline.mdc` — enforces systematic work habits (full impact analysis, no piecemeal fixes, AC scope discipline, context degradation management)

## [1.8.2] - 2026-03-30

- Add full RPC middleware chain to `runtime-reference.md` — documents URL-less RPC execution flow where `response.temp` and `response.output` still execute normally
- Document temp same-block evaluation rule — variables in the same `temp` block are evaluated simultaneously and cannot reference each other; use two-phase `temp` + `response.temp` pattern instead
- Document that only `temp` and `response.temp` exist — `temp2`, `temp3`, etc. are not valid runtime features
- Add strict runtime feature verification rule to `make-app-auto-actions.mdc` — never fabricate or assume non-existent IMLJSON directives; verify in runtime-reference.md or imt-app-runtime source first
- Add temp two-phase pattern reference link to SKILL.md
- Add auto-action 7-3: auto-run component integration tests when creating/updating `api.imljson` outside of code review — run existing tests, create new tests if none exist, append test cases for new behavior

## [1.8.1] - 2026-03-30

- Fix `download-app.js` to save `manifestVersion` in `metadata.json` — resolves local integration test failures caused by incorrect IML `passthrough` setting (defaulted to manifest v1 instead of v2)

## [1.8.0] - 2026-03-26

- Add `test-component.js` wrapper script for component integration tests (modules, RPCs, connections, webhooks, instant triggers)
- Add `imt-app-runtime-path` blocking check — skill will not proceed until runtime path is configured in SKILL.md
- Add auto-run `test-component.js` during code review when `api.imljson` files are changed
- Update install scripts to preserve `make-apps-mockup-path` setting during updates
- Update SKILL.md with component integration test documentation and `make-apps-mockup-path` config
- Update README with `test-component.js` in repository structure and script files table

## [1.7.3] - 2026-03-25

- Add runtime-provided IML functions to `test-function.js` — load `mime`, `jwt`, `generateJwtWithKeyId`, `cryptoSign`, `errorFactory`, `pop`, `shift`, `isArray`, `parseJSON`, `createJSON`, `createXML`, `parseXML` from `imt-app-runtime` (12 functions total)
- Fix `composeRawMessageContents/test.js` base64 decode logic — replace `iml.base64()` encoder with `Buffer.from(..., 'base64')` decoder

## [1.7.2] - 2026-03-25

- Add `_.merge` array behavior documentation to runtime reference — document index-by-index deep merge, ghost properties, cascading reference contamination, and safe vs dangerous patterns for temp array keys (IEN-14758)

## [1.7.1] - 2026-03-25

- Add minimal change principle to bug investigation workflow — bug fixes must not modify existing business logic, and breaking change check is required before pushing
- Add temp + pagination caveat to runtime reference — document `ifempty` pattern to prevent pagination cycles from overwriting temp values

## [1.7.0] - 2026-03-20

- Add `test-function.js` — local IML function test runner matching Make Apps SDK extension behavior (code+test merged execution, `environment.timezone`, `this.timezone` binding for custom functions, UTC default timezone, `--tz=` option)
- Add `polling-trigger-guide.md` — dedicated reference for polling trigger implementation (order selection, date filtering, epoch configuration, examples)
- Add auto-run test rule to code review workflow — automatically run `test-function.js` when `functions/*/code.js` changes are detected
- Update `app-ux-best-practices.md` — clarify runtime default error handling for 429/5xx, consolidate polling trigger section with link to dedicated guide
- Update `component-patterns-reference.md` — add runtime default error handling notes, update trigger pattern to recommend `asc` + date filter
- Update `examples.md` — add runtime default error handling note to base.imljson 429 example
- Update `custom-functions-reference.md` — add local test runner usage with `--tz` option
- Update `make-app-auto-actions.mdc` — add `test-function.js` to read-only scripts, add rule 7-1 for auto-run tests during code review
- Update `make-app-code-review.mdc` — add auto-run tests section, refine polling trigger checklist with link to dedicated guide

## [1.6.5] - 2026-03-20

- Remove `required: true` from Search module limit parameter spec in SKILL.md — limit is not mandatory for Search modules
- Add "Runtime Default Error Handling" section to code review rules — clarify that 429→RateLimitError and 5xx→ConnectionError are handled automatically by imt-app-runtime, so missing explicit error type definitions should not be flagged
- Add "Polling Trigger: Date Filtering as Alternative to Sorting" section to code review rules — guide reviewers to check for date filtering (e.g., `createdAt[$gte]`) as an alternative when API doesn't support sorting by trigger date field

## [1.6.4] - 2026-03-20

- Use IPME auto-detection for app version in code review rule when only app-slug is provided, aligning with workflow behavior

## [1.6.3] - 2026-03-20

- Add mandatory context loading step (Step 2) to code review workflow — load local context file and search Pinecone before analyzing changes to detect re-reviews, known caveats, and prior issues

## [1.6.2] - 2026-03-18

- Add `public` field support to `update-component.js` for toggling module visibility (`public=true` / `public=false`)

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
