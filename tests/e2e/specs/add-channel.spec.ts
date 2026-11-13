/**
 * The Add Channel dialog no longer offers Medium: Medium stopped issuing
 * integration tokens, so its "API key" tile could never be completed
 * (RETIRED_PROVIDERS in integration.manager.ts). A Medium channel connected
 * before stays in the channel list and in the composer.
 */
import { expect, Page, test } from '@playwright/test';
import { addChannelButton, api, control, failOnServerErrors, signUpViaApi } from './support';

async function paidWorkspace(page: Page) {
  const account = await signUpViaApi(page.context());
  await control.givePlan(account.email, 'STANDARD');
  return account;
}

/** The names on the Add Channel tiles, once the dialog has rendered them. */
async function addChannelTiles(page: Page) {
  await addChannelButton(page).click();
  const linkedin = page.locator('[role="button"]', { hasText: 'LinkedIn (personal profile)' }).first();
  await expect(linkedin).toBeVisible();
  const grid = linkedin.locator('xpath=..');
  const names = (await grid.locator(':scope > *').allInnerTexts()).map((s) =>
    s.replace(/\bSoon\b/, '').trim()
  );
  const mediumIcons = await grid.locator('img[src="/icons/platforms/medium.png"]').count();
  return { names, mediumIcons };
}

test.describe('Add Channel without Medium', () => {
  test('a customer is not offered Medium; the article networks and the rest still are', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const { auth } = await paidWorkspace(page);
    expect((await api(auth, 'GET', '/integrations')).body.social.map((p: any) => p.identifier)).not.toContain(
      'medium'
    );
    await page.goto('/launches');
    const { names, mediumIcons } = await addChannelTiles(page);
    expect(names.some((n) => /^medium$/i.test(n))).toBe(false);
    expect(mediumIcons).toBe(0);
    for (const name of ['Dev.to', 'Hashnode', 'WordPress', 'Bluesky', 'X']) {
      expect(names).toContain(name);
    }
    expect(names.length).toBeGreaterThan(10);
    errors.assertNone();
  });

  test('a platform admin, who can pick blocked channels, is not offered Medium either', async ({ page }) => {
    const { email } = await paidWorkspace(page);
    await control.makeSuperAdmin(email);
    await page.goto('/launches');
    const { names, mediumIcons } = await addChannelTiles(page);
    expect(names.some((n) => /^medium$/i.test(n))).toBe(false);
    expect(mediumIcons).toBe(0);
    expect(names).toContain('Dev.to');
  });

  test('a Medium channel connected before still shows, in the list and in the composer', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const { email, auth } = await paidWorkspace(page);
    await control.addChannel(email, 'medium', 'E2E Old Medium');
    await control.addChannel(email, 'bluesky', 'E2E Bluesky Beside Medium');

    const listed = (await api(auth, 'GET', '/integrations/list')).body.integrations;
    expect(listed.find((c: any) => c.name === 'E2E Old Medium')).toMatchObject({
      identifier: 'medium',
      disabled: false,
    });

    await page.goto('/launches');
    await expect(page.getByText('E2E Old Medium').first()).toBeVisible();
    await expect(page.getByText('E2E Bluesky Beside Medium').first()).toBeVisible();

    // The composer still offers it as a channel to post to.
    await page.getByRole('button', { name: 'Create Post' }).click();
    await expect(page.locator('.bg-popup img[alt="medium"]').first()).toBeVisible();

    // And Add Channel, with it connected, still leaves Medium out.
    await page.goto('/launches');
    const { names, mediumIcons } = await addChannelTiles(page);
    expect(names.some((n) => /^medium$/i.test(n))).toBe(false);
    expect(mediumIcons).toBe(0);
    errors.assertNone();
  });
});
