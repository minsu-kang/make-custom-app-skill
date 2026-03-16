#!/bin/bash
set -e

# ============================================================
# Make Custom App Skill Installer for Cursor
# ============================================================
# Usage:
#   Fresh install / Update:
#     curl -fsSL https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install.sh | bash
#
#   Clone & install:
#     git clone https://github.com/minsu-kang/make-custom-app-skill.git
#     cd make-custom-app-skill && ./install.sh
#
#   Flags:
#     --update    Skip confirmation prompt (for scripted updates)
#     --force     Remove everything and do a clean install
# ============================================================

REPO="minsu-kang/make-custom-app-skill"
BRANCH="master"
SKILL_DIR="$HOME/.cursor/skills/make-custom-app"
RULES_DIR="$HOME/.cursor/rules"
VERSION_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/version.json"

SKILL_FILES=("SKILL.md")
REFERENCE_FILES=("builtin-iml-functions.md" "communication-reference.md" "examples.md" "runtime-reference.md" "app-ux-best-practices.md" "parameters-reference.md" "component-patterns-reference.md" "developer-notes-templates.md" "custom-functions-reference.md")
WORKFLOW_FILES=("app-context.md" "code-review.md" "bug-investigation.md" "feature-request.md" "app-task.md" "pinecone-sync.md")
SCRIPT_FILES=("download-app.js" "review-changes.js" "update-app.js" "create-component.js" "update-component.js" "delete-component.js")
RULE_FILES=("make-app-code-review.mdc" "make-app-auto-actions.mdc" "version-sync.mdc")
MCP_SERVER_DIR="$SKILL_DIR/mcp-server"
MCP_SERVER_FILES=("package.json" "tsconfig.json" "index.ts" "register.js" "lib/pinecone.ts" "lib/embeddings.ts" "lib/chunker.ts" "tools/upsert.ts" "tools/search.ts" "tools/get-summary.ts" "tools/list-apps.ts" "tools/upsert-jira.ts" ".env.example")

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

if [ -d "$SKILL_DIR" ]; then
    if [ -f "$SKILL_DIR/SKILL.md" ]; then
        SAVED_RUNTIME_PATH=$(tail -10 "$SKILL_DIR/SKILL.md" | grep '^imt-app-runtime-path:' | grep -v '/path/provided' | tail -1 || true)
        SAVED_MCP_PATH=$(tail -10 "$SKILL_DIR/SKILL.md" | grep '^mcp-server-path:' | grep -v '{path-to' | tail -1 || true)
    fi

    SAVED_ENV=""
    if [ -f "$SKILL_DIR/mcp-server/.env" ]; then
        SAVED_ENV=$(cat "$SKILL_DIR/mcp-server/.env")
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

mkdir -p "$SKILL_DIR"
mkdir -p "$RULES_DIR"

# ── Restore preserved .env ──
if [ -n "$SAVED_ENV" ]; then
    mkdir -p "$MCP_SERVER_DIR"
    printf '%s\n' "$SAVED_ENV" > "$MCP_SERVER_DIR/.env"
fi

# ── Detect Source ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" 2>/dev/null)" && pwd 2>/dev/null || echo "")"

# ── Install Skill Files (skill/ → ~/.cursor/skills/make-custom-app/) ──
info "Installing skill files..."
echo ""

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/skill/SKILL.md" ]; then
    for file in "${SKILL_FILES[@]}"; do
        if [ -f "$SCRIPT_DIR/skill/$file" ]; then
            cp "$SCRIPT_DIR/skill/$file" "$SKILL_DIR/$file"
            ok "$file"
        else
            warn "$file (not found, skipped)"
        fi
    done
else
    info "Downloading from GitHub..."
    echo ""

    if ! command -v curl &>/dev/null; then
        fail "curl is not installed."
    fi

    BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"

    for file in "${SKILL_FILES[@]}"; do
        HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$SKILL_DIR/$file" "$BASE_URL/skill/$file" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ]; then
            ok "$file"
        else
            rm -f "$SKILL_DIR/$file"
            warn "$file (download failed: HTTP $HTTP_CODE)"
        fi
    done
fi

# ── Install Reference Files (skill/references/ → ~/.cursor/skills/make-custom-app/references/) ──
echo ""
info "Installing reference files..."
echo ""

mkdir -p "$SKILL_DIR/references"

