<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# Component Integration Test Guide

## When to Read This

Read this reference when you need to:
- **Run component tests** after modifying `api.imljson`, custom IML functions, or any component code
- **Write or edit `test.js` fixtures** in the `make-apps-mockup` repo for new or changed components
- **Debug test failures** — understand error messages, trace runtime behavior, identify root causes
- **Understand the test pipeline** — how `test-component.js` delegates to `make-apps-mockup`, how test discovery works, how assertions are made

This is the primary reference for anything related to the `make-apps-mockup` repository and component testing. For runtime middleware internals (temp, iterate, output, pagination, etc.), see [runtime-reference.md](runtime-reference.md).

## Overview

Component tests verify that IMLJSON `api.imljson` definitions produce correct output when executed through the `imt-app-runtime`. Tests replay pre-recorded HTTP interactions (mocks) and assert the final output via `assert.deepStrictEqual`.

All tests run inside the **`make-apps-mockup`** repository. This skill provides `test-component.js` as a convenience wrapper.

## How to Run

```bash
node ${SKILL_ROOT}/scripts/test-component.js <app-slug> <app-version> <component-type> [component-name ...] [--format=console|json] [--debug]
```

| Option | Description |
|---|---|
| `component-type` | `module`, `rpc`, `connection`, `webhook` |
| `--format=json` | Structured JSON output (recommended for AI agent parsing) |
| `--debug` | Show actual HTTP request payloads sent by the runtime |

Examples:
```bash
node ${SKILL_ROOT}/scripts/test-component.js monday 2 module                    # all modules
node ${SKILL_ROOT}/scripts/test-component.js monday 2 module CreateItemV2       # one module
node ${SKILL_ROOT}/scripts/test-component.js monday 2 rpc listBoards getUsers   # multiple RPCs
node ${SKILL_ROOT}/scripts/test-component.js monday 2 module --format=json      # JSON for AI
```

## How It Works

`test-component.js` delegates to the **`make-apps-mockup`** repository:

1. Reads `make-apps-mockup-path` from the last lines of SKILL.md to locate the repo
2. Loads `MAKE_API_KEY` from the repo's `.env`
3. Runs `npx ts-node main.ts run {slug} {version} {componentType} [names] ...` inside the `make-apps-mockup` directory

### `make-apps-mockup` Architecture

```
make-apps-mockup/
├── main.ts                          # CLI entry — dotenv, MAKE_API_KEY check, 4 Commander subcommands
├── install-app-runtime.ts           # postinstall — git-clones imt-app-runtime at pinned version
├── lib/
│   ├── adapters/
│   │   ├── api-adapter.ts           # Fetches app definition from eu1.make.com/api/v2/
│   │   └── local-adapter.ts         # Loads from local app context directory
│   ├── core/
│   │   ├── test-runner.ts           # Main orchestrator — component discovery, test execution, assertion
│   │   ├── test-parser.ts           # Parses test.js in VM sandbox, extracts TestCase[]
│   │   └── output-normalizer.ts     # normalizeParameters, transformOutput, normalizeCommunications
│   ├── executors/
│   │   ├── module-executor.ts       # action/search/trigger/instant/responder
│   │   ├── rpc-executor.ts          # RPC execution
│   │   ├── connection-executor.ts   # basic/oauth2 connection testing
│   │   ├── webhook-executor.ts      # webhook parse testing
│   │   └── hook-rpc-executor.ts     # attach/detach/update hook RPCs
│   ├── reporters/
│   │   ├── console-reporter.ts      # Human-readable colored output
│   │   └── json-reporter.ts         # Single JSON blob (used by CI and --format=json)
│   └── utils/
│       └── imt-app-runtime/         # git-cloned runtime (version pinned in package.json)
└── data/                            # Test fixtures
    └── {app-slug}/v{version}/
        ├── modules/{ComponentName}/test.js
        ├── rpcs/{ComponentName}/test.js
        ├── connections/{ComponentName}/test.js
        └── webhooks/{ComponentName}/test.js
```

### Execution Pipeline

1. **Adapter** fetches app definition (base code, component list, custom IML functions) from Make API or local directory
2. **TestRunner** filters components: `public !== false` for modules; CLI names intersected with available components
3. For each component, loads `test.js` from `data/` — skipped if file missing or no `capture()` call
4. **TestParser** runs `test.js` in a Node VM sandbox, extracting `TestCase[]` via injected `it()` + `capture()`
5. **Executor** (module/rpc/connection/webhook) creates runtime instance, sets recordings from `communications`, runs `initialize()` → `write/read/execute/parse`
6. **Assertion**: `assert.deepStrictEqual(transformOutput(result), expectedOutput)`
7. **Reporter** (console or JSON) outputs results

