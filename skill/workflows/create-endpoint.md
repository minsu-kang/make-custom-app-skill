<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->

# Create Endpoint Workflow

> Read [lifecycle.md](lifecycle.md) first. Creates or updates SDK Endpoints — **Arbitrary Call** (passthrough) or **Regular** (typed, single operation). Entity and admin API: [endpoints-reference.md](../references/endpoints-reference.md); its topic parts (`endpoints-reference/`) are named at the step that needs them.

## Type detection

| Ticket says | Type |
|---|---|
| "Arbitrary call", "Make an API Call" module, `arbitraryCall` | Arbitrary Call — use the Standard Template in [arbitrary-call.md](../references/endpoints-reference/arbitrary-call.md) |
| A specific API operation ("List messages", "Create event") | Regular — design per operation |

## Arbitrary Call

Read [arbitrary-call.md](../references/endpoints-reference/arbitrary-call.md) first (template, derivation steps, checklist, gotchas).

1. **Source module.** From the local copy (lifecycle §2): `modules/{name}/{api|expect|scope}.imljson` of `makeAnApiCall` or `makeApiCall`. Extract base URL from `api.url` (e.g. `https://gmail.googleapis.com/gmail/{{parameters.url}}` → `https://gmail.googleapis.com/gmail/`), the connection (`metadata.json` `connections[]`; ask the user if several), `scope`, and any non-standard api directives.
2. **Base config.** Auth injected in `base.imljson` via `qs` or `headers` merges automatically; do not duplicate it in the endpoint.
3. **Existing endpoints.** Run `download-app.js` first, then check `metadata.json` `endpoints[]` — if `arbitraryCall` exists, tell the user and stop.
4. **Example path** for help text and context: a parameter-free GET (`/v1/models`, `/v1/users/me/messages`); otherwise the most common path with a placeholder, taken from the API docs (`customfield_10283`).
5. **Create** (confirmation first): `create-component.js {slug} {ver} endpoint arbitraryCall "Arbitrary call" {connection} "Performs an arbitrary authorized API call." blank` followed by `update-app.js … endpoint/arbitraryCall/{section}` for the four sections, with the template, substituting `BASE_URL` / `EXAMPLE_PATH`, scope from the source module. Keep the template's `"type": "text"` as is — an object body from an AI caller becomes `[object Object]` on the wire, but that is a runtime limitation with a runtime fix pending; do not change the request `type` or add app-level workarounds ([reference § Standard Template → Body serialization](../references/endpoints-reference/arbitrary-call.md#standard-template)).
6. **Context + annotations** — mandatory follow-up, CREATE does not apply them. `context` from the template (`APP_NAME`, `BASE_URL`, `EXAMPLE_PATH`, `API_DOCS_URL`) goes through `update-app.js … endpoint/arbitraryCall/context`. `annotations` is the complete object `{ "readOnlyHint": false, "openWorldHint": false, "idempotentHint": false, "destructiveHint": false, "arbitraryCallHint": true }` saved as `endpoints/arbitraryCall/annotations.json` and pushed with `update-app.js … endpoint/arbitraryCall/annotations`.
7. **Public.** The endpoint is created `public: false`; the MCP tool cannot flip it. Toggle it yourself: `node ${SKILL_ROOT}/scripts/update-component.js {slug} {ver} endpoint arbitraryCall public=true` (write script → confirmation first). Only if that call fails, ask the user to toggle visibility in the SDK admin UI.
8. **Verify** after `download-app.js`: `arbitraryCallHint: true`, `help` on every input/output parameter, `context` has YAML frontmatter + body, scope matches the source module, `attachedAccounts` set. Then run `test-component.js {slug} {ver} endpoint arbitraryCall` (add mockup `test.js` when missing).

