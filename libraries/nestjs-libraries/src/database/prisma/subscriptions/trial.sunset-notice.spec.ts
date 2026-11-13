import 'reflect-metadata';

// The Free plan sunset email of 21 Oct 2026 (20 Oct 19:02 UTC) told 25
// owners "start the 7-day trial", a day before the trial went to 3. Those
// workspaces keep 7 days: trial.policy.ts SUNSET_NOTICE_TRIAL_DAYS, found by
// the email's sent-once rows (UsedCodes notice:free_plan_sunset:<userId>).
// Real repository and service; Prisma faked in memory, with a where-clause
// evaluator for the filters the lookup uses, so the test checks which rows
// match rather than the shape of the query.
//   pnpm exec jest -c apps/backend/jest.config.ts trial.sunset-notice

jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
  PrismaTransaction: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository',
  () => ({ AffiliateRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);

import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { SubscriptionRepository } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.repository';
import {
  baseTrialDays,
  knownTrialDays,
  PLAN_GATE_MESSAGES,
  planGateMessage,
  SUNSET_NOTICE_7_DAY_BEFORE,
  SUNSET_NOTICE_CODE_PREFIX,
  SUNSET_NOTICE_TRIAL_DAYS,
  TRIAL_DAYS,
  trialDaysFor,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

type Row = { id: string; code: string; orgId: string; createdAt: Date };
type Org = { id: string; createdAt: Date; owners: string[] };

// The filters sunsetNoticePromisedTrial uses: equality, startsWith, in, lt, gt, OR.
const matches = (row: any, where: any): boolean =>
  Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === 'OR') return (cond as any[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
      return value === cond;
    }
    return Object.entries(cond).every(([op, arg]: [string, any]) => {
      switch (op) {
        case 'startsWith':
          return String(value).startsWith(arg);
        case 'in':
          return (arg as any[]).includes(value);
        case 'lt':
          return value < arg;
        case 'gt':
          return value > arg;
        default:
          throw new Error(`unsupported filter ${op}`);
      }
    });
  });

const SENT = new Date('2026-10-20T19:02:30.000Z');

