import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Response, Request } from 'express';

import { CreateOrgUserDto } from '@hookpost/nestjs-libraries/dtos/auth/create.org.user.dto';
import { LoginUserDto } from '@hookpost/nestjs-libraries/dtos/auth/login.user.dto';
import { AuthService } from '@hookpost/backend/services/auth/auth.service';
import { ForgotReturnPasswordDto } from '@hookpost/nestjs-libraries/dtos/auth/forgot-return.password.dto';
import { ForgotPasswordDto } from '@hookpost/nestjs-libraries/dtos/auth/forgot.password.dto';
import { ResendActivationDto } from '@hookpost/nestjs-libraries/dtos/auth/resend-activation.dto';
import { ApiTags } from '@nestjs/swagger';
import {
  askAboutInvite,
  sessionCookie,
  settleInvite,
  startSession,
} from '@hookpost/backend/services/auth/session.cookies';
import { INVITE_COOKIE } from '@hookpost/helpers/auth/team.invite';
import { EmailService } from '@hookpost/nestjs-libraries/services/email.service';
import { RealIP } from 'nestjs-real-ip';
import { UserAgent } from '@hookpost/nestjs-libraries/user/user.agent';
import { Provider } from '@prisma/client';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import * as Sentry from '@sentry/nestjs';
import {
  SignupAttributionService,
  SignupContext,
} from '@hookpost/nestjs-libraries/database/prisma/attribution/signup-attribution.service';
import { trustedCountry } from '@hookpost/nestjs-libraries/services/billing.currency';
import { User } from '@prisma/client';
import {
  authRateLimits,
  clientIp,
  TooManyAttemptsError,
} from '@hookpost/backend/services/auth/auth.rate.limit';
import { INVALID_CREDENTIALS } from '@hookpost/backend/services/auth/auth.service';

/** A refused attempt: 429, Retry-After, and the sentence the form shows. */
const tooMany = (response: Response, e: TooManyAttemptsError) => {
  response.header('Retry-After', String(e.retryAfterSeconds));
  return response.status(429).send(e.message);
};

/**
 * Everything a new account's attribution reads from the sign-up request: the
 * hp_attr, hp_attr_s, _fbc and _fbp cookies, the address and browser,
 * Cloudflare's country, and the page it was made on.
 */
const signupContext = (
  req: Request,
  created: { organizationId: string; user: User },
  method: string,
  ip: string,
  userAgent: string
): SignupContext => ({
  organizationId: created.organizationId,
  user: created.user,
  method,
  cookies: req?.cookies || {},
  ip,
  userAgent,
  country: trustedCountry(req?.headers as any),
  sourceUrl:
    typeof req?.headers?.referer === 'string' ? req.headers.referer : undefined,
});

/**
 * How a Google One Tap account was picked (CredentialResponse.select_by)
 * when the visitor did it: a tap or a click on One Tap, the button, or the
 * ITP and FedCM prompts. "auto" and "fedcm_auto" are Google signing a
 * returning account in by itself; anything else, or nothing, counts as
 * that too.
 */
const ONE_TAP_USER_CHOICES = new Set([
  'user',
  'user_1tap',
  'user_2tap',
  'fedcm',
  'btn',
  'btn_confirm',
  'btn_add_session',
  'btn_confirm_add_session',
  'itp',
  'itp_confirm',
  'itp_add_session',
  'itp_confirm_add_session',
]);
export const oneTapChosenByUser = (selectBy: unknown) =>
  typeof selectBy === 'string' && ONE_TAP_USER_CHOICES.has(selectBy);

@ApiTags('Auth')
@Controller('/auth')
export class AuthController {
  constructor(
    private _authService: AuthService,
    private _emailService: EmailService,
    private _attribution: SignupAttributionService
  ) {}

  @Get('/can-register')
  async canRegister() {
    return {
      register: await this._authService.canRegister(Provider.LOCAL as string),
    };
  }

