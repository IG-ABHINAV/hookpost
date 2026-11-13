import 'reflect-metadata';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { TRIAL_DAYS } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

// The trial's length at checkout: a trial started now takes its first charge
// TRIAL_DAYS (3) days later, the number every page prints (22 Oct 2026, 7
// before). Razorpay is a fake that records what subscribe() creates.
//   pnpm exec jest -c apps/backend/jest.config.ts razorpay.trial-length

// Only injection tokens for the two services under test; the real modules
// pull in Prisma, Redis and storage clients.
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository',
  () => ({ AffiliateRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.repository',
  () => ({ SubscriptionRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
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

const mockRequest = jest.fn();
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));


const setup = (redemptions = 0, sunsetNoticePromised = false) => {
  const repo = {
    sunsetNoticePromisedTrial: jest.fn(async () => sunsetNoticePromised),
    findCouponByCode: jest.fn(async () => null),
    countCouponRedemptions: jest.fn(async () => redemptions),
    hasRedeemedCoupon: jest.fn(async () => false),
    getSubscription: jest.fn(async () => null),
    updateCustomerId: jest.fn(),
  };
  const subscriptions = new SubscriptionService(
    repo as any,
    {} as any,
    {} as any,
    {} as any
  );
  const organizations = {
    getOrgById: jest.fn(async (id: string) => ({ id, paymentId: 'cust_1' })),
  };
  const razorpay = new RazorpayService(
    subscriptions,
    organizations as any,
    {} as any,
    {} as any,
    {} as any
  );

  const created: { plans: any[]; subscriptions: any[] } = {
    plans: [],
    subscriptions: [],
  };
  mockRequest.mockReset();
  mockRequest.mockImplementation(async (method: string, path: string, body: any) => {
    if (method === 'GET' && path.startsWith('/plans')) return { items: [] };
    if (method === 'POST' && path === '/plans') {
      created.plans.push(body);
      return { id: `plan_${created.plans.length}` };
    }
    if (method === 'POST' && path === '/subscriptions') {
      created.subscriptions.push(body);
      return { id: 'sub_1', short_url: 'https://rzp.io/i/x' };
    }
    if (method === 'GET' && path.includes('/subscriptions')) return { items: [] };
    throw new Error(`unexpected Razorpay call ${method} ${path}`);
  });

  return { subscriptions, razorpay, created, repo };
};

const DAY = 86400;
const ENV = process.env.RAZORPAY_TRIAL_DAYS;
afterEach(() => {
  if (ENV === undefined) delete process.env.RAZORPAY_TRIAL_DAYS;
  else process.env.RAZORPAY_TRIAL_DAYS = ENV;
});

const subscribe = async (
  allowTrial: boolean,
  period = 'MONTHLY',
  sunsetNoticePromised = false
) => {
  const { razorpay, created } = setup(0, sunsetNoticePromised);
  const before = Math.floor(Date.now() / 1000);
  await razorpay.subscribe('ud-1', 'org-1', 'user-1', { billing: 'STANDARD', period } as any, allowTrial);
  const after = Math.floor(Date.now() / 1000);
  return { body: created.subscriptions[0], before, after };
};

describe('subscribe(): the trial is TRIAL_DAYS long', () => {
  it('TRIAL_DAYS is 3', () => {
    expect(TRIAL_DAYS).toBe(3);
  });

  it.each(['MONTHLY', 'YEARLY'])('a %s trial: the first charge (start_at) is 3 days from now', async (period) => {
    delete process.env.RAZORPAY_TRIAL_DAYS;
    const { body, before, after } = await subscribe(true, period);
    expect(body.start_at).toBeGreaterThanOrEqual(before + 3 * DAY);
    expect(body.start_at).toBeLessThanOrEqual(after + 3 * DAY);
  });

  it('an empty RAZORPAY_TRIAL_DAYS (how .env ships) is the same 3 days', async () => {
    process.env.RAZORPAY_TRIAL_DAYS = '';
    const { body, before } = await subscribe(true);
    expect(body.start_at - before).toBeGreaterThanOrEqual(3 * DAY);
    expect(body.start_at - before).toBeLessThan(3 * DAY + 60);
  });

  it('a workspace whose trial is used is charged on approval: no start_at', async () => {
    delete process.env.RAZORPAY_TRIAL_DAYS;
    const { body } = await subscribe(false);
    expect(body.start_at).toBeUndefined();
  });

  it('RAZORPAY_TRIAL_DAYS=0 still turns trials off', async () => {
    process.env.RAZORPAY_TRIAL_DAYS = '0';
    const { body } = await subscribe(true);
    expect(body.start_at).toBeUndefined();
  });
});

// The Free plan sunset email of 21 Oct 2026 told 25 workspaces "start the
// 7-day trial". Theirs is 7 days; the 3-day change applies to everyone else.
describe('subscribe(): a workspace the sunset email promised 7 days', () => {
  it('gets a 7-day trial (start_at 7 days on)', async () => {
    delete process.env.RAZORPAY_TRIAL_DAYS;
    const { body, before, after } = await subscribe(true, 'MONTHLY', true);
    expect(body.start_at).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(body.start_at).toBeLessThanOrEqual(after + 7 * DAY);
  });

  it('yearly too', async () => {
    delete process.env.RAZORPAY_TRIAL_DAYS;
    const { body, before } = await subscribe(true, 'YEARLY', true);
    expect(body.start_at - before).toBeGreaterThanOrEqual(7 * DAY);
    expect(body.start_at - before).toBeLessThan(7 * DAY + 60);
  });

  it('with its trial used it is charged on approval, like anyone, and nothing is looked up', async () => {
    delete process.env.RAZORPAY_TRIAL_DAYS;
    const { razorpay, created, repo } = setup(0, true);
    await razorpay.subscribe('ud-1', 'org-1', 'user-1', { billing: 'STANDARD', period: 'MONTHLY' } as any, false);
    expect(created.subscriptions[0].start_at).toBeUndefined();
    expect(repo.sunsetNoticePromisedTrial).not.toHaveBeenCalled();
  });

  it('RAZORPAY_TRIAL_DAYS=0 turns its trial off too', async () => {
    process.env.RAZORPAY_TRIAL_DAYS = '0';
    const { body } = await subscribe(true, 'MONTHLY', true);
    expect(body.start_at).toBeUndefined();
  });

  it('a workspace the email did not reach still gets 3', async () => {
    delete process.env.RAZORPAY_TRIAL_DAYS;
    const { body, before } = await subscribe(true, 'MONTHLY', false);
    expect(body.start_at - before).toBeGreaterThanOrEqual(3 * DAY);
    expect(body.start_at - before).toBeLessThan(3 * DAY + 60);
  });
});
