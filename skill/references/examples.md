# App Example: Acme Photos (fictional)

> Read when: you need a complete app reference for structure and IMLJSON patterns (a fictional full app: connection, base, modules, RPCs, webhooks, custom functions).

This file contains practical IMLJSON pattern examples for Acme Photos, a fictional photo-sharing app. The vendor, its URLs and its field names are invented; the IMLJSON patterns are what to copy.

## App Directory Structure

```
acme-photos/
├── .sdk                          # {"version": 2}
├── metadata.json                 # App metadata
├── base.imljson                  # Common settings
├── assets/icon.png               # App icon
├── readme.md
├── connections/
│   └── acme-photos/              # OAuth connection
│       ├── metadata.json         # {"name":"acme-photos","label":"...","type":"oauth"}
│       ├── api.imljson           # authorize/token/refresh/info definition
│       ├── parameters.imljson    # clientId, clientSecret
│       ├── scope.imljson         # Default scope
│       └── scopes.imljson        # Available scopes list
├── modules/
│   ├── createPhotoPost/          # Action module
│   ├── listMedia/                # Search module
│   ├── watchMedia/               # Trigger module
│   ├── newEvents/                # Instant Trigger module
│   └── downloadMedia/            # Action (binary download)
├── rpcs/
│   └── getMedia/                 # Dynamic Options RPC
├── webhooks/
│   └── acme-photos/              # Shared Webhook
│       ├── api.imljson
│       ├── attach.imljson
│       ├── detach.imljson
│       └── metadata.json
└── functions/                    # Custom IML functions
    ├── parseError/code.js
    ├── getOutput/code.js
    ├── getHooks/code.js
    ├── getVerifyParam/code.js
    └── matchesFilter/code.js
```

## metadata.json

```json
{
    "name": "acme-photos",
    "label": "Acme Photos",
    "version": 1,
    "theme": "#2f6fde",
    "language": "en",
    "countries": null
}
```

## base.imljson — Common Settings (Auth, Error Handling, Logging)

```json
{
    "baseUrl": "https://api.acme-photos.example/v1",
    "headers": {
        "authorization": "Bearer {{connection.accessToken}}"
    },
    "timeout": "{{common.timeout || 40000}}",
    "response": {
        "error": {
            "429": {
                "type": "RateLimitError",
                "message": "[{{statusCode}}] {{body.error.message}}"
            },
            "message": "[{{statusCode}}] {{parseError(body.error)}}"
        }
    },
    "log": {
        "sanitize": ["request.headers.authorization"]
    }
}
```

Key points:
- 429 status code mapped to `RateLimitError` type — this is only needed here because the app uses a **custom error message** (`body.error.message`). The runtime already handles 429 → `RateLimitError` and 5xx → `ConnectionError` by default, so explicit directives are only necessary when you need custom message formatting.
- `parseError()` is a custom IML function (functions/parseError/code.js)
- Timeout overridable via `common.timeout`

## OAuth Connection — authorize/token/refresh/info Pattern

> `redirect_uri` uses `{{oauth.localRedirectUri}}` (host-aware — works on Make-hosted **and** self-hosted instances). Do not substitute `{{oauth.redirectUri}}` (legacy, integromat.com-only) or `{{oauth.makeRedirectUri}}` (make.com-only) in new code. The same value must appear in both `authorize.qs.redirect_uri` and `token[*].body.redirect_uri` (RFC 6749 § 4.1.3). See `component-patterns-reference/connection-oauth.md` § "OAuth2 Connection — `redirect_uri` Convention".