Key implications:
- **App code is fetched live from Make** — changes must be uploaded to Make before tests reflect the latest code
- **Test fixtures live in `make-apps-mockup`** — create/edit `test.js` files under `make-apps-mockup/data/...`, not in the app context folder
- **Runtime is bundled inside `make-apps-mockup`** — debug logs must be placed in `make-apps-mockup/lib/utils/imt-app-runtime/`, not in a separate clone

### imt-app-runtime Version Pinning

The runtime version is controlled by `"imt-app-runtime-version"` in `package.json` (e.g., `"1.94.3"`). The `postinstall` script (`install-app-runtime.ts`) git-clones the repo at that tag into `lib/utils/imt-app-runtime/`, then runs `npm i` in the root and 5 subdirectories. To update: change the version string and run `npm i`.

## Test File Structure

Path (inside `make-apps-mockup`): `data/{app-slug}/v{version}/{modules|rpcs|connections|webhooks}/{ComponentName}/test.js`

Each `test.js` runs in a Node VM sandbox (5s timeout) with `it()` and `capture()` injected. No imports, no test framework.

```js
it('Module: myModule', () => {
    const parameters = {
        __IMTCONN__: { accessToken: 'xxx' },
        // module inputs
    };
    const data = {};
    const common = {};
    const metadata = { expect: [] };
    const communications = [ /* {req, res} pairs */ ];
    const output = [ /* expected output */ ];

    capture(parameters, communications, output, data, common, metadata);
});
```

Multiple `it()` blocks per file allowed — each is a separate test case keyed by its description string.

### `capture()` Signature

```
capture(parameters, communications, output, data, common, metadata, environment, options)
```

| Argument | Purpose |
|---|---|
| `parameters` | Module/RPC inputs. Must include `__IMTCONN__` with fake auth |
| `communications` | Ordered `[{req, res}]` HTTP mocks, replayed positionally |
| `output` | Expected result — compared via `assert.deepStrictEqual` after `transformOutput()` |
| `data` | Trigger state — `{ epoch: { id, date, type } }` or `{ lastDate, lastId }` |
| `common` | Shared module data (usually `{}`) |
| `metadata` | `{ expect: [] }` in current tests |
| `environment` | Scenario environment (usually `{}`) |
| `options` | Extra options — e.g., `{ payload: {...} }` for instant trigger gateway simulation |

### Test Patterns by Component Type

**Module (action/search/trigger)**:
```js
it('Module: createItem', () => {
    const parameters = { __IMTCONN__: { accessToken: 'xxx' }, name: 'Test' };
    const communications = [
        { req: { url: '...', method: 'POST', ... }, res: { statusCode: 200, ... } }
    ];
    const output = [{ id: '1', name: 'Test' }];
    capture(parameters, communications, output, {}, {}, { expect: [] });
});
```

**RPC (dropdown/dynamic fields)**:
```js
it('RPC: listProjects', () => {
    const parameters = { __IMTCONN__: { accessToken: 'xxx' } };
    const communications = [ /* ... */ ];
    const output = [
        { label: 'Project Alpha', value: 'proj_1' },
        { label: 'Project Beta', value: 'proj_2' },
    ];
    capture(parameters, communications, output, {}, {}, { expect: [] });
});
```

**Connection**:
```js
it('Connection: myApp', () => {
    const parameters = { apiKey: 'xxx' };
    const communications = [
        { req: { url: '...', method: 'GET', ... }, res: { statusCode: 200, ... } }
    ];
    const output = true;  // connection test just expects truthy
    capture(parameters, communications, output, {}, {}, { expect: [] });
});
```

**Webhook**:
```js
it('Webhook: myWebhook', () => {
    const parameters = {
        headers: { 'content-type': 'application/json' },
        query: {},
        body: { event: 'item.created', data: { id: '1' } },
        method: 'POST',
        rawBody: '{"event":"item.created","data":{"id":"1"}}',
    };
    const communications = [];  // webhooks typically don't make outbound calls
    const output = [{ id: '1', event: 'item.created' }];
    capture(parameters, communications, output, {}, {}, { expect: [] });
});
```

**Instant trigger with gateway payload**:
```js
it('InstantTrigger: watchNewEvents', () => {
    const parameters = { __IMTCONN__: { accessToken: 'xxx' } };
    const communications = [];
    const output = [{ id: '1', type: 'created' }];
    const options = {
        payload: { id: '1', type: 'created' }  // simulates gateway trigger data
    };
    capture(parameters, communications, output, {}, {}, { expect: [] }, {}, options);
});
```

