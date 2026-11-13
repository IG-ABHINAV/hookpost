'use client';

import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { providerName } from '@hookpost/frontend/components/launches/add.channel.helpers';
import {
  abandonedAttempt,
  abandonedConnectTip,
  ConnectAttempt,
  clearConnectAttempt,
  finishedElsewhere,
} from '@hookpost/frontend/components/launches/connect.attempt';
import { reportClientEvent } from '@hookpost/frontend/components/layout/client.event';

/**
 * "Didn't finish connecting X?" when the calendar shows again after a
 * connect that never came back from the provider (connect.attempt.ts):
 * on load, and when the tab is shown again (Back, or returning from an app
 * that opened instead of the sign-in page).
 *
 * `refreshChannels` fetches the channel list again. When the connect started
 * with a known list, a new channel of that provider means it finished in
 * another tab (an app on Android can open the callback there), so the card
 * stays away.
 */
export const AbandonedConnectCard: FC<{
  onTryAgain: () => void;
  refreshChannels?: () => Promise<unknown>;
}> = ({ onTryAgain, refreshChannels }) => {
  const t = useT();
  const search = useSearchParams();
  const [provider, setProvider] = useState<string | null>(null);
  const refresh = useRef(refreshChannels);
  refresh.current = refreshChannels;
  const checking = useRef(false);

  const show = useCallback((attempt: ConnectAttempt) => {
    setProvider(attempt.provider);
    reportClientEvent('connect_abandoned', { provider: attempt.provider });
  }, []);

  const check = useCallback(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    if (checking.current) {
      return;
    }
    const attempt = abandonedAttempt();
    if (!attempt) {
      return;
    }
    const reload = refresh.current;
    if (!attempt.known || !reload) {
      show(attempt);
      return;
    }
    checking.current = true;
    reload()
      .catch(() => undefined)
      .then((channels) => {
        // Dismissed, finished or replaced while the list loaded.
        const still = abandonedAttempt();
        if (!still || still.at !== attempt.at) {
          return;
        }
        if (finishedElsewhere(attempt, channels)) {
          clearConnectAttempt();
          return;
        }
        show(attempt);
      })
      .finally(() => {
        checking.current = false;
      });
  }, [show]);

  useEffect(() => {
    // Back on the calendar after a finished connect: nothing was abandoned.
    if (search.get('added')) {
      clearConnectAttempt();
      return;
    }
    check();
    const onVisible = () => check();
    window.addEventListener('pageshow', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('pageshow', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!provider) {
    return null;
  }

  const name = providerName(provider);
  const dismiss = () => {
    clearConnectAttempt();
    setProvider(null);
  };

  return (
    <div
      role="status"
      className="flex flex-col sm:flex-row sm:items-center gap-[12px] rounded-[12px] border border-btnPrimary/40 bg-btnPrimary/10 p-[14px] text-[14px]"
    >
      <div className="flex-1 min-w-0">
        <div className="font-[600]">
          {t('did_not_finish_connecting', `Didn't finish connecting ${name}?`)}
        </div>
        <div className="opacity-80 mt-[4px]">{abandonedConnectTip(provider)}</div>
      </div>
      <div className="flex gap-[8px] shrink-0">
        <button
          type="button"
          onClick={() => {
            dismiss();
            onTryAgain();
          }}
          className="h-[40px] px-[16px] rounded-[8px] bg-btnPrimary text-hp-on-primary font-[600]"
        >
          {t('try_again', 'Try again')}
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="h-[40px] px-[16px] rounded-[8px] border border-tableBorder"
        >
          {t('dismiss', 'Dismiss')}
        </button>
      </div>
    </div>
  );
};
