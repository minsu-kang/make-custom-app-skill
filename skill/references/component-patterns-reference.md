# Component Patterns Reference

> Read when: writing or reviewing `base.imljson`, a connection (any auth type, `aliasTo`, install params, `redirect_uri`), error handling, webhooks, triggers, responders, or agency modules. Base, connection basics, errors, triggers and responders are below; install params, OAuth2, aliased connections, webhooks and agency modules sit in `component-patterns-reference/` parts (§ Parts).

## Parts (open every part whose trigger applies, skip the rest)

| Part | Open when |
|---|---|
| [component-patterns-reference/install-params.md](component-patterns-reference/install-params.md) | `install.imljson` / `installSpec.imljson`; app-level versus connection-level values |
| [component-patterns-reference/connection-aliased.md](component-patterns-reference/connection-aliased.md) | a connection uses `aliasTo`, or any connection change is reviewed (aliased connections are a mandatory review check) |
| [component-patterns-reference/connection-oauth.md](component-patterns-reference/connection-oauth.md) | OAuth2 connections: `install` / `installSpec` fallback, `redirect_uri`, scope files, `token.response.scope` |
| [component-patterns-reference/webhook-pattern.md](component-patterns-reference/webhook-pattern.md) | webhooks and Instant Trigger modules: attach/detach, verification, shared webhooks, connection ownership |
| [component-patterns-reference/agency-module-pattern.md](component-patterns-reference/agency-module-pattern.md) | agency modules (requests routed through an on-premise Make Agent) |

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

| Field            | Purpose                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `baseUrl`        | Module/RPC URLs become relative to this. Avoids repeating the full URL everywhere.                            |
| `headers`        | Default HTTP headers for module/RPC requests. Auth headers go here.                                           |
| `response.error` | Default error handling for module/RPC responses. Can be overridden per-module.                                |
| `log.sanitize`   | Paths to redact from debug logs for module/RPC requests. **Required** for any header/body containing secrets. |

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
			"429": {
				"message": "Rate limit exceeded. Retry after {{headers.retry-after}} seconds.",
				"type": "RateLimitError"
			},
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

1. User fills in `parameters.imljson` fields (API key, credentials, etc.). **Those user inputs are immediately stored in the account's `data` object — accessible as both `{{parameters.fieldName}}` and `{{connection.fieldName}}` from that point on, in every context (connection api, modules, RPCs, webhooks).** No explicit save step is required for the value to be exposed under `connection.*`. Source: `imt-app-runtime/accounts/app-runtime-oauth2/lib/account.js` (and the OAuth1 / Basic equivalents) initialize the apiContext with `parameters: () => this.data, connection: () => this.data` — the two namespaces are aliases over the same store.
2. `api.imljson` runs a validation request using those parameters (or, for OAuth2, the `authorize` → `token` flow).
3. On success: any fields written by `response.data` (or `token.response.data` / `refresh.response.data` for OAuth) are **merged into the same `data` object** alongside the user-entered parameter values. This is how you persist derived values (access tokens, refresh tokens, expiration timestamps) and how you **transform** a user input before storage (e.g., `customerId: "{{replace(parameters.customerId, '-', '')}}"` writes back a normalized version of what the user typed, overriding the raw entry).
4. On success: `response.metadata.value` is shown as the connection label in the Make UI.

**Practical implication for code reviews**: a missing `token.response.data.fooToken` entry is **not** automatically a bug if `fooToken` exists in the connection's `parameters.imljson` and the user supplies it. `{{connection.fooToken}}` resolves correctly in modules/RPCs because user-entered parameter values are already in `account.data`. Only flag it as a bug when (a) the value needs server-side transformation before downstream use, (b) the value is derived from the API response (token, expiry, account id from a `/userinfo` call), or (c) the field is not in `parameters.imljson` at all.

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

