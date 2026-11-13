import { Body, Controller, Get, HttpException, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { Request } from 'express';
import { impersonationTarget } from '@hookpost/backend/services/auth/session.cookies';
import { GetUserFromRequest } from '@hookpost/nestjs-libraries/user/user.from.request';
import { AuthService } from '@hookpost/backend/services/auth/auth.service';
import { ChangeUnverifiedEmailDto } from '@hookpost/nestjs-libraries/dtos/auth/change-unverified-email.dto';
import {
  authRateLimits,
  clientIp,
} from '@hookpost/backend/services/auth/auth.rate.limit';

/**
 * The "Confirm your email to publish" banner, for a signed-in user whose
 * password sign-up has not confirmed its address yet. Signed in, so it only
 * ever acts on the user's own account and can say what happened; the
 * signed-out POST /auth/resend-activation answers the same for everyone.
 */
@ApiTags('Email verification')
@Controller('/verify-email')
export class EmailVerificationController {
  constructor(private _authService: AuthService) {}

  /**
   * Read again by the banner, so it goes away once the link is used
   * elsewhere. `invitedTo`: the workspace whose invite waits for this
   * confirmation ("You've been invited to ..."), or null.
   */
  @Get('/')
  async status(@GetUserFromRequest() user: User) {
    const verified = user.activated === true;
    return {
      verified,
      email: user.email,
      invitedTo: verified
        ? null
        : await this._authService.heldInviteWorkspace(user.id),
    };
  }

  @Post('/resend')
  resend(@Req() req: Request, @GetUserFromRequest() user: User) {
    // Per IP, on top of the per-address limit inside sendActivation
    // (auth.rate.limit.ts): 429 with a sentence the banner shows.
    authRateLimits.resend(clientIp(req));
    return this._authService.resendForSignedInUser(user.id);
  }

  /** "Wrong address?": move the unconfirmed account and send the link there. */
  @Post('/change')
  change(
    @Req() req: Request,
    @GetUserFromRequest() user: User,
    @Body() body: ChangeUnverifiedEmailDto
  ) {
    // An admin looking at someone's workspace must not move their sign-in
    // address by accident; the admin tools have their own way to do it.
    if (impersonationTarget(req)) {
      throw new HttpException('Stop impersonating to change this address.', 400);
    }
    return this._authService.changeUnverifiedEmail(user.id, body.email);
  }
}
