/**
 * Email sign-up with confirmation required, as production runs it (25 Oct
 * 2026). Of the 7 password sign-ups of 1-25 Oct, 4 never confirmed, 3 of them
 * from Meta ads inside Instagram's or Facebook's browser on Android: the
 * sign-up got no session, only "check your email", and nobody ever opened
 * the link (nginx saw no request for /auth/activate/<token>).
 *
 * Since 25 Oct the sign-up is signed in at once; since the hard gate (owner,
 * 29 Oct 2026) all it sees until it confirms is "Check your inbox" (resend,
 * change the address, sign out). The link is opened where Gmail opens it
 * (Chrome, another "device" here), signs in there, and the first browser
 * opens the app when it comes back to the front. The backend turns confirmation on for this file only
 * (POST /email-verification on the control port).
 */
import { BrowserContext, expect, Page, test } from '@playwright/test';
import { PASSWORD, api, control, failOnServerErrors, gotoForm, signUpViaApi, uniqueEmail, visitFrom } from './support';

const INSTAGRAM_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 Instagram 352.0.0.38.100 Android';
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, userAgent: INSTAGRAM_ANDROID };

/** The path of the newest "Confirm your email" link sent to `email`. */
async function activationPath(email: string) {
  await expect
    .poll(async () => (await control.emails()).filter((m) => m.to === email).length)
    .toBeGreaterThan(0);
  const mail = (await control.emails()).filter((m) => m.to === email && /Confirm your email/.test(m.subject)).at(-1)!;
  const url = new URL(/href="([^"]*\/auth\/activate\/[^"]+)"/.exec(mail.html)![1]);
  return url.pathname;
}

/** A second browser: what opens when the link is tapped in Gmail. */
async function otherBrowser(page: Page): Promise<BrowserContext> {
  return page.context().browser()!.newContext();
}

/**
 * Opens the emailed link and taps "Confirm my email", as a person does.
 * Nothing happens on load (email scanners open links too), and the token
 * leaves the address bar before the tap.
 */
async function openLink(tab: Page, path: string) {
  await tab.goto(path);
  await expect(tab.getByTestId('activation-confirm')).toBeVisible();
  expect(new URL(tab.url()).pathname).toBe('/auth/activate/confirm');
  expect(tab.url()).not.toContain(path.split('/').pop()!);
  await tab.getByRole('button', { name: 'Confirm my email' }).click();
}

test.beforeAll(async () => {
  expect(await control.post('/email-verification', { required: true })).toEqual({ required: true });
});
test.afterAll(async () => {
  await control.post('/email-verification', { required: false });
});

test.describe("Instagram's browser on Android", () => {
  test.use(PHONE);

  test('sign up -> "Check your inbox" and nothing else; the link opened in another browser confirms and signs in there', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const email = uniqueEmail('iab');
    await gotoForm(page, '/auth');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create Account' }).click();

    // Signed in, but the whole app is the gate, even with a plan in place.
    await page.waitForURL(/\/launches/);
    await control.givePlan(email, 'STANDARD');
    await page.reload();
    const gate = page.getByTestId('email-verification-gate');
    await expect(gate).toBeVisible();
    await expect(gate.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    await expect(page.getByTestId('verification-address')).toHaveText(email);
    await expect(page.getByRole('button', { name: 'Create Post' })).toHaveCount(0);

    // Gmail opens the link in Chrome: a browser with no Hookpost cookies.
    const chrome = await otherBrowser(page);
    const tab = await chrome.newPage();
    await openLink(tab, await activationPath(email));
    await tab.waitForURL(/\/launches\?onboarding=true/);
    await expect(tab.getByTestId('email-verification-gate')).toHaveCount(0);
    await chrome.close();

    // Back in Instagram: the app opens once the tab is in front again.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(gate).toHaveCount(0);
    errors.assertNone();
  });

  test("the link opened inside Instagram's browser on another phone signs in there too", async ({ page, browser }) => {
    const { email } = await signUpViaApi(page.context());
    await control.givePlan(email, 'STANDARD');
    const phone = await browser.newContext(PHONE);
    const tab = await phone.newPage();
    await openLink(tab, await activationPath(email));
    await tab.waitForURL(/\/launches\?onboarding=true/);
    // Signed in and in onboarding, which starts by connecting a channel.
    await expect(tab.getByText('Connect Your Channels')).toBeVisible();
    await expect(tab.getByTestId('email-verification-gate')).toHaveCount(0);
    await phone.close();
  });

  test('opening the link without the tap confirms nothing (email scanners open links too)', async ({ page }) => {
    const { email, auth } = await signUpViaApi(page.context());
    const scanner = await (await otherBrowser(page)).newPage();
    await scanner.goto(await activationPath(email));
    await expect(scanner.getByTestId('activation-confirm')).toBeVisible();
    await scanner.waitForTimeout(1500);
    expect((await api(auth, 'GET', '/verify-email')).body.verified).toBe(false);
    // A reload of the clean address still has the token, in this tab only.
    await scanner.reload();
    await scanner.getByRole('button', { name: 'Confirm my email' }).click();
    await scanner.waitForURL(/\/launches/);
    expect((await api(auth, 'GET', '/verify-email')).body.verified).toBe(true);
    await scanner.context().close();
  });

  test('the same link a second time: says it can no longer be used, and what to do', async ({ page }) => {
    const { email } = await signUpViaApi(page.context());
    const path = await activationPath(email);
    const first = await (await otherBrowser(page)).newPage();
    await openLink(first, path);
    await first.waitForURL(/\/launches/);
    await first.context().close();

    const second = await (await otherBrowser(page)).newPage();
    await openLink(second, path);
    await expect(second.getByTestId('activation-link-refused')).toBeVisible();
    await expect(second.getByRole('link', { name: 'Sign In' })).toHaveAttribute('href', '/auth/login');
    await expect(second.getByRole('link', { name: 'Send me a new link' })).toHaveAttribute('href', '/auth/activate');
    await second.context().close();
  });
});

