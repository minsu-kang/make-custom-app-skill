# Code review criteria: UX Guideline Compliance

> Read when: the change set has an `expect` / `parameters` change (mandatory). Part of [code-review-criteria.md](../code-review-criteria.md).

## UX Guideline Compliance (Mandatory for expect/parameters changes)

When expect or parameters files are changed, **read `<plugin root>/shared/references/app-ux-best-practices.md` first** and verify:

- **Label capitalization**: Sentence-style by default, but follow the app's existing convention if consistently Title Case
- **Label naming**: 1–3 words, descriptive not instructional, no articles
- **Hint formatting**: Examples in backticks, default values in backticks, links with app name + page name
- **Hint template**: Limit fields must use the standard template from "Templates: Universal Hints"
- **Terminology accuracy**: Labels and option names must match the actual input format (e.g., don't label "JSON" if the format is GraphQL)

Any violation results in verdict **Improvement Needed**.

### ID Select Field Pattern (Do NOT flag as Improvement)

For **Get / Update / Delete** modules, ID select fields with `"mode": "edit"` and a flat `rpc://` (without nested RPCs) are the **correct pattern** — not an improvement opportunity. Users of these modules typically **map** the ID from a previous module's output rather than selecting from a dropdown. Nested RPC cascading (parent → child) adds unnecessary complexity for these module types.

Only flag missing nested RPCs on **Create** modules or modules where the user is expected to configure values from scratch.

See `app-ux-best-practices.md` § "ID Select Fields: `mode: edit` and Nested RPC Usage by Module Type" for details.

### `help` Text Evaluation (for expect/parameters changes)

When `help` properties are added, removed, or modified, evaluate their **actual UX value** — not just their presence:

- **Redundant `help`** (restates the label): Removing these is **cleanup, not UX regression**. Do NOT flag as Improvement Needed.
  - Example: label `"Name"` → help `"Enter the name."` — adds zero value
  - Example: label `"Value"` → help `"Enter the value."` — adds zero value
- **Meaningful `help`** (provides guidance beyond the label): Removing these IS a UX regression. Flag as Improvement Needed.
  - Example: help `"Use ISO 8601 format (e.g., 2024-01-15T10:30:00Z)"` — actual format guidance
  - Example: help `"Comma-separated list of IDs (max 100)"` — constraints and format
- **Missing `help` on complex fields**: When a field requires non-obvious input (format, constraints, examples), suggest adding meaningful `help` as an improvement — but do NOT flag the absence of trivial `help` as an issue.

### `validate.pattern` Behavior (for expect/parameters changes)

Two facts to apply before flagging anything about a field's `validate`; see [parameters-reference/validation.md](../parameters-reference/validation.md) § Where values are checked and § Patterns for the detail:

- **`validate` (including `pattern`) is not UI-only.** Make's value check, shared by the form and the back end, applies `validate` to a resolved value. The platform most likely runs it when the scenario runs (the form code does not show it), and the part of Make that runs the IMLJSON does not check parameters itself ([validation.md § The runtime does not check parameter values](../parameters-reference/validation.md#the-runtime-does-not-check-parameter-values)). So do NOT flag "a mapped value like `{{1.x}}` bypasses `validate.pattern` at runtime" as a Bug on that ground.
- **`validate.pattern` is case-sensitive**: Make compiles it in Unicode mode with no other flag and does not anchor it ([validation.md § Patterns](../parameters-reference/validation.md#patterns)). **DO flag** a lowercase-only pattern used for a security/compliance rule (e.g. a domain deny-list) as a **Bug**: mixed-case input (`https://Facebook.com`) bypasses it, and `^https://` rejects an uppercase `HTTPS://` scheme. Recommend a custom IML function (`toLowerCase()`, then compare), which handles any case for typed and mapped values, with the case written into the pattern as a fail-fast on top ([validation.md § Patterns](../parameters-reference/validation.md#patterns)).

---
