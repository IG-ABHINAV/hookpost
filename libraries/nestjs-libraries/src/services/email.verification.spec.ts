// takeAllowance against an in-memory Redis that honours SET NX EX, TTL, INCR
// and EXPIRE the way Redis does, with a clock the tests move.
let mockNow = Date.UTC(2026, 9, 25, 10, 0, 0);
const mockStore = new Map<string, { value: string; expiresAt: number | null }>();
const mockLive = (key: string) => {
  const entry = mockStore.get(key);
  if (entry && entry.expiresAt !== null && entry.expiresAt <= mockNow) {
    mockStore.delete(key);
    return undefined;
  }
  return entry;
};
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedisIsMock: false,
  ioRedis: {
    set: jest.fn(async (key: string, value: string, _ex: 'EX', seconds: number, nx?: 'NX') => {
      if (nx === 'NX' && mockLive(key)) return null;
      mockStore.set(key, { value, expiresAt: mockNow + seconds * 1000 });
      return 'OK';
    }),
    ttl: jest.fn(async (key: string) => {
      const entry = mockLive(key);
      if (!entry) return -2;
      return entry.expiresAt === null ? -1 : Math.ceil((entry.expiresAt - mockNow) / 1000);
    }),
    incr: jest.fn(async (key: string) => {
      const entry = mockLive(key);
      const next = (entry ? Number(entry.value) : 0) + 1;
      mockStore.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
      return next;
    }),
    expire: jest.fn(async (key: string, seconds: number) => {
      const entry = mockLive(key);
      if (entry) entry.expiresAt = mockNow + seconds * 1000;
      return entry ? 1 : 0;
    }),
  },
}));

import {
  ACTIVATION_SEND,
  EMAIL_NOT_VERIFIED,
  EmailNotVerifiedException,
  maskEmail,
  takeAllowance,
} from '@hookpost/nestjs-libraries/services/email.verification';

const take = (key = 'jo@gmail.com') => takeAllowance('activation-send', key, ACTIVATION_SEND, mockNow);
const later = (seconds: number) => {
  mockNow += seconds * 1000;
};

beforeEach(() => {
  mockStore.clear();
  mockNow = Date.UTC(2026, 9, 25, 10, 0, 0);
});

describe('takeAllowance: activation emails per address', () => {
  it('one a minute: a second send within 60 s is held, with the seconds left', async () => {
    expect(await take()).toEqual({ allowed: true, retryAfterSeconds: 0 });
    later(15);
    expect(await take()).toEqual({ allowed: false, retryAfterSeconds: 45 });
    later(45);
    expect((await take()).allowed).toBe(true);
  });

  it('five a day, then held until the day key expires', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await take()).allowed).toBe(true);
      later(61);
    }
    const sixth = await take();
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSeconds).toBeGreaterThan(60);
  });

  it('counts the address however it is typed', async () => {
    await take('Jo@Gmail.com');
    expect((await take('  jo@gmail.com ')).allowed).toBe(false);
  });

  it('another address has its own allowance', async () => {
    await take('jo@gmail.com');
    expect((await take('sam@gmail.com')).allowed).toBe(true);
  });

  it('another scope has its own allowance', async () => {
    await take('jo@gmail.com');
    expect((await takeAllowance('email-change', 'jo@gmail.com', ACTIVATION_SEND, mockNow)).allowed).toBe(true);
  });

  it('a held send is not counted toward the day', async () => {
    await take();
    for (let i = 0; i < 10; i++) {
      await take();
    }
    later(61);
    expect((await take()).allowed).toBe(true);
  });
});

