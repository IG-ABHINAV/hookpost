/**
 * The plan list in the app (the paywall a new workspace sees before its trial,
 * and Billing) states what pricing.ts grants, every limit of it: Pro's seats
 * are capped at 15, not "unlimited", Standard is one user and says so, and
 * the AI images, the API with the MCP server and CLI, and the webhooks are
 * listed. /pricing's cards and table read the same lines (planLimitItems,
 * planLimitCells), so the site and the app cannot disagree.
 *   pnpm exec jest -c apps/frontend/jest.config.ts plan.features
 */
import {
  AI_CREDIT_COST,
  MARKETED_TIERS,
  pricing,
  pricingUSD,
  PURCHASABLE_TIERS,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  planFeatureItems,
  planFeatureLabel,
  planLimitCells,
  planLimitItems,
} from '@hookpost/frontend/components/billing/plan.features';
import en from '@hookpost/react/translation/locales/en/translation.json';

const english = (tier: string) =>
  planFeatureItems(pricing[tier]).map((f) => planFeatureLabel(f));
const limits = (tier: string) =>
  planLimitItems(pricing[tier]).map((f) => planFeatureLabel(f));

describe('planLimitItems: every limit, from pricing.ts', () => {
  it('Standard: one user, said in words; API, MCP and CLI; its webhooks', () => {
    expect(limits('STANDARD')).toEqual([
      '5 channels',
      '500 posts per month',
      'Just you, 1 user',
      '500 AI text generations per month',
      '20 AI images per month',
      'Public API, MCP server and CLI',
      '2 webhooks',
    ]);
  });

  it('Pro: up to 15 team members, never "unlimited"', () => {
    expect(limits('PRO')).toEqual([
      '20 channels',
      '2,000 posts per month',
      `Up to ${pricing.PRO.team_member_limit} team members`,
      '1,000 AI text generations per month',
      '100 AI images per month',
      'Public API, MCP server and CLI',
      '30 webhooks',
    ]);
    expect(pricing.PRO.team_member_limit).toBe(15);
    expect(limits('PRO').join('\n')).not.toMatch(/unlimited/i);
  });

  it('Free: no AI, no API, no webhooks, one user', () => {
    expect(limits('FREE')).toEqual(['2 channels', '30 posts per month', 'Just you, 1 user']);
  });

  it('the figures are the ones pricing.ts enforces, for every tier sold', () => {
    for (const tier of PURCHASABLE_TIERS) {
      const plan = pricing[tier];
      const lines = limits(tier).join('\n');
      expect(lines).toContain(`${plan.channel} channels`);
      expect(lines).toContain(`${plan.posts_per_month.toLocaleString('en-US')} posts per month`);
      expect(lines).toContain(
        plan.team_members ? `Up to ${plan.team_member_limit} team members` : 'Just you, 1 user'
      );
      if (plan.ai_credits) {
        // A plan on the shared credit pool lists the credits, not separate text and image counts.
        expect(lines).toContain(`${plan.ai_credits} AI credits/month`);
        expect(lines).not.toMatch(/AI text generations|AI images per month/);
      } else {
        if (plan.ai_generation_count) {
          expect(lines).toContain(`${plan.ai_generation_count.toLocaleString('en-US')} AI text generations per month`);
        }
        if (plan.image_generation_count) {
          expect(lines).toContain(`${plan.image_generation_count} AI images per month`);
        }
      }
      expect(lines.includes('Public API, MCP server and CLI')).toBe(plan.public_api);
      expect(lines.includes('webhooks')).toBe(plan.webhooks > 0);
      expect(/video/i.test(lines)).toBe(plan.generate_videos > 0);
    }
  });
});

