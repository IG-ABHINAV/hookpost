import 'reflect-metadata';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import {
  paymentFailedEmail,
  refundEmail,
  subscriptionCancelledEmail,
  subscriptionWelcomeEmail,
  trialReminderEmail,
} from '@hookpost/nestjs-libraries/emails/templates/billing.emails';

// Customer emails for subscription.cancelled and refund.* webhooks. Razorpay,
// Resend, Redis and the database are all fakes: nothing leaves the machine.

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

// Redis with real SET NX semantics, so the dedupe is actually exercised.
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
const mockSend = jest.fn(async (msg: any) => {
  sent.push(msg);
  return { data: { id: `email_${sent.length}` }, error: null };
});
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

// Fake Razorpay: objects by path.
const rzp = new Map<string, any>();
const mockRequest = jest.fn(async (method: string, path: string, _body?: any) => {
  const [base, query] = path.split('?');
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
  if (base === '/subscriptions' && query) {
    return { items: [...rzp.values()].filter((o) => o.entity === 'subscription') };
  }
  const hit = rzp.get(base);
  if (!hit) throw new Error(`404 ${path}`);
  return hit;
});
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const ORG = 'org-chai';

function put(path: string, obj: any) {
  rzp.set(path, obj);
  return obj;
}

function setup(local: any) {
  let row = local ? { ...local } : null;
  const subscriptions = {
    getSubscriptionByIdentifier: jest.fn(async (id: string) =>
      row && row.identifier === id ? row : null
    ),
    // By workspace, as the real one is: a plan is only ever this org's.
    getSubscription: jest.fn(async (org: string) =>
      row && row.organizationId === org ? row : null
    ),
    scheduleCancellation: jest.fn(async (_org: string, _id: string, at: Date) => {
      row = { ...row, cancelAt: at };
    }),
    deleteSubscriptionByOrg: jest.fn(async () => {
      row = null;
    }),
    getLapsedCancellations: jest.fn(async (at: Date) =>
      row && row.cancelAt && row.cancelAt < at ? [row] : []
    ),
    // A charge writes the row, as the real one does: the identifier can be a
    // new mandate's, which is what makes clearPaymentFailing find it.
    createOrUpdateSubscription: jest.fn(
      async (
        _trial: boolean,
        identifier: string,
        _customer: string,
        _channels: number,
        tier: string,
        period: string,
        cancelAt: number | null,
        _code?: string,
        org?: string
      ) => {
        row = {
          ...(row || { organizationId: org }),
          identifier,
          subscriptionTier: String(tier).toUpperCase(),
          period: String(period).toUpperCase(),
          cancelAt: cancelAt ? new Date(cancelAt * 1000) : null,
        };
        return row;
      }
    ),
    updateCustomerId: jest.fn(async () => {}),
    markPaymentFailing: jest.fn(async (_org: string, id: string, since: Date) => {
      if (!row || row.identifier !== id || row.paymentFailingSince) return 0;
      row = { ...row, paymentFailingSince: since };
      return 1;
    }),
    clearPaymentFailing: jest.fn(async (id: string) => {
      if (!row || row.identifier !== id || !row.paymentFailingSince) return 0;
      row = { ...row, paymentFailingSince: null };
      return 1;
    }),
  };
  const organizations = {
    getOrgById: jest.fn(async (id: string) => ({ id, name: 'Chai Point Social', paymentId: 'cust_1' })),
    getTeam: jest.fn(async () => ({ users: [{ user: { email: 'priya@chaipoint.in' } }] })),
  };
  const razorpay = new RazorpayService(
    subscriptions as any,
    organizations as any,
    {} as any,
    {} as any,
    { recordCommission: jest.fn(async () => {}), voidForRefund: jest.fn(async () => undefined) } as any
  );
  return { razorpay, subscriptions, row: () => row };
}

const standardRow = (identifier: string) => ({
  organizationId: ORG,
  identifier,
  subscriptionTier: 'STANDARD',
  period: 'MONTHLY',
  cancelAt: null,
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
    notes: { service: 'hookpost', orgId: ORG },
    ...extra,
  });
}

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

const refund = (id: string, paymentId: string, amount = 59900, status = 'processed') => ({
  id,
  entity: 'refund',
  amount,
  currency: 'INR',
  payment_id: paymentId,
  notes: { comment: '' },
  status,
  created_at: now(),
});

beforeEach(() => {
  rzp.clear();
  redisData.clear();
  sent.length = 0;
  mockSend.mockClear();
  process.env.RESEND_API_KEY = 're_test';
  // Prisma loads the repo's .env when the client is imported, so on a
  // development machine FRONTEND_URL is localhost and every link in these
  // emails would be the local one. Pinned like the owner-alert specs do.
  process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
  put('/plans/plan_std', { id: 'plan_std', notes: { hookpost_key: 'STANDARD|MONTHLY|59900|INR' } });
});

