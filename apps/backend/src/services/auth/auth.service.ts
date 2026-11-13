import { HttpException, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '@hookpost/nestjs-libraries/integrations/connect.log';
import { Prisma, Provider, User } from '@prisma/client';
import { CreateOrgUserDto } from '@hookpost/nestjs-libraries/dtos/auth/create.org.user.dto';
import { LoginUserDto } from '@hookpost/nestjs-libraries/dtos/auth/login.user.dto';
import { UsersService } from '@hookpost/nestjs-libraries/database/prisma/users/users.service';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';
import { AuthService as AuthChecker, TOKEN_PURPOSE } from '@hookpost/helpers/auth/auth.service';
import { AuthProviderManager } from '@hookpost/backend/services/auth/providers/providers.manager';
import dayjs from 'dayjs';
import { NotificationService } from '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service';
import { ForgotReturnPasswordDto } from '@hookpost/nestjs-libraries/dtos/auth/forgot-return.password.dto';
import { EmailService } from '@hookpost/nestjs-libraries/services/email.service';
import { NewsletterService } from '@hookpost/nestjs-libraries/newsletter/newsletter.service';
import {
  activationEmail,
  passwordResetEmail,
  workspacesRemovedEmail,
} from '@hookpost/nestjs-libraries/emails/templates/auth.emails';
import {
  ACTIVATION_LINK_TTL,
  ACTIVATION_SEND,
  Allowance,
  EMAIL_CHANGE,
  holdInvite,
  inviteMarkedUsed,
  LEGACY_ACTIVATION_LINK_MAX_AGE_SECONDS,
  markInviteUsed,
  maskEmail,
  peekHeldInvite,
  takeAllowance,
  takeHeldInvite,
} from '@hookpost/nestjs-libraries/services/email.verification';
import { inviteRef } from '@hookpost/backend/services/auth/invite.ref';
import {
  displayName,
  INVITER_NAME_MAX,
  InviteOutcome,
  TEAM_NAME_MAX,
} from '@hookpost/helpers/auth/team.invite';

/** A team invite token's claims, once checked (AuthService.getOrgFromCookie). */
export type TeamInvite = {
  orgId: string;
  id: string;
  role: 'USER' | 'ADMIN';
  timeLimit: string;
  email?: string;
  /** The member who made it (invites made since 25 Oct 2026). */
  by?: string;
};

/**
 * What the Join question (GET /user/invite) shows a signed-in visitor about
 * the invite they opened. `ref` names that exact invite: the Join button
 * sends it back, and POST /user/invite/accept refuses a different one, so
 * the button joins the team the page showed even if another tab or a popup
 * opened a second invite link in between. `confirmEmail`: the account has
 * not confirmed its email yet, so Join holds the invite until it does.
 */
export type PendingInvite =
  | { valid: false }
  | {
      valid: true;
      team: string;
      inviter: string | null;
      member: boolean;
      confirmEmail: boolean;
      ref: string;
    };

/**
 * What became of an invite: `organizationId` is the workspace to show
 * (joined, or already a member), when there is one.
 */
export type InviteRedemption = {
  outcome: InviteOutcome;
  organizationId?: string;
};

// Emails are compared case-insensitively and without surrounding spaces, so
// " Jo@Gmail.com" and "jo@gmail.com" are the same person.
/** The one answer to a wrong address or password (counted by auth.rate.limit.ts). */
export const INVALID_CREDENTIALS = 'Invalid user name or password';

const normaliseEmail = (email?: string | null) =>
  (email || '').trim().toLowerCase();

const PROVIDER_SIGN_IN: Record<Provider, string> = {
  LOCAL: 'your email and password',
  GOOGLE: 'Google',
  GITHUB: 'GitHub',
  APPLE: 'Apple',
  FARCASTER: 'Farcaster',
  WALLET: 'your wallet',
  GENERIC: 'single sign-on',
};

const providerLabel = (provider: string) =>
  PROVIDER_SIGN_IN[String(provider).toUpperCase() as Provider] || 'the provider';

/** The sign-in link (its code or its state) is spent, expired or foreign. */
export const OAUTH_SIGNIN_EXPIRED = (provider: string) =>
  `This ${providerLabel(provider)} sign-in link expired or was already used. Please continue with ${providerLabel(provider)} again.`;

/**
 * What the sign-up page is told when the provider login cannot be finished,
 * and why (for the log). A reload of /auth?code=... after a good sign-up
 * re-sends a spent code (invalid_grant); a state that does not match the
 * cookie is a link opened in another browser or an old tab.
 */
export const oauthExistsFailure = (
  provider: string,
  err: unknown
): { message: string; reason: string } => {
  const e = err as {
    message?: unknown;
    response?: { data?: { error?: unknown; error_description?: unknown } };
  };
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const code =
    typeof e?.response?.data?.error === 'string' ? e.response.data.error : '';
  const reason = [code, message].filter(Boolean).join(': ');
  if (
    message === 'Invalid state' ||
    /invalid_grant|bad_verification_code|expired|already (been )?(used|redeemed)/i.test(
      reason
    )
  ) {
    return { message: OAUTH_SIGNIN_EXPIRED(provider), reason };
  }
  if (message === 'Invalid user') {
    return {
      message: `${providerLabel(provider)} did not share your account details. Please try again, or sign up with your email.`,
      reason,
    };
  }
  return {
    message: `Signing in with ${providerLabel(provider)} did not finish. Please try again, or sign up with your email.`,
    reason,
  };
};

// Registration already answers "Email already exists", so naming the way in
// tells a stranger nothing the sign-up form did not, and saves the owner a
// second account.
export const existingAccountMessage = (provider: Provider) =>
  `An account with this email already exists. Sign in with ${
    PROVIDER_SIGN_IN[provider] || 'the method you used before'
  }.`;

const PASSWORD_RESET = TOKEN_PURPOSE.PASSWORD_RESET;

/**
 * An invite link sent before 22 Oct 2026: a plain JWT_SECRET token, valid for
 * two days (timeLimit). Taken only with an invite's own claims, orgId and
 * timeLimit, which no session has, and none of the claims later tokens carry.
 * The two-day limit runs out on 24 Oct 2026; this can go after that.
 */
function legacyInvite(token: string): Record<string, unknown> | null {
  try {
    const payload = AuthChecker.verifyJWT(token);
    if (
      !payload ||
      typeof payload !== 'object' ||
      'purpose' in payload ||
      'expires' in payload ||
      typeof (payload as { orgId?: unknown }).orgId !== 'string' ||
      typeof (payload as { timeLimit?: unknown }).timeLimit !== 'string'
    ) {
      return null;
    }
    // Never later than two days after it was issued (iat), like every real one.
    const { timeLimit, iat } = payload as { timeLimit: string; iat?: number };
    if (
      typeof iat !== 'number' ||
      dayjs(timeLimit).isAfter(dayjs.unix(iat).add(2, 'day').add(1, 'minute'))
    ) {
      return null;
    }
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The link in the "confirm your email" email. It used to be the new user's
 * login session itself; now it is an activation token, which is not a session.
 * It names the address it was sent to (an account that moved to another
 * address is not confirmed by a link sent to the old one) and works for
 * ACTIVATION_LINK_TTL.
 */
function activationUrl(user: { id: string; email: string }) {
  const token = AuthChecker.signPurposeJWT(
    TOKEN_PURPOSE.ACCOUNT_ACTIVATION,
    { id: user.id, email: normaliseEmail(user.email) },
    { expiresIn: ACTIVATION_LINK_TTL }
  );
  return `${process.env.FRONTEND_URL}/auth/activate/${token}`;
}

/**
 * Activation links sent before this deploy (22 Oct 2026) were the session of a
 * user who was not activated yet. Only a session issued before this moment is
 * taken as one; nothing issued later can be an old link.
 */
const LEGACY_ACTIVATION_ISSUED_BEFORE = Date.UTC(2026, 9, 22, 14, 0, 0) / 1000;

/**
 * A link without exp (every one sent before 25 Oct 2026) is taken for
 * LEGACY_ACTIVATION_LINK_MAX_AGE_SECONDS after it was issued.
 */
const withinLegacyAge = (iat: unknown, nowSeconds: number) =>
  typeof iat === 'number' &&
  nowSeconds - iat < LEGACY_ACTIVATION_LINK_MAX_AGE_SECONDS;

/**
 * The user an activation link is for and the address it was sent to, or
 * null. An expired link is refused (verifyPurposeJWT checks exp). An
 * unactivated session issued before LEGACY_ACTIVATION_ISSUED_BEFORE is still
 * taken as an old link; nothing else is.
 */
export function activationTarget(
  code: unknown,
  nowSeconds = Math.floor(Date.now() / 1000)
): { id: string; email: string | null } | null {
  try {
    const payload = AuthChecker.verifyPurposeJWT(
      TOKEN_PURPOSE.ACCOUNT_ACTIVATION,
      code
    );
    const { id, email, exp, iat } = payload as Record<string, unknown>;
    if (typeof id !== 'string' || !id) {
      return null;
    }
    if (typeof exp !== 'number' && !withinLegacyAge(iat, nowSeconds)) {
      return null;
    }
    return { id, email: typeof email === 'string' ? email : null };
  } catch {
    // Not a live activation token: maybe an old link.
  }
  try {
    // An old link is checked by signature and shape only
    // (verifyLegacySessionJWT); the issue time below is what limits it to
    // links sent before the cutoff.
    const session = AuthChecker.verifyLegacySessionJWT(code);
    const iat = session.iat;
    return session.activated === false &&
      typeof iat === 'number' &&
      iat < LEGACY_ACTIVATION_ISSUED_BEFORE &&
      withinLegacyAge(iat, nowSeconds)
      ? {
          id: session.id,
          email: typeof session.email === 'string' ? session.email : null,
        }
      : null;
  } catch {
    return null;
  }
}

/** What the banner's "Resend" and "Change address" answer. */
export type VerificationSendResult =
  | { sent: true; email: string }
  | { sent: false; reason: 'already_verified' }
  | { sent: false; reason: 'throttled'; retryAfterSeconds: number };

@Injectable()
export class AuthService {
  private readonly _logger = new Logger(AuthService.name);

  constructor(
    private _userService: UsersService,
    private _organizationService: OrganizationService,
    private _notificationService: NotificationService,
    private _emailService: EmailService,
    private _providerManager: AuthProviderManager
  ) {}
  async canRegister(provider: string) {
    if (
      process.env.DISABLE_REGISTRATION !== 'true' ||
      provider === Provider.GENERIC
    ) {
      return true;
    }

    return (await this._organizationService.getCount()) === 0;
  }

  /**
   * Signs up or signs in. `invite`: the team invite the visitor followed
   * (the `org` cookie), redeemed for the account this ends in, whichever way
   * it got in (redeemInvite); `invite` in the result says what became of it,
   * or is null when there was none.
   */
  async routeAuth(
    provider: Provider,
    body: CreateOrgUserDto | LoginUserDto,
    ip: string,
    userAgent: string,
    invite?: TeamInvite | false
  ): Promise<{
    jwt: string;
    created?: { organizationId: string; user: User };
    invite: InviteRedemption | null;
  }> {
    if (provider === Provider.LOCAL) {
      body.email = normaliseEmail(body.email);
      if (process.env.DISALLOW_PLUS && body.email.includes('+')) {
        throw new Error('Email with plus sign is not allowed');
      }
      if (body instanceof CreateOrgUserDto) {
        // Any provider, not just LOCAL: a Google user registering a password
        // would otherwise get a second account and a second workspace.
        const existing = await this._userService.getUserByEmailAnyProvider(
          body.email
        );
        if (existing) {
          throw new Error(existingAccountMessage(existing.providerName));
        }

        if (!(await this.canRegister(provider))) {
          throw new Error('Registration is disabled');
        }

        const create = await this._organizationService.createOrgAndUser(
          body,
          ip,
          userAgent
        );

        // Before the confirmation email, which names the team a held invite
        // waits for.
        const newUser = create.users[0].user;
        const redeemed = await this.redeemInvite(newUser, invite);

        const obj = {
          jwt: await this.jwt(create.users[0].user),
          // A new account: the controller records its attribution.
          created: { organizationId: create.id, user: create.users[0].user },
          invite: redeemed,
        };
        // Sent whether or not confirmation is required, as before (without
        // an email provider it goes nowhere).
        await this.sendActivation(create.users[0].user);
        return obj;
      }

      const user = await this._userService.getUserByEmail(body.email);
      if (
        !user ||
        !user.password ||
        !AuthChecker.comparePassword(body.password, user.password)
      ) {
        throw new Error(INVALID_CREDENTIALS);
      }

      // An account that has not confirmed its email signs in like any other
      // and can set up its workspace; publishing waits for the confirmation
      // (PostsService). Refusing the sign-in here is what stranded every
      // password sign-up that did not open the email at once.
      //
      // An invite followed before signing in is redeemed here too: until 25
      // Oct 2026 only a sign-up redeemed it, so someone who already had an
      // account signed in and joined nothing.
      const redeemed = await this.redeemInvite(user, invite);
      return { jwt: await this.jwt(user), created: undefined, invite: redeemed };
    }

    const { user, created } = await this.loginOrRegisterProvider(
      provider,
      body as CreateOrgUserDto,
      ip,
      userAgent
    );

    const redeemed = await this.redeemInvite(user, invite);
    return { jwt: await this.jwt(user), created, invite: redeemed };
  }

  /**
   * Redeems a team invite for `user`, the one way every sign-up, sign-in and
   * the signed-in app (POST /user/join-org) do it:
   *
   * - an account that has not confirmed its email: held, not joined, until
   *   the emailed link is used (activate). An invite link is not tied to an
   *   address, so until then the account may be the address owner's, put
   *   into someone's workspace by whoever typed it. A takeover of the
   *   address (Google, a reset link) drops it.
   * - a confirmed one (any provider sign-in, a password account that used
   *   its link): joined now, if the workspace has a free seat on a plan with
   *   a team.
   *
   * null when there was no invite at all; `invalid` when there was one but
   * it is forged, expired, used or its workspace is gone.
   */
  async redeemInvite(
    user: { id: string; activated?: boolean | null },
    invite: TeamInvite | false | null | undefined
  ): Promise<InviteRedemption | null> {
    if (!invite) {
      return null;
    }
    if (user.activated !== true) {
      // A link that cannot work is said so now, not after the confirmation.
      if (!(await this.inviteIsOpen(invite))) {
        return { outcome: 'invalid' };
      }
      const held = await holdInvite(user.id, {
        orgId: invite.orgId,
        id: invite.id,
        role: invite.role,
        timeLimit: invite.timeLimit,
      });
      return { outcome: held ? 'held' : 'error' };
    }
    return this.joinInvite(user.id, invite);
  }

  /** Joins a confirmed account now, and says what happened. */
  private async joinInvite(
    userId: string,
    invite: Pick<TeamInvite, 'id' | 'orgId' | 'role' | 'timeLimit'>
  ): Promise<InviteRedemption> {
    if (await inviteMarkedUsed(invite.id)) {
      // Used. Whoever used it may be opening it again: then they are told
      // they are in, not that the link is spent. Nothing is joined here.
      const orgs = await this._organizationService
        .getOrgsByUserId(userId)
        .catch(() => [] as { id: string }[]);
      return orgs.some((o) => o.id === invite.orgId)
        ? { outcome: 'member', organizationId: invite.orgId }
        : { outcome: 'invalid' };
    }
    let result: Awaited<ReturnType<OrganizationService['joinWithInvite']>>;
    try {
      result = await this._organizationService.joinWithInvite(
        userId,
        invite.id,
        invite.orgId,
        invite.role
      );
    } catch (err) {
      this._logger.warn(
        `invite ${invite.id} to ${invite.orgId} for ${userId} failed: ${
          (err as Error)?.message
        }`
      );
      return { outcome: 'error' };
    }
    // `in`, not `.joined`: the backend builds without strictNullChecks, where
    // a boolean discriminant does not narrow.
    if (!('reason' in result)) {
      await markInviteUsed(invite.id, invite.timeLimit);
      return { outcome: 'joined', organizationId: invite.orgId };
    }
    switch (result.reason) {
      case 'member':
        return { outcome: 'member', organizationId: invite.orgId };
      case 'full':
        return { outcome: 'full' };
      case 'unavailable':
        return { outcome: 'unavailable' };
      default:
        return { outcome: 'invalid' };
    }
  }

  /** Not used yet (Redis, then the database) and its workspace still exists. */
  private async inviteIsOpen(invite: Pick<TeamInvite, 'id' | 'orgId'>) {
    if (await inviteMarkedUsed(invite.id)) {
      return false;
    }
    try {
      return (
        await this._organizationService.inviteState(invite.id, invite.orgId)
      ).open;
    } catch {
      return false;
    }
  }

  /**
   * What the sign-up and sign-in pages say about the invite in the visitor's
   * `org` cookie: the team's name while it can still be redeemed, otherwise
   * only that it cannot. The token holder is whoever the invite email went
   * to, and that email names the team already.
   */
  async previewInvite(
    token: unknown
  ): Promise<{ valid: true; team: string } | { valid: false }> {
    const invite = this.getOrgFromCookie(
      typeof token === 'string' ? token : undefined
    );
    if (!invite || (await inviteMarkedUsed(invite.id))) {
      return { valid: false };
    }
    try {
      const state = await this._organizationService.inviteState(
        invite.id,
        invite.orgId
      );
      return state.open ? { valid: true, team: state.name } : { valid: false };
    } catch {
      return { valid: false };
    }
  }

  /**
   * The Join question a signed-in visitor answers before an invite they
   * opened is redeemed (GET /user/invite, for /invite). Reads only: nothing
   * is joined, held or marked used here, however often it is asked.
   *
   * Valid while redeemInvite could still do something with it: the
   * workspace exists and nobody used the invite yet (Redis marker, then the
   * database). Someone already in that workspace is told so (`member`),
   * also when they are the one who used it. Names are made fit to show
   * (displayName: one line, no control or direction characters, at most 60
   * characters); the page renders them as text.
   */
  async pendingInvite(
    user: { id: string; activated?: boolean | null },
    token: unknown
  ): Promise<PendingInvite> {
    const invite = this.getOrgFromCookie(
      typeof token === 'string' ? token : undefined
    );
    if (!invite) {
      return { valid: false };
    }
    let details: Awaited<ReturnType<OrganizationService['inviteDetails']>>;
    try {
      details = await this._organizationService.inviteDetails(
        invite.id,
        invite.orgId,
        user.id,
        invite.by
      );
    } catch {
      return { valid: false };
    }
    if (!details) {
      return { valid: false };
    }
    if (
      !details.member &&
      (details.used || (await inviteMarkedUsed(invite.id)))
    ) {
      return { valid: false };
    }
    return {
      valid: true,
      team: displayName(details.name, TEAM_NAME_MAX),
      inviter: displayName(details.inviter, INVITER_NAME_MAX) || null,
      member: details.member,
      confirmEmail: !details.member && user.activated !== true,
      ref: inviteRef(token as string),
    };
  }

  public getOrgFromCookie(cookie?: string): TeamInvite | false {
    if (!cookie) {
      return false;
    }

    let invite: Record<string, unknown>;
    try {
      invite = AuthChecker.verifyPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, cookie);
    } catch {
      const legacy = legacyInvite(cookie);
      if (!legacy) {
        return false;
      }
      invite = legacy;
    }

    const { orgId, id, role, timeLimit } = invite;
    if (
      typeof orgId !== 'string' ||
      !orgId ||
      typeof id !== 'string' ||
      !id ||
      (role !== 'USER' && role !== 'ADMIN') ||
      typeof timeLimit !== 'string' ||
      !dayjs(timeLimit).isValid() ||
      dayjs(timeLimit).isBefore(dayjs())
    ) {
      return false;
    }

    return {
      orgId,
      id,
      role,
      timeLimit,
      ...(typeof invite.email === 'string' ? { email: invite.email } : {}),
      ...(typeof invite.by === 'string' && invite.by ? { by: invite.by } : {}),
    };
  }

  private async loginOrRegisterProvider(
    provider: Provider,
    body: CreateOrgUserDto,
    ip: string,
    userAgent: string
  ) {
    const providerInstance = this._providerManager.getProvider(provider);
    const providerUser = await providerInstance.getUser(body.providerToken);

    if (!providerUser) {
      throw new Error('Invalid provider token');
    }

    const user = await this._userService.getUserByProvider(
      providerUser.id,
      provider
    );
    if (user) {
      return { user };
    }

    const existing = await this.existingUserForEmail(provider, providerUser);
    if (existing) {
      return { user: existing };
    }

    if (!(await this.canRegister(provider))) {
      throw new Error('Registration is disabled');
    }

    const create = await this._organizationService.createOrgAndUser(
      {
        company: body.company,
        // Wallet and Farcaster "emails" are ids, and are left as they are
        email: providerUser.email?.includes('@')
          ? normaliseEmail(providerUser.email)
          : providerUser.email,
        password: '',
        provider,
        providerId: providerUser.id,
        datafast_visitor_id: body.datafast_visitor_id,
      },
      ip,
      userAgent
    );

    this._track('register', providerUser.email, body.datafast_visitor_id).catch(
      (err) => {}
    );

    await NewsletterService.register(providerUser.email);

    try {
      if (providerInstance?.postRegistration) {
        await providerInstance.postRegistration(body.providerToken, create.id);
      }
    } catch (err) {
      // Don't fail registration if postRegistration fails
    }

    return {
      user: create.users[0].user,
      created: { organizationId: create.id, user: create.users[0].user },
    };
  }

  /**
   * One email, one account. A sign-in whose email already belongs to a user
   * under another provider (a password account, or Google when this is
   * GitHub) signs in as that user instead of creating a second one with its
   * own workspace. Only a provider-verified email may claim an account:
   * otherwise anyone could make an OAuth identity carrying someone else's
   * address. Nothing is stored about the link; the next sign-in finds the
   * same user the same way.
   *
   * Returns null when nobody holds the email. Throws when someone does but
   * the provider could not vouch for the address.
   */
  private async existingUserForEmail(
    provider: Provider,
    providerUser: { id: string; email: string; emailVerified?: boolean }
  ) {
    const email = normaliseEmail(providerUser.email);
    if (!email.includes('@')) {
      return null;
    }

    const existing = await this._userService.getUserByEmailAnyProvider(email);
    if (!existing) {
      return null;
    }

    if (!providerUser.emailVerified) {
      throw new Error(existingAccountMessage(existing.providerName));
    }

    if (existing.providerName === Provider.LOCAL && !existing.activated) {
      await this._userService.activateWithVerifiedEmail(existing.id);
      existing.activated = true;
      existing.password = '';
      // The password was never proven to belong to this mailbox's owner, and
      // since 25 Oct 2026 such an account can be used before it is confirmed.
      // Dropping the password signs its sessions out (the stamp changes);
      // secureTakeover does the rest.
      await this.secureTakeover(existing);
    }

    this._logger.log(
      `${provider} sign-in ${providerUser.id} matched existing ${existing.providerName} user ${existing.id} by verified email`
    );
    return existing;
  }

  private async _track(
    name: string,
    email: string,
    datafast_visitor_id: string
  ) {
    if (email && datafast_visitor_id && process.env.DATAFAST_API_KEY) {
      try {
        await fetch('https://datafa.st/api/v1/goals', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.DATAFAST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            datafast_visitor_id: datafast_visitor_id,
            name: name,
            metadata: {
              email,
            },
          }),
        });
      } catch (err) {}
    }
  }

  async forgot(email: string) {
    // LOCAL only: an OAuth-only user has no password to reset, and must not
    // get a password account created alongside the one they have.
    const user = await this._userService.getUserByEmail(normaliseEmail(email));
    if (!user || user.providerName !== Provider.LOCAL) {
      return false;
    }

    // Its own key and a real expiry (signPurposeJWT): a reset link used to be
    // a JWT_SECRET token of { id }, which also worked as a login session with
    // no expiry for anyone holding the email.
    // The address goes in too: a reset link used on an account that has not
    // confirmed its email also confirms it, but only for the address the
    // link was sent to (forgotReturn).
    const resetValues = AuthChecker.signPurposeJWT(
      PASSWORD_RESET,
      { id: user.id, email: normaliseEmail(user.email) },
      { expiresIn: '20m' }
    );

    const reset = passwordResetEmail({
      resetUrl: `${process.env.FRONTEND_URL}/auth/forgot/${resetValues}`,
      expiresInMinutes: 20,
    });
    await this._notificationService.sendEmail(
      user.email,
      reset.subject,
      reset.html
    );
  }

  async forgotReturn(body: ForgotReturnPasswordDto) {
    // Only a reset token: a session, an invite link or any other token signed
    // with JWT_SECRET is refused, and so is one past its 20 minutes.
    let token: Record<string, unknown>;
    try {
      token = AuthChecker.verifyPurposeJWT(PASSWORD_RESET, body.token);
    } catch {
      return false;
    }
    if (typeof token.id !== 'string' || !token.id) {
      return false;
    }

    // A link names the address it was sent to (since 25 Oct 2026). If the
    // account has moved to another address since ("Wrong address?"), the old
    // inbox no longer speaks for it: nothing changes. This is checked before
    // the password is touched (review of f4bee956b).
    const current = (await this._userService.getUserById(token.id)) as
      | User
      | null;
    if (!current) {
      return false;
    }
    const sentTo = typeof token.email === 'string' ? token.email : null;
    if (sentTo !== null && sentTo !== normaliseEmail(current.email)) {
      return false;
    }

    const updated = await this._userService.updatePassword(
      token.id,
      body.password
    );

    // The link reached the inbox it was sent to, which is what confirming an
    // email proves. A link from before 25 Oct (no address in it) only sets
    // the password. The new password already signed out every older session;
    // the rest is the same as a Google sign-in on that address
    // (existingUserForEmail).
    if (
      updated &&
      !current.activated &&
      sentTo !== null &&
      (await this._userService.activatePendingUser(updated.id))
    ) {
      await this.secureTakeover(current);
    }

    return updated;
  }

  /**
   * The owner of an address took over a password account that was never
   * confirmed (Google sign-in, or a reset link, on that address). Whoever
   * typed that password may have used the account meanwhile: its held
   * invite is dropped, it leaves every workspace it joined (whoever else is
   * in it) and its own workspaces get new API keys
   * (OrganizationService.secureTakenOverAccount). What was dropped is logged
   * and emailed to the owner, so a real invitee can ask to be invited again.
   */
  private async secureTakeover(user: { id: string; email: string }) {
    const held = await takeHeldInvite(user.id);
    const heldOrg = held
      ? await this._organizationService.getOrgById(held.orgId).catch(() => null)
      : null;
    const { left, rotated } =
      await this._organizationService.secureTakenOverAccount(user.id);

    const dropped = [
      ...left,
      ...(heldOrg ? [{ id: heldOrg.id, name: heldOrg.name }] : []),
    ];
    // The names stay here, in the server log: the owner's email only says how
    // many (workspacesRemovedEmail), since a name is whatever its maker typed.
    const named = (o: { id: string; name: string }) =>
      `${o.id} ${JSON.stringify(o.name)}`;
    this._logger.log(
      `takeover of unconfirmed account ${user.id} (${maskEmail(user.email)}): left [${left
        .map(named)
        .join(', ')}], dropped held invite to ${
        heldOrg ? named(heldOrg) : held?.orgId || 'none'
      }, new API keys for [${rotated.join(', ')}]`
    );
    if (!dropped.length) {
      return;
    }
    try {
      const notice = workspacesRemovedEmail({ count: dropped.length });
      await this._emailService.sendEmail(
        user.email,
        notice.subject,
        notice.html,
        'top'
      );
    } catch (err) {
      this._logger.error(
        `could not email ${maskEmail(user.email)} the workspaces it left`,
        err as Error
      );
    }
  }

  /**
   * Joins the invite held since sign-up (or since it was opened in the app),
   * now that the email is confirmed. The workspace to land in, or null.
   */
  private async joinHeldInvite(userId: string): Promise<string | null> {
    const invite = await takeHeldInvite(userId);
    if (!invite) {
      return null;
    }
    // A full team or a used invite: the account is confirmed all the same,
    // and the inviter can send another invite.
    const result = await this.joinInvite(userId, invite);
    if (result.outcome !== 'joined' && result.outcome !== 'member') {
      this._logger.warn(
        `held invite to ${invite.orgId} for ${userId} could not be joined: ${result.outcome}`
      );
    }
    return result.organizationId || null;
  }

  /**
   * Only an activation link. It used to take any JWT_SECRET token with an id
   * and sign its payload back as the new session; now the user is read from
   * the database and the session is that row.
   */
  async activate(code: string, tracking: string) {
    const target = activationTarget(code);
    if (!target) {
      return false;
    }
    const user = (await this._userService.getUserById(target.id)) as User | null;
    if (!user || user.activated || user.deletedAt) {
      return false;
    }
    // Sent to another address than the account has now (it was moved off a
    // mistyped one): that inbox proves nothing about this one. Every link
    // ever sent names its address, so one that does not is refused too.
    if (
      !target.email ||
      normaliseEmail(target.email) !== normaliseEmail(user.email)
    ) {
      return false;
    }
    // Only the request that flips activated from false gets a session: two
    // opens of the same link at once used to both sign in.
    if (!(await this._userService.activatePendingUser(user.id))) {
      return false;
    }
    user.activated = true;
    // The inbox the link went to is this account's: the invite it redeemed
    // at sign-up joins now.
    await this.joinHeldInvite(user.id);
    this._track('register', user.email, tracking).catch((err) => {});
    await NewsletterService.register(user.email);
    return this.jwt(user);
  }

  /**
   * The confirmation email for `user`, at most once a minute and five times a
   * day per address (ACTIVATION_SEND). Answers whether it went.
   */
  private async sendActivation(user: {
    id: string;
    email: string;
  }): Promise<Allowance> {
    const allowance = await takeAllowance(
      'activation-send',
      user.email,
      ACTIVATION_SEND
    );
    if (!allowance.allowed) {
      this._logger.log(
        `activation email to ${maskEmail(user.email)} held back: sent less than ${allowance.retryAfterSeconds}s ago or over the daily limit`
      );
      return allowance;
    }
    const activation = activationEmail({
      activationUrl: activationUrl(user),
      invitedTo: await this.heldInviteWorkspace(user.id),
    });
    await this._emailService.sendEmail(
      user.email,
      activation.subject,
      activation.html,
      'top'
    );
    return allowance;
  }

  /**
   * The name of the workspace whose invite this account holds until it
   * confirms its email ("You've been invited to ..."), or null. Read only:
   * the invite stays held.
   */
  async heldInviteWorkspace(userId: string): Promise<string | null> {
    const invite = await peekHeldInvite(userId);
    if (!invite) {
      return null;
    }
    const org = await this._organizationService
      .getOrgById(invite.orgId)
      .catch(() => null);
    return org && !org.deletedAt ? org.name || null : null;
  }

  /**
   * "Send the link again" from the signed-out activation page. The answer is
   * the same whatever the address: whether it has an account, whether that
   * account is confirmed, and whether this was throttled are not told, so the
   * page cannot be used to find out who has an account. It used to answer
   * "User not found" and "Account is already activated".
   */
  async resendActivationEmail(email: string) {
    const user = await this._userService.getUserByEmail(normaliseEmail(email));
    if (user && !user.activated) {
      await this.sendActivation(user);
    }
  }

  /** "Resend" in the banner, for the signed-in user's own address. */
  async resendForSignedInUser(userId: string): Promise<VerificationSendResult> {
    const user = (await this._userService.getUserById(userId)) as User | null;
    if (!user || user.activated) {
      return { sent: false, reason: 'already_verified' };
    }
    const allowance = await this.sendActivation(user);
    if (!allowance.allowed) {
      return {
        sent: false,
        reason: 'throttled',
        retryAfterSeconds: allowance.retryAfterSeconds,
      };
    }
    return { sent: true, email: user.email };
  }

  /**
   * "Wrong address?" in the banner: an unconfirmed password account moves to
   * another address and gets a new link there. Links sent to the old address
   * stop working (activate compares the address). An address that already
   * has an account is refused with the same sentence registration uses, so
   * this tells nobody anything the sign-up form does not; EMAIL_CHANGE limits
   * how many it can try.
   */
  async changeUnverifiedEmail(
    userId: string,
    newEmail: string
  ): Promise<VerificationSendResult> {
    const user = (await this._userService.getUserById(userId)) as User | null;
    if (!user || user.activated) {
      return { sent: false, reason: 'already_verified' };
    }
    if (user.providerName !== Provider.LOCAL) {
      throw new HttpException('Only an email sign-up can change its address here.', 400);
    }

    const email = normaliseEmail(newEmail);
    if (process.env.DISALLOW_PLUS && email.includes('+')) {
      throw new HttpException('Email with plus sign is not allowed', 400);
    }
    if (email === normaliseEmail(user.email)) {
      return this.resendForSignedInUser(user.id);
    }

    const attempt = await takeAllowance('email-change', user.id, EMAIL_CHANGE);
    if (!attempt.allowed) {
      return {
        sent: false,
        reason: 'throttled',
        retryAfterSeconds: attempt.retryAfterSeconds,
      };
    }

    const existing = await this._userService.getUserByEmailAnyProvider(email);
    if (existing && existing.id !== user.id) {
      throw new HttpException(existingAccountMessage(existing.providerName), 409);
    }

    let moved: boolean;
    try {
      moved = await this._userService.changeUnverifiedEmail(user.id, email);
    } catch (err) {
      // Someone took the address between the check and the write.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new HttpException(existingAccountMessage(Provider.LOCAL), 409);
      }
      throw err;
    }
    if (!moved) {
      return { sent: false, reason: 'already_verified' };
    }
    this._logger.log(
      `unconfirmed account ${user.id} moved from ${maskEmail(user.email)} to ${maskEmail(email)}`
    );

    const allowance = await this.sendActivation({ id: user.id, email });
    if (!allowance.allowed) {
      return {
        sent: false,
        reason: 'throttled',
        retryAfterSeconds: allowance.retryAfterSeconds,
      };
    }
    return { sent: true, email };
  }

  oauthLink(provider: string, query?: any) {
    const providerInstance = this._providerManager.getProvider(provider);
    return providerInstance.generateLink(query);
  }

  /**
   * The sign-up page's first call after a provider login. Every failure is a
   * 400 with a message the page shows next to "Continue with Google again":
   * these were plain Errors, so a 500, and the page spun forever with no
   * error and no retry. On 7 Oct a visitor's Google sign-up died that way
   * (no account was created), and a reload of /auth?code=... after a good
   * sign-up (a spent code) did the same on 18 Oct.
   */
  async checkExists(
    provider: string,
    code: string,
    redirectUri?: string,
    state?: string,
    stateCookie?: string,
    invite?: TeamInvite | false
  ): Promise<{
    jwt?: string;
    token?: string;
    invite: InviteRedemption | null;
  }> {
    let found: Awaited<ReturnType<AuthService['checkExistsOrThrow']>>;
    try {
      found = await this.checkExistsOrThrow(
        provider,
        code,
        redirectUri,
        state,
        stateCookie
      );
    } catch (err) {
      const mapped = oauthExistsFailure(provider, err);
      // Never the code: only the provider and why.
      console.warn(
        `[auth] oauth_exists_failed ${JSON.stringify({
          provider,
          reason: redactSecrets(mapped.reason).slice(0, 300),
        })}`
      );
      throw new HttpException(mapped.message, 400);
    }
    if (!found.user) {
      // A new account: the invite is redeemed by the sign-up that follows
      // (/auth/register with the provider token), so it stays in the cookie.
      return { token: found.token, invite: null };
    }
    // An existing account signed in through the provider. Before 25 Oct
    // 2026 this way in never redeemed the invite the visitor followed.
    return {
      jwt: found.jwt,
      invite: await this.redeemInvite(found.user, invite),
    };
  }

  private async checkExistsOrThrow(
    provider: string,
    code: string,
    redirectUri?: string,
    state?: string,
    stateCookie?: string
  ) {
    // the mobile app passes redirect_uri and keeps no cookies, the web flow
    // never passes it, so the state nonce is only enforced for the web flow
    if (
      !process.env.NOT_SECURED &&
      !redirectUri &&
      (!state || state !== stateCookie)
    ) {
      throw new Error('Invalid state');
    }

    const providerInstance = this._providerManager.getProvider(provider);
    const token = await providerInstance.getToken(code, redirectUri);
    const user = await providerInstance.getUser(token);
    if (!user) {
      throw new Error('Invalid user');
    }
    const checkExists = await this._userService.getUserByProvider(
      user.id,
      provider as Provider
    );
    if (checkExists) {
      return { jwt: await this.jwt(checkExists), user: checkExists as User };
    }

    // Same email, other provider: sign straight in rather than showing the
    // new-workspace form. An unverified email falls through to that form,
    // whose submit (loginOrRegisterProvider) refuses it with the reason.
    if (user.emailVerified) {
      const existing = await this.existingUserForEmail(
        provider as Provider,
        user
      );
      if (existing) {
        return { jwt: await this.jwt(existing), user: existing as User };
      }
    }

    return { token, user: undefined };
  }

  /**
   * Google One Tap: the browser posts the ID token Google gave it. An existing
   * Google user is logged in; a new one is registered in the same step with a
   * default workspace name they can rename later, because One Tap has no form
   * to collect one. Same user record as the redirect flow (providerId = sub).
   */
  async googleOneTap(
    credential: string,
    ip: string,
    userAgent: string,
    invite?: TeamInvite | false
  ) {
    const providerInstance = this._providerManager.getProvider(Provider.GOOGLE);
    const googleUser = (await providerInstance.getUser(credential)) as
      | { id: string; email: string; name?: string; emailVerified?: boolean }
      | false;
    if (!googleUser) {
      throw new Error('Invalid Google credential');
    }

    // The sign-up and sign-in pages offer One Tap, so it redeems the invite
    // those pages were opened for, like every other way in, when the visitor
    // picked the account. For Google's automatic sign-in the controller
    // passes no invite and asks about it instead (askAboutInvite).
    const existing = await this._userService.getUserByProvider(
      googleUser.id,
      Provider.GOOGLE
    );
    if (existing) {
      return {
        jwt: await this.jwt(existing),
        registered: false,
        invite: await this.redeemInvite(existing, invite),
      };
    }

    const sameEmail = await this.existingUserForEmail(
      Provider.GOOGLE,
      googleUser
    );
    if (sameEmail) {
      return {
        jwt: await this.jwt(sameEmail),
        registered: false,
        invite: await this.redeemInvite(sameEmail, invite),
      };
    }

    const name = (googleUser.name || googleUser.email.split('@')[0]).trim();
    const company = `${name}'s workspace`.slice(0, 128);
    const routed = await this.routeAuth(
      Provider.GOOGLE,
      {
        provider: Provider.GOOGLE,
        providerToken: credential,
        company: company.length >= 3 ? company : 'My workspace',
      } as CreateOrgUserDto,
      ip,
      userAgent,
      invite
    );
    return {
      jwt: routed.jwt,
      registered: !!routed.created,
      created: routed.created,
      invite: routed.invite,
    };
  }

  /**
   * A new login session for `user` (signSessionJWT: 30 days, renewed while in
   * use by AuthMiddleware, tied to the current password). The stamp needs the
   * stored password hash; every caller passes the full row, and a row read
   * without it is looked up again rather than stamped as passwordless.
   */
  private async jwt(user: User) {
    const password =
      user.password !== undefined
        ? user.password
        : (await this._userService.getUserById(user.id))?.password ?? null;
    if (user.password) {
      delete user.password;
    }
    return AuthChecker.signSessionJWT({ ...user, password });
  }
}