describe('Hookpost: AI credits and X posts, not the old counts', () => {
  it('lists the shared credit pool and the X cap, in that order, after the seats', () => {
    const h = pricing.HOOKPOST;
    expect(h.ai_credits).toBe(100);
    expect(h.x_posts_per_month).toBe(30);
    expect(h.x_link_posts_per_month).toBe(0);
    expect(limits('HOOKPOST')).toEqual([
      `${h.channel} channels`,
      `${h.posts_per_month.toLocaleString('en-US')} posts per month`,
      `Up to ${h.team_member_limit} team members`,
      `${h.ai_credits} AI credits/month (a post ${AI_CREDIT_COST.ai_text}, an image ${AI_CREDIT_COST.ai_images})`,
      `${h.x_posts_per_month} X posts/month (no links on X)`,
      'Public API, MCP server and CLI',
      `${h.webhooks} webhooks`,
    ]);
    expect(limits('HOOKPOST').join('\n')).not.toMatch(/500 AI|20 AI images|50 X posts|3 with a link|AI text generations/);
  });

  it('the keys are the credit and X lines, with the figure as the prefix', () => {
    const items = planLimitItems(pricing.HOOKPOST);
    expect(items.find((f) => f.key === 'billing_ai_credits_per_month')!.prefix).toBe(pricing.HOOKPOST.ai_credits);
    expect(items.find((f) => f.key === 'billing_x_posts_per_month_no_links')!.prefix).toBe(
      pricing.HOOKPOST.x_posts_per_month
    );
  });

  it('the table cells say credits', () => {
    expect(planLimitCells(pricing.HOOKPOST)).toMatchObject({
      aiText: `${pricing.HOOKPOST.ai_credits} AI credits`,
      aiImages: `${AI_CREDIT_COST.ai_images} credits each`,
    });
  });
});

describe('planFeatureItems (the app: paywall and Billing)', () => {
  it('every limit, then the AI tools and the editor', () => {
    expect(english('STANDARD')).toEqual([
      ...limits('STANDARD'),
      'AI auto-complete',
      'AI copilots',
      'Advanced Picture Editor',
    ]);
  });

  it('lists nothing a sold plan does not have, and nothing twice', () => {
    for (const tier of PURCHASABLE_TIERS) {
      const plan = pricing[tier];
      const lines = english(tier);
      expect(new Set(lines.map((l) => l.toLowerCase().replace(/[-\s]/g, ''))).size).toBe(
        lines.length
      );
      if (!plan.generate_videos) {
        expect(lines.join('\n')).not.toMatch(/video/i);
      }
      if (!plan.team_members) {
        expect(lines.join('\n')).not.toMatch(/team members/i);
      }
      if (!plan.image_generation_count) {
        expect(lines.join('\n')).not.toMatch(/AI images/i);
      }
      if (!plan.ai) {
        expect(lines.join('\n')).not.toMatch(/\bAI\b/);
      }
      if (!plan.public_api) {
        expect(lines.join('\n')).not.toMatch(/API|MCP|CLI/);
      }
    }
  });

  it('the limits are the same in every currency', () => {
    expect(planFeatureItems(pricingUSD.PRO)).toEqual(planFeatureItems(pricing.PRO));
  });

  it('translates through t, with the seat cap passed in', () => {
    const t = jest.fn((key: string, opts: any) =>
      typeof opts === 'string' ? `[${key}]` : `[${key}:${opts.limit}]`
    );
    const labels = planFeatureItems(pricing.PRO).map((f) => planFeatureLabel(f, t));
    expect(labels).toContain('[billing_up_to_team_members:15]');
    expect(labels).toContain('20 [billing_channels]');
    expect(labels).toContain('[billing_api_mcp_cli]');
  });

  // The app shows English from en/translation.json where a key is there, and
  // the cards on /pricing show the default. They must be the same words.
  it('English in the app is word for word the English on /pricing', () => {
    const strings = en as Record<string, string>;
    for (const tier of PURCHASABLE_TIERS) {
      for (const f of planFeatureItems(pricing[tier])) {
        if (strings[f.key] !== undefined) {
          expect([f.key, strings[f.key]]).toEqual([f.key, f.defaultValue]);
        }
      }
    }
  });
});

describe('planLimitCells (the /pricing table)', () => {
  it('one cell per limit, the same figures as the cards', () => {
    expect(planLimitCells(pricing.STANDARD)).toEqual({
      channels: '5',
      posts: '500',
      team: 'Just you, 1 user',
      aiText: '500',
      aiImages: '20',
      aiVideos: 'None',
      apiMcpCli: 'Yes',
      webhooks: '2',
    });
    expect(planLimitCells(pricing.PRO)).toEqual({
      channels: '20',
      posts: '2,000',
      team: 'Up to 15',
      aiText: '1,000',
      aiImages: '100',
      aiVideos: 'None',
      apiMcpCli: 'Yes',
      webhooks: '30',
    });
    expect(planLimitCells(pricing.FREE)).toMatchObject({
      team: 'Just you, 1 user',
      aiText: 'None',
      apiMcpCli: 'No',
      webhooks: 'None',
    });
  });

  it('every marketed tier has a value in every cell', () => {
    for (const tier of MARKETED_TIERS) {
      for (const v of Object.values(planLimitCells(pricing[tier]))) {
        expect(v).toMatch(/\S/);
      }
    }
  });
});
