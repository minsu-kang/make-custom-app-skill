# Harness Slimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the skill's always-loaded and per-task prose by ~70% while moving every enforceable check into code and preserving the hard rules listed in the spec.

**Architecture:** Three layers — code-enforced checks (`check-setup.js` + existing `version-guard.js`), a ≤ 8 KB `SKILL.md` as the only always-loaded prose, and on-demand workflows built as one shared `lifecycle.md` plus per-task deltas. Installers download one GitHub archive instead of hardcoded file lists.

**Tech Stack:** Bash, PowerShell, Node.js (CommonJS scripts, no deps), Markdown.

**Spec:** `docs/superpowers/specs/2026-09-15-harness-slimming-design.md`

## Global Constraints

- Release version `2.0.0`; `version.json`, `skill/SKILL.md` frontmatter, `CHANGELOG.md` bump together in the final task only.
- `${SKILL_ROOT}` / `${CONTEXTS_DIR}` placeholders only — no `~/.cursor/skills/...` or `~/.claude/skills/...` literals in `skill/**/*.md`.
- Context-file template (`# {App} v{N}` + `## App Overview / Structure / Key Patterns / Caveats / Work History`) stays byte-identical in meaning — the MCP chunker splits on `##`.
- Scripts under `skill/scripts/` other than the new `check-setup.js` are not modified.
- References: dedupe only; never change factual statements.
- All tabs for JS indentation (matches existing scripts). Markdown uses 4-space nested lists (matches existing files).

---

### Task 1: `check-setup.js`

**Files:**
- Create: `skill/scripts/check-setup.js`
- Reuse: `skill/scripts/lib/settings.js` (`readSkillConfig`, `loadSettings`), `skill/scripts/lib/skill-root.js` (`getSkillRoot`, `getEditorDir`), `skill/scripts/lib/version-guard.js` (`ensureFreshSkill`)

**Interfaces:**
- Produces CLI: `node ${SKILL_ROOT}/scripts/check-setup.js [--json] [--skip-version]`. Exit 0 = all required OK; exit 1 = a required item is missing. `--json` prints `{ ok: boolean, items: [{ key, status: 'ok'|'missing'|'optional-missing', detail, fix }] }`.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
/**
 * check-setup.js — one-screen diagnosis of the skill's local setup.
 *
 * Replaces the prose "Hard Stop" / setup-guide sections that used to live in
 * SKILL.md and pinecone-sync.md. The agent runs this once per conversation;
 * a non-zero exit means a REQUIRED item is missing and work must stop until
 * the printed fix is applied.
 *
 *   node check-setup.js            human-readable report
 *   node check-setup.js --json     machine-readable report
 *   node check-setup.js --skip-version   skip the remote version check
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getSkillRoot, getEditorDir } = require('./lib/skill-root');
const { readSkillConfig } = require('./lib/settings');

const args = new Set(process.argv.slice(2));
if (!args.has('--skip-version')) {
	require('./lib/version-guard').ensureFreshSkill();
}

const skillRoot = getSkillRoot();
const editorDir = getEditorDir();
const isClaude = editorDir === '.claude';
const skillMd = path.join(skillRoot, 'SKILL.md');
const items = [];

function add(key, status, detail, fix) {
	items.push({ key, status, detail, fix: fix || null });
}

// 1. imt-app-runtime-path (required)
{
	const v = readSkillConfig('imt-app-runtime-path');
	if (!v || v.includes('/path/provided/by/user')) {
		add('imt-app-runtime-path', 'missing', 'not set',
			`Clone niceinnovative/imt-app-runtime (Make internal repo), then append to ${skillMd}:\n  imt-app-runtime-path: /absolute/path/to/imt-app-runtime`);
	} else if (!fs.existsSync(v)) {
		add('imt-app-runtime-path', 'missing', `path does not exist: ${v}`,
			`Fix the imt-app-runtime-path line in ${skillMd} so it points to an existing clone.`);
	} else {
		add('imt-app-runtime-path', 'ok', v);
	}
}

// 2. Make API credentials (required)
if (isClaude) {
	const key = readSkillConfig('make-api-key');
	if (!key || /^<.*>$/.test(key)) {
		add('make-api-key', 'missing', 'not set (Claude Code reads it from SKILL.md)',
			`Generate a token in Make → Profile → API (scopes: apps:read apps:write sdk-apps:read sdk-apps:write + admin scopes you have), then append to ${skillMd}:\n  make-api-key: <token>\n  make-api-url: https://eu1.make.com/api/v2/admin   # optional, change zone if needed`);
	} else {
		add('make-api-key', 'ok', `set (${readSkillConfig('make-api-url') || 'https://eu1.make.com/api/v2/admin'})`);
	}
} else {
	const settingsPath = path.join(os.homedir(),
		process.platform === 'win32' ? 'AppData/Roaming/Cursor/User/settings.json' : 'Library/Application Support/Cursor/User/settings.json');
	let ok = false;
	try {
		const raw = fs.readFileSync(settingsPath, 'utf-8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,\s*([}\]])/g, '$1');
		const s = JSON.parse(raw);
		ok = Array.isArray(s['apps-sdk.environments']) && s['apps-sdk.environments'].length > 0;
	} catch { /* fall through */ }
	if (ok) add('make-api (Cursor settings.json)', 'ok', 'apps-sdk.environments present');
	else add('make-api (Cursor settings.json)', 'missing', `apps-sdk.environments not found in ${settingsPath}`,
		'Install the Make Apps SDK extension in Cursor and add an environment with your API key (Command Palette → "Make Apps: Add environment").');
}

