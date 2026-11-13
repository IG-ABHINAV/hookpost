'use client';

import { AdminHeader } from '@hookpost/frontend/components/admin/admin.header';
import React, { FC, useCallback, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { Button } from '@hookpost/react/form/button';
import { LoadingComponent } from '@hookpost/frontend/components/layout/loading';

interface PerSocial {
  provider: string;
  count: number;
}

interface StatsBlock {
  total: number;
  perSocial: PerSocial[];
}

interface StatsResponse {
  from: string;
  to: string;
  errors: StatsBlock;
  posts: StatsBlock;
  connected: StatsBlock;
  publishingAccounts?: StatsBlock;
  scheduledAccounts?: StatsBlock;
  publishingChannels?: StatsBlock;
  scheduledChannels?: StatsBlock;
}

// Presets are whole UTC days, the days the backend counts. They mixed local
// date maths with toISOString (UTC) before: after midnight in India "This
// week" started on Sunday and equalled "Today", and on the 1st "This month"
// started on the last day of the month before.
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export const statsPresetDays = (now: Date = new Date()) => {
  const shifted = (fn: (d: Date) => void) => {
    const d = new Date(now.getTime());
    fn(d);
    return utcDay(d);
  };
  return {
    today: utcDay(now),
    // ISO week: Monday first.
    startOfWeek: shifted((d) => d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))),
    startOfMonth: shifted((d) => d.setUTCDate(1)),
    daysAgo7: shifted((d) => d.setUTCDate(d.getUTCDate() - 7)),
    daysAgo30: shifted((d) => d.setUTCDate(d.getUTCDate() - 30)),
  };
};

const today = () => statsPresetDays().today;

/**
 * The range the stats cover, as the days that were asked for. The backend
 * counts whole UTC days (from 00:00 to 23:59:59.999), so turning its
 * `to` into a local date showed the next day east of UTC ("Today" read
 * "1/11/2026 — 2/11/2026" in India).
 */
export const statsRangeLabel = (from: string, to: string) => {
  const day = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
      timeZone: 'UTC',
    });
  return from === to ? `${day(from)} (UTC)` : `${day(from)} — ${day(to)} (UTC)`;
};

const PRESETS: { label: string; range: () => { from: string; to: string } }[] = [
  { label: 'Today', range: () => ({ from: today(), to: today() }) },
  { label: 'This week', range: () => ({ from: statsPresetDays().startOfWeek, to: today() }) },
  { label: 'This month', range: () => ({ from: statsPresetDays().startOfMonth, to: today() }) },
  { label: 'Last 7 days', range: () => ({ from: statsPresetDays().daysAgo7, to: today() }) },
  { label: 'Last 30 days', range: () => ({ from: statsPresetDays().daysAgo30, to: today() }) },
];

const useStats = (params: {
  from: string;
  to: string;
  unknownOnly: boolean;
}) => {
  const fetch = useFetch();
  const query = new URLSearchParams({
    from: params.from,
    to: params.to,
    ...(params.unknownOnly ? { unknownOnly: 'true' } : {}),
  });
  const key = `/admin/stats?${query.toString()}`;
  return useSWR<StatsResponse>(
    key,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error('Failed to load stats');
      }
      return res.json();
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    }
  );
};

const SummaryCard: FC<{ label: string; value: number }> = ({
  label,
  value,
}) => (
  <div className="border border-newTableBorder rounded-[8px] p-[16px] bg-newBgColorInner">
    <div className="text-[12px] opacity-70">{label}</div>
    <div className="text-[28px] font-[600]">{value.toLocaleString()}</div>
  </div>
);

const PerSocialTable: FC<{ title: string; block: StatsBlock }> = ({
  title,
  block,
}) => (
  <div className="border border-newTableBorder rounded-[8px] overflow-hidden">
    <div className="grid grid-cols-[1fr_auto] gap-[12px] px-[12px] py-[10px] bg-newBgColorInner text-[12px] uppercase opacity-70 border-b border-newTableBorder">
      <div>{title}</div>
      <div className="text-right">Count</div>
    </div>
    {block.perSocial.length === 0 ? (
      <div className="px-[12px] py-[10px] text-[13px] opacity-70">
        No data for this timeframe.
      </div>
    ) : (
      block.perSocial.map((row) => (
        <div
          key={row.provider}
          className="grid grid-cols-[1fr_auto] gap-[12px] px-[12px] py-[10px] text-[13px] border-b border-newTableBorder last:border-b-0"
        >
          <div className="capitalize">{row.provider}</div>
          <div className="text-right">{row.count.toLocaleString()}</div>
        </div>
      ))
    )}
  </div>
);

