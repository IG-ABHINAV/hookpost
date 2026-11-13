'use client';

import { FC, useEffect } from 'react';
import { useToaster } from '@hookpost/react/toaster/toaster';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { setCookie } from '@hookpost/frontend/components/layout/layout.context';
import { INVITE_RESULT_COOKIE } from '@hookpost/helpers/auth/team.invite';
import {
  inviteResultMessage,
  readInviteResult,
} from '@hookpost/frontend/components/layout/invite.result';

/**
 * Says once what became of the team invite the user followed (joined which
 * team, already a member, expired or used, no free seat, ...), then removes
 * the cookie so a reload does not say it again. Before 25 Oct 2026 every
 * invite opened in the app landed on /?added=true whatever happened, and the
 * app took that for "Channel added".
 */
export const InviteResultToast: FC = () => {
  const toaster = useToaster();
  const fetch = useFetch();
  const user = useUser();
  useEffect(() => {
    const value = readInviteResult(document.cookie);
    if (!value) {
      return;
    }
    // Removed before anything else, so it is said once even if this effect
    // runs twice (React's development double run).
    setCookie(INVITE_RESULT_COOKIE, '', -10);
    (async () => {
      // The workspace now shown is the one joined (showorg): name it.
      let team = '';
      if ((value === 'joined' || value === 'member') && user?.orgId) {
        try {
          const orgs = (await (await fetch('/user/organizations')).json()) as {
            id: string;
            name?: unknown;
          }[];
          const current = Array.isArray(orgs)
            ? orgs.find((o) => o?.id === user.orgId)
            : undefined;
          team = typeof current?.name === 'string' ? current.name : '';
        } catch {
          // Said without the name.
        }
      }
      const message = inviteResultMessage(value, team);
      if (message) {
        toaster.show(message.text, message.ok ? 'success' : 'warning');
      }
    })();
  }, []);
  return null;
};
