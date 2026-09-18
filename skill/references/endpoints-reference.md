<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# SDK Endpoints Reference

> Read when: creating, updating, or reviewing an SDK Endpoint — entity structure, admin API, Forman input/output schemas, `context.md`, annotations, Arbitrary Call template, runtime validation caveats.

SDK **Endpoints** are a new app component (per the [Endpoints RFC](https://make.atlassian.net/wiki/x/BwBmvQ)) that expose **one atomic third-party API call** as a first-class, AI-consumable operation. They are designed for AI callers (MCP tools / the Executor initiative), not for the scenario builder.

Everything in this document is verified against the live SDK admin API (google-docs v1, 2026-07-24), the IEN-15912 ticket family, and source code: `imt-web-api` master (`lib/controllers/sdk/endpoints.ts`, `lib/service/sdk-endpoint.service.ts`, `lib/repository/sdk-endpoint.repository.ts`, `lib/routers/sdk.js`), `imt-app-runtime` master (`lib/core/chainMiddleware/endpoint.ts`, `lib/api/rpc.js`, `lib/types.ts`), and `make-mcp-server-host` (`lib/libs/make-mcp-server/modules/endpoints.module.ts`).

## Core Facts

| Fact | Detail |
|---|---|
| **One endpoint = one API call** | An endpoint wraps exactly one third-party API operation. Multi-request chains (arrays) and cross-API augmentation are **out of contract** — e.g. the `google-docs` module fills its `text` output via an extra Drive API call, but the `getDocument` endpoint must not (IEN-16077: the dead `text` field was removed instead). |
| **Compiles as `IMTRPC`** | Same compiled class as RPCs (`imt-app-runtime/lib/api/rpc.js` extends `IMTRPC`); executes via the standard `ExecuteRpc` middleware chain with a single difference: the `endpointExecution` marker triggers result unwrap (see runtime-reference § "Inline Endpoint Calls"). |
| **Not scenario-runnable directly** | Running an endpoint inside a scenario is not supported at the Make platform level (yet). Execution paths: **MCP** (`endpoint_execute`), the platform **Run Endpoint** button (similar to Run RPC), and **inline delegation from a module/RPC** via the `api.endpoint` directive (see below). |
| **Modules can delegate to Endpoints** | A module/RPC `api.imljson` may declare `"endpoint": "name"` + `"input": {...}` instead of `url` — the runtime runs the named sibling Endpoint in place of the HTTP request. Full directive spec: [runtime-reference.md § Inline Endpoint Calls](runtime-reference.md#inline-endpoint-calls-apiendpoint). |
| **Connection binding** | `attachedAccounts` array on the endpoint entity names the app connection(s) the endpoint uses. Managed via `POST/DELETE .../endpoints/{name}/connections`. |
| **Consumables** | `centicreditsFormula` (+ description/documentation URL/meta) on the endpoint entity — the "Consumables" tab in the SDK UI. `null` when unset. Consumable edits are audited and versioned. |
| **Feature-flagged** | All endpoint routes in `imt-web-api` are gated by the growthbook flag `IS_SDK_ENDPOINTS_ENABLED` — 404-class error on environments where it's off. |
| **No endpoint aliasing** | There is no aliasing of endpoints in the current design. The fraction of apps using multiple APIs is small, and aliasing offers little benefit. Future options may enable complex app modules connecting multiple endpoints. |
| **Binary upload and download not supported** | SDK Endpoints do not support `buffer`-typed parameters — neither for upload (input) nor download/export (output). The Endpoint Execution API (`endpoint_execute`) always sends/receives `application/json`. **Upload workaround**: if the third-party API supports URL-based upload (passing a URL instead of binary data), implement that variant. Skip the endpoint entirely if only binary upload is available. **Download/export**: endpoints that return binary responses (file downloads, PDF exports, etc.) cannot be implemented — skip them. ([Slack thread](https://integromat.slack.com/archives/C0BB266NWCU/p1789467764790229), [IEN-16615](https://make.atlassian.net/browse/IEN-16615)) |
| **Full API coverage** | Endpoints should cover **all** parameters from the third-party API docs — not just what the existing app modules implement. Modules may have omitted parameters for various reasons, but endpoints as true API wrappers should expose everything the API supports, excluding parameters flagged as deprecated or legacy in the API docs. |

## Component Files (local layout from `download-app.js`)

```
endpoints/{name}/
  api.imljson                 # communication block
  input_parameters.imljson    # Forman input schema (array of parameter specs)
  output_parameters.imljson   # Forman output schema (can be very large — full API resource)
  scope.imljson               # OAuth scopes array, e.g. ["https://www.googleapis.com/auth/documents.readonly"]
  context.md                  # markdown context doc with YAML frontmatter (name, description)
```

`metadata.json` gains an `endpoints[]` array: `{ name, label, description, annotations, attachedAccounts, public, approved, deprecated, archived }`.

### `context.md`

Markdown document served to AI callers. Frontmatter carries `name` and `description`; the body documents usage, options, and limitations (request-type examples, index semantics, classification limitations, etc.). Treat it as user-facing documentation in reviews — accuracy against actual behavior matters.

### `annotations`

MCP-style hints on the endpoint entity:

| Annotation | Description |
|---|---|
| `readOnlyHint` | If `true`, the endpoint does not modify its environment. |
| `destructiveHint` | If `true`, the endpoint may perform destructive updates (meaningful only when `readOnlyHint` is `false`). |
| `idempotentHint` | If `true`, repeated calls with the same arguments have no additional effect. |
| `openWorldHint` | If `true`, the endpoint may interact with an "open world" of external entities. |
| `arbitraryCallHint` | If `true`, the endpoint is not scoped to a single route — it accepts an arbitrary call (method, path, query, headers, body) against the app's API. **Mandatory** for every `arbitraryCall` endpoint (platform support live since 2026-09-01). |

May be an empty object `{}` when the developer hasn't set them (observed on google-docs `batchUpdateDocument`/`createDocument`; only `getDocument` had them set). Missing annotations on a read-only or destructive endpoint are a legitimate review Improvement. Missing `arbitraryCallHint` on an `arbitraryCall` endpoint is a review Bug.

## SDK Admin API Surface

Base: `{zone}/api/v2/admin/sdk/apps/{slug}/{version}` — route source: `imt-web-api/lib/routers/sdk.js` (endpoints child router).

| Call | Purpose |
|---|---|
| `GET /endpoints` (`?includeInputSchema=true` optional) | List — `{ appEndpoints: [{ name, label, description, context, ... }] }` |
| `POST /endpoints` | Create — body `{ name, label, description?, attachedAccounts?, endpointInitMode?: 'example'\|'blank' }` (default `'example'` = clone the implementation sections from the `model` template app) |
| `GET /endpoints/{name}` | Detail — `{ appEndpoint: { name, label, description, context, annotations, attachedAccounts, public, approved, deprecated, archived, centicreditsFormula*, schemaVersion, rev, createdAt, updatedAt } }` |
| `GET /endpoints/{name}/{section}` | Read one section — `section` ∈ `api \| scope \| inputParameters \| outputParameters`. Returned as **JSONC** (comments preserved) |
| `PUT /endpoints/{name}/{section}` | Write one section (accepts `application/json` / `application/jsonc`). On an **approved** app this records an `apps.change` pending row instead of writing live |
| `PATCH /endpoints/{name}` | Update metadata — `label`, `description`, `context`, `annotations`, `attachedAccounts` |
| `PUT /endpoints/{name}/consumable` | Set `centicreditsFormula*` fields (audited) |
| `POST /endpoints/{name}/clone` | Clone — `{ newName, label? }` |
| `POST /endpoints/{name}/public\|private` | Visibility flip |
| `POST /endpoints/{name}/deprecate\|undeprecate` | Deprecation flip |
| `POST /endpoints/{name}/archive\|unarchive` | Archive flip |
| `POST /endpoints/{name}/connections` / `DELETE ...` | Attach/detach a connection (`attachedAccounts`) |
| `DELETE /endpoints/{name}` | Delete |

Endpoint name pattern: `^[a-zA-Z][0-9a-zA-Z]{1,126}[0-9a-zA-Z]$` (alphanumeric, letter start, 3–128 chars).

⚠️ **Naming mismatch — code paths vs change rows.** The section paths are **camelCase** (`inputParameters`, `outputParameters`; snake_case variants 404). But `apps.change` rows (what `review-changes.js` reports) use the underlying **snake_case** DB column names (`SECTION_COLUMN` in `sdk-endpoint.service.ts`): `endpoint/{name}/input_parameters`, `endpoint/{name}/output_parameters`, plus `api`, `scope`, and `context`. There is **no** `GET /endpoints/{name}/context` code path (404) — context lives only on the list/detail JSON and is edited via `PATCH`. Local filenames follow the snake_case change codes so review diffs map 1:1 to files.

### Change tracking (approved apps)

`apps.change.table = 'endpoint'`. Versioned (→ pending change rows on an approved app, same § 5a semantics as modules):

- Sections: `api`, `scope`, `input_parameters`, `output_parameters`
- Metadata: `context`, `annotations`, `attached_accounts`
- Consumables: `centicredits_formula*`

**NOT versioned: `label` and `description`** — they write live even on an approved app and produce **no change rows**, so label/description edits are invisible to `review-changes.js`. Compare `metadata.json` snapshots when a label change matters to a review.

### Endpoint scaffold (new-component detection)

`endpointInitMode: 'example'` (the default) clones the endpoint sections from the `model` template app (`endpoints/Endpoint/`). Same review rule as module scaffolds: an `old_value` matching the scaffold = effectively new component. Scaffold markers: `"url": "/users/{{parameters.id}}/action"`, `"body": "{{omit(parameters, 'id')}}"`, input params `id`/`email`/`name`, output param `id`, `scope: []`, and the boilerplate `# Context for the Endpoint` markdown. Snapshot lives in [component-scaffold-templates.md](component-scaffold-templates.md) § "Endpoint scaffold".

## UX & Naming Conventions

### Sentence Case Labels

Endpoint names and parameter labels follow the **Sentence case** naming convention (sentence-style capitalization; Verb + Item) — see [Apps UX best practices (Confluence)](https://make.atlassian.net/wiki/x/DAfcyg). Applies to the display `label`; the technical `name` stays camelCase.

Examples: `List files` (not `List Files`), `Get a message` (not `Get A Message`), `File ID` (not `file ID`).

### Endpoint Descriptions

Every endpoint must have a `description` — the same UX requirements apply as for modules. The description should be a concise sentence explaining what the endpoint does (e.g., `"Returns metadata for a file."`, `"Creates a new event in the specified calendar."`).

### Connection Attachment

Only attach connections that are attached to the **real modules** in the app or what is explicitly mentioned in the ticket AC. Some connections in the app may be deprecated, unused, or canonical versions for other apps of the same family. If uncertain which connections should be attached, ask.

### Coverage Completeness

Verify that the suggested/implemented endpoints cover all of the app's functionality as much as possible. Compare the app's **visible** modules with the list of endpoints and the third-party API surface. If the app has 15 modules covering 12 distinct API operations, the endpoint list should aim to cover all 12 (minus any that require unsupported features like binary uploads).

#### Exclude non-public modules before comparing

**Only modules that ship in the app's usable surface may drive an endpoint.** `public: false` strips a module from the compiled build entirely (app-compilation-and-deployment-reference.md § "Module visibility & hiding"), so an endpoint derived from one wraps an operation the shipped app does not expose. Filter the module list **before** designing endpoints, not after: drop every module the SDK modules list reports as `public: false` (`GET .../{slug}/{version}/modules`, or MCP `app-modules_list` / `app-module_get`).

Excluded modules are **not** coverage gaps: list them as excluded instead of reporting a missing endpoint. Conversely, an operation the vendor documents stays endpoint-worthy even when the only module using it was excluded — the filter removes *module-derived* endpoints, not documented API operations.

## `api.imljson` Shape

A standard communication block, same directive family as RPCs (endpoint = compiled `IMTRPC`, standard `ExecuteRpc` chain): `url` (relative to `base.imljson` `baseUrl`), `method`, `qs`, `body`, `headers`, `temp`, `response.*` (`output`/`temp`/`valid`/`iterate`/`wrapper`/`limit`), pagination. Custom IML functions are fully usable (observed: `buildBatchRequests()`, `handleTabs()`, `omit()`).

```json
{
    "url": "/documents/{{parameters.documentId}}:batchUpdate",
    "method": "POST",
    "body": {
        "requests": "{{buildBatchRequests(parameters.requests)}}",
        "writeControl": "{{parameters.writeControl}}"
    },
    "response": {
        "output": "{{body}}"
    }
}
```

Endpoint-specific response behavior:

- **Result unwrap** — because the RPC chain returns an array, an Endpoint's result is unwrapped when running *as an Endpoint*: single-element array → object, empty → `{}`. Opt out with `"response": { "unwrap": false }` or by declaring `response.iterate` (keeps the array). Source: `rpc.js` `_unwrapEndpointResult`, gated by the `endpointExecution` marker — identical embedded (inline `api.endpoint`) vs standalone.
- **`condition` cannot implement validation** — `condition()` IS part of the ExecuteRpc chain, but its falsy path ends the chain returning `condition.default` **as output data** (or `false`); it cannot raise a typed error (source: `lib/core/middleware/condition.js`). IEN-16076 field-tested it as a required-field guard: not viable. Do not suggest `condition` for endpoint-level validation.
- **`condition` CAN implement conditional API flow** — while `condition` cannot validate inputs, it **can** be used to replicate multi-API-call patterns from modules. Endpoints don't support multiple `api` calls, but the `condition` directive allows branching to different API paths or content types based on input. Examples: the Discord `arbitraryCall` endpoint ([IEN-16479](https://make.atlassian.net/browse/IEN-16479)) uses `condition` to handle different content types for POST/PUT/PATCH vs GET ([IEN-16648](https://make.atlassian.net/browse/IEN-16648)) and for bot-identity guards that the module implements via a preflight API call ([IEN-16649](https://make.atlassian.net/browse/IEN-16649)). For cases where an additional API call is needed for pre-checks (e.g., enterprise-gated operations), consider creating a separate helper endpoint and referencing it in the `context.md` — see the Canva implementation ([IEN-16618](https://make.atlassian.net/browse/IEN-16618)).
- **No nested endpoint calls** — an Endpoint's own `api` may not use the `api.endpoint` directive (`InvalidConfigurationError`).

## Pure API Wrapper Principle

Endpoints are **atomic wrappers around a third-party API** — they must not apply transformations beyond what is necessary for structural correctness. This is a core design principle that distinguishes endpoints from modules (which may transform, augment, and combine API responses).

### What this means in practice

| Aspect | Correct | Incorrect |
|---|---|---|
| **Response output** | `"output": "{{body}}"` or `"output": "{{body.items}}"` — raw API response | Applying IML functions to reshape, rename, or filter output fields |
| **Input body** | Pass parameters directly to the API body | Adding computed fields, merging data from other calls, reformatting dates |
| **Input schema** | Match the third-party API's parameter names, types, and structure | Renaming API parameters, adding convenience aliases, splitting/combining fields |
| **Output schema** | Document the full API resource as the third-party API returns it | Omitting fields, renaming fields, flattening nested structures |

### Allowed minimal transformations

Some structural transformations are acceptable to ensure clean API requests:

- **`stripEmpty()`** — a **custom** IML function (not built-in) that recursively removes `null`, `undefined`, empty strings, empty objects `{}`, and empty arrays `[]` from the request body. Required for PATCH endpoints and complex POST bodies where empty optional collections would cause `400 Bad Request` errors. Currently implemented in apps like Google Calendar (`google-calendar` v5) and Google Drive (`google-drive` v4) — it must be created as a custom IML function in each app that needs it. Example: `"body": "{{stripEmpty(omit(parameters, 'calendarId', 'sendUpdates'))}}"` (Google Calendar `createEvent`/`updateEvent`).
- **`omit()`** — to remove URL path parameters and query-string-only parameters from the body: `omit(parameters, 'calendarId', 'sendUpdates')`.
- **`encodeURL()`** — **only** when a path parameter may contain special characters that would break the URL (e.g., email addresses, user-provided strings with slashes or spaces). Example: `"/calendars/{{encodeURL(parameters.calendarId)}}/events"` with `"encodeUrl": false` on the api block to prevent double encoding. **Do not** use `encodeURL()` on simple alphanumeric IDs or slugs — it adds unnecessary complexity. Most path parameters (resource IDs, numeric IDs) do not need encoding.
- **`ifempty()` / `if(length())`** — for simple PATCH bodies where `stripEmpty` is overkill: wrap optional scalar fields with `{{ifempty(parameters.field, undefined)}}` and optional arrays with `{{if(length(parameters.field), parameters.field, undefined)}}` (because `ifempty` does not treat `[]` as empty).
- **`toCollection()`** — for map/dictionary fields where the API expects a flat `{key: value}` object: define the input as an `array` of `{key, value}` pairs, then transform with `"{{toCollection(parameters.field, 'key', 'value')}}"` in the `api.imljson` body/qs. In output, represent these as `collection` with no spec (open/dynamic keys).
- **`join()`** — when a `select` with `multiple: true` produces an array but the API expects a comma-separated string: `"{{join(parameters.field, ',')}}"`. Prefer this over free-text input when the set of values is known.

### `stripEmpty()` vs `ifempty()` — when to use which

| Scenario | Use | Why |
|---|---|---|
| Complex nested request body (POST/PUT/PATCH) | `stripEmpty()` | Recursively cleans all empty values from deeply nested structures |
| Simple flat QS parameters on write endpoints (POST/PUT/PATCH) | `ifempty()` | Lightweight — wraps individual params: `"field": "{{ifempty(parameters.field, undefined)}}"` |
| QS parameters on GET/DELETE endpoints | Neither | GET/DELETE QS params do **not** need empty-value guards — omitted params simply won't appear in the query string |
| URL path parameters | Neither | Path parameters are always required; they don't need `ifempty()` guards |

⚠️ **QS params on write endpoints also need guards** — not just body fields. A POST endpoint with optional QS params should wrap them with `ifempty()` in the `qs` block.

⚠️ **Do not over-apply `ifempty()`** — it is only needed on POST/PUT/PATCH endpoints where sending an empty value would cause errors. GET and DELETE endpoints should **never** use `ifempty()` on query string parameters.

### Always-true parameters — hardcode, don't expose

When a parameter should logically always be `true` (or a fixed value) for the endpoint to be useful, hardcode it in `api.imljson` rather than exposing it as an input. Parameters that are a genuine user choice should remain exposed. Use the correct JSON type for hardcoded values: `true` (boolean) not `"true"` (string), `1` (number) not `"1"` (string).

### What is NOT allowed

- Custom IML functions that reshape output (e.g., `sortEventFields()`, `formatResponse()`)
- Extra API calls to augment the response (e.g., fetching text content via Drive API for a Docs endpoint — IEN-16077)
- Date formatting functions (e.g., `dateParameter()`, `formatDate()`) — use the Make `date` type and let the platform handle serialization, or pass raw strings
- Field renaming or aliasing between input parameters and API body keys

## Input/Output Schemas (Forman)

- Same parameter spec format as module `expect.imljson` (name/type/label/required/default/help/options/nested/spec). Deeply nested `select` + `nested` structures work (observed: `batchUpdateDocument` request-type picker).
- **`output_parameters` must document the full actual output.** When `response.output` is `{{body}}` passthrough, the declared schema must cover the whole API resource (IEN-16078 — createDocument was expanded from 3 fields to the full ~288 KB Document resource schema). AI callers rely on the declared schema, not the raw response.

### Mandatory `help` Text

**Every** input and output parameter must have a descriptive `help` text — no parameter may be left without `help`. This applies to:

- Top-level parameters
- Nested fields inside `collection` specs
- Array item specs (the `spec` object itself and its nested fields)
- Fields at any nesting depth

This includes **primitive array specs** — the `spec` object inside a primitive `array` must also have `help`:

```json
// ❌ Wrong — missing help in spec
{
    "name": "permissionIds",
    "type": "array",
    "label": "Permission IDs",
    "help": "List of permission IDs for users with access to this file.",
    "spec": {
        "type": "text",
        "label": "Permission ID"
    }
}

// ✅ Correct — help present in spec
{
    "name": "permissionIds",
    "type": "array",
    "label": "Permission IDs",
    "help": "List of permission IDs for users with access to this file.",
    "spec": {
        "type": "text",
        "label": "Permission ID",
        "help": "The ID of a permission for a user with access to this file."
    }
}
```

**Exceptions** where `help` is not required:
- `select` `options` entries (the `label` is self-explanatory)
- The `labels` object (e.g., `"labels": { "add": "Add header" }`)

**Help text formatting**: use markdown in help texts. URLs should use the `[text](url)` markdown link format. Follow the [Apps UX best practices](https://make.atlassian.net/wiki/x/DAfcyg) for wording, tone, and formatting conventions.

### Parameter Type Accuracy

Use the most specific type available — do not default to `text` for everything:

| Data | Correct type | Wrong |
|---|---|---|
| Email address | `email` | `text` |
| Date/datetime (RFC3339, ISO 8601) | `date` | `text` |
| URL / link | `url` | `text` |
| True/false flag | `boolean` | `text` |
| Numeric value | `number` or `uinteger` | `text` |
| Fixed set of values (enum) | `select` (with `options`) | `text` |
| Fixed set, multiple allowed | `select` with `multiple: true` | `text` or `array` of `text` |

Where defined options are available from the API docs, always use the `select` type and list those options. For parameters that accept multiple values, use `select` with `multiple: true`. The multiselect in Make produces an array of strings — use `join()` in the `api.imljson` to convert when the API expects a comma-separated string (e.g., `"fields": "{{join(parameters.fields, ',')}}"`).

Prefer `select` over a `text` field with options listed only in the help text — it provides better UX and prevents invalid values.

### Array and Collection Spec Structure

Arrays of **objects** (key-value items) must use the nested collection wrapper:

```json
{
    "name": "attendees",
    "type": "array",
    "label": "Attendees",
    "help": "The attendees of the event.",
    "spec": {
        "type": "collection",
        "label": "Attendee",
        "help": "An event attendee.",
        "spec": [
            { "name": "email", "type": "email", "label": "Email", "help": "The attendee's email address." },
            { "name": "optional", "type": "boolean", "label": "Optional", "help": "Whether this is an optional attendee." }
        ]
    }
}
```

Arrays of **primitives** (strings, numbers) use a flat spec object:

```json
{
    "name": "recurrence",
    "type": "array",
    "label": "Recurrence",
    "help": "List of RRULE, EXRULE, RDATE, and EXDATE lines for a recurring event, as specified in RFC5545.",
    "spec": { "type": "text", "label": "Value" }
}
```

⚠️ Do **not** nest `spec` inside `spec` for primitive arrays — `spec: { type: "text", spec: [...] }` is invalid.

### Other Schema Conventions

- **`required: false`** is the default — do not include it. Only specify `required: true` where the API genuinely requires the field.
- **`validate`** directive for min/max constraints: `"validate": { "min": 0, "max": 1 }`.
- **List endpoint parameter order**: place filtering/search parameters first, followed by ordering/pagination/sync parameters (e.g., `pageToken`, `maxResults`, `orderBy`, `syncToken`) at the end.
- **Nested `required` in optional collections**: if a parent collection is optional but its child field is required *when the collection is present*, prefer removing `required` from the child and adding a help note like `"Required when {parent} is provided."` — otherwise the UI forces users to fill in the child even when they don't want the parent at all.
- **PATCH endpoint context**: always include a note advising AI callers to perform a GET first to retrieve current values, since omitted fields may be cleared.
- **`mode: edit` has no effect** in endpoint parameter schemas — this directive is module-specific and does nothing for endpoints.
- **Standard formatting**: use each property on its own line with 4-space indentation in `api`, `params`, and schema definitions. Do not cram multiple properties onto a single line.
- **Output parameter completeness**: output definitions must cover **all** fields from the API docs — not just commonly used ones. Include all nested object fields exhaustively. **Write-only fields** ("never populated in responses") must be excluded from output definitions. Always verify the output schema against the vendor API documentation — do not rely solely on what the existing module outputs, as modules may omit fields.
- **Parameter naming consistency**: the `name` field of every parameter within one endpoint must follow a consistent casing convention — typically matching the third-party API's naming. If the API uses `snake_case`, use `snake_case`; if `camelCase`, use `camelCase`. Do not mix conventions within a single endpoint schema. Example: Canva's API uses `snake_case` (`attached_to.design_id`), so endpoint parameters should use `attached_to` / `design_id` — not `designId` ([IEN-16696](https://make.atlassian.net/browse/IEN-16696)). When creating extra parameters for disambiguation (e.g., two API fields named `quality` for different contexts), ensure **every** extra parameter is correctly wired in the `api.imljson` — both directions: (1) every input parameter must be mapped to the API request, and (2) it must be mapped to the **correct** vendor field name, not the disambiguation name. Sending a field name the API doesn't recognize (because the endpoint uses a renamed parameter but sends that renamed name instead of the original) causes silent failures or 400 errors.
- **Validation completeness**: always check the third-party API documentation for input constraints — string length limits, numeric min/max ranges, format patterns. Apply the `validate` directive (e.g., `"validate": { "min": 0, "max": 100 }`) wherever the API enforces limits. Do not skip validation just because the module doesn't have it.
- **Nested options for dependent parameters**: when API parameters have values that are only valid for a specific parent option (e.g., different sub-parameters depending on a `type` selector), prefer nesting them under a `select` + `nested` structure when the number of dependent values is manageable. If nesting would be too complex or the nested values are too many, a flat schema with clear `help` text explaining the dependencies is acceptable — but nesting is preferred for AI caller clarity.
- **Deprecated/removed API operations**: before implementing any endpoint, verify the target API operation's status in the vendor's **current** documentation. Do not implement endpoints for API operations that are deprecated, removed, or flagged for sunset when a newer replacement exists — implement the replacement instead, or flag the deprecation to the user before proceeding. If a module wraps a deprecated API operation and a newer one is documented, prefer the newer API operation for the endpoint even if the module hasn't been updated yet. Example: Canva's `createCommentReply` used a legacy `/comments/{id}/replies` path that returned 404 — the current API uses a different endpoint ([IEN-16698](https://make.atlassian.net/browse/IEN-16698)).
- **Context file freshness**: whenever an endpoint is modified, disabled, or its behavior changes during development, check whether any **other** endpoint contexts reference it (e.g., "use `getCalendar` first to retrieve current values before calling `updateCalendar`") and update those references accordingly. Context files can go stale when endpoints are renamed, removed, or have their semantics changed. This applies to any cross-references between endpoints — helper endpoints, prerequisite calls, related operations mentioned in usage notes, etc.

## Runtime Validation Caveats (critical — verified IEN-16076 / IEN-16082)

| Execution path | Forman `required` / `default` enforcement |
|---|---|
| **Run Endpoint** (platform UI) | ✅ Enforced (normal Forman form validation) |
| **MCP `endpoint_execute`** | ❌ **Not enforced** — `required: true` fields pass through empty; declared `default` values are not applied when omitted |

Source-verified: `make-mcp-server-host`'s `endpoint_execute` tool (`lib/libs/make-mcp-server/modules/endpoints.module.ts`) passes `input` straight to `sdk.endpoints.executeEndpointThroughRpcWorker(appName, appVersion, endpointName, input, connectionId)` — no Forman validation anywhere on that path. The MCP host also exposes `endpoints_list` and `app-endpoint_get` (read tools). Platform-level parameter validation for MCP calls will be addressed by the ongoing **Executor initiative** ([Slack #endpoints-for-apps](https://integromat.slack.com/archives/C0BB266NWCU/p1784808924208909)). Until then:

- `required` / `default` in `input_parameters` are **schema hints for AI callers**, not runtime guarantees.
- There is **no app-level workaround** (`condition` unsupported, no pre-flight validation hook).
- **Code-review rule: do NOT flag missing required-field/default enforcement on an endpoint as a Bug** — it is a known platform gap, not an app defect. Prefer aligning the schema with the real API contract instead (IEN-16076: `title` `required` was *lifted* because the Google API itself doesn't require it).

## Skill Tooling Support

All skill scripts handle endpoints:

| Script | Endpoint support |
|---|---|
| `download-app.js` | Downloads `endpoints/{name}/{api,input_parameters,output_parameters,scope}.imljson` + `context.md`; `metadata.json` gains `endpoints[]` |
| `review-changes.js` | Generic — endpoint change rows (`endpoint/{name}/{code}`) already flow through |
| `update-app.js` | `endpoint/<name>/<section>` — sections PUT via camelCase API path; `context` PATCHes the entity metadata from a `.md` file |
| `create-component.js` | `endpoint <name> <label> [connection] [description] [initMode]` (initMode `example`\|`blank`) |
| `update-component.js` | `endpoint` type — `label`, `description` (PATCH), `public`, `deprecated`, `archived` (dedicated POST routes) |
| `delete-component.js` | `endpoint` type — `DELETE .../endpoints/{name}` (public-app deletability left to the server) |
| `test-component.js` | ❌ Not supported — endpoints run only via MCP `endpoint_execute` or platform Run Endpoint |

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
        "label": "Query String",
        "type": "array",
        "help": "The HTTP request query parameters.",
        "spec": {
            "type": "collection",
            "label": "Query Parameter",
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
- [ ] Endpoint toggled **public** (visible) after creation

### Known Gotchas

| Issue | Detail |
|---|---|
| **CREATE doesn't apply `context` or `annotations`** | The `POST /endpoints` (or MCP `custom-apps_endpoints-configure` with `mode: CREATE`) ignores `context` and `annotations` fields. Always follow up with a separate `UPDATE` call to set them. |
| **Module `expect` vs endpoint `inputParameters` format** | Source modules may use a flat `spec: [...]` array for headers/qs items. Endpoints must use the nested `{ type: "collection", spec: [...] }` wrapper with `help` on every nested field. |
| **RPC references stripped** | Module `expect` may include `"rpc://someRpc"` entries (e.g., hint messages). These do not apply to endpoints — omit them entirely. |
| **Base auth merging** | Apps that inject auth via `base.imljson` `qs` or `headers` (e.g., Gemini's `qs.key`) — these merge automatically at runtime. Do not duplicate them in the endpoint's `api.imljson`. |
| **`public: false` after creation** | New endpoints are created with `public: false` (not visible). Must be toggled to `public: true` manually or via `POST .../endpoints/{name}/public`. |

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

> **Note on GitHub**: serves as an example for apps using GraphQL APIs, where the endpoint wraps a single GraphQL query/mutation rather than a REST path.
> **Note on Discord**: demonstrates `condition` directive for content-type branching and bot-identity guards in an `arbitraryCall` endpoint.
> **Note on Canva**: demonstrates deprecated API handling, helper endpoints for enterprise-gated operations, and vendor `snake_case` naming.

## Code Review Guidance for Endpoint Changes

- Changes surface as `endpoint/{name}/{code}` with codes `api`, `input_parameters`, `output_parameters`, `context` (and potentially `scope`).
- **Breaking Changes: skip.** Endpoints cannot run in scenarios, so no existing scenario mappings can break. State the skip reason as usual. (A shared custom IML function edited for an endpoint CAN still break modules that reuse it — evaluate that under the function change, e.g. IEN-16083 `getDocumentResponse`.)
- The Runtime Reference hard gate applies to endpoint `api` changes the same as module/RPC `api` changes.
- **Pure API wrapper check**: verify the endpoint does not apply output transformations or unnecessary input transformations (see § Pure API Wrapper Principle). Structural cleanups like `stripEmpty()` and `omit()` are acceptable; data transformations are not.
- Verify `output_parameters` ↔ `response.output` shape consistency (IEN-16078 class).
- **Mandatory `help` check**: every input and output parameter — including nested fields inside collections and array specs — must have a `help` text. Missing `help` is a review Bug.
- Verify `context.md` accuracy against actual behavior — it is AI-caller documentation.
- Check `annotations` on new endpoints:
  - Read-only/destructive/idempotent hints should accurately reflect the API operation.
  - `arbitraryCallHint: true` is **mandatory** on every `arbitraryCall` endpoint — missing is a review Bug.
  - All non-`arbitraryCall` endpoints should have `arbitraryCallHint: false` (or absent).
- `scope` matches the API call's minimal OAuth scope.
- **Parameter type accuracy**: check that `email`, `date`, `url`, `select` types are used where appropriate instead of generic `text` (see § Parameter Type Accuracy).
- **Sentence case labels**: verify all endpoint labels and parameter labels follow Sentence case (see § Sentence Case Labels).
- **Endpoint descriptions**: every endpoint must have a `description` — same UX requirements as modules.
- **Connection attachment**: only relevant connections should be attached — not deprecated or unused ones (see § Connection Attachment).
- **Coverage completeness**: compare the app's module list and the third-party API surface against the implemented endpoints. Flag significant gaps. Exclude `public: false` modules from that comparison (§ Coverage Completeness) — a missing endpoint for one is not a gap; an endpoint that exists only because a `public: false` module exposed the operation is a scope question for the user, not a Bug.
- **Primitive array `help`**: check that even primitive array specs (e.g., `spec: { type: "text" }`) have `help` text.
- **Hardcoded value types**: verify hardcoded values use correct JSON types (`true` not `"true"`, `1` not `"1"`).
- **`stripEmpty()` / `ifempty()` on write endpoints**: POST/PUT/PATCH endpoints must guard optional body and QS params against sending empty values. Complex bodies → `stripEmpty()`, flat QS → `ifempty()`. Do **not** apply `ifempty()` to GET/DELETE query parameters.
- **`encodeURL()` usage**: verify `encodeURL()` is only used on path parameters that may contain special characters. Simple alphanumeric IDs do not need encoding.
- **URL verification**: API docs URLs in `context` and `help` text must be reachable (not 404). Verify before finalizing.
- **Endpoint URL correctness**: verify the endpoint's `api.url` matches the correct API path — cross-check against both the ticket acceptance criteria and the actual module implementation / vendor API docs.
- **Deprecated API operations**: verify the target API operation is not deprecated or removed in the vendor's current docs. If it is, a newer replacement should be used instead.
- **Parameter naming consistency**: all parameter `name` fields within one endpoint should follow the same casing convention (matching the vendor API), with no mixing of `snake_case` and `camelCase`.
- **Parameter-to-API wiring**: every input parameter must be properly mapped in `api.imljson` — check that no parameter is defined in the input schema but missing from the `url`, `qs`, `body`, or `headers` in the API block. Also verify the mapping uses the **correct vendor field name** — if a parameter was renamed for disambiguation, the `api.imljson` must still send it under the original API field name, not the renamed one.
- **Context file freshness**: when an endpoint is modified or disabled, verify that other endpoint contexts referencing it are updated (e.g., cross-references to helper endpoints, prerequisite calls, related operations).
