/**
 * /llms.txt and /llms-full.txt: byte for byte the committed text while new
 * users have a Free plan, the free-posts terms (3 free posts with no card, then
 * the flat monthly price) once a cutoff is set (PR-3, changed 28 Oct 2026).
 *   pnpm exec jest -c apps/frontend/jest.config.ts llms
 */
import fs from 'fs';
import path from 'path';
import {
  applyTrialReplacements,
  applyUsdReplacements,
  llmsText,
  LlmsFile,
  TRIAL_REPLACEMENTS,
  USD_REPLACEMENTS,
} from './llms';
import {
  AI_CREDIT_COST,
  HOOKPOST_PRICE,
  MARKETED_TIERS,
  pricingINR,
  pricingUSD,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

const FILES: LlmsFile[] = ['llms.txt', 'llms-full.txt'];
const source = (f: LlmsFile) => fs.readFileSync(path.join(__dirname, f), 'utf8');

describe.each(FILES)('%s', (file) => {
  it('is served unchanged while there is a Free plan', () => {
    expect(llmsText(file, false)).toBe(source(file));
  });

  it('every trial replacement finds its line exactly once', () => {
    for (const [from] of TRIAL_REPLACEMENTS[file]) {
      expect(source(file).split(from).length - 1).toBe(1);
    }
  });

  it.each([false, true])('the free-posts version (dollars %s) offers no Free plan and no free start; "no card" only in the free-posts sentence', (usd) => {
    const text = llmsText(file, true, usd);
    expect(text).not.toMatch(/There is a free plan/i);
    expect(text).not.toMatch(/Free \((₹|\$)0\)/);
    expect(text).not.toMatch(/The free plan has/i);
    expect(text).not.toMatch(/free-social-media-scheduler/);
    expect(text).not.toMatch(/no credit card/i);
    // Every "no card" is the free posts' own (check-free-claims.allow).
    for (const m of text.matchAll(/[^.\n]*\bno card\b[^.\n]*/gi)) {
      expect(m[0]).toMatch(/\b3 free posts, no card needed\b/);
    }
    // Same checker CI runs on the trial build.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { checkText, loadAllow } = require('../../../../scripts/check-free-claims.js');
    expect(checkText(file, text.split('\n'), loadAllow())).toEqual([]);
  });

  it('says what new workspaces get: 3 free posts, no card, then the flat monthly price, and no time trial', () => {
    const text = llmsText(file, true);
    expect(text).toMatch(/3 free posts, no card needed/);
    expect(text).toContain(`then Hookpost at $${HOOKPOST_PRICE.displayUsd}/month`);
    expect(text).not.toMatch(/₹\s?(599|699)/);
    expect(text).not.toMatch(/20% off|first month/i);
    // no trial wording at all in public copy (owner, 9 Nov 2026)
    expect(text).not.toMatch(/time-limited trial/);
    expect(text).not.toMatch(/\b3-day trial|24 hours before the first charge|₹0 today/i);
  });

  it('a build with the dollar switches on says the same: $7 for everyone, charged in rupees, no discount', () => {
    // TRIAL_TERMS is read at build, so evaluate llms.ts as that build would.
    const keys = ['TRIAL_REQUIRED_SINCE_IN', 'TRIAL_REQUIRED_SINCE_GLOBAL', 'USD_CHECKOUT', 'GST_LUT_ARN'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      TRIAL_REQUIRED_SINCE_IN: '2026-10-20T05:30:00Z',
      TRIAL_REQUIRED_SINCE_GLOBAL: '2026-10-20T05:30:00Z',
      USD_CHECKOUT: 'on',
      GST_LUT_ARN: 'AD0910260000000',
    });
    let mod!: typeof import('./llms');
    jest.isolateModules(() => {
      mod = require('./llms');
    });
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    const text = mod.llmsText(file, true, true);
    expect(text).toContain(`then Hookpost at $${HOOKPOST_PRICE.displayUsd}/month`);
    expect(text).toMatch(/Indian rupees/);
    expect(text).not.toMatch(/in India, or \$7|\$7\/month outside India|billed in US dollars|paid in US dollars|₹\s?(599|699)/);
    expect(text).not.toMatch(/20% off|first month/i);
    // The same text as the build without the switches.
    expect(text).toBe(llmsText(file, true, false));
  });
});

// Billing as the pages say it: Hookpost is billed monthly only, with no yearly
// price (pricing.ts has year_price 0 for it).
describe.each(FILES)('%s: monthly only', (file) => {
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])('trial %s, dollars %s: monthly only, no yearly price', (trial, usd) => {
    const text = llmsText(file, trial, usd);
    expect(pricingINR.HOOKPOST.year_price).toBe(0);
    expect(text).toContain('no yearly price');
    expect(text).not.toMatch(/unless you choose yearly|5,990|19,990|months free|\$0\/year/);
    expect(text).not.toMatch(/month to month/i);
  });
});

