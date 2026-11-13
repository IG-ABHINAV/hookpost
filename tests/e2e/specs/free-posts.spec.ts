/**
 * Free posts (28 Oct 2026): a new workspace (created after the cutoff, no
 * plan) lands in the app instead of the trial paywall. It sees how many of its
 * 3 free posts are left over the app, with an Upgrade link to the plans, can
 * post, and is refused the 4th with the plan dialog's code. The paywall of a
 * grandfathered workspace the Free plan sunset reached is in trial-cta.spec.ts.
 *
 * The E2E backend's default cutoff makes a fresh workspace needs_trial (see
 * E2E_NEEDS_TRIAL_CUTOFF in server/backend.ts), so this file switches the
 * backend to the cutoff production runs and puts the default back.
 */
import { BrowserContext, expect, Page, test } from '@playwright/test';
import { api, control, failOnServerErrors, signUpViaApi, visitFrom } from './support';

const PRODUCTION_POLICY = {
  TRIAL_REQUIRED_SINCE_IN: '2026-10-19T00:00:00Z',
  FREE_PLAN_SUNSET_AT: '',
  FREE_PLAN_SUNSET_EXEMPT_ORGS: '',
};
const DEFAULT_POLICY = {
  TRIAL_REQUIRED_SINCE_IN: '2099-01-01T00:00:00Z',
  FREE_PLAN_SUNSET_AT: '2026-10-20T00:00:00Z',
  FREE_PLAN_SUNSET_EXEMPT_ORGS: '',
};
const START_TRIAL = /Start \d+-Day Free Trial/;

async function newWorkspace(context: BrowserContext, page: Page) {
  const account = await signUpViaApi(context, { country: 'IN' });
  await visitFrom(page, 'IN');
  return account;
}

const draft = (integrationId: string, day: number): Record<string, unknown> => ({
  type: 'draft',
  shortLink: false,
  date: new Date(Date.now() + day * 86400_000).toISOString(),
  tags: [] as string[],
  posts: [{ integration: { id: integrationId }, group: `g${day}`, value: [{ content: `post ${day}`, image: [] as string[] }], settings: {} }],
});

test.describe('free posts', () => {
  test.beforeAll(async () => {
    await control.setPolicyEnv(PRODUCTION_POLICY);
  });
  test.afterAll(async () => {
    await control.setPolicyEnv(DEFAULT_POLICY);
  });

  test('a new workspace lands in the app, not the paywall, and sees "3 of 3 free posts left" with an Upgrade link to the plans', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    const { email, auth } = await newWorkspace(context, page);
    await control.addChannel(email, 'bluesky', 'E2E Bluesky');
    expect((await api(auth, 'GET', '/user/self')).body).toMatchObject({
      planState: 'free_posts',
      allowTrial: false,
      freePosts: { used: 0, limit: 3, left: 3 },
    });

    await page.goto('/launches');
    await expect(page.getByText('E2E Bluesky').first()).toBeVisible();
    // No paywall: no trial banner, no trial button, the composer opens.
    await expect(page.getByTestId('trial-required-banner')).toHaveCount(0);
    await expect(page.getByRole('button', { name: START_TRIAL })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create Post' })).toBeVisible();

    const counter = page.getByTestId('free-posts-counter');
    await expect(counter).toContainText('3 of 3 free posts left');
    const upgrade = counter.getByRole('link', { name: 'Upgrade' });
    await expect(upgrade).toHaveAttribute('href', /\/billing$/);
    await upgrade.click();
    await page.waitForURL(/\/billing$/);
    // The plans, with no trial to start.
    await expect(page.getByRole('button', { name: START_TRIAL })).toHaveCount(0);
    await expect(page.getByTestId('free-posts-plans-line')).toContainText('3 of 3 free posts left');
    errors.assertNone();
  });

  test('the counter follows the posts: 2 of 3 after one, used up after three, and the 4th is refused', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    const { email, auth } = await newWorkspace(context, page);
    const channel = await control.addChannel(email, 'bluesky', 'E2E Bluesky');

    expect((await api(auth, 'POST', '/posts', draft(channel.id, 1))).status).toBe(201);
    await page.goto('/launches');
    await expect(page.getByTestId('free-posts-counter')).toContainText('2 of 3 free posts left');

    expect((await api(auth, 'POST', '/posts', draft(channel.id, 2))).status).toBe(201);
    expect((await api(auth, 'POST', '/posts', draft(channel.id, 3))).status).toBe(201);
    await page.reload();
    await expect(page.getByTestId('free-posts-counter')).toContainText("You've used your 3 free posts");

    const fourth = await api(auth, 'POST', '/posts', draft(channel.id, 4));
    expect(fourth.status).toBe(402);
    expect(fourth.body).toMatchObject({
      code: 'FREE_POSTS_USED',
      message: "You've used your 3 free posts. Pick a plan to keep posting.",
    });
    expect(await control.posts(email)).toHaveLength(3);
    errors.assertNone();
  });

  test('with a plan the counter is gone', async ({ page, context }) => {
    const { email } = await newWorkspace(context, page);
    await control.givePlan(email, 'STANDARD');
    await control.addChannel(email, 'bluesky', 'E2E Bluesky');
    await page.goto('/launches');
    await expect(page.getByText('E2E Bluesky').first()).toBeVisible();
    await expect(page.getByTestId('free-posts-counter')).toHaveCount(0);
  });
});
