import 'reflect-metadata';

// The refund routes over real HTTP, through Nest's own body parsers and the
// ValidationPipe main.ts installs. The auth cookie is SameSite=None, so an
// auto-submitting form on any site can POST here from a signed-in super
// admin's browser: urlencoded (paymentId=..., paymentIds[0]=...), multipart or
// text/plain. Each must be refused before RefundsService is called; the
// page's JSON must still get through. The services are fakes.

jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/errors/errors.service', () => ({
  ErrorsService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/admin-stats/admin-stats.service',
  () => ({ AdminStatsService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/services/support-tickets.service', () => ({
  SupportTicketsService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: jest.fn() })),
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/refunds/refunds.service', () => ({
  RefundsService: class {},
  PAYMENT_ID_RE: /^pay_[A-Za-z0-9]{14}$/,
  BULK_REFUND_MAX: 50,
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/services/razorpay.service', () => ({
  RazorpayService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service',
  () => ({ NotificationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/database/prisma/users/users.service', () => ({
  UsersService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/attribution/signup-attribution.service',
  () => ({ SignupAttributionService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/services/owner.sales.alert.service', () => ({
  OwnerSalesAlertService: class {},
}));

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminPlanActionsService } from '@hookpost/nestjs-libraries/services/admin.plan.actions.service';
import { MarketplaceUsageService } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.usage.service';
import { BillingController } from './billing.controller';
import { PrismaRepository } from '@hookpost/nestjs-libraries/database/prisma/prisma.service';
import { ErrorsService } from '@hookpost/nestjs-libraries/database/prisma/errors/errors.service';
import { AdminStatsService } from '@hookpost/nestjs-libraries/database/prisma/admin-stats/admin-stats.service';
import { SupportTicketsService } from '@hookpost/nestjs-libraries/services/support-tickets.service';
import { RefundsService } from '@hookpost/nestjs-libraries/database/prisma/refunds/refunds.service';
import { GumroadLicenseService } from '@hookpost/nestjs-libraries/database/prisma/gumroad/gumroad.license.service';
import { OneTimePlanService } from '@hookpost/nestjs-libraries/services/one.time.plan.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { NotificationService } from '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service';
import { UsersService } from '@hookpost/nestjs-libraries/database/prisma/users/users.service';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';
import { SignupAttributionService } from '@hookpost/nestjs-libraries/database/prisma/attribution/signup-attribution.service';
import { OwnerSalesAlertService } from '@hookpost/nestjs-libraries/services/owner.sales.alert.service';

const PAY = 'pay_TqFWpXxKSIObH8';
const refunds = {
  refund: jest.fn(async () => ({ paymentId: PAY, status: 'refunded' })),
  refundBulk: jest.fn(async () => ({ results: [], summary: { requested: 1, refunded: 1 } })),
};

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminController, BillingController],
    providers: [
      { provide: PrismaRepository, useValue: {} },
      { provide: ErrorsService, useValue: {} },
      { provide: AdminStatsService, useValue: {} },
      { provide: SupportTicketsService, useValue: {} },
      { provide: RefundsService, useValue: refunds },
      { provide: GumroadLicenseService, useValue: {} },
      { provide: OneTimePlanService, useValue: {} },
      { provide: SubscriptionService, useValue: {} },
      { provide: RazorpayService, useValue: {} },
      { provide: NotificationService, useValue: {} },
      { provide: UsersService, useValue: {} },
      { provide: OrganizationService, useValue: {} },
      { provide: SignupAttributionService, useValue: {} },
      { provide: MarketplaceUsageService, useValue: {} },
      { provide: OwnerSalesAlertService, useValue: {} },
      { provide: AdminPlanActionsService, useValue: {} },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  // auth.middleware's part: a signed-in super admin, cookie and all.
  app.use((req: any, _res: any, next: any) => {
    req.user = { id: 'u-admin', email: 'owner@hookstep.in', isSuperAdmin: true };
    req.org = { id: 'org-1' };
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => jest.clearAllMocks());

const post = (path: string, contentType: string, body: string | FormData) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    ...(contentType ? { headers: { 'content-type': contentType } } : {}),
    body,
  });

describe('a cross-site form cannot refund', () => {
  const routes: [string, string, string][] = [
    // [path, urlencoded body, JSON body]
    ['/admin/refunds', `paymentId=${PAY}`, JSON.stringify({ paymentId: PAY })],
    ['/admin/refunds/bulk', `paymentIds[0]=${PAY}`, JSON.stringify({ paymentIds: [PAY] })],
    ['/billing/refund-charges', `chargeIds[0]=${PAY}`, JSON.stringify({ chargeIds: [PAY] })],
  ];

  it.each(routes)('%s refuses application/x-www-form-urlencoded with 415', async (path, form) => {
    const res = await post(path, 'application/x-www-form-urlencoded', form);
    expect(res.status).toBe(415);
    expect(refunds.refund).not.toHaveBeenCalled();
    expect(refunds.refundBulk).not.toHaveBeenCalled();
  });

  // Nest does not parse these, so the DTO routes answer 400 before the
  // handler runs and refund-charges (no DTO) answers 415. Refused either way.
  it.each(routes)('%s refuses multipart and text/plain forms', async (path, form, json) => {
    const multipart = new FormData();
    for (const pair of form.split('&')) {
      const [k, v] = pair.split('=');
      multipart.append(k, v);
    }
    // fetch sets multipart/form-data with its boundary itself.
    for (const res of [
      await post(path, '', multipart),
      await post(path, 'text/plain', json),
      await post(path, 'text/plain; x=application/json', json),
    ]) {
      expect([400, 415]).toContain(res.status);
    }
    expect(refunds.refund).not.toHaveBeenCalled();
    expect(refunds.refundBulk).not.toHaveBeenCalled();
  });

  it.each(routes)('%s still takes the page\'s JSON', async (path, _form, json) => {
    const res = await post(path, 'application/json', json);
    expect(res.status).toBe(201);
    expect(refunds.refund.mock.calls.length + refunds.refundBulk.mock.calls.length).toBe(1);
  });
});
