'use client';

import { useModals } from '@hookpost/frontend/components/layout/new-modal';
import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { Input } from '@hookpost/react/form/input';
import { FieldValues, FormProvider, useForm } from 'react-hook-form';
import { Button } from '@hookpost/react/form/button';
import { classValidatorResolver } from '@hookform/resolvers/class-validator';
import { ApiKeyDto } from '@hookpost/nestjs-libraries/dtos/integrations/api.key.dto';
import { TopTitle } from '@hookpost/frontend/components/launches/helpers/top.title.component';
import { useVariables } from '@hookpost/react/helpers/variable.context';
import { useToaster } from '@hookpost/react/toaster/toaster';
import { object, string } from 'yup';
import { yupResolver } from '@hookform/resolvers/yup';
import { web3List } from '@hookpost/frontend/components/launches/web3/web3.list';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import clsx from 'clsx';
import copy from 'copy-to-clipboard';
import { capitalize } from 'lodash';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import {
  blockedReason,
  canUseBlockedChannels,
  extensionCookiesMessage,
  comingSoonTiles,
  needsMissingExtension,
  addChannelLabel,
  orderAddChannelTiles,
  withComingSoon,
} from '@hookpost/frontend/components/launches/add.channel.helpers';
import { CHROME_EXTENSION_URL } from '@hookpost/frontend/components/layout/chrome.extension.url';
import { useConnectLink } from '@hookpost/frontend/components/launches/use.connect.link';
import {
  isTouchOnly,
  useSingleFlight,
} from '@hookpost/frontend/components/launches/single.flight';
import {
  channelIds,
  rememberConnectStart,
} from '@hookpost/frontend/components/launches/connect.attempt';
import { useSWRConfig } from 'swr';
import {
  encodeCredentials,
  handOffConnectCode,
} from '@hookpost/frontend/components/launches/connect.handoff';

// Channels a new account cannot use yet: NOT_AVAILABLE_YET in
// add.channel.helpers.ts. Meta approved Instagram (Facebook Business) and
// Threads on 9 Oct 2026; Instagram (Standalone) is still waiting.
const resolver = classValidatorResolver(ApiKeyDto);

