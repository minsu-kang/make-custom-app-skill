# Push changes

> Read when: the work reaches the first push, or creates or deletes a component. Write scripts need the user's confirmation (hard rule 4).

Show what will change (component path + diff or summary) and wait for an explicit yes. Then:

```
Shell: node "<plugin root>/shared/scripts/update-app.js" {slug} {version} {component-path} {local-file}
required_permissions: ["all"], block_until_ms: 30000
```

| Component path | Sections |
|---|---|
| `module/{name}/{section}` | `api`, `parameters`, `expect`, `interface`, `samples`, `scope` |
| `connection/{name}/{section}` | `api`, `common`, `scopes`, `scope`, `parameters` |
| `rpc/{name}/{section}` | `api`, `parameters` |
| `webhook/{name}/{section}` | `api`, `parameters`, `attach`, `detach` |
| `function/{name}/{section}` | `code`, `test` |
| `endpoint/{name}/{section}` | `api`, `input_parameters`, `output_parameters`, `scope`, `context` (`.md`) and `annotations` (`.json`, a complete hint object) — both PATCH metadata |
| `base` · `common` · `groups` | app-level files |

Component lifecycle (same confirmation rule; positional args, `--force` is the only flag):

- Create: `create-component.js {slug} {ver} module {name} {label} {type_id} [connection] [description]` · `rpc {name} {label} [connection]` · `function {name}` · `connection {label} {auth-type}` · `webhook {label} {webhook-type} [connection]` · `endpoint {name} {label} [connection] [description] [initMode]`. `type_id`: see Module types in [index.md](../index.md). `webhook-type`: `web`, `web-shared`. `initMode`: `example` (default), `blank`.
- Update metadata: `update-component.js {slug} {ver} {type} {name} key=value [key=value…]`, e.g. `label="New Label"`.
- Delete: `delete-component.js {slug} {ver} {type} {name} --force`. Irreversible: run it only after the user's explicit approval. The Bash tool has no TTY, so without `--force` it exits 1 without deleting.
- **Scripts first, MCP second.** Read the local copy ([lifecycle.md](lifecycle.md) §2) and change components with these scripts. Use the custom-app tools of this plugin's Make MCP server only for what no script does yet, with the same confirmation rule. Not connected: say so and ask the user to do it in the SDK UI.

On an **approved** app, pushes land as uncommitted change rows; on a non-approved app they write directly and `compile` is what the user or reviewer runs next. Dev work ends at the push: `commit|compile` only on an explicit user instruction, never as a proposed next step (hard rule 4). Commit, compile, and rollback are in [commit-compile.md](commit-compile.md).