## Communications Array

Each entry is a `{req, res}` pair matched **positionally** — the 1st HTTP call in the runtime consumes `communications[0]`, the 2nd consumes `communications[1]`, etc.

```js
{
    req: {
        url: 'https://api.example.com/v1/items',
        method: 'GET',
        headers: { 'user-agent': 'Integromat/local', authorization: 'Bearer xxx' },
        qs: { limit: 10 },
        gzip: false,
        timeout: 40000,
    },
    res: {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: { items: [{ id: '1', name: 'Test' }] },
    },
}
```

### Key Rules

- **Request matching**: The runtime asserts actual request URL matches `req.url` exactly. Mismatch → `"Request options changed"` error.
- **`res.body`**: Object for JSON responses (auto-stringified by test runner), raw string for `type: "raw"` responses.
- **`{{uuid}}`**: Replaced with an IML expression before execution so any UUID matches.
- **Body objects**: Plain objects in `req.body` are auto-stringified by the runner.
- **URL-less steps**: Communication steps without a `url` in `api.imljson` do NOT make HTTP requests and do NOT consume a `{req, res}` entry. Only count steps that have a `url` when building the communications array.

## Expected Output

### Modules

Arrays of objects. `transformOutput()` processes the raw result:
- `Date` → ISO string
- `undefined` properties → removed
- Nested arrays/objects → recursively transformed

### RPCs

Arrays of `{label, value}` for dropdowns, or structured objects.

### Error Output

To test expected errors (4XX/5XX), `output` can be either a **string** (message only) or an **object** (`errorType` + optional `message`).

**Option 1 — message only** (legacy, backwards-compatible):

```js
const output = '[404] Resource not found';
```

The runner asserts `err.message === output`.

**Option 2 — assert error class + message** (recommended for error-type-sensitive logic like 4XX vs 5XX handling):

```js
const output = {
    errorType: 'ConnectionError',
    message: '[503] Service Unavailable',
};
```

The runner asserts:
- `err.name === output.errorType` (always, when object form is used)
- `err.message === output.message` (only when `message` is provided)

Use object form whenever the test verifies a specific error **class** — for example, confirming that 5XX responses throw `ConnectionError` (triggering scenario-engine retry) rather than `RuntimeError`. Both forms go through the `imtExternalError` assertion path.

Valid `errorType` values come from `RUNTIME_ERROR_TYPES` in `test-runner.ts`: `DataError`, `RuntimeError`, `ConnectionError`, `RateLimitError`, `InvalidAccessTokenError`, `InvalidConfigurationError`, `DuplicateDataError`, `IncompleteDataError`, `MaxResultsExceededError`, `MaxFileSizeExceededError`, `ModuleTimeoutError`, `ScenarioTimeoutError`, `OperationsLimitExceededError`, `DataSizeLimitExceededError`, `ExecutionInterruptedError`, `InconsistencyError`, `OutOfSpaceError`, `UnknownError`, `UnexpectedError`, `Warning`.

## Test Discovery

The runner does NOT simply scan directories. The process is:

1. **Adapter** provides the app's official component list (from Make API or local metadata)
2. For modules: `public !== false` filter applied (explicitly non-public modules are skipped)
3. If CLI specifies component names → intersection with available components; otherwise → all filtered components
4. For each component: `data/{slug}/v{version}/{type}s/{name}/test.js` must exist — otherwise **skipped**
5. File must contain `capture(` — otherwise **skipped**
6. Matching executor must exist for the component type — otherwise **skipped**

### Generating Test Scaffolds

```bash
npm start generate-test {slug} {version}
```

Creates `test.js` templates for all public modules and all RPCs that don't have one yet. Does NOT generate connection or webhook scaffolds.

## Executor Types

| Component Type | Executor | Runtime Class | Method |
|---|---|---|---|
| `action` (typeId 4, 12) | ModuleExecutor | `ExecuteAction` | `write()` → `commit()` → `finalize()` |
| `search` (typeId 9) | ModuleExecutor | `ExecuteSearch` | `write()` → `commit()` → `finalize()` |
| `trigger` (typeId 1) | ModuleExecutor | `ExecuteTrigger` | `read()` |
| `instant` (typeId 10) | ModuleExecutor | `ExecuteHookTrigger` | `fetch()` + `read()` |
| `responder` (typeId 11) | ModuleExecutor | `ExecuteHookResponse` | `write()` |
| RPC | RpcExecutor | `ExecuteRpc` | `execute()` |
| Connection (basic) | ConnectionExecutor | Account | `test()` |
| Connection (oauth2) | ConnectionExecutor | OAuth2Account | `token()` / `refresh()` / `invalidate()` |
| Webhook | WebhookExecutor | Hook | `parse(req)` |

