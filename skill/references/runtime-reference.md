# imt-app-runtime Internal Reference

Source: `imt-app-runtime` — the engine that executes Make custom app IMLJSON at runtime.

## Execution Flow

When a module runs, it goes through a middleware chain. The chain varies by module type.

### Action Middleware Chain

```
communication()
  → repeat()
    → temp('temp')
    → condition()
    → requester.init()
      → prepareRequestOptions()
      → request()
      → prepareResponseBody()
      → temp('response.temp')
      → valid()
      → iterate()
        → iterate.condition()
        → iterate.transform()
      → output()
      → pagination()
    → wrapper()
    → filter.action()
    → errorMiddleware()
```

### Trigger Chain

Same as Action, plus:
- Epoch tracking (`lastId`, `lastDate`, `sameDateIds`)
- Sorting: date triggers sort by `[date, id]`, id triggers sort by `id`
- Deduplication of already-processed items via `dropWhile`

### Search Chain

Same as Action, plus:
- Adds `__IMTLENGTH__` and `__IMTINDEX__` to results
- Deduplicates results (`_.uniq`)
- `continueWhenNoRes: false` → empty array; otherwise `[{ __IMTLENGTH__: 0 }]`

### Hook Chain

- `ExecuteHookTrigger`: parallel `fetch()` + `read()` via `Promise.all`
- `ExecuteHookResponse`: transforms response body/headers/status

### RPC Middleware Chain

```
communication()
  → rpc init (ctx.rpc = {})
  → repeat()
    → temp('temp')
    → condition()
    → requester.init()
      → identifyRequest()
      → accman.validate()
      → agency.initialize()
      → prepareRequestOptions()
      → request()
      → prepareResponseBody()
      → temp('response.temp')
      → valid()
      → iterate()
        → iterate.condition()
        → iterate.transform()
        → epoch tracking (if response.trigger defined)
      → output()
      → pagination()
    → wrapper()
    → filter.rpc()
    → limit()
    → epoch sorting (if epoch data)
    → errorMiddleware()
```

**URL-less RPCs**: When there is no `url` in `api.imljson`, the `getRequestOptions()` function returns without `requestOptions`. The `request()` middleware then skips the HTTP call and calls `next()`, allowing the rest of the chain — including `temp('response.temp')` and `output()` — to execute normally. This makes it possible to build pure data RPCs that use only `temp` + `response.temp` + `response.output` without any API call.

Supports epoch data (`response.trigger.id/date/type`). Final output sorted by epoch type.

## Middleware Details

### condition

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

If condition is `false`, returns `default` (or `false` if no default). Entire request is skipped.

### temp

Merges values into `context.iml.context.temp`. Two phases:
1. `api.temp` — before request
2. `api.response.temp` — after response

**Only `temp` and `response.temp` exist.** There is no `temp2`, `temp3`, or any other temp stage. The runtime source (`lib/core/middleware/temp.js`) only accepts a path argument (defaulting to `'temp'`), and the middleware chains only call `temp('temp')` and `temp('response.temp')`.

**Same-block variables cannot reference each other.** The `temp` middleware calls `context.iml.transform(temp, {deep: true})` on the entire temp object first, then `_.merge()` the result into `context.iml.context.temp`. All IML expressions within a single `temp` block are evaluated simultaneously — before any of them are assigned. A temp variable defined in `api.temp` cannot reference another variable in the same `api.temp` block:

```json
// BROKEN — generateResult evaluates before generateParams is assigned
{
    "temp": {
        "generateParams": { "a": [...], "b": [...] },
        "generateResult": "{{if(condition, temp.generateParams.a, temp.generateParams.b)}}"
    }
}

// CORRECT — use response.temp to reference values from temp
{
    "temp": {
        "generateParams": { "a": [...], "b": [...] }
    },
    "response": {
        "temp": {
            "generateResult": "{{if(condition, temp.generateParams.a, temp.generateParams.b)}}"
        },
        "output": "{{temp.generateResult}}"
    }
}
```

