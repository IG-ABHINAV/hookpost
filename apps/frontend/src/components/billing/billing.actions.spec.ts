/**
 * The billing page's Monthly/Yearly control, the "Pay today" line under a
 * plan the workspace could switch to, the Invoices list, and the toast that
 * carries Cancel's result.
 *   pnpm exec jest -c apps/frontend/jest.config.ts
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import dayjs from 'dayjs';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/billing',
}));

import {
  PeriodToggle,
  yearlySavingPercent,
} from '@hookpost/frontend/components/billing/period.toggle';
import { InvoicesTable } from '@hookpost/frontend/components/billing/invoices.component';
import { planChangeCopy } from '@hookpost/frontend/components/billing/prorate.component';
import { Toaster, useToaster } from '@hookpost/react/toaster/toaster';
import {
  pricingINR,
  PURCHASABLE_TIERS,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

describe('PeriodToggle', () => {
  const renderToggle = (value: 'MONTHLY' | 'YEARLY', onChange = jest.fn()) => {
    render(
      React.createElement(PeriodToggle, {
        value,
        onChange,
        monthlyLabel: 'MONTHLY',
        yearlyLabel: 'YEARLY',
        yearlyNote: 'save 16%',
      })
    );
    return onChange;
  };

  it('marks the chosen period for screen readers and visibly', () => {
    renderToggle('MONTHLY');
    const monthly = screen.getByRole('button', { name: 'MONTHLY' });
    const yearly = screen.getByRole('button', { name: /YEARLY/ });

    expect(monthly.getAttribute('aria-pressed')).toBe('true');
    expect(yearly.getAttribute('aria-pressed')).toBe('false');
    // Filled with the brand colour and bold when chosen, plain when not.
    expect(monthly.className).toContain('bg-btnPrimary');
    expect(monthly.className).toContain('font-semibold');
    expect(yearly.className).not.toContain('bg-btnPrimary');
    expect(screen.getByRole('group', { name: 'Billing period' })).toBeTruthy();
  });

  it('follows the value it is given', () => {
    renderToggle('YEARLY');
    expect(
      screen.getByRole('button', { name: /YEARLY/ }).getAttribute('aria-pressed')
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'MONTHLY' }).getAttribute('aria-pressed')
    ).toBe('false');
  });

  it('is a pair of real buttons, so a click, Enter or Space picks a period', () => {
    const onChange = renderToggle('MONTHLY');
    const yearly = screen.getByRole('button', { name: /YEARLY/ });
    expect(yearly.tagName).toBe('BUTTON');
    expect(yearly.getAttribute('type')).toBe('button');

    fireEvent.click(yearly);
    expect(onChange).toHaveBeenCalledWith('YEARLY');
  });

  it('works out the yearly saving from the price table, rounded down', () => {
    // The yearly plans still on file for Standard and Pro subscribers; the
    // single plan (HOOKPOST) has no yearly price and adds nothing.
    const onSale = [pricingINR.STANDARD, pricingINR.PRO, pricingINR.HOOKPOST];
    // Rs 5,990 a year against 12 x Rs 599, and Rs 19,990 against 12 x Rs 1,999.
    expect(yearlySavingPercent(onSale)).toBe(16);
    expect(yearlySavingPercent([{ month_price: 100, year_price: 1200 }])).toBeNull();
  });
});

describe('planChangeCopy', () => {
  const nextMonth = dayjs('2026-11-13T12:00:00Z');

  it('UPI Standard to Pro: the unused days are credited, nothing to pay today', () => {
    // The policy of 29 Oct 2026: an upgrade starts now and the unused days of
    // the cycle already paid for buy time on the new plan, so the first full
    // charge is pushed out instead of being taken today. The line used to
    // read "Pay Today ₹1414" (a figure nothing charged), then "Pay ₹1,999
    // today ... its unused days aren't refunded", which is no longer true.
    const credited = dayjs('2026-11-08T12:00:00Z');
    const copy = planChangeCopy(
      {
        price: 1999,
        mode: 'new_mandate',
        chargeToday: 0,
        recurring: 1999,
        period: 'MONTHLY',
        nextChargeAt: credited.toISOString(),
        currentTier: 'STANDARD',
        currentPeriod: 'MONTHLY',
        currentStatus: 'active',
        direction: 'upgrade',
        effectiveAt: 'now',
        creditApplied: 299.5,
      },
      'PRO',
      'INR'
    );
    expect(copy).toBe(
      `Pro starts now. Nothing to pay today: the ₹299.50 left on your Standard is credited, and ₹1,999/month starts ${credited.format('D MMM YYYY')}.`
    );
    expect(copy).not.toContain('1414');
    expect(copy).not.toMatch(/refund/i);
  });

  it('an upgrade on the last day of the cycle charges the full price and says why', () => {
    // The credit buys less than an hour, so there is nothing to defer: the
    // new plan simply starts now at its own price (newMandateUpgradeTerms).
    const copy = planChangeCopy(
      {
        price: 1999,
        mode: 'new_mandate',
        chargeToday: 1999,
        recurring: 1999,
        period: 'MONTHLY',
        nextChargeAt: nextMonth.toISOString(),
        currentTier: 'STANDARD',
        currentPeriod: 'MONTHLY',
        currentStatus: 'active',
        direction: 'upgrade',
        effectiveAt: 'now',
        creditApplied: 0,
      },
      'PRO',
      'INR'
    );
    expect(copy).toBe(
      `Pro starts now. Pay ₹1,999 today, then ₹1,999/month from ${nextMonth.format('D MMM YYYY')}. Your Standard cycle has run out, so there is nothing left to credit.`
    );
  });

  it('an upgrade on a card says Razorpay charges only the difference', () => {
    const copy = planChangeCopy(
      {
        price: 1999,
        mode: 'in_place',
        chargeToday: null,
        recurring: 1999,
        period: 'MONTHLY',
        nextChargeAt: nextMonth.toISOString(),
        currentTier: 'STANDARD',
        currentPeriod: 'MONTHLY',
        currentStatus: 'active',
        direction: 'upgrade',
        effectiveAt: 'now',
        creditApplied: null,
      },
      'PRO',
      'INR'
    );
    expect(copy).toBe(
      `Pro starts now on your saved card. Razorpay charges only the difference for the rest of this cycle, then ₹1,999/month from ${nextMonth.format('D MMM YYYY')}.`
    );
    expect(copy).not.toMatch(/Pay ₹.* today/);
  });

  it('a downgrade keeps the higher plan to the end of the cycle and charges nothing today', () => {
    const copy = planChangeCopy(
      {
        price: 599,
        mode: 'new_mandate',
        chargeToday: 0,
        recurring: 599,
        period: 'MONTHLY',
        nextChargeAt: nextMonth.toISOString(),
        currentTier: 'PRO',
        currentPeriod: 'MONTHLY',
        currentStatus: 'active',
        direction: 'downgrade',
        effectiveAt: 'cycle_end',
        creditApplied: 0,
      },
      'STANDARD',
      'INR'
    );
    expect(copy).toBe(
      `You keep Pro until ${nextMonth.format('D MMM YYYY')}, then ₹599/month. Nothing to pay today, and nothing is refunded for days already paid for.`
    );
    expect(copy).not.toMatch(/starts now/);
  });

  it('a downgrade warns about the channels that will not fit, and that none are deleted', () => {
    const copy = planChangeCopy(
      {
        price: 599,
        mode: 'new_mandate',
        chargeToday: 0,
        recurring: 599,
        period: 'MONTHLY',
        nextChargeAt: nextMonth.toISOString(),
        currentTier: 'PRO',
        currentStatus: 'active',
        direction: 'downgrade',
        overage: 3,
      },
      'STANDARD',
      'INR'
    );
    expect(copy).toContain(
      "3 channels won't fit Standard and will stop publishing until you move back up; none are deleted."
    );
  });

  it('a refused plan change says only the refusal', () => {
    const refusal =
      "There's a payment on this plan that hasn't gone through. Pay it first, then you can change plan.";
    expect(
      planChangeCopy(
        {
          price: 1999,
          mode: 'new_mandate',
          chargeToday: null,
          recurring: 1999,
          period: 'MONTHLY',
          nextChargeAt: null,
          currentTier: 'STANDARD',
          currentStatus: 'halted',
          direction: 'upgrade',
          refusal,
          refusalCode: 'PLAN_CHANGE_DUNNING',
        },
        'PRO',
        'INR'
      )
    ).toBe(refusal);
  });

  it('a trial being switched says trial, and claims nothing about refunds', () => {
    const copy = planChangeCopy(
      {
        price: 1999,
        mode: 'new_mandate',
        chargeToday: 1999,
        recurring: 1999,
        period: 'MONTHLY',
        nextChargeAt: nextMonth.toISOString(),
        currentTier: 'STANDARD',
        currentStatus: 'authenticated',
      },
      'PRO',
      'INR'
    );
    expect(copy).toContain('Your Standard trial ends when Pro starts.');
    expect(copy).not.toContain('refunded');
  });

  it('after Reactivate or Change payment method the plan is paid, not a trial, and its days are not refunded', () => {
    // The replacement mandate is `authenticated` until its first charge, on
    // the date the old plan was paid until. The backend flags it as paid.
    const copy = planChangeCopy(
      {
        price: 1999,
        mode: 'new_mandate',
        chargeToday: 1999,
        recurring: 1999,
        period: 'MONTHLY',
        nextChargeAt: nextMonth.toISOString(),
        currentTier: 'STANDARD',
        currentPeriod: 'MONTHLY',
        currentStatus: 'authenticated',
        currentIsTrial: false,
        currentIsPaid: true,
      },
      'PRO',
      'INR'
    );
    expect(copy).toContain(
      "Your Standard plan ends when Pro starts."
    );
    expect(copy).not.toContain('trial');
  });

  it('monthly to yearly on the same tier names the period being replaced', () => {
    const copy = planChangeCopy(
      {
        price: 5990,
        mode: 'new_mandate',
        chargeToday: 5990,
        recurring: 5990,
        period: 'YEARLY',
        nextChargeAt: '2027-10-13T12:00:00Z',
        currentTier: 'STANDARD',
        currentPeriod: 'MONTHLY',
        currentStatus: 'active',
      },
      'STANDARD',
      'INR'
    );
    expect(copy).toContain('Pay ₹5,990 today, then ₹5,990/year from 13 Oct 2027.');
    expect(copy).toContain('Your Standard monthly plan ends when this one starts');
  });

  it('a trial within a day of its first charge: the backend\'s refusal, not a switch it would refuse', () => {
    const refusal =
      "Your trial's first payment is due on 19 Oct 2026, and your bank may already have started it, so the trial cannot be changed now. Once that payment has gone through, you can switch plan or payment method here.";
    const copy = planChangeCopy(
      {
        price: 1999,
        mode: 'new_mandate',
        chargeToday: null,
        recurring: 1999,
        period: 'MONTHLY',
        nextChargeAt: '2026-10-19T06:00:00Z',
        currentTier: 'STANDARD',
        currentStatus: 'authenticated',
        currentIsTrial: true,
        currentIsPaid: false,
        refusal,
      },
      'PRO',
      'INR'
    );
    expect(copy).toBe(refusal);
    expect(copy).not.toMatch(/Nothing to pay today|Pay ₹/);
  });

  it('a trial switched to another plan: nothing today, first charge on the trial date', () => {
    const trialEnds = dayjs('2026-10-25T12:00:00Z');
    const copy = planChangeCopy(
      {
        price: 0,
        mode: 'new_mandate',
        chargeToday: 0,
        recurring: 1999,
        period: 'MONTHLY',
        nextChargeAt: trialEnds.toISOString(),
        currentTier: 'STANDARD',
        currentStatus: 'authenticated',
        currentIsTrial: true,
        currentIsPaid: false,
      },
      'PRO',
      'INR'
    );
    expect(copy).toBe(
      `Nothing to pay today: your trial switches to Pro, then ₹1,999/month from ${trialEnds.format('D MMM YYYY')}.`
    );
    expect(copy).not.toMatch(/Pay ₹/);

    // Same tier, other period: says which.
    expect(
      planChangeCopy(
        {
          price: 0,
          chargeToday: 0,
          recurring: 5990,
          period: 'YEARLY',
          nextChargeAt: trialEnds.toISOString(),
          currentTier: 'STANDARD',
          currentIsTrial: true,
        },
        'STANDARD',
        'INR'
      )
    ).toBe(
      `Nothing to pay today: your trial switches to Standard yearly, then ₹5,990/year from ${trialEnds.format('D MMM YYYY')}.`
    );
  });

  it('a card mandate moved in place claims no amount for today', () => {
    const copy = planChangeCopy(
      {
        price: 1999,
        mode: 'in_place',
        chargeToday: null,
        recurring: 1999,
        period: 'MONTHLY',
        nextChargeAt: nextMonth.toISOString(),
        currentTier: 'STANDARD',
        currentStatus: 'active',
      },
      'PRO',
      'INR'
    );
    expect(copy).toMatch(/^Switches now on your saved card, then ₹1,999\/month from /);
    expect(copy).not.toMatch(/Pay .* today/);
  });
});

describe('InvoicesTable', () => {
  it('lists date, plan, period, amount, status and the Razorpay invoice link', () => {
    render(
      React.createElement(InvoicesTable, {
        invoices: [
          {
            id: 'inv_oct',
            date: '2026-10-13T12:00:00Z',
            periodStart: '2026-10-13T12:00:00Z',
            periodEnd: '2026-11-13T12:00:00Z',
            amount: 699,
            currency: 'INR',
            status: 'issued',
            url: null,
            billing: 'STANDARD',
            period: 'MONTHLY',
          },
          {
            id: 'inv_sep',
            date: '2026-09-13T12:00:00Z',
            periodStart: '2026-09-13T12:00:00Z',
            periodEnd: '2026-10-13T12:00:00Z',
            amount: 1999.5,
            currency: 'INR',
            status: 'paid',
            url: 'https://rzp.io/i/inv_sep',
            billing: 'PRO',
            period: 'MONTHLY',
          },
        ],
      })
    );

    expect(screen.getByText('₹699')).toBeTruthy();
    expect(screen.getByText('Due')).toBeTruthy();
    expect(screen.getByText('₹1,999.50')).toBeTruthy();
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(screen.getByText(/Pro · Monthly · 13 Sep 2026 – 13 Oct 2026/)).toBeTruthy();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://rzp.io/i/inv_sep');
    expect(links[0].getAttribute('rel')).toContain('noopener');
  });

  it('says so when there is nothing yet', () => {
    render(React.createElement(InvoicesTable, { invoices: [] }));
    expect(screen.getByText(/No payments yet/)).toBeTruthy();
  });
});

describe('Toaster: the message a Cancel, Reactivate or payment-method click returns', () => {
  let show: (text: string, type?: 'success' | 'warning') => void = () => undefined;
  const Grab = () => {
    show = useToaster().show;
    return null;
  };
  const refused =
    "Razorpay didn't accept the cancellation (Subscription cannot be cancelled since no billing cycle is going on). Nothing has changed. Please try again, or email support@hookstep.in.";

  beforeEach(() => {
    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Toaster),
        React.createElement(Grab)
      )
    );
  });

  it('a refused cancel is announced as an alert, in a box that grows with the text and stays on screen', () => {
    // The regions exist before anything is shown, so the toast is announced.
    expect(screen.getByRole('alert').textContent).toBe('');
    expect(screen.getByRole('status').textContent).toBe('');

    act(() => show(refused, 'warning'));

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(refused);
    const box = alert.firstElementChild as HTMLElement;
    // It was a fixed h-[56px] overflow-hidden box: two-thirds of this
    // message was cut off on a phone.
    expect(box.className).toContain('min-h-[56px]');
    expect(box.className).not.toMatch(/(^|\s)h-\[56px\]/);
    expect(box.className).toContain('max-w-[calc(100vw-32px)]');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('a confirmation is announced politely as a status', () => {
    act(() =>
      show("Cancelled. Standard stays active until 7 Nov 2026, and you won't be charged again.")
    );
    expect(screen.getByRole('status').textContent).toContain('Standard stays active until 7 Nov 2026');
    expect(screen.getByRole('alert').textContent).toBe('');
  });
});

describe('planChangeCopy: a card upgrade quotes the exact amount', () => {
  it("states Razorpay's prorated charge and the credit behind it", () => {
    const copy = planChangeCopy(
      {
        price: 1999,
        recurring: 1999,
        mode: 'in_place',
        direction: 'upgrade',
        chargeToday: 700,
        creditApplied: 299.5,
        currentTier: 'STANDARD',
        period: 'MONTHLY',
        nextChargeAt: new Date('2026-11-15T00:00:00Z'),
      } as any,
      'PRO',
      'INR'
    );
    expect(copy).toBe(
      'Pro starts now on your saved card. Pay ₹700 today (the ₹299.50 left on your Standard is credited), then ₹1,999/month from 15 Nov 2026.'
    );
  });
});
