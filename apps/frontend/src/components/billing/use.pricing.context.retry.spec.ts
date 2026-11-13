/**
 * The marketing pages ask /api/public/pricing-context once more before
 * falling back. A deploy restarts the backend, and on 11-21 Oct six visitors
 * got a 502 there and kept the fallback for their whole visit.
 *   pnpm exec jest -c apps/frontend/jest.config.ts use.pricing.context.retry
 */
import React from 'react';
import { act, render } from '@testing-library/react';
import {
  PRICING_RETRY_MS,
  usePublicPricingContextState,
} from '@hookpost/frontend/components/billing/use.pricing.context';

const CONTEXT = {
  displayCurrency: 'USD',
  chargeCurrency: 'USD',
  lockedCurrency: null,
  checkoutAllowed: true,
  region: { country: 'US', tzSaysIndia: false, ipSaysIndia: false },
  prices: { STANDARD: { month: 15, year: 150 }, PRO: { month: 49, year: 490 } },
};

const seen: Array<{ ctx: any; settled: boolean }> = [];
const Probe = () => {
  const state = usePublicPricingContextState();
  seen.push(state);
  return null;
};
const last = () => seen[seen.length - 1];

const reply = (ok: boolean, body: unknown = {}) =>
  Promise.resolve({ ok, json: async () => body });

beforeEach(() => {
  seen.length = 0;
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** Mount, then let the request's own task run (it is not started inside the effect). */
const mount = async () => {
  render(React.createElement(Probe));
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  await flush();
};

describe('usePublicPricingContextState', () => {
  it('asks from a task of its own, not inside the effect flush (its first Intl call loads ICU)', async () => {
    const fetchMock = jest.fn(() => reply(true, CONTEXT));
    (global as any).fetch = fetchMock;
    render(React.createElement(Probe));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(last()).toEqual({ ctx: null, settled: false });
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(last()).toEqual({ ctx: CONTEXT, settled: true });
  });

  it('unmounting before that task runs asks nothing', async () => {
    const fetchMock = jest.fn(() => reply(true, CONTEXT));
    (global as any).fetch = fetchMock;
    const { unmount } = render(React.createElement(Probe));
    unmount();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 502 during a deploy is asked again once, and the second answer is used', async () => {
    const fetchMock = jest
      .fn()
      .mockReturnValueOnce(reply(false, { statusCode: 502 }))
      .mockReturnValueOnce(reply(true, CONTEXT));
    (global as any).fetch = fetchMock;
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(last().settled).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(PRICING_RETRY_MS);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(last()).toEqual({ ctx: CONTEXT, settled: true });
  });

  it('two failures settle on the fallback, with no third request', async () => {
    const fetchMock = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    (global as any).fetch = fetchMock;
    await mount();
    await act(async () => {
      jest.advanceTimersByTime(PRICING_RETRY_MS);
    });
    await flush();
    expect(last()).toEqual({ ctx: null, settled: true });
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a good first answer is used straight away, with no retry', async () => {
    const fetchMock = jest.fn(() => reply(true, CONTEXT));
    (global as any).fetch = fetchMock;
    await mount();
    expect(last()).toEqual({ ctx: CONTEXT, settled: true });
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
