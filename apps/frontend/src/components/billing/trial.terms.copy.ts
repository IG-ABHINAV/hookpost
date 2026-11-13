/**
 * The three ticks above the paywall's plan picker (first.billing), as
 * [translation key, English default, values] for
 * t(key, { defaultValue, ...values }).
 *
 * While no trial cutoff is set they are the original three, unchanged. Once
 * one is (trialPolicyActive from /user/self, trial.policy.ts on the backend)
 * every workspace gets the trial's real terms instead, grandfathered ones
 * starting a voluntary trial included: "100% No-Risk" and "Pay NOTHING" are
 * not what a card or UPI AutoPay trial that charges itself when it ends is, and
 * the first debit has reached the bank about a day before the date on live
 * trials, hence the 24 hours. PR-3 of local-assets/trial-usd-plan-2026-10-18.md.
 *
 * The terms name the amount and the date of the first charge, before the
 * customer approves anything: the plan lists "amount and date shown up front"
 * as the trial's built-in safeguard, and /terms says the date is shown at
 * checkout. The date is the one subscribe() sets (expectedFirstChargeAt), and
 * the Razorpay modal repeats the exact date the server set
 * (checkoutDescription).
 *
 * "₹0 today" only for rupees: what a USD mandate's authorisation takes is not
 * known until the live card test (plan PR-4), so it is not promised.
 *
 * The trial's length is never typed into a key or a string: it is TRIAL_DAYS
 * from trial.policy.ts, passed as {{days}}, so a translation of an old
 * "7-day" string cannot show through after the trial changed length. A
 * workspace the Free plan sunset notice promised 7 days to gets 7 from
 * subscribe(); /user/self sends that as trialDays, and `days` below takes it.
 */
import {
  knownTrialDays,
  TRIAL_DAYS,
  TRIAL_MIN_LEAD_MS,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

export type TrialBullet = [
  key: string,
  fallback: string,
  values?: Record<string, string>,
];

/** The trial length subscribe() uses unless RAZORPAY_TRIAL_DAYS says otherwise (it ships unset). */
export { TRIAL_DAYS };

/** {{days}} for every key below that names the trial's length. */
const daysValue = (days?: number | null) => ({
  days: String(knownTrialDays(days)),
});
const DAYS = daysValue(TRIAL_DAYS);


/**
 * When a trial started now takes its first charge: subscribe() sets start_at
 * to now plus the trial (`trialDays`, /user/self's, else TRIAL_DAYS), plus 30
 * days for each free month of a coupon.
 */
export function expectedFirstChargeAt(
  now: number,
  freeMonths?: number | null,
  trialDays?: number | null
): Date {
  const days = knownTrialDays(trialDays) + (freeMonths || 0) * 30;
  return new Date(now + days * 86_400_000);
}

/** "25 Oct 2026", in India time, as the billing emails write it (formatBillingDate). */
export function formatChargeDate(date: Date): string {
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

export const LEGACY_TRIAL_BULLETS: TrialBullet[] = [
  ['billing_no_risk_trial', '100% No-Risk Free Trial'],
  ['billing_pay_nothing_first_days', 'Pay NOTHING for the first {{days}} days', DAYS],
  ['billing_cancel_anytime', 'Cancel anytime, from settings'],
];

export const trialBullets = (p: {
  trialPolicyActive?: boolean;
  currency?: string;
  /** What the plan costs after the trial, as shown on the button ("₹599"). */
  amountLabel?: string;
  /** formatChargeDate(expectedFirstChargeAt(...)). */
  chargeDate?: string;
  /** /user/self trialDays; TRIAL_DAYS without it. */
  days?: number | null;
}): TrialBullet[] => {
  const days = daysValue(p.days);
  if (!p.trialPolicyActive) {
    if (knownTrialDays(p.days) === TRIAL_DAYS) return LEGACY_TRIAL_BULLETS;
    return LEGACY_TRIAL_BULLETS.map(
      ([key, fallback, values]): TrialBullet =>
        values ? [key, fallback, days] : [key, fallback]
    );
  }
  const first: TrialBullet =
    p.currency === 'INR'
      ? ['billing_trial_days_zero_today', '{{days}}-day trial, ₹0 today', days]
      : ['billing_trial_days', '{{days}}-day trial', days];
  if (!p.chargeDate || !p.amountLabel) {
    return [
      first,
      [
        'billing_trial_charged_on_date',
        'Then the plan price, charged automatically on the date shown',
      ],
      [
        'billing_trial_cancel_24h',
        'Cancel in Settings at least 24 hours before that date',
      ],
    ];
  }
  const values = { amount: p.amountLabel, date: p.chargeDate };
  return [
    first,
    [
      'billing_trial_charged_amount_on',
      'Then {{amount}} on {{date}}, charged automatically',
      values,
    ],
    [
      'billing_trial_cancel_24h_before',
      'Cancel in Settings at least 24 hours before {{date}}',
      values,
    ],
  ];
};

/** A bullet's English text, values filled in (what t() shows with no translation). */
export const bulletText = ([, fallback, values]: TrialBullet): string =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, name) => values?.[name] ?? '');

/**
 * The description line of the Razorpay modal: the amount, and for a trial
 * the date of its first charge, which the server set (start_at, unix
 * seconds). The customer sees it before approving the mandate.
 */
export function checkoutDescription(
  amountLabel: string | undefined,
  firstChargeAt: number | null | undefined,
  now: number = Date.now()
): string | undefined {
  const at = Number(firstChargeAt || 0) * 1000;
  if (!at || at - now <= TRIAL_MIN_LEAD_MS) return amountLabel;
  const date = formatChargeDate(new Date(at));
  return amountLabel
    ? `${amountLabel}, first charge on ${date}`
    : `First charge on ${date}`;
}
