'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { customFetch } from '@hookpost/helpers/utils/custom.fetch.func';
import { useVariables } from '@hookpost/react/helpers/variable.context';
import { Logo } from '@hookpost/frontend/components/new-layout/logo';
import { ContextWrapper } from '@hookpost/frontend/components/layout/user.context';
import { EmailVerificationGate } from '@hookpost/frontend/components/layout/email.verification.gate';
import { needsEmailVerification } from '@hookpost/frontend/components/layout/email.verification';
import { isTwaClient } from '@hookpost/frontend/components/layout/twa';
import {
  ConnectorTrialNotice,
  connectorTrialHref,
  connectorTrialNotice,
} from '@hookpost/frontend/components/layout/trial.cta';

export default function OAuthAuthorizePage() {
  const searchParams = useSearchParams();
  const fetch = useFetch();
  const { backendUrl, isSecured } = useVariables();
  // Authorize/Deny skip the app-wide response handler: on a 403
  // EMAIL_NOT_VERIFIED it waits for a dialog this page does not mount, so the
  // request never settled and both buttons stayed disabled. The page says
  // why itself (actionError).
  const plainFetch = useMemo(
    () => customFetch({ baseUrl: backendUrl }, undefined, undefined, isSecured),
    [backendUrl, isSecured]
  );
  const [appInfo, setAppInfo] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // Why Authorize was refused (an unconfirmed email): shown on the consent
  // card, which stays usable so the user can try again once it is fixed.
  const [actionError, setActionError] = useState('');
  // The workspace's plan (/user/self), read alongside the consent request:
  // without a plan, Authorize shows what the trial is for before handing the
  // browser back (trial.cta.ts connectorTrialNotice). Unknown (the request
  // failed) means no card: the redirect is never held up by it.
  const [self, setSelf] = useState<any>(null);
  const [linked, setLinked] = useState<{
    redirect: string;
    notice: ConnectorTrialNotice;
  } | null>(null);

  const clientId = searchParams.get('client_id');
  const responseType = searchParams.get('response_type');
  const state = searchParams.get('state');
  const redirectUri = searchParams.get('redirect_uri');
  const codeChallenge = searchParams.get('code_challenge');
  const codeChallengeMethod = searchParams.get('code_challenge_method');

  useEffect(() => {
    if (!clientId || !responseType) {
      setError('Missing required parameters (client_id, response_type)');
      setLoading(false);
      return;
    }
    if (responseType !== 'code') {
      setError('Only response_type=code is supported');
      setLoading(false);
      return;
    }

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: responseType,
      ...(state ? { state } : {}),
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      ...(codeChallenge ? { code_challenge: codeChallenge } : {}),
      ...(codeChallengeMethod
        ? { code_challenge_method: codeChallengeMethod }
        : {}),
    });

    plainFetch('/user/self')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setSelf(data && !data.statusCode ? data : null))
      .catch(() => setSelf(null));

    fetch(`/oauth/authorize?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.statusCode && data.statusCode >= 400) {
          setError(data.message || 'Invalid OAuth request');
        } else {
          setAppInfo(data);
        }
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to validate OAuth request');
        setLoading(false);
      });
  }, [clientId, responseType, state, redirectUri, codeChallenge, codeChallengeMethod]);

  const handleAction = useCallback(
    async (action: 'approve' | 'deny') => {
      setSubmitting(true);
      setActionError('');
      try {
        const result = await (
          await plainFetch('/oauth/authorize', {
            method: 'POST',
            body: JSON.stringify({
              client_id: clientId,
              state,
              action,
              ...(redirectUri ? { redirect_uri: redirectUri } : {}),
              ...(codeChallenge ? { code_challenge: codeChallenge } : {}),
              ...(codeChallengeMethod
                ? { code_challenge_method: codeChallengeMethod }
                : {}),
            }),
          })
        ).json();

        if (result.redirect) {
          const notice =
            action === 'approve' && self
              ? connectorTrialNotice({
                  planState: self.planState,
                  allowTrial: self.allowTrial,
                  role: self.role,
                  isTwa: isTwaClient(),
                  trialDays: self.trialDays,
                  appName: appInfo?.app?.name,
                })
              : null;
          if (notice) {
            setLinked({ redirect: result.redirect, notice });
            return;
          }
          window.location.href = result.redirect;
          return;
        }
        // Refused (an unconfirmed email): say why instead of leaving the
        // buttons disabled.
        setActionError(
          (typeof result.message === 'string' && result.message) ||
            'Failed to process authorization'
        );
        setSubmitting(false);
      } catch {
        setError('Failed to process authorization');
        setSubmitting(false);
      }
    },
    [plainFetch, clientId, state, redirectUri, codeChallenge, codeChallengeMethod, self, appInfo]
  );

  // Both buttons finish the OAuth round trip in this tab (the code expires
  // in 10 minutes); the trial opens in a new one.
  const continueToClient = useCallback(() => {
    if (linked) window.location.href = linked.redirect;
  }, [linked]);
  const startTrial = useCallback(() => {
    window.open(connectorTrialHref(), '_blank', 'noopener');
    continueToClient();
  }, [continueToClient]);

  // An email account that has not confirmed its address approves nothing:
  // "Check your inbox" here too (the hard gate, 29 Oct 2026).
  if (needsEmailVerification(self)) {
    return (
      <ContextWrapper user={self}>
        <EmailVerificationGate />
      </ContextWrapper>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-white relative overflow-hidden">
        <div className="absolute inset-0 opacity-30">
          <div className="absolute top-[20%] left-[10%] w-[300px] h-[300px] bg-hp-primary rounded-full blur-[120px]" />
          <div className="absolute bottom-[20%] right-[10%] w-[250px] h-[250px] bg-hp-primary rounded-full blur-[120px]" />
        </div>
        <div className="relative z-10 text-center">
          <div className="flex justify-center mb-[24px]">
            <Logo />
          </div>
          <div className="text-[16px] text-gray-400">
            Please wait...
          </div>
          <div className="mt-[32px] flex justify-center">
            <div className="w-[48px] h-[48px] border-[3px] border-hp-primary border-t-transparent rounded-full animate-spin" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center text-white relative overflow-hidden">
        <div className="absolute inset-0 opacity-30">
          <div className="absolute top-[20%] left-[10%] w-[300px] h-[300px] bg-hp-primary rounded-full blur-[120px]" />
          <div className="absolute bottom-[20%] right-[10%] w-[250px] h-[250px] bg-hp-primary rounded-full blur-[120px]" />
        </div>
        <div className="relative z-10 text-center">
          <div className="flex justify-center mb-[24px]">
            <Logo />
          </div>
          <div className="w-[80px] h-[80px] mx-auto mb-[24px] rounded-full bg-red-500/20 flex items-center justify-center">
            <svg
              className="w-[40px] h-[40px] text-red-500"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div className="text-[28px] font-semibold mb-[12px]">
            Authorization Error
          </div>
          <div className="text-[16px] text-gray-400 max-w-[400px]">
            {error}
          </div>
        </div>
      </div>
    );
  }

  if (!appInfo) {
    return null;
  }

  if (linked) {
    return (
      <div className="flex flex-1 items-center justify-center text-white relative overflow-hidden">
        <div className="absolute inset-0 opacity-30">
          <div className="absolute top-[20%] left-[10%] w-[300px] h-[300px] bg-hp-primary rounded-full blur-[120px]" />
          <div className="absolute bottom-[20%] right-[10%] w-[250px] h-[250px] bg-hp-primary rounded-full blur-[120px]" />
        </div>
        <div className="relative z-10 w-full max-w-[500px] mx-auto px-[20px]">
          <div className="flex justify-center mb-[32px]">
            <Logo />
          </div>
          <div
            data-testid="connector-trial-notice"
            className="bg-[#1A1919] rounded-[16px] p-[32px] flex flex-col gap-[20px]"
          >
            <h2 className="text-[24px] font-semibold text-center">
              {linked.notice.title}
            </h2>
            <div className="text-[15px] text-gray-300 text-center">
              {linked.notice.message}
            </div>
            <div className="flex flex-col gap-[12px]">
              {linked.notice.label && (
                <button
                  type="button"
                  onClick={startTrial}
                  className="bg-hp-primary hover:bg-hp-primary-hover text-hp-on-primary rounded-[8px] py-[12px] px-[16px] text-[15px] font-semibold transition-colors"
                >
                  {linked.notice.label}
                </button>
              )}
              <button
                type="button"
                onClick={continueToClient}
                className="bg-[#2A2929] hover:bg-[#3A3939] text-white rounded-[8px] py-[10px] px-[16px] text-[14px] font-semibold transition-colors"
              >
                {linked.notice.continueLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center text-white relative overflow-hidden">
      <div className="absolute inset-0 opacity-30">
        <div className="absolute top-[20%] left-[10%] w-[300px] h-[300px] bg-hp-primary rounded-full blur-[120px]" />
        <div className="absolute bottom-[20%] right-[10%] w-[250px] h-[250px] bg-hp-primary rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 w-full max-w-[500px] mx-auto px-[20px]">
        <div className="flex justify-center mb-[32px]">
          <Logo />
        </div>

        <div className="bg-[#1A1919] rounded-[16px] p-[32px] flex flex-col gap-[24px]">
          <div className="flex flex-col items-center gap-[16px]">
            {appInfo.app.picture?.path ? (
              <img
                src={appInfo.app.picture.path}
                alt={appInfo.app.name}
                className="w-[64px] h-[64px] rounded-full object-cover"
              />
            ) : (
              <div className="w-[64px] h-[64px] rounded-full bg-[#2A2929] flex items-center justify-center text-[24px] text-gray-400">
                {appInfo.app.name?.[0]?.toUpperCase() || '?'}
              </div>
            )}
            <h2 className="text-[24px] font-semibold text-center">
              {appInfo.app.name}
            </h2>
            {appInfo.app.description && (
              <div className="text-gray-400 text-center text-[14px]">
                {appInfo.app.description}
              </div>
            )}
          </div>

          <div className="border-t border-[#2A2929] pt-[16px]">
            <div className="text-[14px] text-gray-400 mb-[12px]">
              This application is requesting access to your Hookpost account. It
              will be able to:
            </div>
            <ul className="text-[14px] list-disc list-inside space-y-[4px]">
              <li>Access your integrations and channels</li>
              <li>Create and schedule posts on your behalf</li>
              <li>Read your post analytics</li>
            </ul>
          </div>

          {actionError && (
            <div
              role="alert"
              className="rounded-[8px] bg-red-500/10 border border-red-500/30 text-red-200 text-[14px] p-[12px]"
            >
              {actionError}
            </div>
          )}

          <div className="flex gap-[12px]">
            <button
              onClick={() => handleAction('approve')}
              disabled={submitting}
              className="flex-1 bg-hp-primary hover:bg-hp-primary-hover disabled:opacity-50 text-hp-on-primary rounded-[8px] py-[10px] px-[16px] text-[14px] font-semibold transition-colors"
            >
              Authorize
            </button>
            <button
              onClick={() => handleAction('deny')}
              disabled={submitting}
              className="flex-1 bg-[#2A2929] hover:bg-[#3A3939] disabled:opacity-50 text-white rounded-[8px] py-[10px] px-[16px] text-[14px] font-semibold transition-colors"
            >
              Deny
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
