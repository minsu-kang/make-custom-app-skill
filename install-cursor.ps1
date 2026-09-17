#Requires -Version 5.1

# ============================================================
# Make Custom App Skill Installer for Cursor (Windows)
# ============================================================
# Usage:
#   Fresh install / Update:
#     irm https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install-cursor.ps1 | iex
#
#   Clone & install:
#     git clone https://github.com/minsu-kang/make-custom-app-skill.git
#     cd make-custom-app-skill; .\install-cursor.ps1
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
$SKILL_DIR = Join-Path $env:USERPROFILE ".cursor\skills\make-custom-app"
$RULES_DIR = Join-Path $env:USERPROFILE ".cursor\rules\make-custom-app"
$MCP_SERVER_DIR = Join-Path $SKILL_DIR "mcp-server"
$HOOKS_DIR = Join-Path $env:USERPROFILE ".cursor\hooks"
$HOOKS_JSON = Join-Path $env:USERPROFILE ".cursor\hooks.json"
$DEPRECATED_HOOK_FILES = @("make-app-auto-actions-check.js", "check-make-app-ticket-sync.js")
# Rule files installed by 1.x releases directly under ~/.cursor/rules. Removed so retired rules stop loading.
$LEGACY_RULE_FILES = @("make-app-workflow.mdc", "make-app-todo-rules.mdc", "make-app-todo-bugfix.mdc", "make-app-todo-feature.mdc", "make-app-todo-task.mdc", "make-app-todo-review.mdc", "make-app-todo-refinement.mdc", "work-discipline.mdc", "make-app-ux-guideline.mdc", "make-app-auto-actions.mdc", "make-app-code-review.mdc")

function Write-Info  { param($msg) Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Fail  { param($msg) Write-Host "  [X]  $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  ==============================================" -ForegroundColor White
Write-Host "    Make Custom App Skill Installer for Cursor   " -ForegroundColor White
Write-Host "  ==============================================" -ForegroundColor White
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
    # ── Install skill\ → $SKILL_DIR ──
    Write-Info "Installing skill files..."
    New-Item -ItemType Directory -Force -Path $SKILL_DIR | Out-Null
    Copy-Item -Path (Join-Path $SrcRoot "skill\*") -Destination $SKILL_DIR -Recurse -Force
    Get-ChildItem -Path $SKILL_DIR -Recurse -Force -Filter ".DS_Store" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    $fileCount = (Get-ChildItem -Path $SKILL_DIR -Recurse -File | Measure-Object).Count
    Write-Ok "skill/ ($fileCount files)"

    # ── Install rules\ → $RULES_DIR (replaced wholesale) ──
    Write-Info "Installing rule files..."
    if (Test-Path $RULES_DIR) { Remove-Item -Recurse -Force $RULES_DIR }
    New-Item -ItemType Directory -Force -Path $RULES_DIR | Out-Null
    Copy-Item -Path (Join-Path $SrcRoot "rules\*.mdc") -Destination $RULES_DIR -Force
    foreach ($f in (Get-ChildItem -Path $RULES_DIR -Filter "*.mdc")) { Write-Ok "rules/$($f.Name)" }
    $oldRulesDir = Join-Path $env:USERPROFILE ".cursor\rules"
    foreach ($f in $LEGACY_RULE_FILES) {
        $p = Join-Path $oldRulesDir $f
        if (Test-Path $p) { Remove-Item -Force $p }
    }

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

# ── Cleanup deprecated stop hooks from releases before 1.12.0 ──
if (Test-Path $HOOKS_DIR) {
    foreach ($file in $DEPRECATED_HOOK_FILES) {
        $hookPath = Join-Path $HOOKS_DIR $file
        if (Test-Path $hookPath) {
            Remove-Item -Force $hookPath
            Write-Ok "removed hooks/$file"
        }
    }
}

if (Test-Path $HOOKS_JSON) {
    try {
        $cfg = Get-Content $HOOKS_JSON -Raw | ConvertFrom-Json
        if ($cfg -and ($cfg.PSObject.Properties.Name -contains 'hooks') -and $cfg.hooks `
            -and ($cfg.hooks.PSObject.Properties.Name -contains 'stop') -and $cfg.hooks.stop) {
            $deprecatedCmds = @(
                "node ./hooks/make-app-auto-actions-check.js",
                "node ./hooks/check-make-app-ticket-sync.js"
            )
            $stopList = @($cfg.hooks.stop)
            $filtered = @()
            $pruned = $false
            foreach ($h in $stopList) {
                if ($h -and ($h.PSObject.Properties.Name -contains 'command') -and ($deprecatedCmds -contains $h.command)) {
                    $pruned = $true
                    continue
                }
                $filtered += $h
            }
            if ($pruned) {
                if ($filtered.Count -eq 0) {
                    $cfg.hooks.PSObject.Properties.Remove('stop')
                } else {
                    $cfg.hooks.stop = $filtered
                }
                $cfg | ConvertTo-Json -Depth 10 | Set-Content -Path $HOOKS_JSON -Encoding UTF8
                Write-Ok "hooks.json (deprecated stop hooks pruned)"
            }
        }
    }
    catch {
        # Silent — never block install on hooks.json parse failure
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
        Write-Info "Non-interactive update - skipping MCP key setup (cd $MCP_SERVER_DIR; copy .env.example .env; npm run register)."
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
            Write-Host "      npm run register" -ForegroundColor Cyan
            Write-Host ""
        }
    }

    $registerJs = Join-Path $MCP_SERVER_DIR "register.js"
    if ($McpConfigured -and $npmCmd -and (Test-Path $registerJs)) {
        Write-Info "Registering MCP server with Cursor..."
        Push-Location $MCP_SERVER_DIR
        try {
            & node register.js 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Ok "MCP server registered with Cursor"
            }
            else {
                Write-Warn "Registration failed - run manually: cd $MCP_SERVER_DIR && npm run register"
            }
        }
        finally {
            Pop-Location
        }
    }
}

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
    Write-Host "    Skill: $SKILL_DIR"
    Write-Host "    Rules: $RULES_DIR"
    Write-Host ""
    Write-Host "  Next steps:"
    Write-Host "  1. Restart Cursor (rule changes load on restart)"
    Write-Host "  2. Fill in API keys and paths in your terminal:"
    Write-Host "     node $(Join-Path $SKILL_DIR 'scripts\setup-secrets.js')" -ForegroundColor Cyan
    Write-Host "  3. Ask any Make app question - the skill activates automatically"
    Write-Host "  4. Check your setup any time: node $checkSetupPath" -ForegroundColor Cyan
    Write-Host "     User config (paths, API keys) lives in $SECRETS_FILE - never in SKILL.md"
    Write-Host ""
    Write-Host "  Prerequisites:"
    Write-Host "  - Make Apps SDK extension installed in VS Code/Cursor" -ForegroundColor Cyan
    Write-Host "  - API key and environment configured in extension settings" -ForegroundColor Cyan
    Write-Host "  - imt-app-runtime cloned locally (setup-secrets.js walks you through this)" -ForegroundColor Cyan
    Write-Host ""
    if ($McpConfigured) {
        Write-Host "  MCP Server: " -NoNewline
        Write-Host "Configured and registered" -ForegroundColor Green
    }
    else {
        Write-Host "  MCP Server: " -NoNewline
        Write-Host "Not configured - run setup-secrets.js and opt in to MCP" -ForegroundColor Yellow
    }
    Write-Host ""
}
else {
    Write-Fail "Installation failed. Required files are missing."
}
