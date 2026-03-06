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

Both methods install skill files to `~/.cursor/skills/make-custom-app/` and rule files to `~/.cursor/rules/`.

After installation, **restart Cursor**. The skill activates automatically when you ask about Make custom apps or open IMLJSON files.

## Repository Structure

```
make-custom-app-skill/
├── README.md
├── install.sh                         # Installer (macOS/Linux)
├── install.ps1                        # Installer (Windows)
├── skill/                              # → installed to ~/.cursor/skills/make-custom-app/
│   ├── SKILL.md                        #   Main skill instructions
│   └── references/                     #   Reference documents
│       ├── builtin-iml-functions.md    #   IML function reference
│       ├── communication-reference.md  #   Communication (API) spec
│       ├── parameters-reference.md     #   Parameters, Interface, RPC patterns
│       ├── component-patterns-reference.md  #  Base, Connection, Error, Webhook, Trigger, Responder
│       ├── custom-functions-reference.md    #  Custom IML function conventions
│       ├── developer-notes-templates.md     #  Developer Notes templates
│       ├── app-ux-best-practices.md    #   App UX best practices
│       ├── examples.md                 #   Instagram app examples
│       └── runtime-reference.md        #   imt-app-runtime internals
├── scripts/                            # → installed to ~/.cursor/skills/make-custom-app/scripts/
│   ├── download-app.js                 #   App source code downloader
│   ├── update-app.js                   #   Push code changes to Make via SDK API
│   ├── review-changes.js               #   Code review change fetcher
│   ├── create-component.js             #   Create new components (module, rpc, function, connection, webhook)
│   ├── update-component.js             #   Update component metadata (label, description, connection)
│   └── delete-component.js             #   Delete components (with public/private app check)
└── rules/                              # → installed to ~/.cursor/rules/
    ├── make-app-code-review.mdc        #   Code review input requirements
    ├── make-app-auto-actions.mdc       #   Mandatory auto-actions (context, sync, tickets)
    └── version-sync.mdc               #   Version & changelog sync rule
```

### Skill vs Rules

| | Skill (`skill/`) | Rules (`rules/`) |
|---|---|---|
| **Install path** | `~/.cursor/skills/make-custom-app/` | `~/.cursor/rules/` |
| **When loaded** | On-demand (when Make app work is detected) | Always active |
| **Purpose** | Detailed workflows, domain knowledge, scripts | Short behavioral rules |
| **Size** | Large (SKILL.md + reference docs + scripts) | Small (< 50 lines per rule) |

## What Gets Installed

### Skill Files (`skill/` → `~/.cursor/skills/make-custom-app/`)

| File | Description |
|------|-------------|
| `SKILL.md` | Main skill — IMLJSON patterns, app context management, code review workflow |
| `references/builtin-iml-functions.md` | All built-in IML functions + runtime extras (jwt, cryptoSign, errorFactory) |
| `references/communication-reference.md` | Full `api.imljson` spec — pagination, iterate, output, temp, RPC, file upload/download |
| `references/parameters-reference.md` | Parameters, Interface, RPC Dynamic Options, Conditional RPCs, nested inheritance |
| `references/component-patterns-reference.md` | Base, Connection, Error Handling, Webhook, Trigger, Responder patterns |
| `references/custom-functions-reference.md` | Custom IML function code conventions, test.js requirements, size limits |
| `references/developer-notes-templates.md` | Developer Notes templates for Bug Fix and Feature tickets |
| `references/app-ux-best-practices.md` | App UX best practices — naming, hints, fields, messages, patterns |
| `references/examples.md` | Real-world Instagram for Business app examples |
| `references/runtime-reference.md` | `imt-app-runtime` internals — middleware chain, execution flow, limits, edge cases |

### Script Files (`scripts/` → `~/.cursor/skills/make-custom-app/scripts/`)

| File | Description |
|------|-------------|
| `download-app.js` | Downloads full app source code from Make API |
| `update-app.js` | Pushes code changes directly to Make via SDK Admin API |
| `review-changes.js` | Fetches uncommitted changes for code review |
| `create-component.js` | Creates new components (module, rpc, function, connection, webhook) via POST |
| `update-component.js` | Updates component metadata (label, description, connection, etc.) via PATCH |
| `delete-component.js` | Deletes components via DELETE (public apps: rpc/function only) |

### Rule Files (`~/.cursor/rules/`)

| File | Description |
|------|-------------|
| `make-app-code-review.mdc` | Enforces required inputs (app-slug, version) and recommends Jira ticket attachment for code reviews. Guides Atlassian MCP setup if needed. |
| `make-app-auto-actions.mdc` | Enforces mandatory actions: context file update, Pinecone sync, related ticket lookup, test code, version check, code download/sync first, external terminal, fresh fetch before review. |
| `version-sync.mdc` | Ensures `version.json` and `skill/SKILL.md` frontmatter versions stay in sync before commits. |

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