it('the free version would fail that same check (the check bites)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { checkText, loadAllow } = require('../../../../scripts/check-free-claims.js');
  expect(
    checkText('llms.txt', source('llms.txt').split('\n'), loadAllow()).length
  ).toBeGreaterThan(0);
});

it('a replacement whose line was edited away fails loudly instead of shipping Free', () => {
  expect(() =>
    applyTrialReplacements('llms.txt', 'There is no such line here.')
  ).toThrow(/expected exactly one/);
});

it('there is no dollar rail left to replace: the committed text already shows the one price', () => {
  for (const file of FILES) {
    expect(USD_REPLACEMENTS[file]).toEqual([]);
    // Nothing to apply, so any text passes through untouched.
    expect(applyUsdReplacements(file, 'There is no such line here.')).toBe('There is no such line here.');
  }
});

it('a replacement whose line appears twice fails loudly too', () => {
  const [from] = TRIAL_REPLACEMENTS['llms.txt'][0];
  expect(() => applyTrialReplacements('llms.txt', `${from}\n${from}`)).toThrow(
    /expected exactly one .* found 2/
  );
});

// What the files say about Hookpost has to be true: every price and limit is
// pricing.ts's, billing is Razorpay's, and the caveats an assistant would
// otherwise get wrong stay in. On 24 Oct 2026 an edit shipped Standard "$9",
// Pro "$19", "unlimited channels", a Free plan, "Stripe/Paddle" and "ranked
// as the best", and dropped the ChatGPT and TikTok caveats. Since 26 Oct 2026
// ChatGPT connects (custom MCP server at /mcp-oauth); the caveat is now how,
// and that it was not yet checked inside a ChatGPT account.
describe.each(FILES)('%s: the facts', (file) => {
  // [mode, trial cutoff set, dollars sold]; production today is the trial,
  // with or without dollars depending on USD_CHECKOUT.
  const MODES: Array<[string, boolean, boolean]> = [
    ['Free plan', false, false],
    ['trial', true, false],
    ['trial and dollars', true, true],
  ];

  // A sentence naming another vendor (and not Hookpost) quotes that vendor's
  // price: "(Buffer charges $5-6 per channel per month)".
  const OTHER_VENDOR =
    /\b(Buffer|Hootsuite|Later|Sprout Social|Metricool|Publer|Postiz|Mixpost|SocialPilot|Agorapulse|Planoly|Typefully|Zoho Social|Sendible|Tailwind)\b/;
  const sentences = (text: string) =>
    text.split('\n').flatMap((line) => line.split(/(?<=\.)\s+/));
  const amounts = (s: string, symbol: '$' | '₹') =>
    [...s.matchAll(new RegExp(`\\${symbol}(\\d[\\d,]*)`, 'g'))].map((m) =>
      Number(m[1].replace(/,/g, ''))
    );
  const tierPrices = (table: typeof pricingINR, tier: string) => [
    table[tier].month_price,
    table[tier].year_price,
  ];
  const USD_PRICES = MARKETED_TIERS.flatMap((tier) => tierPrices(pricingUSD, tier));

  it.each(MODES)('%s: every dollar amount Hookpost quotes is a pricingUSD price', (_mode, trial, usd) => {
    const quoted = sentences(llmsText(file, trial, usd))
      .filter((s) => !OTHER_VENDOR.test(s) || /\bHookpost\b/.test(s))
      .flatMap((s) => amounts(s, '$'));
    for (const amount of quoted) expect(USD_PRICES).toContain(amount);
    // $7 in every mode: shown to every visitor, India included.
    expect(quoted).toEqual(expect.arrayContaining([HOOKPOST_PRICE.displayUsd]));
    expect(quoted).toEqual(expect.arrayContaining([pricingUSD.HOOKPOST.month_price]));
  });

  it.each(MODES)('%s: a price named after Hookpost is the plan’s $7, and no rupee figure is named after it', (_mode, trial, usd) => {
    const text = sentences(llmsText(file, trial, usd))
      .filter((s) => !OTHER_VENDOR.test(s))
      .join('\n');
    const named = [...text.matchAll(/\b(Hookpost)\b[^₹$\n.]{0,70}([₹$])([\d,]+)/g)].map((m) => ({
      match: m[0],
      symbol: m[2],
      amount: Number(m[3].replace(/,/g, '')),
    }));
    expect(named.length).toBeGreaterThan(0);
    for (const { match, symbol, amount } of named) {
      // The match is in the message when this fails.
      expect({ match, ok: symbol === '$' && tierPrices(pricingUSD, 'HOOKPOST').includes(amount) }).toEqual({
        match,
        ok: true,
      });
    }
    // The plan's monthly price is stated, as shown: $7.
    expect(named.some((q) => q.amount === HOOKPOST_PRICE.displayUsd)).toBe(true);
  });

  it.each(MODES)('%s: no unlimited, no Stripe or Paddle, no ranking claims', (_mode, trial, usd) => {
    const text = llmsText(file, trial, usd);
    expect(text).not.toMatch(/unlimited/i);
    expect(text).not.toMatch(/Stripe|Paddle/i);
    expect(text).not.toMatch(/\branked\b|\bleading\b|\b(is|as) the best\b/i);
    expect(text).toMatch(/Razorpay/);
  });

  // Other vendors' free plans may be compared ("Comparison of free plans");
  // Hookpost's is only ever said not to exist.
  it.each(MODES.filter(([, trial]) => trial))('%s: no Free plan for Hookpost', (_mode, trial, usd) => {
    const text = llmsText(file, trial, usd);
    expect(text).not.toMatch(/Free plan/);
    expect(text).not.toMatch(/\b(there is|includes|has|with) a free plan\b/i);
    expect(text).not.toMatch(/\bthe free plan\b/i);
    expect(text).not.toMatch(/\bHookpost free\b/);
    expect(text).toMatch(/no free plan for new workspaces/);
  });

  it.each(MODES)('%s: keeps the ChatGPT and TikTok caveats', (_mode, trial, usd) => {
    const text = llmsText(file, trial, usd);
    expect(text).toContain('ChatGPT: add it as a custom MCP server');
    expect(text).toContain('https://hookpost.hookstep.in/mcp-oauth');
    expect(text).toMatch(/not ChatGPT Free/);
    expect(text).toMatch(/not yet inside a ChatGPT account/);
    expect(text).not.toMatch(/ChatGPT[^.\n]*not (a )?supported/);
    expect(text).toContain(
      "TikTok posts publish to your TikTok account with the audience your account allows (Everyone, Friends, Followers or Only me), or go to your TikTok inbox as drafts if you choose that mode."
    );
  });
});

