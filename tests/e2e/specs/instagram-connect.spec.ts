/**
 * Instagram in Add Channel and the empty Facebook-login picker. From 25 Oct
 * to 8 Nov, 4 of the 10 people who tried a channel picked the Facebook-login
 * Instagram, got 0 Pages (backend log `awaitingPagePick:true, pages:0`) and
 * left. The tiles now say what each needs, Instagram without a Page comes
 * first when it is open to the viewer, and the empty picker leads with "No
 * Facebook Page found." and, when it can, "Connect Instagram directly
 * instead" with a button that starts Instagram login.
 *
 * Instagram login (instagram-standalone) still waits on Meta's App Review
 * (NOT_AVAILABLE_YET in add.channel.helpers.ts), so a customer sees it greyed
 * and last; a platform admin, who can use blocked channels, sees it open.
 * The picker's Graph call is answered in the browser with an empty list, so
 * nothing reaches Meta.
 */
import { expect, Page, test } from '@playwright/test';
import { addChannelButton, BACKEND, control, failOnServerErrors, signUpViaApi } from './support';

const DIRECT = 'Instagram (no Facebook Page needed)';
const VIA_PAGE = 'Instagram via Facebook Page (Business account + linked Page)';

async function paidWorkspace(page: Page, admin = false) {
  const account = await signUpViaApi(page.context());
  await control.givePlan(account.email, 'STANDARD');
  if (admin) await control.makeSuperAdmin(account.email);
  return account;
}

/** Tile names in grid order, one line each, without the "Soon" badge. */
async function addChannelTiles(page: Page) {
  await addChannelButton(page).click();
  const anchor = page.locator('[role="button"]', { hasText: 'LinkedIn (personal profile)' }).first();
  await expect(anchor).toBeVisible();
  const grid = anchor.locator('xpath=..');
  return (await grid.locator(':scope > *').allInnerTexts()).map((s) =>
    s.replace(/\bSoon\b/, '').replace(/\s+/g, ' ').trim()
  );
}

/** Opens the Instagram (via Facebook Page) picker as Meta would leave it: no Page. */
async function openEmptyInstagramPicker(page: Page, email: string) {
  const { id } = await control.addChannel(email, 'instagram', 'E2E IG placeholder', {
    inBetweenSteps: true,
  });
  await page.route(`${BACKEND}/integrations/function`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.goto(`/launches?added=instagram&continue=${id}`);
  await expect(page.getByRole('heading', { name: 'No Facebook Page found.' })).toBeVisible();
}

test.describe('Instagram connect: tiles and the 0 Pages screen', () => {
  test('a customer sees the Facebook-login Instagram named for its Page; Instagram login waits, greyed and last', async ({
    page,
  }) => {
    const errors = failOnServerErrors(page);
    await paidWorkspace(page);
    await page.goto('/launches');
    const names = await addChannelTiles(page);
    expect(names).toContain(VIA_PAGE);
    expect(names).not.toContain('Instagram (Facebook Business)');
    expect(names).toContain(DIRECT);
    expect(names.indexOf(DIRECT)).toBeGreaterThan(names.indexOf(VIA_PAGE));
    errors.assertNone();
  });

  test('where Instagram login is open (platform admin), it is the first Instagram tile', async ({ page }) => {
    await paidWorkspace(page, true);
    await page.goto('/launches');
    const names = await addChannelTiles(page);
    expect(names).toContain(DIRECT);
    expect(names.indexOf(DIRECT)).toBe(names.indexOf(VIA_PAGE) - 1);
  });

  test('0 Pages, customer: "No Facebook Page found." and no button that would fail', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const { email } = await paidWorkspace(page);
    await openEmptyInstagramPicker(page, email);
    await expect(page.getByText(/waiting on Meta's approval/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect Instagram directly' })).toHaveCount(0);
    errors.assertNone();
  });

  test('0 Pages, Instagram login open: "Connect Instagram directly instead" starts Instagram login', async ({
    page,
  }) => {
    const { email } = await paidWorkspace(page, true);
    // Instagram itself is never reached: the browser stops at its login URL.
    let reached = '';
    await page.route('https://www.instagram.com/**', (route) => {
      reached = route.request().url();
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>instagram</p>' });
    });
    await openEmptyInstagramPicker(page, email);
    await expect(page.getByText('Connect Instagram directly instead')).toBeVisible();
    await page.getByRole('button', { name: 'Connect Instagram directly' }).click();
    await expect.poll(() => reached).toContain('https://www.instagram.com/oauth/authorize');
    expect(reached).toContain(encodeURIComponent('/integrations/social/instagram-standalone'));
  });
});
