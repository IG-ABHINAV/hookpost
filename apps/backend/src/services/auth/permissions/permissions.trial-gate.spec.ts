import 'reflect-metadata';

// The trial gate on every plan check (PermissionsService.evaluate,
// PoliciesGuard, SubscriptionExceptionFilter), per plan state. A workspace
// that has to start its trial (needs_trial) or choose a plan (locked) is
// refused every plan check with a 402 carrying TRIAL_REQUIRED or
// PLAN_REQUIRED, and can still reach Billing (ADMIN is a role check). Every
// other state answers exactly what it answered before the gate existed.
// Real SubscriptionService and PermissionsService; the database is a fake.
//   pnpm exec jest -c apps/backend/jest.config.ts permissions.trial-gate

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
jest.mock('@hookpost/nestjs-libraries/database/prisma/posts/posts.service', () => ({
  PostsService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/webhooks/webhooks.service', () => ({
  WebhooksService: class {},
}));

import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { PermissionsService } from '@hookpost/backend/services/auth/permissions/permissions.service';
import { PoliciesGuard } from '@hookpost/backend/services/auth/permissions/permissions.guard';
import { SubscriptionExceptionFilter } from '@hookpost/backend/services/auth/permissions/subscription.exception';
import {
  AuthorizationActions,
  Sections,
  SubscriptionException,
} from '@hookpost/backend/services/auth/permissions/permission.exception.class';

const CUTOFF = '2026-10-20T00:00:00Z';
const BEFORE = new Date('2026-10-01T00:00:00Z');
const AFTER = new Date('2026-10-22T00:00:00Z');

type Facts = {
  createdAt: Date;
  allowTrial: boolean;
  isTrailing: boolean;
  subscription: any;
  country?: string | null;
  /** FREE_PLAN_SUNSET_AT has passed (set by build()). */
  sunset?: boolean;
};

const STD = {
  subscriptionTier: 'STANDARD',
  totalChannels: 5,
  isLifetime: false,
  cancelAt: null,
  deletedAt: null,
  identifier: 'sub_x',
  createdAt: new Date(),
};

const STATES: Record<string, Facts> = {
  free: { createdAt: BEFORE, allowTrial: true, isTrailing: true, subscription: null },
  // A new sign-up: its free posts, nothing gated (28 Oct 2026).
  free_posts: { createdAt: AFTER, allowTrial: true, isTrailing: true, subscription: null },
  // Grandfathered, and the Free plan sunset has passed: free posts, nothing
  // gated (4 Nov 2026, one rule; it was the trial gate, needs_trial, before).
  past_sunset: { createdAt: BEFORE, allowTrial: true, isTrailing: true, subscription: null, sunset: true },
  locked: { createdAt: AFTER, allowTrial: false, isTrailing: false, subscription: null },
  trialing: { createdAt: AFTER, allowTrial: false, isTrailing: true, subscription: STD },
  active: { createdAt: AFTER, allowTrial: false, isTrailing: false, subscription: STD },
  cancelling: {
    createdAt: AFTER,
    allowTrial: false,
    isTrailing: true,
    subscription: { ...STD, cancelAt: new Date(Date.now() + 86_400_000) },
  },
};

// internalId is the platform's account id, which the reconnect link carries
// (?refresh=, launches.component.tsx); id is the database id. They differ.
type ChannelRow = {
  id: string;
  internalId?: string;
  refreshNeeded?: boolean;
  inBetweenSteps?: boolean;
  deletedAt?: Date | null;
};

