'use client';

import { useMinWidth } from '@hookpost/frontend/components/layout/use.min.width';
import React, {
  createContext,
  FC,
  useCallback,
  useMemo,
  useState,
  ReactNode,
} from 'react';
import clsx from 'clsx';
import useCookie from 'react-use-cookie';
import useSWR from 'swr';
import { orderBy } from 'lodash';
import { SVGLine } from '@hookpost/frontend/components/launches/launches.component';
import ImageWithFallback from '@hookpost/react/helpers/image.with.fallback';
import SafeImage from '@hookpost/react/helpers/safe.image';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useWaitForClass } from '@hookpost/helpers/utils/use.wait.for.class';
import { MultiMediaComponent } from '@hookpost/frontend/components/media/media.component';
import { Integration } from '@prisma/client';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { knownTrialDays } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { aiLocked } from '@hookpost/frontend/components/layout/plan.limit.prompt';
import { useIntegrationList } from '@hookpost/frontend/components/launches/helpers/use.integration.list';
import { selfPostUrl } from '@hookpost/frontend/components/onboarding/first.post';
import {
  TwaPlanNotice,
  useIsTwa,
} from '@hookpost/frontend/components/layout/twa.component';

export const MediaPortal: FC<{
  media: { path: string; id: string }[];
  value: string;
  setMedia: (event: {
    target: {
      name: string;
      value?: {
        id: string;
        path: string;
        alt?: string;
        thumbnail?: string;
        thumbnailTimestamp?: number;
      }[];
    };
  }) => void;
}> = ({ media, setMedia, value }) => {
  const waitForClass = useWaitForClass('copilotKitMessages');
  const t = useT();
  if (!waitForClass) return null;
  return (
    <div className="pl-[14px] pr-[24px] whitespace-nowrap editor rm-bg">
      <MultiMediaComponent
        allData={[{ content: value }]}
        text={value}
        label={t('attachments', 'Attachments')}
        description=""
        value={media}
        dummy={false}
        name="image"
        onChange={setMedia}
        onOpen={() => {}}
        onClose={() => {}}
      />
    </div>
  );
};