describe('subscription.cancelled email', () => {
  it('mid-cycle cancel from the dashboard keeps the plan until current_end, emails once', async () => {
    const sub = hookpostSub('sub_live', { status: 'cancelled', ended_at: now() });
    charge('sub_live', 'pay_1');
    const { razorpay, subscriptions, row } = setup(standardRow('sub_live'));

    const event = { event: 'subscription.cancelled', payload: { subscription: { entity: sub } } };
    await razorpay.handleWebhook(event);
    await razorpay.handleWebhook(event); // Razorpay retry

    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(row()!.cancelAt!.getTime()).toBe(sub.current_end * 1000);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('priya@chaipoint.in');
    expect(sent[0].subject).toBe('Your Hookpost plan is cancelled');
    const until = new Date(sub.current_end * 1000).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
    });
    expect(sent[0].text).toContain(`Paid access until: ${until}`);
    expect(sent[0].text).toContain('Future charges: None');
    expect(sent[0].text).toContain("you won't be charged again");
    expect(sent[0].text).toContain('Resubscribe: https://hookpost.hookstep.in/billing');
    // The operator line is required; the legal entity must never appear.
    expect(sent[0].text).toContain('Hookpost by Hookstep · Ghatkopar, Mumbai, India');
    expect(sent[0].html).toContain('Hookpost by Hookstep · Ghatkopar, Mumbai, India');
    expect(sent[0].html + sent[0].text).not.toMatch(/JR Consulting/i);
  });

  it('the grace sweep downgrades only after current_end, and only a cancelled Razorpay sub', async () => {
    const sub = hookpostSub('sub_live', { status: 'cancelled', ended_at: now() });
    charge('sub_live', 'pay_1');
    const { razorpay, subscriptions } = setup(standardRow('sub_live'));
    await razorpay.handleWebhook({ event: 'subscription.cancelled', payload: { subscription: { entity: sub } } });

    expect(await razorpay.endLapsedCancellations(new Date())).toEqual({ checked: 0, ended: 0 });
    // A day after the paid period, while Razorpay still reports the paid end.
    const later = new Date((sub.current_end + DAY) * 1000);
    sub.status = 'active'; // never downgrade a sub Razorpay says is live
    expect(await razorpay.endLapsedCancellations(later)).toEqual({ checked: 1, ended: 0 });
    sub.status = 'cancelled';
    sub.current_end = now() - 60;
    expect(await razorpay.endLapsedCancellations(later)).toEqual({ checked: 1, ended: 1 });
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
  });

  it('tells the customer the plan has ended on the day the paid time runs out, once', async () => {
    // The other half of the "works until <date>" they got when they
    // cancelled: Cancel stops the mandate at Razorpay at once, so the row is
    // what keeps the plan alive until the date, and nothing used to say when
    // it finally went.
    const sub = hookpostSub('sub_live', { status: 'cancelled', ended_at: now() });
    charge('sub_live', 'pay_1');
    const { razorpay, subscriptions } = setup(standardRow('sub_live'));
    await razorpay.handleWebhook({ event: 'subscription.cancelled', payload: { subscription: { entity: sub } } });
    sent.length = 0;

    const later = new Date((sub.current_end + DAY) * 1000);
    sub.current_end = now() - 60;
    expect(await razorpay.endLapsedCancellations(later)).toEqual({ checked: 1, ended: 1 });
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Your Hookpost Standard plan has ended');
    expect(sent[0].text).toContain('has run out, so the plan has now ended');
    expect(sent[0].text).toContain("You weren't charged again");
    expect(sent[0].text).toContain('Future charges: None');
    expect(sent[0].text).toContain('Choose a plan: https://hookpost.hookstep.in/billing');

    // A second sweep of the same subscription says nothing more.
    await razorpay.endLapsedCancellations(later);
    expect(sent).toHaveLength(1);
  });

  it('cycle-end cancel: the period is over, so the plan ends now and the email says so', async () => {
    const sub = hookpostSub('sub_end', { status: 'cancelled', current_end: now() - 10, ended_at: now() - 10 });
    const { razorpay, subscriptions } = setup(standardRow('sub_end'));
    await razorpay.handleWebhook({ event: 'subscription.cancelled', payload: { subscription: { entity: sub } } });
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Plan ended:');
    expect(sent[0].text).toContain('The workspace is now on the Free plan');
  });

  it('a cancel after the period was refunded ends the plan now', async () => {
    const sub = hookpostSub('sub_ref', { status: 'cancelled', ended_at: now() });
    charge('sub_ref', 'pay_r', { amount_refunded: 59900 });
    const { razorpay, subscriptions } = setup(standardRow('sub_ref'));
    await razorpay.handleWebhook({ event: 'subscription.cancelled', payload: { subscription: { entity: sub } } });
    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
    expect(sent[0].text).toContain('Plan ended:');
  });

  it('a plan switch (newer approved Hookpost sub) keeps the plan but sends no email', async () => {
    const old = hookpostSub('sub_old', { status: 'cancelled', ended_at: now() });
    hookpostSub('sub_new', { status: 'authenticated', created_at: now() });
    const { razorpay } = setup(standardRow('sub_old'));
    await razorpay.handleWebhook({ event: 'subscription.cancelled', payload: { subscription: { entity: old } } });
    expect(sent).toHaveLength(0);
  });

  it('a newer checkout nobody approved is not a plan switch: the cancellation is still emailed', async () => {
    // Reactivate answered "Not now", or a Pro checkout closed: Razorpay
    // still lists that subscription as `created`.
    const old = hookpostSub('sub_old', { status: 'cancelled', current_end: now() - 10, ended_at: now() - 10 });
    hookpostSub('sub_stray', { status: 'created', created_at: now() });
    const { razorpay, subscriptions } = setup(standardRow('sub_old'));
    await razorpay.handleWebhook({ event: 'subscription.cancelled', payload: { subscription: { entity: old } } });
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Your Hookpost plan is cancelled');
  });

  it('a subscription Hookpost does not hold is ignored', async () => {
    const other = hookpostSub('sub_unknown', { status: 'cancelled', notes: { service: 'tablamigo' } });
    const { razorpay, subscriptions } = setup(standardRow('sub_mine'));
    await razorpay.handleWebhook({ event: 'subscription.cancelled', payload: { subscription: { entity: other } } });
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe('refund emails', () => {
  it('refund.created (processed) then refund.processed send one email; a partial refund ends the plan', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_1', { amount_refunded: 10000 });
    const { razorpay, subscriptions } = setup(standardRow('sub_live'));
    const r = refund('rfnd_1', 'pay_1', 10000);

    await razorpay.handleWebhook({ event: 'refund.created', payload: { refund: { entity: r }, payment: { entity: pay } } });
    await razorpay.handleWebhook({ event: 'refund.processed', payload: { refund: { entity: r }, payment: { entity: pay } } });
    await razorpay.handleWebhook({ event: 'refund.processed', payload: { refund: { entity: r }, payment: { entity: pay } } });

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Your refund of ₹100 is on its way');
    expect(sent[0].text).toContain('Refund ID: rfnd_1');
    expect(sent[0].text).toContain('usually reaches your bank in 5–7 working days');
    expect(sent[0].text).toContain('Your plan: Standard · cancelled');
    expect(sent[0].text).toContain('Because this payment was refunded, your plan has ended now.');
    expect(sent[0].text).not.toContain('renews on');
    expect(mockRequest).toHaveBeenCalledWith('POST', '/subscriptions/sub_live/cancel', { cancel_at_cycle_end: 0 });
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
  });

  it('a pending refund.created waits for refund.processed', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_1');
    const { razorpay } = setup(standardRow('sub_live'));
    const r = refund('rfnd_p', 'pay_1', 10000, 'pending');
    await razorpay.handleWebhook({ event: 'refund.created', payload: { refund: { entity: r }, payment: { entity: pay } } });
    expect(sent).toHaveLength(0);
    await razorpay.handleWebhook({ event: 'refund.processed', payload: { refund: { entity: { ...r, status: 'processed' } }, payment: { entity: pay } } });
    expect(sent).toHaveLength(1);
  });

  it('a partial refund of a cancelled sub in its grace period ends the plan and says cancelled', async () => {
    const sub = hookpostSub('sub_c', { status: 'cancelled', ended_at: now() });
    const pay = charge('sub_c', 'pay_c');
    const { razorpay, subscriptions } = setup({ ...standardRow('sub_c'), cancelAt: new Date(sub.current_end * 1000) });
    await razorpay.handleWebhook({ event: 'refund.processed', payload: { refund: { entity: refund('rfnd_c', 'pay_c', 49300) }, payment: { entity: pay } } });
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
    expect(sent[0].subject).toBe('Your refund of ₹493 is on its way');
    expect(sent[0].text).toContain('Your plan: Standard · cancelled');
    expect(sent[0].text).toContain('Resubscribe: https://hookpost.hookstep.in/billing');
  });

  it('fetches the payment when the event has none', async () => {
    hookpostSub('sub_live');
    charge('sub_live', 'pay_1');
    const { razorpay } = setup(standardRow('sub_live'));
    await razorpay.handleWebhook({ event: 'refund.processed', payload: { refund: { entity: refund('rfnd_2', 'pay_1', 10000) } } });
    expect(sent).toHaveLength(1);
  });

  it('ignores the Rs 5 mandate-authorisation refund (no invoice, no notes)', async () => {
    const pay = put('/payments/pay_auth', { id: 'pay_auth', amount: 500, currency: 'INR', invoice_id: null, notes: [], customer_id: 'cust_1' });
    const { razorpay } = setup(standardRow('sub_live'));
    await razorpay.handleWebhook({ event: 'refund.processed', payload: { refund: { entity: refund('rfnd_auth', 'pay_auth', 500) }, payment: { entity: pay } } });
    expect(sent).toHaveLength(0);
  });

  it("ignores another product's refund", async () => {
    put('/subscriptions/sub_tm', { id: 'sub_tm', status: 'cancelled', notes: { service: 'tablamigo', user_id: 'u1' } });
    const pay = charge('sub_tm', 'pay_tm', { notes: { service: 'tablamigo', user_id: 'u1' } });
    const { razorpay } = setup(standardRow('sub_live'));
    await razorpay.handleWebhook({ event: 'refund.processed', payload: { refund: { entity: refund('rfnd_tm', 'pay_tm') }, payment: { entity: pay } } });
    expect(sent).toHaveLength(0);
  });

  it('a failed send releases the claim so a redelivery can retry', async () => {
    hookpostSub('sub_live');
    const pay = charge('sub_live', 'pay_1');
    const { razorpay } = setup(standardRow('sub_live'));
    mockSend.mockImplementationOnce(async () => ({ data: null, error: { message: 'rate limited' } }) as any);
    const ev = { event: 'refund.processed', payload: { refund: { entity: refund('rfnd_3', 'pay_1', 10000) }, payment: { entity: pay } } };
    await razorpay.handleWebhook(ev);
    expect(sent).toHaveLength(0);
    await razorpay.handleWebhook(ev);
    expect(sent).toHaveLength(1);
  });
});

