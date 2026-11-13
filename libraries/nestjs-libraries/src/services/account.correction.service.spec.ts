import 'reflect-metadata';
import {
  AccountCorrection,
  AccountCorrectionService,
} from '@hookpost/nestjs-libraries/services/account.correction.service';

// Who a correction email reaches and who it must not: exactly once per
// correction, never an internal workspace, never when the admin switched it
// off, and the owner alert whatever happens. Redis and Resend are fakes;
// nothing leaves the machine.

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.repository',
  () => ({ OrganizationRepository: class {} })
);
jest.mock('@hookpost/nestjs-libraries/services/owner.sales.alert.service', () => ({
  OwnerSalesAlertService: class {},
}));

const redisData = new Map<string, string>();
let redisDown = false;
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      await new Promise((r) => setImmediate(r));
      if (redisDown) throw new Error('ECONNREFUSED');
      if (args.includes('NX') && redisData.has(key)) return null;
      redisData.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => (redisData.delete(key) ? 1 : 0)),
  },
}));

const sent: any[] = [];
let resendMode: 'ok' | 'error' = 'ok';
const mockSend = jest.fn(async (msg: any) => {
  if (resendMode === 'error') {
    return { data: null, error: { name: 'internal_server_error', message: 'Resend is down' } };
  }
  sent.push(msg);
  return { data: { id: `email_${sent.length}` }, error: null };
});
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

const ORG = 'org-d936df7d';

const member = (over: any = {}) => ({
  role: 'SUPERADMIN',
  user: {
    id: 'u-1',
    email: 'owner@rkdefence.example',
    name: 'RK',
    lastName: null,
    signupCountry: 'IN',
    isSuperAdmin: false,
    deletedAt: null,
    ...over,
  },
});

const alerts: any[] = [];
function service(facts: any = { id: ORG, name: 'RK DEFENCE ACADEMY', users: [member()] }) {
  const orgs: any = { getSaleAlertFacts: jest.fn(async () => facts) };
  const owner: any = {
    notify: jest.fn(async (a: any) => {
      alerts.push(a);
      return 'sent';
    }),
  };
  return new AccountCorrectionService(orgs, owner);
}

const correction = (over: Partial<AccountCorrection> = {}): AccountCorrection => ({
  organizationId: ORG,
  facts: {
    event: 'PLAN_CORRECTED_ENDED',
    billing: 'STANDARD',
    endedAt: new Date('2026-10-29T11:04:00Z'),
    neverCharged: true,
  },
  reference: 'sub_TestSubscript',
  reason: 'Trial cancelled at Razorpay on 21 Oct, never charged',
  by: 'owner@hookstep.in',
  ...over,
});

beforeEach(() => {
  redisData.clear();
  redisDown = false;
  resendMode = 'ok';
  sent.length = 0;
  alerts.length = 0;
  process.env.RESEND_API_KEY = 'test-key';
});

describe('AccountCorrectionService: who it reaches', () => {
  it('emails the workspace billing contact and alerts the owner', async () => {
    const result = await service().notify(correction());

    expect(result.email).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('owner@rkdefence.example');
    expect(sent[0].from).toBe('Hookpost Billing <support@hookstep.in>');
    expect(sent[0].reply_to).toBe('support@hookstep.in');
    expect(sent[0].subject).toBe('Your Hookpost workspace: plan status corrected');
    expect(sent[0].html).toContain('RK DEFENCE ACADEMY');

    expect(alerts).toHaveLength(1);
    expect(alerts[0].event).toBe('PLAN_CORRECTED_ENDED');
    expect(alerts[0].source).toBe('hookpost');
    expect(alerts[0].key).toBe(`correction:plan-corrected-ended:${ORG}:sub_TestSubscript`);
    expect(alerts[0].notes).toContain(
      'Reason: Trial cancelled at Razorpay on 21 Oct, never charged'
    );
    expect(alerts[0].notes).toContain('By: owner@hookstep.in');
    expect(alerts[0].notes).toContain('Customer email: sent');
  });

  it('never emails an internal workspace, but still alerts the owner', async () => {
    const internal = service({
      id: ORG,
      name: 'Hookpost HQ',
      users: [member({ isSuperAdmin: true })],
    });

    const result = await internal.notify(correction());

    expect(result.email).toBe('internal');
    expect(sent).toHaveLength(0);
    expect(alerts[0].notes).toContain('Customer email: not sent (internal workspace)');
  });

  it('a deleted super admin does not make a workspace internal, and is never the recipient', async () => {
    const result = await service({
      id: ORG,
      name: 'Left Hookpost',
      users: [
        member({ id: 'u-gone', email: 'gone@hookstep.example', isSuperAdmin: true, deletedAt: new Date() }),
        member({ id: 'u-2', email: 'still@rkdefence.example' }),
      ],
    }).notify(correction());

    expect(result.email).toBe('sent');
    expect(JSON.stringify(sent)).toContain('still@rkdefence.example');
    expect(JSON.stringify(sent)).not.toContain('gone@hookstep.example');
  });

  it('a workspace whose only member is deleted has nobody to email', async () => {
    const result = await service({
      id: ORG,
      name: 'Gone',
      users: [member({ deletedAt: new Date() })],
    }).notify(correction());
    expect(result.email).toBe('no-recipient');
    expect(sent).toHaveLength(0);
  });

  it('never emails a workspace FREE_PLAN_SUNSET_EXEMPT_ORGS lists', async () => {
    process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = `other-org, ${ORG}`;
    try {
      const result = await service().notify(correction());
      expect(result.email).toBe('internal');
      expect(sent).toHaveLength(0);
    } finally {
      delete process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS;
    }
  });

  it('respects the admin switching the customer email off', async () => {
    const result = await service().notify(correction({ skipCustomerEmail: true }));

    expect(result.email).toBe('opted-out');
    expect(sent).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].notes).toContain(
      'Customer email: not sent (switched off for this action)'
    );
  });

  it('says so rather than throwing when the workspace has nobody to email', async () => {
    const result = await service({ id: ORG, name: 'Empty', users: [] }).notify(correction());

    expect(result.email).toBe('no-recipient');
    expect(sent).toHaveLength(0);
    expect(alerts[0].notes).toContain(
      'Customer email: not sent (the workspace has no member with an email address)'
    );
  });

  it('sends nothing at all where there is no email provider', async () => {
    delete process.env.RESEND_API_KEY;
    const result = await service().notify(correction());

    expect(result.email).toBe('disabled');
    expect(sent).toHaveLength(0);
    // The owner alert still goes out; its own service decides what to do.
    expect(alerts).toHaveLength(1);
  });
});

