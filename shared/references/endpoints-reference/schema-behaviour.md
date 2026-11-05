# SDK Endpoints reference: how Make treats a schema

> Read when: you need the exact effect of a property or type in `input_parameters` / `output_parameters`: what a form Make shows does with it, what Make's value check does (conversion, rules and the verbatim messages), and what the public `@makehq/forman-schema` converter and validator do, where the three disagree. The checklist that uses these facts is [forman-schemas.md](forman-schemas.md). Part of [endpoints-reference.md](../endpoints-reference.md).

## Three checks that can disagree

Three pieces of Make read a parameter spec. They share the property names but not the rules, so a reviewer has to know which one produced a message.

| Check | What it is | What it does with a value |
|---|---|---|
| Make's form | The form Make draws from a spec (the module settings, the form that runs an Endpoint). | Shows the fields, collects the values and shows the value check's message under a field that fails. |
| Make's value check | The code that converts a value to the declared type and applies `required`, `validate` and the options. The form and Make's server side use the same code. | Coerces loosely (the text `'5'` becomes the number 5) and has its own messages, such as `Invalid number.` |
| The public library [`@makehq/forman-schema`](https://github.com/integromat/make-forman-schema) | Two separate tools: a converter (spec to JSON Schema) and a validator (checks a value against a spec). | The validator is strict about JSON types, checks no formats and has messages of its own. |

The public validator reports these messages, which Make's value check never gives:

- `Field is mandatory.`
- `Expected type 'number', got type 'string'.`
- `Value 'z' not found in options.`
- `Value is not an array.`
- `Value contains prohibited IML expression.`
- `Unknown field 'z'.` (only when the caller asks for a strict check)
- `Value must be one of the following: a, b` (for `validate.enum`)
- `Selected less than N items.` and `Selected more than N items.` (a multi-select, without the parameter name)

It also checks `validate.min`, `validate.max`, `minItems` and `maxItems`, and for those it uses Make's wording (`Value must be at least N characters long.`, `Value is too small. Minimum value is N.`, `Array has less than N items.`), so those messages do not show which check produced them.

It checks no formats for `email`, `url`, `date` and `uuid`. It rejects text that contains `{{...}}` unless the caller allows dynamic values, which is off by default. Two per-property effects follow: `mappable: false` keeps that rejection even when dynamic values are allowed, and `dynamic` on a select is ignored (details in [§ Form-only properties](#form-only-properties) and [§ Select options](#select-options)).

Examples of the same value judged differently:

| Spec and value | Make's value check | Public validator |
|---|---|---|
| `number`, the text `'5'` | converts it to 5 | `Expected type 'number', got type 'string'.` |
| `text`, the number 5 | converts it to the text `'5'` | `Expected type 'string', got type 'number'.` |
| `boolean`, the text `'true'` | converts it to true | `Expected type 'boolean', got type 'string'.` |
| `email`, the text `abc` | `Value is not a valid email address.` | passes |
| `select` with `multiple: true`, the text `'a'` | wraps it into the list `['a']` | `Value is not an array.` |
| `text`, the text `'{{1.x}}'` | passes as ordinary text | `Value contains prohibited IML expression.` unless dynamic values are allowed |
| required `text`, an empty text | `Value must not be empty.` | `Field is mandatory.` |

Which of these checks an Endpoint call goes through is decided by the platform, not by the form library. [forman-schemas.md § How Make reads an Endpoint schema](forman-schemas.md#how-make-reads-an-endpoint-schema) says what an Endpoint author can rely on. Where each check runs for a module is in [parameters-reference/validation.md § Where values are checked](../parameters-reference/validation.md#where-values-are-checked), and the public library's other differences are in [§ The public schema library checks differently](../parameters-reference/validation.md#the-public-schema-library-checks-differently).

## `required`, `default` and empty values

**What `required` fails in Make's value check.** A required parameter fails with `Value must not be empty.` only when its value is missing (null or undefined), an empty text or, in a browser, an empty selection of files. Everything else counts as present and passes: the text `' '` (one space), the number 0, `false`, an empty list `[]` and an empty object `{}`. For a required `text`:

| Value | Result |
|---|---|
| missing, `null`, `""` | fails with `Value must not be empty.` |
| `" "` | passes, stays one space |
| `0` | passes, becomes `"0"` |
| `false` | passes, becomes `"false"` |
| `[]` | passes, becomes an empty text |
| `{}` | passes, becomes `"{}"` |

Exceptions:

- A required multi-select given an empty list fails with `Missing value of required parameter 'Pick'.` The quoted name is the label, or the name when there is no label. A missing or null value still gives `Value must not be empty.`
- In Make's form, a required array with no items shows `Field must not be empty.`
- To demand at least one array item in the value check, add `validate: { minItems: 1 }`. A required array given `[]` then fails with `Array has less than 1 items.`

The public validator reports `Field is mandatory.` for a missing, null or empty-text value. It counts 0, `false` and an empty list as present, but they can still fail its type check: `0` on a `text` gives `Expected type 'string', got type 'number'.`

**`default`.** Make's value check never applies `default`. A missing value stays missing (the result is undefined) even when the spec has a `default`, and a required parameter with a default and no value still fails. In a form, `default` is the initial value.

The public converter writes `default` as the JSON Schema `default` only for plain types (text-like types, numbers, boolean, date), and not when the default is an empty text or null. It never writes the `default` of a select, an array or a collection:

- A non-required select always gets `default: ""`, even when the spec sets another default.
- A required select gets no default.

**Empty values.** What the value check returns for an empty value of an optional parameter:

| Value received | Result |
|---|---|
| an empty text, for `text`, `any` or `hidden` | dropped (the result is undefined) |
| an empty text, for every other type (numbers, booleans, dates, selects, arrays, collections) | null |
| null or undefined | stays as it is |

A caller can switch the check's `passthrough` option off (which options Make passes is the platform's decision, see [parameters-reference/validation.md § Where values are checked](../parameters-reference/validation.md#where-values-are-checked)). An empty text then becomes null for every type, including `text`, `any` and `hidden`, while null and undefined still stay as they are. An empty optional `text` also skips `min`, `max` and `pattern`. What a template reads for a parameter the person left empty is a separate matter, described in [runtime-reference.md § Missing values](../runtime-reference.md#missing-values).

**A child's `required` inside a collection.** It is checked only when the collection value is present:

- An absent, null or empty-text collection skips all of its children, in Make's value check and in the public validator.
- An empty object `{}` triggers the child's `required` error.
- The public converter writes the child's `required` inside the collection's own schema, which says the same: required when the object is given.
- Make's form is different. It always shows and validates every child of a collection, so a required child inside an optional collection forces the person to fill it.

The form and value check rules for every container are in [parameters-reference.md § `required` inside arrays and collections](../parameters-reference.md#required-inside-arrays-and-collections), and what `validate: false` changes is in [parameters-reference/validation.md § `validate: false`, empty values and `required`](../parameters-reference/validation.md#validate-false-empty-values-and-required).

**How each kept property is converted.**

| Property | Make's form and value check | Public converter |
|---|---|---|
| `required` | fails an empty value (see above) | adds the name to the parent's `required` list |
| `default` | initial value in a form; the value check never substitutes it for a missing value | `default`, for plain types only (not an empty-text or null default); never for selects, arrays or collections |
| `help`, `label` | shown in the form | `description` and `title` |
| `options` | the list of allowed values | `enum`, or `oneOf` with titles when options have labels or nested fields |
| `nested` | extra fields (see [§ Nested fields](#nested-fields)) | a conditional schema (per-option `nested`) or an `x-nested` marker (shared or field-level `nested`) |
| `spec` | the fields of a collection or the item type of an array | `items` or `properties` |
| `validate` | the rules (see [§ `validate` rules](#validate-rules)) | `pattern`, `minimum`, `maximum` and `enum` on plain types, `minItems` and `maxItems` on arrays; a select's `validate` is not converted |

## Form-only properties

Everywhere Make renders a form for a spec, these properties change what a person sees and submits. Make's value check ignores all of them. The public converter ignores all of them except `advanced` and `rpc`, and the public validator reads `mappable` and `editable` as well.

| Property | In Make's form | Make's value check | Public converter |
|---|---|---|---|
| `advanced` | hides the field behind an advanced-settings toggle (details below) | ignored | keeps it and adds `x-advanced: true` (details below) |
| `visible: false` | hides the field, which is still validated | ignored | ignored |
| `omit` | leaves the value out of the collected values; the field is still shown, editable and checked, so a required `omit` field left empty shows `Value must not be empty.` and fails the form's check | ignored | ignored |
| `disabled` | the field is not interactive and its value is not submitted; a required `disabled` field left empty still fails the form's check, with no entry in the floating summary | ignored | ignored |
| `readonly` | the value is shown and is still submitted | ignored | ignored |
| `placeholder` | a plain-text hint in the empty field, never Markdown | ignored | ignored |
| `mode` | the initial pick or map display | ignored | ignored |
| `mappable`, `editable` | allow switching between pick and map | ignored | ignored |
| `labels` | rename the array add button and item rows; on a select, the empty-list and no-results messages | ignored | ignored |
| `rpc` | adds a search button | ignored | an `x-search` marker (details below) |

[parameters-reference.md § Hidden, locked and left-out fields](../parameters-reference.md#hidden-locked-and-left-out-fields) has the per-property detail of the form. [forman-schemas.md § Properties to leave out](forman-schemas.md#properties-to-leave-out) says which of them an Endpoint schema should drop and why.

**`advanced`.**

- In a form the field is hidden behind an advanced-settings toggle. The form's own panel labels it "Advanced settings". The toggle in the scenario module settings is drawn by the platform, so its wording (for example "Show advanced settings") is the platform's.
- The public converter keeps the parameter by default and adds `x-advanced: true` to its schema.
- When the caller passes `excludeAdvancedFields: true`, the converter removes the parameter from the schema and reports only its path in `skippedPaths.advanced`.
- That option does not apply to the top-level field or to the item spec of a primitive array.
- Make's value check ignores `advanced`.

**`labels`.** On an array it holds only the caption of the add button (default "Add item") and of each item row. On a select it holds the empty-list and no-results messages. The value check and the public converter ignore it, so it is harmless in a spec but carries nothing for a caller.

**`mappable`, `mode` and `editable`.** They only control the form's pick or map (formula) switch.

- `mode` is the initial display. `edit` is a legacy name for `map`, and `chose` and `choose` are legacy names for `pick`.
- `mappable` allows switching. `editable` is a deprecated alias.
- Make's value check and the public converter ignore them. A select with `mode: edit`, `mappable: true` or `editable: true` still rejects an unlisted static value.
- The public validator rejects every value that contains a `{{...}}` expression with `Value contains prohibited IML expression.` unless the caller allows dynamic values. `mappable: false` keeps that rejection even when dynamic values are allowed.
- With `mappable: true` or `editable: true`, or when the caller allows dynamic values, the public validator lets a select whose options come from a remote list accept an unlisted value as a warning (`Value 'z' not found in options.`). Static options are not affected: an unlisted value is still an error there.

Which fields have a switch at all is in [parameters-reference.md § Which fields get a Map switch (`mappable`, `editable`)](../parameters-reference.md#which-fields-get-a-map-switch-mappable-editable).

**`rpc`.** On a parameter it adds a search button that fills the value from a remote call. On a text-like input the chosen result sets the value. On an array the button is a second button next to the add button, and each result the user picks adds one item with that result's `value`. Make's value check ignores it. The public converter records it as an `x-search` marker with the call's URL, label and parameter schema on text-like, number and select parameters, and drops it on an array. The button's behaviour is in [parameters-reference.md § Search button on a text field (`rpc`)](../parameters-reference.md#search-button-on-a-text-field-rpc) and, for arrays, in [§ Array properties](../parameters-reference.md#array-properties).

**`omit`.** The form leaves the value out of what it collects, but it still checks the field: a required `omit` field left empty shows `Value must not be empty.`, makes the whole-form check fail and is listed in the floating summary of invalid fields. Make's value check does not look at `omit`: a required parameter marked `omit` that arrives empty still fails with `Value must not be empty.`, and a value sent for it is still validated. The public converter also ignores `omit`, so the parameter is still advertised to callers in the schema.

**`disabled`, `readonly` and `placeholder`.** They only affect the form. Make's value check, the public converter and the public validator ignore all three. A required, disabled field with an empty value still fails the value check.

## Select options

**Membership in Make's value check.** A `select` with a static option list accepts only the listed option values. Any other value fails with `Value not found in options in parameter 'Color'.` The quoted name is the parameter's `label`, or its `name` when it has no label, HTML-escaped in the message.

- Text values are compared exactly and case-sensitively: `'A'` does not match `'a'`, and the number 5 does not match a text option `'5'`.
- For a numeric option, a single value is compared by its leading whole number. Option 5 accepts the text `'5'`, the text `'5abc'` and the number 5.9, and the value is passed on as sent (the text `'5'` stays text). Option 0 rejects the text `'0'` and accepts the number 0.
- With `multiple: true`, every item is compared exactly (option 5 rejects the text `'5'`), a single value counts as a one-item list, and a comma-joined text such as `'a,b'` is not split and fails.
- An enum written as plain `text` has no such check.

**Several values.** A closed set where several values are allowed is a `select` with `multiple: true`. Make's value check wraps a single value into a one-item list, checks each item against the options (`Value not found in options in parameter 'Pick'.`) and applies `minItems` and `maxItems`. Declaring the set as `text`, or as an `array` of `text`, gives no membership check.

The result is a list, never a comma-joined text, so `join()` is needed when the API expects comma-separated text. In the public library the two halves disagree: the converter ignores `multiple` and describes the parameter as a string with an enum, while the public validator demands an array (`Value is not an array.`).

**`dynamic`.** `dynamic: true` on a select switches off Make's membership check. A value that is not in the static option list is accepted by the value check, and the form does not add an allowed-values list to the validation rules it builds for the parameter. It is not form-rendering behaviour. Selects whose options come from a remote list (`rpc://...`) are never checked against options by the value check. The public library ignores `dynamic`: the converter still writes the static options as a closed list, and the public validator still rejects an unlisted value (`Value 'z' not found in options.`).

**`grouped`.** `grouped: true` tells the value check that `options` is a list of groups (`{ label, options: [...] }`) and to look for option values only inside the groups.

| Option list | `grouped` | Make's value check |
|---|---|---|
| groups | not set | every value fails `Value not found in options in parameter '...'.` |
| groups | `true` | values inside the groups pass |
| flat list | `true` | every value fails |
| groups mixed with top-level options | `true` | values inside groups pass, top-level values fail |
| flat list | not set | passes (not affected) |

The public converter detects groups from the option structure and does not need the flag; each grouped option gets the title `Group: Label`. The public validator needs the flag for grouped values, and it accepts top-level options next to groups as well.

**`rpc://` options.** For a select whose `options` is an `rpc://...` address, Make's value check does not compare the value to any list. The public converter gives no `enum`, only an `x-fetch` marker holding the address, so a caller sees a free string. The public validator can check such a select only when the caller supplies a remote resolver. Without one the parameter fails with `Failed to resolve remote resource rpc://app/1/list: Error: Remote resource not supported when resolver is not provided.`

**Option-level properties.** An option also accepts `default: true` on one option (pre-selected in the form), and `description`, `pill`, `icon`, `iconTooltip`, `disabled` and `help`. These affect only the form's picker. They are not carried into the converted schema and the value check does not look at them. An option's `nested` is a separate matter (see [§ Nested fields](#nested-fields)), and the form's full list of option properties is in [select-and-rpc-options.md § Option properties](../parameters-reference/select-and-rpc-options.md#option-properties).

**What the public converter does with a select.**

- An optional (not required) select gets an extra empty-string choice (`""`, titled "Empty" when the options have labels), `default: ""`, and the description "Optional field, can be left empty." when no `help` is set, so a missing `help` is replaced by that line.
- An array item that is a select is given the same empty choice.
- `multiple: true` is ignored, so a multi-select is described as one string.
- Numeric option values sit under `type: string` (as `enum` values or `oneOf` constants, still numbers: `enum: [1, 2]`).
- Required selects get a plain `enum` (no labels), or a `oneOf` with titles when any option has a label or nested fields.

The properties of a select and of its options as the form shows them are in [select-and-rpc-options.md § Select properties](../parameters-reference/select-and-rpc-options.md#select-properties) and [§ Option properties](../parameters-reference/select-and-rpc-options.md#option-properties). Where options can come from is in [§ Option sources](../parameters-reference/select-and-rpc-options.md#option-sources), and the inline-option messages are in [§ Value checks for inline options](../parameters-reference/select-and-rpc-options.md#value-checks-for-inline-options).

## Text-like types

| Type | Make's value check | Public converter and validator |
|---|---|---|
| `text` | converts to text (see below) | a string |
| `uuid` | alias of `text`: no UUID shape check (an empty text becomes null) | a plain string |
| `email` | checks the format and lower-cases | a plain string, no format check |
| `url` | requires `scheme://something` | a plain string, no format check |
| `password` | handled like `text`, except that an empty text becomes null | a string |
| `json` | plain string conversion, not a parser | an object type |

**`text` conversion.** Make's value check converts what it receives:

- Numbers and booleans become text.
- Objects become JSON text.
- Lists become their items joined with `, ` (not JSON). `["a","b"]` becomes `a, b`.
- An invalid date object becomes null.
- HTML handling is controlled by `tags`: `strip` removes tags, `stripall` also removes `<` and `>`, and `escape` converts `&`, `<` and `>` to entities. This always runs, even with `validate: false`.

**`uuid`.** An alias of `text`: the same conversion to text, the same `validate` keys (only an empty text differs: it becomes null), and no UUID shape check anywhere (`not-a-uuid` passes, the number 12 becomes the text `'12'`). The form library deliberately does not validate it as a UUID. `validate.pattern` is the way to enforce a shape. The public converter and validator treat it as a plain string as well.

**`email`.** Make's value check lower-cases the value: `A@B.com` becomes `a@b.com`. `abc`, `a@b` (no dot in the domain), a leading or trailing space and a non-ASCII domain all fail with `Value is not a valid email address.` The public converter and validator treat `email` as a plain string and do not check the format.

**`url`.** A value passes Make's value check when it is some text, then `://`, then more text. Anything before `://` counts as the scheme, so even `not a url://x` passes. Everything else fails with `Value is not a valid URL address.`

| Value | Result |
|---|---|
| `https://example.com/x` | passes |
| `ftp://x` | passes |
| `not a url://x` | passes |
| `example.com` | fails |
| `//x.com` | fails |
| `mailto:a@b.com`, `tel:123` | fails |
| `http://` | fails |

The public converter and validator treat `url` as a plain string.

**`password`.** Make's value check handles it like `text`: the same `validate` keys, and nothing is masked or removed from the value. Only an empty text differs: it becomes null (see [§ `required`, `default` and empty values](#required-default-and-empty-values)). In a form without mapping the form masks the typed characters with a show or hide toggle (`multiline: true` drops the masking); in a mapping form the value shows unmasked. The public converter treats it as a string. Hiding the value in logs is a separate matter (`log.sanitize` in the API description) and the type does not do it.

**`json`.** In Make's value check, `json` is not a JSON parser or an object type. The value goes through plain string conversion, so an object becomes the text `[object Object]` and invalid JSON text such as `{a` passes. For free-form JSON use `any`. In the public converter `json` is an object type, optionally with its own JSON Schema in `schema`, so the two meanings differ.

How the types behave in the form is in [parameters-reference.md § Text field extras](../parameters-reference.md#text-field-extras), and which type to pick for an Endpoint is in [forman-schemas.md § Choosing the type](forman-schemas.md#choosing-the-type).

## Numbers, booleans, dates and times

**Numbers.**

| Type | Make's value check |
|---|---|
| `number` | converts numeric text, trimmed text, hex text and exponent text to a number (`'5'` becomes 5, `' 5 '` becomes 5, `'1e3'` becomes 1000, `'0x10'` becomes 16), `true` to 1, `false` to 0 and a text of only spaces to 0. Objects, lists and texts such as `'abc'` or `'1,5'` fail with `Invalid number.` |
| `integer` | as `number`, and a non-whole number fails with `Invalid integer.` |
| `uinteger` | as `integer`, and a negative number fails with `Number must be unsigned.` |
| `port` | accepts 1 to 65535. 0 and values above 65535 fail with `Invalid port.`, negatives with `Number must be unsigned.` and fractions with `Invalid integer.` |

The public converter writes all four as JSON Schema `number` (not `integer`). The public validator requires a real number (`Expected type 'number', got type 'string'.` for `'5'`) but checks neither whole numbers, sign nor the port range: 1.5, -1 and 70000 pass.

**Booleans.** A `boolean` (and its alias `checkbox`) is converted by Make's value check:

| Value | Result |
|---|---|
| `true`, `false` | stay as they are |
| the text `'false'` (lower case) | false |
| an empty text or null | null (not set) |
| every other value (`'False'`, `'FALSE'`, `'0'`, `'no'`, the number 0, the number 1) | true |

`validate.const` forces one value and fails with `Value not equal true` or `Value not equal false` (no final period). The public validator is stricter about the type: it requires a real boolean (`Expected type 'boolean', got type 'string'.`). The form's controls are in [parameters-reference.md § Boolean and checkbox](../parameters-reference.md#boolean-and-checkbox).

**Dates.** A `date` parameter is parsed into a date value by Make's value check. Text that cannot be parsed fails with `Value is not a valid date.`

Accepted:

- `YYYY-MM-DD` and `YYYY/MM/DD`, with an optional time after `T` or a space (`HH:MM`, `HH:MM:SS`, an optional fraction, or a 12-hour time such as `10:00 PM`), followed by `Z`, `UTC`, `GMT` or a numeric offset (`+01:00`, `-0130`).
- `DD.MM.YYYY` and `DD-MM-YYYY`.
- `MM/DD/YYYY`.

Not accepted: RFC 2822 text such as `Mon, 15 Jan 2024 10:00:00 GMT`, and the word `now`.

Time zone: a date without a time becomes midnight UTC, and a time without an offset is read as UTC. When the caller gives a time zone to the check, both are read in that zone instead.

Pitfalls:

- The fraction of a second is read as a number of milliseconds. Three digits are kept, but `.5` becomes 5 ms (not 500 ms) and `.12` becomes 12 ms.
- A month above 12 swaps day and month: `2024-13-01` becomes 13 January and `15/01/2024` becomes 15 January.
- An all-digit text is read as milliseconds since 1970: `20240115` becomes `1970-01-01T05:37:20.115Z` and `1705312800` becomes 1970-01-20. A real number is read as seconds.
- Out-of-range parts roll over: `2024-02-30` becomes 2024-03-01, and hour 25 becomes 01:00 the next day.

The public converter and validator treat `date` as a plain string without a format check. The form is described in [parameters-reference.md § Date and time fields](../parameters-reference.md#date-and-time-fields).

**Other rules on these types.**

- `date` also supports `validate: { past: false }`, which rejects a date already in the past with `Field contains date in past.` A date without a time is midnight UTC, so today's date counts as in the past.
- `time` takes a time of day (`10:00`, `10:00:30`, `10:00 PM`) and returns it in milliseconds since midnight. `24:00`, `10:60` and a JSON number fail with `Value is not a valid time.`
- `timestamp` takes a whole number of 0 or more, as a number or as numeric text. A negative number fails with `Value is not a valid timestamp.`
- `validate.min` and `validate.max` on `date` are silently ignored: nothing is rejected.

**`color`.** `color` is checked as text (`min`, `max` and `pattern` bound its length and shape) and then has to look like a color. `validate.format` can be `hex`, `rgb`, `rgba`, `hsl` or `hsla`. With a `format`, every value that does not match that form, even a non-color such as `red`, fails with `Value is not a valid color in format 'HEX'.` (the format name in capitals). Without a `format`, a value that matches none of the five forms fails with `Value is not a valid color.` The value is lower-cased on the way out.

## Type list and unknown types

**Types Make's form registers.**

- Plain and structured types: `text`, `editor`, `email`, `password`, `url`, `number`, `integer`, `uinteger`, `json`, `dynamiccollection`, `hidden`, `buffer`, `filename`, `color`, `port`, `timestamp`, `time`, `uuid`, `any`, `path`, `select`, `folder`, `file`, `account`, `hook`, `device`, `udttype`, `udtspec`, `agent`, `udt`, `keychain`, `datastore`, `connectedsystem`, `scenario`, `scenariolist`, `checkbox`, `boolean`, `radio`, `collection`, `array`, `sort`, `date`, `upload`, `range`, `cert`, `pkey`, `filter`, `tokens`, `list`, `grecaptcha`, `aiagent`, `filelist`, `filestorage`, `filestoragefolder`, `mcplist`, `pluginmcpconnections`, `pluginselect`, `exclusionselect`, `aiagenttools`, `mergearray`.
- Composed types `account:name`, `hook:name`, `device:name`, `keychain:name`, `agent:name`, `tokens:name` and `connectedsystem:name`: one base type with a sub-provider.
- Select aliases with Make-hosted option lists: `country`, `imtregion`, `language`, `localization`, `locale`, `timezone`, `usersorganizationsrole`, `userapitokenscope`.
- Display-only entries: `banner`, `separator`, `html`, `markdown`, and the containers `section` and `tabs`.

**The public converter knows a shorter list.** It throws `Unknown field type: <type>` for the rest:

- `device`, `agent`, `connectedsystem`, `scenariolist`, `sort`, `upload`, `range`, `tokens`, `grecaptcha`, `filelist`, `filestoragefolder`, `mcplist`, `pluginmcpconnections`, `pluginselect`, `exclusionselect`, `aiagenttools`, `mergearray` and `section`;
- the lower-case form `dynamiccollection` (it knows only `dynamicCollection`);
- the select aliases above, except `timezone`.

**Unknown types in Make's value check.** A type the value check does not know is not an error: it skips the check and returns no value for it. That also removes the entry from a collection or array-item object (the child comes out undefined) for `radio`, `list`, `timezone`, `country`, `scenario`, `account`, `hook`, `keychain`, `buffer`, `filter` and any misspelt type, unless `required` fails first. The same happens for `file` and `folder`: their check returns no value for any non-empty value. Types are matched case-sensitively here, so `Text` is skipped. In Make's form types are lower-cased first and an unknown type fails with `Unknown type 'xyz'.` The public converter throws `Unknown field type: xyz`, and `Field type is required` for a missing type.

Stay with the types of the type list; a misspelt type is silently skipped by the value check. The aliases and the platform-supplied lists are in [parameters-reference.md § Aliases and platform-supplied lists](../parameters-reference.md#aliases-and-platform-supplied-lists), and the form's handling of an unknown type is in [§ Type list and unknown types](../parameters-reference.md#type-list-and-unknown-types).

## `validate` rules

**`min` and `max` by type.**

| Types | `min` and `max` mean | Messages |
|---|---|---|
| `number`, `integer`, `uinteger`, `port`, `timestamp` | bound the value | `Value is too small. Minimum value is N.` and `Value is too big. Maximum value is N.` |
| `text`, `email`, `url`, `password`, `uuid`, `path`, `color`, `editor` | bound the text length | `Value must be at least N characters long.` and `Value exceeded maximum length of N characters.` |
| `select` with a text value | the same text rules apply to the chosen value, and to each chosen text item of a multi-select; a numeric option value is not checked | as for text |
| `any`, `boolean`, `date`, `array`, `time`, `filename`, `json`, `hidden` | ignored | none |

Arrays and multi-selects use `minItems` and `maxItems` instead:

- An array: `Array has less than N items.` and `Array has more than N items.`
- A multi-select: `Selected less than N items in parameter 'Pick'.` and `Selected more than N items in parameter 'Pick'.`

`validate: false` switches off only the rule keys (`min`, `max`, `pattern`, `minItems`, `maxItems`, `unique`, `const`, `past`, `format`) in Make's value check. The type checks, `required`, the select membership check and the `tags` handling still run: with `validate: false`, `number` `'abc'` still fails with `Invalid number.`, `email` `abc` still fails with `Value is not a valid email address.`, a required empty `number` still fails with `Value must not be empty.` and a `select` with an unlisted value still fails with `Value not found in options in parameter 'Color'.` See [parameters-reference/validation.md § `validate: false`, empty values and `required`](../parameters-reference/validation.md#validate-false-empty-values-and-required).

The public converter writes `min` and `max` as JSON Schema `minimum` and `maximum` only on plain types, including on text, where they do not bound the length. It drops them on arrays and drops the whole `validate` of a select, so a multi-select's `minItems` and `maxItems` do not reach callers (the full table is in [§ What the public converter writes](#what-the-public-converter-writes)).

**`unique`.** `validate: { unique: true }` on an array or a multi-select fails repeated values with `This field contains duplicate values: a`. Values are compared by their JSON text after conversion, so 1 and `'1'` in a text array are duplicates.

`unique: { by: 'key' }` on an array of objects compares one field. How the message names that field depends on the item spec form:

| Item spec form | Message |
|---|---|
| the shorthand (the field list directly) | names the field by its label, or by its `name` when it has no label: `This field contains duplicate values for 'Key': a` |
| the collection wrapper | names the field by its `name`: `This field contains duplicate values for 'k': a` |

On a multi-select, `unique: { by: 'label' }` compares option labels and fails with `This field contains duplicate labels: X`. Empty text, null and undefined values are never duplicates. A `NaN` item of an array of text items is converted to the text `NaN` first, so two of them are duplicates (`This field contains duplicate values: NaN`); in an array of `number` items a `NaN` fails with `Invalid number.` before `unique` runs.

**`pattern`.** `validate.pattern` is a regular expression, given as a plain string or as `{ regexp, label }`. The label is not shown: the message stays `Value doesn't match the pattern.`

- Make compiles the pattern with the Unicode flag and does not anchor it, so `[0-9]+` matches `abc123`.
- An escape that is invalid under the Unicode flag outside a character class (`\-`, `\_`) throws a raw error instead of a validation message, for example `Invalid regular expression: /^\d+\-\d+$/u: Invalid escape`. A malformed pattern does the same: `Invalid regular expression: /(/u: Unterminated group`. Inside a character class `[\-]` is fine.
- The public validator compiles the pattern without the Unicode flag and reports `Value doesn't match the pattern: <regexp>`. The converter copies the pattern to the schema `pattern`.
- Write patterns that are valid under both flags.

The keys each type honours are in [parameters-reference/validation.md § `validate` keys by type](../parameters-reference/validation.md#validate-keys-by-type), pattern handling in [§ Patterns](../parameters-reference/validation.md#patterns), and item rules in [§ Item rules on arrays and multi-selects](../parameters-reference/validation.md#item-rules-on-arrays-and-multi-selects).

## Arrays and collections

**Item spec forms in Make's value check.**

| `spec` of an array | Make's value check | Public converter |
|---|---|---|
| a collection wrapper `{ type: 'collection', spec: [...] }` | validates and converts the item's fields | an object schema; the wrapper's own `label` and `help` become the items' title and description |
| the shorthand `spec: [...]` (the field list directly) | accepted, but only requires each item to be an object; the fields are not validated or converted | the same JSON Schema as the wrapper |
| a single flat field `{ type: 'text', label: 'Value', help: '...' }` (a primitive array) | validates and converts every item by that type | an array of that type |
| `spec: []` | each primitive item becomes an object `{ value: ... }` | an object schema without properties |
| no `spec` | a list of text items | an array |

**The collection wrapper.** With `[{ n: '5', e: 'A@B.COM', r: 'x' }]` and fields `n` (number), `e` (email) and `r` (required text), the result is `[{ n: 5, e: 'a@b.com', r: 'x' }]`. A missing required field fails with `Value must not be empty.`, a bad number with `Invalid number.`, and a text item with `Invalid collection.`

**The shorthand.** The same value passes unchanged (`n` stays `'5'`), required, types and casts are not applied, and a text item fails with `Array of objects expected.` Use the wrapper when the fields must be checked.

**Primitive arrays.** Every item is validated and converted by the single item type, so a list of numbers declared as text becomes a list of text. An array without `spec` is a list of text items. With an empty `spec: []`, each primitive item becomes `{ value: ... }` in Make's value check.

**A `spec` inside a primitive item spec.** `spec: { type: 'text', spec: [...] }` is not rejected by Make's value check or by the public converter. The inner `spec` is silently ignored, the items are treated as text (an object item becomes its JSON text), and the intended structure is lost without any error.

**A `collection` without `spec`.** It is an open object: any keys are accepted and kept. The public converter writes it as an object schema with no properties, and the reverse conversion (JSON Schema back to a spec) treats an object without properties as a dynamic collection. A non-object value fails with `Invalid collection.`

**Errors inside array items.** An error inside an array item keeps the plain field message (for example `Invalid number.`) with no item number in the text, so a message alone does not say which item failed. A select used as the item spec of a primitive array names the parameter by the item spec's label or name; an unnamed item spec gives `parameter ''`.

How the form treats these specs is in [parameters-reference.md § Array item specs](../parameters-reference.md#array-item-specs) and [§ Collections](../parameters-reference.md#collections). The Endpoint recommendation is in [forman-schemas.md § Array and collection specs](forman-schemas.md#array-and-collection-specs).

## Nested fields

Which nested fields Make's value check validates and converts:

| Form of `nested` | Make's value check |
|---|---|
| `options.nested`: nested fields shared by all options of a select, written as a list or as `{ store: [...] }` | validated and converted |
| a boolean's `nested` list | validated and converted when the value is true |
| per-option `nested` on a select | skipped |
| a boolean's two-branch form `nested: { true: [...], false: [...] }` | not validated at all |
| `reversedNested` | ignored: the list is still checked when the value is true |
| field-level `nested` on a select or a text | skipped |

These checks apply only to fields inside a collection (the Endpoint's parameter list). A lone select or boolean validated on its own never checks nested fields.

Example. With per-option `nested`, `{ t: 'a' }` passes and `x: '3'` stays text:

```json
{ "name": "t", "type": "select", "options": [{ "value": "a", "nested": [{ "name": "x", "type": "number", "required": true }] }] }
```

With `options.nested`, `{ t: 'a' }` fails with `Value must not be empty.` and `x: '3'` becomes 3:

```json
{ "name": "t", "type": "select", "options": { "store": [{ "value": "a" }], "nested": [{ "name": "x", "type": "number", "required": true }] } }
```

**The public validator and converter.**

- The public validator validates per-option nested fields.
- It checks the fields of a boolean's plain `nested` list, and of a `{ "store": [...] }` object, whatever the boolean's value, true or false. It ignores `reversedNested`. Fields in a `{ "true": ..., "false": ... }` object are never checked. `checkbox` is treated the same way.
- The public converter does not model boolean branches. It records a plain `nested` list of a boolean (and a `{ "store": [...] }` object) under an `x-nested` marker with no condition on the value. A `{ "true": ..., "false": ... }` object yields no nested schema, and `reversedNested` is not a known property.
- Per-option `nested` becomes conditional branches in the converted schema.

Which nested set a select shows is in [select-and-rpc-options.md § Which nested set is shown](../parameters-reference/select-and-rpc-options.md#which-nested-set-is-shown), the boolean forms in [parameters-reference.md § Conditional fields on a boolean (`nested`)](../parameters-reference.md#conditional-fields-on-a-boolean-nested), and the Endpoint advice in [forman-schemas.md § `required`, `validate` and nested fields](forman-schemas.md#required-validate-and-nested-fields).

## What the public converter writes

This is how the public converter renders a parameter, in case a platform feeds an Endpoint spec to it.

| Spec | JSON Schema |
|---|---|
| `label` | `title` |
| `help` | `description` |
| `required: true` | the name in the parent's `required` list |
| `default` (plain types) | `default` |
| `validate.pattern` | `pattern` |
| `validate.min`, `validate.max` | `minimum`, `maximum` (also on text, where JSON Schema ignores them for strings) |
| `validate.enum` | `enum` |
| array `validate.minItems`, `validate.maxItems` | `minItems`, `maxItems`; `min`, `max` and `default` are dropped |
| select `options` | `enum` or `oneOf`; `validate` (including a multi-select's `minItems` and `maxItems`) and `default` are dropped |
| `advanced` | `x-advanced: true`, or removed with `excludeAdvancedFields` |
| `rpc` | an `x-search` marker on plain types and selects, dropped on arrays |

**Types.**

| Spec type | JSON Schema type |
|---|---|
| `collection` | object |
| `array` | array |
| `text`, `editor`, `email`, `url`, `password`, `uuid`, `path`, `filename`, `color`, `buffer`, `cert`, `pkey`, `file`, `folder`, `date`, `time`, `timestamp`, `timezone`, `select` | string |
| `number`, `integer`, `uinteger`, `port` | number |
| `boolean`, `checkbox` | boolean |
| `json` | object (or its own `schema`) |
| `any`, `hidden` | no type |

**Properties it ignores:** `mappable`, `mode`, `dynamic`, `omit`, `disabled`, `readonly`, `placeholder`, `labels`, `grouped`, `editable`, `multiline`, `time`, `sequence`, `tags` and `multiple`.

The select, array and nested-field results are in [§ Select options](#select-options), [§ Arrays and collections](#arrays-and-collections) and [§ Nested fields](#nested-fields).

## Verbatim messages

Make's value check reports these messages, in English. `N` stands for a number, and the other placeholders in angle brackets for the label, name or key that Make fills in.

| Rule | Message | Notes |
|---|---|---|
| required | `Value must not be empty.` | A missing, null or empty-text value |
| | `Field must not be empty.` | In Make's form: a required array with no items |
| | `Missing value of required parameter '<label>'.` | A required multi-select given an empty list, for example `'Pick'`. A missing or null value gives `Value must not be empty.` |
| Text | `Value exceeded maximum length of N characters.` | |
| | `Value must be at least N characters long.` | |
| | `Value doesn't match the pattern.` | A pattern with a syntax error throws a raw `Invalid regular expression: ...` error instead |
| Number family | `Invalid number.` | |
| | `Invalid integer.` | |
| | `Number must be unsigned.` | |
| | `Invalid port.` | |
| | `Value is too big. Maximum value is N.` | |
| | `Value is too small. Minimum value is N.` | |
| | `Value is not a valid timestamp.` | |
| Date and time | `Value is not a valid date.` | |
| | `Field contains date in past.` | |
| | `Value is not a valid time.` | |
| Formats | `Value is not a valid email address.` | |
| | `Value is not a valid URL address.` | |
| | `Value is not a valid filename.` | |
| | `Value is not a valid color.` | |
| | `Value is not a valid color in format 'RGB'.` | The format name is in capitals (`HEX`, `RGB`, `RGBA`, `HSL`, `HSLA`) |
| Boolean `const` | `Value not equal true` | Also `Value not equal false`. No final period |
| Array | `Array has less than N items.` | |
| | `Array has more than N items.` | |
| | `Array of objects expected.` | |
| `unique` | `This field contains duplicate values: a, b` | The repeated values, joined with `, ` |
| | `This field contains duplicate values for '<field label>': a` | An array of objects with `by` (which name it shows: see [§ `validate` rules](#validate-rules)) |
| | `This field contains duplicate labels: X` | A multi-select with `by: 'label'` |
| Select | `Selected less than N items in parameter '<label>'.` | |
| | `Selected more than N items in parameter '<label>'.` | |
| | `Value not found in options in parameter '<label>'.` | The label falls back to the parameter name, for example `'Color'` |
| Collection | `Invalid collection.` | Also for an array row that is a list or a date |
| | `Unexpected parameter '<key>' found.` | Only when the check runs in strict mode |
| Binary text | `Binary buffer can't be converted to text.` | A text parameter given a binary value |
| | `Unknown codepage '<name>'.` | A binary value with an unknown code page |

Notes:

- A label, name or value quoted in a message is HTML-escaped by the form's message setup: a label `Owner's & <b>` appears as `Owner&#39;s &amp; &lt;b&gt;`, and the repeated values of a `duplicate values` message are escaped the same way (`a&b` appears as `a&amp;b`). The field label in the `for '<field label>'` message is the one exception. Whether a host that sets up the message system itself escapes values too is up to that host.
- Apart from the select messages, the messages do not name the parameter.
- A malformed `validate.pattern` throws a raw `Invalid regular expression: ...` error instead of a message (see [§ `validate` rules](#validate-rules)).

The public validator shares the length, range and array-count messages above, words the rest differently (listed in [§ Three checks that can disagree](#three-checks-that-can-disagree)), and adds `Value doesn't match the pattern: <regexp>`, `Value must be one of the following: a, b`, `Selected less than N items.`, `Selected more than N items.` and, for a remote select without a resolver, `Failed to resolve remote resource rpc://app/1/list: Error: Remote resource not supported when resolver is not provided.`

The full list for modules is in [parameters-reference/validation.md § Error messages](../parameters-reference/validation.md#error-messages). The two lists use the same wording (that file quotes the messages with double quotes, this one with backticks), so change one only together with the other.
