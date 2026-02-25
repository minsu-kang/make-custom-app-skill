# Communication (API) Detailed Reference

Official docs: https://developers.make.com/custom-apps-documentation/component-blocks/api

## Full Spec

```json
{
    "url": "String (relative to baseUrl or absolute)",
    "encodeUrl": "Boolean (default: true)",
    "method": "GET | POST | PUT | DELETE | PATCH | OPTIONS",
    "qs": "Flat Object (query string parameters)",
    "headers": "Flat Object (HTTP headers)",
    "body": "Object | String | Array (request body)",
    "type": "json | urlencoded | multipart/form-data | binary | text | raw",
    "ca": "String (custom CA certificate)",
    "condition": "IML Boolean (skip request if false)",
    "gzip": "Boolean",
    "temp": "Object (temporary variables for chaining requests)",
    "followRedirects": "Boolean",
    "followAllRedirects": "Boolean",
    "aws": {
        "key": "String",
        "secret": "String",
        "session": "String",
        "bucket": "String",
        "sign_version": "2 | 4"
    },
    "response": {
        "type": {
            "*": "json | urlencoded | xml | text | raw | binary | automatic",
            "200-299": "json"
        },
        "valid": "IML Boolean (marks response as invalid if false)",
        "limit": "IML Number (max items for search/trigger)",
        "temp": "Object (store values for next request)",
        "iterate": {
            "container": "IML Array (items to iterate)",
            "condition": "IML Boolean (filter items)"
        },
        "output": "IML Object | String (module output)",
        "wrapper": "IML Object (wraps iterated items)",
        "trigger": {
            "id": "IML String (required)",
            "date": "IML String (required if type=date)",
            "type": "id | date",
            "order": "asc | desc | unordered"
        },
        "data": "Object (data to save in connection)",
        "metadata": "Object (connection display metadata)",
        "error": {
            "message": "IML String",
            "type": "RuntimeError | DataError | RateLimitError | OutOfSpaceError | ConnectionError | InvalidConfigurationError | InvalidAccessTokenError | IncompleteDataError | DuplicateDataError",
            "STATUS_CODE": {
                "message": "String",
                "type": "ErrorType"
            }
        }
    },
    "pagination": {
        "mergeWithParent": "Boolean",
        "url": "String",
        "method": "String",
        "headers": "Flat Object",
        "qs": "Flat Object",
        "body": "Object",
        "condition": "IML Boolean (continue if true)"
    },
    "log": {
        "sanitize": ["Array of paths to sanitize from logs"]
    },
    "repeat": {
        "condition": "IML Boolean (retry if true)",
        "delay": "Number (ms between retries)",
        "limit": "Number (max retries)"
    }
}
```

## Pagination Patterns

### Cursor-based

```json
{
    "url": "/items",
    "qs": { "limit": "{{min(100, parameters.limit)}}" },
    "response": {
        "limit": "{{parameters.limit}}",
        "output": "{{item}}",
        "iterate": "{{body.data}}"
    },
    "pagination": {
        "condition": "{{body.has_more}}",
        "qs": { "cursor": "{{body.next_cursor}}" }
    }
}
```

### Offset-based

```json
{
    "url": "/items",
    "qs": {
        "limit": 100,
        "offset": 0
    },
    "response": {
        "limit": "{{parameters.limit}}",
        "output": "{{item}}",
        "iterate": "{{body.items}}"
    },
    "pagination": {
        "condition": "{{length(body.items) >= 100}}",
        "qs": { "offset": "{{add(temp.offset, 100)}}" }
    }
}
```

### Page-based

```json
{
    "url": "/items",
    "qs": { "page": 1, "per_page": 100 },
    "response": {
        "limit": "{{parameters.limit}}",
        "output": "{{item}}",
        "iterate": "{{body.data}}"
    },
    "pagination": {
        "condition": "{{body.current_page < body.total_pages}}",
        "qs": { "page": "{{add(body.current_page, 1)}}" }
    }
}
```

### Trigger Pagination (using iterate.container.last)

```json
{
    "url": "/items",
    "qs": { "sort": "-created_at" },
    "response": {
        "limit": "{{parameters.limit}}",
        "output": "{{item}}",
        "iterate": "{{body.data}}",
        "trigger": {
            "id": "{{item.id}}",
            "date": "{{item.created_at}}",
            "type": "date",
            "order": "desc"
        }
    },
    "pagination": {
        "condition": "{{body.has_more}}",
        "qs": { "after": "{{iterate.container.last.id}}" }
    }
}
```

## iterate Details

Simple form:
```json
"iterate": "{{body.items}}"
```

Conditional filtering:
```json
"iterate": {
    "container": "{{body.items}}",
    "condition": "{{item.status == 'active'}}"
}
```

## output Details

Return full body:
```json
"output": "{{body}}"
```

Map specific fields only:
```json
"output": {
    "id": "{{item.id}}",
    "name": "{{item.name}}",
    "email": "{{item.email}}"
}
```

## temp Usage

Pass data between requests (multiple requests):
```json
[
    {
        "url": "/auth/token",
        "method": "POST",
        "body": { "grant_type": "client_credentials" },
        "response": {
            "temp": { "accessToken": "{{body.access_token}}" }
        }
    },
    {
        "url": "/api/data",
        "headers": { "Authorization": "Bearer {{temp.accessToken}}" },
        "response": { "output": "{{body}}" }
    }
]
```

## Connection Type Patterns

### OAuth 2.0
Official docs: https://developers.make.com/custom-apps-documentation/app-components/connections/oauth2

### Basic Auth
```json
// base.imljson
{
    "baseUrl": "https://api.example.com",
    "headers": {
        "Authorization": "Basic {{base64(connection.username + ':' + connection.password)}}"
    }
}
```

### API Key (Header)
```json
// base.imljson
{
    "baseUrl": "https://api.example.com",
    "headers": {
        "X-API-Key": "{{connection.apiKey}}"
    }
}
```

### API Key (Query String)
```json
// base.imljson
{
    "baseUrl": "https://api.example.com",
    "qs": {
        "api_key": "{{connection.apiKey}}"
    }
}
```

## RPC Patterns

### Dynamic Options (Dropdown)
```json
// RPC api.imljson
{
    "url": "/projects",
    "response": {
        "output": "{{item}}",
        "iterate": {
            "container": "{{body.projects}}"
        }
    }
}

// Usage in Module expect.imljson
{
    "name": "projectId",
    "type": "select",
    "label": "Project",
    "options": {
        "store": "rpc://listProjects",
        "label": "{{item.name}}",
        "value": "{{item.id}}"
    }
}
```

### Dynamic Fields
```json
// RPC api.imljson
{
    "url": "/custom-fields/{{parameters.objectType}}",
    "response": {
        "output": "{{item}}",
        "iterate": "{{body.fields}}"
    }
}

// Usage in Module expect.imljson
"rpc://listCustomFields"
```

### Request-less RPC (No API Call)
```json
{
    "response": {
        "output": [
            { "label": "Option A", "value": "a" },
            { "label": "Option B", "value": "b" }
        ]
    }
}
```

## File Upload/Download

### Upload (multipart)
```json
{
    "url": "/files",
    "method": "POST",
    "type": "multipart/form-data",
    "body": {
        "file": "{{parameters.data}}",
        "filename": "{{parameters.fileName}}"
    },
    "response": { "output": "{{body}}" }
}
```

### Download (binary)
```json
{
    "url": "/files/{{parameters.fileId}}",
    "response": {
        "type": { "*": "binary" },
        "output": {
            "data": "{{body}}",
            "fileName": "{{headers.content-disposition}}"
        }
    }
}
```
