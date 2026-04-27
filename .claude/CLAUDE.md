# Make Custom App Skill — Project Config

## Version Sync (automatic)

This repository follows strict semver. Before every `git commit`:
1. Determine the appropriate bump: `patch` for fixes/docs, `minor` for new features/workflows/references, `major` for breaking changes to the skill API
2. Update `version.json` → bump the `version` field
3. Update `skill/SKILL.md` → bump the `version:` frontmatter field to match
4. Prepend a new entry to `CHANGELOG.md` in format: `## X.Y.Z — YYYY-MM-DD\n- <change summary>`
5. Stage the version files (`version.json`, `skill/SKILL.md`, `CHANGELOG.md`) alongside the feature changes
6. Format the commit message as: `X.Y.Z: <description>` (e.g. `1.13.0: add claude code install script`)

Never commit without bumping the version.
