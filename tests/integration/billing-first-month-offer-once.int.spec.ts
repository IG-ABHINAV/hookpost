/**
 * The first-month offer once per person (owner, 29 Oct 2026;
 * SubscriptionService.personHadBefore, first.month.offer.ts), end to end
 * through the real backend, Postgres and an in-memory Razorpay
 * (FakeRazorpay): a workspace gets the offer only if nobody behind it
 * (owner email however spelled, channel, UPI VPA or card) ever had a paid
 * plan or the offer, deleted accounts and workspaces included. The pricing
 * context and the checkout agree, so the price shown is the price charged.
 * Then the tricks: plus/dots/case, a channel reconnected after paying, a
 * channel removed before checkout, a deleted account, a deleted workspace,
 * two tabs. Then billing-identity.migration.sql applied twice.
 *
 *   pnpm exec jest -c tests/integration/jest.config.ts billing-first-month-offer-once
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { addChannel, db, disconnectDb, makeSuperAdmin } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';
import { TEST_DATABASE_URL } from './setup/test-env';
import { billingIdentityHash } from '@hookpost/nestjs-libraries/services/razorpay.mapping';

const UPI_OFFER = process.env.RAZORPAY_OFFER_FIRST_MONTH_UPI!;
const ROOT = join(__dirname, '..', '..');
const PRISMA = join(ROOT, 'node_modules', '.bin', 'prisma');
const SCHEMA = join(ROOT, 'libraries/nestjs-libraries/src/database/prisma/schema.prisma');
const MIGRATION = join(ROOT, 'libraries/nestjs-libraries/src/database/prisma/billing-identity.migration.sql');

let people = 0;
/** A fresh Gmail local part per test, so no two tests share a person. */
const person = () => `pers${Date.now().toString(36)}${people++}`;

