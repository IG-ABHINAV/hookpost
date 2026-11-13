/**
 * @jest-environment node
 */
// How the Users & Billing page shows the billing states GET /admin/users
// computes (billing.state.ts): one plain name per state (the owner, 4 Nov
// 2026: "make terminology easy"), one colour each, chips with counts.

import {
  BILLING_CHIP_ORDER,
  BILLING_STATE_META,
  billingTooltip,
  countRowStates,
  rowInState,
  visibleChips,
} from '@hookpost/frontend/components/admin/billing.badge';
import { BILLING_STATES } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/billing.state';

describe('billing badges on /admin/users', () => {
  it('every state the backend can send has a look, a chip, and a colour of its own', () => {
    expect([...BILLING_CHIP_ORDER]).toEqual([...BILLING_STATES]);
    const badges = BILLING_STATES.map((s) => BILLING_STATE_META[s].badge);
    expect(new Set(badges).size).toBe(badges.length);
    expect(BILLING_STATE_META.paying.badge).not.toBe(BILLING_STATE_META.cancelled.badge);
    for (const s of BILLING_STATES) expect(BILLING_STATE_META[s].chip).toBeTruthy();
  });

  it('the chips use the plain names', () => {
    expect(BILLING_STATE_META.free_posts.chip).toBe('Free posts');
    expect(BILLING_STATE_META.paying.chip).toBe('Paying');
    expect(BILLING_STATE_META.gift.chip).toBe('Free Pro (gift)');
    expect(BILLING_STATE_META.needs_plan.chip).toBe('Needs a plan');
    expect(BILLING_STATE_META.team.chip).toBe('Team / review account');
    expect(BILLING_STATE_META.lifetime.chip).toBe('Lifetime plan');
  });

  it('no chip says "trial", "Needs trial", "Locked" or "Free plan ended"', () => {
    for (const s of BILLING_STATES) {
      expect(BILLING_STATE_META[s].chip).not.toMatch(/trial|locked|free plan ended|exempt/i);
    }
  });

  it('chips: states with rows, in order, plus the selected one even when empty', () => {
    const counts = { paying: 1, free_posts: 2, gift: 0, needs_plan: 30 };
    expect(visibleChips(counts, 'ALL')).toEqual(['free_posts', 'paying', 'needs_plan']);
    expect(visibleChips(counts, 'gift')).toEqual(['free_posts', 'paying', 'gift', 'needs_plan']);
    expect(visibleChips(undefined, 'ALL')).toEqual([]);
  });

  it('a row is under a chip when any of its workspaces is in that state', () => {
    const row = { billingStates: ['free_posts', 'needs_plan'] as any };
    expect(rowInState(row, 'free_posts')).toBe(true);
    expect(rowInState(row, 'needs_plan')).toBe(true);
    expect(rowInState(row, 'paying')).toBe(false);
    expect(rowInState({}, 'paying')).toBe(false);
    expect(rowInState({ billingStates: null }, 'paying')).toBe(false);
  });

  it('chip counts are counted over the rows on screen, so they match what a chip shows', () => {
    const rows: any[] = [
      { billingStates: ['paying'] },
      { billingStates: ['paying', 'needs_plan'] },
      { billingStates: ['gift', 'gift'] },
      { billingStates: null },
      {},
    ];
    const counts = countRowStates(rows);
    expect(counts).toEqual({ paying: 2, needs_plan: 1, gift: 1 });
    for (const [state, n] of Object.entries(counts)) {
      expect(rows.filter((r) => rowInState(r, state as any)).length).toBe(n);
    }
  });

  it('the tooltip gives the exact time in IST', () => {
    expect(
      billingTooltip({ label: 'Free Pro until 3 Feb 2027', detail: 'Given by an admin, never billed', at: '2027-02-03T18:29:00.000Z' })
    ).toBe('Free Pro until 3 Feb 2027. Given by an admin, never billed. 3 Feb 2027, 23:59 IST');
    expect(billingTooltip({ label: 'Needs a plan', detail: 'x', at: null })).toBe('Needs a plan. x');
  });
});
