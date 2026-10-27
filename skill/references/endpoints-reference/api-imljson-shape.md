<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# SDK Endpoints reference: `api.imljson` Shape

> Read when: designing or reviewing an endpoint `api.imljson`, including GraphQL APIs. Part of [endpoints-reference.md](../endpoints-reference.md).

## `api.imljson` Shape

A standard communication block, same directive family as RPCs (endpoint = compiled `IMTRPC`, standard `ExecuteRpc` chain): `url` (relative to `base.imljson` `baseUrl`), `method`, `qs`, `body`, `headers`, `temp`, `response.*` (`output`/`temp`/`valid`/`iterate`/`wrapper`/`limit`). No pagination (see [Core Facts](../endpoints-reference.md#core-facts)). Custom IML functions are fully usable (observed: `buildBatchRequests()`, `handleTabs()`, `omit()`, `stripEmpty()`).

**Only functions that exist may be called.** `api.imljson` is evaluated by the IML engine: it can call the built-ins in [builtin-iml-functions.md](../builtin-iml-functions.md) and the app's own custom functions (`functions/{name}/code.js`, including pending ones on an approved app). Nothing else — there is no JavaScript in `api.imljson`, and a plausible-sounding helper (`compact()`, `toJSON()`, `removeNulls()`…) that is not in either list fails at runtime. Before using a helper: `ls ${CONTEXTS_DIR}/{slug}-v{ver}/functions/`. If the app already has an equivalent (Google Forms `removeEmpty`, Google Calendar/Drive `stripEmpty`), reuse it; create a new one only when nothing equivalent exists, and push it with `create-component.js … function {name}` + `update-app.js … function/{name}/code|test` **before** the endpoints that call it.

**Omit `"type": "json"`.** An object `body` is serialized as JSON by default (`request-options.ts` `serializeRequestBody`, `case 'json'` is the fallback for objects); modules in the same apps do not set `type`, and endpoints follow the module convention. The exception is `arbitraryCall`, where the body is a caller-supplied `any` value: the standard template uses `"type": "text"` (parity with the "Make an API Call" module), while GraphQL apps whose modules set `"type": "json"` (GitHub v4, monday v2) keep `json`. Neither handles both string and object bodies today — see [arbitrary-call.md § Standard Template → Body serialization](arbitrary-call.md#standard-template) before changing one.

```json
{
    "url": "/documents/{{parameters.documentId}}:batchUpdate",
    "method": "POST",
    "body": {
        "requests": "{{buildBatchRequests(parameters.requests)}}",
        "writeControl": "{{parameters.writeControl}}"
    },
    "response": {
        "output": "{{body}}"
    }
}
```

Endpoint-specific response behavior:

- **Result unwrap** — because the RPC chain returns an array, an Endpoint's result is unwrapped when running *as an Endpoint*: single-element array → object, empty → `{}`. Opt out with `"response": { "unwrap": false }` or by declaring `response.iterate` (keeps the array). Source: `rpc.js` `_unwrapEndpointResult`, gated by the `endpointExecution` marker — identical embedded (inline `api.endpoint`) vs standalone.
- **`condition` cannot implement validation** — `condition()` IS part of the ExecuteRpc chain, but its falsy path ends the chain returning `condition.default` **as output data** (or `false`); it cannot raise a typed error (source: `lib/core/middleware/condition.js`). IEN-16076 field-tested it as a required-field guard: not viable. Do not suggest `condition` for endpoint-level validation.
- **`condition` CAN implement conditional API flow** — while `condition` cannot validate inputs, it **can** be used to replicate multi-API-call patterns from modules. Endpoints don't support multiple `api` calls, but the `condition` directive allows branching to different API paths or content types based on input. Examples: the Discord `arbitraryCall` endpoint ([IEN-16479](https://make.atlassian.net/browse/IEN-16479)) uses `condition` to handle different content types for POST/PUT/PATCH vs GET ([IEN-16648](https://make.atlassian.net/browse/IEN-16648)) and for bot-identity guards that the module implements via a preflight API call ([IEN-16649](https://make.atlassian.net/browse/IEN-16649)). For cases where an additional API call is needed for pre-checks (e.g., enterprise-gated operations), consider creating a separate helper endpoint and referencing it in the `context.md` — see the Canva implementation ([IEN-16618](https://make.atlassian.net/browse/IEN-16618)). **Exception — internal credential/token exchange ([IEN-16847](https://make.atlassian.net/browse/IEN-16847))**: never split a credential/token lookup into a helper endpoint (e.g. `GetPageAccessToken` returning a Facebook Page `access_token` for the AI to pass as `page_access_token`), which leaks secrets into the LLM context ([security-reference.md § 1.2](../security-reference.md#1-credential--secret-handling)). On an **already-deployed app** whose connection only stores the user token, keep the module's 2-step array inside the endpoint's `api.imljson` (step 1 saves `temp.accessToken` with `"output": null`, step 2 sends `Bearer {{temp.accessToken}}`); on a **new app or connection**, resolve and store the token in `connection.*` at the connection level so each endpoint makes a single request.
- **No nested endpoint calls** — an Endpoint's own `api` may not use the `api.endpoint` directive (`InvalidConfigurationError`).
- **Headers cannot be unset from an endpoint.** `getRequestHeaders` (`fetcher/request-options.ts`) lowercases keys and **skips entries whose value resolves to `undefined`** before merging endpoint headers over `base.imljson` headers. So `"X-Foo": "{{undefined}}"` (or an `ifempty(..., undefined)` that resolves to undefined) is a no-op and the base header still goes out; to send a different value, override it with a concrete value. Observed on monday v2: AI modules declare `"api-version": "{{undefined}}"`, which is inert — the base `API-Version: 2025-10` still reaches the gateway. Verified from the runtime source, not from docs.

### GraphQL APIs (monday v2, GitHub v4, Shopify, Linear…)

GraphQL changes the mechanics but not the contract — one endpoint still wraps one **operation** (one query or one mutation field). Every operation is POSTed to the API's single GraphQL URL (monday `/v2`, GitHub `/graphql`, Shopify `/admin/api/{version}/graphql.json`), so the URL no longer distinguishes endpoints — the operation document does:

- `body.query` holds a static operation document with **typed `$variables`**; `body.variables` maps endpoint inputs 1:1 onto them. Never interpolate input values into the query text (quoting and injection problems). Variable types must match the schema exactly (`[ID!]!`, `JSON`, `[BoardHierarchy!]`…) — verify each against the vendor's **introspection/schema reference**, not the prose docs (monday's docs showed `hierarchy_type` singular; the 2025-10 schema is `hierarchy_types: [BoardHierarchy!]`).
- **Even read operations are POSTs with a JSON body**, so the `ifempty`/`stripEmpty` guards ([pure-api-wrapper.md](pure-api-wrapper.md#empty-input-guards--ifempty-vs-stripempty-verified-against-the-runtime-source)) apply to every endpoint, not only to mutations — an explicit `null` variable overrides the server default (monday `boards.limit: null` → slicing error).
- Selection sets return the **full resource** the vendor docs list (including union/interface fragments such as `... on BoardRelationValue { linked_items { id name updated_at } }`), not the subset the module selected. Mirror the selection set in `output_parameters`.
- Enum arguments → `select` with the schema's enum values; `JSON`-scalar arguments (`column_values`, `defaults`, `variables`) → `any` input passed through verbatim.
- A version header (`API-Version`) belongs in `base.imljson`; an endpoint that needs a newer schema version (monday `getAggregate` → 2026-04) overrides it with a concrete value (see "Headers cannot be unset").
- Error handling lives in `base.imljson`, not per endpoint. GraphQL servers report validation/execution errors as HTTP `200` with a `body.errors` array (transport failures — 401/403/429/5xx — still come as non-2xx), so the base must inspect `body.errors`, not only the status code: monday `"valid": "{{validateResponse(statusCode, body)}}"` + `formatGraphQLErrors(body.errors)`, GitHub `"valid": "{{!body.errors}}"` + `formatErrorHandler(body.errors)`. Check this once when syncing the app; if the base only checks the status, an endpoint would return `{ "data": null, "errors": [...] }` as a success — flag it as a base-level gap rather than adding `response.valid` to each endpoint.

Reference: monday v2 ([IEN-16757](https://make.atlassian.net/browse/IEN-16757)) — 42 endpoints, scripted module-parity check, `stripEmpty` function added for array/collection guards.