describe('first-month offer: once per person', () => {
  let t: TestApp;
  let rzp: FakeRazorpay;
  const secret = () => process.env.RAZORPAY_WEBHOOK_SECRET!;
  const savedExempt = process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS;

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    t = await startApp();
  });
  afterEach(() => {
    if (savedExempt === undefined) delete process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS;
    else process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = savedExempt;
  });
  afterAll(async () => {
    rzp.uninstall();
    await t?.close();
    await disconnectDb();
  });

  const postWebhook = async (event: string, entities: Record<string, any>) => {
    const signed = FakeRazorpay.signedEvent(event, entities, secret());
    const res = await t.api.request('POST', '/razorpay/webhook', {
      raw: signed.raw,
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signed.signature },
    });
    expect(res.status).toBeLessThan(300);
    return res;
  };

  /** A new workspace whose next plan is charged at checkout (no trial). */
  async function workspace(email: string): Promise<{ s: Session; orgId: string }> {
    const s = await t.api.register({ email });
    const { orgId } = await s.self();
    await db().organization.update({ where: { id: orgId }, data: { allowTrial: false } });
    return { s, orgId };
  }

  async function checkout(s: Session, body: Record<string, any> = {}) {
    const res = await s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY', payWith: 'upi', ...body });
    if (res.status !== 201) throw new Error(`embedded ${res.status} ${res.text}`);
    return res.body as { subscriptionId: string; firstMonthOffer: 'upi' | 'card' | null };
  }

  /** The customer approves and pays the checkout; Razorpay's webhooks arrive. */
  async function pay(subscriptionId: string, method: { vpa?: string; card?: any } = { vpa: 'payer@ybl' }) {
    const live = rzp.authorise(subscriptionId, { method: method.card ? 'card' : 'upi' });
    const payment = { ...rzp.charge(subscriptionId), ...method };
    await postWebhook('subscription.activated', { subscription: live });
    await postWebhook('subscription.charged', { subscription: live, payment });
    return { live, payment };
  }

  const offerTerms = async (s: Session) => (await s.get('/billing/pricing-context')).body.firstMonthOffer;
  const rows = (organizationId: string) =>
    db().billingIdentity.findMany({ where: { organizationId }, orderBy: { kind: 'asc' } });

  /** A paid workspace (with the offer) for `email`: the person who has had it. */
  async function paidWorkspace(email: string, method?: { vpa?: string; card?: any }) {
    const w = await workspace(email);
    const out = await checkout(w.s);
    expect(out.firstMonthOffer).toBe('upi');
    const paid = await pay(out.subscriptionId, method);
    return { ...w, ...paid, subscriptionId: out.subscriptionId };
  }

  describe('the no-guard path and what a payment leaves on file', () => {
    it('a new person: offer on the pricing page and on the subscription', async () => {
      const { s } = await workspace(`${person()}@gmail.com`);
      expect(await offerTerms(s)).toEqual({ percent: 20, capInr: 400, methods: ['upi', 'card'] });
      const out = await checkout(s);
      expect(out.firstMonthOffer).toBe('upi');
      expect(rzp.subscriptions.get(out.subscriptionId).offer_id).toBe(UPI_OFFER);
    });

    it('the offer charge records the workspace, the owner identity and the VPA, hashed', async () => {
      const p = person();
      const a = await paidWorkspace(`${p}@gmail.com`, { vpa: `${p}@OKHDFC` });
      const on = await rows(a.orgId);
      expect(on.map((r) => [r.kind, r.source])).toEqual([
        ['EMAIL', 'OFFER'],
        ['UPI', 'OFFER'],
        ['WORKSPACE', 'OFFER'],
      ]);
      expect(on.find((r) => r.kind === 'UPI')!.hash).toBe(billingIdentityHash('UPI', `${p}@okhdfc`));
      expect(on.every((r) => r.subscriptionId === a.subscriptionId)).toBe(true);
      expect(JSON.stringify(on)).not.toContain(p);
    });

    it('redelivered webhooks write nothing twice', async () => {
      const a = await paidWorkspace(`${person()}@gmail.com`);
      const before = (await rows(a.orgId)).length;
      await postWebhook('subscription.charged', { subscription: a.live, payment: a.payment });
      await postWebhook('subscription.charged', { subscription: a.live, payment: a.payment });
      expect((await rows(a.orgId)).length).toBe(before);
    });

    it('the second month is PAID, not OFFER', async () => {
      const a = await paidWorkspace(`${person()}@gmail.com`);
      const sub = rzp.subscriptions.get(a.subscriptionId);
      sub.paid_count = 2;
      await postWebhook('subscription.charged', {
        subscription: { ...sub },
        payment: { ...rzp.charge(a.subscriptionId), vpa: 'payer@ybl' },
      });
      expect((await rows(a.orgId)).filter((r) => r.source === 'PAID').map((r) => r.kind).sort()).toEqual([
        'EMAIL',
        'UPI',
        'WORKSPACE',
      ]);
    });
  });

  describe('the guards: no offer, and the page says so before checkout', () => {
    it.each([
      ['a +tag', (p: string) => `${p}+again@gmail.com`],
      ['dots and capitals', (p: string) => `${p.slice(0, 2)}.${p.slice(2).toUpperCase()}@Gmail.com`],
      ['googlemail.com', (p: string) => `${p}@googlemail.com`],
    ])('the owner paid before under %s', async (_n, spell) => {
      const p = person();
      await paidWorkspace(`${p}@gmail.com`);
      const b = await workspace(spell(p));
      expect(await offerTerms(b.s)).toBeNull();
      const out = await checkout(b.s);
      expect(out.firstMonthOffer).toBeNull();
      expect(rzp.subscriptions.get(out.subscriptionId).offer_id).toBeNull();
    });

    it('a +tag on a company domain counts too; a different person at that domain does not', async () => {
      const p = person();
      await paidWorkspace(`${p}@acme-${p}.in`);
      expect(await offerTerms((await workspace(`${p}+2@acme-${p}.in`)).s)).toBeNull();
      expect(await offerTerms((await workspace(`other${p}@acme-${p}.in`)).s)).not.toBeNull();
    });

    it('the same workspace buying again after its plan ended', async () => {
      const a = await paidWorkspace(`${person()}@gmail.com`);
      await db().subscription.update({ where: { organizationId: a.orgId }, data: { deletedAt: new Date() } });
      expect(await offerTerms(a.s)).toBeNull();
      expect((await checkout(a.s)).firstMonthOffer).toBeNull();
    });

    it('a channel connected in a workspace that paid, even one connected after it paid', async () => {
      const a = await paidWorkspace(`${person()}@gmail.com`);
      const acct = `li-${person()}`;
      await addChannel(a.orgId, 'linkedin', { internalId: acct });
      const b = await workspace(`${person()}@gmail.com`);
      await addChannel(b.orgId, 'linkedin', { internalId: acct });
      expect(await offerTerms(b.s)).toBeNull();
      expect((await checkout(b.s)).firstMonthOffer).toBeNull();
    });

    it('removing the channel before checkout does not help', async () => {
      const a = await paidWorkspace(`${person()}@gmail.com`);
      const acct = `ig-${person()}`;
      await addChannel(a.orgId, 'instagram', { internalId: acct });
      const b = await workspace(`${person()}@gmail.com`);
      const ch = await addChannel(b.orgId, 'instagram', { internalId: acct });
      await db().integration.update({ where: { id: ch.id }, data: { deletedAt: new Date() } });
      expect(await offerTerms(b.s)).toBeNull();
    });

    it('the same account id on another network is another channel', async () => {
      const a = await paidWorkspace(`${person()}@gmail.com`);
      const acct = `same-${person()}`;
      await addChannel(a.orgId, 'linkedin', { internalId: acct });
      const b = await workspace(`${person()}@gmail.com`);
      await addChannel(b.orgId, 'x', { internalId: acct });
      expect(await offerTerms(b.s)).not.toBeNull();
    });

    it('a deleted workspace that paid still counts, through its channel', async () => {
      const a = await paidWorkspace(`${person()}@gmail.com`);
      const acct = `yt-${person()}`;
      await addChannel(a.orgId, 'youtube', { internalId: acct });
      await db().organization.update({ where: { id: a.orgId }, data: { deletedAt: new Date() } });
      await db().subscription.update({ where: { organizationId: a.orgId }, data: { deletedAt: new Date() } });
      const b = await workspace(`${person()}@gmail.com`);
      await addChannel(b.orgId, 'youtube', { internalId: acct });
      expect(await offerTerms(b.s)).toBeNull();
    });

    it("a deleted account that paid: its address is gone, the hashed identity row is not", async () => {
      const p = person();
      const a = await paidWorkspace(`${p}@gmail.com`);
      const me = await a.s.self();
      // What UsersRepository.deleteAccount leaves behind.
      const md5 = createHash('md5').update(`${p}@gmail.com`).digest('hex');
      await db().user.update({
        where: { id: me.id },
        data: { email: `deleted_${md5}_x1`, deletedAt: new Date() },
      });
      await db().organization.update({ where: { id: a.orgId }, data: { deletedAt: new Date() } });
      // Signing up again with a dot in it: neither the live users nor the
      // md5 of this spelling finds it, only the identity row.
      const b = await workspace(`${p.slice(0, 3)}.${p.slice(3)}@gmail.com`);
      expect(await offerTerms(b.s)).toBeNull();
    });

    it('a paid workspace whose row is gone altogether still counts, through its recorded rows', async () => {
      const p = person();
      const a = await paidWorkspace(`${p}@gmail.com`);
      const me = await a.s.self();
      await db().user.update({ where: { id: me.id }, data: { email: `gone_${p}`, deletedAt: new Date() } });
      await db().userOrganization.deleteMany({ where: { organizationId: a.orgId } });
      await db().subscription.deleteMany({ where: { organizationId: a.orgId } });
      await db().organization.delete({ where: { id: a.orgId } }).catch(async () => {
        // Rows the sign-up created that point at it (credits, attribution...).
        await db().$transaction([
          db().credits.deleteMany({ where: { organizationId: a.orgId } }),
          db().usedCodes.deleteMany({ where: { orgId: a.orgId } }),
        ]);
        await db().organization.delete({ where: { id: a.orgId } });
      });
      expect(await db().organization.findUnique({ where: { id: a.orgId } })).toBeNull();
      expect((await rows(a.orgId)).length).toBeGreaterThan(0);
      const b = await workspace(`${p}+back@gmail.com`);
      expect(await offerTerms(b.s)).toBeNull();
    });

    it('a UPI VPA this workspace has used that paid in another workspace', async () => {
      const p = person();
      await paidWorkspace(`${p}@gmail.com`, { vpa: `${p}@ybl` });
      const b = await workspace(`${person()}@gmail.com`);
      expect(await offerTerms(b.s)).not.toBeNull();
      // A mandate check B approved earlier, recorded as B's own method.
      await db().billingIdentity.create({
        data: { organizationId: b.orgId, kind: 'UPI', hash: billingIdentityHash('UPI', `${p}@ybl`), source: 'ATTEMPT' },
      });
      expect(await offerTerms(b.s)).toBeNull();
      expect((await checkout(b.s)).firstMonthOffer).toBeNull();
    });

    it('a card that paid elsewhere (network, last4, issuer, name), the name spelled differently', async () => {
      const p = person();
      await paidWorkspace(`${p}@gmail.com`, {
        card: { network: 'Visa', last4: '4111', issuer: 'HDFC', name: `Asha ${p}` },
      });
      const b = await workspace(`${person()}@gmail.com`);
      const [key] = [`visa|4111|HDFC|${createHash('sha256').update(`asha ${p}`).digest('hex')}`];
      await db().billingIdentity.create({
        data: { organizationId: b.orgId, kind: 'CARD', hash: billingIdentityHash('CARD', key), source: 'ATTEMPT' },
      });
      expect(await offerTerms(b.s)).toBeNull();
    });

    it('an admin who paid before, buying from a workspace someone new owns', async () => {
      const p = person();
      const a = await paidWorkspace(`${p}@gmail.com`);
      const b = await workspace(`${person()}@gmail.com`);
      // The owner of B has never paid: B is offered it...
      expect(await offerTerms(b.s)).not.toBeNull();
      // ...but not to A's owner, made an admin of B, at B's checkout.
      const me = await a.s.self();
      await db().userOrganization.create({ data: { userId: me.id, organizationId: b.orgId, role: 'ADMIN' } });
      const asAdmin = new Session(t.api, a.s.auth, a.s.email, a.s.password, b.orgId);
      expect(await offerTerms(asAdmin)).toBeNull();
      expect((await checkout(asAdmin)).firstMonthOffer).toBeNull();
    });

    it('a disposable email never gets it', async () => {
      const b = await workspace(`${person()}@mailinator.com`);
      expect(await offerTerms(b.s)).toBeNull();
      expect((await checkout(b.s)).firstMonthOffer).toBeNull();
    });

    it("someone else's workspace that only tried (no plan, no offer) does not count", async () => {
      const p = person();
      const a = await workspace(`${p}@gmail.com`);
      await checkout(a.s); // opened, never paid
      const acct = `fb-${p}`;
      await addChannel(a.orgId, 'facebook', { internalId: acct });
      const b = await workspace(`${p}+b@gmail.com`);
      await addChannel(b.orgId, 'facebook', { internalId: acct });
      expect(await offerTerms(b.s)).not.toBeNull();
    });
  });

  describe('a match found only after payment', () => {
    it('the offer charge stands, the method is stored, and the next workspace with it is refused', async () => {
      const shared = `${person()}@paytm`;
      await paidWorkspace(`${person()}@gmail.com`, { vpa: shared });
      // C looks new (other email, no channel) and pays the offer with the same VPA.
      const c = await workspace(`${person()}@gmail.com`);
      const out = await checkout(c.s);
      expect(out.firstMonthOffer).toBe('upi');
      const { payment } = await pay(out.subscriptionId, { vpa: shared });
      expect(payment.amount).toBe(59900); // the fake charges the plan; Razorpay applies the offer
      expect(rzp.subscriptions.get(out.subscriptionId).status).toBe('active'); // nothing undone
      expect((await rows(c.orgId)).map((r) => r.kind)).toContain('UPI');
      // D: C's owner opens another workspace under a +tag: refused (C had the offer).
      const cEmail = (await c.s.self()).email as string;
      const d = await workspace(cEmail.replace('@', '+d@'));
      expect(await offerTerms(d.s)).toBeNull();
    });
  });

  describe('two tabs', () => {
    it("the older open offer checkout of the same person's other workspace is cancelled; the newest keeps the offer", async () => {
      const p = person();
      const a = await workspace(`${p}@gmail.com`);
      const b = await workspace(`${p}+tab2@gmail.com`);
      const first = await checkout(a.s);
      const second = await checkout(b.s);
      expect(first.firstMonthOffer).toBe('upi');
      expect(second.firstMonthOffer).toBe('upi');
      expect(rzp.subscriptions.get(first.subscriptionId).status).toBe('cancelled');
      expect(rzp.subscriptions.get(second.subscriptionId).status).toBe('created');
    });

    it('the first tab was paid and its webhook has not arrived: the second gets no offer', async () => {
      const p = person();
      const a = await workspace(`${p}@gmail.com`);
      const b = await workspace(`${p}+tab2@gmail.com`);
      const first = await checkout(a.s);
      rzp.authorise(first.subscriptionId, { method: 'upi' }); // paid at Razorpay, no webhook yet
      const second = await checkout(b.s);
      expect(second.firstMonthOffer).toBeNull();
      expect(rzp.subscriptions.get(second.subscriptionId).offer_id).toBeNull();
      expect(rzp.subscriptions.get(first.subscriptionId).status).toBe('active');
    });
  });

  describe('workspaces the rule leaves alone', () => {
    it('one of our own (a platform super admin is a member) still gets it', async () => {
      const p = person();
      await paidWorkspace(`${p}@gmail.com`);
      const b = await workspace(`${p}+internal@gmail.com`);
      await makeSuperAdmin((await b.s.self()).id);
      expect(await offerTerms(b.s)).not.toBeNull();
    });

    it('an exempt workspace (FREE_PLAN_SUNSET_EXEMPT_ORGS) that paid never counts against a customer', async () => {
      const p = person();
      const a = await paidWorkspace(`${p}@gmail.com`);
      process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = a.orgId;
      const b = await workspace(`${p}+2@gmail.com`);
      expect(await offerTerms(b.s)).not.toBeNull();
    });

    it('a lifetime deal or a marketplace workspace is not a paid plan here', async () => {
      const p = person();
      const life = await workspace(`${p}@gmail.com`);
      await db().subscription.create({
        data: {
          organizationId: life.orgId,
          subscriptionTier: 'PRO',
          period: 'YEARLY',
          totalChannels: 20,
          isLifetime: true,
          identifier: `sub_life_${p}`,
        },
      });
      await db().organization.update({ where: { id: life.orgId }, data: { isTrailing: false } });
      expect(await offerTerms((await workspace(`${p}+1@gmail.com`)).s)).not.toBeNull();

      const q = person();
      const mkt = await paidWorkspace(`${q}@gmail.com`);
      await db().organization.update({ where: { id: mkt.orgId }, data: { source: 'API_MARKET' } });
      expect(await offerTerms((await workspace(`${q}+1@gmail.com`)).s)).not.toBeNull();
    });
  });
});

