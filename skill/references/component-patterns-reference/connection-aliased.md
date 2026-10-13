# Component patterns: Aliased Connections (`aliasTo`)

> Read when: a connection uses `aliasTo`, or any connection change is reviewed. Part of [component-patterns-reference.md](../component-patterns-reference.md).

### Aliased Connections (`aliasTo`)

A connection in one app can be an **alias** of a connection in another app. The alias is declared at the app-metadata level (visible on the admin API `/sdk/apps/{slug}/connections` response as `aliasTo: "<source-connection-name>"`).

**Critical runtime behavior:**

- When a connection has `aliasTo` set, **all of its own files (`api.imljson`, `parameters.imljson`, `common.imljson`, `scope*.imljson`, `install*.imljson`) are EXCLUDED at compile time**.
- The runtime resolves the connection entirely through the **source connection** referenced by `aliasTo`. The source owns `authorize`/`token`/`refresh`/`info`/`invalidate`, scopes, parameters, and install spec.
- **Any edits to an aliased connection's IMLJSON files are silent no-ops.** The local files may still exist in the repo/admin UI and will be returned by `download-app.js`, but they have **zero runtime effect**.
- Connection UX in scenarios (OAuth button, parameters shown) is also driven by the source, so users of the aliased app see the source connection's UI.

**Implications:**

- To change auth/OAuth/validation behavior or bump the API version used by the connection's `info` endpoint, update the **source app's connection**, not the aliased one.
- When reviewing a code change on an aliased connection, **flag it as ineffective** and point the developer to the source connection. A verdict of "harmless no-op" is appropriate if the intent is cosmetic alignment; otherwise the change belongs in the source app.
- Modules, RPCs, webhooks, functions, `base.imljson`, `common.imljson` of the aliased app are **NOT** affected — only the connection itself. (Note: `base.imljson` is inherited by modules/RPCs only, not by webhooks or the connection. See [Base Pattern](../component-patterns-reference.md#base-pattern).)

**Detection:**

- Admin API: `GET /sdk/apps/{slug}/connections` returns `aliasTo` (and snake_case `alias_to`) on connection entries.
- `download-app.js` captures `aliasTo` into `metadata.json` under `connections[].aliasTo`.
- A comment at the top of the aliased connection's `api.imljson` often documents this explicitly (e.g. `// This connection is aliased to the connection (xxx) from Yyy App`), but presence/absence of the comment is not authoritative — check `metadata.json`.

**Example:** `google-ads-conversions` connection `aliasTo: "google-ads2"`. Changes to `connections/google-ads-conversions/api.imljson` are dropped at compile; the runtime uses `google-ads` app's `google-ads2` connection configuration.
