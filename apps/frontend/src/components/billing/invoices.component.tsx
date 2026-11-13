'use client';

import React, { FC } from 'react';
import useSWR from 'swr';
import dayjs from 'dayjs';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { getCurrencyConfig } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { formatMoney } from '@hookpost/frontend/components/billing/coupon.field';
import { useT } from '@hookpost/react/translation/get.transation.service.client';

/** One row of GET /billing/invoices (RazorpayService.listInvoices). */
export interface BillingInvoiceRow {
  id: string;
  date: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  amount: number;
  currency: string;
  status: string;
  url: string | null;
  billing: string | null;
  period: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  paid: 'Paid',
  issued: 'Due',
  partially_paid: 'Partly paid',
};

const titleCase = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

const day = (value: string | null) =>
  value ? dayjs(value).format('D MMM YYYY') : '';

export const useBillingInvoices = () => {
  const fetch = useFetch();
  return useSWR<BillingInvoiceRow[]>(
    '/billing/invoices',
    async (path: string) => {
      const res = await fetch(path);
      const body = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(body)) {
        throw new Error(
          body?.message || 'We could not load your invoices. Please try again.'
        );
      }
      return body;
    },
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
};

/** The billing history itself; no fetching, so it can be tested on its own. */
export const InvoicesTable: FC<{ invoices: BillingInvoiceRow[] }> = ({
  invoices,
}) => {
  if (!invoices.length) {
    return (
      <div className="text-[14px] text-textItemBlur">
        No payments yet. Invoices appear here once Razorpay charges your plan.
      </div>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-newBorder">
      {invoices.map((invoice) => {
        const symbol = getCurrencyConfig(invoice.currency).symbol;
        const locale = invoice.currency === 'INR' ? 'en-IN' : 'en-US';
        const plan = invoice.billing
          ? `${titleCase(invoice.billing)}${
              invoice.period ? ` · ${titleCase(invoice.period)}` : ''
            }`
          : '';
        const covers =
          invoice.periodStart && invoice.periodEnd
            ? `${day(invoice.periodStart)} – ${day(invoice.periodEnd)}`
            : '';
        const status = STATUS_LABEL[invoice.status] || titleCase(invoice.status);
        return (
          <li
            key={invoice.id}
            className="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] py-[12px] min-w-0"
          >
            <div className="flex flex-col min-w-0 flex-1 basis-[200px]">
              <span className="text-[14px] font-semibold">
                {day(invoice.date)}
              </span>
              <span className="text-[12px] text-textItemBlur break-words">
                {[plan, covers].filter(Boolean).join(' · ')}
              </span>
            </div>
            <span className="text-[14px] font-semibold tabular-nums">
              {symbol}
              {formatMoney(invoice.amount, locale)}
            </span>
            <span
              className={
                invoice.status === 'paid'
                  ? 'text-[12px] font-semibold text-green-600'
                  : 'text-[12px] font-semibold text-red-500'
              }
            >
              {status}
            </span>
            {invoice.url ? (
              <a
                href={invoice.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] font-semibold text-textColor underline"
                aria-label={`Open the invoice of ${day(invoice.date)} on Razorpay`}
              >
                Invoice
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
};

/** "Invoices" on the billing page: loads the list when it is opened. */
export const BillingInvoices: FC = () => {
  const t = useT();
  const { data, error, isLoading, mutate } = useBillingInvoices();
  return (
    <section
      aria-label={t('invoices', 'Invoices')}
      className="w-full max-w-[720px] mx-auto rounded-[4px] border border-newBorder bg-newBgColorInner p-[16px] flex flex-col gap-[8px] min-w-0"
    >
      <div className="text-[16px] font-semibold">{t('invoices', 'Invoices')}</div>
      {isLoading ? (
        <div className="text-[14px] text-textItemBlur">Loading invoices…</div>
      ) : error ? (
        <div className="flex flex-wrap items-center gap-[12px] text-[14px]">
          <span className="text-red-500" role="alert">
            {String(error.message || error)}
          </span>
          <button
            type="button"
            className="underline text-textColor"
            onClick={() => mutate()}
          >
            Try again
          </button>
        </div>
      ) : (
        <InvoicesTable invoices={data || []} />
      )}
    </section>
  );
};
