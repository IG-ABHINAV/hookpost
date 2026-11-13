/**
 * FREE_POSTS_USED for an account that used its free posts elsewhere (owner
 * copy, 29 Oct 2026, item 11), in the composer: your own other workspace
 * with posts left is named with [Switch to <name>] [See plans]; anyone
 * else's never is.
 */
import { expect, Page, test } from '@playwright/test';
import { api, BACKEND, control, failOnServerErrors, signUpViaApi, visitFrom } from './support';

const PRODUCTION_POLICY = { TRIAL_REQUIRED_SINCE_IN: '2026-10-19T00:00:00Z', FREE_PLAN_SUNSET_AT: '', FREE_PLAN_SUNSET_EXEMPT_ORGS: '' };
const DEFAULT_POLICY = { TRIAL_REQUIRED_SINCE_IN: '2099-01-01T00:00:00Z', FREE_PLAN_SUNSET_AT: '2026-10-20T00:00:00Z', FREE_PLAN_SUNSET_EXEMPT_ORGS: '' };

const draft = (integrationId: string, day: number) => ({
  type: 'draft',
  shortLink: false,
  date: new Date(Date.now() + day * 86400_000).toISOString(),
  tags: [] as string[],
  posts: [{ integration: { id: integrationId }, group: `g${day}`, value: [{ content: `post ${day}`, image: [] as string[] }], settings: {} }],
});

async function tryToSchedule(page: Page, channelName: string, workspaceId?: string) {
  await page.goto('/launches');
  if (workspaceId) {
    // The workspace menu's own call (organization.selector.tsx), then a reload.
    await page.evaluate(
      ([backend, id]) =>
        fetch(`${backend}/user/change-org`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        }),
      [BACKEND, workspaceId]
    );
    await page.reload();
  }
  await expect(page.getByText(channelName).first()).toBeVisible();
  // The button can be pressed before the page has hydrated; press until the composer opens.
  const avatar = page.locator('.bg-popup img[alt="bluesky"]').first();
  await expect(async () => {
    await page.getByRole('button', { name: 'Create Post' }).click();
    await expect(avatar).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await avatar.click();
  await page.getByRole('textbox').first().click();
  await page.keyboard.type(`copy test ${Date.now()}`);
  await page.getByRole('button', { name: 'Add to Calendar' }).click();
}

test.describe('free posts used elsewhere: what the composer says', () => {
  test.beforeAll(async () => control.setPolicyEnv(PRODUCTION_POLICY));
  test.afterAll(async () => control.setPolicyEnv(DEFAULT_POLICY));

  test('your own other workspace with posts left: named, and [Switch to it] switches', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    const { email, auth } = await signUpViaApi(context, { country: 'IN' });
    await visitFrom(page, 'IN');
    const account = `bsky-${Date.now().toString(36)}`;
    const first = await control.addChannel(email, 'bluesky', 'E2E First Bluesky', { internalId: account });
    expect((await api(auth, 'POST', '/posts', draft(first.id, 1))).status).toBe(201);
    const self = (await api(auth, 'GET', '/user/self')).body;
    const second = await control.addWorkspace(email, 'Second Studio');
    await control.addChannel(email, 'bluesky', 'E2E Second Bluesky', { internalId: account, organizationId: second.id });

    await tryToSchedule(page, 'E2E Second Bluesky', second.id);
    const dialog = page.getByText(/still has 2 free posts with this Bluesky account/);
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('button', { name: 'See plans' })).toBeVisible();
    await page.getByRole('button', { name: /^Switch to / }).click();
    await page.waitForLoadState('load');
    await expect.poll(async () => (await context.cookies()).find((c) => c.name === 'showorg')?.value).toBe(self.orgId);
    errors.assertNone();
  });

  test("someone else's workspace is never named: the general copy and [See plans]", async ({ page, context, browser }) => {
    const theirs = await browser.newContext();
    const owner = await signUpViaApi(theirs, { country: 'IN' });
    const account = `bsky-${Date.now().toString(36)}`;
    const ch = await control.addChannel(owner.email, 'bluesky', 'Their Bluesky', { internalId: account });
    expect((await api(owner.auth, 'POST', '/posts', draft(ch.id, 1))).status).toBe(201);
    await theirs.close();

    const { email } = await signUpViaApi(context, { country: 'IN' });
    await visitFrom(page, 'IN');
    await control.addChannel(email, 'bluesky', 'E2E Mine Bluesky', { internalId: account });
    await tryToSchedule(page, 'E2E Mine Bluesky');
    await expect(page.getByText('This Bluesky account has already used its free posts on Hookpost. Pick a plan to keep posting from it. Your other connected accounts are not affected.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Switch to / })).toHaveCount(0);
    await page.getByRole('button', { name: 'See plans' }).click();
    await page.waitForURL(/\/billing/);
  });
});
