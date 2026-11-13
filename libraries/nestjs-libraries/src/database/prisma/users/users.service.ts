import { HttpException, Injectable, Logger } from '@nestjs/common';
import { UsersRepository } from '@hookpost/nestjs-libraries/database/prisma/users/users.repository';
import { Provider, Role } from '@prisma/client';
import { UserDetailDto } from '@hookpost/nestjs-libraries/dtos/users/user.details.dto';
import { EmailNotificationsDto } from '@hookpost/nestjs-libraries/dtos/users/email-notifications.dto';
import { OrganizationRepository } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.repository';
import { IntegrationRepository } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.repository';
import { NotificationService } from '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service';
import { AffiliateService } from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service';
import { loginChangedEmail } from '@hookpost/nestjs-libraries/emails/templates/auth.emails';
import { TemporalService } from 'nestjs-temporal-core';
import { organizationId as organizationIdAttribute } from '@hookpost/nestjs-libraries/temporal/temporal.search.attribute';

/** Per call, and for one workspace in total, so a Temporal outage cannot hang the request. */
const WORKFLOW_CALL_TIMEOUT_MS = 5000;
const WORKFLOW_STOP_BUDGET_MS = 20000;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });

// Terminating a workflow that already finished answers NOT_FOUND.
const isNotRunning = (err: any) =>
  err?.name === 'WorkflowNotFoundError' ||
  /not found|already completed/i.test(String(err?.message || ''));

export interface StoppedWorkflows {
  stopped: string[];
  notRunning: number;
  failed: string[];
}

@Injectable()
export class UsersService {
  constructor(
    private _usersRepository: UsersRepository,
    private _organizationRepository: OrganizationRepository,
    private _integrationRepository: IntegrationRepository,
    private _notificationService: NotificationService,
    private _affiliateService: AffiliateService,
    private _temporalService: TemporalService
  ) {}

  private readonly _logger = new Logger(UsersService.name);

  getUserByEmail(email: string) {
    return this._usersRepository.getUserByEmail(email);
  }

  getUserById(id: string) {
    return this._usersRepository.getUserById(id);
  }

  // User.lastOnline was never written anywhere, so it equalled createdAt for
  // every account and nobody could tell who came back. /user/self (every
  // signed-in page load) calls this; one database write an hour per person.
  private _lastOnlineWrites = new Map<string, number>();
  static readonly LAST_ONLINE_GAP_MS = 60 * 60 * 1000;

  async markOnline(id: string, now = new Date()) {
    const gap = UsersService.LAST_ONLINE_GAP_MS;
    const last = this._lastOnlineWrites.get(id);
    if (last !== undefined && now.getTime() - last < gap) {
      return;
    }
    if (this._lastOnlineWrites.size > 10000) {
      this._lastOnlineWrites.clear();
    }
    this._lastOnlineWrites.set(id, now.getTime());
    try {
      await this._usersRepository.markOnline(id, now, gap);
    } catch (e) {
      this._logger.warn(`lastOnline not updated: ${(e as Error)?.message}`);
    }
  }

  recordSignupGeo(id: string, geo: { country?: string; region?: string; city?: string }) {
    return this._usersRepository.recordSignupGeo(id, geo);
  }

  getUserByEmailAnyProvider(email: string) {
    return this._usersRepository.getUserByEmailAnyProvider(email);
  }

  activateWithVerifiedEmail(id: string) {
    return this._usersRepository.activateWithVerifiedEmail(id);
  }

  getUserWithActiveSubscriptionByEmail(email: string, excludeUserId: string) {
    return this._usersRepository.getUserWithActiveSubscriptionByEmail(
      email,
      excludeUserId
    );
  }

  getImpersonateUser(name: string) {
    return this._organizationRepository.getImpersonateUser(name);
  }

  getUserByProvider(providerId: string, provider: Provider) {
    return this._usersRepository.getUserByProvider(providerId, provider);
  }

