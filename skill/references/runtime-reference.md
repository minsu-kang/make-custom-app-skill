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

> **⚠️ This URL-less fallback does NOT apply when the `isc` directive is present.** `isc.initialize()` runs _before_ `prepareRequestOptions()` and hard-requires `url` — a url-less ISC component throws `RuntimeError: ISC directive requires a url field to specify the request path.` instead of silently skipping the call. See [§ ISC (Internal Service Communication)](#isc-internal-service-communication).

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

| Pattern                                               | Safety                                                 |
| ----------------------------------------------------- | ------------------------------------------------------ |
| Array grows monotonically (concat + distinct)         | Safe — same refs at same indices, `_.merge` is no-op   |
| Array shrinks (filter/remove) written to **same key** | **Dangerous** — index shift causes cross-element merge |
| Array reorders (sort) written to **same key**         | **Dangerous** — shared refs cause cascading mutation   |
| Write filtered/sorted result to a **new key**         | Safe — no previous value to merge against              |
| Inline filter/sort in consuming expression            | Safe — result never passes through `_.merge`           |

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
| -------- | ------- |
| `page`   | 1       |
| `offset` | 0       |
| `limit`  | 20      |

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

### `pagination.condition` is Evaluated TWICE per cycle (Critical)

`api.pagination.condition` is **not** a single after-response check. The runtime evaluates it at **two different points**, with **different `pagination.page` values**:

1. **After the response** — in the `pagination` middleware (`lib/core/chainMiddleware/requester/middleware.ts`).
    - Evaluated with `pagination.page = N` (the page that was just fetched).
    - If `false` → `disablePagination()` → `mode = DISABLED` → loop exits.
    - If `true` → `enablePagination()` → `mode = PAGINATION` and **`pagination.page++`** (to `N+1`).

2. **Before the next request** — in `getPaginationRequestOptions()` (`lib/core/chainMiddleware/fetcher/request-options.ts` line 122–130, `lib/core/chainMiddleware/requester/_request.js` line 194–197).
    - Evaluated with `pagination.page = N+1` (already incremented above).
    - If `false` → `ctx.request.options = undefined`, response deleted, `request` middleware skips the HTTP call (`if (!requestOptions) return next();` in `fetcher/middleware.ts:35-38`), the chain bails on `!batch` (`init.ts` callback), and the loop exits cleanly. **No extra HTTP request is made.**
    - If `true` → request is built with the new page and sent.

This dual check is intentional (the second check is the actual stop gate; the first check just decides whether to enter the next iteration at all), but it produces **non-obvious off-by-one behavior** when the condition expression references `pagination.page` directly.

#### Off-by-One Trap: `> pagination.page` vs `>= pagination.page`

For a `total_pages`-style API (e.g. Aha!, where `body.pagination.total_pages` is the count of existing pages and `pagination.page` is used as the request's `qs.page`):

| Condition                        | After response of page N (page=N)                                                                                                                                                                                   | Before request of page N+1 (page=N+1)                                                 | Effect on total_pages=3                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `total_pages > pagination.page`  | `3 > 3` → false on last page → stops _after_ fetching page 3. **But** the second check fires next iteration with page=N+1, and `total_pages > N+1` becomes false **one page early**, skipping the actual last page. | `3 > 3` → false on the LAST request → **request skipped → page 3 data NEVER fetched** | **❌ Loses last page** (2 HTTP requests, only pages 1–2 returned)                                     |
| `total_pages >= pagination.page` | `3 >= 3` → true on last page → enable, increment to 4                                                                                                                                                               | `3 >= 4` → false → request skipped, loop exits                                        | **✅ Correct** (3 HTTP requests for 3 pages, then one chain iteration with no HTTP call to terminate) |

**Rule**: when the condition expression is built around `pagination.page` (the runtime-incremented variable), use `>=`, not `>`. Using `>` produces a silent off-by-one — the **last page is never fetched** because the second condition check sees the post-increment page number.

The same rule applies to inverted forms: prefer `pagination.page <= total_pages` over `pagination.page < total_pages`. The runtime's own pagination tests (`test/pagination.spec.ts:921`) use `pagination.page <= headers['x-totalpages']` — equivalent to `total_pages >= pagination.page`.

**Body-driven conditions are immune** to this trap because they reference fields on the just-received response (`body.current_page`, `body.has_more`, `body.next_cursor`), not the runtime-incremented `pagination.page`. Both checks see the same value, so `<` / `>` / `==` behave intuitively. See `communication-reference.md` § "Pagination Patterns" for body-driven examples.

Source: `lib/core/chainMiddleware/requester/middleware.ts` (pagination middleware: condition check line 473–477, `enablePagination` call line 505), `lib/core/chainMiddleware/requester/utils.ts` (`enablePagination` line 113–130, `pagination.page++` at line 127), `lib/core/chainMiddleware/fetcher/request-options.ts` line 117–130 (request-prep condition re-check), `lib/core/chainMiddleware/fetcher/middleware.ts` line 35–38 (skip HTTP when `!requestOptions`), `lib/core/chainMiddleware/requester/init.ts` line 49–65 (`!batch` exits the loop).

## Trigger Internals

### Epoch Types

| Type     | Tracked State             | Sort Key                 |
| -------- | ------------------------- | ------------------------ |
| `id`     | `lastId`                  | `__itemId`               |
| `date`   | `lastDate`, `sameDateIds` | `[__itemDate, __itemId]` |
| `select` | selected items only       | —                        |

### Order Behavior

| Order       | Behavior                                                                   |
| ----------- | -------------------------------------------------------------------------- |
| `asc`       | Fetches past items, stops at known boundary                                |
| `desc`      | Fetches future items, continues until known boundary                       |
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

| Behavior                                            | Detail                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Consecutive slashes in `pathname` are collapsed** | `/foo//bar///baz` → `/foo/bar/baz` via `pathname.replace(/\/{2,}/g, '/')`. Users can safely supply a leading `/` in a mapped path param even if the URL template already adds one — the runtime will de-dup it.                                                                                                                                                                                                    |
| **Trailing slash on non-root paths is PRESERVED**   | `replace(/\/$/, '')` runs only when `pathname === '/'` (root). `/v0/apps/{id}/collections/{id}/` stays as-is. → **The app must prevent app-level trailing slashes** on APIs that treat `.../x` and `.../x/` as different resources (e.g., Adalo returns 400 on the `/` variant — see IEN-15136). Use `{{if(parameters.url, '/' + parameters.url, '')}}` instead of hardcoding `/` before an optional path segment. |
| **baseUrl + url join**                              | `joinBaseUrlAndUrl(baseUrl, url)` joins with a literal `/` when `url` is relative (`!/^https?:\/\//.test(url)`). Absolute `url` bypasses `baseUrl` entirely.                                                                                                                                                                                                                                                       |
| **Path encoding**                                   | If `encodeUrl: true` (default in most apps), the pre-query portion is run through `encodeURI()`.                                                                                                                                                                                                                                                                                                                   |
| **Query string**                                    | `legacy` mode: `encodeUrl: false` decodes the QS (except reserved `%20 %23 %26 %3F %3A`); the second `?` is rewritten to `&`; `?` with empty QS is dropped. `uniform` mode: QS is encoded iff `encodeUrl: true`, no `?→&` rewrite.                                                                                                                                                                                 |
| **Default ports stripped**                          | 80/443/21 are stripped under `legacy` mode only.                                                                                                                                                                                                                                                                                                                                                                   |
| **Hostname**                                        | Trailing dot removed; IDN→Unicode conversion currently disabled (2025-07-03 flag).                                                                                                                                                                                                                                                                                                                                 |

**Quick rule for path templates**: the runtime fixes internal double-slashes but will NOT fix a trailing slash. Any optional trailing path segment must be emitted conditionally from the app.

### Response Parsing

Determined by `response.type`:

| Type         | Behavior                      |
| ------------ | ----------------------------- |
| `json`       | `JSON.parse()`                |
| `xml`        | XML parser                    |
| `urlencoded` | Query string parser           |
| `text`       | Raw text                      |
| `binary`     | Buffer                        |
| `automatic`  | Auto-detect from Content-Type |

Wildcard matching: `"type": { "*": "json", "200-299": "json" }`

## ISC (Internal Service Communication)

Added in imt-app-runtime **v1.100.0** (2026-05-22, PR #663). Source: `lib/core/middleware/isc.ts`; spec doc: `ISC-SDK-APPS.md`; tests: `test/isc.spec.ts`.

The `isc` directive lets a **Make-owned** SDK app call Make's own internal services (over the cluster network via JWT mutual auth, `@integromat/isc`) instead of a public third-party API. The first consumer is `ai-module-builder-api` (the "Polymorph" / AI Module Builder modules); initial apps: airtable, google-calendar, google-docs, google-drive, google-forms, google-sheets, instagram-business, jira-software-cloud, pinterest, telegram.

### Directive shape

```json
{
	"isc": { "service": "ai-module-builder-api" },
	"url": "/v1/request",
	"method": "POST",
	"headers": { "Content-Type": "application/json" },
	"body": { "targetService": "google-calendar" },
	"qs": { "targetService": "google-calendar" },
	"response": { "output": "{{body}}" }
}
```

- `isc.service` — name of the target internal service. **Supports IML** (e.g. `{{parameters.svc}}`); must resolve to a **non-empty string** or the middleware throws.
- `url` — **required**, treated as a **relative path** (e.g. `/v1/rpc/parameters`). The base URL is resolved from the `INTEGROMAT_ISC_<SERVICE>_URN` env var, NOT from `base.imljson` `baseUrl`. App type definition: `api.isc?: { service: string }` and `flags.allowISC?: string[]` (`imt-app-runtime/lib/types.ts`).

### Middleware position & request bypass

`isc.initialize()` is wired into **all** API entry points (action, search, trigger, hook, rpc), positioned **after `agency` and before `prepareRequestOptions`**:

```
... → accman.validate() → agency.initialize() → isc.initialize() → prepareRequestOptions() → request() → ...
```

When `api.isc` is present, the middleware makes the call itself, then sets `REQUEST_MODE.DISABLED` + `responsePrePopulated = true`, so the standard HTTP requester is skipped. The response is fed into the **normal** response chain — `response.valid`, `response.error`, `response.output`, `response.iterate`, `response.temp`, `response.wrapper`, `response.type` parsing all work transparently and behave exactly like a regular HTTP call.

### Required preconditions (each throws `RuntimeError` if unmet)

Validated in this order inside `isc.initialize()`:

1. **`isc.service` resolves to a non-empty string** → else `ISC directive requires "isc.service" to resolve to a non-empty string.`
2. **`flags.allowISC` (array) includes the target service** → else `ISC directive requires the app to have the target service listed in the allowISC flag.` Set via `POST /admin/sdk/apps/:app/:ver/flags/allowISC` (Make-owned apps only). **Not part of the SDK code download** — it is app-level deployment config, so it cannot be reviewed from `download-app.js` output.
3. **No `pagination` directive** → ISC does not support pagination (fails loudly: `ISC directive does not currently support the "pagination" directive.`).
4. **No `encodeUrl` / `encodeUrlMode`** → ISC bypasses `normalizeUrl`, so these throw if present.
5. **`url` is present** → else `ISC directive requires a url field to specify the request path.` ⚠️ **This is the most common authoring bug** — commenting out / omitting `url` does NOT fall back to the benign URL-less-RPC behavior (that fallback lives in `prepareRequestOptions`, which never runs because `isc` short-circuits first).
6. **`packageName` present** → becomes the JWT issuer (`app#` prefix stripped).
7. **Per-service env vars present** → `INTEGROMAT_ISC_<SERVICE>_URN`, `INTEGROMAT_ISC_APP_RUNTIME_<SERVICE>_SECRET_NAME`, `INTEGROMAT_ISC_APP_RUNTIME_<SERVICE>_SECRET_VALUE` (service name normalized: uppercase, non-alphanumeric → `_`). Missing any → `Missing <KEY> environment variable...`.

### Request building parity with the standard requester

- `method` defaults to `GET`, uppercased. **GET never carries a body** even if `api.body` is set.
- `headers` lower-cased (`mapKeysLower`); a caller-supplied `Content-Type` is respected and not duplicated; JSON body auto-sets `content-type: application/json`.
- `qs` merged into the path; null/undefined stripped; array values expanded to repeated keys; an existing `?` in `url` is merged (no `?a=1?b=2`).
- `body`: IML-transformed (`rootArray: true` preserves a top-level array body); JSON-serialized for non-GET.
- `timeout`: `api.timeout` or default **40000 ms** (matches the standard requester).

### Error handling

All ISC failures are marked `imtExternalError = false` (platform errors, never surfaced as "external API error"):

| Situation                    | Result                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| HTTP 4xx                     | Error carrying service name + status; routable through `response.error` (e.g. `error.404`) |
| HTTP 429                     | `RateLimitError` (default mapping)                                                         |
| HTTP 5xx                     | `ConnectionError` — `"Service is temporarily unavailable."`                                |
| Network / connection failure | `RuntimeError` (`ISC call to "<service>" failed: <msg>`)                                   |

### Security model (defense in depth)

`allowISC` can only be set on Make-owned apps (system user or `@make.com`/`@integromat.com` author); blocked on ownership transfer; stripped on clone/version to non-Make owners. Runtime checks the allowlist; the JWT `iss` claim = the app's `packageName` (cannot be spoofed); the target service validates the issuer against its own `ALLOWED_ISSUERS` (deny-all when unset).

### Limitations

- **No `pagination`** and **no `encodeUrl`/`encodeUrlMode`** (throw if present).
- **No recording/replay** — `REQUEST_MODE.DISABLED` skips the requester's recording logic.
- **Make-owned apps only** — community/third-party SDK apps cannot use ISC.

### Code-review implications

- **A url-less ISC component is a blocking bug**, not a pure-data RPC. Flag it. (Real case: IEN-15506 — `google-calendar` `getParameters` RPC had `//"url": "/v1/rpc/parameters"` commented out; the module's dynamic `expect` failed to load every field at runtime.)
- **Mocked component tests do NOT exercise ISC validation** — the test harness intercepts the call before `isc.initialize()` runs, so a passing module/RPC integration test does **not** prove `url`/`allowISC`/env are correct. ISC paths can only be validated against a real backend (typically `hqrelease`).
- **`flags.allowISC` + the `INTEGROMAT_ISC_*` env vars are out of code-review scope** — they are deployment config, not in the SDK download. Note them as a pre-production verification item rather than a code finding.
- **Do not false-flag** `isc`, `getFieldMapping`, or `safeSerialize` as unknown directives/functions — all are runtime-provided and verified.

### AI Module Builder rollout — the canonical 9-change component set

Epic IEN-15500 ports the same "AI Module Builder" (Polymorph) module into every Make-owned app one ticket at a time (google-sheets IEN-15502, google-forms IEN-15505, google-calendar IEN-15506, slack IEN-15987, …). Every one of those tickets produces the **same 9 changes**. Use this as the review checklist; anything missing is a gap, anything extra needs a reason.

| #   | `group/item/code`                                              | Expected content                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `app//groups`                                                  | New `AI` group containing only the new module. Existing groups must be untouched → pure addition, never a Breaking Change.                                                                                                                                                                                                                                                 |
| 2   | `module/aiModuleBuilder/api`                                   | ISC `POST /v1/request` to `ai-module-builder-api`. Body: `organizationId={{scenario.organizationId}}`, `scenarioId={{scenario.id}}`, `instanceId={{scenarioModuleId}}`, `targetService="<app-slug>"`, `parameters.mappings={{safeSerialize(getFieldMapping('task'))}}` plus `forceRegenerate`/`safetyMode`/`executionMode`, `auth.accessToken={{connection.accessToken}}`. |
| 3   | `module/aiModuleBuilder/expect`                                | `[ "rpc://parametersAiModuleBuilder" ]` — fields are owned by the backend, so field names cannot be verified from app code.                                                                                                                                                                                                                                                |
| 4   | `module/aiModuleBuilder/interface`                             | `[ "rpc://interfaceAiModuleBuilder" ]`                                                                                                                                                                                                                                                                                                                                     |
| 5   | `module/aiModuleBuilder/scope`                                 | **Must not stay `[]`.** Union of the scopes the backend needs to act on the user's behalf, matching the app's other modules.                                                                                                                                                                                                                                               |
| 6–7 | `module/aiModuleBuilder/account_name` + `attached_accounts`    | The parent app's existing connection — the module never declares its own connection parameter.                                                                                                                                                                                                                                                                             |
| 8–9 | `rpc/{interfaceAiModuleBuilder,parametersAiModuleBuilder}/api` | ISC `GET /v1/rpc/interface` / `/v1/rpc/parameters` + `qs.targetService=<app-slug>`, `response.iterate = {{body}}`, `output = {{item}}`, empty `parameters.imljson`.                                                                                                                                                                                                        |

Two items are **not** in the ticket's reference snippet but belong in every implementation — both were added to earlier apps only after a production incident, so treat their absence as an Improvement:

- **`log.sanitize: ["request.headers.authorization", "request.body.auth"]`** on the module `api`. Without it the OAuth access token is written in cleartext to run/debug logs, because the token is deliberately placed in `body.auth.accessToken`. (Root of google-calendar IEN-15714.)
- **A non-empty module `scope`.** An empty `scope.imljson` means the connection token is minted without the permissions the backend needs → the backend's first call fails with the vendor's insufficient-scope error (google-calendar hit `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`).

Recurring non-findings on these tickets — do not flag:

- `api.timeout` (typically `300000`) on the module. ISC honors `api.timeout`; 300 s is the platform maximum.
- `base.imljson` `baseUrl` pointing at the vendor API. ISC resolves its base from `INTEGROMAT_ISC_<SERVICE>_URN`, so there is no conflict.
- A module `scope` entry that is absent from the connection's `scopes.imljson`. That file is the _additional-scope picker catalog_; the active scope set is a union that includes module scopes (see `component-patterns-reference.md` § "OAuth Scope Files").
- `(beta)` in the module label — the lowercase parenthetical is the documented tag format (`app-ux-best-practices.md`).
- Missing `make-apps-mockup` fixture for the new module. It is an AC gap worth reporting, but a mocked test cannot validate ISC anyway (see above), so it is never a blocker.

## Inline Endpoint Calls (`api.endpoint`)

Added in imt-app-runtime **v1.102.0** (2026-07-23, PR #694); reference-resolution changed in **v1.102.3** (2026-07-29, PR #713 — see § "Endpoint references are STATIC" below). Source: `imt-app-runtime` master `lib/core/chainMiddleware/endpoint.ts` + `lib/api/rpc.js` + `lib/types.ts` (verified 2026-08-06). SDK Endpoint entity itself: [endpoints-reference.md](endpoints-reference.md).

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

| IML path     | Resolves to (JS)            | Notes                                                       |
| ------------ | --------------------------- | ----------------------------------------------------------- |
| `foo[]`      | `foo[0]` (first element)    | Empty brackets default to `n = 1` → `arr[n - 1]` = `arr[0]` |
| `foo[1]`     | `foo[0]` (first element)    |                                                             |
| `foo[2]`     | `foo[1]` (second element)   |                                                             |
| `foo[3].bar` | `foo[2].bar`                |                                                             |
| `foo[0]`     | **`foo[-1]` → `undefined`** | **Common bug.** `[0]` is never what you want.               |

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

| Limit                             | Default                      | Overridable via                 |
| --------------------------------- | ---------------------------- | ------------------------------- |
| `maxRequestCount`                 | 100                          | `common.imljson`                |
| `maxPaginationRequestCount`       | 50                           | `common.imljson`                |
| `maxPastRecords`                  | 3200                         | `common.imljson`                |
| Request timeout                   | 40,000ms                     | `common.timeout` (max 300s)     |
| Repeat max iterations             | 1000                         | `repeat.limit` (capped at 1000) |
| Pagination initial limit          | 20                           | —                               |
| Pagination max limit (auto-scale) | 500                          | —                               |
| Unordered trigger memory          | max(`maxPastRecords`, 5000)  | —                               |
| Data collection max size          | 65,536 bytes (64KB)          | —                               |
| Sandbox timeout                   | 10,000ms (prod) / 50ms (dev) | —                               |
| Sandbox memory                    | 2,048MB                      | —                               |
| Max redirects                     | 21                           | —                               |
| Default trigger limit             | 1                            | `parameters.limit`              |

## Environment Variables

Two separate `environment`-related features exist in the runtime, plus a third flag-gated context root (`internal`) that is unrelated to either. Do NOT confuse them.

### Scenario Environment (`environment`)

The user's Make scenario runtime environment. Passed directly to the IML context — **always available without any flags**.

Source: `buildContext()` in `runtime.js`:

```js
environment: instance.environment || {},
```

Available in IML as `{{environment.xxx}}`:

| Property               | Description                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `environment.timezone` | Scenario timezone (from org settings). Also injected into IML function sandbox for `formatDate()`/`parseDate()` |
| `environment.debug`    | Debug mode flag                                                                                                 |
| `environment.audit`    | Audit logging flag                                                                                              |
| `environment.verifier` | Verifier mode flag                                                                                              |

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
	passthrough: manifestVersion >= 2,
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
	Object.defineProperties(
		envProxyBase,
		envProxyProperties.reduce((acc, property) => {
			acc[property] = {
				configurable: false,
				enumerable: false,
				get: () => process.env[property],
				set: undefined,
			};
			return acc;
		}, {}),
	);
	Object.freeze(envProxyBase);
	module.environment.system = envProxyBase;
}
```

- Requires `flags.environmentAccess` (array of strings) in `common.imljson`
- Exposes enumerated `process.env` properties as `{{environment.system.VAR_NAME}}`
- Frozen, non-enumerable, read-only — high security design
- **NOT related to `{{environment.timezone}}`** — that comes from the scenario environment

### Make-Infrastructure Data (`internal` / `flags.exposeInternalProperties`)

Added in imt-app-runtime **v1.103.0** (2026-08-05, PRs #726 + #727). Source: `buildExposedInternal()` + `buildContext()` in `lib/core/runtime.js`, `APPContext.internal` / `flags.exposeInternalProperties` in `lib/types.ts`; tests: `test/expose-internal-properties.spec.ts`. Property catalog: [Environment Context in App](https://make.atlassian.net/wiki/spaces/IEN/pages/776536116/Environment+Context+in+App).

A **third, separate** flag-gated root — not an `environment` feature despite living next to one. The Engine hands Make-infrastructure data (team identity, ISC service URNs) to the module instance as `internal` (generated by scenario finalization as `internalData`, handed over deep-frozen). Before v1.103.0 the runtime never read it — `buildContext()` builds the IML context from an explicit whitelist that omitted it, so `{{internal}}` always resolved to nothing.

```js
function buildExposedInternal(instance) {
	const exposedProperties = instance.flags?.exposeInternalProperties;
	if (exposedProperties === undefined) return undefined;
	if (!Array.isArray(exposedProperties)) {
		console.error(`App ${instance.packageName} has app flag 'exposeInternalProperties' that is not an array: ...`);
		return undefined; // do NOT fail the execution
	}
	const exposedInternal = _.pick(instance.internal, exposedProperties);
	Object.freeze(exposedInternal); // shallow
	return exposedInternal;
}
```

| Aspect                | Behavior                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Grant                 | `flags.exposeInternalProperties` — **admin-granted**, a real trust boundary for internal Make apps. An app developer cannot self-grant it. No grant → `{{internal}}` is `undefined`, byte-for-byte as before. |
| Must be enumerated    | Always an array of property paths. Dot paths supported (`'service.trigger'`); a whole key also works (`'service'` grants everything under it). Strings, numbers, booleans and `null` values all project.       |
| Malformed grant       | A non-array (e.g. `true` — a wholesale grant) is **refused**: `console.error` once per `runtime.run()`, exposure skipped, **execution keeps running**. Contrast `flags.environmentAccess`, which *throws*.    |
| Empty grant           | `[]` → `{{internal}}` is `{}` (defined but empty), not `undefined`.                                                                                                                                          |
| Engine sent nothing   | Older blueprints with no `internalData` → empty projection `{}`, never an error.                                                                                                                              |
| Freeze                | The projection is **shallow**-frozen. Known limitation: when dot paths are granted, `_.pick()` recreates the intermediate containers and those are not frozen, so an app can add properties to them.          |
| Custom IML functions  | Also a sandbox **global** named `internal`, fed via the `functionSandbox` of `buildImlFunctions()` — exactly like `environment`. Reachable from both IML templates and app function code (#727).               |

Usage in `api.imljson` once granted:

```json
{
	"temp": {
		"triggerUrn": "{{internal.service.trigger.urn}}",
		"teamId": "{{internal.team.id}}"
	}
}
```

**Code-review notes.** Treat any `flags.exposeInternalProperties` addition as a permission change, not a code change — it needs admin approval, so confirm the ticket carries it. Flag a boolean/non-array grant: it is silently degraded to no access (only a server log), so the app appears broken with no app-visible error. Flag `{{internal.*}}` reads with no matching grant path for the same reason — they resolve to nothing rather than failing loudly.

**Verifying the real grant (mandatory before flagging as "unconfirmed").** Do NOT leave a `{{internal.*}}` / `{{internal}}` read as a mere "needs discussion, please confirm with admin" note when the actual grant is one API call away. The app's current `flags` (including `exposeInternalProperties`) are readable with the configured `make-api-key`:

```bash
curl -s "{make-api-url}/sdk/apps/{slug}/{version}?cols[]=flags" \
  -H "Authorization: Token {make-api-key}"
# → { "app": { "flags": { "exposeInternalProperties": ["organization"], ... } } }
```

(`{make-api-url}` / `{make-api-key}` come from the last lines of `SKILL.md`; same admin API the skill scripts already use.) Then apply the whole-key rule from the table above: a change reading `internal.organization.customApps.x` is **already covered** if the grant array contains `"organization"` (whole key) — no new permission needed, not a blocker. It is **only** uncovered — and only then a real "needs admin grant" blocker — if the existing grant is scoped to a narrower/different dot-path (e.g. `"organization.someOtherField"`) that doesn't include the property being read. Only report "could not verify, please confirm with admin" if this API call itself fails (e.g. no admin scope on the configured key) — never as a default fallback when the call was simply not attempted.

### Quick Reference

| What you need              | IML expression                       | Flags required?                                                      |
| -------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| Scenario timezone          | `{{environment.timezone}}`           | No                                                                   |
| Scenario debug mode        | `{{environment.debug}}`              | No                                                                   |
| Server env var `FOO`       | `{{environment.system.FOO}}`         | Yes — `flags.environmentAccess: ["FOO"]` in common                   |
| Team id / ISC service URNs | `{{internal.service.trigger.urn}}`   | Yes — `flags.exposeInternalProperties: ["service.trigger"]`, **admin-granted** |

## OAuth Connection Variables

Available inside `connections/{name}/api.imljson` (`authorize`, `token`, etc.). Sourced from `accounts/app-runtime-oauth2/lib/account.js` `get redirects()` (and the OAuth1 equivalent at `accounts/app-runtime-oauth1/lib/account.js`).

| Variable                     | Resolves to                                                                                           | When to use                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{oauth.localRedirectUri}}` | `https://<environment.host>/oauth/cb/{connection-name}` — the **current instance's host**             | **Default for new connections.** Host-aware, works on Make-hosted **and** self-hosted instances.                                                                              |
| `{{oauth.redirectUri}}`      | `https://<environment.redirects.integromat>/oauth/cb/{connection-name}` — **always `integromat.com`** | **Legacy.** Pre-Make-rebrand callback. Avoid in new code; migrate when touched.                                                                                               |
| `{{oauth.makeRedirectUri}}`  | `https://<environment.redirects.make>/oauth/cb/{connection-name}` — **always `make.com`**             | Make-only deployment (breaks self-host). Use only when the upstream provider has a hard `make.com`-only redirect registered AND self-host support is explicitly out of scope. |
| `{{oauth.scope}}`            | Array of scope strings declared in `scope.imljson` / `scopes.imljson`                                 | Joined into the authorize URL via `join(oauth.scope, ' ')` (Google) or `','` (others).                                                                                        |
| `{{oauth.state}}`            | Runtime-injected CSRF-safe state token, validated automatically on callback                           | Always set `"state": "{{oauth.state}}"` in `authorize.qs`.                                                                                                                    |

When `environment.redirects` is unset (legacy environment configuration), all three redirect-URI variables collapse to the same host-based URI, so `localRedirectUri` is also the safest backward-compatible choice.

**Cross-reference**: full convention + code-review checklist live in `component-patterns-reference.md` § "OAuth2 Connection — `redirect_uri` Convention" and `code-review-criteria.md` § "OAuth `redirect_uri` Convention".

### `token.response.scope` — record the scope the provider actually granted

Added in imt-app-runtime **v1.101.0** (2026-07-18, PR #693); follow-up fix **v1.101.1** (2026-07-20, PR #709). Source: `accounts/app-runtime-oauth2/lib/account.js` (`token()`, `saveScope()`, `_setScope()`, `_normalizeScope()`); tests: `test/account.spec.js` § "directive `token.response.scope`" + `test/account-set-scope.spec.ts`.

```json
"token": {
	"url": "https://provider.example/oauth/token",
	"method": "POST",
	"response": {
		"data": { "accessToken": "{{body.access_token}}" },
		"scope": "{{body.scope}}"
	}
}
```

Before this directive the platform only knew the scopes it **requested**; if the user granted a subset, that was invisible (the source calls it out as a known limitation). `token.response.scope` lets the token endpoint report what was actually granted, per RFC 6749 § 3.3.

| Aspect              | Behavior                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Value               | IML-evaluated. Accepts a string array, a space-delimited string (RFC 6749 § 3.3), a comma-delimited string, or a mix — `_normalizeScope()` splits on `/[\s,]+/` and drops empties. Any other type → `[]` (treated as "not reported"). |
| Precedence          | A non-empty result **overrides** the stored scope — it does **not** merge. The token response is authoritative, so a revoked scope drops off on the next exchange.                                                                    |
| Fallback            | Empty / absent → previous behavior: `acceptedScope` (the scopes sent to the authorization server) is merged into the stored scope and deduplicated.                                                                                   |
| `token` as an array | Each communication item is checked; the **last** item reporting a non-empty scope wins. A scope-less follow-up item (e.g. a long-token request) cannot erase an earlier item's scope.                                                 |
| Client Credentials  | With no authorize/callback step there is no `acceptedScope`, so this directive is the **only** way to record scope for that flow.                                                                                                     |

**Not supported under `refresh` — by design.** `saveScope()` is wired into `token()` only. A refresh renews the access token; it is not an authorization event, so it must not change the recorded grant. Changing scope requires re-authorizing the connection. `refresh.response.scope` is silently ignored — flag it in review.

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
