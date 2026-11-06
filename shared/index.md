# Make custom app index

Component and module tables, quick facts, the reference list, and the script list. Docs: https://developers.make.com/custom-apps-documentation

A path written `<plugin root>/...` starts at the plugin root: the directory named on the `Plugin root:` line at the top of the skill that is running. When that line still shows a literal `${...}`, the plugin root is the directory two levels above the folder of the skill that is running. Write the full path in every command.

## App components

| Component | Files | Notes |
|---|---|---|
| Base | `base.imljson` | Inherited by modules, RPCs, and endpoints (not connections / webhooks) |
| Common | `common.imljson` | Encrypted shared data; static content locked after approval, `installSpec` values stay admin-editable |
| Connection | `api`, `parameters` | OAuth2 / OAuth1 / JWT / API key / Basic |
| Module | `api`, `parameters`, `expect`, `interface`, `samples` | Execution unit |
| RPC | `api`, `parameters` | Dynamic options / fields |
| Webhook | `api` | Owns the connection for Instant Trigger modules |
| Endpoint | `api`, `input_parameters`, `output_parameters`, `scope`, `context.md` | AI-callable single call, not scenario-runnable — [endpoints-reference.md](references/endpoints-reference.md) |

## Module types

| type_id | Type | Use |
|---|---|---|
| 1 | Trigger (polling) | Periodic new-item check; static params only; `response.trigger` (`id`/`date`/`type`/`order`) |
| 4 | Action | Exactly one bundle (create / get / update / delete) — `iterate` does not multiply output |
| 9 | Search | Zero or more bundles; needs `response.iterate` + `response.limit: "{{parameters.limit}}"` + expect `limit` (`uinteger`, default 10) |
| 10 | Instant Trigger | Webhook-fed; communication optional |
| 11 | Responder | Returns the webhook response |
| 12 | Universal | Generic call with CRUD hint |

Quick facts: IMLJSON allows `//` comments · IML indices are 1-based (`foo[]` = `foo[1]`; `{{body.results[].field}}` unwraps a single-item array) · triggers cannot map values · `approved` = compiled, not "in production".

## References — read when …

- [runtime-reference.md](references/runtime-reference.md) — writing/reviewing `api.imljson`: order of steps, directives, what each module type returns, request building, response handling, IML expressions and functions, limits; parts for pagination, `api.endpoint`, `environment`/`internal`, connections, `isc`
  - [runtime-reference/polling-triggers.md](references/runtime-reference/polling-triggers.md): polling triggers (`response.trigger`, saved state, "Choose where to start", items that share a date, `order`, default limit)
  - [runtime-reference/webhooks.md](references/runtime-reference/webhooks.md): instant triggers with an `api` (dedicated and shared webhooks, `verification` and `respond`, attach, update and detach, responder)
  - [runtime-reference/http-requests.md](references/runtime-reference/http-requests.md): TLS options, `aws`, `oauth` signing, `shareCookies`, `gzip`, headers Make adds, the older HTTP client
  - [runtime-reference/iml-context.md](references/runtime-reference/iml-context.md): which IML roots a component can read, what custom IML function code can see and its limits
  - [runtime-reference/on-prem-agent.md](references/runtime-reference/on-prem-agent.md): the `agency` directive (a customer system reached through the on-premise agent)
- [communication-reference.md](references/communication-reference.md) — request/response spec, pagination, RPC, file upload/download patterns
- [component-patterns-reference.md](references/component-patterns-reference.md) — base, connections per auth type, install params, errors, webhook, trigger, responder
- [parameters-reference.md](references/parameters-reference.md) — any `expect` / `parameters` / `interface` edit: field properties, the Map switch, types and aliases, text, date and boolean fields, collections, arrays, `nested`, `required` inside arrays and collections; parts for validation, select options and RPCs, and the interface
  - [parameters-reference/validation.md](references/parameters-reference/validation.md): where values are checked, `validate` keys by type, conversions, `pattern`, item rules, hints and verbatim messages
  - [parameters-reference/select-and-rpc-options.md](references/parameters-reference/select-and-rpc-options.md): select and option properties, option sources, what an options RPC receives and returns, conditional RPCs, which nested set is shown, reopening a saved module, paging and search
  - [parameters-reference/interface.md](references/parameters-reference/interface.md): `interface.imljson`, dynamic interface via RPC, mapped values in an interface RPC
- [builtin-iml-functions.md](references/builtin-iml-functions.md) — verifying a `{{ }}` function exists; runtime extras, `errorFactory` types
- [custom-functions-reference.md](references/custom-functions-reference.md) — `functions/*/code.js` + `test.js` conventions
- [app-ux-best-practices.md](references/app-ux-best-practices.md) — labels, hints, fields, messages, ordering
- [polling-trigger-guide.md](references/polling-trigger-guide.md) — type-1 trigger order / date filtering / epoch
- [component-test-guide.md](references/component-test-guide.md) — `test-component.js` mocks and debugging (Make employees; public mode: [module-test.md](workflows/module-test.md))
- [code-review-criteria.md](references/code-review-criteria.md) — review categories, out-of-scope list, ES6+, tests, UX, runtime false positives
- [code-smells-reference.md](references/code-smells-reference.md) — quality thresholds
- [security-reference.md](references/security-reference.md) — credentials, OAuth, signatures, SSRF, data exposure
- [app-compilation-and-deployment-reference.md](references/app-compilation-and-deployment-reference.md) — `approved`/`compile`/changes, visibility flags, admin endpoints, IPM pipeline (admin endpoints and the IPM pipeline: employee mode)
- [component-scaffold-templates.md](references/component-scaffold-templates.md) — is a review `old_value` untouched SDK boilerplate?
- [endpoints-reference.md](references/endpoints-reference.md) — SDK Endpoints entity, admin API, schemas, review guidance
- [developer-notes-templates.md](references/developer-notes-templates.md) — Jira Developer Notes (bugfix / feature) (public mode: the change summary in the chat)
- [examples.md](references/examples.md) — full app example (fictional vendor)

## Scripts (`<plugin root>/shared/scripts/`)

`check-setup.js` · `setup-secrets.js` (user terminal only) · `download-app.js {slug} {ver}` (`--snapshot`; public mode masks common) · `review-changes.js {slug} {ver}` (public mode: the change rows when Make lists them, else on an app that is not approved a diff against the newest snapshot) → `reviews/latest.json` · `update-app.js` · `create-component.js` / `update-component.js` / `delete-component.js` · `commit-changes.js {slug} {ver} commit|rollback|compile` (compile: employee only; commit and rollback: on an approved app) · `test-function.js` (public mode: built-in shim) / `test-component.js` (employee only) · `run-component.js {slug} {ver} endpoint|rpc {name}` (live run, [run-live.md](workflows/run-live.md)) · `download-jira-ticket-attachment.js {key}` (employee only) · `post-review-transition.js {key} committed|returned|commit` (employee only) · `cleanup-legacy.js --plan|--apply {digest} --groups claude,cursor|--restore|--decline {digest}` (make-app-setup only). Usage details are in the workflows.
