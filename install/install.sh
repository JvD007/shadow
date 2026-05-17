#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# GridWeave Inspector — Ubuntu 24.04 automated install script
#
# Usage (run from the project root as root):
#   sudo bash install/install.sh
#
# What it does:
#   1. Installs Node.js 20 LTS and Python 3 system packages
#   2. Creates a dedicated 'gridweave' system user
#   3. Copies the application to /opt/gridweave-inspector
#   4. Builds the production bundle  (npm run build)
#   5. Creates a Python venv with boto3 / s3fs / pandas / gridweave SDK
#   6. Writes config to /etc/gridweave-inspector/app.env (editable afterwards)
#   7. Installs and starts gridweave-inspector.service via systemd
#
# Re-running the script is safe — it upgrades in-place.
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── constants ──────────────────────────────────────────────────────────────────
APP_NAME="gridweave-inspector"
INSTALL_DIR="/opt/${APP_NAME}"
CONFIG_DIR="/etc/${APP_NAME}"
CONFIG_FILE="${CONFIG_DIR}/app.env"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
APP_USER="gridweave"
APP_PORT="${PORT:-5000}"
NODE_VERSION="20"

# Colours (no-op when stdout is not a tty)
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
fi

log()  { echo -e "${CYAN}[install]${NC} $*"; }
ok()   { echo -e "${GREEN}[  ok  ]${NC} $*"; }
warn() { echo -e "${YELLOW}[ warn ]${NC} $*"; }
die()  { echo -e "${RED}[error ]${NC} $*" >&2; exit 1; }

# ── guards ─────────────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "This script must be run as root.  Try: sudo bash install/install.sh"

# Must be run from the project root (where package.json lives)
[ -f "package.json" ] || die "Run this script from the project root directory (where package.json lives)."
[ -f "install/install.sh" ] || die "Cannot find install/install.sh — are you in the right directory?"

# Ubuntu 24.04 check (advisory, not fatal)
if command -v lsb_release &>/dev/null; then
  DISTRO="$(lsb_release -si 2>/dev/null || true)"
  RELEASE="$(lsb_release -sr 2>/dev/null || true)"
  if [[ "$DISTRO" != "Ubuntu" || "$RELEASE" != "24.04" ]]; then
    warn "This script is tested on Ubuntu 24.04; detected ${DISTRO} ${RELEASE}."
    warn "Continuing anyway — proceed at your own risk."
  fi
fi

PROJECT_ROOT="$(pwd)"

# ── step 1: system packages ────────────────────────────────────────────────────
log "Updating package lists…"
apt-get update -qq

log "Installing system dependencies…"
apt-get install -y -qq \
  curl \
  ca-certificates \
  gnupg \
  build-essential \
  python3 \
  python3-pip \
  python3-venv \
  python3-dev

# Node.js 20 LTS via NodeSource
if ! command -v node &>/dev/null || [[ "$(node --version | cut -d. -f1 | tr -d 'v')" -lt "$NODE_VERSION" ]]; then
  log "Installing Node.js ${NODE_VERSION} LTS…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
  apt-get install -y -qq nodejs
else
  ok "Node.js $(node --version) already installed."
fi

ok "System packages ready."

# ── step 2: create system user ─────────────────────────────────────────────────
if ! id "$APP_USER" &>/dev/null; then
  log "Creating system user '${APP_USER}'…"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  ok "User '${APP_USER}' created."
else
  ok "User '${APP_USER}' already exists."
fi

# ── step 3: copy application files ────────────────────────────────────────────
log "Installing application to ${INSTALL_DIR}…"
mkdir -p "$INSTALL_DIR"

# Rsync everything except heavyweight / generated directories
rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.env' \
  --exclude='*.env' \
  --exclude='install' \
  "${PROJECT_ROOT}/" \
  "${INSTALL_DIR}/"

# Copy the gridweave SDK wheel if present
if ls "${PROJECT_ROOT}"/gridweave_sdk-*.whl &>/dev/null 2>&1; then
  cp "${PROJECT_ROOT}"/gridweave_sdk-*.whl "${INSTALL_DIR}/"
fi

ok "Application files copied."

# ── step 4: npm install + build ────────────────────────────────────────────────
log "Installing npm dependencies (this may take a few minutes)…"
cd "$INSTALL_DIR"
npm ci --prefer-offline --loglevel=warn

log "Building production bundle…"
npm run build

ok "Build complete."

# ── step 5: Python virtual environment ────────────────────────────────────────
VENV_DIR="${INSTALL_DIR}/venv"
log "Creating Python virtual environment at ${VENV_DIR}…"
python3 -m venv "$VENV_DIR"

log "Installing Python dependencies…"
"${VENV_DIR}/bin/pip" install --upgrade pip --quiet

# Core runtime dependencies
"${VENV_DIR}/bin/pip" install --quiet \
  boto3 \
  s3fs \
  pandas

