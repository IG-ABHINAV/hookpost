'use client';

import { AdminHeader } from '@hookpost/frontend/components/admin/admin.header';
import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useSWR from 'swr';
import Link from 'next/link';
import dayjs from 'dayjs';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { useToaster } from '@hookpost/react/toaster/toaster';
import { Button } from '@hookpost/react/form/button';
import { LoadingComponent } from '@hookpost/frontend/components/layout/loading';
import {
  Dialog,
  Field,
  inputCls,
} from '@hookpost/frontend/components/admin/admin.dialog';
import {
  historyRowsFromResults,
  madeFromLabel,
  mergeHistory,
  money,
  moneyTotals,
  defaultRefundMinor,
  nextLocalRefunds,
  RefundHistoryRow,
  RefundPayment,
  RefundResult,
  refundState,
  refundStatusLabel,
  withLocalRefund,
} from '@hookpost/frontend/components/admin/refunds.helpers';

interface PaymentsPage {
  payments: RefundPayment[];
  scanned: number;
  nextSkip: number;
  hasMore: boolean;
  from: number;
  to: number;
}

interface HistoryPage {
  refunds: RefundHistoryRow[];
  scanned: number;
  /** Refunds of other products (or unidentified) on this page, left out. */
  hidden: number;
  nextSkip: number;
  hasMore: boolean;
  from: number;
  to: number;
}

interface AuditRow {
  id: string;
  adminEmail: string;
  paymentId: string;
  amount: number;
  currency: string;
  reason: string | null;
  foreign: boolean;
  status: string;
  refundId: string | null;
  error: string | null;
  createdAt: string;
}

/** Ids per bulk request: about 1-2 s each at Razorpay, well inside the proxy timeout. */
const BULK_CHUNK = 20;

const errorText = async (res: Response) => {
  const body = await res.json().catch(() => ({} as any));
  const msg = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
  return msg || `Request failed (${res.status})`;
};

const useRefundPayments = (scope: string, lookup: string) => {
  const fetch = useFetch();
  return useSWR<PaymentsPage>(
    `/admin/refunds/payments?scope=${scope}${
      lookup ? `&paymentId=${encodeURIComponent(lookup)}` : ''
    }`,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(await errorText(res));
      return res.json();
    },
    { revalidateOnFocus: false }
  );
};

const useRefundHistory = (scope: string) => {
  const fetch = useFetch();
  return useSWR<HistoryPage>(
    `/admin/refunds/history?scope=${scope}`,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(await errorText(res));
      return res.json();
    },
    { revalidateOnFocus: false }
  );
};

const useRefundAudit = () => {
  const fetch = useFetch();
  return useSWR<{ available: boolean; rows: AuditRow[] }>(
    '/admin/refunds/audit?limit=50',
    async (url: string) => {
      const res = await fetch(url);
      return res.ok ? res.json() : { available: false, rows: [] };
    },
    { revalidateOnFocus: false }
  );
};

const Chip: FC<{ cls: string; children: React.ReactNode; title?: string }> = ({
  cls,
  children,
  title,
}) => (
  <span
    title={title}
    className={`inline-flex w-max items-center rounded-full border px-[7px] py-[1px] text-[10px] font-[700] ${cls}`}
  >
    {children}
  </span>
);

const ProductChip: FC<{ p: Pick<RefundPayment, 'hookpost' | 'service'> }> = ({ p }) =>
  p.hookpost ? (
    <Chip cls="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40">
      {p.service === 'hookpost-test' ? 'Hookpost test' : 'Hookpost'}
    </Chip>
  ) : (
    <Chip
      cls="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40"
      title="Not identified as Hookpost's. Refunding it needs the foreign-product confirmation."
    >
      {p.service ? `Other: ${p.service}` : 'Unknown product'}
    </Chip>
  );

const StatusChip: FC<{ status: string }> = ({ status }) => (
  <Chip
    cls={
      status === 'refunded'
        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40'
        : status === 'refused'
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40'
        : 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40'
    }
  >
    {status.toUpperCase()}
  </Chip>
);

const GREEN = 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40';
const AMBER = 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40';
const RED = 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40';
const GREY = 'bg-white/5 text-textColor border-newTableBorder';
const SKY = 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40';

/** Fully refunded / Partly refunded (₹x of ₹y, ₹z left) / Not refunded. */
const RefundBadge: FC<{ p: RefundPayment }> = ({ p }) => {
  const state = refundState(p);
  return (
    <div className="flex flex-col gap-[3px]">
      <Chip
        cls={
          state.kind === 'full'
            ? GREEN
            : state.kind === 'partial'
            ? AMBER
            : state.kind === 'none'
            ? SKY
            : GREY
        }
        title={
          state.kind === 'unpaid'
            ? 'Nothing was charged, so there is nothing to refund.'
            : undefined
        }
      >
        {state.label}
      </Chip>
      {state.detail && <div className="text-[11px] opacity-70 whitespace-nowrap">{state.detail}</div>}
    </div>
  );
};

