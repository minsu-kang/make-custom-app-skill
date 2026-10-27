# Runtime reference: Inline Endpoint Calls (`api.endpoint`)

> Read when: a module or RPC `api.imljson` delegates its request to a sibling Endpoint: rules, static references, pagination interplay, `response.unwrap`. Part of [runtime-reference.md](../runtime-reference.md).

## Inline Endpoint Calls (`api.endpoint`)

Added in imt-app-runtime **v1.102.0** (2026-07-23, PR #694); reference-resolution changed in **v1.102.3** (2026-07-29, PR #713 — see § "Endpoint references are STATIC" below). Source: `imt-app-runtime` master `lib/core/chainMiddleware/endpoint.ts` + `lib/api/rpc.js` + `lib/types.ts` (verified 2026-08-06). SDK Endpoint entity itself: [endpoints-reference.md](../endpoints-reference.md).

A module or RPC `api.imljson` can delegate its HTTP request to a **named sibling Endpoint** instead of making the request itself:

```json
{
	"endpoint": "getDocument", // or { "name": "getDocument", "connection": { ... } }; bare string = { name }
	"input": { "documentId": "{{parameters.docId}}" }, // IML-evaluated against the CALLER's context → becomes the Endpoint's parameters
	"response": { "output": "{{body}}" }
}
```

The `endpoint()` middleware wraps the HTTP request cluster in every action/search/RPC chain (after `isc.initialize()`, before `prepareRequestOptions()`). No directive → byte-for-byte no-op for existing apps. Directive present → the named Endpoint runs via its own `.execute()` (standard `ExecuteRpc` chain) and its result is exposed exactly like an HTTP response: `{{body}}` = the result, `statusCode` = 200, and it **counts toward `requestsMade`** (so `maxPaginationRequestCount` still applies).

### Rules (each violation throws `InvalidConfigurationError` / `RuntimeError`)

| Rule                                | Detail                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `endpoint` + `url` forbidden        | Ambiguous (which path makes the request?)                                                         |
| `endpoint` + `agency` forbidden     | The agency call has already fired by then — error surfaces instead of a silently discarded result |
| Single object only                  | Arrays of endpoint calls rejected — orchestrate multi-call at the module level                    |
| No nesting                          | An Endpoint may not itself use `api.endpoint` (`endpointExecution` marker guard)                  |
| Not in triggers/webhook modules     | `rejectUnsupported()` raises a typed error                                                        |
| Fan-out cap                         | Max **100** inline endpoint calls per top-level execution (`executionFlags.endpointBudget`)       |
| `endpoint.name` = plain string      | Not IML-evaluated — see § "Endpoint references are STATIC" below                                  |
| `endpoint.connection` = object only | A string raises `The 'endpoint.connection' directive must be a connection object; string (IML) values are not supported.` |

### Endpoint references are STATIC (v1.102.3, PR #713)

`endpoint.name` and `endpoint.connection` were IML-evaluated in v1.102.0 and **that evaluation is now disabled**: an Endpoint reference is a *component reference*, not runtime data, so evaluating it at execution time would make cross-component dependencies impossible to analyse statically. Both evaluations are commented out in place in `endpoint.ts` (restorable), not deleted.

Consequences to enforce in review:

- A template `"endpoint": "{{parameters.which}}"` is **not** resolved. It is used verbatim, misses the `app.endpoints` Map lookup, and fails with `Endpoint '{{parameters.which}}' not found.` There is no dedicated template guard — the error is the lookup miss.
- A string `endpoint.connection` (including a template) is rejected with a typed `InvalidConfigurationError`. Pass a connection-shaped **object** instead. `string` deliberately stays in the type union so raw descriptors carrying one are still caught at runtime.
- `api.input` / `pagination.input` are **untouched** — they carry runtime data and remain fully IML-evaluated every round.
- Dynamic Endpoint selection therefore does not exist. A module that needs to choose between Endpoints must branch some other way (separate modules, or one Endpoint that branches internally).

### Pagination interplay

- Module-level `pagination` IS supported — `api.input` is re-evaluated each round (so `{{pagination.page}}` inside `input` advances).
- `pagination.endpoint` (object or bare-string shorthand) overrides **which** Endpoint is called from round 2+ — whole-value override, never merged, and **static** like the base name.
- `pagination.input` is IML-evaluated independently, then merged with the base input per `mergeWithParent` (default `true`) — mirrors `pagination.qs`/`body` semantics.
- `pagination.endpoint.connection` is **NOT supported** (base `endpoint.connection` reused every round; rejected loudly).

### What the embedded Endpoint inherits from the caller

Own `input` as `parameters` (+ caller's connection as `__IMTCONN__`, overridable via `endpoint.connection`); `common`, `scenario`, `environment`, `metadata`, `data`, `instanceId`, `packageName`, `runtime`, `versions`; the record/replay tape **by reference**; the caller's `debug` sink. A `Warning` thrown by the Endpoint is folded into the caller's warnings channel (not a hard failure).

### Endpoint result unwrap (`response.unwrap`)

An Endpoint's `.execute()` runs the RPC chain, which naturally returns an **array**. When executing _as an Endpoint_ (embedded or standalone — gated by the `endpointExecution` marker), the result is unwrapped: single-element array → that object; empty array → `{}`. Opt out with `"response": { "unwrap": false }` or by declaring `response.iterate` (list output keeps the array). Plain RPCs never unwrap.

### Endpoint execution chain & validation reality

A standalone Endpoint runs the full RPC middleware chain — `temp` → `condition()` → requester (incl. `isc`/`agency`/`accman`/inline-`endpoint()` wrap) → `response.temp`/`valid`/`iterate`/`output`/`wrapper`/`filter`/`limit` — so most module `api` directives work. Two review-critical caveats:

- **`condition` cannot implement required-field validation.** `condition()` IS in the chain, but its falsy path ends the chain returning `condition.default` **as data** (or `false`) — it cannot raise a typed error. IEN-16076 field-tested this as a validation workaround: not viable.
- **Forman `required`/`default` are not enforced on the MCP path.** `make-mcp-server-host`'s `endpoint_execute` tool passes `input` straight to `executeEndpointThroughRpcWorker()` with no Forman validation (source-verified); the platform "Run Endpoint" form validates client-side as usual. Platform fix tracked under the Executor initiative — never flag this gap as an app bug.
