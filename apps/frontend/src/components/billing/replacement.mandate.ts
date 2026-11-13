import dayjs from 'dayjs';
import { getCurrencyConfig } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { formatMoney } from '@hookpost/frontend/components/billing/coupon.field';
import { tierName } from '@hookpost/frontend/components/billing/prorate.component';

/**
 * Reactivate, and Change payment method. Razorpay can neither undo a
 * scheduled cancellation nor edit a UPI Autopay or e-mandate, so both approve
 * a new mandate for the same plan.
 *
 * The page asks for the terms first (GET .../quote, which creates nothing),
 * shows them, and only after "Continue to Razorpay" creates the mandate
 * (POST /billing/reactivate or /billing/payment-method) and opens checkout.
 * It used to create first and ask second, so every "Not now" left a
 * `created` subscription behind on Razorpay.
 */
export type ReplacementReason =
  | 'reactivate'
  | 'payment_method'
  /**
   * Stay on the current plan instead of the downgrade scheduled for the end
   * of the cycle. Same reason as the other two: the mandate holding the
   * downgrade cannot be re-planned, so keeping the plan means approving a new
   * one for it. Nothing is charged today either.
   */
  | 'undo_downgrade';

/** What the dialog states. Both the quote and the create answer carry it. */
export interface ReplacementTerms {
  currency: string;
  billing: string;
  period: string;
  amount: number;
  /** When the new mandate first charges; null means on approval. */
  startAt: string | null;
  /** Charged on approval because the last renewal failed. */
  unpaid: boolean;
}

export interface CreatedReplacement extends ReplacementTerms {
  subscriptionId: string;
  keyId?: string;
}

type T = (key: string, fallback: string, options?: any) => string;
/** useT()'s t: with options its declared return type is wider than string. */
export type TranslateFn = (
  key: string,
  fallback: string,
  options?: any
) => unknown;
const asText =
  (t: TranslateFn): T =>
  (key, fallback, options) =>
    String(t(key, fallback, options));

/** Plan names, prices and dates go in as they are: React escapes the text. */
const raw = (values: Record<string, string>) => ({
  ...values,
  interpolation: { escapeValue: false },
});

export const replacementPaths = (reason: ReplacementReason) => {
  const create =
    reason === 'reactivate'
      ? '/billing/reactivate'
      : reason === 'undo_downgrade'
      ? '/billing/plan-change/keep-plan'
      : '/billing/payment-method';
  return { quote: `${create}/quote`, create };
};

const sameInstant = (a: string | null, b: string | null) =>
  !a || !b ? !a && !b : dayjs(a).valueOf() === dayjs(b).valueOf();

/**
 * Would the customer be agreeing to something else? Anything the dialog
 * states counts: price, currency, plan, period, the first charge date, and
 * whether it is charged on approval.
 */
export function sameReplacementTerms(
  quoted: ReplacementTerms,
  created: ReplacementTerms
) {
  return (
    Number(quoted.amount) === Number(created.amount) &&
    String(quoted.currency).toUpperCase() ===
      String(created.currency).toUpperCase() &&
    String(quoted.billing) === String(created.billing) &&
    String(quoted.period) === String(created.period) &&
    !!quoted.unpaid === !!created.unpaid &&
    sameInstant(quoted.startAt || null, created.startAt || null)
  );
}

/** The dialog's title and text, and the line checkout shows under the name. */
export function replacementCopy(
  translate: TranslateFn,
  reason: ReplacementReason,
  terms: ReplacementTerms,
  currentTierName: string
) {
  const t = asText(translate);
  const symbol = getCurrencyConfig(terms.currency as any).symbol;
  const locale = terms.currency === 'INR' ? 'en-IN' : 'en-US';
  const amount = `${symbol}${formatMoney(Number(terms.amount), locale)}`;
  const price =
    terms.period === 'YEARLY'
      ? t('billing_price_per_year', '{{amount}}/year', raw({ amount }))
      : t('billing_price_per_month', '{{amount}}/month', raw({ amount }));
  const date = terms.startAt ? dayjs(terms.startAt).format('D MMM YYYY') : '';
  const plan = tierName(String(terms.billing || currentTierName));

  const intro =
    reason === 'reactivate'
      ? t(
          'billing_replacement_intro_reactivate',
          "Razorpay can't undo a cancellation, so keeping {{plan}} means approving a new autopay mandate for the same plan at {{price}}.",
          raw({ plan, price })
        )
      : reason === 'undo_downgrade'
      ? t(
          'billing_replacement_intro_undo_downgrade',
          "UPI Autopay and e-mandates can't be edited, so calling off the scheduled change means approving a new mandate for {{plan}} at {{price}}.",
          raw({ plan, price })
        )
      : t(
          'billing_replacement_intro_payment_method',
          "UPI Autopay and e-mandates can't be edited, so paying another way means approving a new mandate for {{plan}} at {{price}}.",
          raw({ plan, price })
        );
  const when = terms.startAt
    ? t(
        'billing_replacement_when_later',
        'Nothing is charged today (your bank may hold a small verification amount and return it). The first charge on the new mandate is {{amount}} on {{date}}.',
        raw({ amount, date })
      )
    : terms.unpaid
    ? t(
        'billing_replacement_when_unpaid',
        "{{amount}} is charged when you approve it, because your last payment didn't go through.",
        raw({ amount })
      )
    : t(
        'billing_replacement_when_now',
        "{{amount}} is charged when you approve it, because the time you've paid for ends in the next few minutes.",
        raw({ amount })
      );
  const outro = t(
    'billing_replacement_outro',
    'Your current mandate is cancelled once the new one is approved. If you close checkout, nothing changes.'
  );

  return {
    title:
      reason === 'reactivate'
        ? t('reactivate_subscription', 'Reactivate subscription')
        : reason === 'undo_downgrade'
        ? t('billing_keep_current_plan', 'Keep my current plan')
        : t('change_payment_method', 'Change payment method'),
    message: `${intro} ${when} ${outro}`,
    amountLabel: terms.startAt
      ? t('billing_price_from', '{{price}} from {{date}}', raw({ price, date }))
      : price,
  };
}

