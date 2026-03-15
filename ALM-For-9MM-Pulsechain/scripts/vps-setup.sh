#!/usr/bin/env bash
# =============================================================================
# 9mm V3 Rebalancer — DigitalOcean VPS Initial Setup
# Run this ONCE on a fresh droplet: curl ... | bash  or  bash vps-setup.sh
# Tested on Ubuntu 22.04 / 24.04 LTS
# =============================================================================
set -euo pipefail

APP_DIR="/opt/9mm-rebalancer"
APP_USER="rebalancer"
NODE_VERSION="20"

echo "========================================"
echo " 9mm V3 Rebalancer — VPS Setup"
echo "========================================"

# --- 1. System updates ---
echo "[1/7] Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

# --- 2. Install Node.js via NodeSource ---
echo "[2/7] Installing Node.js ${NODE_VERSION}.x..."
if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_VERSION" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node $(node -v) / npm $(npm -v)"

# --- 3. Install PM2 globally ---
echo "[3/7] Installing PM2..."
npm install -g pm2 --silent
pm2 --version

# --- 4. Create dedicated service user ---
echo "[4/7] Creating service user '${APP_USER}'..."
if ! id "$APP_USER" &>/dev/null; then
  useradd --system --create-home --shell /bin/bash "$APP_USER"
  echo "  Created user: ${APP_USER}"
else
  echo "  User '${APP_USER}' already exists, skipping."
fi

# --- 5. Create app directory ---
echo "[5/7] Setting up application directory at ${APP_DIR}..."
mkdir -p "$APP_DIR"
chown "${APP_USER}:${APP_USER}" "$APP_DIR"

# --- 6. Configure PM2 startup ---
echo "[6/7] Configuring PM2 to start on boot..."
pm2 startup systemd -u "$APP_USER" --hp "/home/${APP_USER}" --silent
echo "  PM2 will auto-start as '${APP_USER}' on reboot."

# --- 7. Configure firewall (optional but recommended) ---
echo "[7/7] Configuring firewall..."
if command -v ufw &>/dev/null; then
  ufw allow OpenSSH --quiet
  ufw --force enable --quiet
  echo "  UFW enabled — SSH allowed, all other inbound blocked."
else
  echo "  UFW not found, skipping firewall setup."
fi

echo ""
echo "========================================"
echo " Setup complete!"
echo "========================================"
echo ""
echo "Next steps:"
echo "  1. Clone your repo into ${APP_DIR}:"
echo "     sudo -u ${APP_USER} git clone <your-repo-url> ${APP_DIR}/app"
echo ""
echo "  2. Configure the bot:"
echo "     cd ${APP_DIR}/app"
echo "     cp .env.example .env"
echo "     nano .env          # Set your PRIVATE_KEY"
echo "     nano config.yaml   # Configure positions & strategies"
echo ""
echo "  3. Deploy:"
echo "     sudo -u ${APP_USER} bash ${APP_DIR}/app/scripts/deploy.sh"
echo ""
