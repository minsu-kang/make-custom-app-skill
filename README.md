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

### Option 1: One-liner

```bash
curl -fsSL https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install.sh | bash
```

### Option 2: Clone & install

```bash
git clone https://github.com/minsu-kang/make-custom-app-skill.git
cd make-custom-app-skill
./install.sh
```

Both methods install skill files to `~/.cursor/skills/make-custom-app/` and rule files to `~/.cursor/rules/`.

After installation, **restart Cursor**. The skill activates automatically when you ask about Make custom apps or open IMLJSON files.

## Repository Structure

```
make-custom-app-skill/
├── README.md
├── install.sh
├── skill/                              # → installed to ~/.cursor/skills/make-custom-app/
│   ├── SKILL.md                        #   Main skill instructions
│   ├── download-app.js                 #   App source code downloader
│   ├── review-changes.js               #   Code review change fetcher
│   ├── builtin-iml-functions.md        #   IML function reference
│   ├── communication-reference.md      #   Communication (API) spec
│   ├── examples.md                     #   Instagram app examples
│   └── runtime-reference.md            #   imt-app-runtime internals
└── rules/                              # → installed to ~/.cursor/rules/
    └── make-app-code-review.mdc        #   Code review input requirements
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
| `download-app.js` | Downloads full app source code from Make API |
| `review-changes.js` | Fetches uncommitted changes for code review |
| `builtin-iml-functions.md` | All built-in IML functions + runtime extras (jwt, cryptoSign, errorFactory) |
| `communication-reference.md` | Full `api.imljson` spec — pagination, iterate, output, temp, RPC, file upload/download |
| `examples.md` | Real-world Instagram for Business app examples |
| `runtime-reference.md` | `imt-app-runtime` internals — middleware chain, execution flow, limits, edge cases |

### Rule Files (`~/.cursor/rules/`)

| File | Description |
|------|-------------|
| `make-app-code-review.mdc` | Enforces required inputs (app-slug, version) and recommends Jira ticket attachment for code reviews. Guides Atlassian MCP setup if needed. |
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
