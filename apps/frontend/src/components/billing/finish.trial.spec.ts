/**
 * /billing?finishTrial=true: what the customer is told after "Finish the
 * trial, charge me now".
 *   pnpm exec jest -c apps/frontend/jest.config.ts finish.trial
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react';

const mockFetch = jest.fn();
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
jest.mock('@hookpost/helpers/utils/timer', () => ({
  timer: () => Promise.resolve(),
}));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string, opts?: Record<string, string>) =>
    fallback.replace(/{{(\w+)}}/g, (_m, name) => opts?.[name] ?? ''),
}));
jest.mock(
  '@hookpost/frontend/components/launches/helpers/top.title.component',
  () => ({ TopTitle: ({ title }: { title: string }) => title })
);

import { FinishTrial } from '@hookpost/frontend/components/billing/finish.trial';

const json = (body: any, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

function respond(finishBody: any, finished: boolean, status = 200) {
  mockFetch.mockImplementation(async (url: string) =>
    url === '/billing/finish-trial'
      ? json(finishBody, status)
      : json({ finished })
  );
}

async function open() {
  await act(async () => {
    render(React.createElement(FinishTrial, { close: jest.fn() }));
  });
}

beforeEach(() => mockFetch.mockReset());

describe('FinishTrial', () => {
  it('a charge Razorpay took: the trial has ended', async () => {
    respond({ finish: true, startAt: null }, true);
    await open();
    expect(screen.getByText('Your trial has ended and subscription is active!')).toBeTruthy();
  });

  it('a UPI trial Razorpay would not charge early: nothing charged, first charge date, no success message', async () => {
    respond({ finish: false, startAt: '2026-10-20T10:00:00.000Z' }, false);
    await open();
    expect(screen.getByText('Nothing was charged')).toBeTruthy();
    expect(screen.getByText(/Your first charge is on 20 Oct 2026/)).toBeTruthy();
    expect(screen.queryByText(/subscription is active/)).toBeNull();
    expect(screen.queryByText(/without restrictions/)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalledWith('/billing/is-trial-finished');
  });

  it('no trial subscription: points to the plans instead', async () => {
    respond({ finish: false, startAt: null }, false);
    await open();
    expect(screen.getByText(/no trial subscription to charge/)).toBeTruthy();
    expect(screen.queryByText(/subscription is active/)).toBeNull();
  });

  it('a charge it could not confirm is not announced as a success', async () => {
    respond({ finish: true, startAt: null }, false);
    await open();
    expect(screen.getByText("We couldn't confirm the charge yet")).toBeTruthy();
    expect(screen.queryByText(/successfully/)).toBeNull();
    expect(screen.queryByText(/without restrictions/)).toBeNull();
  });

  it('a server error is not told it has no trial', async () => {
    respond({ statusCode: 500, message: 'Internal server error' }, false, 500);
    await open();
    expect(screen.getByText("We couldn't finish the trial")).toBeTruthy();
    // the charge may have gone through before the error
    expect(screen.queryByText(/nothing was charged/i)).toBeNull();
    expect(screen.queryByText(/no trial subscription to charge/)).toBeNull();
    expect(screen.queryByText(/subscription is active/)).toBeNull();
  });

  it('Razorpay unreachable: try again, not "no trial"', async () => {
    respond({ finish: false, startAt: null, error: true }, false);
    await open();
    expect(screen.getByText(/couldn't reach the payment provider/)).toBeTruthy();
    expect(screen.queryByText(/no trial subscription to charge/)).toBeNull();
  });

  it('a charge Razorpay never answered: may have gone through, so neither "nothing was charged" nor "try again"', async () => {
    respond({ finish: false, startAt: null, error: false, unknown: true }, false);
    await open();
    expect(screen.getByText("We couldn't finish the trial")).toBeTruthy();
    expect(screen.getByText(/Reload the billing page/)).toBeTruthy();
    expect(screen.queryByText(/nothing was charged/i)).toBeNull();
    expect(screen.queryByText(/no trial subscription to charge/)).toBeNull();
    expect(screen.queryByText(/subscription is active/)).toBeNull();
  });

  it('takes ?finishTrial off the address, so a reload does not ask again', async () => {
    window.history.replaceState(null, '', '/billing?finishTrial=true');
    respond({ finish: true, startAt: null }, true);
    await open();
    expect(window.location.search).toBe('');
  });
});
