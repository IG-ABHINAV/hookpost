/**
 * TrialTracker on /launches?trialStart=true: the browser's StartTrial for
 * Meta, sent with the event id the server used for the same trial, so Meta
 * keeps one of the two.
 *   pnpm exec jest -c apps/frontend/jest.config.ts trial.tracker
 */
import React from 'react';
import { act, render } from '@testing-library/react';

jest.mock('@hookpost/frontend/components/layout/user.context', () => ({
  useUser: () => ({ id: 'user-1' }),
}));
jest.mock('@hookpost/react/helpers/variable.context', () => ({
  useVariables: () => ({}),
}));

import {
  START_TRIAL_EVENT_KEY,
  TrialTracker,
} from '@hookpost/frontend/components/layout/gtm.component';

const at = (url: string) => window.history.replaceState({}, '', url);

beforeEach(() => {
  jest.useFakeTimers();
  window.sessionStorage.clear();
  delete (window as any).fbq;
});
afterEach(() => {
  jest.useRealTimers();
  at('/');
});

describe('TrialTracker: Meta StartTrial', () => {
  it('waits for the lazily loaded pixel, then sends StartTrial once with the trial id', () => {
    at('/launches?onboarding=true&trialStart=true');
    window.sessionStorage.setItem(START_TRIAL_EVENT_KEY, 'trial_sub_1');
    render(React.createElement(TrialTracker));

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    const fbq = jest.fn();
    (window as any).fbq = fbq;
    act(() => {
      jest.advanceTimersByTime(600);
    });

    expect(fbq).toHaveBeenCalledTimes(1);
    expect(fbq).toHaveBeenCalledWith('track', 'StartTrial', {}, { eventID: 'trial_sub_1' });
    expect(window.sessionStorage.getItem(START_TRIAL_EVENT_KEY)).toBeNull();

    // A reload of the same URL sends nothing more.
    render(React.createElement(TrialTracker));
    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    expect(fbq).toHaveBeenCalledTimes(1);
  });

  it('sends nothing without trialStart, or without an id from checkout', () => {
    const fbq = jest.fn();
    (window as any).fbq = fbq;

    at('/launches');
    window.sessionStorage.setItem(START_TRIAL_EVENT_KEY, 'trial_sub_1');
    render(React.createElement(TrialTracker));
    at('/launches?trialStart=true');
    window.sessionStorage.clear();
    render(React.createElement(TrialTracker));
    act(() => {
      jest.advanceTimersByTime(30_000);
    });

    expect(fbq).not.toHaveBeenCalled();
  });

  it('with no pixel on the site it gives up quietly and clears the id', () => {
    at('/launches?onboarding=true&trialStart=true');
    window.sessionStorage.setItem(START_TRIAL_EVENT_KEY, 'trial_sub_1');
    render(React.createElement(TrialTracker));
    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    expect(window.sessionStorage.getItem(START_TRIAL_EVENT_KEY)).toBeNull();
  });
});
