/**
 * An in-memory Razorpay account, installed in place of the one network
 * method every Razorpay call goes through (RazorpayClient.request). Billing
 * code runs for real against it: plans are looked up and created, customers
 * and subscriptions are created, fetched and cancelled, and the state is
 * there for the test to read or to replay as a webhook.
 *
 * Covers the calls the subscribe / webhook / cancel / invoices paths make.
 * Anything else throws, so a new Razorpay call shows up as a test failure
 * instead of silently reaching the network.
 */
import { createHmac } from 'crypto';
import { RazorpayClient } from '@hookpost/nestjs-libraries/services/razorpay.client';

const now = () => Math.floor(Date.now() / 1000);

export class FakeRazorpay {
  plans = new Map<string, any>();
  customers = new Map<string, any>();
  subscriptions = new Map<string, any>();
  invoices: any[] = [];
  payments = new Map<string, any>();
  /** Refunds by id, as GET /v1/refunds lists them (the admin refund history). */
  refunds = new Map<string, any>();
  /** Disputes by id, as GET /v1/disputes/:id reads them. */
  disputes = new Map<string, any>();
  /**
   * The Subscription Offers made in the dashboard: the first-month ones whose
   * ids test-env.ts sets. Offers cannot be created over the API.
   */
  offers = new Set<string>(
    ['RAZORPAY_OFFER_FIRST_MONTH_UPI', 'RAZORPAY_OFFER_FIRST_MONTH_CARD']
      .map((k) => process.env[k] || '')
      .filter(Boolean)
  );
  calls: Array<{ method: string; path: string; body?: any }> = [];
  /** What each in-place 'now' plan change charged (+) or refunded (-), in paise. */
  prorations: Array<{ subscriptionId: string; amount: number }> = [];
  /**
   * Refuse a plan change on a UPI mandate, as the live account does ("cannot
   * be updated when payment mode is upi"), so an upgrade opens a new mandate.
   * Off unless a test turns it on.
   */
  refuseUpiPatch = false;
  /** Subscription ids whose cancel fails as an outage would (a 502). */
  refuseCancel = new Set<string>();
  /** `METHOD /path` (no query) that answers 503, as an outage would. */
  unavailable = new Set<string>();
  private seq = 0;
  private original?: RazorpayClient['request'];

  // Patched by hand rather than with jest.spyOn so the E2E backend
  // (tests/e2e/server/backend.ts), which runs outside jest, can use it too.
  install() {
    if (this.original) return this;
    this.original = RazorpayClient.prototype.request;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const fake = this;
    RazorpayClient.prototype.request = function (method: any, path: string, body?: any) {
      return fake.handle(method, path, body);
    } as RazorpayClient['request'];
    return this;
  }

  uninstall() {
    if (this.original) RazorpayClient.prototype.request = this.original;
    this.original = undefined;
  }

  // Ids differ between instances: every test file has its own fake but they
  // share one database, and a subscription id another file left on a row
  // would otherwise be handed out again and read as that workspace's.
  private readonly run = Math.random().toString(36).slice(2, 6);

  private id(prefix: string) {
    return `${prefix}_test${this.run}${(++this.seq).toString().padStart(6, '0')}`;
  }

