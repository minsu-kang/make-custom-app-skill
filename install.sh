#!/bin/bash
set -e

# ============================================================
# Make Custom App Skill Installer for Cursor
# ============================================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/minsu-kang/make-custom-app-skill/master/install.sh | bash
#
#   or clone & run:
#   git clone https://github.com/minsu-kang/make-custom-app-skill.git
#   cd make-custom-app-skill && ./install.sh
# ============================================================

REPO="minsu-kang/make-custom-app-skill"
BRANCH="master"
SKILL_DIR="$HOME/.cursor/skills/make-custom-app"
SKILL_FILES=("SKILL.md" "download-app.js" "review-changes.js" "builtin-iml-functions.md" "communication-reference.md" "examples.md" "runtime-reference.md")

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

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   Make Custom App Skill Installer for Cursor ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── Check Existing Installation ──
if [ -d "$SKILL_DIR" ]; then
    warn "Existing installation detected: $SKILL_DIR"
    echo ""
    read -p "  Overwrite? (y/N): " overwrite
    if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
        info "Installation cancelled."
        exit 0
    fi
    echo ""
fi

mkdir -p "$SKILL_DIR"

# ── Install Files ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" 2>/dev/null)" && pwd 2>/dev/null || echo "")"

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/SKILL.md" ]; then
    info "Installing from local files..."
    echo ""
    for file in "${SKILL_FILES[@]}"; do
        if [ -f "$SCRIPT_DIR/$file" ]; then
            cp "$SCRIPT_DIR/$file" "$SKILL_DIR/$file"
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
        HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$SKILL_DIR/$file" "$BASE_URL/$file" 2>/dev/null || echo "000")
        if [ "$HTTP_CODE" = "200" ]; then
            ok "$file"
        else
            rm -f "$SKILL_DIR/$file"
            warn "$file (download failed: HTTP $HTTP_CODE)"
        fi
    done
fi

# ── Verify Installation ──
echo ""
if [ -f "$SKILL_DIR/SKILL.md" ] && [ -f "$SKILL_DIR/download-app.js" ]; then
    echo -e "${GREEN}${BOLD}══════════════════════════════════════════════${NC}"
    echo -e "${GREEN}${BOLD}  Installation Complete!${NC}"
    echo -e "${GREEN}${BOLD}══════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${BOLD}Installed to:${NC} $SKILL_DIR"
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