# GridWeave SDK wheel (use the newest .whl found in the install dir)
WHL_PATH="$(ls -1t "${INSTALL_DIR}"/gridweave_sdk-*.whl 2>/dev/null | head -n1 || true)"
if [ -n "$WHL_PATH" ]; then
  log "Installing gridweave SDK from ${WHL_PATH}…"
  "${VENV_DIR}/bin/pip" install --quiet "$WHL_PATH"
  ok "gridweave SDK installed."
else
  warn "No gridweave_sdk-*.whl found — skipping SDK install."
  warn "Drop the wheel into ${INSTALL_DIR}/ and re-run this script, or install manually:"
  warn "  sudo ${VENV_DIR}/bin/pip install <path-to-wheel>"
fi

ok "Python environment ready."

# ── step 6: config file ────────────────────────────────────────────────────────
mkdir -p "$CONFIG_DIR"
chmod 750 "$CONFIG_DIR"

if [ ! -f "$CONFIG_FILE" ]; then
  log "Creating config file at ${CONFIG_FILE}…"
  # Generate a random session secret
  SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"

  cat > "$CONFIG_FILE" <<ENVFILE
# GridWeave Inspector — runtime configuration
# Edit this file then run:  sudo systemctl restart ${APP_NAME}

PORT=${APP_PORT}

# Auto-generated — change this to a long random string if desired
SESSION_SECRET=${SESSION_SECRET}

# ── GridWeave authentication ─────────────────────────────────────────────────
GRIDWEAVE_TOKEN=your_jwt_here
GRIDWEAVE_PLATFORM_URL=https://platform.gridweave.ai

# ── Garage / S3-compatible object store ──────────────────────────────────────
GARAGE_ENDPOINT_URL=https://garage.example.com
GARAGE_BUCKET=your-bucket
GARAGE_PREFIX=your/prefix/
GARAGE_ACCESS_KEY=your_access_key
GARAGE_SECRET_KEY=your_secret_key
GARAGE_REGION=garage

# ── Python interpreter ────────────────────────────────────────────────────────
PYTHON_BIN=${VENV_DIR}/bin/python

# ── Optional tuning ───────────────────────────────────────────────────────────
# GRIDWEAVE_DEMO=1            # force demo mode (no real GridWeave call)
# PYTHON_TIMEOUT_MS=90000     # per-script timeout in milliseconds
# PYTHON_CHECK_TIMEOUT_MS=300000
ENVFILE

  chmod 640 "$CONFIG_FILE"
  ok "Config file created."
  warn "IMPORTANT: Edit ${CONFIG_FILE} and fill in your real credentials before starting the service."
else
  ok "Config file already exists at ${CONFIG_FILE} — not overwriting."
  # Ensure PYTHON_BIN points to our venv in case it changed
  if grep -q "^PYTHON_BIN=" "$CONFIG_FILE"; then
    sed -i "s|^PYTHON_BIN=.*|PYTHON_BIN=${VENV_DIR}/bin/python|" "$CONFIG_FILE"
  else
    echo "PYTHON_BIN=${VENV_DIR}/bin/python" >> "$CONFIG_FILE"
  fi
fi

# ── step 7: file ownership ─────────────────────────────────────────────────────
log "Setting file ownership…"
chown -R "${APP_USER}:${APP_USER}" "$INSTALL_DIR"
chown root:"${APP_USER}" "$CONFIG_FILE"
chmod 640 "$CONFIG_FILE"
ok "Ownership set."

# ── step 8: systemd service ────────────────────────────────────────────────────
log "Installing systemd service…"

cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=GridWeave Inspector
Documentation=https://github.com/gridweave/gridweave-s3-browser
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${CONFIG_FILE}
ExecStart=/usr/bin/node ${INSTALL_DIR}/dist/index.cjs
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${INSTALL_DIR}
ProtectHome=true
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${APP_NAME}.service"

# Start (or restart if already running)
if systemctl is-active --quiet "${APP_NAME}.service"; then
  log "Restarting ${APP_NAME}.service…"
  systemctl restart "${APP_NAME}.service"
else
  log "Starting ${APP_NAME}.service…"
  systemctl start "${APP_NAME}.service"
fi

ok "Service '${APP_NAME}' enabled and started."

# ── done ───────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  GridWeave Inspector installed successfully!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  App URL      : http://$(hostname -I | awk '{print $1}'):${APP_PORT}"
echo -e "  Config file  : ${CONFIG_FILE}"
echo -e "  Logs         : sudo journalctl -u ${APP_NAME} -f"
echo -e "  Service      : sudo systemctl status ${APP_NAME}"
echo ""
echo -e "${YELLOW}  Next step: edit ${CONFIG_FILE} with real credentials, then:${NC}"
echo -e "${YELLOW}    sudo systemctl restart ${APP_NAME}${NC}"
echo ""
