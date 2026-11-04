# Task Lifecycle (shared by every workflow)

Every Make app task runs through these steps. Task workflows add only what is specific to them and point back here for the rest. Before the first local file write, edit, or write script, create a todo list from the task workflow's `## Checklist`; it already holds the lifecycle items. A shorter stand-in list does not count. Follow it strictly: mark one item in progress before starting it, finish it before the next, and do not write files for a later item. `Plan approved before editing` blocks every edit of the app until that item is done. The one write allowed before it is a failing test that reproduces a bug.

A path written `<plugin root>/...` starts at the plugin root: the directory named on the `Plugin root:` line at the top of the skill that is running. When that line still shows a literal `${...}`, the plugin root is the directory two levels above the folder of the skill that is running. Write the full path in every command.

## 1. Identify the app

Resolve `slug` + `version`, in this order:

1. Inline from the user (`slack, 4`, "Google Docs v1").
2. Open file path `…/sdk/apps/{slug}/{version}/…`.
3. Jira ticket **App HQ URL** (`customfield_10268`): `https://{zone}/[admin/]apps/{slug}/{version}` → slug = segment after `/apps/`, version = next segment. A minimal `getJiraIssue` for just that field is fine here; the full fetch is in [jira-ticket.md](jira-ticket.md).
4. Slug known but no version → latest major via IPME. The response is huge, so filter it: `curl -s "https://ipme.integromat.com/v3/search/apps" -H "x-imt-ipm-version: 3.20.0" | node -e 'const s=process.argv[1];console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).filter(a=>a.name===s).map(a=>a.version).join("\n"))' {slug}` prints the matching `version`(s); take the major (`2.52.56` → `2`). 0 matches → step 5; more than one → list them and ask.
5. Otherwise ask.

## 2. Sync code

Local source lives at `~/.make-custom-app/contexts/{slug}-v{version}/` (`metadata.json`, `base.imljson`, `common.imljson`, `modules/`, `connections/`, `webhooks/`, `rpcs/`, `functions/`, `endpoints/`).

Run **without asking** when the folder is missing, `metadata.json.downloadedAt` is older than 24 h (or absent), the user's open SDK file differs from the local copy, or the task is a code review (always fresh):

```
Shell: node "<plugin root>/shared/scripts/download-app.js" {slug} {version}
required_permissions: ["all"], block_until_ms: 120000
```

When `download-app.js` exits non-zero, nothing was written: the folder is the previous copy (stale) or missing. The summary prints `Failed: N` and each section that could not be read (for example the app or the version not found, a refused token, or an app that lives in another zone than the token). Do not answer from, review, or edit that folder: show the failed sections to the user and stop until a new run exits 0. This applies to every run, including the fresh download of a code review. `visibility unknown (public mode)` in the summary is not a failure: public mode does not check whether the app is private or public. In public mode (`metadata.json` has `"visibility": "unknown (public mode)"`), `private`, `packagePrivate`, `ipmDeployedToZone` and the `private` of each module are unknown, not "never deployed": never skip a check because of them.

Before re-downloading an existing folder (not for code reviews, which are always fresh): `download-app.js` overwrites and never deletes. If any file other than `metadata.json` and `reviews/` is newer than `metadata.json.downloadedAt`, it may hold unpushed edits — ask the user or diff first. Components deleted remotely linger as local directories, so `metadata.json`, not the directory listing, is the component list.

Between 1 h and 24 h old: mention the age, offer a re-download, continue. Do not answer questions about an app whose code you have not synced.

## 3. Load context

- Read `~/.make-custom-app/contexts/{slug}-v{version}.md` if it exists (structure, patterns, caveats, work history — including prior reviews and fixes).
- Call MCP `search_app_knowledge` with the slug plus ticket key / module names / feature keywords for team-wide prior context. Skip it when `check-setup.js` reported `mcp-server` as missing (an `OPTIONAL mcp-server` line: its Pinecone or OpenAI key is not set): the context server cannot answer then, and the context file alone completes the `Context loaded` checklist item.
- For a bug in a component that was recently fixed (Work History), apply the recurring-bug rigor below.

### Recurring-bug rigor

- Audit **all** crash points of the same class in the function (every `.match()`, every property access on a possibly-null value), not just the reported one.
- Trace with several data samples, including nested nulls, empty strings, missing keys.
- Ask the user to confirm the previous fix is actually deployed — a "recurring" bug may be an undeployed fix.
- Explain why the previous fix did not cover this case and make the new fix cover the whole category.

## 4. Do the work

Read the task workflow. The checklist todo from the intro already exists; do not start §4 by writing files under a shorter list. For bugfix, feature, app-task, and endpoint work: **state the plan (root cause or design, files, components) and wait for approval before editing.** Mark `Plan approved before editing` done only after that approval, then edit. Edit the local copy under `~/.make-custom-app/contexts/{slug}-v{version}/`, then push ([push-changes.md](push-changes.md)). Re-read the relevant reference before touching each file type (hard rule 3).

## Other shared steps

Read each file when the work reaches that step.

| Step | File |
|---|---|
| A Jira ticket is attached | [jira-ticket.md](jira-ticket.md) |
| Push changes, create or delete components | [push-changes.md](push-changes.md) |
| Run an Endpoint or RPC live | [run-live.md](run-live.md) |
| Commit, compile, or roll back (only on an explicit user instruction) | [commit-compile.md](commit-compile.md) |
| Close out | [close-out.md](close-out.md) |
| Look up component tables, module types, quick facts, the reference list, or the script folder | [index.md](../index.md) |
