#!/usr/bin/env bash
# =============================================================================
# 9mm V3 Rebalancer — Deploy / Update
# Run from the project root:  bash scripts/deploy.sh
# Safe to run repeatedly — pulls latest code, rebuilds, restarts PM2.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "========================================"
echo " 9mm V3 Rebalancer — Deploy"
echo "========================================"
echo " Directory: ${PROJECT_DIR}"
echo ""

# --- Pre-flight checks ---
echo "[1/6] Pre-flight checks..."
if [[ ! -f ".env" ]]; then
  echo "  ERROR: .env file not found. Copy .env.example to .env and configure it."
  exit 1
fi

if [[ ! -f "config.yaml" ]]; then
  echo "  ERROR: config.yaml not found."
  exit 1
fi

if ! command -v pm2 &>/dev/null; then
  echo "  ERROR: PM2 not installed. Run: npm install -g pm2"
  exit 1
fi

echo "  All checks passed."

# --- Pull latest changes ---
echo "[2/6] Pulling latest changes..."
if git rev-parse --is-inside-work-tree &>/dev/null; then
  BRANCH=$(git branch --show-current)
  echo "  Branch: ${BRANCH}"
  git pull origin "$BRANCH" --ff-only || {
    echo "  WARNING: git pull failed (maybe not a git repo or conflicts). Continuing with local code."
  }
else
  echo "  Not a git repo, skipping pull."
fi

# --- Install dependencies ---
echo "[3/6] Installing dependencies..."
npm ci --omit=dev --silent 2>/dev/null || npm install --omit=dev --silent
echo "  Dependencies installed."

# --- Build ---
echo "[4/6] Building TypeScript..."
# Need dev deps for tsc, install then prune after
npm install --silent
npm run build
npm prune --omit=dev --silent 2>/dev/null || true
echo "  Build complete: dist/"

# --- Create logs directory ---
echo "[5/6] Ensuring logs directory..."
mkdir -p logs

# --- Start/Restart PM2 ---
echo "[6/6] Starting with PM2..."
if pm2 describe 9mm-rebalancer &>/dev/null; then
  pm2 restart ecosystem.config.cjs
  echo "  Restarted existing process."
else
  pm2 start ecosystem.config.cjs
  echo "  Started new process."
fi

# Save PM2 process list (survives reboot)
pm2 save --silent

echo ""
echo "========================================"
echo " Deploy complete!"
echo "========================================"
echo ""
echo "Useful commands:"
echo "  pm2 status              # Process status"
echo "  pm2 logs 9mm-rebalancer # Live log stream"
echo "  pm2 monit               # Resource monitor"
echo "  pm2 stop 9mm-rebalancer # Stop the bot"
echo "  pm2 restart 9mm-rebalancer  # Restart"
echo ""

# Show current status
pm2 status
