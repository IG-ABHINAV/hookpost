import './auth.scss';
import { getT } from '@hookpost/react/translation/get.translation.service.backend';

export const dynamic = 'force-dynamic';

// Search Console files /auth and /auth?provider=GITHUB as "Duplicate without
// user-selected canonical": same login form, two URLs, and nothing on the page
// saying which one counts. A login form has nothing to rank for either way, so
// tell crawlers not to index it at all - they may still follow it, which is
// what the OAuth flows need. The query-string variants then stop being
// duplicates of anything.
export const metadata = {
  robots: { index: false, follow: true },
};

import { ReactNode } from 'react';
import { cookies } from 'next/headers';
import {
  INVITE_COOKIE,
  looksLikeInviteToken,
} from '@hookpost/helpers/auth/team.invite';
import { ATTRIBUTION_CAPTURE_SCRIPT } from '@hookpost/helpers/utils/attribution';
import Link from 'next/link';
import { GoogleOneTap } from '@hookpost/frontend/components/auth/google-one-tap';
import { RefCapture } from '@hookpost/frontend/components/affiliates/ref-capture';
import loadDynamic from 'next/dynamic';
import { TestimonialComponent } from '@hookpost/frontend/components/auth/testimonial.component';
import { AuthShowcase } from '@hookpost/frontend/components/auth/auth.showcase';
import { LogoTextComponent } from '@hookpost/frontend/components/ui/logo-text.component';
const ReturnUrlComponent = loadDynamic(() => import('./return.url.component'));
export default async function AuthLayout({
  children,
}: {
  children: ReactNode;
}) {
  const t = await getT();
  // Opened from a team invite (proxy.invite.ts left it in the httpOnly
  // cookie): Google may not sign a returning account in by itself here, so
  // the invite is only ever redeemed by a sign-in the visitor chose. The
  // card still shows; picking an account is that choice.
  const invited = looksLikeInviteToken((await cookies()).get(INVITE_COOKIE)?.value);

  return (
    <div className="bg-hp-bg flex flex-1 p-[12px] gap-[12px] min-h-screen w-screen text-hp-text">
      {/*<style>{`html, body {overflow-x: hidden;}`}</style>*/}
      {/* An ad can link straight here: record its first touch (hp_attr)
          before the form can be submitted. See utils/attribution.ts. */}
      <script dangerouslySetInnerHTML={{ __html: ATTRIBUTION_CAPTURE_SCRIPT }} />
      <ReturnUrlComponent />
      <GoogleOneTap autoSelect={!invited} />
      <RefCapture />
      <div className="flex flex-col py-[40px] px-[20px] flex-1 lg:w-[600px] lg:flex-none rounded-[12px] text-hp-text p-[12px] bg-hp-surface">
        <div className="w-full max-w-[440px] mx-auto justify-center gap-[20px] h-full flex flex-col text-hp-text">
          <Link href="/" aria-label="Hookpost home" className="inline-block w-fit">
            <LogoTextComponent />
          </Link>
          <div className="flex">{children}</div>
        </div>
      </div>
      {/*
        Upstream asserted "Over 20,000+ Entrepreneurs use <product>". This
        deployment has no basis for a user count, so the panel shows the
        product and states what it does instead (AuthShowcase: every fact in
        it comes from the same source as the homepage's). TestimonialComponent
        renders nothing until real, consented quotes are added -- see
        helpers/testomonials.tsx. Hidden below lg, so phones get the form only.
      */}
      <div className="flex-1 hidden lg:flex flex-col items-center justify-center px-[32px] xl:px-[48px] py-[48px]">
        <div className="flex w-full max-w-[620px] 2xl:max-w-[700px] flex-col gap-[40px]">
          <div className="text-[30px] xl:text-[36px] 2xl:text-[40px] font-[500] max-w-[560px] 2xl:max-w-[640px] leading-[1.25] -tracking-[0.8px] text-balance">
            Join Forward-Thinking <span className="text-hp-primary-text font-[600]">Creators & Teams</span> Growing Their Social Presence with Hookpost
          </div>
          <AuthShowcase />
        </div>
        <TestimonialComponent />
      </div>
    </div>
  );
}
