/**
 * The app under the trial policy (planState / freePlanAvailable from
 * /user/self): who sees the paywall, the Play app's plain notice, the 402
 * dialog's button, Billing's cancel copy and the admin labels.
 *   pnpm exec jest -c apps/frontend/jest.config.ts trial.gate
 */
import dayjs from 'dayjs';
import {
  showFirstBilling,
  showTwaPlanGate,
} from '@hookpost/frontend/components/layout/twa';
import { planLimitPrompt } from '@hookpost/frontend/components/layout/plan.limit.prompt';
import {
  cancelDialogCopy,
  cancelledToastCopy,
  firstDebitMayBeUnderway,
  trialCancelledLine,
} from '@hookpost/frontend/components/billing/cancel.copy';
import {
  freePlanSunsetNotice,
  planScreenOffersDelete,
} from '@hookpost/frontend/components/layout/free.plan.sunset';
import { freePlanEndDateLabel } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

const web = {
  tier: 'FREE',
  admin: false,
  isGeneral: true,
  billingEnabled: true,
  continueFree: false,
  isTwa: false,
};

describe('showFirstBilling', () => {
  it('needs_trial and locked always get the paywall, whatever hookpost_continue_free says', () => {
    for (const planState of ['needs_trial', 'locked']) {
      expect(showFirstBilling({ ...web, planState, freePlanAvailable: false })).toBe(true);
      expect(
        showFirstBilling({ ...web, planState, freePlanAvailable: false, continueFree: true })
      ).toBe(true);
    }
  });

  it('continue-free only counts where the Free plan exists', () => {
    expect(showFirstBilling({ ...web, continueFree: true, freePlanAvailable: true })).toBe(false);
    expect(showFirstBilling({ ...web, continueFree: true, freePlanAvailable: false })).toBe(true);
  });

  it('a grandfathered Free workspace keeps today’s rule, and so does an older backend without the fields', () => {
    expect(showFirstBilling({ ...web, planState: 'free', freePlanAvailable: true })).toBe(true);
    expect(showFirstBilling({ ...web, planState: 'free', freePlanAvailable: true, continueFree: true })).toBe(false);
    expect(showFirstBilling({ ...web, continueFree: true })).toBe(false);
    expect(showFirstBilling({ ...web })).toBe(true);
  });

  it('never in the Play app, never for a platform admin, never with billing off', () => {
    expect(showFirstBilling({ ...web, planState: 'needs_trial', isTwa: true })).toBe(false);
    expect(showFirstBilling({ ...web, planState: 'needs_trial', admin: true })).toBe(false);
    expect(showFirstBilling({ ...web, planState: 'needs_trial', billingEnabled: false })).toBe(false);
  });

  it('a trialing or paying workspace is never on the paywall', () => {
    expect(showFirstBilling({ ...web, tier: 'STANDARD', planState: 'trialing', freePlanAvailable: false })).toBe(false);
  });
});

describe('showFirstBilling: a new sign-up on its free posts', () => {
  it('gets the app, not the paywall, whatever else is set', () => {
    expect(showFirstBilling({ ...web, planState: 'free_posts', freePlanAvailable: false })).toBe(false);
    expect(
      showFirstBilling({ ...web, planState: 'free_posts', freePlanAvailable: false, continueFree: false })
    ).toBe(false);
  });

  it('and no Play app notice either', () => {
    expect(
      showTwaPlanGate({ admin: false, isGeneral: true, billingEnabled: true, isTwa: true, planState: 'free_posts' })
    ).toBe(false);
  });
});

describe('showTwaPlanGate (Play app)', () => {
  const twa = { admin: false, isGeneral: true, billingEnabled: true, isTwa: true };
  it('needs_trial or locked: the unlinked notice instead of the app', () => {
    expect(showTwaPlanGate({ ...twa, planState: 'needs_trial' })).toBe(true);
    expect(showTwaPlanGate({ ...twa, planState: 'locked' })).toBe(true);
  });
  it('everyone else uses the app as before', () => {
    expect(showTwaPlanGate({ ...twa, planState: 'free' })).toBe(false);
    expect(showTwaPlanGate({ ...twa, planState: 'trialing' })).toBe(false);
    expect(showTwaPlanGate({ ...twa })).toBe(false);
    expect(showTwaPlanGate({ ...twa, planState: 'needs_trial', isTwa: false })).toBe(false);
    expect(showTwaPlanGate({ ...twa, planState: 'needs_trial', admin: true })).toBe(false);
  });
});

