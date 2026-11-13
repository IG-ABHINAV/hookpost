'use client';

import React, { FC, useCallback, useEffect, useState } from 'react';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { Button } from '@hookpost/react/form/button';
import { LoadingComponent } from '@hookpost/frontend/components/layout/loading';
import {
  getCurrencyConfig,
  getPricing,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { isTwaClient } from '@hookpost/frontend/components/layout/twa';
import { START_TRIAL_EVENT_KEY } from '@hookpost/frontend/components/layout/gtm.component';
import { checkoutDescription } from '@hookpost/frontend/components/billing/trial.terms.copy';
import { knownTrialDays } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { useStartFree } from '@hookpost/frontend/components/billing/start.free';
import {
  forgetPendingCheckout,
  rememberPendingCheckout,
  setCheckoutOpenInThisPage,
} from '@hookpost/frontend/components/billing/pending.checkout';
import { brandTokens } from '@hookpost/helpers/brand/brand-themes';

const CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

declare global {
  interface Window {
    Razorpay?: any;
  }
}

/**
 * Loads Razorpay's checkout.js once per page and resolves when it is ready.
 * Concurrent callers share the same in-flight load.
 *
 * Never inside the Google Play app: Play's Payments policy allows only Play
 * Billing there, so the script is not even fetched (see layout/twa.ts). That
 * also makes openRazorpayCheckout return false there.
 */
let scriptPromise: Promise<boolean> | null = null;
export function loadRazorpayScript(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (isTwaClient()) return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<boolean>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${CHECKOUT_SCRIPT}"]`
    );
    if (existing) {
      existing.addEventListener('load', () => resolve(true));
      existing.addEventListener('error', () => resolve(false));
      return;
    }
    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT;
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
  return scriptPromise;
}

/** What POST /razorpay/verify answers. Older backends send only { ok }. */
export interface RazorpayVerifyResult {
  ok?: boolean;
  /** This checkout started a new trial (not a plan switch during one). */
  trial?: boolean;
}

/**
 * Where a checkout that started a trial lands: the channel-connect screen,
 * with trialStart=true for TrialTracker (Google Ads and the browser
 * StartTrial).
 */
export const TRIAL_STARTED_URL = '/launches?onboarding=true&trialStart=true';

export interface RazorpayCheckoutOptions {
  /** Razorpay subscription id created server-side. */
  subscriptionId: string;
  keyId?: string;
  currency?: string;
  /** Human-readable amount, shown in the modal's description line. */
  amountLabel?: string;
  /**
   * The subscription's first charge (start_at from /billing/embedded or
   * /billing/subscribe), unix seconds. For a trial the modal's description
   * names its date, so it is seen before the mandate is approved.
   */
  firstChargeAt?: number | null;
  /**
   * POSTs /razorpay/verify. Passed in so this stays free of React hooks.
   * Resolves with the endpoint's answer, or nothing (then the page reloads).
   */
  verify: (response: {
    razorpay_payment_id: string;
    razorpay_subscription_id: string;
    razorpay_signature: string;
  }) => Promise<RazorpayVerifyResult | void>;
  onSuccess?: () => void;
  onError?: (message: string) => void;
  onClose?: () => void;
  /**
   * Keep the subscription id in sessionStorage while the modal is open, so a
   * page reloaded while the customer is in their UPI app waits for the
   * webhook instead of offering the checkout again (pending.checkout.ts).
   * `trial` is whether success starts a trial.
   */
  rememberPending?: { trial: boolean };
}

/**
 * Opens Razorpay's in-page Checkout modal for an existing subscription.
 *
 * This is the only payment surface we should ever send a customer to. The
 * alternative - redirecting to the `short_url` Razorpay returns with the
 * subscription - goes to Razorpay's hosted subscription page, and on 2026-09-08
 * that page answered "Hosted page is not available. Please contact the merchant
 * for further details." for every plan on this account. The /billing plans grid
 * used it and so had no working path to payment at all, which is what Razorpay's
 * own onboarding review was asking us to fix. Checkout.js does not depend on
 * that page.
 *
 * Returns false when checkout.js could not load, so the caller can decide what
 * to do rather than being silently redirected somewhere broken.
 */