const RefundStatusChip: FC<{ status: string }> = ({ status }) => (
  <Chip
    cls={status === 'processed' ? GREEN : status === 'failed' ? RED : AMBER}
    title={
      status === 'pending'
        ? 'Sent to the bank: it reaches the customer in 5–7 working days.'
        : status === 'failed'
        ? 'The bank could not process it: no money went back.'
        : 'Done: the bank has credited the customer.'
    }
  >
    {refundStatusLabel(status)}
  </Chip>
);

const MadeFromChip: FC<{ r: RefundHistoryRow }> = ({ r }) => (
  <Chip
    cls={r.madeFrom === 'tool' ? SKY : r.madeFrom === 'dashboard' ? AMBER : GREY}
    title={
      r.madeFrom === 'tool'
        ? 'Made from this page.'
        : r.madeFrom === 'dashboard'
        ? "Made from the Razorpay dashboard's refund form."
        : "Not made here or from the dashboard's refund form: Razorpay's own automatic refund (the ₹5 UPI mandate check, say) or another integration."
    }
  >
    {madeFromLabel(r)}
  </Chip>
);

/** Centred dialog on <body>, like the journey drawer in admin-users. */

/**
 * Super-admin refunds: Razorpay payments of the last 180 days, refunded through
 * Razorpay's Refund API from here (one, or many at once) instead of clicking
 * through the Razorpay dashboard. Only Hookpost's own payments by default;
 * the account is shared with other products. Every request is audited.
 */