describe('failure emails: one per billing cycle', () => {
  const failed = (id: string, extra: any = {}) => ({
    id,
    entity: 'payment',
    status: 'failed',
    amount: 59900,
    currency: 'INR',
    customer_id: 'cust_1',
    error_description: 'Insufficient balance in your account',
    ...extra,
  });
  const pendingEvent = (sub: any, payment?: any) => ({
    event: 'subscription.pending',
    payload: {
      subscription: { entity: { ...sub } },
      ...(payment ? { payment: { entity: payment } } : {}),
    },
  });
  const paymentFailedEvent = (payment: any) => ({
    event: 'payment.failed',
    payload: { payment: { entity: payment } },
  });

  it('payment.failed on a Hookpost subscription invoice sends nothing; subscription.pending sends the one email', async () => {
    const sub = hookpostSub('sub_live', { status: 'pending', paid_count: 2 });
    const pay = charge('sub_live', 'pay_f1', { status: 'failed', error_description: 'Insufficient balance in your account' });
    const { razorpay } = setup(standardRow('sub_live'));

    await razorpay.handleWebhook(paymentFailedEvent(pay));
    expect(sent).toHaveLength(0);

    await razorpay.handleWebhook(pendingEvent(sub, pay));
    expect(sent.map((m) => m.subject)).toEqual(["Your Hookpost payment didn't go through"]);
  });

  it('subscription.pending fired twice in one cycle (two failed attempts) sends exactly one email', async () => {
    const sub = hookpostSub('sub_live', { status: 'pending', paid_count: 2 });
    const { razorpay } = setup(standardRow('sub_live'));

    await razorpay.handleWebhook(pendingEvent(sub, failed('pay_a1')));
    await razorpay.handleWebhook(paymentFailedEvent(failed('pay_a1')));
    await razorpay.handleWebhook(pendingEvent(sub, failed('pay_a2')));
    await razorpay.handleWebhook(paymentFailedEvent(failed('pay_a2')));

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('priya@chaipoint.in');
  });

  it('the next cycle failing gets its own email, and a halt its own', async () => {
    const sub = hookpostSub('sub_live', { status: 'pending', paid_count: 2 });
    const { razorpay } = setup(standardRow('sub_live'));

    await razorpay.handleWebhook(pendingEvent(sub));
    await razorpay.handleWebhook(
      pendingEvent({ ...sub, current_start: sub.current_start + 30 * DAY })
    );
    expect(sent).toHaveLength(2);

    await razorpay.handleWebhook({
      event: 'subscription.halted',
      payload: { subscription: { entity: { ...sub, status: 'halted', halted_at: now() } } },
    });
    expect(sent.map((m) => m.subject)).toEqual([
      "Your Hookpost payment didn't go through",
      "Your Hookpost payment didn't go through",
      'Action needed: Hookpost renewal paused',
    ]);
  });

  it("a trial's first charge retried: one email even once Razorpay sets current_start", async () => {
    const startAt = now() - DAY;
    const sub = hookpostSub('sub_trial', {
      status: 'pending',
      paid_count: 0,
      start_at: startAt,
      current_start: null,
      current_end: null,
    });
    const { razorpay } = setup(standardRow('sub_trial'));

    await razorpay.handleWebhook(pendingEvent(sub, failed('pay_t1')));
    await razorpay.handleWebhook(
      pendingEvent({ ...sub, current_start: startAt + 3600, current_end: startAt + 30 * DAY }, failed('pay_t2'))
    );

    expect(sent.map((m) => m.subject)).toEqual([
      "Your first Hookpost payment didn't go through yet",
    ]);
  });

  it('a dollar plan failing with no payment on the event: dollars, a card, never UPI or rupees', async () => {
    put('/plans/plan_usd', { id: 'plan_usd', item: { amount: 1900, currency: 'USD' }, notes: { hookpost_key: 'STANDARD|MONTHLY|1900|USD' } });
    const sub = hookpostSub('sub_usd', { status: 'pending', paid_count: 2, plan_id: 'plan_usd' });
    const { razorpay } = setup(standardRow('sub_usd'));

    await razorpay.handleWebhook(pendingEvent(sub));

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('$19');
    expect(sent[0].text).toContain('Pay with a different card');
    expect(sent[0].html + sent[0].text).not.toMatch(/UPI|₹/);
  });

  it('a plan charged at once (no trial) whose first payment failed is not told its trial ended', async () => {
    const created = now() - 600;
    const sub = hookpostSub('sub_now', {
      status: 'pending',
      paid_count: 0,
      created_at: created,
      start_at: null,
      current_start: created,
    });
    const { razorpay } = setup(standardRow('sub_now'));

    await razorpay.handleWebhook(pendingEvent(sub, failed('pay_n1')));

    expect(sent.map((m) => m.subject)).toEqual(["Your Hookpost payment didn't go through"]);
    expect(sent[0].text).not.toMatch(/trial/i);
  });

  it('a refused send frees the claim, so the next attempt in the cycle can send', async () => {
    const sub = hookpostSub('sub_live', { status: 'pending', paid_count: 2 });
    const { razorpay } = setup(standardRow('sub_live'));
    mockSend.mockImplementationOnce(async () => ({ data: null, error: { message: 'rate limited' } }) as any);

    await razorpay.handleWebhook(pendingEvent(sub));
    expect(sent).toHaveLength(0);
    await razorpay.handleWebhook(pendingEvent(sub));
    expect(sent).toHaveLength(1);
  });

  it('payment.failed that is not on a subscription invoice sends nothing (the abandoned Rs 5 mandate check)', async () => {
    const { razorpay } = setup(null);
    // Notes and a customer that resolve to a workspace, but no invoice.
    await razorpay.handleWebhook(
      paymentFailedEvent(failed('pay_auth', { amount: 500, notes: { service: 'hookpost', orgId: ORG } }))
    );
    expect(sent).toHaveLength(0);
  });

  it("payment.failed on another product's subscription invoice sends nothing", async () => {
    hookpostSub('sub_tm', { notes: { service: 'tablamigo' } });
    const pay = charge('sub_tm', 'pay_tm', { status: 'failed', notes: {} });
    const { razorpay } = setup(null);
    await razorpay.handleWebhook(paymentFailedEvent(pay));
    expect(sent).toHaveLength(0);
  });
});

