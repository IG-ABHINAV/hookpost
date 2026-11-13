import 'reflect-metadata';
import { buildPlanKey } from '@hookpost/nestjs-libraries/services/razorpay.mapping';

// The trial reminder against a REAL Redis: two RazorpayService instances,
// each loaded in its own module registry with its own ioredis connection (as
// the backend and the orchestrator each run the hourly sweep), sweep at the
// same moment. Exactly one email goes out. Razorpay and Resend are fakes.
//
// Skipped unless TEST_REDIS_URL points at a Redis it may write to (it only
// touches one random key and deletes it). Locally:
//   redis-server --port 6390 --save '' --appendonly no --daemonize yes
//   TEST_REDIS_URL=redis://127.0.0.1:6390 \
//     pnpm exec jest -c apps/backend/jest.config.ts trial-reminder.redis
//   redis-cli -p 6390 shutdown nosave

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
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

const mockSent: any[] = [];
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: jest.fn(async (msg: any) => {
        // A real send takes a moment; both sweeps are mid-flight together.
        await new Promise((r) => setTimeout(r, 20));
        mockSent.push(msg);
        return { data: { id: `email_${mockSent.length}` }, error: null };
      }),
    },
  })),
}));

const ORG = 'org-chai';
const SUB = `sub_redis_${Math.random().toString(36).slice(2, 10)}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const mockSubscription = {
  id: SUB,
  created_at: nowSec() - 5 * 86400,
  status: 'authenticated',
  plan_id: 'plan_std',
  customer_id: 'cust_1',
  payment_method: 'upi',
  start_at: nowSec() + 48 * 3600,
  current_start: null,
  current_end: null,
  paid_count: 0,
  end_at: nowSec() + 3650 * 86400,
  notes: { service: 'hookpost', orgId: ORG, billing: 'STANDARD', period: 'MONTHLY' },
};
const mockPlan = {
  id: 'plan_std',
  period: 'monthly',
  item: { amount: 59900, currency: 'INR' },
  notes: { hookpost_key: buildPlanKey('STANDARD', 'MONTHLY', 59900, 'INR') },
};
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({
    request: jest.fn(async (method: string, path: string) => {
      await new Promise((r) => setTimeout(r, 5));
      if (method === 'GET' && path === `/subscriptions/${mockSubscription.id}`) {
        return { ...mockSubscription };
      }
      if (method === 'GET' && path === '/plans/plan_std') return mockPlan;
      if (method === 'GET' && path === '/plans') return { items: [mockPlan] };
      throw new Error(`unexpected Razorpay call ${method} ${path}`);
    }),
  })),
}));

const REDIS = process.env.TEST_REDIS_URL;
const maybe = REDIS ? describe : describe.skip;

type Instance = { razorpay: any; redis: any };

/** One RazorpayService with its own module registry, hence its own Redis connection. */
function instance(): Instance {
  let out: Instance | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RazorpayService } = require('@hookpost/nestjs-libraries/services/razorpay.service');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ioRedis } = require('@hookpost/nestjs-libraries/redis/redis.service');
    const row = {
      organizationId: ORG,
      identifier: SUB,
      subscriptionTier: 'STANDARD',
      period: 'MONTHLY',
    };
    const razorpay = new RazorpayService(
      {
        getTrialingRows: jest.fn(async () => [row]),
        getSubscription: jest.fn(async () => row),
      } as any,
      {
        getOrgById: jest.fn(async () => ({ id: ORG, name: 'Chai Point Social' })),
        getTeam: jest.fn(async () => ({ users: [{ user: { email: 'priya@chaipoint.in' } }] })),
      } as any,
      {} as any,
      {} as any,
      {} as any
    );
    out = { razorpay, redis: ioRedis };
  });
  return out!;
}

maybe('trial reminder, two service instances, one real Redis', () => {
  const ENV = { ...process.env };
  const key = `razorpay:customer-email:trial-reminder:${SUB}`;
  let a: Instance;
  let b: Instance;

  beforeAll(async () => {
    process.env.REDIS_URL = REDIS;
    process.env.RESEND_API_KEY = 're_test';
    process.env.TRIAL_REQUIRED_SINCE_IN = '2026-10-20T00:00:00Z';
    a = instance();
    b = instance();
    expect(a.redis).not.toBe(b.redis);
    await a.redis.del(key);
  });

  afterAll(async () => {
    await a.redis.del(key).catch(() => undefined);
    await a.redis.quit().catch(() => undefined);
    await b.redis.quit().catch(() => undefined);
    process.env = ENV;
  });

  it('both sweep at once: exactly one email, and later sweeps send none', async () => {
    const [ra, rb] = await Promise.all([
      a.razorpay.sendTrialReminders(),
      b.razorpay.sendTrialReminders(),
    ]);
    expect(ra.sent + rb.sent).toBe(1);
    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].subject).toMatch(/^Your Hookpost Standard trial ends on /);
    expect(await a.redis.get(key)).toBeTruthy();
    expect(await b.redis.ttl(key)).toBeGreaterThan(30 * 86400);

    await a.razorpay.sendTrialReminders();
    await b.razorpay.sendTrialReminders();
    expect(mockSent).toHaveLength(1);
  });
});
