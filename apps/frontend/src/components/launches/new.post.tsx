import React, { FC, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useRouter, useSearchParams } from 'next/navigation';
import { useModals } from '@hookpost/frontend/components/layout/new-modal';
import dayjs from 'dayjs';
import { useCalendar } from '@hookpost/frontend/components/launches/calendar.context';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { SetSelectionModal } from '@hookpost/frontend/components/launches/calendar';
import { AddEditModal } from '@hookpost/frontend/components/new-launch/add.edit.modal';
import { ModalWrapperComponent } from '@hookpost/frontend/components/new-launch/modal.wrapper.component';
import {
  clearDraft,
  ComposerDraft,
  draftScope,
  draftSummary,
  loadDraft,
} from '@hookpost/frontend/components/new-launch/composer.draft';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { useLaunchStore } from '@hookpost/frontend/components/new-launch/store';

/**
 * Opens the composer at the next free slot, asking for a Set first when the
 * workspace has any. `selectedChannels` pre-selects channels by id.
 */
export const useCreatePost = () => {
  const fetch = useFetch();
  const modal = useModals();
  const { integrations, reloadCalendarView, sets, showPost } = useCalendar();
  const t = useT();

  const createAPost = useCallback(
    async (
      selectedChannels?: string[],
      // An unsaved post brought back (composer.draft.ts): opened as it was,
      // without asking for a Set.
      restore?: ComposerDraft
    ) => {
      const date = (await (await fetch('/posts/find-slot')).json()).date;

      const set: any = !sets.length || restore
        ? undefined
        : await new Promise((resolve) => {
            modal.openModal({
              title: t('select_set', 'Select a Set'),
              closeOnClickOutside: true,
              closeOnEscape: true,
              withCloseButton: false,
              onClose: () => resolve('exit'),
              classNames: {
                modal: 'text-textColor',
              },
              children: (
                <SetSelectionModal
                  sets={sets}
                  onSelect={(selectedSet) => {
                    resolve(selectedSet);
                    modal.closeAll();
                  }}
                  onContinueWithoutSet={() => {
                    resolve(undefined);
                    modal.closeAll();
                  }}
                />
              ),
            });
          });

      if (set === 'exit') return;

      modal.openModal({
        id: 'add-edit-modal',
        closeOnClickOutside: false,
        removeLayout: true,
        closeOnEscape: false,
        withCloseButton: false,
        askClose: true,
        fullScreen: true,
        classNames: {
          modal: 'w-[100%] max-w-[1400px] text-textColor',
        },
        children: (
          <AddEditModal
            allIntegrations={integrations.map((p) => ({
              ...p,
            }))}
            {...(set?.content ? { set: JSON.parse(set.content) } : {})}
            reopenModal={() => createAPost()}
            mutate={reloadCalendarView}
            onAdded={showPost}
            integrations={integrations}
            {...(selectedChannels?.length && !set?.content
              ? { selectedChannels }
              : {})}
            {...(restore
              ? {
                  unsaved: true,
                  onlyValues: restore.values.map((value) => ({
                    content: value.content,
                    image: value.media,
                  })),
                }
              : {})}
            date={dayjs.utc(date).local()}
          />
        ),
        size: '80%',
        title: ``,
      });
    },
    [integrations, sets, showPost]
  );

  return createAPost;
};

/**
 * /launches?compose=<channel id> opens the composer once, with that channel
 * selected ("first" selects none). The onboarding's "Write your first post"
 * links here: the onboarding is a modal outside the calendar, and the composer
 * needs the calendar's channels, Sets and reload. Rendered once, inside
 * CalendarWeekProvider.
 */
export const ComposeFromQuery: FC = () => {
  const search = useSearchParams();
  const router = useRouter();
  const createAPost = useCreatePost();
  const compose = search.get('compose');
  const opened = useRef(false);

  useEffect(() => {
    if (!compose) {
      opened.current = false;
      return;
    }
    if (opened.current) {
      return;
    }
    opened.current = true;
    router.replace('/launches');
    createAPost(compose === 'first' ? undefined : [compose]);
  }, [compose]);

  return null;
};

