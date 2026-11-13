/**
 * Connect first (25 Oct 2026): a workspace that has to start its trial (a
 * grandfathered one the Free plan sunset reached, needs_trial, which is what
 * the E2E backend makes of a fresh workspace; a sign-up after the cutoff is
 * free_posts and sees no paywall, see free-posts.spec.ts)
 * lands on "Connect your first channel" instead of the paywall, connects one
 * channel (LinkedIn's consent page and token exchange are the only fakes),
 * and then gets the trial paywall saying what the trial is for. Nothing in
 * the app opens before the trial: the calendar, the composer and /billing
 * all show the gate, and the backend refuses the post itself.
 */
import { BrowserContext, expect, Page, test } from '@playwright/test';
import {
  addChannelButton,
  api,
  control,
  failOnServerErrors,
  gotoForm,
  PASSWORD,
  signUpViaApi,
  stubRazorpayCheckout,
  uniqueEmail,
  visitFrom,
} from './support';

const CONNECT_HEADING = 'Connect your first channel';
const START_TRIAL = /Start \d+-Day Free Trial/;

/** LinkedIn's consent page, replaced: records the URL the app sent the browser to. */
async function linkedInConsent(page: Page) {
  const seen: string[] = [];
  await page.route('https://www.linkedin.com/**', (route) => {
    seen.push(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: '<h1>LinkedIn consent (E2E stand-in)</h1>' });
  });
  return seen;
}

