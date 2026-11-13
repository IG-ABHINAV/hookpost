'use client';

import { FC } from 'react';
import Link from 'next/link';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { useIsTwa } from '@hookpost/frontend/components/layout/twa.component';
import { renewalReminder } from '@hookpost/frontend/components/billing/one.time.plan.copy';

/**
 * "Your Hookpost Pro month ends on ...", in the app, in the last
 * RENEW_WINDOW_DAYS of a paid one-time month (one.time.plan.ts), with the
 * way to renew. No email: the owner, 8 Nov 2026. Only for those who can
 * pay (owner and admins), never inside the Play app.
 */
export const RenewalReminderBanner: FC = () => {
  const user = useUser();
  const isTwa = useIsTwa();
  const message = renewalReminder(user?.oneTimePlanEndsAt);
  if (!message || isTwa || !['ADMIN', 'SUPERADMIN'].includes(user?.role || '')) {
    return null;
  }
  return (
    <div
      role="status"
      data-testid="renewal-reminder"
      className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px] border-s-[4px] border-amber-500 bg-newBgColorInner px-[12px] md:px-[20px] py-[10px] text-[14px] text-newTextColor"
    >
      <div className="flex-1 min-w-[220px] font-[500]">{message}</div>
      <Link
        href="/billing"
        className="h-[36px] flex items-center rounded-[8px] bg-forth px-[16px] font-[600] text-hp-on-primary"
      >
        Renew for another month
      </Link>
    </div>
  );
};
