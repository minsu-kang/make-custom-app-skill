# Parameters and Interface Reference: select options and RPCs

> Read when: writing or reviewing a `select`: select and option properties, inline and RPC option sources, what an options RPC receives and must return, conditional RPCs, nested fields on a select (`nested`, per-option `nested`, `options.nested`, `options.placeholder.nested`) and which one is shown, reopening a saved module, paging and server-side search, and the value checks and messages for inline options. Part of [parameters-reference.md](../parameters-reference.md).

This part states what the module form shows for a `select` and what the value check does with it. "In the module settings" marks behaviour measured in the settings panel of a module, which wraps the form and adds a display check; elsewhere the form can differ, and the text says where. How a resolved value reaches the IMLJSON is in [runtime-reference.md](../runtime-reference.md).

## A select with inline options

An inline array of `{ label, value }` objects shows exactly those options, and the chosen option is stored as its `value`.

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

- **The empty choice.** An optional single select (not `required`, not `multiple`) always lists an extra first choice with an empty value, labelled "Empty". It is the selected choice until the user picks something, unless an option has `default: true` (see [Option properties](#option-properties)). `options.placeholder` (a string, or `{ label, nested }`) renames that choice and is also the hint text. A `placeholder` on the select itself changes only the hint text. A required select and a multiple select have no empty choice and show the hint text until something is chosen.
- **Empty RPC options.** When the options loaded by an RPC come back empty and the field has the Map switch, the field switches itself to map mode (see [Which fields get a Map switch](../parameters-reference.md#which-fields-get-a-map-switch-mappable-editable)). An empty inline list does not.
- **A saved value that is no longer an option** is cleared when the form is built. This holds for inline options, and for RPC options when no label of the choice was saved (with a saved label the value stays and shows that label). An optional select falls back to its empty choice without a message. A required select is left empty and marked invalid with `Value must not be empty.`.

## Select properties

| Property | What it does |
|---|---|
| `multiple` | The parameter holds an array of the chosen values. A single scalar given to a multiple select counts as a one-item array. Item rules (`minItems`, `maxItems`, `unique`) are in [Item rules on arrays and multi-selects](validation.md#item-rules-on-arrays-and-multi-selects). |
| `grouped` | `true` makes the options a list of groups, `{ "label": "...", "options": [ ... ] }`, for inline options and for options loaded by an RPC alike; the stored value is the chosen inner option value. Set it whenever the options are groups. `{ "type": "collapsible" }` gives collapsible groups, with a select-all box in multiple selects. Without it the group objects are treated as options and no value matches (the value check says `Value not found in options in parameter '<label>'.`). An unknown `grouped.type` falls back to a flat group list. Common with RPC option sources. |
| `dropdown` | A multiple select is already shown as a dropdown by default. `dropdown: false` switches it to an always-open list of checkboxes. `dropdown: true` is redundant on a multiple select and changes nothing visible on a single select, which is always a dropdown. |
| `sort` | Orders the options by the property `value`, not by `label`. `"text"` compares the values as text in alphabetical order (upper and lower case sort together, and "10" comes before "9"). `"number"` compares them as numbers, so number-like text ("9", "10", "100") sorts numerically too; a list that mixes numbers and non-numeric values ends up in an unpredictable order. Any other `sort` value does nothing, and without `sort` the options keep the order they were given in. It applies to inline options, to options loaded by an RPC, and inside each group of a grouped select (the groups keep their order). `sort` always reads the property `value`, even when `options.value` renames the value key: `"text"` then leaves the select without options, and `"number"` does not reorder them. |
| `dynamic` | `true` switches off the check that a submitted value is one of the inline options, and the allowed-values list is then not saved with the module (see [Value checks for inline options](#value-checks-for-inline-options)). Options loaded by an RPC are never checked this way. It does not control a refresh button: every select whose options come from an RPC shows a refresh icon while its dropdown is open (a multiple select shown as an always-open checkbox list has none). A Refresh action appears next to a select whose nested fields come from an RPC: a nested set given as an RPC URL, or the per-option nested sets of an RPC store that has no `options.nested`. |
| `omit` | `true` removes the select and its value from the value the form returns. The field is still shown, editable and checked: a required `omit` select left empty shows `Value must not be empty.`, fails the whole-form check and is listed in the floating summary; only the per-field result list that the form hands to the hosting page leaves it out. See [Hidden, locked and left-out fields](../parameters-reference.md#hidden-locked-and-left-out-fields). |
| `mode`, `mappable` | Start mode, the Map switch and the map-mode help. `mappable: false` locks the select to pick mode, and a `mappable` object `{ "help": "..." }` supplies the map-mode help. `mode: "edit"` means map mode and is not a typeahead select. See [Start mode, map-mode help and label](../parameters-reference.md#start-mode-map-mode-help-and-label-mode-mappable-object) and [Which fields get a Map switch](../parameters-reference.md#which-fields-get-a-map-switch-mappable-editable). |
| `showSearcher` | `true` or `false` forces the search box on or off; a number sets from how many options it shows (default 10). A multiple select shown as an always-open list shows a search box only with `true`. |
| `showSelectAll` | The Select all box of multiple selects. Same forms as `showSearcher`; the default shows it from 3 options. |
| `showValue` | Adds the value in brackets after each label. |
| `labels` | `{ "noData": "...", "noResults": "..." }` replaces the two list messages (see [What an options RPC must return](#what-an-options-rpc-must-return)). |
| `lazy` | Loads the RPC options only when the list is opened. It needs a Make feature flag. A saved value without a saved label still loads at once. |
| `actionOption` | An extra action row at the end of the list. |

Observed: `dropdown` is rare in the custom apps reviewed.

Whether Make checks a mapped or typed select value against the inline options again when a scenario runs, and so what `dynamic` changes there, is decided by the platform outside the form (see [Where values are checked](validation.md#where-values-are-checked)).

## Option properties

Option-level properties apply to each item of `options` or `options.store`.

| Property | What it does |
|---|---|
| `value` | What is stored. |
| `label` | The text shown. When it is missing or empty, the value is shown as the text. |
| `default: true` | Preselects the option when the field has no value yet (a new module), and also when the saved value is the empty choice (`""`) of an optional select. A non-empty saved value and a `default` set on the select itself win over it. It works for flat inline options and for options loaded by an RPC. On a multiple select only the first option marked `default: true` is preselected. It is ignored for options inside the groups of a grouped list, and when `options.value` renames the value key. |
| `description` | A second line shown under the option label. |
| `nested` | The fields shown when that option is selected. It works on single selects only: on a multiple select a per-option `nested` is never shown, and if `options.nested` is also set the select shows no options at all and its saved value is lost, with no message to the user (see [Which nested set is shown](#which-nested-set-is-shown)). |
| `icon` | The name of a Font Awesome regular icon (for example `"bolt"`), shown before the label. |
| `iconTooltip` | `{ "title": "...", "text": "..." }` adds hover text to the icon. |
| `pill` | A short status text shown next to the description. Its style follows the text in lower case: `info`, `success`, `warning`, `error`, `system-2` and `paid` have their own colour, and any other text gets the default brand colour. |
| `disabled` | `true` greys the option out so it cannot be selected. A disabled option with a `pill` shows the pill as a lock badge with the default tooltip "Upgrade to a paid plan to unlock". |

When `options` is an object (with an inline `store` array or an RPC `store`), these properties of the select's `options` object rename the keys read from each option:

| `options` property | Renames |
|---|---|
| `label` | The key that holds the label. |
| `value` | The key that holds the value. With a renamed value key, `default: true` on an option and `sort` no longer work. |
| `description` | The key that holds the second line. |
| `pill` | The key that holds the status pill. |
| `default` | Names a property to read the default flag from (for example `"isDefault"`) instead of `default`. It acts only on a select that starts with no value at all (a required or a multiple select, not an optional single select). There it also finds options inside groups, works with a renamed value key, and on a multiple select preselects every flagged option. |

Observed: `pill` and `icon` are not used in the custom apps reviewed.

This example has a `description`, a `default` and a `nested`. On a fresh form the option is preselected and its nested field shows.

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

## Image options

`options: { "type": "image", "store": [ ... ] }` shows each option as a tile with its label and a picture loaded from `src`. When `src` is missing, the picture is loaded from the option value. The tiles wrap in a grid.

```json
{
	"options": {
		"type": "image",
		"store": [ { "value": "...", "src": "<url>", "label": "..." } ]
	}
}
```

Observed: image options are not used in the custom apps reviewed. The tile layout was read from the form code and not run in a browser.

## Option sources

| Form | Written as | What you get |
|---|---|---|
| Inline array | `"options": [ { "label": "A", "value": "a" } ]` | Those options. A per-option `nested` is allowed. |
| RPC string | `"options": "rpc://Name"`, optionally with a query string | A dropdown filled from the RPC. There is no place for `options.nested` or `options.placeholder`. If the options the RPC returns carry their own `nested` arrays, those still show when the option is selected. |
| Store object | `"options": { "store": [ ... ], ... }` or `{ "store": "rpc://Name", ... }` | Both store forms give a dropdown. Use the object when you need a store-level nested set (`options.nested`, shown for any option without its own nested), `placeholder`, `label` / `value` / `description` / `pill` key names, `wrapper`, `type: "image"` or `default`. Nested sets that the RPC returns inside its options do not need it. |

The string form, a dropdown with nothing generated on selection except the nested sets the RPC itself returns:

```json
{
	"name": "columnId",
	"type": "select",
	"label": "Column",
	"options": "rpc://RpcBoardColumns?filterAllOutputColumns=true"
}
```

The store form, with a store-level nested set whose select loads its own options:

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

In an RPC answer, a text of the form `rpc://Name` (with or without a query string) is rewritten to the same app and version as the RPC that answered. An RPC can therefore name other RPCs of its own app in the nested specs it returns.

## What an options RPC receives

### Query-string parameters

Pass fixed parameters in the URL: `rpc://RpcName?param=value&other=x`. They reach the RPC as parameters, together with the other data the form sends.

```
rpc://RpcBoardColumns?filterAllOutputColumns=true
rpc://RpcBoardColumns?filterChangeableColumnsWithoutName=true
rpc://RpcBoardColumns?filterOnlyFileColumns=true
```

| Query-string case | What the RPC gets |
|---|---|
| Any value | Text: `true` arrives as `"true"` and `5` as `"5"`. An IMLJSON condition has to compare with the text (`parameters.flag == 'true'`); a real boolean `true` does not equal the text. |
| A key given twice | An array of the values. |
| A key with no value (`flag` or `flag=`) | Dropped. |
| `%` escapes | Not URL-decoded: `x%20y` stays as typed. |
| `#` | Ends the value it is in: `p=x#frag` sends `"x"`. A later `&key=value` is still read, so `?p=x#frag&z=9` sends `p` and `z`. |
| `{{...}}` | Evaluated first, from the values the RPC receives (for example `{{boardId}}` of a parent field). What resolves in an `rpc://` URL and what does not is in [What a parameters array holds](../parameters-reference.md#what-a-parameters-array-holds). |
| The same name as an inherited value | The query-string key replaces the inherited value. |

How the data the form sends (inherited parent values and query-string keys) becomes the `parameters` object inside the RPC's IMLJSON, and which extra values the host adds (connection, module parameters, build-time values), is done by Make before the RPC runs; the form only sends the data. The roots an RPC reads are in [iml-context.md](../runtime-reference/iml-context.md).

### Values inherited from parent fields

A select nested under another field sends its options RPC the values of all the fields it is nested under. "Nested under" covers `options.nested`, a per-option `nested` and a `nested` on the select itself. Each value goes under that field's name (for a parent named `boardId`: `{ "boardId": "p1" }`), and this holds at every depth while the parents are in pick mode. That makes dependent dropdowns possible.

- Fields beside the select at the same level and top-level fields are not sent. A collection around the select adds nothing.
- A top-level select with no parent gets no inherited values.
- When the parent value changes, the child loads its options again the next time its list is opened.
- A select three levels down receives the values of all its ancestors, each under its own field name (for example `boardId`, then a `selectMode` option, then a nested array, then a column select).

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
				// RpcBoardColumns receives { "boardId": "<chosen board>" } automatically
				"options": "rpc://RpcBoardColumns?filterAllOutputColumns=true"
			}
		]
	}
}
```

When the parent is in map mode, what the child gets depends on how the nested set is given:

| Nested set given as | What happens in map mode |
|---|---|
| An inline array | Selects in it whose options come from an RPC are turned into plain mapped fields and call no RPC. Selects with inline options stay selects. |
| An RPC URL | That RPC, and the options RPCs of the selects it returns, receive the unresolved formula text (for example `{{1.id}}`). |

## What an options RPC must return

- An array of option objects `{ label, value }`, optionally with `description`, `pill`, `icon`, `iconTooltip`, `disabled`, `default` and `nested`; or, with `grouped`, an array of groups `{ label, options: [ ... ] }`.
- Another answer shape (an object, or no result) gives no options and no message.
- An empty array shows the message `No data available.`. `labels.noData` replaces it.
- A search that finds nothing shows `No results for '{query}'`, with `{query}` the typed text. `labels.noResults` replaces it.
- If the RPC fails, the open list shows `Failed to load data!` and the form shows the error under the field: the error message without a final full stop, then ". ", then the detail (for example the message "Boom happened." with the detail "Check the connection." shows `Boom happened. Check the connection.`). Both parts are taken from the error answer that Make returns.
- `options.wrapper` names a key of the answer that holds the array. It is a property of the select and is a different thing from the `response.wrapper` directive of the RPC's IMLJSON (below).

What the runtime does with the answer (the full rules are in [RPC](../runtime-reference.md#rpc)):

- `response.output` is always collected into an array, even when it is a single object. An `output` of `null` gives an empty array.
- Every item must be an object or a text. An item that is a number or a boolean fails the RPC with `Invalid item in RPC output. Expected Object, or String, but found <type>.`. Empty (`null`) items are dropped silently.
- Only a `response.wrapper` or the `default` of a `condition` (see [Conditional RPCs](#conditional-rpcs)) can make the answer a single object or text. A wrapper that gives anything else fails with `Invalid module output. Expected Object, or String, or Array, but found <type>.`. The paging envelope `{ items, next }` has to come from one of these two for this reason (see [Paging and server-side search](#paging-and-server-side-search)).

## Conditional RPCs

An RPC branches with `condition` in its `api.imljson` (see [condition](../runtime-reference.md#condition)). What that means for a select:

- When no condition matches, the RPC ends with no result and no error, and the select gets no options.
- `condition` can be an object `{ "condition": "...", "default": ... }`. The `default` is returned as the result when the condition is false. It is returned as written: an object or a text stays an object or a text and is not wrapped in an array.
- In a list of requests, a request whose condition is false is skipped and the earlier result is kept, unless that request has a `default`: the `default` then replaces the earlier result. The RPC answer is the result of the last request that produced one (a request that ran, or the `default` of a skipped one): with exactly one matching request, its output; with every request skipped and no `default`, no result.
- A request without a `url` makes no HTTP call and the chain goes on, but `response.output` still applies. A branch can therefore return a static answer built from `response.output` alone (see [Items without a request](../runtime-reference.md#items-without-a-request)).

**Rule: before using an RPC, read its `api.imljson` for `condition` fields. If conditions exist, pass the flag in the query string.** The query string is the only way to pass a fixed flag from the parameter spec to a branch (a nested select's RPC also receives the values of its parent fields, which a `condition` can read), and a flag compares as text (see [Query-string parameters](#query-string-parameters)).

```json
// api.imljson of an RPC that lists columns (three branches)
[
	{
		"condition": "{{parameters.filterChangeable == 'true'}}",
		"url": "/columns/changeable",
		"response": { "iterate": "{{body.columns}}", "output": { "value": "{{item.id}}", "label": "{{item.title}}" } }
	},
	{
		"condition": "{{parameters.filterAll == 'true'}}",
		"url": "/columns",
		"response": { "iterate": "{{body.columns}}", "output": { "value": "{{item.id}}", "label": "{{item.title}}" } }
	},
	{
		"condition": "{{parameters.filterFiles == 'true'}}",
		"url": "/columns/files",
		"response": { "iterate": "{{body.columns}}", "output": { "value": "{{item.id}}", "label": "{{item.title}}" } }
	}
]
```

With `"options": "rpc://RpcColumns"` no condition matches, so the dropdown is empty. `"options": "rpc://RpcColumns?filterAll=true"` reaches the second branch.

Observed in the monday app: its `RpcBoardColumns` has six condition branches (`filterChangeableColumns`, `filterChangeableColumnsWithoutName`, `filterAllOutputColumns`, `filterOnlyFileColumns` and two more), so `rpc://RpcBoardColumns` without a flag gives an empty dropdown, and it needs `rpc://RpcBoardColumns?filterAllOutputColumns=true` (or another flag). The branch count is that app's own design, not platform behaviour.

How Make's web layer answers when an RPC ends with no result is decided outside the runtime. The form treats any answer that is not an array as no options.

## Which nested set is shown

A select can carry nested fields in several places. For each value Make shows one nested set: the first that exists in this order. The sets are never added together, so nothing shows twice.

| Order | Nested set | When it applies |
|---|---|---|
| 1 | A `nested` key on the select itself, beside `options` | A picked or mapped value, and a multiple select with nothing selected. For an empty single select an inline-array `nested` is hidden (measured with an inline array). |
| 2 | The `nested` of the option that matches the value | With inline options it is available at once. With RPC options it is known only after the RPC has answered. Both use the same rule: a select has one kind of store, so the nested set of an RPC store does not outrank that of an inline store. Only a `nested` key on the select itself ranks above it. |
| 3 | `options.nested` (next to `store`) | Any non-empty value, picked or mapped, when the matching option has no nested of its own. On a multiple select it also shows with nothing selected. |
| 4 | `options.placeholder.nested` | The fallback for any value that has no nested of its own and no `options.nested`: an empty value, a mapped value, and also a normally picked option that has no `nested`. |

Exceptions to the order:

- The empty choice of an optional select carries `placeholder.nested` as its own nested, so for an empty value `placeholder.nested` comes before `options.nested`.
- A `nested` key on the select itself still wins over `placeholder.nested` for an empty single select, although it is hidden there. Nothing shows then. Put the set for the empty value in `options.placeholder.nested` and not in a `nested` key on the select.
- A select restored in map mode gets its set as for an empty value (`placeholder.nested` first, then `options.nested`).
- Pick mode has no typed values: typing a formula is map mode.

When a per-option `nested` and `options.nested` both exist (single select), an option that has its own nested shows only that, and options without one show `options.nested`. The two are never both shown.

**An empty value in the module settings.** `options.nested` is hidden while the value is empty, whether it is an inline array or an RPC URL (in the second case the RPC is not called). Only `options.placeholder.nested`, as an array or an RPC URL, shows for the empty choice. A form outside the module settings can load an RPC-URL `options.nested` for an empty value.

**An optional parent whose children must always show** (for example an optional Tab select wrapping the rest of the form) needs the same spec in both `options.nested` and `options.placeholder.nested`, because of the rule above. Without `placeholder.nested` the children stay hidden until a value is picked.

```json
{
	"name": "tab",
	"type": "select",
	"label": "Tab",
	"options": {
		"store": [ { "label": "Main", "value": "main" }, { "label": "Other", "value": "other" } ],
		"nested": [ { "name": "range", "type": "text", "label": "Range" } ],
		"placeholder": {
			"label": "Empty",
			"nested": [ { "name": "range", "type": "text", "label": "Range" } ]
		}
	}
}
```

**Multiple selects.** A multiple select cannot have both `options.nested` and a `nested` on an option. The combination is rejected with an internal message that the user never sees, `Invalid configuration. It is not possible to define common nested and option nested together for multiple select or list.`, and the select shows no options at all (the saved value is lost). A `nested` on an option alone is accepted but never shown. On a multiple select only `options.nested`, `placeholder.nested` or a `nested` key on the select itself show fields, once for the whole selection.

**The value check.** When the value check of a select hands the nested parameters on, it passes only `options.nested`. A `nested` key on the select itself and the nested of the chosen option are not passed.

Two claims that circulate are wrong: store-level and per-option nested sets do not both render (the first match wins), and the store-level set does render for a mapped value.

Observed in the google-docs app: an optional `rpc://` select with no per-option nested did not render `options.nested` while the field was empty, and the Tab select that wraps the rest of the form there needed both sets. Observed: the answer of Make's documentation assistant (`?ask=`) that both sets render, and that the store-level set does not render for a mapped value, is wrong on both counts. When the form's behaviour matters, check it in the form itself, not with the documentation assistant.

The public `@makehq/forman-schema` library, which validates specs outside Make, is a separate implementation that takes the select's own `nested` or `options.nested` first and then lets the option's nested (or `placeholder.nested` for an empty value) replace it. Its order differs from the editor's order above; see [The public schema library checks differently](validation.md#the-public-schema-library-checks-differently).

## Mapped values and nested fields

A mapped formula matches no option, so a per-option `nested` never applies to it. The value gets `options.nested` or `options.placeholder.nested`, if either is set. In map mode the nested set is built once:

- A select restored in map mode gets its set as for an empty value (the order is in the exceptions under [Which nested set is shown](#which-nested-set-is-shown)) and shows it.
- A select the user switches from a picked option to map mode keeps the nested set of that option.
- Editing the formula afterwards does not rebuild the set.

The set is shown in its map form: selects in it whose options come from an RPC become plain mapped fields (their own nested fields are listed beside them), and selects with inline options stay selects.

A formula is opaque, so the fallback cannot know which option the user would have picked. A fallback set, whether an inline array or an RPC answer, must describe fields that suit any value: a generic or superset spec (for example all operators and a union of the accepted values), not a type-specific one.

## Reopening a saved module

When a saved module is reopened and the select can show its saved choice without calling the RPC (the saved state includes the label of the chosen option), the nested fields are built before the RPC options exist. In that moment:

| Store-level nested set | What shows |
|---|---|
| `options.nested` as an inline array | The array is rendered, even though the choice had its own nested fields saved with the module. The saved fields are ignored. |
| `options.nested` as an RPC URL, only `placeholder.nested`, or no store-level nested set | The nested fields saved with the module, as a refreshable set. With no saved set at all and no fallback, nothing shows until the options load. |

For an RPC store, prefer `options.placeholder.nested` (or an RPC-URL `options.nested`) over an inline-array `options.nested`: on reopen the array replaces the nested fields saved with the module. The reason is the reopen behaviour above, not that `placeholder.nested` applies only to a placeholder state (it shows for a picked option without a `nested` too, see [Which nested set is shown](#which-nested-set-is-shown)). For a mapped value both are shown the same way. For an inline store `options.nested` is fine, because the per-option nested matches at once and no gap exists in which the store-level set can win. This was reproduced for single selects.

Observed in the monday app: the first fix for nested fields that disappeared on a mapped value used `options.nested`, and QA then saw generic fields over saved type-specific data after a reopen; the fix switched to `placeholder.nested`. The mechanism above was reproduced, and the history itself was not checked.

## Nested fields for mapped values: the `placeholder.nested` recipe

Problem: nested fields disappear when the value is mapped or typed instead of selected. The recipe keeps the per-option `nested` that the RPC store returns for picked values, and adds an `options.placeholder.nested` that points to the same RPC with a mode flag.

```json
{
	"name": "columnId",
	"type": "select",
	"editable": true,
	"options": {
		"store": "rpc://RpcItemFields",
		"placeholder": {
			"label": " ",
			"nested": "rpc://RpcItemFields?mode=mapping"
		}
	}
}
```

`editable: true` is the old alias of `mappable: true` and still shows the Map switch. The blank `label` (`" "`) leaves the empty choice without text.

- The flag arrives in the RPC as the text `"mapping"`, together with the select value. Picked options still show their own nested set.
- The RPC branches on the flag: `"condition": "{{!parameters.mode}}"` for the store list with per-option `nested`, and `"condition": "{{parameters.mode === 'mapping'}}"` for a request that has no `url` and returns the generic nested spec. The mapping branch needs no `url` (see [Conditional RPCs](#conditional-rpcs)).
- The `placeholder.nested` RPC is used for more than mapped values. It is also loaded for the empty choice of an optional select and for every picked option that has no nested of its own, each time with `mode=mapping` and the current select value (`""` or the option value). Its generic field set must suit those cases too, or the select must be required and every option must carry its own nested.

Observed in the monday app: this recipe fixed nested fields that disappeared when a column was mapped or typed instead of selected.

## Paging and server-side search

`pagination` and `searchable` work only on selects whose options come from an RPC, and only while Make has the matching feature flag on (one flag for pagination, one for server-side search). An app cannot switch the flags. With a flag off the property is ignored, so do not rely on either in a custom app unless Make confirms the flag is on for it. Whether a flag is on for a given app or zone is decided by Make and cannot be read from the spec.

```json
{
	"name": "contactId",
	"type": "select",
	"label": "Contact",
	"options": "rpc://RpcContacts",
	"pagination": { "nextParam": "next" },
	"searchable": { "param": "query" }
}
```

- `nextParam` and `param` name the keys that carry the previous page token and the search text in the data sent to the options RPC. They default to `"next"` and `"query"`. The first request carries no token.
- Searching does not change the answer shape. With its flag off the select keeps the normal local search box.

The answer shape depends on the flag state, and the two shapes are not interchangeable:

| Pagination flag | The RPC must answer | If it answers the other shape |
|---|---|---|
| On | A single object `{ "items": [ ... ], "next": token }`. `items` is the page of options and `next` any token (page number, cursor, offset). | A plain array gives an empty list with the message `No data available.`. |
| Off, or the property ignored | A plain array | An `{ items, next }` object gives an empty list with no message. |

An RPC always collects `response.output` into an array, so an `{ items, next }` object built in `response.output` reaches the form as a one-item array and also gives `No data available.`. Build the envelope in `response.wrapper` (see [wrapper](../runtime-reference.md#wrapper)), as in this request item of an `api.imljson`:

```json
{
	"response": {
		"iterate": "{{body.data}}",
		"output": { "value": "{{item.id}}", "label": "{{item.name}}" },
		"wrapper": { "items": "{{output}}", "next": "{{body.next}}" }
	}
}
```

A `condition` `default` that is an `{ items, next }` object also reaches the form as that object.

This select paging is separate from the `pagination` directive of a request: see [pagination.md](../runtime-reference/pagination.md) for how the runtime pages one RPC call.

When more loads:

- The next page is requested only when the list overflows its scroll area, the user has scrolled, and the end of the list comes into view. A first page short enough to fit without scrolling never loads more (the height of the open list depends on the window).
- Loading more stops when `next` is empty (any falsy value, such as `""`, `0` or `null`) or a page has no items.

Search:

- A search sends the typed text after 500 ms without typing, cancels an unfinished request and starts again from the first page.
- The refresh button clears the search text and the page token.
- With `searchable` active the search box is shown even for short lists, except while the list has no options and no search is active.

The scroll rules were read from the form code and not run in a browser.

## Value checks for inline options

The value check treats a select as follows. The messages are quoted as written; `<label>` is the select's label, or its name when it has no label.

**Membership.** Unless the select is dynamic (options given by an RPC address, or `dynamic: true`), a value that is not one of the inline option values fails with `Value not found in options in parameter '<label>'.`.

- An empty inline option list rejects every value.
- For grouped options all group option values count.
- A select with `spec` converts the value with that type first.
- In the form a mapped value (an expression) is not checked against the options.
- `validate: false` does not skip the membership check in the value check; in the form it switches every check of the field off (see [validate: false, empty values and required](validation.md#validate-false-empty-values-and-required)).

| Option value | Single select | Multiple select |
|---|---|---|
| A number (`1`) | The number written as text matches: `"1"` matches the option `1` and the value is kept as given. Any text that starts with that number passes too (`"1abc"`). | Each item must equal an option value exactly, so `"1"` does not match the option `1`. |
| `0` | Matched only by the number `0`, not by the text `"0"`. | Exact match. |
| `false` | Matched by `false`. | Exact match. |

**Messages.**

| Situation | Message |
|---|---|
| A value is not one of the options (skipped with `dynamic: true` and for RPC options) | `Value not found in options in parameter '<label>'.` |
| A required select has no value | `Value must not be empty.` |
| A required multiple select has an empty list | `Missing value of required parameter '<label>'.` |
| Fewer items than `validate.minItems` | `Selected less than N items in parameter '<label>'.` |
| More items than `validate.maxItems` | `Selected more than N items in parameter '<label>'.` |
| `validate.unique` finds a repeated value | `This field contains duplicate values: a` (here `a` is the repeated value) |
| `validate.unique` with `{ "by": "label" }` finds a repeated label | `This field contains duplicate labels: X` |

The select label and the duplicate values filled into a message are HTML-escaped, so a label such as `Owner's list` appears as `Owner&#39;s list`. The rest of the select's messages and the order of the checks are in [Error messages](validation.md#error-messages) and [Item rules on arrays and multi-selects](validation.md#item-rules-on-arrays-and-multi-selects).

**The allowed-values list.** For a select with inline options, the check that the editor saves with the module is a list of the allowed values. It replaces the select's own `validate` settings: `minItems`, `maxItems` and `unique` of a multiple select are not saved with it. With a custom value key (`options.value`) the list holds `null` for each option instead of the values. No list is saved with `dynamic: true`, `validate: false`, RPC options or an empty option list. How the platform uses the list is not shown; see [The check saved with the module](validation.md#the-check-saved-with-the-module).