  @Post('/register')
  async register(
    @Req() req: Request,
    @Body() body: CreateOrgUserDto,
    @Res({ passthrough: false }) response: Response,
    @RealIP() ip: string,
    @UserAgent() userAgent: string
  ) {
    // Password sign-ups only (auth.rate.limit.ts): a Google or other provider
    // sign-up is never refused here.
    if (body.provider === Provider.LOCAL) {
      try {
        authRateLimits.register(body.email, clientIp(req));
      } catch (e) {
        if (e instanceof TooManyAttemptsError) return tooMany(response, e);
        throw e;
      }
    }
    try {
      const { jwt, created, invite } = await this._authService.routeAuth(
        body.provider,
        body,
        ip,
        userAgent,
        this._authService.getOrgFromCookie(req?.cookies?.[INVITE_COOKIE])
      );

      // Every sign-up method that has a form or a provider button ends here
      // (One Tap has its own route below). Where the account came from, and
      // Meta's CompleteRegistration with the id the browser pixel reuses.
      const eventId = created
        ? await this._attribution.recordSignup(
            signupContext(req, created, String(body.provider), ip, userAgent)
          )
        : undefined;

      // A password sign-up with an email provider still has to confirm its
      // address, but no longer before it may sign in: it goes to onboarding
      // like every other sign-up, and only publishing waits for the link
      // (PostsService). Until 25 Oct 2026 it got no session here, only a
      // "check your email" page, and none of the five password sign-ups of
      // 19-25 Oct ever opened the link.
      const verifyEmail =
        body.provider === 'LOCAL' && this._emailService.hasProvider();

      startSession(response, jwt);
      settleInvite(req, response, invite);

      Sentry.metrics.count('new_user', 1);
      response.header('onboarding', 'true');
      response.status(200).json({
        register: true,
        ...(verifyEmail ? { verifyEmail: true } : {}),
        ...(eventId ? { eventId } : {}),
      });
    } catch (e: any) {
      response.status(400).send(e.message);
    }
  }

  @Post('/login')
  async login(
    @Req() req: Request,
    @Body() body: LoginUserDto,
    @Res({ passthrough: false }) response: Response,
    @RealIP() ip: string,
    @UserAgent() userAgent: string
  ) {
    // Email and password only: wallet and Farcaster sign-ins also come
    // through here and are never counted (auth.rate.limit.ts).
    const password = body.provider === Provider.LOCAL;
    const from = clientIp(req);
    let release = () => undefined as void;
    if (password) {
      try {
        release = authRateLimits.beforeLogin(body.email, from);
      } catch (e) {
        if (e instanceof TooManyAttemptsError) return tooMany(response, e);
        throw e;
      }
    }
    try {
      // The invite the sign-in page was opened for is redeemed here too
      // (AuthService.routeAuth): an existing account used to sign in and
      // join nothing.
      let routed: Awaited<ReturnType<AuthService['routeAuth']>>;
      try {
        routed = await this._authService.routeAuth(
          body.provider,
          body,
          ip,
          userAgent,
          this._authService.getOrgFromCookie(req?.cookies?.[INVITE_COOKIE])
        );
      } catch (e: any) {
        // A wrong address or password only: a database hiccup is not a guess.
        if (password && e?.message === INVALID_CREDENTIALS) {
          authRateLimits.loginFailed(body.email, from);
        }
        throw e;
      } finally {
        release();
      }
      if (password) authRateLimits.loginSucceeded(body.email, from);
      const { jwt, created, invite } = routed;

      // A provider login (wallet, Farcaster) can create the account too.
      if (created) {
        await this._attribution.recordSignup(
          signupContext(req, created, String(body.provider), ip, userAgent)
        );
      }

      startSession(response, jwt);
      settleInvite(req, response, invite);

      response.header('reload', 'true');
      response.status(200).json({
        login: true,
      });
    } catch (e: any) {
      response.status(400).send(e.message);
    }
  }

  @Post('/forgot')
  async forgot(@Req() req: Request, @Body() body: ForgotPasswordDto) {
    // Outside the try below: a 429 must reach the page, not read as "sent".
    authRateLimits.forgot(body.email, clientIp(req));
    try {
      await this._authService.forgot(body.email);
      return {
        forgot: true,
      };
    } catch (e) {
      return {
        forgot: false,
      };
    }
  }

