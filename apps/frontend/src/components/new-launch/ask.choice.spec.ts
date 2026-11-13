/**
 * The composer's "What do you want to do?" chooser (Update on a published
 * post): picking an answer closes it, so it is not left on top of the
 * composer with buttons that no longer do anything.
 *   pnpm exec jest -c apps/frontend/jest.config.ts ask.choice
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
  useModals,
} from '@hookpost/frontend/components/layout/new-modal';
import { askChoice } from '@hookpost/frontend/components/new-launch/ask.choice';

let modals: ReturnType<typeof useModals>;
const Grab = () => {
  modals = useModals();
  return null;
};
const Page = () =>
  React.createElement(
    ModalManager,
    null,
    React.createElement(DecisionEverywhere),
    React.createElement(Grab)
  );

const flush = () => act(async () => undefined);

const button = (label: string, onClick: () => void) =>
  React.createElement('button', { type: 'button', onClick }, label);

async function openChooser() {
  let answer: string | null | undefined;
  let settled = false;
  await act(async () => {
    askChoice<'update' | 'republish'>(modals, {
      title: 'What do you want to do?',
      children: (choose) =>
        React.createElement(
          'div',
          null,
          React.createElement('div', null, 'This post was already published.'),
          button('Just update the post details', () => choose('update')),
          button('Republish the post', () => choose('republish'))
        ),
    }).then((value) => {
      answer = value;
      settled = true;
    });
  });
  expect(screen.getByText('This post was already published.')).toBeTruthy();
  return { answer: () => answer, settled: () => settled };
}

describe('askChoice', () => {
  beforeEach(() => {
    render(React.createElement(Page));
  });
  afterEach(() => {
    act(() => modals.closeAll());
    decisionModalEmitter.removeAllListeners('open');
  });

  it('picking an answer gives it back and closes the chooser', async () => {
    const res = await openChooser();
    fireEvent.click(screen.getByText('Republish the post'));
    await flush();
    expect(res.answer()).toBe('republish');
    expect(screen.queryByText('This post was already published.')).toBeNull();
  });

  it('Republish, then "No, pick another time" on the past-time dialog: back to the composer, no chooser left behind', async () => {
    const res = await openChooser();
    fireEvent.click(screen.getByText('Republish the post'));
    await flush();
    expect(res.answer()).toBe('republish');

    let publishNow: boolean | undefined;
    await act(async () => {
      areYouSure({
        title: 'This time has passed',
        description: 'The time you picked has already passed.',
        approveLabel: 'Yes, publish now',
        cancelLabel: 'No, pick another time',
      }).then((value) => (publishNow = value));
    });
    fireEvent.click(screen.getByText('No, pick another time'));
    await flush();

    expect(publishNow).toBe(false);
    expect(screen.queryByText('The time you picked has already passed.')).toBeNull();
    expect(screen.queryByText('This post was already published.')).toBeNull();
    expect(screen.queryByText('Republish the post')).toBeNull();
  });

  it('the X answers null instead of leaving the caller waiting', async () => {
    const res = await openChooser();
    const close = document.querySelector('button.mantine-Modal-close');
    expect(close).toBeTruthy();
    fireEvent.click(close!);
    await flush();
    expect(res.settled()).toBe(true);
    expect(res.answer()).toBeNull();
    expect(screen.queryByText('This post was already published.')).toBeNull();
  });
});