  async switchUser(
    currentUserId: string,
    targetUserId: string,
    adminId: string
  ) {
    const { kept, switched } =
      await this._usersRepository.switchUserCredentials(
        currentUserId,
        targetUserId
      );

    this._logger.log(
      `User login switch performed by admin ${adminId}: account ${
        kept.id
      } login ${switched.email} -> ${kept.email}; account ${
        switched.id
      } login ${kept.email} -> ${switched.email}`
    );

    // Security notice to every address involved, old and new. It used to go
    // to each account's NEW address only, so no mailbox was ever told that the
    // account it had signed in to had moved away from it. In a swap the two
    // addresses trade places, so one email per address covers both changes.
    // The swap is already committed; a notification failure must not fail it.
    if (this._notificationService.hasEmailProvider()) {
      const changes = [
        { from: switched.email, to: kept.email }, // account `kept.id`
        { from: kept.email, to: switched.email }, // account `switched.id`
      ];
      const recipients = Array.from(
        new Set(changes.flatMap((c) => [c.from, c.to]).map((e) => e.toLowerCase()))
      );
      await Promise.all(
        recipients.map(async (recipient) => {
          try {
            const message = loginChangedEmail({ changes, recipient });
            await this._notificationService.sendEmail(
              recipient,
              message.subject,
              message.html
            );
          } catch (err) {
            this._logger.error(`Failed to notify ${recipient}`, err);
          }
        })
      );
    }

    return { kept, switched };
  }

  async getOrgsToDeleteForAccount(userId: string) {
    const orgs = await this._organizationRepository.getOrgsByUserId(userId);
    const ownedOrgs = orgs.filter(
      (org) => org.users[0].role === Role.SUPERADMIN
    );

    for (const org of ownedOrgs) {
      const team = await this._organizationRepository.getTeam(org.id);
      if (team?.users?.some((member) => member.user.id !== userId)) {
        throw new HttpException(
          'Please remove your team members before deleting your account',
          400
        );
      }
    }

    return ownedOrgs;
  }

  async deleteAccount(userId: string) {
    const deletedOrgs = await this.getOrgsToDeleteForAccount(userId);
    const orgs = await this._organizationRepository.getOrgsByUserId(userId);
    const workflowIds = new Map<string, string[]>();

    for (const org of orgs) {
      if (org.users[0].role === Role.SUPERADMIN) {
        // Read what Temporal runs for the workspace before its rows are
        // marked deleted.
        workflowIds.set(org.id, await this.workspaceWorkflowIds(org.id));
        await this._integrationRepository.deleteIntegrationsForAccount(org.id);
        await this._organizationRepository.deleteOrganization(org.id);
      } else {
        await this._organizationRepository.deleteTeamMember(org.id, userId);
      }
    }

    await this._affiliateService.deactivateForDeletedAccount(userId);
    await this._usersRepository.deleteAccount(userId);

    // After the rows, so a workflow that wakes up in between already finds
    // its post or channel gone (getPost and getPostsList refuse deleted ones).
    // Never throws: the account is deleted either way.
    for (const [orgId, ids] of workflowIds) {
      const result = await this.stopWorkspaceWorkflows(orgId, ids);
      if (result.failed.length) {
        this._logger.error(
          `ACCOUNT_DELETION_WORKFLOWS_NOT_STOPPED workspace ${orgId}: ${result.failed.join(', ')}`
        );
      }
      this._logger.log(
        `Workspace ${orgId}: stopped ${result.stopped.length} workflow(s), ${result.notRunning} not running, ${result.failed.length} failed`
      );
    }

    this._logger.log(
      `Account ${userId} deleted, organizations removed: ${deletedOrgs
        .map((org) => org.id)
        .join(', ')}`
    );

    return { deletedOrgs };
  }

