'use client';

import React, {
  FC,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import useSWR from 'swr';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useHasOpenModal } from '@hookpost/frontend/components/layout/new-modal';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { isTwaSession } from '@hookpost/frontend/components/layout/twa';
import {
  isAndroidUserAgent,
  RATE_PROMPT_EVENT,
  ReviewButton,
  reviewButtons,
  ReviewTarget,
} from '@hookpost/frontend/components/layout/rate-prompt';

// Wait after a page load so the card never lands on the first paint, and
// after a post is saved so the "Added successfully" toast and the closing
// composer are gone and a post sent "now" has had time to publish. When it is
// due at all is the server's call (rate-prompt.ts).
const AFTER_LOAD_MS = 8000;
const AFTER_POST_MS = 20000;

// The tab's Play-app flag and the user agent only change on a page load, so
// there is nothing to subscribe to. False during server rendering/hydration.
const subscribe = () => (): void => undefined;
const useIsTwaSession = (): boolean =>
  useSyncExternalStore(subscribe, isTwaSession, () => false);
const isAndroidClient = () =>
  typeof navigator !== 'undefined' && isAndroidUserAgent(navigator.userAgent);
const useIsAndroid = (): boolean =>
  useSyncExternalStore(subscribe, isAndroidClient, () => false);

/** GET /user/review-ask once `ready`; `mutate` re-checks after a post. */
const useReviewAsk = (ready: boolean) => {
  const fetch = useFetch();
  const load = useCallback(
    async (path: string) => {
      const res = await fetch(path);
      if (!res.ok) {
        return { ask: false };
      }
      return (await res.json()) as { ask?: boolean };
    },
    [fetch]
  );
  return useSWR(ready ? '/user/review-ask' : null, load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    shouldRetryOnError: false,
  });
};

/**
 * "Enjoying Hookpost? A short review helps a lot." A small card in the
 * corner, shown right after a success moment the server recognised (see
 * rate-prompt.ts). Every user sees the same words and the same buttons;
 * "Not now" is as easy as the review button. It never covers an open modal
 * (the composer is one): if a modal is open when the card is due it waits,
 * and if one opens while it shows it steps aside until the modal closes.
 * Escape closes it. Screen readers hear it through a polite status message;
 * it does not take focus. Not while an admin is impersonating the user.
 *
 * z-[250]: below every full-screen overlay that is not a modal of the modal
 * store (LinkedIn page picker, post URL selector, finish-trial, the payment
 * check: z-[300] and up) and the toaster, above the page's own content.
 */
