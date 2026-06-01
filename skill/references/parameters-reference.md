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

#### Per-Option `nested` vs Store-Level `options.nested` (Precedence + Mapped-Value Fallback)

A `select` can attach nested fields from **two** places, and they are **mutually exclusive per value (precedence), not additive**:

1. **Per-option `nested`** — defined inside each individual store option (e.g. an option object returned by the store RPC carries its own `nested`). Renders only when the field value **matches that fetched option** (i.e. picked from the dropdown).
2. **Store-level `options.nested`** — sibling of `store` (an array or an `rpc://` URL). Acts as the **fallback** that renders when the value does **not** match any fetched option — i.e. a **mapped** or manually **typed** value.

The form renderer (`@integromat/forman`, `lib/utils.ts → resolveInstructions`) resolves the nested spec with a `||` chain — first truthy wins, and `showNestedFieldsets` builds exactly **one** nested fieldset per value:

```
remote-registered nested
  || matchedStoreOption.nested      // per-option (dropdown selection) — takes precedence
  || options.nested                 // store-level (mapped / typed value) — fallback
  || instructions.options.nested
  || options.placeholder.nested
```

Key consequences (verified against forman source, not just docs):

- **No duplication.** When a dropdown option is selected, the per-option `nested` wins and store-level `options.nested` is **not** also rendered — even if both define identically-named fields. Adding a store-level `options.nested` therefore does **not** change the dropdown-selection path.
- **Mapped/typed values fall through to `options.nested`.** Per-option `nested` requires a matching selected option, so it never fires for a mapped IML expression or a manually typed value. Store-level `options.nested` is what surfaces nested fields in those cases.
- **The store-level fallback cannot know the option's type.** Because a mapped value is opaque at design time, the fallback RPC/array must return a **generic / superset** spec (all operators, a union of accepted values), not a type-specific one.

**Canonical fix pattern** — "nested fields disappear when the column/value is mapped instead of selected" (monday IEN-15263): keep the existing per-option `nested` for the typed-selection case, and **add** a store-level `options.nested` (commonly an RPC with a `?mode=...` flag) that returns the generic field set for mapped/typed values:

```json
{
    "name": "columnId",
    "type": "select",
    "editable": true,
    "options": {
        "store": "rpc://buildsItemsPageQueryParameters",
        "nested": "rpc://buildsItemsPageQueryParameters?mode=mapping"
    }
}
```

The RPC branches on the query flag (`"condition": "{{!parameters.mode}}"` for the store list with per-option `nested`; `"condition": "{{parameters.mode === 'mapping'}}"` for a URL-less request returning the generic nested spec).

> ⚠️ Make's docs `?ask=` bot reports that store-level and per-option `nested` "both render" and that `options.nested` "does not render for mapped values" — **both claims are wrong**. The authoritative behavior is the precedence chain above (forman `resolveInstructions`/`findOption`/`showNestedFieldsets`). When editor-rendering behavior matters, verify against forman source, not the docs bot.

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

The Make platform's form validator (`imt-forman`) enforces `required` differently depending on the parent container type.

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

**Source**: In `imt-forman`, `array.mjs` passes the spec array directly as the `instructions` parameter when calling the collection validator (`validateNested(value[i], 'collection', instructions.spec, options)`). The collection validator then accesses `instructions.spec` for child field iteration — but since `instructions` already IS the spec array, `.spec` is `undefined` and child-level validation is skipped entirely. This is intentional platform behavior.

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
