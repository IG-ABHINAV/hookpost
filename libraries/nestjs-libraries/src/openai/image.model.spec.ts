// The image-model choice (image.model.ts): newest GA Gemini image model whose
// listed price fits the 5-credit budget, with the owner's exclusions and
// fallbacks. No network.
//   pnpm exec jest -c apps/backend/jest.config.ts image.model.spec

import {
  compareVersions,
  fallbackImageModels,
  IMAGE_MODEL_PRICES,
  IMAGE_MODEL_REFRESH_MS,
  IMAGE_MODEL_RETRY_MS,
  IMAGE_PRICE_CAP_USD,
  ImageModelResolver,
  pickLatestImageModel,
  PublisherModel,
} from '@hookpost/nestjs-libraries/openai/image.model';

const ga = (id: string): PublisherModel => ({
  id: `publishers/google/models/${id}`,
  launchStage: 'GA',
});
const preview = (id: string): PublisherModel => ({
  id: `publishers/google/models/${id}`,
  launchStage: 'PUBLIC_PREVIEW',
});

// Every candidate in these tests is priced within the cap unless a test says
// otherwise, so the ordering rules are what is under test.
const cheap = (ids: string[]) =>
  Object.fromEntries(ids.map((id) => [id, 0.03]));
const pick = (models: PublisherModel[], prices?: Record<string, number>) =>
  pickLatestImageModel(
    models,
    prices ?? cheap(models.map((m) => m.id.split('/').pop()!)),
    IMAGE_PRICE_CAP_USD
  ).model;

describe('compareVersions', () => {
  it('compares numerically, segment by segment', () => {
    expect(compareVersions('3.10', '3.9')).toBeGreaterThan(0);
    expect(compareVersions('3.9', '3.10')).toBeLessThan(0);
    expect(compareVersions('4', '3.99')).toBeGreaterThan(0);
    expect(compareVersions('3.1', '3')).toBeGreaterThan(0);
    expect(compareVersions('3.0', '3')).toBe(0);
  });
});

describe('pickLatestImageModel', () => {
  const LIVE = [
    ga('gemini-2.5-flash'),
    preview('gemini-3.1-flash-image-preview'),
    ga('gemini-3.1-flash-image'),
    ga('gemini-3-pro-image'),
    ga('gemini-3.1-flash-lite-image'),
    ga('gemini-3.8-flash'),
    ga('gemini-nano-banana-2.1'),
    ga('gemini-4-argon'),
    ga('gemini-omni-1.2-flash'),
  ];

  it('the live Vertex list of 8 Nov 2026 with the real price table gives Nano Banana 2.1', () => {
    expect(pickLatestImageModel(LIVE)).toEqual({
      model: 'gemini-nano-banana-2.1',
      skipped: [],
    });
  });

  it('the price cap fits a 5-credit image', () => {
    expect(IMAGE_PRICE_CAP_USD).toBeLessThanOrEqual(0.04);
    expect(IMAGE_MODEL_PRICES['gemini-nano-banana-2.1']).toBeLessThanOrEqual(
      IMAGE_PRICE_CAP_USD
    );
  });

  it('orders versions numerically: 3.10 beats 3.9 and 3.2', () => {
    expect(
      pick([
        ga('gemini-3.2-flash-image'),
        ga('gemini-3.10-flash-image'),
        ga('gemini-3.9-flash-image'),
      ])
    ).toBe('gemini-3.10-flash-image');
    expect(
      pick([ga('gemini-nano-banana-2.9'), ga('gemini-nano-banana-2.10')])
    ).toBe('gemini-nano-banana-2.10');
  });

  it('prefers Nano Banana over the numbered Flash image ids', () => {
    expect(
      pick([ga('gemini-3.4-flash-image'), ga('gemini-nano-banana-2.1')])
    ).toBe('gemini-nano-banana-2.1');
  });

  it('excludes -lite, pro, preview and experimental ids even when newer', () => {
    expect(
      pick([
        ga('gemini-3.1-flash-image'),
        ga('gemini-4-flash-lite-image'),
        ga('gemini-4-pro-image'),
        ga('gemini-4-flash-image-preview'),
        ga('gemini-4-flash-image-exp'),
        ga('gemini-nano-banana-pro-3'),
        preview('gemini-4-flash-image'),
        { id: 'gemini-5-flash-image', launchStage: 'EXPERIMENTAL' },
      ])
    ).toBe('gemini-3.1-flash-image');
  });

  it('never switches to a newer model that is unpriced or over the cap, and names it', () => {
    const choice = pickLatestImageModel(
      [ga('gemini-nano-banana-2.1'), ga('gemini-nano-banana-3'), ga('gemini-nano-banana-2.5')],
      { 'gemini-nano-banana-2.1': 0.0336, 'gemini-nano-banana-2.5': 0.05 },
      0.04
    );
    expect(choice.model).toBe('gemini-nano-banana-2.1');
    expect(choice.skipped.map((s) => s.id)).toEqual([
      'gemini-nano-banana-3',
      'gemini-nano-banana-2.5',
    ]);
    expect(choice.skipped[0].reason).toContain('no listed price');
    expect(choice.skipped[1].reason).toContain('over the $0.04 cap');
  });

  it('Nano Banana Pro is never picked, even alone', () => {
    expect(pickLatestImageModel([ga('gemini-3-pro-image')]).model).toBeUndefined();
  });

  it('when nothing plain exists, takes the newest excluded one, most stable first', () => {
    expect(
      pick([
        preview('gemini-3.1-flash-image-preview'),
        ga('gemini-3.1-flash-lite-image'),
        ga('gemini-3-pro-image'),
      ])
    ).toBe('gemini-3.1-flash-lite-image');
    expect(
      pick([preview('gemini-3.1-flash-image-preview'), ga('gemini-3-pro-image')])
    ).toBe('gemini-3.1-flash-image-preview');
  });

  it('is undefined when the list has no Gemini image model', () => {
    expect(pickLatestImageModel([]).model).toBeUndefined();
    expect(
      pickLatestImageModel([ga('gemini-3.8-flash'), ga('imagen-4.0-generate')])
        .model
    ).toBeUndefined();
  });
});