// No free service while a payment is failing (29 Oct 2026, the owner's call).
describe('the failing-payment marker and the halted renewal', () => {
  const pending = (sub: any) => ({
    event: 'subscription.pending',
    payload: { subscription: { entity: { ...sub } } },
  });
  const halted = (sub: any) => ({
    event: 'subscription.halted',
    payload: { subscription: { entity: { ...sub, status: 'halted' } } },
  });

  it("a trial's failing first charge marks the row, and a charge clears it", async () => {
    const startAt = now() - DAY;
    const sub = hookpostSub('sub_trial', {
      status: 'pending',
      paid_count: 0,
      start_at: startAt,
      current_start: null,
      current_end: null,
    });
    const { razorpay, subscriptions, row } = setup(standardRow('sub_trial'));

    await razorpay.handleWebhook(pending(sub));
    expect(row()!.paymentFailingSince).toBeInstanceOf(Date);

    // Every retry's webhook keeps the first date rather than pushing it on.
    const first = row()!.paymentFailingSince;
    await razorpay.handleWebhook(pending(sub));
    expect(row()!.paymentFailingSince).toBe(first);

    // The retry went through: Razorpay charges it, and the workspace is live
    // again with nobody doing anything.
    Object.assign(sub, { status: 'active', paid_count: 1 });
    await razorpay.handleWebhook({
      event: 'subscription.charged',
      payload: { subscription: { entity: { ...sub } }, payment: { entity: charge('sub_trial', 'pay_ok') } },
    });
    expect(subscriptions.clearPaymentFailing).toHaveBeenCalledWith('sub_trial');
    expect(row()!.paymentFailingSince).toBeNull();
  });

  it('a webhook redelivered after the charge went through does not mark the row', async () => {
    const sub = hookpostSub('sub_live', { status: 'pending', paid_count: 2 });
    const { razorpay, row } = setup(standardRow('sub_live'));
    // Razorpay retries a webhook for up to 24 hours; by then it is active.
    const stale = { ...sub };
    rzp.get('/subscriptions/sub_live').status = 'active';

    await razorpay.handleWebhook(pending(stale));
    expect(row()!.paymentFailingSince).toBeUndefined();
  });

  it("another workspace's plan, and a lifetime plan, are never marked", async () => {
    const other = hookpostSub('sub_other', {
      status: 'pending',
      paid_count: 2,
      notes: { service: 'hookpost', orgId: 'org-else' },
    });
    const a = setup(standardRow('sub_other'));
    await a.razorpay.handleWebhook(pending(other));
    expect(a.row()!.paymentFailingSince).toBeUndefined();

    const mine = hookpostSub('sub_life', { status: 'pending', paid_count: 2 });
    const b = setup({ ...standardRow('sub_life'), isLifetime: true });
    await b.razorpay.handleWebhook(pending(mine));
    expect(b.row()!.paymentFailingSince).toBeUndefined();
  });

  it('a renewal that halts with nothing paid for ends the plan now, with no second email', async () => {
    // total_count/remaining_count say the current cycle was booked and never
    // paid (razorpay.mapping currentCycleUnpaid), so the paid time stopped at
    // current_start, which is in the past.
    const sub = hookpostSub('sub_live', {
      status: 'halted',
      halted_at: now(),
      paid_count: 1,
      total_count: 120,
      remaining_count: 118,
      current_start: now() - 5 * DAY,
      current_end: now() + 25 * DAY,
    });
    const { razorpay, subscriptions } = setup(standardRow('sub_live'));

    await razorpay.handleWebhook(halted(sub));

    expect(mockRequest).toHaveBeenCalledWith(
      'POST',
      '/subscriptions/sub_live/cancel',
      { cancel_at_cycle_end: 0 }
    );
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
    // One email, the cancellation: never "your renewal is paused" beside it.
    expect(sent.map((m) => m.subject)).toEqual([
      'Your Hookpost Standard plan has ended',
    ]);
  });

  it('a renewal that halts inside a cycle that was paid for runs to the end of it', async () => {
    const paidTo = now() + 25 * DAY;
    const sub = hookpostSub('sub_live', {
      status: 'halted',
      halted_at: now(),
      paid_count: 2,
      total_count: 120,
      remaining_count: 118,
      current_end: paidTo,
    });
    const { razorpay, subscriptions, row } = setup(standardRow('sub_live'));

    await razorpay.handleWebhook(halted(sub));

    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(row()!.cancelAt.getTime()).toBe(paidTo * 1000);
    expect(sent.map((m) => m.subject)).toEqual([
      'Action needed: Hookpost renewal paused',
    ]);
    // No seven-day grace on top of the time paid for (29 Oct 2026).
    expect(row()!.cancelAt.getTime()).toBeLessThan((now() + 26 * DAY) * 1000);
  });
});

