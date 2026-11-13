'use client';

import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { HttpStatusCode } from 'axios';
import { useRouter } from 'next/navigation';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import dayjs from 'dayjs';
import { continueProviderList } from '@hookpost/frontend/components/new-launch/providers/continue-provider/list';
import { IntegrationContext } from '@hookpost/frontend/components/launches/helpers/use.integration';
import { newDayjs } from '@hookpost/frontend/components/layout/set.timezone';
import { useVariables } from '@hookpost/react/helpers/variable.context';
import {
  ADD_CHANNEL_AGAIN_PATH,
  afterConnect,
  marketplaceConnectedMessage,
  providerName,
  providerReturnedError,
  ProviderReturn,
} from '@hookpost/frontend/components/launches/add.channel.helpers';
import { reportClientEvent } from '@hookpost/frontend/components/layout/client.event';
import { clearConnectAttempt } from '@hookpost/frontend/components/launches/connect.attempt';

interface TwoStepState {
  integrationId: string;
  onboarding: boolean;
  /**
   * The pages the login returned, or undefined when the backend could not
   * fetch them (pagesError): the picker then loads them itself and, if that
   * fails too, shows its Try again state instead of "this account has no
   * Pages".
   */
  pages?: any[];
  returnURL?: string;
  /** Started through the api.market API: no dashboard to go back to. */
  marketplace?: boolean;
}

interface SuccessState {
  message: string;
}

