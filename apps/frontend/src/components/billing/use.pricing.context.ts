'use client';

import { useEffect, useState } from 'react';
import {
  PricingInterface,
  SupportedCurrency,
  getPricing,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import type { FirstMonthOfferTerms } from '@hookpost/nestjs-libraries/services/first.month.offer';

/**
 * What the backend decided this visitor is shown and charged
 * (libraries/nestjs-libraries/src/services/billing.currency.ts). The browser
 * no longer picks a currency from its timezone or writes one to a cookie; it
 * sends its timezone and renders the answer. What is shown is always what is
 * charged: displayCurrency equals chargeCurrency.
 */
export interface PricingContext {
  displayCurrency: string;
  chargeCurrency: string;
  lockedCurrency: string | null;
  /**
   * False when checkout would refuse (409 CURRENCY_LOCKED): a live plan in a
   * currency no checkout sells. Missing from backends before PR-4.
   */
  checkoutAllowed?: boolean;
  region: { country: string | null; tzSaysIndia: boolean; ipSaysIndia: boolean };
  prices: Record<'STANDARD' | 'PRO', { month: number; year: number }> &
    Partial<Record<'HOOKPOST', { month: number; year: number }>>;
  /**
   * Signed-in only: what this workspace pays for its plan, read from its
   * Razorpay plan. A subscriber keeps the price they signed up at, so this
   * can differ from `prices`. Null when there is nothing to show.
   */
  currentPlan?: CurrentPlanPrice | null;
  /**
   * 20% off the first month (first.month.offer.ts): its terms when checkout
   * in this currency has the offer, else null. Missing from older backends.
   * Whether a given checkout gets it also depends on the period, a coupon and
   * a trial (firstMonthOfferApplies).
   */
  firstMonthOffer?: FirstMonthOfferTerms | null;
  /**
   * Signed-in only: a plan change the workspace has approved for the end of
   * its cycle, i.e. a downgrade (an upgrade takes effect at once, so it is
   * never waiting). Null or missing when nothing is scheduled.
   */
  scheduledChange?: ScheduledPlanChange | null;
  /**
   * The single plan on sale, paid one month at a time (one.time.plan.ts),
   * in the currency its order charges: USD outside India, INR in India.
   * Missing from older backends.
   */
  oneTimePlan?: {
    name: string;
    tier: string;
    currency: 'INR' | 'USD';
    price: number;
    label: string;
  };
}

/**
 * A downgrade waiting for the end of the cycle already paid for. `how` is how
 * Razorpay is holding it, which decides what calling it off takes:
 * `in_place` it can simply drop (POST /billing/plan-change/undo), and a
 * `new_mandate` needs one approved for the plan being kept
 * (/billing/plan-change/keep-plan), because a UPI Autopay or e-mandate cannot
 * be re-planned.
 */
export interface ScheduledPlanChange {
  billing: string;
  period: 'MONTHLY' | 'YEARLY';
  at: string;
  how: 'in_place' | 'new_mandate';
}

/** The scheduled downgrade, once it has the fields the page needs. */
export function scheduledChangeOf(
  ctx: PricingContext | null | undefined
): ScheduledPlanChange | null {
  const change = ctx?.scheduledChange;
  if (!change?.billing || !change.at) return null;
  return change;
}

/** The first-month offer's terms, only while checkout charges rupees. */
export function firstMonthOfferOf(
  ctx: PricingContext | null | undefined
): FirstMonthOfferTerms | null {
  const terms = ctx?.firstMonthOffer;
  if (!terms || !Array.isArray(terms.methods) || !terms.methods.length) {
    return null;
  }
  return chargeCurrencyOf(ctx) === 'INR' ? terms : null;
}

export interface CurrentPlanPrice {
  billing: string;
  period: 'MONTHLY' | 'YEARLY';
  currency: string;
  /** Major units (rupees, not paise). */
  amount: number;
}

// Module scope on purpose: NEXT_PUBLIC_* is only inlined here, not inside a
// function body (see layout/view-content.tracker.tsx). In production this is
// https://hookpost.hookstep.in/api; locally it points straight at :3000.
const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || '/api';

/** How long the marketing pages wait before asking the pricing context again. */
export const PRICING_RETRY_MS = 1_500;

export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

export function isPricingContext(d: any): d is PricingContext {
  return (
    !!d &&
    typeof d.chargeCurrency === 'string' &&
    typeof d.displayCurrency === 'string' &&
    !!d.region &&
    !!d.prices?.STANDARD &&
    !!d.prices?.PRO
  );
}

/**
 * Marketing pages. Kept free of SWR and useFetch so the landing bundle does
 * not grow; the signed-in hook is in use.billing.pricing.context.ts.
 *
 * Their HTML is cached by Cloudflare for every visitor, so it
 * renders rupees and this asks, uncached, what to tell this visitor. A plain
 * fetch: useFetch has no provider on the marketing pages and silently does
 * nothing there. Null until it answers, and if it never does.
 */
export function usePublicPricingContext(): PricingContext | null {
  return usePublicPricingContextState().ctx;
}

/**
 * usePublicPricingContext, plus whether the server has answered (or failed
 * to): `settled` is false only while the request is in flight. Pages that
 * can show more than one currency keep the price behind a skeleton until it
 * is true, so a visitor never sees one currency flip to another.
 */
export function usePublicPricingContextState(): {
  ctx: PricingContext | null;
  settled: boolean;
} {
  const [state, setState] = useState<{
    ctx: PricingContext | null;
    settled: boolean;
  }>({ ctx: null, settled: false });
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (): Promise<PricingContext | null> =>
      fetch(
        `${BACKEND}/public/pricing-context?tz=${encodeURIComponent(browserTz())}`,
        { cache: 'no-store' }
      )
        .then((res) => (res.ok ? res.json() : null))
        .then((d) => (isPricingContext(d) ? d : null))
        .catch(() => null);
    // Asked from a task of its own, not inside React's effect flush after
    // hydration: browserTz() is the page's first Intl call, and the first one
    // loads ICU, ~20 ms of main thread on a GitHub runner. Inside the flush it
    // lengthened the one long task every effect on the page shares; on its own
    // it is a short task, and the request leaves a tick later.
    const start = setTimeout(() => {
      // One retry before giving up: a deploy restarts the backend, and
      // visitors in that window got a 502 here and kept the fallback for the
      // whole visit (6 visitors on 11-21 Oct).
      ask()
        .then(
          (first) =>
            first ||
            new Promise<PricingContext | null>((resolve) => {
              timer = setTimeout(() => resolve(alive ? ask() : null), PRICING_RETRY_MS);
            })
        )
        .then((ctx) => {
          if (alive) setState({ ctx, settled: true });
        });
    }, 0);
    return () => {
      alive = false;
      clearTimeout(start);
      if (timer) clearTimeout(timer);
    };
  }, []);
  return state;
}