export const RatePrompt: FC = () => {
  const t = useT();
  const fetch = useFetch();
  const user = useUser();
  const isTwa = useIsTwaSession();
  const isAndroid = useIsAndroid();
  const modalOpen = useHasOpenModal();
  const impersonating = !!user?.impersonate;
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const [closed, setClosed] = useState(false);
  const claimedRef = useRef(false);
  const mountedRef = useRef(true);
  const titleId = useId();
  const bodyId = useId();
  const { data, mutate } = useReviewAsk(ready && !impersonating);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = (delay: number, then: () => void) => {
      clearTimeout(timer);
      timer = setTimeout(then, delay);
    };
    later(AFTER_LOAD_MS, () => setReady(true));
    const onPost = () =>
      later(AFTER_POST_MS, () => {
        setReady(true);
        void mutate();
      });
    window.addEventListener(RATE_PROMPT_EVENT, onPost);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(RATE_PROMPT_EVENT, onPost);
    };
  }, [mutate]);

  const record = useCallback(
    (body: { action: 'shown' | 'dismissed' | 'clicked'; target?: ReviewTarget }) =>
      fetch('/user/review-ask', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    [fetch]
  );

  // Due and nothing in the way: claim it on the server (which re-checks and
  // starts the 60-day clock), and show it only if the claim was ours.
  const due = data?.ask === true && !impersonating && !closed;
  useEffect(() => {
    if (!due || modalOpen || claimedRef.current) {
      return;
    }
    // Once per page: the claim is not cancelled if a modal opens while it
    // is in flight (the card then waits for the modal, see onScreen).
    claimedRef.current = true;
    (async () => {
      try {
        const res = await record({ action: 'shown' });
        const body = res.ok ? await res.json() : null;
        if (mountedRef.current && body?.ok === true) {
          setVisible(true);
        }
      } catch (e) {
        // Offline or the API refused: no card this time.
      }
    })();
  }, [due, modalOpen, record]);

  const dismiss = useCallback(() => {
    setVisible(false);
    setClosed(true);
    record({ action: 'dismissed' }).catch(() => undefined);
  }, [record]);
  const open = useCallback(
    (target: ReviewTarget) => {
      setVisible(false);
      setClosed(true);
      record({ action: 'clicked', target }).catch(() => undefined);
    },
    [record]
  );

  const onScreen = visible && !closed && !modalOpen;

  useEffect(() => {
    if (!onScreen) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismiss();
      }
    };
    // Listen from the next tick: the Escape that closed the composer brings
    // the card back during that same keydown (React flushes the effect
    // before the event reaches window), and must not dismiss it too.
    const timer = setTimeout(() => window.addEventListener('keydown', onKey), 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [onScreen, dismiss]);

  const title = t('review_prompt_title', 'Enjoying Hookpost?');
  const body = t('review_prompt_body', 'A short review helps a lot.');
  const { primary, secondary } = reviewButtons({ isTwa, isAndroid });
  const label = (b: ReviewButton, main: boolean) =>
    b.target === 'g2'
      ? t('review_prompt_g2', 'Review on G2')
      : main
      ? t('review_prompt_play', 'Review on Google Play')
      : t('review_prompt_play_secondary', 'Rate on Google Play');

  return (
    <>
      {/* Mounted before the card appears, so the text change is announced. */}
      <div role="status" aria-live="polite" className="sr-only">
        {onScreen ? `${title} ${body}` : ''}
      </div>
      {onScreen && (
        <aside
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          data-testid="review-prompt"
          className="fixed z-[250] bottom-[calc(16px+var(--app-bottom-inset,0px))] start-[12px] end-[12px] sm:start-auto sm:end-[20px] sm:w-[360px] rounded-[12px] border border-newBorder bg-newBgColorInner text-newTextColor shadow-2xl p-[16px] flex flex-col gap-[12px]"
        >
          <div className="flex items-start gap-[12px]">
            <div className="flex-1 min-w-0 flex flex-col gap-[4px]">
              <div id={titleId} className="text-[16px] font-[600]">
                {title}
              </div>
              <div id={bodyId} className="text-[14px] text-textItemBlur">
                {body}
              </div>
            </div>
            <button
              type="button"
              onClick={dismiss}
              aria-label={t('review_prompt_close', 'Close')}
              className="shrink-0 w-[32px] h-[32px] flex items-center justify-center text-[20px] leading-none text-textItemBlur hover:text-newTextColor cursor-pointer"
            >
              &times;
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-[8px]">
            <a
              href={primary.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => open(primary.target)}
              className="flex-1 min-w-[150px] h-[40px] px-[16px] rounded-[8px] bg-forth text-hp-on-primary text-[14px] font-[600] leading-[1.2] text-center flex items-center justify-center cursor-pointer"
            >
              {label(primary, true)}
            </a>
            {secondary && (
              <a
                href={secondary.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => open(secondary.target)}
                className="flex-1 min-w-[150px] h-[40px] px-[16px] rounded-[8px] border border-newBorder text-[14px] font-[600] leading-[1.2] text-center flex items-center justify-center cursor-pointer"
              >
                {label(secondary, false)}
              </a>
            )}
            <button
              type="button"
              onClick={dismiss}
              className="h-[40px] px-[16px] rounded-[8px] border border-newBorder text-[14px] cursor-pointer"
            >
              {t('review_prompt_later', 'Not now')}
            </button>
          </div>
        </aside>
      )}
    </>
  );
};
