import {
  billingIdentityHash,
  buildPlanKey,
  chargeSource,
  paymentMethodKeys,
  cancelProvenAtRazorpay,
  canStillCharge,
  chargedPlanTerms,
  currentCycleUnpaid,
  isHaltedUnpaidTrial,
  isUnpaidTrial,
  paidPastSavedEnd,
  paidThrough,
  planMismatch,
  preChargeVerdict,
  scheduledCancelAt,
  startsNewTrial,
  trialAccessUntil,
} from '@hookpost/nestjs-libraries/services/razorpay.mapping';

// What a subscription's plan charges, as the Change payment method quote and
// the current plan card both state it.

const plan = (amount: number | undefined, currency = 'INR', period = 'MONTHLY') => ({
  id: 'plan_x',
  period: period === 'YEARLY' ? 'yearly' : 'monthly',
  item: { amount, currency },
  notes: { hookpost_key: buildPlanKey('STANDARD', period, amount || 0, currency) },
});

describe('chargedPlanTerms', () => {
  const row = { subscriptionTier: 'STANDARD', period: 'MONTHLY' };

  it('takes the amount from the plan, not from pricing.ts', () => {
    expect(
      chargedPlanTerms({
        plan: plan(69900),
        tier: { billing: 'STANDARD', period: 'MONTHLY' },
        row,
      })
    ).toEqual({ billing: 'STANDARD', period: 'MONTHLY', currency: 'INR', amount: 699 });
  });

  it('the plan decides tier and period over the stored row', () => {
    expect(
      chargedPlanTerms({
        plan: plan(199900),
        tier: { billing: 'PRO', period: 'YEARLY' },
        row,
      })
    ).toMatchObject({ billing: 'PRO', period: 'YEARLY', amount: 1999 });
  });

  it('a plan Hookpost did not create falls back to the row for tier and period', () => {
    expect(chargedPlanTerms({ plan: plan(69900), tier: null, row })).toMatchObject({
      billing: 'STANDARD',
      period: 'MONTHLY',
      amount: 699,
    });
  });

  it('currency: the plan, then the subscription notes, then INR', () => {
    expect(chargedPlanTerms({ plan: plan(1500, 'usd'), tier: null, row }).currency).toBe('USD');
    expect(
      chargedPlanTerms({ plan: null, tier: null, row, subscriptionNotes: { currency: 'usd' } })
        .currency
    ).toBe('USD');
    expect(chargedPlanTerms({ plan: null, tier: null, row }).currency).toBe('INR');
  });

  it.each([[null], [plan(undefined)], [plan(0)], [{ item: { amount: 'abc' } }]])(
    'no readable amount is null, never a guess: %p',
    (p) => {
      expect(chargedPlanTerms({ plan: p, tier: null, row }).amount).toBeNull();
    }
  );
});

