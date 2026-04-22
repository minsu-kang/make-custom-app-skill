# Component Patterns Reference

## Base Pattern

`base.imljson` defines common settings inherited by **modules and RPCs only**. It is **not merged into `connections/*/api.imljson` or `webhooks/*/api.imljson`** — **every** field in base (`baseUrl`, `headers`, `qs`, `body`, `response`, `log`, `type`, `timeout`, or any other key) is ignored for connection and webhook contexts. Those components must specify their full URL, headers, error handling, logging, and everything else explicitly. Any field set in base acts as the default for modules/RPCs only and can be overridden at the component level.

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
| `baseUrl` | Module/RPC URLs become relative to this. Avoids repeating the full URL everywhere. |
| `headers` | Default HTTP headers for module/RPC requests. Auth headers go here. |
| `response.error` | Default error handling for module/RPC responses. Can be overridden per-module. |
| `log.sanitize` | Paths to redact from debug logs for module/RPC requests. **Required** for any header/body containing secrets. |

> **Inheritance scope reminder**: Every field above (and any other field in `base.imljson`) applies to module/RPC requests only. Connection and webhook `api.imljson` are standalone and must re-declare everything they need.

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

### Aliased Connections (`aliasTo`)

A connection in one app can be an **alias** of a connection in another app. The alias is declared at the app-metadata level (visible on the admin API `/sdk/apps/{slug}/connections` response as `aliasTo: "<source-connection-name>"`).

**Critical runtime behavior:**

- When a connection has `aliasTo` set, **all of its own files (`api.imljson`, `parameters.imljson`, `common.imljson`, `scope*.imljson`, `install*.imljson`) are EXCLUDED at compile time**.
- The runtime resolves the connection entirely through the **source connection** referenced by `aliasTo`. The source owns `authorize`/`token`/`refresh`/`info`/`invalidate`, scopes, parameters, and install spec.
- **Any edits to an aliased connection's IMLJSON files are silent no-ops.** The local files may still exist in the repo/admin UI and will be returned by `download-app.js`, but they have **zero runtime effect**.
- Connection UX in scenarios (OAuth button, parameters shown) is also driven by the source, so users of the aliased app see the source connection's UI.

**Implications:**

- To change auth/OAuth/validation behavior or bump the API version used by the connection's `info` endpoint, update the **source app's connection**, not the aliased one.
- When reviewing a code change on an aliased connection, **flag it as ineffective** and point the developer to the source connection. A verdict of "harmless no-op" is appropriate if the intent is cosmetic alignment; otherwise the change belongs in the source app.
- Modules, RPCs, webhooks, functions, `base.imljson`, `common.imljson` of the aliased app are **NOT** affected — only the connection itself. (Note: `base.imljson` is inherited by modules/RPCs only, not by webhooks or the connection. See the Base Pattern section above.)

**Detection:**

- Admin API: `GET /sdk/apps/{slug}/connections` returns `aliasTo` (and snake_case `alias_to`) on connection entries.
- `download-app.js` captures `aliasTo` into `metadata.json` under `connections[].aliasTo`.
- A comment at the top of the aliased connection's `api.imljson` often documents this explicitly (e.g. `// This connection is aliased to the connection (xxx) from Yyy App`), but presence/absence of the comment is not authoritative — check `metadata.json`.

**Example:** `google-ads-conversions` connection `aliasTo: "google-ads2"`. Changes to `connections/google-ads-conversions/api.imljson` are dropped at compile; the runtime uses `google-ads` app's `google-ads2` connection configuration.

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

> **Note**: The 429 entry below is only necessary because it includes a **custom message** with `headers.retry-after`. Without it, the runtime would still handle 429 as `RateLimitError` automatically — but with a generic message.

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

**Note**: `webhooks/*/api.imljson` is **not merged with `base.imljson`**. Webhook payload processing is standalone — **every** field in base (not just `baseUrl` / `headers` / `response.error` / `log.sanitize`, but any key at all) is ignored for the webhook context.

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
| `trigger.order` | Yes | Must match actual API response order. `"desc"` — newest first. `"asc"` — oldest first (recommended with date filtering). `"unordered"` — no guaranteed order. See [Polling Trigger Guide](polling-trigger-guide.md). |

### Trigger Type: `id` vs `date`

| | `id` trigger | `date` trigger |
|---|---|---|
| Tracks | Last seen ID | Last seen date + same-date IDs |
| Best for | Auto-increment IDs, sequential | Timestamps, created_at/updated_at |
| Deduplication | By ID comparison | By date + ID comparison |
| Recommended order | `desc` | `asc` + date filter (see [Polling Trigger Guide](polling-trigger-guide.md)) |

### Important Rules

- **Triggers use Static Parameters only** — they are always the first module in a scenario, so no mapping from previous modules is possible. Use `parameters.imljson` (not `expect.imljson`).
- **`trigger.order` must match the actual API response order.** If the API supports sorting + filtering, use `asc` + date filter (recommended). If sorting only, use `desc`. See [Polling Trigger Guide](polling-trigger-guide.md) for details.
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

## Agency Module Pattern

Agency modules route HTTP requests through a customer's **on-premise Make Agent** instead of making direct HTTP calls from Make's servers. This allows Enterprise customers to access internal APIs and databases behind a firewall without exposing them to the internet.

### Architecture

```
Make Runtime ──POST──▶ process-automation-broker ──queue──▶ On-Prem Agent ──HTTP──▶ Internal API
     ▲                          │                              │                        │
     └──────────response────────┘◄─────────response────────────┘◄───────response────────┘
```

