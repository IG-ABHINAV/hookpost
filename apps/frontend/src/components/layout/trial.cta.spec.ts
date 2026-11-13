/**
 * What a workspace without a plan is told, and where its buttons go: the
 * strip over the app and the connect step, the composer's main button, the
 * OAuth consent page after an AI client is linked, and the plan gates for an
 * impersonating admin.
 *   pnpm exec jest -c apps/frontend/jest.config.ts trial.cta
 */
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';

const mockTwa = { current: false };
jest.mock('@hookpost/frontend/components/layout/twa.component', () => ({
  useIsTwa: () => mockTwa.current,
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('react').createElement('a', { href, ...rest }, children),
}));

import {
  connectorTrialHref,
  connectorTrialNotice,
  freePostsCounter,
  freePostsPlansLine,
  skipsPlanGates,
  TRIAL_CTA_HREF,
  trialRequiredCta,
} from '@hookpost/frontend/components/layout/trial.cta';
import { UserContext } from '@hookpost/frontend/components/layout/user.context';
import {
  FreePostsCounter,
  TrialRequiredBanner,
} from '@hookpost/frontend/components/layout/trial.required.banner';
import { showFirstBilling, showTwaPlanGate } from '@hookpost/frontend/components/layout/twa';

const owner = { role: 'SUPERADMIN', isTwa: false, allowTrial: true, trialDays: 3 };

describe('trialRequiredCta', () => {
  it('needs_trial: the trial, its length, and the composer button', () => {
    expect(trialRequiredCta({ ...owner, planState: 'needs_trial' })).toEqual({
      message: 'Start your 3-day trial to publish posts.',
      label: 'Start free trial',
      scheduleLabel: 'Start trial to schedule',
    });
    expect(trialRequiredCta({ ...owner, planState: 'needs_trial', trialDays: 7 })?.message).toBe(
      'Start your 7-day trial to publish posts.'
    );
    // An older backend without trialDays: TRIAL_DAYS.
    expect(trialRequiredCta({ ...owner, planState: 'needs_trial', trialDays: undefined })?.message).toBe(
      'Start your 3-day trial to publish posts.'
    );
  });

  it('locked (trial used): a plan, not a trial', () => {
    expect(trialRequiredCta({ ...owner, planState: 'locked', allowTrial: false })).toEqual({
      message: 'Choose a plan to publish posts.',
      label: 'Choose a plan',
      scheduleLabel: 'Choose a plan to schedule',
    });
  });

  it('a workspace ADMIN gets the button; a member is told to ask, with no button', () => {
    expect(trialRequiredCta({ ...owner, role: 'ADMIN', planState: 'needs_trial' })?.label).toBe('Start free trial');
    const member = trialRequiredCta({ ...owner, role: 'USER', planState: 'needs_trial' });
    expect(member).toMatchObject({ label: null, scheduleLabel: null });
    expect(member?.message).toMatch(/Ask a workspace admin to start it/);
  });

  it.each(['trialing', 'active', 'cancelling', 'dunning', 'free', undefined, null])(
    '%s: nothing (a plan, a trial or the Free plan)',
    (planState) => {
      expect(trialRequiredCta({ ...owner, planState })).toBeNull();
    }
  );

  it('the Play app sells nothing: nothing', () => {
    expect(trialRequiredCta({ ...owner, isTwa: true, planState: 'needs_trial' })).toBeNull();
  });

  it('every button goes to the paywall', () => {
    expect(TRIAL_CTA_HREF).toBe('/billing');
  });
});