```json
{
    "authorize": {
        "qs": {
            "scope": "{{join(oauth.scope, ',')}}",
            "client_id": "{{ifempty(parameters.clientId, common.clientId)}}",
            "redirect_uri": "{{oauth.localRedirectUri}}",
            "response_type": "code"
        },
        "url": "https://auth.acme-photos.example/oauth/authorize",
        "response": {
            "temp": { "code": "{{query.code}}" },
            "data": { "userId": null }
        }
    },
    "token": [
        {
            "url": "https://auth.acme-photos.example/oauth/token",
            "body": {
                "code": "{{temp.code}}",
                "client_id": "{{ifempty(parameters.clientId, common.clientId)}}",
                "grant_type": "authorization_code",
                "redirect_uri": "{{oauth.localRedirectUri}}",
                "client_secret": "{{ifempty(parameters.clientSecret, common.clientSecret)}}"
            },
            "type": "urlencoded",
            "method": "POST",
            "response": {
                "data": {
                    "expires": "{{addSeconds(now, 1800)}}",
                    "accessToken": "{{body.access_token}}",
                    "userId": null
                }
            },
            "log": {
                "sanitize": [
                    "request.body.code",
                    "request.body.client_secret",
                    "response.body.access_token"
                ]
            }
        },
        {
            "url": "https://auth.acme-photos.example/oauth/long-lived-token",
            "qs": {
                "grant_type": "exchange_token",
                "client_secret": "{{ifempty(parameters.clientSecret, common.clientSecret)}}",
                "access_token": "{{connection.accessToken}}"
            },
            "response": {
                "data": {
                    "expires": "{{addSeconds(now, body.expires_in)}}",
                    "accessToken": "{{body.access_token}}"
                },
                "expires": "{{addSeconds(now, body.expires_in)}}"
            }
        }
    ],
    "refresh": {
        "condition": "{{data.userId && data.expires < addMinutes(now, 1)}}",
        "url": "https://auth.acme-photos.example/oauth/refresh",
        "qs": {
            "grant_type": "refresh_long_lived_token",
            "access_token": "{{data.accessToken}}"
        },
        "response": {
            "data": {
                "expires": "{{addSeconds(now, 1800)}}",
                "accessToken": "{{body.access_token}}"
            }
        }
    },
    "info": [
        {
            "url": "https://api.acme-photos.example/v1/me",
            "qs": { "fields": "id,username" },
            "headers": {
                "authorization": "Bearer {{connection.accessToken}}"
            },
            "response": {
                "uid": "{{body.id}}",
                "metadata": { "type": "text", "value": "{{body.username}}" },
                "data": { "userId": "{{body.id}}" }
            }
        }
    ]
}
```

Key points:
- `redirect_uri` uses `{{oauth.localRedirectUri}}` in **both** `authorize` and `token` (host-aware, self-host-safe; see note above)
- `token` is an array for multiple requests (short-lived → long-lived token exchange)
- `refresh.condition` triggers renewal 1 minute before expiry — `refresh` itself takes no `redirect_uri` (refresh-token grant has no callback)
- `info` sets `uid`, `metadata`, and `data`
- `ifempty(parameters.xxx, common.xxx)` pattern — user value first, falls back to common value

## Action Module — Multiple Requests (Create Photo Post)

```json
[
    {
        "url": "/{{connection.userId}}/media",
        "method": "POST",
        "qs": {
            "caption": "{{parameters.caption}}",
            "image_url": "{{parameters.image_url}}",
            "tagged_users": "{{createJSON(distinct(parameters.tagged_users; 'username'))}}"
        },
        "response": {
            "type": "json",
            "temp": { "id": "{{body.id}}" }
        }
    },
    {
        "condition": "{{temp.id}}",
        "url": "/{{connection.userId}}/media/publish?draft_id={{temp.id}}",
        "method": "POST",
        "response": {
            "type": "json",
            "output": "{{body}}"
        }
    }
]
```

Key points:
- First request stores media ID in `temp.id`
- Second request executes only on first request success via `condition`
- Uses `createJSON()`, `distinct()` IML functions

## Action Module — Binary Download (Download Media)

```json
[
    {
        "url": "/{{parameters.id}}",
        "method": "GET",
        "qs": { "fields": "kind,download_url" },
        "response": {
            "type": "json",
            "temp": {
                "kind": "{{body.kind}}",
                "download_url": "{{body.download_url}}"
            },
            "valid": { "condition": "{{body.download_url}}" },
            "error": {
                "200": {
                    "message": "[Acme Photos] The media item contains copyrighted material."
                },
                "type": "DataError",
                "message": "{{body.error.message}} ({{body.error.code}}, {{body.error.type}})"
            }
        }
    },
    {
        "condition": "{{temp.download_url}}",
        "url": "{{temp.download_url}}",
        "method": "GET",
        "type": "binary",
        "response": {
            "output": {
                "filename": "{{parameters.id}}.{{if(temp.kind == 'VIDEO', 'mp4', 'jpg')}}",
                "data": "{{body}}"
            }
        }
    }
]
```

