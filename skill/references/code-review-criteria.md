# Code Review Criteria

Detailed review criteria for Make custom app code reviews. Referenced by the code review rule (`make-app-code-review.mdc`) and the code review workflow (`workflows/code-review.md`).

## Review Categories

Evaluate each change against the following categories:

### Breaking Changes (risk of breaking existing scenarios)

- Interface output fields removed/renamed → existing scenario mappings may break
- Expect/Parameters fields removed/renamed → existing scenario settings become invalid
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

- Sensitive data sent without log sanitize
- API key exposed in URL query string
- User input not validated

### LGTM (no issues)

- None of the above apply and the code correctly follows Make app patterns

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
node ~/.cursor/skills/make-custom-app/scripts/test-function.js <app-slug> <app-version>
```

- Run once with **no function filter** to test all functions (catches regressions across the app)
- Include the test results in each function's review section under **Test Coverage**
- If tests **fail** → flag in the review with the failure details. Distinguish between:
  - **Pre-existing failures** (test was already broken before this change) — note but do not count as a new issue
  - **New failures** (test broke due to this change) — verdict **Bug** or **Breaking Change**
- If tests **pass** → note "All tests pass" in the Test Coverage field

### Component Integration Tests (Mandatory for api.imljson changes)

**Before running or writing component tests**, re-read `~/.cursor/skills/make-custom-app/references/component-test-guide.md` for communications mock structure, `transformOutput()`, and `assert.deepStrictEqual` patterns.

When **any** component's `api.imljson` file is changed in the review (modules, RPCs, connections, webhooks), **automatically run `test-component.js`** after `download-app.js` completes:

```
node ~/.cursor/skills/make-custom-app/scripts/test-component.js <app-slug> <app-version> <component-type> [component-names...]
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

When expect or parameters files are changed, **read `~/.cursor/skills/make-custom-app/references/app-ux-best-practices.md` first** and verify:

- **Label capitalization**: Sentence-style by default, but follow the app's existing convention if consistently Title Case
- **Label naming**: 1–3 words, descriptive not instructional, no articles
- **Hint formatting**: Examples in backticks, default values in backticks, links with app name + page name
- **Hint template**: Limit fields must use the standard template from "Templates: Universal Hints"
- **Terminology accuracy**: Labels and option names must match the actual input format (e.g., don't label "JSON" if the format is GraphQL)

Any violation results in verdict **Improvement Needed**.

### `help` Text Evaluation (for expect/parameters changes)

When `help` properties are added, removed, or modified, evaluate their **actual UX value** — not just their presence:

- **Redundant `help`** (restates the label): Removing these is **cleanup, not UX regression**. Do NOT flag as Improvement Needed.
  - Example: label `"Name"` → help `"Enter the name."` — adds zero value
  - Example: label `"Value"` → help `"Enter the value."` — adds zero value
- **Meaningful `help`** (provides guidance beyond the label): Removing these IS a UX regression. Flag as Improvement Needed.
  - Example: help `"Use ISO 8601 format (e.g., 2024-01-15T10:30:00Z)"` — actual format guidance
  - Example: help `"Comma-separated list of IDs (max 100)"` — constraints and format
- **Missing `help` on complex fields**: When a field requires non-obvious input (format, constraints, examples), suggest adding meaningful `help` as an improvement — but do NOT flag the absence of trivial `help` as an issue.

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

When code is **removed** in a change (headers deleted, parameters dropped, expressions stripped), **never assume the removal is a bug**. Verify first:

1. **Does the removed reference actually exist?** — If `{{parameters.apiKey}}` was removed from an RPC, check the RPC's own `parameters.imljson`. If it's not defined there, it was never a proper parameter — removal is correct cleanup.
2. **Is the functionality already covered elsewhere?** — Check `base.imljson` headers, connection parameters, and inherited context. If base already provides the same header/value, the component-level copy was redundant.
3. **Who calls this component?** — Check all callers (`rpc://`, `options`, nested params) to see if they pass the removed value. If no caller provides it, the value was never reliably available.

**Review the removal's INTENT before judging its correctness.** The question is not "was this code here before?" but "was this code actually necessary?"

---

## Runtime Behavior Verification (Mandatory for api.imljson changes)

When reviewing `api.imljson` changes that use runtime variables, IML context features, or middleware behavior (e.g., `environment`, `temp`, `condition`, `pagination`, `iterate`, `valid`, `repeat`):

1. **First**: Check `~/.cursor/skills/make-custom-app/references/runtime-reference.md` for documented behavior
2. **If not found or still uncertain**: Search the `imt-app-runtime` source code directly (path in SKILL.md's last line `imt-app-runtime-path:`) to verify actual runtime behavior

**Never assume or guess** how runtime features work. Common mistakes to avoid:
- Confusing `{{environment.timezone}}` (scenario env, always available) with `flags.environmentAccess` (server-side `process.env`, requires flags)
- Assuming middleware behavior without checking the actual execution chain
- Misunderstanding pagination stop conditions or trigger epoch mechanics

### Runtime Default Error Handling (Do NOT flag as missing)

The `imt-app-runtime` automatically handles common HTTP error codes **without any explicit error directive** in the app's `base.imljson` or module `api.imljson`:

- `429` → `RateLimitError` (auto-retry with backoff)
- `500-599` → `ConnectionError` (auto-retry with backoff)

**Do NOT flag missing 429/5xx error type definitions as an issue.** The runtime already handles these by default. Only flag if:
- The app needs a **custom error message** for 429/5xx (e.g., including `headers.retry-after` in the message)
- The app should override the default type (e.g., treating a specific 5xx as `RuntimeError` instead of `ConnectionError`)

---

## Polling Trigger: Order and Date Filtering

For detailed patterns and examples, see **`~/.cursor/skills/make-custom-app/references/polling-trigger-guide.md`**.

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