// 3. make-apps-mockup-path (optional)
{
	const v = readSkillConfig('make-apps-mockup-path');
	if (!v || v.includes('/path/to')) {
		add('make-apps-mockup-path', 'optional-missing', 'not set — test-component.js unavailable',
			`Clone the make-apps-mockup repo, then append to ${skillMd}:\n  make-apps-mockup-path: /absolute/path/to/make-apps-mockup`);
	} else if (!fs.existsSync(v)) {
		add('make-apps-mockup-path', 'optional-missing', `path does not exist: ${v}`, `Fix the make-apps-mockup-path line in ${skillMd}.`);
	} else {
		add('make-apps-mockup-path', 'ok', v);
	}
}

// 4. Jira credentials (optional)
{
	const email = readSkillConfig('jira-email');
	const token = readSkillConfig('jira-api-token');
	if (!email || !token || email.includes('your-email') || token.includes('your-api-token')) {
		add('jira credentials', 'optional-missing', 'jira-email / jira-api-token not set — attachment download + reviewer assignment unavailable',
			`Create a token at https://id.atlassian.com/manage-profile/security/api-tokens, then append to ${skillMd}:\n  jira-email: you@example.com\n  jira-api-token: <token>\n  jira-base-url: https://make.atlassian.net   # optional`);
	} else {
		add('jira credentials', 'ok', email);
	}
}

// 5. MCP server (optional)
{
	const mcpDir = readSkillConfig('mcp-server-path') || path.join(skillRoot, 'mcp-server');
	const dist = path.join(mcpDir, 'dist', 'index.js');
	const env = path.join(mcpDir, '.env');
	const registryPath = isClaude ? path.join(os.homedir(), '.claude.json') : path.join(os.homedir(), '.cursor', 'mcp.json');
	let registered = false;
	try {
		const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
		registered = !!(reg.mcpServers && reg.mcpServers['make-app-context']);
	} catch { /* not registered */ }

	if (!fs.existsSync(path.join(mcpDir, 'package.json'))) {
		add('mcp-server', 'optional-missing', `not installed at ${mcpDir}`,
			'Re-run the installer (it copies and builds mcp-server), or set mcp-server-path: in SKILL.md.');
	} else if (!fs.existsSync(dist)) {
		add('mcp-server', 'optional-missing', 'not built', `cd ${mcpDir} && npm install && npm run build`);
	} else if (!fs.existsSync(env)) {
		add('mcp-server', 'optional-missing', '.env missing',
			`cd ${mcpDir} && cp .env.example .env   # fill PINECONE_API_KEY, OPENAI_API_KEY, PINECONE_INDEX_NAME\nnpm run register   # then restart the editor`);
	} else if (!registered) {
		add('mcp-server', 'optional-missing', `built + configured but not registered in ${registryPath}`,
			`cd ${mcpDir} && npm run register   # then restart the editor`);
	} else {
		add('mcp-server', 'ok', `registered (${registryPath})`);
	}
}

const requiredMissing = items.filter((i) => i.status === 'missing');
const ok = requiredMissing.length === 0;

if (args.has('--json')) {
	process.stdout.write(JSON.stringify({ ok, editor: editorDir, skillRoot, items }, null, 2) + '\n');
} else {
	const mark = { ok: 'OK      ', missing: 'MISSING ', 'optional-missing': 'OPTIONAL' };
	console.log(`make-custom-app setup — ${editorDir} — ${skillRoot}\n`);
	for (const i of items) console.log(`${mark[i.status]} ${i.key}: ${i.detail}`);
	const fixes = items.filter((i) => i.fix);
	if (fixes.length) {
		console.log('\nFixes:');
		for (const i of fixes) console.log(`\n[${i.status === 'missing' ? 'REQUIRED' : 'optional'}] ${i.key}\n${i.fix}`);
	}
	console.log(ok ? '\nSetup OK.' : '\nSetup INCOMPLETE — required items missing. Stop and apply the REQUIRED fixes above.');
}
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Run against the real install**

