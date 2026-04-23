# Code Smells & Quality Thresholds Reference (Make Custom Apps)

Authoritative reference for **quantitative thresholds** and **IMLJSON-specific smells** in Make custom app code review. This file is the single source of truth for quality measurement; `code-review-criteria.md` keeps the high-level JS design principles (SRP, DRY, declarative > imperative) and points here for numbers and IMLJSON smells.

**Scope split** (no overlap with `code-review-criteria.md`):

| Concern | Location |
|---|---|
| JS design principles, code smells, review checklist | `code-review-criteria.md` § "Code Quality & Maintainability" |
| **Quantitative thresholds** for JS (length, complexity, params, nesting) | **This file § 1** |
| **IMLJSON-specific smells** (api, parameters, expect, samples, interface) | **This file § 2** |
| **Cross-file smells** (duplication, base drift, config fragmentation) | **This file § 3** |
| Security findings | `security-reference.md` |

---

## 1. Quantitative Thresholds (`functions/*/code.js`)

Soft limits modeled after SonarQube defaults, tuned for Make's custom IML function sandbox (10s timeout, no modules, small surface).

| Metric | Threshold | How to measure | Verdict if exceeded |
|---|---|---|---|
| **Function length** (effective, excludes blank lines & comments) | ≤ 40 lines | Count non-blank lines between `function` and matching `}` | Improvement (> 40) / Changes Requested (> 80) |
| **Parameter count** | ≤ 4 | Count positional params (default-valued ones included) | Improvement (> 4) — collapse into a single `opts` object |
| **Nesting depth** | ≤ 3 | Max depth of `if` / `for` / `while` / `try` / arrow-body blocks | Improvement (> 3) — early return / extract helper |
| **Cyclomatic complexity** | ≤ 10 | `1 + (if + else-if + case + &&/|| + ? : + catch + for + while)` | Improvement (> 10) / Changes Requested (> 15) |
| **Cognitive complexity** | ≤ 15 | Add +1 per structural decision and +N for nesting (SonarQube rule) | Improvement (> 15) |
| **Duplicated block** | 0 duplicated blocks of ≥ 6 LOC | Any two ≥ 6-line segments with identical tokens (ignoring whitespace) | Improvement — extract shared helper |
| **Statement in file** | ≤ 200 | Total executable statements per `code.js` | Consider splitting into multiple custom functions |
| **Return paths** | ≤ 6 per function | `return` statement count | Improvement — refactor with single-exit or state map |
| **Boolean params** | ≤ 1 | Count of params typed `boolean` (inferred from use) | Improvement (> 1) — replace with enum/string or separate functions |

**Measurement tool**: For numerical scoring, run any SonarJS-compatible linter against `functions/*/code.js` locally. Thresholds above align with SonarQube's "way of the cleaner" profile minus 1 level (Make's ES5.1 sandbox rewards simpler code).

---

## 2. IMLJSON-Specific Smells

These smells appear in `*.imljson` files and are **not** covered by the JS-focused "Code Quality" section in `code-review-criteria.md`.

### 2.1 `api.imljson`

| ID | Smell | Detect | Fix |
|---|---|---|---|
| A-01 | Repeated deep IML path (≥ 3 occurrences of `{{parameters.a.b.c}}`) | grep for the path inside one `api.imljson` | Promote to `temp.someName` at the top of the request, reference `{{temp.someName}}` below |
| A-02 | Nested inline `if()` / `switch()` in `url` or `body` (≥ 2 levels) | Visual scan — expressions longer than ~120 chars with nested parens | Extract to a custom IML function under `functions/` |
| A-03 | Copy-pasted request headers across modules | Same header block present in > 2 modules while `base.imljson` does not define it | Move to `base.imljson` `headers` |
| A-04 | Hardcoded API version / page size / base path duplicated | Literal `"v1"`, `"pageSize": 50` in multiple files | Centralize in `base.imljson` (`baseUrl`, common `qs`) or `common.imljson` (when user-configurable) |
| A-05 | Dead `"condition": true` / empty `"temp": {}` | Literal JSON nodes that have no runtime effect | Remove |
| A-06 | Multi-request array > 3 sequential calls with no rollback path | `api.imljson` is an array of > 3 objects and no `error` directive on intermediate steps | Extract to a single module or add explicit error handling for partial failures |
| A-07 | `"output": "{{body}}"` when iterate is also used | Output is the full body while response iterates — consumers get wrong shape | Use `"output": "{{item}}"` or pick explicit fields |
| A-08 | `parameters.limit` used in both `qs`/`body` and `response.limit` | Double application — user-entered limit caps API pagination AND result count, halving effective output | Hardcode API-side page size (e.g. `100`); keep `parameters.limit` only in `response.limit` |
| A-09 | `condition` string evaluated but result unused | `"condition": "{{parameters.foo}}"` without any dependent branch | Remove or convert to a guard directive |

