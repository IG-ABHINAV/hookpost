'use client';

import React, { FC, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { Button } from '@hookpost/react/form/button';
import { LoadingComponent } from '@hookpost/frontend/components/layout/loading';
import { CheckIconComponent } from '@hookpost/frontend/components/ui/check.icon.component';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { isTwaClient } from '@hookpost/frontend/components/layout/twa';
import { browserTz } from '@hookpost/frontend/components/billing/use.pricing.context';
import {
  planFeatureItems,
  planFeatureLabel,
} from '@hookpost/frontend/components/billing/plan.features';
import {
  OneTimePlanQuote,
  oneTimePlanCopy,
  planDate,
} from '@hookpost/frontend/components/billing/one.time.plan.copy';
import { openRazorpayOrderCheckout } from '@hookpost/frontend/components/billing/razorpay.billing';

/** GET /billing/order/quote: the plan's price for this workspace, and whether checkout opens. */
export const useOneTimePlanQuote = () => {
  const fetch = useFetch();
  return useSWR<OneTimePlanQuote>(
    `/billing/order/quote?tz=${encodeURIComponent(browserTz())}`,
    async (path: string) => (await fetch(path)).json()
  );
};

/**
 * The single plan, paid one month at a time (one.time.plan.ts): price,
 * what it includes, and a one-time Razorpay checkout (UPI, card or an
 * international card). A paid month shows until when; in its last
 * RENEW_WINDOW_DAYS the button renews it for another month. Used by Billing
 * and by the plan screen of a workspace that has to choose a plan.
 */
export const OneTimePlanCheckout: FC<{ className?: string }> = ({ className }) => {
  const t = useT();
  const fetch = useFetch();
  const { data: quote, isLoading, mutate } = useOneTimePlanQuote();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paidUntil, setPaidUntil] = useState<string | null>(null);

  const features = useMemo(() => planFeatureItems(pricing.PRO), []);

  const pay = useCallback(async () => {
    if (isTwaClient() || !quote) return;
    setError(null);
    setBusy(true);
    const order = await (
      await fetch('/billing/order', {
        method: 'POST',
        body: JSON.stringify({ tz: browserTz() }),
      })
    )
      .json()
      .catch(() => null);
    if (!order?.orderId) {
      setBusy(false);
      setError(
        order?.message ||
          t('billing_checkout_unavailable', 'Checkout is currently unavailable. Please try again shortly.')
      );
      mutate();
      return;
    }
    const opened = await openRazorpayOrderCheckout({
      orderId: order.orderId,
      keyId: order.keyId,
      amount: order.amount,
      currency: order.currency,
      description: `${order.name} · one month · ${order.label}`,
      verify: async (payload) => {
        const res = await fetch('/billing/order/verify', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.message || 'verify failed');
        return body;
      },
      onSuccess: (verified) => {
        setBusy(false);
        setPaidUntil(verified?.paidUntil || null);
        // The plan is on: reload so every screen reads it.
        setTimeout(() => window.location.reload(), 1200);
      },
      onError: (message) => {
        setBusy(false);
        setError(message);
      },
      onClose: () => setBusy(false),
    });
    if (!opened) {
      setBusy(false);
      setError(
        t('billing_checkout_unavailable', 'Checkout is currently unavailable. Please try again shortly.')
      );
    }
  }, [quote, fetch, t, mutate]);

  if (isLoading || !quote) {
    return <LoadingComponent />;
  }

  const copy = oneTimePlanCopy(quote);

  return (
    <div
      data-testid="one-time-plan"
      className={`flex flex-col gap-[20px] rounded-[20px] border-[1.5px] border-[#618DFF] p-[24px] mobile:p-[16px] ${className || ''}`}
    >
      <div className="flex flex-wrap items-end justify-between gap-[12px]">
        <div>
          <div className="text-[20px] font-[600]">{quote.name}</div>
          <div className="text-[14px] text-textItemBlur">
            {t('one_time_plan_tagline', 'One plan, everything included. Paid one month at a time.')}
          </div>
        </div>
        <div className="flex items-baseline gap-[4px]">
          <span className="text-[40px] font-[700] leading-none">{quote.label}</span>
          <span className="text-[14px] text-textItemBlur">/ {t('month', 'month')}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 mobile:grid-cols-1 gap-y-[8px] gap-x-[32px] text-[14px]">
        {features.map((feature) => (
          <div key={feature.key} className="flex items-center gap-[8px]">
            <div className="shrink-0">
              <CheckIconComponent />
            </div>
            <div>{planFeatureLabel(feature, t)}</div>
          </div>
        ))}
      </div>

      {paidUntil ? (
        <div role="status" className="text-[16px] font-[600] text-green-400">
          {`Payment received. ${quote.name} is paid until ${planDate(paidUntil)}.`}
        </div>
      ) : (
        <>
          {copy.status && <div className="text-[15px] font-[500]">{copy.status}</div>}
          {quote.canBuy ? (
            <Button onClick={pay} loading={busy} disabled={busy}>
              {copy.button}
            </Button>
          ) : (
            copy.refusal && <div className="text-[14px] text-textItemBlur">{copy.refusal}</div>
          )}
          <div className="text-[12px] text-customColor18">{copy.note}</div>
          <div className="text-[12px] text-customColor18">
            {t('billing_powered_by_razorpay', 'Secure payments processed by')}{' '}
            {quote.currency === 'INR'
              ? 'Razorpay (UPI, cards, NetBanking)'
              : 'Razorpay (international cards)'}
          </div>
        </>
      )}
      {error ? (
        <div className="text-[14px] text-red-400" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
};
