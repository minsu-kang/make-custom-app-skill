# Task Lifecycle (shared by every workflow)

Every Make app task runs through these steps. Task workflows add only what is specific to them and point back here for the rest. Before the first local file write, edit, or write script, create a todo list from the task workflow's `## Checklist`; it already holds the lifecycle items. A shorter stand-in list does not count. Follow it strictly: mark one item in progress before starting it, finish it before the next, and do not write files for a later item. `Plan approved before editing` blocks every edit of the app until that item is done. The one write allowed before it is a failing test that reproduces a bug.

A path written `<plugin root>/...` starts at the plugin root: the directory named on the `Plugin root:` line at the top of the skill that is running. When that line still shows a literal `${...}`, the plugin root is the directory two levels above the folder of the skill that is running. Write the full path in every command.

## Public mode

`check-setup.js` prints `MODE: public` when the token cannot call the Make admin API: the user works on their own apps through the public Make API, with no Jira, compile, component tests or ownership transfer. Every step of every workflow stays as written except where this table, or a short "Public mode:" note in a workflow, says otherwise. A checklist item that needs an employee-only step is marked `n/a (public mode)` with the replacement below (hard rule 11). After a context compaction, take the mode from the last `check-setup.js` output, or run it again.

| Step | In public mode |
|---|---|
| Intake | The chat request is the ticket. Before the plan, collect from the chat the goal, the acceptance criteria, the vendor API docs URL, and screenshots or logs as local file paths (read each with the Read tool); for a bug also the input, the full response or error, and the run of the user's scenario (pasted, or read with the scenario execution tools of this plugin's Make MCP server, which only read). Restate them in the plan; the AC are fixed when the user approves the plan (hard rule 8). Skip [jira-ticket.md](jira-ticket.md), the Preparation guard and every Jira call, and never offer the Atlassian MCP server. |
| Identify the app (§1) | Sources 1, 2 and 5 apply. Instead of sources 3 and 4, list the user's own apps with `custom_app_list` of the Make MCP server and let the user pick (not connected, or the app is missing from the list: ask for the slug and version). A new app: `custom_app_create` after the user's yes (a write, hard rule 4); the `name` it returns is the slug and the version is 1. Then sync. |
| Sync (§2) | As written. `metadata.json` has `"visibility": "unknown (public mode)"` and `commonMasked`: every non-empty string and every number in `common.imljson` and `connections/{name}/common.imljson` reads `***MASKED:string***` or `***MASKED:number***`. Use only the keys and whether a value is set; never treat a marker as data, and never ask for a token, password or other secret. When a masked value that is not a secret, such as a timeout or a page size, decides a finding or a design, ask the user to look it up in the Common data section of the app's Base page or of the connection's Communication page in the Make UI. A review of the user's own app checks for local edits that are not pushed before it syncs: the review route compares them with a new snapshot first. |
| Snapshot | Before the first write script of a task (`create-component.js` included), run `node "<plugin root>/shared/scripts/download-app.js" {slug} {version} --snapshot`. It reads Make into `~/.make-custom-app/snapshots/{slug}-v{version}/{id}/` and leaves the working folder alone; tell the user the id. `update-app.js`, `update-component.js` and `delete-component.js` stop with exit 2 when no snapshot was taken since the last sync (a `download-app.js` run without `--snapshot`): take one, and do not switch to a Make MCP tool. A sync after the snapshot asks for a new one before the next push. The first snapshot of the task is the way back while it is among the newest five of the app: when four newer ones exist, copy its folder out of `snapshots/` before taking another. `create-component.js` does not check for a snapshot, so take it before the first create yourself. Take one before a Make MCP push too. |
| Push ([push-changes.md](push-changes.md)) | As written. On an app with `approved` false or null a push is live at once for every scenario that uses the app: say so when you ask for the yes. `update-app.js` refuses a `common` file that still holds a marker; the user changes common data in the Make UI, in the Common data section of the app's Base page or of the connection's Communication page. |
| Undo a push | An unapproved app has no change list. Run `download-app.js` so the local copy is what Make holds, then `review-changes.js {slug} {version} --baseline {id}` with the snapshot to go back to, and show its rows. That sync asks for a new snapshot before the next push, and each new snapshot removes the oldest beyond five: when `{id}` is the oldest of five, copy its folder out of `snapshots/` first. After the user's yes take the new snapshot, then push each `restorable` row with `update-app.js {slug} {version} {componentPath} {file}`, where the file is `path` inside the snapshot folder (`baseline.dir` in `reviews/latest.json`, or the copy); list the other rows (added or removed components, `readme.md`, component metadata, `common`) for the user to decide. Then sync again. |
| Tests (hard rule 9) | Functions: `test-function.js` runs on the plugin's IML shim; exit 2 means no test failed and at least one needed a built-in, or a form of one, that the shim lacks: check that one in a scenario run. Endpoint or RPC: a live run ([run-live.md](run-live.md)). Module, and the connection or webhook it uses: a test scenario ([module-test.md](module-test.md)), asked once per task. `test-component.js` and mockup fixtures need a Make employee account: say so once and go on. |
| Commit and rollback ([commit-compile.md](commit-compile.md)) | Decided by `approved` in `metadata.json`. False or null: every push is already live; there is nothing to commit, compile or roll back, so never offer it. True: pushes wait as change rows until Make commits them after its review; commit or roll back only when the user asks, with `--message="{summary}"` and never `--issue`. `compile` is not available. |
| Review | A review of the user's own app follows the self-review route that the code review skill names in its load order. |
| Live runs ([run-live.md](run-live.md)) | Skip both ownership transfers: the token's user owns the app. The first live run for a token and zone stops once with `ACTION: CONFIRM_LIVE_RUN`: relay the notice, and only after the user agrees run the same command with `--accept-live-notice`. No fixtures. |
| Endpoints | SDK Endpoints are a closed beta that most Make accounts do not have: say so before endpoint work starts. A refusal on an endpoint list, create or run usually means the account lacks the beta: stop and tell the user. `download-app.js` also reads the endpoint list: when only `endpoint list` failed, nothing was synced; tell the user that the account may lack the beta. |
| Close-out ([close-out.md](close-out.md)) | Skip step 1 and show a change summary in the chat (the feature or bugfix table of [developer-notes-templates.md](../references/developer-notes-templates.md), without the Jira field). Step 2 as written, with a Work History line without a ticket key. Step 3 only when `check-setup.js` shows the `mcp-server` keys as set. Run `download-app.js` once after the last push. |
| Publish and Make's review | Never make the app public and never request Make's review (hard rule 4); making an app public cannot be undone. When the user asks how to list the app for everyone, give the listing steps of the self-review route; the user does both in Make. |

