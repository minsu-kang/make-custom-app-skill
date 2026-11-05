# Runtime reference: calls to Make internal services (isc)

> Read when: an app uses the `isc` directive (Make-owned apps only): shape, where it runs, preconditions and their messages, how the request is built, responses and errors, what it skips, review notes, the AI Module Builder component set. Part of [runtime-reference.md](../runtime-reference.md).

## What isc does and who can use it

The `isc` directive lets a **Make-owned** app call one of Make's own internal services instead of a public third-party API. The call goes over the cluster network and is authenticated as the app with a signed token (JWT). Only apps that Make owns can use it: Make sets the permission, and an app author cannot turn it on from the IMLJSON (see [Security model](#security-model)).

The first consumer was the AI Module Builder service (the "Polymorph" modules), called by ten Make apps: airtable, google-calendar, google-docs, google-drive, google-forms, google-sheets, instagram-business, jira-software-cloud, pinterest and telegram. Make decommissioned that service in October 2026. The directive itself works with any service that is allowed for the app.

## Directive shape

```json
{
	"isc": { "service": "ai-module-builder-api" },
	"url": "/v1/request",
	"method": "POST",
	"headers": { "Content-Type": "application/json" },
	"body": { "targetService": "google-calendar" },
	"qs": { "targetService": "google-calendar" },
	"response": { "output": "{{body}}" }
}
```

