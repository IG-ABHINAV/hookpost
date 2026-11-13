import { InviteConfirm } from '@hookpost/frontend/components/invite/invite.confirm';

export const dynamic = 'force-dynamic';

/**
 * /invite: what a signed-in visitor sees after opening a team invite link
 * (proxy.invite.ts moved the token into its httpOnly cookie). The address
 * never carries the token.
 */
export default function InvitePage() {
  return <InviteConfirm />;
}
