import { mustVerifyEmail } from '@hookpost/nestjs-libraries/services/email.verification';
import {
  Logger,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { GetUserFromRequest } from '@hookpost/nestjs-libraries/user/user.from.request';
import { sign } from 'jsonwebtoken';
import { Organization, User } from '@prisma/client';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { GetOrgFromRequest } from '@hookpost/nestjs-libraries/user/org.from.request';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { Response, Request } from 'express';
import { AuthService } from '@hookpost/backend/services/auth/auth.service';
import { inviteRefMatches } from '@hookpost/backend/services/auth/invite.ref';
import { AuthService as AuthChecker } from '@hookpost/helpers/auth/auth.service';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';
import { CheckPolicies } from '@hookpost/backend/services/auth/permissions/permissions.ability';
import { getCookieUrlFromDomain } from '@hookpost/helpers/subdomain/subdomain.management';
import {
  clearPendingInvite,
  cookiesSecured,
  endSession,
  impersonationTarget,
  selectWorkspace,
  sessionCookie,
  sessionToken,
  settlePendingInvite,
  stopImpersonation,
} from '@hookpost/backend/services/auth/session.cookies';
import {
  assertAppOrigin,
  assertJsonRequest,
} from '@hookpost/backend/services/auth/json.only';
import { INVITE_PENDING_COOKIE } from '@hookpost/helpers/auth/team.invite';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { ApiTags } from '@nestjs/swagger';
import { UsersService } from '@hookpost/nestjs-libraries/database/prisma/users/users.service';
import { UserDetailDto } from '@hookpost/nestjs-libraries/dtos/users/user.details.dto';
import { EmailNotificationsDto } from '@hookpost/nestjs-libraries/dtos/users/email-notifications.dto';
import { ReviewAskDto } from '@hookpost/nestjs-libraries/dtos/users/review-ask.dto';
import { ReviewAskService } from '@hookpost/nestjs-libraries/database/prisma/review-ask/review.ask.service';
import { HttpForbiddenException } from '@hookpost/nestjs-libraries/services/exception.filter';
import { RealIP } from 'nestjs-real-ip';
import { UserAgent } from '@hookpost/nestjs-libraries/user/user.agent';
import { TrackEnum } from '@hookpost/nestjs-libraries/user/track.enum';
import { TrackService } from '@hookpost/nestjs-libraries/track/track.service';
import { AffiliateService } from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import {
  AuthorizationActions,
  Sections,
} from '@hookpost/backend/services/auth/permissions/permission.exception.class';
import { trustedCountry } from '@hookpost/nestjs-libraries/services/billing.currency';
import { isOrderIdentifier } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/one.time.plan';
import { gumroadRedeemEnabled } from '@hookpost/nestjs-libraries/services/gumroad.license';
import {
  blocksPlanUse,
  preTrialChannelLimit,
  TRIAL_DAYS,
  trialPolicyActive,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

@ApiTags('User')
@Controller('/user')
export class UsersController {
  constructor(
    private _subscriptionService: SubscriptionService,
    private _razorpayService: RazorpayService,
    private _authService: AuthService,
    private _orgService: OrganizationService,
    private _userService: UsersService,
    private _trackService: TrackService,
    private _affiliateService: AffiliateService,
    private _reviewAskService: ReviewAskService
  ) {}

  @Get('/chatbase-token')
  async getChatbaseToken(
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() organization: Organization
  ) {
    if (!process.env.CHATBASE_TOKEN) {
      throw new HttpException('Chatbase SSO is not configured', 400);
    }

    const token = sign(
      {
        user_id: organization.id,
        email: user.email,
        ...(organization.paymentId
          ? {
              payment_accounts: [
                {
                  label: organization.name,
                  payment_id: organization.paymentId,
                },
              ],
            }
          : {}),
      },
      process.env.CHATBASE_TOKEN,
      { expiresIn: '1h' }
    );

    return { token };
  }

  @Get('/agent-media-sso')
  async getAgentMediaSsoUrl(
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() organization: Organization
  ) {
    if (!process.env.AGENT_MEDIA_SSO_KEY) {
      throw new HttpException('Agent Media SSO is not configured', 400);
    }

    const token = sign(
      { id: organization.id, displayName: organization.name },
      process.env.AGENT_MEDIA_SSO_KEY
    );

    return { url: `https://agent-media.ai/sso/${token}` };
  }

  @Get('/self')
  async getSelf(
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() organization: Organization,
    @Req() req: Request
  ) {
    if (!organization) {
      throw new HttpForbiddenException();
    }

    // The same source AuthMiddleware impersonates from.
    const impersonate = impersonationTarget(req);

    // An account that has to confirm its email first gets only what the
    // "Check your inbox" screen shows (the hard gate, email.verification.ts):
    // no workspace, plan or key details. An admin impersonating it sees the
    // workspace as usual.
    if (!impersonate && mustVerifyEmail(user)) {
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        providerName: user.providerName,
        activated: false,
        emailVerificationRequired: true,
        orgId: organization.id,
      };
    }

    // When this person was last here (at most one write an hour). Not while
    // an admin is looking at their workspace. Never waited on.
    if (!impersonate) {
      void this._userService.markOnline(user.id);
    }

    // Credit the affiliate whose ?ref= link brought this visitor in. Every
    // signed-in page load hits this endpoint, whichever way they registered.
    // Skipped while impersonating so an admin's session never attributes.
    if (req.cookies.hp_ref && !impersonate) {
      await this._affiliateService.attribute(
        req.cookies.hp_ref,
        organization,
        user
      );
    }

    // Where the workspace stands with the trial policy (trial.policy.ts).
    // tier stays 'FREE' for a workspace without a plan, needs_trial and
    // locked included: seven places on the page read tier.current without a
    // guard. planState is what tells them apart.
    const {
      state: planState,
      freePlanAvailable,
      freePlanEndsAt,
      freePlanSunsetAt,
    } = await this._subscriptionService.getPlanState(organization.id, {
      requestCountry: trustedCountry(req.headers),
    });
    // MCP and the public API key are refused while the workspace has to start
    // its trial or choose a plan, so the key is not handed out either.
    const apiAllowed = !blocksPlanUse(planState);
    // Whether a checkout opened now starts with a trial: not for a workspace
    // on its free posts, which is charged at once, unless the trial switch is
    // on and nobody behind it has had one (checkoutAllowsTrial). The
    // paywall's trial wording and the first-month offer read it.
    const allowTrial = await this._subscriptionService.checkoutAllowsTrial(
      organization.id,
      organization?.allowTrial,
      { requestCountry: trustedCountry(req.headers) },
      { state: planState, userId: user.id }
    );
    // Its FREE_POST_LIMIT allowance, for the counter over the app.
    const freePosts =
      planState === 'free_posts'
        ? await this._subscriptionService.freePostsUsage(organization.id, {
            requestCountry: trustedCountry(req.headers),
          })
        : null;

    // @ts-ignore
    return {
      ...user,
      orgId: organization.id,
      emailVerificationRequired: false,
      totalChannels: !process.env.RAZORPAY_KEY_ID
        ? 10000
        : // @ts-ignore
          organization?.subscription?.totalChannels || pricing.FREE.channel,
      tier:
        // @ts-ignore
        organization?.subscription?.subscriptionTier ||
        (!process.env.RAZORPAY_KEY_ID ? 'ULTIMATE' : 'FREE'),
      // @ts-ignore
      role: organization?.users[0]?.role,
      // @ts-ignore
      isLifetime: !!organization?.subscription?.isLifetime,
      // A paid one-time month (one.time.plan.ts): when it ends, for the
      // "renew for another month" reminder; null for every other plan.
      oneTimePlanEndsAt:
        // @ts-ignore
        isOrderIdentifier(organization?.subscription?.identifier) &&
        // @ts-ignore
        organization?.subscription?.cancelAt
          ? // @ts-ignore
            new Date(organization.subscription.cancelAt).toISOString()
          : null,
      admin: !!user.isSuperAdmin,
      impersonate: !!impersonate,
      isTrailing: !process.env.RAZORPAY_KEY_ID
        ? false
        : organization?.isTrailing,
      allowTrial,
      planState,
      // How many of its FREE_POST_LIMIT posts a workspace on its free posts
      // has used and has left; null in every other state.
      freePosts: freePosts
        ? { used: freePosts.used, limit: freePosts.limit, left: freePosts.left }
        : null,
      // How many channels it may connect before its trial starts
      // (trial.policy.ts PRE_TRIAL_CHANNEL_LIMIT): a number only while it has
      // to start its trial, else null. The layout shows the connect step
      // before the paywall while there is room.
      preTrialChannelLimit: preTrialChannelLimit(planState),
      freePlanAvailable,
      // When a grandfathered Free plan ends (FREE_PLAN_SUNSET_AT), while that
      // is still ahead, for the notice in the app; null otherwise.
      freePlanEndsAt: freePlanEndsAt ? freePlanEndsAt.toISOString() : null,
      // The same date whatever plan the workspace is on now: when the Free
      // plan it would fall back to ends, for Billing's cancel copy.
      freePlanSunsetAt: freePlanSunsetAt ? freePlanSunsetAt.toISOString() : null,
      // The server's "continue free", read by the layout with the browser's
      // cookie: a Free workspace that chose Free on any device, or that has a
      // channel or a post, skips the plans screen. Only for planState free;
      // needs_trial and locked always get it (twa.ts showFirstBilling).
      continueFree:
        planState === 'free' && freePlanAvailable !== false
          ? await this._orgService.skipsPlansScreen(organization.id)
          : false,
      // Whether any trial cutoff is set, whatever this workspace's cohort. The
      // paywall's trial wording follows it for every workspace (PR-3), so a
      // grandfathered workspace starting a voluntary trial reads the same
      // terms as a new one.
      trialPolicyActive: trialPolicyActive(),
      // How long a trial started now would run, as subscribe() sets it:
      // TRIAL_DAYS, or 7 for a workspace the Free plan sunset notice of 21
      // Oct promised 7 to (trial.policy.ts SUNSET_NOTICE_TRIAL_DAYS). The
      // paywall's wording and its first-charge date read it. Only looked up
      // while the workspace can still start a trial.
      trialDays: allowTrial
        ? await this._subscriptionService.trialDaysFor(organization.id)
        : TRIAL_DAYS,
      // A trial's first-charge date; a cancelled trial keeps working until
      // then. Not for a paid plan set to end (isTrailing is false there).
      trialEndsAt:
        organization?.isTrailing &&
        (planState === 'trialing' || planState === 'cancelling')
          ? await this._razorpayService
              .trialEndsAt(organization.id)
              .catch(() => null)
          : null,
      streakSince: await this._orgService.getStreakStart(organization.id),
      // Whether the UGC (AgentMedia) sidebar item can work: /user/agent-media-sso
      // refuses without the key, and the item was a dead button. Only whether
      // it is set, never the key.
      agentMedia: !!process.env.AGENT_MEDIA_SSO_KEY,
      // A Gumroad product is configured (GUMROAD_PRODUCT_STANDARD / _PRO):
      // Billing and the paywall show "Bought on Gumroad? Enter your license
      // key". Only whether, never the product ids.
      gumroadRedeem: gumroadRedeemEnabled(),
      publicApi:
        apiAllowed &&
        // @ts-ignore
        (organization?.users[0]?.role === 'SUPERADMIN' ||
          // @ts-ignore
          organization?.users[0]?.role === 'ADMIN')
          ? organization?.apiKey
          : '',
    };
  }

  /**
   * "Start free" on the plans screen. Stored on the server so the plans
   * screen does not come back on another browser or phone (it lived only in
   * localStorage and a cookie). Changes no plan, limit or trial: it is only
   * read for a workspace already on the Free plan (see getSelf).
   */
  @Post('/free-plan')
  async chooseFreePlan(@GetOrgFromRequest() organization: Organization) {
    return this._orgService.chooseFreePlan(organization.id);
  }

  @Get('/personal')
  async getPersonalInformation(@GetUserFromRequest() user: User) {
    return this._userService.getPersonal(user.id);
  }

  @Get('/impersonate')
  async getImpersonate(
    @GetUserFromRequest() user: User,
    @Query('name') name: string
  ) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }

    return this._userService.getImpersonateUser(name);
  }

  @Post('/impersonate')
  async setImpersonate(
    @GetUserFromRequest() user: User,
    @Body('id') id: string,
    @Res({ passthrough: true }) response: Response,
    @Req() req: Request
  ) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }
    // Who the super admin acts as: never from another *.hookstep.in page's form.
    assertJsonRequest(req);

    // The stop button sends an empty id: expire the cookie rather than keep an
    // empty one for a year.
    if (!id) {
      stopImpersonation(response);
      return;
    }

    response.cookie('impersonate', id, sessionCookie());

    if (!cookiesSecured()) {
      response.header('impersonate', id);
    }
  }

  @Post('/switch')
  async switchUser(
    @GetUserFromRequest() user: User,
    @Body('id') id: string,
    @Req() req: Request
  ) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }
    // Swaps two accounts' logins. Until 2 Nov 2026 a form on any
    // *.hookstep.in page could send it while a super admin impersonated the
    // attacker, handing the attacker the victim's account.
    assertJsonRequest(req);

    // `user` is the impersonated account, so the admin id comes from the token.
    // Require an active impersonation session and never allow the admin's own
    // account in the swap — either would trade away the admin's login.
    const adminId = this.getRequestUserId(req);
    if (
      !id ||
      !adminId ||
      id === user.id ||
      adminId === user.id ||
      adminId === id
    ) {
      throw new HttpException('Invalid user to switch to', 400);
    }

    const { kept, switched } = await this._userService.switchUser(
      user.id,
      id,
      adminId
    );

    await this._razorpayService.syncCustomerEmailsAfterSwitch([kept, switched]);

    return { success: true };
  }

  private getRequestUserId(req: Request): string | null {
    try {
      return AuthChecker.verifySessionJWT(sessionToken(req)).id;
    } catch {
      return null;
    }
  }

  @Post('/personal')
  async changePersonal(
    @GetUserFromRequest() user: User,
    @Body() body: UserDetailDto
  ) {
    return this._userService.changePersonal(user.id, body);
  }

  @Get('/email-notifications')
  async getEmailNotifications(@GetUserFromRequest() user: User) {
    return this._userService.getEmailNotifications(user.id);
  }

  @Post('/email-notifications')
  async updateEmailNotifications(
    @GetUserFromRequest() user: User,
    @Body() body: EmailNotificationsDto
  ) {
    return this._userService.updateEmailNotifications(user.id, body);
  }

  /**
   * Whether the "Enjoying Hookpost? A short review helps a lot." card is due
   * for this user (review.ask.policy.ts). Only `ask`, never why not.
   */
  @Get('/review-ask')
  async getReviewAsk(@GetUserFromRequest() user: User, @Req() req: Request) {
    const decision = await this._reviewAskService.status(
      user,
      !!impersonationTarget(req)
    );
    return { ask: decision.ask };
  }

  /**
   * The card was shown (claims the ask: `ok` false means do not show it),
   * dismissed, or a review page was opened. JSON only, like every other
   * state-changing call the app makes, so a cross-site form cannot spend a
   * user's ask.
   */
  @Post('/review-ask')
  @HttpCode(200)
  async recordReviewAsk(
    @GetUserFromRequest() user: User,
    @Body() body: ReviewAskDto,
    @Req() req: Request
  ) {
    assertJsonRequest(req);
    return this._reviewAskService.record(
      user,
      !!impersonationTarget(req),
      body.action,
      body.target
    );
  }

  @Post('/api-key/rotate')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async rotateApiKey(@GetOrgFromRequest() organization: Organization) {
    return this._orgService.updateApiKey(organization.id);
  }

  @Get('/subscription')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async getSubscription(@GetOrgFromRequest() organization: Organization) {
    const subscription =
      await this._subscriptionService.getSubscriptionByOrganizationId(
        organization.id
      );

    return subscription ? { subscription } : { subscription: undefined };
  }

  @Get('/subscription/tiers')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async tiers(
    @GetOrgFromRequest() organization: Organization,
    @Req() req: Request,
    @Query('tz') tz?: string
  ) {
    // ?currency= is no longer read: the prices are the ones checkout charges.
    return this._razorpayService.getPackages(
      await this._razorpayService.displayCurrencyFor(organization.id, {
        requestCountry: trustedCountry(req.headers),
        tz,
      })
    );
  }

  /**
   * The invite a signed-in visitor opened, for the Join question on /invite
   * ("Join <team>? You were invited by <name>. [Join team] [Not now]"). The
   * proxy keeps the token in the httpOnly INVITE_PENDING_COOKIE and asks
   * this first (a refused session goes to the sign-in form with the invite
   * kept). A GET: nothing is joined, held or marked used here.
   *
   * Until 25 Oct 2026 opening the link while signed in joined at once (the
   * proxy posted the token to /user/join-org on the GET), so a link a
   * stranger got someone to open put them into the stranger's workspace
   * before they had seen a thing. /user/join-org is gone; the only way in
   * for a signed-in account is the Join button below.
   */
  @Get('/invite')
  async pendingInvite(@GetUserFromRequest() user: User, @Req() req: Request) {
    return this._authService.pendingInvite(
      user,
      req.cookies?.[INVITE_PENDING_COOKIE]
    );
  }

  /**
   * The Join button. Redeemed the way a sign-up or sign-in redeems an invite
   * (redeemInvite): single use, the seat count and the plan under the
   * workspace's lock, held until the email is confirmed, "member" for
   * someone already in. CSRF: JSON only (a form or a no-cors fetch cannot
   * send it without a preflight, which only the app's origin passes) and an
   * Origin of the app itself; the session is the usual cookie or `auth`
   * header. The token comes only from the httpOnly cookie the proxy set on
   * the GET of /invite/<token>, never from the body, and `ref` must name
   * that same invite (PendingInvite), else 409 and nothing happens.
   *
   * `id`: the workspace now shown (joined, or already a member), else null.
   * `invite`: what became of the invite (team.invite.ts).
   */
  @Post('/invite/accept')
  @HttpCode(200)
  async acceptInvite(
    @GetUserFromRequest() user: User,
    @Req() req: Request,
    @Body('ref') ref: unknown,
    @Res({ passthrough: true }) response: Response
  ) {
    assertJsonRequest(req);
    assertAppOrigin(req);
    const token: unknown = req.cookies?.[INVITE_PENDING_COOKIE];
    const invite = this._authService.getOrgFromCookie(
      typeof token === 'string' ? token : undefined
    );
    if (invite && !inviteRefMatches(token as string, ref)) {
      // Another invite link was opened since this page asked: the page asks
      // again about that one instead.
      throw new HttpException(
        { invite: 'changed', message: 'This invite changed. Please look at it again.' },
        409
      );
    }
    const redeemed = (await this._authService.redeemInvite(user, invite)) ?? {
      outcome: 'invalid' as const,
    };
    settlePendingInvite(response, redeemed);
    return {
      id: redeemed.organizationId ?? null,
      invite: redeemed.outcome,
    };
  }

  /**
   * "Not now": the question goes away and the invite stays as it was, so the
   * link works again until it expires. Same CSRF checks as Join.
   */
  @Post('/invite/dismiss')
  @HttpCode(200)
  dismissInvite(
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    assertJsonRequest(req);
    assertAppOrigin(req);
    clearPendingInvite(response);
    return { dismissed: true };
  }

  @Get('/organizations')
  async getOrgs(@GetUserFromRequest() user: User) {
    return (await this._orgService.getOrgsByUserId(user.id)).filter(
      (f) => !f.users[0].disabled
    );
  }

  @Post('/change-org')
  changeOrg(
    @Body('id') id: string,
    @Res({ passthrough: true }) response: Response
  ) {
    selectWorkspace(response, id);

    response.status(200).send();
  }

  @Post('/delete-account')
  async deleteAccount(
    @GetUserFromRequest() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const impersonate = impersonationTarget(req);
    if (impersonate) {
      throw new HttpException(
        'Account cannot be deleted while impersonating',
        400
      );
    }

    // Cancel billing before scrubbing the account — once the account is
    // deleted there is no way to retry a failed cancellation
    const ownedOrgs = await this._userService.getOrgsToDeleteForAccount(
      user.id
    );

    if (process.env.RAZORPAY_KEY_ID) {
      for (const org of ownedOrgs) {
        if (!org.paymentId) {
          continue;
        }
        try {
          await this._razorpayService.cancelAllSubscriptions(org.id);
        } catch (err) {
          console.error(
            `Failed to cancel subscriptions during account deletion for org ${org.id}:`,
            err
          );
        }
      }
    }

    await this._userService.deleteAccount(user.id);

    return this.logout(response);
  }

  @Post('/logout')
  logout(@Res({ passthrough: true }) response: Response) {
    response.header('logout', 'true');
    endSession(response);

    response.status(200).send();
  }

  @Post('/t')
  async trackEvent(
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request,
    @GetUserFromRequest() user: User,
    @RealIP() ip: string,
    @UserAgent() userAgent: string,
    @Body()
    body: { tt: TrackEnum; fbclid: string; additional: Record<string, any> }
  ) {
    const uniqueId = req?.cookies?.track || makeId(10);
    const fbclid = req?.cookies?.fbclid || body.fbclid;
    // Same exposure as POST /public/t: track() ends in a live Meta Graph call
    // that rejects on any non-2xx, and unguarded that turns a failed analytics
    // beacon into a 500 on a user-facing request.
    try {
      await this._trackService.track(
        uniqueId,
        ip,
        userAgent,
        body.tt,
        body.additional,
        fbclid,
        user
      );
    } catch (e) {
      Logger.error(`Tracking failed for /user/t (non-fatal): ${e}`);
    }
    if (!req.cookies.track) {
      res.cookie('track', uniqueId, {
        domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
        ...(!process.env.NOT_SECURED
          ? {
              secure: true,
              httpOnly: true,
              sameSite: 'none',
            }
          : {}),
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });
    }

    res.status(200).json({
      track: uniqueId,
    });
  }
}
