#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# GridWeave Inspector — uninstall script
#
# Usage:
#   sudo bash install/uninstall.sh
#
# Removes:
#   - The systemd service (stopped + disabled)
#   - Application files at /opt/gridweave-inspector
#   - Config directory at /etc/gridweave-inspector  (prompted)
#   - The 'gridweave' system user
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

APP_NAME="gridweave-inspector"
INSTALL_DIR="/opt/${APP_NAME}"
CONFIG_DIR="/etc/${APP_NAME}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
APP_USER="gridweave"

if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
fi

log()  { echo -e "${CYAN}[remove ]${NC} $*"; }
ok()   { echo -e "${GREEN}[  ok  ]${NC} $*"; }
warn() { echo -e "${YELLOW}[ warn ]${NC} $*"; }
die()  { echo -e "${RED}[error ]${NC} $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "This script must be run as root.  Try: sudo bash install/uninstall.sh"

echo ""
echo -e "${RED}This will remove GridWeave Inspector from this system.${NC}"
echo -e "  Service  : ${APP_NAME}"
echo -e "  App dir  : ${INSTALL_DIR}"
echo -e "  Config   : ${CONFIG_DIR}"
echo -e "  User     : ${APP_USER}"
echo ""
read -rp "Continue? [y/N] " CONFIRM
[[ "${CONFIRM,,}" == "y" ]] || { echo "Aborted."; exit 0; }

# Stop and disable service
if systemctl is-active --quiet "${APP_NAME}.service" 2>/dev/null; then
  log "Stopping service…"
  systemctl stop "${APP_NAME}.service"
fi

if systemctl is-enabled --quiet "${APP_NAME}.service" 2>/dev/null; then
  log "Disabling service…"
  systemctl disable "${APP_NAME}.service"
fi

if [ -f "$SERVICE_FILE" ]; then
  log "Removing service file…"
  rm -f "$SERVICE_FILE"
  systemctl daemon-reload
  ok "Service removed."
fi

# Remove application directory
if [ -d "$INSTALL_DIR" ]; then
  log "Removing ${INSTALL_DIR}…"
  rm -rf "$INSTALL_DIR"
  ok "Application directory removed."
fi

# Config directory — ask because it contains user credentials
if [ -d "$CONFIG_DIR" ]; then
  echo ""
  warn "Config directory ${CONFIG_DIR} contains your credentials."
  read -rp "Delete it too? [y/N] " DEL_CFG
  if [[ "${DEL_CFG,,}" == "y" ]]; then
    rm -rf "$CONFIG_DIR"
    ok "Config directory removed."
  else
    ok "Config directory kept at ${CONFIG_DIR}."
  fi
fi

# Remove system user
if id "$APP_USER" &>/dev/null; then
  log "Removing system user '${APP_USER}'…"
  userdel "$APP_USER"
  ok "User '${APP_USER}' removed."
fi

echo ""
echo -e "${GREEN}GridWeave Inspector has been uninstalled.${NC}"
echo ""
