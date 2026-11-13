import 'reflect-metadata';

// GET /user/self under the trial policy: planState, freePlanAvailable and
// trialEndsAt, tier still FREE for a workspace without a plan, and no public
// API key where MCP and the public API are refused.
//   pnpm exec jest -c apps/backend/jest.config.ts users.controller.self

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/services/razorpay.service', () => ({
  RazorpayService: class {},
}));
jest.mock('@hookpost/backend/services/auth/auth.service', () => ({
  AuthService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/database/prisma/users/users.service', () => ({
  UsersService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/track/track.service', () => ({
  TrackService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service',
  () => ({ AffiliateService: class {} })
);

import { UsersController } from '@hookpost/backend/api/routes/users.controller';
import { checkoutAllowsTrial } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

const ORG = {
  id: 'org',
  apiKey: 'api-key-1',
  isTrailing: true,
  allowTrial: true,
  subscription: null as any,
  users: [{ role: 'SUPERADMIN' }],
};

function self(
  state: string,
  freePlanAvailable: boolean,
  org: any = ORG,
  skipsPlans = false,
  freePlanEndsAt: Date | null = null,
  freePlanSunsetAt: Date | null = freePlanEndsAt,
  // SubscriptionService.trialUsedByPerson's answer for this workspace.
  personHadTrial = false
) {
  const getPlanState = jest.fn(async () => ({ state, freePlanAvailable, freePlanEndsAt, freePlanSunsetAt }));
  const trialEndsAt = jest.fn(async () => new Date('2026-10-29T06:00:00Z'));
  const skipsPlansScreen = jest.fn(async () => skipsPlans);
  const markOnline = jest.fn(async () => undefined);
  const controller = new UsersController(
    {
      getPlanState,
      // The real rule (trial.policy.ts) plus the once-per-person answer,
      // as SubscriptionService.checkoutAllowsTrial combines them.
      checkoutAllowsTrial: jest.fn(
        async (_org: string, allowTrial: boolean, _hints: any, opts: any) =>
          checkoutAllowsTrial(opts.state, allowTrial) &&
          !(opts.state === 'free_posts' && personHadTrial)
      ),
      trialDaysFor: jest.fn(async (_org: string, base: number = 3) => base),
      freePostsUsage: jest.fn(async () => ({ keys: new Set(['a', 'b']), used: 2, limit: 3, left: 1 })),
    } as any,
    { trialEndsAt } as any,
    {} as any,
    { getStreakStart: jest.fn(async () => null), skipsPlansScreen } as any,
    { markOnline } as any,
    {} as any,
    { attribute: jest.fn() } as any,
    {} as any
  );
  const req: any = { cookies: {}, headers: { 'cf-ipcountry': 'IN' } };
  return {
    run: () => controller.getSelf({ id: 'user-1', email: 'a@b.c' } as any, org, req),
    req,
    getPlanState,
    trialEndsAt,
    skipsPlansScreen,
    markOnline,
  };
}

const ENV = { ...process.env };
beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_unit';
});
afterAll(() => {
  process.env = ENV;
});