1. Make Runtime sends a task to the `process-automation-broker` service
2. The broker queues the task
3. The on-prem agent **polls** the broker for pending tasks (~4-minute cycle)
4. The agent picks up the task and executes the HTTP request on the local network
5. The agent returns the result through the broker back to Make

### api.imljson Structure

Agency modules use the `agency` directive instead of `url`. The `agency.payload` is sent to the broker, which forwards it to the on-prem agent.

```json
{
	"agency": {
		"action": "execute",
		"payload": {
			"body": {
				"url": "{{buildUrl(parameters.url, getUrlFromSourceSystemInputs(agency.connectedSystem.inputs))}}",
				"method": "{{upper(parameters.method)}}",
				"headers": {
					"{{...}}": "{{arrayToMap(parameters.headers)}}",
					"Content-Type": "{{getContentType(parameters)}}"
				},
				"body": "{{getBody(parameters)}}",
				"queryParams": "{{arrayToMap(parameters.qs)}}"
			},
			"connectorType": "http",
			"expiresAfterInMillis": "{{if(parameters.timeout, parameters.timeout * 1000, 40000)}}"
		}
	},
	"response": {
		"output": {
			"{{...}}": "{{omit(body.body, 'body')}}",
			"data": "{{if(parameters.parseResponse, localParseJSON(body.body.body), body.body.body)}}"
		}
	}
}
```

### Key Fields

| Field | Purpose |
|---|---|
| `agency.action` | `"execute"` — run HTTP request via agent. `"inputs"` — fetch connected system inputs only. |
| `agency.payload.body` | The HTTP request spec forwarded to the agent: `url`, `method`, `headers`, `body`, `queryParams`. |
| `agency.payload.connectorType` | Must be `"http"`. Pagination only works with this connector type. |
| `agency.payload.expiresAfterInMillis` | Agent-side timeout — how long the broker waits for the agent to complete the task. |
| `agency.connectedSystem.inputs` | Available in IML after `agency.initialize()` runs. Contains the connected system's base URL and other inputs configured in Make. |

### Response Structure

The broker wraps the agent's HTTP response, creating a **nested structure**:

| Expression | Content |
|---|---|
| `body` | Broker response envelope |
| `body.body` | Agent response (includes `statusCodeValue`, `headers`, `body`) |
| `body.body.body` | Actual HTTP response body from the target API |
| `body.body.statusCodeValue` | HTTP status code from the target API |
| `body.body.headers` | Response headers from the target API |

### Timeout Structure

Agency modules have **two independent timeouts**:

| Timeout | Source | Controls | Default |
|---|---|---|---|
| Module-level | `base.imljson` → `"timeout"` | How long Make Runtime waits for the broker response | 40s (`parseInt(NaN) \|\| 40000`) |
| Agent-side | `agency.payload.expiresAfterInMillis` | How long the broker waits for the agent to complete the task | 40s |

The module-level timeout covers the **entire round-trip**: task creation → agent polling → HTTP execution → response return. Agency modules typically cap this at **60 seconds** because beyond that, the issue is likely on the customer's local infrastructure (slow database, API overload, network issues) — outside Make's control. Direct HTTP modules (non-agency) allow up to **300 seconds** since Make controls the full request lifecycle.

### Runtime Internals

Source: `imt-app-runtime`

| File | Function | Role |
|---|---|---|
| `lib/core/middleware/agency.ts` | `initialize()` | Fetches connected system inputs from broker (`/system-connections/{id}/inputs`) before the request. Sets `agency.connectedSystem.inputs` in the IML context. |
| `lib/core/chainMiddleware/requester/_request.js` | `_getAgencyRequestOptions()` | Builds the POST request to the broker (`/tasks/{id}/execute`). Sets `agencyRequest` flag. |
| `lib/core/middleware/agency.ts` | `sanitizeAgencyAuthHeaders()` | Automatically adds `request.headers` to `log.sanitize` — agency auth headers are always redacted. |

The `agencyRequest` flag enables `localAccess` bypass, allowing the agent to access internal/private IP addresses — this is the core purpose of on-prem agents.

### Pagination

Agency pagination is supported but only for `connectorType: "http"`. The pagination config mirrors standard pagination but nested under `agency.payload.body`:

```json
{
	"agency": {
		"action": "execute",
		"payload": { "..." : "..." }
	},
	"response": {
		"temp": { "nextCursor": "{{body.body.body.nextCursor}}" }
	},
	"pagination": {
		"condition": "{{body.body.body.hasMore}}",
		"mergeWithParent": true,
		"agency": {
			"payload": {
				"body": {
					"queryParams": { "cursor": "{{temp.nextCursor}}" }
				}
			}
		}
	}
}
```

When `mergeWithParent` is `true` (default), pagination request inherits headers and other fields from the original request and only overrides the specified fields.

### Caveats

- **`connection.__IMTCONNSYS__`** must be present — if no connected system is configured, the runtime throws `RuntimeError: Invalid agency configuration. No connected system defined.`
- **Agent polling cycle is ~4 minutes** — if the agent is mid-token-refresh when a task arrives, pickup can be delayed by 10-15 seconds. Combined with the 60s timeout cap, this leaves a narrow window for the actual HTTP request.
- **Response nesting** — always remember `body.body.body` for the actual API response. This is the most common mistake when writing agency module output expressions.
- **Pagination only supports `connectorType: "http"`** — attempting pagination with other connector types throws `RuntimeError: Invalid agency configuration. Pagination can be configured only for http connector type.`
- **Auth headers are auto-sanitized** — the runtime automatically adds `request.headers` to `log.sanitize` for all agency requests. No manual sanitize config needed for agency auth.
