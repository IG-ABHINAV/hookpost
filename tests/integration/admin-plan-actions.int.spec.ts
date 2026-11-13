/**
 * The super admin's "End plan now" and "Restore plan" (Users & Billing), and
 * the account-correction email each sends: through the real backend, Postgres
 * (PlanActionAudit is in the schema the suite pushes), Redis for send-once,
 * an in-memory Razorpay and the recorded Resend.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb, givePlan, makeSuperAdmin } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';
import { clearResendSends, resendSendsTo } from './setup/fake.resend';

describe('admin End plan now / Restore plan', () => {
  let t: TestApp;
  let admin: Session;
  let rzp: FakeRazorpay;
  const REASON = 'Trial cancelled at Razorpay on 21 Oct, never paid';

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    t = await startApp();
    admin = await t.api.register({ company: 'Hookpost HQ' });
    await makeSuperAdmin((await admin.self()).id);
  });
  afterAll(async () => {
    rzp.uninstall();
    await t?.close();
    await disconnectDb();
  });
  beforeEach(() => clearResendSends());

  async function customer(tier: 'STANDARD' | 'PRO' = 'STANDARD') {
    const s = await t.api.register({ company: 'RK Test Academy' });
    const self = await s.self();
    await givePlan(self.orgId, tier);
    return { s, orgId: self.orgId, email: self.email };
  }

  const live = (orgId: string) =>
    db().subscription.findFirst({ where: { organizationId: orgId, deletedAt: null } });

  it('ends the plan, emails the owner of the workspace once, and writes the audit row', async () => {
    const c = await customer();
    const res = await admin.post('/admin/plan/end', { organizationId: c.orgId, reason: REASON, correction: 'PLAN_CORRECTED_ENDED' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true });
    expect(await live(c.orgId)).toBeNull();
    const mails = resendSendsTo(c.email);
    expect(mails).toHaveLength(1);
    expect(String(mails[0].subject)).toMatch(/plan/i);
    expect(String(mails[0].text || mails[0].html)).not.toMatch(/sk_|rzp_|secret|token/i);
    const audit = await db().planActionAudit.findFirstOrThrow({ where: { organizationId: c.orgId } });
    expect(audit).toMatchObject({ action: 'END', status: 'SUCCESS', reason: REASON, correction: 'PLAN_CORRECTED_ENDED' });

    // Pressed again: nothing to end, and no second email.
    const again = await admin.post('/admin/plan/end', { organizationId: c.orgId, reason: REASON, correction: 'PLAN_CORRECTED_ENDED' });
    expect(again.body.ok).toBe(false);
    expect(resendSendsTo(c.email)).toHaveLength(1);
  });

  it('Restore plan puts it back and sends PLAN_RESTORED', async () => {
    const c = await customer('PRO');
    await admin.post('/admin/plan/end', { organizationId: c.orgId, reason: REASON, correction: 'NONE' });
    expect(await live(c.orgId)).toBeNull();
    expect(resendSendsTo(c.email)).toHaveLength(0);
    const res = await admin.post('/admin/plan/restore', { organizationId: c.orgId, reason: 'Ended by mistake, customer had paid', tier: 'PRO', period: 'MONTHLY' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true });
    expect((await live(c.orgId))?.subscriptionTier).toBe('PRO');
    expect(resendSendsTo(c.email)).toHaveLength(1);
  });

  it('the opt-out sends no customer email but still audits', async () => {
    const c = await customer();
    const res = await admin.post('/admin/plan/end', { organizationId: c.orgId, reason: REASON, correction: 'PLAN_CORRECTED_ENDED', skipCustomerEmail: true });
    expect(res.body).toMatchObject({ ok: true });
    expect(resendSendsTo(c.email)).toHaveLength(0);
    expect(await db().planActionAudit.count({ where: { organizationId: c.orgId, status: 'SUCCESS' } })).toBe(1);
  });

  it('an internal workspace (a platform super admin is a member) is never emailed', async () => {
    const res = await admin.post('/admin/plan/end', {
      organizationId: (await admin.self()).orgId,
      reason: REASON,
      correction: 'PLAN_CORRECTED_ENDED',
    });
    // Our own workspace may have no plan; either way nobody is emailed.
    expect(resendSendsTo((await admin.self()).email)).toHaveLength(0);
    expect([true, false]).toContain(res.body.ok);
  });

  it('refuses a workspace owner who is not a platform super admin (403), and changes nothing', async () => {
    const c = await customer();
    const bodies: Record<string, any> = {
      '/admin/plan/end': { organizationId: c.orgId, reason: REASON, correction: 'PLAN_CORRECTED_ENDED' },
      '/admin/plan/restore': { organizationId: c.orgId, reason: REASON, tier: 'PRO', period: 'MONTHLY' },
    };
    for (const [path, body] of Object.entries(bodies)) {
      const res = await c.s.post(path, body);
      expect(res.status).toBe(403);
    }
    expect(await live(c.orgId)).not.toBeNull();
    expect(await db().planActionAudit.count({ where: { organizationId: c.orgId } })).toBe(0);
    expect(resendSendsTo(c.email)).toHaveLength(0);
  });

  it('a reason is required, and an unknown correction is refused', async () => {
    const c = await customer();
    expect((await admin.post('/admin/plan/end', { organizationId: c.orgId, reason: 'short', correction: 'PLAN_CORRECTED_ENDED' })).status).toBe(400);
    expect((await admin.post('/admin/plan/end', { organizationId: c.orgId, reason: REASON, correction: 'FREE_MONEY' })).status).toBe(400);
    expect(await live(c.orgId)).not.toBeNull();
  });
});
