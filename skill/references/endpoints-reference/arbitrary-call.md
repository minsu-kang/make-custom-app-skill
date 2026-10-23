# SDK Endpoints reference: Arbitrary Call Endpoint

> Read when: creating, updating or reviewing the `arbitraryCall` endpoint: standard template, derivation steps, checklist, gotchas. Part of [endpoints-reference.md](../endpoints-reference.md).

## Arbitrary Call Endpoint

The **Arbitrary Call** endpoint is a standardized passthrough that reproduces an app's _Make an API Call_ module at the Endpoint component level. It is **not** decomposed into per-operation Endpoints; it is a single generic endpoint that accepts an arbitrary path, HTTP method, headers, query string, and body against the app's API.

### When to Create

Every app that has a "Make an API Call" (or similarly named) module should also have an `arbitraryCall` endpoint. This is mandated by [IEN-15910](https://make.atlassian.net/browse/IEN-15910) § Acceptance — Arbitrary call endpoint.

### Naming & Annotations

| Field | Value |
|---|---|
| `name` | `arbitraryCall` |
| `label` | `Arbitrary call` |
| `description` | `Performs an arbitrary authorized API call.` |
| `annotations` | `{ "readOnlyHint": false, "openWorldHint": false, "idempotentHint": false, "destructiveHint": false, "arbitraryCallHint": true }` |

The `arbitraryCallHint` annotation is **mandatory** (platform support live since 2026-09-01). It signals that the endpoint is not scoped to a single route.

### Derivation Steps (from Source Module)

To create an `arbitraryCall` endpoint for an app, derive everything from its existing _Make an API Call_ module:

1. **Fetch the source module** — typically named `makeAnApiCall` or `makeApiCall`. Read its `api.imljson`, `expect.imljson`, and `scope.imljson`.
2. **Extract the base URL** — from the module's `api.url` pattern. Examples:
   - `"url": "https://gmail.googleapis.com/gmail/{{parameters.url}}"` → base is `https://gmail.googleapis.com/gmail/`
   - `"url": "https://slides.googleapis.com/{{parameters.url}}"` → base is `https://slides.googleapis.com/`
   - `"url": "https://www.googleapis.com/calendar/{{parameters.url}}"` → base is `https://www.googleapis.com/calendar/`
3. **Extract the connection** — from `attachedAccounts` or `connection` on the module. This becomes the endpoint's `attachedAccounts` array.
4. **Extract the scope** — from the module's `scope.imljson`. Often empty `[]` but some apps require specific scopes. **Must be transferred as-is.**
5. **Check `base.imljson`** — the app's base config may inject additional auth (e.g., Gemini adds `qs.key` and `headers.x-goog-api-key` from the base). These are merged automatically at runtime — no need to duplicate them in the endpoint, but worth noting in the context.
6. **Check for extra `api.imljson` logic** — the source module's `api.imljson` may contain additional directives beyond the standard passthrough:
   - Custom error handling (`response.error`)
   - Additional query string params (e.g., API versioning)
   - `type` overrides (e.g., `"type": "text"`)
   - **Transfer any non-standard logic** that affects the API call behavior.

### Standard Template

#### `api.imljson`

```json
{
    "url": "<BASE_URL>{{parameters.url}}",
    "method": "{{parameters.method}}",
    "headers": {
        "{{...}}": "{{toCollection(parameters.headers, 'key', 'value')}}"
    },
    "qs": {
        "{{...}}": "{{toCollection(parameters.qs, 'key', 'value')}}"
    },
    "body": "{{parameters.body}}",
    "type": "text",
    "response": {
        "output": {
            "body": "{{body}}",
            "headers": "{{headers}}",
            "statusCode": "{{statusCode}}"
        }
    }
}
```

**Body serialization — known runtime limitation, fix owned by the runtime ([Slack thread](https://integromat.slack.com/archives/C0BB266NWCU/p1790238461786569)).** `"type": "text"` makes the runtime serialize the body with `String(body)` (`request-options.ts` `serializeRequestBody`, `text|string|raw` branch). Through MCP `endpoint_execute` the input is passed with no Forman casting, so an AI caller may hand `body` over as a **real JSON object** — `String({…})` is `"[object Object]"` and the vendor rejects the request. It only works when the caller sends a pre-serialized JSON string, which is what the Forman form ("Run Endpoint", scenario module) always does. Flipping to `"type": "json"` (GitHub v4, monday v2 do this, mirroring their GraphQL modules) fixes object bodies but **double-stringifies** string bodies (`JSON.stringify("{}")` → `"\"{}\""`), so neither type handles both shapes today. The agreed fix is a shape-aware serializer in `imt-app-runtime` (parse-if-string, then stringify), requested from Plato — after it ships, what the MCP caller sends no longer matters.

- **Keep developing arbitraryCall endpoints exactly per the template** (`body` input `type: any`, request `"type": "text"`) — parity with the "Make an API Call" module and 15 of 17 existing arbitraryCall endpoints. Do not switch existing apps between `text` and `json`, and do not add app-level workarounds (custom stringify functions, help/context caveats) — they would outlive the runtime fix.
- Reviews: `"type": "text"` on an arbitraryCall is **not** a Bug, and neither is `"type": "json"` where the app already has it. A reported `[object Object]` body from an AI caller is this runtime issue, not an app defect.

#### `input_parameters.imljson`

```json
[
    {
        "name": "url",
        "type": "text",
        "label": "URL",
        "help": "Enter the part of the URL that comes after `<BASE_URL>`. For example, `<EXAMPLE_PATH>`.",
        "required": true
    },
    {
        "name": "method",
        "type": "select",
        "label": "Method",
        "required": true,
        "default": "GET",
        "help": "The HTTP request method.",
        "options": [
            { "label": "GET", "value": "GET" },
            { "label": "POST", "value": "POST" },
            { "label": "PUT", "value": "PUT" },
            { "label": "PATCH", "value": "PATCH" },
            { "label": "DELETE", "value": "DELETE" }
        ]
    },
    {
        "name": "headers",
        "label": "Headers",
        "help": "The HTTP request headers. You don't have to add authorization headers; we already did that for you.",
        "type": "array",
        "spec": {
            "type": "collection",
            "label": "Header",
            "help": "The HTTP request header.",
            "spec": [
                { "name": "key", "label": "Key", "type": "text", "help": "The HTTP request header key." },
                { "name": "value", "label": "Value", "type": "text", "help": "The HTTP request header value." }
            ]
        },
        "default": [{ "key": "Content-Type", "value": "application/json" }],
        "labels": { "add": "Add header" }
    },
    {
        "name": "qs",
        "label": "Query string",
        "type": "array",
        "help": "The HTTP request query parameters.",
        "spec": {
            "type": "collection",
            "label": "Query parameter",
            "help": "The HTTP request query parameter.",
            "spec": [
                { "name": "key", "label": "Key", "type": "text", "help": "The HTTP request query parameter's key." },
                { "name": "value", "label": "Value", "type": "text", "help": "The HTTP request query parameter's value." }
            ]
        },
        "labels": { "add": "Add query parameter" }
    },
    {
        "name": "body",
        "label": "Body",
        "type": "any",
        "help": "The HTTP request body. This input will be ignored if the HTTP request method is `GET`."
    }
]
```

#### `output_parameters.imljson`

```json
[
    { "name": "body", "type": "any", "label": "Body", "help": "The HTTP response body." },
    { "name": "headers", "type": "collection", "label": "Headers", "help": "The HTTP response headers." },
    { "name": "statusCode", "type": "number", "label": "Status code", "help": "The HTTP response status code." }
]
```

#### `context.md`

```markdown
---
name: arbitraryCall
description: Performs an arbitrary authorized API call.
---

This Endpoint is not scoped to a single route — it forwards an arbitrary call (method, path, query string,
headers and body) to the <APP_NAME> API, mirroring the "Make an API Call" module.

The base URL is `<BASE_URL>`. Provide the remaining path in the URL parameter
(e.g. `<EXAMPLE_PATH>`). Authentication is handled automatically via the app's connection.

Refer to the [<APP_NAME> API reference](<API_DOCS_URL>) for available
endpoints, required parameters, and response schemas.
```

**API docs URL versioning**: when the `<API_DOCS_URL>` links to an API reference, prefer the generic (version-less) URL if available and working. For example, use `https://developers.google.com/workspace/drive/api/reference/rest` instead of `https://developers.google.com/workspace/drive/api/reference/rest/v3`, so the reference always points to the latest version. Use a version-specific URL when the generic page is not available, redirects incorrectly, or when it is genuinely relevant to reference the exact API version (e.g., in examples or when the endpoint targets a specific API version).

### Mandatory Checklist

- [ ] `arbitraryCallHint: true` annotation set
- [ ] `help` on **every** input and output parameter (no parameter without `help`)
- [ ] `scope` transferred from the source module's `scope.imljson`
- [ ] `attachedAccounts` set to the app's connection
- [ ] `context` set with YAML frontmatter (`name`, `description`) and descriptive body
- [ ] URL example in both `help` text and `context` uses a simple GET path (ideally parameter-free, e.g., `/v1/models`, `/v1/users/me/calendarList`)
- [ ] API docs URL included in `context` — **verified reachable** (not a 404)
- [ ] Endpoint toggled **public** (visible) after creation — `update-component.js {slug} {ver} endpoint arbitraryCall public=true`

### Known Gotchas

| Issue | Detail |
|---|---|
| **CREATE doesn't apply `context` or `annotations`** | The `POST /endpoints` (or MCP `custom-apps_endpoints-configure` with `mode: CREATE`) ignores `context` and `annotations` fields. Always follow up with a separate update: `update-app.js … endpoint/{name}/context` and `…/annotations` (or MCP `mode: UPDATE`). |
| **Module `expect` vs endpoint `inputParameters` format** | Source modules may use a flat `spec: [...]` array for headers/qs items. Endpoints must use the nested `{ type: "collection", spec: [...] }` wrapper with `help` on every nested field. |
| **RPC references stripped** | Module `expect` may include `"rpc://someRpc"` entries (e.g., hint messages). These do not apply to endpoints — omit them entirely. |
| **Base auth merging** | Apps that inject auth via `base.imljson` `qs` or `headers` (e.g., Gemini's `qs.key`) — these merge automatically at runtime. Do not duplicate them in the endpoint's `api.imljson`. |
| **`public: false` after creation** | New endpoints are created with `public: false` (not visible). The MCP configure tool cannot flip it; the skill does it with `update-component.js {slug} {ver} endpoint {name} public=true` (`POST .../endpoints/{name}/public`) once the definition is pushed — do not leave it to the user unless that call fails. |
| **Object body → `[object Object]`** | With `"type": "text"` an AI caller that sends `body` as a JSON object (not a string) gets `String(body)` = `"[object Object]"` on the wire. Runtime limitation with a runtime fix pending — keep the template, add no app-level workaround. See § Standard Template → Body serialization. |
| **Absolute pagination URLs (`@odata.nextLink`) & write-request `Content-Type` in `context.md`** | When a vendor returns a full continuation URL (e.g., Microsoft Graph `@odata.nextLink`: `https://graph.microsoft.com/v1.0/...`) and any endpoint's `context.md` mentions calling it via `arbitraryCall`, explicitly state to strip `<BASE_URL>` and pass only the remaining path and query string in `url` — passing the full URL concatenates `<BASE_URL>https://...` and fails ([IEN-17151](https://make.atlassian.net/browse/IEN-17151)). Likewise, because MCP `endpoint_execute` does not auto-apply the schema `default` (`Content-Type: application/json`) when `headers` is omitted, note in `arbitraryCall/context.md` to explicitly send `Content-Type: application/json` in `headers` on write requests (`POST`, `PUT`, `PATCH`) when the API requires it. |

### Reference Implementations

| App | Slug / Version | Base URL | Jira |
|---|---|---|---|
| Google Calendar | `google-calendar` v5 | `https://www.googleapis.com/calendar/` | [IEN-16255](https://make.atlassian.net/browse/IEN-16255) |
| Gmail | `google-email` v4 | `https://gmail.googleapis.com/gmail/` | [IEN-15911](https://make.atlassian.net/browse/IEN-15911) |
| Google Gemini AI | `gemini-ai` v1 | `https://generativelanguage.googleapis.com` | [IEN-16471](https://make.atlassian.net/browse/IEN-16471) |
| Google Slides | `google-slides` v1 | `https://slides.googleapis.com/` | [IEN-16483](https://make.atlassian.net/browse/IEN-16483) |
| Google Drive | `google-drive` v4 | `https://www.googleapis.com/` | [IEN-16256](https://make.atlassian.net/browse/IEN-16256) |
| GitHub | `github` v2 | — (GraphQL example) | [IEN-16254](https://make.atlassian.net/browse/IEN-16254) |
| Discord | `discord` v2 | `https://discord.com/api/` | [IEN-16479](https://make.atlassian.net/browse/IEN-16479) |
| Canva | `canva` v1 | `https://api.canva.com/rest/v1` | [IEN-16618](https://make.atlassian.net/browse/IEN-16618) |
| monday.com | `monday` v2 | `https://api.monday.com/v2` (GraphQL, `API-Version` header in base) | [IEN-16757](https://make.atlassian.net/browse/IEN-16757) |
| Microsoft Teams | `microsoft-teams` v1 | `https://graph.microsoft.com/` | [IEN-16617](https://make.atlassian.net/browse/IEN-16617) |
| Calendly | `calendly` v2 | `https://api.calendly.com/` | [IEN-16681](https://make.atlassian.net/browse/IEN-16681) |

> **Note on GitHub**: serves as an example for apps using GraphQL APIs, where the endpoint wraps a single GraphQL query/mutation rather than a REST path.
> **Note on monday**: 42 GraphQL endpoints with typed `$variables`, `ifempty` on scalars / `stripEmpty` on arrays, collections and multi-selects, full selection sets (union fragments), scripted module-parity check, per-endpoint version-header override (`getAggregate` → 2026-04).
> **Note on Microsoft Teams**: 25 endpoints; `sendMessageCard` excluded — a `public: false` module that posts to an Office 365 connector webhook URL, not Microsoft Graph (both the non-public and the foreign-API filters apply). Microsoft Graph is also where the base64-in-JSON upload variant (`contentBytes`) comes from; Outlook `listMessages` ([IEN-16616](https://make.atlassian.net/browse/IEN-16616)) is the one-endpoint-per-vendor-path case.
> **Note on Calendly**: 25 endpoints; added `stripEmpty()` beside the app's older `removeEmptyObjects` (check the existing `functions/` for an equivalent before adding one); UUID-shaped ids declared as `uuid`.
> **Note on Discord**: demonstrates `condition` directive for content-type branching and bot-identity guards in an `arbitraryCall` endpoint.
> **Note on Canva**: demonstrates deprecated API handling, helper endpoints for enterprise-gated operations, and vendor `snake_case` naming.
