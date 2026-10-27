# SDK Endpoints reference: Input/Output Schemas (Forman)

> Read when: writing or reviewing endpoint `input_parameters` / `output_parameters`: `help` text, type accuracy, array and collection specs. Part of [endpoints-reference.md](../endpoints-reference.md).

## Input/Output Schemas (Forman)

- Same parameter spec format as module `expect.imljson` (name/type/label/required/default/help/options/nested/spec). Deeply nested `select` + `nested` structures work (observed: `batchUpdateDocument` request-type picker).
- **`output_parameters` must document the full actual output.** When `response.output` is `{{body}}` passthrough, the declared schema must cover the whole API resource (IEN-16078 — createDocument was expanded from 3 fields to the full ~288 KB Document resource schema). AI callers rely on the declared schema, not the raw response.
- **Complex inputs are declared completely.** When the vendor parameter is an object or array of objects, the `spec` lists **every** documented sub-field (nested `collection`/`array` specs as deep as the vendor schema goes) — do not stop at the two or three fields the module happened to use. If the structure is genuinely open-ended (vendor "JSON" scalar, free-form `column_values`), declare it as `any` and describe the expected shape in `help` + `context.md` instead of inventing a partial spec.
- **Enums become `select`.** Every parameter the vendor documents with a closed set of values (REST enums, GraphQL `enum` types) is a `select` with those exact values as `options` (`label` humanised, `value` verbatim), `multiple: true` for list-of-enum arguments. Plain `text` for an enum is a defect, not a shortcut.
- **Empty response body → `"output_parameters": []`.** For `204`/empty-body operations (DELETE, archive, unsubscribe) the declared output is an empty array. Do not invent placeholder fields (`__IMTMESSAGE__`, `success`, `status`, `result`) that the API does not return — the result unwrap gives the caller `{}`. An empty module `interface` does not make the endpoint output empty: if the vendor returns a body, document that schema. Use `[]` only when the vendor response body itself is empty.
- **Saving `[]` (admin vs non-admin).** `PUT /api/v2/admin/sdk/apps/{slug}/{version}/endpoints/{name}/{section}` returns HTTP 500 `42501` when `input_parameters`, `output_parameters`, or `scope` is `[]`. The same body succeeds on the non-admin route `PUT /api/v2/sdk/apps/{slug}/{version}/endpoints/{name}/{section}`, and only while the caller owns the app. Do not probe alternate content types or invent a placeholder to get past the 500. For endpoint component work done through the admin API: read the current owner (`GET /api/v2/admin/sdk/apps?all=true&name={slug}&cols[]=email` → `email`). If that email is not the acting user (`GET /api/v2/users/me`), `POST /api/v2/admin/sdk/apps/{slug}/transfer` with `{ "user": <actingUserId> }` (resolve the id with `GET /api/v2/admin/users/lookup?type=email&q=`). Write every `[]` section on the non-admin route. Then transfer ownership back to the original owner the same way. Skip a `[]` write when the stored section is already `[]` — an empty `scope` usually is, right after create, so do not PUT it.
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
| Secret / password (`SipAuthPassword`, token) | `password` | `text` |
| True/false flag | `boolean` | `text` |
| Numeric value (JSON number) | `number` or `uinteger` | `text` |
| Numeric-looking string in JSON response (`"0.00000"`) | `text` | `number` |
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
- **Deprecated/removed API operations and parameters**: before implementing any endpoint, verify the target API operation's status in the vendor's **current** documentation. Do not implement endpoints for API operations that are deprecated, removed, or flagged for sunset when a newer replacement exists — implement the replacement instead, or flag the deprecation to the user before proceeding. If a module wraps a deprecated API operation and a newer one is documented, prefer the newer API operation for the endpoint even if the module hasn't been updated yet. Example: Canva's `createCommentReply` used a legacy `/comments/{id}/replies` path that returned 404 — the current API uses a different endpoint ([IEN-16698](https://make.atlassian.net/browse/IEN-16698)). Likewise, drop individual request parameters marked `[OBSOLETE]`, `Deprecated`, or `Reserved` in the vendor's OpenAPI/docs (`MaxPrice`, `ForceDelivery` in Twilio `createMessage`, [IEN-16879](https://make.atlassian.net/browse/IEN-16879)) from both `input_parameters` and `api.imljson`.
- **OpenAPI description & serialization hygiene ([IEN-16879](https://make.atlassian.net/browse/IEN-16879))**:
  - **Type, `help`, and `api.imljson` must agree on the input format**: if `api.imljson` serializes an object parameter via `toJsonString()` (`JSON.stringify`) and the input is `type: any`, remove copied vendor notes claiming the value "must be passed as a string" (which causes double-encoding) and state to pass a JSON object. Conversely, in a `type: urlencoded` request where `node:querystring` serializes nested objects as empty (`param=`), if a JSON-valued field is `type: text` without `toJsonString()`, explicitly state in `help` to pass a JSON string with an example (e.g., `{"1":"Tom"}`). Likewise, remove vendor notes telling callers to manually URL-encode characters like `#` (`SendDigits` in `createCall`) when `type: urlencoded` or `qs` already encodes the value (causing `%23` → `%2523` double-encoding), and when a vendor filter with inline operators (`<=YYYY-MM-DD`, `>=YYYY-MM-DD`) is split into separate parameters (`DateSentBefore` → `DateSent<`), strip the operator syntax from `help` so callers pass a plain date.
  - **Conditionally required parameter groups**: when the API requires one of several optional parameters (e.g., `Url`, `Twiml`, or `ApplicationSid` in `createCall`), document the rule in both the fields' `help` ([app-ux-best-practices.md § Conditionally required fields](../app-ux-best-practices.md#required-vs-optional-fields)) and `context.md` so AI callers do not omit all of them.
  - **Sibling parameter references and shared descriptions across schemas**: vendor OpenAPI prose often references sibling parameters in a different casing or stale name (e.g., `application_sid`, `status_callback`, `send_time` when the schema names are `ApplicationSid`, `StatusCallback`, `SendAt`), and reuses the same property description across request and response schemas (`From` input and `from` / `messages[].from` outputs). Normalize sibling parameter references in `help` to the exact `name` in `input_parameters.imljson`, and when fixing a dead link or stale term in a copied description, grep across all `endpoints/*/{input_parameters,output_parameters}.imljson` and `context.md`.
  - **No raw IML in `help` or `context.md`**: static text is never evaluated by IML. Replace `{{connection.*}}` / `{{ifempty(...)}}` with readable `{Placeholder}` tokens and prose.
  - **Deduplicate `select` `options` and preserve acronyms**: deduplicate `options` by `value`, and keep acronyms uppercase (`SIP`, `SID`, `URL`, `URI`, `ID`, `AMD`, `BYOC`, `MMS`, `SMS`, `OTP`, `ISO`) when converting names to Sentence case (`SipAuthUsername` → `SIP auth username`).
  - **Format hints for string-typed dates/codes**: when the vendor takes a formatted date string as `type: text` (e.g., `YYYYMMDD` on `LastVerifiedDate`), include the required format in both `help` and `context.md`.
- **Context file freshness**: whenever an endpoint is modified, disabled, or its behavior changes during development, check whether any **other** endpoint contexts reference it (e.g., "use `getCalendar` first to retrieve current values before calling `updateCalendar`") and update those references accordingly. Context files can go stale when endpoints are renamed, removed, or have their semantics changed. This applies to any cross-references between endpoints — helper endpoints, prerequisite calls, related operations mentioned in usage notes, etc.
