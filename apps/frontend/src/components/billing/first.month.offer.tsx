'use client';

import React, { FC } from 'react';
import clsx from 'clsx';
import {
  firstMonthOfferDetail,
  firstMonthOfferHeadline,
  FirstMonthOfferTerms,
  OfferMethod,
} from '@hookpost/nestjs-libraries/services/first.month.offer';

const METHOD_LABEL: Record<OfferMethod, string> = {
  upi: 'Pay with UPI',
  card: 'Pay with card',
};

/**
 * "First month 20% off (new customers), up to ₹400" at a checkout that gets it (a new
 * rupee monthly plan charged now, no coupon, no trial: firstMonthOfferApplies),
 * with the UPI / card choice.
 *
 * Razorpay takes one offer per subscription and each offer is for one
 * method, so the choice is made here, before the subscription is created,
 * and decides which offer goes on it (payWith on /billing/embedded). It
 * restricts nothing at checkout: paying another way is allowed and charged
 * the full price, and the line below says so. With only one method
 * configured there is nothing to choose and the line names that method.
 */
export const FirstMonthOffer: FC<{
  terms: FirstMonthOfferTerms;
  /** The chosen plan's monthly price in rupees; none where several are listed. */
  monthPrice?: number;
  payWith: OfferMethod;
  onPayWithChange: (method: OfferMethod) => void;
  className?: string;
}> = ({ terms, monthPrice, payWith, onPayWithChange, className }) => {
  const method = terms.methods.includes(payWith) ? payWith : terms.methods[0];
  return (
    <div
      data-testid="first-month-offer"
      className={clsx(
        'flex flex-col gap-[10px] rounded-[14px] border border-hp-primary/50 bg-hp-primary/[0.06] p-[14px] text-[14px]',
        className
      )}
    >
      <div className="font-[600]">{firstMonthOfferHeadline(terms)}</div>
      {terms.methods.length > 1 && (
        <div
          role="radiogroup"
          aria-label="How you will pay"
          className="flex flex-wrap gap-[8px]"
        >
          {terms.methods.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={m === method}
              onClick={() => onPayWithChange(m)}
              className={clsx(
                'h-[34px] rounded-full border px-[14px] text-[13px] font-[600] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-hp-primary',
                m === method
                  ? 'border-hp-primary bg-hp-primary text-hp-on-primary'
                  : 'border-newColColor text-textItemBlur hover:text-newTextColor'
              )}
            >
              {METHOD_LABEL[m]}
            </button>
          ))}
        </div>
      )}
      <div className="text-textItemBlur">
        {firstMonthOfferDetail({ terms, method, monthPrice })}
      </div>
    </div>
  );
};

/**
 * True when checkout was opened without the first-month offer the page was
 * showing: /billing/embedded answered with a subscription whose
 * firstMonthOffer is null or missing. That is Razorpay refusing the offer
 * (subscribe() then checks out at the full price), or a workspace that
 * still has a plan on file and goes through a plan change, which never
 * carries it. The page then stops promising the discount.
 */
export function checkoutDroppedOffer(
  offerShown: boolean,
  response: { subscriptionId?: unknown; blocked?: unknown; firstMonthOffer?: unknown } | null | undefined
): boolean {
  return (
    offerShown &&
    !!response &&
    !response.blocked &&
    !!response.subscriptionId &&
    response.firstMonthOffer == null
  );
}

/** What replaces FirstMonthOffer once checkoutDroppedOffer is true. */
export const FirstMonthOfferNotApplied: FC<{ className?: string }> = ({
  className,
}) => (
  <div
    data-testid="first-month-offer-not-applied"
    className={clsx('text-[14px] text-textItemBlur', className)}
  >
    The first-month offer could not be applied to this checkout, so it is
    charged the full price shown in the payment window.
  </div>
);
