# Make Custom App Plugin: Project Config

## Releases (after the merge to master)

Every commit to master is one release. The plugin cache directory is named by the version, so a commit with an unchanged version is never delivered to users. Before every `git commit` on master:

1. Choose the bump: `patch` for fixes and documentation, `minor` for new skills, workflows, references, or scripts, `major` for breaking changes.
2. Set `version` to the new value in `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json` (the two must be equal).
3. Prepend a new entry to `CHANGELOG.md`: `## X.Y.Z — YYYY-MM-DD`, then the change summary.
4. Stage both manifests and the CHANGELOG with the change. Write the commit message as `X.Y.Z: <description>`.

CI (`plugin-check`) fails a pull request or push to master that changes the payload (`skills/`, `shared/`, `mcp/`, `mcp.json`, `hooks/`, or either `plugin.json`) without a higher plugin version. A change to `mcp-server/` is payload too once `mcp/index.mjs` is rebuilt (`node tools/build-mcp.js`); commit the bundle with it. A `2.4.x` bridge commit that touches only the old tree (below) is not a plugin release and does not bump the plugin.

## The integration branch

Until the plugin is merged to master, work happens on the branch `plugin`. Versions and CHANGELOG release entries change only in the release commit, the last commit on the branch before the pull request into master opens; until then the CHANGELOG keeps the top entry `## 3.0.0 (unreleased)`. Spec and plans are in `docs/superpowers/`; they are left out of the merge. The branch stays local until the user says otherwise.

## `version.json` and the old tree

`version.json` and `skill/SKILL.md` serve the 2.x clients that update themselves from master. While the old tree exists, change them only in a named bridge commit (a `2.4.x` patch for the migration scripts), together and with equal versions, and never as part of plugin work. The CHANGELOG entry of a `2.4.x` bridge commit goes below the top plugin entry, where `check-skill.js` reads the newest 2.x entry. CI (`.github/scripts/old-tree-guard.js`) allows changes under `skill/` only in the seven bridge files of spec 8.2, never in `rules/` or the installers, and on master only together with a higher `2.4.x` version in both files. After the cleanup, `version.json` stays at its last value and CI fails a change to it.

## Installers

The four installers (`install-cursor.sh`, `install-cursor.ps1`, `install-claude.sh`, `install-claude.ps1`) belong to the 2.x bridge. They copy `skill/`, `rules/`, and the source of `mcp-server/` wholesale and are not changed for plugin work. After the cleanup they become short shims that only print how to install the plugin; the drafts are in `tools/shims/` until plan P6 moves them to the root.
