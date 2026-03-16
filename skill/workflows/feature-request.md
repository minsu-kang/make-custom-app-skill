# Feature Request Workflow

Workflow for implementing a new feature in a Make app, typically driven by a Jira feature request ticket.

## Trigger

Execute this workflow if any of the following conditions are met:

- User shares a Jira feature request ticket about a Make app
- User asks to add a new module, RPC, webhook, or connection to a Make app
- User asks to add new functionality or extend existing components

## Steps

**1. Gather Context**: Collect all available information about the feature.

- **Jira ticket**: Use the Atlassian MCP (`getJiraIssue`) to fetch ticket details — summary, description, Acceptance Criteria
- **Subtasks**: Fetch all subtasks to understand granular requirements, scope, and any QA feedback
- **Comments**: Read comments on parent and subtasks for clarifications, scope changes, and reviewer feedback
- **User description**: Feature requirements, target API, expected behavior
- **Key data to extract**: What components to create, API endpoints involved, expected input/output, edge cases
- **Search Pinecone**: Call `search_app_knowledge` to find if similar features were implemented in other apps — reuse patterns where applicable

**2. App Detection & Code Download**: Identify the app and ensure code is available.

- Determine app slug and version from the ticket/description
- If only app name is mentioned without version: auto-detect via IPME (see [App Version Auto-Detection](app-context.md#app-version-auto-detection-ipme))
- Ensure code is available and fresh (see [App Code Download](app-context.md#app-code-download--sync-execution))
- Load the context file `{slug}-v{version}.md` if it exists

**3. Analyze Existing App Structure**: Understand the app's patterns before implementing.

- Read `metadata.json` to understand available modules, connections, RPCs, webhooks
- Read `base.imljson` for baseUrl, auth patterns, error handling, logging conventions
- Read existing modules of similar type to identify consistent patterns (naming, field structure, pagination, error handling)
- Read `common.imljson` for shared configuration
- Identify reusable RPCs and custom functions

**4. Design New Components**: Plan the implementation before writing code.

- **Module type selection**: Choose the correct type based on expected output (see SKILL.md "Module Type Selection")
- **API mapping**: Map API endpoints to module communication structure
- **Field design**: Design expect/parameters following existing app conventions and [UX best practices](../references/app-ux-best-practices.md)
- **Interface design**: Define output structure matching API response
- **RPC reuse**: Identify if existing RPCs can provide dynamic options, or if new RPCs are needed
- **Custom functions**: Determine if response transformation requires custom IML functions
- Present the design to the user and wait for confirmation before proceeding

**5. Create New Components**: Build the components in Make.

For **new** components (modules, RPCs, webhooks, custom functions), use `create-component.js`:

```
1. Show: "Creating new component: {component-type} '{name}' (label: {label}) — Proceed?"
2. Wait for user approval
3. Shell tool: node ~/.cursor/skills/make-custom-app/scripts/create-component.js {app-slug} {app-version} {component-type} {name} {label} [additional-args]
   required_permissions: ["all"]
   block_until_ms: 30000
```

Component types and arguments:

| Type | Command | Additional Args |
|------|---------|----------------|
| Module | `create-component.js {slug} {ver} module {name} {label}` | `--type={type_id}` (1/4/9/10/11/12), `--connection={conn}`, `--crud={crud}` |
| RPC | `create-component.js {slug} {ver} rpc {name} {label}` | `--connection={conn}` |
| Webhook | `create-component.js {slug} {ver} webhook {name} {label}` | `--connection={conn}` |
| Function | `create-component.js {slug} {ver} function {name} {label}` | — |

**6. Write Component Code**: Write IMLJSON code for each section.

- Write code to `~/.cursor/make-app-contexts/{slug}-v{version}/` (local code store)
- Push each section using `update-app.js` (see [App Code Update](app-context.md#app-code-update-push-changes-to-make))
- Follow the implementation order:
    1. **RPCs first** (if new) — other components may depend on them
    2. **Module api.imljson** — request construction, response output, error handling, pagination
    3. **Module expect.imljson** — input fields with proper types, labels, help text
    4. **Module parameters.imljson** — static parameters (for triggers) or dynamic RPC references
    5. **Module interface.imljson** — output field definitions
    6. **Module samples.imljson** — sample output data
    7. **Custom functions** — if response transformation is needed

**7. Create Tests**: For any custom IML functions created or modified.

- Create `test.js` for each function covering:
    - Core functionality (expected inputs → expected outputs)
    - Edge cases (null, undefined, empty arrays, boundary conditions)
    - Data transformation correctness
- Upload via `update-app.js` with component path `function/{name}/test`

**8. Verify Integration**: Ensure new components work with the existing app.

- Check that new modules reference correct connections
- Verify RPC references in parameters resolve correctly
- Confirm interface output matches what downstream modules expect
- Check for breaking changes to existing components (if any were modified)

**9. Write Developer Notes**: Generate notes for the Jira ticket using the Feature template.

Generate Developer Notes using the [Feature template](../references/developer-notes-templates.md). **Auto-write to Jira**: Use `editJiraIssue` to set `customfield_10483` with ADF format including tables. This must be done automatically — never skip this step.

**10. Update Context**: Update `{slug}-v{version}.md` with the new feature details.

- Add new components to the Structure section
- Document any new patterns or API characteristics in Key Patterns
- Record the work in Work History
- **After updating, execute [Pinecone Auto-Sync](pinecone-sync.md) — both `upsert_app_context` and `upsert_jira_ticket`.**

**11. Post-Commit Sync**: When the user confirms changes have been committed, **auto-execute** the download command to sync.

```
Shell tool: node ~/.cursor/skills/make-custom-app/scripts/download-app.js {app-slug} {app-version}
required_permissions: ["all"]
block_until_ms: 120000
```
