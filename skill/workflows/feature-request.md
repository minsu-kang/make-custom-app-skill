<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->

# Feature Request Workflow

> Read [lifecycle.md](lifecycle.md) first. This file adds only what is feature-specific.

## Triggers

Jira feature ticket for a Make app; user asks to add a module, RPC, webhook, connection, or custom function, or to extend an existing component.

## Steps

1. **Understand the app before designing.** Read `metadata.json` (components), `base.imljson` (baseUrl, auth, error handling), `common.imljson`, and existing modules of the same type for naming, field structure, pagination, and error conventions. List reusable RPCs and functions. `search_app_knowledge` may show the same feature done in another app — reuse the pattern.
2. **Design and get approval** *(gate)*. Cover: module type (SKILL.md § Module types — Search for many results, Action for one), API mapping, expect/parameters fields per [app-ux-best-practices.md](../references/app-ux-best-practices.md) and [parameters-reference.md](../references/parameters-reference.md), interface, RPC reuse or new RPCs, custom functions needed. Present, then wait for a yes.
3. **Create components** (confirmation per component, lifecycle §6):

   | Type | Command (positional args, no flags) | Values |
   |---|---|---|
   | Module | `create-component.js {slug} {ver} module {name} {label} {type_id} [connection] [description]` | `type_id`: 1 trigger, 4 action, 9 search, 10 instant trigger, 11 responder, 12 universal |
   | RPC | `create-component.js {slug} {ver} rpc {name} {label} [connection]` | — |
   | Webhook | `create-component.js {slug} {ver} webhook {label} {webhook-type} [connection]` | `webhook-type`: `web`, `web-shared` |
   | Connection | `create-component.js {slug} {ver} connection {label} {auth-type}` | `auth-type`: `tokenAuth`, `oAuth`, `basic`, `digest`, `apiCert`, `apiKey`, … |
   | Function | `create-component.js {slug} {ver} function {name}` | — |

   Endpoints: see [create-endpoint.md](create-endpoint.md).
4. **Write the code** in `${CONTEXTS_DIR}/{slug}-v{version}/` and push each section with `update-app.js`, in this order: RPCs → module `api` → `expect` → `parameters` → `interface` → `samples` → custom functions. Re-read [communication-reference.md](../references/communication-reference.md) / [runtime-reference.md](../references/runtime-reference.md) before each `api.imljson`.
5. **Tests.** Every new or changed function gets `test.js` (core behaviour, edge cases, transformation correctness) → `test-function.js`. New or changed `api.imljson` → `test-component.js`, adding mockup data when missing.
6. **Verify integration.** Connections referenced correctly, RPC references resolve, interface matches what downstream modules expect, no breaking change to any existing component you touched.
7. **Close out** per lifecycle §7 (Developer Notes use the feature template).

## Checklist

- [ ] Existing patterns read; design presented and approved
- [ ] Components created with confirmation
- [ ] Code pushed in dependency order with confirmation
- [ ] `test-function.js` / `test-component.js` run
- [ ] Integration verified; no breaking change to existing components
- [ ] Dev Notes asked; context + Pinecone updated
