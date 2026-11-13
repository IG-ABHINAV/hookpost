'use client';

import React, { ReactNode, useCallback, useEffect, useState } from 'react';
import { Logo } from '@hookpost/frontend/components/new-layout/logo';
import { Plus_Jakarta_Sans } from 'next/font/google';
const ModeComponent = dynamic(
  () => import('@hookpost/frontend/components/layout/mode.component'),
  {
    ssr: false,
  }
);

import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useVariables } from '@hookpost/react/helpers/variable.context';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { CheckPayment } from '@hookpost/frontend/components/layout/check.payment';
import { ToolTip } from '@hookpost/frontend/components/layout/top.tip';
import { ShowMediaBoxModal } from '@hookpost/frontend/components/media/media.component';
import { ShowLinkedinCompany } from '@hookpost/frontend/components/launches/helpers/linkedin.component';
import { MediaSettingsLayout } from '@hookpost/frontend/components/launches/helpers/media.settings.component';
import { Toaster } from '@hookpost/react/toaster/toaster';
import { ShowPostSelector } from '@hookpost/frontend/components/post-url-selector/post.url.selector';
import { NewSubscription } from '@hookpost/frontend/components/layout/new.subscription';
import { Support } from '@hookpost/frontend/components/layout/support';
import { ContinueProvider } from '@hookpost/frontend/components/layout/continue.provider';
import { ContextWrapper } from '@hookpost/frontend/components/layout/user.context';
import { EmailVerificationGate } from '@hookpost/frontend/components/layout/email.verification.gate';
import { needsEmailVerification } from '@hookpost/frontend/components/layout/email.verification';
import { CopilotKit } from '@copilotkit/react-core';
import { MantineWrapper } from '@hookpost/react/helpers/mantine.wrapper';
import { Impersonate } from '@hookpost/frontend/components/layout/impersonate';
import { AnnouncementBanner } from '@hookpost/frontend/components/layout/announcement.banner';
import { FreePlanSunsetBanner } from '@hookpost/frontend/components/layout/free.plan.sunset.banner';
import { RenewalReminderBanner } from '@hookpost/frontend/components/billing/renewal.reminder.banner';
import { PaymentFailedBanner } from '@hookpost/frontend/components/layout/payment.failed.banner';
import {
  FreePostsCounter,
  TrialRequiredBanner,
} from '@hookpost/frontend/components/layout/trial.required.banner';
import { skipsPlanGates } from '@hookpost/frontend/components/layout/trial.cta';
import DeleteAccountComponent from '@hookpost/frontend/components/settings/delete-account.component';
import { Title } from '@hookpost/frontend/components/layout/title';
import { TopMenu } from '@hookpost/frontend/components/layout/top.menu';
import { LanguageComponent } from '@hookpost/frontend/components/layout/language.component';
import { ChromeExtensionComponent } from '@hookpost/frontend/components/layout/chrome.extension.component';
import NotificationComponent from '@hookpost/frontend/components/notifications/notification.component';
import { OrganizationSelector } from '@hookpost/frontend/components/layout/organization.selector';
import { StreakComponent } from '@hookpost/frontend/components/layout/streak.component';
import { PreConditionComponent } from '@hookpost/frontend/components/layout/pre-condition.component';
import { AttachToFeedbackIcon } from '@hookpost/frontend/components/new-layout/sentry.feedback.component';
import { PlanGateScreen } from '@hookpost/frontend/components/onboarding/connect.first.component';
import { TrialTracker } from '@hookpost/frontend/components/layout/gtm.component';
import { setSentryUser } from '@hookpost/react/sentry/initialize.sentry.client';
import {
  showFirstBilling,
  showTwaPlanGate,
} from '@hookpost/frontend/components/layout/twa';
import {
  TwaPlanNotice,
  useIsTwa,
} from '@hookpost/frontend/components/layout/twa.component';
import { LogoutComponent } from '@hookpost/frontend/components/layout/logout.component';
import { RatePrompt } from '@hookpost/frontend/components/layout/rate-prompt.component';
import { InviteResultToast } from '@hookpost/frontend/components/layout/invite.result.toast';
import { MobileNav } from '@hookpost/frontend/components/new-layout/mobile.nav';

