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

SKILL_FILES=("SKILL.md" "download-app.js" "review-changes.js" "builtin-iml-functions.md" "communication-reference.md" "examples.md" "runtime-reference.md")
RULE_FILES=("make-app-code-review.mdc" "version-sync.mdc")

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

if [ -d "$SKILL_DIR" ]; then
    if [ -f "$SKILL_DIR/SKILL.md" ]; then
        LAST_LINE=$(tail -1 "$SKILL_DIR/SKILL.md")
        if [[ "$LAST_LINE" == imt-app-runtime-path:* ]]; then
            SAVED_RUNTIME_PATH="$LAST_LINE"
        fi
    fi

    case "$MODE" in
        update)
            info "Updating existing installation..."
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
            read -p "  Choose [u/f/c]: " choice
            case "$choice" in
                [Uu]) MODE="update" ; echo "" ;;
                [Ff]) MODE="force" ; rm -rf "$SKILL_DIR" ; echo "" ;;
                *)    info "Installation cancelled." ; exit 0 ;;
            esac
            ;;
    esac
fi

mkdir -p "$SKILL_DIR"
mkdir -p "$RULES_DIR"

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

# ── Restore User Config ──
if [ -n "$SAVED_RUNTIME_PATH" ] && [ -f "$SKILL_DIR/SKILL.md" ]; then
    CURRENT_LAST=$(tail -1 "$SKILL_DIR/SKILL.md")
    if [[ "$CURRENT_LAST" != imt-app-runtime-path:* ]]; then
        echo "" >> "$SKILL_DIR/SKILL.md"
        echo "$SAVED_RUNTIME_PATH" >> "$SKILL_DIR/SKILL.md"
    fi
    ok "Restored user config (imt-app-runtime-path)"
fi

# ── Verify Installation ──
echo ""
if [ -f "$SKILL_DIR/SKILL.md" ] && [ -f "$SKILL_DIR/download-app.js" ]; then
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
else
    fail "Installation failed. Required files are missing."
fi
