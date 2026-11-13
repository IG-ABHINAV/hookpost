'use client';

import { FC } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { useIsTwa } from '@hookpost/frontend/components/layout/twa.component';
import {
  freePostsCounter,
  TRIAL_CTA_HREF,
  trialRequiredCta,
} from '@hookpost/frontend/components/layout/trial.cta';

/**
 * "Start your N-day trial to publish posts" with the button to the paywall,
 * for a workspace without a plan (trial.cta.ts). No close button: it stays
 * until the workspace has a trial or a plan.
 */
export const TrialRequiredBanner: FC<{ className?: string }> = ({
  className,
}) => {
  const user = useUser();
  const isTwa = useIsTwa();
  const cta = trialRequiredCta({
    planState: user?.planState,
    allowTrial: user?.allowTrial,
    role: user?.role,
    isTwa,
    trialDays: user?.trialDays,
  });
  if (!cta) return null;

  return (
    <div
      role="status"
      data-testid="trial-required-banner"
      className={clsx(
        'flex flex-wrap items-center gap-x-[16px] gap-y-[8px] border-s-[4px] border-hp-primary bg-newBgColorInner px-[12px] md:px-[20px] py-[10px] text-[14px] text-newTextColor',
        className
      )}
    >
      <div className="flex-1 min-w-[220px] font-[600]">{cta.message}</div>
      {cta.label && (
        <Link
          href={TRIAL_CTA_HREF}
          className="h-[36px] flex items-center rounded-[8px] bg-hp-primary hover:bg-hp-primary-hover px-[16px] font-[600] text-hp-on-primary whitespace-nowrap"
        >
          {cta.label}
        </Link>
      )}
    </div>
  );
};

/**
 * "2 of 3 free posts left · Upgrade" for a new sign-up on its free posts
 * (trial.cta.ts freePostsCounter). Small and always there, until the
 * workspace has a plan.
 */
export const FreePostsCounter: FC<{ className?: string }> = ({ className }) => {
  const user = useUser();
  const isTwa = useIsTwa();
  const counter = freePostsCounter({
    planState: user?.planState,
    freePosts: user?.freePosts,
    role: user?.role,
    isTwa,
  });
  if (!counter) return null;

  return (
    <div
      role="status"
      data-testid="free-posts-counter"
      className={clsx(
        'flex flex-wrap items-center gap-x-[8px] gap-y-[4px] bg-newBgColorInner px-[12px] md:px-[20px] py-[8px] text-[13px] text-textItemBlur',
        counter.usedUp && 'border-s-[4px] border-hp-primary text-newTextColor font-[600]',
        className
      )}
    >
      <span>{counter.message}</span>
      {counter.label && (
        <>
          <span aria-hidden="true">·</span>
          <Link
            href={TRIAL_CTA_HREF}
            className="font-[600] text-hp-primary-text hover:text-hp-primary-text hover:underline"
          >
            {counter.label}
          </Link>
        </>
      )}
    </div>
  );
};
