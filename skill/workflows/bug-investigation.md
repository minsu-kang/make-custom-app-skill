# Bug Investigation Workflow

Workflow for investigating a bug reported via Jira ticket or user description, tracing the root cause through app code, and applying a fix.

## Trigger

Execute this workflow if any of the following conditions are met:

- User shares a Jira ticket link about a Make app bug
- User describes a bug in a specific Make app module (e.g., "this module throws PARSING_ERROR")
- User asks to investigate an error in a Make app

## Steps

**1. Gather Context**: Collect all available information about the bug.

- **Jira ticket**: Use the Atlassian MCP (`getJiraIssue`) to fetch ticket details — summary, description, priority, attachments
- **User description**: Error message, affected module, steps to reproduce
- **Key data to extract**: Error message, affected URL, input data, request/response bodies, reproduction steps
- **Request missing information**: If any of the following are NOT provided, ask the user before proceeding:
    - **Actual input parameters** used when the error occurred
    - **Full API response body** (the data the module received from the external API)
    - **Make execution logs** (links in Jira ticket or from Make admin panel) — these show the exact IML expression that errored and the runtime context
- Do NOT proceed to root cause analysis with only an error message. The actual data that triggered the error is essential.

**2. App Detection & Code Download**: Identify the app and ensure code is available.

- Determine app slug and version from the ticket/description (e.g., "MONDAY.COM v2" → `monday`, `2`)
- If only app name is mentioned without version: auto-detect via IPME (see [App Version Auto-Detection](app-context.md#app-version-auto-detection-ipme))
- Check if `~/.cursor/make-app-contexts/{slug}-v{version}/` exists
- If not, auto-execute the download command (see [App Code Download](app-context.md#app-code-download--sync-execution))
- Load the context file `{slug}-v{version}.md` if it exists
- **Check for related past fixes**: Search the context file's Caveats and Work History for previous fixes to the same function/component. If found, pay extra attention — the new bug may be a gap in the previous fix (see "Recurring Bug Handling" below).

**3. Identify Affected Component**: Locate the module/function where the error occurs.

- Match the error to a specific module from `metadata.json`
- Read the module's `api.imljson` to understand the request construction and the **full function call chain** in the response output expression (e.g., `parseDatesFromISOFormat(mapColumnValues(buildRelValueField(...)))`)
- Identify ALL custom functions in the chain, not just the one mentioned in the error
- **Shared function pattern**: If the error originates in a custom function (not directly in `api.imljson`), grep for the function name across all `modules/*/api.imljson` files to find every module that calls it — the bug likely affects all of them

**4. Trace Execution with Actual Data**: Follow the data flow with the user's actual input — do NOT rely on reading code alone.

- Read the module's `expect.imljson` to understand parameter structure
- Read the RPC that generates dynamic parameters (if any)
- **Full chain trace**: When the user provides actual response data, trace through EVERY function in the response chain step by step with that data:
    1. Start with the raw API response
    2. Apply each transformation function in order (innermost first)
    3. Examine the intermediate output at each step
    4. Identify the exact point where the data causes the error
- This is the most critical step — code-reading alone often misses edge cases. The actual data reveals the true execution path.

**5. Reproduce with Failing Test**: Before proposing ANY fix, write a test that reproduces the crash.

- Create a test case using the actual input data (or a minimal subset that triggers the bug)
- The test must **fail** (throw the same error) with the current code
- If the test does NOT fail → the hypothesis is wrong. Go back to Step 4 and re-trace.
- **This is a mandatory gate.** Do not proceed to Step 7 (Fix) without a confirmed reproduction. Present the reproduction result to the user as part of Step 6.

**6. Check Impact Scope**: Determine if other components are affected.

- Search for all usages of the affected function/pattern across the app
- Check if other modules use the same RPC or custom function
- Assess whether the fix could have side effects on other modules

**7. Present Findings**: Before applying a fix, present the root cause analysis to the user.

- Summarize: error flow, root cause, why it happens, affected components
- **Include reproduction evidence**: Show that the failing test confirms the root cause
- Wait for user confirmation before proceeding to the fix
- This prevents wasted effort from an incorrect diagnosis

**8. Fix & Verify**: Apply the fix, verify it passes, and push to Make.

- Write the fixed code to `~/.cursor/make-app-contexts/{slug}-v{version}/` (the local code store)
- **Verify**: Confirm the failing test from Step 5 now passes with the fix applied. If it still fails, the fix is incomplete — iterate.
- Push the fix using `update-app.js` (see [App Code Update](app-context.md#app-code-update-push-changes-to-make)) — **always ask user for approval before executing**.

- Changes are pushed as **uncommitted** to Make — the user must still commit and deploy via SDK
- **All custom IML functions must have `test.js`** — for new functions, create it; for existing functions, update it. Test cases must cover:
    - Core functionality (expected inputs → expected outputs)
    - Edge cases (null, undefined, empty arrays, boundary conditions)
    - For bug fixes: the bug scenario (must fail before fix, pass after) + regression tests

## Recurring Bug Handling

When a bug occurs in a function/component that was **recently fixed** (check Work History in the context file), apply extra rigor:

- **Audit ALL crash points**: Do not stop at the first matching hypothesis. Systematically list every possible path in the function where the same error type could occur (e.g., every `.match()` call, every property access on potentially-null values).
- **Trace with multiple data samples**: If the user provides one response, also consider edge cases from the response (e.g., nested objects with null values, empty strings, missing keys).
- **Verify the previous fix is deployed**: Ask the user to confirm the previously fixed code is actually running in production. A "recurring" bug may simply be an undeployed fix.
- **Root cause the gap**: Explain WHY the previous fix didn't cover this case, and ensure the new fix addresses the full category of issues, not just the specific instance.

**9. Write Developer Notes**: Generate notes for the Jira ticket.

Generate Developer Notes for the Jira ticket using the appropriate template (see [developer-notes-templates.md](../references/developer-notes-templates.md)). **Auto-write to Jira**: Use `editJiraIssue` to set `customfield_10483` (Developer Notes field) with ADF (Atlassian Document Format) content including tables. This must be done automatically — never skip this step.

**10. Update Context**: Update `{slug}-v{version}.md` with the bug details and fix in the Work History and Caveats sections. **After updating, execute [Pinecone Auto-Sync](pinecone-sync.md) — both `upsert_app_context` and `upsert_jira_ticket`.**

**11. Post-Commit Sync**: When the user confirms the fix has been committed, **auto-execute** the download command to sync `make-app-contexts` with the committed code.

```
Shell tool: node ~/.cursor/skills/make-custom-app/scripts/download-app.js {app-slug} {app-version}
required_permissions: ["all"]
block_until_ms: 120000
```

This ensures `make-app-contexts` always reflects the latest committed state, preventing stale code from being used in future reviews or investigations.
