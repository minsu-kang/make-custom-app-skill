# Make Custom App Skill for Cursor and Claude Code

An AI skill that helps you build and edit [Make.com](https://www.make.com/) custom apps using IMLJSON — directly inside [Cursor](https://cursor.sh/) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Works with the **Make Apps SDK** VS Code/Cursor extension. The agent understands Make's IMLJSON format, module types, connections, RPCs, webhooks, pagination, error handling, and runtime internals.

## What It Does

- **Write IMLJSON code** — modules (Action, Search, Trigger, Instant Trigger, Responder, Universal), connections (OAuth2, API Key, Basic), RPCs, webhooks, custom IML functions
- **Auto-manage app context** — downloads and caches full app source code per app, persists across sessions
- **Code review with Jira integration** — reviews uncommitted changes against Jira ticket acceptance criteria via Atlassian MCP
- **Reference runtime internals** — knows the middleware chain, pagination logic, limits, error types, and edge cases from `imt-app-runtime`
- **Provide real-world examples** — includes Instagram for Business (v5) as a complete reference app

## Prerequisites

### Cursor

- [Cursor](https://cursor.sh/) installed
- [Make Apps SDK](https://marketplace.visualstudio.com/items?itemName=Integromat.apps-sdk) extension installed and configured (API key + environment)
- Node.js (for the app download script)
- *(Optional)* Pinecone API key + OpenAI API key — required for the shared app context MCP server (team-wide Pinecone vector DB)
- *(Optional)* [Atlassian MCP Server](https://www.npmjs.com/package/@anthropic/atlassian-mcp-server) configured in Cursor — enables automatic Jira ticket fetching during code reviews

### Claude Code

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed
- Node.js (for the MCP server and app scripts)
- [Make Apps SDK](https://marketplace.visualstudio.com/items?itemName=Integromat.apps-sdk) extension installed and configured (API key + environment)
- *(Optional)* Pinecone API key + OpenAI API key — required for the shared app context MCP server (team-wide Pinecone vector DB)
- *(Optional)* Atlassian MCP Server configured — enables Jira ticket fetching during code reviews

## Installation

### Cursor

#### macOS / Linux

**Option 1: One-liner**

```bash
curl -fsSL https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install-cursor.sh | bash
```

**Option 2: Clone & install**

```bash
git clone https://github.com/minsu-kang/make-custom-app-skill.git
cd make-custom-app-skill
./install-cursor.sh
```

#### Windows (PowerShell)

**Option 1: One-liner**

```powershell
irm https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install-cursor.ps1 | iex
```

**Option 2: Clone & install**

```powershell
git clone https://github.com/minsu-kang/make-custom-app-skill.git
cd make-custom-app-skill
.\install-cursor.ps1
```

> **Note:** If you get an execution policy error, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` first.

Both methods install skill files to `~/.cursor/skills/make-custom-app/` and one trigger rule to `~/.cursor/rules/make-custom-app/`. The one-liner downloads the repository archive once and copies `skill/`, `rules/`, and `mcp-server/` wholesale — there is no per-file list to keep in sync. Scripts under `skill/scripts/` auto-detect the editor at runtime via `process.argv[1]`, so the same files resolve to either `~/.cursor/...` or `~/.claude/...` paths without modification. The installer also removes rule files from 1.x releases and prunes the legacy stop hook from `~/.cursor/hooks/` + `~/.cursor/hooks.json`.

After installation, **restart Cursor**, then run `node ~/.cursor/skills/make-custom-app/scripts/check-setup.js` to see what is still missing (`imt-app-runtime` path, Jira credentials, MCP server). User config lives in `~/.make-custom-app-skill-secrets` (one `key: value` per line, mode 600) — never inside the skill directory, so API keys are never loaded into the agent's context. Installs older than 2.0 kept these lines at the tail of `SKILL.md`; the installer moves them automatically. The skill activates automatically when you ask about Make custom apps or open IMLJSON files.

### Claude Code

#### macOS / Linux

**Option 1: One-liner**

```bash
curl -fsSL https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install-claude.sh | bash
```

**Option 2: Clone & install**

```bash
git clone https://github.com/minsu-kang/make-custom-app-skill.git
cd make-custom-app-skill
./install-claude.sh
```

Re-run with `--update` to overwrite skill files while preserving your config, or `--force` for a clean reinstall:

```bash
./install-claude.sh --update
./install-claude.sh --force
```

#### Windows (PowerShell)

**Option 1: One-liner**

```powershell
irm https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install-claude.ps1 | iex
```

**Option 2: Clone & install**

```powershell
git clone https://github.com/minsu-kang/make-custom-app-skill.git
cd make-custom-app-skill
.\install-claude.ps1
```

Use `-Mode update` or `-Mode force` for the equivalent update/clean-install behaviour.

The installer places files under `~/.claude/` and **does not touch your Cursor installation**. After installation, **restart Claude Code**. The skill activates automatically when you ask about Make custom apps.

## What Gets Installed

### Cursor

Skill files to `~/.cursor/skills/make-custom-app/` and the trigger rule to `~/.cursor/rules/make-custom-app/make-custom-app.mdc` (see tables below — the skill inventory is identical for both editors).

### Claude Code

| Target | Location |
|--------|----------|
| Skill files | `~/.claude/skills/make-custom-app/` |
| Agent definition | `~/.claude/agents/make-integration-engineer.md` |
| MCP server | `~/.claude/skills/make-custom-app/mcp-server/` |
| MCP registration | `~/.claude/claude.json` (key: `make-custom-app`) |
| Routing note | appended to `~/.claude/CLAUDE.md` |

The routing note tells the Claude Code orchestrator to delegate any Make app work to the `make-integration-engineer` sub-agent automatically — no manual invocation needed.

> **Editor-aware paths:** Markdown workflow and reference files use `${SKILL_ROOT}` and `${CONTEXTS_DIR}` placeholders that resolve to either the `~/.cursor/...` or `~/.claude/...` tree depending on which editor invokes them. Node scripts share the same auto-detection through `skill/scripts/lib/skill-root.js`.

### Skill Files (`skill/` → `~/.cursor/skills/make-custom-app/` or `~/.claude/skills/make-custom-app/`)

| File | Description |
|------|-------------|
| `SKILL.md` | ≤ 9 KB always-loaded contract: first action (`check-setup.js`), workflow routing, hard rules, component/module tables, reference index |
| **Workflows** | |
| `workflows/lifecycle.md` | Shared skeleton for every task — app identification, code sync, context load, Jira fetch, write-script confirmation, close-out (Dev Notes, context file, Pinecone) |
| `workflows/code-review.md` | Review-specific: reviewer assignment, `approved`-state interpretation, skip rules #1–#5, runtime/vendor-doc gates, output format, disposition gate |
| `workflows/bug-investigation.md` | Root cause analysis, reproduce, fix, verify, developer notes |
| `workflows/feature-request.md` | Design, create new components, implement, test, push |
| `workflows/app-task.md` | UX updates, refactoring, metadata changes, deprecation, cleanup |
| `workflows/task-refinement.md` | Read `Preparation`-status Jira ticket, evaluate feasibility, draft implementation plan, optionally create `Investigation` subtask |
| `workflows/create-endpoint.md` | Create or update SDK Endpoints (Arbitrary Call or regular) |
| **References** | |
| `references/builtin-iml-functions.md` | All built-in IML functions + runtime extras (jwt, cryptoSign, errorFactory) |
| `references/communication-reference.md` | Full `api.imljson` spec — pagination, iterate, output, temp, RPC, file upload/download |
| `references/parameters-reference.md` | Parameters, Interface, RPC Dynamic Options, Conditional RPCs, nested inheritance |
| `references/component-patterns-reference.md` | Base, Connection, Error Handling, Webhook, Trigger, Responder patterns |
| `references/custom-functions-reference.md` | Custom IML function code conventions, test.js requirements, size limits |
| `references/developer-notes-templates.md` | Developer Notes templates for Bug Fix and Feature tickets |
| `references/app-ux-best-practices.md` | App UX best practices — naming, hints, fields, messages, patterns |
| `references/polling-trigger-guide.md` | Polling trigger implementation — order selection, date filtering, epoch, examples |
| `references/examples.md` | Real-world Instagram for Business app examples |
| `references/runtime-reference.md` | `imt-app-runtime` internals — middleware chain, execution flow, limits, edge cases |
| `references/component-test-guide.md` | Component integration tests — `make-apps-mockup` architecture, test.js structure, debugging |
| `references/code-review-criteria.md` | Detailed review criteria — ES6+, code quality, test coverage, UX, runtime verification |
| `references/security-reference.md` | Security checklist — credentials, OAuth flow, webhook signature, SSRF, injection, data exposure (cited as `[SECURITY][1.2]`) |
| `references/code-smells-reference.md` | Quantitative quality thresholds (function length, complexity) + IMLJSON-specific smells (cited as `[QUALITY][A-01]`) |
| `references/app-compilation-and-deployment-reference.md` | How SDK/DB code becomes a compiled PKR file package — compile pipeline, IPM registry, per-zone install, runtime resolution, and why `review-changes` is 0 for non-approved apps |
| `references/component-scaffold-templates.md` | Default SDK component scaffolds (from the `model` app) — match a change's `old_value` against these to detect new components (then skip the old→new diff + Breaking Changes) |
| `references/endpoints-reference.md` | SDK Endpoints (Endpoints RFC) — entity structure, admin API surface, Forman input/output schemas, `context.md`, annotations, runtime validation caveats, review guidance |

### Script Files (`skill/scripts/` → `…/make-custom-app/scripts/`)

| File | Description |
|------|-------------|
| `check-setup.js` | One-screen setup diagnosis — skill version, `imt-app-runtime-path`, Make API credentials, mockup path, Jira credentials, MCP server. Exit 1 when a required item is missing; prints the fix. Run once per conversation (the skill's first action). |
| `download-app.js` | Downloads full app source code from Make API |
| `update-app.js` | Pushes code changes directly to Make via SDK Admin API |
| `review-changes.js` | Fetches uncommitted changes for code review |
| `commit-changes.js` | Commits pending changes (`commit`), discards them (`rollback --confirm`), or enqueues a compile (`compile`). `--issue=KEY` chains the Jira transition. |
| `create-component.js` | Creates new components (module, rpc, function, connection, webhook) via POST |
| `update-component.js` | Updates component metadata (label, description, connection, etc.) via PATCH |
| `delete-component.js` | Deletes components via DELETE (public apps: rpc/function only) |
| `test-function.js` | Runs custom IML function tests (code.js + test.js) using `@integromat/iml`. Default timezone: UTC. Use `--tz=` to override. |
| `test-component.js` | Runs component integration tests (module, RPC, connection, webhook) via `make-apps-mockup` framework. Supports `--format=json` for AI agent output. |
| `download-jira-ticket-attachment.js` | Downloads Jira ticket attachments (images, videos) for agent analysis. Requires `jira-email` and `jira-api-token` in `~/.make-custom-app-skill-secrets`. |
| `post-review-transition.js` | Transitions a Jira ticket after a code review is concluded (e.g. move to QA on commit, back to In Progress on changes-requested). |
| `lib/skill-root.js` | Shared utility — derives the skill root and editor dot-dir (`.cursor` / `.claude`) from `process.argv[1]`. Used by all scripts so they work identically under both editors. |
| `lib/settings.js` | Shared settings loader — reads `~/.make-custom-app-skill-secrets` (paths, Make/Jira credentials; legacy SKILL.md tail as fallback) and Cursor `settings.json`. |
| `lib/version-guard.js` | Shared version guard — enforces the SKILL.md version check in code. Runs at the top of **every** entry script; on an outdated install it auto-runs the installer `--update` and blocks work until the skill is current (fail-open on network errors, cached hourly). |

### Rule File (`rules/` → `~/.cursor/rules/make-custom-app/`, Cursor only)

| File | When loaded | Description |
|------|-------------|-------------|
| `make-custom-app.mdc` | always (~600 bytes) | Trigger only: when the conversation involves a Make app, IMLJSON, the SDK, `make-app-contexts`, or an IEN app ticket, load the `make-custom-app` skill first. All behavioural rules live in `SKILL.md` § Hard rules and the workflows, so nothing else is loaded globally. |

Claude Code does not install a rule file — the `make-integration-engineer` sub-agent calls `Skill('make-custom-app')` as its first action.

## Repository Structure

```
make-custom-app-skill/
├── README.md
├── install-cursor.sh                  # Cursor installer (macOS/Linux)
├── install-cursor.ps1                 # Cursor installer (Windows)
├── install-claude.sh                  # Claude Code installer (macOS/Linux)
├── install-claude.ps1                 # Claude Code installer (Windows)
├── subagents/
│   └── make-integration-engineer.md  # Claude Code sub-agent definition
├── skill/                              # → installed to skills/make-custom-app/
│   ├── SKILL.md                        #   Core domain knowledge + workflow routing
│   ├── workflows/                      #   Workflow instructions (trigger-based)
│   │   ├── lifecycle.md                #     Shared skeleton, read first
│   │   ├── code-review.md
│   │   ├── bug-investigation.md
│   │   ├── feature-request.md
│   │   ├── app-task.md
│   │   ├── task-refinement.md
│   │   └── create-endpoint.md
│   ├── references/                     #   Reference documents (on-demand)
│   └── scripts/                        #   Automation scripts (editor auto-detected)
│       ├── check-setup.js              #     Setup diagnosis (first action)
│       └── lib/skill-root.js           #     Shared skill-root + editor-dir resolver
├── rules/                              # → installed to ~/.cursor/rules/make-custom-app/ (Cursor only)
│   └── make-custom-app.mdc             #   Trigger rule (~600 bytes)
└── mcp-server/                         # → installed to skills/make-custom-app/mcp-server/
    ├── index.ts                        #   MCP server entry point
    ├── lib/                            #   Pinecone + embeddings helpers
    └── tools/                          #   MCP tool implementations
```

### Skill vs Rules (Cursor)

| | Skill (`skill/`) | Rules (`rules/`) |
|---|---|---|
| **Install path** | `~/.cursor/skills/make-custom-app/` | `~/.cursor/rules/make-custom-app/` |
| **When loaded** | On-demand (when Make app work is detected) | Always active |
| **Purpose** | Operating contract (SKILL.md), workflows, reference docs, scripts | Trigger: load the skill |
| **Size** | SKILL.md ≤ 9 KB always; workflows/references on demand | ~600 bytes |

## The `make-integration-engineer` Sub-Agent (Claude Code)

When you install for Claude Code, the installer deploys a sub-agent definition to `~/.claude/agents/make-integration-engineer.md`. The orchestrator (your global `~/.claude/CLAUDE.md`) automatically delegates any Make app work to this agent — you do not invoke it explicitly.

**What it is:** A thin Claude Code sub-agent whose first action is `Skill('make-custom-app')`. `SKILL.md` is its operating contract; it persists knowledge only through the app context files and the Pinecone MCP tools.

**How invocation works:** The routing note appended to `~/.claude/CLAUDE.md` instructs the orchestrator: *"For any Make.com custom app work — building, debugging, reviewing, or managing Make integrations — delegate to the `make-integration-engineer` sub-agent."* The orchestrator routes matching requests automatically.

**Tools available to the agent:**

| Tool group | Tools |
|------------|-------|
| File system | `Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep` |
| Web | `WebFetch`, `WebSearch` |
| Atlassian MCP | `getJiraIssue`, `editJiraIssue`, `searchJiraIssuesUsingJql`, `createJiraIssue`, `getAccessibleAtlassianResources` |
| Make MCP (Pinecone) | `upsert_app_context`, `search_app_knowledge`, `get_app_summary`, `list_apps`, `upsert_jira_ticket` |

## First Use

The agent's first action in every conversation is `scripts/check-setup.js`. If anything required is missing it prints the exact fix and stops — typically:

1. **Clone `imt-app-runtime`** (Make internal repo) and add `imt-app-runtime-path: /path/to/clone` to `~/.make-custom-app-skill-secrets`
2. **Claude Code only:** add `make-api-key: <token>` to the same file

App source code is downloaded automatically (`download-app.js`) when you ask about a specific app.

## Usage Examples

Just ask naturally:

- *"Create an Action module that calls the /users endpoint"*
- *"How does pagination work for cursor-based APIs?"*
- *"Add error handling for 429 rate limits"*
- *"Set up an OAuth2 connection"*
- *"Review my code changes — slug: slack, version: 4"*
- *"What does the Instagram app's base.imljson look like?"*
