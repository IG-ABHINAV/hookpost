/**
 * The paywall's three trial ticks (first.billing): unchanged while no trial
 * cutoff is set, the trial's real terms for every workspace once one is.
 *   pnpm exec jest -c apps/frontend/jest.config.ts trial.terms.copy
 */
import {
  bulletText,
  checkoutDescription,
  expectedFirstChargeAt,
  formatChargeDate,
  LEGACY_TRIAL_BULLETS,
  TRIAL_DAYS,
  trialBullets,
} from '@hookpost/frontend/components/billing/trial.terms.copy';
import { TRIAL_DAYS as POLICY_TRIAL_DAYS } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import {
  authorisationNote,
  trialButtonLabel,
} from '@hookpost/frontend/components/billing/razorpay.billing';

describe('paywall trial ticks', () => {
  it('the trial is 3 days, and the paywall reads the same number as checkout', () => {
    expect(TRIAL_DAYS).toBe(3);
    expect(TRIAL_DAYS).toBe(POLICY_TRIAL_DAYS);
  });

  it('no cutoff: the original three, the length from TRIAL_DAYS', () => {
    const legacy = trialBullets({ trialPolicyActive: false, currency: 'INR' });
    expect(legacy.map(bulletText)).toEqual([
      '100% No-Risk Free Trial',
      'Pay NOTHING for the first 3 days',
      'Cancel anytime, from settings',
    ]);
    // A new key: the old one's translations all say 7.
    expect(legacy.map(([k]) => k)).not.toContain('billing_pay_nothing_7_days');
    // An older backend that does not send the field is treated the same.
    expect(trialBullets({ currency: 'INR' })).toBe(LEGACY_TRIAL_BULLETS);
  });

  it('cutoff set: the terms, and never "No-Risk" or "Pay NOTHING"', () => {
    const bullets = trialBullets({ trialPolicyActive: true, currency: 'INR' });
    const text = bullets.map(bulletText).join(' | ');
    expect(text).toBe(
      '3-day trial, ₹0 today | Then the plan price, charged automatically on the date shown | Cancel in Settings at least 24 hours before that date'
    );
    // The length is a value, never typed into the key or the English.
    expect(bullets[0][1]).toContain('{{days}}');
    expect(bullets[0][0]).not.toMatch(/\d/);
    expect(text).not.toMatch(/no-risk|nothing|free plan|no card/i);
    // New keys, so the old translations cannot leak the old promise.
    for (const [key] of bullets) {
      expect(LEGACY_TRIAL_BULLETS.map(([k]) => k)).not.toContain(key);
    }
  });

  it('cutoff set, not rupees: no "$0 today" before the USD auth amount is known', () => {
    const [first] = trialBullets({ trialPolicyActive: true, currency: 'USD' });
    expect(first).toEqual(['billing_trial_days', '{{days}}-day trial', { days: '3' }]);
    expect(bulletText(first)).toBe('3-day trial');
  });
});

