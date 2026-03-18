---
name: make-custom-app
version: 1.6.2
description: Build and edit Make.com custom app IMLJSON code. Use when working with Make Internal App extension, editing IMLJSON files, creating modules, connections, RPCs, webhooks, or any Make custom app development. Triggers on imljson files, Make app references, or IML expressions.
---

# Make Custom App Development

> **⚠️ Top Priority Rule**: When a Make app/IMLJSON-related question comes in, **this SKILL.md file must be read before any other action.** Before reading or explaining file contents, this skill must be loaded first to follow the workflows and rules below. Skipping this step is not allowed.

## Version Check (Auto-Execute — Once Per Conversation)

**This check must run once when the skill is first loaded.** After the first check, skip it for subsequent uses in the same conversation.

1. Read the `version` field from the frontmatter above
2. Fetch the latest version info from: `https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/version.json`
3. Compare versions:
    - **If the installed version is OLDER than the latest version**: Display the warning below and **stop — do not answer the user's question until they upgrade**.
    - **If versions match**: Proceed normally.
    - **If the fetch fails** (network error, timeout): Proceed normally — do not block the user.

**Upgrade warning message (copy exactly):**

> ⚠️ **Make Custom App skill update required!**
>
> Installed version: `{installed_version}` → Latest version: `{latest_version}`
>
> Please run the following command in an **external terminal** (Cursor menu bar → Terminal → New Window):
>
> ```
> curl -fsSL https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install.sh | bash -s -- --update
> ```
>
> After updating, **restart Cursor** and ask your question again!

---

Skill for writing IMLJSON code for Make custom apps. Used in the Make Internal App (VS Code extension) environment.

Official docs: https://developers.make.com/custom-apps-documentation

## Workflows

When one of the following triggers is detected, read the corresponding workflow file and follow its instructions.

| Trigger Condition | Workflow File | Description |
|---|---|---|
| User asks about a specific Make app, or open file is in `sdk/apps/` | [app-context.md](workflows/app-context.md) | App detection, code download/sync, context management |
| User requests a code review | [code-review.md](workflows/code-review.md) | Fetch changes, perform review, generate report |
| User reports a bug or asks to investigate an error | [bug-investigation.md](workflows/bug-investigation.md) | Root cause analysis, fix, verify, developer notes |
| User requests a new feature or new component for a Make app | [feature-request.md](workflows/feature-request.md) | Design, create, implement new components |
| User requests app maintenance, UX updates, refactoring, or cleanup | [app-task.md](workflows/app-task.md) | Metadata changes, UX fixes, refactoring, deprecation |
| After context file create/update, Jira work, or code review | [pinecone-sync.md](workflows/pinecone-sync.md) | Auto-sync context to shared Pinecone vector DB |

## App Components

A Make app consists of the following components:

| Component      | IMLJSON Files                                                                                 | Description                                                                            |
| -------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Base**       | `base.imljson`                                                                                | Common settings inherited by all modules/RPCs (baseUrl, auth, error handling, logging) |
| **Common**     | `common.imljson`                                                                              | Encrypted common data (API secrets, etc.). Locked after app approval                   |
| **Connection** | `api.imljson`, `parameters.imljson`                                                           | Auth configuration (OAuth2, OAuth1, JWT, API Key, Basic)                               |
| **Module**     | `api.imljson`, `parameters.imljson`, `expect.imljson`, `interface.imljson`, `samples.imljson` | Functional execution unit                                                              |
| **RPC**        | `api.imljson`, `parameters.imljson`                                                           | Remote procedure call for dynamic options/fields                                       |
| **Webhook**    | `api.imljson`                                                                                 | Webhook configuration for instant triggers                                             |

## Module Types

| Type                  | type_id | Purpose                             | Characteristics                                               |
| --------------------- | ------- | ----------------------------------- | ------------------------------------------------------------- |
| **Trigger (Polling)** | 1       | Periodic polling → detect new items | `trigger.type` (id/date), `trigger.order`, Static params only |
| **Action**            | 4       | Single request → single result      | CRUD operations (Create, Get, Update, Delete)                 |
| **Search**            | 9       | Search/list → multiple results      | `iterate`, `limit`, pagination support                        |
| **Instant Trigger**   | 10      | Webhook → real-time reception       | Linked to Webhook, Communication is optional                  |
| **Responder**         | 11      | Return webhook response             | Defines only response (status, headers, body)                 |
| **Universal**         | 12      | General purpose                     | CRUD type can be specified                                    |

### Module Type Selection (Critical)

**Multiple output bundles (`iterate`) only work with Search modules (type_id: 9).** Action modules always produce a single output bundle — even if `iterate` is specified in the response, only the last item is output.

Choose the correct type based on expected output:

| Expected Output | Correct Type | Why |
|---|---|---|
| Always 1 result (e.g., Create, Get, Update, Delete) | **Action** (4) | Single bundle |
| Potentially multiple results (e.g., List, Search, Aggregate with group_by) | **Search** (9) | Needs `iterate` + `limit` |
| Periodic check for new items | **Trigger** (1) | Needs `trigger` config |
| Real-time webhook reception | **Instant Trigger** (10) | Linked to Webhook |

