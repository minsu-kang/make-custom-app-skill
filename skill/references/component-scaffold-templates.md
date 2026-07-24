# Component Scaffold Templates (SDK defaults)

When the Make SDK creates a new module / RPC / webhook, the files are **pre-filled with default scaffold boilerplate** — not real code. `review-changes.js` then reports this boilerplate as the change's `old_value`. That `old_value` is **not a real prior implementation**, so the component is effectively **new**.

## How to use this file (code review)

For any change that has an `old_value`, compare the `old_value` (whitespace-/comment-insensitive) against the matching scaffold below:

- **`old_value` matches a scaffold → the component is NEW.** Skip the `old_value → new_value` diff (the diff is meaningless) and skip the **Breaking Changes** category for that component. Still review the quality of `new_value`.
- **`old_value` is a genuine implementation (no scaffold match) → real existing component.** Do the full `old_value → new_value` diff and the Breaking Changes evaluation. This includes shared components (`base`, a shared RPC, …) that a new-component task happens to touch.
- **Module publish/visibility state is never a finding.** A new module is normally `private: true` / `private: null` in `metadata.json` during implementation/review; the deployer makes it public after QA. Do not flag it.
- **When ambiguous**, run the Breaking eval rather than skipping (a false-positive breaking flag is safer than a missed one).

## Source / refresh

These are copied from the Make template app **`model`, version 1**. To refresh after an SDK template change, run `download-app.js model 1` and re-copy from `make-app-contexts/model-v1/`. The model app exposes one example component per kind.

`typeId` → module scaffold (read the reviewed component's `typeId` from the app's `metadata.json`):

| `typeId` | Kind | Scaffold module(s) in `model` |
|---|---|---|
| 4 | Action | `Action`, `ActionCreate`, `ActionUpdate`, `ActionDelete` |
| 9 | Search | `Search` |
| 1 | Trigger (polling) | `Trigger` |
| 10 | Instant Trigger | `InstantTrigger` |
| 11 | Responder | `Responder` |
| 12 | Universal | `Universal`, `UniversalGraphQL`, `blank` |
| — | RPC | `rpcs/RemoteProcedure` |
| — | Webhook | `webhooks/dedicated`, `webhooks/shared` |

---

## Module `api.imljson` scaffolds

### Action (typeId 4) — `Action`

```json
{
	// Request to API endpoint with parameter "id" defined in Mappable parameters.
	"url": "/users/{{parameters.id}}",      // Relative to base URL
	"method": "GET",
	"headers": {},                          // Additional HTTP headers
	"qs": {},                               // Query string

	// Response handling
	"response": {
		"output": "{{body}}"                // Return JSON response body as an output bundle.
	}
}
```

### Action — Create (typeId 4) — `ActionCreate`

```json
{
	// Request to API endpoint.
	"url": "/users",  // Relative to base URL
	"method": "POST",
	"headers": {},    // Additional HTTP headers
	"qs": {},         // Query string
	"body": {
		"{{...}}": "{{omit(parameters,'birthday')}}",                    // Sends all parameters except the "birthday" that should get special attention.
		"birthday": "{{formatDate(parameters.birthday, 'YYYY-MM-DD')}}"  // Sends "birthday" parameter formatted as "YYYY-MM-DD".
	},

	// Response handling
	"response": {
		"output": "{{body}}"  // Returns API response body as an output bundle.
	}
}
```

### Action — Update (typeId 4) — `ActionUpdate`

```json
{
	// Request to API endpoint with parameter "id" defined in Mappable parameters.
	"url": "/users/{{parameters.id}}",     // Relative to base URL
	"method": "PUT",
	"headers": {},                         // Additional HTTP headers
	"qs": {},                              // Query string
	"body": "{{omit(parameters, 'id')}}",  // Request body omitting the ID that is already being sent in URL.

	// Response handling
	"response": {
		"output": "{{undefined}}"  // Returns no output bundle as no API output is expected.
	}
}
```

### Action — Delete (typeId 4) — `ActionDelete`

