#Requires -Version 5.1

# ============================================================
# Make Custom App Skill Installer for Cursor (Windows)
# ============================================================
# Usage:
#   Fresh install / Update:
#     irm https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install.ps1 | iex
#
#   Clone & install:
#     git clone https://github.com/minsu-kang/make-custom-app-skill.git
#     cd make-custom-app-skill; .\install.ps1
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

$REPO = "minsu-kang/make-custom-app-skill"
$BRANCH = "master"
$SKILL_DIR = Join-Path $env:USERPROFILE ".cursor\skills\make-custom-app"
$RULES_DIR = Join-Path $env:USERPROFILE ".cursor\rules"
$VERSION_URL = "https://raw.githubusercontent.com/$REPO/$BRANCH/version.json"

$SKILL_FILES = @("SKILL.md", "builtin-iml-functions.md", "communication-reference.md", "examples.md", "runtime-reference.md")
$SCRIPT_FILES = @("download-app.js", "review-changes.js", "update-app.js")
$RULE_FILES = @("make-app-code-review.mdc", "version-sync.mdc")
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

Write-Host ""
Write-Host "  ==============================================" -ForegroundColor White
Write-Host "    Make Custom App Skill Installer for Cursor   " -ForegroundColor White
Write-Host "  ==============================================" -ForegroundColor White
Write-Host ""

# ── Preserve User Config ──
$SavedRuntimePath = ""

if (Test-Path $SKILL_DIR) {
    $skillMdPath = Join-Path $SKILL_DIR "SKILL.md"
    if (Test-Path $skillMdPath) {
        $lastLine = (Get-Content $skillMdPath -Tail 1).Trim()
        if ($lastLine -match "^imt-app-runtime-path:") {
            $SavedRuntimePath = $lastLine
        }
    }

    switch ($Mode) {
        "update" {
            Write-Info "Updating existing installation..."
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
                "^[Uu]$" { $Mode = "update"; Write-Host "" }
                "^[Ff]$" { $Mode = "force"; Remove-Item -Recurse -Force $SKILL_DIR; Write-Host "" }
                default   { Write-Info "Installation cancelled."; exit 0 }
            }
        }
    }
}

New-Item -ItemType Directory -Force -Path $SKILL_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $RULES_DIR | Out-Null

# ── Detect Source ──
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { "" }

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

# ── Install Skill Files ──
Write-Info "Installing skill files..."
Write-Host ""

$localSkillMd = if ($ScriptDir) { Join-Path $ScriptDir "skill\SKILL.md" } else { "" }

if ($ScriptDir -and (Test-Path $localSkillMd)) {
    foreach ($file in $SKILL_FILES) {
        $src = Join-Path $ScriptDir "skill\$file"
        if (Test-Path $src) {
            Copy-Item -Force $src (Join-Path $SKILL_DIR $file)
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
        if (Download-File "$baseUrl/skill/$file" $outPath) {
            Write-Ok $file
        }
        else {
            Write-Warn "$file (download failed)"
        }
    }
}

# ── Install Script Files ──
Write-Host ""
Write-Info "Installing script files..."
Write-Host ""

$localDownloadJs = if ($ScriptDir) { Join-Path $ScriptDir "scripts\download-app.js" } else { "" }

if ($ScriptDir -and (Test-Path $localDownloadJs)) {
    foreach ($file in $SCRIPT_FILES) {
        $src = Join-Path $ScriptDir "scripts\$file"
        if (Test-Path $src) {
            Copy-Item -Force $src (Join-Path $SKILL_DIR $file)
            Write-Ok $file
        }
        else {
            Write-Warn "$file (not found, skipped)"
        }
    }
}
else {
    $baseUrl = "https://raw.githubusercontent.com/$REPO/$BRANCH"
    foreach ($file in $SCRIPT_FILES) {
        $outPath = Join-Path $SKILL_DIR $file
        if (Download-File "$baseUrl/scripts/$file" $outPath) {
            Write-Ok $file
        }
        else {
            Write-Warn "$file (download failed)"
        }
    }
}

# ── Install Rule Files ──
Write-Host ""
Write-Info "Installing rule files..."
Write-Host ""

$localRulesDir = if ($ScriptDir) { Join-Path $ScriptDir "rules" } else { "" }

if ($ScriptDir -and (Test-Path $localRulesDir)) {
    foreach ($file in $RULE_FILES) {
        $src = Join-Path $ScriptDir "rules\$file"
        if (Test-Path $src) {
            Copy-Item -Force $src (Join-Path $RULES_DIR $file)
            Write-Ok $file
        }
        else {
            Write-Warn "$file (not found, skipped)"
        }
    }
}
else {
    $baseUrl = "https://raw.githubusercontent.com/$REPO/$BRANCH"
    foreach ($file in $RULE_FILES) {
        $outPath = Join-Path $RULES_DIR $file
        if (Download-File "$baseUrl/rules/$file" $outPath) {
            Write-Ok $file
        }
        else {
            Write-Warn "$file (download failed)"
        }
    }
}

# ── Install MCP Server ──
Write-Host ""
Write-Info "Installing MCP server..."
Write-Host ""

New-Item -ItemType Directory -Force -Path (Join-Path $MCP_SERVER_DIR "lib") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $MCP_SERVER_DIR "tools") | Out-Null

