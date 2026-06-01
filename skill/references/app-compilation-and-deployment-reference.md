<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# App Compilation & Deployment Reference

How a Make custom app travels from the editable SDK code (stored in a database) to a **compiled file package** that a Make zone instance actually executes. This is the missing half of the picture for code reviews: it explains *why* `review-changes.js` behaves the way it does, what `approved` / `compile` really mean, and where a "live" app physically lives.

> **Source repos** (Make internal — referenced the way `runtime-reference.md` references `imt-app-runtime`):
> `imt-web-api` (admin/SDK API + DB store), `make-apps-processor` (compiler), `imt-ipm-server` (package registry, IPM = Integromat Package Manager), `imt-ipm-service` (per-zone installer), `integromat` (zone/HQ instance structure). Every claim below was verified against these sources; if a detail is not in source it is marked as such.

## 1. Two representations of one app

A custom app exists in **two completely different forms** at the same time:

| | SDK / DB working copy | Compiled file package (PKR) |
|---|---|---|
| **Where it lives** | Postgres `apps.*` schema (in `imt-web-api`) | Filesystem: `imt_modules/{slug}/v{major}/` on the instance |
| **How you read it** | `GET /sdk/apps/{slug}/{version}/...` admin API (this is what `download-app.js` pulls) | Runtime `require()` of the package's `lib/*.js` |
| **Shape** | Component-split IMLJSON (`base`, `common`, per-module `api`/`expect`/`interface`/`parameters`/`samples`, rpc/webhook/connection IMLJSON, function `code`/`test`) | `manifest.json` (compiled) + `lib/app.js` (+ `lib/functions.js`, `lib/rpc.js`) + `assets/` + optional `install.json` |
| **IML expressions** | Stored as-is | Stored as-is — embedded as **strings**, evaluated at runtime (compile does NOT evaluate IML) |
| **Who edits it** | Developer in the SDK / via `update-app.js` | Nobody — it's a build artifact |

**The SDK code is the source; the compiled package is the build output.** A code review reads the SDK code (`download-app.js`); the compiled package is what users' scenarios run against once the app is committed/compiled and installed to their zone.

## 2. The pipeline (commit → compile → publish → install → run)

```
[SDK edit]  →  Postgres apps.*   (approved app → edits land in apps.change = uncommitted delta)
   │  POST /sdk/apps/{slug}/{version}/commit   → apps.changes_commit  (apply delta to apps.*, delete change rows)
   ▼  enqueueCompile  → apps.app_compile builds an "AppToCompile" snapshot
[make-apps-processor]  POST /compile (JSON body, 202, queued via RabbitMQ)
   │  compile()  → PKR v2 binary (a virtual Node package tree; see § 4)
   ▼  PUT /v3/publish (raw PKR, content-type application/imt-pkr; app=true)
      + POST /v3/tag/{name}/{version}/{staging|production}
[imt-ipm-server]  filesystem registry: data/{type}/{firstLetter}/{name}/{semver}.pkr + meta.json
   │  GET /v3/sync/{type}/{name}/{version}  → PKR binary download
[zone install]  imt-web-api  POST /admin/install/apps/{app}/{fullVersion}
   │  → (if IPM_SERVICE_ACTIVE) imt-ipm-service POST /install/apps/{app}/{version}
   │     → @integromat/ipm `sync`: fetch PKR → unpack → NFS imt_modules/{slug}/v{major}/
   │        (atomic rename, v{major} → v{major.minor.patch} symlink) + {pkg}.tgz + ipm-service/sync-status.json
   │     → per-node local EBS mirror (IMT_LOCAL_ROOT_DIR)
   ▼  imt-web-api UPDATE_DB_PACKAGES task → imt.package_set  (FS manifest → DB metadata mirror)
[runtime resolve]  compiled app → FS require(imt_modules/{slug}/v{N});  SDK app (app# prefix) → DB
```

## 3. `approved`, `compile`, and why `review-changes.js` is 0 for new apps

This is the single most important section for code reviews.

### `approved` is the change-tracking gate (NOT `compile`)

In `imt-web-api`, whether an edit becomes a tracked "change" depends on **`apps.app.approved`**:

- **Non-approved app** (`approved: false`) → every SDK edit writes **directly** to the `apps.*` tables. No `apps.change` row is created. Therefore `app.changes` is **always `[]`** — `review-changes.js` returns 0 no matter how much the developer changed. (Source: `apps.module_set_json` / `apps.app_update` — `if not approved then direct write else change_add`.)
- **Approved app** (`approved: true`) → versionable edits are diverted into `apps.change` rows (the uncommitted delta vs the committed baseline). A DB trigger (`trigger_app_change_guard`) blocks direct writes to versionable columns, forcing them through the change system. `review-changes.js` then shows real `old_value → new_value` diffs.

