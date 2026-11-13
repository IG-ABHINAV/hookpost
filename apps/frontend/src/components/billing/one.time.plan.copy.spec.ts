import { oneTimePlanCopy, renewalReminder } from './one.time.plan.copy';

const NOW = new Date('2026-11-08T10:00:00.000Z');
const DAY = 86_400_000;

describe('oneTimePlanCopy', () => {
  it('a first month says what it costs, once', () => {
    const c = oneTimePlanCopy({ label: '$7', canBuy: true, renew: false, refusal: null, paidUntil: null });
    expect(c.button).toBe('Pay $7 for one month');
    expect(c.status).toBeNull();
    expect(c.note).toContain('One-time payment of $7');
  });

  it('a renewal says so, in rupees for India', () => {
    const c = oneTimePlanCopy({
      label: '₹599',
      canBuy: true,
      renew: true,
      refusal: null,
      paidUntil: '2026-11-10T10:00:00.000Z',
    });
    expect(c.button).toBe('Renew for another month (₹599)');
    expect(c.status).toBe('Hookpost is paid until 10 Nov 2026.');
  });

  it('never promises a lifetime, free-forever plan or a trial', () => {
    for (const q of [
      { label: '$7', canBuy: true, renew: false, refusal: null, paidUntil: null },
      { label: '$7', canBuy: false, renew: false, refusal: 'ALREADY_PAID' as const, paidUntil: '2026-12-01T00:00:00Z' },
      { label: '$7', canBuy: false, renew: false, refusal: 'HAS_PLAN' as const, paidUntil: null },
    ]) {
      const text = Object.values(oneTimePlanCopy(q)).join(' ').toLowerCase();
      expect(text).not.toMatch(/lifetime|free forever|trial/);
    }
  });
});

describe('renewalReminder', () => {
  it('shows in the last 3 days only', () => {
    expect(renewalReminder(new Date(NOW.getTime() + 2 * DAY).toISOString(), NOW)).toContain(
      'Renew for another month'
    );
    expect(renewalReminder(new Date(NOW.getTime() + 4 * DAY).toISOString(), NOW)).toBeNull();
    expect(renewalReminder(new Date(NOW.getTime() - 1).toISOString(), NOW)).toBeNull();
    expect(renewalReminder(null, NOW)).toBeNull();
    expect(renewalReminder('nonsense', NOW)).toBeNull();
  });
});