export async function openRazorpayCheckout(
  opts: RazorpayCheckoutOptions
): Promise<boolean> {
  const loaded = await loadRazorpayScript();
  if (!loaded || !window.Razorpay || !opts.subscriptionId) {
    return false;
  }

  const rzp = new window.Razorpay({
    key: opts.keyId,
    subscription_id: opts.subscriptionId,
    name: 'HookStep',
    description: checkoutDescription(opts.amountLabel, opts.firstChargeAt),
    image: 'https://hookpost.hookstep.in/brand-logo.png',
    currency: opts.currency || 'INR',
    theme: {
      color: brandTokens('dark').primary,
    },
    handler: async (response: any) => {
      setCheckoutOpenInThisPage(false);
      try {
        // The webhook is authoritative for entitlements; this call just lets us
        // fail fast in the UI if the handshake is bad.
        const verified = await opts.verify({
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_subscription_id: response.razorpay_subscription_id,
          razorpay_signature: response.razorpay_signature,
        });
        // This page saw the result, so a reload has nothing to wait for. Kept
        // when verify fails: the webhook may still start the plan, and the
        // paywall then waits for it.
        forgetPendingCheckout();
        opts.onSuccess?.();
        afterCheckout(
          verified && verified.trial
            ? response.razorpay_subscription_id || opts.subscriptionId
            : null
        );
      } catch (e) {
        opts.onError?.(
          'We could not confirm the payment. If you were charged, it will apply shortly.'
        );
      }
    },
    modal: {
      ondismiss: () => {
        // Closed without paying: nothing is coming.
        setCheckoutOpenInThisPage(false);
        if (opts.rememberPending) forgetPendingCheckout();
        opts.onClose?.();
      },
    },
  });

  rzp.on('payment.failed', (resp: any) => {
    opts.onClose?.();
    opts.onError?.(
      resp?.error?.description || 'Payment failed. Please try again.'
    );
  });

  if (opts.rememberPending) {
    rememberPendingCheckout({
      id: opts.subscriptionId,
      at: Date.now(),
      trial: opts.rememberPending.trial,
    });
  }
  setCheckoutOpenInThisPage(true);
  rzp.open();
  return true;
}

/**
 * Razorpay Checkout for a one-time order (one.time.plan.ts): the single plan,
 * one month, paid once by UPI, card or an international card. The amount is
 * the order's, set on the server; the modal shows it as Razorpay has it.
 * Returns false when checkout.js could not load (or inside the Play app).
 */
export async function openRazorpayOrderCheckout(opts: {
  orderId: string;
  keyId?: string;
  amount: number;
  currency: string;
  description: string;
  verify: (response: {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }) => Promise<any>;
  onSuccess?: (verified: any) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}): Promise<boolean> {
  const loaded = await loadRazorpayScript();
  if (!loaded || !window.Razorpay || !opts.orderId) {
    return false;
  }
  const rzp = new window.Razorpay({
    key: opts.keyId,
    order_id: opts.orderId,
    amount: opts.amount,
    currency: opts.currency,
    name: 'HookStep',
    description: opts.description,
    image: 'https://hookpost.hookstep.in/brand-logo.png',
    notes: { service: 'hookpost' },
    theme: { color: brandTokens('dark').primary },
    handler: async (response: any) => {
      setCheckoutOpenInThisPage(false);
      try {
        const verified = await opts.verify({
          razorpay_order_id: response.razorpay_order_id,
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature,
        });
        opts.onSuccess?.(verified);
      } catch (e) {
        opts.onError?.(
          'We could not confirm the payment. If you were charged, your month will apply shortly.'
        );
      }
    },
    modal: {
      ondismiss: () => {
        setCheckoutOpenInThisPage(false);
        opts.onClose?.();
      },
    },
  });
  rzp.on('payment.failed', (resp: any) => {
    opts.onError?.(resp?.error?.description || 'Payment failed. Please try again.');
  });
  setCheckoutOpenInThisPage(true);
  rzp.open();
  return true;
}

/**
 * After a verified checkout. A new trial goes on to connect channels, taking
 * its StartTrial event id along; anything else (a paid plan, a plan switch,
 * Reactivate, Change payment method) reloads the page it was on, as before.
 */
export function afterCheckout(
  trialSubscriptionId: string | null,
  go: {
    reload: () => void;
    assign: (url: string) => void;
  } = {
    reload: () => window.location.reload(),
    assign: (url) => window.location.assign(url),
  }
) {
  if (!trialSubscriptionId) {
    go.reload();
    return;
  }
  try {
    window.sessionStorage.setItem(
      START_TRIAL_EVENT_KEY,
      `trial_${trialSubscriptionId}`
    );
  } catch {
    // Storage blocked: the server's StartTrial still counts the trial.
  }
  go.assign(TRIAL_STARTED_URL);
}