describe('fallbackImageModels', () => {
  const saved = process.env.AI_IMAGE_MODEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.AI_IMAGE_MODEL;
    else process.env.AI_IMAGE_MODEL = saved;
  });

  it('AI_IMAGE_MODEL first, then Nano Banana 2.1, 3.1 Flash Lite, 3.1 Flash, without repeats', () => {
    delete process.env.AI_IMAGE_MODEL;
    expect(fallbackImageModels()).toEqual([
      'gemini-nano-banana-2.1',
      'gemini-3.1-flash-lite-image',
      'gemini-3.1-flash-image',
    ]);
    process.env.AI_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
    expect(fallbackImageModels()).toEqual([
      'gemini-3.1-flash-lite-image',
      'gemini-nano-banana-2.1',
      'gemini-3.1-flash-image',
    ]);
  });
});

describe('ImageModelResolver', () => {
  let now = 1_000;
  const logger = { log: jest.fn(), warn: jest.fn() };
  beforeEach(() => {
    now = 1_000;
    jest.clearAllMocks();
    delete process.env.AI_IMAGE_MODEL;
  });

  it('caches the choice for 24 hours and logs it once per lookup', async () => {
    const list = jest.fn(async () => [ga('gemini-3.1-flash-image'), ga('gemini-nano-banana-2.1')]);
    const resolver = new ImageModelResolver(list, () => now, logger);
    await expect(resolver.ensure()).resolves.toBe('gemini-nano-banana-2.1');
    await resolver.ensure();
    expect(list).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log.mock.calls[0][0]).toContain('gemini-nano-banana-2.1');

    list.mockResolvedValue([ga('gemini-nano-banana-3')]);
    now += IMAGE_MODEL_REFRESH_MS;
    // gemini-nano-banana-3 has no listed price: warned about, not used
    await expect(resolver.ensure()).resolves.toBe('gemini-nano-banana-2.1');
    expect(logger.warn.mock.calls.map((c) => c[0]).join('\n')).toContain(
      'Not switching to gemini-nano-banana-3'
    );
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers share one lookup', async () => {
    const list = jest.fn(async () => [ga('gemini-nano-banana-2.1')]);
    const resolver = new ImageModelResolver(list, () => now, logger);
    await Promise.all([
      resolver.ensure(),
      resolver.ensure(),
      resolver.resolve(),
    ]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('a failed lookup uses AI_IMAGE_MODEL, warns, and retries after an hour', async () => {
    process.env.AI_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
    const list = jest.fn(async (): Promise<PublisherModel[]> => {
      throw new Error('403 denied');
    });
    const resolver = new ImageModelResolver(list, () => now, logger);
    await expect(resolver.ensure()).resolves.toBe('gemini-3.1-flash-lite-image');
    expect(logger.warn.mock.calls[0][0]).toContain('403 denied');

    list.mockResolvedValue([ga('gemini-nano-banana-2.1')]);
    now += IMAGE_MODEL_RETRY_MS - 1;
    await expect(resolver.ensure()).resolves.toBe('gemini-3.1-flash-lite-image');
    now += 1;
    await expect(resolver.ensure()).resolves.toBe('gemini-nano-banana-2.1');
  });

  it('a list with no affordable image model falls back to the static chain', async () => {
    const resolver = new ImageModelResolver(
      async () => [ga('gemini-3.8-flash'), ga('gemini-3-pro-image')],
      () => now,
      logger
    );
    await expect(resolver.ensure()).resolves.toBe('gemini-nano-banana-2.1');
  });

  it('start() resolves at once and on a 24-hour timer', async () => {
    jest.useFakeTimers();
    try {
      const list = jest.fn(async () => [ga('gemini-nano-banana-2.1')]);
      const resolver = new ImageModelResolver(list, () => now, logger);
      resolver.start();
      resolver.start(); // a second call adds no second timer
      await Promise.resolve();
      expect(list).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(IMAGE_MODEL_REFRESH_MS);
      expect(list).toHaveBeenCalledTimes(2);
      resolver.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
