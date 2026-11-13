import {
  PrismaRepository,
  PrismaTransaction,
} from '@hookpost/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { Provider, Role } from '@prisma/client';
import { AuthService } from '@hookpost/helpers/auth/auth.service';
import { UserDetailDto } from '@hookpost/nestjs-libraries/dtos/users/user.details.dto';
import { EmailNotificationsDto } from '@hookpost/nestjs-libraries/dtos/users/email-notifications.dto';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';

@Injectable()
export class UsersRepository {
  constructor(
    private _user: PrismaRepository<'user'>,
    private _transaction: PrismaTransaction
  ) {}

  async switchUserCredentials(currentUserId: string, targetUserId: string) {
    const current = await this._user.model.user.findUnique({
      where: { id: currentUserId },
    });
    const target = await this._user.model.user.findUnique({
      where: { id: targetUserId },
    });

    if (!current || !target) {
      throw new Error('User not found');
    }

    const currentCredentials = {
      email: current.email,
      password: current.password,
      providerName: current.providerName,
      providerId: current.providerId,
      account: current.account,
      connectedAccount: current.connectedAccount,
      activated: current.activated,
    };
    const targetCredentials = {
      email: target.email,
      password: target.password,
      providerName: target.providerName,
      providerId: target.providerId,
      account: target.account,
      connectedAccount: target.connectedAccount,
      activated: target.activated,
    };

    // (email, providerName) is unique and checked per-statement, so park the
    // current user on a throwaway email first, then fill each freed slot
    await this._transaction.model.$transaction([
      this._user.model.user.update({
        where: { id: current.id },
        data: { email: `switch-${makeId(10)}-${current.email}` },
      }),
      this._user.model.user.update({
        where: { id: target.id },
        data: currentCredentials,
      }),
      this._user.model.user.update({
        where: { id: current.id },
        data: targetCredentials,
      }),
    ]);

    return {
      kept: { id: current.id, email: targetCredentials.email },
      switched: { id: target.id, email: currentCredentials.email },
    };
  }

  getImpersonateUser(name: string) {
    return this._user.model.user.findMany({
      where: {
        deletedAt: null,
        OR: [
          {
            name: {
              contains: name,
            },
          },
          {
            email: {
              contains: name,
            },
          },
          {
            id: {
              contains: name,
            },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
      },
      take: 10,
    });
  }

  /**
   * lastOnline = now, unless it was already set within `minGapMs`: at most one
   * write an hour per person, and the filter makes every other call a no-op.
   * Never on a deleted account (/user/self fires it without waiting).
   */
  markOnline(id: string, now: Date, minGapMs: number) {
    return this._user.model.user.updateMany({
      where: {
        id,
        deletedAt: null,
        lastOnline: { lt: new Date(now.getTime() - minGapMs) },
      },
      data: { lastOnline: now },
    });
  }

  /**
   * Sets the sign-up location once: rows that already have one are left alone.
   * Never on a deleted account: the auth middleware fires this without waiting,
   * so on the very request that deletes an account the write can land after
   * deleteAccount has cleared the location.
   */
  recordSignupGeo(id: string, geo: { country?: string; region?: string; city?: string }) {
    return this._user.model.user.updateMany({
      where: { id, signupGeoAt: null, deletedAt: null },
      data: {
        signupCountry: geo.country || null,
        signupRegion: geo.region || null,
        signupCity: geo.city || null,
        signupGeoAt: new Date(),
      },
    });
  }

  getUserById(id: string) {
    return this._user.model.user.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });
  }

  getUserByEmail(email: string) {
    return this._user.model.user.findFirst({
      where: {
        email: {
          equals: (email || '').trim(),
          mode: 'insensitive',
        },
        providerName: Provider.LOCAL,
        deletedAt: null,
      },
      include: {
        picture: {
          select: {
            id: true,
            path: true,
          },
        },
      },
    });
  }

