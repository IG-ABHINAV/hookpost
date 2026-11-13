/**
 * The browser's failure beacon: an endless spinner, an error page or a
 * connect that never came back is reported to POST /public/client-event,
 * because production has no Sentry or PostHog and these left no trace.
 *   pnpm exec jest -c apps/frontend/jest.config.ts client.event
 */
import React from 'react';
import { act, render } from '@testing-library/react';
import {
  reportClientEvent,
  resetClientEventsForTest,
  SPINNER_STUCK_MS,
} from '@hookpost/frontend/components/layout/client.event';
import { LoadingComponent } from '@hookpost/frontend/components/layout/loading';

const beacon = jest.fn(async () => ({ ok: true }));

beforeEach(() => {
  beacon.mockClear();
  resetClientEventsForTest();
  (window as any).fetch = beacon;
  window.history.replaceState({}, '', '/integrations/social/x?code=secret&state=s');
});

const sentBodies = () =>
  beacon.mock.calls.map((c: any[]) => JSON.parse(c[1].body));

describe('reportClientEvent', () => {
  it('posts the event and the path, never the query string', () => {
    reportClientEvent('connect_page_error', { provider: 'x', reason: 'code must be a string' });
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, init] = beacon.mock.calls[0] as any[];
    expect(url).toMatch(/\/public\/client-event$/);
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'include' });
    expect(sentBodies()[0]).toEqual({
      event: 'connect_page_error',
      path: '/integrations/social/x',
      provider: 'x',
      reason: 'code must be a string',
    });
  });

  it('once per event, page and provider', () => {
    reportClientEvent('spinner_stuck', { ms: 15000 });
    reportClientEvent('spinner_stuck', { ms: 15000 });
    reportClientEvent('connect_abandoned', { provider: 'x' });
    reportClientEvent('connect_abandoned', { provider: 'linkedin' });
    expect(sentBodies().map((b) => `${b.event}:${b.provider || ''}`)).toEqual([
      'spinner_stuck:',
      'connect_abandoned:x',
      'connect_abandoned:linkedin',
    ]);
  });

  it('never throws, even with no fetch at all', () => {
    (window as any).fetch = undefined;
    expect(() => reportClientEvent('page_error', { reason: 'boom' })).not.toThrow();
  });
});

describe('LoadingComponent', () => {
  it('reports a spinner still on screen after 15 seconds', () => {
    jest.useFakeTimers();
    try {
      window.history.replaceState({}, '', '/auth?provider=GOOGLE&code=spent');
      render(React.createElement(LoadingComponent));
      act(() => {
        jest.advanceTimersByTime(SPINNER_STUCK_MS - 1);
      });
      expect(beacon).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(sentBodies()).toEqual([{ event: 'spinner_stuck', path: '/auth', ms: 15000 }]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a spinner that goes away in time reports nothing', () => {
    jest.useFakeTimers();
    try {
      const { unmount } = render(React.createElement(LoadingComponent));
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      unmount();
      act(() => {
        jest.advanceTimersByTime(SPINNER_STUCK_MS);
      });
      expect(beacon).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
