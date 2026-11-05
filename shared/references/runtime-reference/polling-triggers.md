# Runtime reference: polling triggers

> Read when: writing or reviewing a polling trigger's `api.imljson`: `response.trigger` keys, id and date parsing, which items are emitted and in what order, the saved state (`{{data.lastId}}`, `{{data.lastDate}}`), "Choose where to start" (`select`, `{{trigger.matchEqual}}`), items that share a date, `order` and pagination, the default limit, output rules and ignored directives. Part of [runtime-reference.md](../runtime-reference.md).

A polling trigger is a trigger module whose `api.imljson` has a `response.trigger` block. On every scenario run Make asks the API, keeps only the items it has not emitted before, and returns them oldest first. Which items count as new is decided by the saved state of the previous runs. The sections below follow one run: how items are identified, which ones are emitted, what is saved, and how paging and the limit shape the result. For the request itself and for paging in general see [pagination.md](pagination.md).

```json
"response": {
	"iterate": "{{body.items}}",
	"trigger": { "id": "{{item.id}}", "date": "{{item.created_at}}", "type": "date", "order": "desc" },
	"limit": "{{parameters.limit}}"
}
```

## response.trigger: type, id and date

| Setting | What it does | Evaluated |
| ------- | ------------ | --------- |
| `type` | `id` or `date`: what the trigger compares to find new items | once per request |
| `order` | `asc`, `desc` or `unordered`: how the API sorts its list | once per request |
| `id` | the item's id | per item, against `{{item}}` |
| `date` | the item's date | per item, against `{{item}}` |

