#Requires -Version 5.1

# ============================================================
# Make Custom App Skill Installer for Claude Code (Windows)
# ============================================================
# Usage:
#   Fresh install / Update:
#     irm https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install-claude.ps1 | iex
#
#   Clone & install:
#     git clone https://github.com/minsu-kang/make-custom-app-skill.git
#     cd make-custom-app-skill; .\install-claude.ps1
#
#   Flags:
#     -Mode update    Skip confirmation prompt (for scripted updates)
#     -Mode force     Remove everything and do a clean install
# ============================================================

param(
    [ValidateSet("install", "update", "force")]
    [string]$Mode = "install"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Force TLS 1.2 for HTTPS — required for GitHub raw on PowerShell 5.1
# (legacy default on Windows 10 is SSL3/TLS1.0 which GitHub rejects).
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$REPO = "minsu-kang/make-custom-app-skill"
$BRANCH = "master"
$CLAUDE_HOME = Join-Path $env:USERPROFILE ".claude"
$SKILL_DIR = Join-Path $CLAUDE_HOME "skills\make-custom-app"
$RULES_DIR = Join-Path $SKILL_DIR "rules"
$AGENTS_DIR = Join-Path $CLAUDE_HOME "agents"
$CLAUDE_MD = Join-Path $CLAUDE_HOME "CLAUDE.md"
$CLAUDE_JSON = Join-Path $HOME ".claude.json"
$VERSION_URL = "https://raw.githubusercontent.com/$REPO/$BRANCH/version.json"

$SKILL_FILES = @("SKILL.md")
$REFERENCE_FILES = @("builtin-iml-functions.md", "communication-reference.md", "examples.md", "runtime-reference.md", "app-ux-best-practices.md", "parameters-reference.md", "component-patterns-reference.md", "developer-notes-templates.md", "custom-functions-reference.md", "polling-trigger-guide.md", "component-test-guide.md", "code-review-criteria.md", "security-reference.md", "code-smells-reference.md")
$WORKFLOW_FILES = @("app-context.md", "code-review.md", "bug-investigation.md", "feature-request.md", "app-task.md", "pinecone-sync.md", "task-refinement.md")
$SCRIPT_FILES = @("download-app.js", "review-changes.js", "update-app.js", "create-component.js", "update-component.js", "delete-component.js", "test-function.js", "test-component.js", "download-jira-ticket-attachment.js", "post-review-transition.js")
$SCRIPT_LIB_FILES = @("skill-root.js", "settings.js")
$RULE_FILES = @("make-app-workflow.mdc", "make-app-todo-rules.mdc", "make-app-todo-bugfix.mdc", "make-app-todo-feature.mdc", "make-app-todo-task.mdc", "make-app-todo-review.mdc", "make-app-todo-refinement.mdc", "work-discipline.mdc")
$MCP_SERVER_DIR = Join-Path $SKILL_DIR "mcp-server"
$MCP_SERVER_FILES = @(
    "package.json", "tsconfig.json", "index.ts", "register.js",
    "lib/pinecone.ts", "lib/embeddings.ts", "lib/chunker.ts",
    "tools/upsert.ts", "tools/search.ts", "tools/get-summary.ts",
    "tools/list-apps.ts", "tools/upsert-jira.ts", ".env.example"
)

function Write-Info  { param($msg) Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Fail  { param($msg) Write-Host "  [X]  $msg" -ForegroundColor Red; exit 1 }

# Path rewrite: replace ~/.cursor/skills/make-custom-app with ~/.claude/skills/make-custom-app
function Convert-PathRewrite {
    param([string]$Content)
    if ($null -eq $Content) { return $Content }
    return $Content.Replace("~/.cursor/skills/make-custom-app", "~/.claude/skills/make-custom-app")
}

function Copy-WithRewrite {
    param([string]$Src, [string]$Dst)
    $parentDir = Split-Path $Dst -Parent
    if (-not (Test-Path $parentDir)) {
        New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
    }
    $content = Get-Content -Path $Src -Raw
    $content = Convert-PathRewrite $content
    # Use UTF8 without BOM via .NET to keep file format consistent
    [System.IO.File]::WriteAllText($Dst, $content, (New-Object System.Text.UTF8Encoding $false))
}

# Strip frontmatter (the first ---...--- block plus an optional blank line after)
# and apply path rewrite — for converting .mdc rule files into .md.
function Copy-RuleStripFrontmatter {
    param([string]$Src, [string]$Dst)
    $parentDir = Split-Path $Dst -Parent
    if (-not (Test-Path $parentDir)) {
        New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
    }
    $lines = Get-Content -Path $Src
    $out = New-Object System.Collections.Generic.List[string]
    $inFm = $false
    $fmDone = $false
    $sawBlankAfter = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($i -eq 0 -and $line -match '^---\s*$') {
            $inFm = $true
            continue
        }
        if ($inFm -and $line -match '^---\s*$') {
            $inFm = $false
            $fmDone = $true
            continue
        }
        if ($inFm) { continue }
        if ($fmDone -and -not $sawBlankAfter -and $line -match '^\s*$') {
            $sawBlankAfter = $true
            continue
        }
        $out.Add($line) | Out-Null
    }
    $content = ($out -join "`n")
    $content = Convert-PathRewrite $content
    [System.IO.File]::WriteAllText($Dst, $content, (New-Object System.Text.UTF8Encoding $false))
}

function Download-File {
    param(
        [string]$Url,
        [string]$OutPath
    )
    try {
        $parentDir = Split-Path $OutPath -Parent
        if (-not (Test-Path $parentDir)) {
            New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
        }
        Invoke-WebRequest -Uri $Url -OutFile $OutPath -UseBasicParsing -ErrorAction Stop
        return $true
    }
    catch {
        if (Test-Path $OutPath) { Remove-Item -Force $OutPath }
        return $false
    }
}

function Download-FileWithRewrite {
    param([string]$Url, [string]$OutPath)
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing -ErrorAction Stop
        Copy-WithRewrite -Src $tmp -Dst $OutPath
        return $true
    }
    catch {
        if (Test-Path $OutPath) { Remove-Item -Force $OutPath }
        return $false
    }
    finally {
        if (Test-Path $tmp) { Remove-Item -Force $tmp }
    }
}

