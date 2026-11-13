/**
 * Plans sold on Gumroad, against the real database and the real backend:
 * POST /billing/gumroad/redeem, the plan state and gates that follow from it,
 * and the daily re-check (GumroadLicenseService.reverifyLicenses).
 *
 * Gumroad is a local HTTP fake (setup/fake.gumroad.ts) answering the two
 * documented calls, so the real client runs and nothing reaches gumroad.com.
 * Razorpay is the in-memory fake every file gets (after-env.ts); these tests
 * also check it is never called for a Gumroad plan.
 */
import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { FakeRazorpay } from './setup/fake.razorpay';
import { resendSendsTo } from './setup/fake.resend';
import { startApp, TestApp } from './setup/app';
import { Session, inviteTokenFrom } from './setup/api';
import { apiKeyOf, db, disconnectDb, givePlan } from './setup/db';
import { FakeGumroad } from './setup/fake.gumroad';
import { GumroadLicenseService } from '@hookpost/nestjs-libraries/database/prisma/gumroad/gumroad.license.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { RazorpayClient } from '@hookpost/nestjs-libraries/services/razorpay.client';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';

const STANDARD = 'int-standard-product==';
const PRO = 'int-pro-product==';
const CUTOFF = '2026-10-19T00:00:00Z';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('Gumroad license keys (real database, Gumroad faked over HTTP)', () => {
  let t: TestApp;
  let gumroad: FakeGumroad;
  let licenses: GumroadLicenseService;
  let subscriptions: SubscriptionService;
  const ENV_KEYS = [
    'GUMROAD_PRODUCT_STANDARD',
    'GUMROAD_PRODUCT_PRO',
    'GUMROAD_ACCESS_TOKEN',
    'TRIAL_REQUIRED_SINCE_IN',
    'FREE_PLAN_SUNSET_AT',
  ] as const;
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  beforeAll(async () => {
    gumroad = await new FakeGumroad().install();
    process.env.GUMROAD_PRODUCT_STANDARD = STANDARD;
    process.env.GUMROAD_PRODUCT_PRO = PRO;
    process.env.GUMROAD_ACCESS_TOKEN = gumroad.token;
    t = await startApp();
    licenses = t.get<GumroadLicenseService>(GumroadLicenseService);
    subscriptions = t.get<SubscriptionService>(SubscriptionService);
  });
  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await t?.close();
    await gumroad?.uninstall();
    await disconnectDb();
  });
  afterEach(() => {
    gumroad.down = false;
    process.env.TRIAL_REQUIRED_SINCE_IN = '';
    process.env.FREE_PLAN_SUNSET_AT = '';
    jest.restoreAllMocks();
  });

  async function workspace(company: string) {
    const session = await t.api.register({ company });
    const { id: userId, orgId } = await session.self();
    return { session, userId, orgId };
  }

  const redeem = (session: Session, licenseKey: string) =>
    session.post('/billing/gumroad/redeem', { licenseKey });

  const planRow = (organizationId: string) =>
    db().subscription.findUnique({ where: { organizationId } });

  const licenseRow = (key: string) =>
    db().gumroadLicense.findUnique({ where: { licenseKeyHash: sha256(key) } });

  /** A workspace that has redeemed a fresh Pro (or Standard) membership. */
  async function redeemed(company: string, opts: { productId?: string; recurrence?: string } = {}) {
    const ws = await workspace(company);
    const license = gumroad.addLicense({ productId: opts.productId || PRO, recurrence: opts.recurrence });
    const res = await redeem(ws.session, license.key);
    expect(res.status).toBe(201);
    return { ...ws, license };
  }

  describe('redeem', () => {
    it('from the paywall: a grandfathered Indian workspace the Free plan sunset reached (needs_trial) gets the Pro plan, active, with API access', async () => {
      // Created now, before this future cutoff, with the sunset passed: the
      // paywall. A sign-up after a cutoff is free_posts, with no paywall.
      process.env.TRIAL_REQUIRED_SINCE_IN = '2099-01-01T00:00:00Z';
      process.env.FREE_PLAN_SUNSET_AT = '2026-10-20T00:00:00Z';
      const { session, userId, orgId } = await workspace('Gumroad Paywall Co');
      await db().user.update({ where: { id: userId }, data: { signupCountry: 'IN' } });
      const before = await session.self();
      // Behind the paywall: it may only start its trial or choose a plan.
      expect(before.planState).toBe('needs_trial');
      expect(before.gumroadRedeem).toBe(true);
      const key = await apiKeyOf(orgId);
      expect((await t.api.publicApi(key, 'GET', '/integrations')).status).toBe(401);

      const license = gumroad.addLicense({ productId: PRO });
      // Pasted in lower case with a stray line break: still the key.
      const res = await redeem(session, `${license.key.toLowerCase()}\n`);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        ok: true,
        tier: 'PRO',
        period: 'MONTHLY',
        status: 'ACTIVE',
        cancelAt: null,
      });

      const after = await session.self();
      expect(after).toMatchObject({ planState: 'active', tier: 'PRO', isTrailing: false, allowTrial: false });
      expect(after.publicApi).toBeTruthy();
      expect((await t.api.publicApi(key, 'GET', '/integrations')).status).toBe(200);

      expect(await planRow(orgId)).toMatchObject({
        subscriptionTier: 'PRO',
        period: 'MONTHLY',
        totalChannels: pricing.PRO.channel,
        identifier: `gumroad:${license.purchase.sale_id}`,
        isLifetime: false,
        cancelAt: null,
        deletedAt: null,
      });
      const row = await licenseRow(license.key);
      expect(row).toMatchObject({
        organizationId: orgId,
        productId: PRO,
        saleId: license.purchase.sale_id,
        tier: 'PRO',
        period: 'MONTHLY',
        status: 'ACTIVE',
      });
      // Only the hash: the key is in no column.
      expect(JSON.stringify(row)).not.toContain(license.key);

      // Standard was asked first (404), then Pro; one use counted, on the bind.
      expect(
        gumroad.verifyCalls(license.key).map((c) => [c.form?.product_id, c.form?.increment_uses_count])
      ).toEqual([
        [STANDARD, 'false'],
        [PRO, 'false'],
        [PRO, 'true'],
      ]);
      expect(license.uses).toBe(1);
    });

    it('a yearly Standard membership is Standard YEARLY with its channel limit', async () => {
      const { orgId } = await redeemed('Gumroad Yearly Co', { productId: STANDARD, recurrence: 'yearly' });
      expect(await planRow(orgId)).toMatchObject({
        subscriptionTier: 'STANDARD',
        period: 'YEARLY',
        totalChannels: pricing.STANDARD.channel,
      });
    });

    it('the same key on a second workspace: 409 LICENSE_IN_USE, and the first keeps its plan', async () => {
      const first = await redeemed('Gumroad First Co');
      const second = await workspace('Gumroad Second Co');
      const callsBefore = gumroad.calls.length;

      const res = await redeem(second.session, first.license.key);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'LICENSE_IN_USE' });
      // Refused from the database; Gumroad was not asked.
      expect(gumroad.calls.length).toBe(callsBefore);

      expect(await planRow(second.orgId)).toBeNull();
      expect((await second.session.self()).tier).toBe('FREE');
      expect((await licenseRow(first.license.key))?.organizationId).toBe(first.orgId);
      expect((await first.session.self()).planState).toBe('active');
    });

    it('the workspace that holds the key may enter it again: refreshed, no second use counted', async () => {
      const { session, license, orgId } = await redeemed('Gumroad Again Co');
      const res = await redeem(session, license.key);
      expect(res.status).toBe(201);
      expect(license.uses).toBe(1);
      expect(await db().gumroadLicense.count({ where: { organizationId: orgId } })).toBe(1);
    });

    it('a workspace on a Razorpay plan: 409 PLAN_ON_FILE, Gumroad and Razorpay both untouched', async () => {
      const { session, orgId } = await workspace('Gumroad Razorpay Co');
      await givePlan(orgId, 'STANDARD');
      const license = gumroad.addLicense({ productId: PRO });
      const razorpay = jest.spyOn(RazorpayClient.prototype, 'request');

      const res = await redeem(session, license.key);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'PLAN_ON_FILE' });
      expect(gumroad.verifyCalls(license.key)).toHaveLength(0);
      expect(razorpay).not.toHaveBeenCalled();
      expect((await planRow(orgId))?.identifier).toMatch(/^sub_/);
    });

    it.each([
      ['a one-time purchase', 'NOT_A_SUBSCRIPTION', 400, { recurrence: null }],
      ['a refunded purchase', 'REFUNDED', 400, { purchase: { refunded: true } }],
      [
        'a membership that has ended',
        'CANCELLED',
        400,
        { purchase: { subscription_ended_at: new Date(Date.now() - DAY).toISOString() } },
      ],
    ])('%s is refused with %s (%s) and nothing is written', async (_label, code, status, opts: any) => {
      const { session, orgId } = await workspace(`Gumroad Refused ${code}`);
      const license = gumroad.addLicense({ productId: PRO, ...opts });
      const res = await redeem(session, license.key);
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ code });
      expect(await planRow(orgId)).toBeNull();
      expect(await licenseRow(license.key)).toBeNull();
      expect(license.uses).toBe(0);
    });

    it('an unknown key: 400 INVALID_KEY; Gumroad down: 503 GUMROAD_UNAVAILABLE', async () => {
      const { session, orgId } = await workspace('Gumroad Unknown Co');
      const unknown = await redeem(session, 'ABCDEF12-ABCDEF12-ABCDEF12-ABCDEF12');
      expect(unknown.status).toBe(400);
      expect(unknown.body).toMatchObject({ code: 'INVALID_KEY' });

      gumroad.down = true;
      const license = gumroad.addLicense({ productId: PRO });
      const down = await redeem(session, license.key);
      expect(down.status).toBe(503);
      expect(down.body).toMatchObject({ code: 'GUMROAD_UNAVAILABLE' });
      expect(await planRow(orgId)).toBeNull();
    });

    it('a member who is not an owner or admin cannot redeem', async () => {
      const { session: owner, orgId } = await redeemed('Gumroad Team Co');
      const invite = await owner.post('/settings/team', { role: 'USER', sendEmail: false });
      const member = await t.api.register({
        cookies: { org: inviteTokenFrom(invite.body.url) },
      });
      const license = gumroad.addLicense({ productId: STANDARD });
      const res = await redeem(member, license.key);
      expect(res.status).toBe(402);
      expect(gumroad.verifyCalls(license.key)).toHaveLength(0);
      expect((await planRow(orgId))?.subscriptionTier).toBe('PRO');
    });

    it.each([
      ['no product is configured', { GUMROAD_PRODUCT_STANDARD: '', GUMROAD_PRODUCT_PRO: '' }],
      ['the access token for the re-check is missing', { GUMROAD_ACCESS_TOKEN: '' }],
    ])('off while %s: 404 GUMROAD_OFF and no field', async (_label, env: Record<string, string>) => {
      const before = { ...process.env };
      Object.assign(process.env, env);
      try {
        const { session } = await workspace('Gumroad Off Co');
        expect((await session.self()).gumroadRedeem).toBe(false);
        const license = gumroad.addLicense({ productId: PRO });
        const res = await redeem(session, license.key);
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ code: 'GUMROAD_OFF' });
        expect(gumroad.verifyCalls(license.key)).toHaveLength(0);
      } finally {
        for (const key of Object.keys(env)) process.env[key] = before[key];
      }
    });

    it('a Razorpay plan already set to end still blocks it (it may be a halted renewal that can be paid)', async () => {
      const { session, orgId } = await workspace('Gumroad Ending Razorpay Co');
      await givePlan(orgId, 'STANDARD');
      await db().subscription.update({
        where: { organizationId: orgId },
        data: { cancelAt: new Date(Date.now() + 5 * DAY) },
      });
      const license = gumroad.addLicense({ productId: PRO });
      const res = await redeem(session, license.key);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'PLAN_ON_FILE' });
      expect((await planRow(orgId))?.identifier).toMatch(/^sub_/);
    });

    it('two keys redeemed at once on one workspace: one wins, the other is told to wait, and the plan stays on a license the re-check sees', async () => {
      const { session, orgId } = await workspace('Gumroad Race Co');
      const pro = gumroad.addLicense({ productId: PRO });
      const standard = gumroad.addLicense({ productId: STANDARD });
      gumroad.delayMs = 300;
      let results!: Awaited<ReturnType<typeof redeem>>[];
      try {
        results = await Promise.all([redeem(session, pro.key), redeem(session, standard.key)]);
      } finally {
        gumroad.delayMs = 0;
      }
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)?.body).toMatchObject({ code: 'REDEEM_IN_PROGRESS' });
      const [winner, loser] = results[0].status === 201 ? [pro, standard] : [standard, pro];

      expect((await planRow(orgId))?.identifier).toBe(`gumroad:${winner.purchase.sale_id}`);
      const rows = await db().gumroadLicense.findMany({ where: { organizationId: orgId } });
      expect(rows.map((r) => [r.saleId, r.status])).toEqual([[winner.purchase.sale_id, 'ACTIVE']]);

      // The other key, entered again once the first is done, replaces it.
      expect((await redeem(session, loser.key)).status).toBe(201);
      expect((await planRow(orgId))?.identifier).toBe(`gumroad:${loser.purchase.sale_id}`);
      expect((await licenseRow(winner.key))?.status).toBe('REPLACED');
      expect((await licenseRow(loser.key))?.status).toBe('ACTIVE');

      // The plan's license is re-checked: a refund of it ends the plan.
      loser.purchase.refunded = true;
      await licenses.reverifyLicenses(new Date(Date.now() + DAY + HOUR));
      expect(await planRow(orgId)).toBeNull();
      expect((await licenseRow(loser.key))?.status).toBe('REFUNDED');
    });

    it('a Razorpay plan that activates while Gumroad is being asked: 409 PLAN_ON_FILE, and nothing is bound', async () => {
      const { session, orgId } = await workspace('Gumroad Midflight Razorpay Co');
      const license = gumroad.addLicense({ productId: PRO });
      // Standard is asked first (404), then Pro: 600 ms in all. The Razorpay
      // plan lands 150 ms in.
      gumroad.delayMs = 300;
      let res!: Awaited<ReturnType<typeof redeem>>;
      try {
        [res] = await Promise.all([
          redeem(session, license.key),
          new Promise((r) => setTimeout(r, 150)).then(() => givePlan(orgId, 'STANDARD')),
        ]);
      } finally {
        gumroad.delayMs = 0;
      }
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'PLAN_ON_FILE' });
      expect((await planRow(orgId))?.identifier).toMatch(/^sub_/);
      expect(await licenseRow(license.key)).toBeNull();
      expect(license.uses).toBe(0);
    });

    it('checkout is refused on a Gumroad-paid workspace before Razorpay is asked', async () => {
      const { session } = await redeemed('Gumroad Checkout Co');
      const razorpay = jest.spyOn(RazorpayClient.prototype, 'request');
      const res = await session.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'GUMROAD_PLAN' });
      const cancel = await session.post('/billing/cancel', { feedback: 'checking the gumroad guard' });
      expect(cancel.status).toBe(400);
      expect(razorpay).not.toHaveBeenCalled();
    });
  });

  describe('the X and AI gates', () => {
    const postCredits = (organizationId: string) =>
      db().credits.count({ where: { organizationId, type: 'posts' } });

    it.each([
      ['both trial cutoffs empty', ''],
      ['TRIAL_REQUIRED_SINCE_IN set, an Indian workspace', CUTOFF],
    ])('%s: a Gumroad-paid workspace publishes to X unmetered and has its AI credits', async (_label, cutoff) => {
      process.env.TRIAL_REQUIRED_SINCE_IN = cutoff;
      const { session, orgId, userId } = await workspace(`Gumroad Gates ${cutoff || 'none'}`);
      await db().user.update({ where: { id: userId }, data: { signupCountry: 'IN' } });
      const license = gumroad.addLicense({ productId: PRO });
      expect((await redeem(session, license.key)).status).toBe(201);

      expect(await subscriptions.allowsXPublishing(orgId)).toBe(true);
      const before = await postCredits(orgId);
      const publish = jest.fn(async () => 'posted');
      await expect(subscriptions.publishWithinPlan(orgId, publish, 'x')).resolves.toBe('posted');
      expect(publish).toHaveBeenCalledTimes(1);
      expect(await postCredits(orgId)).toBe(before);

      const org = await db().organization.findUniqueOrThrow({
        where: { id: orgId },
        include: { subscription: true },
      });
      expect(await subscriptions.checkCredits(org as any, 'ai_text')).toEqual({
        credits: pricing.PRO.ai_generation_count,
      });
      expect(await subscriptions.checkCredits(org as any, 'ai_images')).toEqual({
        credits: pricing.PRO.image_generation_count,
      });

      // Connecting X: allowed (only X's request-token call is replaced).
      const x = t.get<IntegrationManager>(IntegrationManager).getSocialIntegration('x');
      const authUrl = jest.spyOn(x, 'generateAuthUrl').mockResolvedValue({
        url: 'https://api.x.com/oauth/authenticate?oauth_token=gumroad-int',
        codeVerifier: 'int-token:int-secret',
        state: `gumroad-x-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      const connect = await session.get('/integrations/social/x');
      expect(connect.status).toBe(200);
      expect(authUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe('the daily re-check', () => {
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs);
    const recheck = (now: Date) => licenses.reverifyLicenses(now);

    it('nothing is due within a day of the last check', async () => {
      const { license } = await redeemed('Gumroad Fresh Co');
      const reads = gumroad.calls.filter((c) => c.path.startsWith('/sales/')).length;
      await recheck(at(HOUR));
      expect(gumroad.calls.filter((c) => c.path.startsWith('/sales/')).length).toBe(reads);
      expect((await licenseRow(license.key))?.status).toBe('ACTIVE');
    });

    it('a refunded key is caught on re-verify: the plan ends as an ended plan does', async () => {
      const { license, orgId, session } = await redeemed('Gumroad Refund Co');
      license.purchase.refunded = true;

      await recheck(at(DAY + HOUR));

      expect(await planRow(orgId)).toBeNull();
      expect((await licenseRow(license.key))?.status).toBe('REFUNDED');
      const self = await session.self();
      expect(self.tier).toBe('FREE');
      expect(self.planState).toBe('free');
      // The sale was read back with the token, then the key verified without a use.
      const read = gumroad.calls.find((c) => c.path === `/sales/${encodeURIComponent(license.purchase.sale_id)}`);
      expect(read?.auth).toBe(`Bearer ${gumroad.token}`);
      expect(license.uses).toBe(1);
    });

    // The owner, 29 Oct 2026: paid time is kept in full, X and AI included.
    it('cancelled with paid time left: cancelling (X and LinkedIn on) until the date, then ended', async () => {
      const { license, orgId } = await redeemed('Gumroad Cancel Co');
      const endsAt = at(3 * DAY);
      license.purchase.subscription_cancelled_at = endsAt.toISOString();

      await recheck(at(DAY + HOUR));
      const plan = await planRow(orgId);
      expect(plan?.cancelAt?.toISOString()).toBe(endsAt.toISOString());
      expect((await licenseRow(license.key))?.status).toBe('CANCELLING');
      expect((await subscriptions.getPlanState(orgId)).state).toBe('cancelling');
      await expect(
        subscriptions.publishWithinPlan(orgId, async () => 'posted', 'x')
      ).resolves.toBe('posted');
      await expect(
        subscriptions.publishWithinPlan(orgId, async () => 'posted', 'linkedin')
      ).resolves.toBe('posted');
      expect(await subscriptions.allowsVariableCostFeatures(orgId)).toBe(true);

      // The date passes: due again at once, and the plan ends.
      await recheck(new Date(endsAt.getTime() + HOUR));
      expect(await planRow(orgId)).toBeNull();
      expect((await licenseRow(license.key))?.status).toBe('CANCELLED');
    });

    it('a cancellation undone on Gumroad (renewed or restarted) lifts the end date', async () => {
      const { license, orgId } = await redeemed('Gumroad Restart Co');
      license.purchase.subscription_cancelled_at = at(5 * DAY).toISOString();
      await recheck(at(DAY + HOUR));
      expect((await planRow(orgId))?.cancelAt).not.toBeNull();

      license.purchase.subscription_cancelled_at = null;
      await recheck(at(2 * DAY + 2 * HOUR));
      expect((await planRow(orgId))?.cancelAt).toBeNull();
      expect((await licenseRow(license.key))?.status).toBe('ACTIVE');
      expect((await subscriptions.getPlanState(orgId)).state).toBe('active');
    });

    it('a failed renewal ends the plan; Gumroad down changes nothing', async () => {
      const failed = await redeemed('Gumroad Failed Co');
      const steady = await redeemed('Gumroad Steady Co');
      failed.license.purchase.subscription_failed_at = new Date().toISOString();

      gumroad.down = true;
      await recheck(at(DAY + HOUR));
      expect(await planRow(failed.orgId)).not.toBeNull();
      expect((await licenseRow(failed.license.key))?.status).toBe('ACTIVE');

      gumroad.down = false;
      await recheck(at(DAY + 2 * HOUR));
      expect(await planRow(failed.orgId)).toBeNull();
      expect((await licenseRow(failed.license.key))?.status).toBe('FAILED');
      expect(await planRow(steady.orgId)).not.toBeNull();
      expect((await licenseRow(steady.license.key))?.status).toBe('ACTIVE');
    });

    it('a revoked token: one error line for the run, with the count; a plan past its end date still ends', async () => {
      const { license, orgId } = await redeemed('Gumroad Lapsed Co');
      const endsAt = at(2 * DAY);
      license.purchase.subscription_cancelled_at = endsAt.toISOString();
      await recheck(at(DAY + HOUR));
      expect((await planRow(orgId))?.cancelAt?.toISOString()).toBe(endsAt.toISOString());

      const token = gumroad.token;
      gumroad.token = 'rotated-at-gumroad';
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      let result!: Awaited<ReturnType<typeof recheck>>;
      try {
        result = await recheck(new Date(endsAt.getTime() + HOUR));
      } finally {
        gumroad.token = token;
      }
      expect(result.authFailures).toBeGreaterThanOrEqual(1);
      const tokenLines = error.mock.calls.filter(([m]) => String(m).includes('GUMROAD_ACCESS_TOKEN'));
      expect(tokenLines).toHaveLength(1);
      expect(String(tokenLines[0][0])).toContain(`for ${result.authFailures} of ${result.checked} sales`);
      expect(await planRow(orgId)).toBeNull();
      expect((await licenseRow(license.key))?.status).toBe('CANCELLED');
    });

    it('a plan left on a license marked REPLACED is still re-checked, and a refund of it ends the plan', async () => {
      const { license, orgId } = await redeemed('Gumroad Orphan Co');
      await db().gumroadLicense.update({
        where: { licenseKeyHash: sha256(license.key) },
        data: { status: 'REPLACED' },
      });
      license.purchase.refunded = true;
      await recheck(at(DAY + HOUR));
      expect(await planRow(orgId)).toBeNull();
      expect((await licenseRow(license.key))?.status).toBe('REFUNDED');
    });

    // The round-2 reviewer's probe: the seller rotates the key of a sale and
    // the buyer redeems the new key on the same workspace. The old license
    // keeps the same sale, so the redeem leaves it live; its re-check finds
    // the sale on another key and used to call it REVOKED and end the plan
    // the new key pays for.
    it('a key rotated at Gumroad and redeemed again on the same workspace: the old license is REPLACED, the plan stays', async () => {
      const { session, orgId } = await workspace('Gumroad Rotate Co');
      const lic = gumroad.addLicense({ productId: PRO });
      const k1 = lic.key;
      expect((await redeem(session, k1)).status).toBe(201);

      const k2 = 'ABCDEF12-ABCDEF12-ABCDEF12-ROTATED1';
      lic.key = k2;
      lic.purchase.license_key = k2;
      expect((await redeem(session, k2)).status).toBe(201);
      expect((await planRow(orgId))?.identifier).toBe(`gumroad:${lic.purchase.sale_id}`);

      const run = await recheck(at(DAY + HOUR));
      expect(run.skipped).toBeUndefined();
      const plan = await planRow(orgId);
      expect(plan).not.toBeNull();
      expect(plan?.deletedAt ?? null).toBeNull();
      expect(plan?.identifier).toBe(`gumroad:${lic.purchase.sale_id}`);
      expect((await licenseRow(k1))?.status).toBe('REPLACED');
      expect((await licenseRow(k2))?.status).toBe('ACTIVE');
      expect((await subscriptions.getPlanState(orgId)).state).toBe('active');

      // The old license is covered by the new one: not re-read again, and a
      // refund of the sale is still caught, through the new key.
      const salePath = `/sales/${encodeURIComponent(lic.purchase.sale_id)}`;
      const salesReads = () => gumroad.calls.filter((c) => c.path === salePath).length;
      lic.purchase.refunded = true;
      const before = salesReads();
      await recheck(at(2 * DAY + 2 * HOUR));
      expect(salesReads() - before).toBe(1);
      expect(await planRow(orgId)).toBeNull();
      expect((await licenseRow(k2))?.status).toBe('REFUNDED');
      expect((await licenseRow(k1))?.status).toBe('REPLACED');
    });

    it('ending a plan deletes only the plan with that identifier: one written meanwhile stays', async () => {
      const { license, orgId } = await redeemed('Gumroad Fresh Plan Co');
      const identifier = `gumroad:${license.purchase.sale_id}`;
      // Another plan replaced it after the re-check read it.
      await db().subscription.update({
        where: { organizationId: orgId },
        data: { identifier: 'gumroad:a-plan-written-meanwhile' },
      });
      await expect(subscriptions.endPlanByIdentifier(orgId, identifier)).resolves.toBe(false);
      expect((await planRow(orgId))?.identifier).toBe('gumroad:a-plan-written-meanwhile');
      // Its own plan: ended.
      await expect(
        subscriptions.endPlanByIdentifier(orgId, 'gumroad:a-plan-written-meanwhile')
      ).resolves.toBe(true);
      expect(await planRow(orgId)).toBeNull();
    });

    it('250 old REPLACED licenses never fill the batch (200): a due live license is still re-checked', async () => {
      // A workspace whose key was rotated many times: its plan's sale is held
      // by a live license, and 250 old REPLACED ones carry the same sale,
      // unverified for a month, so they would sort first.
      const rotated = await redeemed('Gumroad Many Rotations Co');
      await db().gumroadLicense.createMany({
        data: Array.from({ length: 250 }, (_, i) => ({
          organizationId: rotated.orgId,
          productId: PRO,
          licenseKeyHash: sha256(`old-rotated-key-${rotated.orgId}-${i}`),
          saleId: rotated.license.purchase.sale_id,
          tier: 'PRO' as const,
          period: 'MONTHLY' as const,
          status: 'REPLACED',
          lastVerifiedAt: new Date(Date.now() - 30 * DAY),
        })),
      });
      // Another workspace's license: due (checked two days ago), and refunded.
      const due = await redeemed('Gumroad Starved Co');
      due.license.purchase.refunded = true;
      await db().gumroadLicense.update({
        where: { licenseKeyHash: sha256(due.license.key) },
        data: { lastVerifiedAt: new Date(Date.now() - 2 * DAY) },
      });

      const run = await recheck(new Date());
      expect(run.checked).toBeGreaterThanOrEqual(1);
      expect(run.checked).toBeLessThan(250);
      expect(await planRow(due.orgId)).toBeNull();
      expect((await licenseRow(due.license.key))?.status).toBe('REFUNDED');
      // The old ones were not read, and the rotated workspace keeps its plan.
      expect(
        await db().gumroadLicense.count({
          where: { organizationId: rotated.orgId, status: 'REPLACED' },
        })
      ).toBe(250);
      expect(await planRow(rotated.orgId)).not.toBeNull();
    });

    it('two runs at once (the backend and the orchestrator): one does the work, the other skips', async () => {
      const { license, orgId } = await redeemed('Gumroad Two Runs Co');
      license.purchase.refunded = true;
      gumroad.delayMs = 200;
      let runs!: Awaited<ReturnType<typeof recheck>>[];
      try {
        runs = await Promise.all([recheck(at(DAY + HOUR)), recheck(at(DAY + HOUR))]);
      } finally {
        gumroad.delayMs = 0;
      }
      expect(runs.filter((r) => r.skipped)).toHaveLength(1);
      expect(await planRow(orgId)).toBeNull();
      expect((await licenseRow(license.key))?.status).toBe('REFUNDED');
    });

    it('a workspace that moved to a Razorpay plan is left alone, even when the Gumroad sale is refunded', async () => {
      const { license, orgId } = await redeemed('Gumroad Moved Co');
      await db().subscription.update({
        where: { organizationId: orgId },
        data: { identifier: `sub_moved_${orgId.slice(0, 8)}`, subscriptionTier: 'STANDARD' },
      });
      license.purchase.refunded = true;
      const razorpay = jest.spyOn(RazorpayClient.prototype, 'request');

      await recheck(at(DAY + HOUR));
      expect(await planRow(orgId)).toMatchObject({ subscriptionTier: 'STANDARD', deletedAt: null });
      expect((await licenseRow(license.key))?.status).toBe('DETACHED');
      expect(razorpay).not.toHaveBeenCalled();
    });
  });

  describe('a Razorpay checkout opened before the key was redeemed, and paid after', () => {
    let rzp: FakeRazorpay;
    beforeAll(() => {
      rzp = new FakeRazorpay().install();
    });
    afterAll(() => rzp.uninstall());

    const postWebhook = (event: string, entities: Record<string, any>) => {
      const signed = FakeRazorpay.signedEvent(event, entities, process.env.RAZORPAY_WEBHOOK_SECRET!);
      return t.api.request('POST', '/razorpay/webhook', {
        raw: signed.raw,
        headers: { 'content-type': 'application/json', 'x-razorpay-signature': signed.signature },
      });
    };

    it('the paid Razorpay plan takes over, logged as an error, and the support inbox is told once', async () => {
      const { session, orgId } = await workspace('Gumroad Then Razorpay Co');
      const opened = await session.post('/billing/subscribe', { billing: 'STANDARD', period: 'MONTHLY' });
      expect(opened.status).toBe(201);
      const license = gumroad.addLicense({ productId: PRO });
      expect((await redeem(session, license.key)).status).toBe(201);
      expect((await planRow(orgId))?.identifier).toBe(`gumroad:${license.purchase.sale_id}`);

      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const sub = rzp.authorise(opened.body.subscriptionId);
      expect((await postWebhook('subscription.activated', { subscription: sub })).status).toBe(201);
      // Razorpay was paid, so its plan is the workspace's now.
      expect(await planRow(orgId)).toMatchObject({ identifier: sub.id, subscriptionTier: 'STANDARD' });

      // To the support inbox, through Resend (recorded by fake.resend.ts).
      const alerts = () =>
        resendSendsTo(process.env.EMAIL_FROM_ADDRESS!).filter((m) =>
          String(m.subject).startsWith('Paying twice?') && String(m.text).includes(orgId)
        );
      expect(alerts()).toHaveLength(1);
      expect(String(alerts()[0].text)).toContain(license.purchase.sale_id);
      expect(String(alerts()[0].html)).toContain('Needs a look');
      expect(
        error.mock.calls.filter(([m]) => String(m).includes(`replaced org ${orgId}'s plan paid on Gumroad`))
      ).toHaveLength(1);

      // A redelivery or the next event for the same subscription: no second alert.
      await postWebhook('subscription.activated', { subscription: sub });
      await postWebhook('subscription.charged', { subscription: sub, payment: rzp.charge(sub.id) });
      expect(alerts()).toHaveLength(1);
    });
  });
});