describe('AccountCorrectionService: exactly once', () => {
  it('apologises once for one correction, however many times it runs', async () => {
    const s = service();
    const first = await s.notify(correction());
    const second = await s.notify(correction());

    expect(first.email).toBe('sent');
    expect(second.email).toBe('duplicate');
    expect(sent).toHaveLength(1);
    expect(alerts[1].notes).toContain(
      'Customer email: not sent (already sent for this correction)'
    );
  });

  it('two jobs racing the same correction send one email', async () => {
    const s = service();
    const [a, b] = await Promise.all([s.notify(correction()), s.notify(correction())]);

    expect([a.email, b.email].sort()).toEqual(['duplicate', 'sent']);
    expect(sent).toHaveLength(1);
  });

  it('a different correction of the same workspace still goes out', async () => {
    const s = service();
    await s.notify(correction());
    const other = await s.notify(
      correction({
        facts: {
          event: 'CHARGE_STOPPED',
          billing: 'STANDARD',
          accessUntil: null,
        },
      })
    );

    expect(other.email).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('a second subscription of the same workspace is its own correction', async () => {
    const s = service();
    await s.notify(correction({ reference: 'sub_One' }));
    const second = await s.notify(correction({ reference: 'sub_Two' }));

    expect(second.email).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('without a reference, a rerun inside the same day is still one email', async () => {
    const s = service();
    await s.notify(correction({ reference: null }));
    const again = await s.notify(correction({ reference: null }));

    expect(again.email).toBe('duplicate');
    expect(sent).toHaveLength(1);
  });

  it('gives the claim back when Resend refuses, so a retry can send', async () => {
    const s = service();
    resendMode = 'error';
    const failed = await s.notify(correction());
    expect(failed.email).toBe('failed');
    expect(alerts[0].notes).toContain('Customer email: NOT SENT - the send failed, see the logs');

    resendMode = 'ok';
    const retried = await s.notify(correction());
    expect(retried.email).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('sends nothing with Redis unreachable, rather than risk two apologies', async () => {
    redisDown = true;
    const result = await service().notify(correction());

    expect(result.email).toBe('failed');
    expect(sent).toHaveLength(0);
    // The owner still hears about it, with the email marked as not sent.
    expect(alerts).toHaveLength(1);
  });
});

describe('AccountCorrectionService: it never throws', () => {
  it('survives a workspace that cannot be read', async () => {
    const orgs: any = {
      getSaleAlertFacts: jest.fn(async () => {
        throw new Error('database is away');
      }),
    };
    const owner: any = { notify: jest.fn(async (a: any) => alerts.push(a)) };

    const result = await new AccountCorrectionService(orgs, owner).notify(correction());

    expect(result.email).toBe('no-recipient');
    expect(alerts).toHaveLength(1);
  });

  it('survives an owner alert service that throws', async () => {
    const orgs: any = {
      getSaleAlertFacts: jest.fn(async () => ({
        id: ORG,
        name: 'RK DEFENCE ACADEMY',
        users: [member()],
      })),
    };
    const owner: any = {
      notify: jest.fn(() => {
        throw new Error('redis is away');
      }),
    };

    await expect(
      new AccountCorrectionService(orgs, owner).notify(correction())
    ).resolves.toMatchObject({ email: 'sent' });
  });
});
