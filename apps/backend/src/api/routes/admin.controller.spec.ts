import 'reflect-metadata';

// GET /admin/users: the "Active trials" metric. The database is a fake.

jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/errors/errors.service', () => ({
  ErrorsService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/admin-stats/admin-stats.service',
  () => ({ AdminStatsService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/services/support-tickets.service', () => ({
  SupportTicketsService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: jest.fn() })),
}));
// AdminPlanActionsService is real (the dispute restore's rule lives there);
// its other collaborators are stubs.
jest.mock('@hookpost/nestjs-libraries/services/razorpay.service', () => ({
  RazorpayService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/services/account.correction.service', () => ({
  AccountCorrectionService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.action.audit.repository',
  () => ({ PlanActionAuditRepository: class {} })
);
jest.mock('@hookpost/nestjs-libraries/database/prisma/refunds/refunds.service', () => ({
  RefundsService: class {},
  PAYMENT_ID_RE: /^pay_[A-Za-z0-9]{14}$/,
  BULK_REFUND_MAX: 50,
}));
// OrganizationService reaches NotificationService and the Resend provider,
// which builds a client at import time and throws without an API key.
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/services/owner.sales.alert.service', () => ({
  OwnerSalesAlertService: class {},
}));

// Only a type here: the restore is driven through a stub (make() below).
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
import { AdminController } from './admin.controller';
import { AdminPlanActionsService } from '@hookpost/nestjs-libraries/services/admin.plan.actions.service';

const org = (id: string, isTrailing: boolean, subscription: any = null) => ({
  organization: { id, name: id, isTrailing, subscription },
});
const trialRow = { subscriptionTier: 'STANDARD', isLifetime: false };

function controller(
  users: any[],
  extra: {
    attribution?: any[];
    marketplace?: any[];
    orgCounts?: number[];
    sources?: any[];
    /** Live members per workspace id (memberCounts). */
    members?: Record<string, number>;
    /** Root post rows (freePostsUsedByOrg). */
    posts?: Array<{ organizationId: string; publishDate: Date; integrationId: string | null }>;
  } = {}
) {
  const count = (n: number) => ({ count: jest.fn(async () => n) });
  // organization.count answers, in call order: all live workspaces, those
  // with a live user, then api.market ones without users.
  const orgCounts = [...(extra.orgCounts || [9, 9, 0])];
  return new AdminController(
    {} as any,
    {} as any,
    { model: { user: { findMany: jest.fn(async () => users), count: jest.fn(async () => users.length) } } } as any,
    {
      model: {
        organization: {
          count: jest.fn(async () => orgCounts.shift() ?? 0),
          findMany: jest.fn(async (args: any) =>
            (args?.where?.id?.in || []).map((id: string) => ({
              id,
              _count: { users: extra.members?.[id] ?? 1 },
            }))
          ),
        },
      },
    } as any,
    { model: { subscription: count(3) } } as any,
    { model: { integration: count(0) } } as any,
    { model: { post: { ...count(0), findMany: jest.fn(async () => extra.posts || []) } } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { model: { signupAttribution: { findMany: jest.fn(async () => extra.attribution || []) } } } as any,
    { model: { marketplaceAccount: { findMany: jest.fn(async () => extra.marketplace || []) } } } as any,
    { sources: jest.fn(async () => extra.sources || []) } as any,
    {} as any,
    { notify: jest.fn(async () => 'sent') } as any,
    {} as any,
    {} as any
  );
}

describe('GET /admin/users: activeTrials', () => {
  it('counts workspaces on a trial subscription, once each, not workspaces that never subscribed', async () => {
    const users = [
      // Two members of the same trialing workspace.
      { id: 'u1', organizations: [org('org-trial', true, trialRow)] },
      { id: 'u2', organizations: [org('org-trial', true, trialRow)] },
      // A second trial.
      { id: 'u3', organizations: [org('org-trial-2', true, { ...trialRow, subscriptionTier: 'PRO' })] },
      // New workspaces start with isTrailing set and no row: never subscribed.
      { id: 'u4', organizations: [org('org-free', true, null)] },
      // Paying, and a lifetime plan.
      { id: 'u5', organizations: [org('org-paid', false, trialRow)] },
      { id: 'u6', organizations: [org('org-lifetime', true, { subscriptionTier: 'ULTIMATE', isLifetime: true })] },
    ];

    const res = await controller(users).listUsers({ isSuperAdmin: true } as any);

    expect(res.metrics.activeTrials).toBe(2);
  });
});

describe('GET /admin/users: planState per workspace', () => {
  const ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ENV };
  });

  const workspace = (id: string, over: any) => ({
    organization: {
      id,
      name: id,
      isTrailing: true,
      allowTrial: true,
      createdAt: new Date('2026-10-22T00:00:00Z'),
      subscription: null,
      users: [{ user: { signupCountry: 'IN' } }],
      ...over,
    },
  });

  const states = async () => {
    const users = [
      { id: 'u1', organizations: [workspace('org-new', {})] },
      { id: 'u2', organizations: [workspace('org-used', { allowTrial: false, isTrailing: false })] },
      { id: 'u3', organizations: [workspace('org-old', { createdAt: new Date('2026-09-01T00:00:00Z') })] },
      { id: 'u4', organizations: [workspace('org-us', { users: [{ user: { signupCountry: 'US' } }] })] },
      { id: 'u5', organizations: [workspace('org-trial', { subscription: { ...trialRow, cancelAt: null, deletedAt: null } })] },
    ];
    const res: any = await controller(users).listUsers({ isSuperAdmin: true } as any);
    return Object.fromEntries(
      res.users.map((u: any) => [u.organizations[0].organization.id, u.organizations[0].organization])
    );
  };

  it('labels each workspace by the trial policy, and does not leak the owner rows', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '2026-10-20T00:00:00Z';
    const orgs: any = await states();
    expect(orgs['org-new'].planState).toBe('free_posts');
    expect(orgs['org-used'].planState).toBe('locked');
    expect(orgs['org-old'].planState).toBe('free');
    expect(orgs['org-us'].planState).toBe('free');
    expect(orgs['org-trial'].planState).toBe('trialing');
    expect(orgs['org-new'].freePlanAvailable).toBe(false);
    expect(orgs['org-old'].freePlanAvailable).toBe(true);
    expect(orgs['org-new'].users).toBeUndefined();
  });

  it('with both cutoffs empty every workspace without a plan is free', async () => {
    delete process.env.TRIAL_REQUIRED_SINCE_IN;
    delete process.env.TRIAL_REQUIRED_SINCE_GLOBAL;
    const orgs: any = await states();
    expect(orgs['org-new'].planState).toBe('free');
    expect(orgs['org-used'].planState).toBe('free');
  });
});

