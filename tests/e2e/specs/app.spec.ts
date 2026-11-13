/**
 * The signed-in app: connecting a channel through the OAuth round trip,
 * writing and scheduling a post in the composer, saving a draft, the calendar,
 * the team invite link and the API key. The social network itself is the only
 * thing faked (its consent page in the browser, its token exchange in the
 * backend); every request between the page and the API is real.
 */
import { expect, Page, test } from '@playwright/test';
import { addChannelButton, api, control, failOnServerErrors, signUpViaApi, uniqueEmail } from './support';

async function paidWorkspace(page: Page, tier: 'STANDARD' | 'PRO' = 'STANDARD') {
  const account = await signUpViaApi(page.context());
  await control.givePlan(account.email, tier);
  return account;
}

test.describe('channels', () => {
  test('connect LinkedIn: consent URL, callback, and the channel appears', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const { auth } = await paidWorkspace(page);
    let consent = '';
    await page.route('https://www.linkedin.com/**', (route) => {
      consent = route.request().url();
      return route.fulfill({ contentType: 'text/html', body: '<h1>LinkedIn consent (E2E stand-in)</h1>' });
    });
    await page.goto('/launches');
    await addChannelButton(page).click();
    await page.getByText('LinkedIn (personal profile)').first().click();
    await expect.poll(() => consent).toContain('linkedin.com/oauth/v2/authorization');
    // The route sees the request before the navigation commits; going to the
    // callback earlier is "interrupted by another navigation" (connect-first.spec.ts).
    await page.waitForURL(/^https:\/\/www\.linkedin\.com\//);

    const q = new URL(consent).searchParams;
    expect(q.get('client_id')).toBe('linkedin-client-e2e');
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/integrations\/social\/linkedin$/);
    const state = q.get('state')!;
    expect(state).toBeTruthy();

    // LinkedIn sends the browser back with a code; the backend exchanges it.
    const id = `${Date.now()}`;
    await page.goto(`/integrations/social/linkedin?code=e2e-${id}&state=${state}`);
    await page.waitForURL(/added=linkedin/);
    await expect(page.getByText(`E2E LinkedIn ${id}`)).toBeVisible();

    const channels = await api(auth, 'GET', '/integrations/list');
    const row = channels.body.integrations.find((c: any) => c.name === `E2E LinkedIn ${id}`);
    expect(row.identifier).toBe('linkedin');
    // Tokens never reach the browser.
    expect(JSON.stringify(channels.body)).not.toContain(`li-access-${id}`);
    errors.assertNone();
  });

  test('a callback with a made-up state creates no channel', async ({ page }) => {
    const { auth } = await paidWorkspace(page);
    const before = (await api(auth, 'GET', '/integrations/list')).body.integrations.length;
    await page.goto('/integrations/social/linkedin?code=e2e-forged&state=not-a-real-state');
    await page.waitForLoadState('networkidle');
    expect((await api(auth, 'GET', '/integrations/list')).body.integrations.length).toBe(before);
    await expect(page.getByText('E2E LinkedIn forged')).toHaveCount(0);
  });
});

