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
