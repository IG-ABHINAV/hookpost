/**
 * E2E for the Chrome extension: the real store build, loaded unpacked into
 * Chromium, messaged from pages served as https://hookpost.hookstep.in and
 * other origins (Playwright serves them; nothing leaves the machine).
 *
 *   pnpm exec playwright install chromium     # once
 *   pnpm exec playwright test -c apps/extension/e2e/playwright.config.ts
 *
 * EXTENSION_E2E_CHROMIUM=<path to a Chromium binary> uses that browser instead
 * of Playwright's. It has to be Chromium or Chrome for Testing: branded Chrome
 * ignores --load-extension since version 137.
 */
import { defineConfig } from '@playwright/test';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// This package is "type": "module", so there is no __dirname.
const here = dirname(fileURLToPath(import.meta.url));

const results = join(here, '..', '..', '..', 'test-results', 'extension-e2e');

export default defineConfig({
  testDir: here,
  testMatch: '*.e2e.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  outputDir: join(results, 'artifacts'),
  reporter: [['list'], ['junit', { outputFile: join(results, 'junit.xml') }]],
});
