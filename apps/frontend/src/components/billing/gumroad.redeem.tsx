'use client';

import React, { FC, useCallback, useMemo, useState } from 'react';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { useSWRConfig } from 'swr';
import { Subscription } from '@prisma/client';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  planFeatureItems,
  planFeatureLabel,
} from '@hookpost/frontend/components/billing/plan.features';
import {
  GUMROAD_LIBRARY_URL,
  gumroadDate,
  gumroadPlanName,
  redeemedMessage,
  redeemErrorMessage,
} from '@hookpost/frontend/components/billing/gumroad.redeem.copy';

const KeyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="8" cy="15" r="4" stroke="currentColor" strokeWidth="2" />
    <path
      d="m10.8 12.2 9.2-9.2M17 6l3 3M14.5 8.5l2 2"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

/**
 * "Bought on Gumroad? Enter your license key", on Billing and on the trial
 * paywall. Collapsed to a link like the coupon field, so it does not compete
 * with checkout. Shown only while a Gumroad product is configured
 * (/user/self gumroadRedeem) and to the owner and admins, who are the only
 * ones POST /billing/gumroad/redeem accepts. On success /user/self and the
 * plan are read again, which takes the paywall away.
 */
export const GumroadRedeemField: FC<{ className?: string }> = ({ className }) => {
  const t = useT();
  const fetch = useFetch();
  const user = useUser();
  const { mutate } = useSWRConfig();
  const [open, setOpen] = useState(false);
  const [licenseKey, setLicenseKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const redeem = useCallback(async () => {
    const value = licenseKey.trim();
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/billing/gumroad/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: value }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(redeemErrorMessage(res.status, body, t));
        return;
      }
      setDone(redeemedMessage(body, t));
      setLicenseKey('');
      await Promise.all([mutate('/user/subscription'), mutate('/user/self')]);
    } catch {
      setError(redeemErrorMessage(0, null, t));
    } finally {
      setBusy(false);
    }
  }, [licenseKey, busy, fetch, t, mutate]);

  if (
    !user?.gumroadRedeem ||
    (user?.role !== 'ADMIN' && user?.role !== 'SUPERADMIN')
  ) {
    return null;
  }

  if (done) {
    return (
      <div
        role="status"
        className={clsx(
          'rounded-[14px] border border-[#00C48C]/50 bg-[#00C48C]/10 px-[16px] py-[12px] text-[14px] font-[600]',
          className
        )}
      >
        {done}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={clsx(
          'inline-flex w-fit items-center gap-[8px] text-[14px] text-textItemBlur transition-colors hover:text-hp-primary-text',
          className
        )}
      >
        <KeyIcon />
        <span className="underline decoration-dotted underline-offset-4">
          {t('gumroad_redeem_link', 'Bought on Gumroad? Enter your license key')}
        </span>
      </button>
    );
  }

  return (
    <div className={clsx('flex flex-col gap-[6px]', className)}>
      <label htmlFor="gumroad-license-key" className="text-[14px] font-[600]">
        {t('gumroad_redeem_label', 'Gumroad license key')}
      </label>
      <div
        className={clsx(
          'flex h-[48px] items-center gap-[8px] rounded-[14px] border bg-newBgColorInner ps-[14px] pe-[5px] transition-colors focus-within:border-hp-primary',
          error ? 'border-red-400/70' : 'border-newColColor'
        )}
      >
        <span className="text-textItemBlur">
          <KeyIcon />
        </span>
        <input
          id="gumroad-license-key"
          autoFocus
          value={licenseKey}
          onChange={(e) => {
            setLicenseKey(e.target.value);
            setError('');
          }}
          onKeyDown={(e) => e.key === 'Enter' && redeem()}
          placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX"
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!error}
          className="h-full min-w-0 flex-1 bg-transparent font-mono text-[14px] uppercase outline-none placeholder:text-textItemBlur"
        />
        <button
          type="button"
          onClick={redeem}
          disabled={busy || !licenseKey.trim()}
          className="h-[38px] shrink-0 rounded-[10px] bg-hp-primary px-[18px] text-[14px] font-[700] text-hp-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy
            ? t('gumroad_redeem_checking', 'Checking...')
            : t('gumroad_redeem_button', 'Redeem')}
        </button>
      </div>
      {error ? (
        <div role="alert" className="ps-[4px] text-[13px] text-red-400">
          {error}
        </div>
      ) : (
        <div className="ps-[4px] text-[13px] text-textItemBlur">
          {t(
            'gumroad_redeem_hint',
            'The key is in your Gumroad receipt email and in your Gumroad library. One key works on one workspace.'
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Billing for a workspace whose plan is paid on Gumroad. Its plan cards and
 * Cancel would act on Razorpay, which holds nothing for it, so the page says
 * what the plan is and where to change or cancel it, and lists what the plan
 * includes (pricing.ts, the same lines as the plan cards).
 */
export const GumroadPlanPanel: FC<{ sub: Subscription }> = ({ sub }) => {
  const t = useT();
  const plan = gumroadPlanName(sub.subscriptionTier);
  const features = useMemo(
    () =>
      pricing[sub.subscriptionTier]
        ? planFeatureItems(pricing[sub.subscriptionTier]).map((f) =>
            planFeatureLabel(f, t)
          )
        : [],
    [sub.subscriptionTier, t]
  );
  const endsAt = sub.cancelAt ? dayjs(sub.cancelAt) : null;

  return (
    <div className="flex flex-col gap-[16px]">
      <div className="text-[20px] font-bold">{t('plans', 'Plans')}</div>
      <div className="flex flex-col gap-[12px] rounded-[4px] border border-customColor6 bg-sixth p-[24px]">
        <div className="text-[18px] font-[600]">
          {t('gumroad_plan_title', {
            defaultValue: '{{plan}} plan, billed through Gumroad',
            plan,
            interpolation: { escapeValue: false },
          })}
        </div>
        <div className="text-[14px] text-textItemBlur">
          {endsAt
            ? t('gumroad_plan_ends', {
                defaultValue:
                  'The membership is cancelled: the plan stays active until {{date}}, then ends.',
                date: gumroadDate(endsAt.toDate()),
                interpolation: { escapeValue: false },
              })
            : t(
                'gumroad_plan_manage',
                'To cancel or change it, open your Gumroad library.'
              )}
        </div>
        <div>
          <a
            href={GUMROAD_LIBRARY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-[40px] items-center rounded-[10px] border border-newColColor px-[16px] text-[14px] font-[600] hover:border-hp-primary"
          >
            {t('gumroad_open_library', 'Open my Gumroad library')}
          </a>
        </div>
        {!!features.length && (
          <ul className="mt-[8px] grid grid-cols-1 gap-[6px] text-[14px] sm:grid-cols-2">
            {features.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
        )}
      </div>
      <GumroadRedeemField />
    </div>
  );
};
