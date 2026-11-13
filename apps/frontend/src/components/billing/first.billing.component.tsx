'use client';

import { useFestiveCard } from '@hookpost/frontend/components/billing/holiday.offer.banner';
import React, { FC, useCallback, useMemo, useState } from 'react';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useVariables } from '@hookpost/react/helpers/variable.context';
import { OrganizationSelector } from '@hookpost/frontend/components/layout/organization.selector';
import { LanguageComponent } from '@hookpost/frontend/components/layout/language.component';
import { AttachToFeedbackIcon } from '@hookpost/frontend/components/new-layout/sentry.feedback.component';
import NotificationComponent from '@hookpost/frontend/components/notifications/notification.component';
import dynamic from 'next/dynamic';
import { LogoTextComponent } from '@hookpost/frontend/components/ui/logo-text.component';
import { capitalize } from 'lodash';
import {
  HOOKPOST_PRICE,
  pricing,
  PURCHASABLE_TIERS,
  getCurrencyConfig,
  SupportedCurrency,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  CHARGE_CURRENCY_NOTE,
  browserTz,
  chargeCurrencyOf,
  firstMonthOfferOf,
  lockedNote,
  pricingFor,
} from '@hookpost/frontend/components/billing/use.pricing.context';
import {
  firstMonthOfferApplies,
  OfferMethod,
} from '@hookpost/nestjs-libraries/services/first.month.offer';
import {
  checkoutDroppedOffer,
  FirstMonthOffer,
  FirstMonthOfferNotApplied,
} from '@hookpost/frontend/components/billing/first.month.offer';
import { upiCapNote } from '@hookpost/frontend/components/billing/checkout.notes';
import { monthsFree } from '@hookpost/frontend/components/billing/yearly.copy';
import { useBillingPricingContext } from '@hookpost/frontend/components/billing/use.billing.pricing.context';
import clsx from 'clsx';
import {
  AppliedCoupon,
  CouponField,
  discounted,
  formatMoney,
} from '@hookpost/frontend/components/billing/coupon.field';
import { LoadingComponent } from '@hookpost/frontend/components/layout/loading';
import { CheckIconComponent } from '@hookpost/frontend/components/ui/check.icon.component';
import {
  FAQComponent,
  FAQSection,
} from '@hookpost/frontend/components/billing/faq.component';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { useDubClickId } from '@hookpost/frontend/components/layout/dubAnalytics';
import SafeImage from '@hookpost/react/helpers/safe.image';
import { useModals } from '@hookpost/frontend/components/layout/new-modal';
import useCookie from 'react-use-cookie';
import { LogoutComponent } from '@hookpost/frontend/components/layout/logout.component';
import { DeveloperIconComponent } from '@hookpost/frontend/components/developer/developer.icon.component';
import {
  expectedFirstChargeAt,
  formatChargeDate,
  trialBullets,
} from '@hookpost/frontend/components/billing/trial.terms.copy';
import { useStartFree } from '@hookpost/frontend/components/billing/start.free';
import { freePlanEndDateLabel } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { FreePlanSunsetBanner } from '@hookpost/frontend/components/layout/free.plan.sunset.banner';
import { HeldInviteNotice } from '@hookpost/frontend/components/layout/held.invite.notice';
import { planScreenOffersDelete } from '@hookpost/frontend/components/layout/free.plan.sunset';
import DeleteAccountComponent from '@hookpost/frontend/components/settings/delete-account.component';
import { usePendingCheckout } from '@hookpost/frontend/components/billing/use.pending.checkout';
import {
  PlanFeature,
  planFeatureItems,
  planFeatureLabel,
} from '@hookpost/frontend/components/billing/plan.features';
import { GumroadRedeemField } from '@hookpost/frontend/components/billing/gumroad.redeem';
import { OneTimePlanCheckout } from '@hookpost/frontend/components/billing/one.time.plan';

const ModeComponent = dynamic(
  () => import('@hookpost/frontend/components/layout/mode.component'),
  {
    ssr: false,
  }
);

const RazorpayBilling = dynamic(
  () =>
    import('@hookpost/frontend/components/billing/razorpay.billing').then(
      (mod) => mod.RazorpayBilling
    ),
  {
    ssr: false,
  }
);