describe('skipsPlanGates (impersonation shows what the customer sees)', () => {
  it('only a platform admin in their own workspace skips the gates', () => {
    expect(skipsPlanGates({ admin: true, impersonate: false })).toBe(true);
    expect(skipsPlanGates({ admin: true, impersonate: true })).toBe(false);
    expect(skipsPlanGates({ admin: false, impersonate: false })).toBe(false);
    expect(skipsPlanGates(undefined)).toBe(false);
  });

  it('an admin impersonating a needs_trial workspace gets the paywall, as the customer does', () => {
    const base = { isGeneral: true, billingEnabled: true, continueFree: false, isTwa: false, planState: 'needs_trial', tier: 'FREE' };
    const customer = showFirstBilling({ ...base, admin: skipsPlanGates({ admin: false, impersonate: false }) });
    const impersonating = showFirstBilling({ ...base, admin: skipsPlanGates({ admin: true, impersonate: true }) });
    expect(customer).toBe(true);
    expect(impersonating).toBe(customer);
    // Before: admin: true went straight to the app.
    expect(showFirstBilling({ ...base, admin: true })).toBe(false);
    // The Play app's gate too.
    expect(
      showTwaPlanGate({ isGeneral: true, billingEnabled: true, isTwa: true, planState: 'locked', admin: skipsPlanGates({ admin: true, impersonate: true }) })
    ).toBe(true);
  });
});

describe('connectorTrialNotice (OAuth consent, after Authorize)', () => {
  it('needs_trial: linked, what the trial is for, the trial button and the way back', () => {
    expect(connectorTrialNotice({ ...owner, planState: 'needs_trial', appName: 'Claude' })).toEqual({
      title: 'Your connector is linked',
      message:
        "Claude is connected to Hookpost. Start your 3-day trial so Claude can publish. Until then it can't schedule or post anything.",
      label: 'Start free trial',
      continueLabel: 'Continue to Claude',
    });
  });

  it('locked: a plan; a member: no button, ask an admin', () => {
    expect(connectorTrialNotice({ ...owner, planState: 'locked', allowTrial: false, appName: 'ChatGPT' })?.message).toMatch(
      /^ChatGPT is connected to Hookpost\. Choose a plan so ChatGPT can publish\./
    );
    const member = connectorTrialNotice({ ...owner, role: 'USER', planState: 'needs_trial', appName: 'Claude' });
    expect(member?.label).toBeNull();
    expect(member?.message).toBe('Claude is connected to Hookpost. It can publish once a workspace admin starts the trial.');
  });

  it('no app name: a neutral one', () => {
    expect(connectorTrialNotice({ ...owner, planState: 'needs_trial', appName: '  ' })?.continueLabel).toBe(
      'Continue to Your AI assistant'
    );
  });

  it('a workspace with a plan or a trial, or the Play app: no card, the redirect goes at once', () => {
    expect(connectorTrialNotice({ ...owner, planState: 'active', appName: 'Claude' })).toBeNull();
    expect(connectorTrialNotice({ ...owner, planState: 'trialing', appName: 'Claude' })).toBeNull();
    expect(connectorTrialNotice({ ...owner, isTwa: true, planState: 'needs_trial', appName: 'Claude' })).toBeNull();
  });

  it('the trial link is the paywall, tagged', () => {
    expect(connectorTrialHref()).toBe('/billing?utm_source=oauth_connect');
  });
});