describe('GET /user/self', () => {
  it('needs_trial: tier FREE, planState and no Free plan, no API key', async () => {
    const { run, getPlanState, trialEndsAt } = self('needs_trial', false);
    const res: any = await run();
    expect(res).toMatchObject({
      tier: 'FREE',
      planState: 'needs_trial',
      freePlanAvailable: false,
      trialEndsAt: null,
      publicApi: '',
    });
    expect(getPlanState).toHaveBeenCalledWith('org', { requestCountry: 'IN' });
    expect(trialEndsAt).not.toHaveBeenCalled();
  });

  it('freePlanEndsAt: the sunset date as ISO for a grandfathered Free workspace, else null', async () => {
    const ahead = await self('free', true, ORG, false, new Date('2026-10-27T18:29:59Z')).run();
    expect((ahead as any).freePlanEndsAt).toBe('2026-10-27T18:29:59.000Z');
    expect(((await self('free', true).run()) as any).freePlanEndsAt).toBeNull();
    expect(((await self('needs_trial', false).run()) as any).freePlanEndsAt).toBeNull();
  });

  it('freePlanSunsetAt: the same date for a workspace with a plan, for Billing’s cancel copy', async () => {
    const paid = await self('active', true, ORG, false, null, new Date('2026-10-27T18:29:59Z')).run();
    expect((paid as any).freePlanEndsAt).toBeNull();
    expect((paid as any).freePlanSunsetAt).toBe('2026-10-27T18:29:59.000Z');
    expect(((await self('active', true).run()) as any).freePlanSunsetAt).toBeNull();
  });

  // 25 Oct 2026: the layout shows the connect step before the paywall while
  // a needs_trial workspace has room (PRE_TRIAL_CHANNEL_LIMIT).
  it('preTrialChannelLimit: 1 for needs_trial, null for every other state', async () => {
    expect(((await self('needs_trial', false).run()) as any).preTrialChannelLimit).toBe(1);
    for (const state of ['free', 'locked', 'trialing', 'active', 'cancelling', 'dunning']) {
      const res: any = await self(state as any, state === 'free').run();
      expect([state, res.preTrialChannelLimit]).toEqual([state, null]);
    }
  });

  it('locked: no API key either', async () => {
    const res: any = await self('locked', false).run();
    expect(res).toMatchObject({ planState: 'locked', publicApi: '' });
  });

  it('a grandfathered Free workspace keeps its API key (MCP stays on)', async () => {
    const res: any = await self('free', true).run();
    expect(res).toMatchObject({ tier: 'FREE', planState: 'free', freePlanAvailable: true, publicApi: 'api-key-1' });
  });

  it('trialing: the date the first charge is due', async () => {
    const org = { ...ORG, subscription: { subscriptionTier: 'STANDARD', totalChannels: 5 } };
    const res: any = await self('trialing', false, org).run();
    expect(res).toMatchObject({ tier: 'STANDARD', planState: 'trialing', publicApi: 'api-key-1' });
    expect(res.trialEndsAt).toEqual(new Date('2026-10-29T06:00:00Z'));
  });

  it('trialPolicyActive follows the cutoffs, not the workspace (PR-3 copy switch)', async () => {
    const saved = {
      IN: process.env.TRIAL_REQUIRED_SINCE_IN,
      GLOBAL: process.env.TRIAL_REQUIRED_SINCE_GLOBAL,
    };
    try {
      process.env.TRIAL_REQUIRED_SINCE_IN = '';
      process.env.TRIAL_REQUIRED_SINCE_GLOBAL = '';
      expect(await self('free', true).run()).toMatchObject({ trialPolicyActive: false });

      process.env.TRIAL_REQUIRED_SINCE_IN = '2026-10-20T05:30:00Z';
      // A grandfathered Free workspace still reads true: the wording is global.
      expect(await self('free', true).run()).toMatchObject({ trialPolicyActive: true });

      // A typo fails open, as it does for the gate (and is logged once).
      process.env.TRIAL_REQUIRED_SINCE_IN = '2026-13-01';
      const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await self('free', true).run()).toMatchObject({ trialPolicyActive: false });
      log.mockRestore();
    } finally {
      process.env.TRIAL_REQUIRED_SINCE_IN = saved.IN;
      process.env.TRIAL_REQUIRED_SINCE_GLOBAL = saved.GLOBAL;
      if (saved.IN === undefined) delete process.env.TRIAL_REQUIRED_SINCE_IN;
      if (saved.GLOBAL === undefined) delete process.env.TRIAL_REQUIRED_SINCE_GLOBAL;
    }
  });

  it('a paid plan set to end (not a trial) has no trial date', async () => {
    const org = { ...ORG, isTrailing: false, subscription: { subscriptionTier: 'PRO', totalChannels: 30 } };
    const { run, trialEndsAt } = self('cancelling', true, org);
    const res: any = await run();
    expect(res.trialEndsAt).toBeNull();
    expect(trialEndsAt).not.toHaveBeenCalled();
  });
});

