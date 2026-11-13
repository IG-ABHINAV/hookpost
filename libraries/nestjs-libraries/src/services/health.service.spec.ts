import { HealthService } from './health.service';

/**
 * The database read must not run on every call: the uptime cron reads
 * /health every 5 minutes, and a read that often kept Neon's compute from
 * ever suspending (80 of 100 free CU-hours used in October 2026).
 */
describe('HealthService database probe', () => {
  const findFirst = jest.fn();
  const temporal = {
    client: {
      getRawClient: () => ({
        workflowService: {
          describeTaskQueue: async () => ({
            pollers: [{ lastAccessTime: { seconds: Math.floor(Date.now() / 1000), nanos: 0 } }],
          }),
        },
      }),
    },
  } as any;
  const make = () => new HealthService({ model: { user: { findFirst } } } as any, temporal);

  beforeEach(() => {
    findFirst.mockReset();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-11-01T10:20:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('reads the database once, then trusts a good read until the next top of the hour', async () => {
    findFirst.mockResolvedValue({ id: 'u' });
    const h = make();
    expect((await h.check()).db).toBe('ok');
    for (const t of ['10:25:00', '10:40:00', '10:55:00', '10:59:59']) {
      jest.setSystemTime(new Date(`2026-11-01T${t}Z`));
      expect((await h.check()).db).toBe('ok');
    }
    expect(findFirst).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-11-01T11:00:15Z'));
    expect((await h.check()).db).toBe('ok');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('a failed read is not trusted: the next call (after the 10 s cache) reads again', async () => {
    findFirst.mockRejectedValueOnce(new Error('down')).mockResolvedValue({ id: 'u' });
    const h = make();
    const first = await h.check();
    expect(first).toMatchObject({ db: 'error', status: 'down' });

    jest.setSystemTime(new Date('2026-11-01T10:20:11Z'));
    expect((await h.check()).db).toBe('ok');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('still reports the worker on every call', async () => {
    findFirst.mockResolvedValue({ id: 'u' });
    const h = make();
    const r = await h.check();
    expect(r).toMatchObject({ status: 'ok', worker: 'ok' });
  });
});
