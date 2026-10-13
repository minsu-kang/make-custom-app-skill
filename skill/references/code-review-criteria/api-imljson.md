<!-- Variables: SKILL_ROOT = ~/.claude/skills/make-custom-app (Claude Code) or ~/.cursor/skills/make-custom-app (Cursor); CONTEXTS_DIR = ~/.claude/make-app-contexts or ~/.cursor/make-app-contexts -->
# Code review criteria: Checks for `api.imljson` and connections

> Read when: the change set has an `api`, `base`, `epoch`, webhook `attach` / `detach` or connection change, or a new app (mandatory): component integration tests, runtime behavior verification (including branding consistency), polling trigger order and date filtering. Part of [code-review-criteria.md](../code-review-criteria.md).

### Component Integration Tests (Mandatory for api.imljson changes)

**Before running or writing component tests**, re-read `${SKILL_ROOT}/references/component-test-guide.md` for communications mock structure, `transformOutput()`, and `assert.deepStrictEqual` patterns.

When **any** component's `api.imljson` file is changed in the review (modules, RPCs, connections, webhooks, endpoints), **automatically run `test-component.js`** after `download-app.js` completes:

```
node ${SKILL_ROOT}/scripts/test-component.js <app-slug> <app-version> <component-type> [component-names...]
```

- Determine the component type and name from the changed file path (e.g., `modules/CreateItem/api.imljson` → `module CreateItem`; `endpoints/getDocument/api.imljson` → `endpoint getDocument`)
- Run `test-component.js` for each affected component type
- If tests exist for the changed component (`test.js` in mockup data) → include results in the review under **Component Test**
- If tests **fail** → flag in the review. Distinguish between:
  - **Pre-existing failures** (test was already broken before this change) — note but do not count as a new issue
  - **New failures** (test broke due to this change) — verdict **Bug** or **Breaking Change**
- If tests **pass** → note "Component tests pass" in the review
- If no tests exist for the component → note "No component integration test found" (not a blocking issue)

**Requires**: `make-apps-mockup-path` configured (see `check-setup.js`). If not configured, skip with a note:
> Component integration tests skipped — `make-apps-mockup-path` not configured.

---

## Runtime Behavior Verification (Mandatory for api.imljson changes)

When reviewing `api.imljson` changes that use runtime variables, IML context features, or middleware behavior (e.g., `environment`, `temp`, `condition`, `pagination`, `iterate`, `valid`, `repeat`):

1. **First**: Check `${SKILL_ROOT}/references/runtime-reference.md` (and the part its § Parts table names) for documented behavior
2. **If not found or still uncertain**: Search the `imt-app-runtime` source code directly (path reported by `check-setup.js` as `imt-app-runtime-path`) to verify actual runtime behavior

