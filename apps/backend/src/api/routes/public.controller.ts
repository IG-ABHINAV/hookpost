import {
  Body,
  Ip,
  Header,
  Headers,
  HttpCode,
  Logger,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PostsService } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.service';
import { TrackService } from '@hookpost/nestjs-libraries/track/track.service';
import { RealIP } from 'nestjs-real-ip';
import { UserAgent } from '@hookpost/nestjs-libraries/user/user.agent';
import { TrackEnum } from '@hookpost/nestjs-libraries/user/track.enum';
import { Request, Response } from 'express';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { getCookieUrlFromDomain } from '@hookpost/helpers/subdomain/subdomain.management';
import { AgentGraphInsertService } from '@hookpost/nestjs-libraries/agent/agent.graph.insert.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { AuthService, TOKEN_PURPOSE } from '@hookpost/helpers/auth/auth.service';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { Readable, pipeline } from 'stream';
import { promisify } from 'util';
import { OnlyURL } from '@hookpost/nestjs-libraries/dtos/webhooks/webhooks.dto';
import { isSafePublicHttpsUrl } from '@hookpost/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import { ssrfSafeDispatcher } from '@hookpost/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { SupportTicketsService } from '@hookpost/nestjs-libraries/services/support-tickets.service';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { DripUnsubscribeService } from '@hookpost/nestjs-libraries/services/drip-unsubscribe.service';
import { readDripUnsubscribeToken } from '@hookpost/nestjs-libraries/emails/drip-unsubscribe';
import { EMAIL_BRAND, escapeAttr } from '@hookpost/nestjs-libraries/emails/layout/email.layout';

/** The unsubscribe pages wear the email colours (the active brand theme). */
const C = EMAIL_BRAND.colors;
import {
  ClientEventBody,
  clientEventLine,
  createRateLimiter,
} from '@hookpost/nestjs-libraries/track/client.event';
import {
  SERVER_ATTRIBUTION_COOKIE,
  serverAttributionUpdate,
} from '@hookpost/helpers/utils/attribution';
import { cookiesSecured } from '@hookpost/backend/services/auth/session.cookies';

const pump = promisify(pipeline);

// 30 beacons a minute per address is far above what one person's browser
// sends (one per spinner, error page or abandoned connect).
const clientEventAllowed = createRateLimiter(30, 60_000);

/** The signed-in user's id from the session, or null. Only for the log line. */
function sessionUserId(req: Request): string | null {
  try {
    return AuthService.verifySessionJWT(req.cookies?.auth || req.headers?.auth).id;
  } catch {
    return null;
  }
}

function unsubscribeHeaders(res: Response) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
}

function invalidUnsubscribePage(): string {
  return unsubscribePage(
    'Link not valid',
    `<h1>This link doesn't work</h1><p>It may be incomplete. Email <a href="mailto:support@hookstep.in">support@hookstep.in</a> and we'll take you off the list by hand.</p>`
  );
}

