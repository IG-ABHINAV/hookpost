/**
 * Two modules that every marketing page loads must stay free of the SDKs they
 * used to drag in: posthog-js (via UtmSaver -> useFireEvents) and
 * @sentry/nextjs (via global-error.tsx). Each mock below throws if anything
 * requires the SDK, so a static import sneaking back in fails here.
 *   pnpm exec jest -c apps/frontend/jest.config.ts
 */
import React from 'react';
import { render } from '@testing-library/react';

jest.mock('posthog-js', () => {
  throw new Error('posthog-js must not load on marketing pages');
});
jest.mock('posthog-js/react', () => {
  throw new Error('posthog-js must not load on marketing pages');
});
jest.mock('@sentry/nextjs', () => {
  throw new Error('@sentry/nextjs must not load with global-error');
});

let mockSearch = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearch,
}));

import UtmCapture from '@hookpost/helpers/utils/utm.capture';
import GlobalError from '@hookpost/frontend/app/global-error';

describe('UtmCapture (marketing pages)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSearch = new URLSearchParams();
  });

  it('records the first landing URL and referrer, and never overwrites them', () => {
    render(React.createElement(UtmCapture));
    expect(localStorage.getItem('landingUrl')).toBe(window.location.href);
    expect(localStorage.getItem('referrer')).toBe(document.referrer);

    localStorage.setItem('landingUrl', 'https://hookpost.hookstep.in/first');
    render(React.createElement(UtmCapture));
    expect(localStorage.getItem('landingUrl')).toBe('https://hookpost.hookstep.in/first');
  });

  it('stores the utm tag the way useUtmUrl reads it (JSON)', () => {
    mockSearch = new URLSearchParams('utm_source=meta');
    render(React.createElement(UtmCapture));
    expect(localStorage.getItem('utm')).toBe(JSON.stringify('meta'));
  });

  it('leaves a stored tag alone when the URL carries none', () => {
    localStorage.setItem('utm', JSON.stringify('meta'));
    render(React.createElement(UtmCapture));
    expect(localStorage.getItem('utm')).toBe(JSON.stringify('meta'));
  });

  it('falls back to ?utm= and ?ref= when there is no utm_source', () => {
    mockSearch = new URLSearchParams('ref=partner42');
    render(React.createElement(UtmCapture));
    expect(localStorage.getItem('utm')).toBe(JSON.stringify('partner42'));
  });
});

describe('global-error', () => {
  it('loads without importing Sentry', () => {
    // Outside every provider, as Next renders it: sentryDsn is ''.
    expect(typeof GlobalError).toBe('function');
  });
});