```json
{
	// Request to API endpoint with parameter "id" defined in Mappable parameters.
	"url": "/users/{{parameters.id}}",  // Relative to base URL
	"method": "DELETE",
	"headers": {},                      // Additional HTTP headers
	"qs": {},                           // Query string

	// Response handling
	"response": {
		"output": "{{undefined}}"       // Returns no output bundle.
	}
}
```

### Search (typeId 9) — `Search`

```json
{
	// Request to API endpoint.
	"url": "/users",                       // Relative to base URL
	"method": "GET",
	"headers": {},                         // Additional HTTP headers
	"qs": {                                // Query string
		"search": "{{parameters.search}}"  // Parameter "search" that is defined in Mappable parameters.
	},

	// Response handling
	"response": {
		// Splits array from API response into bundles.
		// See documentation at: https://docs.integromat.com/apps/app-blocks/api/pagination
		"iterate": "{{body.users}}",       // Iterates "users" array from API response to split it into individual items.

		"output": "{{item}}",              // Outputs whole each iterated "item" object as separate bundle.
		"limit": "{{parameters.limit}}"    // Limits number of output bundles as requested by user (even if API returns more items).
	}
}
```

### Trigger / polling (typeId 1) — `Trigger`

```json
{
	// Request to API endpoint
	"url": "/users",                     // Relative to base URL
	"method": "GET",
	"headers": {},                       // Additinal HTTP headers
	"qs": {                              // Query string
		"pageSize": 100
	},

	// Response handling
	"response": {
		// Splits the array from API response into bundles.
		// See documentation at: https://docs.integromat.com/apps/app-blocks/api/pagination
		"iterate": "{{body.users}}",     // Iterates "users" array from API response to split it into individual items.

		// New items search specification
		// See documentation at: https://docs.integromat.com/apps/app-structure/modules/trigger#response.trigger
		"trigger": {
			"type": "date",              // Identifies trigger polling by date.
			"id": "{{item.id}}",         // Identifies items by its property: "id".
			"date": "{{item.created}}",  // Identifies items by its property: "created" date.
			"order": "desc"              // Specifies in what order the remote API returns items.
		},

		"output": "{{item}}",            // Outputs whole each iterated "item" object as separate bundle.
		"limit": "{{parameters.limit}}"  // Limits number of output bundles as requested by user (even if API returns more items).
	}
}
```

### Instant Trigger (typeId 10) — `InstantTrigger`

```json
{
}
```

> Instant-trigger logic lives in the linked webhook, so the module `api.imljson` scaffold is empty.

### Responder (typeId 11) — `Responder`

```json
{
	"response": {
		"status": 200,
		"body": {
			"text": "{{parameters.text}}"
		},
		"headers": {
			"content-type": "application/json"
		}
	}
}
```

### Universal (typeId 12) — `Universal`

```json
{
    "qs": {
        "{{...}}": "{{toCollection(parameters.qs, 'key', 'value')}}"
    },
    "url": "https://www.example.com/api{{parameters.url}}",  // Defines the fixed base URL and maps the relative path URL from the user.
    "body": "{{parameters.body}}",
    "type": "text",
    "method": "{{parameters.method}}",
    "headers": {
        "{{...}}": "{{toCollection(parameters.headers, 'key', 'value')}}"
    },
    "response": {
        "output": {
            "body": "{{body}}",
            "headers": "{{headers}}",
            "statusCode": "{{statusCode}}"
        }
    }
}
```

### Universal — GraphQL (typeId 12) — `UniversalGraphQL`

```json
{
	"qs": {
		"query": "{{parameters.queryQs}}"
	},
	"url": "https://www.example.com/graphql",  // Defines the fixed base URL.
	"body": {
		"query": "{{parameters.queryBody}}",
		"variables": "{{if(isArray(parameters.variables), toCollection(parameters.variables, 'key', 'value'), parameters.variables)}}",
		"operationName": "{{parameters.operationName}}"
	},
	"type": "json",
	"method": "{{parameters.method}}",
	"headers": {
		"Content-Type": "application/json"
	},
	"response": {
		"output": {
			"body": "{{body}}",
			"headers": "{{headers}}",
			"statusCode": "{{statusCode}}"
		}
	}
}
```

