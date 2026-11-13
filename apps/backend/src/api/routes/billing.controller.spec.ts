import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import {
  HEADERS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';

// POST /billing/cancel, /billing/reactivate, /billing/payment-method, their
// GET .../quote, POST /billing/replacement/discard, GET /billing/invoices and GET /billing/payment-issue: what the controller adds on top of RazorpayService
// (which has its own spec). The services are fakes.

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
jest.mock('@hookpost/nestjs-libraries/database/prisma/refunds/refunds.service', () => ({
  RefundsService: class {},
}));

import { BillingController } from './billing.controller';
import { AuthService } from '@hookpost/helpers/auth/auth.service';
import { CHECK_POLICIES_KEY } from '@hookpost/backend/services/auth/permissions/permissions.ability';
import {
  AuthorizationActions,
  Sections,
} from '@hookpost/backend/services/auth/permissions/permission.exception.class';

const org = { id: 'org-chai', name: 'Chai Point Social', paymentId: 'cust_1' } as any;
const user = { id: 'user-1', email: 'priya@chaipoint.in' } as any;

function setup(cancelResult: any, finishResult: any = { ok: true }) {
  const razorpay = {
    cancelAtPeriodEnd: jest.fn(async () => cancelResult),
    startReplacementMandate: jest.fn(async () => ({ subscriptionId: 'sub_new' })),
    quoteReplacementMandate: jest.fn(async () => ({ amount: 699, currency: 'INR' })),
    discardReplacementMandate: jest.fn(async () => ({ discarded: true })),
    listInvoices: jest.fn(async () => []),
    paymentIssue: jest.fn(async () => ({ status: 'pending' })),
    cancelQuote: jest.fn(async () => ({ endsNow: true })),
    finishTrial: jest.fn(async () => finishResult),
  };
  const notifications = { sendEmail: jest.fn(async () => undefined) };
  const organizations = {
    setTrialFinished: jest.fn(async () => undefined),
    // No chargeback on this workspace: what every test here but the dispute
    // ones wants (assertNotDisputed).
    getDispute: jest.fn(async () => ({ disputedAt: null })),
  };
  const users = {
    getUserWithActiveSubscriptionByEmail: jest.fn(async () => null),
  };
  const controller = new BillingController(
    {
      checkoutAllowsTrial: jest.fn(async () => false),
    } as any,
    razorpay as any,
    notifications as any,
    users as any,
    organizations as any,
    {} as any,
    {} as any
  );
  return { controller, razorpay, notifications, organizations, users };
}

describe('POST /billing/cancel', () => {
  it('cancels, then tells the team, with the feedback', async () => {
    const result = { id: 'x', cancel_at: new Date(), immediate: false, alreadyScheduled: false };
    const { controller, razorpay, notifications } = setup(result);

    await expect(
      controller.cancel(org, user, { feedback: 'Too expensive for our team right now' })
    ).resolves.toBe(result);

    // Who asked and why go along for the owner's sale alert.
    expect(razorpay.cancelAtPeriodEnd).toHaveBeenCalledWith('org-chai', {
      userId: 'user-1',
      feedback: 'Too expensive for our team right now',
    });
    expect(notifications.sendEmail).toHaveBeenCalledTimes(1);
    expect((notifications.sendEmail.mock.calls[0] as any[])[2]).toContain(
      'Too expensive for our team right now'
    );
  });

  it('a repeat click sends no second "Subscription Cancelled" email', async () => {
    const { controller, notifications } = setup({
      id: 'x',
      cancel_at: new Date(),
      immediate: false,
      alreadyScheduled: true,
    });

    await controller.cancel(org, user, { feedback: '' });

    expect(notifications.sendEmail).not.toHaveBeenCalled();
  });

  it('a cancel Razorpay refused sends no email (the error goes to the page)', async () => {
    const { controller, razorpay, notifications } = setup(null);
    razorpay.cancelAtPeriodEnd.mockRejectedValueOnce(new Error('refused'));

    await expect(controller.cancel(org, user, { feedback: '' })).rejects.toThrow('refused');
    expect(notifications.sendEmail).not.toHaveBeenCalled();
  });
});

describe('reactivate and change payment method', () => {
  it('open a replacement mandate for this workspace and user', async () => {
    const { controller, razorpay } = setup(null);

    await controller.reactivate(org, user);
    await controller.changePaymentMethod(org, user);

    expect(razorpay.startReplacementMandate.mock.calls).toEqual([
      ['org-chai', 'user-1', 'reactivate'],
      ['org-chai', 'user-1', 'payment_method'],
    ]);
  });
});

describe('GET /billing/reactivate/quote and /billing/payment-method/quote', () => {
  it('quote this workspace\'s terms and never create a mandate', async () => {
    const { controller, razorpay } = setup(null);

    await expect(controller.reactivateQuote(org)).resolves.toEqual({ amount: 699, currency: 'INR' });
    await controller.paymentMethodQuote(org);

    expect(razorpay.quoteReplacementMandate.mock.calls).toEqual([
      ['org-chai', 'reactivate'],
      ['org-chai', 'payment_method'],
    ]);
    expect(razorpay.startReplacementMandate).not.toHaveBeenCalled();
  });

  it.each([
    ['reactivateQuote', '/reactivate/quote'],
    ['paymentMethodQuote', '/payment-method/quote'],
    ['cancelQuote', '/cancel/quote'],
  ])('%s is a GET on %s, never cached', (method, route) => {
    const handler = (BillingController.prototype as any)[method];
    const reflector = new Reflector();
    expect(reflector.get(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(reflector.get(PATH_METADATA, handler)).toBe(route);
    expect(reflector.get(HEADERS_METADATA, handler)).toEqual([
      { name: 'Cache-Control', value: 'private, no-store' },
    ]);
  });
});

describe('GET /billing/cancel/quote', () => {
  it("asks whether this workspace's Cancel ends the plan now, and cancels nothing", async () => {
    const { controller, razorpay } = setup(null);

    await expect(controller.cancelQuote(org)).resolves.toEqual({ endsNow: true });
    expect(razorpay.cancelQuote).toHaveBeenCalledWith('org-chai');
    expect(razorpay.cancelAtPeriodEnd).not.toHaveBeenCalled();
  });
});

describe('GET /billing/payment-issue', () => {
  it("answers this workspace's failing charge, never cached", async () => {
    const { controller, razorpay } = setup(null);

    await expect(controller.paymentIssue(org)).resolves.toEqual({ status: 'pending' });
    expect(razorpay.paymentIssue).toHaveBeenCalledWith('org-chai');

    const handler = (BillingController.prototype as any).paymentIssue;
    const reflector = new Reflector();
    expect(reflector.get(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(reflector.get(PATH_METADATA, handler)).toBe('/payment-issue');
    expect(reflector.get(HEADERS_METADATA, handler)).toEqual([
      { name: 'Cache-Control', value: 'private, no-store' },
    ]);
  });
});

describe('POST /billing/replacement/discard', () => {
  it('asks the service to withdraw that subscription for this workspace only', async () => {
    const { controller, razorpay } = setup(null);

    await expect(
      controller.discardReplacement(org, { subscriptionId: 'sub_new' })
    ).resolves.toEqual({ discarded: true });
    await controller.discardReplacement(org, {});

    expect(razorpay.discardReplacementMandate.mock.calls).toEqual([
      ['org-chai', 'sub_new'],
      ['org-chai', ''],
    ]);
  });
});

describe('POST /billing/finish-trial', () => {
  it('ends the trial once Razorpay has taken the early charge', async () => {
    const { controller, razorpay, organizations } = setup(null, { ok: true });

    await expect(controller.finishTrial(org)).resolves.toEqual({ finish: true, startAt: null, error: false, unknown: false });
    expect(razorpay.finishTrial).toHaveBeenCalledWith('org-chai');
    expect(organizations.setTrialFinished).toHaveBeenCalledWith('org-chai');
  });

  it('a charge Razorpay refused (UPI) keeps the trial, and says when the first charge is', async () => {
    const startAt = new Date('2026-10-20T10:00:00Z');
    const { controller, organizations } = setup(null, { ok: false, startAt });

    await expect(controller.finishTrial(org)).resolves.toEqual({ finish: false, startAt, error: false, unknown: false });
    expect(organizations.setTrialFinished).not.toHaveBeenCalled();
  });

  it('a workspace with no Razorpay customer does not get its trial limits lifted', async () => {
    const { controller, razorpay, organizations } = setup(null);

    await expect(
      controller.finishTrial({ ...org, paymentId: null })
    ).resolves.toEqual({ finish: false, startAt: null, error: false, unknown: false });
    expect(razorpay.finishTrial).not.toHaveBeenCalled();
    expect(organizations.setTrialFinished).not.toHaveBeenCalled();
  });

  it('a charge asked for with no answer from Razorpay keeps the trial and says it is unknown, not refused', async () => {
    const { controller, organizations } = setup(null, { ok: false, unknown: true });

    await expect(controller.finishTrial(org)).resolves.toEqual({
      finish: false,
      startAt: null,
      error: false,
      unknown: true,
    });
    expect(organizations.setTrialFinished).not.toHaveBeenCalled();
  });

  it('an error reaching Razorpay keeps the trial, and is told apart from "no trial"', async () => {
    const { controller, razorpay, organizations } = setup(null);
    razorpay.finishTrial.mockRejectedValueOnce(new Error('down'));

    await expect(controller.finishTrial(org)).resolves.toEqual({ finish: false, startAt: null, error: true, unknown: false });
    expect(organizations.setTrialFinished).not.toHaveBeenCalled();
  });
});

describe('who may use them', () => {
  it.each([
    'cancel',
    'reactivate',
    'changePaymentMethod',
    'reactivateQuote',
    'paymentMethodQuote',
    'discardReplacement',
    'invoices',
    'paymentIssue',
    'redeemGumroad',
  ])(
    '%s is for workspace admins, like the billing page itself',
    (method) => {
      const policies = new Reflector().get(
        CHECK_POLICIES_KEY,
        (BillingController.prototype as any)[method]
      );
      expect(policies).toEqual([[AuthorizationActions.Create, Sections.ADMIN]]);
    }
  );

  it('the dead Stripe-portal route is gone', () => {
    expect((BillingController.prototype as any).modifyPayment).toBeUndefined();
  });
});

describe('POST /billing/refund-charges (the impersonation bar\'s Refund button)', () => {
  const ADMIN = { id: 'u-admin', email: 'owner@hookstep.in', isSuperAdmin: true } as any;
  // While impersonating, auth.middleware hands the controller the workspace
  // user with isSuperAdmin forced on.
  const IMPERSONATED = { id: 'u-priya', email: 'priya@chaipoint.in', isSuperAdmin: true } as any;
  const PAY = 'pay_TqFWpXxKSIObH8';
  const ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ENV };
  });

  function refundSetup() {
    const refunds = {
      refundBulk: jest.fn(async () => ({ results: [], summary: { requested: 1, refunded: 1 } })),
    };
    const users = {
      getUserById: jest.fn(async (id: string) => (id === ADMIN.id ? ADMIN : null)),
    };
    const controller = new BillingController(
      {} as any,
      {} as any,
      {} as any,
      users as any,
      {} as any,
      refunds as any,
      {} as any
    );
    return { controller, refunds, users };
  }
  const req = (headers: any = {}, cookies: any = {}) =>
    ({ cookies, headers: { 'content-type': 'application/json', ...headers } } as any);

  it('refuses a form post (CSRF: the cookie is SameSite=None) and refunds nothing', async () => {
    const { controller, refunds } = refundSetup();
    for (const type of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
      'text/plain; x=application/json',
    ]) {
      await expect(
        controller.refundCharges(ADMIN, req({ 'content-type': type }), { chargeIds: [PAY] })
      ).rejects.toMatchObject({ status: 415 });
    }
    expect(refunds.refundBulk).not.toHaveBeenCalled();
  });

  it('is for super admins only, and wants a list', async () => {
    const { controller, refunds } = refundSetup();
    await expect(
      controller.refundCharges({ ...ADMIN, isSuperAdmin: false }, req(), { chargeIds: [PAY] })
    ).rejects.toThrow('Unauthorized');
    await expect(
      controller.refundCharges(ADMIN, req(), { chargeIds: PAY as any })
    ).rejects.toMatchObject({ status: 400 });
    expect(refunds.refundBulk).not.toHaveBeenCalled();
  });

  it('goes through RefundsService (Hookpost-only gate, lock, audit), never with confirmForeign', async () => {
    const { controller, refunds } = refundSetup();
    await controller.refundCharges(ADMIN, req(), { chargeIds: [PAY] });
    expect(refunds.refundBulk).toHaveBeenCalledWith(
      { id: 'u-admin', email: 'owner@hookstep.in' },
      [PAY]
    );
  });

  it('while impersonating, the audit names the super admin from the auth token, not the workspace user', async () => {
    process.env.JWT_SECRET = 'test-secret';
    const { controller, refunds } = refundSetup();
    const token = AuthService.signSessionJWT({ id: 'u-admin', password: null });
    await controller.refundCharges(IMPERSONATED, req({}, { impersonate: 'uo-1', auth: token }), {
      chargeIds: [PAY],
    });
    expect(refunds.refundBulk).toHaveBeenCalledWith(
      { id: 'u-admin', email: 'owner@hookstep.in' },
      [PAY]
    );
    // A token that does not resolve to a super admin refunds nothing.
    await expect(
      controller.refundCharges(
        IMPERSONATED,
        req({ impersonate: 'uo-1', auth: AuthService.signSessionJWT({ id: 'u-priya', password: null }) }),
        { chargeIds: [PAY] }
      )
    ).rejects.toThrow('Unauthorized');
    await expect(
      controller.refundCharges(IMPERSONATED, req({ impersonate: 'uo-1', auth: 'not-a-jwt' }), {
        chargeIds: [PAY],
      })
    ).rejects.toThrow('Unauthorized');
    expect(refunds.refundBulk).toHaveBeenCalledTimes(1);
  });
});

describe('POST /billing/gumroad/redeem', () => {
  function gumroadSetup() {
    const gumroad = {
      redeem: jest.fn(async () => ({ ok: true, tier: 'PRO', period: 'MONTHLY' })),
    };
    const controller = new BillingController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      // No dispute on these workspaces (BillingController.assertNotDisputed).
      { getDispute: jest.fn(async () => null) } as any,
      {} as any,
      gumroad as any
    );
    return { controller, gumroad };
  }

  it('hands the key to GumroadLicenseService for this workspace', async () => {
    const { controller, gumroad } = gumroadSetup();
    const workspace = { id: 'org-redeem-once' } as any;
    await expect(
      controller.redeemGumroad(workspace, { licenseKey: 'A1B2C3D4-E5F60718-9ABCDEF0-1234ABCD' })
    ).resolves.toMatchObject({ ok: true, tier: 'PRO' });
    expect(gumroad.redeem).toHaveBeenCalledWith(
      'org-redeem-once',
      'A1B2C3D4-E5F60718-9ABCDEF0-1234ABCD'
    );
  });

  it('five tries in ten minutes per workspace, then 429 RATE_LIMITED without asking Gumroad', async () => {
    const { controller, gumroad } = gumroadSetup();
    const workspace = { id: 'org-many-typos' } as any;
    for (let i = 0; i < 5; i++) {
      await controller.redeemGumroad(workspace, { licenseKey: `TYPO-${i}-AAAA` });
    }
    let refused: any;
    try {
      await controller.redeemGumroad(workspace, { licenseKey: 'TYPO-6-AAAA' });
    } catch (e) {
      refused = e;
    }
    expect(refused?.getStatus()).toBe(429);
    expect(refused?.getResponse()).toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });
    expect(gumroad.redeem).toHaveBeenCalledTimes(5);

    // Another workspace has its own allowance.
    await controller.redeemGumroad({ id: 'org-someone-else' } as any, { licenseKey: 'KEY-1-AAAA' });
    expect(gumroad.redeem).toHaveBeenCalledTimes(6);
  });
});

