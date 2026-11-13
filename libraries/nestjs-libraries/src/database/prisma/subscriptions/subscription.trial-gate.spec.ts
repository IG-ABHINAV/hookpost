import 'reflect-metadata';

// SubscriptionService under the trial policy (trial.policy.ts):
// publishWithinPlan per plan state (the orchestrator publishes every post and
// reply through it), and what happens to a new-cohort workspace's channels
// when its plan ends (deleteSubscriptionByOrg). Repository and services are
// in-memory fakes.
//   pnpm exec jest -c apps/backend/jest.config.ts subscription.trial-gate

jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
  PrismaTransaction: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository',
  () => ({ AffiliateRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);

import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { PlanRequiredError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.required.error';
import { PAYMENT_FAILING_MESSAGE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { CreditsExceededError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/credits.exceeded.error';

const CUTOFF = '2026-10-20T00:00:00Z';
const BEFORE = new Date('2026-10-01T00:00:00Z');
const AFTER = new Date('2026-10-22T00:00:00Z');
const ROW = {
  subscriptionTier: 'STANDARD',
  isLifetime: false,
  cancelAt: null,
  deletedAt: null,
  identifier: 'sub_1',
  createdAt: new Date(),
};

type Org = {
  createdAt: Date;
  allowTrial: boolean;
  isTrailing: boolean;
  subscription: any;
  country?: string | null;
  /** Members who are platform super admins (getPlanFacts' _count.users). */
  superAdmins?: number;
  /** The Free plan sunset notice of 21 Oct promised it a 7-day trial. */
  sunsetNoticePromised?: boolean;
  /** Set on process.env by setup(), for a state that needs it. */
  env?: Record<string, string>;
  /** The publish dates of its posts, each on its own channel (freePostRows). */
  postDates?: Date[];
  /** Its root post rows as they are, when the channel matters (freePostRows). */
  postRows?: Array<{ publishDate: Date; integrationId: string | null }>;
  /**
   * The providers of the channels that gave their free posts in another
   * workspace (workspacesWithSpentFreePosts).
   */
  spentChannels?: string[];
  /**
   * The once-per-person trial check (trialUsedByPerson): the providers of
   * its channels that are, or were, in a workspace that had a trial or plan
   * (trialPersonFacts), whether its owner's email identity is such a user's
   * (emailIdentityKnown), and a lookup that throws.
   */
  channelsHadTrial?: string[];
  ownerEmailHadTrial?: boolean;
  personLookupFails?: boolean;
};

const STATES: Record<string, Org> = {
  free: { createdAt: BEFORE, allowTrial: true, isTrailing: true, subscription: null },
  // A new sign-up: its FREE_POST_LIMIT free posts, no trial (28 Oct 2026).
  free_posts: { createdAt: AFTER, allowTrial: true, isTrailing: true, subscription: null },
  // Grandfathered, and the Free plan sunset has passed: free posts, like a
  // new sign-up (4 Nov 2026, one rule; it was needs_trial before).
  past_sunset: {
    createdAt: BEFORE,
    allowTrial: true,
    isTrailing: true,
    subscription: null,
    env: { FREE_PLAN_SUNSET_AT: '2026-10-21T00:00:00Z' },
  },
  locked: { createdAt: AFTER, allowTrial: false, isTrailing: false, subscription: null },
  trialing: { createdAt: AFTER, allowTrial: false, isTrailing: true, subscription: ROW },
  active: { createdAt: AFTER, allowTrial: false, isTrailing: false, subscription: ROW },
  cancelling: {
    createdAt: AFTER,
    allowTrial: false,
    isTrailing: false,
    subscription: { ...ROW, cancelAt: new Date(Date.now() + 86400000 * 2) },
  },
  /**
   * A trial cancelled before its first charge: still trialing, nothing paid.
   * The only `cancelling` that loses X and AI at once (paidUntilCancelAt).
   */
  cancelling_trial: {
    createdAt: AFTER,
    allowTrial: false,
    isTrailing: true,
    subscription: { ...ROW, cancelAt: new Date(Date.now() + 86400000 * 2) },
  },
  /**
   * That same cancelling plan once its date has passed, with the hourly sweep
   * (RazorpayService.endLapsedCancellations) not yet run, so the row is still
   * on file. The plan is over from the date, not from the sweep: the same
   * answers as `locked` below, which is what the sweep leaves behind.
   */
  ended: {
    createdAt: AFTER,
    allowTrial: false,
    isTrailing: false,
    subscription: { ...ROW, cancelAt: new Date(Date.now() - 60_000) },
  },
  /** The same, on a workspace that falls back to the Free plan. */
  ended_grandfathered: {
    createdAt: BEFORE,
    allowTrial: false,
    isTrailing: false,
    subscription: { ...ROW, cancelAt: new Date(Date.now() - 60_000) },
  },
};

function setup(org: Org, channels = 4) {
  Object.assign(process.env, org.env ?? {});
  const credits: string[] = [];
  const repo = {
    getSubscription: jest.fn(async () => org.subscription),
    getSubscriptionByOrgId: jest.fn(async () => org.subscription),
    getPlanFacts: jest.fn(async () => ({
      id: 'org',
      createdAt: org.createdAt,
      allowTrial: org.allowTrial,
      isTrailing: org.isTrailing,
      subscription: org.subscription,
      users: [{ user: { signupCountry: org.country === undefined ? 'IN' : org.country } }],
      disputedAt: (org as any).disputedAt ?? null,
      _count: { users: org.superAdmins ?? 0 },
    })),
    // As reserveCredit does it: an allowance of none refuses before `publish`
    // runs, so nothing is sent and no third-party call is made.
    useCredit: jest.fn(
      async (
        _o: any,
        type: string,
        publish: () => Promise<any>,
        allowance?: { max: number }
      ) => {
        if (allowance && !(allowance.max > 0)) {
          throw new CreditsExceededError(type);
        }
        credits.push(type);
        return publish();
      }
    ),
    getCreditsFrom: jest.fn(async () => 0),
    deleteSubscriptionByOrganizationId: jest.fn(async () => ({ count: 1 })),
    sunsetNoticePromisedTrial: jest.fn(async () => !!org.sunsetNoticePromised),
    freePostRows: jest.fn(
      async () =>
        org.postRows ??
        (org.postDates ?? []).map((publishDate, i) => ({ publishDate, integrationId: `ch-${i}` }))
    ),
    workspacesWithSpentFreePosts: jest.fn(async () =>
      (org.spentChannels ?? []).map((provider) => ({ provider, organizationId: 'other-org' }))
    ),
    useUpTrial: jest.fn(async () => undefined),
  };
  const integrations = {
    providerName: jest.fn((id: string) =>
      id === 'instagram-standalone' ? 'Instagram' : id
    ),
    getIntegrationsList: jest.fn(async () =>
      Array.from({ length: channels }, (_, i) => ({ id: `ch${i}`, disabled: false }))
    ),
    disableIntegrations: jest.fn(async () => undefined),
    changeActiveCron: jest.fn(async () => undefined),
  };
  const organizations = {
    // The bare Organization row, as organization.repository.ts getOrgById
    // returns it (findUnique, no include): scalars only, no subscription.
    // Mocking it with the subscription hid the 24 Oct 2026 bug, where the X
    // gate read the plan from here and refused X for every workspace.
    getOrgById: jest.fn(async () => ({
      id: 'org',
      createdAt: org.createdAt,
      allowTrial: org.allowTrial,
      isTrailing: org.isTrailing,
    })),
    disableOrEnableNonSuperAdminUsers: jest.fn(async () => undefined),
  };
  const service = new SubscriptionService(
    repo as any,
    integrations as any,
    organizations as any,
    {} as any
  );
  // The once-per-person check (personHadBefore, its own suite in
  // subscription.offer-once.spec.ts): its answer as each case sets it.
  const personHadBefore = jest
    .spyOn(service, 'personHadBefore')
    .mockImplementation(async () => {
      if (org.personLookupFails) throw new Error('db down');
      const by = org.channelsHadTrial?.length ? 'channel' : org.ownerEmailHadTrial ? 'email' : null;
      return { had: !!by, by, related: [] } as any;
    });
  return { service, repo, integrations, organizations, credits, personHadBefore };
}

const ENV = { ...process.env };
beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_unit';
  process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret_unit';
  delete process.env.TRIAL_REQUIRED_SINCE_IN;
  delete process.env.TRIAL_REQUIRED_SINCE_GLOBAL;
  delete process.env.FREE_PLAN_SUNSET_AT;
  delete process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS;
});
afterAll(() => {
  process.env = ENV;
});

describe('publishWithinPlan per plan state (TRIAL_REQUIRED_SINCE_IN set)', () => {
  beforeEach(() => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
  });

  it('a grandfathered workspace past the sunset publishes on its free posts: no TRIAL_REQUIRED any more (4 Nov 2026)', async () => {
    const { service, credits } = setup(STATES.past_sunset);
    const publish = jest.fn(async () => 'posted');
    await expect(service.publishWithinPlan('org', publish)).resolves.toBe('posted');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(credits).toEqual(['posts']);
    expect(await service.planGate('org')).toBeNull();
  });

  it('locked: PlanRequiredError PLAN_REQUIRED', async () => {
    const { service } = setup(STATES.locked);
    const publish = jest.fn(async () => 'posted');
    await expect(service.publishWithinPlan('org', publish)).rejects.toMatchObject({
      code: 'PLAN_REQUIRED',
      message: 'Choose a plan to continue.',
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('free (grandfathered): the Free meter, as before', async () => {
    const { service, credits } = setup(STATES.free);
    await expect(service.publishWithinPlan('org', async () => 'posted')).resolves.toBe('posted');
    expect(credits).toEqual(['posts']);
  });

  it('a Free workspace over its allowance still gets CreditsExceededError, not the gate', async () => {
    const { service, repo } = setup(STATES.free);
    repo.useCredit.mockRejectedValueOnce(new CreditsExceededError('posts'));
    await expect(service.publishWithinPlan('org', async () => 'posted')).rejects.toBeInstanceOf(
      CreditsExceededError
    );
  });

  it.each(['trialing', 'active'])('%s: publishes unmetered, the gate lets it through', async (state) => {
    const { service, credits } = setup(STATES[state]);
    await expect(service.publishWithinPlan('org', async () => 'posted')).resolves.toBe('posted');
    expect(credits).toEqual([]);
  });

  it('outside India with only the India cutoff set: Free, metered', async () => {
    const { service, credits } = setup({ ...STATES.past_sunset, country: 'US' });
    await expect(service.publishWithinPlan('org', async () => 'posted')).resolves.toBe('posted');
    expect(credits).toEqual(['posts']);
  });

  // The owner, 29 Oct 2026: paid time is kept in full, X and AI included.
  it('cancelling, paid: every channel publishes until cancelAt, X included', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { service } = setup(STATES.cancelling);
    await expect(service.publishWithinPlan('org', async () => 'posted-li', 'linkedin')).resolves.toBe('posted-li');
    await expect(service.publishWithinPlan('org', async () => 'posted-x', 'x')).resolves.toBe('posted-x');
    await expect(service.publishWithinPlan('org', async () => 'posted-x', 'twitter')).resolves.toBe('posted-x');
  });

  it('cancelled trial, never charged: allows zero-cost channels (linkedin), blocks X (twitter)', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { service } = setup(STATES.cancelling_trial);
    await expect(service.publishWithinPlan('org', async () => 'posted-li', 'linkedin')).resolves.toBe('posted-li');
    await expect(service.publishWithinPlan('org', async () => 'posted-x', 'x')).rejects.toMatchObject({
      code: 'PLAN_REQUIRED',
    });
    await expect(service.publishWithinPlan('org', async () => 'posted-x', 'twitter')).rejects.toMatchObject({
      code: 'PLAN_REQUIRED',
    });
  });

  // The AI gate reads the workspace's own plan facts, not the Organization
  // row the request carries: that row's `subscription` is selected without
  // cancelAt (organization.repository.ts), so a hand-built org with a cancelAt
  // on it proved nothing and every `cancelling` plan kept its full AI
  // allowance. `requestOrg` is the row as production really produces it.
  const requestOrg = () =>
    ({
      id: 'org',
      createdAt: AFTER,
      allowTrial: false,
      isTrailing: false,
      subscription: {
        subscriptionTier: 'STANDARD',
        totalChannels: 5,
        isLifetime: false,
        createdAt: new Date(),
      },
    } as any);

  it('cancelling, paid: keeps its full AI allowance until cancelAt', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { service } = setup(STATES.cancelling);
    expect((await service.checkCredits(requestOrg(), 'ai_text')).credits).toBeGreaterThan(0);
    expect((await service.checkCredits(requestOrg(), 'ai_images')).credits).toBeGreaterThan(0);
  });

  it('aiAccess (the AI permission): a paid cancel keeps AI, a cancelled trial does not', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_x';
    expect(await setup(STATES.cancelling).service.aiAccess('org', {}, true)).toEqual({ state: 'cancelling', allowed: true });
    expect(await setup(STATES.cancelling_trial).service.aiAccess('org', {}, true)).toEqual({ state: 'cancelling', allowed: false });
    expect(await setup(STATES.ended).service.aiAccess('org', {}, true)).toEqual({ state: 'locked', allowed: false });
  });

  it('cancelled trial: no AI allowance, from the row the request carries', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { service } = setup(STATES.cancelling_trial);
    expect((await service.checkCredits(requestOrg(), 'ai_text')).credits).toBe(0);
    expect((await service.checkCredits(requestOrg(), 'ai_images')).credits).toBe(0);
    expect((await service.checkCredits(requestOrg(), 'generate_videos')).credits).toBe(0);
  });

  it('active: the same row keeps its full AI allowance', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { service } = setup(STATES.active);
    expect((await service.checkCredits(requestOrg(), 'ai_text')).credits).toBeGreaterThan(0);
    expect((await service.checkCredits(requestOrg(), 'ai_images')).credits).toBeGreaterThan(0);
  });

  // The hourly sweep deletes the row of a plan whose cancelAt has passed, so
  // between the two the workspace holds a plan row whose time is up. Every
  // gate reads the date instead (trial.policy.ts planLapsed), which is why
  // the sweep running changes nothing.
  it('cancelAt passed, sweep not run: publishes nothing, and the row is left for the sweep', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { service, repo, credits } = setup(STATES.ended);
    const publish = jest.fn(async () => 'posted');
    await expect(service.publishWithinPlan('org', publish)).rejects.toMatchObject({
      code: 'PLAN_REQUIRED',
      message: 'Choose a plan to continue.',
    });
    expect(publish).not.toHaveBeenCalled();
    expect(credits).toEqual([]);
    // The row itself is untouched: closing it is the sweep's job, once.
    expect(await repo.getSubscription()).toBe(STATES.ended.subscription);
  });

  it('cancelAt passed, sweep not run: no AI allowance either', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { service } = setup(STATES.ended);
    expect((await service.checkCredits(requestOrg(), 'ai_text')).credits).toBe(0);
    expect((await service.checkCredits(requestOrg(), 'ai_images')).credits).toBe(0);
  });

  // The AI credit itself, not only the balance: over the gate `func` must
  // never run, so nothing reaches OpenAI or Vertex.
  it('cancelled trial: useCredit refuses an AI generation and runs nothing', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { service } = setup(STATES.cancelling_trial);
    const generate = jest.fn(async () => 'image');
    await expect(
      service.useCredit({ id: 'org' } as any, 'ai_images', generate)
    ).rejects.toBeInstanceOf(CreditsExceededError);
    expect(generate).not.toHaveBeenCalled();
  });
});

