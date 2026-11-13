'use client';

import { FC, useCallback, useState } from 'react';
import useSWR from 'swr';
import copy from 'copy-to-clipboard';
import { useParams } from 'next/navigation';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useToaster } from '@hookpost/react/toaster/toaster';
import { BellIcon } from '@hookpost/frontend/components/new-launch/remind.component';

export interface Reminder {
  id: string;
  group: string;
  state: string;
  remind: boolean;
  publishDate: string;
  caption: string;
  comments: string[];
  media: { url: string; video: boolean }[];
  integration: { name: string; picture?: string; providerIdentifier: string };
  platform: string;
  appLink: { name: string; app: string; web: string } | null;
}

export const useReminder = (id: string) => {
  const fetch = useFetch();
  const load = useCallback(async (path: string) => {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(String(response.status));
    }
    return (await response.json()) as Reminder;
  }, []);

  return useSWR(id ? `/posts/${id}/reminder` : null, load, {
    revalidateOnFocus: false,
  });
};

/**
 * Opens the platform's app by its URL scheme. When nothing takes it (no app
 * installed, or a desktop browser) the page is still showing after `delay`,
 * so the platform's web page opens instead.
 */
export const openApp = (
  link: { app: string; web: string },
  win: Window = window,
  delay = 1500
) => {
  let left = false;
  const onHide = () => {
    if (win.document.hidden) {
      left = true;
    }
  };
  win.document.addEventListener('visibilitychange', onHide);
  win.location.href = link.app;
  win.setTimeout(() => {
    win.document.removeEventListener('visibilitychange', onHide);
    if (!left && !win.document.hidden) {
      win.location.href = link.web;
    }
  }, delay);
};

/**
 * /reminder/<postId>: a "Remind me to post" post, ready to publish by hand
 * from a phone. Download the file, copy the caption, open the app (the only
 * place licensed music can be added), then "Mark as posted".
 */