export const AgentList: FC<{ onChange: (arr: any[]) => void }> = ({
  onChange,
}) => {
  const fetch = useFetch();
  const t = useT();
  const [selected, setSelected] = useState([]);

  const load = useCallback(async () => {
    return (await (await fetch('/integrations/list')).json()).integrations;
  }, []);

  const [collapseMenu, setCollapseMenu] = useCookie('collapseMenu', '0');
  const isMd = useMinWidth(768);

  const { data } = useSWR('integrations', load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    fallbackData: [],
  });

  const setIntegration = useCallback(
    (integration: Integration) => () => {
      if (selected.some((p) => p.id === integration.id)) {
        onChange(selected.filter((p) => p.id !== integration.id));
        setSelected(selected.filter((p) => p.id !== integration.id));
      } else {
        onChange([...selected, integration]);
        setSelected([...selected, integration]);
      }
    },
    [selected]
  );

  const sortedIntegrations = useMemo(() => {
    return orderBy(
      data || [],
      ['type', 'disabled', 'identifier'],
      ['desc', 'asc', 'asc']
    );
  }, [data]);

  // Phones: a strip above the chat whose channels scroll sideways (the
  // absolutely positioned column had no height there, so channels could not
  // be picked at all). Folding is a desktop preference.
  const folded = isMd && collapseMenu === '1';
  return (
    <div
      className={clsx(
        'trz bg-newBgColorInner flex flex-col gap-[15px] transition-all relative shrink-0 order-1 md:order-none',
        folded ? 'group sidebar w-full md:w-[100px]' : 'w-full md:w-[260px]'
      )}
    >
      <div className="md:absolute md:top-0 md:start-0 w-full md:h-full p-[12px] md:p-[20px] md:overflow-auto scrollbar scrollbar-thumb-fifth scrollbar-track-newBgColor">
        <div className="flex items-center">
          <h2 className="group-[.sidebar]:hidden flex-1 text-[16px] md:text-[20px] font-[500] mb-[10px] md:mb-[15px]">
            {t('select_channels', 'Select Channels')}
          </h2>
          <div
            onClick={() => setCollapseMenu(collapseMenu === '1' ? '0' : '1')}
            className="hidden md:flex -mt-3 group-[.sidebar]:rotate-[180deg] group-[.sidebar]:mx-auto text-btnText bg-btnSimple rounded-[6px] w-[24px] h-[24px] items-center justify-center cursor-pointer select-none"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="7"
              height="13"
              viewBox="0 0 7 13"
              fill="none"
            >
              <path
                d="M6 11.5L1 6.5L6 1.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
        <div className="flex flex-row md:flex-col gap-[8px] md:gap-[15px] overflow-x-auto md:overflow-visible scrollbar-none">
          {sortedIntegrations.map((integration, index) => (
            <div
              onClick={setIntegration(integration)}
              key={integration.id}
              className={clsx(
                'flex gap-[12px] items-center group/profile justify-center hover:bg-boxHover rounded-e-[8px] hover:opacity-100 cursor-pointer shrink-0 max-w-[200px] pe-[8px] md:max-w-none md:pe-0 min-h-[44px] md:min-h-0',
                !selected.some((p) => p.id === integration.id) && 'opacity-20'
              )}
            >
              <div
                className={clsx(
                  'relative rounded-full flex justify-center items-center gap-[6px]',
                  integration.disabled && 'opacity-50'
                )}
              >
                {(integration.inBetweenSteps || integration.refreshNeeded) && (
                  <div className="absolute start-0 top-0 w-[39px] h-[46px] cursor-pointer">
                    <div className="bg-red-500 w-[15px] h-[15px] rounded-full start-0 -top-[5px] absolute z-[200] text-[10px] flex justify-center items-center">
                      !
                    </div>
                    <div className="bg-primary/60 w-[39px] h-[46px] start-0 top-0 absolute rounded-full z-[199]" />
                  </div>
                )}
                <div className="h-full w-[4px] -ms-[12px] rounded-s-[3px] opacity-0 group-hover/profile:opacity-100 transition-opacity">
                  <SVGLine />
                </div>
                <ImageWithFallback
                  fallbackSrc={`/icons/platforms/${integration.identifier}.png`}
                  src={integration.picture}
                  className="rounded-[8px]"
                  alt={integration.identifier}
                  width={36}
                  height={36}
                />
                <SafeImage
                  src={`/icons/platforms/${integration.identifier}.png`}
                  className="rounded-[8px] absolute z-10 bottom-[5px] -end-[5px] border border-fifth"
                  alt={integration.identifier}
                  width={18.41}
                  height={18.41}
                />
              </div>
              <div
                className={clsx(
                  'flex-1 whitespace-nowrap text-ellipsis overflow-hidden group-[.sidebar]:hidden',
                  integration.disabled && 'opacity-50'
                )}
              >
                {integration.name}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

/**
 * /agents on a plan without AI (Free). The page used to load the chat and the
 * thread list anyway; the list answered 402, the "Upgrade to keep going"
 * dialog opened, and SWR's retries kept re-opening it. A static card instead,
 * and no request at all.
 */
const AgentUpgradeCard: FC = () => {
  const t = useT();
  const user = useUser();
  const isTwa = useIsTwa();
  const { data: integrations } = useIntegrationList();

  return (
    <div className="bg-newBgColorInner flex flex-1 items-center justify-center p-[24px]">
      <div className="flex max-w-[480px] flex-col items-center gap-[16px] rounded-[16px] border border-newColColor p-[32px] text-center">
        <div className="flex h-[48px] w-[48px] items-center justify-center rounded-full bg-boxFocused text-textItemFocused">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </div>
        <div className="text-[20px] font-[600]">
          {t('agent_paid_title', 'AI Agent is part of the paid plans')}
        </div>
        <div className="text-[14px] text-textItemBlur">
          {t(
            'agent_paid_description',
            'You can still write and schedule posts yourself.'
          )}
        </div>
        {/* Google Play app: no route to checkout (see layout/twa.ts). */}
        {isTwa && <TwaPlanNotice />}
        <div className="flex flex-wrap justify-center gap-[12px]">
          {!isTwa && (
            <Link
              href="/billing"
              className="flex h-[44px] items-center rounded-md bg-btnPrimary px-[20px] text-[14px] font-[600] text-hp-on-primary"
            >
              {user?.allowTrial
                ? t('start_trial_days_free_trial', {
                    defaultValue: 'Start {{days}}-day free trial',
                    days: knownTrialDays(user?.trialDays),
                  })
                : t('see_plans', 'See plans')}
            </Link>
          )}
          <Link
            href={selfPostUrl(integrations)}
            className="flex h-[44px] items-center rounded-md border border-newColColor px-[20px] text-[14px] font-[600]"
          >
            {t('create_a_post_by_hand', 'Create a post yourself')}
          </Link>
        </div>
      </div>
    </div>
  );
};

export const PropertiesContext = createContext({ properties: [] });
export const Agent: FC<{ children: ReactNode }> = ({ children }) => {
  const [properties, setProperties] = useState([]);
  const user = useUser();

  if (aiLocked(user?.tier)) {
    return <AgentUpgradeCard />;
  }

  return (
    <PropertiesContext.Provider value={{ properties }}>
      <AgentList onChange={setProperties} />
      {/* Phones: the chat comes after both strips and fills the screen. */}
      <div className="bg-newBgColorInner flex flex-1 min-w-0 order-3 md:order-none min-h-[calc(100dvh-300px)] md:min-h-0">{children}</div>
      <Threads />
    </PropertiesContext.Provider>
  );
};

const Threads: FC = () => {
  const fetch = useFetch();
  const router = useRouter();
  const pathname = usePathname();
  const t = useT();
  const threads = useCallback(async () => {
    return (await fetch('/copilot/list')).json();
  }, []);
  const { id } = useParams<{ id: string }>();

  // No retries: a refused list (402) retried every few seconds, and each
  // retry opened the plan dialog again.
  const { data } = useSWR('threads', threads, {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  });

  // Phones: one row above the chat, "Start a new chat" first and the past
  // chats scrolling sideways after it.
  return (
    <div
      className={clsx(
        'trz bg-newBgColorInner flex flex-col gap-[15px] transition-all relative shrink-0 order-2 md:order-none',
        'w-full md:w-[260px]'
      )}
    >
      <div className="md:absolute md:top-0 md:start-0 w-full md:h-full p-[12px] md:p-[20px] md:overflow-auto scrollbar scrollbar-thumb-fifth scrollbar-track-newBgColor flex flex-row md:flex-col gap-[8px] md:gap-0 overflow-x-auto scrollbar-none md:scrollbar">
        <div className="md:mb-[15px] justify-center flex shrink-0 group-[.sidebar]:pb-[15px]">
          <Link
            href={`/agents`}
            className="text-hp-on-primary whitespace-nowrap flex-1 pt-[12px] pb-[14px] ps-[16px] pe-[20px] group-[.sidebar]:p-0 min-h-[44px] max-h-[44px] rounded-md bg-btnPrimary flex justify-center items-center gap-[5px] outline-none"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="21"
              height="20"
              viewBox="0 0 21 20"
              fill="none"
              className="min-w-[21px] min-h-[20px]"
            >
              <path
                d="M10.5001 4.16699V15.8337M4.66675 10.0003H16.3334"
                stroke="white"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div className="flex-1 text-start text-[16px] group-[.sidebar]:hidden">
              {t('start_a_new_chat', 'Start a new chat')}
            </div>
          </Link>
        </div>
        <div className="flex flex-row md:flex-col gap-[4px] md:gap-[1px]">
          {data?.threads?.map((p: any) => (
            <Link
              className={clsx(
                'overflow-ellipsis overflow-hidden whitespace-nowrap hover:bg-newBgColor px-[10px] py-[6px] rounded-[10px] cursor-pointer shrink-0 max-w-[180px] flex items-center min-h-[44px] md:max-w-none md:block md:min-h-0',
                p.id === id && 'bg-newBgColor'
              )}
              href={`/agents/${p.id}`}
              key={p.id}
            >
              {p.title}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
};