/**
 * The trial button's label. Rupees say "₹0 Today": the only thing taken is
 * the ₹5 check, refunded at once. Dollars do not promise "$0 today": what a
 * dollar mandate's authorisation takes is unknown until the live card test
 * (the plan's L2). `amountLabel` is what the plan then costs ("$19"); without
 * one, Standard monthly in that currency.
 */
export function trialButtonLabel(
  currency: string | null | undefined,
  amountLabel?: string,
  /** /user/self trialDays; TRIAL_DAYS without it. */
  trialDays?: number | null
): string {
  const days = knownTrialDays(trialDays);
  const cur = (currency || 'INR').toUpperCase();
  const config = getCurrencyConfig(cur);
  const standard = getPricing(cur).STANDARD.month_price;
  const then =
    amountLabel ||
    `${config.symbol}${standard.toLocaleString(cur === 'INR' ? 'en-IN' : 'en-US')}`;
  return cur === 'INR'
    ? `Start ${days}-Day Free Trial (${config.symbol}0 Today, then ${then})`
    : `Start ${days}-Day Free Trial (then ${then})`;
}

/**
 * The line under the button about the authorisation taken at checkout, or
 * null. Rupees: the ₹5 check, live-measured. Dollars: no amount and no
 * refund promise, since neither has been seen on a live dollar checkout yet
 * (the plan's L2 records it), and no UPI.
 */
export function authorisationNote(
  currency: string | null | undefined,
  allowTrial: boolean | undefined,
  /** The first charge's date as shown above the button (formatChargeDate). */
  chargeDate?: string
): string | null {
  // Only on a trial checkout: a plan that starts today takes its first
  // payment instead.
  if (!allowTrial) return null;
  if (!currency || currency === 'INR') {
    return 'A ₹5 check is taken now and refunded straight away; your bank may take 5-7 working days to show it.';
  }
  return `Your card is authorised now for the plan, which is charged automatically on ${
    chargeDate || 'the date shown'
  } unless you cancel at least 24 hours before.`;
}