describe('planLimitPrompt (the 402 dialog)', () => {
  it('TRIAL_REQUIRED offers the trial', () => {
    expect(
      planLimitPrompt({ code: 'TRIAL_REQUIRED', message: 'Start your 3-day trial to schedule and publish posts.' })
    ).toEqual({
      message: 'Start your 3-day trial to schedule and publish posts.',
      button: 'Start 3-day trial',
      title: 'Start your trial',
    });
  });
  it('FREE_POSTS_USED: the free posts are used, the button opens the plans', () => {
    expect(
      planLimitPrompt({
        code: 'FREE_POSTS_USED',
        message: "You've used your 3 free posts. Pick a plan to keep posting.",
      })
    ).toEqual({
      message: "You've used your 3 free posts. Pick a plan to keep posting.",
      button: 'See plans',
      title: 'Pick a plan to keep posting',
    });
    expect(planLimitPrompt({ code: 'FREE_POSTS_USED' }).button).toBe('See plans');
  });
  it('FREE_POSTS_USED for a channel used in another workspace: the same dialog says why', () => {
    const message =
      'This Instagram account already used its free posts in another Hookpost workspace. Pick a plan to keep posting.';
    expect(planLimitPrompt({ code: 'FREE_POSTS_USED', message })).toEqual({
      message,
      button: 'See plans',
      title: 'Pick a plan to keep posting',
    });
  });

  it('PLAN_REQUIRED offers plans', () => {
    expect(planLimitPrompt({ code: 'PLAN_REQUIRED' })).toMatchObject({
      message: 'Choose a plan to continue.',
      button: 'Choose a plan',
    });
  });
  it('a Free plan limit is unchanged', () => {
    expect(planLimitPrompt({ message: 'x', trial: true })).toEqual({
      message: 'x',
      button: 'Start 3-day free trial',
      title: 'Upgrade to keep going',
    });
    expect(planLimitPrompt({}).button).toBe('See plans');
  });
  it('a workspace the sunset email promised 7 days: the 402 body says 7, so do the buttons', () => {
    expect(
      planLimitPrompt({ code: 'TRIAL_REQUIRED', message: 'Start your 7-day trial to schedule and publish posts.', trialDays: 7 })
    ).toEqual({
      message: 'Start your 7-day trial to schedule and publish posts.',
      button: 'Start 7-day trial',
      title: 'Start your trial',
    });
    expect(planLimitPrompt({ code: 'TRIAL_REQUIRED', trialDays: 7 }).message).toBe(
      'Start your 7-day trial to schedule and publish posts.'
    );
    expect(planLimitPrompt({ message: 'x', trial: true, trialDays: 7 }).button).toBe('Start 7-day free trial');
    // An older backend sends no trialDays, or a bad one: TRIAL_DAYS.
    expect(planLimitPrompt({ message: 'x', trial: true, trialDays: 'abc' }).button).toBe('Start 3-day free trial');
  });
});

