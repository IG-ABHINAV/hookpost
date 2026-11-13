/**
 * Pages that quote web plan prices or upsell a package must not render inside
 * the Google Play app, and must be unchanged outside it.
 *   pnpm exec jest -c apps/frontend/jest.config.ts
 */
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
// The Node build: the default (browser) one needs MessageChannel, which jsdom lacks.
import { renderToString } from 'react-dom/server.node';

const mockFetch = jest.fn(async () => ({ json: async () => ({ affiliate: null }) }));
const mockUseUser = jest.fn(() => undefined);
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
jest.mock('@hookpost/react/toaster/toaster', () => ({
  useToaster: () => ({ show: jest.fn() }),
}));
jest.mock('@hookpost/frontend/components/layout/loading', () => ({
  LoadingComponent: () => 'loading',
}));
jest.mock('@hookpost/frontend/components/layout/new-modal', () => ({
  areYouSure: jest.fn(),
}));
jest.mock('@hookpost/frontend/components/layout/user.context', () => ({
  useUser: () => mockUseUser(),
}));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));
jest.mock('@hookpost/react/form/input', () => ({ Input: () => null }));
jest.mock('@hookpost/react/form/button', () => ({ Button: () => null }));
jest.mock('@hookpost/helpers/utils/use.fire.events', () => ({
  useFireEvents: () => jest.fn(),
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));
// The page's server-side check (the hookpost_twa cookie via next/headers).
const mockIsTwaServerSide = jest.fn(async () => false);
jest.mock('@hookpost/frontend/components/layout/twa.server', () => ({
  isTwaServerSide: () => mockIsTwaServerSide(),
}));
jest.mock('swr', () => {
  const actual = jest.requireActual('swr');
  return { __esModule: true, ...actual, useSWRConfig: () => ({ mutate: jest.fn() }) };
});

import { AffiliateComponent } from '@hookpost/frontend/components/affiliates/affiliate.component';
import AffiliatePage from '@hookpost/frontend/app/(app)/(site)/affiliate/page';
import { LifetimeDeal } from '@hookpost/frontend/components/billing/lifetime.deal';
import {
  TWA_AFFILIATE_NOTICE,
  TWA_BOOTSTRAP_SCRIPT,
  TWA_COOKIE,
  TWA_HTML_ATTR,
  TWA_PLAN_NOTICE,
} from '@hookpost/frontend/components/layout/twa';
import {
  endPageLoad,
  trackObservers,
} from '@hookpost/frontend/components/layout/twa.testing';

trackObservers();

const launch = (referrer: string) => {
  endPageLoad();
  window.localStorage.clear();
  document.cookie = `${TWA_COOKIE}=; path=/; max-age=0`;
  document.documentElement.removeAttribute(TWA_HTML_ATTR);
  Object.defineProperty(document, 'referrer', { value: referrer, configurable: true });
  new Function(TWA_BOOTSTRAP_SCRIPT)();
};

beforeEach(() => {
  mockFetch.mockClear();
  mockUseUser.mockClear();
  mockIsTwaServerSide.mockClear();
});

const renderPage = async () => render(await AffiliatePage());

describe('inside the Play app', () => {
  beforeEach(() => launch('android-app://in.hookstep.hookpost.twa'));

  it('the affiliate page is one neutral line: no payout form, no link, no fetch', () => {
    const { container } = render(React.createElement(AffiliateComponent));
    expect(container.textContent).toBe(TWA_AFFILIATE_NOTICE);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('textarea, input')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('/affiliate opened by deep link, cookie already set: the server HTML is only the notice', async () => {
    // A server render cannot see the client flag (useIsTwa is false there), so
    // without the page's own cookie check this HTML would be the dashboard.
    mockIsTwaServerSide.mockResolvedValueOnce(true);
    const html = renderToString(await AffiliatePage());
    expect(html).toContain(TWA_AFFILIATE_NOTICE);
    expect(html).not.toMatch(/<(a|textarea|input)\b/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('/affiliate on the first launch, before the cookie reaches the server: still only the notice', async () => {
    mockIsTwaServerSide.mockResolvedValueOnce(false);
    const { container } = await renderPage();
    expect(container.textContent).toBe(TWA_AFFILIATE_NOTICE);
    expect(container.querySelector('textarea')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('the lifetime page shows no package upsell', () => {
    const { container } = render(React.createElement(LifetimeDeal));
    expect(container.textContent).toBe(TWA_PLAN_NOTICE);
    expect(mockUseUser).not.toHaveBeenCalled();
  });
});

describe('in a normal browser', () => {
  beforeEach(() => launch('https://www.google.com/'));

  it('the affiliate page still loads its data', async () => {
    await act(async () => {
      render(React.createElement(AffiliateComponent));
    });
    expect(mockFetch).toHaveBeenCalledWith('/affiliates/me');
  });

  it('/affiliate still shows the join form with the payout field', async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = await renderPage());
    });
    await waitFor(() =>
      expect(container.querySelector('textarea')).not.toBeNull()
    );
    expect(container.textContent).not.toContain(TWA_AFFILIATE_NOTICE);
  });

  it('the lifetime page still runs', () => {
    render(React.createElement(LifetimeDeal));
    expect(mockUseUser).toHaveBeenCalled();
  });
});
