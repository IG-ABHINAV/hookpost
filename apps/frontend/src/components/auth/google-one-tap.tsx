'use client';

import { useEffect } from 'react';
import { whenEngaged } from '@hookpost/frontend/components/layout/when-engaged';
import { firePixelEvent } from '@hookpost/frontend/components/layout/pixel-event';
import { useReturnUrl } from '@hookpost/frontend/app/(app)/auth/return.url.component';
import { INVITE_CONFIRM_PATH } from '@hookpost/helpers/auth/team.invite';

// Read at module scope: NEXT_PUBLIC_* is only inlined there (a read inside a
// function silently came back undefined once before - see ViewContent).
const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL;

declare global {
  interface Window {
    google?: any;
  }
}

/**
 * Where a One Tap sign-in lands. The backend answers `registered: true` when
 * the tap created the account, and a new account belongs on the "Connect your
 * channels" onboarding, as after the normal sign-up. Three One Tap sign-ups
 * landed on a bare /launches and never saw it.
 *
 * A returning account goes back to the page that sent it to the login form
 * (/auth/login?returnUrl=/billing, see proxy.ts), as the email and Google
 * redirect logins already do through LayoutContext. `returnPath` must come
 * from useReturnUrl().getAndClear(), which only ever yields a same-origin path.
 *
 * A new account sent here by an app asking for access (Claude's connector,
 * /oauth/authorize) goes back to the consent screen instead of the onboarding:
 * otherwise the app never gets its code, as for the One Tap sign-ups from
 * Claude on 27 Oct 2026.
 */
export const oneTapDestination = (
  body: unknown,
  returnPath?: string | null
): string =>
  // Google signed a returning account in by itself on a page opened from a
  // team invite: nothing was joined, and /invite asks whether to.
  (body as { invite?: unknown } | null)?.invite === 'ask'
    ? INVITE_CONFIRM_PATH
    : (body as { registered?: unknown } | null)?.registered === true
    ? returnPath?.startsWith('/oauth/')
      ? returnPath
      : '/launches?onboarding=true'
    : returnPath || '/launches';

/**
 * Google One Tap: the "Continue as <name>" card Google shows in the top-right
 * for a visitor signed in to Google. Picking the account posts Google's ID
 * token to /auth/oauth/google/one-tap, which logs the user in (or registers
 * them) and sets the same cookies as the normal Google login.
 *
 * Renders nothing. Skips itself when the visitor is already logged in, when
 * no client id is configured, or when Google declines to show the prompt.
 */
export function GoogleOneTap({
  autoSelect = false,
  deferUntilEngaged = false,
}: {
  autoSelect?: boolean;
  // Marketing pages: load the GSI client after the first interaction or ~4s,
  // together with the pixel and GTM (see when-engaged.ts), instead of on the
  // first idle callback, which still landed inside the page load. The card
  // still appears for logged-out visitors, a few seconds later.
  deferUntilEngaged?: boolean;
}): null {
  const { getAndClear } = useReturnUrl();
  useEffect(() => {
    if (!CLIENT_ID || !BACKEND) return;
    if (document.cookie.split('; ').some((c) => c === 'hp_logged_in=1')) return;

    let cancelled = false;

    const start = () => {
      if (cancelled || !window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: CLIENT_ID,
        auto_select: autoSelect,
        cancel_on_tap_outside: true,
        context: 'signin',
        itp_support: true,
        use_fedcm_for_prompt: true,
        callback: async ({
          credential,
          select_by,
        }: {
          credential?: string;
          select_by?: string;
        }) => {
          if (!credential) return;
          try {
            // select_by: whether the visitor picked the account or Google
            // signed them in by itself ("auto"); only the first redeems a
            // team invite (auth.controller.ts, googleOneTap).
            const res = await fetch(`${BACKEND}/auth/oauth/google/one-tap`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ credential, select_by }),
            });
            if (res.ok) {
              const body = await res.json().catch(() => null);
              // A new account: the browser half of CompleteRegistration,
              // under the id the backend sent to Meta's Conversions API.
              if (body?.registered === true) {
                firePixelEvent('CompleteRegistration', body.eventId);
              }
              window.location.href = oneTapDestination(body, getAndClear());
            }
          } catch {
            // Leave the page as it is; the normal login buttons still work.
          }
        },
      });
      window.google.accounts.id.prompt();
    };

    const load = () => {
      if (cancelled) return;
      const existing = document.getElementById('google-gsi-client');
      if (existing) {
        if (window.google?.accounts?.id) start();
        else existing.addEventListener('load', start, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.id = 'google-gsi-client';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = start;
      document.head.appendChild(script);
    };

    // The GSI client is a third-party script. Marketing pages score 100 on
    // Lighthouse and were trimmed by 70KB to get there, so it loads only once
    // the page is idle, never in the critical path.
    const w = window as any;
    if (deferUntilEngaged) {
      // `cancelled` makes a late resolve after unmount a no-op.
      whenEngaged().then(load);
      return () => {
        cancelled = true;
        window.google?.accounts?.id?.cancel?.();
      };
    }
    const idle = w.requestIdleCallback
      ? w.requestIdleCallback(load, { timeout: 4000 })
      : window.setTimeout(load, 2500);

    return () => {
      cancelled = true;
      if (w.cancelIdleCallback && w.requestIdleCallback) w.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      window.google?.accounts?.id?.cancel?.();
    };
  }, [autoSelect, deferUntilEngaged, getAndClear]);

  return null;
}
