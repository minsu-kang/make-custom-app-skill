# Changelog

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
