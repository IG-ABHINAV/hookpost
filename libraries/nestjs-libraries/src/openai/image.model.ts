import { Logger } from '@nestjs/common';

/**
 * Which Gemini image model Hookpost draws with on Vertex AI.
 *
 * Google ships new image models every few months and retires old ones
 * (gemini-2.5-flash-image shuts down on 15 Mar 2027), so the model is not
 * written into the code. At startup and then every 24 hours the backend asks
 * Vertex for the publisher models the project can use and picks the newest
 * GA `gemini-nano-banana-<version>` or `gemini-<version>-flash-image`
 * (pickLatestImageModel), but only one whose price is in IMAGE_MODEL_PRICES
 * and at most IMAGE_PRICE_CAP_USD: an AI image costs the plan a fixed number
 * of AI credits (AI_CREDIT_COST in pricing.ts), so a newer model must never
 * make an image dearer than that budget. A newer model that is unpriced or
 * dearer is skipped with a warning naming it. If the lookup fails, it uses
 * AI_IMAGE_MODEL, then the static chain below. Images are always 1K.
 */

/**
 * USD per 1K (1024 px) image, from https://aistudio.google.com/docs/pricing
 * (checked 8 Nov 2026). Add a model here, with its listed price, before the
 * resolver may pick it.
 */
export const IMAGE_MODEL_PRICES: Record<string, number> = {
  'gemini-nano-banana-2.1': 0.0336,
  'gemini-3.1-flash-image': 0.067,
  // Nano Banana Pro: over the cap, so never picked automatically.
  'gemini-3-pro-image': 0.134,
};

/** The most an automatically chosen model may cost per 1K image (5 credits). */
export const IMAGE_PRICE_CAP_USD = 0.04;

/** Output size sent with every image request. */
export const IMAGE_SIZE = '1K';

/**
 * Used, in this order, when the model list cannot be read; after the first,
 * they are also the 429 fallbacks. Fixed, not price-checked: the two 3.1
 * models only stand in while the default is busy or unavailable.
 */
export const STATIC_IMAGE_MODELS = [
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-lite-image',
  'gemini-3.1-flash-image',
];

export const IMAGE_MODEL_REFRESH_MS = 24 * 60 * 60 * 1000;
/** A failed lookup is tried again after this long, not a whole day. */
export const IMAGE_MODEL_RETRY_MS = 60 * 60 * 1000;

export interface PublisherModel {
  /** `gemini-3.1-flash-image`, or `publishers/google/models/gemini-3.1-flash-image` */
  id: string;
  /** Vertex `launchStage`: GA, PUBLIC_PREVIEW, EXPERIMENTAL, … (if known) */
  launchStage?: string;
}

// Newest family first: Nano Banana superseded the numbered Flash image ids.
const FAMILIES = [
  /^gemini-nano-banana-(\d+(?:\.\d+)*)$/,
  /^gemini-(\d+(?:\.\d+)*)-flash-image$/,
];
// Only when nothing above exists: previews, experimental, lite (never pro).
const LOOSE_NANO = /^gemini-nano-banana-(\d+(?:\.\d+)*)-[a-z0-9.-]+$/;
const LOOSE_FLASH = /^gemini-(\d+(?:\.\d+)*)-[a-z0-9.-]*image[a-z0-9.-]*$/;
const UNSTABLE = /(preview|exp|experimental)/;
const PRO = /(^|-)pro(-|$)/;

/** Compares dotted versions numerically: 3.10 > 3.9, 3.1 > 3. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) {
      return diff;
    }
  }
  return 0;
}

function bareId(id: string) {
  return id.split('/').pop() || '';
}

function isGa(model: PublisherModel) {
  return !model.launchStage || model.launchStage.toUpperCase() === 'GA';
}

export interface ImageModelChoice {
  /** The model to use, or undefined when no candidate is priced within the cap. */
  model?: string;
  /** Candidates newer than the choice that were passed over, and why. */
  skipped: { id: string; reason: string }[];
}

function priceProblem(
  id: string,
  prices: Record<string, number>,
  cap: number
): string | null {
  const price = prices[id];
  if (price === undefined) return 'no listed price in IMAGE_MODEL_PRICES';
  if (price > cap) return `$${price} per 1K image is over the $${cap} cap`;
  return null;
}

/**
 * The newest GA Nano Banana or Flash image model whose listed price is within
 * the cap. `-lite`, preview and experimental ids are considered only when no
 * plain GA id exists; pro never. Newer candidates that are unpriced or too
 * dear come back in `skipped`.
 */
