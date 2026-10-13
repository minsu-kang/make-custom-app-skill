# Apps UX best practices: Modules and actions

> Read when: working on batch or bulk actions, search filtering, group and module order, timeouts, page size or polling triggers. Part of [app-ux-best-practices.md](../app-ux-best-practices.md).

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

## Search Filtering

Source: [Confluence](https://make.atlassian.net/wiki/spaces/IEN/pages/955285660/Search+filtering)

| Do | Don't |
|---|---|
| Provide a list of fields | Ask user to construct query string |
| Provide a list of operators | |
| Group operators by data types | Share operators among all data types |

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
2. At least one of these is true:
   - API supports sorting by the identifier in **descending order**
   - API supports **date/ID filtering** (e.g., `createdAt[$gte]`, `since`, `after`, `$filter`)
   - API returns results in a consistent ascending order by default

For detailed implementation guidance (order selection, date filtering, epoch configuration, code examples), see **[Polling Trigger Implementation Guide](../polling-trigger-guide.md)**.
