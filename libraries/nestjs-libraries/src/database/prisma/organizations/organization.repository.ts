import {
  PrismaRepository,
  PrismaService,
} from '@hookpost/nestjs-libraries/database/prisma/prisma.service';
import {
  Role,
  ShortLinkPreference,
  SubscriptionTier,
  UserOrganization,
} from '@prisma/client';
import { Injectable, Logger } from '@nestjs/common';
import {
  CAN_USE_HOOKPOST,
  signUpStartsConfirmed,
} from '@hookpost/nestjs-libraries/services/email.verification';
import { createHash } from 'crypto';
import { AuthService } from '@hookpost/helpers/auth/auth.service';
import { CreateOrgUserDto } from '@hookpost/nestjs-libraries/dtos/auth/create.org.user.dto';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { SPENT_FREE_POSTS_WORKSPACE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.repository';

/**
 * What joinWithInvite did. `gone`: the workspace was deleted; `used`:
 * someone joined with this invite already; `unavailable`: its plan has no
 * team members; `full`: every seat is taken; `member`: the user is in it
 * already, and nothing changed.
 */
export type InviteJoin =
  | { joined: true; membership: UserOrganization }
  | {
      joined: false;
      reason: 'gone' | 'member' | 'used' | 'unavailable' | 'full';
    };

@Injectable()
export class OrganizationRepository {
  constructor(
    private _organization: PrismaRepository<'organization'>,
    private _userOrg: PrismaRepository<'userOrganization'>,
    private _user: PrismaRepository<'user'>,
    private _post: PrismaRepository<'post'>,
    private _integration: PrismaRepository<'integration'>,
    private _freePlanChoice: PrismaRepository<'freePlanChoice'>,
    // Both only for the dispute evidence pack (getDisputeEvidenceFacts).
    private _signupAttribution: PrismaRepository<'signupAttribution'>,
    private _notifications: PrismaRepository<'notifications'>
  ) {}

  private freePlanChoiceWarned = false;

  // FreePlanChoice does not exist until free-plan-choice.migration.sql is
  // applied. Until then the choice is not remembered on the server and
  // nothing else changes; said once per process, not on every page load.
  private freePlanChoiceUnavailable(err: unknown) {
    if (!this.freePlanChoiceWarned) {
      this.freePlanChoiceWarned = true;
      Logger.warn(
        `FreePlanChoice is unavailable (apply free-plan-choice.migration.sql): ${
          (err as Error)?.message || err
        }`,
        'OrganizationRepository'
      );
    }
  }

  /** Remembers "Start free". True once it is stored. */
  async chooseFreePlan(organizationId: string): Promise<boolean> {
    try {
      await this._freePlanChoice.model.freePlanChoice.upsert({
        where: { organizationId },
        create: { organizationId },
        update: {},
      });
      return true;
    } catch (err) {
      this.freePlanChoiceUnavailable(err);
      return false;
    }
  }

  async hasChosenFreePlan(organizationId: string): Promise<boolean> {
    try {
      return !!(await this._freePlanChoice.model.freePlanChoice.findUnique({
        where: { organizationId },
        select: { organizationId: true },
      }));
    } catch (err) {
      this.freePlanChoiceUnavailable(err);
      return false;
    }
  }

  /**
   * Whether the workspace has a channel (a placeholder from an unfinished
   * two-step connect does not count) and whether it has a post. Two indexed
   * single-row reads.
   */
  async hasChannelOrPost(
    organizationId: string
  ): Promise<{ channel: boolean; post: boolean }> {
    const [channel, post] = await Promise.all([
      this._integration.model.integration.findFirst({
        where: { organizationId, deletedAt: null, inBetweenSteps: false },
        select: { id: true },
      }),
      this._post.model.post.findFirst({
        where: { organizationId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    return { channel: !!channel, post: !!post };
  }

  // The stored `streakSince` is set when a post publishes and cleared 24h later
  // by a Temporal workflow that sleeps through the whole day. If that workflow
  // is lost - a worker restart, a deploy landing mid-sleep - nothing ever
  // clears it, and the badge counts elapsed days forever whether or not anyone
  // posted. On 2026-09-18 two of the three live streaks were exactly that: org
  // "testing" showed 13 days with its last publish 11 days earlier, and
  // One workspace showed 12 days having published nothing for 12.
  //
  // A streak is a fact about the posting history, so derive it instead of
  // storing it. Returns the first day of the current run of consecutive days
  // with at least one published post, or null when the run is already broken
  // (nothing published today or yesterday).
  async getStreakStart(organizationId: string): Promise<Date | null> {
    const WINDOW_DAYS = 120;
    const since = new Date(Date.now() - WINDOW_DAYS * 86400000);

    const posts = await this._post.model.post.findMany({
      where: {
        organizationId,
        // posted by hand from a "Remind me to post" reminder counts too
        state: { in: ['PUBLISHED', 'POSTED_MANUALLY'] },
        deletedAt: null,
        parentPostId: null,
        publishDate: { gte: since },
      },
      select: { publishDate: true },
      orderBy: { publishDate: 'desc' },
    });

    if (!posts.length) {
      return null;
    }

    const dayKey = (d: Date) => d.toISOString().slice(0, 10);
    const published = new Set(posts.map((p) => dayKey(p.publishDate)));

    const today = new Date();
    // A streak stays alive all of the following day, so it only breaks once a
    // whole day has passed with nothing published.
    let cursor = published.has(dayKey(today))
      ? today
      : new Date(today.getTime() - 86400000);

    if (!published.has(dayKey(cursor))) {
      return null;
    }

    let start = cursor;
    while (true) {
      const previous = new Date(cursor.getTime() - 86400000);
      if (!published.has(dayKey(previous))) {
        break;
      }
      start = previous;
      cursor = previous;
    }

    // midnight UTC of the first day in the run, so the frontend's
    // floor(diff / 1 day) + 1 counts whole days
    return new Date(`${dayKey(start)}T00:00:00.000Z`);
  }

  createMaxUser(id: string, name: string, saasName: string, email: string) {
    return this._organization.model.organization.create({
      select: {
        id: true,
        apiKey: true,
      },
      data: {
        name: name ? `${name}###${id}` : `Unnamed User###${id}`,
        apiKey: AuthService.fixedEncryption(makeId(20)),
        isTrailing: false,
        subscription: {
          create: {
            totalChannels: 1000000,
            subscriptionTier: 'ULTIMATE',
            isLifetime: true,
            period: 'YEARLY',
          },
        },
        users: {
          create: {
            role: Role.SUPERADMIN,
            user: {
              create: {
                activated: true,
                email: email
                  ? email.split('@').join(`+${saasName}@`)
                  : `${saasName}+` + makeId(10) + '@hookpost.invalid',
                name: name ? `${name}###${id}` : `Unnamed User###${id}`,
                providerName: 'LOCAL',
                password: AuthService.hashPassword(makeId(500)),
                timezone: 0,
              },
            },
          },
        },
      },
    });
  }

  async getOrgByApiKey(api: string) {
    // Prisma drops an undefined filter, and deleted workspaces have no key, so
    // an empty value must never reach the query: it would match some other
    // workspace instead of none.
    if (!api) {
      return null;
    }
    return this._organization.model.organization.findFirst({
      where: {
        apiKey: api,
        deletedAt: null,
        // A key works only for a workspace with a member who may use
        // Hookpost: the email-confirmation gate (email.verification.ts).
        users: { some: { disabled: false, user: CAN_USE_HOOKPOST } },
      },
      include: {
        subscription: {
          select: {
            subscriptionTier: true,
            totalChannels: true,
            isLifetime: true,
            // The public API refuses a deleted or lapsed plan (public.auth.middleware.ts).
            deletedAt: true,
            cancelAt: true,
            identifier: true,
          },
        },
      },
    });
  }

  getCount() {
    return this._organization.model.organization.count();
  }

  getSuperAdminUser(orgId: string) {
    return this._userOrg.model.userOrganization.findFirst({
      where: {
        organizationId: orgId,
        disabled: false,
        user: {
          isSuperAdmin: true,
          deletedAt: null,
        },
      },
    });
  }

  // Impersonation target. A deleted account or workspace cannot be entered.
  getUserOrg(id: string) {
    return this._userOrg.model.userOrganization.findFirst({
      where: {
        id,
        user: { deletedAt: null },
        organization: { deletedAt: null },
      },
      select: {
        user: true,
        organization: {
          include: {
            users: {
              select: {
                id: true,
                disabled: true,
                role: true,
                userId: true,
              },
            },
            subscription: {
              select: {
                subscriptionTier: true,
                totalChannels: true,
                isLifetime: true,
              },
            },
          },
        },
      },
    });
  }

  getImpersonateUser(name: string) {
    return this._userOrg.model.userOrganization.findMany({
      where: {
        OR: [
          {
            organizationId: {
              contains: name,
            },
          },
          {
            organization: {
              OR: [
                {
                  paymentId: {
                    equals: name,
                  },
                },
                {
                  subscription: {
                    identifier: {
                      equals: name,
                    },
                  },
                },
                {
                  Integration: {
                    some: {
                      id: name,
                    },
                  },
                },
                {
                  post: {
                    some: {
                      id: name,
                    },
                  },
                },
              ],
            },
          },
          {
            user: {
              OR: [
                {
                  name: {
                    contains: name,
                    mode: 'insensitive',
                  },
                },
                {
                  email: {
                    contains: name,
                    mode: 'insensitive',
                  },
                },
                {
                  id: {
                    contains: name,
                  },
                },
              ],
            },
          },
        ],
      },
      select: {
        id: true,
        role: true,
        disabled: true,
        organization: {
          select: {
            id: true,
            name: true,
            paymentId: true,
            deletedAt: true,
            subscription: {
              select: {
                subscriptionTier: true,
                identifier: true,
                isLifetime: true,
                period: true,
                cancelAt: true,
              },
            },
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            activated: true,
            providerName: true,
            deletedAt: true,
          },
        },
      },
    });
  }

  /**
   * Takes `userId` out of every workspace it joined (any role but
   * SUPERADMIN, which only the account that made a workspace has: invites
   * are USER or ADMIN), whoever else is or is not in it, and answers which.
   * For an account whose address was taken over by its owner: an invite
   * link is not tied to an address, so whoever made the unconfirmed account
   * could have joined it to their own workspace, then left it, so that the
   * account was its only member (re-review of f77349f66).
   */
  async leaveJoinedWorkspaces(userId: string) {
    const memberships = await this._userOrg.model.userOrganization.findMany({
      where: { userId, role: { not: Role.SUPERADMIN } },
      select: {
        id: true,
        organization: { select: { id: true, name: true } },
      },
    });
    if (memberships.length) {
      await this._userOrg.model.userOrganization.deleteMany({
        where: { id: { in: memberships.map((m) => m.id) }, userId },
      });
    }
    return memberships.map((m) => m.organization);
  }

  /** The live workspaces `userId` belongs to that have no other member. */
  async soleMemberOrganizationIds(userId: string) {
    const orgs = await this._organization.model.organization.findMany({
      where: { deletedAt: null, users: { some: { userId } } },
      select: { id: true, _count: { select: { users: true } } },
    });
    return orgs.filter((org) => org._count.users === 1).map((org) => org.id);
  }

  updateApiKey(orgId: string) {
    return this._organization.model.organization.update({
      where: {
        id: orgId,
      },
      data: {
        apiKey: AuthService.fixedEncryption(makeId(20)),
      },
    });
  }

  async getOrgsByUserId(userId: string) {
    return this._organization.model.organization.findMany({
      where: {
        deletedAt: null,
        users: {
          some: {
            userId,
          },
        },
      },
      include: {
        users: {
          where: {
            userId,
          },
          select: {
            disabled: true,
            role: true,
          },
        },
        subscription: {
          select: {
            subscriptionTier: true,
            totalChannels: true,
            isLifetime: true,
            createdAt: true,
          },
        },
      },
    });
  }

  async getOrgById(id: string) {
    return this._organization.model.organization.findUnique({
      where: {
        id,
      },
    });
  }

  getUsersByEmail(email: string) {
    return this._user.model.user.findMany({
      where: {
        email,
      },
    });
  }

  /** The membership row, or false when joinWithInvite refused (see there why). */
  async addUserToOrg(
    userId: string,
    id: string,
    orgId: string,
    role: 'USER' | 'ADMIN'
  ) {
    const result = await this.joinWithInvite(userId, id, orgId, role);
    return 'membership' in result ? result.membership : false;
  }

  /**
   * Whether an invite can still be redeemed: its workspace exists and nobody
   * joined with it yet (User.inviteId). Seats and the plan are checked when
   * it is redeemed, since they can change before then.
   */
  async inviteState(
    inviteId: string,
    orgId: string
  ): Promise<{ open: true; name: string } | { open: false }> {
    const org = await this._organization.model.organization.findFirst({
      where: { id: orgId, deletedAt: null },
      select: { name: true },
    });
    if (!org) {
      return { open: false };
    }
    const used = await this._user.model.user.findFirst({
      where: { inviteId },
      select: { id: true },
    });
    return used ? { open: false } : { open: true, name: org.name };
  }

  /**
   * What the Join question for a signed-in visitor shows
   * (AuthService.pendingInvite), in one read: the workspace's name, whether
   * someone joined with this invite already (User.inviteId), whether
   * `userId` is in that workspace already (any membership, as
   * joinWithInvite counts it), and the name of the member who made the
   * invite (`by`, from the token) while that member is still active there.
   * null when the workspace is gone. Nothing is written.
   */
  async inviteDetails(
    inviteId: string,
    orgId: string,
    userId: string,
    by?: string
  ): Promise<{
    name: string;
    used: boolean;
    member: boolean;
    inviter: string | null;
  } | null> {
    const ids = by && by !== userId ? [userId, by] : [userId];
    const org = await this._organization.model.organization.findFirst({
      where: { id: orgId, deletedAt: null },
      select: {
        name: true,
        users: {
          where: { userId: { in: ids } },
          select: {
            userId: true,
            disabled: true,
            user: { select: { name: true, lastName: true, deletedAt: true } },
          },
        },
      },
    });
    if (!org) {
      return null;
    }
    const used = await this._user.model.user.findFirst({
      where: { inviteId },
      select: { id: true },
    });
    const inviter =
      by && by !== userId
        ? org.users.find(
            (u) => u.userId === by && !u.disabled && !u.user?.deletedAt
          )
        : undefined;
    const inviterName = inviter
      ? [inviter.user?.name, inviter.user?.lastName]
          .filter((part): part is string => typeof part === 'string')
          .join(' ')
          .trim()
      : '';
    return {
      name: org.name,
      used: !!used,
      member: org.users.some((u) => u.userId === userId),
      inviter: inviterName || null,
    };
  }

  /**
   * The single chokepoint for joining a workspace: invite links (at sign-up,
   * sign-in, from the app, and a held invite on email confirmation) and
   * addTeamMemberByEmail all land here, so the plan gate belongs here. It
   * used to reject only STANDARD, which meant a FREE org could add unlimited
   * members through an invite link while a paying STANDARD org could add
   * none, and TEAM/PRO/ULTIMATE had no seat ceiling at all.
   *
   * One transaction, serialized per workspace by an advisory lock (as
   * reserveCredit does for credits): the used-invite check, the seat count
   * and the insert used to be separate statements, so two people opening the
   * same link at once both joined, and two invites into the last seat both
   * took it. A user who is already a member is told so and nothing changes:
   * before, the insert hit the (userId, organizationId) unique key and the
   * request failed with a 500, and an ADMIN invite must never change the
   * role of someone already there (an owner especially).
   */
  async joinWithInvite(
    userId: string,
    inviteId: string,
    orgId: string,
    role: 'USER' | 'ADMIN'
  ): Promise<InviteJoin> {
    // PrismaRepository's model is the whole client (see
    // SubscriptionRepository.getMarketplaceAccountFacts).
    const client = this._userOrg.model as unknown as Pick<
      PrismaService,
      '$transaction'
    >;
    return client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`org-join:${orgId}`}))`;

      const org = await tx.organization.findFirst({
        where: { id: orgId, deletedAt: null },
        select: {
          subscription: { select: { subscriptionTier: true, deletedAt: true } },
          users: { where: { userId }, select: { id: true } },
          _count: { select: { users: true } },
        },
      });
      if (!org) {
        return { joined: false, reason: 'gone' } as const;
      }
      if (org.users.length) {
        return { joined: false, reason: 'member' } as const;
      }

      const used = await tx.user.findFirst({
        where: { inviteId },
        select: { id: true },
      });
      if (used) {
        return { joined: false, reason: 'used' } as const;
      }

      if (process.env.RAZORPAY_KEY_ID) {
        // No subscription row IS the free plan - the Prisma SubscriptionTier
        // enum only has STANDARD/PRO/TEAM/ULTIMATE, so 'FREE' is a pricing
        // key, not an enum member. A workspace that has not started its
        // trial has no row either. A soft-deleted row is no plan (the public
        // API refuses it the same way).
        const live =
          org.subscription && !org.subscription.deletedAt
            ? org.subscription
            : null;
        const tier = (live?.subscriptionTier || 'FREE') as keyof typeof pricing;
        const plan = pricing[tier] || pricing.FREE;

        if (!plan.team_members) {
          return { joined: false, reason: 'unavailable' } as const;
        }
        if ((org._count?.users ?? 0) >= plan.team_member_limit) {
          return { joined: false, reason: 'full' } as const;
        }
      }

      const membership = await tx.userOrganization.create({
        data: {
          role,
          userId,
          organizationId: orgId,
        },
      });

      await tx.user.update({
        where: {
          id: userId,
        },
        data: {
          inviteId,
        },
      });

      return { joined: true, membership } as const;
    });
  }

  /**
   * The emails of users that may be one person's address spelled another way
   * (trial.policy.ts emailIdentity) and belong to a workspace that has had
   * its free posts or a trial or plan (SPENT_FREE_POSTS_WORKSPACE): emails
   * starting with `prefix` at one of `domains`, matched exactly by the
   * caller (a Gmail address can have a dot anywhere, so its prefix is one
   * letter). A deleted user's email is `deleted_<md5 of the address>_<random>`
   * (UsersRepository.deleteAccount), so each of `addresses` is matched in
   * that form too and comes back as the hash.
   */
  emailsWithSpentFreePosts(
    prefix: string,
    domains: string[],
    addresses: string[]
  ) {
    const hash = (value: string) =>
      createHash('md5').update(value).digest('hex');
    return this._user.model.user.findMany({
      where: {
        OR: [
          ...domains.map((domain) => ({
            AND: [
              { email: { startsWith: prefix, mode: 'insensitive' as const } },
              { email: { endsWith: `@${domain}`, mode: 'insensitive' as const } },
            ],
          })),
          ...addresses.map((address) => ({
            email: { startsWith: `deleted_${hash(address)}_` },
          })),
        ],
        organizations: {
          some: { organization: SPENT_FREE_POSTS_WORKSPACE },
        },
      },
      select: { email: true },
    });
  }

  async createOrgAndUser(
    body: Omit<CreateOrgUserDto, 'providerToken'> & { providerId?: string },
    hasEmail: boolean,
    ip: string,
    userAgent: string,
    // False starts the workspace locked: no free posts, no trial
    // (OrganizationService.createOrgAndUser).
    allowTrial = true
  ) {
    return this._organization.model.organization.create({
      data: {
        name: body.company,
        apiKey: AuthService.fixedEncryption(makeId(20)),
        allowTrial,
        isTrailing: true,
        users: {
          create: {
            role: Role.SUPERADMIN,
            user: {
              create: {
                activated: signUpStartsConfirmed(body.provider, hasEmail),
                email: body.email,
                password: body.password
                  ? AuthService.hashPassword(body.password)
                  : '',
                providerName: body.provider,
                providerId: body.providerId || '',
                timezone: 0,
                ip,
                agent: userAgent,
              },
            },
          },
        },
      },
      select: {
        id: true,
        users: {
          select: {
            user: true,
          },
        },
      },
    });
  }

  getOrgByCustomerId(customerId: string) {
    return this._organization.model.organization.findFirst({
      where: {
        paymentId: customerId,
      },
    });
  }

  async setStreak(organizationId: string, type: 'start' | 'end') {
    try {
      await this._organization.model.organization.update({
        where: {
          id: organizationId,
          ...(type === 'start'
            ? {
                streakSince: null,
              }
            : {}),
        },
        data: {
          ...(type === 'end' ? { streakSince: null } : {}),
          ...(type === 'start' ? { streakSince: new Date() } : {}),
        },
      });
    } catch (err) {}
  }

  async getTeam(orgId: string) {
    return this._organization.model.organization.findUnique({
      where: {
        id: orgId,
      },
      select: {
        users: {
          select: {
            role: true,
            user: {
              select: {
                email: true,
                id: true,
                sendSuccessEmails: true,
                sendFailureEmails: true,
                sendStreakEmails: true,
              },
            },
          },
        },
      },
    });
  }

  /**
   * Who a sale is from, for the owner's sale alert (OwnerSalesAlertService):
   * the workspace and its members, oldest membership first (normally whoever
   * created it), with where each signed up from and whether any is a
   * platform super admin, plus the workspace's first-touch
   * SignupAttribution row (null when there is none or that table cannot be
   * read). Null when there is no such workspace.
   */
  async getSaleAlertFacts(orgId: string) {
    const org = await this._organization.model.organization.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        createdAt: true,
        users: {
          orderBy: { createdAt: 'asc' },
          select: {
            role: true,
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                lastName: true,
                signupCountry: true,
                isSuperAdmin: true,
                deletedAt: true,
              },
            },
          },
        },
      },
    });
    if (!org) return null;
    // PrismaRepository's model is the whole client. The table comes from
    // signup-attribution.migration.sql and may be missing on a fresh install.
    const attribution = await (
      this._organization.model as unknown as Pick<PrismaService, 'signupAttribution'>
    ).signupAttribution
      .findUnique({ where: { organizationId: orgId } })
      .catch(() => null);
    return { ...org, attribution };
  }

  getAllUsersOrgs(orgId: string) {
    return this._organization.model.organization.findUnique({
      where: {
        id: orgId,
      },
      select: {
        users: {
          select: {
            user: {
              select: {
                email: true,
                id: true,
                sendSuccessEmails: true,
                sendFailureEmails: true,
              },
            },
          },
        },
      },
    });
  }

  // Everything that lets something act for the workspace ends with it:
  //  - its API key (getOrgByApiKey also ignores deleted workspaces),
  //  - the Approved Apps grants made inside it, revoked and their tokens erased
  //    (the token lookup also refuses them, see OAuthRepository),
  //  - its own developer app, so no new sign-ins and no more tokens for it,
  //  - the third-party API keys it stored (e.g. AI video providers) and old
  //    GitHub tokens, overwritten,
  //  - its RSS auto-posts, switched off so the hourly run stops fetching even
  //    if its Temporal workflow cannot be terminated.
  // The rest of its data is erased by the account purge (account.purge.service).
  deleteOrganization(orgId: string) {
    const now = new Date();
    return this._organization.model.organization.update({
      where: {
        id: orgId,
      },
      data: {
        deletedAt: now,
        apiKey: null,
        oauthAuthorizations: {
          updateMany: [
            { where: { revokedAt: null }, data: { revokedAt: now } },
            { where: {}, data: { accessToken: null, authorizationCode: null } },
          ],
        },
        oauthApp: {
          updateMany: { where: { deletedAt: null }, data: { deletedAt: now } },
        },
        thirdParty: {
          updateMany: { where: {}, data: { apiKey: '', deletedAt: now } },
        },
        github: {
          updateMany: { where: {}, data: { token: '' } },
        },
        autoPost: {
          updateMany: {
            where: { deletedAt: null },
            data: { active: false, deletedAt: now },
          },
        },
      },
    });
  }

  // What Temporal may be running for a workspace, read before it is deleted:
  // its scheduled or repeating root posts (post_<id>), its auto-posts
  // (autopost-<id>) and its channels (refresh_<id>). See
  // UsersService.stopWorkspaceWorkflows.
  getWorkflowSubjects(orgId: string) {
    return this._organization.model.organization.findUnique({
      where: { id: orgId },
      select: {
        post: {
          where: {
            deletedAt: null,
            parentPostId: null,
            OR: [{ state: 'QUEUE' }, { intervalInDays: { not: null } }],
          },
          select: { id: true },
        },
        autoPost: { select: { id: true } },
        Integration: { select: { id: true } },
      },
    });
  }

  setTrialFinished(orgId: string) {
    return this._organization.model.organization.update({
      where: {
        id: orgId,
      },
      data: {
        isTrailing: false,
      },
    });
  }

  /**
   * A bank reported a chargeback on one of this workspace's payments
   * (RazorpayService.handleDispute). `allowTrial` goes with it, so the
   * workspace is `locked` rather than given a trial or free posts
   * (trial.policy.ts), and the clear fields are emptied so a workspace
   * disputed again after a clear is disputed, not cleared.
   *
   * The date is the first dispute's: a second event for the same dispute, or
   * a second dispute, does not move it. Prisma's `updateMany` so a workspace
   * that no longer exists is a no-op (count 0) rather than a throw inside a
   * webhook.
   */
  async markDisputed(
    orgId: string,
    dispute: {
      reason: string;
      paymentId: string;
      at: Date;
      /** The evidence pack as JSON (dispute.evidence.ts), when it was built. */
      evidence?: string | null;
    }
  ) {
    const { count } = await this._organization.model.organization.updateMany({
      where: { id: orgId, disputedAt: null },
      data: {
        disputedAt: dispute.at,
        disputeReason: dispute.reason,
        disputePaymentId: dispute.paymentId,
        disputeClearedAt: null,
        disputeClearedBy: null,
        disputeEvidence: dispute.evidence ?? null,
        allowTrial: false,
      },
    });
    return count > 0;
  }

  /**
   * A super admin clears the dispute, so the workspace may buy again
   * (POST /admin/workspaces/:id/dispute/clear). The reason and the payment
   * stay on the row, with who cleared it and when, as the audit trail.
   * `allowTrial` is not given back: the workspace has had its plan.
   */
  async clearDispute(orgId: string, by: string) {
    const { count } = await this._organization.model.organization.updateMany({
      where: { id: orgId, disputedAt: { not: null } },
      data: {
        disputedAt: null,
        disputeClearedAt: new Date(),
        disputeClearedBy: by,
      },
    });
    return count > 0;
  }

  /** The workspace's dispute fields, for the admin page and the alerts. */
  getDispute(orgId: string) {
    return this._organization.model.organization.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        disputedAt: true,
        disputeReason: true,
        disputePaymentId: true,
        disputeClearedAt: true,
        disputeClearedBy: true,
      },
    });
  }

  /**
   * The evidence pack handleDispute stored (dispute.evidence.ts), as JSON,
   * for the admin download and for the plan a restore gives back. Kept out
   * of getDispute: the page lists every workspace, and this is a document.
   */
  getDisputeEvidence(orgId: string) {
    return this._organization.model.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, disputeEvidence: true },
    });
  }

  /**
   * What the evidence pack says about the customer and what we delivered:
   * the workspace and its owner, where they signed up from, the posts they
   * published since `since` (the paid period), and the messages we sent.
   * Read while the dispute is being handled, so one query per part and no
   * relation the webhook does not need.
   */
  async getDisputeEvidenceFacts(orgId: string, since: Date) {
    const org = await this._organization.model.organization.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        createdAt: true,
        users: {
          where: { role: 'SUPERADMIN' },
          take: 1,
          orderBy: { createdAt: 'asc' },
          select: {
            user: { select: { email: true, signupCountry: true } },
          },
        },
      },
    });
    if (!org) return null;

    const published = {
      organizationId: orgId,
      deletedAt: null as Date | null,
      state: 'PUBLISHED' as const,
      publishDate: { gte: since },
    };
    const [attribution, count, first, last, sample, messages] =
      await Promise.all([
        this._signupAttribution.model.signupAttribution.findUnique({
          where: { organizationId: orgId },
          select: { country: true, method: true, firstSeenAt: true },
        }),
        this._post.model.post.count({ where: published }),
        this._post.model.post.findFirst({
          where: published,
          orderBy: { publishDate: 'asc' },
          select: { publishDate: true },
        }),
        this._post.model.post.findFirst({
          where: published,
          orderBy: { publishDate: 'desc' },
          select: { publishDate: true },
        }),
        this._post.model.post.findMany({
          where: published,
          orderBy: { publishDate: 'desc' },
          take: 50,
          select: {
            publishDate: true,
            releaseURL: true,
            integration: { select: { providerIdentifier: true, name: true } },
          },
        }),
        this._notifications.model.notifications.findMany({
          where: { organizationId: orgId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { createdAt: true, content: true },
        }),
      ]);

    return {
      id: org.id,
      name: org.name,
      createdAt: org.createdAt,
      ownerEmail: org.users?.[0]?.user?.email ?? null,
      signupCountry: org.users?.[0]?.user?.signupCountry ?? null,
      ipCountry: attribution?.country ?? null,
      signupMethod: attribution?.method ?? null,
      firstSeenAt: attribution?.firstSeenAt ?? null,
      posts: {
        since,
        count,
        firstAt: first?.publishDate ?? null,
        lastAt: last?.publishDate ?? null,
        sample: sample.map((p) => ({
          at: p.publishDate,
          channel:
            p.integration?.name || p.integration?.providerIdentifier || 'channel',
          url: p.releaseURL,
        })),
      },
      messages: messages.map((m) => ({ at: m.createdAt, text: m.content })),
    };
  }

  async deleteTeamMember(orgId: string, userId: string) {
    return this._userOrg.model.userOrganization.delete({
      where: {
        userId_organizationId: {
          userId,
          organizationId: orgId,
        },
      },
    });
  }

  disableOrEnableNonSuperAdminUsers(orgId: string, disable: boolean) {
    return this._userOrg.model.userOrganization.updateMany({
      where: {
        organizationId: orgId,
        role: {
          not: Role.SUPERADMIN,
        },
      },
      data: {
        disabled: disable,
      },
    });
  }

  getShortlinkPreference(orgId: string) {
    return this._organization.model.organization.findUnique({
      where: {
        id: orgId,
      },
      select: {
        shortlink: true,
      },
    });
  }

  updateShortlinkPreference(orgId: string, shortlink: ShortLinkPreference) {
    return this._organization.model.organization.update({
      where: {
        id: orgId,
      },
      data: {
        shortlink,
      },
    });
  }

  /**
   * Texts that hold the workspace's own links, for the AI post generator: its
   * signatures (the auto-added one first) and the website on its active
   * members' agency profiles. A workspace has no website field of its own.
   */
  async getLinkSources(orgId: string): Promise<string[]> {
    const org = await this._organization.model.organization.findFirst({
      where: { id: orgId, deletedAt: null },
      select: {
        signatures: {
          where: { deletedAt: null },
          orderBy: [{ autoAdd: 'desc' }, { createdAt: 'asc' }],
          select: { content: true },
        },
        users: {
          where: { disabled: false, user: { deletedAt: null } },
          orderBy: { createdAt: 'asc' },
          select: {
            user: {
              select: { agencies: { select: { website: true, deletedAt: true } } },
            },
          },
        },
      },
    });
    if (!org) return [];

    const websites = org.users.flatMap(({ user }) => {
      const website = user.agencies?.deletedAt ? '' : user.agencies?.website?.trim();
      if (!website) return [];
      // "acme.co.za" has no scheme and an ending the link finder does not
      // know on a bare domain; with the scheme it is found whatever the ending.
      return [/^https?:\/\//i.test(website) ? website : `https://${website}`];
    });
    return [...org.signatures.map((s) => s.content), ...websites];
  }
}
