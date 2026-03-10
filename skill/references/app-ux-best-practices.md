# Apps UX Best Practices

Source: [Apps UX best practices (Confluence)](https://make.atlassian.net/wiki/spaces/IEN/pages/886734999/Apps+UX+best+practices)

Figma Design: [Apps UX Council](https://www.figma.com/file/W6gA16FZ6f3qTnkdZRLM4m/Apps-UX-Council)

---

## Table of Contents

1. [Writing and Naming](#writing-and-naming)
   - [Naming: Apps](#naming-apps)
   - [Naming: Modules](#naming-modules)
   - [Naming: Input Fields](#naming-input-fields)
   - [Naming: ID Field with Map Toggle](#naming-id-field-with-map-toggle)
   - [Writing: Hints](#writing-hints)
   - [Writing: Module Descriptions](#writing-module-descriptions)
   - [Writing: Model (AI Apps)](#writing-model-ai-apps)
   - [Templates: Universal Hints](#templates-universal-hints)
2. [Types of Fields](#types-of-fields)
3. [Messages](#messages)
4. [ID Finder](#id-finder)
5. [Labeling for Array of Collections](#labeling-for-array-of-collections)
6. [Parsing Datetime](#parsing-datetime)
7. [Connection Metadata and UID](#connection-metadata-and-uid)
8. [Common Error Messages](#common-error-messages)
9. [Batch Actions](#batch-actions)
10. [Custom Fields](#custom-fields)
11. [Search Filtering](#search-filtering)
12. [Connection Types](#connection-types)
13. [Additional OAuth Scopes](#additional-oauth-scopes)
14. [Date Input](#date-input)
15. [Validating Incorrect API Calls with Empty Response](#validating-incorrect-api-calls-with-empty-response)
16. [Order of Groups and Modules](#order-of-groups-and-modules)
17. [Flattening Nested Outputs](#flattening-nested-outputs)
18. [Bulk Actions](#bulk-actions)
19. [Timeout Handling](#timeout-handling)
20. [Page Size in Pagination](#page-size-in-pagination)
21. [Polling Trigger](#polling-trigger)

---

## Writing and Naming

General writing practices for IEN apps. If information conflicts with the general Make product writing guidelines, the IEN guidelines below take precedent.

### Naming: Apps

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1522368529/Naming+Apps)

- Always follow brand guidelines
- When uncertain, use **Title Case**
- Suffixes use Title Case: `Google Ads Reports` (not `Google Ads reports`)
- Prepositions lowercase in title case: `Instagram for Business` (not `Instagram For Business`)
- Rebrand format: `X (formerly Twitter)` — "formerly" is lowercase

### Naming: Modules

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/895975426/Naming+Modules)

Each module name: **Verb + Item**

Rules:
- Start with the verb
- **Watch/Search modules**: plural item (`Watch contacts`, `Search users`)
- **Action modules**: singular item with a/an (`Create a message`, `Update a record`)
- **List modules**: 0 filtering options (`List users`)
- **Search modules**: 1+ filtering options (`Search users`)
- Sentence-style capitalization
- American English by default; adopt 3rd party's British spelling for product terms if applicable
- Use `Create or update` instead of `Upsert`

#### Watch Modules

| Format | Do | Don't |
|---|---|---|
| Watch [item]s | Watch contacts | Watch a contact |
| Watch new [item]s | Watch new contacts | Watch contacts created |
| Watch updated [item]s | Watch updated contacts | Watch contacts updated |
| Watch deleted [item]s | Watch deleted contacts | Watch contacts deleted |

#### Action Modules

| Format | Do | Don't |
|---|---|---|
| Create a/an [item] | Create a message | |
| Create or update a/an [item] | Create or update a record | Upsert a record |
| Get a/an [item] | Get a message | |
| Update a/an [item] | Update a message | |
| Delete a/an [item] | Delete a message | |
| Download a/an [item] | Download an image | |
| Upload a/an [item] | Upload a product image | |
| Send a/an [item] | Send a message | |
| Add a/an [item] | Add a reaction | |
| Remove a/an [item] | Remove a user from a list | |
| Generate a/an [item] | Generate an image | |
| Invite a/an [item] | Invite a user | |

#### Search Modules

| Format | Do | Don't |
|---|---|---|
| List [item]s (0 filters) | List users | |
| Search [item]s (1+ filters) | Search users | |

#### Bulk Modules

- Format: `Bulk [action] [items] (advanced)`
- Description: `[Actions] multiple [items].`

#### Additional Information Tags

| Tag | Format | Do | Don't |
|---|---|---|---|
| Advanced | Module name (advanced) | Search rows (advanced) | Search rows (Advanced module) |
| Beta | Module name (beta) | List folder items (beta) | List folder items (BETA) |
| Both | Module name (advanced) (beta) | Update a campaign (advanced) (beta) | Update a campaign (advanced, beta) |
| Deprecated | Module name (deprecated) | Send a message (deprecated) | Send a message (Deprecated) |
| Not Used | (NOT USED) Module name | (NOT USED) Download an attachment | Download an attachment [NOT USED] |
| Rebrand | Module name (formerly [name]) | X (formerly Twitter) | X (Formerly Twitter) |

### Naming: Input Fields

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1416331298/Naming+Input+fields)

Rules:
- Short description (1–3 words)
- Match 3rd party UI terminology (not API documentation)
- Be descriptive, not instructional
- Sentence-style capitalization
  - **Exception**: If an app's existing labels are consistently Title Case, follow Title Case for that app to maintain consistency. Always check the app's existing labels before deciding.
- No punctuation or articles ("the", "an", "a")

#### Capitalization Rules

- Proper nouns/trademarks remain capitalized: `New Instagram account name`
- Acronyms stay uppercase: `Content ID`, `File URL`, `Product API key`
- Official terms retain standard capitalization

| Do | Don't | Note |
|---|---|---|
| Custom data parameters | The Custom Data Parameters | No article, lowercase after first word |
| Submit form | Submit Form | Lowercase after first word |
| Google Drive folder | Google drive folder | Proper noun capitalized |
| Content ID | Content id | Acronym uppercase |
| Product API key | Product API Key | "key" is not an acronym |
| ID finder | ID Finder | "finder" is lowercase |

### Naming: ID Field with Map Toggle

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1172766721/Naming+ID+field+with+Map+toggle)

- **Map toggle ON by default** → label should contain "ID": `Board ID`
- **Map toggle OFF by default** → label should NOT contain "ID": `Board`

### Writing: Hints

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/826016021/Writing+Hints)

#### Objectives

- All non-self-explanatory fields must have a hint
- Extra attention to Connection field hints
- Clear, concise, non-technical language
- Avoid symbols like ⨀

#### Information Types (in order)

1. **Expected input**: What should the user enter? Use API documentation description, simplified for users.
2. **Result**: What happens when a specific value is entered? Only if the outcome is not obvious.
3. **Example**: Use "For example, `value`" format. Never use "e.g.", "i.e.", "for instance".
4. **Additional information**: Important extras (supported formats, things to include/leave out).
5. **What if left empty**: Describe impact of empty input. Critical for update modules that may delete values.
6. **Link**: Always use specific link text (never "Click here" or "More information").

#### Link Formatting

- Help Center: Always "our Help Center". Example: `See our Help Center.`
- 3rd party: Include app name and page name. Example: `See the OpenAI Voice options guide.`
- All links must open in new window: `<a href="..." target="_blank">text</a>`

#### Special Formatting

- **Bold**: When referencing another input field in the module, copy its name exactly and bold it
- **Code**: For examples, default values, versions, specific formats (API versions, color codes, dates, country codes)

### Writing: Module Descriptions

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1700462605/Writing+Module+descriptions)

#### Information Types

1. **End result** (mandatory): Clearly describe what the module achieves
2. **Requirements** (when necessary): Specific plan, settings required
3. **Additional information** (when necessary): Useful specifics for the user

#### Templates

**Trigger modules:**

| Template | Module Name | Description |
|---|---|---|
| Watch new [items] | Watch new contacts | Triggers when a new contact is created. |
| Watch updated [items] | Watch updated contacts | Triggers when a contact is updated. |
| Watch deleted [items] | Watch deleted contacts | Triggers when a contact is deleted. |
| Watch [items] | Watch contacts | Triggers when a contact is created or updated. |
| Watch [items] (events) | Watch records | Triggers when an event occurs related to a record. |
| Watch events | Watch events | Triggers when a new event occurs in Monday. |

**Action modules:**

| Template | Module Name | Description |
|---|---|---|
| Add a/an [item] | Add a row | Adds a new row to the bottom of a table. |
| Create a/an [item] | Create a supplier invoice | Creates a new supplier invoice. |
| Create or update | Create or update a contact | Creates a new contact or updates an existing one if a matching contact name or email is found. |
| Delete a/an [item] | Delete a message | Deletes a message from a thread. This action cannot be undone. |
| Download a/an [item] | Download a document | Downloads a document in PDF format. |
| Get a/an [item] | Get a user | Returns information about a specific user by their user ID. |
| Update a/an [item] | Update a message | Updates a message. |
| Bulk [verb] [items] | Bulk add rows | Adds multiple rows to the bottom of a table. |

**Search modules:**

| Template | Module Name | Description |
|---|---|---|
| List [items] | List users | Returns a list of users in a specific organization. |
| Search [items] | Search users | Returns a list of users filtered by [?]. |

**Universal modules:**

| Template | Module Name | Description |
|---|---|---|
| Make an API call | Make an API call | Sends a custom API call to {app name}. You can use this to call endpoints that aren't covered by existing modules. |

### Writing: Model (AI Apps)

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/2426798118/Writing+Model+AI+apps)

#### Model Selection Strategy

- Do NOT automatically include every technically available model
- Prefer stable versions over preview versions (GPT-5 over gpt-5-2025-08-07)

#### Model Names

Use readable labels matching the UI:

| Do | Don't |
|---|---|
| GPT-5 Instant | gpt-5-instant |
| Gemini 2.0 Flash | gemini-2.0-flash |

#### Model Descriptions

- Short, accurate descriptions from the AI provider's website
- Example: "Exceptional model for specialized reasoning tasks"

#### Model Grouping

- Group under parent model family (GPT-5, GPT-4.1, o3, etc.)
- Parent families: newest on top, oldest on bottom
- Within groups: newest on top, oldest on bottom

#### Model Field Hint

Include a link to the official model list:

| Do | Don't |
|---|---|
| For a full list of models and their capabilities, see the [OpenAI Models page](https://platform.openai.com/docs/models). | The model that will complete your prompt. |

### Templates: Universal Hints

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/913997919/Templates+Universal+Hints)

#### Connection Hints

**API key / API token / Access token:**

| Where | Template | Example |
|---|---|---|
| Our Help Center | For details on how to obtain your [value], see our Help Center. | For details on how to obtain your API key, see our [Help Center](...). |
| 3rd party API docs | For details on how to obtain your [value], see the [app name] API documentation. | For details on how to obtain your API key, see the [Instantly API documentation](...). |
| 3rd party other | For details on how to obtain your [value], see the [app name] [page name]. | ... |
| 3rd party account (with link) | You can obtain your [value] on the [page name] in your [app name] account. | You can obtain your API key on the [Anthropic Console API keys page](...). |

**Required client ID/secret:**

| Where | Template |
|---|---|
| Our Help Center | For details on how to obtain your [client ID/secret], see our Help Center. |

#### Limit Field

| Location | Hint |
|---|---|
| Polling trigger | Maximum number of results to return. For information about setting limits, see our [Help Center](https://www.make.com/en/help/modules/types-of-modules#module-limits). |
| Search/List modules | Maximum number of results to return and work with during one execution cycle. For information about setting limits, see our [Help Center](https://www.make.com/en/help/modules/types-of-modules#module-limits). |

Note: The **Limit** field should be the last standard field in the module (not in advanced settings).

#### Make an API Call: URL Field

- Include the correct "prefix" path and an example "postfix" path
- Use `GET` method endpoints as examples (not create/delete)
- Do NOT hardcode API versions in the prefix path

| Template | Example |
|---|---|
| Enter the part of the URL that comes after `{prefix}`. For example, `{postfix}`. | Enter the part of the URL that comes after `https://api.openai.com`. For example, `/v1/models`. |

---

## Types of Fields

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/900826760/Types+of+fields)

### Standard vs Advanced Fields

**Standard fields:**
- Visible by default
- Frequently used
- Typically easy to understand
- Visible on the 3rd party's Web UI by default
- `Limit` should be the last variable

**Advanced fields:**
- Hidden by the "Advanced settings" toggle
- Not needed by the majority of users
- Generally more difficult to understand
- May require technical knowledge (clear hint or link to documentation is necessary)
- Includes Custom Fields if supported
- Hidden on the 3rd party's Web UI
- Placed at the bottom of all fields
- `Limit` should be the last variable

### Required vs Optional Fields

**Required fields:**
- Minimal effort to make the module work
- Validate that user filled in all necessary fields
- Guards against API errors from missing fields
- Ideally contain a default value
- If advanced, MUST contain a default value

**Conditionally required fields:**
- Required based on condition (e.g., either field A or B required; required only on create in Upsert)
- Clear hint is MANDATORY to explain the condition
- Place after Required, before Optional fields

**Optional fields:**
- Not necessary for the API to work
- Enrich UX by providing flexibility

### Nested Parameters

Never use `advanced` directive in nested parameters.

---

## Messages

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/900892383/Messages)

Three message types using the `banner` element. Recommended length: **50 to 300 characters**.

### Information (blue)

```json
{
    "type": "banner",
    "title": "This is an info",
    "text": "Here is a description of info.",
    "theme": "info"
}
```

### Warning (yellow)

```json
{
    "type": "banner",
    "title": "This is a warning",
    "text": "Here is a description of warning.",
    "theme": "warning"
}
```

### Danger (red)

Used for deprecated modules and critical messages.

### Important

Due to [VMB-210](https://make.atlassian.net/browse/VMB-210) there is a risk on using `html` parameters. Stop using it. Use `info` and `warning` `banner` elements instead.

### Dynamic Google Connection Messages

For @gmail.com users who must reauthorize every 6 months:
- Use yellow (warning) info box for active connections
- Switch to red when expired
- Message: "You have until {dynamic date} to reauthorize this connection. For more details, see our [online help](https://www.make.com/en/help/connections/connecting-to-services#reauthorize-connections)."

---

## ID Finder

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/903774260/ID+finder)

### Module Guidelines

- Button label: always **ID finder** (or **Finder** if the field is not searching for an ID)

#### Single Search Method

- Field name: `[Item] ID` (e.g., Campaign ID, Employee ID)

#### Multiple Search Methods

- Field name: `[Item] search method` dropdown
- Options: Search by keyword, Search by [item], Select by file path, Select from list, Enter manually, etc.

### ID Finder Search Criteria

#### Single Criterion: Keyword Search

- Field name: `[Search Item] keywords` (e.g., Channel name keywords)
- Include blue info box: "If you don't see the result you're looking for, try more specific search criteria."

#### Single Criterion: Exact Match

- Field name: identical to the item name (e.g., Channel name)
- Do NOT include the blue info box
- Hint: "Must be the exact **[Search item]**."

#### Multiple Criteria

- Keyword field: `[Search Item] keywords`
- Include blue info box

### ID Finder Results

Results should be listed in alphabetical order (if the API allows).

### Template

```json
{
    "name": "recordId",
    "type": "text",
    "label": "Record ID",
    "rpc": {
        "label": "ID finder",
        "url": "rpc://...",
        "parameters": [
            {
                "type": "banner",
                "text": "If you don't see the result you're looking for, try more specific search criteria.",
                "theme": "info"
            },
            {
                "name": "query",
                "type": "text",
                "label": "Query"
            }
        ]
    }
}
```

---

## Labeling for Array of Collections

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/909410318/Labeling+for+array+of+collections)

### Standard Modules

- **Array label**: plural (e.g., `Recipients`)
- **Array item label**: singular, related to array label (e.g., `Recipient`)
- **Add button label**: related to array item (e.g., `Add recipient`)

#### Array of Collections

```json
{
    "name": "recipients",
    "type": "array",
    "label": "Recipients",
    "spec": {
        "type": "collection",
        "label": "Recipient",
        "spec": [
            {
                "name": "name",
                "type": "text",
                "label": "Name",
                "required": true
            }
        ]
    },
    "labels": {
        "add": "Add recipient"
    }
}
```

#### Primitive Array

```json
{
    "name": "recipients",
    "type": "array",
    "label": "Recipients",
    "spec": {
        "type": "text",
        "label": "Recipient name"
    },
    "labels": {
        "add": "Add recipient name"
    }
}
```

### Make an API Call

Standard structure for headers, query string, and body parameters:

```json
{
    "name": "headers",
    "type": "array",
    "label": "Headers",
    "spec": {
        "type": "collection",
        "label": "Header",
        "spec": [
            { "name": "key", "type": "text", "label": "Key" },
            { "name": "value", "type": "text", "label": "Value" }
        ]
    },
    "labels": { "add": "Add header" }
}
```

---

## Parsing Datetime

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/909574164/Parsing+datetime)

Always parse datetime in module output **EXCEPT**:

1. **No date, only time** (e.g., `13:30`)
2. **No time, only date** (e.g., `2024-01-01`)
3. **Date + time but no timezone** (e.g., `2020-06-08 12:37:56`) — unless API docs confirm UTC or another timezone
4. **Timestamp in seconds/milliseconds** — unless clearly indicated as Date type by name, API docs, or metadata

Do NOT use Make user's or organization's timezone (may differ from 3rd party configuration).

**IMPORTANT**: Apply ONLY to new apps, new app versions, or new modules. DO NOT change existing datetime parsing logic — this introduces breaking changes.

---

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

## Common Error Messages

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/937721971/Common+error+messages)

Define error handler for specific HTTP error types when:
1. Error message is not user friendly
2. No error message at all
3. API docs list expected errors
4. API supports special error types (e.g., 429)

### Common HTTP Error Types

#### 4xx Client Errors

| Type | Description |
|---|---|
| 400 Bad Request | Invalid syntax in HTTP request |
| 401 Unauthorized | User not authenticated correctly |
| 403 Forbidden | User authorized but lacking permissions |
| 404 Not Found | Wrong URL or ID not found |
| 409 Conflict | Request conflicts with current state |
| 429 Too Many Requests | Rate limiting |

#### 5xx Server Errors

| Type | Description |
|---|---|
| 500 Internal Server Error | Unknown server error |
| 502 Bad Gateway | Invalid response from backend |
| 503 Service Unavailable | Server overloaded or under maintenance |

### Error Type Mapping

- **429**: `RateLimitError`
- **501/502/503**: `ConnectionError`

### Example (Monday)

```json
{
    "response": {
        "error": {
            "message": "[{{statusCode}}] {{body.error_message || stringifyData(body.errors)}}",
            "429": {
                "type": "RateLimitError",
                "message": "[{{statusCode}}] {{body.error_message || stringifyData(body.errors)}}"
            },
            "502": {
                "type": "ConnectionError",
                "message": "[{{statusCode}}] {{body.error_message || stringifyData(body.errors)}}"
            },
            "503": {
                "type": "ConnectionError",
                "message": "[{{statusCode}}] {{body.error_message || stringifyData(body.errors)}}"
            }
        }
    }
}
```

---

## Batch Actions

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/937295990/Batch+actions)

### Categories

1. **Read**: Will NOT alter records (get, search, download)
2. **Write**: WILL alter records (create, update, upload)

### Rules

- Avoid combining multiple **Write** actions in a single module (platform limitation: no partial success support)
- **Read + Read**, **Read + Write**, **Write + Read** combinations are acceptable

### Common Batch Patterns

#### Create or Update (Upsert)

- Chain: Read → Write (or single Write if API supports upsert)
- Create's required fields become "Conditionally Required"
- Empty mappings should be ignored (not sent)

#### Update by PUT

- Chain: Read → Write
- Get record → PUT with patched data (empty fields ignored, not erased)

#### Get Record After Update

- Chain: Write → Read
- Update record → Get record by ID (when API only returns ID after update)

#### Upload in Chunks (exception to Write+Write rule)

- Chain: Write → Write → Write
- Create session → Send chunks → Finalize

#### Download by Media ID

- Chain: Read → Read
- Get media ID → Download by ID

#### Async Process

- Chain: Write → Read → Read → ...
- Start task → Poll status → Get result

---

## Custom Fields

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/937755208/Custom+fields)

- Always provide **dynamic parameters** for custom fields (using metadata endpoints)
- Do NOT ask users to map arrays manually
- **Exception**: When API does not provide a metadata endpoint (e.g., Zoho Books)

---

## Search Filtering

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/955285660/Search+filtering)

| Do | Don't |
|---|---|
| Provide a list of fields | Ask user to construct query string |
| Provide a list of operators | |
| Group operators by data types | Share operators among all data types |

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

## Date Input

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1001062889/Date+input)

- Use `date` type parameter instead of asking user to input a specific date format
- **Exception**: If endpoint accepts date only or time only, use `text` type with a clear hint and example

---

## Validating Incorrect API Calls with Empty Response

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/785580229/Validating+incorrect+API+calls+with+an+empty+response)

When a Get module is based on a Search endpoint (no dedicated Get endpoint), the API may return 200 with empty response for invalid IDs.

### Solution

Add `valid` to the `response` object:

```json
{
    "url": "/items",
    "method": "GET",
    "qs": {
        "id": "{{parameters.itemId}}"
    },
    "response": {
        "valid": {
            "condition": "{{body.items[1].id}}",
            "message": "Item with the given id does not exist."
        },
        "output": "{{body.items[1]}}"
    }
}
```

### Example (Custify - Get a Tag)

```json
{
    "url": "/tag/{{parameters.id}}",
    "method": "GET",
    "response": {
        "valid": "{{length(body.tags) === 1}}",
        "error": {
            "message": "[{{statusCode}}] {{body.error.message || body.message || body.error || 'Something wrong. Please try again.'}}",
            "200": {
                "message": "Tag not found."
            },
            "503": {
                "message": "[503] Invalid tag ID."
            }
        },
        "output": "{{body.tags[]}}"
    }
}
```

---

## Order of Groups and Modules

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1033535510/Order+of+groups+and+modules)

### Grouping Logic

1. **TRIGGERS** (instant triggers first, then polling triggers)
2. **Generic modules** (e.g., RECORDS — mostly for SoR apps)
3. **Business logic modules** (sorted by importance)
   - Within groups: RCUD order (Read → Create → Update → Delete)
   - R = Search, List, Get order
4. **OTHER** (Make an API Call, Execute a GraphQL query, etc.)

### Module Order Within a Group

Example (FORMS group): List Forms → Get a Form → Create a Form → Update a Form → Delete a Form

### Grouping Rules

- If at least one group has 2+ modules → group all modules accordingly
- If no group has more than one module → use default groups: ACTIONS and OTHER

---

## Flattening Nested Outputs

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1077739541/Flattening+nested+outputs)

Deeply nested outputs give terrible UX when mapping values. Always consider:

1. Creating a mappable version of key-value pairs
2. Flattening unnecessary nested collections

Examples:
- OpenAI: Flatten response content to a single text value
- Unbounce: Flatten unnecessary nested arrays containing a single item

---

## Bulk Actions

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1085472875/Bulk+actions)

A single API call that acts on multiple records. If the API supports bulk actions, consider implementing a Bulk module.

### Limitations

Platform does NOT support partial success. If some actions failed but the module shows success → confusing. In this case, **DO NOT** implement bulk actions.

### Implementation

- Mapping should always be turned ON by default
- Output types:
  - API returns single success/fail → `Action` module
  - API returns per-record success/fail → `Search` module
- If possible, output the updated range/rows

### Naming

- Module name: `Bulk [action] [items] (advanced)`
- Description: `[Actions] multiple [items].`

Examples:
- `Bulk upload call conversions (advanced)` → `Uploads multiple Google Ads call conversions.`
- `Bulk create folders (advanced)` → `Creates multiple folders.`

---

## Timeout Handling

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1112047655/Timeout+handling)

Maximum timeout: **5 minutes (300,000 ms)**

Increase timeout for:
- Download/upload large files (video, high-res images)
- Large requests to be processed (e.g., OpenAI)
- Slow server responses (e.g., Salesforce)

---

## Page Size in Pagination

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1186398224/Page+size+in+pagination)

Page size should be **as large as possible** to:
1. Reduce number of requests
2. Minimize delay
3. Avoid hitting rate limits

### Example

ActiveCampaign (max 100): set `limit` to 100.
Productive (max 200): set `page[size]` to 200.

```json
{
    "qs": {
        "page[size]": "{{min(200, parameters.limit)}}"
    }
}
```

---

## Polling Trigger

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/1311932438/Polling+trigger)

Implement polling trigger ONLY if:
1. Results have a **numeric ID** or **date** as identifier
2. Results can be sorted or default to **descending order**

**Avoid** using `unordered` or `asc` — 3200 pagination limit means the trigger stops working when new items can't be reached.

### Exception

If the API accepts filtering to get results only after a certain ID or date (reducing total items), polling trigger can be considered.
