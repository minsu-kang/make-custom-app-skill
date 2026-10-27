# Apps UX Best Practices

> Read when: writing or reviewing any label, hint, field structure, error message, ordering, or naming in `expect` / `parameters` / `interface`. Mandatory before UX changes (hard rule 3). Naming, writing rules and field types are below; the other topics are separate parts under `app-ux-best-practices/` (§ Parts; the Table of Contents also links to them).

Source: [Apps UX best practices (Confluence)](https://make.atlassian.net/wiki/spaces/IEN/pages/886734999/Apps+UX+best+practices)

Figma Design: [Apps UX Council](https://www.figma.com/file/W6gA16FZ6f3qTnkdZRLM4m/Apps-UX-Council)

---

## Parts (open every part whose trigger applies, skip the rest)

| Part | Open when |
|---|---|
| [app-ux-best-practices/fields-and-messages.md](app-ux-best-practices/fields-and-messages.md) | ID select fields, arrays of collections, date input / parsing, messages and common error messages, custom fields, nested outputs, validating empty-response API calls |
| [app-ux-best-practices/connections.md](app-ux-best-practices/connections.md) | connection metadata and UID, connection types, additional OAuth scopes |
| [app-ux-best-practices/modules-and-actions.md](app-ux-best-practices/modules-and-actions.md) | batch / bulk actions, search filtering, order of groups and modules, timeouts, page size, polling triggers |

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
3. [Messages](app-ux-best-practices/fields-and-messages.md#messages)
4. [ID Finder](app-ux-best-practices/fields-and-messages.md#id-finder)
5. [Labeling for Array of Collections](app-ux-best-practices/fields-and-messages.md#labeling-for-array-of-collections)
6. [Parsing Datetime](app-ux-best-practices/fields-and-messages.md#parsing-datetime)
7. [Connection Metadata and UID](app-ux-best-practices/connections.md#connection-metadata-and-uid)
8. [Common Error Messages](app-ux-best-practices/fields-and-messages.md#common-error-messages)
9. [Batch Actions](app-ux-best-practices/modules-and-actions.md#batch-actions)
10. [Custom Fields](app-ux-best-practices/fields-and-messages.md#custom-fields)
11. [Search Filtering](app-ux-best-practices/modules-and-actions.md#search-filtering)
12. [Connection Types](app-ux-best-practices/connections.md#connection-types)
13. [Additional OAuth Scopes](app-ux-best-practices/connections.md#additional-oauth-scopes)
14. [Date Input](app-ux-best-practices/fields-and-messages.md#date-input)
15. [Validating Incorrect API Calls with Empty Response](app-ux-best-practices/fields-and-messages.md#validating-incorrect-api-calls-with-empty-response)
16. [Order of Groups and Modules](app-ux-best-practices/modules-and-actions.md#order-of-groups-and-modules)
17. [Flattening Nested Outputs](app-ux-best-practices/fields-and-messages.md#flattening-nested-outputs)
18. [Bulk Actions](app-ux-best-practices/modules-and-actions.md#bulk-actions)
19. [Timeout Handling](app-ux-best-practices/modules-and-actions.md#timeout-handling)
20. [Page Size in Pagination](app-ux-best-practices/modules-and-actions.md#page-size-in-pagination)
21. [Polling Trigger](app-ux-best-practices/modules-and-actions.md#polling-trigger)

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

### ID Select Fields: `mode: "edit"` and Nested RPC Usage by Module Type

ID select fields (`"type": "select"` with an RPC) use `"mode": "edit"` to allow both dropdown selection and manual text mapping. However, the need for **nested RPCs** (e.g., parent → child dropdown cascading) depends on the **module type**:

| Module Type | Typical User Behavior | Nested RPC Needed? |
|---|---|---|
| **Create** | User configures from scratch → selects from dropdown | Yes — nested RPCs improve UX |
| **List / Search** | User sets filters → may select or map | Optional — depends on use case |
| **Get / Update / Delete** | User **maps** ID from a previous module's output | No — users rarely use the dropdown; `mode: "edit"` with a flat `rpc://` is sufficient |

**Why Get/Update/Delete don't need nested RPCs:**
- These modules are typically placed **after** a List/Search or another module in the scenario
- Users map the ID value from the previous module's output (e.g., `{{1.id}}`) rather than selecting from a dropdown
- Adding nested RPCs (parent → child cascading) adds complexity without UX benefit, since the dropdown is rarely used
- A simple `"type": "select"` with `"options": "rpc://getItems"` and `"mode": "edit"` is the correct pattern

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
