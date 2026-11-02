# Runtime reference: ISC (Internal Service Communication)

> Read when: an app uses the `isc` directive: shape, preconditions, limitations, review implications, the AI Module Builder component set. Part of [runtime-reference.md](../runtime-reference.md).

## ISC (Internal Service Communication)

Added in imt-app-runtime **v1.100.0** (2026-05-22, PR #663). Source: `lib/core/middleware/isc.ts`; spec doc: `ISC-SDK-APPS.md`; tests: `test/isc.spec.ts`.

The `isc` directive lets a **Make-owned** SDK app call Make's own internal services (over the cluster network via JWT mutual auth, `@integromat/isc`) instead of a public third-party API. The first consumer is `ai-module-builder-api` (the "Polymorph" / AI Module Builder modules); initial apps: airtable, google-calendar, google-docs, google-drive, google-forms, google-sheets, instagram-business, jira-software-cloud, pinterest, telegram.

### Directive shape

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

- `isc.service` — name of the target internal service. **Supports IML** (e.g. `{{parameters.svc}}`); must resolve to a **non-empty string** or the middleware throws.
- `url` — **required**, treated as a **relative path** (e.g. `/v1/rpc/parameters`). The base URL is resolved from the `INTEGROMAT_ISC_<SERVICE>_URN` env var, NOT from `base.imljson` `baseUrl`. App type definition: `api.isc?: { service: string }` and `flags.allowISC?: string[]` (`imt-app-runtime/lib/types.ts`).

### Middleware position & request bypass

`isc.initialize()` is wired into **all** API entry points (action, search, trigger, hook, rpc), positioned **after `agency` and before `prepareRequestOptions`**:

```
... → accman.validate() → agency.initialize() → isc.initialize() → prepareRequestOptions() → request() → ...
```

When `api.isc` is present, the middleware makes the call itself, then sets `REQUEST_MODE.DISABLED` + `responsePrePopulated = true`, so the standard HTTP requester is skipped. The response is fed into the **normal** response chain — `response.valid`, `response.error`, `response.output`, `response.iterate`, `response.temp`, `response.wrapper`, `response.type` parsing all work transparently and behave exactly like a regular HTTP call.

### Required preconditions (each throws `RuntimeError` if unmet)

Validated in this order inside `isc.initialize()`:

1. **`isc.service` resolves to a non-empty string** → else `ISC directive requires "isc.service" to resolve to a non-empty string.`
2. **`flags.allowISC` (array) includes the target service** → else `ISC directive requires the app to have the target service listed in the allowISC flag.` Set via `POST /admin/sdk/apps/:app/:ver/flags/allowISC` (Make-owned apps only). **Not part of the SDK code download** — it is app-level deployment config, so it cannot be reviewed from `download-app.js` output.
3. **No `pagination` directive** → ISC does not support pagination (fails loudly: `ISC directive does not currently support the "pagination" directive.`).
4. **No `encodeUrl` / `encodeUrlMode`** → ISC bypasses `normalizeUrl`, so these throw if present.
5. **`url` is present** → else `ISC directive requires a url field to specify the request path.` ⚠️ **This is the most common authoring bug** — commenting out / omitting `url` does NOT fall back to the benign URL-less-RPC behavior (that fallback lives in `prepareRequestOptions`, which never runs because `isc` short-circuits first).
6. **`packageName` present** → becomes the JWT issuer (`app#` prefix stripped).
7. **Per-service env vars present** → `INTEGROMAT_ISC_<SERVICE>_URN`, `INTEGROMAT_ISC_APP_RUNTIME_<SERVICE>_SECRET_NAME`, `INTEGROMAT_ISC_APP_RUNTIME_<SERVICE>_SECRET_VALUE` (service name normalized: uppercase, non-alphanumeric → `_`). Missing any → `Missing <KEY> environment variable...`.

### Request building parity with the standard requester

- `method` defaults to `GET`, uppercased. **GET never carries a body** even if `api.body` is set.
- `headers` lower-cased (`mapKeysLower`); a caller-supplied `Content-Type` is respected and not duplicated; JSON body auto-sets `content-type: application/json`.
- `qs` merged into the path; null/undefined stripped; array values expanded to repeated keys; an existing `?` in `url` is merged (no `?a=1?b=2`).
- `body`: IML-transformed (`rootArray: true` preserves a top-level array body); JSON-serialized for non-GET.
- `timeout`: `api.timeout` or default **40000 ms** (matches the standard requester).

### Error handling

All ISC failures are marked `imtExternalError = false` (platform errors, never surfaced as "external API error"):

| Situation                    | Result                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| HTTP 4xx                     | Error carrying service name + status; routable through `response.error` (e.g. `error.404`) |
| HTTP 429                     | `RateLimitError` (default mapping)                                                         |
| HTTP 5xx                     | `ConnectionError` — `"Service is temporarily unavailable."`                                |
| Network / connection failure | `RuntimeError` (`ISC call to "<service>" failed: <msg>`)                                   |

### Security model (defense in depth)

`allowISC` can only be set on Make-owned apps (system user or `@make.com`/`@integromat.com` author); blocked on ownership transfer; stripped on clone/version to non-Make owners. Runtime checks the allowlist; the JWT `iss` claim = the app's `packageName` (cannot be spoofed); the target service validates the issuer against its own `ALLOWED_ISSUERS` (deny-all when unset).

### Limitations

- **No `pagination`** and **no `encodeUrl`/`encodeUrlMode`** (throw if present).
- **No recording/replay** — `REQUEST_MODE.DISABLED` skips the requester's recording logic.
- **Make-owned apps only** — community/third-party SDK apps cannot use ISC.

### Code-review implications

- **A url-less ISC component is a blocking bug**, not a pure-data RPC. Flag it. (Real case: IEN-15506 — `google-calendar` `getParameters` RPC had `//"url": "/v1/rpc/parameters"` commented out; the module's dynamic `expect` failed to load every field at runtime.)
- **Mocked component tests do NOT exercise ISC validation** — the test harness intercepts the call before `isc.initialize()` runs, so a passing module/RPC integration test does **not** prove `url`/`allowISC`/env are correct. ISC paths can only be validated against a real backend (typically `hqrelease`).
- **`flags.allowISC` + the `INTEGROMAT_ISC_*` env vars are out of code-review scope** — they are deployment config, not in the SDK download. Note them as a pre-production verification item rather than a code finding.
- **Do not false-flag** `isc`, `getFieldMapping`, or `safeSerialize` as unknown directives/functions — all are runtime-provided and verified.

### AI Module Builder rollout — the canonical 9-change component set

Epic IEN-15500 ports the same "AI Module Builder" (Polymorph) module into every Make-owned app one ticket at a time (google-sheets IEN-15502, google-forms IEN-15505, google-calendar IEN-15506, slack IEN-15987, …). Every one of those tickets produces the **same 9 changes**. Use this as the review checklist; anything missing is a gap, anything extra needs a reason.

| #   | `group/item/code`                                              | Expected content                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `app//groups`                                                  | New `AI` group containing only the new module. Existing groups must be untouched → pure addition, never a Breaking Change.                                                                                                                                                                                                                                                 |
| 2   | `module/aiModuleBuilder/api`                                   | ISC `POST /v1/request` to `ai-module-builder-api`. Body: `organizationId={{scenario.organizationId}}`, `scenarioId={{scenario.id}}`, `instanceId={{scenarioModuleId}}`, `targetService="<app-slug>"`, `parameters.mappings={{safeSerialize(getFieldMapping('task'))}}` plus `forceRegenerate`/`safetyMode`/`executionMode`, `auth.accessToken={{connection.accessToken}}`. |
| 3   | `module/aiModuleBuilder/expect`                                | `[ "rpc://parametersAiModuleBuilder" ]` — fields are owned by the backend, so field names cannot be verified from app code.                                                                                                                                                                                                                                                |
| 4   | `module/aiModuleBuilder/interface`                             | `[ "rpc://interfaceAiModuleBuilder" ]`                                                                                                                                                                                                                                                                                                                                     |
| 5   | `module/aiModuleBuilder/scope`                                 | **Must not stay `[]`.** Union of the scopes the backend needs to act on the user's behalf, matching the app's other modules.                                                                                                                                                                                                                                               |
| 6–7 | `module/aiModuleBuilder/account_name` + `attached_accounts`    | The parent app's existing connection — the module never declares its own connection parameter.                                                                                                                                                                                                                                                                             |
| 8–9 | `rpc/{interfaceAiModuleBuilder,parametersAiModuleBuilder}/api` | ISC `GET /v1/rpc/interface` / `/v1/rpc/parameters` + `qs.targetService=<app-slug>`, `response.iterate = {{body}}`, `output = {{item}}`, empty `parameters.imljson`.                                                                                                                                                                                                        |

Two items are **not** in the ticket's reference snippet but belong in every implementation — both were added to earlier apps only after a production incident, so treat their absence as an Improvement:

- **`log.sanitize: ["request.headers.authorization", "request.body.auth"]`** on the module `api`. Without it the OAuth access token is written in cleartext to run/debug logs, because the token is deliberately placed in `body.auth.accessToken`. (Root of google-calendar IEN-15714.)
- **A non-empty module `scope`.** An empty `scope.imljson` means the connection token is minted without the permissions the backend needs → the backend's first call fails with the vendor's insufficient-scope error (google-calendar hit `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`).

Recurring non-findings on these tickets — do not flag:

- `api.timeout` (typically `300000`) on the module. ISC honors `api.timeout`; 300 s is the platform maximum.
- `base.imljson` `baseUrl` pointing at the vendor API. ISC resolves its base from `INTEGROMAT_ISC_<SERVICE>_URN`, so there is no conflict.
- A module `scope` entry that is absent from the connection's `scopes.imljson`. That file is the _additional-scope picker catalog_; the active scope set is a union that includes module scopes (see `component-patterns-reference/connection-oauth.md` § "OAuth Scope Files").
- `(beta)` in the module label — the lowercase parenthetical is the documented tag format (`app-ux-best-practices.md`).
- Missing `make-apps-mockup` fixture for the new module. It is an AC gap worth reporting, but a mocked test cannot validate ISC anyway (see above), so it is never a blocker.
