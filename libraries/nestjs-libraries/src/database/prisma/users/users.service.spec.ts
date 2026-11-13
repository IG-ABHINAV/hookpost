import 'reflect-metadata';
import { TypedSearchAttributes } from '@temporalio/common';

// Only injection tokens; the real modules open database, Redis and Temporal
// connections.
jest.mock('@hookpost/nestjs-libraries/database/prisma/users/users.repository', () => ({
  UsersRepository: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.repository',
  () => ({ OrganizationRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.repository',
  () => ({ IntegrationRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service',
  () => ({ NotificationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service',
  () => ({ AffiliateService: class {} })
);
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));

import { Role } from '@prisma/client';
import { UsersService } from '@hookpost/nestjs-libraries/database/prisma/users/users.service';
import { organizationId as organizationIdAttribute } from '@hookpost/nestjs-libraries/temporal/temporal.search.attribute';

class WorkflowNotFoundError extends Error {
  name = 'WorkflowNotFoundError';
}

const OWNED = 'org-owned';
const JOINED = 'org-joined';

/** A Temporal client fake: which ids are running, what the list query returns. */
const fakeTemporal = ({
  running = [] as string[],
  listed = [] as Array<{ workflowId: string; org: string }>,
  terminate,
}: {
  running?: string[];
  listed?: Array<{ workflowId: string; org: string }>;
  terminate?: (id: string) => Promise<void>;
} = {}) => {
  const terminated: string[] = [];
  const queries: string[] = [];
  const client = {
    workflow: {
      getHandle: (id: string) => ({
        terminate: jest.fn(async () => {
          if (terminate) {
            return terminate(id);
          }
          if (!running.includes(id)) {
            throw new WorkflowNotFoundError('workflow execution already completed');
          }
          terminated.push(id);
        }),
      }),
      list: ({ query }: { query: string }) => {
        queries.push(query);
        return (async function* () {
          for (const { workflowId, org } of listed) {
            yield {
              workflowId,
              typedSearchAttributes: new TypedSearchAttributes([
                { key: organizationIdAttribute, value: org },
              ]),
            };
          }
        })();
      },
    },
  };
  return {
    service: { client: { getRawClient: () => client } },
    terminated,
    queries,
  };
};

const setup = (temporal = fakeTemporal()) => {
  const calls: string[] = [];
  const orgs = [
    { id: OWNED, users: [{ role: Role.SUPERADMIN, disabled: false }] },
    { id: JOINED, users: [{ role: Role.USER, disabled: false }] },
  ];
  const organizations = {
    getOrgsByUserId: jest.fn(async () => orgs),
    getTeam: jest.fn(async (id: string) => ({
      users: [{ user: { id: 'user-1' } }, ...(id === JOINED ? [{ user: { id: 'owner-2' } }] : [])],
    })),
    getWorkflowSubjects: jest.fn(async (id: string) => {
      calls.push(`subjects:${id}`);
      return {
        post: [{ id: 'p1' }, { id: 'p2' }],
        autoPost: [{ id: 'a1' }],
        Integration: [{ id: 'i1' }],
      };
    }),
    deleteOrganization: jest.fn(async (id: string) => calls.push(`deleteOrganization:${id}`)),
    deleteTeamMember: jest.fn(async (id: string) => calls.push(`deleteTeamMember:${id}`)),
  };
  const integrations = {
    deleteIntegrationsForAccount: jest.fn(async (id: string) =>
      calls.push(`deleteIntegrations:${id}`)
    ),
  };
  const users = {
    deleteAccount: jest.fn(async () => calls.push('deleteUser')),
  };
  const affiliates = {
    deactivateForDeletedAccount: jest.fn(async () => calls.push('deactivateAffiliate')),
  };
  const service = new UsersService(
    users as any,
    organizations as any,
    integrations as any,
    {} as any,
    affiliates as any,
    temporal.service as any
  );
  const errors = jest
    .spyOn((service as any)._logger, 'error')
    .mockImplementation(() => undefined);
  jest.spyOn((service as any)._logger, 'log').mockImplementation(() => undefined);
  jest.spyOn((service as any)._logger, 'warn').mockImplementation(() => undefined);
  return { service, calls, organizations, users, affiliates, temporal, errors };
};

describe('UsersService.deleteAccount and Temporal', () => {
  it('stops every workflow of the workspace it deletes, after the rows are deleted', async () => {
    const temporal = fakeTemporal({
      running: ['post_p1', 'autopost-a1', 'refresh_i1', `streak_${OWNED}`],
    });
    const { service, calls } = setup(temporal);

    await service.deleteAccount('user-1');

    expect(temporal.terminated.sort()).toEqual(
      ['autopost-a1', 'post_p1', 'refresh_i1', `streak_${OWNED}`].sort()
    );
    // Read before, stopped after: the rows were already deleted.
    expect(calls).toEqual([
      `subjects:${OWNED}`,
      `deleteIntegrations:${OWNED}`,
      `deleteOrganization:${OWNED}`,
      `deleteTeamMember:${JOINED}`,
      'deactivateAffiliate',
      'deleteUser',
    ]);
  });

  it('never touches the workspaces the user only joined', async () => {
    const temporal = fakeTemporal({ running: ['post_p1'] });
    const { service, organizations } = setup(temporal);
    await service.deleteAccount('user-1');
    expect(organizations.getWorkflowSubjects).toHaveBeenCalledTimes(1);
    expect(organizations.getWorkflowSubjects).toHaveBeenCalledWith(OWNED);
    expect(temporal.queries).toEqual([
      `organizationId="${OWNED}" AND ExecutionStatus="Running"`,
    ]);
  });

  it('terminates other runs tagged with the workspace, but only on an exact match', async () => {
    const temporal = fakeTemporal({
      running: ['other-run'],
      listed: [
        { workflowId: 'other-run', org: OWNED },
        // TEXT search attributes are full-text: a near match must be ignored.
        { workflowId: 'someone-else', org: `${OWNED}-2` },
      ],
      terminate: async (id) => {
        if (id !== 'other-run') {
          throw new WorkflowNotFoundError('not found');
        }
        temporal.terminated.push(id);
      },
    });
    const { service } = setup(temporal);
    await service.deleteAccount('user-1');
    expect(temporal.terminated).toEqual(['other-run']);
  });

  it('finishes the deletion and records what it could not stop when Temporal is down', async () => {
    const temporal = fakeTemporal({
      terminate: async () => {
        throw new Error('14 UNAVAILABLE: No connection established');
      },
    });
    const { service, users, errors } = setup(temporal);

    await expect(service.deleteAccount('user-1')).resolves.toMatchObject({
      deletedOrgs: [{ id: OWNED }],
    });
    expect(users.deleteAccount).toHaveBeenCalledWith('user-1');
    const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain(`ACCOUNT_DELETION_WORKFLOWS_NOT_STOPPED workspace ${OWNED}`);
    expect(logged).toContain('post_p1');
  });

  it('finishes the deletion when there is no Temporal client at all', async () => {
    const { service, users, errors } = setup({
      service: { client: { getRawClient: () => null } },
      terminated: [],
      queries: [],
    } as any);
    await service.deleteAccount('user-1');
    expect(users.deleteAccount).toHaveBeenCalled();
    expect(String(errors.mock.calls[0][0])).toContain('ACCOUNT_DELETION_WORKFLOWS_NOT_STOPPED');
  });

  it('counts finished workflows as not running, not as failures', async () => {
    const temporal = fakeTemporal({ running: [] });
    const { service } = setup(temporal);
    const result = await service.stopWorkspaceWorkflows(OWNED, ['post_x', 'post_y']);
    expect(result).toEqual({ stopped: [], notRunning: 2, failed: [] });
  });

  it('gives up on a call that hangs instead of hanging the request', async () => {
    jest.useFakeTimers();
    try {
      const temporal = fakeTemporal({
        terminate: (id) =>
          id === 'post_stuck' ? new Promise<void>(() => undefined) : Promise.resolve(),
      });
      const { service } = setup(temporal);
      const pending = service.stopWorkspaceWorkflows(OWNED, ['post_stuck', 'post_ok']);
      await jest.advanceTimersByTimeAsync(6000);
      const result = await pending;
      expect(result.failed).toEqual(['post_stuck']);
      expect(result.stopped).toEqual(['post_ok']);
    } finally {
      jest.useRealTimers();
    }
  });
});
