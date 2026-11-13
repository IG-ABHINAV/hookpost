/**
 * E2E: a real browser against the real frontend (a production `next build`)
 * and the real backend (AppModule on Postgres and Redis), with Temporal,
 * Razorpay and the social networks' token exchange faked at the edge. See
 * tests/e2e/server/backend.ts and TESTING.md.
 *
 *   node tests/e2e/build-frontend.cjs        # once per frontend change
 *   pnpm exec playwright test -c tests/e2e/playwright.config.ts
 *
 * Needs the test stack (tests/stack) up. Playwright starts both servers and
 * stops them afterwards; a server already listening on its port is reused
 * outside CI.
 */
import { defineConfig, devices } from '@playwright/test';
import { join } from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { frontendEnv, BACKEND_PORT, FRONTEND_PORT } = require('./frontend-env.cjs');

const root = join(__dirname, '..', '..');
const CI = !!process.env.CI;
const results = process.env.E2E_RESULTS_DIR || join(root, 'test-results', 'e2e');

export default defineConfig({
  testDir: join(__dirname, 'specs'),
  // Fails the run if the backend tried to reach a host other than localhost.
  globalTeardown: join(__dirname, 'global-teardown.ts'),
  outputDir: join(results, 'artifacts'),
  // One browser at a time: the specs share one backend and database, and this
  // keeps a laptop responsive (see TESTING.md, memory).
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: join(results, 'report') }],
    ['junit', { outputFile: join(results, 'junit.xml') }],
  ],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    // Asia/Kolkata puts a new workspace in the Indian cohort, which has to
    // start a trial (trial.policy.ts reads the browser's timezone).
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    // A locally installed Chrome instead of Playwright's download, e.g.
    // E2E_BROWSER_CHANNEL=chrome. CI installs Playwright's Chromium.
    ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}),
  },
  // Desktop Chrome runs every spec. The phone projects run only the phone
  // layout specs (mobile-*.spec.ts): an iPhone in WebKit, Safari's engine,
  // and an Android phone in Chromium. CI installs webkit for them.
  projects: [
    {
      name: 'desktop',
      testIgnore: /mobile-.*\.spec\.ts/,
    },
    {
      name: 'desktop-layout',
      testMatch: /mobile-.*\.spec\.ts/,
    },
    {
      name: 'iphone',
      testMatch: /mobile-.*\.spec\.ts/,
      use: { ...devices['iPhone 13'], browserName: 'webkit', channel: undefined },
    },
    {
      name: 'iphone-se',
      testMatch: /mobile-.*\.spec\.ts/,
      use: { ...devices['iPhone SE'], browserName: 'webkit', channel: undefined },
    },
    {
      name: 'android',
      testMatch: /mobile-.*\.spec\.ts/,
      use: { ...devices['Pixel 7'], browserName: 'chromium', channel: undefined },
    },
  ],
  webServer: [
    {
      name: 'backend',
      command: 'node -r ./tests/e2e/server/register.cjs tests/e2e/server/backend.ts',
      cwd: root,
      url: `http://localhost:${BACKEND_PORT}/health`,
      timeout: 180_000,
      reuseExistingServer: !CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      name: 'frontend',
      command: `pnpm --filter hookpost-frontend exec next start -p ${FRONTEND_PORT}`,
      cwd: root,
      env: { ...frontendEnv },
      url: `http://localhost:${FRONTEND_PORT}/pricing`,
      timeout: 180_000,
      reuseExistingServer: !CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