function unsubscribePage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · Hookpost</title>
<style>body{margin:0;background:${C.page};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:${C.text}}main{max-width:480px;margin:64px auto;padding:32px 24px;background:${C.card};border:1px solid ${C.border};border-radius:12px}h1{font-size:22px;margin:0 0 12px}p{font-size:15px;line-height:24px;color:${C.body}}a{color:${C.primary}}button{font:inherit;font-weight:600;color:${C.primaryText};background:${C.primary};border:0;border-radius:8px;padding:12px 24px;cursor:pointer}footer{max-width:480px;margin:0 auto;padding:0 24px;font-size:12px;color:${C.muted};text-align:center}</style></head>
<body><main>${body}</main><footer>Hookstep · Ghatkopar, Mumbai, India</footer></body></html>`;
}

@ApiTags('Public')
@Controller('/public')
export class PublicController {
  constructor(
    private _trackService: TrackService,
    private _agentGraphInsertService: AgentGraphInsertService,
    private _postsService: PostsService,
    private _subscriptionService: SubscriptionService,
    private _supportTicketsService: SupportTicketsService,
    private _razorpayService: RazorpayService,
    private _dripUnsubscribeService: DripUnsubscribeService
  ) {}

  /**
   * Served as /api/public/email/unsubscribe?t=<signed token>: the link in the
   * footer of the marketing drip (scripts/lead-campaign). The token is an HMAC
   * of the user id, see drip-unsubscribe.ts. Transactional mail (receipts,
   * sign-in, post alerts) is never affected.
   *
   * GET changes nothing; it shows a button that POSTs back here. Corporate
   * link scanners open every link in an email, and a GET that unsubscribed
   * would quietly opt out people who never clicked.
   */
  @Get('/email/unsubscribe')
  async dripUnsubscribePage(
    @Query('t') token: string,
    @Query('undo') undo: string | undefined,
    @Res() res: Response
  ) {
    unsubscribeHeaders(res);
    if (!readDripUnsubscribeToken(token)) {
      res.status(400).send(invalidUnsubscribePage());
      return;
    }
    const action = escapeAttr(
      `/api/public/email/unsubscribe?t=${encodeURIComponent(token)}&via=page${
        undo ? '&undo=1' : ''
      }`
    );
    res.send(
      unsubscribePage(
        undo ? 'Subscribe again' : 'Unsubscribe',
        undo
          ? `<h1>Get Hookpost emails again?</h1><p>Tips, offers and setup reminders.</p><form method="post" action="${action}"><button type="submit">Subscribe again</button></form>`
          : `<h1>Unsubscribe from Hookpost emails?</h1><p>You'll stop getting Hookpost tips, offers and setup reminders. Emails about your account, like sign-in links, receipts and post alerts, still arrive.</p><form method="post" action="${action}"><button type="submit">Unsubscribe</button></form>`
      )
    );
  }

  /**
   * Records the choice. Mail clients use it for RFC 8058 one-click
   * unsubscribe (List-Unsubscribe-Post) and get JSON; the page above posts
   * with via=page and gets HTML back.
   */
  @Post('/email/unsubscribe')
  @HttpCode(200)
  async dripUnsubscribe(
    @Query('t') token: string,
    @Query('undo') undo: string | undefined,
    @Query('via') via: string | undefined,
    @Res() res: Response
  ) {
    unsubscribeHeaders(res);
    const userId = readDripUnsubscribeToken(token);
    const resubscribe = !!undo && via === 'page';
    const ok =
      !!userId &&
      (resubscribe
        ? await this._dripUnsubscribeService.resubscribe(userId)
        : await this._dripUnsubscribeService.unsubscribe(userId));
    if (via !== 'page') {
      res.status(ok ? 200 : 400).json(ok ? { ok: true } : { ok: false, error: 'invalid_token' });
      return;
    }
    if (!ok) {
      res.status(400).send(invalidUnsubscribePage());
      return;
    }
    const self = `/api/public/email/unsubscribe?t=${encodeURIComponent(token)}`;
    res.send(
      resubscribe
        ? unsubscribePage(
            'Subscribed again',
            `<h1>You're subscribed again</h1><p>You'll get Hookpost tips and offers by email again.</p><p><a href="${escapeAttr(self)}">Unsubscribe</a></p>`
          )
        : unsubscribePage(
            'Unsubscribed',
            `<h1>You're unsubscribed</h1><p>You won't get Hookpost tips, offers or setup reminders any more. Emails about your account still arrive.</p><p><a href="${escapeAttr(self + '&undo=1')}">Undo</a></p>`
          )
    );
  }

  /**
   * Served as /api/public/pricing-context. The marketing pages are cached by
   * Cloudflare for every visitor, so they render rupees and ask this, uncached,
   * what to say to this visitor. cf-ipcountry is read here on the backend;
   * the browser sends only its timezone.
   */
  @Get('/pricing-context')
  @Header('Cache-Control', 'private, no-store')
  pricingContext(@Req() req: Request, @Query('tz') tz?: string) {
    return this._razorpayService.getPricingContext({
      headers: req.headers,
      tz,
    });
  }
  @Post('/agent')
  async createAgent(@Body() body: { text: string; apiKey: string }) {
    if (
      !body.apiKey ||
      !process.env.AGENT_API_KEY ||
      body.apiKey !== process.env.AGENT_API_KEY
    ) {
      return;
    }
    return this._agentGraphInsertService.newPost(body.text);
  }

  @Get(`/posts/:id`)
  async getPreview(@Param('id') id: string) {
    return this._postsService.getPublicPreview(id);
  }

  @Get(`/posts/:id/comments`)
  async getComments(@Param('id') postId: string) {
    return { comments: await this._postsService.getComments(postId) };
  }

  @Post('/t')
  async trackEvent(
    @Res() res: Response,
    @Req() req: Request,
    @RealIP() ip: string,
    @UserAgent() userAgent: string,
    @Body()
    body: {
      fbclid?: string;
      tt: TrackEnum;
      additional: Record<string, any>;
      /** The page's first-touch cookie (hp_attr), parsed; never sent to Meta. */
      attr?: unknown;
    }
  ) {
    const uniqueId = req?.cookies?.track || makeId(10);
    const fbclid = req?.cookies?.fbclid || body.fbclid;
    // A tracking beacon must never be able to fail the request. track() ends in
    // eventRequest.execute(), a live HTTPS POST to graph.facebook.com that
    // rejects on ANY non-2xx - expired token, malformed event, rate limit, or a
    // network blip. Unguarded, that rejection propagated out of the handler and
    // Nest answered 500, which is exactly what /public/t was returning in
    // production: every ViewContent from every marketing page, failing.
    // razorpay.service.ts already wraps its identical call in try/catch; this
    // one and users.controller.ts POST /user/t did not.
    try {
      await this._trackService.track(
        uniqueId,
        ip,
        userAgent,
        body.tt,
        body.additional,
        fbclid
      );
    } catch (e) {
      Logger.error(`ViewContent tracking failed (non-fatal): ${e}`);
    }
    if (!req.cookies.track) {
      res.cookie('track', uniqueId, {
        domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
        // sameSite must sit INSIDE the secure branch: browsers reject
        // SameSite=None without Secure, so in NOT_SECURED mode the cookie was
        // silently dropped, every request minted a fresh id, and server/browser
        // event de-duplication broke. users.controller.ts already scopes it
        // correctly.
        ...(!process.env.NOT_SECURED
          ? {
              secure: true,
              httpOnly: true,
              sameSite: 'none' as const,
            }
          : {}),
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });
    }

    if (body.fbclid && !req.cookies.fbclid) {
      res.cookie('fbclid', body.fbclid, {
        domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
        // sameSite must sit INSIDE the secure branch: browsers reject
        // SameSite=None without Secure, so in NOT_SECURED mode the cookie was
        // silently dropped, every request minted a fresh id, and server/browser
        // event de-duplication broke. users.controller.ts already scopes it
        // correctly.
        ...(!process.env.NOT_SECURED
          ? {
              secure: true,
              httpOnly: true,
              sameSite: 'none' as const,
            }
          : {}),
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });
    }

    // The server's copy of the first touch (attribution.ts,
    // SERVER_ATTRIBUTION_COOKIE): Safari keeps the script-written hp_attr for
    // 7 days at most, a cookie set here for its full 90. Validated exactly as
    // hp_attr is; only an earlier or a first tagged touch replaces it. This
    // host only, never sent anywhere: recordSignup reads it at sign-up.
    const firstTouch = serverAttributionUpdate(
      req?.cookies?.[SERVER_ATTRIBUTION_COOKIE],
      body?.attr
    );
    if (firstTouch) {
      res.cookie(SERVER_ATTRIBUTION_COOKIE, firstTouch.value, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        ...(cookiesSecured() ? { secure: true } : {}),
        expires: firstTouch.expires,
      });
    }

    res.status(200).json({
      track: uniqueId,
    });
  }

  /**
   * Served as /api/public/client-event: a failure the browser saw (an endless
   * spinner, an error page, a connect that never came back) written to the
   * backend log as one "[client]" line. Not /public/t, which forwards to
   * Meta's Conversions API. Always 204, so a beacon can never fail a page.
   */
  @Post('/client-event')
  @HttpCode(204)
  clientEvent(
    @Req() req: Request,
    @RealIP() ip: string,
    @Body() body: ClientEventBody
  ) {
    if (!clientEventAllowed(ip || 'unknown')) {
      return;
    }
    const line = clientEventLine(body, sessionUserId(req));
    if (line) {
      // Plain, like the "[connect]" lines, so one grep finds both.
      console.warn(line);
    }
  }

  /**
   * A plan change signed by a billing service, for upstream's own billing.
   * It verified any JWT_SECRET token with orgId and billing, and a team invite
   * carried both (POST /settings/team signed every field of the request body),
   * so a team admin could replay one here and run the plan-change side effects
   * on a workspace: re-enable members, disable channels (22 Oct 2026). Only a
   * PLAN_CHANGE token is taken now, and nothing in Hookpost signs one
   * (Razorpay changes plans), so today it refuses every request.
   */
  @Post('/modify-subscription')
  async modifySubscription(@Body('params') params: string) {
    try {
      const load = AuthService.verifyPurposeJWT(
        TOKEN_PURPOSE.PLAN_CHANGE,
        params
      ) as {
        orgId: string;
        billing: 'FREE' | 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' | 'HOOKPOST';
      };

      if (
        typeof load.orgId !== 'string' ||
        !load.orgId ||
        typeof load.billing !== 'string' ||
        !Object.prototype.hasOwnProperty.call(pricing, load.billing)
      ) {
        return { success: false };
      }

      const totalChannels = pricing[load.billing].channel || 0;

      await this._subscriptionService.modifySubscriptionByOrg(
        load.orgId,
        totalChannels,
        load.billing
      );

      return { success: true };
    } catch (err) {
      return { success: false };
    }
  }


  @Get('/stream')
  async streamFile(
    @Query() query: OnlyURL,
    @Res() res: Response,
    @Req() req: Request
  ) {
    const { url } = query;
    if (!url.endsWith('mp4')) {
      return res.status(400).send('Invalid video URL');
    }

    const ac = new AbortController();
    const onClose = () => ac.abort();
    req.on('aborted', onClose);
    res.on('close', onClose);

    // Manually follow redirects so every hop is re-validated against
    // the SSRF blocklist (see GHSA-34w8-5j2v-h6ww). `fetch` defaults to
    // `redirect: 'follow'`, which bypasses the DTO-level URL check.
    const MAX_REDIRECTS = 5;
    let currentUrl = url;
    let r: globalThis.Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await isSafePublicHttpsUrl(currentUrl))) {
        return res.status(400).send('Blocked URL');
      }

      r = await fetch(currentUrl, {
        signal: ac.signal,
        redirect: 'manual',
        // @ts-ignore — undici option, not in lib.dom fetch types
        dispatcher: ssrfSafeDispatcher,
      });

      if (r.status >= 300 && r.status < 400) {
        const location = r.headers.get('location');
        if (!location) {
          return res.status(502).send('Redirect without Location');
        }
        try {
          currentUrl = new URL(location, currentUrl).toString();
        } catch {
          return res.status(400).send('Invalid redirect target');
        }
        continue;
      }

      break;
    }

    if (!r) {
      return res.status(502).send('No upstream response');
    }

    if (r.status >= 300 && r.status < 400) {
      return res.status(508).send('Too many redirects');
    }

    if (!r.ok && r.status !== 206) {
      res.status(r.status);
      throw new Error(`Upstream error: ${r.statusText}`);
    }

    const type = r.headers.get('content-type') ?? 'application/octet-stream';
    res.setHeader('Content-Type', type);

    const contentRange = r.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    const len = r.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);

    const acceptRanges = r.headers.get('accept-ranges') ?? 'bytes';
    res.setHeader('Accept-Ranges', acceptRanges);

    if (r.status === 206) res.status(206); // Partial Content for range responses

    try {
      await pump(Readable.fromWeb(r.body as any), res);
    } catch (err) {}
  }

  // ---------------------------------------------------------------------------
  // Contact form
  // ---------------------------------------------------------------------------

  // A public endpoint that sends mail is a spam vector, so this is deliberately
  // narrow: a honeypot field bots fill and humans never see, one submission per
  // IP per minute, and hard length caps.
  //
  // The submission is written to the database BEFORE the email is attempted.
  // The email is a notification, not the record - previously a Resend outage or
  // a spam folder lost the request entirely, with nothing left to recover from.
  @Post('/contact')
  async contact(
    @Ip() directIp: string,
    @Headers() headers: Record<string, string>,
    @Body()
    body: {
      name?: string;
      email?: string;
      topic?: string;
      message?: string;
      website?: string;
    }
  ) {
    // Honeypot. A real form hides this field; a bot fills every input it finds.
    // Returns success so the bot has nothing to learn from the response.
    if (body?.website) {
      return { ok: true };
    }

    // @Ip() is 127.0.0.1 for every request here - NGINX proxies to the backend
    // and Express has no trust-proxy setting, so without this the per-IP limit
    // below would be one submission per minute for the entire internet.
    // Cloudflare sits in front of NGINX, so its header is the truthful one.
    const ip =
      headers['cf-connecting-ip'] ||
      (headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      directIp;

    const name = (body?.name || '').trim().slice(0, 100);
    const email = (body?.email || '').trim().slice(0, 200);
    const topic = (body?.topic || 'Support').trim().slice(0, 60);
    const message = (body?.message || '').trim().slice(0, 5000);

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false, error: 'Enter an email address we can reply to.' };
    }
    if (message.length < 10) {
      return { ok: false, error: 'Tell us a little more so we can help.' };
    }

    // Stored as a support ticket (the row is the record), then the internal
    // copy to support@ and the customer's auto-reply, both best effort. A
    // double submit inside 60s returns the first ticket's ref.
    return this._supportTicketsService.submit({
      name,
      email,
      topic,
      message,
      ip: ip || null,
      userAgent: (headers['user-agent'] || '').slice(0, 500) || null,
    });
  }
}