  @Post('/forgot-return')
  async forgotReturn(@Body() body: ForgotReturnPasswordDto) {
    const reset = await this._authService.forgotReturn(body);
    // The sign-in lock's message says to reset the password: once that is
    // done, the address may sign in again straight away.
    if (reset && typeof reset === 'object' && 'email' in reset) {
      authRateLimits.passwordReset(reset.email);
    }
    return {
      reset: !!reset,
    };
  }

  @Get('/oauth-mobile-callback')
  mobileCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res({ passthrough: false }) response: Response
  ) {
    const scheme = process.env.MOBILE_APP_SCHEME || 'hookpost://auth/callback';
    const params = new URLSearchParams();
    if (code) params.set('code', code);
    if (state) params.set('state', state);
    return response.redirect(302, `${scheme}?${params.toString()}`);
  }

  @Get('/oauth/:provider')
  async oauthLink(
    @Param('provider') provider: string,
    @Query() query: any,
    @Res({ passthrough: true }) response: Response
  ) {
    const state = `login-${makeId(16)}`;
    response.cookie(
      'oauth_state',
      state,
      sessionCookie({ expires: new Date(Date.now() + 1000 * 60 * 10) })
    );

    return this._authService.oauthLink(provider, { ...query, state });
  }

  @Post('/activate')
  async activate(
    @Req() req: Request,
    @Body('code') code: string,
    @Body('datafast_visitor_id') datafast_visitor_id: string,
    @Res({ passthrough: false }) response: Response
  ) {
    // The link signs in whoever opens it. A cross-site form post could make a
    // visitor's browser open the attacker's own link and work in the
    // attacker's account; such a post cannot send JSON (same guard as
    // oauthExists). The activation page always sends JSON.
    if (!req.headers['content-type']?.includes('application/json')) {
      return response.status(400).json({ can: false });
    }
    const activate = await this._authService.activate(
      code,
      datafast_visitor_id
    );
    if (!activate) {
      return response.status(200).json({ can: false });
    }

    startSession(response, activate);

    response.header('onboarding', 'true');

    return response.status(200).json({ can: true });
  }

  /**
   * Signed out: one answer for every address (AuthService.resendActivationEmail
   * says why). A signed-in user resends from the banner instead
   * (POST /verify-email/resend), which can say more about its own address.
   */
  @Post('/resend-activation')
  async resendActivation(
    @Req() req: Request,
    @Body() body: ResendActivationDto
  ) {
    // Per IP here; per address AuthService.sendActivation already holds it
    // to 1 a minute and 5 a day, with the same answer for every address.
    authRateLimits.resend(clientIp(req));
    try {
      await this._authService.resendActivationEmail(body.email);
    } catch (e) {
      // Only a real unconfirmed account gets this far, so a failure must not
      // answer differently either.
      console.error('[auth] resend-activation failed', (e as Error)?.message);
    }
    return { success: true };
  }

  /**
   * What the sign-up and sign-in pages say about the invite they were opened
   * for (InviteNotice): the team's name while the invite can be redeemed,
   * else only that it cannot. The frontend reads the httpOnly invite cookie
   * on its server and posts the token here.
   */
  @Post('/invite/preview')
  async invitePreview(
    @Req() req: Request,
    @Body('token') token: unknown,
    @Res({ passthrough: false }) response: Response
  ) {
    if (!req.headers['content-type']?.includes('application/json')) {
      return response.status(400).json({ valid: false });
    }
    return response
      .status(200)
      .json(await this._authService.previewInvite(token));
  }

  @Get('/oauth/:provider/redirect')
  oauthRedirectGet(
    @Param('provider') provider: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Res({ passthrough: false }) response: Response
  ) {
    if (!code) {
      return response.redirect(303, `${process.env.FRONTEND_URL}/auth/login`);
    }

    let url = `${process.env.FRONTEND_URL}/auth?code=${code}&provider=${provider.toUpperCase()}`;
    if (state) url += `&state=${state}`;
    return response.redirect(303, url);
  }

  @Post('/oauth/:provider/redirect')
  oauthRedirect(
    @Param('provider') provider: string,
    @Body('code') code: string,
    @Body('state') state: string,
    @Res({ passthrough: false }) response: Response
  ) {
    if (!code) {
      return response.redirect(303, `${process.env.FRONTEND_URL}/auth/login`);
    }

    let url = `${process.env.FRONTEND_URL}/auth?code=${code}&provider=${provider.toUpperCase()}`;
    if (state) url += `&state=${state}`;
    return response.redirect(303, url);
  }

  /**
   * `select_by` is Google's own word for how the account was picked
   * (CredentialResponse.select_by), passed on by the page. Only a sign-in
   * the visitor chose redeems the invite the page was opened for; an
   * automatic one ("auto", "fedcm_auto", or no answer at all) turns it into
   * the Join question (askAboutInvite) and the page goes to /invite.
   */
  @Post('/oauth/google/one-tap')
  async googleOneTap(
    @Req() req: Request,
    @Body('credential') credential: string,
    @Body('select_by') selectBy: unknown,
    @Res({ passthrough: false }) response: Response,
    @RealIP() ip: string,
    @UserAgent() userAgent: string
  ) {
    // Same CSRF guard as oauthExists: a cross-site form post cannot send JSON.
    if (
      !req.headers['content-type']?.includes('application/json') ||
      !credential
    ) {
      return response.status(400).send('Invalid request');
    }

    const chosen = oneTapChosenByUser(selectBy);
    const invite = this._authService.getOrgFromCookie(
      req?.cookies?.[INVITE_COOKIE]
    );
    let result: Awaited<ReturnType<AuthService['googleOneTap']>>;
    try {
      result = await this._authService.googleOneTap(
        credential,
        ip,
        userAgent,
        chosen ? invite : undefined
      );
    } catch (e) {
      // Don't echo library internals (e.g. google-auth-library's PEM errors).
      return response
        .status(401)
        .json({ login: false, message: 'Google sign-in could not be verified' });
    }

    const eventId = result.created
      ? await this._attribution.recordSignup(
          signupContext(req, result.created, 'GOOGLE_ONE_TAP', ip, userAgent)
        )
      : undefined;

    startSession(response, result.jwt);
    // Signed in by itself: an open invite is asked about, not redeemed; one
    // that cannot be used is settled as before ("invalid").
    const ask = !chosen && !!invite && askAboutInvite(req, response);
    if (!ask) {
      settleInvite(req, response, result.invite);
    }
    response.status(200).json({
      login: true,
      registered: result.registered,
      ...(ask ? { invite: 'ask' } : {}),
      ...(eventId ? { eventId } : {}),
    });
  }

  @Post('/oauth/:provider/exists')
  async oauthExists(
    @Req() req: Request,
    @Body('code') code: string,
    @Body('redirect_uri') redirect_uri: string,
    @Body('state') state: string,
    @Param('provider') provider: string,
    @Res({ passthrough: false }) response: Response
  ) {
    // a cross-site form post can spoof any body field, a json body cannot
    if (!req.headers['content-type']?.includes('application/json')) {
      return response.status(400).send('Invalid request');
    }

    const { jwt, token, invite } = await this._authService.checkExists(
      provider,
      code,
      redirect_uri,
      state,
      req?.cookies?.oauth_state,
      this._authService.getOrgFromCookie(req?.cookies?.[INVITE_COOKIE])
    );

    if (token) {
      // A new account: its sign-up (/register) redeems the invite cookie.
      return response.json({ token });
    }

    // The native mobile sign-in passes its own redirect_uri and keeps no
    // cookies, so it is the one client that still gets the token in a header.
    startSession(response, jwt!, { forClient: !!redirect_uri });
    settleInvite(req, response, invite);

    response.header('reload', 'true');

    response.status(200).json({
      login: true,
    });
  }
}