### Blank (typeId 12) — `blank`

```json
{}
```

---

## RPC scaffold — `rpcs/RemoteProcedure`

`api.imljson`:

```json
{
	"url": "/api/users",
	"method": "GET",
	"qs": {},
	"body": {},
	"headers": {},
	"response": {
		"iterate": "{{body.users}}",
		"output": {
			"label": "{{item.name}}",
			"value": "{{item.id}}"
		}
	}
}
```

`parameters.imljson`:

```json
[]
```

---

## Webhook scaffolds — `webhooks/dedicated`, `webhooks/shared`

### Dedicated webhook

`api.imljson`:

```json
{
	"output": "{{body}}"  // Returns webhook's response body as an output bundle.
}
```

`attach.imljson` (all lines commented out by default):

```json
{
	//	// Uncomment and update the following lines to implement the "attach" method.
	//
	//	// Request
	//	"url": "https://www.example.com/api/v2/webhook",
	//	"method": "POST",
	//	"body": {
	//		"url": "{{webhook.url}}"
	//	},
	//
	//	// Response handling
	//	"response": {
	//		"data": {
	//			"externalHookId": "{{body.id}}",  // Stores the webhook's ID to be used in the detach remote procedure. It is accessible via "{{webhook.externalHookId}}".
	//			"token": "{{body.token}}"         // Stores the webhook's token to be used in the detach remote procedure. It is accessible via "{{webhook.token}}".
	//		}
	//	}
}
```

`detach.imljson` (all lines commented out by default):

```json
{
	// // Uncomment and update the following lines to implement the "detach" method.
	//
	// "url": "https://www.example.com/api/v2/webhook/{{webhook.externalHookId}}",
	// "method": "DELETE"
}
```

### Shared webhook

`api.imljson`:

```json
{
	"uid": "{{item.uid}}",  // "UID" parameter is used to match the incoming event with their owners.
	                        // The "UID" parameter must be defined in the connection specification.
	"output": "{{item}}"    // Returns JSON response item as an output bundle.
}
```

---

## Connection scaffolds — `connections/model-*`

The `model` app ships one connection per auth type. Match a connection change's `old_value` (mainly `api.imljson` + `parameters.imljson`) against the matching type.

| `model` connection | metadata `type` | Auth kind |
|---|---|---|
| `model-apikey` | basic | API Key |
| `model-basic` | basic | Basic (username/password) |
| `model-other` | basic | Other / none |
| `model-oauth` | oauth | OAuth2 — authorization code (no refresh) |
| `model-oauth-refresh` | oauth | OAuth2 — authorization code + refresh token |
| `model-oauth-clicre` | oauth | OAuth2 — client credentials |
| `model-oauth-resowncre` | oauth | OAuth2 — resource owner password |
| `model-oauth-1` | oauth | OAuth1 |

> Each connection also ships `common.imljson`, `install.imljson`, `installSpec.imljson`, `scope.imljson`, `scopes.imljson` as scaffolded defaults — refresh via `download-app.js model 1` to inspect them. The `api.imljson` is the discriminator.

### API Key — `model-apikey`

`api.imljson`:

```json
{
	// Request
	"url": "https://www.example.com/api/whoami",          // Absolute URL to the API endpoint which validates credentials
	"headers": {                                          // Additional HTTP headers
		"Authorization": "Bearer {{parameters.apiKey}}"   // Authorizes user by API key, provided by user during the connection creation.
	},

	// Response handling
	"response": {
		"metadata": {                                     // Adds authorized user details to the connection label.
			"type": "email",                              // Type of the parameter. Can be "text" or "email".
			"value": "{{body.email}}"                     // The value in "email" will be displayed in connection's label.
		},
		"error": {                                        // Error handling
			"message": "[{{statusCode}}] {{body.error}}"  // On error, returns error message as "[statusCode] error text".
		}
	},

	"log": {
		"sanitize": [                                     // Excludes sensitive parameters from logs.
			"request.headers.authorization"               // Omit HTTP header "Authorization".
		]
	}
}
```