  async handle(method: string, path: string, body?: any): Promise<any> {
    this.calls.push({ method, path, body });
    const [base, query] = path.split('?');
    if (this.unavailable.has(`${method} ${base}`)) {
      throw new Error(`Razorpay ${method} ${path} failed (503): Service Unavailable`);
    }
    const q = new URLSearchParams(query || '');
    const page = <T>(items: T[]) => {
      const count = Math.min(Number(q.get('count') || 10), 100);
      const skip = Number(q.get('skip') || 0);
      return { entity: 'collection', count: items.length, items: items.slice(skip, skip + count) };
    };
    const notFound = () => {
      throw new Error(`Razorpay ${method} ${path} failed (404): The id provided does not exist`);
    };

    if (method === 'POST' && base === '/customers') {
      const existing = [...this.customers.values()].find((c) => c.email === body.email);
      if (existing) return existing;
      const customer = { id: this.id('cust'), entity: 'customer', ...body, created_at: now() };
      this.customers.set(customer.id, customer);
      return customer;
    }
    if (method === 'GET' && base === '/customers') return page([...this.customers.values()]);

    if (method === 'GET' && base === '/plans') return page([...this.plans.values()]);
    if (method === 'POST' && base === '/plans') {
      const plan = { id: this.id('plan'), entity: 'plan', ...body, created_at: now() };
      this.plans.set(plan.id, plan);
      return plan;
    }
    const plan = base.match(/^\/plans\/([^/]+)$/);
    if (method === 'GET' && plan) return this.plans.get(plan[1]) ?? notFound();

    if (method === 'GET' && base === '/subscriptions') {
      let items = [...this.subscriptions.values()].sort((a, b) => b.created_at - a.created_at);
      if (q.get('plan_id')) items = items.filter((s) => s.plan_id === q.get('plan_id'));
      return page(items);
    }
    if (method === 'POST' && base === '/subscriptions') {
      // As the live account answered on 22 Oct 2026: an offer on a
      // subscription that starts later is refused (first.month.offer.ts),
      // and an offer this account does not have is not found.
      if (body.offer_id !== undefined) {
        if (!this.offers.has(body.offer_id)) {
          throw new Error(`Razorpay POST ${path} failed (400): Offer Not Found`);
        }
        if (body.start_at) {
          throw new Error(
            `Razorpay POST ${path} failed (400): Offer not applicable for this subscription`
          );
        }
      }
      const sub = {
        id: this.id('sub'),
        entity: 'subscription',
        status: 'created',
        plan_id: body.plan_id,
        customer_id: body.customer_id,
        total_count: body.total_count,
        quantity: 1,
        paid_count: 0,
        remaining_count: body.total_count,
        start_at: body.start_at ?? null,
        charge_at: body.start_at ?? now(),
        current_start: null,
        current_end: null,
        ended_at: null,
        end_at: now() + 3650 * 86400,
        notes: body.notes || {},
        offer_id: body.offer_id ?? null,
        short_url: 'https://rzp.io/i/test-checkout',
        created_at: now(),
        payment_method: null,
      };
      this.subscriptions.set(sub.id, sub);
      return sub;
    }
    const cancel = base.match(/^\/subscriptions\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancel) {
      const sub = this.subscriptions.get(cancel[1]) ?? notFound();
      if (this.refuseCancel.has(sub.id)) {
        throw new Error(`Razorpay POST ${path} failed (502): Bad Gateway`);
      }
      if (sub.status === 'cancelled') {
        throw new Error(`Razorpay POST ${path} failed (400): Subscription is not cancellable in cancelled status.`);
      }
      if (body?.cancel_at_cycle_end) {
        sub.has_scheduled_changes = true;
        sub.status_before_cancel = sub.status;
        sub.ended_at = null;
        sub.cancel_at_cycle_end = true;
      } else {
        sub.status = 'cancelled';
        sub.ended_at = now();
      }
      return { ...sub };
    }
    const one = base.match(/^\/subscriptions\/([^/]+)$/);
    if (method === 'GET' && one) return { ...(this.subscriptions.get(one[1]) ?? notFound()) };
    if (method === 'PATCH' && one) {
      const sub = this.subscriptions.get(one[1]) ?? notFound();
      // As the live API (sandbox, 1 Nov 2026): the Update API takes no notes.
      if (body?.notes) {
        throw new Error(`Razorpay PATCH ${path} failed (400): notes is/are not required and should not be sent`);
      }
      if (this.refuseUpiPatch && sub.payment_method === 'upi') {
        throw new Error(
          `Razorpay PATCH ${path} failed (400): subscriptions cannot be updated when payment mode is upi`
        );
      }
      // As the live API: "You can only update a Subscription authorised
      // using cards and not via UPI and Emandate", and of one on a domestic
      // card only its offer. So a plan change is an international card's.
      if (body?.plan_id && body.plan_id !== sub.plan_id && !(sub.payment_method === 'card' && sub.card_international)) {
        throw new Error(
          `Razorpay PATCH ${path} failed (400): subscriptions cannot be updated when payment mode is ${sub.payment_method || 'unknown'}`
        );
      }
      // https://razorpay.com/docs/payments/subscriptions/update/
      if (!['authenticated', 'active'].includes(sub.status)) {
        throw new Error(
          `Razorpay PATCH ${path} failed (400): You can only update Subscriptions in the authenticated and active states`
        );
      }
      if (!body?.plan_id || body.plan_id === sub.plan_id) {
        Object.assign(sub, body);
        return { ...sub };
      }
      if (body.schedule_change_at === 'cycle_end') {
        // Held as a pending update until the cycle ends: plan and notes both
        // stay as they are (retrieve_scheduled_changes shows the new plan).
        sub.has_scheduled_changes = true;
        sub.change_scheduled_at = sub.current_end;
        sub.pending_update = { plan_id: body.plan_id, notes: body.notes };
        return { ...sub };
      }
      // 'now': Razorpay's documented proration, written out here on its own
      // (not imported from the code under test) so a spec comparing the two
      // compares two independent readings of the docs.
      const oldPlan = this.plans.get(sub.plan_id);
      const newPlan = this.plans.get(body.plan_id);
      const qty = Number(sub.quantity || 1);
      let amount = Number(newPlan?.item?.amount || 0) * qty;
      if (sub.status === 'active' && sub.current_start && sub.current_end) {
        const freqDays = Math.round((sub.current_end - sub.current_start) / 86400);
        const changeDay = Math.min(Math.floor((now() - sub.current_start) / 86400) + 1, freqDays);
        const remaining = freqDays - (changeDay - 1);
        const oldPerDay = (Number(oldPlan?.item?.amount || 0) * qty) / freqDays;
        const sameFreq = oldPlan?.period === newPlan?.period;
        const newCharge = sameFreq ? Math.round(((amount / freqDays) * remaining)) : amount;
        amount = newCharge - Math.round(oldPerDay * remaining);
        if (Math.abs(amount) < 50) {
          throw new Error(
            `Razorpay PATCH ${path} failed (400): The prorated amount should be at least 50 paise`
          );
        }
        if (!sameFreq) {
          sub.current_start = now();
          sub.current_end = now() + (newPlan?.period === 'yearly' ? 365 : 30) * 86400;
          sub.charge_at = sub.current_end;
        }
        if (amount > 0) {
          const pay = this.charge(sub.id, amount);
          this.invoices.push({
            id: this.id('inv'),
            entity: 'invoice',
            subscription_id: sub.id,
            payment_id: pay.id,
            amount,
            status: 'paid',
            type: 'proration',
            paid_at: now(),
            created_at: now(),
          });
        }
        this.prorations.push({ subscriptionId: sub.id, amount });
      }
      sub.plan_id = body.plan_id;
      if (body.notes) sub.notes = body.notes;
      return { ...sub };
    }
    const pendingOf = base.match(/^\/subscriptions\/([^/]+)\/retrieve_scheduled_changes$/);
    if (method === 'GET' && pendingOf) {
      const sub = this.subscriptions.get(pendingOf[1]) ?? notFound();
      if (!sub.pending_update) {
        throw new Error(`Razorpay GET ${path} failed (400): No scheduled changes for this subscription`);
      }
      return { ...sub, plan_id: sub.pending_update.plan_id };
    }
    const dropPending = base.match(/^\/subscriptions\/([^/]+)\/cancel_scheduled_changes$/);
    if (method === 'POST' && dropPending) {
      const sub = this.subscriptions.get(dropPending[1]) ?? notFound();
      if (!sub.pending_update) {
        throw new Error(`Razorpay POST ${path} failed (400): No scheduled changes for this subscription`);
      }
      sub.has_scheduled_changes = false;
      sub.change_scheduled_at = null;
      delete sub.pending_update;
      return { ...sub };
    }

    if (method === 'GET' && base === '/invoices') {
      const subId = q.get('subscription_id');
      return page(this.invoices.filter((i) => !subId || i.subscription_id === subId));
    }
    const invoice = base.match(/^\/invoices\/([^/]+)$/);
    if (method === 'GET' && invoice) {
      return this.invoices.find((i) => i.id === invoice[1]) ?? notFound();
    }
    if (method === 'GET' && base === '/payments') {
      const from = Number(q.get('from') || 0);
      const to = Number(q.get('to') || Number.MAX_SAFE_INTEGER);
      return page(
        [...this.payments.values()]
          .filter((p) => p.created_at >= from && p.created_at <= to)
          .sort((a, b) => b.created_at - a.created_at)
      );
    }
    const invoiceOne = base.match(/^\/invoices\/([^/]+)$/);
    if (method === 'GET' && invoiceOne) {
      return this.invoices.find((i) => i.id === invoiceOne[1]) ?? notFound();
    }
    if (method === 'GET' && base === '/disputes') {
      // No payment filter, as on Razorpay: from/skip/count, newest first.
      const from = Number(q.get('from') || 0);
      return page(
        [...this.disputes.values()]
          .filter((d) => d.created_at >= from)
          .sort((a, b) => b.created_at - a.created_at)
          .map((d) => ({ ...d }))
      );
    }
    const disputeOne = base.match(/^\/disputes\/([^/]+)$/);
    if (method === 'GET' && disputeOne) {
      return { ...(this.disputes.get(disputeOne[1]) ?? notFound()) };
    }
    const payment = base.match(/^\/payments\/([^/]+)$/);
    if (method === 'GET' && payment) return this.payments.get(payment[1]) ?? notFound();
    const refundOf = base.match(/^\/payments\/([^/]+)\/refund$/);
    if (method === 'POST' && refundOf) {
      const p = this.payments.get(refundOf[1]) ?? notFound();
      const left = (p.amount || 0) - (p.amount_refunded || 0);
      const amount = Number(body?.amount ?? left);
      if (p.status !== 'captured' || amount < 1 || amount > left) {
        throw new Error(
          `Razorpay POST ${path} failed (400): The refund amount provided is greater than amount captured`
        );
      }
      const refund = this.refund(p.id, amount, {
        status: 'pending',
        notes: body?.notes || [],
        receipt: body?.receipt || null,
      });
      return { ...refund };
    }
    if (method === 'GET' && base === '/refunds') {
      const from = Number(q.get('from') || 0);
      const to = Number(q.get('to') || Number.MAX_SAFE_INTEGER);
      return page(
        [...this.refunds.values()]
          .filter((r) => r.created_at >= from && r.created_at <= to)
          .sort((a, b) => b.created_at - a.created_at)
      );
    }

    throw new Error(`FakeRazorpay: unexpected ${method} ${path}`);
  }

