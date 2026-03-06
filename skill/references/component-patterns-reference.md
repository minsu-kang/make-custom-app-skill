# Component Patterns Reference

## Base Pattern

`base.imljson` defines common settings inherited by **all** modules, RPCs, and webhooks. Any field set here acts as the default and can be overridden at the component level.

### Typical Structure

```json
{
	"baseUrl": "https://api.example.com/v1",
	"headers": {
		"Authorization": "Bearer {{connection.accessToken}}",
		"Content-Type": "application/json"
	},
	"response": {
		"error": {
			"message": "[{{statusCode}}] {{body.error.message}}"
		}
	},
	"log": {
		"sanitize": ["request.headers.Authorization"]
	}
}
```

### Key Fields

| Field | Purpose |
|---|---|
| `baseUrl` | All module/RPC URLs become relative to this. Avoids repeating the full URL everywhere. |
| `headers` | Default HTTP headers for every request. Auth headers go here. |
| `response.error` | Default error handling for all components. Can be overridden per-module. |
| `log.sanitize` | Paths to redact from debug logs. **Required** for any header/body containing secrets. |

### Log Sanitize Best Practices

Always sanitize sensitive data. Common paths:

```json
"log": {
	"sanitize": [
		"request.headers.Authorization",
		"request.headers.x-api-key",
		"request.body.password",
		"request.body.secret",
		"response.body.access_token",
		"response.body.refresh_token"
	]
}
```

### Conditional Base URL

When the API version or subdomain varies per connection:

```json
{
	"baseUrl": "https://{{connection.subdomain}}.example.com/api/v{{connection.apiVersion}}"
}
```

### Base with Multiple Error Codes

```json
{
	"baseUrl": "https://api.example.com/v2",
	"headers": {
		"Authorization": "Bearer {{connection.accessToken}}"
	},
	"response": {
		"error": {
			"400": { "message": "{{body.error.detail}}", "type": "DataError" },
			"401": { "message": "Invalid or expired token", "type": "InvalidAccessTokenError" },
			"403": { "message": "Insufficient permissions: {{body.error.message}}", "type": "InvalidAccessTokenError" },
			"404": { "message": "{{body.error.message}}", "type": "DataError" },
			"429": { "message": "Rate limit exceeded. Retry after {{headers.retry-after}} seconds.", "type": "RateLimitError" },
			"message": "[{{statusCode}}] {{ifempty(body.error.message, body.message, 'Unknown error')}}"
		}
	},
	"log": {
		"sanitize": ["request.headers.Authorization"]
	}
}
```

## Connection Pattern

Connection defines how the app authenticates with the external API. The `api.imljson` performs a **validation request** — if it succeeds, the connection is saved; if it fails, the user sees an error.

### Connection Flow

1. User fills in `parameters.imljson` fields (API key, credentials, etc.)
2. `api.imljson` runs a validation request using those parameters
3. On success: `response.data` is saved as `connection.*` (accessible everywhere)
4. On success: `response.metadata.value` is shown as the connection label in the UI

### API Key Connection

```json
// parameters.imljson
[
	{
		"name": "apiKey",
		"type": "password",
		"label": "API Key",
		"required": true,
		"editable": true
	}
]
```

```json
// api.imljson
{
	"url": "https://api.example.com/me",
	"headers": { "Authorization": "Bearer {{parameters.apiKey}}" },
	"response": {
		"metadata": { "value": "{{body.email}}" },
		"error": { "message": "{{body.error}}" }
	},
	"log": { "sanitize": ["request.headers.Authorization"] }
}
```

### Basic Auth Connection

```json
// parameters.imljson
[
	{
		"name": "username",
		"type": "text",
		"label": "Username",
		"required": true,
		"editable": true
	},
	{
		"name": "password",
		"type": "password",
		"label": "Password",
		"required": true,
		"editable": true
	}
]
```

```json
// api.imljson
{
	"url": "https://api.example.com/me",
	"headers": {
		"Authorization": "Basic {{base64(parameters.username + ':' + parameters.password)}}"
	},
	"response": {
		"metadata": { "value": "{{body.name}} ({{body.email}})" }
	},
	"log": { "sanitize": ["request.headers.Authorization"] }
}
```

### Key Fields

| Field | Purpose |
|---|---|
| `response.data` | Saved as `connection.*`. Accessible in base, modules, RPCs via `{{connection.fieldName}}`. |
| `response.metadata.value` | Displayed as the connection label in the Make UI (e.g., user email or account name). |
| `editable: true` | Allows the user to edit the field after the connection is saved. **Only valid in connection `parameters.imljson`** (deprecated in module expect). |