describe('TrialRequiredBanner', () => {
  const renderWith = (user: Record<string, any>) =>
    render(
      createElement(
        UserContext.Provider,
        { value: user as any },
        createElement(TrialRequiredBanner)
      )
    );

  beforeEach(() => {
    mockTwa.current = false;
  });

  it('no plan: the sentence and a Start free trial link to the paywall, with no close button', () => {
    renderWith({ planState: 'needs_trial', allowTrial: true, role: 'SUPERADMIN', trialDays: 3 });
    const banner = screen.getByTestId('trial-required-banner');
    expect(banner.textContent).toContain('Start your 3-day trial to publish posts.');
    const link = screen.getByRole('link', { name: 'Start free trial' });
    expect(link.getAttribute('href')).toBe('/billing');
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('an active plan or a trial: nothing', () => {
    for (const planState of ['active', 'trialing', 'free']) {
      const { container, unmount } = renderWith({ planState, allowTrial: true, role: 'SUPERADMIN' });
      expect(container.innerHTML).toBe('');
      unmount();
    }
  });

  it('in the Play app: nothing', () => {
    mockTwa.current = true;
    const { container } = renderWith({ planState: 'needs_trial', allowTrial: true, role: 'SUPERADMIN' });
    expect(container.innerHTML).toBe('');
  });

  it('a member: the sentence without a button', () => {
    renderWith({ planState: 'needs_trial', allowTrial: true, role: 'USER' });
    expect(screen.getByTestId('trial-required-banner').textContent).toMatch(/Ask a workspace admin/);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

// 28 Oct 2026: a new sign-up gets FREE_POST_LIMIT free posts and the app, with
// a small counter; the plans come when they are used, 20% off the first month
// where the checkout carries the offer.
describe('free posts: the counter and the plans line', () => {
  const allowance = (used: number) => ({ used, limit: 3, left: Math.max(0, 3 - used) });
  const owner = { planState: 'free_posts', role: 'SUPERADMIN', isTwa: false };

  it.each([
    [0, '3 of 3 free posts left'],
    [1, '2 of 3 free posts left'],
    [2, '1 of 3 free posts left'],
  ])('%i used: "%s · Upgrade"', (used, message) => {
    expect(freePostsCounter({ ...owner, freePosts: allowance(used) })).toEqual({
      message,
      label: 'Upgrade',
      usedUp: false,
    });
  });

  it('all used: says so, and Upgrade is still there', () => {
    expect(freePostsCounter({ ...owner, freePosts: allowance(3) })).toEqual({
      message: "You've used your 3 free posts",
      label: 'Upgrade',
      usedUp: true,
    });
  });

  it('a member, or the Play app: the count without the button', () => {
    expect(freePostsCounter({ ...owner, role: 'USER', freePosts: allowance(1) })?.label).toBeNull();
    expect(freePostsCounter({ ...owner, isTwa: true, freePosts: allowance(1) })?.label).toBeNull();
  });

  it('nothing for any other state, or an older backend without the field', () => {
    for (const planState of ['free', 'needs_trial', 'locked', 'trialing', 'active']) {
      expect(freePostsCounter({ ...owner, planState, freePosts: allowance(1) })).toBeNull();
    }
    expect(freePostsCounter({ ...owner, freePosts: null })).toBeNull();
    expect(freePostsCounter({ ...owner })).toBeNull();
  });

  it('the plans line names the offer only when the checkout carries it', () => {
    expect(freePostsPlansLine(allowance(3), 20)).toBe(
      "You've used your 3 free posts. Pick a plan to keep posting — first month 20% off (new customers)."
    );
    expect(freePostsPlansLine(allowance(3), null)).toBe(
      "You've used your 3 free posts. Pick a plan to keep posting."
    );
    expect(freePostsPlansLine(allowance(1), 20)).toBe(
      "2 of 3 free posts left. Pick a plan whenever you're ready — first month 20% off (new customers)."
    );
    expect(freePostsPlansLine(null, 20)).toBeNull();
  });

  it('renders "2 of 3 free posts left · Upgrade" linking to the plans', () => {
    mockTwa.current = false;
    render(
      createElement(
        UserContext.Provider,
        { value: { ...owner, freePosts: allowance(1) } as any },
        createElement(FreePostsCounter)
      )
    );
    const counter = screen.getByTestId('free-posts-counter');
    expect(counter.textContent).toBe('2 of 3 free posts left·Upgrade');
    expect(screen.getByText('Upgrade').getAttribute('href')).toBe(TRIAL_CTA_HREF);
  });

  it('the trial strip stays away from a workspace on its free posts', () => {
    expect(trialRequiredCta({ ...owner, allowTrial: false })).toBeNull();
  });
});
