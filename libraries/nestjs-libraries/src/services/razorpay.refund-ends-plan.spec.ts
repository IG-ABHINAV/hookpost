import 'reflect-metadata';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';

/**
 * A refund ends the plan now, whoever made it and whatever its size (owner's
 * decision, 29 Oct 2026). This spec is the break-it pass over that rule:
 * refunds made in the Razorpay dashboard and refunds made with the admin
 * Refund button (which carries notes.source = 'hookpost-admin'), on the
 * current cycle and on an old one, on a superseded subscription, with
 * Razorpay misbehaving (refund.processed before refund.created, both
 * delivered twice, a 5xx on every read, a cancel it refuses), and with
 * payloads an attacker could send (another workspace's orgId, another
 * product's subscription, a clock-skewed created_at).
 *
 * Razorpay, Resend, Redis and the database are fakes: nothing leaves the
 * machine and no live subscription is touched.
 */

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/database/prisma/users/users.service', () => ({
  UsersService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/track/track.service', () => ({
  TrackService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service',
  () => ({ AffiliateService: class {} })
);

// Redis with real SET NX semantics, so every sendOnce claim is exercised.
const redisData = new Map<string, string>();
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      if (args.includes('NX') && redisData.has(key)) return null;
      redisData.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => (redisData.delete(key) ? 1 : 0)),
  },
}));

const sent: any[] = [];
/** The owner's alerts (OWNER_SALES_ALERT_EMAIL), in the order they were made. */
const alerts: any[] = [];
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: jest.fn(async (msg: any) => {
        sent.push(msg);
        return { data: { id: `email_${sent.length}` }, error: null };
      }),
    },
  })),
}));

// Fake Razorpay: objects by path, plus the calls made, so a spec can assert
// that a cancel went out (or did not) and make a read or a cancel fail.
const rzp = new Map<string, any>();
const calls: { method: string; path: string; body?: any }[] = [];
const failPaths = new Map<string, string>();
const mockRequest = jest.fn(async (method: string, path: string, body?: any) => {
  calls.push({ method, path, body });
  const [base, query] = path.split('?');
  const failure = failPaths.get(`${method} ${base}`);
  if (failure) throw new Error(failure);
  const cancel = base.match(/^(\/subscriptions\/[^/]+)\/cancel$/);
  if (method === 'POST' && cancel && rzp.get(cancel[1])) {
    const sub = rzp.get(cancel[1]);
    Object.assign(sub, { status: 'cancelled', ended_at: now() });
    return { ...sub };
  }
  if (method !== 'GET') throw new Error(`unexpected ${method} ${path}`);
  if (base === '/invoices' && query) {
    const sub = new URLSearchParams(query).get('subscription_id');
    return {
      items: [...rzp.values()].filter(
        (o) => o.entity === 'invoice' && o.subscription_id === sub
      ),
    };
  }
  if (base === '/refunds' && query) {
    // GET /v1/refunds: from/to (seconds, inclusive), newest first, paged.
    const q = new URLSearchParams(query);
    const from = Number(q.get('from') || 0);
    const to = Number(q.get('to') || Infinity);
    const skip = Number(q.get('skip') || 0);
    const count = Number(q.get('count') || 10);
    const items = [...rzp.values()]
      .filter((o) => o.entity === 'refund' && o.created_at >= from && o.created_at <= to)
      .sort((a, b) => b.created_at - a.created_at);
    return { entity: 'collection', items: items.slice(skip, skip + count) };
  }
  if (base === '/subscriptions' && query) {
    return { items: [...rzp.values()].filter((o) => o.entity === 'subscription') };
  }
  const hit = rzp.get(base);
  if (!hit) throw new Error(`Razorpay GET ${path} failed (404): not found`);
  return hit;
});
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const ORG = 'org-chai';

const put = (path: string, obj: any) => {
  rzp.set(path, obj);
  return obj;
};

const cancelsOf = (subId: string) =>
  calls.filter((c) => c.method === 'POST' && c.path === `/subscriptions/${subId}/cancel`);