function build(facts: Facts, sunsetNoticePromised = false, channels: ChannelRow[] = []) {
  if (facts.sunset) process.env.FREE_PLAN_SUNSET_AT = '2026-10-21T00:00:00Z';
  else delete process.env.FREE_PLAN_SUNSET_AT;
  const repo = {
    sunsetNoticePromisedTrial: jest.fn(async () => sunsetNoticePromised),
    getPlanFacts: jest.fn(async () => ({
      id: 'org',
      createdAt: facts.createdAt,
      allowTrial: facts.allowTrial,
      isTrailing: facts.isTrailing,
      subscription: facts.subscription,
      disputedAt: (facts as any).disputedAt ?? null,
      users: [{ user: { signupCountry: facts.country === undefined ? 'IN' : facts.country } }],
    })),
    getSubscriptionByOrganizationId: jest.fn(async () => facts.subscription),
    getSubscription: jest.fn(async () => facts.subscription),
  };
  const subscriptions = new SubscriptionService(repo as any, {} as any, {} as any, {} as any);
  const permissions = new PermissionsService(
    subscriptions,
    { countPostsFromDay: jest.fn(async () => 0) } as any,
    {
      // As the repository lists them: removed channels left out.
      getIntegrationsList: jest.fn(async () =>
        channels
          .filter((c) => !c.deletedAt)
          .map((c) => ({ refreshNeeded: false, inBetweenSteps: false, ...c }))
      ),
      getIntegrationById: jest.fn(async (_org: string, id: string) =>
        channels.find((c) => c.id === id) || null
      ),
      // As the repository reads it: live channels only.
      getIntegrationByInternalId: jest.fn(
        async (_org: string, internalId: string) =>
          channels.find((c) => c.internalId === internalId && !c.deletedAt) ||
          null
      ),
    } as any,
    { getTotal: jest.fn(async () => 0) } as any
  );
  return { repo, subscriptions, permissions };
}

const SECTIONS = [
  Sections.CHANNEL,
  Sections.POSTS_PER_MONTH,
  Sections.WEBHOOKS,
  Sections.AI,
  Sections.TEAM_MEMBERS,
  Sections.IMPORT_FROM_CHANNELS,
  Sections.ADMIN,
];

async function answers(facts: Facts, role: 'USER' | 'ADMIN' | 'SUPERADMIN' = 'ADMIN') {
  const { permissions } = build(facts);
  const out: Record<string, boolean> = {};
  let gate: string | null = null;
  for (const section of SECTIONS) {
    const res = await permissions.evaluate('org', facts.createdAt, role, [
      [AuthorizationActions.Create, section],
    ]);
    out[section] = res.ability.can(AuthorizationActions.Create, section);
    gate = gate || res.gate;
  }
  return { out, gate };
}

const ENV = { ...process.env };
beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_unit';
  process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret_unit';
  delete process.env.TRIAL_REQUIRED_SINCE_IN;
  delete process.env.TRIAL_REQUIRED_SINCE_GLOBAL;
});
afterAll(() => {
  process.env = ENV;
});

describe('the permissions matrix per plan state (TRIAL_REQUIRED_SINCE_IN set)', () => {
  for (const [state, facts] of Object.entries(STATES)) {
    it(`${state}`, async () => {
      // What the check said before the gate: same workspace, cutoff empty.
      const before = await answers(facts);
      process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
      const after = await answers(facts);

      if (state === 'locked') {
        expect(after.gate).toBe('PLAN_REQUIRED');
        for (const section of SECTIONS) {
          // Billing, the API key page and the team page stay reachable.
          const allowed = section === Sections.ADMIN;
          expect([section, after.out[section]]).toEqual([section, allowed]);
        }
        // The Free plan used to let it connect and post.
        expect(before.out[Sections.CHANNEL]).toBe(true);
        expect(before.out[Sections.POSTS_PER_MONTH]).toBe(true);
      } else if (state === 'cancelling') {
        // A plan set to end keeps its channels and posts until cancelAt, but
        // loses AI at once (trial.policy.ts allowsVariableCostFeatures):
        // AI costs Hookpost per call. Everything else answers as before.
        expect(after.gate).toBeNull();
        expect(before.out[Sections.AI]).toBe(true);
        expect(after.out).toEqual({ ...before.out, [Sections.AI]: false });
      } else {
        expect(after.gate).toBeNull();
        expect(after.out).toEqual(before.out);
      }
    });
  }

  it('a plain member of a blocked workspace is refused ADMIN, as before', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { out } = await answers(STATES.locked, 'USER');
    expect(out[Sections.ADMIN]).toBe(false);
  });

  it('a workspace outside India is not gated by the India cutoff', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { gate, out } = await answers({ ...STATES.past_sunset, country: 'US' });
    expect(gate).toBeNull();
    expect(out[Sections.CHANNEL]).toBe(true);
  });

  // The request's country stands in for a missing signup country in the new
  // cohort only; the sunset reads what is on file (trial.policy.ts).
  it('an owner with no signup country falls back to the request country', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { subscriptions, permissions } = build({ ...STATES.free_posts, country: null });
    expect((await subscriptions.getPlanState('org', { requestCountry: 'IN' })).state).toBe('free_posts');
    expect((await subscriptions.getPlanState('org', { requestCountry: 'US' })).state).toBe('free');
    const res = await permissions.evaluate('org', AFTER, 'ADMIN', [[AuthorizationActions.Create, Sections.CHANNEL]], undefined, {
      requestCountry: 'IN',
    });
    expect(res.gate).toBeNull();
  });
});

