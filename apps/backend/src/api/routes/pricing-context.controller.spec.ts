import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

// GET /public/pricing-context (served as /api/public/pricing-context) and
// GET /billing/pricing-context, over real HTTP on a throwaway port. The
// controllers and RazorpayService are real; Razorpay, Prisma and Redis are
// fakes. Nothing here reads .env or reaches a remote service.

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
jest.mock('@hookpost/nestjs-libraries/database/prisma/posts/posts.service', () => ({
  PostsService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/agent/agent.graph.insert.service', () => ({
  AgentGraphInsertService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/services/support-tickets.service', () => ({
  SupportTicketsService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/services/drip-unsubscribe.service', () => ({
  DripUnsubscribeService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service',
  () => ({ NotificationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/database/prisma/refunds/refunds.service', () => ({
  RefundsService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: { set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) },
}));

const remote: Record<string, any> = {};
const mockRequest = jest.fn(async (method: string, path: string) => {
  if (method === 'GET' && path === '/subscriptions/sub_usd') return remote.sub_usd;
  if (method === 'GET' && path === '/plans/plan_usd') {
    return { id: 'plan_usd', item: { amount: 1500, currency: 'USD' } };
  }
  throw new Error(`unexpected Razorpay call ${method} ${path}`);
});
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));

import { PublicController } from './public.controller';
import { BillingController } from './billing.controller';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';
import { UsersService } from '@hookpost/nestjs-libraries/database/prisma/users/users.service';
import { TrackService } from '@hookpost/nestjs-libraries/track/track.service';
import { PostsService } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.service';
import { AgentGraphInsertService } from '@hookpost/nestjs-libraries/agent/agent.graph.insert.service';
import { SupportTicketsService } from '@hookpost/nestjs-libraries/services/support-tickets.service';
import { DripUnsubscribeService } from '@hookpost/nestjs-libraries/services/drip-unsubscribe.service';
import { NotificationService } from '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service';
import { RefundsService } from '@hookpost/nestjs-libraries/database/prisma/refunds/refunds.service';
import { GumroadLicenseService } from '@hookpost/nestjs-libraries/database/prisma/gumroad/gumroad.license.service';
import { OneTimePlanService } from '@hookpost/nestjs-libraries/services/one.time.plan.service';

let app: INestApplication;
let base = '';
let localRow: any = null;
let ownerFacts: { ownerCountry: string | null; ownerEmail: string | null } | null = null;

beforeAll(async () => {
  const subscriptions = {
    getSubscription: jest.fn(async () => localRow),
    getCurrencyFacts: jest.fn(async () => ownerFacts),
  };
  const razorpay = new RazorpayService(
    subscriptions as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [PublicController, BillingController],
    providers: [
      { provide: RazorpayService, useValue: razorpay },
      { provide: SubscriptionService, useValue: subscriptions },
      { provide: OrganizationService, useValue: {} },
      { provide: UsersService, useValue: {} },
      { provide: TrackService, useValue: {} },
      { provide: PostsService, useValue: {} },
      { provide: AgentGraphInsertService, useValue: {} },
      { provide: SupportTicketsService, useValue: {} },
      { provide: DripUnsubscribeService, useValue: {} },
      { provide: NotificationService, useValue: {} },
      { provide: RefundsService, useValue: {} },
      { provide: GumroadLicenseService, useValue: {} },
      { provide: OneTimePlanService, useValue: {} },
    ],
  }).compile();

  app = moduleRef.createNestApplication({ logger: false });
  // AuthMiddleware's job in production: the signed-in org on the request.
  app.use((req: any, _res: any, next: () => void) => {
    req.org = { id: 'org-chai' };
    next();
  });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  localRow = null;
  ownerFacts = null;
  mockRequest.mockClear();
  delete process.env.INTL_CHECKOUT;
  delete process.env.USD_CHECKOUT;
  delete process.env.USD_ALLOWLIST;
  delete process.env.USD_EXCLUDED_COUNTRIES;
  delete process.env.GST_LUT_ARN;
});

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers });

