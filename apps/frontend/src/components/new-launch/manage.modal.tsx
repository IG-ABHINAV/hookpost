'use client';

import React, {
  FC,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSWRConfig } from 'swr';
import { AddEditModalProps } from '@hookpost/frontend/components/new-launch/add.edit.modal';
import clsx from 'clsx';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { PicksSocialsComponent } from '@hookpost/frontend/components/new-launch/picks.socials.component';
import { EditorWrapper } from '@hookpost/frontend/components/new-launch/editor';
import { SelectCurrent } from '@hookpost/frontend/components/new-launch/select.current';
import { ShowAllProviders } from '@hookpost/frontend/components/new-launch/providers/show.all.providers';
import { useExistingData } from '@hookpost/frontend/components/launches/helpers/use.existing.data';
import { useLaunchStore } from '@hookpost/frontend/components/new-launch/store';
import { DatePicker } from '@hookpost/frontend/components/launches/helpers/date.picker';
import { useShallow } from 'zustand/react/shallow';
import { RepeatComponent } from '@hookpost/frontend/components/launches/repeat.component';
import { RemindComponent } from '@hookpost/frontend/components/new-launch/remind.component';
import { TagsComponent } from '@hookpost/frontend/components/launches/tags.component';
import { useToaster } from '@hookpost/react/toaster/toaster';
import { deleteDialog } from '@hookpost/react/helpers/delete.dialog';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import {
  useModalCloseHandler,
  useModals,
} from '@hookpost/frontend/components/layout/new-modal';
import { capitalize } from 'lodash';
import { SelectCustomer } from '@hookpost/frontend/components/launches/select.customer';
import { CopilotPopup } from '@copilotkit/react-ui';
import { DummyCodeComponent } from '@hookpost/frontend/components/new-launch/dummy.code.component';
import { CreationMethodBadge } from '@hookpost/frontend/components/launches/creation.method.badge';
import {
  SettingsIcon,
  ChevronDownIcon,
  CloseIcon,
  TrashIcon,
  DropdownArrowSmallIcon,
} from '@hookpost/frontend/components/ui/icons';
import { useHasScroll } from '@hookpost/frontend/components/ui/is.scroll.hook';
import { useShortlinkPreference } from '@hookpost/frontend/components/settings/shortlink-preference.component';
import dayjs from 'dayjs';
import { Button } from '@hookpost/react/form/button';
import { recordSuccessfulPost } from '@hookpost/frontend/components/layout/rate-prompt';
import { readablePostError } from '@hookpost/helpers/utils/post.error';
import {
  isPastScheduleTime,
  submitPost,
} from '@hookpost/frontend/components/new-launch/post.save.error';
import { askChoice } from '@hookpost/frontend/components/new-launch/ask.choice';
import { isComposerDirty } from '@hookpost/frontend/components/new-launch/composer.dirty';
import {
  channelsWithMissingMedia,
  existingMediaPaths,
  useMissingMediaCheck,
} from '@hookpost/frontend/components/new-launch/composer.media';
import { republishReason } from '@hookpost/frontend/components/launches/calendar.helpers';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { useIsTwa } from '@hookpost/frontend/components/layout/twa.component';
import {
  TRIAL_CTA_HREF,
  trialRequiredCta,
} from '@hookpost/frontend/components/layout/trial.cta';

