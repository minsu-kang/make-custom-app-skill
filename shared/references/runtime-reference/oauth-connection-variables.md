# Runtime reference: connections, lifecycle and variables

> Read when: writing or reviewing a connection's `api.imljson` (basic, OAuth 1 or OAuth 2): step order, the variables each step sees, redirect URIs, `oauth.scope`, `state`, PKCE, callback errors, token processing, `token.response.scope` and `expires`, renewal and `refresh`, `info` and `uid`, `invalidate`, basic connection checks and their errors, OAuth 1 steps. Part of [runtime-reference.md](../runtime-reference.md).

A connection's `connections/{name}/api.imljson` tells Make how to create, check and (for OAuth 2) renew a connection. The three connection types run different steps. This part gives the step order, the variables each step sees and what each step does. The directives shared with modules (`temp`, `condition`, `valid`, `response.error`) are in [runtime-reference.md](../runtime-reference.md), and the roots of every component are in [iml-context.md](iml-context.md).

## OAuth 2 step order

When the user starts authorization of an OAuth 2 connection, Make runs these steps in order:

1. Every [`preauthorize`](#preauthorize) item. These are real requests with `temp`, `condition`, `response.temp`, `response.valid` and `response.data`. `{{oauth.*}}`, including `oauth.scope`, is available.
2. `authorize.temp`, then the consent URL built from `authorize.url` and `authorize.qs`. `authorize` makes no request (see [Consent URL and state](#consent-url-and-state)).
3. The user consents and the provider redirects back.
4. `authorize.response.temp`, then `authorize.response.valid`, then `authorize.response.data`, evaluated against the redirect: `{{query}}`, the `{{body}}` of a `form_post` callback, `{{headers}}`, and the `temp` restored from step 2 (see [Callback and provider errors](#callback-and-provider-errors)).
5. Every [`token`](#token-step) item.

Three things run outside this sequence:

- The connection test runs only `info`. It passes when `info` raises no error, and without `info` it passes with no request. It does not repeat `token` (see [Connection test (info) and uid](#connection-test-info-and-uid)).
- `refresh` runs whenever renewal is triggered (see [When and how the token is renewed](#when-and-how-the-token-is-renewed)).
- `invalidate` runs when the platform revokes the connection. Its `response.data` is not saved (see [invalidate](#invalidate)).

`{{query.*}}` is still readable in `token`, so `{{query.code}}` works there as well as `{{temp.code}}`. With no `token` directive, `authorize.response.data` is all the connection gets.

```json
{
	"authorize": {
		"url": "https://provider.example/oauth/authorize",
		"qs": {
			"client_id": "{{common.clientId}}",
			"redirect_uri": "{{oauth.localRedirectUri}}",
			"response_type": "code",
			"scope": "{{join(oauth.scope; ' ')}}"
		},
		"response": { "temp": { "code": "{{query.code}}" } }
	}
}
```

## Variables and items in every step

In every OAuth 2 connection step these roots are available:

| Root | What it holds |
|---|---|
| `parameters`, `connection`, `data` | The same object: the fields the user filled in plus everything that earlier `response.data` directives saved |
| `common`, `scenario`, `environment` | As in a module |
| `organization` | The organization, an empty object when there is none |
| `temp` | A `temp` that persists across the steps of the same flow |

OAuth 1 connections have the same set except `organization`. Basic connections have no `organization`; they add `depconn` (see [Basic connections](#basic-connections)). `oauth` exists only in some steps (see [Redirect URIs and the oauth variable](#redirect-uris-and-the-oauth-variable)).

A value that one item saves with `response.data` can be read as `{{data.x}}` by the very next item:

```json
{
	"token": [
		{ "url": "https://provider.example/oauth/token", "response": { "data": { "accessToken": "{{body.access_token}}" } } },
		{ "url": "https://provider.example/oauth/long-token", "body": { "access_token": "{{data.accessToken}}" } }
	]
}
```

In any array-form connection step (the basic `api`, and OAuth 2 `preauthorize`, `token`, `refresh`, `info` and `invalidate`), an item whose `condition` is false is skipped entirely, including its `response.data`, `uid` and expiry handling. The next item still runs. A `condition.default` value has no effect on a connection (see [condition](../runtime-reference.md#condition)). `temp` written by one item is visible to all later items and to later steps of the same flow.

## Redirect URIs and the oauth variable

Three variables hold the redirect URI of the connection:

| Variable | Resolves to | When to use |
|---|---|---|
| `{{oauth.localRedirectUri}}` | `https://<instance host>/oauth/cb/app`, on the host the connection runs on | **Default for new connections.** It follows the instance host, so it works on Make-hosted and self-hosted instances. |
| `{{oauth.redirectUri}}` | `https://<Integromat redirect host>/oauth/cb/app` | **Legacy**, the callback from before the Make rebrand. Avoid in new code and migrate it when the file is touched. |
| `{{oauth.makeRedirectUri}}` | `https://<Make redirect host>/oauth/cb/app` | Make-only deployments, which breaks self-hosting. Use it only when the provider has a hard `make.com`-only redirect registered and self-hosting is explicitly out of scope. |

What the variables resolve to:

- The last path segment is `app` for an OAuth 2 connection and `app-oauth1` for an OAuth 1 connection, not the connection name. Only an account registered under another name uses its own name there.
- `localRedirectUri` uses the instance host. `redirectUri` and `makeRedirectUri` use the Integromat and Make redirect hosts that the environment configures. The runtime never hard-codes those hosts.
- Without that configuration all three are `https://<instance host>/oauth/cb/app`, so `localRedirectUri` is also the safest backward-compatible choice.
- When the environment sets a redirect base (`environment.oauthRedirectBase`), all three variables become that base in either case, with `{{accountName}}` in it replaced by `app` (OAuth 1: `app-oauth1`).

Which steps see `{{oauth.*}}`:

- **OAuth 2.** `preauthorize` and `authorize` see the redirect URIs and `oauth.scope`. `token` and `refresh` see the redirect URIs only. `info` and `invalidate` are not guaranteed to have `oauth`.
- **OAuth 1.** `oauth` is set when the `requestToken` step starts, and `authorize` adds `oauth.scope`. A later step sees it only when it runs on the same connection object, which the runtime does not guarantee.

There is no `{{oauth.state}}` variable (see [Consent URL and state](#consent-url-and-state)).

The convention for the redirect URI and its review checklist are in [component-patterns-reference/connection-oauth.md](../component-patterns-reference/connection-oauth.md) (the redirect URI convention) and [code-review-criteria/api-imljson.md](../code-review-criteria/api-imljson.md) (the OAuth redirect URI convention).

## Requested scope (oauth.scope)

In `preauthorize` and `authorize`, `{{oauth.scope}}` is an array. It is the union of the scope already granted to the connection and the scope requested in this authorization, with the granted scopes first and duplicates removed. The platform decides which scope files feed the requested list. For OAuth 1 it is only the newly requested list, with no union.

Make does not join the array. The author picks the separator:

- `{{join(oauth.scope; ' ')}}` is sent as `+` in the OAuth 2 consent URL (`%20` in OAuth 1). This is the form Google uses.
- `{{join(oauth.scope; ',')}}` is sent as `%2C`. Most other providers use it.
- An array passed unjoined sends a repeated `scope=` parameter.

`oauth.scope` does not exist in `token`, `refresh`, `info` or `invalidate`. A token endpoint that needs the scope must get it through `temp`:

```json
{
	"authorize": { "temp": { "scope": "{{join(oauth.scope; ' ')}}" }, "qs": { "scope": "{{temp.scope}}" } },
	"token": { "body": { "scope": "{{temp.scope}}" } }
}
```

## preauthorize

`preauthorize` (one request or an array) runs only when the user starts authorization, before the consent URL is built.

- Each item is a real HTTP request with `temp`, `condition`, `response.temp`, `response.valid` and `response.data`.
- `response.data` is saved into the connection.
- `temp` values survive into `authorize` and, through the stored state, into `token`.
- `{{oauth.*}}` (the redirect URIs and `oauth.scope`) is already available.
- An error in any item stops the authorization.
- `response.uid` and `response.metadata` have no effect here.

## Consent URL and state

Make evaluates `authorize.temp` first. It then builds the consent URL from `authorize.url` and `authorize.qs`:

- `authorize.url` is IML and must be absolute. `encodeUrl` defaults to true and `encodeUrlMode` to `legacy` (see [URL encoding and normalisation](../runtime-reference.md#url-encoding-and-normalisation)).
- `authorize.qs` is evaluated deeply. It is ignored when it does not evaluate to an object.
- A `null` or `undefined` value is sent as an empty parameter (`key=`), and an array value repeats the key (`tags=one&tags=two`).
- The parameters are appended after any query already in the URL.
- A `#fragment` in `authorize.url` stays at the end, after the query.
- Values use form encoding: a space becomes `+` and a comma becomes `%2C`.

```json
{
	"authorize": {
		"url": "https://provider.example/oauth/authorize",
		"qs": {
			"client_id": "{{common.clientId}}",
			"redirect_uri": "{{oauth.localRedirectUri}}",
			"response_type": "code",
			"scope": "{{join(oauth.scope; ' ')}}"
		}
	}
}
```

This gives `...?client_id=..&redirect_uri=..&response_type=code&scope=a+b&state=<24 hex>`.

**Make injects the CSRF `state`, not the IMLJSON.** Make always appends `state` to the consent URL: 24 lowercase hex characters (12 random bytes). This overwrites any `state` that the app put in `authorize.qs`, and there is no `{{oauth.state}}` variable. Do not add `"state": "{{oauth.state}}"` to `authorize.qs`: it is not an IML variable, and Make overwrites `qs.state` anyway. Omitting `state` from `authorize.qs` is correct. Do not flag it in review: the review rule [SECURITY][2.2] is a false-positive trap, not a finding.

Make stores a record under that `state` for 15 minutes. It holds the connection id, the scope list sent for consent and the current `temp`, so `temp` travels from `preauthorize` and `authorize` into `token`. When the provider redirects back, Make looks the record up by the `state` query parameter, restores `temp` and the requested scope from it, and deletes it.

## PKCE

Make has no built-in PKCE. It never generates a `code_verifier` or a `code_challenge`, and it adds nothing to the consent URL or the token request beyond what the IMLJSON says, apart from `state`. An app can still do PKCE, because `temp` travels from `authorize` to `token` inside the 15-minute record:

1. Generate the verifier, and compute the challenge from it, in `preauthorize` or `authorize.temp`.
2. Send the challenge in `authorize.qs`.
3. Read the verifier back as `{{temp.*}}` in `token`.

```json
{
	"authorize": { "qs": { "code_challenge": "{{temp.challenge}}", "code_challenge_method": "S256" } },
	"token": { "body": { "code_verifier": "{{temp.verifier}}" } }
}
```

Here `temp.verifier` and `temp.challenge` are the values set in step 1.

## Callback and provider errors

On the redirect back from the provider, Make evaluates `authorize.response.temp`, then `authorize.response.valid`, then `authorize.response.data`, in that order.

- They can read `{{query.*}}`, `{{body.*}}` (the body of a `form_post` callback) and `{{headers.*}}` of the incoming redirect, plus the `temp` restored from `preauthorize` and `authorize`.
- `authorize.response.data` is saved into the connection.
- `{{query.*}}` stays readable in the `token` items that follow.

```json
{
	"authorize": { "response": { "temp": { "code": "{{query.code}}" } } },
	"token": { "body": { "code": "{{temp.code}}", "grant_type": "authorization_code", "redirect_uri": "{{oauth.localRedirectUri}}" } }
}
```

When the redirect carries `?error=...`, `token` is never requested:

- Without `authorize.response.valid`, the user sees `InvalidConfigurationError: [<error>] <error_description>`. Without an `error_description` the second part reads `No error description provided`.
- With `authorize.response.valid` defined and evaluating false, the user gets its error instead: `Response marked as invalid.` or its custom `message` and `type`. `authorize.response.error` maps that error as if the HTTP status were 400, through a `"400"` key or the generic `message`. `{{statusCode}}` itself is not set in that step.
- A `valid` that evaluates true still ends in the InvalidConfigurationError.

When the redirect carries no `?error=`, the step has no HTTP response to build an error from. An `authorize.response.valid` that evaluates false there does not give `Response marked as invalid.`: it fails with a TypeError (`Cannot read properties of undefined (reading 'response')`), also when `valid` has a custom `message`. The OAuth 1 callback does the same. Do not use `valid` as a check for a missing `code`.

## Token step

`token` is one object or an array of requests. Make processes each item in this order: `temp`, `condition`, the HTTP request, `response.temp`, `response.valid`, the expiry, the scope, then `response.data`.

- If an item's `condition` is false, Make skips only that item and moves on to the next.
- A value saved by one item's `response.data` is readable as `{{data.x}}` by the next item.
- During `token`, `{{oauth.*}}` holds only the three redirect URIs. `{{oauth.scope}}` is not available.
- `token.response.uid` and `token.response.metadata` have no effect.
- The expiry and the scope come from `response.expires` and `response.scope` (see [Connection expiry](#connection-expiry-tokenresponseexpires) and [the granted scope](#tokenresponsescope-the-scope-the-provider-granted)).

A failed item stops the exchange. The user sees the usual status errors unless the item's `response.error` maps them:

| Response | Error |
|---|---|
| 4xx | `RuntimeError: Status Code Error: <code>` |
| 429 | RateLimitError `Third party API limit likely exceeded` |
| 5xx | ConnectionError `Service is temporarily unavailable.` |

```json
{
	"token": [
		{ "url": "https://provider.example/oauth/token", "response": { "data": { "accessToken": "{{body.access_token}}" } } },
		{ "url": "https://provider.example/oauth/long-token", "body": { "access_token": "{{data.accessToken}}" } }
	]
}
```

## `token.response.scope`: the scope the provider granted

`token.response.scope` records the scope that the provider granted. Without it Make knows only the scopes it requested, so a user who granted a subset is invisible. The directive lets the token endpoint report the grant, as RFC 6749 section 3.3 describes.

```json
{
	"token": {
		"url": "https://provider.example/oauth/token",
		"method": "POST",
		"response": {
			"data": { "accessToken": "{{body.access_token}}" },
			"scope": "{{body.scope}}"
		}
	}
}
```

| Aspect | Behavior |
|---|---|
| Value | IML-evaluated. It accepts a string array, a space-delimited string (RFC 6749 section 3.3), a comma-delimited string, or a mix. A string is split on any run of whitespace and commas and empty parts are dropped. In an array only non-empty string elements are kept, and they are not split further. Any other value counts as "not reported". |
| Precedence | A non-empty result **overrides** the stored scope and is deduplicated. It does **not** merge. The token response is authoritative, so a revoked scope drops off on the next exchange. |
| Fallback | When no item reports a scope, the scope list sent to the authorization server is merged into the stored scope and deduplicated. With no reported scope and no requested scope either, as in a client-credentials renewal, the stored scope stays unchanged. |
| `token` as an array | Each item is checked and the **last** item that reports a non-empty scope wins. Items skipped by `condition` do not count. A scope-less follow-up item (a long-token request, for example) cannot erase an earlier item's scope. |
| Client credentials | With no `authorize` or callback step there is no requested scope, so this directive is the **only** way to record a scope for that flow. |
| Failure | Nothing is recorded when the exchange fails. |

**Not supported under `refresh`, by design.** A refresh renews the access token. It is not an authorization event, so it must not change the recorded grant, and changing the scope requires re-authorizing the connection. `refresh.response.scope` is silently ignored: flag it in review. On renewal `token` runs again only when it is a single object with a `condition`, and an array-form `token` is never re-run (see [When and how the token is renewed](#when-and-how-the-token-is-renewed)).

## Connection expiry (token.response.expires)

`token.response.expires` sets the connection's expiry, which Make keeps apart from the connection data. Make does not derive it from `expires_in` on its own.

- The expression is evaluated after each `token` item, against that item's response.
- It is evaluated again after each `refresh` item, against the refresh response. `refresh.response.expires` is never read.
- Make reads it only when `token` is a **single** object. With an array `token`, every `token` and `refresh` step sets the expiry to empty.
- To use the expiry in a `condition`, also save it with `response.data` (for example as `data.expires`) in both `token` and `refresh`.
- How the platform acts on the stored expiry is outside this runtime.

```json
{
	"token": {
		"url": "https://provider.example/oauth/token",
		"method": "POST",
		"response": {
			"expires": "{{addSeconds(now; body.expires_in)}}",
			"data": {
				"accessToken": "{{body.access_token}}",
				"refreshToken": "{{body.refresh_token}}",
				"expires": "{{addSeconds(now; body.expires_in)}}"
			}
		}
	},
	"refresh": {
		"url": "https://provider.example/oauth/token",
		"method": "POST",
		"response": {
			"data": {
				"accessToken": "{{body.access_token}}",
				"refreshToken": "{{body.refresh_token}}",
				"expires": "{{addSeconds(now; body.expires_in)}}"
			}
		}
	}
}
```

## When and how the token is renewed

Before every HTTP request of an OAuth 2 connection, Make checks whether the token must be renewed. The check runs for every page, every `communication` item and every `repeat` iteration, in actions, searches, polling triggers, RPCs, Endpoints and webhook attach, update and detach. Actions, searches and polling and instant triggers are also checked once when the module starts.

The check evaluates the `condition` of every `token` item and every `refresh` item (a string, or the `{ "condition": ... }` form) against the connection's variables: `data`, `connection` and `parameters`, `common`, `scenario`, `environment`, `organization`, `temp` and `now`. `oauth` is not set in this check.

- Only the built-in IML functions are available in this check. A condition that calls a custom IML function or a runtime-only helper such as `jwt` or `parseJSON` fails the request.
- A literal `true` renews before every request.
- With no condition at all, Make never renews on its own.

When any condition is truthy, renewal starts:

| Directives | What runs |
|---|---|
| `token` is a single object with a `condition` (the client-credentials pattern) | `token` first, re-checking its own `condition`, then `refresh`, where items without a `condition` always run. If `token` fails, renewal stops there, `refresh` is never sent and the module fails with the token error. |
| `token` has no `condition`, or is an array | Only `refresh` runs. Token items are never re-run, even if their condition started the renewal. |
| Neither directive | Nothing happens. |

A `refresh` error fails the module request, mapped by the item's `response.error`. `InvalidAccessTokenError` is an allowed type there. The renewed values are saved into the same connection object, so the request that triggered the renewal already uses them.

```json
{
	"refresh": {
		"condition": "{{data.expires < addMinutes(now; 1)}}",
		"url": "https://provider.example/oauth/token",
		"method": "POST",
		"type": "urlencoded",
		"body": { "grant_type": "refresh_token", "refresh_token": "{{connection.refreshToken}}" }
	}
}
```

Client credentials:

```json
{
	"token": {
		"condition": "{{!data.accessToken || data.expires < addMinutes(now; 1)}}",
		"url": "https://provider.example/oauth/token",
		"method": "POST",
		"type": "urlencoded",
		"body": {
			"grant_type": "client_credentials",
			"client_id": "{{parameters.clientId}}",
			"client_secret": "{{parameters.clientSecret}}"
		},
		"response": { "data": { "accessToken": "{{body.access_token}}" } }
	}
}
```

## refresh keeps values the response omits

In `refresh.response.data` only, a top-level key whose expression evaluates to `null` or `undefined` keeps its stored value.

- A refresh response without `refresh_token` therefore keeps the old refresh token, and the `ifempty(body.refresh_token; data.refreshToken)` workaround is not needed.
- To clear a key there on purpose, write the literal `null`, `"{{null}}"` or `"{{undefined}}"` (spaces inside the braces are allowed).
- An empty string still overwrites. A nested object is replaced as a whole.
- In every other step a `null` value overwrites (see [response.data, response.metadata and audit](../runtime-reference.md#responsedata-responsemetadata-and-audit)).
- `refresh` has the `{{oauth.*}}` redirect URIs but no `oauth.scope`. `refresh.response.uid`, `refresh.response.metadata` and `refresh.response.scope` are ignored.

```json
{
	"refresh": {
		"url": "https://provider.example/oauth/token",
		"response": {
			"data": {
				"accessToken": "{{body.access_token}}",
				"refreshToken": "{{body.refresh_token}}"
			}
		}
	}
}
```

A refresh response with no `refresh_token` keeps the stored one.

## Saved connection data (response.data)

`response.data` in a connection step is evaluated deeply and merged into the stored connection data one level deep.

- A key that the directive produces overwrites the stored key. A nested object replaces the stored one as a whole. The other keys stay.
- When the merged data would exceed an estimated 64 KB, the step fails with `RuntimeError: Error processing module data. 'data' collection is too big.` and the stored data stays untouched (see [Limits](../runtime-reference.md#limits)).
- Basic connections can use this to drop a secret that the user entered, for example `"password": null`.
- Steps that save it: the basic `api` items; OAuth 2 `preauthorize`, the authorize callback, `token`, `refresh` and `info`; OAuth 1 `requestToken`, the callback, `accessToken` and `info`.

## Connection test (info) and uid

The connection test runs only `info` and passes when it raises no error. Without `info`, the test passes without any request.

- OAuth 2 `info` may be an array. OAuth 1 `info` must be a single object. An array is never run: with a top-level `oauth` object no request is sent and the test passes, and without one it fails with the empty-`oauth` error of [OAuth 1 connections](#oauth-1-connections), where the url shows as `unknown`.
- `response.data` is saved into the connection, and `response.metadata` is merged into the connection metadata (the connection label) across items.
- `response.uid` is evaluated again after every processed item, so an item without `response.uid` clears it. Put `uid` on the last item. Items skipped by `condition` do not touch it. The same last-item rule applies to basic connections.

```json
{
	"info": {
		"url": "https://provider.example/api/me",
		"headers": { "authorization": "Bearer {{connection.accessToken}}" },
		"response": {
			"uid": "{{body.id}}",
			"metadata": { "type": "email", "value": "{{body.email}}" }
		}
	}
}
```

## invalidate

`invalidate` (one request or an array) runs its items with `temp`, `condition`, `response.temp` and `response.valid`.

- `invalidate.response.data` is not saved.
- An error in any item fails the invalidation.
- When it runs (connection deletion or reauthorization) is decided by the platform, not by the app.

## Basic connections

For a basic connection (API key, username and password), Make checks the connection by running its `api`: one request, an array, or `{ "communication": [...] }`. In the communication form every item is deep-merged over the other top-level keys of `api`, so shared headers or a base URL can sit at the top.

- Each item runs top-level `temp`, `condition`, one request (no pagination), `response.temp`, `response.valid`, `response.data`, `response.metadata`, `response.uid` and `response.error`. `iterate`, `output`, `wrapper` and `repeat` are ignored.
- The variables are `parameters`, `connection` and `data` (the connection fields), `common`, `scenario`, `environment`, `temp` and `depconn`.
- `response.uid` is set from every item, so in an array the last item must carry it. An item without it sets the uid to empty (the same last-item rule as `info`).
- The check passes when no item fails.
- Basic connections are never checked or renewed before module requests, so nothing in them runs during a scenario.
- `response.data` can drop user secrets, for example `"password": null`.

When a check fails, the user sees one of these:

| Failure | Message |
|---|---|
| 4xx | `Status Code Error: <code>` (RuntimeError) |
| 429 | `Third party API limit likely exceeded` (RateLimitError) |
| 5xx | `Service is temporarily unavailable.` (ConnectionError) |
| `response.valid` false without a message | `Response marked as invalid.` |
| Network failure | A ConnectionError such as `ECONNREFUSED: The service <origin+path> is temporarily unavailable.` The query string is never shown. |

The item's `response.error`, or `response.valid.message` and `type`, can replace any of these.

When a basic connection's data references another connection, Make loads that connection before the check and exposes its data as `{{depconn.*}}`. After a successful check the reference is removed from the stored data, so later checks no longer load it.

```json
{
	"api": {
		"url": "https://api.example.com/me",
		"headers": { "x-api-key": "{{parameters.apiKey}}" },
		"response": {
			"valid": "{{body.ok}}",
			"metadata": { "type": "text", "value": "{{body.name}}" },
			"uid": "{{body.id}}"
		}
	}
}
```

## OAuth 1 connections

An OAuth 1 connection runs `requestToken`, then builds the `authorize` URL, then evaluates `authorize.response.temp`, `valid` and `data` on the callback (a `valid` that evaluates false fails with a TypeError, see [Callback and provider errors](#callback-and-provider-errors)), then runs `accessToken`. The connection test runs `info`.

- Each step is a single object. There are no arrays, no `preauthorize`, no `refresh` and no `invalidate`, and the connection is never renewed.
- The top-level `oauth` object is merged into each step's own `oauth`, with the step's keys winning. If the merged `oauth` is empty, `requestToken`, `accessToken` and `info` fail with `InvalidConfigurationError: OAuth1 parameters not present in request configuration for url: <url>` (`<url>` shows as `unknown` when the step has no `url`).
- In `requestToken`, `oauth.callback` is always forced to `{{oauth.redirectUri}}`.
- `requestToken.response.data` and `accessToken.response.data` are saved. `accessToken.response.metadata` is merged into the connection metadata (the connection label).

The authorize URL is `authorize.url`, then `?`, then `authorize.qs`:

- `qs` is evaluated only one level deep.
- Make adds `oauth_token` from `authorize.oauth.token` unless `qs` already has it, and adds no `state`.
- Spaces are encoded as `%20`, not `+`.
- The query is joined with a plain `?`, so an `authorize.url` that already contains a query string produces a malformed URL. Put every parameter in `qs`.
- Make keeps the 15-minute authorization record under the request token.

```json
{
	"authorize": {
		"url": "https://provider.example/oauth/authenticate",
		"qs": { "scope": "{{join(oauth.scope; ' ')}}" },
		"oauth": { "token": "{{temp.token}}" }
	}
}
```

This gives `...?scope=email%20profile&oauth_token=<token>`.