export const FirstBillingComponent: FC<{
  /**
   * A workspace that has to start its trial and connected its first channel
   * (connect.first.ts connectedChannelLine): what the trial is for now,
   * above the plans.
   */
  connected?: [string, string, Record<string, string>] | null;
  /** It skipped the connect step with room left: a way back to it. */
  onConnectFirst?: () => void;
}> = ({ connected, onConnectFirst }) => {
  const { razorpayKeyId } = useVariables();
  const user = useUser();
  const dub = useDubClickId();
  // The single plan since 8 Nov 2026 (pricing.ts HOOKPOST), monthly only.
  const [tier, setTier] = useState('HOOKPOST');
  const [period, setPeriod] = useState('MONTHLY');
  const fetch = useFetch();
  const modals = useModals();
  const t = useT();
  const { startFree, starting: startingFree } = useStartFree();
  const [datafast_visitor_id] = useCookie('datafast_visitor_id', '');
  const [datafast_session_id] = useCookie('datafast_session_id', '');
  // A checkout this tab opened and never saw finish (Android Chrome reloads
  // the tab while the customer approves in their UPI app): wait for the plan
  // instead of offering the trial again.
  const pending = usePendingCheckout();

  // The server decides the currency (GET /billing/pricing-context). The
  // browser's timezone no longer picks it, and nothing is written to a cookie.
  const { data: pricingContext } = useBillingPricingContext();
  // The one plan on sale is shown as $7 to everyone and charged on one INR
  // plan (pricing.ts HOOKPOST_PRICE), so the checkout is in INR whatever the
  // context says, and the page prints dollars.
  const currency: SupportedCurrency = 'INR';
  const festive = useFestiveCard();
  void chargeCurrencyOf;
  const currencyNote = lockedNote(pricingContext) || CHARGE_CURRENCY_NOTE;

  // Website coupon. Checked against /billing/coupon/validate first, then sent
  // with /billing/embedded, which creates the Razorpay subscription on the
  // discounted plan. It is part of the SWR key so applying one rebuilds the
  // checkout at the new price.
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedCoupon | null>(null);

  const activePricing = useMemo(() => pricingFor(pricingContext), [pricingContext]);
  const currencySymbol = '$';
  void getCurrencyConfig;

  // 20% off the first month, where this checkout gets it: a rupee monthly
  // plan charged now (no trial: Razorpay refuses an offer on one), with no
  // coupon. The paywall only ever opens a new subscription. The UPI / card
  // choice picks which offer goes on it (first.month.offer.ts).
  const [payWith, setPayWith] = useState<OfferMethod>('upi');
  const offerTerms = firstMonthOfferOf(pricingContext);
  const offerShown =
    !!offerTerms &&
    firstMonthOfferApplies({
      currency,
      period,
      coupon: !!appliedCoupon,
      startsLater: !!user?.allowTrial,
      newSubscription: true,
    });
  // The selection a checkout came back without the offer for (Razorpay
  // refused it, or the workspace has a plan on file): the page stops
  // promising the discount for that selection (checkoutDroppedOffer).
  const offerSelection = `${tier}|${period}|${appliedCoupon?.code || ''}|${payWith}`;
  const [offerDroppedFor, setOfferDroppedFor] = useState<string | null>(null);
  const offerDropped = offerShown && offerDroppedFor === offerSelection;

  // What the trial will charge and when, stated above the button before
  // anything is approved: the selected plan after any coupon, on the date
  // subscribe() sets (/user/self trialDays: TRIAL_DAYS, or 7 for a workspace
  // the Free plan sunset notice promised 7 to; plus a free-months coupon's
  // delay). The modal
  // then repeats the exact date the server set. A yearly plan says "/year",
  // so "then ₹5,990" is not read as a monthly price.
  const planPrice =
    (tier === 'HOOKPOST'
      ? HOOKPOST_PRICE.displayUsd
      : period === 'MONTHLY'
      ? activePricing[tier]?.month_price
      : activePricing[tier]?.year_price) || 0;
  const amountLabel = `${currencySymbol}${formatMoney(
    discounted(planPrice, appliedCoupon)
  )}${period === 'YEARLY' ? '/year' : ''}`;
  // Pro yearly is over UPI AutoPay's ₹15,000 limit (checkout.notes.ts).
  const upiNote = upiCapNote(
    currency,
    discounted(planPrice, appliedCoupon),
    `${capitalize(tier)} ${period === 'YEARLY' ? 'yearly' : 'monthly'}`
  );
  const chargeDate = formatChargeDate(
    expectedFirstChargeAt(Date.now(), appliedCoupon?.freeMonths, user?.trialDays)
  );

  const loadCheckout = useCallback(async () => {
    return (
      await fetch('/billing/embedded', {
        method: 'POST',
        body: JSON.stringify({
          billing: tier,
          period: period,
          // The signal /billing/pricing-context was given, so checkout picks
          // the currency this page is showing (billing.currency.ts).
          tz: browserTz(),
          ...(datafast_visitor_id && datafast_session_id
            ? { datafast_visitor_id, datafast_session_id }
            : {}),
          ...(dub ? { dub } : {}),
          ...(appliedCoupon ? { coupon: appliedCoupon.code } : {}),
          // Which first-month offer goes on the subscription, when it gets one.
          ...(offerTerms ? { payWith } : {}),
        }),
      })
    ).json();
  }, [tier, period, appliedCoupon, offerTerms, payWith]);


  const showYouTube = () => {
    modals.openModal({
      title: 'Grow Fast With Hookpost (Play the video)',
      children: (
        <iframe
          className="h-full aspect-video min-w-[800px]"
          src={`https://www.youtube.com/embed/${process.env.NEXT_PUBLIC_DEMO_VIDEO_ID}?autoplay=1`}
          title="Hookpost Tutorial"
          allow="autoplay"
          allowFullScreen
        />
      ),
    });
  };

  // The Razorpay subscription is created when the visitor presses the
  // checkout button, not on page load. Creating it in a useSWR on mount made a
  // new subscription for every view of this screen - one test workspace got 5
  // in 16 minutes without ever clicking - and inflated the admin panel's
  // "checkout opened" counts into page-view counts.
  const [blocked, setBlocked] = useState(false);
  const createCheckout = useCallback(async () => {
    const d = await loadCheckout();
    if (d?.blocked) setBlocked(true);
    setOfferDroppedFor(
      checkoutDroppedOffer(offerShown, d) ? offerSelection : null
    );
    return d;
  }, [loadCheckout, offerShown, offerSelection]);

  const price = useMemo(
    () =>
      // PURCHASABLE_TIERS, not every key in the pricing object. TEAM and
      // ULTIMATE still have TIER_LIMITS entries so existing subscribers keep
      // their entitlements, and walking the object put both back on the
      // onboarding screen at Rs1,499 and Rs4,499 - buyable, after we had
      // retired them everywhere on the marketing site.
      Object.entries(activePricing).filter(
        ([key]) => key !== 'FREE' && (PURCHASABLE_TIERS as readonly string[]).includes(key)
      ),
    [activePricing]
  );

  // What Yearly saves, from the prices on these cards: 2 months free on
  // every plan and currency today (₹5,990 against 12 x ₹599). The fewest
  // across the plans, so it is never more than any plan gets; no badge when
  // a year saves nothing. A new key with {{months}}: the old one's
  // translations said "20% off", which a year at ten months' price is not.
  const yearlyMonthsFree = useMemo(
    () =>
      price.length ? Math.min(...price.map(([, value]) => monthsFree(value))) : 0,
    [price]
  );

  const JoinOver = () => {
    return (
      <>
        <div className="text-[46px] font-[600] leading-[110%] tablet:text-[36px] mobile:!text-[30px] whitespace-pre-line text-balance">
          {t('billing_join_over', 'Built for')}{' '}
          <span className="text-hp-primary-text">
            {t('billing_entrepreneurs_count', 'teams and creators')}
          </span>{' '}
          {t('billing_who_use', 'who use')}{' '}
          {t(
            'billing_hookpost_grow_social',
            'Hookpost To Grow Their Social Presence'
          )}
        </div>

        {/*
          Shown only when NEXT_PUBLIC_DEMO_VIDEO_ID names your own demo video.
          Upstream embedded Postiz's promo clip here; after the rebrand that
          presented their video as ours, so the whole block is gated rather than
          left pointing at someone else's content.
        */}
        {process.env.NEXT_PUBLIC_DEMO_VIDEO_ID ? (
          <div className="flex" onClick={showYouTube}>
            <div className="tablet:mb-[32px] cursor-pointer mt-[32px] flex gap-[10px] items-center underline hover:font-[700]">
              <div>
                <SafeImage
                  className="text-[12px]"
                  src="/icons/platforms/youtube.svg"
                  width={22.5}
                  height={16}
                  alt="YouTube"
                />
              </div>
              <div>See how Hookpost works</div>
            </div>
          </div>
        ) : null}

        {!!user?.allowTrial && (
          <div className="flex mt-[32px] mb-[10px] gap-[15px] tablet:mt-[32px] tablet:mb-[32px] text-[16px] font-[500] mobile:flex-col">
            {/* The original three, or the trial's real terms once a trial
                cutoff is set (trial.terms.copy.ts). */}
            {trialBullets({
              trialPolicyActive: user?.trialPolicyActive,
              currency,
              amountLabel,
              chargeDate,
              days: user?.trialDays,
            }).map(([key, fallback, values], i) => (
              <div
                key={key}
                className={
                  i === 1
                    ? 'flex-1 flex gap-[8px] justify-center mobile:justify-start'
                    : 'flex gap-[8px]'
                }
              >
                <div>
                  <CheckIconComponent />
                </div>
                <div>
                  {values
                    ? t(key, {
                        defaultValue: fallback,
                        ...values,
                        interpolation: { escapeValue: false },
                      })
                    : t(key, fallback)}
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    );
  };

  return (
    <div data-testid="plan-picker" className="blurMe flex flex-1 flex-col bg-newBgColorInner pb-[60px] mobile:pb-[100px]">
      <div className="h-[92px] px-[80px] tablet:px-[32px] mobile:!px-[16px] py-[20px] flex border-b border-newColColor">
        <div className="flex-1 flex items-center text-textColor">
          <LogoTextComponent />
        </div>
        <div className="flex items-center">
          {/* 375px wide, six header items overflowed and cut off the logout
              icon. Tighter gap on mobile, and feedback/developer icons hidden. */}
          <div className="flex items-center gap-[20px] mobile:gap-[12px] text-textItemBlur">
            <OrganizationSelector />
            <div className="hover:text-newTextColor">
              <ModeComponent />
            </div>
            <div className="w-[1px] h-[20px] bg-blockSeparator" />
            <LanguageComponent />
            <div className="w-[1px] h-[20px] bg-blockSeparator" />
            <div className="contents mobile:hidden">
              <AttachToFeedbackIcon />
              <DeveloperIconComponent />
            </div>
            {/*<NotificationComponent />*/}
            <div className="hover:text-newTextColor">
              {user?.tier.current === 'FREE' && (
                <LogoutComponent isIcon={true} />
              )}
            </div>
          </div>
        </div>
      </div>
      {/* A grandfathered Free workspace before FREE_PLAN_SUNSET_AT: the date.
          The plans below are the trial, so no button, and Delete Account is
          the line under it. */}
      <FreePlanSunsetBanner showTrial={false} showDelete={false} />
      {/* A team invite waits for the email confirmation (held.invite.notice.tsx). */}
      <HeldInviteNotice className="px-[80px] tablet:px-[32px] mobile:!px-[16px] pt-[24px] text-[14px] text-newTextColor" />
      {/* The channel it connected before the paywall, and what the trial is
          for now; or, after "Skip for now", the way back to connecting one.
          Hidden while a checkout is being confirmed. */}
      {pending.view === 'none' && (connected || onConnectFirst) && (
        <div className="px-[80px] tablet:px-[32px] mobile:!px-[16px] pt-[24px]">
          {connected ? (
            <div
              role="status"
              data-testid="paywall-channel-connected"
              className="flex items-center gap-[12px] rounded-[20px] border-[1.5px] border-[#618DFF] bg-[#618DFF]/10 p-[20px] mobile:p-[16px] text-[16px] font-[600]"
            >
              <div className="shrink-0">
                <CheckIconComponent />
              </div>
              <div>
                {t(connected[0], {
                  defaultValue: connected[1],
                  ...connected[2],
                  interpolation: { escapeValue: false },
                })}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px] rounded-[14px] border border-newColColor p-[16px] text-[14px]">
              <div className="flex-1 min-w-[200px] text-textItemBlur">
                {t(
                  'paywall_connect_first_hint',
                  'Want to see your own account in Hookpost first? Connect a channel, then start the trial.'
                )}
              </div>
              <button
                type="button"
                onClick={onConnectFirst}
                className="h-[40px] shrink-0 rounded-[10px] border border-[#618DFF]/60 px-[16px] text-[14px] font-[600] text-[#618DFF] transition-colors hover:bg-[#618DFF]/10"
              >
                {t('paywall_connect_first_button', 'Connect a channel')}
              </button>
            </div>
          )}
        </div>
      )}
      {/* Above both columns, so it is the first thing seen at every width
          (on a phone the checkout column sits below the plans). */}
      {pending.view !== 'none' && (
        <PendingCheckoutPanel
          view={pending.view}
          trial={pending.trial}
          canStartOver={pending.canStartOver}
          onCheckAgain={pending.checkAgain}
          onStartOver={pending.startOver}
        />
      )}
      {/* At every width: the FAQ that also has it is desktop-only, and after
          the sunset this screen replaces every page the sunset email's
          Delete button can land on (/settings or /launches). */}
      {planScreenOffersDelete({
        planState: user?.planState,
        freePlanEndsAt: user?.freePlanEndsAt,
      }) && (
        <div className="flex justify-end px-[80px] tablet:px-[32px] mobile:!px-[16px] pt-[16px]">
          <DeleteAccountComponent isLink={true} />
        </div>
      )}
      <div className="flex px-[80px] tablet:px-[32px] mobile:!px-[16px] flex-1 flex-row tablet:flex-none tablet:flex-col-reverse">
        <div className="flex-1 py-[40px] tablet:pt-[80px] flex flex-col pe-[40px] tablet:pe-0">
          <div className="block tablet:hidden">
            <JoinOver />
          </div>
          {pending.view !== 'none' ? null : blocked ? (
            <div className="mt-[24px] p-[24px] rounded-[20px] border-[1.5px] border-newColColor text-[16px] font-[500]">
              {t(
                'billing_other_account_subscribed',
                'Another account with this email already has an active subscription. Please log off and sign in to that account to manage your subscription.'
              )}
            </div>
          ) : (
            <>
          <CouponField
            className="mt-[24px]"
            applied={appliedCoupon}
            onChange={setAppliedCoupon}
            price={planPrice}
            symbol={currencySymbol}
            period={period === 'MONTHLY' ? 'month' : 'year'}
          />
          {/* A plan bought on Gumroad: the key from the receipt instead of
              checkout. Hidden unless a Gumroad product is configured. */}
          <GumroadRedeemField className="mt-[12px]" />
          {offerDropped ? (
            <FirstMonthOfferNotApplied className="mt-[16px]" />
          ) : offerShown && offerTerms ? (
            <FirstMonthOffer
              className="mt-[16px]"
              terms={offerTerms}
              monthPrice={activePricing[tier]?.month_price || 0}
              payWith={payWith}
              onPayWithChange={setPayWith}
            />
          ) : null}
          {upiNote ? (
            <div className="mt-[12px] text-[13px] text-textItemBlur">
              {upiNote}
            </div>
          ) : null}
          <RazorpayBilling
            createCheckout={createCheckout}
            keyId={razorpayKeyId}
            currency={currency}
            amountLabel={amountLabel}
            allowTrial={!!user?.allowTrial}
            trialDays={user?.trialDays}
            chargeDate={chargeDate}
            freePlanAvailable={user?.freePlanAvailable !== false}
            rememberPending={true}
          />
          {/* Autopay could not be set up (a UPI mandate that failed, a card
              that refuses recurring): pay once for this month instead. */}
          <div className="mt-[16px] text-[14px] text-textItemBlur">
            {t('billing_pay_once_hint', "Can't set up autopay? Pay once for this month instead.")}
          </div>
          <OneTimePlanCheckout className="mt-[8px]" />
          {currencyNote ? (
            <div className="mt-[12px] text-[13px] text-textItemBlur">
              {currencyNote}
            </div>
          ) : null}
            </>
          )}
        </div>
        <div className="flex flex-col ps-[40px] tablet:!ps-[0] border-l border-newColColor py-[40px] mobile:!pt-[24px] tablet:border-none tablet:pb-0">
          <div className="top-[20px] sticky">
            <div className="hidden tablet:block">
              <JoinOver />
            </div>
            {/* The Free plan used to be a 14px grey link ~1,100px down the page,
                below the fold on desktop and mobile, and none of the 13 free
                workspaces had connected a channel. Offer it up front, next to
                the trial, so a visitor who only wants to try it is not stuck on
                a payment screen. It lives in this column because on tablet and
                mobile the layout is flex-col-reverse and this column comes first. Same behaviour as the link in RazorpayBilling. */}
            {/* Only where the workspace has a Free plan: the new cohort
                (trial.policy.ts on the backend) starts with the trial. */}
            {!blocked && pending.view === 'none' && user?.freePlanAvailable !== false && (
              <div className="mb-[24px] flex flex-wrap items-center gap-x-[16px] gap-y-[8px] rounded-[14px] border border-newColColor p-[16px]">
                <div className="flex-1 min-w-[200px] text-[14px]">
                  <div className="font-[600]">
                    {t('billing_free_headline', 'Just want to try it first?')}
                  </div>
                  <div className="text-textItemBlur">
                    {/* A grandfathered Free plan with FREE_PLAN_SUNSET_AT
                        ahead does have a time limit: say when it ends. */}
                    {/* The numbers are pricing.ts's FREE limits, which the
                        backend enforces. */}
                    {user?.freePlanEndsAt
                      ? `The Free plan is ${pricing.FREE.channel} channels and ${pricing.FREE.posts_per_month} posts a month, no card, until ${freePlanEndDateLabel(
                          user.freePlanEndsAt
                        )}.`
                      : t('billing_free_sub', {
                          defaultValue:
                            'The Free plan is {{channels}} channels and {{posts}} posts a month, no card and no time limit.',
                          channels: pricing.FREE.channel,
                          posts: pricing.FREE.posts_per_month,
                        })}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={startFree}
                  disabled={startingFree}
                  aria-busy={startingFree}
                  className="h-[40px] shrink-0 rounded-[10px] border border-hp-primary/60 px-[16px] text-[14px] font-[600] text-hp-primary-text transition-colors hover:bg-hp-primary/10 disabled:opacity-60 disabled:cursor-wait"
                >
                  {startingFree
                    ? t('billing_starting_free', 'Starting...')
                    : t('billing_start_free', 'Start free')}
                </button>
              </div>
            )}
            <div className="flex mb-[24px] mobile:flex-col justify-between items-start mobile:items-stretch gap-4">
              <div className="text-[24px] font-[700]">
                {t('billing_choose_plan', 'Choose a Plan')}
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {/* The charged currency, from the server. No switcher. */}
                <div className="inline-flex items-center gap-[6px] rounded-full border border-newColColor px-[12px] py-[5px] text-[13px] font-semibold text-textItemBlur">
                  <span>$</span>
                  <span>Prices in USD</span>
                </div>

                {yearlyMonthsFree > 0 && (
                <div className="h-[44px] px-[6px] mobile:px-0 flex items-center justify-center mobile:justify-start gap-[12px] border border-newColColor rounded-[12px] select-none">
                  <div
                    className={clsx(
                      'h-[32px] mobile:flex-1 rounded-[6px] text-[16px] px-[12px] flex justify-center items-center',
                      period === 'MONTHLY'
                        ? 'bg-boxFocused text-textItemFocused'
                        : 'cursor-pointer'
                    )}
                    onClick={() => setPeriod('MONTHLY')}
                  >
                    {t('billing_monthly', 'Monthly')}
                  </div>
                  <div
                    className={clsx(
                      'gap-[10px] h-[32px] mobile:flex-1 rounded-[6px] text-[16px] px-[12px] flex justify-center items-center',
                      period === 'YEARLY'
                        ? 'bg-boxFocused text-textItemFocused'
                        : 'cursor-pointer'
                    )}
                    onClick={() => setPeriod('YEARLY')}
                  >
                    <div>{t('billing_yearly', 'Yearly')}</div>
                    {yearlyMonthsFree > 0 && (
                      <div className="bg-hp-accent text-hp-on-accent px-[8px] rounded-[4px] mobile:hidden">
                        {t('billing_yearly_months_free', {
                          defaultValue:
                            yearlyMonthsFree === 1
                              ? '{{months}} month free'
                              : '{{months}} months free',
                          months: String(yearlyMonthsFree),
                        })}
                      </div>
                    )}
                  </div>
                </div>
                )}
              </div>
            </div>
            {/* Centred: one card (the plan) or two (Free beside it). */}
            <div
              className={clsx(
                'gap-[12px] w-full pt-[14px]',
                price.length === 1
                  ? 'flex justify-center'
                  : 'grid grid-cols-2 mobile:grid-cols-2 tablet:grid-cols-2'
              )}
            >
              {price.map(
                ([key, value]) => (
                  <div
                    onClick={() => setTier(key)}
                    key={key}
                    style={key === 'HOOKPOST' ? festive.cardStyle : undefined}
                    className={clsx(
                      'relative cursor-pointer select-none w-full max-w-[420px] min-h-[130px] p-[20px] mobile:p-[14px] rounded-[20px] flex flex-col justify-between transition-all',
                      key === tier
                        ? 'border-[1.5px] border-[#618DFF] bg-[#618DFF]/10 shadow-lg'
                        : 'border-[1.5px] border-newColColor hover:border-newTextColor/30',
                      key === 'HOOKPOST' && festive.cardClass
                    )}
                  >
                    {/* The festival badge, lit edge and glow (holiday.offer.banner.tsx). */}
                    {key === 'HOOKPOST' ? festive.decoration : null}
                    <div className="text-[18px] mobile:text-[15px] font-[600] text-textColor">
                      {capitalize(key)}
                    </div>
                    <div className="flex items-baseline gap-[4px] flex-wrap mt-[6px]">
                      <span className="text-[32px] mobile:text-[22px] font-[700] leading-none text-textColor tracking-tight">
                        {currencySymbol}
                        {formatMoney(
                          key === 'HOOKPOST'
                            ? HOOKPOST_PRICE.displayUsd
                            : key === 'FREE'
                            ? 0
                            : value[
                                period === 'MONTHLY' ? 'month_price' : 'year_price'
                              ],
                          'en-US'
                        )}
                      </span>
                      <span className="text-[14px] mobile:text-[12px] font-[400] text-gray-400 whitespace-nowrap">
                        {period === 'MONTHLY'
                          ? t('billing_per_month', '/ month')
                          : t('billing_per_year', '/ year')}
                      </span>
                    </div>
                  </div>
                ),
                []
              )}
            </div>
            <div className="flex flex-col mt-[54px] gap-[24px] tablet:mt-[40px]">
              <div className="text-[24px] font-[700]">
                {t('billing_features', 'Features')}
              </div>
              <BillingFeatures tier={tier} />
            </div>
            <div className="flex flex-col mobile:hidden tablet:hidden">
              {/*<div>asd</div>*/}
              <FAQComponent />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Shown while the paywall waits for a checkout this tab opened
 * (use.pending.checkout.ts), and when the wait runs out. The buttons only
 * read or forget; neither starts a checkout.
 *
 * The words never say the customer approved anything, and never name UPI:
 * the tab may have reloaded after a cancel in GPay or PhonePe, and USD
 * checkouts pay by card. "Back to plans" shows once canStartOver is set.
 */
const PendingCheckoutPanel: FC<{
  view: 'confirming' | 'timeout';
  trial: boolean;
  canStartOver: boolean;
  onCheckAgain: () => void;
  onStartOver: () => void;
}> = ({ view, trial, canStartOver, onCheckAgain, onStartOver }) => {
  const t = useT();
  const backToPlans = (
    <button
      type="button"
      onClick={onStartOver}
      className="h-[40px] rounded-[10px] border border-newColColor px-[16px] text-[14px] font-[600]"
    >
      {t('billing_pending_back_to_plans', 'Back to plans')}
    </button>
  );
  return (
    <div className="px-[80px] tablet:px-[32px] mobile:!px-[16px] pt-[24px]">
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col gap-[12px] rounded-[20px] border-[1.5px] border-[#618DFF] bg-[#618DFF]/10 p-[24px] mobile:p-[16px]"
      >
        {view === 'confirming' ? (
          <>
            <div className="flex items-center gap-[12px] text-[20px] font-[600]">
              <div
                aria-hidden="true"
                className="h-[20px] w-[20px] shrink-0 rounded-full border-[2px] border-[#618DFF] border-t-transparent animate-spin"
              />
              {trial
                ? t(
                    'billing_pending_confirming_trial',
                    'Checking whether your trial has started…'
                  )
                : t(
                    'billing_pending_confirming_payment',
                    'Checking whether your payment went through…'
                  )}
            </div>
            <div className="text-[14px] text-textItemBlur">
              {t(
                'billing_pending_confirming_body',
                'If you approved the payment, this usually takes a few seconds.'
              )}
            </div>
            {canStartOver && (
              <div className="flex flex-wrap items-center gap-[12px]">
                {backToPlans}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="text-[20px] font-[600]">
              {trial
                ? t('billing_pending_timeout_trial', 'Your trial is not confirmed yet')
                : t('billing_pending_timeout_payment', 'Your payment is not confirmed yet')}
            </div>
            <div className="text-[14px] text-textItemBlur">
              {t(
                'billing_pending_timeout_body',
                "If you approved the payment, it can take a minute to reach us, so check again shortly. If you didn't finish paying, go back to the plans and start again."
              )}
            </div>
            <div className="flex flex-wrap items-center gap-[12px]">
              <button
                type="button"
                onClick={onCheckAgain}
                className="h-[40px] rounded-[10px] bg-[#618DFF] px-[16px] text-[14px] font-[600] text-white"
              >
                {t('billing_pending_check_again', 'Check again')}
              </button>
              {backToPlans}
              <a
                href="mailto:support@hookstep.in"
                className="text-[14px] text-textItemBlur underline hover:text-newTextColor"
              >
                {t('billing_pending_support', 'Need help? support@hookstep.in')}
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export const BillingFeatures: FC<{ tier: string }> = ({ tier }) => {
  const t = useT();
  // What pricing.ts grants, shared with the Billing page (plan.features.ts).
  const features = useMemo(() => planFeatureItems(pricing[tier]), [tier]);
  const renderFeature = (feature: PlanFeature) => planFeatureLabel(feature, t);

  return (
    <div className="grid grid-cols-2 mobile:grid-cols-1 gap-y-[8px] gap-x-[32px]">
      {features.map((feature) => (
        <div key={feature.key} className="flex items-center gap-[8px]">
          <div>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="17"
              height="17"
              viewBox="0 0 17 17"
              fill="none"
            >
              <path
                d="M11.825 0H4.84167C1.80833 0 0 1.80833 0 4.84167V11.8167C0 14.8583 1.80833 16.6667 4.84167 16.6667H11.8167C14.85 16.6667 16.6583 14.8583 16.6583 11.825V4.84167C16.6667 1.80833 14.8583 0 11.825 0ZM12.3167 6.41667L7.59167 11.1417C7.475 11.2583 7.31667 11.325 7.15 11.325C6.98333 11.325 6.825 11.2583 6.70833 11.1417L4.35 8.78333C4.10833 8.54167 4.10833 8.14167 4.35 7.9C4.59167 7.65833 4.99167 7.65833 5.23333 7.9L7.15 9.81667L11.4333 5.53333C11.675 5.29167 12.075 5.29167 12.3167 5.53333C12.5583 5.775 12.5583 6.16667 12.3167 6.41667Z"
                fill="currentColor"
              />
            </svg>
          </div>
          <div>{renderFeature(feature)}</div>
        </div>
      ))}
    </div>
  );
};
