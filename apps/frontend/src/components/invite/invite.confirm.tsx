'use client';

import { FC, useCallback, useEffect, useState } from 'react';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import {
  displayName,
  INVITER_NAME_MAX,
  TEAM_NAME_MAX,
} from '@hookpost/helpers/auth/team.invite';

/**
 * What GET /user/invite says about the invite a signed-in visitor opened
 * (AuthService.pendingInvite). Read loosely: anything unexpected is "not
 * valid", never a guess.
 */
export type InviteQuestion =
  | { valid: false }
  | {
      valid: true;
      team: string;
      inviter: string;
      member: boolean;
      confirmEmail: boolean;
      ref: string;
    };

export function readInviteQuestion(body: unknown): InviteQuestion {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (b.valid !== true || typeof b.ref !== 'string' || !b.ref) {
    return { valid: false };
  }
  return {
    valid: true,
    // Made fit to show by the backend already; again here, so this page
    // never relies on that: one line, no control or direction characters,
    // at most 60 characters. Rendered as text only.
    team: displayName(b.team, TEAM_NAME_MAX) || 'this team',
    inviter: displayName(b.inviter, INVITER_NAME_MAX) || 'a team member',
    member: b.member === true,
    confirmEmail: b.confirmEmail === true,
    ref: b.ref,
  };
}

/**
 * Join works only while this page is the one in front (visible and
 * focused), and only once it has been for this long: after the question
 * appears, and again whenever the window gets focus back. A click meant for
 * something else never lands on it: the second click of a double click, a
 * popup that closes on mousedown to reveal this page under the pointer
 * (still "visible" while partly covered, but not focused), a swapped tab.
 * Framing is refused outright (next.config.js).
 */
export const ARM_DELAY_MS = 500;

/** Whether Join may be pressed for the question `key` (null: none shown). */
function useArmed(key: string | null, delayMs: number) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (key === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => {
      clearTimeout(timer);
      setArmed(false);
    };
    const arm = () => {
      disarm();
      if (document.visibilityState !== 'hidden' && document.hasFocus()) {
        timer = setTimeout(() => setArmed(true), delayMs);
      }
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    window.addEventListener('focus', arm);
    window.addEventListener('blur', disarm);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', arm);
      window.removeEventListener('focus', arm);
      window.removeEventListener('blur', disarm);
    };
  }, [key, delayMs]);
  return armed;
}

type State =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'question'; question: InviteQuestion };

const AFTER = '/launches';

/**
 * The page a signed-in visitor sees after opening a team invite link
 * (/invite/<token> -> /invite): "Join <team>? You were invited by <name>.
 * [Join team] [Not now]". Nothing is joined until Join is pressed, which
 * POSTs /user/invite/accept (JSON, from this origin; the token stays in its
 * httpOnly cookie, the page only knows its `ref`). "Not now" leaves the
 * invite unused, so its link works again until it expires. Either way the
 * app opens next and says what happened (InviteResultToast).
 */