export const useAddProvider = (update?: () => void, invite?: boolean) => {
  const modal = useModals();
  const fetch = useFetch();
  return useCallback(async () => {
    const data = await (await fetch('/integrations')).json();
    modal.openModal({
      title: 'Add Channel',
      withCloseButton: true,
      children: (
        <AddProviderComponent invite={!!invite} update={update} {...data} />
      ),
    });
  }, []);
};
const AddChannelIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 20 20"
    fill="none"
  >
    <path
      d="M1.66675 10.0417C3.35907 10.2299 4.93698 10.9884 6.14101 12.1924C7.34504 13.3964 8.10353 14.9743 8.29175 16.6667M1.66675 13.4167C2.46749 13.58 3.20253 13.9751 3.7804 14.553C4.35827 15.1309 4.75344 15.8659 4.91675 16.6667M1.66675 16.6667H1.67508M11.6667 17.5H14.3334C15.7335 17.5 16.4336 17.5 16.9684 17.2275C17.4388 16.9878 17.8212 16.6054 18.0609 16.135C18.3334 15.6002 18.3334 14.9001 18.3334 13.5V6.5C18.3334 5.09987 18.3334 4.3998 18.0609 3.86502C17.8212 3.39462 17.4388 3.01217 16.9684 2.77248C16.4336 2.5 15.7335 2.5 14.3334 2.5H5.66675C4.26662 2.5 3.56655 2.5 3.03177 2.77248C2.56137 3.01217 2.17892 3.39462 1.93923 3.86502C1.66675 4.3998 1.66675 5.09987 1.66675 6.5V6.66667"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const AddProviderButton: FC<{
  update?: () => void;
  // The one-row channel strip (launches/channel.strip.tsx): just the Add
  // Channel button, icon only. The invite-link button stays in the full panel.
  compact?: boolean;
  // No channel yet: the one thing to do, so it looks like it. A grey
  // "Add Channel" was easy to miss on a phone: on 21 Oct the first trial
  // customer spent 13 minutes in the phone layout without opening it, then
  // switched Chrome to "Desktop site" and connected within a minute.
  primary?: boolean;
}> = (props) => {
  const { update, compact, primary } = props;
  const add = useAddProvider(update);
  const invite = useAddProvider(update, true);
  const t = useT();

  if (compact) {
    return (
      <button
        type="button"
        onClick={add}
        aria-label={t('add_channel', 'Add Channel')}
        title={t('add_channel', 'Add Channel')}
        className="shrink-0 text-btnText bg-btnSimple h-[44px] min-w-[44px] justify-center items-center flex rounded-[8px]"
      >
        <AddChannelIcon />
      </button>
    );
  }

  return (
    <div className="flex group-[.sidebar]:block gap-[8px]">
      <button
        type="button"
        className={clsx(
          'flex-1 group-[.sidebar]:w-[100%] group-[.sidebar]:flex-none h-[44px] pt-[12px] pb-[14px] ps-[16px] pe-[20px] justify-center items-center flex rounded-[8px] gap-[8px]',
          primary
            ? 'bg-btnPrimary text-hp-on-primary font-[600]'
            : 'text-btnText bg-btnSimple'
        )}
        onClick={add}
      >
        <div>
          <AddChannelIcon />
        </div>
        <div className="text-start text-[14px] group-[.sidebar]:hidden">
          {primary
            ? t('connect_your_first_channel', 'Connect your first channel')
            : t('add_channel', 'Add Channel')}
        </div>
      </button>
      <button
        onClick={invite}
        data-tooltip-id="tooltip"
        data-tooltip-content={t(
          'invite_link',
          'Send Invite Link to a customer to add channel'
        )}
        className="group-[.sidebar]:hidden min-h-[44px] min-w-[44px] bg-btnSimple justify-center items-center flex rounded-[8px] cursor-pointer"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 16 16"
          fill="none"
        >
          <g clipPath="url(#clip0_2452_193804)">
            <path
              d="M6.6668 8.66599C6.9531 9.04875 7.31837 9.36545 7.73783 9.59462C8.1573 9.82379 8.62114 9.96007 9.0979 9.99422C9.57466 10.0284 10.0532 9.95957 10.501 9.79251C10.9489 9.62546 11.3555 9.36404 11.6935 9.02599L13.6935 7.02599C14.3007 6.39732 14.6366 5.55531 14.629 4.68132C14.6215 3.80733 14.2709 2.97129 13.6529 2.35326C13.0348 1.73524 12.1988 1.38467 11.3248 1.37708C10.4508 1.36948 9.60881 1.70547 8.98013 2.31266L7.83347 3.45266M9.33347 7.33266C9.04716 6.94991 8.68189 6.6332 8.26243 6.40403C7.84297 6.17486 7.37913 6.03858 6.90237 6.00444C6.4256 5.97029 5.94708 6.03908 5.49924 6.20614C5.0514 6.3732 4.64472 6.63461 4.3068 6.97266L2.3068 8.97266C1.69961 9.60133 1.36363 10.4433 1.37122 11.3173C1.37881 12.1913 1.72938 13.0274 2.3474 13.6454C2.96543 14.2634 3.80147 14.614 4.67546 14.6216C5.54945 14.6292 6.39146 14.2932 7.02013 13.686L8.16013 12.546"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            ></path>
          </g>
          <defs>
            <clipPath id="clip0_2452_193804">
              <rect width="16" height="16" fill="textColor"></rect>
            </clipPath>
          </defs>
        </svg>
      </button>
    </div>
  );
};

