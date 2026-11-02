# Component patterns: Webhook Pattern

> Read when: writing or reviewing a webhook or an Instant Trigger module: attach/detach, verification, shared webhooks, connection ownership. Part of [component-patterns-reference.md](../component-patterns-reference.md).

## Webhook Pattern

Webhooks enable **Instant Trigger** modules to receive real-time events. The webhook `api.imljson` defines how to process incoming webhook payloads.

**Note**: `webhooks/*/api.imljson` is **not merged with `base.imljson`**. Webhook payload processing is standalone — **every** field in base (not just `baseUrl` / `headers` / `response.error` / `log.sanitize`, but any key at all) is ignored for the webhook context.

### Webhook api.imljson

```json
{
	"output": "{{item}}",
	"iterate": "{{body.events}}",
	"condition": "{{body.type == 'event'}}",
	"respond": {
		"status": 200,
		"type": "json",
		"body": { "status": "ok" }
	}
}
```

### Key Fields

| Field       | Purpose                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- |
| `output`    | Data to output from the webhook. Use `{{item}}` when iterating, `{{body}}` for single event. |
| `iterate`   | Array of events in the payload to iterate over. Produces one bundle per item.                |
| `condition` | Only process the payload if this evaluates to true. Use to filter ping/heartbeat events.     |
| `respond`   | HTTP response sent back to the webhook sender. Most APIs require 200 OK acknowledgment.      |

### Verification / Challenge Pattern

Many APIs (Slack, Zoom, etc.) send a verification challenge when registering the webhook. Handle it with the `verification` block:

```json
{
	"output": "{{item}}",
	"iterate": "{{body.events}}",
	"respond": {
		"status": 200,
		"type": "json",
		"body": { "status": "ok" }
	},
	"verification": {
		"condition": "{{body.challenge}}",
		"respond": {
			"status": 200,
			"type": "json",
			"body": { "challenge": "{{body.challenge}}" }
		}
	}
}
```

The `verification` block is checked **first**. If `verification.condition` is true, the verification response is sent and normal processing is skipped.

### Attach / Detach

When the external API requires explicit webhook registration/unregistration:

```json
// attach.imljson — called when user enables the webhook
{
	"url": "/webhooks",
	"method": "POST",
	"body": {
		"url": "{{webhook.url}}",
		"events": ["item.created", "item.updated"]
	},
	"response": {
		"data": {
			"webhookId": "{{body.id}}"
		}
	}
}
```

```json
// detach.imljson — called when user disables the webhook
{
	"url": "/webhooks/{{webhook.webhookId}}",
	"method": "DELETE"
}
```

| Variable                | Description                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `{{webhook.url}}`       | The unique Make-generated URL for this webhook instance.                            |
| `{{webhook.webhookId}}` | Value saved in `attach`'s `response.data`. Available in `detach` and `api.imljson`. |

### Shared Webhooks

When one webhook URL is shared across multiple Instant Trigger modules (e.g., different event types), configure it at the app level. Each module filters events via its `condition`.

### Connection Ownership — Instant Trigger Modules Have None (the Webhook Does)

**An Instant Trigger module (type_id 10) has no connection configuration of its own.** Per Make's official docs ([Instant trigger (webhook)](https://developers.make.com/custom-apps-documentation/app-components/modules/instant-trigger)): _"There is nothing to configure in this module except the interface. The data processing is handled by a selected webhook."_ The user does not pick a connection on the module — they pick (or create) a **webhook**, and the webhook is what holds the connection (via its `account_name` / `attached_accounts`, and the connection selected when the webhook instance is configured/attached in the scenario).

- **Rolling out a new connection to Instant Trigger modules** means wiring it onto the **webhook(s)** those modules are linked to (`webhook/{name}/account_name` + `webhook/{name}/attached_accounts`) — not onto the module.
- The module entity's own `account_name` / `attached_accounts` fields still exist at the SDK/admin-API level (e.g. visible via `GET /sdk/apps/{slug}/{version}/modules`) and `create-component.js module ... [connection]` will happily accept a value for type_id 10, but **they have no runtime effect unless the module's own optional `api.imljson` communication block actually references `{{connection.*}}`** (see the "Communication is optional" callout below). A module with an empty `api.imljson` (`{}`) — the common case — never reads that field at all. Do not treat that module-level field as the thing that exposes a connection to the end user; it doesn't, for a typeId-10 module with no communication of its own.
- **Communication is optional on Instant Trigger** and, per the same docs, may only perform a single non-paginated, non-iterating additional request (e.g. to enrich the webhook payload). *Only* in that case does the module's own `{{connection.*}}` matter, and only then does the module-level `account_name`/`attached_accounts` binding become functionally relevant — check the module's `api.imljson` before assuming it does.
- **Code-review consequence**: when a ticket rolls a new connection out to Instant Trigger modules, check the **webhook's** `attached_accounts`, not the module's — that is where the AC is actually satisfied (or not). Flagging a typeId-10 module for "missing `attached_accounts`" without first checking (a) whether its `api.imljson` is empty and (b) whether the paired webhook is already wired is a false positive.
