/**
 * "Remind me to post" in the composer: per channel or for all of them, held
 * in the store the save reads (manage.modal.tsx sends remind per channel),
 * and counted as an edit when closing.
 *   pnpm exec jest -c apps/frontend/jest.config.ts remind.component
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (key: string, fallback?: any) =>
    typeof fallback === 'string' ? fallback : key,
}));

import { RemindComponent } from '@hookpost/frontend/components/new-launch/remind.component';
import { useLaunchStore } from '@hookpost/frontend/components/new-launch/store';
import {
  composerSnapshot,
  isComposerDirty,
} from '@hookpost/frontend/components/new-launch/composer.dirty';

const channel = (id: string, identifier: string, name: string) =>
  ({
    integration: { id, identifier, name, picture: '' },
    settings: {},
  } as any);

const select = (...channels: any[]) =>
  act(() => {
    useLaunchStore.setState({ selectedIntegrations: channels, reminders: {} });
  });

beforeEach(() => {
  act(() => useLaunchStore.getState().reset());
});

describe('RemindComponent', () => {
  it('shows nothing until a channel is picked', () => {
    render(React.createElement(RemindComponent));
    expect(screen.queryByTestId('remind-me-to-post')).toBeNull();
  });

  it('is off by default: posts auto-publish unless asked', () => {
    select(channel('ig', 'instagram', 'My IG'));
    render(React.createElement(RemindComponent));
    expect(screen.getByText('Remind me to post')).toBeTruthy();
    expect(useLaunchStore.getState().reminders).toEqual({});
  });

  it('sets one channel, and says how many of the picked ones remind', () => {
    select(channel('ig', 'instagram', 'My IG'), channel('li', 'linkedin', 'Me'));
    render(React.createElement(RemindComponent));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Remind me to post (add music in the app)')).toBeTruthy();
    fireEvent.click(screen.getByTestId('remind-ig'));
    expect(useLaunchStore.getState().reminders).toEqual({ ig: true });
    expect(screen.getByText('Remind me to post: 1/2')).toBeTruthy();
  });

  it('"All channels" sets and clears every picked channel', () => {
    select(channel('ig', 'instagram', 'My IG'), channel('tt', 'tiktok', 'My TikTok'));
    render(React.createElement(RemindComponent));
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByLabelText('All channels'));
    expect(useLaunchStore.getState().reminders).toEqual({ ig: true, tt: true });
    expect(screen.getByText('Remind me to post: all channels')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('All channels'));
    expect(useLaunchStore.getState().reminders).toEqual({ ig: false, tt: false });
  });

  it('closing asks after the reminder is changed, and reset() clears it', () => {
    select(channel('ig', 'instagram', 'My IG'));
    act(() => useLaunchStore.getState().markComposerClean());
    expect(isComposerDirty(useLaunchStore.getState())).toBe(false);
    act(() => useLaunchStore.getState().setReminder('ig', true));
    expect(isComposerDirty(useLaunchStore.getState())).toBe(true);
    act(() => useLaunchStore.getState().reset());
    expect(useLaunchStore.getState().reminders).toEqual({});
  });

  it('a reminder on a channel that was unpicked does not count', () => {
    const state = {
      selectedIntegrations: [{ integration: { id: 'li' } }],
      global: [],
      internal: [],
      reminders: { ig: true },
    };
    expect(composerSnapshot(state)).toBe(
      composerSnapshot({ ...state, reminders: {} })
    );
  });
});
