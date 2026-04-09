# Built-in IML Function Reference

Source: `@integromat/iml` package — `lib/functions.js`, `lib/operators.js`, `lib/keywords.js`, `lib/variables.js`, `lib/iml.js`
Official docs: https://help.make.com/functions

> In IMLJSON, the argument separator is comma (`,`). Semicolons (`;`) are for the Make scenario UI only.

## General Functions

| Function | Signature | Return Type | Description |
|----------|-----------|-------------|-------------|
| `if` | `if(expression, value1, value2)` | `*` | Returns value1 if expression is truthy, otherwise value2. Uses lazy evaluation — only the chosen branch is evaluated. |
| `ifempty` | `ifempty(value1, value2)` | `*` | Returns value1 if it's not empty (non-null, non-empty-string), otherwise value2. Uses lazy evaluation for value2. |
| `switch` | `switch(expr, val1, result1, [val2, result2, ...], [else])` | `*` | Compares expr against values using `String()` coercion. Returns matching result or else value. |
| `get` | `get(object_or_array, path)` | `*` | Extracts value from object/array using dot notation path. |
| `pick` | `pick(object, key1, [key2, ...])` | `collection` | Returns new object with only specified keys. |
| `omit` | `omit(object, key1, [key2, ...])` | `collection` | Returns new object excluding specified keys. |

Keywords: `null`, `true`, `false`, `erase` (alias of `null`), `ignore` (evaluates to `undefined`)
Variables: `executionId`

## Text / Binary Functions

