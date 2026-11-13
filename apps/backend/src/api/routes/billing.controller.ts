import { Body, Controller, Get, Header, HttpException, Param, Post, Query, Req } from '@nestjs/common';
import { cancelNoteEmail } from '@hookpost/nestjs-libraries/emails/templates/admin.alert.email';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { GetOrgFromRequest } from '@hookpost/nestjs-libraries/user/org.from.request';
import { Organization, User } from '@prisma/client';
import { BillingSubscribeDto } from '@hookpost/nestjs-libraries/dtos/billing/billing.subscribe.dto';
import { AdminApplyCouponDto } from '@hookpost/nestjs-libraries/dtos/billing/admin.apply.coupon.dto';
import { ApiTags } from '@nestjs/swagger';
import { GetUserFromRequest } from '@hookpost/nestjs-libraries/user/user.from.request';
import { NotificationService } from '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service';
import { Request } from 'express';
import { AuthService, TOKEN_PURPOSE } from '@hookpost/helpers/auth/auth.service';
import { UsersService } from '@hookpost/nestjs-libraries/database/prisma/users/users.service';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';
import { couponPrice, pricing, getPricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { CheckPolicies } from '@hookpost/backend/services/auth/permissions/permissions.ability';
import { trustedCountry } from '@hookpost/nestjs-libraries/services/billing.currency';
import { DISPUTE_CHECKOUT_MESSAGE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { RefundsService } from '@hookpost/nestjs-libraries/database/prisma/refunds/refunds.service';
import { assertJsonRequest } from '@hookpost/backend/services/auth/json.only';
import { sessionToken } from '@hookpost/backend/services/auth/session.cookies';
import {
  AuthorizationActions,
  Sections,
} from '@hookpost/backend/services/auth/permissions/permission.exception.class';
import {
  GumroadLicenseService,
  GumroadRedeemError,
} from '@hookpost/nestjs-libraries/database/prisma/gumroad/gumroad.license.service';
import { GumroadRedeemDto } from '@hookpost/nestjs-libraries/dtos/billing/gumroad.redeem.dto';
import {
  BillingOrderDto,
  BillingOrderVerifyDto,
  BillingSavedCardRemoveDto,
} from '@hookpost/nestjs-libraries/dtos/billing/billing.order.dto';
import { OneTimePlanService } from '@hookpost/nestjs-libraries/services/one.time.plan.service';
import { isOrderIdentifier } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/one.time.plan';
import { isGumroadIdentifier } from '@hookpost/nestjs-libraries/services/gumroad.license';
import { createRateLimiter } from '@hookpost/nestjs-libraries/track/client.event';

// Gumroad license keys a workspace may try in ten minutes. Enough for a few
// typos; it keeps a script from walking keys through Gumroad's API on us.
const gumroadRedeemAllowed = createRateLimiter(5, 10 * 60_000);

// Why the admin coupon tool cannot apply anything on this deployment. Upstream
// built it for a card provider that can re-price a live subscription. Razorpay
// cannot: a UPI Autopay mandate fixes the amount at signup, and Offers can only
// be created in the Razorpay dashboard and attached when a subscription is
// created. The old stubs returned a shape the modal did not expect (no
// `coupons` array) and it crashed on `info.coupons.length`.
const COUPON_UNSUPPORTED_REASON =
  "Razorpay can't change the price of a running subscription - UPI Autopay locks the amount at signup. To discount a user, create an Offer in the Razorpay dashboard; it applies when they subscribe.";

@ApiTags('Billing')
@Controller('/billing')
export class BillingController {
  constructor(
    private _subscriptionService: SubscriptionService,
    private _razorpayService: RazorpayService,
    private _notificationService: NotificationService,
    private _usersService: UsersService,
    private _organizationService: OrganizationService,
    private _refundsService: RefundsService,
    private _gumroadLicenseService: GumroadLicenseService,
    private _oneTimePlanService: OneTimePlanService
  ) {}

  /**
   * A paid one-time month is renewed with another order, never a
   * subscription beside it (one.time.plan.ts), so /embedded and /subscribe
   * refuse it rather than open a mandate that would bill on top.
   */
  private async assertNoOneTimePlan(organizationId: string) {
    const plan = await this._subscriptionService.getSubscription(organizationId);
    if (plan && !plan.deletedAt && isOrderIdentifier(plan.identifier)) {
      throw new HttpException(
        {
          statusCode: 409,
          code: 'ONE_TIME_PLAN',
          message: 'Your plan is paid one month at a time. Renew it on the Billing page.',
        },
        409
      );
    }
  }

  /**
   * The single plan, paid one month at a time: price in this workspace's
   * currency, and whether checkout (a first month or a renewal) opens now.
   */
  @Get('/order/quote')
  @Header('Cache-Control', 'private, no-store')
  orderQuote(
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request,
    @Query('tz') tz?: string
  ) {
    return this._oneTimePlanService.quote(
      org.id,
      { requestCountry: trustedCountry(req.headers), tz: tz || null },
      new Date(),
      // Only a customer that already exists: reading the page creates nothing.
      org.paymentId || null
    );
  }

  /**
   * "Remove saved card": deletes the card Razorpay keeps for this
   * workspace's customer (a token; no card data is stored here).
   */
  @Post('/order/saved-card/remove')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  removeSavedCard(
    @GetOrgFromRequest() org: Organization,
    @Body() body: BillingSavedCardRemoveDto
  ) {
    return this._oneTimePlanService.removeSavedCard(org.paymentId || null, body.tokenId);
  }

  /**
   * Open a one-time checkout: a Razorpay order for one month at the
   * server's price. Owner and admins only, like the rest of Billing.
   */
  @Post('/order')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async createOrder(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: BillingOrderDto,
    @Req() req: Request
  ) {
    await this.assertNotDisputed(org.id);
    // The workspace's Razorpay customer, so checkout can save a card (with
    // the customer's consent) and list it for the next renewal. Without one
    // checkout still works, just without a saved card.
    const customerId = await this._razorpayService
      .createOrGetCustomer(org)
      .catch((): null => null);
    return this._oneTimePlanService.createOrder(
      org.id,
      user.id,
      { requestCountry: trustedCountry(req.headers), tz: body?.tz || null },
      new Date(),
      customerId
    );
  }

  /**
   * Razorpay Checkout succeeded: check the handshake and Razorpay's own
   * order and payment, then give the month (once per payment; the
   * order.paid webhook does the same if this never arrives).
   */
  @Post('/order/verify')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async verifyOrder(
    @GetOrgFromRequest() org: Organization,
    @Body() body: BillingOrderVerifyDto
  ) {
    const result = await this._oneTimePlanService.verify(org.id, body);
    return {
      ok: true,
      granted: result.granted,
      reason: result.reason ?? null,
      paidUntil: result.paidUntil ? new Date(result.paidUntil).toISOString() : null,
    };
  }

  private async assertNoOtherSubscribedAccount(user: User) {
    const other = await this._usersService.getUserWithActiveSubscriptionByEmail(
      user.email,
      user.id
    );
    return !!other;
  }

  /**
   * A plan paid on Gumroad is changed or cancelled on Gumroad. Checkout here
   * would open a Razorpay mandate next to it and charge twice, so it is
   * refused before Razorpay is asked for anything.
   */
  private async assertNotBilledOnGumroad(organizationId: string) {
    const plan = await this._subscriptionService.getSubscription(organizationId);
    if (isGumroadIdentifier(plan?.identifier)) {
      throw new HttpException(
        {
          statusCode: 409,
          code: 'GUMROAD_PLAN',
          message:
            "This workspace's plan is billed through Gumroad. Cancel it in your Gumroad library before choosing a plan here.",
        },
        409
      );
    }
  }

  /**
   * A workspace a bank reported a chargeback on cannot buy again on its own
   * (trial.policy.ts workspaceDisputed): checkout is refused until a super
   * admin clears it. Before Razorpay is asked for anything, like the Gumroad
   * check above.
   */
  private async assertNotDisputed(organizationId: string) {
    const org = await this._organizationService.getDispute(organizationId);
    if (!org?.disputedAt) return;
    throw new HttpException(
      {
        statusCode: 409,
        code: 'PAYMENT_DISPUTE',
        message: DISPUTE_CHECKOUT_MESSAGE,
      },
      409
    );
  }

  /**
   * "Bought on Gumroad? Enter your license key": binds the key to this
   * workspace and puts it on the plan the Gumroad product sells
   * (GumroadLicenseService.redeem). Owner and admins only, like the rest of
   * Billing, and also from the trial paywall. Errors answer with a `code`
   * the page shows in its own words (GUMROAD_REDEEM_ERRORS).
   */
  @Post('/gumroad/redeem')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async redeemGumroad(
    @GetOrgFromRequest() org: Organization,
    @Body() body: GumroadRedeemDto
  ) {
    if (!gumroadRedeemAllowed(org.id)) {
      throw new GumroadRedeemError('RATE_LIMITED');
    }
    // A license key is a plan bought elsewhere: the same way back in that
    // checkout refuses a workspace a chargeback locked.
    await this.assertNotDisputed(org.id);
    return this._gumroadLicenseService.redeem(org.id, body.licenseKey);
  }

  @Get('/check/:id')
  async checkId(
    @GetOrgFromRequest() org: Organization,
    @Param('id') body: string
  ) {
    return {
      status: await this._razorpayService.checkSubscription(org.id, body),
    };
  }

  @Get('/check-discount')
  async checkDiscount(@GetOrgFromRequest() org: Organization) {
    return {
      offerCoupon: !(await this._razorpayService.checkDiscount(org.paymentId))
        ? false
        : // Only a flag the billing page checks; nothing verifies it.
          AuthService.signPurposeJWT(
            TOKEN_PURPOSE.DISCOUNT_OFFER,
            { discount: true },
            { expiresIn: '1d' }
          ),
    };
  }

  @Post('/apply-discount')
  async applyDiscount(@GetOrgFromRequest() org: Organization) {
    await this._razorpayService.applyDiscount(org.paymentId);
  }

  /**
   * "Finish the trial, charge me now". The trial ends only when Razorpay
   * accepted the early charge: ending it lifts the trial limits, and it used
   * to be ended whatever happened, so a refused UPI charge, or a workspace
   * with no subscription at all, got them lifted without paying.
   */
  @Post('/finish-trial')
  // Owner and admins only, like the rest of Billing: it charges the owner's
  // mandate now. Until 2 Nov 2026 a USER member could bring the charge forward.
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async finishTrial(@GetOrgFromRequest() org: Organization) {
    // A throw (Razorpay unreachable while the subscription is read) happens
    // before any charge is asked for; it is not "this workspace has no trial".
    // unknown comes from the service: the charge was asked for and Razorpay
    // never said whether it took.
    const result: {
      ok: boolean;
      startAt?: Date | null;
      error?: boolean;
      unknown?: boolean;
    } = org.paymentId
      ? await this._razorpayService
          .finishTrial(org.id)
          .catch(() => ({ ok: false, startAt: null, error: true }))
      : { ok: false, startAt: null };
    if (result.ok) {
      await this._organizationService.setTrialFinished(org.id);
    }
    return {
      finish: result.ok,
      /** When the trial's first charge still is, when it could not move. */
      startAt: result.startAt || null,
      /** The payment provider could not be reached: try again, not "no trial". */
      error: !!result.error,
      /** The charge was asked for with no answer: it may have gone through. */
      unknown: !!result.unknown,
    };
  }

  /**
   * What is left of this plan month's metered allowances: the shared AI
   * credits (tiers with ai_credits) and the X posts. The plan screen shows it.
   */
  @Get('/usage')
  @Header('Cache-Control', 'private, no-store')
  usage(@GetOrgFromRequest() org: Organization) {
    return this._subscriptionService.planUsage(org);
  }

  @Get('/is-trial-finished')
  async isTrialFinished(@GetOrgFromRequest() org: Organization) {
    const currentOrg = await this._organizationService.getOrgById(org.id);
    return {
      finished: !currentOrg?.isTrailing,
    };
  }

  /**
   * What this workspace is shown and would be charged, decided on the server.
   * Never cached: it depends on the org's plan and on cf-ipcountry.
   */
  @Get('/pricing-context')
  @Header('Cache-Control', 'private, no-store')
  pricingContext(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Req() req: Request,
    @Query('tz') tz?: string
  ) {
    return this._razorpayService.getPricingContext({
      organizationId: org.id,
      userId: user?.id,
      headers: req.headers,
      tz,
      // The Billing page is ADMIN/SUPERADMIN only; other members get list prices.
      includeCurrentPlan: ['ADMIN', 'SUPERADMIN'].includes(
        // @ts-ignore users is the requesting member's row
        org?.users?.[0]?.role
      ),
    });
  }

  @Post('/embedded')
  // Owner and admins only, like the rest of Billing. Until 31 Oct 2026 a
  // USER member could change the plan here and charge the owner's mandate.
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async embedded(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: BillingSubscribeDto,
    @Req() req: Request
  ) {
    if (await this.assertNoOtherSubscribedAccount(user)) {
      return { blocked: true };
    }
    await this.assertNotDisputed(org.id);
    await this.assertNotBilledOnGumroad(org.id);
    await this.assertNoOneTimePlan(org.id);

    const uniqueId = req?.cookies?.track;
    const hints = { requestCountry: trustedCountry(req.headers), tz: body.tz };
    return this._razorpayService.embedded(
      uniqueId,
      org.id,
      user.id,
      body,
      // No trial for a workspace on its free posts: charged at once, so the
      // first-month offer applies (trial.policy.ts checkoutAllowsTrial).
      await this._subscriptionService.checkoutAllowsTrial(
        org.id,
        org.allowTrial,
        hints,
        { userId: user.id }
      ),
      hints
    );
  }

  @Post('/subscribe')
  // Owner and admins only, like the rest of Billing. Until 31 Oct 2026 a
  // USER member could change the plan here and charge the owner's mandate.
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async subscribe(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: BillingSubscribeDto,
    @Req() req: Request
  ) {
    if (await this.assertNoOtherSubscribedAccount(user)) {
      return { blocked: true };
    }
    await this.assertNotDisputed(org.id);
    await this.assertNotBilledOnGumroad(org.id);
    await this.assertNoOneTimePlan(org.id);

    const uniqueId = req?.cookies?.track;
    const hints = { requestCountry: trustedCountry(req.headers), tz: body.tz };
    return this._razorpayService.subscribe(
      uniqueId,
      org.id,
      user.id,
      body,
      // No trial for a workspace on its free posts: charged at once, so the
      // first-month offer applies (trial.policy.ts checkoutAllowsTrial).
      await this._subscriptionService.checkoutAllowsTrial(
        org.id,
        org.allowTrial,
        hints,
        { userId: user.id }
      ),
      hints
    );
  }

  @Get('/')
  getCurrentBilling(@GetOrgFromRequest() org: Organization) {
    return this._subscriptionService.getSubscriptionByOrganizationId(org.id);
  }

  /**
   * Stop future charges; the plan stays until the end of the paid period.
   * Errors come back as 4xx with a message the page shows as it is.
   */
  @Post('/cancel')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async cancel(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: { feedback?: string }
  ) {
    const result = await this._razorpayService.cancelAtPeriodEnd(org.id, {
      userId: user.id,
      feedback: typeof body?.feedback === 'string' ? body.feedback : undefined,
    });

    // Only for a cancellation that just happened, not a repeat click.
    if (!result.alreadyScheduled) {
      const note = cancelNoteEmail({
        orgName: org.name,
        orgId: org.id,
        customerEmail: user.email,
        feedback: body?.feedback,
      });
      await this._notificationService.sendEmail(
        process.env.EMAIL_FROM_ADDRESS,
        note.subject,
        note.html,
        user.email
      );
    }

    return result;
  }

  /**
   * Whether Cancel would end the plan now (a charge on it was refunded)
   * rather than at the end of the period, for the confirm dialog.
   */
  @Get('/cancel/quote')
  @Header('Cache-Control', 'private, no-store')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  cancelQuote(@GetOrgFromRequest() org: Organization) {
    return this._razorpayService.cancelQuote(org.id);
  }

  /**
   * Keep a plan that is set to end. Razorpay cannot undo a scheduled
   * cancellation, so this opens a new mandate on the same plan, starting
   * when the paid period ends; the page opens checkout for it.
   */
  @Post('/reactivate')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async reactivate(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User
  ) {
    // Reactivate opens a new mandate, so it is a way to buy again: refused
    // for a disputed workspace like checkout is. It matters when the dispute
    // marked the workspace but could not end the plan (handleDispute's retry
    // path), which is exactly when the plan row is still there to reactivate.
    await this.assertNotDisputed(org.id);
    return this._razorpayService.startReplacementMandate(
      org.id,
      user.id,
      'reactivate'
    );
  }

  /**
   * Change how the plan is paid. A UPI Autopay or e-mandate cannot be edited,
   * so this opens a new mandate on the same plan from the next renewal; the
   * old one is cancelled once the new one is approved.
   */
  @Post('/payment-method')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async changePaymentMethod(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User
  ) {
    // The same new mandate as Reactivate, so the same refusal: a disputed
    // workspace may not put a second card behind the plan its bank is
    // charging back.
    await this.assertNotDisputed(org.id);
    return this._razorpayService.startReplacementMandate(
      org.id,
      user.id,
      'payment_method'
    );
  }

  /**
   * What Reactivate would open (plan, amount, currency, period, first charge
   * date, whether it is charged on approval), without creating anything on
   * Razorpay. The page shows these before the customer agrees, then calls
   * POST /billing/reactivate.
   */
  @Get('/reactivate/quote')
  @Header('Cache-Control', 'private, no-store')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  reactivateQuote(@GetOrgFromRequest() org: Organization) {
    return this._razorpayService.quoteReplacementMandate(org.id, 'reactivate');
  }

  /** As /reactivate/quote, for POST /billing/payment-method. */
  @Get('/payment-method/quote')
  @Header('Cache-Control', 'private, no-store')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  paymentMethodQuote(@GetOrgFromRequest() org: Organization) {
    return this._razorpayService.quoteReplacementMandate(
      org.id,
      'payment_method'
    );
  }

  /**
   * Whether the plan's last charge failed (pending or halted at Razorpay),
   * for the "Pay from a different account" banner in the app.
   */
  @Get('/payment-issue')
  @Header('Cache-Control', 'private, no-store')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  paymentIssue(@GetOrgFromRequest() org: Organization) {
    return this._razorpayService.paymentIssue(org.id);
  }

  /**
   * Drop the downgrade scheduled for the end of the cycle ("Changes to <plan>
   * on <date>" in Billing) and carry on unchanged. Nothing is charged.
   *
   * Only where Razorpay holds it as a pending update on the mandate, which is
   * a card. A change held as a second mandate needs a new one approved
   * instead (/plan-change/keep-plan); `how` on the scheduled change says
   * which, so the page never calls the wrong one.
   */
  @Post('/plan-change/undo')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  undoPlanChange(@GetOrgFromRequest() org: Organization) {
    return this._razorpayService.undoScheduledPlanChange(org.id);
  }

  /**
   * Stay on the current plan instead of the scheduled downgrade, where
   * Razorpay cannot drop the change: it approves a fresh mandate for the plan
   * being kept, at the price being paid for it, charged where the paid cycle
   * ends. Same two steps as Reactivate - the quote creates nothing.
   */
  @Get('/plan-change/keep-plan/quote')
  @Header('Cache-Control', 'private, no-store')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  keepPlanQuote(@GetOrgFromRequest() org: Organization) {
    return this._razorpayService.quoteReplacementMandate(
      org.id,
      'undo_downgrade'
    );
  }

  @Post('/plan-change/keep-plan')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  keepPlan(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User
  ) {
    return this._razorpayService.startReplacementMandate(
      org.id,
      user.id,
      'undo_downgrade'
    );
  }

  /**
   * Withdraw a mandate from /reactivate or /payment-method that the customer
   * turned down before checkout opened (its terms changed after the quote, or
   * checkout could not load). Only an unapproved one of this workspace's.
   */
  @Post('/replacement/discard')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  discardReplacement(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { subscriptionId?: string }
  ) {
    return this._razorpayService.discardReplacementMandate(
      org.id,
      String(body?.subscriptionId || '')
    );
  }

  /** The workspace's own paid and due invoices, newest first. */
  @Get('/invoices')
  @Header('Cache-Control', 'private, no-store')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  invoices(@GetOrgFromRequest() org: Organization) {
    return this._razorpayService.listInvoices(org.id);
  }

  @Post('/prorate')
  // Owner and admins only, like the rest of Billing. Until 31 Oct 2026 a
  // USER member could change the plan here and charge the owner's mandate.
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  prorate(
    @GetOrgFromRequest() org: Organization,
    @Body() body: BillingSubscribeDto,
    @Req() req: Request
  ) {
    return this._razorpayService.prorate(org.id, body, {
      requestCountry: trustedCountry(req.headers),
      tz: body.tz,
    });
  }

  @Get('/charges')
  async getCharges(
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() org: Organization
  ) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }

    return this._razorpayService.getCharges(org.id);
  }

  /**
   * The Refund button of the impersonation bar's charges list. Goes through
   * RefundsService like /admin/refunds: JSON only (CSRF), only payments
   * identified as Hookpost's (the Razorpay account is shared; another
   * product's payment is refunded only from /admin/refunds, on purpose),
   * a per-payment lock and a RefundAudit row naming the super admin.
   */
  @Post('/refund-charges')
  async refundCharges(
    @GetUserFromRequest() user: User,
    @Req() req: Request,
    @Body() body: { chargeIds: string[] }
  ) {
    if (!user?.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }
    assertJsonRequest(req);
    if (!Array.isArray(body?.chargeIds)) {
      throw new HttpException('chargeIds must be a list of payment ids', 400);
    }

    const admin = await this.realSuperAdmin(user, req);
    return this._refundsService.refundBulk(
      { id: admin.id, email: admin.email },
      body.chargeIds
    );
  }

  /**
   * While impersonating, req.user is the impersonated workspace's user with
   * isSuperAdmin set (auth.middleware), so an audit row would carry their
   * name. The auth token still names the super admin who pressed the button.
   */
  private async realSuperAdmin(user: User, req: Request): Promise<User> {
    // Any sign of impersonation, a header included: where AuthMiddleware did
    // not act on it (secure cookies ignore the header), the token names
    // req.user anyway.
    if (!(req?.cookies?.impersonate || req?.headers?.impersonate)) return user;
    let id: string | undefined;
    try {
      id = AuthService.verifySessionJWT(sessionToken(req)).id;
    } catch {
      id = undefined;
    }
    const admin = id ? await this._usersService.getUserById(id) : null;
    if (!admin?.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }
    return admin;
  }

  @Post('/cancel-subscription')
  async cancelSubscription(
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request
  ) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }
    assertJsonRequest(req);

    // A workspace on the free plan has nothing to cancel. The dialog used to
    // warn "the user will be downgraded to FREE" for users already on FREE.
    const sub = await this._subscriptionService.getSubscription(org.id);
    if (!sub) {
      return {
        ok: false,
        reason: 'This workspace has no paid subscription to cancel.',
      };
    }
    if (sub.isLifetime) {
      return {
        ok: false,
        reason:
          'This is a lifetime plan with no Razorpay subscription behind it. Change the tier instead of cancelling.',
      };
    }
    if (isGumroadIdentifier(sub.identifier)) {
      return {
        ok: false,
        reason:
          'This plan is paid on Gumroad, with no Razorpay subscription behind it. Cancel or refund the sale in Gumroad; the daily re-check (GUMROAD_ACCESS_TOKEN) then ends the plan here.',
      };
    }

    return this._razorpayService.cancelSubscription(org.id);
  }

  // ---- Website coupons (buyer-facing) ----
  @Get('/coupon/validate')
  async validateWebsiteCoupon(
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request,
    @Query('code') code: string,
    @Query('billing') billing?: string,
    @Query('period') period?: string,
    @Query('tz') tz?: string
  ) {
    const check = await this._subscriptionService.validateCoupon(code, org.id);
    if (!check.ok) {
      return { valid: false, reason: check.reason };
    }
    const { coupon } = check;
    // The currency checkout would charge, not a ?currency= from the page.
    // Finding it costs a Razorpay read, so only when a price is asked for.
    const currency = billing
      ? await this._razorpayService.displayCurrencyFor(org.id, {
          requestCountry: trustedCountry(req.headers),
          tz,
        })
      : 'INR';
    const plan =
      billing && (getPricing(currency) as any)[billing.toUpperCase()];
    const base = plan
      ? period === 'YEARLY'
        ? plan.year_price
        : plan.month_price
      : null;
    return {
      valid: true,
      code: coupon.code,
      percentOff: coupon.percentOff,
      freeMonths: coupon.freeMonths,
      price: base,
      discountedPrice: base != null ? couponPrice(base, coupon.percentOff) : base,
    };
  }

  // ---- Website coupons (platform admin) ----
  @Get('/admin/coupons')
  async listCoupons(@GetUserFromRequest() user: User) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }
    return this._subscriptionService.listCoupons();
  }

  @Post('/admin/coupons')
  async createCoupon(
    @GetUserFromRequest() user: User,
    @Body()
    body: {
      code: string;
      percentOff?: number;
      freeMonths?: number;
      maxRedemptions?: number;
      expiresAt?: string;
      note?: string;
    },
    @Req() req: Request
  ) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }
    // A coupon is money off: never from another *.hookstep.in page's form.
    assertJsonRequest(req);
    const code = String(body.code || '').trim().toUpperCase();
    const pct = body.percentOff != null ? Number(body.percentOff) : null;
    const months = body.freeMonths != null ? Number(body.freeMonths) : null;
    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {
      throw new HttpException('Code: 3-40 letters, digits, - or _', 400);
    }
    // Exactly one kind. 90% is the ceiling: Razorpay rejects a plan below
    // Rs 1, and a 100%-off plan is what freeMonths is for.
    if ((pct == null) === (months == null)) {
      throw new HttpException('Give either percentOff or freeMonths', 400);
    }
    if (pct != null && (!Number.isInteger(pct) || pct < 1 || pct > 90)) {
      throw new HttpException('percentOff must be a whole number 1-90', 400);
    }
    if (months != null && (!Number.isInteger(months) || months < 1 || months > 12)) {
      throw new HttpException('freeMonths must be a whole number 1-12', 400);
    }
    return this._subscriptionService.createCoupon({
      code,
      percentOff: pct,
      freeMonths: months,
      maxRedemptions:
        body.maxRedemptions != null ? Number(body.maxRedemptions) : null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      note: body.note || null,
    });
  }

  @Post('/admin/coupons/:id/active')
  async setCouponActive(
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: { active: boolean },
    @Req() req: Request
  ) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }
    assertJsonRequest(req);
    return this._subscriptionService.setCouponActive(id, !!body.active);
  }

  @Get('/coupon-info')
  async couponInfo(
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() org: Organization
  ) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }

    const sub = await this._subscriptionService.getSubscription(org.id);
    const tier = sub?.subscriptionTier || null;
    const plan = tier ? (pricing as any)[tier] : undefined;
    return {
      tier,
      period: sub?.period || null,
      isLifetime: !!sub?.isLifetime,
      monthlyPrice: plan?.month_price || 0,
      planPrice:
        (sub?.period === 'YEARLY' ? plan?.year_price : plan?.month_price) || 0,
      nextPayment: null,
      coupons: [],
      supported: false,
      reason: COUPON_UNSUPPORTED_REASON,
    };
  }

  @Post('/apply-coupon')
  async applyCoupon(
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() org: Organization,
    @Body() body: AdminApplyCouponDto
  ) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }

    return { applied: false, reason: COUPON_UNSUPPORTED_REASON };
  }

  @Post('/cancel-coupon')
  async cancelCoupon(
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() org: Organization
  ) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }

    return { cancelled: false, reason: COUPON_UNSUPPORTED_REASON };
  }

  @Post('/add-subscription')
  async addSubscription(
    @Body() body: { subscription: string },
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request
  ) {
    if (!user.isSuperAdmin) {
      throw new Error('Unauthorized');
    }
    // A plan for free: never from another *.hookstep.in page's form.
    assertJsonRequest(req);

    await this._subscriptionService.addSubscription(
      org.id,
      user.id,
      body.subscription
    );
  }

}