$localMcpIndex = if ($ScriptDir) { Join-Path $ScriptDir "mcp-server\index.ts" } else { "" }

if ($ScriptDir -and (Test-Path $localMcpIndex)) {
    foreach ($file in $MCP_SERVER_FILES) {
        $src = Join-Path $ScriptDir "mcp-server\$file"
        if (Test-Path $src) {
            $dest = Join-Path $MCP_SERVER_DIR $file
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
        $outPath = Join-Path $MCP_SERVER_DIR $file
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

# ── Restore User Config ──
$skillMdPath = Join-Path $SKILL_DIR "SKILL.md"
if ($SavedRuntimePath -and (Test-Path $skillMdPath)) {
    $currentLast = (Get-Content $skillMdPath -Tail 1).Trim()
    if ($currentLast -notmatch "^imt-app-runtime-path:") {
        Add-Content -Path $skillMdPath -Value "`n$SavedRuntimePath"
    }
    Write-Ok "Restored user config (imt-app-runtime-path)"
}

# ── Verify Installation ──
Write-Host ""
$downloadJsPath = Join-Path $SKILL_DIR "download-app.js"

if ((Test-Path $skillMdPath) -and (Test-Path $downloadJsPath)) {
    $installedVersion = ""
    if (Test-Path $skillMdPath) {
        $versionLine = Select-String -Path $skillMdPath -Pattern "^version:" | Select-Object -First 1
        if ($versionLine) {
            $installedVersion = ($versionLine.Line -replace "^version:\s*", "").Trim()
        }
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
    Write-Host "  1. Restart Cursor"
    Write-Host "  2. Ask any Make app question - the skill activates automatically"
    Write-Host "  3. On first use, you'll be guided to clone imt-app-runtime"
    Write-Host ""
    Write-Host "  Prerequisites:"
    Write-Host "  - Make Apps SDK extension installed in VS Code/Cursor" -ForegroundColor Cyan
    Write-Host "  - API key and environment configured in extension settings" -ForegroundColor Cyan
    Write-Host ""
    if ($McpConfigured) {
        Write-Host "  MCP Server: " -NoNewline
        Write-Host "Configured and registered" -ForegroundColor Green
        Write-Host "  Restart Cursor to activate shared app context via Pinecone."
    }
    else {
        Write-Host "  MCP Server: " -NoNewline
        Write-Host "Not configured" -ForegroundColor Yellow
        Write-Host "  To enable later, run:"
        Write-Host "    cd $MCP_SERVER_DIR" -ForegroundColor Cyan
        Write-Host "    cp .env.example .env  # fill in API keys" -ForegroundColor Cyan
        Write-Host "    npm run register" -ForegroundColor Cyan
    }
    Write-Host ""
}
else {
    Write-Fail "Installation failed. Required files are missing."
}
