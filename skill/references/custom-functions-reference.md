# Custom IML Functions (functions/)

Write per-app custom JavaScript functions in `functions/{functionName}/code.js`. Call in IMLJSON with `{{functionName(args)}}`.

```
functions/
├── parseError/
│   ├── code.js    # function parseError(error) { ... }
│   └── test.js    # Test code
└── getOutput/
    ├── code.js    # function getOutput(item) { ... }
    └── test.js
```

Functions are written as plain JavaScript functions in `function functionName(args) { ... }` form. Executed within the IML sandbox at runtime.

> **⚠️ Size limit**: `code.js` has a **5000 character** hard limit enforced by the Make SDK API (error `IM005`). If a function exceeds this limit, reduce size by removing unnecessary comments, shortening variable names, or extracting logic into a separate helper function.

## test.js (Required)

Every IML function **must** have a `test.js` file. Tests use `it()` blocks with `assert`. The function is available globally (no import needed). Prefer `assert.deepStrictEqual` for objects/arrays, `assert.strictEqual` for primitives.

```js
it('should return expected result for valid input', () => {
	assert.deepStrictEqual(myFunction({ key: 'value' }), { expected: 'output' });
});

it('should handle null input gracefully', () => {
	assert.deepStrictEqual(myFunction(null), {});
});
```

Required test coverage:
- **Happy path**: Core functionality with typical inputs
- **Edge cases**: null, undefined, empty arrays/objects, missing optional fields
- **Type variations**: Different data types the function may encounter (string, number, boolean, array)

## Code Conventions (ES6+)

IML functions must follow ES6+ conventions. Reference the patterns below when writing `code.js`:

| Pattern | Use | Avoid |
|---|---|---|
| Variables | `const` / `let` | `var` |
| Strings | Template literals `` `Hello ${name}` `` | `'Hello ' + name` |
| Callbacks | Arrow functions `(x) => x.id` | `function(x) { return x.id; }` |
| Iteration | `.map()`, `.forEach()`, `.filter()`, `for...of` | `for (var i = 0; ...)` |
| Null checks | `value != null`, `value?.prop` | `value !== undefined && value !== null` |
| Destructuring | `const { alias, value } = entry` | `const alias = entry.alias; const value = entry.value;` |
| Default params | `function fn(opts = {})` | `opts = opts \|\| {}` |

Example (following conventions):

```js
function buildSelectQuery(parameters) {
    const selectParts = [];

    parameters.functions?.forEach((fn) => {
        const alias = fn.alias || `${fn.functionType.toLowerCase()}_${fn.columnId}`;
        selectParts.push(`{ type: FUNCTION, function: ${fn.functionType}, as: "${alias}" }`);
    });

    return `[${selectParts.join(', ')}]`;
}
```