  /**
   * What Razorpay does when the customer approves the mandate: the
   * subscription becomes authenticated (a trial: first charge later) or
   * active (charged now).
   */
  authorise(
    subscriptionId: string,
    opts: { trialDays?: number; method?: string; international?: boolean } = {}
  ) {
    const sub = this.subscriptions.get(subscriptionId)!;
    sub.payment_method = opts.method || 'upi';
    // Not on the real entity: the fake's note of the card's origin, which
    // Razorpay reports on the card's payments (payment.international).
    sub.card_international = !!opts.international;
    if (opts.trialDays) {
      sub.status = 'authenticated';
      sub.start_at = sub.start_at || now() + opts.trialDays * 86400;
      sub.charge_at = sub.start_at;
    } else {
      sub.status = 'active';
      sub.paid_count = 1;
      sub.current_start = now();
      // One cycle of the plan: a year on a yearly plan, else a month.
      const yearly = this.plans.get(sub.plan_id)?.period === 'yearly';
      sub.current_end = now() + (yearly ? 365 : 30) * 86400;
      sub.charge_at = sub.current_end;
    }
    return { ...sub };
  }

  /**
   * A charge Razorpay could not take: it starts the next billing cycle
   * unpaid (one more cycle booked off remaining_count than paid_count counts,
   * as live sub_TYd1D4gZnW0EP2 showed) and the subscription goes `pending`
   * while it retries, then `halted` once the retries are over. Works for a
   * trial's first charge (nothing paid yet) and a renewal alike.
   */
  failCharge(subscriptionId: string, status: 'pending' | 'halted' = 'pending') {
    const sub = this.subscriptions.get(subscriptionId)!;
    if (sub.status !== 'pending' && sub.status !== 'halted') {
      // The charge is due now: the paid cycle (or the trial) has just run
      // out, and the new cycle starts unpaid.
      const start = now();
      sub.current_start = start;
      sub.current_end = start + 30 * 86400;
      // The cycles paid for, plus this one, booked.
      sub.remaining_count =
        Number(sub.total_count) - (Number(sub.paid_count || 0) + 1);
    }
    sub.status = status;
    if (status === 'halted') sub.halted_at = now();
    return { ...sub };
  }

