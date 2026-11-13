// The service's two collaborators are injected as fakes below; their modules
// pull in Prisma and the upload pipeline, which this spec never touches.
jest.mock('./subscription.service', () => ({ SubscriptionService: class {} }));
jest.mock('./subscription.repository', () => ({ SubscriptionRepository: class {} }));

import dayjs from 'dayjs';
import {
  X_CREDIT,
  X_LINK_CREDIT,
  XPostCapError,
  XPostCapService,
  X_LINKS_NOT_INCLUDED,
  xCapMessage,
  xTweetText,
} from './x.post.cap';
import { AI_CREDIT_COST, HOOKPOST_PRICE, pricing } from './pricing';
import { IMAGE_MODEL_PRICES } from '@hookpost/nestjs-libraries/openai/image.model';
import { CreditsExceededError } from './credits.exceeded.error';

const ORG = 'org-1';
const X_PLAIN = 0.015;
const X_LINK = 0.2;
const INR_PER_USD = 88;
const RAZORPAY_INR_FEE = 0.0236;

/** SubscriptionRepository.useCredit over an in-memory Credits table. */
function fakeRepository() {
  const rows: { type: string; at: Date }[] = [];
  const repo = {
    rows,
    getCreditsFrom: jest.fn(async (_org: string, from: dayjs.Dayjs, type: string) =>
      rows.filter((r) => r.type === type && r.at >= from.toDate()).length
    ),
    useCredit: jest.fn(
      async (
        _org: any,
        type: string,
        func: () => Promise<any>,
        allowance?: { max: number; from: dayjs.Dayjs }
      ) => {
        const used = allowance
          ? rows.filter((r) => r.type === type && r.at >= allowance.from.toDate()).length
          : 0;
        if (allowance && used + 1 > allowance.max) throw new CreditsExceededError(type);
        const row = { type, at: new Date() };
        rows.push(row);
        try {
          return await func();
        } catch (err) {
          rows.splice(rows.indexOf(row), 1);
          throw err;
        }
      }
    ),
  };
  return repo;
}

function setup(
  opts: {
    tier?: string | null;
    identifier?: string;
    platformAdmin?: boolean;
    org?: boolean;
  } = {}
) {
  const repo = fakeRepository();
  const subscriptions = {
    getPolicyOrg: jest.fn(async () =>
      opts.org === false
        ? null
        : { id: ORG, createdAt: dayjs().subtract(40, 'day').toDate(), platformAdmin: !!opts.platformAdmin }
    ),
    getSubscription: jest.fn(async () =>
      opts.tier === null
        ? null
        : {
            subscriptionTier: opts.tier ?? 'STANDARD',
            identifier: opts.identifier ?? 'sub_1',
            createdAt: dayjs().subtract(10, 'day').toDate(),
          }
    ),
  };
  const service = new XPostCapService(subscriptions as any, repo as any);
  const publish = jest.fn(async () => 'posted');
  return { service, repo, subscriptions, publish };
}

const saved = { ...process.env };
beforeEach(() => {
  process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret_unit';
  delete process.env.STRIP_LINKS_FROM_X_POSTS;
  delete process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS;
});
afterAll(() => {
  process.env = saved;
});

describe('X caps in TIER_LIMITS: worst case under 20% of the INR price net of fees', () => {
  it.each(['STANDARD', 'TEAM', 'PRO', 'ULTIMATE'])('%s', (tier) => {
    const plan = pricing[tier];
    expect(plan.x_link_posts_per_month).toBeLessThanOrEqual(plan.x_posts_per_month);
    const worstUsd =
      plan.x_link_posts_per_month * X_LINK +
      (plan.x_posts_per_month - plan.x_link_posts_per_month) * X_PLAIN;
    const netInr = plan.month_price * (1 - RAZORPAY_INR_FEE);
    expect(worstUsd * INR_PER_USD).toBeLessThan(0.2 * netInr);
  });

  it('every tier has both caps; only HOOKPOST has no link posts', () => {
    for (const tier of Object.keys(pricing)) {
      expect(pricing[tier].x_posts_per_month).toBeGreaterThan(0);
      if (tier === 'HOOKPOST') {
        expect(pricing[tier].x_link_posts_per_month).toBe(0);
      } else {
        expect(pricing[tier].x_link_posts_per_month).toBeGreaterThan(0);
      }
    }
  });
});

