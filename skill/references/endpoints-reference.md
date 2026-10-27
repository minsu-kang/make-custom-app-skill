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
| **Not scenario-runnable directly** | Running an endpoint inside a scenario is not supported at the Make platform level (yet). Execution paths: `run-component.js` (skill script, lifecycle §6 "Run live"), **MCP** (`endpoint_execute`), the platform **Run Endpoint** button (similar to Run RPC), and **inline delegation from a module/RPC** via the `api.endpoint` directive (see below). |
| **Modules can delegate to Endpoints** | A module/RPC `api.imljson` may declare `"endpoint": "name"` + `"input": {...}` instead of `url` — the runtime runs the named sibling Endpoint in place of the HTTP request. Full directive spec: [runtime-reference/inline-endpoint-calls.md](runtime-reference/inline-endpoint-calls.md#inline-endpoint-calls-apiendpoint). |
| **Connection binding** | `attachedAccounts` array on the endpoint entity names the app connection(s) the endpoint uses. Managed via `POST/DELETE .../endpoints/{name}/connections`. |
| **Consumables** | `centicreditsFormula` (+ description/documentation URL/meta) on the endpoint entity — the "Consumables" tab in the SDK UI. `null` when unset. Consumable edits are audited and versioned. |
| **Feature-flagged** | All endpoint routes in `imt-web-api` are gated by the growthbook flag `IS_SDK_ENDPOINTS_ENABLED` — 404-class error on environments where it's off. |
| **No endpoint aliasing** | There is no aliasing of endpoints in the current design. The fraction of apps using multiple APIs is small, and aliasing offers little benefit. Future options may enable complex app modules connecting multiple endpoints. |
| **Binary upload and download not supported** | `endpoint_execute` sends and receives JSON. No `buffer` parameter, no multipart body, no raw byte body, no binary response (file download, PDF export). **The only uploads that may be endpoints:** (a) the request passes a URL and the vendor fetches the file; (b) the JSON body contains the file as base64 text (`contentBytes`, Gmail `raw`, Jira/Confluence attachment-by-base64), declared as `text`, not `buffer`. **Skip the whole operation** when the file moves as raw bytes. A create-upload-session call is that case: its `uploadUrl` still needs a byte PUT, Make MCP has no tool that can PUT those bytes, and `arbitraryCall` is pinned to the app's API host and attaches `Authorization` (Graph returns 401 on the upload host when that header is sent). Returning `uploadUrl` is not the URL-fetch upload in (a). Do not keep the session so a ticket row survives. Implementation and review use the same verdict: do not build it; if it was built, remove it. Do not review the session schema instead. ([Slack thread](https://integromat.slack.com/archives/C0BB266NWCU/p1789467764790229), [IEN-16615](https://make.atlassian.net/browse/IEN-16615), IEN-16850) |
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

Markdown document served to AI callers. Frontmatter carries `name` and `description`. The body documents usage, options, and limitations of **this call** (request-type examples, index semantics, classification limitations). Accuracy against actual behavior matters.

How a scenario module differs ("the module rewrites…", "the scenario module sends…") belongs in Developer Notes, not here. Name another endpoint in plain text (`the searchDriveItems endpoint`). A relative link such as `[Search drive items](searchDriveItems)` points nowhere.

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

## Shared rules

`create-endpoint.md` and `code-review-guidance.md` apply this table. Do not restate a weaker version in either file. The verdict is the same for the person building the endpoint and the person reviewing it.

| Rule | Requirement | Verdict |
|---|---|---|
| `context.md` | AI-caller document for this call. Module comparisons go to Developer Notes. Another endpoint is named in plain text. See [`context.md`](#contextmd). | Required fix |
| No `pagination` directive | No `pagination`, no `iterate`, no `response.limit`. Paging controls are plain inputs. The continuation token is an output. A vendor continuation operation is its own endpoint. See [Core Facts](#core-facts). | Required fix. Remove the directive. |
| `"type": "json"` | Omit it on a regular endpoint. An object body serializes as JSON by default. `arbitraryCall` keeps `"type": "text"`. See [api-imljson-shape.md](endpoints-reference/api-imljson-shape.md). | Required fix |
| `stripEmpty` keeps filled values | The stripper removes only empty values. `false`, `0`, a `Date`, and a filled collection or facet `{}` survive, and `test.js` covers them. See [pure-api-wrapper.md](endpoints-reference/pure-api-wrapper.md#stripempty-must-never-drop-a-filled-in-value). | Bug when a filled value this endpoint can send would be dropped |
| Output schema | `output_parameters` is the vendor resource for that call, minus write-only fields, with `help` on every field. `response.output` unwraps that same value (`{{body}}` or the list array). Every returned key is declared, and each value's type matches the field. | Required fix |
| Module parity | When endpoints mirror modules, a script diffs module `expect` / response fields against endpoint input and output names. Allowed deltas are UI-only switches, module-side transformations, and deliberate extras from the vendor docs. See [Scripted module-parity check](#scripted-module-parity-check-module-derived-apps). | Required fix for any other gap |
| GraphQL | Static operation document, typed `$variables` mapped 1:1, selection set equals the full resource. Argument types come from the schema, not from prose. See [GraphQL APIs](endpoints-reference/api-imljson-shape.md#graphql-apis-monday-v2-github-v4-shopify-linear). | Required fix |
| No token / credential passthrough | Never expose an `access_token`, `refresh_token`, API key, or sub-resource bearer token in `output_parameters` / `response.output` (e.g. a `GetPageAccessToken` helper endpoint, or `fields=access_token` on `GET /me/accounts`), and never add a bearer token input (`page_access_token`) for the AI caller to pass between endpoints ([security-reference.md § 1.2](security-reference.md#1-credential--secret-handling), [IEN-16847](https://make.atlassian.net/browse/IEN-16847)). When a module uses an internal 2-step token exchange (`temp.accessToken` with `"output": null`), or when an app has no "Make an API Call" module because the vendor API returns tokens on regular routes, stop and flag the security risk to the user instead of exposing tokens to the AI context. | Critical (`[SECURITY]` 1.2) — block / do not commit |

## UX & Naming Conventions

### Sentence Case Labels

Every endpoint display `label` is **Sentence case**: the endpoint label, every input parameter, every output parameter, and every nested collection or array spec label. The technical `name` stays camelCase. See [Apps UX best practices (Confluence)](https://make.atlassian.net/wiki/x/DAfcyg).

Module labels are often Title Case. Do not copy them onto an endpoint. The module-field exception in [app-ux-best-practices](app-ux-best-practices.md) (follow the app when its labels are Title Case) does not apply to endpoints. [code-smells-reference.md](code-smells-reference.md) I-03 is a module-interface smell and does not relax this rule.

Examples: `List files`, `Get a message`, `File ID`, `Application instance`, `Query string`, `Query parameter`.

Implementation and review use the same verdict: a Title Case endpoint label is a required fix. The module's case is not a reason to keep it.

### Endpoint Descriptions

Every endpoint must have a `description` — the same UX requirements apply as for modules. The description should be a concise sentence explaining what the endpoint does (e.g., `"Returns metadata for a file."`, `"Creates a new event in the specified calendar."`).

### Connection Attachment

Only attach connections that are attached to the **real modules** in the app or what is explicitly mentioned in the ticket AC. Some connections in the app may be deprecated, unused, or canonical versions for other apps of the same family. If uncertain which connections should be attached, ask.

### Coverage Completeness

Verify that the suggested/implemented endpoints cover all of the app's functionality as much as possible. Compare the app's **visible** modules with the list of endpoints and the third-party API surface. If the app has 15 modules covering 12 distinct API operations, the endpoint list should aim to cover all 12 (minus any that require unsupported features like binary uploads).

#### Exclude hidden modules before comparing

**Only modules on the app's usable surface may drive an endpoint.** Filter the module list **before** designing, using `metadata.json` `modules[]` (filled by `download-app.js`):

| Drop when | Source | What it means |
|---|---|---|
| `public === false` | SDK `GET .../modules` (`modules[].public`) | Hard-disable. The compiled package drops the module. |
| `private === true` | IPM `GET .../admin/apps/{slug}` (`modules[].private`) | Soft-hide. Hidden from the scenario picker. Existing scenarios still run. |

`private: null` means the module is absent from the deployed module list. It does not mean the module is public. Read `public`. A vendor doc for the operation, and an AC row that names the module, do not put the endpoint back. Excluded modules are not coverage gaps: list them as excluded.

**The ticket AC does not override this filter.** Report the row as *"listed in AC but `public: false` or `private: true` → excluded, confirm?"* and wait. Building it first is the failure this rule prevents (IEN-16850 `createAPage`, SDK `public: false`).

Implementation and review use the same verdict: an endpoint built from an excluded module without that confirmation is removed.

#### Scripted module-parity check (module-derived apps)

When the endpoint set mirrors an app's modules, finish the design with a scripted comparison instead of eyeballing: for each module, read `expect`/`parameters` names and the response-field tokens of its `api` (for GraphQL: the selection-set fields in `body.query`), and diff them against the endpoint's `input_parameters`/`output_parameters` names. Expected differences are only (a) UI-only switches (`omit`, `select` helpers, "advanced" toggles), (b) module-side transformations the endpoint must not replicate, and (c) deliberate extras from the vendor docs. Anything else is a gap. On monday v2 ([IEN-16757](https://make.atlassian.net/browse/IEN-16757)) this check caught two missing output sub-objects (`linked_items`, time-tracking `history`) that a manual pass had missed. Review uses the same verdict: any other gap is a required fix.

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

`scope.imljson` lists the OAuth scopes the operation needs, chosen **only from the scopes the app's connection/modules already request**. Never introduce a scope from the vendor docs that no module declares: the connection never asked the user for it, so the token lacks it and the call fails with a permission error at runtime, long after review. If the operation needs a scope the app does not have, the operation is out of scope for this app's endpoints — flag it. Foreign-API scopes are excluded for the same reason (§ Foreign API calls). With a vendor that offers granular scopes, each endpoint declares the scopes of its one call and the connection default stays small ([code-review-criteria/api-imljson.md § OAuth Scope Placement](code-review-criteria/api-imljson.md#oauth-scope-placement-mandatory-for-oauth-connections-whose-vendor-documents-granular-scopes)).

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
| `test-component.js` | ✅ `endpoint` type — same mockup `test.js` + communications as modules/RPCs; expected output is the **unwrapped object** (see [component-test-guide.md](component-test-guide.md)). Live execute: `run-component.js` (lifecycle §6 "Run live"), MCP `endpoint_execute`, or platform Run Endpoint |
