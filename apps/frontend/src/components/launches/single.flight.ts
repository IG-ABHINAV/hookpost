'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One connect (or sign-in) at a time. Until the link comes back nothing on
 * screen changed, so people tapped again: org d4ad9404 opened Instagram's
 * connect 5 times in 5 s on 22 Oct, and a Razorpay reviewer pressed
 * "Continue with Google" 4 times in 2 s on 18 Oct. Each tap made a new OAuth
 * state and a new navigation.
 *
 * `run(key, fn)` ignores further calls while one is in flight and exposes the
 * key as `pending` for a spinner. When `fn` returns true the browser is
 * leaving for the provider, so the guard stays up; it comes down when the
 * page shows again (Back from the provider restores it from the cache, or an
 * app such as X's opened instead and the person came back) or after
 * `resetAfterMs`, so a navigation that never happens cannot lock the screen.
 */
export const useSingleFlight = (resetAfterMs = 10_000) => {
  const current = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    current.current = null;
    setPending(null);
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && current.current) {
        clear();
      }
    };
    window.addEventListener('pageshow', clear);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('pageshow', clear);
      document.removeEventListener('visibilitychange', onVisible);
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, [clear]);

  const run = useCallback(
    async (key: string, fn: () => Promise<boolean | void> | boolean | void) => {
      if (current.current) {
        return;
      }
      current.current = key;
      setPending(key);
      let leaving = false;
      try {
        leaving = (await fn()) === true;
      } finally {
        if (leaving) {
          timer.current = setTimeout(clear, resetAfterMs);
        } else {
          clear();
        }
      }
    },
    [clear, resetAfterMs]
  );

  return { pending, run };
};

/** A device without hover (a phone or tablet): tooltips never show there. */
export const isTouchOnly = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(hover: none)').matches;