describe('Billing’s cancel copy', () => {
  const until = dayjs().add(5, 'day');
  const date = until.format('D MMM YYYY');

  it('the toast for a cancelled trial: no charge, access until the date, then Free or paused', () => {
    expect(cancelledToastCopy({ cancelAt: until.toISOString(), isTrial: true, freePlan: false })).toBe(
      `Trial cancelled. No charge. Access until ${date}, then the workspace pauses.`
    );
    expect(cancelledToastCopy({ cancelAt: until.toISOString(), isTrial: true, freePlan: true })).toBe(
      `Trial cancelled. No charge. Access until ${date}, then moves to the Free plan.`
    );
    expect(trialCancelledLine(until, false)).toBe(
      `Trial cancelled. No charge. Access until ${date}, then the workspace pauses.`
    );
  });

  it('a paid plan’s toast is unchanged; one that ends now says Free or paused', () => {
    expect(
      cancelledToastCopy({ cancelAt: until.toISOString(), isTrial: false, freePlan: true, tierName: 'Pro' })
    ).toBe(`Cancelled. Pro stays active until ${date}, and you won't be charged again.`);
    expect(cancelledToastCopy({ cancelAt: new Date().toISOString(), isTrial: false, freePlan: true })).toBe(
      "Cancelled. This workspace moves to the Free plan, and you won't be charged again."
    );
    expect(cancelledToastCopy({ cancelAt: new Date().toISOString(), isTrial: false, freePlan: false })).toBe(
      "Cancelled. The workspace is paused until you choose a plan, and you won't be charged again."
    );
  });

  it('the confirm dialog for a trial with its date says access continues and nothing is charged', () => {
    expect(
      cancelDialogCopy({ isTrial: true, trialEndsAt: until.toISOString(), freePlan: false })
    ).toBe(
      `Your trial is cancelled now and you won't be charged. You keep access until ${date}, then the workspace pauses.`
    );
    // Without a date (its first charge is already being retried): it ends now.
    expect(cancelDialogCopy({ isTrial: true, trialEndsAt: null, freePlan: true })).toBe(
      "Your free trial ends now and this workspace moves to the Free plan. You won't be charged."
    );
    expect(cancelDialogCopy({ isTrial: false, freePlan: false, tierName: 'Standard' })).toContain(
      'then the workspace pauses'
    );
    expect(cancelDialogCopy({ isTrial: false, freePlan: true, tierName: 'Standard' })).toBe(
      "You keep Standard until the end of the period you've paid for, then this workspace moves to the Free plan. You won't be charged again."
    );
  });

  it('the confirm dialog for a refunded plan says it ends now, never the end of the period', () => {
    expect(
      cancelDialogCopy({ isTrial: false, freePlan: true, tierName: 'Standard', refunded: true })
    ).toBe(
      "Your payment was refunded, so Standard ends now and this workspace moves to the Free plan. You won't be charged again."
    );
    const paused = cancelDialogCopy({ isTrial: false, freePlan: false, tierName: 'Standard', refunded: true });
    expect(paused).toBe(
      "Your payment was refunded, so Standard ends now and the workspace pauses; your channels and posts are kept, and their media files for 30 days. You won't be charged again."
    );
    expect(paused).not.toContain("the end of the period you've paid for");
  });
});

