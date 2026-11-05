# Runtime reference: environment, environmentAccess and internal

> Read when: an app reads `{{environment.*}}`, `{{environment.system.*}}` (the `environmentAccess` app flag) or `{{internal.*}}` (the admin-granted `exposeInternalProperties` flag), or you must check which flags the platform really grants. Part of [runtime-reference.md](../runtime-reference.md).

## Three separate features

Three roots look related and are not. Do not confuse them.

| Root | What it holds | Flag needed |
|---|---|---|
| `{{environment.*}}` | Information about the run that Make passes: timezone, debug mode and so on | None |
| `{{environment.system.NAME}}` | Server environment variables that the app flag `environmentAccess` lists | `environmentAccess`, an app flag |
| `{{internal.*}}` | Make infrastructure data: team identity, internal service addresses | `exposeInternalProperties`, an app flag that a Make admin grants |

`environment.system` sits inside `environment` but is not part of what Make passes. It exists only when the app has the flag. `{{environment.timezone}}` has nothing to do with it. `internal` is not an `environment` feature either, even though it is listed next to one.

## Scenario environment (environment)

`environment` describes the run. Make fills it, and it is always available: no flag is needed. Make decides what it contains, so the full list of fields cannot be derived from the runtime. The runtime reads only the fields in the table below.

What a component gets when Make passes nothing differs:

- Actions, searches, polling triggers, RPCs and Endpoints get an empty object (`{}`).
- Webhook modules (instant triggers with an `api`, webhook attach, update and detach, the responder), connections and gateway webhooks get the value exactly as Make sent it, with no fallback.
- The request-parsing step of a shared webhook has no `environment` at all.

The fields the runtime reads:

| Field | What the runtime does with it |
|---|---|
| `timezone` | The scenario timezone (Make takes it from the organization settings). Date functions use it when no timezone argument is passed. The dates of a date trigger are parsed in it too (see [polling-triggers.md](polling-triggers.md)) |
| `debug`, `verifier` | Turn on debug logging. `debug()` in custom IML function code writes only when `debug` is on; `verifier` alone is not enough |
| `audit` | Turns on audit events (see [response.data, response.metadata and audit](../runtime-reference.md#responsedata-responsemetadata-and-audit)) |
| `host`, `redirects`, `oauthRedirectBase` | Build the OAuth redirect URIs (see [Redirect URIs and the oauth variable](oauth-connection-variables.md#redirect-uris-and-the-oauth-variable)) |
| `currentDate` | The clock of OAuth connections, which sets the 15-minute life of an authorization |
| `brand.title` | The name in the default User-Agent header (see [http-requests.md](http-requests.md)) |
| the agent-service address | Where the on-premise agent is reached (see [on-prem-agent.md](on-prem-agent.md)) |
| `record` | Turns on recording of the run's requests for replay, when its value is `true` |

Usage example in `api.imljson`:

```json
{
	"temp": {
		"tz": "{{environment.timezone}}"
	}
}
```

The timezone works differently in custom IML functions and in templates:

- **Custom IML functions.** Their `iml.formatDate`, `iml.parseDate` and the other built-in date functions use `environment.timezone` of the module instance automatically. When Make sends no timezone, they have none and fall back to UTC. They also follow the manifest's null and undefined rule: undefined values pass through only when the app's manifest version is 2 or higher (see [Missing values](../runtime-reference.md#missing-values)).
- **`{{...}}` templates.** The timezone is taken the first time a given expression text is parsed in that worker. A later scenario in another timezone that evaluates the identical text can get the first timezone. Pass the timezone argument explicitly to date functions in templates. See [Timezone in templates](../runtime-reference.md#timezone-in-templates).

## Server variables (environmentAccess)

`environmentAccess` is an app flag, not common data: Make reads it from the app's flags, where `allowISC` and `localAccess` also live, and never from `common.imljson`. An app author cannot set a flag from the IMLJSON, so listing `environmentAccess` in the common data does nothing. Make sets the flag on the app.

The flag is an array of variable names. Make requires the names to be listed one by one, because exposing the whole environment at once would be a security risk.

```json
{ "headers": { "x-region": "{{environment.system.MY_REGION}}" } }
```

With the app flag `{"environmentAccess": ["MY_REGION"]}`, `{{environment.system.MY_REGION}}` returns the environment variable `MY_REGION` of the worker that runs the component.

- Values are read live, at each access.
- Only the listed names exist. An unlisted name is empty, the same as any missing value (see [Missing values](../runtime-reference.md#missing-values)).
- The object is read-only and hidden from enumeration, and it serialises to nothing when output as a whole: a JSON body key set to `{{environment.system}}` is left out.
- `[]` gives an `environment.system` with no names, so every name is empty.
- A value that is not an array makes every component of the app fail with `Variables for the Environment Access should always be enumerated as an array of strings.` This holds for `true`, a string, an object or a number. A false value (`false`, `null`, `0`, `""`) switches the feature off without an error, and `environment.system` then does not exist.
- It is unrelated to `{{environment.timezone}}`, which comes from the scenario environment.

## Make infrastructure data (internal)

`internal` holds Make infrastructure data: the team identity and the addresses of internal services (ISC service URNs). Make generates it when it finalises the scenario and hands it to each module run already frozen, but it does not reach an app's templates by default.

The app flag `exposeInternalProperties` decides what an app can read. It is admin-granted: a Make admin sets it per app, and an app developer cannot grant it to themselves. It is a real trust boundary for internal Make apps. Make keeps the catalog of the properties that `internal` can hold; it is not reproduced here.

| Aspect | Behavior |
|---|---|
| Grant | The flag `exposeInternalProperties`, admin-granted. With no grant `{{internal}}` is `undefined`. |
| Must be enumerated | Always an array of property paths. Dot paths work (`'service.trigger'`), and a whole key grants everything under it (`'service'`). Strings, numbers, booleans and `null` values all project. A path that the data does not contain adds nothing. |
| Malformed grant | A value that is not an array (for example `true`, a grant of everything) is refused: Make writes an error to the server log (`App <package name> has app flag 'exposeInternalProperties' that is not an array: <value>`), exposes nothing, and the execution keeps running. Compare `environmentAccess`, which fails the component. |
| Empty grant | `[]` makes `{{internal}}` an empty object (`{}`), not `undefined`. |
| Make sent nothing | When the platform sends no internal data (an older scenario), the projection is an empty object. It is never an error. |
| Freeze | The projection is frozen at the top level only. Known limitation: when dot paths are granted, the intermediate objects of the projection are not frozen, so an app can add properties to them. |
| Where it exists | `{{internal}}` is a root in action, search, polling trigger, RPC and Endpoint templates. It is not a root in webhook-module, connection or gateway-webhook templates. |
| Custom IML functions | A function sandbox has the same projection as the global `internal`, like `environment`. It is reachable from templates and from function code. Without a grant it is undefined, and reading it is not an error. |

Usage in `api.imljson` once granted:

```json
{
	"temp": {
		"triggerUrn": "{{internal.service.trigger.urn}}",
		"teamId": "{{internal.team.id}}"
	}
}
```

**Code-review notes.**

- Treat any `flags.exposeInternalProperties` addition as a permission change, not a code change. It needs admin approval, so confirm the ticket records it.
- Flag a boolean or other non-array grant. Make degrades it to no access and writes only a server log, so the app appears broken with no error that the app can see.
- Flag `{{internal.*}}` reads with no matching grant path for the same reason: they resolve to nothing instead of failing loudly.

## Checking the real grant

**Verify the real grant before flagging a read as "unconfirmed".** Do not leave a `{{internal.*}}` or `{{internal}}` read as a "needs discussion, please confirm with the admin" note when the actual grant is one API call away. The app's current `flags`, including `exposeInternalProperties`, are readable with the configured Make API key. The helper of the skill scripts, `requireMode()`, loads the key and the API base and never prints them (never read the secrets file yourself). This call prints only the flags:

```bash
node -e '
const { requireMode } = require("<plugin root>/shared/scripts/lib/mode.js");
const { baseUrl, auth } = requireMode();
fetch(`${baseUrl}/sdk/apps/{slug}/{version}?cols[]=flags`, { headers: { Authorization: auth } })
  .then(async (r) => console.log(r.ok ? JSON.stringify((await r.json()).app.flags ?? {}, null, 2) : `HTTP ${r.status}`));
'
# { "exposeInternalProperties": ["organization"], ... }
```

It uses the same API base as the skill scripts: the admin API in employee mode and the public API in public mode. `requireMode()` picks the editor from the environment of the shell that runs it, checks the Make API token on its zone (in employee mode also the `@make.com` Jira account), and stops with the fix when it cannot tell the editor or a check fails.

Then apply the whole-key rule from the table above:

- A change that reads `internal.organization.customApps.x` is **already covered** when the grant array contains `"organization"` (the whole key). No new permission is needed and it is not a blocker.
- It is **uncovered**, and only then a real "needs admin grant" blocker, when the existing grant is scoped to a narrower or different dot path (for example `"organization.someOtherField"`) that does not include the property being read.
- Report "could not verify, please confirm with the admin" only when this API call itself fails (for example the configured key has no admin scope). Never use it as a default when the call was simply not made.

## Quick reference

| What you need | IML expression | Flag needed? |
|---|---|---|
| Scenario timezone | `{{environment.timezone}}` | No |
| Scenario debug mode | `{{environment.debug}}` | No |
| Server env var `FOO` | `{{environment.system.FOO}}` | Yes: the app flag `environmentAccess: ["FOO"]`, set by Make |
| Team id / ISC service URNs | `{{internal.service.trigger.urn}}` | Yes: the app flag `exposeInternalProperties: ["service.trigger"]`, **admin-granted** |
