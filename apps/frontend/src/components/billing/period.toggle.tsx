'use client';

import React, { FC } from 'react';
import clsx from 'clsx';

export type BillingPeriod = 'MONTHLY' | 'YEARLY';

/**
 * Monthly / Yearly on the billing page: two buttons, the chosen one filled.
 *
 * This replaced the shared Slider here. Its knob was the only sign of which
 * period was chosen - #e9e9f1 on a white page in light mode, about 1.2:1 -
 * the labels beside it never changed, and it was a div with onClick, so a
 * keyboard or screen reader could not use it at all. Native buttons with
 * aria-pressed give both for free.
 *
 * Colours are plain var() tokens with no opacity modifier: Tailwind 3 emits
 * nothing for `bg-x/50` when x is a var() colour.
 */
export const PeriodToggle: FC<{
  value: BillingPeriod;
  onChange: (value: BillingPeriod) => void;
  monthlyLabel: string;
  yearlyLabel: string;
  /** Short note on the yearly option, e.g. "save 16%". */
  yearlyNote?: string;
}> = ({ value, onChange, monthlyLabel, yearlyLabel, yearlyNote }) => {
  const options: Array<{ value: BillingPeriod; label: string; note?: string }> = [
    { value: 'MONTHLY', label: monthlyLabel },
    { value: 'YEARLY', label: yearlyLabel, note: yearlyNote },
  ];
  return (
    <div
      role="group"
      aria-label="Billing period"
      className="inline-flex items-center gap-[2px] rounded-full border border-newBorder bg-newBgColorInner p-[3px]"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={clsx(
              'h-[32px] rounded-full px-[14px] text-[13px] flex items-center gap-[6px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-btnPrimary focus-visible:ring-offset-1',
              selected
                ? 'bg-btnPrimary text-hp-on-primary font-semibold'
                : 'bg-transparent text-textItemBlur font-medium hover:text-textColor'
            )}
          >
            <span>{option.label}</span>
            {option.note ? (
              <span
                className={clsx(
                  'text-[11px] font-semibold',
                  selected ? 'text-white' : 'text-textColor'
                )}
              >
                {option.note}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
};

/**
 * What a year costs against twelve months, as a whole percentage rounded
 * down, across the tiers on sale; null when yearly is not cheaper.
 */
export function yearlySavingPercent(
  tiers: Array<{ month_price: number; year_price: number }>
): number | null {
  const savings = tiers
    .filter((t) => t.month_price > 0 && t.year_price > 0)
    .map((t) => Math.floor((1 - t.year_price / (t.month_price * 12)) * 100));
  if (!savings.length) return null;
  const least = Math.min(...savings);
  return least > 0 ? least : null;
}