Run: `node ~/.cursor/skills/make-custom-app/scripts/check-setup.js --skip-version` after copying the file there (or run from the repo with `HOME` unchanged — `getSkillRoot()` derives from `argv[1]`, so run the installed copy).
Expected: a report with `OK imt-app-runtime-path`, exit 0 or 1 matching the real state.

- [ ] **Step 3: Run in a fake install**

```bash
T=$(mktemp -d); mkdir -p "$T/.cursor/skills/make-custom-app/scripts/lib"
cp skill/scripts/check-setup.js "$T/.cursor/skills/make-custom-app/scripts/"
cp skill/scripts/lib/*.js "$T/.cursor/skills/make-custom-app/scripts/lib/"
printf -- '---\nname: x\nversion: 9.9.9\n---\n' > "$T/.cursor/skills/make-custom-app/SKILL.md"
HOME=$T node "$T/.cursor/skills/make-custom-app/scripts/check-setup.js" --skip-version --json
```
Expected: JSON with `ok: false`, `imt-app-runtime-path` = `missing`, exit 1.

---

### Task 2: Installers → archive download

**Files:**
- Modify: `install-cursor.sh`, `install-claude.sh`, `install-cursor.ps1`, `install-claude.ps1`

**Interfaces:**
- Produces: `SRC_ROOT` variable pointing at the repo root (local clone or extracted archive). All copy steps read from `$SRC_ROOT/{skill,rules,mcp-server,subagents}`.

- [ ] **Step 1: `install-cursor.sh` — replace arrays and per-file loops**

Delete lines 26–37 (`SKILL_FILES` … `MCP_SERVER_FILES`), keep `DEPRECATED_HOOK_FILES`, `HOOKS_DIR`, `HOOKS_JSON`, `MCP_SERVER_DIR`. Replace the "Detect Source" block through the end of "Install MCP Server" copy loop (lines 139–390) with:

```bash
# ── Resolve Source (local clone or GitHub archive) ──
CLEANUP_TMP=""
if [ -n "${BASH_SOURCE[0]}" ] && [ -f "${BASH_SOURCE[0]}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/skill/SKILL.md" ]; then
    SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    info "Using local source: $SRC_ROOT"
else
    command -v curl &>/dev/null || fail "curl is not installed."
    command -v tar  &>/dev/null || fail "tar is not installed."
    CLEANUP_TMP="$(mktemp -d)"
    info "Downloading $REPO@$BRANCH archive..."
    if ! curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar -xz -C "$CLEANUP_TMP"; then
        fail "Download failed. Check your network and try again."
    fi
    SRC_ROOT="$CLEANUP_TMP/$(basename "$REPO")-$BRANCH"
    [ -f "$SRC_ROOT/skill/SKILL.md" ] || fail "Archive layout unexpected — SKILL.md not found."
fi
trap '[ -n "$CLEANUP_TMP" ] && rm -rf "$CLEANUP_TMP"' EXIT

# ── Install skill/ → $SKILL_DIR ──
info "Installing skill files..."
mkdir -p "$SKILL_DIR"
cp -R "$SRC_ROOT/skill/." "$SKILL_DIR/"
find "$SKILL_DIR" -name '.DS_Store' -delete 2>/dev/null || true
ok "skill/ ($(find "$SKILL_DIR" -type f | wc -l | tr -d ' ') files)"

# ── Install rules/ → $RULES_DIR (replace wholesale; removes retired rule files) ──
info "Installing rule files..."
rm -rf "$RULES_DIR"
mkdir -p "$RULES_DIR"
cp "$SRC_ROOT"/rules/*.mdc "$RULES_DIR/"
for f in "$RULES_DIR"/*.mdc; do ok "rules/$(basename "$f")"; done
# 1.x installed rule files directly under ~/.cursor/rules — remove any stragglers
for f in make-app-workflow make-app-todo-rules make-app-todo-bugfix make-app-todo-feature make-app-todo-task make-app-todo-review make-app-todo-refinement work-discipline make-app-ux-guideline make-app-auto-actions make-app-code-review; do
    rm -f "$HOME/.cursor/rules/$f.mdc"
done

# ── Install mcp-server/ (source only) → $MCP_SERVER_DIR ──
info "Installing MCP server source..."
mkdir -p "$MCP_SERVER_DIR"
(cd "$SRC_ROOT/mcp-server" && tar -cf - --exclude=node_modules --exclude=dist --exclude=.env --exclude='.DS_Store' .) | (cd "$MCP_SERVER_DIR" && tar -xf -)
ok "mcp-server/ source copied"
```

