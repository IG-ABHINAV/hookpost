/**
 * The sign-in, sign-up, forgot-password and resend limits
 * (apps/backend/src/services/auth/auth.rate.limit.ts), through the real
 * controllers. On 1 Nov 2026, 12 wrong passwords in 5 s all answered 400.
 *
 * The visitor's address comes from CF-Connecting-IP, which nginx sets in
 * production (nginx.hookpost.conf, $trusted_client_ip). Each test uses its own
 * documentation-range addresses; requests without one come from loopback and
 * are only counted per email address. Limits live in the backend process, and
 * this file boots its own.
 */
import { generateKeyPairSync, randomUUID, sign } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { startApp, TestApp } from './setup/app';
import { uniqueEmail } from './setup/api';
import { disconnectDb } from './setup/db';

const PASSWORD = 'Correct-Horse-9';
/** Test passwords for this file: wrong guesses and a reset's new one. */
const WRONG = `${PASSWORD}-wrong`;
const NEW_PASSWORD = `${PASSWORD}-new`;
let ipSeq = 0;
/** A fresh visitor address for one test. */
const freshIp = () => `198.51.100.${++ipSeq}`;
const from = (ip: string) => ({ headers: { 'cf-connecting-ip': ip } });

describe('auth rate limits', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  const login = (email: string, password: string, ip?: string, extra: Record<string, string> = {}) =>
    t.api.post(
      '/auth/login',
      { email, password, provider: 'LOCAL' },
      { headers: { ...(ip ? { 'cf-connecting-ip': ip } : {}), ...extra } }
    );

  describe('POST /auth/login', () => {
    it('10 wrong passwords answer 400; the 11th attempt is 429 with a wait, even with the right password', async () => {
      const s = await t.api.register();
      const ip = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push((await login(s.email, WRONG, ip)).status);
      }
      expect(statuses).toEqual([...Array(10).fill(400), 429, 429]);

      const locked = await login(s.email, PASSWORD, freshIp());
      expect(locked.status).toBe(429);
      expect(locked.text).toBe(
        'Too many sign-in attempts. For your security, please wait 15 minutes and try again, or reset your password.'
      );
      expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(800);
      expect(locked.headers.get('auth')).toBeNull();
    });

    it('locks one address only: another account signs in from the same network', async () => {
      const victim = await t.api.register();
      const other = await t.api.register();
      const ip = freshIp();
      for (let i = 0; i < 10; i++) await login(victim.email, WRONG, ip);
      expect((await login(victim.email, PASSWORD, ip)).status).toBe(429);
      const ok = await login(other.email, PASSWORD, ip);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('auth')).toBeTruthy();
    });

    it('30 wrong passwords sent at once: no more than 12 are checked, the rest are 429', async () => {
      const s = await t.api.register();
      const statuses = await Promise.all(
        Array.from({ length: 30 }, () => login(s.email, WRONG, freshIp()).then((r) => r.status))
      );
      expect(statuses.filter((x) => x === 400).length).toBeLessThanOrEqual(12);
      expect(statuses.filter((x) => x === 429).length).toBeGreaterThanOrEqual(18);
      expect((await login(s.email, PASSWORD, freshIp())).status).toBe(429);
    });

    it('the address counts however it is typed', async () => {
      const s = await t.api.register();
      for (let i = 0; i < 10; i++) {
        await login(i % 2 ? `  ${s.email.toUpperCase()} ` : s.email, WRONG, freshIp());
      }
      expect((await login(s.email, PASSWORD, freshIp())).status).toBe(429);
    });

    it('a right password before the 10th failure clears the count', async () => {
      const s = await t.api.register();
      const ip = freshIp();
      for (let i = 0; i < 9; i++) await login(s.email, WRONG, ip);
      expect((await login(s.email, PASSWORD, ip)).status).toBe(200);
      for (let i = 0; i < 9; i++) expect((await login(s.email, WRONG, ip)).status).toBe(400);
      expect((await login(s.email, PASSWORD, ip)).status).toBe(200);
    });

    it('a device that signed in before still signs in while a stranger has the address locked', async () => {
      const s = await t.api.register();
      const home = freshIp();
      expect((await login(s.email, PASSWORD, home)).status).toBe(200);
      const stranger = freshIp();
      for (let i = 0; i < 10; i++) await login(s.email, WRONG, stranger);
      expect((await login(s.email, PASSWORD, stranger)).status).toBe(429);
      expect((await login(s.email, PASSWORD, freshIp())).status).toBe(429);
      expect((await login(s.email, PASSWORD, home)).status).toBe(200);
    });

    it('a password reset lifts the lock (the 429 says to reset)', async () => {
      const s = await t.api.register();
      for (let i = 0; i < 10; i++) await login(s.email, WRONG, freshIp());
      expect((await login(s.email, PASSWORD, freshIp())).status).toBe(429);
      t.temporal.reset();
      expect((await t.api.post('/auth/forgot', { email: s.email }, from(freshIp()))).status).toBe(201);
      const mail = t.temporal.emails().find((m) => m.to === s.email);
      const token = /\/auth\/forgot\/([A-Za-z0-9_\-.]+)/.exec(mail!.html)?.[1];
      const reset = await t.api.post('/auth/forgot-return', { token, password: NEW_PASSWORD, repeatPassword: NEW_PASSWORD });
      expect(reset.body).toEqual({ reset: true });
      expect((await login(s.email, NEW_PASSWORD, freshIp())).status).toBe(200);
    });

    it('one IP trying 50 addresses is locked out; a spoofed X-Client-IP or X-Forwarded-For does not get round it', async () => {
      const ip = freshIp();
      for (let i = 0; i < 50; i++) {
        expect((await login(uniqueEmail(`stuff${i}`), WRONG, ip)).status).toBe(400);
      }
      const s = await t.api.register();
      expect((await login(s.email, PASSWORD, ip)).status).toBe(429);
      expect(
        (await login(s.email, PASSWORD, ip, { 'x-client-ip': '203.0.113.200', 'x-forwarded-for': '203.0.113.201' })).status
      ).toBe(429);
      // The same account from elsewhere is fine.
      expect((await login(s.email, PASSWORD, freshIp())).status).toBe(200);
    });
  });

  describe('Google One Tap is never limited', () => {
    const CLIENT_ID = 'rate-limit-client.apps.googleusercontent.com';
    const KID = 'hookpost-rate-limit-key';
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const b64url = (v: object | Buffer) =>
      (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
    const credential = (claims: Record<string, unknown> = {}) => {
      const now = Math.floor(Date.now() / 1000);
      const head = `${b64url({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64url({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: `g-${randomUUID()}`,
        email: uniqueEmail('ratetap'),
        email_verified: true,
        name: 'Rate Tap',
        iat: now,
        exp: now + 600,
        ...claims,
      })}`;
      return `${head}.${b64url(sign('RSA-SHA256', Buffer.from(head), privateKey))}`;
    };
    let savedClientId: string | undefined;
    beforeAll(() => {
      savedClientId = process.env.YOUTUBE_CLIENT_ID;
      process.env.YOUTUBE_CLIENT_ID = CLIENT_ID;
      jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({
        certs: { [KID]: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
        format: 'PEM',
      } as any);
    });
    afterAll(() => {
      jest.restoreAllMocks();
      if (savedClientId === undefined) delete process.env.YOUTUBE_CLIENT_ID;
      else process.env.YOUTUBE_CLIENT_ID = savedClientId;
    });

    it('signs up and back in from a network whose password sign-ins are locked', async () => {
      const ip = freshIp();
      for (let i = 0; i < 50; i++) await login(uniqueEmail(`tap${i}`), WRONG, ip);
      expect((await login(uniqueEmail('tapcheck'), WRONG, ip)).status).toBe(429);

      const sub = `g-${randomUUID()}`;
      const email = uniqueEmail('ratetap');
      for (let i = 0; i < 12; i++) {
        const res = await t.api.post('/auth/oauth/google/one-tap', { credential: credential({ sub, email }) }, from(ip));
        expect(res.status).toBe(200);
        expect(res.body.login).toBe(true);
      }
    });
  });

  describe('POST /auth/register', () => {
    it('20 password sign-ups an hour per IP, then 429 with a sentence', async () => {
      const ip = freshIp();
      for (let i = 0; i < 20; i++) {
        const res = await t.api.post(
          '/auth/register',
          { email: uniqueEmail(`reg${i}`), password: PASSWORD, company: 'Rate Co', provider: 'LOCAL' },
          from(ip)
        );
        expect(res.status).toBe(200);
      }
      const res = await t.api.post(
        '/auth/register',
        { email: uniqueEmail('reg21'), password: PASSWORD, company: 'Rate Co', provider: 'LOCAL' },
        from(ip)
      );
      expect(res.status).toBe(429);
      expect(res.text).toBe('Too many attempts. Please wait 1 hour and try again.');
      // Another network is not affected.
      expect(
        (
          await t.api.post(
            '/auth/register',
            { email: uniqueEmail('reg22'), password: PASSWORD, company: 'Rate Co', provider: 'LOCAL' },
            from(freshIp())
          )
        ).status
      ).toBe(200);
    });

    it('10 attempts an hour per address, from any IP', async () => {
      const email = uniqueEmail('regsame');
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        statuses.push(
          (
            await t.api.post(
              '/auth/register',
              { email, password: PASSWORD, company: 'Rate Co', provider: 'LOCAL' },
              from(freshIp())
            )
          ).status
        );
      }
      // The first creates the account, the next nine say it exists.
      expect(statuses).toEqual([200, ...Array(9).fill(400), 429]);
    });
  });

  describe('POST /auth/forgot', () => {
    it('5 an hour per address, then 429 (JSON with a message)', async () => {
      const s = await t.api.register();
      for (let i = 0; i < 5; i++) {
        expect((await t.api.post('/auth/forgot', { email: s.email }, from(freshIp()))).status).toBe(201);
      }
      const res = await t.api.post('/auth/forgot', { email: s.email }, from(freshIp()));
      expect(res.status).toBe(429);
      expect(res.body.message).toBe('Too many attempts. Please wait 1 hour and try again.');
    });

    it('20 an hour per IP across addresses; an unknown address is counted the same', async () => {
      const ip = freshIp();
      for (let i = 0; i < 20; i++) {
        expect((await t.api.post('/auth/forgot', { email: uniqueEmail(`fg${i}`) }, from(ip))).status).toBe(201);
      }
      expect((await t.api.post('/auth/forgot', { email: uniqueEmail('fg21') }, from(ip))).status).toBe(429);
    });
  });

  describe('activation email resends', () => {
    it('POST /auth/resend-activation: 20 an hour per IP', async () => {
      const ip = freshIp();
      for (let i = 0; i < 20; i++) {
        const res = await t.api.post('/auth/resend-activation', { email: uniqueEmail(`rs${i}`) }, from(ip));
        expect(res.status).toBe(201);
      }
      const res = await t.api.post('/auth/resend-activation', { email: uniqueEmail('rs21') }, from(ip));
      expect(res.status).toBe(429);
      expect(res.body.message).toMatch(/Too many attempts/);
    });

    it('POST /verify-email/resend (signed in): 20 an hour per IP', async () => {
      const s = await t.api.register();
      const ip = freshIp();
      for (let i = 0; i < 20; i++) {
        expect((await s.post('/verify-email/resend', undefined, from(ip))).status).not.toBe(429);
      }
      const res = await s.post('/verify-email/resend', undefined, from(ip));
      expect(res.status).toBe(429);
      expect(res.body.message).toMatch(/Too many attempts/);
    });
  });
});
