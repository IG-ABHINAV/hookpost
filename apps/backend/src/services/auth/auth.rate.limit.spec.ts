import {
  AUTH_LIMITS,
  clientIp,
  createAuthRateLimits,
  createFailureBackoff,
  describeWait,
  TooManyAttemptsError,
} from './auth.rate.limit';

const MIN = 60_000;
const IP = '203.0.113.7';

const refused = (fn: () => void): TooManyAttemptsError | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof TooManyAttemptsError) return e;
    throw e;
  }
};

describe('createFailureBackoff', () => {
  const make = () =>
    createFailureBackoff({ maxFailures: 3, windowMs: 15 * MIN, lockMs: 15 * MIN, maxLockMs: 60 * MIN });

  it('locks on the Nth failure inside the window, for lockMs', () => {
    const b = make();
    b.fail('k', 0);
    b.fail('k', 1);
    expect(b.retryAfterMs('k', 2)).toBe(0);
    b.fail('k', 2);
    expect(b.retryAfterMs('k', 3)).toBe(15 * MIN - 1);
    expect(b.retryAfterMs('k', 2 + 15 * MIN)).toBe(0);
  });

  it('forgets failures older than the window', () => {
    const b = make();
    b.fail('k', 0);
    b.fail('k', 1);
    b.fail('k', 15 * MIN + 1);
    expect(b.retryAfterMs('k', 15 * MIN + 2)).toBe(0);
  });

  it('doubles each further lock inside a day, up to maxLockMs', () => {
    const b = make();
    let now = 0;
    const lockOnce = () => {
      for (let i = 0; i < 3; i++) b.fail('k', now++);
      const wait = b.retryAfterMs('k', now);
      now += wait;
      return wait;
    };
    expect(lockOnce()).toBe(15 * MIN - 1);
    expect(lockOnce()).toBe(30 * MIN - 1);
    expect(lockOnce()).toBe(60 * MIN - 1);
    expect(lockOnce()).toBe(60 * MIN - 1);
  });

  it('a success clears the count but not the lock history', () => {
    const b = make();
    b.fail('k', 0);
    b.fail('k', 1);
    b.succeed('k');
    b.fail('k', 2);
    b.fail('k', 3);
    expect(b.retryAfterMs('k', 4)).toBe(0);
  });

  it('keys are independent', () => {
    const b = make();
    for (let i = 0; i < 3; i++) b.fail('a', i);
    expect(b.retryAfterMs('a', 5)).toBeGreaterThan(0);
    expect(b.retryAfterMs('b', 5)).toBe(0);
  });
});

describe('createAuthRateLimits: sign-in', () => {
  it('10 wrong passwords for one address, then the 11th attempt is refused with a wait', () => {
    const l = createAuthRateLimits();
    for (let i = 0; i < AUTH_LIMITS.loginFailuresPerEmail; i++) {
      let release: () => void = () => undefined;
      expect(refused(() => (release = l.beforeLogin('jo@example.com', IP, i)))).toBeNull();
      l.loginFailed('jo@example.com', IP, i);
      release();
    }
    const e = refused(() => l.beforeLogin('jo@example.com', IP, 20));
    expect(e?.getStatus()).toBe(429);
    expect(e?.message).toMatch(/Too many sign-in attempts.*15 minutes.*reset your password/);
    expect(e?.retryAfterSeconds).toBe(900);
  });

  it('counts the address however it is typed', () => {
    const l = createAuthRateLimits();
    for (let i = 0; i < 10; i++) l.loginFailed(i % 2 ? ' JO@Example.com ' : 'jo@example.com', `198.51.100.${i}`, i);
    expect(refused(() => l.beforeLogin('Jo@example.COM', '198.51.100.99', 20))).not.toBeNull();
  });

  it('a right password before the 10th failure starts the count again', () => {
    const l = createAuthRateLimits();
    for (let i = 0; i < 9; i++) l.loginFailed('jo@example.com', IP, i);
    l.loginSucceeded('jo@example.com');
    for (let i = 0; i < 9; i++) l.loginFailed('jo@example.com', IP, 10 + i);
    expect(refused(() => l.beforeLogin('jo@example.com', IP, 30))).toBeNull();
  });

  it('a stranger locking an address does not lock out a device that signed in to it before', () => {
    const l = createAuthRateLimits();
    const home = '198.51.100.77';
    l.loginSucceeded('jo@example.com', home, 0);
    for (let i = 0; i < 10; i++) l.loginFailed('jo@example.com', '203.0.113.66', 10 + i);
    expect(refused(() => l.beforeLogin('jo@example.com', '203.0.113.66', 30))).not.toBeNull();
    expect(refused(() => l.beforeLogin('jo@example.com', home, 30))).toBeNull();
    // ...which gets its own 10 tries.
    for (let i = 0; i < 10; i++) l.loginFailed('jo@example.com', home, 40 + i);
    expect(refused(() => l.beforeLogin('jo@example.com', home, 60))).not.toBeNull();
  });

  it('a known device is known for a day only', () => {
    const l = createAuthRateLimits();
    l.loginSucceeded('jo@example.com', '198.51.100.77', 0);
    const later = 25 * 60 * MIN;
    for (let i = 0; i < 10; i++) l.loginFailed('jo@example.com', '203.0.113.66', later + i);
    expect(refused(() => l.beforeLogin('jo@example.com', '198.51.100.77', later + 20))).not.toBeNull();
  });

  it('a password reset lifts the address lock at once', () => {
    const l = createAuthRateLimits();
    for (let i = 0; i < 10; i++) l.loginFailed('jo@example.com', IP, i);
    expect(refused(() => l.beforeLogin('jo@example.com', IP, 20))).not.toBeNull();
    l.passwordReset(' JO@example.com');
    expect(refused(() => l.beforeLogin('jo@example.com', IP, 21))).toBeNull();
  });

  it('a parallel burst: at most 3 sign-ins per address are checked at once, 10 per IP', () => {
    const l = createAuthRateLimits();
    const releases = [0, 1, 2].map(() => l.beforeLogin('jo@example.com', `198.51.100.${Math.random()}`, 1));
    expect(refused(() => l.beforeLogin('jo@example.com', '198.51.100.200', 1))?.getStatus()).toBe(429);
    releases[0]();
    releases[0]();
    const again = l.beforeLogin('jo@example.com', '198.51.100.200', 2);
    expect(again).toEqual(expect.any(Function));
    const m = createAuthRateLimits();
    for (let i = 0; i < 10; i++) m.beforeLogin(`u${i}@example.com`, IP, 1);
    expect(refused(() => m.beforeLogin('u99@example.com', IP, 1))).not.toBeNull();
    // Loopback is counted per address only.
    for (let i = 0; i < 20; i++) m.beforeLogin(`l${i}@example.com`, '127.0.0.1', 1);
  });

  it('one address being locked does not refuse another', () => {
    const l = createAuthRateLimits();
    for (let i = 0; i < 10; i++) l.loginFailed('jo@example.com', `198.51.100.${i}`, i);
    expect(refused(() => l.beforeLogin('ann@example.com', IP, 20))).toBeNull();
  });

  it('50 failures from one IP across many addresses locks the IP', () => {
    const l = createAuthRateLimits();
    for (let i = 0; i < AUTH_LIMITS.loginFailuresPerIp; i++) {
      l.loginFailed(`user${i}@example.com`, IP, i);
    }
    expect(refused(() => l.beforeLogin('fresh@example.com', IP, 100))).not.toBeNull();
    expect(refused(() => l.beforeLogin('fresh@example.com', '198.51.100.1', 100))).toBeNull();
  });

  it('never counts loopback per IP (the test stacks, our own scripts)', () => {
    const l = createAuthRateLimits();
    for (let i = 0; i < 60; i++) l.loginFailed(`user${i}@example.com`, '127.0.0.1', i);
    expect(refused(() => l.beforeLogin('fresh@example.com', '127.0.0.1', 100))).toBeNull();
    expect(refused(() => l.beforeLogin('fresh@example.com', '::ffff:127.0.0.1', 100))).toBeNull();
  });
});