function setup(local: any) {
  let row = local ? { ...local } : null;
  const subscriptions = {
    getSubscriptionByIdentifier: jest.fn(async (id: string) =>
      row && row.identifier === id ? row : null
    ),
    getSubscription: jest.fn(async () => row),
    scheduleCancellation: jest.fn(async (_org: string, _id: string, at: Date) => {
      row = { ...row, cancelAt: at };
    }),
    deleteSubscriptionByOrg: jest.fn(async () => {
      row = null;
    }),
    getLapsedCancellations: jest.fn(async () => []),
  };
  const organizations = {
    getOrgById: jest.fn(async (id: string) => ({
      id,
      name: 'Chai Point Social',
      paymentId: 'cust_1',
    })),
    getTeam: jest.fn(async () => ({ users: [{ user: { email: 'priya@chaipoint.in' } }] })),
  };
  const marked = new Set<string>();
  const ownerAlerts = {
    notify: jest.fn(async (alert: any) => {
      alerts.push(alert);
      return { sent: true };
    }),
    mark: jest.fn(async (key: string) => {
      marked.add(key);
    }),
    unmark: jest.fn(async (key: string) => {
      marked.delete(key);
    }),
    isMarked: jest.fn(async (key: string) => marked.has(key)),
  };
  const razorpay = new RazorpayService(
    subscriptions as any,
    organizations as any,
    {} as any,
    {} as any,
    { voidForRefund: jest.fn(async () => undefined) } as any,
    undefined,
    ownerAlerts as any
  );
  return { razorpay, subscriptions, organizations, ownerAlerts, row: () => row };
}

const standardRow = (identifier: string, extra: any = {}) => ({
  organizationId: ORG,
  identifier,
  subscriptionTier: 'STANDARD',
  period: 'MONTHLY',
  cancelAt: null,
  ...extra,
});

function hookpostSub(id: string, extra: any = {}) {
  return put(`/subscriptions/${id}`, {
    id,
    entity: 'subscription',
    status: 'active',
    plan_id: 'plan_std',
    customer_id: 'cust_1',
    created_at: now() - 40 * DAY,
    current_start: now() - 5 * DAY,
    current_end: now() + 25 * DAY,
    charge_at: now() + 25 * DAY,
    paid_count: 2,
    notes: { service: 'hookpost', orgId: ORG },
    ...extra,
  });
}

/** A subscription charge: its invoice and the captured payment behind it. */
function charge(subId: string, payId: string, extra: any = {}) {
  put(`/invoices/inv_${payId}`, {
    id: `inv_${payId}`,
    entity: 'invoice',
    subscription_id: subId,
    payment_id: payId,
    billing_start: now() - 5 * DAY,
    billing_end: now() + 25 * DAY,
  });
  return put(`/payments/${payId}`, {
    id: payId,
    entity: 'payment',
    amount: 59900,
    currency: 'INR',
    invoice_id: `inv_${payId}`,
    customer_id: 'cust_1',
    status: 'captured',
    captured: true,
    amount_refunded: 0,
    notes: { service: 'hookpost', orgId: ORG },
    ...extra,
  });
}

/** What Razorpay sends for a refund made in the dashboard (notes.comment). */
const dashboardRefund = (id: string, paymentId: string, extra: any = {}) => ({
  id,
  entity: 'refund',
  amount: 59900,
  currency: 'INR',
  payment_id: paymentId,
  notes: { comment: '' },
  status: 'processed',
  created_at: now(),
  ...extra,
});

/** What Razorpay sends for a refund made with the admin Refund button. */
const adminRefund = (id: string, paymentId: string, extra: any = {}) => ({
  ...dashboardRefund(id, paymentId, extra),
  notes: {
    source: 'hookpost-admin',
    refunded_by: 'owner@hookstep.in',
    ...(extra.notes || {}),
  },
});

const webhook = (type: string, refund: any, payment?: any) => ({
  event: type,
  payload: { refund: { entity: refund }, ...(payment ? { payment: { entity: payment } } : {}) },
});

beforeEach(() => {
  rzp.clear();
  redisData.clear();
  calls.length = 0;
  failPaths.clear();
  sent.length = 0;
  alerts.length = 0;
  mockRequest.mockClear();
  process.env.RESEND_API_KEY = 're_test';
  process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
  put('/plans/plan_std', {
    id: 'plan_std',
    notes: { hookpost_key: 'STANDARD|MONTHLY|59900|INR' },
  });
});

afterAll(() => {
  delete process.env.RESEND_API_KEY;
});

