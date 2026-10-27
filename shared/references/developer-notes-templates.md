# Developer Notes Templates

> Read when: writing Jira Developer Notes (`customfield_10483`) after a bugfix or feature — ADF table templates.

When the user approves writing Developer Notes (lifecycle §7 step 1; never for code reviews), use the Bug Fix or Feature template matching the ticket type.

## Common Rules

- Write in English (Jira is shared across teams)
- Be specific about the technical details — include function names, variable names, and code flow
- List ALL affected/created components, not just the primary one
- In Changed Files, mark each file as **(new)** or **(modified)** to distinguish new additions from edits to existing files
- **Always write to Jira field `customfield_10483`** (Developer Notes) using `editJiraIssue` with ADF format — never post as a comment
- Use **tables** for Root Cause, Fix, Affected Components, and Changed Files sections for readability

## Bug Fix Template

```markdown
### Root Cause

| Item | Detail |
|---|---|
| Component | {Which function/component has the bug} |
| Trigger | {What condition triggers it} |
| Effect | {Why it produces the wrong result} |

### Fix

| Item | Detail |
|---|---|
| Change | {What was changed and why} |
| Logic | {How the new logic works} |

### Affected Components

| Component | Description |
|---|---|
| {module/function name} | {label/description} |
| ... | ... |

### Changed Files

| File | Change |
|---|---|
| {file path relative to app root} | **(new)** or **(modified)** |
| ... | ... |
```

## Feature Template

```markdown
### Summary

{What was implemented and why — link to the API/feature being integrated}

### Implementation

{Technical description of how the feature works:

- Architecture decisions and rationale
- Key patterns used (e.g., GraphQL query construction, RPC reuse)
- API requirements (version, auth, endpoints)}

### New Components

- {component type}: {name} — {label/description}
- ...

### Reused Components

- {component type}: {name} — {how it's used in this feature}
- ...

### Changed Files

| File | Change |
|---|---|
| {file path relative to app root} | **(new)** or **(modified)** |
| ... | ... |

### Testing Notes

{How to test the feature:

- Required setup (board structure, column types, data)
- Example parameter values
- Expected output}
```