Keep everything after (npm install/build, MCP config prompt, deprecated hooks cleanup, restore user config, verify). Move the "Restore preserved .env" block to run **after** the mcp-server copy (the copy excludes `.env`, but ordering makes intent obvious). Delete the "Migrate: remove old/deprecated rule files" block (lines 119–131) and the "Cleanup deprecated rule files" block (lines 304–314) — both are subsumed by `rm -rf "$RULES_DIR"` and the straggler loop.

- [ ] **Step 2: `install-claude.sh` — same replacement**

Same `SRC_ROOT` block. Copy block differences:

```bash
# skill/ → $SKILL_DIR (path-rewritten for Claude)
mkdir -p "$SKILL_DIR"
(cd "$SRC_ROOT/skill" && find . -type f ! -name '.DS_Store' -print0) | while IFS= read -r -d '' rel; do
    mkdir -p "$SKILL_DIR/$(dirname "$rel")"
    case "$rel" in
        *.md) copy_with_rewrite "$SRC_ROOT/skill/$rel" "$SKILL_DIR/$rel" ;;
        *)    cp "$SRC_ROOT/skill/$rel" "$SKILL_DIR/$rel" ;;
    esac
done
ok "skill/ ($(find "$SKILL_DIR" -type f | wc -l | tr -d ' ') files)"
# rules/ are no longer installed for Claude Code (SKILL.md carries the hard rules)
rm -rf "$SKILL_DIR/rules"
# mcp-server: same tar pipe as Cursor
# subagents:
install_agent "$SRC_ROOT/subagents/make-integration-engineer.md"
```

Remove `copy_rule_strip_frontmatter` and the entire "Install Rule Files" section. Keep `copy_with_rewrite` + `PATH_REWRITE_SED` (no-op safety net for one release). Keep the `~/.claude/CLAUDE.md` sentinel block and `~/.claude.json` registration as-is.

- [ ] **Step 3: `install-cursor.ps1` / `install-claude.ps1` — same change**

```powershell
# ── Resolve Source ──
$CleanupTmp = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'skill\SKILL.md'))) {
    $SrcRoot = $PSScriptRoot
} else {
    $CleanupTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("make-custom-app-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $CleanupTmp | Out-Null
    $Zip = Join-Path $CleanupTmp 'src.zip'
    Write-Info "Downloading $Repo@$Branch archive..."
    Invoke-WebRequest -Uri "https://github.com/$Repo/archive/refs/heads/$Branch.zip" -OutFile $Zip -UseBasicParsing
    Expand-Archive -Path $Zip -DestinationPath $CleanupTmp -Force
    $SrcRoot = Join-Path $CleanupTmp ("$($Repo.Split('/')[1])-$Branch")
    if (-not (Test-Path (Join-Path $SrcRoot 'skill\SKILL.md'))) { Write-Fail 'Archive layout unexpected.' }
}
try {
    New-Item -ItemType Directory -Force -Path $SkillDir | Out-Null
    Copy-Item -Path (Join-Path $SrcRoot 'skill\*') -Destination $SkillDir -Recurse -Force
    # Cursor only:
    if (Test-Path $RulesDir) { Remove-Item -Recurse -Force $RulesDir }
    New-Item -ItemType Directory -Force -Path $RulesDir | Out-Null
    Copy-Item -Path (Join-Path $SrcRoot 'rules\*.mdc') -Destination $RulesDir -Force
    # mcp-server source (exclude node_modules/dist/.env)
    New-Item -ItemType Directory -Force -Path $McpServerDir | Out-Null
    Get-ChildItem -Path (Join-Path $SrcRoot 'mcp-server') -Recurse -File |
        Where-Object { $_.FullName -notmatch '\\(node_modules|dist)\\' -and $_.Name -ne '.env' } |
        ForEach-Object {
            $rel = $_.FullName.Substring((Join-Path $SrcRoot 'mcp-server').Length).TrimStart('\')
            $dst = Join-Path $McpServerDir $rel
            New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
            Copy-Item $_.FullName $dst -Force
        }
} finally {
    if ($CleanupTmp) { Remove-Item -Recurse -Force $CleanupTmp -ErrorAction SilentlyContinue }
}
```