describe('trial helpers', () => {
  const ours = { service: 'hookpost', orgId: 'org-1' };
  const trial = (extra: any = {}) => ({
    id: 'sub_t',
    status: 'authenticated',
    paid_count: 0,
    notes: { ...ours },
    ...extra,
  });

  const NOW = Date.UTC(2026, 9, 18, 6, 0, 0);
  const inDays = (d: number) => Math.floor(NOW / 1000) + Math.round(d * 86400);

  it('startsNewTrial: an authorised Hookpost trial, never a replacement or a foreign one', () => {
    const trial = (extra: any = {}) => ({
      id: 'sub_t',
      status: 'authenticated',
      paid_count: 0,
      start_at: inDays(7),
      notes: { ...ours },
      ...extra,
    });
    expect(startsNewTrial(trial(), NOW)).toBe(true);
    // A plan switch or new payment method during a trial continues it.
    expect(startsNewTrial(trial({ notes: { ...ours, replaces: 'sub_a', trial: '1' } }))).toBe(false);
    expect(startsNewTrial(trial({ notes: { ...ours, replaces: 'sub_a' } }))).toBe(false);
    expect(startsNewTrial(trial({ status: 'active' }))).toBe(false);
    expect(startsNewTrial(trial({ status: 'created' }))).toBe(false);
    expect(startsNewTrial(trial({ notes: { service: 'vetnow' } }))).toBe(false);
    expect(startsNewTrial(null)).toBe(false);
  });

  it('startsNewTrial: a checkout that charges now is not a trial, though `authenticated`', () => {
    const sub = (extra: any = {}) => ({
      id: 'sub_now',
      status: 'authenticated',
      paid_count: 0,
      notes: { ...ours },
      ...extra,
    });
    // No trial (allowTrial false, RAZORPAY_TRIAL_DAYS=0): no start_at, charge_at ~ now.
    expect(startsNewTrial(sub({ charge_at: inDays(0) }), NOW)).toBe(false);
    expect(startsNewTrial(sub({ start_at: inDays(0), charge_at: inDays(0) }), NOW)).toBe(false);
    // Nothing on the payload says when it charges: not counted.
    expect(startsNewTrial(sub(), NOW)).toBe(false);
    // Under 12 hours away is a plan starting, not a trial.
    expect(startsNewTrial(sub({ start_at: inDays(0.4) }), NOW)).toBe(false);
    expect(startsNewTrial(sub({ start_at: inDays(0.6) }), NOW)).toBe(true);
    // A free-months coupon delays the first charge: still a trial start.
    expect(startsNewTrial(sub({ start_at: inDays(37) }), NOW)).toBe(true);
    // Something already paid, or a payload that does not say: not counted.
    expect(startsNewTrial(sub({ start_at: inDays(7), paid_count: 1 }), NOW)).toBe(false);
    expect(startsNewTrial(sub({ start_at: inDays(7), paid_count: undefined }), NOW)).toBe(false);
  });

  it('isUnpaidTrial: paid_count must say 0; a paid replacement is not a trial', () => {
    expect(isUnpaidTrial(trial({ status: 'pending' }))).toBe(true);
    expect(isUnpaidTrial(trial({ status: 'halted', paid_count: '0' }))).toBe(true);
    expect(isUnpaidTrial(trial({ notes: { ...ours, replaces: 'sub_a', trial: '1' } }))).toBe(true);
    expect(isUnpaidTrial(trial({ paid_count: 1 }))).toBe(false);
    expect(isUnpaidTrial(trial({ paid_count: undefined }))).toBe(false);
    expect(isUnpaidTrial(trial({ paid_count: null }))).toBe(false);
    expect(isUnpaidTrial(trial({ notes: { ...ours, replaces: 'sub_a' } }))).toBe(false);
  });

  it('trialAccessUntil: a trial before its first charge was attempted runs to start_at', () => {
    const at = 1_800_000_000;
    // Running, or cancelled from there (Razorpay cancels a trial at once).
    expect(trialAccessUntil(trial({ start_at: at }))).toBe(at);
    expect(trialAccessUntil(trial({ status: 'cancelled', start_at: at }))).toBe(at);
    // A plan switch during the trial is still the trial.
    expect(
      trialAccessUntil(trial({ status: 'cancelled', start_at: at, notes: { ...ours, replaces: 'sub_a', trial: '1' } }))
    ).toBe(at);
    // No paid_count, but no billing cycle either: nothing can have been paid.
    expect(trialAccessUntil(trial({ status: 'cancelled', start_at: at, paid_count: undefined }))).toBe(at);
    // The first charge was attempted, or paid: not a trial any more.
    expect(trialAccessUntil(trial({ status: 'pending', start_at: at }))).toBe(0);
    expect(trialAccessUntil(trial({ status: 'halted', start_at: at }))).toBe(0);
    expect(trialAccessUntil(trial({ status: 'cancelled', start_at: at, current_end: at + 30 * 86400 }))).toBe(0);
    expect(trialAccessUntil(trial({ status: 'cancelled', start_at: at, paid_count: 1 }))).toBe(0);
    expect(trialAccessUntil(trial({ status: 'active', start_at: at }))).toBe(0);
    // A Reactivate or Change payment method mandate of a paid plan: paid time, not a trial.
    expect(
      trialAccessUntil(trial({ status: 'cancelled', start_at: at, notes: { ...ours, replaces: 'sub_a' } }))
    ).toBe(0);
    expect(trialAccessUntil(null)).toBe(0);
  });

  it('isHaltedUnpaidTrial: halted, Hookpost, never paid', () => {
    expect(isHaltedUnpaidTrial(trial({ status: 'halted' }))).toBe(true);
    expect(isHaltedUnpaidTrial(trial({ status: 'pending' }))).toBe(false);
    expect(isHaltedUnpaidTrial(trial({ status: 'halted', paid_count: 1 }))).toBe(false);
    expect(isHaltedUnpaidTrial(trial({ status: 'halted', notes: { service: 'tablamigo' } }))).toBe(false);
  });
});