describe('paymentIssue (the "pay from a different account" banner)', () => {
  it.each([
    ['pending', 'pending'],
    ['halted', 'halted'],
    ['active', null],
    ['authenticated', null],
    ['cancelled', null],
  ])('a plan that is %s at Razorpay answers %s', async (status, expected) => {
    hookpostSub('sub_live', { status });
    const { razorpay } = setup(standardRow('sub_live'));
    await expect(razorpay.paymentIssue(ORG)).resolves.toEqual({ status: expected });
  });

  it('no Razorpay plan, a lifetime plan, another workspace\'s plan or Razorpay down: no banner', async () => {
    await expect(setup(null).razorpay.paymentIssue(ORG)).resolves.toEqual({ status: null });

    hookpostSub('sub_live', { status: 'pending' });
    await expect(
      setup({ ...standardRow('sub_live'), isLifetime: true }).razorpay.paymentIssue(ORG)
    ).resolves.toEqual({ status: null });

    hookpostSub('sub_other', { status: 'pending', notes: { service: 'hookpost', orgId: 'org-else' } });
    await expect(setup(standardRow('sub_other')).razorpay.paymentIssue(ORG)).resolves.toEqual({
      status: null,
    });

    // Not in the fake: Razorpay answers 404.
    await expect(setup(standardRow('sub_gone')).razorpay.paymentIssue(ORG)).resolves.toEqual({
      status: null,
    });
  });
});

