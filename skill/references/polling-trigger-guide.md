# Polling Trigger Implementation Guide

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1311932438/Polling+trigger)

## When to Use Polling Trigger

Implement polling trigger ONLY if:
1. Results have a **numeric ID** or **date** as identifier
2. At least one of these is true:
   - API supports sorting by the identifier in **descending order**
   - API supports **date/ID filtering** (e.g., `createdAt[$gte]`, `since`, `after`, `$filter`)
   - API returns results in a consistent ascending order by default

If none of the above is true, use a webhook or instant trigger instead.

## Understanding `trigger.order`

The `trigger.order` value **must match the actual order of results** returned by the API. Mismatches cause the runtime to incorrectly compare new vs. seen items, leading to duplicates or missed data.

### How the Runtime Uses `order`

| Order | Runtime Behavior |
|---|---|
| `asc` | Fetches past items, stops at known boundary |
| `desc` | Fetches future items, continues until known boundary |
| `unordered` | Keeps all items in memory (max `maxPastRecords` or 5000), always paginates through everything |

### Determining the Correct `order`

1. Check the API documentation for the **default response ordering** of the list endpoint
2. If the API supports a sort parameter (e.g., `$orderby`, `sort`, `order_by`), use it in `qs` to control the order explicitly
3. Set `trigger.order` to match the **actual response order**:
   - API returns newest first (or you sort descending) → `"desc"`
   - API returns oldest first (or you sort ascending) → `"asc"`
   - API returns in no consistent order and sorting is not available → `"unordered"`

> **Critical**: If the API's default response is unordered but the developer sets `order: "asc"` or `"desc"` without using a sort parameter — this is a bug. The `order` must reflect reality.

## Order Selection Guide

| API Capability | `trigger.order` | Date Filter? | Epoch Order | Notes |
|---|---|---|---|---|
| Sorting + filtering supported | `asc` **(recommended)** | Yes, with `\|\| undefined` | `desc` | Best pattern — ascending sort + date filter ensures efficiency |
| Sorting supported, no filtering | `desc` | Not needed | `desc` | Classic pattern — descending sort, newest first |
| Filtering only, no sorting | `unordered` | Yes, with `\|\| undefined` | `desc` | API returns unsorted data but supports date/ID filtering to narrow results |
| API returns ascending by default, no filtering | `asc` | Not available | `desc` | Acceptable but limited by 3200 pagination cap |
| No sorting, no filtering, unsorted response | `unordered` | Not available | N/A | Last resort — limited by 3200 pagination cap, may stop working for high-volume APIs |

**Avoid** using `unordered` or `asc` without date filtering on high-volume APIs — the 3200 pagination limit (`maxPastRecords`) means the trigger stops working when new items can't be reached.

## Recommended Pattern: `asc` + Date Filtering

When the API supports both sorting and filtering, use `order: "asc"` with a date filter. This is the most efficient pattern:

- **api.imljson**: Sort ascending + filter by `data.lastDate` to only fetch new items
- **epoch.imljson**: Sort **descending** to get the latest item as the starting point

### Why `asc` + Filter is Better Than `desc`

- `desc` fetches ALL new items from the top until it hits the known boundary — works, but processes more data
- `asc` + date filter only fetches items **after** the last known date — smaller result set, faster execution

### Important Rules

1. Always use `{{data.lastDate || undefined}}` (not `{{data.lastDate}}`) in the filter — so the filter is omitted entirely on the first run when no `lastDate` exists yet
2. **Epoch must always use `desc` ordering** — epoch determines the starting point by fetching the latest items, so it must sort descending regardless of the api's ascending order

### Example: microsoft-email v2 — watchMessages

**api.imljson** (ascending + date filter):
```json
{
    "url": "/me/messages",
    "method": "GET",
    "qs": {
        "$top": 100,
        "$orderby": "createdDateTime asc",
        "$filter": "{{if(data.lastDate, 'createdDateTime ge ' + formatDate(data.lastDate, 'YYYY-MM-DDTHH:mm:ss\\Z', 'UTC'), undefined)}}"
    },
    "response": {
        "trigger": {
            "id": "{{item.id}}",
            "date": "{{item.createdDateTime}}",
            "type": "date",
            "order": "asc"
        },
        "output": "{{item}}",
        "limit": "{{parameters.limit}}"
    }
}
```

**epoch.imljson** (descending — opposite of api):
```json
{
    "qs": {
        "$top": 500,
        "$orderby": "createdDateTime desc"
    },
    "response": {
        "limit": 500,
        "output": {
            "date": "{{item.createdDateTime}}",
            "label": "{{item.subject}}"
        }
    }
}
```

## Fallback: `unordered` + Date Filtering

When the API doesn't support sorting but supports date filtering:

```json
{
    "qs": {
        "createdAt[$gte]": "{{data.lastDate || undefined}}"
    },
    "response": {
        "trigger": {
            "id": "{{item.id}}",
            "date": "{{item.createdAt}}",
            "type": "date",
            "order": "unordered"
        }
    }
}
```

## Fallback: No Filtering Available

When the API has no sorting or filtering support:

- If the response comes in **ascending** order by default → `order: "asc"`
- If the response comes in **no consistent order** → `order: "unordered"`
- Both are limited by the 3200 `maxPastRecords` cap — note this caveat in the module description or help text

## Runtime Internals Reference

### Epoch Types

| Type | Tracked State | Sort Key |
|---|---|---|
| `id` | `lastId` | `__itemId` |
| `date` | `lastDate`, `sameDateIds` | `[__itemDate, __itemId]` |
| `select` | selected items only | — |

### Same-Date Deduplication

For date triggers, items with the same date are tracked in `sameDateIds` array to prevent re-processing on subsequent runs.

### Default Trigger Limit

Default `limit` for triggers: **1** (returns one item per execution).

## Common Mistakes

| Mistake | Why It's Wrong | Fix |
|---|---|---|
| `trigger.order` doesn't match actual response order | Runtime misidentifies new vs. seen items → duplicates or missed data | Verify API docs for default ordering; use sort parameter if available |
| `{{data.lastDate}}` instead of `{{data.lastDate \|\| undefined}}` | Sends empty/null filter value on first run instead of omitting the parameter | Use `\|\| undefined` to skip filter when no lastDate exists |
| Epoch uses same order as api | Epoch needs latest items to set starting point — ascending won't find them | Epoch must always use `desc` ordering |
| Using `order: "desc"` when API supports sorting + filtering | Less efficient — fetches all new items from top | Use `asc` + date filter for smaller result sets |
| Missing date filter when API supports it | Hits 3200 pagination limit on high-volume APIs | Check API docs for filter parameters (`$filter`, `since`, `after`, `created_at[gte]`) |
| Using `order: "asc"` but API response is actually unordered | Runtime assumes ascending boundary logic but items arrive randomly | Verify actual response order; use `unordered` if no sorting available |
