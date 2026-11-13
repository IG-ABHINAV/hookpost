// The billing state on the super-admin Users & Billing page (billing.state.ts):
// one state per workspace, with its one-line label and date. Pure, so every
// case runs on plain objects with a fixed clock.
//   pnpm exec jest -c apps/backend/jest.config.ts billing.state

import {
  BILLING_STATES,
  billingDay,
  billingMoney,
  BillingInput,
  billingState,
  countBillingStates,
  RemoteSubscription,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/billing.state';
import { TrialCutoffs } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

// As production runs today (26 Oct 2026): both cutoffs set, the dollar
// checkout live, the Free plan ending 27 Oct 2026 23:59 IST.
const SUNSET = new Date('2026-10-27T18:29:59.000Z');
const NOW = new Date('2026-10-26T06:00:00.000Z');
const cutoffs = (over: Partial<TrialCutoffs> = {}): TrialCutoffs => ({
  IN: new Date('2026-10-19T00:00:00Z'),
  GLOBAL: new Date('2026-10-20T17:35:00Z'),
  usdLive: true,
  excluded: new Set(),
  sunset: SUNSET,
  sunsetExempt: new Set(['org-exempt']),
  now: NOW,
  ...over,
});
const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

// A grandfathered Indian workspace (created before the IN cutoff), no plan.
const oldOrg = (over: Record<string, any> = {}) => ({
  id: 'org-old',
  createdAt: new Date('2026-09-10T00:00:00Z'),
  allowTrial: true,
  isTrailing: true,
  ownerCountry: 'IN',
  subscription: null,
  ...over,
});
// A workspace from the new cohort (created after the IN cutoff).
const newOrg = (over: Record<string, any> = {}) =>
  oldOrg({ id: 'org-new', createdAt: new Date('2026-10-24T00:00:00Z'), ...over });

const row = (over: Record<string, any> = {}) => ({
  subscriptionTier: 'STANDARD',
  period: 'MONTHLY',
  isLifetime: false,
  cancelAt: null,
  deletedAt: null,
  identifier: 'sub_TrORabc',
  ...over,
});
const remote = (over: Partial<RemoteSubscription> = {}): RemoteSubscription => ({
  status: 'active',
  paidCount: 2,
  startAt: at('2026-09-11T10:45:21Z'),
  chargeAt: at('2026-11-12T18:30:00Z'),
  currentEnd: at('2026-11-12T18:30:00Z'),
  amount: 699,
  currency: 'INR',
  ...over,
});

const state = (input: BillingInput, c: TrialCutoffs = cutoffs()) => billingState(input, c);

describe('billingState: a workspace with a plan', () => {
  it('paying: a real Razorpay charge on record, "Paying ₹X/month · renews <date>"', () => {
    const v = state({ org: newOrg({ isTrailing: false, subscription: row() }), remote: remote() });
    expect(v).toMatchObject({
      state: 'paying',
      label: 'Paying ₹699/month · renews 13 Nov',
      detail: 'Standard monthly · Razorpay',
      at: '2026-11-12T18:30:00.000Z',
      planState: 'active',
    });
  });

  it('first charge due: card or UPI added, never charged; never "Paying" and never "trial"', () => {
    const v = state({
      org: newOrg({ subscription: row() }),
      remote: remote({ status: 'authenticated', paidCount: 0, startAt: at('2026-10-26T15:06:43Z'), chargeAt: at('2026-10-26T15:06:43Z'), currentEnd: null, amount: 599 }),
      attribution: { trialStartedAt: '2026-10-23T15:07:47Z' },
    });
    expect(v.state).toBe('first_charge');
    expect(v.label).toBe('First charge ₹599 on 26 Oct');
    expect(v.detail).toBe('Standard monthly · card or UPI added 23 Oct');
    expect(v.planState).toBe('trialing');
  });

  it('first charge due wins over a stale isTrailing=false: Razorpay says it was never charged', () => {
    const v = state({
      org: newOrg({ isTrailing: false, subscription: row() }),
      remote: remote({ status: 'active', paidCount: 0, startAt: at('2026-10-26T15:06:43Z'), chargeAt: at('2026-10-26T15:06:43Z'), amount: 599 }),
    });
    expect(v.state).toBe('first_charge');
    expect(v.label).toBe('First charge ₹599 on 26 Oct');
  });

  it('first charge time passing without a payment reads "due since"', () => {
    const first = '2026-10-26T15:06:43Z';
    const input = {
      org: newOrg({ subscription: row() }),
      remote: remote({ status: 'active', paidCount: 0, startAt: at(first), chargeAt: at(first), amount: 599 }),
    };
    expect(state(input, cutoffs({ now: new Date(first) })).label).toBe('First charge ₹599 on 26 Oct');
    expect(state(input, cutoffs({ now: new Date(new Date(first).getTime() + 1000) })).label).toBe(
      'First charge ₹599 due since 26 Oct'
    );
  });

  it('first charge in dollars, price unknown', () => {
    const usd = state({
      org: newOrg({ ownerCountry: 'US', createdAt: new Date('2026-10-22T00:00:00Z'), subscription: row({ subscriptionTier: 'PRO' }) }),
      remote: remote({ status: 'authenticated', paidCount: 0, startAt: at('2026-10-29T10:00:00Z'), chargeAt: at('2026-10-29T10:00:00Z'), amount: 19, currency: 'USD' }),
    });
    expect(usd.label).toBe('First charge $19 on 29 Oct');
    expect(usd.detail).toBe('Pro monthly');
    const unknown = state({
      org: newOrg({ subscription: row() }),
      remote: remote({ status: 'authenticated', paidCount: 0, startAt: at('2026-10-29T10:00:00Z'), chargeAt: null, amount: null, currency: null }),
    });
    expect(unknown.label).toBe('First charge on 29 Oct');
  });

  it('paying yearly in dollars: "/year"', () => {
    const v = state({
      org: newOrg({ isTrailing: false, subscription: row({ period: 'YEARLY' }) }),
      remote: remote({ amount: 190.5, currency: 'USD', chargeAt: at('2027-09-11T00:00:00Z') }),
    });
    expect(v.label).toBe('Paying $190.50/year · renews 11 Sept 2027');
  });

  it('cancelled: access until cancelAt; never charged says so without the word trial', () => {
    const cancelAt = new Date('2026-10-26T08:46:54Z');
    const input = {
      org: newOrg({ subscription: row({ cancelAt }) }),
      remote: remote({ status: 'cancelled', paidCount: 0 }),
    };
    const before = state(input, cutoffs({ now: new Date(cancelAt.getTime() - 1) }));
    expect(before).toMatchObject({
      state: 'cancelled',
      label: 'Cancelled · access until 26 Oct',
      detail: 'Standard monthly · cancelled before the first charge, never charged',
      at: cancelAt.toISOString(),
      planState: 'cancelling',
    });
    expect(state(input, cutoffs({ now: cancelAt })).label).toBe('Cancelled · access ended 26 Oct');
  });

  it('cancelled after paying: "no further charges"; ended at Razorpay is never paying', () => {
    const v = state({
      org: newOrg({ isTrailing: false, subscription: row({ cancelAt: new Date('2026-11-11T07:39:10Z') }) }),
      remote: remote({ paidCount: 3 }),
    });
    expect(v.label).toBe('Cancelled · access until 11 Nov');
    expect(v.detail).toBe('Standard monthly · no further charges');
    const ended = state({ org: newOrg({ isTrailing: false, subscription: row() }), remote: remote({ status: 'completed' }) });
    expect(ended).toMatchObject({ state: 'cancelled', label: 'Cancelled · ended at Razorpay' });
  });

  it('payment failed: pending is retrying, halted has stopped; both beat cancelAt', () => {
    const org = newOrg({ isTrailing: false, subscription: row({ cancelAt: new Date('2026-11-30T00:00:00Z') }) });
    const pending = state({ org, remote: remote({ status: 'pending' }) });
    expect(pending).toMatchObject({ state: 'payment_failed', label: 'Payment failed · retrying', planState: 'dunning' });
    const halted = state({ org, remote: remote({ status: 'halted' }) });
    expect(halted).toMatchObject({ state: 'payment_failed', label: 'Payment failed · stopped' });
  });

  describe('Razorpay not read', () => {
    it('isTrailing and no paidAt: first charge, date unknown', () => {
      const v = state({ org: newOrg({ subscription: row() }) });
      expect(v).toMatchObject({ state: 'first_charge', label: 'First charge date unknown' });
    });
    it('isTrailing but paidAt recorded: paying', () => {
      const v = state({ org: newOrg({ subscription: row() }), attribution: { paidAt: '2026-10-25T00:00:00Z' } });
      expect(v).toMatchObject({ state: 'paying', label: 'Paying' });
    });
    it('not trialing: paying, without a renewal date', () => {
      const v = state({ org: newOrg({ isTrailing: false, subscription: row() }) });
      expect(v).toMatchObject({ state: 'paying', label: 'Paying', at: null });
      expect(v.detail).toContain('renewal date not read');
    });
  });

  it('a Gumroad plan was paid for: Paying, via Gumroad', () => {
    const v = state({ org: newOrg({ isTrailing: false, subscription: row({ identifier: 'gumroad:sale1' }) }) });
    expect(v).toMatchObject({ state: 'paying', label: 'Paying · Gumroad' });
  });

  describe('a plan an admin gave (no Razorpay subscription behind it)', () => {
    // Live case 3 Nov 2026: James's complimentary Pro (identifier
    // restored-..., no Razorpay id) showed "Paying - Pro monthly".
    const gift = (over: Record<string, any> = {}) =>
      newOrg({ allowTrial: false, isTrailing: false, subscription: row({ identifier: 'restored-f9q1la6nen', subscriptionTier: 'PRO', ...over }) });

    it('shows "Free Pro until <date>", never Paying', () => {
      const v = state({ org: gift({ cancelAt: new Date('2027-02-03T18:29:00Z') }) });
      expect(v).toMatchObject({ state: 'gift', label: 'Free Pro until 3 Feb 2027', at: '2027-02-03T18:29:00.000Z' });
      expect(v.detail).toBe('Given by an admin, never billed');
    });

    it('without an end date on file says so', () => {
      expect(state({ org: gift() })).toMatchObject({ state: 'gift', label: 'Free Pro · no end date set' });
    });

    it('once its end date passes it is no plan: needs a plan', () => {
      const v = state({ org: gift({ cancelAt: new Date('2026-10-01T00:00:00Z') }), freePostsUsed: 0 });
      expect(v).toMatchObject({ state: 'needs_plan', planState: 'locked' });
    });

    it('a plan an admin added by hand (makeId identifier) is a gift too', () => {
      expect(state({ org: gift({ identifier: 'Ab3dE' }) }).state).toBe('gift');
    });
  });

  it('lifetime given by us is a team account; any other lifetime is a lifetime plan', () => {
    const team = state({
      org: oldOrg({ subscription: row({ isLifetime: true, subscriptionTier: 'TEAM', period: 'YEARLY', identifier: 'sub_admin_lifetime' }) }),
      remote: remote({ status: 'halted' }),
    });
    expect(team).toMatchObject({ state: 'team', label: 'Team / review account' });
    expect(state({ org: oldOrg({ subscription: row({ isLifetime: true, identifier: null }) }) }).state).toBe('team');
    expect(state({ org: oldOrg({ subscription: row({ isLifetime: true, identifier: 'appsumo-code-1' }) }) })).toMatchObject({
      state: 'lifetime',
      label: 'Lifetime plan',
    });
  });

  it('a soft-deleted Subscription row counts as no plan', () => {
    const v = state({ org: newOrg({ subscription: row({ deletedAt: new Date('2026-10-20') }) }) });
    expect(v.state).toBe('free_posts');
  });

  it('an api.market workspace is its own state, plan row or not', () => {
    expect(state({ org: newOrg({ subscription: row({ identifier: 'apimkt:social:1' }) }), marketplace: true })).toMatchObject({
      state: 'marketplace',
      label: 'API marketplace',
    });
    expect(state({ org: newOrg(), marketplace: true }).state).toBe('marketplace');
  });
});

describe('billingState: no plan on file (one rule: free posts, then needs a plan)', () => {
  const AFTER = cutoffs({ now: new Date('2026-11-04T06:00:00Z') });

  it('no workspace at all', () => {
    expect(state({ org: null })).toMatchObject({ state: 'no_workspace', label: 'No workspace', planState: null });
  });

  it('free posts: "Can post free · X of 3 left"', () => {
    expect(state({ org: newOrg(), freePostsUsed: 1 })).toMatchObject({
      state: 'free_posts',
      label: 'Can post free · 2 of 3 left',
      planState: 'free_posts',
    });
    expect(state({ org: newOrg() }).label).toBe('Can post free · 3 of 3 left');
  });

  it('free posts used up: "Used 3 free posts · must pick a plan"', () => {
    expect(state({ org: newOrg(), freePostsUsed: 3 })).toMatchObject({
      state: 'needs_plan',
      label: 'Used 3 free posts · must pick a plan',
      planState: 'free_posts',
    });
  });

  it('no "Needs trial" any more: a grandfathered workspace past the sunset is on its free posts', () => {
    const v = state({ org: oldOrg(), freePostsUsed: 0 }, AFTER);
    expect(v).toMatchObject({ state: 'free_posts', label: 'Can post free · 3 of 3 left', planState: 'free_posts' });
    expect(state({ org: oldOrg(), freePostsUsed: 5 }, AFTER).state).toBe('needs_plan');
  });

  it('locked (had a plan, or a sign-up refused free posts) is needs a plan', () => {
    const v = state({ org: newOrg({ allowTrial: false, isTrailing: false }), freePostsUsed: 0 });
    expect(v).toMatchObject({ state: 'needs_plan', label: 'No free posts · must pick a plan', planState: 'locked' });
    expect(state({ org: newOrg({ allowTrial: false }), freePostsUsed: 3 }).label).toBe('Used 3 free posts · must pick a plan');
  });

  it('team and review workspaces are their own bucket, never customers', () => {
    for (const now of [NOW, new Date('2027-01-01T00:00:00Z')]) {
      const listed = state({ org: oldOrg({ id: 'org-exempt' }) }, cutoffs({ now }));
      expect(listed).toMatchObject({ state: 'team', label: 'Team / review account' });
      const admin = state({ org: newOrg({ platformAdmin: true }) }, cutoffs({ now }));
      expect(admin.state).toBe('team');
    }
  });

  it('a region the sunset does not reach is on the old Free plan', () => {
    const us = oldOrg({ ownerCountry: 'US' });
    const v = state({ org: us }, cutoffs({ usdLive: false, now: new Date('2026-11-01T00:00:00Z') }));
    expect(v).toMatchObject({ state: 'free', label: 'Old Free plan' });
  });

  it('no label or detail anywhere says "trial", "Needs trial" or "Free plan ended"', () => {
    const inputs: Array<[BillingInput, TrialCutoffs?]> = [
      [{ org: oldOrg(), freePostsUsed: 0 }, AFTER],
      [{ org: oldOrg({ allowTrial: false }), freePostsUsed: 0 }, AFTER],
      [{ org: oldOrg() }],
      [{ org: newOrg({ allowTrial: false }) }],
      [{ org: newOrg({ subscription: row() }) }],
      [{ org: newOrg({ subscription: row({ cancelAt: new Date('2026-10-30') }) }), remote: remote({ paidCount: 0 }) }],
      [{ org: oldOrg({ id: 'org-exempt' }) }, AFTER],
    ];
    for (const [input, c] of inputs) {
      const v = state(input, c);
      expect(`${v.label} ${v.detail}`).not.toMatch(/trial|free plan ended/i);
    }
  });
});

describe('helpers', () => {
  it('billingDay: the calendar day in India, so 18:30Z is already the next day', () => {
    expect(billingDay('2026-10-27T18:29:59Z', NOW)).toBe('27 Oct');
    expect(billingDay('2026-10-27T18:30:00Z', NOW)).toBe('28 Oct');
    expect(billingDay('2027-01-02T00:00:00Z', NOW)).toBe('2 Jan 2027');
  });

  it('billingMoney: rupees, dollars, euros, other codes, paise', () => {
    expect(billingMoney(599, 'INR')).toBe('₹599');
    expect(billingMoney(1999, 'INR')).toBe('₹1,999');
    expect(billingMoney(479.2, 'INR')).toBe('₹479.20');
    expect(billingMoney(9, 'USD')).toBe('$9');
    expect(billingMoney(30, 'AED')).toBe('AED 30');
  });

  it('countBillingStates: every state present, the legacy ones gone', () => {
    const counts = countBillingStates(['paying', 'gift', 'paying']);
    expect(Object.keys(counts)).toEqual([...BILLING_STATES]);
    expect(counts.paying).toBe(2);
    expect(counts.gift).toBe(1);
    expect(BILLING_STATES).not.toContain('needs_trial');
    expect(BILLING_STATES).not.toContain('locked');
    expect(BILLING_STATES).not.toContain('free_exempt');
    expect(BILLING_STATES).not.toContain('trial');
  });
});
