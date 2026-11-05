# Runtime reference: webhooks and instant triggers

> Read when: writing or reviewing an instant trigger's `api`, a dedicated or shared webhook's request parsing, `verification` and `respond`, webhook attach/update/detach, or a responder module. Part of [runtime-reference.md](../runtime-reference.md).

A webhook-based app uses up to five kinds of `api` block. Each one has its own variables and its own list of directives that run, so check the section of the block you are reading.

| Block | What its `api` does |
|---|---|
| Dedicated webhook | Turns each HTTP request that reaches one webhook, with its own address, into bundles, and can answer the sender |
| Shared webhook | Turns each request that reaches one address shared by many webhooks into `{account, data}` items, and filters them per receiving webhook |
| Instant trigger | Processes each received bundle: an optional request, then the mapping |
| Attach, update, detach | Registers, changes and removes the webhook in the remote system |
| Responder module | Builds the answer that a scenario sends back to the webhook caller |

The size of a webhook payload and the time a webhook may take to answer are set by Make's gateway, not by the IMLJSON, so this reference does not state them.

## Instant triggers with an api

An instant trigger gets its bundles from a webhook. A trigger with no `api` passes the received bundles on unchanged. A trigger with an `api` runs it once for every received bundle.

- Several bundles run in parallel, and the results are flattened in arrival order. If the run for one bundle fails, the whole run fails with that error and returns nothing.
- Each bundle follows the usual order of a request item: `temp`, `condition`, one request, `response.temp`, `response.valid`, `response.iterate`, `response.data`, `response.output` (see [Order of steps per module type](../runtime-reference.md#order-of-steps-per-module-type)). `repeat` works here too. A `communication` array, or an `api` array, runs its items in turn, and only the result of the last item that produced one is returned for that bundle (see [Several requests in one module](../runtime-reference.md#several-requests-in-one-module)).
- `url` is optional. With one, Make sends a request for every bundle, for example to fetch the full record. Without one, no request is made, and `{{body}}`, `{{headers}}` and `{{statusCode}}` stay empty.

Variables an instant trigger can read:

| Variable | Holds |
|---|---|
| `{{payload}}` | the received bundle |
| `{{webhook}}` | the data of the webhook the module is attached to, as Make supplies it |
| `{{parameters}}` | the module parameters |
| `{{connection}}` | the connection |
| `{{data}}`, `{{metadata}}` | the module data and metadata |
| `{{common}}`, `{{scenario}}`, `{{environment}}` | the app's common data, the scenario and the environment (see [environment-variables.md](environment-variables.md)) |
| `{{scenarioModuleId}}` | the id of the module in the scenario |

`{{internal}}` and `{{trigger}}` are empty here. The pagination variables exist but never move: `{{pagination.page}}` is 1, `offset` is 0 and `limit` is 20.

With a `url`, `response.iterate` works, so one payload can become several bundles (the no-request case is in the last paragraph of this section). When it is set, `response.output` is the mapping of each element.

```json
{
	"url": "/items/{{payload.id}}",
	"response": {
		"iterate": "{{body.data}}",
		"output": { "event": "{{payload}}", "record": "{{item}}" }
	}
}
```

The public developer docs say that `iterate` is not available in instant triggers, that only a single request is made, and they do not list `{{webhook}}`. Make runs `response.iterate`, runs every item of an `api` or `communication` array, and provides `{{webhook}}`. Only pagination is never entered.

What a bundle's run returns:

- The output of `response.output`, or of `response.iterate` with `response.output`, as an object or a list. Without `response.output`, a request's `{{body}}` passes through.
- Items must be plain objects, the same check as in a search (see [Search](../runtime-reference.md#search)). `null` items are dropped. An item of another type fails with DataError "Invalid item in module output. Expected Object, but found String." (the type name varies), and a result that is neither an object nor a list fails with "Invalid module output. Expected Object, or Array, but found String."
- `pagination`, `response.wrapper` and `response.limit` are ignored. There is never a second page: each item makes one request.
- No output for the bundle comes from a false `condition`, from `response.output` set to `false` or `null`, and from an `api` that has no request and no `response.output`. A false `condition` that has a `condition.default` returns that default instead.
- `api.endpoint` fails with InvalidConfigurationError "Inline endpoint calls ('api.endpoint') are not supported in webhook modules."
- A failed request (status 400 or more, or a transport error) fails the run, with `response.error` shaping the message (see [Handling the response](../runtime-reference.md#handling-the-response)).

With no request, `response.output` is still evaluated for every bundle from `{{payload}}`:

```json
{ "response": { "output": { "id": "{{payload.id}}", "type": "{{payload.event}}" } } }
```

`response.iterate` in a trigger that makes no request never finishes. Make repeats the request-less round without end, until it stops the run (for example at the module's time limit). To split a payload that carries a list when there is no request, return the list from `response.output`: an expression that evaluates to an array gives one bundle per element.

## Dedicated webhooks

A dedicated webhook is one webhook with its own address. Its `api` parses each HTTP request that reaches it. Its directives sit at the TOP level of the block, not under `response`: `temp`, `condition`, `verification`, `respond`, `iterate` and `output`. They run in that order.

| Variable | Holds |
|---|---|
| `{{body}}` | the parsed request body |
| `{{query}}` | the query string parameters |
| `{{method}}` | the HTTP method |
| `{{rawBody}}` | the body as received |
| `{{headers}}` | the request headers; a name is looked up case-insensitively, so ``headers.`X-Event` `` finds `x-event`. A name with a hyphen needs backticks: `headers.X-Event` without them is read as a subtraction and gives 0 |
| `{{parameters}}`, `{{data}}` | both are the webhook's stored data |
| `{{common}}`, `{{scenario}}`, `{{environment}}` | as in a module |
| `{{temp}}` | what the top-level `temp` set |
| `{{item}}` | inside `iterate`, the current element |

There is no `{{connection}}`. `{{payload}}`, `{{webhook}}`, `{{metadata}}` and `{{scenarioModuleId}}` are empty.

What the request becomes:

- With no `api`, or with no `iterate` and no `output`, the whole request body is one bundle. A JSON array body goes on as the list itself, and an empty body gives no bundle.
- `iterate` splits the body into bundles, and `iterate.condition` filters them. With `iterate`, `output` is the mapping of each element. Without it, `output` maps the whole body.
- `output` set to `false` or `null` gives no bundles.
- A false top-level `condition` gives zero bundles, and `verification` and `respond` do not run either. With a `condition.default`, that default is returned instead.
- While Make is learning the data structure (learning mode), the first produced item is used to generate the structure, and no bundles are passed on for that request.

```json
{
	"condition": "{{headers.`X-EVENT` == 'update'}}",
	"iterate": "{{body.data}}",
	"output": { "id": "{{item.id}}" }
}
```

## verification and respond

`verification` and `respond` work the same in dedicated and shared webhooks. They answer the sender of the request before any bundle is made.

- If `verification.condition` is truthy and `verification.respond` is present (both are required), Make sends that response and the request produces NO bundles.
- Otherwise a `respond` directive is sent before the items are processed. A request with neither answers as Make's gateway decides, which the IMLJSON does not control.
- Both run after the top-level `condition`: when that is false, nothing is sent from `verification` or `respond`.

```json
{
	"verification": {
		"condition": "{{body.type == 'url_verification'}}",
		"respond": { "type": "json", "status": 200, "body": { "challenge": "{{body.challenge}}" } }
	}
}
```

A `respond` block has these fields:

| Field | Behaviour |
|---|---|
| `status` | an IML expression, 200 when the directive is missing or empty. An expression that evaluates to nothing sends no status. It is not converted to an integer (a responder module's status is) |
| `headers` | an object whose values are evaluated, or a list of `{key, value}` entries that an expression returns. A literal list written inside the block evaluates to nothing and gives no headers |
| `body` | evaluated deeply, then encoded by `type`. A literal top-level array in `body` evaluates to nothing |
| `type` | how the body is encoded, see below |

| `type` | Body sent |
|---|---|
| `text` (the default) | the body as text. An object becomes "[object Object]", and a missing body becomes "undefined" |
| `json` | the body as JSON text |
| `urlencoded` | a query string; `null` and undefined fields are left out, an empty string stays |
| any other value | an empty body |

## Shared webhooks

A shared webhook receives requests for many webhooks at once, for example one address for every connected account. Its `api` needs a top-level `uid`. Without it every request fails with InvalidConfigurationError "Missing uid in configuration."

- Each item becomes `{account: <uid value>, data: <raw item>}`. `uid` is evaluated per item (`{{item...}}` with `iterate`, `{{body...}}` without). A `uid` that evaluates to nothing is not an error: `account` is empty.
- Make delivers each item to the webhooks whose uid matches. That uid starts as the connection's uid, and the `response.uid` of the attach call can change it (see [Attach, update and detach](#attach-update-and-detach)).
- A JSON array body with no `iterate` is not wrapped: the array goes on as it is, with no `uid` evaluated. Use `iterate` for a list.
- `verification` and `respond` work as described above. There is no learning mode.

A shared webhook evaluates IML in two phases, and the variables differ:

| | When the request arrives | Then, for each matching webhook |
|---|---|---|
| What runs | the top-level `temp` and `condition`, `verification`, `respond`, `iterate` with `iterate.condition`, and `uid` | `iterate.condition` again, then the `output` mapping |
| Variables | `{{body}}`, `{{query}}`, `{{headers}}`, `{{rawBody}}`, `{{item}}`, and `{{temp}}` | `{{item}}` (the raw item), `{{body}}`, `{{query}}`, `{{headers}}`, `{{environment}}`, and that webhook's stored data as `{{parameters}}` and `{{data}}` |
| Empty | everything else, for example `{{environment}}`, `{{parameters}}`, `{{data}}`, `{{method}}`, `{{common}}`, `{{scenario}}` | everything else, for example `{{rawBody}}`, `{{temp}}`, `{{common}}`, `{{scenario}}`, `{{connection}}`, `{{metadata}}` |

So write `iterate.condition` to pass when `data` is absent (it runs first without it), and put per-webhook filters in it. A false condition in the second phase drops the item for that webhook only. The top-level `condition` does not run again.

```json
{
	"uid": "{{item.userId}}",
	"iterate": {
		"container": "{{body.data}}",
		"condition": "{{if(data; data.type == item.type; true)}}"
	},
	"output": "{{item}}"
}
```

## Attach, update and detach

Attach, update and detach are the calls that keep a webhook in step with the remote system. Each one runs its `api` around a step Make does itself.

| | Attach | Update | Detach |
|---|---|---|---|
| Make first | registers a new webhook for the connection's uid | loads the stored webhook | unregisters the webhook |
| `{{webhook}}` | the new Make webhook; `{{webhook.url}}` is its address | the stored data (what attach or update saved with `response.data`) | the stored data |
| `{{data}}` | starts empty; with `repeat` it accumulates across iterations | the same | not available |
| `{{parameters}}`, `{{connection}}` | the webhook's own fields, and the connection | the same | the same |
| Make last | applies `response.uid`, then saves the data | saves the new data | saves nothing |

In update and detach, `{{webhook}}` is NOT the Make webhook record. It is the data you stored, so `{{webhook.externalHookId}}` reads the id that attach kept.

```json
{
	"attach": {
		"url": "/hooks",
		"method": "POST",
		"body": { "callback": "{{webhook.url}}" },
		"response": { "data": { "externalHookId": "{{body.id}}" } }
	},
	"detach": { "url": "/hooks/{{webhook.externalHookId}}", "method": "DELETE" }
}
```

The steps of all three, in order: top-level `temp`, `condition`, the request with `response.temp` and `response.valid`, then `response.data`, then (attach only) `response.uid`, then `response.error`. `repeat` works. `response.iterate`, `response.output`, `response.wrapper`, `response.limit` and `pagination` are ignored, so an output mapping has no effect. `api.endpoint` fails with the "webhook modules" message of [Instant triggers with an api](#instant-triggers-with-an-api).

Stored data:

- `response.data` is evaluated in all three but saved only by attach and update. The data of a webhook is limited to 64 KB: a larger result fails with RuntimeError "Error processing module data. 'data' collection is too big." (see [response.data, response.metadata and audit](../runtime-reference.md#responsedata-responsemetadata-and-audit)).
- In attach, if saving the data fails, Make unregisters the webhook again and returns the error. In update, a failed save returns the error and the webhook stays registered. If the IMLJSON itself fails (a failed request, data too big) in attach or update, the error is returned and the webhook is not unregistered. Attach hands the registered webhook back to Make as its result.
- A successful update stores the old data, then the current webhook parameters (without the connection), then the update's `response.data` on top. So parameter values end up inside the webhook data, and a field that the update does not set keeps its old value. A failed update saves nothing.

The uid in attach:

- The webhook uid starts as the connection's uid. `response.uid` replaces it only when it evaluates to a different value. An expression that evaluates to nothing counts as a different value, and sets an empty uid.
- Update and detach never change the uid; their `response.uid` is ignored.

## Responder modules

A responder module answers the caller of a webhook. It makes no request. It evaluates three directives:

| Directive | Behaviour |
|---|---|
| `response.status` | parsed as an integer; 200 when missing, empty or not a number (`"abc"` and `0` give 200, `201.9` gives 201) |
| `response.headers` | evaluated one level deep; each entry becomes a header, and a nested object as a value gives an empty value. A list does not work: a literal list gives no headers, and a list returned by an expression gives headers named 0, 1 and so on |
| `response.body` | evaluated deeply. A literal top-level array evaluates to nothing; return an array through an expression instead |

The variables are `{{parameters}}` (the module parameters merged with the mapped input, the mapped input winning on equal names), `{{connection}}`, `{{common}}`, `{{scenario}}`, `{{environment}}`, `{{metadata}}`, `{{data}}` and `{{scenarioModuleId}}`. `{{temp}}` starts empty. `{{payload}}` and `{{webhook}}` are not available.

```json
{
	"response": {
		"status": "{{parameters.status}}",
		"headers": { "content-type": "application/json" },
		"body": { "ok": true }
	}
}
```

Without a `response` block the answer is status 200 with no body and no headers. Webhook payload size and response timeout are not set by the runtime.
