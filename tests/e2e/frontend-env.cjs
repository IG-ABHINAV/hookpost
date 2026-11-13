/**
 * The environment of the frontend under E2E test, shared by the build
 * (tests/e2e/build-frontend.cjs) and `next start` (playwright.config.ts).
 *
 * Next inlines NEXT_PUBLIC_* and prerenders the marketing pages at build
 * time, so the build must see the same URLs the test server runs with; the
 * app's layouts read the rest at request time.
 *
 * Mirrors production's shape (secure cookies, billing on, new Indian
 * workspaces need a trial) with local URLs and a fake Razorpay key.
 */
const { tmpdir } = require('os');
const { join } = require('path');

const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT || 53000);
const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT || 54200);

/**
 * Plans sold on Gumroad: on unless E2E_GUMROAD=off, which runs the frontend
 * and the backend (server/backend.ts) with the Gumroad variables unset, as
 * production is until they are set. /redeem reads them at request time.
 */
const GUMROAD_ON = process.env.E2E_GUMROAD !== 'off';
const GUMROAD_ENV = GUMROAD_ON
  ? {
      GUMROAD_PRODUCT_STANDARD: 'e2e-standard-product==',
      GUMROAD_PRODUCT_PRO: 'e2e-pro-product==',
      GUMROAD_ACCESS_TOKEN: 'gumroad-integration-token',
    }
  : { GUMROAD_PRODUCT_STANDARD: '', GUMROAD_PRODUCT_PRO: '', GUMROAD_ACCESS_TOKEN: '' };

const frontendEnv = {
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  // Its own build directory, so it never touches a developer's .next.
  NEXT_DIST_DIR: '.next-e2e',
  FRONTEND_URL: `http://localhost:${FRONTEND_PORT}`,
  MAIN_URL: `http://localhost:${FRONTEND_PORT}`,
  NEXT_PUBLIC_BACKEND_URL: `http://localhost:${BACKEND_PORT}`,
  BACKEND_INTERNAL_URL: `http://localhost:${BACKEND_PORT}`,
  STORAGE_PROVIDER: 'local',
  NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY: '/uploads',
  // Where the E2E backend stores uploads (tests/integration/setup/test-env.ts
  // UPLOAD_DIR), so /uploads/... is served by the Next.js route as it is
  // wherever nginx does not stand in front (uploads.spec.ts).
  UPLOAD_DIRECTORY: join(tmpdir(), 'hookpost-int-uploads'),
  // A Chrome extension id (32 letters a-p), so Add Channel offers Skool; the
  // specs stand in for the extension itself (connect-handoff.spec.ts).
  // Read at request time, like production's EXTENSION_ID.
  EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop',
  IS_GENERAL: 'true',
  // billingEnabled in the app; never sent anywhere (checkout.js is stubbed).
  RAZORPAY_KEY_ID: 'rzp_test_integration',
  // The marketing copy (free posts, not the Free plan) and the legal pages'
  // "Last updated" read the cutoff production runs. The backend's own cutoff
  // is a different one, so that a fresh workspace is needs_trial (see
  // E2E_NEEDS_TRIAL_CUTOFF in tests/e2e/server/backend.ts); the browser never
  // reads this key for a plan state, /user/self decides that.
  TRIAL_REQUIRED_SINCE_IN: '2026-10-19T00:00:00Z',
  // No analytics or error reporting from test runs.
  NEXT_PUBLIC_SENTRY_DSN: '',
  SENTRY_DSN: '',
  NEXT_PUBLIC_POSTHOG_KEY: '',
  NEXT_PUBLIC_GTM_ID: '',
  NEXT_PUBLIC_FACEBOOK_PIXEL: '',
  NEXT_PUBLIC_GOOGLE_ADS_ID: '',
  DATAFAST_WEBSITE_ID: '',
  ...GUMROAD_ENV,
};

module.exports = { frontendEnv, BACKEND_PORT, FRONTEND_PORT, GUMROAD_ON, GUMROAD_ENV };