describe('templates', () => {
  it('never name the legal entity or a street address', () => {
    const emails = [
      subscriptionCancelledEmail({ orgName: 'A', billing: 'PRO', period: 'YEARLY', accessUntil: new Date() }),
      subscriptionCancelledEmail({ orgName: 'A', billing: 'PRO', accessUntil: null }),
      refundEmail({ orgName: 'A', amount: 5990, currency: 'INR', refundId: 'rfnd_x', refundedAt: new Date(), plan: 'none' }),
    ];
    for (const e of emails) {
      // Hookstep is the operator and must be named; the legal entity and a
      // street address must not.
      expect(e.html).toContain('Hookpost by Hookstep · Ghatkopar, Mumbai, India');
      expect(e.text).toContain('Hookpost by Hookstep · Ghatkopar, Mumbai, India');
      expect(e.html + e.text).not.toMatch(/JR Consulting|\bRoad\b|\bMarg\b|\bStreet\b/i);
    }
    expect(emails[2].subject).toBe('Your refund of ₹5,990 is on its way');
    expect(emails[2].text).not.toContain('Your plan:');
  });

  it('a cancel on a refunded plan says the plan ended now because it was refunded', () => {
    const e = subscriptionCancelledEmail({ orgName: 'A', billing: 'STANDARD', accessUntil: null, endedByRefund: true });
    expect(e.text).toContain('Your payment was refunded, so the plan ended now rather than at the end of the period');
    expect(e.text).toContain('Plan ended:');
    expect(e.html).toContain('Your payment was refunded, so your Standard plan has ended now.');
    // With paid time still kept the refund line never shows.
    const kept = subscriptionCancelledEmail({ orgName: 'A', billing: 'STANDARD', accessUntil: new Date(Date.now() + 9 * 86400_000), endedByRefund: true });
    expect(kept.text).not.toContain('refunded');
    expect(subscriptionCancelledEmail({ orgName: 'A', billing: 'STANDARD', accessUntil: null }).text).not.toContain('refunded');
  });

  it('a refund that ended the plan says the refund is why', () => {
    const base = { orgName: 'A', amount: 6.99, currency: 'INR', refundId: 'rfnd_x', refundedAt: new Date(), billing: 'STANDARD', plan: 'cancelled' as const };
    expect(refundEmail({ ...base, endedByRefund: true }).text).toContain(
      'Because this payment was refunded, your plan has ended now. Your Standard plan for A is cancelled'
    );
    expect(refundEmail(base).text).not.toContain('Because this payment was refunded');
    // A refund on another subscription: the current plan stays, with no renewal date.
    const kept = refundEmail({ ...base, plan: 'active' }).text;
    expect(kept).toContain('Your Standard plan for A stays active. Nothing else changes.');
    expect(kept).not.toContain('renews on');
  });

  it('every failure email: the bank declined it, Razorpay retries, a button to pay from another account, never "no action needed"', () => {
    const variants = [
      paymentFailedEmail({ orgName: 'A', billing: 'STANDARD', amount: 599, currency: 'INR' }),
      paymentFailedEmail({ orgName: 'A', billing: 'STANDARD', amount: 599, currency: 'INR', firstChargeRetrying: true }),
    ];
    for (const e of variants) {
      expect(e.text.toLowerCase()).toContain('your bank declined');
      expect(e.text).toContain('Razorpay will retry it automatically');
      expect(e.text).toContain('Pay from a different UPI app or card');
      expect(e.html).toContain('/billing?pay=another-account');
      expect(e.text).toContain('so you are not charged twice');
      expect(e.html + e.text).not.toMatch(/no action needed|nothing you need to do/i);
    }
    const halted = paymentFailedEmail({ orgName: 'A', billing: 'STANDARD', amount: 599, currency: 'INR', isHalted: true });
    expect(halted.html).toContain('/billing?pay=another-account');
    expect(halted.text).toContain('Pay from a different UPI app or card');
    expect(halted.html + halted.text).not.toMatch(/no action needed|nothing you need to do/i);
  });

  it("a trial's failed first charge: calm, says it is retried, names no renewal", () => {
    const e = paymentFailedEmail({
      orgName: 'Chai <Point>',
      billing: 'STANDARD',
      amount: 599,
      currency: 'INR',
      reason: 'Payment declined by the bank',
      firstChargeRetrying: true,
    });
    expect(e.subject).toBe("Your first Hookpost payment didn't go through yet");
    expect(e.text).toContain('Razorpay will retry it automatically');
    expect(e.text).toContain('Amount: ₹599');
    expect(e.text).toContain("If every retry fails, the trial ends and you won't be charged.");
    // It must name what actually stops - AI and X - and must not say the
    // workspace is paused, because the other channels keep publishing
    // (trial.policy.ts `dunning`).
    expect(e.text).toContain('AI writing and posting to X are paused');
    expect(e.text).toContain('your scheduled posts go out to your other channels');
    expect(e.text).toContain('AI and X switch back on the moment one goes through');
    expect(e.html + e.text).not.toMatch(/workspace is paused|renewal/i);
    expect(e.html).not.toContain('<Point>');
    expect(e.text).toContain('Hookpost by Hookstep · Ghatkopar, Mumbai, India');
    expect(e.html + e.text).not.toMatch(/JR Consulting/i);
    // Halted wins: retries are over then.
    expect(
      paymentFailedEmail({ orgName: 'A', isHalted: true, firstChargeRetrying: true }).subject
    ).toBe('Action needed: Hookpost renewal paused');
    // Without the flag nothing changes.
    expect(paymentFailedEmail({ orgName: 'A', billing: 'PRO' }).subject).toBe(
      "Your Hookpost payment didn't go through"
    );
  });

  it('a trial ended for an unpaid first charge says so, not "your plan is cancelled"', () => {
    const e = subscriptionCancelledEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      period: 'MONTHLY',
      accessUntil: null,
      unpaidTrialEnded: true,
    });
    expect(e.subject).toBe('Your Hookpost Standard trial has ended');
    expect(e.text).toContain("didn't go through on any of the automatic retries");
    expect(e.text).toContain("You won't be charged.");
    expect(e.text).toContain('Future charges: None');
    expect(e.text).not.toMatch(/cancelled by mistake/i);
    expect(e.text).toContain('Hookpost by Hookstep · Ghatkopar, Mumbai, India');
    expect(e.html + e.text).not.toMatch(/JR Consulting/i);
  });

  it('a paid plan ended after its renewal halted says so, not "your plan is cancelled"', () => {
    const e = subscriptionCancelledEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      period: 'MONTHLY',
      accessUntil: null,
      endedAt: new Date('2026-10-27T06:00:00Z'),
      unpaidRenewalEnded: true,
    });
    expect(e.subject).toBe('Your Hookpost Standard plan has ended');
    expect(e.text).toContain("The renewal payment for your Hookpost Standard plan");
    expect(e.text).toContain("You won't be charged.");
    expect(e.text).toContain('Plan ended: 27 Oct 2026');
    expect(e.text).toContain('Future charges: None');
    expect(e.text).not.toMatch(/cancelled by mistake|trial/i);
  });

  it('halted renewal email: names the date the plan keeps working until, and the way to keep it', () => {
    const e = paymentFailedEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      amount: 599,
      currency: 'INR',
      isHalted: true,
      activeUntil: new Date('2026-10-27T06:00:00Z'),
    });
    expect(e.subject).toBe('Action needed: Hookpost renewal paused');
    expect(e.text).toContain('Plan active until: 27 Oct 2026');
    expect(e.text).toContain('keep working until 27 Oct 2026');
    expect(e.text).toContain('AI writing and X are paused');
    expect(e.text).toContain("Otherwise the plan ends on that date, and you won't be charged.");
    // No date means nothing was paid for past today, so the plan is over:
    // never "still active right now" (a halt has no grace).
    const over = paymentFailedEmail({
      orgName: 'A',
      billing: 'STANDARD',
      isHalted: true,
    }).text;
    expect(over).toContain('Your plan is ending now');
    expect(over).not.toMatch(/still active|keeps working/i);
    expect(
      paymentFailedEmail({ orgName: 'A', billing: 'STANDARD', activeUntil: new Date() }).text
    ).not.toContain('Plan active until');
  });

  it('a failing renewal email says AI and X stop and the plan ends if the retries fail', () => {
    const e = paymentFailedEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      amount: 599,
      currency: 'INR',
    });
    expect(e.subject).toBe("Your Hookpost payment didn't go through");
    expect(e.text).toContain('Your scheduled posts and connected channels keep working');
    expect(e.text).toContain('AI writing and posting to X are paused');
    expect(e.text).toContain('if every retry fails the plan ends');
  });

  it('escapes the workspace name', () => {
    const e = subscriptionCancelledEmail({ orgName: '<b>x</b>', billing: 'STANDARD', accessUntil: null });
    expect(e.html).not.toContain('<b>x</b>');
  });
});