export function pickLatestImageModel(
  models: PublisherModel[],
  prices: Record<string, number> = IMAGE_MODEL_PRICES,
  cap: number = IMAGE_PRICE_CAP_USD
): ImageModelChoice {
  const ids = models.map((model) => ({ id: bareId(model.id), ga: isGa(model) }));

  const strict = ids
    .flatMap((c) => {
      if (!c.ga) return [];
      const family = FAMILIES.findIndex((re) => re.test(c.id));
      return family < 0
        ? []
        : [{ id: c.id, family, version: FAMILIES[family].exec(c.id)![1] }];
    })
    .sort(
      (a, b) => a.family - b.family || compareVersions(b.version, a.version)
    );

  // Nothing GA and plain: what exists, newest first, the fewest excluded
  // traits (preview/experimental, lite) first.
  const penalty = (c: { id: string; ga: boolean }) =>
    (!c.ga || UNSTABLE.test(c.id) ? 2 : 0) + (/-lite-/.test(c.id) ? 1 : 0);
  const loose = strict.length
    ? []
    : ids
        .flatMap((c) => {
          if (PRO.test(c.id)) return [];
          const match = LOOSE_NANO.exec(c.id) || LOOSE_FLASH.exec(c.id);
          return match ? [{ ...c, version: match[1] }] : [];
        })
        .sort(
          (a, b) =>
            compareVersions(b.version, a.version) ||
            penalty(a) - penalty(b) ||
            a.id.localeCompare(b.id)
        );

  const skipped: ImageModelChoice['skipped'] = [];
  for (const { id } of [...strict, ...loose]) {
    const problem = priceProblem(id, prices, cap);
    if (!problem) return { model: id, skipped };
    skipped.push({ id, reason: problem });
  }
  return { model: undefined, skipped };
}

/** AI_IMAGE_MODEL, then STATIC_IMAGE_MODELS, without repeats. */
export function fallbackImageModels(): string[] {
  const fromEnv = process.env.AI_IMAGE_MODEL?.trim();
  return [...new Set([...(fromEnv ? [fromEnv] : []), ...STATIC_IMAGE_MODELS])];
}

/**
 * Keeps the resolved model. `current()` never waits; `ensure()` resolves when
 * nothing is cached or the cache has expired (24 h, or 1 h after a failed
 * lookup), and concurrent callers share one lookup.
 */
export class ImageModelResolver {
  private model?: string;
  private expiresAt = 0;
  private pending?: Promise<string>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly listModels: () => Promise<PublisherModel[]>,
    private readonly now: () => number = Date.now,
    private readonly logger: Pick<Logger, 'log' | 'warn'> = new Logger(
      'AI image model'
    )
  ) {}

  /** The cached model, or the first fallback before the first resolve. */
  current(): string {
    return this.model || fallbackImageModels()[0];
  }

  async ensure(): Promise<string> {
    if (this.model && this.now() < this.expiresAt) {
      return this.model;
    }
    return this.resolve();
  }

  /** Looks the model up now (one lookup at a time) and logs the choice. */
  resolve(): Promise<string> {
    if (!this.pending) {
      this.pending = this.lookup().finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  /** Resolve now and every IMAGE_MODEL_REFRESH_MS; never keeps the process alive. */
  start(): void {
    if (this.timer) {
      return;
    }
    this.resolve().catch(() => undefined);
    this.timer = setInterval(
      () => this.resolve().catch(() => undefined),
      IMAGE_MODEL_REFRESH_MS
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Test seam: pretend `model` was just resolved (undefined clears it). */
  set(model: string | undefined): void {
    this.model = model;
    this.expiresAt = model ? this.now() + IMAGE_MODEL_REFRESH_MS : 0;
  }

  private async lookup(): Promise<string> {
    let model: string | undefined;
    let reason = '';
    try {
      const choice = pickLatestImageModel(await this.listModels());
      for (const skip of choice.skipped) {
        this.logger.warn(`Not switching to ${skip.id}: ${skip.reason}`);
      }
      model = choice.model;
      if (!model) {
        reason = 'no Gemini image model within the price cap';
      }
    } catch (e: any) {
      reason = e?.message || String(e);
    }
    if (model) {
      this.logger.log(
        `Using ${model} (newest GA Gemini image model, $${IMAGE_MODEL_PRICES[model]} per 1K image)`
      );
      this.expiresAt = this.now() + IMAGE_MODEL_REFRESH_MS;
    } else {
      model = fallbackImageModels()[0];
      this.logger.warn(
        `Using ${model}: could not resolve the newest (${reason})`
      );
      this.expiresAt = this.now() + IMAGE_MODEL_RETRY_MS;
    }
    this.model = model;
    return model;
  }
}