describe('Billing’s cancel copy while FREE_PLAN_SUNSET_AT is ahead (freePlanSunsetAt)', () => {
  const until = dayjs().add(5, 'day');
  const date = until.format('D MMM YYYY');
  const later = dayjs().add(10, 'day'); // the trial ends first
  const sooner = dayjs().add(2, 'day'); // the trial runs past it
  const label = (d: dayjs.Dayjs) => freePlanEndDateLabel(d.toDate());

  it('a trial that ends before it: Free until that date, then paused', () => {
    const p = { cancelAt: until.toISOString(), isTrial: true, freePlan: true, freePlanEndsAt: later.toISOString() };
    const then = `then moves to the Free plan until ${label(later)}, when the Free plan ends and the workspace pauses`;
    expect(cancelledToastCopy(p)).toBe(`Trial cancelled. No charge. Access until ${date}, ${then}.`);
    expect(trialCancelledLine(until, true, later.toISOString())).toBe(
      `Trial cancelled. No charge. Access until ${date}, ${then}.`
    );
    expect(
      cancelDialogCopy({ isTrial: true, trialEndsAt: until.toISOString(), freePlan: true, freePlanEndsAt: later.toISOString() })
    ).toContain(then);
  });

  it('a trial that runs past it: paused, never "moves to the Free plan"', () => {
    const p = { cancelAt: until.toISOString(), isTrial: true, freePlan: true, freePlanEndsAt: sooner.toISOString() };
    const then = `then the workspace pauses, as the Free plan ends on ${label(sooner)}`;
    expect(cancelledToastCopy(p)).toBe(`Trial cancelled. No charge. Access until ${date}, ${then}.`);
    expect(trialCancelledLine(until, true, sooner.toISOString())).not.toMatch(/moves to the Free plan/);
    expect(
      cancelDialogCopy({ isTrial: true, trialEndsAt: until.toISOString(), freePlan: true, freePlanEndsAt: sooner.toISOString() })
    ).not.toMatch(/moves to the Free plan/);
  });

  it('a paid plan, whose period end the dialog does not know, names both outcomes', () => {
    expect(
      cancelDialogCopy({ isTrial: false, freePlan: true, tierName: 'Standard', freePlanEndsAt: later.toISOString() })
    ).toBe(
      `You keep Standard until the end of the period you've paid for, then the workspace pauses (if your period ends before ${label(
        later
      )}, it is on the Free plan until then); your channels and posts are kept, and their media files for 30 days. You won't be charged again.`
    );
  });

  it('ending now: Free until the date', () => {
    expect(
      cancelledToastCopy({ cancelAt: new Date().toISOString(), isTrial: false, freePlan: true, freePlanEndsAt: later.toISOString() })
    ).toBe(
      `Cancelled. This workspace moves to the Free plan until ${label(
        later
      )}, when the Free plan ends and the workspace pauses, and you won't be charged again.`
    );
    expect(cancelDialogCopy({ isTrial: true, trialEndsAt: null, freePlan: true, freePlanEndsAt: later.toISOString() })).toContain(
      `moves to the Free plan until ${label(later)}`
    );
  });

  it('a date already past, or none, is today’s copy; the new cohort still pauses', () => {
    const past = dayjs().subtract(1, 'day').toISOString();
    for (const freePlanEndsAt of [null, undefined, past, 'garbage']) {
      expect(cancelledToastCopy({ cancelAt: until.toISOString(), isTrial: true, freePlan: true, freePlanEndsAt })).toBe(
        `Trial cancelled. No charge. Access until ${date}, then moves to the Free plan.`
      );
    }
    expect(
      cancelledToastCopy({ cancelAt: until.toISOString(), isTrial: true, freePlan: false, freePlanEndsAt: later.toISOString() })
    ).toBe(`Trial cancelled. No charge. Access until ${date}, then the workspace pauses.`);
  });
});

