#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# GridWeave Inspector — local startup script
#
# Usage:
#   bash start.sh          # auto-setup + start (default)
#   bash start.sh --dev    # start in development mode (hot-reload)
#   bash start.sh --build  # build production bundle then start
#
# Requirements: Node.js 18+, Python 3.10+
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── colours ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi

log()  { echo -e "${CYAN}[start]${NC} $*"; }
ok()   { echo -e "${GREEN}[  ok ]${NC} $*"; }
warn() { echo -e "${YELLOW}[ warn]${NC} $*"; }
die()  { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

# ── parse args ────────────────────────────────────────────────────────────────
MODE="auto"
for arg in "$@"; do
  case "$arg" in
    --dev)   MODE="dev" ;;
    --build) MODE="build" ;;
    --help|-h)
      echo "Usage: bash start.sh [--dev | --build]"
      echo "  (no flag)  Auto-detect: build if dist/ is missing, then start production"
      echo "  --dev      Development mode with hot-reload (tsx + vite)"
      echo "  --build    Force rebuild then start production"
      exit 0 ;;
    *) warn "Unknown flag: $arg (ignored)" ;;
  esac
done

# ── prerequisite checks ───────────────────────────────────────────────────────
command -v node &>/dev/null || die "Node.js not found. Install from https://nodejs.org (v18 or later)."
command -v python3 &>/dev/null || die "Python 3 not found. Install from https://python.org (v3.10 or later)."

NODE_VER="$(node --version | tr -d 'v' | cut -d. -f1)"
[[ "$NODE_VER" -ge 18 ]] || die "Node.js v18+ required (found $(node --version))."

ok "Node.js $(node --version) · Python $(python3 --version | awk '{print $2}')"

# ── .env file ─────────────────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    warn ".env not found — copied from .env.example."
    warn "Edit .env and fill in your credentials before running checks."
  else
    warn ".env not found and no .env.example available. The app will start but GridWeave checks will fail without credentials."
  fi
else
  ok ".env found."
fi

# ── npm dependencies ──────────────────────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  log "Installing npm dependencies…"
  npm install --prefer-offline --loglevel=warn
  ok "npm dependencies installed."
else
  ok "node_modules present."
fi

# ── Python virtual environment ────────────────────────────────────────────────
VENV_DIR=".venv"
if [ ! -d "$VENV_DIR" ]; then
  log "Creating Python virtual environment at ${VENV_DIR}…"
  python3 -m venv "$VENV_DIR"

  log "Installing Python dependencies (boto3, s3fs, pandas, Pillow)…"
  "${VENV_DIR}/bin/pip" install --upgrade pip --quiet
  "${VENV_DIR}/bin/pip" install --quiet boto3 s3fs pandas Pillow

  # GridWeave SDK wheel — pick the newest one if present
  WHL="$(ls -1t gridweave_sdk-*.whl 2>/dev/null | head -n1 || true)"
  if [ -n "$WHL" ]; then
    log "Installing GridWeave SDK from ${WHL}…"
    "${VENV_DIR}/bin/pip" install --quiet "$WHL"
    ok "GridWeave SDK installed."
  else
    warn "No gridweave_sdk-*.whl found in project root — skipping SDK install."
    warn "Drop the wheel here and re-run, or set PYTHON_BIN in .env to a Python that already has it."
  fi

  ok "Python environment ready."

  # Write PYTHON_BIN into .env so the server picks up the venv automatically
  VENV_PYTHON="$(pwd)/${VENV_DIR}/bin/python"
  if [ -f ".env" ]; then
    if grep -q "^PYTHON_BIN=" .env; then
      sed -i "s|^PYTHON_BIN=.*|PYTHON_BIN=${VENV_PYTHON}|" .env
    else
      echo "PYTHON_BIN=${VENV_PYTHON}" >> .env
    fi
    ok "PYTHON_BIN set to ${VENV_PYTHON} in .env"
  fi
else
  ok "Python venv present at ${VENV_DIR}."
fi

# ── build / start ─────────────────────────────────────────────────────────────
case "$MODE" in
  dev)
    echo ""
    echo -e "${BOLD}Starting in development mode (hot-reload)…${NC}"
    echo -e "  URL: ${CYAN}http://localhost:5000${NC}"
    echo ""
    NODE_ENV=development exec node_modules/.bin/tsx server/index.ts
    ;;

  build)
    log "Building production bundle…"
    npm run build
    ok "Build complete."
    echo ""
    echo -e "${BOLD}Starting production server…${NC}"
    echo -e "  URL: ${CYAN}http://localhost:${PORT:-5000}${NC}"
    echo ""
    NODE_ENV=production exec node dist/index.cjs
    ;;

  auto)
    if [ ! -d "dist" ] || [ ! -f "dist/index.cjs" ]; then
      log "dist/ not found — building production bundle…"
      npm run build
      ok "Build complete."
    else
      ok "dist/ present — skipping build."
    fi
    echo ""
    echo -e "${BOLD}Starting production server…${NC}"
    echo -e "  URL: ${CYAN}http://localhost:${PORT:-5000}${NC}"
    echo ""
    NODE_ENV=production exec node dist/index.cjs
    ;;
esac
