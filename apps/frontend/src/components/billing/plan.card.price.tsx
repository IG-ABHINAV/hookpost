'use client';

import React, { FC } from 'react';
import { getCurrencyConfig } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  AppliedCoupon,
  discounted,
  formatMoney,
} from '@hookpost/frontend/components/billing/coupon.field';
import { CurrentPlanPrice } from '@hookpost/frontend/components/billing/use.pricing.context';
import { useT } from '@hookpost/react/translation/get.transation.service.client';

type Period = 'MONTHLY' | 'YEARLY';

/** What the current plan's card shows instead of the list price. */
export interface PaidPrice {
  amount: number;
  currency: string;
  /** Today's list price, only when the workspace pays something else. */
  list: { amount: number; currency: string } | null;
}

const money = (amount: number, currency: string) =>
  `${getCurrencyConfig(currency).symbol}${formatMoney(
    amount,
    currency === 'INR' ? 'en-IN' : 'en-US'
  )}`;

/**
 * The price this workspace pays, for the one card that is its current plan
 * in the period the toggle shows. Razorpay can't re-price a running
 * subscription, so a subscriber keeps the price they signed up at; the card
 * used to show today's list price beside "Current Plan" instead.
 *
 * Null for every other card (another tier, the other period), and when the
 * server sent no price: those cards show the list price as before.
 */
export function paidPriceFor(input: {
  tier: string;
  period: Period;
  /** The card is marked Current Plan. */
  isCurrent: boolean;
  listPrice: number;
  listCurrency: string;
  currentPlan?: CurrentPlanPrice | null;
}): PaidPrice | null {
  const { tier, period, isCurrent, listPrice, listCurrency, currentPlan } =
    input;
  if (
    !isCurrent ||
    !currentPlan ||
    String(currentPlan.billing).toUpperCase() !== tier.toUpperCase() ||
    currentPlan.period !== period ||
    !(Number(currentPlan.amount) > 0)
  ) {
    return null;
  }
  const amount = Number(currentPlan.amount);
  const currency = String(currentPlan.currency || listCurrency).toUpperCase();
  const same =
    amount === Number(listPrice) && currency === listCurrency.toUpperCase();
  return {
    amount,
    currency,
    list: same ? null : { amount: Number(listPrice), currency: listCurrency },
  };
}

/**
 * The price block of a plan card: the list price (with a coupon applied, if
 * any), or for the current plan what the workspace actually pays, with a line
 * noting it is the price they subscribed at when it differs.
 */
export const PlanCardPrice: FC<{
  listPrice: number;
  listCurrency: string;
  period: Period;
  coupon?: AppliedCoupon | null;
  paid?: PaidPrice | null;
}> = ({ listPrice, listCurrency, period, coupon, paid }) => {
  const t = useT();
  const symbol = getCurrencyConfig(listCurrency).symbol;
  return (
    <div className="flex flex-col gap-[4px] [@media(max-width:1024px)]:items-center">
      <div className="text-[38px] flex gap-[2px] items-center">
        {paid ? (
          <div>{money(paid.amount, paid.currency)}</div>
        ) : (
          <>
            <div>
              {symbol}
              {formatMoney(discounted(listPrice, coupon))}
            </div>
            {coupon?.percentOff ? (
              <div className="text-[16px] text-customColor18 line-through">
                {symbol}
                {listPrice}
              </div>
            ) : null}
          </>
        )}
        <div className="text-[14px] text-customColor18">
          {period === 'YEARLY' ? '/year' : '/month'}
        </div>
      </div>
      {paid?.list ? (
        <div className="text-[13px] text-customColor18">
          {String(
            t(
              'billing_your_price_since_subscribed',
              'Your price since you subscribed.'
            )
          )}
        </div>
      ) : null}
    </div>
  );
};
