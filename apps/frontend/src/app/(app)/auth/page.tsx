import { internalFetch } from '@hookpost/helpers/utils/internal.fetch';
export const dynamic = 'force-dynamic';
import { Register } from '@hookpost/frontend/components/auth/register';
import { Metadata } from 'next';
import { PUBLISHABLE_CHANNEL_COUNT } from '@hookpost/frontend/app/(landing)/channels/channel-count';
import { isGeneralServerSide } from '@hookpost/helpers/utils/is.general.server.side';
import Link from 'next/link';
import { getT } from '@hookpost/react/translation/get.translation.service.backend';
import { LoginWithOidc } from '@hookpost/frontend/components/auth/login.with.oidc';
import { FREE_POSTS, offer } from '@hookpost/frontend/app/(landing)/trial-offer';
import { InviteNotice } from '@hookpost/frontend/components/auth/invite.notice';
// force-dynamic, so unlike the marketing pages this reads the trial cutoff
// from the frontend's own .env when the server starts (trial-offer.ts).
export const metadata: Metadata = {
  title: offer('Hookpost Register | Sign Up Free', `Hookpost Register | Get ${FREE_POSTS}`),
  description: offer(
    `Create your free Hookpost account to schedule and automate social media across ${PUBLISHABLE_CHANNEL_COUNT} channels with AI.`,
    `Create your Hookpost account and get ${FREE_POSTS}, no card needed, to schedule and automate social media across ${PUBLISHABLE_CHANNEL_COUNT} channels with AI.`
  ),
};
export default async function Auth(params: {
  searchParams: Promise<{ provider?: string; invite?: string }>;
}) {
  const t = await getT();
  const invite = (await params?.searchParams)?.invite;
  if (process.env.DISABLE_REGISTRATION === 'true') {
    const canRegister = (
      await (await internalFetch('/auth/can-register')).json()
    ).register;
    if (!canRegister && !(await params?.searchParams)?.provider) {
      return (
        <>
          <LoginWithOidc />
          <div className="text-center">
            {t('registration_is_disabled', 'Registration is disabled')}
            <br />
            <Link className="underline hover:font-bold" href="/auth/login">
              {t('login_instead', 'Login instead')}
            </Link>
          </div>
        </>
      );
    }
  }
  // A team invite (/invite/<token>) lands here: the line above the form
  // names the team; the cookie it left is redeemed by the sign-up, or by
  // the sign-in this page links to.
  return (
    <div className="flex flex-col flex-1 gap-[20px]">
      <InviteNotice invite={invite} mode="signup" />
      <Register />
    </div>
  );
}