describe('ships dark', () => {
  it('with both cutoffs empty nothing is gated: only the chargeback lock is looked up', async () => {
    const { permissions, repo } = build(STATES.past_sunset);
    const res = await permissions.evaluate('org', AFTER, 'ADMIN', [
      [AuthorizationActions.Create, Sections.CHANNEL],
    ]);
    expect(res.gate).toBeNull();
    expect(res.ability.can(AuthorizationActions.Create, Sections.CHANNEL)).toBe(true);
    // One read, for workspaceDisputed, which holds whatever the cutoffs say.
    expect(repo.getPlanFacts).toHaveBeenCalledTimes(1);
  });

  it('with both cutoffs empty a disputed workspace is refused all but Billing (PLAN_REQUIRED)', async () => {
    const { permissions } = build({ ...STATES.free, disputedAt: new Date() } as any);
    const res = await permissions.evaluate('org', AFTER, 'ADMIN', [
      [AuthorizationActions.Create, Sections.POSTS_PER_MONTH],
      [AuthorizationActions.Create, Sections.ADMIN],
    ]);
    expect(res.gate).toBe('PLAN_REQUIRED');
    expect(res.ability.can(AuthorizationActions.Create, Sections.POSTS_PER_MONTH)).toBe(false);
    expect(res.ability.can(AuthorizationActions.Create, Sections.ADMIN)).toBe(true);
  });

  it('a value that is not a UTC timestamp fails open: nobody is locked', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.TRIAL_REQUIRED_SINCE_IN = '2026-13-01';
    const { gate, out } = await answers(STATES.past_sunset);
    expect(gate).toBeNull();
    expect(out[Sections.CHANNEL]).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a workspace that cannot be read is not gated', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const { permissions, repo } = build(STATES.past_sunset);
    repo.getPlanFacts.mockRejectedValueOnce(new Error('db down'));
    const res = await permissions.evaluate('org', AFTER, 'ADMIN', [
      [AuthorizationActions.Create, Sections.CHANNEL],
    ]);
    expect(res.gate).toBeNull();
  });
});