describe('checkout on a workspace whose plan is paid on Gumroad', () => {
  function checkoutSetup(identifier: string | null) {
    const razorpay = {
      embedded: jest.fn(async () => ({ subscriptionId: 'sub_new' })),
      subscribe: jest.fn(async () => ({ id: 'x' })),
    };
    const subscriptions = {
      getSubscription: jest.fn(async () =>
        identifier ? { identifier, subscriptionTier: 'PRO' } : null
      ),
      checkoutAllowsTrial: jest.fn(async (_id: string, allowTrial: boolean) => !!allowTrial),
    };
    const users = { getUserWithActiveSubscriptionByEmail: jest.fn(async () => null) };
    const controller = new BillingController(
      subscriptions as any,
      razorpay as any,
      {} as any,
      users as any,
      { getDispute: jest.fn(async () => ({ disputedAt: null })) } as any,
      {} as any,
      {} as any
    );
    return { controller, razorpay, subscriptions };
  }
  const body = { billing: 'PRO', period: 'MONTHLY' } as any;
  const request = { cookies: {}, headers: {} } as any;

  it.each(['embedded', 'subscribe'] as const)(
    '%s: 409 GUMROAD_PLAN, and Razorpay is never asked to open a mandate',
    async (method) => {
      const { controller, razorpay } = checkoutSetup('gumroad:FO8TXN-dbxYaBdahG97Y-Q==');
      await expect(controller[method](org, user, body, request)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: 'GUMROAD_PLAN' }),
      });
      expect(razorpay[method]).not.toHaveBeenCalled();
    }
  );

  it.each(['embedded', 'subscribe'] as const)(
    '%s: a paid one-time month gets 409 ONE_TIME_PLAN, never a mandate beside it',
    async (method) => {
      const { controller, razorpay } = checkoutSetup('order_TqA1b2C3');
      await expect(controller[method](org, user, body, request)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: 'ONE_TIME_PLAN' }),
      });
      expect(razorpay[method]).not.toHaveBeenCalled();
    }
  );

  it.each(['embedded', 'subscribe'] as const)(
    '%s: a Razorpay plan or none goes to checkout as before',
    async (method) => {
      for (const identifier of ['sub_TYd1D4gZnW0EP2', null]) {
        const { controller, razorpay } = checkoutSetup(identifier);
        await controller[method](org, user, body, request);
        expect(razorpay[method]).toHaveBeenCalledTimes(1);
      }
    }
  );
});

