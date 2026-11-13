/**
 * Back on the calendar with an unsaved post: "Restore your unsaved post?"
 * reopens the composer with its text, media and channels.
 *   pnpm exec jest -c apps/frontend/jest.config.ts composer.draft.offer
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mockOpenModal = jest.fn();
const mockShowPost = jest.fn();
const mockFetch = jest.fn(async () => ({
  json: async () => ({ date: '2026-10-22T10:00:00Z' }),
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@hookpost/frontend/components/layout/new-modal', () => ({
  useModals: () => ({ openModal: mockOpenModal, closeAll: jest.fn() }),
}));
jest.mock('@hookpost/frontend/components/launches/calendar.context', () => ({
  useCalendar: () => ({
    integrations: [{ id: 'yt-1' }, { id: 'x-1' }],
    reloadCalendarView: jest.fn(),
    showPost: mockShowPost,
    sets: [{ id: 'set-1', content: '{}' }],
  }),
}));
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));
jest.mock('@hookpost/frontend/components/launches/calendar', () => ({
  SetSelectionModal: () => null,
}));
jest.mock('@hookpost/frontend/components/new-launch/add.edit.modal', () => ({
  AddEditModal: () => null,
}));
jest.mock('@hookpost/frontend/components/new-launch/modal.wrapper.component', () => ({
  ModalWrapperComponent: () => null,
}));
jest.mock('@hookpost/frontend/components/layout/user.context', () => ({
  useUser: () => ({ id: 'user-1', orgId: 'org-1' }),
}));

import { ComposerDraftOffer } from '@hookpost/frontend/components/launches/new.post';
import {
  draftFromState,
  loadDraft,
  saveDraft,
} from '@hookpost/frontend/components/new-launch/composer.draft';

const IMAGE = { id: 'm1', path: 'https://media.hookstep.in/ai-1.png' };

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

const saveRkDraft = () =>
  saveDraft(
    'user-1:org-1',
    draftFromState({
      global: [{ content: '<p>Join our NDA batch</p>', media: [IMAGE] }],
      selectedIntegrations: [
        { integration: { id: 'yt-1' } },
        // a channel since removed from the workspace
        { integration: { id: 'gone-1' } },
      ],
    })
  );

describe('ComposerDraftOffer', () => {
  it('nothing saved, nothing shown', () => {
    render(React.createElement(ComposerDraftOffer));
    expect(screen.queryByText('Restore your unsaved post?')).toBeNull();
  });

  it('Restore reopens the composer with the text, the image and the channels still here, with no Set prompt', async () => {
    saveRkDraft();
    render(React.createElement(ComposerDraftOffer));
    expect(screen.getByText('Restore your unsaved post?')).toBeTruthy();
    expect(screen.getByText(/Join our NDA batch/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('Restore'));
    });
    expect(mockOpenModal).toHaveBeenCalledTimes(1);
    const props = mockOpenModal.mock.calls[0][0].children.props;
    expect(mockOpenModal.mock.calls[0][0].id).toBe('add-edit-modal');
    expect(props.selectedChannels).toEqual(['yt-1']);
    expect(props.onlyValues).toEqual([
      { content: '<p>Join our NDA batch</p>', image: [IMAGE] },
    ]);
    expect(props.unsaved).toBe(true);
    // Once added, the calendar moves to where the post landed
    expect(props.onAdded).toBe(mockShowPost);
  });

  it('Discard forgets it', () => {
    saveRkDraft();
    render(React.createElement(ComposerDraftOffer));
    fireEvent.click(screen.getByText('Discard'));
    expect(screen.queryByText('Restore your unsaved post?')).toBeNull();
    expect(loadDraft('user-1:org-1')).toBeNull();
  });
});
