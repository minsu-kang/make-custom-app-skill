# Built-in IML Function Reference

Official docs: https://help.make.com/functions
Source: `@integromat/iml/lib/iml-documentation.js`

## General Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `if` | `if(expression; value1; value2)` | Returns value1 if condition is true, otherwise value2 |
| `ifempty` | `ifempty(value1; value2)` | Returns value1 if not empty, otherwise value2 |
| `switch` | `switch(expr; val1; result1; [val2; result2; ...]; [else])` | Returns result matching value |
| `get` | `get(object_or_array; path)` | Extracts value from object/array. Supports dot notation |
| `pick` | `pick(object; key1; [key2; ...])` | Extracts only specified keys from object |
| `omit` | `omit(object; key1; [key2; ...])` | Excludes specified keys from object |
| `equal` | `equal(value; value)` | Compares values |

Keywords: `null`, `true`, `false`, `erase`, `ignore`
Operators: `=`, `!=`, `&` (and), `|` (or)
Variables: `executionId`

## Text / Binary Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `length` | `length(text_or_buffer)` | String length / buffer size |
| `lower` | `lower(text)` | Convert to lowercase |
| `upper` | `upper(text)` | Convert to uppercase |
| `capitalize` | `capitalize(text)` | Capitalize first letter |
| `startcase` | `startcase(text)` | Capitalize first letter of each word |
| `trim` | `trim(text)` | Remove leading/trailing whitespace |
| `substring` | `substring(text; start; end)` | Extract substring |
| `indexOf` | `indexOf(string; value; [start])` | Return first position of value (-1 = not found) |
| `contains` | `contains(text; search)` | Check if text contains search string |
| `replace` | `replace(text; search; replacement)` | String/regex replacement |
| `split` | `split(text; separator; [keepEmpty])` | Split string into array |
| `join` | `join(array; separator)` | Join array into string |
| `base64` | `base64(text)` | Base64 encoding |
| `md5` | `md5(text)` | MD5 hash |
| `sha1` | `sha1(text; [encoding]; [key]; [keyEncoding])` | SHA1 hash/HMAC |
| `sha256` | `sha256(text; [encoding]; [key]; [keyEncoding])` | SHA256 hash/HMAC |
| `sha512` | `sha512(text; [encoding]; [key]; [keyEncoding])` | SHA512 hash/HMAC |
| `ascii` | `ascii(text; [removeDiacritics])` | Remove non-ASCII characters |
| `toString` | `toString(value)` | Convert to string |
| `toBinary` | `toBinary(value)` | Convert to binary |
| `encodeURL` | `encodeURL(text)` | URL encoding |
| `decodeURL` | `decodeURL(text)` | URL decoding |
| `stripHTML` | `stripHTML(text)` | Remove HTML tags |
| `escapeHTML` | `escapeHTML(text)` | Escape HTML tags |
| `escapeMarkdown` | `escapeMarkdown(text)` | Escape Markdown tags |
| `replaceEmojiCharacters` | `replaceEmojiCharacters(text; replacement)` | Replace emoji characters |

Keywords: `newline`, `tab`, `space`, `nbsp`, `emptystring`, `carriagereturn`
Variables: `uuid`

## Math Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `round` | `round(number)` | Round |
| `floor` | `floor(number)` | Floor |
| `ceil` | `ceil(number)` | Ceiling |
| `trunc` | `trunc(number; [decimals])` | Truncate decimal part |
| `abs` | `abs(number)` | Absolute value |
| `min` | `min(array) / min(val1; val2; ...)` | Minimum value |
| `max` | `max(array) / max(val1; val2; ...)` | Maximum value |
| `sum` | `sum(array) / sum(val1; val2; ...)` | Sum |
| `average` | `average(array) / average(val1; val2; ...)` | Average |
| `median` | `median(array) / median(val1; val2; ...)` | Median |
| `stdevS` | `stdevS(array)` | Sample standard deviation |
| `stdevP` | `stdevP(array)` | Population standard deviation |
| `parseNumber` | `parseNumber(number; decimalSeparator)` | String to number |
| `formatNumber` | `formatNumber(number; decimals; [decSep]; [thousandSep])` | Number formatting |