describe('XPostCapService.publishWithinXCap', () => {
  it('lets a plan publish its monthly X posts, then refuses the next with a sentence and sends nothing', async () => {
    const { service, publish } = setup({ tier: 'STANDARD' });
    const cap = pricing.STANDARD.x_posts_per_month;
    for (let i = 0; i < cap; i++) {
      await expect(service.publishWithinXCap(ORG, 'x', `post ${i}`, publish)).resolves.toBe('posted');
    }
    const over = service.publishWithinXCap(ORG, 'x', 'one more', publish);
    await expect(over).rejects.toBeInstanceOf(XPostCapError);
    await expect(over).rejects.toThrow(`Your Standard plan includes ${cap} X posts a month`);
    expect(publish).toHaveBeenCalledTimes(cap);
  });

  it('a post with a link also takes a link credit; past the link cap it says to remove the link', async () => {
    const { service, publish, repo } = setup({ tier: 'STANDARD' });
    const links = pricing.STANDARD.x_link_posts_per_month;
    for (let i = 0; i < links; i++) {
      await service.publishWithinXCap(ORG, 'x', `read https://hookpost.in/blog/${i}`, publish);
    }
    expect(repo.rows.filter((r) => r.type === X_LINK_CREDIT)).toHaveLength(links);
    expect(repo.rows.filter((r) => r.type === X_CREDIT)).toHaveLength(links);

    await expect(
      service.publishWithinXCap(ORG, 'x', 'and hookpost.in too', publish)
    ).rejects.toThrow(/includes 3 X posts with a link a month.*remove the link/);
    // The refused link post gave its plain-post credit back.
    expect(repo.rows.filter((r) => r.type === X_CREDIT)).toHaveLength(links);
    // A post without a link still goes out.
    await expect(service.publishWithinXCap(ORG, 'x', 'no link here', publish)).resolves.toBe('posted');
  });

  it('a link only in editor markup (a mention) is not a link post', async () => {
    const { service, publish, repo } = setup();
    await service.publishWithinXCap(ORG, 'x', '<p>hi <span data-mention="x">@jo</span></p>', publish);
    expect(repo.rows.map((r) => r.type)).toEqual([X_CREDIT]);
    await service.publishWithinXCap(ORG, 'x', '<p>see <a href="https://a.co">https://a.co</a></p>', publish);
    expect(repo.rows.filter((r) => r.type === X_LINK_CREDIT)).toHaveLength(1);
  });

  it('with STRIP_LINKS_FROM_X_POSTS a link post is billed, and counted, as a plain one', async () => {
    process.env.STRIP_LINKS_FROM_X_POSTS = '1';
    const { service, publish, repo } = setup();
    await service.publishWithinXCap(ORG, 'x', 'https://hookpost.in', publish);
    expect(repo.rows.map((r) => r.type)).toEqual([X_CREDIT]);
  });

  it('a failed publish gives the credits back', async () => {
    const { service, repo } = setup();
    const boom = new Error('X 503');
    await expect(
      service.publishWithinXCap(ORG, 'x', 'https://hookpost.in', async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(repo.rows).toHaveLength(0);
  });

  it('a CreditsExceededError thrown by the publish itself is not reported as the X cap', async () => {
    const { service } = setup();
    const inner = new CreditsExceededError('posts');
    await expect(
      service.publishWithinXCap(ORG, 'x', 'plain', async () => {
        throw inner;
      })
    ).rejects.toBe(inner);
  });

  it('Pro gets its own, larger caps', async () => {
    const { service, publish, repo } = setup({ tier: 'PRO' });
    for (let i = 0; i < pricing.PRO.x_link_posts_per_month; i++) {
      await service.publishWithinXCap(ORG, 'x', 'https://hookpost.in', publish);
    }
    await expect(service.publishWithinXCap(ORG, 'x', 'https://hookpost.in', publish)).rejects.toThrow(
      /Your Pro plan includes 10 X posts with a link/
    );
    expect(repo.useCredit.mock.calls[0][3].max).toBe(pricing.PRO.x_posts_per_month);
  });

  it('the single plan (HOOKPOST): 30 X posts a month, and no link posts at all', async () => {
    expect(pricing.HOOKPOST.x_posts_per_month).toBe(30);
    expect(pricing.HOOKPOST.x_link_posts_per_month).toBe(0);
    const { service, publish, repo } = setup({ tier: 'HOOKPOST', identifier: 'order_A' });
    await expect(service.publishWithinXCap(ORG, 'x', 'see https://hookpost.in', publish)).rejects.toThrow(
      X_LINKS_NOT_INCLUDED
    );
    expect(publish).not.toHaveBeenCalled();
    for (let i = 0; i < 30; i++) {
      await service.publishWithinXCap(ORG, 'x', `plain post ${i}`, publish);
    }
    expect(repo.useCredit.mock.calls[0][3].max).toBe(30);
    await expect(service.publishWithinXCap(ORG, 'x', 'one more', publish)).rejects.toThrow(
      /Your Hookpost plan includes 30 X posts a month/
    );
    expect(publish).toHaveBeenCalledTimes(30);
    // other platforms keep their links
    await expect(
      service.publishWithinXCap(ORG, 'linkedin', 'see https://hookpost.in', publish)
    ).resolves.toBe('posted');
  });

  it('the one plan keeps its worst case at about $1.12 against about $6.75 net', () => {
    const p = pricing.HOOKPOST;
    const images = (p.ai_credits! / AI_CREDIT_COST.ai_images) * IMAGE_MODEL_PRICES['gemini-nano-banana-2.1'];
    const texts = (p.ai_credits! / AI_CREDIT_COST.ai_text) * 0.0053;
    const x = p.x_link_posts_per_month * X_LINK + (p.x_posts_per_month - p.x_link_posts_per_month) * X_PLAIN;
    const worst = Math.max(images, texts) + x;
    expect(worst).toBeLessThan(1.13);
    expect(worst / HOOKPOST_PRICE.displayUsd).toBeLessThan(0.2);
    // Every platform and channel the old top plan had.
    expect(p.channel).toBe(pricing.PRO.channel);
    expect(p.team_member_limit).toBe(pricing.PRO.team_member_limit);
    expect(p.autoPost).toBe(true);
    // Pro subscribers keep Pro's own caps.
    expect(pricing.PRO.x_posts_per_month).toBe(150);
    expect(pricing.PRO.ai_generation_count).toBe(1000);
    expect(p.generate_videos).toBe(0);
  });

  it('a workspace without a plan row is held to the Free caps, on its own month', async () => {
    const { service, publish, repo } = setup({ tier: null });
    for (let i = 0; i < pricing.FREE.x_posts_per_month; i++) {
      await service.publishWithinXCap(ORG, 'x', 'plain', publish);
    }
    await expect(service.publishWithinXCap(ORG, 'x', 'plain', publish)).rejects.toThrow(/Your Free plan includes 10 X posts/);
    // The month runs from the workspace's createdAt (40 days ago): one
    // calendar month after it, so 9 to 12 days in depending on month length.
    const from: dayjs.Dayjs = repo.useCredit.mock.calls[0][3].from;
    expect(from.isSame(dayjs().subtract(40, 'day').add(1, 'month'), 'day')).toBe(true);
  });

  it('the month runs from the subscription start', async () => {
    const { service, publish, repo } = setup();
    await service.publishWithinXCap(ORG, 'x', 'plain', publish);
    const from: dayjs.Dayjs = repo.useCredit.mock.calls[0][3].from;
    expect(dayjs().diff(from, 'day')).toBe(10);
  });

  it.each([
    ['another provider', { provider: 'linkedin' }],
    ['a platform super admin workspace', { platformAdmin: true }],
    ['a marketplace workspace (its own X credits)', { identifier: 'apimkt:abc' }],
    ['a workspace that cannot be read', { org: false }],
  ] as const)('not capped: %s', async (_name, o: any) => {
    const { service, publish, repo } = setup(o);
    for (let i = 0; i < 60; i++) {
      await service.publishWithinXCap(ORG, o.provider ?? 'x', 'https://hookpost.in', publish);
    }
    expect(publish).toHaveBeenCalledTimes(60);
    expect(repo.useCredit).not.toHaveBeenCalled();
  });

  it('not capped: FREE_PLAN_SUNSET_EXEMPT_ORGS', async () => {
    process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = `other,${ORG}`;
    const { service, publish, repo } = setup();
    await service.publishWithinXCap(ORG, 'x', 'plain', publish);
    expect(repo.useCredit).not.toHaveBeenCalled();
  });

  it('not capped without billing (no RAZORPAY_KEY_SECRET), like the plan meter', async () => {
    delete process.env.RAZORPAY_KEY_SECRET;
    const { service, publish, repo } = setup();
    await service.publishWithinXCap(ORG, 'x', 'plain', publish);
    expect(repo.useCredit).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
  });

  it("the legacy 'twitter' identifier is X too", async () => {
    const { service, publish, repo } = setup();
    await service.publishWithinXCap(ORG, 'twitter', 'plain', publish);
    expect(repo.useCredit).toHaveBeenCalled();
  });
});

describe('XPostCapService.guardPlug (X plugs: auto plug, auto repost)', () => {
  it('runs the plug and counts it once it acted; a poll that did not act counts nothing', async () => {
    const { service, repo } = setup();
    expect(await service.guardPlug(ORG, 'x', 'Thanks! https://hookpost.in', async () => false, true)).toBe(false);
    expect(repo.rows).toHaveLength(0);
    expect(await service.guardPlug(ORG, 'x', 'Thanks! https://hookpost.in', async () => true, true)).toBe(true);
    expect(repo.rows.map((r) => r.type).sort()).toEqual([X_CREDIT, X_LINK_CREDIT].sort());
    // A repost has no text: a plain post.
    await service.guardPlug(ORG, 'x', '', async () => undefined, undefined);
    expect(repo.rows.filter((r) => r.type === X_CREDIT)).toHaveLength(2);
  });

  it('once the cap is used, the plug does not run and gets the skipped answer', async () => {
    const { service, repo } = setup();
    for (let i = 0; i < pricing.STANDARD.x_posts_per_month; i++) repo.rows.push({ type: X_CREDIT, at: new Date() });
    const run = jest.fn(async () => true);
    expect(await service.guardPlug(ORG, 'x', 'plain', run, 'skipped' as any)).toBe('skipped');
    expect(run).not.toHaveBeenCalled();
  });

  it('a plug with a link stops at the link cap, a plain one does not', async () => {
    const { service, repo } = setup();
    for (let i = 0; i < pricing.STANDARD.x_link_posts_per_month; i++) repo.rows.push({ type: X_LINK_CREDIT, at: new Date() });
    const run = jest.fn(async () => true);
    expect(await service.guardPlug(ORG, 'x', 'see hookpost.in', run, 'skipped' as any)).toBe('skipped');
    expect(await service.guardPlug(ORG, 'x', 'plain words', run, 'skipped' as any)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('not X, or not capped: runs untouched and counts nothing', async () => {
    const { service, repo } = setup({ platformAdmin: true });
    expect(await service.guardPlug(ORG, 'x', 'x', async () => true, false)).toBe(true);
    expect(await service.guardPlug(ORG, 'linkedin', 'x', async () => true, false)).toBe(true);
    expect(repo.rows).toHaveLength(0);
  });
});

describe('xCapMessage / xTweetText', () => {
  it('a plan with no link posts says so plainly', () => {
    expect(xCapMessage('links', 0, 'Hookpost')).toBe(
      "Links on X aren't included in your plan — remove the link"
    );
  });

  it('names the plan and the number', () => {
    expect(xCapMessage('posts', 1, 'Free')).toMatch(/^Your Free plan includes 1 X post a month/);
    expect(xCapMessage('posts', 50, 'Standard')).toMatch(/^Your Standard plan includes 50 X posts a month/);
    expect(xCapMessage('links', 1, 'Free')).toMatch(/1 X post with a link a month/);
  });

  it('flattens editor HTML to the tweet text', () => {
    // As XProvider.toTweetText: no tags left (bold turns into Unicode bold).
    const text = xTweetText('<p>hello <strong>world</strong></p>');
    expect(text).not.toMatch(/[<>]/);
    expect(text.startsWith('hello ')).toBe(true);
  });
});
