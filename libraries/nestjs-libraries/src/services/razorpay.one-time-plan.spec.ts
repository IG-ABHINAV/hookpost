/**
 * RazorpayService's side of the one-time plan (one.time.plan.service.ts):
 * the webhook hands order events and their refunds over, the sweep ends a
 * paid month without asking Razorpay for a subscription, and the pricing
 * context names the plan in the currency its order charges.
 */
import 'reflect-metadata';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';

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

function build(subscriptions: any = {}, oneTime: any = {}) {
  const oneTimePlan = {
    handleWebhook: jest.fn(async () => true),
    handleRefund: jest.fn(async () => false),
    currencyFor: jest.fn(async () => 'USD'),
    ...oneTime,
  };
  const service = new RazorpayService(
    subscriptions,
    {} as any,
    {} as any,
    {} as any,
    { recordCommission: jest.fn() } as any,
    undefined,
    undefined,
    undefined,
    undefined,
    oneTimePlan as any
  );
  return { service, oneTimePlan };
}

beforeEach(() => mockRequest.mockReset());

describe('webhook routing', () => {
  it('order.paid and payment.captured go to the one-time plan, with the event id', async () => {
    const { service, oneTimePlan } = build();
    const event = { event: 'order.paid', payload: { payment: { entity: { id: 'pay_1' } } } };
    expect(await service.handleWebhook(event, 'evt_1')).toEqual({ ok: true });
    expect(oneTimePlan.handleWebhook).toHaveBeenCalledWith('order.paid', event, 'evt_1');
    await service.handleWebhook({ event: 'payment.captured', payload: {} }, 'evt_2');
    expect(oneTimePlan.handleWebhook).toHaveBeenCalledTimes(2);
  });

  it('a refund of an order payment stops there; any other goes on to the subscription rules', async () => {
    const { service, oneTimePlan } = build({}, { handleRefund: jest.fn(async () => true) });
    const handleRefund = jest.spyOn(service, 'handleRefund').mockResolvedValue(undefined as any);
    await service.handleWebhook({
      event: 'refund.processed',
      payload: { refund: { entity: { payment_id: 'pay_1' } } },
    });
    expect(oneTimePlan.handleRefund).toHaveBeenCalled();
    expect(handleRefund).not.toHaveBeenCalled();

    const other = build();
    const subRefund = jest.spyOn(other.service, 'handleRefund').mockResolvedValue(undefined as any);
    await other.service.handleWebhook({
      event: 'refund.processed',
      payload: { refund: { entity: { payment_id: 'pay_2' } } },
    });
    expect(subRefund).toHaveBeenCalled();
  });
});

describe('a paid month ending', () => {
  it('the sweep ends a lapsed order row without asking Razorpay', async () => {
    const now = new Date('2026-12-08T10:00:00Z');
    const subscriptions = {
      getLapsedCancellations: jest.fn(async () => [
        { organizationId: 'org1', identifier: 'order_A', cancelAt: new Date('2026-12-08T09:59:00Z') },
      ]),
      endOneTimePlan: jest.fn(async () => true),
    };
    const { service } = build(subscriptions);
    expect(await service.endLapsedCancellations(now)).toEqual({ checked: 1, ended: 1 });
    expect(subscriptions.endOneTimePlan).toHaveBeenCalledWith('org1', 'order_A');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('the exact plan-end timer follows an order row', async () => {
    const cancelAt = new Date('2026-12-08T10:00:00Z');
    const { service } = build({
      getSubscription: jest.fn(async () => ({ identifier: 'order_A', cancelAt })),
    });
    expect(await service.planEndDue('org1')).toEqual({
      identifier: 'order_A',
      cancelAt: cancelAt.toISOString(),
    });
  });
});

describe('the single plan on autopay (HOOKPOST tier)', () => {
  it('a new subscription is one INR plan of Rs 699 (69900 paise) for every buyer', async () => {
    const { service } = build();
    expect((service as any).amountFor('HOOKPOST', 'MONTHLY', 'INR')).toBe(69900);
    const { newPurchaseCurrency } = await import(
      '@hookpost/nestjs-libraries/services/billing.currency'
    );
    // a visitor the USD rail would charge in dollars still gets the INR plan
    expect(newPurchaseCurrency('HOOKPOST', 'USD')).toBe('INR');
    expect(newPurchaseCurrency('HOOKPOST', 'INR')).toBe('INR');
    expect(newPurchaseCurrency('STANDARD', 'USD')).toBe('USD');
    // Existing Standard and Pro subscribers keep their own prices.
    expect((service as any).amountFor('STANDARD', 'MONTHLY', 'INR')).toBe(59900);
    expect((service as any).amountFor('PRO', 'MONTHLY', 'INR')).toBe(199900);
  });

  it('checkout sells HOOKPOST only; Standard and Pro are not purchasable any more', async () => {
    const { validate } = await import('class-validator');
    const { plainToInstance } = await import('class-transformer');
    const { BillingSubscribeDto } = await import(
      '@hookpost/nestjs-libraries/dtos/billing/billing.subscribe.dto'
    );
    const ok = await validate(plainToInstance(BillingSubscribeDto, { billing: 'HOOKPOST', period: 'MONTHLY' }));
    expect(ok.filter((e) => e.property === 'billing')).toHaveLength(0);
    for (const billing of ['STANDARD', 'PRO', 'TEAM', 'ULTIMATE']) {
      const errs = await validate(plainToInstance(BillingSubscribeDto, { billing, period: 'MONTHLY' }));
      expect(errs.some((e) => e.property === 'billing')).toBe(true);
    }
  });
});

describe('pricing context', () => {
  it('every visitor is shown $7 and the order charges Rs 699, US and India alike', async () => {
    const { service } = build();
    jest.spyOn(service as any, 'firstMonthOfferTermsFor').mockResolvedValue(null);
    const expected = {
      name: 'Hookpost',
      tier: 'HOOKPOST',
      currency: 'INR',
      price: 699,
      label: '$7',
    };
    for (const headers of [{ 'cf-ipcountry': 'US' }, {}, { 'cf-ipcountry': 'IN' }]) {
      const ctx = await service.getPricingContext({ headers });
      expect(ctx.oneTimePlan).toEqual(expected);
    }
  });
});