if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/skill/references" ]; then
    for file in "${REFERENCE_FILES[@]}"; do
        if [ -f "$SCRIPT_DIR/skill/references/$file" ]; then
            cp "$SCRIPT_DIR/skill/references/$file" "$SKILL_DIR/references/$file"
            ok "references/$file"
        else
            warn "references/$file (not found, skipped)"
        fi
    done
else
    BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"

    for file in "${REFERENCE_FILES[@]}"; do
        HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$SKILL_DIR/references/$file" "$BASE_URL/skill/references/$file" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ]; then
            ok "references/$file"
        else
            rm -f "$SKILL_DIR/references/$file"
            warn "references/$file (download failed: HTTP $HTTP_CODE)"
        fi
    done
fi

# ── Install Workflow Files (skill/workflows/ → ~/.cursor/skills/make-custom-app/workflows/) ──
echo ""
info "Installing workflow files..."
echo ""

mkdir -p "$SKILL_DIR/workflows"

if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/skill/workflows" ]; then
    for file in "${WORKFLOW_FILES[@]}"; do
        if [ -f "$SCRIPT_DIR/skill/workflows/$file" ]; then
            cp "$SCRIPT_DIR/skill/workflows/$file" "$SKILL_DIR/workflows/$file"
            ok "workflows/$file"
        else
            warn "workflows/$file (not found, skipped)"
        fi
    done
else
    BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"

    for file in "${WORKFLOW_FILES[@]}"; do
        HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$SKILL_DIR/workflows/$file" "$BASE_URL/skill/workflows/$file" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ]; then
            ok "workflows/$file"
        else
            rm -f "$SKILL_DIR/workflows/$file"
            warn "workflows/$file (download failed: HTTP $HTTP_CODE)"
        fi
    done
fi

# ── Install Script Files (skill/scripts/ → ~/.cursor/skills/make-custom-app/scripts/) ──
echo ""
info "Installing script files..."
echo ""

SCRIPTS_DEST="$SKILL_DIR/scripts"
mkdir -p "$SCRIPTS_DEST"

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/skill/scripts/download-app.js" ]; then
    for file in "${SCRIPT_FILES[@]}"; do
        if [ -f "$SCRIPT_DIR/skill/scripts/$file" ]; then
            cp "$SCRIPT_DIR/skill/scripts/$file" "$SCRIPTS_DEST/$file"
            ok "scripts/$file"
        else
            warn "scripts/$file (not found, skipped)"
        fi
    done
else
    BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"

    for file in "${SCRIPT_FILES[@]}"; do
        HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$SCRIPTS_DEST/$file" "$BASE_URL/skill/scripts/$file" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ]; then
            ok "scripts/$file"
        else
            rm -f "$SCRIPTS_DEST/$file"
            warn "scripts/$file (download failed: HTTP $HTTP_CODE)"
        fi
    done
fi

# ── Install Rule Files (rules/ → ~/.cursor/rules/) ──
echo ""
info "Installing rule files..."
echo ""

if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/rules" ]; then
    for file in "${RULE_FILES[@]}"; do
        if [ -f "$SCRIPT_DIR/rules/$file" ]; then
            cp "$SCRIPT_DIR/rules/$file" "$RULES_DIR/$file"
            ok "$file"
        else
            warn "$file (not found, skipped)"
        fi
    done
else
    BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"

    for file in "${RULE_FILES[@]}"; do
        HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$RULES_DIR/$file" "$BASE_URL/rules/$file" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ]; then
            ok "$file"
        else
            rm -f "$RULES_DIR/$file"
            warn "$file (download failed: HTTP $HTTP_CODE)"
        fi
    done
fi

# ── Install MCP Server (mcp-server/ → ~/.cursor/skills/make-custom-app/mcp-server/) ──
echo ""
info "Installing MCP server..."
echo ""

mkdir -p "$MCP_SERVER_DIR/lib" "$MCP_SERVER_DIR/tools"

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/mcp-server/index.ts" ]; then
    for file in "${MCP_SERVER_FILES[@]}"; do
        if [ -f "$SCRIPT_DIR/mcp-server/$file" ]; then
            cp "$SCRIPT_DIR/mcp-server/$file" "$MCP_SERVER_DIR/$file"
            ok "mcp-server/$file"
        else
            warn "mcp-server/$file (not found, skipped)"
        fi
    done