test.describe('composer and calendar', () => {
  async function openComposer(page: Page, channelName: string) {
    await page.goto('/launches');
    await expect(page.getByText(channelName).first()).toBeVisible();
    await page.getByRole('button', { name: 'Create Post' }).click();
    // The channel avatars at the top of the composer (a modal over the
    // calendar, which shows the same avatars): pick the first.
    await page.locator('.bg-popup img[alt="bluesky"]').first().click();
    await page.getByRole('textbox').first().click();
  }

  test('Add to calendar: the post is saved, shown in the week, and its publish workflow starts', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const { email } = await paidWorkspace(page);
    await control.addChannel(email, 'bluesky', 'E2E Bluesky');
    await openComposer(page, 'E2E Bluesky');
    const text = `Scheduled from the E2E suite ${Date.now()}`;
    await page.keyboard.type(text);
    await page.getByRole('button', { name: 'Add to Calendar' }).click();
    await expect(page.getByText('Added successfully')).toBeVisible();
    await expect(page.getByText(text)).toBeVisible();

    const post = (await control.posts(email)).find((p) => p.content.includes(text))!;
    expect(post).toBeDefined();
    expect(post.state).toBe('QUEUE');
    const workflows = await control.workflows();
    expect(workflows.some((w) => w.id === `post_${post.id}` && /^postWorkflowV\d+$/.test(w.workflow))).toBe(true);
    errors.assertNone();
  });

  // 25 Oct 2026: on a Sunday after the day's last posting time (11:40 UTC,
  // 17:10 in India) the next free slot is Monday morning, in next week, and
  // the calendar stayed on the week on screen, so the post just "Added
  // successfully" was nowhere to be seen. The browser's clock is pinned to
  // 22:30 IST on the Sunday before the week of the slot the backend offers, so
  // the slot is in the next week whatever day the suite runs.
  test('Add to calendar on a Sunday evening: the calendar moves to next week, where the post is', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const { email, auth } = await paidWorkspace(page);
    await control.addChannel(email, 'bluesky', 'E2E Sunday Bluesky');
    const slot = new Date(`${(await api(auth, 'GET', '/posts/find-slot')).body.date}Z`);
    // India has no DST: IST is always UTC+05:30.
    const IST = 330 * 60_000;
    const slotIst = new Date(slot.getTime() + IST);
    const mondayIst = new Date(
      Date.UTC(slotIst.getUTCFullYear(), slotIst.getUTCMonth(), slotIst.getUTCDate() - ((slotIst.getUTCDay() + 6) % 7))
    );
    const sundayEvening = new Date(mondayIst.getTime() - IST - 90 * 60_000);
    const nextMonday = mondayIst.toISOString().slice(0, 10);
    await page.clock.install({ time: sundayEvening });

    await openComposer(page, 'E2E Sunday Bluesky');
    expect(await page.evaluate(() => new Date().toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' }))).toMatch(
      /^Sunday.* 22:3\d$/
    );
    const text = `Sunday evening from the E2E suite ${Date.now()}`;
    await page.keyboard.type(text);
    await page.getByRole('button', { name: 'Add to Calendar' }).click();
    await expect(page.getByText('Added successfully')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`startDate=${nextMonday}&`));
    await expect(page.getByText(text)).toBeVisible();

    const post = (await control.posts(email)).find((p) => p.content.includes(text))!;
    expect(post.state).toBe('QUEUE');
    expect((await control.workflows()).some((w) => w.id === `post_${post.id}`)).toBe(true);
    errors.assertNone();
  });

  test('Save as draft: saved as a draft and never sent to the publisher', async ({ page }) => {
    const { email } = await paidWorkspace(page);
    await control.addChannel(email, 'bluesky', 'E2E Draft Bluesky');
    await openComposer(page, 'E2E Draft Bluesky');
    const text = `Draft from the E2E suite ${Date.now()}`;
    await page.keyboard.type(text);
    await page.getByRole('button', { name: /Save as draft/i }).click();
    await expect
      .poll(async () => (await control.posts(email)).find((p) => p.content.includes(text))?.state)
      .toBe('DRAFT');
    const draft = (await control.posts(email)).find((p) => p.content.includes(text))!;
    expect((await control.workflows()).some((w) => w.id === `post_${draft.id}`)).toBe(false);
  });

  test('the composer cannot post until a channel is picked', async ({ page }) => {
    const { email } = await paidWorkspace(page);
    await control.addChannel(email, 'bluesky', 'E2E Picker Bluesky');
    await page.goto('/launches');
    await page.getByRole('button', { name: 'Create Post' }).click();
    await expect(page.getByRole('button', { name: 'Check the circles above' })).toBeDisabled();
  });
});

