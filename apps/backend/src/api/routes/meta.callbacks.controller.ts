import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createHmac, timingSafeEqual } from 'crypto';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.service';

// The three Meta apps we own each sign their callbacks with their own secret,
// and the payload does not say which app sent it, so every configured secret
// gets a try. FACEBOOK_APP_SECRET covers both the facebook and instagram
// providers, which share one app.
const APP_SECRET_VARS = [
  'FACEBOOK_APP_SECRET',
  'THREADS_APP_SECRET',
  'INSTAGRAM_APP_SECRET',
];

// Providers whose channels are keyed by a Meta app-scoped user id. One
// Facebook login can connect several Pages (or Instagram accounts); the
// callback names the login, and IntegrationService.getChannelsConnectedByAccount
// finds every channel that login connected.
const META_PROVIDERS = [
  'facebook',
  'instagram',
  'instagram-standalone',
  'threads',
];

/**
 * Deauthorize and data-deletion callbacks for our Meta apps.
 *
 * Meta requires both URLs on every app that requests Platform Data, and App
 * Review checks them: the deletion endpoint must answer with a confirmation
 * code and a status URL, not an HTML page. Both are unauthenticated by design -
 * the caller is Meta, and the signed_request HMAC is the only credential.
 */
@ApiTags('Meta')
@Controller('/meta')
export class MetaCallbacksController {
  private readonly logger = new Logger(MetaCallbacksController.name);

  constructor(
    private _integrationService: IntegrationService,
    private _postService: PostsService
  ) {}

  @Post('/deauthorize')
  @HttpCode(200)
  async deauthorize(@Body('signed_request') signedRequest: string) {
    const userId = this.parseSignedRequest(signedRequest);
    if (!userId) {
      // Meta retries on 5xx, so an unverifiable payload gets a flat 200 to stop
      // it looping on something we will never accept.
      return { ok: true };
    }

    const channels = await this._integrationService.getChannelsConnectedByAccount(
      META_PROVIDERS,
      userId
    );
    for (const { id, organizationId } of channels) {
      await this._integrationService.refreshNeeded(organizationId, id);
    }

    this.logger.log(`Meta deauthorize: flagged ${channels.length} channel(s)`);
    return { ok: true };
  }

  @Post('/data-deletion')
  @HttpCode(200)
  async dataDeletion(@Body('signed_request') signedRequest: string) {
    const confirmationCode = makeId(20);
    const userId = this.parseSignedRequest(signedRequest);

    if (userId) {
      // Every channel this Meta login connected, every Page of a multi-Page
      // selection included. Same removal as the Delete channel button
      // (pending posts go, tokens are wiped, the refresh workflow stops), and
      // then the profile Meta gave us (name, username, picture link, ids) is
      // overwritten too. Removed channels are skipped, so a repeated callback
      // from Meta is a no-op.
      const channels =
        await this._integrationService.getChannelsConnectedByAccount(
          META_PROVIDERS,
          userId
        );
      for (const { id, organizationId } of channels) {
        const posts = await this._integrationService.getPostsForChannel(
          organizationId,
          id
        );
        for (const post of posts) {
          this._postService
            .deletePost(organizationId, post.group)
            .catch((err) => {});
        }
        await this._integrationService.deleteChannel(organizationId, id);
        await this._integrationService.eraseRemovedChannelProfile(
          organizationId,
          id
        );
      }
      this.logger.log(
        `Meta data deletion ${confirmationCode}: removed ${channels.length} channel(s)`
      );
    }

    // Shape is fixed by Meta: a status URL the person can open, plus a code
    // they can quote. Anything else fails App Review.
    return {
      url: `${process.env.FRONTEND_URL}/data-deletion?code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    };
  }

  /**
   * Verifies a Meta signed_request and returns the app-scoped user id, or
   * undefined when no configured secret produces a matching signature.
   */
  private parseSignedRequest(signedRequest?: string): string | undefined {
    if (!signedRequest || signedRequest.indexOf('.') === -1) {
      return undefined;
    }

    const [encodedSignature, payload] = signedRequest.split('.', 2);
    let signature: Buffer;
    try {
      signature = Buffer.from(encodedSignature, 'base64url');
    } catch (e) {
      return undefined;
    }

    const matches = APP_SECRET_VARS.map((name) => process.env[name])
      .filter((secret): secret is string => !!secret)
      .some((secret) => {
        const expected = createHmac('sha256', secret)
          .update(payload)
          .digest();
        return (
          expected.length === signature.length &&
          timingSafeEqual(expected, signature)
        );
      });

    if (!matches) {
      this.logger.warn('Rejected Meta callback: signature did not verify');
      return undefined;
    }

    try {
      const data = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf-8')
      );
      return data?.user_id;
    } catch (e) {
      return undefined;
    }
  }
}
