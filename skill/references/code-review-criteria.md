<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# Code Review Criteria

> Read when: performing a code review — after `workflows/code-review.md` has set the skip rules and gates. This file defines the review categories, the out-of-scope list, and the per-file-type checks. The checks for `function/*/code`, `expect` / `parameters` and `api` / connection changes sit in `code-review-criteria/` parts: open the part for every change type in the change set (§ Parts).

## Parts (open every part whose trigger applies, skip the rest)

| Part | Open when |
|---|---|
| [code-review-criteria/functions.md](code-review-criteria/functions.md) | **Mandatory** when the change set has `function/*/code`: test coverage, ES6+, code quality |
| [code-review-criteria/ux.md](code-review-criteria/ux.md) | **Mandatory** when the change set has `expect` / `parameters` changes |
| [code-review-criteria/api-imljson.md](code-review-criteria/api-imljson.md) | **Mandatory** when the change set has an `api`, `base`, `epoch` or webhook `attach` / `detach` change, or any connection change; also for a new app (branding consistency). Covers integration tests, runtime behavior checks, OAuth scope placement, polling triggers (order, date filtering) |

For every change type: IMLJSON-specific smells (`api.imljson`, `parameters.imljson`, `expect.imljson`, `samples.imljson`, `interface.imljson`) → `code-smells-reference.md` §§ 2–3. Cite with the smell ID, e.g. `[QUALITY][A-01]`.

## Review Categories

Evaluate each change against the following categories:

### Breaking Changes (risk of breaking existing scenarios)

> **Skip rules #1–#5** (app-level, new component, scaffold `old_value`, endpoint, no production surface) are defined once in [code-review.md § Skip rules](../workflows/code-review.md). Decide them per change before evaluating this category. Skip #5 also suppresses Bugs. When `old_value` is the SDK scaffold, judge `new_value` alone — the diff is meaningless. A new module's `private` / publish state is **never** a finding.

- Interface output fields removed/renamed → existing scenario mappings may break
- Expect/Parameters fields removed/renamed → existing scenario settings become invalid
- **Never suggest renaming existing expect parameter names for consistency.** Renaming a parameter (e.g., `createdBy` → `created_by`) destroys all user mappings in production scenarios. If the API expects snake_case but existing params are camelCase, the correct fix is to map in `api.imljson` (via `temp` or explicit body mapping) while keeping the original param names. Cross-module naming inconsistency (e.g., CreateFeature uses snake_case, UpdateFeature uses camelCase) is acceptable when the alternative is breaking existing scenarios.
- Connection parameters changed → existing connections may break
- Module type changed → scenario compatibility broken
- Trigger configuration changed (id/date field, type, order) → risk of duplicate/missed triggers
- API URL path changes that alter functionality

### Bugs (potential bugs)

> Skip #5 (no production surface) applies here too — see [code-review.md § Skip rules](../workflows/code-review.md).

- Incorrect variable references in IML expressions (e.g., `{{parameters.filed}}` typo)
- Missing required fields (no response.output, no error handling, etc.)
- JSON structure errors (missing brackets, incorrect nesting)
- Infinite loop potential in pagination (condition always true)
- Temp variable mismatch in sequential requests
- Output not using `{{item}}` when iterate is used

### Improvements (recommended enhancements)

- Missing or generic-only error handling
- Missing log sanitize (Authorization, API key, or other sensitive data exposed)
- Missing pagination (risk of data loss with large datasets)
- Unnecessary API calls (could be skipped with condition)
- Hardcoded values (baseUrl, API version, etc. → should move to base.imljson)
- Missing `ifempty()` / null checks
- Missing `label` in interface fields (UX degradation)
- Duplicate code patterns (common logic could be extracted to RPC or base)

### Security

Full catalogue with severity, detection patterns, and fix guidance lives in **`security-reference.md`**. Do **not** duplicate those checks here. When flagging, cite the numeric ID from that file (e.g., `[SECURITY][1.2]`, `[SECURITY][3.1]`).

High-impact triggers that must always force opening `security-reference.md`:

- Any change touching `common.imljson`, `connections/*/install*`, `connections/*/authorize.imljson`, `connections/*/token.imljson`, `connections/*/refresh.imljson` → review §§ 1–2 end to end
- Any change touching `connections/*/scope.imljson` or `scopes.imljson`, a module or endpoint `scope.imljson`, or a new OAuth connection → review § 2.3 and `code-review-criteria/api-imljson.md` § "OAuth Scope Placement"
- Any webhook change (`webhooks/**`) → review § 3 (signature, replay, secret type)
- Any `api.imljson` that takes a URL or hostname from user input → review § 4 (SSRF)
- Any new/modified `functions/*/code.js` handling untrusted input, dynamic keys, or regex → review § 5
- Any change to `response.output` / `response.temp` / error `message` → review § 6 (sensitive data exposure)

### LGTM (no issues)

- None of the above apply and the code correctly follows Make app patterns

---

## Out of Scope (Do NOT flag)

The following categories are **explicitly excluded** from code review output. Do not mention, flag, or suggest changes for these — even as "nit" or "informational":

### Formatting & Indentation

- **Whitespace-only changes** (tabs ↔ spaces conversion, trailing whitespace, blank line additions/removals)
- **Indentation style drift** (e.g., a file switching between 2-space, 4-space, or tabs)
- **Whole-file re-indentation** even when the actual logic change is a single line
- **Diff noise** caused by editor auto-format on save
- **Line ending changes** (LF vs CRLF)

**Rationale**: Formatting is a tooling concern, not a correctness concern. IMLJSON has no enforced style — both tabs and spaces are valid, indentation is purely cosmetic. Flagging these adds noise to reviews without preventing bugs or runtime issues. If the team later adopts a formatter (Prettier config, `.editorconfig`), formatting consistency is enforced by the tool — not by human review.

**What to do instead**: When diffing changes, use `diff -w -u` (ignores whitespace) to extract the real logical change. Evaluate only the meaningful diff. If the diff is 100% whitespace → the file is effectively unchanged for review purposes.

**Exception — functional impact**: Flag only if whitespace change causes actual behavior change (e.g., breaking a template literal, altering a JSON string value). This is extremely rare in IMLJSON files.

### `pagination.condition` with `>=` and `pagination.page` (Do NOT flag as "extra request")

When a `total_pages`-style API uses the runtime's `pagination.page` variable directly in `api.pagination.condition`, `>=` (or its inverted form `pagination.page <= total_pages`) is the **correct** pattern. **Do NOT** suggest changing it to `>` — that breaks pagination by silently dropping the last page.

| Pattern (uses `pagination.page`) | Verdict | Why |
|---|---|---|
| `{{body.pagination.total_pages >= pagination.page}}` | **Correct** | Runtime evaluates `condition` twice per cycle (after response + before next request); second check sees the post-increment page number. `>=` correctly stops on the iteration **after** the last page is fetched. |
| `{{pagination.page <= body.pagination.total_pages}}` | **Correct** | Equivalent to `>=`; this is the form used in the runtime's own pagination tests (`test/pagination.spec.ts:921`). |
| `{{body.pagination.total_pages > pagination.page}}` | **Bug** | Off-by-one: second condition check fires with `pagination.page = N+1`, so `total_pages > N+1` becomes false one page early → request for the last page is skipped → last page's data is never returned. Flag as `[BUG]`. |
| `{{pagination.page < body.pagination.total_pages}}` | **Bug** | Same off-by-one as `>`. Flag as `[BUG]`. |

**Body-driven conditions** (`{{body.has_more}}`, `{{body.current_page < body.total_pages}}`, `{{body.next_cursor}}`) reference fields on the **just-received response** rather than the runtime's pre-incremented `pagination.page`, so `<` / `>` / `==` behave intuitively in those forms — review them on their own merits.