// 28 Oct 2026: a workspace on its free posts subscribes with no trial, so the
// first payment is taken at once and the first-month offer can go on it
// (Razorpay refuses an offer on a subscription with a start_at).
describe('checkout for a workspace on its free posts', () => {
  const body = { billing: 'STANDARD', period: 'MONTHLY', payWith: 'upi' } as any;
  const request = { cookies: {}, headers: { 'cf-ipcountry': 'IN' } } as any;
  const setupCheckout = (allowsTrial: boolean) => {
    const razorpay = {
      embedded: jest.fn(async () => ({ subscriptionId: 'sub_new' })),
      subscribe: jest.fn(async () => ({ id: 'x' })),
    };
    const subscriptions = {
      getSubscription: jest.fn(async () => null),
      checkoutAllowsTrial: jest.fn(async () => allowsTrial),
    };
    const controller = new BillingController(
      subscriptions as any,
      razorpay as any,
      {} as any,
      { getUserWithActiveSubscriptionByEmail: jest.fn(async () => null) } as any,
      { getDispute: jest.fn(async () => ({ disputedAt: null })) } as any,
      {} as any,
      {} as any
    );
    return { controller, razorpay, subscriptions };
  };

  it.each(['embedded', 'subscribe'] as const)(
    '%s: Razorpay is asked for no trial, whatever allowTrial says',
    async (method) => {
      const { controller, razorpay, subscriptions } = setupCheckout(false);
      await controller[method]({ ...org, allowTrial: true }, user, body, request);
      // The member at checkout counts as an owner for once-per-person.
      expect(subscriptions.checkoutAllowsTrial).toHaveBeenCalledWith(
        'org-chai',
        true,
        { requestCountry: 'IN', tz: undefined },
        { userId: 'user-1' }
      );
      expect((razorpay[method].mock.calls[0] as any[])[4]).toBe(false);
    }
  );

  it.each(['embedded', 'subscribe'] as const)(
    '%s: a workspace that may still start a trial keeps it',
    async (method) => {
      const { controller, razorpay } = setupCheckout(true);
      await controller[method]({ ...org, allowTrial: true }, user, body, request);
      expect((razorpay[method].mock.calls[0] as any[])[4]).toBe(true);
    }
  );
});

