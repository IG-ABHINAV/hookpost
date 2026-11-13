/**
 * The api.market plan table (marketplace.plans.ts): every paid plan keeps a
 * profit in the worst case, and the publish-time re-check the orchestrator
 * runs for marketplace workspaces.
 *   pnpm exec jest -c apps/backend/jest.config.ts marketplace.plans
 */
import {
  alertCreditThreshold,
  capMultiplier,
  CREDIT_COST,
  disabledProducts,
  hardCreditCap,
  isMarketplaceIdentifier,
  MARKETPLACE_FEE,
  MARKETPLACE_FEE_STRESS,
  MARKETPLACE_PLANS,
  MARKETPLACE_PRODUCTS,
  marketplaceIdentifier,
  marketplacePlan,
  marketplacePublishRefusal,
  netRevenueUsd,
  planForWindow,
  plansOf,
  PRIOR_PLAN_LIMITS,
  productProviders,
  QUOTA_WINDOW_DAYS,
  quotaWindow,
  trialXDailyBudgetUsd,
  worstCaseCostUsd,
  worstCaseMonthlyCredits,
  worstCaseProfitUsd,
  worstCaseUsdPerCredit,
  X_COST_USD,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';

const paid = Object.values(MARKETPLACE_PLANS).filter((p) => !p.trial);
const trials = Object.values(MARKETPLACE_PLANS).filter((p) => p.trial);

describe('profit: every paid plan makes money in the worst case', () => {
  it.each(paid.map((p) => [`${p.product}:${p.plan}`, p]))(
    '%s stays above 0 at a 20%% and a 25%% fee, with our whole cap (2x per 28 days) spent on the most expensive call',
    (_name, p) => {
      for (const fee of [MARKETPLACE_FEE, MARKETPLACE_FEE_STRESS]) {
        expect(worstCaseProfitUsd(p, fee)).toBeGreaterThan(0);
      }
    }
  );

  it('prices the worst case at our refusal point, not at the plan: 2x per 28-day window is 2.17x a month', () => {
    const standard = marketplacePlan('social', 'standard')!;
    expect(hardCreditCap(standard)).toBe(1000);
    expect(worstCaseMonthlyCredits(standard)).toBeCloseTo((1000 * 365.25) / 12 / 28, 6);
    expect(worstCaseMonthlyCredits(standard) / standard.credits).toBeCloseTo(2.174, 3);
  });

  it('prices X at its cost: $0.015 for 2 credits, $0.20 for 20, so a credit costs us $0.01 at most', () => {
    expect(X_COST_USD.tweet / CREDIT_COST.xTweet).toBeCloseTo(0.0075, 6);
    expect(X_COST_USD.tweetWithLink / CREDIT_COST.xTweetWithLink).toBeCloseTo(0.01, 6);
    const standard = marketplacePlan('social', 'standard')!;
    expect(worstCaseUsdPerCredit(standard)).toBeCloseTo(0.01, 6);
    expect(worstCaseCostUsd(standard, standard.credits)).toBeCloseTo(5, 6);
    expect(worstCaseCostUsd(standard)).toBeCloseTo(10.87, 2);
    expect(netRevenueUsd(standard)).toBeCloseTo(15.2, 6);
    // X without links (the X trial) costs $0.0075 a credit.
    expect(worstCaseUsdPerCredit(marketplacePlan('x', 'trial')!)).toBeCloseTo(0.0075, 6);
  });

  it('matches the design numbers (25 Oct 2026)', () => {
    const at = (product: string, plan: string, fee = MARKETPLACE_FEE) =>
      Math.round(worstCaseProfitUsd(marketplacePlan(product, plan)!, fee) * 100) / 100;
    expect(at('social', 'standard')).toBe(4.33);
    expect(at('social', 'standard', MARKETPLACE_FEE_STRESS)).toBe(3.38);
    expect(at('social', 'pro')).toBe(5.11);
    expect(at('social', 'pro', MARKETPLACE_FEE_STRESS)).toBe(3.16);
    expect(at('x', 'basic')).toBe(3.08);
    expect(at('x', 'basic', MARKETPLACE_FEE_STRESS)).toBe(2.48);
    expect(at('x', 'pro')).toBe(6.26);
    expect(at('x', 'pro', MARKETPLACE_FEE_STRESS)).toBe(4.51);
  });

  it('the old X price (1 credit a tweet, 10 with a link) would lose money at the 2x cap (why it changed)', () => {
    const at = (product: string, plan: string) => {
      const p = marketplacePlan(product, plan)!;
      return netRevenueUsd(p, MARKETPLACE_FEE_STRESS) - worstCaseMonthlyCredits(p) * 0.02;
    };
    for (const [product, plan] of [['social', 'standard'], ['social', 'pro'], ['x', 'basic'], ['x', 'pro']]) {
      expect(at(product, plan)).toBeLessThan(0);
    }
  });

  it('a cheaper Social Pro at $29 with 1,200 credits would lose money (why it is $39)', () => {
    const pro = { ...marketplacePlan('social', 'pro')!, priceUsd: 29 };
    expect(worstCaseProfitUsd(pro, MARKETPLACE_FEE_STRESS)).toBeLessThan(0);
  });
});

describe('the plan table', () => {
  it('has one 7-day-style trial (price 0) and at least one paid plan per product', () => {
    for (const product of MARKETPLACE_PRODUCTS) {
      const plans = plansOf(product);
      expect(plans.filter((p) => p.trial)).toHaveLength(1);
      expect(plans.filter((p) => !p.trial).length).toBeGreaterThan(0);
    }
    for (const t of trials) expect(t.priceUsd).toBe(0);
    for (const p of paid) expect(p.priceUsd).toBeGreaterThan(0);
  });

  it('keeps X off the Social trial and links off the X trial (25 tweets), threads of 5 at most', () => {
    expect(marketplacePlan('social', 'trial')).toMatchObject({ allowX: false, channels: 1, credits: 10 });
    expect(marketplacePlan('x', 'trial')).toMatchObject({ allowX: true, allowXLinks: false, threadCap: 5, credits: 50 });
    expect(marketplacePlan('x', 'trial')!.credits / CREDIT_COST.xTweet).toBe(25);
    for (const p of paid.filter((p) => p.allowX)) expect(p.threadCap).toBe(25);
  });

  it('schedules 7 days ahead on a trial and 35 on a paid plan (except the validator, which posts nothing)', () => {
    for (const t of trials.filter((t) => t.product !== 'validate')) expect(t.scheduleHorizonDays).toBe(7);
    for (const p of paid.filter((p) => p.product !== 'validate')) expect(p.scheduleHorizonDays).toBe(35);
  });

  it('maps Pro and Agency to the PRO tier and everything else to STANDARD', () => {
    expect(marketplacePlan('social', 'pro')!.tier).toBe('PRO');
    expect(marketplacePlan('linkedin', 'agency')!.tier).toBe('PRO');
    expect(marketplacePlan('x', 'pro')!.tier).toBe('PRO');
    for (const [key, p] of Object.entries(MARKETPLACE_PLANS)) {
      if (!['social:pro', 'linkedin:agency', 'x:pro'].includes(key)) expect(p.tier).toBe('STANDARD');
    }
  });

  it('holds a trial at 1.2x (it never renews) and a paid plan at 2x (a window can hold two api.market months)', () => {
    expect(hardCreditCap(marketplacePlan('social', 'trial')!)).toBe(12);
    expect(hardCreditCap(marketplacePlan('linkedin', 'trial')!)).toBe(60);
    expect(hardCreditCap(marketplacePlan('social', 'standard')!)).toBe(1000);
    expect(hardCreditCap(marketplacePlan('social', 'pro')!)).toBe(2400);
    expect(hardCreditCap(marketplacePlan('x', 'basic')!)).toBe(600);
    for (const t of trials) expect(capMultiplier(t)).toBe(1.2);
    for (const p of paid) expect(capMultiplier(p)).toBe(2);
  });

  it('logs a paid plan past 1.2x, and has no separate alert for a trial (its cap is 1.2x)', () => {
    expect(alertCreditThreshold(marketplacePlan('social', 'standard')!)).toBe(600);
    expect(alertCreditThreshold(marketplacePlan('linkedin', 'creator')!)).toBe(360);
    for (const t of trials) expect(alertCreditThreshold(t)).toBeNull();
  });

  it('bounds what one X trial can cost (25 plain tweets, x1.2)', () => {
    const trial = marketplacePlan('x', 'trial')!;
    expect(worstCaseCostUsd(trial)).toBeCloseTo(25 * 1.2 * 0.015, 6);
    expect(worstCaseCostUsd(trial)).toBeLessThan(0.5);
  });

  it('knows every plan by product and id, and nothing else', () => {
    expect(marketplacePlan('social', 'enterprise')).toBeNull();
    expect(marketplacePlan('nope', 'trial')).toBeNull();
  });
});

describe('quota windows', () => {
  const start = new Date('2026-10-01T00:00:00Z');
  it('counts 28-day windows from periodStart', () => {
    expect(QUOTA_WINDOW_DAYS).toBe(28);
    expect(quotaWindow(start, new Date('2026-10-01T00:00:00Z')).index).toBe(0);
    expect(quotaWindow(start, new Date('2026-10-28T23:59:59Z')).index).toBe(0);
    const next = quotaWindow(start, new Date('2026-10-29T00:00:00Z'));
    expect(next.index).toBe(1);
    expect(next.start.toISOString()).toBe('2026-10-29T00:00:00.000Z');
    expect(next.end.toISOString()).toBe('2026-11-26T00:00:00.000Z');
  });

  it('a window never holds three api.market months, so a buyer within the plan stays under the 2x cap', () => {
    // api.market's month runs from the subscription date (docs: renewDate one
    // month after currentPeriodStartDate); the shortest is February's 28 days.
    // Whatever day the buyer subscribed and first called, every window of
    // ours meets at most two of those months.
    const monthsMet = (subscribed: Date, firstCall: Date) => {
      const w = quotaWindow(firstCall, firstCall);
      let met = 0;
      for (let k = 0; k < 40; k++) {
        const from = new Date(subscribed);
        from.setUTCMonth(subscribed.getUTCMonth() + k);
        const to = new Date(subscribed);
        to.setUTCMonth(subscribed.getUTCMonth() + k + 1);
        if (from < w.end && to > w.start) met++;
      }
      return met;
    };
    for (const subscribed of ['2027-01-28T10:00:00Z', '2027-01-01T00:00:00Z', '2026-12-15T00:00:00Z']) {
      for (let lag = 0; lag < 90; lag++) {
        const s = new Date(subscribed);
        const firstCall = new Date(s.getTime() + lag * 86_400_000 + 3_600_000);
        expect(monthsMet(s, firstCall)).toBeLessThanOrEqual(2);
      }
    }
  });
  it('never goes negative for a clock behind periodStart', () => {
    expect(quotaWindow(start, new Date('2026-09-01T00:00:00Z')).index).toBe(0);
  });
});

describe('environment', () => {
  it('reads MKT_DISABLED_PRODUCTS as a list', () => {
    expect([...disabledProducts({ MKT_DISABLED_PRODUCTS: ' x, Social ,' })]).toEqual(['x', 'social']);
    expect(disabledProducts({}).size).toBe(0);
  });
  it('sells the default networks unless MKT_SOCIAL_PROVIDERS narrows them; the other products sell one', () => {
    expect(productProviders('social', {})).toEqual(
      expect.arrayContaining(['x', 'linkedin', 'threads', 'youtube'])
    );
    expect(productProviders('social', {})).toContain('tiktok');
    expect(productProviders('social', {})).not.toContain('linkedin-page');
    expect(productProviders('social', { MKT_SOCIAL_PROVIDERS: 'linkedin,discord' })).toEqual(['linkedin', 'discord']);
    expect(productProviders('linkedin', {})).toEqual(['linkedin']);
    expect(productProviders('x', {})).toEqual(['x']);
    expect(productProviders('validate', {})).toEqual([]);
  });
  it('reads MKT_TRIAL_X_DAILY_USD, falling back to $3', () => {
    expect(trialXDailyBudgetUsd({})).toBe(3);
    expect(trialXDailyBudgetUsd({ MKT_TRIAL_X_DAILY_USD: '' })).toBe(3);
    expect(trialXDailyBudgetUsd({ MKT_TRIAL_X_DAILY_USD: 'abc' })).toBe(3);
    expect(trialXDailyBudgetUsd({ MKT_TRIAL_X_DAILY_USD: '0.5' })).toBe(0.5);
    expect(trialXDailyBudgetUsd({ MKT_TRIAL_X_DAILY_USD: '0' })).toBe(0);
  });
  it('builds and recognises apimkt: identifiers', () => {
    expect(marketplaceIdentifier('x', 'cll8kolno0000l808v6p3xvax')).toBe('apimkt:x:cll8kolno0000l808v6p3xvax');
    expect(isMarketplaceIdentifier('apimkt:x:abc')).toBe(true);
    expect(isMarketplaceIdentifier('sub_123')).toBe(false);
    expect(isMarketplaceIdentifier('gumroad:abc')).toBe(false);
    expect(isMarketplaceIdentifier(null)).toBe(false);
  });
});

describe('marketplacePublishRefusal (the orchestrator re-check)', () => {
  const account = (product: string, plan: string, status = 'ACTIVE') => ({ product, plan, status });

  it('refuses X for the Social trial, allows it on Standard', () => {
    expect(marketplacePublishRefusal(account('social', 'trial'), 'x', {})).toMatch(/does not include X/);
    expect(marketplacePublishRefusal(account('social', 'trial'), 'twitter', {})).toMatch(/does not include X/);
    expect(marketplacePublishRefusal(account('social', 'standard'), 'x', {})).toBeNull();
  });
  it('allows the trial its other networks', () => {
    expect(marketplacePublishRefusal(account('social', 'trial'), 'linkedin', {})).toBeNull();
  });
  it('refuses a network outside the product', () => {
    expect(marketplacePublishRefusal(account('linkedin', 'creator'), 'x', {})).toMatch(/does not include X/);
    expect(marketplacePublishRefusal(account('linkedin', 'creator'), 'threads', {})).toMatch(/does not post to threads/);
    expect(marketplacePublishRefusal(account('x', 'basic'), 'linkedin', {})).toMatch(/does not post to linkedin/);
    expect(
      marketplacePublishRefusal(account('social', 'pro'), 'threads', { MKT_SOCIAL_PROVIDERS: 'linkedin' })
    ).toMatch(/does not post to threads/);
  });
  it('refuses everything for a blocked account, a paused product or an unknown plan', () => {
    expect(marketplacePublishRefusal(account('social', 'pro', 'BLOCKED'), 'linkedin', {})).toMatch(/blocked/);
    expect(
      marketplacePublishRefusal(account('social', 'pro'), 'linkedin', { MKT_DISABLED_PRODUCTS: 'social' })
    ).toMatch(/paused/);
    expect(marketplacePublishRefusal(account('social', 'gold'), 'linkedin', {})).toMatch(/not known/);
  });
  it('a dormant account still publishes what it paid for', () => {
    expect(marketplacePublishRefusal(account('social', 'standard', 'DORMANT'), 'linkedin', {})).toBeNull();
  });
});

describe('the Social trial is for testing, not free use (owner, 26 Oct 2026)', () => {
  const MB = 1024 * 1024;
  const trial = marketplacePlan('social', 'trial')!;
  const until = PRIOR_PLAN_LIMITS['social:trial'].until;
  const minutes = (n: number) => new Date(until.getTime() + n * 60_000);
  const days = (n: number) => new Date(until.getTime() + n * 86_400_000);

  it('is 10 credits, 1 channel and 50 MB for 7 days, without X; refused past 12 credits', () => {
    expect(trial).toMatchObject({
      priceUsd: 0,
      trial: true,
      credits: 10,
      channels: 1,
      storageBytes: 50 * MB,
      allowX: false,
      allowXLinks: false,
      scheduleHorizonDays: 7,
    });
    expect(hardCreditCap(trial)).toBe(12);
    expect(alertCreditThreshold(trial)).toBeNull();
  });

  it('leaves the paid Social plans (and so Tester, which is Pro) and the other products alone', () => {
    expect(marketplacePlan('social', 'standard')).toMatchObject({ credits: 500, channels: 5, storageBytes: 2 * 1024 * MB });
    expect(marketplacePlan('social', 'pro')).toMatchObject({ credits: 1200, channels: 20, storageBytes: 10 * 1024 * MB });
    expect(marketplacePlan('linkedin', 'trial')).toMatchObject({ credits: 50, channels: 1 });
    expect(marketplacePlan('x', 'trial')).toMatchObject({ credits: 50, channels: 1 });
    expect(marketplacePlan('validate', 'trial')).toMatchObject({ credits: 200, channels: 0 });
    expect(Object.keys(PRIOR_PLAN_LIMITS)).toEqual(['social:trial']);
  });

  it('a window that began before the change keeps 100 credits, 2 channels and 250 MB to its end', () => {
    const periodStart = minutes(-60);
    for (const now of [minutes(-1), minutes(1), days(3), days(27)]) {
      const p = planForWindow(trial, periodStart, now);
      expect(p).toMatchObject({ credits: 100, channels: 2, storageBytes: 250 * MB });
      expect(hardCreditCap(p)).toBe(120);
      // Only the three limits are held back.
      expect(p).toMatchObject({ plan: 'trial', allowX: false, scheduleHorizonDays: 7, youtubePerDay: 1, threadCap: 5 });
    }
    expect(trial.credits).toBe(10);
  });

  it('its next window has the new limits', () => {
    const periodStart = minutes(-60);
    // The second 28-day window starts 27 days 23 hours after the change.
    for (const now of [days(28), days(40), days(400)]) {
      expect(planForWindow(trial, periodStart, now)).toBe(trial);
    }
    expect(planForWindow(trial, periodStart, new Date(periodStart.getTime() + 28 * 86_400_000 - 1)).credits).toBe(100);
    expect(planForWindow(trial, periodStart, new Date(periodStart.getTime() + 28 * 86_400_000)).credits).toBe(10);
  });

  it('an account whose window starts at or after the change gets the new limits at once', () => {
    expect(planForWindow(trial, until, until)).toBe(trial);
    expect(planForWindow(trial, minutes(5), days(1))).toBe(trial);
    // An older account: its second window began 2 days before the change
    // (old limits), its third 26 days after it (new limits).
    expect(planForWindow(trial, days(-30), days(1)).credits).toBe(100);
    expect(planForWindow(trial, days(-30), days(27))).toBe(trial);
  });

  it('never changes a plan without prior limits', () => {
    for (const p of Object.values(MARKETPLACE_PLANS).filter((p) => !(`${p.product}:${p.plan}` in PRIOR_PLAN_LIMITS))) {
      expect(planForWindow(p, days(-1), minutes(1))).toBe(p);
    }
  });
});
