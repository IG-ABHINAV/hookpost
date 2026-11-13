'use client';

import React, { FC, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { useDebouncedCallback } from 'use-debounce';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import ReactLoading from '@hookpost/frontend/components/layout/loading';
import { formatMoney } from '@hookpost/frontend/components/billing/coupon.field';
import {
  getCurrencyConfig,
  SupportedCurrency,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { browserTz } from '@hookpost/frontend/components/billing/use.pricing.context';

/** POST /billing/prorate (RazorpayService.prorate). */
export interface PlanChangePreview {
  /** Kept for pages opened before the preview existed: charged today. */
  price: number;
  /** new_mandate: a new subscription, charged on approval. in_place: Razorpay re-plans the card mandate. */
  mode?: 'new_mandate' | 'in_place';
  chargeToday?: number | null;
  recurring?: number;
  period?: 'MONTHLY' | 'YEARLY';
  nextChargeAt?: string | null;
  currentTier?: string | null;
  currentPeriod?: string | null;
  currentStatus?: string | null;
  /**
   * A trial: approved, nothing charged yet. False for a Reactivate or Change
   * payment method mandate, which is `authenticated` too but runs on time
   * already paid for. Absent from older backends: go by currentStatus.
   */
  currentIsTrial?: boolean;
  /** The current plan runs on paid time, which a switch does not refund. */
  currentIsPaid?: boolean;
  /**
   * Why the switch is refused right now: a trial within a day of its first
   * charge, whose debit may already be at the bank, or a plan change the
   * policy does not allow (a failing payment, another currency, a lifetime
   * plan). The checkout would be refused with this same message.
   */
  refusal?: string;
  /** PLAN_CHANGE_DUNNING / _CURRENCY / _LIFETIME, for pages that branch. */
  refusalCode?: string;
  /**
   * Which way this plan change goes, under the policy of 29 Oct 2026: an
   * upgrade takes effect at once with the unused days of the current cycle
   * credited against it, a downgrade at the end of that cycle.
   */
  direction?: 'upgrade' | 'downgrade' | 'same';
  /** When the new plan starts. Absent from older backends. */
  effectiveAt?: 'now' | 'cycle_end';
  /**
   * The unused days of the cycle already paid for, carried over to the new
   * plan, in major units. null when Razorpay works the figure out itself (a
   * card mandate re-planned in place).
   */
  creditApplied?: number | null;
  /**
   * Channels that would not fit the new plan's allowance. Counted in the
   * browser, from the channel list the page already holds
   * (channelsOverAllowance), not by the backend.
   */
  overage?: number;
}

/**
 * How many of a workspace's channels would not fit `allowance`.
 *
 * Counted the way the channel limit itself counts (channel.limit.ts): a
 * channel waiting to be reconnected, and a placeholder from a two-step
 * connect nobody finished, take no slot. Nothing is ever deleted by a
 * downgrade - the channels past the allowance stop publishing until the
 * workspace is back on a plan that covers them - so this only words a
 * warning.
 */
export function channelsOverAllowance(
  channels: Array<{ refreshNeeded?: boolean; inBetweenSteps?: boolean }> | undefined,
  allowance: number | undefined
): number {
  if (!Array.isArray(channels) || !allowance) return 0;
  const live = channels.filter(
    (c) => !c?.refreshNeeded && !c?.inBetweenSteps
  ).length;
  return Math.max(0, live - allowance);
}

export const tierName = (tier: string) =>
  tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();

/**
 * The line Billing shows while a downgrade is waiting for the end of the
 * cycle: what it changes to, when, and that nothing changes before then.
 * Only a downgrade ever waits - an upgrade takes effect at once.
 */
export function scheduledChangeLine(change: {
  billing: string;
  period: 'MONTHLY' | 'YEARLY';
  at: string;
}): string {
  return `Changes to ${tierName(change.billing)} ${
    change.period === 'YEARLY' ? 'yearly' : 'monthly'
  } on ${dayjs(change.at).format('D MMM YYYY')}. Until then nothing changes and nothing is charged.`;
}

/**
 * The line under a plan the workspace could switch to, from the backend's
 * preview. It states what is charged and when, and what happens to the plan
 * on now. It used to read "Pay Today ₹1414.0": a prorated figure nothing ever
 * charged, above a checkout that took the full ₹1,999.
 *
 * The plan-change rules it words are the ones the pricing page and the terms
 * state, and the ones razorpay.mapping.ts carries out: an upgrade takes
 * effect at once with the unused days of the cycle already paid for credited
 * against it, a downgrade at the end of that cycle, and nothing is ever
 * refunded for part of a period.
 */
export function planChangeCopy(
  preview: PlanChangePreview,
  pack: string,
  currency: string
): string {
  if (preview.refusal) return preview.refusal;
  const symbol = getCurrencyConfig(currency).symbol;
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  const money = (value: number) => `${symbol}${formatMoney(value, locale)}`;
  const unit = (preview.period || 'MONTHLY') === 'YEARLY' ? 'year' : 'month';
  const recurring = preview.recurring ?? preview.price;
  const at = preview.nextChargeAt
    ? dayjs(preview.nextChargeAt).format('D MMM YYYY')
    : '';
  const from = at ? ` from ${at}` : '';
  const current = preview.currentTier ? tierName(preview.currentTier) : '';

  // A downgrade takes effect at the end of the cycle already paid for, on
  // every payment method: the workspace keeps what it paid for to the last
  // day, and the lower price starts after it.
  if (preview.direction === 'downgrade') {
    const keeps = current
      ? `You keep ${current} until ${at || 'the end of this cycle'}`
      : `Your current plan runs until ${at || 'the end of this cycle'}`;
    const overage = preview.overage
      ? ` ${preview.overage} ${
          preview.overage === 1 ? 'channel' : 'channels'
        } won't fit ${tierName(
          pack
        )} and will stop publishing until you move back up; none are deleted.`
      : '';
    return `${keeps}, then ${money(
      recurring
    )}/${unit}. Nothing to pay today, and nothing is refunded for days already paid for.${overage}`;
  }

  // An upgrade takes effect at once. What it costs today is the one thing the
  // two payment routes differ on: Razorpay prorates a card mandate itself,
  // and a mandate it cannot re-plan carries the unused days over as time on
  // the new plan instead.
  if (preview.direction === 'upgrade') {
    if (preview.mode === 'in_place') {
      // The figure is Razorpay's own proration (inPlaceChangeMinor on the
      // backend), so it is the amount the card is charged.
      if (typeof preview.chargeToday === 'number') {
        const credit = preview.creditApplied ?? 0;
        return `${tierName(pack)} starts now on your saved card. Pay ${money(
          preview.chargeToday
        )} today${
          credit > 0
            ? ` (the ${money(credit)} left on your ${current || 'current plan'} is credited)`
            : ''
        }, then ${money(recurring)}/${unit}${from}.`;
      }
      return `${tierName(
        pack
      )} starts now on your saved card. Razorpay charges only the difference for the rest of this cycle, then ${money(
        recurring
      )}/${unit}${from}.`;
    }
    const credit = preview.creditApplied ?? 0;
    if (credit > 0 && (preview.chargeToday ?? 0) === 0) {
      return `${tierName(pack)} starts now. Nothing to pay today: the ${money(
        credit
      )} left on your ${current || 'current plan'} is credited, and ${money(
        recurring
      )}/${unit} starts ${at || 'when it runs out'}.`;
    }
    return `${tierName(pack)} starts now. Pay ${money(
      preview.chargeToday ?? preview.price
    )} today, then ${money(recurring)}/${unit}${from}.${
      current ? ` Your ${current} cycle has run out, so there is nothing left to credit.` : ''
    }`;
  }

  if (preview.mode === 'in_place') {
    return `Switches now on your saved card, then ${money(recurring)}/${unit}${from}. Razorpay works out any charge for the rest of this cycle.`;
  }

  const today = preview.chargeToday ?? preview.price;
  if (preview.currentTier) {
    const isTrial =
      preview.currentIsTrial ?? preview.currentStatus === 'authenticated';
    // A plan switch during a trial keeps the trial's first charge date
    // (nothing today); the backend says so with chargeToday 0.
    if (isTrial && today === 0) {
      const samePlan = tierName(preview.currentTier) === tierName(pack);
      const target = samePlan
        ? `${tierName(pack)} ${unit === 'year' ? 'yearly' : 'monthly'}`
        : tierName(pack);
      return `Nothing to pay today: your trial switches to ${target}, then ${money(recurring)}/${unit}${from}.`;
    }
  }
  let copy = `Pay ${money(today)} today, then ${money(recurring)}/${unit}${from}.`;
  if (current) {
    const samePlan = current === tierName(pack);
    const isTrial =
      preview.currentIsTrial ?? preview.currentStatus === 'authenticated';
    const kind = isTrial ? 'trial' : 'plan';
    const what = samePlan
      ? `Your ${current} ${
          preview.currentPeriod === 'YEARLY' ? 'yearly' : 'monthly'
        } ${kind}`
      : `Your ${current} ${kind}`;
    // No claim either way about the days left on it: a plan change credits
    // them (the branches above), and this line is only reached where the
    // backend did not call it a change at all - an older backend, or a plan
    // on a tier this page does not rank.
    copy += ` ${what} ends when ${samePlan ? 'this one' : tierName(pack)} starts.`;
  }
  return copy;
}

export const Prorate: FC<{
  period: 'MONTHLY' | 'YEARLY';
  pack: 'STANDARD' | 'PRO' | 'HOOKPOST';
  currency?: SupportedCurrency;
  /**
   * Channels that would not fit this plan (channelsOverAllowance). Only a
   * downgrade's line mentions them, and only to say they stop publishing
   * rather than being deleted.
   */
  overage?: number;
}> = (props) => {
  const { period, pack, currency = 'INR', overage = 0 } = props;
  const fetch = useFetch();
  const [preview, setPreview] = useState<PlanChangePreview | false>(false);
  const [loading, setLoading] = useState(false);
  const calculatePrice = useDebouncedCallback(async () => {
    setLoading(true);
    // No currency in the body: the server prices it in what checkout
    // charges. `currency` here is only the symbol to print. The timezone is
    // the same signal /billing/pricing-context was given.
    const res = await fetch('/billing/prorate', {
      method: 'POST',
      body: JSON.stringify({
        period,
        billing: pack,
        tz: browserTz(),
      }),
    });
    const body = await res.json().catch(() => null);
    setPreview(res.ok && typeof body?.price === 'number' ? body : false);
    setLoading(false);
  }, 500);
  useEffect(() => {
    setPreview(false);
    calculatePrice();
  }, [period, pack, currency]);
  if (loading) {
    return (
      <div className="pt-[4px]">
        <ReactLoading type="spin" color="var(--hp-primary)" width={20} height={20} />
      </div>
    );
  }
  if (!preview) {
    return null;
  }
  return (
    <div className="text-[12px] text-textItemBlur max-w-[340px]">
      {planChangeCopy({ ...preview, overage }, pack, currency)}
    </div>
  );
};
