import 'reflect-metadata';
import { AdminPlanActionsService } from '@hookpost/nestjs-libraries/services/admin.plan.actions.service';

// "End plan now" and "Restore plan": that each one runs the app's own code
// path, is recorded before anything changes, tells the customer the right
// thing, and changes nothing when it cannot be recorded.

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/services/razorpay.service', () => ({
  RazorpayService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.action.audit.repository',
  () => ({ PlanActionAuditRepository: class {} })
);
// Its import chain reaches an ESM-only package (file-type) that ts-jest
// does not transform; the service only needs getDispute from it.
jest.mock('@hookpost/nestjs-libraries/database/prisma/organizations/organization.service', () => ({
  OrganizationService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/services/account.correction.service', () => ({
  AccountCorrectionService: class {},
}));

const ADMIN = { id: 'u-admin', email: 'owner@hookstep.in' };
const ORG = 'org-d936df7d';
const LIVE_PLAN = {
  id: 'sub-row',
  subscriptionTier: 'STANDARD',
  period: 'MONTHLY',
  identifier: 'sub_TestSubscript',
};

function build(
  over: {
    plan?: any;
    cancelledAtProvider?: boolean;
    cancelThrows?: string;
    auditThrows?: boolean;
    restoreThrows?: string;
    restoreReturns?: any;
    /** Razorpay's subscriptions for the workspace (getOrgSubscriptions). */
    remote?: any[];
    /** The workspace's dispute row (getDispute). */
    dispute?: any;
  } = {}
) {
  const calls: string[] = [];
  const audits: any[] = [];
  const finished: any[] = [];
  const corrections: any[] = [];

  const subscriptions: any = {
    getSubscription: jest.fn(async () => ('plan' in over ? over.plan : LIVE_PLAN)),
    deleteSubscriptionByOrg: jest.fn(async () => {
      calls.push('deleteSubscriptionByOrg');
    }),
    restoreSubscriptionByOrg: jest.fn(async () => {
      calls.push('restoreSubscriptionByOrg');
      if (over.restoreThrows) throw new Error(over.restoreThrows);
      return 'restoreReturns' in over ? over.restoreReturns : {};
    }),
  };
  const razorpay: any = {
    cancelSubscription: jest.fn(async () => {
      calls.push('cancelSubscription');
      if (over.cancelThrows) throw new Error(over.cancelThrows);
      return { ok: true, cancelledAtProvider: !!over.cancelledAtProvider };
    }),
    cancelAllSubscriptions: jest.fn(async () => {
      calls.push('cancelAllSubscriptions');
      return { ok: true };
    }),
    getOrgSubscriptions: jest.fn(async () => ({ items: over.remote || [] })),
  };
  const organizations: any = { getDispute: jest.fn(async () => over.dispute ?? null) };
  const auditRepo: any = {
    createAudit: jest.fn(async (row: any) => {
      calls.push('createAudit');
      if (over.auditThrows) throw new Error('relation "PlanActionAudit" does not exist');
      audits.push(row);
      return { id: `audit-${audits.length}` };
    }),
    finishAudit: jest.fn(async (id: string, data: any) => {
      finished.push({ id, ...data });
    }),
    listAudit: jest.fn(async (take: number, organizationId?: string) => {
      calls.push(`listAudit:${take}:${organizationId ?? ''}`);
      return [];
    }),
  };
  const corrector: any = {
    notify: jest.fn(async (c: any) => {
      calls.push('correction');
      corrections.push(c);
      return { email: 'sent' };
    }),
  };

  return {
    service: new AdminPlanActionsService(subscriptions, razorpay, auditRepo, corrector, organizations),
    calls,
    audits,
    finished,
    corrections,
    subscriptions,
    razorpay,
  };
}

const endRequest = (over: any = {}) => ({
  organizationId: ORG,
  reason: 'Trial cancelled at Razorpay on 21 Oct, never charged',
  correction: 'PLAN_CORRECTED_ENDED' as const,
  ...over,
});

