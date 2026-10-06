<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->

# Create Endpoint Workflow

> Read [lifecycle.md](lifecycle.md) first. Creates or updates SDK Endpoints — **Arbitrary Call** (passthrough) or **Regular** (typed, single operation). Entity, templates, and review guidance: [endpoints-reference.md](../references/endpoints-reference.md).

## Type detection

| Ticket says | Type |
|---|---|
| "Arbitrary call", "Make an API Call" module, `arbitraryCall` | Arbitrary Call — use the § Standard Template in endpoints-reference.md |
| A specific API operation ("List messages", "Create event") | Regular — design per operation |

## Arbitrary Call

1. **Source module.** `custom-apps_modules-fetch { appName, appVersion, moduleName: makeAnApiCall|makeApiCall, sections: ["api","expect","scope"] }`. Extract base URL from `api.url` (e.g. `https://gmail.googleapis.com/gmail/{{parameters.url}}` → `https://gmail.googleapis.com/gmail/`), the connection (`attachedAccounts` / `connection`), `scope`, and any non-standard api directives.
2. **Base config.** `custom-apps_fetch { sections: ["base"] }` — auth injected in `base.imljson` via `qs` or `headers` merges automatically; do not duplicate it in the endpoint.
3. **Existing endpoints.** `custom-apps_endpoints-fetch` — if `arbitraryCall` exists, tell the user and stop.
4. **Example path** for help text and context: a parameter-free GET (`/v1/models`, `/v1/users/me/messages`); otherwise the most common path with a placeholder, taken from the API docs (`customfield_10283`).
5. **Create** (confirmation first): `custom-apps_endpoints-configure { mode: CREATE, endpointName: arbitraryCall, label: "Arbitrary call", description: "Performs an arbitrary authorized API call.", attachedAccounts: [conn], sections: { api, inputParameters, outputParameters, scope } }` with the template, substituting `BASE_URL` / `EXAMPLE_PATH`, scope from the source module — or equivalently `create-component.js {slug} {ver} endpoint arbitraryCall "Arbitrary call" {connection} "Performs an arbitrary authorized API call." blank` followed by `update-app.js … endpoint/arbitraryCall/{section}` for the four sections. Keep the template's `"type": "text"` as is — an object body from an AI caller becomes `[object Object]` on the wire, but that is a runtime limitation with a runtime fix pending; do not change the request `type` or add app-level workarounds ([reference § Standard Template → Body serialization](../references/endpoints-reference.md#standard-template)).
6. **Context + annotations** — mandatory follow-up, CREATE does not apply them: `mode: UPDATE` with `annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: false, destructiveHint: false, arbitraryCallHint: true }` and `context` from the template (`APP_NAME`, `BASE_URL`, `EXAMPLE_PATH`, `API_DOCS_URL`).
7. **Public.** The endpoint is created `public: false`; the MCP tool cannot flip it. Toggle it yourself: `node ${SKILL_ROOT}/scripts/update-component.js {slug} {ver} endpoint arbitraryCall public=true` (write script → confirmation first). Only if that call fails, ask the user to toggle visibility in the SDK admin UI.
8. **Verify** with `custom-apps_endpoints-fetch { endpointName, sections: [...] }`: `arbitraryCallHint: true`, `help` on every input/output parameter, `context` has YAML frontmatter + body, scope matches the source module, `attachedAccounts` set. Then run `test-component.js {slug} {ver} endpoint arbitraryCall` (add mockup `test.js` when missing).

## Regular

