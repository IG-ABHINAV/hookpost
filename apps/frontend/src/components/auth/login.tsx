'use client';

import { useForm, SubmitHandler, FormProvider } from 'react-hook-form';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { tooManyAttemptsMessage } from '@hookpost/frontend/components/auth/too.many.attempts';
import Link from 'next/link';
import { Button } from '@hookpost/react/form/button';
import { Input } from '@hookpost/react/form/input';
import { useEffect, useMemo, useState } from 'react';
import { classValidatorResolver } from '@hookform/resolvers/class-validator';
import { LoginUserDto } from '@hookpost/nestjs-libraries/dtos/auth/login.user.dto';
import { GithubProvider } from '@hookpost/frontend/components/auth/providers/github.provider';
import { OauthProvider } from '@hookpost/frontend/components/auth/providers/oauth.provider';
import { GoogleProvider } from '@hookpost/frontend/components/auth/providers/google.provider';
import {
  InAppBrowserNotice,
  useIsInAppBrowser,
} from '@hookpost/frontend/components/auth/in-app-browser-notice';
import { AppleProvider } from '@hookpost/frontend/components/auth/providers/apple.provider';
import { useVariables } from '@hookpost/react/helpers/variable.context';
import { FarcasterProvider } from '@hookpost/frontend/components/auth/providers/farcaster.provider';
import WalletProvider from '@hookpost/frontend/components/auth/providers/wallet.provider';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
type Inputs = {
  email: string;
  password: string;
  providerToken: '';
  provider: 'LOCAL';
};
export function Login() {
  const t = useT();
  const isInApp = useIsInAppBrowser();
  const [loading, setLoading] = useState(false);
  const {
    isGeneral,
    neynarClientId,
    appleClientId,
    billingEnabled,
    genericOauth,
  } = useVariables();
  // In an in-app browser only Google is hidden: it refuses OAuth there
  // (disallowed_useragent), and the card above says so. Every other way in
  // stays, so an account made with it can still sign in.
  const showProviders =
    !!genericOauth ||
    !isInApp ||
    !!appleClientId ||
    !!neynarClientId ||
    !!billingEnabled;

  useEffect(() => {
    if (
      typeof document !== 'undefined' &&
      (document.cookie.includes('hp_logged_in=1') ||
        document.cookie.includes('auth='))
    ) {
      fetch('/api/user/self', { credentials: 'include' })
        .then((res) => {
          if (res.ok) {
            window.location.replace('/launches');
          }
        })
        .catch(() => {});
    }
  }, []);
  const resolver = useMemo(() => {
    return classValidatorResolver(LoginUserDto);
  }, []);
  const form = useForm<Inputs>({
    resolver,
    defaultValues: {
      providerToken: '',
      provider: 'LOCAL',
    },
  });
  const fetchData = useFetch();
  const onSubmit: SubmitHandler<Inputs> = async (data) => {
    setLoading(true);
    // An account that has not confirmed its email signs in like any other
    // since 25 Oct 2026 (the app's banner asks for the confirmation), so
    // "User is not activated" is no longer an answer here.
    const login = await fetchData('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        ...data,
        provider: 'LOCAL',
      }),
    });
    // 429: too many wrong passwords for this address or network
    // (auth.rate.limit.ts); the backend's sentence says how long to wait.
    const tooMany = await tooManyAttemptsMessage(login);
    if (tooMany || login.status === 400) {
      form.setError('email', {
        message: tooMany ?? (await login.text()),
      });
      setLoading(false);
    }
  };
  return (
    <FormProvider {...form}>
      <form className="flex-1 flex" onSubmit={form.handleSubmit(onSubmit)}>
        <div className="flex flex-col flex-1">
          <div>
            <h1 className="text-[40px] font-[500] -tracking-[0.8px] text-start cursor-pointer">
              {t('sign_in', 'Sign In')}
            </h1>
          </div>
          <div className="text-[14px] mt-[32px] mb-[12px]">
            {showProviders ? t('continue_with', 'Continue With') : null}
          </div>
          <div className="flex flex-col">
            {/* Same trap as the signup page: Meta ads open in Facebook's in-app
                browser and Google refuses OAuth there. */}
            <InAppBrowserNotice mode="login" />
            {!showProviders ? null : genericOauth ? (
              <OauthProvider />
            ) : (
              <div className="gap-[8px] flex">
                {/* Google is the button that fails in an in-app browser. */}
                {!isInApp && <GoogleProvider />}
                {!!appleClientId && <AppleProvider />}
                {!!neynarClientId && <FarcasterProvider />}
                {billingEnabled && <WalletProvider />}
              </div>
            )}
            {showProviders && (
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
                  autoComplete="current-password"
                  type="password"
                  placeholder={t('label_password', 'Password')}
                />
              </div>
              <div className="text-center mt-6">
                <div className="w-full flex">
                  <Button
                    type="submit"
                    className="flex-1 rounded-[10px] !h-[52px]"
                    loading={loading}
                  >
                    {t('sign_in_1', 'Sign in')}
                  </Button>
                </div>
                <p className="mt-4 text-sm">
                  {t('don_t_have_an_account', "Don't Have An Account?")}&nbsp;
                  <Link href="/auth" className="underline cursor-pointer">
                    {t('sign_up', 'Sign Up')}
                  </Link>
                </p>
                <p className="mt-4 text-sm">
                  <Link
                    href="/auth/forgot"
                    className="underline hover:font-bold cursor-pointer"
                  >
                    {t('forgot_password', 'Forgot password')}
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
