<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# Code Review Criteria

Detailed review criteria for Make custom app code reviews. Referenced by the code review workflow (`workflows/code-review.md`) and the static § R TODO template (`rules/make-app-todo-review.mdc`).

## Review Categories

Evaluate each change against the following categories:

### Breaking Changes (risk of breaking existing scenarios)

> **Skip conditions** (do not evaluate the Breaking Changes category at all):
>
> 1. **App-level skip** — If the Jira ticket's `issuetype.name` is **"App"**, skip this category for the entire app. App-type tickets are new apps not yet deployed to production, so no existing scenarios exist that could break.
> 2. **Per-change skip — no `old_value`** — If the change reported by `review-changes.js` is a **pure new-component creation** (a module, RPC, webhook, connection, function, or group whose files have `new_value` only, with no `old_value`), skip breaking-change evaluation for that component. A brand-new component has never been placed in any scenario, so the "existing mapping broken" concept does not apply.
> 3. **Endpoint skip (always)** — changes whose `group` is `endpoint` are SDK Endpoints (see [endpoints-reference.md](endpoints-reference.md)): not scenario-runnable (MCP `endpoint_execute` / platform Run Endpoint only), so no existing scenario mappings can break. Always skip Breaking Changes for endpoint changes. A shared custom IML function edited for an endpoint CAN still break modules that reuse it — evaluate that under the `function/{name}/code` change. Also: missing `required`/`default` enforcement when calling endpoints via MCP is a known platform gap (Executor initiative) — never flag it as a Bug.
> 4. **Per-change skip — `old_value` is the default scaffold template** — A newly created module/RPC is pre-filled by the SDK with Make's **default scaffold boilerplate** (placeholder `"url": "/users"`, `"iterate": "{{body.users}}"`, the standard scaffold comments such as `// Relative to base URL`, `// Query string`, `// Splits array from API response into bundles`, and — for triggers — a default `response.trigger`). `review-changes.js` reports this boilerplate as the `old_value`, but it is **not a real prior implementation**, so the component is effectively new → skip breaking-change evaluation. Decide first from the **ticket** whether the work is new-component implementation, then confirm by checking whether the `old_value` is the untouched scaffold (not a real previous version). The canonical scaffolds live in the `model` template app (slug `model`, version 1 — `download-app.js model 1`, see `modules/{Action,Search,Trigger,Universal,…}/api.imljson`). Recognition markers: `"url": "/users"` or `/users/{{parameters.id}}`, `"iterate": "{{body.users}}"`, `"qs": { "pageSize": 100 }`, default `response.trigger` (`id:{{item.id}}`, `date:{{item.created}}`, `order:desc`), and the boilerplate `// Relative to base URL` / `// Splits array from API response into bundles` comments. **Deterministic check:** compare `old_value` (whitespace-/comment-insensitive) against the matching template in [`component-scaffold-templates.md`](component-scaffold-templates.md) (every per-type scaffold — module by `typeId`, RPC, webhook, connection); a match = untouched template = new component. When ambiguous, run the Breaking eval rather than skipping.
>
> In all cases, the review output's Analysis must explicitly state the skip reason:
>
> > Breaking Changes check skipped — new {app | component: `{group}/{item}`} (no existing scenarios).
>
> All other categories (Bugs, Improvements, Security, ES6+, Code Quality, Tests, UX, Runtime, Polling Triggers) still apply as usual, and the quality of `new_value` is **always** reviewed. **`old_value` comparison rule:** review the `old_value → new_value` diff **only when `old_value` is a real prior implementation**. When `old_value` is the `model` scaffold template, the diff is meaningless — **skip the `old_value` comparison entirely** and judge `new_value` standalone. **Modifications to real existing components** (changes whose `old_value` is a genuine prior implementation, not the scaffold template) are still subject to breaking-change evaluation — judge this per change, not per app. This includes shared components (`base`, a shared RPC, etc.) that a new-component task happens to touch. Example: "new module B added (`old_value` = scaffold → skip diff + breaking) + shared RPC A modified (`old_value` = real impl → full diff + breaking eval)".
>
> **Publish/visibility state is never a finding.** A new module is normally `private: true` / `private: null` in `metadata.json` during implementation and review; the deployer makes it visible in the scenario builder after QA. Do NOT raise a new module's `private`/publish/visibility state as a Breaking Change, Bug, or Improvement.

