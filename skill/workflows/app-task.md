<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->

# App Task Workflow

> Read [lifecycle.md](lifecycle.md) first. This file covers maintenance work: refactoring, UX tweaks (labels, hints, ordering), component metadata changes, deprecation, cleanup.

## Steps

1. **Scope and approval** *(gate)*. List every affected component. UX change → read [app-ux-best-practices.md](../references/app-ux-best-practices.md) first. Refactor → map dependencies between components. Deprecation / removal → find every module, RPC, and scenario-facing field that references the component. Present the scope and wait for a yes.
2. **Implement** (all with confirmation, lifecycle §6):
   - UX: labels sentence-case (or the app's consistent Title Case), 1–3 words, descriptive; hints with examples and defaults in backticks; push via `update-app.js`.
   - Metadata: `update-component.js {slug} {ver} {type} {name} key=value …`. Module fields: `label`, `description`, `connection`, `altConnection`, `webhook`, `typeId`, `crud`, `public` (no rename; only endpoints take `deprecated`/`archived`); other types: run `update-component.js` with no args for the per-type field list. Module deprecation is not scriptable: the user hides it in the admin panel. Never `public=false` on a module in production use (hard-disable that breaks scenarios — see [app-compilation-and-deployment-reference.md](../references/app-compilation-and-deployment-reference.md) § Module visibility & hiding).
   - Deletion: `delete-component.js {slug} {ver} {type} {name} --force` — irreversible; run only after explicit approval (lifecycle §6).
   - Refactor: edit locally, push with `update-app.js`; changed functions get updated `test.js` + `test-function.js`. A refactored Endpoint or RPC is run live after the push (lifecycle §6 "Run live"); its mockup fixture is written after that review passes.
3. **Breaking-change check** before pushing: no expect/parameters field removed or renamed (breaks scenario settings), no interface field removed or renamed (breaks mappings), connection parameters unchanged (breaks existing connections), refactored code behaves identically. Warn the user before proceeding on any hit.
4. **Close out** per lifecycle §7.

## Checklist

- [ ] Scope listed and approved
- [ ] Changes pushed with confirmation; tests run where code changed; refactored Endpoint / RPC run live
- [ ] Breaking-change check passed (or user warned)
- [ ] Dev Notes asked + `In Progress` → `Commit`; context + Pinecone updated
