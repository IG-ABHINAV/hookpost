/**
 * The pricing cards render what the backend's pricing context says, and the
 * browser no longer picks a currency or writes one anywhere.
 *   pnpm exec jest -c apps/frontend/jest.config.ts
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, prefetch: _p, ...rest }: any) =>
    require('react').createElement('a', { href, ...rest }, children),
}));

import { PricingPlans } from '@hookpost/frontend/app/(landing)/PricingPlans';
import {
  PricingContext,
  CHARGE_CURRENCY_NOTE,
  RUPEE_NOTE,
  lockedNote,
  pricingFor,
  showRupeeNote,
} from '@hookpost/frontend/components/billing/use.pricing.context';

const context = (over: Partial<PricingContext> = {}): PricingContext => ({
  displayCurrency: 'INR',
  chargeCurrency: 'INR',
  lockedCurrency: null,
  checkoutAllowed: true,
  region: { country: 'US', tzSaysIndia: false, ipSaysIndia: false },
  prices: { STANDARD: { month: 599, year: 5990 }, PRO: { month: 1999, year: 19990 } },
  ...over,
});

let fetchMock: jest.Mock;
const answer = (body: any, ok = true) => {
  fetchMock = jest.fn(async () => ({ ok, json: async () => body }));
  (global as any).fetch = fetchMock;
};

/**
 * The request leaves from a task of its own after mount (use.pricing.context.ts):
 * wait for it, then for its answer to be applied, before asserting on it.
 */
const answered = async () => {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

beforeEach(() => {
  window.localStorage.clear();
  document.cookie.split(';').forEach((c) => {
    document.cookie = `${c.split('=')[0].trim()}=; path=/; max-age=0`;
  });
});

describe('PricingPlans on the cached marketing pages', () => {
  it('a visitor in the US sees $7, no currency pill, and the note that checkout charges rupees', async () => {
    answer(context());
    const { container } = render(React.createElement(PricingPlans));

    await answered();
    expect(container.textContent).toContain('$7');
    expect(container.textContent).toContain(CHARGE_CURRENCY_NOTE);
    expect(container.textContent).not.toContain('Prices in'); // one shown price, no currency pill
    // One plan, one price: no rupee figure and no Pro price on the cards.
    expect(container.textContent).not.toMatch(/₹|\b599\b|\b699\b|1,999/);
    // The abroad-card line is gone: the note above says what checkout charges.
    expect(container.textContent).not.toContain(RUPEE_NOTE);

    // Only the timezone goes to the server; the country is read there.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/public\/pricing-context\?tz=/);
    expect(init).toMatchObject({ cache: 'no-store' });

    // Nothing written for checkout to read any more.
    expect(document.cookie).not.toContain('hookpost_currency');
    expect(window.localStorage.getItem('hookpost_currency')).toBeNull();
  });

  it.each([
    [{ country: 'IN', tzSaysIndia: false, ipSaysIndia: true }],
    [{ country: 'US', tzSaysIndia: true, ipSaysIndia: false }],
  ])('a visitor the server places in India sees the same $7 and no rupee figure (%p)', async (region) => {
    answer(context({ region }));
    const { container } = render(React.createElement(PricingPlans));
    await answered();
    expect(container.textContent).toContain('$7');
    expect(container.textContent).toContain(CHARGE_CURRENCY_NOTE);
    expect(container.textContent).not.toMatch(/₹|\b599\b|\b699\b/);
    expect(container.textContent).not.toContain(RUPEE_NOTE);
  });

  it('renders the same $7 when the context call fails', async () => {
    answer({ statusCode: 500 }, false);
    const { container } = render(React.createElement(PricingPlans));
    await answered();
    expect(container.textContent).toContain('$7');
    expect(container.textContent).toContain(CHARGE_CURRENCY_NOTE);
    expect(container.textContent).not.toMatch(/₹|\b599\b|\b699\b/);
    expect(container.textContent).not.toContain(RUPEE_NOTE);
  });
});

describe('helpers', () => {
  it('pricingFor takes the paid prices from the server and limits from pricing.ts', () => {
    const table = pricingFor(
      context({ prices: { STANDARD: { month: 649, year: 6490 }, PRO: { month: 1999, year: 19990 } } })
    );
    expect(table.STANDARD.month_price).toBe(649);
    expect(table.STANDARD.year_price).toBe(6490);
    expect(table.STANDARD.channel).toBe(5);
    expect(pricingFor(null).STANDARD.month_price).toBe(599);
  });

  it('a workspace on a live USD plan is shown dollars and, since PR-4, may change plan in them', () => {
    const ctx = context({
      displayCurrency: 'USD',
      chargeCurrency: 'USD',
      lockedCurrency: 'USD',
      checkoutAllowed: true,
      prices: { STANDARD: { month: 19, year: 190 }, PRO: { month: 29, year: 290 } },
    });
    expect(pricingFor(ctx).STANDARD.month_price).toBe(19);
    expect(showRupeeNote(ctx)).toBe(false);
    expect(lockedNote(ctx)).toBeNull();
    expect(lockedNote(context({ lockedCurrency: 'INR' }))).toBeNull();
  });

  it('a live plan checkout refuses is told why it cannot switch', () => {
    const refused = context({
      displayCurrency: 'EUR',
      chargeCurrency: 'EUR',
      lockedCurrency: 'EUR',
      checkoutAllowed: false,
    });
    expect(lockedNote(refused)).toContain('billed in EUR');
    // A backend from before PR-4 sends no checkoutAllowed and refused every
    // plan not in rupees.
    const old = context({ lockedCurrency: 'USD' });
    delete (old as any).checkoutAllowed;
    expect(lockedNote(old)).toContain('billed in USD');
  });

  it('the abroad line never claims a foreign card will work', () => {
    expect(RUPEE_NOTE).not.toMatch(/accept|supported|works|international cards|convert/i);
    expect(RUPEE_NOTE).toContain('may be declined');
  });

  // The FAQ is a const in a Next page file, which cannot export it, so read
  // the source. Its answers also go into the FAQPage JSON-LD. Two versions
  // since PR-4: rupees only, and (usdCopy, once dollars are sold) both.
  it('the /pricing currency FAQ never claims a foreign card will work on rupees', () => {
    const page = fs.readFileSync(
      path.join(__dirname, '../../app/(landing)/pricing/page.tsx'),
      'utf8'
    );
    const [, rupees, both] =
      page.match(
        /q: 'What currencies can I pay in\?',\s*a: usdCopy\(\s*'([^']*)',\s*`([^`]*)`/
      ) || [];
    expect(rupees).toContain('Indian rupees');
    expect(rupees).not.toMatch(/accept|supported|works|international cards|convert/i);
    expect(rupees).toContain('may be declined');
    // The dollar version still promises nothing about a foreign card on the
    // rupee plan, and never offers UPI outside India.
    expect(both).toContain('Indian rupees');
    expect(both).toContain('US dollars by card');
    expect(both).not.toMatch(/accept|supported|works|international cards|convert/i);
    expect(both.split('Outside India')[1]).not.toMatch(/UPI/);
  });
});
