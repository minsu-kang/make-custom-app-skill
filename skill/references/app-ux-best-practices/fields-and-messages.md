# Apps UX best practices: Fields and messages

> Read when: working on ID selects, arrays of collections, date input and parsing, messages and common error messages, custom fields or nested outputs. Part of [app-ux-best-practices.md](../app-ux-best-practices.md).

## Messages

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/900892383/Messages)

Three message types using the `banner` element. Recommended length: **50 to 300 characters**.

### Information (blue)

```json
{
    "type": "banner",
    "title": "This is an info",
    "text": "Here is a description of info.",
    "theme": "info"
}
```

### Warning (yellow)

```json
{
    "type": "banner",
    "title": "This is a warning",
    "text": "Here is a description of warning.",
    "theme": "warning"
}
```

### Danger (red)

Used for deprecated modules and critical messages.

### Important

Due to [VMB-210](https://make.atlassian.net/browse/VMB-210) there is a risk on using `html` parameters. Stop using it. Use `info` and `warning` `banner` elements instead.

### Dynamic Google Connection Messages

For @gmail.com users who must reauthorize every 6 months:
- Use yellow (warning) info box for active connections
- Switch to red when expired
- Message: "You have until {dynamic date} to reauthorize this connection. For more details, see our [online help](https://www.make.com/en/help/connections/connecting-to-services#reauthorize-connections)."

---

## ID Finder

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/903774260/ID+finder)

### Module Guidelines

- Button label: always **ID finder** (or **Finder** if the field is not searching for an ID)

#### Single Search Method

- Field name: `[Item] ID` (e.g., Campaign ID, Employee ID)

#### Multiple Search Methods

- Field name: `[Item] search method` dropdown
- Options: Search by keyword, Search by [item], Select by file path, Select from list, Enter manually, etc.

### ID Finder Search Criteria

#### Single Criterion: Keyword Search

- Field name: `[Search Item] keywords` (e.g., Channel name keywords)
- Include blue info box: "If you don't see the result you're looking for, try more specific search criteria."

#### Single Criterion: Exact Match

- Field name: identical to the item name (e.g., Channel name)
- Do NOT include the blue info box
- Hint: "Must be the exact **[Search item]**."

#### Multiple Criteria

- Keyword field: `[Search Item] keywords`
- Include blue info box

### ID Finder Results

Results should be listed in alphabetical order (if the API allows).

### Template

```json
{
    "name": "recordId",
    "type": "text",
    "label": "Record ID",
    "rpc": {
        "label": "ID finder",
        "url": "rpc://...",
        "parameters": [
            {
                "type": "banner",
                "text": "If you don't see the result you're looking for, try more specific search criteria.",
                "theme": "info"
            },
            {
                "name": "query",
                "type": "text",
                "label": "Query"
            }
        ]
    }
}
```

---

## Labeling for Array of Collections

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/909410318/Labeling+for+array+of+collections)

### Standard Modules

- **Array label**: plural (e.g., `Recipients`)
- **Array item label**: singular, related to array label (e.g., `Recipient`)
- **Add button label**: related to array item (e.g., `Add recipient`)

#### Array of Collections

```json
{
    "name": "recipients",
    "type": "array",
    "label": "Recipients",
    "spec": {
        "type": "collection",
        "label": "Recipient",
        "spec": [
            {
                "name": "name",
                "type": "text",
                "label": "Name",
                "required": true
            }
        ]
    },
    "labels": {
        "add": "Add recipient"
    }
}
```

#### Primitive Array

```json
{
    "name": "recipients",
    "type": "array",
    "label": "Recipients",
    "spec": {
        "type": "text",
        "label": "Recipient name"
    },
    "labels": {
        "add": "Add recipient name"
    }
}
```

### Make an API Call

Standard structure for headers, query string, and body parameters:

```json
{
    "name": "headers",
    "type": "array",
    "label": "Headers",
    "spec": {
        "type": "collection",
        "label": "Header",
        "spec": [
            { "name": "key", "type": "text", "label": "Key" },
            { "name": "value", "type": "text", "label": "Value" }
        ]
    },
    "labels": { "add": "Add header" }
}
```

---

## Parsing Datetime

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/909574164/Parsing+datetime)

Always parse datetime in module output **EXCEPT**:

1. **No date, only time** (e.g., `13:30`)
2. **No time, only date** (e.g., `2024-01-01`)
3. **Date + time but no timezone** (e.g., `2020-06-08 12:37:56`) — unless API docs confirm UTC or another timezone
4. **Timestamp in seconds/milliseconds** — unless clearly indicated as Date type by name, API docs, or metadata