export const AdminStatsComponent: FC = () => {
  const user = useUser();

  const [fromInput, setFromInput] = useState(today());
  const [toInput, setToInput] = useState(today());
  const [range, setRange] = useState({ from: today(), to: today() });
  const [unknownOnly, setUnknownOnly] = useState(false);

  const { data, isLoading, error } = useStats({ ...range, unknownOnly });

  const applyRange = useCallback((next: { from: string; to: string }) => {
    setFromInput(next.from);
    setToInput(next.to);
    setRange(next);
  }, []);

  if (!user?.isSuperAdmin) {
    return (
      <div className="text-textColor p-[20px]">
        You do not have access to this page.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[16px] text-textColor max-w-[1400px] w-full min-w-0 mx-auto">
      <AdminHeader
        icon="📊"
        title="Social Publishing Stats"
        subtitle={'Real-time social posting volume, channel throughput, and network analytics.'}
      />

      <div className="flex items-center justify-between mt-[4px]">
        <div className="text-[16px] font-[600]">Timeframe Telemetry</div>
        {data && (
          <div className="text-[13px] opacity-70" data-testid="stats-range">
            {statsRangeLabel(range.from, range.to)}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-[8px]">
        {PRESETS.map((preset) => {
          const next = preset.range();
          const active = range.from === next.from && range.to === next.to;
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyRange(next)}
              className={`h-[32px] px-[12px] rounded-[8px] text-[13px] border cursor-pointer whitespace-nowrap ${
                active
                  ? 'bg-forth text-hp-on-primary border-forth'
                  : 'bg-newBgColorInner text-textColor border-newTableBorder hover:bg-tableBorder'
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-[12px] items-end bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[12px]">
        <div className="flex flex-col gap-[6px]">
          <div className="text-[12px] opacity-70">From</div>
          <input
            type="date"
            value={fromInput}
            max={toInput}
            onChange={(e) => setFromInput(e.target.value)}
            className="bg-newBgColorInner h-[38px] border border-newTableBorder rounded-[8px] px-[10px] text-[14px] text-textColor"
          />
        </div>
        <div className="flex flex-col gap-[6px]">
          <div className="text-[12px] opacity-70">To</div>
          <input
            type="date"
            value={toInput}
            min={fromInput}
            max={today()}
            onChange={(e) => setToInput(e.target.value)}
            className="bg-newBgColorInner h-[38px] border border-newTableBorder rounded-[8px] px-[10px] text-[14px] text-textColor"
          />
        </div>
        <Button
          onClick={() => setRange({ from: fromInput, to: toInput })}
          disabled={!fromInput || !toInput || fromInput > toInput}
        >
          Apply
        </Button>

        <label
          className="flex items-center gap-[6px] text-[13px] cursor-pointer h-[38px]"
          title='Only count errors whose message matches "message":"Unknown Error" (affects the error stats only)'
        >
          <input
            type="checkbox"
            checked={unknownOnly}
            onChange={(e) => setUnknownOnly(e.target.checked)}
          />
          Unknown errors only
        </label>
      </div>

      {isLoading ? (
        <LoadingComponent />
      ) : error || !data ? (
        <div className="text-red-400">Failed to load stats.</div>
      ) : (
        <div className="overflow-x-auto pb-[8px] scrollbar scrollbar-thumb-fifth scrollbar-track-newBgColor flex flex-col gap-[16px]">
          {/* Was one non-wrapping row of 220px+ boxes: 1,612px wide, off
              screen even at 1440. As many columns as fit instead. */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] gap-[12px]">
            <div className="min-w-0">
              <SummaryCard
                label="Total posts published"
                value={data.posts.total}
              />
            </div>
            <div className="min-w-0">
              <SummaryCard
                label="Total connected accounts"
                value={data.connected.total}
              />
            </div>
            <div className="min-w-0">
              <SummaryCard
                label={unknownOnly ? 'Total unknown errors' : 'Total errors'}
                value={data.errors.total}
              />
            </div>
            {data.publishingChannels && (
              <div className="min-w-0">
                <SummaryCard
                  label="Unique channels - published (all platforms combined)"
                  value={data.publishingChannels.total}
                />
              </div>
            )}
            {data.scheduledChannels && (
              <div className="min-w-0">
                <SummaryCard
                  label="Unique channels - scheduled (all platforms combined)"
                  value={data.scheduledChannels.total}
                />
              </div>
            )}
            {data.publishingAccounts && (
              <div className="min-w-0">
                <SummaryCard
                  label="Unique users - published (all platforms combined)"
                  value={data.publishingAccounts.total}
                />
              </div>
            )}
            {data.scheduledAccounts && (
              <div className="min-w-0">
                <SummaryCard
                  label="Unique users - scheduled (all platforms combined)"
                  value={data.scheduledAccounts.total}
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-[12px] items-start">
            <div className="min-w-0">
              <PerSocialTable
                title="Posts published per social"
                block={data.posts}
              />
            </div>
            <div className="min-w-0">
              <PerSocialTable
                title="Connected accounts per social"
                block={data.connected}
              />
            </div>
            <div className="min-w-0">
              <PerSocialTable
                title={
                  unknownOnly
                    ? 'Unknown errors per social'
                    : 'Errors per social'
                }
                block={data.errors}
              />
            </div>
            {data.publishingChannels && (
              <div className="min-w-0">
                <PerSocialTable
                  title="Unique channels - published"
                  block={data.publishingChannels}
                />
              </div>
            )}
            {data.scheduledChannels && (
              <div className="min-w-0">
                <PerSocialTable
                  title="Unique channels - scheduled"
                  block={data.scheduledChannels}
                />
              </div>
            )}
            {data.publishingAccounts && (
              <div className="min-w-0">
                <PerSocialTable
                  title="Unique users - published"
                  block={data.publishingAccounts}
                />
              </div>
            )}
            {data.scheduledAccounts && (
              <div className="min-w-0">
                <PerSocialTable
                  title="Unique users - scheduled"
                  block={data.scheduledAccounts}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
