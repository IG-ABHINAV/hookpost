/**
 * ReviewAskService: the facts it reads for review.ask.policy.ts, in which
 * order, and the claim. The repository is mocked; the real queries run in
 * tests/integration/review-ask.int.spec.ts.
 *   pnpm exec jest -c apps/backend/jest.config.ts review.ask.service
 */
import { ReviewAskService } from '@hookpost/nestjs-libraries/database/prisma/review-ask/review.ask.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-26T10:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const user = { id: 'user-1', email: 'creator@example.com', activated: true };

function repo(over: Record<string, any> = {}) {
  return {
    getState: jest.fn(async () => null),
    getMemberships: jest.fn(async () => [
      { organizationId: 'org-own', role: 'SUPERADMIN', createdAt: ago(30) },
      { organizationId: 'org-team', role: 'USER', createdAt: ago(5) },
    ]),
    hasInternalWorkspace: jest.fn(async () => false),
    getPublishedPosts: jest.fn(async () => ({ count: 2, latest: ago(0.5) })),
    getPaidPlanStartedAt: jest.fn(async () => null),
    claim: jest.fn(async () => true),
    dismiss: jest.fn(async () => true),
    click: jest.fn(async () => true),
    ...over,
  };
}

const service = (r: ReturnType<typeof repo>) => new ReviewAskService(r as any);

const OLD_ENV = process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS;
afterEach(() => {
  process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = OLD_ENV;
});

describe('ReviewAskService.status', () => {
  it('asks after the second published post', async () => {
    const r = repo();
    expect(await service(r).status(user, false, NOW)).toEqual({ ask: true, moment: 'POSTS_PUBLISHED' });
    expect(r.getPublishedPosts).toHaveBeenCalledWith(
      [
        { organizationId: 'org-own', role: 'SUPERADMIN', createdAt: ago(30) },
        { organizationId: 'org-team', role: 'USER', createdAt: ago(5) },
      ],
      NOW
    );
  });

  it('reads the paid start only for workspaces the user owns, not teams they joined', async () => {
    const r = repo({
      getPublishedPosts: jest.fn(async () => ({ count: 0, latest: null })),
      getPaidPlanStartedAt: jest.fn(async () => ago(1)),
    });
    expect(await service(r).status(user, false, NOW)).toEqual({ ask: true, moment: 'PAID_PLAN' });
    expect(r.getPaidPlanStartedAt).toHaveBeenCalledWith(['org-own']);
  });

  it('a team member (no workspace of their own) gets no paid-plan ask', async () => {
    const r = repo({
      getMemberships: jest.fn(async () => [
        { organizationId: 'org-team', role: 'ADMIN', createdAt: ago(5) },
      ]),
      getPublishedPosts: jest.fn(async () => ({ count: 0, latest: null })),
    });
    expect((await service(r).status(user, false, NOW)).ask).toBe(false);
    expect(r.getPaidPlanStartedAt).toHaveBeenCalledWith([]);
  });

  it('an internal account costs no query at all', async () => {
    const r = repo();
    const d = await service(r).status({ ...user, email: 'support@hookstep.in' }, false, NOW);
    expect(d.ask).toBe(false);
    expect(r.getState).not.toHaveBeenCalled();
    expect(r.getMemberships).not.toHaveBeenCalled();
  });

  it('impersonation costs no query at all', async () => {
    const r = repo();
    expect((await service(r).status(user, true, NOW)).ask).toBe(false);
    expect(r.getState).not.toHaveBeenCalled();
  });

  it('a recent ask stops at the state row', async () => {
    const r = repo({ getState: jest.fn(async () => ({ askedAt: ago(3) })) });
    expect(await service(r).status(user, false, NOW)).toEqual({ ask: false, reason: 'asked recently' });
    expect(r.getMemberships).not.toHaveBeenCalled();
  });

  it('a member of an exempt workspace (FREE_PLAN_SUNSET_EXEMPT_ORGS) is never asked', async () => {
    process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = 'org-x, org-team';
    const r = repo();
    expect(await service(r).status(user, false, NOW)).toEqual({
      ask: false,
      reason: 'internal workspace',
    });
    expect(r.getPublishedPosts).not.toHaveBeenCalled();
  });

  it('a member of an api.market or super-admin workspace is never asked', async () => {
    const r = repo({ hasInternalWorkspace: jest.fn(async () => true) });
    expect((await service(r).status(user, false, NOW)).ask).toBe(false);
    expect(r.hasInternalWorkspace).toHaveBeenCalledWith(['org-own', 'org-team']);
  });

  it('no table yet: said once as a warning; any other failure is logged as an error each time', async () => {
    const { Logger } = await import('@nestjs/common');
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const missing = Object.assign(new Error('The table `public.ReviewAsk` does not exist in the current database.'), { code: 'P2021' });
      const r = repo({ getState: jest.fn(async () => Promise.reject(missing)) });
      const s = service(r);
      await s.status(user, false, NOW);
      await s.status(user, false, NOW);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();

      const broken = repo({ getState: jest.fn(async () => Promise.reject(new Error('connection reset'))) });
      const b = service(broken);
      await b.status(user, false, NOW);
      await b.status(user, false, NOW);
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('a database failure (or no table yet) means no card, never an error', async () => {
    const r = repo({ getState: jest.fn(async () => Promise.reject(new Error('relation "ReviewAsk" does not exist'))) });
    const s = service(r);
    expect(await s.status(user, false, NOW)).toEqual({ ask: false, reason: 'unavailable' });
    expect(await s.record(user, false, 'shown', undefined, NOW)).toEqual({ ok: false });
  });
});

describe('ReviewAskService.record', () => {
  it('shown: claims with the 60-day boundary when the card is due', async () => {
    const r = repo();
    expect(await service(r).record(user, false, 'shown', undefined, NOW)).toEqual({ ok: true });
    expect(r.claim).toHaveBeenCalledWith('user-1', NOW, ago(60));
  });

  it('shown: no claim when it is not due (a page cannot force the card)', async () => {
    const r = repo({ getPublishedPosts: jest.fn(async () => ({ count: 1, latest: ago(0.1) })) });
    expect(await service(r).record(user, false, 'shown', undefined, NOW)).toEqual({ ok: false });
    expect(r.claim).not.toHaveBeenCalled();
  });

  it('shown: the claim lost to another tab', async () => {
    const r = repo({ claim: jest.fn(async () => false) });
    expect(await service(r).record(user, false, 'shown', undefined, NOW)).toEqual({ ok: false });
  });

  it('dismissed and clicked are recorded', async () => {
    const r = repo();
    expect(await service(r).record(user, false, 'dismissed', undefined, NOW)).toEqual({ ok: true });
    expect(r.dismiss).toHaveBeenCalledWith('user-1', NOW);
    expect(await service(r).record(user, false, 'clicked', 'play', NOW)).toEqual({ ok: true });
    expect(r.click).toHaveBeenCalledWith('user-1', 'play', NOW);
  });

  it('clicked without a target records nothing', async () => {
    const r = repo();
    expect(await service(r).record(user, false, 'clicked', undefined, NOW)).toEqual({ ok: false });
    expect(r.click).not.toHaveBeenCalled();
  });

  it('nothing is recorded while an admin impersonates the user', async () => {
    const r = repo();
    for (const action of ['shown', 'dismissed', 'clicked'] as const) {
      expect(await service(r).record(user, true, action, 'g2', NOW)).toEqual({ ok: false });
    }
    expect(r.claim).not.toHaveBeenCalled();
    expect(r.dismiss).not.toHaveBeenCalled();
    expect(r.click).not.toHaveBeenCalled();
  });
});
