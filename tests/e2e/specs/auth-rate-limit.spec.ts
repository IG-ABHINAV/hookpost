/**
 * The sign-in limit as a person meets it (auth.rate.limit.ts): ten wrong
 * passwords, then the 11th attempt shows the backend's sentence on the form,
 * not a spinner and not "invalid password". Also forgot-password: the sixth
 * request in an hour says to wait instead of "we have sent you an email".
 *
 * The browser talks to the backend from loopback, which is counted per email
 * address only, so these specs never lock out the rest of the suite.
 */
import { expect, test } from '@playwright/test';
import { BACKEND, PASSWORD, failOnServerErrors, gotoForm, signUpViaApi } from './support';

const WRONG = `${PASSWORD}-wrong`;

test.describe('too many attempts', () => {
  test('the 11th sign-in attempt for an address shows a friendly wait message, even with the right password', async ({ page, context, request }) => {
    const errors = failOnServerErrors(page);
    const { email } = await signUpViaApi(context);
    await context.clearCookies();

    // Nine wrong passwords straight to the API, the tenth through the form.
    for (let i = 0; i < 9; i++) {
      const res = await request.post(`${BACKEND}/auth/login`, {
        data: { email, password: WRONG, provider: 'LOCAL' },
      });
      expect(res.status()).toBe(400);
    }

    await gotoForm(page, '/auth/login');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByPlaceholder('Password').fill(WRONG);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(/invalid user name or password/i)).toBeVisible();

    // The 11th: the right password, still refused, with the reason.
    await page.getByPlaceholder('Password').fill(PASSWORD);
    const answered = page.waitForResponse((r) => r.url().endsWith('/auth/login'));
    await page.getByRole('button', { name: 'Sign in' }).click();
    expect((await answered).status()).toBe(429);
    await expect(page.getByText(/Too many sign-in attempts.*wait 15 minutes.*reset your password/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    await expect(page).toHaveURL(/\/auth\/login/);
    expect((await context.cookies()).some((c) => c.name === 'auth' && c.value)).toBe(false);
    errors.assertNone();
  });

  test('forgot password: the sixth request in an hour says to wait, not "sent"', async ({ page, context, request }) => {
    const { email } = await signUpViaApi(context);
    await context.clearCookies();
    for (let i = 0; i < 5; i++) {
      expect((await request.post(`${BACKEND}/auth/forgot`, { data: { email } })).status()).toBe(201);
    }
    await gotoForm(page, '/auth/forgot');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByRole('button', { name: 'Send Password Reset Email' }).click();
    await expect(page.getByText('Too many attempts. Please wait 1 hour and try again.')).toBeVisible();
    await expect(page.getByText(/We have send you an email/)).toHaveCount(0);
  });
});