## 1. Identify the app

Resolve `slug` + `version`, in this order:

1. Inline from the user (`slack, 4`, "Google Docs v1").
2. Open file path `…/sdk/apps/{slug}/{version}/…`.
3. (Employee mode.) Jira ticket **App HQ URL** (`customfield_10268`): `https://{zone}/[admin/]apps/{slug}/{version}` → slug = segment after `/apps/`, version = next segment. A minimal `getJiraIssue` for just that field is fine here; the full fetch is in [jira-ticket.md](jira-ticket.md).
4. Slug known but no version → latest major via IPME. The response is huge, so filter it: `curl -s "https://ipme.integromat.com/v3/search/apps" -H "x-imt-ipm-version: 3.20.0" | node -e 'const s=process.argv[1];console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).filter(a=>a.name===s).map(a=>a.version).join("\n"))' {slug}` prints the matching `version`(s); take the major (`2.52.56` → `2`). 0 matches → step 5; more than one → list them and ask. Public mode: § Public mode, Identify the app.
5. Otherwise ask.

## 2. Sync code

Local source lives at `~/.make-custom-app/contexts/{slug}-v{version}/` (`metadata.json`, `base.imljson`, `common.imljson`, `modules/`, `connections/`, `webhooks/`, `rpcs/`, `functions/`, `endpoints/`).

Run **without asking** when the folder is missing, `metadata.json.downloadedAt` is older than 24 h (or absent), the user's open SDK file differs from the local copy, or the task is a code review (always fresh):

```
Shell: node "<plugin root>/shared/scripts/download-app.js" {slug} {version}
required_permissions: ["all"], block_until_ms: 120000
```

When `download-app.js` exits non-zero, nothing was written: the folder is the previous copy (stale) or missing. The summary prints `Failed: N` and each section that could not be read (for example the app or the version not found, a refused token, or an app that lives in another zone than the token). Do not answer from, review, or edit that folder: show the failed sections to the user and stop until a new run exits 0. This applies to every run, including the fresh download of a code review. `Visibility: unknown (public mode)` in the summary is not a failure: public mode does not check whether the app is private or public. In public mode (`metadata.json` has `"visibility": "unknown (public mode)"`), `private`, `packagePrivate`, `ipmDeployedToZone` and the `private` of each module are unknown, not "never deployed": never skip a check because of them.

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
| A Jira ticket is attached (employee mode) | [jira-ticket.md](jira-ticket.md) |
| Push changes, create or delete components | [push-changes.md](push-changes.md) |
| Run an Endpoint or RPC live | [run-live.md](run-live.md) |
| Commit, compile, or roll back (only on an explicit user instruction) (public mode: only on an approved app) | [commit-compile.md](commit-compile.md) |
| Close out | [close-out.md](close-out.md) |
| Test a module (public mode) | [module-test.md](module-test.md) |
| Look up component tables, module types, quick facts, the reference list, or the script folder | [index.md](../index.md) |
