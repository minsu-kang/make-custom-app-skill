# Bug Investigation Workflow

> Read [lifecycle.md](lifecycle.md) and [jira-ticket.md](jira-ticket.md) first. This file adds only what is bug-specific.

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
5. **Present findings and wait for approval** *(gate)*: error flow, root cause, why it happens, affected components, reproduction evidence, proposed fix scope. When working QA subtasks on a returned ticket, classify each one as **True Positive** or **False Positive** first, as described in [jira-ticket.md](jira-ticket.md).
6. **Fix minimally.** Only the bug — no refactoring, no "improvements", no touching unrelated logic. Write to `~/.make-custom-app/contexts/{slug}-v{version}/`, confirm the failing test now passes, and confirm zero behaviour change outside the bug scenario (otherwise the fix is too broad). Every changed function keeps `test.js` covering core behaviour, edge cases (null / undefined / empty / boundaries), the bug scenario, and regressions; run `test-function.js`. Changed `api.imljson` → `test-component.js`.
7. **Push** per [push-changes.md](push-changes.md). For an Endpoint or RPC fix, then run it live with the bug's input ([run-live.md](run-live.md): ownership, review, cleanup, fixtures after a pass, ownership back).
8. **Close out** per [close-out.md](close-out.md), steps 1 to 5 (Developer Notes on the parent ticket use the bugfix template).

## Recurring bug (component fixed recently per Work History)

Apply the recurring-bug rigor in [lifecycle.md](lifecycle.md) §3.

## Checklist

- [ ] App identified (slug + version, source stated)
- [ ] Code synced (`download-app.js` fresh)
- [ ] Context loaded (file + `search_app_knowledge`)
- [ ] Jira fetched incl. subtasks, comments, attachments (or none attached)
- [ ] Real input, response body, and execution logs obtained
- [ ] Component + full function chain located; all callers found
- [ ] Failing test reproduces the bug
- [ ] Findings presented; plan approved before editing
- [ ] Minimal fix; failing test passes; `test-function.js` / `test-component.js` run (hard rule 9)
- [ ] Pushed only after confirmation
- [ ] Endpoint / RPC fix run live: ownership transferred to the acting user, run reviewed with the user, created vendor records deleted, fixtures added after a pass, ownership transferred back
- [ ] Closed out: Dev Notes asked · `In Progress` → `Commit` · context file · Pinecone (post-commit sync when the user says the changes are committed)
