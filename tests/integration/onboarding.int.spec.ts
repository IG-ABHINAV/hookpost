/**
 * First run and the plan state a workspace is in (trial.policy.ts):
 *  - with no trial cutoff set, a new workspace is on Free and can "Start
 *    free" (remembered on the server, so the plans screen does not come back);
 *  - with a cutoff set (TRIAL_REQUIRED_SINCE_IN / _GLOBAL), a new workspace
 *    is on free_posts: the normal app and FREE_POST_LIMIT posts, then it
 *    chooses a plan (free-posts.int.spec.ts covers the posts themselves);
 *  - a grandfathered workspace (created before its cutoff) the Free plan
 *    sunset reached must start its trial first (needs_trial): every
 *    plan-gated action answers 402 TRIAL_REQUIRED, Billing stays reachable,
 *    the API key is withheld;
 *  - a workspace in its trial (a subscription row, isTrailing) can use it;
 *  - the Free plan sunset (FREE_PLAN_SUNSET_AT) ends Free for older
 *    workspaces, except the exempt ones.
 * And deleting the account.
 *
 * The cutoffs are read from the environment on every call, so each test sets
 * them and the afterEach clears them.
 */
import { startApp, TestApp } from './setup/app';
import { Session, inviteTokenFrom } from './setup/api';
import { addChannel, apiKeyOf, db, disconnectDb, givePlan } from './setup/db';
import {
  PLAN_GATE_MESSAGES,
  trialCheckoutOn,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

const POLICY_ENV = [
  'TRIAL_REQUIRED_SINCE_IN',
  'TRIAL_REQUIRED_SINCE_GLOBAL',
  'FREE_PLAN_SUNSET_AT',
  'FREE_PLAN_SUNSET_EXEMPT_ORGS',
];
// The earliest cutoff trial.policy.ts accepts (TRIAL_CUTOFF_FLOOR).
const CUTOFF = '2026-10-19T00:00:00Z';
// A workspace created now is BEFORE this cutoff (grandfathered); with the
// sunset below passed it is needs_trial. Created after a cutoff it is
// free_posts instead (since 28 Oct 2026).
const FUTURE_CUTOFF = '2099-01-01T00:00:00Z';
const SUNSET_PASSED = '2026-10-20T00:00:00Z';

describe('onboarding and plan state', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterEach(() => {
    for (const key of POLICY_ENV) process.env[key] = '';
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  const postBody = (integrationId: string) => ({
    type: 'draft',
    shortLink: false,
    date: new Date(Date.now() + 86400_000).toISOString(),
    tags: [],
    posts: [{ integration: { id: integrationId }, group: 'g1', value: [{ content: 'hello', image: [] }], settings: {} }],
  });

  describe('no trial cutoff (Free plan for everyone)', () => {
    it('a new workspace is on Free and sees the plans screen once', async () => {
      const s = await t.api.register();
      const self = await s.self();
      expect(self).toMatchObject({ tier: 'FREE', planState: 'free', freePlanAvailable: true, continueFree: false, trialPolicyActive: false });
      expect(self.publicApi).toBeTruthy();

      const choose = await s.post('/user/free-plan');
      expect(choose.status).toBe(201);
      expect((await s.self()).continueFree).toBe(true);
    });

    it('a workspace that already has a channel skips the plans screen', async () => {
      const s = await t.api.register();
      await addChannel((await s.self()).orgId, 'bluesky');
      expect((await s.self()).continueFree).toBe(true);
    });

    it('Free can save a draft to its own channel', async () => {
      const s = await t.api.register();
      const channel = await addChannel((await s.self()).orgId, 'bluesky');
      expect((await s.post('/posts', postBody(channel.id))).status).toBe(201);
    });
  });

  // The cohort is decided by the owner's signup country (Cloudflare, recorded
  // on the first signed-in request). The integration client sends none, so
  // the tests set it on the user row the way that request would.
  async function setOwnerCountry(s: Session, country: string | null) {
    await db().user.update({ where: { id: (await s.self()).id }, data: { signupCountry: country } });
  }

  describe('a grandfathered workspace the Free plan sunset reached (needs_trial)', () => {
    let s: Session;
    let orgId: string;
    beforeEach(async () => {
      process.env.TRIAL_REQUIRED_SINCE_IN = FUTURE_CUTOFF;
      process.env.TRIAL_REQUIRED_SINCE_GLOBAL = FUTURE_CUTOFF;
      process.env.FREE_PLAN_SUNSET_AT = SUNSET_PASSED;
      s = await t.api.register();
      orgId = (await s.self()).orgId;
      await setOwnerCountry(s, 'IN');
    });

    it('/user/self: needs_trial, no Free plan, no API key handed out', async () => {
      const self = await s.self();
      expect(self).toMatchObject({ planState: 'needs_trial', freePlanAvailable: false, trialPolicyActive: true, publicApi: '' });
    });

    it('plan-gated actions answer 402 TRIAL_REQUIRED with the paywall message', async () => {
      const channel = await addChannel(orgId, 'bluesky');
      const post = await s.post('/posts', postBody(channel.id));
      expect(post.status).toBe(402);
      expect(post.body).toMatchObject({
        code: 'TRIAL_REQUIRED',
        message: PLAN_GATE_MESSAGES.TRIAL_REQUIRED,
        trial: true,
        url: 'http://localhost:4200/billing',
      });
      const connect = await s.get('/integrations/social/linkedin');
      expect(connect.status).toBe(402);
      expect(connect.body.code).toBe('TRIAL_REQUIRED');
    });

    it('Billing stays reachable so the trial can be started', async () => {
      expect((await s.get('/user/subscription/tiers')).status).toBe(200);
      expect((await s.get('/billing/pricing-context')).status).toBe(200);
      expect((await s.get('/billing')).status).toBe(200);
    });

    it('a workspace in its trial can use the plan', async () => {
      await givePlan(orgId, 'STANDARD');
      await db().organization.update({ where: { id: orgId }, data: { isTrailing: true } });
      const self = await s.self();
      expect(self.planState).toBe('trialing');
      const channel = await addChannel(orgId, 'bluesky');
      expect((await s.post('/posts', postBody(channel.id))).status).toBe(201);
    });

    it('a workspace whose trial was used and lost its plan is locked: PLAN_REQUIRED', async () => {
      await db().organization.update({ where: { id: orgId }, data: { allowTrial: false } });
      const self = await s.self();
      expect(self.planState).toBe('locked');
      const channel = await addChannel(orgId, 'bluesky');
      const post = await s.post('/posts', postBody(channel.id));
      expect(post.status).toBe(402);
      expect(post.body.code).toBe('PLAN_REQUIRED');
    });

    it('outside India the trial is not asked for while the dollar checkout is off', async () => {
      // USD_CHECKOUT is not "on" in the test env, so GLOBAL fails open to Free.
      await setOwnerCountry(s, 'US');
      const self = await s.self();
      expect(self.planState).toBe('free');
      expect(self.freePlanAvailable).toBe(true);
    });

    it('an exempt workspace keeps the Free plan', async () => {
      process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = orgId;
      const self = await s.self();
      expect(self.planState).toBe('free');
      expect(self.freePlanAvailable).toBe(true);
    });
  });

  describe('trial cutoff set (new workspaces get free posts, not a trial)', () => {
    let s: Session;
    let orgId: string;
    beforeEach(async () => {
      process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
      process.env.TRIAL_REQUIRED_SINCE_GLOBAL = CUTOFF;
      s = await t.api.register();
      orgId = (await s.self()).orgId;
      await setOwnerCountry(s, 'IN');
    });

    it('/user/self: free_posts, no Free plan, 3 of 3 left, checkout without a trial', async () => {
      const self = await s.self();
      expect(self).toMatchObject({
        planState: 'free_posts',
        freePlanAvailable: false,
        trialPolicyActive: true,
        // No trial while the trial switch is off (production); with it on, one.
        allowTrial: trialCheckoutOn(),
        preTrialChannelLimit: null,
        freePosts: { used: 0, limit: 3, left: 3 },
      });
    });

    it('is not behind the paywall: connect and post work, Billing stays reachable', async () => {
      const channel = await addChannel(orgId, 'bluesky');
      expect((await s.post('/posts', postBody(channel.id))).status).toBe(201);
      expect((await s.get('/billing')).status).toBe(200);
    });

    it('a workspace in its trial can use the plan', async () => {
      await givePlan(orgId, 'STANDARD');
      await db().organization.update({ where: { id: orgId }, data: { isTrailing: true } });
      expect((await s.self()).planState).toBe('trialing');
      const channel = await addChannel(orgId, 'bluesky');
      expect((await s.post('/posts', postBody(channel.id))).status).toBe(201);
    });

    it('a workspace whose trial was used and lost its plan is locked: PLAN_REQUIRED', async () => {
      await db().organization.update({ where: { id: orgId }, data: { allowTrial: false } });
      const self = await s.self();
      expect(self.planState).toBe('locked');
      const channel = await addChannel(orgId, 'bluesky');
      const post = await s.post('/posts', postBody(channel.id));
      expect(post.status).toBe(402);
      expect(post.body.code).toBe('PLAN_REQUIRED');
    });

    it('outside India the trial is not asked for while the dollar checkout is off', async () => {
      // USD_CHECKOUT is not "on" in the test env, so GLOBAL fails open to Free.
      await setOwnerCountry(s, 'US');
      const self = await s.self();
      expect(self.planState).toBe('free');
      expect(self.freePlanAvailable).toBe(true);
    });

    it('a workspace created before the cutoff keeps the Free plan', async () => {
      await db().organization.update({ where: { id: orgId }, data: { createdAt: new Date('2026-10-01T00:00:00Z') } });
      const self = await s.self();
      expect(self.planState).toBe('free');
      expect(self.freePlanAvailable).toBe(true);
    });
  });

  describe('Free plan sunset', () => {
    async function oldFreeWorkspace() {
      const s = await t.api.register();
      const { orgId } = await s.self();
      await setOwnerCountry(s, 'IN');
      await db().organization.update({
        where: { id: orgId },
        data: { createdAt: new Date('2026-10-01T00:00:00Z') },
      });
      return { s, orgId };
    }

    it('once the sunset has passed, an old Free workspace has to choose', async () => {
      process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
      process.env.TRIAL_REQUIRED_SINCE_GLOBAL = CUTOFF;
      process.env.FREE_PLAN_SUNSET_AT = '2026-10-20T00:00:00Z';
      const { s } = await oldFreeWorkspace();
      const self = await s.self();
      expect(['needs_trial', 'locked']).toContain(self.planState);
      expect(self.freePlanAvailable).toBe(false);
    });

    it('before the sunset, the date is announced and Free still works', async () => {
      process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
      process.env.TRIAL_REQUIRED_SINCE_GLOBAL = CUTOFF;
      process.env.FREE_PLAN_SUNSET_AT = '2099-01-01T00:00:00Z';
      const { s } = await oldFreeWorkspace();
      const self = await s.self();
      expect(self.planState).toBe('free');
      expect(self.freePlanEndsAt).toBe('2099-01-01T00:00:00.000Z');
    });

    it('an exempt workspace keeps Free after the sunset', async () => {
      process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
      process.env.TRIAL_REQUIRED_SINCE_GLOBAL = CUTOFF;
      process.env.FREE_PLAN_SUNSET_AT = '2026-10-20T00:00:00Z';
      const { s, orgId } = await oldFreeWorkspace();
      process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = `some-other-org,${orgId}`;
      expect((await s.self()).planState).toBe('free');
    });
  });

  describe('delete account', () => {
    it('removes the workspace, its channels and its API key, and signs out', async () => {
      const s = await t.api.register({ company: 'Leaving Co' });
      const { orgId, id } = await s.self();
      await givePlan(orgId, 'STANDARD');
      const key = await apiKeyOf(orgId);
      const channel = await addChannel(orgId, 'bluesky');
      expect((await t.api.publicApi(key, 'GET', '/is-connected')).status).toBe(200);

      const res = await s.post('/user/delete-account');
      expect(res.status).toBe(200);
      expect(res.headers.get('logout')).toBe('true');

      expect((await db().user.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
      expect((await db().organization.findUniqueOrThrow({ where: { id: orgId } })).deletedAt).not.toBeNull();
      expect((await db().integration.findUniqueOrThrow({ where: { id: channel.id } })).deletedAt).not.toBeNull();
      expect((await t.api.publicApi(key, 'GET', '/is-connected')).status).toBe(401);
      await expect(t.api.login(s.email, s.password)).rejects.toThrow();
      // The old session no longer works either.
      expect((await s.get('/user/self')).status).toBe(401);
    });

    it('a team member deleting their account leaves the workspace intact', async () => {
      const owner = await t.api.register();
      const { orgId } = await owner.self();
      await givePlan(orgId, 'PRO');
      const invite = await owner.post('/settings/team', { role: 'USER', sendEmail: false });
      const member = await t.api.register({ cookies: { org: inviteTokenFrom(invite.body.url) } });
      await member.post('/user/delete-account');
      expect((await db().organization.findUniqueOrThrow({ where: { id: orgId } })).deletedAt).toBeNull();
      expect((await owner.self()).orgId).toBe(orgId);
    });
  });
});
