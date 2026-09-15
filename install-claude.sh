#!/bin/bash
set -e

# ============================================================
# Make Custom App Skill Installer for Claude Code
# ============================================================
# Usage:
#   Fresh install / Update:
#     curl -fsSL https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install-claude.sh | bash
#
#   Clone & install:
#     git clone https://github.com/minsu-kang/make-custom-app-skill.git
#     cd make-custom-app-skill && ./install-claude.sh
#
#   Flags:
#     --update    Skip confirmation prompt (for scripted updates)
#     --force     Remove everything and do a clean install
#
# Source resolution: when run from a local clone the clone is copied; when
# piped from curl the whole repo archive is downloaded once and extracted, so
# no file list is maintained here.
# ============================================================

REPO="minsu-kang/make-custom-app-skill"
BRANCH="master"
SKILL_DIR="$HOME/.claude/skills/make-custom-app"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
CLAUDE_JSON="$HOME/.claude.json"
MCP_SERVER_DIR="$SKILL_DIR/mcp-server"
AGENTS_DIR="$HOME/.claude/agents"
AGENT_DST="$AGENTS_DIR/make-integration-engineer.md"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}▸${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; exit 1; }

MODE="install"
for arg in "$@"; do
    case "$arg" in
        --update) MODE="update" ;;
        --force)  MODE="force" ;;
    esac
done

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   Make Custom App Skill Installer for Claude     ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ── Preserve User Config ──
SAVED_RUNTIME_PATH=""
SAVED_MCP_PATH=""
SAVED_MOCKUP_PATH=""
SAVED_JIRA_EMAIL=""
SAVED_JIRA_TOKEN=""
SAVED_JIRA_BASE_URL=""
SAVED_MAKE_API_KEY=""
SAVED_MAKE_API_URL=""
SAVED_ENV=""

if [ -d "$SKILL_DIR" ]; then
    if [ -f "$SKILL_DIR/SKILL.md" ]; then
        SAVED_RUNTIME_PATH=$(grep '^imt-app-runtime-path:' "$SKILL_DIR/SKILL.md" | grep -v '/path/provided' | tail -1 || true)
        SAVED_MCP_PATH=$(grep '^mcp-server-path:' "$SKILL_DIR/SKILL.md" | grep -v '{path-to' | tail -1 || true)
        SAVED_MOCKUP_PATH=$(grep '^make-apps-mockup-path:' "$SKILL_DIR/SKILL.md" | grep -v '/path/to' | tail -1 || true)
        SAVED_JIRA_EMAIL=$(grep '^jira-email:' "$SKILL_DIR/SKILL.md" | grep -v 'your-email' | tail -1 || true)
        SAVED_JIRA_TOKEN=$(grep '^jira-api-token:' "$SKILL_DIR/SKILL.md" | grep -v 'your-api-token' | tail -1 || true)
        SAVED_JIRA_BASE_URL=$(grep '^jira-base-url:' "$SKILL_DIR/SKILL.md" | grep -v 'your-instance' | tail -1 || true)
        SAVED_MAKE_API_KEY=$(grep '^make-api-key:' "$SKILL_DIR/SKILL.md" | grep -v 'your-make-api-token' | tail -1 || true)
        SAVED_MAKE_API_URL=$(grep '^make-api-url:' "$SKILL_DIR/SKILL.md" | grep -v 'eu1.make.com/api/v2/admin$' | tail -1 || true)
    fi
    if [ -f "$MCP_SERVER_DIR/.env" ]; then
        SAVED_ENV=$(cat "$MCP_SERVER_DIR/.env")
    fi

    case "$MODE" in
        update)
            info "Updating existing installation (cleaning old files)..."
            rm -rf "$SKILL_DIR"
            echo ""
            ;;
        force)
            warn "Force mode: removing existing installation..."
            rm -rf "$SKILL_DIR"
            echo ""
            ;;
        install)
            warn "Existing installation detected: $SKILL_DIR"
            echo ""
            echo -e "  ${BOLD}(u)${NC} Update — overwrite skill files, preserve user config"
            echo -e "  ${BOLD}(f)${NC} Force  — clean install, remove everything"
            echo -e "  ${BOLD}(c)${NC} Cancel"
            echo ""
            read -p "  Choose [u/f/c]: " choice </dev/tty
            case "$choice" in
                [Uu]) MODE="update" ; rm -rf "$SKILL_DIR" ; echo "" ;;
                [Ff]) MODE="force" ; rm -rf "$SKILL_DIR" ; echo "" ;;
                *)    info "Installation cancelled." ; exit 0 ;;
            esac
            ;;
    esac