- `isc.service` is the name of the target internal service. It supports IML (for example `{{parameters.svc}}`) and must resolve to a **non-empty string**, or the component fails.
- `url` is **required** and is a **relative path** on the service (for example `/v1/rpc/parameters`). The base address of the service comes from the configuration that Make gives the worker for that service, not from the `baseUrl` of `base.imljson`. `baseUrl` is ignored.
- The app needs the app flag `allowISC`, an array of the service names it may call. Make sets it (see [Preconditions](#preconditions) and [Security model](#security-model)).

## Where it runs and what it replaces

`isc` works in actions, searches, polling triggers, RPCs, Endpoints, instant-trigger webhook calls and webhook attach, update and detach. It does nothing in connections or gateway webhooks.

Make handles it after the connection token check and after `agency`, and before it builds the request. When `api.isc` is present, Make makes the call itself instead of sending an HTTP request. The response then goes through the normal response directives: `response.valid`, `response.error`, `response.output`, `response.iterate`, `response.temp`, `response.wrapper` and the `response.type` parsing all work (see [Responses and errors](#responses-and-errors)).

Some parts of an HTTP request do not apply to an `isc` call:

- The response body is read as UTF-8 text first, so binary content is corrupted, not preserved byte for byte.
- `urlPermissions`, the private-address check and the redirect directives do not apply, and a status below 400 is never an error.
- Recording and replay do not apply.
- The request and the response (an error response too) reach the debug log only when debug logging is on and the component has a `log.sanitize` directive (even `[]`), and never for confidential scenarios. A `log.sanitize` list masks the named parts of the request and response in the log.
- Combining `isc` with `endpoint` always fails. Without a `url` it fails with the `url` message of the [Preconditions](#preconditions). With a `url` Make sends the call first and then fails with InvalidConfigurationError "Cannot use the 'endpoint' and 'url' directives together." (see [Rules and their errors](inline-endpoint-calls.md#rules-and-their-errors)).

```json
{
	"isc": { "service": "my-internal-service" },
	"url": "/v1/request",
	"log": { "sanitize": ["request.headers.authorization", "request.body.auth"] }
}
```

## Preconditions

When `isc` is set, Make checks the points below in this order. The first problem fails the component with a RuntimeError and the message shown.

1. `isc.service` (IML allowed) evaluates to a non-empty string. Otherwise: `ISC directive requires "isc.service" to resolve to a non-empty string.`
2. The app flag `allowISC` is an array that contains exactly that string, case-sensitive. Otherwise: `ISC directive requires the app to have the target service listed in the allowISC flag.` Make sets the flag per app and version through its admin interface, on Make-owned apps only. It is **not part of the downloaded app code**: it is deployment configuration, so it cannot be reviewed from a download.
3. There is no `pagination` directive. Otherwise: `ISC directive does not currently support the "pagination" directive.`
4. There is no `encodeUrl` and no `encodeUrlMode` key at all, even with `true` or `false`. Otherwise: `ISC directive does not support the "encodeUrl" directive.` or `ISC directive does not support the "encodeUrlMode" directive.`
5. `url` is set (an empty string counts as not set). Otherwise: `ISC directive requires a url field to specify the request path.` **This is the most common authoring bug.** Commenting out or omitting `url` does NOT fall back to the harmless url-less behaviour of an RPC (the skip described in [Items without a request](../runtime-reference.md#items-without-a-request)). That fallback belongs to the request step, which never runs because `isc` stops the component first.
6. The app has a package name. Otherwise: `ISC directive requires the app to have a packageName. ISC feature is not available.`
7. The worker has the three variables of the service, checked in this order: the service address, the secret name and the secret value. The first one missing fails with:
   - `Missing INTEGROMAT_ISC_<SERVICE>_URN environment variable. ISC feature is not available for service "<service>".`
   - `Missing INTEGROMAT_ISC_APP_RUNTIME_<SERVICE>_SECRET_NAME environment variable. ISC feature is not available for service "<service>".`
   - `Missing INTEGROMAT_ISC_APP_RUNTIME_<SERVICE>_SECRET_VALUE environment variable. ISC feature is not available for service "<service>".`

   `<SERVICE>` is the service name in uppercase with every non-alphanumeric character replaced by `_`, so `my-service` becomes `MY_SERVICE`.

The caller identity that Make sends to the service is the app name: the part of the package name before `:`, without a leading `app#`.

```json
{
	"isc": { "service": "my-internal-service" },
	"url": "/v1/items",
	"method": "GET",
	"response": { "output": "{{body}}" }
}
```

## How the request is built

- `url` (IML) is a path relative to the base address of the service, and `baseUrl` is ignored.
- `method` (IML) defaults to `GET` and is uppercased, so `post` is sent as `POST`.
- `headers` are evaluated deeply and their names are lowercased. A `content-type` header in any casing is kept and not duplicated.
- `qs` is evaluated deeply. `null` and `undefined` values are dropped, arrays become repeated keys, and values are percent-encoded (a space becomes `%20`). The result is appended to any query already in `url` with `&`, so `?` is never doubled.
- `body` is evaluated deeply (a top-level array is kept) and is **always sent as JSON**. Body format directives such as `type: urlencoded` have no effect. A `GET` never sends a body, even when `body` is set. When a body is sent, `content-type: application/json` is added unless a content-type header exists in any casing.
- `timeout` is evaluated as IML and is a number of milliseconds. It defaults to 40000 when it is missing, `0`, negative or not a number. There is no upper limit.

```json
{
	"isc": { "service": "my-internal-service" },
	"url": "/v1/items?source=make",
	"method": "post",
	"qs": { "tag": ["a", "b"] },
	"body": [{ "id": "{{parameters.id}}" }],
	"timeout": 60000
}
```

## Responses and errors

After the call, Make sets `body` (parsed by `response.type` or the content type, like an HTTP response), `headers` (lowercase names), `statusCode` and `statusMessage`, and all the response directives work. A status of 400 or more goes through `response.error`: a status-specific entry, or the generic `message` and `type` for any 4xx or 5xx. When no entry matches, these defaults apply:

| Situation | Result |
|---|---|
| 429 | RateLimitError `Third party API limit likely exceeded` |
| 500 to 599 | ConnectionError `Service is temporarily unavailable.` |
| Any other 4xx | RuntimeError `ISC call to "<service>" failed with status <code>.` |
| Network or connection failure | RuntimeError `ISC call to "<service>" failed: <reason>` |

```json
{ "response": { "error": { "404": { "type": "DataError", "message": "Item not found" } }, "output": "{{body}}" } }
```

An error of the call itself (a status of 400 or more, or a network failure) is marked as a platform error, never as an error of a third-party API, also when `response.error` maps it to another message or type. The precondition errors carry no mark. A `response.valid` failure without its own `message` after a successful call is a third-party error, as in any module; with a `message` it carries no mark.

## Security model

`allowISC` is guarded in several layers:

- Only a Make-owned app can have it: its owner is the system user, or its author has a Make or Integromat company address. Make blocks the ownership transfer of an app that has it, and removes it when the app is cloned or versioned to an owner that is not Make-owned.
- At run time Make checks the allowlist. The caller identity that goes to the target service is the app name, which the app cannot spoof.
- The target service validates that identity against its own list of allowed issuers. When it has no list, it rejects every call (deny-all).

## Limitations

- No `pagination`, and no `encodeUrl` or `encodeUrlMode` (the component fails when one is present).
- No recording and no replay.
- Make-owned apps only: community and third-party apps cannot use `isc`.

## Review notes

- **A url-less `isc` component is a blocking bug**, not a pure-data RPC. Flag it. In a real case the `getParameters` RPC of a Google Calendar app had its `url` commented out, and the module's dynamic `expect` failed to load every field at run time.
- **Mocked component tests do NOT exercise the `isc` checks.** The test harness answers the call before the checks run, so a passing module or RPC test does not prove that `url`, `allowISC` and the environment variables are correct. `isc` paths can only be validated against a real backend, typically a release environment.
- **`allowISC` and the `INTEGROMAT_ISC_*` variables are out of code-review scope.** They are deployment configuration, not part of the download. Note them as a pre-production verification item, not as a code finding.
- **Do not flag** `isc`, `getFieldMapping` or `safeSerialize` as unknown directives or functions. The runtime provides all three (see [getFieldMapping and safeSerialize](../runtime-reference.md#getfieldmapping-and-safeserialize)).

## AI Module Builder component set

The AI Module Builder service was decommissioned in October 2026. The checklist stays for reviewing the apps that still carry its component set.

A rollout ported the same "AI Module Builder" (Polymorph) module into every Make-owned app, one ticket at a time (google-sheets, google-forms, google-calendar, slack and others). Every one of those tickets produces the **same 9 changes**. Use them as the review checklist: anything missing is a gap, and anything extra needs a reason.

| # | `group/item/code` | Expected content |
|---|---|---|
| 1 | `app//groups` | A new `AI` group containing only the new module. Existing groups stay untouched: a pure addition, never a Breaking Change. |
| 2 | `module/aiModuleBuilder/api` | `isc` `POST /v1/request` to `ai-module-builder-api`. Body: `organizationId={{scenario.organizationId}}`, `scenarioId={{scenario.id}}`, `instanceId={{scenarioModuleId}}`, `targetService="<app-slug>"`, `parameters.mappings={{safeSerialize(getFieldMapping('task'))}}` plus `forceRegenerate`, `safetyMode` and `executionMode`, and `auth.accessToken={{connection.accessToken}}`. |
| 3 | `module/aiModuleBuilder/expect` | `[ "rpc://parametersAiModuleBuilder" ]`. The backend owns the fields, so their names cannot be verified from app code. |
| 4 | `module/aiModuleBuilder/interface` | `[ "rpc://interfaceAiModuleBuilder" ]` |
| 5 | `module/aiModuleBuilder/scope` | **Must not stay `[]`.** The union of the scopes the backend needs to act on the user's behalf, matching the app's other modules. |
| 6 to 7 | `module/aiModuleBuilder/account_name` and `attached_accounts` | The existing connection of the parent app. The module never declares its own connection parameter. |
| 8 to 9 | `rpc/{interfaceAiModuleBuilder,parametersAiModuleBuilder}/api` | `isc` `GET /v1/rpc/interface` and `GET /v1/rpc/parameters`, with `qs.targetService=<app-slug>`, `response.iterate` set to `{{body}}`, `output` set to `{{item}}` and an empty `parameters.imljson`. |

Two items are **not** in the ticket's reference snippet but belong in every implementation. Both were added to earlier apps only after a production incident, so treat their absence as an Improvement:

- **`log.sanitize: ["request.headers.authorization", "request.body.auth"]`** on the module `api`. Without it the OAuth access token is written in clear text to the run and debug logs, because the token is deliberately placed in `body.auth.accessToken`. This was the cause of a Google Calendar incident.
- **A non-empty module `scope`.** An empty `scope.imljson` means the connection token is minted without the permissions the backend needs, so the first backend call fails with the vendor's insufficient-scope error (Google Calendar hit `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`).

Recurring non-findings on these tickets. Do not flag them:

- `api.timeout` (typically `300000`) on the module. `isc` honours any positive `timeout`. The runtime has no 300 s cap, and any cap sits outside the runtime.
- A `base.imljson` `baseUrl` that points at the vendor API. `isc` takes its base address from the configuration of the service, so there is no conflict.
- A module `scope` entry that is absent from the connection's `scopes.imljson`. That file is the additional-scope picker catalog. The active scope set is a union that includes the module scopes (see the section on OAuth scope files in [component-patterns-reference/connection-oauth.md](../component-patterns-reference/connection-oauth.md)).
- `(beta)` in the module label. The lowercase parenthetical is the documented tag format (see [app-ux-best-practices.md](../app-ux-best-practices.md)).
- A missing `make-apps-mockup` fixture for the new module. It is an acceptance-criteria gap worth reporting, but a mocked test cannot validate `isc` anyway (see the review notes above), so it is never a blocker.
