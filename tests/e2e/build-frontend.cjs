#!/usr/bin/env node
/**
 * Builds the frontend for the E2E suite into apps/frontend/.next-e2e, with
 * the E2E URLs baked in (tests/e2e/frontend-env.cjs). Run from the repo root:
 *
 *   node tests/e2e/build-frontend.cjs
 *
 * Takes several minutes and a few GB of memory; on a laptop run it through
 * the one-at-a-time lock (~/.local/bin/heavy). Rebuild after frontend changes:
 * the E2E server serves exactly this build.
 */
const { spawnSync } = require('child_process');
const { join } = require('path');
const { frontendEnv } = require('./frontend-env.cjs');

const root = join(__dirname, '..', '..');
const result = spawnSync(
  'pnpm',
  ['--filter', 'hookpost-frontend', 'exec', 'next', 'build'],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...frontendEnv,
      // The heap the CI build uses (build.yml); NODE_OPTIONS from the shell
      // comes after it, so it wins.
      NODE_OPTIONS: ['--max-old-space-size=6144', process.env.NODE_OPTIONS].filter(Boolean).join(' '),
    },
  }
);
process.exit(result.status ?? 1);
