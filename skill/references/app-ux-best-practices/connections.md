# Apps UX best practices: Connections

> Read when: working on connection metadata and UID, connection types or additional OAuth scopes. Part of [app-ux-best-practices.md](../app-ux-best-practices.md).

## Connection Metadata and UID

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/924352648/Connection+metadata+and+UID)

### Metadata

Always save metadata in the connection if:
1. An endpoint for authenticated user info is available
2. The information can distinguish the connection

Suggested information: Name, Email, User ID, Org/Company/Location/Tenant

Example:
```json
{
    "info": {
        "url": "https://api.example.com/v3/account/summary",
        "method": "GET",
        "headers": {
            "authorization": "Bearer {{connection.accessToken}}"
        },
        "response": {
            "uid": "{{body.encoded_account_id}}",
            "metadata": {
                "type": "text",
                "value": "{{body.contact_email}}"
            }
        },
        "log": {
            "sanitize": ["request.headers.authorization"]
        }
    }
}
```

### UID

Always save UID if the service supports a single webhook URL per app (shared webhook). The UID must match the ID in incoming webhook payloads.

---

## Connection Types

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/999588028/Connection+types)

If there are multiple types of connection, use **parentheses** for the connection type specification:

| Do | Don't |
|---|---|
| App Name (OAuth 2.0) | App Name - OAuth 2.0 connection |
| App Name (API Key) | App Name API Key |

---

## Additional OAuth Scopes

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1001029949/Additional+OAuth+scopes)

Make an API Call may not work if required scopes aren't in the OAuth connection. Accept user-defined additional scopes at connection creation.

### Make an API Call Banner

If connection is NOT editable:
```json
{
    "type": "banner",
    "text": "Your connection must contain the required scopes for your API call. If you receive an error, create a new connection with the necessary Additional scopes.",
    "theme": "info"
}
```

If connection IS editable:
```json
{
    "type": "banner",
    "text": "Your connection must contain the required scopes for your API call. If you receive an error, edit your connection with the necessary Additional scopes.",
    "theme": "info"
}
```

### Connection Parameters

```json
[
    {
        "name": "additionalScopes",
        "label": "Additional Scopes",
        "type": "array",
        "spec": {
            "type": "text",
            "label": "Scope"
        },
        "help": "Additional scopes are required for the __Make an API Call__ module. For details, see the [App Name API Documentation](https://link-to-doc). Add scopes for every API call you will make with this connection.",
        "labels": {
            "add": "Add scope"
        },
        "editable": true
    }
]
```

### Scope Merging in Communication

```
"scope": "{{join(distinct(merge(oauth.scope, ifempty(parameters.additionalScopes, emptyarray))), ',')}}"
```

---
