# Component patterns: Agency Module Pattern

> Read when: writing or reviewing an agency module (requests routed through a customer's on-premise Make Agent). Part of [component-patterns-reference.md](../component-patterns-reference.md).

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

| Field                                 | Purpose                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `agency.action`                       | `"execute"` — run HTTP request via agent. `"inputs"` — fetch connected system inputs only.                                       |
| `agency.payload.body`                 | The HTTP request spec forwarded to the agent: `url`, `method`, `headers`, `body`, `queryParams`.                                 |
| `agency.payload.connectorType`        | Must be `"http"`. Pagination only works with this connector type.                                                                |
| `agency.payload.expiresAfterInMillis` | Agent-side timeout — how long the broker waits for the agent to complete the task.                                               |
| `agency.connectedSystem.inputs`       | Available in IML after `agency.initialize()` runs. Contains the connected system's base URL and other inputs configured in Make. |

### Response Structure

The broker wraps the agent's HTTP response, creating a **nested structure**:

| Expression                  | Content                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `body`                      | Broker response envelope                                       |
| `body.body`                 | Agent response (includes `statusCodeValue`, `headers`, `body`) |
| `body.body.body`            | Actual HTTP response body from the target API                  |
| `body.body.statusCodeValue` | HTTP status code from the target API                           |
| `body.body.headers`         | Response headers from the target API                           |

### Timeout Structure

Agency modules have **two independent timeouts**:

| Timeout      | Source                                | Controls                                                     | Default                          |
| ------------ | ------------------------------------- | ------------------------------------------------------------ | -------------------------------- |
| Module-level | `base.imljson` → `"timeout"`          | How long Make Runtime waits for the broker response          | 40s (`parseInt(NaN) \|\| 40000`) |
| Agent-side   | `agency.payload.expiresAfterInMillis` | How long the broker waits for the agent to complete the task | 40s                              |

The module-level timeout covers the **entire round-trip**: task creation → agent polling → HTTP execution → response return. Agency modules typically cap this at **60 seconds** because beyond that, the issue is likely on the customer's local infrastructure (slow database, API overload, network issues) — outside Make's control. Direct HTTP modules (non-agency) allow up to **300 seconds** since Make controls the full request lifecycle.

### Runtime Internals

Source: `imt-app-runtime`

| File                                             | Function                      | Role                                                                                                                                                         |
| ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/core/middleware/agency.ts`                  | `initialize()`                | Fetches connected system inputs from broker (`/system-connections/{id}/inputs`) before the request. Sets `agency.connectedSystem.inputs` in the IML context. |
| `lib/core/chainMiddleware/requester/_request.js` | `_getAgencyRequestOptions()`  | Builds the POST request to the broker (`/tasks/{id}/execute`). Sets `agencyRequest` flag.                                                                    |
| `lib/core/middleware/agency.ts`                  | `sanitizeAgencyAuthHeaders()` | Automatically adds `request.headers` to `log.sanitize` — agency auth headers are always redacted.                                                            |

The `agencyRequest` flag enables `localAccess` bypass, allowing the agent to access internal/private IP addresses — this is the core purpose of on-prem agents.

### Pagination

Agency pagination is supported but only for `connectorType: "http"`. The pagination config mirrors standard pagination but nested under `agency.payload.body`:

```json
{
	"agency": {
		"action": "execute",
		"payload": { "...": "..." }
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