This two-phase pattern works because `temp('temp')` runs first and assigns `generateParams`, then `temp('response.temp')` runs later and can safely reference `temp.generateParams`.

**Critical: `_.merge` array behavior**. The temp middleware uses `_.merge()` (lodash) to apply values. For objects, this deep-merges properties. For **arrays**, `_.merge` does **not replace** — it merges **index by index**:

```
Old temp.arr = [A, B, C, D, E]   (5 items)
New value    = [A, B, D, E]       (4 items — C filtered out)

_.merge result:
  [0] merge(A, A) → OK
  [1] merge(B, B) → OK
  [2] merge(C, D) → BUG: index shift, C gets D's data
  [3] merge(D, E) → BUG: D gets E's data
  [4] E           → BUG: stale element retained (_.merge never deletes)
```

This causes three problems:
1. **Index-shifted contamination** — when an array shrinks (filter/remove), elements at mismatched indices get deep-merged with the wrong element
2. **Ghost properties** — `_.merge` never deletes properties from the destination. Old properties persist even after "replacement"
3. **Cascading reference contamination** — when `sort()` reorders elements, the new array shares object references with the old one. `_.merge` mutates objects in-place at each index, and since the same object exists at different indices in old vs new arrays, mutations cascade through the entire array

**Safe vs dangerous patterns:**

| Pattern | Safety |
|---|---|
| Array grows monotonically (concat + distinct) | Safe — same refs at same indices, `_.merge` is no-op |
| Array shrinks (filter/remove) written to **same key** | **Dangerous** — index shift causes cross-element merge |
| Array reorders (sort) written to **same key** | **Dangerous** — shared refs cause cascading mutation |
| Write filtered/sorted result to a **new key** | Safe — no previous value to merge against |
| Inline filter/sort in consuming expression | Safe — result never passes through `_.merge` |

**Rule: treat temp array keys as append-only.** Never write a shorter or reordered array back to the same temp key. Use a new key or inline the operation.

See IEN-14758 (google-email v4) for a real-world case where this caused 92.5% cross-message body contamination in a 200-email batch.

**Undefined parameter handling in temp**: When `{{parameters.fieldName}}` references a parameter the user did not fill in, IML evaluates the expression to `undefined` (not empty string `""`). Since `_.merge` **skips source properties with `undefined` values**, the key is simply absent from `context.iml.context.temp`. This means explicit body mapping patterns like the following are safe — unfilled fields are automatically excluded:

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

If the user only fills `name`, `temp.mappedFields` = `{name: "user value"}` — `description` is not present.

**Direct body mapping is also safe**: When body fields reference undefined parameters directly (without temp), `iml.transform` evaluates each value. Undefined results remain as `undefined` in the transformed object. Since the runtime uses `JSON.stringify(body)` for `json` type requests, and `JSON.stringify` omits keys with `undefined` values, unfilled fields are excluded from the HTTP body:

```json
"body": {
    "name": "{{parameters.name}}",
    "assigned_to_user": "{{parameters.assignedToUser}}"
}
```

If only `name` is set → HTTP body = `{"name":"user value"}` (no `assigned_to_user` key).

**Important distinction**: `null` vs `undefined`:
- `undefined` → key omitted by `JSON.stringify` and by `_.merge`
- `null` → key **included** by `JSON.stringify` as `null`, and included by `_.merge`
- Empty string `""` → key **included** by both

The `stripNullAndUndefined` utility (`lib/core/utils/index.js`) removes both `null` and `undefined` (`== null` check), but it is only applied to `urlencoded` and `multipart/form-data` body types — **NOT to `json` type** (default). For `json`, the only filtering is `JSON.stringify`'s native `undefined` omission.

Source: `lib/core/middleware/temp.js` (line 20: `_.merge`), `lib/core/chainMiddleware/requester/_request.js` (line 181: `iml.transform` body, line 357: `JSON.stringify`), `lib/core/utils/index.js` (line 175: `stripNullAndUndefined`).

**Pagination caveat**: During pagination cycles, `response.temp` is re-evaluated on every page. If a temp variable was set to a meaningful value on the first page (e.g., `true`), a subsequent page may overwrite it (e.g., back to `false`). Use `ifempty` to protect values that should persist once set:

