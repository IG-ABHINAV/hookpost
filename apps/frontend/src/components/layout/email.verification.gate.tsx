'use client';

import { FC, FormEvent, useCallback, useEffect, useState } from 'react';
import { mutate } from 'swr';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { HeldInviteNotice } from '@hookpost/frontend/components/layout/held.invite.notice';
import {
  needsEmailVerification,
  sendResultMessage,
  VerificationSendResult,
} from '@hookpost/frontend/components/layout/email.verification';

/**
 * "Check your inbox": the whole app for an email+password account that has
 * not confirmed its address (owner, 29 Oct 2026: the hard gate,
 * email.verification.ts in the backend). The backend refuses everything else
 * it could call (403 EMAIL_VERIFICATION_REQUIRED), so this is all it gets:
 * resend the link, change the address, sign out. A Google (or any OAuth)
 * sign-in never sees it.
 *
 * Shows the address the link went to, because a mistyped one is a dead end
 * otherwise: on 24 Oct 2026 a sign-up typed a Gmail address that does not
 * exist and pressed "Resend" four times, and every email bounced or was
 * suppressed while the page said "sent". "Wrong address?" moves the account
 * and sends the link there.
 *
 * The link is usually opened in another app or browser (Gmail opens it in
 * Chrome, not in Instagram's browser), so the user is read again whenever
 * this tab comes back into view, and the app opens once it is confirmed.
 */
export const EmailVerificationGate: FC = () => {
  const user = useUser();
  const fetch = useFetch();
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(
    null
  );
  const show = needsEmailVerification(user);

  useEffect(() => {
    if (!show) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        mutate('/user/self');
      }
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [show]);

  const send = useCallback(
    async (path: string, body?: unknown) => {
      setBusy(true);
      setStatus(null);
      try {
        const res = await fetch(path, {
          method: 'POST',
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const message = Array.isArray(json?.message)
            ? json.message[0]
            : json?.message;
          setStatus({
            ok: false,
            text:
              typeof message === 'string' && message
                ? message
                : 'Could not send the email. Please try again.',
          });
          return null;
        }
        const result = json as VerificationSendResult;
        setStatus(sendResultMessage(result));
        if (result.sent === false && result.reason === 'already_verified') {
          await mutate('/user/self');
        }
        return result;
      } catch (e) {
        setStatus({
          ok: false,
          text: 'Could not reach Hookpost. Check your connection and try again.',
        });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [fetch]
  );

  const resend = useCallback(() => send('/verify-email/resend'), [send]);

  const signOut = useCallback(async () => {
    setBusy(true);
    await fetch('/user/logout', { method: 'POST' }).catch(() => null);
    window.location.href = '/auth/login';
  }, [fetch]);

  const change = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const result = await send('/verify-email/change', { email: newEmail });
      if (result?.sent) {
        setChanging(false);
        setNewEmail('');
        await mutate('/user/self');
      }
    },
    [send, newEmail]
  );

  if (!show) return null;

  return (
    <main
      data-testid="email-verification-gate"
      aria-labelledby="verification-title"
      className="min-h-[100dvh] w-full flex items-center justify-center bg-newBgColor px-[16px] py-[32px] text-newTextColor"
    >
      <div className="w-full max-w-[480px] flex flex-col gap-[16px] rounded-[12px] bg-newBgColorInner p-[24px] text-[15px]">
        <h1 id="verification-title" className="text-[22px] font-[600]">
          Check your inbox
        </h1>
        <p>
          We sent a link to{' '}
          <span className="font-[600] break-all" data-testid="verification-address">
            {user?.email}
          </span>
          . Open it to start using Hookpost. It can take a minute, and it may be in Spam.
        </p>
        <HeldInviteNotice />
        <div className="flex flex-wrap items-center gap-[12px]">
          <button
            type="button"
            onClick={resend}
            disabled={busy}
            className="h-[40px] flex items-center rounded-[8px] bg-forth px-[16px] font-[600] text-hp-on-primary disabled:opacity-50"
          >
            Resend link
          </button>
          <button
            type="button"
            onClick={() => {
              setChanging((v) => !v);
              setStatus(null);
            }}
            aria-expanded={changing}
            className="underline text-textItemBlur hover:text-newTextColor"
          >
            Wrong address?
          </button>
          <button
            type="button"
            onClick={signOut}
            disabled={busy}
            className="ms-auto underline text-textItemBlur hover:text-newTextColor"
          >
            Sign out
          </button>
        </div>
      {changing && (
        <form onSubmit={change} className="flex flex-wrap items-center gap-[8px]">
          <label htmlFor="verification-new-email" className="sr-only">
            Your email address
          </label>
          <input
            id="verification-new-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="you@example.com"
            className="h-[36px] flex-1 min-w-[200px] rounded-[8px] border border-fifth bg-transparent px-[12px] text-newTextColor"
          />
          <button
            type="submit"
            disabled={busy || !newEmail}
            className="h-[36px] rounded-[8px] bg-forth px-[16px] font-[600] text-hp-on-primary disabled:opacity-50"
          >
            Send the link here
          </button>
        </form>
      )}
      {status && (
        <div
          role="status"
          aria-live="polite"
          className={status.ok ? 'text-green-400' : 'text-amber-400'}
        >
          {status.text}
        </div>
      )}
      </div>
    </main>
  );
};
