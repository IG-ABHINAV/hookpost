'use client';

import React, { FC, useState } from 'react';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useToaster } from '@hookpost/react/toaster/toaster';
import {
  Dialog,
  Field,
  inputCls,
} from '@hookpost/frontend/components/admin/admin.dialog';

/** The same minimum the DTO enforces (admin.plan.action.dto.ts). */
const REASON_MIN = 10;
const REASON_MAX = 200;

/** Which correction email an ending sends; the values the endpoint accepts. */
const END_CORRECTIONS: Array<{ value: string; label: string; help: string }> = [
  {
    value: 'PLAN_CORRECTED_ENDED',
    label: 'Our records showed a plan that had ended',
    help: 'A plan cancelled before its first charge, or an ended plan, that the workspace kept showing.',
  },
  {
    value: 'REFUND_ENDED_PLAN',
    label: 'A refund should have ended it at the time',
    help: 'We refunded them earlier and left the plan running.',
  },
  {
    value: 'CHARGE_STOPPED',
    label: 'A mandate could still have charged them',
    help: 'The plan had ended but the payment instruction was still live.',
  },
  {
    value: 'NONE',
    label: 'Send the customer nothing',
    help: 'The owner is still alerted and the action is still audited.',
  },
];

const TIERS = ['STANDARD', 'TEAM', 'PRO', 'ULTIMATE'];

export interface PlanActionWorkspace {
  id: string;
  name: string;
  email: string;
  tier?: string | null;
  period?: string | null;
}

/**
 * "End plan now" and "Restore plan" for one workspace (POST /admin/plan/end,
 * /admin/plan/restore). A plan the customer did not change, so the reason is
 * required, the correction email the customer gets is chosen here, and every
 * press is audited server-side.
 */
export const PlanActionDialog: FC<{
  workspace: PlanActionWorkspace;
  /** 'end' when the workspace has a plan on file, 'restore' when it has none. */
  mode: 'end' | 'restore';
  onClose: () => void;
  onDone: () => void;
}> = ({ workspace, mode, onClose, onDone }) => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [reason, setReason] = useState('');
  const [correction, setCorrection] = useState(END_CORRECTIONS[0].value);
  const [tier, setTier] = useState(workspace.tier || 'STANDARD');
  const [period, setPeriod] = useState(workspace.period === 'YEARLY' ? 'YEARLY' : 'MONTHLY');
  const [skipCustomerEmail, setSkipCustomerEmail] = useState(false);
  // A gift's last day (yyyy-mm-dd, India); empty means no end date.
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);

  const ending = mode === 'end';
  const chosen = END_CORRECTIONS.find((c) => c.value === correction);
  const canSend = reason.trim().length >= REASON_MIN && !busy;

  const send = async () => {
    setBusy(true);
    try {
      const res = await fetch(ending ? '/admin/plan/end' : '/admin/plan/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId: workspace.id,
          reason: reason.trim(),
          skipCustomerEmail: skipCustomerEmail || undefined,
          ...(ending
            ? { correction }
            : {
                tier,
                period,
                // The end of that day in India, so "until 3 Feb" means the
                // whole of 3 Feb.
                ...(until ? { until: `${until}T23:59:00+05:30` } : {}),
              }),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        toaster.show(
          json?.reason || json?.message || `Could not ${ending ? 'end' : 'restore'} the plan`,
          'warning'
        );
        setBusy(false);
        return;
      }
      toaster.show(
        `${ending ? 'Plan ended' : 'Plan restored'} for ${workspace.name}. Customer email: ${
          json?.email || 'not sent'
        }.`,
        'success'
      );
      onDone();
    } catch (e: any) {
      toaster.show(e?.message || 'Request failed', 'warning');
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={ending ? 'End this plan now?' : 'Restore this plan?'}
      onClose={busy ? () => undefined : onClose}
    >
      <div className="grid grid-cols-[120px_1fr] gap-y-[6px]">
        <span className="opacity-60">Workspace</span>
        <span className="text-textColor">{workspace.name}</span>
        <span className="opacity-60">Workspace id</span>
        <span className="font-mono text-textColor break-all">{workspace.id}</span>
        <span className="opacity-60">Customer</span>
        <span className="text-textColor break-all">{workspace.email || '—'}</span>
        <span className="opacity-60">Plan on file</span>
        <span className="text-textColor">
          {workspace.tier ? `${workspace.tier} · ${workspace.period || 'MONTHLY'}` : 'None'}
        </span>
      </div>

      <Field label={`Reason (required, at least ${REASON_MIN} characters, kept in the audit log)`}>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={REASON_MAX}
          placeholder={
            ending
              ? 'Cancelled at Razorpay on 21 Oct before the first charge; our row ran to 11 Nov'
              : 'Ended by the sweep on bad facts; the renewal had been paid'
          }
          className={inputCls}
        />
      </Field>

      {ending ? (
        <Field label="What the customer is told">
          <select
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            className={inputCls}
          >
            {END_CORRECTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <div className="flex gap-[10px]">
          <div className="flex-1">
            <Field label="Tier to restore">
              <select value={tier} onChange={(e) => setTier(e.target.value)} className={inputCls}>
                {TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Period">
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className={inputCls}
              >
                <option value="MONTHLY">MONTHLY</option>
                <option value="YEARLY">YEARLY</option>
              </select>
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Free until (a gift; optional)">
              <input
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>
        </div>
      )}

      {ending && chosen && <div className="text-[12px] opacity-70">{chosen.help}</div>}

      <label className="flex items-start gap-[8px] rounded-[8px] border border-newTableBorder p-[10px]">
        <input
          type="checkbox"
          checked={skipCustomerEmail}
          onChange={(e) => setSkipCustomerEmail(e.target.checked)}
          className="mt-[3px]"
        />
        <span>
          Don&apos;t email the customer (an internal or test workspace). One of
          ours is skipped automatically; this covers anything else. The owner
          alert and the audit row still happen.
        </span>
      </label>

      <div className="text-[12px] opacity-70">
        {ending
          ? 'The Razorpay subscription is cancelled if one is still live, and the plan row is removed. Channels and posts are kept. This cannot be undone from here: use Restore plan.'
          : 'The plan row is written back with the tier and period above. No money is taken, and no Razorpay subscription is created: if the customer has no live mandate they are not charged again when it renews.'}
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
          onClick={send}
          className={`h-[38px] px-[16px] rounded-[8px] text-[13px] font-[600] text-white disabled:opacity-40 disabled:cursor-not-allowed ${
            ending ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'
          }`}
        >
          {busy
            ? ending
              ? 'Ending…'
              : 'Restoring…'
            : ending
            ? 'End plan now'
            : 'Restore plan'}
        </button>
      </div>
    </Dialog>
  );
};
