/**
 * A behaviour that depends on a setting read when the backend boots, so this
 * file starts its own app with it:
 *  - API_LIMIT: POST /public/v1/posts is rate limited per workspace per hour
 *    (ThrottlerBehindProxyGuard, Redis storage).
 * EMAIL_PROVIDER stays set as in production (the sign-ups here are
 * unconfirmed, and drafts are what they post). Email confirmation itself is
 * email-verification.int.spec.ts since 25 Oct 2026, when a password sign-up
 * stopped having to open the emailed link before it could sign in.
 */
process.env.EMAIL_PROVIDER = 'resend';
process.env.API_LIMIT = '3';

import { startApp, TestApp } from './setup/app';
import { uniqueEmail } from './setup/api';
import { addChannel, apiKeyOf, db, disconnectDb, givePlan } from './setup/db';

describe('settings read at boot: API_LIMIT', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  describe('public API rate limit', () => {
    it('POST /public/v1/posts: API_LIMIT per hour per workspace, then 429', async () => {
      const email = uniqueEmail('ratelimit');
      await t.api.post('/auth/register', { email, password: 'Correct-Horse-9', company: 'Rate Co', provider: 'LOCAL' });
      // Confirmed: an unconfirmed account's key is refused outright (the hard gate).
      await db().user.updateMany({ where: { email }, data: { activated: true } });
      const user = await db().user.findFirstOrThrow({ where: { email }, include: { organizations: true } });
      const orgId = user.organizations[0].organizationId;
      await givePlan(orgId, 'STANDARD');
      const key = await apiKeyOf(orgId);
      const channel = await addChannel(orgId, 'bluesky');
      const body = {
        type: 'draft',
        shortLink: false,
        date: new Date(Date.now() + 86400_000).toISOString(),
        tags: [],
        posts: [{ integration: { id: channel.id }, value: [{ content: 'rate', image: [] }], settings: {} }],
      };

      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await t.api.publicApi(key, 'POST', '/posts', body)).status);
      }
      expect(statuses).toEqual([201, 201, 201, 429]);

      // Reads are not limited.
      expect((await t.api.publicApi(key, 'GET', '/integrations')).status).toBe(200);

      // Another workspace has its own allowance.
      const other = uniqueEmail('ratelimit2');
      await t.api.post('/auth/register', { email: other, password: 'Correct-Horse-9', company: 'Rate Two', provider: 'LOCAL' });
      await db().user.updateMany({ where: { email: other }, data: { activated: true } });
      const otherUser = await db().user.findFirstOrThrow({ where: { email: other }, include: { organizations: true } });
      const otherOrg = otherUser.organizations[0].organizationId;
      await givePlan(otherOrg, 'STANDARD');
      const otherChannel = await addChannel(otherOrg, 'bluesky');
      const res = await t.api.publicApi(await apiKeyOf(otherOrg), 'POST', '/posts', {
        ...body,
        posts: [{ ...body.posts[0], integration: { id: otherChannel.id } }],
      });
      expect(res.status).toBe(201);
    });
  });
});
