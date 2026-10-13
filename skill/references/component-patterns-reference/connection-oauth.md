# Component patterns: OAuth2 connections

> Read when: writing or reviewing an OAuth2 connection: common fallback, `redirect_uri` convention, scope files, the granted-scope record. Part of [component-patterns-reference.md](../component-patterns-reference.md).

### OAuth2 Connection with Common Fallback (`install` + `installSpec` required)

When an OAuth2 connection's `api.imljson` falls back to `common.*` for the platform-issued client credentials (typical pattern for Google/Microsoft/etc. apps that ship with Make's own GCP app but also let power users supply their own), **`installSpec.imljson` and `install.imljson` are not optional — they are required**.

**Why**: The runtime populates `common.*` only via the app's install flow. Without `installSpec` (form definition) and `install` (mapping to `common`), an admin has no UI path to set `common.clientId` / `common.clientSecret`, so the `ifempty(parameters.clientId, common.clientId)` fallback resolves to an empty string and Google returns `invalid_client`. Users who don't enter their own credentials can't connect at all.

**Minimum viable pair** (connection-level files, not app-level):

```json
// connections/{name}/installSpec.imljson
[
	{ "name": "clientId", "label": "Client ID", "type": "text", "required": true },
	{ "name": "clientSecret", "label": "Client Secret", "type": "password", "required": true }
]
```

```json
// connections/{name}/install.imljson
{
	"common": {
		"clientId": "{{parameters.clientId}}",
		"clientSecret": "{{parameters.clientSecret}}"
	}
}
```

And in the connection's `api.imljson`, continue to reference the fallback:

```json
"client_id": "{{ifempty(parameters.clientId, common.clientId)}}",
"client_secret": "{{ifempty(parameters.clientSecret, common.clientSecret)}}"
```

**Rule of thumb**: if `grep "common\." connections/{name}/api.imljson` returns any hit, `installSpec.imljson` and `install.imljson` must be non-empty and populate those exact `common.*` keys. Empty `[]` / `{}` is a bug, not a stub.

**Not required**: If the OAuth connection stores credentials only under `parameters.*` (no `common.*` references anywhere in the connection's `api.imljson`) — install/installSpec can stay empty.

**Related**: aliased connections (see [connection-aliased.md](connection-aliased.md)) don't need their own install/installSpec — the source connection owns them.

### OAuth2 Connection — `redirect_uri` Convention

When the upstream API supports the standard OAuth2 / OAuth1 flow with a `redirect_uri` parameter, the connection's `api.imljson` **must** use `{{oauth.localRedirectUri}}` for that field — not `{{oauth.redirectUri}}`. This rule applies both when **building a new connection** and when **reviewing an existing one**.

**Why**: the runtime exposes three different redirect-URI variables, and only `localRedirectUri` resolves to the host the user is actually running on (so it works on Make-hosted **and** self-hosted instances).

| Runtime variable             | Resolves to                                                                                                                                       | Use case                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{oauth.localRedirectUri}}` | `https://<environment.host>/oauth/cb/{connection-name}` — the **current instance's host** (Make → `make.com`, self-hosted → that customer's host) | **Default for all new connections.** Self-host-safe. Required for any app that may be deployed outside Make.                                                                        |
| `{{oauth.redirectUri}}`      | `https://<environment.redirects.integromat>/oauth/cb/{connection-name}` — **always `integromat.com`**                                             | **Legacy.** Pre-Make-rebrand callback. Do not use in new code. Existing apps still on this value should be migrated when touched.                                                   |
| `{{oauth.makeRedirectUri}}`  | `https://<environment.redirects.make>/oauth/cb/{connection-name}` — **always `make.com`**                                                         | Make-only deployment (breaks self-host). Use only when the upstream OAuth provider has a hard `make.com`-only redirect registered and self-host support is explicitly out of scope. |

Source of truth: `accounts/app-runtime-oauth2/lib/account.js` `get redirects()` (and the OAuth1 equivalent at `accounts/app-runtime-oauth1/lib/account.js`). When `environment.redirects` is unset (legacy environment configuration), all three variables collapse to the same host-based URI, so `localRedirectUri` is also the safest backward-compatible choice.

**Where to set it (and where you must keep it consistent)**:

```json
{
	"authorize": {
		"qs": {
			"redirect_uri": "{{oauth.localRedirectUri}}",
			"...": "..."
		}
	},
	"token": {
		"body": {
			"redirect_uri": "{{oauth.localRedirectUri}}",
			"...": "..."
		}
	}
}
```

- **`authorize` and `token` must use the same value.** OAuth2 spec (RFC 6749 § 4.1.3) requires the `redirect_uri` in the token-exchange call to exactly match the one sent to the authorize endpoint, otherwise the provider returns `redirect_uri_mismatch` / `invalid_grant`.
- **`refresh` does not take `redirect_uri`** (refresh-token grant has no callback step) — leave it out, do not add it.

