'use client';

import { useCallback, useRef, useState } from 'react';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';

/**
 * "Start free" on the plans screen, shared by the button above the plan cards
 * (first.billing.component.tsx) and the link under the checkout button
 * (razorpay.billing.tsx).
 *
 * The plans screen sits in front of /launches for a Free workspace, so the
 * sign-up's /launches?onboarding=true was lost on the way through it: "Start
 * free" went to a bare /launches and no Free sign-up ever saw the "Connect
 * your channels" onboarding. A workspace with no channel yet now lands on it.
 */
export const CONTINUE_FREE_FLAG = 'hookpost_continue_free';

export const startFreeDestination = (hasChannels: boolean): string =>
  hasChannels ? '/launches' : '/launches?onboarding=true';

/**
 * The browser's copy of the choice, read by layout.component.tsx. The server
 * keeps its own (/user/self continueFree); this one still works before the
 * server answers, and where the server could not store it.
 */
export const rememberContinueFree = () => {
  try {
    localStorage.setItem(CONTINUE_FREE_FLAG, 'true');
  } catch (e) {
    // Blocked storage: the cookie below still carries it.
  }
  document.cookie = `${CONTINUE_FREE_FLAG}=true; path=/; max-age=31536000; SameSite=Lax`;
};

/**
 * How long "Start free" waits for the server before leaving anyway. The
 * request carries on (keepalive); only the "has a channel" answer is lost,
 * and the onboarding lists any channel.
 */
export const START_FREE_WAIT_MS = 3000;

/** `work`, or `fallback` once `ms` have passed or `work` fails. */
export const settleWithin = <T>(
  work: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> =>
  new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });

/**
 * Remembers the choice in this browser and on the server (POST
 * /user/free-plan), so the plans screen does not come back on another
 * browser or phone, then goes to the onboarding or the calendar.
 *
 * `starting` is true from the tap until the page leaves: the button shows it
 * is working, and a second tap does nothing. A slow or hung request no longer
 * holds the user on the plans screen; after START_FREE_WAIT_MS they go on.
 */
export const useStartFree = () => {
  const fetch = useFetch();
  const [starting, setStarting] = useState(false);
  const busy = useRef(false);
  const startFree = useCallback(async () => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setStarting(true);
    rememberContinueFree();
    const hasChannels = await settleWithin(
      fetch('/user/free-plan', { method: 'POST', keepalive: true }).then(
        async (response) =>
          response.ok ? !!(await response.json())?.hasChannels : false
      ),
      START_FREE_WAIT_MS,
      // Unknown: the onboarding is the safe default, it lists any channel.
      false
    );
    window.location.href = startFreeDestination(hasChannels);
  }, [fetch]);
  return { startFree, starting };
};
