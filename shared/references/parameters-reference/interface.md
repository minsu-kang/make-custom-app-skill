# Parameters and Interface Reference: output interface

> Read when: writing or reviewing `interface.imljson` or an RPC that builds part of it: interface syntax, unknown structures, a dynamic interface via an `rpc://` entry, what such an RPC returns, and how mapped parameter values reach it. Part of [parameters-reference.md](../parameters-reference.md).

How the runtime runs an RPC is in [RPC](../runtime-reference.md#rpc) of the runtime reference.

## Interface syntax

The interface of a module (`interface.imljson`) describes the structure of the output that the module returns. It uses the same field syntax as a parameters array: each entry has a `name`, a `type`, a `label` and the other properties of a field (see [What a parameters array holds](../parameters-reference.md#what-a-parameters-array-holds)). Nested structures use `spec`:

- A collection takes an array of fields as its `spec`.
- An array takes one field description as its `spec` when its items are simple values (see [Array item specs](../parameters-reference.md#array-item-specs)).

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

When the structure of an array or a collection is not known in advance, the public developer documentation says to leave `spec` out of an array and to write `spec: []` for a collection:

```json
[
	{ "name": "tags", "type": "array", "label": "Tags" },
	{ "name": "extra", "type": "collection", "label": "Extra", "spec": [] }
]
```

What the form and the runtime do with an interface:

- The runtime never reads the interface and never compares the output of a module with it. An output that does not match its interface fails nothing at run time.
- The parameter form does not render an interface. The types written inside an interface are not checked by the form or by the runtime.

The `parameters` root of the IML templates is a separate matter. The runtime builds it from the stored parameters with the mapped input on top, takes the connection and webhook entries out, hands the rest over as it is and checks no value against a spec (see [The runtime does not check parameter values](validation.md#the-runtime-does-not-check-parameter-values) and [Roots in modules, RPCs and Endpoints](../runtime-reference/iml-context.md#roots-in-modules-rpcs-and-endpoints)).

The platform reads the interface (the mapping panel and the scenario builder use it). That an interface takes the same syntax as parameters comes from the public developer documentation and is decided by the platform, not by the form or the runtime.

## Dynamic interface via RPC

Write `"rpc://nameOfRPC"` as an entry of the interface array to build output fields from what the user entered: the fields depend on the module parameters, so they are not fixed in the file. The entry can sit among static fields, as below, or be the whole interface.

**Module interface.imljson**:

```json
[
	{ "name": "id", "type": "uinteger", "label": "ID" },
	"rpc://RpcMyDynamicInterface"
]
```

The public developer documentation says the RPC can read the module parameters as `{{parameters.foo}}` and, in the interface of an instant trigger, the webhook parameters as `{{webhook.foo}}` (the roots of an RPC are in [Roots in modules, RPCs and Endpoints](../runtime-reference/iml-context.md#roots-in-modules-rpcs-and-endpoints)).

The platform calls the RPC and puts its answer in the place of the `rpc://` entry. When it calls, with which parameter values, and what shape of answer it accepts, is the platform's decision: the form and the runtime cannot settle it, and the public documentation only implies the replacement with its example of a static field next to an `rpc://` entry. For the pattern below the runtime returns a list (see the rules after it).

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

`buildMyInterface` stands for a custom IML function of the app that returns the list of fields.

What the RPC returns follows the runtime rules for an RPC ([output](../runtime-reference.md#output), [condition](../runtime-reference.md#condition) and [Several requests in one module](../runtime-reference.md#several-requests-in-one-module)). Each element of the `api` array is one block:

- `response.output` is an IML template that Make evaluates through all its levels. A `{{...}}` expression inside `spec`, as in the pattern above, is evaluated too, and it can return a whole list of fields.
- A block that sends a request, or has no `url` (so it sends none), yields a list, unless a `response.wrapper` returns an object or a string (see [What each module type returns](../runtime-reference.md#what-each-module-type-returns)). An `output` object becomes a list of one element, and an `output` that is a list, or evaluates to one, gives one element per entry. A block without `url` still evaluates `response.output`.
- Without `output`, the parsed response body is the result: an array body is the list, an object body becomes a list of one element. A block without `url` has no body, so without `output` it yields an empty list, which replaces an earlier result.
- `output: false` or `output: null` yields an empty list.
- Blocks run in order, and the result of the last block that is not skipped is the RPC's result. An empty list is a result like any other and replaces an earlier one.
- A block whose `condition` is false is skipped: it adds no result, so the result of an earlier block stays. When that block has a `condition.default`, the evaluated `default` replaces the earlier result. It is returned as written: an object `default` is an object, not wrapped in a list. When every block is skipped and none has a `default`, the RPC has no result.

## Mapped values reach the RPC as text

While a module is being set up, a mapped parameter has no real value yet. An RPC that reads a parameter which may hold a mapping expression has to handle the mapping text safely.

- For an RPC that the parameter form calls (an options RPC or the RPC of a nested group), a mapped value arrives as the text the user entered in the mapping box, its raw `{{...}}` text (for example `"{{4.boardId}}"`), not as null. A boolean field `b` in map mode that holds `{{4.flag}}` and has `"nested": "rpc://foo"` sends the call data `{"b": "{{4.flag}}"}`. What such an RPC receives is in [What an options RPC receives](select-and-rpc-options.md#what-an-options-rpc-receives), and the nested-field case is in [Mapped values and nested fields](select-and-rpc-options.md#mapped-values-and-nested-fields).
- The text is not null, so a check such as `!= null` passes, but the text is not a valid id.
- The platform, not the form, calls the interface RPC, so what it receives while the module is set up cannot be seen from the form or the runtime. The same raw text is expected, but the platform decides.

To detect a mapped value, add a custom IML function to the app (see [custom-functions-reference.md](../custom-functions-reference.md)):

```js
function isImlVariableIncluded(value = '') {
	return /\{\{.*?\}\}/.test(value);
}
```

It returns true for a text that holds `{{`, any characters on one line, and `}}`:

- `{{4.boardId}}` and `a{{b}}c` give true.
- Numbers, `null`, an unset value and a plain id such as `12345` give false.
- A variable with a line break inside the braces is not detected and gives false.

The conditions that use this helper, and what each kind of value does with them, are in [Skipping the call for a mapped value](#skipping-the-call-for-a-mapped-value).

## Skipping the call for a mapped value

Use the helper in `condition` to skip the API call while the parameter is mapped. The RPC has two blocks: the first calls the API when the parameter holds a real value, the second builds an empty collection when the value is missing or mapped.

```json
[
	{
		"condition": "{{parameters.boardId != null && !isImlVariableIncluded(parameters.boardId)}}",
		"url": "/api/endpoint",
		"response": {
			"output": {
				"name": "data",
				"type": "collection",
				"label": "Dynamic Output",
				"spec": "{{buildMyInterface(...)}}"
			}
		}
	},
	{
		"condition": "{{parameters.boardId == null || isImlVariableIncluded(parameters.boardId)}}",
		"response": {
			"output": {
				"name": "data",
				"type": "collection",
				"label": "Dynamic Output",
				"spec": []
			}
		}
	}
]
```

How the two blocks run:

- The blocks follow the rules of [Dynamic interface via RPC](#dynamic-interface-via-rpc): they run in order, a block whose `condition` is false is skipped, and the last block that is not skipped gives the result.
- The second block has no `url`, so it sends no request. It still evaluates `response.output`, which is all it needs.
- The two conditions are exact opposites, so exactly one block runs.

What each kind of value does with the two conditions:

| `parameters.boardId` | `!= null` | First condition | Second condition | Block that runs |
|---|---|---|---|---|
| Mapped text `"{{4.boardId}}"` | true | false | true | second |
| A real id such as `"12345"` | true | true | false | first |
| `null` | false | false | true | second |
| Absent from the saved parameters (see [Missing values](../runtime-reference.md#missing-values)) | false | false | true | second |
| An empty string `""` | true | true | false | first, with an empty id |

Give both blocks the same field shape. `response.output` is returned as written, after its IML is evaluated, so an `output` without `name` and `type` (only `spec`) would return a different shape than the other block. Write the output of the first block as a full field, as in the RPC pattern of [Dynamic interface via RPC](#dynamic-interface-via-rpc).

`!= null` lets an empty string through. With `parameters.boardId` equal to `""` the first condition is true, and the request runs with an empty id (last row of the table). An empty text field is not absent: the parameter form gives it the value `""`, also when the user never typed in it. Whether the platform passes that `""` on to the interface RPC cannot be seen from the form or the runtime; the platform decides. To treat an empty value as missing too, test the value itself in both conditions. The new `condition` of the first and of the second block, with their other keys unchanged:

```json
[
	{ "condition": "{{parameters.boardId && !isImlVariableIncluded(parameters.boardId)}}" },
	{ "condition": "{{!parameters.boardId || isImlVariableIncluded(parameters.boardId)}}" }
]
```

A value of `0` counts as missing in these tests as well. Change both conditions together: with only the first one changed, an empty string makes neither block run, and the RPC returns no result.

The alternative: when the app already has a `validateID` function, use `validateID(ifempty(parameters.boardId, 0))` in the query body to convert invalid values to `0`, so that the API returns an empty result gracefully. `ifempty` turns an empty string, `null` or an unset value into `0` and leaves a mapped text (and an empty list) as it is, so `validateID` has to deal with the `{{...}}` text. `validateID` is not a Make function: the app defines it, and how the vendor API treats `0` is the vendor's behaviour. Neither the form nor the runtime decides either of them.
