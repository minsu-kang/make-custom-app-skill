# Module test (public mode)

> Read when: in `MODE: public` a module (or the connection or webhook it uses) was changed and pushed, a module bug needs reproducing, or the user asks to test a module. In employee mode a module is tested with `test-component.js`. Nothing runs during a code review.

## Ask once per task
Before the first test scenario of a task, ask: "To test {module} I would create a test scenario in team {team}, run it once with your connection, show you the result, and delete the scenario. It spends credits, and the module calls the real vendor API (records it creates are deleted afterwards where the API allows). Go ahead, or will you run it yourself in the Make UI?"
- Yes: it covers the create, activate, run, deactivate and delete of the test scenarios of this task (hard rule 4). Inputs that write to the vendor are still shown before each run.
- No: the user-run steps below.

## Steps
1. Team and organization: `environment_get` (a read). Several teams: ask once.
2. Find the module: `app_find` with the app label as the query and `includePrivate: true`. Take the exact `app:module` name and version from the result; never build it by hand. Not found: Make does not list a private app that is not installed in the organization, and a newly created private app was not found at all: use the user-run steps below, which work for any app the user owns. Once the user has saved a scenario with a module of the app, a new search may find it. A hidden module: show it first with `update-component.js {slug} {version} module {name} public=true` after the user's yes (it is an app edit: take the snapshot of lifecycle.md § Public mode first, and never before the plan is approved; a bug reproduction before the plan uses the user-run steps instead), and hide it again after the test unless the user wants it shown.
3. Spec: `module_spec` with `schemas: true`: its fields, its output, the connection it needs and the user's connections that fit. No fitting connection: `connection_create` gives an authorization link the user opens (the connection-request exception of hard rule 4); wait, then go on.
4. Build with `scenario_create`, named `[plugin test] {slug} {module} {date}`, by module type:

| type_id | Scenario |
|---|---|
| 4 action, 9 search, 12 universal | Scheduling `{"type": "on-demand"}`: `scenario-service:StartSubscenario` as the root, the module after it with the test values in its mapper, `scenario-service:ReturnData` last. |
| 1 polling trigger | The module as the root; scheduling `indefinitely` with interval 900; the epoch from `module_field_resolve`. Activate, run once, deactivate at once. |
| 10 instant trigger, 11 responder | A webhook scenario: `scenario_run` does not run it. Give the user the webhook URL or the vendor event to fire, then read the run. |

   Test values come from the approved plan or the bug's input; values that write to the vendor are shown first. A refused `scenario_create` (plan, hidden module, a design problem the tool lists) is reported; on a plan refusal use the user-run steps.
5. Run: `scenario_activate` (`scenario_run` runs only an active scenario), then `scenario_run`. A tool timeout returns an execution id: read the run with it, do not run again.
6. Read the run: `scenario_execution_inspect` (status, the module, errors), then `scenario_execution_module_get` (the module's request and output). Compare the output with `interface.imljson`: every returned key declared, each type matching. For a bug, the failure is the reproduction.
7. Clean up: delete the vendor records the run created as run-live.md step 1 describes, or list them for the user. Then `scenario_deactivate` and `scenario_delete` the test scenario, unless the user asks to keep it. Connections stay.
8. Review, ask, stop: show the review below; ask whether to fix interface, expect or help mismatches; push only after the yes (push-changes.md); test again after the push.

## Review result
A table: Module | Type | Execution | Bundles | Output vs interface | Error. Counts and ids only, no personal data, then the cleanup list.

## User-run steps (on a no, when the tools refuse, or when the module is not found)
Tell the user: open a scenario in Make, add the module of the app (a private app carries a Private tag), pick or create a connection, Run once (or right-click the module, Run this module only), then paste the output bundle or the error, or give the execution id so the run can be read with the read tools. Compare as in step 6.

## Checklist
For a standalone test. Inside a task workflow, that workflow's checklist covers the test.
- [ ] App identified (slug + version, source stated); code synced; context loaded
- [ ] Asked once for this task (credits, vendor writes, cleanup); user-run steps given on a no
- [ ] Module and connection found with the Make MCP read tools (no guessed names); the connection is the user's own (or the user-run steps when the module is not found)
- [ ] Test scenario built for the module type and run once
- [ ] Run read; output compared with `interface.imljson`
- [ ] Created vendor records deleted (or listed); test scenario deleted unless the user kept it
- [ ] Review shown; edits pushed only after the user's yes; tested again after the push
