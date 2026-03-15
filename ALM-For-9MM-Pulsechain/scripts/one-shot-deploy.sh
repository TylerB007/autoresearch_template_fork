#!/usr/bin/env bash
# =============================================================================
# 9mm V3 Rebalancer — One-Shot VPS Deploy
# Paste this ENTIRE script into your droplet's SSH terminal.
# Tested on Ubuntu 22.04/24.04 LTS
# =============================================================================
set -euo pipefail

APP_DIR="/opt/9mm-rebalancer"
REPO="https://github.com/TylerB007/ALM-For-9MM-Pulsechain.git"
BRANCH="main"

echo "========================================"
echo " 9mm V3 Rebalancer — Full Deploy"
echo "========================================"

# --- 1. System updates + Node.js 20 ---
echo "[1/8] Installing Node.js 20..."
apt-get update -qq
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node $(node -v) / npm $(npm -v)"

# --- 2. Install PM2 ---
echo "[2/8] Installing PM2..."
npm install -g pm2 --silent 2>/dev/null
echo "  PM2 $(pm2 --version)"

# --- 3. Install git if needed ---
echo "[3/8] Ensuring git is installed..."
apt-get install -y -qq git

# --- 4. Clone or update repo ---
echo "[4/8] Setting up repository..."
if [[ -d "${APP_DIR}/.git" ]]; then
  echo "  Repo exists, pulling latest..."
  cd "$APP_DIR"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git pull origin "$BRANCH" --ff-only
else
  echo "  Cloning fresh..."
  git clone -b "$BRANCH" "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

# --- 5. Create .env if missing ---
echo "[5/8] Checking configuration..."
if [[ ! -f ".env" ]]; then
  cp .env.example .env
  echo ""
  echo "  ================================================"
  echo "  IMPORTANT: .env file created from template."
  echo "  You MUST edit it with your private key:"
  echo "    nano ${APP_DIR}/.env"
  echo "  ================================================"
  echo ""
fi

# --- 6. Install deps + build ---
echo "[6/8] Installing dependencies and building..."
npm install --silent
npm run build
echo "  Build complete."

# --- 7. Create logs dir + start PM2 ---
echo "[7/8] Starting with PM2..."
mkdir -p logs
if pm2 describe 9mm-rebalancer &>/dev/null 2>&1; then
  pm2 restart ecosystem.config.cjs
  echo "  Restarted existing process."
else
  pm2 start ecosystem.config.cjs
  echo "  Started new process."
fi
pm2 save --silent

# --- 8. PM2 startup on boot ---
echo "[8/8] Configuring PM2 boot startup..."
pm2 startup systemd --silent 2>/dev/null || pm2 startup --silent 2>/dev/null || true
pm2 save --silent

echo ""
echo "========================================"
echo " Deploy complete!"
echo "========================================"
echo ""
pm2 status
echo ""
echo "Commands:"
echo "  pm2 logs 9mm-rebalancer     # Live logs"
echo "  pm2 monit                   # Resource monitor"
echo "  pm2 stop 9mm-rebalancer     # Stop bot"
echo "  pm2 restart 9mm-rebalancer  # Restart bot"
echo "  nano ${APP_DIR}/.env        # Edit private key"
echo "  nano ${APP_DIR}/config.yaml # Edit positions & strategies"
echo ""
echo "NOTE: dry_run is ON by default. Edit config.yaml"
echo "and set dry_run: false when you're ready to go live."
echo ""
