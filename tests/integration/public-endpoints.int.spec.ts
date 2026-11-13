/**
 * The unauthenticated /public/* endpoints the marketing site and emails use:
 * the pricing context the cached /pricing page asks for, the contact form
 * (support ticket), the drip unsubscribe link, the landing beacon and the
 * public post preview.
 */
import { randomUUID } from 'crypto';
import { startApp, TestApp } from './setup/app';
import { uniqueEmail } from './setup/api';
import { addChannel, db, disconnectDb, givePlan } from './setup/db';
import { clearResendSends, resendSends, resendSendsTo } from './setup/fake.resend';
import { dripUnsubscribeToken, dripUnsubscribeCode } from '@hookpost/nestjs-libraries/emails/drip-unsubscribe';

describe('public endpoints', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  describe('GET /public/pricing-context', () => {
    it('rupees by default, never cached', async () => {
      const res = await t.api.get('/public/pricing-context');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(JSON.stringify(res.body)).toContain('INR');
    });

    it('a visitor abroad is still charged rupees while dollar checkout is off', async () => {
      const res = await t.api.get('/public/pricing-context?tz=America/New_York', {
        headers: { 'cf-ipcountry': 'US' },
      });
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain('INR');
    });
  });

  describe('POST /public/contact', () => {
    beforeEach(() => clearResendSends());

    it('stores a support ticket and answers with its reference', async () => {
      const email = uniqueEmail('contact');
      const message = 'My invoice shows the wrong GSTIN, please fix.';
      const res = await t.api.post(
        '/public/contact',
        { name: 'Asha', email, topic: 'Billing', message },
        { headers: { 'cf-connecting-ip': '203.0.113.7' } }
      );
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.ref).toBeTruthy();
      const row = await db().contactMessage.findFirstOrThrow({ where: { email } });
      expect(row).toMatchObject({ topic: 'Billing', ip: '203.0.113.7', state: 'NEW', emailSent: true });

      // Two emails through Resend: the ticket to the support inbox (a reply
      // goes to the customer), and an auto-reply to the customer.
      const sends = resendSends();
      expect(sends).toHaveLength(2);
      const [internal] = sends.filter((m) => m.to === process.env.EMAIL_FROM_ADDRESS);
      expect(internal).toMatchObject({ reply_to: email });
      expect(internal.text).toContain(message);
      const [auto] = resendSendsTo(email);
      expect(auto).toMatchObject({ reply_to: 'support@hookstep.in' });
      expect(auto.subject).toContain(res.body.ref);
      // The auto-reply goes to an unverified address, so it never repeats
      // what was typed: the form cannot relay someone else's text.
      expect(`${auto.subject} ${auto.text} ${auto.html}`).not.toContain(message);
    });

    it('a double submit returns the first ticket instead of a second one', async () => {
      const email = uniqueEmail('dupe');
      const body = { email, message: 'Exactly the same message twice.' };
      const a = await t.api.post('/public/contact', body, { headers: { 'cf-connecting-ip': '203.0.113.8' } });
      const b = await t.api.post('/public/contact', body, { headers: { 'cf-connecting-ip': '203.0.113.8' } });
      expect(b.body.ref).toBe(a.body.ref);
      expect(await db().contactMessage.count({ where: { email } })).toBe(1);
    });

    it('the honeypot field silently drops a bot', async () => {
      const email = uniqueEmail('bot');
      const res = await t.api.post('/public/contact', {
        email,
        message: 'Buy cheap followers now!!!',
        website: 'http://spam.example',
      });
      expect(res.body).toEqual({ ok: true });
      expect(await db().contactMessage.count({ where: { email } })).toBe(0);
      expect(resendSends()).toEqual([]);
    });

    it.each([
      ['no email', { message: 'A long enough message here.' }, /email/],
      ['bad email', { email: 'nope', message: 'A long enough message here.' }, /email/],
      ['short message', { email: 'a@b.co', message: 'hi' }, /more/],
    ])('refuses %s with a readable error', async (_label, body, error) => {
      const res = await t.api.post('/public/contact', body);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(error);
    });
  });

  describe('drip unsubscribe link', () => {
    it('GET shows a confirm page and changes nothing (link scanners)', async () => {
      const s = await t.api.register();
      const { id } = await s.self();
      const token = dripUnsubscribeToken(id);
      const res = await t.api.get(`/public/email/unsubscribe?t=${encodeURIComponent(token)}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<form method="post"');
      expect(await db().usedCodes.count({ where: { code: dripUnsubscribeCode(id) } })).toBe(0);
    });

    it('POST (one-click) unsubscribes; undo from the page subscribes again', async () => {
      const s = await t.api.register();
      const { id } = await s.self();
      const token = encodeURIComponent(dripUnsubscribeToken(id));
      const one = await t.api.post(`/public/email/unsubscribe?t=${token}`);
      expect(one.status).toBe(200);
      expect(one.body).toEqual({ ok: true });
      expect(await db().usedCodes.count({ where: { code: dripUnsubscribeCode(id) } })).toBe(1);

      const undo = await t.api.post(`/public/email/unsubscribe?t=${token}&undo=1&via=page`);
      expect(undo.status).toBe(200);
      expect(undo.text).toContain('subscribed again');
      expect(await db().usedCodes.count({ where: { code: dripUnsubscribeCode(id) } })).toBe(0);
    });

    it('a forged token is refused', async () => {
      const bad = `${randomUUID()}.not-the-signature`;
      expect((await t.api.get(`/public/email/unsubscribe?t=${bad}`)).status).toBe(400);
      const post = await t.api.post(`/public/email/unsubscribe?t=${bad}`);
      expect(post.status).toBe(400);
      expect(post.body).toEqual({ ok: false, error: 'invalid_token' });
    });
  });

  describe('POST /public/t (landing beacon)', () => {
    it('sets a first-party track cookie and answers its id', async () => {
      const res = await t.api.post('/public/t', { tt: 'ViewContent', additional: {} });
      expect(res.status).toBe(200);
      expect(res.body.track).toMatch(/^\w{10}$/);
      expect(res.headers.getSetCookie().join(';')).toContain(`track=${res.body.track}`);
    });

    it('never fails the page when tracking is unconfigured or broken', async () => {
      const res = await t.api.post('/public/t', { tt: 'NotAnEvent', additional: { x: 1 }, fbclid: 'fb.1' });
      expect(res.status).toBe(200);
    });
  });

  describe('public post preview /public/posts/:id', () => {
    it('shows a post by id without a login', async () => {
      const s = await t.api.register();
      const { orgId } = await s.self();
      await givePlan(orgId, 'STANDARD');
      const channel = await addChannel(orgId, 'bluesky');
      const post = await db().post.create({
        data: {
          organizationId: orgId,
          integrationId: channel.id,
          content: '<p>Preview me</p>',
          group: `preview-${orgId}`,
          publishDate: new Date(),
        },
      });
      const res = await t.api.get(`/public/posts/${post.id}`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain('Preview me');
      // No credentials of the channel in a public response.
      expect(JSON.stringify(res.body)).not.toContain(channel.token);

      const comments = await t.api.get(`/public/posts/${post.id}/comments`);
      expect(comments.status).toBe(200);
      expect(comments.body).toEqual({ comments: [] });
    });

    it('an unknown id answers without a 5xx', async () => {
      const res = await t.api.get('/public/posts/does-not-exist');
      expect(res.status).toBeLessThan(500);
    });
  });

  describe('POST /public/modify-subscription', () => {
    it('refuses a token that is not signed by us', async () => {
      const res = await t.api.post('/public/modify-subscription', { params: 'not-a-jwt' });
      expect(res.body).toEqual({ success: false });
    });

    // An invite (or any other token) replayed here: tokens.int.spec.ts.
  });
});
