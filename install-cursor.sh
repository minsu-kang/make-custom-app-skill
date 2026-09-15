#!/bin/bash
set -e

# ============================================================
# Make Custom App Skill Installer for Cursor
# ============================================================
# Usage:
#   Fresh install / Update:
#     curl -fsSL https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install-cursor.sh | bash
#
#   Clone & install:
#     git clone https://github.com/minsu-kang/make-custom-app-skill.git
#     cd make-custom-app-skill && ./install-cursor.sh
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
SKILL_DIR="$HOME/.cursor/skills/make-custom-app"
RULES_DIR="$HOME/.cursor/rules/make-custom-app"
MCP_SERVER_DIR="$SKILL_DIR/mcp-server"
HOOKS_DIR="$HOME/.cursor/hooks"
HOOKS_JSON="$HOME/.cursor/hooks.json"
DEPRECATED_HOOK_FILES=("make-app-auto-actions-check.js" "check-make-app-ticket-sync.js")
# Rule files installed by 1.x releases (both directly under ~/.cursor/rules and
# under $RULES_DIR). Removed on every install so retired rules stop loading.
LEGACY_RULE_FILES=("make-app-workflow.mdc" "make-app-todo-rules.mdc" "make-app-todo-bugfix.mdc" "make-app-todo-feature.mdc" "make-app-todo-task.mdc" "make-app-todo-review.mdc" "make-app-todo-refinement.mdc" "work-discipline.mdc" "make-app-ux-guideline.mdc" "make-app-auto-actions.mdc" "make-app-code-review.mdc")

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
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   Make Custom App Skill Installer for Cursor ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── Preserve User Config ──
SAVED_RUNTIME_PATH=""
SAVED_MCP_PATH=""
SAVED_MOCKUP_PATH=""
SAVED_JIRA_EMAIL=""
SAVED_JIRA_TOKEN=""
SAVED_JIRA_BASE_URL=""
SAVED_ENV=""

if [ -d "$SKILL_DIR" ]; then
    if [ -f "$SKILL_DIR/SKILL.md" ]; then
        SAVED_RUNTIME_PATH=$(grep '^imt-app-runtime-path:' "$SKILL_DIR/SKILL.md" | grep -v '/path/provided' | tail -1 || true)
        SAVED_MCP_PATH=$(grep '^mcp-server-path:' "$SKILL_DIR/SKILL.md" | grep -v '{path-to' | tail -1 || true)
        SAVED_MOCKUP_PATH=$(grep '^make-apps-mockup-path:' "$SKILL_DIR/SKILL.md" | grep -v '/path/to' | tail -1 || true)
        SAVED_JIRA_EMAIL=$(grep '^jira-email:' "$SKILL_DIR/SKILL.md" | grep -v 'your-email' | tail -1 || true)
        SAVED_JIRA_TOKEN=$(grep '^jira-api-token:' "$SKILL_DIR/SKILL.md" | grep -v 'your-api-token' | tail -1 || true)
        SAVED_JIRA_BASE_URL=$(grep '^jira-base-url:' "$SKILL_DIR/SKILL.md" | grep -v 'your-instance' | tail -1 || true)
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

# ── Install skill/ → $SKILL_DIR ──
info "Installing skill files..."
mkdir -p "$SKILL_DIR"
cp -R "$SRC_ROOT/skill/." "$SKILL_DIR/"
find "$SKILL_DIR" -name '.DS_Store' -delete 2>/dev/null || true
ok "skill/ ($(find "$SKILL_DIR" -type f | wc -l | tr -d ' ') files)"

# ── Install rules/ → $RULES_DIR (replaced wholesale) ──
info "Installing rule files..."
rm -rf "$RULES_DIR"
mkdir -p "$RULES_DIR"
cp "$SRC_ROOT"/rules/*.mdc "$RULES_DIR/"
for f in "$RULES_DIR"/*.mdc; do ok "rules/$(basename "$f")"; done
for f in "${LEGACY_RULE_FILES[@]}"; do
    rm -f "$HOME/.cursor/rules/$f"
done

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

# ── Cleanup deprecated stop hooks from releases before 1.12.0 ──
if [ -d "$HOOKS_DIR" ]; then
    for file in "${DEPRECATED_HOOK_FILES[@]}"; do
        if [ -f "$HOOKS_DIR/$file" ]; then
            rm -f "$HOOKS_DIR/$file"
            ok "removed hooks/$file"
        fi
    done
fi

if [ -f "$HOOKS_JSON" ] && command -v node &>/dev/null; then
    HOOKS_JSON_PATH="$HOOKS_JSON" node - <<'EOF'
const fs = require('fs');
const file = process.env.HOOKS_JSON_PATH;
let cfg;
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { process.exit(0); }
if (!cfg || !cfg.hooks || !Array.isArray(cfg.hooks.stop)) process.exit(0);
const deprecated = new Set([
    'node ./hooks/make-app-auto-actions-check.js',
    'node ./hooks/check-make-app-ticket-sync.js',
]);
const before = cfg.hooks.stop.length;
cfg.hooks.stop = cfg.hooks.stop.filter(h => !(h && deprecated.has(h.command)));
if (cfg.hooks.stop.length !== before) {
    if (cfg.hooks.stop.length === 0) delete cfg.hooks.stop;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    console.log('pruned');
}
EOF
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
        info "Non-interactive update — skipping MCP key setup (run: cd $MCP_SERVER_DIR && cp .env.example .env && npm run register)."
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
            echo -e "    ${CYAN}npm run register${NC}"
            echo ""
        fi
    fi

    if [ "$MCP_CONFIGURED" = true ] && command -v npm &>/dev/null && [ -f "$MCP_SERVER_DIR/register.js" ]; then
        info "Registering MCP server with Cursor..."
        if (cd "$MCP_SERVER_DIR" && node register.js 2>/dev/null); then
            ok "MCP server registered with Cursor"
        else
            warn "Registration failed — run manually: cd $MCP_SERVER_DIR && npm run register"
        fi
    fi
fi

# ── Restore User Config ──
if [ -f "$SKILL_DIR/SKILL.md" ]; then
    echo "" >> "$SKILL_DIR/SKILL.md"
    for line in "$SAVED_MCP_PATH" "$SAVED_RUNTIME_PATH" "$SAVED_MOCKUP_PATH" "$SAVED_JIRA_EMAIL" "$SAVED_JIRA_TOKEN" "$SAVED_JIRA_BASE_URL"; do
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
    echo -e "    Rules: $RULES_DIR"
    echo ""
    echo -e "  ${BOLD}Next steps:${NC}"
    echo -e "  1. Restart Cursor (rule changes load on restart)"
    echo -e "  2. Ask any Make app question — the skill activates automatically"
    echo -e "  3. Check your setup any time: ${CYAN}node $SKILL_DIR/scripts/check-setup.js${NC}"
    echo ""
    echo -e "  ${BOLD}Prerequisites:${NC}"
    echo -e "  - ${CYAN}Make Apps SDK${NC} extension installed in VS Code/Cursor"
    echo -e "  - API key and environment configured in extension settings"
    echo -e "  - ${CYAN}imt-app-runtime${NC} cloned locally (check-setup.js tells you where to put the path)"
    echo ""
    if [ "$MCP_CONFIGURED" = true ]; then
        echo -e "  ${BOLD}MCP Server:${NC} ${GREEN}Configured and registered${NC}"
    else
        echo -e "  ${BOLD}MCP Server:${NC} ${YELLOW}Not configured${NC} — see check-setup.js output for the steps"
    fi
    echo ""
else
    fail "Installation failed. Required files are missing."
fi