describe('a refund ends the plan now, wherever it was made', () => {
  it('from the Razorpay dashboard: the subscription is cancelled and the plan row is gone', async () => {
    const sub = hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_dash');
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_dash', 'pay_dash'), pay)
    );

    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(cancelsOf('sub_live')[0].body).toEqual({ cancel_at_cycle_end: 0 });
    expect(sub.status).toBe('cancelled');
    expect(ctx.row()).toBeNull();
    expect(ctx.subscriptions.scheduleCancellation).not.toHaveBeenCalled();
  });

  it('from the admin Refund button: the same end, by the same webhook', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_admin');
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', adminRefund('rfnd_admin', 'pay_admin'), pay)
    );

    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(ctx.row()).toBeNull();
    // One refund email, saying the plan ended, never "it renews".
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Your plan: Standard · cancelled');
  });

  it('a partial refund of ₹1 ends it just as a full one does', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_part');
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', adminRefund('rfnd_part', 'pay_part', { amount: 100 }), pay)
    );

    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(ctx.row()).toBeNull();
    expect(sent[0].subject).toBe('Your refund of ₹1 is on its way');
  });

  it('a refund of an old cycle of the plan the workspace is still on ends it too', async () => {
    hookpostSub('sub_live', { paid_count: 4 });
    // An invoice from three cycles ago, long outside the current period.
    put('/invoices/inv_pay_old', {
      id: 'inv_pay_old',
      entity: 'invoice',
      subscription_id: 'sub_live',
      payment_id: 'pay_old',
      billing_start: now() - 95 * DAY,
      billing_end: now() - 65 * DAY,
    });
    const pay = put('/payments/pay_old', {
      id: 'pay_old',
      entity: 'payment',
      amount: 59900,
      currency: 'INR',
      invoice_id: 'inv_pay_old',
      status: 'captured',
      captured: true,
      amount_refunded: 0,
      created_at: now() - 95 * DAY,
      notes: { service: 'hookpost', orgId: ORG },
    });
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_old', 'pay_old'), pay)
    );

    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(ctx.row()).toBeNull();
  });

  it('the refund email is in the payment currency, not the workspace tier currency', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_usd', { amount: 1900, currency: 'USD' });
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(
      webhook(
        'refund.processed',
        dashboardRefund('rfnd_usd', 'pay_usd', { amount: 1900, currency: 'USD' }),
        pay
      )
    );

    expect(sent[0].subject).toBe('Your refund of $19 is on its way');
    expect(ctx.row()).toBeNull();
  });
});

describe('a refund that must leave the plan alone', () => {
  it('the ₹5 UPI mandate check (no invoice, refunded by Razorpay itself)', async () => {
    hookpostSub('sub_live');
    const pay = put('/payments/pay_mandate', {
      id: 'pay_mandate',
      entity: 'payment',
      amount: 500,
      currency: 'INR',
      invoice_id: null,
      status: 'refunded',
      captured: true,
      amount_refunded: 500,
      notes: { service: 'hookpost', orgId: ORG },
    });
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(
      webhook(
        'refund.processed',
        { ...dashboardRefund('rfnd_mandate', 'pay_mandate', { amount: 500 }), notes: [] },
        pay
      )
    );

    expect(cancelsOf('sub_live')).toHaveLength(0);
    expect(ctx.row()).not.toBeNull();
  });

  it('a double charge refunded during a plan change: the new plan stays', async () => {
    // The customer moved to Pro on a new mandate; the old Standard mandate
    // debited once more and that charge is refunded.
    hookpostSub('sub_old', { status: 'cancelled', ended_at: now() - 60 });
    hookpostSub('sub_new', { plan_id: 'plan_pro', notes: { service: 'hookpost', orgId: ORG } });
    put('/plans/plan_pro', {
      id: 'plan_pro',
      notes: { hookpost_key: 'PRO|MONTHLY|199900|INR' },
    });
    const pay = charge('sub_old', 'pay_double');
    const ctx = setup(
      standardRow('sub_new', { subscriptionTier: 'PRO' })
    );

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', adminRefund('rfnd_double', 'pay_double'), pay)
    );

    expect(cancelsOf('sub_new')).toHaveLength(0);
    expect(ctx.row()).not.toBeNull();
    expect(ctx.row()!.identifier).toBe('sub_new');
    // The email names the plan the workspace is on, and does not say it ended.
    expect(sent[0].text).toContain('Your plan: Pro · still active');
    expect(alerts[0].notes).toContain(
      "sub_old is not the workspace's current subscription (sub_new): the current plan is unaffected"
    );
  });

  it('a lifetime workspace is never ended by a refund of a Razorpay charge', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_life');
    const ctx = setup(standardRow('sub_live', { isLifetime: true }));

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_life', 'pay_life'), pay)
    );

    expect(cancelsOf('sub_live')).toHaveLength(0);
    expect(ctx.row()).not.toBeNull();
  });

  it("another product's charge on the shared account: nothing read, nothing ended", async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_other', {
      notes: { service: 'tablamigo', orgId: 'org-other' },
      invoice_id: null,
    });
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_other', 'pay_other'), pay)
    );

    expect(cancelsOf('sub_live')).toHaveLength(0);
    expect(ctx.row()).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('a refund of an uncaptured payment is no charge: the plan stays', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_auth', {
      status: 'authorized',
      captured: false,
    });
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_auth', 'pay_auth'), pay)
    );

    expect(cancelsOf('sub_live')).toHaveLength(0);
    expect(ctx.row()).not.toBeNull();
  });
});

