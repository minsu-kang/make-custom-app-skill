# Make custom app runtime: behaviour reference

> Read when: writing or reviewing `api.imljson`: the order Make runs a request item in, every request and response directive (`temp`, `condition`, `valid`, `iterate`, `output`, `wrapper`, `limit`, `error`, `repeat`, `response.data`), what each module type returns, building the request (URL and encoding, `qs`, headers, body, timeout, redirects), handling the response, IML paths and missing values, runtime IML functions, limits, private addresses and `urlPermissions`. Mandatory before flagging any `api.imljson` issue (hard rule 3). Less common topics sit in `runtime-reference/` parts: open one only when its row in § Parts applies.

## Scope

This reference describes how Make runs the IMLJSON of a custom app: when an `api.imljson` says X, what Make does, in which order, and with which defaults, limits and edge cases. It states the behaviour of the runtime that executes the IMLJSON, as read from that runtime, and not how the runtime is built. Where the public developer docs (developers.make.com) say something different, or where a platform layer outside the runtime may change the result, one line says so.

The public docs leave these topics open. This reference settles them from the runtime:

- the order of steps per module type;
- `temp` same-block references, and the array and `undefined` merge rules;
- what `json`, `qs`, `urlencoded` and `multipart` bodies send for `undefined`, `null` and `""`;
- URL normalisation in both modes;
- the pagination offset and limit sequence, and its off-by-one;
- the default limit of a trigger, the `select` epoch, the list of ids that share a date, and the memory of unordered triggers;
- `limit` 0 as a literal and as an expression;
- `output` false and null, and the output types each module type accepts;
- the zero-result bundle of a search;
- transport error types, the redirect cap and the repeat cap;
- the runtime IML functions;
- OAuth scope, expiry and renewal;
- private-network blocking and `urlPermissions`;
- the limit overrides: the common data is read for `maxPaginationRequestCount` and `maxPastRecords`, while `maxRequestCount` is not enforced;
- the data size limit of about 64 KB.

Three things the runtime cannot settle, so this reference does not either:

- the full contents of `environment` and `scenario` (the runtime reads only some of their fields);
- the maximum webhook payload size and the webhook response timeout (the gateway sets them, not the runtime);
- whether Endpoints are available to an account (a platform decision; Endpoints are in beta).

## Parts (open every part whose trigger applies, skip the rest)

| Part | Open when |
|---|---|
| [runtime-reference/pagination.md](runtime-reference/pagination.md) | `pagination` directive; search and RPC modules that page: the page, offset and limit sequence, when paging stops, the delay |
| [runtime-reference/polling-triggers.md](runtime-reference/polling-triggers.md) | a polling trigger: `response.trigger`, the saved state (`{{data.lastId}}`, `{{data.lastDate}}`), "Choose where to start", items that share a date, `order`, the default limit |
| [runtime-reference/webhooks.md](runtime-reference/webhooks.md) | an instant trigger with an `api`, a dedicated or shared webhook, `verification` and `respond`, webhook attach/update/detach, a responder module |
| [runtime-reference/inline-endpoint-calls.md](runtime-reference/inline-endpoint-calls.md) | `api.endpoint`, `pagination.endpoint`, `response.unwrap`; reviewing an Endpoint's own `api` |
| [runtime-reference/http-requests.md](runtime-reference/http-requests.md) | TLS options (`rejectUnauthorized`, `ca`, `cert`, `key`), `aws`, `oauth` (OAuth 1.0 signing), `shareCookies`, `gzip`; which headers Make adds; how the older HTTP client differs |
| [runtime-reference/iml-context.md](runtime-reference/iml-context.md) | which IML roots (`parameters`, `connection`, `data`, `metadata`, `webhook`, `payload`, `query`, `depconn`, `organization`, `scenarioModuleId` ...) a component can read; what custom IML function code can see and how it is limited |
| [runtime-reference/environment-variables.md](runtime-reference/environment-variables.md) | `environment`, `flags.environmentAccess` or `internal` roots; verifying what the platform really grants |
| [runtime-reference/oauth-connection-variables.md](runtime-reference/oauth-connection-variables.md) | a connection's `api.imljson` (basic, OAuth 1 or OAuth 2): the step order and the variables of each step, `authorize` and `token`, `token.response.scope`, renewal and `refresh`, `info`, `invalidate` |
| [runtime-reference/isc.md](runtime-reference/isc.md) | `isc` directive (Make-owned app calling an internal service); the AI Module Builder component set |
| [runtime-reference/on-prem-agent.md](runtime-reference/on-prem-agent.md) | `agency` directive: an app reaching a customer system through Make's on-premise agent |

## How a request item runs

A request item is one request description of an `api`: the `api` object itself, or one element of an `api` array or of an object's `communication` array. Make runs the same sequence for every item. The sections below give the order of steps per module type, what is evaluated once and what on every page, how several items combine, items without a request, and what ends a run early.

### Order of steps per module type

Every module type that sends requests handles each request item with the same core steps. The tail after the last page differs per type.

