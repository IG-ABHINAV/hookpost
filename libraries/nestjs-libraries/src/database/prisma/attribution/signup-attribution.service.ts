import { Injectable, Logger } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import {
  PrismaRepository,
  PrismaService,
} from '@hookpost/nestjs-libraries/database/prisma/prisma.service';
import { TrackService } from '@hookpost/nestjs-libraries/track/track.service';
import { TrackEnum } from '@hookpost/nestjs-libraries/user/track.enum';
import {
  ATTRIBUTION_COOKIE,
  Attribution,
  SERVER_ATTRIBUTION_COOKIE,
  deviceClass,
  firstTouch,
  inAppBrowser,
  isTokenPath,
  readAttributionCookie,
} from '@hookpost/helpers/utils/attribution';

/**
 * The event id of a new account's CompleteRegistration. The backend sends the
 * event to Meta's Conversions API with it and returns it to the browser,
 * which fires the pixel's CompleteRegistration with the same eventID, so
 * Meta counts the pair once.
 */
export const registrationEventId = (userId: string) => `reg_${userId}`;

/** How the account was created, as stored and reported. */
export type SignupMethod =
  | 'LOCAL'
  | 'GOOGLE'
  | 'GOOGLE_ONE_TAP'
  | 'GITHUB'
  | 'APPLE'
  | 'FARCASTER'
  | 'WALLET'
  | 'GENERIC'
  | string;

export interface SignupContext {
  organizationId: string;
  user: User;
  method: SignupMethod;
  /** The request's parsed cookies (hp_attr, hp_attr_s, _fbc, _fbp). */
  cookies?: Record<string, string | undefined>;
  ip?: string;
  userAgent?: string;
  /** Cloudflare's CF-IPCountry, already validated. */
  country?: string | null;
  /** The page the sign-up happened on (Referer of the API call). */
  sourceUrl?: string;
}

export interface AttributionRow {
  campaign: string;
  source: string;
  medium: string;
  signups: number;
  /** Connected at least one channel (connect-first funnel). */
  channels: number;
  /** ... within FIRST_CHANNEL_WINDOW_MINUTES of signing up. */
  channelsFast: number;
  trials: number;
  paid: number;
  mobile: number;
  inApp: number;
}

/**
 * The connect-first target (25 Oct 2026): a new sign-up connects its first
 * channel within this many minutes of creating the workspace.
 */
export const FIRST_CHANNEL_WINDOW_MINUTES = 10;

export interface AttributionReport {
  from: string;
  to: string;
  totals: Omit<AttributionRow, 'campaign' | 'source' | 'medium'> & {
    mobileShare: number;
  };
  rows: AttributionRow[];
}

// Meta's own cookie formats; anything else is not forwarded. An fbclid
// becomes an fbc only when it fits FBC's click-id part.
const FBC = /^fb\.\d\.\d{10,13}\.[\w-]{10,500}$/;
const FBP = /^fb\.\d\.\d{10,13}\.\d{5,20}$/;
const FBCLID = /^[\w-]{10,500}$/;

/**
 * The fbclid of a sign-up. /public/t stores an fbclid posted to it whole, in
 * its own `fbclid` cookie, so that copy wins over hp_attr's when it is the
 * same click (equal, or hp_attr's is a shortened copy of it) or hp_attr has
 * none; a different click in hp_attr is the first touch and stays.
 */
export const signupFbclid = (cookie: string | undefined, firstTouch: string | undefined) => {
  const full = cookie && FBCLID.test(cookie) ? cookie : undefined;
  if (full && (!firstTouch || full.startsWith(firstTouch))) return full;
  return firstTouch;
};

const sameSiteUrl = (url?: string) => {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const front = new URL(process.env.FRONTEND_URL || 'http://localhost');
    // Only our own pages, and never their query strings (tokens, emails) or
    // a path that is itself a token (a reset or activation link).
    return u.host === front.host && !isTokenPath(u.pathname)
      ? `${u.origin}${u.pathname}`
      : undefined;
  } catch {
    return undefined;
  }
};

@Injectable()
export class SignupAttributionService {
  private readonly logger = new Logger(SignupAttributionService.name);
  private warned = false;

  constructor(
    private _attribution: PrismaRepository<'signupAttribution'>,
    private _prisma: PrismaService,
    private _track: TrackService
  ) {}

  private unavailable(err: unknown) {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(
      `SignupAttribution is unavailable (apply signup-attribution.migration.sql): ${
        (err as Error)?.message || err
      }`
    );
  }