```json
"temp": {
    "hasResults": "{{ifempty(temp.hasResults, body.total > 0)}}"
}
```

Without `ifempty`, page 1 might set `hasResults = true`, but page 2 (with 0 results) would overwrite it to `false`.

### iterate

- `container`: array to iterate over
- `condition`: filter each item
- `transform`: map each item (internally mapped from `response.output`)

Compatibility mode: when `response.output` exists alongside `iterate`, output is converted to `iterate.transform`.

### output

- `false` or `null` → terminates chain (no output)
- `undefined` → returns raw response
- Otherwise → IML transform applied

### wrapper

`response.wrapper` wraps the final iterated result. Applied after iterate.

### filter

- **Action**: only objects pass through
- **Search**: objects and arrays (filters non-objects from arrays)
- **RPC**: objects, strings, and arrays all pass

### limit

- Default: `Number.MAX_SAFE_INTEGER` (effectively unlimited)
- `limit === 0` → throws `InvalidConfigurationError`
- **Works independently from `iterate`**: The `limit` middleware checks `Array.isArray(result)` and applies `result.slice(0, limit)` regardless of whether `iterate` is used.
- If `result` is not an array → passes through unchanged (no limit applied)
- In Search modules, `response.output: "{{body}}"` + `response.limit` without `iterate` works correctly when the API response is an array — limit is applied and each element becomes an individual output bundle

### error

Default status code mapping:
- `429` → `RateLimitError`
- `500-599` → `ConnectionError`

Custom error directives from `api.response.error` or `api.error`. Status-code-specific overrides:

```json
"error": {
    "401": { "message": "...", "type": "InvalidAccessTokenError" },
    "429": { "message": "...", "type": "RateLimitError" },
    "message": "[{{statusCode}}] {{body.message}}"
}
```

Network error code mapping:
- `ESOCKETTIMEDOUT`, `ECONNABORTED`, `ETIMEDOUT` → timeout errors
- `ECONNRESET`, `ECONNREFUSED`, `ENOTFOUND` → connection errors

TLS certificate errors → `RuntimeError` (no retry).

### repeat

```json
"repeat": {
    "condition": "{{body.status == 'pending'}}",
    "delay": 2000,
    "limit": 10
}
```

Also accepts `api.while` as alias. Max iterations: **1000** (hard limit).

### valid

Validates response. Three forms:

```json
// Simple boolean
"valid": "{{body.success}}"

// Object with custom error
"valid": {
    "condition": "{{body.success}}",
    "message": "API returned failure",
    "type": "DataError"
}
```

If validation fails and no custom error → default message: `"Response marked as invalid."`

## Pagination Internals

### Initial Values

| Property | Default |
|----------|---------|
| `page` | 1 |
| `offset` | 0 |
| `limit` | 20 |

### Auto-Scaling

On each pagination cycle: `limit = Math.min(limit * 5, 500)`

### Stop Conditions

Pagination stops when **any** of these is true:
1. `condition` evaluates to `false`
2. `maxPaginationRequestCount` exceeded (default: 50)
3. `maxRequestCount` exceeded (default: 100)
4. `maxPastRecords` reached (triggers only, default: 3200)
5. Module `limit` reached
6. Empty batch received (when `stopOnEmptyBundles: true`)

### mergeWithParent

When `pagination.mergeWithParent` is `true`, pagination config is deep-merged with the parent request config (inherits headers, qs, etc.).

## Trigger Internals

### Epoch Types

| Type | Tracked State | Sort Key |
|------|--------------|----------|
| `id` | `lastId` | `__itemId` |
| `date` | `lastDate`, `sameDateIds` | `[__itemDate, __itemId]` |
| `select` | selected items only | — |

### Order Behavior

| Order | Behavior |
|-------|----------|
| `asc` | Fetches past items, stops at known boundary |
| `desc` | Fetches future items, continues until known boundary |
| `unordered` | Keeps all items in memory (max `maxPastRecords` or 5000), always paginates |

