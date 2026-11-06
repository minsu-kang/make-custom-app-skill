# Self-review (public mode)

> Read [lifecycle.md](lifecycle.md) first. In `MODE: public` this replaces the employee steps of [code-review.md](code-review.md): the user reviews their own app against their own request, with no Jira and no disposition. The criteria, gates and output blocks of code-review.md apply as written unless a section below changes them. Never edits the app.

## Inputs
- Slug and version: lifecycle.md §1 (Public mode: the user's own apps).
- Goal: what the app or the change should do, from the chat. It stands for the AC (hard rule 8). Not given: ask once; "a general quality review" is a valid answer (then no AC Coverage).
- Load context (lifecycle.md §3) before looking at code.

## Scope
State the scope in one line before the review.

| Situation | Steps | Scope |
|---|---|---|
| Local edits not pushed yet (a file other than `metadata.json` and `reviews/` is newer than `downloadedAt`) | Do not sync. Run `download-app.js {slug} {version} --snapshot`, then `review-changes.js {slug} {version} --baseline latest`. A component made with `create-component.js` since the last sync is missing from the local `metadata.json`, so it shows as `removed` rows (its metadata and its files in the snapshot) and its local files are not compared: ask the user to push the edits first with the skill that made them, then use the next row, or review that component by name (the last row). | The unpushed edits against what Make holds now |
| Pushed work | Run `download-app.js` fresh, then `review-changes.js {slug} {version}`. | The change rows when Make lists them (`source: api`, an approved app). No rows on an app that is not approved: the diff against the newest snapshot (`source: baseline`); name its time as the baseline, and offer an older id when the user means an earlier start. An approved app with no pending rows: say so, and offer the full app or named components. |
| `review-changes.js` exits 2 (no snapshot) | | The full app, as the `approved: false` row of code-review.md |
| The user names components, or has the app in their own git repository | | Those components, or that git diff |

`review-changes.js` exit 1: show its failed calls and stop; when its fix line says that Make sent no change list, review the full app as that line says. Exit 2 for a snapshot id that does not exist lists the ids there are; exit 2 for a missing local copy asks for a sync first. A `removed` row is a finding to confirm with the user. code-review.md § Filter to the ticket does not apply: the scope above decides what is reviewed, and a finding outside the goal is still reported, marked "outside the goal".

`reviews/latest.json`: `source` is `api` (change rows with `id`, `group`, `item`, `code`, `label`, `old_value`, `new_value`) or `baseline` (a diff against the snapshot named in `baseline`, with its `id`, `takenAt` and `dir`). `approved` is Make's answer for the version (true, false or null). A baseline row has `id` null, a `status` (`modified`, `added`, `removed`), a `componentPath` (on a `restorable` row, the path that `update-app.js` takes), the `path` of the file relative to the app folder (inside the snapshot folder unless the row is `added`), and `restorable`; app files have the group `app`, and component metadata rows the code `metadata` with the path `metadata.json`. `workingCopyEdited` true means local edits that are not pushed. Common values are masked on both sides. Make keeps `groups` as plain JSON, so a pushed edit of its comments alone is dropped and shows no row after the next sync.

## Skip rules (code-review.md § Skip rules, with these changes)
- Rule 1: skip Breaking for the whole app only when the user says the app is new and no scenario uses it.
- Rule 3: compare with the shipped component-scaffold-templates.md; no refresh.
- Rule 5: `private: null` is unknown in public mode, never "no production surface". Ask whether scenarios use the component; the user's scenarios can be read with the scenario read tools of this plugin's Make MCP server.
- A module's `public` flag is an informational note, not a finding.
- `common` values are masked: review keys and whether a value is set.

## Review
code-review.md § Review each related change, both gates, and the cross-module check, as written. Component integration tests are skipped with the note of code-review-criteria/api-imljson.md (public mode). Nothing runs during the review: tests go into Next steps.

## Output
The blocks of code-review.md § Output format, with these changes:
- `### Goal: {one line from the chat}` in place of the Jira line; AC Coverage against the goal (left out for a general review); "Mapped AC" reads "Mapped goal item".
- `### Fix list` in place of the Commit Checklist: one line per finding (file, change, the skill that makes it: make-app-bug-investigation, make-app-task, make-app-feature-request). Required for every verdict, LGTM included.
- `### Next steps`: the tests to run after fixes (a live run for an Endpoint or RPC, a test scenario for a module).
- No To Developer message: the findings are addressed to the user.

## After the review
1. Ask: "Record this review in the context file?" Yes: close-out.md step 2 (Work History line `{date} | self-review | {verdict}`), and step 3 only when the context server keys are set. No: done.
2. Offer to apply the fix list through the named skill. This skill never edits the app.
3. Approved app with pending rows, and the user asks to commit: commit-compile.md as its public sentence says. Never offer it first.

## Before a public listing
Only when the user asks how to publish the app or list it for everyone:
- Making an app public cannot be undone: no delete, no way back to private, no deletes of modules, connections or webhooks (`delete-component.js` still deletes RPCs and functions) (https://developers.make.com/custom-apps-documentation/create-your-first-app/app-visibility).
- A listing for all Make users goes through Make's app review: prerequisites https://developers.make.com/custom-apps-documentation/app-review/prerequisites, request https://developers.make.com/custom-apps-documentation/app-review/request-app-review. The user presses the button in Make; Make answers by email.
- Prepare with the user: a self-review with no open Bug or Breaking finding, every module tested in a scenario, help texts and labels per app-ux-best-practices.md, the theme and icon set, and the testing scenarios the review form asks for.
- The plugin never calls publish or the review request (hard rule 4).

## Checklist
- [ ] App identified (slug + version, source stated)
- [ ] Goal taken from the chat (or "general quality review" stated)
- [ ] Context loaded (file; `search_app_knowledge` when its keys are set)
- [ ] Scope chosen and stated (unpushed edits against a fresh snapshot, pushed work against the newest snapshot or the change rows, named components, or the full app)
- [ ] Skip rules decided per component; no skip derived from `private: null`
- [ ] Runtime-reference gate and vendor-docs gate satisfied for every finding
- [ ] Cross-module check done for every "missing X"
- [ ] Output emitted with Fix list and Next steps (no Commit Checklist, no To Developer message)
- [ ] Recording asked; context file written only after a yes
- [ ] Listing steps given only when asked; nothing published or requested
