import {
  Body,
  Controller,
  Get,
  HttpException,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { GetUserFromRequest } from '@hookpost/nestjs-libraries/user/user.from.request';
import { Prisma, User } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { ErrorsService } from '@hookpost/nestjs-libraries/database/prisma/errors/errors.service';
import { AdminStatsService } from '@hookpost/nestjs-libraries/database/prisma/admin-stats/admin-stats.service';
import { PrismaRepository } from '@hookpost/nestjs-libraries/database/prisma/prisma.service';
import dayjs from 'dayjs';
import { RazorpayClient } from '@hookpost/nestjs-libraries/services/razorpay.client';
import { DUNNING_STATES } from '@hookpost/nestjs-libraries/services/billing.currency';
import { SupportTicketsService } from '@hookpost/nestjs-libraries/services/support-tickets.service';
import { assertJsonRequest } from '@hookpost/backend/services/auth/json.only';
import { RefundsService } from '@hookpost/nestjs-libraries/database/prisma/refunds/refunds.service';
import { SignupAttributionService } from '@hookpost/nestjs-libraries/database/prisma/attribution/signup-attribution.service';
import {
  signupDetails,
  signupSource,
} from '@hookpost/nestjs-libraries/database/prisma/attribution/signup.source';
import { MarketplaceUsageService } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.usage.service';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';
import { OwnerSalesAlertService } from '@hookpost/nestjs-libraries/services/owner.sales.alert.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import {
  DisputeEvidencePack,
  disputeEvidenceFilename,
  renderDisputeEvidence,
} from '@hookpost/nestjs-libraries/services/dispute.evidence';
import { sourceLabel } from '@hookpost/nestjs-libraries/marketplace/marketplace.adapters';
import { workspaceRow } from '@hookpost/backend/api/routes/admin.workspaces';
import {
  AdminBulkRefundDto,
  AdminRefundDto,
} from '@hookpost/nestjs-libraries/dtos/billing/admin.refund.dto';
import {
  AdminEndPlanDto,
  AdminRestorePlanDto,
} from '@hookpost/nestjs-libraries/dtos/billing/admin.plan.action.dto';
import {
  AdminPlanActionsService,
  EndPlanCorrection,
} from '@hookpost/nestjs-libraries/services/admin.plan.actions.service';
import {
  freePlanAvailable,
  freePostsUsed,
  planSource,
  trialCutoffs,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { POSTED_STATES } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.repository';
import {
  BillingState,
  billingState,
  countBillingStates,
  RemoteSubscription,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/billing.state';

/** How long a Razorpay subscription or plan read for /admin/users is reused. */
const REMOTE_TTL_MS = 120_000;
/** One Razorpay read for /admin/users waits at most this long. */
const REMOTE_TIMEOUT_MS = 8_000;
/** At most this many Razorpay reads at once for /admin/users. */
const REMOTE_CONCURRENCY = 6;
/**
 * All Razorpay reads for one /admin/users together wait at most this long;
 * what is not read by then is labelled from the database (and counted in
 * billingSource.failed), so a slow Razorpay never times the page out.
 */
const REMOTE_DEADLINE_MS = 10_000;

@ApiTags('Admin')
@Controller('/admin')
export class AdminController {
  constructor(
    private _errorsService: ErrorsService,
    private _adminStatsService: AdminStatsService,
    private _user: PrismaRepository<'user'>,
    private _organization: PrismaRepository<'organization'>,
    private _subscription: PrismaRepository<'subscription'>,
    private _integration: PrismaRepository<'integration'>,
    private _post: PrismaRepository<'post'>,
    private _contactMessage: PrismaRepository<'contactMessage'>,
    private _supportTicketsService: SupportTicketsService,
    private _refundsService: RefundsService,
    private _attribution: SignupAttributionService,
    private _attributionRows: PrismaRepository<'signupAttribution'>,
    private _marketplaceAccount: PrismaRepository<'marketplaceAccount'>,
    private _marketplaceUsage: MarketplaceUsageService,
    private _organizationService: OrganizationService,
    private _ownerAlerts: OwnerSalesAlertService,
    private _subscriptionService: SubscriptionService,
    private _planActionsService: AdminPlanActionsService
  ) {}

  private readonly _razorpay = new RazorpayClient();
  private _checkoutCache?: { at: number; data: Record<string, any> };
  private _remoteCache = new Map<string, { at: number; data: RemoteSubscription }>();
  /**
   * Plan id -> its price, as a promise so subscriptions read in parallel on
   * the same plan share one read; a Razorpay plan's price never changes. A
   * read that fails is dropped, to be tried again next time.
   */
  private _planCache = new Map<string, Promise<{ amount: number; currency: string | null } | null>>();

  /**
   * Razorpay's copy of each subscription (by Subscription.identifier), for
   * the billing states on /admin/users: status, paid_count and the dates.
   * Read a few at a time (REMOTE_CONCURRENCY) and reused for two minutes; one
   * that cannot be read is left out, and its workspace is labelled from the
   * database alone. `failed` counts those.
   */
  private async remoteSubscriptions(
    identifiers: string[],
    fresh: boolean
  ): Promise<{ byId: Record<string, RemoteSubscription>; failed: number; read: boolean }> {
    const byId: Record<string, RemoteSubscription> = {};
    if (!identifiers.length || !this._razorpay.configured) {
      return { byId, failed: 0, read: false };
    }
    const timed = <T>(p: Promise<T>) =>
      Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timed out')), REMOTE_TIMEOUT_MS).unref?.()
        ),
      ]);
    let failed = 0;
    const queue = [...identifiers];
    const settled = new Set<string>();
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        await readOne(id);
      }
    };
    const readOne = async (id: string) => {
      const cached = this._remoteCache.get(id);
      if (!fresh && cached && Date.now() - cached.at < REMOTE_TTL_MS) {
        byId[id] = cached.data;
        settled.add(id);
        return;
      }
      try {
        const sub: any = await timed(
          this._razorpay.request('GET', `/subscriptions/${encodeURIComponent(id)}`)
        );
        let price: { amount: number; currency: string | null } | null = null;
        if (sub?.plan_id) {
          const planId = String(sub.plan_id);
          let pending = this._planCache.get(planId);
          if (!pending) {
            pending = timed(
              this._razorpay.request('GET', `/plans/${encodeURIComponent(planId)}`)
            ).then(
              (plan: any) =>
                plan?.item && Number.isFinite(Number(plan.item.amount))
                  ? { amount: Number(plan.item.amount) / 100, currency: plan.item.currency || null }
                  : null,
              () => null
            );
            this._planCache.set(planId, pending);
          }
          price = await pending;
          if (!price) this._planCache.delete(planId);
        }
        // A 200 without a status is not an answer about this subscription.
        if (!sub?.status) throw new Error('Razorpay answered without a status');
        const num = (v: any) => (Number(v) > 0 ? Number(v) : null);
        const data: RemoteSubscription = {
          status: String(sub?.status || ''),
          paidCount: Number(sub?.paid_count || 0),
          startAt: num(sub?.start_at),
          chargeAt: num(sub?.charge_at),
          currentEnd: num(sub?.current_end),
          amount: price?.amount ?? null,
          currency: price?.currency ?? null,
        };
        this._remoteCache.set(id, { at: Date.now(), data });
        byId[id] = data;
      } catch {
        failed += 1;
      } finally {
        settled.add(id);
      }
    };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(REMOTE_CONCURRENCY, queue.length) }, worker)),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, REMOTE_DEADLINE_MS);
      }),
    ]);
    clearTimeout(deadline);
    // Past the deadline: stop starting reads; the ones still running finish
    // into the cache for the next load but are not waited for.
    queue.length = 0;
    const unread = identifiers.filter((id) => !settled.has(id));
    const read: Record<string, RemoteSubscription> = {};
    for (const id of identifiers) if (byId[id] && settled.has(id)) read[id] = byId[id];
    return { byId: read, failed: failed + unread.length, read: true };
  }

  private assertSuperAdmin(user: User) {
    // 403: signed in, but not a platform super admin (it was a 400 until
    // 1 Nov 2026, which read as a malformed request).
    if (!user?.isSuperAdmin) {
      throw new HttpException('Unauthorized', 403);
    }
  }

  /**
   * While a super admin impersonates someone, the request carries that
   * person's user (auth.middleware), so a refund would be recorded under
   * their name. Money is only moved as yourself.
   */
  private assertNotImpersonating(req: Request) {
    if (req?.cookies?.impersonate || req?.headers?.impersonate) {
      throw new HttpException(
        'Stop impersonating first: refunds are recorded under your own name',
        400
      );
    }
  }

  @Get('/users')
  async listUsers(
    @GetUserFromRequest() user: User,
    @Query('search') search?: string,
    @Query('tier') tier?: string,
    @Query('fresh') fresh?: string
  ) {
    this.assertSuperAdmin(user);

    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(search
        ? {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              {
                organizations: {
                  some: {
                    organization: {
                      name: { contains: search, mode: 'insensitive' },
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [
      users,
      totalUsers,
      totalOrgs,
      totalSubscriptions,
      totalIntegrations,
      totalPosts,
      deletedUsers,
      orgsWithUsers,
      marketplaceRows,
      sources,
    ] = await Promise.all([
        this._user.model.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            email: true,
            name: true,
            isSuperAdmin: true,
            activated: true,
            providerName: true,
            createdAt: true,
            organizations: {
              // Live workspaces only, oldest membership first: the first is
              // the one the row shows and Impersonate opens.
              where: { organization: { deletedAt: null } },
              orderBy: { createdAt: 'asc' },
              select: {
                // The UserOrganization id - what the impersonate cookie must
                // hold (auth.middleware resolves it with getUserOrg).
                id: true,
                role: true,
                organization: {
                  select: {
                    id: true,
                    name: true,
                    // DIRECT or the marketplace the workspace came through.
                    source: true,
                    paymentId: true,
                    allowTrial: true,
                    isTrailing: true,
                    createdAt: true,
                    subscription: {
                      select: {
                        id: true,
                        subscriptionTier: true,
                        isLifetime: true,
                        period: true,
                        totalChannels: true,
                        cancelAt: true,
                        createdAt: true,
                        deletedAt: true,
                        identifier: true,
                        paymentFailingSince: true,
                      },
                    },
                    // The owner's signup country: which trial cutoff applies.
                    users: {
                      where: { role: 'SUPERADMIN' },
                      orderBy: { createdAt: 'asc' },
                      take: 1,
                      select: { user: { select: { signupCountry: true } } },
                    },
                    _count: {
                      select: {
                        Integration: true,
                        post: true,
                        // Platform super admins among the members: such a
                        // workspace keeps the Free plan after
                        // FREE_PLAN_SUNSET_AT (trial.policy.ts).
                        users: {
                          where: {
                            user: { isSuperAdmin: true, deletedAt: null },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        this._user.model.user.count({ where: { deletedAt: null } }),
        this._organization.model.organization.count({ where: { deletedAt: null } }),
        this._subscription.model.subscription.count({ where: { deletedAt: null } }),
        this._integration.model.integration.count({ where: { deletedAt: null } }),
        this._post.model.post.count({ where: { deletedAt: null } }),
        this._user.model.user.count({ where: { deletedAt: { not: null } } }),
        this._organization.model.organization.count({
          where: { deletedAt: null, users: { some: { user: { deletedAt: null } } } },
        }),
        this._marketplaceAccount.model.marketplaceAccount.findMany({
          select: { organizationId: true },
        }),
        // Live workspaces per Organization.source: direct sign-ups and each
        // marketplace.
        this._marketplaceUsage.sources(),
      ]);

    // Workspaces on a trial right now: a Razorpay trial subscription on file
    // (a Subscription row) that has not been charged yet (isTrailing). Every
    // new workspace starts with isTrailing set and no row, so the old "trial
    // and no row" test counted users who had never subscribed at all. Counted
    // per workspace, once each, however many members it has.
    const activeTrials = new Set(
      users.flatMap((u) =>
        u.organizations
          .filter(
            (o) =>
              o.organization.isTrailing &&
              !!o.organization.subscription &&
              !o.organization.subscription.isLifetime
          )
          .map((o) => o.organization.id)
      )
    ).size;

    // Each workspace's billing state (billing.state.ts): one badge with its
    // date, from the Subscription row, Razorpay's copy of it, the signup
    // attribution, the free posts used and planState (trial.policy.ts), the
    // same rule the paywall applies.
    const cutoffs = { ...trialCutoffs(), now: new Date() };
    const marketplaceOrgs = new Set(marketplaceRows.map((m) => m.organizationId));
    const orgIds = [
      ...new Set(users.flatMap((u) => u.organizations.map((o) => o.organization.id))),
    ];
    const attributionRows = orgIds.length
      ? await this._attributionRows.model.signupAttribution.findMany({
          where: { organizationId: { in: orgIds } },
          select: {
            organizationId: true,
            trialStartedAt: true,
            paidAt: true,
            // Where the sign-up came from (signup.source.ts).
            utmSource: true,
            utmMedium: true,
            utmCampaign: true,
            referrer: true,
            landingPath: true,
            gclid: true,
            fbclid: true,
            ttclid: true,
            msclkid: true,
          },
        })
      : [];
    const attribution = new Map(attributionRows.map((a) => [a.organizationId, a]));
    // Free posts matter only to a workspace with no plan (or a gift), so the
    // post rows of paying and lifetime ones are never read.
    const noPlanOrgIds = [
      ...new Set(
        users.flatMap((u) =>
          u.organizations
            .filter((o) => {
              const s = o.organization.subscription;
              return !s || !!s.deletedAt || planSource(s) === 'gift';
            })
            .map((o) => o.organization.id)
        )
      ),
    ];
    const [members, postsUsed] = await Promise.all([
      this.memberCounts(orgIds),
      this.freePostsUsedByOrg(noPlanOrgIds),
    ]);
    const identifiers = [
      ...new Set(
        users.flatMap((u) =>
          u.organizations
            .map((o) => o.organization.subscription)
            .filter(
              (s) => s && !s.deletedAt && !s.isLifetime && s.identifier?.startsWith('sub_')
            )
            .map((s) => s!.identifier!)
        )
      ),
    ];
    const remote = await this.remoteSubscriptions(
      identifiers,
      fresh === '1' || fresh === 'true'
    );

    const rowStates: BillingState[][] = [];
    const withPlanState = users.map((u) => {
      const organizations = u.organizations.map((o) => {
        const { users: owners, ...organization } = o.organization;
        const policyOrg = {
          ...organization,
          ownerCountry: owners?.[0]?.user?.signupCountry ?? null,
          platformAdmin: (organization._count?.users ?? 0) > 0,
        };
        const sub = organization.subscription;
        const billing = billingState(
          {
            org: policyOrg,
            marketplace: marketplaceOrgs.has(organization.id),
            attribution: attribution.get(organization.id) ?? null,
            remote: sub?.identifier ? remote.byId[sub.identifier] ?? null : null,
            freePostsUsed: postsUsed[organization.id] ?? 0,
          },
          cutoffs
        );
        const { identifier: _identifier, ...subscription } = sub ?? ({} as any);
        return {
          ...o,
          organization: {
            ...organization,
            // A soft-deleted row is no plan (billing.state.ts reads it so).
            subscription: sub && !sub.deletedAt ? subscription : null,
            planState: billing.planState ?? undefined,
            freePlanAvailable: freePlanAvailable(policyOrg, cutoffs),
            billing,
            // Live members of the workspace (this user included).
            members: members[organization.id] ?? 0,
            // utm source / ad click id / referrer host, or null when no
            // attribution was recorded (before 23 Oct 2026, marketplaces).
            signupSource: signupSource(attribution.get(organization.id)),
          },
        };
      });
      const states = organizations.length
        ? organizations.map((o) => o.organization.billing.state)
        : [billingState({ org: null }, cutoffs).state];
      rowStates.push([...new Set(states)]);
      return { ...u, organizations, billingStates: [...new Set(states)] };
    });

    // Rows per state: a user whose workspaces are in two states counts in
    // both, exactly as the page's filter chip for each state finds them.
    const states = countBillingStates(rowStates.flat());

    // Workspaces nobody signs in to: api.market subscribers by design, and
    // any other whose members were all deleted.
    const marketplaceWorkspaces = marketplaceOrgs.size
      ? await this._organization.model.organization.count({
          where: {
            deletedAt: null,
            id: { in: [...marketplaceOrgs] },
            users: { none: { user: { deletedAt: null } } },
          },
        })
      : 0;

    return {
      metrics: {
        totalUsers,
        deletedUsers,
        totalOrgs,
        workspaces: {
          total: totalOrgs,
          withUsers: orgsWithUsers,
          marketplace: marketplaceWorkspaces,
          withoutUsers: Math.max(0, totalOrgs - orgsWithUsers - marketplaceWorkspaces),
          usersWithSeveral: withPlanState.filter((u) => u.organizations.length > 1).length,
        },
        totalSubscriptions,
        activeTrials,
        totalIntegrations,
        totalPosts,
        states,
        sources,
      },
      billingSource: {
        razorpay: !remote.read
          ? identifiers.length
            ? 'not_configured'
            : 'not_needed'
          : remote.failed
          ? 'partial'
          : 'ok',
        failed: remote.failed,
        asOf: cutoffs.now.toISOString(),
        sunsetAt: cutoffs.sunset ? cutoffs.sunset.toISOString() : null,
      },
      users: withPlanState,
    };
  }

  /**
   * Per-workspace checkout intent, read live from Razorpay.
   *
   * Opening checkout creates a Razorpay subscription (tagged notes.orgId), and
   * authorising the UPI/card mandate takes a small refundable payment (Rs 5)
   * against the customer. So "opened N times, never paid", "Rs 5 failed" and
   * "Rs 5 paid" separate someone who wanted to pay from someone who looked.
   * The account is shared with VetNow, hence the notes.service filter.
   * Cached for two minutes: it walks every payment and subscription.
   */
  /**
   * The Marketplaces page: per marketplace (api.market, RapidAPI, the keyed
   * ones in .env), its subscribers (paying, free, dormant, blocked), calls
   * and refusals (401, 403, 429, 5xx) today / 7 / 30 UTC days, and its last
   * call; plus calls that named no marketplace, and workspaces per source.
   */
  @Get('/marketplaces')
  async marketplaces(@GetUserFromRequest() user: User) {
    this.assertSuperAdmin(user);
    return this._marketplaceUsage.overview();
  }

  /**
   * Free posts used per workspace, counted exactly as the post gate counts
   * them (SubscriptionRepository.freePostRows + trial.policy.ts
   * freePostsUsed), so "X of 3 left" on this page is what the composer
   * enforces. One query for all of them.
   */
  private async freePostsUsedByOrg(orgIds: string[]): Promise<Record<string, number>> {
    if (!orgIds.length) return {};
    const rows = await this._post.model.post.findMany({
      where: {
        organizationId: { in: orgIds },
        parentPostId: null,
        OR: [{ deletedAt: null }, { state: { in: [...POSTED_STATES] } }],
      },
      select: { organizationId: true, publishDate: true, integrationId: true },
    });
    const byOrg = new Map<string, Array<{ publishDate: Date; integrationId: string | null }>>();
    for (const r of rows) {
      const list = byOrg.get(r.organizationId) ?? [];
      list.push(r);
      byOrg.set(r.organizationId, list);
    }
    return Object.fromEntries([...byOrg].map(([id, list]) => [id, freePostsUsed(list)]));
  }

  /** Live members (users not deleted) per workspace. */
  private async memberCounts(orgIds: string[]): Promise<Record<string, number>> {
    if (!orgIds.length) return {};
    const rows = await this._organization.model.organization.findMany({
      where: { id: { in: orgIds } },
      select: {
        id: true,
        _count: { select: { users: { where: { user: { deletedAt: null } } } } },
      },
    });
    return Object.fromEntries(rows.map((r) => [r.id, r._count?.users ?? 0]));
  }

  /**
   * Every live workspace, newest first: name, source (Direct or the
   * marketplace), members and owner, billing state (the same badge as the
   * Users rows), live channels and posts, created; and for a marketplace
   * subscriber workspace the masked subscriber id, product, plan, status,
   * last call and calls in the last 7 days (counted from 27 Oct 2026).
   */
  @Get('/workspaces')
  async listWorkspaces(@GetUserFromRequest() user: User, @Query('fresh') fresh?: string) {
    this.assertSuperAdmin(user);
    const [orgs, accounts] = await Promise.all([
      this._organization.model.organization.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          source: true,
          allowTrial: true,
          isTrailing: true,
          createdAt: true,
          disputedAt: true,
          disputeReason: true,
          disputePaymentId: true,
          subscription: {
            select: {
              id: true,
              subscriptionTier: true,
              isLifetime: true,
              period: true,
              totalChannels: true,
              cancelAt: true,
              createdAt: true,
              deletedAt: true,
              identifier: true,
              paymentFailingSince: true,
            },
          },
          // Live members, oldest first: the first owner is "the owner".
          users: {
            where: { user: { deletedAt: null } },
            orderBy: { createdAt: 'asc' },
            select: {
              role: true,
              user: { select: { email: true, signupCountry: true, isSuperAdmin: true } },
            },
          },
          _count: {
            select: {
              Integration: { where: { deletedAt: null, inBetweenSteps: false } },
              post: { where: { deletedAt: null, parentPostId: null } },
            },
          },
        },
      }),
      this._marketplaceAccount.model.marketplaceAccount.findMany({
        select: {
          id: true,
          organizationId: true,
          marketplace: true,
          externalUserId: true,
          product: true,
          plan: true,
          status: true,
          lastSeenAt: true,
        },
      }),
    ]);

    const accountByOrg = new Map(accounts.map((a) => [a.organizationId, a]));
    const orgIds = orgs.map((o) => o.id);
    const [attributionRows, calls7d] = await Promise.all([
      orgIds.length
        ? this._attributionRows.model.signupAttribution.findMany({
            where: { organizationId: { in: orgIds } },
            select: { organizationId: true, trialStartedAt: true, paidAt: true },
          })
        : [],
      this._marketplaceUsage.accountCalls(
        accounts.filter((a) => orgIds.includes(a.organizationId)).map((a) => a.id)
      ),
    ]);
    const attribution = new Map(attributionRows.map((a) => [a.organizationId, a] as const));
    const cutoffs = { ...trialCutoffs(), now: new Date() };
    const identifiers = [
      ...new Set(
        orgs
          .map((o) => o.subscription)
          .filter((s) => s && !s.deletedAt && !s.isLifetime && s.identifier?.startsWith('sub_'))
          .map((s) => s!.identifier!)
      ),
    ];
    const [remote, postsUsed] = await Promise.all([
      this.remoteSubscriptions(identifiers, fresh === '1' || fresh === 'true'),
      this.freePostsUsedByOrg(
        orgs
          .filter((o) => !o.subscription || !!o.subscription.deletedAt || planSource(o.subscription) === 'gift')
          .map((o) => o.id)
      ),
    ]);

    const workspaces = orgs.map((o) => {
      const { users: memberRows, _count, subscription: sub, ...org } = o;
      const owner = memberRows.find((m) => m.role === 'SUPERADMIN') ?? memberRows[0];
      const billing = billingState(
        {
          org: {
            ...org,
            subscription: sub,
            ownerCountry: owner?.user?.signupCountry ?? null,
            platformAdmin: memberRows.some((m) => m.user?.isSuperAdmin),
          },
          marketplace: accountByOrg.has(o.id),
          attribution: attribution.get(o.id) ?? null,
          remote: sub?.identifier ? remote.byId[sub.identifier] ?? null : null,
          freePostsUsed: postsUsed[o.id] ?? 0,
        },
        cutoffs
      );
      const account = accountByOrg.get(o.id) ?? null;
      return workspaceRow(
        {
          id: o.id,
          name: o.name,
          source: o.source,
          createdAt: o.createdAt,
          members: memberRows.length,
          owner: owner?.user?.email ?? null,
          channels: _count?.Integration ?? 0,
          posts: _count?.post ?? 0,
          billing,
          account,
          calls7d: account ? calls7d[account.id] ?? 0 : 0,
          disputedAt: o.disputedAt,
          disputeReason: o.disputeReason,
          disputePaymentId: o.disputePaymentId,
        },
        (id) => sourceLabel(id)
      );
    });

    return { asOf: cutoffs.now.toISOString(), workspaces };
  }

  /**
   * The workspace's payment dispute, or null (GET), and the owner's clear
   * (POST). A bank reported a chargeback, so RazorpayService.handleDispute
   * ended the plan and locked the workspace: no free posts, no trial, and
   * checkout refuses (trial.policy.ts workspaceDisputed). Clearing it lets
   * that workspace buy again; it does not give the plan back, and winning
   * the dispute never clears it by itself.
   *
   * Super admin only, like everything here, and audited: who cleared it and
   * when stay on the workspace (disputeClearedBy, disputeClearedAt), the
   * reason and the disputed payment stay beside them, the clear is logged,
   * and the owner is emailed (DISPUTE_CLEARED).
   */
  @Get('/workspaces/:id/dispute')
  async getWorkspaceDispute(
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    this.assertSuperAdmin(user);
    const org = await this._organizationService.getDispute(id);
    if (!org) throw new HttpException('Workspace not found', 404);
    return org;
  }

  @Post('/workspaces/:id/dispute/clear')
  async clearWorkspaceDispute(
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Req() req: Request
  ) {
    assertJsonRequest(req);
    this.assertSuperAdmin(user);
    const before = await this._organizationService.getDispute(id);
    if (!before) throw new HttpException('Workspace not found', 404);
    if (!before.disputedAt) {
      return { cleared: false, reason: 'This workspace has no open dispute.' };
    }

    const by = `${user.email} (${user.id})`;
    const cleared = await this._organizationService.clearDispute(id, by);
    if (!cleared) {
      return { cleared: false, reason: 'This workspace has no open dispute.' };
    }
    Logger.warn(
      `Super admin ${by} cleared the payment dispute on workspace ${id} (reason ${
        before.disputeReason || 'not given'
      }, payment ${before.disputePaymentId || 'unknown'}, reported ${before.disputedAt.toISOString()}).`,
      AdminController.name
    );
    void this._ownerAlerts.notify({
      event: 'DISPUTE_CLEARED',
      // The time, because one workspace can be disputed and cleared again.
      key: `dispute-cleared:${id}:${Date.now()}`,
      source: 'razorpay',
      organizationId: id,
      ids: { payment: before.disputePaymentId },
      notes: [
        `Cleared by ${by}`,
        `Dispute reported ${before.disputedAt.toISOString()}, reason ${
          before.disputeReason || 'not given'
        }`,
        'The workspace can buy a plan again. Its old plan was not restored.',
      ],
    });
    return { cleared: true };
  }

  /**
   * The evidence pack RazorpayService.handleDispute built when the
   * chargeback arrived (dispute.evidence.ts), as a text file to download and
   * answer Razorpay with. Built then, not now, because the plan row and the
   * paid period it names were ended by the dispute itself.
   */
  @Get('/workspaces/:id/dispute/evidence')
  async getWorkspaceDisputeEvidence(
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Res() res: Response
  ) {
    this.assertSuperAdmin(user);
    const org = await this._organizationService.getDisputeEvidence(id);
    if (!org) throw new HttpException('Workspace not found', 404);
    if (!org.disputeEvidence) {
      throw new HttpException('No evidence pack for this workspace', 404);
    }
    let pack: DisputeEvidencePack;
    try {
      pack = JSON.parse(org.disputeEvidence);
    } catch {
      throw new HttpException('The evidence pack could not be read', 500);
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${disputeEvidenceFilename(pack)}"`
    );
    res.send(renderDisputeEvidence(pack));
  }

  /**
   * Give back the plan the chargeback ended, for the time already paid for:
   * AdminPlanActionsService.restoreAfterWonDispute decides and writes; this
   * logs who did it and tells the owner.
   */
  @Post('/workspaces/:id/dispute/restore')
  async restoreWorkspacePlan(
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Req() req: Request
  ) {
    assertJsonRequest(req);
    this.assertSuperAdmin(user);
    const by = `${user.email} (${user.id})`;
    const result = await this._planActionsService.restoreAfterWonDispute(id, by);
    if (!result) throw new HttpException('Workspace not found', 404);
    if (!result.restored) return result;

    Logger.warn(
      `Super admin ${by} restored the ${result.tier} plan on workspace ${id} after a payment dispute (until ${result.until}, subscription ${result.identifier}).`,
      AdminController.name
    );
    void this._ownerAlerts.notify({
      event: 'DISPUTE_RESTORED',
      key: `dispute-restored:${id}:${Date.now()}`,
      source: 'razorpay',
      organizationId: id,
      ids: { subscription: result.identifier },
      notes: [
        `Restored by ${by}`,
        `${result.tier} ${result.period} until ${result.until}`.trim(),
        'The dispute is cleared and the workspace can buy again. The Razorpay subscription stays cancelled, so the plan ends on that date unless they buy a new one.',
      ],
    });
    return { restored: true, until: result.until };
  }

  @Get('/checkout-signals')
  async checkoutSignals(
    @GetUserFromRequest() user: User,
    @Query('fresh') fresh?: string
  ) {
    this.assertSuperAdmin(user);
    if (!fresh && this._checkoutCache && Date.now() - this._checkoutCache.at < 120_000) {
      return this._checkoutCache.data;
    }

    const all = async (path: string) => {
      const items: any[] = [];
      for (let skip = 0; skip < 2000; skip += 100) {
        const page: any = await this._razorpay.request(
          'GET',
          `${path}?count=100&skip=${skip}`
        );
        items.push(...(page?.items || []));
        if (!page?.items || page.items.length < 100) break;
      }
      return items;
    };

    const [subscriptions, payments, orgs] = await Promise.all([
      all('/subscriptions'),
      all('/payments'),
      this._organization.model.organization.findMany({
        where: { paymentId: { not: null } },
        select: { id: true, paymentId: true },
      }),
    ]);

    const customerToOrg: Record<string, string> = {};
    for (const o of orgs) if (o.paymentId) customerToOrg[o.paymentId] = o.id;

    const out: Record<string, any> = {};
    const bucket = (orgId: string) =>
      (out[orgId] ||= {
        checkoutsOpened: 0,
        currencies: [] as string[],
        lastOpenedAt: null as string | null,
        authenticated: false,
        /** A Hookpost subscription of this workspace is pending or halted: a charge failed. */
        pastDue: false,
        failedAuthAttempts: 0,
        payments: [] as any[],
      });

    for (const sub of subscriptions) {
      const notes = sub?.notes || {};
      if (notes.service !== 'hookpost' || !notes.orgId) continue;
      if (sub.customer_id) customerToOrg[sub.customer_id] ||= notes.orgId;
      const b = bucket(notes.orgId);
      b.checkoutsOpened += 1;
      if (notes.currency && !b.currencies.includes(notes.currency)) {
        b.currencies.push(notes.currency);
      }
      const at = new Date(sub.created_at * 1000).toISOString();
      if (!b.lastOpenedAt || at > b.lastOpenedAt) b.lastOpenedAt = at;
      if (['authenticated', 'active', 'pending', 'halted', 'completed'].includes(sub.status) || sub.paid_count > 0) {
        b.authenticated = true;
      }
      if (DUNNING_STATES.includes(sub.status)) {
        b.pastDue = true;
      }
      b.failedAuthAttempts += sub.auth_attempts || 0;
    }

    for (const pay of payments) {
      const orgId = pay?.customer_id && customerToOrg[pay.customer_id];
      if (!orgId) continue;
      bucket(orgId).payments.push({
        id: pay.id,
        status: pay.status,
        amount: pay.amount / 100,
        currency: pay.currency,
        method: pay.method,
        at: new Date(pay.created_at * 1000).toISOString(),
        error: pay.error_description || null,
      });
    }
    for (const b of Object.values(out)) {
      b.payments.sort((x: any, y: any) => (x.at < y.at ? 1 : -1));
    }

    this._checkoutCache = { at: Date.now(), data: out };
    return out;
  }

  // ---------------------------------------------------------------------------
  // Refunds (Razorpay Refund API; see RefundsService)
  // ---------------------------------------------------------------------------

  @Get('/refunds/payments')
  async listRefundPayments(
    @GetUserFromRequest() user: User,
    @Query('skip') skip?: string,
    @Query('count') count?: string,
    @Query('to') to?: string,
    @Query('scope') scope?: string,
    @Query('paymentId') paymentId?: string
  ) {
    this.assertSuperAdmin(user);
    return this._refundsService.listPayments({
      skip: skip ? parseInt(skip, 10) : 0,
      count: count ? parseInt(count, 10) : 50,
      to: to ? parseInt(to, 10) : undefined,
      all: scope === 'all',
      paymentId: paymentId || undefined,
    });
  }

  /** Read-only: every Razorpay refund of the last 180 days, wherever it was made. */
  @Get('/refunds/history')
  async listRefundHistory(
    @GetUserFromRequest() user: User,
    @Query('skip') skip?: string,
    @Query('count') count?: string,
    @Query('to') to?: string,
    @Query('scope') scope?: string
  ) {
    this.assertSuperAdmin(user);
    return this._refundsService.listRefunds({
      skip: skip ? parseInt(skip, 10) : 0,
      count: count ? parseInt(count, 10) : 50,
      to: to ? parseInt(to, 10) : undefined,
      all: scope === 'all',
    });
  }

  @Get('/refunds/audit')
  async listRefundAudit(
    @GetUserFromRequest() user: User,
    @Query('limit') limit?: string
  ) {
    this.assertSuperAdmin(user);
    return this._refundsService.listAudit(limit ? parseInt(limit, 10) : 50);
  }

  @Post('/refunds')
  async refundPayment(
    @GetUserFromRequest() user: User,
    @Req() req: Request,
    @Body() body: AdminRefundDto
  ) {
    this.assertSuperAdmin(user);
    assertJsonRequest(req);
    this.assertNotImpersonating(req);
    return this._refundsService.refund({ id: user.id, email: user.email }, body);
  }

  @Post('/refunds/bulk')
  async refundPayments(
    @GetUserFromRequest() user: User,
    @Req() req: Request,
    @Body() body: AdminBulkRefundDto
  ) {
    this.assertSuperAdmin(user);
    assertJsonRequest(req);
    this.assertNotImpersonating(req);
    return this._refundsService.refundBulk(
      { id: user.id, email: user.email },
      body.paymentIds,
      { reason: body.reason, confirmForeign: body.confirmForeign, full: body.full }
    );
  }

  @Post('/plan/end')
  async endPlan(
    @GetUserFromRequest() user: User,
    @Req() req: Request,
    @Body() body: AdminEndPlanDto
  ) {
    this.assertSuperAdmin(user);
    assertJsonRequest(req);
    this.assertNotImpersonating(req);
    return this._planActionsService.endPlan(
      { id: user.id, email: user.email },
      {
        organizationId: body.organizationId,
        reason: body.reason,
        correction: body.correction as EndPlanCorrection,
        skipCustomerEmail: body.skipCustomerEmail,
        refundedOn: body.refundedOn ? new Date(body.refundedOn) : null,
      }
    );
  }

  @Post('/plan/restore')
  async restorePlan(
    @GetUserFromRequest() user: User,
    @Req() req: Request,
    @Body() body: AdminRestorePlanDto
  ) {
    this.assertSuperAdmin(user);
    assertJsonRequest(req);
    this.assertNotImpersonating(req);
    return this._planActionsService.restorePlan(
      { id: user.id, email: user.email },
      {
        organizationId: body.organizationId,
        reason: body.reason,
        tier: body.tier as 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' | 'HOOKPOST',
        period: body.period as 'MONTHLY' | 'YEARLY',
        skipCustomerEmail: body.skipCustomerEmail,
        until: body.until ? new Date(body.until) : null,
      }
    );
  }

  @Get('/plan/actions')
  async listPlanActions(
    @GetUserFromRequest() user: User,
    @Query('limit') limit?: string,
    @Query('organizationId') organizationId?: string
  ) {
    this.assertSuperAdmin(user);
    return this._planActionsService.listActions(
      limit ? parseInt(limit, 10) : 50,
      organizationId || undefined
    );
  }

  @Get('/errors')
  async listErrors(
    @GetUserFromRequest() user: User,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('platform') platform?: string,
    @Query('email') email?: string,
    @Query('unknownFirst') unknownFirst?: string
  ) {
    this.assertSuperAdmin(user);
    return this._errorsService.listErrors({
      page: page ? parseInt(page, 10) : 0,
      limit: limit ? parseInt(limit, 10) : 20,
      platform: platform || undefined,
      email: email || undefined,
      unknownFirst: unknownFirst === 'true' || unknownFirst === '1',
    });
  }

  @Get('/errors/platforms')
  async listPlatforms(@GetUserFromRequest() user: User) {
    this.assertSuperAdmin(user);
    return this._errorsService.listPlatforms();
  }

  @Get('/stats')
  async getStats(
    @GetUserFromRequest() user: User,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('unknownOnly') unknownOnly?: string
  ) {
    this.assertSuperAdmin(user);

    const fromDate = from ? dayjs(from) : dayjs().subtract(30, 'day');
    const toDate = to ? dayjs(to) : dayjs();

    return this._adminStatsService.getStats({
      from: fromDate.startOf('day').toDate(),
      to: toDate.endOf('day').toDate(),
      unknownOnly: unknownOnly === 'true' || unknownOnly === '1',
    });
  }

  /**
   * Sign-ups, trials and paying workspaces per utm_campaign (and source and
   * medium), plus phone and in-app-browser counts, for workspaces created in
   * the window: the last `days` days (default 7, at most 365), or from/to
   * (ISO dates, `to` exclusive). Read-only. For the ads routine; the same
   * query runs over SSH as scripts/reports/signups-by-campaign.sql.
   */
  @Get('/attribution')
  async attribution(
    @GetUserFromRequest() user: User,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string
  ) {
    this.assertSuperAdmin(user);
    const toDate = to && dayjs(to).isValid() ? dayjs(to) : dayjs();
    const span = Math.min(Math.max(Number(days) || 7, 1), 365);
    const fromDate =
      from && dayjs(from).isValid() ? dayjs(from) : toDate.subtract(span, 'day');
    if (!fromDate.isBefore(toDate)) {
      throw new HttpException('from must be before to', 400);
    }
    try {
      return await this._attribution.report(fromDate.toDate(), toDate.toDate());
    } catch (err) {
      // Most likely signup-attribution.migration.sql not applied yet.
      throw new HttpException(
        `Attribution report unavailable: ${(err as Error)?.message?.split('\n')[0]}`,
        503
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Contact messages
  // ---------------------------------------------------------------------------

  @Get('/contact-messages')
  async listContactMessages(
    @GetUserFromRequest() user: User,
    @Query('state') state?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string
  ) {
    this.assertSuperAdmin(user);

    const take = Math.min(Math.max(parseInt(limit || '25', 10) || 25, 1), 100);
    const skip = (Math.max(parseInt(page || '1', 10) || 1, 1) - 1) * take;

    // OPEN = not closed (NEW or READ); ANSWERED = open with a reply sent;
    // DONE is closed. The raw states still work for old links.
    const stateWhere: Prisma.ContactMessageWhereInput =
      !state || state === 'ALL'
        ? {}
        : state === 'OPEN'
        ? { state: { in: ['NEW', 'READ'] } }
        : state === 'ANSWERED'
        ? { state: { in: ['NEW', 'READ'] }, answeredAt: { not: null } }
        : { state: state as Prisma.EnumContactMessageStateFilter['equals'] };

    const where: Prisma.ContactMessageWhereInput = {
      ...stateWhere,
      ...(search
        ? {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              { message: { contains: search, mode: 'insensitive' } },
              { ref: { equals: search.trim().toUpperCase() } },
            ],
          }
        : {}),
    };

    const [messages, total, newCount, failedCount] = await Promise.all([
      this._contactMessage.model.contactMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this._contactMessage.model.contactMessage.count({ where }),
      this._contactMessage.model.contactMessage.count({ where: { state: 'NEW' } }),
      // Rows whose notification email never left. These are the ones that would
      // have vanished entirely under the old email-only design.
      this._contactMessage.model.contactMessage.count({
        where: { emailSent: false },
      }),
    ]);

    return {
      messages: messages.map((m) => ({ ...m, ref: SupportTicketsService.refOf(m) })),
      total,
      newCount,
      failedCount,
    };
  }

  @Get('/contact-messages/:id')
  async getContactMessage(@GetUserFromRequest() user: User, @Param('id') id: string) {
    this.assertSuperAdmin(user);
    const ticket = await this._supportTicketsService.get(id);
    if (!ticket) {
      throw new HttpException('Not found', 404);
    }
    return ticket;
  }

  /** Emails the reply to the customer in the product layout. */
  @Post('/contact-messages/:id/reply')
  async replyToContactMessage(
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body('body') body: string,
    @Req() req: Request
  ) {
    this.assertSuperAdmin(user);
    // Sent from the support address: never on another *.hookstep.in page's form.
    assertJsonRequest(req);
    const text = (body || '').trim();
    if (text.length < 2 || text.length > 10000) {
      throw new HttpException('Write a reply between 2 and 10,000 characters', 400);
    }
    const result = await this._supportTicketsService.reply(id, text, {
      id: user.id,
      email: user.email,
    });
    if (!result.reply && !result.ok) {
      throw new HttpException(result.error || 'Reply failed', 404);
    }
    return result;
  }

  @Post('/contact-messages/:id/state')
  async setContactMessageState(
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body('state') state: string,
    @Req() req: Request
  ) {
    this.assertSuperAdmin(user);
    assertJsonRequest(req);

    if (!['NEW', 'READ', 'DONE'].includes(state)) {
      throw new HttpException('Invalid state', 400);
    }

    await this._contactMessage.model.contactMessage.update({
      where: { id },
      data: { state: state as any },
    });

    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Super Admin Management & User Journey
  // ---------------------------------------------------------------------------

  @Post('/users/:id/super-admin')
  async toggleSuperAdmin(
    @GetUserFromRequest() user: User,
    @Param('id') targetUserId: string,
    @Body('isSuperAdmin') isSuperAdmin: boolean,
    @Req() req: Request
  ) {
    this.assertSuperAdmin(user);
    // Super admin can refund, end plans and read every workspace. Until
    // 2 Nov 2026 a form on any *.hookstep.in page, opened by a super admin,
    // could grant it (the auth cookie is SameSite=Lax, which is same-site
    // there): JSON only, which such a form cannot send (json.only.ts).
    assertJsonRequest(req);

    if (user.id === targetUserId && !isSuperAdmin) {
      throw new HttpException('Cannot revoke your own super admin access', 400);
    }

    const updated = await this._user.model.user.update({
      where: { id: targetUserId },
      data: { isSuperAdmin: Boolean(isSuperAdmin) },
      select: {
        id: true,
        email: true,
        name: true,
        isSuperAdmin: true,
      },
    });

    return { ok: true, user: updated };
  }

  @Get('/users/:id/journey')
  async getUserJourney(
    @GetUserFromRequest() user: User,
    @Param('id') targetUserId: string
  ): Promise<Record<string, any>> {
    this.assertSuperAdmin(user);

    const targetUser: any = await this._user.model.user.findUnique({
      where: { id: targetUserId },
      include: {
        organizations: {
          include: {
            organization: {
              include: {
                subscription: true,
                Integration: {
                  select: {
                    id: true,
                    name: true,
                    providerIdentifier: true,
                    picture: true,
                    disabled: true,
                    createdAt: true,
                    updatedAt: true,
                    inBetweenSteps: true,
                  },
                },
                post: {
                  orderBy: { createdAt: 'desc' },
                  take: 50,
                  select: {
                    id: true,
                    content: true,
                    createdAt: true,
                    publishDate: true,
                    state: true,
                    releaseURL: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!targetUser) {
      throw new HttpException('User not found', 404);
    }

    interface JourneyEvent {
      id: string;
      type: 'SIGNUP' | 'WORKSPACE' | 'CHANNEL' | 'POST' | 'BILLING';
      title: string;
      description: string;
      timestamp: Date;
      metadata?: Record<string, any>;
      status?: 'success' | 'warning' | 'info' | 'error';
    }

    const events: JourneyEvent[] = [];

    // 1. Signup Event
    events.push({
      id: `signup-${targetUser.id}`,
      type: 'SIGNUP',
      title: 'Signed Up to Hookpost',
      description: `Registered via ${targetUser.providerName || 'Email'}${
        targetUser.activated ? ' (Verified)' : ' (Pending verification)'
      }`,
      timestamp: targetUser.createdAt,
      status: 'success',
      metadata: {
        email: targetUser.email,
        isSuperAdmin: targetUser.isSuperAdmin,
      },
    });

    // 2. Workspaces, Channels, Posts & Subscriptions
    for (const uo of targetUser.organizations) {
      const org = uo.organization;
      events.push({
        id: `org-${org.id}`,
        type: 'WORKSPACE',
        title: `Workspace: ${org.name}`,
        description: `Member role: ${uo.role}. ${
          org.isTrailing
            ? 'Status: Free plan, never subscribed.'
            : 'Status: Active.'
        }`,
        timestamp: org.createdAt,
        status: 'info',
        metadata: {
          organizationId: org.id,
          role: uo.role,
          paymentId: org.paymentId,
        },
      });

      if (org.subscription) {
        events.push({
          id: `sub-${org.subscription.id}`,
          type: 'BILLING',
          title: `Subscription Plan: ${org.subscription.subscriptionTier}`,
          description: `Plan: ${org.subscription.subscriptionTier} (${
            org.subscription.period
          }). Channels allowed: ${org.subscription.totalChannels}. ${
            org.subscription.isLifetime ? 'Lifetime access.' : ''
          }`,
          timestamp: org.subscription.createdAt,
          status: 'success',
          metadata: {
            tier: org.subscription.subscriptionTier,
            period: org.subscription.period,
            channels: org.subscription.totalChannels,
          },
        });
      }

      for (const integ of org.Integration) {
        events.push({
          id: `integ-${integ.id}`,
          type: 'CHANNEL',
          title: `Connected Channel: ${integ.name || integ.providerIdentifier}`,
          description: `Platform: ${integ.providerIdentifier}. Status: ${
            integ.disabled
              ? 'Disabled'
              : integ.inBetweenSteps
              ? 'Needs Reconnect'
              : 'Active'
          }`,
          timestamp: integ.createdAt,
          status: integ.disabled
            ? 'error'
            : integ.inBetweenSteps
            ? 'warning'
            : 'success',
          metadata: {
            channelId: integ.id,
            provider: integ.providerIdentifier,
            name: integ.name,
            picture: integ.picture,
          },
        });
      }

      for (const p of org.post) {
        const snippet = (p.content || '').slice(0, 100);
        events.push({
          id: `post-${p.id}`,
          type: 'POST',
          title:
            p.state === 'PUBLISHED'
              ? 'Published Social Post'
              : p.state === 'POSTED_MANUALLY'
              ? 'Posted by Hand (Reminder)'
              : p.state === 'REMINDER_SENT'
              ? 'Reminder Sent'
              : p.state === 'QUEUE'
              ? 'Scheduled Post'
              : 'Draft Post',
          description: snippet ? `"${snippet}..."` : 'Social media post',
          timestamp: p.publishDate || p.createdAt,
          status:
            p.state === 'PUBLISHED'
              ? 'success'
              : p.state === 'ERROR'
              ? 'error'
              : 'info',
          metadata: {
            postId: p.id,
            state: p.state,
            releaseURL: p.releaseURL,
          },
        });
      }
    }

    events.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    const totalWorkspaces = targetUser.organizations.length;
    const totalIntegrations = targetUser.organizations.reduce(
      (sum, uo) => sum + uo.organization.Integration.length,
      0
    );
    const totalPosts = targetUser.organizations.reduce(
      (sum, uo) => sum + uo.organization.post.length,
      0
    );
    const publishedPosts = targetUser.organizations.reduce(
      (sum, uo) =>
        sum + uo.organization.post.filter((p) => p.state === 'PUBLISHED').length,
      0
    );
    const hasActiveSubscription = targetUser.organizations.some(
      (uo) => !!uo.organization.subscription
    );
    const isTrailing = targetUser.organizations.some(
      (uo) => uo.organization.isTrailing
    );

    // The panel's "Sign-up" block, for the workspace the Users row shows
    // (oldest live membership): source, country, device, method, the funnel
    // dates and live channel/post counts.
    const liveMemberships = [...targetUser.organizations]
      .filter((uo: any) => !uo.organization?.deletedAt)
      .sort(
        (x: any, y: any) =>
          new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime()
      );
    const main = liveMemberships[0]?.organization;
    // Every workspace the user is in, with their role and its member count.
    const memberCount = await this.memberCounts(
      liveMemberships.map((uo: any) => uo.organization.id)
    );
    const workspaces = liveMemberships.map((uo: any) => ({
      id: uo.organization.id,
      name: uo.organization.name,
      role: uo.role,
      members: memberCount[uo.organization.id] ?? 0,
      source: uo.organization.source || 'DIRECT',
      sourceLabel:
        (uo.organization.source || 'DIRECT') === 'DIRECT'
          ? 'Direct'
          : sourceLabel(uo.organization.source),
      createdAt: uo.organization.createdAt,
    }));
    const [signupAttribution, liveChannels, livePosts, firstChannel] = main
      ? await Promise.all([
          this._attributionRows.model.signupAttribution.findUnique({
            where: { organizationId: main.id },
          }),
          this._integration.model.integration.count({
            where: { organizationId: main.id, deletedAt: null, inBetweenSteps: false },
          }),
          this._post.model.post.count({
            where: { organizationId: main.id, deletedAt: null, parentPostId: null },
          }),
          this._integration.model.integration.findFirst({
            where: { organizationId: main.id, inBetweenSteps: false },
            orderBy: { createdAt: 'asc' },
            select: { createdAt: true },
          }),
        ])
      : [null, 0, 0, null];
    const signup = signupDetails({
      user: targetUser,
      attribution: signupAttribution,
      firstChannelFallback: firstChannel?.createdAt ?? null,
      channels: liveChannels,
      posts: livePosts,
      workspaceId: main?.id ?? null,
    });

    return {
      user: {
        id: targetUser.id,
        email: targetUser.email,
        name: targetUser.name,
        isSuperAdmin: targetUser.isSuperAdmin,
        activated: targetUser.activated,
        providerName: targetUser.providerName,
        createdAt: targetUser.createdAt,
      },
      summary: {
        totalWorkspaces,
        totalIntegrations,
        totalPosts,
        publishedPosts,
        hasActiveSubscription,
        isTrailing,
      },
      signup,
      workspaces,
      events,
    };
  }
}