`parameters.imljson`:

```json
[
    {
        "name": "apiKey",
        "type": "password",
        "label": "API Key",
        "required": true,
        "editable": true
    }
]
```

### Basic — `model-basic`

`api.imljson`:

```json
{
	// Request
	"url": "https://www.example.com/api/whoami",          // Absolute URL to the API endpoint which validates credentials
	"headers": {                                          // Additional HTTP headers
		// Authorizes user by username and password, provided by user during the connection creation.
		"authorization": "Basic {{base64(parameters.username + ':' + parameters.password)}}"
	},

	// Response handling
	"response": {
		"metadata": {                                     // Adds authorized user details to the connection label.
			"type": "email",                              // Type of the parameter. Can be "text" or "email".
			"value": "{{body.email}}"                     // The value in "email" will be displayed in connection's label.
		},
		"error": {                                        // Error handling
			"message": "[{{statusCode}}] {{body.error}}"  // On error, returns error message as "[statusCode] error text".
		}
	},

	"log": {
		"sanitize": [                                     // Excludes sensitive parameters from logs.
			"request.headers.authorization"               // Omit HTTP header "Authorization".
		]
	}
}
```

`parameters.imljson`:

```json
[
    {
        "name": "username",
        "type": "text",
        "label": "Username",
        "required": true,
        "editable": true
    },
    {
        "name": "password",
        "type": "password",
        "label": "Password",
        "required": true,
        "editable": true
    }
]
```

### Other / none — `model-other`

`api.imljson`:

```json
{
}
```

`parameters.imljson`:

```json
[
]
```

### OAuth2 — authorization code — `model-oauth`

`api.imljson`:

```json
{
	// Step 1: OAuth2 authorization request
	// See OAuth2 documentation: https://www.oauth.com/oauth2-servers/server-side-apps/authorization-code/
	"authorize": {
		"url": "https://www.example.com/oauth/authorize",                      // Endpoint for authorization
		"qs": {
			"scope": "{{join(oauth.scope, ',')}}",                             // Lists the scopes from the "default scope" tab.
			"client_id": "{{ifempty(parameters.clientId, common.clientId)}}",  // Client ID either provided in common parameters (below) or by the user.
			"redirect_uri": "{{oauth.localRedirectUri}}",                      // Redirect URI (see the link above).
			"response_type": "code"                                            // Response type "code".
		},

		// Authorization response handling
		// See OAuth2 documentation https://www.oauth.com/oauth2-servers/authorization/the-authorization-response/
		"response": {
			"temp": {
				"code": "{{query.code}}"
			}
		}
	},

	// Step 2: OAuth2 token request
	"token": {
		"url": "https://www.example.com/api/token",
		"method": "POST",
		"body": {
			"code": "{{temp.code}}",                                           // Uses stored "code" from authorization response.
			"client_id": "{{ifempty(parameters.clientId, common.clientId)}}",
			"grant_type": "authorization_code",                                // Sets the "grant_type" to "authorization_code".
			"redirect_uri": "{{oauth.localRedirectUri}}",
			"client_secret": "{{ifempty(parameters.clientSecret, common.clientSecret)}}"
		},
		"type": "urlencoded",

		// Token response handling
		"response": {
			"data": {
				"accessToken": "{{body.access_token}}"     // Stores the accessToken.
			}
		},

		"log": {
			"sanitize": [                                  // Excludes sensitive parameters from logs.
				"request.body.code",
				"request.body.client_secret",
				"response.body.access_token"
			]
		}
	},

	// Request to get authorized user information
	"info": {
		"url": "https://www.example.com/api/whoami",
		"headers": {
			"authorization": "Bearer {{connection.accessToken}}"
		},
		"response": {
			"uid": "{{body.id}}",                          // Unique ID of user's account.
			"metadata": {
				"type": "text",                            // Type of the parameter. Can be "text" or "email".
				"value": "{{body.user}}"                   // The value in "user" will be displayed in connection's label.
			}
		},
		"log": {                                           // Excludes sensitive parameters from logs.
			"sanitize": ["request.headers.authorization"]  // Omit HTTP header "Authorization".
		}
	},

	// Access token invalidation
	"invalidate": {
		"url": "https://www.example.com/oauth/invalidate",
		"headers": {
			"authorization": "Bearer {{connection.accessToken}}"
		},
		"log": {                                           // Excludes sensitive parameters from logs.
			"sanitize": ["request.headers.authorization"]  // Omit HTTP header "Authorization".
		}
	}
}
```