  /**
   * Workflow ids Temporal may be running for a workspace. Each one is started
   * elsewhere with a fixed id:
   *   post_<postId>                      PostsService.startWorkflow, PostActivity
   *   autopost-<id>                      AutopostService.processCron (hourly)
   *   refresh_<integrationId>            RefreshIntegrationService.startRefreshWorkflow
   *                                      (Instagram standalone, Threads)
   *   streak_<orgId>                     PostActivity (after a publish)
   *   digest_email_workflow_<orgId>      NotificationService.inAppNotification
   */
  async workspaceWorkflowIds(orgId: string) {
    const subjects = await this._organizationRepository.getWorkflowSubjects(
      orgId
    );
    return [
      ...(subjects?.post || []).map((p) => `post_${p.id}`),
      ...(subjects?.autoPost || []).map((a) => `autopost-${a.id}`),
      ...(subjects?.Integration || []).map((i) => `refresh_${i.id}`),
      `streak_${orgId}`,
      `digest_email_workflow_${orgId}`,
    ];
  }

  /**
   * Terminates a deleted workspace's workflows: the fixed ids above, then
   * anything else still running with its organizationId search attribute.
   * That attribute is a TEXT (full-text) field, so a listed run is only
   * terminated when its value is exactly this workspace. Best effort and
   * bounded in time: what could not be stopped is returned (and logged by the
   * caller) and the workflows' own checks keep them from publishing.
   */
  async stopWorkspaceWorkflows(
    orgId: string,
    ids: string[]
  ): Promise<StoppedWorkflows> {
    const result: StoppedWorkflows = { stopped: [], notRunning: 0, failed: [] };
    let client: any;
    try {
      client = this._temporalService?.client?.getRawClient();
    } catch (err) {
      client = null;
    }
    if (!client) {
      result.failed.push(...ids);
      return result;
    }

    const reason = `Account deleted: workspace ${orgId}`;
    const deadline = Date.now() + WORKFLOW_STOP_BUDGET_MS;
    const seen = new Set<string>();
    const terminate = async (workflowId: string) => {
      seen.add(workflowId);
      try {
        await withTimeout(
          client.workflow.getHandle(workflowId).terminate(reason),
          WORKFLOW_CALL_TIMEOUT_MS
        );
        result.stopped.push(workflowId);
      } catch (err) {
        if (isNotRunning(err)) {
          result.notRunning++;
        } else {
          result.failed.push(workflowId);
        }
      }
    };

    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 10) {
      if (Date.now() > deadline) {
        result.failed.push(...unique.slice(i));
        return result;
      }
      await Promise.all(unique.slice(i, i + 10).map(terminate));
    }

    try {
      const listing = client.workflow.list({
        query: `organizationId="${orgId}" AND ExecutionStatus="Running"`,
      });
      const iterator = listing[Symbol.asyncIterator]();
      while (Date.now() <= deadline) {
        const next = await withTimeout<IteratorResult<any>>(
          iterator.next(),
          WORKFLOW_CALL_TIMEOUT_MS
        );
        if (next.done) {
          break;
        }
        const execution = next.value;
        if (
          seen.has(execution.workflowId) ||
          execution.typedSearchAttributes?.get(organizationIdAttribute) !==
            orgId
        ) {
          continue;
        }
        await terminate(execution.workflowId);
      }
    } catch (err) {
      this._logger.warn(
        `Workspace ${orgId}: could not list its running workflows: ${
          (err as Error)?.message || err
        }`
      );
    }

    return result;
  }

  activateUser(id: string) {
    return this._usersRepository.activateUser(id);
  }

  activatePendingUser(id: string) {
    return this._usersRepository.activatePendingUser(id);
  }

  changeUnverifiedEmail(id: string, email: string) {
    return this._usersRepository.changeUnverifiedEmail(id, email);
  }

  updatePassword(id: string, password: string) {
    return this._usersRepository.updatePassword(id, password);
  }

  getPersonal(userId: string) {
    return this._usersRepository.getPersonal(userId);
  }

  changePersonal(userId: string, body: UserDetailDto) {
    return this._usersRepository.changePersonal(userId, body);
  }

  getEmailNotifications(userId: string) {
    return this._usersRepository.getEmailNotifications(userId);
  }

  updateEmailNotifications(userId: string, body: EmailNotificationsDto) {
    return this._usersRepository.updateEmailNotifications(userId, body);
  }
}
