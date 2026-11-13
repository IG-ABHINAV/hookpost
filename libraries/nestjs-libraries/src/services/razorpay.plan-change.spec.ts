/**
 * The plan-change policy, as the owner approved it on 29 Oct 2026:
 *
 *   - An upgrade (higher tier, or monthly -> yearly) takes effect at once and
 *     the unused days of the cycle already paid for are credited against it.
 *     No refund, nothing lost, no free days.
 *   - A downgrade takes effect at the next billing cycle. The workspace keeps
 *     the higher plan until then.
 *   - Cancel stops the mandate at Razorpay at once; the workspace keeps the
 *     plan until the end of the cycle paid for (the plan row's cancelAt).
 *
 * These are the pure sums behind it (razorpay.mapping.ts). The Razorpay calls
 * that carry them out are in razorpay.cancel-and-mandates.spec.ts and
 * tests/integration/billing-plan-change.int.spec.ts.
 */
import {
  creditCoveredSeconds,
  cycleSecondsFor,
  inPlaceChangeMinor,
  newMandateUpgradeTerms,
  planChangeDirection,
  planChangeRefusal,
  unusedCreditMinor,
} from '@hookpost/nestjs-libraries/services/razorpay.mapping';

const DAY = 86400;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

// Rupees in paise, the only units these sums ever work in.
const STANDARD_M = 59900;
const STANDARD_Y = 599000;
const PRO_M = 199900;
const PRO_Y = 1999000;

describe('planChangeDirection', () => {
  it('calls a higher tier an upgrade and a lower tier a downgrade', () => {
    expect(
      planChangeDirection(
        { billing: 'STANDARD', period: 'MONTHLY' },
        { billing: 'PRO', period: 'MONTHLY' }
      )
    ).toBe('upgrade');
    expect(
      planChangeDirection(
        { billing: 'PRO', period: 'MONTHLY' },
        { billing: 'STANDARD', period: 'MONTHLY' }
      )
    ).toBe('downgrade');
  });

  it('ranks the tiers that are no longer sold where their price puts them', () => {
    // TEAM (Rs 1,499) sits between STANDARD (Rs 599) and PRO (Rs 1,999);
    // ULTIMATE above PRO. There are live rows on both (pricing.ts).
    expect(
      planChangeDirection(
        { billing: 'STANDARD', period: 'MONTHLY' },
        { billing: 'TEAM', period: 'MONTHLY' }
      )
    ).toBe('upgrade');
    expect(
      planChangeDirection(
        { billing: 'ULTIMATE', period: 'MONTHLY' },
        { billing: 'PRO', period: 'MONTHLY' }
      )
    ).toBe('downgrade');
  });

  it('calls monthly -> yearly an upgrade and yearly -> monthly a downgrade', () => {
    expect(
      planChangeDirection(
        { billing: 'STANDARD', period: 'MONTHLY' },
        { billing: 'STANDARD', period: 'YEARLY' }
      )
    ).toBe('upgrade');
    expect(
      planChangeDirection(
        { billing: 'STANDARD', period: 'YEARLY' },
        { billing: 'STANDARD', period: 'MONTHLY' }
      )
    ).toBe('downgrade');
  });

  it('lets the tier decide when the period moves the other way', () => {
    // Standard yearly -> Pro monthly is more product, so it is an upgrade and
    // takes effect now; Pro yearly -> Standard monthly is less, so it waits.
    expect(
      planChangeDirection(
        { billing: 'STANDARD', period: 'YEARLY' },
        { billing: 'PRO', period: 'MONTHLY' }
      )
    ).toBe('upgrade');
    expect(
      planChangeDirection(
        { billing: 'PRO', period: 'YEARLY' },
        { billing: 'STANDARD', period: 'MONTHLY' }
      )
    ).toBe('downgrade');
  });

  it('calls the same plan the same plan', () => {
    expect(
      planChangeDirection(
        { billing: 'PRO', period: 'YEARLY' },
        { billing: 'PRO', period: 'YEARLY' }
      )
    ).toBe('same');
  });

  it('reads the tier and period however they are cased', () => {
    expect(
      planChangeDirection(
        { billing: 'standard', period: 'monthly' },
        { billing: 'Pro', period: 'Monthly' }
      )
    ).toBe('upgrade');
  });

  it('treats a tier it does not know as the same plan rather than guessing', () => {
    // A plan from another product on the shared Razorpay account must never
    // be read as an upgrade and charged for.
    expect(
      planChangeDirection(
        { billing: 'WHATEVER', period: 'MONTHLY' },
        { billing: 'PRO', period: 'MONTHLY' }
      )
    ).toBe('same');
  });
});

