#!/usr/bin/env bash
# ==============================================================================
# scripts/cleanup-expired-media.sh
# Production Cron Runner for Hookpost Media Retention Cleanup
# ==============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/home/hookpost/hookpost}"
if [ ! -d "$APP_DIR" ]; then
  # Local fallback if testing on Mac
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fi

LOG_DIR="${APP_DIR}/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/media-cleanup-$(date +%Y-%m).log"

{
  echo "----------------------------------------------------------"
  echo "▶ [$(date -u '+%Y-%m-%d %H:%M:%S UTC')] Starting Hookpost Media Cleanup"
  echo "----------------------------------------------------------"
} >> "$LOG_FILE"

cd "$APP_DIR"

# Run with standard 7-day retention window
node scripts/cleanup-expired-media.js --days 7 >> "$LOG_FILE" 2>&1

{
  echo "✔ [$(date -u '+%Y-%m-%d %H:%M:%S UTC')] Media Cleanup Complete"
  echo ""
} >> "$LOG_FILE"
