#!/usr/bin/env bash
# Fails when a frontend build made with a trial cutoff (TRIAL_REQUIRED_SINCE_IN
# or _GLOBAL) still offers new users a Free plan, "no card" or a free start.
# PR-3 of local-assets/trial-usd-plan-2026-10-18.md; the logic and its notes are
# in check-free-claims.js, the reviewed exceptions in check-free-claims.allow.
#
#   scripts/check-free-claims.sh [dist dir, default apps/frontend/.next]
#
# Run it on a build made WITH a cutoff. Build one without touching .next:
#   cd apps/frontend && TRIAL_REQUIRED_SINCE_IN=2026-10-20T00:00:00Z \
#     NEXT_DIST_DIR=.next-trial NODE_ENV=production pnpm exec next build
#   scripts/check-free-claims.sh apps/frontend/.next-trial
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec node "$ROOT/scripts/check-free-claims.js" "${1:-$ROOT/apps/frontend/.next}"