export const NewPost: FC<{
  // The one-row channel strip (launches/channel.strip.tsx): a 44px icon button
  // on a phone, with its label from md up.
  compact?: boolean;
}> = ({ compact }) => {
  const t = useT();
  const createAPost = useCreatePost();

  return (
    <button
      onClick={() => createAPost()}
      {...(compact && {
        'aria-label': t('create_new_post', 'Create Post'),
        title: t('create_new_post', 'Create Post'),
      })}
      className={clsx(
        'text-hp-on-primary min-h-[44px] max-h-[44px] rounded-md bg-btnPrimary flex justify-center items-center gap-[5px] outline-none',
        compact
          ? 'shrink-0 min-w-[44px] px-[10px] md:px-[16px]'
          : 'flex-1 pt-[12px] pb-[14px] ps-[16px] pe-[20px] group-[.sidebar]:p-0'
      )}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="21"
        height="20"
        viewBox="0 0 21 20"
        fill="none"
        className="min-w-[21px] min-h-[20px]"
      >
        <path
          d="M10.5001 4.16699V15.8337M4.66675 10.0003H16.3334"
          stroke="white"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div
        className={clsx(
          'text-start text-[14px]',
          compact
            ? 'hidden md:block whitespace-nowrap'
            : 'flex-1 group-[.sidebar]:hidden'
        )}
      >
        {t('create_new_post', 'Create Post')}
      </div>
    </button>
  );
};

/**
 * "You have an unsaved post" on the calendar, when a new post was being
 * written and the page was left before it was posted or closed (an OAuth
 * login, Back, a reload, a closed tab). Restore reopens the composer with its
 * text, media and channels; Discard forgets it. Rendered inside
 * CalendarWeekProvider. See composer.draft.ts.
 */
export const ComposerDraftOffer: FC = () => {
  const t = useT();
  const user = useUser();
  const createAPost = useCreatePost();
  const { integrations } = useCalendar();
  const scope = draftScope(user as any);
  const composerOpen = useLaunchStore(
    (state) => state.global.length > 0 || state.internal.length > 0
  );
  const [draft, setDraft] = useState<ComposerDraft | null>(null);

  // On load, and whenever a composer closes: that composer may have saved,
  // replaced or removed the draft.
  useEffect(() => {
    if (scope && !composerOpen) {
      setDraft(loadDraft(scope));
    }
  }, [scope, composerOpen]);

  if (!draft || !scope || composerOpen) {
    return null;
  }

  const restore = () => {
    const current = loadDraft(scope) || draft;
    setDraft(null);
    const known = new Set(integrations.map((i) => i.id));
    createAPost(
      current.channels.filter((id) => known.has(id)),
      current
    );
  };
  const discard = () => {
    clearDraft(scope);
    setDraft(null);
  };

  return (
    <div
      role="status"
      className="flex flex-col sm:flex-row sm:items-center gap-[12px] rounded-[12px] border border-btnPrimary/40 bg-btnPrimary/10 p-[14px] text-[14px]"
    >
      <div className="flex-1 min-w-0">
        <div className="font-[600]">
          {t('restore_unsaved_post', 'Restore your unsaved post?')}
        </div>
        <div className="opacity-80 mt-[4px] truncate">
          {dayjs(draft.savedAt).format('D MMM, HH:mm')} · {draftSummary(draft)}
        </div>
      </div>
      <div className="flex gap-[8px] shrink-0">
        <button
          type="button"
          onClick={restore}
          className="h-[40px] px-[16px] rounded-[8px] bg-btnPrimary text-hp-on-primary font-[600]"
        >
          {t('restore', 'Restore')}
        </button>
        <button
          type="button"
          onClick={discard}
          className="h-[40px] px-[16px] rounded-[8px] border border-tableBorder"
        >
          {t('discard', 'Discard')}
        </button>
      </div>
    </div>
  );
};