describe('unusedCreditMinor', () => {
  const cycle = { paidMinor: STANDARD_M, cycleStart: 1_000_000, cycleEnd: 1_000_000 + MONTH };

  it('credits the unused share of what was actually paid', () => {
    // Half the month gone: half of Rs 599.
    expect(unusedCreditMinor(cycle, cycle.cycleStart + MONTH / 2)).toBe(29950);
  });

  it('credits what was paid, not the list price', () => {
    // The 20% first-month offer charged Rs 479.20; the credit follows it.
    expect(
      unusedCreditMinor(
        { ...cycle, paidMinor: 47920 },
        cycle.cycleStart + MONTH / 2
      )
    ).toBe(23960);
  });

  it('gives the whole cycle back on day one and nothing on the last day', () => {
    expect(unusedCreditMinor(cycle, cycle.cycleStart)).toBe(STANDARD_M);
    expect(unusedCreditMinor(cycle, cycle.cycleEnd)).toBe(0);
  });

  it('is never negative once the cycle has run out', () => {
    expect(unusedCreditMinor(cycle, cycle.cycleEnd + DAY)).toBe(0);
  });

  it('is never more than what was paid, whatever the clock says', () => {
    expect(unusedCreditMinor(cycle, cycle.cycleStart - DAY)).toBe(STANDARD_M);
  });

  it('gives nothing when nothing was paid', () => {
    expect(unusedCreditMinor({ ...cycle, paidMinor: 0 }, cycle.cycleStart)).toBe(0);
    expect(unusedCreditMinor({ ...cycle, paidMinor: -1 }, cycle.cycleStart)).toBe(0);
  });

  it('gives nothing for a cycle with no length, rather than dividing by zero', () => {
    expect(
      unusedCreditMinor(
        { paidMinor: STANDARD_M, cycleStart: 1_000_000, cycleEnd: 1_000_000 },
        1_000_000
      )
    ).toBe(0);
    expect(
      unusedCreditMinor(
        { paidMinor: STANDARD_M, cycleStart: 1_000_000, cycleEnd: 0 },
        1_000_000
      )
    ).toBe(0);
  });

  it('rounds to a whole paise, down, so a credit is never invented', () => {
    // A third of a month of Rs 599 is 19966.66 paise.
    const third = cycle.cycleEnd - MONTH / 3;
    expect(unusedCreditMinor(cycle, third)).toBe(19966);
    expect(Number.isInteger(unusedCreditMinor(cycle, third))).toBe(true);
  });

  it('does not care which timezone the boundary is read in', () => {
    // Unix seconds only: the same instant gives the same credit however the
    // server's TZ is set.
    const atBoundary = cycle.cycleEnd;
    const before = new Date(atBoundary * 1000);
    expect(unusedCreditMinor(cycle, Math.floor(before.getTime() / 1000))).toBe(0);
  });
});

describe('creditCoveredSeconds', () => {
  it('turns a credit into the time it buys on the new plan', () => {
    // Rs 299.50 of credit against Pro monthly (Rs 1,999 for 30 days).
    expect(creditCoveredSeconds(29950, PRO_M, MONTH)).toBe(
      Math.floor((29950 * MONTH) / PRO_M)
    );
  });

  it('buys more time on a yearly plan, which costs less per day', () => {
    expect(creditCoveredSeconds(29950, STANDARD_Y, YEAR)).toBeGreaterThan(
      creditCoveredSeconds(29950, STANDARD_M, MONTH)
    );
  });

  it('buys nothing with no credit, and never a negative span', () => {
    expect(creditCoveredSeconds(0, PRO_M, MONTH)).toBe(0);
    expect(creditCoveredSeconds(-500, PRO_M, MONTH)).toBe(0);
  });

  it('buys nothing when the new plan has no readable price', () => {
    expect(creditCoveredSeconds(29950, 0, MONTH)).toBe(0);
    expect(creditCoveredSeconds(29950, NaN, MONTH)).toBe(0);
  });

  it('rounds down to a whole second', () => {
    const covered = creditCoveredSeconds(12345, PRO_M, MONTH);
    expect(Number.isInteger(covered)).toBe(true);
  });
});

