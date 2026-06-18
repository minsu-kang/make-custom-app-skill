# Changelog

## 1.16.0 — 2026-06-18

- **New `skill/references/runtime-reference.md` § "ISC (Internal Service Communication)" — documents the `isc` directive (imt-app-runtime v1.100.0, 2026-05-22, PR #663).** The `isc` directive lets Make-owned SDK apps call Make's own internal services (JWT mutual auth via `@integromat/isc`) instead of a public third-party API; the first consumer is `ai-module-builder-api` (the "Polymorph" / AI Module Builder modules). The new section covers: directive shape (`isc: { service }` + required relative `url`, base URL from `INTEGROMAT_ISC_<SERVICE>_URN` env, **not** `base.imljson`); middleware position (`agency ? isc.initialize() ? prepareRequestOptions`) and request bypass (`REQUEST_MODE.DISABLED` + `responsePrePopulated`); the 7 ordered preconditions that each throw `RuntimeError` (non-empty `isc.service`, `flags.allowISC` allowlist, no `pagination`, no `encodeUrl`/`encodeUrlMode`, **`url` required**, `packageName`, per-service env vars); standard-requester parity (method/headers/qs/body/timeout); error mapping (4xx / 429?RateLimitError / 5xx?ConnectionError / network?RuntimeError); the defense-in-depth security model; limitations; and **code-review implications** (a url-less ISC component is a blocking bug — NOT a benign pure-data RPC; mocked component tests do not exercise ISC validation; `flags.allowISC` + `INTEGROMAT_ISC_*` env are deployment config out of code-review scope; never false-flag `isc`/`getFieldMapping`/`safeSerialize`). Also cross-linked the existing "URL-less RPCs" note to warn that the URL-less fallback does **not** apply when `isc` is present. Trigger: IEN-15506 (google-calendar v5 "Add Polymorph AI module") review — the `getParameters` RPC had its `url` commented out, which throws at runtime under `isc`; `isc` was undocumented in the skill and had to be learned from the runtime source.

- **`skill/workflows/code-review.md` + `rules/make-app-todo-review.mdc` — `### Commit Checklist` is now an enforced, unconditional part of every review output.** The Review Output Format already listed a `### Commit Checklist` block, but it was treated as skippable on an `LGTM` verdict — an agent could (and did) end the output at `### Overall Verdict` / the suggestions list and omit the commit message entirely, then only produce it when the user asked. Added an **"Output Completeness Gate"** to `code-review.md`: the review output is incomplete/invalid without the Commit Checklist, for **every** verdict (`LGTM`, `LGTM (with suggestions)`, `Changes Requested`, `Needs Discussion`); it is the last block of every review, emitted in the same message as the verdict, and is independent of the conditional "To Developer" message. Marked the checklist heading `(MANDATORY — every verdict, including LGTM)`. Strengthened the § R template's `review_output` item to require the Commit Checklist for every verdict and call out that stopping at Overall Verdict/suggestions is a format violation. Trigger: a google-photos v2 (IEN-11341) LGTM review omitted the Commit Checklist and only emitted the commit message after the user demanded it twice.

## 1.15.1 — 2026-06-05

- **New `skill/references/component-scaffold-templates.md` — the SDK default component scaffolds, used to detect new components during code review.** When the SDK creates a new module/RPC/webhook/connection, the files are pre-filled with Make's default scaffold boilerplate; `review-changes.js` then reports that boilerplate as the change's `old_value`. The new reference snapshots every per-type scaffold from the `model` template app (slug `model`, v1 — `download-app.js model 1`): module `api` per `typeId` (Action/Create/Update/Delete, Search, Trigger, InstantTrigger, Responder, Universal, UniversalGraphQL, blank), RPC, webhook (dedicated/shared), and all 8 connection auth types (API Key, Basic, Other, OAuth2 auth-code, OAuth2 auth-code+refresh, OAuth2 client-credentials, OAuth2 resource-owner, OAuth1). A change's `old_value` is matched against these to decide whether a component is genuinely new.
- **`skill/workflows/code-review.md` § 7 + `skill/references/code-review-criteria.md` — Breaking-Changes skip extended + new-component handling clarified.** Previously the only per-change skip was "no `old_value`". Added a third skip case: **`old_value` is the `model` scaffold template** ? the component is effectively new ? skip Breaking Changes. Also clarified: (a) the `old_value ? new_value` diff is reviewed **only when `old_value` is a real prior implementation** — when it is the scaffold, skip the diff and judge `new_value` standalone (quality of `new_value` is always reviewed); (b) **never run Breaking-Changes verification on a new component** (no `old_value` or scaffold `old_value`) — Breaking applies only to real existing components, including shared components (`base`, a shared RPC) a new-component task happens to touch; (c) a new module's **publish/visibility state (`private: true`/`null`) is never a finding** — the deployer makes it public after QA. Verification is deterministic: compare `old_value` against the matching template in `component-scaffold-templates.md`. Trigger: github v4 IEN-15217 review (new `searchItems`/`watchCreateOrUpdateItems` modules whose `old_value` was the Search/Trigger scaffold) — the publish-state was over-flagged and the scaffold-`old_value` case was undocumented.
- **All 4 installers + README + SKILL.md synced** — `component-scaffold-templates.md` added to every `REFERENCE_FILES` array (`install-cursor.sh`, `install-cursor.ps1`, `install-claude.sh`, `install-claude.ps1`), the README Skill Files table, and the SKILL.md Detailed Reference list, per the install-sync rule.

## 1.15.0 — 2026-06-04

- **New `skill/scripts/lib/version-guard.js` — enforces the SKILL.md version check in code (deterministic, no longer agent-discretionary).** The "Version Check & Auto-Update" step in `SKILL.md` is an agent instruction, so a fresh session (fresh agent, no memory of the rule) silently skips it and can run an entire task on a stale skill. The guard moves the check into code: `ensureFreshSkill()` runs at the **top of every entry script** — `download-app.js`, `review-changes.js`, `update-app.js`, `create-component.js`, `update-component.js`, `delete-component.js`, `test-function.js`, `test-component.js`, `post-review-transition.js`, `download-jira-ticket-attachment.js`. It compares the **installed** skill's `SKILL.md` version against the remote `version.json`; on an outdated install it auto-runs the matching installer (`install-{cursor,claude}.{sh,ps1}` `--update`), verifies the update took (no loop on a silently-failed installer), then exits asking the caller to re-run against the fresh skill. **Fail-open** on any network/read error (never blocks work when GitHub is unreachable), and the remote `version.json` is fetched at most once per hour via a tmp-dir cache, so the common already-fresh path costs ~0. Editor (`.cursor`/`.claude`) and platform (`sh`/`ps1`) are auto-detected via `lib/skill-root.js`. Trigger: a code review (IEN-15472, microsoft-email v2) ran to completion on a stale `1.14.12` install because the manual version check was skipped — only caught when the user asked directly. Known gap: pure-conversation sessions that run no script are still uncovered (that is `sessionStart`-hook territory).
- **`skill/SKILL.md` — "Version Check & Auto-Update" section hardened.** Added a "Code-level safety net" callout documenting that the guard now enforces the check in code, and an explicit warning in step 1 to read the version from the **installed** `SKILL.md` (`~/.cursor/` or `~/.claude/`), **not** from a source-repo checkout open in the workspace (the repo copy is usually already latest and masks a stale install — the exact trap that caused the IEN-15472 miss).
- **All 4 installers + README synced** — `version-guard.js` added to every `SCRIPT_LIB_FILES` array (`install-cursor.sh`, `install-cursor.ps1`, `install-claude.sh`, `install-claude.ps1`) and the README Script Files table, per the install-sync rule.

## 1.14.13 — 2026-06-04

- **`skill/references/builtin-iml-functions.md` — new "No Inline Array/Object Literals" section.** IML has no array/object literal syntax: `['markdown']` inside `{{ }}` evaluates to `null` (not `["markdown"]`, and not the string `"['markdown']"`), and `{ country: x }` collapses to a mangled string (`"{US}"`). This is a parser-level limitation that holds in **every** position, including the arguments to **any** function — built-in (`if`, `ifempty`, `merge`, `switch`, …) and custom (`functions/*/code.js`): `myFn(['a'])` receives `null`, `myFn({ k: v })` receives a string. Documents the correct alternatives (arrays via `split()` / `merge()` / `emptyarray`; objects via a `temp` JSON-nested reference `{{fn(temp.x)}}` or static `parseJSON()`), and that `ifempty` does not treat `[]` as empty (use `if(length(arr), arr, split(...))`). All behavior verified against the runtime's bundled `@integromat/iml` v3.9.1.
- **`skill/references/custom-functions-reference.md` — cross-ref note on array/object arguments** pointing to the new section, so custom-function authors know inline literals cannot be passed as args. Trigger: make-ai-web-scraper v1 (IEN-14735) review — module `api.imljson` used `ifempty(parameters.formats, ['markdown'])` (? `null` fallback, masked by manifest-v2 passthrough + Firecrawl's own default) and `if(parameters.country, { country: parameters.country }, undefined)` (? sent `location: "US"` as a string instead of `{ country: "US" }`, breaking the Country feature); both bugs fixed in the app, and the doc gap that let them through the first review is now closed.

## 1.14.12 — 2026-06-02

- **`skill/references/parameters-reference.md` — corrected the "Per-Option `nested` vs Store-Level Fallbacks" guidance (supersedes 1.14.10).** The 1.14.10 entry recommended store-level `options.nested` as the canonical "nested fields disappear when mapped/typed" fix. That is **wrong for an `rpc://`-backed `store`**: per-option `nested` from an RPC store is registered **asynchronously** (only after the store fetches), while store-level `options.nested` is **not gated** by value state — so on module **reopen** of a dropdown-selected value, `options.nested` can win the async render race and paint **generic** operators over a type-specific selection (saved compare-values then read as "not compatible"). The canonical fix is now **`placeholder.nested`** (`{ store, placeholder: { label, nested: "rpc://…?mode=mapping" } }`), which the renderer shows **only** in the placeholder state (mapped / typed / no matched option) and therefore never pre-empts the async per-option nested. Section rewritten with the RPC-store-vs-static-array distinction and a 4-rule precedence order; `options.nested` documented as acceptable only for **static-array** stores (per-option matches synchronously, no async gap). Trigger: monday v2 IEN-15263 re-review — the 1.14.10 `options.nested` approach shipped, then regressed in QA (IEN-15480: compare values incompatible after saving the form); the fix switched to `placeholder.nested`.
- **`skill/references/parameters-reference.md` — genericized internal renderer/package names.** Replaced all references to the internal parameter-form library and its internal symbols (package name, source file path, and internal function names) with neutral wording: "the Make parameter form renderer" / "the Make platform's parameter form validator". IMLJSON-facing config keys (`options.nested`, `placeholder.nested`, `placeholder.label`, per-option `nested`, `store`, `?mode=mapping`) and plain behavioral descriptions are retained; the precedence chain pseudocode was replaced with a plain numbered rule list.

## 1.14.11 — 2026-06-01

- **`skill/references/app-compilation-and-deployment-reference.md` + `skill/SKILL.md` — document module visibility: `deprecated`/`private` (soft-hide) vs SDK `public` (hard-disable).** Two different admin endpoints expose two different visibility controls with very different blast radius. `GET {zone}/api/v2/admin/apps/{slug}` ? `versions[*].modules[*].deprecated` / `.private` is a **soft-hide**: the module is hidden from the scenario builder for **new** use, but scenarios **already using** it keep rendering & running. `GET {zone}/api/v2/admin/sdk/apps/{slug}/{version}/modules` ? per-module `public` is a **hard-disable**: `public: false` makes the module owner-only and, on compile/deploy, **removes it from `versions[*].modules[*]` and from every existing scenario that uses it ? those scenarios break.** Rule: to hide/sunset a module that is in production use, set `deprecated: true` (or hide via the admin panel), **never `public: false`** (that is a hard breaking change, only appropriate for never-released owner-only/WIP modules). Also documents that `metadata.json` from `download-app.js` reflects the `/admin/apps` deployed view, so a pending-uncompiled `public: false` shows there as `private: false` / `deprecated: false` — query the SDK `/modules` `public` flag for the real pending state, and note that relabeling a module "(deprecated)" does nothing to visibility. Provenance marked field-verified (team knowledge + direct endpoint observation, IEN-15262 TimeCamp v1), not yet cross-checked against the source repos. Trigger: IEN-15262 code review where the 6 create/update modules were hidden via `public: false` (breaking existing scenarios) instead of `deprecated: true`.

## 1.14.10 — 2026-06-01

- **`skill/references/parameters-reference.md` — new "RPC Dynamic Options" sub-section "Per-Option `nested` vs Store-Level `options.nested` (Precedence + Mapped-Value Fallback)".** Documents that a `select` resolves nested fields with a **`||` precedence chain** (one fieldset per value, NOT additive), verified against `@integromat/forman` source (`lib/utils.ts ? resolveInstructions` + `showNestedFieldsets` + `findOption`): registered-remote ? matched store option's per-option `nested` ? store-level `options.nested` ? `instructions.options.nested` ? `placeholder.nested`. Consequences: per-option `nested` wins on dropdown selection (no duplicate even with identically-named fields, so adding a store-level `options.nested` does **not** change the selection path); store-level `options.nested` is the fallback that renders for **mapped or manually typed** values (and must return a generic/superset spec because the option type is unknown). Includes the canonical "nested fields disappear when the value is mapped" fix pattern (`{ store: rpc://X, nested: rpc://X?mode=mapping }` with a `condition`-branched RPC). Explicit warning that Make's docs `?ask=` bot is wrong on this (claims "both render" + "options.nested doesn't render for mapped values") — verify editor-render behavior against forman source. Trigger: monday v2 IEN-15263 (Search advanced & Aggregate modules — Operator/Compare Values not shown when the column ID is mapped).

## 1.14.9 — 2026-05-29

- **New reference `skill/references/app-compilation-and-deployment-reference.md`.** Documents the full lifecycle of how a Make custom app goes from editable SDK code (Postgres `apps.*` in `imt-web-api`) to a compiled **PKR file package** that a zone instance executes: the two representations (DB working copy vs compiled package), the commit?compile?publish?install?run pipeline, `make-apps-processor` (`AppToCompile` snapshot ? PKR v2 virtual Node-package tree, IML embedded as strings/not evaluated), `imt-ipm-server` registry layout (`data/{type}/{firstLetter}/{name}/{semver}.pkr` + `meta.json` tags), `imt-ipm-service` per-zone install (NFS `imt_modules/{slug}/v{major}/`, `.tgz` snapshot, `sync-status.json`, local-EBS mirror, symlink scheme), and runtime resolution (compiled ? FS `require()`; SDK `app#` ? DB; `resolveComponentsRoot` NFS vs local). All claims source-verified against `imt-web-api` / `make-apps-processor` / `imt-ipm-server` / `imt-ipm-service` / `integromat`. Synced into all 4 installers' `REFERENCE_FILES`, the README references table, and the SKILL.md Detailed Reference list.
- **`skill/workflows/code-review.md` — new § 5a "Interpret `review-changes.js` output" + corrected 0-changes rule.** Clarifies that change-tracking is gated by the **`approved`** flag (not `compile`): a non-approved app writes every SDK edit directly to the DB with **no `apps.change` rows**, so `review-changes.js` is **structurally 0 regardless of how much changed** ? the reviewer must review the **full app code**, never report "nothing to review" / "all committed via SDK." An approved app returns a real `old_value ? new_value` diff. The "If there are 0 changes" Important Rule now routes through this `approved` check. Trigger: google-merchant v1 (IEN-12847), a new uncompiled app whose `review-changes.js` was 0 every round.
- **`skill/workflows/code-review.md` + `rules/make-app-todo-review.mdc` — disposition question now verb-aware.** For an uncompiled app (`approved: false`) the forward action is **compile**, not commit: ask "Did you **compile** the app, or return it to the developer?" (accepting `?????`/`?????`/`?????`); for a compiled app keep "commit." Both forward verbs map to the same `post-review-transition.js {key} committed` call. `SKILL.md` `approved` bullet updated with the same `approved`-gate clarification and a cross-link to the new reference.

## 1.14.8 ÿ 2026-05-29

- **Code-review subtask status filter corrected: `Complete` ? `Test`.** The IEN board no longer has a `Complete` status. The actual workflow is: QA creates a subtask and returns it to the developer ? the developer fixes it and sets the subtask to **`Test`** ? once all subtasks are done the developer sets the **parent** to **`Commit`** and requests review ? the reviewer, on a `committed` disposition, moves the **parent** to **`In Testing`** ? QA then tests each subtask directly and transitions it **`Test` ? `Done`** (verified) or returns it to the developer. Updated `skill/workflows/code-review.md` ÿ 3 (status filter `Done = skip / Test = review / Other = context`, added a "Subtask status lifecycle" note, fixed the assignment-scope example list), the ÿ "Post-Review Disposition Gate" Hard Rule (`Sub-task "Test" status is QA territory`, `Test ? Done` belongs to QA), `rules/make-app-todo-rules.mdc` `common_jira_fetch` filter, and the `rules/make-app-todo-review.mdc` reviewer-assignment example list. No script change ÿ `post-review-transition.js` never hardcoded `Complete` and already aborts on a `Test` subtask (QA territory). Trigger: IEN-15122 Round #6 review where the reviewer correctly left `Test`-status subtask IEN-15442 untouched and moved only the parent to `In Testing`.

## 1.14.7 ÿ 2026-05-29

- **`skill/references/component-patterns-reference.md` ÿ new Connection-Pattern sub-section "OAuth Scope Files ÿ `scope.imljson` vs `scopes.imljson`".** Documents the opposite shapes of the two near-identically-named connection files: `scope.imljson` is an **array** of default active scope strings (`["<scope-url>", ...]`), `scopes.imljson` is an **object** catalog keyed by scope ? human-readable description (`{ "<scope>": "<desc>" }`) that populates the `additionalScopes` picker UI. Explains how the active scope set is composed at OAuth `authorize` time (connection `scope.imljson` ? triggering module/RPC `scope.imljson` ? user-selected `additionalScopes`), with real examples from `google-sheets-v2` / `productboard-v1` (populated) and the many apps that ship an empty `{}` (`google-ads-conversions`, `whatsapp-business-cloud`, `cloudconvert`, `github`, `google-merchant`, etc.). Includes a false-positive guard: empty `{}` is valid, the real bug is the inverted shape (`scopes.imljson` as `[]` or `scope.imljson` as `{}`).
- **`skill/references/code-review-criteria.md` ÿ "Out of Scope (Do NOT flag)" ÿ new entry "`scopes.imljson` Empty Object `{}`".** Stops reviewers from flagging an empty `scopes.imljson` `{}` as an improvement or suggesting `{}` ? `[]` (which inverts the schema). Table contrasts the correct vs wrong shape for both `scope.imljson` and `scopes.imljson`, and cross-links the full mechanism in `component-patterns-reference.md`. Trigger case: google-merchant v1 review (IEN-12847) where `scopes.imljson: {}` was incorrectly flagged as needing to become `[]`.

## 1.14.6 ÿ 2026-05-28

- **`rules/work-discipline.mdc` ÿ 7 ÿ new sub-section "External API Reference Verification (mandatory before any external-API claim)".** Codifies that `runtime-reference.md` and the in-skill references describe Make's runtime, NOT the third-party vendor's contract ÿ every claim about the external API surface (endpoint params, body fields, response shape, "module is missing parameter X") must be verified against the vendor's official docs before being asserted in code or in a code review. Six trigger phrases enumerated (qs/body/header/response/missing-param/symmetric-endpoints), five verification rules (no claims from memory, `WebFetch`/`WebSearch` against vendor docs first, "I couldn't verify {X}" instead of guessing, withdraw immediately on contradiction, record verified facts to `${CONTEXTS_DIR}/{slug}-v{version}.md` ÿ Caveats with the source URL). Trigger case: IEN-15238 (Etsy v2) where two unverified claims (`includes` on `findAllListingsActive`, `readiness_state_on_property` mis-graded as "Improvement") shipped in a single review pass ÿ first wrong, second a real bug under-flagged.
- **`skill/workflows/code-review.md` ÿ 7 ÿ new "Hard Gate ÿ External API Reference Verification" peer-section to the existing "Hard Gate ÿ Runtime Reference Read".** Six-step procedure (identify exact endpoint ? fetch vendor docs via `WebFetch`/`WebSearch` ? quote source in review output ? "I couldn't verify {X}" when fetch fails ? existing app code is not proof, symmetric-looking endpoints often diverge ? withdraw on contradiction). Documents two real false-positives prevented (Etsy `/listings/active` does not accept `includes`; Etsy `updateListingInventory` accepts `readiness_state_on_property` as first-class body field ÿ was graded too low). Review Categories list updated with new "External API Verification" bullet pointing to the gate.
- **`skill/workflows/code-review.md` ÿ "Developer Message" ÿ new "Audience Rule ÿ No Skill-Repo Commands in Developer Messages" sub-section.** The "To Developer" message is read by developers who do not use this skill ÿ they work in the Make Internal App (VS Code extension) and the SDK web UI. Skill-internal vocabulary in their copy-paste is noise at best, confusing at worst. Forbidden in any developer-facing message: skill scripts (`update-component.js`, `update-app.js`, `test-component.js`, `post-review-transition.js`, etc.), skill paths (`~/.cursor/skills/...`, `${SKILL_ROOT}`, `${CONTEXTS_DIR}`, `~/.cursor/make-app-contexts/...`), skill-internal references (`Pinecone`, `upsert_app_context`, `make-app-context` MCP, `${slug}-v${version}.md`), skill flags (`public=true`, `--debug`, `--format=json`). Translation rule: speak in the developer's language (IMLJSON / SDK terms with in-app relative paths like `modules/SearchTiles/expect.imljson`). Applies to the To Developer block, any quoted snippet a user might copy to Jira, and Jira comments / Developer Notes authored on the developer's behalf. Does NOT apply to internal review analysis above the To Developer line (user is the audience there) or skill-side post-review actions (silent local execution).

## 1.14.5 ÿ 2026-05-28

- **MCP server registration ÿ absolute `node` path baked into `mcpServers[].command`.** macOS GUI launches of Cursor / Claude Code don't inherit shell `PATH`, so the previous `command: "node"` value caused `spawn node ENOENT` and the `make-app-context` MCP server never came up for any user installing via the README one-liner. `mcp-server/register.js` (Cursor flow) + the inline node registration scripts in `install-claude.sh` / `install-claude.ps1` now write `command: process.execPath` ÿ the absolute path of the node binary that ran the installer. Claude installers additionally include `command` in the `needsUpdate` comparison, so re-running the installer / `--update` will auto-correct existing broken entries that have the literal `"node"` string. Confirmed end-to-end against `~/.cursor/mcp.json` after re-registration: server now spawns successfully and `upsert_app_context` / `upsert_jira_ticket` / `search_app_knowledge` work without a Cursor restart beyond the one MCP-toggle cycle.

## 1.14.4 ÿ 2026-05-28

- **`skill/workflows/task-refinement.md` ÿ "Output Format" ÿ Investigation subtask body delivery flipped to ADF-default with mandatory `expand`-wrapping for every code block.** Two new hard rules added to the Output Format section (raising the count from 2 to 4): (3) every code block in the subtask body must be wrapped in an ADF `expand` element with the file path as `expand.attrs.title` (one `expand` per file ÿ `installSpec.imljson`, `install.imljson`, `common.imljson`, `metadata.json`, `base.imljson`, `groups.imljson`, every `modules/{name}/*.imljson`, every `functions/{name}/code.js`, plus reference snippets like `External API response shape`); (4) the subtask description body is English-only regardless of chat language ÿ summary, prose, table cells, `expand` titles, Open Questions. Prose / tables / headings / lists stay at the top level; only code blocks go inside `expand`. ÿ "Subtask body delivery" section now documents the minimum `expand` JSON shape and recommends programmatic ADF construction (Python `urllib.request` against `POST /rest/api/3/issue` using the `jira-email` + `jira-api-token` from `SKILL.md` tail config) over hand-written ADF when the Atlassian MCP `createJiraIssue` tool is unavailable or returns auth errors. Markdown fallback retained only for the rare zero-code-block refinement (UX-only, metadata-only). The template at ÿ "Template" is now explicitly labeled a structural reference, not the wire format. Codified after IEN-15430 (Investigation sub-task for IEN-14735 Make AI Web Scraper) shipped with 13 `expand`-wrapped code blocks per user request ÿ pattern is now the default for every future ÿ P refinement.

## 1.14.3 ÿ 2026-05-27

- **`skill/references/component-patterns-reference.md` Connection Flow rewrite.** Clarifies that `parameters.*` and `connection.*` are aliases over the same `account.data` store ÿ user inputs in connection `parameters.imljson` are accessible as `{{connection.fieldName}}` from every context (connection api, modules, RPCs, webhooks) **without** any explicit `response.data` save step. Sources: `imt-app-runtime/accounts/app-runtime-oauth2/lib/account.js` lines 86ÿ87 (and OAuth1 / Basic equivalents) initialize the apiContext with `parameters: () => this.data, connection: () => this.data`. The `response.data` row of the directives table now correctly scopes its purpose to (a) persisting API-derived values (tokens, expiry, account ids) and (b) transforming a user input before storage. Closes a recurring false-positive where reviewers flagged "missing `token.response.data.fieldName` save" as a bug when the field was already in `parameters.imljson`.
- **`skill/references/code-review-criteria.md` Runtime Behavior Verification list updated.** New "Common mistakes to avoid" entry pointing reviewers at the same parameters/connection aliasing rule and listing the only three cases in which an explicit `response.data.{field}` save is actually required (transformation, derived-from-response value, field not in `parameters.imljson`). Cross-links to the rewritten Connection Flow section in `component-patterns-reference.md`.

## 1.14.2 — 2026-05-26

- **`skill/scripts/download-app.js` — `metadata.json` `modules[].deprecated` source-of-truth fix.** The admin app endpoint (`/api/v2/admin/apps/{slug}` ? `versions[].modules[].deprecated`) is observed to return stale `false` for modules whose deprecated flag has been toggled in the SDK. The previous merge expression `vis.deprecated ?? m.deprecated ?? null` let that stale `false` win over the correct `true` from the SDK modules endpoint, because `false` is not nullish. Source-of-truth flipped so SDK modules endpoint (`/sdk/apps/{slug}/{version}/modules?cols[]=deprecated`) wins (`m.deprecated ?? vis.deprecated ?? null`); admin endpoint remains authoritative for `private` only. Verified end-to-end against `google-ads-conversions` v1 — four UploadClickConversions modules now correctly report `deprecated: true` in `metadata.json`.

## 1.14.1 — 2026-05-22

- **Installer file-list sync — 4 installers were missing files that exist in the repo.** All four installers (`install-cursor.sh`, `install-cursor.ps1`, `install-claude.sh`, `install-claude.ps1`) hardcode the download list for `curl | bash` / `irm | iex` flows. Two files added in 1.14.0 were never registered: `skill/workflows/task-refinement.md` and `rules/make-app-todo-refinement.mdc`. Every user who installed via the README-recommended one-liner since 1.14.0 received a broken installation missing both files. All 4 installer arrays now match the repo 1:1 (`WORKFLOW_FILES` 6?7, `RULE_FILES` 7?8).
- **`install-cursor.ps1` — `post-review-transition.js` added to `$SCRIPT_FILES`.** The script existed in the repo and in `install-cursor.sh` / `install-claude.*` but was missing from the Cursor Windows installer's download list. Windows Cursor users on `irm | iex` never received it.
- **Windows installers (`install-*.ps1`) — TLS 1.2 forced at startup.** Legacy PowerShell 5.1 (Windows 10 default) defaults to SSL3/TLS1.0 which GitHub rejects, causing `Invoke-WebRequest` against `raw.githubusercontent.com` to fail. Added `[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12` immediately after `$ErrorActionPreference = "Stop"` in both ps1 installers.
- **Windows installers — wildcard `Copy-Item` calls now use `-ErrorAction SilentlyContinue`.** With `$ErrorActionPreference = "Stop"`, a wildcard `Copy-Item (Join-Path ... "*.js") ...` against an empty or missing source dir threw and aborted the entire installer. The bash equivalent already suppressed errors via `2>/dev/null`. Fixed in 5 sites in `install-cursor.ps1` and 3 sites in `install-claude.ps1`.
- **`install-claude.ps1` MCP registration — `Env:MCP_ENV_FILE` now cleaned up in `finally`.** Previously only `CLAUDE_JSON_PATH` and `MCP_INDEX_JS` were removed, leaving `MCP_ENV_FILE` polluting the user's PowerShell session after the installer finished.
- **New `.cursor/rules/install-sync.mdc` + matching `.claude/CLAUDE.md` section.** Enforces 4-installer parity whenever a file is added/renamed/deleted/moved in any tracked directory (`skill/`, `skill/references/`, `skill/workflows/`, `skill/scripts/`, `skill/scripts/lib/`, `rules/`, `mcp-server/`, `subagents/`). Includes the directory?array mapping table, mandatory sync triggers, verification steps (`Glob` actual files vs `Grep` installer arrays for 1:1 match), and README/SKILL.md sync rules. Codified specifically so the 1.14.0 task-refinement omission cannot recur.
- **`README.md` updated** to list the previously-missing entries: `workflows/task-refinement.md`, `make-app-todo-refinement.mdc`, `scripts/post-review-transition.js`, `scripts/lib/settings.js` (Skill Files / Script Files / Rule Files tables + Repository Structure tree).

## 1.14.0 — 2026-05-20

- **New § P Task Refinement workflow** for `Preparation`-status Jira tickets: `skill/workflows/task-refinement.md` + `rules/make-app-todo-refinement.mdc` (§ P static TODO template, 18 items — Common Pre 5 + 9 refinement items + Common Post 4). Read-only investigation flow ending with an optional `Investigation` sub-task created via Atlassian MCP `createJiraIssue` on the parent. The single Jira write is the sub-task itself; no `update-app.js` / `update-component.js` / `create-component.js` / `delete-component.js` calls in any step.
- **Mandatory § P auto-routing.** When a user message contains all three signals — Jira ticket URL, inline app slug (± version), and the ticket's `status.name === "Preparation"` (verified after `getJiraIssue`) — the workflow is unambiguously § P. No `SwitchMode` prompt, no template-selection question; jump straight into the § P TODO template. Codified in `rules/make-app-todo-rules.mdc` Template Selection table + `skill/SKILL.md` Workflows table row + `skill/workflows/task-refinement.md` § "Trigger" "Mandatory auto-trigger" subsection.
- **Refinement subtask body format** (`skill/workflows/task-refinement.md` § "Output Format") locked to a dev-audience template: 2-column header meta table ? Feasibility prose ? AC Coverage table ? Decisions subsections (each with full IMLJSON code blocks for the resulting file change) ? Implementation Plan with full `api.imljson` / `expect.imljson` / `interface.imljson` fenced JSON blocks (no bullet-list-of-fields substitute) ? Pagination paragraph ? Custom Functions table + JavaScript code block ? Pricing/UX Copy/Breaking Changes/Open Questions tables ? Next Step using generic dev-step language. Explicitly forbids "References Consulted" section, Make-skill internal commands (`update-component.js` / `update-app.js` / `test-component.js`), and a "Test Plan" subsection — test design is implementation territory, not refinement.
- **`skill/references/component-patterns-reference.md` new § "App-Level Install Params"** (+75 lines, inserted before § "Connection Pattern"). Clarifies the two scopes of `installSpec.imljson` + `install.imljson` (app root vs connection-level), documents the admin panel URL `{zone_url}/admin/native-apps/{slug}/version/{version}` where admin users enter / update values after IPM deployment, and codifies the post-approval editability rule — adding a new field to `installSpec.imljson` on an `approved: true` app is an ordinary edit, not a structural blocker. No v2 bump required at the IMLJSON level (deployment policies still apply per Make team's release process).
- **`skill/SKILL.md` Common-data lock note corrected.** Component-table row for `common.imljson` and the Important Notes bullet were both too-strict in stating "Common data cannot be changed after app approval". The static `common.imljson` contents are still frozen, but install-flow values populated through `installSpec` / `install` are admin-editable post-approval via the admin panel — both surfaces now reflect this distinction and link to the new App-Level Install Params reference subsection. Closes a real session where a refinement initially mis-characterized a simple installSpec extension as a structural blocker requiring v2 bump or per-user connection.
- **Code Review reviewer-assignment scope tightened to parent ticket only.** `workflows/code-review.md` § 3 "Assign to reviewer" + `rules/make-app-todo-review.mdc` § R item-7 note: assign **only the parent** via Atlassian MCP, never touch any sub-task `assignee` — regardless of status (`Complete` / `Done` / `In Progress` / anything). Sub-task ownership belongs to the implementer / QA, not the reviewer. Pairs with the existing § "Hard Rule — Sub-task Complete = QA territory" from 1.13.11 to fully isolate the reviewer's MCP edits to the parent ticket.

## 1.13.11 — 2026-05-12

- `workflows/code-review.md` § "Post-Review Disposition Gate" — new hard rule: **sub-task `Complete` status is QA territory**. When `post-review-transition.js` aborts on a sub-task currently in `Complete` (allowed pre-status is `Commit` / `Compilation`), the reviewer must NOT bypass — no `--force`, no direct MCP `transitionJiraIssue` call to push it to `Done`. The `Complete ? Done` transition belongs to QA; they will mark it `Done` themselves once verified. The script's abort is the correct behavior, not a bug to work around. Reviewer reports the abort as "skipped (QA territory)" and moves on. Only override if the user explicitly says "force it" or names the target status. Codified after a real-session regression where the reviewer auto-pushed a sub-task `Complete ? Done`, requiring a manual revert via the To Do ? In Progress ? Complete loop.

## 1.13.10 — 2026-05-12

- `workflows/code-review.md` § 7 — new "Hard Gate — Runtime Reference Read" subsection. Before flagging any Bug / Breaking / Improvement on an `api.imljson` change, the reviewer must `Read` the matching section of `references/runtime-reference.md` (directive-to-section index included: URL normalization, qs encoding, headers/body/type/condition, temp two-phase, response directives, pagination, polling triggers, IML path syntax). Lists real false-positives this gate prevents (double-slash URL bug, undefined `temp`, `body.results[].field` array-wrap). Closes the loop on intuition-based bug flags.
- `rules/make-app-todo-review.mdc` § R item 7 (`review_analyze`) — content now explicitly references the hard gate, so the runtime-reference read is enforceable from the TODO list, not just the workflow file.

## 1.13.9 — 2026-04-30

- Document the OAuth `redirect_uri` convention across the references and the code-review checklist. Connections that support `redirect_uri` must use `{{oauth.localRedirectUri}}` (host-aware — works on Make-hosted **and** self-hosted instances) for both `authorize.qs.redirect_uri` and `token.body.redirect_uri`. `{{oauth.redirectUri}}` is the legacy `integromat.com`-only callback and `{{oauth.makeRedirectUri}}` is `make.com`-only — neither is portable across deployments. Sourced from `accounts/app-runtime-oauth2/lib/account.js` `get redirects()` and the OAuth1 equivalent.
- `component-patterns-reference.md` — new "OAuth2 Connection — `redirect_uri` Convention" subsection under the Connection Pattern: full variable table, OAuth2 spec reasoning (RFC 6749 § 4.1.3 — authorize/token must match), `refresh` exception (no `redirect_uri`), and operational note about registering the new callback in the upstream OAuth client (e.g. Google Cloud Console) when migrating Make-managed common credentials.
- `code-review-criteria.md` — new "OAuth `redirect_uri` Convention (Mandatory check for connection changes)" subsection alongside the aliased-connections and install/installSpec checks. Adds an `rg` heuristic, verdict mapping (new connection ? Changes Requested, untouched legacy ? Improvement, modified line still on legacy ? Changes Requested), and the `aliasTo` exception.
- `security-reference.md` row 2.5 — replaces the legacy "use `{{oauth.redirectUri}}`" recommendation with the host-aware variant and cross-links to the new pattern subsection.
- `examples.md` — Instagram OAuth example now uses `{{oauth.localRedirectUri}}` in both `authorize` and `token` blocks, with a note above the JSON and an extra Key Points bullet.
- `runtime-reference.md` — new "OAuth Connection Variables" section between Environment Variables and Security: short table covering `oauth.localRedirectUri` / `oauth.redirectUri` / `oauth.makeRedirectUri` / `oauth.scope` / `oauth.state`, with cross-links to the full convention.

## 1.13.8 — 2026-04-28
- Auto-update flow now hard-stops on outdated skill: cancel current task, run install command for the detected editor (Claude Code ? `install-claude.sh`/`.ps1`, Cursor ? `install-cursor.sh`/`.ps1`), and refuse all other tool calls until the update succeeds. Failure no longer falls back to "proceed with current version" — instead instruct the user to update manually and end the turn. Fixes Cursor-only command being shown to Claude Code users.
- `make-integration-engineer` subagent now enforces the same auto-update hard stop directly after `Skill('make-custom-app')` and before the tail-config precheck, so the agent that actually drives the tools also blocks until the skill is on the latest version. Previously the version check lived only inside `SKILL.md` and could be silently ignored by the agent loop.

## 1.13.7 — 2026-04-28
- Fix Claude Code installers writing MCP registration to the wrong path. `install-claude.sh` and `install-claude.ps1` were targeting `~/.claude/claude.json`, but Claude Code reads its config from `~/.claude.json`, so the registration silently went into a stray file and `mcp__make-custom-app__*` tools never became available to the `make-integration-engineer` subagent. Both installers now write to `~/.claude.json`, populate the `env` block with `PINECONE_API_KEY` / `OPENAI_API_KEY` / `PINECONE_INDEX_NAME` parsed from `mcp-server/.env` (previously empty `env: {}` left the server unable to connect to Pinecone or OpenAI), update an existing entry instead of skipping when the args/env drift, and remove the stale `~/.claude/claude.json` left behind by earlier installs when it only contains the orphan entry.

## 1.13.6 — 2026-04-27
- Fix remote installers dropping `skill/scripts/lib/settings.js`. The file was added in 1.13.4 but never registered in the `SCRIPT_LIB_FILES` arrays of `install-claude.sh`, `install-claude.ps1`, `install-cursor.sh`, `install-cursor.ps1`, so curl/irm-mode installs left it missing and every write/read script failed with `Cannot find module './lib/settings'`. Local-mode installs (cp `*.js` glob) were unaffected.

## 1.13.5 — 2026-04-27
- MCP server `chunker.ts` now resolves the contexts directory from `process.argv[1]` (Claude Code ? `~/.claude/make-app-contexts`, Cursor ? `~/.cursor/make-app-contexts`) instead of hardcoding `~/.cursor/...`. Without this fix `upsert_app_context` could not find context files installed under the Claude Code path. The `upsert_app_context` "no context files found" error message lists both paths so the user knows where to look.

## 1.13.4 — 2026-04-27
- Claude Code now requires `make-api-key:` in the last lines of SKILL.md (admin endpoint by default — `make-api-url:` defaults to `https://eu1.make.com/api/v2/admin`). Skill scripts hard-fail with a setup guide when the key is missing; environment-variable fallback removed for Claude Code.
- Added `skill/scripts/lib/settings.js` — single source of truth for API auth. Cursor still reads from `apps-sdk.environments` in its `settings.json`; Claude Code reads from SKILL.md tail config.
- Migrated `download-app.js`, `review-changes.js`, `update-app.js`, `update-component.js`, `delete-component.js`, `create-component.js`, `test-component.js` to the shared `loadSettings()` helper (removed seven inline copies).
- Hard-stop precheck added to both the SKILL.md top banner and the `make-integration-engineer` sub-agent. The skill refuses to load workflows, run scripts, call MCP, or edit any file until BOTH required tail-config lines are valid: `imt-app-runtime-path:` (path must exist on disk; required on Claude Code and Cursor) and `make-api-key:` (Claude Code only). The stop message lists each failed key with its specific reason — missing / placeholder / path does not exist.
- Updated `install-claude.sh` and `install-claude.ps1` to preserve `make-api-key:` and `make-api-url:` across reinstall/update, alongside the existing `imt-app-runtime-path:` / Jira credential preservation.
- Added new "Make API Key Setup (Claude Code only — required)" section to `skill/SKILL.md`.

## 1.13.3 — 2026-04-27
- Add editor auto-detection (.claude vs .cursor) via process.argv[1] in all skill scripts
- Add shared skill/scripts/lib/skill-root.js utility (no __dirname)
- Replace hardcoded ~/.cursor paths with ${SKILL_ROOT}/${CONTEXTS_DIR} placeholders in workflows, references, and rules
- Rename install.sh ? install-cursor.sh, install.ps1 ? install-cursor.ps1 for consistency
- Split version.json update commands into _cursor and _claude variants
- Fix all installers (install-cursor.sh, install-claude.sh, install-cursor.ps1, install-claude.ps1) to copy scripts/lib/ subdir
- Add cspell.json with project-specific word allowlist

## [1.13.2] - 2026-04-27

- `subagents/make-integration-engineer.md` — enforce invoking the Skill tool (`make-custom-app`) as the first action on every task before any other tool call. Restructured the rules section into 3 always-on rules (work-discipline, make-app-todo-rules, make-app-workflow) plus 4 on-demand rules (todo-build, todo-debug, todo-review, todo-jira) loaded only when the matching workflow runs. Added a post-task memory-update protocol: after each completed task, append a short bullet to `~/.claude/agents/make-integration-engineer.md` under a `## Memory` section capturing reusable patterns (e.g. recurring bug shapes, customer-specific quirks, novel IMLJSON idioms) so the agent improves across sessions. Fixed several cSpell warnings (IMLJSON, ADF, cloudId, accountId).
- `.claude/settings.json` — new project-scoped settings file. Sets `make-integration-engineer` as the default agent for this repo and grants the agent baseline permissions (Read, Edit, Write, Bash for git/npm/lint, Atlassian MCP) so routine tasks no longer require per-call confirmation.

## [1.13.1] - 2026-04-27

- `skill/workflows/code-review.md` § 3 — add new "Assign to reviewer (mandatory — immediately after fetch)" sub-section. Once parent + subtasks have been fetched via `getJiraIssue` and the reviewable subtask set has been determined (Done = skip, Complete = review), the reviewer is now assigned **at the start of the review** via Atlassian MCP — `getAccessibleAtlassianResources` (cache `cloudId` per session) ? `lookupJiraAccountId` with the `jira-email:` value from `SKILL.md` (cache `accountId` per session) ? `editJiraIssue` with `fields: { assignee: { accountId } }` for the parent and every Complete subtask. Tickets already assigned to the reviewer are skipped (no-op via `getJiraIssue` payload), and the entire step is skipped when `common_jira_fetch` is cancelled (no-Jira review). All MCP calls; no script. The status transition still happens later via `post-review-transition.js` after the user gives their disposition. The script's own assign step (kept intact) is now an idempotent safety net since pre-review already assigned the reviewer to the same accountId.
- `rules/make-app-todo-review.mdc` — Notes section gains one line documenting that reviewer assignment runs as a sub-action **inside** `common_jira_fetch` (per Universal Rule 2: no new todo items for sub-actions). Cross-references the workflow's § 3 "Assign to reviewer" for the full procedure.

## [1.13.0] - 2026-04-27

- **Claude Code support (new feature).** Added `install-claude.sh` (macOS/Linux) and `install-claude.ps1` (Windows) installers that deploy the skill to `~/.claude/skills/make-custom-app/`, register the MCP server in `~/.claude/claude.json`, and append a routing note to `~/.claude/CLAUDE.md`. Support `--update` / `--force` (sh) and `-Mode update` / `-Mode force` (ps1) flags, mirroring the Cursor installer API.
- **`subagents/make-integration-engineer.md`** — new Claude Code sub-agent definition. Pre-loads the full Make domain skill (SKILL.md + all workflows and rule files) and is deployed to `~/.claude/agents/make-integration-engineer.md` by the installer. The orchestrator routes any Make app work to this agent automatically via the routing note in `~/.claude/CLAUDE.md`.
- **`.claude/CLAUDE.md`** — new project-scoped version-sync rules (PostToolUse hook companion).
- **`.claude/settings.local.json`** — updated with PostToolUse version-sync hook (gitignored; not committed).
- **`README.md`** — updated prerequisites, installation, "What Gets Installed", repository-structure tree, and new "The `make-integration-engineer` Sub-Agent" section to document Claude Code support alongside Cursor.
- **`.gitignore`** — added `.claude/settings.local.json` exclusion.

## [1.12.1] - 2026-04-27

- `runtime-reference.md` § "Pagination Internals" — add new sub-section "`pagination.condition` is Evaluated TWICE per cycle (Critical)" documenting a critical runtime trap verified against `imt-app-runtime`. The condition is evaluated **twice** per cycle: once after the response (in the pagination middleware, with `pagination.page = N`), and again before the next request (in `getPaginationRequestOptions`, with `pagination.page` already incremented to `N+1` by `enablePagination()`). When the condition expression references `pagination.page` directly, this dual evaluation produces a non-obvious off-by-one: `total_pages > pagination.page` skips the last page (the second check fires `total_pages > N+1` which is false one page early ? request for the last page is skipped entirely ? last page's data never fetched). The correct pattern is `total_pages >= pagination.page` (or its inverted form `pagination.page <= total_pages`, which matches the runtime's own `test/pagination.spec.ts:921`). Body-driven conditions (`body.has_more`, `body.current_page < body.total_pages`, `body.next_cursor`) sidestep the trap entirely. Includes a behavior table, source-line citations, and the full request-skip mechanism (`ctx.request.options = undefined` ? `if (!requestOptions) return next()` in `fetcher/middleware.ts:35-38` ? `!batch` exits the loop in `init.ts`).
- `code-review-criteria.md` § "Out of Scope" — add a new sub-section "`pagination.condition` with `>=` and `pagination.page` (Do NOT flag as 'extra request')" with a four-row pattern table so reviewers stop incorrectly flagging `total_pages >= pagination.page` as an inefficient "one extra empty request" pattern. The opposite is true: `>` (and `<`) introduce a real off-by-one bug that drops the last page; `>=` (and `<=`) are the correct convention for `pagination.page`-based conditions. Body-driven conditions are reviewed on their own merits. Cross-references the new runtime-reference section. Retracts a previous reviewer guidance that suggested the `>=` ? `>` simplification.

## [1.12.0] - 2026-04-24

- **Removed the `make-app-auto-actions-check.js` stop hook entirely.** Since 1.11.4 the hook had been blocking the stop event whenever it judged a post-work checklist item missing; in practice this kept derailing the agent's TODO progression mid-session (re-injected reason blocks were being read as new user signals, falsely-detected ticket keys triggered phantom work, etc.). Enforcement is now done structurally via stricter static TODO templates instead — the hook script (`hooks/make-app-auto-actions-check.js`) and its node-test suite (`hooks/__tests__/`) are deleted from the repo, the `hooks/` directory is gone, and `install.sh` / `install.ps1` no longer ship or register the hook. On update both installers also actively prune any leftover registration from `~/.cursor/hooks.json` and remove the legacy script files (`make-app-auto-actions-check.js`, `check-make-app-ticket-sync.js`) from `~/.cursor/hooks/`, so existing installations stop firing the deprecated hook automatically.
- **Restructured `rules/` into focused per-concern files (replaces the old `make-app-auto-actions.mdc` + `make-app-code-review.mdc`).** Both old rule files are deleted from the repo and actively pruned from `~/.cursor/rules/make-custom-app/` on install / update via a `DEPRECATED_RULE_FILES` list in `install.sh` and `install.ps1`. The new layout follows the global-rules best-practice guidance (concise, single-purpose, project-specific paths only where necessary):
  - `rules/make-app-workflow.mdc` (always-applied) — Pre / During / After Work checklist condensed from the old "Auto Actions" sections (runtime path check, version check, code sync, auto-execute scripts, Jira attachments, UX reads, IML function tests, runtime reference, post-work context update).
  - `rules/make-app-todo-rules.mdc` (always-applied) — 9 universal static-list rules (verbatim creation, no add / merge / split / reorder, single `in_progress`, `[GATE]` discipline, typed `[CANCELLED: <reason>]` content prefix, no template swap), Common Pre/Post blocks shared by every template, and the template selection matrix.
  - `rules/make-app-todo-bugfix.mdc` (on demand) — § B Bugfix template (17 items, covers reported broken behavior, QA subtasks, regressions).
  - `rules/make-app-todo-feature.mdc` (on demand) — § N New / Feature Implementation template (18 items, covers new modules / RPCs / webhooks / connections / functions and brand-new app creation).
  - `rules/make-app-todo-task.mdc` (on demand) — § T App Task template (16 items, covers refactor / metadata / UX-only / deprecation / cleanup / public-flag flip).
  - `rules/make-app-todo-review.mdc` (on demand) — § R Code Review template (15 items).
- **Code review process moved out of `rules/` into `skill/workflows/code-review.md`** since it is only relevant when the user requests a code review (no need to keep it always-applied). The workflow now contains the full procedure: required inputs (slug + version, Jira ticket suggestion, Atlassian MCP connection check), Jira-driven flow (Step 1 fetch ? Step 2 expected changes ? Step 3 actual changes ? Step 4 filter ? Step 5 review ? Cross-Module Pattern Verification), Review Output Format, Developer Message, Post-Review Disposition Gate (STRICT), Re-Review process, and Review-Without-Jira-Ticket fallback. Cross-references in `make-app-todo-review.mdc`, `make-app-todo-rules.mdc`, `work-discipline.mdc`, and `references/code-review-criteria.md` redirect from the deleted rule to the workflow.
- **Universal Static-List Rules** apply to every template (including § R). Adds verbatim creation, no additions / merges / splits / reorder / renames, single `in_progress`, completion-requires-verified-output, `[GATE]` discipline, and a typed `[CANCELLED: <one-line specific reason>]` content prefix so skipped items still carry their canonical text plus a concrete reason. Vague reasons ("not needed", "n/a") are explicitly forbidden. Pure read-only sessions are exempt unless they produce an edit or run a write script (in which case the matching template applies retroactively).
- **Common Mandatory Items** introduced — every template (§ R, § B, § N, § T) sandwiches its body between the same 5-item Common Pre Block (`common_runtime_path_check`, `common_context_load`, `common_code_sync`, `common_jira_fetch`, `common_attachments`) and 4-item Common Post Block (`common_context_update`, `common_upsert_app_context`, `common_upsert_jira_ticket`, `common_compaction_recommend`). Same `id`, same content, same position across all templates — Universal Rule 9 makes any drift a hard violation.
- `README.md` repository-structure tree, install blurb, and rule-files table updated to drop the `hooks/` directory + the old two-rule layout, and to describe the seven-file split with a per-file "When loaded" column so contributors can see at a glance which rules are always-on vs. fetched on demand.

## [1.11.8] - 2026-04-24

- `hooks/__tests__/make-app-auto-actions-check.test.js` — persist the §8 dev-notes decline-detection cases as a real `node:test` suite (10 tests covering: explicit "no + notes-keyword" form, standalone-negation-after-prompt form for both EN and KO, false-positive guards on words containing "no" / "now" / "node", array-form message content, KO prompt variants, and `detectDevNotesPrompted` + `stripHookOutput` smoke). Run with `node --test hooks/__tests__/`. Replaces the throw-away inline `node -e` invocations from 1.11.7 so regressions get caught next time the regex is touched.
- `hooks/make-app-auto-actions-check.js` — add a conditional bottom export (`module.exports = { detectDevNotesDecline, detectDevNotesPrompted, stripHookOutput }` only when `require.main !== module`). CLI execution path is unchanged; tests can now `require()` the file without triggering `main()`.
- `install.sh` / `install.ps1` install paths already glob `hooks/*.js` (top-level only), so `hooks/__tests__/` is correctly excluded from end-user installs and only ships in the repo for contributors / CI.

## [1.11.7] - 2026-04-24

- `hooks/make-app-auto-actions-check.js` — fix §8 Developer Notes false-positive that re-prompted across sessions for tickets the user had already declined. The previous `detectDevNotesDecline` only matched explicit "no + notes-keyword" phrases (`"don't write developer notes"`, `"?ÿÿÿ ÿÿ?ÿÿ"`), so context-implicit Korean replies like `"??"` / `"?? ÿÿÿ?ÿÿ?ÿÿÿÿ"` (right after the agent's "Developer Notes? ÿÿÿ??ÿÿÿÿÿ?" prompt) were never recognized as declines and the hook kept asking forever. Detection now walks messages in conversation order and accepts a second form: a short standalone-negation user reply (`??`, `?`, `?ÿÿ`, `?`, `?ÿÿÿ?`, `no`, `nope`, `nah`, `skip`, `pass`, `decline`, `not now`, `no thanks`, …) immediately following an assistant turn that contained the dev-notes prompt. The original explicit-form regex is preserved for cases where the user volunteers a decline without being prompted.

## [1.11.6] - 2026-04-24

- `runtime-reference.md` — add new § "IML Variable Path Syntax" section documenting a critical gotcha verified against `imt-iml/lib/utils.js` `mapVariable`: **IML path indices are 1-based, not 0-based.** Includes a behavior table (`foo[]` = `foo[1]` = first element; `foo[0]` ? `undefined`), implications for `response.output` / `response.iterate`, dynamic index evaluation, and the internal `` foo.`1` `` dotted-number stringify form.
- `SKILL.md` § "Important Notes" — add a one-liner on 1-based IML indexing and clarify that `{{body.results[].field}}` is the idiomatic way to unwrap a one-element response array into a scalar output, linking to the new runtime-reference section.
- `code-review-criteria.md` § "Out of Scope" — add a new sub-section "IML Path `[]` / `[1]` Shorthand (Do NOT flag as array wrap)" with a pattern table so reviewers stop incorrectly flagging `newMediaItemResults[].mediaItem`-style expressions as accidental array wraps and correctly flag `[0]` (which resolves to `undefined`) as a bug.

## [1.11.5] - 2026-04-24

- `download-app.js` — extend `metadata.json` to capture compilation + branding + per-zone visibility: `approved` (compilation state — `false` = not yet compiled, `true` = compiled), `compile`, `compilationError`, `theme`, `public`, `beta`, `language`, `countries`, `global` come from the SDK version endpoint; `ipmDeployedToZone`, `private`, `packagePrivate`, `deprecated` (and per-module `private` / `deprecated`) come from a second, admin-only call to `GET {zone}/api/v2/admin/apps/{slug}` matched to the requested major version. The admin call gracefully handles `200` / `403` / `404` (404 = compiled but not IPM-deployed to this zone) and leaves visibility flags `null` when the data is not available.
- `SKILL.md` § "Important Notes" — document two related but distinct concepts:
  1. `approved` reflects compilation state (not Make-team production approval).
  2. Scenario-builder visibility is governed by `versions[*].private` + `versions[*].deprecated` (and the same fields per-module). `private: false` + `deprecated: false` = visible & usable; `private: true` = hidden; `deprecated: true` = hidden in builder but kept in scenarios already using it. The visibility data only exists for apps **IPM-deployed to that specific zone** — `200` / `403` / `404` semantics on the admin endpoint are spelled out so reviewers do not misread a 404 as "app missing". `approved: true` is necessary but not sufficient for production visibility.
- `hooks/make-app-auto-actions-check.js` — fix §8 (Developer Notes) false positives:
  1. Skip §8 entirely for code reviews — Dev Notes are the developer's responsibility, not the reviewer's. Code reviews follow §7 of `make-app-code-review.mdc` (disposition prompt + `post-review-transition.js`) instead.
  2. Broaden the user-decline detector to Korean (`ÿÿÿÿÿ ÿÿ ?ÿÿ?`, `?? ÿÿ`, `ÿÿ ÿÿ`, `?ÿÿÿ ?`, `ÿÿÿ?`, `ÿÿÿ?`, etc. adjacent to `dev note` / `developer notes` / `ÿÿÿÿÿÿÿ ?ÿÿÿ` / `?ÿÿÿ`) and scan the **entire** user-message history instead of only the last message — once the user has declined, the rule says "skip, do not ask again" and the decision must persist across turns.
  3. Broaden the "already prompted" detector to match Korean wording (`Developer Notes? ÿÿÿ??ÿÿÿÿÿ`, `ÿÿÿÿÿÿÿ ?ÿÿÿ …` etc.) and to inspect `AskQuestion` tool inputs in addition to assistant prose.

## [1.11.4] - 2026-04-23

- Add `hooks/make-app-auto-actions-check.js` — Cursor stop hook that enforces the full `make-app-auto-actions.mdc` post-work checklist at session end. Blocks the stop event (with an actionable reminder) when any of the following are missing: §6 (IML function `test.js` update + `test-function.js` run after `code.js` change), §6-2 (`test-component.js` run after `api.imljson` change outside code review), §8 (Developer Notes offered/written after a write script + Jira ticket), §9 (`~/.cursor/make-app-contexts/{slug}-v{version}.md` update), §10 (`upsert_app_context` + `upsert_jira_ticket` per detected ticket), and post-review transition (`post-review-transition.js`) when the user replies "committed" / "returned". Fail-open on any internal error so it never breaks a session; `loop_limit: 1` prevents infinite loops.
- Ticket-key extraction is strict — scans only user messages and Jira MCP tool inputs (`getJiraIssue`, `editJiraIssue`, `upsert_jira_ticket`, …). Assistant prose, code blocks, shell command strings, and edit-tool arguments are ignored, eliminating false positives from example snippets or placeholder IDs.
- Hook also strips its own previously-emitted reason blocks from user-role messages before extracting keys, so a re-injected block from a prior `decision: block` cycle does not cause the hook to re-detect its own example tickets.
- Make-app-work detection relies on concrete tool_use signals only (`.imljson` edits, `make-app-contexts/` writes, SDK script invocations, `make-app` MCP calls) — no text-regex fallbacks, so skill-repo edits that merely mention IMLJSON terms do not trigger the checklist.
- `install.sh` / `install.ps1` now install `hooks/*.js` to `~/.cursor/hooks/` and merge-register the stop hook into `~/.cursor/hooks.json` (idempotent, never overwrites existing user hooks). Both installers also remove the legacy `check-make-app-ticket-sync.js` filename and its `hooks.json` entry from prior releases.
- `README.md` repository-structure tree, install blurb, and a new **Hook Scripts** section document the stop hook and its enforcement scope.

## [1.11.3] - 2026-04-23

- Add `skill/references/security-reference.md` — authoritative security checklist for Make app code review. Eight categories (credentials & secret handling, OAuth/connection flow, webhook signature & replay, SSRF, injection/prototype pollution/ReDoS, sensitive data exposure, environment & sandbox, output format) with severity (`C`/`H`/`M`), detection patterns, and fix guidance. Each finding gets a numeric ID (e.g. `1.2`, `3.1`) so reviews cite `[SECURITY][1.2]` for traceability.
- Add `skill/references/code-smells-reference.md` — quantitative quality thresholds (function length ?40, cyclomatic ?10, cognitive ?15, params ?4, nesting ?3, duplication, return paths, boolean params) plus IMLJSON-specific smells (`A-*` for api.imljson, `P-*` for parameters/expect, `S-*` for samples, `I-*` for interface, `X-*` for cross-file). Findings cite `[QUALITY][A-01]` / `[QUALITY][function-length=62]`.
- Reshape `code-review-criteria.md` to point to the two new references instead of duplicating content. Security section is now a trigger list (which change types mandate opening `security-reference.md`); Code Quality keeps the JS design principles/smells tables but delegates thresholds and IMLJSON smells to `code-smells-reference.md`.
- Add `component-patterns-reference.md` § "OAuth2 Connection with Common Fallback" — documents why `installSpec.imljson` + `install.imljson` are mandatory when `connections/{name}/api.imljson` references `common.clientId` / `common.clientSecret`, with the admin-form + `parameters ? common` mapping example.
- Add `code-review-criteria.md` § "Connection install + installSpec Verification" — mandatory reviewer step: grep `common\.` in `connections/{name}/api.imljson`; if hit and install files are empty, flag as bug (OAuth fallback resolves to empty ? `invalid_client`).
- Add `code-review-criteria.md` § "Branding Consistency for Apps in an Existing Family" — mandatory reviewer step for new-app tickets sharing a prefix with published apps (e.g. `google-ads-*`): verify `app.theme` via admin API, check the family-shared logo, confirm label/description style.
- Expand Breaking Changes skip conditions in both `code-review-criteria.md` and `rules/make-app-code-review.mdc` — now skip for (1) App-type Jira tickets (entire app), and (2) per-change new-component creation inside existing apps (when the review diff has `new_value` only with no `old_value`). All skip cases must state the reason in Analysis.
- Update `install.sh`, `install.ps1` `REFERENCE_FILES` whitelist, `README.md` directory tree + reference table, and `SKILL.md` Detailed Reference list to register the two new references — required so `curl | bash` installs pick them up (local-clone installs already did via `cp *.md`).

## [1.11.2] - 2026-04-22

- Document URL normalization in `runtime-reference.md` — new `### URL Normalization` subsection under `## Requester / HTTP Details` explains the behavior of `lib/core/utils/normalizeUrl.js` and `joinBaseUrlAndUrl.ts`: consecutive slashes in `pathname` are collapsed (`\/{2,} ? /`), but trailing slash on non-root paths is preserved (stripped only when `pathname === '/'`). Includes the IEN-15136 Adalo case as an example — apps must emit optional trailing path segments conditionally (`{{if(parameters.url, '/' + parameters.url, '')}}`) because the runtime will not strip an app-level trailing `/`. Also documents `baseUrl + url` join rules, path/QS encoding differences between `legacy` and `uniform` modes, default-port stripping, and hostname handling.

## [1.11.1] - 2026-04-22

- Document aliased connection runtime behavior in `component-patterns-reference.md` — new `### Aliased Connections (aliasTo)` section clarifies that when a connection has `aliasTo` set, all of its own IMLJSON files (`api`, `parameters`, `common`, `scope*`, `install*`) are **excluded at compile time** and the runtime resolves the connection entirely through the source connection referenced by `aliasTo`. Includes detection via admin API `/sdk/apps/{slug}/connections` response and `metadata.json connections[].aliasTo`.
- Correct the Base Pattern scope in `component-patterns-reference.md` and `SKILL.md` — `base.imljson` is inherited by **modules and RPCs only**, NOT by `connections/*/api.imljson` or `webhooks/*/api.imljson`. **Every** field in base (not just `baseUrl` / `headers` / `response.error` / `log.sanitize`, but any key at all) is ignored for connection and webhook contexts; those components are standalone and must re-declare everything they need. Previous docs incorrectly claimed base applied to webhooks too.
- Add `### Aliased Connections` mandatory check to `code-review-criteria.md` — reviewers must consult `metadata.json connections[].aliasTo` before evaluating any `connections/{name}/*.imljson` change; edits on aliased connections are runtime no-ops and must be flagged with that caveat even when the verdict is LGTM.
- Fix `download-app.js` dropping connection metadata — the `connections.map` now captures `type` and `aliasTo` (with `alias_to` snake_case fallback) into `metadata.json`, matching what the admin API already returns. Previously only `name` and `label` were persisted, which hid alias relationships from the agent.

## [1.11.0] - 2026-04-20

- Add `post-review-transition.js` script — assigns a Jira ticket to the authenticated user (`/myself`) and transitions the ticket after a code review. `committed` ? "In Testing" (from "Commit" or "Compilation"); `returned` ? "In Progress" (from "Commit") or "To Do" (from "Compilation", since that workflow has no direct "In Progress" transition). Supports `--force` override and `--from-status=<name1,name2>` customization.
- Wire the new script into `make-app-code-review.mdc` § 7 (Post-Review Auto-Actions) and `make-app-auto-actions.mdc` § 3 so it runs automatically when the user replies "committed" / "returned to developer" after a review.
- Fix `install.sh` `set -e` + subshell regression — when `npm install`, `npm run build`, or `node register.js` failed, the installer aborted before reaching the Jira credentials / runtime paths restore block, silently wiping `jira-email`, `jira-api-token`, `imt-app-runtime-path`, etc. The failing subshells are now guarded by `if (...); then` so only the post-check branch reacts to the failure.
- Harden `SKILL.md` credential parsing in `download-jira-ticket-attachment.js` and `post-review-transition.js` — skip markdown blockquote lines (`> ...`) from the setup guide, filter obvious placeholders (`your-*`, `user@example.com`, `ATATT3x...`), and use last-wins so real credentials appended at the end of the file take precedence over setup-guide examples.

## [1.10.18] - 2026-04-17

- Document new `{ errorType, message }` object form for component test error output in `component-test-guide.md` § "Error Output" — supports asserting error class (e.g., `ConnectionError` vs `RuntimeError`) in addition to the error message. Backwards-compatible with the legacy string form. Requires the matching `test-runner.ts` extension in `make-apps-mockup` (shipped together)

## [1.10.17] - 2026-04-17

- Add "Out of Scope" section to `code-review-criteria.md` — explicitly exclude formatting and indentation changes (whitespace, tabs ? spaces, whole-file re-indentation) from code review output to reduce noise; reviewers should use `diff -w -u` to extract the real logical change

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

- Rewrite `builtin-iml-functions.md` from IML source code (`@integromat/iml` package): add return types, operator precedence table, ALT_OPS aliases (`===`?`=` loose equality), `+` operator type detection, Decimal.js precision notes
- Add missing functions: `dateDiff`, `toArray`, `first`, `last`
- Add dedicated Operators, Keywords, and Variables sections with source file references
- Document `emptystring` behavior (`new String('')` vs primitive `""`)
- Document `formatDate` always returns string (even for numeric formats like `'X'`)

## [1.10.4] - 2026-04-09

- Fix Windows CRLF line endings breaking markdown section parsing in MCP chunker (`split('\n')` ? `split(/\r?\n/)`)
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
- Extract detailed review criteria from `make-app-code-review.mdc` (401?211 lines) into new `code-review-criteria.md` reference (ES6+, code quality, test coverage, UX, runtime verification, polling triggers)
- Merge `make-app-ux-guideline.mdc` into `make-app-auto-actions.mdc` as "5-1. UX Reference Before UX Changes" — remove standalone file
- Deduplicate `code-review.md` workflow (143?69 lines) — remove inline Review Criteria and Output Format, reference rule and criteria docs instead
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
- Add "Runtime Default Error Handling" section to code review rules — clarify that 429?RateLimitError and 5xx?ConnectionError are handled automatically by imt-app-runtime, so missing explicit error type definitions should not be flagged
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

- Extract workflows from SKILL.md into `workflows/` folder (882?~300 lines in SKILL.md)
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

- Extracted 4 large reference sections (~500 lines) from SKILL.md into dedicated files (1323?835 lines)
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
- Added QA subtask investigation workflow to rule (Pinecone search ? local context ? investigation)

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
