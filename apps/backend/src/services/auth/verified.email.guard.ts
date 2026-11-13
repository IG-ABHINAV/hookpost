import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { EmailNotVerifiedException } from '@hookpost/nestjs-libraries/services/email.verification';

/**
 * Refuses the route (403 EMAIL_NOT_VERIFIED) unless the signed-in user has
 * confirmed their email. For what reaches beyond the user's own workspace or
 * outlives their session, so it must wait until we know the address is
 * theirs: an invite email to someone else, a webhook to another server,
 * approving an OAuth app. Publishing is refused in PostsService instead,
 * which every way of posting goes through.
 *
 * Since 25 Oct 2026 an unconfirmed password sign-up has a session
 * (AuthMiddleware lets it in); before, it had none, so nothing needed this.
 *
 *   @UseGuards(new VerifiedEmailGuard('invite people to your workspace'))
 */
@Injectable()
export class VerifiedEmailGuard implements CanActivate {
  constructor(private readonly action: string = 'do this') {}

  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest()?.user;
    if (user?.activated === true) {
      return true;
    }
    throw new EmailNotVerifiedException(
      `Confirm your email address to ${this.action}. Open the link we emailed you, or send a new one from the banner at the top of Hookpost.`
    );
  }
}
