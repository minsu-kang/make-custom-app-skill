# Parameters and Interface Reference: validation

> Read when: a field's `validate` or `required` matters: where Make checks a value (the form and the shared value check) and what the runtime does not check, `validate: false`, empty values, which `validate` keys each type honours, how values are converted by type, `pattern` syntax and case, item rules on arrays and multi-selects, the hints under a field and the verbatim error messages. Part of [parameters-reference.md](../parameters-reference.md).

## Where values are checked

Two places check a value against a parameter spec. This part calls them the form and the value check.

- **The form** is the parameter form Make shows when a module's or a connection's parameters are filled in. Each field checks itself while the user fills it in.
- **The value check** is one check that the form and Make's back end share. It takes a resolved value, converts it to the parameter type (`"5"` becomes the number 5, `"false"` becomes the boolean false, a date text becomes a date) and throws an English message with a code when a rule fails. A typed literal and a resolved mapped value get the same answers: where a value came from does not change a rule.

The form calls the value check for every field with the checks of nested structures switched off. The items of an array and the children of a collection are checked by their own fields.

**What the form checks.** The deciding factor is whether the value contains an IML expression, not the mode of the field.

| Value in the field | What the form checks |
|---|---|
| Contains an IML expression (a mapped variable or a function call), in map mode or in a mappable field in pick mode | Only the syntax of the expression, and it shows the syntax errors. No `min`, `max`, `pattern` or type check |
| A plain literal, also in map mode | The spec, like any other value: `required`, `min`, `max`, `pattern` and the type |
| A field in a group of nested fields that is not shown (for example the nested fields of a boolean that is off, or of an option that is not chosen), or an item field of an array that is switched to map mode | Skipped when the form validates. A `section` is not such a group: its fields are checked even when it is collapsed |

**When the form checks a field.**

- Once, silently, when the field is built.
- Again on every change.
- When the field is switched between pick and map mode.
- When the same field changes elsewhere in the form.
- For the whole form, when the page that hosts the form asks for it. In Make that happens, for example, when the module settings are confirmed. The form does not decide when.

Errors are drawn only after the field was focused or changed, or after the whole form was checked. The whole-form check skips the fields of a nested-field group that is not shown and the item fields of an array in map mode. A collapsed `section` is still checked. A failing field behind the "Advanced settings" toggle makes the form show the advanced settings. After a failed whole-form check a floating summary lists the invalid fields. With more than three, it shows the first three and a "Show N more" toggle (then "Show less") for the rest.

**When a scenario runs.** The value check was written to be shared with Make's back end, and Make most likely runs it on every resolved parameter before a module runs. A mapped value such as `{{1.url}}` that resolves to a disallowed text would then be rejected like a typed literal, and `validate.pattern` would be more than editor help. The form code cannot confirm this, so treat it as the likely behaviour. The platform decides three things:

- Whether, and when, it runs the value check again on the resolved values at execution. This includes what it does with a collection that has `sequence: true` and with `validate.enum` on an array.
- Which options it passes: strict mode (it adds "Unexpected parameter '<key>' found." for a key outside a collection spec, and for every key of a row of an array whose `spec` is a list of fields; without it unknown keys pass), passthrough (whether an empty string is dropped or becomes null) and depth.
- How a validation error reaches the scenario user: the error type, the wording and whether the parameter name is added. The text and the code come from the value check.

## The runtime does not check parameter values