// The X gate (trial.policy.ts allowsXPublishing) per plan state, for X and for
// a channel that costs nothing per post. Only a cancelling plan loses X (the
// owner's Option A); our own workspaces (a platform super admin member, or
// FREE_PLAN_SUNSET_EXEMPT_ORGS) never do. The plan is read through
// getPlanFacts; getOrgById returns scalars only, as the real repository does.
describe('publishWithinPlan: X per plan state', () => {
  const CANCELLING = { ...ROW, cancelAt: new Date(Date.now() + 86400000 * 2) };
  const LIFETIME = { ...ROW, subscriptionTier: 'ULTIMATE', isLifetime: true };

  // [workspace, X result, LinkedIn result, the workspace, extra env]
  // A result is 'unmetered', 'metered' (one Free 'posts' credit) or the
  // PlanRequiredError code.
  type Result = 'unmetered' | 'metered' | 'PLAN_REQUIRED' | 'TRIAL_REQUIRED';
  const MATRIX: Array<[string, Result, Result, Org, Record<string, string>?]> = [
    ['active Standard', 'unmetered', 'unmetered', STATES.active],
    ['active Standard, grandfathered', 'unmetered', 'unmetered', { ...STATES.active, createdAt: BEFORE }],
    ['lifetime', 'unmetered', 'unmetered', { ...STATES.active, subscription: LIFETIME }],
    ['trialing', 'unmetered', 'unmetered', STATES.trialing],
    ['cancelling, paid', 'unmetered', 'unmetered', STATES.cancelling],
    ['cancelling trial', 'PLAN_REQUIRED', 'unmetered', { ...STATES.cancelling, isTrailing: true }],
    ['free (grandfathered)', 'metered', 'metered', STATES.free],
    ['super admin member, no plan', 'metered', 'metered', { ...STATES.free, superAdmins: 1 }],
    ['super admin member, active', 'unmetered', 'unmetered', { ...STATES.active, superAdmins: 1 }],
    ['super admin member, cancelling', 'unmetered', 'unmetered', { ...STATES.cancelling, superAdmins: 1 }],
    ['exempt, no plan', 'metered', 'metered', STATES.free, { FREE_PLAN_SUNSET_EXEMPT_ORGS: 'other,org' }],
    ['exempt, cancelling', 'unmetered', 'unmetered', STATES.cancelling, { FREE_PLAN_SUNSET_EXEMPT_ORGS: 'org' }],
    ['free_posts', 'metered', 'metered', STATES.free_posts],
    ['grandfathered past the sunset (free posts)', 'metered', 'metered', STATES.past_sunset],
    ['locked', 'PLAN_REQUIRED', 'PLAN_REQUIRED', STATES.locked],
    // cancelAt passed, row not swept yet: the `locked` line, not the
    // `cancelling` one. Without this the row's existence alone published.
    ['ended, row not swept yet', 'PLAN_REQUIRED', 'PLAN_REQUIRED', STATES.ended],
    ['ended, row not swept yet, grandfathered', 'metered', 'metered', STATES.ended_grandfathered],
  ];

  const cases = MATRIX.flatMap(([name, x, linkedin, org, extra]) => [
    [name, 'x', x, org, extra] as const,
    [name, 'linkedin', linkedin, org, extra] as const,
  ]);

  describe.each([
    ['TRIAL_REQUIRED_SINCE_IN set, as in production', CUTOFF],
    ['both cutoffs empty', ''],
  ])('%s', (_mode, cutoff) => {
    it.each(cases)('%s, %s: %s', async (_name, provider, expected, org, extra) => {
      process.env.TRIAL_REQUIRED_SINCE_IN = cutoff;
      Object.assign(process.env, extra ?? {});
      // With no cutoff nobody is in the new cohort: needs_trial and locked
      // are the Free plan there, and so is a workspace whose plan has ended
      // (its row is on file but over, which is no plan either).
      const planOnFile =
        !!org.subscription &&
        !(org.subscription.cancelAt && org.subscription.cancelAt <= new Date());
      const result: Result =
        !cutoff && (expected === 'TRIAL_REQUIRED' || (expected === 'PLAN_REQUIRED' && !planOnFile))
          ? 'metered'
          : expected;
      const { service, credits, organizations } = setup(org);
      const publish = jest.fn(async () => 'posted');
      const attempt = service.publishWithinPlan('org', publish, provider);
      if (result === 'unmetered' || result === 'metered') {
        await expect(attempt).resolves.toBe('posted');
        expect(publish).toHaveBeenCalledTimes(1);
        expect(credits).toEqual(result === 'metered' ? ['posts'] : []);
      } else {
        await expect(attempt).rejects.toBeInstanceOf(PlanRequiredError);
        await expect(attempt).rejects.toMatchObject({ code: result, status: 402 });
        expect(publish).not.toHaveBeenCalled();
        expect(credits).toEqual([]);
      }
      // getOrgById has no plan on it: only the Free meter may read it, for
      // the workspace's creation date.
      if (result !== 'metered') expect(organizations.getOrgById).not.toHaveBeenCalled();
    });
  });

  it("'twitter', X's old identifier, is gated the same way", async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const publish = jest.fn(async () => 'posted');
    await expect(setup(STATES.cancelling_trial).service.publishWithinPlan('org', publish, 'twitter')).rejects.toMatchObject({
      code: 'PLAN_REQUIRED',
    });
    await expect(setup(STATES.active).service.publishWithinPlan('org', publish, 'twitter')).resolves.toBe('posted');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('reads the plan through getPlanFacts, which carries the Subscription row', async () => {
    const { service, repo, organizations } = setup(STATES.active);
    await expect(service.publishWithinPlan('org', async () => 'posted', 'x')).resolves.toBe('posted');
    expect(repo.getPlanFacts).toHaveBeenCalledWith('org');
    expect(organizations.getOrgById).not.toHaveBeenCalled();
  });

  it('without billing, X publishes and nothing is read', async () => {
    delete process.env.RAZORPAY_KEY_SECRET;
    const { service, repo } = setup(STATES.cancelling);
    await expect(service.publishWithinPlan('org', async () => 'posted', 'x')).resolves.toBe('posted');
    expect(repo.getPlanFacts).not.toHaveBeenCalled();
  });

  it('a workspace that cannot be found is not refused X by this gate', async () => {
    const { service, repo } = setup(STATES.active);
    repo.getPlanFacts.mockResolvedValueOnce(null as any);
    expect(await service.allowsXPublishing('org')).toBe(true);
  });

  it('allowsXPublishing (the connect gate) answers like the publish gate', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    expect(await setup(STATES.active).service.allowsXPublishing('org')).toBe(true);
    expect(await setup({ ...STATES.active, subscription: LIFETIME }).service.allowsXPublishing('org')).toBe(true);
    expect(await setup(STATES.trialing).service.allowsXPublishing('org')).toBe(true);
    expect(await setup(STATES.free).service.allowsXPublishing('org')).toBe(true);
    expect(await setup(STATES.cancelling).service.allowsXPublishing('org')).toBe(true);
    expect(await setup(STATES.cancelling_trial).service.allowsXPublishing('org')).toBe(false);
    expect(await setup({ ...STATES.cancelling_trial, superAdmins: 1 }).service.allowsXPublishing('org')).toBe(true);
    process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = 'org';
    expect(await setup(STATES.cancelling_trial).service.allowsXPublishing('org')).toBe(true);
  });
});

