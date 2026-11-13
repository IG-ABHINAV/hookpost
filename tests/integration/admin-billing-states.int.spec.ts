/**
 * GET /admin/users: one billing state per workspace (billing.state.ts) for
 * the Users & Billing page, against the real backend, Postgres and an
 * in-memory Razorpay account. Every state the page has a badge for, the
 * counts behind its chips, the Users/Workspaces breakdown (api.market
 * workspaces and ones whose users were deleted), FREE_PLAN_SUNSET_AT passing
 * with no restart, and Razorpay failing.
 *
 * The database is shared with the other files of a run, so counts are
 * checked as identities (the chip count is the rows the chip shows) and the
 * states by workspace id.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb, givePlan, makeSuperAdmin } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

describe('admin: billing states on GET /admin/users', () => {
  let t: TestApp;
  let admin: Session;
  const rzp = new FakeRazorpay();
  const ENV = { ...process.env };
  const orgs: Record<string, string> = {};

  // A plan on the fake account and a subscription on it, linked to the
  // workspace's Subscription row as the webhook would leave it.
  const plan = (amount: number, currency = 'INR') => {
    const id = `plan_int${amount}${currency}`;
    rzp.plans.set(id, { id, entity: 'plan', period: 'monthly', item: { amount, currency } });
    return id;
  };
  const linkSubscription = async (orgId: string, fields: Record<string, any>, row: Record<string, any> = {}) => {
    const id = `sub_int${Math.random().toString(36).slice(2, 12)}`;
    rzp.subscriptions.set(id, {
      id,
      entity: 'subscription',
      status: 'active',
      paid_count: 1,
      start_at: null,
      charge_at: null,
      current_end: null,
      notes: { service: 'hookpost', orgId },
      created_at: now(),
      ...fields,
    });
    await givePlan(orgId, 'STANDARD');
    await db().subscription.update({ where: { organizationId: orgId }, data: { identifier: id, ...row } });
    return id;
  };
  const customer = async (key: string, country = 'IN', createdAt?: Date) => {
    const s = await t.api.register({ company: `Billing ${key}` });
    const self = await s.self();
    await db().user.update({ where: { id: self.id }, data: { signupCountry: country } });
    if (createdAt) await db().organization.update({ where: { id: self.orgId }, data: { createdAt } });
    orgs[key] = self.orgId;
    return { session: s, ...self };
  };
  const list = async (query = '') => {
    const res = await admin.get(`/admin/users${query}`);
    expect(res.status).toBe(200);
    return res.body;
  };
  const billingOf = (body: any, orgId: string) =>
    body.users
      .flatMap((u: any) => u.organizations)
      .find((o: any) => o.organization.id === orgId)?.organization.billing;

  beforeAll(async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '2026-10-19T00:00:00Z';
    process.env.FREE_PLAN_SUNSET_AT = '2099-10-27T18:29:59Z';
    t = await startApp();
    rzp.install();
    admin = await t.api.register({ company: 'Billing HQ' });
    await makeSuperAdmin((await admin.self()).id);

    const inr599 = plan(59900);
    const inr699 = plan(69900);
    const usd19 = plan(1900, 'USD');
    const old = new Date('2026-09-01T00:00:00Z');

    const paying = await customer('paying');
    await linkSubscription(paying.orgId, { plan_id: inr699, paid_count: 2, charge_at: now() + 10 * DAY, current_end: now() + 10 * DAY });
    await db().organization.update({ where: { id: paying.orgId }, data: { isTrailing: false } });

    const trial = await customer('trial');
    await linkSubscription(trial.orgId, { plan_id: inr599, status: 'authenticated', paid_count: 0, start_at: now() + 3 * DAY, charge_at: now() + 3 * DAY });

    const usd = await customer('usd', 'US');
    await linkSubscription(usd.orgId, { plan_id: usd19, status: 'authenticated', paid_count: 0, start_at: now() + 3 * DAY, charge_at: now() + 3 * DAY });

    const cancelled = await customer('cancelled');
    await linkSubscription(
      cancelled.orgId,
      { plan_id: inr599, status: 'cancelled', paid_count: 0 },
      { cancelAt: new Date(Date.now() + 5 * DAY * 1000) }
    );

    const failed = await customer('failed');
    await linkSubscription(failed.orgId, { plan_id: inr699, status: 'halted', paid_count: 3 });
    await db().organization.update({ where: { id: failed.orgId }, data: { isTrailing: false } });

    const lifetime = await customer('lifetime');
    await givePlan(lifetime.orgId, 'TEAM');
    await db().subscription.update({ where: { organizationId: lifetime.orgId }, data: { isLifetime: true, identifier: 'sub_admin_lifetime' } });

    await customer('free', 'IN', old);
    await customer('exempt', 'IN', old);
    process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = orgs.exempt;
    const used = await customer('used', 'IN', old);
    await db().organization.update({ where: { id: used.orgId }, data: { allowTrial: false, isTrailing: false } });
    await customer('new');

    // A user in two workspaces: their own (free posts) and the paying one.
    const multi = await customer('multi');
    await db().userOrganization.create({ data: { userId: multi.id, organizationId: paying.orgId, role: 'USER' } });

    // A deleted user, and their workspace: neither is counted.
    const gone = await customer('gone');
    await db().user.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    // api.market: a workspace with a plan row and no users, by design.
    const mkt = await db().organization.create({ data: { name: 'api.market subscriber int' } });
    orgs.mkt = mkt.id;
    await db().marketplaceAccount.create({
      data: { externalUserId: `int-${Date.now()}`, product: 'social', plan: 'trial', organizationId: mkt.id },
    });
    await db().subscription.create({
      data: { organizationId: mkt.id, subscriptionTier: 'STANDARD', period: 'MONTHLY', totalChannels: 5, identifier: `apimkt:social:${mkt.id}` },
    });
    // A workspace whose only member was deleted (its org row was left live).
    const orphanUser = await customer('orphan');
    await db().user.update({ where: { id: orphanUser.id }, data: { deletedAt: new Date() } });
  });

  afterAll(async () => {
    rzp.uninstall();
    process.env = { ...ENV };
    await t?.close();
    await disconnectDb();
  });

  it('labels every workspace with one state and the date that matters', async () => {
    const body = await list();
    const b = (k: string) => billingOf(body, orgs[k]);
    expect(b('paying')).toMatchObject({ state: 'paying', planState: 'active' });
    expect(b('paying').label).toMatch(/^Paying — renews \d{1,2} [A-Z][a-z]{2,3}/);
    expect(b('paying').detail).toBe('Standard monthly · ₹699/mo');
    expect(b('trial').label).toMatch(/^Trial — first charge ₹599 on \d{1,2} [A-Z][a-z]{2,3}/);
    expect(b('usd').label).toMatch(/^Trial — first charge \$19 on /);
    expect(b('cancelled')).toMatchObject({ state: 'cancelled' });
    expect(b('cancelled').label).toMatch(/^Cancelled — access until /);
    expect(b('cancelled').detail).toContain('never charged');
    expect(b('failed')).toMatchObject({ state: 'payment_failed', label: 'Payment failed — halted', planState: 'dunning' });
    expect(b('lifetime')).toMatchObject({ state: 'lifetime', label: 'Lifetime (internal)' });
    expect(b('free')).toMatchObject({ state: 'free', label: 'Free (ends 27 Oct 2099)' });
    expect(b('exempt')).toMatchObject({ state: 'free_exempt', label: 'Free (exempt)' });
    expect(b('used')).toMatchObject({ state: 'free' });
    // A new sign-up (created after the cutoff) gets free posts, not a trial.
    expect(b('new')).toMatchObject({ state: 'free_posts', label: 'Free posts', planState: 'free_posts' });
    expect(b('new').detail).toContain('3 free posts');
    // The Razorpay subscription id stays on the server.
    expect(JSON.stringify(body.users)).not.toMatch(/sub_int[a-z0-9]+/);
  });

  it('the chip counts are exactly the rows each chip shows; a user in two workspaces counts in both', async () => {
    const body = await list();
    for (const [state, n] of Object.entries(body.metrics.states)) {
      expect(body.users.filter((u: any) => u.billingStates.includes(state)).length).toBe(n);
    }
    const multi = body.users.find((u: any) => u.organizations.some((o: any) => o.organization.id === orgs.multi));
    expect(multi.organizations[0].organization.id).toBe(orgs.multi);
    expect(multi.billingStates.sort()).toEqual(['free_posts', 'paying']);
  });

  it('Users and Workspaces: deleted users are not counted, api.market and orphaned workspaces are named', async () => {
    const body = await list();
    const m = body.metrics;
    expect(m.totalUsers).toBe(await db().user.count({ where: { deletedAt: null } }));
    expect(m.deletedUsers).toBeGreaterThanOrEqual(2);
    expect(m.workspaces.total).toBe(m.totalOrgs);
    expect(m.workspaces.withUsers + m.workspaces.marketplace + m.workspaces.withoutUsers).toBe(m.totalOrgs);
    expect(m.workspaces.marketplace).toBeGreaterThanOrEqual(1);
    // The orphan and the deleted user's workspace.
    expect(m.workspaces.withoutUsers).toBeGreaterThanOrEqual(2);
    expect(m.workspaces.usersWithSeveral).toBeGreaterThanOrEqual(1);
    // Neither the api.market workspace nor a deleted user is a row.
    expect(billingOf(body, orgs.mkt)).toBeUndefined();
    expect(billingOf(body, orgs.gone)).toBeUndefined();
  });

  it('FREE_PLAN_SUNSET_AT passing turns Free into Needs trial / Locked with no restart; exempt stays Free (exempt)', async () => {
    const before = await list();
    expect(billingOf(before, orgs.free).state).toBe('free');
    process.env.FREE_PLAN_SUNSET_AT = '2026-10-20T00:00:00Z';
    try {
      const after = await list();
      expect(billingOf(after, orgs.free)).toMatchObject({ state: 'needs_trial', label: 'Needs trial', planState: 'needs_trial' });
      // A new sign-up is not reached by the sunset: still free posts.
      expect(billingOf(after, orgs.new)).toMatchObject({ state: 'free_posts', label: 'Free posts' });
      expect(billingOf(after, orgs.free).detail).toContain('Free plan ended 20 Oct');
      expect(billingOf(after, orgs.used)).toMatchObject({ state: 'locked', label: 'Locked — trial used' });
      expect(billingOf(after, orgs.exempt)).toMatchObject({ state: 'free_exempt' });
      expect(billingOf(after, orgs.paying).state).toBe('paying');
      expect(after.billingSource.sunsetAt).toBe('2026-10-20T00:00:00.000Z');
    } finally {
      process.env.FREE_PLAN_SUNSET_AT = '2099-10-27T18:29:59Z';
    }
  });

  it('Razorpay failing for a plan: that row falls back to the database and the page is told', async () => {
    // Other files' plans (givePlan's sub_test_ ids) are unknown to this fake
    // account and fail too; only the difference is this test's.
    const baseline = (await list('?fresh=1')).billingSource.failed;
    const original = rzp.handle.bind(rzp);
    const trialSub = (await db().subscription.findUniqueOrThrow({ where: { organizationId: orgs.trial } })).identifier!;
    rzp.handle = async (method: string, path: string, body?: any) => {
      if (path.includes(trialSub)) throw new Error('Razorpay GET failed (502): Bad gateway');
      return original(method, path, body);
    };
    try {
      const body = await list('?fresh=1');
      expect(billingOf(body, orgs.trial)).toMatchObject({ state: 'trial', label: 'Trial — first charge date unknown' });
      expect(billingOf(body, orgs.paying).state).toBe('paying');
      expect(body.billingSource).toMatchObject({ razorpay: 'partial', failed: baseline + 1 });
    } finally {
      rzp.handle = original;
    }
  });

  it('is refused to a workspace owner who is not a platform super admin', async () => {
    const owner = await t.api.register({ company: 'Not admin' });
    const res = await owner.get('/admin/users');
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('billingStates');
  });
});
