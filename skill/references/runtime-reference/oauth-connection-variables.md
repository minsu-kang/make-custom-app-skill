# Runtime reference: OAuth Connection Variables

> Read when: writing or reviewing OAuth connection `api.imljson`: the variables available there and the granted-scope record. Part of [runtime-reference.md](../runtime-reference.md).

## OAuth Connection Variables

Available inside `connections/{name}/api.imljson` (`authorize`, `token`, etc.). Sourced from `accounts/app-runtime-oauth2/lib/account.js` `get redirects()` (and the OAuth1 equivalent at `accounts/app-runtime-oauth1/lib/account.js`).

| Variable                     | Resolves to                                                                                           | When to use                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{oauth.localRedirectUri}}` | `https://<environment.host>/oauth/cb/{connection-name}` — the **current instance's host**             | **Default for new connections.** Host-aware, works on Make-hosted **and** self-hosted instances.                                                                              |
| `{{oauth.redirectUri}}`      | `https://<environment.redirects.integromat>/oauth/cb/{connection-name}` — **always `integromat.com`** | **Legacy.** Pre-Make-rebrand callback. Avoid in new code; migrate when touched.                                                                                               |
| `{{oauth.makeRedirectUri}}`  | `https://<environment.redirects.make>/oauth/cb/{connection-name}` — **always `make.com`**             | Make-only deployment (breaks self-host). Use only when the upstream provider has a hard `make.com`-only redirect registered AND self-host support is explicitly out of scope. |
| `{{oauth.scope}}`            | Array of scope strings declared in `scope.imljson` / `scopes.imljson`                                 | Joined into the authorize URL via `join(oauth.scope, ' ')` (Google) or `','` (others).                                                                                        |

`oauth` IML context is **only** the object returned by `get redirects()` (`redirectUri`, `localRedirectUri`, `makeRedirectUri`) plus `oauth.scope` assigned in `authorize()`. There is **no** `{{oauth.state}}` variable.

**OAuth2 CSRF `state` is injected by the runtime, not by IML.** After `authorize.qs` is IML-transformed, `accounts/app-runtime-oauth2/lib/account.js` always does `options.qs.state = crypto.randomBytes(12).toString('hex')` (overwriting any IML `qs.state`), then `IMTOAuthAccount.createToken(state, …)` (15 min). The callback validates via `getTokenFromRequest` → `request.query.state`. **Do not** add `"state": "{{oauth.state}}"` to `authorize.qs` — it is not an IML variable, and the runtime overwrites `qs.state` anyway. Omitting `state` from the app's `authorize.qs` is correct. Do not flag it in review ([SECURITY][2.2] is a false-positive trap, not a finding).

When `environment.redirects` is unset (legacy environment configuration), all three redirect-URI variables collapse to the same host-based URI, so `localRedirectUri` is also the safest backward-compatible choice.

**Cross-reference**: full convention + code-review checklist live in `component-patterns-reference/connection-oauth.md` § "OAuth2 Connection — `redirect_uri` Convention" and `code-review-criteria/api-imljson.md` § "OAuth `redirect_uri` Convention".

### `token.response.scope` — record the scope the provider actually granted

Added in imt-app-runtime **v1.101.0** (2026-07-18, PR #693); follow-up fix **v1.101.1** (2026-07-20, PR #709). Source: `accounts/app-runtime-oauth2/lib/account.js` (`token()`, `saveScope()`, `_setScope()`, `_normalizeScope()`); tests: `test/account.spec.js` § "directive `token.response.scope`" + `test/account-set-scope.spec.ts`.

```json
"token": {
	"url": "https://provider.example/oauth/token",
	"method": "POST",
	"response": {
		"data": { "accessToken": "{{body.access_token}}" },
		"scope": "{{body.scope}}"
	}
}
```

Before this directive the platform only knew the scopes it **requested**; if the user granted a subset, that was invisible (the source calls it out as a known limitation). `token.response.scope` lets the token endpoint report what was actually granted, per RFC 6749 § 3.3.

| Aspect              | Behavior                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Value               | IML-evaluated. Accepts a string array, a space-delimited string (RFC 6749 § 3.3), a comma-delimited string, or a mix — `_normalizeScope()` splits on `/[\s,]+/` and drops empties. Any other type → `[]` (treated as "not reported"). |
| Precedence          | A non-empty result **overrides** the stored scope — it does **not** merge. The token response is authoritative, so a revoked scope drops off on the next exchange.                                                                    |
| Fallback            | Empty / absent → previous behavior: `acceptedScope` (the scopes sent to the authorization server) is merged into the stored scope and deduplicated.                                                                                   |
| `token` as an array | Each communication item is checked; the **last** item reporting a non-empty scope wins. A scope-less follow-up item (e.g. a long-token request) cannot erase an earlier item's scope.                                                 |
| Client Credentials  | With no authorize/callback step there is no `acceptedScope`, so this directive is the **only** way to record scope for that flow.                                                                                                     |

**Not supported under `refresh` — by design.** `saveScope()` is wired into `token()` only. A refresh renews the access token; it is not an authorization event, so it must not change the recorded grant. Changing scope requires re-authorizing the connection. `refresh.response.scope` is silently ignored — flag it in review.
