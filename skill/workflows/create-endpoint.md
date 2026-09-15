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
2. **Design per operation** — [Pure API Wrapper Principle](../references/endpoints-reference.md#pure-api-wrapper-principle): no output transformation, minimal input transformation, schemas mirror the vendor's.
   - `api.imljson`: method, path relative to `baseUrl`, `qs`, `body`; `{{encodeURL(parameters.x)}}` for path params with `"encodeUrl": false`; PATCH bodies via `stripEmpty(omit(parameters, …))`; `response.output` is `{{body}}` (or `{{body.items}}` for lists).
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
- [ ] Endpoint created with confirmation; context + annotations set
- [ ] Verified (fetch or execute); public toggle requested
- [ ] Context + Pinecone updated