describe('takeAllowance when Redis is down or slow (it runs inside sign-up)', () => {
  const redis = jest.requireMock('@hookpost/nestjs-libraries/redis/redis.service').ioRedis;
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  afterAll(() => warn.mockRestore());

  it('an error lets the send go', async () => {
    redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await take()).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it('no answer within the timeout lets the send go, and does not wait for Redis', async () => {
    redis.set.mockImplementationOnce(() => new Promise(() => undefined));
    const started = Date.now();
    expect(await takeAllowance('activation-send', 'slow@gmail.com', ACTIVATION_SEND, mockNow, 50)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('EmailNotVerifiedException', () => {
  it('is a 403 the frontend can tell apart by its code', () => {
    const e = new EmailNotVerifiedException();
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toEqual({
      code: EMAIL_NOT_VERIFIED,
      statusCode: 403,
      message: expect.stringMatching(/^Confirm your email address to publish\./),
    });
  });
});

describe('maskEmail', () => {
  it('keeps only the first letter and the domain', () => {
    expect(maskEmail('janedoe@gmail.com')).toBe('j***@gmail.com');
    expect(maskEmail('')).toBe('');
  });
});


describe('the hard gate rule (email.verification.ts)', () => {
  const { mustVerifyEmail, allowedBeforeVerification, CAN_USE_HOOKPOST } = jest.requireActual(
    '@hookpost/nestjs-libraries/services/email.verification'
  );
  it('only an unconfirmed email+password account must confirm', () => {
    expect(mustVerifyEmail({ providerName: 'LOCAL', activated: false })).toBe(true);
    expect(mustVerifyEmail({ providerName: 'LOCAL', activated: null })).toBe(true);
    expect(mustVerifyEmail({ providerName: 'LOCAL', activated: true })).toBe(false);
    for (const providerName of ['GOOGLE', 'GITHUB', 'LINKEDIN', 'WALLET']) {
      expect(mustVerifyEmail({ providerName, activated: false })).toBe(false);
    }
    expect(mustVerifyEmail(null)).toBe(false);
  });
  it('allows only self, sign-out and the confirmation routes', () => {
    expect(allowedBeforeVerification('GET', '/user/self')).toBe(true);
    expect(allowedBeforeVerification('GET', '/user/self/')).toBe(true);
    expect(allowedBeforeVerification('POST', '/user/logout')).toBe(true);
    expect(allowedBeforeVerification('GET', '/verify-email')).toBe(true);
    expect(allowedBeforeVerification('POST', '/verify-email/resend')).toBe(true);
    expect(allowedBeforeVerification('post', '/verify-email/change?x=1')).toBe(true);
    for (const [m, p] of [['PUT', '/user/self'], ['GET', '/user/selfish'], ['GET', '/posts'], ['POST', '/verify-email'], ['GET', '/verify-email/resend'], ['POST', '/user/logout/x'], ['GET', '/public/v1/posts']]) {
      expect(allowedBeforeVerification(m, p)).toBe(false);
    }
  });
  it('the Prisma filter says the same: confirmed, or not an email+password account', () => {
    expect(CAN_USE_HOOKPOST).toEqual({ deletedAt: null, OR: [{ activated: true }, { providerName: { not: 'LOCAL' } }] });
  });
  it('a new email sign-up starts confirmed only where no email can be sent, and never in production', () => {
    const { signUpStartsConfirmed } = jest.requireActual('@hookpost/nestjs-libraries/services/email.verification');
    expect(signUpStartsConfirmed('GOOGLE', true, 'production')).toBe(true);
    expect(signUpStartsConfirmed('LOCAL', true, 'production')).toBe(false);
    expect(signUpStartsConfirmed('LOCAL', false, 'production')).toBe(false);
    expect(signUpStartsConfirmed('LOCAL', false, 'test')).toBe(true);
    expect(signUpStartsConfirmed('LOCAL', true, 'development')).toBe(false);
  });

  it('has no environment switch', () => {
    const src = require('fs').readFileSync(require.resolve('@hookpost/nestjs-libraries/services/email.verification'), 'utf8');
    const gate = src.slice(src.indexOf('THE HARD GATE'), src.indexOf('Whether a new account starts confirmed'));
    expect(gate).not.toMatch(/process\.env/);
  });
});
