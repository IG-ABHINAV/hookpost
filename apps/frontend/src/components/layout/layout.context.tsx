'use client';

import { ReactNode, useCallback } from 'react';
import { FetchWrapperComponent } from '@hookpost/helpers/utils/custom.fetch';
import { deleteDialog } from '@hookpost/react/helpers/delete.dialog';
import { useReturnUrl } from '@hookpost/frontend/app/(app)/auth/return.url.component';
import { useVariables } from '@hookpost/react/helpers/variable.context';
import {
  isTwaClient,
  twaLimitMessage,
} from '@hookpost/frontend/components/layout/twa';
import { twaPlanDialog } from '@hookpost/frontend/components/layout/twa.component';
import {
  planLimitPrompt,
  readPlanRefusal,
  showPlanDialogOnce,
} from '@hookpost/frontend/components/layout/plan.limit.prompt';
import { SESSION_TTL_DAYS } from '@hookpost/helpers/auth/session.lifetime';
import { customFetch } from '@hookpost/helpers/utils/custom.fetch.func';
import { useToaster } from '@hookpost/react/toaster/toaster';
import { mutate } from 'swr';
import {
  EMAIL_VERIFICATION_REQUIRED,
  readEmailNotVerifiedRefusal,
  recordVerificationResend,
  sendResultMessage,
  showVerificationPromptOnce,
} from '@hookpost/frontend/components/layout/email.verification';