function Download-RuleStripFrontmatter {
    param([string]$Url, [string]$OutPath)
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing -ErrorAction Stop
        Copy-RuleStripFrontmatter -Src $tmp -Dst $OutPath
        return $true
    }
    catch {
        if (Test-Path $OutPath) { Remove-Item -Force $OutPath }
        return $false
    }
    finally {
        if (Test-Path $tmp) { Remove-Item -Force $tmp }
    }
}

Write-Host ""
Write-Host "  ==============================================" -ForegroundColor White
Write-Host "    Make Custom App Skill Installer for Claude   " -ForegroundColor White
Write-Host "  ==============================================" -ForegroundColor White
Write-Host ""

# -- Preserve User Config --
$SavedRuntimePath = ""
$SavedMcpPath = ""
$SavedMockupPath = ""
$SavedJiraEmail = ""
$SavedJiraToken = ""
$SavedJiraBaseUrl = ""
$SavedMakeApiKey = ""
$SavedMakeApiUrl = ""
$SavedEnv = ""

if (Test-Path $SKILL_DIR) {
    $skillMdPath = Join-Path $SKILL_DIR "SKILL.md"
    if (Test-Path $skillMdPath) {
        $allLines = Get-Content $skillMdPath
        $SavedRuntimePath = ($allLines | Where-Object { $_ -match "^imt-app-runtime-path:" -and $_ -notmatch "/path/provided" } | Select-Object -Last 1) -join ""
        $SavedMcpPath = ($allLines | Where-Object { $_ -match "^mcp-server-path:" -and $_ -notmatch "\{path-to" } | Select-Object -Last 1) -join ""
        $SavedMockupPath = ($allLines | Where-Object { $_ -match "^make-apps-mockup-path:" -and $_ -notmatch "/path/to" } | Select-Object -Last 1) -join ""
        $SavedJiraEmail = ($allLines | Where-Object { $_ -match "^jira-email:" -and $_ -notmatch "your-email" } | Select-Object -Last 1) -join ""
        $SavedJiraToken = ($allLines | Where-Object { $_ -match "^jira-api-token:" -and $_ -notmatch "your-api-token" } | Select-Object -Last 1) -join ""
        $SavedJiraBaseUrl = ($allLines | Where-Object { $_ -match "^jira-base-url:" -and $_ -notmatch "your-instance" } | Select-Object -Last 1) -join ""
        $SavedMakeApiKey = ($allLines | Where-Object { $_ -match "^make-api-key:" -and $_ -notmatch "your-make-api-token" } | Select-Object -Last 1) -join ""
        $SavedMakeApiUrl = ($allLines | Where-Object { $_ -match "^make-api-url:" -and $_ -notmatch "eu1\.make\.com/api/v2/admin$" } | Select-Object -Last 1) -join ""
    }

    $savedEnvFile = Join-Path $SKILL_DIR "mcp-server\.env"
    if (Test-Path $savedEnvFile) {
        $SavedEnv = Get-Content $savedEnvFile -Raw
    }

    switch ($Mode) {
        "update" {
            Write-Info "Updating existing installation (cleaning old files)..."
            Remove-Item -Recurse -Force $SKILL_DIR
            Write-Host ""
        }
        "force" {
            Write-Warn "Force mode: removing existing installation..."
            Remove-Item -Recurse -Force $SKILL_DIR
            Write-Host ""
        }
        "install" {
            Write-Warn "Existing installation detected: $SKILL_DIR"
            Write-Host ""
            Write-Host "    (u) Update - overwrite skill files, preserve user config"
            Write-Host "    (f) Force  - clean install, remove everything"
            Write-Host "    (c) Cancel"
            Write-Host ""
            $choice = Read-Host "    Choose [u/f/c]"
            switch -Regex ($choice) {
                "^[Uu]$" { $Mode = "update"; Remove-Item -Recurse -Force $SKILL_DIR; Write-Host "" }
                "^[Ff]$" { $Mode = "force"; Remove-Item -Recurse -Force $SKILL_DIR; Write-Host "" }
                default   { Write-Info "Installation cancelled."; exit 0 }
            }
        }
    }
}

