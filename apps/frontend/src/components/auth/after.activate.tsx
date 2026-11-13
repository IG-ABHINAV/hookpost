'use client';

import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { LoadingComponent } from '@hookpost/frontend/components/layout/loading';
import { useCallback, useLayoutEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@hookpost/react/form/button';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import useCookie from 'react-use-cookie';
import {
  ACTIVATION_CONFIRM_PATH,
  forgetActivationCode,
  takeActivationCode,
} from '@hookpost/frontend/components/auth/activation.link';

const tabStorage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/**
 * The page the emailed "Confirm email" link opens, usually in another browser
 * than the one the account was made in (Gmail opens links in Chrome, not in
 * Instagram's browser). A tap on "Confirm my email" confirms the address and
 * signs in right here; the backend's `onboarding` header then takes the
 * browser into the app (layout.context.tsx). Nothing happens on load: email
 * scanners that open links (and run their scripts) must not use them up, or
 * get a session.
 *
 * The token leaves the address bar before any analytics script reads it
 * (activation.link.ts). A link that is expired, already used, or for an
 * address the account no longer has is refused, and says what to do next.
 */
export const AfterActivate = () => {
  const fetch = useFetch();
  const params = useParams();
  const t = useT();
  const [datafast_visitor_id] = useCookie('datafast_visitor_id');
  const [code, setCode] = useState<string | null | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);

  // Before paint and before every passive effect, which is where the
  // analytics start (PostHog, datafast, the pixel's PageView).
  useLayoutEffect(() => {
    const taken = takeActivationCode(params?.code, tabStorage());
    if (window.location.pathname !== ACTIVATION_CONFIRM_PATH) {
      window.history.replaceState(window.history.state, '', ACTIVATION_CONFIRM_PATH);
    }
    setCode(taken);
    if (!taken) {
      setFailed(true);
    }
  }, []);

  const confirm = useCallback(async () => {
    if (!code) {
      setFailed(true);
      return;
    }
    setConfirming(true);
    try {
      const res = await fetch(`/auth/activate`, {
        method: 'POST',
        body: JSON.stringify({ code, datafast_visitor_id }),
        headers: { 'Content-Type': 'application/json' },
      });
      const { can } = await res.json().catch(() => ({ can: false }));
      forgetActivationCode(tabStorage());
      if (!can) {
        setFailed(true);
        setConfirming(false);
      }
      // can: the response's onboarding header is already taking the browser
      // into the app; stay on the spinner until it does.
    } catch (e) {
      setFailed(true);
      setConfirming(false);
    }
  }, [code, datafast_visitor_id]);

  if (failed) {
    return (
      <div className="flex flex-col gap-[16px] text-start" role="alert" data-testid="activation-link-refused">
        <h1 className="text-[24px] font-[600]">
          {t('activation_link_refused_title', 'This link can no longer be used')}
        </h1>
        <p className="text-[15px] text-textColor/80">
          {t(
            'activation_link_refused_body',
            'It has expired, was already used, or was sent to an address your account no longer uses. If your email is already confirmed, just sign in. Otherwise sign in and press "Resend link" at the top of the page.'
          )}
        </p>
        <Link href="/auth/login" className="underline text-[14px]">
          {t('sign_in', 'Sign In')}
        </Link>
        <Link href="/auth/activate" className="underline text-[14px]">
          {t('send_a_new_link', 'Send me a new link')}
        </Link>
      </div>
    );
  }

  if (code === undefined) {
    return <LoadingComponent />;
  }

  return (
    <div className="flex flex-col gap-[16px] text-start" data-testid="activation-confirm">
      <h1 className="text-[24px] font-[600]">
        {t('confirm_your_email', 'Confirm your email')}
      </h1>
      <p className="text-[15px] text-textColor/80">
        {t(
          'activation_confirm_body',
          'One tap and your posts can go out. This also signs you in on this device.'
        )}
      </p>
      <Button
        type="button"
        onClick={confirm}
        loading={confirming}
        className="rounded-[10px] !h-[52px]"
      >
        {t('confirm_my_email', 'Confirm my email')}
      </Button>
    </div>
  );
};