1. **Context.** Which operation(s) to wrap; fetch the vendor docs for each (hard rule 1); check related modules for naming, fields, scope; sync code and read `base.imljson` (lifecycle §2). List the app's existing custom functions (`ls ${CONTEXTS_DIR}/{slug}-v{ver}/functions/`) — you may call only those and the IML built-ins.
   - **Filter the module list first.** When modules drive the endpoint list, drop every `public: false` module before designing — they are stripped from the compiled build, so they must not produce endpoints — **even when the ticket AC names them**; report those as "excluded, confirm?" in the plan. Drop modules that call a foreign API too. See [endpoints-reference § Coverage Completeness](../references/endpoints-reference.md#coverage-completeness).
   - **One endpoint per vendor operation.** A module that calls vendor endpoint A or B depending on an input becomes two SDK endpoints — never one endpoint whose input decides which API endpoint to call (IEN-16616).
2. **Design per operation** — [Pure API Wrapper Principle](../references/endpoints-reference.md#pure-api-wrapper-principle): no output transformation, minimal input transformation, schemas mirror the vendor's.
   - `api.imljson`: method, path relative to `baseUrl`, `qs`, `body`; no `type` key (objects serialize as JSON by default; `arbitraryCall` is the exception); `{{encodeURL(parameters.x)}}` for path params **only when the value may contain special characters** (not for simple IDs) with `"encodeUrl": false`; `response.output` is `{{body}}` (or `{{body.items}}` for lists). No `pagination` — paging controls are plain inputs and the vendor's cursor/token is an output. **Guards on every optional JSON-body value, any method** (GraphQL reads are POSTs too): scalars `{{ifempty(parameters.x, undefined)}}`, arrays / collections / multi-selects `{{stripEmpty(parameters.x)}}` (reuse the app's existing equivalent — `stripEmpty`, `removeEmpty` — or add the function first); `qs` values need no guard ([reference § Empty-input guards](../references/endpoints-reference.md#empty-input-guards--ifempty-vs-stripempty-verified-against-the-runtime-source)). GraphQL APIs: static operation document with typed `$variables`, variables mapped 1:1, selection set = full resource ([reference § GraphQL APIs](../references/endpoints-reference.md#graphql-apis-monday-v2-github-v4-shopify-linear)). When a module does an extra pre-check call, use a separate helper endpoint (see reference).
   - `input_parameters.imljson`: every API parameter with the vendor's names and types; `help` **mandatory** on every field incl. nested; `select` (+ `multiple`) for **every** enum; specific types (`email`, `date`, `url`, `uuid`, `number`, `boolean`, `any` for vendor JSON scalars); complex objects declared **completely** (all documented sub-fields); pagination/ordering params last; omit `required: false`; no UI-only properties (`advanced`, `labels`, `mappable`, `mode`, `rpc://`, `omit` fields); vendor keys with special characters (`$search`) get a plain `name` and are mapped in `api`; `validate` for min/max; array/collection spec per [reference](../references/endpoints-reference.md#array-and-collection-spec-structure).
   - `output_parameters.imljson`: the **full** resource schema, vendor field names, `help` on every field, never `labels`; empty-body responses → `[]` (no placeholder fields).
   - `scope.imljson`: minimal scope, chosen only from scopes the app's modules/connection already declare — never a new one from the vendor docs. `context.md`: YAML frontmatter (`name`, `description`) on **every** endpoint + usage notes / limitations / PATCH semantics. Annotations accurate; `arbitraryCallHint` false or absent.
   - **Module parity (module-derived sets).** Before pushing, diff each module's `expect` names and response fields against the endpoint's inputs/outputs with a script, not by eye — expected deltas are UI-only switches and module-side transformations only ([reference § Scripted module-parity check](../references/endpoints-reference.md#scripted-module-parity-check-module-derived-apps)).
3. **Create and push** with the skill scripts (confirmation first): `create-component.js {slug} {ver} endpoint {name} "{label}" {connection} "{description}"`, then `update-app.js {slug} {ver} endpoint/{name}/{api|input_parameters|output_parameters|scope|context}` from the local files. MCP `custom-apps_endpoints-configure` is an equivalent alternative; it is **required** only for `annotations`, which no script writes yet (`mode: UPDATE, annotations: {…}`). New custom functions go first (`create-component.js … function {name}` + `update-app.js … function/{name}/code|test`).4. **Public.** `node ${SKILL_ROOT}/scripts/update-component.js {slug} {ver} endpoint {name} public=true` for each new endpoint (confirmation first; a single confirmation for the batch is fine). Ask the user to toggle in the UI only if the call fails.
5. **Tests.** New or changed `api.imljson` → add `data/{slug}/v{version}/endpoints/{name}/test.js` in the mockup repo when missing, then `test-component.js {slug} {ver} endpoint {name}` ([component-test-guide.md](../references/component-test-guide.md)). Expected output is the unwrapped object, not an RPC-style array. Live smoke still available via MCP `endpoint_execute` or the platform "Run Endpoint" button.
6. **Close out** (lifecycle §7): Developer Notes, context file, Pinecone. **Do not run `commit-changes.js commit`** — development ends at the push; the reviewer/committer commits. Commit only on an explicit user instruction.

## Updating an existing endpoint

Same tools and principles. Skip CREATE; fetch the current sections first so you do not overwrite other changes; push sections individually with `mode: UPDATE` or `update-app.js endpoint/{name}/{section}` (context and annotations update independently).

## Checklist

- [ ] Type detected; source module / vendor docs read (GraphQL: schema/introspection, not prose, for argument types)
- [ ] Connection identified (only connections used by real modules or mentioned in AC)
- [ ] `public: false` and foreign-API modules excluded from the module list — also when the AC lists them (flagged, not built)
- [ ] Coverage verified (endpoints cover app functionality; gaps flagged); one endpoint per vendor operation, no input-driven path switching
- [ ] Deprecated API operations checked; newer replacements used where available
- [ ] Binary upload/download checked; skipped, URL variant, or base64-in-JSON variant used
- [ ] Every IML function called in `api.imljson` exists (built-in or this app's `functions/`); new helper functions pushed first
- [ ] Optional JSON-body values guarded: scalars `ifempty`, arrays/collections/multi-selects `stripEmpty` (or app equivalent); no guards on `qs`; no `type: json` outside `arbitraryCall`
- [ ] Endpoint created with confirmation; context (with frontmatter) + annotations set on every endpoint
- [ ] All labels in Sentence case; descriptions present; parameter naming consistent; special-character vendor keys mapped from plain names
- [ ] Inputs: enums are `select`; complex objects fully declared; no UI-only props (`advanced`, `labels`, `mappable`, `mode`, `rpc://`, `omit` helpers)
- [ ] Outputs: full resource; no `labels`; empty-body responses `[]`
- [ ] Scope drawn only from scopes the app already declares
- [ ] All input parameters wired in `api.imljson` to correct vendor field names; validation directives applied
- [ ] Module parity diffed by script (module-derived sets)
- [ ] API docs URLs verified reachable (not 404)
- [ ] Context files of other endpoints cross-referencing this one are up to date
- [ ] `test-component.js` run (or skipped with a note if mockup path missing)
- [ ] Public toggled via `update-component.js … public=true` (user asked only if it failed)
- [ ] Pushed, **not committed**; Dev Notes + context + Pinecone updated

## Design conventions (Regular Endpoints)

When designing Regular Endpoints, follow these additional conventions beyond what the reference covers:

- **Coverage check**: compare the vendor API surface and the app's **visible** modules against the planned endpoint list — `public: false` modules are excluded and are not coverage gaps ([endpoints-reference § Coverage Completeness](../references/endpoints-reference.md#coverage-completeness)). Flag significant gaps to the user — don't just implement what the ticket lists.
- **Connection**: only attach connections used by real modules or explicitly mentioned in the AC. Skip deprecated or unused connections.
- **Sentence case**: all `label` values (endpoint and parameter) follow Sentence case per [UX best practices](https://make.atlassian.net/wiki/x/DAfcyg).
- **Description**: every endpoint must have a `description` — concise sentence explaining what it does.
- **Empty-input guards**: the platform fills omitted inputs (`null` / `[]` / null-leaf collections) and JSON bodies send `null` literally, so every optional value in a JSON body is guarded regardless of HTTP method — scalars `ifempty(parameters.x, undefined)`, arrays/collections/multi-selects `stripEmpty(parameters.x)`, or the whole body via `stripEmpty(omit(parameters, ...))`. `qs` values are not guarded (the runtime drops `null`/`undefined` there). Reuse the app's existing equivalent function before adding one.
- **Hardcoded params**: always-true parameters go into `api.imljson`, not exposed as inputs. Use correct JSON types (`true` not `"true"`).
- **Map/dictionary fields**: input as `array` of `{key, value}` pairs → `toCollection()` in api block; output as `collection` with no spec.
- **`select` for enums**: use `select` (+ `multiple: true`) for known option sets; `join()` in api block when the API expects a comma-separated string.
- **Primitive array `help`**: even flat `spec: { type: "text" }` inside arrays must have `help`.
- **`mode: edit`**: has no effect on endpoint fields — do not use.
- **Markdown in help**: use `[text](url)` for links in help texts.
- **Output completeness**: all fields from API docs exhaustively; exclude write-only fields.
- **API doc URLs**: prefer version-less URLs when the generic page works; keep version-specific when the exact version is relevant.
- **Standard formatting**: each property on its own line, 4-space indentation for all JSON/JSONC blocks.
- **Deprecated API check**: before implementing, verify each target API operation is not deprecated/removed in the vendor docs. Use the newer replacement if available, or flag to the user.
- **Parameter naming consistency**: all `name` fields within one endpoint follow the vendor API's casing (snake_case or camelCase). Never mix conventions.
- **Parameter-to-API wiring**: every input parameter must appear in the `api.imljson` (`url`, `qs`, `body`, or `headers`) **and must map to the correct vendor field name**. If an input parameter was renamed for disambiguation (e.g., `video_quality` to avoid collision), the `api.imljson` must still send it under the original API field name — not the renamed one.
- **Validation**: check API docs for input constraints (length, min/max, format) and apply `validate` directives.
- **Nested options**: prefer `select` + `nested` for dependent parameters when manageable; flat with clear `help` text if too complex.
- **Binary check**: always verify whether an operation involves binary upload or binary response. Skip if binary-only; implement the URL-based or base64-in-JSON upload variant if the vendor offers one.
- **`encodeURL()` restraint**: only for path params with special characters (emails, user strings). Do not apply to simple IDs.
- **Guard restraint**: no `ifempty()`/`stripEmpty()` on `qs` values or required fields; `ifempty()` never on arrays/collections.
- **No pagination**: paging inputs (`page`, `limit`, `cursor`, `pageToken`…) are plain inputs; the continuation token is an output; a vendor continuation operation is its own endpoint.
- **UI-only properties out**: `advanced`, `labels`, `mappable`, `mode`, `rpc://` sources and `omit` helper fields do not belong in endpoint schemas; `labels` never in outputs.
- **Empty responses**: `output_parameters: []` for 204/empty-body operations — no invented placeholder fields.
- **Types**: `uuid` for UUID ids, `any` for vendor JSON scalars / free-form bodies; consult the runtime type list and existing apps, not only the public docs.
- **Functions**: only IML built-ins and the app's existing custom functions in `api.imljson`; no JavaScript, no invented helpers.
- **Scopes**: only scopes the app already declares.
- **Dev Notes**: one cumulative note describing the final state; on rework, rewrite it rather than appending dated follow-ups.
- **URL verification**: verify all API docs URLs in `context` and `help` are reachable (not 404).
- **Acceptance verification**: cross-check the endpoint's `api.url` against the ticket acceptance criteria AND the actual module/vendor API docs. Do not pick a different API path than specified.