describe('an attacker cannot end a plan with a refund payload', () => {
  it('orgId put on the refund itself is never read: only the payment and subscription say whose it is', async () => {
    hookpostSub('sub_live');
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', {
        ...dashboardRefund('rfnd_forged', 'pay_nope'),
        notes: { service: 'hookpost', orgId: ORG },
      })
    );

    expect(cancelsOf('sub_live')).toHaveLength(0);
    expect(ctx.row()).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("a payment entity in the event that is not the refund's payment is not trusted", async () => {
    // The event carries a Hookpost payment, but the refund names another one
    // that Razorpay does not know: the real payment is read, not the attached
    // one, so nothing is ended.
    hookpostSub('sub_live');
    const planted = charge('sub_live', 'pay_real');
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_mismatch', 'pay_unknown'), planted)
    );

    expect(cancelsOf('sub_live')).toHaveLength(0);
    expect(ctx.row()).not.toBeNull();
  });

  it('a refund without an id or a payment id is dropped before any read', async () => {
    hookpostSub('sub_live');
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(webhook('refund.processed', { amount: 59900 }));
    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', { id: 'rfnd_x', amount: 59900 })
    );

    expect(calls).toHaveLength(0);
    expect(ctx.row()).not.toBeNull();
  });

  it('a created_at far in the future (clock skew) changes nothing but the date on the email', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_skew');
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(
      webhook(
        'refund.processed',
        dashboardRefund('rfnd_skew', 'pay_skew', { created_at: now() + 400 * DAY }),
        pay
      )
    );

    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(ctx.row()).toBeNull();
    expect(sent).toHaveLength(1);
  });
});