MCP equivalents (lifecycle §6): reads `custom-apps_modules-fetch { appName, appVersion, moduleName, sections }`, `custom-apps_fetch { sections: ["base"] }`, `custom-apps_endpoints-fetch`; create `custom-apps_endpoints-configure { mode: CREATE, endpointName: arbitraryCall, label, description, attachedAccounts: [conn], sections: { api, inputParameters, outputParameters, scope } }`.

## Regular

Before designing, read [api-imljson-shape.md](../references/endpoints-reference/api-imljson-shape.md), [pure-api-wrapper.md](../references/endpoints-reference/pure-api-wrapper.md) and [forman-schemas.md](../references/endpoints-reference/forman-schemas.md); step 2 links to the sections it relies on.

1. **Context.** Which operation(s) to wrap; fetch the vendor docs for each (hard rule 1); check related modules for naming, fields, scope; sync code and read `base.imljson` (lifecycle §2). List the app's existing custom functions (`ls ${CONTEXTS_DIR}/{slug}-v{ver}/functions/`) — you may call only those and the IML built-ins.
   - **Filter the module list first.** When modules drive the endpoint list, drop every module with `public === false` or `private === true` before designing — **even when the ticket AC names them**. Read `modules[].public` in `metadata.json` (SDK). `private: null` does not mean the module is public. Report each dropped row as "excluded, confirm?" and do not build it until the user confirms. Drop modules that call a foreign API too. See [endpoints-reference § Coverage Completeness](../references/endpoints-reference.md#coverage-completeness).
   - **One endpoint per vendor operation.** A module that calls vendor endpoint A or B depending on an input becomes two SDK endpoints — never one endpoint whose input decides which API endpoint to call (IEN-16616).
2. **Design per operation** — [Pure API Wrapper Principle](../references/endpoints-reference/pure-api-wrapper.md#pure-api-wrapper-principle): no output transformation, minimal input transformation, schemas mirror the vendor's.
   - `api.imljson`: method, path relative to `baseUrl`, `qs`, `body`; no `type` key (objects serialize as JSON by default; `arbitraryCall` is the exception); `{{encodeURL(parameters.x)}}` for path params **only when the value may contain special characters** (not for simple IDs) with `"encodeUrl": false`; `response.output` is `{{body}}` (or `{{body.items}}` for lists). No `pagination` — paging controls are plain inputs and the vendor's cursor/token is an output. **Guards on every optional JSON-body value, any method** (GraphQL reads are POSTs too): scalars `{{ifempty(parameters.x, undefined)}}`, arrays / collections / multi-selects `{{stripEmpty(parameters.x)}}` (reuse the app's existing equivalent — `stripEmpty`, `removeEmpty` — or add the function first); `qs` values need no guard ([reference § Empty-input guards](../references/endpoints-reference/pure-api-wrapper.md#empty-input-guards--ifempty-vs-stripempty-verified-against-the-runtime-source)). GraphQL APIs: static operation document with typed `$variables`, variables mapped 1:1, selection set = full resource ([reference § GraphQL APIs](../references/endpoints-reference/api-imljson-shape.md#graphql-apis-monday-v2-github-v4-shopify-linear)). When a module does an extra pre-check call, use a separate helper endpoint (see reference).
   - `input_parameters.imljson`: every API parameter with the vendor's names and types; `help` **mandatory** on every field incl. nested; `select` (+ `multiple`) for **every** enum; specific types (`email`, `date`, `url`, `uuid`, `number`, `boolean`, `any` for vendor JSON scalars); complex objects declared **completely** (all documented sub-fields); pagination/ordering params last; omit `required: false`; no UI-only properties (`advanced`, `labels`, `mappable`, `mode`, `rpc://`, `omit` fields); vendor keys with special characters (`$search`) get a plain `name` and are mapped in `api`; `validate` for min/max; array/collection spec per [reference](../references/endpoints-reference/forman-schemas.md#array-and-collection-spec-structure).
   - `output_parameters.imljson`: the vendor resource for that call, minus write-only fields, `help` on every field, never `labels`. `response.output` unwraps that same value. Empty-body responses → `[]` (no placeholder fields). See [Shared rules](../references/endpoints-reference.md#shared-rules).
   - `scope.imljson`: minimal scope, chosen only from scopes the app's modules/connection already declare — never a new one from the vendor docs. `context.md`: YAML frontmatter (`name`, `description`) on **every** endpoint. The body is usage and limitations of this call. Module comparisons go to Developer Notes ([Shared rules](../references/endpoints-reference.md#shared-rules)). Annotations accurate; `arbitraryCallHint` false or absent.
   - **Module parity (module-derived sets).** Before pushing, diff with a script. Allowed deltas and the review verdict are in [Shared rules](../references/endpoints-reference.md#shared-rules).
3. **Create and push** with the skill scripts (confirmation first): `create-component.js {slug} {ver} endpoint {name} "{label}" {connection} "{description}"`, then `update-app.js {slug} {ver} endpoint/{name}/{api|input_parameters|output_parameters|scope|context|annotations}` from the local files (`annotations` = `annotations.json`, the complete hint object). New custom functions go first (`create-component.js … function {name}` + `update-app.js … function/{name}/code|test`). A section whose body is `[]` is not sent on the admin route — that PUT returns HTTP 500 `42501`. Transfer ownership to the acting user, `PUT` that section on `/api/v2/sdk/apps/{slug}/{version}/endpoints/{name}/{section}`, then transfer ownership back ([forman-schemas.md § Saving `[]`](../references/endpoints-reference/forman-schemas.md#inputoutput-schemas-forman)). Skip the write when the stored section is already `[]`. Do not invent a placeholder field to avoid the empty array.
4. **Public.** `node ${SKILL_ROOT}/scripts/update-component.js {slug} {ver} endpoint {name} public=true` for each new endpoint (confirmation first; a single confirmation for the batch is fine). Ask the user to toggle in the UI only if the call fails.
5. **Live, then fixtures** (lifecycle §6 "Run live"). Transfer ownership to the acting user first. The live input includes every parameter, required and optional. The script uses only that user's connection. After the calls, delete every vendor record this run created, then show the review result and ask before changing schemas, `context.md`, or `help`. Live again after those edits. When the review passes and a mockup path is set, add `data/{slug}/v{version}/endpoints/{name}/test.js` from the live request and run `test-component.js` ([component-test-guide.md](../references/component-test-guide.md)). Expected output is the unwrapped object, not an RPC-style array. No connection of yours → create the request in that turn with Make MCP `connection_create`, `appName` `app#{slug}` and `endpointNames` for every endpoint this run covers. The compiled slug does not list uncommitted SDK endpoints. Transfer ownership back before close-out.
6. **Close out** (lifecycle §7), only after the live phase: Developer Notes, context file, Pinecone. **Do not run `commit-changes.js commit`** — development ends at the push; the reviewer/committer commits. Commit only on an explicit user instruction.

## Updating an existing endpoint

Same tools and principles. Skip CREATE; fetch the current sections first so you do not overwrite other changes; push sections individually with `update-app.js endpoint/{name}/{section}` (context and annotations update independently).

## Checklist

- [ ] Type detected; source module / vendor docs read (GraphQL: schema/introspection, not prose, for argument types)
- [ ] Connection identified (only connections used by real modules or mentioned in AC)
- [ ] `public === false`, `private === true`, and foreign-API modules excluded — also when the AC lists them (flagged, not built). `private: null` was not treated as public
- [ ] Coverage verified (endpoints cover app functionality; gaps flagged); one endpoint per vendor operation, no input-driven path switching
- [ ] Deprecated API operations checked; newer replacements used where available; obsolete/deprecated/reserved individual parameters excluded
- [ ] Upload is a URL the vendor fetches, or base64 text inside JSON. No `buffer`, no multipart, no raw byte PUT, no create-upload-session whose file is a later PUT to `uploadUrl`
- [ ] Every IML function called in `api.imljson` exists (built-in or this app's `functions/`); new helper functions pushed first
- [ ] Optional JSON-body values guarded: scalars `ifempty`, arrays/collections/multi-selects `stripEmpty` (or app equivalent); no guards on `qs`. `stripEmpty` keeps `false`, `0`, `Date`, and a filled collection ([Shared rules](../references/endpoints-reference.md#shared-rules))
- [ ] Endpoint created with confirmation; context (with frontmatter) + annotations set on every endpoint (`openWorldHint: true` for outbound external actions); no raw IML (`{{...}}`) in `help` or `context.md`
- [ ] Every endpoint label, including nested fields, is Sentence case with uppercase acronyms (`SIP`, `SID`, `URL`, `ID`). Module Title Case was not copied. Descriptions present; parameter naming consistent; sibling parameter names in `help` match `input_parameters[].name`; special-character vendor keys mapped from plain names
- [ ] Inputs: enums are `select` (no duplicate `options`); `url`/`password`/`date`/`email` types accurate; complex objects fully declared; `help` matches `api.imljson` serialization (no string/object mismatch on `urlencoded` or `toJsonString()`); no UI-only props (`advanced`, `labels`, `mappable`, `mode`, `rpc://`, `omit` helpers)
- [ ] [Shared rules](../references/endpoints-reference.md#shared-rules) applied: `context.md` has no module comparison, no `pagination` directive, no `"type": "json"` except `arbitraryCall`'s `"type": "text"`, output schema is the vendor resource minus write-only fields and matches `response.output`, module parity was diffed by script, GraphQL uses a static document and the full selection set
- [ ] Outputs: full resource; no `labels`; empty-body responses `[]`
- [ ] Scope drawn only from scopes the app already declares
- [ ] All input parameters wired in `api.imljson` to correct vendor field names; validation directives applied
- [ ] Module parity diffed by script (module-derived sets)
- [ ] API docs URLs verified reachable (not 404)
- [ ] Context files of other endpoints cross-referencing this one are up to date
- [ ] Endpoint run live (every input, own connection, review shown, created records deleted); after a pass, mockup fixture + `test-component.js` (skipped with a note if no mockup path)
- [ ] Public toggled via `update-component.js … public=true` (user asked only if it failed)
- [ ] Pushed, **not committed**; Dev Notes + context + Pinecone updated

## Design conventions (Regular Endpoints)

When designing Regular Endpoints, follow these additional conventions beyond what the reference covers:

- **Coverage check**: compare the vendor API surface and the app's visible modules against the planned endpoint list. Modules with `public === false` or `private === true` are excluded and are not coverage gaps ([endpoints-reference § Coverage Completeness](../references/endpoints-reference.md#coverage-completeness)). Flag significant gaps to the user — don't just implement what the ticket lists.
- **Connection**: only attach connections used by real modules or explicitly mentioned in the AC. Skip deprecated or unused connections.
- **Sentence case**: every endpoint `label`, including nested input and output fields, is Sentence case. Do not copy a module's Title Case ([endpoints-reference § Sentence Case Labels](../references/endpoints-reference.md#sentence-case-labels)).
- **Description**: every endpoint must have a `description` — concise sentence explaining what it does.
- **Empty-input guards**: the platform fills omitted inputs (`null` / `[]` / null-leaf collections) and JSON bodies send `null` literally, so every optional value in a JSON body is guarded regardless of HTTP method — scalars `ifempty(parameters.x, undefined)`, arrays/collections/multi-selects `stripEmpty(parameters.x)`, or the whole body via `stripEmpty(omit(parameters, ...))`. `qs` values are not guarded (the runtime drops `null`/`undefined` there). Reuse the app's existing equivalent function before adding one.
- **Hardcoded params**: always-true parameters go into `api.imljson`, not exposed as inputs. Use correct JSON types (`true` not `"true"`).
- **Map/dictionary fields**: input as `array` of `{key, value}` pairs → `toCollection()` in api block; output as `collection` with no spec.
- **`select` for enums**: use `select` (+ `multiple: true`) for known option sets; `join()` in api block when the API expects a comma-separated string.
- **Primitive array `help`**: even flat `spec: { type: "text" }` inside arrays must have `help`.
- **`mode: edit`**: has no effect on endpoint fields — do not use.
- **Markdown in help**: use `[text](url)` for links in help texts.
- **Output completeness**: [Shared rules](../references/endpoints-reference.md#shared-rules) — the vendor resource for that call, minus write-only fields, matching `response.output`.
- **API doc URLs**: prefer version-less URLs when the generic page works; keep version-specific when the exact version is relevant.
- **Standard formatting**: each property on its own line, 4-space indentation for all JSON/JSONC blocks.
- **Deprecated API check**: before implementing, verify each target API operation is not deprecated/removed in the vendor docs. Use the newer replacement if available, or flag to the user.
- **Parameter naming consistency**: all `name` fields within one endpoint follow the vendor API's casing (snake_case or camelCase). Never mix conventions.
- **Parameter-to-API wiring**: every input parameter must appear in the `api.imljson` (`url`, `qs`, `body`, or `headers`) **and must map to the correct vendor field name**. If an input parameter was renamed for disambiguation (e.g., `video_quality` to avoid collision), the `api.imljson` must still send it under the original API field name — not the renamed one.
- **Validation**: check API docs for input constraints (length, min/max, format) and apply `validate` directives.
- **Nested options**: prefer `select` + `nested` for dependent parameters when manageable; flat with clear `help` text if too complex.
- **Binary check**: build an upload only when that call passes a URL the vendor fetches, or puts the file in the JSON body as base64 `text`. Skip `buffer`, multipart, raw byte bodies, binary responses, and a create-upload-session whose file is a later byte PUT to `uploadUrl`. Do not keep the session so the ticket row survives ([endpoints-reference § Core Facts](../references/endpoints-reference.md#core-facts)).
- **`encodeURL()` restraint**: only for path params with special characters (emails, user strings). Do not apply to simple IDs.
- **Guard restraint**: no `ifempty()`/`stripEmpty()` on `qs` values or required fields; `ifempty()` never on arrays/collections.
- **No pagination**: [Shared rules](../references/endpoints-reference.md#shared-rules). No `pagination` directive. Paging controls are plain inputs. The continuation token is an output.
- **UI-only properties out**: `advanced`, `labels`, `mappable`, `mode`, `rpc://` sources and `omit` helper fields do not belong in endpoint schemas; `labels` never in outputs.
- **Empty responses**: `output_parameters: []` for 204/empty-body operations — no invented placeholder fields (`success`, `result`, `status`). A module with an empty `interface` still gets the vendor response schema when the API returns a body. Saving that `[]` uses the non-admin route while the acting user owns the app; the admin route returns HTTP 500 `42501` ([forman-schemas.md § Saving `[]`](../references/endpoints-reference/forman-schemas.md#inputoutput-schemas-forman)).
- **Types**: `uuid` for UUID ids, `any` for vendor JSON scalars / free-form bodies; consult the runtime type list and existing apps, not only the public docs.
- **Functions**: only IML built-ins and the app's existing custom functions in `api.imljson`; no JavaScript, no invented helpers.
- **Scopes**: only scopes the app already declares.
- **Dev Notes**: one cumulative note describing the final state; on rework, rewrite it rather than appending dated follow-ups.
- **URL verification**: verify all API docs URLs in `context` and `help` are reachable (not 404).
- **Acceptance verification**: cross-check the endpoint's `api.url` against the ticket acceptance criteria AND the actual module/vendor API docs. Do not pick a different API path than specified.