Adapt names to each script's existing variables (`$SkillDir`, `$RulesDir`, `$McpServerDir`, `Write-Info`, `Write-Fail`). Delete the `$SKILL_FILES` … `$MCP_SERVER_FILES` arrays and per-file loops. Claude variant: skip rules, add subagent copy with `{{SKILLS_DIR}}` replacement as the existing script does.

- [ ] **Step 4: Verify — local-clone mode, fresh HOME**

```bash
T=$(mktemp -d); HOME=$T bash ./install-cursor.sh --update </dev/null
ls $T/.cursor/skills/make-custom-app $T/.cursor/rules/make-custom-app
HOME=$T node $T/.cursor/skills/make-custom-app/scripts/check-setup.js --skip-version; echo "exit=$?"
```
Expected: `SKILL.md references scripts workflows mcp-server` present; rules dir has exactly `make-custom-app.mdc` (after Task 4); check-setup exits 1 with `MISSING imt-app-runtime-path`.

- [ ] **Step 5: Verify — update over a 1.21.0 layout preserves tail config and removes old rules**

```bash
T=$(mktemp -d); mkdir -p $T/.cursor/skills/make-custom-app $T/.cursor/rules/make-custom-app
printf -- '---\nversion: 1.21.0\n---\nold\n\nimt-app-runtime-path: /tmp\njira-email: a@b.c\n' > $T/.cursor/skills/make-custom-app/SKILL.md
touch $T/.cursor/rules/make-custom-app/work-discipline.mdc $T/.cursor/rules/make-custom-app/make-app-todo-rules.mdc
HOME=$T bash ./install-cursor.sh --update </dev/null
tail -3 $T/.cursor/skills/make-custom-app/SKILL.md; ls $T/.cursor/rules/make-custom-app
```
Expected: tail shows `imt-app-runtime-path: /tmp` and `jira-email: a@b.c`; rules dir lists only `make-custom-app.mdc`.

- [ ] **Step 6: Verify — archive mode**

```bash
T=$(mktemp -d); cd /tmp && HOME=$T bash "$OLDPWD/install-cursor.sh" --update </dev/null; cd -
```
Because `BASH_SOURCE[0]` resolves to the repo, force archive mode by piping: `HOME=$T bash -c "$(cat install-cursor.sh)" -- --update`. Expected: "Downloading minsu-kang/make-custom-app-skill@master archive..." and a complete tree. (Archive mode pulls `master`, i.e. the old 1.21.0 tree, until this work is pushed — the point of the check is the download + extract + copy path, not the content.)

- [ ] **Step 7: Verify — Claude installer local mode**

```bash
T=$(mktemp -d); HOME=$T bash ./install-claude.sh --update </dev/null
ls $T/.claude/skills/make-custom-app $T/.claude/agents; test ! -d $T/.claude/skills/make-custom-app/rules && echo "no rules dir"
```

- [ ] **Step 8: PowerShell syntax check (if `pwsh` available)**

Run: `pwsh -NoProfile -Command '[void][System.Management.Automation.Language.Parser]::ParseFile("install-cursor.ps1",[ref]$null,[ref]$e); $e.Count'` for both files. Expected: `0`.

---

### Task 3: `SKILL.md` rewrite

**Files:**
- Modify: `skill/SKILL.md` (full rewrite, ≤ 8192 bytes)

- [ ] **Step 1: Write the new file** with these sections in order (content sources in parentheses):

1. Frontmatter — copy current lines 1–5 verbatim (version bump happens in Task 9).
2. `## First action (once per conversation)` — run `node ${SKILL_ROOT}/scripts/check-setup.js`; non-zero exit → print its output, stop, end turn. Exception: the user is asking to add/fix a tail-config line. Mention `${SKILL_ROOT}` resolves to `~/.cursor/skills/make-custom-app` or `~/.claude/skills/make-custom-app`, `${CONTEXTS_DIR}` to the sibling `make-app-contexts`.
3. `## Workflows` — routing table (current lines 80–89, shortened descriptions), plus one row: "any of the above" → `workflows/lifecycle.md` (read first, always).
4. `## Hard rules` — the 8 lines from spec §4.
5. `## App components` and `## Module types` — current tables at lines 91–127, trimmed to one line per row; keep the "iterate only in Search modules" sentence and the Search-module `iterate`/`limit` requirement.
6. `## References` — current lines 339–355 as one line each with "read when".
7. `## Scripts` — 12 lines: script name → purpose (`download-app`, `review-changes`, `update-app`, `create-component`, `update-component`, `delete-component`, `commit-changes`, `test-function`, `test-component`, `download-jira-ticket-attachment`, `post-review-transition`, `check-setup`).
8. Trailing comment: `<!-- User config lines (imt-app-runtime-path:, make-api-key:, …) are appended below by the installer. Run scripts/check-setup.js to see what is missing. -->`

