# Runtime reference: calling an Endpoint from a module (`api.endpoint`)

> Read when: a module or RPC `api.imljson` delegates its request to a sibling Endpoint, or you review an Endpoint's own `api`: directive shape, rules and their messages, static references, pagination interplay, what the caller receives, what crosses the boundary, `response.unwrap`, what runs inside an Endpoint, standalone runs. Part of [runtime-reference.md](../runtime-reference.md).

An Endpoint is a single-call component of an app (see [endpoints-reference.md](../endpoints-reference.md) for the Endpoint entity itself). A module or RPC can run a sibling Endpoint instead of sending a request of its own. This part covers that inline call, its rules and error messages, and what runs inside an Endpoint.

## Directive shape

A module or RPC `api.imljson` can hand its request to a **named sibling Endpoint** instead of making the request itself:

```json
{
	"endpoint": "getDocument",
	"input": { "documentId": "{{parameters.docId}}" },
	"response": { "output": "{{body}}" }
}
```

- Without `endpoint`, the module sends its request as usual. With it, Make runs the Endpoint in place of the HTTP request.
- `endpoint` is the Endpoint's name. It can also be an object, `{ "name": "getDocument", "connection": { ... } }`; a bare string means `{ "name": ... }`.
- `input` is evaluated in the CALLER's context every time the call runs (in the example, `{{parameters.docId}}` is the caller's parameter), and arrives in the Endpoint as `{{parameters.*}}`. Without `input`, the Endpoint's `{{parameters}}` is empty.
- The Endpoint uses the caller's connection as `{{connection}}`, or the object in `endpoint.connection`. `{{parameters.__IMTCONN__}}` stays empty.
- The Endpoint's result is the caller's `{{body}}`, with `{{statusCode}}` 200, `{{statusMessage}}` "OK" and empty `{{headers}}`. The caller's `response.iterate`, `response.output` and `pagination` read it like an HTTP response. Without `response.output`, the caller passes `{{body}}` through.
- The call counts as one request, so `maxPaginationRequestCount` applies to a paging caller.

## Rules and their errors

Each violation fails the run with InvalidConfigurationError, except the call limit, which is a RuntimeError. Make checks in the order of the table and reports the first violation.

| Rule | Message |
|---|---|
| No nesting: an Endpoint may not use `api.endpoint` itself | "Inline endpoint calls ('api.endpoint') cannot be used inside an Endpoint." |
| `endpoint` with a non-empty `url` (ambiguous: which path makes the request?) | "Cannot use the 'endpoint' and 'url' directives together." |
| `endpoint` with `agency` (the agency call has already been made by then, so this is an error instead of a silently discarded result) | "Cannot use the 'endpoint' and 'agency' directives together." |
| Single object only: an array of endpoint calls (orchestrate several calls at the module level) | "The 'endpoint' directive must be a single object; arrays of endpoint calls are not supported." |
| `pagination.endpoint` as an array | "The 'pagination.endpoint' directive must be a single object; arrays are not supported." |
| `pagination.endpoint.connection` set | "'pagination.endpoint.connection' is not supported; the base 'endpoint.connection' is reused for every round." |
| `endpoint` set to `''`, `false` or `0`, or an object with no string `name` | "Endpoint directive requires a string 'name'." |
| A name that is not an Endpoint of the app (also `constructor` and `__proto__`) | "Endpoint '<name>' not found." |
| More than 100 inline calls in one run, counted across `communication` steps and pagination rounds | RuntimeError "Maximum number of endpoint calls (100) exceeded." |
| A string `endpoint.connection` | "The 'endpoint.connection' directive must be a connection object; string (IML) values are not supported." |

Where the directive works: actions, searches and RPCs, including inside `communication` steps and in an `api` that is itself an array. Elsewhere it is rejected:

- A polling trigger fails with InvalidConfigurationError "Inline endpoint calls ('api.endpoint') are not supported in triggers."
- An instant trigger and the webhook attach, update and detach calls fail with "Inline endpoint calls ('api.endpoint') are not supported in webhook modules."
- The check fires for any present value, including `''`, `false` and `0`. Webhooks and responder modules have no request to replace.

An empty `url` next to `endpoint` is not a conflict: only a non-empty `url` is.

## Endpoint references are static

`endpoint.name`, the name in `pagination.endpoint` and `endpoint.connection` are never evaluated as IML. An Endpoint reference names a component, it is not runtime data, and evaluating it at run time would make the dependencies between components impossible to analyse.

- A template such as `"endpoint": "{{parameters.which}}"` is not resolved. Make looks up the text as written and fails with InvalidConfigurationError "Endpoint '{{parameters.which}}' not found." There is no separate check for templates: the error is the failed lookup.
- A string `endpoint.connection`, a template included, is rejected with the message in the table above. Pass a connection-shaped object instead. Its values are used as written: a template inside the object is not evaluated either.
- `api.input` and `pagination.input` are evaluated in full on every call, because they carry runtime data.
- Choosing an Endpoint dynamically is therefore not possible. A module that must pick between Endpoints branches another way: separate modules, or one Endpoint that branches inside.

## Pagination with an Endpoint

A module-level `pagination` works with an inline call. The Endpoint is called once per round, and the usual stop rules of [pagination.md](pagination.md) apply.

- `api.input` is evaluated again each round, so `{{pagination.page}}` inside it advances.
- `pagination.condition` reads the Endpoint's `{{body}}`, the unwrapped result.
- From round 2 on, `pagination.endpoint` (an object, or a bare name) switches to another Endpoint. It replaces the base value as a whole and is never merged. Like the base name, it is static.
- `pagination.input` is evaluated separately and deep-merged over the base input. Array fields in `pagination.input` REPLACE the base array; they are not merged by index. With `pagination.mergeWithParent: false` it replaces the base input entirely.
- `pagination.endpoint.connection` is rejected (see the table above): the base `endpoint.connection` is used in every round.
- Every call counts as one request, so `maxPaginationRequestCount` applies: a cap of 2 gives 3 calls, and the default of 50 gives 51. Every call also counts toward the limit of 100 inline calls per run.