`parameters.imljson` (shared by the OAuth2 connections):

```json
[
    {
        "name": "clientId",
        "type": "text",
        "label": "Client ID",
        "advanced": true,
        "editable": true
    },
    {
        "name": "clientSecret",
        "type": "password",
        "label": "Client Secret",
        "advanced": true,
        "editable": true
    }
]
```

### OAuth2 — authorization code + refresh — `model-oauth-refresh`

`api.imljson`:

```json
{
	// Step 1: OAuth2 authorization request
	"authorize": {
		"url": "https://www.example.com/oauth/authorize",
		"qs": {
			"scope": "{{join(oauth.scope, ',')}}",
			"client_id": "{{ifempty(parameters.clientId, common.clientId)}}",
			"redirect_uri": "{{oauth.localRedirectUri}}",
			"response_type": "code"
		},
		"response": {
			"temp": {
				"code": "{{query.code}}"
			}
		}
	},

	// Step 2: OAuth2 token request
	"token": {
		"condition": "{{temp.code}}",
		"url": "https://www.example.com/api/token",
		"method": "POST",
		"body": {
			"code": "{{temp.code}}",
			"client_id": "{{ifempty(data.clientId, common.clientId)}}",
			"grant_type": "authorization_code",
			"redirect_uri": "{{oauth.localRedirectUri}}",
			"client_secret": "{{ifempty(data.clientSecret, common.clientSecret)}}"
		},
		"type": "urlencoded",
		"response": {
			"data": {
				"expires": "{{addSeconds(now, body.expires_in)}}",
				"accessToken": "{{body.access_token}}",
				"refreshToken": "{{body.refresh_token}}"
			},
			"expires": "{{addSeconds(now, body.refresh_expires_in)}}"
		},
		"log": {
			"sanitize": [
				"request.body.code",
				"request.body.client_secret",
				"response.body.access_token",
				"response.body.refresh_token"
			]
		}
	},

	// Step 3: Refresh token
	"refresh": {
		"condition": "{{data.expires < addMinutes(now, 1)}}",
		"url": "https://www.example.com/api/token",
		"method": "POST",
		"body": {
			"client_id": "{{ifempty(parameters.clientId, common.clientId)}}",
			"grant_type": "refresh_token",
			"client_secret": "{{ifempty(parameters.clientSecret, common.clientSecret)}}",
			"refresh_token": "{{data.refreshToken}}"
		},
		"type": "urlencoded",
		"response": {
			"data": {
				"expires": "{{addSeconds(now, body.expires_in)}}",
				"accessToken": "{{body.access_token}}",
				"refreshToken": "{{body.refresh_token}}"
			},
			"expires": "{{addSeconds(now, body.refresh_expires_in)}}"
		},
		"log": {
			"sanitize": [
				"request.body.client_secret",
				"request.body.refresh_token",
				"response.body.access_token",
				"response.body.refresh_token"
			]
		}
	},

	// Request to get authorized user information
	"info": {
		"url": "https://www.example.com/api/whoami",
		"headers": {
			"Authorization": "Bearer {{connection.accessToken}}"
		},
		"response": {
			"uid": "{{body.id}}",
			"metadata": {
				"type": "text",
				"value": "{{body.user}}"
			}
		},
		"log": {
			"sanitize": [
				"request.headers.authorization"
			]
		}
	},

	// Access token invalidation
	"invalidate": {
		"url": "https://www.example.com/oauth/invalidate",
		"headers": {
			"authorization": "Bearer {{connection.accessToken}}"
		},
		"log": {
			"sanitize": [
				"request.headers.authorization"
			]
		}
	}
}
```