- [ ] **Step 2: Move Important Notes content** (current lines 271–302) — for each bullet, grep `references/app-compilation-and-deployment-reference.md` and `references/runtime-reference.md` for the same fact; append only the bullets not already present to `app-compilation-and-deployment-reference.md` § "Module visibility & hiding" (visibility/`private`/`deprecated`/`public`/admin endpoint status codes) or § 3 (`approved` semantics). The IML 1-based index note and `environment`/`internal` note are already in `runtime-reference.md` — verify with grep, drop from SKILL.

- [ ] **Step 3: Check size and placeholders**

Run: `wc -c skill/SKILL.md; rg -n '~/\.(cursor|claude)/skills' skill/SKILL.md`
Expected: ≤ 8192; no matches.

---

### Task 4: Rules and sub-agent

**Files:**
- Create: `rules/make-custom-app.mdc`
- Delete: `rules/make-app-workflow.mdc`, `rules/make-app-todo-rules.mdc`, `rules/make-app-todo-bugfix.mdc`, `rules/make-app-todo-feature.mdc`, `rules/make-app-todo-task.mdc`, `rules/make-app-todo-review.mdc`, `rules/make-app-todo-refinement.mdc`, `rules/work-discipline.mdc`
- Modify: `subagents/make-integration-engineer.md`

- [ ] **Step 1: Write `rules/make-custom-app.mdc`**

```markdown
---
description: Route Make.com custom app work to the make-custom-app skill
globs:
alwaysApply: true
---

When the conversation involves a Make.com custom app, IMLJSON, the Make Apps SDK, `make-app-contexts`, or an IEN Jira ticket about an app: load the `make-custom-app` skill (`~/.cursor/skills/make-custom-app/SKILL.md`) before any other action and follow it. Do not answer from memory.
```

- [ ] **Step 2: Delete the 8 old rule files** (`git rm`).

- [ ] **Step 3: Rewrite the sub-agent body** — keep frontmatter lines 1–7 verbatim; body:

```markdown
You are a Make Senior Integration Engineer for Make.com custom apps (IMLJSON, Make Apps SDK).

## First action — every conversation

Call `Skill('make-custom-app')` before any other tool call. It loads `SKILL.md`, which is your operating contract: run its first-action setup check, route via its workflow table, obey its hard rules. Static file reads are not a substitute. If the Skill tool fails, report that and stop.

## Working rules

- Follow `workflows/lifecycle.md` for every task; read the task-specific workflow it routes to.
- Persist knowledge only through the app context file (`${CONTEXTS_DIR}/{slug}-v{version}.md`) and the `upsert_app_context` / `upsert_jira_ticket` MCP tools — no private memory store.
- Write scripts (`update-app.js`, `create-component.js`, `update-component.js`, `delete-component.js`, `commit-changes.js`) run only after the user confirms the shown change.
```

- [ ] **Step 4: Verify** `wc -c rules/make-custom-app.mdc subagents/make-integration-engineer.md` → ≤ 600 and ≤ 2000. Grep the installers for `{{SKILLS_DIR}}` replacement still applied (Claude installer `install_agent`).

---

### Task 5: `workflows/lifecycle.md`

**Files:**
- Create: `skill/workflows/lifecycle.md`
- Delete: `skill/workflows/app-context.md`, `skill/workflows/pinecone-sync.md`

- [ ] **Step 1: Write `lifecycle.md`** (≤ 8 KB) with the variables comment line on top, then:

```
# Task Lifecycle (shared by every workflow)
## 1. Identify the app        ← app-context.md lines 42–76 (App HQ URL → IPME → ask), condensed
## 2. Sync code               ← app-context.md 78–92 + 106–121 (download-app.js call; freshness: <1h fresh, 1–24h mention, >24h re-download)
## 3. Load context            ← context file + search_app_knowledge (one paragraph)
## 4. Fetch the Jira ticket   ← code-review.md 53–71 field list, subtask status filter, parent fetch, comments, attachments script
## 5. Do the work             ← "read the task workflow; before editing, state the plan and wait for approval (bug/feature/task)"
## 6. Push changes            ← app-context.md 123–187: update-app.js component-path table, create/update/delete-component pointers, commit-changes.js option table, rollback rule (verbatim ⛔ paragraph)
## 7. Close out               ← Developer Notes prompt (skip for code review) → context file (template below verbatim from app-context.md 204–237) → upsert_app_context + upsert_jira_ticket (argument shapes from pinecone-sync.md 133–158) → post-commit download-app.js
## MCP unavailable            ← "run check-setup.js, show its mcp-server line and fix; continue the workflow, tell the user sync was skipped"
## Checklist                  ← 7 lines: identify · sync · context · jira · plan-approved · pushed-with-confirmation · closed-out
```