/** Clicks the LinkedIn tile and comes back from LinkedIn with a code. */
async function connectLinkedIn(page: Page, id = `${Date.now()}`) {
  const consent = await linkedInConsent(page);
  await page.getByText('LinkedIn (personal profile)').first().click();
  await expect.poll(() => consent.length).toBeGreaterThan(0);
  // The route sees the request before the navigation to it commits. Going to
  // the callback before then is "interrupted by another navigation" to
  // LinkedIn, which a slower machine (Cloud Build's 2 vCPUs) hits every time.
  await page.waitForURL(/^https:\/\/www\.linkedin\.com\//);
  const state = new URL(consent[0]).searchParams.get('state')!;
  await page.goto(`/integrations/social/linkedin?code=e2e-${id}&state=${state}`);
  return { id, state };
}

async function newIndianWorkspace(context: BrowserContext, page: Page) {
  const account = await signUpViaApi(context, { country: 'IN' });
  await visitFrom(page, 'IN');
  return account;
}

test.describe('connect first', () => {
  test('sign-up lands on the connect step, not the paywall', async ({ page }) => {
    const errors = failOnServerErrors(page);
    await visitFrom(page, 'IN');
    await gotoForm(page, '/auth');
    await page.getByPlaceholder('Email Address').fill(uniqueEmail('connect-first'));
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.waitForURL(/\/launches/);
    await expect(page.getByRole('heading', { name: CONNECT_HEADING })).toBeVisible();
    await expect(page.getByText('LinkedIn (personal profile)').first()).toBeVisible();
    // Neither the paywall nor the app yet.
    await expect(page.getByRole('button', { name: START_TRIAL })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create Post' })).toHaveCount(0);
    errors.assertNone();
  });

  test('connect a channel, then the paywall says it is connected; posting still needs the trial', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    const { auth, email } = await newIndianWorkspace(context, page);
    await page.goto('/launches');
    await expect(page.getByRole('heading', { name: CONNECT_HEADING })).toBeVisible();

    const { id } = await connectLinkedIn(page);
    await page.waitForURL(/\/launches/);
    const banner = page.getByTestId('paywall-channel-connected');
    await expect(banner).toHaveText(/Your LinkedIn is connected\. Start your \d+-day trial to schedule your first post\./);
    await expect(page.getByRole('button', { name: START_TRIAL })).toBeVisible();
    await expect(page.getByRole('heading', { name: CONNECT_HEADING })).toHaveCount(0);
    // The connect notice is not left in the URL to fire again on a reload.
    await expect.poll(() => new URL(page.url()).searchParams.get('added')).toBeNull();

    const channels = (await api(auth, 'GET', '/integrations/list')).body.integrations;
    expect(channels.map((c: any) => c.name)).toEqual([`E2E LinkedIn ${id}`]);

    // Trying to post: the composer's own deep link shows the paywall, and
    // the API refuses the post with the paywall's code.
    await page.goto(`/launches?compose=${channels[0].id}`);
    await expect(page.getByRole('button', { name: START_TRIAL })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add to Calendar' })).toHaveCount(0);
    const post = await api(auth, 'POST', '/posts', {
      type: 'schedule',
      shortLink: false,
      date: new Date(Date.now() + 86400_000).toISOString(),
      tags: [],
      posts: [{ integration: { id: channels[0].id }, group: 'g', value: [{ content: 'hi', image: [] }], settings: {} }],
    });
    expect(post.status).toBe(402);
    expect(post.body.code).toBe('TRIAL_REQUIRED');
    expect(await control.posts(email)).toEqual([]);

    // A second channel is refused before the trial.
    const second = await api(auth, 'GET', '/integrations/social/linkedin');
    expect(second.status).toBe(402);
    expect(second.body.message).toMatch(/You can connect 1 channel before your trial starts/);
    errors.assertNone();
  });

  test('then starting the trial opens the app, with the channel already there', async ({ page, context }) => {
    const { auth } = await newIndianWorkspace(context, page);
    await page.goto('/launches');
    const { id } = await connectLinkedIn(page);
    await page.waitForURL(/\/launches/);
    await stubRazorpayCheckout(page, { trialDays: 3 });
    await page.getByRole('button', { name: START_TRIAL }).click();
    await page.waitForURL(/trialStart=true/);
    expect((await api(auth, 'GET', '/user/self')).body.planState).toBe('trialing');
    await expect(page.getByText(`E2E LinkedIn ${id}`).first()).toBeVisible();
  });

  test('Skip for now: the paywall, with a way back to connecting', async ({ page, context }) => {
    await newIndianWorkspace(context, page);
    await page.goto('/launches');
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByRole('button', { name: START_TRIAL })).toBeVisible();
    // Remembered for this workspace on a reload.
    await page.reload();
    await expect(page.getByRole('button', { name: START_TRIAL })).toBeVisible();
    await page.getByRole('button', { name: 'Connect a channel' }).click();
    await expect(page.getByRole('heading', { name: CONNECT_HEADING })).toBeVisible();
  });

  test('straight to /billing, the calendar, settings or the composer: the gate, never the app', async ({ page, context }) => {
    await newIndianWorkspace(context, page);
    // /billing (where every "Start your trial" link goes): the paywall itself.
    await page.goto('/billing');
    await expect(page.getByRole('button', { name: START_TRIAL })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect a channel' })).toBeVisible();
    for (const path of ['/launches', '/launches?compose=first', '/launches?add_channel=1', '/settings', '/analytics', '/agents']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: CONNECT_HEADING }), path).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create Post' }), path).toHaveCount(0);
    }
  });

  test('Cancel on LinkedIn: "Nothing was connected", and Try again comes back to the connect step', async ({ page, context }) => {
    const { auth } = await newIndianWorkspace(context, page);
    await page.goto('/launches');
    const consent = await linkedInConsent(page);
    await page.getByText('LinkedIn (personal profile)').first().click();
    await expect.poll(() => consent.length).toBeGreaterThan(0);
    const state = new URL(consent[0]).searchParams.get('state')!;
    await page.goto(`/integrations/social/linkedin?error=user_cancelled_login&state=${state}`);
    await expect(page.getByText('Nothing was connected').first()).toBeVisible();
    await page.getByRole('button', { name: /Try again/i }).click();
    await expect(page.getByRole('heading', { name: CONNECT_HEADING })).toBeVisible();
    expect((await api(auth, 'GET', '/integrations/list')).body.integrations).toEqual([]);
  });

  test('a made-up or spent callback adds nothing and leaves the connect step reachable', async ({ page, context }) => {
    const { auth } = await newIndianWorkspace(context, page);
    await page.goto('/integrations/social/linkedin?code=e2e-forged&state=not-a-real-state');
    await page.waitForLoadState('networkidle');
    expect((await api(auth, 'GET', '/integrations/list')).body.integrations).toEqual([]);
    await page.goto('/launches');
    await expect(page.getByRole('heading', { name: CONNECT_HEADING })).toBeVisible();
  });

  test('double-clicking a tile asks for one connect link', async ({ page, context }) => {
    await newIndianWorkspace(context, page);
    await linkedInConsent(page);
    await page.goto('/launches');
    const links: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/integrations/social/linkedin')) links.push(r.url());
    });
    await page.getByText('LinkedIn (personal profile)').first().dblclick();
    await page.waitForURL(/linkedin\.com/);
    expect(links).toHaveLength(1);
  });

  test('removing the one channel brings the connect step back, not the app', async ({ page, context }) => {
    const { auth, email } = await newIndianWorkspace(context, page);
    const channel = await control.addChannel(email, 'bluesky', 'E2E Bluesky');
    await page.goto('/launches');
    await expect(page.getByTestId('paywall-channel-connected')).toHaveText(/Your Bluesky is connected/);
    expect((await api(auth, 'DELETE', '/integrations', { id: channel.id })).status).toBe(200);
    await page.reload();
    await expect(page.getByRole('heading', { name: CONNECT_HEADING })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Post' })).toHaveCount(0);
  });

  test('on a phone: the connect step fits the screen', async ({ page, context }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await newIndianWorkspace(context, page);
    await page.goto('/launches');
    await expect(page.getByRole('heading', { name: CONNECT_HEADING })).toBeVisible();
    await expect(page.getByText('LinkedIn (personal profile)').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('who never sees the connect step', () => {
  test('a workspace on a plan with no channel: the app, with Add Channel', async ({ page, context }) => {
    const { email } = await newIndianWorkspace(context, page);
    await control.givePlan(email, 'STANDARD');
    await page.goto('/launches');
    await expect(addChannelButton(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: CONNECT_HEADING })).toHaveCount(0);
  });

  test('a workspace whose trial was used (locked): the paywall straight away', async ({ page, context }) => {
    const { email } = await newIndianWorkspace(context, page);
    await control.trialUsed(email);
    await page.goto('/launches');
    await expect(page.getByRole('button', { name: /^Subscribe for/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: CONNECT_HEADING })).toHaveCount(0);
  });

  test('the Play app: the plain plan notice, no connect step and no checkout', async ({ page, context }) => {
    await newIndianWorkspace(context, page);
    await context.addCookies([{ name: 'hookpost_twa', value: '1', domain: 'localhost', path: '/' }]);
    await page.goto('/launches');
    await expect(page.getByText('Manage your plan on hookpost.hookstep.in').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: CONNECT_HEADING })).toHaveCount(0);
    await expect(page.getByRole('button', { name: START_TRIAL })).toHaveCount(0);
  });
});
