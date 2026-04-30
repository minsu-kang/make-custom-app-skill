# Real-World App Example — Instagram for Business (v5)

This file contains practical IMLJSON pattern examples based on the Instagram app source code.

## App Directory Structure

```
instagram/
├── .sdk                          # {"version": 2}
├── metadata.json                 # App metadata
├── base.imljson                  # Common settings
├── assets/icon.png               # App icon
├── readme.md
├── connections/
│   └── instagram2/               # OAuth connection
│       ├── metadata.json         # {"name":"instagram2","label":"...","type":"oauth"}
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
│   └── instagram2/               # Shared Webhook
│       ├── api.imljson
│       ├── attach.imljson
│       ├── detach.imljson
│       └── metadata.json
└── functions/                    # Custom IML functions
    ├── parseError/code.js
    ├── getOutput/code.js
    ├── getHooks/code.js
    └── getHub/code.js
```

## metadata.json

```json
{
    "name": "instagram",
    "label": "Instagram for Business (Instagram login)",
    "version": 5,
    "theme": "#c13584",
    "language": "en",
    "countries": null
}
```

## base.imljson — Common Settings (Auth, Error Handling, Logging)

```json
{
    "baseUrl": "https://graph.instagram.com/v23.0",
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

> `redirect_uri` uses `{{oauth.localRedirectUri}}` (host-aware — works on Make-hosted **and** self-hosted instances). Do not substitute `{{oauth.redirectUri}}` (legacy, integromat.com-only) or `{{oauth.makeRedirectUri}}` (make.com-only) in new code. The same value must appear in both `authorize.qs.redirect_uri` and `token[*].body.redirect_uri` (RFC 6749 § 4.1.3). See `component-patterns-reference.md` § "OAuth2 Connection — `redirect_uri` Convention".

```json
{
    "authorize": {
        "qs": {
            "scope": "{{join(oauth.scope, ',')}}",
            "client_id": "{{ifempty(parameters.clientId, common.clientId)}}",
            "redirect_uri": "{{oauth.localRedirectUri}}",
            "response_type": "code"
        },
        "url": "https://api.instagram.com/oauth/authorize",
        "response": {
            "temp": { "code": "{{query.code}}" },
            "data": { "userId": null }
        }
    },
    "token": [
        {
            "url": "https://api.instagram.com/oauth/access_token",
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
            "url": "https://graph.instagram.com/access_token",
            "qs": {
                "grant_type": "ig_exchange_token",
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
        "url": "https://graph.instagram.com/refresh_access_token",
        "qs": {
            "grant_type": "ig_refresh_token",
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
            "url": "https://graph.instagram.com/me",
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
            "user_tags": "{{createJSON(distinct(parameters.user_tags; 'username'))}}"
        },
        "response": {
            "type": "json",
            "temp": { "id": "{{body.id}}" }
        }
    },
    {
        "condition": "{{temp.id}}",
        "url": "/{{connection.userId}}/media_publish?creation_id={{temp.id}}",
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
        "qs": { "fields": "media_type,media_url" },
        "response": {
            "type": "json",
            "temp": {
                "media_type": "{{body.media_type}}",
                "media_url": "{{body.media_url}}"
            },
            "valid": { "condition": "{{body.media_url}}" },
            "error": {
                "200": {
                    "message": "[Instagram] The IG media contains copyrighted material."
                },
                "type": "DataError",
                "message": "{{body.error.message}} ({{body.error.code}}, {{body.error.type}})"
            }
        }
    },
    {
        "condition": "{{temp.media_url}}",
        "url": "{{temp.media_url}}",
        "method": "GET",
        "type": "binary",
        "response": {
            "output": {
                "filename": "{{parameters.id}}.{{if(temp.media_type == 'VIDEO', 'mp4', 'jpg')}}",
                "data": "{{body}}"
            }
        }
    }
]
```

Key points:
- `valid` + `error.200` combo: error when 200 response but no `media_url`
- `type: "binary"` for binary response handling
- `if()` function for dynamic file extension

## Search Module — Cursor Pagination (List Media)

```json
{
    "url": "/{{connection.userId}}/media",
    "method": "GET",
    "qs": {
        "fields": "caption,comments_count,id,is_comment_enabled,like_count,media_type,media_product_type,media_url,owner,permalink,shortcode,thumbnail_url,timestamp,username"
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
- Facebook/Instagram API cursor pagination: directly uses `body.paging.next` URL
- `getOutput(item)` — custom function for post-processing like date conversion

## Trigger Module — Watch Media

```json
{
    "url": "/{{connection.userId}}/media",
    "method": "GET",
    "qs": {
        "fields": "caption,comments_count,id,..."
    },
    "response": {
        "iterate": "{{body.data}}",
        "trigger": {
            "id": "{{item.id}}",
            "date": "{{parseDate(item.timestamp)}}",
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
            "date": "{{parseDate(item.timestamp)}}",
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
            "condition": "{{manageRpcCondition(item, parameters.condition, parameters.value)}}",
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
"options": "rpc://getMedia?condition=media_type&value=CAROUSEL_ALBUM"
```

## Webhook — Shared (instagram2)

```json
{
    "verification": {
        "condition": "{{getHub(query, 'mode') === 'subscribe'}}",
        "respond": {
            "type": "text",
            "body": "{{getHub(query, 'challenge')}}"
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
    "url": "/{{connection.userId}}/subscribed_apps",
    "method": "POST",
    "type": "multipart/form-data",
    "body": {
        "access_token": "{{connection.accessToken}}",
        "subscribed_fields": "comments,messages"
    },
    "response": { "type": "json", "output": null }
}
```

## Custom IML Functions (functions/)

Write plain JavaScript functions in `functions/{functionName}/code.js`:

```javascript
// parseError — extract message from error object
function parseError(error) {
    if (typeof error !== 'object' || error === null) return undefined;
    const errorMessages = [];
    if (error.message) errorMessages.push(error.message);
    if (error.error_user_title) errorMessages.push(error.error_user_title);
    if (error.error_user_msg) errorMessages.push(error.error_user_msg);
    return errorMessages.length > 0 ? errorMessages.join("\n") : undefined;
}
```

Usage in IMLJSON: `{{parseError(body.error)}}`

## Compiled Package Structure

Source → Compile → 3 packages:

| Package | Files | Content |
|---------|-------|---------|
| `instagram-app@5.2.2` | `lib/app.js`, `lib/functions.js`, `lib/rpc.js`, `manifest.json` | Module + RPC logic |
| `instagram-account@5.2.2` | `lib/account.js`, `lib/functions.js`, `manifest.json` | Connection auth logic |
| `instagram2-hook@5.2.2` | `lib/hook.js`, `lib/functions.js`, `manifest.json` | Webhook processing logic |

`install.json` — Common data initial setup:
```json
{
    "spec": [
        { "name": "timeout", "type": "uinteger", "label": "Module Timeout", "default": 40000 }
    ],
    "directives": {
        "common": { "timeout": "{{parameters.timeout}}" }
    }
}
```