New-Item -ItemType Directory -Force -Path $SKILL_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $RULES_DIR | Out-Null

# -- Restore preserved .env --
if ($SavedEnv) {
    $restoreMcpDir = Join-Path $SKILL_DIR "mcp-server"
    New-Item -ItemType Directory -Force -Path $restoreMcpDir | Out-Null
    Set-Content -Path (Join-Path $restoreMcpDir ".env") -Value $SavedEnv -Encoding UTF8
}

# -- Detect Source --
# When run via `irm | iex`, $PSScriptRoot is empty — fall back to download mode.
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { "" }

# -- Install Skill Files (skill/ -> $SKILL_DIR/) --
Write-Info "Installing skill files..."
Write-Host ""

$localSkillMd = if ($ScriptDir) { Join-Path $ScriptDir "skill\SKILL.md" } else { "" }

if ($ScriptDir -and (Test-Path $localSkillMd)) {
    foreach ($file in $SKILL_FILES) {
        $src = Join-Path $ScriptDir "skill\$file"
        if (Test-Path $src) {
            Copy-WithRewrite -Src $src -Dst (Join-Path $SKILL_DIR $file)
            Write-Ok $file
        }
        else {
            Write-Warn "$file (not found, skipped)"
        }
    }
}
else {
    Write-Info "Downloading from GitHub..."
    Write-Host ""
    $baseUrl = "https://raw.githubusercontent.com/$REPO/$BRANCH"
    foreach ($file in $SKILL_FILES) {
        $outPath = Join-Path $SKILL_DIR $file
        if (Download-FileWithRewrite "$baseUrl/skill/$file" $outPath) {
            Write-Ok $file
        }
        else {
            Write-Warn "$file (download failed)"
        }
    }
}

# -- Install Reference Files (skill/references/ -> $SKILL_DIR/references/) --
Write-Host ""
Write-Info "Installing reference files..."
Write-Host ""

$REFERENCES_DIR = Join-Path $SKILL_DIR "references"
New-Item -ItemType Directory -Force -Path $REFERENCES_DIR | Out-Null

$localReferencesDir = if ($ScriptDir) { Join-Path $ScriptDir "skill\references" } else { "" }

if ($ScriptDir -and (Test-Path $localReferencesDir)) {
    Copy-Item -Force (Join-Path $localReferencesDir "*.md") $REFERENCES_DIR -ErrorAction SilentlyContinue
    foreach ($file in (Get-ChildItem -Path $REFERENCES_DIR -Filter "*.md")) {
        Write-Ok "references/$($file.Name)"
    }
}
else {
    $baseUrl = "https://raw.githubusercontent.com/$REPO/$BRANCH"
    foreach ($file in $REFERENCE_FILES) {
        $outPath = Join-Path $REFERENCES_DIR $file
        if (Download-File "$baseUrl/skill/references/$file" $outPath) {
            Write-Ok "references/$file"
        }
        else {
            Write-Warn "references/$file (download failed)"
        }
    }
}

# -- Install Workflow Files (path-rewritten) --
Write-Host ""
Write-Info "Installing workflow files..."
Write-Host ""