// Inside the last day before a trial's first charge the bank may already
// have the debit, so cancelling cannot promise "no charge" (the backend
// refuses a plan switch then too).
describe('cancelling a trial within a day of its first charge', () => {
  const soon = dayjs().add(12, 'hour');
  const date = soon.format('D MMM YYYY');
  const late =
    'Your bank may already have started the first debit; if it goes through, we refund it in full.';

  it('the dialog, the toast and the status line say the debit may go through, refunded in full', () => {
    const dialog = cancelDialogCopy({ isTrial: true, trialEndsAt: soon.toISOString(), freePlan: false });
    expect(dialog).toBe(
      `Your trial is cancelled now. ${late} You keep access until ${date}, then the workspace pauses.`
    );
    const toast = cancelledToastCopy({ cancelAt: soon.toISOString(), isTrial: true, freePlan: true });
    expect(toast).toBe(`Trial cancelled. ${late} Access until ${date}, then moves to the Free plan.`);
    const line = trialCancelledLine(soon, false);
    expect(line).toBe(
      `Trial cancelled. Access until ${date}, then the workspace pauses. If a first debit your bank had already started goes through, we refund it in full.`
    );
    for (const text of [dialog, toast, line]) {
      expect(text).not.toMatch(/no charge|won't be charged/i);
    }
  });

  it('just over a day out it still says no charge', () => {
    const later = dayjs().add(25, 'hour');
    expect(cancelledToastCopy({ cancelAt: later.toISOString(), isTrial: true, freePlan: false })).toContain(
      'No charge.'
    );
    expect(firstDebitMayBeUnderway(later)).toBe(false);
    expect(firstDebitMayBeUnderway(soon)).toBe(true);
  });

  it('a paid plan’s copy is not affected', () => {
    expect(
      cancelledToastCopy({ cancelAt: soon.toISOString(), isTrial: false, freePlan: true, tierName: 'Pro' })
    ).toBe(`Cancelled. Pro stays active until ${date}, and you won't be charged again.`);
  });
});

// The admin page's billing badges: apps/frontend/src/components/admin/billing.badge.spec.ts.

describe('freePlanSunsetNotice (FREE_PLAN_SUNSET_AT ahead, grandfathered Free)', () => {
  const ENDS = '2026-10-27T18:29:59.000Z';
  const owner = { planState: 'free', freePlanEndsAt: ENDS, allowTrial: true, role: 'SUPERADMIN', isTwa: false };

  it('the date, the trial and Delete Account', () => {
    expect(freePlanSunsetNotice(owner)).toEqual({
      message: 'Your Free plan ends on 27 October 2026. Start your 3-day trial to keep posting, or delete your account.',
      trialLabel: 'Start 3-day trial',
    });
  });

  it('a workspace the sunset email promised 7 days (trialDays 7) is told 7, not 3', () => {
    expect(freePlanSunsetNotice({ ...owner, trialDays: 7 })).toEqual({
      message: 'Your Free plan ends on 27 October 2026. Start your 7-day trial to keep posting, or delete your account.',
      trialLabel: 'Start 7-day trial',
    });
    expect(freePlanSunsetNotice({ ...owner, trialDays: null })?.trialLabel).toBe('Start 3-day trial');
  });

  it('trial already used: choose a plan', () => {
    expect(freePlanSunsetNotice({ ...owner, allowTrial: false })).toEqual({
      message: 'Your Free plan ends on 27 October 2026. Choose a plan to keep posting, or delete your account.',
      trialLabel: 'Choose a plan',
    });
  });

  it('a member, who cannot reach Billing, reads it without the button', () => {
    expect(freePlanSunsetNotice({ ...owner, role: 'USER' })?.trialLabel).toBeNull();
  });

  it('in the Play app: the date and the plain plan line only, no trial', () => {
    const n = freePlanSunsetNotice({ ...owner, isTwa: true })!;
    expect(n.trialLabel).toBeNull();
    expect(n.message).toBe('Your Free plan ends on 27 October 2026. Manage your plan on hookpost.hookstep.in.');
    expect(n.message).not.toMatch(/trial|₹|\$/i);
  });

  it('nothing without a date (unset, exempt, passed, older backend) or off the Free plan', () => {
    expect(freePlanSunsetNotice({ ...owner, freePlanEndsAt: null })).toBeNull();
    expect(freePlanSunsetNotice({ ...owner, freePlanEndsAt: undefined })).toBeNull();
    expect(freePlanSunsetNotice({ ...owner, freePlanEndsAt: 'garbage' })).toBeNull();
    for (const planState of ['needs_trial', 'locked', 'trialing', 'active', undefined]) {
      expect(freePlanSunsetNotice({ ...owner, planState })).toBeNull();
    }
  });
});

describe('planScreenOffersDelete: Delete Account on the plans screen at every width', () => {
  it('whenever the workspace must start its trial or choose a plan, and while a Free plan end date is ahead', () => {
    expect(planScreenOffersDelete({ planState: 'needs_trial' })).toBe(true);
    expect(planScreenOffersDelete({ planState: 'locked' })).toBe(true);
    expect(planScreenOffersDelete({ planState: 'free', freePlanEndsAt: '2026-10-27T18:29:59.000Z' })).toBe(true);
  });

  it('not for an ordinary Free workspace (its FAQ keeps the desktop entry) or a plan', () => {
    for (const planState of ['free', 'trialing', 'active', 'cancelling', undefined]) {
      expect(planScreenOffersDelete({ planState, freePlanEndsAt: null })).toBe(false);
    }
  });
});
