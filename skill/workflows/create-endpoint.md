<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# Create Endpoint Workflow

Workflow for creating SDK Endpoints in a Make app — both **Arbitrary Call** (passthrough) and **Regular** (typed, single-operation) endpoints.

## Trigger

Execute this workflow if any of the following conditions are met:

- User asks to create an Arbitrary Call endpoint for a Make app
- User asks to create a new SDK Endpoint (any type)
- Jira ticket describes adding an endpoint to an app (e.g., IEN-15910 family)

## Endpoint Type Detection

| Indicator | Type | Template |
|---|---|---|
| Ticket mentions "Arbitrary call", "Make an API Call" module, or `arbitraryCall` | **Arbitrary Call** | See [endpoints-reference.md § Arbitrary Call Endpoint](../references/endpoints-reference.md#arbitrary-call-endpoint) |
| Ticket describes a specific API operation (e.g., "List messages", "Create event") | **Regular** | Design per-operation following [endpoints-reference.md](../references/endpoints-reference.md) general guidance |

---

## Arbitrary Call Endpoint

### Steps

**1. Gather Context**: Identify the app and source module.

- **Jira ticket**: Fetch ticket via Atlassian MCP — extract app slug, version, and source module name (usually `makeAnApiCall` or `makeApiCall`)
- **App HQ URL**: If only a Jira link is provided, extract slug + version from `customfield_10268`
- **API docs URL**: Note the `customfield_10283` (API docs link) for the context field

**2. Fetch Source Module**: Read the existing _Make an API Call_ module.

```
MCP: custom-apps_modules-fetch
  appName: {slug}
  appVersion: {version}
  moduleName: {source-module-name}
  sections: ["api", "expect", "scope"]
```

Extract from the response:
- **Base URL** — from `api.url` (e.g., `"https://gmail.googleapis.com/gmail/{{parameters.url}}"` → `https://gmail.googleapis.com/gmail/`)
- **Connection** — from `attachedAccounts` or `connection`
- **Scope** — from `scope` section (may be `[]`)
- **Extra api logic** — any non-standard directives (custom error handling, additional qs/headers, type overrides)

**3. Fetch App Base Config**: Check for inherited auth.

```
MCP: custom-apps_fetch
  appName: {slug}
  appVersion: {version}
  sections: ["base"]
```

Review `base.imljson` for:
- Auth injected via `qs` (e.g., Gemini's `"key": "{{connection.key}}"`)
- Auth injected via `headers` (e.g., `"x-goog-api-key"`)
- These merge automatically — do **not** duplicate in the endpoint, but note in context if relevant

**4. Check for Existing Endpoints**: Verify no `arbitraryCall` already exists.

```
MCP: custom-apps_endpoints-fetch
  appName: {slug}
  appVersion: {version}
```

If `arbitraryCall` already exists, inform the user and stop.

**5. Choose URL Example**: Pick a simple GET path for the help text and context.

- Prefer parameter-free paths (e.g., `/v1/models`, `/v1/users/me/calendarList`, `/v1/users/me/messages`)
- If the API has no simple GET, use the most common path with a placeholder (e.g., `/v1/presentations/{presentationId}`)
- Reference the API docs to find the simplest available endpoint

**6. Create the Endpoint**: Use the standardized template.

```
MCP: custom-apps_endpoints-configure
  mode: CREATE
  appName: {slug}
  appVersion: {version}
  endpointName: arbitraryCall
  label: Arbitrary call
  description: Performs an arbitrary authorized API call.
  attachedAccounts: [{connection-name}]
  sections:
    api: <from template, substituting BASE_URL>
    inputParameters: <from template, substituting BASE_URL and EXAMPLE_PATH in help>
    outputParameters: <standard template>
    scope: <from source module's scope.imljson>
```

Use the full templates from [endpoints-reference.md § Arbitrary Call Endpoint — Standard Template](../references/endpoints-reference.md#standard-template).

**⚠️ Important**: The `CREATE` call does **not** apply `context` or `annotations`. Always proceed to step 7.

**7. Set Context and Annotations**: Mandatory follow-up UPDATE.

```
MCP: custom-apps_endpoints-configure
  mode: UPDATE
  appName: {slug}
  appVersion: {version}
  endpointName: arbitraryCall
  annotations:
    readOnlyHint: false
    openWorldHint: false
    idempotentHint: false
    destructiveHint: false
    arbitraryCallHint: true
  context: <from template, substituting APP_NAME, BASE_URL, EXAMPLE_PATH, API_DOCS_URL>
```

**8. Toggle Public**: Remind the user to toggle the endpoint visible.

> The endpoint has been created with `public: false`. Please toggle it visible in the SDK admin UI, or confirm and I'll proceed.

Note: The MCP `custom-apps_endpoints-configure` tool does not support the `public` flag directly. Visibility must be toggled via the admin UI or `POST .../endpoints/{name}/public`.

**9. Verify**: Fetch the created endpoint to confirm all sections are set correctly.

```
MCP: custom-apps_endpoints-fetch
  appName: {slug}
  appVersion: {version}
  endpointName: arbitraryCall
  sections: ["api", "inputParameters", "outputParameters", "scope"]
```

Check:
- `arbitraryCallHint: true` in annotations
- `help` present on all input/output parameters
- `context` contains YAML frontmatter + descriptive body
- `scope` matches source module
- `attachedAccounts` is set

---

## Regular Endpoint

### Steps

**1. Gather Context**: Same as Arbitrary Call step 1, plus:

- Identify which API operation(s) to wrap
- Fetch the third-party API documentation for each operation
- Check if related modules already exist in the app (for patterns, field naming, scope)

**2. App Detection & Code Download**: Ensure code is available.

- Download/sync app code via `download-app.js`
- Load context file `{slug}-v{version}.md` if it exists
- Read `base.imljson` for baseUrl, auth, error handling patterns

**3. Design the Endpoint**: For each API operation, follow the [Pure API Wrapper Principle](../references/endpoints-reference.md#pure-api-wrapper-principle) — no output transformations, minimal input transformations, schemas as close to the third-party API description as possible.

- **API block** (`api.imljson`): Map the HTTP method, URL path (relative to `baseUrl`), query params, request body
  - Use `{{encodeURL(parameters.field)}}` for path parameters, with `"encodeUrl": false` on the api block
  - For PATCH endpoints: consider using `stripEmpty(omit(parameters, ...))` pattern to avoid sending empty objects
  - `response.output` should be `{{body}}` (or `{{body.items}}` for list endpoints) — no IML transformations on the output
- **Input parameters** (`input_parameters.imljson`): Map all API parameters — names and types should match the third-party API docs
  - `help` is **mandatory** on every parameter including nested fields (see [Mandatory help Text](../references/endpoints-reference.md#mandatory-help-text))
  - Use `select` for enum-type fields (fixed set of values), with `multiple: true` where applicable
  - Use the most specific types: `email`, `date`, `url`, `number`, `boolean` — not just `text` (see [Parameter Type Accuracy](../references/endpoints-reference.md#parameter-type-accuracy))
  - Place pagination/ordering parameters at the end for list endpoints
  - Do not include `required: false` (optional is the default)
  - Add `validate` directives where min/max constraints exist
  - Use correct array/collection spec structure (see [Array and Collection Spec Structure](../references/endpoints-reference.md#array-and-collection-spec-structure))
- **Output parameters** (`output_parameters.imljson`): Map the **full** API resource schema — AI callers rely on the declared schema
  - `help` is **mandatory** on every output parameter including nested fields
  - Use appropriate types for output fields too (`email`, `date`, `url`)
  - Do not omit fields or rename them — document what the API actually returns
- **Scope** (`scope.imljson`): Use the minimal OAuth scope required for the operation
- **Context** (`context.md`): YAML frontmatter (`name`, `description`) + usage notes, limitations, PATCH semantics hints for update endpoints
- **Annotations**: Set `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` accurately. `arbitraryCallHint` must be `false` (or absent) for regular endpoints

**4. Create & Upload**: Use MCP or `update-app.js` to create and configure endpoints.

**5. Verify**: Test each endpoint via MCP `endpoint_execute` or the platform "Run Endpoint" button.

**6. Post-Creation**: Toggle public, update context file, sync to Pinecone if applicable.

---

## Updating Existing Endpoints

The same tools and principles apply when updating an existing endpoint (e.g., adding missing fields, fixing schemas, updating context after a code review). The key differences:

- **Skip the CREATE step** — use `custom-apps_endpoints-configure` with `mode: UPDATE` or `update-app.js` with `endpoint/<name>/<section>` to push individual section changes.
- **Context and annotations** can be updated independently via `mode: UPDATE` (MCP) or `update-app.js endpoint/<name>/context`.
- **Always re-read the current state** before editing — fetch the endpoint's sections first to avoid overwriting other changes.
- **All design principles still apply**: pure API wrapper, mandatory `help`, parameter type accuracy, array/collection spec structure, etc.