  /**
   * A new account: stores where it came from and reports CompleteRegistration
   * to Meta's Conversions API, with the click id (fbc), the browser id (fbp)
   * and the event id the browser pixel uses. Never throws and never waits for
   * Meta: a sign-up must not fail or stall because of either. Returns the
   * event id for the browser.
   */
  async recordSignup(ctx: SignupContext): Promise<string> {
    const eventId = registrationEventId(ctx.user.id);
    const cookies = ctx.cookies || {};
    // hp_attr, or the backend's copy of it (hp_attr_s) where Safari has
    // already dropped hp_attr or a later visit has written a newer one.
    const attr: Attribution =
      firstTouch(
        readAttributionCookie(cookies[ATTRIBUTION_COOKIE]),
        readAttributionCookie(cookies[SERVER_ATTRIBUTION_COOKIE])
      ) || {};
    const fbcCookie = cookies._fbc && FBC.test(cookies._fbc) ? cookies._fbc : undefined;
    const fbp = cookies._fbp && FBP.test(cookies._fbp) ? cookies._fbp : undefined;
    const fbclid = signupFbclid(cookies.fbclid, attr.fbclid);
    // The pixel's own _fbc when it saw the click; else one built from the
    // whole fbclid, dated when the landing page recorded that click.
    const fbclidSeenAt =
      fbclid && attr.fbclid && fbclid.startsWith(attr.fbclid) ? attr.first_seen_at : undefined;
    const fbc = fbcCookie
      ? fbcCookie
      : fbclid && FBCLID.test(fbclid)
      ? `fb.1.${fbclidSeenAt || Date.now()}.${fbclid}`
      : undefined;
    const ua = ctx.userAgent || '';

    try {
      await this._attribution.model.signupAttribution.create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.user.id,
          method: String(ctx.method).slice(0, 32),
          utmSource: attr.utm_source,
          utmMedium: attr.utm_medium,
          utmCampaign: attr.utm_campaign,
          utmContent: attr.utm_content,
          utmTerm: attr.utm_term,
          gclid: attr.gclid,
          fbclid,
          ttclid: attr.ttclid,
          msclkid: attr.msclkid,
          fbc,
          fbp,
          landingPath: attr.landing_path,
          referrer: attr.referrer,
          firstSeenAt: attr.first_seen_at ? new Date(attr.first_seen_at) : null,
          device: deviceClass(ua),
          inApp: inAppBrowser(ua),
          country: ctx.country || null,
          eventId,
        },
      });
    } catch (err) {
      // P2002: already recorded (a retried request). Anything else, most
      // likely the table not being there yet, is logged once and skipped.
      if ((err as { code?: string })?.code !== 'P2002') this.unavailable(err);
    }

    this.reportRegistration(eventId, ctx, fbc, fbp, attr).catch(
      (err) =>
        this.logger.error(`CompleteRegistration to Meta failed (non-fatal): ${err}`)
    );
    return eventId;
  }

  private async reportRegistration(
    eventId: string,
    ctx: SignupContext,
    fbc: string | undefined,
    fbp: string | undefined,
    attr: Attribution
  ) {
    await this._track.track(
      eventId,
      ctx.ip || '',
      ctx.userAgent || '',
      TrackEnum.CompleteRegistration,
      {},
      fbc,
      ctx.user,
      {
        fbp,
        sourceUrl: sameSiteUrl(ctx.sourceUrl),
        fbclidSeenAt: attr.first_seen_at,
      }
    );
  }

  /** The workspace started its trial (Razorpay checkout or webhook). */
  async markTrialStarted(organizationId: string, at = new Date()) {
    try {
      await this._attribution.model.signupAttribution.updateMany({
        where: { organizationId, trialStartedAt: null },
        data: { trialStartedAt: at },
      });
    } catch (err) {
      this.unavailable(err);
    }
  }

  /** The workspace's first real charge (subscription.charged). */
  async markPaid(organizationId: string, at = new Date()) {
    try {
      await this._attribution.model.signupAttribution.updateMany({
        where: { organizationId, paidAt: null },
        data: { paidAt: at },
      });
    } catch (err) {
      this.unavailable(err);
    }
  }

  /**
   * Sign-ups, first channels, trials and paying workspaces per campaign,
   * for workspaces created in [from, to). Read-only.
   *
   * `channels` is a workspace that connected at least one channel, and
   * `channelsFast` one that did so within FIRST_CHANNEL_WINDOW_MINUTES of
   * creating the workspace (the connect-first target): SignupAttribution's
   * firstChannelAt, or for a workspace without one its earliest channel row
   * that is not an unfinished two-step placeholder (removed ones included).
   *
   * Every workspace created in the window counts, recorded or not: one with
   * no SignupAttribution row (before it existed, or the table missing) is
   * "(none)". Trials and paid also read the subscription state, so they are
   * right for workspaces created before the timestamps existed: a trial is a
   * workspace that used its trial or has a subscription; paid is one whose
   * first charge was recorded, or that is subscribed, past its trial and not
   * on a free lifetime plan. Phone and in-app counts read the user agent the
   * owner signed up with (User.agent), so they cover old sign-ups too.
   */
  async report(from: Date, to: Date): Promise<AttributionReport> {
    const rows = await this._prisma.$queryRaw<
      Array<{
        campaign: string;
        source: string;
        medium: string;
        signups: bigint;
        channels: bigint;
        channels_fast: bigint;
        trials: bigint;
        paid: bigint;
        mobile: bigint;
        in_app: bigint;
      }>
    >(Prisma.sql`
      WITH owner AS (
        SELECT DISTINCT ON (uo."organizationId") uo."organizationId", u.agent
        FROM "UserOrganization" uo JOIN "User" u ON u.id = uo."userId"
        ORDER BY uo."organizationId", uo."createdAt"
      ),
      first_channel AS (
        SELECT i."organizationId", min(i."createdAt") AS at
        FROM "Integration" i
        WHERE i."inBetweenSteps" = false
        GROUP BY i."organizationId"
      )
      SELECT
        coalesce(a."utmCampaign", '(none)') AS campaign,
        coalesce(a."utmSource",
          CASE WHEN a."gclid" IS NOT NULL THEN 'google'
               WHEN a."fbclid" IS NOT NULL THEN 'meta'
               WHEN a."ttclid" IS NOT NULL THEN 'tiktok'
               WHEN a."msclkid" IS NOT NULL THEN 'bing'
               WHEN a."referrer" IS NOT NULL THEN '(referral)'
               ELSE '(direct)' END) AS source,
        coalesce(a."utmMedium", '') AS medium,
        count(*) AS signups,
        count(*) FILTER (WHERE coalesce(a."firstChannelAt", fc.at) IS NOT NULL) AS channels,
        count(*) FILTER (WHERE coalesce(a."firstChannelAt", fc.at)
          <= o."createdAt" + make_interval(mins => ${FIRST_CHANNEL_WINDOW_MINUTES}::int)) AS channels_fast,
        count(*) FILTER (WHERE a."trialStartedAt" IS NOT NULL OR o."allowTrial" = false OR s.id IS NOT NULL) AS trials,
        count(*) FILTER (WHERE a."paidAt" IS NOT NULL
          OR (s.id IS NOT NULL AND s."deletedAt" IS NULL AND NOT s."isLifetime" AND o."isTrailing" = false)) AS paid,
        count(*) FILTER (WHERE coalesce(a.device, CASE WHEN ow.agent ~* '(iPad|Tablet)' THEN 'tablet'
          WHEN ow.agent ~* '(Mobi|iPhone|iPod|Android)' THEN 'mobile' ELSE 'desktop' END) = 'mobile') AS mobile,
        count(*) FILTER (WHERE a."inApp" IS NOT NULL
          OR ow.agent ~ '(FBAN|FBAV|FB_IAB|FBIOS|Instagram|Barcelona|LinkedInApp|musical_ly|BytedanceWebview|ByteLocale)') AS in_app
      FROM "Organization" o
      LEFT JOIN "SignupAttribution" a ON a."organizationId" = o.id
      LEFT JOIN "Subscription" s ON s."organizationId" = o.id
      LEFT JOIN owner ow ON ow."organizationId" = o.id
      LEFT JOIN first_channel fc ON fc."organizationId" = o.id
      WHERE o."createdAt" >= ${from} AND o."createdAt" < ${to}
      GROUP BY 1, 2, 3
      ORDER BY signups DESC, campaign
    `);

    const out: AttributionRow[] = rows.map((r) => ({
      campaign: r.campaign,
      source: r.source,
      medium: r.medium,
      signups: Number(r.signups),
      channels: Number(r.channels),
      channelsFast: Number(r.channels_fast),
      trials: Number(r.trials),
      paid: Number(r.paid),
      mobile: Number(r.mobile),
      inApp: Number(r.in_app),
    }));
    const sum = (
      k: 'signups' | 'channels' | 'channelsFast' | 'trials' | 'paid' | 'mobile' | 'inApp'
    ) =>
      out.reduce((n, r) => n + r[k], 0);
    const signups = sum('signups');
    const mobile = sum('mobile');
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        signups,
        channels: sum('channels'),
        channelsFast: sum('channelsFast'),
        trials: sum('trials'),
        paid: sum('paid'),
        mobile,
        inApp: sum('inApp'),
        mobileShare: signups ? Math.round((mobile / signups) * 1000) / 1000 : 0,
      },
      rows: out,
    };
  }
}
