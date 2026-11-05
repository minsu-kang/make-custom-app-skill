# Runtime reference: IML roots and custom IML functions

> Read when: you need to know which IML roots (`parameters`, `connection`, `data`, `metadata`, `webhook`, `payload`, `query`, `depconn`, `organization`, `scenarioModuleId` …) a component's templates can read, or what custom IML function code can see and how it is limited. Part of [runtime-reference.md](../runtime-reference.md).

A `{{...}}` template reads a root: the first name of its path, such as `parameters` in `{{parameters.name}}`. Which roots exist depends on the component Make is running. This part lists them per component and then describes what the code of a custom IML function can see. How a missing value resolves, the built-in variables and the timezone of date functions are in [IML expressions](../runtime-reference.md#iml-expressions). What `environment`, `scenario` and `internal` hold is in [environment-variables.md](environment-variables.md).

## Roots in modules, RPCs and Endpoints

Actions, searches, polling triggers, RPCs and Endpoints can always read these roots:

| Root | What it holds |
|---|---|
| `parameters` | The module's stored parameters merged with the mapped input bundle. The bundle wins on equal keys. The connection and webhook entries are not in it, they have their own roots. |
| `connection` | The data of the connection. In a new-style Endpoint, the Endpoint's connection. |
| `common` | The app's common data. |
| `scenario` | The scenario information Make passes. |
| `environment` | The environment information Make passes, an empty object when it passes none. |
| `data` | The module's stored data, read live at each access. |
| `metadata` | The module's metadata, read live at each access. |
| `webhook` | The data of the attached webhook, when the module has one. |
| `scenarioModuleId` | The id of the module in the scenario. |
| `trigger.matchEqual` | `true` only when the stored epoch type is `select` (see [polling-triggers.md](polling-triggers.md)). |
| `internal` | Make infrastructure data. It exists only when Make has granted it to the app, otherwise the root is empty. |

Other roots appear while the item runs:

| Root | When it exists |
|---|---|
| `temp` | After the first non-empty `temp` or `response.temp` block. It is empty before. |
| `pagination` | `{ page: 1, offset: 0, limit: 20 }` at the start of every request item. See [pagination.md](pagination.md). |
| `body`, `headers`, `statusCode`, `statusMessage` | After a response. `body` is the parsed body. |
| `item`, `iterate.isFirst`, `iterate.isLast`, `iterate.index` | For each element of `response.iterate`. `iterate.index` starts at 0. |
| `iterate.container.first`, `iterate.container.last`, `output` | After the iteration. `item` is gone by then. |
| `agency.connectedSystem.inputs` | With the `agency` directive, see [on-prem-agent.md](on-prem-agent.md). |

There is no `response`, `request` or `url` root, so `{{response.body}}` is empty. Read the answer through `body`, `headers` and `statusCode`.

```json
{
	"response": {
		"iterate": "{{body.items}}",
		"output": { "id": "{{item.id}}", "position": "{{iterate.index}}", "module": "{{scenarioModuleId}}" }
	}
}
```

## Roots in webhook modules, connections and gateway webhooks

**Webhook modules.** These components do not have the full set above:

| Component | Roots |
|---|---|
| Instant trigger (its per-bundle `api`) | `payload` (the incoming webhook bundle), `parameters` (the module's parameters without the connection entry, no bundle merged in), `connection`, `common`, `scenario`, `environment`, `metadata`, `data`, `webhook`, `scenarioModuleId`. There is no `internal` and no `trigger`. |
| Webhook attach RPC | `parameters`, `connection`, `common`, `scenario`, `environment`, `metadata`, `data`, `scenarioModuleId`, and `webhook` holding the whole registered webhook record |
| Webhook update RPC | The same, with `webhook` holding the webhook's data |
| Webhook detach RPC | The same as update, but there is no `data` root |
| Webhook responder | `parameters` (merged with the bundle), `connection`, `common`, `scenario`, `environment`, `metadata`, `data`, `scenarioModuleId` and an empty `temp` |

In these components `environment` is passed as the platform sends it, with no empty-object fallback. See [webhooks.md](webhooks.md) for how each of them runs.

```json
{ "url": "/hooks/{{webhook.id}}", "method": "DELETE" }
```

**Connections.** In a connection file `parameters`, `connection` and `data` all point to the connection's own stored data. Every step also reads `common`, `scenario` and `environment`.

| Connection type | Extra roots |
|---|---|
| Basic | `depconn`: the data of the connection this one depends on, `{}` when there is none |
| OAuth 2 | `organization` (`{}` when there is none) and a `temp` that persists across the steps of the connection. `oauth` exists in `preauthorize` and `authorize` (the redirect URIs and `oauth.scope`, the requested scopes), in `token` and in `refresh` (the redirect URIs only, no `scope`). |
| OAuth 1 | A `temp` that persists across the steps. `oauth` is set by the request-token step, and `authorize` adds `oauth.scope`. The other steps do not set it again, so a later step sees it only when it runs on the same connection object that ran the request-token step, which the runtime does not guarantee. There is no `organization` and no `depconn`. |

The callback step of an OAuth connection adds `query`, `body` and `headers` of the redirect request. When Make sets `environment.oauthRedirectBase`, all three redirect variables (`oauth.redirectUri`, `oauth.localRedirectUri` and `oauth.makeRedirectUri`) become that template, with `{{accountName}}` in it replaced by the connection's name (`app` for the standard OAuth 2 connection, `app-oauth1` for the OAuth 1 one). The variables and the step order are in [oauth-connection-variables.md](oauth-connection-variables.md).

```json
{
	"authorize": {
		"url": "https://provider.example/oauth/authorize",
		"qs": { "redirect_uri": "{{oauth.localRedirectUri}}", "scope": "{{join(oauth.scope; ' ')}}" }
	}
}
```

**Gateway webhooks.** They have no `connection` root.

| Step | Roots |
|---|---|
| Dedicated webhook, parse step | `parameters` and `data` (both the webhook's own data), `common`, `scenario`, `environment`, `body`, `query`, `method`, `rawBody`, `headers` (names are case-insensitive) |
| Shared webhook, parse step | `body`, `query`, `rawBody` and `headers` only |
| Shared webhook, per-account filter | `body`, `query`, `headers`, `environment`, `parameters` and `data` (both that account's webhook data) and `item` |

Connections and gateway webhooks have no `internal` and no `scenarioModuleId`. See [Dedicated webhooks](webhooks.md#dedicated-webhooks) and [Shared webhooks](webhooks.md#shared-webhooks).

## What custom IML functions can see

Custom functions (`api.iml.functions`, written in JavaScript) run in an isolated sandbox. They do not read the roots of a template. The only globals are:

| Global | Value |
|---|---|
| `scenarioModuleId`, `common`, `scenario`, `environment`, `metadata` | The same values as the roots of that name |
| `internal` | The part of the Make infrastructure data that Make granted to the app. Without a grant it is undefined: reading it is not an error. |
| `debug(...)` | Writes to the execution log when the environment's debug mode is on, and does nothing otherwise |
| `Buffer` | A Node-like `Buffer` |

The globals are captured when the module instance first prepares its functions, and reused for the later runs of that instance.

`parameters`, `connection`, `data`, `temp`, `body` and `item` are not globals. Pass what the function needs as arguments:

```json
{ "headers": { "authorization": "Bearer {{signClaims(temp.claims; connection.secret)}}" } }
```

```js
function signClaims(claims, secret) {
	debug('claims', claims);
	return iml.jwt(claims, secret, 'HS256', { expiresIn: 300 });
}
```

Inside a function, these are callable as `iml.<name>(...)`:

- the built-in IML functions (`iml.formatDate`, `iml.upper` and the others), bound to the scenario timezone and to the manifest's null and undefined rule;
- `iml.jwt`, `iml.generateJwtWithKeyId`, `iml.mime` and `iml.toDataStructure`;
- the app's other custom functions.

`cryptoSign`, `errorFactory`, `parseJSON`, `createJSON`, `createXML`, `parseXML`, `safeSerialize`, `getFieldMapping`, `pop`, `shift`, `isArray` and the `parseZapier*` helpers are not available in function code. They exist only in `{{...}}` templates (see [Which function wins a name](../runtime-reference.md#which-function-wins-a-name)).

## Values across the function boundary

Arguments and return values keep their types when they cross into and out of the sandbox, also when nested: strings, numbers, booleans, `null`, BigInt, plain objects and arrays, `Date`, `Buffer` and all typed arrays. A function that returns `undefined` gives `undefined`.

What a function receives for an empty argument depends on the manifest version of the app:

| What the template passes | Manifest 1 | Manifest 2 or higher |
|---|---|---|
| A missing value, as in `{{f(parameters.missing)}}` | `null` | `undefined` |
| An argument left out of the call | `undefined` | `undefined` |

The same rule is in [Missing values](../runtime-reference.md#missing-values).

## Time, memory and errors in custom functions

- Each call may run at most 10,000 ms in production, and 50 ms when the worker runs in development or test mode. A longer call fails with `Function '<name>' finished with error! Script execution timed out.`
- The sandbox has a memory limit of 2048 MB.
- A syntax error in a function shows only when that function is first called, as `Function '<name>' finished with error! ...` followed by the syntax message.
- Depending on how the platform is configured, all modules in a worker can share one sandbox. If the function of any app exhausts the memory, the functions of the other modules are rebuilt and the call is retried once without an error. A function that keeps exhausting the memory itself fails.

The limits are also listed in [Limits](../runtime-reference.md#limits).
