/**
 * /health is what the uptime monitor (uptime.yml) and the nightly prod smoke
 * read. 200 with db:ok while Postgres answers; the worker state comes from the
 * last poll Temporal saw on the "main" queue.
 */
import { startApp, TestApp } from './setup/app';

describe('GET /health', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('answers 200 with db ok and a recently polled worker', async () => {
    const res = await t.api.get('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok', worker: 'ok' });
    expect(res.body.workerLastPollSecondsAgo).toBeLessThan(180);
  });

  it('GET / answers without auth', async () => {
    const res = await t.api.get('/');
    expect(res.status).toBeLessThan(500);
  });
});

/**
 * Neon (production Postgres) suspends its compute after 5 idle minutes and the
 * Free plan allows 100 compute-hours a month. The uptime cron reads /health
 * every 5 minutes, so a database read on every call kept the compute awake
 * around the clock. A good read is trusted until the next top of the hour.
 */
describe('GET /health does not read the database on every call', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('three calls past the 10 s report cache: one database read, still db ok', async () => {
    const { HealthService } = await import('@hookpost/nestjs-libraries/services/health.service');
    const svc: any = t.get(HealthService);
    const spy = jest.spyOn(svc._user.model.user, 'findFirst');
    svc._dbOkUntil = 0;
    for (let i = 0; i < 3; i++) {
      svc._cached = undefined; // skip the 10 s report cache, as calls 5 minutes apart would
      const res = await t.api.get('/health');
      expect(res.status).toBe(200);
      expect(res.body.db).toBe('ok');
    }
    expect(spy).toHaveBeenCalledTimes(1);
    const nextHour = Math.ceil((Date.now() + 1) / 3_600_000) * 3_600_000;
    expect(svc._dbOkUntil).toBeLessThanOrEqual(nextHour);
    expect(svc._dbOkUntil).toBeGreaterThan(Date.now());
    spy.mockRestore();
  });
});
