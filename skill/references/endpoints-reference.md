<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# SDK Endpoints Reference

> Read when: creating, updating, or reviewing an SDK Endpoint — entity structure, admin API, Forman input/output schemas, `context.md`, annotations, Arbitrary Call template, runtime validation caveats. This file holds the core facts; design, schema, Arbitrary Call and review topics sit in `endpoints-reference/` parts: open one only when its row in § Parts applies.

SDK **Endpoints** are a new app component (per the [Endpoints RFC](https://make.atlassian.net/wiki/x/BwBmvQ)) that expose **one atomic third-party API call** as a first-class, AI-consumable operation. They are designed for AI callers (MCP tools / the Executor initiative), not for the scenario builder.

Everything in this document is verified against the live SDK admin API (google-docs v1, 2026-07-24), the IEN-15912 ticket family, and source code: `imt-web-api` master (`lib/controllers/sdk/endpoints.ts`, `lib/service/sdk-endpoint.service.ts`, `lib/repository/sdk-endpoint.repository.ts`, `lib/routers/sdk.js`), `imt-app-runtime` master (`lib/core/chainMiddleware/endpoint.ts`, `lib/api/rpc.js`, `lib/types.ts`), and `make-mcp-server-host` (`lib/libs/make-mcp-server/modules/endpoints.module.ts`).

## Parts (open every part whose trigger applies, skip the rest)

| Part | Open when |
|---|---|
| [endpoints-reference/api-imljson-shape.md](endpoints-reference/api-imljson-shape.md) | designing or reviewing an endpoint `api.imljson`; GraphQL APIs |
| [endpoints-reference/pure-api-wrapper.md](endpoints-reference/pure-api-wrapper.md) | designing a Regular endpoint: allowed transformations, `ifempty` / `stripEmpty` guards, hardcoded parameters |
| [endpoints-reference/forman-schemas.md](endpoints-reference/forman-schemas.md) | `input_parameters` / `output_parameters`: `help`, types, arrays and collections |
| [endpoints-reference/arbitrary-call.md](endpoints-reference/arbitrary-call.md) | creating, updating or reviewing the `arbitraryCall` endpoint: template, checklist, gotchas |
| [endpoints-reference/code-review-guidance.md](endpoints-reference/code-review-guidance.md) | reviewing any endpoint change |

## Core Facts

| Fact | Detail |
|---|---|
| **One endpoint = one API call** | An endpoint wraps exactly one third-party API operation. Multi-request chains (arrays) and cross-API augmentation are **out of contract** — e.g. the `google-docs` module fills its `text` output via an extra Drive API call, but the `getDocument` endpoint must not (IEN-16077: the dead `text` field was removed instead). **Also never use an input to select which vendor endpoint to call** — building the URL as `/me/messages` or `/me/mailFolders/{id}/messages` depending on whether `folderId` is filled packs two API endpoints into one SDK endpoint to "cover more" ([IEN-16616](https://make.atlassian.net/browse/IEN-16616) Outlook `listMessages`). Split them into two endpoints; a module that does this internally does not justify replicating it. |
| **No pagination** | Endpoints are dumb single-request wrappers: no `pagination` directive, no iteration, no `response.limit`. Expose the vendor's paging controls (`page`, `limit`, `cursor`, `pageToken`, `offset`…) as **plain inputs** and surface the vendor's continuation token (`cursor`, `nextPageToken`, `next_items_page`…) in `output_parameters` so the AI caller can page by calling again. If the vendor has a dedicated continuation operation (monday `next_items_page`), make it its own endpoint. |
| **Compiles as `IMTRPC`** | Same compiled class as RPCs (`imt-app-runtime/lib/api/rpc.js` extends `IMTRPC`); executes via the standard `ExecuteRpc` middleware chain with a single difference: the `endpointExecution` marker triggers result unwrap (see runtime-reference/inline-endpoint-calls.md). |
| **Not scenario-runnable directly** | Running an endpoint inside a scenario is not supported at the Make platform level (yet). Execution paths: **MCP** (`endpoint_execute`), the platform **Run Endpoint** button (similar to Run RPC), and **inline delegation from a module/RPC** via the `api.endpoint` directive (see below). |
| **Modules can delegate to Endpoints** | A module/RPC `api.imljson` may declare `"endpoint": "name"` + `"input": {...}` instead of `url` — the runtime runs the named sibling Endpoint in place of the HTTP request. Full directive spec: [runtime-reference/inline-endpoint-calls.md](runtime-reference/inline-endpoint-calls.md#inline-endpoint-calls-apiendpoint). |
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

`apps.change.table = 'endpoint'`. Versioned (→ pending change rows on an approved app, same semantics as modules, see [app-compilation-and-deployment-reference.md](app-compilation-and-deployment-reference.md)):

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