describe('createAuthRateLimits: hourly routes', () => {
  it('sign-up: 20 an hour per IP', () => {
    const l = createAuthRateLimits();
    for (let i = 0; i < 20; i++) {
      expect(refused(() => l.register(`n${i}@example.com`, IP, i))).toBeNull();
    }
    const e = refused(() => l.register('n21@example.com', IP, 30));
    expect(e?.getStatus()).toBe(429);
    expect(e?.message).toBe('Too many attempts. Please wait 1 hour and try again.');
    expect(refused(() => l.register('n21@example.com', IP, 60 * MIN + 1))).toBeNull();
  });

  it('sign-up: 10 an hour per address, from any IP', () => {
    const l = createAuthRateLimits();
    for (let i = 0; i < 10; i++) l.register('jo@example.com', `198.51.100.${i}`, i);
    expect(refused(() => l.register('jo@example.com', '198.51.100.50', 20))).not.toBeNull();
  });

  it('forgot password: 5 an hour per address, 20 per IP', () => {
    const l = createAuthRateLimits();
    for (let i = 0; i < 5; i++) l.forgot('jo@example.com', `198.51.100.${i}`, i);
    expect(refused(() => l.forgot('jo@example.com', '198.51.100.9', 10))).not.toBeNull();
    const m = createAuthRateLimits();
    for (let i = 0; i < 20; i++) m.forgot(`u${i}@example.com`, IP, i);
    expect(refused(() => m.forgot('other@example.com', IP, 30))).not.toBeNull();
  });

  it('resend: 20 an hour per IP, loopback not counted', () => {
    const l = createAuthRateLimits();
    for (let i = 0; i < 20; i++) l.resend(IP, i);
    expect(refused(() => l.resend(IP, 30))).not.toBeNull();
    for (let i = 0; i < 40; i++) expect(refused(() => l.resend('::1', i))).toBeNull();
  });
});

describe('clientIp', () => {
  const req = (headers: Record<string, string>, remote = '127.0.0.1') =>
    ({ headers, socket: { remoteAddress: remote } } as any);

  it('reads CF-Connecting-IP from nginx (a loopback peer), which sets it from Cloudflare or its own peer', () => {
    expect(clientIp(req({ 'cf-connecting-ip': ' 203.0.113.9 ' }))).toBe('203.0.113.9');
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.9' }, '::ffff:127.0.0.1'))).toBe('203.0.113.9');
    expect(clientIp(req({}))).toBe('127.0.0.1');
  });

  it('a request that reached the port without nginx is its own address, whatever it claims', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '127.0.0.1' }, '10.0.0.5'))).toBe('10.0.0.5');
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.1' }, '10.0.0.5'))).toBe('10.0.0.5');
  });

  it('ignores X-Client-IP and X-Forwarded-For, which a client can set', () => {
    expect(clientIp(req({ 'x-client-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }, '10.0.0.5'))).toBe('10.0.0.5');
    expect(clientIp(req({ 'x-client-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }))).toBe('127.0.0.1');
  });
});

describe('describeWait', () => {
  it.each([
    [1, '1 minute'],
    [15 * MIN, '15 minutes'],
    [60 * MIN, '1 hour'],
    [90 * MIN, '2 hours'],
  ])('%d ms -> %s', (ms, text) => {
    expect(describeWait(ms)).toBe(text);
  });
});
