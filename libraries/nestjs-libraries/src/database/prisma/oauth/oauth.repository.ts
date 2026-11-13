import { Injectable } from '@nestjs/common';
import { CAN_USE_HOOKPOST } from '@hookpost/nestjs-libraries/services/email.verification';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@hookpost/nestjs-libraries/database/prisma/prisma.service';

// An authorization code or access token is only good while everything it was
// granted for still exists: the user, the workspace, the app, and the app's own
// workspace when it has one (dynamic MCP clients have none). Deleting an
// account only marks those rows deleted, and accounts deleted before the
// deletion started revoking tokens kept theirs, so this filter is what closes
// them. Tokens never expire, so there is no other check behind it.
const liveAuthorization: Prisma.OAuthAuthorizationWhereInput = {
  revokedAt: null,
  user: { deletedAt: null },
  organization: { deletedAt: null },
  oauthApp: {
    deletedAt: null,
    OR: [{ organizationId: null }, { organization: { deletedAt: null } }],
  },
};

@Injectable()
export class OAuthRepository {
  constructor(
    private _oauthApp: PrismaRepository<'oAuthApp'>,
    private _oauthAuth: PrismaRepository<'oAuthAuthorization'>
  ) {}

  getAppByOrgId(orgId: string) {
    return this._oauthApp.model.oAuthApp.findFirst({
      where: {
        organizationId: orgId,
        deletedAt: null,
      },
      include: {
        picture: true,
      },
    });
  }

  // A developer app belongs to a workspace; once that workspace is deleted the
  // app can no longer start a sign-in or exchange a code.
  getAppByClientId(clientId: string) {
    return this._oauthApp.model.oAuthApp.findFirst({
      where: {
        clientId,
        deletedAt: null,
        OR: [{ organizationId: null }, { organization: { deletedAt: null } }],
      },
      include: {
        picture: true,
      },
    });
  }

  createApp(
    orgId: string,
    data: {
      name: string;
      description?: string;
      pictureId?: string;
      redirectUrl: string;
      clientId: string;
      clientSecret: string;
    }
  ) {
    return this._oauthApp.model.oAuthApp.create({
      data: {
        organizationId: orgId,
        name: data.name,
        description: data.description,
        pictureId: data.pictureId,
        redirectUrl: data.redirectUrl,
        clientId: data.clientId,
        clientSecret: data.clientSecret,
      },
      include: {
        picture: true,
      },
    });
  }

  createDynamicApp(data: {
    name: string;
    redirectUrl: string;
    redirectUris: string;
    clientId: string;
    clientSecret?: string;
    tokenEndpointAuthMethod: string;
  }) {
    return this._oauthApp.model.oAuthApp.create({
      data: {
        name: data.name,
        redirectUrl: data.redirectUrl,
        redirectUris: data.redirectUris,
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        tokenEndpointAuthMethod: data.tokenEndpointAuthMethod,
        dynamic: true,
      },
    });
  }

  // Dynamic clients register before the consent screen, so abandoned flows
  // leave orphan rows; prune the ones no user ever authorized
  deleteStaleDynamicApps(olderThan: Date) {
    return this._oauthApp.model.oAuthApp.deleteMany({
      where: {
        dynamic: true,
        createdAt: { lt: olderThan },
        authorizations: { none: {} },
      },
    });
  }

  async updateApp(
    orgId: string,
    data: {
      name?: string;
      description?: string;
      pictureId?: string;
      redirectUrl?: string;
    }
  ) {
    const app = await this._oauthApp.model.oAuthApp.findFirst({
      where: {
        organizationId: orgId,
        deletedAt: null,
      },
    });
    if (!app) {
      return null;
    }
    return this._oauthApp.model.oAuthApp.update({
      where: { id: app.id },
      data,
      include: {
        picture: true,
      },
    });
  }

