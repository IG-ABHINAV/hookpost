/**
 * Affiliate commission for the lifetime of the referred subscription
 * (owner's approval, 22 Oct 2026; it was 12 months), end to end through the
 * real backend and an in-memory Razorpay: a new affiliate is on lifetime
 * terms, a charge years after the referral still earns 30%, and the
 * hand-applied affiliate-lifetime.migration.sql backs up, moves existing
 * affiliates to lifetime and is idempotent.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';

describe('affiliate commission for the lifetime of the subscription', () => {
  let t: TestApp;
  let rzp: FakeRazorpay;
  const secret = () => process.env.RAZORPAY_WEBHOOK_SECRET!;

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    t = await startApp();
  });
  afterAll(async () => {
    rzp.uninstall();
    await t?.close();
    await disconnectDb();
  });

  const postWebhook = (event: string, entities: Record<string, any>) => {
    const signed = FakeRazorpay.signedEvent(event, entities, secret());
    return t.api.request('POST', '/razorpay/webhook', {
      raw: signed.raw,
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signed.signature },
    });
  };

  /** A workspace that has had its trial: its next plan is charged at checkout. */
  async function trialUsed(session: Session) {
    const { orgId } = await session.self();
    await db().organization.update({ where: { id: orgId }, data: { allowTrial: false } });
    return orgId;
  }

  async function subscribe(session: Session, body: Record<string, any>) {
    const res = await session.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY', ...body });
    if (res.status !== 201) throw new Error(`embedded ${res.status} ${res.text}`);
    return res.body as {
      subscriptionId: string;
      currency: string;
      startAt: number | null;
      firstMonthOffer: 'upi' | 'card' | null;
      keyId: string;
    };
  }

  describe('commission', () => {
    it('a new affiliate is on the standard 12 months (since 3 Nov 2026), and the dashboard says so', async () => {
      const owner = await t.api.register();
      const res = await owner.post('/affiliates/join', {});
      expect(res.status).toBe(201);
      expect(res.body.affiliate).toMatchObject({ commissionPercent: 30, commissionMonths: 12, couponPercent: 10 });
      const row = await db().affiliate.findFirstOrThrow({ where: { email: owner.email } });
      expect(row.commissionMonths).toBe(12);
    });

    it('a charge 30 months after the referral still earns 30%; an old 12-month row does not', async () => {
      const owner = await t.api.register();
      await owner.post('/affiliates/join', {});
      // An affiliate on lifetime ("while partner active") terms.
      const joined = await db().affiliate.findFirstOrThrow({ where: { email: owner.email } });
      const affiliate = await db().affiliate.update({ where: { id: joined.id }, data: { commissionMonths: 0 } });

      const s = await t.api.register();
      const orgId = await trialUsed(s);
      const longAgo = new Date(Date.now() - 30 * 31 * 86400 * 1000);
      await db().affiliateReferral.create({ data: { affiliateId: affiliate.id, organizationId: orgId, createdAt: longAgo } });

      const out = await subscribe(s, {});
      const live = rzp.authorise(out.subscriptionId, { method: 'upi' });
      await postWebhook('subscription.charged', { subscription: live, payment: rzp.charge(out.subscriptionId, 59900) });
      expect(await db().affiliateCommission.findMany({ where: { organizationId: orgId } })).toEqual([
        expect.objectContaining({ amount: 59900, commission: 17970 }),
      ]);

      // The same affiliate before the migration (12 months): no commission.
      await db().affiliate.update({ where: { id: affiliate.id }, data: { commissionMonths: 12 } });
      await postWebhook('subscription.charged', { subscription: live, payment: rzp.charge(out.subscriptionId, 59900) });
      expect(await db().affiliateCommission.count({ where: { organizationId: orgId } })).toBe(1);
    });

    it('affiliate-lifetime.migration.sql: backup, 12 -> 0, default 0, a second run changes nothing; the rollback restores', async () => {
      const file = (name: string) =>
        readFileSync(join(__dirname, '../../libraries/nestjs-libraries/src/database/prisma', name), 'utf8');
      const sql = file('affiliate-lifetime.migration.sql');
      const rollback = file('affiliate-lifetime.rollback.sql');
      const pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      try {
        await pg.query('DROP TABLE IF EXISTS "Affiliate_backup_20261022"');
        // Production's shape: the column default is still 12, and rows hold it.
        await pg.query('ALTER TABLE "Affiliate" ALTER COLUMN "commissionMonths" SET DEFAULT 12');
        const owner = await t.api.register();
        const other = await t.api.register();
        const ownerOrg = (await owner.self()).orgId;
        const otherOrg = (await other.self()).orgId;
        const ownerUser = (await owner.self()).id;
        const otherUser = (await other.self()).id;
        await db().affiliate.create({
          data: { userId: ownerUser, organizationId: ownerOrg, code: 'legacy12a', name: 'L', email: owner.email, commissionMonths: 12 },
        });
        await db().affiliate.create({
          data: { userId: otherUser, organizationId: otherOrg, code: 'deal6b', name: 'D', email: other.email, commissionMonths: 6 },
        });
        const before = await pg.query('SELECT count(*)::int AS n FROM "Affiliate"');

        await pg.query(sql);
        await pg.query(sql); // idempotent

        const months = async (code: string) =>
          (await pg.query('SELECT "commissionMonths" FROM "Affiliate" WHERE code = $1', [code])).rows[0].commissionMonths;
        expect(await months('legacy12a')).toBe(0);
        // A deal made by hand keeps its own window.
        expect(await months('deal6b')).toBe(6);
        const backup = await pg.query(
          'SELECT "commissionMonths" FROM "Affiliate_backup_20261022" WHERE code = $1',
          ['legacy12a']
        );
        expect(backup.rows[0].commissionMonths).toBe(12);
        expect((await pg.query('SELECT count(*)::int AS n FROM "Affiliate_backup_20261022"')).rows[0].n).toBe(
          before.rows[0].n
        );
        const def = await pg.query(
          `SELECT column_default FROM information_schema.columns WHERE table_name = 'Affiliate' AND column_name = 'commissionMonths'`
        );
        expect(def.rows[0].column_default).toBe('0');

        // A 12-month deal made by hand after the first run: a re-run leaves it.
        const later = await t.api.register();
        const laterSelf = await later.self();
        await db().affiliate.create({
          data: { userId: laterSelf.id, organizationId: laterSelf.orgId, code: 'deal12c', name: 'C', email: later.email, commissionMonths: 12 },
        });
        await pg.query(sql);
        expect(await months('deal12c')).toBe(12);
        expect(await months('legacy12a')).toBe(0);

        // The rollback: the backup's windows back, a lifetime row that joined
        // since gets the old 12 months, the default is 12 again.
        const joined = await t.api.register();
        const joinedSelf = await joined.self();
        await db().affiliate.create({
          data: { userId: joinedSelf.id, organizationId: joinedSelf.orgId, code: 'new0d', name: 'N', email: joined.email, commissionMonths: 0 },
        });
        await pg.query(rollback);
        await pg.query(rollback); // safe twice
        expect(await months('legacy12a')).toBe(12);
        expect(await months('deal6b')).toBe(6);
        expect(await months('deal12c')).toBe(12);
        expect(await months('new0d')).toBe(12);
        const restored = await pg.query(
          `SELECT column_default FROM information_schema.columns WHERE table_name = 'Affiliate' AND column_name = 'commissionMonths'`
        );
        expect(restored.rows[0].column_default).toBe('12');
      } finally {
        await pg.query('DROP TABLE IF EXISTS "Affiliate_backup_20261022"');
        await pg.query('ALTER TABLE "Affiliate" ALTER COLUMN "commissionMonths" SET DEFAULT 0');
        await pg.end();
      }
    });
  });
});