describe('PoliciesGuard and the 402 body', () => {
  const run = async (facts: Facts, handlers: any[], path = '/posts', sunsetNoticePromised = false) => {
    const { permissions } = build(facts, sunsetNoticePromised);
    const guard = new PoliciesGuard({ get: () => handlers } as any, permissions);
    const request = {
      path,
      query: {},
      headers: { 'cf-ipcountry': 'IN' },
      org: {
        id: 'org',
        createdAt: facts.createdAt,
        allowTrial: facts.allowTrial,
        subscription: facts.subscription,
        users: [{ role: 'ADMIN' }],
      },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => () => undefined,
    } as any;
    try {
      await guard.canActivate(context);
      return { allowed: true as const, request };
    } catch (exception) {
      return { allowed: false as const, exception, request };
    }
  };

  const respond = (exception: any, request: any) => {
    const json = jest.fn();
    const response = { status: jest.fn(() => ({ json })) };
    new SubscriptionExceptionFilter().catch(exception, {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    } as any);
    return { status: (response.status.mock.calls[0] as any)[0], body: json.mock.calls[0][0] };
  };

  it('locked connecting a channel: 402 PLAN_REQUIRED, "Choose a plan to continue."', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const res = await run(STATES.locked, [[AuthorizationActions.Create, Sections.CHANNEL]]);
    const { body } = respond(res.exception, res.request);
    expect(body).toMatchObject({ code: 'PLAN_REQUIRED', message: 'Choose a plan to continue.', trial: false });
  });

  it('locked still reaches Billing (ADMIN routes)', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const res = await run(STATES.locked, [[AuthorizationActions.Create, Sections.ADMIN]], '/billing/invoices');
    expect(res.allowed).toBe(true);
  });

  it('the same workspace over a Free limit is offered a 7-day trial', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const res = await run(STATES.free, [[AuthorizationActions.Create, Sections.AI]], '/posts', true);
    const { body } = respond(res.exception, res.request);
    expect(body.message).toMatch(/Start a 7-day free trial of Standard/);
    expect(body.trialDays).toBe(7);
  });

  it('a used trial is not looked up', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const locked = await run(STATES.locked, [[AuthorizationActions.Create, Sections.CHANNEL]], '/posts', true);
    const body = respond(locked.exception, locked.request).body;
    expect(body.trialDays).toBeUndefined();
    expect(body.message).toBe('Choose a plan to continue.');
  });

  it('a grandfathered Free workspace over its limit gets the Free plan message, no code', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const res = await run(STATES.free, [[AuthorizationActions.Create, Sections.AI]]);
    const { body } = respond(res.exception, res.request);
    expect(body.code).toBeUndefined();
    expect(body.trial).toBe(true);
  });
});

// The connect-first gate (needs_trial may connect PRE_TRIAL_CHANNEL_LIMIT
// channel and nothing else) went with needs_trial on 4 Nov 2026: a
// grandfathered workspace the sunset reached is on its free posts now (the
// matrix above, past_sunset).

// A failing payment (29 Oct 2026, the owner's call): while Razorpay retries,
// only AI and X go off; every other plan check answers as for a paid plan.
// The marker is Subscription.paymentFailingSince, set by the webhooks.
describe('a failing payment (dunning): AI off, everything else as before', () => {
  const failing: Facts = {
    ...STATES.active,
    subscription: { ...STD, paymentFailingSince: new Date('2026-10-30T00:00:00Z') },
  };

  for (const cutoff of [undefined, CUTOFF]) {
    it(`AI refused, the rest unchanged (trial cutoff ${cutoff ? 'set' : 'empty'})`, async () => {
      if (cutoff) process.env.TRIAL_REQUIRED_SINCE_IN = cutoff;
      const paid = await answers(STATES.active);
      const dunning = await answers(failing);
      expect(dunning.gate).toBeNull();
      expect(paid.out[Sections.AI]).toBe(true);
      expect(dunning.out).toEqual({ ...paid.out, [Sections.AI]: false });
    });
  }

  it('a trial whose first charge failed is treated the same', async () => {
    const trial = await answers({ ...failing, isTrailing: true });
    expect(trial.out[Sections.AI]).toBe(false);
    expect(trial.out[Sections.POSTS_PER_MONTH]).toBe(true);
    expect(trial.out[Sections.CHANNEL]).toBe(true);
  });

  it('cancelling keeps AI while the cohort rules are off (no new cut beside dunning)', async () => {
    const { out } = await answers(STATES.cancelling);
    expect(out[Sections.AI]).toBe(true);
  });

  it('a lifetime plan is never dunning', async () => {
    const { out } = await answers({
      ...failing,
      subscription: { ...failing.subscription, isLifetime: true },
    });
    expect(out[Sections.AI]).toBe(true);
  });

  it('the 402 says the payment failed and links to paying from another account', async () => {
    const { permissions } = build(failing);
    const guard = new PoliciesGuard(
      { get: () => [[AuthorizationActions.Create, Sections.AI]] } as any,
      permissions
    );
    const request: any = {
      path: '/copilot/chat',
      query: {},
      headers: {},
      org: { id: 'org', createdAt: AFTER, allowTrial: false, subscription: failing.subscription, users: [{ role: 'ADMIN' }] },
    };
    let thrown: any;
    try {
      await guard.canActivate({
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => () => undefined,
      } as any);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SubscriptionException);
    const json = jest.fn();
    const response = { status: jest.fn(() => ({ json })) };
    new SubscriptionExceptionFilter().catch(thrown, {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    } as any);
    expect((response.status.mock.calls[0] as any)[0]).toBe(402);
    const body = json.mock.calls[0][0];
    expect(body.code).toBe('PAYMENT_FAILING');
    expect(body.message).toMatch(/AI and X are paused/);
    expect(body.message).not.toMatch(/upgrade|choose a plan/i);
    expect(body.url).toMatch(/\/billing\?pay=another-account$/);
  });

  it('a post (no AI) passes the guard while the payment is failing', async () => {
    const { permissions } = build(failing);
    const guard = new PoliciesGuard(
      { get: () => [[AuthorizationActions.Create, Sections.POSTS_PER_MONTH]] } as any,
      permissions
    );
    const request: any = {
      path: '/posts',
      query: {},
      headers: {},
      org: { id: 'org', createdAt: AFTER, allowTrial: false, subscription: failing.subscription, users: [{ role: 'ADMIN' }] },
    };
    await expect(
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => () => undefined,
      } as any)
    ).resolves.toBe(true);
  });
});