  /** A retry went through: the unpaid cycle is paid, `active` again. */
  retrySucceeds(subscriptionId: string) {
    const sub = this.subscriptions.get(subscriptionId)!;
    sub.status = 'active';
    sub.paid_count = Number(sub.paid_count || 0) + 1;
    return { sub: { ...sub }, payment: this.charge(subscriptionId) };
  }

  /**
   * A captured charge on `subscriptionId`, as subscription.charged carries it
   * (the amount is the plan's, in paise). Razorpay raises an invoice for
   * every subscription charge and stamps the payment with its id, which is
   * the only way back from a refund to the subscription it was on
   * (RazorpayService.handleRefund, subscriptionRefunded), so the invoice is
   * made here too.
   */
  charge(subscriptionId: string, amount?: number) {
    const sub = this.subscriptions.get(subscriptionId)!;
    const plan = this.plans.get(sub.plan_id);
    const payment: any = {
      id: this.id('pay'),
      entity: 'payment',
      amount: amount ?? plan?.item?.amount ?? 0,
      currency: plan?.item?.currency || 'INR',
      status: 'captured',
      captured: true,
      method: sub.payment_method || 'upi',
      international: !!sub.card_international,
      ...(sub.payment_method === 'card'
        ? { card: { network: 'Visa', international: !!sub.card_international } }
        : {}),
      created_at: now(),
    };
    const invoice = {
      id: this.id('inv'),
      entity: 'invoice',
      subscription_id: sub.id,
      customer_id: sub.customer_id,
      payment_id: payment.id,
      status: 'paid',
      amount: payment.amount,
      currency: payment.currency,
      created_at: payment.created_at,
    };
    payment.invoice_id = invoice.id;
    this.invoices.push(invoice);
    this.payments.set(payment.id, payment);
    return payment;
  }

