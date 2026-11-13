/**
 * Plan changes end to end (owner's policy, 29 Oct 2026), through the real
 * backend and an in-memory Razorpay (FakeRazorpay):
 *
 *   - Upgrade: immediate. On a card Razorpay re-plans the mandate and charges
 *     its own prorated difference, and the billing page quotes that exact
 *     figure first. On UPI (cannot be re-planned) a new mandate starts now and
 *     the unused days become time on the new plan; nothing is charged today.
 *   - Downgrade: at the end of the cycle paid for. The workspace keeps the
 *     higher plan until then, and can undo it.
 *   - The break-it cases: a double click, a failing renewal, a tampered plan,
 *     another workspace's session.
 */
import { startApp, TestApp } from './setup/app';
import { Session, inviteTokenFrom } from './setup/api';
import { db, disconnectDb } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

describe('plan changes', () => {
  let t: TestApp;
  let rzp: FakeRazorpay;
  const secret = () => process.env.RAZORPAY_WEBHOOK_SECRET!;

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    t = await startApp();
  });
  afterAll(async () => {
    rzp.uninstall();
    await t?.close();
    await disconnectDb();
  });

  const postWebhook = (event: string, entities: Record<string, any>) => {
    const signed = FakeRazorpay.signedEvent(event, entities, secret());
    return t.api.request('POST', '/razorpay/webhook', {
      raw: signed.raw,
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signed.signature },
    });
  };

  const row = (orgId: string) => db().subscription.findUniqueOrThrow({ where: { organizationId: orgId } });

  /**
   * A workspace paying for `billing` monthly on `method`, `daysIn` days into
   * a 30-day cycle. The charge is the plan's list price, with its invoice.
   */
  /**
   * `card-intl` is a card issued outside India, the only mandate Razorpay
   * re-plans in place; `card` is an Indian one.
   */
  async function paying(
    billing: string,
    method: 'card-intl' | 'card' | 'upi' | 'emandate' | 'wallet',
    daysIn = 0,
    period = 'MONTHLY'
  ) {
    const s = await t.api.register();
    const { orgId } = await s.self();
    await db().organization.update({ where: { id: orgId }, data: { allowTrial: false } });
    const res = await s.post('/billing/embedded', { billing, period });
    if (res.status !== 201) throw new Error(`embedded ${res.status} ${res.text}`);
    const subId = res.body.subscriptionId as string;
    rzp.authorise(subId, {
      method: method === 'card-intl' ? 'card' : method,
      international: method === 'card-intl',
    });
    const sub = rzp.subscriptions.get(subId);
    // No first-month offer in these cases: the credit is priced on the
    // invoice either way, and the offer case has its own unit spec.
    sub.offer_id = null;
    const plan = rzp.plans.get(sub.plan_id);
    const payment = rzp.charge(subId, plan.item.amount);
    sub.current_start = nowSec() - daysIn * DAY;
    sub.current_end = sub.current_start + (period === 'YEARLY' ? 365 : 30) * DAY;
    sub.charge_at = sub.current_end;
    rzp.invoices.push({
      id: `inv_${subId}`,
      entity: 'invoice',
      subscription_id: subId,
      payment_id: payment.id,
      amount: plan.item.amount,
      status: 'paid',
      billing_start: sub.current_start,
      billing_end: sub.current_end,
      paid_at: sub.current_start,
      created_at: sub.current_start,
    });
    const hook = await postWebhook('subscription.charged', { subscription: { ...sub }, payment });
    expect(hook.status).toBe(201);
    expect((await row(orgId)).subscriptionTier).toBe(billing);
    return { s, orgId, subId };
  }

  describe('upgrade on a card: immediate, Razorpay prorates, and the quote is exact', () => {
    it('Standard -> Pro on day 16 of 30: quotes Rs 700, Razorpay takes Rs 700, Pro at once with no webhook', async () => {
      const { s, orgId, subId } = await paying('STANDARD', 'card-intl', 15);

      const quote = await s.post('/billing/prorate', { billing: 'PRO', period: 'MONTHLY' });
      expect(quote.status).toBe(201);
      expect(quote.body).toMatchObject({ direction: 'upgrade', effectiveAt: 'now', mode: 'in_place' });
      // (1999 - 599) x 15 / 30
      expect(quote.body.chargeToday).toBe(700);
      expect(quote.body.creditApplied).toBe(299.5);

      const res = await s.post('/billing/embedded', { billing: 'PRO', period: 'MONTHLY' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ direction: 'upgrade', effectiveAt: 'now' });

      const charged = rzp.prorations.filter((p) => p.subscriptionId === subId);
      expect(charged).toEqual([{ subscriptionId: subId, amount: 70000 }]);
      expect(charged[0].amount / 100).toBe(quote.body.chargeToday);

      // Pro now, from the PATCH alone: no subscription.updated was posted.
      const after = await row(orgId);
      expect(after).toMatchObject({ subscriptionTier: 'PRO', identifier: subId });
      expect((await s.self()).tier).toBe('PRO');
      // Same mandate, same renewal date: no second subscription.
      expect([...rzp.subscriptions.values()].filter((x) => x.notes?.orgId === orgId)).toHaveLength(1);
    });

    it('Standard monthly -> Standard yearly quotes the year less the unused month', async () => {
      const { s, subId } = await paying('STANDARD', 'card-intl', 0);
      const quote = await s.post('/billing/prorate', { billing: 'STANDARD', period: 'YEARLY' });
      expect(quote.body).toMatchObject({ direction: 'upgrade', chargeToday: 5990 - 599 });
      await s.post('/billing/embedded', { billing: 'STANDARD', period: 'YEARLY' });
      expect(rzp.prorations.filter((p) => p.subscriptionId === subId)).toEqual([
        { subscriptionId: subId, amount: 599000 - 59900 },
      ]);
    });

    it('a double click upgrades once: the second request is refused while the first is in flight', async () => {
      const { s, subId } = await paying('STANDARD', 'card-intl', 10);
      const before = rzp.subscriptions.size;
      const [a, b] = await Promise.all([
        s.post('/billing/embedded', { billing: 'PRO', period: 'MONTHLY' }),
        s.post('/billing/embedded', { billing: 'PRO', period: 'MONTHLY' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(rzp.prorations.filter((p) => p.subscriptionId === subId)).toHaveLength(1);
      expect(rzp.subscriptions.size).toBe(before);

      // And a later third click on the plan it is now on opens nothing new.
      const again = await s.post('/billing/prorate', { billing: 'PRO', period: 'MONTHLY' });
      expect(again.body.direction).not.toBe('upgrade');
    });
  });

  describe('downgrade on a card: at the cycle end, undoable', () => {
    it('Pro -> Standard keeps Pro until the renewal, shows the scheduled change, and undo drops it', async () => {
      const { s, orgId, subId } = await paying('PRO', 'card-intl', 5);
      const sub = rzp.subscriptions.get(subId);

      const quote = await s.post('/billing/prorate', { billing: 'STANDARD', period: 'MONTHLY' });
      expect(quote.body).toMatchObject({ direction: 'downgrade', effectiveAt: 'cycle_end', chargeToday: 0 });

      const res = await s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ direction: 'downgrade', effectiveAt: 'cycle_end' });
      const patch = rzp.calls.filter((c) => c.method === 'PATCH' && c.path === `/subscriptions/${subId}`);
      expect(patch.at(-1)?.body.schedule_change_at).toBe('cycle_end');
      // Nothing charged or refunded, and still Pro.
      expect(rzp.prorations.filter((p) => p.subscriptionId === subId)).toHaveLength(0);
      expect((await row(orgId)).subscriptionTier).toBe('PRO');

      const ctx = await s.get('/billing/pricing-context');
      expect(ctx.body.scheduledChange).toMatchObject({ billing: 'STANDARD', period: 'MONTHLY', how: 'in_place' });
      expect(new Date(ctx.body.scheduledChange.at).getTime() / 1000).toBeCloseTo(sub.current_end, -1);

      const undo = await s.post('/billing/plan-change/undo');
      expect(undo.body).toEqual({ undone: true });
      expect(rzp.subscriptions.get(subId).has_scheduled_changes).toBe(false);
      expect((await s.get('/billing/pricing-context')).body.scheduledChange).toBeNull();
      // A second undo is a no-op, not an error.
      expect((await s.post('/billing/plan-change/undo')).body).toEqual({ undone: false });
      expect((await row(orgId)).subscriptionTier).toBe('PRO');
    });
  });

  describe('UPI (cannot be re-planned)', () => {
    beforeAll(() => {
      rzp.refuseUpiPatch = true;
    });
    afterAll(() => {
      rzp.refuseUpiPatch = false;
    });

    it('upgrade: nothing charged today, the unused days become Pro time, Pro on approval, old mandate stopped at once', async () => {
      const { s, orgId, subId } = await paying('STANDARD', 'upi', 10);

      const quote = await s.post('/billing/prorate', { billing: 'PRO', period: 'MONTHLY' });
      expect(quote.body).toMatchObject({ direction: 'upgrade', mode: 'new_mandate', chargeToday: 0 });
      // 599 x 20/30, to the paise, rounded down.
      expect(quote.body.creditApplied).toBeCloseTo(399.33, 2);

      const res = await s.post('/billing/embedded', { billing: 'PRO', period: 'MONTHLY' });
      expect(res.status).toBe(201);
      const fresh = rzp.subscriptions.get(res.body.subscriptionId);
      expect(fresh.id).not.toBe(subId);
      // Rs 399.33 buys 399.33/1999 of 30 days of Pro: just under 6 days.
      const covered = fresh.start_at - nowSec();
      expect(covered).toBeGreaterThan(5.9 * DAY);
      expect(covered).toBeLessThan(6.0 * DAY);
      expect(fresh.notes).toMatchObject({ change: 'upgrade', replaces: subId, from_billing: 'STANDARD' });
      // Abandoned until approved: the old plan is untouched.
      expect(rzp.subscriptions.get(subId).status).toBe('active');
      expect((await row(orgId)).subscriptionTier).toBe('STANDARD');

      const approved = rzp.authorise(fresh.id, { method: 'upi', trialDays: 1 });
      expect((await postWebhook('subscription.authenticated', { subscription: approved })).status).toBe(201);
      // Redelivered: still one switch.
      expect((await postWebhook('subscription.authenticated', { subscription: approved })).status).toBe(201);

      expect(await row(orgId)).toMatchObject({ subscriptionTier: 'PRO', identifier: fresh.id });
      const old = rzp.calls.filter((c) => c.path === `/subscriptions/${subId}/cancel`);
      expect(old.map((c) => c.body)).toEqual([{ cancel_at_cycle_end: 0 }]);
      // The old mandate's cancelled webhook is a plan switch, not an end.
      await postWebhook('subscription.cancelled', { subscription: rzp.subscriptions.get(subId) });
      expect(await row(orgId)).toMatchObject({ subscriptionTier: 'PRO', identifier: fresh.id });
    });

    it('a second upgrade in the same cycle keeps the credit the first one left', async () => {
      const { s, orgId, subId } = await paying('STANDARD', 'upi', 10);
      const first = await s.post('/billing/embedded', { billing: 'PRO', period: 'MONTHLY' });
      const pro = rzp.subscriptions.get(first.body.subscriptionId);
      expect(pro.notes.replaces).toBe(subId);
      const approved = rzp.authorise(pro.id, { method: 'upi', trialDays: 1 });
      await postWebhook('subscription.authenticated', { subscription: approved });
      expect((await row(orgId)).subscriptionTier).toBe('PRO');

      // Pro monthly -> Pro yearly before the credited Pro time runs out.
      const quote = await s.post('/billing/prorate', { billing: 'PRO', period: 'YEARLY' });
      expect(quote.body.direction).toBe('upgrade');
      // Almost all of the Rs 399.33 carried over is still unused.
      expect(quote.body.creditApplied).toBeGreaterThan(399);
      expect(quote.body.creditApplied).toBeLessThanOrEqual(399.33);
      const second = await s.post('/billing/embedded', { billing: 'PRO', period: 'YEARLY' });
      const yearly = rzp.subscriptions.get(second.body.subscriptionId);
      expect(yearly.notes).toMatchObject({ replaces: pro.id, change: 'upgrade' });
      expect(yearly.start_at).toBeGreaterThan(nowSec() + 3600);
    });

    it('downgrade scheduled, then upgrade back: refused toward the plan already kept, with the way to keep it', async () => {
      const { s, orgId } = await paying('PRO', 'upi', 3);
      const res = await s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY' });
      const approved = rzp.authorise(res.body.subscriptionId, { method: 'upi', trialDays: 1 });
      await postWebhook('subscription.authenticated', { subscription: approved });
      expect((await row(orgId)).subscriptionTier).toBe('PRO');
      const before = rzp.subscriptions.size;
      const again = await s.post('/billing/embedded', { billing: 'PRO', period: 'MONTHLY' });
      expect(again.status).toBe(400);
      expect(again.body.code).toBe('USE_KEEP_PLAN');
      expect(rzp.subscriptions.size).toBe(before);
      // The way it offers: a mandate for Pro that starts where Pro is paid to.
      const keep = await s.post('/billing/plan-change/keep-plan');
      expect(keep.status).toBe(201);
      const kept = rzp.subscriptions.get(keep.body.subscriptionId);
      expect(rzp.plans.get(kept.plan_id).item.amount).toBe(199900);
      expect(kept.start_at).toBe(approved.start_at);
    });

    it('downgrade: the new mandate starts where the paid cycle ends, Pro is kept until then, the old mandate stops at once', async () => {
      const { s, orgId, subId } = await paying('PRO', 'upi', 3);
      const paidEnd = rzp.subscriptions.get(subId).current_end;

      const res = await s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY' });
      expect(res.status).toBe(201);
      const fresh = rzp.subscriptions.get(res.body.subscriptionId);
      expect(fresh.start_at).toBe(paidEnd);
      expect(fresh.notes).toMatchObject({ change: 'downgrade', from_billing: 'PRO', replaces: subId });

      const approved = rzp.authorise(fresh.id, { method: 'upi', trialDays: 1 });
      await postWebhook('subscription.authenticated', { subscription: approved });
      // Still Pro, on the new mandate, and the old one is stopped now: no
      // cycle-end promise left at Razorpay.
      expect(await row(orgId)).toMatchObject({ subscriptionTier: 'PRO', identifier: fresh.id });
      expect(rzp.subscriptions.get(subId).status).toBe('cancelled');
      expect(rzp.calls.filter((c) => c.path === `/subscriptions/${subId}/cancel`).map((c) => c.body)).toEqual([
        { cancel_at_cycle_end: 0 },
      ]);
      await postWebhook('subscription.cancelled', { subscription: rzp.subscriptions.get(subId) });
      expect((await row(orgId)).subscriptionTier).toBe('PRO');

      const ctx = await s.get('/billing/pricing-context');
      expect(ctx.body.scheduledChange).toMatchObject({ billing: 'STANDARD', how: 'new_mandate' });

      // The cycle ends and the new mandate charges for the first time: Standard.
      const landed = rzp.subscriptions.get(fresh.id);
      Object.assign(landed, {
        status: 'active',
        paid_count: 1,
        current_start: nowSec(),
        current_end: nowSec() + 30 * DAY,
      });
      const pay = rzp.charge(fresh.id);
      await postWebhook('subscription.charged', { subscription: { ...landed }, payment: pay });
      expect((await row(orgId)).subscriptionTier).toBe('STANDARD');
    });
  });

  describe('break it', () => {
    it('a renewal that is failing cannot change plan, and nothing is created at Razorpay', async () => {
      const { s, subId } = await paying('STANDARD', 'card-intl', 29);
      rzp.subscriptions.get(subId).status = 'pending';
      const before = rzp.calls.length;
      const res = await s.post('/billing/embedded', { billing: 'PRO', period: 'MONTHLY' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PLAN_CHANGE_DUNNING');
      const sent = rzp.calls.slice(before).filter((c) => c.method !== 'GET');
      expect(sent).toEqual([]);
      const quote = await s.post('/billing/prorate', { billing: 'PRO', period: 'MONTHLY' });
      expect(quote.body.refusalCode).toBe('PLAN_CHANGE_DUNNING');
    });

    it('a tampered plan or a price in the body is refused or ignored: the price is always the server\'s', async () => {
      const { s, subId } = await paying('STANDARD', 'card-intl', 15);
      for (const billing of ['FREE', 'ENTERPRISE', 'TEAM', 'ULTIMATE', 'pro; drop table']) {
        const r = await s.post('/billing/embedded', { billing, period: 'MONTHLY' });
        expect(r.status).toBe(400);
      }
      expect((await s.post('/billing/embedded', { billing: 'PRO', period: 'WEEKLY' })).status).toBe(400);
      const r = await s.post('/billing/embedded', {
        billing: 'PRO',
        period: 'MONTHLY',
        amount: 1,
        price: 1,
        plan_id: 'plan_cheap',
      });
      expect(r.status).toBe(201);
      const patched = rzp.calls.filter((c) => c.method === 'PATCH' && c.path === `/subscriptions/${subId}`).at(-1)!;
      expect(rzp.plans.get(patched.body.plan_id).item.amount).toBe(199900);
      expect(rzp.prorations.filter((p) => p.subscriptionId === subId)).toEqual([{ subscriptionId: subId, amount: 70000 }]);
    });

    it('another workspace can neither see nor undo this one\'s scheduled change (IDOR)', async () => {
      const a = await paying('PRO', 'card-intl', 5);
      await a.s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY' });
      const b = await t.api.register();
      // B points its session at A's workspace.
      const forged = new Session(b.api, b.auth, b.email, b.password, a.orgId);
      const ctx = await forged.get('/billing/pricing-context');
      expect(ctx.body?.scheduledChange ?? null).toBeNull();
      const undo = await forged.post('/billing/plan-change/undo');
      expect(undo.body?.undone ?? false).toBe(false);
      expect((await forged.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY' })).body?.subscriptionId)
        .not.toBe(a.subId);
      expect(rzp.subscriptions.get(a.subId).has_scheduled_changes).toBe(true);
      expect((await a.s.get('/billing/pricing-context')).body.scheduledChange).toMatchObject({ billing: 'STANDARD' });
    });

    it('a member without billing rights cannot change or undo the plan', async () => {
      const a = await paying('PRO', 'card-intl', 5);
      const invite = await a.s.post('/settings/team', { role: 'USER', sendEmail: false });
      const member = await t.api.register({ cookies: { org: inviteTokenFrom(invite.body.url) } });
      member.showorg = a.orgId;
      expect((await member.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY' })).status).toBeGreaterThanOrEqual(400);
      expect((await member.post('/billing/plan-change/undo')).status).toBeGreaterThanOrEqual(400);
      expect((await row(a.orgId)).subscriptionTier).toBe('PRO');
    });

    it('the same plan again on a healthy mandate is refused, and opens nothing', async () => {
      const { s } = await paying('STANDARD', 'card-intl', 4);
      const before = rzp.subscriptions.size;
      const res = await s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PLAN_UNCHANGED');
      expect(rzp.subscriptions.size).toBe(before);
    });

    it('cancel then resubscribe to the same plan goes through Reactivate, which starts at the old paid end', async () => {
      const { s, orgId, subId } = await paying('STANDARD', 'card-intl', 12);
      const paidEnd = rzp.subscriptions.get(subId).current_end;
      expect((await s.post('/billing/cancel')).status).toBe(201);
      const again = await s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY' });
      expect(again.status).toBe(400);
      expect(again.body.code).toBe('USE_REACTIVATE');

      const react = await s.post('/billing/reactivate');
      expect(react.status).toBe(201);
      const fresh = rzp.subscriptions.get(react.body.subscriptionId);
      expect(fresh.start_at).toBe(paidEnd);
      const approved = rzp.authorise(fresh.id, { method: 'card', trialDays: 1 });
      await postWebhook('subscription.authenticated', { subscription: approved });
      expect(await row(orgId)).toMatchObject({ subscriptionTier: 'STANDARD', identifier: fresh.id, cancelAt: null });
    });

    it('refund, then cancel: the plan ends at once and a later checkout is a fresh one, not a credit', async () => {
      const { s, orgId, subId } = await paying('STANDARD', 'upi', 2);
      const inv = rzp.invoices.find((i) => i.subscription_id === subId);
      rzp.refund(inv.payment_id, 59900);
      const cancel = await s.post('/billing/cancel');
      expect(cancel.status).toBe(201);
      expect(await db().subscription.findUnique({ where: { organizationId: orgId } }).then((r) => !r || (r.cancelAt && r.cancelAt.getTime() <= Date.now() + 60_000))).toBe(true);
      const fresh = await s.post('/billing/embedded', { billing: 'PRO', period: 'MONTHLY' });
      expect(fresh.status).toBe(201);
      const sub = rzp.subscriptions.get(fresh.body.subscriptionId);
      expect(sub.notes.credit).toBeUndefined();
    });

    it('upgrade while a cancellation is pending opens a fresh mandate, and the plan no longer ends', async () => {
      const { s, orgId, subId } = await paying('STANDARD', 'card-intl', 10);
      expect((await s.post('/billing/cancel')).status).toBe(201);
      expect((await row(orgId)).cancelAt).not.toBeNull();

      // The line agrees with what checkout does: a new mandate, not a card proration.
      const quote = await s.post('/billing/prorate', { billing: 'PRO', period: 'MONTHLY' });
      expect(quote.body).toMatchObject({ direction: 'upgrade', mode: 'new_mandate' });

      const res = await s.post('/billing/embedded', { billing: 'PRO', period: 'MONTHLY' });
      expect(res.status).toBe(201);
      const fresh = rzp.subscriptions.get(res.body.subscriptionId);
      if (!fresh) throw new Error(JSON.stringify(res.body));
      expect(fresh.id).not.toBe(subId);
      const approved = rzp.authorise(fresh.id, { method: 'card', trialDays: 1 });
      await postWebhook('subscription.authenticated', { subscription: approved });
      const after = await row(orgId);
      expect(after).toMatchObject({ subscriptionTier: 'PRO', identifier: fresh.id, cancelAt: null });
    });
  });
});