- Interface output fields removed/renamed → existing scenario mappings may break
- Expect/Parameters fields removed/renamed → existing scenario settings become invalid
- **Never suggest renaming existing expect parameter names for consistency.** Renaming a parameter (e.g., `createdBy` → `created_by`) destroys all user mappings in production scenarios. If the API expects snake_case but existing params are camelCase, the correct fix is to map in `api.imljson` (via `temp` or explicit body mapping) while keeping the original param names. Cross-module naming inconsistency (e.g., CreateFeature uses snake_case, UpdateFeature uses camelCase) is acceptable when the alternative is breaking existing scenarios.
- Connection parameters changed → existing connections may break
- Module type changed → scenario compatibility broken
- Trigger configuration changed (id/date field, type, order) → risk of duplicate/missed triggers
- API URL path changes that alter functionality

### Bugs (potential bugs)

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

Full mechanism: see [runtime-reference.md § "`pagination.condition` is Evaluated TWICE per cycle"](runtime-reference.md#paginationcondition-is-evaluated-twice-per-cycle-critical). Re-read it before flagging any `pagination.condition` change.

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

Full mechanism, including how the active scope set is composed at OAuth `authorize` time (connection scope ∪ triggering module's scope ∪ user's `additionalScopes`), in [component-patterns-reference.md § "OAuth Scope Files"](component-patterns-reference.md#oauth-scope-files--scopeimljson-vs-scopesimljson).

---

## Test Coverage Enforcement (Mandatory for `functions/*/code.js`)

When a `functions/{name}/code.js` file is changed, **always** check the corresponding `functions/{name}/test.js`:

1. **test.js missing entirely** → verdict **Improvement Needed**. Flag with `[IMPROVEMENT]` and list required test cases.
2. **test.js exists but has no tests for the changed behavior** → verdict **Improvement Needed**. Flag the specific missing cases.
3. **test.js exists and covers the changed behavior** → no action needed.

**What to check:**
- Does the test file cover the new/changed logic paths? (e.g., new filter condition for `false` → must have a test for `false`)
- Are edge cases tested? (`null`, `undefined`, `false`, `0`, empty string, empty array/object)
- If the function had existing tests, do they still align with the new behavior? (no stale assertions)

Any test gap for changed behavior results in verdict **Improvement Needed**. Include specific test cases the developer should add in the review output AND the To Developer message.

### Auto-Run Tests for Changed Functions (Mandatory)

When **any** `functions/*/code.js` file is changed in the review, **automatically run `test-function.js`** after downloading the app code:

```
node ${SKILL_ROOT}/scripts/test-function.js <app-slug> <app-version>
```

- Run once with **no function filter** to test all functions (catches regressions across the app)
- Include the test results in each function's review section under **Test Coverage**
- If tests **fail** → flag in the review with the failure details. Distinguish between:
  - **Pre-existing failures** (test was already broken before this change) — note but do not count as a new issue
  - **New failures** (test broke due to this change) — verdict **Bug** or **Breaking Change**
- If tests **pass** → note "All tests pass" in the Test Coverage field

### Component Integration Tests (Mandatory for api.imljson changes)

**Before running or writing component tests**, re-read `${SKILL_ROOT}/references/component-test-guide.md` for communications mock structure, `transformOutput()`, and `assert.deepStrictEqual` patterns.

When **any** component's `api.imljson` file is changed in the review (modules, RPCs, connections, webhooks), **automatically run `test-component.js`** after `download-app.js` completes:

```
node ${SKILL_ROOT}/scripts/test-component.js <app-slug> <app-version> <component-type> [component-names...]
```

- Determine the component type and name from the changed file path (e.g., `modules/CreateItem/api.imljson` → `module CreateItem`)
- Run `test-component.js` for each affected component type
- If tests exist for the changed component (`test.js` in mockup data) → include results in the review under **Component Test**
- If tests **fail** → flag in the review. Distinguish between:
  - **Pre-existing failures** (test was already broken before this change) — note but do not count as a new issue
  - **New failures** (test broke due to this change) — verdict **Bug** or **Breaking Change**
- If tests **pass** → note "Component tests pass" in the review
- If no tests exist for the component → note "No component integration test found" (not a blocking issue)

**Requires**: `make-apps-mockup-path` configured in SKILL.md. If not configured, skip with a note:
> Component integration tests skipped — `make-apps-mockup-path` not configured in SKILL.md.

---

## UX Guideline Compliance (Mandatory for expect/parameters changes)

When expect or parameters files are changed, **read `${SKILL_ROOT}/references/app-ux-best-practices.md` first** and verify:

- **Label capitalization**: Sentence-style by default, but follow the app's existing convention if consistently Title Case
- **Label naming**: 1–3 words, descriptive not instructional, no articles
- **Hint formatting**: Examples in backticks, default values in backticks, links with app name + page name
- **Hint template**: Limit fields must use the standard template from "Templates: Universal Hints"
- **Terminology accuracy**: Labels and option names must match the actual input format (e.g., don't label "JSON" if the format is GraphQL)

Any violation results in verdict **Improvement Needed**.

### ID Select Field Pattern (Do NOT flag as Improvement)

For **Get / Update / Delete** modules, ID select fields with `"mode": "edit"` and a flat `rpc://` (without nested RPCs) are the **correct pattern** — not an improvement opportunity. Users of these modules typically **map** the ID from a previous module's output rather than selecting from a dropdown. Nested RPC cascading (parent → child) adds unnecessary complexity for these module types.

Only flag missing nested RPCs on **Create** modules or modules where the user is expected to configure values from scratch.

See `app-ux-best-practices.md` § "ID Select Fields: `mode: edit` and Nested RPC Usage by Module Type" for details.

### `help` Text Evaluation (for expect/parameters changes)

When `help` properties are added, removed, or modified, evaluate their **actual UX value** — not just their presence:

- **Redundant `help`** (restates the label): Removing these is **cleanup, not UX regression**. Do NOT flag as Improvement Needed.
  - Example: label `"Name"` → help `"Enter the name."` — adds zero value
  - Example: label `"Value"` → help `"Enter the value."` — adds zero value
- **Meaningful `help`** (provides guidance beyond the label): Removing these IS a UX regression. Flag as Improvement Needed.
  - Example: help `"Use ISO 8601 format (e.g., 2024-01-15T10:30:00Z)"` — actual format guidance
  - Example: help `"Comma-separated list of IDs (max 100)"` — constraints and format
- **Missing `help` on complex fields**: When a field requires non-obvious input (format, constraints, examples), suggest adding meaningful `help` as an improvement — but do NOT flag the absence of trivial `help` as an issue.

### `validate.pattern` Behavior (for expect/parameters changes)

Two facts to apply before flagging anything about a field's `validate` — see `parameters-reference.md` § Validation for the source detail:

- **`validate` (incl. `pattern`) IS enforced at runtime, on resolved mapped values — NOT UI-only.** Make core validates each resolved parameter through the shared `@integromat/forman` type validators (`lib/types/*.ts`, *"used by both front-end and back-end"*) at execution. So **do NOT flag** "a mapped value like `{{1.x}}` bypasses `validate.pattern` at runtime" — that is a **false positive**. (`imt-app-runtime` has no param validation, but the layer above it does. Real mistake: IEN-15781 review, make-ai-web-scraper.)
- **`validate.pattern` is case-sensitive** — the platform compiles it as `new RegExp(pattern, 'u')` (no `i` flag; `@integromat/forman` `lib/types/text.ts`). **DO flag** a lowercase-only pattern used for a security/compliance rule (e.g. a domain deny-list) as a **Bug**: mixed-case input (`https://Facebook.com`) bypasses it, and `^https://` rejects an uppercase `HTTPS://` scheme. Recommend baking case into the pattern (char classes) or enforcing in a custom IML function (`toLowerCase()`), which is case-robust for typed + mapped values.

---

## ES6+ Enforcement (Mandatory for `functions/*/code.js`)

**Scope**: All **newly written or modified lines** in the diff. Unchanged existing code is out of scope.

Any violation in changed/new code results in verdict **Improvement Needed**. Do NOT overlook these.

| Pattern | Required (ES6+) | Violation (flag it) |
|---|---|---|
| Variables | `const` / `let` | `var` |
| Callbacks | Arrow functions `(x) => x.id` | `function(x) { return x.id; }` |
| Strings | Template literals `` `${name}` `` | `'Hello ' + name` |
| Iteration | `.map()`, `.filter()`, `for...of` | `for (var i = 0; ...)` |
| Null checks | `value != null`, `value?.prop` | `value !== undefined && value !== null` |
| Destructuring | `const { a, b } = obj` | `const a = obj.a; const b = obj.b;` |
| Default params | `function fn(opts = {})` | `opts = opts \|\| {}` |

**Review checklist for each changed function file:**

1. Scan every new/modified line in the diff for `var`, `function(`, string concatenation, verbose null checks
2. If found → flag as `[IMPROVEMENT]` with the exact line and the ES6+ replacement
3. If the function signature itself was touched, ensure it also follows conventions

---

## Code Quality & Maintainability (Mandatory for `functions/*/code.js`)

**Scope**: All **newly written or modified** functions in the diff. Review as a **senior JavaScript engineer** — flag any code that a mid-level or junior developer would write when a cleaner, more idiomatic pattern exists.

Any violation in changed/new code results in verdict **Improvement Needed**.

**Companion references** (do not restate their content here — link to them in the review output):

- **Quantitative thresholds** (function length, cyclomatic/cognitive complexity, param count, nesting, duplication) → `code-smells-reference.md` § 1. Cite a metric violation as `[QUALITY][function-length=62]` etc.
- **IMLJSON-specific smells** (`api.imljson`, `parameters.imljson`, `expect.imljson`, `samples.imljson`, `interface.imljson`) → `code-smells-reference.md` §§ 2–3. Cite with the smell ID, e.g. `[QUALITY][A-01]`.
- The JS **design principles** and **code smells** tables below remain the authoritative list for qualitative JS review (apply to `functions/*/code.js` only).

### Design Principles

| Principle | Violation (flag it) | Preferred Pattern |
|---|---|---|
| **Data over branching** | 3+ conditional branches performing the same structural operation (e.g., value mapping, name assignment) | Lookup map / config object |
| **DRY (Don't Repeat Yourself)** | Copy-pasted logic blocks with minor variations across branches | Extract shared helper, parameterize differences |
| **Open/Closed** | Adding a new case requires modifying control flow | Data-driven structure where new cases are a single-line config addition |
| **Single Responsibility** | One function doing too many things (transformation + routing + error handling + side effects) | Split into focused, composable functions |
| **Declarative over imperative** | Index-based manual loops, manual accumulation, imperative state mutation | `.map()`, `.filter()`, `.reduce()`, `for...of`, spread syntax |

### Code Smells

| Smell | Example | Why It's a Problem |
|---|---|---|
| **Spaghetti flow** | Deeply nested callbacks/conditions (3+ levels), interleaved concerns, unclear execution path | Unreadable, untestable, high bug surface |
| **God function** | Single function >40 lines handling multiple unrelated tasks | Violates SRP, impossible to unit test individual behaviors |
| **Magic values** | Hardcoded strings/numbers scattered in logic without named constants | Fragile, grep-hostile, no single source of truth |
| **Mutation over transformation** | Modifying input objects in-place (`obj.x = y`) when a new object would be safer | Unexpected side effects, harder to debug and test |
| **Boolean blindness** | `if (flag1 && !flag2 && flag3)` — multiple booleans controlling flow without clarity | Replace with descriptive variable names or strategy pattern |
| **Null/undefined juggling** | Verbose manual checks instead of `??`, `?.`, `||` with clear intent | Noisy, error-prone, obscures business logic |
| **Dead code** | Unreachable branches, unused parameters, empty function bodies registered as app functions | Confusing, maintenance burden, misleading to other developers |
| **Inconsistent return types** | Function returns `undefined`, array, or object depending on code path | Caller must handle multiple shapes — fragile contract |

### Review Checklist

1. **Structure**: Does the function have a clear, linear flow? Or is it a maze of nested conditions and mutations?
2. **Extensibility**: If a new case is added (e.g., new tool type), does it require 1 line (config) or 10+ lines (new branch)?
3. **Readability**: Can another developer understand the function's purpose within 10 seconds of reading it?
4. **Testability**: Can each behavior path be tested independently? Are side effects isolated?
5. If any checklist item fails → flag as `[IMPROVEMENT]` with the specific code and the idiomatic alternative
6. Exception: If each branch has **substantially different logic** (not just value assignment or simple transformation), imperative branching is acceptable

---

## Removed Code Verification (Mandatory before flagging removals as bugs)

When code is **removed** in a change (headers deleted, parameters dropped, expressions stripped), **never assume the removal is a bug — but never assume it's safe cleanup either**. Verify with all three steps before judging:

1. **Does the removed reference exist in the component's own scope?** — Check the component's own `parameters.imljson`, `expect.imljson`, etc. If defined there, removal may break functionality.
2. **Is the functionality covered elsewhere?** — Check `base.imljson` headers, connection parameters, and inherited context. If base already provides the same header/value, the component-level copy may be redundant.
3. **Who calls this component and in what context?** — Check all callers (`rpc://`, `options`, nested params). An RPC called from connection parameters (e.g., `rpc://getIndexes` nested under a connection field) receives parent field values as `parameters.*` — even if the RPC's own `parameters.imljson` is empty. Removing such references breaks the connection setup flow.

**All three steps must pass before concluding a removal is safe.** Step 3 is critical — a value not defined in the component's own parameters can still be essential if passed by a caller.

---

## Runtime Behavior Verification (Mandatory for api.imljson changes)

When reviewing `api.imljson` changes that use runtime variables, IML context features, or middleware behavior (e.g., `environment`, `temp`, `condition`, `pagination`, `iterate`, `valid`, `repeat`):

1. **First**: Check `${SKILL_ROOT}/references/runtime-reference.md` for documented behavior
2. **If not found or still uncertain**: Search the `imt-app-runtime` source code directly (path in SKILL.md's last line `imt-app-runtime-path:`) to verify actual runtime behavior

**Never assume or guess** how runtime features work. Common mistakes to avoid:
- **Flagging explicit body mapping as "sending empty values"** — When `api.imljson` maps params explicitly (e.g., `"name": "{{parameters.name}}"`), unfilled params evaluate to `undefined`, which `JSON.stringify` omits. The `temp` + `_.merge` pattern also skips `undefined` values. Do NOT flag this as a bug. See `runtime-reference.md` § "Undefined parameter handling in temp" for full details.
- **Flagging missing `token.response.data.{field}` save as a `connection.{field}` lookup bug** — Connection-form `parameters.imljson` user inputs are **automatically** exposed under `connection.*` in every context (modules, RPCs, webhooks). The runtime aliases `parameters` and `connection` over the same `account.data` store (`imt-app-runtime/accounts/app-runtime-oauth2/lib/account.js` lines 86–87, plus the OAuth1/Basic equivalents). Do NOT flag a missing explicit save as a bug when the field is already defined in the connection's `parameters.imljson` — `{{connection.fieldName}}` resolves correctly. Explicit `response.data.{field}` save is only needed when the value must be (a) transformed before downstream use (e.g., `customerId: "{{replace(parameters.customerId, '-', '')}}"`), (b) derived from the API response (tokens, expiry, uid from `/userinfo`), or (c) populated for a field NOT present in `parameters.imljson`. See `component-patterns-reference.md` § "Connection Pattern" → "Connection Flow" for the full mechanism.
- Confusing `{{environment.timezone}}` (scenario env, always available) with `flags.environmentAccess` (server-side `process.env`, requires flags)
- Assuming middleware behavior without checking the actual execution chain
- Misunderstanding pagination stop conditions or trigger epoch mechanics

### Aliased Connections (Mandatory check for connection changes)

Before reviewing any change to `connections/{name}/*.imljson`, open the app's `metadata.json` and check `connections[].aliasTo`.

- **If `aliasTo` is set** → every file in that connection (`api`, `parameters`, `common`, `scope*`, `install*`) is **excluded at compile time**. The runtime uses the connection referenced by `aliasTo` (which may live in a different app).
- **Review implication**: Flag the change as a **runtime no-op**, even if the diff looks syntactically correct. The real fix must go into the source app's connection. A harmless commit can still be verdict "LGTM" but must include this caveat in the Analysis so the developer and QA know the change has no runtime effect on its own.
- **Full behavior documentation**: see `component-patterns-reference.md` § "Aliased Connections (`aliasTo`)".

### Connection `install` + `installSpec` Verification (Mandatory for OAuth using `common.*`)

When reviewing a connection (especially new apps or new connections), if the connection's `api.imljson` references `common.*` — most commonly `ifempty(parameters.clientId, common.clientId)` / `common.clientSecret` in OAuth2 apps — the connection's `installSpec.imljson` and `install.imljson` **must be non-empty**.

**Checklist:**

1. `rg "common\." connections/{name}/api.imljson` — any hit?
2. If yes → open `connections/{name}/installSpec.imljson` and `connections/{name}/install.imljson`.
3. Both files must define the same `common.*` keys that `api.imljson` references:
   - `installSpec.imljson` declares the admin form (`clientId`, `clientSecret`, etc.)
   - `install.imljson` maps `parameters.*` → `common.*`
4. Empty `[]` / `{}` while `api.imljson` references `common.*` → **BUG**. Flag with verdict "Changes Requested" — without it, the OAuth fallback resolves to empty and any user who hasn't supplied their own credentials gets `invalid_client` from the identity provider.

**Exception**: aliased connections — the source connection owns install/installSpec, so local install files being empty is expected.

**Full pattern + example**: see `component-patterns-reference.md` § "OAuth2 Connection with Common Fallback".

### OAuth `redirect_uri` Convention (Mandatory check for connection changes)

When reviewing **any** connection (new app, new connection in an existing app, or a touched OAuth1/OAuth2 connection in an existing app), and the upstream API supports OAuth with a `redirect_uri` parameter, the connection's `api.imljson` **must** use `{{oauth.localRedirectUri}}` for both `authorize.qs.redirect_uri` and `token.body.redirect_uri`.

**Why**: `oauth.redirectUri` is the legacy variable that always resolves to `integromat.com` (per `accounts/app-runtime-oauth2/lib/account.js` `get redirects()`). Apps using it break OAuth on self-hosted Make instances and on any future Make-hosted environment that doesn't carry the `integromat.com` redirect alias. `oauth.localRedirectUri` resolves to the running instance's host (Make → `make.com`, self-hosted → that customer's host), so it is the only variant that is portable across deployments.

**Checklist:**

1. `rg "oauth\.redirectUri" connections/{name}/api.imljson` — any hit?
2. If yes, check the `aliasTo` exception first — aliased connections compile no-op, the real fix belongs in the source app's connection (see "Aliased Connections" subsection above).
3. Otherwise, both `authorize.qs.redirect_uri` and `token.body.redirect_uri` should be `{{oauth.localRedirectUri}}`. If only one of the two is migrated, the OAuth provider returns `redirect_uri_mismatch` / `invalid_grant` (RFC 6749 § 4.1.3 — the values must match exactly).
4. `refresh.imljson` / `refresh` block does **not** take `redirect_uri` (refresh-token grant has no callback step). Flag any `redirect_uri` inside `refresh` as a bug regardless of which variable it uses.
5. `oauth.makeRedirectUri` is acceptable only when the upstream provider has a hard `make.com`-only registered redirect AND self-host support is explicitly out of scope. Treat any usage in a new app as Changes Requested unless that justification is documented.

**Verdict mapping:**

- **New app / new connection** with `oauth.redirectUri` → **Changes Requested**.
- **Existing connection edit** that doesn't touch the `redirect_uri` line → not a blocker on its own, but raise as **Improvement** so the developer can migrate while the file is open.
- **Existing connection edit** that explicitly modifies the `redirect_uri` line and still uses `oauth.redirectUri` → **Changes Requested**.
- **Operational reminder to include in the Analysis** (regardless of verdict): when migrating from `oauth.redirectUri` → `oauth.localRedirectUri` on a connection that uses Make-managed common credentials (`installSpec`/`install` populated `common.clientId` / `common.clientSecret`), the new callback URL must also be registered on the upstream OAuth client (e.g. Google Cloud Console). Coordinate with whoever owns that client before flipping the production app.

**Full pattern + variable table**: see `component-patterns-reference.md` § "OAuth2 Connection — `redirect_uri` Convention" and `security-reference.md` § 2.5.

### Branding Consistency for Apps in an Existing Family (Mandatory for new apps)

When the Jira ticket type is **App** (new app) AND the app slug shares a prefix with other published apps (e.g. `google-ads-*`, `microsoft-*`, `slack-*`, `hubspot-*`), verify the app matches the family's visual identity:

**Checklist:**

1. **Theme color**: Fetch via admin API — `GET /sdk/apps/{slug}/{version}` returns `app.theme` (hex string). Compare with sibling apps in the same family. A value of `#cccccc` means the developer never set it (platform default placeholder) — always flag this on a family-aligned submission.
2. **Logo/icon**: Check that the family's shared logo asset has been uploaded. Icons are typically managed via Admin UI, not code — but the review should still note a missing/default icon as an improvement and point the developer to the family's design asset.
3. **Label/description style**: Sentence casing, product name spelling, and "formerly X" conventions must match the family.

**Example API call** (to verify theme before review):

```
curl -s "$MAKE_ADMIN/sdk/apps/{slug}/{version}" -H "Authorization: Token $KEY" | jq .app.theme
```

**Verdict**: mismatch is usually **Improvement Needed** (not a hard blocker), but for a family of approved apps it's still a required consistency check before LGTM. Flag in the review so the developer can align theme via Admin UI or `PATCH /sdk/apps/{slug}/{version}` with `{ "theme": "#......" }`.

### Runtime Default Error Handling (Do NOT flag as missing)

The `imt-app-runtime` automatically handles common HTTP error codes **without any explicit error directive** in the app's `base.imljson` or module `api.imljson`:

- `429` → `RateLimitError` (auto-retry with backoff)
- `500-599` → `ConnectionError` (auto-retry with backoff)

**Do NOT flag missing 429/5xx error type definitions as an issue.** The runtime already handles these by default. Only flag if:
- The app needs a **custom error message** for 429/5xx (e.g., including `headers.retry-after` in the message)
- The app should override the default type (e.g., treating a specific 5xx as `RuntimeError` instead of `ConnectionError`)

---

## Polling Trigger: Order and Date Filtering

For detailed patterns and examples, see **`${SKILL_ROOT}/references/polling-trigger-guide.md`**.

When reviewing a polling trigger, verify these in order:

**Step 1: Verify `trigger.order` matches actual API response order**
- Check the API documentation for how the endpoint orders results by default
- If a sort parameter is used in `qs`, verify it matches `trigger.order`
- **Mismatch between `trigger.order` and actual response order is a bug**

**Step 2: Check date filtering support (for `order: "unordered"` or `"asc"`)**
- If the API supports date filtering but it's not used → **Improvement Needed**
- If neither sorting nor date filtering is available → acceptable, note the 3200 limit caveat

**Quick checklist:**
- [ ] `trigger.order` matches actual response ordering
- [ ] Date filter uses `{{data.lastDate || undefined}}` (not `{{data.lastDate}}`)
- [ ] Epoch uses `desc` ordering (even when api uses `asc`)
- [ ] If API supports sorting + filtering → `order: "asc"` is preferred over `"desc"`
- [ ] API request `qs`/`body` page size is **hardcoded** (not `{{parameters.limit}}`) — `parameters.limit` belongs only in `response.limit`
- [ ] If `api.imljson` temp keys changed, `epoch.imljson` `iterate` references the correct (final pipeline) key
