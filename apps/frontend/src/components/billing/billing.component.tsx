'use client';

import { useCallback, useEffect } from 'react';
import useSWR from 'swr';
import { LoadingComponent } from '@hookpost/frontend/components/layout/loading';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { MainBillingComponent } from './main.billing.component';
import { OneTimePlanCheckout } from './one.time.plan';
import { isOrderIdentifier } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/one.time.plan';
import {
  TwaPlanNotice,
  useIsTwa,
} from '@hookpost/frontend/components/layout/twa.component';

// Inside the Google Play app there are no plans and no checkout - Play's
// Payments policy allows only Play Billing there - just the plain line.
export const BillingComponent = () => {
  const isTwa = useIsTwa();
  if (isTwa) {
    return <TwaPlanNotice />;
  }
  return <BillingPlans />;
};

const BillingPlans = () => {
  const fetch = useFetch();
  const load = useCallback(async (path: string) => {
    return await (await fetch(path)).json();
  }, []);
  const { isLoading: isLoadingTier, data: tiers } = useSWR(
    '/user/subscription/tiers',
    load
  );
  const { isLoading: isLoadingSubscription, data: subscription } = useSWR(
    '/user/subscription',
    load
  );
  if (isLoadingSubscription || isLoadingTier) {
    return <LoadingComponent />;
  }
  const sub = subscription?.subscription;
  // A paid one-time month (one.time.plan.ts): its status and the renewal.
  if (sub && isOrderIdentifier(sub.identifier)) {
    return (
      <div className="flex flex-1 flex-col p-[24px] mobile:p-[16px] max-w-[880px]">
        <OneTimePlanCheckout />
      </div>
    );
  }
  // The subscription (autopay) checkout stays the default; with no plan on
  // file, paying once for one month is offered under it as the fallback.
  return (
    <>
      <MainBillingComponent sub={sub} />
      {!sub && (
        <div className="flex flex-col p-[24px] mobile:p-[16px] max-w-[880px]">
          <div className="text-[14px] text-textItemBlur mb-[12px]">
            Can't set up autopay? Pay once for this month instead.
          </div>
          <OneTimePlanCheckout />
        </div>
      )}
    </>
  );
};
