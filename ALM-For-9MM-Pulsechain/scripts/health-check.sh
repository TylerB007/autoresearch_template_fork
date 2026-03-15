#!/usr/bin/env bash
# =============================================================================
# 9mm V3 Rebalancer — Health Check
# Run periodically via cron to auto-restart if the process dies unexpectedly.
# Add to crontab:  */5 * * * * /opt/9mm-rebalancer/app/scripts/health-check.sh
# =============================================================================
set -euo pipefail

PROCESS_NAME="9mm-rebalancer"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="${PROJECT_DIR}/logs/health-check.log"

mkdir -p "$(dirname "$LOG_FILE")"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

# Check if PM2 process is running
STATUS=$(pm2 jlist 2>/dev/null | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const proc = data.find(p => p.name === '${PROCESS_NAME}');
  console.log(proc ? proc.pm2_env.status : 'not_found');
" 2>/dev/null || echo "pm2_error")

case "$STATUS" in
  online)
    # All good, no action needed
    ;;
  stopped|errored)
    echo "$(timestamp) Process ${PROCESS_NAME} is ${STATUS}. Restarting..." >> "$LOG_FILE"
    pm2 restart "$PROCESS_NAME" >> "$LOG_FILE" 2>&1
    echo "$(timestamp) Restart triggered." >> "$LOG_FILE"
    ;;
  not_found)
    echo "$(timestamp) Process ${PROCESS_NAME} not found in PM2. Starting..." >> "$LOG_FILE"
    cd "$PROJECT_DIR"
    pm2 start ecosystem.config.cjs >> "$LOG_FILE" 2>&1
    pm2 save --silent
    echo "$(timestamp) Started and saved." >> "$LOG_FILE"
    ;;
  pm2_error)
    echo "$(timestamp) PM2 not responding or not installed." >> "$LOG_FILE"
    ;;
esac