else
    BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"

    for file in "${MCP_SERVER_FILES[@]}"; do
        dir_part=$(dirname "$file")
        if [ "$dir_part" != "." ]; then
            mkdir -p "$MCP_SERVER_DIR/$dir_part"
        fi
        HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$MCP_SERVER_DIR/$file" "$BASE_URL/mcp-server/$file" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ]; then
            ok "mcp-server/$file"
        else
            rm -f "$MCP_SERVER_DIR/$file"
            warn "mcp-server/$file (download failed: HTTP $HTTP_CODE)"
        fi
    done
fi

MCP_CONFIGURED=false

if [ -f "$MCP_SERVER_DIR/package.json" ]; then
    echo ""
    info "Installing MCP server dependencies (npm install)..."
    if command -v npm &>/dev/null; then
        (cd "$MCP_SERVER_DIR" && npm install --silent 2>/dev/null)
        if [ $? -eq 0 ]; then
            ok "MCP server dependencies installed"
        else
            warn "npm install failed — run manually: cd $MCP_SERVER_DIR && npm install"
        fi

        info "Building MCP server (npm run build)..."
        (cd "$MCP_SERVER_DIR" && npm run build 2>/dev/null)
        if [ $? -eq 0 ]; then
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
        (cd "$MCP_SERVER_DIR" && node register.js 2>/dev/null)
        if [ $? -eq 0 ]; then
            ok "MCP server registered with Cursor"
        else
            warn "Registration failed — run manually: cd $MCP_SERVER_DIR && npm run register"
        fi
    fi
fi

# ── Restore User Config ──
if [ -f "$SKILL_DIR/SKILL.md" ]; then
    if [ -n "$SAVED_MCP_PATH" ]; then
        MCP_DIR=$(echo "$SAVED_MCP_PATH" | sed 's/^mcp-server-path:[[:space:]]*//')
        if [ -d "$MCP_DIR" ]; then
            echo "" >> "$SKILL_DIR/SKILL.md"
            echo "$SAVED_MCP_PATH" >> "$SKILL_DIR/SKILL.md"
            ok "Restored user config (mcp-server-path)"
        else
            warn "Skipped mcp-server-path (directory not found: $MCP_DIR)"
        fi
    fi
    if [ -n "$SAVED_RUNTIME_PATH" ]; then
        RUNTIME_DIR=$(echo "$SAVED_RUNTIME_PATH" | sed 's/^imt-app-runtime-path:[[:space:]]*//')
        if [ -d "$RUNTIME_DIR" ]; then
            echo "" >> "$SKILL_DIR/SKILL.md"
            echo "$SAVED_RUNTIME_PATH" >> "$SKILL_DIR/SKILL.md"
            ok "Restored user config (imt-app-runtime-path)"
        else
            warn "Skipped imt-app-runtime-path (directory not found: $RUNTIME_DIR)"
        fi
    fi
fi

# ── Verify Installation ──
echo ""
if [ -f "$SKILL_DIR/SKILL.md" ] && [ -f "$SKILL_DIR/scripts/download-app.js" ]; then
    INSTALLED_VERSION=""
    if [ -f "$SKILL_DIR/SKILL.md" ]; then
        INSTALLED_VERSION=$(grep -m1 '^version:' "$SKILL_DIR/SKILL.md" | sed 's/version:[[:space:]]*//')
    fi

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
    echo -e "  1. Restart Cursor"
    echo -e "  2. Ask any Make app question — the skill activates automatically"
    echo -e "  3. On first use, you'll be guided to clone imt-app-runtime"
    echo ""
    echo -e "  ${BOLD}Prerequisites:${NC}"
    echo -e "  - ${CYAN}Make Apps SDK${NC} extension installed in VS Code/Cursor"
    echo -e "  - API key and environment configured in extension settings"
    echo ""
    if [ "$MCP_CONFIGURED" = true ]; then
        echo -e "  ${BOLD}MCP Server:${NC} ${GREEN}Configured and registered${NC}"
        echo -e "  Restart Cursor to activate shared app context via Pinecone."
    else
        echo -e "  ${BOLD}MCP Server:${NC} ${YELLOW}Not configured${NC}"
        echo -e "  To enable later, run:"
        echo -e "    ${CYAN}cd $MCP_SERVER_DIR${NC}"
        echo -e "    ${CYAN}cp .env.example .env${NC}  # fill in API keys"
        echo -e "    ${CYAN}npm run register${NC}"
    fi
    echo ""
else
    fail "Installation failed. Required files are missing."
fi
