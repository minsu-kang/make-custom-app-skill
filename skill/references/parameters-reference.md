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
