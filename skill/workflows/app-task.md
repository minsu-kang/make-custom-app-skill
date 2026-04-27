<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# App Task Workflow

Workflow for handling general Make app tasks — refactoring, UX improvements, label/hint updates, component metadata changes, deprecation, cleanup, and other maintenance work.

## Trigger

Execute this workflow if any of the following conditions are met:

- User shares a Jira task ticket related to Make app maintenance or improvement
- User asks to update labels, hints, field ordering, or other UX elements
- User asks to refactor, clean up, or reorganize app components
- User asks to update component metadata (rename, change type, reorder)
- User asks to deprecate or remove app components

## Steps

**1. Gather Context**: Collect all available information about the task.

- **Jira ticket**: Use the Atlassian MCP (`getJiraIssue`) to fetch ticket details — summary, description, Acceptance Criteria
- **Subtasks**: Fetch all subtasks to understand granular requirements and QA feedback
- **Comments**: Read comments on parent and subtasks for clarifications and scope changes
- **User description**: What needs to change and why
- **Search Pinecone**: Call `search_app_knowledge` for prior context, related work, and known caveats

**2. App Detection & Code Download**: Identify the app and ensure code is available.

- Determine app slug and version from the ticket/description
- If only app name is mentioned without version: auto-detect via IPME (see [App Version Auto-Detection](app-context.md#app-version-auto-detection-ipme))
- Ensure code is available and fresh (see [App Code Download](app-context.md#app-code-download--sync-execution))
- Load the context file `{slug}-v{version}.md` if it exists

**3. Analyze Scope of Changes**: Determine what needs to change and assess impact.

- Identify all affected components (modules, RPCs, connections, functions)
- For UX changes: **read [UX best practices](../references/app-ux-best-practices.md) first** before making any label, hint, or field changes
- For refactoring: map dependencies between components to ensure nothing breaks
- For deprecation/removal: check which scenarios or modules reference the component
- Present the scope to the user and confirm before proceeding

**4. Implement Changes**: Apply the changes based on task type.

### For UX Changes (labels, hints, field ordering)

- Follow [UX best practices](../references/app-ux-best-practices.md) strictly
- Label capitalization: Sentence-style by default, follow app convention if consistently Title Case
- Label naming: 1–3 words, descriptive not instructional, no articles
- Hint formatting: Examples in backticks, default values in backticks, links with app name + page name
- Push changes using `update-app.js` (see [App Code Update](app-context.md#app-code-update-push-changes-to-make))

### For Component Metadata Changes (rename, type change, reorder)

- Use `update-component.js` for metadata updates:

```
1. Show: "Updating component metadata: {component-type} '{name}' — Proceed?"
2. Wait for user approval
3. Shell tool: node ${SKILL_ROOT}/scripts/update-component.js {app-slug} {app-version} {component-type} {name} {updates-json}
   required_permissions: ["all"]
   block_until_ms: 30000
```

### For Component Deletion

- Use `delete-component.js`:

```
1. Show: "⚠️ Deleting component: {component-type} '{name}' — This action cannot be undone. Proceed?"
2. Wait for EXPLICIT user approval
3. Shell tool: node ${SKILL_ROOT}/scripts/delete-component.js {app-slug} {app-version} {component-type} {name}
   required_permissions: ["all"]
   block_until_ms: 30000
```

### For Code Refactoring

- Write updated code to `${CONTEXTS_DIR}/{slug}-v{version}/`
- Push using `update-app.js` (see [App Code Update](app-context.md#app-code-update-push-changes-to-make))
- If custom IML functions are modified, update `test.js` accordingly

**5. Verify No Breaking Changes**: Ensure the task doesn't break existing functionality.

- Check that no existing expect/parameters fields were removed or renamed (breaks scenario settings)
- Check that no interface output fields were removed or renamed (breaks scenario mappings)
- Check that connection parameters are unchanged (breaks existing connections)
- For refactoring: verify that the refactored code produces identical behavior
- If any potential breaking change is detected, warn the user before proceeding

**6. Write Developer Notes**: Generate notes for the Jira ticket.

Generate Developer Notes using the appropriate template from [developer-notes-templates.md](../references/developer-notes-templates.md). **Auto-write to Jira**: Use `editJiraIssue` to set `customfield_10483` with ADF format including tables. This must be done automatically — never skip this step.

**7. Update Context**: Update `{slug}-v{version}.md` with the task details.

- Update Structure section if components were added, removed, or renamed
- Add any new caveats discovered
- Record the work in Work History
- **After updating, execute [Pinecone Auto-Sync](pinecone-sync.md) — both `upsert_app_context` and `upsert_jira_ticket`.**

**8. Post-Commit Sync**: When the user confirms changes have been committed, **auto-execute** the download command to sync.

```
Shell tool: node ${SKILL_ROOT}/scripts/download-app.js {app-slug} {app-version}
required_permissions: ["all"]
block_until_ms: 120000
```