describe('currentCycleUnpaid / paidThrough: where the paid time ends', () => {
  // As Razorpay reported them on 20 Oct 2026 (sub_TYd1D4gZnW0EP2 and
  // sub_TXvoILk8Rch2Wo).
  const start = 1791829800; // 12 Oct 2026 18:30 UTC
  const end = 1794508200; // 12 Nov 2026 18:30 UTC
  const halted = {
    status: 'halted',
    total_count: 120,
    remaining_count: 118,
    paid_count: 1,
    current_start: start,
    current_end: end,
  };

  it('a renewal that halted: the paid time ended where the unpaid cycle started', () => {
    expect(currentCycleUnpaid(halted)).toBe(true);
    expect(paidThrough(halted)).toBe(start);
    // Still so once it is cancelled, and while Razorpay retries (pending).
    expect(paidThrough({ ...halted, status: 'cancelled' })).toBe(start);
    expect(paidThrough({ ...halted, status: 'pending' })).toBe(start);
  });

  it('paid up: current_end', () => {
    const paid = { ...halted, status: 'active', paid_count: 2 };
    expect(currentCycleUnpaid(paid)).toBe(false);
    expect(paidThrough(paid)).toBe(end);
    expect(paidThrough({ ...paid, status: 'cancelled' })).toBe(end);
    // `active` is paid up, whatever the counts say.
    expect(paidThrough({ ...halted, status: 'active' })).toBe(end);
  });

  it('a payload without the counts is never read as unpaid', () => {
    for (const key of ['total_count', 'remaining_count', 'paid_count']) {
      const partial: any = { ...halted };
      delete partial[key];
      expect(currentCycleUnpaid(partial)).toBe(false);
      expect(paidThrough(partial)).toBe(end);
    }
    expect(paidThrough(null)).toBe(0);
  });

  it('a checkout charged on approval and never approved has no paid time', () => {
    // Razorpay books its first cycle when it is created, before any cycle runs.
    const never = { status: 'cancelled', total_count: 120, remaining_count: 119, paid_count: 0 };
    expect(currentCycleUnpaid(never)).toBe(true);
    expect(paidThrough(never)).toBe(0);
  });
});