describe('publishWithinPlan ships dark', () => {
  it('with both cutoffs empty a new workspace publishes on the Free meter', async () => {
    const { service, credits } = setup(STATES.past_sunset);
    await expect(service.publishWithinPlan('org', async () => 'posted')).resolves.toBe('posted');
    expect(credits).toEqual(['posts']);
  });

  it('without billing nothing is read at all', async () => {
    delete process.env.RAZORPAY_KEY_SECRET;
    const { service, credits, repo } = setup(STATES.past_sunset);
    await expect(service.publishWithinPlan('org', async () => 'posted')).resolves.toBe('posted');
    expect(credits).toEqual([]);
    expect(repo.getPlanFacts).not.toHaveBeenCalled();
  });

  it('with both cutoffs empty a disputed workspace still publishes nothing', async () => {
    const { service, credits } = setup({ ...STATES.free, disputedAt: new Date() } as any);
    const publish = jest.fn(async () => 'posted');
    await expect(service.publishWithinPlan('org', publish)).rejects.toMatchObject({ code: 'PLAN_REQUIRED' });
    expect(publish).not.toHaveBeenCalled();
    expect(credits).toEqual([]);
  });
});

// What stops while a payment is failing (29 Oct 2026, the owner's call): AI
// and X, and nothing else. The marker on the plan row is all any of this
// reads; nothing here asks Razorpay.
describe('publishWithinPlan when the payment is failing', () => {
  const FAILING = { ...ROW, paymentFailingSince: new Date('2026-10-29T10:00:00Z') };
  const firstCharge: Org = { ...STATES.trialing, subscription: FAILING };
  const renewal: Org = { ...STATES.active, subscription: FAILING };

  beforeEach(() => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
  });

  it.each([
    ["a trial's first charge", firstCharge],
    ["a paid plan's renewal", renewal],
  ])('%s failing: the other channels publish, X and AI do not', async (_name, workspace) => {
    const { service, credits } = setup(workspace);
    await expect(
      service.publishWithinPlan('org', async () => 'posted', 'linkedin')
    ).resolves.toBe('posted');
    // A plan on file publishes on the plan, never on the Free posts meter.
    expect(credits).toEqual([]);

    for (const provider of ['x', 'twitter']) {
      const publish = jest.fn(async () => 'posted');
      const attempt = setup(workspace).service.publishWithinPlan(
        'org',
        publish,
        provider
      );
      await expect(attempt).rejects.toBeInstanceOf(PlanRequiredError);
      await expect(attempt).rejects.toMatchObject({
        code: 'PLAN_REQUIRED',
        status: 402,
      });
      expect(publish).not.toHaveBeenCalled();
    }

    expect((await setup(workspace).service.getPlanState('org')).state).toBe('dunning');
    // Nothing is gated: a post that comes due still goes out.
    expect(await setup(workspace).service.planGate('org')).toBeNull();

    const org = {
      id: 'org',
      createdAt: AFTER,
      allowTrial: false,
      isTrailing: workspace === firstCharge,
      subscription: FAILING,
    } as any;
    expect((await service.checkCredits(org, 'ai_text')).credits).toBe(0);
    expect((await service.checkCredits(org, 'ai_images')).credits).toBe(0);
  });

  it('a lifetime plan is never restricted by a marker', async () => {
    const lifetime = {
      ...STATES.active,
      subscription: { ...FAILING, isLifetime: true, subscriptionTier: 'ULTIMATE' },
    };
    const { service } = setup(lifetime);
    await expect(service.publishWithinPlan('org', async () => 'posted', 'x')).resolves.toBe('posted');
    expect((await setup(lifetime).service.getPlanState('org')).state).toBe('active');
  });

  it('one of our own workspaces keeps X while its test mandate fails', async () => {
    const ours = { ...firstCharge, superAdmins: 1 };
    expect(await setup(ours).service.allowsXPublishing('org')).toBe(true);
    expect((await setup(ours).service.getPlanState('org')).state).toBe('trialing');
  });

  it('does not need a trial cutoff: a bought plan is not a cohort', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '';
    expect(await setup(firstCharge).service.allowsXPublishing('org')).toBe(false);
    await expect(
      setup(firstCharge).service.publishWithinPlan('org', async () => 'posted', 'x')
    ).rejects.toMatchObject({ code: 'PLAN_REQUIRED' });
    // And the rest of the workspace is untouched either way.
    await expect(
      setup(renewal).service.publishWithinPlan('org', async () => 'posted', 'linkedin')
    ).resolves.toBe('posted');
    expect(await setup(renewal).service.planGate('org')).toBeNull();
  });

  it('the X refusal says the payment failed, not "choose a plan"', async () => {
    await expect(
      setup(renewal).service.publishWithinPlan('org', async () => 'posted', 'x')
    ).rejects.toMatchObject({ message: PAYMENT_FAILING_MESSAGE });
    // A cancelled trial keeps its own wording.
    await expect(
      setup(STATES.cancelling_trial).service.publishWithinPlan('org', async () => 'posted', 'x')
    ).rejects.toMatchObject({ message: 'Choose a plan to continue.' });
  });

  it('AI credits read the marker from the database, not the trimmed request org', async () => {
    // The request's organization (auth middleware) carries a Subscription row
    // without paymentFailingSince: AI must still be refused.
    const trimmed = {
      id: 'org',
      createdAt: AFTER,
      allowTrial: false,
      isTrailing: false,
      subscription: { subscriptionTier: 'STANDARD', totalChannels: 5, isLifetime: false },
    } as any;
    const { service, repo } = setup(renewal);
    expect(await service.checkCredits(trimmed, 'ai_text')).toEqual({
      credits: 0,
      paymentFailing: true,
    });
    const generate = jest.fn(async () => 'image');
    // max 0 handed to the repository's metered transaction: refused, nothing generated.
    await expect(service.useCredit(trimmed, 'ai_images', generate)).rejects.toBeInstanceOf(
      CreditsExceededError
    );
    expect(repo.useCredit).toHaveBeenLastCalledWith(
      trimmed,
      'ai_images',
      generate,
      expect.objectContaining({ max: 0 })
    );
    expect(generate).not.toHaveBeenCalled();
    // Posts are not an AI credit: untouched by the marker.
    expect(await service.isPaymentFailing('org')).toBe(true);
    await expect(
      setup(STATES.active).service.isPaymentFailing('org')
    ).resolves.toBe(false);
  });

  it('without billing nothing is read and nothing is failing', async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    const { service, repo } = setup(renewal);
    expect(await service.isPaymentFailing('org')).toBe(false);
    expect(repo.getPlanFacts).not.toHaveBeenCalled();
  });

  it('cleared again: X is back, with nobody doing anything', async () => {
    const back = { ...STATES.trialing, subscription: { ...ROW, paymentFailingSince: null } };
    const { service } = setup(back);
    await expect(service.publishWithinPlan('org', async () => 'posted', 'x')).resolves.toBe('posted');
    expect((await setup(back).service.getPlanState('org')).state).toBe('trialing');
  });
});

