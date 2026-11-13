#!/usr/bin/env bash
# ==============================================================================
# scripts/purge-deleted-accounts.sh
# Cron runner for the account purge (AccountPurgeService): erases what accounts
# and workspaces deleted more than 30 days ago leave behind - posts, comments,
# media rows and the stored files behind them, channel tokens and profiles,
# signatures, sets, webhooks, auto-posts, API keys, AI assistant threads.
#
# DRY RUN unless ACCOUNT_PURGE_ENABLED=true is set in ~/hookpost/.env. A dry run
# prints, per workspace and account, the rows and files it would erase, and
# writes nothing. --dry-run forces one even when the purge is enabled.
#
#   By hand, before enabling:  ~/hookpost/scripts/purge-deleted-accounts.sh --dry-run
#   Cron (daily, after the 03:00 media cleanup):
#     20 3 * * * /home/hookpost/hookpost/scripts/purge-deleted-accounts.sh
#
# The logic ships with the backend build (apps/backend/src/cli/account-purge.ts);
# this wrapper does not, so copy it to ~/hookpost/scripts/ after merging.
# Output goes to the terminal and to logs/account-purge-YYYY-MM.log: ids and
# counts only, never file URLs or secrets.
# ==============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/home/hookpost/hookpost}"
if [ ! -d "$APP_DIR" ]; then
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fi

LOG_DIR="${APP_DIR}/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/account-purge-$(date +%Y-%m).log"
ENTRY="apps/backend/dist/apps/backend/src/cli/account-purge.js"

cd "$APP_DIR"
if [ ! -f "$ENTRY" ]; then
  echo "account purge: $ENTRY is missing; deploy a backend build that includes it first" | tee -a "$LOG_FILE" >&2
  exit 1
fi

# dotenv loads .env without overriding what is already set, so
# ACCOUNT_PURGE_ENABLED=false on the command line still means a dry run.
{
  echo "---------- $(date -u '+%Y-%m-%d %H:%M:%S UTC') account purge $* ----------"
  DOTENV_CONFIG_PATH="${APP_DIR}/.env" node --experimental-require-module -r dotenv/config "$ENTRY" "$@"
} 2>&1 | tee -a "$LOG_FILE"