### Same-Date Deduplication

For date triggers, items with the same date are tracked in `sameDateIds` array to prevent re-processing on subsequent runs.

### Default Trigger Limit

Default `limit` for triggers: **1** (returns one item per execution).

## Requester / HTTP Details

### Timeout

Default: **40,000ms** (40 seconds). Configurable via `common.timeout` (max 300,000ms).

### TLS Error Retry

On `EPROTO SSL alert number 40`, retries **once** automatically.

### Redirect Handling

- `followRedirect`: controls 3xx redirect following
- Max redirects: 21
- Each redirect URL is validated against local IP / URL permissions

### URL Normalization

Every outbound request URL is normalized **after** IML evaluation and **before** the HTTP call, via `lib/core/utils/normalizeUrl.js` (composed with `lib/core/utils/joinBaseUrlAndUrl.ts`). Key behaviors the app author should rely on — or work around — are:

| Behavior | Detail |
|---|---|
| **Consecutive slashes in `pathname` are collapsed** | `/foo//bar///baz` → `/foo/bar/baz` via `pathname.replace(/\/{2,}/g, '/')`. Users can safely supply a leading `/` in a mapped path param even if the URL template already adds one — the runtime will de-dup it. |
| **Trailing slash on non-root paths is PRESERVED** | `replace(/\/$/, '')` runs only when `pathname === '/'` (root). `/v0/apps/{id}/collections/{id}/` stays as-is. → **The app must prevent app-level trailing slashes** on APIs that treat `.../x` and `.../x/` as different resources (e.g., Adalo returns 400 on the `/` variant — see IEN-15136). Use `{{if(parameters.url, '/' + parameters.url, '')}}` instead of hardcoding `/` before an optional path segment. |
| **baseUrl + url join** | `joinBaseUrlAndUrl(baseUrl, url)` joins with a literal `/` when `url` is relative (`!/^https?:\/\//.test(url)`). Absolute `url` bypasses `baseUrl` entirely. |
| **Path encoding** | If `encodeUrl: true` (default in most apps), the pre-query portion is run through `encodeURI()`. |
| **Query string** | `legacy` mode: `encodeUrl: false` decodes the QS (except reserved `%20 %23 %26 %3F %3A`); the second `?` is rewritten to `&`; `?` with empty QS is dropped. `uniform` mode: QS is encoded iff `encodeUrl: true`, no `?→&` rewrite. |
| **Default ports stripped** | 80/443/21 are stripped under `legacy` mode only. |
| **Hostname** | Trailing dot removed; IDN→Unicode conversion currently disabled (2025-07-03 flag). |

**Quick rule for path templates**: the runtime fixes internal double-slashes but will NOT fix a trailing slash. Any optional trailing path segment must be emitted conditionally from the app.

### Response Parsing

Determined by `response.type`:

| Type | Behavior |
|------|----------|
| `json` | `JSON.parse()` |
| `xml` | XML parser |
| `urlencoded` | Query string parser |
| `text` | Raw text |
| `binary` | Buffer |
| `automatic` | Auto-detect from Content-Type |

Wildcard matching: `"type": { "*": "json", "200-299": "json" }`

## IML Custom Functions (Runtime-Provided)

### jwt(payload, secret, alg?, options?)

- Default algorithm: `HS256`
- `noTimestamp: true` by default (when payload has no `iat`)
- Valid options: `expiresIn`, `notBefore`, `audience`, `algorithm`, `header`, `encoding`, `issuer`, `subject`, `jwtid`, `noTimestamp`, `keyid`, `mutatePayload`, `allowInsecureKeySizes`, `allowInvalidAsymmetricKeyTypes`

### generateJwtWithKeyId(payload, hmacKey, jwtAlg?, thumbprintAlg?, options?)

- Default: `jwtAlg = 'HS512'`, `thumbprintAlg = 'HS256'`
- Generates JWK thumbprint as `kid` header
- Caches thumbprint for performance

### cryptoSign(algorithm, data, key, outputEncoding?)

- Default output encoding: `'hex'`
- Supports Buffer input
- Wrapper around Node.js `crypto.sign()`