Search modules **must** include in their response:
- `"iterate"` — the array to iterate over
- `"limit"` — `"{{parameters.limit}}"` to control max bundles

And in their expect:
- `limit` parameter with `"type": "uinteger"`, `"default": 10`, `"required": true`

## IML Expressions

Used within IMLJSON strings in `{{expression}}` format. Key variables:

| Variable             | Description                    |
| -------------------- | ------------------------------ |
| `{{parameters.xxx}}` | Module mapping parameter value |
| `{{connection.xxx}}` | Connection stored data         |
| `{{common.xxx}}`     | Common data                    |
| `{{body}}`           | Response body                  |
| `{{body.xxx}}`       | Response body field            |
| `{{statusCode}}`     | HTTP status code               |
| `{{headers.xxx}}`    | Response header                |
| `{{item}}`           | Current item in iterate        |
| `{{item.xxx}}`       | Iterate item field             |
| `{{temp.xxx}}`       | Temporary variable             |
| `{{payload.xxx}}`    | Webhook payload                |
| `{{webhook.xxx}}`    | Webhook parameter              |

For the full list of built-in functions, see the reference files in the language folders.

Key functions: `if()`, `ifempty()`, `switch()`, `get()`, `pick()`, `omit()`, `contains()`, `replace()`, `substring()`, `split()`, `join()`, `lower()`, `upper()`, `trim()`, `base64()`, `parseDate()`, `formatDate()`, `addDays()`, `addSeconds()`, `addMinutes()`, `length()`, `min()`, `max()`, `map()`, `sort()`, `distinct()`, `flatten()`, `keys()`, `md5()`, `sha256()`, `encodeURL()`, `decodeURL()`

### Runtime Additional Functions (provided by imt-app-runtime)

| Function                 | Signature                                                                   | Description                                          |
| ------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------- |
| `jwt()`                  | `jwt(payload, secret, alg?, options?)`                                      | Generate JWT token. Default alg: `HS256`             |
| `generateJwtWithKeyId()` | `generateJwtWithKeyId(payload, hmacKey, jwtAlg?, thumbprintAlg?, options?)` | Generate JWT with RFC7517 kid header                 |
| `cryptoSign()`           | `cryptoSign(algorithm, data, key, outputEncoding?)`                         | Cryptographic signing. Default outputEncoding: `hex` |
| `mime()`                 | `mime(filename)`                                                            | Return MIME type from filename                       |
| `parseJSON()`            | `parseJSON(string)`                                                         | Parse JSON string                                    |
| `createJSON()`           | `createJSON(object)`                                                        | Convert object to JSON string                        |
| `parseXML()`             | `parseXML(string)`                                                          | Parse XML string to object                           |
| `createXML()`            | `createXML(object)`                                                         | Convert object to XML string                         |
| `toDataStructure()`      | `toDataStructure(data, type?)`                                              | Generate data structure. Default type: `json`        |
| `isArray()`              | `isArray(value)`                                                            | Check if value is array                              |
| `pop()`                  | `pop(array)`                                                                | Remove/return last element of array                  |
| `shift()`                | `shift(array)`                                                              | Remove/return first element of array                 |
| `errorFactory()`         | `errorFactory(errorType, message)`                                          | Create custom error                                  |

Backtick escaping: Use ``{{parameters.`key.with.dots`}}`` when keys contain `.`, `-`, or spaces

## Communication (api.imljson) Structure

For detailed specs, see [communication-reference.md](references/communication-reference.md).

```json
{
	"url": "/endpoint/{{parameters.id}}",
	"method": "GET|POST|PUT|DELETE|PATCH",
	"headers": { "Custom-Header": "value" },
	"qs": { "param": "{{parameters.param}}" },
	"body": { "field": "{{parameters.field}}" },
	"type": "json|urlencoded|multipart/form-data|binary|text",
	"temp": { "myVar": "{{body.someValue}}" },
	"condition": "{{parameters.optionalParam}}",
	"response": {
		"output": "{{body}}",
		"iterate": "{{body.items}}",
		"limit": "{{parameters.limit}}",
		"trigger": {
			"id": "{{item.id}}",
			"date": "{{item.createdAt}}",
			"type": "date",
			"order": "desc"
		},
		"valid": "{{body.status != 'error'}}",
		"error": {
			"message": "[{{statusCode}}] {{body.error.message}}",
			"type": "RuntimeError"
		},
		"temp": { "nextCursor": "{{body.nextCursor}}" },
		"wrapper": { "id": "{{item.id}}", "data": "{{item}}" }
	},
	"pagination": {
		"condition": "{{body.hasMore}}",
		"qs": { "cursor": "{{temp.nextCursor}}" }
	}
}
```

### Multiple Requests (Array)

Writing Communication as an array executes them sequentially:

```json
[
	{
		"url": "/first-call",
		"response": { "temp": { "token": "{{body.token}}" } }
	},
	{
		"url": "/second-call",
		"headers": { "Authorization": "Bearer {{temp.token}}" },
		"response": { "output": "{{body}}" }
	}
]
```

## Parameters & Interface

For Parameters (Expect/Static), Interface, RPC Dynamic Options, and related patterns, see [parameters-reference.md](references/parameters-reference.md).

## Component Patterns

For Base, Connection, Error Handling, Webhook, Trigger, and Responder patterns, see [component-patterns-reference.md](references/component-patterns-reference.md).

## Runtime Limitations (imt-app-runtime)

| Setting                     | Default        | Description                          |
| --------------------------- | -------------- | ------------------------------------ |
| `maxRequestCount`           | 100            | Max HTTP requests per module         |
| `maxPaginationRequestCount` | 50             | Max pagination requests              |
| `maxPastRecords`            | 3200           | Max past records for Trigger         |
| timeout                     | 40s (max 300s) | Configurable via `timeout` in Common |

These values can be overridden in `common.imljson`:

```json
{
	"maxRequestCount": 200,
	"maxPaginationRequestCount": 100,
	"timeout": 300000
}
```

## Available Error Types for errorFactory

`DataError`, `UnknownError`, `RuntimeError`, `InconsistencyError`, `RateLimitError`, `OutOfSpaceError`, `ConnectionError`, `InvalidConfigurationError`, `InvalidAccessTokenError`, `UnexpectedError`, `MaxResultsExceededError`, `MaxFileSizeExceededError`, `IncompleteDataError`, `DuplicateDataError`, `ModuleTimeoutError`, `Warning`

## Important Notes

- `editable: true` → connection `parameters.imljson` only (deprecated in module expect)
- Connection reserved words: Do not use `teamID`, `accountName`
- Common data cannot be changed after app approval
- Triggers use Static Parameters only (cannot map as it's the first module)
- Trigger sorting: `desc` recommended (3200 record limit)
- IMLJSON allows comments (`//`)
- Sanitize is required to remove sensitive info from logs
- IML functions run in a sandbox (10-second timeout)
- `{{environment.timezone}}` etc. (scenario environment) is always available — no flags needed. `flags.environmentAccess` is only for server-side `process.env` access via `{{environment.system.VAR}}` (see [runtime-reference.md](references/runtime-reference.md#environment-variables))

## Custom IML Functions

For custom IML function details (code conventions, test.js requirements, size limits), see [custom-functions-reference.md](references/custom-functions-reference.md).

## Developer Notes Templates

For Developer Notes templates (Bug Fix and Feature), see [developer-notes-templates.md](references/developer-notes-templates.md).

## Detailed Reference

- Built-in IML functions: [builtin-iml-functions.md](references/builtin-iml-functions.md)
- Communication detailed spec: [communication-reference.md](references/communication-reference.md)
- Parameters & Interface (Expect, RPC, Collection, Array, Dynamic Interface): [parameters-reference.md](references/parameters-reference.md)
- Component patterns (Base, Connection, Error, Webhook, Trigger, Responder): [component-patterns-reference.md](references/component-patterns-reference.md)
- Custom IML functions (code conventions, test.js, size limits): [custom-functions-reference.md](references/custom-functions-reference.md)
- Developer Notes templates (Bug Fix, Feature): [developer-notes-templates.md](references/developer-notes-templates.md)
- Real-world examples (Instagram app): [examples.md](references/examples.md)
- Runtime internals (middleware, limits, edge cases): [runtime-reference.md](references/runtime-reference.md)
- Apps UX best practices (naming, hints, fields, messages, patterns): [app-ux-best-practices.md](references/app-ux-best-practices.md)

## imt-app-runtime Source Setup

This skill uses `imt-app-runtime` source code to reference the internal workings of the Make app runtime.

### Auto-Detection Workflow

Check whether the **very last line** of this SKILL.md file starts with `imt-app-runtime-path:`.

- **If the line exists** → Use the source code at that path as runtime reference.
- **If the line doesn't exist** → Proceed with the installation guide below **first**. Do not answer the user's original question — only provide the installation guide and end the turn.

### Installation Guide (When the Line Doesn't Exist)

Guide the user as follows:

> **imt-app-runtime source code has not been configured yet.**
>
> The `imt-app-runtime` source code is needed to accurately reference the internal workings of the Make app runtime.
>
> Please open **GitHub Desktop** and clone the following repository:
>
> - Repository: `niceinnovative/imt-app-runtime` (Make internal repo)
> - Clone to any local path you prefer
>
> Once cloning is complete, please tell me the **local path**! (e.g., `/Users/username/Documents/GitHub/imt-app-runtime`)

### After Installation (When the User Provides the Path)

Add the path provided by the user to the **very last line** of this SKILL.md file in the following format:

```
imt-app-runtime-path: /path/provided/by/user/imt-app-runtime
```

After adding it, inform the user that setup is complete and answer their original question.