### OAuth2 — client credentials — `model-oauth-clicre`

`api.imljson`:

```json
{
	// OAuth2 access token request
	"token": {
		"condition": "{{if(data.accessToken, data.expires < addMinutes(now, 1), true)}}",
		"url": "https://www.example.com/api/token",
		"method": "POST",
		"body": {
			"client_id": "{{parameters.clientId}}",
			"grant_type": "client_credentials",
			"client_secret": "{{parameters.clientSecret}}"
		},
		"type": "urlencoded",
		"response": {
			"data": {
				"expires": "{{addSeconds(now, body.expires_in)}}",
				"accessToken": "{{body.access_token}}"
			}
		},
		"log": {
			"sanitize": [
				"request.body.client_secret",
				"response.body.access_token"
			]
		}
	},

	// Request to get authorized user information
	"info": {
		"url": "https://www.example.com/api/whoami",
		"headers": {
			"authorization": "Bearer {{connection.accessToken}}"
		},
		"response": {
			"uid": "{{body.id}}",
			"metadata": {
				"type": "text",
				"value": "{{body.user}}"
			}
		},
		"log": {
			"sanitize": [
				"request.headers.authorization"
			]
		}
	},

	// Access token invalidation
	"invalidate": {
		"url": "https://www.example.com/oauth/invalidate",
		"headers": {
			"authorization": "Bearer {{connection.accessToken}}"
		},
		"log": {
			"sanitize": [
				"request.headers.authorization"
			]
		}
	}
}
```

### OAuth2 — resource owner password — `model-oauth-resowncre`

`api.imljson`:

```json
{
	// OAuth2 access token request
	"token": {
		"condition": "{{if(data.accessToken, data.expires < addMinutes(now, 1), true)}}",
		"url": "https://www.example.com/api/token",
		"method": "POST",
		"body": {
			"password": "{{parameters.password}}",
			"username": "{{parameters.username}}",
			"client_id": "{{ifempty(parameters.clientId, common.clientId)}}",
			"grant_type": "password",
			"client_secret": "{{ifempty(parameters.clientSecret, common.clientSecret)}}"
		},
		"type": "urlencoded",
		"response": {
			"data": {
				"expires": "{{addSeconds(now, body.expires_in)}}",
				"accessToken": "{{body.access_token}}"
			}
		},
		"log": {
			"sanitize": [
				"request.body.password",
				"request.body.client_secret",
				"response.body.access_token"
			]
		}
	},

	"info": {
		"url": "https://www.example.com/api/whoami",
		"headers": {
			"authorization": "Bearer {{connection.accessToken}}"
		},
		"response": {
			"uid": "{{body.id}}",
			"metadata": {
				"type": "text",
				"value": "{{body.user}}"
			}
		},
		"log": {
			"sanitize": [
				"request.headers.authorization"
			]
		}
	},

	"invalidate": {
		"url": "https://www.example.com/oauth/invalidate",
		"headers": {
			"authorization": "Bearer {{connection.accessToken}}"
		},
		"log": {
			"sanitize": [
				"request.headers.authorization"
			]
		}
	}
}
```

### OAuth1 — `model-oauth-1`

`api.imljson`:

```json
{
	"oauth": {
		"consumer_key": "{{ifempty(parameters.consumerKey, common.consumerKey)}}",
		"consumer_secret": "{{ifempty(parameters.consumerSecret, common.consumerSecret)}}"
	},

	// Step 1: OAuth1 Get request token
	"requestToken": {
		"url": "http://www.example.com/oauth/request_token",
		"method": "POST",
		"response": {
			"temp": {
				"token": "{{body.oauth_token}}",
				"token_secret": "{{body.oauth_token_secret}}"
			},
			"type": "urlencoded"
		},
		"log": {
			"sanitize": [
				"response.body.oauth_token",
				"response.body.oauth_token_secret"
			]
		}
	},

	// Step 2: OAuth1 Get verifier
	"authorize": {
		"url": "http://www.example.com/oauth/authenticate",
		"oauth": {
			"token": "{{temp.token}}"
		},
		"response": {
			"temp": {
				"token": "{{query.oauth_token}}",
				"verifier": "{{query.oauth_verifier}}"
			},
			"type": "urlencoded"
		}
	},

	// Step 3: OAuth1 Get access token
	"accessToken": {
		"url": "http://www.example.com/oauth/access_token",
		"method": "POST",
		"type": "urlencoded",
		"oauth": {
			"token": "{{temp.token}}",
			"verifier": "{{temp.verifier}}",
			"token_secret": "{{temp.token_secret}}"
		},
		"response": {
			"data": {
				"token": "{{body.oauth_token}}",
				"token_secret": "{{body.oauth_token_secret}}"
			},
			"type": "urlencoded"
		},
		"log": {
			"sanitize": [
				"response.body.oauth_token",
				"response.body.oauth_token_secret"
			]
		}
	},

	// Request to get authorized user information
	"info": {
		"url": "http://www.example.com/api/whoami",
		"oauth": {
			"token": "{{connection.token}}",
			"token_secret": "{{connection.token_secret}}"
		},
		"response": {
			"uid": "{{body.id}}",
			"metadata": {
				"type": "text",
				"value": "{{body.user}}"
			}
		}
	}
}
```

---

## Endpoint scaffold — `endpoints/Endpoint`

New SDK Endpoints created with `endpointInitMode: 'example'` (the default — `POST /sdk/apps/{slug}/{ver}/endpoints`) clone these sections from the `model` app. Captured 2026-07-24 (`download-app.js model 1`). Entity docs: [endpoints-reference.md](endpoints-reference.md).

`api.imljson`:

```json
{
	// Request to API endpoint with parameter "id" defined in Input Parameters.
	"url": "/users/{{parameters.id}}/action",     // Relative to base URL
	"method": "POST",
	"headers": {},                                // Additional HTTP headers
	"qs": {},                                     // Query string
	"body": "{{omit(parameters, 'id')}}",         // Request body omitting the ID that is already being sent in URL.

	// Response handling
	"response": {
		"output": "{{body}}"                      // Return JSON response body to the Output.
	}
}
```

`input_parameters.imljson`:

```json
// Defines "id", "email" and "name" as Input Parameters.
[
	{
		"name": "id",        // Makes value accessible via "{{parameters.id}}".
		"type": "uinteger",  // Sends the value as unsigned integer.
		"label": "User ID",  // Sets the user friendly label visible in the interface.
		"required": true     // Sets the parameter as mandatory.
	},
	{
		"name": "email",
		"type": "email",
		"label": "Email address"
	},
	{
		"name": "name",
		"type": "text",
		"label": "Name"
	}
]
```

`output_parameters.imljson`:

```json
// Defines JSON object with "id" parameter as expected API response body.
[
    {
        "name": "id",
        "type": "uinteger",
        "label": "User ID"
    }
]
```

`scope.imljson` → `[]`; `context.md` → the boilerplate `# Context for the Endpoint` markdown ("Here you can provide additional context for the Endpoint...").

Recognition markers: `"url": "/users/{{parameters.id}}/action"`, `"body": "{{omit(parameters, 'id')}}"`, the `id`/`email`/`name` input trio, single-`id` output, and the boilerplate context heading. An `old_value` matching these = untouched scaffold = new endpoint (skip the `old_value` diff; Breaking Changes are always skipped for endpoints anyway — see `code-review-criteria.md`).

---

## Other scaffolded files

The non-`api` files of a freshly created module also come scaffolded — typically empty arrays/objects — and count as scaffold too:

- `parameters.imljson` → `[]`
- `expect.imljson` → `[]`
- `interface.imljson` → `[]`
- `samples.imljson` → `{}`
- `scope.imljson` → `[]`

The **`api.imljson` is the primary discriminator**: if a module's `api.imljson` `old_value` is one of the module scaffolds above and the rest are empty defaults, the module is new. Refresh all defaults with `download-app.js model 1` if the SDK template changes.
