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

1. Install dependencies:

```bash
npm install
```

2. Build:

```bash
npm run build
```

3. Copy `.env.example` to `.env` and fill in your API keys:

```bash
cp .env.example .env
```

4. Add to Cursor MCP settings (Settings → MCP):

```json
{
  "make-app-context": {
    "command": "node",
    "args": ["/path/to/mcp-server/dist/index.js"],
    "env": {
      "PINECONE_API_KEY": "your-pinecone-api-key",
      "OPENAI_API_KEY": "your-openai-api-key",
      "PINECONE_INDEX_NAME": "make-app-contexts"
    }
  }
}
```

5. Restart Cursor.

## Development

```bash
npm install        # install dependencies
npm run build      # compile TypeScript → dist/
npm start          # run the server (stdio transport)
```

## Project Structure

```
mcp-server/
├── index.ts              # MCP server entry point
├── lib/
│   ├── pinecone.ts       # Pinecone client + helpers
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
