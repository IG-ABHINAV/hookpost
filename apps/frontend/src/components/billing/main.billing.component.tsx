'use client';

import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@hookpost/react/form/button';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { Subscription } from '@prisma/client';
import { deleteDialog } from '@hookpost/react/helpers/delete.dialog';
import { useToaster } from '@hookpost/react/toaster/toaster';
import dayjs from 'dayjs';
import clsx from 'clsx';
import {
  AppliedCoupon,
  CouponField,
} from '@hookpost/frontend/components/billing/coupon.field';
import {
  PlanCardPrice,
  paidPriceFor,
} from '@hookpost/frontend/components/billing/plan.card.price';
import {
  pricing,
  getCurrencyConfig,
  getPricing,
  SupportedCurrency,
  PURCHASABLE_TIERS,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  browserTz,
  chargeCurrencyOf,
  firstMonthOfferOf,
  lockedNote,
  pricingFor,
  scheduledChangeOf,
} from '@hookpost/frontend/components/billing/use.pricing.context';
import {
  HolidayOfferBanner,
  useFestiveCard,
} from '@hookpost/frontend/components/billing/holiday.offer.banner';
import { PlanUsage } from '@hookpost/frontend/components/billing/plan.usage';
import { CHARGE_CURRENCY_NOTE } from '@hookpost/frontend/components/billing/use.pricing.context';
import { HOOKPOST_PRICE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { useBillingPricingContext } from '@hookpost/frontend/components/billing/use.billing.pricing.context';
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
import { FAQComponent } from '@hookpost/frontend/components/billing/faq.component';
import useSWR, { useSWRConfig } from 'swr';
import { useUser } from '@hookpost/frontend/components/layout/user.context';
import { useRouter, useSearchParams } from 'next/navigation';
import { useVariables } from '@hookpost/react/helpers/variable.context';
import { useModals } from '@hookpost/frontend/components/layout/new-modal';
import { Textarea } from '@hookpost/react/form/textarea';
import { useFireEvents } from '@hookpost/helpers/utils/use.fire.events';
import { useUtmUrl } from '@hookpost/helpers/utils/utm.saver';
import { useTrack } from '@hookpost/react/helpers/use.track';
import { TrackEnum } from '@hookpost/nestjs-libraries/user/track.enum';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import {
  knownTrialDays,
  MEDIA_KEPT_LINE,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { FinishTrial } from '@hookpost/frontend/components/billing/finish.trial';
import { useDubClickId } from '@hookpost/frontend/components/layout/dubAnalytics';
import { LogoutComponent } from '@hookpost/frontend/components/layout/logout.component';
import {
  loadRazorpayScript,
  openRazorpayCheckout,
} from '@hookpost/frontend/components/billing/razorpay.billing';
import {
  ReplacementReason,
  runReplacementMandate,
} from '@hookpost/frontend/components/billing/replacement.mandate';
import { isTwaClient } from '@hookpost/frontend/components/layout/twa';
import {
  PeriodToggle,
  yearlySavingPercent,
} from '@hookpost/frontend/components/billing/period.toggle';
import { BillingInvoices } from '@hookpost/frontend/components/billing/invoices.component';
import {
  cancelDialogCopy,
  cancelledToastCopy,
  trialCancelledLine,
  freePlanUntil,
} from '@hookpost/frontend/components/billing/cancel.copy';
import {
  channelsOverAllowance,
  Prorate,
  scheduledChangeLine,
  tierName,
} from '@hookpost/frontend/components/billing/prorate.component';
import {
  planFeatureItems,
  planFeatureLabel,
} from '@hookpost/frontend/components/billing/plan.features';
import {
  GumroadPlanPanel,
  GumroadRedeemField,
} from '@hookpost/frontend/components/billing/gumroad.redeem';
import {
  isGumroadIdentifier,
  planOnFileBlocksRedeem,
} from '@hookpost/nestjs-libraries/services/gumroad.license';
import { freePostsPlansLine } from '@hookpost/frontend/components/layout/trial.cta';

/**
 * The workspace's channels, for the warning a downgrade shows: the ones past
 * the new plan's allowance stop publishing until it is raised again, and none
 * are deleted (channelsOverAllowance).
 *
 * The same SWR key the rest of the app reads, so on a page opened from inside
 * the app the list is already cached and this costs no request.
 */
const useWorkspaceChannels = () => {
  const fetch = useFetch();
  return useSWR('/integrations/list', async (path: string) => {
    const res = await fetch(path);
    return res.ok ? (await res.json()).integrations : [];
  });
};

export const Features: FC<{
  pack: 'FREE' | 'STANDARD' | 'PRO' | 'HOOKPOST';
}> = (props) => {
  const { pack } = props;
  // The same list as the paywall's (plan.features.ts), in English.
  const features = useMemo(
    () => planFeatureItems(pricing[pack]).map((f) => planFeatureLabel(f)),
    [pack]
  );
  return (
    <div className="flex flex-col gap-[10px] justify-center text-[16px] text-customColor18">
      {features.map((feature) => (
        // text-start: below 1024px the plan card centres its text, which
        // pushed a wrapped feature line away from its tick.
        <div key={feature} className="flex gap-[12px] md:gap-[20px] text-start">
          <div className="shrink-0">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
            >
              <path
                d="M16.2806 9.21937C16.3504 9.28903 16.4057 9.37175 16.4434 9.46279C16.4812 9.55384 16.5006 9.65144 16.5006 9.75C16.5006 9.84856 16.4812 9.94616 16.4434 10.0372C16.4057 10.1283 16.3504 10.211 16.2806 10.2806L11.0306 15.5306C10.961 15.6004 10.8783 15.6557 10.7872 15.6934C10.6962 15.7312 10.5986 15.7506 10.5 15.7506C10.4014 15.7506 10.3038 15.7312 10.2128 15.6934C10.1218 15.6557 10.039 15.6004 9.96938 15.5306L7.71938 13.2806C7.57865 13.1399 7.49959 12.949 7.49959 12.75C7.49959 12.551 7.57865 12.3601 7.71938 12.2194C7.86011 12.0786 8.05098 11.9996 8.25 11.9996C8.44903 11.9996 8.6399 12.0786 8.78063 12.2194L10.5 13.9397L15.2194 9.21937C15.289 9.14964 15.3718 9.09432 15.4628 9.05658C15.5538 9.01884 15.6514 8.99941 15.75 8.99941C15.8486 8.99941 15.9462 9.01884 16.0372 9.05658C16.1283 9.09432 16.211 9.14964 16.2806 9.21937ZM21.75 12C21.75 13.9284 21.1782 15.8134 20.1068 17.4168C19.0355 19.0202 17.5127 20.2699 15.7312 21.0078C13.9496 21.7458 11.9892 21.9389 10.0979 21.5627C8.20656 21.1865 6.46928 20.2579 5.10571 18.8943C3.74215 17.5307 2.81355 15.7934 2.43735 13.9021C2.06114 12.0108 2.25422 10.0504 2.99218 8.26884C3.73013 6.48726 4.97982 4.96451 6.58319 3.89317C8.18657 2.82183 10.0716 2.25 12 2.25C14.585 2.25273 17.0634 3.28084 18.8913 5.10872C20.7192 6.93661 21.7473 9.41498 21.75 12ZM20.25 12C20.25 10.3683 19.7661 8.77325 18.8596 7.41655C17.9531 6.05984 16.6646 5.00242 15.1571 4.37799C13.6497 3.75357 11.9909 3.59019 10.3905 3.90852C8.79017 4.22685 7.32016 5.01259 6.16637 6.16637C5.01259 7.32015 4.22685 8.79016 3.90853 10.3905C3.5902 11.9908 3.75358 13.6496 4.378 15.1571C5.00242 16.6646 6.05984 17.9531 7.41655 18.8596C8.77326 19.7661 10.3683 20.25 12 20.25C14.1873 20.2475 16.2843 19.3775 17.8309 17.8309C19.3775 16.2843 20.2475 14.1873 20.25 12Z"
                fill="#06ff00"
              />
            </svg>
          </div>
          <div>{feature}</div>
        </div>
      ))}
    </div>
  );
};

const Accept: FC<{ resolve: (res: boolean) => void }> = ({ resolve }) => {
  const [loading, setLoading] = useState(false);
  const fetch = useFetch();
  const toaster = useToaster();

  const apply = useCallback(async () => {
    setLoading(true);
    await fetch('/billing/apply-discount', {
      method: 'POST',
    });

    resolve(true);
    toaster.show('50% discount applied successfully');
  }, []);

  return (
    <div>
      <div className="mb-[20px]">
        Would you accept 50% discount for 3 months instead? 🙏🏻
      </div>
      <div className="flex gap-[10px]">
        <Button loading={loading} onClick={apply}>
          Apply 50% discount for 3 months
        </Button>
        <Button onClick={() => resolve(false)} className="!bg-red-800">
          Cancel my subscription
        </Button>
      </div>
    </div>
  );
};
const Info: FC<{
  proceed: (feedback: string) => void;
}> = (props) => {
  const [feedback, setFeedback] = useState('');
  const modal = useModals();
  const events = useFireEvents();
  const cancel = useCallback(() => {
    props.proceed(feedback);
    events('cancel_subscription');
    modal.closeAll();
  }, [modal, feedback]);

  const t = useT();

  return (
    <div className="relative flex gap-[20px] flex-col flex-1 rounded-[4px]">
      <div>
        {t(
          'would_you_mind_shortly_tell_us_what_we_could_have_done_better',
          'Would you mind shortly tell us what we could have done better?'
        )}
      </div>
      <div>
        <Textarea
          className="bg-newBgColorInner"
          label={'Feedback'}
          name="feedback"
          disableForm={true}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
      </div>
      <div>
        <Button disabled={feedback.length < 20} onClick={cancel}>
          {feedback.length < 20
            ? t('please_add_at_least', 'Please add at least 20 chars')
            : t('cancel_subscription', 'Cancel Subscription')}
        </Button>
      </div>
    </div>
  );
};
export const MainBillingComponent: FC<{
  sub?: Subscription;
}> = (props) => {
  const { sub } = props;
  const { isGeneral } = useVariables();
  const { mutate } = useSWRConfig();
  const fetch = useFetch();
  const toast = useToaster();
  const user = useUser();
  const dub = useDubClickId();
  const modal = useModals();
  const router = useRouter();
  const utm = useUtmUrl();
  const track = useTrack();
  const t = useT();
  const queryParams = useSearchParams();
  const [finishTrial, setFinishTrial] = useState(
    !!queryParams.get('finishTrial')
  );

  const [subscription, setSubscription] = useState<Subscription | undefined>(
    sub
  );
  const [loading, setLoading] = useState<boolean>(false);
  // Which plan the customer actually clicked. A single shared `loading`
  // spun every Purchase button at once and looked like a page-wide hang.
  const [loadingPack, setLoadingPack] = useState<string>('');
  const [period, setPeriod] = useState<'MONTHLY' | 'YEARLY'>(
    subscription?.period || 'MONTHLY'
  );
  // Website coupon: validated here, sent with the checkout request, applied by
  // the backend when the Razorpay subscription is created.
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedCoupon | null>(null);
  const [monthlyOrYearly, setMonthlyOrYearly] = useState<'on' | 'off'>(
    period === 'MONTHLY' ? 'off' : 'on'
  );
  const [initialChannels, setInitialChannels] = useState(
    sub?.totalChannels || 1
  );
  // The server decides the currency (GET /billing/pricing-context): rupees,
  // unless this workspace is still on a live plan in another currency. The
  // browser's timezone no longer picks it, and nothing is written to a cookie.
  const { data: pricingContext, mutate: refreshPricingContext } =
    useBillingPricingContext();
  const currency: SupportedCurrency = chargeCurrencyOf(pricingContext);
  const festive = useFestiveCard();
  const activePricing = useMemo(() => pricingFor(pricingContext), [pricingContext]);
  const currencyLocked = lockedNote(pricingContext);
  // A downgrade approved for the end of the cycle (scheduledChangeOf): the
  // workspace keeps the plan it paid for until then.
  const scheduledChange = scheduledChangeOf(pricingContext);
  const { data: channels } = useWorkspaceChannels();
  // 20% off the first month (first.month.offer.ts): only a workspace with no
  // plan on file, buying a rupee monthly plan charged now (no trial), with no
  // coupon. Upgrades and plan changes never get it.
  const [payWith, setPayWith] = useState<OfferMethod>('upi');
  const offerTerms = firstMonthOfferOf(pricingContext);
  const offerShown =
    !!offerTerms &&
    firstMonthOfferApplies({
      currency,
      period: monthlyOrYearly === 'on' ? 'YEARLY' : 'MONTHLY',
      coupon: !!appliedCoupon,
      startsLater: !!user?.allowTrial,
      newSubscription: !subscription,
    });
  // The selection a checkout came back without the offer for (Razorpay
  // refused it): the page stops promising the discount for that selection
  // (checkoutDroppedOffer). Several plans are listed, so the plan is part of
  // it once a checkout has been opened.
  const offerSelection = `${monthlyOrYearly}|${appliedCoupon?.code || ''}|${payWith}`;
  const [offerDroppedFor, setOfferDroppedFor] = useState<string | null>(null);
  const offerDropped = offerShown && offerDroppedFor === offerSelection;
  // A new sign-up on its free posts: how many are left, and the offer when
  // this selection gets it (trial.cta.ts freePostsPlansLine).
  const freePostsLine =
    user?.planState === 'free_posts'
      ? freePostsPlansLine(
          user?.freePosts,
          offerShown && !offerDropped && offerTerms ? offerTerms.percent : null
        )
      : null;
  // Pro yearly is over UPI AutoPay's ₹15,000 limit (checkout.notes.ts).
  const upiNote =
    monthlyOrYearly === 'on'
      ? upiCapNote(currency, activePricing.PRO?.year_price || 0, 'Pro yearly')
      : null;
  const yearlySaving = useMemo(
    () =>
      yearlySavingPercent(
        Object.entries(activePricing)
          .filter(([tier]) => (PURCHASABLE_TIERS as readonly string[]).includes(tier))
          .map(([, values]) => values)
      ),
    [activePricing]
  );

  useEffect(() => {
    if (initialChannels !== sub?.totalChannels) {
      setInitialChannels(sub?.totalChannels || 1);
    }
    if (period !== sub?.period) {
      setPeriod(sub?.period || 'MONTHLY');
      setMonthlyOrYearly(
        (sub?.period || 'MONTHLY') === 'MONTHLY' ? 'off' : 'on'
      );
    }
    setSubscription(sub);
  }, [sub]);
  const [showInvoices, setShowInvoices] = useState(false);

  // When the plan stops, if it is set to. In the future = still active.
  const endsAt = subscription?.cancelAt ? dayjs(subscription.cancelAt) : null;
  const stillActiveUntilEnd = !!endsAt && endsAt.isAfter(dayjs());
  // Workspaces created before the trial cutoff fall back to the Free plan;
  // the new cohort is paused instead (trial.policy.ts on the backend).
  const freePlan = user?.freePlanAvailable !== false;
  // When that Free plan itself ends (FREE_PLAN_SUNSET_AT, still ahead).
  const freePlanEndsAt = user?.freePlanSunsetAt || null;
  const currentTierName = subscription?.subscriptionTier
    ? tierName(subscription.subscriptionTier)
    : '';

  /**
   * Reactivate, and Change payment method. Razorpay can neither undo a
   * scheduled cancellation nor edit a UPI Autopay or e-mandate, so both
   * approve a new mandate for the same plan. The terms come from a quote that
   * creates nothing; the mandate is created only after "Continue to Razorpay"
   * (see replacement.mandate.ts). The old mandate is cancelled by the backend
   * only once the new one is approved.
   */
  const startReplacementMandate = useCallback(
    async (reason: ReplacementReason) => {
      if (isTwaClient()) {
        return;
      }
      const stop = () => {
        setLoading(false);
        setLoadingPack('');
      };
      setLoading(true);
      setLoadingPack(reason);
      const outcome = await runReplacementMandate({
        reason,
        t,
        currentTierName,
        fetch,
        confirm: deleteDialog,
        prepareCheckout: loadRazorpayScript,
        warn: (message) => toast.show(message, 'warning'),
        openCheckout: (created, amountLabel) =>
          openRazorpayCheckout({
            subscriptionId: created.subscriptionId,
            keyId: created.keyId,
            currency: created.currency,
            amountLabel,
            verify: async (payload) => {
              await fetch('/razorpay/verify', {
                method: 'POST',
                body: JSON.stringify(payload),
              });
            },
            onError: (message) => {
              stop();
              toast.show(message, 'warning');
            },
            onClose: stop,
          }),
      }).catch(() => {
        toast.show(
          t(
            'billing_checkout_start_failed',
            'We could not start checkout. Please try again, or email support@hookstep.in.'
          ),
          'warning'
        );
        return 'failed' as const;
      });
      stop();
      return outcome;
    },
    [fetch, toast, t, currentTierName]
  );
  /**
   * "Keep my current plan" on a scheduled downgrade. Razorpay drops a pending
   * update on a card mandate itself, and nothing else is needed; a mandate it
   * cannot re-plan holds the downgrade as a second subscription, so keeping
   * the plan means approving a new one for it (undo_downgrade), which is the
   * flow Reactivate already runs. The backend's `how` decides, so the page
   * never asks for the wrong one.
   */
  const undoScheduledChange = useCallback(async () => {
    if (!scheduledChange) {
      return;
    }
    if (scheduledChange.how === 'new_mandate') {
      await startReplacementMandate('undo_downgrade');
      await refreshPricingContext();
      return;
    }
    setLoading(true);
    setLoadingPack('undo_downgrade');
    const res = await fetch('/billing/plan-change/undo', {
      method: 'POST',
    }).catch(() => null);
    setLoading(false);
    setLoadingPack('');
    if (!res?.ok) {
      toast.show(
        t(
          'billing_undo_change_failed',
          'We could not call off the change. Please try again, or email support@hookstep.in.'
        ),
        'warning'
      );
      return;
    }
    await refreshPricingContext();
    toast.show(
      t('billing_change_called_off', 'Your plan carries on unchanged.'),
      'success'
    );
  }, [
    scheduledChange,
    startReplacementMandate,
    refreshPricingContext,
    fetch,
    toast,
    t,
  ]);

  // The failure email and the banner over the app link here
  // (PAY_FROM_ANOTHER_ACCOUNT_PATH) when the plan's last charge failed: open
  // Change payment method once, then drop the parameter so a reload does
  // not open it again. Nothing is created until "Continue to Razorpay".
  const payFromAnotherAccount = queryParams.get('pay') === 'another-account';
  const openedPayFromAnotherAccount = useRef(false);
  useEffect(() => {
    // The banner stays on this page too: once the parameter is gone, its
    // next click opens the dialog again.
    if (!payFromAnotherAccount) {
      openedPayFromAnotherAccount.current = false;
      return;
    }
    if (
      openedPayFromAnotherAccount.current ||
      subscription?.isLifetime ||
      !subscription?.identifier?.startsWith('sub_')
    ) {
      return;
    }
    openedPayFromAnotherAccount.current = true;
    router.replace('/billing');
    startReplacementMandate('payment_method');
  }, [payFromAnotherAccount, subscription, startReplacementMandate, router]);
  const currentPackage = useMemo(() => {
    if (!subscription) {
      return 'FREE';
    }
    if (period === 'YEARLY' && monthlyOrYearly === 'off') {
      return '';
    }
    if (period === 'MONTHLY' && monthlyOrYearly === 'on') {
      return '';
    }
    return subscription?.subscriptionTier;
  }, [subscription, initialChannels, monthlyOrYearly, period]);
  const moveToCheckout = useCallback(
    (billing: 'STANDARD' | 'PRO' | 'HOOKPOST' | 'FREE', reactivate = false) =>
      async () => {
        // BillingComponent never renders this inside the Google Play app.
        // This is the backstop: there, openRazorpayCheckout returns false and
        // the code below would fall through to Razorpay's hosted page.
        if (isTwaClient()) {
          return;
        }
        if (reactivate) {
          // This used to POST /billing/cancel, which toggled: it read
          // Razorpay's always-populated end_at as "already cancelled" and
          // opened a subscription nobody approved.
          await startReplacementMandate('reactivate');
          return;
        }

        const messages = [];
        if (
          !pricing[billing].team_members &&
          pricing[subscription?.subscriptionTier!]?.team_members
        ) {
          // They are switched off, not removed, when the lower plan takes
          // effect (subscription.service.ts disableOrEnableNonSuperAdminUsers),
          // and switched back on by moving up again.
          messages.push(
            `Your team members lose access when the new plan takes effect, and get it back if you move up again; nobody is removed`
          );
        }
        // Channels past the new plan's allowance: the limit disables the
        // newest ones and deletes nothing (permissions.service.ts). Said
        // before the change is confirmed, not after.
        const over = channelsOverAllowance(channels, pricing[billing]?.channel);
        if (over) {
          messages.push(
            `${over} of your channels won't fit the new plan and will stop publishing until you move back up; none are deleted`
          );
        }
        if (billing === 'FREE') {
          // Already set to end: nothing to do (the buttons are hidden then).
          if (subscription?.cancelAt) {
            return;
          }
          // A refunded plan ends now, not at the end of the period. The
          // dialog only words it; POST /billing/cancel decides.
          let quote: { endsNow?: boolean } | null = null;
          if (!user?.isTrailing) {
            setLoading(true);
            setLoadingPack('cancel');
            quote = await fetch('/billing/cancel/quote')
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null);
            setLoading(false);
            setLoadingPack('');
          }
          const whatHappens = cancelDialogCopy({
            isTrial: !!user?.isTrailing,
            trialEndsAt: user?.trialEndsAt,
            freePlan,
            tierName: currentTierName,
            freePlanEndsAt,
            refunded: !!quote?.endsNow,
          });
          if (
            await deleteDialog(
              [whatHappens, ...messages].join(' '),
              t('yes_cancel', 'Yes, cancel'),
              t('cancel_subscription', 'Cancel subscription'),
              t('keep_my_plan', 'Keep my plan')
            )
          ) {
            const checkDiscount = await (
              await fetch('/billing/check-discount')
            ).json();
            if (checkDiscount.offerCoupon) {
              const info = await new Promise((res) => {
                modal.openModal({
                  title: 'Before you cancel',
                  withCloseButton: true,
                  classNames: {
                    modal: 'bg-transparent text-textColor',
                  },
                  children: <Accept resolve={res} />,
                });
              });

              modal.closeAll();

              if (info) {
                return;
              }
            }

            const info = await new Promise<string | null>((res) => {
              modal.openModal({
                title: t(
                  'we_are_sorry_to_see_you_go',
                  'We are sorry to see you go :('
                ),
                withCloseButton: true,
                // Closing the feedback box keeps the plan.
                onClose: () => res(null),
                classNames: {
                  modal: 'bg-transparent text-textColor',
                },
                children: <Info proceed={(e) => res(e)} />,
              });
            });
            if (info === null) {
              return;
            }

            setLoading(true);
            setLoadingPack('cancel');
            const res = await fetch('/billing/cancel', {
              method: 'POST',
              body: JSON.stringify({
                feedback: info,
              }),
              headers: {
                'Content-Type': 'application/json',
              },
            });
            const body = await res.json().catch(() => null);
            setLoading(false);
            setLoadingPack('');
            // It used to toast only when cancel_at came back and ignore
            // errors, so a failed cancel looked like a dead button.
            if (!res.ok || !body?.cancel_at) {
              toast.show(
                String(
                  body?.message ||
                    "We couldn't cancel your subscription. Please try again, or email support@hookstep.in."
                ),
                'warning'
              );
              return;
            }
            setSubscription((subs) => ({
              ...subs!,
              cancelAt: body.cancel_at,
            }));
            mutate('/user/subscription');
            toast.show(
              cancelledToastCopy({
                cancelAt: body.cancel_at,
                isTrial: !!user?.isTrailing,
                freePlan,
                tierName: currentTierName,
                freePlanEndsAt,
              })
            );
          }
          return;
        }
        if (
          messages.length &&
          !(await deleteDialog(messages.join(', '), 'Yes, continue'))
        ) {
          return;
        }
        setLoading(true);
        setLoadingPack(billing);
        const embeddedResponse = await (
          await fetch('/billing/embedded', {
            method: 'POST',
            body: JSON.stringify({
              period: monthlyOrYearly === 'on' ? 'YEARLY' : 'MONTHLY',
              utm,
              billing,
              // The signal /billing/pricing-context was given, so checkout
              // picks the currency this page is showing.
              tz: browserTz(),
              ...(dub ? { dub } : {}),
              ...(appliedCoupon ? { coupon: appliedCoupon.code } : {}),
              // Which first-month offer goes on the subscription, when it
              // gets one.
              ...(offerTerms ? { payWith } : {}),
            }),
          })
        ).json();
        if (embeddedResponse?.statusCode >= 400) {
          toast.show(
            String(embeddedResponse.message || 'Could not start checkout'),
            'warning'
          );
          setLoading(false);
          setLoadingPack('');
          return;
        }
        const {
          url,
          blocked,
          subscriptionId,
          keyId,
          currency: returnedCurrency,
          startAt,
        } = embeddedResponse;
        setOfferDroppedFor(
          checkoutDroppedOffer(offerShown, embeddedResponse)
            ? offerSelection
            : null
        );
        if (blocked) {
          setLoading(false);
          setLoadingPack('');
          await deleteDialog(
            t(
              'billing_other_account_subscribed',
              'Another account with this email already has an active subscription. Please log off and sign in to that account to manage your subscription.'
            ),
            t('ok', 'OK'),
            t('already_subscribed', 'Already subscribed')
          );
          return;
        }
        if (url || subscriptionId) {
          const checkoutCurrency = returnedCurrency || currency;
          // Priced in the currency the subscription was created in: if the
          // page's prices were in another one (out of date), its own table.
          const planTable =
            checkoutCurrency === currency
              ? activePricing
              : getPricing(checkoutCurrency);
          const planPrice =
            planTable[billing][
              monthlyOrYearly === 'on' ? 'year_price' : 'month_price'
            ];
          await track(TrackEnum.InitiateCheckout, {
            value: planPrice,
            currency: checkoutCurrency,
          });

          // Open Razorpay's in-page modal. This used to be
          // `window.location.href = url`, which sends the customer to
          // Razorpay's hosted subscription page - and that page answered
          // "Hosted page is not available. Please contact the merchant" for
          // every plan on this account on 2026-09-08, so the plans grid had no
          // working path to payment at all. checkout.js does not use it.
          if (subscriptionId) {
            const checkoutConfig = getCurrencyConfig(checkoutCurrency);
            const opened = await openRazorpayCheckout({
              subscriptionId,
              keyId,
              currency: checkoutCurrency,
              amountLabel: `${checkoutConfig.symbol}${planPrice}`,
              // A trial's first-charge date, shown in the modal before the
              // mandate is approved.
              firstChargeAt: startAt,
              // Its answer says whether this checkout started a trial, which
              // sends the customer on to /launches instead of reloading.
              verify: async (payload) => {
                const res = await fetch('/razorpay/verify', {
                  method: 'POST',
                  body: JSON.stringify(payload),
                });
                return res.json().catch(() => ({}));
              },
              onError: (message) => {
                setLoading(false);
                setLoadingPack('');
                toast.show(message, 'warning');
              },
              onClose: () => {
                setLoading(false);
                setLoadingPack('');
              },
            });
            if (opened) {
              // Clear the spinner the moment the modal is up. It used to stay
              // spinning until Razorpay's ondismiss fired, which left the
              // button stuck if that callback did not arrive - and once the
              // modal is covering the page the spinner communicates nothing
              // anyway. The modal itself is the feedback.
              setLoading(false);
              setLoadingPack('');
              return;
            }
          }

          // checkout.js could not load. The hosted page is all that is left.
          setLoading(false);
          setLoadingPack('');
          if (url) {
            window.location.href = url;
            return;
          }
          toast.show(
            t(
              'billing_checkout_unavailable',
              'Checkout is currently unavailable. Please try again shortly.'
            ),
            'warning'
          );
          return;
        }
        // A downgrade Razorpay holds for the end of the cycle: nothing changes
        // today. The plan, its limits and the price stay as they are, and the
        // "Changes to <plan> on <date>" line (pricing context) takes over.
        if (embeddedResponse?.effectiveAt === 'cycle_end') {
          refreshPricingContext();
          toast.show(
            t(
              'billing_downgrade_scheduled',
              'Done. Your plan changes at the end of this billing cycle; until then nothing changes.'
            )
          );
          setLoading(false);
          setLoadingPack('');
          return;
        }
        // The plan was moved in place (a card mandate; see subscribe()).
        // There used to be a `portal` branch here for Stripe's customer
        // portal, which nothing on Razorpay ever returns.
        setPeriod(monthlyOrYearly === 'on' ? 'YEARLY' : 'MONTHLY');
        setSubscription((subs) => ({
          ...subs!,
          subscriptionTier: billing,
          cancelAt: null,
        }));
        mutate(
          '/user/self',
          {
            ...user,
            tier: billing,
          },
          {
            revalidate: false,
          }
        );
        // The card's "what you pay" comes from the plan; it just changed.
        refreshPricingContext();
        toast.show('Subscription updated successfully');
        setLoading(false);
        setLoadingPack('');
      },
    [monthlyOrYearly, subscription, user, utm, fetch, toast, t, currency, activePricing, appliedCoupon, startReplacementMandate, currentTierName, mutate, refreshPricingContext, offerTerms, payWith, offerShown, offerSelection, channels]
  );
  if (user?.isLifetime) {
    router.replace('/');
    return null;
  }
  // Paid on Gumroad: changed and cancelled there, never through the plan
  // cards below, which would open a Razorpay checkout next to it.
  if (subscription && isGumroadIdentifier(subscription.identifier)) {
    return <GumroadPlanPanel sub={subscription} />;
  }
  return (
    <div className="flex flex-col gap-[16px]">
      <div className="flex flex-col md:flex-row min-w-0 gap-[12px] md:gap-0 items-start md:items-center justify-between">
        <div className="flex-1 text-[20px] font-bold">{t('plans', 'Plans')}</div>
        <div className="flex items-center gap-[16px] flex-wrap">
          {/* The charged currency, from the server. No switcher. */}
          <div className="inline-flex items-center gap-[6px] rounded-full border border-customColor6 px-[12px] py-[5px] text-[13px] font-semibold text-textItemBlur">
            <span>$</span>
            <span>Prices in USD</span>
          </div>

          {/* The single plan is monthly only: the toggle is for an existing
              Standard or Pro subscriber whose plan has a yearly price. */}
          {!!(activePricing as any)[subscription?.subscriptionTier || '']?.year_price && (
          <PeriodToggle
            value={monthlyOrYearly === 'on' ? 'YEARLY' : 'MONTHLY'}
            onChange={(next) => setMonthlyOrYearly(next === 'YEARLY' ? 'on' : 'off')}
            monthlyLabel={t('monthly', 'MONTHLY')}
            yearlyLabel={t('yearly', 'YEARLY')}
            yearlyNote={yearlySaving ? `save ${yearlySaving}%` : undefined}
          />
          )}
        </div>
      </div>

      {/* The current Indian festival (holiday.offer.ts). */}
      <HolidayOfferBanner />

      <div className="text-[14px] text-textItemBlur" data-testid="charge-currency-note">
        {CHARGE_CURRENCY_NOTE}
      </div>

      {/* What is left this plan month: AI credits and X posts. */}
      <PlanUsage />

      {freePostsLine ? (
        <div role="status" data-testid="free-posts-plans-line" className="text-[16px] font-[600]">
          {freePostsLine}
        </div>
      ) : null}

      {currencyLocked ? (
        <div className="text-[14px] text-textItemBlur">{currencyLocked}</div>
      ) : null}

      {!subscription?.identifier && (
        <CouponField
          className="max-w-[420px]"
          applied={appliedCoupon}
          onChange={setAppliedCoupon}
        />
      )}

      {/* Not over a live plan billed here (planOnFileBlocksRedeem): the
          backend would refuse it with PLAN_ON_FILE. */}
      {!planOnFileBlocksRedeem(subscription) && (
        <GumroadRedeemField className="max-w-[520px]" />
      )}

      {offerDropped ? (
        <FirstMonthOfferNotApplied className="max-w-[520px]" />
      ) : offerShown && offerTerms ? (
        <FirstMonthOffer
          className="max-w-[520px]"
          terms={offerTerms}
          // Several plans are listed here, so the line names no amount.
          payWith={payWith}
          onPayWithChange={setPayWith}
        />
      ) : null}
      {upiNote ? (
        <div className="text-[14px] text-textItemBlur">{upiNote}</div>
      ) : null}

      {finishTrial && <FinishTrial close={() => setFinishTrial(false)} />}
      {/* Centred: usually the one plan, sometimes beside Free or a kept plan. */}
      <div className="flex justify-center gap-[16px] pt-[16px] [@media(max-width:1024px)]:flex-col [@media(max-width:1024px)]:items-center [@media(max-width:1024px)]:text-center">
        {Object.entries(activePricing)
          // Only tiers we still sell (PURCHASABLE_TIERS: the single plan
          // since 8 Nov 2026), plus the plan this workspace is on, so an
          // existing Standard or Pro subscriber still sees and manages it.
          .filter(
            (f) =>
              (PURCHASABLE_TIERS as readonly string[]).includes(f[0]) ||
              f[0] === subscription?.subscriptionTier
          )
          // No yearly price, no card on the Yearly view.
          .filter((f) => monthlyOrYearly !== 'on' || f[0] === 'FREE' || f[1].year_price > 0)
          .filter((f) => !isGeneral || f[0] !== 'FREE')
          .map(([name, values]) => (
            <div
              key={name}
              style={name === 'HOOKPOST' ? festive.cardStyle : undefined}
              className={clsx(
                'relative flex-1 w-full max-w-[420px] bg-sixth border border-customColor6 rounded-[12px] p-[24px] gap-[16px] flex flex-col [@media(max-width:1024px)]:items-center',
                name === 'HOOKPOST' && festive.cardClass
              )}
            >
              {/* The festival badge, lit edge and glow (holiday.offer.banner.tsx). */}
              {name === 'HOOKPOST' ? festive.decoration : null}
              <div className="text-[18px]">{name}</div>
              <PlanCardPrice
                // The one plan on sale is shown as $7 to everyone (pricing.ts
                // HOOKPOST_PRICE) and charged on the INR plan; FREE is $0.
                listPrice={
                  name === 'HOOKPOST'
                    ? HOOKPOST_PRICE.displayUsd
                    : name === 'FREE'
                    ? 0
                    : monthlyOrYearly === 'on'
                    ? values.year_price
                    : values.month_price
                }
                listCurrency={name === 'HOOKPOST' || name === 'FREE' ? 'USD' : currency}
                period={monthlyOrYearly === 'on' ? 'YEARLY' : 'MONTHLY'}
                coupon={values.month_price ? appliedCoupon : null}
                // The current plan shows what this workspace pays, which can
                // be an older price than the list one.
                paid={paidPriceFor({
                  tier: name,
                  period: monthlyOrYearly === 'on' ? 'YEARLY' : 'MONTHLY',
                  isCurrent: currentPackage === name.toUpperCase(),
                  listPrice:
                    monthlyOrYearly === 'on' ? values.year_price : values.month_price,
                  listCurrency: currency,
                  currentPlan: pricingContext?.currentPlan,
                })}
              />
              <div className="text-[14px] flex flex-col gap-[8px] items-start [@media(max-width:1024px)]:items-center">
                {currentPackage === name.toUpperCase() &&
                stillActiveUntilEnd ? (
                  <div className="gap-[3px] flex flex-col">
                    <div>
                      <Button
                        onClick={moveToCheckout('FREE', true)}
                        loading={loading && loadingPack === 'reactivate'}
                      >
                        {t(
                          'reactivate_subscription',
                          'Reactivate subscription'
                        )}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    loading={loading && loadingPack === name.toUpperCase()}
                    disabled={
                      (!!subscription?.cancelAt &&
                        name.toUpperCase() === 'FREE') ||
                      currentPackage === name.toUpperCase()
                    }
                    className={clsx(
                      subscription &&
                        name.toUpperCase() === 'FREE' &&
                        '!bg-red-500'
                    )}
                    onClick={moveToCheckout(
                      name.toUpperCase() as 'STANDARD' | 'PRO' | 'HOOKPOST'
                    )}
                  >
                    {currentPackage === name.toUpperCase()
                      ? 'Current Plan'
                      : name.toUpperCase() === 'FREE'
                      ? subscription?.cancelAt
                        ? `Downgrade on ${dayjs
                            .utc(subscription?.cancelAt)
                            .local()
                            .format('D MMM, YYYY')}`
                        : 'Cancel subscription'
                      : // @ts-ignore
                      (user?.tier === 'FREE' ||
                          user?.tier?.current === 'FREE') &&
                        user.allowTrial
                      ? t('start_trial_days_free_trial', {
                          defaultValue: 'Start {{days}}-day free trial',
                          days: knownTrialDays(user?.trialDays),
                        })
                      : subscription
                      ? t('switch_to_this_plan', 'Switch to this plan')
                      : 'Purchase'}
                  </Button>
                )}
                {subscription &&
                  currentPackage !== name.toUpperCase() &&
                  name !== 'FREE' &&
                  !!name && (
                    <Prorate
                      period={monthlyOrYearly === 'on' ? 'YEARLY' : 'MONTHLY'}
                      pack={name.toUpperCase() as 'STANDARD' | 'PRO' | 'HOOKPOST'}
                      currency={currency}
                      overage={channelsOverAllowance(
                        channels,
                        pricing[name.toUpperCase() as 'STANDARD' | 'PRO' | 'HOOKPOST']
                          ?.channel
                      )}
                    />
                  )}
              </div>
              <Features
                pack={name.toUpperCase() as 'FREE' | 'STANDARD' | 'PRO' | 'HOOKPOST'}
              />
            </div>
          ))}
      </div>
      {!!subscription?.id && (
        <div className="flex flex-wrap justify-center mt-[20px] gap-[10px] min-w-0">
          <Button
            onClick={() => setShowInvoices((open) => !open)}
            aria-expanded={showInvoices}
          >
            {showInvoices
              ? t('hide_invoices', 'Hide invoices')
              : t('invoices', 'Invoices')}
          </Button>
          {/* A plan set to end is kept with Reactivate, which asks for a
              payment method anyway. */}
          {!subscription?.isLifetime &&
            !!subscription?.identifier?.startsWith('sub_') &&
            !subscription?.cancelAt && (
              <Button
                loading={loading && loadingPack === 'payment_method'}
                onClick={() => startReplacementMandate('payment_method')}
              >
                {t('change_payment_method', 'Change payment method')}
              </Button>
            )}
          {isGeneral && !subscription?.cancelAt && (
            <Button
              className="bg-red-500"
              loading={loading && loadingPack === 'cancel'}
              onClick={moveToCheckout('FREE')}
            >
              {t('cancel_subscription_1', 'Cancel subscription')}
            </Button>
          )}
        </div>
      )}
      {showInvoices && !!subscription?.id && <BillingInvoices />}
      {/* A downgrade waiting for the end of the cycle already paid for. Only a
          downgrade ever waits: an upgrade takes effect at once. */}
      {scheduledChange && isGeneral && !subscription?.cancelAt && (
        <div
          className="text-center flex flex-col items-center gap-[8px]"
          role="status"
        >
          <div>{scheduledChangeLine(scheduledChange)}</div>
          <Button
            loading={loading && loadingPack === 'undo_downgrade'}
            onClick={undoScheduledChange}
          >
            {t('billing_keep_current_plan', 'Keep my current plan')}
          </Button>
        </div>
      )}
      {endsAt && isGeneral && (
        <div className="text-center" role="status">
          {stillActiveUntilEnd && user?.isTrailing ? (
            trialCancelledLine(endsAt, freePlan, freePlanEndsAt)
          ) : stillActiveUntilEnd ? (
            <>
              {currentTierName || t('your_plan', 'Your plan')}{' '}
              {t('is_active_until', 'is active until')}{' '}
              {endsAt.format('D MMM YYYY')}.
              <br />
              {t(
                'plan_will_not_renew',
                "It won't renew, and you won't be charged again."
              )}
            </>
          ) : freePlan && freePlanUntil(freePlanEndsAt) ? (
            `Your plan has ended and this workspace is moving to the Free plan${freePlanUntil(
              freePlanEndsAt
            )}. You won't be charged again.`
          ) : freePlan ? (
            t(
              'plan_has_ended',
              "Your plan has ended and this workspace is moving to the Free plan. You won't be charged again."
            )
          ) : (
            `Your plan has ended and this workspace is paused until you choose a plan; ${MEDIA_KEPT_LINE}. You won't be charged again.`
          )}
        </div>
      )}
      <FAQComponent />
      <div className="flex justify-center mt-[20px]">
        <LogoutComponent />
      </div>
    </div>
  );
};