// 1 Nov 2026: whether a workspace is on its free posts is read from its own
// billing facts (the owner's signup country), not the request's. An Indian
// owner on free posts whose request comes from abroad (an MCP call from a US
// server) was told "Start a 3-day free trial" at the channel limit, a trial
// its checkout never starts.
describe('PoliciesGuard: a free_posts workspace at a limit, request from abroad', () => {
  afterEach(() => {
    delete process.env.TRIAL_CHECKOUT;
  });

  const refuse = async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const facts = STATES.free_posts; // owner's signup country: IN
    const { permissions } = build(facts, false, [{ id: 'ch-1' }, { id: 'ch-2' }]);
    const guard = new PoliciesGuard(
      { get: () => [[AuthorizationActions.Create, Sections.CHANNEL]] } as any,
      permissions
    );
    const request = {
      path: '/integrations/social/linkedin',
      query: {},
      headers: { 'cf-ipcountry': 'US' },
      org: {
        id: 'org',
        createdAt: facts.createdAt,
        allowTrial: facts.allowTrial,
        subscription: null as any,
        users: [{ role: 'ADMIN' }],
      },
    };
    const exception: any = await guard
      .canActivate({
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => (): undefined => undefined,
      } as any)
      .then(
        () => null,
        (e) => e
      );
    const json = jest.fn();
    const response = { status: jest.fn(() => ({ json })) };
    new SubscriptionExceptionFilter().catch(exception, {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    } as any);
    return { exception, body: (json.mock.calls[0] as any)[0] };
  };

  it('is never offered a trial, and is not told it is on the Free plan', async () => {
    process.env.TRIAL_CHECKOUT = 'off';
    const { exception, body } = await refuse();
    expect(exception).toBeInstanceOf(SubscriptionException);
    expect(exception.getResponse()).toMatchObject({ freePosts: true });
    expect(exception.getResponse().trialDays).toBeUndefined();
    expect(body.trial).toBe(false);
    expect(body.message).toMatch(/^Your free posts include 2 channels\. Upgrade to Standard/);
    expect(body.message).not.toMatch(/trial|Free plan/i);
  });

  it('with the trial switch on: offered its trial by its length, still no Free plan', async () => {
    process.env.TRIAL_CHECKOUT = 'on';
    const { exception, body } = await refuse();
    expect(exception.getResponse()).toMatchObject({ freePosts: true, trialDays: 3 });
    expect(body.trial).toBe(true);
    expect(body.message).toMatch(/^Your free posts include 2 channels\. Start a 3-day free trial/);
    expect(body.message).not.toMatch(/Free plan/);
  });
});