// A bank reported a chargeback on one of this workspace's payments
// (Organization.disputedAt, RazorpayService.handleDispute): it may not buy
// again, by any of the doors, until a super admin clears it.
describe('a disputed workspace cannot buy again', () => {
  const disputed = () => {
    const { controller, razorpay, organizations } = setup(null);
    organizations.getDispute = jest.fn(async () => ({
      disputedAt: new Date('2026-10-29T11:26:00Z'),
      disputeReason: 'processed_invalid_expired_card',
      disputePaymentId: 'pay_EFtmUsbwpXwBHI',
    })) as any;
    return { controller, razorpay, organizations };
  };
  const body = { billing: 'STANDARD', period: 'MONTHLY' } as any;
  const req = { cookies: {}, headers: {} } as any;

  it.each([
    ['checkout (/billing/subscribe)', (c: any) => c.subscribe(org, user, body, req)],
    ['the embedded checkout (/billing/embedded)', (c: any) => c.embedded(org, user, body, req)],
    ['Reactivate (/billing/reactivate)', (c: any) => c.reactivate(org, user)],
    ['Change payment method', (c: any) => c.changePaymentMethod(org, user)],
    ['a Gumroad license key (/billing/gumroad/redeem)', (c: any) => c.redeemGumroad(org, { licenseKey: 'K-1' })],
  ])('%s is refused with the dispute message, and Razorpay is never called', async (_l, call) => {
    const { controller, razorpay } = disputed();

    await expect(call(controller)).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'PAYMENT_DISPUTE',
        message: 'Your account has a payment dispute. Contact support@hookstep.in',
      },
    });
    // No mandate, no order, no money asked for.
    expect(razorpay.startReplacementMandate).not.toHaveBeenCalled();
  });

  it('a workspace with no dispute is let through to Razorpay as before', async () => {
    const { controller, razorpay } = setup(null);

    await expect(controller.reactivate(org, user)).resolves.toEqual({
      subscriptionId: 'sub_new',
    });
    expect(razorpay.startReplacementMandate).toHaveBeenCalledWith(
      'org-chai',
      'user-1',
      'reactivate'
    );
  });

  it('a cleared dispute (disputedAt null, the clear fields filled) buys again', async () => {
    const { controller, razorpay, organizations } = setup(null);
    organizations.getDispute = jest.fn(async () => ({
      disputedAt: null,
      disputeReason: 'processed_invalid_expired_card',
      disputeClearedAt: new Date('2026-10-30T06:00:00Z'),
      disputeClearedBy: 'owner@hookstep.in (u-1)',
    })) as any;

    await expect(controller.reactivate(org, user)).resolves.toEqual({
      subscriptionId: 'sub_new',
    });
    expect(razorpay.startReplacementMandate).toHaveBeenCalled();
  });

  it('cancelling is never blocked: a disputed workspace may still stop its plan', async () => {
    const { controller, razorpay } = disputed();
    const result = { id: 'x', cancel_at: new Date(), immediate: true, alreadyScheduled: false };
    razorpay.cancelAtPeriodEnd = jest.fn(async () => result) as any;

    await expect(controller.cancel(org, user, { feedback: '' })).resolves.toBe(result);
  });
});

