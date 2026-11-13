'use client';

import { FC } from 'react';
import useSWR from 'swr';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { needsEmailVerification } from '@hookpost/frontend/components/layout/email.verification';

/**
 * "You've been invited to <team>. Confirm your email to join." A password
 * sign-up that came through a team invite is held out of that workspace
 * until it confirms its email (AuthService.holdInvite), and lands on its own
 * connect step or paywall meanwhile, with no other sign that a team is
 * waiting. Plain text (React escapes it), never a link: the name is whatever
 * the inviter typed.
 */
export const HeldInviteNotice: FC<{ className?: string }> = ({ className }) => {
  const user = useUser();
  const fetch = useFetch();
  const pending = needsEmailVerification(user);
  const { data } = useSWR<{ invitedTo?: string | null }>(
    pending ? '/verify-email' : null,
    async (path: string) => (await fetch(path)).json(),
    { revalidateOnFocus: true }
  );
  const team = typeof data?.invitedTo === 'string' ? data.invitedTo.trim() : '';
  if (!pending || !team) {
    return null;
  }
  return (
    <div data-testid="held-invite-notice" role="status" className={className}>
      {"You've been invited to "}
      <span className="font-[600] break-all">{team}</span>
      {'. Confirm your email to join.'}
    </div>
  );
};