describe('the plan limits are pricing.ts’s', () => {
  const { HOOKPOST } = pricingINR;
  const n = (v: number) => v.toLocaleString('en-US');

  it('llms-full.txt: the paid plan’s line, at $7 with AI credits and X posts', () => {
    const text = source('llms-full.txt');
    expect(text).toContain(
      `- Hookpost ($${HOOKPOST_PRICE.displayUsd}/month): ${HOOKPOST.channel} channels, ${n(HOOKPOST.posts_per_month)} posts/month, ${HOOKPOST.ai_credits} AI credits/month (a post uses ${AI_CREDIT_COST.ai_text}, an image ${AI_CREDIT_COST.ai_images}), ${HOOKPOST.x_posts_per_month} X posts/month (links on X are not included),`
    );
    expect(text).toContain(`up to ${HOOKPOST.team_member_limit} team members (owner included)`);
    expect(text).toContain(`${HOOKPOST.webhooks} webhooks.`);
    expect(HOOKPOST.x_link_posts_per_month).toBe(0);
    expect(text).not.toMatch(/500 AI|20 AI images|50 X posts|3 of them with a link|₹\s?(599|699)/);
  });

  it('llms.txt: X posts without links, and AI as credits', () => {
    const text = source('llms.txt');
    expect(text).toContain(
      `X (Twitter) posting is capped at ${HOOKPOST.x_posts_per_month} posts a month, and links on X are not included. AI is ${HOOKPOST.ai_credits} AI credits a month: a post uses ${AI_CREDIT_COST.ai_text} credit, an image ${AI_CREDIT_COST.ai_images}.`
    );
  });

  it('llms.txt: the channels the plan covers', () => {
    expect(source('llms.txt')).toContain(`the Hookpost plan covers ${HOOKPOST.channel} channels.`);
  });
});

// "HookPost" is also an unrelated Shopify Flow app, so the first thing an AI
// assistant reads names the company too.
describe.each(FILES)('%s: names Hookpost by Hookstep first', (file) => {
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])('trial %s, dollars %s: the title line says Hookpost by Hookstep', (trial, usd) => {
    const [title] = llmsText(file, trial, usd).split('\n');
    expect(title).toMatch(/^# Hookpost by Hookstep\b/);
  });
});
