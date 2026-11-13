// The guard for the 3-day trial (22 Oct 2026): no built page may give a trial
// length other than TRIAL_DAYS, unless it is a competitor's own and the page
// names that competitor. It reads built HTML, so these cases are built text,
// the way the pages and llms.txt come out.
//   pnpm exec jest -c apps/backend/jest.config.ts check-trial-days

import fs from 'fs';
import os from 'os';
import path from 'path';
import { TRIAL_DAYS } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import {
  COMPETITOR_FACTS,
  INDIA_FACTS,
  MIXPOST_CLOUD,
} from '../apps/frontend/src/app/(landing)/compare/competitor-facts';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VENDOR_TRIAL_DAYS, readTrialDays, checkText, checkBuild } = require('./check-trial-days.js');

const flagged = (...segments: string[]) =>
  checkText('page', segments).map((h: any) => h.sentence);

describe('the trial length it checks against', () => {
  it('is TRIAL_DAYS from trial.policy.ts, which is 3', () => {
    expect(readTrialDays()).toBe(TRIAL_DAYS);
    expect(TRIAL_DAYS).toBe(3);
  });

  it('knows every competitor trial the pages quote (competitor-facts.ts)', () => {
    for (const facts of [...Object.values(COMPETITOR_FACTS), ...Object.values(INDIA_FACTS)]) {
      if (facts.freeTrialDays === null || facts.freeTrialDays === undefined) continue;
      expect([facts.name, VENDOR_TRIAL_DAYS[facts.name]]).toEqual([
        facts.name,
        expect.arrayContaining([facts.freeTrialDays]),
      ]);
    }
    expect(VENDOR_TRIAL_DAYS.Mixpost).toContain(MIXPOST_CLOUD.trialDays);
  });
});

describe('what counts as a wrong trial length', () => {
  it.each([
    'Start 7-day trial',
    'Start 7-Day Free Trial (₹0 Today, then ₹599)',
    '7-day trial: ₹0 today, ₹599/month after, UPI AutoPay or card, cancel at least 24 hours before the first charge.',
    'Free trial: 7 days, payment method required',
    'Try it for 7 days first',
    'Hookpost has no free plan for new workspaces: a 7-day trial, payment method required.',
    'Every plan starts with a seven-day trial.',
    // A competitor named, but the length is not theirs.
    'Hookpost and Buffer both start with a 7-day trial.',
  ])('flags %p', (s) => {
    expect(flagged(s)).toEqual([s]);
  });

  it.each([
    // Hookpost's own.
    '3-day trial: ₹0 today, ₹599/month after, UPI AutoPay or card, cancel at least 24 hours before the first charge.',
    'Free trial: 3 days, payment method required',
    'Start 3-day trial',
    // The free-posts copy (28 Oct 2026) states no trial length at all, so there
    // is nothing to check: the guard rejects wrong lengths, it never requires one.
    '3 free posts, no card needed. Then first month 20% off (new customers).',
    'There is no time-limited trial. 3 free posts, no card needed. Then first month 20% off (new customers) in India, or $19/month elsewhere.',
    'Get 3 free posts',
    // Competitors' own, named.
    "Postiz's hosted service has no free plan, only a 7-day trial.",
    'Hootsuite has no free plan (it offers a 14-day trial).',
    "Hookpost's trial is 3 days and Postiz's is 7.",
    'No free plan on either; trials of 3 days (Hookpost) and 7 days (Postiz)',
    'Mixpost Cloud starts at $9 a month with a 7-day trial.',
    'Entry price, per its own page (Postbeam): 7-day trial, then from $39 a month',
    // Days that are not a trial.
    'Videos you attach to a post are deleted from our storage 7 days after the post is published.',
    'List every post Hookpost published in the last 7 days, group them by channel.',
  ])('lets through %p', (s) => {
    expect(flagged(s)).toEqual([]);
  });

  it('a table cell belongs to the vendor in its row or column heading', () => {
    expect(flagged('Postiz Cloud (USD Only)', 'Free / Trial', 'No hosted free plan (7-day trial)')).toEqual([]);
    // Nobody named nearby: it is Hookpost's.
    expect(flagged('Plan', 'Free / Trial', 'No free plan (7-day trial)')).toEqual([
      'No free plan (7-day trial)',
    ]);
  });

  it('an offer in the imperative is Hookpost’s, whoever is named nearby', () => {
    expect(flagged('Postiz has a 7-day trial.', 'Start 7-day trial')).toEqual(['Start 7-day trial']);
  });
});

describe('reading a build', () => {
  it('checkBuild walks prerendered pages and route bodies under server/app', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-days-'));
    try {
      const app = path.join(dir, 'server', 'app');
      fs.mkdirSync(path.join(app, 'alternatives'), { recursive: true });
      fs.writeFileSync(
        path.join(app, 'pricing.html'),
        '<html><head><title>Pricing</title><meta name="description" content="A 3-day trial, then flat plans."/></head><body><p>3-day trial: ₹0 today.</p></body></html>'
      );
      fs.writeFileSync(path.join(app, 'llms.txt.body'), '- 3-day trial: every new workspace starts with a trial of Standard or Pro.\n');
      fs.writeFileSync(
        path.join(app, 'alternatives', 'postiz.html'),
        "<html><body><p>Postiz's hosted service has no free plan, only a 7-day trial.</p></body></html>"
      );
      expect(checkBuild(dir)).toEqual({ pages: 3, hits: [] });

      fs.writeFileSync(
        path.join(app, 'for-creators.html'),
        '<html><head><meta name="description" content="A 7-day trial for creators and influencers, ₹0 today."/></head><body></body></html>'
      );
      expect(checkBuild(dir).hits).toEqual([
        {
          file: 'for-creators.html',
          sentence: 'A 7-day trial for creators and influencers, ₹0 today.',
          days: [7],
        },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