describe('paidPastSavedEnd: only a halted renewal paid after all lifts a saved end date', () => {
  const start = 1791829800; // 12 Oct 2026 18:30 UTC
  const end = 1794508200; // 12 Nov 2026 18:30 UTC
  const active = {
    status: 'active',
    total_count: 120,
    remaining_count: 118,
    paid_count: 2,
    current_start: start,
    current_end: end,
    end_at: end + 3650 * 86400, // where all cycles finish: nothing scheduled
  };

  it('a cycle-end cancel is saved as current_end and is never lifted, even when end_at does not show it', () => {
    expect(paidPastSavedEnd(active, new Date(end * 1000))).toBe(false);
    // Within a day of current_end (clock skew, rounding) is still kept.
    expect(paidPastSavedEnd(active, new Date((end - 3600) * 1000))).toBe(false);
  });

  it('the end set when a renewal halted, since paid, runs weeks short of current_end: lifted', () => {
    const grace = new Date((start + 10 * 86400) * 1000);
    expect(paidPastSavedEnd(active, grace)).toBe(true);
    expect(paidPastSavedEnd(active, grace.toISOString())).toBe(true);
  });

  it('never when Razorpay is not billing it, or shows an end of its own', () => {
    const grace = new Date((start + 10 * 86400) * 1000);
    for (const status of ['halted', 'pending', 'cancelled', 'authenticated']) {
      expect(paidPastSavedEnd({ ...active, status }, grace)).toBe(false);
    }
    expect(paidPastSavedEnd({ ...active, end_at: end }, grace)).toBe(false);
    expect(paidPastSavedEnd(active, null)).toBe(false);
    expect(paidPastSavedEnd(null, grace)).toBe(false);
  });
});

describe('cancelProvenAtRazorpay: a cycle-end cancel leaves no proof', () => {
  // Razorpay's docs: with cancel_at_cycle_end=1 the status "changes to
  // cancelled only at the end of the current billing cycle", and
  // has_scheduled_changes / change_scheduled_at describe a pending *update*
  // (the Update API's schedule_change_at), not a pending cancel. So between
  // the request and the cycle end the entity is identical to one that will
  // renew. Shape taken from live sub_TXvoILk8Rch2Wo on 29 Oct 2026.
  const afterCycleEndCancel = {
    status: 'active',
    current_start: 1791743400,
    current_end: 1794335400,
    charge_at: 1794335400,
    end_at: 2102005800,
    has_scheduled_changes: false,
    change_scheduled_at: null,
  };

  it('is false right after a cycle-end cancel, however the entity is read', () => {
    expect(cancelProvenAtRazorpay(afterCycleEndCancel)).toBe(false);
    expect(scheduledCancelAt(afterCycleEndCancel)).toBeNull();
  });

  it('is false when Razorpay claims a scheduled change, which is about updates', () => {
    expect(
      cancelProvenAtRazorpay({
        ...afterCycleEndCancel,
        has_scheduled_changes: true,
        change_scheduled_at: 1794335400,
      })
    ).toBe(false);
  });

  it('is true once Razorpay really ends it, or really will', () => {
    expect(cancelProvenAtRazorpay({ ...afterCycleEndCancel, status: 'cancelled', ended_at: 1793276131 })).toBe(true);
    // end_at pulled back to the cycle end is the one shape that does prove it.
    expect(cancelProvenAtRazorpay({ ...afterCycleEndCancel, end_at: 1794335400 })).toBe(true);
  });
});

describe('canStillCharge', () => {
  const now = 1793276131;
  const live = { status: 'active', charge_at: now + 86400, end_at: now + 3650 * 86400, current_end: now + 86400 };

  it('is true for a live mandate with a debit still to come', () => {
    expect(canStillCharge(live, now)).toBe(true);
  });

  it('is true on the very second the charge is due', () => {
    // The 11 Nov race: charge_at and the saved end on the same instant.
    expect(canStillCharge({ ...live, charge_at: now }, now)).toBe(true);
  });

  it('is true for a pending retry even when its charge date has passed', () => {
    expect(canStillCharge({ ...live, status: 'pending', charge_at: now - 3600 }, now)).toBe(true);
  });

  it('is false once Razorpay has stopped it, and for states that cannot debit', () => {
    expect(canStillCharge({ ...live, status: 'cancelled', ended_at: now }, now)).toBe(false);
    // halted: Razorpay has given up retrying and attempts nothing by itself.
    expect(canStillCharge({ ...live, status: 'halted' }, now)).toBe(false);
    // created: never approved.
    expect(canStillCharge({ ...live, status: 'created' }, now)).toBe(false);
    expect(canStillCharge({ ...live, charge_at: now - 3600 }, now)).toBe(false);
    expect(canStillCharge(null, now)).toBe(false);
  });
});

