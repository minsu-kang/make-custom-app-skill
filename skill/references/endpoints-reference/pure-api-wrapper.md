# SDK Endpoints reference: Pure API Wrapper Principle

> Read when: designing or reviewing a Regular endpoint: which transformations are allowed, empty-input guards, always-true parameters. Part of [endpoints-reference.md](../endpoints-reference.md).

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
- **`toCollection()`** — for map/dictionary fields where the API expects a flat `{key: value}` object: define the input as an `array` of `{key, value}` pairs, then transform with `"{{toCollection(parameters.field, 'key', 'value')}}"` in the `api.imljson` body/qs. In output, represent these as `collection` with no spec (open/dynamic keys). Because `ExecuteRpc` / `ExecuteEndpoint` workers run IML with `passthrough: false`, an entry where `value` is omitted evaluates to `null` (`{"Col": null}`), which clears the field on APIs that treat `null` (or `""`) as a clear signal (e.g., SharePoint `fieldValueSet`, [IEN-17149](https://make.atlassian.net/browse/IEN-17149)). Do **not** mark `value` as `required: true` when `null` or `""` is a valid clear value — `@makehq/forman-schema` rejects `value == null || value === ""` on required fields, blocking intentional clears — and do not replace `toCollection` with a custom validator. Instead, document in `help` and `context.md` that every entry must include `value` and that sending `null` or `""` (or omitting `value`) clears the field; never write `"An empty string is kept"` unless verified against the vendor API.
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