Key points:
- `valid` + `error.200` combo: error when 200 response but no `download_url`
- `type: "binary"` for binary response handling
- `if()` function for dynamic file extension

## Search Module — Cursor Pagination (List Media)

```json
{
    "url": "/{{connection.userId}}/media",
    "method": "GET",
    "qs": {
        "fields": "caption,comment_count,comments_enabled,created_at,download_url,id,kind,like_count,owner,thumbnail_url,username,web_url"
    },
    "response": {
        "limit": "{{parameters.limit}}",
        "type": "json",
        "iterate": "{{body.data}}",
        "output": "{{getOutput(item)}}"
    },
    "pagination": {
        "condition": "{{body.paging.next}}",
        "url": "{{body.paging.next}}"
    }
}
```

Key points:
- Cursor pagination where the API returns the next page as a full URL: directly uses the `body.paging.next` URL
- `getOutput(item)` — custom function for post-processing like date conversion

## Trigger Module — Watch Media

```json
{
    "url": "/{{connection.userId}}/media",
    "method": "GET",
    "qs": {
        "fields": "caption,comment_count,id,..."
    },
    "response": {
        "iterate": "{{body.data}}",
        "trigger": {
            "id": "{{item.id}}",
            "date": "{{parseDate(item.created_at)}}",
            "type": "date",
            "order": "desc"
        },
        "limit": "{{parameters.limit}}",
        "output": "{{getOutput(item)}}"
    },
    "pagination": {
        "condition": "{{body.paging.next}}",
        "url": "{{body.paging.next}}"
    }
}
```

Epoch configuration:
```json
{
    "response": {
        "limit": 100,
        "output": {
            "date": "{{parseDate(item.created_at)}}",
            "label": "{{ifempty(substring(item.caption, 0, 100); 'ID: ' + item.id)}}"
        }
    }
}
```

## RPC — Dynamic Options (Get Media)

```json
{
    "url": "/{{connection.userId}}/media",
    "method": "GET",
    "qs": {
        "fields": "caption,...",
        "limit": 100
    },
    "response": {
        "type": "json",
        "iterate": {
            "condition": "{{matchesFilter(item, parameters.condition, parameters.value)}}",
            "container": "{{body.data}}"
        },
        "output": {
            "value": "{{item.id}}",
            "label": "{{if(item.caption, substring(item.caption, 0, 60), 'ID: ' + item.id)}}"
        }
    }
}
```

Using RPC in modules:
```json
{ "name": "id", "type": "select", "label": "Media ID", "options": "rpc://getMedia" }
```

Passing query parameters:
```json
"options": "rpc://getMedia?condition=kind&value=ALBUM"
```

## Webhook — Shared (acme-photos)

```json
{
    "verification": {
        "condition": "{{getVerifyParam(query, 'mode') === 'subscribe'}}",
        "respond": {
            "type": "text",
            "body": "{{getVerifyParam(query, 'challenge')}}"
        }
    },
    "iterate": "{{getHooks(body)}}",
    "uid": "{{item.id}}",
    "output": "{{item}}",
    "respond": { "status": 200 }
}
```

Attach (subscription registration):
```json
{
    "url": "/{{connection.userId}}/subscriptions",
    "method": "POST",
    "type": "multipart/form-data",
    "body": {
        "access_token": "{{connection.accessToken}}",
        "events": "comments,messages"
    },
    "response": { "type": "json", "output": null }
}
```

## Custom IML Functions (functions/)

Write plain JavaScript functions in `functions/{functionName}/code.js`:

```javascript
// parseError — extract a readable message from an error object
function parseError(error) {
    if (typeof error !== 'object' || error === null) return undefined;
    return error.message;
}
```

Usage in IMLJSON: `{{parseError(body.error)}}`

## Compiled Package Structure

> Internal-only topic: Make employees read it in the platform source they have access to. This plugin does not document it.
