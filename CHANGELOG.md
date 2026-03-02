# Changelog

## [1.2.0] - 2026-03-02

- Added `install.ps1` — Windows PowerShell installer with full feature parity to `install.sh`
- Updated `README.md` with OS-specific installation instructions (macOS/Linux + Windows)

## [1.1.0] - 2026-03-02

- Added MCP server for shared app context via Pinecone vector DB
- Added Pinecone auto-sync workflow to SKILL.md (triggers on context save, Jira work, code review)
- Added interactive MCP server setup to install.sh (API key input, auto-register)
- Added `register.js` script for automated Cursor MCP registration
- Added ESLint with TypeScript + Prettier flat config to mcp-server
- Added Vitest with 44 unit/integration tests for mcp-server
- Improved MCP server detection logic (auto-detect default installed path)

## [1.0.3] - 2026-03-02

- Moved scripts (`download-app.js`, `review-changes.js`) to separate `scripts/` folder
- Updated `install.sh` to install scripts from `scripts/` directory
- Translated all Korean text to English in `skill/SKILL.md` and `scripts/download-app.js`

## [1.0.2] - 2026-03-02

- Added `version-sync.mdc` rule to keep `version.json`, `skill/SKILL.md`, and `CHANGELOG.md` in sync
- Added `CHANGELOG.md` for tracking release history
- Updated `install.sh` to install `version-sync.mdc` rule
- Updated `README.md` with `version-sync.mdc` documentation
- Removed `changelog` field from `version.json` (replaced by `CHANGELOG.md`)

## [1.0.1] - 2026-03-02

- Version check system test

## [1.0.0] - Initial Release

- SKILL.md: IMLJSON patterns, app context management, code review, bug investigation workflows
- download-app.js: App source code downloader with dynamic concurrency and retry
- review-changes.js: Uncommitted changes fetcher for code review
- Reference docs: builtin-iml-functions, communication-reference, examples, runtime-reference
- Rule: make-app-code-review.mdc
- install.sh: One-liner installer with update/force modes