- [ ] **Step 2: `git rm` the two absorbed files.**

- [ ] **Step 3: Verify** `wc -c skill/workflows/lifecycle.md` ≤ 8192; the context-file template block is byte-identical to the old one (`diff <(sed -n '206,237p' <(git show HEAD:skill/workflows/app-context.md)) <(sed -n '/^```markdown/,/^```/p' skill/workflows/lifecycle.md)` → only fence lines differ).

---

### Task 6: Task workflows — deltas only

**Files:**
- Modify: `skill/workflows/code-review.md`, `bug-investigation.md`, `feature-request.md`, `app-task.md`, `task-refinement.md`, `create-endpoint.md`

- [ ] **Step 1: `code-review.md`** (≤ 18 KB). Structure:

```
# Code Review Workflow
> Read lifecycle.md first. This file adds only what is review-specific.
## Inputs                      ← slug/version, Jira recommended, Atlassian MCP check (3 short paragraphs)
## Reviewer assignment         ← parent only, MCP procedure (current 73–101, list form, no repetition)
## Fetch changes               ← download-app.js + review-changes.js every time; latest.json path
## 0 changes: approved vs not  ← current §5a table verbatim (it is the decisive artifact)
## Filter to the ticket        ← current §6
## Skip rules (#1–#5)          ← current §7 items 1–5 including the uncommitted #5 text; scaffold verification paragraph; "publish state is never a finding"
## Review each change          ← criteria bullet list (current 179–189)
### Gate: runtime reference    ← directive → section table (current 195–208) + 3 false-positive bullets
### Gate: external API docs    ← procedure steps 1–6 (current 224–236), no anecdote paragraphs; the Etsy examples move to code-review-criteria.md Out of Scope if absent
### Cross-module check         ← current 244–248
## Output format               ← current 250–283 block verbatim + Commit Checklist rule as 3 bullets
## Developer message           ← template + audience rule as one bullet list (forbidden: scripts, paths, Pinecone terms; say it in SDK terms)
## Disposition gate            ← question by compiled state; past tense vs imperative; committed/returned actions list; commit-changes.js delegation block; ⛔ Test-status QA rule
## Re-review                   ← 5 lines + table
## Without a Jira ticket       ← 2 lines
## Checklist                   ← 8 lines
```
Drop: "Important Rules" (all duplicated above), the TODO-template cross-references (`§ R`, `review_analyze`, `common_jira_fetch`), "Do NOT prompt for Developer Notes" (now a hard rule in SKILL.md — keep one short reminder in Disposition gate).

- [ ] **Step 2: `bug-investigation.md`** (≤ 5 KB): keep steps 1 (required data rule), 3–8, Recurring Bug Handling; replace steps 2, 9–11 with "→ lifecycle.md §1–3, §7". Add `## Checklist`.

- [ ] **Step 3: `feature-request.md`** (≤ 4 KB): keep steps 3–8 + `create-component.js` table; replace 1–2, 9–11 with lifecycle pointers. Add `## Checklist`.

- [ ] **Step 4: `app-task.md`** (≤ 3 KB): keep steps 3–5; replace 1–2, 6–8 with lifecycle pointers. Add `## Checklist`.

- [ ] **Step 5: `task-refinement.md`** (≤ 12 KB): read the current file; remove every paragraph that restates lifecycle §1–4 or the TODO template (`§ P`, `refine_*` ids); keep status check, feasibility criteria, plan output format, Investigation-subtask creation procedure, Checklist.

- [ ] **Step 6: `create-endpoint.md`** (≤ 7 KB): remove lifecycle repetition and any `~/.cursor` literal; otherwise unchanged.

- [ ] **Step 7: Verify sizes and dangling links**

```bash
wc -c skill/workflows/*.md
rg -n '\]\((\.\./)?(workflows|references)/[^)#]+' -o skill --no-filename | sed -E 's/.*\]\(//' | sort -u | while read p; do f="skill/${p#../}"; [ -f "$f" ] || [ -f "skill/workflows/$p" ] || echo "BROKEN: $p"; done
rg -n 'app-context\.md|pinecone-sync\.md|make-app-todo|work-discipline|§ [RBNTP]\b|common_[a-z_]+|review_[a-z_]+|bug_[a-z_]+|refine_[a-z_]+' skill rules subagents
```
Expected: sizes within targets; no `BROKEN:`; no matches on the last command.

