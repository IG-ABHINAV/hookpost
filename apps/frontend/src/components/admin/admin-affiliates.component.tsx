'use client';

import React, { FC, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { AdminHeader } from '@hookpost/frontend/components/admin/admin.header';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { useToaster } from '@hookpost/react/toaster/toaster';
import { LoadingComponent } from '@hookpost/frontend/components/layout/loading';
import {
  money,
  moneyList,
} from '@hookpost/frontend/components/affiliates/affiliate.component';
import {
  AFFILIATE_MAX_COMMISSION_MONTHS,
  AFFILIATE_MAX_COMMISSION_PERCENT,
} from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.terms';

/** Durations offered in the deal editor; 0 is "while partner active". */
const DURATIONS = [3, 6, 12, 24, 36, 0];
const durationLabel = (m: number) => (m === 0 ? 'While partner active' : `${m} months`);

/**
 * One affiliate's deal: percent and duration. Saving applies it to the
 * customers they refer from now on; customers already referred keep the
 * terms they were referred under.
 */
const TermsEditor: FC<{
  id: string;
  percent: number;
  months: number;
  onSaved: () => void;
}> = ({ id, percent, months, onSaved }) => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [p, setP] = useState(String(percent));
  const [m, setM] = useState(months);
  const changed = Number(p) !== percent || m !== months;
  const options = DURATIONS.includes(months) ? DURATIONS : [...DURATIONS, months];
  const save = useCallback(async () => {
    const res = await fetch(`/affiliates/admin/${id}/terms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commissionPercent: Number(p), commissionMonths: m }),
    });
    if (!res.ok) {
      toaster.show('Could not save the terms', 'warning');
      return;
    }
    toaster.show('Terms saved for new referrals', 'success');
    onSaved();
  }, [fetch, id, p, m, onSaved, toaster]);
  return (
    <div className="flex items-center gap-[6px] whitespace-nowrap">
      <input
        type="number"
        min={1}
        max={AFFILIATE_MAX_COMMISSION_PERCENT}
        value={p}
        onChange={(e) => setP(e.target.value)}
        aria-label="Commission percent"
        className="h-[28px] w-[52px] rounded-[6px] bg-newBgColor border border-newTableBorder px-[6px]"
      />
      <span className="opacity-60">%</span>
      <select
        value={m}
        onChange={(e) => setM(Number(e.target.value))}
        aria-label="Commission duration"
        className="h-[28px] rounded-[6px] bg-newBgColor border border-newTableBorder px-[4px]"
      >
        {options
          .filter((x) => x <= AFFILIATE_MAX_COMMISSION_MONTHS)
          .map((x) => (
            <option key={x} value={x}>
              {durationLabel(x)}
            </option>
          ))}
      </select>
      {changed && (
        <button type="button" onClick={save} className="text-[12px] underline">
          Save
        </button>
      )}
    </div>
  );
};

interface Overview {
  affiliates: {
    id: string;
    name: string;
    email: string;
    code: string;
    active: boolean;
    payoutDetails: string | null;
    commissionPercent: number;
    commissionMonths: number;
    referrals: number;
    pending: Record<string, number>;
    paid: Record<string, number>;
    createdAt: string;
  }[];
  pendingCommissions: {
    id: string;
    organizationId: string;
    paymentId: string;
    amount: number;
    commission: number;
    currency: string;
    createdAt: string;
    affiliate: {
      name: string;
      email: string;
      code: string;
      payoutDetails: string | null;
    };
  }[];
}

/**
 * Commissions are paid by hand. This page lists what is owed, grouped by
 * affiliate, with their payout details; after sending the UPI/bank transfer,
 * tick the rows and record it with the transfer reference.
 */
export const AdminAffiliatesComponent: FC = () => {
  const user = useUser();
  const fetch = useFetch();
  const toaster = useToaster();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');

  const { data, isLoading, mutate } = useSWR<Overview>(
    '/affiliates/admin',
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load affiliates');
      return res.json();
    }
  );

  const byAffiliate = useMemo(() => {
    const groups = new Map<string, Overview['pendingCommissions']>();
    for (const c of data?.pendingCommissions || []) {
      const k = c.affiliate.code;
      groups.set(k, [...(groups.get(k) || []), c]);
    }
    return [...groups.entries()];
  }, [data]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const markPaid = useCallback(async () => {
    if (!selected.size) return;
    const res = await fetch('/affiliates/admin/commissions/paid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selected], note: note || undefined }),
    });
    if (!res.ok) {
      toaster.show('Could not record the payout', 'warning');
      return;
    }
    toaster.show(`Marked ${selected.size} commission(s) paid`, 'success');
    setSelected(new Set());
    setNote('');
    mutate();
  }, [fetch, mutate, note, selected, toaster]);

  const voidOne = useCallback(
    async (id: string) => {
      const reason = window.prompt('Why void this commission? (e.g. refunded)');
      if (reason === null) return;
      await fetch(`/affiliates/admin/commissions/${id}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: reason }),
      });
      toaster.show('Commission voided', 'success');
      mutate();
    },
    [fetch, mutate, toaster]
  );

  const setActive = useCallback(
    async (id: string, active: boolean) => {
      await fetch(`/affiliates/admin/${id}/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      mutate();
    },
    [fetch, mutate]
  );

  if (!user?.isSuperAdmin) {
    return (
      <div className="text-textColor p-[20px]">
        This page is for administrators.
      </div>
    );
  }
  if (isLoading || !data) return <LoadingComponent />;

  return (
    <div className="flex flex-col gap-[20px] text-textColor max-w-[1100px] w-full min-w-0 mx-auto">
      <AdminHeader
        icon="🤝"
        title="Affiliates"
        subtitle={
          <>
            {data.affiliates.length} affiliates ·{' '}
            {data.pendingCommissions.length} unpaid commissions. Pay by UPI or
            bank transfer, then record it here.
          </>
        }
      />

      <section className="flex flex-col gap-[12px]">
        <h2 className="text-[16px] font-[700] text-textColor">Owed</h2>
        {byAffiliate.length === 0 && (
          <div className="text-[14px] opacity-70">Nothing owed.</div>
        )}
        {byAffiliate.map(([code, rows]) => {
          const total: Record<string, number> = {};
          rows.forEach(
            (r) => (total[r.currency] = (total[r.currency] || 0) + r.commission)
          );
          return (
            <div
              key={code}
              className="rounded-[10px] border border-newTableBorder bg-newBgColorInner overflow-hidden"
            >
              <div className="px-[14px] py-[10px] flex flex-wrap gap-[8px] justify-between">
                <div>
                  <b className="text-textColor">{rows[0].affiliate.name}</b>{' '}
                  <span className="opacity-60">
                    {rows[0].affiliate.email} · {code}
                  </span>
                  <div className="text-[13px] mt-[2px]">
                    Pay to:{' '}
                    <span className="text-textColor">
                      {rows[0].affiliate.payoutDetails || 'not given yet'}
                    </span>
                  </div>
                </div>
                <div className="text-[18px] font-[700] text-textColor">
                  {moneyList(total)}
                </div>
              </div>
              <table className="w-full text-[13px]">
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-newTableBorder">
                      <td className="px-[14px] py-[8px] w-[32px]">
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={() => toggle(r.id)}
                        />
                      </td>
                      <td className="px-[8px] py-[8px] whitespace-nowrap">
                        {new Date(r.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-[8px] py-[8px] opacity-70">
                        {r.paymentId}
                      </td>
                      <td className="px-[8px] py-[8px]">
                        {money(r.amount, r.currency)} →{' '}
                        <b className="text-textColor">
                          {money(r.commission, r.currency)}
                        </b>
                      </td>
                      <td className="px-[14px] py-[8px] text-right">
                        <button
                          type="button"
                          onClick={() => voidOne(r.id)}
                          className="text-[12px] underline opacity-60 hover:opacity-100"
                        >
                          Void
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
        {selected.size > 0 && (
          <div className="flex gap-[8px] flex-wrap items-center">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Transfer reference (UTR / UPI ref)"
              className="h-[38px] flex-1 min-w-0 sm:min-w-[220px] rounded-[8px] bg-newBgColor border border-newTableBorder px-[10px] text-[14px]"
            />
            <button
              type="button"
              onClick={markPaid}
              disabled={!note.trim()}
              className="h-[38px] px-[16px] rounded-[8px] bg-emerald-600 text-white font-[600] disabled:opacity-50"
            >
              Mark {selected.size} paid
            </button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-[12px]">
        <h2 className="text-[16px] font-[700] text-textColor">All affiliates</h2>
        <div className="overflow-x-auto rounded-[10px] border border-newTableBorder">
          <table className="w-full text-[13px]">
            <thead className="text-left opacity-60 bg-newBgColorInner">
              <tr>
                {['Affiliate', 'Code', 'Terms', 'Sign-ups', 'Owed', 'Paid', ''].map((h) => (
                  <th key={h} className="px-[12px] py-[8px] font-[500]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.affiliates.map((a) => (
                <tr key={a.id} className="border-t border-newTableBorder">
                  <td className="px-[12px] py-[8px]">
                    <div className="text-textColor">{a.name}</div>
                    <div className="opacity-60">{a.email}</div>
                  </td>
                  <td className="px-[12px] py-[8px]">{a.code}</td>
                  <td className="px-[12px] py-[8px]">
                    <TermsEditor
                      key={`${a.commissionPercent}-${a.commissionMonths}`}
                      id={a.id}
                      percent={a.commissionPercent}
                      months={a.commissionMonths}
                      onSaved={() => mutate()}
                    />
                  </td>
                  <td className="px-[12px] py-[8px]">{a.referrals}</td>
                  <td className="px-[12px] py-[8px]">{moneyList(a.pending)}</td>
                  <td className="px-[12px] py-[8px]">{moneyList(a.paid)}</td>
                  <td className="px-[12px] py-[8px] text-right">
                    <button
                      type="button"
                      onClick={() => setActive(a.id, !a.active)}
                      className="text-[12px] underline opacity-70 hover:opacity-100"
                    >
                      {a.active ? 'Pause' : 'Resume'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