// 8 Nov 2026: the single plan, paid one month at a time (one.time.plan.ts).
describe('one-time checkout', () => {
  const setupOrder = (disputedAt: Date | null = null) => {
    const oneTime = {
      createOrder: jest.fn(async () => ({ orderId: 'order_new' })),
      verify: jest.fn(async () => ({ ok: true, granted: true, paidUntil: new Date('2026-12-08T10:00:00Z') })),
      quote: jest.fn(async () => ({ price: 7 })),
    };
    const controller = new BillingController(
      {} as any,
      { createOrGetCustomer: jest.fn(async (o: any) => o.paymentId) } as any,
      {} as any,
      {} as any,
      { getDispute: jest.fn(async () => ({ disputedAt })) } as any,
      {} as any,
      {} as any,
      oneTime as any
    );
    return { controller, oneTime };
  };
  const request = { cookies: {}, headers: { 'cf-ipcountry': 'US' } } as any;

  it('opens an order with the request country and timezone, never a client amount', async () => {
    const { controller, oneTime } = setupOrder();
    await controller.createOrder(org, user, { tz: 'America/New_York', amount: 1 } as any, request);
    expect(oneTime.createOrder).toHaveBeenCalledWith(
      'org-chai',
      'user-1',
      { requestCountry: 'US', tz: 'America/New_York' },
      expect.any(Date),
      'cust_1'
    );
  });

  it('a disputed workspace gets 409 PAYMENT_DISPUTE and no order', async () => {
    const { controller, oneTime } = setupOrder(new Date());
    await expect(controller.createOrder(org, user, {}, request)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'PAYMENT_DISPUTE' }),
    });
    expect(oneTime.createOrder).not.toHaveBeenCalled();
  });

  it('verify answers the month it gave', async () => {
    const { controller, oneTime } = setupOrder();
    const body = { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'x' };
    await expect(controller.verifyOrder(org, body)).resolves.toEqual({
      ok: true,
      granted: true,
      reason: null,
      paidUntil: '2026-12-08T10:00:00.000Z',
    });
    expect(oneTime.verify).toHaveBeenCalledWith('org-chai', body);
  });
});
