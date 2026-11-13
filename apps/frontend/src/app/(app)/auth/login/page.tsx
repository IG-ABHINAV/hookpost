export const dynamic = 'force-dynamic';
import { Login } from '@hookpost/frontend/components/auth/login';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@hookpost/helpers/utils/is.general.server.side';
import { InviteNotice } from '@hookpost/frontend/components/auth/invite.notice';
export const metadata: Metadata = {
  title: 'Hookpost Login | Sign In',
  description: 'Log in to your Hookpost workspace to manage and publish scheduled social content.',
};
export default async function Auth(params: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const invite = (await params?.searchParams)?.invite;
  // A team invite followed by someone who already has an account: signing
  // in redeems it (AuthService.routeAuth).
  return (
    <div className="flex flex-col flex-1 gap-[20px]">
      <InviteNotice invite={invite} mode="login" />
      <Login />
    </div>
  );
}
