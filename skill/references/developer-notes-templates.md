# Developer Notes Templates

Generate Developer Notes for any Jira ticket (bug, feature, or other) when work is completed. Use the appropriate template based on the ticket type.

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

{Concise technical explanation of what causes the bug, including:

- Which function/component has the bug
- What condition triggers it
- Why it produces the wrong result}

### Fix

{Description of the changes made:

- What was changed and why
- How the new logic works}

### Affected Components

- {module/function name} — {label/description}
- ...

### Changed Files

- {file path relative to app root} **(new)** or **(modified)**
- ...
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

- {file path relative to app root} **(new)** or **(modified)**
- ...

### Testing Notes

{How to test the feature:

- Required setup (board structure, column types, data)
- Example parameter values
- Expected output}
```
