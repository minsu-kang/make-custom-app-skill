# Parameters & Interface Reference

## Parameters Structure

Both Expect (mappable params) and Parameters (static params) use the same syntax.

**Expect (mappable) limitations**:
- IML expressions (`{{...}}`) do NOT work inside `expect.imljson`
- `condition` is NOT supported in expect specs
- `editable` is deprecated in expect — use only in connection `parameters.imljson`

```json
[
	{
		"name": "fieldName",
		"type": "text",
		"label": "Field Label",
		"help": "Description text",
		"required": true,
		"default": "defaultValue",
		"advanced": false,
		"multiline": false
	}
]
```

### Common Spec Properties (all types)

Beyond `name` / `type` / `label` / `help` / `required` / `default`, every parameter spec accepts the properties below. They are rendered by the Make parameter form renderer (imt-forman). Each is verified against real custom apps unless marked otherwise.

| Property | Type | Notes |
|---|---|---|
| `advanced` | boolean | Hidden until the form's "Show advanced settings" toggle is on. Use for rarely-needed options. |
| `placeholder` | string | Empty-state hint text (text-like inputs and `select`). |
| `mappable` | boolean \| object | `false` locks the field to pick mode (removes the map/pick toggle). Object form `{ "enabled": true, "help": "..." }` supplies map-mode-specific help — see [`mappable` Override](#mappable-override-map-toggle-mode). |
| `mode` | string | Initial editor mode: `"pick"` (UI) or `"map"` (IML coder). `select` additionally accepts `"edit"` (editable/typeahead select). |
| `omit` | boolean | Field is rendered and editable but its value is **excluded** from the submitted parameters. Use for UI-only helper fields. |
| `disabled` | boolean | Not editable; value **not** submitted. |
| `readonly` | boolean | Not editable; value **still** submitted. |
| `validate` | object \| false | Type-specific validation rules; `false` disables format checks (but `required` is still enforced). See [Validation](#validation). |
| `dynamic` | boolean | Marks an RPC-backed field as dynamic → the form renders a refresh button to re-fetch its options/nested fieldset. |
| `semantic` | string | Affinity hint for variable (pill) suggestions. `file:name` / `file:data` mark a file-upload field pair (filename + buffer). |

> imt-forman exposes additional web-renderer-only properties (`visible`, `isolated`, `erasable`, `coderPlaceholder`, `autofocus`, `autocomplete`, `shadow`, `innerLabel`, …) that are **not** part of the typical custom-app parameter contract. Do not add them unless you confirm them in an actual app.

### `mappable` Override (Map Toggle Mode)

Any expect parameter can define a `mappable` object whose properties override the parameter's base spec **only when the user flips the Map toggle ON** (mapping mode). This lets you show different guidance depending on whether the user is picking from a dropdown vs. typing/mapping a raw value.

```json
{
	"name": "select",
	"type": "select",
	"multiple": true,
	"label": "Select",
	"options": "rpc://getFields",
	"help": "Select one or more fields to return. Leave empty to return all fields.",
	"mappable": {
		"help": "List of fields separated by comma, for example, `First_Name, MAX(Age) MaxAge`. Leave empty if you need all fields."
	}
}
```

- Base `help` (and other props) apply when the picker/select UI is shown.
- `mappable.help` is displayed only after the user toggles Map mode on.
- Useful for RPC-backed `select` / `multi-select` fields where the dropdown UI and the free-text mapping UI need different instructions (e.g., dropdown lists field names, mapping mode supports aggregate expressions like `MAX(Age) MaxAge`).

Only document properties you have verified. Currently verified override: `help`. Other spec properties may be overridable but have not been documented here — verify against an actual Make app before relying on them.

### Parameter Types

`text`, `number`, `integer`, `uinteger`, `boolean`, `date`, `select`, `collection`, `array`, `email`, `url`, `json`, `password`, `hidden`, `buffer`, `filename`, `color`, `filter`, `file`, `folder`, `uuid`, `time`, `timestamp`, `timezone`, `port`, `path`, `cert`, `pkey`

`checkbox` is an alias for `boolean`; `uuid` and `path` are aliases for `text` (see [Type Aliases & Boolean Rendering](#type-aliases--boolean-rendering)).

### Validation

Add a `validate` object with type-specific keys. Set `validate: false` to disable format checks on a field (e.g. a `required` field whose value should not be format-validated). `required` is checked **separately** — an empty value always fails `required` regardless of `validate`.

| Type | Keys |
|---|---|
| `text` (and `email`, `url`, `password`, `filename`, `uuid`, `path`) | `min`, `max` (string length), `pattern` (regex string; also accepts the object form `{ "regexp": "...", "label": "..." }`) |
| `number`, `integer`, `uinteger`, `port` | `min`, `max` (numeric bounds) |
| `date`, `time`, `timestamp` | `min`, `max` (date/time bounds); `date` also accepts `{ "past": false }` to reject past dates |
| `array`, multi-`select` (`multiple: true`) | `minItems`, `maxItems`, `unique` |

`unique: true` flags duplicate primitive values. For a complex `array`, `unique: { "by": "<fieldName>" }` flags rows whose named field repeats (null / undefined / empty-string values are skipped).

```json
{ "name": "username", "type": "text", "validate": { "min": 3, "max": 30, "pattern": "^[a-z][a-z0-9_]*$" } }
```

```json
{ "name": "durationSeconds", "type": "number", "validate": { "min": 4, "max": 8 } }
```

```json
{ "name": "referenceImages", "type": "array", "validate": { "minItems": 1, "maxItems": 3 }, "spec": { "type": "text" } }
```

### Select Type

```json
{
	"name": "status",
	"type": "select",
	"label": "Status",
	"options": [
		{ "label": "Active", "value": "active" },
		{ "label": "Inactive", "value": "inactive" }
	]
}
```

#### Select Properties

| Property | Notes |
|---|---|
| `multiple` | Allow multiple selection (output is an array). |
| `grouped` | Options are grouped; groups carry nested `options`. Common with RPC option sources. |
| `dropdown` | Use a dropdown UI for multi-select. (forman-documented; rare in apps — verify before use.) |
| `sort` | Sort options, e.g. `"text"` or `"number"`. |
| `dynamic` | RPC-backed → show a refresh button to re-fetch options. |
| `omit` | Exclude the selected value from the submitted parameters. |
| `mode` | `"edit"` enables an editable/typeahead select. |
| `mappable` | `false` locks to pick; object `{ "help": "..." }` supplies map-mode help. |

Option-level properties (each item in `options` or `options.store`):

| Property | Notes |
|---|---|
| `label`, `value` | Display text + stored value (required). |
| `default: true` | Marks this option as the default selection. |
| `description` | Secondary descriptive text shown under the option label. |
| `nested` | Per-option nested fieldset (see precedence rules below). |
| `pill`, `icon` | Visual badge / icon. (forman-supported; not seen in current custom apps — verify before use.) |

```json
{
	"name": "type",
	"type": "select",
	"label": "Search for",
	"required": true,
	"options": [
		{
			"value": "ISSUE",
			"label": "Issues",
			"description": "Search issues by state, author, labels, and other attributes.",
			"default": true,
			"nested": [ { "name": "search", "type": "text", "label": "Search Query" } ]
		}
	]
}
```

**Image options** — `options: { "type": "image", "store": [ { "value": "...", "src": "<url>", "label": "..." } ] }` renders an image picker. (forman-documented; not seen in current custom apps.)

**Pagination / server-side search** — RPC selects can declare `pagination` (`{ "nextParam": "next" }`, envelope `{ items, next }` response) and `searchable` (`{ "param": "query" }`). These are gated behind platform feature flags (`forman-select-pagination`, `forman-select-searchable`) and are silently ignored when off — do not rely on them in custom apps unless confirmed enabled.

### RPC Dynamic Options

Two formats for calling RPCs from parameters:

**Simple format** — dropdown only, no nested parameters generated on selection:

```json
{
	"name": "columnId",
	"type": "select",
	"label": "Column",
	"options": "rpc://RpcBoardColumns?filterAllOutputColumns=true"
}
```

**Store format** — enables nested parameters that appear dynamically when a value is selected (use when the RPC returns `nested` in its output):

```json
{
	"name": "boardId",
	"type": "select",
	"label": "Board ID",
	"options": {
		"store": "rpc://RpcBoards",
		"nested": [
			{
				"name": "columnId",
				"type": "select",
				"label": "Column",
				"options": "rpc://RpcBoardColumns?filterAllOutputColumns=true"
			}
		]
	}
}
```

#### Query Parameter Passing

Pass additional parameters to RPCs using query string syntax: `rpc://RpcName?param=value`

```
rpc://RpcBoardColumns?filterAllOutputColumns=true
rpc://RpcBoardColumns?filterChangeableColumnsWithoutName=true
rpc://RpcBoardColumns?filterOnlyFileColumns=true
```

#### Conditional RPCs (Critical)

Many RPCs use `"condition"` fields in their `api.imljson` to branch into different behaviors. If no condition matches, the RPC returns **empty results** (no error, just no data).

**Rule: Before using any RPC, read its `api.imljson` to check for `condition` fields. If conditions exist, pass the required flag via query string.**

Example — `RpcBoardColumns` has 6 condition branches:

```json
// api.imljson of RpcBoardColumns
[
    { "condition": "{{parameters.filterChangeableColumns == 'true'}}", ... },
    { "condition": "{{parameters.filterChangeableColumnsWithoutName == 'true'}}", ... },
    { "condition": "{{parameters.filterAllOutputColumns == 'true'}}", ... },
    { "condition": "{{parameters.filterOnlyFileColumns == 'true'}}", ... },
    ...
]
```

Calling `rpc://RpcBoardColumns` without any flag → **no condition matches → empty dropdown**. Must use `rpc://RpcBoardColumns?filterAllOutputColumns=true` (or another flag).

#### Nested Parameter Inheritance

RPCs nested inside a parent select's `options.nested` automatically receive the parent's selected value. This enables dependent dropdowns:

```json
{
    "name": "boardId",
    "type": "select",
    "options": {
        "store": "rpc://RpcBoards",
        "nested": [
            {
                "name": "columnId",
                "type": "select",
                // RpcBoardColumns receives `boardId` automatically
                "options": "rpc://RpcBoardColumns?filterAllOutputColumns=true"
            }
        ]
    }
}
```

This inheritance works through multiple nesting levels (e.g., `boardId` → `selectMode` options → nested array → column select). The parent parameter values are always available to child RPCs regardless of depth.

#### Per-Option `nested` vs Store-Level Fallbacks (`placeholder.nested` / `options.nested`)

A `select` can attach nested fields from **multiple** places, resolved by a **precedence order (first match wins), not additively**. The Make parameter form renderer builds exactly **one** nested fieldset per value, choosing the nested spec in this order:

1. **Per-option `nested` from an RPC store** — registered **asynchronously**, only after the store RPC has fetched its options. *(Highest precedence.)*
2. **Per-option `nested` from a static-array store** — matched **synchronously** against the field value.
3. **Store-level `options.nested`** — a sibling of `store`; always eligible, **not gated** by any value state.
4. **`placeholder.nested`** — rendered **only** when the value is in a **placeholder state** (empty / no matched option), i.e. for mapped or manually typed values. *(Lowest precedence.)*

**Critical distinction — RPC store vs static-array store:**

- For a **static array `store`**, the per-option `nested` is matched **synchronously** against the value (rule 2).
- For an **`rpc://` string `store`**, the per-option `nested` arrives **asynchronously** (rule 1) — only available **after** the store RPC has fetched and its options' nesteds are registered.

This async gap is the trap. On module **reopen** of a *dropdown-selected* RPC-store value, the per-option nested (rule 1) may not be resolved yet during the first render pass. If a store-level `options.nested` (rule 3) exists, it wins the race and renders the **generic** nested spec over what is actually a type-specific selection → the saved type-specific operator/value data appears "not compatible." This is exactly the regression QA caught in monday **IEN-15480**.

**`placeholder.nested` is the robust mechanism for the mapped/typed case.** Unlike `options.nested`, the renderer shows `placeholder.nested` **only** when the value is in a placeholder state (no matched option) — so it does **not** pre-empt the async per-option nested (rule 1) on reopen of a dropdown selection.

Other consequences (verified against the Make parameter form renderer's behavior, not docs):

- **No duplication on selection.** When the per-option nested resolves, it wins; the store-level fallback is not *also* rendered.
- **Mapped/typed values fall through to the fallback.** Per-option nested requires a matched option, so it never fires for a mapped IML expression or a manually typed value — the fallback (`placeholder.nested` / `options.nested`) is what surfaces nested fields then.
- **The fallback cannot know the option's type.** A mapped value is opaque at design time, so the fallback RPC/array must return a **generic / superset** spec (all operators, a union of accepted values), not a type-specific one.

**Canonical fix pattern** — "nested fields disappear when the column/value is mapped or typed instead of selected" (monday IEN-15263): keep the per-option `nested` (via the RPC store options) for the dropdown case, and add a **`placeholder.nested`** (RPC with a `?mode=...` flag) that returns the generic field set for mapped/typed values:

```json
{
    "name": "columnId",
    "type": "select",
    "editable": true,
    "options": {
        "store": "rpc://buildsItemsPageQueryParameters",
        "placeholder": {
            "label": " ",
            "nested": "rpc://buildsItemsPageQueryParameters?mode=mapping"
        }
    }
}
```

The RPC branches on the query flag (`"condition": "{{!parameters.mode}}"` for the store list with per-option `nested`; `"condition": "{{parameters.mode === 'mapping'}}"` for a URL-less request returning the generic nested spec).

> ⚠️ **For an RPC-backed `store`, prefer `placeholder.nested` over store-level `options.nested`.** `options.nested` (rule 3) is not gated and can win the async render race on reopen, rendering generic fields over a dropdown selection (monday IEN-15263 was first shipped with `options.nested` and regressed in QA via IEN-15480; the fix switched to `placeholder.nested`). `options.nested` remains acceptable when the `store` is a **static array** (per-option matches synchronously at rule 2, no async gap).
>
> ⚠️ Make's docs `?ask=` bot reports that store-level and per-option `nested` "both render" and that the store-level fallback "does not render for mapped values" — **both claims are wrong**. The authoritative behavior is the precedence order above. When editor-rendering behavior matters, verify against the Make parameter form renderer's actual behavior, not the docs bot.

### Collection Type

```json
{
	"name": "address",
	"type": "collection",
	"label": "Address",
	"spec": [
		{ "name": "city", "type": "text", "label": "City" },
		{ "name": "zip", "type": "text", "label": "ZIP Code" }
	]
}
```

### Array Type

```json
{
	"name": "tags",
	"type": "array",
	"label": "Tags",
	"spec": { "type": "text", "label": "Tag" }
}
```

#### Array Properties

| Property | Notes |
|---|---|
| `labels` | Custom UI text: `{ "add": "Add attendee", "item": "Attendee" }` (add-button + per-item label). |
| `validate` | `minItems`, `maxItems`, `unique` — see [Validation](#validation). |
| `rpc` | Add items via a remote search sub-form: `{ "label", "url": "rpc://...", "parameters": [...] }`. |
| `mappable` | `false` disables mapping the whole array. |
| `sequence` | `true` → items are user-orderable (drag to reorder). (forman-documented; rare in apps — verify before use.) |

```json
{
	"name": "attendees",
	"type": "array",
	"label": "Attendees",
	"labels": { "add": "Add attendee" },
	"spec": { "type": "email", "label": "Attendee" }
}
```

### `required` Validation Behavior: Array vs Collection

The Make platform's parameter form validator enforces `required` differently depending on the parent container type.

**Collection** — child field `required: true` **is enforced**:

```json
{
	"name": "collectionParam",
	"type": "collection",
	"spec": [
		{ "name": "childParam", "type": "text", "required": true }
	]
}
// Submitting {"collectionParam": {"childParam": null}} → validation error
```

**Array (complex)** — child field `required: true` **is NOT enforced**:

```json
{
	"name": "arrayParam",
	"type": "array",
	"spec": [
		{ "name": "childParam", "type": "text", "required": true }
	]
}
// Submitting {"arrayParam": [{"childParam": null}]} → passes validation
```

**Array (simple)** — item-level `required: true` **is enforced**:

```json
{
	"name": "emails",
	"type": "array",
	"spec": { "type": "email", "required": true }
}
// Submitting {"emails": [null]} → validation error
```

**Why**: Collection is a fixed single object where the user explicitly fills each field — enforcing `required` on child fields is natural. Array is a dynamic, repeatable structure where items are often populated through mapping from previous modules. Validating `required` on every child field of every array item would cause unnecessary failures when mapped values resolve to null at runtime.

**Source**: In the Make platform's parameter form validator, the `array` input passes the spec array directly as the `instructions` parameter when calling the collection validator (`validateNested(value[i], 'collection', instructions.spec, options)`). The collection validator then accesses `instructions.spec` for child field iteration — but since `instructions` already IS the spec array, `.spec` is `undefined` and child-level validation is skipped entirely. This is intentional platform behavior.

**Practical implication**: If you need strict validation on child fields inside an array, do not rely on `required: true` in the spec. Instead, validate in the module's `api.imljson` communication layer (e.g., using `valid` directive or custom error handling).

## Text Type Extras

```json
{
	"name": "siteUrl",
	"type": "text",
	"label": "Site URL",
	"multiline": false,
	"rows": 5,
	"placeholder": "https://example.com/admin",
	"prefix": "https://",
	"postfix": "/admin",
	"validate": { "max": 200 }
}
```

- `multiline: true` → renders a textarea; `rows` sets its height. (`rows` is forman-documented; rare in apps.)
- `prefix` / `postfix` → fixed, non-editable text rendered around the input (URL-style fields).
- `placeholder` → empty-state hint.

**Text RPC search button** — a `text` input can render a "Search" button that opens a remote sub-form whose result populates the field:

```json
{
	"name": "channel",
	"type": "text",
	"label": "Channel ID",
	"required": true,
	"rpc": {
		"label": "Search",
		"url": "rpc://searchChannels",
		"parameters": [
			{ "name": "query", "type": "text", "label": "Query", "help": "Name of the channel." }
		]
	}
}
```

## Boolean Type & Conditional Nesting

`boolean` (and its alias `checkbox`) can reveal nested fields based on its value — the same `nested` mechanism as `select`, plus boolean-only branch control.

```json
{
	"name": "addImage",
	"type": "boolean",
	"label": "Add Cover Image",
	"nested": [
		{ "name": "fileName", "type": "filename", "semantic": "file:name", "required": true },
		{ "name": "data", "type": "buffer", "semantic": "file:data", "required": true }
	]
}
```

| `nested` shape | `reversedNested` | Result |
|---|---|---|
| `[...]` or `"rpc://..."` | absent / false | nested shown when value is `true` |
| `[...]` or `"rpc://..."` | `true` | nested shown when value is `false` |
| `{ "true": [...], "false": [...] }` | ignored | both branches, each independently an array or RPC URL string |

```json
{
	"name": "notify",
	"type": "boolean",
	"nested": {
		"true":  [ { "name": "email", "type": "email", "required": true } ],
		"false": [ { "name": "reason", "type": "text" } ]
	}
}
```

`text` (and aliases) also accept `nested`, shown whenever the field has any non-empty value.

> The single-branch boolean `nested` (true-trigger) is widely used in custom apps. `reversedNested` and the object `nested: { true, false }` form are imt-forman-documented but uncommon in current custom apps — verify against a live app before relying on them.

## Date / Time Type Extras

- `time: false` → date-only picker (no time component).
- `validate: { "past": false }` → reject dates in the past.
- `mappable: false` → lock to the picker (disable IML mapping).

## Type Aliases & Boolean Rendering

| Alias | Resolves to | Notes |
|---|---|---|
| `checkbox` | `boolean` | Always a 2-state single checkbox (unchecked = `false`). |
| `uuid` | `text` | No built-in UUID format check — add `validate.pattern` if you need it. |
| `path` | `text` | No built-in path validation; intent-only alias. |

`boolean` rendering depends on `required`:

- `required: false` → 3-state control (true / false / empty).
- `required: true` → 2-state control.

Use the `checkbox` alias when you always want a single 2-state checkbox.

## Interface Structure

Defines module output structure. Same syntax as Parameters but uses `spec` for nested structures:

```json
[
	{ "name": "id", "type": "uinteger", "label": "ID" },
	{ "name": "name", "type": "text", "label": "Name" },
	{
		"name": "emails",
		"type": "array",
		"label": "Emails",
		"spec": { "type": "email", "label": "Email" }
	}
]
```

### Dynamic Interface via RPC

Use `"rpc://nameOfRPC"` as an element in the interface array to generate output fields dynamically based on user parameters.

**Module interface.imljson**:
```json
[
	{ "name": "id", "type": "uinteger", "label": "ID" },
	"rpc://RpcMyDynamicInterface"
]
```

The RPC replaces its position in the array with a dynamically generated field definition.

**RPC api.imljson pattern**:
```json
[
	{
		"url": "/api/endpoint",
		"method": "POST",
		"body": { "query": "..." },
		"response": {
			"output": {
				"name": "data",
				"type": "collection",
				"label": "Dynamic Output",
				"spec": "{{buildMyInterface(parameters.fields, body.data.columns)}}"
			}
		}
	}
]
```

**Mapped parameter safety**: When module parameters may contain mapping expressions (e.g., `{{4.boardId}}`), the RPC must handle them safely. Mapped values are unresolved strings at design time (e.g., `"{{4.boardId}}"`) — they are not null, so `!= null` checks pass, but they are not valid IDs.

**Handling mapped parameters**: At design time, mapped values are unresolved strings (e.g., `"{{4.boardId}}"`). They are not null, so `!= null` checks pass, but they are not valid IDs. To detect mapped values, create a custom IML function like:

```js
function isImlVariableIncluded(value = '') {
	return /\{\{.*?\}\}/.test(value);
}
```

Then use it in conditions to skip API calls when the parameter is mapped:

```json
{
	"condition": "{{parameters.boardId != null && !isImlVariableIncluded(parameters.boardId)}}",
	"url": "/api/endpoint",
	"response": { "output": { "spec": "{{buildMyInterface(...)}}" } }
},
{
	"condition": "{{parameters.boardId == null || isImlVariableIncluded(parameters.boardId)}}",
	"response": { "output": { "name": "data", "type": "collection", "spec": [] } }
}
```

Alternatively, if the app already has a `validateID` function, use `validateID(ifempty(parameters.boardId, 0))` in the query body to convert invalid values to `0` (API returns empty results gracefully).
