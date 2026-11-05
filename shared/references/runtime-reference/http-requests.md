# Runtime reference: HTTP client details

> Read when: a request uses TLS options (`rejectUnauthorized`, `ca`, `cert`, `key`), AWS signing (`aws`), OAuth 1.0 signing (`oauth`), `shareCookies` or `gzip`, or you must know which headers Make adds or how the older HTTP client differs. Part of [runtime-reference.md](../runtime-reference.md).

This part holds the details of sending an HTTP request that the main reference only points at: which HTTP client runs, the headers and compression Make adds, TLS options, AWS and OAuth 1.0 signing, and shared cookies. How the URL, query string, headers, body, timeout and redirects are built is in [Building the request](../runtime-reference.md#building-the-request), and how the answer is read is in [Handling the response](../runtime-reference.md#handling-the-response). Every section describes the default HTTP client. Where the older client behaves differently, the first section lists it.

## Which HTTP client runs

By default every request goes through the newer HTTP client. That covers modules, searches, triggers, RPCs (webhook attach and detach included), Endpoints and the requests of a connection file.

- `"axios": true` or `"fetcher": true` in an `api` forces the newer client for it (the value is not evaluated as IML, any truthy value counts). `"axios": false` does not select the older client.
- Nothing in the IMLJSON can select the older client. A Make host can be configured to run the older client instead, and the two directives above still force the newer one for that `api`.

Where the older client differs, if a host runs it:

| Behaviour | Default client | Older client |
|---|---|---|
| Falsy JSON body (`""`, `0`, `false`, `null`) | Sent as that JSON text | Sent as an empty body |
| Header value `null` | Header not sent | Sent as the text `null` |
| `gzip` directive | Ignored: gzip, deflate and br are always decoded | Honoured: gzip and deflate responses are decoded only with `gzip` set, br is never decoded |
| `Accept-Encoding` | Always sent | Not sent unless `gzip` is set, then `gzip, deflate` |
| Characters in `qs` values | `! ( ) * ~` stay literal | `! ( ) *` are percent-encoded too |
| Zero-byte `binary` body | Sent with `Content-Length: 0` | Fails with `Argument error, options.body.` |
| Timeout | ConnectionError `ECONNABORTED: ...` | `ESOCKETTIMEDOUT: ...`, or `ETIMEDOUT: ...` while connecting, with no error code |
| Redirect limit | RuntimeError `Maximum number of redirects exceeded` | `Exceeded maxRedirects. Probably stuck in a redirect loop <url>` |
| 301 or 302 after PUT, PATCH or DELETE | Method and body are kept (only a POST becomes a GET) | Sent again as a GET without the body |
| TLS failure `SSL alert number 40` | Not retried | Retried once |
| `Connection` header | `close` on https, see the next section | `close` |

See [timeout](../runtime-reference.md#timeout), [redirects](../runtime-reference.md#redirects) and [No retries and no size limit](../runtime-reference.md#no-retries-and-no-size-limit) for the default behaviour in full.

## Headers Make adds and compression

| Header | What Make sends |
|---|---|
| `User-Agent` | `<brand>/<environment>` when the app sets none. `<brand>` is the brand title of the Make environment (`Integromat` when it has none), `<environment>` the name of the environment the worker runs in. A `User-Agent` set by the app is sent unchanged on every request, every pagination round and every redirect hop. |
| `Accept` | Nothing. Set it in `headers` when the server picks its format from it. |
| `Accept-Encoding` | `gzip, compress, deflate, br`, unless the app sets its own `Accept-Encoding`. |
| `Connection` | `close` on https requests: Make never keeps those connections alive. A plain http request is not forced to close: Make sets no agent for it, so the connection is left to the default HTTP agent and may be kept alive. An app-set `Connection` header is sent as set. |

```json
{ "headers": { "Accept": "application/json" } }
```

Compression:

- gzip, deflate and br responses are decompressed before the body is parsed, binary bodies included.
- After decompression `content-encoding` is gone from `{{headers}}`, but `content-length` still shows the compressed size.
- A file served as `application/gzip` without a `Content-Encoding` header is not decompressed.
- The `gzip` directive does nothing on the default client, because decompression is always on. The public docs call it deprecated.

## TLS options

`rejectUnauthorized` is evaluated as IML. Make checks the server certificate unless the result is the boolean `false`:

| `rejectUnauthorized` | Certificate check |
|---|---|
| the boolean `false`, written as `false` or `{{false}}` | Off |
| anything else: not set, `true`, the text `"false"`, `0`, `""`, `null`, `{{null}}` | On |

With the check on and a bad certificate, the module fails with RuntimeError `Blocked the insecure HTTPS connection. ...` and is not retried. The message names the origin and the error code, adds a fix hint and ends with a link to the public fix page (the full text is in [When no response arrives](../runtime-reference.md#when-no-response-arrives)). The hint depends on the code:

| Error code | Hint says |
|---|---|
| `DEPTH_ZERO_SELF_SIGNED_CERT` | The certificate is self-signed: paste its public key into the connection's "Advanced settings" |
| `SELF_SIGNED_CERT_IN_CHAIN` | The issuer is self-signed: paste the CA certificate's public key |
| `CERT_HAS_EXPIRED` | The certificate has expired: the server owner must update it |
| `ERR_TLS_CERT_ALTNAME_INVALID` | The certificate was issued for a different DNS name: check the host name in the connection, otherwise the server owner must fix it |
| `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` | The issuer is a CA that Make does not trust, typically a private or corporate one: paste the CA's public key |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | The server did not send its complete certificate chain: paste the CA's public key for a private CA, otherwise the server owner must fix it |

For any other certificate error code the error shows the system's own message instead of a hint.

With the check off, the request succeeds even when the certificate is bad. Action and trigger modules then still return their result but finish with a Warning `Insecure HTTPS connection detected. ...`. It names the origin and the error code, then gives the hint of the table above (for any other code a note that the problem is on the third-party server and its owner should fix the certificate) and the same link. Searches, RPCs and connection calls return no warning.

`ca`, `cert` and `key` are evaluated as IML and hold PEM strings. When one is empty, Make uses `request.ca`, `request.cert` or `request.key` from the app's common data. A custom `ca` replaces the default trust store for that request. `cert` and `key` make Make present a client certificate.

```json
{ "rejectUnauthorized": "{{connection.allowSelfSigned != true}}", "ca": "{{connection.caCert}}" }
```

Here the check is off only when the user has set `allowSelfSigned` to true.

## AWS signing

The `aws` directive signs the request for AWS. It is evaluated as IML one level deep (see [Directive objects and expression types](../runtime-reference.md#directive-objects-and-expression-types)), and every pagination round is signed again.

- When it evaluates to a falsy value (`undefined`, `null`, `""`, `0`, `false`), nothing is signed. One module can therefore serve an AWS connection and a non-AWS connection: an IML function returns the object for the first and nothing for the second. An object is never falsy. `{}` is signed with Signature Version 2 and the module fails before the request is sent, because there is no `secret`. With `sign_version` 4 and no `key` or `secret`, the request goes out signed with the credential `undefined`.
- `sign_version` 4, as a number or the text `"4"`, signs with Signature Version 4 using `key`, `secret`, an optional `session` (sent as `x-amz-security-token`) and an optional `service`. Any other value, or none, signs with Signature Version 2. The public docs name 2 as the default and `service` as required for version 4; in Make `service` can be left out when the host names it.
- The region cannot be set: a `region` key is ignored. Make reads the region and the service from a host of the form `<service>.<region>.amazonaws.com`. Without such a host the region is `us-east-1`, and `service` must be given, otherwise the signature has an empty service name. A `service` key wins over the host.
- Version 4 covers the final path and query, the body and the headers set at that point, `Cookie` included (the jar of `shareCookies` is merged first). `User-Agent`, `Authorization`, `Connection`, `Expect` and `Range` (also when the app sets them) and `Accept-Encoding`, which is added when the request goes out, are not part of it.
- Version 4 adds headers, and all of them are really sent: `x-amz-date`, `content-length`, `x-amz-content-sha256` for `s3`, `x-amz-security-token` with a `session`, and, when a body has no `Content-Type`, `application/x-www-form-urlencoded; charset=utf-8`. Set `Content-Type` yourself for a binary S3 upload, or the upload goes out with that type.
- Version 2 sets a `date` header and `Authorization: AWS <key>:<signature>`. The signature covers the method, `content-md5`, `content-type`, the date, the `x-amz-*` headers and the resource `/<bucket><path>`, where `bucket` is an optional key of `aws`.

```json
{
	"aws": { "key": "{{connection.key}}", "secret": "{{connection.secret}}", "sign_version": 4, "service": "s3" },
	"headers": { "Content-Type": "image/jpeg" }
}
```

## OAuth 1.0 request signing

The `oauth` directive signs a request with OAuth 1.0. It works on any request: the steps of an OAuth 1 connection, modules, RPCs, webhook calls and Endpoints. It is evaluated as IML one level deep, and the request is signed once its body, headers and shared cookies are final. Every pagination round is signed again with a fresh nonce and timestamp.

- A falsy result skips signing silently, so one module can serve an OAuth 1 connection and an OAuth 2 connection (an IML function returns the object for the first and nothing for the second). An empty object is not falsy: it is signed with the defaults and no keys.
- Each key `k` is sent as `oauth_k`, except `consumer_secret`, `private_key` and `token_secret` (used only to sign), `realm` and `transport_method`.
- Defaults: `version` `1.0`, `timestamp` the current Unix time in seconds, `nonce` a random 32-character hex string, `signature_method` `HMAC-SHA1`. Values the app sets for them are used as given.
- `signature_method` can be `HMAC-SHA1`, `HMAC-SHA256`, `RSA-SHA1` (with `private_key`) or `PLAINTEXT`. Any other value fails with RuntimeError `Signature method not supported: <method>`.
- The signature covers the method, the URL without its query, the query parameters, an urlencoded body and the OAuth parameters.

`transport_method` decides where the signed parameters go:

| `transport_method` | Result |
|---|---|
| `header` (the default) | `Authorization: OAuth realm="...",oauth_a="...",...,oauth_signature="..."`: `realm` first when set, the others sorted by name, the signature last, values RFC 3986 encoded and quoted, no spaces. It replaces any `Authorization` header of the app. |
| `query` | The parameters are appended to the URL after the app's own query. |
| `body` | The parameters are appended to the urlencoded body. The request `type` must be `urlencoded`, otherwise RuntimeError `When OAuth "transport_method" is set to "body" the request "type" must be "urlencoded"`. |
| anything else | RuntimeError `The OAuth "transport_method" directive is invalid` |

With `query` or `body`, a `realm` is sent as a plain `realm` parameter before the others.

`body_hash`:

- A boolean (`true` and also `false`) adds `oauth_body_hash`, the base64 SHA-1 of the exact bytes sent (of an empty body for a GET).
- An urlencoded body is already covered by the signature, so there the boolean is not computed but sent literally (`oauth_body_hash=true`). Leave `body_hash` out of urlencoded requests.
- A text value is sent as it is.
- It works only with `HMAC-SHA1` or `RSA-SHA1`. Any other method fails with RuntimeError `The OAuth signature_method "<method>" not supported with "body_hash" signing.`

```json
{
	"oauth": {
		"consumer_key": "{{common.consumerKey}}",
		"consumer_secret": "{{common.consumerSecret}}",
		"token": "{{connection.token}}",
		"token_secret": "{{connection.tokenSecret}}",
		"body_hash": true
	}
}
```

The older HTTP client hands the same object to its own signer, so its messages for a wrong `transport_method` or `body_hash` read differently, and a `body_hash` on a GET fails there.

## Cookies (shareCookies)

Requests that never set `shareCookies` carry no cookies at all, not even across a redirect.

`shareCookies` is a literal: it is not evaluated as IML, and any truthy value turns it on, including the text `"false"`. Put it on a request, or on the `api` that wraps a `communication` array.

- The first request that sets it opens a cookie jar for its host (host name and port) for the rest of that module execution. The jar is not kept between bundles or runs. A request to another port of the same host name has its own jar.
- Make stores the `Set-Cookie` headers of every response from that host, redirect responses included. It sends them again, by the normal cookie rules for domain, path, secure and expiry, on later requests to that host within the same execution: the next `communication` steps, pagination rounds and redirects. Those later requests do not need to set `shareCookies` themselves. A request that runs before the first one that sets it stores nothing.
- Jar cookies are appended to a string `cookie` header of the app (`manual=1; session=abc`). An array-valued `cookie` header is replaced by the jar cookies.
- A cookie goes only to the hosts its domain matches, and a host-only cookie (one without a `Domain` attribute) never goes to another host. During a redirect chain the jar of the host where the request started is used for every hop, and a cookie set by another host of the chain stays scoped to that host: it is not sent back to the starting host, nor on a later separate request to that other host.
- A cookie with a `Domain` attribute (for example `Domain=example.com`) is replayed to other subdomains only inside the same redirect chain. A later separate request to another subdomain has its own jar and does not get it.
- A cookie whose `Domain` does not match the host that set it, or is a public suffix such as `.com`, is silently dropped.

```json
{ "shareCookies": true, "communication": [ { "url": "/login", "method": "POST" }, { "url": "/data" } ] }
```
