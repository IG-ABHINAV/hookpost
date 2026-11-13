#!/usr/bin/env bash
# Fails when a frontend build states a trial length that is not Hookpost's
# TRIAL_DAYS (trial.policy.ts) or the trial of a competitor the sentence
# names. The logic and its notes are in check-trial-days.js.
#
#   scripts/check-trial-days.sh [dist dir, default apps/frontend/.next]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec node "$ROOT/scripts/check-trial-days.js" "${1:-$ROOT/apps/frontend/.next}"
