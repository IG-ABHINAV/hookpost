/**
 * The pricing cards (PricingPlans.client.tsx) as a visitor reads them once the
 * pricing context has answered: the one plan's monthly price in the currency
 * checkout charges, no yearly price (Hookpost is billed monthly only since
 * 8 Nov 2026), and "Cancel anytime", which billing sandbox scenarios s2 (rupees)
 * and s14 (dollars) prove: Razorpay stops at once and the plan runs to the
 * end of the period paid for.
 *
 *   ./node_modules/.bin/jest -c apps/frontend/jest.config.ts pricing-plans
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import {
  HOOKPOST_PRICE,
  pricingINR,
  pricingUSD,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) =>
    React.createElement('a', { href, ...rest }, children),
}));

import { PricingPlansClient } from './PricingPlans.client';
import { CHARGE_CURRENCY_NOTE } from '@hookpost/frontend/components/billing/use.pricing.context';

const context = (currency: 'INR' | 'USD') => {
  const table = currency === 'USD' ? pricingUSD : pricingINR;
  return {
    displayCurrency: currency,
    chargeCurrency: currency,
    lockedCurrency: null,
    checkoutAllowed: true,
    region: {
      country: currency === 'USD' ? 'US' : 'IN',
      tzSaysIndia: currency === 'INR',
      ipSaysIndia: currency === 'INR',
    },
    prices: {
      STANDARD: { month: table.STANDARD.month_price, year: table.STANDARD.year_price },
      PRO: { month: table.PRO.month_price, year: table.PRO.year_price },
      HOOKPOST: { month: table.HOOKPOST.month_price, year: table.HOOKPOST.year_price },
    },
    firstMonthOffer: null,
  };
};

const answer = (body: unknown) => {
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
  });
};

const cards = async (currency: 'INR' | 'USD') => {
  answer(context(currency));
  const { container, unmount } = render(
    React.createElement(PricingPlansClient, { usdMarketed: true })
  );
  await waitFor(() =>
    expect(screen.queryByTestId('price-skeleton')).toBeNull()
  );
  const out = {
    text: (container.textContent || '').replace(/\s+/g, ' '),
    yearly: screen.queryAllByTestId('yearly-price').map((n) => n.textContent),
  };
  unmount();
  return out;
};

afterEach(() => {
  delete (global as any).fetch;
});

describe('pricing cards', () => {
  it('a visitor billed in dollars sees the one plan at its $7 price and no yearly line', async () => {
    const { text, yearly } = await cards('USD');
    expect(text).toContain(`$${HOOKPOST_PRICE.displayUsd}`);
    expect(text).toContain('Hookpost');
    expect(yearly).toEqual([]);
    expect(text).not.toMatch(/₹|\/year|\bStandard\b|\bPro\b|\$19\b|\$29\b/);
  });

  it('a visitor in India sees the same $7, no rupee figure for the plan, and no yearly line', async () => {
    const { text, yearly } = await cards('INR');
    expect(text).toContain(`$${HOOKPOST_PRICE.displayUsd}`);
    expect(yearly).toEqual([]);
    expect(text).not.toMatch(/₹|\/year|\bStandard\b|\bPro\b|1,999|\b599\b|\b699\b/);
    expect(text).not.toContain('Prices in'); // one shown price, no currency pill
    expect(text).toContain(CHARGE_CURRENCY_NOTE);
  });

  it.each(['INR', 'USD'] as const)('says Cancel anytime, and what it means (%s)', async (currency) => {
    const { text } = await cards(currency);
    expect(text).toContain('Cancel anytime: your plan runs to the end of the period you paid for.');
  });

  it('shows no yearly line while the price is loading, and Cancel anytime from the first paint', () => {
    (global as any).fetch = jest.fn(() => new Promise(() => undefined));
    const { container, unmount } = render(
      React.createElement(PricingPlansClient, { usdMarketed: true })
    );
    expect(screen.queryAllByTestId('yearly-price')).toHaveLength(0);
    expect(container.textContent).toContain('Cancel anytime');
    unmount();
  });
});

describe('the one plan card, festival dressing', () => {
  afterEach(() => jest.useRealTimers());

  it('is centred on its own, with the festival ribbon, and shows the real quotas', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-20T12:00:00+05:30') });
    global.fetch = jest.fn(() => new Promise(() => undefined)) as any;
    render(
      React.createElement(PricingPlansClient, {
        trialOnly: true,
        trialNote: 'x',
        trialCta: 'Get 3 free posts',
        festivalKey: 'winter',
      })
    );
    const cards = screen.getByTestId('plan-cards');
    expect(cards.className).toMatch(/\bjustify-center\b/);
    expect(cards.className).not.toMatch(/grid-cols-2/);
    expect(screen.getByTestId('festival-ribbon').textContent).toBe('Winter offer');
    // pricing.ts TIER_LIMITS.HOOKPOST
    expect(cards.textContent).toContain('20 channels');
    expect(cards.textContent).toContain('2,000 posts per month');
    expect(cards.textContent).toContain('100 AI credits');
    expect(cards.textContent).toContain('$7');
  });
});