### mime(filename)

- Returns MIME type from file extension
- Returns `undefined` if not found

### errorFactory(name, message)

All available error types:
`DataError`, `UnknownError`, `RuntimeError`, `InconsistencyError`, `RateLimitError`, `OutOfSpaceError`, `ConnectionError`, `InvalidConfigurationError`, `InvalidAccessTokenError`, `UnexpectedError`, `MaxResultsExceededError`, `MaxFileSizeExceededError`, `IncompleteDataError`, `DuplicateDataError`, `ModuleTimeoutError`, `ScenarioTimeoutError`, `OperationsLimitExceededError`, `DataSizeLimitExceededError`, `ExecutionInterruptedError`, `Warning`

## IML Variable Path Syntax

IML expressions (`{{...}}`) resolve variable paths through `imt-iml`'s `mapVariable(data, key)` in `lib/utils.js`. The indexing rules are **not** the same as JavaScript and trip up most reviewers at least once.

### 1-Based Array Indexing (Critical)

IML path indices are **1-based**, not 0-based. Backing source (`imt-iml/lib/utils.js` `mapVariable`):

```js
if (/\[(\d+)?\]$/.exec(k)) {
    n = RegExp.$1 ? parseInt(RegExp.$1) : 1; // empty brackets → n = 1
    ...
}
...
if (Array.isArray(data)) data = data[k - 1]; // 1-based
if (n != null && Array.isArray(data)) data = data[n - 1]; // 1-based
```

| IML path | Resolves to (JS) | Notes |
|---|---|---|
| `foo[]` | `foo[0]` (first element) | Empty brackets default to `n = 1` → `arr[n - 1]` = `arr[0]` |
| `foo[1]` | `foo[0]` (first element) | |
| `foo[2]` | `foo[1]` (second element) | |
| `foo[3].bar` | `foo[2].bar` | |
| `foo[0]` | **`foo[-1]` → `undefined`** | **Common bug.** `[0]` is never what you want. |

### Implications for `response.output`, `response.iterate`, etc.

- `{{body.items[].id}}` — returns **one** scalar: the first item's `id`. It does NOT iterate or collect.
- `{{body.items[1].id}}` — identical to the above (both access item 1 / JS index 0).
- To iterate all items in the response, use `response.iterate` with `{{body.items}}` — never rely on `[]` to produce a collection.
- For action modules that upload/create a single entity and the API returns a one-element array (e.g. Google Photos `mediaItems:batchCreate` → `newMediaItemResults`), `{{body.newMediaItemResults[].mediaItem}}` is the correct way to unwrap the single result into a scalar output — it is **not** an array-wrap.

### Dynamic / Expression Indices

When the bracket content is a nested IML expression (e.g. `foo[{{idx}}]`), the engine evaluates the inner expression first, then applies the same 1-based rule. So `foo[{{1}}]` = first item, `foo[{{0}}]` = undefined.

### Dotted-Number Path Syntax

Internally the engine stringifies `foo[]` as `` foo.`1` `` (the backtick-wrapped numeric segment is a path token, not a literal value). Reviewers occasionally see this in debug dumps — it is the same access as `foo[]` / `foo[1]`.

### Takeaways for Code Review

- Flag any `{{...[0]...}}` in IMLJSON as a bug unless the reviewed intent is specifically "return undefined / null".
- `foo[]` is **not** a bug and **not** an accidental array wrap — it is the idiomatic way to pick the first element out of a single-result array.
- When a module outputs `{{body.results[].field}}`, the output is a **scalar**, matching interface of type `text`/`number`/object — not an array. Do not request that it be "unwrapped".

## Limits & Constants