describe('cycleSecondsFor', () => {
  it('is a month or a year', () => {
    expect(cycleSecondsFor('MONTHLY')).toBe(MONTH);
    expect(cycleSecondsFor('YEARLY')).toBe(YEAR);
  });

  it('falls back to a month for anything else', () => {
    expect(cycleSecondsFor('WEEKLY' as never)).toBe(MONTH);
  });
});

describe('newMandateUpgradeTerms', () => {
  // The upgrade Razorpay cannot make in place (every UPI Autopay and
  // e-mandate): a new mandate on the new plan whose first charge is pushed
  // out by the time the unused credit buys, so the customer pays nothing
  // today and loses none of what they already paid.
  const nowSec = 1_700_000_000;
  const base = {
    nowSec,
    cycle: { paidMinor: STANDARD_M, cycleStart: nowSec - MONTH / 2, cycleEnd: nowSec + MONTH / 2 },
    newAmountMinor: PRO_M,
    newPeriod: 'MONTHLY' as const,
  };

  it('pushes the first charge out by the time the credit buys', () => {
    const terms = newMandateUpgradeTerms(base);
    expect(terms.creditMinor).toBe(29950);
    expect(terms.coveredSeconds).toBe(Math.floor((29950 * MONTH) / PRO_M));
    expect(terms.startAt).toBe(nowSec + terms.coveredSeconds);
    // Nothing is taken at the authentication transaction: Razorpay charges
    // the Rs 5 mandate check and refunds it (a future start_at, no upfront).
    expect(terms.chargeNowMinor).toBe(0);
  });

  it('charges the full price at once when the old cycle is spent', () => {
    // The last hour of the cycle: the credit buys less than the lead time, so
    // there is nothing to defer and the new plan simply starts now.
    const terms = newMandateUpgradeTerms({
      ...base,
      cycle: { paidMinor: STANDARD_M, cycleStart: nowSec - MONTH, cycleEnd: nowSec + 60 },
    });
    expect(terms.startAt).toBeNull();
    expect(terms.chargeNowMinor).toBe(PRO_M);
  });

  it('gives most of a month of the new plan for an upgrade on day one', () => {
    const terms = newMandateUpgradeTerms({
      ...base,
      cycle: { paidMinor: STANDARD_M, cycleStart: nowSec, cycleEnd: nowSec + MONTH },
    });
    expect(terms.creditMinor).toBe(STANDARD_M);
    // Rs 599 of Pro at Rs 1,999 a month is nine days and a bit.
    expect(terms.coveredSeconds).toBe(Math.floor((STANDARD_M * MONTH) / PRO_M));
    expect(terms.chargeNowMinor).toBe(0);
  });

  it('carries a monthly cycle over to a yearly plan without losing a paise', () => {
    // Standard monthly, half gone, to Standard yearly: Rs 299.50 buys 18 days
    // of a Rs 5,990 year, so the yearly charge lands 18 days out.
    const terms = newMandateUpgradeTerms({
      ...base,
      newAmountMinor: STANDARD_Y,
      newPeriod: 'YEARLY',
    });
    expect(terms.creditMinor).toBe(29950);
    expect(terms.coveredSeconds).toBe(Math.floor((29950 * YEAR) / STANDARD_Y));
    expect(terms.startAt).toBe(nowSec + terms.coveredSeconds);
    expect(terms.chargeNowMinor).toBe(0);
  });

  it('carries a long yearly cycle over to a monthly plan', () => {
    // Standard yearly with 300 days left, upgrading to Pro monthly. The
    // credit is big, so the first Pro charge is months away -- it is never
    // charged up front.
    const terms = newMandateUpgradeTerms({
      nowSec,
      cycle: { paidMinor: STANDARD_Y, cycleStart: nowSec - 65 * DAY, cycleEnd: nowSec + 300 * DAY },
      newAmountMinor: PRO_M,
      newPeriod: 'MONTHLY',
    });
    expect(terms.chargeNowMinor).toBe(0);
    expect(terms.creditMinor).toBeLessThanOrEqual(STANDARD_Y);
    expect(terms.startAt).toBe(nowSec + terms.coveredSeconds);
  });

  it('never credits more than was paid, and never a negative credit', () => {
    for (const at of [-MONTH, -1, 0, MONTH / 2, MONTH, MONTH + DAY]) {
      const terms = newMandateUpgradeTerms({
        ...base,
        cycle: { paidMinor: STANDARD_M, cycleStart: nowSec - at, cycleEnd: nowSec - at + MONTH },
      });
      expect(terms.creditMinor).toBeGreaterThanOrEqual(0);
      expect(terms.creditMinor).toBeLessThanOrEqual(STANDARD_M);
      expect(terms.chargeNowMinor).toBeGreaterThanOrEqual(0);
    }
  });

  it('gives no credit for a cycle that was refunded', () => {
    const terms = newMandateUpgradeTerms({ ...base, refunded: true });
    expect(terms.creditMinor).toBe(0);
    expect(terms.startAt).toBeNull();
    expect(terms.chargeNowMinor).toBe(PRO_M);
  });

  it('gives no credit for a trial, which paid nothing', () => {
    const terms = newMandateUpgradeTerms({
      ...base,
      cycle: { paidMinor: 0, cycleStart: nowSec - MONTH / 2, cycleEnd: nowSec + MONTH / 2 },
    });
    expect(terms.creditMinor).toBe(0);
    expect(terms.chargeNowMinor).toBe(PRO_M);
  });

  it('keeps the credit that a second upgrade in the same cycle has left', () => {
    // Upgrade once: Standard -> Pro, first charge pushed to nowSec + covered.
    const first = newMandateUpgradeTerms(base);
    // A day later, upgrade again. What is left is the unspent part of the
    // time the first credit bought, priced at Pro: pass it in as the cycle.
    const laterNow = nowSec + DAY;
    const second = newMandateUpgradeTerms({
      nowSec: laterNow,
      cycle: {
        paidMinor: first.creditMinor,
        cycleStart: nowSec,
        cycleEnd: first.startAt!,
      },
      newAmountMinor: 449900,
      newPeriod: 'MONTHLY',
    });
    expect(second.creditMinor).toBeGreaterThan(0);
    expect(second.creditMinor).toBeLessThan(first.creditMinor);
    expect(second.chargeNowMinor).toBe(0);
  });

  it('always lands start_at strictly in the future, which Razorpay requires', () => {
    for (const left of [60, 3600, DAY, 15 * DAY]) {
      const terms = newMandateUpgradeTerms({
        ...base,
        cycle: { paidMinor: STANDARD_M, cycleStart: nowSec - MONTH + left, cycleEnd: nowSec + left },
      });
      if (terms.startAt !== null) expect(terms.startAt).toBeGreaterThan(nowSec);
    }
  });
});