export const ReminderPage: FC = () => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const { id } = useParams<{ id: string }>();
  const { data, error, isLoading, mutate } = useReminder(id);
  const [marking, setMarking] = useState(false);

  const copyText = useCallback(
    (text: string) => {
      copy(text);
      toaster.show(t('copied_to_clipboard', 'Copied to clipboard'), 'success');
    },
    [toaster]
  );

  const markPosted = useCallback(async () => {
    setMarking(true);
    try {
      const response = await fetch(`/posts/${id}/posted-manually`, {
        method: 'POST',
      });
      if (!response.ok) {
        toaster.show(
          t('reminder_mark_failed', 'Could not mark it as posted'),
          'warning'
        );
        return;
      }
      await mutate();
      toaster.show(t('reminder_marked', 'Marked as posted'), 'success');
    } finally {
      setMarking(false);
    }
  }, [id, mutate, fetch, toaster, t]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-[16px]">
        <div className="animate-spin h-[24px] w-[24px] border-4 border-textColor border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        role="alert"
        className="max-w-[560px] w-full mx-auto p-[16px] text-[15px]"
      >
        {t(
          'reminder_not_found',
          "This post isn't in this workspace. Switch to the workspace it belongs to, or open it from the reminder email again."
        )}
      </div>
    );
  }

  const posted = data.state === 'POSTED_MANUALLY' || data.state === 'PUBLISHED';
  // the backend accepts "Mark as posted" only for these
  const canMark =
    data.remind && (data.state === 'QUEUE' || data.state === 'REMINDER_SENT');

  return (
    <div className="max-w-[560px] w-full mx-auto flex flex-col gap-[16px] p-[16px] text-textColor">
      <div className="flex items-center gap-[12px]">
        <div className="relative min-w-[40px]">
          <img
            src={data.integration.picture || '/no-picture.jpg'}
            className="w-[40px] h-[40px] rounded-[8px]"
            alt=""
          />
          <img
            src={`/icons/platforms/${data.integration.providerIdentifier}.png`}
            className="w-[18px] h-[18px] rounded-[4px] absolute -bottom-[4px] -end-[4px]"
            alt=""
          />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-[20px] font-[600] leading-[26px]">
            {t('reminder_time_to_post', 'Time to post on')} {data.platform}
          </h1>
          <div className="text-[14px] text-textColor/70 truncate">
            {data.integration.name}
          </div>
        </div>
      </div>

      <div
        data-testid="reminder-state"
        className="inline-flex self-start items-center gap-[6px] rounded-[6px] bg-hp-primary/15 text-hp-primary-text px-[10px] py-[4px] text-[13px] font-[600]"
      >
        <BellIcon className="w-[14px] h-[14px]" />
        {posted
          ? t('reminder_state_posted', 'Posted')
          : data.state === 'REMINDER_SENT'
          ? t('reminder_state_sent', 'Ready to post')
          : t('reminder_state_scheduled', 'Reminder scheduled')}
      </div>

      {data.media.map((file, i) => (
        <div
          key={file.url}
          className="flex flex-col gap-[8px] rounded-[12px] bg-newBgColorInner p-[12px]"
        >
          {file.video ? (
            <video
              src={file.url}
              controls
              playsInline
              preload="metadata"
              className="w-full max-h-[60vh] rounded-[8px] bg-black"
            />
          ) : (
            <img
              src={file.url}
              alt=""
              className="w-full max-h-[60vh] object-contain rounded-[8px]"
            />
          )}
          <a
            href={file.url}
            download
            target="_blank"
            rel="noopener noreferrer"
            className="h-[44px] rounded-[8px] bg-btnSimple flex items-center justify-center text-[15px] font-[600]"
          >
            {data.media.length === 1
              ? t('reminder_download', 'Download')
              : `${t('reminder_download_file', 'Download file')} ${i + 1}`}
          </a>
        </div>
      ))}

      {!!data.caption && (
        <div className="flex flex-col gap-[8px] rounded-[12px] bg-newBgColorInner p-[12px]">
          <div className="text-[13px] font-[600] text-textColor/70">
            {t('caption', 'Caption')}
          </div>
          <div
            data-testid="reminder-caption"
            className="whitespace-pre-wrap break-words text-[15px]"
          >
            {data.caption}
          </div>
          <button
            type="button"
            onClick={() => copyText(data.caption)}
            className="h-[44px] rounded-[8px] bg-btnSimple text-[15px] font-[600]"
          >
            {t('copy_caption', 'Copy caption')}
          </button>
        </div>
      )}

      {data.comments.map((comment, i) => (
        <div
          key={i}
          className="flex flex-col gap-[8px] rounded-[12px] bg-newBgColorInner p-[12px]"
        >
          <div className="text-[13px] font-[600] text-textColor/70">
            {t('reminder_first_comment', 'Comment')} {i + 1}
          </div>
          <div className="whitespace-pre-wrap break-words text-[15px]">
            {comment}
          </div>
          <button
            type="button"
            onClick={() => copyText(comment)}
            className="h-[44px] rounded-[8px] bg-btnSimple text-[15px] font-[600]"
          >
            {t('copy_comment', 'Copy comment')}
          </button>
        </div>
      ))}

      {data.appLink && (
        <button
          type="button"
          data-testid="reminder-open-app"
          onClick={() => openApp(data.appLink!)}
          className="h-[48px] rounded-[8px] bg-hp-primary text-hp-on-primary text-[16px] font-[600]"
        >
          {t('reminder_open_app', 'Open')} {data.appLink.name}
        </button>
      )}

      {canMark && (
        <button
          type="button"
          data-testid="reminder-mark-posted"
          disabled={marking}
          onClick={markPosted}
          className="h-[48px] rounded-[8px] border border-hp-primary text-[16px] font-[600] disabled:opacity-60"
        >
          {t('reminder_mark_posted', 'Mark as posted')}
        </button>
      )}
    </div>
  );
};