describe('GET /public/pricing-context', () => {
  it('is never cached and quotes INR to a visitor in the US', async () => {
    const res = await get('/public/pricing-context?tz=America%2FNew_York', {
      'cf-ipcountry': 'US',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      displayCurrency: 'INR',
      chargeCurrency: 'INR',
      lockedCurrency: null,
      checkoutAllowed: true,
      region: { country: 'US', tzSaysIndia: false, ipSaysIndia: false },
      prices: {
        STANDARD: { month: 599, year: 5990 },
        PRO: { month: 1999, year: 19990 },
        HOOKPOST: { month: 699, year: 0 },
      },
      // No first-month offer configured (first.month.offer.ts).
      firstMonthOffer: null,
      // The single plan paid once (one.time.plan.ts): shown as $7 to
      // everyone, charged Rs 699 in INR to everyone.
      oneTimePlan: { name: 'Hookpost', tier: 'HOOKPOST', currency: 'INR', price: 699, label: '$7' },
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('names no first-month offer even with its ids set: the single plan is a flat price', async () => {
    process.env.RAZORPAY_OFFER_FIRST_MONTH_UPI = 'offer_UpiTest0000001';
    process.env.RAZORPAY_OFFER_FIRST_MONTH_CARD = 'offer_CardTest000001';
    try {
      const body = await (
        await get('/public/pricing-context', { 'cf-ipcountry': 'IN' })
      ).json();
      expect(body.chargeCurrency).toBe('INR');
      expect(body.firstMonthOffer).toBeNull();
    } finally {
      delete process.env.RAZORPAY_OFFER_FIRST_MONTH_UPI;
      delete process.env.RAZORPAY_OFFER_FIRST_MONTH_CARD;
    }
  });

  it('reports an Indian IP and an Indian timezone separately', async () => {
    const ip = await (
      await get('/public/pricing-context?tz=America%2FChicago', { 'cf-ipcountry': 'IN' })
    ).json();
    expect(ip.region).toEqual({ country: 'IN', tzSaysIndia: false, ipSaysIndia: true });

    const tz = await (
      await get('/public/pricing-context?tz=Asia%2FKolkata', { 'cf-ipcountry': 'US' })
    ).json();
    expect(tz.region).toEqual({ country: 'US', tzSaysIndia: true, ipSaysIndia: false });
  });

  it('does not believe x-country, and treats XX and T1 as unknown', async () => {
    for (const cf of ['XX', 'T1']) {
      const body = await (
        await get('/public/pricing-context', { 'x-country': 'IN', 'cf-ipcountry': cf })
      ).json();
      expect(body.region).toEqual({ country: null, tzSaysIndia: false, ipSaysIndia: false });
    }
    const forged = await (await get('/public/pricing-context', { 'x-country': 'IN' })).json();
    expect(forged.region.ipSaysIndia).toBe(false);
  });
});

describe('GET /billing/pricing-context', () => {
  it('is never cached and follows the workspace plan', async () => {
    localRow = {
      identifier: 'sub_usd',
      isLifetime: false,
      deletedAt: null,
      cancelAt: null,
    };
    remote.sub_usd = { id: 'sub_usd', status: 'active', plan_id: 'plan_usd' };

    const res = await get('/billing/pricing-context?tz=Asia%2FKolkata', {
      'cf-ipcountry': 'IN',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({
      displayCurrency: 'USD',
      chargeCurrency: 'USD',
      lockedCurrency: 'USD',
      checkoutAllowed: true,
      prices: { STANDARD: { month: 19, year: 190 } },
    });
  });

  it('a free workspace gets rupees', async () => {
    const body = await (
      await get('/billing/pricing-context?tz=Europe%2FLondon', { 'cf-ipcountry': 'GB' })
    ).json();
    expect(body).toMatchObject({
      displayCurrency: 'INR',
      chargeCurrency: 'INR',
      lockedCurrency: null,
      region: { country: 'GB', tzSaysIndia: false, ipSaysIndia: false },
    });
  });
});

describe('with the USD rail on (PR-4)', () => {
  beforeEach(() => {
    process.env.USD_CHECKOUT = 'on';
    process.env.GST_LUT_ARN = 'AD0910260000000';
  });

  it('a signed-out visitor in the US is shown dollars, and one in India rupees', async () => {
    const us = await (
      await get('/public/pricing-context?tz=America%2FNew_York', { 'cf-ipcountry': 'US' })
    ).json();
    expect(us).toMatchObject({
      displayCurrency: 'USD',
      chargeCurrency: 'USD',
      prices: { STANDARD: { month: 19, year: 190 }, PRO: { month: 29, year: 290 } },
    });

    const india = await (
      await get('/public/pricing-context?tz=Asia%2FKolkata', { 'cf-ipcountry': 'IN' })
    ).json();
    expect(india).toMatchObject({ displayCurrency: 'INR', chargeCurrency: 'INR' });

    // A US IP with an Indian clock is India.
    const vpn = await (
      await get('/public/pricing-context?tz=Asia%2FKolkata', { 'cf-ipcountry': 'US' })
    ).json();
    expect(vpn.chargeCurrency).toBe('INR');
  });

  it('a forged x-country cannot buy the rupee price', async () => {
    const body = await (
      await get('/public/pricing-context?tz=America%2FChicago', {
        'x-country': 'IN',
        'cf-ipcountry': 'US',
      })
    ).json();
    expect(body.chargeCurrency).toBe('USD');
  });

  it("a workspace follows its creator's signup country, not the request", async () => {
    ownerFacts = { ownerCountry: 'IN', ownerEmail: 'owner@chai.example' };
    const body = await (
      await get('/billing/pricing-context?tz=America%2FNew_York', { 'cf-ipcountry': 'US' })
    ).json();
    expect(body).toMatchObject({ displayCurrency: 'INR', chargeCurrency: 'INR' });

    ownerFacts = { ownerCountry: 'US', ownerEmail: 'owner@chai.example' };
    const abroad = await (
      await get('/billing/pricing-context?tz=Asia%2FKolkata', { 'cf-ipcountry': 'IN' })
    ).json();
    expect(abroad).toMatchObject({ displayCurrency: 'USD', chargeCurrency: 'USD' });
  });
});

// The same PublicController over HTTP: the browser's failure beacon.
describe('POST /public/client-event', () => {
  const post = (body: unknown) =>
    fetch(`${base}/public/client-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('answers 204 and writes one "[client]" line, without the query string', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await post({
        event: 'connect_page_error',
        provider: 'instagram',
        path: '/integrations/social/instagram?code=one-time&state=s',
        reason: 'code must be a string',
      });
      expect(res.status).toBe(204);
      expect(warn).toHaveBeenCalledWith(
        '[client] connect_page_error {"provider":"instagram","path":"/integrations/social/instagram","reason":"code must be a string"}'
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('an unknown event is still a 204 and writes nothing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await post({ event: 'drop table' })).status).toBe(204);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
