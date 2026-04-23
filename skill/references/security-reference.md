# Security Reference (Make Custom Apps)

Authoritative security checklist for Make custom app code review. This file is the **single source of truth** for security review; `code-review-criteria.md` only links here. Scope covers IMLJSON (`api.imljson`, `parameters.imljson`, `samples.imljson`, `interface.imljson`, connection `install*`/`common`/`scope*`) and `functions/*/code.js`.

Each finding below maps to a verdict — **Critical** (block merge), **High** (changes requested), **Medium** (improvement). Severity column uses `C` / `H` / `M`.

---

## 1. Credential & Secret Handling

| # | Severity | Check | Red Flag | Fix |
|---|---|---|---|---|
| 1.1 | C | OAuth client secret in plaintext `parameters.imljson` | `clientSecret` field declared as `type: "text"` (not `"password"`), or stored on `connection.*` instead of `common.*` / `installSpec` | Declare as `type: "password"`. Platform-issued keys go in `installSpec` + `install.imljson` → `common.*`; user-issued keys go on `parameters.imljson` but still `password` type |
| 1.2 | C | Credential echoed in `response.output` | `{{body}}` dumped when the response body contains `access_token`, `refresh_token`, `client_secret`, `api_key`, `private_key`, `cookie`, `set-cookie` | Pick explicit fields (`{ "id": "{{body.id}}", "name": "{{body.name}}" }`) or strip via `omit(body, 'access_token', ...)` |
| 1.3 | H | Token echoed in error message | `"message": "... {{body}}"` or `"[{{statusCode}}] {{body}}"` raw | Use `{{body.error.message}}` or sanitized fields only; never `{{body}}` wholesale in error text |
| 1.4 | H | Sensitive header missing log sanitize | `base.imljson` / `api.imljson` sends `Authorization`, `X-Api-Key`, `Cookie`, `Proxy-Authorization`, `X-Amz-Security-Token`, etc. without `log.sanitize` entry | Add each header name to the `log.sanitize` array of the same request. See `runtime-reference.md` § "log.sanitize" |
| 1.5 | H | API key in URL query string | `url: "/v1/items?api_key={{parameters.apiKey}}"` or `qs: { "token": "{{connection.token}}" }` | Move to `headers.Authorization` (Bearer / custom scheme). URL query strings are logged by intermediaries and Make request logs |
| 1.6 | M | `samples.imljson` contains real credentials/PII | Copy-pasted production response with real emails, phone numbers, tokens, IDs resolvable to real accounts | Replace with synthetic values (`user@example.com`, `+1-555-0100`, `sample_token_xxxx`) |
| 1.7 | M | Password-type expect field revealed by interface | `expect.imljson` `type: "password"` but the same field appears in `response.output` / `interface.imljson` as plain text | Never expose password-type fields as module output |

---

## 2. OAuth / Connection Flow

| # | Severity | Check | Red Flag | Fix |
|---|---|---|---|---|
| 2.1 | C | `installSpec.imljson` + `install.imljson` missing while `api.imljson` references `common.*` | OAuth2 connection using `{{ifempty(parameters.clientId, common.clientId)}}` but `installSpec.imljson = []` and `install.imljson = {}` | See `component-patterns-reference.md` § "OAuth2 Connection with Common Fallback" and `code-review-criteria.md` § "Connection install + installSpec Verification" |
| 2.2 | H | Missing `state` parameter in authorize URL | `authorize.imljson` builds `url` without `state` | Add `"state": "{{oauth.state}}"` — runtime injects CSRF-safe state and validates on callback |
| 2.3 | H | Wildcard/overbroad scope | Scope string like `admin`, `*`, or one scope union that covers multiple modules regardless of user intent | Request the minimum scope each module needs. For apps with per-module scope, define `scope.imljson` + `scopes.imljson` |
| 2.4 | H | `refresh_token` logged / echoed | `response.output`, `response.temp`, or error message references `body.refresh_token` outside of `connection.refreshToken` assignment in `token.imljson` / `refresh.imljson` | Keep `refresh_token` strictly inside connection storage; never surface to module output |
| 2.5 | M | `redirect_uri` hardcoded to a non-Make host | `authorize.imljson` sets `redirect_uri` to a developer-controlled URL | Must use Make's `{{oauth.redirectUri}}` — runtime value |

---

## 3. Webhook Signature & Replay Protection

