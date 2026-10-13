# SDK Endpoints reference: Code Review Guidance for Endpoint Changes

> Read when: reviewing any endpoint change. Part of [endpoints-reference.md](../endpoints-reference.md).

## Code Review Guidance for Endpoint Changes

- Changes surface as `endpoint/{name}/{code}` with codes `api`, `input_parameters`, `output_parameters`, `context` (and potentially `scope`).
- **Component tests.** When `api` is changed, run `test-component.js {slug} {ver} endpoint {name}` after `download-app.js` (same auto-run as modules/RPCs — [component-test-guide.md](../component-test-guide.md)). Missing `test.js` is a note, not a Bug.
- **Breaking Changes: skip.** Endpoints cannot run in scenarios, so no existing scenario mappings can break. State the skip reason as usual. (A shared custom IML function edited for an endpoint CAN still break modules that reuse it — evaluate that under the function change, e.g. IEN-16083 `getDocumentResponse`.)
- The Runtime Reference hard gate applies to endpoint `api` changes the same as module/RPC `api` changes.
- **Pure API wrapper check**: verify the endpoint does not apply output transformations or unnecessary input transformations (see [pure-api-wrapper.md](pure-api-wrapper.md)). Structural cleanups like `stripEmpty()` and `omit()` are acceptable; data transformations are not.
- Verify `output_parameters` ↔ `response.output` shape consistency (IEN-16078 class).
- **Mandatory `help` check**: every input and output parameter — including nested fields inside collections and array specs — must have a `help` text. Missing `help` is a review Bug.
- Verify `context.md` accuracy against actual behavior — it is AI-caller documentation.
- Check `annotations` on new endpoints:
  - Read-only/destructive/idempotent hints should accurately reflect the API operation.
  - `arbitraryCallHint: true` is **mandatory** on every `arbitraryCall` endpoint — missing is a review Bug.
  - All non-`arbitraryCall` endpoints should have `arbitraryCallHint: false` (or absent).
- `scope` matches the API call's minimal OAuth scope **and** is drawn from scopes the app's modules/connection already declare ([endpoints-reference.md § Scope rule](../endpoints-reference.md#scope-rule--only-scopes-the-app-already-declares)). A scope that no module requests is a Bug: the token will not carry it.
- **Functions exist**: every `{{fn(...)}}` in `api.imljson` is a built-in or an existing custom function of this app (`functions/`). A call to a function that does not exist is a Bug (runtime failure).
- **One vendor operation per endpoint**: an endpoint whose input decides which vendor API endpoint is called (to cover more API calls in one) is a Bug (IEN-16616) — the fix is two endpoints.
- **Parameter type accuracy**: check that `email`, `date`, `url`, `select` types are used where appropriate instead of generic `text` (see [forman-schemas.md § Parameter Type Accuracy](forman-schemas.md#parameter-type-accuracy)). Vendor enums declared as `text` instead of `select` are a finding.
- **UI-only properties**: `advanced`, `labels`, `mappable`, `mode`, `rpc://` sources, `omit` fields in `input_parameters`, and `labels` anywhere in `output_parameters` are findings ([forman-schemas.md § UI-only properties](forman-schemas.md#ui-only-properties--leave-them-out)). Placeholder output fields for empty-body responses (`__IMTMESSAGE__`) are findings — expected `output_parameters: []`.
- **Complete complex inputs**: nested object inputs must declare every documented sub-field, or be `any` with the shape described in `help`/`context` — a half-declared `collection` spec is a finding.
- **Sentence case labels**: verify all endpoint labels and parameter labels follow Sentence case (see [endpoints-reference.md § Sentence Case Labels](../endpoints-reference.md#sentence-case-labels)).
- **Endpoint descriptions**: every endpoint must have a `description` — same UX requirements as modules.
- **Connection attachment**: only relevant connections should be attached — not deprecated or unused ones (see [endpoints-reference.md § Connection Attachment](../endpoints-reference.md#connection-attachment)).
- **Coverage completeness**: compare the app's module list and the third-party API surface against the implemented endpoints. Flag significant gaps. Exclude `public: false` modules from that comparison ([endpoints-reference.md § Coverage Completeness](../endpoints-reference.md#coverage-completeness)) — a missing endpoint for one is not a gap; an endpoint that exists only because a `public: false` module exposed the operation is a scope question for the user, not a Bug. A module that calls a different product's API is not a gap either ([endpoints-reference.md § Foreign API calls](../endpoints-reference.md#foreign-api-calls), IEN-16686): do not add that endpoint here, and do not add that API's scope. Missing it is not a review finding once the ticket marks it out of scope.
- **Primitive array `help`**: check that even primitive array specs (e.g., `spec: { type: "text" }`) have `help` text.
- **Hardcoded value types**: verify hardcoded values use correct JSON types (`true` not `"true"`, `1` not `"1"`).
- **Empty-input guards**: every optional input that lands in a **JSON body** (any method — GraphQL reads included) is guarded: scalars → `ifempty(…, undefined)`, arrays / collections / multi-selects → `stripEmpty()` (or the app's equivalent). `ifempty()` on an array or collection is a Bug (it passes `[]` and null-leaf objects through). Guards on `qs` values are unnecessary (the runtime drops `null`/`undefined` there) — a note, not a Bug. See [pure-api-wrapper.md § Empty-input guards](pure-api-wrapper.md#empty-input-guards--ifempty-vs-stripempty-verified-against-the-runtime-source).
- **`stripEmpty()` drops only empty values**: open the app's stripper (`functions/stripEmpty/code.js` or equivalent) and check it cannot discard a filled-in value — the known case is `Date` (no `[object Date]` short-circuit before the object branch). If such a value can reach it from an endpoint's inputs (top-level or nested in a wrapped body) → Bug (silent data loss). See [pure-api-wrapper.md § `stripEmpty()` must never drop a filled-in value](pure-api-wrapper.md#stripempty-must-never-drop-a-filled-in-value).
- **`encodeURL()` usage**: verify `encodeURL()` is only used on path parameters that may contain special characters. Simple alphanumeric IDs do not need encoding.
- **URL verification**: API docs URLs in `context` and `help` text must be reachable (not 404). Verify before finalizing.
- **Endpoint URL correctness**: verify the endpoint's `api.url` matches the correct API path — cross-check against both the ticket acceptance criteria and the actual module implementation / vendor API docs.
- **Deprecated API operations**: verify the target API operation is not deprecated or removed in the vendor's current docs. If it is, a newer replacement should be used instead.
- **Parameter naming consistency**: all parameter `name` fields within one endpoint should follow the same casing convention (matching the vendor API), with no mixing of `snake_case` and `camelCase`.
- **Parameter-to-API wiring**: every input parameter must be properly mapped in `api.imljson` — check that no parameter is defined in the input schema but missing from the `url`, `qs`, `body`, or `headers` in the API block. Also verify the mapping uses the **correct vendor field name** — if a parameter was renamed for disambiguation, the `api.imljson` must still send it under the original API field name, not the renamed one.
- **Context file freshness**: when an endpoint is modified or disabled, verify that other endpoint contexts referencing it are updated (e.g., cross-references to helper endpoints, prerequisite calls, related operations).
