'use client';

import { FC, useCallback } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import clsx from 'clsx';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { useIsTwa } from '@hookpost/frontend/components/layout/twa.component';
import { PAY_FROM_ANOTHER_ACCOUNT_PATH } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

/** GET /billing/payment-issue: the plan's last charge failed (Razorpay status). */
export type PaymentIssueStatus = 'pending' | 'halted' | null;

/**
 * Plan states that can hold a Razorpay plan whose last charge failed.
 * `dunning` is the state the backend computes once it knows a charge is
 * failing (trial.policy.ts), so it is exactly when the banner belongs on the
 * page; the three before it cover the moment before the webhook has landed.
 */
const PLAN_ON_FILE = ['active', 'trialing', 'cancelling', 'dunning'];

/**
 * Whether the app should ask Razorpay at all: a workspace admin (the only
 * ones who can pay) with a Razorpay plan on file, outside the Play app, which
 * never shows checkout.
 */
export function checksPaymentIssue(input: {
  planState?: string | null;
  isLifetime?: boolean;
  role?: string | null;
  isTwa?: boolean;
}): boolean {
  return (
    !input.isTwa &&
    !input.isLifetime &&
    (input.role === 'ADMIN' || input.role === 'SUPERADMIN') &&
    PLAN_ON_FILE.includes(input.planState || '')
  );
}

/**
 * "Your last payment didn't go through" with the way to pay from a different
 * UPI app or card, while Razorpay is retrying the charge (pending) or has
 * stopped (halted); null otherwise. The button opens Change payment method
 * on Billing: a new mandate charged on approval, the old one cancelled once
 * it is approved. The failure email's button goes to the same place.
 *
 * The banner names what a failing charge actually takes away (trial.policy.ts
 * `dunning`): AI and X, for a trial's first charge and a renewal alike. The
 * rest of the workspace carries on, so it must not say "paused".
 */
export function paymentFailedNotice(status: PaymentIssueStatus | undefined) {
  if (status !== 'pending' && status !== 'halted') return null;
  return {
    message:
      status === 'halted'
        ? "Your last payment didn't go through and the retries have stopped, so your plan is ending. AI and X are already paused."
        : "Your last payment didn't go through. AI and X are paused until it does.",
    label: 'Pay from a different account',
    href: PAY_FROM_ANOTHER_ACCOUNT_PATH,
  };
}

export function usePaymentIssue(enabled: boolean) {
  const fetch = useFetch();
  const load = useCallback(
    async (path: string) => {
      const res = await fetch(path);
      if (!res.ok) return null;
      const body = await res.json();
      return (body?.status ?? null) as PaymentIssueStatus;
    },
    [fetch]
  );
  return useSWR<PaymentIssueStatus>(
    enabled ? '/billing/payment-issue' : null,
    load,
    { revalidateOnFocus: false }
  );
}

/**
 * Over the app while the plan's last charge failed. No close button: it
 * goes once the charge is paid, from this account or another one.
 */
export const PaymentFailedBanner: FC<{ className?: string }> = ({
  className,
}) => {
  const user = useUser();
  const isTwa = useIsTwa();
  const { data } = usePaymentIssue(
    checksPaymentIssue({
      planState: user?.planState,
      isLifetime: user?.isLifetime,
      role: user?.role,
      isTwa,
    })
  );
  const notice = paymentFailedNotice(data);
  if (!notice) return null;

  return (
    <div
      role="status"
      data-testid="payment-failed-banner"
      className={clsx(
        'flex flex-wrap items-center gap-x-[16px] gap-y-[8px] border-s-[4px] border-red-500 bg-newBgColorInner px-[12px] md:px-[20px] py-[10px] text-[14px] text-newTextColor',
        className
      )}
    >
      <div className="flex-1 min-w-[220px] font-[600]">{notice.message}</div>
      <Link
        href={notice.href}
        className="h-[36px] flex items-center rounded-[8px] bg-hp-primary hover:bg-hp-primary-hover px-[16px] font-[600] text-hp-on-primary whitespace-nowrap"
      >
        {notice.label}
      </Link>
    </div>
  );
};