$WORKFLOWS_DIR = Join-Path $SKILL_DIR "workflows"
New-Item -ItemType Directory -Force -Path $WORKFLOWS_DIR | Out-Null

$localWorkflowsDir = if ($ScriptDir) { Join-Path $ScriptDir "skill\workflows" } else { "" }

if ($ScriptDir -and (Test-Path $localWorkflowsDir)) {
    foreach ($src in (Get-ChildItem -Path $localWorkflowsDir -Filter "*.md")) {
        $dst = Join-Path $WORKFLOWS_DIR $src.Name
        Copy-WithRewrite -Src $src.FullName -Dst $dst
        Write-Ok "workflows/$($src.Name)"
    }
}
else {
    $baseUrl = "https://raw.githubusercontent.com/$REPO/$BRANCH"
    foreach ($file in $WORKFLOW_FILES) {
        $outPath = Join-Path $WORKFLOWS_DIR $file
        if (Download-FileWithRewrite "$baseUrl/skill/workflows/$file" $outPath) {
            Write-Ok "workflows/$file"
        }
        else {
            Write-Warn "workflows/$file (download failed)"
        }
    }
}

# -- Install Script Files (skill/scripts/ -> $SKILL_DIR/scripts/) --
Write-Host ""
Write-Info "Installing script files..."
Write-Host ""

$SCRIPTS_DEST = Join-Path $SKILL_DIR "scripts"
New-Item -ItemType Directory -Force -Path $SCRIPTS_DEST | Out-Null

$localDownloadJs = if ($ScriptDir) { Join-Path $ScriptDir "skill\scripts\download-app.js" } else { "" }

if ($ScriptDir -and (Test-Path $localDownloadJs)) {
    Copy-Item -Force (Join-Path $ScriptDir "skill\scripts\*.js") $SCRIPTS_DEST -ErrorAction SilentlyContinue
    foreach ($file in (Get-ChildItem -Path $SCRIPTS_DEST -Filter "*.js")) {
        Write-Ok "scripts/$($file.Name)"
    }
    $SCRIPTS_LIB_DEST = Join-Path $SCRIPTS_DEST "lib"
    New-Item -ItemType Directory -Force -Path $SCRIPTS_LIB_DEST | Out-Null
    Copy-Item -Force (Join-Path $ScriptDir "skill\scripts\lib\*.js") $SCRIPTS_LIB_DEST -ErrorAction SilentlyContinue
    foreach ($file in (Get-ChildItem -Path $SCRIPTS_LIB_DEST -Filter "*.js")) {
        Write-Ok "scripts/lib/$($file.Name)"
    }
}
else {
    $baseUrl = "https://raw.githubusercontent.com/$REPO/$BRANCH"
    foreach ($file in $SCRIPT_FILES) {
        $outPath = Join-Path $SCRIPTS_DEST $file
        if (Download-File "$baseUrl/skill/scripts/$file" $outPath) {
            Write-Ok "scripts/$file"
        }
        else {
            Write-Warn "scripts/$file (download failed)"
        }
    }
    $SCRIPTS_LIB_DEST = Join-Path $SCRIPTS_DEST "lib"
    New-Item -ItemType Directory -Force -Path $SCRIPTS_LIB_DEST | Out-Null
    foreach ($file in $SCRIPT_LIB_FILES) {
        $outPath = Join-Path $SCRIPTS_LIB_DEST $file
        if (Download-File "$baseUrl/skill/scripts/lib/$file" $outPath) {
            Write-Ok "scripts/lib/$file"
        }
        else {
            Write-Warn "scripts/lib/$file (download failed)"
        }
    }
}

# -- Install Rule Files (rules/*.mdc -> $RULES_DIR/*.md, frontmatter stripped, paths rewritten) --
Write-Host ""
Write-Info "Installing rule files..."
Write-Host ""

$localRulesDir = if ($ScriptDir) { Join-Path $ScriptDir "rules" } else { "" }

if ($ScriptDir -and (Test-Path $localRulesDir)) {
    foreach ($src in (Get-ChildItem -Path $localRulesDir -Filter "*.mdc")) {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($src.Name)
        $dst = Join-Path $RULES_DIR "$base.md"
        Copy-RuleStripFrontmatter -Src $src.FullName -Dst $dst
        Write-Ok "rules/$base.md"
    }
}
else {
    $baseUrl = "https://raw.githubusercontent.com/$REPO/$BRANCH"
    foreach ($file in $RULE_FILES) {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($file)
        $outPath = Join-Path $RULES_DIR "$base.md"
        if (Download-RuleStripFrontmatter "$baseUrl/rules/$file" $outPath) {
            Write-Ok "rules/$base.md"
        }
        else {
            Write-Warn "rules/$file (download failed)"
        }
    }
}

