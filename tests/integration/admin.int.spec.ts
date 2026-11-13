/**
 * The super-admin pages (/admin/*) and impersonation. Every admin endpoint is
 * refused to an ordinary user; a super admin sees users with their plan
 * state, stats, the contact inbox (read, reply by email, close) and a user's
 * journey, and can impersonate a workspace without being able to move money
 * as that person.
 */
import { startApp, TestApp } from './setup/app';
import { Session, uniqueEmail } from './setup/api';
import { db, disconnectDb, givePlan, makeSuperAdmin } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';

describe('admin', () => {
  let t: TestApp;
  let admin: Session;
  let customer: Session;

  beforeAll(async () => {
    t = await startApp();
    admin = await t.api.register({ company: 'Hookpost HQ' });
    await makeSuperAdmin((await admin.self()).id);
    customer = await t.api.register({ company: 'Customer Co' });
    await givePlan((await customer.self()).orgId, 'STANDARD');
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  const ADMIN_GETS = [
    '/admin/users',
    '/admin/stats',
    '/admin/errors',
    '/admin/errors/platforms',
    '/admin/contact-messages',
    '/admin/checkout-signals',
    '/admin/refunds/audit',
    '/admin/refunds/payments',
    '/admin/refunds/history',
    '/admin/refunds/history?scope=all',
    '/user/impersonate?name=a',
  ];

  it.each(ADMIN_GETS)('%s is refused to an ordinary user', async (path) => {
    const res = await customer.get(path);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('an ordinary user cannot make anyone a super admin', async () => {
    const { id } = await customer.self();
    const res = await customer.post(`/admin/users/${id}/super-admin`, { isSuperAdmin: true });
    expect(res.status).toBe(403);
    expect((await db().user.findUniqueOrThrow({ where: { id } })).isSuperAdmin).toBe(false);
  });

  it('GET /admin/users finds a customer with their plan state', async () => {
    const res = await admin.get(`/admin/users?search=${encodeURIComponent(customer.email)}`);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain(customer.email);
    expect(text).not.toContain('"password"');
  });

  it('GET /admin/stats answers for a date range', async () => {
    const res = await admin.get('/admin/stats?from=2026-01-01&to=2026-12-31');
    expect(res.status).toBe(200);
  });

  it('contact inbox: a ticket from the form, read, replied to by email, closed', async () => {
    const email = uniqueEmail('ticket');
    await t.api.post(
      '/public/contact',
      { email, message: 'Where is my invoice for October?' },
      { headers: { 'cf-connecting-ip': '198.51.100.40' } }
    );
    const list = await admin.get(`/admin/contact-messages?search=${encodeURIComponent(email)}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    const ticket = list.body.messages[0];
    expect(ticket).toMatchObject({ email, state: 'NEW' });
    expect(ticket.ref).toBeTruthy();

    const one = await admin.get(`/admin/contact-messages/${ticket.id}`);
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).toContain('Where is my invoice');

    t.temporal.reset();
    const reply = await admin.post(`/admin/contact-messages/${ticket.id}/reply`, {
      body: 'It is attached to this email.',
    });
    expect(reply.status).toBe(201);

    const done = await admin.post(`/admin/contact-messages/${ticket.id}/state`, { state: 'DONE' });
    expect(done.status).toBe(201);
    expect((await db().contactMessage.findUniqueOrThrow({ where: { id: ticket.id } })).state).toBe('DONE');

    expect((await admin.post(`/admin/contact-messages/${ticket.id}/state`, { state: 'BOGUS' })).status).toBe(400);
    expect((await customer.get(`/admin/contact-messages/${ticket.id}`)).status).toBe(403);
  });

  it('super-admin toggle: grant to another user; cannot revoke your own', async () => {
    const other = await t.api.register();
    const { id } = await other.self();
    const grant = await admin.post(`/admin/users/${id}/super-admin`, { isSuperAdmin: true });
    expect(grant.status).toBe(201);
    expect((await db().user.findUniqueOrThrow({ where: { id } })).isSuperAdmin).toBe(true);
    await admin.post(`/admin/users/${id}/super-admin`, { isSuperAdmin: false });

    const self = await admin.self();
    const revokeSelf = await admin.post(`/admin/users/${self.id}/super-admin`, { isSuperAdmin: false });
    expect(revokeSelf.status).toBe(400);
  });

  // Red team, 2 Nov 2026: the auth cookie is SameSite=Lax, so a form on any
  // *.hookstep.in page, opened by a signed-in super admin, reaches the API.
  // These POSTs moved money or power and took form bodies.
  describe('CSRF: a super admin\'s form post from another page is refused (415)', () => {
    const form = (s: Session, path: string, raw: string) =>
      s.request('POST', path, {
        raw,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

    it('cannot make the attacker a super admin', async () => {
      const attacker = await t.api.register();
      const { id } = await attacker.self();
      const res = await form(admin, `/admin/users/${id}/super-admin`, 'isSuperAdmin=1');
      expect(res.status).toBe(415);
      expect((await db().user.findUniqueOrThrow({ where: { id } })).isSuperAdmin).toBe(false);
    });

    it('cannot create a coupon', async () => {
      const res = await form(admin, '/billing/admin/coupons', 'code=CSRF90&percentOff=90');
      expect(res.status).toBe(415);
      expect(await db().coupon.count({ where: { code: 'CSRF90' } })).toBe(0);
    });

    it('cannot give the impersonated workspace a free plan', async () => {
      const res = await form(admin, '/billing/add-subscription', 'subscription=ULTIMATE');
      expect(res.status).toBe(415);
    });

    it('cannot swap two accounts or start impersonating', async () => {
      expect((await form(admin, '/user/switch', 'id=someone')).status).toBe(415);
      expect((await form(admin, '/user/impersonate', 'id=someone')).status).toBe(415);
    });

    it('cannot reply from the support address', async () => {
      expect((await form(admin, '/admin/contact-messages/x/reply', 'body=hello%20there')).status).toBe(415);
    });

    it('cannot post an announcement to every user', async () => {
      const title = `CSRF ${Date.now()}`;
      const res = await form(admin, '/announcements', `title=${encodeURIComponent(title)}&description=Log%20in%20here`);
      expect(res.status).toBe(415);
      expect(await db().announcement.count({ where: { title } })).toBe(0);
    });

    it('cannot mark affiliate commissions paid', async () => {
      // ids[0]= parses to a list, so the form passes the DTO.
      expect((await form(admin, '/affiliates/admin/commissions/paid', 'ids%5B0%5D=a')).status).toBe(415);
    });
  });

  it('a user journey answers for a real user', async () => {
    const { id } = await customer.self();
    const res = await admin.get(`/admin/users/${id}/journey`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(customer.email);
  });

  describe('refund history (GET /admin/refunds/history, read-only)', () => {
    let rzp: FakeRazorpay;
    let orgId: string;
    const NOW = Math.floor(Date.now() / 1000);
    const payment = (id: string, notes: any, over: any = {}) => {
      const p = {
        id,
        entity: 'payment',
        amount: 69900,
        amount_refunded: 0,
        currency: 'INR',
        status: 'captured',
        method: 'upi',
        email: 'buyer@example.com',
        notes,
        created_at: NOW - 3 * 86400,
        ...over,
      };
      rzp.payments.set(id, p);
      return p;
    };

    beforeAll(async () => {
      orgId = (await customer.self()).orgId;
      rzp = new FakeRazorpay().install();
      payment('pay_IntHookpost001', { service: 'hookpost', orgId });
      payment('pay_IntVetNow00001', { service: 'vetnow' });
      payment('pay_IntOld00000001', { service: 'hookpost', orgId }, { created_at: NOW - 400 * 86400 });
    });
    afterAll(() => rzp?.uninstall());

    it("lists a dashboard refund on a Hookpost payment with its workspace; another product's is counted, not shown", async () => {
      const dash = rzp.refund('pay_IntHookpost001', 600, {
        notes: { comment: 'asked by email' },
        acquirer_data: { arn: null, rrn: '529412345678' },
        created_at: NOW - 60,
      });
      rzp.refund('pay_IntVetNow00001', 100, { notes: { comment: '' }, created_at: NOW - 120 });
      // Older than Razorpay's 180-day refund window: never asked for.
      rzp.refund('pay_IntOld00000001', 100, { created_at: NOW - 200 * 86400 });
      rzp.calls.length = 0;

      const res = await admin.get('/admin/refunds/history');
      expect(res.status).toBe(200);
      expect(res.body.refunds).toEqual([
        expect.objectContaining({
          id: dash.id,
          paymentId: 'pay_IntHookpost001',
          amount: 600,
          currency: 'INR',
          status: 'processed',
          reference: '529412345678',
          madeFrom: 'dashboard',
          reason: 'asked by email',
          hookpost: true,
          organizationId: orgId,
          organizationName: 'Customer Co',
          email: 'buyer@example.com',
          paymentAmount: 69900,
        }),
      ]);
      expect(res.body).toMatchObject({ scanned: 2, hidden: 1, hasMore: false });
      expect(res.body.to - res.body.from).toBe(180 * 86400);
      // Read-only: Razorpay was only ever read.
      expect(rzp.calls.length).toBeGreaterThan(0);
      expect(rzp.calls.every((c) => c.method === 'GET')).toBe(true);

      const all = await admin.get('/admin/refunds/history?scope=all');
      expect(all.body.hidden).toBe(0);
      expect(all.body.refunds.map((r: any) => r.paymentId).sort()).toEqual([
        'pay_IntHookpost001',
        'pay_IntVetNow00001',
      ]);
      const vet = all.body.refunds.find((r: any) => r.paymentId === 'pay_IntVetNow00001');
      expect(vet).toMatchObject({ hookpost: false, service: 'vetnow', organizationId: null, organizationName: null });
    });

    it('nonsense paging parameters fall back to safe ones instead of erroring', async () => {
      rzp.calls.length = 0;
      const res = await admin.get('/admin/refunds/history?skip=-5&count=abc&to=-1');
      expect(res.status).toBe(200);
      const listed = rzp.calls.find((c) => c.path.startsWith('/refunds?'))!.path;
      const q = new URLSearchParams(listed.split('?')[1]);
      expect(q.get('skip')).toBe('0');
      expect(q.get('count')).toBe('50');
      expect(Math.abs(Number(q.get('to')) - Math.floor(Date.now() / 1000))).toBeLessThan(60);

      rzp.calls.length = 0;
      await admin.get('/admin/refunds/history?count=100000');
      const big = rzp.calls.find((c) => c.path.startsWith('/refunds?'))!.path;
      expect(new URLSearchParams(big.split('?')[1]).get('count')).toBe('100');
    });

    it('impersonating changes nothing: still the whole history, read-only, never scoped to that workspace', async () => {
      // auth.middleware keeps isSuperAdmin while impersonating; only moving
      // money is refused then (assertNotImpersonating). Reading is the admin's.
      const userOrg = await db().userOrganization.findFirstOrThrow({ where: { organizationId: orgId } });
      rzp.calls.length = 0;
      const res = await admin.get('/admin/refunds/history?scope=all', { headers: { impersonate: userOrg.id } });
      expect(res.status).toBe(200);
      expect(res.body.refunds.map((r: any) => r.paymentId)).toContain('pay_IntVetNow00001');
      expect(rzp.calls.every((c) => c.method === 'GET')).toBe(true);
    });

    it("an ordinary user's impersonate header does not open it", async () => {
      const { orgId: adminOrg } = await admin.self();
      const userOrg = await db().userOrganization.findFirstOrThrow({ where: { organizationId: adminOrg } });
      rzp.calls.length = 0;
      const res = await customer.get('/admin/refunds/history', { headers: { impersonate: userOrg.id } });
      expect(res.status).toBe(403);
      expect(rzp.calls).toHaveLength(0);
    });
  });

  describe('impersonation', () => {
    it('a super admin sees the app as the customer', async () => {
      const found = await admin.get(`/user/impersonate?name=${encodeURIComponent(customer.email)}`);
      expect(found.status).toBe(200);
      const target = JSON.stringify(found.body);
      expect(target).toContain(customer.email);

      const { orgId } = await customer.self();
      const userOrg = await db().userOrganization.findFirstOrThrow({
        where: { organizationId: orgId },
      });
      const set = await admin.post('/user/impersonate', { id: userOrg.id });
      expect(set.status).toBe(201);
      expect(set.headers.get('impersonate')).toBe(userOrg.id);

      const as = await admin.get('/user/self', { headers: { impersonate: userOrg.id } });
      expect(as.status).toBe(200);
      expect(as.body.email).toBe(customer.email);
      expect(as.body.orgId).toBe(orgId);
      expect(as.body.impersonate).toBe(true);
    });

    it('an ordinary user\'s impersonate header is ignored', async () => {
      const { orgId } = await admin.self();
      const userOrg = await db().userOrganization.findFirstOrThrow({ where: { organizationId: orgId } });
      const res = await customer.get('/user/self', { headers: { impersonate: userOrg.id } });
      expect(res.body.email).toBe(customer.email);
      expect(res.body.orgId).not.toBe(orgId);
      expect(res.body.admin).toBe(false);
    });

    it('no refunds while impersonating', async () => {
      const { orgId } = await customer.self();
      const userOrg = await db().userOrganization.findFirstOrThrow({ where: { organizationId: orgId } });
      const res = await admin.post(
        '/admin/refunds',
        { paymentId: 'pay_ABCDEFGHIJ1234', amount: 100 },
        { headers: { impersonate: userOrg.id } }
      );
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/impersonating/i);
    });

    it('the account cannot be deleted while impersonating', async () => {
      const { orgId } = await customer.self();
      const userOrg = await db().userOrganization.findFirstOrThrow({ where: { organizationId: orgId } });
      const res = await admin.post('/user/delete-account', undefined, { headers: { impersonate: userOrg.id } });
      expect(res.status).toBe(400);
      const user = await db().user.findFirstOrThrow({ where: { email: customer.email } });
      expect(user.deletedAt).toBeNull();
    });
  });
});
