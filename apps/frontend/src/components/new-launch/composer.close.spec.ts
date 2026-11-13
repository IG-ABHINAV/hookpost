/**
 * Closing the composer: it asks "are you sure?" only when something changed
 * since it opened (the values, or a channel's settings form), and Escape
 * follows the same rule as the X button.
 *   pnpm exec jest -c apps/frontend/jest.config.ts composer.close
 */
import React, { createElement, useEffect } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import dayjs from 'dayjs';

// The real useT suspends until the locale files load
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));
// ESM-heavy widgets the provider wrapper imports but these tests never show
jest.mock('@hookpost/frontend/components/launches/internal.channels', () => ({
  InternalChannels: () => null,
}));
jest.mock('@hookpost/frontend/components/media/media.component', () => ({
  MediaComponent: () => null,
}));
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => async () => ({ json: async () => ({ internalPlugs: [] }) }),
}));
// The canonical-link picker: choosing a post resolves with its reference
jest.mock(
  '@hookpost/frontend/components/post-url-selector/post.url.selector',
  () => ({ useShowPostSelector: () => async () => '(post:abc)' })
);
// react-hotkeys-hook ships ESM only; this stands in for its Escape binding
jest.mock('react-hotkeys-hook', () => ({
  useHotkeys: (
    key: string,
    callback: (event: KeyboardEvent) => void,
    deps: unknown[]
  ) => {
    const { useEffect } = jest.requireActual('react');
    useEffect(() => {
      const listener = (event: KeyboardEvent) => {
        if (event.key === key) {
          callback(event);
        }
      };
      document.addEventListener('keydown', listener);
      return () => document.removeEventListener('keydown', listener);
    }, deps);
  },
}));

import { useLaunchStore } from '@hookpost/frontend/components/new-launch/store';
import {
  composerSnapshot,
  isComposerDirty,
} from '@hookpost/frontend/components/new-launch/composer.dirty';
import { withProvider } from '@hookpost/frontend/components/new-launch/providers/high.order.provider';
import { PostComment } from '@hookpost/frontend/components/new-launch/providers/post-comment.enum';
import { useSettings } from '@hookpost/frontend/components/launches/helpers/use.values';
import { Canonical } from '@hookpost/react/form/canonical';
import { CustomSelect } from '@hookpost/react/form/custom.select';
import { Total } from '@hookpost/react/form/total';
import {
  Component as ModalComponent,
  useModalCloseHandler,
} from '@hookpost/frontend/components/layout/new-modal';

const channel = (id: string) =>
  ({
    id,
    name: id,
    identifier: 'x',
    picture: '',
    additionalSettings: '[]',
  } as any);

// What AddEditModal does when an existing post opens
const openExistingPost = () => {
  const store = useLaunchStore.getState();
  store.reset();
  store.setAllIntegrations([channel('int-1'), channel('int-2')]);
  store.setDate(dayjs('2026-10-20T10:00:00Z'));
  store.addOrRemoveSelectedIntegration(channel('int-1'), {});
  store.setRepeater(0);
  store.setTags([{ label: 'launch', value: 'launch' }]);
  store.addInternalValue(0, 'int-1', [
    {
      id: 'post-1',
      content: '<p>hello</p>',
      delay: 0,
      media: [{ id: 'm1', path: 'https://media.hookstep.in/a.mp4' }],
    },
  ]);
  store.addGlobalValue(0, [{ id: 'g1', content: '', delay: 0, media: [] }]);
  store.markComposerClean();
};

const dirty = () => isComposerDirty(useLaunchStore.getState());

afterEach(() => {
  cleanup();
  useLaunchStore.getState().reset();
});