# -- Install MCP Server --
Write-Host ""
Write-Info "Installing MCP server..."
Write-Host ""

New-Item -ItemType Directory -Force -Path (Join-Path $MCP_SERVER_DIR "lib") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $MCP_SERVER_DIR "tools") | Out-Null

$localMcpIndex = if ($ScriptDir) { Join-Path $ScriptDir "mcp-server\index.ts" } else { "" }

if ($ScriptDir -and (Test-Path $localMcpIndex)) {
    foreach ($file in $MCP_SERVER_FILES) {
        # MCP_SERVER_FILES uses forward slashes; normalize for Windows source path.
        $relWin = $file.Replace("/", "\")
        $src = Join-Path $ScriptDir "mcp-server\$relWin"
        if (Test-Path $src) {
            $dest = Join-Path $MCP_SERVER_DIR $relWin
            $destDir = Split-Path $dest -Parent
            if (-not (Test-Path $destDir)) {
                New-Item -ItemType Directory -Force -Path $destDir | Out-Null
            }
            Copy-Item -Force $src $dest
            Write-Ok "mcp-server/$file"
        }
        else {
            Write-Warn "mcp-server/$file (not found, skipped)"
        }
    }
}
else {
    $baseUrl = "https://raw.githubusercontent.com/$REPO/$BRANCH"
    foreach ($file in $MCP_SERVER_FILES) {
        $relWin = $file.Replace("/", "\")
        $outPath = Join-Path $MCP_SERVER_DIR $relWin
        if (Download-File "$baseUrl/mcp-server/$file" $outPath) {
            Write-Ok "mcp-server/$file"
        }
        else {
            Write-Warn "mcp-server/$file (download failed)"
        }
    }
}

$McpConfigured = $false
$mcpPackageJson = Join-Path $MCP_SERVER_DIR "package.json"

if (Test-Path $mcpPackageJson) {
    Write-Host ""
    Write-Info "Installing MCP server dependencies (npm install)..."

    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) {
        Push-Location $MCP_SERVER_DIR
        try {
            & npm install --silent 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Ok "MCP server dependencies installed"
            }
            else {
                Write-Warn "npm install failed - run manually: cd $MCP_SERVER_DIR && npm install"
            }

            Write-Info "Building MCP server (npm run build)..."
            & npm run build 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Ok "MCP server built successfully"
            }
            else {
                Write-Warn "Build failed - run manually: cd $MCP_SERVER_DIR && npm run build"
            }
        }
        finally {
            Pop-Location
        }
    }
    else {
        Write-Warn "npm not found - install Node.js and run: cd $MCP_SERVER_DIR && npm install && npm run build"
    }

    # -- MCP Server Configuration --
    Write-Host ""
    Write-Host "  ==============================================" -ForegroundColor White
    Write-Host "    MCP Server Setup (Shared App Context)        " -ForegroundColor White
    Write-Host "  ==============================================" -ForegroundColor White
    Write-Host ""
    Write-Host "  The MCP server enables team-wide sharing of app contexts via Pinecone."
    Write-Host "  You'll need a Pinecone API key and an OpenAI API key."
    Write-Host ""

    $envPath = Join-Path $MCP_SERVER_DIR ".env"
    if (Test-Path $envPath) {
        Write-Info "Existing .env found - skipping key setup."
        $McpConfigured = $true
    }
    else {
        $setupMcp = Read-Host "  Set up MCP server now? [y/n]"
        Write-Host ""

        if ($setupMcp -match "^[Yy]$") {
            $pineconeKey = Read-Host "  Pinecone API Key"
            $openaiKey = Read-Host "  OpenAI API Key"
            $pineconeIndex = Read-Host "  Pinecone Index Name (default: make-app-contexts)"
            if (-not $pineconeIndex) { $pineconeIndex = "make-app-contexts" }

            @"
# Pinecone
PINECONE_API_KEY=$pineconeKey
PINECONE_INDEX_NAME=$pineconeIndex

# OpenAI (for text-embedding-3-small)
OPENAI_API_KEY=$openaiKey
"@ | Set-Content -Path $envPath -Encoding UTF8

            Write-Ok ".env created"
            $McpConfigured = $true
        }
        else {
            Write-Info "Skipping MCP server setup. You can configure it later:"
            Write-Host "      cd $MCP_SERVER_DIR" -ForegroundColor Cyan
            Write-Host "      cp .env.example .env  # fill in API keys" -ForegroundColor Cyan
            Write-Host ""
        }
    }
}

