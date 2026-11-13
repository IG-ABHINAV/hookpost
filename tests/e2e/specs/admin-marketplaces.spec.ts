/**
 * The super-admin Marketplaces page (/admin/marketplaces) and the source line
 * on Users & Billing, against the E2E backend and the production build of
 * the frontend. Calls are made the way each marketplace's proxy forwards
 * them (api.market: setup/marketplace.ts; RapidAPI: setup/marketplace-
 * adapters.ts), then the page must show them: subscribers paying vs free,
 * calls today / 7 / 30 days, refusals by kind, the last call, and workspaces
 * per source. Numbers are read before and after, so other specs' calls in
 * the same database do not matter.
 *
 * The admin is a test account made here (signUpViaApi + makeSuperAdmin).
 *   pnpm exec playwright test -c tests/e2e/playwright.config.ts admin-marketplaces
 */
import { expect, Locator, Page, test } from '@playwright/test';
import { BACKEND, control, failOnServerErrors, signUpViaApi } from './support';
import { Gateway, newSubscriber } from '../../integration/setup/marketplace';
import { newRapidUser, RapidGateway } from '../../integration/setup/marketplace-adapters';

const api = new Gateway(BACKEND);
const rapid = new RapidGateway(BACKEND);
const CHECK = { text: 'hello world', platforms: ['x'], media: [] };

const num = async (l: Locator) => Number((await l.innerText()).replace(/[^\d]/g, ''));

async function readRow(page: Page, id: string) {
  const row = page.getByTestId(`mkt-row-${id}`);
  await expect(row).toBeVisible();
  const errors = row.getByTestId('mkt-errors');
  return {
    row,
    subscribers: id === 'UNKNOWN' ? 0 : await num(row.getByTestId('mkt-subscribers')),
    paying: id === 'UNKNOWN' ? 0 : await num(row.getByTestId('mkt-paying')),
    free: id === 'UNKNOWN' ? 0 : await num(row.getByTestId('mkt-free')),
    today: await num(row.getByTestId('mkt-calls-today')),
    d7: await num(row.getByTestId('mkt-calls-7d')),
    d30: await num(row.getByTestId('mkt-calls-30d')),
    e401: await num(errors.getByTestId('mkt-errors-401').locator('b')),
    e403: await num(errors.getByTestId('mkt-errors-403').locator('b')),
  };
}

const sourceCount = async (page: Page, id: string) =>
  num(page.getByTestId(`source-${id}`).getByTestId('source-count'));

test.describe('admin: Marketplaces', () => {
  test('per marketplace: subscribers, paying vs free, calls, refusals and last call; workspaces per source', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const admin = await signUpViaApi(page.context());
    await control.givePlan(admin.email, 'STANDARD');
    await control.makeSuperAdmin(admin.email);

    await page.goto('/admin/marketplaces');
    await expect(page.getByRole('link', { name: '🛒 Marketplaces' })).toHaveClass(/bg-primary/);
    const before = {
      rapid: await readRow(page, 'RAPIDAPI'),
      api: await readRow(page, 'API_MARKET'),
      unknown: await readRow(page, 'UNKNOWN'),
      rapidSource: await sourceCount(page, 'RAPIDAPI'),
    };
    await expect(before.rapid.row.getByTestId('mkt-configured')).toContainText('Live: social, linkedin, x, validate');

    // Through RapidAPI: a free buyer, a paying one, a wrong proxy secret, a plan not sold.
    const free = newRapidUser();
    const paying = newRapidUser();
    expect((await rapid.call({ product: 'validate', user: free, subscription: 'BASIC', path: '/rules' })).status).toBe(200);
    expect((await rapid.call({ product: 'validate', user: paying, subscription: 'PRO', path: '/check', body: CHECK })).status).toBe(200);
    expect(
      (await rapid.call({ product: 'validate', user: free, subscription: 'BASIC', path: '/rules', headers: { 'x-rapidapi-proxy-secret': 'wrong-proxy-secret-0123456789abcdef' } })).status
    ).toBe(401);
    expect((await rapid.call({ product: 'validate', user: free, subscription: 'CUSTOM', path: '/rules' })).status).toBe(403);
    // Through api.market, and one naming no marketplace.
    expect((await api.call({ product: 'validate', plan: 'trial', user: newSubscriber(), path: '/rules' })).status).toBe(200);
    expect((await fetch(`${BACKEND}/mkt/v1/validate/rules`)).status).toBe(401);
    await page.waitForTimeout(300);

    await page.reload();
    const rapidAfter = await readRow(page, 'RAPIDAPI');
    expect(rapidAfter.subscribers - before.rapid.subscribers).toBe(2);
    expect(rapidAfter.paying - before.rapid.paying).toBe(1);
    expect(rapidAfter.free - before.rapid.free).toBe(1);
    expect(rapidAfter.today - before.rapid.today).toBe(4);
    expect(rapidAfter.d7 - before.rapid.d7).toBe(4);
    expect(rapidAfter.d30 - before.rapid.d30).toBe(4);
    expect(rapidAfter.e401 - before.rapid.e401).toBe(1);
    expect(rapidAfter.e403 - before.rapid.e403).toBe(1);
    await expect(rapidAfter.row.getByTestId('mkt-last-call')).toHaveText(/seconds? ago|a minute ago/);

    const apiAfter = await readRow(page, 'API_MARKET');
    expect(apiAfter.subscribers - before.api.subscribers).toBe(1);
    expect(apiAfter.today - before.api.today).toBe(1);
    const unknownAfter = await readRow(page, 'UNKNOWN');
    expect(unknownAfter.today - before.unknown.today).toBe(1);
    expect(unknownAfter.e401 - before.unknown.e401).toBe(1);

    expect((await sourceCount(page, 'RAPIDAPI')) - before.rapidSource).toBe(2);
    expect(await sourceCount(page, 'DIRECT')).toBeGreaterThan(0);

    // The refusals column follows the window chosen.
    await page.getByTestId('window-30d').click();
    await expect(page.getByTestId('window-30d')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('columnheader', { name: 'Refusals (30 days)' })).toBeVisible();
    expect(await num(page.getByTestId('mkt-row-RAPIDAPI').getByTestId('mkt-errors-401').locator('b'))).toBeGreaterThanOrEqual(1);

    // Users & Billing: workspaces per source, linking here.
    await page.goto('/admin/users');
    const sources = page.getByTestId('users-sources');
    await expect(sources).toBeVisible();
    await expect(page.getByTestId('users-source-DIRECT')).toContainText('Direct:');
    await expect(page.getByTestId('users-source-RAPIDAPI')).toContainText('RapidAPI:');
    await expect(page.getByTestId('users-source-API_MARKET')).toContainText('api.market:');
    await sources.getByRole('link', { name: /Marketplaces/ }).click();
    await expect(page).toHaveURL(/\/admin\/marketplaces$/);
    await expect(page.getByTestId('mkt-row-RAPIDAPI')).toBeVisible();

    errors.assertNone();
  });

  test('is not shown to a user who is not a super admin', async ({ page }) => {
    const someone = await signUpViaApi(page.context());
    await control.givePlan(someone.email, 'STANDARD');
    await page.goto('/admin/marketplaces');
    await expect(page.getByText('You are not authorized to view the Super Admin panel.')).toBeVisible();
    await expect(page.getByTestId('mkt-row-RAPIDAPI')).toHaveCount(0);
  });
});
