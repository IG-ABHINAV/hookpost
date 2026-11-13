/**
 * The review card ("Enjoying Hookpost? A short review helps a lot.") in a
 * real browser: when it shows (the server's decision, review.ask.policy.ts),
 * where it links on the website, in an Android browser and in the Play app
 * (a Trusted Web Activity, recognised by its launch referrer or ?source=twa),
 * that it never covers the composer, and that "Not now" and a click are kept
 * on the server. These accounts sign up on their own domain: the E2E backend
 * keeps the card away from every other spec's accounts
 * (FREE_PLAN_SUNSET_SKIP_EMAILS in tests/e2e/server/backend.ts).
 */
import { BrowserContext, expect, Page, test } from '@playwright/test';
import { api, control, failOnServerErrors, signUpViaApi } from './support';

const G2 = 'https://www.g2.com/products/hookpost/take_survey';
const PLAY = 'https://play.google.com/store/apps/details?id=in.hookstep.hookpost.twa';
const TWA_REFERRER = 'android-app://in.hookstep.hookpost.twa/';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
/** The card waits 8 s after a page load; give it room. */
const DUE = { timeout: 25_000 };
/** After the check answered: long enough for a claim and a render. */
const SETTLE_MS = 3_000;

let n = 0;
const reviewEmail = (tag = 'review') =>
  `${tag}.${Date.now().toString(36)}.${(n++).toString(36)}@review-card.invalid`;

const card = (page: Page) => page.getByTestId('review-prompt');
/**
 * The card's own check (GET /user/review-ask, 8 s after a page load), so a
 * "stays hidden" assertion runs after the page really asked. Call before the
 * navigation; await the answer.
 */
const reviewCheck = (page: Page) =>
  page
    .waitForResponse(
      (r) => r.url().includes('/user/review-ask') && r.request().method() === 'GET',
      { timeout: 30_000 }
    )
    .then((r) => r.json() as Promise<{ ask: boolean }>);

/** The composer (a modal over the calendar). */
const composer = (page: Page) => page.getByRole('button', { name: 'Save as draft' });

/** The review sites stand in locally: nothing leaves the machine. */
async function standInReviewSites(context: BrowserContext) {
  await context.route('https://www.g2.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>G2 (E2E stand-in)</h1>' })
  );
  await context.route('https://play.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Google Play (E2E stand-in)</h1>' })
  );
}

/** A workspace that has just started its paid plan: the success moment. */
async function justPaid(context: BrowserContext, email = reviewEmail()) {
  const account = await signUpViaApi(context, { email });
  await control.givePlan(account.email, 'STANDARD');
  return account;
}

/** "Post now" through the API, then published by the orchestrator's activity. */
async function publishedPost(auth: string, channelId: string, minutesAgo?: number) {
  const res = await api(auth, 'POST', '/posts', {
    type: 'now',
    shortLink: false,
    date: new Date().toISOString(),
    tags: [],
    posts: [
      {
        integration: { id: channelId },
        group: `g${Date.now()}`,
        value: [{ content: `Review card E2E ${Date.now()}`, image: [] }],
        settings: {},
      },
    ],
  });
  expect(res.status).toBe(201);
  const id = res.body[0].postId;
  expect(await control.publish(id, minutesAgo)).toEqual({ published: true });
  return id;
}

