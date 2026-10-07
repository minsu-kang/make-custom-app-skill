<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# SDK Endpoints Reference

> Read when: creating, updating, or reviewing an SDK Endpoint — entity structure, admin API, Forman input/output schemas, `context.md`, annotations, Arbitrary Call template, runtime validation caveats.

SDK **Endpoints** are a new app component (per the [Endpoints RFC](https://make.atlassian.net/wiki/x/BwBmvQ)) that expose **one atomic third-party API call** as a first-class, AI-consumable operation. They are designed for AI callers (MCP tools / the Executor initiative), not for the scenario builder.

Everything in this document is verified against the live SDK admin API (google-docs v1, 2026-07-24), the IEN-15912 ticket family, and source code: `imt-web-api` master (`lib/controllers/sdk/endpoints.ts`, `lib/service/sdk-endpoint.service.ts`, `lib/repository/sdk-endpoint.repository.ts`, `lib/routers/sdk.js`), `imt-app-runtime` master (`lib/core/chainMiddleware/endpoint.ts`, `lib/api/rpc.js`, `lib/types.ts`), and `make-mcp-server-host` (`lib/libs/make-mcp-server/modules/endpoints.module.ts`).

## Core Facts

| Fact | Detail |
|---|---|
| **One endpoint = one API call** | An endpoint wraps exactly one third-party API operation. Multi-request chains (arrays) and cross-API augmentation are **out of contract** — e.g. the `google-docs` module fills its `text` output via an extra Drive API call, but the `getDocument` endpoint must not (IEN-16077: the dead `text` field was removed instead). **Also never use an input to select which vendor endpoint to call** — building the URL as `/me/messages` or `/me/mailFolders/{id}/messages` depending on whether `folderId` is filled packs two API endpoints into one SDK endpoint to "cover more" ([IEN-16616](https://make.atlassian.net/browse/IEN-16616) Outlook `listMessages`). Split them into two endpoints; a module that does this internally does not justify replicating it. |
| **No pagination** | Endpoints are dumb single-request wrappers: no `pagination` directive, no iteration, no `response.limit`. Expose the vendor's paging controls (`page`, `limit`, `cursor`, `pageToken`, `offset`…) as **plain inputs** and surface the vendor's continuation token (`cursor`, `nextPageToken`, `next_items_page`…) in `output_parameters` so the AI caller can page by calling again. If the vendor has a dedicated continuation operation (monday `next_items_page`), make it its own endpoint. |
| **Compiles as `IMTRPC`** | Same compiled class as RPCs (`imt-app-runtime/lib/api/rpc.js` extends `IMTRPC`); executes via the standard `ExecuteRpc` middleware chain with a single difference: the `endpointExecution` marker triggers result unwrap (see runtime-reference § "Inline Endpoint Calls"). |
| **Not scenario-runnable directly** | Running an endpoint inside a scenario is not supported at the Make platform level (yet). Execution paths: **MCP** (`endpoint_execute`), the platform **Run Endpoint** button (similar to Run RPC), and **inline delegation from a module/RPC** via the `api.endpoint` directive (see below). |
| **Modules can delegate to Endpoints** | A module/RPC `api.imljson` may declare `"endpoint": "name"` + `"input": {...}` instead of `url` — the runtime runs the named sibling Endpoint in place of the HTTP request. Full directive spec: [runtime-reference.md § Inline Endpoint Calls](runtime-reference.md#inline-endpoint-calls-apiendpoint). |
| **Connection binding** | `attachedAccounts` array on the endpoint entity names the app connection(s) the endpoint uses. Managed via `POST/DELETE .../endpoints/{name}/connections`. |
| **Consumables** | `centicreditsFormula` (+ description/documentation URL/meta) on the endpoint entity — the "Consumables" tab in the SDK UI. `null` when unset. Consumable edits are audited and versioned. |
| **Feature-flagged** | All endpoint routes in `imt-web-api` are gated by the growthbook flag `IS_SDK_ENDPOINTS_ENABLED` — 404-class error on environments where it's off. |
| **No endpoint aliasing** | There is no aliasing of endpoints in the current design. The fraction of apps using multiple APIs is small, and aliasing offers little benefit. Future options may enable complex app modules connecting multiple endpoints. |
| **Binary upload and download not supported** | SDK Endpoints do not support `buffer`-typed parameters — neither for upload (input) nor download/export (output). The Endpoint Execution API (`endpoint_execute`) always sends/receives `application/json`. **Upload workarounds** (either is acceptable): (a) if the third-party API supports URL-based upload (passing a URL instead of binary data), implement that variant; (b) if the API accepts the file content as a **base64 string inside the JSON body** (Microsoft Graph `contentBytes`, Gmail `raw`, Jira/Confluence attachment-by-base64 variants), expose that field as a `text` input (not `buffer`) and pass it through — the AI caller supplies the base64. Skip the endpoint entirely if only `multipart/form-data` / raw-binary upload exists. **Download/export**: endpoints that return binary responses (file downloads, PDF exports, etc.) cannot be implemented — skip them. ([Slack thread](https://integromat.slack.com/archives/C0BB266NWCU/p1789467764790229), [IEN-16615](https://make.atlassian.net/browse/IEN-16615)) |
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

**The ticket AC does not override this filter.** Acceptance criteria are often generated from the full module list and name `public: false` modules too. When an AC-listed module is non-public, do not build its endpoint silently — report it in the plan as *"listed in AC but `public: false` → excluded, confirm?"* and let the user decide. Building it first and discussing later is the failure mode this rule prevents.

#### Scripted module-parity check (module-derived apps)

When the endpoint set mirrors an app's modules, finish the design with a scripted comparison instead of eyeballing: for each module, read `expect`/`parameters` names and the response-field tokens of its `api` (for GraphQL: the selection-set fields in `body.query`), and diff them against the endpoint's `input_parameters`/`output_parameters` names. Expected differences are only (a) UI-only switches (`omit`, `select` helpers, "advanced" toggles), (b) module-side transformations the endpoint must not replicate, and (c) deliberate extras from the vendor docs. Anything else is a gap. On monday v2 ([IEN-16757](https://make.atlassian.net/browse/IEN-16757)) this check caught two missing output sub-objects (`linked_items`, time-tracking `history`) that a manual pass had missed.

#### Foreign API calls

A module in this app may call a different product's API. Google Slides `createPresentation` copies a file with Drive `files.copy`, and `listPresentations` uses Drive `files.list`. Do not add an endpoint for that call in this app, and do not put that API's OAuth scope on any endpoint here. The operation belongs on the app whose base URL and scopes already cover it (`google-drive` in that example). Confirmed on [IEN-16686](https://make.atlassian.net/browse/IEN-16686) (2026-09-23): `copyPresentation` and `listPresentations` stay out of `google-slides`. This app's Arbitrary call cannot stand in for them either — its base URL is `https://slides.googleapis.com/`, so it never reaches Drive. This is separate from cross-API augmentation inside one endpoint (IEN-16077).

## `api.imljson` Shape

A standard communication block, same directive family as RPCs (endpoint = compiled `IMTRPC`, standard `ExecuteRpc` chain): `url` (relative to `base.imljson` `baseUrl`), `method`, `qs`, `body`, `headers`, `temp`, `response.*` (`output`/`temp`/`valid`/`iterate`/`wrapper`/`limit`). No pagination (see Core Facts). Custom IML functions are fully usable (observed: `buildBatchRequests()`, `handleTabs()`, `omit()`, `stripEmpty()`).

**Only functions that exist may be called.** `api.imljson` is evaluated by the IML engine: it can call the built-ins in [builtin-iml-functions.md](builtin-iml-functions.md) and the app's own custom functions (`functions/{name}/code.js`, including pending ones on an approved app). Nothing else — there is no JavaScript in `api.imljson`, and a plausible-sounding helper (`compact()`, `toJSON()`, `removeNulls()`…) that is not in either list fails at runtime. Before using a helper: `ls ${CONTEXTS_DIR}/{slug}-v{ver}/functions/`. If the app already has an equivalent (Google Forms `removeEmpty`, Google Calendar/Drive `stripEmpty`), reuse it; create a new one only when nothing equivalent exists, and push it with `create-component.js … function {name}` + `update-app.js … function/{name}/code|test` **before** the endpoints that call it.

**Omit `"type": "json"`.** An object `body` is serialized as JSON by default (`request-options.ts` `serializeRequestBody`, `case 'json'` is the fallback for objects); modules in the same apps do not set `type`, and endpoints follow the module convention. The exception is `arbitraryCall`, where the body is a caller-supplied `any` value: the standard template uses `"type": "text"` (parity with the "Make an API Call" module), while GraphQL apps whose modules set `"type": "json"` (GitHub v4, monday v2) keep `json`. Neither handles both string and object bodies today — see § Standard Template → Body serialization before changing one.

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
- **Headers cannot be unset from an endpoint.** `getRequestHeaders` (`fetcher/request-options.ts`) lowercases keys and **skips entries whose value resolves to `undefined`** before merging endpoint headers over `base.imljson` headers. So `"X-Foo": "{{undefined}}"` (or an `ifempty(..., undefined)` that resolves to undefined) is a no-op and the base header still goes out; to send a different value, override it with a concrete value. Observed on monday v2: AI modules declare `"api-version": "{{undefined}}"`, which is inert — the base `API-Version: 2025-10` still reaches the gateway. Verified from the runtime source, not from docs.

### GraphQL APIs (monday v2, GitHub v4, Shopify, Linear…)

GraphQL changes the mechanics but not the contract — one endpoint still wraps one **operation** (one query or one mutation field). Every operation is POSTed to the API's single GraphQL URL (monday `/v2`, GitHub `/graphql`, Shopify `/admin/api/{version}/graphql.json`), so the URL no longer distinguishes endpoints — the operation document does:

- `body.query` holds a static operation document with **typed `$variables`**; `body.variables` maps endpoint inputs 1:1 onto them. Never interpolate input values into the query text (quoting and injection problems). Variable types must match the schema exactly (`[ID!]!`, `JSON`, `[BoardHierarchy!]`…) — verify each against the vendor's **introspection/schema reference**, not the prose docs (monday's docs showed `hierarchy_type` singular; the 2025-10 schema is `hierarchy_types: [BoardHierarchy!]`).
- **Even read operations are POSTs with a JSON body**, so the `ifempty`/`stripEmpty` guards below apply to every endpoint, not only to mutations — an explicit `null` variable overrides the server default (monday `boards.limit: null` → slicing error).
- Selection sets return the **full resource** the vendor docs list (including union/interface fragments such as `... on BoardRelationValue { linked_items { id name updated_at } }`), not the subset the module selected. Mirror the selection set in `output_parameters`.
- Enum arguments → `select` with the schema's enum values; `JSON`-scalar arguments (`column_values`, `defaults`, `variables`) → `any` input passed through verbatim.
- A version header (`API-Version`) belongs in `base.imljson`; an endpoint that needs a newer schema version (monday `getAggregate` → 2026-04) overrides it with a concrete value (see "Headers cannot be unset").
- Error handling lives in `base.imljson`, not per endpoint. GraphQL servers report validation/execution errors as HTTP `200` with a `body.errors` array (transport failures — 401/403/429/5xx — still come as non-2xx), so the base must inspect `body.errors`, not only the status code: monday `"valid": "{{validateResponse(statusCode, body)}}"` + `formatGraphQLErrors(body.errors)`, GitHub `"valid": "{{!body.errors}}"` + `formatErrorHandler(body.errors)`. Check this once when syncing the app; if the base only checks the status, an endpoint would return `{ "data": null, "errors": [...] }` as a success — flag it as a base-level gap rather than adding `response.valid` to each endpoint.

Reference: monday v2 ([IEN-16757](https://make.atlassian.net/browse/IEN-16757)) — 42 endpoints, scripted module-parity check, `stripEmpty` function added for array/collection guards.

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

- **`stripEmpty()`** — a **custom** IML function (not built-in) that recursively removes `null`, `undefined`, empty strings, empty objects `{}`, and empty arrays `[]` from a value (returns `undefined` when nothing is left). Required for every **array- or collection-valued** optional input in a JSON body, and the simplest choice for whole PATCH/POST bodies. **It must remove only empty values and never drop a filled-in one** (e.g. a `Date`) — see § `stripEmpty()` must never drop a filled-in value. Good examples to start from: Box (`box` v3) `stripEmpty`, Google Forms (`google-forms` v2) `removeEmpty`. Treat them as a **template, not a drop-in**: read the code and tests against the inputs of the app you are building (which value shapes can reach the function, which empty values the vendor API treats as a meaningful *clear*) and adjust before pushing. **Reuse the app's existing equivalent if there is one** (after reading it the same way); otherwise copy `code.js`/`test.js` from one of the examples into the target app as a new custom function (it must exist per app). Examples: `"body": "{{stripEmpty(omit(parameters, 'calendarId', 'sendUpdates'))}}"` (Google Calendar), `"variables": { "columns": "{{stripEmpty(parameters.columns)}}" }` (monday).
- **`omit()`** — to remove URL path parameters and query-string-only parameters from the body: `omit(parameters, 'calendarId', 'sendUpdates')`.
- **`encodeURL()`** — **only** when a path parameter may contain special characters that would break the URL (e.g., email addresses, user-provided strings with slashes or spaces). Example: `"/calendars/{{encodeURL(parameters.calendarId)}}/events"` with `"encodeUrl": false` on the api block to prevent double encoding. **Do not** use `encodeURL()` on simple alphanumeric IDs or slugs — it adds unnecessary complexity. Most path parameters (resource IDs, numeric IDs) do not need encoding.
- **`ifempty()`** — for optional **scalar** fields in a JSON body: `{{ifempty(parameters.field, undefined)}}`. Never for arrays or collections (see the table below). `{{if(length(parameters.field), parameters.field, undefined)}}` is an acceptable legacy form for flat arrays of scalars only (`length(null)` is `0`); it does not clean null leaves inside collection items, so prefer `stripEmpty()` whenever the app has it.
- **`toCollection()`** — for map/dictionary fields where the API expects a flat `{key: value}` object: define the input as an `array` of `{key, value}` pairs, then transform with `"{{toCollection(parameters.field, 'key', 'value')}}"` in the `api.imljson` body/qs. In output, represent these as `collection` with no spec (open/dynamic keys).
- **`join()`** — when a `select` with `multiple: true` produces an array but the API expects a comma-separated string: `"{{join(parameters.field, ',')}}"`. Prefer this over free-text input when the set of values is known.

### Empty-input guards — `ifempty()` vs `stripEmpty()` (verified against the runtime source)

Why guards are needed at all: the platform **fills every declared input before `api.imljson` runs** — an omitted scalar arrives as `null`, an omitted `array` / multi-`select` as `[]`, and an omitted `collection` as a full-shape object whose leaves are all `null` (`{ "calculated": { "function": null } }`). What then happens depends on *where the value goes*, not on the HTTP method (`imt-app-runtime/lib/core/chainMiddleware/fetcher/request-options.ts`, `requester/utils.ts`):

| Destination | Runtime behaviour | Guard |
|---|---|---|
| `qs` (any method) | `prepareQS` → `stripNullAndUndefined` — `null`/`undefined` values are dropped before the URL is built | **None** |
| `body` with `type: urlencoded` | `stripNullAndUndefined` on the form | **None** |
| `body` serialized as JSON (default for objects; every GraphQL request, including reads) | `JSON.stringify(body)` — `undefined` keys disappear, **`null` is sent literally**, `[]` and null-leaf objects are sent as-is | **Required** on every optional input |
| URL path parameters | always required | None |

Which guard, by **value shape**:

| Input shape | Guard | Why |
|---|---|---|
| Scalar (`text`, `number`, `boolean`, `date`, single `select`, `uuid`…) | `{{ifempty(parameters.x, undefined)}}` | `ifempty` (`@integromat/iml/lib/functions.js`) returns the default only for `""`, `null`, `undefined` |
| `array`, `collection`, `select` + `multiple: true` | `{{stripEmpty(parameters.x)}}` | `ifempty` passes `[]` and `{a: null}` through unchanged; `stripEmpty` prunes them to `undefined` and also drops null leaves inside items the caller *did* send |
| `any` / `json` (free-form JSON the caller supplies verbatim) | `{{ifempty(parameters.x, undefined)}}` | the caller owns the shape; pruning their `[]`/`{}` would change meaning |
| Whole body (`"body": "{{stripEmpty(omit(parameters, …))}}"`) | `stripEmpty` | simplest when every field is optional and none is an intentional empty value |

Why it matters: an explicit `null` overrides the server's default (monday `boards(limit: null)` → slicing error) and a sent-but-empty collection fails input validation (`ColumnCapabilitiesInput.calculated.function: null`). Vendor APIs where an empty array/object is a meaningful *clear* signal (Slack `blocks: []`, `attachments: []`) are the exception — there, do **not** use `stripEmpty` on that field and say so in `help`.

⚠️ **Do not over-apply guards** — `qs` never needs them regardless of method, and a required field never does. Guards go on optional JSON-body values only.

### `stripEmpty()` must never drop a filled-in value

The function's only job is to remove **empty** things — `null`, `undefined`, `""`, `{}`, `[]` and collections whose leaves are all empty. Anything the caller actually filled in must come out the other side unchanged: `false`, `0`, and any non-plain object the API expects to receive as a value. A stripper that drops a filled-in value causes silent data loss — the request succeeds and the vendor simply keeps the old value.

The known trap is **`Date`**: a `Date` is `typeof 'object'` with no own enumerable keys, so a naive implementation (`if (typeof obj === 'object') { … Object.keys(obj) … }`) mistakes it for `{}` and returns `undefined` — a `date` input then never reaches the API. The guard, placed **before** the object branch (realm-safe — `instanceof Date` is unreliable in the IML sandbox, IEN-15580):

```javascript
if (Object.prototype.toString.call(obj) === '[object Date]') return obj;
```

Rules:

- `test.js` must assert that filled-in values survive, not only that empty ones are removed: `false`, `0`, a `Date`, and a partially filled collection (Box v3 `functions/stripEmpty/test.js`).
- When reusing an app's existing `stripEmpty` / `removeEmpty` / `clearEmpties`, read it first. If it can drop a filled-in value that any input of your endpoints can carry (whole-body `stripEmpty(parameters)` / `stripEmpty(omit(parameters, …))`, or a collection containing such a field), fix the function in the same ticket — do not work around it per field. Before changing it, check where else it is used (`rg -l '<name>\(' modules/ rpcs/ webhooks/ functions/`): a custom function is shared by the whole app, so the change ships to every module that calls it too. If modules use it, keep the change strictly additive (preserve a value that was being dropped — never alter what the function already keeps or removes), run the existing tests plus the new ones, and call out the module impact in the Developer Notes; if the needed change would alter module behaviour, add a new function for the endpoints instead.
- Review: a stripper that drops a filled-in value reachable from an endpoint's inputs is a **Bug** (data loss); one that could but no current input reaches it is an Improvement (fix it anyway — the next endpoint will reach it).
- Changing the input type to dodge the problem (e.g. a `date` declared as `text`) is not a fix — the acceptance criteria require accurate types.

### Always-true parameters — hardcode, don't expose

When a parameter should logically always be `true` (or a fixed value) for the endpoint to be useful, hardcode it in `api.imljson` rather than exposing it as an input. Parameters that are a genuine user choice should remain exposed. Use the correct JSON type for hardcoded values: `true` (boolean) not `"true"` (string), `1` (number) not `"1"` (string).

### What is NOT allowed

- Custom IML functions that reshape output (e.g., `sortEventFields()`, `formatResponse()`)
- Extra API calls to augment the response (e.g., fetching text content via Drive API for a Docs endpoint — IEN-16077)
- Date formatting functions (e.g., `dateParameter()`, `formatDate()`) — use the Make `date` type and let the platform handle serialization, or pass raw strings
- Field renaming or aliasing between input parameters and API body keys — **one exception**: when the vendor key contains characters outside `[A-Za-z0-9_]` (OData `$search`, `$filter`, `$top`; keys with dots or dashes), name the input with the plain identifier (`search`, `filter`, `top`) and map it in `api.imljson` (`"qs": { "$search": "{{parameters.search}}" }`). Say so in `help` ("Sent as `$search`."). Special characters in Forman `name`s are a known source of IML path and mapping trouble, and the rename is a transport detail, not a semantic alias.

## Input/Output Schemas (Forman)

- Same parameter spec format as module `expect.imljson` (name/type/label/required/default/help/options/nested/spec). Deeply nested `select` + `nested` structures work (observed: `batchUpdateDocument` request-type picker).
- **`output_parameters` must document the full actual output.** When `response.output` is `{{body}}` passthrough, the declared schema must cover the whole API resource (IEN-16078 — createDocument was expanded from 3 fields to the full ~288 KB Document resource schema). AI callers rely on the declared schema, not the raw response.
- **Complex inputs are declared completely.** When the vendor parameter is an object or array of objects, the `spec` lists **every** documented sub-field (nested `collection`/`array` specs as deep as the vendor schema goes) — do not stop at the two or three fields the module happened to use. If the structure is genuinely open-ended (vendor "JSON" scalar, free-form `column_values`), declare it as `any` and describe the expected shape in `help` + `context.md` instead of inventing a partial spec.
- **Enums become `select`.** Every parameter the vendor documents with a closed set of values (REST enums, GraphQL `enum` types) is a `select` with those exact values as `options` (`label` humanised, `value` verbatim), `multiple: true` for list-of-enum arguments. Plain `text` for an enum is a defect, not a shortcut.
- **Empty response body → `"output_parameters": []`.** For `204`/empty-body operations (DELETE, archive, unsubscribe) the declared output is an empty array. Do not invent placeholder fields (`__IMTMESSAGE__`, `success`, `status`) that the API does not return — the result unwrap gives the caller `{}`.
- **Types to know about.** `uuid` is a `text` alias — use it for UUID-shaped IDs (self-documenting, enables UUID validation). `any` accepts any JSON value and is the right type for vendor "JSON scalar" inputs and the `arbitraryCall` body (every arbitraryCall uses it; it is undocumented in the public Make developer docs but is a runtime/Forman type). Check the runtime type list and existing apps, not only the public docs, before declaring a type unsupported.

### UI-only properties — leave them out

Endpoints have no form UI. Module-form properties carry nothing for an AI caller and are **omitted** from endpoint schemas:

| Property | Where it is wrong | Why |
|---|---|---|
| `advanced` | inputs | "Show advanced settings" is a module-form toggle; the AI caller sees a flat argument list |
| `labels` (`{ "add": …, "item": … }`) | **outputs** (never), inputs (drop on regular endpoints) | add-button / item captions of the array widget. Modules carry them; copying `expect` → `input_parameters` wholesale drags them along, and copying `interface` → `output_parameters` must not. The `arbitraryCall` template keeps the module's `labels` on `headers`/`qs` for parity with the 17 existing apps — harmless, not a finding |
| `mappable`, `mode`, `dynamic`, `rpc`, `omit`, `disabled`, `readonly`, `placeholder`, `grouped`, `editable` | inputs | form-rendering / RPC-refresh behaviour. `omit` fields are UI helpers that never reach the API — drop them, do not pass them through |
| `rpc://…` option sources | inputs | the AI caller has no form to fetch options into; replace with static `options` from the vendor enum, or a plain typed input |

`required`, `default`, `help`, `options`, `nested`, `spec`, `validate` stay.

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
- The `labels` object (e.g., `"labels": { "add": "Add header" }`) — if it is present at all; it is a UI-only property and should normally be dropped from endpoint schemas (see "UI-only properties" below)

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

### Scope rule — only scopes the app already declares

`scope.imljson` lists the OAuth scopes the operation needs, chosen **only from the scopes the app's connection/modules already request**. Never introduce a scope from the vendor docs that no module declares: the connection never asked the user for it, so the token lacks it and the call fails with a permission error at runtime, long after review. If the operation needs a scope the app does not have, the operation is out of scope for this app's endpoints — flag it. Foreign-API scopes are excluded for the same reason (§ Foreign API calls).

## Skill Tooling Support

All skill scripts handle endpoints:

| Script | Endpoint support |
|---|---|
| `download-app.js` | Downloads `endpoints/{name}/{api,input_parameters,output_parameters,scope}.imljson` + `context.md`; `metadata.json` gains `endpoints[]` |
| `review-changes.js` | Generic — endpoint change rows (`endpoint/{name}/{code}`) already flow through |
| `update-app.js` | `endpoint/<name>/<section>` — sections PUT via camelCase API path; `context` PATCHes the entity metadata from a `.md` file |
| `create-component.js` | `endpoint <name> <label> [connection] [description] [initMode]` (initMode `example`\|`blank`) |
| `update-component.js` | `endpoint` type — `label`, `description` (PATCH), `public`, `deprecated`, `archived` (dedicated POST routes). **Visibility is self-service**: `node update-component.js {slug} {ver} endpoint {name} public=true` (write script → same confirmation rule). Ask the user to toggle it in the SDK UI only if the call fails |
| `delete-component.js` | `endpoint` type — `DELETE .../endpoints/{name}` (public-app deletability left to the server) |
| `test-component.js` | ✅ `endpoint` type — same mockup `test.js` + communications as modules/RPCs; expected output is the **unwrapped object** (see [component-test-guide.md](component-test-guide.md)). Live execute still available via MCP `endpoint_execute` / platform Run Endpoint |

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
- [ ] Endpoint toggled **public** (visible) after creation — `update-component.js {slug} {ver} endpoint arbitraryCall public=true`

### Known Gotchas

| Issue | Detail |
|---|---|
| **CREATE doesn't apply `context` or `annotations`** | The `POST /endpoints` (or MCP `custom-apps_endpoints-configure` with `mode: CREATE`) ignores `context` and `annotations` fields. Always follow up with a separate `UPDATE` call to set them. |
| **Module `expect` vs endpoint `inputParameters` format** | Source modules may use a flat `spec: [...]` array for headers/qs items. Endpoints must use the nested `{ type: "collection", spec: [...] }` wrapper with `help` on every nested field. |
| **RPC references stripped** | Module `expect` may include `"rpc://someRpc"` entries (e.g., hint messages). These do not apply to endpoints — omit them entirely. |
| **Base auth merging** | Apps that inject auth via `base.imljson` `qs` or `headers` (e.g., Gemini's `qs.key`) — these merge automatically at runtime. Do not duplicate them in the endpoint's `api.imljson`. |
| **`public: false` after creation** | New endpoints are created with `public: false` (not visible). The MCP configure tool cannot flip it; the skill does it with `update-component.js {slug} {ver} endpoint {name} public=true` (`POST .../endpoints/{name}/public`) once the definition is pushed — do not leave it to the user unless that call fails. |
| **Object body → `[object Object]`** | With `"type": "text"` an AI caller that sends `body` as a JSON object (not a string) gets `String(body)` = `"[object Object]"` on the wire. Runtime limitation with a runtime fix pending — keep the template, add no app-level workaround. See § Standard Template → Body serialization. |

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

## Code Review Guidance for Endpoint Changes

- Changes surface as `endpoint/{name}/{code}` with codes `api`, `input_parameters`, `output_parameters`, `context` (and potentially `scope`).
- **Component tests.** When `api` is changed, run `test-component.js {slug} {ver} endpoint {name}` after `download-app.js` (same auto-run as modules/RPCs — [component-test-guide.md](component-test-guide.md)). Missing `test.js` is a note, not a Bug.
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
- `scope` matches the API call's minimal OAuth scope **and** is drawn from scopes the app's modules/connection already declare (§ Scope rule). A scope that no module requests is a Bug: the token will not carry it.
- **Functions exist**: every `{{fn(...)}}` in `api.imljson` is a built-in or an existing custom function of this app (`functions/`). A call to a function that does not exist is a Bug (runtime failure).
- **One vendor operation per endpoint**: an endpoint whose input decides which vendor API endpoint is called (to cover more API calls in one) is a Bug (IEN-16616) — the fix is two endpoints.
- **Parameter type accuracy**: check that `email`, `date`, `url`, `select` types are used where appropriate instead of generic `text` (see § Parameter Type Accuracy). Vendor enums declared as `text` instead of `select` are a finding.
- **UI-only properties**: `advanced`, `labels`, `mappable`, `mode`, `rpc://` sources, `omit` fields in `input_parameters`, and `labels` anywhere in `output_parameters` are findings (§ UI-only properties). Placeholder output fields for empty-body responses (`__IMTMESSAGE__`) are findings — expected `output_parameters: []`.
- **Complete complex inputs**: nested object inputs must declare every documented sub-field, or be `any` with the shape described in `help`/`context` — a half-declared `collection` spec is a finding.
- **Sentence case labels**: verify all endpoint labels and parameter labels follow Sentence case (see § Sentence Case Labels).
- **Endpoint descriptions**: every endpoint must have a `description` — same UX requirements as modules.
- **Connection attachment**: only relevant connections should be attached — not deprecated or unused ones (see § Connection Attachment).
- **Coverage completeness**: compare the app's module list and the third-party API surface against the implemented endpoints. Flag significant gaps. Exclude `public: false` modules from that comparison (§ Coverage Completeness) — a missing endpoint for one is not a gap; an endpoint that exists only because a `public: false` module exposed the operation is a scope question for the user, not a Bug. A module that calls a different product's API is not a gap either (§ Foreign API calls, IEN-16686): do not add that endpoint here, and do not add that API's scope. Missing it is not a review finding once the ticket marks it out of scope.
- **Primitive array `help`**: check that even primitive array specs (e.g., `spec: { type: "text" }`) have `help` text.
- **Hardcoded value types**: verify hardcoded values use correct JSON types (`true` not `"true"`, `1` not `"1"`).
- **Empty-input guards**: every optional input that lands in a **JSON body** (any method — GraphQL reads included) is guarded: scalars → `ifempty(…, undefined)`, arrays / collections / multi-selects → `stripEmpty()` (or the app's equivalent). `ifempty()` on an array or collection is a Bug (it passes `[]` and null-leaf objects through). Guards on `qs` values are unnecessary (the runtime drops `null`/`undefined` there) — a note, not a Bug. See § Empty-input guards.
- **`stripEmpty()` drops only empty values**: open the app's stripper (`functions/stripEmpty/code.js` or equivalent) and check it cannot discard a filled-in value — the known case is `Date` (no `[object Date]` short-circuit before the object branch). If such a value can reach it from an endpoint's inputs (top-level or nested in a wrapped body) → Bug (silent data loss). See § `stripEmpty()` must never drop a filled-in value.
- **`encodeURL()` usage**: verify `encodeURL()` is only used on path parameters that may contain special characters. Simple alphanumeric IDs do not need encoding.
- **URL verification**: API docs URLs in `context` and `help` text must be reachable (not 404). Verify before finalizing.
- **Endpoint URL correctness**: verify the endpoint's `api.url` matches the correct API path — cross-check against both the ticket acceptance criteria and the actual module implementation / vendor API docs.
- **Deprecated API operations**: verify the target API operation is not deprecated or removed in the vendor's current docs. If it is, a newer replacement should be used instead.
- **Parameter naming consistency**: all parameter `name` fields within one endpoint should follow the same casing convention (matching the vendor API), with no mixing of `snake_case` and `camelCase`.
- **Parameter-to-API wiring**: every input parameter must be properly mapped in `api.imljson` — check that no parameter is defined in the input schema but missing from the `url`, `qs`, `body`, or `headers` in the API block. Also verify the mapping uses the **correct vendor field name** — if a parameter was renamed for disambiguation, the `api.imljson` must still send it under the original API field name, not the renamed one.
- **Context file freshness**: when an endpoint is modified or disabled, verify that other endpoint contexts referencing it are updated (e.g., cross-references to helper endpoints, prerequisite calls, related operations).
