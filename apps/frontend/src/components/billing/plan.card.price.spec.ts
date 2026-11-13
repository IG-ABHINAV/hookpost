/**
 * The plan card marked "Current Plan" shows what the workspace pays, which
 * for a subscriber on an older plan is not today's list price.
 *   pnpm exec jest -c apps/frontend/jest.config.ts plan.card.price
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { HOOKPOST_PRICE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { CHARGE_CURRENCY_NOTE } from '@hookpost/frontend/components/billing/use.pricing.context';

jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string, opts?: Record<string, string>) =>
    fallback.replace(/{{(\w+)}}/g, (_m, name) => opts?.[name] ?? ''),
}));

// The billing page's neighbours, none of which this is about.
let mockPricingContext: any = null;
jest.mock('@hookpost/frontend/components/billing/use.billing.pricing.context', () => ({
  useBillingPricingContext: () => ({ data: mockPricingContext, mutate: jest.fn() }),
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/billing',
}));
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({ useFetch: () => jest.fn() }));
jest.mock('@hookpost/react/helpers/delete.dialog', () => ({ deleteDialog: jest.fn() }));
jest.mock('@hookpost/react/toaster/toaster', () => ({ useToaster: () => ({ show: jest.fn() }) }));
jest.mock('@hookpost/frontend/components/layout/user.context', () => ({
  useUser: () => ({ tier: 'STANDARD', allowTrial: false, isLifetime: false }),
}));
jest.mock('@hookpost/react/helpers/variable.context', () => ({
  useVariables: () => ({ isGeneral: true }),
}));
jest.mock('@hookpost/frontend/components/layout/new-modal', () => ({
  useModals: () => ({ openModal: jest.fn(), closeAll: jest.fn() }),
}));
jest.mock('@hookpost/react/form/textarea', () => ({ Textarea: () => null }));
jest.mock('@hookpost/helpers/utils/use.fire.events', () => ({ useFireEvents: () => jest.fn() }));
jest.mock('@hookpost/helpers/utils/utm.saver', () => ({ useUtmUrl: () => '' }));
jest.mock('@hookpost/react/helpers/use.track', () => ({ useTrack: () => jest.fn() }));
jest.mock('@hookpost/frontend/components/billing/finish.trial', () => ({ FinishTrial: () => null }));
jest.mock('@hookpost/frontend/components/layout/dubAnalytics', () => ({ useDubClickId: () => '' }));
jest.mock('@hookpost/frontend/components/layout/logout.component', () => ({
  LogoutComponent: () => null,
}));
jest.mock('@hookpost/frontend/components/billing/faq.component', () => ({ FAQComponent: () => null }));
jest.mock('@hookpost/frontend/components/billing/razorpay.billing', () => ({
  loadRazorpayScript: jest.fn(),
  openRazorpayCheckout: jest.fn(),
}));
jest.mock('@hookpost/frontend/components/layout/twa', () => ({ isTwaClient: () => false }));
jest.mock('@hookpost/frontend/components/billing/invoices.component', () => ({
  BillingInvoices: () => null,
}));
jest.mock('@hookpost/frontend/components/billing/prorate.component', () => ({
  Prorate: () => null,
  tierName: (tier: string) => tier.charAt(0) + tier.slice(1).toLowerCase(),
  channelsOverAllowance: () => 0,
  scheduledChangeLine: () => '',
}));

import {
  PlanCardPrice,
  paidPriceFor,
} from '@hookpost/frontend/components/billing/plan.card.price';
import { MainBillingComponent } from '@hookpost/frontend/components/billing/main.billing.component';

const NOTE = 'Your price since you subscribed.';
const OLD_STANDARD = {
  billing: 'STANDARD',
  period: 'MONTHLY' as const,
  currency: 'INR',
  amount: 699,
};

describe('paidPriceFor', () => {
  const base = {
    tier: 'STANDARD',
    period: 'MONTHLY' as const,
    isCurrent: true,
    listPrice: 599,
    listCurrency: 'INR',
    currentPlan: OLD_STANDARD,
  };

  it('the current plan at an older price: that price, and the list price beside it', () => {
    expect(paidPriceFor(base)).toEqual({
      amount: 699,
      currency: 'INR',
      list: { amount: 599, currency: 'INR' },
    });
  });

  it('paying the list price: nothing to point out', () => {
    expect(
      paidPriceFor({ ...base, currentPlan: { ...OLD_STANDARD, amount: 599 } })
    ).toEqual({ amount: 599, currency: 'INR', list: null });
  });

  it('a different currency counts as different, even at the same number', () => {
    expect(
      paidPriceFor({ ...base, currentPlan: { ...OLD_STANDARD, amount: 599, currency: 'USD' } })
        ?.list
    ).toEqual({ amount: 599, currency: 'INR' });
  });

  it.each([
    ['another tier', { tier: 'PRO', listPrice: 1999 }],
    ['the other period (Yearly toggle on a monthly plan)', { period: 'YEARLY' as const, listPrice: 5990 }],
    ['a card not marked Current Plan', { isCurrent: false }],
    ['no price from the server', { currentPlan: null }],
    ['a zero amount', { currentPlan: { ...OLD_STANDARD, amount: 0 } }],
  ])('list price for %s', (_label, over) => {
    expect(paidPriceFor({ ...base, ...over })).toBeNull();
  });
});

describe('PlanCardPrice', () => {
  it('shows what the workspace pays as the price, and what new subscribers pay under it', () => {
    const { container } = render(
      React.createElement(PlanCardPrice, {
        listPrice: 599,
        listCurrency: 'INR',
        period: 'MONTHLY',
        paid: { amount: 699, currency: 'INR', list: { amount: 599, currency: 'INR' } },
      })
    );
    expect(container.textContent).toBe(`₹699/month${NOTE}`);
  });

  it('no line when the workspace pays the list price', () => {
    const { container } = render(
      React.createElement(PlanCardPrice, {
        listPrice: 599,
        listCurrency: 'INR',
        period: 'MONTHLY',
        paid: { amount: 599, currency: 'INR', list: null },
      })
    );
    expect(container.textContent).toBe('₹599/month');
  });

  it('other cards: the list price, with a coupon struck through as before', () => {
    const { container } = render(
      React.createElement(PlanCardPrice, {
        listPrice: 1999,
        listCurrency: 'INR',
        period: 'MONTHLY',
        coupon: { code: 'TEN', percentOff: 10 } as any,
      })
    );
    expect(container.textContent).toBe('₹1,799.10₹1999/month');
  });
});

describe('the billing page', () => {
  const sub = {
    id: 'sub-row-1',
    organizationId: 'org-1',
    subscriptionTier: 'STANDARD',
    identifier: 'sub_old',
    period: 'MONTHLY',
    cancelAt: null,
    isLifetime: false,
    totalChannels: 5,
  } as any;
  const context = (currentPlan: any) => ({
    displayCurrency: 'INR',
    chargeCurrency: 'INR',
    checkoutAllowed: true,
    lockedCurrency: null,
    region: { country: 'IN', tzSaysIndia: true, ipSaysIndia: true },
    prices: {
      STANDARD: { month: 599, year: 5990 },
      PRO: { month: 1999, year: 19990 },
      HOOKPOST: { month: 699, year: 0 },
    },
    currentPlan,
  });
  const card = (tier: string) =>
    screen.getByText(tier, { selector: 'div.text-\\[18px\\]' }).parentElement!;

  const open = async () => {
    await act(async () => {
      render(React.createElement(MainBillingComponent, { sub }));
    });
  };

  it('a Standard subscriber on the old Rs 699 plan: Rs 699 on the Current Plan card, the $7 list price on the plan for sale', async () => {
    mockPricingContext = context(OLD_STANDARD);
    await open();

    const standard = card('STANDARD');
    expect(within(standard).getByRole('button', { name: 'Current Plan' })).toBeTruthy();
    expect(standard.textContent).toContain('₹699/month');
    expect(standard.textContent).toContain(NOTE);
    expect(standard.textContent).not.toContain('₹599/month');

    // Pro is no longer sold: the single plan sits beside the plan it has.
    expect(screen.queryByText('PRO', { selector: 'div.text-\\[18px\\]' })).toBeNull();
    // The plan on sale is shown at $7 to everyone, with no rupee figure (HOOKPOST_PRICE).
    expect(card('HOOKPOST').textContent).toContain(`$${HOOKPOST_PRICE.displayUsd}/month`);
    expect(card('HOOKPOST').textContent).not.toMatch(/₹|\b599\b|\b699\b/);
    expect(card('HOOKPOST').textContent).not.toContain('Your price since you subscribed');
    expect(screen.getByTestId('charge-currency-note').textContent).toBe(CHARGE_CURRENCY_NOTE);
  });

  it('Yearly toggle on a monthly plan: no card is current, every card shows its list price', async () => {
    mockPricingContext = context(OLD_STANDARD);
    await open();

    fireEvent.click(screen.getByRole('button', { name: /YEARLY/ }));

    expect(card('STANDARD').textContent).toContain('₹5,990/year');
    expect(card('STANDARD').textContent).not.toContain('₹699');
    expect(screen.queryByText(/Your price since you subscribed/)).toBeNull();
  });

  it('no price from the server (Razorpay unreachable): the list price, as before', async () => {
    mockPricingContext = context(null);
    await open();

    const standard = card('STANDARD');
    expect(within(standard).getByRole('button', { name: 'Current Plan' })).toBeTruthy();
    expect(standard.textContent).toContain('₹599/month');
    expect(screen.queryByText(/Your price since you subscribed/)).toBeNull();
  });
});
