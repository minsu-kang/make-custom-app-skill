# SDK Endpoints reference: input and output schemas

> Read when: writing or reviewing endpoint `input_parameters` / `output_parameters`: the schema checklist (what to declare, enums, empty outputs and saving `[]`, types, properties to leave out, `help`, arrays and collections, `required` / `validate` / nested fields), each rule with its verified effect, and the team conventions marked as conventions. For what Make's form, Make's value check and the public converter do with each property and type, open [schema-behaviour.md](schema-behaviour.md). Part of [endpoints-reference.md](../endpoints-reference.md).

## How Make reads an Endpoint schema

An Endpoint's `input_parameters` use the parameter spec format of a module's `expect.imljson`: `name`, `type`, `label`, `help`, `required`, `default`, `options`, `nested`, `spec` and `validate`, plus the properties that only a form uses ([parameters-reference.md](../parameters-reference.md) lists them all). `output_parameters` is written the same way, like a module's `interface` ([interface syntax](../parameters-reference/interface.md#interface-syntax)). Make's value check and the public `@makehq/forman-schema` converter take exactly this shape and do not know whether a spec belongs to a module or to an Endpoint.

Three things act on a schema, and this file keeps them apart:

- **Make's form** renders the spec as input fields (the Run Endpoint form in the platform UI).
- **Make's value check** converts and checks a submitted value against the spec: types, `required`, `validate`.
- **The public library** [`@makehq/forman-schema`](https://github.com/integromat/make-forman-schema) has a converter, which writes the spec as JSON Schema, and a validator, which checks a value against the spec. The validator does not behave like Make's value check: for example, it rejects a number for a `text` parameter, where Make's value check turns the number into text.

[schema-behaviour.md § Three checks that can disagree](schema-behaviour.md#three-checks-that-can-disagree) lists where the three differ. Legend for the rest of this file: a rule marked **Make enforces** describes what one of these checks does with the spec; a rule marked **Team convention** is a review rule of this team that no check enforces.

Select parameters whose options carry their own nested parameters are accepted at any depth: a select inside an option of a select, or a select field inside an array item collection (observed: the request-type picker of `batchUpdateDocument`). The public converter turns option-level nested parameters into conditional JSON Schema on the object that holds the select. It writes one `allOf` entry per option that has nested fields, saying "if the select equals this value, these properties apply", and nested fields marked `required` are required inside that branch. One exception: a select used directly as the item spec of a primitive array attaches its branches to the object that holds the array, under the property name `undefined`, so the dependency is lost for callers. Whether Make's value check validates the nested fields depends on how they are nested, see [`required`, `validate` and nested fields](#required-validate-and-nested-fields).

Platform notes:

- Which paths apply Make's value check to an Endpoint call (the Run Endpoint form, MCP execution, a module's `api.endpoint` call, a scenario), and whether strict checking is on, is decided by the platform, not by Make's form or the part of Make that runs the IMLJSON. That part never receives the spec and validates no parameter value ([runtime-reference/inline-endpoint-calls.md § What runs inside an Endpoint](../runtime-reference/inline-endpoint-calls.md#what-runs-inside-an-endpoint)). [endpoints-reference.md § Runtime Validation Caveats](../endpoints-reference.md#runtime-validation-caveats-critical--verified) has what is known for the Run Endpoint form and MCP execution. Every conversion and message in this file applies only where the check runs.
- Whether the platform converts an Endpoint spec with the public converter before it shows the spec to an AI caller, and with which options (for example `excludeAdvancedFields`), is decided by the platform too. What this file says about a caller that works from the converted schema describes the library.

## Declare the full input and output

The converter lists exactly the parameters you declare, so a field that is not declared does not exist for anyone who works from the schema.

**Make enforces**

- The public converter writes the declared parameters as JSON Schema properties in declared order, with nested fields and array item fields at their depth. A parameter or sub-field that is not declared is absent from the result, so a caller that works from the schema cannot know about it. Entries without a name and display-only entries are skipped, and when two entries share a name only the first is kept.
- The part of Make that runs an Endpoint never receives the output spec. It runs the API description and returns what `response.output` yields, which is the whole body for `{{body}}`. Declaring more, fewer or different output parameters does not change, trim or validate the returned data, so the declared output schema is documentation for callers and the mapper, and it has to be complete to be useful. The only check on the result is its shape: an object, a text, or a list of those. Anything else fails with `Invalid Endpoint output. Expected Object, or String, or Array, but found <type>.`, and a bad list item fails with `Invalid item in Endpoint output. Expected Object, or String, but found <type>.` Older Endpoints use the RPC wording of these messages, listed in [runtime-reference/inline-endpoint-calls.md § What runs inside an Endpoint](../runtime-reference/inline-endpoint-calls.md#what-runs-inside-an-endpoint).
- Open-ended inputs are declared as `any` or as a `collection` without `spec`. `any` accepts any value unchanged (object, list, text, number). A `collection` without `spec` accepts any object and keeps its keys. A `collection` whose `spec` lists only some fields also lets the extra keys through unchanged in lenient checking. In strict checking every undeclared key fails: `Unexpected parameter 'zzz' found.` in Make's value check, `Unknown field 'z'.` in the public validator. For a `collection` without `spec` that means every key. In Make's value check it also means every key of an array item declared with the shorthand item spec (a field list directly, see [Array and collection specs](#array-and-collection-specs)).

**Team conventions**

- `output_parameters` documents the full actual output. When `response.output` is the `{{body}}` passthrough, the declared schema covers the whole API resource (observed: `createDocument` grew from 3 fields to the full Document resource schema of about 288 KB). Nothing checks an output spec against the real response, so completeness is a review matter. AI callers rely on the declared schema, not on the raw response. How the platform presents Endpoint specs to AI callers is decided outside Make's form and the runtime.
- Output definitions cover every field of the API docs, nested object fields included, whether or not the field is commonly used. Write-only fields ("never populated in responses") are left out. Verify the output schema against the vendor API documentation and do not rely only on what the existing module outputs, because modules may omit fields.
- Complex inputs are declared completely. When the vendor parameter is an object or an array of objects, the `spec` lists every documented sub-field, with nested `collection` / `array` specs as deep as the vendor schema goes. Do not stop at the two or three fields the module happened to use. When the structure is genuinely open-ended (a vendor "JSON" scalar, free-form `column_values`), declare it as `any` and describe the expected shape in `help` and `context.md` instead of inventing a partial spec.

## Enums are selects

A parameter the vendor documents with a closed set of values (REST enums, GraphQL `enum` types) is a `select` with those exact values as `options` (`label` humanised, `value` verbatim), and `multiple: true` for list-of-enum arguments. Plain `text` for an enum is a defect, not a shortcut.

| Data | Use | Instead of |
|---|---|---|
| Fixed set of values (enum) | `select` (with `options`) | `text` |
| Fixed set, multiple allowed | `select` with `multiple: true` | `text` or `array` of `text` |

**Make enforces**

- A `select` with static options rejects a value outside the list: `Value not found in options in parameter '<label>'.` (the parameter's name stands in when it has no label). A `text` parameter whose options are named only in `help` accepts any text. That is why `select` is preferred: better UX, and invalid values are prevented.
- `validate.enum` on a `text` parameter does not restrict anything in Make's value check; any text passes. The public validator does enforce it (`Value must be one of the following: a, b`) and the public converter writes it as a JSON Schema `enum`. Only a `select` gets the membership check in Make.
- With `multiple: true` the stored value is a list of the chosen option values, and each keeps its own type: numeric option values stay numbers, and a single value is wrapped into a one-item list. The list holds text only when the option values are text. Make's value check expects a list and checks every item. So a multi-select does not always produce an array of strings; when the API expects comma-separated text, use `join()` in `api.imljson` (for example `"fields": "{{join(parameters.fields, ',')}}"`).
- The two halves of the public library disagree about `multiple`. The converter ignores it and describes the parameter as one string from the enum, while the validator demands a list (`Value is not an array.`). Say in the parameter's `help` that it takes a list of these values.

## Empty response body

An Endpoint whose response mapping yields an empty list returns `{}` to its caller. A list with exactly one item is returned as that item, so `{{body.field}}` works without `first()`. With a top-level `response.iterate` (list output) or `response.unwrap: false` the list is kept as it is, and an empty list stays `[]` ([runtime-reference/inline-endpoint-calls.md § Result unwrap](../runtime-reference/inline-endpoint-calls.md#result-unwrap-responseunwrap)).

**Team conventions**

- For `204` and other empty-body operations (DELETE, archive, unsubscribe) the declared output is an empty array: `"output_parameters": []`.
- Do not invent placeholder fields (`__IMTMESSAGE__`, `success`, `status`, `result`) that the API does not return. The unwrap gives the caller `{}` anyway.
- An empty module `interface` does not make the Endpoint output empty. When the vendor returns a body, document that schema. Use `[]` only when the vendor response body itself is empty.

An empty HTTP body reads as `{{body}}` = `null` ([runtime-reference.md § Empty bodies and parse failures](../runtime-reference.md#empty-bodies-and-parse-failures)). In the runtime, an `output` of `{{body}}`, or no `output`, then gives an empty list, which the unwrap turns into `{}`. An `output` object that maps the body into a field, such as `{ "a": "{{body}}" }`, gives a one-item list, so the caller gets `{ "a": null }`. The `[]` and placeholder rules above are review conventions.

## Saving an empty section

Platform behaviour of the API, which the form cannot settle:

- `PUT /api/v2/admin/sdk/apps/{slug}/{version}/endpoints/{name}/{section}` returns HTTP 500 `42501` when the `input_parameters`, `output_parameters` or `scope` section is `[]` (the `{section}` in the path is `inputParameters`, `outputParameters` or `scope`, see [endpoints-reference.md § SDK Admin API Surface](../endpoints-reference.md#sdk-admin-api-surface)).
- The same body succeeds on the non-admin route `PUT /api/v2/sdk/apps/{slug}/{version}/endpoints/{name}/{section}`, and only while the caller owns the app. In public mode `update-app.js` uses this route already.
- Do not probe alternate content types or invent a placeholder to get past the 500.

For endpoint component work done through the admin API:

1. Read the current owner: `GET /api/v2/admin/sdk/apps?all=true&name={slug}&cols[]=email` returns `email`.
2. If that email is not the acting user's (`GET /api/v2/users/me`), `POST /api/v2/admin/sdk/apps/{slug}/transfer` with `{ "user": <actingUserId> }`. Resolve the id with `GET /api/v2/admin/users/lookup?type=email&q=`.
3. Write every `[]` section on the non-admin route.
4. Transfer ownership back to the original owner the same way.

Skip a `[]` write when the stored section is already `[]`. An empty `scope` usually is, right after create, so do not PUT it.

## Choosing the type

Use the most specific type available. Do not default to `text` for everything.

| Data | Use | Instead of |
|---|---|---|
| Email address | `email` | `text` |
| Date or datetime (RFC 3339, ISO 8601) | `date` | `text` |
| URL or link | `url` | `text` |
| Secret or password (`SipAuthPassword`, token) | `password` | `text` |
| True/false flag | `boolean` | `text` |
| Numeric value (JSON number) | `number` or `uinteger` (`integer` and `port` also exist) | `text` |
| UUID-shaped ID | `uuid` (documents intent only, see below) | `text` |
| Any JSON value (vendor "JSON scalar" input, the `arbitraryCall` body) | `any` | `text` |
| Numeric-looking string in a JSON response (`"0.00000"`) | `text` | `number` |

What Make does with each type (the whole list is in [schema-behaviour.md § Type list and unknown types](schema-behaviour.md#type-list-and-unknown-types), the conversions in [§ Numbers, booleans, dates and times](schema-behaviour.md#numbers-booleans-dates-and-times) and [§ Text-like types](schema-behaviour.md#text-like-types)):

- **`uuid`** is handled like `text`, except that an empty text becomes null. Make does not check that the value is UUID-shaped (`not-a-uuid` passes), so the type only documents intent. To enforce the shape, add `validate.pattern` with an anchored regular expression ([parameters-reference/validation.md § Patterns](../parameters-reference/validation.md#patterns)).
- **`any`** is a registered parameter type. Make's value check returns the value untouched (object, list, text, number), ignores every `validate` rule on it, and still applies `required` (an empty text or `null` fails with `Value must not be empty.`; `{}` passes). The public converter gives it no JSON Schema type, only a title and description, so the caller sees just the label and the `help` text. Every `arbitraryCall` uses it. Platform note: `any` is not in the public Make developer docs, so check the list of types Make accepts and existing apps before declaring a type unsupported.
- **`email`** is checked and lower-cased: the value is stored in lower case, and an address with no dot in the domain (`a@b`), a non-ASCII domain or surrounding spaces fails with `Value is not a valid email address.` Use `text` when the API accepts a wider set (for example internationalised domains) or is case-sensitive.
- **`date`** is right for RFC 3339 and ISO 8601 values, but Make converts the text into a date value:
  - invalid text fails with `Value is not a valid date.`;
  - a date-only value becomes midnight UTC;
  - the fraction of a second is read as a number of milliseconds: three digits are kept, but `.5` becomes 5 ms, not 500 ms;
  - a month above 12 swaps day and month (`2024-13-01` is read as 13 January), and an all-digit text such as `20240115` is misread as milliseconds since 1970.

  When the API wants a plain `YYYY-MM-DD` or another fixed format, keep `text` with a format hint (and a `validate.pattern`), or format the date in the API description.
- **`url`** accepts only values of the form `scheme://something`. `example.com`, `//host/path`, `mailto:` and `tel:` values fail with `Value is not a valid URL address.` Use `text` where the API takes bare domains or non-URL schemes.
- **`password`** is the same as `text` for Make's value check (same conversion, same `min` / `max` length rules), except that an empty text becomes null. In a form without mapping the typed characters are hidden, with a switch to show them; in a mapping form, such as a module's settings, the field is a mapping box and the value shows unmasked ([parameters-reference.md § Text field extras](../parameters-reference.md#text-field-extras)). Do not rely on the type to keep the value out of logs: sanitize it with `log.sanitize` in `api.imljson` ([component-patterns-reference.md § Log Sanitize Best Practices](../component-patterns-reference.md#log-sanitize-best-practices)).
- **`boolean`** is converted loosely. Only `true`, `false` and the lower-case text `false` mean what they say, an empty value is "not set", and everything else is true, including the text `False`, `0` and `no` and the number 0. Callers that send flags as text or numbers must send real booleans or the text `true` and `false`.
- **Numbers.** `integer` (whole numbers, `Invalid integer.`) and `port` (1 to 65535, `Invalid port.`) exist beside `number` and `uinteger`. All four turn text into a JavaScript number, so identifiers longer than about 15 digits, and values whose written form matters (`0.00000`, `007`), must stay `text`.
- **Numeric-looking strings in a response.** For an output parameter nothing converts the returned data: the Endpoint returns what the response mapping yields, so typing a numeric-looking string as `number` only misdescribes it. Declare `text` because the API returns a string. For an input parameter, Make's value check rewrites numeric-looking text typed `number`: `0.00000` becomes 0, `007` becomes 7, and `12345678901234567890` becomes 12345678901234567000 (JavaScript number precision). Keeping such values as `text` preserves them exactly.

## Properties to leave out

Leave out the properties that only a form reads. The reason is not that Endpoints have no form: wherever Make renders a form from the spec (the Run Endpoint form in the platform UI, see [endpoints-reference.md § Runtime Validation Caveats](../endpoints-reference.md#runtime-validation-caveats-critical--verified)), these properties change what a person sees and submits. The reason is that they have no effect for callers, and some of them can hide a parameter or change validation. Platform note: which surfaces render an Endpoint spec as a form is decided by the platform.

| Property | In Make's form | Make's value check | Public converter |
|---|---|---|---|
| `advanced` | hides the field until the "Advanced settings" toggle is on (the scenario module settings draw their own toggle) | ignores it | keeps the parameter and adds `x-advanced: true`; leaves it out when the caller converts with `excludeAdvancedFields: true` |
| `omit` | the field stays editable and checked, its value is not submitted | ignores it | ignores it |
| `disabled` | not editable, value not submitted | ignores it | ignores it |
| `readonly` | not editable, value still submitted | ignores it | ignores it |
| `mode`, `mappable`, `editable` | control the formula (Map) mode of fields that have a Map switch | ignores them | ignores them |
| `labels` (`{ "add": ..., "item": ... }`) | rename the add button and the item captions of an array | ignores it | ignores it |
| `placeholder` | hint text in the empty field | ignores it | ignores it |
| `rpc` | adds a button that calls an RPC | ignores it | writes an `x-search` marker |
| `dynamic`, `grouped` | `dynamic`: draws no control (read by `select` only); `grouped`: see below | change the check, see below | read the options, not the flag |

The public validator reads only `mappable` and `editable` of these. It rejects every value that contains a `{{...}}` expression with `Value contains prohibited IML expression.` unless the caller allows dynamic values, and `mappable: false` keeps that rejection even then. With `mappable: true` or `editable: true` (or when the caller allows dynamic values), an unlisted value of a select with a remote option list becomes a warning (`Value 'z' not found in options.`) instead of an error ([schema-behaviour.md § Form-only properties](schema-behaviour.md#form-only-properties)).

- **`advanced`** can make a parameter invisible to a caller. By default the converter only marks it, but a caller that converts with `excludeAdvancedFields: true` does not see the parameter at all (its path is only reported as skipped). That is a stronger reason to omit the property than cosmetics. A caller that works from the converter also sees a nested JSON Schema, not a flat list of arguments: a collection becomes an object with its own properties, an array becomes `items`, and per-option nested fields become conditional branches. Advanced fields stay in that schema with an `x-advanced` marker unless the caller excludes them.
- **`labels`** never belong in `output_parameters`, and on inputs of a regular endpoint they are dropped. Modules carry them, so copying `expect` into `input_parameters` wholesale drags them along, and copying `interface` into `output_parameters` must not. Team convention: the `arbitraryCall` template keeps the module's `labels` on `headers` and `qs` for parity with the 17 existing apps. That is harmless and not a finding.
- **`dynamic`** is read by `select` only and draws no refresh button in a form ([parameters-reference.md § Placeholder, `validate: false` and `dynamic`](../parameters-reference.md#placeholder-validate-false-and-dynamic)), but it changes the value check. On a select with static options, `dynamic: true` switches off the check that the value is in the option list, so a value outside the list is accepted. Only Make's value check honours it: the converter still describes the options as a closed `enum`, and the public validator still rejects an unlisted value (`Value 'z' not found in options.`). Drop it from an Endpoint when the value must be one of the options. Keeping it for a vendor that accepts values beyond the documented list widens only Make's check. A caller that works from the converted schema still sees a closed list, so say in `help` that other values are accepted.
- **`grouped`** does more than render groups. With grouped options (`[{ label, options: [...] }]`), Make's value check needs `grouped: true` to find the option values, and without it every value fails `Value not found in options in parameter '...'.` The flag also changes flat lists: `grouped: true` on a flat option list makes every value fail, and in a list that mixes groups with top-level options the top-level values fail. Use flat `options` without `grouped` in Endpoint schemas. If groups are kept, set `grouped: true` and put every option inside a group.
- **`omit`** only keeps the value out of what a Make form collects. In a module, such fields are helpers that never reach the API, and they are dropped from an Endpoint rather than passed through: Make's value check and the converter ignore `omit`, so the parameter is still advertised to callers, and a value sent for it is still validated and received.
- **`rpc://` option sources.** Make's value check accepts any value for a select whose options come from an `rpc://` source, and the converter writes a free string with an `x-fetch` marker naming the source, so callers get no list of values. Team note: an AI caller has no form to fetch options into. Replace the source with static `options` from the vendor enum, or with a plain typed input. Platform note: how the platform treats these sources for AI callers is decided by the platform.
- **Display-only entries** (`banner`, `separator`, `html`, `markdown`) are not values. Make's form renders them, the converter and the validator skip them, and they never reach a caller, so they do not belong in an Endpoint spec.
- **`sequence: true`** on a `collection` (a module option meant to keep the declared key order) makes Make's value check return an empty object: every key of the collection value is lost. Copying a module spec that carries `sequence` into an Endpoint input would therefore drop the whole collection value wherever the check runs (whether the platform uses that result is decided outside the form, see [parameters-reference.md § Collections](../parameters-reference.md#collections)). Leave `sequence` out. Without it the keys keep the order in which they arrived.

`required`, `default`, `help`, `options`, `nested`, `spec` and `validate` stay, but know what each does:

- `default` is only the form's initial value and, for plain types (text-like, numbers, boolean, date), the JSON Schema `default`. Make's value check never fills a missing value from it. The converter never writes the `default` of a select, an array or a collection (an optional select always gets `default: ""`).
- `required` fails for `null`, `undefined`, an empty text and an empty multi-select list (`Value must not be empty.`, and `Missing value of required parameter 'Pick'.` for the multi-select, which names the label or the name). A space, `0`, `false`, `{}` and an empty `array` count as present. Details: [schema-behaviour.md § `required`, `default` and empty values](schema-behaviour.md#required-default-and-empty-values).
- Per-option `nested` is not validated by Make's value check, see [`required`, `validate` and nested fields](#required-validate-and-nested-fields).
- `validate` is converted only for plain types and arrays. The `validate` of a select, including the `minItems` and `maxItems` of a multi-select, does not reach the converted schema.

## `help` on every parameter

**Team convention** (Make does not require it): every input and output parameter has a descriptive `help`, and no parameter is left without one. This applies at every depth:

- top-level parameters;
- nested fields inside `collection` specs;
- array item specs (the `spec` object itself and its nested fields);
- fields at any nesting depth.

It includes primitive array specs: the `spec` object inside a primitive `array` needs `help` too.

```json
// Wrong: missing help in spec
{
    "name": "permissionIds",
    "type": "array",
    "label": "Permission IDs",
    "help": "List of permission IDs for users with access to this file.",
    "spec": {
        "type": "text",
        "label": "Permission ID"
    }
}

// Correct: help present in spec
{
    "name": "permissionIds",
    "type": "array",
    "label": "Permission IDs",
    "help": "List of permission IDs for users with access to this file.",
    "spec": {
        "type": "text",
        "label": "Permission ID",
        "help": "The ID of a permission for a user with access to this file."
    }
}
```

**What Make does with `help`** (it requires none):

- The converter passes `help` to the caller at every depth: top-level parameters, fields inside a collection spec, the item spec of an array (`items.description`) and the fields of array item collections all keep their own `help` as `description` (and `label` as `title`). It drops an empty or whitespace-only `help`.
- For a primitive array, the item spec's own `label` and `help` reach the caller as the title and description of the array items. A primitive item spec without `help` leaves the items undescribed, as the Wrong example shows.

**Exceptions** where `help` is not required:

- `select` `options` entries. The `label` is self-explanatory, but an option contributes only its `label` (as the entry title) and its `value` to the converted schema. An option's own `description` or `help` is not carried, so say what each value means in the parameter's own `help`.
- The `labels` object (for example `"labels": { "add": "Add header" }`), if it is present at all. The converter ignores it, and it is a form-only property that is normally dropped from Endpoint schemas (see [Properties to leave out](#properties-to-leave-out) above).

**Formatting.** Use markdown in `help` texts, with URLs in the `[text](url)` link format, and follow the Apps UX best practices for wording, tone and formatting ([app-ux-best-practices.md](../app-ux-best-practices.md); this is a convention). Make's form passes `label` and `help` through a small markdown renderer, so know what it renders:

- The text is HTML-escaped first, so raw HTML shows as text.
- Supported: `[text](https://...)` links (opened in a new tab), inline code in backticks, `**bold**` or `__bold__`, `*italic*` or `_italic_`, and a newline as a line break.
- Not supported: headings, bullet or numbered lists, tables and block quotes show as literal characters, and a fenced code block is not a block (its backticks are partly read as inline code).
- A link whose address starts with `javascript:`, `data:` or `vbscript:` (case and spaces ignored) is not turned into a link; the whole `[text](address)` is shown as typed.
- A link address with an underscore directly followed by a non-word character (for example `_/`, `_.`, `_-`, `_?` or `_(`) is garbled by the italic rule, and an address that contains `)` ends the link early.
- `label` is rendered the same way, and `placeholder` is plain text.
- The public converter passes `help` through verbatim, so a caller that works from the converted schema sees the raw markdown.

## Array and collection specs

Arrays of **objects** (items with named fields) use the nested collection wrapper:

```json
{
    "name": "attendees",
    "type": "array",
    "label": "Attendees",
    "help": "The attendees of the event.",
    "spec": {
        "type": "collection",
        "label": "Attendee",
        "help": "An event attendee.",
        "spec": [
            { "name": "email", "type": "email", "label": "Email", "help": "The attendee's email address." },
            { "name": "optional", "type": "boolean", "label": "Optional", "help": "Whether this is an optional attendee." }
        ]
    }
}
```

**Make enforces**

- Both `spec: [ ...fields ]` (the shorthand) and `spec: { "type": "collection", "spec": [ ...fields ] }` (the wrapper) are accepted, and both convert to the same JSON Schema.
- The wrapper is required in practice: only it makes Make's value check validate and convert the item fields (`required`, types, casts). With the shorthand, the check only confirms that each item is an object (`Array of objects expected.`). Only the wrapper can carry the item's own `label` and `help`.

Arrays of **primitives** (strings, numbers) use a flat spec object, which needs `help` like every other spec:

```json
{
    "name": "recurrence",
    "type": "array",
    "label": "Recurrence",
    "help": "List of RRULE, EXRULE, RDATE, and EXDATE lines for a recurring event, as specified in RFC5545.",
    "spec": { "type": "text", "label": "Value", "help": "One RRULE, EXRULE, RDATE or EXDATE line." }
}
```

Do not put a `spec` inside the `spec` of a primitive array: `spec: { type: "text", spec: [...] }`. It is not rejected. Make's value check and the public converter silently ignore the inner `spec`, and the array becomes a list of text items (an object item is turned into its JSON text), so the structure the author wanted is lost without an error. To get objects, use an item spec of type `collection`. An item spec of type `array` or `collection` carrying its own `spec` (a list of lists, a list of objects that hold lists) is the legitimate way to nest.

More on the spec forms and array properties: [parameters-reference.md § Collections](../parameters-reference.md#collections), [§ Array item specs](../parameters-reference.md#array-item-specs), and [schema-behaviour.md § Arrays and collections](schema-behaviour.md#arrays-and-collections).

## `required`, `validate` and nested fields

**`required`.** `required: false` is the default, so do not write it: writing it changes nothing in Make's check or in the converted schema. Specify `required: true` only where the API genuinely requires the field.

**`validate` limits** (**Make enforces**; for example `"validate": { "min": 0, "max": 1 }`):

| Type | `min` / `max` bound | Messages |
|---|---|---|
| `number`, `integer`, `uinteger`, `port` | the value | `Value is too small. Minimum value is 5.` and `Value is too big. Maximum value is 5.` |
| `text`, `email`, `url`, `password`, `uuid`, `path` | the text length | `Value must be at least 3 characters long.` and `Value exceeded maximum length of 3 characters.` |
| `select` (and each chosen item of a multi-select) | the text length of a chosen text value; a numeric option value is not checked | the text messages |
| `array`, and the number of chosen items of a multi-select | nothing: `min` and `max` are silently ignored there. Use `minItems` and `maxItems` for the number of items | `Array has less than 2 items.` and `Array has more than 1 items.`; for a multi-select `Selected less than 2 items in parameter 'Pick'.` and `Selected more than 1 items in parameter 'p'.` |
| `any`, `boolean`, `date` | nothing: `min` and `max` are silently ignored | none |

`pattern` is a regular expression (a plain string or `{ regexp, label }`), compiled with the Unicode flag and not anchored. Write `^...$` for a whole-value match, and avoid escapes that are invalid under that flag (for example a backslash before a dash or an underscore outside a character class): they fail with the engine's own text instead of a validation message, for example `Invalid regular expression: /.../u: Invalid escape`. A value that does not match fails with `Value doesn't match the pattern.` ([parameters-reference/validation.md § Patterns](../parameters-reference/validation.md#patterns), [schema-behaviour.md § `validate` rules](schema-behaviour.md#validate-rules)).

Limits declared with `validate` are enforced by Make's value check wherever it runs (messages in [schema-behaviour.md § Verbatim messages](schema-behaviour.md#verbatim-messages)), so declaring vendor length and range limits has an effect. Where the check does not run they are only hints: the converter writes numeric bounds and `pattern` into the schema, and text length bounds as `minimum` and `maximum`. Team convention: always check the third-party API documentation for input constraints (string length limits, numeric ranges, format patterns) and apply `validate` (for example `"validate": { "min": 0, "max": 100 }`) wherever the API enforces limits. Do not skip validation just because the module does not have it.

**A child's `required` in an optional collection.** When a parent collection is optional but its child field is required once the collection is present, add a help note such as `"Required when {parent} is provided."` Whether to remove `required` from the child is a choice by consumer. Removing it stops Make's form from forcing the user to fill in the child when the parent is not wanted, but that is the only place the problem exists. Make's value check, the public validator and the converter already treat a child's `required` as "required when the collection is present", so removing it throws away machine-readable information for programmatic callers. Keep `required` where callers read the schema, and drop it only where a person fills in the form. Add the help note either way.

**`mode`** is not module-specific: it is a property of the parameters that have a Map switch (`select`, `boolean`, `array` and similar), in a module's settings and in any other form built from a spec. It is the initial pick or map display: `edit` is an old name for `map`, and in a form shown to a person the field opens in formula mode. Text-like types, `date`, `time` and `collection` ignore it ([parameters-reference.md § Start mode, map-mode help and label (`mode`, `mappable` object)](../parameters-reference.md#start-mode-map-mode-help-and-label-mode-mappable-object)). It has no effect on Make's value check or on the converted schema (`mode: edit` included), so it carries nothing for callers.

**Dependent parameters.** A parameter can be nested under a `select` option, under `options.nested` (for all options) or under a `boolean`. Make's value check treats these unevenly:

| Shape | Make's value check |
|---|---|
| `options.nested` (nested fields for all options) | validated and converted when the parent is set |
| a `boolean`'s `nested` list | validated and converted when the parent is set and the value is true |
| per-option `nested` (`options: [{ value, nested: [...] }]`) | not validated at all |
| a boolean's two-branch form `nested: { true: [...], false: [...] }` | not validated at all |
| a field-level `nested` on a `select` or `text` | not validated at all |

"Not validated at all" means a missing required nested field passes, and a text `3` stays text. The public converter turns per-option nested fields into conditional schema, and the public validator does validate them (and a boolean's `nested` list whatever the value is). Details: [parameters-reference/select-and-rpc-options.md § Which nested set is shown](../parameters-reference/select-and-rpc-options.md#which-nested-set-is-shown), [parameters-reference.md § Conditional fields on a boolean (`nested`)](../parameters-reference.md#conditional-fields-on-a-boolean-nested) and [schema-behaviour.md § Nested fields](schema-behaviour.md#nested-fields).

Team convention: when API parameters have values that are only valid for a specific parent option (for example different sub-parameters depending on a `type` selector), prefer nesting them under a `select` plus `nested` structure when the number of dependent values is manageable. The converted schema then carries the dependency for AI callers, even though Make's value check does not validate per-option nested fields. If nesting would be too complex or the nested values too many, a flat schema with clear `help` text that explains the dependencies is acceptable, but nesting is preferred for AI caller clarity.

## Naming, order and formatting conventions

Team conventions unless a line says what Make does.

- **List endpoint parameter order.** Place filtering and search parameters first, followed by ordering, pagination and sync parameters (for example `pageToken`, `maxResults`, `orderBy`, `syncToken`) at the end. What Make does with the order: the spec order is the property order of the converted schema.
- **PATCH endpoint context.** Always include a note advising AI callers to perform a GET first to retrieve the current values, because omitted fields may be cleared.
- **Standard formatting.** Put each property on its own line with 4-space indentation in `api`, `params` and schema definitions. Do not cram several properties onto one line.
- **Parameter naming consistency.** The `name` of every parameter within one endpoint follows one casing convention, typically the third-party API's: `snake_case` when the API uses `snake_case`, `camelCase` when it uses `camelCase`. Do not mix conventions within one endpoint schema. Example: Canva's API uses `snake_case` (`attached_to.design_id`), so endpoint parameters are `attached_to` and `design_id`, not `designId`.
  - Names are used verbatim as keys: they are case-sensitive and nothing renames them. Two entries with the same name in one collection are one value (**Make enforces**): Make's form keeps them in sync, Make's value check validates the one value against both specs in turn (the second sees the first's converted result), the public converter keeps only the first definition, and the public validator validates the value against both, so differing types conflict. Parameters meant to be different therefore need different names.
  - When you create extra parameters for disambiguation (for example two API fields named `quality` for different contexts), wire every extra parameter correctly in `api.imljson`, in both directions: every input parameter is mapped to the API request, and it is mapped to the correct vendor field name, not to the disambiguation name. Sending a field name the API does not recognise (because the endpoint uses a renamed parameter but sends the renamed name instead of the original) causes silent failures or 400 errors.
- **Deprecated or removed API operations and parameters.** Before implementing any endpoint, verify the status of the target API operation in the vendor's current documentation. Do not implement endpoints for operations that are deprecated, removed or flagged for sunset when a newer replacement exists: implement the replacement, or flag the deprecation to the user before proceeding. If a module wraps a deprecated operation and a newer one is documented, prefer the newer operation for the endpoint even if the module has not been updated yet. Example: Canva's `createCommentReply` used a legacy `/comments/{id}/replies` path that returned 404, and the current API uses a different endpoint. Likewise, drop individual request parameters marked `[OBSOLETE]`, `Deprecated` or `Reserved` in the vendor's OpenAPI or docs (`MaxPrice`, `ForceDelivery` in Twilio `createMessage`) from both `input_parameters` and `api.imljson`.
- **Context file freshness.** Whenever an endpoint is modified, disabled, or changes behaviour during development, check whether any other endpoint's `context.md` references it (for example "use `getCalendar` first to retrieve current values before calling `updateCalendar`") and update those references. Context files go stale when endpoints are renamed, removed or change semantics. This applies to every cross-reference between endpoints: helper endpoints, prerequisite calls and related operations mentioned in usage notes.

## Descriptions copied from vendor docs

Vendor OpenAPI prose is written for a different caller than yours. Check each copied description against the endpoint it ends up in.

- **Type, `help` and `api.imljson` agree on the input format.** When Make's value check runs, a `text` parameter converts what it receives: a number or boolean becomes its text (`5`, `true`), an object becomes its JSON text (`{"a":1}`), and a list becomes its items joined with a comma and a space (`a, b`, not JSON). `any` keeps an object as an object. The `json` type is not a JSON parser: it turns any value into text with plain string conversion, so an object becomes `[object Object]` and invalid JSON text is not rejected. The public validator is strict instead: a number for `text` fails with `Expected type 'string', got type 'number'.` What this means for copied text:
  - If `api.imljson` serialises an object parameter with the IML function that turns an object into JSON text (`createJSON()` is the built-in one) and the input is `type: any`, remove copied vendor notes that say the value "must be passed as a string" (they cause double-encoding) and say to pass a JSON object.
  - In a `type: urlencoded` request, the body encoding writes a nested object as an empty value (`param=`). If a JSON-valued field is `type: text` and is not serialised in `api.imljson`, say in `help` that a JSON string is expected, with an example (for example `{"1":"Tom"}`).
  - Remove vendor notes that tell callers to URL-encode characters such as `#` by hand (`SendDigits` in `createCall`) when `type: urlencoded` or `qs` already encodes the value, which would turn `%23` into `%2523`.
  - When a vendor filter with inline operators (`<=YYYY-MM-DD`, `>=YYYY-MM-DD`) is split into separate parameters (`DateSentBefore` becomes `DateSent<`), strip the operator syntax from `help` so callers pass a plain date.

  Platform note: how a request body and query string are encoded belongs to the runtime request building ([runtime-reference.md § body and type](../runtime-reference.md#body-and-type), [§ qs](../runtime-reference.md#qs)); this file covers the form-library side.
- **Conditionally required parameter groups.** The parameter spec has no property that says "at least one of these parameters is required" or "these two are mutually exclusive": `required` is per parameter and independent. When the API requires one of several optional parameters (for example `Url`, `Twiml` or `ApplicationSid` in `createCall`), write the rule in the `help` of those fields ([app-ux-best-practices.md § Conditionally required fields](../app-ux-best-practices.md#required-vs-optional-fields)) and in `context.md`, so AI callers do not omit all of them.
- **Sibling parameter references and shared descriptions.** Vendor OpenAPI prose often refers to sibling parameters in a different casing or under a stale name (for example `application_sid`, `status_callback` and `send_time` when the schema names are `ApplicationSid`, `StatusCallback` and `SendAt`), and it reuses the same property description across request and response schemas (`From` input and `from` / `messages[].from` outputs). Normalise sibling parameter references in `help` to the exact `name` in `input_parameters.imljson`. When you fix a dead link or a stale term in a copied description, search all `endpoints/*/{input_parameters,output_parameters}.imljson` files and `context.md` files.
- **No raw IML in `help` or `context.md`.** `help` text is shown literally: `{{connection.token}}` or `{{ifempty(a; b)}}` inside `help` is not evaluated and appears as typed. The only interpreted token in `label` and `help` is the localisation form `{{l:key@namespace}}`, which is for Make's own forms. The converter copies `help` into `description` without touching it. Replace `{{connection.*}}` and `{{ifempty(...)}}` with readable `{Placeholder}` tokens and prose.
- **Deduplicate `select` `options` and keep acronyms uppercase.** The converter does not de-duplicate option lists: repeated values give an `enum` with repeated entries, and repeated values with labels give a `oneOf` in which the same constant matches twice, so a value of that option fails the JSON Schema rule "exactly one of". Make's value check is unaffected by duplicates. Deduplicate `options` by `value`. Team convention: keep acronyms uppercase (`SIP`, `SID`, `URL`, `URI`, `ID`, `AMD`, `BYOC`, `MMS`, `SMS`, `OTP`, `ISO`) when converting names to Sentence case (`SipAuthUsername` becomes `SIP auth username`).
- **Format hints for string-typed dates and codes.** A `text` parameter has no date or code format check, and a format can only be enforced with `validate.pattern`. When the vendor takes a formatted date string as `type: text` (for example `YYYYMMDD` on `LastVerifiedDate`), include the required format in both `help` and `context.md`, and add a pattern if the API is strict. Using `date` for such a value would misread it: an all-digit text is taken as milliseconds.
