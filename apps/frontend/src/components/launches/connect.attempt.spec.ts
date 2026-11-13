/**
 * A connect that left for the provider and never came back: 11 of 18
 * outsider connects on 6-22 Oct, and Hookpost said nothing when the person
 * returned. On 22 Oct an Android user tried X, Threads and LinkedIn and was
 * back on the calendar 4-7 s after each.
 *   pnpm exec jest -c apps/frontend/jest.config.ts connect.attempt
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

let mockQuery = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useSearchParams: () => mockQuery,
}));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));
const mockReport = jest.fn();
jest.mock('@hookpost/frontend/components/layout/client.event', () => ({
  reportClientEvent: (...args: unknown[]) => mockReport(...args),
}));

import {
  abandonedAttempt,
  abandonedConnect,
  abandonedConnectTip,
  channelIds,
  clearConnectAttempt,
  finishedElsewhere,
  rememberConnectStart,
} from '@hookpost/frontend/components/launches/connect.attempt';
import { AbandonedConnectCard } from '@hookpost/frontend/components/launches/abandoned.connect.card';

const T0 = 1_760_000_000_000;

beforeEach(() => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
  mockQuery = new URLSearchParams();
});

describe('abandonedConnect', () => {
  it('nothing started, nothing abandoned', () => {
    expect(abandonedConnect(T0)).toBeNull();
  });

  it('not while the browser may still be leaving (under 3 s)', () => {
    rememberConnectStart('x', T0);
    expect(abandonedConnect(T0 + 2_000)).toBeNull();
    expect(abandonedConnect(T0 + 4_000)).toBe('x');
  });

  it('a callback that came back clears it', () => {
    rememberConnectStart('linkedin', T0);
    clearConnectAttempt();
    expect(abandonedConnect(T0 + 10_000)).toBeNull();
  });

  it('forgets an attempt older than 30 minutes', () => {
    rememberConnectStart('threads', T0);
    expect(abandonedConnect(T0 + 31 * 60 * 1000)).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('keeps the ids of the channels the workspace had when it started', () => {
    rememberConnectStart('x', T0, undefined, ['a', 'b']);
    expect(abandonedAttempt(T0 + 5_000)).toEqual({ provider: 'x', at: T0, known: ['a', 'b'] });
    rememberConnectStart('x', T0);
    expect(abandonedAttempt(T0 + 5_000)).toEqual({ provider: 'x', at: T0 });
  });

  it('channelIds reads a channel list, and nothing from a missing one', () => {
    expect(channelIds([{ id: 'a' }, { id: 7 }, null, { id: 'b' }])).toEqual(['a', 'b']);
    expect(channelIds(undefined)).toBeNull();
  });

  it('finishedElsewhere: a new channel of that provider, and only that', () => {
    const attempt = { provider: 'x', at: T0, known: ['old-x'] };
    expect(finishedElsewhere(attempt, [{ id: 'old-x', identifier: 'x' }])).toBe(false);
    expect(finishedElsewhere(attempt, [{ id: 'new-li', identifier: 'linkedin' }])).toBe(false);
    expect(finishedElsewhere(attempt, [{ id: 'new-x', identifier: 'x' }])).toBe(true);
    // Without the starting list nothing can be told apart.
    expect(finishedElsewhere({ provider: 'x', at: T0 }, [{ id: 'new-x', identifier: 'x' }])).toBe(false);
  });

  it('says what each platform needs', () => {
    expect(abandonedConnectTip('instagram')).toContain('Facebook Page');
    expect(abandonedConnectTip('x')).toContain('X app');
    expect(abandonedConnectTip('lemmy')).toBe(
      "If Lemmy's app opened instead of its sign-in page, or the page closed, try again. Nothing was connected."
    );
  });
});

describe('AbandonedConnectCard', () => {
  const ago = (ms: number) => rememberConnectStart('linkedin', Date.now() - ms);

  it('back on the calendar with no new channel: offers help and reports it', () => {
    ago(5_000);
    render(React.createElement(AbandonedConnectCard, { onTryAgain: jest.fn() }));
    expect(screen.getByText("Didn't finish connecting LinkedIn?")).toBeTruthy();
    expect(mockReport).toHaveBeenCalledWith('connect_abandoned', { provider: 'linkedin' });
  });

  it('appears when the tab is shown again (an app opened instead, then Back)', () => {
    render(React.createElement(AbandonedConnectCard, { onTryAgain: jest.fn() }));
    expect(screen.queryByText(/Didn't finish connecting/)).toBeNull();
    ago(6_000);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.getByText("Didn't finish connecting LinkedIn?")).toBeTruthy();
  });

  it('after a finished connect (?added=) it says nothing and forgets the attempt', () => {
    ago(5_000);
    mockQuery = new URLSearchParams('added=linkedin');
    render(React.createElement(AbandonedConnectCard, { onTryAgain: jest.fn() }));
    expect(screen.queryByText(/Didn't finish connecting/)).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('finished in another tab (an app opened the callback there): no card, attempt forgotten', async () => {
    rememberConnectStart('x', Date.now() - 5_000, undefined, ['li-1']);
    const refreshChannels = jest.fn(async () => [
      { id: 'li-1', identifier: 'linkedin' },
      { id: 'x-1', identifier: 'x' },
    ]);
    render(React.createElement(AbandonedConnectCard, { onTryAgain: jest.fn(), refreshChannels }));
    await waitFor(() => expect(window.sessionStorage.length).toBe(0));
    expect(refreshChannels).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Didn't finish connecting/)).toBeNull();
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('the list fetched again has no new channel: the card shows', async () => {
    rememberConnectStart('x', Date.now() - 5_000, undefined, ['li-1']);
    const refreshChannels = jest.fn(async () => [{ id: 'li-1', identifier: 'linkedin' }]);
    render(React.createElement(AbandonedConnectCard, { onTryAgain: jest.fn(), refreshChannels }));
    expect(await screen.findByText("Didn't finish connecting X?")).toBeTruthy();
    expect(mockReport).toHaveBeenCalledWith('connect_abandoned', { provider: 'x' });
  });

  it('the list cannot be fetched: still offers help', async () => {
    rememberConnectStart('x', Date.now() - 5_000, undefined, []);
    const refreshChannels = jest.fn(async () => {
      throw new Error('offline');
    });
    render(React.createElement(AbandonedConnectCard, { onTryAgain: jest.fn(), refreshChannels }));
    expect(await screen.findByText("Didn't finish connecting X?")).toBeTruthy();
  });

  it('Try again opens Add Channel; either button puts the card away for good', () => {
    ago(5_000);
    const onTryAgain = jest.fn();
    render(React.createElement(AbandonedConnectCard, { onTryAgain }));
    fireEvent.click(screen.getByText('Try again'));
    expect(onTryAgain).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Didn't finish connecting/)).toBeNull();
    expect(abandonedConnect(Date.now() + 10_000)).toBeNull();
  });
});