**Never assume or guess** how runtime features work. Common mistakes to avoid:
- **Flagging explicit body mapping as "sending empty values"** — When `api.imljson` maps params explicitly (e.g., `"name": "{{parameters.name}}"`), unfilled params evaluate to `undefined`, which `JSON.stringify` omits. The `temp` + `_.merge` pattern also skips `undefined` values. Do NOT flag this as a bug. See `runtime-reference.md` § "Undefined parameter handling in temp" for full details.
- **Flagging missing `token.response.data.{field}` save as a `connection.{field}` lookup bug** — Connection-form `parameters.imljson` user inputs are **automatically** exposed under `connection.*` in every context (modules, RPCs, webhooks). The runtime aliases `parameters` and `connection` over the same `account.data` store (`imt-app-runtime/accounts/app-runtime-oauth2/lib/account.js` lines 86–87, plus the OAuth1/Basic equivalents). Do NOT flag a missing explicit save as a bug when the field is already defined in the connection's `parameters.imljson` — `{{connection.fieldName}}` resolves correctly. Explicit `response.data.{field}` save is only needed when the value must be (a) transformed before downstream use (e.g., `customerId: "{{replace(parameters.customerId, '-', '')}}"`), (b) derived from the API response (tokens, expiry, uid from `/userinfo`), or (c) populated for a field NOT present in `parameters.imljson`. See `component-patterns-reference.md` § "Connection Pattern" → "Connection Flow" for the full mechanism.
- Confusing `{{environment.timezone}}` (scenario env, always available) with `flags.environmentAccess` (server-side `process.env`, requires flags) — and both with `{{internal.*}}` (Make-infrastructure data, requires the **admin-granted** `flags.exposeInternalProperties` allowlist). Don't leave a `{{internal.*}}` grant as "unconfirmed, ask admin" — verify the actual grant via `GET /sdk/apps/{slug}/{version}?cols[]=flags` (see `runtime-reference/environment-variables.md` § Make-Infrastructure Data → "Verifying the real grant") before deciding it's a blocker.
- **Assuming `api.endpoint` / `pagination.endpoint` names accept IML templates** — they are static component references since v1.102.3 (PR #713). A template name is used verbatim and fails the lookup; a string `endpoint.connection` is rejected outright. See `runtime-reference/inline-endpoint-calls.md` § "Endpoint references are STATIC".
- **Flagging an Instant Trigger module (type_id 10) for "missing `attached_accounts`" without checking the paired webhook** — an Instant Trigger module has no connection configuration of its own ("There is nothing to configure in this module except the interface. The data processing is handled by a selected webhook." — [Make docs](https://developers.make.com/custom-apps-documentation/app-components/modules/instant-trigger)). Rolling a new connection out to Instant Trigger modules means wiring the **webhook's** `attached_accounts`, not the module's. The module-level field still exists at the SDK-entity level but has no runtime effect unless the module's own (optional) `api.imljson` communication actually reads `{{connection.*}}` — check that file before assuming the module-level binding matters. See `component-patterns-reference/webhook-pattern.md` § "Connection Ownership — Instant Trigger Modules Have None (the Webhook Does)".
- Assuming middleware behavior without checking the actual execution chain
- Misunderstanding pagination stop conditions or trigger epoch mechanics

### Aliased Connections (Mandatory check for connection changes)

Before reviewing any change to `connections/{name}/*.imljson`, open the app's `metadata.json` and check `connections[].aliasTo`.

- **If `aliasTo` is set** → every file in that connection (`api`, `parameters`, `common`, `scope*`, `install*`) is **excluded at compile time**. The runtime uses the connection referenced by `aliasTo` (which may live in a different app).
- **Review implication**: Flag the change as a **runtime no-op**, even if the diff looks syntactically correct. The real fix must go into the source app's connection. A harmless commit can still be verdict "LGTM" but must include this caveat in the Analysis so the developer and QA know the change has no runtime effect on its own.
- **Full behavior documentation**: see `component-patterns-reference/connection-aliased.md` § "Aliased Connections (`aliasTo`)".

### Connection `install` + `installSpec` Verification (Mandatory for OAuth using `common.*`)

When reviewing a connection (especially new apps or new connections), if the connection's `api.imljson` references `common.*` — most commonly `ifempty(parameters.clientId, common.clientId)` / `common.clientSecret` in OAuth2 apps — the connection's `installSpec.imljson` and `install.imljson` **must be non-empty**.

**Checklist:**

1. `rg "common\." connections/{name}/api.imljson` — any hit?
2. If yes → open `connections/{name}/installSpec.imljson` and `connections/{name}/install.imljson`.
3. Both files must define the same `common.*` keys that `api.imljson` references:
   - `installSpec.imljson` declares the admin form (`clientId`, `clientSecret`, etc.)
   - `install.imljson` maps `parameters.*` → `common.*`
4. Empty `[]` / `{}` while `api.imljson` references `common.*` → **BUG**. Flag with verdict "Changes Requested" — without it, the OAuth fallback resolves to empty and any user who hasn't supplied their own credentials gets `invalid_client` from the identity provider.

**Exception**: aliased connections — the source connection owns install/installSpec, so local install files being empty is expected.

**Full pattern + example**: see `component-patterns-reference/connection-oauth.md` § "OAuth2 Connection with Common Fallback".

### OAuth `redirect_uri` Convention (Mandatory check for connection changes)

When reviewing **any** connection (new app, new connection in an existing app, or a touched OAuth1/OAuth2 connection in an existing app), and the upstream API supports OAuth with a `redirect_uri` parameter, the connection's `api.imljson` **must** use `{{oauth.localRedirectUri}}` for both `authorize.qs.redirect_uri` and `token.body.redirect_uri`.

**Why**: `oauth.redirectUri` is the legacy variable that always resolves to `integromat.com` (per `accounts/app-runtime-oauth2/lib/account.js` `get redirects()`). Apps using it break OAuth on self-hosted Make instances and on any future Make-hosted environment that doesn't carry the `integromat.com` redirect alias. `oauth.localRedirectUri` resolves to the running instance's host (Make → `make.com`, self-hosted → that customer's host), so it is the only variant that is portable across deployments.

**Checklist:**

1. `rg "oauth\.redirectUri" connections/{name}/api.imljson` — any hit?
2. If yes, check the `aliasTo` exception first — aliased connections compile no-op, the real fix belongs in the source app's connection (see "Aliased Connections" subsection above).
3. Otherwise, both `authorize.qs.redirect_uri` and `token.body.redirect_uri` should be `{{oauth.localRedirectUri}}`. If only one of the two is migrated, the OAuth provider returns `redirect_uri_mismatch` / `invalid_grant` (RFC 6749 § 4.1.3 — the values must match exactly).
4. `refresh.imljson` / `refresh` block does **not** take `redirect_uri` (refresh-token grant has no callback step). Flag any `redirect_uri` inside `refresh` as a bug regardless of which variable it uses.
5. `oauth.makeRedirectUri` is acceptable only when the upstream provider has a hard `make.com`-only registered redirect AND self-host support is explicitly out of scope. Treat any usage in a new app as Changes Requested unless that justification is documented.

**Verdict mapping:**

- **New app / new connection** with `oauth.redirectUri` → **Changes Requested**.
- **Existing connection edit** that doesn't touch the `redirect_uri` line → not a blocker on its own, but raise as **Improvement** so the developer can migrate while the file is open.
- **Existing connection edit** that explicitly modifies the `redirect_uri` line and still uses `oauth.redirectUri` → **Changes Requested**.
- **Operational reminder to include in the Analysis** (regardless of verdict): when migrating from `oauth.redirectUri` → `oauth.localRedirectUri` on a connection that uses Make-managed common credentials (`installSpec`/`install` populated `common.clientId` / `common.clientSecret`), the new callback URL must also be registered on the upstream OAuth client (e.g. Google Cloud Console). Coordinate with whoever owns that client before flipping the production app.

**Full pattern + variable table**: see `component-patterns-reference/connection-oauth.md` § "OAuth2 Connection — `redirect_uri` Convention" and `security-reference.md` § 2.5.

### Branding Consistency for Apps in an Existing Family (Mandatory for new apps)

When the Jira ticket type is **App** (new app) AND the app slug shares a prefix with other published apps (e.g. `google-ads-*`, `microsoft-*`, `slack-*`, `hubspot-*`), verify the app matches the family's visual identity:

**Checklist:**

1. **Theme color**: Fetch via admin API — `GET /sdk/apps/{slug}/{version}` returns `app.theme` (hex string). Compare with sibling apps in the same family. A value of `#cccccc` means the developer never set it (platform default placeholder) — always flag this on a family-aligned submission.
2. **Logo/icon**: Check that the family's shared logo asset has been uploaded. Icons are typically managed via Admin UI, not code — but the review should still note a missing/default icon as an improvement and point the developer to the family's design asset.
3. **Label/description style**: Sentence casing, product name spelling, and "formerly X" conventions must match the family.

**Example API call** (to verify theme before review):

```
curl -s "$MAKE_ADMIN/sdk/apps/{slug}/{version}" -H "Authorization: Token $KEY" | jq .app.theme
```

**Verdict**: mismatch is usually **Improvement Needed** (not a hard blocker), but for a family of approved apps it's still a required consistency check before LGTM. Flag in the review so the developer can align theme via Admin UI or `PATCH /sdk/apps/{slug}/{version}` with `{ "theme": "#......" }`.

### Runtime Default Error Handling (Do NOT flag as missing)

The `imt-app-runtime` automatically handles common HTTP error codes **without any explicit error directive** in the app's `base.imljson` or module `api.imljson`:

- `429` → `RateLimitError` (auto-retry with backoff)
- `500-599` → `ConnectionError` (auto-retry with backoff)

**Do NOT flag missing 429/5xx error type definitions as an issue.** The runtime already handles these by default. Only flag if:
- The app needs a **custom error message** for 429/5xx (e.g., including `headers.retry-after` in the message)
- The app should override the default type (e.g., treating a specific 5xx as `RuntimeError` instead of `ConnectionError`)

---

## Polling Trigger: Order and Date Filtering

For detailed patterns and examples, see **`${SKILL_ROOT}/references/polling-trigger-guide.md`**.

When reviewing a polling trigger, verify these in order:

**Step 1: Verify `trigger.order` matches actual API response order**
- Check the API documentation for how the endpoint orders results by default
- If a sort parameter is used in `qs`, verify it matches `trigger.order`
- **Mismatch between `trigger.order` and actual response order is a bug**

**Step 2: Check date filtering support (for `order: "unordered"` or `"asc"`)**
- If the API supports date filtering but it's not used → **Improvement Needed**
- If neither sorting nor date filtering is available → acceptable, note the 3200 limit caveat

**Quick checklist:**
- [ ] `trigger.order` matches actual response ordering
- [ ] Date filter uses `{{data.lastDate || undefined}}` (not `{{data.lastDate}}`)
- [ ] Epoch uses `desc` ordering (even when api uses `asc`)
- [ ] If API supports sorting + filtering → `order: "asc"` is preferred over `"desc"`
- [ ] API request `qs`/`body` page size is **hardcoded** (not `{{parameters.limit}}`) — `parameters.limit` belongs only in `response.limit`
- [ ] If `api.imljson` temp keys changed, `epoch.imljson` `iterate` references the correct (final pipeline) key
