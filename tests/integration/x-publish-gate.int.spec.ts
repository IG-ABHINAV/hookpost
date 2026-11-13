/**
 * The X gate against the real database: SubscriptionService.publishWithinPlan
 * (what the orchestrator runs before every publish and reply) and the X
 * connect route, for one real workspace per plan state.
 *
 * X bills Hookpost per post, so only a workspace whose plan is set to end
 * (cancelAt on file) loses X; every other state keeps it, and our own
 * workspaces (a platform super admin member, FREE_PLAN_SUNSET_EXEMPT_ORGS)
 * always do (trial.policy.ts allowsXPublishing). On 24 Oct 2026 the gate read
 * the plan from the bare Organization row, which has no subscription, and
 * refused X for every workspace, paid ones included: these run on rows written
 * the way production writes them, so that cannot pass here again.
 *
 * Nothing reaches X: `publish` is a stub, and the connect test replaces only
 * the provider's request-token call (generateAuthUrl).
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb, givePlan, makeSuperAdmin } from './setup/db';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { PlanRequiredError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.required.error';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';

type State =
  | 'active'
  | 'lifetime'
  | 'trialing'
  | 'cancelling'
  | 'free'
  | 'super admin, no plan'
  | 'super admin, cancelling'
  | 'exempt, no plan'
  | 'exempt, cancelling';

const IN_TWO_DAYS = () => new Date(Date.now() + 2 * 86400_000);

describe('X gate per plan state (real database)', () => {
  let t: TestApp;
  let subscriptions: SubscriptionService;
  const orgs = {} as Record<State, { orgId: string; session: Session }>;
  const savedEnv = {
    exempt: process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS,
    cutoff: process.env.TRIAL_REQUIRED_SINCE_IN,
  };

  async function workspace(state: State) {
    const session = await t.api.register({ company: `X gate ${state}` });
    const { id: userId, orgId } = await session.self();
    const plan = async () => givePlan(orgId, 'STANDARD');
    const cancel = () =>
      db().subscription.update({ where: { organizationId: orgId }, data: { cancelAt: IN_TWO_DAYS() } });
    switch (state) {
      case 'active':
        await plan();
        break;
      case 'lifetime':
        await givePlan(orgId, 'ULTIMATE');
        await db().subscription.update({ where: { organizationId: orgId }, data: { isLifetime: true } });
        break;
      case 'trialing':
        await plan();
        await db().organization.update({ where: { id: orgId }, data: { isTrailing: true } });
        break;
      case 'cancelling':
      case 'exempt, cancelling':
        await plan();
        await cancel();
        break;
      case 'super admin, cancelling':
        await plan();
        await cancel();
        await makeSuperAdmin(userId);
        break;
      case 'super admin, no plan':
        await makeSuperAdmin(userId);
        break;
      case 'free':
      case 'exempt, no plan':
        break;
    }
    orgs[state] = { orgId, session };
  }

  beforeAll(async () => {
    t = await startApp();
    subscriptions = t.get<SubscriptionService>(SubscriptionService);
    for (const state of Object.keys(EXPECTED) as State[]) {
      await workspace(state);
    }
    process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = [
      'some-other-org',
      orgs['exempt, no plan'].orgId,
      orgs['exempt, cancelling'].orgId,
    ].join(',');
  });
  afterAll(async () => {
    for (const [key, name] of [
      ['exempt', 'FREE_PLAN_SUNSET_EXEMPT_ORGS'],
      ['cutoff', 'TRIAL_REQUIRED_SINCE_IN'],
    ] as const) {
      if (savedEnv[key] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[key];
    }
    await t?.close();
    await disconnectDb();
  });

  // What publishWithinPlan(…, 'x') does per state: publish unmetered, publish
  // on the Free plan's posts meter (one credit), or refuse with PLAN_REQUIRED.
  const EXPECTED: Record<State, 'unmetered' | 'metered' | 'refused'> = {
    active: 'unmetered',
    lifetime: 'unmetered',
    trialing: 'unmetered',
    cancelling: 'refused',
    free: 'metered',
    'super admin, no plan': 'metered',
    'super admin, cancelling': 'unmetered',
    'exempt, no plan': 'metered',
    'exempt, cancelling': 'unmetered',
  };

  const postCredits = (organizationId: string) =>
    db().credits.count({ where: { organizationId, type: 'posts' } });

  describe.each([
    ['both trial cutoffs empty', ''],
    // As production runs: the India cutoff set. These workspaces' owners have
    // no signup country, so they are outside the India cohort either way;
    // what changes is that the plan gate reads the trial facts too.
    ['TRIAL_REQUIRED_SINCE_IN set', '2026-10-19T00:00:00Z'],
  ])('publishWithinPlan, %s', (_mode, cutoff) => {
    beforeAll(() => {
      process.env.TRIAL_REQUIRED_SINCE_IN = cutoff;
    });

    it.each(Object.entries(EXPECTED))('%s, X: %s', async (state, expected) => {
      const { orgId } = orgs[state as State];
      const before = await postCredits(orgId);
      const publish = jest.fn(async () => 'posted');
      const attempt = subscriptions.publishWithinPlan(orgId, publish, 'x');

      if (expected === 'refused') {
        await expect(attempt).rejects.toBeInstanceOf(PlanRequiredError);
        await expect(attempt).rejects.toMatchObject({ code: 'PLAN_REQUIRED', status: 402 });
        expect(publish).not.toHaveBeenCalled();
      } else {
        await expect(attempt).resolves.toBe('posted');
        expect(publish).toHaveBeenCalledTimes(1);
      }
      expect(await postCredits(orgId)).toBe(before + (expected === 'metered' ? 1 : 0));
    });

    it('a cancelling plan still publishes to LinkedIn until cancelAt, unmetered', async () => {
      const { orgId } = orgs.cancelling;
      const before = await postCredits(orgId);
      await expect(subscriptions.publishWithinPlan(orgId, async () => 'posted', 'linkedin')).resolves.toBe('posted');
      expect(await postCredits(orgId)).toBe(before);
    });
  });

  describe('connecting X (GET /integrations/social/x)', () => {
    beforeAll(() => {
      process.env.TRIAL_REQUIRED_SINCE_IN = '';
    });
    afterEach(() => jest.restoreAllMocks());

    const x = () => t.get<IntegrationManager>(IntegrationManager).getSocialIntegration('x');

    const connectCases = Object.entries(EXPECTED).map(
      ([state, expected]) => [state, expected === 'refused' ? 'refused' : 'allowed'] as const
    );

    it.each(connectCases)('%s: %s', async (state, expected) => {
      // X's request-token call is the only network step; it never leaves.
      const authUrl = jest.spyOn(x(), 'generateAuthUrl').mockResolvedValue({
        url: 'https://api.x.com/oauth/authenticate?oauth_token=int-test',
        codeVerifier: 'int-token:int-secret',
        state: `int-x-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      const res = await orgs[state as State].session.get('/integrations/social/x');
      if (expected === 'refused') {
        expect(res.status).toBe(402);
        expect(authUrl).not.toHaveBeenCalled();
      } else {
        expect(res.status).toBe(200);
        expect(res.body.url).toContain('oauth_token=int-test');
        expect(authUrl).toHaveBeenCalledTimes(1);
      }
    });
  });
});
