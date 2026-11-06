# Feature Request Workflow

> Read [lifecycle.md](lifecycle.md) and, when a Jira ticket is attached in employee mode, [jira-ticket.md](jira-ticket.md) first. This file adds only what is feature-specific.

## Triggers

Jira feature ticket for a Make app; user asks to add a module, RPC, webhook, connection, or custom function, or to extend an existing component; a request for the user's own app (public mode).

## Steps

1. **Understand the app before designing.** Read `metadata.json` (components), `base.imljson` (baseUrl, auth, error handling), `common.imljson`, and existing modules of the same type for naming, field structure, pagination, and error conventions. List reusable RPCs and functions. `search_app_knowledge` may show the same feature done in another app — reuse the pattern.
2. **Design and get approval** *(gate)*. Cover: module type ([index.md](../index.md) § Module types — Search for many results, Action for one), API mapping, expect/parameters fields per [app-ux-best-practices.md](../references/app-ux-best-practices.md) and [parameters-reference.md](../references/parameters-reference.md) (selects and RPC options: [select-and-rpc-options.md](../references/parameters-reference/select-and-rpc-options.md); interface: [interface.md](../references/parameters-reference/interface.md)), interface, RPC reuse or new RPCs, custom functions needed. Present, then wait for a yes.
3. **Create components** (confirmation per component, [push-changes.md](push-changes.md)):
   A whole new app in public mode: create it first (lifecycle.md § Public mode, Identify the app), then sync. Custom IML functions can be off for an account: a refused `create-component.js ... function` is reported to the user.

   | Type | Command (positional args, no flags) | Values |
   |---|---|---|
   | Module | `create-component.js {slug} {ver} module {name} {label} {type_id} [connection] [description]` | `type_id`: 1 trigger, 4 action, 9 search, 10 instant trigger, 11 responder, 12 universal |
   | RPC | `create-component.js {slug} {ver} rpc {name} {label} [connection]` | — |
   | Webhook | `create-component.js {slug} {ver} webhook {label} {webhook-type} [connection]` | `webhook-type`: `web`, `web-shared` |
   | Connection | `create-component.js {slug} {ver} connection {label} {auth-type}` | `auth-type`: `tokenAuth`, `oAuth`, `basic`, `digest`, `apiCert`, `apiKey`, … |
   | Function | `create-component.js {slug} {ver} function {name}` | — |

   Endpoints: see [create-endpoint.md](create-endpoint.md).
4. **Write the code** in `~/.make-custom-app/contexts/{slug}-v{version}/` and push each section with `update-app.js`, in this order: RPCs → module `api` → `expect` → `parameters` → `interface` → `samples` → custom functions. Re-read [communication-reference.md](../references/communication-reference.md) / [runtime-reference.md](../references/runtime-reference.md) before each `api.imljson`.
5. **Tests.** Every new or changed function gets `test.js` (core behaviour, edge cases, transformation correctness) → `test-function.js`. A new or changed module `api.imljson` → `test-component.js`. Endpoint and RPC mockup fixtures wait until the live review passes ([run-live.md](run-live.md)). Public mode: functions run on the shim; a module, connection or webhook change gets a test scenario ([module-test.md](module-test.md)) after the push.
6. **Verify integration.** Connections referenced correctly, RPC references resolve, interface matches what downstream modules expect, no breaking change to any existing component you touched. For a new or changed Endpoint or RPC, run it live ([run-live.md](run-live.md)).
7. **Close out** per [close-out.md](close-out.md), steps 1 to 5 (Developer Notes use the feature template).

## Checklist

- [ ] App identified (slug + version, source stated)
- [ ] Code synced (`download-app.js` fresh)
- [ ] Context loaded (file + `search_app_knowledge`)
- [ ] Jira fetched incl. subtasks, comments, attachments (or none attached); public mode: the request from the chat
- [ ] Existing patterns read; design presented; plan approved before editing
- [ ] Components created with confirmation (public mode: snapshot taken before the first write)
- [ ] Code pushed in dependency order with confirmation
- [ ] `test-function.js` / `test-component.js` run (hard rule 9) (public mode: shim, live run or test scenario)
- [ ] Integration verified; no breaking change to existing components
- [ ] New or changed Endpoint / RPC run live: ownership transferred to the acting user, created vendor records deleted, run reviewed with the user, fixtures added after a pass, ownership transferred back (public mode: no transfers, notice before the first run, no fixtures)
- [ ] Closed out: Dev Notes asked · `In Progress` → `Commit` · context file · Pinecone (post-commit sync when the user says the changes are committed) (public mode: change summary shown, context file)
