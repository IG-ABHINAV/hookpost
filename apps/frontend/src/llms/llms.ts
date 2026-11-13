/**
 * /llms.txt and /llms-full.txt, the plain-text summaries AI crawlers read.
 *
 * They used to be static files in public/, which cannot change with the trial
 * policy: public/ is served as it is. The text now lives next to this file,
 * unchanged, and two route handlers (app/llms.txt, app/llms-full.txt) serve it,
 * prerendered at build like every marketing page. While new users have a Free
 * plan the files go out byte for byte as written. Once a trial cutoff is set
 * (trial-offer.ts) the Free-plan lines are swapped for the free-posts terms
 * (FREE_POST_LIMIT posts with no card, then the one paid plan) by the exact
 * replacements below. TRIAL_REPLACEMENTS keeps its name for that reason: there
 * is no time trial for new users any more.
 *
 * Every replacement must match exactly once. If someone edits a line one of
 * them targets, the trial build throws rather than ship a Free claim, and
 * llms.spec.ts fails in CI in either mode, so fix the pair when you edit the
 * text.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FREE_POSTS,
  NO_TIME_TRIAL,
  THEN_TRIAL_TERMS,
  TRIAL_AFTER_FREE_POSTS,
  TRIAL_ONLY,
  TRIAL_PRICE_AFTER,
} from '@hookpost/frontend/app/(landing)/trial-offer';
import {
  USD_MARKETED,
  USD_HOOKPOST_MONTH,
} from '@hookpost/frontend/app/(landing)/usd-offer';

export type LlmsFile = 'llms.txt' | 'llms-full.txt';

// `next build` runs in apps/frontend; jest runs from the repo root.
const DIRS = [
  join(process.cwd(), 'src', 'llms'),
  join(process.cwd(), 'apps', 'frontend', 'src', 'llms'),
];

export function readLlmsSource(file: LlmsFile): string {
  const dir = DIRS.find((d) => existsSync(join(d, file)));
  if (!dir) throw new Error(`${file} not found in ${DIRS.join(' or ')}`);
  return readFileSync(join(dir, file), 'utf8');
}

// Once dollars are sold too (usd-offer.ts), the dollar price follows the rupee
// one. With the trial switch on (trial-offer.ts TRIAL_AFTER_FREE_POSTS) a trial
// follows the free posts.
const FREE_POSTS_TERMS = TRIAL_AFTER_FREE_POSTS
  ? `${FREE_POSTS}, no card needed, ${THEN_TRIAL_TERMS} (Hookpost is ${TRIAL_PRICE_AFTER}/month)`
  : USD_MARKETED
  ? `${FREE_POSTS}, no card needed, then Hookpost at ${TRIAL_PRICE_AFTER}/month in India, or ${USD_HOOKPOST_MONTH}/month outside India, paid by card`
  : `${FREE_POSTS}, no card needed, then Hookpost at ${TRIAL_PRICE_AFTER}/month`;

/** [exact text in the file, what replaces it once new users have no Free plan] */
export const TRIAL_REPLACEMENTS: Record<LlmsFile, [string, string][]> = {
  'llms.txt': [
    [
      'There is a free plan (2 channels, 30 posts a month); the one paid plan, Hookpost, is a flat monthly price',
      `There is no free plan for new workspaces: a new workspace gets ${FREE_POSTS_TERMS}${NO_TIME_TRIAL}. Hookpost is a flat monthly price`,
    ],
    [
      '- The free plan has no AI generation and no API access. The API, CLI, n8n node and MCP server need the paid Hookpost plan.',
      '- The API, CLI, n8n node and MCP server need the paid Hookpost plan.',
    ],
    [
      '- You want a free or low-cost Buffer / Hootsuite / Later alternative',
      '- You want a low-cost Buffer / Hootsuite / Later alternative',
    ],
    [
      '- [Free social media scheduler](https://hookpost.hookstep.in/free-social-media-scheduler): What the free plan includes, compared with the free plans of Buffer, Metricool, Hootsuite and Later.\n',
      '',
    ],
    [
      'Its tools work on every Hookpost plan.',
      `Any Hookpost workspace can connect: without a plan it gets ${FREE_POSTS}, then the Hookpost plan.`,
    ],
    [
      '- [Pricing](https://hookpost.hookstep.in/pricing): Every plan limit in one table.',
      `- [Pricing](https://hookpost.hookstep.in/pricing): Every plan limit in one table and the ${FREE_POSTS}.`,
    ],
  ],
  'llms-full.txt': [
    [
      '- Free ($0): 2 channels, 30 posts/month, calendar scheduling. No AI generation, no API.\n',
      `- New workspaces: ${FREE_POSTS_TERMS}. There is no free plan for new workspaces${NO_TIME_TRIAL ? ' and no time-limited trial' : ''}.\n`,
    ],
    [
      'The tools work on every Hookpost plan.',
      `Any Hookpost workspace can connect: without a plan it gets ${FREE_POSTS}, then the Hookpost plan.`,
    ],
    [
      ' Hookpost free = 2 channels, 30 posts/month, X and LinkedIn included.',
      ` Hookpost has no free plan for new workspaces: ${FREE_POSTS}, no card needed, then a paid plan.`,
    ],
  ],
};

/**
 * [exact text in the file, what replaces it once dollars are sold too]
 * (usd-offer.ts). The committed text bills in rupees only; these scope the
 * rupee and UPI lines to India and add the dollar prices. Independent of the
 * trial replacements above: none of them touches the same text.
 */
export const USD_REPLACEMENTS: Record<LlmsFile, [string, string][]> = {
  // None since 8 Nov 2026: the committed text already shows the one price,
  // $7, to everyone (pricing.ts HOOKPOST_PRICE), and USD_MARKETED is off.
  'llms.txt': [],
  'llms-full.txt': [],
};

function applyExactly(
  file: LlmsFile,
  text: string,
  pairs: [string, string][],
  what: string,
  table: string
): string {
  let out = text;
  for (const [from, to] of pairs) {
    const count = out.split(from).length - 1;
    if (count !== 1) {
      throw new Error(
        `${file}: expected exactly one "${from.slice(0, 60)}..." to replace for the ${what}, found ${count}. Update ${table} in src/llms/llms.ts.`
      );
    }
    out = out.replace(from, () => to);
  }
  return out;
}

/** Apply the replacements, insisting each one matches exactly once. */
export function applyTrialReplacements(file: LlmsFile, text: string): string {
  return applyExactly(file, text, TRIAL_REPLACEMENTS[file], 'trial copy', 'TRIAL_REPLACEMENTS');
}

/** The dollar replacements, insisting each one matches exactly once. */
export function applyUsdReplacements(file: LlmsFile, text: string): string {
  return applyExactly(file, text, USD_REPLACEMENTS[file], 'dollar copy', 'USD_REPLACEMENTS');
}

/** The file as it should be served right now. */
export function llmsText(
  file: LlmsFile,
  trialOnly: boolean = TRIAL_ONLY,
  usdMarketed: boolean = USD_MARKETED
): string {
  let text = readLlmsSource(file);
  if (trialOnly) text = applyTrialReplacements(file, text);
  if (usdMarketed) text = applyUsdReplacements(file, text);
  return text;
}

export function llmsResponse(file: LlmsFile): Response {
  return new Response(llmsText(file), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