1. Top-level `temp`.
2. `condition`. A falsy result skips the item (see [condition](#condition)).
3. For the first request and then for every pagination page:
   1. refresh the connection token when an OAuth 2 connection needs it;
   2. build the request (`url` and `baseUrl`, `method`, `headers`, `qs`, `body` and the other request directives; they can read `temp` and `pagination.*`);
   3. send it and parse the body by `response.type`;
   4. `response.temp`, then `response.valid`;
   5. `response.iterate` (per element: `iterate.condition`, then the per-element mapping);
   6. `response.output`;
   7. the `pagination` decision: stop, or request the next page.
4. After the last page: the tail of the module type, from the table below.
5. When anything above failed: `response.error` formats the error.

If `repeat` is set, steps 1 to 5 run again for the same item, until the repeat condition is false, before the next item of an array starts. A request that goes through `isc`, `agency` or `api.endpoint` is not sent directly over HTTP in step 3; each is described in its part.

| Module type | After the last page, in this order | Ignored or not allowed |
|---|---|---|
| Action | `response.wrapper`; shape check (one plain object) | `response.data`. Paging keeps only the last page's result, and `response.limit` only stops paging, it never cuts the result |
| Search | `response.wrapper`; shape check (one object, or an array of objects); `response.limit` cut; numbering (`__IMTLENGTH__`, `__IMTINDEX__`) | `response.data` |
| RPC | `response.wrapper`; shape check (objects and strings); `response.limit` cut; when `response.trigger` is set: epoch data on every item (only with `response.iterate`), and for type `id` or `date` a sort by the epoch values that is then reversed (newest first when the items carry epoch data; without `response.iterate` the list is only reversed) | `response.data`, `audit`. No numbering |
| Endpoint | Newer Endpoints: like an RPC, then the unwrap of a one-element result. Older Endpoints follow the RPC order, `repeat` included. See [runtime-reference/inline-endpoint-calls.md](runtime-reference/inline-endpoint-calls.md) | Newer Endpoints reject `repeat`, `while` and `response.trigger` with InvalidConfigurationError, even for a falsy value |
| Polling trigger | After `condition`: `response.trigger.type` and `order` are evaluated. After each page: epoch filtering. After the last page: sort ascending, `response.limit` cut (default 1), save the newest emitted item's id and date, shape check (objects only), `response.data`. See [runtime-reference/polling-triggers.md](runtime-reference/polling-triggers.md) | `response.wrapper`. `api.endpoint` fails with InvalidConfigurationError "Inline endpoint calls ('api.endpoint') are not supported in triggers." |
| Instant trigger with `api` | Per received webhook bundle: `temp`, `condition`, one request, `response.temp`, `response.valid`, `response.iterate`, `response.data`, `response.output`, shape check (objects only, `null` items dropped). See [runtime-reference/webhooks.md](runtime-reference/webhooks.md) | `pagination`, `response.wrapper`, `response.limit`. `api.endpoint` fails with InvalidConfigurationError "Inline endpoint calls ('api.endpoint') are not supported in webhook modules." |
| Webhook attach, update, detach | `temp`, `condition`, the request, `response.temp`, `response.valid`, then `response.data`, then (attach only) `response.uid` | `response.iterate`, `response.output`, `response.wrapper`, `response.limit` and `pagination`. `repeat` works. `api.endpoint` fails with the same "webhook modules" message |
| Basic connection | `temp`, `condition`, then one request per item (no pagination): `response.temp`, `response.valid`, `response.data`, `response.metadata`, `response.uid` | `response.iterate`, `response.output`, `response.wrapper` and `repeat` |
| Responder | No request. Evaluates `response.status`, `response.headers` and `response.body` of the answer sent back to the webhook caller. See [runtime-reference/webhooks.md](runtime-reference/webhooks.md) | |

What a polling trigger does, in detail:

- It is not an action with extras: `response.wrapper` is never applied.
- Id and date are read per iterated item, so an ordered trigger (`asc`, `desc` or no `order`) needs `response.iterate`: without it nothing is emitted, even for a non-empty list of objects. Only an `unordered` trigger passes a list through. A single object (not a list) without `response.iterate` emits nothing in any order.
- In a date trigger, items whose `response.trigger.date` is missing, empty or cannot be parsed are dropped; a missing id does not drop the item. In an id trigger a missing or non-numeric id becomes NaN, and the item is kept. With any other `type`, or none, an item whose id is missing is dropped. `order: unordered` skips this filter. Items already seen are dropped (the trigger saves the last id, the last date, and the ids that share the last date).
- The pages are combined and sorted ascending: by date, then id, for a date trigger; by id for an id trigger.
- `response.limit` (default 1 for ordered triggers) then keeps the OLDEST new items, and the id and date of the newest emitted item are saved.
- Items must be plain objects: a mapped item that is not an object fails the run (see [runtime-reference/polling-triggers.md](runtime-reference/polling-triggers.md#output-rules-and-ignored-directives)). `response.data` is stored.

What an instant trigger with an `api` does, in detail:

- Each received webhook bundle runs the sequence above once. When several bundles arrive they run in parallel, and the results are flattened in arrival order.
- `{{payload}}` is the webhook bundle. A `pagination` block is ignored: there is never a second page.
- `response.iterate` is allowed, so one payload can become several bundles. When it is set, `response.output` is the per-element mapping. Give the trigger a `url`: without one, `response.iterate` makes the trigger repeat without end (see [Instant triggers with an api](runtime-reference/webhooks.md#instant-triggers-with-an-api)).
- Without an `api` the bundles pass through unchanged.

```json
{
	"url": "/items/{{payload.id}}",
	"response": {
		"output": { "hook": "{{payload}}", "item": "{{body}}" }
	}
}
```

A status of 400 or more, and a transport error, cut the sequence short:

- Status 400 or more: Make still parses the body (with the `response.type` entry for that status) and goes to `response.error`. `response.temp`, `response.valid`, `response.iterate`, `response.output` and `pagination` are skipped. A status below 400, including a 3xx that is not followed, is never an error by itself.
- Transport error (no HTTP response, for example a DNS failure, a refused or reset connection, a timeout or a certificate error): the same steps are skipped, and the module ends with the error Make derives from the failure: a ConnectionError for the network codes, a RuntimeError for a certificate error. `response.error` never changes it (see [When no response arrives](#when-no-response-arrives)).

### Once per item or once per page

| Evaluated | When |
|---|---|
| Top-level `temp`, `condition`, `response.wrapper`, the `response.limit` cut, `response.data` | Once per request item and per repeat iteration |
| The request directives (`url`, `qs`, `headers`, `body` and the rest), `response.temp`, `response.valid`, `response.iterate`, `response.output`, `pagination.condition` | Again on every pagination page |
| The connection token check | Before every page's request |

What the response variables show:

- `{{body}}` always reads the latest response of the current request phase.
- On page 2 and later, the request directives see the previous page's `{{body}}`.
- In an array of requests, item N's own request and response directives cannot see item N-1's `{{body}}`. Item N's top-level `temp` and `condition` still see it, and so do the `temp` and `condition` of the next repeat iteration (they see the previous response's `{{body}}`).
- `{{headers}}` and `{{statusCode}}` keep the previous item's values until the next response arrives.
- To pass data between items, use `temp`.

```json
{
	"temp": { "i": "{{ifempty(temp.i; 3)}}" },
	"url": "/items/{{temp.i}}",
	"response": { "temp": { "i": "{{temp.i - 1}}" } },
	"repeat": "{{temp.i > 0}}"
}
```

### Several requests in one module

- When `api` is an array, its items run one after another. Each has its own `temp`, `condition`, `repeat`, request, `response` and `pagination`. The pagination variables restart at page 1, offset 0, limit 20. Items are used as written: nothing from one item is merged into another at run time.
- When `api` is an object with a `communication` array, each item is deep-merged over the other top-level keys of the object, which act as defaults.
- `temp` is shared by all items.
- The module result is the result of the LAST item that produced one. Results are not concatenated. An item skipped by `condition`, or an action item with no output, keeps the previous result. An empty search or RPC result is still a value, so it replaces the previous one.
- An error in any item, page or repeat iteration stops the whole module. Results gathered before are not returned.
- An item with no `url` still runs `response.temp`, `response.valid`, `response.iterate` and `response.output` (see [Items without a request](#items-without-a-request)), so it can build a result from `temp` or `parameters`.

```json
[
	{ "url": "/me", "response": { "temp": { "uid": "{{body.id}}" } } },
	{ "url": "/users/{{temp.uid}}/items", "response": { "iterate": "{{body}}" } }
]
```

### Items without a request

Make sends no HTTP request only when the `url` directive is absent or is a literal empty string `""`. This holds for every module type (action, search, trigger, RPC, Endpoint, connection calls), not only for RPCs.

- `{{body}}`, `{{headers}}` and `{{statusCode}}` stay empty. `response.temp`, `response.valid`, `response.iterate` and `response.output` still run, and pagination is disabled. The one exception is an instant trigger: it has no pagination step, so with `response.iterate` and no `url` the round repeats without end until Make stops the run (see [Instant triggers with an api](runtime-reference/webhooks.md#instant-triggers-with-an-api)).
- That makes pure data components possible: an RPC (or any module) that only uses `temp`, `response.temp` and `response.output` builds its result without an API call.
- An action with `response.output: "{{body}}"` and no `url` returns no result, because `{{body}}` is undefined.

```json
{ "temp": { "x": 1 }, "response": { "output": "{{temp}}" } }
```

```json
{ "response": { "output": { "id": "{{temp.id}}" } } }
```

A `url` template that evaluates to empty, `null` or `undefined` is not the same as an absent `url`: the request is still sent, to `baseUrl` with a trailing `/` added. With no `baseUrl` the request is broken: the host becomes `undefined` when `encodeUrl` is on, and a TypeError "Expected a string" is thrown when it is off. Skipping the request works only when the directive itself is absent.

```json
{ "baseUrl": "https://api.x.com/v1", "url": "{{parameters.path}}" }
```

With `parameters.path` unset this sends `GET https://api.x.com/v1/`.

Exception: this skip does not apply when the `isc` directive is present. A component with `isc` and no `url` fails with RuntimeError `ISC directive requires a url field to specify the request path.` instead of silently skipping the call. See [runtime-reference/isc.md](runtime-reference/isc.md#preconditions).

### What ends a run early

When the scenario is stopped or the module times out:

- `repeat` and pagination stop at the next iteration boundary, and a running `repeat.delay` or `pagination.delay` is cut short. The request in flight is not aborted.
- The result gathered so far is returned, without the "Maximum number of repeats exceeded." error.
- The items of an array of requests still start their first request.

When a request was let through with `rejectUnauthorized: false` despite a certificate problem, or an inline Endpoint call raised a warning, the module still returns its result but finishes with one Warning. Its message lists all collected warnings, separated by a dashed line.

## Directives

One subsection per directive, with defaults, accepted forms and edge cases. `pagination` has its own part: [runtime-reference/pagination.md](runtime-reference/pagination.md). Every `response.*` directive belongs to the request item it is written in.

### temp and response.temp

`temp` is a scratch object that the other directives of one module execution read as `{{temp.*}}`. It is filled in two phases:

| Directive | Runs | Who can read it |
|---|---|---|
| `temp` (top level) | Once per request item and per repeat iteration, before `condition` and before the request | `condition`, `url`, `qs`, `headers`, `body`, and `response.temp` |
| `response.temp` | Right after the response body is parsed, before `response.valid`, on every page | `response.valid`, `response.iterate`, `response.output` and the later directives |

Only `temp` and `response.temp` exist. There is no `temp2`, `temp3` or any other temp stage.

**Lifetime.** `temp` starts empty for every module execution (each bundle or call). Within one execution it is shared by all items of an array of requests, all repeat iterations and all pagination pages. It does not cross into an inline Endpoint call. Nothing in `temp` survives to the next execution; use `response.data` (triggers, webhooks) for that.

**Accepted forms.**

- A `temp` value is an object (evaluated deeply) or one expression string that evaluates to an object (its keys are merged).
- A top-level array, or a falsy value, is ignored.
- A key that contains `{{...}}` is evaluated as a key name. A key written exactly `{{...}}` spreads the object it evaluates to into the parent.
- The same rules apply to `body`, `output`, `wrapper` and `data`.
- Literal objects nested more than 10 levels deep inside a directive come out empty. An object returned by an expression is kept whole.

```json
{ "temp": { "{{...}}": "{{parameters.extra}}", "id": "{{parameters.id}}" } }
```

**Values in one block cannot read each other.** All values of one `temp` block are evaluated first and merged afterwards, so a value cannot read another key defined in the same block: it sees the value that key had before this block. A temp variable defined in `api.temp` cannot reference another variable of the same `api.temp` block:

```json
// BROKEN: generateResult is evaluated before generateParams is assigned
{
    "temp": {
        "generateParams": { "a": ["x"], "b": ["y"] },
        "generateResult": "{{if(condition, temp.generateParams.a, temp.generateParams.b)}}"
    }
}
```

```json
// CORRECT: use response.temp to reference values from temp
{
    "temp": {
        "generateParams": { "a": ["x"], "b": ["y"] }
    },
    "response": {
        "temp": {
            "generateResult": "{{if(condition, temp.generateParams.a, temp.generateParams.b)}}"
        },
        "output": "{{temp.generateResult}}"
    }
}
```

The two-phase pattern works because `temp` runs first and assigns `generateParams`, and `response.temp` runs later and can safely read `temp.generateParams`. In the other direction, top-level `temp` runs before `condition` and the request, so those directives can read it, and `response.temp` can read top-level `temp`:

```json
{ "temp": { "a": 1 }, "condition": "{{temp.a = 1}}", "response": { "temp": { "b": "{{temp.a + 1}}" } } }
```

**Merge rules.** `temp` and `response.temp` are deep-merged into the existing `temp`:

- Nested objects merge key by key. Keys are never removed, so old properties persist even after a "replacement".
- Arrays merge index by index: a shorter new array keeps the old tail, and the elements at each index are themselves merged into each other.
- `null` overwrites.
- A value that evaluates to `undefined` never overwrites an existing value (the old value stays). A new key is created holding `undefined`.
- To clear a key, write `null`. To replace an array, write it under a new key.

```json
{ "response": { "temp": { "cursor": "{{body.next}}" } } }
```

If the last page has no `next`, `temp.cursor` keeps the previous page's cursor.

Array merging is the dangerous part:

```
Old temp.arr = [A, B, C, D, E]   (5 items)
New value    = [A, B, D, E]       (4 items: C filtered out)

Merge result:
  [0] A merged with A: fine
  [1] B merged with B: fine
  [2] C merged with D: index shift, C gets D's data
  [3] D merged with E: D gets E's data
  [4] E stays: stale element retained (the merge never deletes)
```

This causes three problems:

1. **Index-shifted contamination.** When an array shrinks (filter, remove), the elements at mismatched indexes are merged into the wrong element.
2. **Ghost properties.** The merge never deletes properties from the old value, so old properties persist after a "replacement".
3. **Cascading contamination.** When `sort()` reorders elements, the new array can hold the same element objects as the old one. The merge changes the objects in place at each index, and an object that sits at different indexes in the old and the new array passes the change on through the whole array. Whether a reordered array shares element objects with the old one depends on the IML function that reorders it; the contamination was observed in a real app.

| Pattern | Safety |
|---|---|
| Array grows monotonically (concat plus distinct) | Safe: the same elements sit at the same indexes, so the merge changes nothing |
| Array shrinks (filter, remove) written to the same key | Dangerous: the index shift merges elements into each other |
| Array reorders (sort) written to the same key | Dangerous: elements merge into each other at changed indexes, and shared element objects can cascade the change |
| Filtered or sorted result written to a new key | Safe: there is no previous value to merge against |
| Inline filter or sort in the consuming expression | Safe: the result never passes through the merge |

Rule: treat temp array keys as append-only. Never write a shorter or reordered array back to the same temp key. Use a new key, or inline the operation.

In a real app (google-email v4) this caused 92.5% cross-message body contamination in a 200-email batch.

**Unfilled parameters.** In apps with manifest version 2 or higher, `{{parameters.fieldName}}` for a parameter the user did not fill in evaluates to `undefined` (not to `""`). The key still exists in `temp`, holding `undefined`, and a JSON body leaves it out, because JSON drops `undefined` values. That makes explicit mapping patterns like this one safe, because unfilled fields drop out of the JSON body:

```json
{
	"temp": {
		"mappedFields": {
			"name": "{{parameters.name}}",
			"description": "{{parameters.description}}"
		}
	},
	"body": {
		"feature": "{{temp.mappedFields}}"
	}
}
```

If the user only fills `name`, `temp.mappedFields` holds `name` and a `description` key whose value is `undefined`, and the JSON body is `{"feature": {"name": "user value"}}`: `description` is not sent.

In apps with manifest version 1, any missing path (an unfilled parameter, a missing key, an out-of-range index) evaluates to `null` instead. `temp` keeps the `null`, and a JSON body sends `"key": null`. In both versions a path that passes through an existing `null` gives `null`. In manifest 2 and higher, because `undefined` never overwrites a key that `temp` already holds, a cursor that is missing on the last page keeps the previous page's value. How a body of each type sends `undefined`, `null` and `""` is in [body and type](#body-and-type); missing values in general are in [Missing values](#missing-values).

**Timing of `response.temp`.**

- It runs right after the body is parsed and before `response.valid`.
- It is skipped when the HTTP status is 400 or higher, so a `response.error` message cannot use `temp` values from that error response.
- On a 2xx response that then fails `response.valid`, `response.temp` has already been applied.
- On an item without a request it still runs, with `{{body}}` empty.

**Pagination caveat.** Top-level `temp` is not evaluated again per page: only once per request item and per repeat iteration. `response.temp` is re-evaluated on every page. If a temp variable was set to a meaningful value on the first page (for example `true`), a later page may overwrite it (for example back to `false`). Use `ifempty` to protect values that should persist once set:

```json
"response": {
    "temp": {
        "hasResults": "{{ifempty(temp.hasResults; body.total > 0)}}"
    }
}
```

Without `ifempty`, page 1 might set `hasResults = true`, but page 2 (with 0 results) would overwrite it with `false`.

### condition

`condition` decides whether a request item runs. It is an expression string, a boolean, or an object with a `default`:

```json
"condition": "{{parameters.optionalField}}"
```

Object form with default:

```json
{
	"condition": "{{parameters.hasData}}",
	"default": { "status": "skipped" }
}
```

- When `condition` is missing or `null`, or the object has no `condition` (or it is `null`), the request runs.
- Any falsy result (`false`, `0`, `""`, `null`, `undefined`) skips the item.
- `default` is evaluated deeply (arrays are allowed) and becomes the item's result.

A false `condition` skips everything after it for that item or repeat iteration: the request, all `response.*` directives, pagination, `response.wrapper`, the shape check, `response.limit`, bundle numbering, `response.data` and epoch updates.

Without `default` the item has no result. The module then returns the previous item's result, or nothing when there is none:

| Module type | Result of a skipped item without `default` and without an earlier result |
|---|---|
| Action | No output |
| Search | `[{"__IMTLENGTH__": 0}]` |
| Polling trigger | No bundles |
| RPC, Endpoint | No result |

It never returns `false`. The other items of an array of requests still run, and in a `repeat` the repeat condition is still evaluated. In array-form connection steps only that item is skipped, and `default` has no effect there.

`default` is returned as it is: `response.wrapper` is not applied, its shape is not checked and `response.limit` is not applied.

- Search: an object `default` is thrown away and replaced by the zero-result bundle `[{"__IMTLENGTH__": 0}]`. Only a non-empty array `default` is returned, as it is, without `__IMTLENGTH__` and `__IMTINDEX__` and without object validation.
- Action and RPC: the default (or nothing) becomes the output directly. An object `default` of an RPC is returned as an object, not as an array.
- Polling trigger: the default is returned without any epoch handling.

### valid

`response.valid` checks the response. It has two forms: an expression string, or an object `{ condition, message, type }` (the public docs list the same two forms).

```json
// Simple expression
"valid": "{{body.success}}"
```

```json
// Object with custom error
"valid": {
    "condition": "{{body.success}}",
    "message": "API returned failure",
    "type": "DataError"
}
```

- It runs once per page, after `response.temp`, and only for a response with a status below 400.
- A missing value means "no check" (always valid).
- A literal boolean is accepted but can never fail: `false` (also `0` and `""`) means no check, and `true` always passes.
- An object without `condition`, including `{}`, fails EVERY response.
- `type` is used only together with a `message` that evaluates to non-empty.

When the check fails and `message` evaluates to non-empty, Make raises that message with `type`. `response.error` cannot change it. Allowed types: RuntimeError, InconsistencyError, DataError, RateLimitError, OutOfSpaceError, ConnectionError, InvalidConfigurationError, InvalidAccessTokenError, UnexpectedError, MaxResultsExceededError, IncompleteDataError, DuplicateDataError, UnknownError. Anything else becomes RuntimeError.

Without a `message`, `response.error` supplies the error: first its entry for the actual status (for example `"200"`), then its generic `message` and `type`. Without those, the error is RuntimeError "Response marked as invalid."

```json
{
	"response": {
		"valid": "{{body.ok}}",
		"error": { "200": { "message": "Not valid: {{body.detail}}", "type": "DataError" } }
	}
}
```

### iterate

`response.iterate` turns the response into a list of items. It is an expression string, or an object with `container` (the expression), `condition` (filters each item) and `transform` (maps each item).

- A falsy container gives an empty result. A non-array value (an object, or a string body) is treated as a one-element list.
- Iteration STOPS at the first falsy element (`null`, `0`, `""`, `false`), so later elements are lost.
- It runs once per page.
- `iterate.condition` is checked for each element before the mapping, with `{{item}}` as the raw element. A falsy result drops the element.

```json
{
	"response": {
		"iterate": { "container": "{{body.items}}", "condition": "{{item.active}}" },
		"output": { "id": "{{item.id}}" }
	}
}
```

Variables. While iterating, `{{item}}` is the raw element, and `{{iterate.index}}` (0-based), `{{iterate.isFirst}}` and `{{iterate.isLast}}` (against the full container) are available. After the iteration `{{item}}` is gone, and `{{iterate.container.first}}`, `{{iterate.container.last}}` (raw elements) and `{{output}}` (the mapped items of this page) are available to `response.output` and `response.wrapper`:

```json
{
	"response": {
		"iterate": "{{body}}",
		"output": "{{item.name}}",
		"wrapper": { "first": "{{iterate.container.first}}", "data": "{{output}}" }
	}
}
```

`response.output` as the per-item mapping. When `iterate` has no `transform` of its own, `response.output` becomes the per-item mapping (default `{{item}}`) and is not applied again afterwards.

- `output: false` or `null` is then ignored, and the raw items are output.
- An `output` that is an array, a number or `true` fails with InvalidConfigurationError "Invalid output descriptor. Expected Object, or String, but found Array." (the type name varies).
- When `iterate.transform` exists, it is the per-item mapping, and `response.output` is applied afterwards to the whole list.

What a per-item mapping returns:

- A mapped item that is falsy (`null`, `""`, `0`, `false`) is dropped silently. In a polling trigger it is not: it fails the run with RuntimeError (see [runtime-reference/polling-triggers.md](runtime-reference/polling-triggers.md#output-rules-and-ignored-directives)).
- A mapping that returns an array adds the array's elements AND then the array itself as one more element. That extra element then fails the shape check of every module type (DataError).

### output

`response.output` builds the page's result.

- Missing: the result is the parsed response body (nothing for an item without a request).
- `false` or `null`: this page produces no result, and pagination stops.
- Otherwise the object, string or array is evaluated deeply by IML, and `{{output}}` is set to the result of each page.
- It runs once per page. In an instant trigger it runs once, after the request.
- With `response.iterate` and no `iterate.transform`, `false` and `null` are ignored (see [iterate](#iterate)).

### wrapper

`response.wrapper` runs once per request item, after the last page, and its result replaces the whole result. It is applied after `iterate`.

- Its `{{output}}` is the output of the LAST page only, not the items of all pages. `{{body}}` is the last response.
- It may return an object, a string or an array. The module's shape check then applies (an action needs an object).
- It is used in actions, searches, RPCs and Endpoints. It is NOT applied in polling triggers, instant triggers, webhook attach/update/detach or connections.

```json
{
	"response": {
		"iterate": "{{body.users}}",
		"output": { "id": "{{item.id}}" },
		"wrapper": { "users": "{{output}}" }
	}
}
```

### limit

`response.limit` is an IML expression that cuts an array result to its first N items. Results that are not arrays pass through unchanged. It works independently of `iterate`: it cuts any array result.

| Value | Effect |
|---|---|
| Missing, or a literal `0`, `null`, `false` or `""` | No limit (effectively unlimited) |
| An expression that evaluates to empty, `null` or `undefined` | No limit |
| An expression that evaluates to the number `0` | InvalidConfigurationError "Limit cannot be zero.", raised after all pages were fetched. An action has no cut, so it raises nothing |
| The text `"0"` (for example from a text parameter) | Keeps nothing, no error. A text that reads as a number (`"4"`) works as that number |
| A positive integer n | Keeps the first n items |
| A non-integer or a non-number (for example `2.5`, `"abc"`) | Ignored, no error |
| A negative integer -k | Drops the last k items |

Example with 10 items: limits `null`, `5` and `20` give 10, 5 and 10 items.

```json
"response": { "limit": "{{parameters.limit}}" }
```

Where it applies:

- The cut runs after `response.wrapper` and the shape check, and before the numbering of a search, so `__IMTLENGTH__` counts the limited list.
- Separately, pagination stops once the number of collected items reaches `response.limit`. There a literal `0`, `null`, an empty value, a non-integer and an expression that evaluates to the number `0` all mean no limit (the last one then fails at the cut, as above). The text `"0"` does stop paging, after the first page. In a module that cuts, the cut then keeps nothing; an action, which has no cut, returns the first page.
- Searches, RPCs, Endpoints and polling triggers use the cut. The default for ordered polling triggers is 1 (see [runtime-reference/polling-triggers.md](runtime-reference/polling-triggers.md)).
- Actions use `response.limit` only for the pagination stop. Instant triggers, webhook attach/update/detach and connections ignore it.
- In a search, `response.output: "{{body}}"` with `response.limit` and no `iterate` works when the API response is an array: the limit is applied and each element becomes an individual output bundle.

### error

`response.error` shapes the error of a failed request. It is a string (the generic message) or an object with `message`, `type` and exact status keys:

```json
"error": {
    "401": { "message": "...", "type": "InvalidAccessTokenError" },
    "429": { "message": "...", "type": "RateLimitError" },
    "message": "[{{statusCode}}] {{body.message}}"
}
```

Matching.

- Only `response.error` of the current request item is read. A top-level `api.error` is not a directive.
- Status keys are exact codes such as `"401"`. There are no ranges or wildcards.
- A status key's missing `message` or `type` falls back to the generic `message` and `type`.
- The generic `message` and `type` apply to every HTTP status of 400 or higher. For a 2xx or 3xx response they apply only when `response.valid` failed without its own message.
- `message` and `type` are expressions. They can read `{{body}}` (the error body, parsed by `response.type`), `{{statusCode}}`, `{{headers}}`, `{{temp}}`, `{{parameters}}` and `{{connection}}`. A `message` that evaluates to empty keeps the original message.

Defaults, when no valid custom `type` is given:

| Status | Error |
|---|---|
| 429 | RateLimitError "Third party API limit likely exceeded" |
| 500 to 599 | ConnectionError "Service is temporarily unavailable." |
| Any other status of 400 or more | RuntimeError "Status Code Error: <code>" |

A status below 400, including a 3xx that is not followed, is never an error by itself: only a failed `response.valid` turns it into one. A custom `message` alone replaces the text but keeps the 429 and 5xx types. A valid custom `type`, generic or per status, replaces those types. An unknown type becomes RuntimeError, and the 429 and 5xx defaults still apply.

Allowed types: IMLError, RuntimeError, InconsistencyError, DataError, RateLimitError, OutOfSpaceError, ConnectionError, InvalidConfigurationError, InvalidAccessTokenError, UnexpectedError, MaxResultsExceededError, IncompleteDataError, DuplicateDataError, UnknownError. Anything else becomes RuntimeError. The type can be an expression:

```json
{
	"response": {
		"error": {
			"message": "[{{statusCode}}] {{body.message}}",
			"type": "{{if(statusCode = 404; 'DataError'; 'RuntimeError')}}",
			"401": { "type": "InvalidAccessTokenError" }
		}
	}
}
```

Scope and effect.

- An error that already has a Make type passes through `response.error` unchanged: IMLError from an expression or a custom function, the DataError of the shape check, an error from `valid.message`, and InvalidConfigurationError.
- Errors without an HTTP response (network and TLS errors) are never re-typed by `response.error`. See [When no response arrives](#when-no-response-arrives) for the types and messages.
- Any error stops the whole module: remaining pages, repeat iterations and later items of an array of requests do not run, and results gathered before are not returned.

### repeat

`repeat` runs a request item again while a condition holds. It is an object `{ condition, delay, limit }` or a bare condition string. `while` is a deprecated alias; `repeat` wins when both are set.

```json
"repeat": {
    "condition": "{{body.status == 'pending'}}",
    "delay": 2000,
    "limit": 10
}
```

- The item always runs once. The condition is checked after each full iteration (including `response.wrapper` and the shape check). It can read the latest `{{body}}` as well as `{{temp}}`. The public docs say the condition can read only `temp`; the runtime also exposes the latest `{{body}}`, and the platform may differ.
- `limit` defaults to 1000 when it is missing or 0, and has no cap. With `limit: N` the item runs up to N+1 times, then fails with RuntimeError "Maximum number of repeats exceeded."
- `limit` and `delay` are not evaluated as IML: an expression string as `limit` never triggers the error. `delay` is a plain number of milliseconds between iterations, with no maximum.
- Each iteration runs top-level `temp`, `condition` and the whole request phase again, so the loop advances through `temp` (for example a counter) or through the latest `{{body}}`.
- The module result is the last iteration that produced a result. Results of earlier iterations are not merged. An error in any iteration stops the loop with that error.
- `repeat` works in actions, searches, RPCs, polling and instant triggers, and webhook attach/update/detach. Newer Endpoints reject it, and connections ignore it.

The bare-string form appears in the example under [Once per item or once per page](#once-per-item-or-once-per-page).

### response.data, response.metadata and audit

`response.data` is stored only by polling triggers (at the end of a successful run), instant triggers that already have stored data from Make, webhook attach and update, and connections. A webhook detach evaluates it and saves nothing. Actions, searches, RPCs and Endpoints ignore it.

- It is evaluated deeply and shallow-merged into the stored data: each top-level key replaces the stored key as a whole (a nested object is replaced as a whole), and the other stored keys stay.
- A key whose expression evaluates to `null` or `undefined` is overwritten with that empty value (the OAuth 2 `refresh` is the exception, see [runtime-reference/oauth-connection-variables.md](runtime-reference/oauth-connection-variables.md)).
- A result that evaluates to empty changes nothing.
- When the merged data would exceed about 64 KB, the module fails with RuntimeError "Error processing module data. 'data' collection is too big." and the stored data stays unchanged.

```json
{ "response": { "data": { "lastCursor": "{{body.cursor}}" } } }
```

`response.metadata` takes effect only in connections, where its evaluated keys are merged into the connection metadata, which holds the connection label. Modules ignore it.

`audit` and `response.audit` take effect only when the environment enables auditing. Then only the keys `agentId`, `systemConnection`, `targetApi`, `targetObject` and `targetSystem` with non-empty, non-object values are sent. They run in actions, searches, polling triggers and instant triggers, not in RPCs, Endpoints or webhook attach/update/detach. `response.audit` also runs when the request failed.

## What each module type returns

The final result of a request item, and the check that guards its shape, differ per module type. A shape error is always a DataError.

### Action

An action returns one plain object, or no result.

- `null` or `undefined` gives no result and no error. So does `response.output` set to `false` or `null`, or a false `condition` without `default`.
- Anything else fails with DataError "Invalid module output. Expected Object, but found <Type>." (for example `Array`; the type name varies). That is what an array from `response.iterate` without a wrapper, or a raw array body, produces. So `response.iterate` in an action needs a `response.wrapper` that builds an object; inside the wrapper `{{output}}` is the iterated list, and `{{iterate.container.first}}` and `{{iterate.container.last}}` are the first and last raw items.
- When an action paginates, each page's result REPLACES the previous one. Only the last page's output, with the wrapper applied to it, is returned. A page with no result keeps the previous one. (A condition on `pagination.page`, `offset` or `limit` that ends paging costs the last page: see [pagination.condition is checked twice per round](runtime-reference/pagination.md#paginationcondition-is-checked-twice-per-round).) Pages are never accumulated, and `response.limit` never cuts an action's output, it only stops paging. An instant trigger never requests a second page (see [Order of steps per module type](#order-of-steps-per-module-type)), so this rule does not come up there.

```json
"response": {
    "iterate": "{{body}}",
    "output": "{{item.name}}",
    "wrapper": { "names": "{{output}}" }
}
```

### Search

A search always returns a list.

- A single object output becomes a one-item list.
- A search concatenates the output of every page, and an output that is an array is spread into separate items. Search, RPC and Endpoint append every page's items into one list.
- Order after the last page: the shape check, the `response.limit` cut, then the numbering.
- Each item gets `__IMTLENGTH__` (the item count after `response.limit`) and `__IMTINDEX__` (the 1-based position). A single object gets 1 and 1. With a `response.wrapper` that returns an object, that object becomes the single numbered bundle.
- Only the very same object appearing twice is removed. Items with equal content are all kept.
- With a `communication` array or an `api` array, the result of the LAST step that produced a result is returned. Steps are not concatenated, and numbering is computed per step. A step that finds nothing still produces a result: when the last step finds nothing, the search returns `{"__IMTLENGTH__": 0}` even if an earlier step found items. Only a step skipped by a false `condition` (without `default`) keeps the earlier result.

Zero results. A search with nothing to output always returns exactly one bundle `{"__IMTLENGTH__": 0}`. That covers an empty list, `output` false or `null`, `iterate` finding nothing, a false `condition` and an item without a request. The app flag `continueWhenNoRes: false` has no visible effect: the result is the same. How the scenario treats that bundle is decided by the Make platform, outside the runtime.

Shape check.

- Items must be plain objects. `null` and `undefined` items are removed.
- Any other item (string, number, array) FAILS the run with DataError "Invalid item in module output. Expected Object, but found String." (the type name varies). It is not filtered out.
- A whole result that is neither an object nor an array fails with "Invalid module output. Expected Object, or Array, but found Number."
- Instant triggers use the same check. A polling trigger uses it too, but with `response.iterate` a mapped item that is not an object fails earlier with RuntimeError, and a `null` item is not removed (see [runtime-reference/polling-triggers.md](runtime-reference/polling-triggers.md#output-rules-and-ignored-directives)).

### RPC

An RPC returns an array, unless a wrapper or a `condition.default` returns an object or a string.

- The array is `[]` when nothing was produced (including `output` false or `null`), and `[object]` for a single object. An output that evaluates to an array, such as `{{body}}` or a literal array, gives one item per element.
- A `response.wrapper` or a `condition.default` that yields an object or a string is returned as that object or string, not inside an array. A false `condition` without `default` returns no result.
- The order of steps is a search's, except that the shape check accepts objects and strings, and there is no bundle numbering.
- An RPC with no `url` makes no request and evaluates `temp`, `response.temp` and `response.output` (see [Items without a request](#items-without-a-request)).

Shape check.

- Array items must be plain objects or strings. `null` items are removed.
- Any other item fails with DataError "Invalid item in RPC output. Expected Object, or String, but found Number." (the type name varies).
- A number or boolean whole result (for example from a wrapper) fails with "Invalid module output. Expected Object, or String, or Array, but found Number."
- Endpoints give the same errors with Endpoint wording ("Invalid item in Endpoint output...", "Invalid Endpoint output...").

Pagination. RPC pagination works like search pagination: all pages are concatenated, and `{{pagination.page}}`, `offset` and `limit` and `temp` advance per page. Paging stops on:

- an empty page;
- a false `pagination.condition`;
- `response.limit` reached;
- 50 extra pages (`maxPaginationRequestCount`, so 51 requests in total);
- 3200 raw fetched items (counted only when `response.iterate` is used);
- no `url` (or `endpoint`) to repeat.

Epoch list for "Choose where to start". When an RPC declares `response.trigger` (`id`, `date`, `type`), two things happen, independently of each other:

- With `response.iterate`, each output item gets `data: {epoch: {id, date, type: "select"}}`, with `id` and `date` evaluated against the raw item. This OVERWRITES any `data` key of the output, so the output must be an object (a string output cannot carry it and fails). Without `response.iterate` no epoch data is added.
- When `type` is `id` or `date`, the final list is sorted ascending and then reversed, so it comes back newest first: by `epoch.date`, then `epoch.id`, for type `date`; by `epoch.id` for type `id`. The sort compares the raw evaluated values, not parsed dates: numbers numerically, strings lexicographically (so string ids and date strings sort as text). This happens whether or not `response.iterate` is set. Without it there are no epoch values, so the list keeps its order and is simply reversed. With any other `type`, or none, the list is not sorted.

Newer Endpoints reject `response.trigger`; older ones honour it.

```json
"response": {
    "iterate": "{{body}}",
    "trigger": { "id": "{{item.id}}", "date": "{{item.created_at}}", "type": "date" },
    "output": { "label": "{{item.title}}" }
}
```

```json
"response": {
    "iterate": "{{body.users}}",
    "output": { "value": "{{item.id}}", "label": "{{item.name}}" }
}
```

### Endpoints and triggers

- An Endpoint returns the RPC-style result, then a one-element array is unwrapped to that element and an empty array becomes `{}`. With `response.unwrap: false`, or a top-level `response.iterate`, the array is kept. A false `condition` without `default` returns no result. See [runtime-reference/inline-endpoint-calls.md](runtime-reference/inline-endpoint-calls.md).
- A polling trigger returns the new items as a list, or nothing (no bundles) when there are none. See [runtime-reference/polling-triggers.md](runtime-reference/polling-triggers.md).
- An instant trigger with an `api` returns the output of each webhook bundle (an object or a list), flattened over all bundles in the run. See [runtime-reference/webhooks.md](runtime-reference/webhooks.md).

## Building the request

Make builds the request from the directives of a request item each time it sends one, including every pagination page: `url`, `baseUrl`, `qs`, `method`, `headers`, `type`, `body`, `timeout` and the redirect directives. Each directive except the redirect directives (read as literals, see [redirects](#redirects)) is evaluated as IML first. TLS options, AWS and OAuth 1.0 signing, cookies, compression and the headers Make adds on its own are in [runtime-reference/http-requests.md](runtime-reference/http-requests.md).

### url and baseUrl

`url` and `baseUrl` are each evaluated as IML, then joined:

- A `url` that starts with `http://` or `https://` (in any letter case) is used alone, and `baseUrl` is ignored.
- Any other `url` is relative. Make joins it as `baseUrl` + `/` + `url`, and runs of `/` in the path collapse into one, so a leading `/` in a mapped path value is harmless.
- A protocol-relative `//host/path` counts as relative too: with a `baseUrl` it is appended to the `baseUrl` and the host does not change. With no `baseUrl` it becomes `http://host/path`.

```json
{ "baseUrl": "https://api.x.com/v1/", "url": "/items" }
```

This sends `https://api.x.com/v1/items`. `pagination.url` follows the same rules.

Protocol:

- A URL without a protocol gets `http://`, not `https://`. Write `https://` in `baseUrl` when the API needs it.
- Only `http` and `https` are allowed. Any other protocol fails the module with `Unsupported protocol ftp:. Only http and https are supported.`

```json
{ "baseUrl": "example.com", "url": "/info" }
```

This sends `GET http://example.com/info`.

Empty and unusual values:

- Only an absent `url`, or a literal `""`, skips the request (see [Items without a request](#items-without-a-request)). A `url` template that evaluates to empty sends a GET to `baseUrl` + `/`:

```json
{ "baseUrl": "https://api.x.com/v1", "url": "{{parameters.path}}" }
```

With `parameters.path` unset this sends `GET https://api.x.com/v1/`.

- A URL with an IPv6 literal such as `http://[2001:db8::1]/path` fails with `Invalid URL` while `encodeUrl` is on (the default), in both modes. It works with `encodeUrl: false`. Host names are resolved to IPv4 addresses only, so a host that has only IPv6 addresses cannot be reached.
- Put values that contain `://`, `/` or non-ASCII characters in `qs`, never in the `url` string: the quirks of an inline query, listed in the next section, do not apply to `qs` values.

### URL encoding and normalisation

After IML evaluation and the join, and before the request is sent, Make normalises the URL. Two directives steer it, and both are evaluated as IML:

- `encodeUrl` defaults to true. Only a falsy value turns encoding off: boolean `false`, `{{false}}`, `0`. The string `"false"` is truthy, so encoding stays on. In `uniform` mode a truthy value that is not the boolean `true` (such as `"false"` or `1`) encodes the path but leaves the inline query as written.
- `encodeUrlMode` defaults to `legacy`. The other value is `uniform`. Any other value fails with `App Error: Expected "encodeUrlMode" directive to be "legacy" or "uniform", if defined. Invalid value: <x>`.

The default `legacy` mode runs an older normaliser with several quirks. `uniform` runs a newer, more regular one. The `qs` directive is added after normalisation, so values in `qs` avoid every quirk below.

Both modes:

- Runs of `/` in the path collapse into one: `/foo//bar///baz` becomes `/foo/bar/baz`.
- The default port is removed: `:80` for http, `:443` for https.
- A trailing dot on the host name is removed and `www.` is kept: `https://www.example.com.:443/p` becomes `https://www.example.com/p`. An international domain name is sent in its ASCII form (`žluva.example` is requested as `xn--luva-kbb.example`), and a host already written in that form is sent as written.

**Default mode (`legacy`).**

| | `encodeUrl: true` (default) | `encodeUrl: false` |
|---|---|---|
| Path | Percent-encoded: spaces, quotes, `<`, `>` and non-ASCII characters. `( ) $ : = & , ; + @ ! *` stay literal | Sent as written, except that spaces and Latin-1 characters (up to U+00FF, such as `é` or `ü`) are percent-encoded as UTF-8. A character above U+00FF (such as `ž` or an emoji) fails with `Request path contains unescaped characters. URL: ...`, unless a `qs` directive with at least one value that is not `null` or `undefined` is also set (the path is then encoded) |
| `%XX` already in the path | Encoded again: `%2F` becomes `%252F` and `%20` becomes `%2520`. Pass path segments unencoded | Kept as written |
| Inline query (the part after `?` in `url`) | Kept as written, except that braces, pipe, backslash, caret, backtick, spaces, quotes, `<` and `>` are percent-encoded | Decoded once, completely (below) |

```
url "/list(1,2,3)"      ->  /list(1,2,3)
url "/a b/ježíšek"      ->  /a%20b/je%C5%BE%C3%AD%C5%A1ek
url "/je%C5%BE"         ->  /je%25C5%25BE
```

With `encodeUrl: false` the inline query is decoded once:

- `%26` becomes `&` and splits the value, `%3D` becomes `=`, `%2B` becomes `+` (servers read it as a space), `%3F` becomes `?` and then `&`, and `%25` becomes a bare `%`.
- Only `%20` and `%23` survive (they are sent as `%20` and `%23`).
- A bare `%` in the query fails with `URI malformed`.

`url "/path?a=1%262"` with `encodeUrl: false` is sent as `/path?a=1&2`. The public docs describe `encodeUrl: false` as decoding percent-encoded characters in the query string and do not mention `encodeUrlMode`. That is true but understates the effect: in the default mode the whole inline query is decoded, so a `%26` splits a value.

Whichever `encodeUrl` value is set, the default mode also does this to the inline query:

- A `/` directly before `&`, `?` or `#` is removed: `/items/?a=1` is sent as `/items?a=1`, and `?a=x/&b=2` as `?a=x&b=2`.
- Runs of `/` collapse into one: `?a=//x` becomes `?a=/x`.
- A second `?` becomes `&`, so two query strings written one after the other join. An empty `?` is dropped.
- A literal `://` fails with `Invalid URL`, even when a `qs` is set.
- A raw character above U+00FF (such as `ž` or an emoji) fails with `Request path contains unescaped characters. URL: ...`, unless a `qs` directive with at least one value that is not `null` or `undefined` is also set. Latin-1 characters (up to U+00FF, such as `é` or `ü`) are sent percent-encoded as UTF-8. With `encodeUrl: false` an encoded character above U+00FF (`%C5%BE`) is decoded first, so it fails the same way.

```
url "/path?redirect=https://a.com"  ->  error "Invalid URL"
```

Put the value in `"qs": { "redirect": "https://a.com" }` instead.

**`uniform` mode.**

| | `encodeUrl: true` | `encodeUrl: false` |
|---|---|---|
| Path | Percent-encoded as in the default mode (`( ) $ : = & , ; + @ ! *` stay literal) | Sent as written. Only characters that are illegal in a URL (for example space, quotes, `<`, `>`, non-ASCII) are encoded |
| `%XX` already in the path | Encoded again | Kept as written |
| Inline query | Encoded like the path, so any existing `%XX` is encoded again | Sent as written. Only illegal characters are encoded |

`uniform` never turns a second `?` into `&`, never removes slashes in the query, keeps a trailing slash before `?`, and accepts `://` and non-ASCII characters in the query.

```json
{ "baseUrl": "https://x.com", "url": "/path?q=%value%", "encodeUrlMode": "uniform" }
```

This sends `?q=%25value%25`.

**Trailing slashes.** In the default mode a `/` directly before an inline `?`, `&` or `#` is removed. A slash at the very end of the URL, or before a query that comes from `qs`, is kept: `/v0/apps/{id}/collections/{id}/` is sent with its trailing slash, and `/items/` with `"qs": { "a": 1 }` gives `/items/?a=1`. `uniform` keeps the slash in all cases.

Apart from those rules Make neither adds nor removes a trailing slash, and some APIs treat `.../x` and `.../x/` as different resources (for example Adalo returns 400 on the `/` variant). Emit an optional trailing path segment conditionally instead of hardcoding the `/`:

```json
{ "url": "/items{{if(parameters.url, '/' + parameters.url, '')}}" }
```

### qs

`qs` adds a query string. Make evaluates it deeply, then serialises it:

- A top-level key whose value is `null` or `undefined` is removed.
- An empty string is sent as `key=`.
- Numbers and booleans become strings.
- A date becomes an ISO 8601 UTC string, also inside an array.
- A Buffer becomes an empty value.
- An array repeats the key without brackets (`a=1&a=2`). To get `ids[]=1&ids[]=2`, name the key `ids[]`; it is sent as `ids%5B%5D`. An empty array drops the key, and a `null` inside an array becomes an empty entry.
- A nested object is not expanded: it is sent as `key=`.
- `"qs": {}` is ignored.

Values are always percent-encoded, whatever `encodeUrl` and `encodeUrlMode` say. A space becomes `%20`, `+` becomes `%2B`, `&` becomes `%26`, `'` becomes `%27`, and non-ASCII characters become UTF-8 escapes. `! ( ) * ~` stay literal. A value that is already encoded is encoded again (`%25` becomes `%2525`).

```json
{ "qs": { "a": [1, 2], "d": "{{now}}", "n": null, "o": { "x": 1 }, "e": "", "q": "a b+c" } }
```

This sends `?a=1&a=2&d=2026-11-04T10%3A00%3A00.000Z&o=&e=&q=a%20b%2Bc`.

A query string written inside `url` and the `qs` directive are merged:

- Inline keys come first, in their original order, and duplicate inline keys are kept.
- New `qs` keys are appended after them.
- A `qs` key with the same name as an inline key replaces the inline value in place.
- When `qs` is non-empty, the inline query is decoded and encoded again, so `%41` becomes `A` and `+` becomes `%20`.

```json
{ "url": "http://x.com/p?a=1&a=2&b=0", "qs": { "b": "3", "c": "4" } }
```

This sends `/p?a=1&a=2&b=3&c=4`. `pagination.qs` follows the same rules.

### headers and method

`headers` rules:

- Header names are lower-cased. If two keys differ only by case, the last one wins.
- Values are evaluated as IML, one level deep.
- A value that resolves to `null` or `undefined` means the header is not sent. An empty string is sent as an empty header. Booleans and numbers are sent as strings.
- A value written as a JSON object or array literal is dropped.
- A `headers` directive that resolves to `null` or `undefined` (for example `"headers": null` or `"{{undefined}}"`) sends no app headers at all. That is a way to drop headers inherited from `base`.
- The whole directive may be one `{{...}}` that returns an object.

```json
{ "headers": { "X-Null": "{{null}}", "X-Flag": "{{false}}", "X-Zero": "{{0}}" } }
```

This sends `x-flag: false` and `x-zero: 0`, and no `x-null`.

`method` is evaluated as IML, is case-insensitive and defaults to GET. Only GET drops the body: a GET never sends a body and never gets a Content-Type derived from `type`, but a Content-Type set by the app is still sent. HEAD, DELETE, OPTIONS, POST, PUT and PATCH all serialise `body` when it is present.

### body and type

`type` is evaluated as IML and lower-cased, and defaults to `json`. The recognised values are `json`, `urlencoded`, `multipart/form-data`, `binary`, `text`, `string` and `raw`. Any other value (for example `form` or `multipart`) is treated like `text`. `body` is evaluated deeply before it is serialised.

```json
{ "type": "{{temp.type}}" }
```

What reaches the wire for `undefined`, `null` and `""` in an object body, `qs` or `headers`:

| Where | `undefined` (an unfilled parameter) | `null` | `""` |
|---|---|---|---|
| `json` body | key omitted | `"key": null` | `"key": ""` |
| `urlencoded` body (top-level key) | key removed | key removed | `key=` |
| `multipart/form-data` body | field skipped | field skipped | empty field |
| `text`, `string`, `raw` body (an object, sent as JSON) | key omitted | `"key": null` | `"key": ""` |
| `qs` (top-level key) | key removed | key removed | `key=` |
| `headers` | not sent | not sent | sent empty |

In an app with manifest version 2 or higher, `{{parameters.name}}` for a parameter the user left empty is `undefined`. In an app with manifest version 1 it is `null`, so a `json` body sends `"key": null` for it, and the other rows treat it as `null`. [Missing values](#missing-values) covers missing values in general.

The value of the whole `body` is a separate case:

| Type | Absent or `undefined` | `null` | `""` |
|---|---|---|---|
| `json` | no body | `null` | `""` (two quote characters) |
| `urlencoded` | no body | no body | no body |
| `multipart/form-data` | no body | no body | no fields (see below) |
| `binary` | no body | no body | no body |
| `text`, `string`, `raw` | empty body | empty body | empty body |

**`json` (the default)**

- The body is serialised as JSON. Keys whose value is `undefined`, such as unmapped parameters, are omitted. `null` and `""` are kept. A root array is kept.
- A direct mapping is therefore safe: unfilled fields drop out of the body without a `temp` step.

```json
"body": {
    "name": "{{parameters.name}}",
    "assigned_to_user": "{{parameters.assignedToUser}}"
}
```

If only `name` is set, the body sent is `{"name":"user value"}`, with no `assigned_to_user` key.

- A string body is sent JSON-quoted, so a JSON string taken from a parameter is double-encoded. Use type `text` with your own Content-Type, or parse the string first.

```json
{ "method": "POST", "type": "text", "headers": { "Content-Type": "application/json" }, "body": "{{parameters.rawJson}}" }
```

With `"type": "json"` and `"body": "{{parameters.rawJson}}"` the wire body is the quoted string `"{\"a\":1}"` instead.

- A falsy root body is sent literally: `""` as `""`, `0` as `0`, `false` as `false`, `null` or `{{null}}` as `null`. An absent or `undefined` body sends no body. The older HTTP client sends an empty body for the falsy values.
- The Content-Type is `application/json`, unless the app sets its own, which then wins. On every non-GET method this Content-Type is sent even when there is no body.

**`urlencoded`**

- An object body: top-level `null` and `undefined` keys are removed, an empty string becomes `key=`, and an array becomes a repeated key (`a=1&a=2`). A nested object or a date becomes an empty value (`key=`), so flatten nested data first and use `formatDate` for dates.
- Values are percent-encoded, and `! ' ( ) *` are encoded as well.
- A string body is sent verbatim, except that `! ' ( ) *` are percent-encoded. Spaces, `&` and non-ASCII characters are not encoded. A truthy number body is sent as its digits.
- A falsy body (absent, `null`, `""`, `0`, `false`) sends an empty body with no Content-Type, unless the app set one, in which case the app's value is sent as it is.
- With a body, the Content-Type is `application/x-www-form-urlencoded`. The app's own value is kept only when it starts with exactly the lower-case `application/x-www-form-urlencoded`, for example with `; charset=utf-8`. Any other app value is replaced.

```json
{ "type": "urlencoded", "body": { "a": 1, "tags": ["x", "y"], "n": null } }
```

This sends `a=1&tags=x&tags=y`.

**`multipart/form-data`**

- The body is an object, or an array of `{ "name", "value" }` entries. Use the array when field order matters.
- A field value can be a string, a number or boolean (sent as a string), a Buffer, or `{ "value", "options" }`. `options` is `{ "filename", "contentType" }`, or a plain string, which is taken as the filename. An array value sends the field once per element.
- `null`, `undefined`, nested objects without `value`, and dates are skipped silently. An empty string is an empty field.
- An array entry that is not exactly `{ name, value }`, or whose `name` is not a primitive, fails with RuntimeError `Invalid multipart/form-data body format.` followed by a line that names the problem.
- For any object or array body, including `{}`, the Content-Type is always `multipart/form-data; boundary=...`, and the app's own value is overwritten. A non-null falsy body (`""`, `0`, `false`) gets that Content-Type too but has no fields. An absent or `null` body sends no body and no multipart Content-Type.

```json
{
	"type": "multipart/form-data",
	"body": [
		{ "name": "file", "value": { "value": "{{parameters.data}}", "options": { "filename": "{{parameters.fileName}}" } } },
		{ "name": "tag", "value": ["a", "b"] }
	]
}
```

**`binary`**

- The body is sent as it is: a Buffer, a Uint8Array or a string. A zero-byte buffer is sent with `Content-Length: 0`.
- Make adds no Content-Type, and a Content-Type set by the app is kept, even when the body is empty or absent.

```json
{ "type": "binary", "headers": { "Content-Type": "application/octet-stream" }, "body": "{{parameters.data}}" }
```

**`text`, `string`, `raw`**

- A string is sent verbatim, so a body that already holds JSON is not double-encoded.
- A plain object or array is sent as JSON, with `null` kept and `undefined` omitted. A date is sent in ISO 8601 form, numbers and booleans as text, and a Buffer as its bytes.
- `null` or `undefined` sends an empty body, never the word `null` or `undefined`.
- Make never adds a Content-Type for these types. Set it in `headers`.

### timeout

The `timeout` directive sets how long a request may take. It is evaluated as IML and read as an integer number of milliseconds, and it can come from `base`. The public docs set it as `"timeout": "{{common.timeout}}"` in `base`, which works because `base` is merged into each request. Without a `timeout` directive, nothing is read from the common data and the default below applies.

- When `timeout` is missing, `0` or not a number, the timeout is 40000 ms (40 seconds).
- Make enforces no maximum. The public docs state a maximum of 300,000 ms; any cap would sit outside the runtime and cannot be confirmed here, so the platform may differ.
- The timer runs until the response headers arrive. After that the connection is closed only if no data arrives for the same length of time, so a body that keeps streaming is not cut off. A body that stalls for that long after the headers does not raise a timeout: the module continues with the status code and headers it received and an empty body (`{{body}}` is `null`).
- A request that times out fails with ConnectionError `ECONNABORTED: The service <origin><path> is temporarily unavailable or request has exceeded the allotted timeout.` The URL in the message never includes the query string. The older HTTP client words it `ESOCKETTIMEDOUT: The request to <url> has exceeded the allotted timeout.`, or `ETIMEDOUT: The service <url> is temporarily unavailable.` while it is still connecting.

```json
{ "timeout": 120000 }
```

### redirects

Make follows redirects by default, at most 10 per request. The limit cannot be configured, and it applies to every pagination round. The 11th redirect fails with RuntimeError `Maximum number of redirects exceeded` (error code `ERR_FR_TOO_MANY_REDIRECTS`).

Two directives switch following off. Both read a literal value and are not evaluated as IML, so `"{{false}}"` counts as true and disables nothing:

- `followRedirects` set to a falsy literal returns the 3xx response itself as a successful result. Its body is parsed, the `Location` header is in `{{headers.location}}`, and an empty 3xx body gives an `undefined` output.
- `followAllRedirects: false` (literal `false` only) does the same for POST, PUT, DELETE and PATCH, and returns the 3xx body. GET is still followed.

```json
{ "url": "/files/{{parameters.id}}", "method": "GET", "followRedirects": false, "response": { "output": { "downloadUrl": "{{headers.location}}" } } }
```

```json
{ "method": "POST", "followAllRedirects": false }
```

The public docs spell the directives `followRedirect` and `followAllRedirect` (singular). Make reads only the plural spellings, so a singular key changes nothing here. Whether the platform rewrites a singular key before the module runs cannot be confirmed here, so the platform may differ.

When a redirect is followed:

- A POST answered with 301 or 302, and any method except GET and HEAD answered with 303, is sent again as a GET without the body and the Content-* headers. 307 and 308 keep the method and the body.
- Authorization, Proxy-Authorization and Cookie are dropped when the redirect goes to another host that is not a subdomain of the current one, or from https to http.
- A 4xx or 5xx response with a `Location` header is not followed. It is an error like any other (see [Status code and headers](#status-code-and-headers)).
- Cookies set on one hop are not sent to the next hop unless `shareCookies` is on (see [runtime-reference/http-requests.md](runtime-reference/http-requests.md)).
- Every hop is checked like the first request. A redirect to a private or local address fails with InvalidConfigurationError `Connection denied because the destination address is considered unsafe. ... Details: Rejected HTTP redirect to "<ip>".`, and a hop outside `urlPermissions` fails with InvalidConfigurationError `Security policy violation: Network request blocked. The target URL is not allowed by the app's URL Permission Policy.` See [Private and local addresses](#private-and-local-addresses) and [urlPermissions](#urlpermissions).

## Handling the response

Make parses the response body by `response.type`. A status below 400 then continues with the response directives, and a status of 400 or more goes to `response.error`. When no response arrives, the module ends with an error typed by the network failure.

### response.type

`response.type` chooses how the body is parsed:

| Value | Result |
|---|---|
| `json` | The parsed JSON value |
| `xml` | A parsed object (see [XML responses](#xml-responses)) |
| `urlencoded` | An object of strings |
| `text`, `string`, `raw` | The body as a UTF-8 string (the three names mean the same) |
| `binary` | The raw byte buffer: `{{length(body)}}` gives the byte count |
| `automatic` | The parser is chosen from the response Content-Type |

- The value is case-insensitive and can be an IML expression, evaluated with `{{statusCode}}` and `{{headers}}` available.
- Any other string (for example `html`), or a missing, `null`, number or boolean value, acts as `automatic`.
- Text is always decoded as UTF-8. The charset in the Content-Type is ignored, so ISO-8859-1 bytes become U+FFFD replacement characters.
- A zero-length body is `null` for every type, and a body that does not parse raises DataError `Body is not a valid JSON. ...` or `Body is not a valid XML. ...` (see [Empty bodies and parse failures](#empty-bodies-and-parse-failures)).
- A `urlencoded` body becomes an object of strings. A repeated key becomes an array (`a=1&b=two&a=3` gives `{ "a": ["1", "3"], "b": "two" }`), `+` decodes to a space, and the number of keys is not limited.

```json
"response": { "type": "text", "output": { "raw": "{{body}}" } }
```

**`automatic`** (the default) picks the parser from the Content-Type:

| Content-Type | Parsed as |
|---|---|
| `text/plain` | string |
| `application/json`, `application/*+json` | JSON |
| `application/x-www-form-urlencoded`, `application/*+x-www-form-urlencoded` | object |
| `application/xml`, `application/*+xml`, `text/xml` | XML |
| `application/octet-stream`, zip, gzip, `x-rar-compressed`, `x-tar`, `x-7z-compressed`, pdf, msword, `vnd.ms-excel`, `vnd.ms-powerpoint`, anything starting with `audio`, anything containing `video`, `image` or `font` | binary |
| everything else | UTF-8 string |

Everything else includes a missing Content-Type (a JSON body without a Content-Type stays a string), `text/json`, `text/html`, `text/csv` and Office Open XML files (docx, xlsx, pptx). A file downloaded as a string is corrupted, so a file download needs `response.type` `binary`:

```json
"response": { "type": "binary", "output": { "data": "{{body}}", "fileName": "report.xlsx" } }
```

**Per status code.** `response.type` can also be an object keyed by status code:

- `"*"` matches any status. A single code (`"404"`) matches that status. A range (`"200-299"`) matches the statuses between its ends. An open range (`"400-"` or `"-499"`) means 400 to 499.
- When several keys match, the narrowest range wins. Keys that are neither `"*"` nor numeric are ignored. When no key matches, the body is parsed as `automatic`.
- Each value can be a type name or an IML expression.
- The mapping also parses error bodies before `response.error` runs, so `{{body}}` in `response.error` is already parsed with the type chosen for that status.

```json
"response": { "type": { "*": "json", "401": "text", "500-599": "text" }, "error": "[{{statusCode}}] {{body}}" }
```

```json
"response": { "type": { "*": "json", "200-299": "json" } }
```

### Empty bodies and parse failures

- A zero-length body is `{{body}}` = `null` for every `response.type` (json, xml and binary included), so an empty JSON body is not a parse error. That covers 204 No Content, a HEAD response and an empty 3xx returned when redirects are off.
- A JSON body is decoded as UTF-8 and parsed as standard JSON, so a scalar root works: `{{body + 1}}` on a body of `42` gives `43`.
- Invalid JSON fails the module with DataError `Body is not a valid JSON. <parser message>`. `response.error` cannot change this error, and `response.valid` and `response.output` never run.
- A UTF-8 byte-order mark at the start of the body is not stripped, so such a body fails to parse.
- Integers larger than 2^53 lose precision (XML keeps them as strings).

An error response whose body cannot be parsed hides the HTTP error. If the body of a 4xx or 5xx cannot be parsed with the chosen type (for example an HTML 502 page sent as `application/json`, or `response.type` `json` on a plain-text error), the module fails with DataError `Body is not a valid JSON. ...` or `Body is not a valid XML. ...` instead of the HTTP error. `response.error` is then not applied, and a 5xx does not become a ConnectionError. To keep the HTTP error, map the error statuses to `text`, or leave the type `automatic`:

```json
"response": { "type": { "*": "json", "500-599": "text" } }
```

### XML responses

Make parses XML strictly into an object keyed by the root element:

- Every child element is wrapped in an array. Read it with `[]` or `[1]`.
- Attributes go under `_attributes`.
- An element's text goes under `_value` when the element also has attributes. Otherwise the element is the plain value, and an empty element gives `""`.
- Text and attribute values are converted. Integers and decimals that survive the conversion become numbers (`"42"` becomes `42`, `"455.333"` becomes `455.333`), and `"true"` and `"false"` in any case become booleans.
- Values that start with `0` stay strings (`"007"`, `"0"`, `"0.5"`), and so do numbers that would change (`"445191262199889920"`, `"1e3"`, `"1.0"`).
- Malformed XML fails with DataError `Body is not a valid XML. <parser message>`.

```xml
<data><message>Hi</message><location type="city">Prague</location></data>
```

This body is parsed as:

```json
{ "data": { "message": ["Hi"], "location": [{ "_attributes": { "type": "city" }, "_value": "Prague" }] } }
```

```json
"response": {
    "output": { "name": "{{body.data.message[]}}", "kind": "{{body.data.location[]._attributes.type}}", "text": "{{body.data.location[]._value}}" }
}
```

### Status code and headers

- A status below 400 is a success, including a 3xx that is not followed. Make parses the body, and `response.temp`, `response.valid`, `response.iterate`, `response.output` and `pagination` run.
- A status of 400 or more is an error. Make still parses the body (with the `response.type` for that status) and evaluates `response.error` with `{{body}}`, `{{headers}}` and `{{statusCode}}`. `response.temp`, `valid`, `iterate`, `output` and `pagination` do not run, so values that `response.temp` would set are not there for `response.error`.
- Unless `response.error` sets a type, a 429 becomes RateLimitError `Third party API limit likely exceeded`, 500 to 599 become ConnectionError `Service is temporarily unavailable.`, and every other status of 400 or more becomes RuntimeError `Status Code Error: <code>`.

See [error](#error) for the directive.

```json
"response": {
	"error": {
		"message": "[{{statusCode}}] {{body.error.message}}",
		"401": { "type": "InvalidAccessTokenError", "message": "{{body.error.message}}" }
	}
}
```

After each response, these variables are set:

- `{{statusCode}}` is a number and `{{statusMessage}}` is the reason phrase (for example `OK`).
- `{{headers}}` holds the response headers with lower-case names, so use `{{headers['x-total-count']}}`. `set-cookie` is always an array. Other repeated headers arrive as one comma-joined string, except single-value headers such as `content-type` and `location`, where only the first value is kept.
- `{{body}}` is the parsed body.
- After redirects they describe only the final response.
- When an error body is plain text, any sub-path such as `{{body.error.message}}` resolves to the whole text.
- When no response arrives (a timeout, a DNS or connection failure) none of them exist, and `response.error` is not applied (see [When no response arrives](#when-no-response-arrives)).

```json
"pagination": { "condition": "{{pagination.page <= headers['x-totalpages']}}" }
```

### When no response arrives

When there is no HTTP response, Make types the error by the network error code, and `response.error` is never applied, because there is no status or body to format.

- ESOCKETTIMEDOUT, ECONNABORTED, ETIMEDOUT, ECONNRESET (including a `socket hang up`), ECONNREFUSED, ENOTFOUND, EAI_AGAIN, EHOSTUNREACH, ENETUNREACH and EACCES all become ConnectionError. There is no separate timeout type.
- The message is `<CODE>: The service <origin><path> is temporarily unavailable.` Three codes differ: ECONNABORTED adds `or request has exceeded the allotted timeout`, ESOCKETTIMEDOUT reads `The request to <url> has exceeded the allotted timeout.`, and EACCES reads `EACCES: Can't connect to <origin><path>.`
- A `socket hang up` without a code becomes ConnectionError `socket hang up`.
- The URL is the one being requested when the request failed (after redirects), cut to origin and path. The query string never appears. A URL that cannot be parsed shows as `[redacted-invalid-url]`.
- Any other failure (for example a TLS protocol error such as EPROTO) becomes RuntimeError with the raw message.

**DNS.** Host names are resolved to IPv4 addresses only, so a host that has only IPv6 addresses cannot be reached.

- A name that does not exist fails with ConnectionError `The server "<host>" could not be found. This address does not exist or does not point to any server. Check that the host is spelled correctly. If it is, ask the server administrator to check that the address is set up correctly. (ENOTFOUND)`.
- A DNS server that does not answer fails with ConnectionError `The server "<host>" could not be found right now, because the service that translates the address to a server did not respond. This is usually temporary. Try again later. (EAI_AGAIN)`. Other DNS codes keep the raw message.
- If any resolved address is private, local or reserved, the whole request fails with InvalidConfigurationError `Connection denied because the destination address is considered unsafe. ... Details: Rejected DNS record with unsafe IP address "<ip>".` A name with no addresses fails with `... Details: No DNS records found.` See [Private and local addresses](#private-and-local-addresses).
- With local access granted (`flags.localAccess` or `scenario.localAccess`) there is no address check, and a missing host gives the generic `ENOTFOUND: The service <url> is temporarily unavailable.`

**TLS certificate errors.** With certificate validation on (the default), a bad server certificate (expired, not yet valid, self-signed, self-signed in the chain, issued by an unknown CA, an incomplete chain, a wrong host name, or any other X.509 verification failure) fails the module with RuntimeError, not ConnectionError, so it is not treated as temporary. The message is:

```
Blocked the insecure HTTPS connection.

The module tried to connect to <origin>, but the destination server's TLS certificate returned an error: <CODE>.

<fix hint>

Learn what this error means and how to fix it:
https://developers.make.com/custom-apps-documentation/other/fix-https-certificate-errors-in-scenarios
```

It shows only the origin. The hint is specific for `DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`, `CERT_HAS_EXPIRED`, `ERR_TLS_CERT_ALTNAME_INVALID`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` and `UNABLE_TO_VERIFY_LEAF_SIGNATURE`; for other codes the system's own message is shown. With `rejectUnauthorized: false` the request succeeds instead, and action and trigger modules end with a Warning `Insecure HTTPS connection detected. ...` (see [What ends a run early](#what-ends-a-run-early) and [runtime-reference/http-requests.md](runtime-reference/http-requests.md)).

### No retries and no size limit

- Make does not retry a failed HTTP request inside a module run. That includes TLS errors: only the older HTTP client, if the host selects it, repeats a request once, immediately, when it fails with `EPROTO ... SSL alert number 40`.
- Errors are only classified. ConnectionError (timeouts, network errors, 5xx) and RateLimitError (429) are the types the platform treats as temporary: any retry or backoff happens outside the module. RuntimeError (certificate errors, other 4xx) and DataError (parse failures) are not.
- Make sets no size limit on a response. The whole body is loaded into memory before it is parsed, for every `response.type` including `binary`. Any platform limit on output size is applied outside this step.

## IML expressions

IML expressions are the `{{...}}` templates inside directives. This part covers how a missing value and an array index resolve, the built-in variables, how Make evaluates a directive that holds an object, and the timezone of date functions. Which roots (`parameters`, `connection`, `data`, `metadata`, `webhook`, `payload` ...) a component can read, and what custom IML function code can see, is in [runtime-reference/iml-context.md](runtime-reference/iml-context.md). The IML engine is supplied by the Make platform, so edge cases follow the platform's engine version.

### Missing values

A path that does not exist resolves to an empty value, and which empty value depends on the manifest version of the app. A path does not exist when it is an unfilled parameter, a missing key, an out-of-range index, `[0]`, or a non-numeric key on an array.

| Case | Manifest 1 | Manifest 2 or higher |
|---|---|---|
| A path that does not exist | `null` | `undefined` |
| A path that passes through an existing `null` | `null` | `null` |
| A built-in function given a missing value, for example `upper(parameters.x)` | `null` | `undefined` |
| A missing value passed as an argument of a custom function | `null` | `undefined` |
| An argument left out of the call | `undefined` | `undefined` |

The same switch applies to the built-in functions called inside custom function code (`iml.upper(...)`).

What follows from it:

- Manifest 1: an unfilled `{{parameters.x}}` is `null`. A `temp` merge keeps the `null` (`null` overwrites), and a JSON body sends `"x": null`.
- Manifest 2 or higher: an unfilled `{{parameters.x}}` is `undefined`. A `temp` merge keeps the key holding `undefined` (the key is not dropped from `temp`), but `undefined` never overwrites a value that `temp` already holds. Only the JSON serialisation of a body leaves the key out.
- Inside text, a missing value renders as nothing: `a{{parameters.x}}b` is `ab` in both versions.

```json
{ "body": { "name": "{{parameters.name}}", "description": "{{parameters.description}}" } }
```

With only `name` filled, the body is `{"name":"x","description":null}` in manifest 1 and `{"name":"x"}` in manifest 2 or higher. See [temp and response.temp](#temp-and-responsetemp) for the merge rules and [body and type](#body-and-type) for how each body type sends `undefined`, `null` and `""`.

### Paths and 1-based indexes

Array indexes in IML paths are 1-based, not 0-based like JavaScript. This trips up most reviewers at least once.

| IML path | Reads | Notes |
|---|---|---|
| `foo[]` | the first element | Empty brackets mean index 1. |
| `foo[1]` | the first element | |
| `foo[2]` | the second element | |
| `foo[3].bar` | `bar` of the third element | |
| `foo[0]` | nothing: `null` in manifest 1, `undefined` in manifest 2 or higher | Common bug: `[0]` is never what you want. |
| `foo[-1]`, an index past the end | nothing, the same as `foo[0]` | |

Details of path syntax:

- A bare numeric segment is 1-based too: `{{body.items.2.id}}` is the id of the second item. A fractional index is cut to its integer part, so `items[2.9]` reads the second element.
- On an object (not an array) a numeric segment or bracket is just the key as written: `{{obj.1}}` and `{{obj[1]}}` read the key `"1"`, with no shift.
- The bracket can hold an expression. Make evaluates it first and then applies the same 1-based rule: `{{items[idx]}}`, `{{items[idx - 1]}}`, `{{items[floor(1 + 1)]}}`. When `idx` is 0 the result is empty. Nested braces inside the brackets, as in `{{items[{{idx}}]}}`, are not an index expression and fail with `Invalid AST!`.
- A key that contains dots is written in backticks: ``{{body.`odata.count`}}``. A doubled backtick is a literal backtick. A backtick-wrapped number is the same 1-based segment, so `` items.`2`.id `` is the second item's id. A debug dump of a path may show `` foo.`1` ``: that is the same access as `foo[]` and `foo[1]`.
- A non-numeric key on an array does not map over it: `{{body.items.id}}` is empty. Use `map()` or `response.iterate` to collect a field.
- The keys `prototype`, `constructor`, `__proto__` and `__super__` always resolve to empty.
- Reading a sub-key of a plain string or number returns the value itself: `{{parameters.name.foo}}` with `name` set to `"abc"` gives `"abc"`.

```json
{
	"response": {
		"output": {
			"count": "{{body.`odata.count`}}",
			"firstId": "{{body.items[].id}}",
			"secondId": "{{body.items[2].id}}"
		}
	}
}
```

**Implications for `response.output`, `response.iterate` and the other directives.**

- `{{body.items[].id}}` returns one scalar: the `id` of the first item. It does not iterate or collect.
- `{{body.items[1].id}}` is identical to the line above (both read item 1).
- To iterate all items of a response, use `response.iterate` with `{{body.items}}`. Never rely on `[]` to produce a collection.
- For an action that uploads or creates a single entity and whose API returns a one-element array (for example Google Photos `mediaItems:batchCreate` with `newMediaItemResults`), `{{body.newMediaItemResults[].mediaItem}}` is the correct way to unwrap the single result into a scalar output. It is not an array wrap.

**Takeaways for code review.**

- Flag any `{{...[0]...}}` in IMLJSON as a bug, unless the reviewed intent is specifically to return an empty value.
- `foo[]` is not a bug and not an accidental array wrap. It is the idiomatic way to pick the first element out of a single-result array.
- When a module outputs `{{body.results[].field}}`, the output is a scalar that matches an interface field of type `text`, `number` or an object. It is not an array. Do not ask for it to be "unwrapped".

### Built-in variables and keywords

These variables work in every expression:

| Name | Value |
|---|---|
| `now` | the current date |
| `timestamp` | the current Unix time in seconds |
| `uuid` | a random version 4 UUID |
| `random` | a random number from 0 up to 1 |
| `pi` | the number pi |

`uuid` and `random` come from a generator that is not cryptographically secure, so do not use them for secrets.

These keywords are reserved too:

| Keyword | Value |
|---|---|
| `true`, `false` | the booleans |
| `null` | `null` |
| `erase` | `null` (alias of `null`) |
| `undefined` | `undefined` |
| `ignore` | `undefined` |
| `space`, `nbsp`, `tab`, `newline`, `carriagereturn` | the text of that character |
| `emptystring` | an empty text that stays distinct from the empty value |
| `emptyarray`, `erasearray` | a new empty array on every use |

The built-in variables and keywords take precedence over context data. A top-level root with one of these names cannot be read by that bare name: `{{now}}` is the current date even when the context holds a root called `now`. They come from the platform's IML engine, not from the app.

```json
{ "temp": { "jwtClaims": { "iat": "{{timestamp}}", "jti": "{{uuid}}" } } }
```

### Directive objects and expression types

When a directive value is an object (`body`, `temp`, `headers`, `response.output` and so on), Make evaluates it key by key:

- A key that contains `{{...}}` is evaluated, and the result becomes the key name.
- A key written exactly `{{...}}` spreads the object it evaluates to into the parent. The order of the keys decides: a key written after the spread overrides a spread key of the same name, and a spread overrides a key written before it.
- A string that is a single `{{...}}` keeps the type of the result (object, array, number, boolean). Text around the expression makes the result a string.
- A literal `null` inside the object stays `null`. Numbers and booleans pass unchanged, and `""` stays `""`.
- An object or array written in the directive more than 10 levels below the directive's own object is replaced by `undefined` and so dropped. This limit applies only to structure written in the directive. An object that a `{{...}}` expression returns whole is kept intact.

```json
{
	"body": {
		"name": "{{parameters.name}}",
		"{{parameters.customKey}}": "{{parameters.customValue}}",
		"{{...}}": "{{parameters.extraFields}}"
	}
}
```

A directive that is evaluated as an object (the table below) and whose own value is falsy (`""`, `0`, `false`, `null`) evaluates to nothing. When its own value is an array, it is dropped (it evaluates to `undefined`) unless that directive accepts a root array. A directive that expects one expression (`url`, `condition`, `timeout`) is evaluated as a single expression instead: a string is evaluated, a number, a boolean or `null` passes through unchanged, and an object or array there evaluates to `undefined`.

Which directives are evaluated deeply and which accept a root array:

| Directive | Evaluated | Root array |
|---|---|---|
| `body`, `qs`, `pagination.body`, `pagination.qs` | deeply | accepted |
| `response.output`, `response.wrapper`, `condition.default` | deeply | accepted |
| `temp`, `response.temp`, `response.data`, `response.metadata`, the per-element mapping of `response.iterate` | deeply | ignored (evaluates to nothing) |
| `headers`, `pagination.headers`, `aws`, `oauth` | one level only: a nested object or array value becomes `undefined` | ignored (evaluates to nothing) |

### Timezone in templates

Date functions in a `{{...}}` template (`formatDate`, `parseDate` and the others) use the timezone of the scenario when you pass no timezone argument. Make parses each distinct expression text once per worker and reuses the result for that exact text. The scenario timezone is taken when the text is first parsed and is not read again. A later scenario in another timezone that evaluates the identical expression text in the same worker therefore gets the timezone of the first scenario.

Pass the timezone to the date function explicitly to avoid this:

```json
{ "qs": { "since": "{{formatDate(parameters.since; 'YYYY-MM-DD'; environment.timezone)}}" } }
```

Custom IML functions are not affected. Their `iml.*` date functions use the timezone of the module instance. See [runtime-reference/environment-variables.md](runtime-reference/environment-variables.md) for what `environment` holds.

## Runtime IML functions

Make adds the helpers below to the built-in IML functions in every component. They work in `{{...}}` templates. Four of them can also be called from custom function code as `iml.<name>`; the rest are templates only (see the table in the next section). Which built-in functions exist is not repeated here.

### Which function wins a name

The order, from lowest to highest priority:

1. The built-in IML function.
2. An app custom function of the same name. It replaces the built-in: an app function called `upper` is used instead of the built-in `upper`.
3. The runtime helper of the same name. It replaces an app function: an app function called `jwt` is never called.

The runtime helpers are `jwt`, `generateJwtWithKeyId`, `mime`, `cryptoSign`, `toDataStructure`, `parseJSON`, `createJSON`, `createXML`, `parseXML`, `safeSerialize`, `errorFactory`, `pop`, `shift`, `isArray`, `parseZapierParameters`, `parseZapierOptions`, `parseZapierInterface` and `getFieldMapping`. They exist in every component, also when the app defines no custom functions.

Errors:

- An unknown name fails with `Function '<name>' not found!`.
- An error thrown by a function fails with `Function '<name>' finished with error! <message>`.

Which helpers custom function code can call:

| Helper | In custom function code |
|---|---|
| `jwt`, `generateJwtWithKeyId`, `mime`, `toDataStructure` | yes, as `iml.jwt`, `iml.generateJwtWithKeyId`, `iml.mime`, `iml.toDataStructure` |
| `cryptoSign`, `errorFactory`, `parseJSON`, `createJSON`, `createXML`, `parseXML`, `safeSerialize`, `getFieldMapping`, `pop`, `shift`, `isArray`, `parseZapierParameters`, `parseZapierOptions`, `parseZapierInterface` | no, templates only |

Custom function code can also call every built-in IML function as `iml.<name>`. The limits of a custom function call are in [Limits](#limits), and what its code can see is in [runtime-reference/iml-context.md](runtime-reference/iml-context.md).

### jwt and generateJwtWithKeyId

**`jwt(payload, secret, alg = "HS256", options = {})`** returns a signed JWT string.

- The default algorithm is `HS256`. `options.algorithm` overrides the `alg` argument.
- No `iat` claim is added by default. An `iat` already in the payload stays. Setting `options.noTimestamp` to `false` adds `iat` with the current time.
- Only these option keys are used, and Make silently drops all others: `expiresIn`, `notBefore`, `audience`, `algorithm`, `header`, `encoding`, `issuer`, `subject`, `jwtid`, `noTimestamp`, `keyid`, `mutatePayload`, `allowInsecureKeySizes`, `allowInvalidAsymmetricKeyTypes`.
- `expiresIn` adds `exp` from the current time, even without `iat`.
- A string payload fails with `invalid noTimestamp option for string payload`, because of the `noTimestamp` default.
- An RSA key under 2048 bits fails with `secretOrPrivateKey has a minimum key size of 2048 bits for RS256` (the algorithm name varies), unless `allowInsecureKeySizes: true` is set.
- The header is `{"alg": ..., "typ": "JWT"}`, in that key order.
- Available in templates and as `iml.jwt` in custom functions.

```json
{ "headers": { "authorization": "Bearer {{jwt(temp.claims; connection.privateKey; 'RS256'; temp.jwtOptions)}}" } }
```

**`generateJwtWithKeyId(payload, hmacKey, jwtAlg = "HS512", thumbprintAlg = "HS256", options = {header: {}})`** signs an HMAC JWT and adds a `kid` header.

- Both algorithms must start with `HS`, otherwise it fails with `Unrecognized algorithm provided; jwtAlg=<a>, thumbprintAlg=<b>`.
- `kid` is the base64url SHA hash of the compact JSON text `{"k":"<base64url key>","kty":"oct"}` (no spaces). The hash size is the bit size of `thumbprintAlg` (`HS256` gives SHA-256). The key is zero-padded to `jwtAlg` bits divided by 8 bytes when it is shorter than that, and never cut when it is longer.
- Unlike `jwt()`, an `iat` claim is added by default, and `options` are not filtered: they go to the signer as given, so `noTimestamp: true` leaves `iat` out, and an unknown option fails with `"foo" is not allowed in "options"`.
- The header holds `alg`, `typ` and `kid` (plus any key of `options.header`). Make computes the `kid` once per key and algorithm pair and reuses it, and writes it into the `options.header` object you pass.
- Available in templates and as `iml.generateJwtWithKeyId` in custom functions.

```json
{
	"temp": { "claims": { "iss": "{{connection.clientId}}" } },
	"headers": { "authorization": "Bearer {{generateJwtWithKeyId(temp.claims; connection.secret)}}" }
}
```

### cryptoSign

**`cryptoSign(algorithm, data, key, outputEncoding = "hex")`** returns the signature of `data`, made with the private key `key` and the digest or algorithm name `algorithm` (for example `RSA-SHA256` or `RSA-SHA512`). The signature is encoded as `hex` by default, or as another encoding such as `base64`.

- `algorithm` must be a non-empty string, otherwise it fails with `invalid algorithm '<x>' provided`.
- `key` must be a non-empty string, typically a PEM private key, otherwise it fails with `invalid private key provided`. A key that cannot be read fails with the system's own message.
- `data` is a string or binary data (a Buffer or array buffer is signed as its bytes). A number or `null` fails.
- An unknown algorithm or output encoding fails with the system's own message.
- Templates only: `cryptoSign` is not available inside custom functions.

```json
{ "headers": { "x-signature": "{{cryptoSign('RSA-SHA256'; temp.stringToSign; connection.privateKey; 'base64')}}" } }
```

### mime, toDataStructure and the JSON and XML helpers

**`mime(fileNameOrExtension)`** returns the MIME type for a file name or extension: `mime("image.jpg")` is `image/jpeg`, and a bare extension such as `png` or `.png` works too. It returns `undefined` when the extension is unknown. Also available as `iml.mime` in custom functions.

**`toDataStructure(data, type = "json")`** builds a Make data-structure spec (an interface array) from sample data. Also available as `iml.toDataStructure` in custom functions.

- `json` takes a JSON string or an object. `toDataStructure('{"a": 1}')` is `[{"name": "a", "type": "number"}]`.
- `form` takes a URL-encoded string. Each key becomes a `text` field, and a repeated key becomes an `array` of `text`. An empty value gives `[]`.
- `query` does the same and also accepts a full URL (it uses the part after `?`).
- `xml` always fails when called from IML with `Failed to generate data structure. Invalid XML.`
- Any other type, including `JSON` in capitals, fails with `Unsupported format.`
- Invalid JSON text, and an empty string, fails with `Failed to generate data structure. Invalid JSON.` A `null` or `undefined` value gives `[]`.

How a JSON value maps to a field type:

| Value | Field type |
|---|---|
| string or `null` | `text` |
| number | `number` |
| boolean | `boolean` |
| Date | `date` |
| Buffer | `buffer` |
| object | `collection`, with a nested spec |
| array | `array`, with a spec built from its first element only |

Rules for the mapping:

- For an array, an object element becomes `{type: collection, spec: [...]}` and a primitive element `{type: text}`, `{type: number}` or `{type: boolean}`. A first element that is empty, `0`, `""`, `false` or `null` (and an empty array) leaves the spec `undefined`.
- For a top-level array, only the first element is used. A top-level primitive returns a single `{type: ...}` object instead of an array. `0`, `false`, `null` and `undefined` give `[]`.
- When the argument is JSON text, ISO strings of exactly the form `YYYY-MM-DDTHH:mm:ss.sssZ` become type `date`. The same string inside an object argument stays `text`.
- No labels are generated.

```json
{ "response": { "output": { "spec": "{{toDataStructure(body)}}", "type": "{{mime(parameters.fileName)}}" } } }
```

`toDataStructure('a=1&b=2&b=3'; 'form')` is `[{"name": "a", "type": "text"}, {"name": "b", "type": "array", "spec": {"type": "text"}}]`.

**JSON helpers.** `parseJSON(text)` parses JSON, and invalid text fails. `createJSON(value)` stringifies a value.

**XML helpers.**

- `createXML(object)` returns pretty-printed XML with a `<?xml version="1.0"?>` declaration and a 2-space indent. Attributes are `@name` keys and element text is `#text`.
- `parseXML(text)` returns an object with attributes as `@name`, element text under `#` (not `#text`), and repeated elements as arrays.

```json
{ "response": { "output": { "xml": "{{createXML(temp.doc)}}" } } }
```

`parseXML('<root id="1">hi<item>a</item><item>b</item></root>')` is `{"root": {"@id": "1", "#": "hi", "item": ["a", "b"]}}`.

**Array helpers.**

- `pop(array)` and `shift(array)` return the last and the first element and remove it from the referenced array itself, so the source value (in `temp`, `parameters` and so on) changes too. A value that is not an array gives nothing.
- `isArray(value)` returns a boolean.

### errorFactory

**`errorFactory(name, message)`** returns a new error object of the named Make error type with that message. It does not throw the error. These 20 names are allowed: `DataError`, `UnknownError`, `RuntimeError`, `InconsistencyError`, `RateLimitError`, `OutOfSpaceError`, `ConnectionError`, `InvalidConfigurationError`, `InvalidAccessTokenError`, `UnexpectedError`, `MaxResultsExceededError`, `MaxFileSizeExceededError`, `IncompleteDataError`, `DuplicateDataError`, `ModuleTimeoutError`, `ScenarioTimeoutError`, `OperationsLimitExceededError`, `DataSizeLimitExceededError`, `ExecutionInterruptedError` and `Warning`.

Any other name fails with `Function 'errorFactory' finished with error! Invalid error type.` Templates only: `errorFactory` is not available inside custom functions.

### getFieldMapping and safeSerialize

**`getFieldMapping(fieldName)`** returns how the scenario user mapped a module field: `{mapping, values}`. `mapping` is the raw mapping text and `values` maps each referenced item to its current value. For a field mapped to `Hello {{1.name}}` the result is `{mapping: 'Hello {{1.name}}', values: {'1.name': 'World'}}`.

- It returns `null` for an unknown or unmapped field, when the platform provides no mappings (an older platform), and when resolving that one field failed.
- Make resolves the mappings of every field before the run starts, so they are fresh for each run. If the platform cannot list the fields at all, the run fails with that error.
- Available in action, search, trigger, RPC and Endpoint templates. Templates only.

**`safeSerialize(value)`** returns a string in a compact reference-table format, not plain JSON, that keeps Date, `undefined` and Buffer values. A Buffer is stored as base64. The receiver must decode the string with a compatible parser. Templates only.

| Value | Result |
|---|---|
| `42` | `[42]` |
| `"hello"` | `["hello"]` |
| `{a: 1, b: "x"}` | `[{"a":1,"b":2},1,"x"]` |
| a Date | `[["Date","2024-01-15T12:01:02.003Z"]]` |
| the Buffer `"hello"` | `[["Buffer",1],"aGVsbG8="]` |

```json
{ "body": { "mappings": "{{safeSerialize(getFieldMapping('task'))}}" } }
```

### Zapier conversion helpers

Three legacy helpers convert Zapier field definitions. They are templates only.

**`parseZapierParameters(list)`** maps each `{key, label, required, type_of, help_text, default, choices, list, prefill}` to a Make parameter:

| `type_of` | Make type |
|---|---|
| `int` | `integer` |
| `bool` | `boolean` |
| `unicode` | `text`, or `select` with the parsed `choices` as options (`multiple: true` when `list` is `true`) |
| `text` | `text` with `multiline: true` |
| `float` | `number` |
| `datetime` | `date` |
| `dict` | `collection` |
| `file` | `file` |
| `password` | `password` |

`key` becomes `name`, and `label` and `required` are copied. `help_text` becomes `help` and `default` is kept, each only when set. `prefill: "x.y"` makes the parameter a `select` whose options are `rpc://x` (the part before the first dot). A `type_of` not in the table leaves the type unset.

**`parseZapierOptions(text)`** parses a list written as `v1|Label 1,v2|Label 2` into `[{label, value}]`: `[{"label": "Label 1", "value": "v1"}, {"label": "Label 2", "value": "v2"}]`.

**`parseZapierInterface(list)`** returns `[{name: key, type}]`, reading the type from each item's `type` field. The mapping is the one of the table above, with `unicode` and `text` both giving `text`. An unknown type gets no `type`.

## Limits

Make enforces the limits below. Where a row says "read, not enforced", the value is read but nothing stops on it.

| Limit | Default | Set with | Notes |
|---|---|---|---|
| `maxRequestCount` | 100 | `maxRequestCount` in the app's common data | Read, not enforced: nothing in the runtime stops on it, for requests or pagination. The public docs describe 100 requests for all requests of one module; a platform-level cap cannot be ruled out, so the platform may differ. |
| `maxPaginationRequestCount` | 50 extra requests after the first, so 51 requests in total | `maxPaginationRequestCount` in the common data | Enforced. Paging stops after this many extra requests. |
| `maxPastRecords` | 3200 raw items | `maxPastRecords` in the common data | Enforced for every module type, not only triggers. It counts the raw items that pass through `response.iterate`, before `iterate.condition`, so it never fires without `response.iterate`. The page that crosses the line is kept whole. `0` stops paging after the first page. |
| Request timeout | 40000 ms | the `timeout` directive (IML, an integer in milliseconds) | Missing, `0` or non-numeric gives 40000. The runtime enforces no maximum. The public docs state 300 s; the platform may differ. A request that times out fails with ConnectionError (messages in [timeout](#timeout)). |
| Redirects | 10 | none | Fixed, cannot be configured. `followRedirects: false` follows none. See [redirects](#redirects). |
| `repeat.limit` (or `while.limit`) | 1000 | `repeat.limit`, not evaluated as IML | Used when the value is missing or `0`. There is no cap. The block runs up to limit + 1 times, then fails with RuntimeError "Maximum number of repeats exceeded." A scenario stop or module timeout ends the loop with the last result instead of this error (see [What ends a run early](#what-ends-a-run-early)). See [repeat](#repeat). |
| Pagination `limit` variable | 20 on page 1, then 100, then 500 | none | Pages start at page 1, offset 0, limit 20. When paging continues, `limit` becomes min(limit x 5, 500). |
| `pagination.delay` | 0 | `pagination.delay` (IML) | Clamped to 0 to 30000 ms. |
| Unordered trigger memory | `maxPastRecords` (3200) | `maxPastRecords` | 5000 only when `maxPastRecords` is set to `0`. |
| Module `data` | 65,536 bytes (about 64 KB) | none | The size is an estimate that adds overhead per value, so the usable JSON payload is somewhat smaller. A larger result fails with RuntimeError "Error processing module data. 'data' collection is too big." |
| Custom IML function call | 10 s in production, 50 ms in development and test environments | none | A call that runs longer fails. |
| Custom function sandbox memory | 2048 MB | none | |
| Inline Endpoint calls | 100 per run | none | The 101st call fails with RuntimeError "Maximum number of endpoint calls (100) exceeded." See [runtime-reference/inline-endpoint-calls.md](runtime-reference/inline-endpoint-calls.md). |
| Trigger `limit` | 1 | `response.limit` (usually mapped to `{{parameters.limit}}`) | The default of 1 applies to ordered triggers only. An unordered trigger has no default; a `response.limit` you set still cuts its result, but does not stop paging. |

The public docs describe 3200 as a cap on the records a trigger returns. Here it is a pagination stop: once 3200 raw items have come through `response.iterate`, no further page is requested, but the page that crossed the line is kept whole. What a polling trigger emits per run is set by `response.limit`.

## Security

Two checks apply to every HTTP request Make sends for a component: the address check (private and local destinations are refused) and the app's own `urlPermissions`. Both run before any data is sent. Neither applies to `isc` calls (see [runtime-reference/isc.md](runtime-reference/isc.md)) or to the agent's fetch of the connected-system inputs (see [runtime-reference/on-prem-agent.md](runtime-reference/on-prem-agent.md)).

### Private and local addresses

Make refuses requests to private, loopback, link-local and other non-public addresses. That covers the private IPv4 ranges (10.x.x.x, 172.16.x.x to 172.31.x.x, 192.168.x.x), loopback (127.x.x.x and `::1`), link-local (169.254.x.x, which includes the cloud metadata address) and the IPv4-mapped IPv6 forms of those. The refusal is lifted only by local access. Make grants local access to a scenario (`scenario.localAccess`) or to an app (`flags.localAccess`); the app author cannot grant it in the IMLJSON. With local access there is no address check at all.

The check runs in three places:

- **An IP literal in the URL.** It fails with InvalidConfigurationError `Connection denied because the address "<ip>" points to a private or local network...`.
- **A host name.** Make resolves it to IPv4 addresses only and checks every address of the answer. If any address is unsafe, the whole request fails with InvalidConfigurationError `Connection denied because the destination address is considered unsafe. ... Details: Rejected DNS record with unsafe IP address "<ip>".` A name with no addresses fails with `... Details: No DNS records found.` The connection then goes to exactly the checked addresses, so a second lookup cannot return another address. A failed lookup fails with ConnectionError, with the DNS code (for example `ENOTFOUND`) as `code`. For `ENOTFOUND` the message starts `The server "<host>" could not be found.` and ends with the code in parentheses. A host with only IPv6 records cannot be resolved.
- **Every redirect target.** A redirect to an unsafe IP literal fails with InvalidConfigurationError `Connection denied because the destination address is considered unsafe. ... Details: Rejected HTTP redirect to "<ip>".` and the redirected request is not sent. A redirect to a host name goes through the host name check above, so one that resolves to an unsafe address fails with the `Rejected DNS record ...` message instead. A relative redirect path is allowed.

More details:

- With the default `encodeUrl`, an IPv6 literal URL such as `http://[2001:db8::1]/` fails with `Invalid URL`, for public addresses too.
- After an `execute` request through the on-premise agent, private addresses stay allowed for the rest of that run. An `inputs` request does not lift the address check.
- The check applies to modules, RPCs, Endpoints, webhook calls and connections.
- With local access granted, a host that does not exist gives the generic `ENOTFOUND: The service <url> is temporarily unavailable.` See [When no response arrives](#when-no-response-arrives) and [runtime-reference/on-prem-agent.md](runtime-reference/on-prem-agent.md).

### urlPermissions

`urlPermissions` limits which URLs an app may call. It is a literal list of URL match patterns; Make does not evaluate IML in it. Each check uses the `urlPermissions` of the `api` block being run, so a block with none is not restricted. Whether a connection or webhook picks up the list from the base depends on how the platform merges the base, so set it explicitly on each.

```json
{ "urlPermissions": ["https://api.example.com/*", "https://api.example.com:8443/*"] }
```

Values:

| Value | Result |
|---|---|
| missing, `null`, `false`, `""` (any falsy value) | no restriction |
| `[]` | every request is blocked |
| a list of patterns | a request is sent only when its URL matches one of them |
| any other value that is not an array | fails, even when the component makes no request |

A component that builds no request URL is not checked, apart from the non-array failure above. Pattern errors are raised only when a request URL exists.

Errors, all InvalidConfigurationError unless noted:

- A value that is not an array: `Invalid URL Permission Policy - non-array value. This indicates an invalid "urlPermissions" directive in the Application, not an issue in the scenario.`
- Make validates all patterns before matching, so one invalid pattern fails the request even when another pattern would match: `Invalid URL Permission Policy pattern - non-string value. ...` and `Invalid URL Permission Policy pattern "<p>". ...` (same ending as above).
- A URL that matches no pattern is not sent: `Security policy violation: Network request blocked. The target URL is not allowed by the app's URL Permission Policy.`
- A request URL that cannot be parsed fails with RuntimeError `Security policy violation: Request blocked. Not possible to validate URL against URL Permission Policy. Details: Malformed request URL "<url>". <reason>`

Pattern syntax is the match-pattern form of browser extensions, `<scheme>://<host>[:<port>]/<path>`, with `*` as a wildcard:

- `https://api.example.com/*` allows one host and any path. `*://*.example.com/*` allows any scheme and any subdomain. `<all_urls>` and `*://*/*` allow everything.
- A pattern needs a path part. A host-only pattern such as `https://api.example.com` matches no URL, so it blocks every request.
- A pattern without a trailing `*` matches the exact path only: `https://mail.google.com/` allows the root URL and blocks `/inbox` and any URL with a query string. Use `https://valid.com/resource*` to accept a query string.
- Ports must match: `https://api.example.com/*` does not allow a URL with port 8443, and `https://api.example.com:8443/*` allows only that port. A pattern with the default port written out does not match a URL without a port: `https://api.example.com:443/*` blocks `https://api.example.com/x`, so leave the default port out of the pattern.

What is checked:

- The final request URL, after IML, the `baseUrl` join, URL normalisation and the query string.
- Every redirect target, again against the same list, with relative and protocol-relative `Location` values resolved first. A disallowed redirect fails with the same policy error and the redirected request is not sent. When the first URL is allowed but redirects to another host, allow both hosts or turn redirects off.

Where it applies: actions, searches, triggers, RPCs, Endpoints, instant-trigger webhook calls, webhook attach, update and detach, and connection requests. It does not apply to `isc` calls or to the agent's fetch of the connected-system inputs.

## Edge cases

- **Unordered trigger.** It keeps up to `maxPastRecords` items in memory (3200 by default, 5000 only when `maxPastRecords` is `0`). It pages until an empty page, a false `pagination.condition`, 50 extra pages or 3200 raw iterated items, and `response.limit` does not stop it (a `response.limit` you set still cuts the result). That can be expensive.
- **Trigger paging.** An empty page stops paging in every order, unless `pagination.stopOnEmptyResponse` is `false`, where `pagination.condition` decides. In `desc` order a page with no new items after filtering also stops paging, again unless `stopOnEmptyResponse` is `false`. A page whose oldest item has the same id as the oldest item of the previous page stops paging too; this check does not apply to unordered triggers. The oldest item is found after items without a sort value (the date in a date trigger, the id otherwise) are dropped and the page is sorted oldest first, so for a `desc` API it is the last item of the response. A page left empty by that drop stops paging as well.
- **`stopOnEmptyResponse: false` without a condition.** The module fails at once with InvalidConfigurationError "pagination.condition must be set when using pagination.stopOnEmptyResponse". It cannot loop forever, and the request count caps it anyway.
- **`valid` without a message.** The module fails with the generic "Response marked as invalid." (see [valid](#valid)).
- **TLS errors.** The default HTTP client retries nothing. Certificate errors are RuntimeError and are never retried. Only the older client, if the host selects it, repeats a request once on SSL alert 40.
- **Third-party and platform errors.** Make marks an error as caused by a third party (the vendor's API or the network, for example a bad status, a network failure, a DNS or certificate problem) or by the platform. An `isc` call answered with a status of 400 or more or failing on the network, and an agent connected-system inputs fetch that the agent answers with a status of 400 or more, count as platform errors. The `isc` precondition errors carry no mark, and neither does a `response.valid` failure that has its own `message`.