  /**
   * A paid invoice for `payment` on `subscriptionId`, linked both ways as on
   * the live account (payment.invoice_id, invoice.subscription_id): the only
   * road from a disputed payment back to its subscription.
   */
  invoiceFor(subscriptionId: string, payment: any) {
    const invoice = {
      id: this.id('inv'),
      entity: 'invoice',
      subscription_id: subscriptionId,
      payment_id: payment.id,
      status: 'paid',
      amount: payment.amount,
      currency: payment.currency,
      created_at: now(),
    };
    this.invoices.push(invoice);
    const stored = this.payments.get(payment.id);
    if (stored) stored.invoice_id = invoice.id;
    payment.invoice_id = invoice.id;
    return invoice;
  }

  /**
   * A bank's chargeback on `paymentId`, as Razorpay's payment.dispute.*
   * webhooks carry it (docs: Disputes API entity). `status` moves on with
   * setDisputeStatus, which is what GET /disputes/:id then answers.
   */
  dispute(paymentId: string, over: Record<string, any> = {}) {
    const p = this.payments.get(paymentId);
    const d = {
      id: this.id('disp'),
      entity: 'dispute',
      payment_id: paymentId,
      amount: p?.amount ?? 0,
      currency: p?.currency || 'INR',
      amount_deducted: 0,
      reason_code: 'chargeback',
      reason_description: 'The customer disputed the charge with their bank',
      respond_by: now() + 3 * 86400,
      status: 'open',
      phase: 'chargeback',
      created_at: now(),
      ...over,
    };
    this.disputes.set(d.id, d);
    return { ...d };
  }

  setDisputeStatus(disputeId: string, status: string) {
    const d = this.disputes.get(disputeId)!;
    d.status = status;
    return { ...d };
  }

  /**
   * A refund made outside Hookpost's API calls (the Razorpay dashboard's form
   * stores notes.comment; Razorpay's own automatic refunds carry no notes).
   * The payment's amount_refunded follows, as on the live account.
   */
  refund(paymentId: string, amount: number, over: Record<string, any> = {}) {
    const p = this.payments.get(paymentId);
    const refund = {
      id: this.id('rfnd'),
      entity: 'refund',
      amount,
      currency: p?.currency || 'INR',
      payment_id: paymentId,
      notes: [],
      receipt: null,
      acquirer_data: { arn: null, rrn: null },
      created_at: now(),
      status: 'processed',
      ...over,
    };
    this.refunds.set(refund.id, refund);
    if (p) {
      p.amount_refunded = (p.amount_refunded || 0) + amount;
      const full = p.amount_refunded >= p.amount;
      p.refund_status = full ? 'full' : 'partial';
      if (full) p.status = 'refunded';
    }
    return refund;
  }

  /** A webhook body and its signature, as Razorpay would POST them. */
  static signedEvent(event: string, entities: Record<string, any>, secret: string) {
    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(entities)) payload[k] = { entity: v };
    const raw = JSON.stringify({
      entity: 'event',
      account_id: 'acc_test',
      event,
      contains: Object.keys(entities),
      payload,
      created_at: now(),
    });
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    return { raw, signature };
  }
}