describe('deleteSubscriptionByOrg: a plan ends', () => {
  it('a grandfathered workspace is cut to the Free plan’s 2 channels, as before', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { service, integrations, repo } = setup({ ...STATES.active, createdAt: BEFORE }, 4);
    await service.deleteSubscriptionByOrg('org');
    expect(integrations.disableIntegrations).toHaveBeenCalledWith('org', 2);
    expect(repo.deleteSubscriptionByOrganizationId).toHaveBeenCalledWith('org');
  });

  it('a new-cohort workspace keeps its channels (paused, not pruned), team handling unchanged', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const team = { ...ROW, subscriptionTier: 'TEAM' };
    const { service, integrations, organizations, repo } = setup(
      { ...STATES.active, subscription: team },
      4
    );
    await service.deleteSubscriptionByOrg('org');
    expect(integrations.getIntegrationsList).not.toHaveBeenCalled();
    expect(integrations.disableIntegrations).not.toHaveBeenCalled();
    // Team members are switched off like any plan without them.
    expect(organizations.disableOrEnableNonSuperAdminUsers).toHaveBeenCalledWith('org', true);
    expect(repo.deleteSubscriptionByOrganizationId).toHaveBeenCalledWith('org');
  });

  it('with both cutoffs empty every workspace is pruned as before, without reading its trial facts', async () => {
    const { service, integrations, repo } = setup(STATES.active, 4);
    await service.deleteSubscriptionByOrg('org');
    expect(integrations.disableIntegrations).toHaveBeenCalledWith('org', 2);
    expect(repo.getPlanFacts).not.toHaveBeenCalled();
  });
});