## CLI Commands

| Command | Purpose |
|---|---|
| `run` | Execute tests and assert output |
| `generate-test` | Create test.js scaffolds from live API |
| `show-requests` | Display actual HTTP request payloads (no assertion) |
| `show-output` | Display actual parsed output (no assertion) |

`show-requests` and `show-output` are useful for debugging — they show what the runtime actually produces without asserting.

## Runtime Behavior That Affects Tests

### Result Propagation Between Steps

The `communication` middleware iterates through the communication array sequentially. After each step:

```js
setImmediate(nextCommItem, currResult || prevResult);
```

`[]` is truthy in JavaScript. A step producing an empty array overwrites valid previous results. This causes silent empty-output bugs in multi-branch flows.

**Fix**: Add path guards to step conditions to prevent wrong-branch execution.

### `output: null` Suppresses Step Output

In `output.js`:
- `null` or `false` → `context.chain.end()` — suppresses output, terminates requester sub-chain
- `undefined` (not set) → raw response passes through as output

Steps with `"type": "raw"` that don't set `"output": null` leak their raw body (a string) as `currResult`. This causes:
- Search modules: `filter.search()` throws `"Invalid item in module output. Expected Object, but found String."`
- Any module: raw string overwrites valid previous results

### Filter Strictness by Component Type

| Component | Accepts | Rejects with DataError |
|---|---|---|
| Action | Object only | Array, String, etc. |
| Search | Object, Array\<Object\> | String |
| RPC | Object, String, Array\<Object\|String\> | Number, Boolean, etc. |

### URL-less Steps

Steps without `url`:
- Don't make HTTP requests — requester skips
- Don't consume `{req, res}` from communications
- Still execute `temp`, `response.temp`, `response.iterate`, `response.output`
- Can produce output affecting `currResult`

### `temp` Persistence

`temp` variables persist across ALL steps in the communication array. In multi-branch flows (same component handling different paths), earlier branch's temp values remain unless explicitly overwritten. This can cause cross-branch interference when step conditions rely on shared temp keys.

## Debugging Failed Tests

### "Request options changed"

The runtime's actual request doesn't match `communications[n].req`. Check:
- URL (exact match required)
- Query string parameters (`qs`)
- Headers (especially `content-type` for multipart)
- Request body (for POST/PUT)

Use `show-requests` to see what the runtime actually sends:
```bash
npm start show-requests {slug} {version} {type} {component}
```

### Empty output `[]`

A URL-less step's condition evaluated true when it shouldn't have. Check:
- Shared `temp` variables across branches causing unintended condition matches
- Missing path guards in step conditions

### "Expected Object, but found String"

A `type: "raw"` step is leaking its response body. Add `"output": null` to the step's `response` in `api.imljson`.

### Output mismatch (AssertionError)

Use `show-output` to see the actual parsed output:
```bash
npm start show-output {slug} {version} {type} {component}
```

### Adding Debug Logs to Runtime

The runtime used by tests is at `{make-apps-mockup}/lib/utils/imt-app-runtime/`. Use `process.stdout.write()` (not `console.log`) to avoid interference with test output parsing.

Key locations:
- `lib/core/chainMiddleware/communication.js` line 56 — log `currResult`/`prevResult` between steps
- `lib/core/middleware/filter.js` — log `result` to see what's being validated
- `lib/core/middleware/output.js` — log `descriptor` to see output directives

**Always clean up debug logs after fixing.**

## Environment Variables

| Variable | Purpose |
|---|---|
| `MAKE_API_KEY` | Required. Make API auth token |
| `IS_ADMIN` | `'true'` adds `admin` segment to API paths |
| `IMT_ENV` | e.g., `"local"` — appears in `user-agent` of HTTP recordings |
| `DEBUGGABLE` | Enables debug request logging in runtime |

## CI Integration

`.github/workflows/make-apps-ci.yml`:
- On PR: detects changed files under `data/**`, groups by slug/version/componentType, runs tests for each group with `--format=json`
- Failure detection: output contains `"status": "failed"` or `"error"`
- Posts results as PR comment with `<!-- make-apps-ci-results -->` marker (upserts)
- `workflow_dispatch`: accepts explicit inputs for manual runs
