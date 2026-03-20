# Code Review Workflow

Workflow for AI to fetch uncommitted changes from a Make app and perform a code review.

## Trigger

Execute this workflow if any of the following conditions are met:

- User requests a code review (e.g., "code review", "review changes")
- User asks to review changes for a specific app

## Steps

**1. App Detection**: Determine the app slug and version.

- If the user explicitly mentions it: use that app
- Extract from open file path: `sdk/apps/{slug}/{version}/` pattern
- If only app name is given without version: auto-detect via IPME (see [App Version Auto-Detection](app-context.md#app-version-auto-detection-ipme))
- If unclear: ask the user

**2. Load Context (Mandatory — before review)**: Before fetching code or analyzing changes, load existing knowledge about this app to inform the review.

1. **Local context file**: Read `~/.cursor/make-app-contexts/{slug}-v{version}.md` if it exists. This contains app structure, key patterns, caveats, and **work history** (previous reviews, bugs found, known issues).
2. **Pinecone search**: Call `search_app_knowledge` with the app slug and relevant keywords (ticket key, module names, feature area) to find prior context, related fixes, and known caveats from the team.
3. **Evaluate relevance**: Check if any previous work history entries relate to the current review (e.g., same ticket re-review, same modules changed before, known bugs in affected areas). Use this context to:
   - Detect re-reviews and load previous issues for verification
   - Identify known caveats that may affect the current changes
   - Avoid repeating analysis already captured in prior reviews

**Do NOT skip this step.** Missing context leads to incomplete reviews (e.g., not catching that a previous review flagged a bug that is still unfixed).

**3. Check App Code & Run Scripts**: Both `download-app.js` and `review-changes.js` must be run **every time** a review is requested — including re-reviews. The local code in `make-app-contexts` may be stale even if the folder exists, and the changes data must always be freshly fetched from the API.

**Auto-execute** both scripts in order using the Shell tool:

```
Shell tool: node ~/.cursor/skills/make-custom-app/scripts/download-app.js {app-slug} {app-version}
required_permissions: ["all"]
block_until_ms: 120000
```

```
Shell tool: node ~/.cursor/skills/make-custom-app/scripts/review-changes.js {app-slug} {app-version}
required_permissions: ["all"]
block_until_ms: 60000
```

**4. Read Review Data**: After scripts complete, read the review data.

```
~/.cursor/make-app-contexts/{slug}-v{version}/reviews/latest.json
```

**5. Analyze & Review**: Compare and analyze `old_value` and `new_value` for each change to perform the review. Use context loaded in Step 2 to cross-reference previous issues, known caveats, and related work history.

**6. Component Context (Optional)**: If full context of the changed component is needed, read related files from `~/.cursor/make-app-contexts/{slug}-v{version}/` for reference.

**7. Auto-Sync to Pinecone**: After the review is complete, execute [Pinecone Auto-Sync](pinecone-sync.md) — call `upsert_jira_ticket` with `ticket_type: "review"` and the review result.

## Review Output Format

Provide review results in the following structure:

```
## Code Review: {App Name} v{Version}

### Summary
- Total {N} change(s)
- Overall verdict: LGTM / Changes Requested / Needs Discussion

### Per-Change Review

#### [{#}] {group}/{item}/{code}
- **Verdict**: LGTM | Breaking Change | Bug | Improvement Needed
- **Change Summary**: (one-line summary)
- **Detailed Analysis**: (old → new comparison, estimated reason for change, scope of impact)
- **Suggestions**: (if any)

### Commit Checklist

At the end of every review, include a commit checklist so the user can easily see what to commit in the SDK:

Commit message: `{JIRA-KEY}: {concise description of changes}`

- [ ] {group}/{item}/{code}
- [ ] {group}/{item}/{code}
- ...
```

## Review Criteria

Evaluate each change against the following criteria:

### Breaking Changes (risk of breaking existing scenarios)

- Interface output fields removed/renamed → existing scenario mappings may break
- Expect/Parameters fields removed/renamed → existing scenario settings become invalid
- Connection parameters changed → existing connections may break
- Module type changed → scenario compatibility broken
- Trigger configuration changed (id/date field, type, order) → risk of duplicate/missed triggers
- API URL path changes that alter functionality

### Bugs (potential bugs)

- Incorrect variable references in IML expressions (e.g., `{{parameters.filed}}` typo)
- Missing required fields (no response.output, no error handling, etc.)
- JSON structure errors (missing brackets, incorrect nesting)
- Infinite loop potential in pagination (condition always true)
- Temp variable mismatch in sequential requests
- Output not using `{{item}}` when iterate is used

### Improvements (recommended enhancements)

- Missing or generic-only error handling
- Missing log sanitize (Authorization, API key, or other sensitive data exposed)
- Missing pagination (risk of data loss with large datasets)
- Unnecessary API calls (could be skipped with condition)
- Hardcoded values (baseUrl, API version, etc. → should move to base.imljson)
- Missing `ifempty()` / null checks
- Missing `label` in interface fields (UX degradation)
- Duplicate code patterns (common logic could be extracted to RPC or base)

### Security

- Sensitive data sent without log sanitize
- API key exposed in URL query string
- User input not validated

### LGTM (no issues)

- None of the above apply and the code correctly follows Make app patterns

## Important Rules

- **ALWAYS run both download-app.js and review-changes.js before every review** — never rely on previously saved local code or `latest.json`. The local code in `make-app-contexts` may be stale, and review data must be freshly fetched each time, including re-reviews after code changes.
- After review, if fixes are needed, apply them using `update-app.js` (see [App Code Update](app-context.md#app-code-update-push-changes-to-make)) instead of manually editing in the SDK.
- If there are 0 changes: inform the user "No uncommitted changes found."
- Focus the review on **old_value → new_value comparison**. If only new_value exists (new component), evaluate quality of new_value only.
- If any breaking change is found, the overall verdict must be **Changes Requested**.
- If any bug is found, the overall verdict must be **Changes Requested**.
- If only improvements are found, the overall verdict can be **LGTM (with suggestions)**.
- Do NOT modify local code in `make-app-contexts` after review. Local code sync is the responsibility of download-app.js.
