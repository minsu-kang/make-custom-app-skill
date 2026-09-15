<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->

# Bug Investigation Workflow

> Read [lifecycle.md](lifecycle.md) first (app identification, code sync, context, Jira fetch, push, close-out). This file adds only what is bug-specific.

## Triggers

Jira bug ticket or QA subtask about a Make app; user describes a module error ("this module throws PARSING_ERROR"); user asks to investigate an error.

## Required data before analysis

Do **not** start root-cause analysis with only an error message. Ask for whatever is missing:

- the actual input parameters used when the error occurred,
- the full API response body the module received,
- Make execution logs (link in the ticket or admin panel) — they show the exact IML expression that failed and the runtime context.

## Steps

1. **Locate the component.** Match the error to a module via `metadata.json`; read its `api.imljson` and the **whole function chain** in the response expression (e.g. `parseDatesFromISOFormat(mapColumnValues(buildRelValueField(...)))`). If the error is inside a custom function, grep `modules/*/api.imljson` for every caller — the bug likely affects all of them.
2. **Trace with real data.** Read `expect.imljson` and any RPC feeding it, then apply each function in the chain to the actual response, innermost first, inspecting the intermediate output until the failing step is found. Code reading alone misses edge cases.
3. **Reproduce with a failing test** *(gate)*. Write a `test.js` case from the actual input (or a minimal subset). It must **fail** with the current code; if it passes, the hypothesis is wrong — return to step 2.
4. **Check impact.** Search the app for every use of the affected function / pattern; assess side effects on other modules.
5. **Present findings and wait for approval** *(gate)*: error flow, root cause, why it happens, affected components, reproduction evidence, proposed fix scope.
6. **Fix minimally.** Only the bug — no refactoring, no "improvements", no touching unrelated logic. Write to `${CONTEXTS_DIR}/{slug}-v{version}/`, confirm the failing test now passes, and confirm zero behaviour change outside the bug scenario (otherwise the fix is too broad). Every changed function keeps `test.js` covering core behaviour, edge cases (null / undefined / empty / boundaries), the bug scenario, and regressions; run `test-function.js`. Changed `api.imljson` → `test-component.js`.
7. **Push and close out** per lifecycle §6–7 (Developer Notes use the bugfix template).

## Recurring bug (component fixed recently per Work History)

- Audit **all** crash points of the same class in the function (every `.match()`, every property access on a possibly-null value), not just the reported one.
- Trace with several data samples, including nested nulls, empty strings, missing keys.
- Ask the user to confirm the previous fix is actually deployed — a "recurring" bug may be an undeployed fix.
- Explain why the previous fix did not cover this case and make the new fix cover the whole category.

## Checklist

- [ ] Real input, response body, and execution logs obtained
- [ ] Component + full function chain located; all callers found
- [ ] Failing test reproduces the bug
- [ ] Findings presented and approved
- [ ] Minimal fix; failing test passes; `test-function.js` / `test-component.js` run
- [ ] Pushed with confirmation; Dev Notes asked; context + Pinecone updated
