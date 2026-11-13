'use client';

import { FC, useEffect, useState } from 'react';
import { Button } from '@hookpost/react/form/button';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import {
  blockedReason,
  canUseBlockedChannels,
} from '@hookpost/frontend/components/launches/add.channel.helpers';
import { useLeaveForConnect } from '@hookpost/frontend/components/new-launch/providers/continue-provider/meta/meta.picker.howto';
import type { OtherConnect } from '@hookpost/frontend/components/new-launch/providers/continue-provider/with-continue-provider';

export const INSTAGRAM_STANDALONE = 'instagram-standalone';

/** Instagram's help page: switching to a professional (Business or Creator) account. */
export const INSTAGRAM_PROFESSIONAL_HELP_URL =
  'https://help.instagram.com/502981923235522';

/**
 * Whether Instagram login (instagram-standalone) can be started from here: the page must
 * allow another connect (otherConnect: signed in, not api.market, not a
 * connect that returns to an app), the browser must not be the mobile app's
 * WebView (Instagram refuses sign-in there), and the provider must be open to
 * the viewer: NOT_AVAILABLE_YET in add.channel.helpers.ts, the same rule Add
 * Channel follows. While it is closed it ends on Instagram's "Insufficient
 * developer role" page for anyone outside the Meta app's roles.
 */
export const canOfferStandalone = (
  otherConnect: OtherConnect | undefined,
  user: { admin?: boolean; email?: string | null } | null | undefined,
  inAppWebView: boolean
) =>
  !!otherConnect &&
  !inAppWebView &&
  !blockedReason(INSTAGRAM_STANDALONE, canUseBlockedChannels(user));

const isAppWebView = () =>
  typeof window !== 'undefined' && !!(window as any).ReactNativeWebView;

/**
 * Leads the empty Facebook / Instagram (via Facebook Page) picker: the login
 * worked but Meta returned no Page and no linked professional account, which
 * is what a personal Facebook profile and a personal Instagram look like.
 * From 25 Oct to 8 Nov, 4 of the 10 people who tried a channel ended here
 * (backend log `awaitingPagePick:true, pages:0`) and left with nothing
 * connected. It says so in one line and, when Instagram login is open to the
 * viewer, offers it as the way out: no Facebook Page needed.
 */
export const MetaNoPagesHelp: FC<{ otherConnect?: OtherConnect }> = ({
  otherConnect,
}) => {
  const t = useT();
  const user = useUser();
  const { pending, failed, start } = useLeaveForConnect();
  // Read after mount: the picker only renders client-side, but keep SSR and
  // the first client render identical anyway.
  const [inAppWebView, setInAppWebView] = useState(false);
  useEffect(() => setInAppWebView(isAppWebView()), []);
  const offer = canOfferStandalone(otherConnect, user as any, inAppWebView);
  const waitingOnMeta = !!blockedReason(
    INSTAGRAM_STANDALONE,
    canUseBlockedChannels(user as any)
  );

  const startStandalone = () => start(INSTAGRAM_STANDALONE, otherConnect);

  return (
    <div
      className="flex flex-col items-center gap-[12px] text-[14px] leading-[20px]"
      data-testid="meta-no-pages-help"
    >
      <h2 className="text-[20px] leading-[28px] font-[600]">
        {t('no_facebook_page_found', 'No Facebook Page found.')}
      </h2>
      {offer ? (
        <>
          <div className="text-[16px] font-[600]">
            {t(
              'connect_instagram_directly_instead',
              'Connect Instagram directly instead'
            )}
          </div>
          <span>
            {t(
              'instagram_standalone_offer',
              'A professional Instagram account (Business or Creator) can connect directly with Instagram login. No Facebook Page needed.'
            )}
          </span>
          <Button
            className="rounded-[8px]"
            loading={!!pending}
            disabled={!!pending}
            onClick={startStandalone}
          >
            {t('connect_instagram_directly', 'Connect Instagram directly')}
          </Button>
        </>
      ) : (
        <span>
          {waitingOnMeta
            ? t(
                'instagram_standalone_waiting',
                "Connecting Instagram directly with Instagram login (no Facebook Page needed) is waiting on Meta's approval. Until then, Instagram connects through a Facebook Page."
              )
            : t(
                'instagram_standalone_from_add_channel',
                'A professional Instagram account (Business or Creator) can connect directly: in Hookpost, open Add Channel and choose Instagram (no Facebook Page needed).'
              )}
        </span>
      )}
      {failed && (
        <span role="alert">
          {t(
            'could_not_start_instagram_login',
            'Could not start Instagram login. Please try again.'
          )}
        </span>
      )}
      <a
        href={INSTAGRAM_PROFESSIONAL_HELP_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
      >
        {t(
          'how_to_switch_to_professional',
          'How to switch Instagram to a professional account'
        )}
      </a>
    </div>
  );
};
