import 'reflect-metadata';

// POST /public/client-event: failures the browser saw, written as one
// "[client]" line. Production has no Sentry or PostHog, so the 7 Oct Google
// sign-up 500 (an endless spinner) and the 22 Oct consent 400 left no trace.
//   pnpm exec jest -c apps/backend/jest.config.ts client.event

jest.mock('@hookpost/nestjs-libraries/database/prisma/users/users.repository', () => ({
  UsersRepository: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.repository',
  () => ({ OrganizationRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.repository',
  () => ({ IntegrationRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service',
  () => ({ NotificationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service',
  () => ({ AffiliateService: class {} })
);
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));

import {
  clientEventLine,
  cleanPath,
  createRateLimiter,
} from '@hookpost/nestjs-libraries/track/client.event';
import { UsersService } from '@hookpost/nestjs-libraries/database/prisma/users/users.service';

describe('clientEventLine', () => {
  it('one grep-able line with the allowed fields', () => {
    expect(
      clientEventLine(
        { event: 'spinner_stuck', path: '/auth', ms: 15000 },
        'd936df7d-1111-2222-3333-444444444444'
      )
    ).toBe('[client] spinner_stuck {"path":"/auth","ms":15000,"user":"d936df7d"}');
  });

  it('a connect that never came back names the provider', () => {
    expect(
      clientEventLine({ event: 'connect_abandoned', provider: 'linkedin', path: '/launches' })
    ).toBe('[client] connect_abandoned {"provider":"linkedin","path":"/launches"}');
  });

  it('refuses events that are not on the list, and bodies that are not objects', () => {
    expect(clientEventLine({ event: 'anything' })).toBeNull();
    expect(clientEventLine({ event: '__proto__' })).toBeNull();
    expect(clientEventLine(null)).toBeNull();
    expect(clientEventLine({} as any)).toBeNull();
  });

  it('drops the query string: an OAuth callback carries a one-time code there', () => {
    expect(cleanPath('/integrations/social/x?code=secret&state=s#frag')).toBe(
      '/integrations/social/x'
    );
    expect(cleanPath('https://evil.example/')).toBeUndefined();
    expect(cleanPath('/a b')).toBeUndefined();
    expect(cleanPath(42)).toBeUndefined();
  });

  it('never personal data or secrets in the reason, and never a long one', () => {
    const line = clientEventLine({
      event: 'signup_error',
      reason: `Failed for rk.defence@gmail.com with access_token=abc123 ${'x'.repeat(400)}`,
    })!;
    expect(line).not.toContain('rk.defence@gmail.com');
    expect(line).not.toContain('abc123');
    expect(line).toContain('<email>');
    expect(JSON.parse(line.replace('[client] signup_error ', '')).reason.length).toBeLessThanOrEqual(200);
  });

  it('ignores a bad provider id and a bad duration', () => {
    expect(
      clientEventLine({ event: 'page_error', provider: '<script>', ms: -5 })
    ).toBe('[client] page_error {}');
  });
});

describe('createRateLimiter', () => {
  it('lets 30 a minute through per address, then refuses until the window ends', () => {
    const allow = createRateLimiter(30, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) {
      expect(allow('1.2.3.4', t0 + i)).toBe(true);
    }
    expect(allow('1.2.3.4', t0 + 31)).toBe(false);
    expect(allow('5.6.7.8', t0 + 31)).toBe(true);
    expect(allow('1.2.3.4', t0 + 60_000)).toBe(true);
  });

  it('reset(key) forgets one key and leaves the others counted', () => {
    const allow = createRateLimiter(2, 60_000);
    allow('a', 0);
    allow('a', 1);
    allow('b', 1);
    allow('b', 2);
    expect(allow('a', 3)).toBe(false);
    allow.reset('a');
    expect(allow('a', 4)).toBe(true);
    expect(allow('b', 4)).toBe(false);
  });

  it('when full, drops the oldest keys instead of every count (no reset by flooding)', () => {
    const allow = createRateLimiter(1, 60_000, 3);
    allow('old', 0);
    allow('k1', 1);
    expect(allow('k1', 2)).toBe(false);
    allow('k2', 3);
    // The table is full; a new key pushes out only the oldest one ("old").
    allow('k3', 4);
    expect(allow('k1', 5)).toBe(false);
    expect(allow('old', 6)).toBe(true);
  });
});

describe('UsersService.markOnline (User.lastOnline was never written)', () => {
  const service = (markOnline = jest.fn(async () => ({ count: 1 }))) => ({
    svc: new UsersService(
      { markOnline } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    ),
    markOnline,
  });

  it('writes lastOnline, at most once an hour per person', async () => {
    const { svc, markOnline } = service();
    const t0 = new Date('2026-10-22T10:00:00Z');
    await svc.markOnline('user-1', t0);
    await svc.markOnline('user-1', new Date('2026-10-22T10:30:00Z'));
    await svc.markOnline('user-2', new Date('2026-10-22T10:30:00Z'));
    await svc.markOnline('user-1', new Date('2026-10-22T11:00:00Z'));
    expect(markOnline.mock.calls.map((c: any[]) => c[0])).toEqual(['user-1', 'user-2', 'user-1']);
    expect(markOnline).toHaveBeenCalledWith('user-1', t0, 60 * 60 * 1000);
  });

  it('a database error never reaches the page', async () => {
    const { svc } = service(
      jest.fn(async () => {
        throw new Error('connection reset');
      })
    );
    await expect(svc.markOnline('user-1')).resolves.toBeUndefined();
  });
});
