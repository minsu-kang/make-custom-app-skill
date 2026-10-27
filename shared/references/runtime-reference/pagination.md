# Runtime reference: Pagination Internals

> Read when: reviewing or writing `pagination`: initial values, auto-scaling, stop conditions, `mergeWithParent`, the double evaluation of `pagination.condition`. Part of [runtime-reference.md](../runtime-reference.md).

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