Operators: `+`, `-`, `*`, `/`, `%`, `<`, `>`, `<=`, `>=`
Variables: `pi`, `random`

## Date / Time Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `parseDate` | `parseDate(date; format; [timezone])` | Parse string to date |
| `formatDate` | `formatDate(date; format; [timezone])` | Format date to string |
| `addSeconds` | `addSeconds(date; number)` | Add seconds (negative to subtract) |
| `addMinutes` | `addMinutes(date; number)` | Add minutes |
| `addHours` | `addHours(date; number)` | Add hours |
| `addDays` | `addDays(date; number)` | Add days |
| `addMonths` | `addMonths(date; number)` | Add months |
| `addYears` | `addYears(date; number)` | Add years |
| `setSecond` | `setSecond(date; number)` | Set second (0-59) |
| `setMinute` | `setMinute(date; number)` | Set minute (0-59) |
| `setHour` | `setHour(date; number)` | Set hour (0-23) |
| `setDate` | `setDate(date; number)` | Set day (1-31) |
| `setDay` | `setDay(date; number_or_name)` | Set weekday (Sun=1~Sat=7 or English name) |
| `setMonth` | `setMonth(date; number_or_name)` | Set month (1-12 or English name) |
| `setYear` | `setYear(date; number)` | Set year |

Variables: `now` (current time), `timestamp` (Unix timestamp)

## Array Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `length` | `length(array)` | Array length |
| `add` | `add(array; val1; val2; ...)` | Add values to array |
| `remove` | `remove(array; val1; val2; ...)` | Remove values from array |
| `join` | `join(array; separator)` | Array to string |
| `map` | `map(array; key; [filterKey]; [filterValues])` | Extract key from complex array |
| `sort` | `sort(array; [order]; [key])` | Sort (asc/desc/asc ci/desc ci) |
| `reverse` | `reverse(array)` | Reverse order |
| `shuffle` | `shuffle(array)` | Random shuffle |
| `slice` | `slice(array; start; [end])` | Sub-array |
| `merge` | `merge(array1; array2; ...)` | Merge arrays |
| `flatten` | `flatten(array; [depth])` | Flatten nested arrays |
| `contains` | `contains(array; value)` | Check if array contains value |
| `distinct` | `distinct(array; [key])` | Remove duplicates |
| `deduplicate` | `deduplicate(array)` | Remove duplicates |
| `keys` | `keys(object)` | List of object/array keys |
| `toCollection` | `toCollection(array; key; value)` | Array to collection |

Keywords: `emptyarray`

## Runtime Additional Functions (imt-app-runtime)

| Function | Signature | Description |
|----------|-----------|-------------|
| `jwt` | `jwt(payload, secret, alg?, options?)` | Generate JWT token |
| `generateJwtWithKeyId` | `generateJwtWithKeyId(payload, key, jwtAlg?, thumbAlg?, opts?)` | RFC7517 kid JWT |
| `cryptoSign` | `cryptoSign(algorithm, data, key, outputEncoding?)` | Cryptographic signing |
| `mime` | `mime(filename)` | Return MIME type |
| `parseJSON` | `parseJSON(string)` | Parse JSON |
| `createJSON` | `createJSON(object)` | Create JSON string |
| `parseXML` | `parseXML(string)` | Parse XML |
| `createXML` | `createXML(object)` | Create XML |
| `toDataStructure` | `toDataStructure(data, type?)` | Auto-generate data structure |
| `isArray` | `isArray(value)` | Check if value is array |
| `pop` | `pop(array)` | Remove/return last element |
| `shift` | `shift(array)` | Remove/return first element |
| `errorFactory` | `errorFactory(errorType, message)` | Create custom error |

## Important Notes

- In IMLJSON, the separator is comma (`,`), not semicolon (`;`). Semicolons are for the Make scenario UI only.
- `replace()` supports regex: `replace(text, '/regex/flags', replacement)`
- `contains()` works with both strings and arrays (overloaded)
- `length()` works with strings, arrays, and buffers
- `now` is a variable (not a function): `{{now}}`, `{{addDays(now, 7)}}`
