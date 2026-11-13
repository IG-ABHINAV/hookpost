'use client';

import { FC, useState } from 'react';
import { useSWRConfig } from 'swr';
import { Button } from '@hookpost/react/form/button';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useConnectLink } from '@hookpost/frontend/components/launches/use.connect.link';
import {
  channelIds,
  rememberConnectStart,
} from '@hookpost/frontend/components/launches/connect.attempt';
import { useSingleFlight } from '@hookpost/frontend/components/launches/single.flight';
import type {
  OtherConnect,
  PickerHelpProps,
} from '@hookpost/frontend/components/new-launch/providers/continue-provider/with-continue-provider';

/**
 * Leaves the picker for another connect (`identifier`): asks for the link,
 * drops the half-connected placeholder, remembers the attempt, and replaces
 * the page, so Back never returns to the spent OAuth callback. A refused link
 * (plan dialog, platform down) stays on the page with `failed` set: the OAuth
 * callback page has no toaster.
 */
export const useLeaveForConnect = () => {
  const connectLink = useConnectLink();
  const { cache } = useSWRConfig();
  const { pending, run } = useSingleFlight();
  const [failed, setFailed] = useState(false);

  const start = (identifier: string, otherConnect?: OtherConnect) =>
    run(identifier, async () => {
      setFailed(false);
      const url = await connectLink(
        `/integrations/social/${identifier}${
          otherConnect?.onboarding ? '?onboarding=true' : ''
        }`
      );
      if (!url) {
        setFailed(true);
        return false;
      }
      try {
        await otherConnect?.beforeLeave?.();
      } catch {
        // The placeholder is swept after 24 h anyway.
      }
      rememberConnectStart(
        identifier,
        Date.now(),
        undefined,
        channelIds(cache.get('/integrations/list')?.data)
      );
      window.location.replace(url);
      return true;
    });

  return { pending, failed, start };
};

/**
 * What the Facebook / Instagram (Facebook Business) picker needs, in three
 * steps, with Try again (the same connect) right there. In the 30 days to
 * 7 Nov all 4 Instagram connects stopped on this picker and the channel was
 * deleted within 12-42 s, although the login had worked. Open when the list
 * is empty, one click away when it is not. Try again only where a connect
 * from here lands back in this workspace (otherConnect).
 */
export const metaPickerHowTo = (
  provider: 'instagram' | 'facebook'
): FC<PickerHelpProps> =>
  function MetaPickerHowTo({ otherConnect, empty }) {
    const t = useT();
    const { pending, failed, start } = useLeaveForConnect();
    const instagram = provider === 'instagram';

    return (
      <details
        open={empty}
        data-testid="meta-picker-howto"
        className="w-full rounded-[8px] border border-input p-[16px] text-start text-[14px] leading-[20px]"
      >
        <summary className="cursor-pointer font-[600]">
          {instagram
            ? t('dont_see_your_instagram', "Don't see your Instagram account?")
            : t('dont_see_your_page', "Don't see your Page?")}
        </summary>
        <div className="mt-[12px] flex flex-col gap-[12px]">
          <p>
            {t(
              'instagram_requirement',
              'Instagram must be a Professional (Business or Creator) account linked to a Facebook Page. Facebook posts go to Pages you manage, not personal profiles.'
            )}
          </p>
          <ol className="list-decimal ps-[20px] flex flex-col gap-[6px]">
            {instagram ? (
              <>
                <li>
                  {t(
                    'ig_howto_step_1',
                    'In the Instagram app, open Settings, then Account type and tools, then Switch to professional account, and choose Business or Creator.'
                  )}
                </li>
                <li>
                  {t(
                    'ig_howto_step_2',
                    'Link it to a Facebook Page you manage: in Instagram, Edit profile, then Page, then connect an existing Page or create one.'
                  )}
                </li>
              </>
            ) : (
              <>
                <li>
                  {t(
                    'fb_howto_step_1',
                    'Make sure you have a Facebook Page and are its admin. Create one at facebook.com/pages/create if not.'
                  )}
                </li>
                <li>
                  {t(
                    'fb_howto_step_2',
                    'For Instagram too: switch it to a Professional account and link it to that Page (Instagram, Edit profile, then Page).'
                  )}
                </li>
              </>
            )}
            <li>
              {t(
                'meta_howto_step_3',
                'Come back and press Try again. When Facebook asks what to share, tick that Page and its Instagram account.'
              )}
            </li>
          </ol>
          {otherConnect && (
            <div>
              <Button
                className="rounded-[8px]"
                loading={!!pending}
                disabled={!!pending}
                onClick={() => start(provider, otherConnect)}
              >
                {t('try_again', 'Try again')}
              </Button>
            </div>
          )}
          {failed && (
            <span role="alert">
              {t(
                'could_not_restart_connect',
                'Could not restart the connect. Please try again.'
              )}
            </span>
          )}
        </div>
      </details>
    );
  };
