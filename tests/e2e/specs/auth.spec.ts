/**
 * Sign-up, sign-in, sign-out and password reset through the real forms, with
 * the session in the backend's httpOnly cookie as in production.
 */
import { expect, test } from '@playwright/test';
import { PASSWORD, addChannelButton, control, failOnServerErrors, gotoForm, signUpViaApi, uniqueEmail, visitFrom } from './support';

test.describe('email and password', () => {
  test('sign up with the form: lands on the connect step, then the trial paywall (Indian visitor)', async ({ page }) => {
    const errors = failOnServerErrors(page);
    await visitFrom(page, 'IN');
    await gotoForm(page, '/auth');
    await page.getByPlaceholder('Email Address').fill(uniqueEmail('signup'));
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.waitForURL(/\/launches/);
    // New workspaces in India start with a trial: first the connect step
    // (connect-first.spec.ts), then the paywall, and no Free plan.
    await expect(page.getByRole('heading', { name: 'Connect your first channel' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByRole('button', { name: /Start \d+-Day Free Trial/ })).toBeVisible();
    await expect(page.getByText(/continue with free/i)).toHaveCount(0);
    errors.assertNone();
  });

  test('the session cookie is httpOnly, Secure and SameSite=Lax, and no page script can read the token', async ({ page, context }) => {
    await visitFrom(page, 'IN');
    await gotoForm(page, '/auth');
    await page.getByPlaceholder('Email Address').fill(uniqueEmail('cookie-flags'));
    await page.getByPlaceholder('Password').fill(PASSWORD);
    const registered = page.waitForResponse((r) => r.url().endsWith('/auth/register'));
    await page.getByRole('button', { name: 'Create Account' }).click();
    const res = await registered;
    expect(res.status()).toBe(200);
    // No token in a header for page scripts to copy into a readable cookie.
    expect(res.headers()['auth']).toBeUndefined();
    await page.waitForURL(/\/launches/);

    const auth = (await context.cookies()).find((c) => c.name === 'auth');
    expect(auth?.value).toMatch(/^eyJ/);
    expect(auth).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
    expect(await page.evaluate(() => document.cookie)).not.toMatch(/(^|;\s*)auth=/);
  });

  test('the same email cannot sign up twice', async ({ page, context }) => {
    const { email } = await signUpViaApi(context);
    await context.clearCookies();
    await gotoForm(page, '/auth');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create Account' }).click();
    await expect(page.getByText(/already/i).first()).toBeVisible();
    await expect(page).toHaveURL(/\/auth/);
  });

  test('log out, then log back in with the form', async ({ page, context }) => {
    const { email } = await signUpViaApi(context);
    await control.givePlan(email);
    await page.goto('/launches');
    await expect(addChannelButton(page)).toBeVisible();

    await page.goto('/auth/logout');
    await expect(page).toHaveURL(/\/auth\/login/);
    expect((await context.cookies()).find((c) => c.name === 'auth')?.value || '').toBe('');
    await page.goto('/launches');
    await expect(page).toHaveURL(/\/auth/);

    await gotoForm(page, '/auth/login');
    await page.getByPlaceholder('Email Address').fill(email.toUpperCase());
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/launches/);
    await expect(addChannelButton(page)).toBeVisible();
  });

  test('a wrong password is refused and stays on the login form', async ({ page, context }) => {
    const { email } = await signUpViaApi(context);
    await context.clearCookies();
    await gotoForm(page, '/auth/login');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByPlaceholder('Password').fill('Wrong-Password-1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(/invalid|wrong|incorrect/i).first()).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/login/);
    expect((await context.cookies()).some((c) => c.name === 'auth' && c.value)).toBe(false);
  });

  test('returnUrl: a signed-out /billing link signs in and comes back to /billing', async ({ page, context }) => {
    const { email } = await signUpViaApi(context);
    await control.givePlan(email);
    await context.clearCookies();
    await page.goto('/billing');
    await expect(page).toHaveURL(/\/auth\/login\?returnUrl=%2Fbilling/);
    await page.waitForLoadState('networkidle');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/billing/);
    await expect(page.getByRole('button', { name: 'Cancel subscription' })).toBeVisible();
  });

  test('returnUrl never leaves the site (open redirect)', async ({ page, context }) => {
    const { email } = await signUpViaApi(context);
    await context.clearCookies();
    await gotoForm(page, '/auth/login?returnUrl=https%3A%2F%2Fevil.example%2Fphish');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/launches'));
    expect(page.url()).toMatch(/^http:\/\/localhost:\d+\/launches/);
  });
});

test.describe('forgot password', () => {
  test('emails a reset link that sets a new password', async ({ page, context }) => {
    const { email } = await signUpViaApi(context);
    await context.clearCookies();
    await page.goto('/auth/login');
    await expect(page.getByRole('link', { name: 'Forgot password' })).toHaveAttribute('href', '/auth/forgot');
    await page.goto('/auth/forgot');
    // Typing before the form has hydrated is lost; fill until it sticks.
    await page.waitForLoadState('networkidle');
    const input = page.getByPlaceholder('Email Address');
    await expect(async () => {
      await input.fill(email);
      await expect(input).toHaveValue(email, { timeout: 500 });
    }).toPass();
    await page.getByRole('button', { name: 'Send Password Reset Email' }).click();

    await expect
      .poll(async () => (await control.emails()).filter((m) => m.to === email && /reset/i.test(m.subject)).length)
      .toBe(1);
    const mail = (await control.emails()).find((m) => m.to === email && /reset/i.test(m.subject))!;
    const link = mail.html.match(/href="(http:\/\/localhost:\d+\/auth\/forgot\/[^"]+)"/)![1];

    await gotoForm(page, link);
    const NEW = 'Brand-New-Pass-7';
    await page.getByPlaceholder('Password', { exact: true }).fill(NEW);
    await page.getByPlaceholder('Repeat Password').fill(NEW);
    await page.getByRole('button', { name: 'Change Password' }).click();
    await expect(page.getByText('We successfully reset your password')).toBeVisible();

    await gotoForm(page, '/auth/login');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByPlaceholder('Password').fill(NEW);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/launches/);
  });
});