export const UrlModal: FC<{
  gotoUrl(url: string): void;
}> = (props) => {
  const { gotoUrl } = props;
  const methods = useForm({
    mode: 'onChange',
  });

  const t = useT();

  const submit = useCallback(async (data: FieldValues) => {
    gotoUrl(data.url);
  }, []);
  return (
    <div className="rounded-[4px] border border-customColor6 bg-sixth px-[16px] pb-[16px] relative">
      <TopTitle title={`Instance URL`} />
      <button
        onClick={close}
        className="outline-none absolute end-[20px] top-[20px] mantine-UnstyledButton-root mantine-ActionIcon-root hover:bg-tableBorder cursor-pointer mantine-Modal-close mantine-1dcetaa"
        type="button"
      >
        <svg
          viewBox="0 0 15 15"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
        >
          <path
            d="M11.7816 4.03157C12.0062 3.80702 12.0062 3.44295 11.7816 3.2184C11.5571 2.99385 11.193 2.99385 10.9685 3.2184L7.50005 6.68682L4.03164 3.2184C3.80708 2.99385 3.44301 2.99385 3.21846 3.2184C2.99391 3.44295 2.99391 3.80702 3.21846 4.03157L6.68688 7.49999L3.21846 10.9684C2.99391 11.193 2.99391 11.557 3.21846 11.7816C3.44301 12.0061 3.80708 12.0061 4.03164 11.7816L7.50005 8.31316L10.9685 11.7816C11.193 12.0061 11.5571 12.0061 11.7816 11.7816C12.0062 11.557 12.0062 11.193 11.7816 10.9684L8.31322 7.49999L11.7816 4.03157Z"
            fill="currentColor"
            fillRule="evenodd"
            clipRule="evenodd"
          ></path>
        </svg>
      </button>
      <FormProvider {...methods}>
        <form
          className="gap-[8px] flex flex-col"
          onSubmit={methods.handleSubmit(submit)}
        >
          <div className="pt-[10px]">
            <Input label="URL" name="url" />
          </div>
          <div>
            <Button type="submit">{t('connect', 'Connect')}</Button>
          </div>
        </form>
      </FormProvider>
    </div>
  );
};
export const CustomVariables: FC<{
  variables: Array<{
    key: string;
    label: string;
    defaultValue?: string;
    validation: string;
    type: 'text' | 'password';
    hint?: string;
  }>;
  close?: () => void;
  identifier: string;
  onboarding?: boolean;
}> = (props) => {
  const { close, identifier, variables, onboarding } = props;
  const connectLink = useConnectLink();
  const fetch = useFetch();
  const toaster = useToaster();
  const modals = useModals();
  const schema = useMemo(() => {
    return object({
      ...variables.reduce((aIcc, item) => {
        const splitter = item.validation.split('/');
        const regex = new RegExp(
          splitter.slice(1, -1).join('/'),
          splitter.pop()
        );
        return {
          ...aIcc,
          [item.key]: string()
            .matches(regex, `${item.label} is invalid`)
            .required(),
        };
      }, {}),
    });
  }, [variables]);
  const methods = useForm({
    mode: 'onChange',
    resolver: yupResolver(schema),
    values: variables.reduce(
      (acc, item) => ({
        ...acc,
        ...(item.defaultValue
          ? {
              [item.key]: item.defaultValue,
            }
          : {}),
      }),
      {}
    ),
  });
  const submit = useCallback(
    async (data: FieldValues) => {
      const url = await connectLink(
        `/integrations/social/${identifier}${
          onboarding ? '?onboarding=true' : ''
        }`
      );
      if (!url) {
        return;
      }
      // The API key or app password goes to the backend in a POST body; the
      // callback URL only carries a one-time id (connect.handoff.ts).
      const handoff = await handOffConnectCode(fetch, {
        provider: identifier,
        state: url,
        code: encodeCredentials(data),
        onboarding,
      });
      if ('error' in handoff) {
        toaster.show(handoff.error, 'warning');
        return;
      }
      modals.closeAll();
      // A full page load, not router.push: the URL scrub runs only when a
      // document loads (layout.tsx), and a client-side navigation would show
      // the URL to the trackers' page-view hooks (Plausible, the pixel) first.
      window.location.href = handoff.path;
    },
    [variables, onboarding, connectLink, fetch, toaster, identifier]
  );

  const t = useT();

  return (
    <div className="rounded-[4px] relative">
      <FormProvider {...methods}>
        <form
          className="gap-[8px] flex flex-col pt-[10px]"
          onSubmit={methods.handleSubmit(submit)}
        >
          {variables.map((variable) => (
            <div key={variable.key}>
              {variable.hint ? (
                <div className="flex flex-col gap-[6px]">
                  <div className="text-[14px] flex items-center gap-[6px]">
                    <span>{variable.label}</span>
                    <span
                      data-tooltip-id="tooltip"
                      data-tooltip-content={variable.hint}
                      className="w-[16px] h-[16px] rounded-full border border-textColor/60 text-textColor/60 flex items-center justify-center text-[11px] leading-none cursor-help select-none"
                    >
                      i
                    </span>
                  </div>
                  <Input
                    label=""
                    name={variable.key}
                    type={variable.type == 'text' ? 'text' : 'password'}
                  />
                </div>
              ) : (
                <Input
                  label={variable.label}
                  name={variable.key}
                  type={variable.type == 'text' ? 'text' : 'password'}
                />
              )}
            </div>
          ))}
          <div>
            <Button type="submit">{t('connect', 'Connect')}</Button>
          </div>
        </form>
      </FormProvider>
    </div>
  );
};
// "Install Extension" only once the extension is in the Chrome Web Store
// (CHROME_EXTENSION_URL). It used to read the URL inside onClick, where Next
// does not inline it, so the button only ever closed the dialog.
export const ExtensionNotFound: FC = () => {
  const modals = useModals();
  const t = useT();
  return (
    <div className="flex flex-col gap-[16px] pt-[8px]">
      <p className="text-[14px] text-textColor/80">
        {t(
          'extension_not_available',
          'The Hookpost browser extension is not installed. You need to install it before connecting this channel.'
        )}
      </p>
      <div className="flex gap-[10px]">
        {CHROME_EXTENSION_URL && (
          <Button
            type="button"
            className="flex-1"
            onClick={() => {
              window.open(CHROME_EXTENSION_URL, '_blank', 'noopener,noreferrer');
              modals.closeCurrent();
            }}
          >
            {t('install_extension', 'Install Extension')}
          </Button>
        )}
        <Button
          type="button"
          className="flex-1 !bg-transparent border border-tableBorder text-textColor"
          onClick={() => modals.closeCurrent()}
        >
          {t('cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  );
};

// What the extension reads and sends, shown before it reads anything (Chrome
// Web Store "prominent disclosure"). Must match apps/extension and /privacy.
const EXTENSION_DATA_DISCLOSURE: Record<string, string> = {
  skool:
    'To connect, the Hookpost extension reads two Skool sign-in cookies (client_id and auth_token) from this browser and sends them to Hookpost, which stores them encrypted and uses them only to publish the posts you schedule to Skool. While the channel stays connected, the extension sends their current values to Hookpost once a day. It reads no other cookies, no browsing history and no page content.',
};

const ChromeExtensionWarning: FC<{
  identifier: string;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ identifier, onConfirm, onCancel }) => {
  const modals = useModals();
  const t = useT();
  return (
    <div className="flex flex-col gap-[16px] pt-[8px]">
      <p className="text-[14px] text-textColor/80">
        {t(
          'chrome_extension_warning_intro',
          'This channel connects via the browser extension. Please be aware of the following:'
        )}
      </p>
      <ul className="flex flex-col gap-[8px] list-disc ps-[20px] text-[14px] text-textColor/80">
        <li>
          {t(
            'chrome_extension_warning_tos',
            'Using a browser extension to interact with a platform may violate its terms of service and could result in your account being suspended or banned.'
          )}
        </li>
        <li>
          {t(
            'chrome_extension_warning_unstable',
            'This method is not as reliable as native integrations and may experience random disconnections.'
          )}
        </li>
        <li>
          {t(
            'chrome_extension_warning_reconnect',
            'You may need to reconnect periodically if the session expires.'
          )}
        </li>
        <li>
          {t(
            `chrome_extension_data_${identifier}`,
            EXTENSION_DATA_DISCLOSURE[identifier] ??
              'To connect, the Hookpost extension reads this platform\'s sign-in cookies from this browser and sends them to Hookpost, which stores them encrypted.'
          )}{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {t('privacy_policy', 'Privacy Policy')}
          </a>
        </li>
        <li>
          Hookpost does not take responsibility for any issues arising or account
          termination due to the use of this method.
        </li>
      </ul>
      <div className="flex gap-[10px] mt-[8px]">
        <Button
          type="button"
          className="flex-1"
          onClick={() => {
            modals.closeCurrent();
            onConfirm();
          }}
        >
          {t('i_understand_continue', 'I understand, continue')}
        </Button>
        <Button
          type="button"
          className="flex-1 !bg-transparent border border-tableBorder text-textColor"
          onClick={() => {
            modals.closeCurrent();
            onCancel();
          }}
        >
          {t('cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  );
};

export const AddProviderComponent: FC<{
  social: Array<{
    identifier: string;
    name: string;
    toolTip?: string;
    isExternal: boolean;
    isWeb3: boolean;
    isChromeExtension?: boolean;
    extensionCookies?: Array<{
      name: string;
      domain: string;
    }>;
    customFields?: Array<{
      key: string;
      label: string;
      validation: string;
      type: 'text' | 'password';
      hint?: string;
    }>;
  }>;
  article: Array<{
    identifier: string;
    name: string;
  }>;
  invite: boolean;
  update?: () => void;
  onboarding?: boolean;
  isMobile?: boolean;
}> = (props) => {
  const { update, social, article, onboarding, isMobile } = props;
  const { isGeneral, extensionId } = useVariables();
  const toaster = useToaster();
  const user = useUser();
  // Platform admins, plus our own @hookstep.in accounts: Meta's App Review
  // team logs in as meta-reviewer@hookstep.in and must be able to connect
  // Instagram and Threads to review them.
  const canUseBlocked = canUseBlockedChannels(user as any);
  const connectLink = useConnectLink();
  const fetch = useFetch();
  const modal = useModals();
  // The channel list the calendar already loaded (useIntegrationList's key),
  // read without fetching: the abandoned-connect card compares against it.
  const { cache } = useSWRConfig();
  const getSocialLink = useCallback(
    (
        invite: boolean,
        identifier: string,
        isExternal: boolean,
        isWeb3: boolean,
        isChromeExtension?: boolean,
        customFields?: Array<{
          key: string;
          label: string;
          validation: string;
          defaultValue?: string;
          type: 'text' | 'password';
          hint?: string;
        }>
      ) =>
      async () => {
        const onboardingParam = onboarding ? 'onboarding=true' : '';
        const openWeb3 = async () => {
          const { component: Web3Providers } = web3List.find(
            (item) => item.identifier === identifier
          )!;
          const url = await connectLink(
            `/integrations/social/${identifier}${
              onboarding ? '?onboarding=true' : ''
            }`
          );
          if (!url) {
            return;
          }
          modal.openModal({
            title: `Add ${capitalize(identifier)}`,
            withCloseButton: true,
            ...(isMobile ? { removeLayout: true, fullScreen: true } : {}),
            classNames: {
              // max-w constraint so the dialog cannot run past a narrow
              // viewport. isMobile is only passed by mobile.integration.tsx -
              // the calendar path leaves it undefined, so on a phone this
              // rendered the desktop dialog and its right edge (including the
              // Connect button) sat off-screen. The CSS holds regardless of
              // whether the flag is right.
              modal: 'bg-transparent text-textColor max-w-[calc(100vw-24px)]',
            },
            children: (
              <div
                {...(isMobile
                  ? { className: 'h-full bg-black p-[20px]' }
                  : { className: 'w-full max-w-full' })}
              >
                <Web3Providers
                  onComplete={async (code, newState) => {
                    // Moltbook's code is the agent's permanent API key: it
                    // goes in a POST body, the URL gets a one-time id.
                    const handoff = await handOffConnectCode(fetch, {
                      provider: identifier,
                      state: newState,
                      code,
                      onboarding,
                    });
                    if ('error' in handoff) {
                      // The provider's dialog may already be spinning
                      // (Farcaster) or done polling (Telegram): close it, so
                      // Add Channel can be started again.
                      modal.closeAll();
                      toaster.show(handoff.error, 'warning');
                      return;
                    }
                    window.location.href = handoff.path;
                  }}
                  nonce={url}
                />
              </div>
            ),
          });
          return;
        };
        const gotoIntegration = async (externalUrl?: string) => {
          // Mobile WebView: reuse the existing `externalUrl` param to
          // carry the `hookpost://` deep link so the backend redirects
          // back to the iOS/Android app after OAuth completes, instead
          // of the default web redirect.
          const params = [
            `externalUrl=${encodeURIComponent(externalUrl)}`,
            onboardingParam,
            isMobile
              ? `redirectUrl=${encodeURIComponent('hookpost://integrations')}`
              : '',
          ]
            .filter(Boolean)
            .join('&');
          const url = await connectLink(
            `/integrations/social/${identifier}${params ? `?${params}` : ''}`
          );
          if (!url) {
            return;
          }

          if (invite) {
            toaster.show(
              'Invite link copied to clipboard, link will be available for 1 hour',
              'success'
            );
            modal.closeAll();
            copy(url);
            return;
          }

          if (isMobile) {
            // In the mobile WebView the OAuth provider (Google, Facebook,
            // etc.) typically refuses in-WebView sign-in. Post the URL
            // out to React Native so it can open the system browser;
            // `window.open`/`location.href` aren't reliable here because
            // RN WebView doesn't always route them through the native
            // navigation intercept. The backend redirects back to the
            // app via `hookpost://` once OAuth completes.
            const rn = (window as any).ReactNativeWebView;
            if (rn && typeof rn.postMessage === 'function') {
              rn.postMessage(JSON.stringify({ type: 'open-external', url }));
              return;
            }
            window.open(url, '_blank');
            return;
          }

          // If the calendar shows again without the provider having sent the
          // person back, it offers help (abandoned.connect.card.tsx), unless
          // a new channel of this provider appeared meanwhile.
          rememberConnectStart(
            identifier,
            Date.now(),
            undefined,
            channelIds(cache.get('/integrations/list')?.data)
          );
          window.location.href = url;
          // Leaving for the provider: the tile keeps its spinner.
          return true;
        };
        if (isWeb3) {
          openWeb3();
          return;
        }
        if (isChromeExtension) {
          const confirmed = await new Promise<boolean>((resolve) => {
            modal.openModal({
              title: t('chrome_extension_notice', 'Browser Extension Notice'),
              withCloseButton: true,
              onClose: () => resolve(false),
              children: (
                <ChromeExtensionWarning
                  identifier={identifier}
                  onConfirm={() => {
                    resolve(true);
                  }}
                  onCancel={() => {
                    resolve(false);
                  }}
                />
              ),
            });
          });
          if (!confirmed) {
            return;
          }
          if (!extensionId || !chrome?.runtime?.sendMessage) {
            modal.openModal({
              title: t('extension_not_available_title', 'Extension Not Found'),
              withCloseButton: true,
              children: <ExtensionNotFound />,
            });
            return;
          }
          try {
            await new Promise<void>((resolve, reject) => {
              chrome.runtime.sendMessage(
                extensionId,
                { type: 'PING' },
                (response: any) => {
                  if (chrome.runtime.lastError || !response?.status) {
                    reject(new Error('Extension not reachable'));
                  } else {
                    resolve();
                  }
                }
              );
            });
          } catch {
            toaster.show(
              t(
                'extension_not_installed',
                'Hookpost browser extension is not installed or not reachable.'
              ),
              'warning'
            );
            return;
          }
          try {
            const cookieResponse = await new Promise<any>((resolve, reject) => {
              chrome.runtime.sendMessage(
                extensionId,
                { type: 'GET_COOKIES', provider: identifier },
                (response: any) => {
                  if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                  } else {
                    resolve(response);
                  }
                }
              );
            });
            if (!cookieResponse.success) {
              toaster.show(extensionCookiesMessage(cookieResponse, identifier), 'warning');
              return;
            }
            const url = await connectLink(
              `/integrations/social/${identifier}${
                onboarding ? '?onboarding=true' : ''
              }`
            );
            if (!url) {
              return;
            }
            // The session cookies go to the backend in a POST body, never in
            // a URL: the callback page loads the Meta pixel, GTM, Sentry,
            // Plausible and Dub (connect.handoff.ts).
            const handoff = await handOffConnectCode(fetch, {
              provider: identifier,
              state: url,
              code: encodeCredentials(cookieResponse.cookies),
              onboarding,
            });
            if ('error' in handoff) {
              toaster.show(handoff.error, 'warning');
              return;
            }
            modal.closeAll();
            window.location.href = handoff.path;
          } catch {
            toaster.show(
              t(
                'extension_communication_error',
                'Failed to communicate with the browser extension.'
              ),
              'warning'
            );
          }
          return;
        }
        if (isExternal) {
          modal.openModal({
            title: 'URL',
            withCloseButton: true,
            ...(isMobile ? { removeLayout: true, fullScreen: true } : {}),
            classNames: {
              modal: 'bg-transparent text-textColor',
            },
            children: <UrlModal gotoUrl={gotoIntegration} />,
          });
          return;
        }
        if (customFields) {
          modal.openModal({
            title: t('add_provider_title', 'Add Provider'),
            withCloseButton: true,
            ...(isMobile ? { removeLayout: true, fullScreen: true } : {}),
            classNames: {
              modal: 'bg-transparent text-textColor',
            },
            children: (
              <div
                {...(isMobile ? { className: 'h-full bg-black p-[20px]' } : {})}
              >
                <CustomVariables
                  identifier={identifier}
                  variables={customFields}
                  onboarding={onboarding}
                />
              </div>
            ),
          });
          return;
        }
        return gotoIntegration();
      },
    [onboarding, connectLink, fetch]
  );

  const t = useT();
  // One connect at a time, with a spinner on the tile that was tapped.
  const { pending, run } = useSingleFlight();
  // Phones and tablets never show a hover tooltip, so the one requirement
  // that matters ("must be a business account linked to a Facebook Page")
  // is written on the tile there.
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(isTouchOnly()), []);
  const showHint = !!isMobile || touch;

  return (
    <div className="w-full flex flex-col gap-[20px] rounded-[4px] relative]">
      <div className="flex flex-col">
        <div
          className={clsx(
            isMobile && 'gap-[20px] flex flex-col',
            !isMobile &&
              'grid gap-[10px] justify-items-center justify-center',
            // Was a hard grid-cols-5 at every width. On a narrow viewport that
            // gives each cell about 70px, and names like "Instagram (Facebook
            // Business)" overflow into the next column.
            isMobile
              ? {}
              : onboarding
              ? 'grid-cols-3 sm:grid-cols-6 lg:grid-cols-9'
              : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'
          )}
        >
          {withComingSoon(
            orderAddChannelTiles(
              social
              .filter((item) => !needsMissingExtension(item, extensionId))
              .filter((item) => {
                if (!props.invite) {
                  return true;
                }

                return (
                  !item.isExternal &&
                  !item.isWeb3 &&
                  !item.isChromeExtension &&
                  !item.customFields
                );
              }),
              // Channels that work today first, the unavailable ones last,
              // Instagram without a Page before the Facebook-login one.
              canUseBlocked
            ),
            // A channel that is not open yet, next to the one it is mistaken
            // for, in the same "Soon" style as the unavailable tiles.
            comingSoonTiles(social, props.invite)
          ).map((tile) => {
              if (tile.kind === 'soon') {
                const soon = tile.item;
                return (
                  <div
                    key={soon.identifier}
                    onClick={() => toaster.show(soon.reason, 'warning')}
                    className={clsx(
                      isMobile
                        ? 'flex-row h-[72px] p-[16px]'
                        : 'flex-col p-[10px] h-[100px] justify-center',
                      'w-full text-[14px] rounded-[8px] bg-newTableHeader text-textColor relative items-center flex gap-[10px] cursor-pointer opacity-50'
                    )}
                  >
                    <span className="absolute top-[6px] start-[6px] rounded-[4px] bg-white/10 px-[5px] py-[1px] text-[10px] font-[600] text-white/80">
                      {t('not_available_yet', 'Soon')}
                    </span>
                    <div>
                      <img
                        alt=""
                        className="w-[32px] h-[32px] rounded-full"
                        src={`/icons/platforms/${soon.identifier}.png`}
                      />
                    </div>
                    <div
                      className={clsx(
                        isMobile ? '' : 'whitespace-pre-wrap',
                        'text-center min-w-0 break-words leading-tight'
                      )}
                    >
                      {soon.name}
                    </div>
                  </div>
                );
              }
              const item = tile.item;
              const blocked = blockedReason(item.identifier, canUseBlocked);
              const busy = pending === item.identifier;
              const hint = showHint && !blocked ? item.toolTip : undefined;
              return (
              <div
                key={item.identifier}
                role="button"
                aria-busy={busy}
                onClick={
                  blocked
                    ? () => toaster.show(blocked, 'warning')
                    : () =>
                        run(
                          item.identifier,
                          getSocialLink(
                            props.invite,
                            item.identifier,
                            item.isExternal,
                            item.isWeb3,
                            item.isChromeExtension,
                            item.customFields
                          )
                        )
                }
                {...(!!item.toolTip && !hint
                  ? {
                      'data-tooltip-id': 'tooltip',
                      'data-tooltip-content': item.toolTip,
                    }
                  : {})}
                className={clsx(
                  isMobile
                    ? clsx('flex-row p-[16px]', hint ? 'min-h-[72px]' : 'h-[72px]')
                    : clsx(
                        'flex-col p-[10px] justify-center',
                        hint ? 'min-h-[100px]' : 'h-[100px]'
                      ),
                  'w-full text-[14px] rounded-[8px] bg-newTableHeader text-textColor relative items-center flex gap-[10px] cursor-pointer',
                  blocked && 'opacity-50',
                  pending && !busy && 'opacity-60 pointer-events-none'
                )}
              >
                {blocked && (
                  <span className="absolute top-[6px] start-[6px] rounded-[4px] bg-white/10 px-[5px] py-[1px] text-[10px] font-[600] text-white/80">
                    {t('not_available_yet', 'Soon')}
                  </span>
                )}
                {busy && (
                  <span
                    aria-label={t('connecting', 'Connecting')}
                    className="absolute top-[8px] end-[8px] w-[16px] h-[16px] rounded-full border-2 border-white/30 border-t-white animate-spin"
                  />
                )}
                <div>
                  {item.identifier === 'youtube' ? (
                    <img src={`/icons/platforms/youtube.svg`} />
                  ) : (
                    <img
                      className={clsx(
                        'w-[32px] h-[32px]',
                        item.identifier !== 'google_my_business' &&
                          'rounded-full'
                      )}
                      src={`/icons/platforms/${item.identifier}.png`}
                    />
                  )}
                </div>
                <div
                  className={clsx(
                    isMobile ? '' : 'whitespace-pre-wrap',
                    // min-w-0 is the fix: a flex item defaults to
                    // min-width:auto and will not shrink past its content, so
                    // the label spilled into the neighbouring cell rather than
                    // wrapping. break-words handles the long single tokens.
                    'text-center min-w-0 break-words leading-tight'
                  )}
                >
                  {addChannelLabel(item)}
                  {!!hint && (
                    <div className="mt-[4px] text-[11px] opacity-70 font-[400] whitespace-normal">
                      {hint}
                    </div>
                  )}
                  {!!item.toolTip && !isMobile && !hint && !busy && (
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 26 26"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      className="absolute top-[10px] end-[10px]"
                    >
                      <path
                        d="M13 0C10.4288 0 7.91543 0.762437 5.77759 2.1909C3.63975 3.61935 1.97351 5.64968 0.989572 8.02512C0.0056327 10.4006 -0.251811 13.0144 0.249797 15.5362C0.751405 18.0579 1.98953 20.3743 3.80762 22.1924C5.6257 24.0105 7.94208 25.2486 10.4638 25.7502C12.9856 26.2518 15.5995 25.9944 17.9749 25.0104C20.3503 24.0265 22.3807 22.3603 23.8091 20.2224C25.2376 18.0846 26 15.5712 26 13C25.9964 9.5533 24.6256 6.24882 22.1884 3.81163C19.7512 1.37445 16.4467 0.00363977 13 0ZM13 21C12.7033 21 12.4133 20.912 12.1667 20.7472C11.92 20.5824 11.7277 20.3481 11.6142 20.074C11.5007 19.7999 11.471 19.4983 11.5288 19.2074C11.5867 18.9164 11.7296 18.6491 11.9393 18.4393C12.1491 18.2296 12.4164 18.0867 12.7074 18.0288C12.9983 17.9709 13.2999 18.0007 13.574 18.1142C13.8481 18.2277 14.0824 18.42 14.2472 18.6666C14.412 18.9133 14.5 19.2033 14.5 19.5C14.5 19.8978 14.342 20.2794 14.0607 20.5607C13.7794 20.842 13.3978 21 13 21ZM14 14.91V15C14 15.2652 13.8946 15.5196 13.7071 15.7071C13.5196 15.8946 13.2652 16 13 16C12.7348 16 12.4804 15.8946 12.2929 15.7071C12.1054 15.5196 12 15.2652 12 15V14C12 13.7348 12.1054 13.4804 12.2929 13.2929C12.4804 13.1054 12.7348 13 13 13C14.6538 13 16 11.875 16 10.5C16 9.125 14.6538 8 13 8C11.3463 8 10 9.125 10 10.5V11C10 11.2652 9.89465 11.5196 9.70711 11.7071C9.51958 11.8946 9.26522 12 9.00001 12C8.73479 12 8.48044 11.8946 8.2929 11.7071C8.10536 11.5196 8.00001 11.2652 8.00001 11V10.5C8.00001 8.01875 10.2425 6 13 6C15.7575 6 18 8.01875 18 10.5C18 12.6725 16.28 14.4913 14 14.91Z"
                        fill="currentColor"
                      />
                    </svg>
                  )}
                </div>
              </div>
              );
            })}
        </div>
      </div>
    </div>
  );
};