| Function | Signature | Return Type | Description |
|----------|-----------|-------------|-------------|
| `length` | `length(text_or_buffer)` | `uinteger` | String character count or buffer byte size. Returns 0 for null. |
| `lower` | `lower(text)` | `text` | Convert to lowercase via `String.toLowerCase()`. |
| `upper` | `upper(text)` | `text` | Convert to uppercase via `String.toUpperCase()`. |
| `capitalize` | `capitalize(text)` | `text` | Capitalize first character only. |
| `startcase` | `startcase(text)` | `text` | Capitalize first letter of each word, lowercase the rest. |
| `trim` | `trim(text)` | `text` | Remove leading/trailing whitespace. |
| `substring` | `substring(text, start, end)` | `text` | Extract substring (same as JS `String.substring`). |
| `indexOf` | `indexOf(string, value, [start])` | `integer` | First position of value in string. Returns -1 if not found. |
| `contains` | `contains(text, search)` | `boolean` | Check if text contains search string. Also works on arrays (overloaded). Optional 3rd arg for case-insensitive. |
| `replace` | `replace(text, search, replacement)` | `text` | Replace occurrences. Supports regex: `replace(text, '/regex/flags', replacement)`. Without regex, replaces all occurrences (auto-escapes special chars). |
| `replaceEmojiCharacters` | `replaceEmojiCharacters(text, replacement)` | `text` | Replace all emoji characters with replacement string. Replacement is required. |
| `split` | `split(text, separator, [keepEmpty])` | `array` | Split string into array. Trims each element. Empty strings are removed unless keepEmpty is true. |
| `join` | `join(array, separator)` | `text` | Join array elements into string. Default separator: `,`. |
| `base64` | `base64(text)` | `text` | Base64 encoding. |
| `md5` | `md5(text)` | `text` | MD5 hash (hex). |
| `sha1` | `sha1(text, [encoding], [key], [keyEncoding])` | `text` | SHA1 hash or HMAC. Encoding: `hex`(default)/`base64`/`latin1`. Key encoding: `text`(default)/`hex`/`base64`/`binary`. |
| `sha256` | `sha256(text, [encoding], [key], [keyEncoding])` | `text` | SHA256 hash or HMAC. Same encoding options as sha1. |
| `sha512` | `sha512(text, [encoding], [key], [keyEncoding])` | `text` | SHA512 hash or HMAC. Same encoding options as sha1. |
| `ascii` | `ascii(text, [removeDiacritics])` | `text` | Remove non-ASCII characters. If removeDiacritics is true, normalizes diacritics first (e.g., `ě` → `e`). |
| `toString` | `toString(value)` | `text` | Convert to string. Arrays become comma-joined, dates become ISO string, objects become `{object}`. Optional 2nd arg for buffer encoding. |
| `toBinary` | `toBinary(value, [encoding])` | `buffer` | Convert to binary buffer. Encoding: `utf8`(default)/`ascii`/`hex`/`base64`/`binary`. |
| `encodeURL` | `encodeURL(text)` | `text` | URL encoding via `encodeURIComponent()`. |
| `decodeURL` | `decodeURL(text)` | `text` | URL decoding via `decodeURIComponent()`. |
| `stripHTML` | `stripHTML(text)` | `text` | Remove HTML tags. Also removes `<style>` and `<script>` content. Converts `<br>` to newline. |
| `escapeHTML` | `escapeHTML(text)` | `text` | Escape `&`, `<`, `>` to HTML entities. |
| `escapeMarkdown` | `escapeMarkdown(text)` | `text` | Escape Markdown special characters (`#`, `*`, `_`, `` ` ``, `|`, etc.). |

Keywords: `newline`, `tab`, `space`, `nbsp`, `emptystring`, `carriagereturn`
Variables: `uuid` (RFC 4122 v4 random UUID)

### `emptystring` Behavior

`emptystring` is NOT a primitive empty string `""`. Internally it uses `new String('')` (String object) as a special symbol. A primitive empty string `""` represents null in IML — `emptystring` is the way to explicitly set a field to empty text without it being treated as null.

## Math Functions

| Function | Signature | Return Type | Description |
|----------|-----------|-------------|-------------|
| `round` | `round(number)` | `integer` | Round to nearest integer. |
| `floor` | `floor(number)` | `integer` | Round down. |
| `ceil` | `ceil(number)` | `integer` | Round up. |
| `trunc` | `trunc(number, [decimals])` | `number` | Truncate decimal part. Positive decimals: keep N decimal places. Negative decimals: zero out trailing digits (e.g., `trunc(123, -2)` → `100`). |
| `abs` | `abs(number)` | `number` | Absolute value. |
| `min` | `min(array) / min(val1, val2, ...)` | `number` | Minimum value. Filters non-numbers before computing. |
| `max` | `max(array) / max(val1, val2, ...)` | `number` | Maximum value. Filters non-numbers before computing. |
| `sum` | `sum(array) / sum(val1, val2, ...)` | `number` | Sum. Skips non-numbers. |
| `average` | `average(array) / average(val1, val2, ...)` | `number` | Arithmetic mean. Skips non-numbers. |
| `median` | `median(array) / median(val1, val2, ...)` | `number` | Median value. Returns null for empty input. |
| `stdevS` | `stdevS(val1, val2, ...)` | `number` | Sample standard deviation (divides by N-1). |
| `stdevP` | `stdevP(val1, val2, ...)` | `number` | Population standard deviation (divides by N). |
| `parseNumber` | `parseNumber(number, decimalSeparator)` | `number` | Parse string to number. Separator must be `,` or `.` (default `.`). |
| `formatNumber` | `formatNumber(number, decimals, [decSep], [thousandSep])` | `text` | Format number. Default decSep: `,`, default thousandSep: `.`. |

Variables: `pi` (3.14159...), `random` (0 ≤ x < 1, new value each evaluation)

## Date / Time Functions

| Function | Signature | Return Type | Description |
|----------|-----------|-------------|-------------|
| `parseDate` | `parseDate(date, [format], [timezone])` | `date` | Parse string/number to Date. Without format: auto-detect. `'X'` = Unix seconds, `'x'` = Unix milliseconds. |
| `formatDate` | `formatDate(date, [format], [timezone])` | `text` | Format date to string via `moment.format()`. **Always returns a string**, even for numeric formats like `'X'`. Default format: `YYYY-MM-DDTHH:mm:ss.SSSZ`. |
| `dateDiff` | `dateDiff(endDate, startDate, unit)` | `number` | Difference between dates. Units: `D` (days), `H` (hours), `m` (minutes), `s` (seconds), `RH` (residual hours), `Rm` (residual minutes), `Rs` (residual seconds). Throws if startDate > endDate. |
| `addSeconds` | `addSeconds(date, number)` | `date` | Add seconds (negative to subtract). |
| `addMinutes` | `addMinutes(date, number)` | `date` | Add minutes. |
| `addHours` | `addHours(date, number)` | `date` | Add hours. |
| `addDays` | `addDays(date, number)` | `date` | Add days. |
| `addMonths` | `addMonths(date, number)` | `date` | Add months. |
| `addYears` | `addYears(date, number)` | `date` | Add years. |
| `setSecond` | `setSecond(date, number)` | `date` | Set second (0-59, overflows allowed). |
| `setMinute` | `setMinute(date, number)` | `date` | Set minute (0-59, overflows allowed). |
| `setHour` | `setHour(date, number)` | `date` | Set hour (0-23, overflows allowed). |
| `setDate` | `setDate(date, number)` | `date` | Set day of month (1-31, overflows allowed). |
| `setDay` | `setDay(date, number_or_name)` | `date` | Set weekday. Number: Sun=1 ~ Sat=7. Also accepts English names (`monday`, `tue`, etc.). |
| `setMonth` | `setMonth(date, number_or_name)` | `date` | Set month. Number: 1-12. Also accepts English names (`january`, `feb`, etc.). |
| `setYear` | `setYear(date, number)` | `date` | Set year. |

Variables: `now` (current Date object), `timestamp` (current Unix timestamp in seconds, integer)

### `formatDate` Return Type

`formatDate()` always returns a **string** via `moment.format()`. Even numeric format tokens return strings:
- `formatDate(date, 'X')` → `"1234567890"` (string), not `1234567890` (number)
- `formatDate(date, 'x')` → `"1234567890000"` (string)

This matters for comparisons — see [Operator Aliases](#operator-aliases-alt_ops) for why `formatDate(date, 'X') === 0` still works.

### `dateDiff` Unit Reference

| Unit | Description | Example: 2d 3h 45m |
|------|-------------|---------------------|
| `D` | Total days | 2 |
| `H` | Total hours | 51 |
| `m` | Total minutes | 3105 |
| `s` | Total seconds | 186300 |
| `RH` | Residual hours (after removing full days) | 3 |
| `Rm` | Residual minutes (after removing full hours) | 45 |
| `Rs` | Residual seconds (after removing full minutes) | 0 |

## Array Functions

| Function | Signature | Return Type | Description |
|----------|-----------|-------------|-------------|
| `length` | `length(array)` | `uinteger` | Array length. Returns 0 for null. |
| `add` | `add(array, val1, val2, ...)` | `array` | Returns new array with values appended. Does not mutate original. |
| `remove` | `remove(array, val1, val2, ...)` | `array` | Remove values from array. Only works on primitive values (string/number/boolean/null). |
| `join` | `join(array, separator)` | `text` | Join array elements into string. |
| `map` | `map(array, key, [filterKey], [filterValues])` | `array` | Extract values by key from complex array. Optional filter: `map(items, 'name', 'type', 'active,pending')`. |
| `sort` | `sort(array, [order], [key])` | `array` | Sort. Order: `asc`(default)/`desc`/`asc ci`/`desc ci`. Supports dot notation key for nested properties. |
| `reverse` | `reverse(array)` | `array` | Reverse array order. Returns new array. |
| `shuffle` | `shuffle(array)` | `array` | Random shuffle. Returns new array. |
| `slice` | `slice(array, start, [end])` | `array` | Sub-array extraction (same as JS `Array.slice`). |
| `merge` | `merge(array1, array2, ...)` | `array` | Concatenate arrays. Filters out non-array arguments. |
| `flatten` | `flatten(array, [depth])` | `array` | Flatten nested arrays. Default depth: 1. |
| `contains` | `contains(array, value)` | `boolean` | Check if array contains value. Optional 3rd arg for case-insensitive comparison. |
| `distinct` | `distinct(array, [key])` | `array` | Remove duplicates. For objects: uses deep equality. For primitives: compares via `String()`. Optional key for complex arrays. |
| `deduplicate` | `deduplicate(array)` | `array` | Alias of `distinct`. |
| `keys` | `keys(object)` | `array` | Returns array of object keys (or array indices). |
| `toCollection` | `toCollection(array, key, value)` | `collection` | Convert array of `{key, value}` objects to a single object. |
| `toArray` | `toArray(collection)` | `array` | Convert object to array of `{key, value}` objects. If input is already an array, maps to `{key: index, value}`. |
| `first` | `first(array)` | `*` | Returns first element of array (`array[0]`). |
| `last` | `last(array)` | `*` | Returns last element of array (`array[array.length - 1]`). |

Keywords: `emptyarray` (creates new empty `[]` each time — safe for mutation patterns like `merge(temp.arr || emptyarray, newItems)`)

## Operators

Source: `@integromat/iml/lib/operators.js`, `@integromat/iml/lib/iml.js` (ALT_OPS)

### Operator List

| Operator | Group | Precedence | JS Equivalent | Description |
|----------|-------|------------|---------------|-------------|
| `!` | general | 16 | `!a` | Logical NOT (unary, hidden) |
| `*` | math | 14 | `Decimal(a).times(b)` | Multiplication (arbitrary precision) |
| `/` | math | 14 | `Decimal(a).dividedBy(b)` | Division (arbitrary precision) |
| `%` | math | 14 | `Decimal(a).modulo(b)` | Modulo (arbitrary precision) |
| `+` | math | 13 | see below | Addition or string concatenation (auto-detected) |
| `++` | math | 13 | `Number(a) + Number(b)` | Forced numeric addition |
| `-` | math | 13 | `Number(a) - Number(b)` | Subtraction |
| `<` | math | 11 | `a < b` | Less than |
| `<=` | math | 11 | `a <= b` | Less than or equal |
| `>` | math | 11 | `a > b` | Greater than |
| `>=` | math | 11 | `a >= b` | Greater than or equal |
| `=` | general | 10 | `a == b` | Equality (**loose**, type coercion) |
| `!=` | general | 10 | `a != b` | Inequality (**loose**, type coercion) |
| `&` | general | 6 | `a && b` | Logical AND |
| `\|` | general | 5 | `a \|\| b` | Logical OR |

### Operator Aliases (ALT_OPS)

The IML parser normalizes JavaScript-style operators to IML operators:

| Written in code | Parsed as | Behavior |
|-----------------|-----------|----------|
| `===` | `=` | **Loose equality** (`==`), NOT strict |
| `!==` | `!=` | **Loose inequality** (`!=`), NOT strict |
| `==` | `=` | Loose equality |
| `&&` | `&` | Logical AND |
| `\|\|` | `\|` | Logical OR |

**`===` does NOT perform strict equality in IML.** It is silently converted to `=`, which uses JavaScript's `==` (loose equality with type coercion). For example, `"0" === 0` in IML evaluates to `true` because it actually runs `"0" == 0`.

### `+` Operator Behavior

The `+` operator auto-detects types:
- Both operands are numbers → numeric addition via `Decimal.plus` (arbitrary precision)
- Either operand is a string → string concatenation
- One operand is `null` → returns the non-null operand (if it's a primitive type)
- Both operands are `null` → returns `null`

Use `++` to force numeric addition regardless of operand types.

### `*`, `/`, `%` Precision

Math operators use `Decimal.js` for arbitrary-precision arithmetic. This avoids floating-point issues (e.g., `0.1 + 0.2 = 0.3`, not `0.30000000000000004`).

## Keywords Reference

Source: `@integromat/iml/lib/keywords.js`

| Keyword | Group | Type | Value | Notes |
|---------|-------|------|-------|-------|
| `true` | general | boolean | `true` | |
| `false` | general | boolean | `false` | |
| `null` | general | * | `null` | |
| `erase` | general | * | `null` | Alias of `null`. Sets field to empty value. |
| `ignore` | general | * | `undefined` | Instructs engine to treat field as unmapped. |
| `emptystring` | string | text | `new String('')` | NOT primitive `""`. See [emptystring behavior](#emptystring-behavior). |
| `emptyarray` | array | * | `[]` | Creates new empty array each invocation. Safe for mutation patterns. |
| `space` | string | text | `' '` | |
| `nbsp` | string | text | `\xA0` | Non-breaking space. |
| `tab` | string | text | `\t` | |
| `newline` | string | text | `\n` | |
| `carriagereturn` | string | text | `\r` | |

## Variables Reference

Source: `@integromat/iml/lib/variables.js`

| Variable | Group | Type | Description |
|----------|-------|------|-------------|
| `now` | date | date | Current Date object. New value each evaluation. |
| `timestamp` | date | uinteger | Current Unix timestamp in seconds (`Math.floor(Date.now() / 1000)`). |
| `uuid` | string | text | RFC 4122 v4 random UUID. New value each evaluation. |
| `pi` | math | number | Mathematical constant π (3.141592653589793). |
| `random` | math | number | Random float 0 ≤ x < 1. New value each evaluation. |
| `executionId` | general | text | ID of the current scenario execution (injected by runtime). |

## Runtime Additional Functions (imt-app-runtime)

These are NOT in the `@integromat/iml` package. They are injected by the Make app runtime.

| Function | Signature | Description |
|----------|-----------|-------------|
| `jwt` | `jwt(payload, secret, alg?, options?)` | Generate JWT token. Default alg: `HS256`. |
| `generateJwtWithKeyId` | `generateJwtWithKeyId(payload, key, jwtAlg?, thumbAlg?, opts?)` | Generate JWT with RFC7517 kid header. |
| `cryptoSign` | `cryptoSign(algorithm, data, key, outputEncoding?)` | Cryptographic signing. Default outputEncoding: `hex`. |
| `mime` | `mime(filename)` | Return MIME type from filename. |
| `parseJSON` | `parseJSON(string)` | Parse JSON string to object. |
| `createJSON` | `createJSON(object)` | Convert object to JSON string. |
| `parseXML` | `parseXML(string)` | Parse XML string to object. |
| `createXML` | `createXML(object)` | Convert object to XML string. |
| `toDataStructure` | `toDataStructure(data, type?)` | Auto-generate data structure. Default type: `json`. |
| `isArray` | `isArray(value)` | Check if value is array. |
| `pop` | `pop(array)` | Remove and return last element of array. |
| `shift` | `shift(array)` | Remove and return first element of array. |
| `errorFactory` | `errorFactory(errorType, message)` | Create custom error. See SKILL.md for available error types. |