  async deleteApp(orgId: string) {
    const app = await this._oauthApp.model.oAuthApp.findFirst({
      where: {
        organizationId: orgId,
        deletedAt: null,
      },
    });
    if (!app) {
      return null;
    }
    return this._oauthApp.model.oAuthApp.update({
      where: { id: app.id },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async updateClientSecret(orgId: string, newSecret: string) {
    const app = await this._oauthApp.model.oAuthApp.findFirst({
      where: {
        organizationId: orgId,
        deletedAt: null,
      },
    });
    if (!app) {
      return null;
    }
    return this._oauthApp.model.oAuthApp.update({
      where: { id: app.id },
      data: {
        clientSecret: newSecret,
      },
    });
  }

  createAuthorization(data: {
    oauthAppId: string;
    userId: string;
    organizationId: string;
    authorizationCode: string;
    codeExpiresAt: Date;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    redirectUri?: string;
  }) {
    return this._oauthAuth.model.oAuthAuthorization.upsert({
      where: {
        oauthAppId_userId_organizationId: {
          oauthAppId: data.oauthAppId,
          userId: data.userId,
          organizationId: data.organizationId,
        },
      },
      create: {
        oauthAppId: data.oauthAppId,
        userId: data.userId,
        organizationId: data.organizationId,
        authorizationCode: data.authorizationCode,
        codeExpiresAt: data.codeExpiresAt,
        codeChallenge: data.codeChallenge || null,
        codeChallengeMethod: data.codeChallengeMethod || null,
        redirectUri: data.redirectUri || null,
      },
      update: {
        authorizationCode: data.authorizationCode,
        codeExpiresAt: data.codeExpiresAt,
        codeChallenge: data.codeChallenge || null,
        codeChallengeMethod: data.codeChallengeMethod || null,
        redirectUri: data.redirectUri || null,
        accessToken: null,
        revokedAt: null,
      },
    });
  }

  async findByCode(encryptedCode: string) {
    if (!encryptedCode) {
      return null;
    }
    return this._oauthAuth.model.oAuthAuthorization.findFirst({
      where: {
        authorizationCode: encryptedCode,
        ...liveAuthorization,
      },
    });
  }

  /**
   * The client_id of the public (PKCE-only) dynamic client a live code was
   * issued to, or null: for a token request that left client_id out.
   */
  async publicClientIdForCode(encryptedCode: string) {
    if (!encryptedCode) {
      return null;
    }
    const authorization = await this._oauthAuth.model.oAuthAuthorization.findFirst({
      where: {
        AND: [
          { authorizationCode: encryptedCode },
          liveAuthorization,
          { oauthApp: { dynamic: true, tokenEndpointAuthMethod: 'none' } },
        ],
      },
      select: { oauthApp: { select: { clientId: true } } },
    });
    return authorization?.oauthApp.clientId ?? null;
  }

  exchangeCodeForToken(id: string, encryptedToken: string) {
    return this._oauthAuth.model.oAuthAuthorization.update({
      where: { id },
      select: {
        organizationId: true,
      },
      data: {
        accessToken: encryptedToken,
        authorizationCode: null,
        codeExpiresAt: null,
        codeChallenge: null,
        codeChallengeMethod: null,
        redirectUri: null,
      },
    });
  }

  async findByAccessToken(encryptedToken: string) {
    if (!encryptedToken) {
      return null;
    }
    const authorization = await this._oauthAuth.model.oAuthAuthorization.findFirst({
      where: {
        accessToken: encryptedToken,
        ...liveAuthorization,
        // The user who approved the app must be one who may use Hookpost:
        // the email-confirmation gate (email.verification.ts).
        user: CAN_USE_HOOKPOST,
      },
      include: {
        oauthApp: {
          select: {
            clientId: true,
          },
        },
        organization: {
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
        },
        user: {
          select: {
            id: true,
            email: true,
            activated: true,
            organizations: {
              where: { disabled: false },
              select: { organizationId: true },
            },
          },
        },
      },
    });

    // Same rule as a signed-in session (AuthMiddleware): only the workspaces
    // the user is still an enabled member of. Prisma cannot compare two
    // columns of the row in `where`, so this one is checked here. It stops the
    // token of a member who was removed from the workspace.
    if (
      !authorization ||
      !authorization.user.organizations.some(
        (membership) =>
          membership.organizationId === authorization.organizationId
      )
    ) {
      return null;
    }

    return authorization;
  }

  getApprovedApps(userId: string) {
    return this._oauthAuth.model.oAuthAuthorization.findMany({
      where: {
        userId,
        revokedAt: null,
        accessToken: { not: null },
        // An app that was deleted, or whose workspace was, no longer works.
        oauthApp: liveAuthorization.oauthApp,
      },
      include: {
        oauthApp: {
          include: {
            picture: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  /**
   * Revokes the user's own approval. Answers false when the user has no
   * approval with that id (someone else's, or none at all): update() would
   * throw P2025 there, which surfaced as a 500.
   */
  async revokeAuthorization(userId: string, authId: string) {
    const { count } = await this._oauthAuth.model.oAuthAuthorization.updateMany({
      where: {
        id: authId,
        userId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    if (count) {
      return true;
    }
    // Already revoked is still the user's own: revoking again succeeds.
    return !!(await this._oauthAuth.model.oAuthAuthorization.findFirst({
      where: { id: authId, userId },
      select: { id: true },
    }));
  }

  revokeAllForApp(oauthAppId: string) {
    return this._oauthAuth.model.oAuthAuthorization.updateMany({
      where: {
        oauthAppId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }
}