describe('billing-identity.migration.sql', () => {
  const PG_SCHEMA = 'billing_identity_migration_check';
  const withSchema = (url: string, schema: string) => {
    const u = new URL(url);
    u.searchParams.set('schema', schema);
    return u.toString();
  };
  const url = withSchema(TEST_DATABASE_URL, PG_SCHEMA);
  let client: PrismaClient;

  beforeAll(async () => {
    // Today's production schema: schema.prisma without the new model.
    const before = readFileSync(SCHEMA, 'utf8').replace(
      /\n\/\/ What a workspace's people and payment methods have had[\s\S]*?\nmodel BillingIdentity \{[\s\S]*?\n\}\n/,
      '\n'
    );
    expect(before).not.toContain('BillingIdentity');
    const beforeFile = join(mkdtempSync(join(tmpdir(), 'billing-identity-migration-')), 'before.prisma');
    writeFileSync(beforeFile, before);
    execFileSync(
      PRISMA,
      ['db', 'push', '--schema', beforeFile, '--skip-generate', '--force-reset', '--accept-data-loss'],
      { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' }
    );
    client = new PrismaClient({ datasources: { db: { url } } });
    await client.$executeRawUnsafe(
      `INSERT INTO "${PG_SCHEMA}"."Organization" ("id", "name", "updatedAt") VALUES ('org-before-migration', 'Existing', now())`
    );
  }, 120_000);

  afterAll(async () => {
    await client?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${PG_SCHEMA}" CASCADE`).catch(() => undefined);
    await client?.$disconnect();
  });

  const apply = () => {
    try {
      execFileSync('psql', ['--version'], { stdio: 'pipe' });
    } catch {
      execFileSync(PRISMA, ['db', 'execute', '--url', url, '--file', MIGRATION], { stdio: 'pipe' });
      return;
    }
    execFileSync('psql', [TEST_DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', MIGRATION], {
      env: { ...process.env, PGOPTIONS: `-c search_path=${PG_SCHEMA}` },
      stdio: 'pipe',
    });
  };

  const diff = () => {
    try {
      execFileSync(PRISMA, ['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', SCHEMA, '--exit-code'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
      });
      return 0;
    } catch (e: any) {
      return e.status;
    }
  };

  it('applies twice cleanly, and leaves the database exactly as schema.prisma says', async () => {
    expect(diff()).toBe(2);
    apply();
    apply();
    expect(diff()).toBe(0);
    const orgs = await client.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "${PG_SCHEMA}"."Organization"`);
    expect(orgs.map((r) => r.id)).toEqual(['org-before-migration']);
  }, 120_000);
});