export const ManageModal: FC<AddEditModalProps> = (props) => {
  const t = useT();
  const fetch = useFetch();
  const ref = useRef(null);
  const existingData = useExistingData();
  // A failed post, or a failed comment under a published one, says why it
  // failed rather than only the red mark on the calendar
  const failedIndex = useMemo(
    () => (existingData?.posts || []).findIndex((p) => p.state === 'ERROR'),
    [existingData]
  );
  const failedPost =
    failedIndex === -1 ? undefined : existingData.posts[failedIndex];
  const failureReason = useMemo(
    () => readablePostError(failedPost?.error),
    [failedPost]
  );
  const [loading, setLoading] = useState(false);
  const toaster = useToaster();
  const modal = useModals();
  const [showSettings, setShowSettings] = useState(false);
  const [showPostNow, setShowPostNow] = useState(false);
  const { data: shortlinkPreferenceData } = useShortlinkPreference();

  const { addEditSets, mutate, customClose, dummy, unsaved, onAdded } =
    props;

  const {
    selectedIntegrations,
    hide,
    date,
    setDate,
    repeater,
    setRepeater,
    tags,
    setTags,
    integrations,
    setSelectedIntegrations,
    locked,
    current,
    activateExitButton,
    setHide,
    publishBlocked,
    markComposerClean,
  } = useLaunchStore(
    useShallow((state) => ({
      hide: state.hide,
      setHide: state.setHide,
      date: state.date,
      setDate: state.setDate,
      current: state.current,
      repeater: state.repeater,
      setRepeater: state.setRepeater,
      tags: state.tags,
      setTags: state.setTags,
      selectedIntegrations: state.selectedIntegrations,
      integrations: state.integrations,
      setSelectedIntegrations: state.setSelectedIntegrations,
      locked: state.locked,
      activateExitButton: state.activateExitButton,
      publishBlocked: state.publishBlocked,
      markComposerClean: state.markComposerClean,
    }))
  );

  // What the composer holds now is what closing compares against, so it asks
  // only after a change. Content handed in that exists nowhere else
  // (generated posts) is never clean.
  useEffect(() => {
    if (!unsaved) {
      markComposerClean();
    }
  }, []);

  // A file purged from storage (a failed post's video, a week after its
  // group published) cannot be published again. A published post is left
  // alone: its files are expected to go, and "Just update the post details"
  // must stay possible; republishing it is refused by the backend instead.
  const isPublished = existingData?.posts?.[0]?.state === 'PUBLISHED';
  useMissingMediaCheck(
    existingData?.integration ? existingMediaPaths(existingData.posts) : [],
    !dummy && !isPublished
  );
  const missingMediaChannels = useLaunchStore(
    useShallow(channelsWithMissingMedia)
  );
  const missingMediaMessage =
    !isPublished && missingMediaChannels.length
      ? t(
          'post_media_removed_from_storage',
          "This post's video/image was removed from storage. Upload it again before retrying."
        )
      : '';

  // A provider can stop publishing until the user acts (TikTok's disclosure
  // choice, creator_info saying the creator can't post), and so does a file
  // that is gone. Drafts stay allowed.
  const publishBlockedReason = useMemo(
    () =>
      selectedIntegrations
        .map((p) => publishBlocked[p.integration.id])
        .find(Boolean) || missingMediaMessage,
    [selectedIntegrations, publishBlocked, missingMediaMessage]
  );

  // No plan yet: the main button goes to the paywall instead of a post the
  // backend refuses (TRIAL_REQUIRED). trial.cta.ts; null with a plan, in the
  // Play app and for a member.
  const user = useUser();
  // /user/self, for the free posts counter (trial.required.banner.tsx).
  const { mutate: refreshSelf } = useSWRConfig();
  const isTwa = useIsTwa();
  const trialCta = trialRequiredCta({
    planState: user?.planState,
    allowTrial: user?.allowTrial,
    role: user?.role,
    isTwa,
    trialDays: user?.trialDays,
  });
  const startTrialLabel = !dummy && trialCta?.scheduleLabel;

  useEffect(() => {
    if (hide) {
      setHide(false);
    }
  }, [hide]);

  const currentIntegrationText = useMemo(() => {
    if (current === 'global') {
      return (
        <div className="flex items-center gap-[10px]">
          <div className="relative">
            <SettingsIcon size={15} className="text-white" />
          </div>
          <div>Settings</div>
        </div>
      );
    }

    const currentIntegration = integrations.find((p) => p.id === current)!;

    return (
      <div className="flex items-center gap-[10px]">
        <div className="relative">
          <img
            src={`/icons/platforms/${currentIntegration.identifier}.png`}
            className="w-[20px] h-[20px] rounded-[4px]"
            alt={currentIntegration.identifier}
          />
          <SettingsIcon
            size={15}
            className="text-white absolute -end-[5px] -bottom-[5px]"
          />
        </div>
        <div>
          {currentIntegration.name} {t('channel_settings', 'Settings')}
        </div>
      </div>
    );
  }, [current]);

  const changeCustomer = useCallback(
    (customer: string) => {
      const neededIntegrations = integrations.filter(
        (p) => p?.customer?.id === customer
      );
      setSelectedIntegrations(
        neededIntegrations.map((p) => ({
          settings: {},
          selectedIntegrations: p,
        }))
      );
    },
    [integrations]
  );

  // X and Escape: close straight away when nothing changed since the
  // composer opened, ask first when something did.
  const askClose = useCallback(async () => {
    if (!activateExitButton || dummy) {
      return;
    }

    if (
      isComposerDirty(useLaunchStore.getState()) &&
      !(await deleteDialog(
        // A saved post is not lost by closing, only what was changed since
        existingData?.integration
          ? t(
              'are_you_sure_you_want_to_close_unsaved_changes_will_be_lost',
              'Are you sure you want to close this post? Unsaved changes will be lost.'
            )
          : t(
              'are_you_sure_you_want_to_close_this_modal_all_data_will_be_lost',
              'Are you sure you want to close this modal? (all data will be lost)'
            ),
        t('yes_close_it', 'Yes, close it!')
      ))
    ) {
      return;
    }

    if (customClose) {
      customClose();
      return;
    }
    modal.closeAll();
  }, [activateExitButton, dummy, existingData, customClose]);

  // Escape follows the same rule as X, instead of the modal's own question
  useModalCloseHandler(askClose);

  const deletePost = useCallback(async () => {
    setLoading(true);
    if (
      !(await deleteDialog(
        t(
          'are_you_sure_you_want_to_delete_post',
          'Are you sure you want to delete this post?'
        ),
        t('yes_delete_it', 'Yes, delete it!')
      ))
    ) {
      setLoading(false);
      return;
    }
    await fetch(`/posts/${existingData.group}`, {
      method: 'DELETE',
    });
    mutate();
    modal.closeAll();
    return;
  }, [existingData, mutate, modal]);

  const schedule = useCallback(
    (type: 'draft' | 'now' | 'schedule' | 'update') => async () => {
      let republish = false;
      // Saving again publishes it: it already went out, or its time passed
      // while it was queued and it never did. Each says which.
      const reason = republishReason(
        existingData?.posts?.[0]?.state,
        date,
        dayjs()
      );
      if ((type === 'now' || type === 'schedule') && reason) {
        const channels = selectedIntegrations
          .map((p) => p.integration.name)
          .join(', ');
        const isRecurring =
          !!repeater || !!existingData?.posts?.[0]?.intervalInDays;

        // The chooser closes itself when a button is picked. It used to stay
        // on top of the composer, dead, whenever another dialog followed (a
        // past date) or the save was refused.
        const whatToDo = await askChoice<'update' | 'republish'>(modal, {
          title: t('what_do_you_want_to_do', 'What do you want to do?'),
          children: (choose) => (
            <div className="flex flex-col">
              <div className="text-[20px] mb-[20px]">
                {reason === 'missed'
                  ? t(
                      'post_missed_publish_warning',
                      "This post's scheduled time has passed and it was not published. It will be published to"
                    )
                  : reason === 'reminded'
                  ? t(
                      'post_reminder_sent_warning',
                      'The reminder for this post was already sent. Saving it again sends another reminder for'
                    )
                  : t(
                      'post_already_published_republish_warning',
                      'This post was already published. Republishing will publish it again to'
                    )}{' '}
                {channels} {t('republish_at', 'at')}{' '}
                {date.format('DD/MM/YYYY HH:mm')}.
                {isRecurring && (
                  <div className="mt-[10px]">
                    {t(
                      'republish_recurring_note',
                      'This is a recurring post: your changes apply to all future recurrences starting now.'
                    )}
                  </div>
                )}
              </div>
              <div className="flex w-full gap-[10px]">
                <div className="flex-1 flex">
                  <Button
                    type="button"
                    className="flex-1"
                    onClick={() => choose('update')}
                  >
                    {t(
                      'just_update_post_details',
                      'Just update the post details'
                    )}
                  </Button>
                </div>
                <div className="flex-1 flex">
                  <Button
                    type="button"
                    className="flex-1"
                    onClick={() => choose('republish')}
                  >
                    {reason === 'missed'
                      ? t('publish_the_post', 'Publish the post')
                      : reason === 'reminded'
                      ? t('remind_me_again', 'Remind me again')
                      : t('republish_the_post', 'Republish the post')}
                  </Button>
                </div>
              </div>
            </div>
          ),
        });

        // Closed with X: nothing is saved and the composer stays as it was.
        if (!whatToDo) {
          return;
        }

        if (whatToDo === 'update') {
          type = 'update';
        }

        if (whatToDo === 'republish') {
          republish = true;
        }
      }

      // A time that has already gone would publish the moment it is saved:
      // say so, and publish now only if that is what the user wants.
      if (!dummy && !addEditSets && isPastScheduleTime(type, date, dayjs())) {
        const publishNow = await deleteDialog(
          `${t(
            'scheduled_time_has_passed',
            'The time you picked has already passed:'
          )} ${date.format('DD/MM/YYYY HH:mm')}. ${t(
            'publish_it_now_instead',
            'Publish the post now instead?'
          )}`,
          t('yes_publish_now', 'Yes, publish now'),
          t('this_time_has_passed', 'This time has passed'),
          t('no_pick_another_time', 'No, pick another time')
        );
        if (!publishNow) {
          return;
        }
        type = 'now';
      }

      // A reminder is sent once (the backend refuses it with Repeat too)
      const { reminders: picked, selectedIntegrations: pickedChannels } =
        useLaunchStore.getState();
      if (repeater && pickedChannels.some((p) => picked[p.integration.id])) {
        toaster.show(
          t(
            'remind_me_cannot_repeat',
            '"Remind me to post" cannot repeat. Turn off Repeat Post, or turn off the reminder.'
          ),
          'warning'
        );
        return;
      }

      setLoading(true);

      // Pull the local values to build the payload, but rely on the server
      // (`/posts/valid`) for the actual validation — checkValidity now lives
      // server-side so it can't be bypassed.
      const allValues = await ref.current.getAllValues();

      // Read at call time: for a new post this callback still holds the empty
      // channel list the composer opened with.
      const integrationById = (id: string) =>
        useLaunchStore
          .getState()
          .selectedIntegrations.find((p) => p.integration.id === id);

      const group = existingData.group || makeId(10);
      // Read at call time too: toggled after the callback was created
      const { reminders } = useLaunchStore.getState();


      const posts = allValues.map((post: any) => ({
        integration: {
          id: post.id,
        },
        remind: !!reminders[post.id],
        group,
        settings: { ...(post.settings || {}) },
        value: post.values.map((value: any) => ({
          ...(value.id ? { id: value.id } : {}),
          content: value.content,
          delay: value.delay || 0,
          image:
            (value?.media || []).map(
              ({ id, path, alt, thumbnail, thumbnailTimestamp }: any) => ({
                id,
                path,
                alt,
                thumbnail,
                thumbnailTimestamp,
              })
            ) || [],
        })),
      }));

      if (!dummy) {
        const checkAllValid = await (
          await fetch('/posts/valid', {
            method: 'POST',
            body: JSON.stringify({ type, posts }),
          })
        ).json();

        // Open the tab of the channel that failed, so its preview or settings
        // show what to fix.
        const focus = (id: string) => {
          if (integrationById(id)) {
            useLaunchStore.getState().setCurrent(id);
            setHide(true);
          }
        };

        const notEnoughChars = checkAllValid.filter((p: any) => p.emptyContent);

        for (const item of notEnoughChars) {
          toaster.show(
            `${capitalize(item.identifier.split('-')[0])} (${item.name}):` +
              ' ' +
              t(
                'post_needs_content_or_image',
                'Your post should have at least one character or one image.'
              ),
            'warning'
          );
          setLoading(false);
          focus(item.id);
          return;
        }

        if (type !== 'draft') {
          for (const item of checkAllValid) {
            if (item.valid === false) {
              toaster.show(
                `${capitalize(item.identifier.split('-')[0])} (${item.name}): ${
                  item.settingsError ||
                  t('please_fix_your_settings', 'Please fix your settings')
                }`,
                'warning'
              );
              focus(item.id);
              setLoading(false);
              setShowSettings(true);
              return;
            }

            if (item.errors !== true) {
              toaster.show(
                `${capitalize(item.identifier.split('-')[0])} (${item.name}): ${
                  item.errors
                }`,
                'warning'
              );
              focus(item.id);
              setLoading(false);
              setShowSettings(false);
              return;
            }

            if (item.tooLong) {
              toaster.show(
                `${item.name} (${item.identifier}) ${t(
                  'post_is_too_long',
                  'post is too long, please fix it'
                )}`,
                'warning'
              );
              focus(item.id);
              setLoading(false);
              return;
            }
          }

          // Heads-ups that don't block the post (e.g. a file over Discord's
          // limit that will go out as a link). Ask once, listing them all.
          const notices = checkAllValid.flatMap((item: any) =>
            (item.notices || []).map(
              (notice: string) =>
                `${capitalize(item.identifier.split('-')[0])} (${
                  item.name
                }): ${notice}`
            )
          );
          if (notices.length) {
            const goOn = await deleteDialog(
              notices.join('\n\n'),
              t('post_anyway', 'Post anyway'),
              t('before_you_post', 'Before you post'),
              t('go_back_and_change_it', 'Go back and change it')
            );
            if (!goOn) {
              const [first] = checkAllValid.filter(
                (item: any) => (item.notices || []).length
              );
              focus(first.id);
              setLoading(false);
              return;
            }
          }
        }
      }

      const shortlinkPreference = shortlinkPreferenceData?.shortlink || 'ASK';

      let shortLink = false;

      if (!dummy && shortlinkPreference !== 'NO') {
        const shortLinkUrl = await (
          await fetch('/posts/should-shortlink', {
            method: 'POST',
            body: JSON.stringify({
              messages: allValues
                // platforms that remove links won't keep shortlinks either
                .filter(
                  (p: any) => !integrationById(p.id)?.integration?.stripLinks
                )
                .flatMap((p: any) => p.values.flatMap((a: any) => a.content)),
            }),
          })
        ).json();

        if (shortLinkUrl.ask) {
          if (shortlinkPreference === 'YES') {
            // Automatically shortlink without asking
            shortLink = true;
          } else {
            // ASK: Show the dialog
            shortLink = await deleteDialog(
              t(
                'shortlink_urls_question',
                'Do you want to shortlink the URLs? it will let you get statistics over clicks'
              ),
              t('yes_shortlink_it', 'Yes, shortlink it!'),
              undefined,
              t('no_original_urls', 'No, original URLs')
            );
          }
        }
      }

      const data = {
        type,
        ...(republish ? { republish } : {}),
        ...(repeater ? { inter: repeater } : {}),
        tags,
        shortLink,
        date: date.utc().format('YYYY-MM-DDTHH:mm:ss'),
        posts,
      };

      if (dummy) {
        modal.openModal({
          title: '',
          children: <DummyCodeComponent code={data} />,
          classNames: {
            modal: 'w-[100%] bg-transparent text-textColor',
          },
          size: '100%',
          withCloseButton: false,
          closeOnEscape: true,
          closeOnClickOutside: true,
        });

        setLoading(false);
      }

      if (!dummy) {
        let saveResponse: Response | undefined;
        if (addEditSets) {
          addEditSets(data);
        } else {
          // Nothing was saved: say why and keep the composer open, so the
          // post and the edits are still there.
          const accepted = await submitPost(
            fetch,
            data,
            {
              fallback: t(
                'post_save_failed',
                'Could not save the post, please try again'
              ),
              limitReached: t(
                'post_save_plan_limit',
                "Not saved: your plan's limit is reached"
              ),
            },
            (message) => toaster.show(message, 'warning')
          );
          if (!accepted) {
            setLoading(false);
            return;
          }
          saveResponse = accepted;
        }

        if (!addEditSets) {
          mutate();
          // A workspace on its free posts: the counter shows one fewer.
          if (user?.planState === 'free_posts') {
            refreshSelf('/user/self');
          }
          // The review card re-checks with the server a little later
          // (layout/rate-prompt.ts): only after a new post that was actually
          // scheduled or published.
          if (
            saveResponse?.ok &&
            (type === 'schedule' || type === 'now') &&
            !existingData.integration
          ) {
            recordSuccessfulPost();
          }
          // TikTok's Content Sharing Guidelines require telling the creator
          // that a published post can take a few minutes to show up.
          // Read at call time: this callback's selectedIntegrations can be stale.
          const toTikTok =
            type === 'now' &&
            allValues.some(
              (p: any) =>
                useLaunchStore
                  .getState()
                  .selectedIntegrations.find((s) => s.integration.id === p.id)
                  ?.integration?.identifier?.startsWith('tiktok') &&
                p.settings?.content_posting_method !== 'UPLOAD'
            );
          const saved = !existingData.integration
            ? t('added_successfully', 'Added successfully')
            : t('updated_successfully', 'Updated successfully');
          toaster.show(
            toTikTok
              ? `${saved}. ${t(
                  'tiktok_processing_toast',
                  'TikTok may take a few minutes to process your post before it appears on your profile.'
                )}`
              : saved
          );
        }
        if (customClose) {
          setTimeout(() => {
            customClose();
          }, 2000);
        }

        if (!addEditSets) {
          modal.closeAll();
          // A new post: the calendar moves to where it landed. "Post now"
          // publishes at once, whatever the date field held.
          if (!existingData.integration) {
            onAdded?.(type === 'now' ? dayjs() : date);
          }
        }
      }
    },
    [ref, repeater, tags, date, addEditSets, dummy, shortlinkPreferenceData]
  );

  return (
    // Phones: edge to edge, no frame or rounded card; every pixel goes to the
    // editor and the actions.
    <div className="w-full h-full flex-1 p-0 md:p-[40px] flex relative min-w-0">
      <div className="flex flex-1 bg-newBgColorInner rounded-none md:rounded-[20px] flex-col min-w-0">
        <div className="flex-1 flex flex-col lg:flex-row min-w-0 overflow-y-auto lg:overflow-visible">
          {/* Below lg the editor and the preview stack and scroll together;
              the editor gets most of the first screen. flex-none there: a
              flex-1 (0 basis) column was squeezed to its min-height inside
              the scroller, and an open settings form spilled over the
              preview. */}
          <div className="flex flex-col flex-none lg:flex-1 min-w-0 min-h-[max(340px,58dvh)] lg:min-h-0 lg:border-e border-newBorder">
            <div className="bg-newBgColor h-[52px] md:h-[65px] rounded-none md:rounded-s-[20px] !rounded-b-[0] flex items-center gap-[12px] px-[16px] md:px-[20px] text-[18px] md:text-[20px] font-[600]">
              {existingData?.integration
                ? t('top_title_edit_post', 'Edit Post')
                : t('create_post_title', 'Create Post')}
              <CreationMethodBadge
                creationMethod={existingData?.posts?.[0]?.creationMethod}
                size="sm"
              />
            </div>
            <div className="flex-1 flex flex-col gap-[16px]">
              <div
                className={clsx('flex-1 relative', showSettings && 'hidden')}
              >
                <div
                  id="social-content"
                  className="gap-[24px] md:gap-[32px] flex flex-col pe-[8px] pt-[16px] md:pt-[20px] ps-[12px] md:ps-[20px] lg:absolute lg:top-0 lg:left-0 w-full lg:h-full overflow-x-hidden lg:overflow-y-scroll scrollbar scrollbar-thumb-newColColor scrollbar-track-newBgColorInner"
                >
                  {failedPost && (
                    <div
                      role="alert"
                      className="rounded-[8px] border border-red-500/40 bg-red-500/10 px-[14px] py-[10px] text-[14px] text-textColor break-words"
                    >
                      <span className="font-[600] text-red-500">
                        {failedIndex === 0
                          ? t(
                              'post_failed_to_publish',
                              'This post failed to publish.'
                            )
                          : t(
                              'post_comment_failed_to_publish',
                              'A comment on this post failed to publish.'
                            )}
                      </span>
                      {failureReason && (
                        <>
                          {' '}
                          {failureReason}
                        </>
                      )}
                    </div>
                  )}
                  {!!missingMediaMessage && (
                    <div
                      role="alert"
                      className="rounded-[8px] border border-red-500/40 bg-red-500/10 px-[14px] py-[10px] text-[14px] text-textColor break-words"
                    >
                      {missingMediaMessage}
                    </div>
                  )}
                  <div className="flex w-full">
                    <div className="flex flex-1">
                      <PicksSocialsComponent toolTip={true} />
                    </div>
                    <div>
                      {!dummy && (
                        <SelectCustomer
                          onChange={changeCustomer}
                          integrations={integrations}
                        />
                      )}
                    </div>
                  </div>
                  <div className="flex flex-1 gap-[6px] flex-col min-w-0">
                    <div>{!existingData.integration && <SelectCurrent />}</div>
                    <div className="flex-1 flex">
                      {!hide && <EditorWrapper totalPosts={1} value="" />}
                    </div>
                    <div
                      id="social-empty"
                      className={clsx(
                        'pb-[16px]'
                        // current !== 'global' && 'hidden'
                      )}
                    />
                  </div>
                </div>
              </div>
              <div
                id="wrapper-settings"
                className={clsx(
                  'pb-[16px] md:pb-[20px] px-[12px] md:px-[20px] select-none',
                  showSettings && 'flex-1 flex pt-[20px]',
                  current === 'global' && 'hidden'
                )}
              >
                <div className="flex-1 flex flex-col rounded-[12px] gap-[12px] overflow-hidden bg-newSettings">
                  <div
                    onClick={() => setShowSettings(!showSettings)}
                    className={clsx(
                      'bg-hp-primary rounded-[12px] flex items-center gap-[8px] cursor-pointer p-[12px]',
                      showSettings ? '!rounded-b-none' : ''
                    )}
                  >
                    <div className="flex-1 text-[14px] font-[600] text-hp-on-primary">
                      {currentIntegrationText}
                    </div>
                    <div>
                      <ChevronDownIcon
                        rotated={showSettings}
                        className="text-hp-on-primary"
                      />
                    </div>
                  </div>
                  <div
                    className={clsx(
                      !showSettings ? 'hidden' : 'flex-1',
                      'text-[14px] text-textColor font-[500] relative'
                    )}
                  >
                    {/* lg: scrolls inside the column. Phones: natural height,
                        the whole composer scrolls. */}
                    <div className="lg:absolute lg:left-0 lg:top-0 w-full lg:h-full flex flex-col overflow-x-hidden lg:overflow-y-auto scrollbar scrollbar-thumb-newBgColorInner scrollbar-track-newColColor">
                      <div
                        id="social-settings"
                        className="flex flex-col gap-[20px] bg-newBgColor"
                      />
                    </div>
                  </div>
                  <style>
                    {`#social-settings [data-id="${current}"] {display: block !important;}`}
                  </style>
                </div>
              </div>
            </div>
          </div>
          <div className="w-full lg:w-[580px] shrink-0 flex flex-col min-w-0 min-h-[320px] lg:min-h-0 border-t lg:border-t-0 border-newBorder">
            <div className="bg-newBgColor h-[52px] md:h-[65px] rounded-none md:rounded-e-[20px] !rounded-b-[0] flex items-center px-[16px] md:px-[20px] text-[18px] md:text-[20px] font-[600]">
              <div className="flex-1">{t('post_preview', 'Post Preview')}</div>
              <button
                type="button"
                onClick={askClose}
                aria-label={t('close', 'Close')}
                className="cursor-pointer flex items-center justify-center w-[44px] h-[44px] -me-[12px]"
              >
                <CloseIcon className="text-[#A3A3A3]" />
              </button>
            </div>
            <div className="flex-1 relative">
              <Scrollable
                scrollClasses="!pe-[20px]"
                className="absolute top-0 p-[12px] md:p-[20px] pe-[8px] left-0 w-full h-full overflow-x-hidden overflow-y-scroll scrollbar scrollbar-thumb-newColColor scrollbar-track-newBgColorInner"
              >
                <ShowAllProviders ref={ref} />
              </Scrollable>
            </div>
          </div>
        </div>
        {/* The home indicator: a phone's full-screen composer reaches the
            bottom edge, so the actions pad by its inset. */}
        <div className="select-none min-h-[84px] lg:h-[84px] pt-[10px] pb-[calc(10px+env(safe-area-inset-bottom,0px))] lg:py-[20px] border-t border-newBorder flex flex-col lg:flex-row lg:items-center gap-[8px] lg:gap-0 min-w-0">
          <div className="flex-1 flex flex-wrap px-[12px] lg:px-0 lg:ps-[20px] gap-[8px] min-w-0">
            {!dummy && (
              <TagsComponent
                name="tags"
                label={t('tags', 'Tags')}
                initial={tags}
                onChange={(e) => {
                  setTags(e.target.value);
                }}
              />
            )}

            {!dummy && (
              <RepeatComponent repeat={repeater} onChange={setRepeater} />
            )}

            {!dummy && !addEditSets && <RemindComponent />}
          </div>
          {/* lg:pe-[40px] keeps the buttons clear of the assistant launcher,
              which sits fixed 72px in from the corner */}
          <div className="px-[12px] lg:px-0 lg:pe-[40px] flex flex-wrap items-center justify-start lg:justify-end gap-[8px] min-w-0 [&>*]:grow lg:[&>*]:grow-0">
            {existingData?.integration && (
              <button
                onClick={deletePost}
                className="cursor-pointer flex text-[#FF3F3F] gap-[8px] items-center text-[15px] font-[600]"
              >
                <div>
                  <TrashIcon />
                </div>
                <div>{t('delete_post', 'Delete Post')}</div>
              </button>
            )}
            <DatePicker onChange={setDate} date={date} />
            {!addEditSets && (
              <button
                disabled={
                  selectedIntegrations.length === 0 || loading || locked
                }
                onClick={schedule('draft')}
                className="relative cursor-pointer disabled:cursor-not-allowed px-[14px] md:px-[20px] h-[44px] bg-btnSimple justify-center items-center flex rounded-[8px] text-[15px] font-[600] whitespace-nowrap"
              >
                {loading && (
                  <div className="absolute left-[50%] top-[50%] -translate-y-[50%] -translate-x-[50%]">
                    <div className="animate-spin h-[20px] w-[20px] border-4 border-textColor border-t-transparent rounded-full" />
                  </div>
                )}
                <div className={clsx(loading && 'invisible')}>
                  {t('save_as_draft', 'Save as Draft')}
                </div>
              </button>
            )}
            {addEditSets && (
              <button
                className="text-hp-on-primary text-[15px] font-[600] min-w-[180px] btnSub disabled:cursor-not-allowed disabled:opacity-80 outline-none gap-[8px] flex justify-center items-center h-[44px] rounded-[8px] bg-hp-primary ps-[20px] pe-[16px]"
                disabled={
                  selectedIntegrations.length === 0 || loading || locked
                }
                onClick={schedule('draft')}
              >
                Save Set
              </button>
            )}
            {!addEditSets && startTrialLabel && (
              <button
                type="button"
                data-testid="composer-start-trial"
                title={trialCta?.message}
                onClick={() => {
                  window.location.assign(TRIAL_CTA_HREF);
                }}
                className="text-hp-on-primary min-w-[180px] btnSub outline-none flex justify-center items-center h-[44px] rounded-[8px] bg-hp-primary px-[20px] text-[15px] font-[600]"
              >
                {startTrialLabel}
              </button>
            )}
            {!addEditSets && !startTrialLabel && (
              <div
                className="group cursor-pointer relative flex"
                onMouseLeave={() => setShowPostNow(false)}
              >
                <button
                  disabled={
                    selectedIntegrations.length === 0 ||
                    loading ||
                    locked ||
                    !!publishBlockedReason
                  }
                  title={publishBlockedReason || undefined}
                  onClick={schedule('schedule')}
                  className={clsx(
                    'text-hp-on-primary relative flex-1 lg:flex-none lg:min-w-[180px] btnSub disabled:cursor-not-allowed disabled:opacity-80 outline-none gap-[8px] flex justify-center items-center h-[44px] bg-hp-primary ps-[20px]',
                    dummy
                      ? 'rounded-[8px] pe-[20px]'
                      : 'rounded-s-[8px] pe-[12px]'
                  )}
                >
                  {loading && (
                    <div className="absolute left-[50%] top-[50%] -translate-y-[50%] -translate-x-[50%]">
                      <div className="animate-spin h-[20px] w-[20px] border-4 border-white border-t-transparent rounded-full" />
                    </div>
                  )}
                  <div
                    className={clsx(
                      'text-[15px] font-[600]',
                      loading && 'invisible'
                    )}
                  >
                    {selectedIntegrations.length === 0
                      ? t('check_circles_above', 'Check the circles above')
                      : dummy
                      ? t('create_output', 'Create output')
                      : !existingData?.integration
                      ? t('add_to_calendar', 'Add to calendar')
                      : existingData?.posts?.[0]?.state === 'DRAFT'
                      ? t('schedule', 'Schedule')
                      : t('update', 'Update')}
                  </div>
                </button>

                {/* The caret used to live INSIDE the button above, so clicking
                    it to see the publishing options scheduled the post instead
                    of opening them - and since "Post Now" only appeared on
                    group-hover, that click was the natural way to reach it.
                    It is its own toggle now, and the menu opens on hover or on
                    the toggle, so it is reachable without a mouse too. */}
                {!dummy && (
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={showPostNow}
                    aria-label={t(
                      'more_publish_options',
                      'More publishing options'
                    )}
                    disabled={
                      selectedIntegrations.length === 0 ||
                      loading ||
                      locked ||
                      !!publishBlockedReason
                    }
                    title={publishBlockedReason || undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setShowPostNow((current) => !current);
                    }}
                    className="text-hp-on-primary btnSub disabled:cursor-not-allowed disabled:opacity-80 outline-none flex justify-center items-center h-[44px] w-[36px] rounded-e-[8px] bg-hp-primary arrow-change"
                  >
                    <DropdownArrowSmallIcon
                      className={clsx(
                        'text-white transition-transform',
                        showPostNow ? 'rotate-180' : 'group-hover:rotate-180'
                      )}
                    />
                  </button>
                )}

                {!dummy && (
                  <button
                    onClick={() => {
                      setShowPostNow(false);
                      return schedule('now')();
                    }}
                    disabled={
                      selectedIntegrations.length === 0 ||
                      loading ||
                      locked ||
                      !!publishBlockedReason
                    }
                    title={publishBlockedReason || undefined}
                    className={clsx(
                      'rounded-[8px] z-[300] disabled:cursor-not-allowed disabled:opacity-80 absolute bottom-[100%] -left-[12px] p-[12px] w-[206px] bg-newBgColorInner',
                      showPostNow ? 'flex' : 'hidden group-hover:flex'
                    )}
                  >
                    <div className="text-hp-on-accent rounded-[8px] bg-hp-accent h-[44px] w-full flex justify-center items-center post-now">
                      {t('post_now', 'Post Now')}
                    </div>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <CopilotPopup
        hitEscapeToClose={false}
        clickOutsideToClose={true}
        instructions={`
You are an assistant that help the user to schedule their social media posts,
Here are the things you can do:
- Add a new comment / post to the list of posts
- Delete a comment / post from the list of posts
- Add content to the comment / post
- Activate or deactivate the comment / post

Post content can be added using the addPostContentFor{num} function.
After using the addPostFor{num} it will create a new addPostContentFor{num+ 1} function.
`}
        labels={{
          title: t('your_assistant', 'Your Assistant'),
          initial: t(
            'assistant_initial_message',
            'Hi! I can help you to refine your social media posts.'
          ),
        }}
      />
    </div>
  );
};

const Scrollable: FC<{
  className: string;
  scrollClasses: string;
  children: ReactNode;
}> = ({ className, scrollClasses, children }) => {
  const ref = useRef(undefined);
  const hasScroll = useHasScroll(ref);
  return (
    <div className={clsx(className, hasScroll && scrollClasses)} ref={ref}>
      {children}
    </div>
  );
};
