/**
 * SubscriptionService.publishWithinPlan for api.market workspaces: the
 * orchestrator holds every publish and reply of an `apimkt:` workspace to its
 * marketplace plan, billing on or off, before anything reaches a network.
 *   pnpm exec jest -c apps/backend/jest.config.ts subscription.marketplace-gate
 */
jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
  PrismaTransaction: class {},
  PrismaService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository', () => ({
  AffiliateRepository: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/integrations/integration.service', () => ({
  IntegrationService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/organizations/organization.service', () => ({
  OrganizationService: class {},
}));

import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { MarketplacePublishRefusedError } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.publish.error';
import { PlanRequiredError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.required.error';

const ORG = 'org-mkt';

const setup = (
  subscription: { identifier: string } | null,
  account: { product: string; plan: string; status: string } | null
) => {
  const repository = {
    getSubscription: jest.fn(async () =>
      subscription ? { ...subscription, isLifetime: false, cancelAt: null, deletedAt: null } : null
    ),
    getMarketplaceAccountFacts: jest.fn(async () => account),
    getPlanFacts: jest.fn(async () => ({
      id: ORG,
      createdAt: new Date('2026-10-25T00:00:00Z'),
      allowTrial: false,
      isTrailing: false,
      subscription: subscription
        ? { ...subscription, isLifetime: false, cancelAt: null, deletedAt: null }
        : null,
      users: [],
      _count: { users: 0 },
    })),
  };
  const service = new SubscriptionService(repository as any, {} as any, {} as any, {} as any);
  return { service, repository };
};

const saved = process.env.RAZORPAY_KEY_SECRET;
afterEach(() => {
  if (saved === undefined) delete process.env.RAZORPAY_KEY_SECRET;
  else process.env.RAZORPAY_KEY_SECRET = saved;
  delete process.env.MKT_DISABLED_PRODUCTS;
  delete process.env.MKT_GATEWAY_SECRETS_X;
  delete process.env.MKT_RAPIDAPI_SECRETS_X;
});

describe.each([
  ['billing on', 'rzp_secret_unit', '', ''],
  ['billing off, api.market on', '', 'a-gateway-secret-of-at-least-32-characters', ''],
  ['billing off, only RapidAPI on', '', '', 'a-rapidapi-proxy-secret-0123456789'],
])('marketplace workspaces, %s', (_mode, secret, gateway, rapid) => {
  beforeEach(() => {
    if (secret) process.env.RAZORPAY_KEY_SECRET = secret;
    else delete process.env.RAZORPAY_KEY_SECRET;
    if (gateway) process.env.MKT_GATEWAY_SECRETS_X = gateway;
    if (rapid) process.env.MKT_RAPIDAPI_SECRETS_X = rapid;
  });

  it('holds a RapidAPI subscriber\'s workspace (apimkt:<product>:rapidapi:<user>) to its plan too', async () => {
    const { service } = setup({ identifier: 'apimkt:social:rapidapi:jane' }, { product: 'social', plan: 'trial', status: 'ACTIVE' });
    const publish = jest.fn(async () => 'posted');
    await expect(service.publishWithinPlan(ORG, publish, 'x')).rejects.toBeInstanceOf(MarketplacePublishRefusedError);
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses X for the Social trial without calling X, as a PlanRequiredError the orchestrator ends the post with', async () => {
    const { service } = setup({ identifier: 'apimkt:social:u1' }, { product: 'social', plan: 'trial', status: 'ACTIVE' });
    const publish = jest.fn(async () => 'posted');
    const attempt = service.publishWithinPlan(ORG, publish, 'x');
    await expect(attempt).rejects.toBeInstanceOf(MarketplacePublishRefusedError);
    await expect(attempt).rejects.toBeInstanceOf(PlanRequiredError);
    await expect(attempt).rejects.toThrow(/does not include X/);
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes the trial\'s other networks, and X on a paid plan', async () => {
    const trial = setup({ identifier: 'apimkt:social:u1' }, { product: 'social', plan: 'trial', status: 'ACTIVE' });
    await expect(trial.service.publishWithinPlan(ORG, async () => 'ok', 'linkedin')).resolves.toBe('ok');
    const paid = setup({ identifier: 'apimkt:social:u2' }, { product: 'social', plan: 'standard', status: 'ACTIVE' });
    await expect(paid.service.publishWithinPlan(ORG, async () => 'ok', 'x')).resolves.toBe('ok');
  });

  it('refuses a blocked account and a paused product on every network', async () => {
    const blocked = setup({ identifier: 'apimkt:x:u3' }, { product: 'x', plan: 'pro', status: 'BLOCKED' });
    const publish = jest.fn(async () => 'posted');
    await expect(blocked.service.publishWithinPlan(ORG, publish, 'x')).rejects.toThrow(/blocked/);
    process.env.MKT_DISABLED_PRODUCTS = 'x';
    const paused = setup({ identifier: 'apimkt:x:u4' }, { product: 'x', plan: 'pro', status: 'ACTIVE' });
    await expect(paused.service.publishWithinPlan(ORG, publish, 'x')).rejects.toThrow(/paused/);
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses a workspace whose account row is gone', async () => {
    const { service } = setup({ identifier: 'apimkt:x:u5' }, null);
    await expect(service.publishWithinPlan(ORG, async () => 'ok', 'x')).rejects.toThrow(/not known/);
  });
});

it('never reads the marketplace table for an ordinary plan', async () => {
  process.env.RAZORPAY_KEY_SECRET = 'rzp_secret_unit';
  const { service, repository } = setup({ identifier: 'sub_123' }, null);
  await expect(service.publishWithinPlan(ORG, async () => 'ok', 'linkedin')).resolves.toBe('ok');
  expect(repository.getMarketplaceAccountFacts).not.toHaveBeenCalled();
});

it('an install with neither billing nor the marketplace publishes without looking up a plan', async () => {
  delete process.env.RAZORPAY_KEY_SECRET;
  const { service, repository } = setup({ identifier: 'apimkt:x:u6' }, { product: 'x', plan: 'trial', status: 'BLOCKED' });
  await expect(service.publishWithinPlan(ORG, async () => 'ok', 'x')).resolves.toBe('ok');
  expect(repository.getSubscription).not.toHaveBeenCalled();
});