# -- Register MCP Server in $CLAUDE_JSON --
Write-Host ""
Write-Info "Registering MCP server in $CLAUDE_JSON..."

# Clean up stale config from earlier buggy installer (<= 1.13.6) that wrote to
# the wrong path ~/.claude/claude.json. Only remove if it contains nothing but
# our orphan mcpServers entry.
$StaleClaudeJson = Join-Path $CLAUDE_HOME "claude.json"
if ((Test-Path $StaleClaudeJson) -and ($StaleClaudeJson -ne $CLAUDE_JSON)) {
    if (Select-String -Path $StaleClaudeJson -Pattern '"make-custom-app"' -SimpleMatch -Quiet) {
        try {
            $stale = Get-Content $StaleClaudeJson -Raw | ConvertFrom-Json
            $topKeys = @($stale.PSObject.Properties.Name)
            $mcpKeys = @()
            if ($stale.mcpServers) {
                $mcpKeys = @($stale.mcpServers.PSObject.Properties.Name)
            }
            if ($topKeys.Count -eq 1 -and $topKeys[0] -eq 'mcpServers' -and $mcpKeys.Count -eq 1 -and $mcpKeys[0] -eq 'make-custom-app') {
                Remove-Item -Force $StaleClaudeJson
                Write-Ok "Removed stale $StaleClaudeJson (left over from earlier installer bug)"
            }
            else {
                Write-Warn "$StaleClaudeJson contains unrelated config - leaving it untouched."
            }
        }
        catch {
            Write-Warn "Could not parse stale $StaleClaudeJson - leaving it untouched."
        }
    }
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Warn "node not found - cannot register MCP server. Install Node.js and re-run."
}
else {
    # Use forward slashes for the dist/index.js path — Node.js handles them on Windows.
    $McpIndexJs = ($MCP_SERVER_DIR.Replace("\", "/")) + "/dist/index.js"
    $McpEnvFile = ($MCP_SERVER_DIR.Replace("\", "/")) + "/.env"

    $env:CLAUDE_JSON_PATH = $CLAUDE_JSON
    $env:MCP_INDEX_JS = $McpIndexJs
    $env:MCP_ENV_FILE = $McpEnvFile

    $nodeScript = @'
const fs = require('fs');
const path = require('path');
const file = process.env.CLAUDE_JSON_PATH;
const indexJs = process.env.MCP_INDEX_JS;
const envFile = process.env.MCP_ENV_FILE;
const KEY = 'make-custom-app';

function parseEnvFile(p) {
    if (!p || !fs.existsSync(p)) return {};
    const out = {};
    for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return out;
}

const envVars = parseEnvFile(envFile);
const mcpEnv = {};
for (const k of ['PINECONE_API_KEY', 'OPENAI_API_KEY', 'PINECONE_INDEX_NAME']) {
    if (envVars[k]) mcpEnv[k] = envVars[k];
}

let cfg = {};
let existed = false;
if (fs.existsSync(file)) {
    existed = true;
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
        console.error(`[register] Could not parse existing ${file} - leaving it alone.`);
        process.exit(2);
    }
}

if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') {
    cfg.mcpServers = {};
}

// Absolute node path — Claude Code (and Cursor) launched from a GUI shortcut
// inherits no shell PATH, so a literal 'node' fails with `spawn node ENOENT`.
const NODE_BIN = process.execPath;

const existingEntry = cfg.mcpServers[KEY];
const needsUpdate = !existingEntry
    || existingEntry.command !== NODE_BIN
    || existingEntry.args?.[0] !== indexJs
    || JSON.stringify(existingEntry.env || {}) !== JSON.stringify(mcpEnv);

if (!needsUpdate) {
    console.log('skip');
    process.exit(0);
}

cfg.mcpServers[KEY] = {
    command: NODE_BIN,
    args: [indexJs],
    env: mcpEnv
};

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log(existed ? (existingEntry ? 'updated' : 'added') : 'created');
'@

    # Write the inline script to a temp file and exec node against it
    $tmpJs = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "mcp-register-$([guid]::NewGuid().ToString('N')).js")
    try {
        [System.IO.File]::WriteAllText($tmpJs, $nodeScript, (New-Object System.Text.UTF8Encoding $false))
        & node $tmpJs
        $regResult = $LASTEXITCODE
        if ($regResult -eq 0) {
            if ((Test-Path $CLAUDE_JSON) -and (Select-String -Path $CLAUDE_JSON -Pattern '"make-custom-app"' -SimpleMatch -Quiet)) {
                Write-Ok "MCP server registered (key 'make-custom-app' present in $CLAUDE_JSON)"
            }
            else {
                Write-Warn "MCP registration produced no error but key not visible in $CLAUDE_JSON"
            }
        }
        elseif ($regResult -eq 2) {
            Write-Warn "Existing $CLAUDE_JSON could not be parsed - left untouched."
        }
        else {
            Write-Warn "MCP registration failed (exit $regResult)"
        }
    }
    finally {
        if (Test-Path $tmpJs) { Remove-Item -Force $tmpJs }
        Remove-Item Env:CLAUDE_JSON_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:MCP_INDEX_JS -ErrorAction SilentlyContinue
        Remove-Item Env:MCP_ENV_FILE -ErrorAction SilentlyContinue
    }
}

# -- Append Skill Section to $CLAUDE_MD (idempotent via sentinel) --
Write-Host ""
Write-Info "Wiring skill into $CLAUDE_MD..."

$Sentinel = '<!-- make-custom-app-skill -->'
$alreadyWired = $false
if (Test-Path $CLAUDE_MD) {
    $existing = Get-Content $CLAUDE_MD -Raw
    if ($existing -and $existing.Contains($Sentinel)) {
        $alreadyWired = $true
    }
}

if ($alreadyWired) {
    Write-Info "Skill section already present in $CLAUDE_MD - skipping append."
}
else {
    $claudeMdParent = Split-Path $CLAUDE_MD -Parent
    if (-not (Test-Path $claudeMdParent)) {
        New-Item -ItemType Directory -Force -Path $claudeMdParent | Out-Null
    }

    $section = @"
$Sentinel
# Make Custom App Skill

For any Make.com custom app work — building, debugging, reviewing, or managing Make integrations — delegate to the ``make-integration-engineer`` sub-agent.
"@

    if ((Test-Path $CLAUDE_MD) -and ((Get-Item $CLAUDE_MD).Length -gt 0)) {
        $existing = Get-Content $CLAUDE_MD -Raw
        # Ensure single blank line separator before our section
        if (-not $existing.EndsWith("`n")) {
            $existing += "`n"
        }
        if (-not $existing.EndsWith("`n`n")) {
            $existing += "`n"
        }
        $newContent = $existing + $section + "`n"
        [System.IO.File]::WriteAllText($CLAUDE_MD, $newContent, (New-Object System.Text.UTF8Encoding $false))
    }
    else {
        [System.IO.File]::WriteAllText($CLAUDE_MD, $section + "`n", (New-Object System.Text.UTF8Encoding $false))
    }
    Write-Ok "Skill section appended to $CLAUDE_MD"
}

# -- Install Claude Code Agent Definition --
Write-Host ""
Write-Info "Installing make-integration-engineer agent..."

New-Item -ItemType Directory -Force -Path $AGENTS_DIR | Out-Null
$AgentDst = Join-Path $AGENTS_DIR "make-integration-engineer.md"
$AgentKey = "make-integration-engineer"

$agentAlreadyExists = $false
if (Test-Path $AgentDst) {
    if (Select-String -Path $AgentDst -Pattern "name: $AgentKey" -SimpleMatch -Quiet) {
        $agentAlreadyExists = $true
    }
}

# Forward slashes in the placeholder substitution — the agent file uses the value
# inside @-import paths inside markdown, where forward slashes are conventional.
$skillDirForwardSlash = $SKILL_DIR.Replace("\", "/")

function Install-Agent {
    param([string]$Src)
    $content = Get-Content -Path $Src -Raw
    $content = $content.Replace("{{SKILLS_DIR}}", $skillDirForwardSlash)
    [System.IO.File]::WriteAllText($AgentDst, $content, (New-Object System.Text.UTF8Encoding $false))
}

if ($agentAlreadyExists -and $Mode -eq "install") {
    Write-Info "Agent already installed at $AgentDst - skipping (use -Mode update to overwrite)."
}
elseif ($ScriptDir -and (Test-Path (Join-Path $ScriptDir "subagents\make-integration-engineer.md"))) {
    Install-Agent -Src (Join-Path $ScriptDir "subagents\make-integration-engineer.md")
    Write-Ok "make-integration-engineer agent installed to $AgentDst"
}
else {
    $baseUrl = "https://raw.githubusercontent.com/$REPO/$BRANCH"
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        Invoke-WebRequest -Uri "$baseUrl/subagents/make-integration-engineer.md" -OutFile $tmp -UseBasicParsing -ErrorAction Stop
        Install-Agent -Src $tmp
        Write-Ok "make-integration-engineer agent installed to $AgentDst"
    }
    catch {
        Write-Warn "make-integration-engineer.md (download failed)"
    }
    finally {
        if (Test-Path $tmp) { Remove-Item -Force $tmp }
    }
}

# -- Restore User Config --
$skillMdPath = Join-Path $SKILL_DIR "SKILL.md"
if (Test-Path $skillMdPath) {
    if ($SavedMcpPath) {
        Add-Content -Path $skillMdPath -Value "`n$SavedMcpPath"
        Write-Ok "Restored user config (mcp-server-path)"
    }
    if ($SavedRuntimePath) {
        Add-Content -Path $skillMdPath -Value "`n$SavedRuntimePath"
        Write-Ok "Restored user config (imt-app-runtime-path)"
    }
    if ($SavedMockupPath) {
        Add-Content -Path $skillMdPath -Value "$SavedMockupPath"
        Write-Ok "Restored user config (make-apps-mockup-path)"
    }
    if ($SavedJiraEmail) {
        Add-Content -Path $skillMdPath -Value "$SavedJiraEmail"
        Write-Ok "Restored user config (jira-email)"
    }
    if ($SavedJiraToken) {
        Add-Content -Path $skillMdPath -Value "$SavedJiraToken"
        Write-Ok "Restored user config (jira-api-token)"
    }
    if ($SavedJiraBaseUrl) {
        Add-Content -Path $skillMdPath -Value "$SavedJiraBaseUrl"
        Write-Ok "Restored user config (jira-base-url)"
    }
    if ($SavedMakeApiKey) {
        Add-Content -Path $skillMdPath -Value "$SavedMakeApiKey"
        Write-Ok "Restored user config (make-api-key)"
    }
    if ($SavedMakeApiUrl) {
        Add-Content -Path $skillMdPath -Value "$SavedMakeApiUrl"
        Write-Ok "Restored user config (make-api-url)"
    }
}

# -- Verify Installation --
Write-Host ""
$downloadJsPath = Join-Path $SKILL_DIR "scripts\download-app.js"

if ((Test-Path $skillMdPath) -and (Test-Path $downloadJsPath)) {
    $installedVersion = ""
    $versionLine = Select-String -Path $skillMdPath -Pattern "^version:" | Select-Object -First 1
    if ($versionLine) {
        $installedVersion = ($versionLine.Line -replace "^version:\s*", "").Trim()
    }

    Write-Host ""
    Write-Host "  ==============================================" -ForegroundColor Green
    if ($Mode -eq "update") {
        Write-Host "    Update Complete!" -ForegroundColor Green
    }
    else {
        Write-Host "    Installation Complete!" -ForegroundColor Green
    }
    if ($installedVersion) {
        Write-Host "    Version: $installedVersion" -ForegroundColor Green
    }
    Write-Host "  ==============================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Installed to:"
    Write-Host "    Skill:          $SKILL_DIR"
    Write-Host "    Rules:          $RULES_DIR"
    Write-Host "    Wired in:       $CLAUDE_MD"
    Write-Host "    MCP registered: $CLAUDE_JSON"
    Write-Host ""
    Write-Host "  Next steps:"
    Write-Host "  1. Restart Claude Code"
    Write-Host "  2. Ask any Make app question - the skill activates automatically"
    Write-Host "  3. On first use, you'll be guided to clone imt-app-runtime"
    Write-Host ""
    if ($McpConfigured) {
        Write-Host "  MCP Server: " -NoNewline
        Write-Host "Configured" -ForegroundColor Green
        Write-Host "  Restart Claude Code to activate shared app context via Pinecone."
    }
    else {
        Write-Host "  MCP Server: " -NoNewline
        Write-Host "Not configured" -ForegroundColor Yellow
        Write-Host "  To enable later, run:"
        Write-Host "    cd $MCP_SERVER_DIR" -ForegroundColor Cyan
        Write-Host "    cp .env.example .env  # fill in API keys" -ForegroundColor Cyan
    }
    Write-Host ""
}
else {
    Write-Fail "Installation failed. Required files are missing."
}
