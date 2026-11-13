/**
 * The monthly X cap as a person meets it (pricing.ts x_posts_per_month,
 * XPostCapService): the post over the cap is not sent to X, and the calendar
 * marks it failed with the cap's sentence on its error badge.
 *
 * X itself is stubbed by the E2E backend; control.publish runs the
 * orchestrator's real PostActivity on the post.
 */
import { expect, test } from '@playwright/test';
import { api, control, failOnServerErrors, signUpViaApi } from './support';

async function postNowOnX(auth: string, channelId: string, text: string) {
  const res = await api(auth, 'POST', '/posts', {
    type: 'now',
    shortLink: false,
    date: new Date().toISOString(),
    tags: [],
    posts: [
      {
        integration: { id: channelId },
        group: `g${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        value: [{ content: text, image: [] }],
        settings: { __type: 'x', who_can_reply_post: 'everyone' },
      },
    ],
  });
  expect(res.status).toBe(201);
  return res.body[0].postId as string;
}

test('Standard: the 51st X post of the month is refused, and the calendar says why', async ({ page, context }) => {
  const errors = failOnServerErrors(page);
  const { email, auth } = await signUpViaApi(context);
  await control.givePlan(email, 'STANDARD');
  const x = await control.addChannel(email, 'x', 'Capped X');
  await control.useCredits(email, 'x_posts', 49);

  expect(await control.publish(await postNowOnX(auth, x.id, 'The fiftieth X post'))).toEqual({ published: true });

  const refused = await control.publish(await postNowOnX(auth, x.id, 'One X post too many'));
  expect(refused.published).toBe(false);
  expect(refused.error).toMatch(/^Your Standard plan includes 50 X posts a month/);

  await page.goto('/launches');
  const badge = page.locator('[data-tooltip-content^="Your Standard plan includes 50 X posts a month"]');
  await expect(badge).toHaveCount(1);
  await badge.hover();
  await expect(page.getByRole('tooltip').or(page.locator('#tooltip'))).toContainText('50 X posts a month');
  errors.assertNone();
});