  // One email, one account: registration and OAuth sign-in look an email up
  // across LOCAL and every provider before they create anyone. Oldest first,
  // so accounts that were duplicated before this rule resolve the same way
  // every time.
  getUserByEmailAnyProvider(email: string) {
    return this._user.model.user.findFirst({
      where: {
        email: {
          equals: (email || '').trim(),
          mode: 'insensitive',
        },
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  // A provider has just verified the email of a password account that never
  // confirmed it. Activate it and drop the unconfirmed password, so whoever
  // typed that password cannot sign in to the account the mailbox owner now
  // uses. The owner can still set one through Forgot password.
  activateWithVerifiedEmail(id: string) {
    return this._user.model.user.updateMany({
      where: {
        id,
        providerName: Provider.LOCAL,
        activated: false,
      },
      data: {
        activated: true,
        password: '',
      },
    });
  }

  getUserWithActiveSubscriptionByEmail(email: string, excludeUserId: string) {
    return this._user.model.user.findFirst({
      where: {
        email,
        id: { not: excludeUserId },
        deletedAt: null,
        organizations: {
          some: {
            role: Role.SUPERADMIN,
            organization: {
              subscription: { is: { deletedAt: null } },
            },
          },
        },
      },
      select: { id: true, email: true, providerName: true },
    });
  }

  /**
   * A password account that has not confirmed its email moves to another
   * address, for a typo at sign-up. Only while it is unconfirmed: a confirmed
   * address is only changed by an admin (switchUserCredentials). False when
   * the row is no longer such an account. Another account already on the
   * address fails the (email, providerName) unique index (P2002).
   */
  async changeUnverifiedEmail(id: string, email: string) {
    const { count } = await this._user.model.user.updateMany({
      where: {
        id,
        providerName: Provider.LOCAL,
        activated: false,
        deletedAt: null,
      },
      data: { email },
    });
    return count === 1;
  }

  /**
   * Confirms the account if it is not confirmed yet, in one statement, and
   * answers whether this call did it. Of two requests racing on the same
   * link, only one sees true.
   */
  async activatePendingUser(id: string) {
    const { count } = await this._user.model.user.updateMany({
      where: { id, activated: false, deletedAt: null },
      data: { activated: true },
    });
    return count === 1;
  }

  activateUser(id: string) {
    return this._user.model.user.update({
      where: {
        id,
      },
      data: {
        activated: true,
      },
    });
  }

  getUserByProvider(providerId: string, provider: Provider) {
    return this._user.model.user.findFirst({
      where: {
        providerId,
        providerName: provider,
        deletedAt: null,
      },
    });
  }

  async deleteAccount(userId: string) {
    const user = await this._user.model.user.findUnique({
      where: {
        id: userId,
      },
    });

    if (!user || user.deletedAt) {
      return;
    }

    const hash = (value: string) =>
      createHash('md5').update(value).digest('hex');
    const now = new Date();

    // Hash the identifying fields instead of removing the row, the random
    // suffix keeps [email, providerName] unique if the same email is deleted
    // more than once.
    //
    // Every personal column on User must be named here, either cleared or
    // hashed. The ones left alone on purpose are id, providerName (half of the
    // unique key), isSuperAdmin, audience, timezone (a number, not nullable),
    // inviteId (an opaque id), the three email-preference flags and the
    // timestamps. users.repository.spec.ts fails when a column is added to the
    // User model without being listed there or here, which is how the sign-up
    // location was missed.
    return this._user.model.user.update({
      where: {
        id: userId,
      },
      data: {
        email: `deleted_${hash(user.email.toLowerCase())}_${makeId(5)}`,
        password: null,
        name: user.name ? hash(user.name) : null,
        lastName: user.lastName ? hash(user.lastName) : null,
        providerId: user.providerId ? hash(user.providerId) : null,
        bio: null,
        ip: null,
        agent: null,
        account: null,
        pictureId: null,
        signupCountry: null,
        signupRegion: null,
        signupCity: null,
        signupGeoAt: null,
        deletedAt: now,
        // Approved Apps (OAuth and MCP connections). The token lookup
        // (OAuthRepository) also refuses tokens of deleted users and
        // workspaces; this erases the tokens themselves.
        oauthAuthorizations: {
          updateMany: [
            { where: { revokedAt: null }, data: { revokedAt: now } },
            { where: {}, data: { accessToken: null, authorizationCode: null } },
          ],
        },
      },
    });
  }

  updatePassword(id: string, password: string) {
    return this._user.model.user.update({
      where: {
        id,
        providerName: Provider.LOCAL,
      },
      data: {
        password: AuthService.hashPassword(password),
      },
    });
  }

  changeAudienceSize(userId: string, audience: number) {
    return this._user.model.user.update({
      where: {
        id: userId,
      },
      data: {
        audience,
      },
    });
  }

  async getPersonal(userId: string) {
    const user = await this._user.model.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
        name: true,
        bio: true,
        picture: {
          select: {
            id: true,
            path: true,
          },
        },
      },
    });

    return user;
  }

  async changePersonal(userId: string, body: UserDetailDto) {
    await this._user.model.user.update({
      where: {
        id: userId,
      },
      data: {
        name: body.fullname,
        bio: body.bio,
        picture: body.picture
          ? {
              connect: {
                id: body.picture.id,
              },
            }
          : {
              disconnect: true,
            },
      },
    });
  }

  async getEmailNotifications(userId: string) {
    return this._user.model.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        sendSuccessEmails: true,
        sendFailureEmails: true,
        sendStreakEmails: true,
      },
    });
  }

  async updateEmailNotifications(userId: string, body: EmailNotificationsDto) {
    await this._user.model.user.update({
      where: {
        id: userId,
      },
      data: {
        sendSuccessEmails: body.sendSuccessEmails,
        sendFailureEmails: body.sendFailureEmails,
        sendStreakEmails: body.sendStreakEmails,
      },
    });
  }
}