describe('isComposerDirty', () => {
  beforeEach(openExistingPost);

  it('is clean when nothing was touched, so closing does not ask', () => {
    expect(dirty()).toBe(false);
  });

  it('is dirty after the text changes, and clean again once it is put back', () => {
    useLaunchStore.getState().setInternalValueText('int-1', 0, '<p>hello!</p>');
    expect(dirty()).toBe(true);
    useLaunchStore.getState().setInternalValueText('int-1', 0, '<p>hello</p>');
    expect(dirty()).toBe(false);
  });

  it('counts media, channels, date, tags and repeat as changes', () => {
    const changes: Array<() => void> = [
      () => useLaunchStore.getState().removeInternalValueMedia('int-1', 0, 0),
      () =>
        useLaunchStore
          .getState()
          .addOrRemoveSelectedIntegration(channel('int-2'), {}),
      () => useLaunchStore.getState().setDate(dayjs('2026-10-21T10:00:00Z')),
      () => useLaunchStore.getState().setTags([]),
      () => useLaunchStore.getState().setRepeater(7),
      () =>
        useLaunchStore.getState().setInternalValueMedia('int-1', 0, [
          {
            id: 'm1',
            path: 'https://media.hookstep.in/a.mp4',
            alt: 'a cat',
          } as any,
        ]),
    ];
    for (const change of changes) {
      openExistingPost();
      change();
      expect(dirty()).toBe(true);
    }
  });

  it('is dirty when a channel settings form reports an edit', () => {
    useLaunchStore.getState().setSettingsDirty('int-1', true);
    expect(dirty()).toBe(true);
    useLaunchStore.getState().setSettingsDirty('int-1', false);
    expect(dirty()).toBe(false);
  });

  it('switching tabs or the preview is not a change', () => {
    useLaunchStore.getState().setCurrent('global');
    useLaunchStore.getState().setTab(1);
    useLaunchStore.getState().setChars('int-1', 280);
    expect(dirty()).toBe(false);
  });

  it('always asks for content that was never marked clean (generated posts)', () => {
    useLaunchStore.getState().reset();
    useLaunchStore
      .getState()
      .addGlobalValue(0, [
        { id: 'g1', content: '<p>AI</p>', delay: 0, media: [] },
      ]);
    expect(dirty()).toBe(true);
  });

  it('forgets the baseline and the settings edits when the composer closes', () => {
    useLaunchStore.getState().setSettingsDirty('int-1', true);
    useLaunchStore.getState().reset();
    expect(useLaunchStore.getState().composerBaseline).toBeUndefined();
    expect(useLaunchStore.getState().settingsDirty).toEqual({});
  });

  it('ignores value ids, which the user never edits', () => {
    const state = useLaunchStore.getState();
    expect(
      composerSnapshot({
        ...state,
        internal: state.internal.map((p) => ({
          ...p,
          integrationValue: p.integrationValue.map((v) => ({
            ...v,
            id: 'other',
          })),
        })),
      })
    ).toBe(state.composerBaseline);
  });
});

describe("a channel's settings form", () => {
  // Fills one value in by itself, like TikTok's creator limits, and has a
  // field and a picker the user changes
  const TestSettings = () => {
    const { register, setValue } = useSettings();
    useEffect(() => {
      setValue('filled_in', 'by itself');
    }, []);
    return createElement(
      'div',
      null,
      createElement('input', { 'aria-label': 'title', ...register('title') }),
      createElement(
        'button',
        {
          type: 'button',
          onClick: () => setValue('tags', ['news'], { shouldDirty: true }),
        },
        'pick a tag'
      )
    );
  };
  const TestProvider = withProvider({
    postComment: PostComment.ALL,
    minimumCharacters: [],
    SettingsComponent: TestSettings,
    maximumCharacters: 1000,
  });

  const renderSettings = async (saved?: Record<string, unknown>) => {
    const portal = document.createElement('div');
    portal.id = 'social-settings';
    document.body.appendChild(portal);
    openExistingPost();
    if (saved) {
      // an existing post opens with its saved settings
      useLaunchStore
        .getState()
        .setSelectedIntegrations([
          { selectedIntegrations: channel('int-1'), settings: saved },
        ]);
      useLaunchStore.getState().markComposerClean();
    }
    useLaunchStore.getState().setCurrent('int-1');
    await act(async () => {
      render(createElement(TestProvider as any, { id: 'int-1' }));
    });
    return () => portal.remove();
  };

  it('values it fills in by itself are not an edit', async () => {
    const remove = await renderSettings();
    expect(useLaunchStore.getState().settingsDirty['int-1']).toBeFalsy();
    expect(dirty()).toBe(false);
    remove();
  });

  it('typing in a field is an edit', async () => {
    const remove = await renderSettings();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('title'), {
        target: { value: 'My title' },
      });
    });
    expect(useLaunchStore.getState().settingsDirty['int-1']).toBe(true);
    expect(dirty()).toBe(true);
    remove();
  });

  it('a saved post opens clean, and changing a saved value is an edit', async () => {
    const remove = await renderSettings({ title: 'Saved title' });
    expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe(
      'Saved title'
    );
    expect(dirty()).toBe(false);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('title'), {
        target: { value: 'New title' },
      });
    });
    expect(dirty()).toBe(true);
    remove();
  });

  it('a pick written with setValue(shouldDirty) is an edit', async () => {
    const remove = await renderSettings();
    await act(async () => {
      fireEvent.click(screen.getByText('pick a tag'));
    });
    expect(dirty()).toBe(true);
    remove();
  });
});

