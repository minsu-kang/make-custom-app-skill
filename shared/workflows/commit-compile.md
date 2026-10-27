# Commit, compile, roll back

> Read when: the user explicitly asks to commit, compile, or roll back. Never propose these as a next step (hard rule 4).

```
node "<plugin root>/shared/scripts/commit-changes.js" {slug} {ver} commit --message="{KEY} {summary}" [--change-ids=1,2] [--issue=KEY]
node "<plugin root>/shared/scripts/commit-changes.js" {slug} {ver} compile [--issue=KEY]
node "<plugin root>/shared/scripts/commit-changes.js" {slug} {ver} rollback --confirm
```

`--message` 1–1000 chars, defaults to all pending changes; `--issue=KEY` chains `post-review-transition.js {KEY} committed`; `--notify` only when the user asks. Commit enqueues a compile. Commit on a non-approved app exits 2 and points to `compile`.

**⛔ Rollback is never self-initiated.** It discards **all** pending changes on the version at once and cannot be undone. Do not run it, propose it as a repair step, or pass `--confirm` on your own reasoning. A returned ticket ("돌려줘" / "returned") is not rollback authorization. After a rollback, re-run `download-app.js`.
