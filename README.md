# Make Custom App Skill for Cursor

An AI skill that helps you build and edit [Make.com](https://www.make.com/) custom apps using IMLJSON — directly inside [Cursor](https://cursor.sh/).

Works with the **Make Apps SDK** VS Code/Cursor extension. The agent understands Make's IMLJSON format, module types, connections, RPCs, webhooks, pagination, error handling, and runtime internals.

## What It Does

- **Write IMLJSON code** — modules (Action, Search, Trigger, Instant Trigger, Responder, Universal), connections (OAuth2, API Key, Basic), RPCs, webhooks, custom IML functions
- **Auto-manage app context** — downloads and caches full app source code per app, persists across Cursor sessions
- **Code review with Jira integration** — reviews uncommitted changes against Jira ticket acceptance criteria via Atlassian MCP
- **Reference runtime internals** — knows the middleware chain, pagination logic, limits, error types, and edge cases from `imt-app-runtime`
- **Provide real-world examples** — includes Instagram for Business (v5) as a complete reference app

## Prerequisites

- [Cursor](https://cursor.sh/) installed
- [Make Apps SDK](https://marketplace.visualstudio.com/items?itemName=Integromat.apps-sdk) extension installed and configured (API key + environment)
- Node.js (for the app download script)
- *(Optional)* [Atlassian MCP Server](https://www.npmjs.com/package/@anthropic/atlassian-mcp-server) configured in Cursor — enables automatic Jira ticket fetching during code reviews

## Installation

### macOS / Linux

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

### Windows (PowerShell)

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

Both methods install skill files to `~/.cursor/skills/make-custom-app/` and rule files to `~/.cursor/rules/make-custom-app/`.

After installation, **restart Cursor**. The skill activates automatically when you ask about Make custom apps or open IMLJSON files.

## Repository Structure

```
make-custom-app-skill/
├── README.md
├── install.sh                         # Installer (macOS/Linux)
├── install.ps1                        # Installer (Windows)
├── skill/                              # → installed to ~/.cursor/skills/make-custom-app/
│   ├── SKILL.md                        #   Core domain knowledge + workflow routing
│   ├── workflows/                      #   Workflow instructions (trigger-based)
│   │   ├── app-context.md              #   App detection, code download/sync, context management
│   │   ├── code-review.md             #   Fetch changes, review, generate report
│   │   ├── bug-investigation.md       #   Root cause analysis, fix, verify
│   │   ├── feature-request.md         #   Design, create, implement new components
│   │   ├── app-task.md                #   UX fixes, refactoring, metadata changes
│   │   └── pinecone-sync.md           #   Auto-sync context to shared Pinecone DB
│   └── references/                     #   Reference documents (on-demand)
│       ├── builtin-iml-functions.md    #   IML function reference
│       ├── communication-reference.md  #   Communication (API) spec
│       ├── parameters-reference.md     #   Parameters, Interface, RPC patterns
│       ├── component-patterns-reference.md  #  Base, Connection, Error, Webhook, Trigger, Responder
│       ├── custom-functions-reference.md    #  Custom IML function conventions
│       ├── developer-notes-templates.md     #  Developer Notes templates
│       ├── app-ux-best-practices.md    #   App UX best practices
│       ├── polling-trigger-guide.md   #   Polling trigger implementation guide
│       ├── component-test-guide.md    #   Component integration test guide (make-apps-mockup)
│       ├── code-review-criteria.md    #   Detailed review criteria (ES6+, code quality, tests, UX)
│       ├── security-reference.md      #   Security checklist (credentials, OAuth, webhook, SSRF, injection)
│       ├── code-smells-reference.md   #   Quality thresholds + IMLJSON-specific code smells
│       ├── examples.md                 #   Instagram app examples
│       └── runtime-reference.md        #   imt-app-runtime internals
│   └── scripts/                        #   Automation scripts
│       ├── download-app.js             #   App source code downloader
│       ├── update-app.js               #   Push code changes to Make via SDK API
│       ├── review-changes.js           #   Code review change fetcher
│       ├── create-component.js         #   Create new components (module, rpc, function, connection, webhook)
│       ├── update-component.js         #   Update component metadata (label, description, connection)
│       ├── delete-component.js         #   Delete components (with public/private app check)
│       ├── test-function.js           #   IML function test runner
│       ├── test-component.js          #   Component integration test runner (module, RPC, connection, webhook)
│       └── download-jira-ticket-attachment.js  #   Jira attachment downloader
└── rules/                              # → installed to ~/.cursor/rules/make-custom-app/
    ├── make-app-code-review.mdc        #   Code review input requirements & output format
    ├── make-app-auto-actions.mdc       #   Mandatory auto-actions (context, sync, tickets, UX)
    └── work-discipline.mdc            #   Systematic work habits & anti-hallucination
```

### Skill vs Rules

| | Skill (`skill/`) | Rules (`rules/`) |
|---|---|---|
| **Install path** | `~/.cursor/skills/make-custom-app/` | `~/.cursor/rules/make-custom-app/` |
| **When loaded** | On-demand (when Make app work is detected) | Always active |
| **Purpose** | Domain knowledge, workflows, reference docs, scripts | Behavioral directives referencing detailed docs |
| **Size** | Large (SKILL.md + workflows + references + scripts) | Concise (~100-180 lines per rule) |

## What Gets Installed

### Skill Files (`skill/` → `~/.cursor/skills/make-custom-app/`)

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

### Script Files (`skill/scripts/` → `~/.cursor/skills/make-custom-app/scripts/`)

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

### Rule Files (`~/.cursor/rules/make-custom-app/`)

| File | Description |
|------|-------------|
| `make-app-code-review.mdc` | Code review requirements: input validation, Jira-driven process, output format, developer message, post-review actions. References `code-review-criteria.md` for detailed criteria. |
| `make-app-auto-actions.mdc` | Mandatory auto-actions: version check, code download/sync, test execution, UX reference, runtime verification, context update, Pinecone sync, developer notes. |
| `work-discipline.mdc` | Systematic work habits: full impact analysis, no piecemeal fixes, changed files tracking, AC scope discipline, context degradation management, proactive reference re-read. |

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