describe('getPlanState (for /user/self)', () => {
  // Every state is its own key, except the two that are a plan whose cancelAt
  // has passed: the app must already show what the sweep will leave behind.
  const SHOWN: Record<string, string> = {
    ended: 'locked',
    ended_grandfathered: 'free',
    cancelling_trial: 'cancelling',
    past_sunset: 'free_posts',
  };

  it.each(Object.keys(STATES))('%s', async (state) => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { service } = setup(STATES[state]);
    const res = await service.getPlanState('org');
    const shown = SHOWN[state] ?? state;
    expect(res.state).toBe(shown);
    expect(res.freePlanAvailable).toBe(shown === 'free');
  });

  it('with both cutoffs empty a new workspace is free and has the Free plan', async () => {
    const { service } = setup(STATES.past_sunset);
    expect(await service.getPlanState('org')).toEqual({
      state: 'free',
      freePlanAvailable: true,
      freePlanEndsAt: null,
      freePlanSunsetAt: null,
    });
  });

  it('without billing every workspace is active', async () => {
    delete process.env.RAZORPAY_KEY_ID;
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { service } = setup(STATES.locked);
    expect((await service.getPlanState('org')).state).toBe('active');
    expect(await service.planGate('org')).toBe('PLAN_REQUIRED'); // the secret is still set
    delete process.env.RAZORPAY_KEY_SECRET;
    expect(await service.planGate('org')).toBeNull();
  });
});

