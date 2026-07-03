#!/bin/bash

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${GREEN}[pi-booth]${NC} $1"; }
warn()    { echo -e "${YELLOW}[pi-booth]${NC} $1"; }
error()   { echo -e "${RED}[pi-booth]${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- System dependencies ---

APT_PACKAGES=(gphoto2 libvips-dev librsvg2-dev cups)
MISSING_APT=()

info "Checking system dependencies..."
for pkg in "${APT_PACKAGES[@]}"; do
  if ! dpkg -s "$pkg" &>/dev/null; then
    MISSING_APT+=("$pkg")
  fi
done

if [ ${#MISSING_APT[@]} -gt 0 ]; then
  warn "Installing missing packages: ${MISSING_APT[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y "${MISSING_APT[@]}"
else
  info "All system packages present."
fi

# --- Node.js ---

NODE_MAJOR=20
if ! command -v node &>/dev/null; then
  warn "Node.js not found, installing v${NODE_MAJOR}..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  info "Node.js $(node -v) found."
fi

# --- pm2 ---

if ! command -v pm2 &>/dev/null; then
  warn "pm2 not found, installing globally..."
  sudo npm install -g pm2
fi
info "pm2 $(pm2 -v) found."

# --- npm dependencies ---

info "Installing server dependencies..."
cd "$SCRIPT_DIR/server" && npm install --omit=dev

info "Installing client dependencies..."
cd "$SCRIPT_DIR/client" && npm install

# --- Build client ---

info "Building client..."
cd "$SCRIPT_DIR/client" && npm run build

# --- SSL certificate ---

SSL_DIR="$SCRIPT_DIR/server/ssl"
CERT="$SSL_DIR/cert.pem"
KEY="$SSL_DIR/key.pem"

mkdir -p "$SSL_DIR"
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  info "Generating self-signed SSL certificate..."
  PI_IP=$(hostname -I | awk '{print $1}')
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=pi-booth" \
    -addext "subjectAltName=IP:${PI_IP},IP:127.0.0.1,DNS:booth.local,DNS:localhost"
  info "Certificate generated (valid 10 years)."
  info ""
  warn "ACTION REQUIRED: Trust the certificate on your iPad."
  warn "  1. Open https://${PI_IP} in Safari"
  warn "  2. Tap 'Show Details' then 'visit this website'"
  warn "  3. Go to Settings > General > About > Certificate Trust Settings"
  warn "  4. Enable full trust for 'pi-booth'"
  info ""
else
  info "SSL certificate found."
fi

# --- Allow Node to bind to port 443 without root ---

NODE_BIN="$(command -v node)"
if ! getcap "$NODE_BIN" 2>/dev/null | grep -q cap_net_bind_service; then
  warn "Granting Node.js permission to bind to port 443..."
  sudo setcap cap_net_bind_service=+ep "$NODE_BIN"
fi

# --- Start with pm2 ---

cd "$SCRIPT_DIR"

# Stop existing instance if running
pm2 delete pi-booth 2>/dev/null || true

info "Starting pi-booth with pm2..."
pm2 start ecosystem.config.js

# Save pm2 process list so it survives reboot
pm2 save

# Set pm2 to start on boot (only needs to run once, safe to re-run)
pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | bash 2>/dev/null || \
  warn "Could not auto-configure pm2 startup. Run 'pm2 startup' manually if needed."

info ""
info "Pi Booth is running!"
info "Open https://$(hostname -I | awk '{print $1}') on your iPad."
info ""
info "Useful commands:"
info "  pm2 logs pi-booth     — view logs"
info "  pm2 restart pi-booth  — restart the app"
info "  pm2 stop pi-booth     — stop the app"
