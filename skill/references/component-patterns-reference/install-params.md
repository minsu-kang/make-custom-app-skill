# Component patterns: App-Level Install Params

> Read when: writing or reviewing `install.imljson` / `installSpec.imljson`, or deciding whether a value is app-level or connection-level. Part of [component-patterns-reference.md](../component-patterns-reference.md).

## App-Level Install Params

`installSpec.imljson` and `install.imljson` exist at **two scopes**, with different semantics:

| Scope                | Location                                                                                    | Purpose                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **App-level**        | App root: `{app}/installSpec.imljson` + `{app}/install.imljson`                             | Define and populate `common.*` for the whole app (platform-managed credentials, shared API keys, global timeouts). Filled by an **admin** via the admin panel after the app is installed in a zone.                                        |
| **Connection-level** | `{app}/connections/{name}/installSpec.imljson` + `{app}/connections/{name}/install.imljson` | Define and populate `common.*` fallback for one connection (typical OAuth2 client_id / client_secret pattern — see [OAuth2 Connection with Common Fallback](connection-oauth.md#oauth2-connection-with-common-fallback-install--installspec-required)). |

This section describes the **app-level** scope. The connection-level scope is covered in [OAuth2 Connection with Common Fallback](connection-oauth.md#oauth2-connection-with-common-fallback-install--installspec-required).

### Structure

```json
// {app}/installSpec.imljson
[
	{ "name": "apiKey", "type": "password", "label": "API Key", "required": true },
	{ "name": "timeout", "type": "uinteger", "label": "Timeout (ms)", "required": true, "default": 300000 }
]
```

```json
// {app}/install.imljson
{
	"common": {
		"apiKey": "{{parameters.apiKey}}",
		"timeout": "{{parameters.timeout}}"
	}
}
```

`installSpec.imljson` declares the admin form (one entry per field — identical schema to `parameters.imljson`); `install.imljson` maps those `parameters.*` values into `common.*` keys that the app's `base.imljson` / modules / RPCs / connections can then reference as `{{common.apiKey}}` etc.

### Admin Panel — Where Values Are Entered

After the app is deployed via IPM to a zone, an admin user opens:

```
{zone_url}/admin/native-apps/{slug}/version/{version}
```

For example: `https://eu1.make.com/admin/native-apps/make-ai-web-search/version/1.0.0`.

The form rendered there is generated from `installSpec.imljson`. The admin fills in each field; on save, the platform applies `install.imljson` to produce the runtime `common.*` payload for that zone.

**This is the only place those values can be set or changed** — they are not exposed in the scenario builder, not in user settings, not in the developer SDK.

### Post-Approval Editability

`approved: true` does **not** lock install params:

- The **static contents** of `common.imljson` (values baked into the app source at build time) are frozen after approval.
- Values populated via the `installSpec` + `install` flow are **not** frozen. The admin can update them through the admin panel at any time, on any zone independently.
- **Adding a new field to `installSpec.imljson` after approval is a normal edit**: upload the spec change, then the admin sees the new field in the admin panel and fills it in. No v2 bump, no platform sign-off required at the IMLJSON level (deployment policies still apply per the Make team's release process).

Implication for refactors and new features that need an additional platform-managed credential: extend `installSpec.imljson` + `install.imljson` rather than bumping the app version, and treat the post-upload admin-panel input as a deployment step, not an architectural blocker.

### When App-Level vs Connection-Level

| Need                                                                                                                                                                | Use                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| One platform-managed credential shared by every module / RPC / webhook in the app (no per-user connection) — typical for "global" apps like Make-issued AI wrappers | **App-level** `installSpec` + `install` → `common.*`                                            |
| Per-user credential where each user creates their own connection in the scenario builder                                                                            | **Connection** with `parameters.imljson` (no install pair needed)                               |
| OAuth2 where the platform ships Make-owned `client_id` / `client_secret` as fallback, but users can override per-connection                                         | **Connection-level** `installSpec` + `install` — see [connection-oauth.md § "OAuth2 Connection with Common Fallback"](connection-oauth.md#oauth2-connection-with-common-fallback-install--installspec-required) |

### Code-Review Heuristic

If `rg "common\." {app}/base.imljson {app}/modules/*/api.imljson` returns hits to `common.*` keys, the app must have one of:

- App-root `installSpec.imljson` + `install.imljson` declaring those keys, OR
- A connection with connection-level `installSpec.imljson` + `install.imljson` declaring them, OR
- Static `common.imljson` entries for them (pre-approval apps only).

Missing all three → bug (admin has no way to set the value, runtime resolves to empty, every request fails auth).