describe('GET /admin/users: one billing state per workspace, counted like the filter chips', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '2026-10-19T00:00:00Z';
    process.env.FREE_PLAN_SUNSET_AT = '2099-10-27T18:29:59Z';
    process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = 'org-exempt';
  });
  afterEach(() => {
    process.env = { ...ENV };
  });

  const ws = (id: string, over: any = {}) => ({
    id: `uo-${id}`,
    role: 'SUPERADMIN',
    organization: {
      id,
      name: id,
      isTrailing: true,
      allowTrial: true,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      subscription: null,
      users: [{ user: { signupCountry: 'IN' } }],
      _count: { users: 0 },
      ...over,
    },
  });
  const sub = (over: any = {}) => ({
    subscriptionTier: 'STANDARD',
    period: 'MONTHLY',
    isLifetime: false,
    cancelAt: null,
    deletedAt: null,
    identifier: 'sub_paying00000001',
    ...over,
  });
  const users = () => [
    { id: 'u-pay', organizations: [ws('org-pay', { isTrailing: false, subscription: sub() })] },
    { id: 'u-trial', organizations: [ws('org-trial', { createdAt: new Date('2026-10-23T00:00:00Z'), isTrailing: false, subscription: sub({ identifier: 'sub_trial000000001' }) })] },
    { id: 'u-cancel', organizations: [ws('org-cancel', { subscription: sub({ identifier: 'sub_cancel00000001', cancelAt: new Date('2099-11-02T00:00:00Z') }) })] },
    { id: 'u-free', organizations: [ws('org-free')] },
    { id: 'u-exempt', organizations: [ws('org-exempt')] },
    { id: 'u-life', organizations: [ws('org-life', { subscription: sub({ isLifetime: true, identifier: 'sub_admin_granted' }) })] },
    // One user owning two workspaces in different states counts in both.
    { id: 'u-two', organizations: [ws('org-two-a'), ws('org-two-b', { createdAt: new Date('2026-10-24T00:00:00Z') })] },
    { id: 'u-none', organizations: [] },
  ];
  const razorpay = (c: AdminController, failFor: string[] = []) => {
    const rz = (c as any)._razorpay;
    Object.defineProperty(rz, 'configured', { value: true });
    const subs: Record<string, any> = {
      sub_paying00000001: { status: 'active', paid_count: 3, plan_id: 'plan_a', charge_at: 4102444800, current_end: 4102444800 },
      sub_trial000000001: { status: 'active', paid_count: 0, plan_id: 'plan_a', start_at: 4102444800, charge_at: 4102444800 },
      sub_cancel00000001: { status: 'cancelled', paid_count: 0, plan_id: 'plan_a' },
    };
    rz.request = jest.fn(async (_m: string, path: string) => {
      const id = decodeURIComponent(path.split('/').pop() || '');
      if (failFor.includes(id)) throw new Error('Razorpay GET failed (500)');
      if (path.startsWith('/plans/')) return { id, item: { amount: 59900, currency: 'INR' } };
      if (subs[id]) return { id, ...subs[id] };
      throw new Error('Razorpay GET failed (404)');
    });
    return rz.request as jest.Mock;
  };
  const byOrg = (res: any) =>
    Object.fromEntries(res.users.flatMap((u: any) => u.organizations.map((o: any) => [o.organization.id, o.organization.billing])));

  it('labels every row from Razorpay, the row and the policy, and the counts match the badges', async () => {
    const c = controller(users(), {
      orgCounts: [12, 8, 4],
      marketplace: [{ organizationId: 'mkt-1' }],
      // One free post used by org-two-b, counted as the post gate counts it.
      posts: [{ organizationId: 'org-two-b', publishDate: new Date('2026-10-25T10:00:00Z'), integrationId: 'ch-1' }],
    });
    const request = razorpay(c);
    const res: any = await c.listUsers({ isSuperAdmin: true } as any);
    const b = byOrg(res);
    expect(b['org-pay']).toMatchObject({ state: 'paying', label: 'Paying ₹599/month · renews 1 Jan 2100' });
    expect(b['org-trial']).toMatchObject({ state: 'first_charge', label: 'First charge ₹599 on 1 Jan 2100' });
    expect(b['org-cancel']).toMatchObject({ state: 'cancelled', label: 'Cancelled · access until 2 Nov 2099' });
    expect(b['org-free']).toMatchObject({ state: 'free', label: 'Old Free plan' });
    expect(b['org-exempt']).toMatchObject({ state: 'team', label: 'Team / review account' });
    expect(b['org-life']).toMatchObject({ state: 'team' });
    expect(b['org-two-b']).toMatchObject({ state: 'free_posts', label: 'Can post free · 2 of 3 left' });
    expect(res.users.find((u: any) => u.id === 'u-none').billingStates).toEqual(['no_workspace']);

    expect(res.metrics.states).toMatchObject({
      paying: 1, first_charge: 1, cancelled: 1, free: 2, team: 2, lifetime: 0, gift: 0,
      free_posts: 1, needs_plan: 0, no_workspace: 1, payment_failed: 0, marketplace: 0,
    });
    // Each count is exactly the rows the chip for that state would show.
    for (const [state, n] of Object.entries(res.metrics.states)) {
      expect(res.users.filter((u: any) => u.billingStates.includes(state)).length).toBe(n);
    }
    expect(res.metrics.workspaces).toEqual({ total: 12, withUsers: 8, marketplace: 4, withoutUsers: 0, usersWithSeveral: 1 });
    expect(res.billingSource).toMatchObject({ razorpay: 'ok', failed: 0 });

    // Lifetime and plan-less workspaces are never looked up; the plan once.
    const paths = request.mock.calls.map((call) => call[1]);
    expect(paths.filter((p: string) => p.startsWith('/subscriptions/')).sort()).toEqual([
      '/subscriptions/sub_cancel00000001', '/subscriptions/sub_paying00000001', '/subscriptions/sub_trial000000001',
    ]);
    expect(paths.filter((p: string) => p.startsWith('/plans/'))).toEqual(['/plans/plan_a']);
    // The Razorpay subscription id is not sent to the page.
    expect(JSON.stringify(res.users)).not.toContain('sub_paying00000001');
  });

  it('Razorpay failing for one plan labels that one from the database and says so', async () => {
    const c = controller(users());
    razorpay(c, ['sub_trial000000001']);
    const res: any = await c.listUsers({ isSuperAdmin: true } as any);
    const b = byOrg(res);
    // isTrailing is false on that row: from the database alone it reads as paying, without a date.
    expect(b['org-trial']).toMatchObject({ state: 'paying', label: 'Paying' });
    expect(b['org-pay'].state).toBe('paying');
    expect(res.billingSource).toMatchObject({ razorpay: 'partial', failed: 1 });
  });

  it('Razorpay not configured: nothing is called, states come from the database', async () => {
    const c = controller(users(), { attribution: [{ organizationId: 'org-trial', trialStartedAt: new Date('2026-10-23T00:00:00Z'), paidAt: null }] });
    const res: any = await c.listUsers({ isSuperAdmin: true } as any);
    expect(byOrg(res)['org-cancel'].state).toBe('cancelled');
    expect(res.billingSource.razorpay).toBe('not_configured');
  });

  it('reuses Razorpay answers for two minutes unless fresh=1', async () => {
    const c = controller(users());
    const request = razorpay(c);
    await c.listUsers({ isSuperAdmin: true } as any);
    const first = request.mock.calls.length;
    await c.listUsers({ isSuperAdmin: true } as any);
    expect(request.mock.calls.length).toBe(first);
    await c.listUsers({ isSuperAdmin: true } as any, undefined, undefined, '1');
    expect(request.mock.calls.length).toBeGreaterThan(first);
  });

  it('is refused to anyone but a platform super admin', async () => {
    await expect(controller(users()).listUsers({ isSuperAdmin: false } as any)).rejects.toThrow('Unauthorized');
  });

  it('payment failed, locked, a soft-deleted plan row and a 200 without a status', async () => {
    const rows = [
      { id: 'u-f', organizations: [ws('org-failed', { isTrailing: false, subscription: sub({ identifier: 'sub_failed00000001' }) })] },
      { id: 'u-l', organizations: [ws('org-locked', { createdAt: new Date('2026-10-23T00:00:00Z'), allowTrial: false, isTrailing: false })] },
      { id: 'u-d', organizations: [ws('org-deleted-row', { createdAt: new Date('2026-10-23T00:00:00Z'), subscription: sub({ identifier: 'sub_deleted0000001', deletedAt: new Date('2026-10-20') }) })] },
      { id: 'u-e', organizations: [ws('org-empty', { isTrailing: false, subscription: sub({ identifier: 'sub_empty000000001' }) })] },
    ];
    const c = controller(rows);
    const rz = (c as any)._razorpay;
    Object.defineProperty(rz, 'configured', { value: true });
    rz.request = jest.fn(async (_m: string, path: string) => {
      if (path === '/subscriptions/sub_failed00000001') return { id: 'x', status: 'pending', paid_count: 4, plan_id: 'plan_a' };
      if (path === '/subscriptions/sub_empty000000001') return { raw: 'unexpected' };
      if (path.startsWith('/plans/')) return { item: { amount: 69900, currency: 'INR' } };
      throw new Error(`unexpected ${path}`);
    });
    const res: any = await c.listUsers({ isSuperAdmin: true } as any);
    const b = byOrg(res);
    expect(b['org-failed']).toMatchObject({ state: 'payment_failed', label: 'Payment failed · retrying', planState: 'dunning' });
    expect(b['org-locked']).toMatchObject({ state: 'needs_plan', label: 'No free posts · must pick a plan', planState: 'locked' });
    expect(b['org-deleted-row']).toMatchObject({ state: 'free_posts' });
    const deletedRow = res.users.find((u: any) => u.id === 'u-d').organizations[0].organization;
    expect(deletedRow.subscription).toBeNull();
    // The deleted row is never looked up; the status-less answer is a failed read.
    expect(rz.request.mock.calls.map((call: any[]) => call[1])).not.toContain('/subscriptions/sub_deleted0000001');
    expect(b['org-empty']).toMatchObject({ state: 'paying', label: 'Paying' });
    expect(res.billingSource).toMatchObject({ razorpay: 'partial', failed: 1 });
  });

  it('reads Razorpay at most 6 at a time, and stops waiting after 10 seconds in all', async () => {
    jest.useFakeTimers();
    try {
      const many = Array.from({ length: 20 }, (_, i) => ({
        id: `u-${i}`,
        organizations: [ws(`org-${i}`, { isTrailing: false, subscription: sub({ identifier: `sub_many${String(i).padStart(10, '0')}` }) })],
      }));
      const c = controller(many);
      const rz = (c as any)._razorpay;
      Object.defineProperty(rz, 'configured', { value: true });
      // Razorpay hangs: no read ever answers, each times out after 8 s.
      rz.request = jest.fn(() => new Promise(() => undefined));
      const pending = c.listUsers({ isSuperAdmin: true } as any);
      await jest.advanceTimersByTimeAsync(7_999);
      // Six at once, no more, until one of them gives up.
      expect(rz.request).toHaveBeenCalledTimes(6);
      await jest.advanceTimersByTimeAsync(2_001);
      const res: any = await pending;
      // The next six started at 8 s; at 10 s the page stops waiting and
      // starts nothing more.
      expect(rz.request).toHaveBeenCalledTimes(12);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(rz.request).toHaveBeenCalledTimes(12);
      expect(res.billingSource).toMatchObject({ razorpay: 'partial', failed: 20 });
      expect(new Set(Object.values(byOrg(res)).map((v: any) => v.label))).toEqual(new Set(['Paying']));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('/admin/refunds: super admins only, never while impersonating', () => {
  const refunds = () => ({
    listPayments: jest.fn(async () => ({ payments: [] })),
    listAudit: jest.fn(async () => ({ available: true, rows: [] })),
    listRefunds: jest.fn(async () => ({ refunds: [] })),
    refund: jest.fn(async () => ({ status: 'refunded' })),
    refundBulk: jest.fn(async () => ({ results: [], summary: {} })),
  });
  const make = (service: any) =>
    new AdminController(
      {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, service,
      {} as any, {} as any, {} as any, {} as any, {} as any,
      { notify: jest.fn(async () => 'sent') } as any,
      {} as any,
    {} as any
  );
  const admin = { id: 'u-admin', email: 'owner@hookstep.in', isSuperAdmin: true } as any;
  // A workspace owner is "Super Admin" of their own workspace (the org role),
  // which is not User.isSuperAdmin and must not open this.
  const orgOwner = { id: 'u-owner', email: 'owner@acme.com', isSuperAdmin: false } as any;
  // What the page sends: JSON.
  const req = (cookies: any = {}, headers: any = {}) =>
    ({ cookies, headers: { 'content-type': 'application/json', ...headers } } as any);
  const body = { paymentId: 'pay_TqFWpXxKSIObH8' } as any;

  it('refuses every refunds endpoint to a user without User.isSuperAdmin, and calls nothing', async () => {
    const service = refunds();
    const c = make(service);
    await expect(c.listRefundPayments(orgOwner)).rejects.toThrow('Unauthorized');
    await expect(c.listRefundAudit(orgOwner)).rejects.toThrow('Unauthorized');
    await expect(c.listRefundHistory(orgOwner)).rejects.toThrow('Unauthorized');
    await expect(c.listRefundHistory(undefined as any, '0', '50', undefined, 'all')).rejects.toThrow(
      'Unauthorized'
    );
    await expect(c.refundPayment(orgOwner, req(), body)).rejects.toThrow('Unauthorized');
    await expect(
      c.refundPayments(orgOwner, req(), { paymentIds: [body.paymentId] } as any)
    ).rejects.toThrow('Unauthorized');
    await expect(c.refundPayment(undefined as any, req(), body)).rejects.toThrow('Unauthorized');
    Object.values(service).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  it('refuses to move money while impersonating (cookie or header), so the audit names the real admin', async () => {
    const service = refunds();
    const c = make(service);
    await expect(c.refundPayment(admin, req({ impersonate: 'uo-1' }), body)).rejects.toThrow(
      /Stop impersonating/
    );
    await expect(
      c.refundPayments(admin, req({}, { impersonate: 'uo-1' }), { paymentIds: [body.paymentId] } as any)
    ).rejects.toThrow(/Stop impersonating/);
    expect(service.refund).not.toHaveBeenCalled();
    expect(service.refundBulk).not.toHaveBeenCalled();
  });

  it('refuses anything but JSON (a cross-site form can post urlencoded with the cookie), and calls nothing', async () => {
    const service = refunds();
    const c = make(service);
    for (const type of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
      'text/plain; x=application/json',
      undefined,
    ]) {
      const form = req({}, { 'content-type': type });
      await expect(c.refundPayment(admin, form, body)).rejects.toMatchObject({ status: 415 });
      await expect(
        c.refundPayments(admin, form, { paymentIds: [body.paymentId] } as any)
      ).rejects.toMatchObject({ status: 415 });
    }
    expect(service.refund).not.toHaveBeenCalled();
    expect(service.refundBulk).not.toHaveBeenCalled();
    // A charset parameter is still JSON.
    await c.refundPayment(admin, req({}, { 'content-type': 'application/json; charset=utf-8' }), body);
    expect(service.refund).toHaveBeenCalledTimes(1);
  });

  it('a super admin refunds as themselves', async () => {
    const service = refunds();
    const c = make(service);
    await c.refundPayment(admin, req(), { ...body, amount: 50, reason: 'test' });
    expect(service.refund).toHaveBeenCalledWith(
      { id: 'u-admin', email: 'owner@hookstep.in' },
      { paymentId: 'pay_TqFWpXxKSIObH8', amount: 50, reason: 'test' }
    );
    await c.refundPayments(admin, req(), {
      paymentIds: ['pay_TqFWpXxKSIObH8'],
      confirmForeign: true,
    } as any);
    expect(service.refundBulk).toHaveBeenCalledWith(
      { id: 'u-admin', email: 'owner@hookstep.in' },
      ['pay_TqFWpXxKSIObH8'],
      { reason: undefined, confirmForeign: true }
    );
    await c.listRefundHistory(admin, '50', '50', '1792518300', 'all');
    expect(service.listRefunds).toHaveBeenCalledWith({
      skip: 50,
      count: 50,
      to: 1792518300,
      all: true,
    });
    // Hookpost's only unless all products is asked for.
    await c.listRefundHistory(admin);
    expect(service.listRefunds).toHaveBeenLastCalledWith({
      skip: 0,
      count: 50,
      to: undefined,
      all: false,
    });
    await c.listRefundPayments(admin, '100', '50', '1792518300', 'all');
    expect(service.listPayments).toHaveBeenCalledWith({
      skip: 100,
      count: 50,
      to: 1792518300,
      all: true,
      paymentId: undefined,
    });
  });
});

describe('GET /admin/users: where each workspace signed up from', () => {
  const ws = (id: string, source = 'DIRECT') => ({
    organization: {
      id,
      name: id,
      source,
      isTrailing: true,
      allowTrial: true,
      createdAt: new Date('2026-10-27T04:00:00Z'),
      subscription: null,
      users: [{ user: { signupCountry: 'US' } }],
    },
  });

  it('labels each workspace from its own attribution row, and asks the database for the source fields', async () => {
    const users = [
      { id: 'u1', organizations: [ws('org-claude')] },
      { id: 'u2', organizations: [ws('org-ads')] },
      { id: 'u3', organizations: [ws('org-direct')] },
      { id: 'u4', organizations: [ws('org-old')] },
      { id: 'u5', organizations: [ws('org-mkt', 'API_MARKET')] },
    ];
    const c = controller(users, {
      attribution: [
        { organizationId: 'org-claude', referrer: 'https://claude.ai/', landingPath: '/auth' },
        { organizationId: 'org-ads', utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'hp_search_alt_23oct', gclid: 'g' },
        { organizationId: 'org-direct', referrer: null, landingPath: '/pricing' },
      ],
    });
    const res: any = await c.listUsers({ isSuperAdmin: true } as any);
    const byId = Object.fromEntries(
      res.users.map((u: any) => [u.organizations[0].organization.id, u.organizations[0].organization])
    );

    expect(byId['org-claude'].signupSource).toEqual({
      label: 'claude.ai',
      kind: 'referral',
      campaign: null,
      landingPath: '/auth',
    });
    expect(byId['org-ads'].signupSource).toMatchObject({
      label: 'google / hp_search_alt_23oct',
      campaign: 'hp_search_alt_23oct',
    });
    expect(byId['org-direct'].signupSource).toMatchObject({ label: 'direct', kind: 'direct' });
    // No row: unknown, never "direct".
    expect(byId['org-old'].signupSource).toBeNull();
    // The marketplace source travels next to it.
    expect(byId['org-mkt'].source).toBe('API_MARKET');
    expect(byId['org-claude'].source).toBe('DIRECT');

    const findMany = (c as any)._attributionRows.model.signupAttribution.findMany as jest.Mock;
    const select = findMany.mock.calls[0][0].select;
    for (const k of ['utmSource', 'utmMedium', 'utmCampaign', 'referrer', 'landingPath', 'gclid', 'fbclid', 'ttclid', 'msclkid', 'trialStartedAt', 'paidAt']) {
      expect(select[k]).toBe(true);
    }
    const userSelect = ((c as any)._user.model.user.findMany as jest.Mock).mock.calls[0][0].select;
    expect(userSelect.organizations.select.organization.select.source).toBe(true);
  });
});

describe('GET /admin/users: members per workspace', () => {
  it('each workspace carries its live member count, asked for in one query', async () => {
    const ws = (id: string) => ({
      organization: { id, name: id, isTrailing: true, allowTrial: true, createdAt: new Date(), subscription: null, users: [] },
    });
    const c = controller(
      [
        { id: 'u1', organizations: [ws('org-team'), ws('org-solo')] },
        { id: 'u2', organizations: [ws('org-team')] },
      ],
      { members: { 'org-team': 3, 'org-solo': 1 } }
    );
    const res: any = await c.listUsers({ isSuperAdmin: true } as any);
    const orgs = res.users[0].organizations.map((o: any) => [o.organization.id, o.organization.members]);
    expect(orgs).toEqual([
      ['org-team', 3],
      ['org-solo', 1],
    ]);
    const findMany = (c as any)._organization.model.organization.findMany as jest.Mock;
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.id.in.sort()).toEqual(['org-solo', 'org-team']);
    // Deleted users are not members.
    expect(findMany.mock.calls[0][0].select._count.select.users.where).toEqual({ user: { deletedAt: null } });
  });
});

// The owner's clear of a payment dispute: GET /admin/workspaces/:id/dispute
// and POST .../dispute/clear. Super admin only, JSON only, audited, and it
// never gives the plan back (RazorpayService.handleDispute ended it).
const DISPUTED_AT = new Date('2026-10-29T11:26:00Z');
const disputeRow = (over: any = {}) => ({
  id: 'org-chai',
  name: 'Chai Point Social',
  disputedAt: DISPUTED_AT,
  disputeReason: 'processed_invalid_expired_card',
  disputePaymentId: 'pay_EFtmUsbwpXwBHI',
  disputeClearedAt: null,
  disputeClearedBy: null,
  ...over,
});
const admin = { id: 'u-admin', email: 'owner@hookstep.in', isSuperAdmin: true } as any;
const orgOwner = { id: 'u-owner', email: 'owner@acme.com', isSuperAdmin: false } as any;
const jsonReq = (headers: any = {}) =>
  ({ cookies: {}, headers: { 'content-type': 'application/json', ...headers } } as any);

const make = (
  organizations: any,
  alerts: any = { notify: jest.fn(async () => 'sent') },
  subscriptions: any = { restoreDisputedPlan: jest.fn(async () => undefined) },
  /** What Razorpay says about the dispute (GET /disputes/:id). */
  razorpayDispute: any = { status: 'won' }
) => {
  if (!subscriptions.getSubscription) {
    subscriptions.getSubscription = jest.fn(async () => null);
  }
  // RazorpayService.readDispute answers null when Razorpay cannot be read.
  const razorpay = {
    readDispute: jest.fn(async (id: string) =>
      razorpayDispute instanceof Error ? null : { id, ...razorpayDispute }
    ),
  };
  // The real rule (AdminPlanActionsService.restoreAfterWonDispute) over the
  // same stubs the controller gets.
  const planActions = new AdminPlanActionsService(
    subscriptions,
    razorpay as any,
    {} as any,
    {} as any,
    organizations
  );
  const c = new AdminController(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any,
    organizations,
    alerts,
    subscriptions,
    planActions
  );
  (c as any)._razorpayDisputes = razorpay;
  return c;
};
const orgService = (over: any = {}) => ({
  getDispute: jest.fn(async () => disputeRow()),
  clearDispute: jest.fn(async () => true),
  getDisputeEvidence: jest.fn(async () => ({
    id: 'org-chai',
    name: 'Chai Point Social',
    disputeEvidence: null,
  })),
  ...over,
});

describe('/admin/workspaces/:id/dispute', () => {
  const row = disputeRow;
  const req = jsonReq;

  it('refuses both endpoints to anyone without User.isSuperAdmin, and changes nothing', async () => {
    const organizations = orgService();
    const c = make(organizations);
    await expect(c.getWorkspaceDispute(orgOwner, 'org-chai')).rejects.toThrow('Unauthorized');
    await expect(
      c.clearWorkspaceDispute(orgOwner, 'org-chai', req())
    ).rejects.toThrow('Unauthorized');
    await expect(
      c.clearWorkspaceDispute(undefined as any, 'org-chai', req())
    ).rejects.toThrow('Unauthorized');
    expect(organizations.clearDispute).not.toHaveBeenCalled();
  });

  it('refuses anything but JSON, so a cross-site form cannot clear a dispute', async () => {
    const organizations = orgService();
    const c = make(organizations);
    for (const type of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
      undefined,
    ]) {
      await expect(
        c.clearWorkspaceDispute(admin, 'org-chai', req({ 'content-type': type }))
      ).rejects.toMatchObject({ status: 415 });
    }
    expect(organizations.clearDispute).not.toHaveBeenCalled();
  });

  it('clears it, names who did it in the audit trail, and alerts the owner', async () => {
    const organizations = orgService();
    const alerts = { notify: jest.fn(async () => 'sent') };
    const c = make(organizations, alerts);

    await expect(c.clearWorkspaceDispute(admin, 'org-chai', req())).resolves.toEqual({
      cleared: true,
    });

    expect(organizations.clearDispute).toHaveBeenCalledWith(
      'org-chai',
      'owner@hookstep.in (u-admin)'
    );
    expect(alerts.notify).toHaveBeenCalledTimes(1);
    const alert = (alerts.notify.mock.calls[0] as any[])[0];
    expect(alert.event).toBe('DISPUTE_CLEARED');
    expect(alert.organizationId).toBe('org-chai');
    expect(alert.notes.join(' ')).toContain('owner@hookstep.in (u-admin)');
    expect(alert.notes.join(' ')).toContain('processed_invalid_expired_card');
    expect(alert.notes.join(' ')).toContain('Its old plan was not restored');
  });

  it('a workspace with no open dispute is said so, and nothing is written or alerted', async () => {
    const organizations = orgService({
      getDispute: jest.fn(async () => row({ disputedAt: null })),
    });
    const alerts = { notify: jest.fn(async () => 'sent') };
    const c = make(organizations, alerts);

    await expect(c.clearWorkspaceDispute(admin, 'org-chai', req())).resolves.toEqual({
      cleared: false,
      reason: 'This workspace has no open dispute.',
    });
    expect(organizations.clearDispute).not.toHaveBeenCalled();
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it('a second click (someone else cleared it first) is not a second alert', async () => {
    const organizations = orgService({ clearDispute: jest.fn(async () => false) });
    const alerts = { notify: jest.fn(async () => 'sent') };
    const c = make(organizations, alerts);

    await expect(c.clearWorkspaceDispute(admin, 'org-chai', req())).resolves.toEqual({
      cleared: false,
      reason: 'This workspace has no open dispute.',
    });
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it('a workspace that does not exist is a 404, not a silent success', async () => {
    const organizations = orgService({ getDispute: jest.fn(async () => null) });
    const c = make(organizations);
    await expect(c.getWorkspaceDispute(admin, 'nope')).rejects.toMatchObject({ status: 404 });
    await expect(c.clearWorkspaceDispute(admin, 'nope', req())).rejects.toMatchObject({
      status: 404,
    });
    expect(organizations.clearDispute).not.toHaveBeenCalled();
  });

  it('GET returns the dispute with its reason, payment and who cleared it', async () => {
    const organizations = orgService();
    const c = make(organizations);
    await expect(c.getWorkspaceDispute(admin, 'org-chai')).resolves.toMatchObject({
      disputedAt: DISPUTED_AT,
      disputeReason: 'processed_invalid_expired_card',
      disputePaymentId: 'pay_EFtmUsbwpXwBHI',
    });
  });
});

// The evidence pack handleDispute stored, as a file to answer Razorpay with
// (GET /admin/workspaces/:id/dispute/evidence), and the owner giving the
// plan back after winning (POST .../dispute/restore).
describe('/admin/workspaces/:id/dispute: the evidence pack and the restore', () => {
  const req = jsonReq;
  const PERIOD_END = '2026-11-20T00:00:00.000Z';
  const pack = (over: any = {}) => ({
    builtAt: '2026-10-29T11:26:00.000Z',
    dispute: {
      id: 'disp_EsIAlDcoUr8CaQ',
      status: 'open',
      phase: 'chargeback',
      reasonCode: 'processed_invalid_expired_card',
      amount: 390,
      currency: 'INR',
      createdAt: '2026-10-29T11:25:57.000Z',
      respondBy: '2026-11-03T11:25:57.000Z',
    },
    payment: {
      id: 'pay_EFtmUsbwpXwBHI',
      method: 'card',
      international: false,
      bank: 'HDFC',
      wallet: null,
      vpa: null,
      cardId: 'card_EADblPSDnnk5ZG',
      email: 'testpayer@example.in',
      contact: '+919900000000',
      amount: 599,
      currency: 'INR',
      createdAt: '2026-10-20T06:00:00.000Z',
      acquirer: { auth_code: '831000', rrn: '029400514911' },
    },
    workspace: {
      id: 'org-chai',
      name: 'Chai Point Social',
      createdAt: '2026-09-01T06:00:00.000Z',
      ownerEmail: 'testpayer@example.in',
      signupCountry: 'IN',
      ipCountry: 'IN',
      signupMethod: 'GOOGLE',
      firstSeenAt: '2026-09-01T05:55:00.000Z',
    },
    plan: {
      tier: 'STANDARD',
      period: 'MONTHLY',
      identifier: 'sub_live',
      totalChannels: 5,
      startedAt: '2026-10-20T06:00:00.000Z',
      periodEnd: PERIOD_END,
    },
    posts: {
      since: '2026-10-20T06:00:00.000Z',
      count: 14,
      firstAt: '2026-10-20T09:00:00.000Z',
      lastAt: '2026-10-28T09:00:00.000Z',
      sample: [
        { at: '2026-10-28T09:00:00.000Z', channel: 'Instagram', url: 'https://x.test/p/1' },
      ],
    },
    messages: [{ at: '2026-10-20T06:01:00.000Z', text: 'Payment received' }],
    policies: {
      terms: 'https://hookpost.hookstep.in/terms',
      refundPolicy: 'https://hookpost.hookstep.in/refund-policy',
      cancellationPolicy: 'https://hookpost.hookstep.in/cancellation-policy',
      privacy: 'https://hookpost.hookstep.in/privacy',
      support: 'support@hookstep.in',
    },
    ...over,
  });
  const withEvidence = (over: any = {}) =>
    orgService({
      getDisputeEvidence: jest.fn(async () => ({
        id: 'org-chai',
        name: 'Chai Point Social',
        disputeEvidence: JSON.stringify(pack()),
        ...over,
      })),
    });
  const res = () => {
    const headers: Record<string, string> = {};
    return {
      headers,
      setHeader: jest.fn((k: string, v: string) => {
        headers[k] = v;
      }),
      send: jest.fn(),
    };
  };

  it('downloads the pack as a named text file with the facts that answer a chargeback', async () => {
    const c = make(withEvidence());
    const r = res();

    await c.getWorkspaceDisputeEvidence(admin, 'org-chai', r as any);

    expect(r.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(r.headers['Content-Disposition']).toBe(
      'attachment; filename="hookpost-dispute-disp_EsIAlDcoUr8CaQ.txt"'
    );
    const file = (r.send.mock.calls[0] as any[])[0] as string;
    // The payment and how the bank says it was authorised.
    expect(file).toContain('pay_EFtmUsbwpXwBHI');
    expect(file).toContain('831000');
    expect(file).toContain('029400514911');
    // Who they are and when they signed up.
    expect(file).toContain('testpayer@example.in');
    expect(file).toContain('2026-09-01T06:00:00.000Z');
    // What we delivered, and what we told them.
    expect(file).toContain('Posts published in the paid period: 14');
    expect(file).toContain('Payment received');
    // Our terms, and the deadline.
    expect(file).toContain('https://hookpost.hookstep.in/refund-policy');
    expect(file).toContain('Respond by (3 business days): 2026-11-03T11:25:57.000Z');
    // Never a penalty figure: the fee depends on the stage and the network.
    expect(file).not.toMatch(/penalt|USD 675|USD 15|INR 3,000/i);
  });

  it('is refused to anyone but a super admin, and sends nothing', async () => {
    const c = make(withEvidence());
    const r = res();
    await expect(
      c.getWorkspaceDisputeEvidence(orgOwner, 'org-chai', r as any)
    ).rejects.toThrow('Unauthorized');
    expect(r.send).not.toHaveBeenCalled();
  });

  it.each([
    ['a workspace that does not exist', { getDisputeEvidence: jest.fn(async () => null) }],
    [
      'a dispute with no pack',
      {
        getDisputeEvidence: jest.fn(async () => ({
          id: 'org-chai',
          name: 'Chai',
          disputeEvidence: null,
        })),
      },
    ],
  ])('%s is a 404 rather than an empty file', async (_label, over) => {
    const c = make(orgService(over as any));
    const r = res();
    await expect(
      c.getWorkspaceDisputeEvidence(admin, 'org-chai', r as any)
    ).rejects.toMatchObject({ status: 404 });
    expect(r.send).not.toHaveBeenCalled();
  });

  it('a pack that is not readable JSON is an error, not a half-written file', async () => {
    const c = make(
      orgService({
        getDisputeEvidence: jest.fn(async () => ({
          id: 'org-chai',
          name: 'Chai',
          disputeEvidence: '{not json',
        })),
      })
    );
    const r = res();
    await expect(
      c.getWorkspaceDisputeEvidence(admin, 'org-chai', r as any)
    ).rejects.toMatchObject({ status: 500 });
    expect(r.send).not.toHaveBeenCalled();
  });

  it('restores the plan for the time already paid for, clears the dispute and alerts', async () => {
    const organizations = withEvidence();
    const alerts = { notify: jest.fn(async () => 'sent') };
    const subscriptions = { restoreDisputedPlan: jest.fn(async () => undefined) };
    const c = make(organizations, alerts, subscriptions);

    await expect(
      c.restoreWorkspacePlan(admin, 'org-chai', req())
    ).resolves.toEqual({ restored: true, until: PERIOD_END });

    expect(subscriptions.restoreDisputedPlan).toHaveBeenCalledWith('org-chai', {
      tier: 'STANDARD',
      period: 'MONTHLY',
      identifier: 'sub_live',
      periodEnd: new Date(PERIOD_END),
    });
    expect(organizations.clearDispute).toHaveBeenCalledWith(
      'org-chai',
      'owner@hookstep.in (u-admin)'
    );
    const alert = (alerts.notify.mock.calls[0] as any[])[0];
    expect(alert.event).toBe('DISPUTE_RESTORED');
    expect(alert.notes.join(' ')).toContain('owner@hookstep.in (u-admin)');
  });

  it('never restores on its own: it takes a super admin and a JSON request', async () => {
    const subscriptions = { restoreDisputedPlan: jest.fn(async () => undefined) };
    const c = make(withEvidence(), undefined, subscriptions);
    await expect(
      c.restoreWorkspacePlan(orgOwner, 'org-chai', req())
    ).rejects.toThrow('Unauthorized');
    await expect(
      c.restoreWorkspacePlan(admin, 'org-chai', req({ 'content-type': 'text/plain' }))
    ).rejects.toMatchObject({ status: 415 });
    expect(subscriptions.restoreDisputedPlan).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the paid period is already over',
      pack({ plan: { tier: 'STANDARD', period: 'MONTHLY', identifier: 'sub_live', periodEnd: '2026-10-01T00:00:00.000Z' } }),
    ],
    ['no plan was recorded', pack({ plan: null })],
    [
      'the plan has no subscription to name',
      pack({ plan: { tier: 'STANDARD', period: 'MONTHLY', identifier: null, periodEnd: PERIOD_END } }),
    ],
  ])('gives nothing back and writes nothing when %s', async (_label, stored) => {
    const organizations = orgService({
      getDisputeEvidence: jest.fn(async () => ({
        id: 'org-chai',
        name: 'Chai',
        disputeEvidence: JSON.stringify(stored),
      })),
    });
    const subscriptions = { restoreDisputedPlan: jest.fn(async () => undefined) };
    const c = make(organizations, undefined, subscriptions);

    const result: any = await c.restoreWorkspacePlan(admin, 'org-chai', req());

    expect(result.restored).toBe(false);
    expect(result.reason).toContain('Clear the dispute instead');
    expect(subscriptions.restoreDisputedPlan).not.toHaveBeenCalled();
    // And it must not quietly clear the dispute either.
    expect(organizations.clearDispute).not.toHaveBeenCalled();
  });

  it.each([
    ['still open', { status: 'open' }],
    ['lost', { status: 'lost' }],
    ['under review', { status: 'under_review' }],
  ])('refuses while Razorpay says the dispute is %s', async (_l, live) => {
    const organizations = withEvidence();
    const subscriptions = { restoreDisputedPlan: jest.fn(async () => undefined) };
    const c = make(organizations, undefined, subscriptions, live);
    const result: any = await c.restoreWorkspacePlan(admin, 'org-chai', req());
    expect(result).toMatchObject({ restored: false });
    expect(result.reason).toContain('not won');
    expect(subscriptions.restoreDisputedPlan).not.toHaveBeenCalled();
    expect(organizations.clearDispute).not.toHaveBeenCalled();
    expect((c as any)._razorpayDisputes.readDispute).toHaveBeenCalledWith('disp_EsIAlDcoUr8CaQ');
  });

  it('refuses when Razorpay cannot be read (never restores on a guess)', async () => {
    const subscriptions = { restoreDisputedPlan: jest.fn(async () => undefined) };
    const c = make(withEvidence(), undefined, subscriptions, new Error('down'));
    const result: any = await c.restoreWorkspacePlan(admin, 'org-chai', req());
    expect(result.restored).toBe(false);
    expect(subscriptions.restoreDisputedPlan).not.toHaveBeenCalled();
  });

  it('never overwrites a plan the workspace has bought since', async () => {
    const subscriptions = {
      restoreDisputedPlan: jest.fn(async () => undefined),
      getSubscription: jest.fn(async () => ({ identifier: 'sub_new', deletedAt: null })),
    };
    const c = make(withEvidence(), undefined, subscriptions);
    const result: any = await c.restoreWorkspacePlan(admin, 'org-chai', req());
    expect(result).toMatchObject({ restored: false });
    expect(result.reason).toContain('already has a plan');
    expect(subscriptions.restoreDisputedPlan).not.toHaveBeenCalled();
  });

  it('a plan row past its end date (not yet swept) is no plan: the restore goes ahead', async () => {
    const subscriptions = {
      restoreDisputedPlan: jest.fn(async () => undefined),
      getSubscription: jest.fn(async () => ({
        identifier: 'sub_old',
        deletedAt: null,
        cancelAt: new Date(Date.now() - 60_000),
      })),
    };
    const c = make(withEvidence(), undefined, subscriptions);
    const result: any = await c.restoreWorkspacePlan(admin, 'org-chai', req());
    expect(result).toEqual({ restored: true, until: PERIOD_END });
    expect(subscriptions.restoreDisputedPlan).toHaveBeenCalled();
  });

  it('a workspace that does not exist is a 404 on restore', async () => {
    const subscriptions = { restoreDisputedPlan: jest.fn(async () => undefined) };
    const c = make(
      orgService({ getDisputeEvidence: jest.fn(async () => null) }),
      undefined,
      subscriptions
    );
    await expect(
      c.restoreWorkspacePlan(admin, 'nope', req())
    ).rejects.toMatchObject({ status: 404 });
    expect(subscriptions.restoreDisputedPlan).not.toHaveBeenCalled();
  });
});

describe('/admin/plan: super admins only, never while impersonating', () => {
  const planActions = () => ({
    endPlan: jest.fn(async () => ({ ok: true, email: 'sent' })),
    restorePlan: jest.fn(async () => ({ ok: true, email: 'sent' })),
    listActions: jest.fn(async () => []),
  });
  const make = (service: any) =>
    new AdminController(
      {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, service
    );
  const admin = { id: 'u-admin', email: 'owner@hookstep.in', isSuperAdmin: true } as any;
  // A workspace owner is "Super Admin" of their own workspace (the org role),
  // which is not User.isSuperAdmin and must not end anyone's plan.
  const orgOwner = { id: 'u-owner', email: 'owner@acme.com', isSuperAdmin: false } as any;
  const req = (cookies: any = {}, headers: any = {}) =>
    ({ cookies, headers: { 'content-type': 'application/json', ...headers } } as any);
  const endBody = {
    organizationId: 'org-d936df7d',
    reason: 'Trial cancelled at Razorpay on 21 Oct, never charged',
    correction: 'PLAN_CORRECTED_ENDED',
  } as any;
  const restoreBody = {
    organizationId: 'org-d936df7d',
    reason: 'Ended by the sweep on bad facts',
    tier: 'PRO',
    period: 'MONTHLY',
  } as any;

  it('refuses every plan endpoint to a user without User.isSuperAdmin, and calls nothing', async () => {
    const service = planActions();
    const c = make(service);
    await expect(c.endPlan(orgOwner, req(), endBody)).rejects.toThrow('Unauthorized');
    await expect(c.restorePlan(orgOwner, req(), restoreBody)).rejects.toThrow('Unauthorized');
    await expect(c.listPlanActions(orgOwner)).rejects.toThrow('Unauthorized');
    await expect(c.endPlan(undefined as any, req(), endBody)).rejects.toThrow('Unauthorized');
    Object.values(service).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  it('refuses to change a plan while impersonating, so the audit names the real admin', async () => {
    const service = planActions();
    const c = make(service);
    await expect(c.endPlan(admin, req({ impersonate: 'uo-1' }), endBody)).rejects.toThrow(
      /Stop impersonating/
    );
    await expect(
      c.restorePlan(admin, req({}, { impersonate: 'uo-1' }), restoreBody)
    ).rejects.toThrow(/Stop impersonating/);
    expect(service.endPlan).not.toHaveBeenCalled();
    expect(service.restorePlan).not.toHaveBeenCalled();
  });

  it('refuses anything but JSON (a cross-site form can post urlencoded with the cookie)', async () => {
    const service = planActions();
    const c = make(service);
    for (const type of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
      undefined,
    ]) {
      const form = req({}, { 'content-type': type });
      await expect(c.endPlan(admin, form, endBody)).rejects.toMatchObject({ status: 415 });
      await expect(c.restorePlan(admin, form, restoreBody)).rejects.toMatchObject({ status: 415 });
    }
    expect(service.endPlan).not.toHaveBeenCalled();
    expect(service.restorePlan).not.toHaveBeenCalled();
  });

  it('a super admin ends and restores as themselves', async () => {
    const service = planActions();
    const c = make(service);

    await c.endPlan(admin, req(), { ...endBody, refundedOn: '2026-10-11T06:00:00.000Z' });
    expect(service.endPlan).toHaveBeenCalledWith(
      { id: 'u-admin', email: 'owner@hookstep.in' },
      {
        organizationId: 'org-d936df7d',
        reason: 'Trial cancelled at Razorpay on 21 Oct, never charged',
        correction: 'PLAN_CORRECTED_ENDED',
        skipCustomerEmail: undefined,
        refundedOn: new Date('2026-10-11T06:00:00.000Z'),
      }
    );

    await c.restorePlan(admin, req(), { ...restoreBody, skipCustomerEmail: true });
    expect(service.restorePlan).toHaveBeenCalledWith(
      { id: 'u-admin', email: 'owner@hookstep.in' },
      {
        organizationId: 'org-d936df7d',
        reason: 'Ended by the sweep on bad facts',
        tier: 'PRO',
        period: 'MONTHLY',
        skipCustomerEmail: true,
        until: null,
      }
    );

    await c.listPlanActions(admin, '25', 'org-d936df7d');
    expect(service.listActions).toHaveBeenCalledWith(25, 'org-d936df7d');
    await c.listPlanActions(admin);
    expect(service.listActions).toHaveBeenLastCalledWith(50, undefined);
  });
});

describe('/admin/plan: super admins only, never while impersonating', () => {
  const planActions = () => ({
    endPlan: jest.fn(async () => ({ ok: true, email: 'sent' })),
    restorePlan: jest.fn(async () => ({ ok: true, email: 'sent' })),
    listActions: jest.fn(async () => []),
  });
  const make = (service: any) =>
    new AdminController(
      {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, service
    );
  const admin = { id: 'u-admin', email: 'owner@hookstep.in', isSuperAdmin: true } as any;
  // A workspace owner is "Super Admin" of their own workspace (the org role),
  // which is not User.isSuperAdmin and must not end anyone's plan.
  const orgOwner = { id: 'u-owner', email: 'owner@acme.com', isSuperAdmin: false } as any;
  const req = (cookies: any = {}, headers: any = {}) =>
    ({ cookies, headers: { 'content-type': 'application/json', ...headers } } as any);
  const endBody = {
    organizationId: 'org-d936df7d',
    reason: 'Trial cancelled at Razorpay on 21 Oct, never charged',
    correction: 'PLAN_CORRECTED_ENDED',
  } as any;
  const restoreBody = {
    organizationId: 'org-d936df7d',
    reason: 'Ended by the sweep on bad facts',
    tier: 'PRO',
    period: 'MONTHLY',
  } as any;

  it('refuses every plan endpoint to a user without User.isSuperAdmin, and calls nothing', async () => {
    const service = planActions();
    const c = make(service);
    await expect(c.endPlan(orgOwner, req(), endBody)).rejects.toThrow('Unauthorized');
    await expect(c.restorePlan(orgOwner, req(), restoreBody)).rejects.toThrow('Unauthorized');
    await expect(c.listPlanActions(orgOwner)).rejects.toThrow('Unauthorized');
    await expect(c.endPlan(undefined as any, req(), endBody)).rejects.toThrow('Unauthorized');
    Object.values(service).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  it('refuses to change a plan while impersonating, so the audit names the real admin', async () => {
    const service = planActions();
    const c = make(service);
    await expect(c.endPlan(admin, req({ impersonate: 'uo-1' }), endBody)).rejects.toThrow(
      /Stop impersonating/
    );
    await expect(
      c.restorePlan(admin, req({}, { impersonate: 'uo-1' }), restoreBody)
    ).rejects.toThrow(/Stop impersonating/);
    expect(service.endPlan).not.toHaveBeenCalled();
    expect(service.restorePlan).not.toHaveBeenCalled();
  });

  it('refuses anything but JSON (a cross-site form can post urlencoded with the cookie)', async () => {
    const service = planActions();
    const c = make(service);
    for (const type of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
      undefined,
    ]) {
      const form = req({}, { 'content-type': type });
      await expect(c.endPlan(admin, form, endBody)).rejects.toMatchObject({ status: 415 });
      await expect(c.restorePlan(admin, form, restoreBody)).rejects.toMatchObject({ status: 415 });
    }
    expect(service.endPlan).not.toHaveBeenCalled();
    expect(service.restorePlan).not.toHaveBeenCalled();
  });

  it('a super admin ends and restores as themselves', async () => {
    const service = planActions();
    const c = make(service);

    await c.endPlan(admin, req(), { ...endBody, refundedOn: '2026-10-11T06:00:00.000Z' });
    expect(service.endPlan).toHaveBeenCalledWith(
      { id: 'u-admin', email: 'owner@hookstep.in' },
      {
        organizationId: 'org-d936df7d',
        reason: 'Trial cancelled at Razorpay on 21 Oct, never charged',
        correction: 'PLAN_CORRECTED_ENDED',
        skipCustomerEmail: undefined,
        refundedOn: new Date('2026-10-11T06:00:00.000Z'),
      }
    );

    await c.restorePlan(admin, req(), { ...restoreBody, skipCustomerEmail: true });
    expect(service.restorePlan).toHaveBeenCalledWith(
      { id: 'u-admin', email: 'owner@hookstep.in' },
      {
        organizationId: 'org-d936df7d',
        reason: 'Ended by the sweep on bad facts',
        tier: 'PRO',
        period: 'MONTHLY',
        skipCustomerEmail: true,
        until: null,
      }
    );

    await c.listPlanActions(admin, '25', 'org-d936df7d');
    expect(service.listActions).toHaveBeenCalledWith(25, 'org-d936df7d');
    await c.listPlanActions(admin);
    expect(service.listActions).toHaveBeenLastCalledWith(50, undefined);
  });
});