The runtime, the part of Make that runs the IMLJSON of a module, does not check parameter values against the spec. Its own checks are the connection, the outgoing address and the `response.valid` directive. It builds `parameters` from the instance parameters with the mapped values on top (a mapped value wins over an instance parameter of the same name) and hands them to the IML context as they are. [IML roots](../runtime-reference/iml-context.md#roots-in-modules-rpcs-and-endpoints) lists what `parameters` holds, and [Missing values](../runtime-reference.md#missing-values) says what an unfilled parameter evaluates to.

The values it receives were resolved before the call. If Make checks or converts values against the spec (`required`, boolean, date, time), that happens before the runtime, in the platform, where the shared value check most likely runs. The runtime does not show where, or against which spec.

Do not conclude "validation is UI-only" from the runtime's lack of checks: a platform check would sit above the runtime, not inside it. A mapped value is then most likely checked by the same rules as a typed one, but the platform decides (see the end of [Where values are checked](#where-values-are-checked)). Observed: a review of make-ai-web-scraper reported that a mapped value bypasses `validate.pattern`, on the strength of the runtime's lack of checks alone.

## The check saved with the module

When the module is configured, the form hands back a reduced copy of each parameter spec, and Make stores it with the configured module. The copy describes the saved module later. It holds:

| Key in the copy | When it is there |
|---|---|
| `name`, `type` | Always |
| `label` | Only when it differs from `name` |
| `required` | Only when it is `true` |
| `validate` | Left out when `validate` is `false` |
| `mode` | When the field has a mode |
| `tags` | Text fields |
| `time` | Date fields (a `false` is kept, because the default is `true`) |
| `extension` | Filename fields |
| `multiple` | Select fields |
| `spec` | Array and collection fields |

- **Array.** The `spec` is a copy of the item spec with the keys that only the editor uses removed (`help`, `default`, `mappable` and similar). An RPC address for options is replaced by an empty option list with `dynamic: true`. `validate` and `required: true` of the children stay as written.
- **Collection.** The `spec` is rebuilt from the reduced copies of its child fields, and the nested fields of each child field are added to the same list. A collection with `sequence: true` keeps `sequence: true`.
- **Select with an inline option list that is not dynamic.** The stored `validate` is replaced by `{ "enum": [ ...all option values ] }` (with a custom `options.value` key the entries are `null`; see [Value checks for inline options](select-and-rpc-options.md#value-checks-for-inline-options)), so `minItems`, `maxItems`, `unique` and the text rules of such a select are not in the stored copy. This holds when `validate` is not `false` and the list is not empty. For a grouped select the `enum` lists the values of the options inside the groups. The value check never reads `enum`.

The platform decides whether it enforces the generated `validate.enum` when it checks resolved values, and what it does with the `minItems`, `maxItems` and `unique` of such a select that the stored copy lacks. How Make uses the copy when a scenario runs is not shown by the form.

## `validate: false`, empty values and `required`

Add a `validate` object with keys that suit the type (see [`validate` keys by type](#validate-keys-by-type)). `validate: false` means different things in the two places a value is checked:

| | The value check | The form |
|---|---|---|
| What it switches off | Only the rule keys: `min`, `max`, `pattern`, `minItems`, `maxItems`, `unique`, `const`, `past`, `format` | Every check of that one field: `required`, the rule keys, the type check, and the display of syntax errors of a mapped expression in it |
| What still runs | The checks that belong to the type, the select membership check, the checks of the items and children against their own specs, and the `tags` handling | Nothing for that field. The child fields of an array or collection with `validate: false` are still checked by themselves |
| `required` | Still enforced, and checked first | Not enforced: an empty required field shows no error, though the form still marks it as required |

The type checks that still run in the value check with `validate: false`:

- an `email` must still look like an email, a `url` must still contain `://`
- a `number` must still be a number, an `integer` must still be whole, a `uinteger` must not be negative, a `port` must still be 1 to 65535, a `timestamp` must not be negative
- a `date` and a `time` must still parse
- a `color` must still be a color, a `filename` must still have an extension
- a select value must still be one of the inline options
- the items of an array and the children of a collection are still checked against their own specs
- `tags` (the HTML tag handling of a text field) is applied either way

So `validate: false` is not a way to accept an arbitrary value in a typed parameter: use type `text` or `any` for that. It is also not a way to keep a required field but skip its format check: in the value check the type checks stay, and in the form the `required` check goes too. The field property is also covered in [Placeholder, `validate: false` and `dynamic`](../parameters-reference.md#placeholder-validate-false-and-dynamic).

**What counts as empty for `required`.** In the value check, `required` is checked first. It fails on a missing value, `null`, an empty string and an empty file list, even when `validate` is `false` and even for a type that has no value check of its own. These count as filled: a string of spaces, `0`, `false`, an empty list `[]` (except on a multiple select, where a required empty list fails with "Missing value of required parameter '<label>'."), an empty object `{}` and the IML keyword `emptystring` (an empty text that is not the same as a missing value, see [emptystring behavior](../builtin-iml-functions.md#emptystring-behavior)). The error is "Value must not be empty."

`required` accepts `emptystring`, except on a `filename` field, which rejects it with "Value is not a valid filename.". What the field holds afterwards depends on the type. These types keep an empty text: `text`, `password`, `path`, `editor`, `uuid`, `hidden`, `any`, `cert`, `pkey` and `upload`. These types read it as no value: `email`, `url`, `number`, `integer`, `uinteger`, `port`, `timestamp`, `date`, `time`, `boolean`, `checkbox`, `color`, `select`, `array`, `collection`, `json`, `file`, `folder`, `timezone`, `buffer` and `filter`. A required `number` or `date` field filled with `emptystring` therefore passes `required` and has no value.

**Empty values are never rule-checked.** An empty string or a missing value returns before any rule runs, so the text rules (`min` as a length, `max`, `pattern`), the number bounds and `past` do not reject an empty field. Only `required` does. For an array the same holds for a missing value or an empty string, but an empty list `[]` is checked against `minItems` (`minItems: 1` rejects `[]`), and a single value that is not a list is treated as a list of one.

## `validate` keys by type

A key that a type does not honour is ignored without an error. This table is the quickest way to decide whether a `validate` key can work at all.

| Type | Keys honoured | Notes |
|---|---|---|
| `text`, `email`, `url`, `password`, `uuid`, `path`, `editor` | `min`, `max`, `pattern` (a string, or the object form `{ "regexp": "...", "label": "..." }`) | `min` and `max` are a length check counted in JavaScript string units, so one emoji counts as 2. A mapped number, boolean, object or list is first turned into text (a list becomes `a, b`, an object its JSON text) and then measured. See [Patterns](#patterns) |
| `color` | `min`, `max`, `pattern`, `format` | `format` is `hex`, `rgb`, `rgba`, `hsl` or `hsla`, case-insensitive. An unknown format name falls back to "any known color format" |
| `number`, `integer`, `uinteger`, `port`, `timestamp` | `min`, `max` | Inclusive numeric bounds. A numeric text is converted first |
| `boolean`, `checkbox` | `const` | See below |
| `date` | `past` | `min` and `max` are ignored |
| `array`, `select` with `multiple: true` | `minItems`, `maxItems`, `unique` | A single select ignores `minItems` and `maxItems` |
| `select` (single or multiple) | `min`, `max`, `pattern` | Applied to a text option value, and to each text item of a multiple select |
| `time`, `filename`, `collection`, `hidden`, `any`, `json`, `cert`, `pkey`, `file`, `folder`, `upload`, `timezone`, `buffer`, `filter` | none | `timezone`, `buffer`, `filter`, `file` and `folder` values are not checked apart from `required`, and the value check returns no value for them (see [schema-behaviour.md § Type list and unknown types](../endpoints-reference/schema-behaviour.md#type-list-and-unknown-types)) |

Details by type:

- **Numbers.** A numeric text such as `"5"`, `"1e3"` or `"0x10"` is accepted and converted, a string of spaces becomes 0, `true` becomes 1, and an object or a list fails with "Invalid number.".
- **`filename`** does not belong with the text types. It ignores `min`, `max` and `pattern`, and its only check is that the value ends with a dot followed by at least one character: `report.` and `report` fail with "Value is not a valid filename.", `.bashrc` passes. The `extension` key of a filename spec is kept with the module but not checked: `a.txt` passes with `extension: ["pdf"]`.
- **`tags` on a text parameter** (`strip`, `stripall`, `escape`) is applied even when `validate` is `false`. `min`, `max` and `pattern` are checked on the text before the tags are removed or escaped, so `<b>ab</b>` fails `max: 3` although the stored text is `ab`. See [Text field extras](../parameters-reference.md#text-field-extras).
- **`date`.** The only rule is `past: false`, which rejects a date earlier than the moment the check runs ("Field contains date in past."). A date without a time counts as midnight, so today's date is already in the past and is rejected. A date outside a `min` or `max` range passes, because both are ignored. See [Date and time fields](../parameters-reference.md#date-and-time-fields).
- **`time`.** No `validate` key is honoured. The value only has to parse as a time of day ("Value is not a valid time.").
- **`timestamp`.** `min` and `max` are plain numeric bounds on the whole-number timestamp, not date bounds, with the number messages "Value is too small. Minimum value is N." and "Value is too big. Maximum value is N.". A negative timestamp is always rejected, with "Value is not a valid timestamp.", or with the minimum message when the value is also below `min`.
- **`const` on `boolean` and `checkbox`.** The value must equal the constant, otherwise the error is "Value not equal true" (or "Value not equal false"; the constant is printed and there is no full stop). The comparison is made after the value is converted to a boolean: `"false"` and `false` are false, and any other non-empty value is true, including `0`, `"0"` and `"FALSE"`. The comparison is strict, so `const` must be the JSON value `true` or `false`: a `const` of `"true"` or `1` never matches and rejects every value. `validate: false` switches it off.

Three examples that behave as written:

```json
{ "name": "username", "type": "text", "validate": { "min": 3, "max": 30, "pattern": "^[a-z][a-z0-9_]*$" } }
```

`"ab"` is too short ("Value must be at least 3 characters long."), `"Abc"` fails the pattern ("Value doesn't match the pattern."), and 31 characters exceed `max`.

```json
{ "name": "durationSeconds", "type": "number", "validate": { "min": 4, "max": 8 } }
```

3 gives "Value is too small. Minimum value is 4." and 9 gives "Value is too big. Maximum value is 8.". Both bounds are inclusive.

```json
{ "name": "referenceImages", "type": "array", "validate": { "minItems": 1, "maxItems": 3 }, "spec": { "type": "text" } }
```

An empty list gives "Array has less than 1 items." and a list of four items gives "Array has more than 3 items.".

## How values are converted and type-checked

The order is fixed:

1. The value is converted to the type (for numbers, see Numbers under [`validate` keys by type](#validate-keys-by-type)).
2. `min`, `max` and `pattern` run.
3. The check of the more specific type runs.

So an `integer` of 1.5 with `max: 1` gives the maximum message, an invalid email that is too long gives the length message, and a `uinteger` of -5 with `max: 10` gives "Number must be unsigned." because the rule passes first. These type checks stack with the rules:

| Type | The value must be | Message |
|---|---|---|
| `integer` | A whole number | "Invalid integer." |
| `uinteger` | A whole number of 0 or more | "Invalid integer.", "Number must be unsigned." |
| `port` | A whole number from 1 to 65535. `min` and `max` can only narrow that range | "Invalid integer.", "Invalid port." |
| `timestamp` | A whole number of 0 or more | "Invalid number." for a non-number, "Invalid integer." for a decimal, "Value is not a valid timestamp." for a negative |
| `time` | A time of day: 24-hour forms such as `10:30` or `10:30:15`, 12-hour forms such as `10am` or `10:30 PM`, or any text that reads as a date (its time of day is used). A text of digits only passes (it is read as milliseconds), and a JSON number is not a time | "Value is not a valid time." |
| `email` | The form `name@domain.tld`. The value is turned into lower case | "Value is not a valid email address." |
| `url` | Some text, then `://`, then more text. `ftp://x` passes, and so does `not a url ://x` | "Value is not a valid URL address." |
| `filename` | Text with an extension: a dot followed by at least one character | "Value is not a valid filename." |
| `color` | Hex, rgb, rgba, hsl or hsla. The rgb and hsl forms are matched anywhere in the text. With `format` set, only that format | "Value is not a valid color.", "Value is not a valid color in format 'RGB'." |

**Mapped dates.** The `date` type reads mapped text as follows:

- ISO-style dates and date-times are accepted: `2030-01-02`, `2030/01/02`, `2030-01-02 03:04`, `2030-01-02T03:04:05Z`, with or without an offset, also with `AM/PM`.
- Day-first `02.01.2030` and `02-01-2030` are accepted.
- `01/02/2030` is read month-first (2 January) unless the user's date format starts with the day. When the month part is above 12, day and month are swapped: `13/02/2030` is 13 February.
- A value without a time means midnight in the time zone in use, which is UTC unless another one applies.
- A number is read as Unix seconds, but a string made only of digits is read as milliseconds: the text `'1893456000'` gives 1970-01-22, and the number `1893456000` gives 2030-01-01.
- Anything else, such as `Jan 2 2030` or `tomorrow`, fails with "Value is not a valid date.".

**Mapped times.** `time` accepts `HH:mm`, `HH:mm:ss`, `HH:mm:ss.SSS`, `h:mm AM/PM` and `h AM/PM`. The value becomes milliseconds since midnight (`10:30` gives 37800000). A text that reads as a date (also a text of digits only) passes too, and its time of day is used (see the table above). Other text, such as `25:00` or `10.30`, fails with "Value is not a valid time.".

**Mapped timestamps.** `timestamp` accepts a non-negative whole number, also as a numeric text. A negative number fails with "Value is not a valid timestamp.", a decimal with "Invalid integer." and a non-number with "Invalid number.".

## Patterns

`pattern` takes one of two forms:

- A string, which is the body of a regular expression without slashes. A value written like `/^a$/i` is taken literally.
- An object `{ "regexp": "...", "label": "..." }`. The value is checked with `regexp`, and `label` is only the hint line under a text field. An object without `regexp` accepts every value.

The error is always "Value doesn't match the pattern.", in both forms. It does not name the pattern. The check runs only on a non-empty value, and on a text parameter it runs before the tags are removed or escaped.

**Case.** The pattern is compiled in Unicode mode with no other flag (no `i`, `s`, `m` or `g`) and is not anchored: a value matches when the expression is found anywhere in it, unless the pattern says `^` and `$`. Matching is therefore case-sensitive, and a lowercase-only pattern lets mixed-case values through. A deny-list pattern such as

```json
{ "name": "website", "type": "url", "validate": { "pattern": "^https://(?!(?:www\\.)?(?:facebook|linkedin|instagram|tiktok)\\.com)" } }
```

rejects `https://facebook.com` but accepts `https://Facebook.com` and `https://FACEBOOK.COM`, and the literal `^https://` rejects `HTTPS://example.com` as invalid. Host names are case-insensitive, so the domain restriction is bypassed. This was observed in make-ai-web-scraper.

**No way to set a flag.** A pattern cannot be made case-insensitive from the spec:

- A `flags` key (at the top of `validate` or inside the object form) is ignored.
- `/.../i` is taken literally: the slashes and the `i` are characters to match.
- A leading `(?i)` is rejected as an invalid expression.
- A scoped modifier group such as `(?i:facebook)` is accepted by recent JavaScript engines (it worked on Node 24) and rejected by older ones. The check runs in the user's browser and on Make's servers, whose engines are not known, so do not rely on it.

Write case-insensitivity into the pattern with character classes, such as `[Ff][Aa][Cc][Ee]`.

**Unicode-mode syntax traps.** Because the pattern is compiled in Unicode mode, its syntax is strict:

- Escaping a character that is not a regular-expression special character is a syntax error: `\-` outside a character class, `\@`, `\:`, `\_`, a backslash followed by a space, and a numeric back-reference without a group.
- A lone `{`, `}` or `]` without escaping is a syntax error.
- These are fine: `[\w-]`, `\-` inside a class, `\/` and `\.`.
- `\w` and `\d` match ASCII only (`\p{L}` is available), and the dot does not match a newline (use `[\s\S]`).
- A character outside the basic plane counts as one character for the pattern but as 2 for `min` and `max`.

A syntax error is not reported as a validation message. The raw text of the JavaScript engine appears instead, for example `Invalid regular expression: /a\-b/u: Invalid escape`, and the field stays invalid for every non-empty value (an empty value is never checked). The exact text depends on the engine; the examples here come from Node 24 (V8).

**Security rules.** For a security or compliance block (a domain deny-list, an SSRF guard), prefer a custom IML function called from `api.imljson` that lower-cases the value (`host.toLowerCase()`, then compare): it does not depend on the case of the input and covers typed and mapped values. See [custom-functions-reference.md](../custom-functions-reference.md). Treat `validate.pattern`, with the case written into it, as a fail-fast on top of that, not as the only enforcement of the rule. The platform decides whether `validate` is enforced on resolved values and how an error thrown from a custom function is reported (see [Where values are checked](#where-values-are-checked)).

## Item rules on arrays and multi-selects

**Order of the checks.**

- Array: `minItems`, `maxItems`, the checks of the items, then `unique`. The `unique` check also runs for an array without a spec.
- Multi-select: `required` (an empty selection), the item type, `minItems`, `maxItems`, `unique`, then membership in the options.

`unique: false` and `validate: false` switch the `unique` check off.

**`unique: true`.** It flags duplicate items of any kind, rows of a complex array included, and it is also honoured by a multiple select.

- Items are compared after each item was converted to the item type. With the default text item type, `1` and `"1"` are the same item.
- The comparison is case-sensitive and uses the JSON text of an item. Two rows of a complex array count as the same only when they have the same keys with the same values in the same order, so `{"a":1,"b":2}` and `{"b":2,"a":1}` are not flagged.
- A complex array is an array whose `spec` is a list of fields. Its rows are not converted, so `{"x":1}` and `{"x":"1"}` are different rows. When the `spec` is a single collection description instead, the children are converted to their types first and the same two rows are duplicates.
- Null, undefined and empty-string items are skipped. A `NaN` is converted to the text `NaN` first, so two of them are duplicates.

**`unique: { "by": "<field name>" }` on an array of objects.** It flags rows whose named top-level field repeats.

- With a complex array, the field values are compared as given, without converting them to the child field type, so `1` and `"1"` are different. With a collection description the children were converted first, so they are the same.
- Rows where that field is null, undefined or an empty string are skipped, and so are items that are not objects.
- A nested path such as `"a.b"` is not supported and flags nothing. On a simple array `by` finds nothing.
- The message names the field by its label, or by its name when it has no label. When the `spec` is a collection description, the message always shows the field name.

**`unique` with `by` on a select.** `by: "label"` compares the labels of the chosen options and `by: "value"` compares the values. Any other `by` falls back to comparing values (the form logs a console warning).

**How a mapped array is read** by the value check:

- A value that is not a list becomes a one-element list. A mapped text `a,b,c` is one item, not three: it is not split.
- `null` and an empty string give no value.
- Every item is converted to the item type: `['1','2']` with a `number` item spec gives `[1,2]`. A failing item keeps the plain message of its type, such as "Invalid number.", and the error carries the position of that item.
- An empty list does not fail `required` (only a missing, null or empty-string value does) but does fail `minItems`.

In the form, an array in map mode (the whole array mapped) that holds an IML expression keeps its text as its value and skips every check of the spec: `minItems: 3` does not complain about a mapped value, and none of the checks above run on it while the module is set up. A plain text in map mode is checked like any other value: `a,b` with `minItems: 3` shows "Array has less than 3 items." (it is one item), and an empty required array shows "Field must not be empty." (plus "Value must not be empty." when its value is an empty text). Which checks apply to the children of an array is covered in [`required` inside arrays and collections](../parameters-reference.md#required-inside-arrays-and-collections), and the checks of inline select options in [Value checks for inline options](select-and-rpc-options.md#value-checks-for-inline-options).

## Hints under a field

The form draws hint lines under a field from `validate`. A `0` for `min` or `max` counts as not set.

| Type | Rule | Hint |
|---|---|---|
| `text` only (not `email`, `url` or `password`) | `min` equals `max` | "Must be exactly N characters long." |
| | `min` and `max` | "Must be between A and B characters long." |
| | `max` only | "Must be at most N characters long." |
| | `min` only | "Must be at least N characters long." |
| | `pattern` as an object | The `label` |
| | `pattern` as a string | "Must match pattern /<pattern>/." A `validate.hint` text replaces this generated hint |
| `number`, `integer`, `uinteger` | `min` equals `max` | "Must be equal to N." |
| | `min` and `max` | "Must be a number between A and B." |
| | `max` only | "Must be lower than or equal to N." |
| | `min` only | "Must be higher than or equal to N." |
| `port` | always | "Must be between 1 and 65535." |

For example `min: 0` with `max: 10` on a number shows "Must be lower than or equal to 10." and `min: 0` alone shows nothing.

There is no hint for `minItems`, `maxItems`, `unique`, `const`, `past` or the bounds of a `timestamp`.

## Error messages

These are the messages a user sees, in English and verbatim. `N`, `A` and `B` stand for numbers, and the other placeholders in angle brackets for the value, label or key that Make fills in.

| Rule | Message | Notes |
|---|---|---|
| `required` | "Value must not be empty." | A missing, null or empty-string value |
| | "Field must not be empty." | In the form: a required array with no items |
| | "Missing value of required parameter '<label>'." | A required multiple select given an empty list. A missing or null value gives "Value must not be empty." |
| Text | "Value exceeded maximum length of N characters." | |
| | "Value must be at least N characters long." | |
| | "Value doesn't match the pattern." | A pattern with a syntax error shows the engine's own text instead |
| Number family | "Invalid number." | |
| | "Invalid integer." | |
| | "Number must be unsigned." | |
| | "Invalid port." | |
| | "Value is too big. Maximum value is N." | |
| | "Value is too small. Minimum value is N." | |
| | "Value is not a valid timestamp." | |
| Date and time | "Value is not a valid date." | |
| | "Field contains date in past." | |
| | "Value is not a valid time." | |
| Formats | "Value is not a valid email address." | |
| | "Value is not a valid URL address." | |
| | "Value is not a valid filename." | |
| | "Value is not a valid color." | |
| | "Value is not a valid color in format 'RGB'." | The format name is in capitals |
| Boolean `const` | "Value not equal true" | Also "Value not equal false". No full stop |
| Array | "Array has less than N items." | |
| | "Array has more than N items." | |
| | "Array of objects expected." | |
| `unique` | "This field contains duplicate values: a, b" | |
| | "This field contains duplicate values for '<field label>': a" | An array of objects with `by`. The field label, or the field name when it has no label or when the `spec` is a collection description |
| | "This field contains duplicate labels: X" | A select with `by: "label"` |
| Select | "Selected less than N items in parameter '<label>'." | |
| | "Selected more than N items in parameter '<label>'." | |
| | "Value not found in options in parameter '<label>'." | The label falls back to the parameter name |
| Collection | "Invalid collection." | Also for a complex array row that is a list or a date |
| | "Unexpected parameter '<key>' found." | Only when the check runs in strict mode |
| Binary text | "Binary buffer can't be converted to text." | A text parameter given a binary value |
| | "Unknown codepage '<name>'." | A binary value with an unknown code page |

Apart from the select messages, the messages do not name the parameter. The form shows them under the field. The `rpc` button of an array has two messages of its own, "Invalid response." and "No matches found.", which [Array properties](../parameters-reference.md#array-properties) covers.

**HTML escaping.** Error text is built from templates, and the values filled into a message (the select label and the duplicate values) are HTML-escaped by the form's message setup. A label such as `Owner's list` appears as `Owner&#39;s list` and `Q&A` as `Q&amp;A`. The form shows the text as plain text, so the entities are visible. The field label in the "duplicate values for" message is the one exception and is not escaped. Whether a host that sets up the message system before the form escapes values too, and so whether such entities appear, is up to that host.

## The public schema library checks differently

The public `@makehq/forman-schema` library is a separate implementation and does not give the same answers as Make. Compared with Make's value check it:

- compiles the pattern with no flags, so there is no Unicode mode and a backslash before a hyphen is accepted
- words its errors differently: "Value doesn't match the pattern: <regexp>", "Field is mandatory.", and "Value must be one of the following: x" for `validate.enum`
- validates the children of a complex array, including `required`
- does not check `unique` or the formats of `email`, `url` and `date`
- honours a `validate.enum` list on a text value (Make's value check ignores `enum`), and, when the caller asks for field schemas and the value is valid, the schemas it returns carry a `validate.enum` list that it generates for a select with inline options
- exports `min` and `max` of a text parameter to JSON Schema as `minimum` and `maximum`, not as `minLength` and `maxLength`

Use it for structure checks, not as a stand-in for Make's own validation. Its per-property effects (`{{...}}` values rejected, with `mappable: false` even when dynamic values are allowed; `dynamic` ignored) are in [endpoints-reference/schema-behaviour.md](../endpoints-reference/schema-behaviour.md#three-checks-that-can-disagree).

## Rules of thumb

- Use `required` for "must be filled", never `min: 1`. Empty values are never rule-checked, so `min: 1` does not reject an empty field.
- When the children of an array must be checked on resolved values, give the items as a single collection spec (see [`required` inside arrays and collections](../parameters-reference.md#required-inside-arrays-and-collections)).
- Escape every literal special character of a pattern correctly for Unicode mode, and test the pattern with an uppercase value (see [Patterns](#patterns)).
- Expect the form not to check anything that contains a mapped expression. Whether the platform checks it when the scenario runs is the platform's decision.