describe('preChargeVerdict: when the guard cancels at Razorpay', () => {
  const now = 1793276131;
  const sub = (extra: any = {}) => ({
    status: 'active',
    charge_at: now + 30 * 86400,
    current_start: now - 86400,
    current_end: now + 30 * 86400,
    end_at: now + 3650 * 86400,
    total_count: 120,
    remaining_count: 118,
    paid_count: 2,
    ...extra,
  });
  const at = (sec: number) => new Date(sec * 1000);

  it('cancels when the charge and the saved end are the same instant inside 48 hours', () => {
    const when = now + 47 * 3600;
    expect(
      preChargeVerdict({ subscription: sub({ charge_at: when, current_end: when }), cancelAt: at(when), nowSec: now })
    ).toMatchObject({ cancel: true });
  });

  it('cancels when the saved end has passed and nothing was paid past it', () => {
    // A replacement mandate waiting to start charging: nothing taken yet.
    expect(
      preChargeVerdict({
        subscription: sub({
          status: 'authenticated',
          current_start: null,
          current_end: null,
          charge_at: now + 10 * 86400,
          paid_count: 0,
          remaining_count: 120,
        }),
        cancelAt: at(now - 60),
        nowSec: now,
      })
    ).toMatchObject({ cancel: true });
  });

  it('asks the caller to look when the cycle is paid past the saved end', () => {
    // A halted renewal that was paid after all, or a cancel Razorpay charged
    // through: only the refunds say which, so nothing is decided here.
    expect(
      preChargeVerdict({ subscription: sub(), cancelAt: at(now - 60), nowSec: now })
    ).toEqual({
      cancel: false,
      recheck: true,
      reason: 'it is paid past the end saved here',
    });
  });

  it('asks the caller to look even when the charge is hours away', () => {
    expect(
      preChargeVerdict({
        subscription: sub({ charge_at: now + 3600 }),
        cancelAt: at(now + 1800),
        nowSec: now,
      })
    ).toMatchObject({ cancel: false, recheck: true });
  });

  it('waits while the charge is more than 48 hours away', () => {
    const when = now + 49 * 3600;
    expect(
      preChargeVerdict({ subscription: sub({ charge_at: when, current_end: when }), cancelAt: at(when), nowSec: now })
    ).toEqual({ cancel: false, reason: 'the next charge is more than 48 hours away' });
  });

  it('never cancels an unpaid cycle: that charge is the customer settling it', () => {
    expect(
      preChargeVerdict({
        subscription: sub({ status: 'pending', paid_count: 2, remaining_count: 117, charge_at: now + 3600 }),
        cancelAt: at(now + 7200),
        nowSec: now,
      })
    ).toEqual({ cancel: false, reason: 'the current cycle is unpaid, so a charge would settle it' });
  });

  it('never cancels what Razorpay cannot charge', () => {
    expect(
      preChargeVerdict({ subscription: sub({ status: 'cancelled', ended_at: now }), cancelAt: at(now - 60), nowSec: now })
    ).toEqual({ cancel: false, reason: 'Razorpay cannot charge it' });
  });

  it('never cancels on an unreadable end date', () => {
    expect(
      preChargeVerdict({ subscription: sub({ charge_at: now + 3600 }), cancelAt: 'not a date', nowSec: now })
    ).toEqual({ cancel: false, reason: 'no readable end date' });
  });
});