| Limit | Default | Overridable via |
|-------|---------|----------------|
| `maxRequestCount` | 100 | `common.imljson` |
| `maxPaginationRequestCount` | 50 | `common.imljson` |
| `maxPastRecords` | 3200 | `common.imljson` |
| Request timeout | 40,000ms | `common.timeout` (max 300s) |
| Repeat max iterations | 1000 | `repeat.limit` (capped at 1000) |
| Pagination initial limit | 20 | — |
| Pagination max limit (auto-scale) | 500 | — |
| Unordered trigger memory | max(`maxPastRecords`, 5000) | — |
| Data collection max size | 65,536 bytes (64KB) | — |
| Sandbox timeout | 10,000ms (prod) / 50ms (dev) | — |
| Sandbox memory | 2,048MB | — |
| Max redirects | 21 | — |
| Default trigger limit | 1 | `parameters.limit` |

## Environment Variables

Two separate `environment`-related features exist in the runtime. Do NOT confuse them.

### Scenario Environment (`environment`)

The user's Make scenario runtime environment. Passed directly to the IML context — **always available without any flags**.

Source: `buildContext()` in `runtime.js`:
```js
environment: instance.environment || {},
```

Available in IML as `{{environment.xxx}}`:

| Property | Description |
|----------|-------------|
| `environment.timezone` | Scenario timezone (from org settings). Also injected into IML function sandbox for `formatDate()`/`parseDate()` |
| `environment.debug` | Debug mode flag |
| `environment.audit` | Audit logging flag |
| `environment.verifier` | Verifier mode flag |

Usage example in `api.imljson`:
```json
{
    "temp": {
        "tz": "{{environment.timezone}}"
    }
}
```

`environment.timezone` is also passed to the custom IML function sandbox context, so built-in IML functions (`formatDate`, `parseDate`, etc.) automatically use the scenario's timezone:
```js
const imlFunctionContext = {
    timezone: (functionSandbox.environment || {}).timezone,
    passthrough: manifestVersion >= 2
};
```

### Server Environment Access (`flags.environmentAccess`)

A **separate, unrelated** feature for accessing **server-side `process.env` variables** via a frozen proxy object at `environment.system`.

Source: `runtime()` in `runtime.js`:
```js
if (module.flags && module.flags.environmentAccess) {
    // Must be an array — accessing the whole environment at once is a security risk
    if (!Array.isArray(module.flags.environmentAccess))
        throw new Error('Variables for the Environment Access should always be enumerated as an array of strings.');

    const envProxyProperties = module.flags.environmentAccess;
    const envProxyBase = {};
    Object.defineProperties(envProxyBase, envProxyProperties.reduce((acc, property) => {
        acc[property] = {
            configurable: false, enumerable: false,
            get: () => process.env[property],
            set: undefined
        };
        return acc;
    }, {}));
    Object.freeze(envProxyBase);
    module.environment.system = envProxyBase;
}
```

- Requires `flags.environmentAccess` (array of strings) in `common.imljson`
- Exposes enumerated `process.env` properties as `{{environment.system.VAR_NAME}}`
- Frozen, non-enumerable, read-only — high security design
- **NOT related to `{{environment.timezone}}`** — that comes from the scenario environment

### Quick Reference

| What you need | IML expression | Flags required? |
|---|---|---|
| Scenario timezone | `{{environment.timezone}}` | No |
| Scenario debug mode | `{{environment.debug}}` | No |
| Server env var `FOO` | `{{environment.system.FOO}}` | Yes — `flags.environmentAccess: ["FOO"]` in common |

## Security

### Local Access

- Blocked by default. Requires `flags.localAccess` or `scenario.localAccess`
- DNS lookup validates all resolved IPs; if any IP is unsafe, request is denied

### URL Permissions

- Controlled by `urlPermissions` directive
- Each request URL is checked against allowed patterns

### Data Collection

- `data` collection updated only when module has `data` property
- Exceeding 64KB throws `RuntimeError`

## Edge Cases

- **Trigger `unordered`**: keeps ALL items in memory (up to 5000), always paginates through everything — can be expensive
- **`desc` trigger with empty batch**: stops pagination immediately (optimization)
- **`stopOnEmptyResponse: false`**: must have explicit `condition` or pagination runs forever
- **`valid` without custom error**: generic "Response marked as invalid." message
- **TLS errors**: no retry except for SSL alert 40
- **`imtExternalError` flag**: distinguishes external (API) vs internal (runtime) errors
