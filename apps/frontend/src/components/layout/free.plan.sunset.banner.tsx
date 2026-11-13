'use client';

import { FC, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { useIsTwa } from '@hookpost/frontend/components/layout/twa.component';
import DeleteAccountComponent from '@hookpost/frontend/components/settings/delete-account.component';
import {
  FREE_SUNSET_DISMISS_KEY,
  freePlanSunsetNotice,
} from '@hookpost/frontend/components/layout/free.plan.sunset';

/**
 * "Your Free plan ends on ..." for a grandfathered Free workspace before
 * FREE_PLAN_SUNSET_AT, with the trial (Billing) and the existing Delete
 * Account flow. Closing it hides it for the rest of this tab's session.
 */
export const FreePlanSunsetBanner: FC<{
  /** False on the plans screen, which is itself the way to the trial. */
  showTrial?: boolean;
  /** False on the plans screen, which shows Delete Account itself. */
  showDelete?: boolean;
}> = ({ showTrial = true, showDelete = true }) => {
  const user = useUser();
  const isTwa = useIsTwa();
  const endsAt = user?.freePlanEndsAt || null;
  // Hidden until the tab's choice is read, so a closed notice never flashes.
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    let closed = false;
    try {
      closed = window.sessionStorage.getItem(FREE_SUNSET_DISMISS_KEY) === endsAt;
    } catch (e) {
      // Blocked storage: show it.
    }
    setDismissed(closed);
  }, [endsAt]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(FREE_SUNSET_DISMISS_KEY, endsAt || '');
    } catch (e) {
      // Blocked storage: closed for this page view only.
    }
  }, [endsAt]);

  const notice = freePlanSunsetNotice({
    planState: user?.planState,
    freePlanEndsAt: endsAt,
    allowTrial: user?.allowTrial,
    role: user?.role,
    isTwa,
    trialDays: user?.trialDays,
  });


  if (!notice || dismissed) return null;

  return (
    <>
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px] border-s-[4px] border-amber-500 bg-newBgColorInner px-[12px] md:px-[20px] py-[10px] text-[14px] text-newTextColor"
    >
      <div className="flex-1 min-w-[220px] font-[500]">{notice.message}</div>
      <div className="flex flex-wrap items-center gap-[16px]">
        {showTrial && notice.trialLabel && (
          <Link
            href="/billing"
            className="h-[36px] flex items-center rounded-[8px] bg-forth px-[16px] font-[600] text-hp-on-primary"
          >
            {notice.trialLabel}
          </Link>
        )}
        {showDelete && <DeleteAccountComponent isLink={true} />}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close"
          className="text-[18px] leading-none text-textItemBlur hover:text-newTextColor"
        >
          ×
        </button>
      </div>
    </div>
    </>
  );
};
