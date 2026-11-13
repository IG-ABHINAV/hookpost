/**
 * Per-affiliate deals end to end (3 Nov 2026): new affiliates on 30% for 12
 * months, an admin setting a percent and a duration (or "while partner
 * active") in /admin/affiliates, terms fixed on each referral so a change
 * never cuts a customer already referred, and the hand-applied
 * affiliate-deal-terms.migration.sql.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb, makeSuperAdmin } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';

describe('affiliate deal terms', () => {
  let t: TestApp;
  let rzp: FakeRazorpay;
  let admin: Session;
  const secret = () => process.env.RAZORPAY_WEBHOOK_SECRET!;

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

  const postWebhook = (event: string, entities: Record<string, any>) => {
    const s = FakeRazorpay.signedEvent(event, entities, secret());
    return t.api.request('POST', '/razorpay/webhook', {
      raw: s.raw,
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': s.signature },
    });
  };

  async function newAffiliate() {
    const s = await t.api.register();
    await s.post('/affiliates/join', {});
    const row = await db().affiliate.findFirstOrThrow({ where: { email: s.email } });
    return { session: s, affiliate: row };
  }

  /** A customer referred by `code`; `charge()` posts one signed charge of `amount` paise. */
  async function referredCharge(code: string, amount = 59900) {
    const s = await t.api.register();
    const self = (await s.get('/user/self', { cookies: { hp_ref: code } })).body;
    await db().organization.update({ where: { id: self.orgId }, data: { allowTrial: false } });
    const res = await s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY' });
    const live = rzp.authorise(res.body.subscriptionId, { method: 'upi' });
    return {
      orgId: self.orgId as string,
      charge: async () => {
        await postWebhook('subscription.charged', { subscription: live, payment: rzp.charge(live.id, amount) });
        return db().affiliateCommission.findMany({ where: { organizationId: self.orgId }, orderBy: { createdAt: 'asc' } });
      },
    };
  }

  const setTerms = (s: Session, id: string, body: any) => s.post(`/affiliates/admin/${id}/terms`, body);

  it('a new affiliate is on 30% for 12 months, and the admin overview shows it', async () => {
    const { affiliate } = await newAffiliate();
    expect(affiliate).toMatchObject({ commissionPercent: 30, commissionMonths: 12 });
    const row = (await admin.get('/affiliates/admin')).body.affiliates.find((a: any) => a.id === affiliate.id);
    expect(row).toMatchObject({ commissionPercent: 30, commissionMonths: 12 });
  });

  it('only a super admin sets terms, only as JSON, and only within limits', async () => {
    const { session, affiliate } = await newAffiliate();
    expect((await setTerms(session, affiliate.id, { commissionPercent: 50 })).status).toBe(403);
    const form = await admin.request('POST', `/affiliates/admin/${affiliate.id}/terms`, {
      raw: 'commissionPercent=50',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.status).toBeGreaterThanOrEqual(400);
    for (const body of [{ commissionPercent: 51 }, { commissionPercent: 0 }, { commissionMonths: -1 }, { commissionMonths: 121 }, { commissionPercent: '40' }, {}]) {
      expect((await setTerms(admin, affiliate.id, body)).status).toBe(400);
    }
    expect((await setTerms(admin, 'no-such-affiliate', { commissionPercent: 40 })).status).toBe(400);
    expect(await db().affiliate.findUniqueOrThrow({ where: { id: affiliate.id } })).toMatchObject({
      commissionPercent: 30,
      commissionMonths: 12,
    });
  });

  it('40% while partner active: fixed on the referral, still paid years later', async () => {
    const { affiliate } = await newAffiliate();
    const res = await setTerms(admin, affiliate.id, { commissionPercent: 40, commissionMonths: 0 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: affiliate.id, commissionPercent: 40, commissionMonths: 0 });

    const c = await referredCharge(affiliate.code);
    const referral = await db().affiliateReferral.findUniqueOrThrow({ where: { organizationId: c.orgId } });
    expect(referral).toMatchObject({ commissionPercent: 40, commissionMonths: 0 });
    await db().affiliateReferral.update({
      where: { organizationId: c.orgId },
      data: { createdAt: new Date(Date.now() - 3 * 365 * 86400_000) },
    });
    expect(await c.charge()).toEqual([expect.objectContaining({ commission: 23960 })]);
  });

  it('lowering a deal never cuts a customer already referred', async () => {
    const { affiliate } = await newAffiliate();
    await setTerms(admin, affiliate.id, { commissionPercent: 40, commissionMonths: 0 });
    const before = await referredCharge(affiliate.code);
    await setTerms(admin, affiliate.id, { commissionPercent: 20, commissionMonths: 6 });
    const after = await referredCharge(affiliate.code);

    expect((await before.charge())[0].commission).toBe(23960);
    expect((await after.charge())[0].commission).toBe(11980);
  });

  it('affiliate-deal-terms.migration.sql: backfills existing referrals once, sets the default; the rollback undoes it', async () => {
    const file = (name: string) =>
      readFileSync(join(__dirname, '../../libraries/nestjs-libraries/src/database/prisma', name), 'utf8');
    const sql = file('affiliate-deal-terms.migration.sql');
    const rollback = file('affiliate-deal-terms.rollback.sql');
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      // Production's shape before: no referral columns, default 0, lifetime rows.
      await pg.query('ALTER TABLE "AffiliateReferral" DROP COLUMN "commissionPercent", DROP COLUMN "commissionMonths"');
      await pg.query('ALTER TABLE "Affiliate" ALTER COLUMN "commissionMonths" SET DEFAULT 0');
      const { affiliate: aff } = await newAffiliate();
      await pg.query('UPDATE "Affiliate" SET "commissionMonths" = 0, "commissionPercent" = 35 WHERE id = $1', [aff.id]);
      const orgId = (await (await t.api.register()).self()).orgId;
      await pg.query(
        'INSERT INTO "AffiliateReferral" (id, "affiliateId", "organizationId") VALUES ($1, $2, $3)',
        [`ref-mig-${Date.now()}`, aff.id, orgId]
      );

      await pg.query(sql);
      const terms = async () =>
        (await pg.query('SELECT "commissionPercent", "commissionMonths" FROM "AffiliateReferral" WHERE "organizationId" = $1', [orgId])).rows[0];
      expect(await terms()).toEqual({ commissionPercent: 35, commissionMonths: 0 });

      // A later change to the affiliate, then a re-run: the referral keeps its terms.
      await pg.query('UPDATE "Affiliate" SET "commissionMonths" = 6, "commissionPercent" = 20 WHERE id = $1', [aff.id]);
      await pg.query(sql);
      expect(await terms()).toEqual({ commissionPercent: 35, commissionMonths: 0 });
      const def = async () =>
        (await pg.query(
          `SELECT column_default FROM information_schema.columns WHERE table_name = 'Affiliate' AND column_name = 'commissionMonths'`
        )).rows[0].column_default;
      expect(await def()).toBe('12');

      await pg.query(rollback);
      await pg.query(rollback);
      expect(await def()).toBe('0');
      const cols = await pg.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'AffiliateReferral' AND column_name LIKE 'commission%'`
      );
      expect(cols.rows).toHaveLength(0);
    } finally {
      await pg.query(sql);
      await pg.end();
    }
  });
});
