/**
 * The "are you sure?" dialog (areYouSure / deleteDialog): every way of
 * closing it settles the caller's promise, so a button waiting on it stops
 * spinning.
 *   pnpm exec jest -c apps/frontend/jest.config.ts decision-modal
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

// react-hotkeys-hook is ESM-only; a plain keydown listener stands in for it.
jest.mock('react-hotkeys-hook', () => ({
  useHotkeys: (key: string, callback: () => void, deps: any[]) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useEffect: useReactEffect } = require('react');
    useReactEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === key) callback();
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, deps);
  },
}));

import {
  areYouSure,
  DecisionEverywhere,
  decisionModalEmitter,
  ModalManager,
} from '@hookpost/frontend/components/layout/new-modal';

const Page = () =>
  React.createElement(ModalManager, null, React.createElement(DecisionEverywhere));

async function ask() {
  let answer: boolean | undefined;
  let settled = false;
  await act(async () => {
    areYouSure({
      title: 'Change payment method',
      description: 'Approve a new mandate?',
      approveLabel: 'Continue to Razorpay',
      cancelLabel: 'Not now',
    }).then((value) => {
      answer = value;
      settled = true;
    });
  });
  expect(screen.getByText('Approve a new mandate?')).toBeTruthy();
  return { answer: () => answer, settled: () => settled };
}

const flush = () => act(async () => undefined);

describe('areYouSure', () => {
  beforeEach(() => {
    render(React.createElement(Page));
  });
  afterEach(() => {
    // DecisionEverywhere subscribes once per mount and never unsubscribes.
    decisionModalEmitter.removeAllListeners('open');
  });

  it('the approve button answers yes', async () => {
    const res = await ask();
    fireEvent.click(screen.getByText('Continue to Razorpay'));
    await flush();
    expect(res.settled()).toBe(true);
    expect(res.answer()).toBe(true);
    expect(screen.queryByText('Approve a new mandate?')).toBeNull();
  });

  it('the cancel button answers no', async () => {
    const res = await ask();
    fireEvent.click(screen.getByText('Not now'));
    await flush();
    expect(res.answer()).toBe(false);
  });

  it('the X answers no instead of leaving the caller waiting', async () => {
    const res = await ask();
    const close = document.querySelector('button.mantine-Modal-close');
    expect(close).toBeTruthy();
    fireEvent.click(close!);
    await flush();
    expect(res.settled()).toBe(true);
    // Closed, not answered: undefined, which every caller reads as no.
    expect(res.answer()).toBeUndefined();
    expect(screen.queryByText('Approve a new mandate?')).toBeNull();
  });

  it('Escape answers no', async () => {
    const res = await ask();
    fireEvent.keyDown(document, { key: 'Escape' });
    await flush();
    expect(res.settled()).toBe(true);
    // Closed, not answered: undefined, which every caller reads as no.
    expect(res.answer()).toBeUndefined();
  });

  it('a click on the backdrop answers no', async () => {
    const res = await ask();
    const backdrop = screen
      .getByText('Approve a new mandate?')
      .closest('.bg-popup');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    await flush();
    expect(res.settled()).toBe(true);
    // Closed, not answered: undefined, which every caller reads as no.
    expect(res.answer()).toBeUndefined();
  });
});