### 2.2 `parameters.imljson` / `expect.imljson`

| ID | Smell | Detect | Fix |
|---|---|---|---|
| P-01 | Type drift vs `interface.imljson` | Same field name: `expect.type = "number"` but `interface.type = "text"` | Align types; document transformation if intentional |
| P-02 | Required field with no `help` and non-obvious format | `required: true` field for an ISO date, UUID, cron string, JSON, etc. without `help` | Add a one-line `help` with a concrete example |
| P-03 | `nested` used where flat `rpc://` would do | Nested RPCs on Get / Update / Delete modules (users typically map IDs) | Flatten — see `code-review-criteria.md` § "ID Select Field Pattern" |
| P-04 | `default` value duplicates API default | Explicit `default: 10` that also happens to be the API default | Either remove (reduce UI clutter) or add a hint explaining why it's exposed |
| P-05 | Mixed casing conventions in the same file | `createdBy` and `created_by` both present | Pick one per module. Never rename existing params in published apps — add temp mapping in `api.imljson` instead (see `code-review-criteria.md` § "Breaking Changes") |
| P-06 | `editable: true` in module expect | `editable` is a connection-only flag | Remove from expect |

### 2.3 `samples.imljson`

| ID | Smell | Detect | Fix |
|---|---|---|---|
| S-01 | Empty `{}` / `[]` | File exists but provides no sample | Populate with at least one realistic synthetic record so downstream modules can map fields at design time |
| S-02 | Shape mismatch vs `interface.imljson` | Sample has keys absent from interface or missing interface keys | Regenerate sample from a real API response (then anonymize per `security-reference.md` § 1.6) |
| S-03 | Sample contains real production data | Real emails, IDs, phone numbers | See `security-reference.md` § 1.6 |

### 2.4 `interface.imljson`

| ID | Smell | Detect | Fix |
|---|---|---|---|
| I-01 | Missing `label` on a non-trivial field | Field with `name: "crtdAt"`, no `label` | Add human-readable `label` (e.g., `"Created at"`) |
| I-02 | `type: "collection"` with 20+ flat children | Very wide output collection dumps that could be grouped | Group semantically (e.g., `address.*`, `billing.*`) |
| I-03 | Output labels in Title Case while the app uses Sentence case everywhere else (or vice versa) | Mixed capitalization conventions across modules | Normalize — follow the app's established style |

---

## 3. Cross-File / App-Level Smells

| ID | Smell | Detect | Fix |
|---|---|---|---|
| X-01 | Helper logic duplicated across modules | Same 10+ line transformation exists in multiple `functions/` entries or inline in multiple `api.imljson` files | Extract one custom IML function and call it from each |
| X-02 | Connection settings copied across multiple connection folders | Two connections with near-identical `api.imljson` (only scope differs) | Consider `aliasTo` or consolidate into one connection with dynamic scope — see `component-patterns-reference.md` |
| X-03 | Base drift | `base.imljson` missing `baseUrl` / `headers.Authorization` while every module re-declares them | Move to base |
| X-04 | Group fragmentation | Many single-module groups in `groups.imljson` | Consolidate logically related modules into one group |
| X-05 | Orphan function | `functions/{name}` not referenced from any `api.imljson` or other function | Delete or document planned usage |

---

## 4. Review Output Format

When flagging a smell from this reference, the review line should read:

```
[QUALITY][A-01] Repeated deep IML path
File: modules/ListItems/api.imljson:18-42
Problem: `{{parameters.filter.status}}` referenced 5 times inline.
Fix: Add `"temp": { "status": "{{parameters.filter.status}}" }` at the top of the request; reference `{{temp.status}}` below.
```

The bracketed ID (`A-01`, `P-02`, `X-03`, etc.) lets reviewers and developers trace a finding back to this reference. Quantitative threshold findings use the metric name:

```
[QUALITY][function-length=62] functions/normalizeEmail/code.js
Problem: Function body is 62 effective lines (threshold 40).
Fix: Split into `normalizeLocal(local)` and `normalizeDomain(domain)`; compose them.
```