describe('End plan now', () => {
  it('records the action before it changes anything', async () => {
    const t = build();
    await t.service.endPlan(ADMIN, endRequest());

    expect(t.calls.indexOf('createAudit')).toBeLessThan(
      t.calls.indexOf('cancelSubscription')
    );
    expect(t.audits[0]).toMatchObject({
      adminUserId: 'u-admin',
      adminEmail: 'owner@hookstep.in',
      organizationId: ORG,
      action: 'END',
      reason: 'Trial cancelled at Razorpay on 21 Oct, never charged',
      correction: 'PLAN_CORRECTED_ENDED',
      tier: 'STANDARD',
      period: 'MONTHLY',
      status: 'PENDING',
    });
    expect(t.finished[0]).toMatchObject({ status: 'SUCCESS', emailOutcome: 'sent' });
  });

  it('deletes the plan row itself when there was nothing live at Razorpay', async () => {
    // RK Defence: the trial was cancelled at Razorpay on 21 Oct, so
    // cancelSubscription finds nothing and leaves the row behind.
    const t = build({ cancelledAtProvider: false });
    const result = await t.service.endPlan(ADMIN, endRequest());

    expect(result).toMatchObject({ ok: true, cancelledAtProvider: false, email: 'sent' });
    expect(t.calls).toContain('deleteSubscriptionByOrg');
  });

  it('leaves the deleting to cancelSubscription when it did cancel one', async () => {
    const t = build({ cancelledAtProvider: true });
    const result = await t.service.endPlan(ADMIN, endRequest());

    expect(result.cancelledAtProvider).toBe(true);
    // cancelSubscription already called deleteSubscriptionByOrg; calling it
    // again would downgrade a workspace twice.
    expect(t.subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
  });

  it('refuses a workspace with no plan on file, and records nothing', async () => {
    const t = build({ plan: null });
    const result = await t.service.endPlan(ADMIN, endRequest());

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('nothing to end');
    expect(t.calls).toEqual([]);
  });

  it('changes nothing when the audit row cannot be written', async () => {
    const t = build({ auditThrows: true });
    const result = await t.service.endPlan(ADMIN, endRequest());

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('plan-action-audit.migration.sql');
    expect(t.calls).toEqual(['createAudit']);
  });

  it('records the failure and emails nobody when Razorpay refuses', async () => {
    const t = build({ cancelThrows: 'Razorpay request failed (400)' });
    const result = await t.service.endPlan(ADMIN, endRequest());

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Nothing was changed');
    expect(t.finished[0]).toMatchObject({ status: 'FAILED' });
    expect(t.corrections).toHaveLength(0);
  });
});

describe('End plan now: what the customer is told', () => {
  it('PLAN_CORRECTED_ENDED never claims they were never charged', async () => {
    const t = build();
    await t.service.endPlan(ADMIN, endRequest());

    expect(t.corrections[0].facts).toMatchObject({
      event: 'PLAN_CORRECTED_ENDED',
      billing: 'STANDARD',
      neverCharged: false,
    });
    expect(t.corrections[0]).toMatchObject({
      reference: 'sub_TestSubscript',
      by: 'owner@hookstep.in',
    });
  });

  it("CHARGE_STOPPED sends the guard's email with the plan over (End plan now leaves no paid time)", async () => {
    const stopped = build({ cancelledAtProvider: true });
    await stopped.service.endPlan(ADMIN, endRequest({ correction: 'CHARGE_STOPPED' }));
    expect(stopped.corrections[0].facts).toEqual({ event: 'CHARGE_STOPPED', billing: expect.anything(), accessUntil: null });
  });

  it('REFUND_ENDED_PLAN carries the date of the refund we failed to act on', async () => {
    const t = build();
    const refundedOn = new Date('2026-10-11T06:00:00Z');
    await t.service.endPlan(
      ADMIN,
      endRequest({ correction: 'REFUND_ENDED_PLAN', refundedOn })
    );

    expect(t.corrections[0].facts).toMatchObject({
      event: 'REFUND_ENDED_PLAN',
      refundedOn,
    });
  });

  it('NONE ends the plan and emails nobody', async () => {
    const t = build();
    const result = await t.service.endPlan(ADMIN, endRequest({ correction: 'NONE' }));

    expect(result).toMatchObject({ ok: true, email: 'opted-out' });
    expect(t.corrections).toHaveLength(0);
    expect(t.audits[0].correction).toBeNull();
    expect(t.calls).toContain('cancelSubscription');
  });

  it('passes the admin opt-out through to the correction service', async () => {
    const t = build();
    await t.service.endPlan(ADMIN, endRequest({ skipCustomerEmail: true }));

    expect(t.corrections[0].skipCustomerEmail).toBe(true);
  });
});

describe('Restore plan', () => {
  const restoreRequest = (over: any = {}) => ({
    organizationId: ORG,
    reason: 'Ended by the sweep on bad facts; the renewal had been paid',
    tier: 'PRO' as const,
    period: 'MONTHLY' as const,
    ...over,
  });

  it('a gift with an end date: the plan is written with that cancelAt, so it ends then', async () => {
    const t = build({ plan: null });
    const until = new Date('2027-02-03T18:29:00Z');
    const result = await t.service.restorePlan(ADMIN, restoreRequest({ until }));
    expect(result).toMatchObject({ ok: true });
    expect(t.subscriptions.restoreSubscriptionByOrg).toHaveBeenCalledWith(ORG, {
      tier: 'PRO',
      period: 'MONTHLY',
      cancelAt: until,
    });
  });

  it('refuses an end date that is not in the future', async () => {
    const t = build({ plan: null });
    const result = await t.service.restorePlan(ADMIN, restoreRequest({ until: new Date('2020-01-01') }));
    expect(result).toMatchObject({ ok: false });
    expect(t.calls).not.toContain('restoreSubscriptionByOrg');
  });

  it('writes the plan back and tells the customer', async () => {
    const t = build({ plan: null });
    const result = await t.service.restorePlan(ADMIN, restoreRequest());

    expect(result).toMatchObject({ ok: true, email: 'sent' });
    expect(t.calls.indexOf('createAudit')).toBeLessThan(
      t.calls.indexOf('restoreSubscriptionByOrg')
    );
    expect(t.audits[0]).toMatchObject({
      action: 'RESTORE',
      correction: 'PLAN_RESTORED',
      tier: 'PRO',
      period: 'MONTHLY',
    });
    expect(t.corrections[0].facts).toMatchObject({
      event: 'PLAN_RESTORED',
      billing: 'PRO',
    });
    expect(t.finished[0]).toMatchObject({ status: 'SUCCESS' });
  });

  it('refuses a workspace that already has a plan, rather than writing over it', async () => {
    const t = build({ plan: LIVE_PLAN });
    const result = await t.service.restorePlan(ADMIN, restoreRequest());

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('already has a live STANDARD plan');
    expect(t.calls).toEqual([]);
  });

  it('records the failure when the workspace does not exist', async () => {
    const t = build({ plan: null, restoreReturns: null });
    const result = await t.service.restorePlan(ADMIN, restoreRequest());

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('does not exist');
    expect(t.finished[0]).toMatchObject({ status: 'FAILED' });
    expect(t.corrections).toHaveLength(0);
  });

  it('changes nothing when the audit row cannot be written', async () => {
    const t = build({ plan: null, auditThrows: true });
    const result = await t.service.restorePlan(ADMIN, restoreRequest());

    expect(result.ok).toBe(false);
    expect(t.calls).toEqual(['createAudit']);
  });

  it('records the failure and emails nobody when the write throws', async () => {
    const t = build({ plan: null, restoreThrows: 'database is away' });
    const result = await t.service.restorePlan(ADMIN, restoreRequest());

    expect(result.ok).toBe(false);
    expect(t.finished[0]).toMatchObject({ status: 'FAILED' });
    expect(t.corrections).toHaveLength(0);
  });

  it('with the email switched off it still records and still alerts the owner', async () => {
    const t = build({ plan: null });
    await t.service.restorePlan(ADMIN, restoreRequest({ skipCustomerEmail: true }));

    expect(t.audits[0].correction).toBeNull();
    expect(t.corrections[0].skipCustomerEmail).toBe(true);
  });
});

describe('the audit list', () => {
  it('caps how much one call can read', async () => {
    const t = build();
    await t.service.listActions(5000, ORG);
    await t.service.listActions(0);

    expect(t.calls).toContain(`listAudit:500:${ORG}`);
    expect(t.calls).toContain('listAudit:1:');
  });
});

describe('review of PR #69 (1 Nov 2026)', () => {
  it('End plan now also stops every other live mandate of the workspace', async () => {
    const t = build();
    await t.service.endPlan(ADMIN, endRequest({ correction: 'PLAN_CORRECTED_ENDED' }));
    expect(t.calls).toContain('cancelAllSubscriptions');
  });

  it('Restore refuses while a Razorpay subscription is still live, and changes nothing', async () => {
    const t = build({ plan: null, remote: [{ id: 'sub_x', status: 'active' }] });
    const res = await t.service.restorePlan(ADMIN, { organizationId: 'org-1', reason: 'Ended by mistake here', tier: 'PRO', period: 'MONTHLY' } as any);
    expect(res.ok).toBe(false);
    expect(t.calls).not.toContain('restoreSubscriptionByOrg');
    expect(t.calls).not.toContain('createAudit');
  });

  it('Restore refuses an open chargeback (only the dispute\'s Restore (won) may)', async () => {
    const t = build({ plan: null, dispute: { disputedAt: new Date(), disputeClearedAt: null } });
    const res = await t.service.restorePlan(ADMIN, { organizationId: 'org-1', reason: 'Ended by mistake here', tier: 'PRO', period: 'MONTHLY' } as any);
    expect(res).toMatchObject({ ok: false, reason: expect.stringMatching(/chargeback/) });
    expect(t.calls).not.toContain('restoreSubscriptionByOrg');
  });

  it('a cancelled or expired Razorpay subscription does not block a restore', async () => {
    const t = build({ plan: null, remote: [{ id: 'sub_y', status: 'cancelled' }, { id: 'sub_z', status: 'expired' }] });
    const res = await t.service.restorePlan(ADMIN, { organizationId: 'org-1', reason: 'Ended by mistake here', tier: 'PRO', period: 'MONTHLY' } as any);
    expect(res.ok).toBe(true);
  });
});
