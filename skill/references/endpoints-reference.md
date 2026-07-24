<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# SDK Endpoints Reference

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

MCP-style hints on the endpoint entity: `readOnlyHint`, `openWorldHint`, `idempotentHint`, `destructiveHint`. May be an empty object `{}` when the developer hasn't set them (observed on google-docs `batchUpdateDocument`/`createDocument`; only `getDocument` had them set). Missing annotations on a read-only or destructive endpoint are a legitimate review Improvement.

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
- **No nested endpoint calls** — an Endpoint's own `api` may not use the `api.endpoint` directive (`InvalidConfigurationError`).

## Input/Output Schemas (Forman)

- Same parameter spec format as module `expect.imljson` (name/type/label/required/default/help/options/nested/spec). Deeply nested `select` + `nested` structures work (observed: `batchUpdateDocument` request-type picker).
- **`output_parameters` must document the full actual output.** When `response.output` is `{{body}}` passthrough, the declared schema must cover the whole API resource (IEN-16078 — createDocument was expanded from 3 fields to the full ~288 KB Document resource schema). AI callers rely on the declared schema, not the raw response.

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

## Code Review Guidance for Endpoint Changes

- Changes surface as `endpoint/{name}/{code}` with codes `api`, `input_parameters`, `output_parameters`, `context` (and potentially `scope`).
- **Breaking Changes: skip.** Endpoints cannot run in scenarios, so no existing scenario mappings can break. State the skip reason as usual. (A shared custom IML function edited for an endpoint CAN still break modules that reuse it — evaluate that under the function change, e.g. IEN-16083 `getDocumentResponse`.)
- The Runtime Reference hard gate applies to endpoint `api` changes the same as module/RPC `api` changes.
- Verify `output_parameters` ↔ `response.output` shape consistency (IEN-16078 class).
- Verify `context.md` accuracy against actual behavior — it is AI-caller documentation.
- Check `annotations` on new endpoints (read-only/destructive hints) and `scope` matches the API call's minimal OAuth scope.