- `type` and `order` are IML expressions. They are evaluated before the request is sent, so they can read `parameters`, the top-level `temp`, `data` and similar, but not `{{body}}` or `response.temp`. Both are case-sensitive: `ID` is not `id`, and `UNORDERED` counts as no order. An RPC that declares the same block compares `type` literally, so an expression there is not evaluated.
- `{{item}}` in `id` and `date` is the raw element of `response.iterate`, before `response.output` maps it. The mapped output does not need to contain the id or the date.
- Ids and dates are read per iterated item, so an ordered trigger needs `response.iterate`. Without it every item has no id or date, and nothing is emitted, even when the output is a list (see [Output rules and ignored directives](#output-rules-and-ignored-directives)).
- If `type` is set but `id` is missing or empty, the run fails before any request with InvalidConfigurationError "Invalid response.trigger.id. Item id specifier must be present".
- If `response.trigger` is missing entirely, every item is dropped because it has no id, so the trigger never outputs anything.

What each `type` tracks and sorts by:

| `type` | Tracked state | Sorted by |
| ------ | ------------- | --------- |
| `id` | `lastId` | the id, as a number |
| `date` | `lastDate` and the list of ids that share it | the date, then the id |
| any other value, or none | `lastId` | the id as given |

**Ids.**

- With `type: "id"` each id goes through `parseInt`: `"123abc"` becomes 123 and `"abc"` becomes NaN. Ids are then compared as numbers.
- With `type: "date"`, or any other value, ids stay as they are, so string ids compare as text: `"10"` sorts before `"9"`. In a date trigger this decides the order of items that share a date.
- An id that parses to NaN breaks the ordering: it sorts last, and every comparison with it is false, so it is never skipped as already seen. It is emitted again on every run, and when it is the last emitted item the saved id becomes NaN and nothing is skipped from then on.

**Which items are dropped.** After `response.iterate` and `response.output` have run, each page is filtered, before the step that removes already seen items. Only an item whose sort field is null or undefined is dropped, and only when `order` is not `unordered`:

| `type` | Sort field | Dropped |
| ------ | ---------- | ------- |
| `date` | the parsed date | a missing, empty or unparseable `date`. A missing id does NOT drop the item: the id is not checked, and the item is kept with an empty id |
| `id` | the id as a number | nothing for a missing or non-numeric id: it becomes NaN, which is not null, so the item is kept (see above) |
| any other value, or none | the raw id | a missing (null or undefined) id |

- A date trigger with no `response.trigger.date` at all has no date for any item: an ordered trigger emits nothing, and an `unordered` one fails with RuntimeError "Cannot read properties of undefined (reading 'getTime')".
- `order: "unordered"` skips this filter, but a later step compares each item's date with the saved date, and there an item with an unparseable date is rejected.
- If every item of a page is dropped, paging stops.
- Items that were already seen are removed by a separate step (see [Which items are emitted, and in what order](#which-items-are-emitted-and-in-what-order)).

**Dates.**

- Item dates, and the saved date, are parsed in the scenario's timezone unless the text carries an offset or `Z`. ISO 8601, `YYYY-MM-DD`, `D.M.YYYY` and similar formats are read. A value with slashes such as `05/01/2024` is read month first (May 1).
- A value made only of digits is read as MILLISECONDS since 1970, as a string or as a number. A Unix timestamp in seconds is therefore misread (`1704448800` becomes January 20, 1970). Convert it first, for example with `{{item.created_at * 1000}}`.
- An unrecognised value gives no date, and the item is dropped. Month names (`Jan 5, 2024 10:00`) and RFC 2822 dates (`Fri, 05 Jan 2024 10:00:00 GMT`) are not recognised; map them to ISO 8601 first.
- A date with an impossible part, such as `2024-02-30`, is not rejected. In UTC it rolls over (March 1). In other timezones it becomes an invalid date that does not drop the item, and the saved date is then invalid, so every item is emitted again on each run.

## Which items are emitted, and in what order

- A trigger always emits items sorted ascending, oldest first: by date, then id, for a date trigger, and by id otherwise. This is the same for `asc` and `desc` APIs.
- When more new items exist than the limit, Make emits the OLDEST new ones, and the rest come on the next run. With 200 new items and a limit of 100, run 1 emits ids 0 to 99 and run 2 emits ids 100 to 199.
- For id triggers, items whose id is at or below the saved `lastId` are skipped. On the first run after "Choose where to start" (epoch type `select`) the selected item itself is INCLUDED, and the normal exclusion applies from then on (details in [Choose where to start](#choose-where-to-start-select-and-triggermatchequal)).
- With no saved id, for example an epoch without an id, every item is new.
- The Make platform sets the epoch, outside the IMLJSON. The trigger reads only its `id`, `date` and `type`, and treats only `select` specially. Whatever the epoch type, its date becomes the starting `lastDate`, and its id, read with `parseInt` and kept only if it is a safe integer, the starting `lastId`; an id such as `"b2"` gives no `lastId`.
- For date triggers, what "already seen" means is described in [Items that share a date](#items-that-share-a-date).

## Saved state ({{data.lastId}} and {{data.lastDate}})

After a run that emits items, the trigger stores:

- `lastId` and `lastDate` of the NEWEST emitted item. `lastDate` stays empty unless `response.trigger.date` is set, so it is empty for an id trigger without a date, and a request then reads `{{data.lastDate}}` as 1970-01-01T00:00:00.001Z. For an id trigger `lastId` is a number; for other types it is the id as given.
- The ids that share the newest date (see [Items that share a date](#items-that-share-a-date)).
- The starting choice of "Choose where to start" is cleared; only a picked id stays (see the next section).

Requests read the state as `{{data.lastId}}` and `{{data.lastDate}}`, for example as an API `since` or `after` filter. In a `qs` a date is sent in ISO 8601 form.

```json
"qs": { "after": "{{data.lastId}}", "limit": 20 }
```

- With nothing saved yet, `{{data.lastId}}` is empty and `{{data.lastDate}}` is 1970-01-01T00:00:00.001Z, not empty.
- On the first run after the user picks an item, `{{data.lastId}}` is the picked id; see [Choose where to start](#choose-where-to-start-select-and-triggermatchequal) for how it is read.
- If nothing is new, the state stays as it was and the run returns no bundles.
- If the scenario run is rolled back, the state reverts to what it was before the run, and the same items are emitted again next time.
- `response.data` is also merged into this trigger data, so `{{data.cursor}}` carries a `cursor` entry to the next run (shallow merge, 64 KB limit; see [response.data, response.metadata and audit](../runtime-reference.md#responsedata-responsemetadata-and-audit)). It is applied at the end of every run, also when nothing was emitted, and after `lastId` and `lastDate` are saved: a `response.data` entry named `lastId` or `lastDate` overwrites the saved value. A merge over 64 KB fails the run with RuntimeError "Error processing module data. 'data' collection is too big." and nothing from that run is saved.

```json
"response": { "data": { "cursor": "{{body.next_cursor}}" } }
```

## Choose where to start (select) and {{trigger.matchEqual}}

`select` is not a `response.trigger.type` value. It is the epoch the user creates in "Choose where to start" by picking an item from the list that the module's RPC returns (an RPC that declares `response.trigger`, see [RPC](../runtime-reference.md#rpc)). On the next run the trigger emits the selected item itself plus everything newer, then tracks `lastId` and `lastDate` as usual.

- **Id triggers:** ids at or above the selected id are emitted.
- **Date triggers:** the selected item and items with a newer date are emitted. Older dates are excluded and, on the selected timestamp, so are items whose id is smaller than the selected id. This mirrors the order of the "Choose where to start" list (newest first, then id descending). The selected id is then kept permanently in the trigger's data, readable as `{{data.epochId}}`, and every later run orders items that share that timestamp by id against `lastId`. This works the same for string and numeric ids.
- `{{data.epochType}}` is `select` on the first run. The choice stays in effect until a run emits items: if the first run emits nothing, the selected item is still included on the next run.
- On the first run `{{data.lastId}}` is the picked id read as an integer: `42` for `"42"`, `123` for `"123abc"`, empty for an id that does not start with a digit (`"b2"`). Use `{{data.epochId}}` when the API needs the id exactly as picked.

`{{trigger.matchEqual}}` is true during the first run after the user picked a specific item (epoch type `select`) and false otherwise. Use it to switch an API filter between inclusive (`>=`) and exclusive (`>`). The variable exists in every module's IML context, but it only means something in a polling trigger.

```json
"qs": { "since_id": "{{data.lastId}}", "inclusive": "{{trigger.matchEqual}}" }
```

## Items that share a date

For date triggers, items with the same date are tracked in a list of ids, so they are not processed again on later runs.

- Items dated before the saved date are skipped.
- Items dated exactly on the saved date are skipped only if their id is in the saved same-date list; other items on that date are kept.
- In a trigger that was not started from a picked item, `asc`, `desc` and no-order triggers apply the list from the oldest item on, and stop at the first item that is not on it. A new item on the saved date with a smaller id than the listed ones therefore brings the listed ones back: with the list `[1, 2]`, items 0, 1, 2 and 3 on that date emit 0, 1, 2 and 3. An `unordered` trigger skips every listed item (it emits 0 and 3).
- After a picked start (see [Choose where to start](#choose-where-to-start-select-and-triggermatchequal)) all four orders skip every listed item, and also every item on the saved date whose id is below `lastId`. With the list `[1, 2]` and `lastId` 2, items 0, 1, 2 and 3 emit only 3, so a late item with a smaller id is never emitted.
- After each run the list holds the ids of the emitted items that share the newest emitted date. When the run started on the saved date, that is, when its first emitted item is dated on it, these ids are appended to the old list. Otherwise they replace it. The list can therefore keep ids of earlier dates; it is only consulted for items dated exactly on the saved date.
- Query the API inclusively (`>=` the last date), so that items sharing a timestamp are neither lost nor duplicated.

Example with limit 2: ids 1, 2 and 3 are dated January 1, id 4 is dated January 2. Run 1 emits 1 and 2, and saves January 1 and the list `[1, 2]`. Run 2 gets all four items from an inclusive query. Items 1 and 2 are on the saved date and in the list, so they are skipped. Items 3 and 4 are emitted, the saved date becomes January 2, and the list becomes `[1, 2, 4]`.

## order and pagination

`order` tells Make how the API sorts its list, and it must match. A wrong value does not fail: items are missed or come out of sequence. An `order` that is not exactly `asc`, `desc` or `unordered` counts as no order.

A trigger pages only when a `pagination` directive exists. Without it Make requests the first page only, and items beyond it are never seen. With it, paging depends on `order`:

- **`asc`:** pages forward until it has collected `response.limit` NEW items. While no id is saved yet (an epoch without an id), every comparison with the saved id is false, so an `asc` id trigger keeps paging until another stop rule fires.
- **`desc`:** keeps paging toward older items and ignores the limit, because it needs the oldest new items. It stops when the newest item of a page is older than the saved point, when a page has no new items (unless `pagination.stopOnEmptyResponse` is `false`), or when the saved point lies inside a page.
- **`unordered`:** pages through everything and ignores the limit while paging. It keeps at most `maxPastRecords` items in memory (default 3200; 5000 only if that setting is 0, and then paging ends after the first page) and filters seen items out. A `response.limit`, if set, still cuts the final list.
- **No `order`:** pages like `desc` (it keeps paging while pages hold only new items) but combines pages like `asc`. For an ascending API that means paging to the end on every run, so set `order` explicitly.

In every mode the general stop rules of [When paging stops](pagination.md#when-paging-stops) apply as well: an empty page (here: nothing left after `iterate.condition` and `response.output`; `pagination.stopOnEmptyResponse: false` lifts it, and `pagination.condition` then decides), 50 extra requests, and 3200 raw items fetched through `response.iterate`.

`asc`, `desc` and no-order triggers also stop when a page starts with the same item as the previous page. Make compares the ids of the oldest item of each page after sorting, which protects against an API that ignores the page parameter. The repeated page is not used. `unordered` triggers do not have this stop: with an API that ignores the page parameter they page up to the 50 extra requests and emit the same items again.

The public docs describe 3200 as a cap on the records a trigger returns. Here it is a pagination stop: what a polling trigger emits per run is set by `response.limit`. A high-volume API that is listed oldest first without a date or id filter can therefore hide new items behind the first 3200 raw items; filter the request with `{{data.lastId}}` or `{{data.lastDate}}` instead.

## Items per run (response.limit)

The cap per run comes from `response.limit`, an IML expression such as `{{parameters.limit}}`. Make never reads `parameters.limit` by itself.

| `response.limit` | Ordered trigger (`asc`, `desc`, no order) | `unordered` trigger |
| ---------------- | ----------------------------------------- | ------------------- |
| missing, empty, null, a literal `0` or not an integer (`2.5`, `"abc"`) | 1 item | no cap: every new item it collected |
| a positive integer, or text that reads as one (`"4"`) | the oldest n new items | the oldest n new items |
| an expression that evaluates to the number 0 | InvalidConfigurationError "Limit cannot be zero." at the end of the run | the same |
| the text `"0"` | nothing is emitted, no error | the same |

Default `limit` for triggers: **1**. A user who leaves Limit empty gets one item per run. A negative number does not work as a cap: it drops items from the end (an ordered trigger drops them twice), so avoid it.

## Output rules and ignored directives

- Each page's output must be a non-empty list. A single object from `response.output` without `response.iterate` produces no bundles and stops paging. For an ordered trigger the same is true of a list without `response.iterate`: only an `unordered` trigger passes such a list through.
- With `response.iterate`, each item must stay a plain object after `response.output` maps it, because the trigger attaches the id and date to it. A mapping that gives anything that is not an object, including `null`, `undefined`, `0`, `false` and an empty string, fails the run with RuntimeError, for example "Cannot create property '__itemId' on string 'a'" or "Cannot set properties of null (setting '__itemId')" (the type and value vary).
- The shape check that raises DataError "Invalid item in module output. Expected Object, but found String." (the type name varies) catches items that get through unchanged, for example the items of an `unordered` trigger without `response.iterate`.
- `response.wrapper` is never applied.
- `api.endpoint` is rejected before any request with InvalidConfigurationError "Inline endpoint calls ('api.endpoint') are not supported in triggers.". This holds for any present value, even `""` or `false`.
- `response.data` is stored at the end of every run (see [Saved state](#saved-state-datalastid-and-datalastdate)).

```json
{
	"response": {
		"iterate": "{{body.items}}",
		"output": "{{item}}",
		"trigger": { "id": "{{item.id}}", "type": "id", "order": "desc" }
	}
}
```