const jakartaSans = Plus_Jakarta_Sans({
  weight: ['600', '500', '700'],
  style: ['normal', 'italic'],
  subsets: ['latin'],
});

export const LayoutComponent = ({ children }: { children: ReactNode }) => {
  const fetch = useFetch();

  const { backendUrl, billingEnabled, isGeneral } = useVariables();
  // Google Play app: never the Razorpay plans screen (see layout/twa.ts).
  const isTwa = useIsTwa();

  // Feedback icon component attaches Sentry feedback to a top-bar icon when DSN is present
  const searchParams = useSearchParams();
  const load = useCallback(async (path: string) => {
    return await (await fetch(path)).json();
  }, []);
  const { data: user, mutate } = useSWR('/user/self', load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    refreshWhenOffline: false,
    refreshWhenHidden: false,
  });

  useEffect(() => {
    setSentryUser(
      user ? { id: user.id, email: user.email, orgId: user.orgId } : null
    );
  }, [user]);

  const [continueFree, setContinueFree] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const isFree =
        localStorage.getItem('hookpost_continue_free') === 'true' ||
        document.cookie.includes('hookpost_continue_free=true');
      if (isFree) {
        setContinueFree(true);
      }
    }
  }, []);

  if (!user) return null;

  // An email+password account that has not confirmed its address gets
  // "Check your inbox" and nothing else (the hard gate, 29 Oct 2026); the
  // backend refuses every other route for it anyway.
  if (needsEmailVerification(user)) {
    return (
      <ContextWrapper user={user}>
        <EmailVerificationGate />
      </ContextWrapper>
    );
  }

  // The gates below treat an impersonating platform admin as the customer
  // (trial.cta.ts skipsPlanGates); the Impersonate bar stays on top.
  const gateAdmin = skipsPlanGates(user);

  return (
    <ContextWrapper user={user}>
      <CopilotKit
        credentials="include"
        runtimeUrl={backendUrl + '/copilot/chat'}
        showDevConsole={false}
      >
        <MantineWrapper>
          <ToolTip />
          <Toaster />
          <TrialTracker />
          <CheckPayment check={searchParams.get('check') || ''} mutate={mutate}>
            <ShowMediaBoxModal />
            <ShowLinkedinCompany />
            <MediaSettingsLayout />
            <ShowPostSelector />
            <PreConditionComponent />
            <NewSubscription />
            <ContinueProvider />
            <InviteResultToast />
            <div
              className={clsx(
                // dvh, not vh: on iPhone 100vh is taller than the visible
                // area while Safari's toolbars show. Phones get 8px of frame
                // and room at the bottom for the tab bar (mobile.nav.tsx).
                // min-h-screen first: a browser without dvh keeps it.
                'flex flex-col min-h-screen min-h-dvh text-newTextColor p-[8px] md:p-[12px]',
                'pb-[calc(8px+var(--app-bottom-inset,0px))] md:pb-[12px]',
                jakartaSans.className
              )}
            >
              <div>{user?.admin ? <Impersonate /> : <div />}</div>
              {showTwaPlanGate({
                admin: gateAdmin,
                isGeneral,
                billingEnabled,
                isTwa,
                planState: user?.planState,
              }) ? (
                // Play app, and the workspace has to start its trial or
                // choose a plan: the plain notice, no checkout, no Free plan.
                <div className="flex flex-1 flex-col items-center justify-center gap-[24px] p-[24px] text-center">
                  <TwaPlanNotice className="text-[16px] text-newTextColor" />
                  <div className="flex items-center gap-[16px]">
                    <OrganizationSelector />
                    <LogoutComponent />
                  </div>
                  {/* The only way out here besides a plan: the sunset email's
                      Delete my account lands on this screen in the Play app. */}
                  <DeleteAccountComponent isLink={true} />
                </div>
              ) : showFirstBilling({
                tier: user.tier,
                admin: gateAdmin,
                isGeneral,
                billingEnabled,
                // The cookie and localStorage flag, or the server's own
                // (a Free workspace that chose Free on any device, or has a
                // channel or a post). Only where the workspace has a Free
                // plan (see showFirstBilling).
                continueFree: continueFree || !!user?.continueFree,
                isTwa,
                planState: user?.planState,
                freePlanAvailable: user?.freePlanAvailable,
              }) ? (
                // The paywall; for a workspace that has to start its trial,
                // the connect step comes first (connect.first.component.tsx).
                // Keyed by workspace: "Skip for now" is per workspace.
                <PlanGateScreen key={user.orgId} />
              ) : (
                <>
                  {/* The review card: only in the app itself, never over
                      the paywall or the Play app's plan notice. */}
                  <RatePrompt />
                  <AnnouncementBanner />
                  <div className="flex-1 flex gap-[8px] min-w-0">
                    <Support />
                    {/* The rail from md up; phones get the tab bar (MobileNav). */}
                    <div className="hidden md:flex flex-col bg-newBgColorInner w-[80px] shrink-0 rounded-[12px]">
                      <div
                        id="left-menu"
                        className={clsx(
                          'fixed h-full w-[64px] start-[calc(17px+env(safe-area-inset-left,0px))] flex flex-1 top-0',
                          user?.admin && 'pt-[60px] max-h-[1000px]:w-[500px]'
                        )}
                      >
                        <div className="flex flex-col h-full gap-[32px] flex-1 py-[12px] overflow-y-auto overflow-x-hidden min-h-0">
                          <Logo />
                          <TopMenu />
                        </div>
                      </div>
                    </div>
                    <main className="flex-1 min-w-0 bg-newBgLineColor rounded-[12px] overflow-hidden flex flex-col gap-[1px] blurMe">
                      <div className="flex bg-newBgColorInner h-[60px] md:h-[80px] px-[12px] md:px-[20px] items-center gap-[8px] min-w-0">
                        {/* The rail carries the logo from md up. */}
                        <img
                          src="/brand-logo-96.webp"
                          alt=""
                          width={32}
                          height={32}
                          loading="lazy"
                          className="md:hidden w-[32px] h-[32px] shrink-0 rounded-[8px]"
                        />
                        <div className="text-[18px] md:text-[24px] font-[600] flex flex-1 min-w-0 truncate">
                          <Title />
                        </div>
                        <div className="flex items-center gap-[8px] md:gap-[20px] text-textItemBlur shrink-0">
                          <div className="hidden sm:flex"><StreakComponent /></div>
                          <div className="w-[1px] h-[20px] bg-blockSeparator" />
                          <OrganizationSelector />
                          <div className="hover:text-newTextColor">
                            <ModeComponent />
                          </div>
                          <div className="w-[1px] h-[20px] bg-blockSeparator" />
                          <LanguageComponent />
                          <div className="hidden sm:flex"><ChromeExtensionComponent /></div>
                          <div className="w-[1px] h-[20px] bg-blockSeparator" />
                          <AttachToFeedbackIcon />
                          <NotificationComponent />
                        </div>
                      </div>
                      {/* Below the header, so the fixed left menu never covers it. */}
                      {/* No plan yet (an admin in their own workspace gets the
                          app): the way to the trial, on every page. */}
                      <TrialRequiredBanner />
                      {/* A new sign-up on its free posts: how many are left. */}
                      <FreePostsCounter />
                      {/* The plan's last charge failed: pay from another account. */}
                      <PaymentFailedBanner />
                      <FreePlanSunsetBanner />
                      {/* A paid one-time month in its last days: renew it. */}
                      <RenewalReminderBanner />
                      <div className="flex flex-col md:flex-row flex-1 gap-[1px] min-w-0">{children}</div>
                    </main>
                    {/* After the page in the DOM: it is fixed to the bottom
                        anyway, and screen readers and "first link named
                        Calendar" lookups meet the rail on a computer. */}
                    <MobileNav />
                  </div>
                </>
              )}
            </div>
          </CheckPayment>
        </MantineWrapper>
      </CopilotKit>
    </ContextWrapper>
  );
};
