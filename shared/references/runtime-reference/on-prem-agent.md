# Runtime reference: the on-premise agent (agency)

> Read when: an app uses the `agency` directive to reach a customer system through Make's on-premise agent. Part of [runtime-reference.md](../runtime-reference.md).

The `agency` directive routes a call through Make's on-premise agent, a service that runs next to a customer's own system, so the module can reach a system that Make's cloud cannot call directly. Make enables this per customer: it provides the agent service, its credentials and the connected-system id that the connection carries. An app author writes the directive but cannot turn the feature on from the IMLJSON.

The directive has the form `agency: { action, payload }` and works on actions, searches, triggers, RPCs, Endpoints, instant triggers and webhook attach, update and detach.

## Connected-system inputs

Make checks the directive before it does anything else. Each failure is a RuntimeError:

| Problem | Message |
|---|---|
| `action` is not literally `execute` or `inputs` (the value is not evaluated as IML) | `Invalid agency configuration. Unsupported action type.` |
| `action` is `execute` and there is no `payload` | `Invalid agency configuration. Execute payload not defined.` |
| The connection carries no connected-system id | `Invalid agency configuration. No connected system defined.` |

Then, before the module's own request, Make fetches the inputs of the connected system from the agent service (its address comes from the platform's configuration, and the protocol is http unless that configuration says otherwise). It authenticates with a service token that is valid for 120 seconds and sends the organization id of the scenario as the team. The call has the `timeout` of the `api`, or 40,000 ms when there is none. The result is available as `{{agency.connectedSystem.inputs}}` for the rest of the item.

If the fetch fails, the module fails with a RuntimeError:

- `Failed to get connected system inputs. Status code: <n>` when the agent service answers with a status of 400 or more.
- `Failed to get connected system inputs. <reason>` when it does not answer (a refused connection, a timeout and so on).
- `Missing INTEGROMAT_AGENCY_JWT_SECRET environment variable. Agency authentication headers cannot be generated. Agency feature is not available.` on a worker that has no agency secret.

Only the first of these three is marked as a platform error.

The fetch is exempt from both security checks: it is not checked against `urlPermissions`, and the private-address check does not apply to it. It does not lift the address check for later requests either.

```json
{
	"agency": { "action": "inputs" },
	"response": { "output": { "inputs": "{{agency.connectedSystem.inputs}}" } }
}
```

## Execute requests and side effects

**`action: execute`.** The module's own request is replaced by a POST to the agent service's task endpoint for the connected system. The body is the IML-evaluated `payload` as JSON. The agent's reply goes through the normal response directives (`{{body}}`, `response.output` and the rest).

```json
{
	"agency": {
		"action": "execute",
		"payload": {
			"connectorType": "http",
			"body": { "url": "http://intranet.local/api", "method": "GET", "body": { "inputs": "{{agency.connectedSystem.inputs}}" } }
		}
	},
	"response": { "output": "{{body}}" }
}
```

**`action: inputs`.** No second request is made. `{{body}}`, `{{headers}}` and `{{statusCode}}` stay empty, the response directives still run, and a `url` next to it is never requested.

Side effects and limits:

- After an `execute` request, private and local addresses stay reachable for the rest of that run, so later requests of the same run (the next `communication` items, pagination) are not blocked from them either. See [Private and local addresses](../runtime-reference.md#private-and-local-addresses).
- `urlPermissions` is checked against the agent service's URL of an `execute` request, so a list that does not allow it blocks the call. See [urlPermissions](../runtime-reference.md#urlpermissions).
- All request headers are masked in the logs automatically, and the debug log shows the URL of an `execute` request as `agency://execute`.
- Combining `agency` with `endpoint` fails with InvalidConfigurationError `Cannot use the 'endpoint' and 'agency' directives together.` The inputs have already been fetched when this error comes. See [inline-endpoint-calls.md](inline-endpoint-calls.md).
- Pagination does not work over an agency request. What happens depends on the configuration. Without a `url` next to `agency`, a `pagination` block is ignored and the module makes one request. With a `url` and a `pagination.agency` block, the module fails after the first round with RuntimeError `Cannot read properties of undefined (reading 'payload')`. With a `url` and a plain `pagination` block, the later rounds do not go through the agent on the default HTTP client: Make sends the same JSON payload as an ordinary POST to the module's own `url` (the older HTTP client repeats the `execute` call through the agent instead). With `action: inputs`, a `url` and a `pagination` block, the module fetches the inputs again and again, with no request count or record limit to stop it, until the platform stops the run. Do not combine `pagination` with `agency`.
