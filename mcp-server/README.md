# Make App Context MCP Server

MCP (Model Context Protocol) server that enables the team to share Make app context via a Pinecone vector DB. Each team member runs the server locally, and all data is stored in a shared Pinecone index.

## Architecture

```
[Cursor A] → [Local MCP Server] ─┐
[Cursor B] → [Local MCP Server] ─┼→ [Pinecone Index (shared)]
[Cursor C] → [Local MCP Server] ─┘
                                    ↕
                              [OpenAI Embeddings API]
```

## Tools

| Tool | Description |
|------|-------------|
| `upsert_app_context` | Read local `.md` summary + `metadata.json` and upsert to Pinecone |
| `search_app_knowledge` | Semantic search across all shared app contexts |
| `get_app_summary` | Retrieve full context of a specific app from Pinecone |
| `list_apps` | List all apps stored in the shared vector DB |
| `upsert_jira_ticket` | Store a Jira ticket (bugfix/feature/review) linked to an app |

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- Pinecone account + index (dimension: 1536, metric: cosine)
- OpenAI API key

## Setup

### As part of the make-custom-app plugin

The plugin starts the server from `mcp/index.mjs` at the plugin root, a bundle built from this source. Nothing to install or build. Give it the keys in one of two ways; the environment wins:

| Setting | Environment variable | Line in `~/.make-custom-app-skill-secrets` |
|---|---|---|
| Pinecone API key | `MAKE_APP_CONTEXT_PINECONE_API_KEY` | `pinecone-api-key: <value>` |
| Pinecone index (default `make-app-contexts`) | `MAKE_APP_CONTEXT_PINECONE_INDEX` | `pinecone-index-name: <value>` |
| OpenAI API key | `MAKE_APP_CONTEXT_OPENAI_API_KEY` | `openai-api-key: <value>` |

The setup wizard of the plugin writes the secrets-file lines. App contexts are read from `~/.make-custom-app/contexts`. The generic names `PINECONE_API_KEY`, `OPENAI_API_KEY` and `PINECONE_INDEX_NAME` are not read, so unrelated keys in your shell are never picked up.

### In an old 2.x install

The 2.x installers copy this source to `~/.claude/skills/make-custom-app/mcp-server` (or the `~/.cursor` twin), build it there, and register it with the keys from `.env` under the generic names `PINECONE_API_KEY`, `OPENAI_API_KEY` and `PINECONE_INDEX_NAME`. A server started from such a path keeps those names and reads contexts from `~/.claude/make-app-contexts` or `~/.cursor/make-app-contexts`, as the 2.x scripts write them. The path rule is `isLegacyInstall` in `lib/config.ts`.

### Manual setup (development)

1. Install dependencies:

```bash
npm install
```

2. Build:

```bash
npm run build
```

3. Add to Cursor MCP settings (Settings → MCP):

```json
{
  "make-app-context": {
    "command": "node",
    "args": ["/path/to/mcp-server/dist/index.js"],
    "env": {
      "MAKE_APP_CONTEXT_PINECONE_API_KEY": "your-pinecone-api-key",
      "MAKE_APP_CONTEXT_OPENAI_API_KEY": "your-openai-api-key",
      "MAKE_APP_CONTEXT_PINECONE_INDEX": "make-app-contexts"
    }
  }
}
```

4. Restart Cursor.

A server started from a clone of this repository, registered by hand or by `npm run register`, is read as the plugin: it needs the `MAKE_APP_CONTEXT_*` names above or the secrets-file lines, and it ignores the generic names. Only a server under `.../skills/make-custom-app/mcp-server/`, which the 2.x installers create, keeps the generic names. `.env` and `.env.example` are read only by the 2.x installers and `register.js`.

## Development

```bash
npm install        # install dependencies
npm run build      # compile TypeScript → dist/
npm start          # run the server (stdio transport)
npm test           # unit tests
node ../tools/build-mcp.js          # rebuild ../mcp/index.mjs, the bundle the plugin runs
node ../tools/build-mcp.js --check  # fail when the committed bundle is stale (CI)
```

Commit the rebuilt `../mcp/index.mjs` with every change to this source: the plugin cache holds the bundle, not the source.

## Project Structure

```
mcp-server/
├── index.ts              # MCP server entry point
├── lib/
│   ├── pinecone.ts       # Pinecone client + helpers
│   ├── config.ts         # where the server runs from, and its keys (environment, secrets file)
│   ├── embeddings.ts     # OpenAI embedding generation
│   └── chunker.ts        # .md section parser + metadata summarizer
├── tools/
│   ├── upsert.ts         # upsert_app_context
│   ├── search.ts         # search_app_knowledge
│   ├── get-summary.ts    # get_app_summary
│   ├── list-apps.ts      # list_apps
│   └── upsert-jira.ts    # upsert_jira_ticket
├── dist/                 # compiled JS output (gitignored)
├── package.json
├── tsconfig.json
├── .prettierrc
├── .editorconfig
├── .env.example
└── .env                  # actual API keys (gitignored)
```