| # | Severity | Check | Red Flag | Fix |
|---|---|---|---|---|
| 3.1 | C | Webhook accepts payload without signature verification | `webhooks/{name}/api.imljson` has only `response.output` and no `verification` or pre-output `valid` / `condition` rejecting unsigned requests | Compute HMAC (`sha256(payload, secret)`) and compare with `headers.x-signature` via `verification.condition` or early `error` directive |
| 3.2 | H | Signature compared with `==` (timing-unsafe conceptually) | String comparison of secret-derived digests in `functions/*/code.js` using `==` or `===` without `cryptoSign` equivalence | Compute digest via `sha256()` / `cryptoSign()` in IML — they produce deterministic hex strings; string equality is acceptable only after both sides are hex-lowercased |
| 3.3 | H | No replay window enforcement | Webhook accepts requests whose `timestamp` / `X-Timestamp` header is arbitrarily old | Reject if `parseDate(headers['x-timestamp'])` is older than 5 minutes |
| 3.4 | M | Shared secret stored in `parameters.imljson` without `type: "password"` | Webhook secret visible in UI as plain text | Declare as `type: "password"` |

---

## 4. SSRF & Outbound Request Abuse

| # | Severity | Check | Red Flag | Fix |
|---|---|---|---|---|
| 4.1 | C | User-supplied URL used directly in `api.imljson` `url` | Module expect has a `url` field mapped into `"url": "{{parameters.url}}"` with no allowlist | Constrain to the app's own domain: `"url": "{{baseUrl}}/{{parameters.path}}"`. If arbitrary URLs are the product (proxy/HTTP module), document the risk and require `https://` prefix + explicit user consent |
| 4.2 | H | Missing protocol check for user URL | Accepts `file://`, `gopher://`, raw IP, or `http://169.254.169.254` (AWS metadata) | Validate via IML: `{{if(startsWith(parameters.url, 'https://'), parameters.url, throw('Only https URLs allowed'))}}` or reject in a function |
| 4.3 | M | Follow-redirects against unchecked host | `communication` array follows redirect chain to arbitrary domains without re-validating target | Pin `followRedirects: false` when the first hop is user-controlled |

---

## 5. Injection, Prototype Pollution, ReDoS (functions/*/code.js)

| # | Severity | Check | Red Flag | Fix |
|---|---|---|---|---|
| 5.1 | C | `eval()` / `new Function()` on user input | Any `eval(` or `new Function(` in function code | Disallowed. Parse with `JSON.parse` or structured alternatives |
| 5.2 | C | Prototype pollution via dynamic key | `obj[userKey] = value` where `userKey` can be `"__proto__"` / `"constructor"` / `"prototype"` | Use `Object.create(null)` for maps, or reject keys matching `/^(__proto__\|constructor\|prototype)$/` |
| 5.3 | H | Regex on user input with catastrophic backtracking | Patterns like `/^(a+)+$/`, `/(x+x+)+y/`, `/([a-zA-Z]+)*$/` applied to untrusted input | Rewrite to non-nesting pattern, or cap input length before matching |
| 5.4 | H | Command-style interpolation into URL/path | `` `${baseUrl}/${userInput}` `` where `userInput` could contain `..`, `\r\n`, or URL-encoded nulls | `encodeURIComponent(userInput)` and validate with an allowlist regex |
| 5.5 | M | `JSON.parse` without try/catch on untrusted string | Crashes the function on malformed input, surfaces stack to user | Wrap in try/catch and return `errorFactory('DataError', ...)` |

---

## 6. Sensitive Data in Output & Samples

| # | Severity | Check | Red Flag | Fix |
|---|---|---|---|---|
| 6.1 | H | Output field labeled `password` / `secret` / `token` visible in `interface.imljson` | Field appears in module output so downstream scenarios can map it | Remove from interface; if legitimately needed, declare as `type: "password"` |
| 6.2 | M | PII echoed by default | Full user records returned when only `id` was requested (e.g., Get module returns SSN, DOB unless user asked) | Return minimum viable fields; expose extras via explicit expect flag |
| 6.3 | M | Raw stack trace in error message | `"message": "{{body.stack}}"` or function throwing with `err.stack` | Strip stack; use `err.message` only |

---

## 7. Environment & Sandbox

| # | Severity | Check | Red Flag | Fix |
|---|---|---|---|---|
| 7.1 | H | `{{environment.system.*}}` used without `flags.environmentAccess` note | Developer added `flags: { environmentAccess: true }` to read `process.env.*` — this requires explicit Make approval | Flag in review; confirm the flag is requested intentionally (rarely appropriate for customer apps) |
| 7.2 | M | IML function exceeds 10s sandbox timeout risk | Synchronous loops > 100k iterations, or recursive JSON walking without depth cap | Add length guard; abort early |

---

## 8. Review Output Format

When a finding from this reference is flagged, the review section should read:

```
[SECURITY][Critical] 1.2 Credential echoed in response.output
File: modules/GetUser/api.imljson:12
Problem: `{{body}}` is returned wholesale; upstream API includes `access_token` in the response.
Fix: Replace `"output": "{{body}}"` with explicit pick list, e.g. `"output": "{{pick(body, 'id', 'email', 'name')}}"`.
```

The bracketed category must be `[SECURITY]` and include the numeric ID from this reference (`1.2`, `3.1`, etc.) so findings are traceable across reviews.
