'use client';

import React, { FC, useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { aiCreditsLeftLabel, xPostsLeftLabel } from './plan.usage.copy';

interface PlanUsageResponse {
  aiCredits: { left: number; total: number; imageCost: number } | null;
  xPosts: { left: number; total: number; linksAllowed: boolean } | null;
}

/**
 * What is left this plan month (GET /billing/usage), on the plan screen:
 * the shared AI credits and the X posts. Nothing when neither is metered.
 */
export const PlanUsage: FC<{ className?: string }> = ({ className }) => {
  const fetch = useFetch();
  const load = useCallback(async (): Promise<PlanUsageResponse | null> => {
    const res = await fetch('/billing/usage', { method: 'GET' });
    return res.ok ? res.json() : null;
  }, []);
  const { data } = useSWR('billing-plan-usage', load);
  const lines = [
    data?.aiCredits ? aiCreditsLeftLabel(data.aiCredits) : null,
    data?.xPosts ? xPostsLeftLabel(data.xPosts) : null,
  ].filter(Boolean) as string[];
  if (!lines.length) return null;
  return (
    <div
      data-testid="plan-usage"
      className={
        'flex flex-wrap gap-x-[16px] gap-y-[4px] text-[14px] text-textItemBlur ' +
        (className || '')
      }
    >
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
};