// The date and amount of the first charge, before anything is approved: the
// paywall's ticks, the note under a dollar button and the Razorpay modal.
describe('the first charge is named before the mandate is approved', () => {
  // 18 Oct 2026, 20:00 UTC: already the 19th in India.
  const NOW = Date.UTC(2026, 9, 18, 20, 0, 0);

  it('is the date subscribe() sets: 3 days on, plus 30 per free coupon month, in India time', () => {
    expect(formatChargeDate(expectedFirstChargeAt(NOW))).toBe('22 Oct 2026');
    expect(formatChargeDate(expectedFirstChargeAt(NOW, 1))).toBe('21 Nov 2026');
    expect(formatChargeDate(expectedFirstChargeAt(NOW, null))).toBe('22 Oct 2026');
  });

  it('the ticks name the amount and the date', () => {
    const bullets = trialBullets({
      trialPolicyActive: true,
      currency: 'INR',
      amountLabel: '₹599',
      chargeDate: '26 Oct 2026',
    });
    expect(bullets.map(bulletText)).toEqual([
      '3-day trial, ₹0 today',
      'Then ₹599 on 26 Oct 2026, charged automatically',
      'Cancel in Settings at least 24 hours before 26 Oct 2026',
    ]);
    const usd = trialBullets({
      trialPolicyActive: true,
      currency: 'USD',
      amountLabel: '$19',
      chargeDate: '26 Oct 2026',
    });
    expect(usd.map(bulletText)).toEqual([
      '3-day trial',
      'Then $19 on 26 Oct 2026, charged automatically',
      'Cancel in Settings at least 24 hours before 26 Oct 2026',
    ]);
    // Placeholders, so a translation can move them.
    expect(usd[1][1]).toContain('{{date}}');
  });

  it('the dollar note under the button names the date too', () => {
    expect(authorisationNote('USD', true, '26 Oct 2026')).toBe(
      'Your card is authorised now for the plan, which is charged automatically on 26 Oct 2026 unless you cancel at least 24 hours before.'
    );
  });

  it('the Razorpay modal states the date the server set; a plan charged now shows only its amount', () => {
    const startAt = Math.floor(NOW / 1000) + 7 * 86400;
    expect(checkoutDescription('₹599', startAt, NOW)).toBe('₹599, first charge on 26 Oct 2026');
    expect(checkoutDescription(undefined, startAt, NOW)).toBe('First charge on 26 Oct 2026');
    expect(checkoutDescription('₹599', null, NOW)).toBe('₹599');
    expect(checkoutDescription('₹599', Math.floor(NOW / 1000) + 60, NOW)).toBe('₹599');
  });
});

// The 25 workspaces the Free plan sunset email of 21 Oct told "start the
// 7-day trial" get 7 days from subscribe(); /user/self sends trialDays 7 for
// them, and the paywall states that length and that date, not 3.
describe('a workspace promised 7 days by the sunset email (trialDays from /user/self)', () => {
  const NOW = Date.UTC(2026, 9, 18, 20, 0, 0);

  it('the first charge is 7 days on, not 3; no value or a bad one means TRIAL_DAYS', () => {
    expect(formatChargeDate(expectedFirstChargeAt(NOW, null, 7))).toBe('26 Oct 2026');
    expect(formatChargeDate(expectedFirstChargeAt(NOW, 1, 7))).toBe('25 Nov 2026');
    expect(formatChargeDate(expectedFirstChargeAt(NOW, null, undefined))).toBe('22 Oct 2026');
    expect(formatChargeDate(expectedFirstChargeAt(NOW, null, 0))).toBe('22 Oct 2026');
    expect(formatChargeDate(expectedFirstChargeAt(NOW, null, NaN))).toBe('22 Oct 2026');
  });

  it('the ticks say 7 days, in both versions', () => {
    const live = trialBullets({
      trialPolicyActive: true,
      currency: 'INR',
      amountLabel: '₹599',
      chargeDate: '26 Oct 2026',
      days: 7,
    });
    expect(live.map(bulletText)[0]).toBe('7-day trial, ₹0 today');
    const legacy = trialBullets({ trialPolicyActive: false, currency: 'INR', days: 7 });
    expect(legacy.map(bulletText)).toEqual([
      '100% No-Risk Free Trial',
      'Pay NOTHING for the first 7 days',
      'Cancel anytime, from settings',
    ]);
    // The shared constant is not touched.
    expect(LEGACY_TRIAL_BULLETS.map(bulletText)[1]).toBe('Pay NOTHING for the first 3 days');
  });

  it('the button names 7 days', () => {
    expect(trialButtonLabel('INR', '₹599', 7)).toBe('Start 7-Day Free Trial (₹0 Today, then ₹599)');
    expect(trialButtonLabel('USD', '$19', 7)).toBe('Start 7-Day Free Trial (then $19)');
    expect(trialButtonLabel('USD', '$19')).toBe('Start 3-Day Free Trial (then $19)');
  });
});
