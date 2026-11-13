'use client';

import React, { FC, useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import { usePathname, useRouter } from 'next/navigation';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useFireEvents } from '@hookpost/helpers/utils/use.fire.events';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { LogoTextComponent } from '@hookpost/frontend/components/ui/logo-text.component';
import { OrganizationSelector } from '@hookpost/frontend/components/layout/organization.selector';
import { LogoutComponent } from '@hookpost/frontend/components/layout/logout.component';
import { LoadingComponent } from '@hookpost/frontend/components/layout/loading';
import { AddProviderComponent } from '@hookpost/frontend/components/launches/add.provider.component';
import { useIntegrationList } from '@hookpost/frontend/components/launches/helpers/use.integration.list';
import { withoutConnectNotice } from '@hookpost/frontend/components/launches/add.channel.helpers';
import { FirstBillingComponent } from '@hookpost/frontend/components/billing/first.billing.component';
import { HeldInviteNotice } from '@hookpost/frontend/components/layout/held.invite.notice';
import { TrialRequiredBanner } from '@hookpost/frontend/components/layout/trial.required.banner';
import { knownTrialDays } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import {
  connectedChannelLine,
  countedChannels,
  readConnectFirstSkipped,
  rememberConnectFirstSkipped,
  showConnectFirst,
} from '@hookpost/frontend/components/onboarding/connect.first';

/** The providers the Add Channel screen lists (GET /integrations). */
const useAvailableProviders = () => {
  const fetch = useFetch();
  const load = useCallback(async (path: string) => {
    return (await fetch(path)).json();
  }, []);
  return useSWR('/integrations', load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
  });
};

/**
 * What a workspace on the paywall sees (layout.component.tsx, where
 * showFirstBilling is true). A workspace that has to start its trial gets the
 * connect step first while it has room for a channel and has not skipped it,
 * then the paywall saying what the trial is for now; every other workspace
 * gets the paywall exactly as before.
 */
export const PlanGateScreen: FC = () => {
  const user = useUser();
  const router = useRouter();
  // /billing is where every "Start your trial" link goes (the plan dialog,
  // the emails): the paywall itself, with the way back to connecting.
  const onBilling = (usePathname() || '').startsWith('/billing');
  const fireEvents = useFireEvents();
  const { data: list, isLoading } = useIntegrationList();
  const [skippedHere, setSkipped] = useState(() =>
    readConnectFirstSkipped(user?.orgId)
  );
  const skipped = skippedHere || onBilling;

  const limit = user?.preTrialChannelLimit;
  const preTrial = user?.planState === 'needs_trial' && typeof limit === 'number';
  const channels = countedChannels(list).length;

  // Back from the provider (/launches?added=<provider>&msg=...): the
  // calendar that would show the toast and count channel_added is not on
  // screen, so this counts the connect and drops the notice from the URL.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const added = new URLSearchParams(window.location.search).get('added');
    if (added && preTrial) {
      fireEvents('channel_connected_pre_trial', { provider: added });
    }
    const rest = withoutConnectNotice(window.location.search);
    if (rest !== null) {
      router.replace(
        rest ? `${window.location.pathname}?${rest}` : window.location.pathname,
        { scroll: false }
      );
    }
  }, []);

  const skip = useCallback(() => {
    rememberConnectFirstSkipped(user?.orgId, true);
    setSkipped(true);
  }, [user?.orgId]);

  const connectFirst = useCallback(() => {
    rememberConnectFirstSkipped(user?.orgId, false);
    setSkipped(false);
    if (onBilling) {
      router.push('/launches');
    }
  }, [user?.orgId, onBilling]);

  if (preTrial && isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-newBgColorInner">
        <LoadingComponent />
      </div>
    );
  }

  if (
    showConnectFirst({
      planState: user?.planState,
      preTrialChannelLimit: limit,
      channels,
      skipped,
    })
  ) {
    return <ConnectFirstChannel onSkip={skip} />;
  }

  return (
    <FirstBillingComponent
      connected={
        preTrial
          ? connectedChannelLine(list, knownTrialDays(user?.trialDays))
          : null
      }
      onConnectFirst={
        preTrial && skipped && channels < (limit as number)
          ? connectFirst
          : undefined
      }
    />
  );
};

/**
 * The connect step: the Add Channel tiles, full screen, with the workspace
 * switcher and Log out like the paywall, and a way past it. Connecting goes
 * through the provider and comes back to /launches, where PlanGateScreen
 * shows the paywall once the channel is there.
 */
export const ConnectFirstChannel: FC<{ onSkip: () => void }> = ({ onSkip }) => {
  const t = useT();
  const user = useUser();
  const { data } = useAvailableProviders();
  const days = String(knownTrialDays(user?.trialDays));

  return (
    <div
      data-testid="connect-first-channel"
      className="blurMe flex flex-1 flex-col bg-newBgColorInner pb-[60px] mobile:pb-[100px]"
    >
      <div className="h-[92px] px-[80px] tablet:px-[32px] mobile:!px-[16px] py-[20px] flex border-b border-newColColor">
        <div className="flex-1 flex items-center text-textColor">
          <LogoTextComponent />
        </div>
        <div className="flex items-center gap-[20px] mobile:gap-[12px] text-textItemBlur">
          <OrganizationSelector />
          <div className="hover:text-newTextColor">
            <LogoutComponent isIcon={true} />
          </div>
        </div>
      </div>
      {/* The trial is the next step: its button, not only a sentence. It
          goes to the paywall (/billing skips this step). */}
      <TrialRequiredBanner />
      <div className="flex flex-col gap-[24px] w-full max-w-[960px] mx-auto px-[24px] mobile:!px-[16px] pt-[40px] mobile:pt-[24px]">
        <div className="flex flex-col gap-[8px] text-center">
          <h1 className="text-[32px] mobile:text-[24px] font-[700] leading-[120%]">
            {t('connect_first_title', 'Connect your first channel')}
          </h1>
          <div className="text-[16px] text-textItemBlur">
            {t(
              'connect_first_subtitle',
              'Pick the account you want Hookpost to post to. Nothing is charged for connecting it.'
            )}
          </div>
          <div className="text-[14px] text-textItemBlur">
            {t('connect_first_next', {
              defaultValue:
                'Next, start your {{days}}-day trial to schedule your first post. You can connect more channels once it starts.',
              days,
            })}
          </div>
          {/* A team invite waits for the email confirmation (held.invite.notice.tsx). */}
          <HeldInviteNotice className="text-[14px] text-newTextColor" />
        </div>
        {data ? (
          <AddProviderComponent
            invite={false}
            social={data.social || []}
            article={data.article || []}
          />
        ) : (
          <div className="flex justify-center py-[40px]">
            <LoadingComponent />
          </div>
        )}
        <div className="flex justify-center pt-[8px]">
          <button
            type="button"
            onClick={onSkip}
            className="text-[14px] text-textItemBlur underline hover:text-newTextColor"
          >
            {t('connect_first_skip', 'Skip for now')}
          </button>
        </div>
      </div>
    </div>
  );
};