describe('planMismatch: what the guard reports but never acts on', () => {
  const now = 1793276131;
  const charging = {
    status: 'active',
    created_at: now - 30 * 86400,
    charge_at: now + 86400,
    current_end: now + 86400,
    end_at: now + 3650 * 86400,
  };

  it('flags a subscription that can charge with no row behind it', () => {
    expect(planMismatch({ subscription: charging, row: null, nowSec: now })).toBe(
      'charging_without_plan'
    );
  });

  it('stays quiet about a checkout approved in the last few hours', () => {
    expect(
      planMismatch({ subscription: { ...charging, created_at: now - 600 }, row: null, nowSec: now })
    ).toBeNull();
  });

  it('flags a plan with no end date whose subscription has ended', () => {
    expect(
      planMismatch({
        subscription: { ...charging, status: 'cancelled', ended_at: now - 86400 },
        row: { cancelAt: null },
        nowSec: now,
      })
    ).toBe('plan_without_subscription');
  });

  it('stays quiet while a cancelled plan runs out the time it paid for', () => {
    expect(
      planMismatch({
        subscription: { ...charging, status: 'cancelled', ended_at: now },
        row: { cancelAt: new Date((now + 10 * 86400) * 1000) },
        nowSec: now,
      })
    ).toBeNull();
  });

  it('stays quiet when the two agree', () => {
    expect(planMismatch({ subscription: charging, row: { cancelAt: null }, nowSec: now })).toBeNull();
    expect(planMismatch({ subscription: null, row: null, nowSec: now })).toBeNull();
  });
});

describe('once per person: what identifies a payment method', () => {
  it('a UPI VPA, lower case and trimmed; payment.upi.vpa for UPI AutoPay', () => {
    expect(paymentMethodKeys({ method: 'upi', vpa: ' Jo.Hn@OKHDFC ' })).toEqual([
      { kind: 'UPI', value: 'jo.hn@okhdfc' },
    ]);
    expect(paymentMethodKeys({ method: 'upi', vpa: null, upi: { vpa: 'a@ybl' } })).toEqual([
      { kind: 'UPI', value: 'a@ybl' },
    ]);
  });

  it('a card: network, last4, issuer and a hash of the name, never the name itself', () => {
    const [key] = paymentMethodKeys({
      method: 'card',
      card: { network: 'Visa', last4: '4242', issuer: 'hdfc', name: '  Jatin  Kumar ' },
    });
    expect(key.kind).toBe('CARD');
    expect(key.value).toMatch(/^visa\|4242\|HDFC\|[0-9a-f]{64}$/);
    expect(key.value).not.toContain('Kumar');
    // The same card however the name is spaced or cased.
    expect(
      paymentMethodKeys({ card: { network: 'VISA', last4: '4242', issuer: 'HDFC', name: 'jatin kumar' } })
    ).toEqual([key]);
    // Another cardholder's card with the same last four is another card.
    expect(
      paymentMethodKeys({ card: { network: 'Visa', last4: '4242', issuer: 'HDFC', name: 'Someone Else' } })[0]
        .value
    ).not.toBe(key.value);
  });

  it('nothing for netbanking, a wallet, a malformed VPA or a card without its digits', () => {
    expect(paymentMethodKeys({ method: 'netbanking', bank: 'HDFC' })).toEqual([]);
    expect(paymentMethodKeys({ method: 'wallet', wallet: 'paytm' })).toEqual([]);
    expect(paymentMethodKeys({ vpa: 'not-a-vpa' })).toEqual([]);
    expect(paymentMethodKeys({ card: { network: 'Visa', last4: '' } })).toEqual([]);
    // Network, issuer and last four alone are shared by strangers.
    expect(paymentMethodKeys({ card: { network: 'Visa', last4: '4242', issuer: 'HDFC', name: ' ' } })).toEqual([]);
    expect(paymentMethodKeys(null)).toEqual([]);
  });

  it('the stored hash depends on the kind and never contains the value', () => {
    const h = billingIdentityHash('UPI', 'a@ybl');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(billingIdentityHash('UPI', 'a@ybl'));
    expect(h).not.toBe(billingIdentityHash('EMAIL', 'a@ybl'));
  });

  it('a charge is OFFER only for the first one on an offer subscription', () => {
    expect(chargeSource({ offer_id: 'offer_x', paid_count: 1 })).toBe('OFFER');
    expect(chargeSource({ offer_id: 'offer_x', paid_count: 2 })).toBe('PAID');
    expect(chargeSource({ offer_id: null, paid_count: 1 })).toBe('PAID');
  });
});