### Important Rules

- **Reserved parameter names**: Do not use `teamID` or `accountName` — these are reserved by the Make platform.
- **Always use `editable: true`** on connection parameters so users can update credentials without recreating the connection.
- **Always sanitize** auth headers/body in `log.sanitize`.
- For OAuth2 connections, see the [official OAuth2 docs](https://developers.make.com/custom-apps-documentation/app-components/connections/oauth2).

## Error Handling

Errors can be defined at the base level (default for all components) or overridden per-module/RPC in their `api.imljson`.

### Error Types and When to Use Them

| Error Type | When to Use | User-Visible Behavior |
|---|---|---|
| `RuntimeError` | General API errors, unexpected failures | Shows error, stops execution |
| `DataError` | Invalid input data, validation errors | Shows error, stops execution |
| `RateLimitError` | API rate limit hit (429) | **Auto-retries** with backoff |
| `ConnectionError` | Service unavailable (5xx) | **Auto-retries** with backoff |
| `InvalidAccessTokenError` | Auth failure (401/403) | Marks connection as broken, prompts re-auth |
| `InvalidConfigurationError` | Wrong module settings | Shows error, stops execution |
| `OutOfSpaceError` | Storage quota exceeded | Shows error, stops execution |
| `IncompleteDataError` | Required data missing from response | Shows error, stops execution |
| `DuplicateDataError` | Conflict/duplicate creation (409) | Shows error, stops execution |

### Default Runtime Behavior (No Custom Error)

Without custom error config, the runtime applies these defaults:
- `429` → `RateLimitError` (auto-retry)
- `500-599` → `ConnectionError` (auto-retry)
- Other 4xx → `RuntimeError`

### Per-Status-Code Error Handling

```json
"response": {
	"error": {
		"200": { "message": "{{body.error.message}}" },
		"401": {
			"message": "Invalid credentials. Please reconnect.",
			"type": "InvalidAccessTokenError"
		},
		"404": {
			"message": "{{body.error.message}}",
			"type": "DataError"
		},
		"409": {
			"message": "{{body.error.message}}",
			"type": "DuplicateDataError"
		},
		"429": {
			"message": "Rate limit exceeded. Retry after {{headers.retry-after}}s.",
			"type": "RateLimitError"
		},
		"message": "[{{statusCode}}] {{ifempty(body.error.message, body.message, 'Unknown error')}}"
	}
}
```

### Error Handling for APIs with 200-OK Errors

Some APIs return `200 OK` with an error in the body. Use status code `"200"` or `valid`:

```json
"response": {
	"valid": "{{body.ok == true}}",
	"error": {
		"200": {
			"message": "{{body.error}}: {{body.detail}}",
			"type": "RuntimeError"
		}
	}
}
```

### Using `errorFactory()` in Custom Functions

For complex error logic in custom IML functions:

```js
function handleApiError(statusCode, body) {
	if (statusCode === 404) {
		return errorFactory('DataError', `Resource not found: ${body.resource_type} ${body.resource_id}`);
	}
	if (body.error_code === 'RATE_LIMIT') {
		return errorFactory('RateLimitError', body.message);
	}
	return errorFactory('RuntimeError', `[${statusCode}] ${body.message || 'Unknown error'}`);
}
```

## Webhook Pattern

Webhooks enable **Instant Trigger** modules to receive real-time events. The webhook `api.imljson` defines how to process incoming webhook payloads.

### Webhook api.imljson

```json
{
	"output": "{{item}}",
	"iterate": "{{body.events}}",
	"condition": "{{body.type == 'event'}}",
	"respond": {
		"status": 200,
		"type": "json",
		"body": { "status": "ok" }
	}
}
```

### Key Fields

| Field | Purpose |
|---|---|
| `output` | Data to output from the webhook. Use `{{item}}` when iterating, `{{body}}` for single event. |
| `iterate` | Array of events in the payload to iterate over. Produces one bundle per item. |
| `condition` | Only process the payload if this evaluates to true. Use to filter ping/heartbeat events. |
| `respond` | HTTP response sent back to the webhook sender. Most APIs require 200 OK acknowledgment. |

### Verification / Challenge Pattern

Many APIs (Slack, Zoom, etc.) send a verification challenge when registering the webhook. Handle it with the `verification` block:

```json
{
	"output": "{{item}}",
	"iterate": "{{body.events}}",
	"respond": {
		"status": 200,
		"type": "json",
		"body": { "status": "ok" }
	},
	"verification": {
		"condition": "{{body.challenge}}",
		"respond": {
			"status": 200,
			"type": "json",
			"body": { "challenge": "{{body.challenge}}" }
		}
	}
}
```

The `verification` block is checked **first**. If `verification.condition` is true, the verification response is sent and normal processing is skipped.

### Attach / Detach

When the external API requires explicit webhook registration/unregistration:

```json
// attach.imljson — called when user enables the webhook
{
	"url": "/webhooks",
	"method": "POST",
	"body": {
		"url": "{{webhook.url}}",
		"events": ["item.created", "item.updated"]
	},
	"response": {
		"data": {
			"webhookId": "{{body.id}}"
		}
	}
}
```

```json
// detach.imljson — called when user disables the webhook
{
	"url": "/webhooks/{{webhook.webhookId}}",
	"method": "DELETE"
}
```

| Variable | Description |
|---|---|
| `{{webhook.url}}` | The unique Make-generated URL for this webhook instance. |
| `{{webhook.webhookId}}` | Value saved in `attach`'s `response.data`. Available in `detach` and `api.imljson`. |

### Shared Webhooks

When one webhook URL is shared across multiple Instant Trigger modules (e.g., different event types), configure it at the app level. Each module filters events via its `condition`.

## Trigger Pattern

Polling triggers periodically check for new items. They use **epoch tracking** to remember what was already processed.

### Basic Trigger

```json
{
	"url": "/api/items",
	"qs": { "sort": "created_at", "order": "desc" },
	"response": {
		"limit": "{{parameters.limit}}",
		"output": "{{item}}",
		"iterate": "{{body.data}}",
		"trigger": {
			"id": "{{item.id}}",
			"date": "{{item.created_at}}",
			"type": "date",
			"order": "desc"
		}
	},
	"pagination": {
		"condition": "{{body.has_more}}",
		"qs": { "cursor": "{{body.next_cursor}}" }
	}
}
```

### Trigger Configuration Fields

| Field | Required | Description |
|---|---|---|
| `trigger.id` | Yes | Unique identifier for each item. Used for deduplication. |
| `trigger.date` | If `type: "date"` | Timestamp field. Items with dates after the last known date are considered new. |
| `trigger.type` | Yes | `"id"` — tracks by ID only. `"date"` — tracks by date + ID (more reliable). |
| `trigger.order` | Yes | `"desc"` — newest first (recommended). `"asc"` — oldest first. `"unordered"` — no guaranteed order. |

### Trigger Type: `id` vs `date`

| | `id` trigger | `date` trigger |
|---|---|---|
| Tracks | Last seen ID | Last seen date + same-date IDs |
| Best for | Auto-increment IDs, sequential | Timestamps, created_at/updated_at |
| Deduplication | By ID comparison | By date + ID comparison |
| Recommended order | `desc` | `desc` |

### Important Rules

- **Triggers use Static Parameters only** — they are always the first module in a scenario, so no mapping from previous modules is possible. Use `parameters.imljson` (not `expect.imljson`).
- **`desc` order recommended** — with `maxPastRecords` of 3200, `asc` order may miss items if there are more than 3200 new items.
- **Always include `limit`** in response and in parameters (`"type": "uinteger"`, `"default": 10`).
- **Default trigger limit is 1** — if no `limit` parameter is configured, the trigger returns only 1 item per execution.

### ID-Only Trigger Example

```json
{
	"url": "/api/notifications",
	"qs": { "sort": "-id" },
	"response": {
		"limit": "{{parameters.limit}}",
		"output": "{{item}}",
		"iterate": "{{body.data}}",
		"trigger": {
			"id": "{{item.id}}",
			"type": "id",
			"order": "desc"
		}
	}
}
```

## Responder Pattern

Responder modules (type_id: 11) define the HTTP response sent back to a webhook caller. Used in combination with an Instant Trigger when the external API expects a custom response body.

### Structure

```json
{
	"response": {
		"status": 200,
		"headers": { "content-type": "application/json" },
		"body": { "result": "{{parameters.result}}" }
	}
}
```

### Key Fields

| Field | Purpose |
|---|---|
| `response.status` | HTTP status code to return (e.g., 200, 201, 204). |
| `response.headers` | Response headers. Usually `content-type`. |
| `response.body` | Response body. Can reference `{{parameters.*}}` from the responder module's expect. |

### When to Use

- The Instant Trigger receives the webhook event and outputs data
- The Responder (placed later in the scenario) sends a response back to the webhook sender
- Use when the external API requires a specific response format (e.g., Slack interactive messages, payment confirmations)
- If a simple 200 OK is sufficient, use `respond` in the webhook `api.imljson` instead — no Responder module needed