A brand-new app (`issuetype: "App"`) is almost always `approved: false` / `compile: false` / `ipmDeployedToZone: false` — so its `review-changes.js` is structurally 0.

> **Code-review consequence**: when `review-changes.js` returns 0, read `metadata.json` `approved`. If `approved: false` → **review the full app code** against the AC (the developer's edits are the current full state; there is no diff to show). Do **not** report "nothing to review" or "all committed via SDK." If `approved: true` and 0 → genuinely "No uncommitted changes found." See [code-review.md § 5a](../workflows/code-review.md).

### Commit / compile lifecycle

- `POST /sdk/apps/{slug}/{version}/commit` → `apps.changes_commit`: **requires `approved`**; on the first commit of each field it captures an `'initial state'` baseline into history; applies the pending change values to the real `apps.*` tables; deletes the `apps.change` rows; then calls `enqueueCompile`.
- `POST /admin/sdk/apps/{slug}/{version}/compile` (admin) and the approve action both also call `enqueueCompile`.
- The **Jira** workflow status for "ready for review" is canonically **`Compilation`**; some developers colloquially set **`Commit`** instead. Both mean the same thing and `post-review-transition.js` accepts either.

### `compile` flag is legacy / in-progress signal

The API's `app.compile` is no longer the primary DB boolean — `imt-web-api` overrides it by querying `make-apps-processor` `/info/{app}` (`compile = !info.isFinal`, i.e. "compilation in progress"). The legacy DB `apps.app.compile` column fed an old polling queue (`jobs.apps_to_compile`).

### `compiledName` / `isCompiled`

`apps.app.compiled_name` is set at approval and is the IPM package name (`app_compile` manifest name = `coalesce(compiled_name, name)`). The SDK themes endpoint exposes `isCompiled` per app (`true` once a compiled package exists). `ipmDeployedToZone` is **not** defined in any of the five repos above — it surfaces from the IPME/admin layer and must be read per zone via the admin app endpoint (see SKILL.md visibility notes).

### Module visibility & hiding — `deprecated`/`private` vs SDK `public` (field-verified, IEN-15262)

> Sourced from team knowledge + direct endpoint observation (IEN-15262, TimeCamp v1) — **not** yet cross-checked against the five source repos above. Treat the deploy-side blast radius below as the operational rule; verify in `imt-web-api` before relying on internals.

Two **different** endpoints expose two **different** visibility controls for a module. They are not the same field and do not have the same blast radius:

| Endpoint | Field (per module) | Effect on deploy |
|---|---|---|
| `GET {zone}/api/v2/admin/apps/{slug}` → `app.versions[*].modules[*]` | `deprecated` / `private` | **Soft-hide.** Hidden from the scenario builder for **new** use, but scenarios **already using** the module keep rendering & running. Safe for existing customers. `deprecated: true` is the canonical "sunset / hide" flag. |
| `GET {zone}/api/v2/admin/sdk/apps/{slug}/{version}/modules` → per-module | `public` | **Hard-disable.** `public: false` = module fully disabled (app-owner only). On compile/deploy the module **disappears from `app.versions[*].modules[*]` entirely** and is **removed from every existing scenario that uses it** → those scenarios break. |

**Rule for hiding a module that is already in production use**: set **`deprecated: true`** (or hide via the admin panel). **Never use `public: false`** for that purpose — it is a hard breaking change for existing scenarios, not a soft-hide. `public: false` is only appropriate for modules that were never released to users (owner-only / WIP).

**Why `metadata.json` can mislead about hiding**: `download-app.js` reads the `/admin/apps` (deployed) view, so a module hidden via a *pending, uncompiled* `public: false` still shows `private: false` / `deprecated: false` there. To see the real pending visibility state, query the SDK `/modules` endpoint and read the `public` flag per module. Also note: **relabel-only** changes (appending "(deprecated)" to the module label) do **nothing** to visibility — the flag itself must be set.

## 4. make-apps-processor — DB snapshot → PKR file package

**Input**: `imt-web-api` `enqueueCompile` runs `apps.app_compile` to build an **`AppToCompile`** JSON snapshot and `POST`s it to `make-apps-processor /compile` (JSON, `202`, queued in RabbitMQ). The processor does **not** read the DB itself.

`AppToCompile` top-level fields: `manifest` (app metadata + groups + accounts/triggers/actions UX), `modules[]` (`{name, class, api, flags, epoch}`), `rpcs[]` (`{name, api}`), `accounts[]` (`{name, type, api, install}`), `hooks[]` (`{name, type, api, attach, detach, update}`), `functions[]` (`{name, code}` — **code only, no test.js**), `icon` (base64), `install` (`{spec, directives}`), `flags`, optional `ipmRepo` / `ipmTags`.

> Note: the per-component file split you see in the SDK (`expect.imljson`, `interface.imljson`, `parameters.imljson`, `samples.imljson`, `base`, `common`) does **not** travel as separate files. `imt-web-api` merges them: module runtime → `modules[].api`; module/connection UX → `manifest`; install → top-level `install` + `accounts[].install`. Function `test.js` is **not** sent to the compiler.

**Compile transform** (`make-apps-processor/lib/compiler/compiler.ts#compile()`): builds a virtual Node package tree and `pkr.packSync()` → a single **PKR v2 binary** (magic `pkr` + version byte `2`; not tar/zip). It does: name-prefix rewrite (`ipm.writePrefix`), manifest URI rewrite (`account:app#...`, `rpc://...`), Node class codegen embedding each `api` JSON into a module class, functions → `lib/functions.js` string literals, hook attach/detach/update + module `epoch` → synthetic RPC classes, icon PNG re-encode. It does **NOT** evaluate IML, minify, bundle (webpack), or validate schemas.

**PKR internal layout** (virtual file tree inside the single binary):

```
manifest.json                    # compiled app metadata (UX, actions, expect, …)
package.json                     # { name, main: "lib/app.js", private: true }
install.json                     # if install.spec + install.directives present
lib/app.js                       # module classes (each embeds its api JSON) + module.exports
lib/functions.js                 # module.exports = { fnName: "<code string>", ... }
lib/rpc.js                       # RPCs + hook attach/detach/update + module epoch (if any)
accounts/{name}/lib/account.js   # extends imt_accounts/app-runtime-{type}
accounts/{name}/lib/functions.js
accounts/{name}/package.json     # main → lib/account.js
accounts/{name}/install.json     # if account install present
hooks/{name}/lib/hook.js         # extends imt_hooks/app-runtime-{type}
hooks/{name}/package.json
assets/icon.png                  # re-encoded PNG
assets/color.png                 # optional
```

There is **no** per-module `expect.json` / `interface.json` / `parameters.json` / `samples` / `base` / `common` file in the package — that UX/metadata is folded into `manifest.json`, and the communication `api` blocks are embedded inside the `lib/app.js` classes.

**Handoff**: `PUT {ipm}/v3/publish` with the raw PKR buffer (`content-type: application/imt-pkr; app=true`, `x-imt-token`), skipped if that version already exists on IPM, then `POST {ipm}/v3/tag/{name}/{version}/{tag}` for each tag (default `staging`, `production`). Progress is logged in `apps_processor.compile_history` (`compile_step`: `enqueued → archive → publish → tag:* → finished/failed`).

## 5. imt-ipm-server — the package registry

A **filesystem registry** (content-addressed: no; name + semver: yes). On `PUT /v3/publish` it splits the uploaded monolithic PKR into per-component PKRs (app / account / hook / key) and stores:

```
data/apps/c/clickup/
  1.1.13.pkr
  1.1.14.pkr
  icon.png
  meta.json        # { label, theme, tag: { production:[...], staging:[...], stable:[...] }, iconHash, enabled, unpublished? }
```

- Layout: `data/{componentType}/{firstLetterOfName}/{name}/{semver}.pkr`.
- `meta.json.tag.{env}[]` records **which semver is live per environment** (one version per major series per tag).
- App PKR manifests get auto-generated `dependencies` / `externalDependencies` (regex scan of the code).
- Key download endpoint: `GET /v3/sync/{componentType}/{module}/{version}` → PKR binary (version may be `latest`). Catalog: `GET /v3/sync`. Tagging: `POST /v3/tag/{module}/{version}/{tag}`. Soft-delete: `unpublished` map → `410` on download.
- Required headers: `x-imt-token`, `x-imt-ipm-version`, optional `x-imt-env` (default `production`).

## 6. imt-ipm-service — per-zone install onto the instance

A DaemonSet (one pod per node) that calls the `@integromat/ipm` library in-process (not a subprocess). All IPM operations target **NFS** (`IMT_ROOT_DIR`); each node keeps a **local EBS** mirror (`IMT_LOCAL_ROOT_DIR`).

- Trigger: `POST /internal/install/apps/{app}/{fullVersion}?` → returns `200 {status:'INIT'}` immediately, then async runs `@integromat/ipm sync` which: fetches the PKR from `imt-ipm-server /v3/sync/...`, unpacks to a temp dir, `npm install` + icons, **atomic rename** into `imt_modules/{app}/v{major}/`, installs account/hook/key deps, writes a `{pkg}.tgz` snapshot, and updates `ipm-service/sync-status.json` on NFS (guarded by `ipm-service/.sync.lock`).
- Symlink scheme: `imt_modules/myapp/v2 → v2.13.3/` (the `v{major}` symlink points at the current physical `v{major.minor.patch}` dir; old versions kept).
- NFS → local EBS: `app-transfer.ts` compares `sync-status.json` timestamps and copies `{pkg}.tgz` to the node, extracting into the local `imt_modules`.
- After install, `imt-web-api`'s `UPDATE_DB_PACKAGES` task reads the FS manifests and upserts `imt.package_set` (and `account_set` etc.) — **the DB is a metadata mirror of the filesystem, not the runtime code source for compiled apps.**

Artifacts on a zone after install: `imt_modules/{app}/v{major}/` (unpacked: `manifest.json`, `lib/*.js`, `node_modules/`), companion `imt_accounts/{name}/`, `imt_hooks/{name}/`, `imt_keys/{name}/`, shared `imt_deps/`, plus `ipm-service/sync-status.json` (the install registry).

> `ipmDeployedTozone` is not defined in `imt-ipm-server` / `imt-ipm-service` / `imt-web-api`. "Installed to this zone" is observable via `imt-ipm-service GET /internal/install/apps/{app}/check` and via `imt-web-api packageIsInstalled()` (DB version ↔ FS manifest match).

## 7. Runtime resolution — file package vs DB

The instance loader picks the source by app type (verified in `imt-web-api` workers — the same images run in the zone):

| App type | Manifest source | Runtime JS | DB role |
|---|---|---|---|
| **Compiled / IPM-installed** | `imt_modules/{slug}/v{N}/manifest.json` | `require()` from the FS package (`package.json` main → `lib/app.js`) | metadata cache (`imt.package_set`) |
| **SDK / uncompiled** (internal API `app#` prefix) | `apps.app_get_manifest` (DB) | DB-stored SDK code | source of truth |

- `resolveComponentsRoot()` chooses the filesystem root: if `IPM_SERVICE_ACTIVE` and the local cache is healthy → `IMT_LOCAL_ROOT_DIR` (local EBS), else `IMT_ROOT_DIR` (NFS). Production helm default is `IPM_SERVICE_ACTIVE: false` → direct NFS.
- RPC and connection execution always `require()` from `imt_modules` / `imt_accounts` on the resolved root.
- `imt_modules` = zone instances (master + slaves). `imt_modules_hq` = HQ only (used by `hq_trackman`). "HQ is also a zone" — some config spans both.

## 8. What this means for skill workflows

- **Code review of a new app** (`approved: false`): `review-changes.js` is structurally 0 → do a **full code review** of all SDK components against the AC. Never say "nothing to review." (See [code-review.md § 5a](../workflows/code-review.md) and [code-review-criteria.md](code-review-criteria.md).)
- **Disposition wording**: for an uncompiled app the forward action is **compile**, not commit — ask "Did you compile the app, or return it?" (See code-review.md § "Post-Review Disposition Gate".)
- **`download-app.js` always reads the SDK/DB code**, never the compiled package — so reviews are always against source, which is correct.
- **A committed/compiled app's behavior in production** comes from the installed `imt_modules` package, which is regenerated from the SDK code at compile time. Reviewing the SDK code is therefore reviewing what will be compiled.

## 9. Source map

| Concern | Repo · key files |
|---|---|
| SDK endpoints, `app.changes`, commit/compile, install orchestration | `imt-web-api` · `lib/routers/sdk.js`, `lib/controllers/sdk/apps.js` (`commitChanges`, `setCompile`, `enqueueCompile`), `evoman/schemas/apps/routines/*` (`app_get`, `change_add`, `changes_commit`, `module_set_json`), `lib/controllers/admin/apps.js` (`installApp`), `lib/workers/{rpc,connection}_processor.js`, `lib/helpers/{manifest,utils}.js` (`resolveComponentsRoot`) |
| Compile → PKR | `make-apps-processor` · `lib/controllers/processor.controller.ts`, `lib/types/processor.ts` (`AppToCompile`), `lib/compiler/compiler.ts`, `lib/plugins/ipm/IPMManager.ts`, `test/unit/compiler/compiler.spec.ts` |
| Package registry | `imt-ipm-server` · `lib/controllers/{publish,sync,tag}.js`, `lib/helpers/{pkr_builder,repository}.js`, `README.md` (layout), `AGENTS.md` |
| Per-zone install | `imt-ipm-service` · `lib/controllers/apps.ts`, `lib/services/app-transfer.ts`, `AGENTS-app-components-updating.md`, `openapi/openapi.yaml` |
| Instance structure | `integromat` · `docker-compose.base.yml` (`imt_modules` mounts), `*/imt_configs/ipm-service.json`, `ipm-service/sync-status.json`, `imt_modules/{slug}/v{N}/` sample trees |
