# Parameters and Interface Reference

> Read when: writing or reviewing `expect.imljson`, `parameters.imljson` or `interface.imljson` (its fields use the same syntax): what a parameters array may hold, the properties every field takes and which types they apply to, the Map switch (`mappable`, `editable`, `mode`), the type list and its aliases, text, date and time extras, boolean and checkbox, collections and arrays, conditional fields (`nested`), and `required` inside arrays and collections. This file answers "is this parameter spec right?" and states what the module form shows and what Make's value check does. Validation details, select options and RPCs, and the output interface sit in `parameters-reference/` parts: open one only when its row in § Parts applies. Do not use a property that is not listed here or in a part.

## Scope

This reference states what a parameter spec does in the form Make shows and in the value check that the form and the back end share. "Form" means what the user fills in. "Value check" means the check Make applies to a complete value, for example the values saved with a module. A spec is the same JSON in `expect.imljson`, `parameters.imljson` and `interface.imljson`.

Terms used below:

- **Mapping form**: a form whose fields accept `{{...}}` mappings, such as the settings of a scenario module. A **form without mapping** takes plain values only.
- **Map switch**: the toggle on a field that moves it between pick mode (a control such as a dropdown or radio buttons) and map mode (a mapping box for `{{...}}` text). See [Which fields get a Map switch](#which-fields-get-a-map-switch-mappable-editable).
- **Text-like types**: `text`, `email`, `url`, `password`, `number`, `integer`, `uinteger`, `port`, `uuid`, `path`, `json`, `color`, `filename`, `buffer`, `timestamp` and `time`. In a mapping form these are always mapping boxes.

The module settings panel wraps the form and adds a display check of its own. Where the behaviour was measured there and differs, the text says "in the module settings". Behaviour is stated as of 2026-11-05; Make changes forms from time to time.

Which properties and values the platform's app compiler accepts, keeps or rejects in `expect`, `parameters` and `interface` JSON is decided by the platform, not by the form. For example, whether a `condition` or `editable` in a spec gives a compile error is not settled here. How the saved values reach `{{parameters.x}}` in `api.imljson` at run time is in [runtime-reference/iml-context.md](runtime-reference/iml-context.md#roots-in-modules-rpcs-and-endpoints).

## Parts (open every part whose trigger applies, skip the rest)

| Part | Open when |
|---|---|
| [parameters-reference/validation.md](parameters-reference/validation.md) | where values are checked, the `validate` keys by type, how values are converted, `pattern`, item rules on arrays and multi-selects, hints under a field, the verbatim error messages |
| [parameters-reference/select-and-rpc-options.md](parameters-reference/select-and-rpc-options.md) | a `select` or an options RPC: select and option properties, option sources, what an options RPC receives and returns, conditional RPCs, which nested set is shown, paging and search |
| [parameters-reference/interface.md](parameters-reference/interface.md) | `interface.imljson`, a dynamic interface via RPC, mapped values in an interface RPC |

The input and output schemas of an SDK Endpoint use the same spec language. Their checklist is in [endpoints-reference/forman-schemas.md](endpoints-reference/forman-schemas.md) and the effect of each property is in [endpoints-reference/schema-behaviour.md](endpoints-reference/schema-behaviour.md).

## What a parameters array holds

`expect.imljson` (the mappable parameters of a module) and `parameters.imljson` (static parameters, for example of a connection) use the same property names and are read by the same form code. What differs is the host form. A module's `expect` usually opens as a mapping form and a connection's `parameters` as a form without mapping, but which kind of form a screen is, is decided by the platform; the form only reads the flags it is given.

An entry of the array is one of:

| Entry | What it is |
|---|---|
| a field spec | `{ "name": ..., "type": ..., ... }` |
| a display-only entry | the types `banner`, `separator`, `html` and `markdown` |
| a container | `section` (with its own `spec`) and `tabs` |
| a plain string | an `rpc://` URL; the RPC's answer (an array of specs) is inserted in its place |

**IML in a spec.** `{{...}}` is evaluated only inside `rpc://` URLs: the `options` and `nested` of a field, a string entry in a parameter list, and the `rpc.url` of a text field.

- The whole URL is evaluated, the path as well as the query. `rpc://list{{kind}}Items` became `rpc://listItems` when `kind` had no value.
- `{{name}}` resolves to the value of a field the RPC-backed field is nested under (those values are also sent to the RPC as parameters automatically) and to the value of a field marked `isContext`. An `isContext` value is available only once that field is set up: an RPC called during the first build of the form did not see it, a later load did.
- A field's own value is not available in its own `options` URL.
- `{{parameters.x}}` and `{{connection.x}}` resolve to nothing.
- A variable that resolves to nothing becomes empty, and that query parameter is not sent.
- In `label`, `help`, `placeholder` and option labels `{{...}}` is shown literally. The one exception is the localisation form `{{l:key@namespace}}` in `label` and `help`, which Make's own forms use ([forman-schemas.md § Descriptions copied from vendor docs](endpoints-reference/forman-schemas.md#descriptions-copied-from-vendor-docs)).
- A `default` that contains `{{...}}` on a field that is a mapping box (text-like types, `date` and `time` in a mapping form) is kept as a mapping expression and shown as pills, not evaluated. On a `select` or `boolean` in pick mode such a default is dropped.

**`condition` is not read.** A `condition` property on a spec has no effect: the field is always shown (tested with `condition: false` and `condition: "{{normal}}"`). Use `nested` for conditional fields.

**Unknown properties are ignored.** The form shows no error and no warning for a property it does not read (a made-up property and a `condition` were both accepted and the field rendered normally). A typo in a property name therefore has no visible effect, so the rule "use only the properties listed" is sound advice.

Every property of this example is read by the form for a `text` field. `multiline` applies to text-like types only.

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

## Label, help, required and default

- `label` and `help` are rendered as a small Markdown subset: bold, italic, links that open in a new tab, code and line breaks. Without `label` the field shows its `name`. A required field gets an asterisk after the label.
- A `required` field with an empty value (empty string, `null`, `undefined`) fails with `Value must not be empty.`, whatever the type. `false` and `0` are not empty. A `select` with `multiple` and an empty list fails with `Missing value of required parameter '<label>'.` (the label falls back to the field name). The empty-value rules are in [validation.md](parameters-reference/validation.md#validate-false-empty-values-and-required).
- `default` is used when there is no saved value or the saved value is an empty string. A saved value wins over the default. Measured on a text field: a saved `null` does not bring the default back, the field is empty.
- `false` and `0` are valid defaults (`default: false` on a boolean gives `false`, `default: 0` on a number gives `0`).
- A required field that has a default passes the form's check with the default. The value check never fills a default into a missing value; see [schema-behaviour.md](endpoints-reference/schema-behaviour.md#required-default-and-empty-values).

## Which properties apply to which types

Not every property applies to every type. Each row says where the form reads the property. Whether a property appears in real apps' specs is something the form cannot show, so this table states only what the form does.

| Property | Applies to |
|---|---|
| `name`, `type`, `label`, `help`, `required`, `default` | all types |
| `advanced`, `omit`, `disabled`, `readonly`, `visible` | all types |
| `validate` (type-specific rules) | all types |
| `placeholder` | text-like types and `select`. `folder` and `file` show their own fixed placeholder; `date` and `boolean` ignore it |
| `mappable`, `editable` | types that have a Map switch. On `date`, the literal `mappable: false` also turns it into a plain picker |
| `mode` | only fields that have a Map switch |
| `dynamic` | `select` only |
| `multiline`, `rows` | text-like types. `multiline: true` breaks `email`, `url`, `number`, `integer`, `uinteger`, `port` and `time` in a form without mapping |
| `prefix`, `postfix`, `tags` | text-like types (the `tags` hint only on `text`) |
| `rpc` | text-like types and `array` |
| `time` | `date` |
| `innerLabel` | `checkbox` only |
| `semantic` | accepts only the prefix `file` |
| `labels` | `array` |
| `nested`, `reversedNested` | `boolean` (both), `select` and text-like types (`nested`), `array` (`nested`). Ignored on `checkbox` |
| `sequence` | `collection`. Nothing on an `array` |

## Hidden, locked and left-out fields

| Property | What the form shows | The key in the form value |
|---|---|---|
| `advanced: true` | hidden until the advanced switch is on | stays, with its value, while hidden |
| `visible: false` | hidden (only visually) | stays, with its value |
| `omit: true` | shown and editable | absent |
| `disabled: true` | shown, not editable; keeps its Map switch | absent |
| `readonly: true` | not editable, no Map switch | stays |

- A field hidden by `advanced` or `visible: false` is still validated. When the form is validated and a hidden advanced field is invalid, the form switches the advanced fields on so the error is visible. An empty hidden `required` field makes the form invalid although the user cannot see it.
- Use `advanced` for rarely needed options and `omit` for form-only helper fields whose value is not wanted in the parameters.
- The form's own panel labels the advanced switch "Advanced settings". The toggle in the scenario module settings is drawn by the platform, so its wording (for example "Show advanced settings") is the platform's.
- Whether the value of an `omit` or `disabled` field is absent from the parameters the module receives at run time is decided by the platform. The form leaves such a field out of the form value it saves. An `omit` field is still checked by the form: a required `omit` field left empty shows `Value must not be empty.` and fails the whole-form check.

## Placeholder, `validate: false` and `dynamic`

**`placeholder`** is the empty-state hint of a text-like field (also inside the mapping box) and of a `select`. A `select` also takes it from `options.placeholder`, a string or an object with `label`. `date` and `boolean` do not read it.

**`validate: false`** has two strengths.

- In the value check it switches off only the type's extra rules: text `min`, `max` and `pattern`, number `min` and `max`, color `format`, date `past`, boolean `const`, and `minItems`, `maxItems` and `unique` on an array or a multiple select. The type's own check still runs: a value that is not a valid email address, URL, number, integer, unsigned integer, port, color, filename, date, time or timestamp is still rejected. A `select` with a static `options` list still rejects a value that is not in the list (unless `dynamic: true`). `required` is still enforced (`Value must not be empty.`, or `Missing value of required parameter '<label>'.` for an empty multiple select).
- In the form shown to the user it is stronger: every check of that field is off, so an empty required field or a bad email shows no error there.
- A text field's `tags` handling still runs with `validate: false`.

Details are in [validation.md](parameters-reference/validation.md#validate-false-empty-values-and-required).

**`dynamic`** is read by `select` only. With `dynamic: true`, Make does not check that the value is one of the static `options` entries. Without it, a value outside the list is rejected with `Value not found in options in parameter '<label>'.` (the label falls back to the field name); see [select-and-rpc-options.md](parameters-reference/select-and-rpc-options.md#value-checks-for-inline-options). `dynamic` does not draw a refresh button. The "Refresh" action next to a field appears by itself when the field's nested fields are loaded from an `rpc://` URL (measured on `select`, `boolean` and text fields; a `readonly` field shows none). This is separate from the refresh icon that a select with RPC options shows while its dropdown is open, which is described in [select-and-rpc-options.md](parameters-reference/select-and-rpc-options.md#select-properties).

## File fields (`semantic`)

`semantic` groups fields. All fields whose `semantic` starts with `file` are shown together as one group titled "File". `file:name` marks the filename field and `file:data` the file content field.

- Where the host knows the file outputs of earlier modules, the group offers one radio option per such module that fills both fields at once, plus a "Map" option for manual entry. This part was read from the source and not tested.
- `file` is the only prefix the form knows. Any other prefix (for example `foo:bar`) makes the form show the error `Cannot read properties of undefined (reading 'label')` (the text comes from the browser's JavaScript engine and can differ between browsers), and the field is not rendered.
- It is not a hint for variable (pill) suggestions.

## Other properties the form reads

| Property | What the form does |
|---|---|
| `visible: false` | hides the field; the value stays in the form value |
| `isolated: true` | stops two fields with the same `name` from mirroring each other |
| `erasable: false` | removes the option to insert an erase value |
| `coderPlaceholder` | the placeholder of the mapping box in map mode |
| `autofocus` | focuses the field |
| `autocomplete` | sets the browser's autocomplete hint |
| `shadow` | a styling flag for nested collections |
| `innerLabel` | the label text of a `checkbox` (only) |

Two fields with the same `name` in the same form mirror each other's value and share one key in the form value, unless `isolated: true` is set on one of them.

These properties only change how the form looks or behaves in the browser. They are not part of the usual spec of a custom app. The form reads all of them, but whether the platform keeps them in an app's spec is decided by the platform. Do not add them unless you have confirmed them in an actual app.

## Which fields get a Map switch (`mappable`, `editable`)

`mappable` controls the Map switch, which exists only on types that have a pick/map pair.

| Type | Map switch |
|---|---|
| `select` and the select-based types such as `timezone`; `radio`, `boolean`, `checkbox`, `array`, `folder`, `file` (and some reference types such as `account`) | yes, when the form offers it (next table) |
| text-like types | never. In a mapping form they are always mapping boxes and `mappable: false` does not change that |
| `date` | never. In a mapping form it is a mapping box. Only the literal `mappable: false` replaces the box by a plain date-time picker field; `editable: false` and `mappable: { "enabled": false }` leave the box |
| `collection` | never. The fields inside carry their own switches |

Whether a switch shows at all also depends on the form:

| Form | `select` and select-based types | `radio`, `boolean`, `checkbox`, `array`, `folder`, `file` |
|---|---|---|
| form without mapping | only with `mappable: true`, `editable: true` or a `mappable` object | never |
| mapping form that does not turn mapping on by default | needs `mappable: true`, `editable: true` or a `mappable` object | needs the same |
| mapping form that turns mapping on by default | every field | every field |

- `mappable: false` removes the switch and the field stays in pick mode. So do `editable: false` and `mappable: { "enabled": false }` (but see the `date` row). When `mappable: false` and `editable: true` are both given, `mappable` wins.
- The object form is `{ "enabled": ..., "help": ..., "label": ... }`. `enabled` defaults to true when left out. `help` and `label` replace the field's help and label while the field is in map mode (see the next section).
- `mappable: true` gives a `select` its own Map switch even when the surrounding form does not offer mapping, for example in module parameters. Without the property the form decides.
- Inside the items of an array field, every field of a type that has a switch keeps it, whatever its own `mappable` says and also in a form without mapping (checked with `select`, `boolean`, `checkbox` and `radio`). `mappable: false` on the array itself removes only the switch of the whole array (see § Array properties).
- Which kind of form a screen is, and so the default for a field that does not set `mappable`, is decided by the platform. In the module settings the mapper fields (`expect`) usually have the switch and `parameters` fields do not.

**`editable`** is the old name of `mappable` and is marked deprecated.

- The form reads it the same way in every form: as a boolean or as an object with `enabled` and `help`. An `editable.label` is not used.
- For the Map switch, `mappable` wins when both are given. For the map-mode help the field uses `mappable.help` first and falls back to `editable.help`, so `mappable: true` together with `editable: { "help": "..." }` shows the `editable` help in map mode.
- The form gives it no connection-specific meaning. In a form without mapping, `editable: true` (like `mappable: true`) has a visible effect only on `select` and the select-based types such as `timezone`, which then show the Map switch. On other types it does nothing.
- The advice to use `editable` only in a connection's `parameters.imljson` is not something the form enforces. Any such rule would come from the platform.

## Start mode, map-mode help and label (`mode`, `mappable` object)

**`mode`** sets the state a field starts in.

| Value | Meaning |
|---|---|
| `"pick"` (also `"choose"`, `"chose"`) | pick mode, the default |
| `"map"` (also `"edit"`) | map mode: the mapping box (formula editor) shows first |

- The legacy spellings work on every type that has a Map switch. `"edit"` is not special to `select` and does not mean an editable or typeahead select.
- Values are case sensitive. On a field that has a Map switch, any other value (`"MAP"`, `"Map"`, `"foo"`) shows the error `Invalid mode 'MAP'.` in an error banner above the form. The field is still shown, in pick mode, and the other fields render normally. On a field without a Map switch such a value is ignored (next bullet).
- `mode` is ignored, without an error, on fields that have no Map switch: text-like types, `date`, `time`, `collection`, `readonly` fields and any field whose switch is not shown in that form. A `select` marked `mappable: true` in a form without mapping does have the switch, so `mode` applies there.
- When a saved module is reopened, the mode saved with it wins over the spec.

**The `mappable` object.** Besides `enabled` (which decides whether the Map switch is there), only two keys are used: `help` and `label`. While the field is in map mode they replace the field's help and label. Every other key (`placeholder`, `required`, `default` and so on) is ignored, and a blank `label` is ignored. No other spec property is overridden in map mode.

- The object matters only on fields that have a Map switch. Text-like fields, `date`, `time` and `collection` never enter map mode, so its help and label are never shown there.
- The `label` override works on `select`, `radio`, `boolean`, `checkbox` and `array`. On `folder` and `file` the label is never replaced, and the map help appears only after the user switches to map mode, not when the field starts in map mode.
- The base `help` is shown while the field is in pick mode. `mappable.help` is shown only in map mode, and the base help returns when the user switches back.

This shows different guidance for the dropdown and for the mapping box of an RPC-backed multiple select (the dropdown lists field names, mapping mode accepts aggregate expressions such as `MAX(Age) MaxAge`):

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

## Type list and unknown types

All of these types are known to the form:

`text`, `number`, `integer`, `uinteger`, `boolean`, `date`, `select`, `collection`, `array`, `email`, `url`, `json`, `password`, `hidden`, `buffer`, `filename`, `color`, `filter`, `file`, `folder`, `uuid`, `time`, `timestamp`, `timezone`, `port`, `path`, `cert`, `pkey`

- `timezone` is a `select` whose list of time zones comes from the platform (value = time zone code, label = name). The others render as their own input.
- The form knows further types: `checkbox`, `any`, `radio`, `range`, `editor`, `sort`, `upload`, `udt`, `udtspec`, `udttype`, `dynamiccollection`, `list`, `tokens`, `account`, `hook`, `device`, `keychain`, `datastore`, `agent` and `aiagent`, `scenario`, `filestorage`, `mergearray`, and the select-based `country`, `language`, `locale`, `localization`, `imtregion`, `userapitokenscope` and `usersorganizationsrole`. Also the display-only `banner`, `separator`, `html` and `markdown`, and the containers `section` and `tabs`.
- A type the form does not know (for example `float`, `string`, `bool`, `int`, `datetime`, `textarea`, `multiselect`) shows the error `Unknown type '<type>'.` in an error banner. Neither that field nor any field after it in the same list is rendered; the fields before it are.
- A spec with no `type` is rendered as `text` (the form logs a warning that the fallback may be removed).
- Type names are not case sensitive when the form renders (`TEXT` renders as text, `Number` as number). The value check uses the type as written, so a capitalised type gets no type checks, only `required`, and the value check returns no value for it (see [schema-behaviour.md § Type list and unknown types](endpoints-reference/schema-behaviour.md#type-list-and-unknown-types)).
- Which of these types an app spec may use is decided by the platform, not by the form.

## Aliases and platform-supplied lists

| Alias | Resolves to | Notes |
|---|---|---|
| `checkbox` | validated as `boolean` (same value rules) | has its own control, a single tick box; see [Boolean and checkbox](#boolean-and-checkbox) |
| `uuid` | `text` | renders as a plain text field and is validated exactly like `text` (min, max, pattern, tags). There is no UUID format check, so add `validate.pattern` if you need one |
| `path` | `text` | no path check beyond the text rules |

`timezone`, `country`, `language`, `locale`, `localization` and `imtregion` are `select` fields whose list the platform supplies, so no `options` are needed. `timezone` stores the time zone code. `userapitokenscope` is the same with multiple values, and `usersorganizationsrole` lists organization roles.

## Text field extras

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

The form reads every property of this example. `rows: 5` has no effect while `multiline` is false.

- **`multiline` and `rows`.** `multiline: true` makes the field multi-line and `rows` sets its visible height, limited to 30 rows. A numeric string such as `"7"` works. `rows` without `multiline: true`, or a value that is not a positive number, is ignored. In a mapping form (the scenario module form) the multi-line field is the mapping box sized by `rows`, not a plain textarea. A plain textarea appears only in a form without mapping. Observed: `rows` is rare in the custom apps reviewed.
- **Use `multiline` on `text`** (it is also fine on `uuid`, `path` and `password`). On `email`, `url`, `number`, `integer`, `uinteger`, `port` and `time`, `multiline: true` in a form without mapping shows the error `Cannot set property type of [object HTMLTextAreaElement] which has only a getter` (the text comes from the browser's JavaScript engine and can differ between browsers) and the field has no input box. In a mapping form it works.
- **`prefix` and `postfix`** are fixed, non-editable texts shown before and after the input, in plain and in mapping-capable text fields (URL-style fields).
- **`tags`.** `strip` removes HTML tags, `stripall` removes tags and any remaining `<` and `>`, and `escape` turns `&`, `<` and `>` into HTML entities (`a & <b>` becomes `a &amp; &lt;b&gt;`). It runs when the value is validated, also with `validate: false`, and also on other text-like types such as `email`. Only on type `text` does the form show a hint under the field: `All HTML tags will be automatically removed.` (for `strip` and `stripall`) or `All HTML tags will be automatically escaped.` (for `escape`).
- **`password`.** In a form without mapping it is masked and has a show/hide button; with `multiline: true` it is a plain multi-line box with neither. In a mapping form a `password` field is a mapping box that shows its value unmasked, with or without `multiline`.
- **Whitespace.** Every text-like type except `text` (`email`, `url`, `password`, `uuid`, `path`, the number types and the others) trims leading and trailing whitespace from the value in the form value. `text` keeps it.

## Search button on a text field (`rpc`)

A text field with `rpc` shows a button whose text is `rpc.label` (not always "Search"). It opens a remote sub-form whose result populates the field. This example is valid:

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

- Clicking the button opens a panel titled with that label, with the fields of `rpc.parameters` and the buttons "Close" and "OK".
- "OK" (after the panel's fields validate) calls `rpc.url` with the panel's values plus the values of the fields the text field is nested under. The RPC must answer an array of `{ "label": ..., "value": ... }`.
- One result is applied at once and the panel closes. Several results are listed as buttons (the label, else the value) to choose from. The chosen `value` becomes the field's value.
- An empty array shows `No matches found.` An answer that is not an array shows `Invalid response.`
- The button is also available on other text-like types (`email`, `url`, `password`, `number` and so on) and on `array` (where it adds an item).
- `rpc.immediate: true` skips the panel and calls the RPC straight away. The answer must be exactly one item with a value, else the field shows `Invalid response.` With it, `rpc.copyResult: true` copies the value to the clipboard (on failure: `The value was created but could not be copied. Copy it from the field.`), and `rpc.buttonOnly: true` together with both of those hides the text box.

The button, the panel, the parameter field, "OK", one, several and no results, and a non-array answer were run. `immediate`, `copyResult` and `buttonOnly` were read from the source and not run.

## Date and time fields

- **`time: false`** gives a date-only picker with no clock, also in the picker of the mapping panel, and the format hint then shows only the date part. With it, a plain `date` field (in a form without mapping, or with `mappable: false`) stores midnight of the chosen day in the form's time zone, and a saved value that has a time is cut to midnight when the form is opened (`2030-01-02T10:20:00Z` came back as `2030-01-02T00:00:00.000Z`). A value that arrives by mapping keeps its time part. `time` is read only by `date`; without `time: false` the picker has a clock.
- **`validate: { "past": false }`** rejects a date earlier than the current moment with `Field contains date in past.` A date-only value for today is also rejected, because it counts as midnight. `past: true` or no `past` accepts past dates. See [validation.md](parameters-reference/validation.md#validate-keys-by-type).
- **`mappable: false`** on a `date` field gives a plain date-time picker field without mapping. On a `time` field it has no effect on the control: in a mapping form `time` stays a mapping-capable box, and only the format hint changes to the locale's time format instead of `HH:mm`.
- **Mapping panel and hints.** In a mapping form the mapping panel of every mapping box has a date tab with a picker: a time picker for a `time` field, a date-only picker for a `date` field with `time: false`, otherwise a date and time picker. The hint under a mapping-capable date field reads `For more information about supported date formats, see the online Help.` Under a plain `date` it shows the locale format (`Format: MM/DD/YYYY h:mm A`, without the time part when `time: false`). Both show the time zone.

How mapped date and time text is read and converted is in [validation.md](parameters-reference/validation.md#how-values-are-converted-and-type-checked).

## Boolean and checkbox

| | `boolean` | `checkbox` |
|---|---|---|
| Control in pick mode | radio buttons | one tick box |
| Choices | optional: `Yes`, `No`, `Empty`. Required: `Yes`, `No` | ticked or unticked; the label is `Yes` or `innerLabel` |
| Start, with no default or saved value | optional: `Empty`, so no value and the key is absent from the form value. Required: `No`, so the value is `false`, never empty | unticked; the value is `false` and the key is present |
| `required: true` | removes `Empty`. It does not turn the radio buttons into a tick box | does not force a tick: unticked (`false`) passes the required check |
| Map switch | as in [Which fields get a Map switch](#which-fields-get-a-map-switch-mappable-editable) | the same. In map mode it is a mapping box, so it is not always a tick box. Add `mappable: false` to keep it a tick box in a mapping form |
| `nested` | shows conditional groups (see [Conditional fields on a boolean](#conditional-fields-on-a-boolean-nested)) | never shows any; `nested` and `reversedNested` are ignored |
| Value check | the rules below | validated like `boolean` |

- Use `checkbox` for a single tick box whose value is always `true` or `false` in pick mode. Use `boolean` when a conditional group depends on the value.
- The public developer page says `required: true` turns a boolean's radio buttons into a checkbox. The form keeps the radio buttons (a different build of the host, or an older page text, cannot be ruled out). Only `type: checkbox` gives a tick box.
- The `Yes`, `No` and `Empty` choices are the same in every kind of form. Only the Map switch, and so map mode, depends on the kind of form (see [Which fields get a Map switch](#which-fields-get-a-map-switch-mappable-editable)); which kind the scenario module form is, is decided by the platform.

**How a value becomes true or false.** This holds for typed and for mapped values:

- `true` and `false` pass through. The exact string `"false"` is `false`.
- Every other non-empty value is `true`: the strings `"true"`, `"FALSE"`, `"0"` and `"no"`, every number (including `0`), `{}` and `[]`.
- `null` and an empty string are no value. A `required` boolean with such a value fails with `Value must not be empty.`

## Collections

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

- `spec` is an array of field specs in the normal parameter syntax (`name`, `type`, `label` and any other property). The value is one object with one key per spec field. The fields of any conditional (`nested`) group that is currently shown are keys of the same object, next to the field that triggers them.
- A collection has no Map switch of its own, so it cannot be mapped as one value. The fields inside carry their own switches.
- **Value check.** A text, number, list or date given as the collection value fails with `Invalid collection.` `null` or an empty string gives no value. Each spec field is cast to its type, and a wrong value fails with the field's message (for example `Invalid number.`). A spec field missing from the value is not a failure and stays absent, unless it is `required`: then it fails with `Value must not be empty.` Keys that are not in the spec pass through untouched. Only the strict variant of the check (whether and where the platform turns it on is the platform's decision, see [Where values are checked](parameters-reference/validation.md#where-values-are-checked)) rejects them with `Unexpected parameter '<key>' found.`
- **`required` on the collection itself** fails only a missing, `null` or empty-string value (`Value must not be empty.`). An empty object `{}` passes.
- **`sequence: true`** means the object's keys keep the order of `spec`. The public developer page says "the object's properties keep the order they have in spec", and the data structure editor labels it "Preserve the order of object keys". The flag is passed on in the check saved with the module (see [validation.md](parameters-reference/validation.md#the-check-saved-with-the-module)). In the shared value check, though, the `sequence` branch returns an empty object `{}` for a non-empty collection, so the declared order cannot be demonstrated from the check. Whether the platform uses that result is decided outside the parameter form. Treat `sequence` on a collection as declared intent and verify the output order in a test run.
- **A `spec` given as an RPC URL** (on a collection or an array) is called once, when the form is built. The request data holds only the query parameters written in the URL (`rpc://name?x=1` sends `{ "x": "1" }`). Other parameter values are not sent, and the RPC is not called again when another field changes. The URL may use IML context values (team, organization and scenario ids, fields marked `isContext`), but an `isContext` field of the same form is not reliably in the context yet when this RPC runs (in a test run `{{field}}` resolved to empty). A conditional `nested` RPC does not help with siblings either: it receives only the value of its trigger field and of the fields it is nested under.

## Array item specs

The `spec` of an array can take these forms:

| `spec` | Items |
|---|---|
| a single field object, `{ "type": "text", "label": "Tag" }` | primitive items. Its `name` is ignored (replaced by a fixed key) and its `label` becomes the item label |
| a list of fields, `[ ... ]` | each item is an object with those fields (a "complex array") |
| a single collection description, `{ "type": "collection", "spec": [ ... ] }` | each item is an object with those fields; the value check also checks the item fields (see [`required` inside arrays and collections](#required-inside-arrays-and-collections)) |
| `[]` or no `spec` | text items; the form value is a list of texts. The value check turns each item of a `[]`-spec array into `{ "value": item }`, keeping items that already are plain objects (a non-plain object such as a date is wrapped too) |
| an `rpc://` URL string | the spec is loaded by that RPC when the form is built (see [Collections](#collections)) |

Prefer an explicit `{ "type": "text" }` over leaving `spec` out.

```json
{
	"name": "tags",
	"type": "array",
	"label": "Tags",
	"spec": { "type": "text", "label": "Tag" }
}
```

## Array properties

| Property | What it does |
|---|---|
| `labels` | `labels.add` sets the add button text (default `Add item`); `labels.item` sets the item label (default `Item`) |
| `validate` | `minItems`, `maxItems`, `unique`, with the messages below |
| `rpc` | a second button that adds one item for the result the user picks from a remote search sub-form |
| `mappable` | `false` removes the Map switch of the whole array only |
| `nested` | a conditional group, shown once the array has an item |
| `sequence` | no effect on an array |

```json
{
	"name": "attendees",
	"type": "array",
	"label": "Attendees",
	"labels": { "add": "Add attendee" },
	"spec": { "type": "email", "label": "Attendee" }
}
```

This example is valid: one `email` item per row, the add button reads `Add attendee` and the items read `Attendee 1`, `Attendee 2`.

**`labels`.** Make appends the item's 1-based number to the item label, so the user sees `Attendee 1`, `Attendee 2`. For a primitive array, a `label` inside the spec object takes precedence over `labels.item`. Item labels are renumbered after a removal but not after a drag: after the first of three items is moved to the end, the labels read `Item 2`, `Item 3`, `Item 1` until an item is removed. Only `labels.add` is on the public developer page.

**Reordering.** Array items can always be reordered with a drag handle and removed with a remove button, whatever the properties say.

**`validate`.** An array accepts `minItems`, `maxItems` and `unique`. The messages, in English, are:

- `Array has less than <N> items.`
- `Array has more than <N> items.`
- `This field contains duplicate values: <list>` (for `unique: true`)
- `This field contains duplicate values for '<field label>': <list>` (for `unique: { "by": "<fieldName>" }`; the label falls back to the field name, and it is always the field name when the item `spec` is a single collection description; see [validation.md](parameters-reference/validation.md#error-messages))

Special characters in the listed values are shown HTML-escaped: a duplicate `a&b` reads `a&amp;b`, and a duplicate object is listed as JSON with `&quot;` around keys. `validate: false` switches all three rules off. An empty list fails `minItems`; a missing, `null` or empty-string value skips the item-count checks. `validate.enum`, listed on the public developer page, is not enforced: not by the form, not by the value check and not by the public `@makehq/forman-schema` library. Check an allowed-values list in `api.imljson`. The other item rules are in [validation.md](parameters-reference/validation.md#item-rules-on-arrays-and-multi-selects).

**`rpc` button.**

- It adds a second button, labelled with `rpc.label`, next to the add button. A click opens a panel with a form built from `rpc.parameters`. "OK" calls the RPC `url` with the panel's form values, plus the values of the fields the array is nested under and any data the hosting page adds. The module's other top-level parameters are not sent.
- The RPC must answer a list of `{ "label": "...", "value": ... }` (a missing label shows the value). One hit is added at once. Several hits are listed, and the clicked one adds one item with its `value`.
- A non-list answer shows `Invalid response.` and an empty list shows `No matches found.`; nothing is added.
- With `"immediate": true` in `rpc` no panel opens: the RPC is called at once (same data, without panel values) and must answer exactly one item with a non-null `value`, otherwise the field shows `Invalid response.`

**`mappable: false`** on an array removes the Map switch of the whole array, so the array cannot be mapped as a single value. Items stay individually mappable: a text item still takes `{{...}}`, and a boolean item, or a boolean inside a complex item, keeps its own switch.

**`nested`.** An array can have its own `nested` group. It is shown as soon as the array has at least one item (hidden for an empty array), and its fields are siblings of the array in the parameters object.

**`sequence`** does nothing on an array. Every item has a drag handle and a remove button with or without it. `sequence` is a collection property (see [Collections](#collections)). Do not put it on the item collection of an array as a fix for item order: the order it promises cannot be confirmed, and the value check returns a collection with `sequence: true` as an empty object `{}`.

## `required` inside arrays and collections

The difference lies in the value check that Make applies to a value (shared by the form and the back end; see [where values are checked](parameters-reference/validation.md#where-values-are-checked)), not in the form. The form shows each row of an array with its own child fields and checks every shown child field by itself.

| Container | In the form | In the value check |
|---|---|---|
| a collection (a parameter of its own) | a required child left empty shows `Value must not be empty.` | a required child is enforced: a missing, `null` or empty child fails with `Value must not be empty.` |
| a collection inside a collection | the same, for the children of the inner collection too | enforced, children of the inner collection included |
| an array with a single field spec, `"spec": { "type": "email", "required": true }` | each item checks itself | every item is checked, `required`, rules and type included: `[null]` and `[""]` fail with `Value must not be empty.` |
| an array with a single collection description, `"spec": { "type": "collection", "spec": [ ... ] }` | each shown child checks itself | every child is checked (type, `required`, rules), also with `validate: false` on the array. An array of this kind inside a collection is checked the same way |
| an array with a list of fields, `"spec": [ ... ]` (complex array) | each shown child checks itself, so a required child is flagged and the check of the whole form fails | no child rule is checked |

For the complex array in the value check:

- Every child-level rule is skipped: `required`, `min`, `max`, `pattern`, the number and email formats, select membership and the child type check. The child values are not converted either. `[{"childParam": null}]` passes with a required child, and a child of the wrong type is accepted.
- Nothing inside a row is checked, including a collection or array that sits in the row.
- The only row checks left, when the spec is not empty: a row that is text, a number or a boolean fails with `Array of objects expected.`; a row that is a list or a date fails with `Invalid collection.`; a `null` row passes.
- In the strict variant of the check, every key of every row is reported as `Unexpected parameter '<key>' found.`, because no child field is known.
- The form is stricter than the value check here: a required child of a complex array row is flagged in the form and makes the whole-form check fail even though the value check accepts the same value. Whether the page that hosts the form then refuses to save is up to that page.

The three cases, as the value check sees them:

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

```json
{
	"name": "arrayParam",
	"type": "array",
	"spec": [
		{ "name": "childParam", "type": "text", "required": true }
	]
}
// Submitting {"arrayParam": [{"childParam": null}]} → passes the value check (the form still flags it)
```

```json
{
	"name": "emails",
	"type": "array",
	"spec": { "type": "email", "required": true }
}
// Submitting {"emails": [null]} → validation error
```

**`required` on the array or collection itself** fails only a missing, `null` or empty-string value. An empty list `[]` or an empty object `{}` passes the value check. In the form, an empty required list shows `Field must not be empty.` In the value check, `minItems` fails `[]` but not a missing value.

**Mechanism.** For a complex array the check hands the list of child fields to the collection check in the place where that check expects a collection description. The collection check finds no child list and checks no child. This is observed behaviour of the shared value check, not of the form. Nothing shows that the skip is intended; only the maintainers can say whether it is deliberate. Treat it as behaviour that may change.

**Likely reason (a platform note: nothing settles it).** A collection is a fixed object the user fills in explicitly, so checking its children is natural. An array is dynamic and its items are often filled by mapping from earlier modules, so checking `required` on every child could fail when mapped values resolve to `null` at run time.

**How to get strict child checks.**

- Describe each item as a single collection (`"spec": { "type": "collection", "spec": [ ...fields ] }`). The value check then checks every child, `required` included. This also covers values that do not pass through the form's own fields, such as a mapped array.
- `api.response.valid` is no substitute: it runs after the request has been made and judges the response, so it cannot stop a call built from invalid input ([valid](runtime-reference.md#valid)). `condition` skips the call silently and raises no error; what the module returns instead (the `default` of the `condition` object, else the previous item's result, else nothing, and never `false`) is in [condition](runtime-reference.md#condition).
- Or check the values while the request is being built, for example in a custom IML function that throws. Whether such an error reaches the user as a clear message is decided by the runtime, not by the parameter spec; see [custom functions](runtime-reference/iml-context.md#time-memory-and-errors-in-custom-functions).

## Conditional fields on a boolean (`nested`)

`boolean` can reveal nested fields based on its value, with a group for each of the true and false branches. The `{ "store": [...] }` form that `select` accepts is not understood by `boolean`. A `checkbox` cannot do this: `nested` and `reversedNested` on a `checkbox` are ignored and nothing is ever shown. Use `boolean` whenever a group depends on the value.

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

What the form shows, by the form of `nested` and the state of the boolean ("Empty" is an optional boolean that has no value; a required boolean starts at `No` and is never Empty):

| `nested` | `reversedNested` | Value `true` | Value `false` | Empty | Map mode |
|---|---|---|---|---|---|
| `[ ...fields ]` | absent or false | the fields | nothing | nothing | the fields |
| `[ ...fields ]` | `true` | nothing | the fields | nothing | the fields |
| `"rpc://..."` | absent or false | the RPC's fields | nothing | the RPC's fields | the RPC's fields |
| `"rpc://..."` | `true` | nothing | the RPC's fields | the RPC's fields | the RPC's fields |
| `{ "true": X, "false": Y }` | ignored | X | Y | nothing | nothing |
| `{ "true": X }` only | ignored | X | nothing | X, only when it is an `rpc://` URL | X |
| `{ "false": Y }` only | ignored | nothing | Y | Y, only when it is an `rpc://` URL | Y |
| `{ "store": [...] }` | ignored | nothing | nothing | nothing | nothing |

- Each branch of the object form is a list of fields or an `rpc://` URL string. Either branch may be left out, and keys other than `true` and `false` are ignored.
- Map mode means the boolean's value is an IML text such as `{{1.flag}}`. The group cannot follow the value then: one defined branch (or the single `nested`, with or without `reversedNested`) is shown, and two defined branches show nothing. A boolean with no `nested` shows nothing.
- The nested field values are flat siblings of the boolean in the parameters object (`parameters.fileName`, not `parameters.addImage.fileName`).
- A hidden branch is neither validated nor submitted: an empty required field in the inactive branch does not fail the form check. Values typed in a branch stay in the form and come back when the user switches back.
- An RPC branch is fetched the first time it is shown for a value, and the answer is reused when the user returns to that value. The request carries the boolean's own value (left out while the boolean is Empty) and the values of the fields it is nested under. For a boolean inside a collection that is the whole collection object, including the other fields of that collection. Parameters next to the boolean at the top level are not sent.
- The group is built only while the boolean's own value passes its checks: a boolean with a failing `validate.const` or `required` does not reveal its nested fields. This part was read from the source and not tested.
- The value check reads the `{ "store": [...] }` form differently from the form: there `store` is read, and its fields are checked when the value is true.
- When the group must follow the value strictly, use a field list or the object form with both branches, or make the boolean `required` (it then starts at `No` and is never Empty).

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

The `notify` example (an `email` branch for true and a `reason` branch for false) is valid and works as written. `reversedNested` and the `{ "true": ..., "false": ... }` form work as the table says (verified by running the form). They are not on the public developer page for boolean, which lists `nested` only as an array, a string (an `rpc://` URL) or an unspecified object. Only `boolean` supports them. The form cannot show how common each form is in real apps; check the form in the editor before relying on the less usual ones.

## Conditional fields on text and other types

`text` and the other text-like types (`email`, `url`, `number`, `integer`, `password`, `filename` and the rest) show `nested` whenever the value is not empty and passes the field's own checks.

- Any non-empty string (even a single space) or number (even `0`) shows the group. An empty value hides it.
- A value that fails the field's validation hides it too, for example an invalid email address or a text longer than `validate.max`. With `validate: false` the form's checks of the field are off, so the group shows for such a value as well.

For an array with `nested` see [Array properties](#array-properties). For a `select` see [select-and-rpc-options.md](parameters-reference/select-and-rpc-options.md#which-nested-set-is-shown).
