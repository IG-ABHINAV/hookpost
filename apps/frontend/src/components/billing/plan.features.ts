import {
  AI_CREDIT_COST,
  PricingInnerInterface,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
// The homepage's plan cards render these lines while it hydrates; see
// group.digits.ts for why figures are not grouped with toLocaleString.
import { groupDigits } from './group.digits';

/** One line of a plan's feature list in the app (paywall and Billing). */
export interface PlanFeature {
  /** Translation key. */
  key: string;
  /** English text. With `values`, it has {{placeholders}} for them. */
  defaultValue: string;
  /** Shown before the text: a figure, or 'unlimited'. */
  prefix?: string | number;
  values?: Record<string, string | number>;
}

/**
 * Every limit a plan has, one line each, from pricing.ts and nothing else:
 * channels, posts a month, who can use it, AI text, AI images (and AI videos
 * while any are granted), the API with the MCP server and the CLI, and
 * webhooks. The same lines, in the same words, on /pricing's plan cards
 * (PricingPlans.client.tsx), in its table (planLimitCells), on the paywall a
 * new workspace sees before its trial and on Billing (planFeatureItems), so
 * a limit cannot be stated on one and missing or different on another.
 *
 * Seats are team_member_limit, owner included: organization.service.ts
 * refuses the invite that would pass it. A plan without team_members is one
 * person, which is said rather than left out. `public_api` gates the API key
 * (Settings, Developers), and the MCP server and the CLI both run on that
 * key, so they come and go together.
 */
export const planLimitItems = (plan: PricingInnerInterface): PlanFeature[] => {
  const list: PlanFeature[] = [];

  list.push({
    key: plan.channel === 1 ? 'billing_channel' : 'billing_channels',
    defaultValue: plan.channel === 1 ? 'channel' : 'channels',
    prefix: plan.channel,
  });

  list.push({
    key: 'billing_posts_per_month',
    defaultValue: 'posts per month',
    prefix: plan.posts_per_month > 10000 ? 'unlimited' : plan.posts_per_month,
  });

  list.push(
    plan.team_members && plan.team_member_limit > 1
      ? {
          key: 'billing_up_to_team_members',
          defaultValue: 'Up to {{limit}} team members',
          values: { limit: plan.team_member_limit },
        }
      : { key: 'billing_just_you_one_user', defaultValue: 'Just you, 1 user' }
  );

  if (plan.ai && plan.ai_credits) {
    // One pool for text and images (pricing.ts AI_CREDIT_COST).
    list.push({
      key: 'billing_ai_credits_per_month',
      defaultValue: 'AI credits/month (a post 1, an image {{image}})',
      prefix: plan.ai_credits,
      values: { image: AI_CREDIT_COST.ai_images },
    });
  } else if (plan.ai && plan.ai_generation_count) {
    list.push({
      key: 'billing_ai_text_per_month',
      defaultValue: 'AI text generations per month',
      prefix: plan.ai_generation_count,
    });
  }

  if (plan.ai_credits && plan.x_posts_per_month) {
    list.push({
      key: plan.x_link_posts_per_month
        ? 'billing_x_posts_per_month'
        : 'billing_x_posts_per_month_no_links',
      defaultValue: plan.x_link_posts_per_month
        ? 'X posts/month'
        : 'X posts/month (no links on X)',
      prefix: plan.x_posts_per_month,
    });
  }

  if (plan.image_generation_count && !plan.ai_credits) {
    list.push({
      key: 'billing_ai_images_per_month',
      defaultValue: 'AI images per month',
      prefix: plan.image_generation_count,
    });
  }

  if (plan.generate_videos) {
    list.push({
      key: 'billing_ai_videos_per_month',
      defaultValue: 'AI videos per month',
      prefix: plan.generate_videos,
    });
  }

  if (plan.public_api) {
    list.push({
      key: 'billing_api_mcp_cli',
      defaultValue: 'Public API, MCP server and CLI',
    });
  }

  if (plan.webhooks) {
    list.push({
      key: plan.webhooks === 1 ? 'billing_webhook' : 'billing_webhooks',
      defaultValue: plan.webhooks === 1 ? 'webhook' : 'webhooks',
      prefix: plan.webhooks,
    });
  }

  return list;
};

/**
 * What a plan grants, for the paywall a new workspace sees before its trial
 * and for the Billing page: every limit (planLimitItems), then the AI tools
 * and the editor, which have no number.
 *
 * The paywall said "Unlimited team members" for Pro, whose seats are capped at
 * team_member_limit (organization.service.ts refuses the 16th), and it left
 * out Standard's 20 AI images because it asked image_generator, a flag for the
 * design editor's AI panel, rather than image_generation_count, the credits
 * the media library's AI image actually uses. "AI auto-complete" was listed
 * twice under two spellings.
 */
export const planFeatureItems = (plan: PricingInnerInterface): PlanFeature[] => {
  const list = planLimitItems(plan);
  if (plan.ai) {
    list.push({ key: 'billing_ai_auto_complete', defaultValue: 'AI auto-complete' });
    list.push({ key: 'billing_ai_copilots', defaultValue: 'AI copilots' });
  }
  list.push({
    key: 'billing_advanced_picture_editor',
    defaultValue: 'Advanced Picture Editor',
  });
  return list;
};

/** One plan's row in /pricing's "Every limit, in one table". */
export interface PlanLimitCells {
  channels: string;
  posts: string;
  team: string;
  aiText: string;
  aiImages: string;
  aiVideos: string;
  apiMcpCli: string;
  webhooks: string;
}

/**
 * The same limits as planLimitItems, as table cells: a number, or the short
 * form of the line ("Up to 15", "Just you", "Yes", "None").
 */
export const planLimitCells = (plan: PricingInnerInterface): PlanLimitCells => {
  const n = (v: number) => groupDigits(v);
  return {
    channels: n(plan.channel ?? 0),
    posts: plan.posts_per_month > 10000 ? 'Unlimited' : n(plan.posts_per_month),
    team:
      plan.team_members && plan.team_member_limit > 1
        ? `Up to ${n(plan.team_member_limit)}`
        : 'Just you, 1 user',
    aiText: plan.ai && plan.ai_credits
      ? `${n(plan.ai_credits)} AI credits`
      : plan.ai && plan.ai_generation_count
      ? n(plan.ai_generation_count)
      : 'None',
    aiImages: plan.ai_credits
      ? `${AI_CREDIT_COST.ai_images} credits each`
      : plan.image_generation_count
      ? n(plan.image_generation_count)
      : 'None',
    aiVideos: plan.generate_videos ? n(plan.generate_videos) : 'None',
    apiMcpCli: plan.public_api ? 'Yes' : 'No',
    webhooks: plan.webhooks ? n(plan.webhooks) : 'None',
  };
};

// useT()'s t. Its declared result is wider than string (i18next), but with a
// default value it always returns the text.
type Translate = (key: string, fallbackOrOptions: any) => unknown;

/**
 * The line as shown: translated with `t`, or the English text without.
 * Figures are grouped the same way everywhere ("2,000"), so the cards and the
 * app read alike.
 */
export const planFeatureLabel = (feature: PlanFeature, t?: Translate): string => {
  const text = feature.values
    ? t
      ? String(
          t(feature.key, {
            defaultValue: feature.defaultValue,
            ...feature.values,
            interpolation: { escapeValue: false },
          })
        )
      : feature.defaultValue.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
          String(feature.values![name] ?? '')
        )
    : t
    ? String(t(feature.key, feature.defaultValue))
    : feature.defaultValue;

  if (feature.prefix === 'unlimited') {
    return `${t ? String(t('billing_unlimited', 'Unlimited')) : 'Unlimited'} ${text}`;
  }
  if (typeof feature.prefix === 'number') {
    return `${groupDigits(feature.prefix)} ${text}`;
  }
  if (feature.prefix !== undefined) {
    return `${feature.prefix} ${text}`;
  }
  return text;
};
