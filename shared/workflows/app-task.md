# App Task Workflow

> Read [lifecycle.md](lifecycle.md) and [jira-ticket.md](jira-ticket.md) first. This file covers maintenance work: refactoring, UX tweaks (labels, hints, ordering), component metadata changes, deprecation, cleanup.

## Steps

1. **Scope and approval** *(gate)*. List every affected component. UX change → read [app-ux-best-practices.md](../references/app-ux-best-practices.md) first. Refactor → map dependencies between components. Deprecation / removal → find every module, RPC, and scenario-facing field that references the component. Present the scope and wait for a yes.
2. **Implement** (all with confirmation, [push-changes.md](push-changes.md)):
   - UX: labels sentence-case (or the app's consistent Title Case), 1–3 words, descriptive; hints with examples and defaults in backticks; push via `update-app.js`.
   - Metadata: `update-component.js {slug} {ver} {type} {name} key=value …`. Module fields: `label`, `description`, `connection`, `altConnection`, `webhook`, `typeId`, `crud`, `public` (no rename; only endpoints take `deprecated`/`archived`); other types: run `update-component.js` with no args for the per-type field list. Module deprecation is not scriptable: the user hides it in the admin panel. Never `public=false` on a module in production use (hard-disable that breaks scenarios — see [app-compilation-and-deployment-reference.md](../references/app-compilation-and-deployment-reference.md) § Module visibility & hiding).
   - Deletion: `delete-component.js {slug} {ver} {type} {name} --force` — irreversible; run only after explicit approval ([push-changes.md](push-changes.md)).
   - Refactor: edit locally, push with `update-app.js`; changed functions get updated `test.js` + `test-function.js`. A refactored Endpoint or RPC is run live after the push ([run-live.md](run-live.md)); its mockup fixture is written after that review passes.
3. **Breaking-change check** before pushing: no expect/parameters field removed or renamed (breaks scenario settings), no interface field removed or renamed (breaks mappings), connection parameters unchanged (breaks existing connections), refactored code behaves identically. Warn the user before proceeding on any hit.
4. **Close out** per [close-out.md](close-out.md), steps 1 to 5.

## Checklist

- [ ] App identified (slug + version, source stated)
- [ ] Code synced (`download-app.js` fresh)
- [ ] Context loaded (file + `search_app_knowledge`)
- [ ] Jira fetched incl. subtasks, comments, attachments (or none attached)
- [ ] Scope listed; plan approved before editing
- [ ] Changes pushed with confirmation; tests run where code changed (hard rule 9)
- [ ] Breaking-change check passed (or user warned)
- [ ] Refactored Endpoint / RPC run live: ownership transferred to the acting user, run reviewed with the user, created vendor records deleted, fixtures added after a pass, ownership transferred back
- [ ] Closed out: Dev Notes asked · `In Progress` → `Commit` · context file · Pinecone (post-commit sync when the user says the changes are committed)
