'use client';

import { FormProvider, SubmitHandler, useForm } from 'react-hook-form';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import Link from 'next/link';
import { Button } from '@hookpost/react/form/button';
import { Input } from '@hookpost/react/form/input';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { classValidatorResolver } from '@hookform/resolvers/class-validator';
import { CreateOrgUserDto } from '@hookpost/nestjs-libraries/dtos/auth/create.org.user.dto';
import { GithubProvider } from '@hookpost/frontend/components/auth/providers/github.provider';
import { useRouter, useSearchParams } from 'next/navigation';
import { LoadingComponent } from '@hookpost/frontend/components/layout/loading';
import clsx from 'clsx';
import { GoogleProvider } from '@hookpost/frontend/components/auth/providers/google.provider';
import { AppleProvider } from '@hookpost/frontend/components/auth/providers/apple.provider';
import { OauthProvider } from '@hookpost/frontend/components/auth/providers/oauth.provider';
import {
  InAppBrowserNotice,
  useIsInAppBrowser,
} from '@hookpost/frontend/components/auth/in-app-browser-notice';
import { useFireEvents } from '@hookpost/helpers/utils/use.fire.events';
import { useVariables } from '@hookpost/react/helpers/variable.context';
import { firePixelEvent } from '@hookpost/frontend/components/layout/pixel-event';
import { FarcasterProvider } from '@hookpost/frontend/components/auth/providers/farcaster.provider';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import useCookie from 'react-use-cookie';
import { reportClientEvent } from '@hookpost/frontend/components/layout/client.event';
type Inputs = {
  email: string;
  password: string;
  company: string;
  providerToken: string;
  provider: string;
};
export function Register() {
  const getQuery = useSearchParams();
  const fetch = useFetch();
  const [provider] = useState(getQuery?.get('provider')?.toUpperCase());
  const [code, setCode] = useState(getQuery?.get('code') || '');
  const [state] = useState(getQuery?.get('state') || '');
  const [show, setShow] = useState(false);
  // Why the provider login could not be finished. Without it a failed
  // /exists (a 500 on 7 Oct, a spent code on a reload) left this page on an
  // endless spinner with no error and no way on.
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (provider && code) {
      load();
    }
  }, []);
  const load = useCallback(async () => {
    const fail = (message: string, reason: string) => {
      setFailure(message);
      reportClientEvent('signup_error', {
        provider: (provider || 'local').toLowerCase(),
        reason,
      });
    };
    try {
      const res = await fetch(
        `/auth/oauth/${provider?.toUpperCase() || 'LOCAL'}/exists`,
        {
          method: 'POST',
          body: JSON.stringify({
            code,
            state,
          }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(
          (typeof body?.message === 'string' && body.message) ||
            SIGN_IN_DID_NOT_FINISH,
          `${res.status} ${body?.message || ''}`.trim()
        );
        return;
      }
      if (body?.token) {
        setCode(body.token);
        setShow(true);
      }
      // { login: true }: an existing account, and the fetch wrapper is
      // already taking the browser to the calendar.
    } catch (e) {
      fail(SIGN_IN_DID_NOT_FINISH, `network ${(e as Error)?.message || ''}`);
    }
  }, [provider, code]);
  if (!code && !provider) {
    return <RegisterAfter token="" provider="LOCAL" />;
  }
  if (failure) {
    return <ProviderSignInFailed provider={provider} message={failure} />;
  }
  if (!show) {
    return <LoadingComponent />;
  }
  return (
    <RegisterAfter token={code} provider={provider?.toUpperCase() || 'LOCAL'} />
  );
}
const SIGN_IN_DID_NOT_FINISH =
  'Signing in did not finish. Please try again, or sign up with your email.';

/**
 * The provider login could not be finished: why, the provider button again,
 * and the email form. The link is a full page load, so the spent ?code= is
 * gone from the address bar and a reload cannot repeat this.
 */
export function ProviderSignInFailed({
  provider,
  message,
}: {
  provider?: string;
  message: string;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-[20px] text-start" role="alert">
      <h1 className="text-[24px] font-[600]">
        {t('sign_in_did_not_finish_title', 'That sign-in did not finish')}
      </h1>
      <p className="text-[15px] text-textColor/80">{message}</p>
      {provider === 'GOOGLE' && (
        <div className="flex">
          <GoogleProvider />
        </div>
      )}
      <a href="/auth" className="underline text-[14px]">
        {t('sign_up_with_email_instead', 'Sign up with your email instead')}
      </a>
    </div>
  );
}

// The backend still needs an organisation name (min 3 chars), but asking for a
// "Company" on the sign-up form cost us people: creators coming from a reel do
// not have one, and on 10-11 Oct 2026 fourteen ad visitors opened this page and
// none submitted it. Name the workspace after the email instead ("My workspace"
// after a Google redirect, where the form has no email).
const PLACEHOLDER_WORKSPACE = 'My workspace';
export function workspaceNameFromEmail(email?: string) {
  const local = (email || '')
    .split('@')[0]
    .replace(/[^\p{L}\p{M}\p{N} ._-]/gu, '')
    .trim()
    .slice(0, 40);
  return local ? `${local}'s workspace` : PLACEHOLDER_WORKSPACE;
}
function getHelpfulReasonForRegistrationFailure(httpCode: number) {
  switch (httpCode) {
    case 400:
      return 'Email already exists';
    case 404:
      return 'Your browser got a 404 when trying to contact the API, the most likely reasons for this are the NEXT_PUBLIC_BACKEND_URL is set incorrectly, or the backend is not running.';
  }
  return 'Unhandled error: ' + httpCode;
}
export function RegisterAfter({
  token,
  provider,
}: {
  token: string;
  provider: string;
}) {
  // Published policy URLs. Absent by default: better no link at all than a link
  // to a domain this deployment does not control.
  const termsUrl = process.env.NEXT_PUBLIC_TERMS_URL;
  const privacyUrl = process.env.NEXT_PUBLIC_PRIVACY_URL;
  const t = useT();
  const {
    isGeneral,
    genericOauth,
    neynarClientId,
    appleClientId,
  } = useVariables();
  const [loading, setLoading] = useState(false);
  // Google refuses OAuth inside Instagram/Facebook's browser, so the button
  // only produces a dead tap there. Hide it and lead with the email form;
  // every other provider stays (none of them refuses an in-app browser).
  const isInApp = useIsInAppBrowser();
  const showProviders =
    !!genericOauth || !isInApp || !!appleClientId || !!neynarClientId;
  const router = useRouter();
  const fireEvents = useFireEvents();
  const [datafast_visitor_id] = useCookie('datafast_visitor_id');
  const isAfterProvider = useMemo(() => {
    return !!token && !!provider;
  }, [token, provider]);
  const resolver = useMemo(() => {
    return classValidatorResolver(CreateOrgUserDto);
  }, []);
  const form = useForm<Inputs>({
    resolver,
    defaultValues: {
      providerToken: token,
      provider: provider,
      // Satisfies the DTO's required company; replaced on submit below.
      company: PLACEHOLDER_WORKSPACE,
    },
  });
  const fetchData = useFetch();
  const onSubmit: SubmitHandler<Inputs> = async (data) => {
    setLoading(true);
    await fetchData('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        ...data,
        company: workspaceNameFromEmail(data.email),
        datafast_visitor_id,
      }),
    })
      .then(async (response) => {
        // Stays loading on success until the redirect lands: on 23 Oct a
        // second tap in that gap sent the form again and showed "already
        // exists" for the account the first tap had just made.
        if (response.status !== 200) {
          setLoading(false);
        }
        if (response.status === 200) {
          fireEvents('register');
          // The backend already sent CompleteRegistration to Meta's
          // Conversions API (with the ad's click id); the pixel fires the
          // browser half under the same event id so Meta keeps one.
          const body = await response
            .clone()
            .json()
            .catch(() => ({}));
          firePixelEvent('CompleteRegistration', body?.eventId);
          // Signed in already: the response's `onboarding` header has sent
          // the browser to the app (layout.context.tsx), where a banner asks
          // for the email confirmation before the first post goes out. Only
          // a backend from before 25 Oct 2026 still answers `activate`.
          if (response.headers.get('activate') === 'true') {
            router.push('/auth/activate');
          }
          return;
        } else {
          form.setError('email', {
            message: await response.text(),
          });
        }
      })
      .catch((e) => {
        setLoading(false);
        form.setError('email', {
          message:
            'General error: ' +
            e.toString() +
            '. Please check your browser console.',
        });
      });
  };
  return (
    <FormProvider {...form}>
      <form className="flex-1 flex" onSubmit={form.handleSubmit(onSubmit)}>
        <div className="flex flex-col flex-1">
          <div>
            <h1 className="text-[40px] font-[500] -tracking-[0.8px] text-start cursor-pointer">
              {t('sign_up', 'Sign Up')}
            </h1>
          </div>
          <div className="text-[14px] mt-[32px] mb-[12px]">
            {/* In-app with only Google configured: no provider buttons
                follow, the email form does. */}
            {!isAfterProvider && !showProviders
              ? null
              : t('continue_with', 'Continue With')}
          </div>
          <div className="flex flex-col text-[14px]">
            {/* 89% of paid traffic arrives in Facebook's in-app browser, where
                Google refuses OAuth outright. Say so before they tap it. */}
            {!isAfterProvider && <InAppBrowserNotice />}
            {!isAfterProvider && showProviders && (
              <div className="gap-[8px] flex">
                {genericOauth ? (
                  <OauthProvider />
                ) : (
                  !isInApp && <GoogleProvider />
                )}
                {!!appleClientId && <AppleProvider />}
                {!!neynarClientId && <FarcasterProvider />}
                {/* No Solana wallet sign-up: on a social media scheduler it read
                    as noise next to Google, and an unlabelled icon button at
                    375px. Sign-in (login.tsx) keeps it behind billingEnabled
                    for any account that was made with a wallet. */}
              </div>
            )}
            {!isAfterProvider && showProviders && (
              <div className="h-[20px] mb-[24px] mt-[24px] relative">
                <div className="absolute w-full h-[1px] bg-fifth top-[50%] -translate-y-[50%]" />
                <div
                  className={`absolute z-[1] justify-center items-center w-full start-0 -top-[4px] flex`}
                >
                  <div className="px-[16px]">{t('or', 'or')}</div>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-[12px]">
              <div className="text-textColor">
                {!isAfterProvider && (
                  <>
                    {/* The whole sign-up: two fields, one button. In an
                        in-app browser it is the way in (Google is hidden). */}
                    <Input
                      label="Email"
                      translationKey="label_email"
                      {...form.register('email')}
                      type="email"
                      autoComplete="email"
                      inputMode="email"
                      placeholder={t('email_address', 'Email Address')}
                    />
                    <Input
                      label="Password"
                      translationKey="label_password"
                      {...form.register('password')}
                      autoComplete="new-password"
                      type="password"
                      placeholder={t('label_password', 'Password')}
                    />
                  </>
                )}
              </div>
              {/*
                Only shown once the operator has published real policies and
                pointed NEXT_PUBLIC_TERMS_URL / NEXT_PUBLIC_PRIVACY_URL at them.
                Upstream hard-coded its own domain here; after the rebrand that
                became a link to a domain this deployment does not control, which
                is worse than no link -- users would be agreeing to terms owned
                by someone else.
              */}
              {termsUrl && privacyUrl ? (
                <div className={clsx('text-[12px]')}>
                  {t(
                    'by_registering_you_agree_to_our',
                    'By registering you agree to our'
                  )}
                  &nbsp;
                  <a
                    href={termsUrl}
                    className="underline hover:font-bold"
                    rel="nofollow"
                  >
                    {t('terms_of_service', 'Terms of Service')}
                  </a>
                  &nbsp;
                  {t('and', 'and')}&nbsp;
                  <a
                    href={privacyUrl}
                    rel="nofollow"
                    className="underline hover:font-bold"
                  >
                    {t('privacy_policy', 'Privacy Policy')}
                  </a>
                  &nbsp;
                </div>
              ) : null}
              <div className="text-center mt-6">
                <div className="w-full flex">
                  <Button
                    type="submit"
                    className="flex-1 rounded-[10px] !h-[52px]"
                    loading={loading}
                  >
                    {t('create_account', 'Create Account')}
                  </Button>
                </div>
                <p className="mt-4 text-sm">
                  {t('already_have_an_account', 'Already Have An Account?')}
                  &nbsp;
                  <Link
                    href="/auth/login"
                    className="underline  cursor-pointer"
                  >
                    {t('sign_in', 'Sign In')}
                  </Link>
                </p>
              </div>
            </div>
          </div>
        </div>
      </form>
    </FormProvider>
  );
}