export default function LayoutContext(params: { children: ReactNode }) {
  if (params?.children) {
    // eslint-disable-next-line react/no-children-prop
    return <LayoutContextInner children={params.children} />;
  }
  return <></>;
}
export function setCookie(cname: string, cvalue: string, exdays: number) {
  if (typeof document === 'undefined') {
    return;
  }
  const d = new Date();
  d.setTime(d.getTime() + exdays * 24 * 60 * 60 * 1000);
  const expires = 'expires=' + d.toUTCString();
  document.cookie = cname + '=' + cvalue + ';' + expires + ';path=/';
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    const parts = host.split('.');
    if (parts.length > 2) {
      const rootDomain = '.' + parts.slice(-2).join('.');
      document.cookie = cname + '=' + cvalue + ';' + expires + ';path=/;domain=' + rootDomain;
    }
  }
}
function LayoutContextInner(params: { children: ReactNode }) {
  const returnUrl = useReturnUrl();
  const { backendUrl, isGeneral, isSecured } = useVariables();
  const toaster = useToaster();

  // The readable login hint used to be written here on every mount, before
  // anything knew whether the visitor was signed in - so an expired session
  // re-armed it on the way to its own 401. It is now written only when the
  // backend confirms the session (see afterRequest: a 2xx from /user/self).
  const afterRequest = useCallback(
    async (url: string, options: RequestInit, response: Response) => {
      if (
        typeof window !== 'undefined' &&
        (window.location.href.includes('/p/') ||
          window.location.pathname.startsWith('/provider/'))
      ) {
        return true;
      }
      const headerAuth =
        response?.headers?.get('auth') || response?.headers?.get('Auth');
      const showOrg =
        response?.headers?.get('showorg') || response?.headers?.get('Showorg');
      const impersonate =
        response?.headers?.get('impersonate') ||
        response?.headers?.get('Impersonate');
      const logout =
        response?.headers?.get('logout') || response?.headers?.get('Logout');
      // NOT_SECURED only: the session (and each renewal of it) comes back in
      // this header, and lives as long as the token inside it.
      if (headerAuth) {
        setCookie('auth', headerAuth, SESSION_TTL_DAYS);
      }
      if (response?.ok && url.includes('/user/self')) {
        setCookie('hp_logged_in', '1', 365);
      }
      if (showOrg) {
        setCookie('showorg', showOrg, 365);
      }
      if (impersonate) {
        setCookie('impersonate', impersonate, 365);
      }
      if (logout && !isSecured) {
        setCookie('auth', '', -10);
        setCookie('showorg', '', -10);
        setCookie('impersonate', '', -10);
        setCookie('hp_logged_in', '', -10);
        if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/auth')) {
          window.location.href = '/auth/login';
          return true;
        }
      }
      const reloadOrOnboarding =
        response?.headers?.get('reload') ||
        response?.headers?.get('onboarding');
      if (reloadOrOnboarding) {
        const getAndClear = returnUrl.getAndClear();
        if (getAndClear) {
          window.location.href = getAndClear;
          return true;
        }
      }
      if (response?.headers?.get('onboarding')) {
        window.location.href = isGeneral
          ? '/launches?onboarding=true'
          : '/analytics?onboarding=true';
        return true;
      }

      if (response?.headers?.get('reload')) {
        if (window.location.pathname.startsWith('/auth')) {
          window.location.href = isGeneral ? '/launches' : '/analytics';
          return true;
        }
        window.location.reload();
        return true;
      }

      if (response.status === 401 || response?.headers?.get('logout')) {
        setCookie('auth', '', -10);
        setCookie('showorg', '', -10);
        setCookie('impersonate', '', -10);
        setCookie('hp_logged_in', '', -10);
        if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/auth')) {
          window.location.href = '/auth/login';
          return true;
        }
      }
      if (response.status === 406) {
        // Google Play app: no route to checkout (see layout/twa.ts).
        if (isTwaClient()) {
          await twaPlanDialog(
            'This feature needs a paid plan, and your trial has not ended yet.',
            'Trial'
          );
          return false;
        }
        if (
          await deleteDialog(
            'You are currently on trial, in order to use the feature you must finish the trial',
            'Finish the trial, charge me now',
            'Trial',

          )
        ) {
          window.open('/billing?finishTrial=true', '_blank');
          return false;
        }
        return false;
      }

      if (response.status === 402) {
        // Read from a copy: the caller gets the 402 unread (see
        // readPlanRefusal), and only one plan dialog shows at a time. Once
        // the dialog is dismissed the caller carries on with a 402 whose
        // body says `url: .../billing`, so every caller checks `ok` before
        // reading it as a result (add.channel.helpers.ts fetchConnectLink).
        const body = await readPlanRefusal(response);
        // Google Play app: the limit, without the backend's "Upgrade to ..."
        // or "Start a N-day free trial ..." sentence, and no route to /billing.
        if (isTwaClient()) {
          await showPlanDialogOnce(() =>
            twaPlanDialog(twaLimitMessage(body?.message))
          );
          return true;
        }
        const prompt = planLimitPrompt(body);
        // [Switch to <workspace>] [See plans]: switch on the first, the
        // plans on the second, nothing when the dialog is closed.
        if (prompt.switchTo) {
          const target = prompt.switchTo;
          const choice = await showPlanDialogOnce(() =>
            deleteDialog(prompt.message, prompt.button, prompt.title, prompt.secondButton)
          );
          if (choice === true) {
            const switched = await customFetch({ baseUrl: backendUrl })('/user/change-org', {
              method: 'POST',
              body: JSON.stringify({ id: target.id }),
            }).catch(() => null);
            // Not switched: leave the refusal to the caller, which says the
            // post was not saved, rather than reload into the same 402.
            if (!switched?.ok) return true;
            window.location.reload();
            return false;
          }
          if (choice === false) {
            window.location.href = '/billing';
            return false;
          }
          return true;
        }
        if (
          await showPlanDialogOnce(() =>
            deleteDialog(
              prompt.message,
              prompt.button,
              prompt.title,
              'Not now'
            )
          )
        ) {
          window.location.href = prompt.href || '/billing';
          return false;
        }
        return true;
      }

      // Publishing (or an invite, a webhook, an OAuth app) refused until the
      // email is confirmed: say so, with the link one tap away. The caller
      // still gets the 403 and says what was not saved.
      if (response.status === 403) {
        // The hard gate: this account has to confirm its email before
        // anything. "Check your inbox" is the app's own page for it
        // (layout.component.tsx): pages outside the app layout (an invite,
        // an OAuth consent) go there; inside it, reading /user/self again
        // puts it up. No dialog on top.
        const gate = await response
          .clone()
          .json()
          .catch(() => null);
        if (gate?.code === EMAIL_VERIFICATION_REQUIRED) {
          if (window.location.pathname !== '/launches') {
            window.location.href = '/launches';
            return false;
          }
          await mutate('/user/self');
          return true;
        }
        const refusal = await readEmailNotVerifiedRefusal(response);
        if (refusal) {
          const resend = await showVerificationPromptOnce(() =>
            deleteDialog(
              refusal.message,
              'Email me the link again',
              'Confirm your email',
              'Not now'
            )
          );
          if (resend) {
            const sent = await customFetch({ baseUrl: backendUrl })(
              '/verify-email/resend',
              { method: 'POST' }
            )
              .then((res) => (res.ok ? res.json() : null))
              .catch(() => null);
            const line = sendResultMessage(sent);
            recordVerificationResend(line.text);
            toaster.show(line.text, line.ok ? 'success' : 'warning');
          }
        }
        return true;
      }
      return true;
    },
    []
  );
  return (
    <FetchWrapperComponent baseUrl={backendUrl} afterRequest={afterRequest}>
      {params?.children || <></>}
    </FetchWrapperComponent>
  );
}
