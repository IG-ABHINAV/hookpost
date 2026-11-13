'use client';

import { AdminHeader } from '@hookpost/frontend/components/admin/admin.header';
import React, { FC, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { LoadingComponent } from '@hookpost/frontend/components/layout/loading';
import {
  errorsOf,
  MarketplaceTotals,
  MarketplacesResponse,
  WINDOWS,
  WindowKey,
} from '@hookpost/frontend/components/admin/marketplaces.view';

dayjs.extend(relativeTime);

const n = (v: number) => v.toLocaleString();

const Card: FC<{ title: string; value: number; icon: string; subtext?: string; testId?: string }> = ({
  title,
  value,
  icon,
  subtext,
  testId,
}) => (
  <div
    data-testid={testId}
    className="border border-newTableBorder rounded-[12px] p-[16px] bg-newBgColorInner flex flex-col justify-between shadow-sm"
  >
    <div className="flex items-center justify-between">
      <div className="text-[13px] opacity-75 font-medium">{title}</div>
      <div className="text-[20px]">{icon}</div>
    </div>
    <div className="mt-[8px]">
      <div className="text-[28px] font-[700] text-textColor" data-testid={testId ? `${testId}-value` : undefined}>
        {n(value)}
      </div>
      {subtext && <div className="text-[11px] opacity-60 mt-[2px]">{subtext}</div>}
    </div>
  </div>
);

/** 401, 403, 429 and 5xx of one period, each with its own colour; other 4xx in the tooltip. */
const Errors: FC<{ t: MarketplaceTotals; testId: string }> = ({ t, testId }) => {
  const parts: [string, number, string][] = [
    ['401', t.unauthorized, 'text-amber-700 dark:text-amber-300'],
    ['403', t.forbidden, 'text-orange-700 dark:text-orange-300'],
    ['429', t.rateLimited, 'text-sky-700 dark:text-sky-300'],
    ['5xx', t.serverErrors, 'text-red-400'],
  ];
  return (
    <div
      className="flex flex-wrap gap-[8px] text-[12px]"
      data-testid={testId}
      title={`Other 4xx: ${t.clientErrors}`}
    >
      {parts.map(([label, value, color]) => (
        <span key={label} data-testid={`${testId}-${label}`} className={value ? color : 'opacity-40'}>
          {label}: <b>{n(value)}</b>
        </span>
      ))}
    </div>
  );
};

/** Calls per day, the last 30 UTC days; errors shaded on top. */
const Spark: FC<{ daily: MarketplacesResponse['marketplaces'][number]['daily'] }> = ({ daily }) => {
  const max = Math.max(1, ...daily.map((d) => d.calls));
  return (
    <div className="flex items-end gap-[1px] h-[24px]" aria-hidden="true">
      {daily.map((d) => (
        <div
          key={d.day}
          title={`${d.day}: ${d.calls} calls, ${d.errors} refused or failed`}
          className="w-[3px] bg-primary/70 relative"
          style={{ height: `${Math.max(d.calls ? 2 : 0, (d.calls / max) * 24)}px` }}
        >
          {d.errors > 0 && (
            <div
              className="absolute bottom-0 left-0 w-full bg-red-400/80"
              style={{ height: `${(d.errors / Math.max(1, d.calls)) * 100}%` }}
            />
          )}
        </div>
      ))}
    </div>
  );
};

const LastCall: FC<{ at: string | null }> = ({ at }) =>
  at ? (
    <span title={dayjs(at).format('D MMM YYYY, HH:mm:ss')}>{dayjs(at).fromNow()}</span>
  ) : (
    <span className="opacity-50">never</span>
  );

/**
 * The super-admin Marketplaces page (/admin/marketplaces): per API
 * marketplace, its subscribers (paying vs free, dormant, blocked), calls
 * today / 7 / 30 days, refusals by kind (401, 403, 429, 5xx) and its last
 * call, plus how many workspaces came direct and through each marketplace.
 * From GET /admin/marketplaces (MarketplaceUsageService.overview).
 */
export const AdminMarketplacesComponent: FC = () => {
  const user = useUser();
  const fetch = useFetch();
  const [period, setPeriod] = useState<WindowKey>('today');

  const { data, isLoading, error, mutate } = useSWR<MarketplacesResponse>(
    user?.isSuperAdmin ? '/admin/marketplaces' : null,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load marketplaces');
      return res.json();
    },
    { refreshInterval: 60_000 }
  );

  if (!user?.isSuperAdmin) {
    return (
      <div className="border border-newTableBorder rounded-[8px] p-[24px] text-center opacity-70">
        You are not authorized to view the Super Admin panel.
      </div>
    );
  }

  const rows = data?.marketplaces || [];
  const totals = rows.reduce(
    (acc, r) => ({
      subscribers: acc.subscribers + r.subscribers.total,
      paying: acc.paying + r.subscribers.paying,
      free: acc.free + r.subscribers.free,
      calls: acc.calls + r.today.calls,
      errors: acc.errors + errorsOf(r.today),
    }),
    { subscribers: 0, paying: 0, free: 0, calls: 0, errors: 0 }
  );
  const windowLabel = WINDOWS.find((w) => w.key === period)!.label;

  return (
    <div className="flex flex-col gap-[20px] max-w-[1400px] w-full min-w-0 mx-auto">
      <AdminHeader
        icon="🛒"
        title="Marketplaces"
        subtitle={'API marketplaces that resell Hookpost: subscribers, calls and refusals per marketplace.'}
      />

      {isLoading && <LoadingComponent />}
      {error && (
        <div className="border border-red-500/40 rounded-[8px] p-[16px] text-red-700 dark:text-red-300 text-[13px]">
          Could not load the marketplaces.{' '}
          <button className="underline" onClick={() => mutate()}>
            Try again
          </button>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-[14px]">
            <Card
              testId="mkt-total-subscribers"
              title="Marketplace subscribers"
              value={totals.subscribers}
              icon="🛒"
              subtext={`${totals.paying} paying · ${totals.free} free, across ${rows.length} marketplaces`}
            />
            <Card testId="mkt-total-paying" title="Paying" value={totals.paying} icon="💳" subtext="Active, on a paid plan" />
            <Card
              testId="mkt-total-calls-today"
              title="Calls today"
              value={totals.calls}
              icon="📈"
              subtext={`UTC day ${data.day}`}
            />
            <Card
              testId="mkt-total-errors-today"
              title="Refused or failed today"
              value={totals.errors}
              icon="⚠️"
              subtext="401, 403, 429, other 4xx and 5xx"
            />
          </div>

          <div
            data-testid="customer-sources"
            className="flex flex-wrap items-center gap-[10px] bg-newBgColorInner border border-newTableBorder rounded-[12px] p-[14px] text-[13px]"
          >
            <span className="opacity-70">Workspaces by source:</span>
            {data.sources.map((s) => (
              <span
                key={s.id}
                data-testid={`source-${s.id}`}
                className="rounded-[8px] border border-newTableBorder px-[10px] py-[4px]"
              >
                {s.label}: <b data-testid="source-count">{n(s.workspaces)}</b>
              </span>
            ))}
          </div>

          <div className="flex items-center gap-[6px]" role="group" aria-label="Refusals period">
            <span className="text-[12px] opacity-70 me-[4px]">Refusals:</span>
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                type="button"
                data-testid={`window-${w.key}`}
                aria-pressed={period === w.key}
                onClick={() => setPeriod(w.key)}
                className={`px-[12px] h-[32px] rounded-[8px] text-[12px] font-[600] transition-all ${
                  period === w.key
                    ? 'bg-forth text-hp-on-primary border border-forth'
                    : 'bg-newBgColor border border-newTableBorder text-textColor hover:bg-white/5'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto border border-newTableBorder rounded-[12px]">
            <table className="w-full text-[13px]">
              <thead className="bg-newBgColorInner text-start">
                <tr className="text-[12px] opacity-75">
                  <th className="text-start p-[12px]">Marketplace</th>
                  <th className="text-start p-[12px]">Subscribers</th>
                  <th className="text-end p-[12px]">Calls today</th>
                  <th className="text-end p-[12px]">7 days</th>
                  <th className="text-end p-[12px]">30 days</th>
                  <th className="text-start p-[12px]">Refusals ({windowLabel})</th>
                  <th className="text-start p-[12px]">Last 30 days</th>
                  <th className="text-start p-[12px]">Last call</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    data-testid={`mkt-row-${r.id}`}
                    className="border-t border-newTableBorder align-top"
                  >
                    <td className="p-[12px]">
                      <div className="font-[600] text-textColor">{r.label}</div>
                      <div className="text-[11px] mt-[2px]" data-testid="mkt-configured">
                        {r.configured ? (
                          <span className="text-emerald-700 dark:text-emerald-300">Live: {r.products.join(', ')}</span>
                        ) : (
                          <span className="opacity-50">No secret set</span>
                        )}
                      </div>
                    </td>
                    <td className="p-[12px]">
                      <div>
                        <b data-testid="mkt-subscribers">{n(r.subscribers.total)}</b>{' '}
                        <span className="opacity-70">
                          (<span data-testid="mkt-paying">{r.subscribers.paying}</span> paying ·{' '}
                          <span data-testid="mkt-free">{r.subscribers.free}</span> free)
                        </span>
                      </div>
                      <div className="text-[11px] opacity-60 mt-[2px]">
                        {r.subscribers.new7d} new in 7 days
                        {r.subscribers.dormant ? ` · ${r.subscribers.dormant} dormant` : ''}
                        {r.subscribers.blocked ? ` · ${r.subscribers.blocked} blocked` : ''}
                        {Object.keys(r.subscribers.byProduct).length
                          ? ` · ${Object.entries(r.subscribers.byProduct)
                              .map(([p, c]) => `${p} ${c}`)
                              .join(', ')}`
                          : ''}
                      </div>
                    </td>
                    <td className="p-[12px] text-end" data-testid="mkt-calls-today">
                      {n(r.today.calls)}
                    </td>
                    <td className="p-[12px] text-end" data-testid="mkt-calls-7d">
                      {n(r.last7d.calls)}
                    </td>
                    <td className="p-[12px] text-end" data-testid="mkt-calls-30d">
                      {n(r.last30d.calls)}
                    </td>
                    <td className="p-[12px]">
                      <Errors t={r[WINDOWS.find((w) => w.key === period)!.field]} testId="mkt-errors" />
                    </td>
                    <td className="p-[12px]">
                      <Spark daily={r.daily} />
                    </td>
                    <td className="p-[12px]" data-testid="mkt-last-call">
                      <LastCall at={r.lastCallAt} />
                    </td>
                  </tr>
                ))}
                <tr data-testid="mkt-row-UNKNOWN" className="border-t border-newTableBorder align-top opacity-80">
                  <td className="p-[12px]">
                    <div className="font-[600]">No marketplace named</div>
                    <div className="text-[11px] opacity-60">Calls with no marketplace header, or two</div>
                  </td>
                  <td className="p-[12px] opacity-50">-</td>
                  <td className="p-[12px] text-end" data-testid="mkt-calls-today">
                    {n(data.unattributed.today.calls)}
                  </td>
                  <td className="p-[12px] text-end" data-testid="mkt-calls-7d">
                    {n(data.unattributed.last7d.calls)}
                  </td>
                  <td className="p-[12px] text-end" data-testid="mkt-calls-30d">
                    {n(data.unattributed.last30d.calls)}
                  </td>
                  <td className="p-[12px]">
                    <Errors
                      t={data.unattributed[WINDOWS.find((w) => w.key === period)!.field]}
                      testId="mkt-errors"
                    />
                  </td>
                  <td className="p-[12px]" />
                  <td className="p-[12px]" data-testid="mkt-last-call">
                    <LastCall at={data.unattributed.lastCallAt} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="text-[11px] opacity-60">
            Days are UTC. Counts are added every 15 seconds; a call is counted once its answer is sent.
            Paying and free count active subscribers; dormant (no call for 40 days) and blocked ones are counted apart.
          </div>
        </>
      )}
    </div>
  );
};
