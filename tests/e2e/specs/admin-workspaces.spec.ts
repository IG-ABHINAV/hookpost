/**
 * The workspace level of the super-admin Users page (/admin/users): each row
 * says the user's role and how many members their workspace has; the user
 * panel lists every workspace with role and members; the source chips
 * (Direct / api.market / ...) open a Workspaces list with members, billing,
 * channels, posts, created, and for a marketplace subscriber its masked id,
 * plan and calls in the last 7 days.
 *
 * Test accounts only; the marketplace subscriber calls through the real
 * gateway the way api.market forwards (integration/setup/marketplace.ts).
 */
import { expect, test } from '@playwright/test';
import { BACKEND, control, failOnServerErrors, signUpViaApi } from './support';
import { Gateway, newSubscriber } from '../../integration/setup/marketplace';

const api = new Gateway(BACKEND);

test.describe('admin users page: workspaces', () => {
  test('roles and members per row and in the panel; the Workspaces list per source', async ({ page, browser }) => {
    const errors = failOnServerErrors(page);

    // A team of three (the owner and two seats) and a marketplace subscriber
    // that made two calls.
    const context = await browser.newContext();
    const owner = await signUpViaApi(context, { country: 'US' });
    await context.close();
    await control.addSeats(owner.email, 2);
    const subscriber = newSubscriber();
    for (let i = 0; i < 2; i++) {
      expect((await api.call({ product: 'validate', plan: 'trial', user: subscriber, path: '/rules' })).status).toBe(200);
    }

    const admin = await signUpViaApi(page.context());
    await control.givePlan(admin.email, 'STANDARD');
    await control.makeSuperAdmin(admin.email);
    await page.goto('/admin/users');

    // The row: role and members.
    const row = page.getByRole('row').filter({ hasText: owner.email });
    await expect(row.getByTestId('user-workspace-role')).toHaveText('Owner · 3 members');

    // The panel: the user's workspaces.
    await row.locator('[data-testid^="user-source-"]').first().click();
    const mine = page.getByTestId('user-workspaces');
    await expect(mine.getByTestId('user-workspace')).toHaveCount(1);
    await expect(mine.getByTestId('user-workspace').first()).toContainText('Owner · 3 members · Direct');
    await page.getByRole('button', { name: '✕', exact: true }).click();

    // Direct chip: the team's workspace, no marketplace block.
    await page.getByTestId('users-source-DIRECT').click();
    const list = page.getByTestId('workspaces-list');
    await expect(list).toContainText('Direct workspaces');
    await list.getByPlaceholder(/Search workspace/).fill(owner.email);
    const team = list.getByTestId('workspace-row');
    await expect(team).toHaveCount(1);
    await expect(team.locator('td').nth(2)).toHaveText('3');
    await expect(team.getByTestId('billing-state')).toBeVisible();
    await expect(team.locator('td').nth(6)).toHaveText(/^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} IST$/);
    await expect(team.getByTestId('workspace-marketplace')).toHaveCount(0);

    // api.market chip: the subscriber, masked, with its plan and 2 calls.
    await page.getByTestId('users-source-API_MARKET').click();
    await expect(list).toContainText('workspaces');
    await list.getByPlaceholder(/Search workspace/).fill('');
    const mkt = list.getByTestId('workspace-row').filter({ hasText: subscriber.slice(0, 4) });
    await expect(mkt.first().getByTestId('workspace-marketplace')).toContainText('validate · trial · active · 2 calls in 7 days');
    await expect(list).not.toContainText(subscriber);
    await expect(list.getByTestId('workspace-row').filter({ hasText: owner.email })).toHaveCount(0);

    // All workspaces, then closed.
    await page.getByTestId('users-source-ALL').click();
    await expect(list).toContainText('All workspaces');
    await page.getByRole('button', { name: 'Close workspaces' }).click();
    await expect(list).toHaveCount(0);

    errors.assertNone();
  });
});