describe('planChangeRefusal', () => {
  const ok = {
    direction: 'upgrade' as const,
    status: 'active',
    crossCurrency: false,
    isLifetime: false,
  };

  it('allows an upgrade on a plan that is paying', () => {
    expect(planChangeRefusal(ok)).toBeNull();
  });

  it('refuses while a charge is failing: pay first', () => {
    for (const status of ['pending', 'halted']) {
      const refusal = planChangeRefusal({ ...ok, status });
      expect(refusal?.code).toBe('PLAN_CHANGE_DUNNING');
      expect(refusal?.message).toMatch(/pay/i);
    }
  });

  it('refuses a change that would cross currencies in place', () => {
    const refusal = planChangeRefusal({ ...ok, crossCurrency: true });
    expect(refusal?.code).toBe('PLAN_CHANGE_CURRENCY');
  });

  it('refuses to touch a lifetime plan', () => {
    const refusal = planChangeRefusal({ ...ok, isLifetime: true });
    expect(refusal?.code).toBe('PLAN_CHANGE_LIFETIME');
  });

  it('refuses a downgrade just as firmly while a charge is failing', () => {
    expect(planChangeRefusal({ ...ok, direction: 'downgrade', status: 'halted' })?.code).toBe(
      'PLAN_CHANGE_DUNNING'
    );
  });

  it('says nothing about a plan that is not changing', () => {
    expect(planChangeRefusal({ ...ok, direction: 'same' })).toBeNull();
  });
});