```json
{
	"endpoint": "listPage",
	"input": { "page": "{{pagination.page}}" },
	"response": { "iterate": "{{body.items}}" },
	"pagination": { "condition": "{{body.hasMore}}" }
}
```

## What the caller receives

What the caller gets depends on its type and on whether the Endpoint returns one result or a list (an Endpoint with `response.iterate`; see [Result unwrap](#result-unwrap-responseunwrap)).

| Caller | Endpoint with one result | Endpoint with a list |
|---|---|---|
| Action | the object, directly | fails with DataError "Invalid module output. Expected Object, but found Array." |
| Search | one numbered bundle | one numbered bundle per element, with no `iterate` in the caller |
| RPC | an array holding the object | the array |

The caller's `response.output` can remap `{{body}}`, and its `response.iterate` and `pagination` read `{{body}}` as they read an HTTP response.

## What crosses the boundary

The Endpoint receives:

- Its input as `{{parameters.*}}`, and the caller's connection, or an `endpoint.connection` object, as `{{connection}}`. `{{parameters.__IMTCONN__}}` is empty.
- The caller's `{{common}}`, `{{scenario}}`, `{{environment}}`, `{{metadata}}`, `{{data}}` and `{{scenarioModuleId}}`, and the app's package, runtime and version information.
- The run's recording: the traffic of the Endpoint is recorded and replayed in order together with the caller's. Its debug output and download progress reach the caller.

What does not cross:

- `temp` crosses in neither direction. Bridge a value in through `api.input` and out through the calling item's own `response.temp` mapping of `{{body}}`. The Endpoint's own `temp` and `response.temp` stay inside it.
- The Endpoint uses its OWN custom IML functions, not the caller's.

```json
{
	"endpoint": "mid",
	"input": { "fromA": "{{temp.a}}" },
	"response": { "temp": { "thing": "{{body}}" } }
}
```

Errors and warnings:

- An error of the Endpoint (for example one shaped by its own `response.error`) reaches the caller unchanged. The caller's `response.error` does not reformat it.
- A Warning raised by the Endpoint is added to the caller's warnings, and the Endpoint's result is still used (see [What ends a run early](../runtime-reference.md#what-ends-a-run-early)).

## Result unwrap (response.unwrap)

An Endpoint's result is unwrapped before the caller sees it as `{{body}}`:

| Items in the Endpoint's result | `{{body}}` |
|---|---|
| one | that object |
| none | `{}` |
| two or more | the array |

- `"response": { "unwrap": false }`, or a `response.iterate` at the TOP level of the Endpoint's `api`, keeps the array: one item stays a list of one, and an empty list stays `[]`.
- Only the top-level `response` is checked. An Endpoint built from a `communication` array whose `iterate` sits inside an item is still unwrapped, to an object or `{}` when it yields 0 or 1 items.
- Plain RPCs never unwrap. The same rule applies when the Endpoint runs standalone.

## What runs inside an Endpoint

An Endpoint's own `api` runs these steps, per request item: top-level `temp`, `condition`, the request (or `isc` or `agency`), `response.temp`, `response.valid`, `response.iterate`, `response.output`, `response.wrapper`, the shape check and `response.limit`; `response.error` formats a failure, and a one-item result is then unwrapped. The request steps are the same per-page steps as an RPC's, so most directives of a module's `api` work in an Endpoint.

- Newer Endpoints reject `repeat` and `while` with InvalidConfigurationError `The 'repeat' and 'while' directives are not supported in Endpoints; an Endpoint is a single API call — repeat at the module level instead.` They reject `response.trigger` with `The 'response.trigger' directive is not supported in Endpoints; an Endpoint has no epoch panel.` These checks run for every request item and fire for any present value, even a falsy one such as `repeat: false`.
- Older Endpoints still honour both directives and follow the RPC order, `repeat` included.
- The shape check accepts plain objects and strings. A newer Endpoint fails with DataError "Invalid item in Endpoint output. Expected Object, or String, but found Number." for a bad list item, or "Invalid Endpoint output. Expected Object, or String, or Array, but found Number." for a whole result that is not a list, an object or a string (for example a `response.wrapper` that evaluates to a number). An older Endpoint says "Invalid item in RPC output. Expected Object, or String, but found Number." and "Invalid module output. Expected Object, or String, or Array, but found Number."
- `condition` cannot validate required fields. A false `condition` does not raise an error: it ends the Endpoint with `condition.default` as its result, and with no `default` the Endpoint returns no result (never `false`). A false `condition` is therefore not a usable input check.

## Standalone runs

When an Endpoint runs on its own (for example in a platform Endpoint run):

- Its input lands in `{{parameters.*}}`.
- A connection given as an id is resolved before the request. A resolution error is returned as it is.
- The result follows the same unwrap rules.
- If the node that runs the Endpoint is too old to run Endpoints, the run fails with RuntimeError saying that the host is too old to run Endpoints. No IMLJSON causes this; it is a deployment state of the node.

A platform note that the runtime cannot confirm: the platform's Run Endpoint form validates the input in the browser, so the `required` and `default` settings of the input fields apply there. A call through the endpoint-execution tool served by the bare `https://mcp.make.com` entry point (not by the `make` server of this plugin) may pass the input straight through with no such validation. Never flag this gap as an app bug.