fi

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
    [ -f "$SRC_ROOT/skill/SKILL.md" ] || fail "Archive layout unexpected — skill/SKILL.md not found."
fi
trap '[ -n "$CLEANUP_TMP" ] && rm -rf "$CLEANUP_TMP"' EXIT
echo ""

# Safety net: rewrite any leftover Cursor-path literal so files work under ~/.claude.
# The skill uses ${SKILL_ROOT} placeholders, so this is normally a no-op.
PATH_REWRITE_SED='s|~/.cursor/skills/make-custom-app|~/.claude/skills/make-custom-app|g'

# ── Install skill/ → $SKILL_DIR (markdown path-rewritten) ──
info "Installing skill files..."
mkdir -p "$SKILL_DIR"
(cd "$SRC_ROOT/skill" && find . -type f ! -name '.DS_Store' -print0) | while IFS= read -r -d '' rel; do
    mkdir -p "$SKILL_DIR/$(dirname "$rel")"
    case "$rel" in
        *.md) sed -E "$PATH_REWRITE_SED" "$SRC_ROOT/skill/$rel" > "$SKILL_DIR/$rel" ;;
        *)    cp "$SRC_ROOT/skill/$rel" "$SKILL_DIR/$rel" ;;
    esac
done
rm -rf "$SKILL_DIR/rules"   # 1.x installed rule copies here; SKILL.md now carries the hard rules
ok "skill/ ($(find "$SKILL_DIR" -type f | wc -l | tr -d ' ') files)"

# ── Install mcp-server/ source → $MCP_SERVER_DIR ──
echo ""
info "Installing MCP server source..."
mkdir -p "$MCP_SERVER_DIR"
(cd "$SRC_ROOT/mcp-server" && tar -cf - --exclude=node_modules --exclude=dist --exclude=.env --exclude='.DS_Store' .) | (cd "$MCP_SERVER_DIR" && tar -xf -)
ok "mcp-server/ source copied"
if [ -n "$SAVED_ENV" ]; then
    printf '%s\n' "$SAVED_ENV" > "$MCP_SERVER_DIR/.env"
    ok "mcp-server/.env preserved"
fi

# ── Build MCP Server ──
MCP_CONFIGURED=false

if [ -f "$MCP_SERVER_DIR/package.json" ]; then
    echo ""
    info "Installing MCP server dependencies (npm install)..."
    if command -v npm &>/dev/null; then
        if (cd "$MCP_SERVER_DIR" && npm install --silent 2>/dev/null); then
            ok "MCP server dependencies installed"
        else
            warn "npm install failed — run manually: cd $MCP_SERVER_DIR && npm install"
        fi

        info "Building MCP server (npm run build)..."
        if (cd "$MCP_SERVER_DIR" && npm run build 2>/dev/null); then
            ok "MCP server built successfully"
        else
            warn "Build failed — run manually: cd $MCP_SERVER_DIR && npm run build"
        fi
    else
        warn "npm not found — install Node.js and run: cd $MCP_SERVER_DIR && npm install && npm run build"
    fi

    # ── MCP Server Configuration ──
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║   MCP Server Setup (Shared App Context)      ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  The MCP server enables team-wide sharing of app contexts via Pinecone."
    echo -e "  You'll need a ${CYAN}Pinecone API key${NC} and an ${CYAN}OpenAI API key${NC}."
    echo ""

    if [ -f "$MCP_SERVER_DIR/.env" ]; then
        info "Existing .env found — skipping key setup."
        MCP_CONFIGURED=true
    elif [ "$MODE" = "update" ]; then
        info "Non-interactive update — skipping MCP key setup (run: cd $MCP_SERVER_DIR && cp .env.example .env, then re-run this installer)."
    else
        read -p "  Set up MCP server now? [y/n]: " setup_mcp </dev/tty
        echo ""

        if [[ "$setup_mcp" =~ ^[Yy]$ ]]; then
            read -p "  Pinecone API Key: " pinecone_key </dev/tty
            read -p "  OpenAI API Key: " openai_key </dev/tty
            read -p "  Pinecone Index Name (default: make-app-contexts): " pinecone_index </dev/tty
            pinecone_index="${pinecone_index:-make-app-contexts}"

            cat > "$MCP_SERVER_DIR/.env" <<ENVEOF