describe('templates under the trial policy', () => {
  const PAUSED =
    'Your workspace is paused; your channels and posts are kept, and their media files for 30 days. Choose a plan to keep everything.';
  const later = new Date('2026-11-02T06:00:00Z');

  it('a trial cancelled before its first charge: no charge, works until the date, then Free or paused', () => {
    const free = subscriptionCancelledEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      period: 'MONTHLY',
      accessUntil: later,
      trialCancelled: true,
    });
    expect(free.subject).toBe('Your Hookpost Standard trial is cancelled');
    expect(free.text).toContain("you won't be charged");
    expect(free.text).toContain('Trial access until: 2 Nov 2026');
    expect(free.text).toContain('After that the workspace moves to the Free plan');
    expect(free.text).not.toMatch(/Paid access/);

    const paused = subscriptionCancelledEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      accessUntil: later,
      trialCancelled: true,
      freePlanAvailable: false,
    });
    expect(paused.text).toContain('After that your workspace is paused; your channels and posts are kept, and their media files for 30 days.');
    expect(paused.text).not.toMatch(/Free plan/);
    for (const e of [free, paused]) {
      expect(e.text).toContain('Hookpost by Hookstep · Ghatkopar, Mumbai, India');
      expect(e.html + e.text).not.toMatch(/JR Consulting|stripe/i);
    }
  });

  it('a trial cancelled within a day of its first charge: never "you won\'t be charged", a full refund if the debit lands', () => {
    const e = subscriptionCancelledEmail({
      orgName: 'Chai Point Social',
      billing: 'STANDARD',
      period: 'MONTHLY',
      accessUntil: later,
      trialCancelled: true,
      firstDebitMayBeUnderway: true,
    });
    expect(e.subject).toBe('Your Hookpost Standard trial is cancelled');
    expect(e.text).toContain('your bank may already have started that debit. If it goes through, we refund it in full');
    expect(e.text).toContain('Charges: None. A debit already under way is refunded in full.');
    expect(e.text).not.toMatch(/won't be charged|Charges: None\n/);
    // Reactivate is refused in that window, so it is not offered.
    expect(e.text).not.toMatch(/Reactivate/);
    expect(e.text).toContain('Choose a plan from Billing after 2 Nov 2026.');
  });

  it('new cohort: every "now on the Free plan" line is the paused line instead', () => {
    const emails = [
      subscriptionCancelledEmail({ orgName: 'A', billing: 'PRO', accessUntil: null, freePlanAvailable: false }),
      subscriptionCancelledEmail({ orgName: 'A', billing: 'PRO', accessUntil: later, freePlanAvailable: false }),
      subscriptionCancelledEmail({ orgName: 'A', billing: 'STANDARD', accessUntil: null, unpaidTrialEnded: true, freePlanAvailable: false }),
      refundEmail({ orgName: 'A', amount: 599, currency: 'INR', refundId: 'rfnd_x', refundedAt: new Date(), billing: 'STANDARD', plan: 'cancelled', freePlanAvailable: false }),
    ];
    for (const e of emails) {
      expect(e.text).not.toMatch(/Free plan/);
      expect(e.text).toMatch(/paused; your channels and posts are kept, and their media files for 30 days/);
    }
    expect(emails[0].text).toContain(PAUSED);
    // Grandfathered (the default) is unchanged.
    expect(
      subscriptionCancelledEmail({ orgName: 'A', billing: 'PRO', accessUntil: null }).text
    ).toContain('The workspace is now on the Free plan (2 channels, 30 posts a month)');
  });

  it('a Free fallback with an end (FREE_PLAN_SUNSET_AT ahead) says when that Free plan ends', () => {
    const sunset = new Date('2026-10-27T18:29:59Z');
    const ENDS =
      'The Free plan itself ends on 27 October 2026; from then the workspace is paused, and your channels and posts are kept, and their media files for 30 days.';
    const emails = [
      subscriptionCancelledEmail({ orgName: 'A', billing: 'PRO', accessUntil: null, freePlanEndsAt: sunset }),
      subscriptionCancelledEmail({ orgName: 'A', billing: 'PRO', accessUntil: later, freePlanEndsAt: sunset }),
      subscriptionCancelledEmail({ orgName: 'A', billing: 'STANDARD', accessUntil: later, trialCancelled: true, freePlanEndsAt: sunset }),
      subscriptionCancelledEmail({ orgName: 'A', billing: 'STANDARD', accessUntil: null, unpaidRenewalEnded: true, freePlanEndsAt: sunset }),
      refundEmail({ orgName: 'A', amount: 599, currency: 'INR', refundId: 'rfnd_x', refundedAt: new Date(), billing: 'STANDARD', plan: 'cancelled', freePlanEndsAt: sunset }),
    ];
    for (const e of emails) {
      expect(e.text).toContain(ENDS);
    }
    // No end date: exactly the old line, with nothing after it.
    expect(subscriptionCancelledEmail({ orgName: 'A', billing: 'PRO', accessUntil: null }).text).not.toContain(
      'The Free plan itself ends'
    );
    // Paused wins: the caller decided at the plan's end that Free is gone.
    expect(
      subscriptionCancelledEmail({ orgName: 'A', billing: 'PRO', accessUntil: later, freePlanAvailable: false, freePlanEndsAt: sunset }).text
    ).not.toMatch(/Free plan/);
  });

  it('the welcome states amount, date, how to cancel and UPI revoke only when given the charge', () => {
    const base = {
      orgName: 'A',
      billing: 'STANDARD',
      channels: 5,
      period: 'MONTHLY',
      isTrial: true,
      trialDays: 7,
      firstChargeAt: later,
    };
    const plain = subscriptionWelcomeEmail(base);
    expect(plain.text).not.toContain('at least 24 hours before');
    const told = subscriptionWelcomeEmail({
      ...base,
      charge: { amount: 599, currency: 'INR', period: 'MONTHLY', paymentMethod: 'upi' },
    });
    expect(told.text).toContain('Then: ₹599/month');
    expect(told.text).toContain('On 2 Nov 2026 your Standard plan starts and ₹599 is charged');
    expect(told.text).toContain('at least 24 hours before that date');
    expect(told.text).toContain('A UPI AutoPay mandate can also be revoked from your UPI app.');
    expect(told.html).toContain('/billing');
    // A card mandate has no UPI app to revoke it from.
    const card = subscriptionWelcomeEmail({
      ...base,
      charge: { amount: 599, currency: 'INR', period: 'MONTHLY', paymentMethod: 'card' },
    });
    expect(card.text).not.toContain('UPI');
    // A paid plan that starts today has no trial lines.
    expect(
      subscriptionWelcomeEmail({ ...base, isTrial: false, charge: { amount: 599, currency: 'INR', period: 'MONTHLY' } }).text
    ).not.toContain('at least 24 hours before');
  });

  // PR-4: a dollar plan is a card mandate. Its emails name dollars and never
  // UPI, even before Razorpay reports how the mandate is paid.
  it('dollar trials and failed dollar charges say dollars and never UPI', () => {
    const welcome = subscriptionWelcomeEmail({
      orgName: 'Abroad',
      billing: 'STANDARD',
      channels: 5,
      period: 'MONTHLY',
      isTrial: true,
      trialDays: 7,
      firstChargeAt: later,
      charge: { amount: 19, currency: 'USD', period: 'MONTHLY', paymentMethod: null },
    });
    expect(welcome.text).toContain('Then: $19/month');
    expect(welcome.text).toContain('at least 24 hours before that date');
    expect(welcome.html + welcome.text).not.toMatch(/UPI|₹/);

    const reminder = trialReminderEmail({
      orgName: 'Abroad',
      billing: 'PRO',
      chargeAt: later,
      charge: { amount: 290, currency: 'USD', period: 'YEARLY' },
    });
    expect(reminder.text).toContain('Amount: $290/year');
    expect(reminder.html + reminder.text).not.toMatch(/UPI|₹/);

    for (const e of [
      paymentFailedEmail({ orgName: 'Abroad', billing: 'STANDARD', amount: 19, currency: 'USD' }),
      paymentFailedEmail({ orgName: 'Abroad', billing: 'STANDARD', amount: 19, currency: 'USD', firstChargeRetrying: true }),
      paymentFailedEmail({ orgName: 'Abroad', billing: 'STANDARD', amount: 19, currency: 'USD', isHalted: true }),
    ]) {
      expect(e.text).toContain('$19');
      expect(e.html + e.text).not.toMatch(/UPI|₹/);
    }
    // Dollar emails offer a different card; rupee emails a UPI app or card.
    expect(
      paymentFailedEmail({ orgName: 'Abroad', billing: 'STANDARD', amount: 19, currency: 'USD' }).text
    ).toContain('Pay with a different card');
    expect(
      paymentFailedEmail({ orgName: 'A', billing: 'STANDARD', amount: 599, currency: 'INR' }).text
    ).toContain('pay from a different UPI app or card instead');
    expect(
      paymentFailedEmail({ orgName: 'A', amount: 599, currency: 'INR', firstChargeRetrying: true }).text
    ).toContain('pay from a different UPI app or card instead');
  });

  it('the reminder: subject with the date, amount per period, how to cancel', () => {
    const e = trialReminderEmail({
      orgName: 'Chai <Point>',
      billing: 'PRO',
      chargeAt: later,
      charge: { amount: 19990, currency: 'INR', period: 'YEARLY', paymentMethod: 'upi' },
    });
    expect(e.subject).toBe('Your Hookpost Pro trial ends on 2 Nov 2026');
    expect(e.text).toContain('Amount: ₹19,990/year');
    expect(e.text).toContain('at least 24 hours before');
    expect(e.html).not.toContain('<Point>');
    expect(e.text).toContain('Hookpost by Hookstep · Ghatkopar, Mumbai, India');
    expect(e.html + e.text).not.toMatch(/JR Consulting|stripe|free plan/i);
  });
});