export const RazorpayBilling: FC<{
  /** Razorpay subscription id created server-side. */
  subscriptionId?: string;
  /** Hosted-checkout fallback URL, used when checkout.js cannot load. */
  url?: string;
  keyId?: string;
  currency?: string;
  amountLabel?: string;
  allowTrial?: boolean;
  /** The workspace's trial length (/user/self trialDays). */
  trialDays?: number | null;
  /**
   * The date a trial started now first charges (formatChargeDate of
   * expectedFirstChargeAt), for the note under the button.
   */
  chargeDate?: string;
  /**
   * Whether the workspace has a Free plan to fall back on. False for the new
   * cohort (planState needs_trial or locked), which gets no "continue with
   * Free" link. Defaults to true, as before.
   */
  freePlanAvailable?: boolean;
  onSuccess?: () => void;
  /**
   * Creates the Razorpay subscription on click and returns the
   * /billing/embedded response. Used instead of subscriptionId so a
   * subscription is only created when the visitor actually starts checkout.
   */
  createCheckout?: () => Promise<any>;
  /**
   * Remember the checkout in this tab while it is open (pending.checkout.ts),
   * for the paywall, which waits for the webhook after a reload.
   */
  rememberPending?: boolean;
}> = ({ subscriptionId, url, keyId, currency, amountLabel, allowTrial, trialDays, chargeDate, freePlanAvailable = true, onSuccess, createCheckout, rememberPending }) => {
  const t = useT();
  const fetch = useFetch();
  const { startFree, starting: startingFree } = useStartFree();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRazorpayScript().then(setReady);
  }, []);

  const pay = useCallback(async () => {
    // Google Play app: do not even create the Razorpay subscription.
    if (isTwaClient()) {
      return;
    }
    setError(null);
    setBusy(true);

    let subId = subscriptionId;
    let key = keyId;
    let cur = currency;
    let hostedUrl = url;
    let firstChargeAt: number | null | undefined;
    if (createCheckout) {
      const d = await createCheckout().catch(() => null);
      if (!d || d.blocked || d.statusCode >= 400 || !d.subscriptionId) {
        setBusy(false);
        setError(
          d?.blocked
            ? t(
                'billing_other_account_subscribed',
                'Another account with this email already has an active subscription. Please log off and sign in to that account to manage your subscription.'
              )
            : d?.message ||
                t('billing_checkout_unavailable', 'Checkout is currently unavailable. Please try again shortly.')
        );
        return;
      }
      subId = d.subscriptionId;
      key = d.keyId || keyId;
      cur = d.currency || currency;
      hostedUrl = d.url;
      firstChargeAt = d.startAt;
    }

    const opened = await openRazorpayCheckout({
      subscriptionId: subId!,
      keyId: key,
      currency: cur,
      // A label priced in another currency than the one the subscription was
      // created in (the page's prices were out of date) is left out rather
      // than shown in the payment modal.
      amountLabel: !currency || cur === currency ? amountLabel : undefined,
      firstChargeAt,
      verify: async (payload) => {
        const res = await fetch('/razorpay/verify', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        return res.json().catch(() => ({}));
      },
      onSuccess,
      onError: (message) => {
        setBusy(false);
        setError(message);
      },
      onClose: () => setBusy(false),
      rememberPending: rememberPending ? { trial: !!allowTrial } : undefined,
    });

    if (opened) {
      return;
    }

    // checkout.js blocked or offline. The hosted page is the only thing left,
    // and it has been known to be unavailable on this account - so say so
    // rather than dropping the customer on an error screen with no context.
    setBusy(false);
    if (hostedUrl) {
      window.location.href = hostedUrl;
      return;
    }
    setError(
      t('billing_checkout_unavailable', 'Checkout is currently unavailable. Please try again shortly.')
    );
  }, [subscriptionId, keyId, currency, url, amountLabel, onSuccess, createCheckout, rememberPending, allowTrial]);

  if (!ready && !url) {
    return <LoadingComponent />;
  }

  // `currency` is what the server said checkout charges; INR until it has.
  const sym = getCurrencyConfig(currency || 'INR').symbol;
  const isINR = !currency || currency === 'INR';
  const authNote = authorisationNote(currency, allowTrial, chargeDate);

  return (
    <div className="flex flex-col gap-[16px] mt-[24px]">
      <Button onClick={pay} loading={busy} disabled={busy}>
        {allowTrial
          ? // The fallback used to be a hardcoded '₹699'/'$19'. When amountLabel
            // was empty the button promised the old price while the charge came
            // from pricing.ts - a button that names the wrong amount on the way
            // into a payment. Derived now, in the checkout's own currency.
            trialButtonLabel(currency, amountLabel, trialDays)
          : amountLabel
          ? `${t('billing_subscribe_for', 'Subscribe for')} ${amountLabel}`
          : t('billing_subscribe', 'Subscribe')}
      </Button>
      {freePlanAvailable && (
        <div className="flex justify-center items-center gap-2 mt-1">
          <button
            type="button"
            onClick={startFree}
            disabled={startingFree}
            aria-busy={startingFree}
            className="text-[14px] text-[#A0A0B0] hover:text-white underline cursor-pointer transition-colors bg-transparent border-none p-0 disabled:opacity-60 disabled:cursor-wait"
          >
            {startingFree
              ? t('billing_starting_free', 'Starting...')
              : `Or continue with Free Plan (${sym}0/month) →`}
          </button>
        </div>
      )}
      {error ? (
        <div className="text-[14px] text-red-400" role="alert">
          {error}
        </div>
      ) : null}
      {/* Only on a trial checkout: that is where the Rs 5 check is taken (a
          plan that starts today takes its first payment instead). Live, the
          refund was created 24-31 s after the check, at Razorpay's "normal"
          speed, so "immediately" promised more than a bank shows. A dollar
          trial names no amount (authorisationNote). */}
      {authNote && (
        <div className="text-[11px] text-customColor18/90 bg-white/5 border border-white/10 rounded-lg p-2.5 leading-relaxed text-center">
          💡 <strong>Note:</strong> {authNote}
        </div>
      )}
      <div className="text-[12px] text-customColor18 text-center">
        {t('billing_powered_by_razorpay', 'Secure payments processed by')}{' '}
        {/* No card-network list for other currencies: nothing but rupees has
            ever been charged on this account, so naming networks would be a
            guess. */}
        {isINR ? 'Razorpay (UPI, NetBanking, Cards)' : 'Razorpay'}
      </div>
    </div>
  );
};
