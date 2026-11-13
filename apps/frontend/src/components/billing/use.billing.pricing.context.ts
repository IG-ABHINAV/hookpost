'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import {
  PricingContext,
  browserTz,
  isPricingContext,
} from '@hookpost/frontend/components/billing/use.pricing.context';

/**
 * Signed-in billing screens: GET /billing/pricing-context, which answers like
 * the public one and also knows the workspace's own plan (a legacy USD plan
 * keeps showing USD).
 */
export function useBillingPricingContext() {
  const fetch = useFetch();
  const load = useCallback(
    async (path: string) => {
      const d = await (await fetch(path)).json();
      return isPricingContext(d) ? d : null;
    },
    [fetch]
  );
  return useSWR<PricingContext | null>(
    `/billing/pricing-context?tz=${encodeURIComponent(browserTz())}`,
    load,
    { revalidateOnFocus: false }
  );
}