export interface ReplacementFlowDeps {
  reason: ReplacementReason;
  t: TranslateFn;
  currentTierName: string;
  /** useFetch(): relative backend paths, cookies included. */
  fetch: (url: string, init?: RequestInit) => Promise<any>;
  /** deleteDialog: resolves true on the confirm button. */
  confirm: (
    message: string,
    confirmLabel: string,
    title: string,
    cancelLabel: string
  ) => Promise<boolean>;
  /** Loads checkout.js; false when it cannot (so nothing is created). */
  prepareCheckout: () => Promise<boolean>;
  /** openRazorpayCheckout; false when checkout could not be opened. */
  openCheckout: (
    created: CreatedReplacement,
    amountLabel: string
  ) => Promise<boolean>;
  warn: (message: string) => void;
}

/**
 * - `checkout`: checkout is open on the new mandate.
 * - `declined`: "Not now" on the terms; nothing was created.
 * - `declined_changed`: the mandate came back on other terms and the
 *   customer turned them down; it was withdrawn.
 * - `failed`: the quote or the create was refused (the reason is shown).
 * - `unavailable`: checkout could not load.
 */
export type ReplacementOutcome =
  | 'checkout'
  | 'declined'
  | 'declined_changed'
  | 'failed'
  | 'unavailable';

const readJson = async (res: any) => {
  try {
    return await res.json();
  } catch (e) {
    return null;
  }
};

const isTerms = (body: any) =>
  !!body &&
  typeof body.currency === 'string' &&
  Number.isFinite(Number(body.amount)) &&
  body.amount !== null &&
  body.amount !== undefined;

export async function runReplacementMandate(
  deps: ReplacementFlowDeps
): Promise<ReplacementOutcome> {
  const { reason, currentTierName } = deps;
  const t = asText(deps.t);
  const paths = replacementPaths(reason);
  const startFailed = (body: any) =>
    deps.warn(
      String(
        body?.message ||
          t(
            'billing_checkout_start_failed',
            'We could not start checkout. Please try again, or email support@hookstep.in.'
          )
      )
    );
  const unavailable = () =>
    deps.warn(
      t(
        'billing_checkout_unavailable',
        'Checkout is currently unavailable. Please try again shortly.'
      )
    );
  // A mandate created here that the customer never saw in checkout. Only an
  // unapproved one is withdrawn (the backend checks); a failure is harmless,
  // the next checkout retires it.
  const discard = (subscriptionId: string) =>
    deps
      .fetch('/billing/replacement/discard', {
        method: 'POST',
        body: JSON.stringify({ subscriptionId }),
      })
      .catch(() => undefined);

  // 1. The terms, without creating anything.
  const quoteRes = await deps.fetch(paths.quote).catch(() => null);
  const quote = quoteRes ? await readJson(quoteRes) : null;
  if (!quoteRes?.ok || !isTerms(quote)) {
    startFailed(quote);
    return 'failed';
  }

  const copy = replacementCopy(t, reason, quote, currentTierName);
  const agreed = await deps.confirm(
    copy.message,
    t('continue_to_razorpay', 'Continue to Razorpay'),
    copy.title,
    t('not_now', 'Not now')
  );
  if (!agreed) {
    return 'declined';
  }

  // 2. Nothing is created when checkout could not open anyway.
  if (!(await deps.prepareCheckout())) {
    unavailable();
    return 'unavailable';
  }

  // 3. Create it, now that the customer has agreed.
  const createRes = await deps
    .fetch(paths.create, { method: 'POST' })
    .catch(() => null);
  const created = createRes ? await readJson(createRes) : null;
  if (!createRes?.ok || !created?.subscriptionId || !isTerms(created)) {
    startFailed(created);
    return 'failed';
  }

  // 4. What the customer agreed to is what checkout will take, or they say
  // yes again to the new terms.
  let finalCopy = copy;
  if (!sameReplacementTerms(quote, created)) {
    finalCopy = replacementCopy(t, reason, created, currentTierName);
    const again = await deps.confirm(
      `${t(
        'billing_replacement_terms_changed',
        'These terms changed while checkout was being set up. Please check them again.'
      )} ${finalCopy.message}`,
      t('continue_to_razorpay', 'Continue to Razorpay'),
      t('billing_replacement_terms_changed_title', 'The terms have changed'),
      t('not_now', 'Not now')
    );
    if (!again) {
      await discard(created.subscriptionId);
      return 'declined_changed';
    }
  }

  // Checkout that throws while opening (new Razorpay(...)) is the same as
  // one that could not open: the customer never saw the new mandate.
  let opened = false;
  try {
    opened = await deps.openCheckout(created, finalCopy.amountLabel);
  } catch (e) {
    opened = false;
  }
  if (!opened) {
    await discard(created.subscriptionId);
    unavailable();
    return 'unavailable';
  }
  return 'checkout';
}