describe('FREE_PLAN_SUNSET_AT (grandfathered Free workspaces)', () => {
  // The suite runs on the real clock (20 Oct 2026 or later), so a sunset on
  // the floor day has passed and one in 2030 is ahead.
  const PASSED = '2026-10-19T06:00:00Z';
  const AHEAD = '2030-01-01T00:00:00Z';
  beforeEach(() => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
  });

  it('unset: Free, metered, no date, exactly as before', async () => {
    const { service, credits } = setup(STATES.free);
    expect(await service.getPlanState('org')).toEqual({
      state: 'free',
      freePlanAvailable: true,
      freePlanEndsAt: null,
      freePlanSunsetAt: null,
    });
    await expect(service.publishWithinPlan('org', async () => 'posted')).resolves.toBe('posted');
    expect(credits).toEqual(['posts']);
  });

  it('ahead: still Free and publishing, with the date for the notice', async () => {
    process.env.FREE_PLAN_SUNSET_AT = AHEAD;
    const { service, credits } = setup(STATES.free);
    const res = await service.getPlanState('org');
    expect(res.state).toBe('free');
    expect(res.freePlanAvailable).toBe(true);
    expect(res.freePlanEndsAt?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(res.freePlanSunsetAt?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    await expect(service.publishWithinPlan('org', async () => 'posted')).resolves.toBe('posted');
    expect(credits).toEqual(['posts']);
  });

  it('ahead, grandfathered with a plan: no notice, but Billing learns when its Free fallback ends', async () => {
    process.env.FREE_PLAN_SUNSET_AT = AHEAD;
    for (const state of ['trialing', 'active']) {
      const { service } = setup({ ...STATES[state], createdAt: BEFORE });
      const res = await service.getPlanState('org');
      expect(res.state).toBe(state);
      expect(res.freePlanEndsAt).toBeNull();
      expect(res.freePlanSunsetAt?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
      expect((await service.getFreePlanSunsetAt('org'))?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
      // When its plan ends after the sunset, it is paused, not moved to Free.
      expect(await service.inNewCohort('org')).toBe(false);
      expect(await service.inNewCohort('org', new Date('2030-02-01T00:00:00Z'))).toBe(true);
    }
  });

  it('passed: free posts, like a new sign-up (4 Nov 2026, no needs_trial)', async () => {
    process.env.FREE_PLAN_SUNSET_AT = PASSED;
    const { service, credits } = setup(STATES.free);
    expect(await service.getPlanState('org')).toEqual({
      state: 'free_posts',
      freePlanAvailable: false,
      freePlanEndsAt: null,
      freePlanSunsetAt: null,
    });
    expect(await service.planGate('org')).toBeNull();
    const publish = jest.fn(async () => 'posted');
    await expect(service.publishWithinPlan('org', publish)).resolves.toBe('posted');
    expect(credits).toEqual(['posts']);
  });

  it('passed, trial already used: choose a plan', async () => {
    process.env.FREE_PLAN_SUNSET_AT = PASSED;
    const { service } = setup({ ...STATES.free, allowTrial: false, isTrailing: false });
    expect(await service.planGate('org')).toBe('PLAN_REQUIRED');
  });

  it('passed, but exempt by FREE_PLAN_SUNSET_EXEMPT_ORGS or a platform super admin member: Free', async () => {
    process.env.FREE_PLAN_SUNSET_AT = PASSED;
    process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = 'other,org';
    expect((await setup(STATES.free).service.getPlanState('org')).state).toBe('free');
    delete process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS;
    const admin = setup({ ...STATES.free, superAdmins: 1 });
    expect((await admin.service.getPlanState('org')).state).toBe('free');
    expect(await admin.service.planGate('org')).toBeNull();
  });

  it.each(['trialing', 'active'])('passed, %s grandfathered workspace: publishes unmetered, untouched', async (state) => {
    process.env.FREE_PLAN_SUNSET_AT = PASSED;
    const { service, credits } = setup({ ...STATES[state], createdAt: BEFORE });
    expect((await service.getPlanState('org')).state).toBe(state);
    await expect(service.publishWithinPlan('org', async () => 'posted')).resolves.toBe('posted');
    expect(credits).toEqual([]);
  });
});

// 28 Oct 2026: a new sign-up gets FREE_POST_LIMIT free posts, then a plan
// charged at once (no trial, so the first-month offer applies).
describe('free posts (free_posts)', () => {
  const at = (iso: string) => new Date(iso);
  const posts = (n: number) =>
    Array.from({ length: n }, (_, i) => at(`2026-10-2${3 + i}T10:00:00Z`));

  beforeEach(() => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
  });

  it('publishes on the Free meter: a free post is never refused at publish time', async () => {
    const { service, credits } = setup({ ...STATES.free_posts, postDates: posts(3) });
    const publish = jest.fn(async () => 'posted');
    await expect(service.publishWithinPlan('org', publish, 'linkedin')).resolves.toBe('posted');
    await expect(service.publishWithinPlan('org', publish, 'x')).resolves.toBe('posted');
    expect(credits).toEqual(['posts', 'posts']);
  });

  it.each([
    [0, 3],
    [2, 1],
    [3, 0],
  ])('%i posts used: %i left', async (used, left) => {
    const { service } = setup({ ...STATES.free_posts, postDates: posts(used) });
    expect(await service.freePostsUsage('org')).toMatchObject({ used, limit: 3, left });
  });

  it('counts a post on several channels once: its rows share the publish date', async () => {
    const same = at('2026-10-23T10:00:00Z');
    const { service } = setup({
      ...STATES.free_posts,
      postDates: [same, at('2026-10-23T10:00:30Z'), at('2026-10-24T08:00:00Z')],
    });
    expect(await service.freePostsUsage('org')).toMatchObject({ used: 2, left: 1 });
  });

  it('counts separate saves to one channel at the same minute as separate posts (sandbox s0, 1 Nov 2026)', async () => {
    const same = at('2026-10-23T10:00:00Z');
    const rows = [0, 1, 2].map(() => ({ publishDate: same, integrationId: 'linkedin-1' }));
    const { service } = setup({ ...STATES.free_posts, postRows: rows });
    expect(await service.freePostsUsage('org')).toMatchObject({ used: 3, left: 0 });
    await expect(
      service.assertFreePostAllowed('org', { newPost: true, repeats: false })
    ).rejects.toMatchObject({ code: 'FREE_POSTS_USED' });
  });

  it.each([
    [0, true],
    [2, true],
    [3, false],
    [4, false],
  ])('with %i used, a new post is allowed: %s', async (used, allowed) => {
    const { service } = setup({ ...STATES.free_posts, postDates: posts(used) });
    const attempt = service.assertFreePostAllowed('org', {
      newPost: true,
      repeats: false,
    });
    if (allowed) {
      await expect(attempt).resolves.toBeUndefined();
    } else {
      await expect(attempt).rejects.toBeInstanceOf(PlanRequiredError);
      await expect(attempt).rejects.toMatchObject({
        code: 'FREE_POSTS_USED',
        status: 402,
        message: "You've used your 3 free posts. Pick a plan to keep posting.",
      });
    }
  });

  it('with all 3 used, an edit still saves; a new post at a used minute does not', async () => {
    const { service } = setup({ ...STATES.free_posts, postDates: posts(3) });
    await expect(
      service.assertFreePostAllowed('org', { newPost: false, repeats: false })
    ).resolves.toBeUndefined();
    await expect(
      service.assertFreePostAllowed('org', { newPost: true, repeats: false })
    ).rejects.toMatchObject({ code: 'FREE_POSTS_USED' });
  });

  it('refuses Repeat Post, which would publish a free post again and again', async () => {
    const { service } = setup({ ...STATES.free_posts, postDates: [] });
    await expect(
      service.assertFreePostAllowed('org', {
        newPost: true,
        repeats: true,
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each(['free', 'locked', 'trialing', 'active', 'cancelling'])(
    '%s: no allowance, nothing read, nothing refused',
    async (state) => {
      const { service, repo } = setup({ ...STATES[state], postDates: posts(9) });
      expect(await service.freePostsUsage('org')).toBeNull();
      await expect(
        service.assertFreePostAllowed('org', {
          newPost: true,
          repeats: true,
        })
      ).resolves.toBeUndefined();
      expect(repo.freePostRows).not.toHaveBeenCalled();
    }
  );

  it('with both cutoffs empty nothing is read', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '';
    const { service, repo } = setup({ ...STATES.free_posts, postDates: posts(9) });
    expect(await service.freePostsUsage('org')).toBeNull();
    expect(repo.freePostRows).not.toHaveBeenCalled();
    expect(repo.getPlanFacts).not.toHaveBeenCalled();
  });

  it('checkout: no trial for free_posts, a grandfathered one past the sunset included; a grandfathered Free workspace keeps its', async () => {
    process.env.TRIAL_CHECKOUT = 'off';
    expect(await setup(STATES.free_posts).service.checkoutAllowsTrial('org', true)).toBe(false);
    expect(await setup(STATES.past_sunset).service.checkoutAllowsTrial('org', true)).toBe(false);
    delete process.env.FREE_PLAN_SUNSET_AT;
    expect(await setup(STATES.free).service.checkoutAllowsTrial('org', true)).toBe(true);
    // A used trial stays used, without reading the workspace.
    const locked = setup(STATES.locked);
    expect(await locked.service.checkoutAllowsTrial('org', false)).toBe(false);
    expect(locked.repo.getPlanFacts).not.toHaveBeenCalled();
  });

  describe('with the trial switch on (TRIAL_CHECKOUT=on)', () => {
    beforeEach(() => {
      process.env.TRIAL_CHECKOUT = 'on';
    });
    afterEach(() => {
      delete process.env.TRIAL_CHECKOUT;
    });

    it('a free_posts workspace nobody behind has had a trial: checkout starts one, asking with the trial sources and the member', async () => {
      const { service, personHadBefore } = setup(STATES.free_posts);
      expect(await service.checkoutAllowsTrial('org', true, {}, { userId: 'u1' })).toBe(true);
      expect(personHadBefore).toHaveBeenCalledWith('org', ['PAID', 'OFFER', 'TRIAL'], { userId: 'u1' });
    });

    it('a channel that had a trial or plan in another workspace: no trial', async () => {
      const { service } = setup({ ...STATES.free_posts, channelsHadTrial: ['linkedin'] });
      expect(await service.checkoutAllowsTrial('org', true)).toBe(false);
    });

    it("the owner's email identity in a workspace that had a trial or plan: no trial", async () => {
      expect(
        await setup({ ...STATES.free_posts, ownerEmailHadTrial: true }).service.checkoutAllowsTrial('org', true)
      ).toBe(false);
    });

    it('a lookup that fails gives the trial (as a failed free-posts check gives the posts)', async () => {
      expect(
        await setup({ ...STATES.free_posts, personLookupFails: true }).service.checkoutAllowsTrial('org', true)
      ).toBe(true);
    });

    it('a used trial stays used: allowTrial false is never a trial, nothing read', async () => {
      const { service, repo, personHadBefore } = setup({ ...STATES.locked });
      expect(await service.checkoutAllowsTrial('org', false)).toBe(false);
      expect(repo.getPlanFacts).not.toHaveBeenCalled();
      expect(personHadBefore).not.toHaveBeenCalled();
    });

    it('a disputed workspace is locked, never a trial', async () => {
      const { service } = setup({ ...STATES.free_posts, disputedAt: new Date() } as any);
      expect(await service.checkoutAllowsTrial('org', true)).toBe(false);
    });

    it('at approval: a person who had a trial meanwhile is refused, and the trial is used up', async () => {
      const { service, repo } = setup({ ...STATES.free_posts, ownerEmailHadTrial: true });
      expect(await service.refuseTrialAtApproval('org')).toBe(true);
      expect(repo.useUpTrial).toHaveBeenCalledWith('org');
    });

    it('at approval: nobody behind it had a trial, or it is not on its free posts: not refused, nothing written', async () => {
      for (const org of [STATES.free_posts, { ...STATES.trialing, ownerEmailHadTrial: true }]) {
        const { service, repo } = setup(org);
        expect(await service.refuseTrialAtApproval('org')).toBe(false);
        expect(repo.useUpTrial).not.toHaveBeenCalled();
      }
    });

    it('at approval: a trial mandate for a workspace whose trial is already used and has no plan is refused (a delivery beside the refusing one)', async () => {
      const { service, personHadBefore } = setup(STATES.locked);
      expect(await service.refuseTrialAtApproval('org')).toBe(true);
      expect(personHadBefore).not.toHaveBeenCalled();
    });

    it('at approval: a workspace with a live plan is never refused here (a plan switch is not a new trial)', async () => {
      for (const org of [STATES.trialing, STATES.active, STATES.cancelling_trial]) {
        expect(await setup({ ...org, ownerEmailHadTrial: true }).service.refuseTrialAtApproval('org')).toBe(false);
      }
    });

    it('at approval: never refuses the mandate a parallel delivery has just made the plan', async () => {
      const { service, repo } = setup({ ...STATES.free_posts, ownerEmailHadTrial: true });
      // First read: no plan yet. By the re-read the other delivery saved it.
      const facts = (over: any) => ({
        id: 'org', createdAt: STATES.free_posts.createdAt, allowTrial: true, isTrailing: true,
        subscription: null, users: [{ user: { signupCountry: 'IN' } }], disputedAt: null, _count: { users: 0 }, ...over,
      });
      repo.getPlanFacts
        .mockImplementationOnce(async () => facts({}) as any)
        .mockImplementation(async () => facts({ allowTrial: false, subscription: { ...ROW, identifier: 'sub_X' } }) as any);
      expect(await service.refuseTrialAtApproval('org', { subscriptionId: 'sub_X' })).toBe(false);
      expect(repo.useUpTrial).not.toHaveBeenCalled();
    });

    it('a state the caller already read is not read again (/user/self)', async () => {
      const { service, repo } = setup(STATES.free_posts);
      expect(await service.checkoutAllowsTrial('org', true, {}, { state: 'free_posts' })).toBe(true);
      expect(repo.getPlanFacts).not.toHaveBeenCalled();
    });
  });

  it('at approval with the switch off: never refused, nothing read (production unchanged)', async () => {
    process.env.TRIAL_CHECKOUT = 'off';
    const { service, repo } = setup({ ...STATES.free_posts, ownerEmailHadTrial: true, channelsHadTrial: ['x'] });
    expect(await service.refuseTrialAtApproval('org')).toBe(false);
    expect(repo.getPlanFacts).not.toHaveBeenCalled();
    expect(repo.useUpTrial).not.toHaveBeenCalled();
    delete process.env.TRIAL_CHECKOUT;
  });

  it('checkout with both cutoffs empty: allowTrial decides, as before', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '';
    expect(await setup(STATES.free_posts).service.checkoutAllowsTrial('org', true)).toBe(true);
  });
});

// Free posts are given once (trial.policy.ts, 29 Oct 2026): a channel that is
// or was connected in another workspace that had its free posts, a trial or a
// plan gives none here. The repository decides which channels those are
// (workspacesWithSpentFreePosts); this is what the save does with the answer.
describe('free posts: a channel gives them once', () => {
  const REUSED =
    'This Instagram account has already used its free posts on Hookpost. Pick a plan to keep posting from it. Your other connected accounts are not affected.';
  const save = (integrationIds: string[], newPost = true) => ({
    newPost,
    repeats: false,
    channelsGainingPosts: jest.fn(async () => integrationIds),
  });

  beforeEach(() => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
  });

  it('a new post to a channel used in another workspace is FREE_POSTS_USED, naming it', async () => {
    const { service, repo } = setup({
      ...STATES.free_posts,
      postDates: [],
      spentChannels: ['instagram-standalone'],
    });
    const attempt = service.assertFreePostAllowed('org', save(['ch1', 'ch2', 'ch1']));
    await expect(attempt).rejects.toBeInstanceOf(PlanRequiredError);
    await expect(attempt).rejects.toMatchObject({
      code: 'FREE_POSTS_USED',
      status: 402,
      message: REUSED,
      response: { code: 'FREE_POSTS_USED', message: REUSED },
    });
    // Each channel asked about once.
    expect(repo.workspacesWithSpentFreePosts).toHaveBeenCalledWith('org', ['ch1', 'ch2']);
  });

  it('a channel no other workspace spent: the post saves', async () => {
    const { service, repo } = setup({ ...STATES.free_posts, postDates: [], spentChannels: [] });
    await expect(service.assertFreePostAllowed('org', save(['ch1']))).resolves.toBeUndefined();
    expect(repo.workspacesWithSpentFreePosts).toHaveBeenCalledTimes(1);
  });

  it('an edit that keeps its channels still saves, without asking', async () => {
    const { service, repo } = setup({
      ...STATES.free_posts,
      postDates: [new Date('2026-10-23T10:00:00Z')],
      spentChannels: ['instagram-standalone'],
    });
    await expect(
      service.assertFreePostAllowed('org', save([], false))
    ).resolves.toBeUndefined();
    expect(repo.workspacesWithSpentFreePosts).not.toHaveBeenCalled();
  });

  it('an edit that moves its post onto a spent channel is refused, even with all 3 used', async () => {
    const { service, repo } = setup({
      ...STATES.free_posts,
      postDates: [1, 2, 3].map((d) => new Date(`2026-10-2${d}T10:00:00Z`)),
      spentChannels: ['instagram-standalone'],
    });
    await expect(
      service.assertFreePostAllowed('org', save(['ch2'], false))
    ).rejects.toMatchObject({ code: 'FREE_POSTS_USED', message: REUSED });
    expect(repo.workspacesWithSpentFreePosts).toHaveBeenCalledWith('org', ['ch2']);
  });

  it('a channel lookup that fails lets the save through (as the usage read does)', async () => {
    const { service, repo } = setup({ ...STATES.free_posts, postDates: [] });
    repo.workspacesWithSpentFreePosts.mockRejectedValueOnce(new Error('db down'));
    await expect(service.assertFreePostAllowed('org', save(['ch1']))).resolves.toBeUndefined();
  });

  it('all 3 used: the usual message, not the channel one', async () => {
    const { service } = setup({
      ...STATES.free_posts,
      postDates: [1, 2, 3].map((d) => new Date(`2026-10-2${d}T10:00:00Z`)),
      spentChannels: ['instagram-standalone'],
    });
    await expect(service.assertFreePostAllowed('org', save(['ch1']))).rejects.toMatchObject({
      message: "You've used your 3 free posts. Pick a plan to keep posting.",
    });
  });

  it('one of our own workspaces (a platform super admin member) is not refused', async () => {
    const { service, repo } = setup({
      ...STATES.free_posts,
      superAdmins: 1,
      spentChannels: ['instagram-standalone'],
    });
    await expect(service.assertFreePostAllowed('org', save(['ch1']))).resolves.toBeUndefined();
    expect(repo.workspacesWithSpentFreePosts).not.toHaveBeenCalled();
  });

  it('a workspace in FREE_PLAN_SUNSET_EXEMPT_ORGS is not refused', async () => {
    process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = 'org';
    const { service } = setup({ ...STATES.free_posts, spentChannels: ['instagram-standalone'] });
    await expect(service.assertFreePostAllowed('org', save(['ch1']))).resolves.toBeUndefined();
  });

  it.each(['free', 'locked', 'trialing', 'active', 'cancelling'])(
    '%s (lifetime, paid, marketplace plans included): never asked',
    async (state) => {
      const { service, repo } = setup({
        ...STATES[state],
        spentChannels: ['instagram-standalone'],
      });
      const s = save(['ch1']);
      await expect(service.assertFreePostAllowed('org', s)).resolves.toBeUndefined();
      expect(repo.workspacesWithSpentFreePosts).not.toHaveBeenCalled();
      // Nor are the save's posts read for it.
      expect(s.channelsGainingPosts).not.toHaveBeenCalled();
    }
  );

  it('a lifetime plan is never asked', async () => {
    const { service, repo } = setup({
      ...STATES.active,
      subscription: { ...ROW, isLifetime: true },
      spentChannels: ['instagram-standalone'],
    });
    await expect(service.assertFreePostAllowed('org', save(['ch1']))).resolves.toBeUndefined();
    expect(repo.workspacesWithSpentFreePosts).not.toHaveBeenCalled();
  });
});

describe('forUser: the composer names only your own workspace (owner copy, 29 Oct item 11)', () => {
  const spentError = () => {
    const e = new PlanRequiredError('FREE_POSTS_USED', 7, 'general');
    e.spentIn = { provider: 'LinkedIn', organizationIds: ['theirs', 'mine'] };
    return e;
  };
  const build = (names: Record<string, string | null>, left: Record<string, number>) => {
    const { service, repo } = setup({ ...STATES.free_posts, postDates: [] });
    (repo as any).memberWorkspaceName = jest.fn(async (_u: string, org: string) => names[org] ?? null);
    jest.spyOn(service, 'freePostsUsage').mockImplementation(async (org: string) =>
      left[org] === undefined ? null : ({ left: left[org] } as any)
    );
    return service;
  };

  it('a member workspace with posts left: named, with switchTo', async () => {
    const service = build({ mine: 'My Studio' }, { theirs: 3, mine: 2 });
    const out: any = await service.forUser(spentError(), 'u1');
    expect(out.getResponse()).toEqual({
      code: 'FREE_POSTS_USED',
      message: 'Your workspace "My Studio" still has 2 free posts with this LinkedIn account. Switch to it from the workspace menu to use them, or pick a plan to post from here.',
      switchTo: { id: 'mine', name: 'My Studio', left: 2 },
    });
  });

  it('never a workspace the user is not in, however many posts it has', async () => {
    const service = build({}, { theirs: 3 });
    const e = spentError();
    expect(await service.forUser(e, 'u1')).toBe(e);
  });

  it('a member workspace with none left: the general copy', async () => {
    const service = build({ mine: 'My Studio' }, { mine: 0 });
    const e = spentError();
    expect(await service.forUser(e, 'u1')).toBe(e);
  });

  it('no user (public API, MCP) or another error: unchanged', async () => {
    const service = build({ mine: 'My Studio' }, { mine: 2 });
    const e = spentError();
    expect(await service.forUser(e, undefined)).toBe(e);
    const other = new Error('x');
    expect(await service.forUser(other, 'u1')).toBe(other);
  });

  it('several candidates: skips one the user is not in, names the next one they are', async () => {
    const service = build({ mine: 'Second Brand' }, { theirs: 3, mine: 1 });
    const out: any = await service.forUser(spentError(), 'u1');
    expect(out.getResponse().switchTo).toEqual({ id: 'mine', name: 'Second Brand', left: 1 });
    expect(out.getResponse().message).toContain('1 free post with this LinkedIn account');
  });
});
