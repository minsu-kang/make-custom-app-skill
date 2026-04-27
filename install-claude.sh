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
# ============================================================

REPO="minsu-kang/make-custom-app-skill"
BRANCH="master"
SKILL_DIR="$HOME/.claude/skills/make-custom-app"
RULES_DIR="$SKILL_DIR/rules"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
CLAUDE_JSON="$HOME/.claude/claude.json"
VERSION_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/version.json"

SKILL_FILES=("SKILL.md")
REFERENCE_FILES=("builtin-iml-functions.md" "communication-reference.md" "examples.md" "runtime-reference.md" "app-ux-best-practices.md" "parameters-reference.md" "component-patterns-reference.md" "developer-notes-templates.md" "custom-functions-reference.md" "polling-trigger-guide.md" "component-test-guide.md" "code-review-criteria.md" "security-reference.md" "code-smells-reference.md")
WORKFLOW_FILES=("app-context.md" "code-review.md" "bug-investigation.md" "feature-request.md" "app-task.md" "pinecone-sync.md")
SCRIPT_FILES=("download-app.js" "review-changes.js" "update-app.js" "create-component.js" "update-component.js" "delete-component.js" "test-function.js" "test-component.js" "download-jira-ticket-attachment.js" "post-review-transition.js")
SCRIPT_LIB_FILES=("skill-root.js")
RULE_FILES=("make-app-workflow.mdc" "make-app-todo-rules.mdc" "make-app-todo-bugfix.mdc" "make-app-todo-feature.mdc" "make-app-todo-task.mdc" "make-app-todo-review.mdc" "work-discipline.mdc")
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
# When run via `curl | bash`, BASH_SOURCE[0] is empty — dirname "" returns "."
# which resolves to cwd. If cwd happens to be a repo clone, local files get used
# instead of downloading from GitHub. Only use local source when BASH_SOURCE[0]
# points to an actual file (i.e., script was run directly, not piped).
if [ -n "${BASH_SOURCE[0]}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
    SCRIPT_DIR=""
fi

# Path substitution: rewrite any reference to the Cursor install path so files
# work under ~/.claude/skills/make-custom-app instead of ~/.cursor/skills/make-custom-app.
PATH_REWRITE_SED='s|~/.cursor/skills/make-custom-app|~/.claude/skills/make-custom-app|g'

copy_with_rewrite() {
    local src="$1"
    local dst="$2"
    sed -E "$PATH_REWRITE_SED" "$src" > "$dst"
}

# Strip frontmatter (everything between the first `---` and the second `---`,
# plus the optional blank line after) when copying .mdc rule files into .md.
copy_rule_strip_frontmatter() {
    local src="$1"
    local dst="$2"
    awk '
        BEGIN { in_fm = 0; fm_done = 0; saw_blank_after = 0 }
        NR == 1 && /^---[[:space:]]*$/ { in_fm = 1; next }
        in_fm && /^---[[:space:]]*$/ { in_fm = 0; fm_done = 1; next }
        in_fm { next }
        fm_done && !saw_blank_after && /^[[:space:]]*$/ { saw_blank_after = 1; next }
        { print }
    ' "$src" | sed -E "$PATH_REWRITE_SED" > "$dst"
}

# ── Install Skill Files (skill/ → ~/.claude/skills/make-custom-app/) ──
info "Installing skill files..."
echo ""

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/skill/SKILL.md" ]; then
    for file in "${SKILL_FILES[@]}"; do
        if [ -f "$SCRIPT_DIR/skill/$file" ]; then
            copy_with_rewrite "$SCRIPT_DIR/skill/$file" "$SKILL_DIR/$file"
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
        TMP_FILE="$(mktemp)"
        HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$TMP_FILE" "$BASE_URL/skill/$file" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ]; then
            copy_with_rewrite "$TMP_FILE" "$SKILL_DIR/$file"
            rm -f "$TMP_FILE"
            ok "$file"
        else
            rm -f "$TMP_FILE"
            warn "$file (download failed: HTTP $HTTP_CODE)"
        fi
    done
fi

# ── Install Reference Files ──
echo ""
info "Installing reference files..."
echo ""

mkdir -p "$SKILL_DIR/references"

if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/skill/references" ]; then
    for src in "$SCRIPT_DIR"/skill/references/*.md; do
        [ -f "$src" ] || continue
        cp "$src" "$SKILL_DIR/references/$(basename "$src")"
        ok "references/$(basename "$src")"
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

# ── Install Workflow Files (path-rewritten) ──
echo ""
info "Installing workflow files..."
echo ""

mkdir -p "$SKILL_DIR/workflows"

if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/skill/workflows" ]; then
    for src in "$SCRIPT_DIR"/skill/workflows/*.md; do
        [ -f "$src" ] || continue
        copy_with_rewrite "$src" "$SKILL_DIR/workflows/$(basename "$src")"
        ok "workflows/$(basename "$src")"
    done
else
    BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"

    for file in "${WORKFLOW_FILES[@]}"; do
        TMP_FILE="$(mktemp)"
        HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$TMP_FILE" "$BASE_URL/skill/workflows/$file" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ]; then
            copy_with_rewrite "$TMP_FILE" "$SKILL_DIR/workflows/$file"
            rm -f "$TMP_FILE"
            ok "workflows/$file"
        else
            rm -f "$TMP_FILE"
            warn "workflows/$file (download failed: HTTP $HTTP_CODE)"
        fi
    done
fi

# ── Install Script Files ──
echo ""
info "Installing script files..."
echo ""

SCRIPTS_DEST="$SKILL_DIR/scripts"
mkdir -p "$SCRIPTS_DEST"

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/skill/scripts/download-app.js" ]; then
    cp "$SCRIPT_DIR"/skill/scripts/*.js "$SCRIPTS_DEST/" 2>/dev/null
    for file in "$SCRIPTS_DEST"/*.js; do
        ok "scripts/$(basename "$file")"
    done
    mkdir -p "$SCRIPTS_DEST/lib"
    cp "$SCRIPT_DIR"/skill/scripts/lib/*.js "$SCRIPTS_DEST/lib/" 2>/dev/null
    for file in "$SCRIPTS_DEST"/lib/*.js; do
        [ -f "$file" ] || continue
        ok "scripts/lib/$(basename "$file")"
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

    mkdir -p "$SCRIPTS_DEST/lib"
    for file in "${SCRIPT_LIB_FILES[@]}"; do
        HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$SCRIPTS_DEST/lib/$file" "$BASE_URL/skill/scripts/lib/$file" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ]; then
            ok "scripts/lib/$file"
        else
            rm -f "$SCRIPTS_DEST/lib/$file"
            warn "scripts/lib/$file (download failed: HTTP $HTTP_CODE)"
        fi
    done
fi

# ── Install Rule Files (rules/*.mdc → $RULES_DIR/*.md, frontmatter stripped, paths rewritten) ──
echo ""
info "Installing rule files..."
echo ""

if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/rules" ]; then
    for src in "$SCRIPT_DIR"/rules/*.mdc; do
        [ -f "$src" ] || continue
        base="$(basename "$src" .mdc)"
        copy_rule_strip_frontmatter "$src" "$RULES_DIR/$base.md"
        ok "rules/$base.md"
    done
else
    BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"

    for file in "${RULE_FILES[@]}"; do
        TMP_FILE="$(mktemp)"
        HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$TMP_FILE" "$BASE_URL/rules/$file" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ]; then
            base="${file%.mdc}"
            copy_rule_strip_frontmatter "$TMP_FILE" "$RULES_DIR/$base.md"
            rm -f "$TMP_FILE"
            ok "rules/$base.md"
        else
            rm -f "$TMP_FILE"
            warn "rules/$file (download failed: HTTP $HTTP_CODE)"
        fi
    done
fi

# ── Install MCP Server ──
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

# ── Register MCP Server in ~/.claude/claude.json ──
echo ""
info "Registering MCP server in $CLAUDE_JSON..."

if ! command -v node &>/dev/null; then
    warn "node not found — cannot register MCP server. Install Node.js and re-run."
else
    MCP_INDEX_JS="$MCP_SERVER_DIR/dist/index.js"
    CLAUDE_JSON_PATH="$CLAUDE_JSON" MCP_INDEX_JS="$MCP_INDEX_JS" node - <<'NODEEOF'
const fs = require('fs');
const path = require('path');
const file = process.env.CLAUDE_JSON_PATH;
const indexJs = process.env.MCP_INDEX_JS;
const KEY = 'make-custom-app';

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

if (cfg.mcpServers[KEY]) {
    console.log('skip');
    process.exit(0);
}

cfg.mcpServers[KEY] = {
    command: 'node',
    args: [indexJs],
    env: {}
};

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log(existed ? 'added' : 'created');
NODEEOF
    REG_RESULT=$?
    if [ $REG_RESULT -eq 0 ]; then
        # Re-detect what happened by inspecting the file
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
        # Ensure single blank line separator before our section
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

AGENTS_DIR="$HOME/.claude/agents"
mkdir -p "$AGENTS_DIR"
AGENT_DST="$AGENTS_DIR/make-integration-engineer.md"
AGENT_KEY="make-integration-engineer"

AGENT_ALREADY_EXISTS=false
if [ -f "$AGENT_DST" ] && grep -qF "name: $AGENT_KEY" "$AGENT_DST"; then
    AGENT_ALREADY_EXISTS=true
fi

install_agent() {
    local src="$1"
    # Replace {{SKILLS_DIR}} placeholder with actual expanded path
    sed "s|{{SKILLS_DIR}}|$SKILL_DIR|g" "$src" > "$AGENT_DST"
}

if [ "$AGENT_ALREADY_EXISTS" = true ] && [ "$MODE" = "install" ]; then
    info "Agent already installed at $AGENT_DST — skipping (use --update to overwrite)."
elif [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/subagents/make-integration-engineer.md" ]; then
    install_agent "$SCRIPT_DIR/subagents/make-integration-engineer.md"
    ok "make-integration-engineer agent installed to $AGENT_DST"
else
    BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"
    TMP_FILE="$(mktemp)"
    HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$TMP_FILE" "$BASE_URL/subagents/make-integration-engineer.md" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        install_agent "$TMP_FILE"
        rm -f "$TMP_FILE"
        ok "make-integration-engineer agent installed to $AGENT_DST"
    else
        rm -f "$TMP_FILE"
        warn "make-integration-engineer.md (download failed: HTTP $HTTP_CODE)"
    fi
fi

# ── Restore User Config ──
if [ -f "$SKILL_DIR/SKILL.md" ]; then
    if [ -n "$SAVED_MCP_PATH" ]; then
        echo "" >> "$SKILL_DIR/SKILL.md"
        echo "$SAVED_MCP_PATH" >> "$SKILL_DIR/SKILL.md"
        ok "Restored user config (mcp-server-path)"
    fi
    if [ -n "$SAVED_RUNTIME_PATH" ]; then
        echo "" >> "$SKILL_DIR/SKILL.md"
        echo "$SAVED_RUNTIME_PATH" >> "$SKILL_DIR/SKILL.md"
        ok "Restored user config (imt-app-runtime-path)"
    fi
    if [ -n "$SAVED_MOCKUP_PATH" ]; then
        echo "$SAVED_MOCKUP_PATH" >> "$SKILL_DIR/SKILL.md"
        ok "Restored user config (make-apps-mockup-path)"
    fi
    if [ -n "$SAVED_JIRA_EMAIL" ]; then
        echo "$SAVED_JIRA_EMAIL" >> "$SKILL_DIR/SKILL.md"
        ok "Restored user config (jira-email)"
    fi
    if [ -n "$SAVED_JIRA_TOKEN" ]; then
        echo "$SAVED_JIRA_TOKEN" >> "$SKILL_DIR/SKILL.md"
        ok "Restored user config (jira-api-token)"
    fi
    if [ -n "$SAVED_JIRA_BASE_URL" ]; then
        echo "$SAVED_JIRA_BASE_URL" >> "$SKILL_DIR/SKILL.md"
        ok "Restored user config (jira-base-url)"
    fi
    if [ -n "$SAVED_MAKE_API_KEY" ]; then
        echo "$SAVED_MAKE_API_KEY" >> "$SKILL_DIR/SKILL.md"
        ok "Restored user config (make-api-key)"
    fi
    if [ -n "$SAVED_MAKE_API_URL" ]; then
        echo "$SAVED_MAKE_API_URL" >> "$SKILL_DIR/SKILL.md"
        ok "Restored user config (make-api-url)"
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
    echo -e "    Wired in: $CLAUDE_MD"
    echo -e "    MCP registered: $CLAUDE_JSON"
    echo ""
    echo -e "  ${BOLD}Next steps:${NC}"
    echo -e "  1. Restart Claude Code"
    echo -e "  2. Ask any Make app question — the skill activates automatically"
    echo -e "  3. On first use, you'll be guided to clone imt-app-runtime"
    echo ""
    if [ "$MCP_CONFIGURED" = true ]; then
        echo -e "  ${BOLD}MCP Server:${NC} ${GREEN}Configured${NC}"
        echo -e "  Restart Claude Code to activate shared app context via Pinecone."
    else
        echo -e "  ${BOLD}MCP Server:${NC} ${YELLOW}Not configured${NC}"
        echo -e "  To enable later, run:"
        echo -e "    ${CYAN}cd $MCP_SERVER_DIR${NC}"
        echo -e "    ${CYAN}cp .env.example .env${NC}  # fill in API keys"
    fi
    echo ""
else
    fail "Installation failed. Required files are missing."
fi