test.describe('signed in before confirming: the gate', () => {
  test('a deep link into the app (calendar, settings, billing) still shows only the gate, and the API refuses', async ({ page }) => {
    const { email, auth } = await signUpViaApi(page.context());
    await control.givePlan(email, 'STANDARD');
    await control.addChannel(email, 'bluesky', 'E2E Gated Bluesky');
    for (const path of ['/launches', '/settings', '/billing', '/analytics']) {
      await page.goto(path);
      await expect(page.getByTestId('email-verification-gate')).toBeVisible();
      await expect(page.getByText('E2E Gated Bluesky')).toHaveCount(0);
    }
    const res = await api(auth, 'GET', '/integrations/list');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
  });

  test('"Wrong address?" moves the account to the right one, which gets the link; the old link stops working', async ({ page }) => {
    const { email } = await signUpViaApi(page.context());
    const oldPath = await activationPath(email);
    await page.goto('/launches');
    const gate = page.getByTestId('email-verification-gate');
    await expect(page.getByTestId('verification-address')).toHaveText(email);

    const fixed = uniqueEmail('fixed');
    await gate.getByRole('button', { name: 'Wrong address?' }).click();
    await gate.getByLabel('Your email address').fill(fixed);
    await gate.getByRole('button', { name: 'Send the link here' }).click();
    await expect(gate.getByRole('status')).toHaveText(`Sent to ${fixed}. Check your inbox, and the spam folder too.`);
    await expect(page.getByTestId('verification-address')).toHaveText(fixed);

    const stale = await (await otherBrowser(page)).newPage();
    await openLink(stale, oldPath);
    await expect(stale.getByTestId('activation-link-refused')).toBeVisible();
    await stale.context().close();

    const fresh = await (await otherBrowser(page)).newPage();
    await openLink(fresh, await activationPath(fixed));
    await fresh.waitForURL(/\/launches/);
    await fresh.context().close();
  });

  test('"Resend link" right after sign-up says when it can go, and never claims a send it held back', async ({ page }) => {
    await signUpViaApi(page.context());
    await page.goto('/launches');
    const gate = page.getByTestId('email-verification-gate');
    await gate.getByRole('button', { name: 'Resend link' }).click();
    await expect(gate.getByRole('status')).toHaveText(/^We just sent one\. You can send another in \d+ seconds?\.$/);
  });

  test('the sign-in form signs an unconfirmed account in, to the gate; Sign out leaves it', async ({ page }) => {
    const { email } = await signUpViaApi(page.context());
    await page.context().clearCookies();
    await gotoForm(page, '/auth/login');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/launches/);
    const gate = page.getByTestId('email-verification-gate');
    await expect(gate).toBeVisible();
    await gate.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/auth\/login/);
  });
});

test('signed out, /auth/activate answers the same whatever address is typed', async ({ page }) => {
  const elsewhere = await page.context().browser()!.newContext();
  const known = (await signUpViaApi(elsewhere)).email;
  await elsewhere.close();
  const lines: string[] = [];
  for (const email of [uniqueEmail('nobody'), known]) {
    await page.context().clearCookies();
    await gotoForm(page, '/auth/activate');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByRole('button', { name: 'Resend Activation Email' }).click();
    const sent = page.getByTestId('resend-sent');
    await expect(sent).toBeVisible();
    lines.push((await sent.textContent())!.replace(email, '<address>'));
  }
  expect(lines[0]).toBe(lines[1]);
  expect(lines[0]).toContain('If <address> has an account waiting for confirmation');
});

// Final review of 733294f78: a password sign-up through a team invite is held
// out of the team until it confirms its email, and used to land on its own
// connect step with no sign that a team was waiting.
test('an invitee held until confirmed sees which team waits, on the Check your inbox page', async ({ page, browser }) => {
  // The team: a confirmed owner on Pro, and an invite link.
  const ownerContext = await browser.newContext();
  const owner = await signUpViaApi(ownerContext);
  const ownerCode = new URL(/href="([^"]*\/auth\/activate\/[^"]+)"/.exec(
    (await control.emails()).filter((m) => m.to === owner.email).at(-1)!.html
  )![1]).pathname.split('/').pop()!;
  expect((await api(owner.auth, 'POST', '/auth/activate', { code: ownerCode })).body).toEqual({ can: true });
  await control.givePlan(owner.email, 'PRO');
  const invite = await api<{ url: string }>(owner.auth, 'POST', '/settings/team', { role: 'USER', sendEmail: false });
  expect(invite.status).toBe(201);
  await ownerContext.close();

  // The invitee opens the emailed link (/invite/<token>) signed out: the
  // proxy keeps the invite in the org cookie and shows the sign-up form,
  // where they sign up with a password.
  await visitFrom(page, 'IN');
  const link = new URL(invite.body.url);
  await page.goto(link.pathname);
  await page.waitForURL(/\/auth\?invite=1$/);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('invite-notice')).toContainText('E2E Co');
  await page.getByPlaceholder('Email Address').fill(uniqueEmail('held-invitee'));
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.waitForURL(/\/launches/);

  // The gate, naming the team that waits.
  await expect(page.getByTestId('email-verification-gate')).toBeVisible();
  const notice = page.getByTestId('held-invite-notice');
  await expect(notice).toHaveText("You've been invited to E2E Co. Confirm your email to join.");
  await expect(notice.locator('a')).toHaveCount(0);
});
