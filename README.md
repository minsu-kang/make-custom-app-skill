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
curl -fsSL https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install.sh | bash
```

**Option 2: Clone & install**

```bash
git clone https://github.com/minsu-kang/make-custom-app-skill.git
cd make-custom-app-skill
./install.sh
```

#### Windows (PowerShell)

**Option 1: One-liner**

```powershell
irm https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install.ps1 | iex
```

**Option 2: Clone & install**

```powershell
git clone https://github.com/minsu-kang/make-custom-app-skill.git
cd make-custom-app-skill
.\install.ps1
```

> **Note:** If you get an execution policy error, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` first.

Both methods install skill files to `~/.cursor/skills/make-custom-app/` and rule files to `~/.cursor/rules/make-custom-app/`. The installer also removes deprecated rule files from earlier releases (`make-app-auto-actions.mdc` and `make-app-code-review.mdc`, replaced in 1.12.0 by the split `make-app-workflow.mdc` + `make-app-todo-*.mdc` rules and the `skill/workflows/code-review.md` workflow) and prunes the legacy stop hook from `~/.cursor/hooks/` + `~/.cursor/hooks.json`.

After installation, **restart Cursor**. The skill activates automatically when you ask about Make custom apps or open IMLJSON files.

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

Skill files to `~/.cursor/skills/make-custom-app/` and rule files to `~/.cursor/rules/make-custom-app/` (see tables below — the file inventory is identical for both editors).

### Claude Code

| Target | Location |
|--------|----------|
| Skill files | `~/.claude/skills/make-custom-app/` |
| Rule files | `~/.claude/skills/make-custom-app/rules/` |
| Agent definition | `~/.claude/agents/make-integration-engineer.md` |
| MCP server | `~/.claude/skills/make-custom-app/mcp-server/` |
| MCP registration | `~/.claude/claude.json` (key: `make-custom-app`) |
| Routing note | appended to `~/.claude/CLAUDE.md` |

The routing note tells the Claude Code orchestrator to delegate any Make app work to the `make-integration-engineer` sub-agent automatically — no manual invocation needed.

### Skill Files (`skill/` → `~/.cursor/skills/make-custom-app/` or `~/.claude/skills/make-custom-app/`)

| File | Description |
|------|-------------|
| `SKILL.md` | Core domain knowledge (IMLJSON, module types, IML expressions) + workflow routing table |
| **Workflows** | |
| `workflows/app-context.md` | App detection, code download/sync, context file management |
| `workflows/code-review.md` | Fetch uncommitted changes, review against criteria, generate report |
| `workflows/bug-investigation.md` | Root cause analysis, reproduce, fix, verify, developer notes |
| `workflows/feature-request.md` | Design, create new components, implement, test, push |
| `workflows/app-task.md` | UX updates, refactoring, metadata changes, deprecation, cleanup |
| `workflows/pinecone-sync.md` | Auto-sync context to shared Pinecone vector DB |
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

### Script Files (`skill/scripts/` → `…/make-custom-app/scripts/`)

| File | Description |
|------|-------------|
| `download-app.js` | Downloads full app source code from Make API |
| `update-app.js` | Pushes code changes directly to Make via SDK Admin API |
| `review-changes.js` | Fetches uncommitted changes for code review |
| `create-component.js` | Creates new components (module, rpc, function, connection, webhook) via POST |
| `update-component.js` | Updates component metadata (label, description, connection, etc.) via PATCH |
| `delete-component.js` | Deletes components via DELETE (public apps: rpc/function only) |
| `test-function.js` | Runs custom IML function tests (code.js + test.js) using `@integromat/iml`. Default timezone: UTC. Use `--tz=` to override. |
| `test-component.js` | Runs component integration tests (module, RPC, connection, webhook) via `make-apps-mockup` framework. Supports `--format=json` for AI agent output. |
| `download-jira-ticket-attachment.js` | Downloads Jira ticket attachments (images, videos) for agent analysis. Requires `jira-email` and `jira-api-token` in SKILL.md. |

### Rule Files (`~/.cursor/rules/make-custom-app/` or `~/.claude/skills/make-custom-app/rules/`)

Split per concern so each file stays short, focused, and is loaded only when relevant:

| File | When loaded | Description |
|------|-------------|-------------|
| `make-app-workflow.mdc` | always | Pre / During / After Work checklist — runtime path check, version check, code sync, auto-execute scripts, Jira attachments, UX reads, IML function tests, runtime reference, post-work context update. |
| `make-app-todo-rules.mdc` | always | Static TODO discipline — 9 universal rules (verbatim creation, no add / merge / split / reorder, single `in_progress`, `[GATE]` discipline, `[CANCELLED: <reason>]` prefix, no template swap), Common Pre/Post blocks shared by every template, and the template selection matrix. |
| `make-app-todo-bugfix.mdc` | on bug work | § B Bugfix template (17 items). |
| `make-app-todo-feature.mdc` | on new component / app | § N New / Feature Implementation template (18 items). |
| `make-app-todo-task.mdc` | on refactor / metadata / UX | § T App Task template (16 items). |
| `make-app-todo-review.mdc` | on code review | § R Code Review template (15 items). The full review process — inputs, Atlassian MCP check, Jira-driven flow, output format, Developer Message, post-review disposition gate, re-review, no-Jira fallback — lives in `skill/workflows/code-review.md` (loaded together by the agent). |
| `work-discipline.mdc` | always | Systematic work habits — full impact analysis, no piecemeal fixes, changed files tracking, AC scope discipline, context degradation management, proactive reference re-read. |

## Repository Structure

```
make-custom-app-skill/
├── README.md
├── install.sh                         # Cursor installer (macOS/Linux)
├── install.ps1                        # Cursor installer (Windows)
├── install-claude.sh                  # Claude Code installer (macOS/Linux)
├── install-claude.ps1                 # Claude Code installer (Windows)
├── subagents/
│   └── make-integration-engineer.md  # Claude Code sub-agent definition
├── skill/                              # → installed to skills/make-custom-app/
│   ├── SKILL.md                        #   Core domain knowledge + workflow routing
│   ├── workflows/                      #   Workflow instructions (trigger-based)
│   │   ├── app-context.md
│   │   ├── code-review.md
│   │   ├── bug-investigation.md
│   │   ├── feature-request.md
│   │   ├── app-task.md
│   │   └── pinecone-sync.md
│   ├── references/                     #   Reference documents (on-demand)
│   └── scripts/                        #   Automation scripts
├── rules/                              # → installed to rules/make-custom-app/
│   ├── make-app-workflow.mdc
│   ├── make-app-todo-rules.mdc
│   ├── make-app-todo-bugfix.mdc
│   ├── make-app-todo-feature.mdc
│   ├── make-app-todo-task.mdc
│   ├── make-app-todo-review.mdc
│   └── work-discipline.mdc
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
| **Purpose** | Domain knowledge, workflows, reference docs, scripts | Behavioral directives referencing detailed docs |
| **Size** | Large (SKILL.md + workflows + references + scripts) | Concise (~100-180 lines per rule) |

## The `make-integration-engineer` Sub-Agent (Claude Code)

When you install for Claude Code, the installer deploys a sub-agent definition to `~/.claude/agents/make-integration-engineer.md`. The orchestrator (your global `~/.claude/CLAUDE.md`) automatically delegates any Make app work to this agent — you do not invoke it explicitly.

**What it is:** A Claude Code sub-agent pre-loaded with the full Make domain skill (SKILL.md + all workflow and rule files). It behaves as a Make Senior Integration Engineer with knowledge of IMLJSON, IML, runtime internals, and the full SDK.

**How invocation works:** The routing note appended to `~/.claude/CLAUDE.md` instructs the orchestrator: *"For any Make.com custom app work — building, debugging, reviewing, or managing Make integrations — delegate to the `make-integration-engineer` sub-agent."* The orchestrator routes matching requests automatically.

**Tools available to the agent:**

| Tool group | Tools |
|------------|-------|
| File system | `Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep` |
| Web | `WebFetch`, `WebSearch` |
| Atlassian MCP | `getJiraIssue`, `editJiraIssue`, `searchJiraIssuesUsingJql`, `createJiraIssue`, `getAccessibleAtlassianResources` |
| Make MCP (Pinecone) | `upsert_app_context`, `search_app_knowledge`, `get_app_summary`, `list_apps`, `upsert_jira_ticket` |

## First Use

On first use, the agent will guide you to:

1. **Clone `imt-app-runtime`** via GitHub Desktop — needed for runtime reference
2. **Download app source code** — when you ask about a specific app, the agent will prompt you to run a download command in an external terminal

## Usage Examples

Just ask naturally:

- *"Create an Action module that calls the /users endpoint"*
- *"How does pagination work for cursor-based APIs?"*
- *"Add error handling for 429 rate limits"*
- *"Set up an OAuth2 connection"*
- *"Review my code changes — slug: slack, version: 4"*
- *"What does the Instagram app's base.imljson look like?"*
