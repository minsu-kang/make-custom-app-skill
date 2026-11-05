# Runtime reference: pagination

> Read when: reviewing or writing `pagination`: the page/offset/limit sequence, when paging stops, how each round's request is built (`mergeWithParent`, `pagination.url`, method, qs, headers, body), the delay, and the double check of `pagination.condition` with its off-by-one. Part of [runtime-reference.md](../runtime-reference.md).

The `pagination` directive makes Make send a request again, round after round, until a stop rule fires. Round 1 is the request as written. A polling trigger pages by extra rules of its own (see [polling-triggers.md](polling-triggers.md#order-and-pagination)). An instant trigger never pages: a `pagination` block on it is ignored.

## Page, offset and limit

`{{pagination.page}}`, `{{pagination.offset}}` and `{{pagination.limit}}` can be read by the request directives, the `response` directives and `pagination.condition`. They start at these values:

| Property | Default |
| -------- | ------- |
| `page`   | 1       |
| `offset` | 0       |
| `limit`  | 20      |

Each time Make continues paging, it changes the three values in one step, in this order:

1. `page` goes up by 1.
2. `offset` goes up by the OLD limit, the limit of the round just finished.
3. `limit` becomes `min(limit × 5, 500)`.

So the rounds see:

| Round | `page` | `offset` | `limit` |
| ----- | ------ | -------- | ------- |
| 1     | 1      | 0        | 20      |
| 2     | 2      | 20       | 100     |
| 3     | 3      | 120      | 500     |
| 4     | 4      | 620      | 500     |
| 5     | 5      | 1120     | 500     |

The values do not depend on what the API returned. Pairing `offset` with `limit` is correct only if every page returns exactly `limit` items. If the API caps a page below the limit Make sends (a cap of 50 while `limit` is 100), round 2 gets records 20 to 69 and round 3 asks for offset 120, so records 70 to 119 are never requested. For such an API, take the next offset from the response or from `temp` (see [Pagination Patterns](../communication-reference.md#pagination-patterns)).

Every item of an `api` array starts again at page 1, offset 0 and limit 20.

## When paging stops

Make stops after the current round when any of these holds:

- The item has no `pagination` directive, or it has neither a `url` nor an inline `endpoint` to repeat.
- `pagination.condition` is false. Make checks it twice per round (see the last section).
- 50 extra requests were made (`maxPaginationRequestCount`, default 50). The first request does not count, so a request item sends at most 51 requests.
- `maxPastRecords` raw items were reached (default 3200).
- The page result is not a list, for example a `response.output` that gives an object.
- The page result is an empty list (after `response.iterate`, `iterate.condition` and `response.output`), unless `pagination.stopOnEmptyResponse` is `false`.
- `response.output` is `false` or `null`: that page gives no result and paging stops. This does not hold when `response.iterate` is set without its own `transform`: then the value is ignored, the raw items are output and paging goes on (see [iterate](../runtime-reference.md#iterate)).
- The items collected over all pages so far (after `iterate.condition` and `response.output`) reach `response.limit`. A literal `0`, `null`, an empty value or a non-integer does not stop paging. Neither does an expression that evaluates to the number 0: in a module that cuts its result (search, RPC, Endpoint, polling trigger) it fails once all pages were fetched with InvalidConfigurationError "Limit cannot be zero.", and an action, which has no cut, raises nothing (see [limit](../runtime-reference.md#limit)). The text `"0"`, which a text parameter gives when the user types 0, reads as the number 0 and does stop paging after the first page. In a module that cuts its result the cut then keeps nothing; an action, which has no cut, returns the first page.
- The scenario is stopped or the module times out: the request in flight finishes and no further round starts.

Details:

- **`maxPastRecords`** counts the raw items that pass through `response.iterate`, before `iterate.condition` drops any, and it applies to every module type, not only triggers. Without `response.iterate` it never fires. The page that crosses the line is kept whole. A value of `0` stops paging after the first page.
- **`maxRequestCount`** (default 100) is read but never enforced: nothing stops on it, so setting it lower changes nothing. The public docs describe 100 requests for all requests of one module; a platform-level cap cannot be ruled out, so the platform may differ.
- **`stopOnEmptyResponse`** defaults to `true`. With `false`, an empty page does not stop paging, and the other rules, `pagination.condition` above all, decide. Setting it to `false` without a `pagination.condition` fails right after the first response with InvalidConfigurationError "pagination.condition must be set when using pagination.stopOnEmptyResponse". The public docs do not name this flag; they only say paging stops after a response with 0 records, which is the default.
- The page of the round that ends paging is kept, except an empty one or one without a result.
- A polling trigger with `order` `desc`, `unordered` or no `order` keeps paging past its `response.limit`. See [polling-triggers.md](polling-triggers.md#order-and-pagination).

## How each round's request is built

Rounds 2 and later start from the first request as it was built, not from what the previous round sent. `pagination.mergeWithParent` and `pagination.reEvalParent` both default to `true`.

**url.** `pagination.url` replaces `url` whole when it is set: the two are never merged, and the inline query of `url` is not carried over. Whichever is used is evaluated again with the current `{{pagination.*}}` values, joined to `baseUrl` when it is relative, and encoded and normalised like the first URL.

| Part | `mergeWithParent: true` (default) | `mergeWithParent: false` |
| ---- | --------------------------------- | ------------------------ |
| method | `pagination.method`, else the first request's method | `pagination.method`, else GET |
| qs | the inline query of the round's url, then the parent `qs`, then `pagination.qs`; later keys win | the inline query of the round's url, then `pagination.qs`; the parent `qs` is left out |
| headers | the first request's headers, then `headers` evaluated again (unless `reEvalParent` is `false`), then `pagination.headers` | `headers` evaluated again (unless `reEvalParent` is `false`), then `pagination.headers` |
| body | see below | only `pagination.body`, if given |

All of these are evaluated again with the current `{{pagination.*}}` values, with one exception: with `reEvalParent: false` the `headers` directive is not evaluated again. With `mergeWithParent` the round then keeps the header values of the first request; without it the directive is left out. `reEvalParent` has no effect on `qs` or `body`. Because the parent `qs` is applied again on top of the query of a next-page URL, by default it also overrides same-named keys there.

**Body.**

- A GET round never sends a body, and no `Content-Type` derived from the first body.
- A non-GET round sends no body unless `pagination.body` is given.
- With `mergeWithParent` and `type` `json`, `urlencoded` or `multipart/form-data` (a missing `type` counts as `json`), an object `pagination.body` is deep-merged over the parent body, which is evaluated again. Arrays are replaced whole, not merged. So even `"pagination": { "body": {} }` sends the parent body again.
- In every other case (a text, binary or array body, a non-object `pagination.body`, or `mergeWithParent: false`) `pagination.body` replaces the body.

```json
{
	"method": "POST",
	"body": { "filter": "x" },
	"pagination": { "body": { "page": "{{pagination.page}}" } }
}
```

Round 2 sends the body `{"filter":"x","page":2}`.

**Applied to every round.** The redirect cap (see [redirects](../runtime-reference.md#redirects)), the cookies of `shareCookies`, and the AWS and OAuth 1 signatures are applied again in each round, so each round is signed for its own URL and body.

**The public docs.** They summarise this as "url, method and body override regardless; headers and qs merge". What Make does differs in three places. The method overrides only when `pagination.method` is set: with `mergeWithParent: false` and no `pagination.method` the round is a GET, not the first request's method. The body is deep-merged with the parent body, not overridden, when `mergeWithParent` is on and both bodies are objects of `type` `json`, `urlencoded` or `multipart/form-data`. And the parent `qs` is applied again over the query of `pagination.url`.

## Delay between rounds

`pagination.delay` is an IML expression for a wait in milliseconds. Make clamps the result to 0 to 30000: a negative or non-numeric value gives 0. Without it there is no wait.

- It is evaluated and waited after a response, only when another round is going to follow. A condition that ends paging on the response itself causes no wait.
- A condition that is false only at the second check (for example `pagination.page <= 3`) still waits once before it stops, because Make only learns that at the check before the next request. No request is sent after that wait.
- A scenario stop or a module timeout cuts a running delay short, and no further round starts.
- The delay is not part of the request timeout. The 40 s timeout (see [timeout](../runtime-reference.md#timeout)) applies to each HTTP request on its own. The public docs say the delay counts toward a 40 s limit; a module-level time budget is set outside the runtime, so the platform may differ.

## `pagination.condition` is checked twice per round

`pagination.condition` is not a single check after the response. Make evaluates it at two points of every round, and the two points see different values of `{{pagination.page}}`, `{{pagination.offset}}` and `{{pagination.limit}}`. Both see the same `{{body}}`.

1. **After the response.** The values are those of the page just fetched, page N.
   - If the condition is false, paging ends.
   - If it is true, Make moves on: `page` becomes N+1 and `offset` and `limit` advance as described above.
2. **Before the next request is built.** The values are those of the page about to be requested, page N+1.
   - If the condition is false, no request is sent. Paging ends cleanly and no extra HTTP request is made. When this second check is what ends paging (a condition on `pagination.page`, `offset` or `limit`, the `>=` form included), Make still runs the response directives of one more round over an empty response, and its empty list becomes the output of the last page. An action, or a search or RPC with a `response.wrapper`, builds its result from the last page alone, so it loses the last fetched page: an action with `"wrapper": { "x": "{{output}}" }` and `{{pagination.page <= 3}}` returns `{"x":[]}` after 3 requests. A body-driven condition, or a `response.limit` stop, ends paging on the first check and keeps the last page. A search or RPC without a wrapper keeps all its pages.
   - If it is true, the request is built with the new values and sent.

The second check is the real stop gate; the first only decides whether another round starts at all. This is intended, but it causes a non-obvious off-by-one whenever the expression uses `pagination.page` directly. The same holds for `pagination.offset` and `pagination.limit`: with `{{pagination.offset < 20}}` Make sends one request, because the second check already sees offset 20.

**Off-by-one trap: `>` versus `>=`.** Take a `total_pages`-style API (for example Aha!, where `body.pagination.total_pages` is the number of pages and `pagination.page` is sent as `qs.page`) with `total_pages` = 3:

| Condition | After the response of page N (sees page N) | Before the request of page N+1 (sees page N+1) | Effect with `total_pages` = 3 |
| --------- | ------------------------------------------ | ----------------------------------------------- | ----------------------------- |
| `total_pages > pagination.page` | after page 2: `3 > 2`, true | before page 3: `3 > 3`, false, so the request is skipped | Loses the last page: 2 requests, only pages 1 and 2 returned |
| `total_pages >= pagination.page` | after page 3: `3 >= 3`, true | before page 4: `3 >= 4`, false, so no request is sent | Correct: 3 requests for 3 pages, and no fourth request |

**Rule.** When the condition is built around `pagination.page`, use `>=`, not `>`. With `>` the last page is never fetched, because the second check sees the page number after it was incremented. The inverted forms follow the same rule: prefer `pagination.page <= total_pages` over `pagination.page < total_pages`. For an API that reports the count in a header, `{{pagination.page <= headers['x-totalpages']}}` is the same as `total_pages >= pagination.page` and is correct.

```json
"pagination": { "condition": "{{pagination.page <= body.pagination.total_pages}}" }
```

**Body-driven conditions are immune.** A condition that reads fields of the response just received (`body.current_page`, `body.has_more`, `body.next_cursor`) and not the page counter gives the same answer at both checks, so `<`, `>` and `==` behave as they read. For examples see [Pagination Patterns](../communication-reference.md#pagination-patterns).