const build = (orgs: Org[], rows: Row[]) => {
  const organization = {
    model: {
      organization: {
        findFirst: jest.fn(async ({ where }: any) => {
          const o = orgs.find((x) => x.id === where.id);
          return o
            ? { createdAt: o.createdAt, users: o.owners.map((userId) => ({ userId })) }
            : null;
        }),
      },
    },
  };
  const usedCodes = {
    model: {
      usedCodes: {
        findFirst: jest.fn(async ({ where }: any) => {
          const r = rows.find((x) => matches(x, where));
          return r ? { id: r.id } : null;
        }),
      },
    },
  };
  const repository = new SubscriptionRepository(
    {} as any,
    organization as any,
    {} as any,
    {} as any,
    usedCodes as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  const service = new SubscriptionService(repository, {} as any, {} as any, {} as any);
  return { repository, service };
};

const notice = (userId: string, orgId: string, createdAt = SENT): Row => ({
  id: `uc-${userId}-${orgId}`,
  code: `${SUNSET_NOTICE_CODE_PREFIX}${userId}`,
  orgId,
  createdAt,
});

describe('trialDaysFor / knownTrialDays / planGateMessage (pure)', () => {
  it('7 for a workspace the notice promised it to, TRIAL_DAYS (3) for everyone else', () => {
    expect(TRIAL_DAYS).toBe(3);
    expect(SUNSET_NOTICE_TRIAL_DAYS).toBe(7);
    expect(trialDaysFor({ sunsetNoticePromised: true })).toBe(7);
    expect(trialDaysFor({ sunsetNoticePromised: false })).toBe(3);
    expect(trialDaysFor({})).toBe(3);
  });

  it('RAZORPAY_TRIAL_DAYS: 0 keeps trials off for everyone; a longer one is not cut to 7', () => {
    expect(trialDaysFor({ sunsetNoticePromised: true }, 0)).toBe(0);
    expect(trialDaysFor({ sunsetNoticePromised: true }, NaN)).toBeNaN();
    expect(trialDaysFor({ sunsetNoticePromised: true }, 14)).toBe(14);
    expect(trialDaysFor({ sunsetNoticePromised: true }, 5)).toBe(7);
  });

  it('baseTrialDays: RAZORPAY_TRIAL_DAYS overrides TRIAL_DAYS for every caller, unset or empty is TRIAL_DAYS', () => {
    expect(baseTrialDays({})).toBe(TRIAL_DAYS);
    expect(baseTrialDays({ RAZORPAY_TRIAL_DAYS: '' })).toBe(TRIAL_DAYS);
    expect(baseTrialDays({ RAZORPAY_TRIAL_DAYS: '0' })).toBe(0);
    expect(baseTrialDays({ RAZORPAY_TRIAL_DAYS: '5' })).toBe(5);
    expect(baseTrialDays({ RAZORPAY_TRIAL_DAYS: 'abc' })).toBe(0);
    expect(baseTrialDays({ RAZORPAY_TRIAL_DAYS: '-1' })).toBe(0);
    // trialDaysFor's default base is the same number, so /user/self, the MCP
    // gate and the channel gate say what checkout does.
    const was = process.env.RAZORPAY_TRIAL_DAYS;
    try {
      process.env.RAZORPAY_TRIAL_DAYS = '5';
      expect(trialDaysFor({})).toBe(5);
      expect(trialDaysFor({ sunsetNoticePromised: true })).toBe(7);
      process.env.RAZORPAY_TRIAL_DAYS = '0';
      expect(trialDaysFor({ sunsetNoticePromised: true })).toBe(0);
    } finally {
      if (was === undefined) delete process.env.RAZORPAY_TRIAL_DAYS;
      else process.env.RAZORPAY_TRIAL_DAYS = was;
    }
  });

  it('knownTrialDays falls back to TRIAL_DAYS for anything that is not a positive number', () => {
    expect(knownTrialDays(7)).toBe(7);
    expect(knownTrialDays('7')).toBe(7);
    for (const v of [undefined, null, '', 0, -1, NaN, 'abc', {}]) {
      expect(knownTrialDays(v)).toBe(TRIAL_DAYS);
    }
  });

  it('the gate message names the workspace\'s own length; PLAN_REQUIRED is unchanged', () => {
    expect(planGateMessage('TRIAL_REQUIRED')).toBe(PLAN_GATE_MESSAGES.TRIAL_REQUIRED);
    expect(planGateMessage('TRIAL_REQUIRED', 3)).toBe(
      'Start your 3-day trial to schedule and publish posts.'
    );
    expect(planGateMessage('TRIAL_REQUIRED', 7)).toBe(
      'Start your 7-day trial to schedule and publish posts.'
    );
    expect(planGateMessage('PLAN_REQUIRED', 7)).toBe('Choose a plan to continue.');
  });

  it('the code the notice wrote on prod, written before the cutoff', () => {
    // notify-free-plan-sunset.spec.ts checks the script writes this prefix.
    expect(SUNSET_NOTICE_CODE_PREFIX).toBe('notice:free_plan_sunset:');
    // All 25 rows on prod were written on 20 Oct 19:02 UTC, before the cutoff.
    expect(SENT < SUNSET_NOTICE_7_DAY_BEFORE).toBe(true);
  });
});

describe('which workspaces the sunset notice promised 7 days', () => {
  const OLD = new Date('2026-09-17T00:00:00Z');

  it('the row is on the workspace (how all 25 prod rows look): 7 days', async () => {
    const { repository, service } = build(
      [{ id: 'org-a', createdAt: OLD, owners: ['u-a'] }],
      [notice('u-a', 'org-a')]
    );
    expect(await repository.sunsetNoticePromisedTrial('org-a')).toBe(true);
    expect(await service.trialDaysFor('org-a')).toBe(7);
  });

  it('no notice row: TRIAL_DAYS', async () => {
    const { service } = build([{ id: 'org-n', createdAt: OLD, owners: ['u-n'] }], []);
    expect(await service.trialDaysFor('org-n')).toBe(3);
  });

  it('another workspace of the same owner, which existed when the email went out, is covered', async () => {
    const { service } = build(
      [
        { id: 'org-a', createdAt: OLD, owners: ['u-a'] },
        { id: 'org-b', createdAt: OLD, owners: ['u-a'] },
      ],
      [notice('u-a', 'org-a')]
    );
    expect(await service.trialDaysFor('org-b')).toBe(7);
  });

  it('a workspace the owner creates after the email: TRIAL_DAYS', async () => {
    const { service } = build(
      [
        { id: 'org-a', createdAt: OLD, owners: ['u-a'] },
        { id: 'org-new', createdAt: new Date('2026-10-23T00:00:00Z'), owners: ['u-a'] },
      ],
      [notice('u-a', 'org-a')]
    );
    expect(await service.trialDaysFor('org-new')).toBe(3);
  });

  it('a notice sent after 22 Oct says TRIAL_DAYS, and gets TRIAL_DAYS', async () => {
    const { service } = build(
      [{ id: 'org-l', createdAt: OLD, owners: ['u-l'] }],
      [notice('u-l', 'org-l', new Date('2026-10-23T10:00:00Z'))]
    );
    expect(await service.trialDaysFor('org-l')).toBe(3);
  });

  it('other UsedCodes on the workspace (coupons, lead drip) do not count', async () => {
    const { service } = build(
      [{ id: 'org-c', createdAt: OLD, owners: ['u-c'] }],
      [{ id: 'x', code: 'lead:drip:1', orgId: 'org-c', createdAt: SENT }]
    );
    expect(await service.trialDaysFor('org-c')).toBe(3);
  });

  it('an unknown workspace or a failing lookup gives TRIAL_DAYS, never an error at checkout', async () => {
    const { service } = build([], []);
    expect(await service.trialDaysFor('missing')).toBe(3);
    const broken = new SubscriptionService(
      { sunsetNoticePromisedTrial: jest.fn(async () => { throw new Error('db down'); }) } as any,
      {} as any,
      {} as any,
      {} as any
    );
    expect(await broken.trialDaysFor('org-a')).toBe(3);
  });

  it('trials switched off (base 0) are not looked up', async () => {
    const lookup = jest.fn(async () => true);
    const service = new SubscriptionService(
      { sunsetNoticePromisedTrial: lookup } as any,
      {} as any,
      {} as any,
      {} as any
    );
    expect(await service.trialDaysFor('org-a', 0)).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  });
});