export const ContinueIntegration: FC<{
  provider: string;
  searchParams: any;
  logged: boolean;
}> = (props) => {
  const { provider, searchParams, logged } = props;
  // Every way out of this page replaces it in the history. It holds a
  // one-time OAuth code: with push, the back button returned here and sent
  // the spent code again, and the user was told "This connect link was
  // already used" for a channel that had connected fine (21 Oct, three times).
  const { replace } = useRouter();
  const t = useT();
  const fetch = useFetch();
  const { extensionId } = useVariables();
  const [error, setError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [twoStepState, setTwoStepState] = useState<TwoStepState | null>(null);
  const [successState, setSuccessState] = useState<SuccessState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // The provider came back without a code (Cancel or Deny on its screen).
  const [providerReturn, setProviderReturn] = useState<ProviderReturn | null>(
    null
  );

  // Whatever this page shows as an error, the backend log hears about it: a
  // request refused before it reached the controller (the 22 Oct consent
  // 400) logged nothing on the server.
  useEffect(() => {
    if (error) {
      reportClientEvent('connect_page_error', {
        provider,
        reason: errorMessage || 'unknown',
      });
    }
  }, [error]);

  // Helper to handle navigation - redirects if logged or returnURL exists, otherwise shows inline
  const navigateOrShow = useCallback(
    (
      path: string,
      returnURL: string | undefined,
      successMessage: string,
      marketplace = false
    ) => {
      if (marketplace) {
        // An api.market subscriber's connect: the channel is in their API
        // workspace, not in whatever Hookpost account this browser is signed
        // in to, so never the calendar.
        setSuccessState({ message: marketplaceConnectedMessage(providerName(provider)) });
      } else if (returnURL) {
        // If returnURL exists, always redirect to it with the path params
        const params = path.includes('?') ? path.split('?')[1] : '';
        replace(params ? `${returnURL}?${params}` : returnURL);
      } else if (logged) {
        // If logged in without returnURL, go to the calendar
        replace(path);
      } else {
        // If not logged in without returnURL, show success inline
        setSuccessState({ message: successMessage });
      }
    },
    [logged, replace, provider]
  );
  const modifiedParams = useMemo(() => {
    if (provider === 'mewe') {
      return {
        state: searchParams.state || '',
        code: searchParams.loginRequestToken || '',
        refresh: searchParams.refresh || '',
      };
    }
    if (provider === 'x') {
      return {
        state: searchParams.oauth_token || '',
        code: searchParams.oauth_verifier || '',
        refresh: searchParams.refresh || '',
      };
    }

    if (provider === 'tiktok-business') {
      // The TikTok Business API redirects back with `auth_code` instead of `code`
      return {
        state: searchParams.state || '',
        code: searchParams.auth_code || searchParams.code || '',
        refresh: searchParams.refresh || '',
      };
    }

    if (provider === 'vk') {
      return {
        ...searchParams,
        state: searchParams.state || '',
        code: searchParams.code + '&&&&' + searchParams.device_id,
      };
    }

    if (provider === 'mewe') {
      const hash =
        typeof window !== 'undefined' ? window.location.hash.substring(1) : '';
      const hashParams = new URLSearchParams(hash);
      return {
        state: hashParams.get('state') || searchParams.state || '',
        code: hashParams.get('loginRequestToken') || '',
        refresh: searchParams.refresh || '',
      };
    }

    return searchParams;
  }, []);

  useEffect(() => {
    // The provider answered, whatever it said: not an abandoned connect.
    clearConnectAttempt();
    (async () => {
      // Cancel or Deny on the provider's screen: there is no code to send.
      // Posting anyway was a 400 ("code must be a string") shown as "Could not
      // add provider" for 3 s, then a bounce to the calendar; X's ?denied=
      // read as "This connect link was already used or has expired".
      const returned = providerReturnedError(searchParams);
      if (returned) {
        setProviderReturn(returned);
        // Only for the log (connect_failed, user_denied); nothing waits on it.
        Promise.resolve()
          .then(() =>
            fetch(`/integrations/social-connect/${provider}/cancelled`, {
              method: 'POST',
              body: JSON.stringify({
                state: searchParams.state || searchParams.denied || '',
                reason: returned.code,
              }),
            })
          )
          .catch(() => undefined);
        return;
      }

      const timezone = String(dayjs.tz().utcOffset());

      // Try public endpoint first (handles both public and fallback scenarios)
      let data = await fetch(`/integrations/social-connect/${provider}`, {
        method: 'POST',
        body: JSON.stringify({ ...modifiedParams, timezone }),
      });

      // If public endpoint fails with specific errors, try authenticated endpoint
      if (data.status === HttpStatusCode.BadRequest) {
        const errorData = await data.json().catch(() => ({}));
        // "Invalid connection type" means this wasn't started as a public flow
        if (
          errorData.message?.includes('Invalid connection type') ||
          errorData.message?.includes('Invalid or expired state')
        ) {
          data = await fetch(`/integrations/social-connect/${provider}`, {
            method: 'POST',
            body: JSON.stringify({ ...modifiedParams, timezone }),
          });
        }
      }

      if (data.status === HttpStatusCode.PreconditionFailed) {
        const { returnURL } = await data.json().catch(() => ({}));
        navigateOrShow(
          `/launches?precondition=true`,
          returnURL,
          'Precondition failed'
        );
        return;
      }

      if (data.status === HttpStatusCode.NotAcceptable) {
        const { msg, returnURL } = await data.json();
        navigateOrShow(`/launches?msg=${msg}`, returnURL, msg);
        return;
      }

      if (
        data.status !== HttpStatusCode.Ok &&
        data.status !== HttpStatusCode.Created
      ) {
        const errorData = await data.json().catch(() => ({}));
        setErrorMessage(
          errorData.message || errorData.msg || 'Could not add provider'
        );
        setError(true);
        return;
      }

      const {
        inBetweenSteps,
        id,
        onboarding: resOnboarding,
        reconnected,
        alreadyConnected,
        pages,
        pagesError,
        returnURL,
        extensionToken,
        marketplace,
      } = await data.json();
      const onboarding = resOnboarding || searchParams.onboarding === 'true';

      // Store refresh token in extension for background cookie refresh
      if (
        extensionToken &&
        extensionId &&
        typeof chrome !== 'undefined' &&
        chrome?.runtime?.sendMessage
      ) {
        try {
          chrome.runtime.sendMessage(
            extensionId,
            {
              type: 'STORE_REFRESH_TOKEN',
              provider,
              integrationId: id,
              jwt: extensionToken,
            },
            () => {}
          );
        } catch {
          // Silently ignore — extension may not be available
        }
      }

      // If it's a two-step provider, show the selection UI inline
      if (inBetweenSteps && !searchParams.refresh) {
        // The picker can only load the list itself with a session; without
        // one (an invite link, an api.market connect) its request would be a
        // 401 and a bounce to the login page, so say what happened instead.
        if (pagesError && (!logged || marketplace)) {
          setErrorMessage(
            "We couldn't load the list from the platform. Please try connecting again."
          );
          setError(true);
          return;
        }
        setTwoStepState({
          integrationId: id,
          onboarding,
          pages: pagesError ? undefined : pages || [],
          returnURL,
          marketplace: !!marketplace,
        });
        return;
      }

      // "Channel Updated" was shown for every connect, a first one included.
      // A repeat of a connect that already succeeded (Back, a reload) goes
      // back to the calendar with no error.
      const done = afterConnect({
        provider,
        reconnected: !!reconnected,
        onboarding,
        alreadyConnected: !!alreadyConnected,
      });
      navigateOrShow(done.path, returnURL, done.message, !!marketplace);
    })();
  }, []);

  const onSave = useCallback(
    async (data: any) => {
      if (!twoStepState) return;

      setIsSaving(true);

      try {
        // Use public or authenticated endpoint based on the flow. An
        // api.market connect is always the public one: its channel is not in
        // the signed-in user's workspace.
        const endpoint = logged && !twoStepState.marketplace
          ? `/integrations/provider/${twoStepState.integrationId}/connect`
          : `/integrations/public/provider/${twoStepState.integrationId}/connect`;

        const response = await fetch(endpoint, {
          method: 'POST',
          body: JSON.stringify({ ...modifiedParams, ...data }),
        });

        if (
          response.status !== HttpStatusCode.Ok &&
          response.status !== HttpStatusCode.Created
        ) {
          const errorData = await response.json().catch(() => ({}));
          setErrorMessage(
            errorData.message || 'Failed to save channel configuration'
          );
          setError(true);
          return;
        }

        // A page picked after the login is always a new channel.
        const done = afterConnect({
          provider,
          reconnected: false,
          onboarding: twoStepState.onboarding,
        });
        navigateOrShow(
          done.path,
          twoStepState.returnURL,
          done.message,
          !!twoStepState.marketplace
        );
      } finally {
        setIsSaving(false);
      }
    },
    [twoStepState, fetch, modifiedParams, provider, navigateOrShow]
  );

  // Signed in: drop the half-connected channel the login created and go back
  // to the calendar. Without a session (an invite link) there is nothing to
  // remove it with; the nightly sweep clears it after 24 h.
  const onCancel = useCallback(async () => {
    if (twoStepState) {
      await fetch('/integrations', {
        method: 'DELETE',
        body: JSON.stringify({ id: twoStepState.integrationId }),
      }).catch(() => undefined);
    }
    replace('/launches');
  }, [twoStepState, fetch, replace]);

  // Lets the empty picker start Instagram login instead (no Page needed).
  // Only for a signed-in connect into the user's own workspace that returns
  // to the web app: an api.market connect belongs to someone else's
  // workspace, and a returnURL goes back to an app. Leaving drops the
  // half-connected placeholder, as Cancel does.
  const otherConnect = useMemo(
    () =>
      logged &&
      twoStepState &&
      !twoStepState.marketplace &&
      !twoStepState.returnURL
        ? {
            onboarding: twoStepState.onboarding,
            beforeLeave: async () => {
              await fetch('/integrations', {
                method: 'DELETE',
                body: JSON.stringify({ id: twoStepState.integrationId }),
              });
            },
          }
        : undefined,
    [logged, twoStepState, fetch]
  );

  const Provider = useMemo(() => {
    return (
      continueProviderList[provider as keyof typeof continueProviderList] ||
      null
    );
  }, [provider]);

  const providerDisplayName = useMemo(() => providerName(provider), [provider]);

  // The provider came back without a code. Says what happened and stays put:
  // no auto-redirect, so it can be read, and Try again goes to Add Channel.
  if (providerReturn) {
    return (
      <ConnectProblem
        title={
          providerReturn.cancelled
            ? t('nothing_was_connected', 'Nothing was connected')
            : t('could_not_add_provider', 'Could not add provider')
        }
        message={
          providerReturn.cancelled
            ? t(
                'you_cancelled_on_provider',
                `You cancelled on ${providerDisplayName}. Nothing was connected.`
              )
            : `${providerDisplayName}: ${providerReturn.detail}`
        }
        logged={logged}
        onTryAgain={() => replace(ADD_CHANNEL_AGAIN_PATH)}
        onBack={() => replace('/launches')}
      />
    );
  }

  // Success state for non-logged users without returnURL
  if (successState) {
    return (
      <div className="flex flex-1 items-center justify-center text-white relative overflow-hidden">
        {/* Background gradient decoration */}
        <div className="absolute inset-0 opacity-30">
          <div className="absolute top-[20%] left-[10%] w-[300px] h-[300px] bg-hp-primary rounded-full blur-[120px]" />
          <div className="absolute bottom-[20%] right-[10%] w-[250px] h-[250px] bg-hp-primary rounded-full blur-[120px]" />
        </div>

        <div className="relative z-10 text-center">
          <div className="w-[80px] h-[80px] mx-auto mb-[24px] rounded-full bg-green-500/20 flex items-center justify-center">
            <svg
              className="w-[40px] h-[40px] text-green-500"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div className="text-[28px] font-semibold mb-[12px]">
            {t('channel_connected', 'Channel Connected!')}
          </div>
          <div className="text-[16px] text-gray-400 max-w-[400px]">
            {successState.message ||
              t(
                'channel_connected_description',
                `Your ${providerDisplayName} channel has been successfully connected. You can close this window now.`
              )}
          </div>
        </div>
      </div>
    );
  }

  // Show the two-step selection UI
  if (twoStepState && Provider) {
    return (
      <div className="flex flex-1 items-center justify-center text-white relative overflow-hidden">
        {/* Background gradient decoration */}
        <div className="absolute inset-0 opacity-30">
          <div className="absolute top-[20%] left-[10%] w-[300px] h-[300px] bg-hp-primary rounded-full blur-[120px]" />
          <div className="absolute bottom-[20%] right-[10%] w-[250px] h-[250px] bg-hp-primary rounded-full blur-[120px]" />
        </div>

        {/* Content */}
        <div className="relative z-10 w-full max-w-[550px] mx-auto px-[20px]">
          <div className="bg-[#1A1919] rounded-[16px] p-[32px] flex flex-col gap-[24px]">
            <div className="flex flex-col gap-[8px] text-center">
              <h1 className="text-[24px] font-semibold">
                {t('configure_your_channel', 'Configure Your Channel')}
              </h1>
              {/* Nothing to select when the login has no pages; the empty
                  state below says what to do instead. */}
              {twoStepState.pages?.length !== 0 && (
                <p className="text-[14px] text-gray-400">
                  {t(
                    'select_the_page_or_account',
                    `Select the ${providerDisplayName} page or account you want to connect.`
                  )}
                </p>
              )}
            </div>

            <IntegrationContext.Provider
              value={{
                date: newDayjs(),
                value: [],
                allIntegrations: [],
                integration: {
                  editor: 'normal',
                  additionalSettings: '',
                  display: '',
                  time: [{ time: 0 }],
                  id: twoStepState.integrationId,
                  type: '',
                  name: '',
                  picture: '',
                  inBetweenSteps: true,
                  changeNickName: false,
                  changeProfilePicture: false,
                  identifier: provider,
                },
              }}
            >
              <Provider
                onSave={onSave}
                existingId={[]}
                initialData={twoStepState.pages}
                isSaving={isSaving}
                {...(logged ? { onCancel } : {})}
                {...(otherConnect ? { otherConnect } : {})}
              />
            </IntegrationContext.Provider>
          </div>
        </div>
      </div>
    );
  }

  // It used to redirect to the calendar after 3 s, before most people had
  // read why (8 Oct: a YouTube connect missing a permission). Now it stays,
  // with Try again (Add Channel) and Back to calendar.
  if (error) {
    return (
      <ConnectProblem
        title={t('could_not_add_provider', 'Could not add provider')}
        message={
          errorMessage ||
          t('you_are_being_redirected_back', 'An error occurred. Please try again.')
        }
        logged={logged}
        onTryAgain={() => replace(ADD_CHANNEL_AGAIN_PATH)}
        onBack={() => replace('/launches')}
      />
    );
  }

  // Loading state
  return (
    <div className="flex flex-1 items-center justify-center text-white relative overflow-hidden">
      {/* Background gradient decoration */}
      <div className="absolute inset-0 opacity-30">
        <div className="absolute top-[20%] left-[10%] w-[300px] h-[300px] bg-hp-primary rounded-full blur-[120px]" />
        <div className="absolute bottom-[20%] right-[10%] w-[250px] h-[250px] bg-hp-primary rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 text-center">
        <div className="text-[28px] font-semibold mb-[12px]">
          {t('adding_channel', 'Adding Channel')}
        </div>
        <div className="text-[16px] text-gray-400">
          {t('please_wait', 'Please wait while we connect your account...')}
        </div>
        {/* Loading spinner */}
        <div className="mt-[32px] flex justify-center">
          <div className="w-[48px] h-[48px] border-[3px] border-hp-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    </div>
  );
};

/**
 * A connect that did not finish, said plainly, with the way on. It stays on
 * screen: the old error redirected to the calendar after 3 s, before most
 * people had read it. Without a session (an invite link) there is nowhere in
 * the app to go, so it only explains.
 */
export const ConnectProblem: FC<{
  title: string;
  message: string;
  logged: boolean;
  onTryAgain: () => void;
  onBack: () => void;
}> = ({ title, message, logged, onTryAgain, onBack }) => {
  const t = useT();
  return (
    <div className="flex flex-1 items-center justify-center text-white relative overflow-hidden">
      <div className="absolute inset-0 opacity-30">
        <div className="absolute top-[20%] left-[10%] w-[300px] h-[300px] bg-hp-primary rounded-full blur-[120px]" />
        <div className="absolute bottom-[20%] right-[10%] w-[250px] h-[250px] bg-hp-primary rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 text-center px-[20px] max-w-[480px]">
        <div className="text-[28px] font-semibold mb-[12px]">{title}</div>
        <div className="text-[16px] text-gray-400">{message}</div>
        {logged && (
          <div className="mt-[28px] flex flex-col sm:flex-row gap-[12px] justify-center">
            <button
              type="button"
              onClick={onTryAgain}
              className="h-[44px] px-[20px] rounded-[8px] bg-hp-primary text-hp-on-primary font-[600]"
            >
              {t('try_again', 'Try again')}
            </button>
            <button
              type="button"
              onClick={onBack}
              className="h-[44px] px-[20px] rounded-[8px] border border-white/20 text-white"
            >
              {t('back_to_calendar', 'Back to calendar')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
