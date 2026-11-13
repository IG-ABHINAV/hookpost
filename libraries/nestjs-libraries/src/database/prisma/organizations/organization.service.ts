import { CreateOrgUserDto } from '@hookpost/nestjs-libraries/dtos/auth/create.org.user.dto';
import {
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationRepository } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.repository';
import { NotificationService } from '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service';
import { AddTeamMemberDto } from '@hookpost/nestjs-libraries/dtos/settings/add.team.member.dto';
import { AdminAddTeamMemberDto } from '@hookpost/nestjs-libraries/dtos/settings/admin.add.team.member.dto';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { AuthService, TOKEN_PURPOSE } from '@hookpost/helpers/auth/auth.service';
import dayjs from 'dayjs';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { Organization, ShortLinkPreference, User } from '@prisma/client';
import { AutopostService } from '@hookpost/nestjs-libraries/database/prisma/autopost/autopost.service';
import { teamInviteEmail } from '@hookpost/nestjs-libraries/emails/templates/auth.emails';
import { invitePath } from '@hookpost/helpers/auth/team.invite';
import {
  emailIdentity,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { disposableEmail } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/disposable.email';

@Injectable()
export class OrganizationService {
  constructor(
    private _organizationRepository: OrganizationRepository,
    private _notificationsService: NotificationService
  ) {}
  async createOrgAndUser(
    body: Omit<CreateOrgUserDto, 'providerToken'> & { providerId?: string },
    ip: string,
    userAgent: string
  ) {
    return this._organizationRepository.createOrgAndUser(
      body,
      this._notificationsService.hasEmailProvider(),
      ip,
      userAgent,
      await this.signupGetsFreePosts(body.email)
    );
  }

  /**
   * Whether a new sign-up's workspace starts with its free posts
   * (allowTrial true) or locked (trial.policy.ts "free posts are given
   * once"): not from a disposable email service, nor for someone already in
   * a workspace that has had its free posts or a trial or plan under another
   * spelling of the same address (emailIdentity), nor for the address of a
   * deleted account that had. The sign-up itself always goes ahead; a lookup
   * that fails gives the free posts, as before.
   */
  async signupGetsFreePosts(email: string | null | undefined) {
    if (disposableEmail(email)) return false;
    const identity = emailIdentity(email);
    if (!identity) return true;
    const [local, domain] = identity.split('@');
    const gmail = domain === 'gmail.com';
    try {
      const users = await this._organizationRepository.emailsWithSpentFreePosts(
        gmail ? local.slice(0, 1) : local,
        gmail ? ['gmail.com', 'googlemail.com'] : [domain],
        [...new Set([(email || '').trim().toLowerCase(), identity])]
      );
      // A deleted account's email has no @: it was matched by its hash.
      return !users.some(
        (u) => !u.email.includes('@') || emailIdentity(u.email) === identity
      );
    } catch (err) {
      Logger.warn(
        `Free posts given to a sign-up without the email check: ${
          (err as Error)?.message || err
        }`,
        'OrganizationService'
      );
      return true;
    }
  }

  async getCount() {
    return this._organizationRepository.getCount();
  }

  async createMaxUser(
    id: string,
    name: string,
    saasName: string,
    email: string
  ) {
    return this._organizationRepository.createMaxUser(
      id,
      name,
      saasName,
      email
    );
  }

  addUserToOrg(
    userId: string,
    id: string,
    orgId: string,
    role: 'USER' | 'ADMIN'
  ) {
    return this._organizationRepository.addUserToOrg(userId, id, orgId, role);
  }

  /** Joins with an invite, or says why not (OrganizationRepository.joinWithInvite). */
  joinWithInvite(
    userId: string,
    inviteId: string,
    orgId: string,
    role: 'USER' | 'ADMIN'
  ) {
    return this._organizationRepository.joinWithInvite(
      userId,
      inviteId,
      orgId,
      role
    );
  }

  /** Whether an invite can still be redeemed, and its workspace's name. */
  inviteState(inviteId: string, orgId: string) {
    return this._organizationRepository.inviteState(inviteId, orgId);
  }

  /** What the Join question shows (OrganizationRepository.inviteDetails). */
  inviteDetails(inviteId: string, orgId: string, userId: string, by?: string) {
    return this._organizationRepository.inviteDetails(inviteId, orgId, userId, by);
  }

  getOrgById(id: string) {
    return this._organizationRepository.getOrgById(id);
  }

  getOrgByApiKey(api: string) {
    return this._organizationRepository.getOrgByApiKey(api);
  }

  async hasSuperAdminUser(orgId: string) {
    return !!(await this._organizationRepository.getSuperAdminUser(orgId));
  }

  getUserOrg(id: string) {
    return this._organizationRepository.getUserOrg(id);
  }

  getOrgsByUserId(userId: string) {
    return this._organizationRepository.getOrgsByUserId(userId);
  }

  updateApiKey(orgId: string) {
    return this._organizationRepository.updateApiKey(orgId);
  }

  /**
   * The owner of an address has just taken over a password account that was
   * never confirmed (Google sign-in or a reset link on that address).
   * Whoever typed that password used the account meanwhile, so:
   *  - it leaves every workspace it joined, however many members it has: an
   *    invite link is not tied to an address, so it could have been joined
   *    to the typist's own (paid) workspace, which sign-in would then prefer,
   *    and the typist could have left it first;
   *  - the workspaces only it is in get a new API key, in case the typist
   *    copied the old one.
   * Its sessions end on their own: the password changed or was dropped.
   * Answers the workspaces it left ({id, name}) and those it renewed.
   */
  async secureTakenOverAccount(userId: string) {
    const left = await this._organizationRepository.leaveJoinedWorkspaces(
      userId
    );
    const rotated = await this._organizationRepository.soleMemberOrganizationIds(
      userId
    );
    for (const id of rotated) {
      await this._organizationRepository.updateApiKey(id);
    }
    return { left, rotated };
  }

  getTeam(orgId: string) {
    return this._organizationRepository.getTeam(orgId);
  }

  async setStreak(organizationId: string, type: 'start' | 'end') {
    return this._organizationRepository.setStreak(organizationId, type);
  }

  /**
   * "Start free" on the plans screen, stored on the server so the plans
   * screen stays away on every browser and phone, not only the one that
   * pressed it. `hasChannels` tells the page whether to open the "Connect
   * your channels" onboarding next.
   */
  async chooseFreePlan(organizationId: string) {
    const [saved, { channel }] = await Promise.all([
      this._organizationRepository.chooseFreePlan(organizationId),
      this._organizationRepository.hasChannelOrPost(organizationId),
    ]);
    return { saved, hasChannels: channel };
  }

  /**
   * Whether a Free workspace skips the full-screen plans screen: it chose
   * Free before, on any device, or it already has a channel or a post (it
   * got past the plans screen once, whatever the browser remembers).
   */
  async skipsPlansScreen(organizationId: string) {
    if (await this._organizationRepository.hasChosenFreePlan(organizationId)) {
      return true;
    }
    const { channel, post } =
      await this._organizationRepository.hasChannelOrPost(organizationId);
    return channel || post;
  }

  async getStreakStart(organizationId: string) {
    return this._organizationRepository.getStreakStart(organizationId);
  }

  getOrgByCustomerId(customerId: string) {
    return this._organizationRepository.getOrgByCustomerId(customerId);
  }

  async inviteTeamMember(
    org: Organization,
    user: User,
    body: AddTeamMemberDto
  ) {
    // This used to mint an invite URL with no plan check at all, so a FREE org
    // could hand out links all day; redemption then silently failed (or, before
    // the addUserToOrg fix, silently succeeded). Fail here instead, with a
    // reason, rather than sending someone a link that cannot work.
    if (process.env.RAZORPAY_KEY_ID) {
      const tier = ((org as any)?.subscription?.subscriptionTier ||
        'FREE') as keyof typeof pricing;
      const plan = pricing[tier] || pricing.FREE;

      if (!plan.team_members) {
        throw new HttpException(
          'The organization plan does not include team members',
          400
        );
      }

      const team = await this._organizationRepository.getTeam(org.id);
      if ((team?.users?.length ?? 0) >= plan.team_member_limit) {
        throw new HttpException(
          `Your plan includes ${plan.team_member_limit} seats and they are all in use. Upgrade to add more members.`,
          400
        );
      }
    }

    // Its own key and only the fields an invite needs. It used to be a
    // JWT_SECRET token of the whole request body, so any extra field the admin
    // sent was signed too, and other endpoints took it as their own token.
    const timeLimit = dayjs().add(2, 'day').format('YYYY-MM-DD HH:mm:ss');
    const id = makeId(5);
    const token = AuthService.signPurposeJWT(
      TOKEN_PURPOSE.TEAM_INVITE,
      {
        ...(typeof body.email === 'string' ? { email: body.email } : {}),
        role: body.role,
        orgId: org.id,
        timeLimit,
        id,
        // Who made it: the Join question a signed-in invitee answers names
        // them ("You were invited by ..."), while they are still a member.
        by: user.id,
      },
      { expiresIn: '2d' }
    );
    // /invite/<token>, never /?org=<token>: Cloudflare caches "/" with the
    // query string ignored, so a signed-out invitee got the homepage and the
    // invite was lost (team.invite.ts).
    const url = process.env.FRONTEND_URL + invitePath(token);
    if (body.sendEmail) {
      const invite = teamInviteEmail({
        inviterName: user.name,
        inviterEmail: user.email,
        orgName: org.name,
        inviteUrl: url,
        expiresInDays: 2,
      });
      await this._notificationsService.sendEmail(
        body.email,
        invite.subject,
        invite.html
      );
    }
    return { url };
  }

  async addTeamMemberByEmail(org: Organization, body: AdminAddTeamMemberDto) {
    const tier =
      // @ts-ignore
      org?.subscription?.subscriptionTier ||
      (!process.env.RAZORPAY_KEY_ID ? 'ULTIMATE' : 'FREE');

    if (!pricing[tier].team_members) {
      throw new HttpException(
        'The organization plan does not include team members',
        400
      );
    }

    // Surface the seat ceiling here so the UI can say why. addUserToOrg
    // enforces it again at the DB level for the invite-link path.
    const seats = pricing[tier].team_member_limit;
    const team = await this._organizationRepository.getTeam(org.id);
    if ((team?.users?.length ?? 0) >= seats) {
      throw new HttpException(
        `Your plan includes ${seats} seats and they are all in use. Upgrade to add more members.`,
        400
      );
    }

    const users = await this._organizationRepository.getUsersByEmail(
      body.email
    );
    if (!users.length) {
      throw new HttpException('No Hookpost account found for this email', 400);
    }

    if (users.length > 1) {
      throw new HttpException(
        'Multiple accounts exist for this email (different login providers)',
        400
      );
    }

    const [user] = users;

    const userOrgs = await this._organizationRepository.getOrgsByUserId(
      user.id
    );
    if (userOrgs.some((current) => current.id === org.id)) {
      throw new HttpException(
        'User is already a member of this organization',
        400
      );
    }

    const added = await this._organizationRepository.addUserToOrg(
      user.id,
      makeId(5),
      org.id,
      body.role as 'USER' | 'ADMIN'
    );

    if (!added) {
      throw new HttpException(
        'Could not add the user to the organization',
        400
      );
    }

    return { added: true };
  }

  async deleteTeamMember(org: Organization, userId: string) {
    const userOrgs = await this._organizationRepository.getOrgsByUserId(userId);
    const findOrgToDelete = userOrgs.find((orgUser) => orgUser.id === org.id);
    // HttpExceptions, not plain Errors: the exception filter cannot serialise
    // a plain Error ("Converting circular structure to JSON"), so a refusal
    // used to reach the Teams page as a 500.
    if (!findOrgToDelete) {
      throw new NotFoundException('User is not part of this organization');
    }

    // @ts-ignore
    const myRole = org.users[0].role;
    const userRole = findOrgToDelete.users[0].role;
    const myLevel = myRole === 'USER' ? 0 : myRole === 'ADMIN' ? 1 : 2;
    const userLevel = userRole === 'USER' ? 0 : userRole === 'ADMIN' ? 1 : 2;

    if (myLevel < userLevel) {
      throw new ForbiddenException(
        'You do not have permission to delete this user'
      );
    }

    return this._organizationRepository.deleteTeamMember(org.id, userId);
  }

  disableOrEnableNonSuperAdminUsers(orgId: string, disable: boolean) {
    return this._organizationRepository.disableOrEnableNonSuperAdminUsers(
      orgId,
      disable
    );
  }

  getShortlinkPreference(orgId: string) {
    return this._organizationRepository.getShortlinkPreference(orgId);
  }

  updateShortlinkPreference(orgId: string, shortlink: ShortLinkPreference) {
    return this._organizationRepository.updateShortlinkPreference(
      orgId,
      shortlink
    );
  }

  setTrialFinished(orgId: string) {
    return this._organizationRepository.setTrialFinished(orgId);
  }

  /**
   * The workspace's payment dispute (trial.policy.ts workspaceDisputed):
   * mark it when a bank reports a chargeback, clear it when a super admin
   * decides to let the workspace buy again, read it for the admin page.
   */
  markDisputed(
    orgId: string,
    dispute: {
      reason: string;
      paymentId: string;
      at: Date;
      evidence?: string | null;
    }
  ) {
    return this._organizationRepository.markDisputed(orgId, dispute);
  }

  clearDispute(orgId: string, by: string) {
    return this._organizationRepository.clearDispute(orgId, by);
  }

  getDispute(orgId: string) {
    return this._organizationRepository.getDispute(orgId);
  }

  /** The stored evidence pack (dispute.evidence.ts), as JSON. */
  getDisputeEvidence(orgId: string) {
    return this._organizationRepository.getDisputeEvidence(orgId);
  }

  /** What goes into a new evidence pack: the customer and what we delivered. */
  getDisputeEvidenceFacts(orgId: string, since: Date) {
    return this._organizationRepository.getDisputeEvidenceFacts(orgId, since);
  }

  /** Texts holding the workspace's own links (signatures, agency website). */
  getLinkSources(orgId: string) {
    return this._organizationRepository.getLinkSources(orgId);
  }
}