# Pinecone
PINECONE_API_KEY=$pinecone_key
PINECONE_INDEX_NAME=$pinecone_index

# OpenAI (for text-embedding-3-small)
OPENAI_API_KEY=$openai_key
ENVEOF

            ok ".env created"
            MCP_CONFIGURED=true
        else
            info "Skipping MCP server setup. You can configure it later:"
            echo -e "    ${CYAN}cd $MCP_SERVER_DIR${NC}"
            echo -e "    ${CYAN}cp .env.example .env${NC}  # fill in API keys"
            echo ""
        fi
    fi
fi

# ── Register MCP Server in ~/.claude.json ──
echo ""
info "Registering MCP server in $CLAUDE_JSON..."

# Clean up stale config from earlier buggy installer (≤1.13.6) that wrote to
# the wrong path ~/.claude/claude.json. Only remove if it contains nothing but
# our orphan mcpServers entry.
STALE_CLAUDE_JSON="$HOME/.claude/claude.json"
if [ -f "$STALE_CLAUDE_JSON" ] && [ "$STALE_CLAUDE_JSON" != "$CLAUDE_JSON" ]; then
    if grep -q '"make-custom-app"' "$STALE_CLAUDE_JSON" 2>/dev/null; then
        ONLY_KEY_PRESENT=$(node -e "
            try {
                const c = JSON.parse(require('fs').readFileSync('$STALE_CLAUDE_JSON','utf8'));
                const keys = Object.keys(c);
                const mcpKeys = c.mcpServers ? Object.keys(c.mcpServers) : [];
                const onlyOurs = keys.length === 1 && keys[0] === 'mcpServers' && mcpKeys.length === 1 && mcpKeys[0] === 'make-custom-app';
                console.log(onlyOurs ? 'yes' : 'no');
            } catch (e) { console.log('no'); }
        " 2>/dev/null)
        if [ "$ONLY_KEY_PRESENT" = "yes" ]; then
            rm -f "$STALE_CLAUDE_JSON"
            ok "Removed stale $STALE_CLAUDE_JSON (left over from earlier installer bug)"
        else
            warn "$STALE_CLAUDE_JSON contains unrelated config — leaving it untouched."
        fi
    fi
fi

if ! command -v node &>/dev/null; then
    warn "node not found — cannot register MCP server. Install Node.js and re-run."
else
    MCP_INDEX_JS="$MCP_SERVER_DIR/dist/index.js"
    MCP_ENV_FILE="$MCP_SERVER_DIR/.env"
    CLAUDE_JSON_PATH="$CLAUDE_JSON" MCP_INDEX_JS="$MCP_INDEX_JS" MCP_ENV_FILE="$MCP_ENV_FILE" node - <<'NODEEOF'
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
        console.error(`[register] Could not parse existing ${file} — leaving it alone.`);
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
NODEEOF
    REG_RESULT=$?
    if [ $REG_RESULT -eq 0 ]; then
        if [ -f "$CLAUDE_JSON" ] && grep -q '"make-custom-app"' "$CLAUDE_JSON"; then
            ok "MCP server registered (key 'make-custom-app' present in $CLAUDE_JSON)"
        else
            warn "MCP registration produced no error but key not visible in $CLAUDE_JSON"
        fi
    elif [ $REG_RESULT -eq 2 ]; then
        warn "Existing $CLAUDE_JSON could not be parsed — left untouched."
    else
        warn "MCP registration failed (exit $REG_RESULT)"
    fi
fi

# ── Append Skill Section to ~/.claude/CLAUDE.md (idempotent via sentinel) ──
echo ""
info "Wiring skill into $CLAUDE_MD..."

SENTINEL='<!-- make-custom-app-skill -->'
if [ -f "$CLAUDE_MD" ] && grep -qF "$SENTINEL" "$CLAUDE_MD"; then
    info "Skill section already present in $CLAUDE_MD — skipping append."
else
    mkdir -p "$(dirname "$CLAUDE_MD")"
    if [ -f "$CLAUDE_MD" ] && [ -s "$CLAUDE_MD" ]; then
        tail -c1 "$CLAUDE_MD" | read -r _ || echo "" >> "$CLAUDE_MD"
        echo "" >> "$CLAUDE_MD"
    fi
    cat >> "$CLAUDE_MD" <<CLAUDEEOF
$SENTINEL
# Make Custom App Skill

For any Make.com custom app work — building, debugging, reviewing, or managing Make integrations — delegate to the \`make-integration-engineer\` sub-agent.
CLAUDEEOF
    ok "Skill section appended to $CLAUDE_MD"
fi

# ── Install Claude Code Agent Definition ──
echo ""
info "Installing make-integration-engineer agent..."
mkdir -p "$AGENTS_DIR"

if [ -f "$AGENT_DST" ] && grep -qF "name: make-integration-engineer" "$AGENT_DST" && [ "$MODE" = "install" ]; then
    info "Agent already installed at $AGENT_DST — skipping (use --update to overwrite)."
else
    sed "s|{{SKILLS_DIR}}|$SKILL_DIR|g" "$SRC_ROOT/subagents/make-integration-engineer.md" > "$AGENT_DST"
    ok "make-integration-engineer agent installed to $AGENT_DST"
fi

# ── Restore User Config ──
if [ -f "$SKILL_DIR/SKILL.md" ]; then
    echo "" >> "$SKILL_DIR/SKILL.md"
    for line in "$SAVED_MCP_PATH" "$SAVED_RUNTIME_PATH" "$SAVED_MOCKUP_PATH" "$SAVED_JIRA_EMAIL" "$SAVED_JIRA_TOKEN" "$SAVED_JIRA_BASE_URL" "$SAVED_MAKE_API_KEY" "$SAVED_MAKE_API_URL"; do
        if [ -n "$line" ]; then
            echo "$line" >> "$SKILL_DIR/SKILL.md"
            ok "Restored user config (${line%%:*})"
        fi
    done
fi

# ── Verify Installation ──
echo ""
if [ -f "$SKILL_DIR/SKILL.md" ] && [ -f "$SKILL_DIR/scripts/download-app.js" ] && [ -f "$SKILL_DIR/scripts/check-setup.js" ]; then
    INSTALLED_VERSION=$(grep -m1 '^version:' "$SKILL_DIR/SKILL.md" | sed 's/version:[[:space:]]*//')

    echo -e "${GREEN}${BOLD}══════════════════════════════════════════════${NC}"
    if [ "$MODE" = "update" ]; then
        echo -e "${GREEN}${BOLD}  Update Complete!${NC}"
    else
        echo -e "${GREEN}${BOLD}  Installation Complete!${NC}"
    fi
    if [ -n "$INSTALLED_VERSION" ]; then
        echo -e "${GREEN}${BOLD}  Version: $INSTALLED_VERSION${NC}"
    fi
    echo -e "${GREEN}${BOLD}══════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${BOLD}Installed to:${NC}"
    echo -e "    Skill: $SKILL_DIR"
    echo -e "    Agent: $AGENT_DST"
    echo -e "    Wired in: $CLAUDE_MD"
    echo -e "    MCP registered: $CLAUDE_JSON"
    echo ""
    echo -e "  ${BOLD}Next steps:${NC}"
    echo -e "  1. Restart Claude Code"
    echo -e "  2. Ask any Make app question — the skill activates automatically"
    echo -e "  3. Check your setup any time: ${CYAN}node $SKILL_DIR/scripts/check-setup.js${NC}"
    echo -e "     (it tells you where to add imt-app-runtime-path and make-api-key)"
    echo ""
    if [ "$MCP_CONFIGURED" = true ]; then
        echo -e "  ${BOLD}MCP Server:${NC} ${GREEN}Configured${NC}"
    else
        echo -e "  ${BOLD}MCP Server:${NC} ${YELLOW}Not configured${NC} — see check-setup.js output for the steps"
    fi
    echo ""
else
    fail "Installation failed. Required files are missing."
fi
