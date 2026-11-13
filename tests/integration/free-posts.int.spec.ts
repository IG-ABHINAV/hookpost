/**
 * Free posts (28 Oct 2026): a workspace created on or after its group's
 * cutoff, with no plan and its trial unused, is `free_posts` (trial.policy.ts)
 * instead of `needs_trial`. It uses the normal app and may create
 * FREE_POST_LIMIT (3) posts: drafts count, and one save to several channels
 * is ONE post (its channels share a publishDate, freePostKey). The 4th new
 * post is a 402 FREE_POSTS_USED and nothing is saved; an edit of a post it
 * has is never new; Repeat Post is a 400. Its checkout starts no trial, so
 * the first-month offer attaches. Against the real backend, Postgres and an
 * in-memory Razorpay (FakeRazorpay); only LinkedIn's token exchange is
 * replaced.
 *
 * The cutoffs are read from the environment on every call: each test sets
 * them and afterEach clears them.
 */
import { createHash } from 'crypto';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { addChannel, db, disconnectDb, givePlan, makeSuperAdmin } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import {
  PLAN_GATE_MESSAGES,
  reusedChannelMessage,
  trialCheckoutOn,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

const POLICY_ENV = [
  'TRIAL_REQUIRED_SINCE_IN',
  'TRIAL_REQUIRED_SINCE_GLOBAL',
  'FREE_PLAN_SUNSET_AT',
  'FREE_PLAN_SUNSET_EXEMPT_ORGS',
];
const PROVIDER_ENV: Record<string, string> = {
  LINKEDIN_CLIENT_ID: 'linkedin-client-test',
  LINKEDIN_CLIENT_SECRET: 'linkedin-secret-test',
};
// The earliest cutoff trial.policy.ts accepts (TRIAL_CUTOFF_FLOOR).
const CUTOFF = '2026-10-19T00:00:00Z';
const USED_MESSAGE = "You've used your 3 free posts. Pick a plan to keep posting.";
const UPI_OFFER = process.env.RAZORPAY_OFFER_FIRST_MONTH_UPI!;

let accounts = 0;
const account = (tag: string) => `${tag}-${Date.now().toString(36)}-${accounts++}`;

describe('free posts: a new sign-up gets 3 posts, not a trial', () => {
  let t: TestApp;
  const rzp = new FakeRazorpay();
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [k, v] of Object.entries(PROVIDER_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    rzp.install();
    t = await startApp();
  });
  afterEach(() => {
    for (const key of POLICY_ENV) process.env[key] = '';
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rzp.uninstall();
    await t?.close();
    await disconnectDb();
  });

  /** A new Indian workspace created after the cutoff: free_posts. */
  async function newWorkspace(): Promise<{ s: Session; orgId: string; userId: string }> {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const s = await t.api.register();
    const self = await s.self();
    await db().user.update({ where: { id: self.id }, data: { signupCountry: 'IN' } });
    return { s, orgId: self.orgId, userId: self.id };
  }

  /** The day `n` days from now, to the minute: one post's channels share it. */
  const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();

  const body = (
    channels: string[],
    over: { type?: string; date?: string; inter?: number; ids?: Record<string, { id: string; group: string }> } = {}
  ) => ({
    type: over.type ?? 'draft',
    shortLink: false,
    date: over.date ?? day(1),
    tags: [],
    ...(over.inter ? { inter: over.inter } : {}),
    posts: channels.map((id) => ({
      integration: { id },
      group: over.ids?.[id]?.group ?? `g-${id}`,
      value: [{ ...(over.ids?.[id] ? { id: over.ids[id].id } : {}), content: `hello ${id}`, image: [] }],
      settings: {},
    })),
  });

  const postRows = (orgId: string) => db().post.count({ where: { organizationId: orgId, deletedAt: null } });

  const freePosts = async (s: Session) => (await s.self()).freePosts;

  describe('a new workspace (created after the cutoff, no plan)', () => {
    it('/user/self: free_posts, 3 of 3 left, a checkout without a trial, no paywall', async () => {
      const { s } = await newWorkspace();
      expect(await s.self()).toMatchObject({
        planState: 'free_posts',
        // No trial while the trial switch is off (production); with it on, one
        // (trial-switch.int.spec.ts has that side).
        allowTrial: trialCheckoutOn(),
        preTrialChannelLimit: null,
        freePlanAvailable: false,
        trialPolicyActive: true,
        freePosts: { used: 0, limit: 3, left: 3 },
      });
    });

    it('connects a channel (the Free allowance is 2), and is still free_posts afterwards', async () => {
      const { s, orgId } = await newWorkspace();
      const id = account('li');
      const linkedin = t.get<IntegrationManager>(IntegrationManager).getSocialIntegration('linkedin') as any;
      jest.spyOn(linkedin, 'authenticate').mockResolvedValueOnce({
        id,
        name: `Person ${id}`,
        accessToken: `access-${id}`,
        refreshToken: `refresh-${id}`,
        expiresIn: 3600,
        picture: '',
        username: id,
      } as any);

      const link = await s.get('/integrations/social/linkedin');
      expect(link.status).toBe(200);
      const state = /[?&]state=([^&]+)/.exec(decodeURIComponent(link.body.url))?.[1] || '';
      const done = await t.api.post('/integrations/social-connect/linkedin', { code: 'oauth-code', state, timezone: '330' });
      expect(done.status).toBe(201);
      expect(await db().integration.count({ where: { organizationId: orgId, deletedAt: null } })).toBe(1);
      expect((await s.self()).planState).toBe('free_posts');

      // A second one, to the Free allowance of 2: a third is refused by the
      // Free plan's channel limit (not by a trial gate).
      await addChannel(orgId, 'bluesky');
      const third = await s.get('/integrations/social/linkedin');
      expect(third.status).not.toBe(200);
      expect(third.body?.code).not.toBe('TRIAL_REQUIRED');
    });

    it('3 posts work (one on two channels is still one post, a draft counts); the 4th is 402 FREE_POSTS_USED and saves nothing', async () => {
      const { s, orgId } = await newWorkspace();
      const a = (await addChannel(orgId, 'bluesky')).id;
      const b = (await addChannel(orgId, 'threads')).id;

      // 1: scheduled on two channels, the same date: ONE post.
      const first = await s.post('/posts', body([a, b], { type: 'schedule', date: day(1) }));
      expect(first.status).toBe(201);
      expect(await postRows(orgId)).toBe(2);
      expect(await freePosts(s)).toEqual({ used: 1, limit: 3, left: 2 });

      // 2: a draft counts.
      expect((await s.post('/posts', body([a], { type: 'draft', date: day(2) }))).status).toBe(201);
      expect(await freePosts(s)).toEqual({ used: 2, limit: 3, left: 1 });

      // 3: the last one.
      expect((await s.post('/posts', body([b], { type: 'schedule', date: day(3) }))).status).toBe(201);
      expect(await freePosts(s)).toEqual({ used: 3, limit: 3, left: 0 });
      expect(await postRows(orgId)).toBe(4);

      // 4: refused, a draft and a schedule alike, and nothing is saved.
      for (const type of ['draft', 'schedule']) {
        const refused = await s.post('/posts', body([a, b], { type, date: day(4) }));
        expect(refused.status).toBe(402);
        expect(refused.body).toMatchObject({ code: 'FREE_POSTS_USED', message: USED_MESSAGE });
        expect(refused.body.message).toBe(PLAN_GATE_MESSAGES.FREE_POSTS_USED);
        expect(await postRows(orgId)).toBe(4);
      }
      // The composer gives every new value a random id (makeId): still new.
      const composer = await s.post(
        '/posts',
        body([a, b], {
          type: 'schedule',
          date: day(5),
          ids: { [a]: { id: 'kq3ZpX81aB', group: 'g-new-a' }, [b]: { id: 'Vt0LmN44zQ', group: 'g-new-b' } },
        })
      );
      expect(composer.status).toBe(402);
      // A new post at the minute of a used one is a new post too.
      expect((await s.post('/posts', body([a], { type: 'schedule', date: day(1) }))).status).toBe(402);
      expect(await postRows(orgId)).toBe(4);
      expect(await freePosts(s)).toEqual({ used: 3, limit: 3, left: 0 });
      // Still the normal app: not a paywall state.
      expect((await s.self()).planState).toBe('free_posts');
      expect((await s.get('/billing')).status).toBe(200);
    });

    it('editing a post it has still works once the 3 are used, on either of its channels', async () => {
      const { s, orgId } = await newWorkspace();
      const a = (await addChannel(orgId, 'bluesky')).id;
      const b = (await addChannel(orgId, 'threads')).id;
      const date = day(1);
      expect((await s.post('/posts', body([a, b], { type: 'draft', date }))).status).toBe(201);
      expect((await s.post('/posts', body([a], { type: 'draft', date: day(2) }))).status).toBe(201);
      expect((await s.post('/posts', body([b], { type: 'draft', date: day(3) }))).status).toBe(201);
      expect(await freePosts(s)).toEqual({ used: 3, limit: 3, left: 0 });
      expect((await s.post('/posts', body([a], { date: day(4) }))).status).toBe(402);

      // The composer sends the existing post's id and group back.
      const existing = await db().post.findFirstOrThrow({
        where: { organizationId: orgId, integrationId: a, deletedAt: null, publishDate: { gte: new Date(date.slice(0, 16) + ':00Z') } },
        orderBy: { publishDate: 'asc' },
      });
      const edit = await s.post(
        '/posts',
        body([a], { type: 'draft', date, ids: { [a]: { id: existing.id, group: existing.group } } })
      );
      expect(edit.status).toBe(201);
      expect((await db().post.findUniqueOrThrow({ where: { id: existing.id } })).content).toContain('hello');
      expect(await freePosts(s)).toEqual({ used: 3, limit: 3, left: 0 });
    });

    it('deleting a draft gives its free post back', async () => {
      const { s, orgId } = await newWorkspace();
      const a = (await addChannel(orgId, 'bluesky')).id;
      expect((await s.post('/posts', body([a], { date: day(1) }))).status).toBe(201);
      expect(await freePosts(s)).toEqual({ used: 1, limit: 3, left: 2 });
      const row = await db().post.findFirstOrThrow({ where: { organizationId: orgId, deletedAt: null } });
      expect((await s.delete(`/posts/${row.group}`)).status).toBe(200);
      expect(await freePosts(s)).toEqual({ used: 0, limit: 3, left: 3 });
    });

    it('Repeat Post is a 400 for it, and saves nothing', async () => {
      const { s, orgId } = await newWorkspace();
      const a = (await addChannel(orgId, 'bluesky')).id;
      const res = await s.post('/posts', body([a], { type: 'schedule', inter: 7 }));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('Repeat Post needs a plan');
      expect(await postRows(orgId)).toBe(0);
      expect(await freePosts(s)).toEqual({ used: 0, limit: 3, left: 3 });
    });

    it('is not behind the plan gate elsewhere: the channel list, the slot finder and Billing answer 200', async () => {
      const { s } = await newWorkspace();
      expect((await s.get('/integrations/list')).status).toBe(200);
      expect((await s.get('/billing')).status).toBe(200);
      expect((await s.get('/posts/find-slot')).status).toBe(200);
    });
  });

  describe('separate saves at the same minute (billing sandbox s0, 1 Nov 2026)', () => {
    it('are separate posts: three saved, the fourth to the same channel and minute is a 402', async () => {
      const { s, orgId } = await newWorkspace();
      const ch = (await addChannel(orgId, 'bluesky')).id;
      const date = day(3);
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await s.post('/posts', body([ch], { date }))).status);
      expect(codes).toEqual([201, 201, 201, 402]);
      expect(await postRows(orgId)).toBe(3);
      expect(await freePosts(s)).toMatchObject({ used: 3, left: 0 });
    });

    it('one save to two channels is still one post', async () => {
      const { s, orgId } = await newWorkspace();
      const a = (await addChannel(orgId, 'bluesky')).id;
      const b = (await addChannel(orgId, 'threads')).id;
      expect((await s.post('/posts', body([a, b]))).status).toBe(201);
      expect(await freePosts(s)).toMatchObject({ used: 1, left: 2 });
    });
  });

  describe('its checkout starts no trial, so the first-month offer attaches', () => {
    // The trial switch off, as in production (trial-switch.int.spec.ts has it on).
    beforeEach(() => {
      process.env.TRIAL_CHECKOUT = 'off';
    });
    afterEach(() => {
      delete process.env.TRIAL_CHECKOUT;
    });

    it('POST /billing/embedded: no start_at on the subscription, the first-month offer on it', async () => {
      const { s } = await newWorkspace();
      const res = await s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY', payWith: 'upi' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ currency: 'INR', startAt: null, firstMonthOffer: 'upi' });
      const sub = rzp.subscriptions.get(res.body.subscriptionId);
      expect(sub.start_at).toBeNull();
      expect(sub.offer_id).toBe(UPI_OFFER);
    });

    it('POST /billing/subscribe: the same, no start_at', async () => {
      const { s } = await newWorkspace();
      const res = await s.post('/billing/subscribe', { billing: 'STANDARD', period: 'MONTHLY' });
      expect(res.status).toBe(201);
      const sub = rzp.subscriptions.get(res.body.subscriptionId);
      expect(sub.start_at).toBeNull();
    });
  });

  describe('who is not on free posts', () => {
    it('a workspace created before the cutoff (grandfathered, no sunset): Free, no allowance, no limit of 3', async () => {
      const { s, orgId } = await newWorkspace();
      await db().organization.update({ where: { id: orgId }, data: { createdAt: new Date('2026-10-01T00:00:00Z') } });
      const self = await s.self();
      expect(self).toMatchObject({ planState: 'free', freePlanAvailable: true, freePosts: null });
      const a = (await addChannel(orgId, 'bluesky')).id;
      for (let n = 1; n <= 4; n++) {
        expect((await s.post('/posts', body([a], { date: day(n) }))).status).toBe(201);
      }
    });

    it('a workspace with a running trial: trialing, unlimited by the free posts', async () => {
      const { s, orgId } = await newWorkspace();
      await givePlan(orgId, 'STANDARD');
      await db().organization.update({ where: { id: orgId }, data: { isTrailing: true } });
      expect(await s.self()).toMatchObject({ planState: 'trialing', freePosts: null });
      const a = (await addChannel(orgId, 'bluesky')).id;
      for (let n = 1; n <= 4; n++) {
        expect((await s.post('/posts', body([a], { date: day(n) }))).status).toBe(201);
      }
    });

    it('a workspace whose trial was used and lost its plan is locked (PLAN_REQUIRED), never given free posts again', async () => {
      const { s, orgId } = await newWorkspace();
      await db().organization.update({ where: { id: orgId }, data: { allowTrial: false } });
      expect(await s.self()).toMatchObject({ planState: 'locked', freePosts: null });
      const a = (await addChannel(orgId, 'bluesky')).id;
      const res = await s.post('/posts', body([a]));
      expect(res.status).toBe(402);
      expect(res.body.code).toBe('PLAN_REQUIRED');
    });

    it('a grandfathered workspace the Free plan sunset reached is needs_trial, not free posts', async () => {
      process.env.TRIAL_REQUIRED_SINCE_IN = '2099-01-01T00:00:00Z';
      process.env.FREE_PLAN_SUNSET_AT = '2026-10-20T00:00:00Z';
      const s = await t.api.register();
      const self = await s.self();
      await db().user.update({ where: { id: self.id }, data: { signupCountry: 'IN' } });
      expect(await s.self()).toMatchObject({ planState: 'needs_trial', freePosts: null });
      const a = (await addChannel(self.orgId, 'bluesky')).id;
      const res = await s.post('/posts', body([a]));
      expect(res.status).toBe(402);
      expect(res.body.code).toBe('TRIAL_REQUIRED');
    });

    it('with no cutoff set nobody is on free posts', async () => {
      const s = await t.api.register();
      expect(await s.self()).toMatchObject({ planState: 'free', freePosts: null });
    });
  });
  // Free posts are given once (trial.policy.ts, 29 Oct 2026): per channel
  // (providerIdentifier + internalId, deleted rows too) and per person (the
  // sign-up's email identity, disposable domains), across workspaces.
  describe('free posts are given once', () => {
    const REUSED = reusedChannelMessage('Instagram');

    /** A workspace that used a free post on the Instagram account `internalId`. */
    async function spentOn(internalId: string) {
      const { s, orgId } = await newWorkspace();
      const ch = await addChannel(orgId, 'instagram-standalone', { internalId });
      expect((await s.post('/posts', body([ch.id], { date: day(1) }))).status).toBe(201);
      return { s, orgId, channelId: ch.id };
    }

    it('the same Instagram account in a second workspace: 402 naming it, nothing saved; another channel still posts', async () => {
      const ig = account('ig');
      await spentOn(ig);
      const { s, orgId } = await newWorkspace();
      const same = (await addChannel(orgId, 'instagram-standalone', { internalId: ig })).id;
      const other = (await addChannel(orgId, 'bluesky')).id;

      for (const channels of [[same], [same, other]]) {
        const refused = await s.post('/posts', body(channels, { date: day(2) }));
        expect(refused.status).toBe(402);
        expect(refused.body).toMatchObject({ code: 'FREE_POSTS_USED', message: REUSED });
      }
      expect(await postRows(orgId)).toBe(0);
      // Its own free posts are untouched: another account posts.
      expect((await s.post('/posts', body([other], { date: day(3) }))).status).toBe(201);
      expect(await freePosts(s)).toEqual({ used: 1, limit: 3, left: 2 });
    });

    /** A second workspace for the same person, on its free posts, selected for `s`. */
    async function secondWorkspaceOf(s: Session, name: string) {
      const self = await s.self();
      const org = await db().organization.create({
        data: {
          name,
          apiKey: `k-${account('org')}`,
          allowTrial: true,
          users: { create: { userId: self.id, role: 'SUPERADMIN' } },
        },
      });
      return { s2: new Session(t.api, s.auth, s.email, s.password, org.id), orgId2: org.id };
    }

    it('your own other workspace still has free posts with this account: it is named, with a switch target (item 11)', async () => {
      const ig = account('ig');
      const first = await spentOn(ig);
      await db().organization.update({ where: { id: first.orgId }, data: { name: 'Chai Studio' } });
      const { s2, orgId2 } = await secondWorkspaceOf(first.s, 'Second Studio');
      const same = (await addChannel(orgId2, 'instagram-standalone', { internalId: ig })).id;
      const refused = await s2.post('/posts', body([same], { date: day(4) }));
      expect(refused.status).toBe(402);
      expect(refused.body).toEqual({
        code: 'FREE_POSTS_USED',
        message: 'Your workspace "Chai Studio" still has 2 free posts with this Instagram account. Switch to it from the workspace menu to use them, or pick a plan to post from here.',
        switchTo: { id: first.orgId, name: 'Chai Studio', left: 2 },
      });
      expect(await postRows(orgId2)).toBe(0);
    });

    it('your own other workspace has no free posts left: the general copy, no workspace named', async () => {
      const ig = account('ig');
      const first = await spentOn(ig);
      for (const d of [5, 6]) {
        expect((await first.s.post('/posts', body([first.channelId], { date: day(d) }))).status).toBe(201);
      }
      const { s2, orgId2 } = await secondWorkspaceOf(first.s, 'Second Studio');
      const same = (await addChannel(orgId2, 'instagram-standalone', { internalId: ig })).id;
      const refused = await s2.post('/posts', body([same], { date: day(7) }));
      expect(refused.body).toEqual({ code: 'FREE_POSTS_USED', message: REUSED });
    });

    it("someone else's workspace is never named, even with free posts left there (privacy)", async () => {
      const ig = account('ig');
      const theirs = await spentOn(ig);
      await db().organization.update({ where: { id: theirs.orgId }, data: { name: 'Their Secret Brand' } });
      const { s, orgId } = await newWorkspace();
      const same = (await addChannel(orgId, 'instagram-standalone', { internalId: ig })).id;
      const refused = await s.post('/posts', body([same]));
      expect(refused.body).toEqual({ code: 'FREE_POSTS_USED', message: REUSED });
      expect(refused.text).not.toContain('Their Secret Brand');
      expect(refused.text).not.toContain(theirs.orgId);
    });

    it('the public API never gets a workspace name either', async () => {
      const ig = account('ig');
      const first = await spentOn(ig);
      const { orgId2 } = await secondWorkspaceOf(first.s, 'Second Studio');
      const same = (await addChannel(orgId2, 'instagram-standalone', { internalId: ig })).id;
      const key = (await db().organization.findUniqueOrThrow({ where: { id: orgId2 } })).apiKey!;
      const res = await t.api.publicApi(key, 'POST', '/posts', body([same], { date: day(4) }));
      expect(JSON.stringify(res.body)).not.toContain('switchTo');
    });

    it('a channel deleted in the first workspace (and the workspace deleted) still counts', async () => {
      const ig = account('ig');
      const first = await spentOn(ig);
      await db().integration.update({ where: { id: first.channelId }, data: { deletedAt: new Date() } });
      await db().organization.update({ where: { id: first.orgId }, data: { deletedAt: new Date() } });
      const { s, orgId } = await newWorkspace();
      const same = (await addChannel(orgId, 'instagram-standalone', { internalId: ig })).id;
      const refused = await s.post('/posts', body([same]));
      expect(refused.status).toBe(402);
      expect(refused.body.message).toBe(REUSED);
    });

    it('a workspace that had a plan (now gone) gives the account no free posts elsewhere', async () => {
      const ig = account('ig');
      const { orgId: paid } = await newWorkspace();
      await addChannel(paid, 'instagram-standalone', { internalId: ig });
      await givePlan(paid);
      await db().organization.update({ where: { id: paid }, data: { allowTrial: false } });
      await db().subscription.delete({ where: { organizationId: paid } });
      const { s, orgId } = await newWorkspace();
      const same = (await addChannel(orgId, 'instagram-standalone', { internalId: ig })).id;
      expect((await s.post('/posts', body([same]))).body).toMatchObject({ code: 'FREE_POSTS_USED', message: REUSED });
    });

    it('connected elsewhere but never used there (no post, no plan): the free posts are still its to use', async () => {
      const ig = account('ig');
      const { orgId: idle } = await newWorkspace();
      await addChannel(idle, 'instagram-standalone', { internalId: ig });
      const { s, orgId } = await newWorkspace();
      const same = (await addChannel(orgId, 'instagram-standalone', { internalId: ig })).id;
      expect((await s.post('/posts', body([same]))).status).toBe(201);
    });

    it('the same id on another provider is another account', async () => {
      const id = account('ig');
      await spentOn(id);
      const { s, orgId } = await newWorkspace();
      const fb = (await addChannel(orgId, 'instagram', { internalId: id })).id;
      expect((await s.post('/posts', body([fb]))).status).toBe(201);
    });

    it('an edit of a post saved before the account was spent elsewhere still saves; a new post does not', async () => {
      const ig = account('ig');
      const { s, orgId } = await newWorkspace();
      const same = (await addChannel(orgId, 'instagram-standalone', { internalId: ig })).id;
      expect((await s.post('/posts', body([same], { date: day(1) }))).status).toBe(201);
      // Then a workspace with a plan connects the same account.
      const { orgId: paid } = await newWorkspace();
      await addChannel(paid, 'instagram-standalone', { internalId: ig });
      await givePlan(paid);
      const row = await db().post.findFirstOrThrow({ where: { organizationId: orgId, deletedAt: null } });
      const edit = await s.post(
        '/posts',
        body([same], { date: day(1), ids: { [same]: { id: row.id, group: row.group } } })
      );
      expect(edit.status).toBe(201);
      expect((await s.post('/posts', body([same], { date: day(2) }))).body.message).toBe(REUSED);
    });

    it('whichever workspace uses the account first keeps it: the other one is refused', async () => {
      const ig = account('ig');
      const a = await newWorkspace();
      const b = await newWorkspace();
      const chA = (await addChannel(a.orgId, 'instagram-standalone', { internalId: ig })).id;
      const chB = (await addChannel(b.orgId, 'instagram-standalone', { internalId: ig })).id;
      expect((await b.s.post('/posts', body([chB]))).status).toBe(201);
      expect((await a.s.post('/posts', body([chA]))).status).toBe(402);
      expect((await b.s.post('/posts', body([chB], { date: day(2) }))).status).toBe(201);
    });

    it('an edit that moves a post from a fresh channel onto a spent one is refused', async () => {
      const ig = account('ig');
      await spentOn(ig);
      const { s, orgId } = await newWorkspace();
      const fresh = (await addChannel(orgId, 'bluesky')).id;
      const spent = (await addChannel(orgId, 'instagram-standalone', { internalId: ig })).id;
      expect((await s.post('/posts', body([fresh], { date: day(1) }))).status).toBe(201);
      const row = await db().post.findFirstOrThrow({ where: { organizationId: orgId, deletedAt: null } });
      const moved = await s.post('/posts', {
        ...body([spent], { date: day(1) }),
        posts: [{ integration: { id: spent }, group: row.group, value: [{ id: row.id, content: 'moved', image: [] }], settings: {} }],
      });
      expect(moved.status).toBe(402);
      expect(moved.body.message).toBe(REUSED);
      expect((await db().post.findUniqueOrThrow({ where: { id: row.id } })).integrationId).toBe(fresh);
    });

    it.each([
      ['deleted_<id>_ (reconnected elsewhere in the workspace)', (id: string) => `deleted_${id}_abc123`],
      ['deleted_<md5>_ (profile erased)', (id: string) => `deleted_${createHash('md5').update(id).digest('hex')}_abc123`],
      ['<md5> (account deleted)', (id: string) => createHash('md5').update(id).digest('hex')],
    ])('a removed channel stored as %s still counts', async (_label, stored) => {
      const ig = account('ig');
      const first = await spentOn(ig);
      await db().integration.update({
        where: { id: first.channelId },
        data: { internalId: stored(ig), deletedAt: new Date() },
      });
      const { s, orgId } = await newWorkspace();
      const same = (await addChannel(orgId, 'instagram-standalone', { internalId: ig })).id;
      expect((await s.post('/posts', body([same]))).body).toMatchObject({ code: 'FREE_POSTS_USED', message: REUSED });
    });

    it('deleting the account and signing up again: the same email starts locked, the same channel is refused', async () => {
      process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
      const email = `fpdel${Date.now().toString(36)}@gmail.com`;
      const s = await t.api.register({ email });
      const { orgId } = await s.self();
      const ig = account('ig');
      const ch = (await addChannel(orgId, 'instagram-standalone', { internalId: ig })).id;
      expect((await s.post('/posts', body([ch]))).status).toBe(201);
      // It went out, so it counts after the account is gone.
      await db().post.updateMany({ where: { organizationId: orgId }, data: { state: 'PUBLISHED' } });
      expect((await s.post('/user/delete-account')).status).toBe(200);
      expect((await db().integration.findUniqueOrThrow({ where: { id: ch } })).internalId).not.toBe(ig);

      const again = await t.api.register({ email });
      const self = await again.self();
      await db().user.update({ where: { id: self.id }, data: { signupCountry: 'IN' } });
      expect(await again.self()).toMatchObject({ planState: 'locked', freePosts: null });

      const other = await newWorkspace();
      const same = (await addChannel(other.orgId, 'instagram-standalone', { internalId: ig })).id;
      expect((await other.s.post('/posts', body([same]))).body.message).toBe(REUSED);
    });

    it('one of our own workspaces (a platform super admin member) is not refused', async () => {
      const ig = account('ig');
      await spentOn(ig);
      const { s, orgId, userId } = await newWorkspace();
      await makeSuperAdmin(userId);
      const same = (await addChannel(orgId, 'instagram-standalone', { internalId: ig })).id;
      expect((await s.post('/posts', body([same]))).status).toBe(201);
    });

    describe('at sign-up', () => {
      /** Registers `email` as a new Indian workspace after the cutoff. */
      async function signUp(email: string) {
        process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
        const s = await t.api.register({ email });
        const self = await s.self();
        await db().user.update({ where: { id: self.id }, data: { signupCountry: 'IN' } });
        return { s, orgId: self.orgId as string };
      }
      const local = () => `fp${Date.now().toString(36)}${accounts++}`;

      it('a Gmail address with dots or a +tag of someone who used free posts starts locked; the sign-up still works', async () => {
        const name = local();
        const first = await signUp(`${name}@gmail.com`);
        const ch = (await addChannel(first.orgId, 'bluesky')).id;
        expect((await first.s.post('/posts', body([ch]))).status).toBe(201);

        const dotted = `${name.slice(0, 2)}.${name.slice(2)}+again@gmail.com`;
        const second = await signUp(dotted);
        expect(await second.s.self()).toMatchObject({ planState: 'locked', freePosts: null });
        expect(
          await db().organization.findUniqueOrThrow({ where: { id: second.orgId }, select: { allowTrial: true } })
        ).toEqual({ allowTrial: false });
        // googlemail.com is the same inbox.
        expect((await (await signUp(`${name}@googlemail.com`)).s.self()).planState).toBe('locked');
      });

      it('a +tag on any domain is the same person when the first workspace had a plan', async () => {
        const name = local();
        const first = await signUp(`${name}@agency-test.io`);
        await db().organization.update({ where: { id: first.orgId }, data: { allowTrial: false } });
        const second = await signUp(`${name}+client@agency-test.io`);
        expect((await second.s.self()).planState).toBe('locked');
      });

      it('someone who signed up but used nothing: the next spelling still gets free posts', async () => {
        const name = local();
        await signUp(`${name}@gmail.com`);
        expect((await (await signUp(`${name}+2@gmail.com`)).s.self()).freePosts).toEqual({ used: 0, limit: 3, left: 3 });
      });

      it('a disposable email domain signs up locked (0 free posts)', async () => {
        const { s } = await signUp(`${local()}@mailinator.com`);
        expect(await s.self()).toMatchObject({ planState: 'locked', freePosts: null });
      });

      it.each(['throwawaymail.com', 'emailondeck.com', 'fakeinbox.com', 'sub.mohmal.com'])(
        'a domain only the vendored open-source list knows (%s) signs up locked too (item 12)',
        async (domain) => {
          const { s } = await signUp(`${local()}@${domain}`);
          expect(await s.self()).toMatchObject({ planState: 'locked', freePosts: null });
        }
      );

      it('an ordinary new address gets its 3 free posts', async () => {
        const { s } = await signUp(`${local()}@gmail.com`);
        expect(await s.self()).toMatchObject({ planState: 'free_posts', freePosts: { left: 3 } });
      });
    });
  });
});