export const InviteConfirm: FC<{
  /** Where to go afterwards; a full page load, so the app reads the new workspace. */
  navigate?: (path: string) => void;
  /** How long Join stays off after the question shows (useArmed). */
  armDelayMs?: number;
}> = ({ navigate = (path) => window.location.assign(path), armDelayMs = ARM_DELAY_MS }) => {
  const fetch = useFetch();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const asking = state.kind === 'question' && state.question.valid;
  const armed = useArmed(
    asking ? (state.question as { ref: string }).ref : null,
    armDelayMs
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch('/user/invite');
      if (!res.ok) {
        setState({ kind: 'failed' });
        return;
      }
      setState({ kind: 'question', question: readInviteQuestion(await res.json()) });
    } catch {
      setState({ kind: 'failed' });
    }
  }, [fetch]);

  useEffect(() => {
    load();
  }, []);

  const join = useCallback(
    async (ref: string) => {
      if (busy) return;
      setBusy(true);
      setNote('');
      try {
        const res = await fetch('/user/invite/accept', {
          method: 'POST',
          body: JSON.stringify({ ref }),
        });
        if (res.ok) {
          navigate(AFTER);
          return;
        }
        if (res.status === 409) {
          // Another invite link was opened in the meantime: show that one.
          setNote('A different invite was opened since this page loaded. Here it is.');
          await load();
        } else {
          setNote("We couldn't join just now. Please try again.");
        }
      } catch {
        setNote("We couldn't join just now. Please try again.");
      }
      setBusy(false);
    },
    [busy, fetch, load, navigate]
  );

  const notNow = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch('/user/invite/dismiss', { method: 'POST', body: '{}' });
    } catch {
      // The question expires on its own within the hour.
    }
    navigate(AFTER);
  }, [busy, fetch, navigate]);

  return (
    <div className="flex flex-1 items-center justify-center text-white relative overflow-hidden">
      <div className="absolute inset-0 opacity-30" aria-hidden="true">
        <div className="absolute top-[20%] left-[10%] w-[300px] h-[300px] bg-hp-primary rounded-full blur-[120px]" />
        <div className="absolute bottom-[20%] right-[10%] w-[250px] h-[250px] bg-hp-primary rounded-full blur-[120px]" />
      </div>
      <main
        data-testid="invite-confirm"
        className="relative z-10 w-full max-w-[480px] mx-auto px-[16px]"
      >
        <div className="bg-[#1A1919] rounded-[16px] p-[24px] sm:p-[32px] flex flex-col gap-[20px]">
          {state.kind === 'loading' && (
            <div role="status" className="text-[15px] text-gray-400 text-center">
              Checking your invite...
            </div>
          )}
          {state.kind === 'failed' && (
            <>
              <p role="alert" className="text-[15px] leading-[1.5]">
                {"We couldn't open that invite. Please open the link again."}
              </p>
              <Secondary onClick={notNow} disabled={busy}>
                Go to Hookpost
              </Secondary>
            </>
          )}
          {state.kind === 'question' && !state.question.valid && (
            <>
              <p role="alert" data-invalid="true" className="text-[15px] leading-[1.5]">
                This invite link has expired or was already used. Ask whoever
                invited you for a new one.
              </p>
              <Secondary onClick={notNow} disabled={busy}>
                Go to Hookpost
              </Secondary>
            </>
          )}
          {state.kind === 'question' && state.question.valid && (
            <Question
              question={state.question}
              busy={busy}
              armed={armed}
              onJoin={join}
              onNotNow={notNow}
            />
          )}
          {!!note && (
            <p role="status" className="text-[13px] text-amber-300">
              {note}
            </p>
          )}
        </div>
      </main>
    </div>
  );
};

const Question: FC<{
  question: Extract<InviteQuestion, { valid: true }>;
  busy: boolean;
  armed: boolean;
  onJoin: (ref: string) => void;
  onNotNow: () => void;
}> = ({ question, busy, armed, onJoin, onNotNow }) => (
  <>
    <h1
      data-testid="invite-confirm-title"
      className="text-[22px] font-semibold leading-[1.3] break-words [overflow-wrap:anywhere]"
    >
      {question.member ? (
        <>
          {"You're already a member of "}
          <span data-testid="invite-team">{question.team}</span>.
        </>
      ) : (
        <>
          {'Join '}
          <span data-testid="invite-team">{question.team}</span>?
        </>
      )}
    </h1>
    <p className="text-[15px] text-gray-300 leading-[1.5] break-words [overflow-wrap:anywhere]">
      {'You were invited by '}
      <span data-testid="invite-inviter" className="font-semibold text-white">
        {question.inviter}
      </span>
      .
    </p>
    {question.confirmEmail && (
      <p className="text-[13px] text-gray-400 leading-[1.5]">
        {"You'll join once you confirm your email address."}
      </p>
    )}
    <div className="flex flex-col sm:flex-row gap-[12px]">
      <button
        type="button"
        onClick={() => onJoin(question.ref)}
        disabled={busy || !armed}
        className="flex-1 bg-hp-primary hover:bg-hp-primary-hover disabled:opacity-50 text-hp-on-primary rounded-[8px] py-[10px] px-[16px] text-[14px] font-semibold transition-colors"
      >
        {question.member ? 'Open team' : 'Join team'}
      </button>
      <Secondary onClick={onNotNow} disabled={busy}>
        Not now
      </Secondary>
    </div>
  </>
);

const Secondary: FC<{
  onClick: () => void;
  disabled: boolean;
  children: string;
}> = ({ onClick, disabled, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="flex-1 bg-[#2A2929] hover:bg-[#3A3939] disabled:opacity-50 text-white rounded-[8px] py-[10px] px-[16px] text-[14px] font-semibold transition-colors"
  >
    {children}
  </button>
);
