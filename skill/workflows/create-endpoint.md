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
5. **Create** (confirmation first): `custom-apps_endpoints-configure { mode: CREATE, endpointName: arbitraryCall, label: "Arbitrary call", description: "Performs an arbitrary authorized API call.", attachedAccounts: [conn], sections: { api, inputParameters, outputParameters, scope } }` with the template, substituting `BASE_URL` / `EXAMPLE_PATH`, scope from the source module.
6. **Context + annotations** — mandatory follow-up, CREATE does not apply them: `mode: UPDATE` with `annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: false, destructiveHint: false, arbitraryCallHint: true }` and `context` from the template (`APP_NAME`, `BASE_URL`, `EXAMPLE_PATH`, `API_DOCS_URL`).
7. **Public.** The endpoint is created `public: false`; the MCP tool cannot flip it. Ask the user to toggle visibility in the SDK admin UI (or `POST .../endpoints/{name}/public`).
8. **Verify** with `custom-apps_endpoints-fetch { endpointName, sections: [...] }`: `arbitraryCallHint: true`, `help` on every input/output parameter, `context` has YAML frontmatter + body, scope matches the source module, `attachedAccounts` set.

## Regular

1. **Context.** Which operation(s) to wrap; fetch the vendor docs for each (hard rule 1); check related modules for naming, fields, scope; sync code and read `base.imljson` (lifecycle §2).
   - **Filter the module list first.** When modules drive the endpoint list, drop every `public: false` module before designing — they are stripped from the compiled build, so they must not produce endpoints. See [endpoints-reference § Coverage Completeness](../references/endpoints-reference.md#coverage-completeness).
2. **Design per operation** — [Pure API Wrapper Principle](../references/endpoints-reference.md#pure-api-wrapper-principle): no output transformation, minimal input transformation, schemas mirror the vendor's.
   - `api.imljson`: method, path relative to `baseUrl`, `qs`, `body`; `{{encodeURL(parameters.x)}}` for path params **only when the value may contain special characters** (not for simple IDs) with `"encodeUrl": false`; PATCH bodies via `stripEmpty(omit(parameters, …))`; `response.output` is `{{body}}` (or `{{body.items}}` for lists). For multi-API-call patterns from modules, consider the `condition` directive for conditional flow or a separate helper endpoint (see reference).
   - `input_parameters.imljson`: every API parameter with the vendor's names and types; `help` **mandatory** on every field incl. nested; `select` (+ `multiple`) for enums; specific types (`email`, `date`, `url`, `number`, `boolean`); pagination/ordering params last; omit `required: false`; `validate` for min/max; array/collection spec per [reference](../references/endpoints-reference.md#array-and-collection-spec-structure).
   - `output_parameters.imljson`: the **full** resource schema, vendor field names, `help` on every field.
   - `scope.imljson`: minimal scope. `context.md`: YAML frontmatter (`name`, `description`) + usage notes / limitations / PATCH semantics. Annotations accurate; `arbitraryCallHint` false or absent.
3. **Create and push** via MCP `custom-apps_endpoints-configure` or `update-app.js endpoint/{name}/{section}` (confirmation first).
4. **Verify** via MCP `endpoint_execute` or the platform "Run Endpoint" button.
5. **Close out** (lifecycle §7): ask about public toggle, context file, Pinecone.

## Updating an existing endpoint

Same tools and principles. Skip CREATE; fetch the current sections first so you do not overwrite other changes; push sections individually with `mode: UPDATE` or `update-app.js endpoint/{name}/{section}` (context and annotations update independently).

## Checklist

- [ ] Type detected; source module / vendor docs read
- [ ] Connection identified (only connections used by real modules or mentioned in AC)
- [ ] `public: false` modules excluded from the module list
- [ ] Coverage verified (endpoints cover app functionality; gaps flagged)
- [ ] Deprecated API operations checked; newer replacements used where available
- [ ] Binary upload/download checked; skipped or URL variant used
- [ ] Endpoint created with confirmation; context + annotations set
- [ ] All labels in Sentence case; descriptions present; parameter naming consistent
- [ ] All input parameters wired in `api.imljson` to correct vendor field names; validation directives applied
- [ ] API docs URLs verified reachable (not 404)
- [ ] Context files of other endpoints cross-referencing this one are up to date
- [ ] Verified (fetch or execute); public toggle requested
- [ ] Context + Pinecone updated

## Design conventions (Regular Endpoints)

When designing Regular Endpoints, follow these additional conventions beyond what the reference covers:

- **Coverage check**: compare the vendor API surface and the app's **visible** modules against the planned endpoint list — `public: false` modules are excluded and are not coverage gaps ([endpoints-reference § Coverage Completeness](../references/endpoints-reference.md#coverage-completeness)). Flag significant gaps to the user — don't just implement what the ticket lists.
- **Connection**: only attach connections used by real modules or explicitly mentioned in the AC. Skip deprecated or unused connections.
- **Sentence case**: all `label` values (endpoint and parameter) follow Sentence case per [UX best practices](https://make.atlassian.net/wiki/x/DAfcyg).
- **Description**: every endpoint must have a `description` — concise sentence explaining what it does.
- **Write-endpoint guards**: POST/PUT/PATCH bodies → `stripEmpty(omit(parameters, ...))` for complex nested bodies; `ifempty()` for flat QS params. QS params on write endpoints also need guards.
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
- **Binary check**: always verify whether an operation involves binary upload or binary response. Skip if binary-only; implement URL-based upload variant if available.
- **`encodeURL()` restraint**: only for path params with special characters (emails, user strings). Do not apply to simple IDs.
- **`ifempty()` restraint**: only on POST/PUT/PATCH — never on GET/DELETE query parameters.
- **URL verification**: verify all API docs URLs in `context` and `help` are reachable (not 404).
- **Acceptance verification**: cross-check the endpoint's `api.url` against the ticket acceptance criteria AND the actual module/vendor API docs. Do not pick a different API path than specified.