---

### Task 7: References — dedupe and headers

**Files:**
- Modify: all 17 `skill/references/*.md`

- [ ] **Step 1: Add a `> Read when:` header** under the H1 of every reference (one line each; e.g. `runtime-reference.md`: "Read when: writing or reviewing `api.imljson` — directive semantics, URL/QS normalization, temp, pagination, triggers, endpoint calls, environment/internal roots.").

- [ ] **Step 2: `code-review-criteria.md`** — replace the Breaking-skip block (current lines 12–37, the five numbered skips + trailing paragraphs) with: `> Breaking-change and Bug skip rules #1–#5 are defined once in [code-review.md § Skip rules](../workflows/code-review.md). Apply them before evaluating this category.` Keep the "Publish/visibility state is never a finding" line. In § "Runtime Behavior Verification", replace the directive descriptions that duplicate `runtime-reference.md` with the pointer to `code-review.md § Gate: runtime reference` and keep only the "common mistakes / false positives" list. Add the two Etsy examples from `code-review.md` to § Out of Scope if not present.

- [ ] **Step 3: Replace `~/.cursor/skills/make-custom-app` literals** with `${SKILL_ROOT}` across `skill/references/*.md` (`rg -l '~/\.cursor/skills' skill/references`).

- [ ] **Step 4: Verify** `rg -n '~/\.(cursor|claude)/skills' skill` → no matches. `rg -c 'Read when:' skill/references/*.md` → 17 files, 1 each.

---

### Task 8: Repo meta

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.cursor/rules/version-sync.mdc` (no change needed — verify), `cspell.json` (if new words)
- Delete: `.cursor/rules/install-sync.mdc`

- [ ] **Step 1: `README.md`** — update § Skill Files table (remove `app-context.md`, `pinecone-sync.md`; add `lifecycle.md`), § Script Files (add `check-setup.js`), § Rule Files (one row), § Repository Structure tree, and the installation section: state that the installer downloads the GitHub archive; commands unchanged.

- [ ] **Step 2: `CLAUDE.md` + `.claude/CLAUDE.md`** — delete § Install Sync; in `CLAUDE.md` § Architecture, replace the rules/subagent description with the new layout (one always-on trigger rule; sub-agent delegates to SKILL.md; `check-setup.js`).

- [ ] **Step 3: `git rm .cursor/rules/install-sync.mdc`**.

- [ ] **Step 4: Verify** `rg -n 'install-sync|SKILL_FILES|REFERENCE_FILES|RULE_FILES' --glob '!CHANGELOG.md' --glob '!docs/**' .` → no matches.

---

### Task 9: Version 2.0.0, CHANGELOG, final verification

**Files:**
- Modify: `version.json`, `skill/SKILL.md` (frontmatter `version`), `CHANGELOG.md`

- [ ] **Step 1: Bump** `version.json` → `"version": "2.0.0"`, `"released": "<today>"`; `skill/SKILL.md` frontmatter `version: 2.0.0`.

- [ ] **Step 2: CHANGELOG entry** (`## 2.0.0 — <date>`) covering: archive-based installers (file arrays gone, `install-sync.mdc` removed); `check-setup.js`; `SKILL.md` ≤ 8 KB; rules collapsed to one trigger rule (list the 8 removed files); TODO templates retired in favour of workflow checklists; `lifecycle.md` replaces `app-context.md` + `pinecone-sync.md`; workflow size reductions; sub-agent slimmed, agent-memory removed; skip #5 (no-production-surface) folded in from the pending change; migration note (auto-update handles cleanup; restart editor).

- [ ] **Step 3: Full verification**

```bash
wc -c skill/SKILL.md rules/*.mdc skill/workflows/lifecycle.md skill/workflows/code-review.md skill/references/code-review-criteria.md | tail -1   # ≤ 61440
(cd mcp-server && npm test)
T=$(mktemp -d); HOME=$T bash ./install-cursor.sh --update </dev/null && HOME=$T node $T/.cursor/skills/make-custom-app/scripts/check-setup.js --skip-version --json | head -5
T=$(mktemp -d); HOME=$T bash ./install-claude.sh --update </dev/null && ls $T/.claude/agents
```

- [ ] **Step 4: Spec §4 audit** — for each of the 8 hard rules, `rg` a distinctive phrase in `skill/SKILL.md`; for skip rules #1–#5 and the disposition gate, `rg` in `skill/workflows/code-review.md`. All present.

- [ ] **Step 5: Commit and push** (per `version-sync.mdc`): `2.0.0: slim the harness — archive installers, check-setup.js, single trigger rule, lifecycle workflow`.