describe("the shared settings pickers (Dev.to, Hashnode, Medium, Reddit)", () => {
  const PickerSettings = () => {
    const { setValue } = useSettings();
    useEffect(() => {
      setValue('total', 1);
    }, []);
    return createElement(
      'div',
      null,
      createElement(Canonical, {
        name: 'canonical',
        label: 'Canonical Link',
        date: dayjs('2026-10-20T10:00:00Z'),
      }),
      createElement(CustomSelect, {
        name: 'flair',
        label: 'Flair',
        placeholder: 'Pick a flair',
        options: [{ value: 'news', label: 'News' }],
      }),
      createElement(Total, { name: 'total' })
    );
  };
  const PickerProvider = withProvider({
    postComment: PostComment.ALL,
    minimumCharacters: [],
    SettingsComponent: PickerSettings,
    maximumCharacters: 1000,
  });

  const renderPickers = async () => {
    const portal = document.createElement('div');
    portal.id = 'social-settings';
    document.body.appendChild(portal);
    openExistingPost();
    useLaunchStore.getState().setCurrent('int-1');
    await act(async () => {
      render(createElement(PickerProvider as any, { id: 'int-1' }));
    });
    expect(dirty()).toBe(false);
    return () => portal.remove();
  };

  it('picking a canonical post with the lightning icon is an edit', async () => {
    const remove = await renderPickers();
    const icon = screen
      .getByText('Canonical Link')
      .closest('div.items-center')!
      .querySelector('svg')!;
    await act(async () => {
      fireEvent.click(icon);
    });
    expect(dirty()).toBe(true);
    remove();
  });

  it('choosing an option in a custom select is an edit', async () => {
    const remove = await renderPickers();
    await act(async () => {
      fireEvent.click(screen.getByText('Pick a flair'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('News'));
    });
    expect(dirty()).toBe(true);
    remove();
  });

  it('changing a total is an edit', async () => {
    const remove = await renderPickers();
    await act(async () => {
      fireEvent.click(screen.getByText('1').nextSibling as Element);
    });
    expect(screen.getByText('2')).toBeTruthy();
    expect(dirty()).toBe(true);
    remove();
  });
});

describe('Escape on a modal', () => {
  const open = (children: any, askClose = false) => {
    const closeModal = jest.fn();
    render(
      createElement(ModalComponent, {
        closeModal,
        zIndex: 200,
        isLast: true,
        modal: {
          id: 'add-edit-modal',
          removeLayout: true,
          askClose,
          children,
        },
      })
    );
    return closeModal;
  };

  it("runs the content's own close (the composer's X rule) instead of asking", async () => {
    const handler = jest.fn();
    const Content = () => {
      useModalCloseHandler(handler);
      return createElement('div', null, 'composer');
    };
    const closeModal = open(createElement(Content), true);
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(closeModal).not.toHaveBeenCalled();
  });

  it('leaves the content open when a widget inside already handled the Escape', async () => {
    const handler = jest.fn();
    const Content = () => {
      useModalCloseHandler(handler);
      // like the emoji picker, which closes its own search on Escape
      return createElement('input', {
        'data-testid': 'emoji-search',
        ref: (el: HTMLInputElement | null) =>
          el?.addEventListener('keydown', (e) => e.preventDefault()),
      });
    };
    const closeModal = open(createElement(Content), true);
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('emoji-search'), {
        key: 'Escape',
        code: 'Escape',
      });
    });
    expect(handler).not.toHaveBeenCalled();
    expect(closeModal).not.toHaveBeenCalled();
  });

  it('still closes a modal whose content sets no handler', async () => {
    const closeModal = open(createElement('div', null, 'plain'));
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    });
    expect(closeModal).toHaveBeenCalledWith('add-edit-modal');
  });
});