describe('inPlaceChangeMinor (Razorpay card proration)', () => {
  // The three worked examples on
  // https://razorpay.com/docs/payments/subscriptions/update/, to the rupee.
  // Day N of a cycle that started at T is any moment in [T+(N-1)d, T+Nd).
  const T = 1_790_000_000;
  const onDay = (n: number) => T + (n - 1) * DAY + 3600;

  it('daily example: 8-day cycle, Rs 1000 x2 -> Rs 400 x1 on day 6 refunds Rs 600', () => {
    const out = inPlaceChangeMinor({
      oldAmountMinor: 100000 * 2,
      newAmountMinor: 40000,
      cycleStart: T,
      cycleEnd: T + 8 * DAY,
      nowSec: onDay(6),
      sameFrequency: true,
    });
    expect(out).toEqual({ amountMinor: -60000, creditMinor: 75000, remainingDays: 3 });
  });

  it('yearly -> monthly on day 245: Rs 21,900 - Rs 3,630 = Rs 18,270', () => {
    const out = inPlaceChangeMinor({
      oldAmountMinor: 1095000,
      newAmountMinor: 2190000,
      cycleStart: T,
      cycleEnd: T + 365 * DAY,
      nowSec: onDay(245),
      sameFrequency: false,
    });
    expect(out).toEqual({ amountMinor: 1827000, creditMinor: 363000, remainingDays: 121 });
  });

  it('monthly -> quarterly on day 27: Rs 1,800 - Rs 40 = Rs 1,760', () => {
    const out = inPlaceChangeMinor({
      oldAmountMinor: 30000,
      newAmountMinor: 90000 * 2,
      cycleStart: T,
      cycleEnd: T + 30 * DAY,
      nowSec: onDay(27),
      sameFrequency: false,
    });
    expect(out).toEqual({ amountMinor: 176000, creditMinor: 4000, remainingDays: 4 });
  });

  it('Standard -> Pro monthly on day 16 of 30 charges the difference for the 15 days left', () => {
    const out = inPlaceChangeMinor({
      oldAmountMinor: STANDARD_M,
      newAmountMinor: PRO_M,
      cycleStart: T,
      cycleEnd: T + 30 * DAY,
      nowSec: onDay(16),
      sameFrequency: true,
    });
    // (1999 - 599) x 15/30 = Rs 700.00
    expect(out).toEqual({ amountMinor: 70000, creditMinor: 29950, remainingDays: 15 });
  });

  it('Standard monthly -> Standard yearly on day 1 charges the year less the whole month', () => {
    const out = inPlaceChangeMinor({
      oldAmountMinor: STANDARD_M,
      newAmountMinor: STANDARD_Y,
      cycleStart: T,
      cycleEnd: T + 30 * DAY,
      nowSec: onDay(1),
      sameFrequency: false,
    });
    expect(out).toEqual({ amountMinor: STANDARD_Y - STANDARD_M, creditMinor: STANDARD_M, remainingDays: 30 });
  });

  it('on the last day only that day is credited, and a clock past the end is read as the last day', () => {
    const last = inPlaceChangeMinor({
      oldAmountMinor: STANDARD_M,
      newAmountMinor: PRO_M,
      cycleStart: T,
      cycleEnd: T + 30 * DAY,
      nowSec: T + 30 * DAY + 5 * DAY,
      sameFrequency: true,
    });
    expect(last.remainingDays).toBe(1);
    expect(last.amountMinor).toBe(Math.round(PRO_M / 30) - Math.round(STANDARD_M / 30));
  });

  it('a clock before the cycle starts is read as day one, never more than a full cycle', () => {
    const early = inPlaceChangeMinor({
      oldAmountMinor: STANDARD_M,
      newAmountMinor: PRO_M,
      cycleStart: T,
      cycleEnd: T + 30 * DAY,
      nowSec: T - 10 * DAY,
      sameFrequency: true,
    });
    expect(early).toEqual({ amountMinor: PRO_M - STANDARD_M, creditMinor: STANDARD_M, remainingDays: 30 });
  });

  it('with no readable cycle charges the new plan and credits nothing, rather than inventing a credit', () => {
    expect(
      inPlaceChangeMinor({
        oldAmountMinor: STANDARD_M,
        newAmountMinor: PRO_M,
        cycleStart: 0,
        cycleEnd: 0,
        nowSec: T,
        sameFrequency: true,
      })
    ).toEqual({ amountMinor: PRO_M, creditMinor: 0, remainingDays: 0 });
  });
});