Do NOT use Make user's or organization's timezone (may differ from 3rd party configuration).

**IMPORTANT**: Apply ONLY to new apps, new app versions, or new modules. DO NOT change existing datetime parsing logic — this introduces breaking changes.

---

## Common Error Messages

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/937721971/Common+error+messages)

Define error handler for specific HTTP error types when:
1. Error message is not user friendly
2. No error message at all
3. API docs list expected errors
4. API returns custom error details you want to surface (e.g., `retry-after` header for 429)

> **Note**: 429 (`RateLimitError`) and 5xx (`ConnectionError`) are handled automatically by the runtime. Only define explicit handlers for these when you need a custom message format.

### Common HTTP Error Types

#### 4xx Client Errors

| Type | Description |
|---|---|
| 400 Bad Request | Invalid syntax in HTTP request |
| 401 Unauthorized | User not authenticated correctly |
| 403 Forbidden | User authorized but lacking permissions |
| 404 Not Found | Wrong URL or ID not found |
| 409 Conflict | Request conflicts with current state |
| 429 Too Many Requests | Rate limiting |

#### 5xx Server Errors

| Type | Description |
|---|---|
| 500 Internal Server Error | Unknown server error |
| 502 Bad Gateway | Invalid response from backend |
| 503 Service Unavailable | Server overloaded or under maintenance |

### Error Type Mapping

- **429**: `RateLimitError`
- **501/502/503**: `ConnectionError`

> **Note**: The `imt-app-runtime` automatically maps `429` → `RateLimitError` and `500-599` → `ConnectionError` by default, even without explicit error directives. You only need to define these explicitly when you want a **custom error message** (e.g., including `headers.retry-after` or API-specific error details). If the generic default message is sufficient, omit the status-code-specific directives entirely.

### Example (Monday)

This example defines custom error messages for 429/502/503 — useful because Monday's API returns specific `error_message` fields. If the API's error response is already readable, the runtime defaults are sufficient and these overrides can be omitted.

```json
{
    "response": {
        "error": {
            "message": "[{{statusCode}}] {{body.error_message || stringifyData(body.errors)}}",
            "429": {
                "type": "RateLimitError",
                "message": "[{{statusCode}}] {{body.error_message || stringifyData(body.errors)}}"
            },
            "502": {
                "type": "ConnectionError",
                "message": "[{{statusCode}}] {{body.error_message || stringifyData(body.errors)}}"
            },
            "503": {
                "type": "ConnectionError",
                "message": "[{{statusCode}}] {{body.error_message || stringifyData(body.errors)}}"
            }
        }
    }
}
```

---

## Custom Fields

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/937755208/Custom+fields)

- Always provide **dynamic parameters** for custom fields (using metadata endpoints)
- Do NOT ask users to map arrays manually
- **Exception**: When API does not provide a metadata endpoint (e.g., Zoho Books)

---

## Date Input

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1001062889/Date+input)

- Use `date` type parameter instead of asking user to input a specific date format
- **Exception**: If endpoint accepts date only or time only, use `text` type with a clear hint and example

---

## Validating Incorrect API Calls with Empty Response

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/785580229/Validating+incorrect+API+calls+with+an+empty+response)

When a Get module is based on a Search endpoint (no dedicated Get endpoint), the API may return 200 with empty response for invalid IDs.

### Solution

Add `valid` to the `response` object:

```json
{
    "url": "/items",
    "method": "GET",
    "qs": {
        "id": "{{parameters.itemId}}"
    },
    "response": {
        "valid": {
            "condition": "{{body.items[1].id}}",
            "message": "Item with the given id does not exist."
        },
        "output": "{{body.items[1]}}"
    }
}
```

### Example (Custify - Get a Tag)

```json
{
    "url": "/tag/{{parameters.id}}",
    "method": "GET",
    "response": {
        "valid": "{{length(body.tags) === 1}}",
        "error": {
            "message": "[{{statusCode}}] {{body.error.message || body.message || body.error || 'Something wrong. Please try again.'}}",
            "200": {
                "message": "Tag not found."
            },
            "503": {
                "message": "[503] Invalid tag ID."
            }
        },
        "output": "{{body.tags[]}}"
    }
}
```

---

## Flattening Nested Outputs

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1077739541/Flattening+nested+outputs)

Deeply nested outputs give terrible UX when mapping values. Always consider:

1. Creating a mappable version of key-value pairs
2. Flattening unnecessary nested collections

Examples:
- OpenAI: Flatten response content to a single text value
- Unbounce: Flatten unnecessary nested arrays containing a single item

---