describe('Razorpay misbehaving', () => {
  it('refund.processed before refund.created: ended once, emailed once', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_order');
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_order', 'pay_order'), pay)
    );
    await ctx.razorpay.handleWebhook(
      webhook('refund.created', dashboardRefund('rfnd_order', 'pay_order'), pay)
    );

    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(ctx.row()).toBeNull();
  });

  it('the same refund.processed delivered four times (its 24 h retry): one cancel, one email', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_retry');
    const ctx = setup(standardRow('sub_live'));
    const event = webhook('refund.processed', dashboardRefund('rfnd_retry', 'pay_retry'), pay);

    for (let i = 0; i < 4; i++) await ctx.razorpay.handleWebhook(event);

    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(ctx.row()).toBeNull();
  });

  it('a refund.created whose invoice cannot be read waits for refund.processed instead of guessing', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_5xx');
    const ctx = setup(standardRow('sub_live'));

    failPaths.set('GET /invoices/inv_pay_5xx', 'Razorpay GET /invoices failed (502): bad gateway');
    await ctx.razorpay.handleWebhook(
      webhook('refund.created', dashboardRefund('rfnd_5xx', 'pay_5xx'), pay)
    );
    expect(cancelsOf('sub_live')).toHaveLength(0);
    expect(ctx.row()).not.toBeNull();
    expect(sent).toHaveLength(0);

    // Razorpay is back when refund.processed lands, and the plan ends then.
    failPaths.clear();
    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_5xx', 'pay_5xx'), pay)
    );
    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(ctx.row()).toBeNull();
  });

  it('a pending refund.created is not acted on; the processed one that follows is', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_pending');
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.handleWebhook(
      webhook(
        'refund.created',
        dashboardRefund('rfnd_pending', 'pay_pending', { status: 'pending' }),
        pay
      )
    );
    expect(calls).toHaveLength(0);
    expect(ctx.row()).not.toBeNull();

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_pending', 'pay_pending'), pay)
    );
    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(ctx.row()).toBeNull();
  });

  it('a cancel Razorpay refuses leaves everything as it was, and tells nobody the plan ended', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_refuse');
    const ctx = setup(standardRow('sub_live'));
    failPaths.set(
      'POST /subscriptions/sub_live/cancel',
      'Razorpay POST /subscriptions/sub_live/cancel failed (400): cannot cancel'
    );

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_refuse', 'pay_refuse'), pay)
    );

    expect(ctx.row()).not.toBeNull();
    expect(ctx.subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    // No customer email at all: the plan is not settled yet.
    expect(sent).toHaveLength(0);
    // The owner is told to cancel it in the dashboard, under its own key, so
    // a later refund event still has the plain refund alert to send.
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe('refund-cancel-refused:rfnd_refuse');
    expect(alerts[0].notes).toContain(
      'Refunded, so the plan should end, but Razorpay refused the cancel: cancel it in the dashboard'
    );

    // And the claim is freed, so a later refund event can still end it.
    failPaths.clear();
    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_refuse2', 'pay_refuse'), pay)
    );
    expect(ctx.row()).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Your plan: Standard · cancelled');
  });

  it('a cancel that fails because the customer had already cancelled still ends the plan', async () => {
    // Razorpay takes one cancel per subscription: the customer cancelled at
    // the cycle end, so the refund's cancel is refused, but it really is
    // cancelled and the plan must end now all the same.
    hookpostSub('sub_live', { status: 'cancelled', end_at: now() + 25 * DAY });
    const pay = charge('sub_live', 'pay_twice');
    const ctx = setup(standardRow('sub_live'));
    failPaths.set(
      'POST /subscriptions/sub_live/cancel',
      'Razorpay POST /subscriptions/sub_live/cancel failed (400): already cancelled'
    );

    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_twice', 'pay_twice'), pay)
    );

    expect(ctx.row()).toBeNull();
  });

  it('a payment read Razorpay cannot answer (503) fails the webhook, so the refund comes back', async () => {
    // refund.processed is the last event there is: swallowing it would leave
    // a refunded workspace on a paid plan for good, because nothing else
    // looks for refunds. The webhook must fail so Razorpay redelivers it.
    hookpostSub('sub_live');
    charge('sub_live', 'pay_down');
    const ctx = setup(standardRow('sub_live'));
    failPaths.set('GET /payments/pay_down', 'Razorpay GET /payments/pay_down failed (503)');

    await expect(
      ctx.razorpay.handleWebhook(
        webhook('refund.processed', dashboardRefund('rfnd_down', 'pay_down'))
      )
    ).rejects.toThrow(/rfnd_down/);
    expect(ctx.row()).not.toBeNull();
    expect(sent).toHaveLength(0);
    expect(alerts).toHaveLength(0);

    // Razorpay is back on the redelivery, and the plan ends then.
    failPaths.clear();
    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_down', 'pay_down'))
    );
    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(ctx.row()).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('an invoice read Razorpay cannot answer is never read as "not a subscription charge"', async () => {
    // The charge is a subscription's; only the invoice read failed. Calling
    // it a one-off would leave the plan on and email the customer that it is
    // unchanged, which is the opposite of what the refund means.
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_inv5xx');
    const ctx = setup(standardRow('sub_live'));
    failPaths.set(
      'GET /invoices/inv_pay_inv5xx',
      'Razorpay GET /invoices/inv_pay_inv5xx failed (502): bad gateway'
    );

    await expect(
      ctx.razorpay.handleWebhook(
        webhook('refund.processed', dashboardRefund('rfnd_inv5xx', 'pay_inv5xx'), pay)
      )
    ).rejects.toThrow(/rfnd_inv5xx/);
    expect(cancelsOf('sub_live')).toHaveLength(0);
    expect(ctx.row()).not.toBeNull();
    expect(sent).toHaveLength(0);

    failPaths.clear();
    await ctx.razorpay.handleWebhook(
      webhook('refund.processed', dashboardRefund('rfnd_inv5xx', 'pay_inv5xx'), pay)
    );
    expect(ctx.row()).toBeNull();
  });

  it('a subscription read Razorpay cannot answer fails the webhook too', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_sub5xx');
    const ctx = setup(standardRow('sub_live'));
    failPaths.set(
      'GET /subscriptions/sub_live',
      'Razorpay GET /subscriptions/sub_live failed (504): gateway timeout'
    );

    await expect(
      ctx.razorpay.handleWebhook(
        webhook('refund.processed', dashboardRefund('rfnd_sub5xx', 'pay_sub5xx'), pay)
      )
    ).rejects.toThrow(/rfnd_sub5xx/);
    expect(cancelsOf('sub_live')).toHaveLength(0);
    expect(ctx.row()).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('a rate-limited read (429) is not "not found": the webhook fails and comes back', async () => {
    hookpostSub('sub_live');
    charge('sub_live', 'pay_429');
    const ctx = setup(standardRow('sub_live'));
    failPaths.set('GET /payments/pay_429', 'Razorpay GET /payments/pay_429 failed (429): Too many requests');

    await expect(
      ctx.razorpay.handleWebhook(webhook('refund.processed', dashboardRefund('rfnd_429', 'pay_429')))
    ).rejects.toThrow(/rfnd_429/);
    expect(ctx.row()).not.toBeNull();

    failPaths.clear();
    await ctx.razorpay.handleWebhook(webhook('refund.processed', dashboardRefund('rfnd_429', 'pay_429')));
    expect(ctx.row()).toBeNull();
  });

  it('a read Razorpay refuses (404) is settled: dropped once, not asked for again', async () => {
    // A payment Razorpay does not know is an answer, not a failure: retrying
    // it for 24 hours would only fill the log.
    hookpostSub('sub_live');
    const ctx = setup(standardRow('sub_live'));

    await expect(
      ctx.razorpay.handleWebhook(
        webhook('refund.processed', dashboardRefund('rfnd_404', 'pay_gone'))
      )
    ).resolves.toEqual({ ok: true });
    expect(ctx.row()).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('a refund.created Razorpay cannot be read for still waits for refund.processed', async () => {
    // Only refund.processed is worth a redelivery: refund.created is always
    // followed by one.
    hookpostSub('sub_live');
    charge('sub_live', 'pay_c5xx');
    const ctx = setup(standardRow('sub_live'));
    failPaths.set('GET /payments/pay_c5xx', 'Razorpay GET /payments/pay_c5xx failed (503)');

    await expect(
      ctx.razorpay.handleWebhook(
        webhook('refund.created', dashboardRefund('rfnd_c5xx', 'pay_c5xx'))
      )
    ).resolves.toEqual({ ok: true });
    expect(ctx.row()).not.toBeNull();
  });
});

describe('a refund whose webhook never arrives: the hourly refund sweep', () => {
  // Razorpay gives up on a webhook after 24 hours of failures, and a refund
  // event left out of the webhook's event list is never sent at all. Without
  // a sweep the refunded workspace would keep its paid plan for good.
  const refundOnAccount = (refund: any) => put(`/refunds/${refund.id}`, refund);

  it('a dashboard refund with no webhook at all ends the plan on the next sweep, once', async () => {
    const sub = hookpostSub('sub_live');
    charge('sub_live', 'pay_nohook');
    refundOnAccount(dashboardRefund('rfnd_nohook', 'pay_nohook', { created_at: now() - 3600 }));
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.sweepMissedRefunds();

    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(sub.status).toBe('cancelled');
    expect(ctx.row()).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Your plan: Standard · cancelled');

    // The next hour's sweep sees the same refund: nothing more happens.
    await ctx.razorpay.sweepMissedRefunds();
    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('a refund the webhook already settled is left as it is', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_hooked');
    const refund = refundOnAccount(adminRefund('rfnd_hooked', 'pay_hooked'));
    const ctx = setup(standardRow('sub_live'));
    await ctx.razorpay.handleWebhook(webhook('refund.processed', refund, pay));
    const keysBefore = new Set(alerts.map((a) => a.key));

    await ctx.razorpay.sweepMissedRefunds();

    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(sent).toHaveLength(1);
    // OwnerSalesAlertService sends one email per key: no new key, no new alert.
    expect(new Set(alerts.map((a) => a.key))).toEqual(keysBefore);
  });

  it('a refund still pending is left for a later sweep, and ends the plan once processed', async () => {
    hookpostSub('sub_live');
    charge('sub_live', 'pay_slow');
    const refund = refundOnAccount(
      dashboardRefund('rfnd_slow', 'pay_slow', { status: 'pending', created_at: now() - 600 })
    );
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.sweepMissedRefunds();
    expect(cancelsOf('sub_live')).toHaveLength(0);
    expect(ctx.row()).not.toBeNull();

    refund.status = 'processed';
    await ctx.razorpay.sweepMissedRefunds();
    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(ctx.row()).toBeNull();
  });

  it('the ₹5 mandate check and a superseded plan\'s refund change nothing on a sweep either', async () => {
    hookpostSub('sub_old', { status: 'cancelled' });
    hookpostSub('sub_new');
    charge('sub_old', 'pay_dup');
    put('/payments/pay_mandate', {
      id: 'pay_mandate',
      entity: 'payment',
      amount: 500,
      currency: 'INR',
      status: 'refunded',
      invoice_id: null,
      notes: [],
    });
    refundOnAccount(dashboardRefund('rfnd_dup', 'pay_dup'));
    refundOnAccount(dashboardRefund('rfnd_mandate', 'pay_mandate', { amount: 500, notes: [] }));
    const ctx = setup(standardRow('sub_new'));

    await ctx.razorpay.sweepMissedRefunds();

    expect(cancelsOf('sub_new')).toHaveLength(0);
    expect(ctx.row()).toMatchObject({ identifier: 'sub_new' });
  });

  it('a refund older than the look-back window is not read at all', async () => {
    hookpostSub('sub_live');
    charge('sub_live', 'pay_ancient');
    refundOnAccount(dashboardRefund('rfnd_ancient', 'pay_ancient', { created_at: now() - 30 * DAY }));
    const ctx = setup(standardRow('sub_live'));

    await ctx.razorpay.sweepMissedRefunds();

    expect(calls.some((c) => c.path.startsWith('/payments/'))).toBe(false);
    expect(ctx.row()).not.toBeNull();
  });

  it('Razorpay down: the sweep never throws, and one refund it could not read does not hold up the others', async () => {
    const ctx = setup(standardRow('sub_live'));
    failPaths.set('GET /refunds', 'Razorpay GET /refunds failed (502)');
    await expect(ctx.razorpay.sweepMissedRefunds()).resolves.toBeDefined();
    failPaths.clear();

    hookpostSub('sub_live');
    charge('sub_live', 'pay_live');
    put('/payments/pay_other', { id: 'pay_other', entity: 'payment', status: 'captured' });
    refundOnAccount(dashboardRefund('rfnd_other', 'pay_other', { created_at: now() - 60 }));
    refundOnAccount(dashboardRefund('rfnd_live', 'pay_live', { created_at: now() - 120 }));
    failPaths.set('GET /payments/pay_other', 'Razorpay GET /payments/pay_other failed (503)');

    const report = await ctx.razorpay.sweepMissedRefunds();

    expect(report).toMatchObject({ unreadable: 1 });
    expect(ctx.row()).toBeNull();
    expect(cancelsOf('sub_live')).toHaveLength(1);
  });

  it('the backend and the orchestrator sweeping at the same moment cancel once', async () => {
    hookpostSub('sub_live');
    charge('sub_live', 'pay_twice');
    refundOnAccount(dashboardRefund('rfnd_twice', 'pay_twice', { created_at: now() - 60 }));
    const ctx = setup(standardRow('sub_live'));

    await Promise.all([ctx.razorpay.sweepMissedRefunds(), ctx.razorpay.sweepMissedRefunds()]);

    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(ctx.subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it('pages through every refund in the window', async () => {
    hookpostSub('sub_live');
    charge('sub_live', 'pay_deep');
    for (let i = 0; i < 120; i++) {
      put(`/payments/pay_x${i}`, { id: `pay_x${i}`, entity: 'payment', status: 'refunded', notes: { service: 'tablamigo' } });
      refundOnAccount(dashboardRefund(`rfnd_x${i}`, `pay_x${i}`, { created_at: now() - 60 - i }));
    }
    // The oldest of all, on the second page.
    refundOnAccount(dashboardRefund('rfnd_deep', 'pay_deep', { created_at: now() - 3 * 3600 }));
    const ctx = setup(standardRow('sub_live'));

    const report = await ctx.razorpay.sweepMissedRefunds();

    expect(report.seen).toBe(121);
    expect(ctx.row()).toBeNull();
  });
});
