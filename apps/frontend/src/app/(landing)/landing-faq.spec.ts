/**
 * The homepage FAQ, which is also the FAQPage structured data (layout.tsx and
 * SeoSchemas.tsx) that AI models quote. It promised "monthly or annual billing
 * (annual is two months free)"; the pricing answer now says what every
 * visitor is sold, at the prices in pricing.ts.
 *   pnpm exec jest -c apps/frontend/jest.config.ts landing-faq
 */
import { HOOKPOST_PRICE, pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

const KEYS = ['TRIAL_REQUIRED_SINCE_IN', 'USD_CHECKOUT', 'GST_LUT_ARN'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const faqFor = (env: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  let data: Array<{ q: string; a: string }> = [];
  jest.isolateModules(() => {
    data = require('./LandingFaq').FAQ_DATA;
  });
  return data;
};

const BUILDS = {
  'the trial build': {
    TRIAL_REQUIRED_SINCE_IN: '2026-10-20T00:00:00Z',
    USD_CHECKOUT: 'on',
    GST_LUT_ARN: 'AD0000000000000',
  },
  'the Free-plan build': {},
};

describe.each(Object.entries(BUILDS))('homepage FAQ, %s', (_name, env) => {
  // 8 Nov 2026: one plan, Hookpost, billed monthly only. The answer names no
  // yearly price and nothing about the retired Standard and Pro plans.
  it('sells one plan, billed monthly only, with no yearly price', () => {
    const all = faqFor(env).map((f) => `${f.q} ${f.a}`).join('\n');
    const cost = faqFor(env).find((f) => /How much does Hookpost cost/.test(f.q))!;
    expect(pricingINR.HOOKPOST.year_price).toBe(0);
    expect(cost.a).toContain('There is no yearly price.');
    expect(all).not.toMatch(/annual|two months free|\/year|\$0\/year/i);
    expect(all).not.toMatch(/\bStandard\b|\bPro\b|₹1,999|₹5,990|₹19,990|\$19\b|\$29\b/);
  });

  it('prices the plan from pricing.ts, billed monthly', () => {
    const cost = faqFor(env).find((f) => /How much does Hookpost cost/.test(f.q))!;
    expect(cost.a).toContain('billed monthly');
    expect(cost.a).not.toContain('month to month');
    expect(cost.a).toContain(`$${HOOKPOST_PRICE.displayUsd}/mo`);
    expect(cost.a).not.toMatch(/₹|\b699\b|\b599\b|in India/);
    expect(cost.a).toContain(`${pricingINR.HOOKPOST.ai_credits} AI credits/month`);
    expect(cost.a).toContain(`${pricingINR.HOOKPOST.x_posts_per_month} X posts/month`);
    expect(cost.a).not.toMatch(/500 AI|20 AI images|50 X posts|3 with a link/);
    expect(cost.a).toContain(`${pricingINR.HOOKPOST.channel} channels`);
    expect(cost.a).toContain(`up to ${pricingINR.HOOKPOST.team_member_limit} team members`);
  });
});

// 28 Oct 2026: a new workspace gets 3 free posts with no card, then the one
// plan at its flat price (no first-month discount since 8 Nov 2026). No time
// trial, so the FAQPage that AI models quote must not promise one.
describe('homepage FAQ, the free-posts build', () => {
  const env = BUILDS['the trial build'];

  it('the cost answer carries the canonical sentence: $7 for everyone, no India or elsewhere split', () => {
    const cost = faqFor(env).find((f) => /How much does Hookpost cost/.test(f.q))!;
    expect(cost.a).toContain('3 free posts, no card needed. Then $7/month.');
    expect(cost.a).not.toMatch(/% off|first month|₹|in India|elsewhere/i);
    expect(cost.a).not.toMatch(/-day trial|₹0 today|24 hours/i);
  });

  it('with the dollar switches off, the same sentence', () => {
    const cost = faqFor({ TRIAL_REQUIRED_SINCE_IN: env.TRIAL_REQUIRED_SINCE_IN }).find((f) =>
      /How much does Hookpost cost/.test(f.q)
    )!;
    expect(cost.a).toContain('3 free posts, no card needed. Then $7/month. ');
  });

  it('no answer promises a trial of any length', () => {
    const all = faqFor(env).map((f) => `${f.q} ${f.a}`).join('\n');
    expect(all).not.toMatch(/\d+-day trial|free trial/i);
  });
});