test.describe('settings', () => {
  test('team (Pro): an invite link adds the person who opens it and presses Join', async ({ page, browser }) => {
    const owner = await paidWorkspace(page, 'PRO');
    const ownerSelf = (await api(owner.auth, 'GET', '/user/self')).body;
    await page.goto('/settings');
    await page.getByText('Teams', { exact: true }).click();
    await page.getByRole('button', { name: 'Add another member' }).click();
    await page.locator('select[name="role"]').selectOption('USER');
    // Untick "Send invitation via email?" to get a link instead.
    await page.getByRole('checkbox').first().click();
    const invite = page.waitForResponse((r) => r.url().endsWith('/settings/team') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Copy Link|Send Invitation Link/ }).click();
    const { url } = await (await invite).json();
    // /invite/<token>: "/" is edge-cached with the query string ignored, so
    // the old /?org= link never reached a signed-out invitee (25 Oct 2026).
    expect(new URL(url).pathname).toMatch(/^\/invite\/[\w-]+\.[\w-]+\.[\w-]+$/);

    // Someone else opens the link while signed in: asked first, joined on Join.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    const member = await signUpViaApi(other, { email: uniqueEmail('member') });
    await otherPage.goto(new URL(url).pathname);
    await otherPage.waitForURL(/\/invite$/);
    await otherPage.getByRole('button', { name: 'Join team' }).click();
    await otherPage.waitForURL(/\/launches$/);
    const orgs = await api(member.auth, 'GET', '/user/organizations');
    expect(orgs.body.map((o: any) => o.id)).toContain(ownerSelf.orgId);
    await other.close();
  });

  test('developers: the API key works on the public API; Rotate Key replaces it', async ({ page }) => {
    const { auth } = await paidWorkspace(page);
    const before = (await api(auth, 'GET', '/user/self')).body.publicApi as string;
    const publicCall = (key: string) =>
      fetch(`http://localhost:${process.env.E2E_BACKEND_PORT || 53000}/public/v1/is-connected`, {
        headers: { authorization: key },
      }).then((r) => r.status);
    expect(await publicCall(before)).toBe(200);

    await page.goto('/settings');
    await page.getByText('Developers', { exact: true }).click();
    await page.getByRole('button', { name: 'Reveal' }).first().click();
    await expect(page.getByText(before)).toBeVisible();
    await page.getByRole('button', { name: 'Rotate Key' }).click();
    await page.getByRole('button', { name: 'Rotate', exact: true }).click();
    await expect(page.getByText('API Key rotated successfully')).toBeVisible();

    const after = (await api(auth, 'GET', '/user/self')).body.publicApi as string;
    expect(after).not.toBe(before);
    expect(await publicCall(before)).toBe(401);
    expect(await publicCall(after)).toBe(200);
  });
});

test.describe('every signed-in page renders', () => {
  // Pages without a deeper spec of their own (agents, analytics, media
  // library, plugs, third-party integrations, affiliate, lifetime deal) get
  // at least this: they load for a paying workspace with no server error and
  // no crash screen.
  const PAGES = ['/launches', '/agents', '/analytics', '/media', '/plugs', '/third-party', '/billing', '/billing/lifetime', '/affiliate', '/settings'];
  for (const path of PAGES) {
    test(`${path}`, async ({ page }) => {
      const errors = failOnServerErrors(page);
      const crashes: string[] = [];
      page.on('pageerror', (e) => crashes.push(e.message));
      const { email } = await paidWorkspace(page);
      await control.addChannel(email, 'bluesky', 'E2E Pages Bluesky');
      const res = await page.goto(path);
      expect(res?.status(), path).toBeLessThan(400);
      await expect(page.getByRole('link', { name: 'Calendar' }).first()).toBeVisible();
      await expect(page.getByText(/application error|something went wrong/i)).toHaveCount(0);
      await page.waitForLoadState('networkidle');
      errors.assertNone();
      expect(crashes, 'uncaught errors in the page').toEqual([]);
    });
  }

  test('admin pages render for a super admin', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const { email } = await paidWorkspace(page);
    await control.makeSuperAdmin(email);
    for (const path of ['/admin/users', '/admin/stats', '/admin/errors', '/admin/contact', '/admin/refunds', '/admin/affiliates']) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBeLessThan(400);
      await expect(page.getByText(/application error/i)).toHaveCount(0);
    }
    errors.assertNone();
  });
});
