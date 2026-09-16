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
#
# Source resolution: when run from a local clone the clone is copied; when
# piped from irm the whole repo archive (zip) is downloaded once and
# extracted, so no file list is maintained here.
# ============================================================

param(
    [ValidateSet("install", "update", "force")]
    [string]$Mode = "install"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Force TLS 1.2 for HTTPS — required for GitHub on PowerShell 5.1.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$REPO = "minsu-kang/make-custom-app-skill"
$BRANCH = "master"
$CLAUDE_HOME = Join-Path $env:USERPROFILE ".claude"
$SKILL_DIR = Join-Path $CLAUDE_HOME "skills\make-custom-app"
$AGENTS_DIR = Join-Path $CLAUDE_HOME "agents"
$AGENT_DST = Join-Path $AGENTS_DIR "make-integration-engineer.md"
$CLAUDE_MD = Join-Path $CLAUDE_HOME "CLAUDE.md"
$CLAUDE_JSON = Join-Path $HOME ".claude.json"
$MCP_SERVER_DIR = Join-Path $SKILL_DIR "mcp-server"

function Write-Info  { param($msg) Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Fail  { param($msg) Write-Host "  [X]  $msg" -ForegroundColor Red; exit 1 }

# Main session loads the skill directly. Closing sentinel lets -Mode update replace the block.
$SkillSection = @'
<!-- make-custom-app-skill -->
# Make Custom App Skill

When the conversation involves a Make.com custom app, IMLJSON, the Make Apps SDK, `make-app-contexts`, or an IEN Jira ticket about an app: invoke the `make-custom-app` skill before any other action and follow it. Do not answer from memory. Do not delegate this work to a sub-agent.
<!-- /make-custom-app-skill -->
'@

function Remove-SkillSection {
    param([string]$Path)
    $lines = @(Get-Content -Path $Path)
    $start = '<!-- make-custom-app-skill -->'
    $end = '<!-- /make-custom-app-skill -->'
    $hasEnd = $false
    foreach ($line in $lines) {
        if ($line -eq $end) { $hasEnd = $true; break }
    }
    $out = New-Object System.Collections.Generic.List[string]
    if ($hasEnd) {
        $skip = $false
        foreach ($line in $lines) {
            if ($line -eq $start) { $skip = $true; continue }
            if ($line -eq $end) { $skip = $false; continue }
            if (-not $skip) { $out.Add($line) }
        }
    }
    else {
        $skip = $false
        $phase = 'none'
        foreach ($line in $lines) {
            if (-not $skip -and $line -eq $start) {
                $skip = $true
                $phase = 'after_start'
                continue
            }
            if ($skip -and $phase -eq 'after_start') {
                if ($line -eq '# Make Custom App Skill' -or $line -eq '') { continue }
                $phase = 'body'
                continue
            }
            if ($skip -and $phase -eq 'body') {
                if ($line -eq '') { $skip = $false; continue }
                continue
            }
            $out.Add($line)
        }
    }
    while ($out.Count -gt 0 -and [string]::IsNullOrWhiteSpace($out[$out.Count - 1])) {
        $out.RemoveAt($out.Count - 1)
    }
    return $out
}

function Set-ClaudeMdSkillSection {
    Write-Info "Wiring skill into $CLAUDE_MD..."
    $claudeMdParent = Split-Path $CLAUDE_MD -Parent
    if (-not (Test-Path $claudeMdParent)) {
        New-Item -ItemType Directory -Force -Path $claudeMdParent | Out-Null
    }
    $body = New-Object System.Collections.Generic.List[string]
    if ((Test-Path $CLAUDE_MD) -and ((Get-Item $CLAUDE_MD).Length -gt 0)) {
        $body = Remove-SkillSection -Path $CLAUDE_MD
    }
    if ($body.Count -gt 0) {
        $text = ($body -join "`n") + "`n`n" + $SkillSection + "`n"
    }
    else {
        $text = $SkillSection + "`n"
    }
    [System.IO.File]::WriteAllText($CLAUDE_MD, $text, (New-Object System.Text.UTF8Encoding $false))
    Write-Ok "Skill section written to $CLAUDE_MD"
}

function Remove-LegacyAgent {
    if (Test-Path $AGENT_DST) {
        Remove-Item -Force $AGENT_DST
        Write-Ok "Removed leftover make-integration-engineer agent ($AGENT_DST)"
    }
}

# Safety net: rewrite any leftover Cursor-path literal so files work under ~/.claude.
# The skill uses ${SKILL_ROOT} placeholders, so this is normally a no-op.
function Copy-MarkdownRewritten {
    param([string]$Src, [string]$Dst)
    $parentDir = Split-Path $Dst -Parent
    if (-not (Test-Path $parentDir)) { New-Item -ItemType Directory -Force -Path $parentDir | Out-Null }
    $content = Get-Content -Path $Src -Raw
    if ($null -ne $content) {
        $content = $content.Replace("~/.cursor/skills/make-custom-app", "~/.claude/skills/make-custom-app")
    }
    [System.IO.File]::WriteAllText($Dst, $content, (New-Object System.Text.UTF8Encoding $false))
}

Write-Host ""
Write-Host "  ==================================================" -ForegroundColor White
Write-Host "    Make Custom App Skill Installer for Claude      " -ForegroundColor White
Write-Host "  ==================================================" -ForegroundColor White
Write-Host ""

# ── User config lives in ~/.make-custom-app-skill-secrets (never inside the skill dir) ──
$SECRETS_FILE = Join-Path $env:USERPROFILE ".make-custom-app-skill-secrets"
$CONFIG_KEYS = @("imt-app-runtime-path", "make-api-key", "make-api-url", "make-apps-mockup-path", "jira-email", "jira-api-token", "jira-base-url", "mcp-server-path")

# Pre-2.0 installs appended config to the tail of SKILL.md, which the AI agent reads every
# session. Move any real values into the secrets file (existing secrets-file keys win).
function Move-TailConfig {
    $src = Join-Path $SKILL_DIR "SKILL.md"
    if (-not (Test-Path $src)) { return }
    $lines = Get-Content $src | Where-Object { $_ -notmatch '^\s*>' }
    $existing = @()
    if (Test-Path $SECRETS_FILE) { $existing = Get-Content $SECRETS_FILE }
    $migrated = $false
    foreach ($key in $CONFIG_KEYS) {
        $line = ($lines | Where-Object { $_ -match "^$key\s*:" } | Select-Object -Last 1) -join ""
        if (-not $line) { continue }
        $val = ($line -replace "^$key\s*:\s*", "").Trim()
        if (-not $val) { continue }
        if ($val -match 'your-|<|@example\.com|ATATT3x\.\.\.|/path/provided/by/user|/path/to/|\{path-to') { continue }
        if ($existing | Where-Object { $_ -match "^$key\s*:" }) { continue }
        Add-Content -Path $SECRETS_FILE -Value "$key`: $val" -Encoding UTF8
        $migrated = $true
    }
    if ($migrated) {
        try {
            $acl = Get-Acl $SECRETS_FILE
            $acl.SetAccessRuleProtection($true, $false)
            $acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME, "FullControl", "Allow")
            $acl.AddAccessRule($rule)
            Set-Acl $SECRETS_FILE $acl
        } catch { }
        Write-Ok "Moved user config from SKILL.md to $SECRETS_FILE"
    }
}

# ── Preserve User Config ──
$SavedEnv = ""

if (Test-Path $SKILL_DIR) {
    Move-TailConfig

    $savedEnvFile = Join-Path $MCP_SERVER_DIR ".env"
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

# ── Resolve Source (local clone or GitHub archive) ──
$CleanupTmp = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "skill\SKILL.md"))) {
    $SrcRoot = $PSScriptRoot
    Write-Info "Using local source: $SrcRoot"
}
else {
    $CleanupTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("make-custom-app-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $CleanupTmp | Out-Null
    $zipPath = Join-Path $CleanupTmp "src.zip"
    Write-Info "Downloading $REPO@$BRANCH archive..."
    try {
        Invoke-WebRequest -Uri "https://github.com/$REPO/archive/refs/heads/$BRANCH.zip" -OutFile $zipPath -UseBasicParsing -ErrorAction Stop
        Expand-Archive -Path $zipPath -DestinationPath $CleanupTmp -Force
    }
    catch {
        Write-Fail "Download failed: $($_.Exception.Message)"
    }
    $SrcRoot = Join-Path $CleanupTmp ("$($REPO.Split('/')[1])-$BRANCH")
    if (-not (Test-Path (Join-Path $SrcRoot "skill\SKILL.md"))) {
        Write-Fail "Archive layout unexpected - skill\SKILL.md not found."
    }
}
Write-Host ""

try {
    # ── Install skill\ → $SKILL_DIR (markdown path-rewritten) ──
    Write-Info "Installing skill files..."
    New-Item -ItemType Directory -Force -Path $SKILL_DIR | Out-Null
    $skillSrc = Join-Path $SrcRoot "skill"
    Get-ChildItem -Path $skillSrc -Recurse -File -Force |
        Where-Object { $_.Name -ne ".DS_Store" } |
        ForEach-Object {
            $rel = $_.FullName.Substring($skillSrc.Length).TrimStart('\', '/')
            $dst = Join-Path $SKILL_DIR $rel
            if ($_.Extension -eq ".md") {
                Copy-MarkdownRewritten -Src $_.FullName -Dst $dst
            }
            else {
                New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
                Copy-Item -Force $_.FullName $dst
            }
        }
    $legacyRules = Join-Path $SKILL_DIR "rules"   # 1.x installed rule copies here
    if (Test-Path $legacyRules) { Remove-Item -Recurse -Force $legacyRules }
    $fileCount = (Get-ChildItem -Path $SKILL_DIR -Recurse -File | Measure-Object).Count
    Write-Ok "skill/ ($fileCount files)"

    # ── Install mcp-server\ source → $MCP_SERVER_DIR ──
    Write-Host ""
    Write-Info "Installing MCP server source..."
    New-Item -ItemType Directory -Force -Path $MCP_SERVER_DIR | Out-Null
    $mcpSrc = Join-Path $SrcRoot "mcp-server"
    Get-ChildItem -Path $mcpSrc -Recurse -File -Force |
        Where-Object { $_.FullName -notmatch '[\\/](node_modules|dist)[\\/]' -and $_.Name -ne ".env" -and $_.Name -ne ".DS_Store" } |
        ForEach-Object {
            $rel = $_.FullName.Substring($mcpSrc.Length).TrimStart('\', '/')
            $dst = Join-Path $MCP_SERVER_DIR $rel
            New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
            Copy-Item -Force $_.FullName $dst
        }
    Write-Ok "mcp-server/ source copied"
    if ($SavedEnv) {
        Set-Content -Path (Join-Path $MCP_SERVER_DIR ".env") -Value $SavedEnv -Encoding UTF8
        Write-Ok "mcp-server/.env preserved"
    }
}
finally {
    if ($CleanupTmp -and (Test-Path $CleanupTmp)) {
        Remove-Item -Recurse -Force $CleanupTmp -ErrorAction SilentlyContinue
    }
}

# ── Build MCP Server ──
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

    # ── MCP Server Configuration ──
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
    elseif ($Mode -eq "update") {
        Write-Info "Non-interactive update - skipping MCP key setup (cd $MCP_SERVER_DIR; copy .env.example .env; re-run this installer)."
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
            Write-Host "      copy .env.example .env  # fill in API keys" -ForegroundColor Cyan
            Write-Host ""
        }
    }
}

# ── Register MCP Server in $CLAUDE_JSON ──
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

// Absolute node path — Claude Code launched from a GUI shortcut inherits no
// shell PATH, so a literal 'node' fails with `spawn node ENOENT`.
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

# ── Wire skill into $CLAUDE_MD (replace existing sentinel block) ──
Write-Host ""
Set-ClaudeMdSkillSection

# ── Remove leftover Claude Code sub-agent (Make work now runs in the main session) ──
Write-Host ""
Remove-LegacyAgent

# ── Verify Installation ──
Write-Host ""
$skillMdPath = Join-Path $SKILL_DIR "SKILL.md"
$downloadJsPath = Join-Path $SKILL_DIR "scripts\download-app.js"
$checkSetupPath = Join-Path $SKILL_DIR "scripts\check-setup.js"

if ((Test-Path $skillMdPath) -and (Test-Path $downloadJsPath) -and (Test-Path $checkSetupPath)) {
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
    Write-Host "    Wired in:       $CLAUDE_MD"
    Write-Host "    MCP registered: $CLAUDE_JSON"
    Write-Host ""
    Write-Host "  Next steps:"
    Write-Host "  1. Restart Claude Code"
    Write-Host "  2. Ask any Make app question - the skill activates automatically"
    Write-Host "  3. Check your setup any time: node $checkSetupPath" -ForegroundColor Cyan
    Write-Host "     User config (paths, API keys) lives in $SECRETS_FILE - never in SKILL.md"
    Write-Host "     (it tells you where to add imt-app-runtime-path and make-api-key)"
    Write-Host ""
    if ($McpConfigured) {
        Write-Host "  MCP Server: " -NoNewline
        Write-Host "Configured" -ForegroundColor Green
    }
    else {
        Write-Host "  MCP Server: " -NoNewline
        Write-Host "Not configured - see check-setup.js output for the steps" -ForegroundColor Yellow
    }
    Write-Host ""
}
else {
    Write-Fail "Installation failed. Required files are missing."
}