| Field                     | Purpose                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parameters.imljson` field | User input goes into the shared `account.data` store and is **automatically accessible as both `parameters.{name}` and `connection.{name}`** in every context (connection api, modules, RPCs, webhooks). No explicit save step required. |
| `response.data`           | Merged into the same `account.data` store. Use it to **persist API-derived values** (access/refresh tokens, expiry, account ids from `/userinfo`) and to **transform a user input** before storage (e.g., normalize hyphens, lowercase, trim). The merged result is accessible as `connection.*`.                                                        |
| `response.metadata.value` | Displayed as the connection label in the Make UI (e.g., user email or account name).                                                              |
| `editable: true`          | Allows the user to edit the field after the connection is saved. **Only valid in connection `parameters.imljson`** (deprecated in module expect). |

### Important Rules

- **Reserved parameter names**: Do not use `teamID` or `accountName` — these are reserved by the Make platform.
- **Always use `editable: true`** on connection parameters so users can update credentials without recreating the connection.
- **Always sanitize** auth headers/body in `log.sanitize`.
- **Connection with `common.*` fallback requires install + installSpec** — see [connection-oauth.md](component-patterns-reference/connection-oauth.md#oauth2-connection-with-common-fallback-install--installspec-required).
- For OAuth2 connections, see the [official OAuth2 docs](https://developers.make.com/custom-apps-documentation/app-components/connections/oauth2).

## Error Handling

Errors can be defined at the base level (default for all components) or overridden per-module/RPC in their `api.imljson`.

### Error Types and When to Use Them

| Error Type                  | When to Use                             | User-Visible Behavior                       |
| --------------------------- | --------------------------------------- | ------------------------------------------- |
| `RuntimeError`              | General API errors, unexpected failures | Shows error, stops execution                |
| `DataError`                 | Invalid input data, validation errors   | Shows error, stops execution                |
| `RateLimitError`            | API rate limit hit (429)                | **Auto-retries** with backoff               |
| `ConnectionError`           | Service unavailable (5xx)               | **Auto-retries** with backoff               |
| `InvalidAccessTokenError`   | Auth failure (401/403)                  | Marks connection as broken, prompts re-auth |
| `InvalidConfigurationError` | Wrong module settings                   | Shows error, stops execution                |
| `OutOfSpaceError`           | Storage quota exceeded                  | Shows error, stops execution                |
| `IncompleteDataError`       | Required data missing from response     | Shows error, stops execution                |
| `DuplicateDataError`        | Conflict/duplicate creation (409)       | Shows error, stops execution                |

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

| Field           | Required          | Description                                                                                                                                                                                                          |
| --------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger.id`    | Yes               | Unique identifier for each item. Used for deduplication.                                                                                                                                                             |
| `trigger.date`  | If `type: "date"` | Timestamp field. Items with dates after the last known date are considered new.                                                                                                                                      |
| `trigger.type`  | Yes               | `"id"` — tracks by ID only. `"date"` — tracks by date + ID (more reliable).                                                                                                                                          |
| `trigger.order` | Yes               | Must match actual API response order. `"desc"` — newest first. `"asc"` — oldest first (recommended with date filtering). `"unordered"` — no guaranteed order. See [Polling Trigger Guide](polling-trigger-guide.md). |

### Trigger Type: `id` vs `date`

|                   | `id` trigger                   | `date` trigger                                                              |
| ----------------- | ------------------------------ | --------------------------------------------------------------------------- |
| Tracks            | Last seen ID                   | Last seen date + same-date IDs                                              |
| Best for          | Auto-increment IDs, sequential | Timestamps, created_at/updated_at                                           |
| Deduplication     | By ID comparison               | By date + ID comparison                                                     |
| Recommended order | `desc`                         | `asc` + date filter (see [Polling Trigger Guide](polling-trigger-guide.md)) |

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

| Field              | Purpose                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| `response.status`  | HTTP status code to return (e.g., 200, 201, 204).                                   |
| `response.headers` | Response headers. Usually `content-type`.                                           |
| `response.body`    | Response body. Can reference `{{parameters.*}}` from the responder module's expect. |

### When to Use

- The Instant Trigger receives the webhook event and outputs data
- The Responder (placed later in the scenario) sends a response back to the webhook sender
- Use when the external API requires a specific response format (e.g., Slack interactive messages, payment confirmations)
- If a simple 200 OK is sufficient, use `respond` in the webhook `api.imljson` instead — no Responder module needed