export const AdminRefundsComponent: FC = () => {
  const user = useUser();
  const fetch = useFetch();
  const toaster = useToaster();

  const [scope, setScope] = useState<'hookpost' | 'all'>('hookpost');
  const [onlyRefundable, setOnlyRefundable] = useState(true);
  const [lookupInput, setLookupInput] = useState('');
  const [lookup, setLookup] = useState('');
  const [extra, setExtra] = useState<RefundPayment[]>([]);
  const [cursor, setCursor] = useState<{ nextSkip: number; hasMore: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [single, setSingle] = useState<RefundPayment | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [results, setResults] = useState<RefundResult[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  // Refunds made on this page since it loaded: payment id -> its amount
  // refunded after them, and their history rows until Razorpay lists them.
  const [localRefunds, setLocalRefunds] = useState<Record<string, number>>({});
  const [localHistory, setLocalHistory] = useState<RefundHistoryRow[]>([]);
  const [historyExtra, setHistoryExtra] = useState<RefundHistoryRow[]>([]);
  const [historyCursor, setHistoryCursor] = useState<{
    nextSkip: number;
    hasMore: boolean;
    hidden: number;
  } | null>(null);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);

  const { data, error, isLoading, mutate } = useRefundPayments(scope, lookup);
  const { data: audit, mutate: mutateAudit } = useRefundAudit();
  const {
    data: history,
    error: historyError,
    isLoading: historyLoading,
    mutate: mutateHistory,
  } = useRefundHistory(scope);

  // A new first page (scope, lookup, refresh) starts the list over. A refund
  // made here that the server now counts is the server's to report from then
  // on (so a refund the bank later fails shows as refundable again).
  useEffect(() => {
    setExtra([]);
    setCursor(data ? { nextSkip: data.nextSkip, hasMore: data.hasMore } : null);
    if (!data?.payments) return;
    const server = new Map(data.payments.map((p) => [p.id, p.amountRefunded]));
    setLocalRefunds((prev) => {
      const kept = Object.fromEntries(
        Object.entries(prev).filter(([id, total]) => !(server.has(id) && server.get(id)! >= total))
      );
      return Object.keys(kept).length === Object.keys(prev).length ? prev : kept;
    });
  }, [data]);

  // Same for the history: a new first page drops the pages loaded after it.
  useEffect(() => {
    setHistoryExtra([]);
    setHistoryCursor(
      history?.refunds
        ? { nextSkip: history.nextSkip, hasMore: history.hasMore, hidden: history.hidden }
        : null
    );
  }, [history]);

  /** Every payment loaded, with the refunds made here since folded in. */
  const loaded = useMemo(() => {
    const seen = new Set<string>();
    return [...(data?.payments || []), ...extra]
      .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
      .map((p) => withLocalRefund(p, localRefunds[p.id]));
  }, [data, extra, localRefunds]);
  const loadedById = useMemo(() => new Map(loaded.map((p) => [p.id, p])), [loaded]);

  const payments = useMemo(
    () => loaded.filter((p) => !onlyRefundable || p.refundable > 0),
    [loaded, onlyRefundable]
  );

  const historyRows = useMemo(
    () => mergeHistory([...(history?.refunds || []), ...historyExtra], localHistory, scope),
    [history, historyExtra, localHistory, scope]
  );

  const byId = useMemo(() => new Map(payments.map((p) => [p.id, p])), [payments]);
  const chosen = useMemo(
    () => [...selected].map((id) => byId.get(id)).filter(Boolean) as RefundPayment[],
    [selected, byId]
  );

  const loadMore = useCallback(async () => {
    if (!data || !cursor?.hasMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/admin/refunds/payments?scope=${scope}&skip=${cursor.nextSkip}&to=${data.to}`
      );
      if (!res.ok) throw new Error(await errorText(res));
      const page: PaymentsPage = await res.json();
      setExtra((e) => [...e, ...page.payments]);
      setCursor({ nextSkip: page.nextSkip, hasMore: page.hasMore });
    } catch (e: any) {
      toaster.show(e.message || 'Could not load more payments', 'warning');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, data, fetch, scope, toaster]);

  const loadMoreHistory = useCallback(async () => {
    if (!history || !historyCursor?.hasMore) return;
    setLoadingMoreHistory(true);
    try {
      const res = await fetch(
        `/admin/refunds/history?scope=${scope}&skip=${historyCursor.nextSkip}&to=${history.to}`
      );
      if (!res.ok) throw new Error(await errorText(res));
      const page: HistoryPage = await res.json();
      setHistoryExtra((e) => [...e, ...page.refunds]);
      setHistoryCursor((c) => ({
        nextSkip: page.nextSkip,
        hasMore: page.hasMore,
        hidden: (c?.hidden || 0) + page.hidden,
      }));
    } catch (e: any) {
      toaster.show(e.message || 'Could not load more refunds', 'warning');
    } finally {
      setLoadingMoreHistory(false);
    }
  }, [fetch, history, historyCursor, scope, toaster]);

  const reload = useCallback(() => {
    setSelected(new Set());
    mutate();
    mutateAudit();
    mutateHistory();
  }, [mutate, mutateAudit, mutateHistory]);

  /** Show refunds that went through at once, in their rows and the history. */
  const recordResults = useCallback(
    (done: RefundResult[]) => {
      setLocalRefunds((prev) =>
        nextLocalRefunds(prev, done, (id) => loadedById.get(id)?.amountRefunded || 0)
      );
      setLocalHistory((prev) => [
        ...historyRowsFromResults(done, (id) => loadedById.get(id), user?.email || null),
        ...prev,
      ]);
    },
    [loadedById, user]
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const selectable = payments.filter((p) => p.refundable > 0);
  const allSelected = selectable.length > 0 && selectable.every((p) => selected.has(p.id));

  const refundOne = useCallback(
    async (body: {
      paymentId: string;
      amount?: number;
      reason?: string;
      confirmForeign?: boolean;
      duplicate?: boolean;
    }) => {
      const res = await fetch('/admin/refunds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await errorText(res));
      const result: RefundResult = await res.json();
      setResults([result]);
      recordResults([result]);
      toaster.show(
        result.status === 'refunded'
          ? `Refunded ${money(result.amount || 0, result.currency || '')} (${result.refundId})`
          : `Not refunded: ${result.error}`,
        result.status === 'refunded' ? 'success' : 'warning'
      );
      reload();
    },
    [fetch, recordResults, reload, toaster]
  );

  const refundMany = useCallback(
    async (ids: string[], opts: { reason?: string; confirmForeign?: boolean; full?: boolean }) => {
      const all: RefundResult[] = [];
      setResults([]);
      try {
        for (let i = 0; i < ids.length; i += BULK_CHUNK) {
          setProgress(`Refunding ${Math.min(i + BULK_CHUNK, ids.length)} of ${ids.length}…`);
          const res = await fetch('/admin/refunds/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentIds: ids.slice(i, i + BULK_CHUNK), ...opts }),
          });
          if (!res.ok) throw new Error(await errorText(res));
          const out: { results: RefundResult[] } = await res.json();
          all.push(...out.results);
          setResults([...all]);
        }
        const ok = all.filter((r) => r.status === 'refunded').length;
        toaster.show(
          `${ok} of ${ids.length} refunded`,
          ok === ids.length ? 'success' : 'warning'
        );
      } catch (e: any) {
        toaster.show(
          `Stopped after ${all.length} of ${ids.length}: ${e.message}. The results below are what happened.`,
          'warning'
        );
      } finally {
        recordResults(all);
        setProgress(null);
        reload();
      }
    },
    [fetch, recordResults, reload, toaster]
  );

  if (!user?.isSuperAdmin) {
    return (
      <div className="border border-newTableBorder rounded-[8px] p-[24px] text-center opacity-70">
        You are not authorized to view the Super Admin panel.
      </div>
    );
  }

  const summary = {
    refunded: results.filter((r) => r.status === 'refunded'),
    refused: results.filter((r) => r.status === 'refused').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };
  const refundedTotals: Record<string, number> = {};
  summary.refunded.forEach((r) => {
    if (r.currency) refundedTotals[r.currency] = (refundedTotals[r.currency] || 0) + (r.amount || 0);
  });

  return (
    <div className="flex flex-col gap-[20px] max-w-[1400px] w-full min-w-0 mx-auto">
      <AdminHeader
        icon="💸"
        title="Refunds"
        subtitle={"Razorpay payments of the last 180 days, refunded through Razorpay's Refund API. Only Hookpost's own payments unless you switch to all products. Every refund is recorded with your name."}
      />

      {audit && !audit.available && (
        <div className="rounded-[8px] border border-amber-500/30 bg-amber-500/10 px-[14px] py-[10px] text-[13px] text-amber-700 dark:text-amber-300">
          The refund audit table is not there yet, so every refund is refused.
          Apply refund-audit.migration.sql to the database first.
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap gap-[12px] items-end justify-between bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[12px]">
        <div className="flex flex-wrap gap-[12px] items-end">
          <div className="flex items-center gap-[6px]">
            {(['hookpost', 'all'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setScope(s);
                  setSelected(new Set());
                }}
                className={`px-[12px] h-[38px] rounded-[8px] text-[12px] font-[600] transition-all ${
                  scope === s
                    ? 'bg-forth text-hp-on-primary border border-forth'
                    : 'bg-newBgColor border border-newTableBorder text-textColor hover:bg-white/5'
                }`}
              >
                {s === 'hookpost' ? 'Hookpost payments' : 'All products'}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-[6px] h-[38px] text-[13px]">
            <input
              type="checkbox"
              checked={onlyRefundable}
              onChange={(e) => setOnlyRefundable(e.target.checked)}
            />
            Only refundable
          </label>
          <form
            className="flex items-center gap-[6px] w-full sm:w-auto"
            onSubmit={(e) => {
              e.preventDefault();
              setSelected(new Set());
              setLookup(lookupInput.trim());
            }}
          >
            <input
              value={lookupInput}
              onChange={(e) => setLookupInput(e.target.value)}
              placeholder="Find a payment id (pay_…)"
              className={`${inputCls} flex-1 min-w-0 sm:flex-none sm:w-[230px] font-mono`}
            />
            <button
              type="submit"
              className="px-[12px] h-[38px] rounded-[8px] text-[12px] font-[600] bg-newBgColor border border-newTableBorder hover:bg-white/5"
            >
              Find
            </button>
            {lookup && (
              <button
                type="button"
                onClick={() => {
                  setLookup('');
                  setLookupInput('');
                }}
                className="text-[12px] underline opacity-70 hover:opacity-100"
              >
                Clear
              </button>
            )}
          </form>
        </div>
        <div className="flex items-center gap-[8px]">
          {selected.size > 0 && (
            <button
              type="button"
              disabled={!!progress}
              onClick={() => setBulkOpen(true)}
              className="h-[38px] px-[16px] rounded-[8px] bg-red-600 hover:bg-red-500 text-white text-[13px] font-[600] disabled:opacity-50"
            >
              Refund selected ({selected.size})
            </button>
          )}
          <Button secondary onClick={reload}>
            🔄 Refresh
          </Button>
        </div>
      </div>

      {progress && (
        <div className="rounded-[8px] border border-newTableBorder bg-newBgColorInner px-[14px] py-[10px] text-[13px] text-textColor">
          {progress} Keep this tab open.
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <section className="border border-newTableBorder rounded-[12px] bg-newBgColorInner overflow-hidden">
          <div className="px-[16px] py-[12px] flex flex-wrap gap-[12px] items-center justify-between border-b border-newTableBorder">
            <h2 className="text-[15px] font-[700] text-textColor">Result</h2>
            <div className="text-[13px]">
              <b className="text-emerald-700 dark:text-emerald-300">{summary.refunded.length} refunded</b>{' '}
              ({moneyTotals(refundedTotals)}) ·{' '}
              <span className="text-amber-700 dark:text-amber-300">{summary.refused} refused</span> ·{' '}
              <span className="text-red-700 dark:text-red-300">{summary.failed} failed</span>
            </div>
          </div>
          <div className="overflow-x-auto max-h-[320px]">
            <table className="w-full text-left text-[13px]">
              <tbody className="divide-y divide-newTableBorder">
                {results.map((r) => (
                  <tr key={r.paymentId}>
                    <td className="py-[8px] px-[16px] font-mono">{r.paymentId}</td>
                    <td className="py-[8px] px-[16px]">
                      <StatusChip status={r.status} />
                    </td>
                    <td className="py-[8px] px-[16px] whitespace-nowrap">
                      {r.amount ? money(r.amount, r.currency || '') : ''}
                    </td>
                    <td className="py-[8px] px-[16px] font-mono opacity-80">
                      {r.refundId ? `${r.refundId} (${r.refundStatus})` : ''}
                    </td>
                    <td className="py-[8px] px-[16px] opacity-80">{r.error || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Payments */}
      {isLoading ? (
        <LoadingComponent />
      ) : error ? (
        <div className="text-red-400 p-[20px] bg-red-950/20 border border-red-800 rounded-[8px]">
          Could not load payments: {error.message}
        </div>
      ) : payments.length === 0 ? (
        <div className="border border-newTableBorder rounded-[12px] p-[36px] text-center opacity-70 bg-newBgColorInner">
          {lookup
            ? 'That payment has nothing left to refund.'
            : `No ${onlyRefundable ? 'refundable ' : ''}${
                scope === 'hookpost' ? 'Hookpost ' : ''
              }payments in the ${data?.scanned ?? 0} scanned so far.`}
        </div>
      ) : (
        <div className="border border-newTableBorder rounded-[12px] overflow-hidden bg-newBgColorInner shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-newBgColorInner text-[12px] uppercase opacity-75 border-b border-newTableBorder tracking-wider">
                  <th className="py-[12px] px-[16px] w-[36px]">
                    <input
                      type="checkbox"
                      aria-label="Select all refundable"
                      checked={allSelected}
                      onChange={() =>
                        setSelected(allSelected ? new Set() : new Set(selectable.map((p) => p.id)))
                      }
                    />
                  </th>
                  <th className="py-[12px] px-[16px]">Payment</th>
                  <th className="py-[12px] px-[16px]">Customer</th>
                  <th className="py-[12px] px-[16px]">Product</th>
                  <th className="py-[12px] px-[16px]">Amount</th>
                  <th className="py-[12px] px-[16px]">Refunded</th>
                  <th className="py-[12px] px-[16px] text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-newTableBorder text-[13px]">
                {payments.map((p) => (
                  <tr key={p.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-[12px] px-[16px]">
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.id}`}
                        disabled={p.refundable <= 0}
                        checked={selected.has(p.id)}
                        onChange={() => toggle(p.id)}
                      />
                    </td>
                    <td className="py-[12px] px-[16px]">
                      <div className="font-mono text-textColor">{p.id}</div>
                      <div className="text-[11px] opacity-60">
                        {dayjs(p.createdAt).format('D MMM YYYY, HH:mm')}
                        {p.method ? ` · ${p.method}` : ''}
                        {p.international ? ' · international' : ''}
                      </div>
                    </td>
                    <td className="py-[12px] px-[16px]">
                      <div className="text-textColor break-all">{p.email || '—'}</div>
                      <div className="text-[11px] opacity-60">
                        {p.organizationName || p.description || ''}
                      </div>
                    </td>
                    <td className="py-[12px] px-[16px]">
                      <ProductChip p={p} />
                    </td>
                    <td className="py-[12px] px-[16px] whitespace-nowrap">
                      <div className="text-textColor font-[600]">{money(p.amount, p.currency)}</div>
                    </td>
                    <td className="py-[12px] px-[16px]" data-testid={`refund-state-${p.id}`}>
                      <RefundBadge p={p} />
                    </td>
                    <td className="py-[12px] px-[16px] text-right">
                      {p.refundable > 0 ? (
                        <button
                          type="button"
                          disabled={!!progress}
                          onClick={() => setSingle(p)}
                          className="px-[12px] py-[6px] rounded-[6px] text-[12px] font-[600] bg-red-600/80 hover:bg-red-500 text-white disabled:opacity-50"
                        >
                          Refund
                        </button>
                      ) : (
                        <span className="opacity-40 text-[12px]">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cursor?.hasMore && !lookup && (
            <div className="p-[12px] border-t border-newTableBorder flex justify-center">
              <Button secondary loading={loadingMore} onClick={loadMore}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Refund history */}
      <section className="flex flex-col gap-[8px]" data-testid="refund-history">
        <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
          <h2 className="text-[15px] font-[700] text-textColor">Refund history</h2>
          <p className="text-[12px] opacity-70">
            Every refund of the last 180 days, wherever it was made: here, in the
            Razorpay dashboard, or by Razorpay itself.
            {scope === 'hookpost' && (historyCursor?.hidden || 0) > 0
              ? ` ${historyCursor!.hidden} of another product or unidentified hidden; switch to All products to see them.`
              : ''}
          </p>
        </div>
        {historyLoading ? (
          <LoadingComponent />
        ) : historyError ? (
          <div className="text-red-400 p-[12px] bg-red-950/20 border border-red-800 rounded-[8px] text-[13px]">
            Could not load the refund history: {historyError.message}
          </div>
        ) : historyRows.length === 0 ? (
          <div className="border border-newTableBorder rounded-[10px] p-[20px] text-center opacity-70 bg-newBgColorInner text-[13px]">
            No {scope === 'hookpost' ? 'Hookpost ' : ''}refunds in the last 180 days
            {historyCursor?.hasMore ? ' on the pages scanned so far' : ''}.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-[10px] border border-newTableBorder bg-newBgColorInner">
            <table className="w-full text-left text-[12px]">
              <thead className="opacity-60">
                <tr>
                  {['When', 'Refund', 'Customer', 'Product', 'Amount', 'Status', 'Made from'].map((h) => (
                    <th key={h} className="px-[12px] py-[8px] font-[500]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-newTableBorder">
                {historyRows.map((r) => (
                  <tr key={r.id} data-testid={`refund-row-${r.id}`}>
                    <td className="px-[12px] py-[6px] whitespace-nowrap">
                      {dayjs(r.createdAt).format('D MMM YYYY, HH:mm')}
                    </td>
                    <td className="px-[12px] py-[6px]">
                      <div className="font-mono text-textColor">{r.id}</div>
                      <div className="font-mono text-[11px] opacity-60">
                        {r.paymentId}
                        {r.reference ? ` · ref ${r.reference}` : ''}
                      </div>
                    </td>
                    <td className="px-[12px] py-[6px]">
                      <div className="text-textColor break-all">{r.email || '—'}</div>
                      <div className="text-[11px] opacity-60">
                        {r.organizationName || r.description || ''}
                      </div>
                    </td>
                    <td className="px-[12px] py-[6px]">
                      {r.paymentFound ? (
                        <ProductChip p={r} />
                      ) : (
                        <span className="opacity-60" title="Razorpay did not return this payment.">
                          Unknown payment
                        </span>
                      )}
                    </td>
                    <td className="px-[12px] py-[6px] whitespace-nowrap">
                      <div className="text-textColor font-[600]">{money(r.amount, r.currency)}</div>
                      {r.paymentAmount !== null && (
                        <div className="text-[11px] opacity-60">
                          of {money(r.paymentAmount, r.currency)}
                        </div>
                      )}
                    </td>
                    <td className="px-[12px] py-[6px]">
                      <RefundStatusChip status={r.status} />
                    </td>
                    <td className="px-[12px] py-[6px]">
                      <MadeFromChip r={r} />
                      {(r.madeBy || r.reason) && (
                        <div className="text-[11px] opacity-60 mt-[3px]">
                          {[r.madeBy, r.reason].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* Also under an empty first page: a page of other products' refunds
            only must not hide Hookpost's older ones. */}
        {!historyLoading && !historyError && historyCursor?.hasMore && (
          <div className="flex justify-center">
            <Button secondary loading={loadingMoreHistory} onClick={loadMoreHistory}>
              Load more refunds
            </Button>
          </div>
        )}
      </section>

      {/* Audit */}
      {audit?.available && audit.rows.length > 0 && (
        <section className="flex flex-col gap-[8px]">
          <h2 className="text-[15px] font-[700] text-textColor">Recent refund actions</h2>
          <div className="overflow-x-auto rounded-[10px] border border-newTableBorder bg-newBgColorInner">
            <table className="w-full text-left text-[12px]">
              <thead className="opacity-60">
                <tr>
                  {['When', 'Who', 'Payment', 'Amount', 'Result', ''].map((h) => (
                    <th key={h} className="px-[12px] py-[8px] font-[500]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-newTableBorder">
                {audit.rows.map((a) => (
                  <tr key={a.id}>
                    <td className="px-[12px] py-[6px] whitespace-nowrap">
                      {dayjs(a.createdAt).format('D MMM, HH:mm:ss')}
                    </td>
                    <td className="px-[12px] py-[6px]">{a.adminEmail}</td>
                    <td className="px-[12px] py-[6px] font-mono">{a.paymentId}</td>
                    <td className="px-[12px] py-[6px] whitespace-nowrap">
                      {a.amount ? money(a.amount, a.currency) : ''}
                    </td>
                    <td className="px-[12px] py-[6px]">
                      {a.status}
                      {a.foreign ? ' · foreign' : ''}
                      {a.refundId ? ` · ${a.refundId}` : ''}
                    </td>
                    <td className="px-[12px] py-[6px] opacity-70">{a.error || a.reason || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {single && (
        <RefundOneDialog
          payment={single}
          onClose={() => setSingle(null)}
          onConfirm={async (body) => {
            await refundOne(body);
            setSingle(null);
          }}
        />
      )}

      {bulkOpen && (
        <RefundManyDialog
          payments={chosen}
          onClose={() => setBulkOpen(false)}
          onConfirm={(opts) => {
            setBulkOpen(false);
            refundMany(
              chosen.map((p) => p.id),
              opts
            );
          }}
        />
      )}
    </div>
  );
};

const RefundOneDialog: FC<{
  payment: RefundPayment;
  onClose: () => void;
  onConfirm: (body: {
    paymentId: string;
    amount?: number;
    reason?: string;
    confirmForeign?: boolean;
    duplicate?: boolean;
  }) => Promise<void>;
}> = ({ payment, onClose, onConfirm }) => {
  const toaster = useToaster();
  // Our mistake (a charge after cancel, a double charge): refund it all.
  const [full, setFull] = useState(false);
  const [amount, setAmount] = useState((defaultRefundMinor(payment, false) / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const [foreign, setForeign] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);
  const fee = payment.fee || 0;

  const minor = Math.round(parseFloat(amount) * 100);
  const valid = Number.isFinite(minor) && minor >= 1 && minor <= payment.refundable;
  const canSend = valid && (payment.hookpost || foreign) && !busy;

  return (
    <Dialog title="Refund this payment?" onClose={busy ? () => undefined : onClose}>
      <div className="grid grid-cols-[120px_1fr] gap-y-[6px]">
        <span className="opacity-60">Payment</span>
        <span className="font-mono text-textColor">{payment.id}</span>
        <span className="opacity-60">Customer</span>
        <span className="text-textColor break-all">{payment.email || '—'}</span>
        <span className="opacity-60">Workspace</span>
        <span className="text-textColor">{payment.organizationName || '—'}</span>
        <span className="opacity-60">Paid</span>
        <span className="text-textColor">
          {money(payment.amount, payment.currency)} · {dayjs(payment.createdAt).format('D MMM YYYY')}
        </span>
        <span className="opacity-60">Razorpay fee</span>
        <span className="text-textColor" data-testid="refund-fee">
          {fee > 0
            ? `${money(fee, payment.currency)} (GST ${money(payment.tax || 0, payment.currency)} included)`
            : 'Not on the payment yet'}
        </span>
        <span className="opacity-60">Less the fee</span>
        <span className="text-textColor font-[700]" data-testid="refund-after-fee">
          {money(defaultRefundMinor(payment, false), payment.currency)}
        </span>
        <span className="opacity-60">Full</span>
        <span className="text-textColor">{money(payment.refundable, payment.currency)}</span>
        <span className="opacity-60">Product</span>
        <span>
          <ProductChip p={payment} />
        </span>
      </div>

      <label className="flex items-start gap-[8px] rounded-[8px] border border-newTableBorder p-[10px]">
        <input
          type="checkbox"
          checked={full}
          onChange={(e) => {
            setFull(e.target.checked);
            setAmount((defaultRefundMinor(payment, e.target.checked) / 100).toFixed(2));
          }}
          className="mt-[3px]"
          aria-label="Full refund, our mistake"
        />
        <span>
          Full refund, fee included. Only for our mistake: a charge after
          cancel, or a double charge. Otherwise refunds are at our discretion
          and the Razorpay fee and its GST are deducted.
        </span>
      </label>

      <Field label={`Amount to refund (${payment.currency})`}>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          className={inputCls}
        />
      </Field>
      {!valid && (
        <div className="text-red-700 dark:text-red-300 text-[12px]">
          Enter an amount between {money(1, payment.currency)} and{' '}
          {money(payment.refundable, payment.currency)}.
        </div>
      )}
      <Field label="Reason (optional, saved with the refund)">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
          className={inputCls}
        />
      </Field>

      {!payment.hookpost && (
        <label className="flex items-start gap-[8px] rounded-[8px] border border-amber-500/30 bg-amber-500/10 p-[10px] text-amber-700 dark:text-amber-200">
          <input
            type="checkbox"
            checked={foreign}
            onChange={(e) => setForeign(e.target.checked)}
            className="mt-[3px]"
          />
          <span>
            Confirm foreign product payment: this payment is not marked as
            Hookpost&apos;s ({payment.service || 'no product tag'}). Refund it anyway.
          </span>
        </label>
      )}

      <label className="flex items-start gap-[8px] rounded-[8px] border border-newTableBorder p-[10px]">
        <input
          type="checkbox"
          checked={duplicate}
          onChange={(e) => setDuplicate(e.target.checked)}
          className="mt-[3px]"
        />
        <span>
          This was a duplicate charge. The customer is emailed that we charged
          them twice and have refunded it, and the owner is alerted. Leave this
          off for an ordinary refund: Razorpay&apos;s refund webhook already
          sends the normal refund email.
        </span>
      </label>

      <div className="text-[12px] opacity-70">
        Money goes back to the customer&apos;s card/UPI/bank in 5–7 working days.
        This cannot be undone.
        {payment.subscriptionId
          ? ' Refunding a charge does not cancel the subscription: it keeps renewing unless it is cancelled too.'
          : ''}
      </div>

      <div className="flex justify-end gap-[8px]">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="h-[38px] px-[16px] rounded-[8px] border border-newTableBorder text-[13px]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSend}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm({
                paymentId: payment.id,
                // Always the amount shown: if the payment changed since the
                // list loaded, the server refuses rather than refund another figure.
                amount: minor,
                reason: reason.trim() || undefined,
                confirmForeign: !payment.hookpost ? foreign : undefined,
                duplicate: duplicate || undefined,
              });
            } catch (e: any) {
              toaster.show(e.message || 'Refund failed', 'warning');
              setBusy(false);
            }
          }}
          className="h-[38px] px-[16px] rounded-[8px] bg-red-600 hover:bg-red-500 text-white text-[13px] font-[600] disabled:opacity-50"
        >
          {busy ? 'Refunding…' : `Refund ${valid ? money(minor, payment.currency) : ''}`}
        </button>
      </div>
    </Dialog>
  );
};

const RefundManyDialog: FC<{
  payments: RefundPayment[];
  onClose: () => void;
  onConfirm: (opts: { reason?: string; confirmForeign?: boolean; full?: boolean }) => void;
}> = ({ payments, onClose, onConfirm }) => {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [foreign, setForeign] = useState(false);
  const [full, setFull] = useState(false);

  const foreignCount = payments.filter((p) => !p.hookpost).length;
  const totals: Record<string, number> = {};
  payments.forEach(
    (p) => (totals[p.currency] = (totals[p.currency] || 0) + defaultRefundMinor(p, full))
  );
  const canSend = typed === 'REFUND' && payments.length > 0 && (foreignCount === 0 || foreign);

  return (
    <Dialog
      title={`Refund ${payments.length} payments${full ? ' in full' : ', less the fee'}?`}
      onClose={onClose}
    >
      <div className="grid grid-cols-[120px_1fr] gap-y-[6px]">
        <span className="opacity-60">Payments</span>
        <span className="text-textColor">{payments.length}</span>
        <span className="opacity-60">Total</span>
        <span className="text-textColor font-[700]">{moneyTotals(totals)}</span>
        <span className="opacity-60">Customers</span>
        <span className="text-textColor break-all">
          {[...new Set(payments.map((p) => p.email).filter(Boolean))].slice(0, 5).join(', ')}
          {new Set(payments.map((p) => p.email).filter(Boolean)).size > 5 ? ', …' : ''}
        </span>
      </div>
      <div className="text-[12px] opacity-70">
        Each one is refunded for what is still refundable on it less
        Razorpay&apos;s fee and its GST (or all of it with the box below
        ticked), checked again at Razorpay just before. Sent {BULK_CHUNK} at a time; one that is
        refused or fails does not stop the rest.
      </div>

      <Field label="Reason (optional, saved with each refund)">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
          className={inputCls}
        />
      </Field>

      {foreignCount > 0 && (
        <label className="flex items-start gap-[8px] rounded-[8px] border border-amber-500/30 bg-amber-500/10 p-[10px] text-amber-700 dark:text-amber-200">
          <input
            type="checkbox"
            checked={foreign}
            onChange={(e) => setForeign(e.target.checked)}
            className="mt-[3px]"
          />
          <span>
            Confirm foreign product payment: {foreignCount} of these are not
            marked as Hookpost&apos;s. Refund them anyway.
          </span>
        </label>
      )}

      <label className="flex items-start gap-[8px] rounded-[8px] border border-newTableBorder p-[10px]">
        <input
          type="checkbox"
          checked={full}
          onChange={(e) => setFull(e.target.checked)}
          className="mt-[3px]"
          aria-label="Full refund for every payment, our mistake"
        />
        <span>
          Full refunds, fee included: only for our mistake (charges after
          cancel, double charges).
        </span>
      </label>

      <Field label="Type REFUND to confirm">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          className={`${inputCls} font-mono`}
        />
      </Field>

      <div className="flex justify-end gap-[8px]">
        <button
          type="button"
          onClick={onClose}
          className="h-[38px] px-[16px] rounded-[8px] border border-newTableBorder text-[13px]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSend}
          onClick={() =>
            onConfirm({
              reason: reason.trim() || undefined,
              confirmForeign: foreignCount > 0 ? foreign : undefined,
              ...(full ? { full: true } : {}),
            })
          }
          className="h-[38px] px-[16px] rounded-[8px] bg-red-600 hover:bg-red-500 text-white text-[13px] font-[600] disabled:opacity-50"
        >
          Refund {payments.length}
        </button>
      </div>
    </Dialog>
  );
};