**Operational note (out of scope of the IMLJSON file)**: when migrating an existing connection from `oauth.redirectUri` → `oauth.localRedirectUri`, the new callback URL must also be registered as an "Authorized redirect URI" in the upstream provider's OAuth client (e.g. Google Cloud Console for Google APIs, Facebook App settings for Meta). For apps that ship Make-managed common credentials (`common.clientId` / `common.clientSecret` populated by `installSpec`/`install`), this is an ops-team task on the Make-owned OAuth client — coordinate with whoever owns that client before flipping the value in production.

**Code-review heuristic**: in any connection `api.imljson` diff, `rg "oauth\.redirectUri" connections/{name}/api.imljson` should return zero hits. Any hit (other than a comment explaining a deliberate exception) is at least an Improvement; on a new app or new connection it is Changes Requested.

### OAuth Scope Files — `scope.imljson` vs `scopes.imljson`

These two filenames look near-identical but have **opposite shapes** and **different purposes**. Confusing them is a recurring false-positive in connection reviews.

| File | Shape | Purpose | Empty value |
|---|---|---|---|
| `connections/{name}/scope.imljson` | **Array** of strings: `["<scope-url>", ...]` | Default active scopes auto-requested at connection time. Joined into the OAuth `authorize` URL via the runtime's `oauth.scope` variable. | `[]` — no default scopes (only module/RPC scopes apply at request time) |
| `connections/{name}/scopes.imljson` | **Object** keyed by scope: `{ "<scope-key>": "<description>", ... }` | **Catalog** of additional scopes the user can pick from in the connection form's `additionalScopes` UI. Acts as a dictionary mapping scope identifier → human-readable label shown in the picker. | `{}` — no extra scopes selectable beyond what `scope.imljson` and module/RPC scopes already request. **Common and valid.** |

The active set sent to the OAuth provider at `authorize` time is the union of:

1. `connections/{name}/scope.imljson` (connection defaults)
2. The triggering module / RPC's own `module/scope.imljson` (auto-merged when the user creates the connection from inside that module's settings)
3. Any user-selected scopes from `connection.parameters.additionalScopes` (which the picker UI populates from `scopes.imljson`)

**Examples of valid `scopes.imljson` shapes** (sampled across published apps):

```json
// google-sheets-v2 — populated catalog
{
    "https://www.googleapis.com/auth/spreadsheets": "Access to spreadsheets",
    "https://www.googleapis.com/auth/drive": "Access to files in Google Drive"
}
```

```json
// productboard-v1 — populated catalog with granular permissions
{
    "entities:read":  "Read entities (features, components, initiatives, etc.) ...",
    "entities:write": "Create and update entities ...",
    "entities:delete": "Delete entities ..."
}
```

```json
// google-ads-conversions, google-ads-customer-match, whatsapp-business-cloud,
// cloudconvert, getresponse, github, google-merchant — empty catalog (no extras)
{}
```

**Code-review heuristic** (false-positive guard):

- An empty `scopes.imljson` `{}` is **NOT** a bug or an improvement — many production apps ship it empty. Do **not** suggest converting it to `[]`.
- An empty `scope.imljson` `[]` is fine when the connection itself needs no default scope (module/RPC scopes will be merged in per request).
- If you see `scopes.imljson` declared as `[]` (an array) — **that** is the bug. The runtime expects an object/dictionary, not an array, and the picker UI will fail to render.
- Conversely, `scope.imljson` declared as `{}` (an object) is also a bug — the runtime expects an array of scope strings.

### Recording the granted scope — `token.response.scope`

The three sources above are what the connection **requests**. Until imt-app-runtime **v1.101.0** (2026-07-18) nothing recorded what the provider actually **granted** — if a user ticked only some of the consent boxes, Make stored the requested list anyway. The `token.response.scope` directive closes that gap:

```json
// connections/{name}/api.imljson
"token": {
	"url": "https://provider.example/oauth/token",
	"method": "POST",
	"response": {
		"data": { "accessToken": "{{body.access_token}}" },
		"scope": "{{body.scope}}"
	}
}
```

Most OAuth2 providers return a `scope` field in the token response, so this is usually a one-line addition. The value may be an array, a space-delimited string (the RFC 6749 § 3.3 standard form), or a comma-delimited string — the runtime normalizes all three.

**Two behaviors worth knowing before adding it:**

- **It overrides, it does not merge.** A non-empty reported scope replaces the stored list, so a scope the user revoked disappears on the next token exchange. When the response reports nothing, the old merge-the-requested-scopes behavior applies unchanged.
- **It only works under `token`, never `refresh`.** Scope grants come from an authorization event; a refresh just renews the access token. `refresh.response.scope` is ignored.

For Client Credentials connections (no authorize/callback step) this is the **only** way to record scope at all.

**Code-review notes**: adding the directive to an existing connection is low-risk and generally an improvement, but the stored list starts reflecting the provider's own notation — some providers echo short names where the app requested full URLs. `refresh.response.scope` is always a finding (silently ignored). Full directive semantics, normalization rules, and array-`token` precedence: [runtime-reference/oauth-connection-variables.md § `token.response.scope`](../runtime-reference/oauth-connection-variables.md#tokenresponsescope--record-the-scope-the-provider-actually-granted).