test.describe('review card', () => {
  test('website, desktop: right after a paid plan starts, G2 only; "Not now" is kept for 60 days', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    await standInReviewSites(context);
    const { email } = await justPaid(context);
    await page.goto('/launches');

    await expect(card(page)).toBeVisible(DUE);
    await expect(card(page)).toContainText('Enjoying Hookpost?');
    await expect(card(page)).toContainText('A short review helps a lot.');
    const links = card(page).getByRole('link');
    await expect(links).toHaveCount(1);
    await expect(links.first()).toHaveText('Review on G2');
    await expect(links.first()).toHaveAttribute('href', G2);
    await expect(card(page).getByText('Rate on Google Play')).toHaveCount(0);
    expect(await control.reviewAsk(email)).toMatchObject({ asks: 1, dismissedAt: null, clickedAt: null });

    await card(page).getByRole('button', { name: 'Not now' }).click();
    await expect(card(page)).toHaveCount(0);
    await expect.poll(async () => (await control.reviewAsk(email))?.dismissedAt).not.toBeNull();

    const again = reviewCheck(page);
    await page.reload();
    expect(await again).toEqual({ ask: false });
    await page.waitForTimeout(SETTLE_MS);
    await expect(card(page)).toHaveCount(0);
    expect((await control.reviewAsk(email))?.asks).toBe(1);
    errors.assertNone();
  });

  test('the Play app (launch referrer): one button, to Google Play; opening it ends the asks', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    await standInReviewSites(context);
    const { email } = await justPaid(context);
    // The Play app's launch: Chrome gives the first page the TWA's
    // android-app:// referrer (Chrome itself will not send that scheme as a
    // Referer header, so the document's referrer is set before any script).
    await page.addInitScript((referrer: string) => {
      Object.defineProperty(document, 'referrer', { get: () => referrer, configurable: true });
    }, TWA_REFERRER);
    await page.goto('/launches');

    await expect(card(page)).toBeVisible(DUE);
    const links = card(page).getByRole('link');
    await expect(links).toHaveCount(1);
    await expect(links.first()).toHaveText('Review on Google Play');
    await expect(links.first()).toHaveAttribute('href', PLAY);
    await expect(card(page).getByText('G2')).toHaveCount(0);

    const [store] = await Promise.all([context.waitForEvent('page'), links.first().click()]);
    await store.waitForLoadState();
    expect(store.url()).toBe(PLAY);
    await expect(card(page)).toHaveCount(0);
    await expect.poll(async () => (await control.reviewAsk(email))?.clickedTarget).toBe('play');
    errors.assertNone();
  });

  test('the Play app (?source=twa) after a navigation that lost the referrer: still Google Play', async ({ page, context }) => {
    await standInReviewSites(context);
    await justPaid(context);
    await page.goto('/launches?source=twa');
    await page.goto('/settings');
    await expect(card(page)).toBeVisible(DUE);
    await expect(card(page).getByRole('link')).toHaveCount(1);
    await expect(card(page).getByRole('link').first()).toHaveAttribute('href', PLAY);
  });

  test.describe('an Android browser at phone width', () => {
    test.use({ userAgent: ANDROID_CHROME, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    test('G2 first, then "Rate on Google Play"; the card fits the screen', async ({ page, context }) => {
      await standInReviewSites(context);
      const { email } = await justPaid(context);
      await page.goto('/launches');
      await expect(card(page)).toBeVisible(DUE);
      const links = card(page).getByRole('link');
      await expect(links).toHaveCount(2);
      await expect(links.nth(0)).toHaveAttribute('href', G2);
      await expect(links.nth(1)).toHaveText('Rate on Google Play');
      await expect(links.nth(1)).toHaveAttribute('href', PLAY);

      const box = (await card(page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
      expect(box.y + box.height).toBeLessThanOrEqual(812);

      await links.nth(1).click();
      await expect.poll(async () => (await control.reviewAsk(email))?.clickedTarget).toBe('play');
    });
  });

  test('after the second published post, not the first, and never over the composer', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    await standInReviewSites(context);
    const { email, auth } = await signUpViaApi(context, { email: reviewEmail('posts') });
    // A plan bought long ago: no success moment of its own.
    await control.givePlan(email, 'STANDARD', { startedDaysAgo: 90 });
    const channel = await control.addChannel(email, 'linkedin', 'E2E Review LinkedIn');

    await publishedPost(auth, channel.id, 30);
    const first = reviewCheck(page);
    await page.goto('/launches');
    await expect(page.getByText('E2E Review LinkedIn').first()).toBeVisible();
    expect(await first).toEqual({ ask: false });
    await page.waitForTimeout(SETTLE_MS);
    await expect(card(page)).toHaveCount(0);
    expect(await control.reviewAsk(email)).toBeNull();

    await publishedPost(auth, channel.id);
    const second = reviewCheck(page);
    await page.reload();
    await expect(page.getByText('E2E Review LinkedIn').first()).toBeVisible();
    // The composer is open when the card becomes due: it waits, unclaimed.
    await page.getByRole('button', { name: 'Create Post' }).click();
    await expect(composer(page)).toBeVisible();
    expect(await second).toEqual({ ask: true });
    await page.waitForTimeout(SETTLE_MS);
    await expect(card(page)).toHaveCount(0);
    expect(await control.reviewAsk(email)).toBeNull();

    // Closed: now it shows, and only now is the ask spent.
    await page.keyboard.press('Escape');
    await expect(composer(page)).toHaveCount(0);
    await expect(card(page)).toBeVisible(DUE);
    expect(await control.reviewAsk(email)).toMatchObject({ asks: 1 });

    // Opening the composer again: the card steps aside, and comes back.
    await page.getByRole('button', { name: 'Create Post' }).click();
    await expect(composer(page)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(composer(page)).toHaveCount(0);
    await expect(card(page)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    await expect.poll(async () => (await control.reviewAsk(email))?.dismissedAt).not.toBeNull();
    errors.assertNone();
  });

  test('never for our own accounts, even right after a plan starts', async ({ page, context }) => {
    const { email } = await justPaid(context, `qa.${Date.now().toString(36)}@hookstep.in`);
    const checked = reviewCheck(page);
    await page.goto('/launches');
    expect(await checked).toEqual({ ask: false });
    await page.waitForTimeout(SETTLE_MS);
    await expect(card(page)).toHaveCount(0);
    expect(await control.reviewAsk(email)).toBeNull();
  });

  test('a post saved in the composer: the card re-checks on its own once the post is out', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    await standInReviewSites(context);
    const { email, auth } = await signUpViaApi(context, { email: reviewEmail('composer') });
    await control.givePlan(email, 'STANDARD', { startedDaysAgo: 90 });
    const channel = await control.addChannel(email, 'linkedin', 'E2E Composer LinkedIn');
    await publishedPost(auth, channel.id, 30);

    const checked = reviewCheck(page);
    await page.goto('/launches');
    await expect(page.getByText('E2E Composer LinkedIn').first()).toBeVisible();
    expect(await checked).toEqual({ ask: false });
    // A marker a reload would lose: the card must come without one.
    await page.evaluate(() => ((window as any).__noReload = true));

    await page.getByRole('button', { name: 'Create Post' }).click();
    await page.locator('.bg-popup img[alt="linkedin"]').first().click();
    await page.getByRole('textbox').first().click();
    const text = `Second post from the review card E2E ${Date.now()}`;
    await page.keyboard.type(text);
    await page.getByRole('button', { name: 'Add to Calendar' }).click();
    await expect(page.getByText('Added successfully')).toBeVisible();
    // Its time comes and the publisher sends it (a minute ago).
    const saved = (await control.posts(email)).find((p) => p.content.includes(text))!;
    expect(saved.state).toBe('QUEUE');
    expect(await control.publish(saved.id, 1)).toEqual({ published: true });

    await expect(card(page)).toBeVisible({ timeout: 35_000 });
    expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
    expect(await control.reviewAsk(email)).toMatchObject({ asks: 1 });
    errors.assertNone();
  });

  test('a second tab gets no second card', async ({ page, context }) => {
    await standInReviewSites(context);
    const { email } = await justPaid(context);
    const other = await context.newPage();
    await Promise.all([page.goto('/launches'), other.goto('/launches')]);
    const shown = async () => (await card(page).count()) + (await card(other).count());
    await expect.poll(shown, DUE).toBe(1);
    await page.waitForTimeout(3000);
    expect(await shown()).toBe(1);
    expect((await control.reviewAsk(email))?.asks).toBe(1);
  });
});
