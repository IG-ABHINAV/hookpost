import { PrismaRepository } from '@hookpost/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { IntegrationTimeDto } from '@hookpost/nestjs-libraries/dtos/integrations/integration.time.dto';
import { UploadFactory } from '@hookpost/nestjs-libraries/upload/upload.factory';
import { PlugDto } from '@hookpost/nestjs-libraries/dtos/plugs/plug.dto';

@Injectable()
export class IntegrationRepository {
  private storage = UploadFactory.createStorage();
  constructor(
    private _integration: PrismaRepository<'integration'>,
    private _posts: PrismaRepository<'post'>,
    private _plugs: PrismaRepository<'plugs'>,
    private _exisingPlugData: PrismaRepository<'exisingPlugData'>,
    private _customers: PrismaRepository<'customer'>,
    private _mentions: PrismaRepository<'mentions'>,
    private _signupAttribution: PrismaRepository<'signupAttribution'>
  ) {}

  /**
   * SignupAttribution.firstChannelAt, the first time the workspace has a real
   * channel (connect-first funnel: sign-up, first channel, trial). Called
   * where a channel row becomes real: a one-step connect's save, and the page
   * pick that turns a two-step placeholder into a channel. Only the first
   * time counts. Never fails the save: until
   * signup-attribution-first-channel.migration.sql is applied (or for a
   * workspace with no SignupAttribution row) nothing is written.
   */
  private async markFirstChannel(organizationId?: string | null) {
    if (!organizationId) return;
    try {
      await this._signupAttribution.model.signupAttribution.updateMany({
        where: { organizationId, firstChannelAt: null },
        data: { firstChannelAt: new Date() },
      });
    } catch (err) {
      console.warn(
        'SignupAttribution.firstChannelAt not recorded:',
        (err as Error)?.message?.split('\n')[0]
      );
    }
  }

  getMentions(platform: string, q: string) {
    return this._mentions.model.mentions.findMany({
      where: {
        platform,
        OR: [
          {
            name: {
              contains: q,
              mode: 'insensitive',
            },
          },
          {
            username: {
              contains: q,
              mode: 'insensitive',
            },
          },
        ],
      },
      orderBy: {
        name: 'asc',
      },
      take: 100,
      select: {
        name: true,
        username: true,
        image: true,
      },
    });
  }

  insertMentions(
    platform: string,
    mentions: { name: string; username: string; image: string }[]
  ) {
    if (mentions.length === 0) {
      return [] as any[];
    }
    return this._mentions.model.mentions.createMany({
      data: mentions.map((mention) => ({
        platform,
        name: mention.name,
        username: mention.username,
        image: mention.image,
      })),
      skipDuplicates: true,
    });
  }

  async checkPreviousConnections(org: string, id: string) {
    // Deleted accounts keep their integrations with an md5 hashed
    // rootInternalId, so match both the raw id and its hash to still catch
    // channels that were connected by a deleted account.
    const findIt = await this._integration.model.integration.findMany({
      where: {
        rootInternalId: {
          in: [id, createHash('md5').update(id).digest('hex')],
        },
      },
      select: {
        organizationId: true,
        id: true,
      },
    });

    if (findIt.some((f) => f.organizationId === org)) {
      return false;
    }

    if (findIt.length === 0) {
      return false;
    }

    // If the same user/team owns both organizations, allow reconnecting without blocking
    try {
      const userOrgDelegate = (this._integration.model as any).userOrganization;
      if (userOrgDelegate) {
        const currentOrgUsers = await userOrgDelegate.findMany({
          where: { organizationId: org, disabled: false },
          select: { userId: true },
        });
        const userIds = currentOrgUsers.map((u: any) => u.userId);

        if (userIds.length > 0) {
          const previousOrgIds = findIt.map((f) => f.organizationId);
          const sharedUser = await userOrgDelegate.findFirst({
            where: {
              organizationId: { in: previousOrgIds },
              userId: { in: userIds },
            },
          });
          if (sharedUser) {
            return false;
          }
        }
      }
    } catch (e) {}

    return true;
  }

