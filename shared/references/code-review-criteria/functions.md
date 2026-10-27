<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# Code review criteria: Checks for `functions/*/code.js`

> Read when: the change set has a `function/*/code` change (mandatory): test coverage, ES6+, code quality and maintainability. Part of [code-review-criteria.md](../code-review-criteria.md).

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