describe('GET /user/self for a new sign-up on its free posts (free_posts)', () => {
  afterEach(() => {
    delete process.env.TRIAL_CHECKOUT;
  });

  it('gets the app: its allowance, no trial to start (checkout charges at once), its API key', async () => {
    process.env.TRIAL_CHECKOUT = 'off';
    const { run } = self('free_posts', false);
    const res: any = await run();
    expect(res).toMatchObject({
      tier: 'FREE',
      planState: 'free_posts',
      freePosts: { used: 2, limit: 3, left: 1 },
      allowTrial: false,
      trialDays: 3,
      preTrialChannelLimit: null,
      continueFree: false,
      publicApi: 'api-key-1',
    });
    // The Set stays on the server.
    expect(res.freePosts.keys).toBeUndefined();
  });

  it('with the trial switch on: the trial is offered (allowTrial, its length), the allowance stays', async () => {
    process.env.TRIAL_CHECKOUT = 'on';
    const res: any = await self('free_posts', false).run();
    expect(res).toMatchObject({
      planState: 'free_posts',
      freePosts: { used: 2, limit: 3, left: 1 },
      allowTrial: true,
      trialDays: 3,
    });
  });

  it('with the switch on, not to a person who has had a trial elsewhere', async () => {
    process.env.TRIAL_CHECKOUT = 'on';
    const res: any = await self('free_posts', false, ORG, false, null, null, true).run();
    expect(res.allowTrial).toBe(false);
  });

  it('every other state has no allowance, and allowTrial as on file', async () => {
    for (const state of ['free', 'needs_trial', 'trialing', 'active']) {
      const res: any = await self(state, state === 'free').run();
      expect(res.freePosts).toBeNull();
      expect(res.allowTrial).toBe(true);
    }
    // Locked with allowTrial left true is a disputed workspace: no trial with
    // the switch on; off, as before.
    const locked: any = await self('locked', false).run();
    expect(locked.freePosts).toBeNull();
    expect(locked.allowTrial).toBe(process.env.TRIAL_CHECKOUT !== 'on');
  });
});

describe('GET /user/self continueFree (the plans screen on a new device)', () => {
  it('a Free workspace that chose Free, or has a channel or a post, skips the plans screen', async () => {
    const { run, skipsPlansScreen } = self('free', true, ORG, true);
    expect(await run()).toMatchObject({ continueFree: true });
    expect(skipsPlansScreen).toHaveBeenCalledWith('org');
  });

  it('a new Free workspace still gets it', async () => {
    expect(await self('free', true, ORG, false).run()).toMatchObject({
      continueFree: false,
    });
  });

  it('never for a workspace that must start its trial or choose a plan', async () => {
    for (const state of ['needs_trial', 'locked']) {
      const { run, skipsPlansScreen } = self(state, false, ORG, true);
      expect(await run()).toMatchObject({ continueFree: false });
      expect(skipsPlansScreen).not.toHaveBeenCalled();
    }
  });

  it('a paid workspace is not asked', async () => {
    const org = { ...ORG, subscription: { subscriptionTier: 'STANDARD', totalChannels: 5 } };
    const { run, skipsPlansScreen } = self('active', false, org, true);
    expect(await run()).toMatchObject({ continueFree: false });
    expect(skipsPlansScreen).not.toHaveBeenCalled();
  });
});

// User.lastOnline was never written, so it equalled createdAt for all 47
// users and nobody could tell who came back.
describe('GET /user/self records lastOnline', () => {
  it('marks the signed-in user online', async () => {
    const { run, markOnline } = self('free', true);
    await run();
    expect(markOnline).toHaveBeenCalledWith('user-1');
  });

  it('not while an admin is impersonating them', async () => {
    const s = self('free', true);
    s.req.cookies.impersonate = 'someone';
    await s.run();
    expect(s.markOnline).not.toHaveBeenCalled();
  });
});

describe('POST /user/free-plan', () => {
  it('stores the choice for the workspace and says whether it has a channel', async () => {
    const chooseFreePlan = jest.fn(async () => ({ saved: true, hasChannels: false }));
    const controller = new UsersController(
      {} as any,
      {} as any,
      {} as any,
      { chooseFreePlan } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    await expect(controller.chooseFreePlan(ORG as any)).resolves.toEqual({
      saved: true,
      hasChannels: false,
    });
    expect(chooseFreePlan).toHaveBeenCalledWith('org');
  });
});

describe('GET /user/self agentMedia (the UGC sidebar item)', () => {
  const saved = process.env.AGENT_MEDIA_SSO_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_MEDIA_SSO_KEY;
    else process.env.AGENT_MEDIA_SSO_KEY = saved;
  });

  it('false while AGENT_MEDIA_SSO_KEY is not set, so the item is hidden', async () => {
    delete process.env.AGENT_MEDIA_SSO_KEY;
    expect(await self('free', true).run()).toMatchObject({ agentMedia: false });
  });

  it('true once it is set, and the key itself is never in the answer', async () => {
    process.env.AGENT_MEDIA_SSO_KEY = 'sso-signing-key-unit';
    const res: any = await self('free', true).run();
    expect(res.agentMedia).toBe(true);
    expect(JSON.stringify(res)).not.toContain('sso-signing-key-unit');
  });
});