Full mechanism: see [runtime-reference/pagination.md § "`pagination.condition` is Evaluated TWICE per cycle"](runtime-reference/pagination.md#paginationcondition-is-evaluated-twice-per-cycle-critical). Re-read it before flagging any `pagination.condition` change.

### IML Path `[]` / `[1]` Shorthand (Do NOT flag as "array wrap")

`{{body.results[].field}}` and `{{body.results[1].field}}` both resolve to a **scalar** — the first item's `.field` — because IML path indices are 1-based and empty brackets default to `n = 1`. They are **not** an array wrap, iteration, or map.

| Pattern | Resolves to | Flag? |
|---|---|---|
| `{{body.items[].field}}` | First item's `field` (scalar) | **No** — idiomatic "unwrap single-item array" |
| `{{body.items[1].field}}` | First item's `field` (scalar) | **No** — identical to `[]` |
| `{{body.items[2].field}}` | Second item's `field` (scalar) | **No** — explicit index |
| `{{body.items[0].field}}` | `undefined` (JS `arr[-1]`) | **Yes — Bug.** Never use `[0]` in IML paths. |

Common anti-pattern mistake: flagging `{{body.newMediaItemResults[].mediaItem}}` as "output is wrapped in an array". It is not — `[]` picks the first (and in this case only) element, producing a scalar `mediaItem` object.

See [runtime-reference.md § IML Variable Path Syntax](runtime-reference.md#iml-variable-path-syntax) for the full source excerpt and index semantics.

### `scopes.imljson` Empty Object `{}` (Do NOT flag as Improvement)

`connections/{name}/scopes.imljson` is an **object** keyed by scope-name → human-readable description (catalog for the `additionalScopes` picker UI), **not** an array. An empty `{}` simply means the connection offers no extra scopes beyond what `scope.imljson` and module/RPC `scope.imljson` already request — this is **common and valid**, used by `google-ads-conversions`, `google-ads-customer-match`, `whatsapp-business-cloud`, `cloudconvert`, `getresponse`, `github`, `google-merchant`, etc.

| File | Correct shape | Wrong shape (real bug) |
|---|---|---|
| `connections/{name}/scope.imljson` | Array `["<scope-url>", ...]` (default active scopes) | `{}` object — runtime expects array |
| `connections/{name}/scopes.imljson` | Object `{ "<scope>": "<description>" }` (catalog for `additionalScopes` UI) | `[]` array — picker UI fails to render |

**Do NOT** suggest converting `scopes.imljson` `{}` → `[]`. That inverts the schema. The opposite mistake (`scope.imljson` `{}` instead of `[]`) **is** a bug — flag those.

Full mechanism, including how the active scope set is composed at OAuth `authorize` time (connection scope ∪ triggering module's scope ∪ user's `additionalScopes`), in [component-patterns-reference/connection-oauth.md § "OAuth Scope Files"](component-patterns-reference/connection-oauth.md#oauth-scope-files--scopeimljson-vs-scopesimljson).

### OAuth2 `authorize.qs` missing `state` (Do NOT flag)

OAuth2 CSRF `state` is **not** an app-authored IML field. `app-runtime-oauth2` `authorize()` always overwrites `qs.state` with `crypto.randomBytes(12).toString('hex')` after the IML transform, then stores it and validates it on callback. `{{oauth.state}}` does **not** exist on the IML context (`oauth` is the redirects object only).

| Pattern | Verdict | Why |
|---|---|---|
| `authorize.qs` has no `state` | **Correct** | Runtime injects and validates `state`. Do not flag. |
| `"state": "{{oauth.state}}"` in `authorize.qs` | **Dead code** | `oauth.state` is undefined; runtime overwrites `qs.state` anyway. Do not ask the developer to add it. Do not flag as a missing-security bug if it is absent. |

**Do NOT** cite `[SECURITY][2.2]` as a High finding for a missing `state` key. That ID is a documented false-positive trap, not a verdict.

Full mechanism: [runtime-reference/oauth-connection-variables.md](runtime-reference/oauth-connection-variables.md#oauth-connection-variables) and [security-reference.md](security-reference.md) § 2.2.

---

## Removed Code Verification (Mandatory before flagging removals as bugs)

When code is **removed** in a change (headers deleted, parameters dropped, expressions stripped), **never assume the removal is a bug — but never assume it's safe cleanup either**. Verify with all three steps before judging:

1. **Does the removed reference exist in the component's own scope?** — Check the component's own `parameters.imljson`, `expect.imljson`, etc. If defined there, removal may break functionality.
2. **Is the functionality covered elsewhere?** — Check `base.imljson` headers, connection parameters, and inherited context. If base already provides the same header/value, the component-level copy may be redundant.
3. **Who calls this component and in what context?** — Check all callers (`rpc://`, `options`, nested params). An RPC called from connection parameters (e.g., `rpc://getIndexes` nested under a connection field) receives parent field values as `parameters.*` — even if the RPC's own `parameters.imljson` is empty. Removing such references breaks the connection setup flow.

**All three steps must pass before concluding a removal is safe.** Step 3 is critical — a value not defined in the component's own parameters can still be essential if passed by a caller.

---