  updateProviderSettings(org: string, id: string, settings: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        additionalSettings: settings,
      },
    });
  }

  async setTimes(org: string, id: string, times: IntegrationTimeDto) {
    return this._integration.model.integration.update({
      select: {
        id: true,
      },
      where: {
        id,
        organizationId: org,
      },
      data: {
        postingTimes: JSON.stringify(times.time),
      },
    });
  }

  getPlug(plugId: string) {
    return this._plugs.model.plugs.findFirst({
      where: {
        id: plugId,
      },
      include: {
        integration: true,
      },
    });
  }

  async getPlugs(orgId: string, integrationId: string) {
    return this._plugs.model.plugs.findMany({
      where: {
        integrationId,
        organizationId: orgId,
        activated: true,
      },
      include: {
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
          },
        },
      },
    });
  }

  async updateIntegration(id: string, params: Partial<Integration>) {
    if (
      params.picture &&
      (params.picture.indexOf(process.env.CLOUDFLARE_BUCKET_URL!) === -1 ||
        params.picture.indexOf(process.env.FRONTEND_URL!) === -1)
    ) {
      params.picture = await this.storage.uploadSimple(params.picture);
    }

    const existing = await this._integration.model.integration.findUnique({
      where: {
        organizationId_internalId: {
          organizationId: params.organizationId!,
          internalId: params.internalId,
        },
      },
    });

    if (existing) {
      await this._posts.model.post.updateMany({
        where: {
          integrationId: id,
        },
        data: {
          deletedAt: new Date(),
        },
      });

      await this._integration.model.integration.update({
        where: {
          id,
        },
        data: {
          internalId: `deleted_${params.internalId}_${makeId(10)}`,
          deletedAt: new Date(),
        },
      });
    }

    const updated = await this._integration.model.integration.update({
      where: {
        ...(existing ? { id: existing.id } : { id }),
      },
      data: {
        ...params,
        disabled: false,
        deletedAt: null,
      },
    });

    // The page pick that finishes a two-step connect.
    if (params.inBetweenSteps === false) {
      await this.markFirstChannel(updated.organizationId);
    }

    return updated;
  }

  disconnectChannel(org: string, id: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        refreshNeeded: true,
      },
    });
  }

  getIntegrationByInternalId(org: string, internalId: string) {
    return this._integration.model.integration.findFirst({
      where: {
        organizationId: org,
        internalId,
        deletedAt: null,
      },
    });
  }

  // Moves a channel to another provider in place (MIGRATE_PROVIDERS): only the
  // provider and the app-scoped ids change, so the integration id - and with it
  // scheduled posts, settings and customers - survives the migration. The
  // follow-up createOrUpdateIntegration upsert matches the new internalId and
  // stores the fresh tokens.
  async migrateIntegration(
    org: string,
    id: string,
    internalId: string,
    providerIdentifier: string,
    rootInternalId: string
  ) {
    // A soft-deleted channel can still hold the target internalId
    // (deleteChannel keeps it): rename it out of the way like updateIntegration
    // does, otherwise the organizationId_internalId unique constraint rejects
    // the migration. Live channels are rejected by the service before this.
    const existing = await this._integration.model.integration.findUnique({
      where: {
        organizationId_internalId: {
          organizationId: org,
          internalId,
        },
      },
    });

    if (existing && existing.deletedAt) {
      await this._integration.model.integration.update({
        where: {
          id: existing.id,
        },
        data: {
          internalId: `deleted_${internalId}_${makeId(10)}`,
        },
      });
    }

    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        internalId,
        providerIdentifier,
        rootInternalId,
      },
    });
  }

  async createOrUpdateIntegration(
    additionalSettings:
      | {
          title: string;
          description: string;
          type: 'checkbox' | 'text' | 'textarea';
          value: any;
          regex?: string;
        }[]
      | undefined,
    oneTimeToken: boolean,
    org: string,
    name: string,
    picture: string | undefined,
    type: 'article' | 'social',
    internalId: string,
    provider: string,
    token: string,
    refreshToken = '',
    expiresIn = 999999999,
    username?: string,
    isBetweenSteps = false,
    refresh?: string,
    timezone?: number,
    customInstanceDetails?: string,
    rootInternalId?: string
  ) {
    const postTimes = timezone
      ? {
          postingTimes: JSON.stringify([
            { time: 560 - timezone },
            { time: 850 - timezone },
            { time: 1140 - timezone },
          ]),
        }
      : {};
    const upsert = await this._integration.model.integration.upsert({
      where: {
        organizationId_internalId: {
          internalId,
          organizationId: org,
        },
      },
      create: {
        type: type as any,
        name,
        providerIdentifier: provider,
        token,
        profile: username,
        ...(picture ? { picture } : {}),
        inBetweenSteps: isBetweenSteps,
        refreshToken,
        ...(expiresIn
          ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
          : {}),
        internalId,
        ...postTimes,
        organizationId: org,
        refreshNeeded: false,
        rootInternalId: rootInternalId || internalId,
        ...(customInstanceDetails ? { customInstanceDetails } : {}),
        additionalSettings: additionalSettings
          ? JSON.stringify(additionalSettings)
          : '[]',
      },
      update: {
        ...(additionalSettings
          ? { additionalSettings: JSON.stringify(additionalSettings) }
          : {}),
        ...(customInstanceDetails ? { customInstanceDetails } : {}),
        type: type as any,
        ...(!refresh
          ? {
              inBetweenSteps: isBetweenSteps,
            }
          : {}),
        ...(picture ? { picture } : {}),
        profile: username,
        providerIdentifier: provider,
        token,
        refreshToken,
        ...(expiresIn
          ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
          : {}),
        internalId,
        organizationId: org,
        deletedAt: null,
        refreshNeeded: false,
        ...(rootInternalId ? { rootInternalId } : {}),
      },
    });

    // A one-step connect saved a real channel (a two-step login only saved
    // its placeholder; the page pick marks it in updateIntegration).
    if (!isBetweenSteps) {
      await this.markFirstChannel(org);
    }

    if (oneTimeToken) {
      const rootId =
        (
          await this._integration.model.integration.findFirst({
            where: {
              organizationId: org,
              internalId: internalId,
            },
          })
        )?.rootInternalId || internalId;

      // Removed channels keep their hashed tokens (deleteChannel), so a
      // refresh of a sibling channel must not write fresh ones back.
      await this._integration.model.integration.updateMany({
        where: {
          id: {
            not: upsert.id,
          },
          rootInternalId: rootId,
          deletedAt: null,
        },
        data: {
          token,
          refreshToken,
          refreshNeeded: false,
          ...(expiresIn
            ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
            : {}),
        },
      });
    }

    return upsert;
  }

  needsToBeRefreshed() {
    return this._integration.model.integration.findMany({
      where: {
        tokenExpiration: {
          lte: dayjs().add(1, 'day').toDate(),
        },
        inBetweenSteps: false,
        deletedAt: null,
        refreshNeeded: false,
      },
    });
  }

  async setBetweenRefreshSteps(id: string) {
    return this._integration.model.integration.update({
      where: {
        id,
      },
      data: {
        inBetweenSteps: true,
      },
    });
  }
  refreshNeeded(org: string, id: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        refreshNeeded: true,
      },
    });
  }

  updateNameAndUrl(id: string, name: string, url: string) {
    return this._integration.model.integration.update({
      where: {
        id,
      },
      data: {
        ...(name ? { name } : {}),
        ...(url ? { picture: url } : {}),
      },
    });
  }

  getIntegrationById(org: string, id: string) {
    return this._integration.model.integration.findFirst({
      where: {
        organizationId: org,
        id,
      },
    });
  }

  async getIntegrationForOrder(
    id: string,
    order: string,
    user: string,
    org: string
  ) {
    const integration = await this._posts.model.post.findFirst({
      where: {
        integrationId: id,
        submittedForOrder: {
          id: order,
          messageGroup: {
            OR: [
              { sellerId: user },
              { buyerId: user },
              { buyerOrganizationId: org },
            ],
          },
        },
      },
      select: {
        integration: {
          select: {
            id: true,
            name: true,
            picture: true,
            inBetweenSteps: true,
            providerIdentifier: true,
          },
        },
      },
    });

    return integration?.integration;
  }

  async updateOnCustomerName(org: string, id: string, name: string) {
    const customer = !name
      ? undefined
      : (await this._customers.model.customer.findFirst({
          where: {
            orgId: org,
            name,
          },
        })) ||
        (await this._customers.model.customer.create({
          data: {
            name,
            orgId: org,
          },
        }));

    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        customer: !customer
          ? { disconnect: true }
          : {
              connect: {
                id: customer.id,
              },
            },
      },
    });
  }

  updateIntegrationGroup(org: string, id: string, group: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: !group
        ? {
            customer: {
              disconnect: true,
            },
          }
        : {
            customer: {
              connect: {
                id: group,
              },
            },
          },
    });
  }

  customers(orgId: string) {
    return this._customers.model.customer.findMany({
      where: {
        orgId,
        deletedAt: null,
      },
    });
  }

  getIntegrationsList(org: string) {
    return this._integration.model.integration.findMany({
      where: {
        organizationId: org,
        deletedAt: null,
      },
      include: {
        customer: true,
      },
    });
  }

  async disableChannel(org: string, id: string) {
    await this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        disabled: true,
      },
    });
  }

  async enableChannel(org: string, id: string) {
    await this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        disabled: false,
      },
    });
  }

  getPostsForChannel(org: string, id: string) {
    return this._posts.model.post.groupBy({
      by: ['group'],
      where: {
        organizationId: org,
        integrationId: id,
        deletedAt: null,
      },
    });
  }

  /**
   * Candidates for the placeholder sweep: rows of a two-step provider
   * (`providers`: Facebook, Instagram, YouTube...) still in between steps and
   * untouched since `before`. A new login to the same account updates the
   * row, so a connect in progress is never one of them. Bounded: the sweep
   * runs again a few hours later.
   *
   * inBetweenSteps alone does not mean "never finished": a token refresh that
   * throws while publishing sets it on a live channel (setBetweenRefreshSteps).
   * That only happens while a post goes out, so a row with any post, deleted
   * ones included, is never a candidate. IntegrationService also checks the
   * rows it returns (unfinished.connect.ts).
   */
  getStalePlaceholders(before: Date, providers: string[]) {
    return this._integration.model.integration.findMany({
      where: {
        inBetweenSteps: true,
        deletedAt: null,
        providerIdentifier: { in: providers },
        posts: { none: {} },
        createdAt: { lt: before },
        OR: [{ updatedAt: null }, { updatedAt: { lt: before } }],
      },
      select: {
        id: true,
        organizationId: true,
        providerIdentifier: true,
        internalId: true,
        rootInternalId: true,
      },
      take: 500,
    });
  }

  // The row stays (its posts and history point at it), but its tokens are
  // overwritten with a one-way hash, like deleteIntegrationsForAccount does.
  // Reconnecting the channel stores fresh tokens through the upsert.
  async deleteChannel(org: string, id: string) {
    const hash = (value: string) =>
      createHash('md5').update(value).digest('hex');

    const integration = await this._integration.model.integration.findFirst({
      where: {
        id,
        organizationId: org,
      },
    });

    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        deletedAt: new Date(),
        ...(integration
          ? {
              token: hash(integration.token),
              refreshToken: integration.refreshToken
                ? hash(integration.refreshToken)
                : null,
              // Password-based providers keep their real credentials here.
              ...(integration.customInstanceDetails
                ? { customInstanceDetails: hash(integration.customInstanceDetails) }
                : {}),
            }
          : {}),
      },
    });
  }

  /**
   * Live channels that one platform account connected (a Meta data-deletion or
   * deauthorize callback names the account, not the channels).
   *
   * A channel matches when its own id or its root id is that account: a page
   * picked after a Facebook login keeps the login's user id in rootInternalId.
   * Pages 2..N of a multi-page selection used to be saved with their own page
   * id as root (fixed in saveProviderPage), so for those rows the link is the
   * login's long-lived token, which the selection copied into every page's
   * refreshToken: a row in the same workspace and provider holding the same
   * refreshToken as a matched row came from the same login. A removed root
   * keeps that token only as an md5 hash (deleteChannel), so both forms are
   * compared. Best effort for old rows: a root that was reconnected later
   * (new token) or wiped with its account can no longer vouch for its pages.
   */
  async getChannelsConnectedByAccount(providers: string[], accountId: string) {
    if (!accountId || !providers.length) {
      return [];
    }
    const hash = (value: string) =>
      createHash('md5').update(value).digest('hex');

    const roots = await this._integration.model.integration.findMany({
      where: {
        providerIdentifier: { in: providers },
        OR: [{ internalId: accountId }, { rootInternalId: accountId }],
      },
      select: {
        id: true,
        organizationId: true,
        providerIdentifier: true,
        refreshToken: true,
        deletedAt: true,
      },
    });

    const found = new Map<string, { id: string; organizationId: string }>();
    for (const root of roots) {
      if (!root.deletedAt) {
        found.set(root.id, { id: root.id, organizationId: root.organizationId });
      }
    }

    for (const root of roots) {
      if (!root.refreshToken) {
        continue;
      }
      const siblings = await this._integration.model.integration.findMany({
        where: {
          organizationId: root.organizationId,
          providerIdentifier: root.providerIdentifier,
          deletedAt: null,
          id: { not: root.id },
          refreshToken: { not: null },
        },
        select: { id: true, organizationId: true, refreshToken: true },
      });
      for (const sibling of siblings) {
        if (
          sibling.refreshToken &&
          (sibling.refreshToken === root.refreshToken ||
            hash(sibling.refreshToken) === root.refreshToken)
        ) {
          found.set(sibling.id, {
            id: sibling.id,
            organizationId: sibling.organizationId,
          });
        }
      }
    }

    return [...found.values()];
  }

  /**
   * After deleteChannel, for a platform data-deletion request: the profile the
   * platform gave us (name, username, picture link, ids) is overwritten too,
   * the way deleteIntegrationsForAccount does it. The root id keeps its md5
   * form, which is all checkPreviousConnections compares. The internal id gets
   * a random suffix because the same channel can be connected and removed
   * again in the same workspace, and (organizationId, internalId) is unique.
   */
  async eraseRemovedChannelProfile(org: string, id: string) {
    const hash = (value: string) =>
      createHash('md5').update(value).digest('hex');

    const integration = await this._integration.model.integration.findFirst({
      where: { id, organizationId: org, deletedAt: { not: null } },
    });
    if (!integration) {
      return null;
    }

    return this._integration.model.integration.update({
      where: { id, organizationId: org },
      data: {
        name: hash(integration.name),
        internalId: `deleted_${hash(integration.internalId)}_${makeId(10)}`,
        rootInternalId: integration.rootInternalId
          ? hash(integration.rootInternalId)
          : null,
        profile: integration.profile ? hash(integration.profile) : null,
        picture: null,
      },
    });
  }

  // Token refresh for a live channel. Unlike the upsert in
  // createOrUpdateIntegration it never clears deletedAt, so a removal that
  // lands while the provider call is in flight stays a removal.
  async updateRefreshedTokens(
    org: string,
    internalId: string,
    oneTimeToken: boolean,
    token: string,
    refreshToken = '',
    expiresIn = 999999999
  ) {
    const data = {
      token,
      refreshToken,
      refreshNeeded: false,
      tokenExpiration: new Date(Date.now() + expiresIn * 1000),
    };

    const { count } = await this._integration.model.integration.updateMany({
      where: { organizationId: org, internalId, deletedAt: null },
      data,
    });

    if (!count || !oneTimeToken) {
      return count;
    }

    const current = await this._integration.model.integration.findFirst({
      where: { organizationId: org, internalId },
    });

    await this._integration.model.integration.updateMany({
      where: {
        id: { not: current!.id },
        rootInternalId: current!.rootInternalId || internalId,
        deletedAt: null,
      },
      data,
    });

    return count;
  }

  async deleteIntegrationsForAccount(org: string) {
    const hash = (value: string) =>
      createHash('md5').update(value).digest('hex');

    await this._posts.model.post.updateMany({
      where: {
        organizationId: org,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    const integrations = await this._integration.model.integration.findMany({
      where: {
        organizationId: org,
      },
    });

    // md5 is deterministic, so a hashed rootInternalId can still be matched
    // by checkPreviousConnections when the same channel is connected again
    // from a new account.
    for (const integration of integrations) {
      await this._integration.model.integration.update({
        where: {
          id: integration.id,
        },
        data: {
          name: hash(integration.name),
          internalId: hash(integration.internalId),
          rootInternalId: integration.rootInternalId
            ? hash(integration.rootInternalId)
            : null,
          token: hash(integration.token),
          refreshToken: integration.refreshToken
            ? hash(integration.refreshToken)
            : null,
          profile: integration.profile ? hash(integration.profile) : null,
          customInstanceDetails: integration.customInstanceDetails
            ? hash(integration.customInstanceDetails)
            : null,
          picture: null,
          deletedAt: integration.deletedAt || new Date(),
        },
      });
    }
  }

  async checkForDeletedOnceAndUpdate(org: string, page: string) {
    return this._integration.model.integration.updateMany({
      where: {
        organizationId: org,
        internalId: page,
        deletedAt: {
          not: null,
        },
      },
      data: {
        internalId: makeId(10),
      },
    });
  }

  async disableIntegrations(org: string, totalChannels: number) {
    const getChannels = await this._integration.model.integration.findMany({
      where: {
        organizationId: org,
        disabled: false,
        deletedAt: null,
      },
      take: totalChannels,
      select: {
        id: true,
      },
    });

    for (const channel of getChannels) {
      await this._integration.model.integration.update({
        where: {
          id: channel.id,
        },
        data: {
          disabled: true,
        },
      });
    }
  }

  getPlugsByIntegrationId(org: string, id: string) {
    return this._plugs.model.plugs.findMany({
      where: {
        organizationId: org,
        integrationId: id,
      },
    });
  }

  createOrUpdatePlug(org: string, integrationId: string, body: PlugDto) {
    return this._plugs.model.plugs.upsert({
      where: {
        organizationId: org,
        plugFunction_integrationId: {
          integrationId,
          plugFunction: body.func,
        },
      },
      create: {
        integrationId,
        organizationId: org,
        plugFunction: body.func,
        data: JSON.stringify(body.fields),
        activated: true,
      },
      update: {
        data: JSON.stringify(body.fields),
      },
      select: {
        activated: true,
      },
    });
  }

  changePlugActivation(orgId: string, plugId: string, status: boolean) {
    return this._plugs.model.plugs.update({
      where: {
        organizationId: orgId,
        id: plugId,
      },
      data: {
        activated: !!status,
      },
    });
  }

  async loadExisingData(
    methodName: string,
    integrationId: string,
    id: string[]
  ) {
    return this._exisingPlugData.model.exisingPlugData.findMany({
      where: {
        integrationId,
        methodName,
        value: {
          in: id,
        },
      },
    });
  }

  async saveExisingData(
    methodName: string,
    integrationId: string,
    value: string[]
  ) {
    return this._exisingPlugData.model.exisingPlugData.createMany({
      data: value.map((p) => ({
        integrationId,
        methodName,
        value: p,
      })),
    });
  }

  async getPostingTimes(orgId: string, integrationsId?: string) {
    return this._integration.model.integration.findMany({
      where: {
        ...(integrationsId ? { id: integrationsId } : {}),
        organizationId: orgId,
        disabled: false,
        deletedAt: null,
      },
      select: {
        postingTimes: true,
      },
    });
  }
}
