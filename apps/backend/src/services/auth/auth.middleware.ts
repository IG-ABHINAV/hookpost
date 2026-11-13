import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import {
  AuthService,
  isSessionPayload,
} from '@hookpost/helpers/auth/auth.service';
import { User } from '@prisma/client';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';
import { UsersService } from '@hookpost/nestjs-libraries/database/prisma/users/users.service';
import {
  expired,
  impersonationTarget,
  refreshSession,
  sessionCookie,
  sessionToken,
  upgradeReadableSession,
} from '@hookpost/backend/services/auth/session.cookies';
import { HttpForbiddenException } from '@hookpost/nestjs-libraries/services/exception.filter';
import { MastraService } from '@hookpost/nestjs-libraries/chat/mastra.service';
import { setSentryUserContext } from '@hookpost/nestjs-libraries/sentry/initialize.sentry';
import {
  headerValue,
  trustedCountry,
} from '@hookpost/nestjs-libraries/services/billing.currency';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import {
  allowedBeforeVerification,
  EmailVerificationRequiredException,
  mustVerifyEmail,
} from '@hookpost/nestjs-libraries/services/email.verification';
import {
  blocksPlanUse,
  trialPolicyActive,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

export const removeAuth = (res: Response) => {
  res.cookie('auth', '', expired(sessionCookie()));
  res.header('logout', 'true');
};

// Users whose sign-up location this process has already written (or found), so the hot path does at most one write per user.
const geoDone = new Set<string>();
// Shared with the pricing context, which reads cf-ipcountry the same way (XX = unknown, T1 = Tor).
const header = (req: Request, name: string) => headerValue(req.headers, name);
// Fire-and-forget: a failure here must never block or fail the request.
function recordSignupGeoOnce(users: UsersService, user: User, req: Request) {
  if ((user as any).signupGeoAt || geoDone.has(user.id)) return;
  const country = header(req, 'cf-ipcountry');
  if (!country) return; // not behind Cloudflare (local dev) or unknown: try again on a later request
  geoDone.add(user.id);
  users
    .recordSignupGeo(user.id, { country, region: header(req, 'cf-region'), city: header(req, 'cf-ipcity') })
    .catch(() => geoDone.delete(user.id));
}

/**
 * A login session is signSessionJWT(user): the user row, with iat, exp and a
 * stamp of the password it was issued under. Every other token has its own
 * key (signPurposeJWT) and never verifies here; an older reset or invite
 * link signed with JWT_SECRET is refused by its shape (isSessionPayload).
 *
 * A session is refused once past its exp, when it has none, and when the
 * user's password has been reset or changed since it was issued. One that is
 * a day old is re-issued on the way through, so it lasts 30 days from the
 * last use, not from sign-in.
 */
export { isSessionPayload };

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private _organizationService: OrganizationService,
    private _userService: UsersService,
    private _subscriptionService: SubscriptionService
  ) {}

  /**
   * With no workspace chosen (no showorg cookie, e.g. a fresh browser), the
   * first one that can be used: not one that has to start its trial or choose
   * a plan first (trial.policy.ts). An invitee who signed up on the invite
   * link owns an empty personal workspace too, and used to land in it, on the
   * paywall, instead of in the workspace they were invited to.
   *
   * Only asked when the trial policy is on and there is a choice to make;
   * otherwise, and when every workspace is blocked, the first one as before.
   */
  private async firstUsableOrg<T extends { id: string }>(
    organizations: T[],
    req: Request
  ): Promise<T | undefined> {
    if (organizations.length < 2 || !trialPolicyActive()) return undefined;
    const requestCountry = trustedCountry(req.headers);
    for (const org of organizations) {
      const { state } = await this._subscriptionService
        .getPlanState(org.id, { requestCountry })
        .catch(() => ({ state: 'free' as const }));
      if (!blocksPlanUse(state)) return org;
    }
    return undefined;
  }
  async use(req: Request, res: Response, next: NextFunction) {
    let verificationRequired = false;
    // The cookie before the header (session.cookies.ts, sessionToken).
    const auth = sessionToken(req);
    if (!auth) {
      throw new HttpForbiddenException();
    }
    try {
      // Verify the JWT signature only. Never trust authorization-relevant
      // claims (id, isSuperAdmin, activated) from the token body — always
      // re-resolve the user from the database using the id.
      // A session only: a reset link, an invite or any other token throws.
      const payload = AuthService.verifySessionJWT(auth);
      const orgHeader = req.cookies.showorg || req.headers.showorg;

      let user = (await this._userService.getUserById(payload.id)) as User | null;

      if (!user) {
        throw new HttpForbiddenException();
      }

      // Issued before the password was last reset or changed: signed out.
      if (!AuthService.sessionMatchesPassword(payload, user.password)) {
        throw new HttpForbiddenException();
      }

      // An email+password account that has not confirmed its address may
      // call only itself, sign out and the confirmation routes (owner, 29 Oct
      // 2026: the hard gate, email.verification.ts). Judged on the signed-in
      // user, before any impersonation: an admin looking at such a
      // workspace is let through. The catch below makes every other error a
      // sign-out, so it rethrows this one as itself.
      if (
        mustVerifyEmail(user) &&
        !allowedBeforeVerification(req.method, req.originalUrl || req.url)
      ) {
        verificationRequired = true;
        throw new EmailVerificationRequiredException();
      }

      // Sliding expiry: a day-old session gets a new 30 days. Always the
      // signed-in user's own row, also while a super admin impersonates.
      // The new cookie is set with the secure flags over any copy that was
      // set without them; otherwise such a copy is set again with them and
      // the same token (upgradeReadableSession).
      if (AuthService.sessionNeedsRefresh(payload)) {
        refreshSession(res, AuthService.signSessionJWT(user));
      } else {
        upgradeReadableSession(req, res);
      }

      // With secure cookies, the httpOnly cookie only (never a header).
      const impersonate = impersonationTarget(req);
      if (user?.isSuperAdmin && impersonate) {
        const loadImpersonate = await this._organizationService.getUserOrg(
          impersonate
        );

        if (loadImpersonate) {
          user = loadImpersonate.user;
          user.isSuperAdmin = true;
          delete user.password;

          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error
          req.user = user;

          // @ts-ignore
          loadImpersonate.organization.users =
            loadImpersonate.organization.users.filter(
              (f) => f.userId === user.id
            );
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error
          req.org = loadImpersonate.organization;

          setSentryUserContext({
            userId: user.id,
            email: user.email,
            orgId: loadImpersonate.organization.id,
            paymentId: loadImpersonate.organization.paymentId,
          });
          next();
          return;
        }
      }

      delete user.password;
      recordSignupGeoOnce(this._userService, user, req);
      const organization = (
        await this._organizationService.getOrgsByUserId(user.id)
      ).filter((f) => !f.users[0].disabled);
      const setOrg =
        organization.find((org) => org.id === orgHeader) ||
        organization.find((org) => org.subscription) ||
        (await this.firstUsableOrg(organization, req)) ||
        organization[0];

      if (!organization) {
        throw new HttpForbiddenException();
      }

      if (!setOrg.apiKey) {
        await this._organizationService.updateApiKey(setOrg.id);
      }

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      req.user = user;

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      req.org = setOrg;

      setSentryUserContext({
        userId: user.id,
        email: user.email,
        orgId: setOrg.id,
        paymentId: setOrg.paymentId,
      });
    } catch (err) {
      if (verificationRequired) {
        throw new EmailVerificationRequiredException();
      }
      throw new HttpForbiddenException();
    }
    next();
  }
}