/** The currency to render, INR until the server has answered. */
export function chargeCurrencyOf(ctx: PricingContext | null | undefined) {
  return (ctx?.chargeCurrency || 'INR') as SupportedCurrency;
}

/**
 * The local price table for that currency, with the paid tiers' prices taken
 * from the server's answer. Limits and features still come from pricing.ts.
 */
export function pricingFor(ctx: PricingContext | null | undefined): PricingInterface {
  const table = getPricing(chargeCurrencyOf(ctx));
  if (!ctx) return table;
  const out: PricingInterface = { ...table };
  for (const tier of ['STANDARD', 'PRO'] as const) {
    const p = ctx.prices[tier];
    if (out[tier] && p) {
      out[tier] = { ...out[tier], month_price: p.month, year_price: p.year };
    }
  }
  return out;
}

/** Neither the IP nor the timezone says India, and the price is in rupees. */
export function showRupeeNote(ctx: PricingContext | null | undefined) {
  return (
    !!ctx &&
    ctx.chargeCurrency === 'INR' &&
    !ctx.region.ipSaysIndia &&
    !ctx.region.tzSaysIndia
  );
}

/**
 * For visitors outside India while only rupees can be charged. It must not
 * say international cards work, or say who converts the charge: no card
 * issued outside India has ever been charged on this account.
 */
export const RUPEE_NOTE =
  'Prices are in Indian rupees, paid by UPI, NetBanking or card. A card issued outside India may be declined; if yours is, email support@hookstep.in.';

/**
 * Prices are shown in dollars to everyone, and every new purchase is charged
 * on one INR plan or order (pricing.ts HOOKPOST_PRICE). Said once, with no
 * rupee figure (the owner, 8 Nov 2026): Razorpay's checkout shows the amount.
 */
export const CHARGE_CURRENCY_NOTE =
  'Payment is taken in Indian rupees (INR) at checkout, which shows the exact amount.';

/**
 * The workspace is on a live plan in a currency checkout no longer sells, so
 * it cannot change plan here. A live USD plan is not one: since PR-4 it
 * changes plan in dollars. Backends from before PR-4 do not send
 * checkoutAllowed, and refused every non-rupee plan.
 */
export function lockedNote(ctx: PricingContext | null | undefined): string | null {
  const locked = ctx?.lockedCurrency;
  if (!locked) return null;
  const refused =
    typeof ctx?.checkoutAllowed === 'boolean'
      ? !ctx.checkoutAllowed
      : locked !== 'INR';
  if (!refused) return null;
  return `Your current plan is billed in ${locked}. To change plan, cancel it and subscribe again after it ends, or email support@hookstep.in.`;
}

/**
 * How a plan in this currency is paid. Rupee plans take UPI AutoPay, cards and
 * NetBanking; a dollar plan is a card mandate only, so UPI is never offered
 * there.
 */
export function paymentMethodsFor(currency: string | null | undefined): string {
  return !currency || currency === 'INR' ? 'UPI, NetBanking or cards' : 'card';
}
