# App Question Workflow

> Read [lifecycle.md](lifecycle.md) first. Answers a question about one Make custom app, or about an open file under `sdk/apps/`, from its synced source and the references. Read-only: no app edit, no write script, no Developer Notes, no Jira write, no context file or `upsert_*` write.

## Trigger

A question about how an app, module, RPC, webhook, connection, function, or endpoint works; an open file under `sdk/apps/` with a question about it; a general IMLJSON or runtime question (pagination, expressions, directives) with no app attached.

## Steps

1. **Identify the app** ([lifecycle.md](lifecycle.md) §1). A general question that needs no app skips this step and steps 2 and 3, and is answered from the references (step 4).
2. **Sync the code** (lifecycle.md §2). Do not answer questions about an app whose code you have not synced.
3. **Load context** (lifecycle.md §3): the context file and `search_app_knowledge`. For questions about which apps exist or what an app contains, `list_apps` and `get_app_summary`.
4. **Answer from the source and the references.** Read the matching reference (listed in [index.md](../index.md)) before stating anything about `api.imljson`, `expect` / `parameters`, or runtime behavior (hard rule 3). Vendor API claims need the vendor's docs (hard rule 1). Cite files and reference sections (`modules/{name}/api.imljson`) so the user can check them.
5. **A change request is not this workflow.** Say what would change and which kind of task it is (bug fix, feature, maintenance, endpoint, review), then stop. The user's next request starts that workflow. Do not edit the app here.

## Checklist

- [ ] App identified (slug + version, source stated), or the question needs no app
- [ ] Code synced (`download-app.js` fresh) when an app is involved
- [ ] Context loaded (file + `search_app_knowledge`)
- [ ] Answer cites the source files and reference sections it relies on
- [ ] No file edited, no write script run, no `upsert_*` call
