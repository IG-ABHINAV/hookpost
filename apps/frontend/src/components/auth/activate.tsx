'use client';

import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { FormProvider, SubmitHandler, useForm } from 'react-hook-form';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { tooManyAttemptsMessage } from '@hookpost/frontend/components/auth/too.many.attempts';
import { Button } from '@hookpost/react/form/button';
import { Input } from '@hookpost/react/form/input';
import { useState, useEffect } from 'react';
import Link from 'next/link';

type ResendInputs = {
  email: string;
};

const COOLDOWN_SECONDS = 60;

/**
 * /auth/activate, signed out: get the confirmation link again. Since 25 Oct
 * 2026 a password sign-up is signed in straight away and confirms from the
 * banner in the app, so this page is for someone who is not signed in here
 * (another phone, a link that expired). The link it sends also signs in.
 *
 * The backend answers the same for every address (it says nothing about who
 * has an account), so neither does this page.
 */
export function Activate() {
  const t = useT();
  const fetch = useFetch();
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const form = useForm<ResendInputs>();

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const onSubmit: SubmitHandler<ResendInputs> = async (data) => {
    setLoading(true);
    try {
      const response = await fetch('/auth/resend-activation', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      const tooMany = await tooManyAttemptsMessage(response);
      if (response.ok) {
        setSentTo(data.email.trim());
        setCooldown(COOLDOWN_SECONDS);
      } else {
        form.setError('email', {
          message:
            tooMany ??
            t('enter_a_valid_email', 'Enter a valid email address.'),
        });
      }
    } catch (e) {
      form.setError('email', {
        message: t('error_occurred', 'An error occurred. Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col flex-1">
      <div>
        <h1 className="text-3xl font-bold text-start mb-4 cursor-pointer">
          {t('confirm_your_email', 'Confirm your email')}
        </h1>
      </div>
      <div className="text-textColor">
        {t(
          'activation_page_intro',
          'You can sign in and set up your workspace now. Your posts go out once you confirm your email with the link we sent you.'
        )}
      </div>
      <Link href="/auth/login" className="mt-4">
        <Button className="rounded-[10px] !h-[52px] w-full">
          {t('sign_in', 'Sign In')}
        </Button>
      </Link>

      <div className="mt-8 border-t border-fifth pt-6">
        <h2 className="text-lg font-semibold mb-4">
          {t('need_a_new_link', 'Need a new link?')}
        </h2>
        {sentTo && (
          <div className="text-green-400 mb-4" role="status" data-testid="resend-sent">
            {t(
              'activation_link_sent_if_waiting',
              'If {{email}} has an account waiting for confirmation, a new link is on its way. It also signs you in. Check the spam folder too.',
              // React escapes the text; i18next escaping it too would show
              // an apostrophe in an address as &#39;.
              { email: sentTo, interpolation: { escapeValue: false } }
            )}
          </div>
        )}
        <FormProvider {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <Input
              label={t('label_email', 'Email')}
              translationKey="label_email"
              {...form.register('email', { required: true })}
              type="email"
              placeholder={t('email_address', 'Email Address')}
            />
            <Button
              type="submit"
              className="rounded-[10px] !h-[52px]"
              loading={loading}
              disabled={cooldown > 0}
            >
              {cooldown > 0
                ? `${t('resend_available_in', 'You can resend in')} ${cooldown}s`
                : t('resend_activation_email', 'Resend Activation Email')}
            </Button>
          </form>
        </FormProvider>
      </div>
    </div>
  );
}
