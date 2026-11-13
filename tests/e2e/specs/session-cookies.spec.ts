/**
 * Impersonation in a browser with NOT_SECURED empty (the E2E backend runs
 * that way): started from /admin/users and stopped from the banner, always
 * through the backend's httpOnly cookie; and a script-readable copy, as the
 * admin users page used to write, removed on the next page load.
 *
 * On localhost Chrome keeps one cookie per name (Domain=localhost and a
 * host-only cookie are the same cookie), so the production case of a
 * host-only copy next to a cookie on .hookstep.in is covered in jsdom
 * (session-cookies.spec.ts under apps/frontend) and over HTTP
 * (secure-cookies.int.spec.ts).
 */
import { expect, Page, test } from '@playwright/test';
import { BACKEND, api, control, failOnServerErrors, signUpViaApi } from './support';

/** Who the API says this page is, with the page's own cookies. */
const whoAmI = (page: Page) =>
  page.evaluate(async (backend) => {
    const res = await fetch(`${backend}/user/self`, { credentials: 'include' });
    const body = await res.json();
    return { email: body.email as string, impersonate: !!body.impersonate };
  }, BACKEND);

const sessionCookies = async (page: Page, name: string) =>
  (await page.context().cookies()).filter((c) => c.name === name && c.value !== '');

test.describe('impersonation', () => {
  test('starts from /admin/users and stops from the banner', async ({ page, browser }) => {
    const errors = failOnServerErrors(page);
    const elsewhere = await browser.newContext();
    const customer = await signUpViaApi(elsewhere);
    await elsewhere.close();
    await control.givePlan(customer.email, 'STANDARD');

    const admin = await signUpViaApi(page.context());
    await control.givePlan(admin.email, 'STANDARD');
    await control.makeSuperAdmin(admin.email);

    await page.goto('/admin/users');
    await page.getByPlaceholder('Search by email, name, workspace or source...').fill(customer.email);
    await page
      .getByRole('row')
      .filter({ hasText: customer.email })
      .getByRole('button', { name: 'Impersonate' })
      .click();
    await expect(page.getByText('Currently Impersonating')).toBeVisible();
    expect(await whoAmI(page)).toEqual({ email: customer.email, impersonate: true });
    // The backend set it, httpOnly: nothing a script can read, copy or keep.
    expect(await page.evaluate(() => document.cookie)).not.toContain('impersonate=');
    const set = await sessionCookies(page, 'impersonate');
    expect(set.length).toBe(1);
    expect(set[0].httpOnly).toBe(true);

    await page.getByRole('button', { name: 'Stop impersonating' }).click();
    await expect(page.getByText('Currently Impersonating')).toHaveCount(0);
    expect(await whoAmI(page)).toEqual({ email: admin.email, impersonate: false });
    expect(await sessionCookies(page, 'impersonate')).toEqual([]);
    await page.reload();
    await expect(page.getByText('Currently Impersonating')).toHaveCount(0);
    expect(await whoAmI(page)).toEqual({ email: admin.email, impersonate: false });
    errors.assertNone();
  });

  test('a readable copy, as the admin users page wrote it, is removed on the next page load', async ({ page, browser }) => {
    const errors = failOnServerErrors(page);
    const elsewhere = await browser.newContext();
    const customer = await signUpViaApi(elsewhere);
    await elsewhere.close();
    const admin = await signUpViaApi(page.context());
    await control.givePlan(admin.email, 'STANDARD');
    await control.makeSuperAdmin(admin.email);
    const found = await api(admin.auth, 'GET', `/user/impersonate?name=${encodeURIComponent(customer.email)}`);
    const userOrgId = (found.body as any[]).find((u) => u.user?.email === customer.email)?.id;
    expect(userOrgId).toBeTruthy();

    // setCookie('impersonate', id, 365), which /admin/users used to call.
    await page.goto('/launches');
    await page.evaluate((id) => {
      document.cookie = `impersonate=${id}; path=/`;
    }, userOrgId);
    expect(await page.evaluate(() => document.cookie)).toContain('impersonate=');

    await page.reload();
    await expect(page.getByRole('link', { name: 'Calendar' }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.cookie)).not.toContain('impersonate=');
    await expect(page.getByText('Currently Impersonating')).toHaveCount(0);
    expect(await whoAmI(page)).toEqual({ email: admin.email, impersonate: false });
    errors.assertNone();
  });
});
